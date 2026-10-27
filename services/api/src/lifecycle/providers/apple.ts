import type { AppleOutcome, BoundedAppleTransport, BoundedProviderOperation, ProviderBudget, ResolvedMaterial } from './types.js';

// Settlement includes local producer cleanup. If a port violates it, this invocation stays unresolved;
// its durable active claim prevents a competing send. No detached race winner grants retry authority.
export async function settleProviderOperation<T>(start: () => BoundedProviderOperation<T>, budget: ProviderBudget): Promise<T> {
  if (budget.signal.aborted) throw new Error('provider_cancelled');
  const operation = start();
  if (!operation || typeof operation.cancel !== 'function' || !operation.settled || typeof operation.settled.then !== 'function')
    throw new Error('provider_port_unqualified');
  let cleanup: Promise<void> | undefined;
  const cancel = () => { cleanup ??= Promise.resolve().then(() => operation.cancel()); void cleanup.catch(() => undefined); };
  budget.signal.addEventListener('abort', cancel, { once: true });
  if (budget.signal.aborted) cancel();
  try {
    const value = await operation.settled;
    cancel(); await cleanup;
    if (budget.signal.aborted) throw new Error('provider_cancelled');
    return value;
  } finally {
    cancel();
    try { await cleanup; } finally { budget.signal.removeEventListener('abort', cancel); }
  }
}
export async function revokeApple(material: ResolvedMaterial, transport: BoundedAppleTransport,
  budget: ProviderBudget): Promise<AppleOutcome> {
  const m = material?.material;
  const valid = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 &&
    Buffer.byteLength(value) <= max && !/[\u0000-\u001f\u007f]/.test(value) && Buffer.from(value, 'utf8').toString('utf8') === value;
  if (transport?.contract !== 'bounded-apple-revoke-v1' || typeof transport.post !== 'function' ||
    !m || !['refresh_token', 'access_token'].includes(m.tokenKind) || m.provider !== 'apple' ||
    m.provenance !== 'issuer-client-subject-token-v1' ||
    !valid(m.token, 16384) || !valid(material.clientSecret, 16384) || !valid(m.clientId, 255))
    return { code: 'response_invalid', status: null };
  const body = new URLSearchParams({ client_id: m.clientId, client_secret: material.clientSecret,
    token: m.token, token_type_hint: m.tokenKind }).toString();
  if (Buffer.byteLength(body) > 131072 || budget.maxResponseBytes !== 4096 || budget.signal.aborted)
    return { code: 'response_invalid', status: null };
  try {
    const response = await settleProviderOperation(() => transport.post(Object.freeze({ url: 'https://appleid.apple.com/auth/revoke',
      method: 'POST', contentType: 'application/x-www-form-urlencoded', body, redirect: 'error', credentials: 'omit', retry: 0 }), budget), budget);
    const status = Number.isInteger(response?.status) && response.status >= 100 && response.status <= 599 ? response.status : null;
    if (status === null || !(response.body instanceof Uint8Array) || response.body.byteLength > 4096 || response.truncated !== false)
      return { code: 'response_invalid', status };
    if (status !== 200) return { code: 'provider_error', status };
    return { code: response.body.byteLength === 0 ? 'apple_ack' : 'response_invalid', status };
  } catch { return { code: 'transport_unknown', status: null }; }
}
