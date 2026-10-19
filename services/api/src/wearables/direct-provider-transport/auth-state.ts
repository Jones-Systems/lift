import { createHash } from 'node:crypto';
import { authorizationUrl } from '../providers/oauth.js';
import type { OAuthVault } from '../providers/oauth.js';
import { tokenResponse } from '../providers/http.js';
import type { TokenResponse } from '../providers/http.js';
import type { ProviderScope, ScopedSecretResolver, SecretLease } from './index.js';
import type { AuthStateOptions, AuthStateRecord, AuthStateTransaction, ExchangeOperation, StoredSecret } from './auth-state-types.js';

export class AuthStateFailure extends Error {
  readonly code: 'auth_state_invalid' | 'auth_state_unavailable' | 'auth_state_conflict' | 'auth_state_pending' | 'auth_state_expired' | 'auth_state_capacity';
  constructor(code: AuthStateFailure['code']) { super(code); this.code = code; }
}
function fail(code: AuthStateFailure['code'] = 'auth_state_invalid'): never { throw new AuthStateFailure(code); }
const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
const scopeValue = (scope: ProviderScope): string => JSON.stringify([scope.accountId, scope.sessionId, scope.epoch, scope.provider, scope.connectionId, scope.generation]);
export const authStateKey = (scope: ProviderScope): string => JSON.stringify([scope.accountId, scope.provider, scope.connectionId, scope.generation]);
function text(value: unknown, max = 2048): asserts value is string {
  if (typeof value !== 'string' || !value.length || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) fail();
}
function integer(value: number, minimum = 0): number {
  if (!Number.isSafeInteger(value) || value < minimum) fail(); return value;
}
function safe<T>(effect: () => T): T {
  try { return effect(); } catch (error) { if (error instanceof AuthStateFailure) throw error; throw new AuthStateFailure('auth_state_unavailable'); }
}
function capacity(value: number | undefined, fallback: number, max: number): number {
  const result = value ?? fallback; if (integer(result, 1) > max) fail(); return result;
}
function validateScope(scope: ProviderScope): void {
  text(scope.accountId); text(scope.sessionId); text(scope.connectionId);
  integer(scope.epoch); integer(scope.generation);
  if (!['oura', 'garmin'].includes(scope.provider)) fail();
}
function validateSecret(secret: StoredSecret, purpose: StoredSecret['purpose'], version: number): void {
  text(secret.reference); text(secret.ciphertext, 65536);
  if (secret.purpose !== purpose || secret.version !== version) fail();
  if (secret.expiresAtMs !== null) integer(secret.expiresAtMs);
}
export function validateAuthStateRecord(record: AuthStateRecord): void {
  if (record.schema !== 1) fail(); validateScope(record.scope); integer(record.revision);
  if (record.key !== authStateKey(record.scope) || !Array.isArray(record.flows) || !Array.isArray(record.operations) || record.flows.length > 16 || record.operations.length > 128) fail();
  if (record.suppressedEpoch !== null) integer(record.suppressedEpoch, 1);
  const states = new Set<string>(), operations = new Set<string>(), leases = new Set<string>();
  for (const flow of record.flows) {
    if (!/^[a-f0-9]{64}$/.test(flow.stateDigest) || states.has(flow.stateDigest) || !['pending', 'consumed', 'retired'].includes(flow.status)) fail();
    states.add(flow.stateDigest); text(flow.operationId, 256); text(flow.redirectUri, 8192); integer(flow.expiresAtMs); integer(flow.expectedVersion);
    if (flow.verifier !== null) validateSecret(flow.verifier, 'code_verifier', flow.expectedVersion);
  }
  for (const op of record.operations) {
    text(op.operationId, 256);
    if (operations.has(op.operationId) || !['code', 'refresh'].includes(op.kind) || !['ready', 'leased', 'unknown', 'committed', 'rejected'].includes(op.phase)) fail();
    operations.add(op.operationId); integer(op.expectedVersion);
    if (op.leaseId !== null) { text(op.leaseId, 256); if (leases.has(op.leaseId)) fail(); leases.add(op.leaseId); }
    if (op.startedAtMs !== null) integer(op.startedAtMs);
    if (op.phase === 'ready' ? op.leaseId !== null || op.startedAtMs !== null : op.leaseId === null || op.startedAtMs === null) fail();
    if (op.phase === 'committed') {
      if (!op.receipt || op.receipt.version !== op.expectedVersion + 1 || !op.tokenDigest || !/^[a-f0-9]{64}$/.test(op.tokenDigest)) fail();
      text(op.receipt.accessSecretRef);
    } else if (op.receipt !== null || op.tokenDigest !== null) fail();
  }
  if (record.operations.filter(op => ['ready', 'leased', 'unknown'].includes(op.phase)).length > 1) fail();
  if (record.tokens !== null) {
    integer(record.tokens.version, 1); integer(record.tokens.issuedAtMs);
    validateSecret(record.tokens.access, 'access_token', record.tokens.version);
    validateSecret(record.tokens.refresh, 'refresh_token', record.tokens.version);
    if (record.tokens.access.expiresAtMs === null || record.tokens.access.reference === record.tokens.refresh.reference) fail();
  }
}
export function accountAuthRecords(tx: AuthStateTransaction, accountId: string, max: number): AuthStateRecord[] {
  text(accountId); const records = tx.listAccount(accountId, max + 1);
  if (!Array.isArray(records) || records.length > max) fail('auth_state_capacity');
  const keys = new Set<string>();
  for (const record of records) {
    validateAuthStateRecord(record);
    if (record.scope.accountId !== accountId || keys.has(record.key)) fail(); keys.add(record.key);
  }
  return records;
}
function aad(scope: ProviderScope, secret: Omit<StoredSecret, 'ciphertext'>): string {
  return JSON.stringify(['form-provider-auth-v1', scopeValue(scope), secret.reference, secret.purpose, secret.version, secret.expiresAtMs]);
}
const unresolved = (op: ExchangeOperation) => ['ready', 'leased', 'unknown'].includes(op.phase);
export type OperationReconciliation = { status: 'committed'; receipt: { accessSecretRef: string; version: number } } |
  { status: 'pending' | 'unknown' | 'rejected' | 'absent' };

export function createProviderAuthState(input: AuthStateOptions) {
  const scope: ProviderScope = Object.freeze({ ...input.scope });
  validateScope(scope);
  const { store, cipher, randomBytes, now, assertCurrent, assertRefreshUsable, clientSecrets } = input;
  const clientId = input.clientId, clientSecretRef = input.clientSecretRef;
  text(clientId); text(clientSecretRef);
  const lifetime = integer(input.stateLifetimeMs, 1);
  const maxFlows = capacity(input.limits?.flows, 8, 16), maxOperations = capacity(input.limits?.operations, 64, 128);
  const maxAccounts = capacity(input.limits?.accountRecords, 64, 256);
  const redirects = new Set(input.allowedRedirectUris);
  for (const uri of redirects) {
    text(uri, 8192); const url = new URL(uri);
    if (url.href !== uri || url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) fail();
  }
  const key = authStateKey(scope), clock = () => integer(now());
  function random(): string {
    const bytes = randomBytes(32);
    if (!(bytes instanceof Uint8Array) || bytes.byteLength !== 32) fail('auth_state_unavailable');
    return Buffer.from(bytes).toString('base64url');
  }
  function load(tx: AuthStateTransaction): AuthStateRecord {
    const record = tx.get(key); if (!record) fail('auth_state_conflict');
    validateAuthStateRecord(record);
    if (scopeValue(record.scope) !== scopeValue(scope) || record.suppressedEpoch !== null) fail('auth_state_conflict');
    return record;
  }
  function active<T>(effect: (record: AuthStateRecord, tx: AuthStateTransaction) => T, write = false, create = false): T {
    return safe(() => store.transaction(tx => {
      assertCurrent(scope);
      const prior = tx.get(key);
      let record: AuthStateRecord;
      if (prior === null && create) {
        if (accountAuthRecords(tx, scope.accountId, maxAccounts).length >= maxAccounts) fail('auth_state_capacity');
        record = { schema: 1, key, revision: 0, scope, suppressedEpoch: null, flows: [], operations: [], tokens: null };
      } else record = load(tx);
      const result = effect(record, tx);
      assertCurrent(scope);
      if (write) {
        const revision = prior?.revision ?? null;
        record.revision = revision === null ? 0 : integer(revision + 1);
        validateAuthStateRecord(record);
        if (!tx.compareAndSwap(key, revision, record)) fail('auth_state_conflict');
        assertCurrent(scope);
      }
      return result;
    }));
  }
  function sealed(value: string, purpose: StoredSecret['purpose'], version: number, expiresAtMs: number | null): StoredSecret {
    text(value, 16384);
    const identity = { reference: 'authref:' + random(), purpose, version, expiresAtMs };
    const ciphertext = cipher.seal(value, aad(scope, identity)); text(ciphertext, 65536);
    return { ...identity, ciphertext };
  }
  function available(record: AuthStateRecord): void {
    if (record.operations.some(unresolved)) fail('auth_state_pending');
  }
  function refreshUsable(record: AuthStateRecord): NonNullable<AuthStateRecord['tokens']> {
    const tokens = record.tokens; if (!tokens) fail('auth_state_conflict');
    if (tokens.refresh.expiresAtMs !== null && tokens.refresh.expiresAtMs <= clock()) fail('auth_state_expired');
    assertRefreshUsable(scope, { version: tokens.version, issuedAtMs: tokens.issuedAtMs, expiresAtMs: tokens.refresh.expiresAtMs });
    return tokens;
  }
  function newOperation(record: AuthStateRecord, operationId: string, kind: ExchangeOperation['kind']): ExchangeOperation {
    text(operationId, 256);
    if (record.operations.some(op => op.operationId === operationId)) fail('auth_state_conflict');
    if (record.operations.length >= maxOperations) fail('auth_state_capacity');
    const op: ExchangeOperation = { operationId, kind, phase: 'ready', leaseId: null, expectedVersion: record.tokens?.version ?? 0,
      startedAtMs: null, tokenDigest: null, receipt: null };
    record.operations.push(op); return op;
  }
  function leaseOperation(record: AuthStateRecord, leaseId: string): ExchangeOperation {
    text(leaseId, 256); const op = record.operations.find(value => value.leaseId === leaseId);
    if (!op) fail('auth_state_conflict'); return op;
  }
  function retireVerifier(record: AuthStateRecord, operationId: string): void {
    const flow = record.flows.find(value => value.operationId === operationId);
    if (flow) { flow.verifier = null; flow.status = 'retired'; }
  }
  const vault: OAuthVault = {
    begin(kind, operationId) {
      return active(record => {
        let op: ExchangeOperation;
        let secretRef: string, redirectUri: string | null = null;
        if (kind === 'code') {
          const found = record.operations.find(value => value.operationId === operationId);
          if (!found || found.kind !== 'code' || found.phase !== 'ready' || record.operations.some(value => value !== found && unresolved(value))) fail('auth_state_pending');
          op = found;
          const flow = record.flows.find(value => value.operationId === operationId);
          if (!flow || flow.status !== 'consumed' || !flow.verifier || flow.expectedVersion !== (record.tokens?.version ?? 0)) fail('auth_state_conflict');
          if (flow.expiresAtMs <= clock()) fail('auth_state_expired');
          secretRef = flow.verifier.reference; redirectUri = flow.redirectUri;
        } else if (kind === 'refresh') {
          available(record); const tokens = refreshUsable(record);
          op = newOperation(record, operationId, kind); secretRef = tokens.refresh.reference;
        } else return fail();
        op.phase = 'leased'; op.leaseId = 'lease:' + random(); op.startedAtMs = clock();
        return { id: op.leaseId, secretRef, redirectUri };
      }, true);
    },
    commit(leaseId, raw: TokenResponse) {
      return active(record => {
        const op = leaseOperation(record, leaseId);
        const tokens = tokenResponse({ ...raw, refresh_token_expires_in: raw.refresh_token_expires_in ?? undefined });
        if (tokens.scope !== null) text(tokens.scope);
        const tokenDigest = digest(JSON.stringify(tokens));
        if (op.phase === 'committed') {
          if (op.tokenDigest !== tokenDigest || !op.receipt) fail('auth_state_conflict');
          return { ...op.receipt };
        }
        if (op.phase !== 'leased' || op.expectedVersion !== (record.tokens?.version ?? 0) || op.startedAtMs === null) fail('auth_state_conflict');
        const version = integer(op.expectedVersion + 1, 1);
        const expiresAtMs = integer(op.startedAtMs + tokens.expires_in * 1000);
        const refreshExpiresAtMs = tokens.refresh_token_expires_in === null ? null : integer(op.startedAtMs + tokens.refresh_token_expires_in * 1000);
        if (expiresAtMs <= clock() || (refreshExpiresAtMs !== null && refreshExpiresAtMs <= clock())) fail('auth_state_expired');
        const access = sealed(tokens.access_token, 'access_token', version, expiresAtMs);
        const refresh = sealed(tokens.refresh_token, 'refresh_token', version, refreshExpiresAtMs);
        if (access.reference === refresh.reference || [record.tokens?.access.reference, record.tokens?.refresh.reference, clientSecretRef].includes(access.reference) ||
          [record.tokens?.access.reference, record.tokens?.refresh.reference, clientSecretRef].includes(refresh.reference)) fail('auth_state_conflict');
        record.tokens = { version, issuedAtMs: op.startedAtMs, access, refresh };
        op.phase = 'committed'; op.tokenDigest = tokenDigest; op.receipt = { accessSecretRef: access.reference, version };
        retireVerifier(record, op.operationId); return { ...op.receipt };
      }, true);
    },
    unknown(leaseId) {
      active(record => {
        const op = leaseOperation(record, leaseId);
        // A committed receipt remains authoritative even when its caller lost the transaction acknowledgement.
        if (op.phase === 'committed' || op.phase === 'rejected' || op.phase === 'unknown') return;
        if (op.phase !== 'leased') fail('auth_state_conflict');
        op.phase = 'unknown'; retireVerifier(record, op.operationId);
      }, true);
    },
    rejected(leaseId) {
      active(record => {
        const op = leaseOperation(record, leaseId);
        if (op.phase === 'committed' || op.phase === 'rejected') return;
        if (op.phase !== 'leased') fail('auth_state_pending');
        op.phase = 'rejected'; retireVerifier(record, op.operationId);
      }, true);
    },
  };
  const secrets: ScopedSecretResolver = {
    async acquire(requestScope, reference, purpose, signal) {
      let external: SecretLease | undefined;
      try {
        if (scopeValue(requestScope) !== scopeValue(scope) || signal.aborted) fail('auth_state_conflict');
        text(reference);
        if (purpose === 'client_secret') {
          if (reference !== clientSecretRef) fail('auth_state_conflict');
          const requireLease = () => active(record => { if (!record.operations.some(op => op.phase === 'leased')) fail('auth_state_pending'); });
          requireLease(); external = await clientSecrets.acquire(scope, reference, purpose, signal);
          requireLease(); if (signal.aborted) fail('auth_state_conflict');
          text(external.value, 16384); let released = false;
          const lease = external;
          return { get value() { if (released) fail('auth_state_conflict'); return lease.value; }, release() { if (!released) { released = true; lease.release(); } } };
        }
        const plaintext = active(record => {
          let value: StoredSecret | undefined;
          if (purpose === 'access_token') {
            if (record.operations.some(op => op.phase === 'leased' || op.phase === 'unknown')) fail('auth_state_pending');
            value = record.tokens?.access;
          } else if (purpose === 'refresh_token') {
            const tokens = refreshUsable(record);
            if (!record.operations.some(op => op.kind === 'refresh' && op.phase === 'leased' && op.expectedVersion === tokens.version)) fail('auth_state_pending');
            value = tokens.refresh;
          } else if (purpose === 'code_verifier') {
            const flow = record.flows.find(item => item.verifier?.reference === reference);
            if (!flow || flow.status !== 'consumed' || !record.operations.some(op => op.operationId === flow.operationId && op.phase === 'leased')) fail('auth_state_pending');
            value = flow.verifier ?? undefined;
          } else fail();
          if (!value || value.reference !== reference || value.purpose !== purpose) fail('auth_state_conflict');
          if (value.expiresAtMs !== null && value.expiresAtMs <= clock()) fail('auth_state_expired');
          const result = cipher.open(value.ciphertext, aad(scope, value)); text(result, 16384); return result;
        });
        if (signal.aborted) fail('auth_state_conflict');
        let value: string | null = plaintext;
        return { get value() { if (value === null) fail('auth_state_conflict'); return value; }, release() { value = null; } };
      } catch (error) {
        external?.release();
        if (error instanceof AuthStateFailure) throw error;
        throw new AuthStateFailure('auth_state_unavailable');
      }
    },
  };
  return {
    vault, secrets,
    beginAuthorization(redirectUri: string, scopes: string[]) {
      return active(record => {
        available(record); if (!redirects.has(redirectUri)) fail();
        if (record.flows.length >= maxFlows || record.operations.length >= maxOperations) fail('auth_state_capacity');
        const state = random(), verifier = random(), operationId = 'code:' + random(), stateDigest = digest(state);
        if (record.flows.some(flow => flow.stateDigest === stateDigest || flow.operationId === operationId)) fail('auth_state_conflict');
        const expiresAtMs = integer(clock() + lifetime), version = record.tokens?.version ?? 0;
        const encryptedVerifier = sealed(verifier, 'code_verifier', version, expiresAtMs);
        record.flows.push({ stateDigest, operationId, redirectUri, expiresAtMs, expectedVersion: version, status: 'pending', verifier: encryptedVerifier });
        return { url: authorizationUrl(scope.provider, { clientId, redirectUri, state, verifier, scopes }), expiresAtMs };
      }, true, true);
    },
    consumeCallback(state: string, code: string) {
      return active(record => {
        text(state, 256); text(code, 2048); available(record);
        const flow = record.flows.find(value => value.stateDigest === digest(state));
        if (!flow || flow.status !== 'pending' || !flow.verifier || flow.expectedVersion !== (record.tokens?.version ?? 0) || !redirects.has(flow.redirectUri)) fail('auth_state_conflict');
        if (flow.expiresAtMs <= clock()) fail('auth_state_expired');
        newOperation(record, flow.operationId, 'code'); flow.status = 'consumed';
        return { operationId: flow.operationId, verifierRef: flow.verifier.reference, redirectUri: flow.redirectUri };
      }, true);
    },
    reconcile(operationId: string): OperationReconciliation {
      return active<OperationReconciliation>(record => {
        text(operationId, 256); const op = record.operations.find(value => value.operationId === operationId);
        if (!op) return { status: 'absent' };
        if (op.phase === 'committed' && op.receipt) return { status: 'committed', receipt: { ...op.receipt } };
        if (op.phase === 'rejected') return { status: 'rejected' };
        return { status: op.phase === 'ready' ? 'pending' : 'unknown' };
      });
    },
  };
}
