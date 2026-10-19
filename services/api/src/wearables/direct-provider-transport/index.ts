import { ProviderFailure } from '../providers/http.js';
import type { AuthorizedHttp, HttpRequest, HttpResponse } from '../providers/http.js';

export type ProviderScope = Readonly<{
  accountId: string; sessionId: string; epoch: number;
  connectionId: string; generation: number; provider: 'oura' | 'garmin';
}>;
export type SecretPurpose = 'access_token' | 'client_secret' | 'code_verifier' | 'refresh_token';
export interface SecretLease {
  value: string;
  // Synchronous, nonthrowing release drops the resolver's temporary plaintext reference; it is not vault/CAS completion.
  release(): void;
}
export interface ScopedSecretResolver {
  acquire(scope: ProviderScope, reference: string, purpose: SecretPurpose, signal: AbortSignal): Promise<SecretLease>;
}
export interface TransportResponse {
  status: number;
  headers: ReadonlyArray<readonly [string, string]>;
  // Read at most maxBytes (after decompression); null marks EOF. Never prebuffer an unbounded body.
  read(maxBytes: number, signal: AbortSignal): Promise<Uint8Array | null>;
  // Synchronous, nonthrowing cancellation releases the response, including unread/error bodies.
  cancel(): void;
}
export interface TransportRequest {
  method: HttpRequest['method']; url: string; headers: Readonly<Record<string, string>>;
  body: string | undefined; redirect: 'error'; signal: AbortSignal;
  maxResponseBytes: number; timeoutMs: number;
}
export type TransportPrimitive = (request: TransportRequest) => Promise<TransportResponse>;
export interface DirectProviderTransportOptions {
  scope: ProviderScope;
  assertCurrent(scope: ProviderScope): void;
  secrets: ScopedSecretResolver;
  // The primitive must honor redirect:error and abort, do no retries/logging, and use ordinary verified HTTPS.
  transport: TransportPrimitive;
  allowedRedirectUris: readonly string[];
  limits?: { timeoutMs?: number; requestBytes?: number; responseBytes?: number; readCount?: number };
}

const projections: Record<string, string> = {
  daily_activity: 'id,day,timestamp,steps,active_calories',
  daily_readiness: 'id,day,timestamp,score', daily_sleep: 'id,day,timestamp,score',
  sleep: 'id,day,bedtime_start,bedtime_end,total_sleep_duration,time_in_bed,sleep_algorithm_version',
  workout: 'id,day,start_datetime,end_datetime,activity,calories,distance,intensity,source',
};
const encoder = new TextEncoder();
function invalid(): never { throw new ProviderFailure('provider_request_invalid', 'none'); }
function bounded(value: unknown, max: number): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) invalid();
}
function exactKeys(value: Record<string, string>, keys: readonly string[]): void {
  if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) invalid();
  for (const part of Object.values(value)) bounded(part, 16384);
}
function https(value: string): URL {
  bounded(value, 8192);
  let u: URL;
  try { u = new URL(value); } catch { return invalid(); }
  if (u.protocol !== 'https:' || u.username || u.password || u.port || u.hash || value.includes('\\')) invalid();
  return u;
}
function day(value: string | null): string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) invalid();
  return value;
}
function limit(value: number | undefined, fallback: number, ceiling: number): number {
  const n = value ?? fallback;
  if (!Number.isSafeInteger(n) || n < 1 || n > ceiling) invalid();
  return n;
}

function validate(request: HttpRequest, scope: ProviderScope, redirects: ReadonlySet<string>) {
  if (Object.keys(request).some(key => !['method', 'url', 'headers', 'form', 'secretFormFields', 'bearerSecretRef', 'redirect'].includes(key))) invalid();
  if (request.redirect !== undefined && request.redirect !== 'error') invalid();
  const u = https(request.url);
  // Requiring the canonical spelling also rejects dot-segment and encoded-path aliases before secret resolution.
  if (u.href !== request.url) invalid();
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(request.headers)) {
    const name = key.toLowerCase();
    if (!['accept', 'content-type'].includes(name) || Object.hasOwn(headers, name)) invalid();
    bounded(value, 128); headers[name] = value;
  }
  const form = { ...request.form }, refs = { ...request.secretFormFields };
  if (request.method === 'POST') {
    const tokenUrl = scope.provider === 'oura' ? 'https://api.ouraring.com/oauth/token' : 'https://connectapi.garmin.com/di-oauth2-service/oauth/token';
    if (request.url !== tokenUrl || request.bearerSecretRef !== undefined || headers['content-type'] !== 'application/x-www-form-urlencoded' || (headers.accept !== undefined && headers.accept !== 'application/json')) invalid();
    if (form.grant_type === 'authorization_code') {
      exactKeys(form, ['grant_type', 'client_id', 'code', 'redirect_uri']);
      exactKeys(refs, ['client_secret', 'code_verifier']);
      if (!redirects.has(form.redirect_uri!)) invalid();
    } else if (form.grant_type === 'refresh_token') {
      exactKeys(form, ['grant_type', 'client_id']); exactKeys(refs, ['client_secret', 'refresh_token']);
    } else invalid();
  } else {
    if (request.form !== undefined || request.secretFormFields !== undefined || headers.accept !== 'application/json' || headers['content-type'] !== undefined) invalid();
    bounded(request.bearerSecretRef, 2048);
    if (scope.provider === 'oura') {
      const collection = u.pathname.slice('/v2/usercollection/'.length);
      if (request.method !== 'GET' || u.origin !== 'https://api.ouraring.com' || !u.pathname.startsWith('/v2/usercollection/') || !Object.hasOwn(projections, collection)) invalid();
      const keys = [...u.searchParams.keys()];
      if (new Set(keys).size !== keys.length || keys.some(key => !['start_date', 'end_date', 'fields', 'next_token'].includes(key))) invalid();
      if (day(u.searchParams.get('start_date')) > day(u.searchParams.get('end_date')) || u.searchParams.get('fields') !== projections[collection]) invalid();
      if (u.searchParams.has('next_token')) bounded(u.searchParams.get('next_token'), 2048);
    } else {
      const base = 'https://apis.garmin.com/wellness-api/rest/user/';
      if (!((request.method === 'GET' && [base + 'id', base + 'permissions'].includes(request.url)) || (request.method === 'DELETE' && request.url === base + 'registration'))) invalid();
    }
  }
  return { url: u.href, method: request.method, headers, form, refs, bearer: request.bearerSecretRef };
}

export function createDirectProviderTransport(options: DirectProviderTransportOptions): AuthorizedHttp {
  const scope: ProviderScope = Object.freeze({ ...options.scope });
  for (const field of [scope.accountId, scope.sessionId, scope.connectionId]) bounded(field, 2048);
  if (!['oura', 'garmin'].includes(scope.provider) || !Number.isSafeInteger(scope.epoch) || scope.epoch < 0 || !Number.isSafeInteger(scope.generation) || scope.generation < 0) invalid();
  const redirects = new Set(options.allowedRedirectUris);
  for (const uri of redirects) { const u = https(uri); if (u.href !== uri) invalid(); }
  const timeoutMs = limit(options.limits?.timeoutMs, 15000, 30000);
  const requestBytes = limit(options.limits?.requestBytes, 32768, 65536);
  const responseBytes = limit(options.limits?.responseBytes, 1048576, 1048576);
  const readCount = limit(options.limits?.readCount, 1024, 4096);
  const { assertCurrent, secrets, transport } = options;

  return { async request(request): Promise<HttpResponse> {
    let dispatched = false, mutating = false, finished = false;
    const controller = new AbortController();
    const leases: SecretLease[] = [];
    let response: TransportResponse | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let rejectDeadline: (reason: Error) => void = () => {};
    const deadline = new Promise<never>((_, reject) => { rejectDeadline = reject; });
    const check = () => { if (controller.signal.aborted) throw new Error('expired'); assertCurrent(scope); };
    const boundary = async <T>(work: () => Promise<T>, late?: (value: T) => void): Promise<T> => {
      check();
      const pending = work().then(value => {
        if (finished || controller.signal.aborted) { late?.(value); throw new Error('expired'); }
        return value;
      });
      const result = await Promise.race([pending, deadline]);
      check(); return result;
    };
    try {
      check();
      const prepared = validate(request, scope, redirects);
      mutating = prepared.method !== 'GET';
      const baseSize = encoder.encode(prepared.url + JSON.stringify(prepared.headers) + JSON.stringify(prepared.form) + JSON.stringify(prepared.refs) + (prepared.bearer ?? '')).byteLength;
      if (baseSize > requestBytes) invalid();
      timer = setTimeout(() => { controller.abort(); rejectDeadline(new Error('expired')); }, timeoutMs);
      async function secret(reference: string, purpose: SecretPurpose): Promise<string> {
        bounded(reference, 2048);
        // Register ownership before the post-await currentness check so stale results still release their lease.
        const lease = await boundary(async () => {
          const acquired = await secrets.acquire(scope, reference, purpose, controller.signal);
          if (!finished && !controller.signal.aborted) leases.push(acquired);
          return acquired;
        }, value => value.release());
        bounded(lease.value, 16384);
        if (purpose === 'access_token' && !/^[A-Za-z0-9\-._~+/]+=*$/.test(lease.value)) invalid();
        if (purpose === 'code_verifier' && !/^[A-Za-z0-9._~-]{43,128}$/.test(lease.value)) invalid();
        return lease.value;
      }
      if (prepared.bearer !== undefined) prepared.headers.authorization = 'Bearer ' + await secret(prepared.bearer, 'access_token');
      for (const [key, reference] of Object.entries(prepared.refs)) prepared.form[key] = await secret(reference, key as SecretPurpose);
      const body = prepared.method === 'POST' ? new URLSearchParams(prepared.form).toString() : undefined;
      if (encoder.encode(prepared.url + JSON.stringify(prepared.headers) + (body ?? '')).byteLength > requestBytes) invalid();
      response = await boundary(async () => {
        dispatched = true;
        const received = await transport({ method: prepared.method, url: prepared.url, headers: Object.freeze(prepared.headers), body,
          redirect: 'error', signal: controller.signal, timeoutMs, maxResponseBytes: responseBytes });
        if (!finished && !controller.signal.aborted) response = received;
        return received;
      }, value => value.cancel());
      if (!Number.isInteger(response.status) || response.status < 100 || response.status > 599 || response.headers.length > 64) throw new Error('response');
      const headers: Record<string, string> = {};
      let headerBytes = 0;
      for (const [rawName, rawValue] of response.headers) {
        if (typeof rawName !== 'string' || typeof rawValue !== 'string' || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(rawName) || /[\r\n\u0000]/.test(rawValue)) throw new Error('headers');
        headerBytes += encoder.encode(rawName + rawValue).byteLength;
        if (headerBytes > 16384) throw new Error('headers');
        const name = rawName.toLowerCase();
        if (['content-type', 'content-length', 'retry-after'].includes(name)) {
          if (Object.hasOwn(headers, name)) throw new Error('headers');
          headers[name] = rawValue.trim();
        }
      }
      if (headers['content-length'] !== undefined && (!/^\d+$/.test(headers['content-length']) || Number(headers['content-length']) > responseBytes)) throw new Error('size');
      // HTTP errors after a mutating dispatch cannot establish that a code, refresh token or registration was untouched.
      if (response.status < 200 || (response.status >= 300 && (mutating || response.status < 400))) throw new Error('status');
      const chunks: Uint8Array[] = [];
      let bytes = 0, ended = false;
      for (let reads = 0; reads < readCount; reads++) {
        const maxChunk = Math.min(65536, responseBytes - bytes + 1);
        const chunk = await boundary(() => response!.read(maxChunk, controller.signal));
        if (chunk === null) { ended = true; break; }
        if (!(chunk instanceof Uint8Array) || chunk.byteLength === 0 || chunk.byteLength > maxChunk) throw new Error('chunk');
        bytes += chunk.byteLength;
        if (bytes > responseBytes) throw new Error('size');
        chunks.push(chunk.slice());
      }
      if (!ended) throw new Error('reads');
      const joined = new Uint8Array(bytes);
      let offset = 0;
      for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
      let result: unknown = null;
      if (bytes > 0) {
        if (headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json') throw new Error('content_type');
        result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(joined));
      } else if (!(prepared.method === 'DELETE' && response.status >= 200 && response.status < 300)) throw new Error('empty');
      check();
      return { status: response.status, headers, body: result };
    } catch {
      throw new ProviderFailure('provider_transport', dispatched && mutating ? 'unknown' : 'none');
    } finally {
      finished = true;
      if (timer !== undefined) clearTimeout(timer);
      controller.abort();
      try { response?.cancel(); } finally { for (const lease of leases) lease.release(); }
    }
  } };
}
