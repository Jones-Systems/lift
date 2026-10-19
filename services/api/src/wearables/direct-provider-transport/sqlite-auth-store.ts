import type { Sqlite } from '../../storage.js';
import type { AuthStateRecord, AuthStateTransaction, DurableAuthStateStore } from './auth-state-types.js';
import { validateAuthStateRecord } from './auth-state.js';
import { providerAuthStateIndexSql, providerAuthStateTableSql } from './auth-store-schema.js';

export interface SqliteAuthStoreOptions {
  db: Sqlite;
  // Enter root's immediate writer transaction on this exact handle, or propagate failure without an independent commit.
  runRootWrite<T>(effect: () => T): T;
  // Verify exact database identity and root writer custody, including lifecycle writers; inTransaction alone is insufficient.
  assertRootWriter(db: Sqlite): void;
}
const rowLimit = 1048576, readLimit = 16777216;
function invalid(): never { throw new Error('provider_auth_store_unavailable'); }
function safe<T>(effect: () => T): T { try { return effect(); } catch { return invalid(); } }
function integer(value: number, minimum = 0): void { if (!Number.isSafeInteger(value) || value < minimum) invalid(); }
function text(value: string, max: number): void {
  if (typeof value !== 'string' || !value.length || value.length > max || Buffer.byteLength(value) > max) invalid();
}
function keys(value: unknown, expected: string[]): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const actual = Object.keys(value);
  if (actual.length !== expected.length || expected.some(key => !Object.hasOwn(value, key))) invalid();
}
function strict(record: AuthStateRecord): void {
  keys(record, ['schema', 'key', 'revision', 'scope', 'suppressedEpoch', 'flows', 'operations', 'tokens']);
  keys(record.scope, ['accountId', 'sessionId', 'epoch', 'connectionId', 'generation', 'provider']);
  validateAuthStateRecord(record);
  const secretKeys = ['reference', 'purpose', 'ciphertext', 'expiresAtMs', 'version'];
  for (const flow of record.flows) {
    keys(flow, ['stateDigest', 'operationId', 'redirectUri', 'expiresAtMs', 'expectedVersion', 'status', 'verifier']);
    if (flow.verifier !== null) keys(flow.verifier, secretKeys);
  }
  for (const op of record.operations) {
    keys(op, ['operationId', 'kind', 'phase', 'leaseId', 'expectedVersion', 'startedAtMs', 'tokenDigest', 'receipt']);
    if (op.receipt !== null) keys(op.receipt, ['accessSecretRef', 'version']);
  }
  if (record.tokens !== null) {
    keys(record.tokens, ['version', 'issuedAtMs', 'access', 'refresh']); keys(record.tokens.access, secretKeys); keys(record.tokens.refresh, secretKeys);
  }
}
type Row = { record_key: string; account_id: string; revision: number; bytes: number; data: string | null };
function decode(row: Row): AuthStateRecord {
  if (typeof row.data !== 'string' || !Number.isSafeInteger(row.bytes) || row.bytes < 1 || row.bytes > rowLimit || Buffer.byteLength(row.data) !== row.bytes) invalid();
  const record = JSON.parse(row.data) as AuthStateRecord; strict(record);
  if (record.key !== row.record_key || record.scope.accountId !== row.account_id || record.revision !== row.revision) invalid();
  return record;
}
function synchronous<T>(value: T): T {
  if (value !== null && (typeof value === 'object' || typeof value === 'function') && typeof (value as { then?: unknown }).then === 'function') invalid();
  return value;
}
const normalizeSql = (value: string) => value.trim().replace(/;$/, '').replace(/\s+/g, ' ');

export function createSqliteAuthStateStore(input: SqliteAuthStoreOptions): DurableAuthStateStore {
  const { db, runRootWrite, assertRootWriter } = input;
  let schemaVersion = -1;
  function qualify(): void {
    if (!db.open || db.pragma('foreign_keys', { simple: true }) !== 1) invalid();
    const version = db.pragma('schema_version', { simple: true });
    if (typeof version !== 'number') invalid();
    if (schemaVersion === version) return;
    const rows = db.prepare('SELECT type,name,sql FROM sqlite_schema WHERE tbl_name=? ORDER BY name').all('wearable_provider_auth_state') as { type: string; name: string; sql: string | null }[];
    const expected = new Map([
      ['wearable_provider_auth_state', ['table', normalizeSql(providerAuthStateTableSql)]],
      ['wearable_provider_auth_account', ['index', normalizeSql(providerAuthStateIndexSql)]],
      ['sqlite_autoindex_wearable_provider_auth_state_1', ['index', null]],
    ]);
    if (rows.length !== expected.size || rows.some(row => {
      const match = expected.get(row.name);
      return !match || match[0] !== row.type || match[1] !== (row.sql === null ? null : normalizeSql(row.sql));
    })) invalid();
    schemaVersion = version;
  }
  safe(qualify);
  const projection = 'record_key,account_id,revision,length(CAST(data AS BLOB)) AS bytes,CASE WHEN length(CAST(data AS BLOB))<=1048576 THEN data ELSE NULL END AS data';
  function guard(): void {
    if (!db.inTransaction) invalid(); qualify(); synchronous(assertRootWriter(db));
  }
  function within<T>(effect: () => T): T { return safe(() => { guard(); const result = effect(); guard(); return result; }); }
  const tx: AuthStateTransaction = {
    get(key) {
      return within(() => {
        text(key, 32768);
        const row = db.prepare('SELECT ' + projection + ' FROM wearable_provider_auth_state WHERE record_key=?').get(key) as Row | undefined;
        return row === undefined ? null : decode(row);
      });
    },
    compareAndSwap(key, expectedRevision, next) {
      return within(() => {
        text(key, 32768); strict(next);
        if (key !== next.key) invalid(); text(next.scope.accountId, 8192);
        if (expectedRevision !== null) integer(expectedRevision);
        if (next.revision !== (expectedRevision === null ? 0 : expectedRevision + 1)) invalid();
        const encoded = JSON.stringify(next);
        if (Buffer.byteLength(encoded) > rowLimit) invalid();
        // Decode the actual serialized form as well; custom serializers cannot smuggle extra credential fields into storage.
        decode({ record_key: key, account_id: next.scope.accountId, revision: next.revision, bytes: Buffer.byteLength(encoded), data: encoded });
        const result = expectedRevision === null
          ? db.prepare('INSERT INTO wearable_provider_auth_state(record_key,account_id,revision,data) VALUES(?,?,?,?) ON CONFLICT(record_key) DO NOTHING').run(key, next.scope.accountId, next.revision, encoded)
          : db.prepare('UPDATE wearable_provider_auth_state SET revision=?,data=? WHERE record_key=? AND account_id=? AND revision=?').run(next.revision, encoded, key, next.scope.accountId, expectedRevision);
        return result.changes === 1;
      });
    },
    listAccount(accountId, limit) {
      return within(() => {
        text(accountId, 8192); integer(limit, 1); if (limit > 257) invalid();
        const size = db.prepare('SELECT coalesce(sum(bytes),0) AS bytes FROM (SELECT length(CAST(data AS BLOB)) AS bytes FROM wearable_provider_auth_state WHERE account_id=? ORDER BY record_key LIMIT ?)').get(accountId, limit) as { bytes: number };
        if (!Number.isSafeInteger(size.bytes) || size.bytes > readLimit) invalid();
        const rows = db.prepare('SELECT ' + projection + ' FROM wearable_provider_auth_state WHERE account_id=? ORDER BY record_key LIMIT ?').all(accountId, limit) as Row[];
        return rows.map(row => { const record = decode(row); if (record.scope.accountId !== accountId) invalid(); return record; });
      });
    },
    delete(key, expectedRevision) {
      return within(() => {
        text(key, 32768); integer(expectedRevision);
        return db.prepare('DELETE FROM wearable_provider_auth_state WHERE record_key=? AND revision=?').run(key, expectedRevision).changes === 1;
      });
    },
  };
  function savepoint<T>(effect: (transaction: AuthStateTransaction) => T): T {
    guard();
    return db.transaction(() => { guard(); const result = synchronous(effect(tx)); guard(); return result; }).immediate();
  }
  return {
    transaction<T>(effect: (transaction: AuthStateTransaction) => T): T {
      return safe(() => {
        if (db.inTransaction) return savepoint(effect);
        let called = false;
        const result = synchronous(runRootWrite(() => {
          if (called) invalid(); called = true;
          return savepoint(effect);
        }));
        if (!called) invalid(); return result;
      });
    },
    currentTransaction() { return within(() => tx); },
  };
}
