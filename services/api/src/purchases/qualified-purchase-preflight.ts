import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { constants, copyFileSync, linkSync, lstatSync, mkdtempSync, realpathSync, rmSync, unlinkSync, type BigIntStats } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { Sqlite } from '../storage.js';
import { backupAndVerify } from '../storage.js';
import { evidenceCanonical } from '../lifecycle/evidence-codec.js';
import { selectSourceSubscriptionStatusMigrations, assertSourceSubscriptionStatusHistory, assertSourceSubscriptionStatusSelection,
  assertSubscriptionStatusPreflight, openSourceSubscriptionStatusStorage } from './status-source-migrations.js';
import { notificationInboxSql, assertNotificationInboxSchema, validateInboxPolicy } from './notification-inbox-schema.js';
import { allSchemaDigest, validateQualifiedPurchaseConfiguration, validateQualifiedPurchasePolicy, configurationNamespaceCount,
  qualifiedNamespaceKey, readQualifiedStore, QUALIFIED_SCHEMA_VERSION } from './qualified-purchase-context.js';
import { assertQualifiedPurchaseSchema, qualifiedPurchaseSql, genuineSchemaReference, genuinePredecessorSchema, currentSchemaRows } from './qualified-purchase-schema.js';
import type { QualifiedPurchaseConfiguration, QualifiedPurchasePolicy, QualifiedStorage, SyntheticStoreInput } from './qualified-purchase.types.js';

const identity = /^[a-zA-Z0-9_-]{1,128}$/;
const reject = (code: string): never => { throw new Error(code); };

type Prepared = Readonly<{
  storeId: string; generation: string; ingress: string; inboxPolicyJson: string; configuration: QualifiedPurchaseConfiguration;
  policy: QualifiedPurchasePolicy; currentness: SyntheticStoreInput['currentness'];
}>;
/** Validates every explicit input before any path, handle or DDL is touched. No default is ever supplied. */
function prepare(input: SyntheticStoreInput): Prepared {
  if (!input || input.use !== 'isolated-synthetic' || !input.inbox || !input.currentness) return reject('qualified_purchase_input_rejected');
  const { storeId, generation } = input;
  const { ingress, policy: rawInboxPolicy } = input.inbox;
  const { generation: currentnessGeneration, check } = input.currentness;
  if ([storeId, generation, ingress, currentnessGeneration].some(value => typeof value !== 'string' || !identity.test(value)) ||
      typeof check !== 'function') return reject('qualified_purchase_input_rejected');
  const inboxPolicy = structuredClone(rawInboxPolicy);
  validateInboxPolicy(inboxPolicy);
  const inboxPolicyJson = JSON.stringify(inboxPolicy);
  const configuration = validateQualifiedPurchaseConfiguration(input.configuration);
  const policy = validateQualifiedPurchasePolicy(input.policy);
  configurationNamespaceCount(configuration, policy);
  return Object.freeze({ storeId, generation, ingress, inboxPolicyJson, configuration, policy,
    currentness: Object.freeze({ generation: currentnessGeneration, check }) });
}

type Phase = Parameters<Prepared['currentness']['check']>[0]['phase'];
/** The callback is neither operational authority nor producer settlement; only a synchronous literal true passes. */
function attest(prepared: Prepared, phase: Phase): void {
  const { check, generation: currentnessGeneration } = prepared.currentness;
  let value: unknown;
  try {
    value = check(Object.freeze({ storeId: prepared.storeId, generation: prepared.generation, currentnessGeneration, phase }));
  } catch { return reject('qualified_purchase_currentness_required'); }
  if (value !== true) reject('qualified_purchase_currentness_required');
}

function configureConnection(db: Sqlite): void {
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = FULL');
}
function assertDurableSettings(db: Sqlite): void {
  if (db.pragma('foreign_keys', { simple: true }) !== 1 || db.pragma('journal_mode', { simple: true }) !== 'wal' ||
      db.pragma('synchronous', { simple: true }) !== 2) reject('qualified_purchase_settings_required');
}

const safeTable = /^[A-Za-z_][A-Za-z0-9_]*$/;
const allowedPopulated = new Set(['form_migrations', 'exercises']);
/**
 * Exact genuine Selected27 and wholly empty application. Wrong, missing, extra or modified receipts, unreceipted or
 * hand-edited objects, partial extensions, any populated table other than the receipt table and the catalog, and any
 * integrity failure all refuse. Nothing is deleted, repaired or reset to make the predicate pass.
 */
export function assertEmptySource27ForQualifiedPurchases(db: Sqlite): void {
  // The failing step is recorded as the error cause so a refusal is attributable without exposing row contents.
  let step = 'handle';
  const check = (name: string, ok: boolean): void => { step = name; if (!ok) reject(name); };
  try {
    check('handle', db.open);
    check('receipts_required', db.prepare("SELECT 1 FROM main.sqlite_schema WHERE type='table' AND name='form_migrations'").get() !== undefined);
    step = 'history';
    assertSourceSubscriptionStatusHistory(db.prepare('SELECT version,checksum FROM main.form_migrations ORDER BY version').all() as { version: number; checksum: string }[], true);
    step = 'selection';
    assertSourceSubscriptionStatusSelection(selectSourceSubscriptionStatusMigrations());
    // Exact genuine predecessor schema first: unreceipted, hand-edited, missing or partial extension objects all differ here.
    const predecessor = genuinePredecessorSchema();
    check('schema_mismatch', JSON.stringify(currentSchemaRows(db)) === predecessor.json);
    // The finite table list is the exact genuine list established above, never caller input.
    for (const name of predecessor.tables) {
      if (allowedPopulated.has(name)) continue;
      check(`populated:${name}`, safeTable.test(name) && db.prepare(`SELECT 1 FROM main."${name}" LIMIT 1`).get() === undefined);
    }
    // Source validators and extension SQL use unqualified names. Exclude temporary objects before calling either.
    check('temp_schema', db.prepare('SELECT 1 FROM temp.sqlite_schema LIMIT 1').get() === undefined);
    step = 'source_preflight';
    assertSubscriptionStatusPreflight(db, true);
    check('integrity', db.pragma('main.integrity_check', { simple: true }) === 'ok' && (db.pragma('main.foreign_key_check') as unknown[]).length === 0);
  } catch { throw new Error('qualified_purchase_empty_source27_required', { cause: step }); }
}

function install(db: Sqlite, prepared: Prepared): void {
  const reference = genuineSchemaReference();
  db.exec(notificationInboxSql);
  db.exec(qualifiedPurchaseSql);
  // Mechanical installation of the unchanged notification inbox schema beside Source27; its fresh-only initializer is never called.
  db.prepare('INSERT INTO notification_inbox_store VALUES(1,?,?,?,?,0,?)')
    .run(prepared.storeId, prepared.generation, prepared.inboxPolicyJson, prepared.ingress, 'isolated-synthetic');
  db.prepare('INSERT INTO qualified_apple_store VALUES(1,?,?,?,?,?,?,?,?)').run(QUALIFIED_SCHEMA_VERSION, 'isolated-synthetic', prepared.storeId,
    prepared.generation, reference.predecessorDigest, reference.extensionDigest, evidenceCanonical(prepared.configuration), evidenceCanonical(prepared.policy));
  const insert = db.prepare('INSERT INTO qualified_apple_namespaces VALUES(?,?,?,?,?)');
  for (const item of prepared.configuration.namespaces) {
    insert.run(qualifiedNamespaceKey(item.namespace), 'Apple', item.namespace.bundleId, item.namespace.environment, item.namespace.appAppleId);
  }
  assertNotificationInboxSchema(db);
  assertQualifiedPurchaseSchema(db);
}

/** One immediate extension transaction: re-attest and re-check the empty predicate under the write lock, then install. */
function extend(db: Sqlite, prepared: Prepared, path: string, file: BigIntStats): void {
  assertUpgradeHandle(db, path, file);
  const marker = `"qualified_${randomUUID()}"`;
  db.exec('BEGIN IMMEDIATE');
  let ownsTransaction = true;
  try {
    db.exec(`SAVEPOINT ${marker}`);
    try {
      attest(prepared, 'under-lock');
    } finally {
      // A borrower might already hold this handle. The marker distinguishes our transaction from a replacement.
      ownsTransaction = false;
      if (!db.open || !db.inTransaction) reject('qualified_purchase_upgrade_rejected');
      try { db.exec(`RELEASE ${marker}`); }
      catch { reject('qualified_purchase_upgrade_rejected'); }
      ownsTransaction = true;
    }
    if (!sameFile(path, file)) reject('qualified_purchase_upgrade_rejected');
    assertDurableSettings(db);
    assertEmptySource27ForQualifiedPurchases(db);
    install(db, prepared);
    db.exec('COMMIT');
  } finally {
    if (ownsTransaction && db.open && db.inTransaction) db.exec('ROLLBACK');
  }
}

function assertCanonicalPath(path: string): void {
  if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path || path.trim() !== path || path.includes('\0'))
    reject('qualified_purchase_path_required');
}
const fileAt = (path: string) => lstatSync(path, { bigint: true, throwIfNoEntry: false });
function ownedFile(path: string): BigIntStats {
  assertCanonicalPath(path);
  const file = fileAt(path);
  if (!file?.isFile() || realpathSync(path) !== path) return reject('qualified_purchase_path_required');
  return file;
}
function sameFile(path: string, expected: BigIntStats): boolean {
  const actual = fileAt(path);
  return !!actual?.isFile() && actual.dev === expected.dev && actual.ino === expected.ino && realpathSync(path) === path;
}
const sidecars = (path: string) => [`${path}-wal`, `${path}-shm`, `${path}-journal`];
const closeOnce = (db: Sqlite) => (): void => { if (db.open) db.close(); };

function assertUpgradeHandle(db: Sqlite, path: string, file: BigIntStats): void {
  if (!db.open || db.inTransaction || db.readonly || db.name !== path || !sameFile(path, file)) reject('qualified_purchase_upgrade_rejected');
  assertDurableSettings(db);
}

function assertVacant(path: string): void {
  if ([path, ...sidecars(path)].some(item => fileAt(item))) reject('qualified_purchase_fresh_path_required');
}

/**
 * Stage genuine Selected27 on the same filesystem. Publish its closed file with an exclusive link before extension.
 * The staged migration backups retain their original paths and remain available on refusal.
 */
export async function openSyntheticQualifiedPurchaseStorage(path: string, input: SyntheticStoreInput): Promise<QualifiedStorage> {
  const prepared = prepare(input);
  assertCanonicalPath(path);
  assertVacant(path);
  const parent = dirname(path);
  if (!fileAt(parent)?.isDirectory() || realpathSync(parent) !== parent) return reject('qualified_purchase_path_required');
  const staged = join(mkdtempSync(join(parent, '.qualified-source27-')), 'source27.sqlite');
  const opened = await openSourceSubscriptionStatusStorage(staged, { mode: 'source-only', cohort: 'subscription-status-v1' });
  opened.db.close();
  const file = ownedFile(staged);
  try {
    // Never publish a WAL-dependent snapshot or replace an entry created while migrations were running.
    if (sidecars(staged).some(item => fileAt(item))) return reject('qualified_purchase_fresh_path_required');
    assertVacant(path);
    try { linkSync(staged, path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return reject('qualified_purchase_fresh_path_required');
      throw error;
    }
  } finally {
    if (sameFile(staged, file)) unlinkSync(staged);
  }
  if (!sameFile(path, file) || sidecars(path).some(item => fileAt(item))) return reject('qualified_purchase_fresh_path_required');
  const db = new Database(path, { fileMustExist: true });
  try {
    if (!sameFile(path, file) || sidecars(path).some(item => fileAt(item))) return reject('qualified_purchase_fresh_path_required');
    configureConnection(db);
    attest(prepared, 'before-backup');
    assertUpgradeHandle(db, path, file);
    assertEmptySource27ForQualifiedPurchases(db);
    extend(db, prepared, path, file);
    return Object.freeze({ ownership: 'owned' as const, db, storeId: prepared.storeId, generation: prepared.generation,
      schemaDigest: allSchemaDigest(db), migrationBackups: Object.freeze([...opened.migrationBackups]), close: closeOnce(db) });
  } catch (error) { if (db.open) db.close(); throw error; }
}

/**
 * Supported existing upgrade: an exactly empty genuine Selected27 fixture opened by the caller. Takes the existing
 * verified backup, repeats every check after the backup and again under BEGIN IMMEDIATE. The borrowed handle is never
 * closed by this function.
 */
export async function upgradeEmptySyntheticQualifiedPurchaseStorage(db: Sqlite, path: string, input: SyntheticStoreInput): Promise<QualifiedStorage> {
  const prepared = prepare(input);
  if (!db || !db.open || db.inTransaction || db.readonly) return reject('qualified_purchase_upgrade_rejected');
  const file = ownedFile(path);
  assertUpgradeHandle(db, path, file);
  attest(prepared, 'before-backup');
  assertUpgradeHandle(db, path, file);
  assertEmptySource27ForQualifiedPurchases(db);
  const destination = join(dirname(path), 'backups', `before-qualified-purchases-${randomUUID()}.sqlite`);
  await backupAndVerify(db, destination);
  assertUpgradeHandle(db, path, file);
  assertEmptySource27ForQualifiedPurchases(db);
  attest(prepared, 'after-backup');
  extend(db, prepared, path, file);
  return Object.freeze({ ownership: 'borrowed' as const, db, storeId: prepared.storeId, generation: prepared.generation,
    schemaDigest: allSchemaDigest(db), backups: Object.freeze([destination]) });
}

/** Exact readback and reopen of an already extended store. It never repairs, backfills or migrates policy. */
export function reopenSyntheticQualifiedPurchaseStorage(path: string, input: SyntheticStoreInput): QualifiedStorage {
  const prepared = prepare(input);
  const file = ownedFile(path);
  const assertCheckpoint = (): void => {
    const current = fileAt(path);
    if (!current || !sameFile(path, file) || current.size !== file.size || current.mtimeNs !== file.mtimeNs ||
        current.ctimeNs !== file.ctimeNs || sidecars(path).some(item => fileAt(item))) reject('qualified_purchase_held');
  };
  assertCheckpoint();
  attest(prepared, 'reopen');
  assertCheckpoint();
  // A read-only SQLite connection can create WAL sidecars. Validate a private copy of the checkpointed file.
  const probeRoot = mkdtempSync(join(dirname(path), '.qualified-reopen-'));
  let schemaDigest: string;
  try {
    const probePath = join(probeRoot, 'checkpoint.sqlite');
    copyFileSync(path, probePath, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
    assertCheckpoint();
    const probe = new Database(probePath, { readonly: true, fileMustExist: true });
    try {
      probe.pragma('foreign_keys = ON');
      assertQualifiedPurchaseSchema(probe);
      const record = readQualifiedStore(probe);
      const inbox = probe.prepare('SELECT ingress,policy_json FROM main.notification_inbox_store WHERE singleton=1').get() as { ingress: string; policy_json: string } | undefined;
      if (record.storeId !== prepared.storeId || record.generation !== prepared.generation ||
          record.configurationJson !== evidenceCanonical(prepared.configuration) || record.policyJson !== evidenceCanonical(prepared.policy) ||
          !inbox || inbox.ingress !== prepared.ingress || evidenceCanonical(JSON.parse(inbox.policy_json)) !== evidenceCanonical(JSON.parse(prepared.inboxPolicyJson))) reject('qualified_purchase_held');
      if (probe.pragma('main.journal_mode', { simple: true }) !== 'wal') reject('qualified_purchase_settings_required');
      schemaDigest = allSchemaDigest(probe);
    } finally { probe.close(); }
  } finally { rmSync(probeRoot, { recursive: true, force: true }); }

  assertCheckpoint();
  const db = new Database(path, { fileMustExist: true });
  try {
    assertCheckpoint();
    configureConnection(db);
    return Object.freeze({ ownership: 'owned' as const, db, storeId: prepared.storeId, generation: prepared.generation,
      schemaDigest, migrationBackups: Object.freeze([] as string[]), close: closeOnce(db) });
  } catch (error) { if (db.open) db.close(); throw error; }
}
