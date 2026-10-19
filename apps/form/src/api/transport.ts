import type { ManualRetentionAttemptAuthority } from '../body/manualRetentionContract';

export type ManualMeasurementAttemptContext = Readonly<{ manualRetention: ManualRetentionAttemptAuthority | null }>;
export type FormRequestAttemptContext = ManualMeasurementAttemptContext & Readonly<{ assertCurrent(): void }>;

/** Detach before awaits; the actual protocol module validates authority before dispatch. Null requests receipt reconciliation. */
export function captureManualMeasurementAttemptContext(value: unknown): ManualMeasurementAttemptContext | undefined {
  if (value === undefined) return undefined;
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error();
    const keys = Reflect.ownKeys(value), descriptor = Object.getOwnPropertyDescriptor(value, 'manualRetention');
    if (keys.length !== 1 || keys[0] !== 'manualRetention' || !descriptor?.enumerable || !('value' in descriptor)) throw new Error();
    if (descriptor.value === null) return Object.freeze({ manualRetention: null });
    const authority = descriptor.value;
    if (!authority || typeof authority !== 'object' || Array.isArray(authority)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(authority))) throw new Error();
    const fields = ['protocol', 'decisionId', 'revision', 'statementSha256'], captured: Record<string, unknown> = {};
    const authorityKeys = Reflect.ownKeys(authority);
    if (authorityKeys.length !== fields.length) throw new Error();
    for (const key of authorityKeys) {
      if (typeof key !== 'string' || !fields.includes(key)) throw new Error();
      const field = Object.getOwnPropertyDescriptor(authority, key);
      if (!field?.enumerable || !('value' in field) || !['string', 'number'].includes(typeof field.value)) throw new Error();
      captured[key] = field.value;
    }
    return Object.freeze({ manualRetention: Object.freeze(captured) as ManualRetentionAttemptAuthority });
  } catch { throw new ApiError(400, 'invalid_attempt_context', 'Manual measurement attempt context is invalid.'); }
}

/** The dispatch fence is captured separately from retained command authority and must remain synchronous. */
export function captureFormRequestAttemptContext(value: unknown): FormRequestAttemptContext | undefined {
  if (value === undefined) return undefined;
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error();
    const keys = Reflect.ownKeys(value);
    if (keys.length !== 2 || !keys.includes('manualRetention') || !keys.includes('assertCurrent')) throw new Error();
    const authority = Object.getOwnPropertyDescriptor(value, 'manualRetention');
    const guard = Object.getOwnPropertyDescriptor(value, 'assertCurrent');
    if (!authority?.enumerable || !('value' in authority) || !guard?.enumerable || !('value' in guard)
      || typeof guard.value !== 'function') throw new Error();
    const captured = captureManualMeasurementAttemptContext({ manualRetention: authority.value })!;
    return Object.freeze({ ...captured, assertCurrent: guard.value });
  } catch { throw new ApiError(400, 'invalid_attempt_context', 'Manual measurement dispatch context is invalid.'); }
}

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public effectUnknown = false,
    public originalEffectUnknown = false) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface SessionStorage {
  load(): Promise<string | null>;
  save(token: string): Promise<void>;
  clear(): Promise<void>;
}

export type AuthAttemptGuard = { isCurrent(): boolean; validateResult?(data: unknown): boolean };

export type SessionLifetimeEvidence = Readonly<{ kind: 'session_unavailable' }>;
export type RawExchangeLimits = Readonly<{ maxEnvelopeBytes: number; deadlineMs: number }>;

export class FormTransport {
  private token: string | null = null;
  private sessionGeneration = 0;
  private authGeneration = 0;
  private storageTail: Promise<void> = Promise.resolve();
  private revokingAll = false;
  private storageUncertain = false;
  private readonly authObservers = new Set<(source?: AuthAttemptGuard) => void>();

  subscribeAuthChanges(observer: (source?: AuthAttemptGuard) => void): { remove(): void } {
    this.authObservers.add(observer);
    return { remove: () => { this.authObservers.delete(observer); } };
  }

  private beginAuth(source?: AuthAttemptGuard): number {
    this.authGeneration++;
    for (const observer of this.authObservers) observer(source);
    return this.authGeneration;
  }

  /** Memory-only guard; invalidated by every auth intent, restore, logout or session replacement. */
  captureAuthContext(): AuthAttemptGuard {
    const auth = this.authGeneration, session = this.sessionGeneration;
    return { isCurrent: () => auth === this.authGeneration && session === this.sessionGeneration };
  }

  private serializedStorage<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.storageTail.then(operation);
    this.storageTail = result.then(() => undefined, () => undefined);
    return result;
  }

  private changed(originalEffectUnknown = false): ApiError {
    return new ApiError(409, 'session_changed',
      'The account session changed. Check the original account before repeating a change.', false, originalEffectUnknown);
  }

  private envelope(token: string): string {
    return JSON.stringify({ version: 1, baseURL: this.baseURL, token });
  }

  private async repairStorage(): Promise<void> {
    // Called only inside the storage queue: no later write can be erased by this repair.
    try {
      if (this.token) await this.storage.save(this.envelope(this.token));
      else await this.storage.clear();
      this.storageUncertain = false;
    } catch {
      this.storageUncertain = true;
      throw new ApiError(0, 'secure_storage_failed', 'Secure session storage could not be reconciled.', false, true);
    }
  }
  private setToken(token: string | null, source?: AuthAttemptGuard): void {
    this.token = token;
    this.sessionGeneration++;
    for (const observer of this.authObservers) observer(source);
  }
  constructor(public readonly baseURL: string, private readonly storage: SessionStorage, private readonly fetcher: typeof fetch = fetch) {
    const url = new URL(baseURL);
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      throw new Error('Form API configuration must be an exact origin.');
    }
    const privateHost = url.hostname === 'localhost' || url.hostname === '127.0.0.1' ||
      /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(url.hostname) || url.hostname.endsWith('.ts.net');
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && privateHost)) {
      throw new Error('Form requires HTTPS or its private Tailscale development endpoint.');
    }
  }

  /** Carries encoded wire bytes unchanged; identity, cancellation and bounds cover the entire body read. */
  async exchangeStandardWire(request: string, signal: AbortSignal, limits: RawExchangeLimits): Promise<string> {
    return this.boundedAuthenticatedText('/v1/coaching/standard/turn', request, signal, limits);
  }

  private async boundedAuthenticatedText(path: string, body: string | undefined, signal: AbortSignal,
    limits: RawExchangeLimits): Promise<string> {
    if (!Number.isSafeInteger(limits.maxEnvelopeBytes) || limits.maxEnvelopeBytes <= 0 || limits.maxEnvelopeBytes > 100_000_000 ||
      !Number.isSafeInteger(limits.deadlineMs) || limits.deadlineMs <= 0 || limits.deadlineMs > 2_147_483_647)
      throw new ApiError(400, 'invalid_transport_limits', 'Explicit transport limits are required.');
    const bound = limits.maxEnvelopeBytes, deadline = limits.deadlineMs;
    if (body !== undefined && new TextEncoder().encode(body).byteLength > bound)
      throw new ApiError(413, 'wire_size', 'The encoded turn exceeds its transport bound.');
    const token = this.token, session = this.sessionGeneration, auth = this.authGeneration;
    if (!token) throw new ApiError(401, 'unauthenticated', 'Sign in before continuing.');
    const controller = new AbortController();
    let dispatched = false;
    const current = () => {
      if (this.token !== token || session !== this.sessionGeneration || auth !== this.authGeneration) throw this.changed(dispatched);
      signal.throwIfAborted(); controller.signal.throwIfAborted();
    };
    const abort = () => controller.abort();
    const subscription = this.subscribeAuthChanges(abort);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    const timer = setTimeout(abort, deadline);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const interrupted = new Promise<never>((_, reject) => {
      controller.signal.addEventListener('abort', () => {
        if (reader) void reader.cancel().catch(() => {});
        reject(new ApiError(0, 'transport_interrupted', 'The result could not be confirmed.', dispatched));
      }, { once: true });
    });
    // A rejected cancellation promise is observed even if currentness prevents the first request.
    void interrupted.catch(() => {});
    const wait = async <T>(work: Promise<T>): Promise<T> => {
      current(); const value = await Promise.race([work, interrupted]); current(); return value;
    };
    try {
      current(); dispatched = true;
      const response = await wait(this.fetcher(this.baseURL.replace(/\/$/, '') + path, {
        method: body === undefined ? 'GET' : 'POST', headers: { Accept: 'application/json',
          Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body }), signal: controller.signal, redirect: 'error',
      }).then(response => {
        if (controller.signal.aborted) void response.body?.cancel().catch(() => {});
        return response;
      }));
      if (response.redirected || response.status >= 300 && response.status < 400 || !response.ok) {
        void response.body?.cancel().catch(() => {});
        if (!response.redirected && response.status === 401 && path === '/v1/coaching/standard/turn' && body !== undefined) {
          current();
          await this.clearSession(session, auth);
          current();
        }
        throw new ApiError(response.status, 'wire_response_rejected', 'The server result could not be confirmed.', body !== undefined);
      }
      if (!response.body) throw new ApiError(502, 'invalid_response', 'The server result could not be confirmed.', body !== undefined);
      reader = response.body.getReader();
      const chunks: Uint8Array[] = []; let length = 0;
      while (true) {
        const part = await wait(reader.read());
        if (part.done) break;
        length += part.value.byteLength;
        if (length > bound) throw new ApiError(502, 'wire_size', 'The server result exceeds its transport bound.', body !== undefined);
        chunks.push(part.value);
      }
      current();
      const bytes = new Uint8Array(length); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      current(); return text;
    } catch (error) {
      if (this.token !== token || session !== this.sessionGeneration || auth !== this.authGeneration) throw this.changed(dispatched);
      if (error instanceof ApiError) throw error;
      if (controller.signal.aborted)
        throw new ApiError(0, 'transport_interrupted', 'The result could not be confirmed.', dispatched && body !== undefined);
      throw new ApiError(0, 'wire_result_unknown', 'The server result could not be confirmed.', dispatched && body !== undefined);
    } finally {
      clearTimeout(timer); subscription.remove(); signal.removeEventListener('abort', abort);
      if (reader) { void reader.cancel().catch(() => {}); }
    }
  }

  /** The auth proxy may renew sessions. Its returned date schedules revalidation, never offline expiry or keepalive polling. */
  observeSessionLifetime(observer: (evidence: SessionLifetimeEvidence) => void): { remove(): void; refresh(): Promise<void> } {
    const token = this.token, generation = this.sessionGeneration, auth = this.authGeneration;
    const controller = new AbortController();
    let active = token !== null, delivered = false, pending: Promise<void> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const current = () => active && token === this.token && generation === this.sessionGeneration && auth === this.authGeneration;
    const remove = () => { active = false; clearTimeout(timer); controller.abort(); subscription.remove(); };
    const subscription = this.subscribeAuthChanges(remove);
    const refresh = (): Promise<void> => {
      if (!current()) return Promise.resolve();
      if (pending) return pending;
      clearTimeout(timer);
      pending = (async () => {
        try {
          const text = await this.boundedAuthenticatedText('/api/auth/get-session', undefined, controller.signal,
            { maxEnvelopeBytes: 65_536, deadlineMs: 15_000 });
          if (!current()) return;
          const data: unknown = JSON.parse(text);
          if (!current()) return;
          if (data === null) {
            if (delivered) return;
            delivered = true;
            // Claim the original shell while its auth guard still holds, before storage or native cleanup awaits.
            try { observer(Object.freeze({ kind: 'session_unavailable' })); } catch { /* Local observation cannot prevent fencing. */ }
            if (current()) await this.clearSession(generation, auth);
            remove(); return;
          }
          if (!data || typeof data !== 'object' || Array.isArray(data)) return;
          const session = (data as { session?: unknown }).session, user = (data as { user?: unknown }).user;
          if (!session || typeof session !== 'object' || Array.isArray(session) || !user || typeof user !== 'object' || Array.isArray(user)) return;
          const row = session as { id?: unknown; token?: unknown; userId?: unknown; expiresAt?: unknown };
          const userId = (user as { id?: unknown }).id;
          const identity = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 &&
            value.length <= max && !/\s/.test(value);
          if (!identity(row.id, 512) || !identity(row.token, 8192) || !identity(row.userId, 512) || !identity(userId, 512) || row.userId !== userId) return;
          if (!identity(token, 16_384)) return;
          // BetterAuth's bearer header carries the URI-encoded signed cookie; session.token is its raw token component.
          const bearer = decodeURIComponent(token), parts = bearer.split('.');
          if (parts.length > 2 || parts.length === 2 && !parts[1] || row.token !== parts[0]) return;
          const expiry = row.expiresAt;
          if (typeof expiry !== 'string' || expiry.length > 64) return;
          const deadline = Date.parse(expiry), remaining = deadline - Date.now();
          if (!Number.isFinite(deadline) || remaining <= 0 || !current()) return;
          timer = setTimeout(() => { if (current()) void refresh(); }, Math.min(remaining, 2_147_483_647));
        } catch { /* Network, rejection and malformed observations establish no expiry. */ }
        finally { pending = undefined; }
      })();
      return pending;
    };
    if (active) void refresh(); else remove();
    return Object.freeze({ remove, refresh });
  }

  async restore(): Promise<boolean> {
    if (this.revokingAll) throw new ApiError(409, 'revocation_in_progress', 'Wait for session revocation to finish.');
    const auth = this.beginAuth();
    const current = () => auth === this.authGeneration;
    const restored = await this.serializedStorage(async () => {
      if (!current()) throw this.changed();
      let saved: string | null;
      try { saved = await this.storage.load(); }
      catch {
        if (!current()) throw this.changed();
        throw new ApiError(0, 'secure_storage_failed', 'Secure session storage is unavailable.');
      }
      if (!current()) throw this.changed();
      if (this.storageUncertain) throw new ApiError(0, 'secure_storage_failed', 'Secure session storage needs reconciliation.', false, true);
      if (!saved) return false;
      let token: string | null = null;
      try {
        const session = JSON.parse(saved) as { version?: number; baseURL?: string; token?: unknown };
        if (session.version === 1 && session.baseURL === this.baseURL && typeof session.token === 'string' && session.token.length)
          token = session.token;
      } catch { /* Invalid stored envelopes cannot establish a session. */ }
      if (!token) {
        try { await this.storage.clear(); }
        catch { this.storageUncertain = true; throw new ApiError(0, 'secure_storage_failed', 'Secure session storage needs reconciliation.', false, true); }
        if (!current()) throw this.changed();
        return false;
      }
      this.setToken(token);
      return true;
    });
    if (!current()) throw this.changed();
    if (!restored) return false;
    try {
      await this.request('/v1/me');
      if (!current()) throw this.changed();
      return true;
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) return false;
      throw error;
    }
  }

  async signIn(email: string, password: string, guard?: AuthAttemptGuard) {
    return this.authenticate('/api/auth/sign-in/email', { email, password }, undefined, guard);
  }
  async signUp(name: string, email: string, password: string, guard?: AuthAttemptGuard) {
    return this.authenticate('/api/auth/sign-up/email', { name, email, password }, undefined, guard);
  }

  async anonymousAuthCommand<T>(path: '/api/auth/email-otp/request-password-reset' | '/api/auth/email-otp/reset-password', body: unknown): Promise<T> {
    if (path !== '/api/auth/email-otp/request-password-reset' && path !== '/api/auth/email-otp/reset-password')
      throw new ApiError(400, 'invalid_auth_command', 'Unsupported password recovery action.');
    const context = this.captureAuthContext();
    try {
      const result = await this.perform(path, 'POST', body, undefined, false);
      if (!context.isCurrent()) throw this.changed(true);
      return result.data as T;
    } catch (error) {
      if (!context.isCurrent()) throw this.changed(true);
      throw error;
    }
  }

  async replaceSession<T>(path: '/api/auth/change-password', body: unknown, guard: AuthAttemptGuard): Promise<T> {
    if (path !== '/api/auth/change-password')
      throw new ApiError(400, 'invalid_auth_command', 'Unsupported session replacement action.');
    if (!this.token) throw new ApiError(401, 'unauthenticated', 'Sign in before changing your password.');
    return await this.authenticate(path, body, undefined, guard, true) as T;
  }

  async signInIdentity(provider: 'apple' | 'google', proof: {
    token: string; nonce?: string;
    user?: { name?: { firstName?: string; lastName?: string }; email?: string };
  }, guard?: AuthAttemptGuard) {
    if (!proof.token || proof.token.length > 16000) throw new ApiError(400, 'invalid_identity_proof', 'A provider identity proof is required.');
    // The server's pinned provider verifies signature, issuer, audience and nonce.
    return this.authenticate('/api/auth/sign-in/social', { provider, idToken: proof }, undefined, guard);
  }

  async signInPhone(proof: { phoneNumber: string; binding: string; challengeId: string; code: string }, key: string, guard?: AuthAttemptGuard) {
    if (typeof proof.phoneNumber !== 'string' || typeof proof.binding !== 'string' || typeof proof.challengeId !== 'string'
      || typeof proof.code !== 'string' || typeof key !== 'string' || !/^\+[1-9][0-9]{7,14}$/.test(proof.phoneNumber)
      || !/^[A-Za-z0-9_-]{43,128}$/.test(proof.binding)
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(proof.challengeId)
      || !/^[0-9]{4,10}$/.test(proof.code)
      || !/^[A-Za-z0-9_.:-]{16,128}$/.test(key)) {
      throw new ApiError(422, 'invalid_phone_proof', 'Check the phone verification fields.');
    }
    return this.authenticate('/api/auth/phone-number/verify', {
      phoneNumber: proof.phoneNumber, binding: proof.binding, challengeId: proof.challengeId, code: proof.code,
    }, key, guard);
  }

  async phoneChallenge(body: { phoneNumber: string; binding: string }, key: string, guard?: AuthAttemptGuard): Promise<unknown> {
    return this.phoneCommand('/api/auth/phone-number/challenge', { phoneNumber: body.phoneNumber, binding: body.binding }, key, guard);
  }

  async resendPhoneChallenge(body: { phoneNumber: string; binding: string; challengeId: string }, key: string, guard?: AuthAttemptGuard): Promise<unknown> {
    return this.phoneCommand('/api/auth/phone-number/resend', { phoneNumber: body.phoneNumber, binding: body.binding, challengeId: body.challengeId }, key, guard);
  }

  private async phoneCommand(path: string, body: { phoneNumber: string; binding: string; challengeId?: string }, key: string, guard?: AuthAttemptGuard) {
    if (typeof body.phoneNumber !== 'string' || typeof body.binding !== 'string' || typeof key !== 'string'
      || (body.challengeId !== undefined && typeof body.challengeId !== 'string') || !/^\+[1-9][0-9]{7,14}$/.test(body.phoneNumber) || !/^[A-Za-z0-9_-]{43}$/.test(body.binding)
      || !/^[A-Za-z0-9_.:-]{16,128}$/.test(key) || (body.challengeId !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.challengeId)))
      throw new ApiError(422, 'invalid_phone_proof', 'Check the phone verification fields.');
    const context = this.captureAuthContext();
    const current = () => context.isCurrent() && (guard?.isCurrent() ?? true);
    if (!current()) throw this.changed();
    try {
      const result = await this.perform(path, 'POST', body, key, false, true);
      if (!current()) throw this.changed(true);
      const row = result.data;
      if (!row || typeof row !== 'object' || Array.isArray(row)
        || Object.keys(row).sort().join(',') !== 'challengeId,expiresAt,phoneNumber,resendAfter,status'
        || typeof row.challengeId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(row.challengeId)
        || (body.challengeId !== undefined && row.challengeId !== body.challengeId)
        || row.phoneNumber !== body.phoneNumber || row.status !== 'pending'
        || typeof row.expiresAt !== 'string' || !Number.isFinite(Date.parse(row.expiresAt))
        || typeof row.resendAfter !== 'string' || !Number.isFinite(Date.parse(row.resendAfter)))
        throw new ApiError(502, 'invalid_phone_challenge', 'The phone challenge could not be confirmed.', true);
      return row;
    } catch (error) {
      if (!current()) throw this.changed(true);
      throw error;
    }
  }

  private async authenticate(path: string, body: unknown, key?: string, guard?: AuthAttemptGuard, authenticated = false) {
    if (this.revokingAll) throw new ApiError(409, 'revocation_in_progress', 'Wait for session revocation to finish.');
    if (this.storageUncertain) throw new ApiError(0, 'secure_storage_failed', 'Secure session storage needs reconciliation.', false, true);
    if (guard && !guard.isCurrent()) throw this.changed();
    const auth = this.beginAuth(guard), session = this.sessionGeneration;
    const current = () => auth === this.authGeneration && session === this.sessionGeneration && (guard?.isCurrent() ?? true);
    let result: Awaited<ReturnType<FormTransport['perform']>>;
    try { result = await this.perform(path, 'POST', body, key, authenticated, true); }
    catch (error) { if (!current()) throw this.changed(true); throw error; }
    const { data, response } = result;
    const token = response.headers.get('set-auth-token');
    if (!token) {
      if (!current()) throw this.changed(true);
      throw new ApiError(502, 'missing_session', 'The server did not return a usable Form session.', false, true);
    }
    let failure: unknown;
    if (!current()) failure = this.changed(true);
    else if (data === null || typeof data !== 'object' || Array.isArray(data) ||
      (path === '/api/auth/phone-number/verify' && data.status !== true) || (guard?.validateResult && !guard.validateResult(data)))
      failure = new ApiError(502, 'invalid_response', 'Phone verification could not be confirmed.', false, true);
    else {
      try {
        await this.serializedStorage(async () => {
          if (!current()) throw this.changed(true);
          try { await this.storage.save(this.envelope(token)); }
          catch {
            try { await this.repairStorage(); } catch { /* Failed repair marks the storage boundary uncertain. */ }
            if (!current()) throw this.changed(true);
            throw new ApiError(0, 'secure_storage_failed', 'Secure session storage is unavailable.', false, true);
          }
          if (!current()) {
            await this.repairStorage();
            throw this.changed(true);
          }
          this.storageUncertain = false;
          this.setToken(token, guard);
        });
      } catch (error) { failure = error; }
    }
    if (!failure && (auth !== this.authGeneration || session + 1 !== this.sessionGeneration || !(guard?.isCurrent() ?? true))) {
      failure = this.changed(true);
      try {
        await this.serializedStorage(async () => {
          if (this.token === token && this.sessionGeneration === session + 1) {
            this.setToken(null);
            await this.repairStorage();
          }
        });
      } catch { /* The failure remains unknown; cleanup still targets only the issued remote token. */ }
    }
    if (failure) {
      // Revoke the issued token explicitly, never temporarily adopting it or borrowing a later session.
      let cleanupUnknown = false;
      try { await this.cleanupIssuedSession(token); } catch { cleanupUnknown = true; }
      if (failure instanceof ApiError) {
        failure.originalEffectUnknown = failure.originalEffectUnknown || cleanupUnknown;
        throw failure;
      }
      throw new ApiError(0, 'secure_storage_failed', 'Secure session storage is unavailable.', false, true);
    }
    return data;
  }

  private async cleanupIssuedSession(token: string): Promise<void> {
    if (this.token === token) throw new ApiError(409, 'session_cleanup_unknown',
      'The issued token matches the current session; cleanup needs reconciliation.', false, true);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await this.fetcher(this.baseURL.replace(/\/$/, '') + '/api/auth/sign-out', {
        method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: '{}', signal: controller.signal, redirect: 'error',
      });
      const data = await response.json();
      if (!response.ok || data?.success !== true) throw new Error('Session cleanup unconfirmed');
    } finally { clearTimeout(timeout); }
  }

  /** Captures only this local session; a confirmed disabled-account receipt is required by the host before use. */
  captureRevokedSessionClear(source: AuthAttemptGuard = this.captureAuthContext()): () => Promise<void> {
    const generation = this.sessionGeneration, originalAuth = this.authGeneration;
    let result: Promise<void> | undefined;
    return () => {
      result ??= Promise.resolve().then(async () => {
        if (generation !== this.sessionGeneration || originalAuth !== this.authGeneration) throw this.changed();
        const auth = this.beginAuth(source);
        if (auth !== originalAuth + 1) throw this.changed();
        await this.clearSession(generation, auth, source);
      });
      return result;
    };
  }

  async signOut(): Promise<void> {
    const auth = this.beginAuth(), generation = this.sessionGeneration;
    // Keep the original token if remote revocation is uncertain; never wipe a later account.
    const result = await this.request<{ success?: unknown }>('/api/auth/sign-out', 'POST', {});
    if (result.success !== true) throw new ApiError(502, 'revocation_unconfirmed', 'Sign-out could not be confirmed. Retry this same action.', true);
    await this.clearSession(generation, auth);
  }

  async revokeOtherSessions(): Promise<void> {
    await this.revokeSessions('/api/auth/revoke-other-sessions');
  }

  async revokeAllSessions(): Promise<void> {
    if (this.revokingAll) throw new ApiError(409, 'revocation_in_progress', 'Wait for session revocation to finish.');
    this.revokingAll = true;
    const auth = this.beginAuth(), generation = this.sessionGeneration;
    try {
      await this.revokeSessions('/api/auth/revoke-sessions');
      await this.clearSession(generation, auth);
    } finally { this.revokingAll = false; }
  }

  private async clearSession(generation: number, auth: number, source?: AuthAttemptGuard): Promise<void> {
    if (generation !== this.sessionGeneration || auth !== this.authGeneration) throw this.changed(true);
    // Fence and notify synchronously. A queued repair writes the then-current token, never an old session's clear.
    this.setToken(null, source);
    const cleared = this.sessionGeneration;
    await this.serializedStorage(async () => { await this.repairStorage(); });
    if (cleared !== this.sessionGeneration || auth !== this.authGeneration) throw this.changed(true);
  }

  private async revokeSessions(path: string): Promise<void> {
    const result = await this.request<{ status?: unknown }>(path, 'POST', {});
    if (result.status !== true) throw new ApiError(502, 'revocation_unconfirmed',
      'Session revocation could not be confirmed. Retry this same action.', true);
  }

  async request<T = unknown>(path: string, method = 'GET', body?: unknown, key?: string,
    attemptContext?: FormRequestAttemptContext): Promise<T> {
    if (attemptContext === undefined) return (await this.perform(path, method, body, key)).data as T;
    const auth = this.captureAuthContext();
    const captured = captureFormRequestAttemptContext(attemptContext);
    if (!captured || path !== '/v1/body/measurements' || method !== 'POST')
      throw new ApiError(400, 'invalid_attempt_context', 'Manual measurement context requires the exact create operation.');
    const assertDispatch = () => {
      if (!auth.isCurrent()) throw this.changed();
      const result: unknown = captured.assertCurrent();
      if (result !== undefined && result !== true) {
        if (result && (typeof result === 'object' || typeof result === 'function')) void Promise.resolve(result).catch(() => {});
        throw new ApiError(409, 'attempt_not_current', 'The original manual measurement attempt is no longer current.');
      }
      if (!auth.isCurrent()) throw this.changed();
    };
    assertDispatch();
    const { formatManualRetentionHeader, MANUAL_RETENTION_HEADER } = await import('../body/manualRetentionContract');
    assertDispatch();
    const retentionHeader = captured.manualRetention === null ? undefined : formatManualRetentionHeader(captured.manualRetention);
    if (retentionHeader === null) throw new ApiError(400, 'invalid_attempt_context', 'Manual measurement authority is invalid.');
    return (await this.perform(path, method, body, key, true, false,
      retentionHeader === undefined ? undefined : { name: MANUAL_RETENTION_HEADER, value: retentionHeader }, assertDispatch)).data as T;
  }

  private async perform(path: string, method: string, body?: unknown, key?: string, authenticated = true, authResponse = false,
    retentionHeader?: Readonly<{ name: typeof import('../body/manualRetentionContract').MANUAL_RETENTION_HEADER; value: string }>,
    assertDispatch?: () => void) {
    if (!path.startsWith('/') || path.startsWith('//')) throw new Error('Invalid API path');
    const generation = this.sessionGeneration;
    const auth = this.authGeneration;
    const assertCurrentSession = (issuedSessionResponse = false) => {
      if (authenticated && generation !== this.sessionGeneration && !issuedSessionResponse) {
        throw new ApiError(409, 'session_changed',
          'The account session changed. Check the original account before repeating a change.', false, method !== 'GET');
      }
    };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    let response: Response;
    let dispatched = false;
    try {
      const init: RequestInit = {
        method,
        headers: {
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(authenticated && this.token ? { Authorization: `Bearer ${this.token}` } : {}),
          ...(key ? { 'Idempotency-Key': key } : {}),
          ...(retentionHeader ? { [retentionHeader.name]: retentionHeader.value } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
        redirect: 'error',
      };
      assertDispatch?.();
      dispatched = true;
      response = await this.fetcher(this.baseURL.replace(/\/$/, '') + path, init);
    } catch (error) {
      if (!dispatched && assertDispatch) throw error;
      assertCurrentSession();
      throw new ApiError(0, 'network_unavailable', method === 'GET'
        ? 'Cannot reach Form. Check your private connection and try again.'
        : 'The result could not be confirmed. Retry this same action without changing it.', method !== 'GET');
    } finally { clearTimeout(timeout); }
    assertCurrentSession(authResponse && response.ok);
    let validJSON = true;
    const data = await response.json().catch(() => { validJSON = false; return null; }) as Record<string, unknown> | null;
    assertCurrentSession(authResponse && response.ok);
    if (!response.ok) {
      if (response.status === 401 && authenticated) {
        await this.clearSession(generation, auth);
      }
      const error = data?.error && typeof data.error === 'object'
        ? data.error as { code?: unknown; message?: unknown } : data;
      const code = String(error?.code ?? 'request_failed');
      throw new ApiError(response.status, code,
        typeof error?.message === 'string' ? error.message : 'Form could not save this change.',
        method !== 'GET' && (code === 'phone_outcome_unknown' || response.status >= 500));
    }
    const nullableRead = method === 'GET' && (path === '/v1/activity/calendar' || path === '/v1/activity/schedule');
    if (!authResponse && (!validJSON || (data === null && !nullableRead))) throw new ApiError(502, 'invalid_response',
      'The server result could not be confirmed. Refresh before changing this action.', method !== 'GET');
    return { data, response };
  }
}
