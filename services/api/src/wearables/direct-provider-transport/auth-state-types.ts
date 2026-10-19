import type { ProviderScope, ScopedSecretResolver } from './index.js';

export type StoredSecret = Readonly<{
  reference: string; purpose: 'access_token' | 'refresh_token' | 'code_verifier';
  ciphertext: string; expiresAtMs: number | null; version: number;
}>;
export type AuthorizationFlow = {
  stateDigest: string; operationId: string; redirectUri: string; expiresAtMs: number;
  expectedVersion: number; status: 'pending' | 'consumed' | 'retired'; verifier: StoredSecret | null;
};
export type ExchangeOperation = {
  operationId: string; kind: 'code' | 'refresh'; phase: 'ready' | 'leased' | 'unknown' | 'committed' | 'rejected';
  leaseId: string | null; expectedVersion: number; startedAtMs: number | null;
  tokenDigest: string | null; receipt: { accessSecretRef: string; version: number } | null;
};
export type AuthStateRecord = {
  schema: 1; key: string; revision: number; scope: ProviderScope; suppressedEpoch: number | null;
  flows: AuthorizationFlow[]; operations: ExchangeOperation[];
  tokens: { version: number; issuedAtMs: number; access: StoredSecret; refresh: StoredSecret } | null;
};
export interface AuthStateTransaction {
  // Return detached values. CAS and all reads/writes participate in the same root transaction.
  get(key: string): AuthStateRecord | null;
  compareAndSwap(key: string, expectedRevision: number | null, next: AuthStateRecord): boolean;
  listAccount(accountId: string, limit: number): AuthStateRecord[];
  delete(key: string, expectedRevision: number): boolean;
}
export interface DurableAuthStateStore {
  // Synchronous serializable rollback boundary, including currentness failure. Within a root transaction use a savepoint, never an independent commit.
  transaction<T>(effect: (transaction: AuthStateTransaction) => T): T;
  // Must throw unless the root already owns the current writer transaction; never open an independent transaction.
  currentTransaction(): AuthStateTransaction;
}
export interface AuthenticatedCipher {
  seal(plaintext: string, associatedData: string): string;
  open(ciphertext: string, associatedData: string): string;
}
export interface AuthStateOptions {
  scope: ProviderScope;
  store: DurableAuthStateStore;
  cipher: AuthenticatedCipher;
  randomBytes(length: number): Uint8Array;
  now(): number;
  assertCurrent(scope: ProviderScope): void;
  // A null provider expiry is unknown, not indefinite validity. Root must qualify it before refresh use.
  assertRefreshUsable(scope: ProviderScope, token: Readonly<{ version: number; issuedAtMs: number; expiresAtMs: number | null }>): void;
  clientId: string;
  clientSecretRef: string;
  clientSecrets: ScopedSecretResolver;
  allowedRedirectUris: readonly string[];
  stateLifetimeMs: number;
  limits?: { flows?: number; operations?: number; accountRecords?: number };
}
export interface AuthLifecycleOptions {
  store: DurableAuthStateStore;
  assertAccountCurrent(context: import('../../lifecycle/types.js').AccountContext): void;
  assertSuppression(accountId: string, epoch: number): void;
  purgeReadiness(requestId: string, accountId: string): { status: 'ready'; epoch: number } | { status: 'pending' | 'unavailable' | 'unknown' | 'retained'; reason?: string };
  maxAccountRecords?: number;
}
