import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Sqlite } from '../../src/storage.js';
import { notificationPayloadDigest } from '../../src/purchases/notification-inbox.js';
import { initializeSyntheticNotificationInbox, notificationInboxSql } from '../../src/purchases/notification-inbox-schema.js';
import { selectSourceSubscriptionStatusMigrations } from '../../src/purchases/status-source-migrations.js';
import { assertEmptySource27ForQualifiedPurchases, openSyntheticQualifiedPurchaseStorage, reopenSyntheticQualifiedPurchaseStorage,
  upgradeEmptySyntheticQualifiedPurchaseStorage } from '../../src/purchases/qualified-purchase-preflight.js';
import { assertQualifiedPurchaseSchema, formMigrationsDefinition, genuinePredecessorSchema, genuineSchemaReference, predecessorPurchaseTables,
  qualifiedPurchaseDescriptors, qualifiedPurchaseSql } from '../../src/purchases/qualified-purchase-schema.js';
import { allSchemaDigest, qualifiedNamespaceKey, validateQualifiedPurchaseConfiguration, validateQualifiedPurchasePolicy } from '../../src/purchases/qualified-purchase-context.js';
import { ACCOUNT_A, ACCOUNT_B, ALL_NAMESPACES, PRD_A, PRD_B, SBX_A, SBX_B, STORE_GENERATION, STORE_ID, configurationFor, count, currentnessProbe, emptySource27,
  inboxPolicy, migrationRows, nsKey, policy, qualified, schemaObjects, scratch, seedAccount, seedCommand, seedDelivery, seedNotification, seedOwner,
  seedDependency, seedProjection, seedProofObservation, seedReconciliation, seedStatusObservation, seedTransaction, sha, storeInput, tableCounts, userTables } from './qualified-purchase-fixture.js';

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../src');
const refused = (statement: () => unknown, pattern: RegExp) => assert.throws(statement, (error: unknown) => error instanceof Error && pattern.test(error.message), String(pattern));
const sqliteRefusal = /constraint failed|qualified_apple_/i;
const A_UUID = '6b340806-51e1-411c-a356-2433e0781fb6';
const B_UUID = '9c8a1f3e-2d4b-4e6f-8a7b-0c1d2e3f4a5b';
const A_PAYLOADS = ['synthetic.variant.one', 'synthetic.variant.two'] as const;

/** Everything observable about a database that an installer could change. */
const snapshot = (db: Sqlite): string => JSON.stringify({ objects: schemaObjects(db), counts: tableCounts(db), receipts: migrationRows(db) });
const names = (db: Sqlite, prefix: string) => (schemaObjects(db) as { name: string }[]).map(row => row.name).filter(name => name.startsWith(prefix));

/** Populates one table with typed placeholders, with constraint enforcement lifted only for this single statement. */
function populate(db: Sqlite, table: string): void {
  const columns = (db.prepare(`PRAGMA table_xinfo("${table}")`).all() as { name: string; type: string; hidden: number }[]).filter(column => column.hidden === 0);
  const values = columns.map(column => /INT|REAL|NUM/i.test(column.type) ? 1 : /BLOB/i.test(column.type) ? Buffer.from('x') : 'x');
  // Inside a transaction foreign key enforcement cannot be switched, so the check is deferred and never reached.
  const inside = db.inTransaction;
  if (inside) db.pragma('defer_foreign_keys = ON'); else db.pragma('foreign_keys = OFF');
  db.pragma('ignore_check_constraints = ON');
  try { db.prepare(`INSERT INTO "${table}"(${columns.map(column => `"${column.name}"`).join(',')}) VALUES(${columns.map(() => '?').join(',')})`).run(...values); }
  finally { db.pragma('ignore_check_constraints = OFF'); if (!inside) db.pragma('foreign_keys = ON'); }
}
/**
 * Plants one placeholder row. Some Source24 through Source27 tables guard inserts with their own triggers; for those the
 * guard is lifted only on a throwaway copy while the row is planted and restored byte-for-byte afterwards, so the schema
 * still equals the genuine predecessor and only the emptiness predicate can notice the row.
 */
function plant(db: Sqlite, table: string): boolean {
  try { populate(db, table); return false; } catch { /* a guard refused the placeholder row */ }
  const guards = db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name=? AND sql IS NOT NULL").all(table) as { name: string; sql: string }[];
  assert.ok(guards.length > 0, `${table} refused a placeholder row without a trigger guard`);
  for (const guard of guards) db.exec(`DROP TRIGGER "${guard.name}"`);
  try { populate(db, table); } finally { for (const guard of guards) db.exec(guard.sql); }
  return true;
}
const cause = (error: unknown): unknown => error instanceof Error ? error.cause : undefined;
/** The real storage constructor already writes migration backups; only the delta around an upgrade attempt is meaningful. */
const backupsOf = (directory: string): string[] => existsSync(join(directory, 'backups')) ? readdirSync(join(directory, 'backups')).filter(name => name.endsWith('.sqlite')).sort() : [];
const emptyRequired = /qualified_purchase_empty_source27_required/;

// ---------------------------------------------------------------------------------------------------------------------
// Additive successor schema and its immutable, retained, bounded constraints
// ---------------------------------------------------------------------------------------------------------------------

test('fresh installation keeps genuine history 1..27, adds exactly the inbox and qualified objects and writes no migration row', async t => {
  const f = await qualified(t), genuine = await emptySource27(t);
  assert.equal(f.storage.ownership, 'owned');
  const receipts = migrationRows(f.db);
  assert.deepEqual(receipts.map(row => row.version), Array.from({ length: 27 }, (_, index) => index + 1));
  assert.deepEqual(receipts, migrationRows(genuine.db), 'receipt versions and checksums are exactly the genuine Source27 history');
  assert.equal(selectSourceSubscriptionStatusMigrations().length, 27);
  assert.equal(count(f.db, 'form_migrations'), 27);

  const added = names(f.db, 'qualified_apple_');
  assert.deepEqual([...added].sort(), qualifiedPurchaseDescriptors.map(item => item.name).sort());
  assert.equal(qualifiedPurchaseDescriptors.filter(item => item.type === 'table').length, 17);
  assert.equal(qualifiedPurchaseDescriptors.filter(item => item.name.startsWith('qualified_apple_fence_')).length, 33);
  assert.equal(f.storage.schemaDigest, allSchemaDigest(f.db));
  assert.equal(f.db.pragma('integrity_check', { simple: true }), 'ok');
  assert.deepEqual(f.db.pragma('foreign_key_check'), []);
  assertQualifiedPurchaseSchema(f.db);

  // Every business table except the catalog stays empty; only the singleton rows and namespaces are written.
  const counts = tableCounts(f.db);
  for (const [table, rows] of Object.entries(counts)) {
    if (table === 'form_migrations' || table === 'exercises') continue;
    const expected = table === 'qualified_apple_store' || table === 'notification_inbox_store' ? 1 : table === 'qualified_apple_namespaces' ? ALL_NAMESPACES.length : 0;
    assert.equal(rows, expected, table);
  }
  const record = f.db.prepare('SELECT * FROM qualified_apple_store').get() as { predecessor_digest: string; extension_digest: string; store_id: string; generation: string };
  const reference = genuineSchemaReference();
  assert.equal(record.predecessor_digest, reference.predecessorDigest);
  assert.equal(record.extension_digest, reference.extensionDigest);
  assert.equal(record.store_id, STORE_ID);
  assert.equal(record.generation, STORE_GENERATION);
});

test('the inbox schema and singleton row are installed byte-identically beside Source27, not through the fresh-only initializer', async t => {
  const f = await qualified(t);
  const reference = new Database(':memory:');
  try {
    initializeSyntheticNotificationInbox(reference, { use: 'isolated-synthetic', storeId: STORE_ID, generation: STORE_GENERATION, ingress: 'fixture', policy: inboxPolicy });
    const pick = (db: Sqlite) => (db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name LIKE 'notification_inbox%' ORDER BY type,name").all());
    assert.deepEqual(pick(f.db), pick(reference));
    assert.ok(pick(f.db).length > 10);
    assert.deepEqual(f.db.prepare('SELECT * FROM notification_inbox_store').all(), reference.prepare('SELECT * FROM notification_inbox_store').all());
  } finally { reference.close(); }
  assert.ok(notificationInboxSql.length > 0);
  // The installer wrote it with plain statements: the fresh-only initializer refuses a non-empty database.
  assert.throws(() => initializeSyntheticNotificationInbox(f.db, { use: 'isolated-synthetic', storeId: 'other', generation: 'other', ingress: 'fixture', policy: inboxPolicy }), /isolated_fresh_inbox_required/);
});

test('successor SQL adds unregistered DDL with only the qualified acceptance and page progression effects', () => {
  const statements = qualifiedPurchaseSql.split(/;\n/).map(statement => statement.trim().replace(/;$/, '')).filter(Boolean);
  assert.equal(statements.length, qualifiedPurchaseDescriptors.length);
  for (const statement of statements) assert.match(statement, /^CREATE (TABLE|UNIQUE INDEX|INDEX|TRIGGER) qualified_apple_/);
  // Trigger events are named (BEFORE INSERT ON ...), so only data statements and foreign key actions are forbidden.
  const pageAdvances = qualifiedPurchaseDescriptors.filter(item => item.name.endsWith('_pages_advance_parent'));
  assert.deepEqual(pageAdvances.map(item => item.table).sort(),
    ['qualified_apple_notification_history_pages', 'qualified_apple_reconciliation_pages']);
  for (const { sql } of pageAdvances) {
    assert.match(sql, /AFTER INSERT ON qualified_apple_\w+_pages BEGIN\s+UPDATE qualified_apple_\w+ SET expected_page=NEW.request_page\+1,\w+=NEW.\w+,outcome_json=NEW.outcome_json\s+WHERE namespace_key=NEW.namespace_key AND handle=NEW.handle; END$/);
  }
  const record = qualifiedPurchaseDescriptors.find(item => item.name === 'qualified_apple_notification_commits_record')!;
  assert.equal(record.table, 'notification_inbox_operations');
  assert.match(record.sql, /AFTER INSERT ON notification_inbox_operations[\s\S]+INSERT INTO qualified_apple_notification_commits\(namespace_key,notification_uuid,operation_id\)/);
  const otherDdl = qualifiedPurchaseDescriptors.filter(item => !pageAdvances.includes(item) && item !== record).map(item => item.sql).join(';');
  assert.doesNotMatch(otherDdl, /\bALTER\b|\bDROP\b|\bON (DELETE|UPDATE)\b|\bINSERT INTO\b|\bREPLACE\b|\bDELETE FROM\b|\bUPDATE\s+\w+\s+SET\b|form_migrations|\bPRAGMA\b|\bVACUUM\b/i);
  // Original predecessor objects are only ever the subject of refusal triggers, never created or altered.
  for (const item of qualifiedPurchaseDescriptors.filter(entry => (predecessorPurchaseTables as readonly string[]).includes(entry.table))) {
    assert.equal(item.type, 'trigger');
    assert.match(item.sql, /BEFORE (INSERT|UPDATE|DELETE) ON apple_purchase_[a-z_]+ BEGIN SELECT RAISE\(ABORT,'qualified_apple_predecessor_fenced'\); END$/);
  }
  assert.ok(readFileSync(join(sourceRoot, 'storage.ts'), 'utf8').includes(formMigrationsDefinition), 'receipt table definition must match the genuine storage constructor');
});

test('predecessor purchase tables are fenced for insert in the real installation and for every event in the fence SQL itself', async t => {
  assert.equal(predecessorPurchaseTables.length, 11);
  const f = await qualified(t);
  for (const table of predecessorPurchaseTables) {
    assert.equal(count(f.db, table), 0, table);
    assert.throws(() => populate(f.db, table), /qualified_apple_predecessor_fenced/, table);
    assert.equal(count(f.db, table), 0, table);
  }
  const fences = qualifiedPurchaseDescriptors.filter(item => item.name.startsWith('qualified_apple_fence_'));
  assert.deepEqual(fences.map(item => item.table).filter((table, index, all) => all.indexOf(table) === index).sort(), [...predecessorPurchaseTables].sort());
  for (const event of ['insert', 'update', 'delete']) assert.equal(fences.filter(item => item.name.endsWith(`_${event}`)).length, 11);
  // Isolated from every older trigger: with rows present, update and delete are refused by the fence alone.
  const memory = new Database(':memory:');
  try {
    for (const table of predecessorPurchaseTables) { memory.exec(`CREATE TABLE ${table}(x)`); memory.exec(`INSERT INTO ${table} VALUES(1)`); }
    for (const item of fences) memory.exec(item.sql);
    for (const table of predecessorPurchaseTables) {
      refused(() => memory.exec(`INSERT INTO ${table} VALUES(2)`), /qualified_apple_predecessor_fenced/);
      refused(() => memory.exec(`UPDATE ${table} SET x=3`), /qualified_apple_predecessor_fenced/);
      refused(() => memory.exec(`DELETE FROM ${table}`), /qualified_apple_predecessor_fenced/);
      assert.equal(count(memory, table), 1);
    }
  } finally { memory.close(); }
});

test('the same identifiers coexist across two environments and two bundles; owner, transaction and cross-namespace links never fork or leak', async t => {
  const f = await qualified(t);
  seedAccount(f.db, ACCOUNT_A); seedAccount(f.db, ACCOUNT_B);
  const inbox = f.inbox();
  const observationId = sha('repeat-status-id'), eventKey = sha('repeat-status-event');
  for (const [index, namespace] of ALL_NAMESPACES.entries()) {
    const account = index === 3 ? ACCOUNT_B : ACCOUNT_A;
    seedOwner(f.db, namespace, '1000', account);
    const tx = seedTransaction(f.db, namespace, { transactionId: '2000', original: '1000', account });
    seedProofObservation(f.db, namespace, tx);
    seedCommand(f.db, namespace, tx, { key: 'repeat-command', actor: account });
    seedReconciliation(f.db, namespace, { handle: 'repeat-handle', original: '1000', actor: account });
    seedStatusObservation(f.db, namespace, { original: '1000', account, observationId, eventKey, proof: tx });
    const accepted = await inbox.accept(A_PAYLOADS[0], namespace, A_UUID);
    const request = { operationId: randomUUID(), claim: inbox.claim(accepted.receiptId), applicationInput: 'repeat-input' };
    assert.equal(inbox.committer().commit(request, db => seedNotification(db, namespace, { uuid: A_UUID, aggregateId: accepted.aggregateId,
      receiptId: accepted.receiptId, original: '1000', account, request, payloadDigest: notificationPayloadDigest(accepted.capture.signedPayload) }), () => true).status, 'ok');
    assert.equal(f.reader.reconciliation(f.context(account, namespace), 'repeat-handle')?.originalTransactionId, '1000');
  }
  const exactNamespaceKeys = ALL_NAMESPACES.map(nsKey).sort();
  const repeated = (table: string, column: string, value: string) => assert.deepEqual(
    f.db.prepare(`SELECT namespace_key FROM qualified_apple_${table} WHERE ${column}=? ORDER BY namespace_key`).pluck().all(value), exactNamespaceKeys);
  repeated('owners', 'original_transaction_id', '1000');
  repeated('transactions', 'transaction_id', '2000');
  repeated('observations', 'proof_hash', sha('synthetic.2000.signature'));
  repeated('commands', 'idempotency_key', 'repeat-command');
  repeated('reconciliations', 'handle', 'repeat-handle');
  repeated('status_observations', 'observation_id', observationId);
  repeated('notifications', 'notification_uuid', A_UUID);
  assert.equal(nsKey(SBX_A), '{"provider":"Apple","bundleId":"com.example.form","environment":"Sandbox"}');
  assert.equal(new Set(ALL_NAMESPACES.map(nsKey)).size, 4);
  assert.equal(nsKey(PRD_A), qualifiedNamespaceKey({ ...PRD_A, appAppleId: 111 }), 'appAppleId is a configuration binding and never part of N');

  // Same-N reassignment is a primary key collision and an update or delete is refused.
  refused(() => seedOwner(f.db, SBX_A, '1000', ACCOUNT_B), /qualified_apple_owners_replacement/);
  refused(() => f.db.prepare('UPDATE qualified_apple_owners SET account_id=?,app_account_token=? WHERE namespace_key=?').run(ACCOUNT_B.accountId, ACCOUNT_B.accountId, nsKey(SBX_A)), /qualified_apple_owners_immutable/);
  refused(() => f.db.prepare('DELETE FROM qualified_apple_owners WHERE namespace_key=?').run(nsKey(SBX_A)), /qualified_apple_owners_retained/);
  // A token must equal the owning account: no account is inferred from a similar token.
  refused(() => f.db.prepare('INSERT INTO qualified_apple_owners VALUES(?,?,?,?,?)').run(nsKey(SBX_A), '3000', ACCOUNT_A.accountId, ACCOUNT_B.accountId, 1), /CHECK constraint failed/);

  // A transaction cannot borrow an owner from another namespace: the owner foreign key includes N.
  seedOwner(f.db, SBX_B, '4000', ACCOUNT_A);
  refused(() => seedTransaction(f.db, PRD_B, { transactionId: '5000', original: '4000', account: ACCOUNT_A }), /FOREIGN KEY constraint failed/);
  refused(() => seedTransaction(f.db, SBX_B, { transactionId: '5001', original: '4000', account: ACCOUNT_B }), /FOREIGN KEY constraint failed/);
  assert.equal(count(f.db, 'qualified_apple_transactions'), 4);
  // Unknown namespace keys never insert.
  refused(() => f.db.prepare('INSERT INTO qualified_apple_owners VALUES(?,?,?,?,?)').run('{"provider":"Apple","bundleId":"x.y.z","environment":"Sandbox"}', '3000', ACCOUNT_A.accountId, ACCOUNT_A.accountId, 1), /FOREIGN KEY constraint failed/);
});

test('every retained relation refuses SQLite replacement with recursive triggers off or on', async t => {
  const f = await qualified(t);
  const db = f.db, key = nsKey(SBX_A);
  seedAccount(db, ACCOUNT_A); seedOwner(db, SBX_A, '1000', ACCOUNT_A);
  const tx = seedTransaction(db, SBX_A, { transactionId: '2000', original: '1000', account: ACCOUNT_A });
  seedProofObservation(db, SBX_A, tx);
  seedCommand(db, SBX_A, tx, { key: 'command', actor: ACCOUNT_A });
  seedDelivery(db, SBX_A, tx, { serverDeliveryId: 'delivery', actor: ACCOUNT_A });
  db.prepare("INSERT INTO qualified_apple_grants VALUES(?, '2000', ?, 'grant', 'form_plus', 1000)").run(key, ACCOUNT_A.accountId);
  seedReconciliation(db, SBX_A, { handle: 'reconciliation', original: '1000', actor: ACCOUNT_A });
  db.prepare(`INSERT INTO qualified_apple_reconciliation_pages VALUES(?, 'reconciliation', 0, '{"providerRevision":null}', '{"items":[]}', 0, ?, NULL, '{}')`)
    .run(key, sha('reconciliation'));
  db.prepare("INSERT INTO qualified_apple_notification_history VALUES(?, 'history', '{}', '{}', 'policy1', ?, 0, NULL, '{}')").run(key, STORE_GENERATION);
  db.prepare(`INSERT INTO qualified_apple_notification_history_pages VALUES(?, 'history', 0, NULL, '{}', '{"items":[]}', 0, ?, NULL, '{}')`)
    .run(key, sha('history'));
  const inbox = f.inbox(), accepted = await inbox.accept(A_PAYLOADS[0], SBX_A, A_UUID);
  const request = { operationId: randomUUID(), claim: inbox.claim(accepted.receiptId), applicationInput: 'exact-effect' };
  assert.equal(inbox.committer().commit(request, db => seedNotification(db, SBX_A, { uuid: A_UUID, aggregateId: accepted.aggregateId,
    receiptId: accepted.receiptId, original: '1000', account: ACCOUNT_A, request,
    payloadDigest: notificationPayloadDigest(accepted.capture.signedPayload) }), () => true).status, 'ok');
  const { revision } = seedProjection(db, SBX_A, { original: '1000', account: ACCOUNT_A, provenance: 'notification_evidence', accepted });
  seedDependency(db, SBX_A, { original: '1000', revision, aggregateId: accepted.aggregateId, version: 1 });

  const tables = qualifiedPurchaseDescriptors.filter(item => item.type === 'table').map(item => item.name);
  for (const recursive of ['OFF', 'ON']) {
    db.pragma(`recursive_triggers=${recursive}`);
    for (const table of tables) {
      const contents = db.prepare(`SELECT rowid AS retained_row, * FROM ${table} ORDER BY rowid`);
      const before = contents.all() as { retained_row: number }[];
      assert.ok(before.length, table);
      const rowid = before[0]!.retained_row;
      for (const verb of ['REPLACE', 'INSERT OR REPLACE']) {
        refused(() => db.prepare(`${verb} INTO ${table} SELECT * FROM ${table} WHERE rowid=?`).run(rowid), new RegExp(`${table}_replacement`));
      }
      const target = before[1]?.retained_row ?? rowid + 1000;
      refused(() => db.prepare(`UPDATE OR REPLACE ${table} SET rowid=? WHERE rowid=?`).run(target, rowid),
        new RegExp(`${table}_(immutable|rowid|advancing|bound_update)`));
      assert.deepEqual(contents.all(), before, `${table} with recursive_triggers ${recursive}`);
    }
  }
  assert.deepEqual(db.pragma('foreign_key_check'), []);
});

test('namespace rows enforce provider, verified environment and the Production appAppleId rule; configuration never forks N', async t => {
  const f = await qualified(t);
  const insert = f.db.prepare('INSERT INTO qualified_apple_namespaces VALUES(?,?,?,?,?)');
  const key = (bundle: string, environment: string) => JSON.stringify({ provider: 'Apple', bundleId: bundle, environment });
  refused(() => insert.run(key('com.example.new', 'Production'), 'Apple', 'com.example.new', 'Production', null), /CHECK constraint failed/);
  refused(() => insert.run(key('com.example.new', 'Production'), 'Apple', 'com.example.new', 'Production', 0), /CHECK constraint failed/);
  refused(() => insert.run(key('com.example.new', 'Sandbox'), 'Apple', 'com.example.new', 'Sandbox', 5), /CHECK constraint failed/);
  refused(() => insert.run(key('com.example.new', 'Xcode'), 'Apple', 'com.example.new', 'Xcode', null), /CHECK constraint failed/);
  refused(() => insert.run(key('com.example.new', 'Sandbox'), 'Google', 'com.example.new', 'Sandbox', null), /CHECK constraint failed/);
  refused(() => insert.run('{"provider":"Apple","bundleId":"other","environment":"Sandbox"}', 'Apple', 'com.example.new', 'Sandbox', null), /CHECK constraint failed/);
  // The same bundle and environment cannot be inserted with a second appAppleId.
  refused(() => insert.run(nsKey(PRD_A), 'Apple', PRD_A.bundleId, 'Production', 424242), /qualified_apple_namespaces_replacement/);
  refused(() => f.db.prepare('UPDATE qualified_apple_namespaces SET app_apple_id=? WHERE namespace_key=?').run(424242, nsKey(PRD_A)), /qualified_apple_namespaces_immutable/);
  refused(() => f.db.prepare('DELETE FROM qualified_apple_namespaces').run(), /qualified_apple_namespaces_retained/);
  assert.equal(count(f.db, 'qualified_apple_namespaces'), 4);

  const forked = configurationFor([PRD_A, { ...PRD_A, appAppleId: 424242 }]);
  assert.throws(() => validateQualifiedPurchaseConfiguration(forked), /qualified_purchase_configuration_rejected/);
  refused(() => f.db.prepare('UPDATE qualified_apple_store SET configuration_json=?').run('{}'), /qualified_apple_store_immutable/);
  refused(() => f.db.prepare('UPDATE qualified_apple_store SET policy_json=?').run('{}'), /qualified_apple_store_immutable/);
  refused(() => f.db.prepare('UPDATE qualified_apple_store SET generation=?').run('other'), /qualified_apple_store_immutable/);
  refused(() => f.db.prepare('DELETE FROM qualified_apple_store').run(), /qualified_apple_store_retained/);
});

test('configuration and policy are explicit, strict, closed and copied; nothing defaults', () => {
  const good = configurationFor();
  const config = validateQualifiedPurchaseConfiguration(good);
  assert.equal(config.namespaces.length, 4);
  assert.ok(Object.isFrozen(config) && Object.isFrozen(config.namespaces[0]) && Object.isFrozen(config.namespaces[0]!.namespace));
  (good.namespaces[0]!.namespace as { bundleId: string }).bundleId = 'mutated.after.validation';
  assert.equal(config.namespaces[0]!.namespace.bundleId, 'com.example.form', 'validated copy is independent of caller mutation');

  const bad: [string, (value: ReturnType<typeof configurationFor>) => unknown][] = [
    ['unknown top key', value => ({ ...value, extra: true })],
    ['wrong mode', value => ({ ...value, mode: 'runtime' })],
    ['wrong cohort', value => ({ ...value, cohort: 'other' })],
    ['wrong use', value => ({ ...value, use: 'live' })],
    ['revision syntax', value => ({ ...value, revision: 'has space' })],
    ['no namespaces', value => ({ ...value, namespaces: [] })],
    ['too many namespaces', value => ({ ...value, namespaces: Array.from({ length: 17 }, (_, index) => ({ ...value.namespaces[0]!, namespace: { ...SBX_A, bundleId: `com.example.n${index}` } })) })],
    ['unknown namespace key', value => ({ ...value, namespaces: [{ ...value.namespaces[0]!, extra: 1 }] })],
    ['unknown N key', value => ({ ...value, namespaces: [{ ...value.namespaces[0]!, namespace: { ...SBX_A, region: 'x' } }] })],
    ['single label bundle', value => ({ ...value, namespaces: [{ ...value.namespaces[0]!, namespace: { ...SBX_A, bundleId: 'form' } }] })],
    ['Xcode environment', value => ({ ...value, namespaces: [{ ...value.namespaces[0]!, namespace: { ...SBX_A, environment: 'Xcode' } }] })],
    ['Production without appAppleId', value => ({ ...value, namespaces: [{ ...value.namespaces[0]!, namespace: { ...PRD_A, appAppleId: null }, statusAppAppleId: null }] })],
    ['Production with mismatched status id', value => ({ ...value, namespaces: [{ ...value.namespaces[0]!, namespace: PRD_A, statusAppAppleId: 5 }] })],
    ['Sandbox with appAppleId', value => ({ ...value, namespaces: [{ ...value.namespaces[0]!, namespace: { ...SBX_A, appAppleId: 5 } }] })],
    ['no products', value => ({ ...value, namespaces: [{ ...value.namespaces[0]!, products: [] }] })],
    ['duplicate N', value => ({ ...value, namespaces: [value.namespaces[0]!, value.namespaces[0]!] })],
    ['prototype pollution shape', () => Object.create({ mode: 'source-only' })],
  ];
  for (const [label, mutate] of bad) assert.throws(() => validateQualifiedPurchaseConfiguration(mutate(configurationFor())), /qualified_purchase_configuration_rejected/, label);

  assert.equal(validateQualifiedPurchasePolicy(policy).revision, 'policy1');
  const badPolicy: [string, unknown][] = [
    ['missing', undefined], ['extra key', { ...policy, extra: 1 }], ['zero page', { ...policy, maxPageSize: 0 }], ['fractional', { ...policy, maxMetadataRows: 1.5 }],
    ['string number', { ...policy, maxNamespaces: '8' }], ['page over bound', { ...policy, maxPageSize: 101 }], ['history over bound', { ...policy, maxHistoryItems: 21 }],
    ['evidence over bound', { ...policy, maxEvidenceBytes: 16385 }], ['namespaces over bound', { ...policy, maxNamespaces: 17 }], ['bad revision', { ...policy, revision: '' }],
    ['identity below evidence', { ...policy, retention: { evidenceMs: 100, identityMs: 50, auditMs: 200 } }],
    ['audit below identity', { ...policy, retention: { evidenceMs: 10, identityMs: 100, auditMs: 50 } }],
    ['retention key', { ...policy, retention: { evidenceMs: 1, identityMs: 2, auditMs: 3, extra: 4 } }],
  ];
  for (const [label, value] of badPolicy) assert.throws(() => validateQualifiedPurchasePolicy(value), /qualified_purchase_configuration_rejected/, label);
});

test('explicit input is rejected before any file or handle exists; no default configuration, policy or currentness is supplied', async t => {
  const s = scratch(t);
  const probe = currentnessProbe();
  const invalid: [string, Record<string, unknown>][] = [
    ['configuration', { configuration: undefined }], ['policy', { policy: undefined }], ['bad store id', { storeId: 'has space' }], ['bad generation', { generation: '' }],
    ['non-synthetic use', { use: 'live' }], ['no currentness', { currentness: undefined }], ['async currentness id', { currentness: { generation: '', check: probe.currentness.check } }],
    ['namespaces over policy', { policy: { ...policy, maxNamespaces: 2 } }], ['bad inbox', { inbox: { ingress: 'x', policy: { ...inboxPolicy, maxPageSize: 0 } } }],
    ['no inbox', { inbox: undefined }],
  ];
  for (const [label, override] of invalid) {
    const path = s.path(`${label.replace(/\W/g, '-')}.sqlite`);
    await assert.rejects(openSyntheticQualifiedPurchaseStorage(path, storeInput({ currentness: probe.currentness, ...override })), /qualified_purchase_(input_rejected|configuration_rejected)|inbox_policy_required/i, label);
    assert.equal(existsSync(path), false, label);
  }
  assert.equal(probe.phases.length, 0);
  await assert.rejects(openSyntheticQualifiedPurchaseStorage('relative.sqlite', storeInput()), /qualified_purchase_path_required/);
  await assert.rejects(openSyntheticQualifiedPurchaseStorage(':memory:', storeInput()), /qualified_purchase_path_required/);
  assert.equal(existsSync('relative.sqlite'), false);
});

test('immutable, sticky and retained constraints on the identity, proof, grant, command and delivery relations', async t => {
  const f = await qualified(t);
  seedAccount(f.db, ACCOUNT_A);
  seedOwner(f.db, SBX_A, '1000', ACCOUNT_A);
  const tx = seedTransaction(f.db, SBX_A, { transactionId: '2000', original: '1000', account: ACCOUNT_A });
  seedProofObservation(f.db, SBX_A, tx);
  const key = nsKey(SBX_A);
  const update = (sql: string, ...params: unknown[]) => () => f.db.prepare(sql).run(...params);
  // Identity columns never change; money-relevant facts only move forward.
  refused(update('UPDATE qualified_apple_transactions SET product_id=? WHERE namespace_key=?', 'form.plus.lifetime', key), /qualified_apple_transactions_identity/);
  refused(update('UPDATE qualified_apple_transactions SET account_id=? WHERE namespace_key=?', ACCOUNT_A.accountId, key), /qualified_apple_transactions_identity/);
  refused(update('UPDATE qualified_apple_transactions SET purchase_date_ms=? WHERE namespace_key=?', 600, key), /qualified_apple_transactions_identity/);
  refused(update('UPDATE qualified_apple_transactions SET signed_date_ms=? WHERE namespace_key=?', 800, key), /qualified_apple_transactions_sticky/);
  f.db.prepare('UPDATE qualified_apple_transactions SET revocation_date_ms=?,is_upgraded=1,signed_date_ms=?,updated_at_ms=? WHERE namespace_key=?').run(950, 1000, 1100, key);
  refused(update('UPDATE qualified_apple_transactions SET revocation_date_ms=NULL WHERE namespace_key=?', key), /qualified_apple_transactions_sticky/);
  refused(update('UPDATE qualified_apple_transactions SET is_upgraded=0 WHERE namespace_key=?', key), /qualified_apple_transactions_sticky/);
  refused(update('DELETE FROM qualified_apple_transactions WHERE namespace_key=?', key), /qualified_apple_transactions_retained/);
  refused(update('UPDATE qualified_apple_observations SET claims=? WHERE namespace_key=?', '{}', key), /qualified_apple_observations_immutable/);
  refused(update('DELETE FROM qualified_apple_observations WHERE namespace_key=?', key), /qualified_apple_observations_retained/);
  refused(update('UPDATE qualified_apple_transactions SET exact_jws=? WHERE namespace_key=?', 'j'.repeat(policy.maxEvidenceBytes + 1), key),
    /qualified_apple_transactions_policy_exact_jws_update/);
  // Evidence bytes are bounded by the stored policy.
  refused(() => seedTransaction(f.db, SBX_A, { transactionId: '2001', original: '1000', account: ACCOUNT_A, jws: 'j'.repeat(policy.maxEvidenceBytes + 1) }), /qualified_apple_transactions_policy_exact_jws/);
  refused(() => f.db.prepare('INSERT INTO qualified_apple_observations VALUES(?,?,?,?,?,?)').run(key, '2000', sha('other'), '{}', 'j'.repeat(policy.maxEvidenceBytes + 1), 1), /qualified_apple_observations_policy_exact_jws/);

  seedCommand(f.db, SBX_A, tx, { key: 'command-one', actor: ACCOUNT_A });
  refused(update('UPDATE qualified_apple_commands SET product_id=?', 'form.plus.lifetime'), /qualified_apple_commands_immutable/);
  refused(update('DELETE FROM qualified_apple_commands'), /qualified_apple_commands_retained/);
  // A command must reference an observed proof of its own transaction.
  refused(() => seedCommand(f.db, SBX_A, { ...tx, proofHash: sha('unobserved') }, { key: 'command-two', actor: ACCOUNT_A }), /FOREIGN KEY constraint failed/);
  refused(() => seedCommand(f.db, SBX_A, { ...tx, productId: 'form.plus.lifetime' }, { key: 'command-three', actor: ACCOUNT_A }), /FOREIGN KEY constraint failed/);

  const alternate = { ...tx, jws: 'alternate.synthetic.proof', proofHash: sha('alternate.synthetic.proof') };
  seedProofObservation(f.db, SBX_A, alternate);
  refused(() => seedDelivery(f.db, SBX_A, { ...tx, jws: 'wrong-proof-bytes' }, { serverDeliveryId: 'wrong-proof', actor: ACCOUNT_A }),
    /qualified_apple_deliveries_proof/);
  refused(() => seedDelivery(f.db, SBX_A, { ...tx, proofHash: sha('unobserved') }, { serverDeliveryId: 'no-proof', actor: ACCOUNT_A }),
    /qualified_apple_deliveries_proof/);
  seedDelivery(f.db, SBX_A, tx, { serverDeliveryId: 'delivery-one', actor: ACCOUNT_A });
  assert.deepEqual(f.db.prepare('SELECT transaction_id,account_id,proof_hash,exact_jws FROM qualified_apple_deliveries').get(),
    { transaction_id: tx.transactionId, account_id: ACCOUNT_A.accountId, proof_hash: tx.proofHash, exact_jws: tx.jws });
  refused(update('UPDATE qualified_apple_deliveries SET server_delivery_id=?', 'delivery-two'), /qualified_apple_deliveries_immutable/);
  refused(update('DELETE FROM qualified_apple_deliveries'), /qualified_apple_deliveries_retained/);
  refused(() => seedDelivery(f.db, SBX_A, tx, { serverDeliveryId: 'delivery-one', actor: ACCOUNT_A }), /qualified_apple_deliveries_replacement/);
  refused(() => seedDelivery(f.db, SBX_A, { ...tx, proofHash: alternate.proofHash, jws: alternate.jws }, { serverDeliveryId: 'x'.repeat(129), actor: ACCOUNT_A }), /CHECK constraint failed/);
  refused(() => seedDelivery(f.db, SBX_A, { ...tx, proofHash: sha('third'), jws: 'j'.repeat(policy.maxEvidenceBytes + 1) }, { serverDeliveryId: 'delivery-three', actor: ACCOUNT_A }), /qualified_apple_deliveries_policy_exact_jws/);
  f.db.prepare('INSERT INTO qualified_apple_grants VALUES(?,?,?,?,?,?)').run(key, '2000', ACCOUNT_A.accountId, 'grant-one', 'form_plus', 1000);
  refused(update('UPDATE qualified_apple_grants SET entitlement=?', 'form_plus'), /qualified_apple_grants_immutable/);
  refused(update('DELETE FROM qualified_apple_grants'), /qualified_apple_grants_retained/);
  refused(() => f.db.prepare('INSERT INTO qualified_apple_grants VALUES(?,?,?,?,?,?)').run(key, '2000', ACCOUNT_A.accountId, 'grant-two', 'form_plus', 1000), /qualified_apple_grants_replacement/);
});

test('delivery identifiers are separate from every inbox receipt, work, aggregate and operation identifier', async t => {
  const f = await qualified(t);
  seedAccount(f.db, ACCOUNT_A); seedOwner(f.db, SBX_A, '1000', ACCOUNT_A);
  const tx = seedTransaction(f.db, SBX_A, { transactionId: '2000', original: '1000', account: ACCOUNT_A });
  const a = f.inbox(), accepted = await a.accept(A_PAYLOADS[0], SBX_A, A_UUID);
  const claim = a.claim(accepted.receiptId);
  const state = f.db.prepare('SELECT work_id FROM notification_inbox_state WHERE receipt_id=?').get(accepted.receiptId) as { work_id: string };
  const operation = (f.db.prepare('SELECT operation_id FROM notification_inbox_operations LIMIT 1').get() as { operation_id: string }).operation_id;
  const identifiers = [accepted.receiptId, accepted.aggregateId, state.work_id, operation, claim.processingAttemptId];
  assert.equal(new Set(identifiers).size, identifiers.length);
  seedProofObservation(f.db, SBX_A, tx);
  for (const id of identifiers) {
    refused(() => seedDelivery(f.db, SBX_A, tx, { serverDeliveryId: id, actor: ACCOUNT_A }), /qualified_apple_deliveries_identity_separate/);
  }
  seedDelivery(f.db, SBX_A, tx, { serverDeliveryId: 'server-delivery-distinct', actor: ACCOUNT_A });
  assert.equal(count(f.db, 'qualified_apple_deliveries'), 1);
});

test('reconciliation and notification-history pages commit with exactly one checkpoint advance or roll back together', async t => {
  const f = await qualified(t);
  seedAccount(f.db, ACCOUNT_A); seedOwner(f.db, SBX_A, '1000', ACCOUNT_A);
  seedReconciliation(f.db, SBX_A, { handle: 'handle-one', original: '1000', actor: ACCOUNT_A });
  const key = nsKey(SBX_A);
  const observer = f.track(new Database(f.path, { readonly: true }));
  const abort = (write: () => unknown) => f.db.transaction(() => { write(); throw new Error('synthetic rollback'); })();
  const items = (n: number) => JSON.stringify({ items: Array<number>(n).fill(1) });
  const page = (number: number, token: string | null, next: string | null, declared = 1, body = items(declared)) =>
    () => f.db.prepare('INSERT INTO qualified_apple_reconciliation_pages VALUES(?,?,?,?,?,?,?,?,?)')
      .run(key, 'handle-one', number, JSON.stringify({ providerRevision: token }), body, declared, sha(body), next, '{"status":"page_ready"}');
  const progress = () => observer.prepare('SELECT expected_page,provider_revision,outcome_json FROM qualified_apple_reconciliations').get();
  const pending = progress();
  const advance = (to: number) => () => f.db.prepare('UPDATE qualified_apple_reconciliations SET expected_page=? WHERE handle=?').run(to, 'handle-one');
  refused(page(1, null, null), /qualified_apple_reconciliation_pages_order/);
  refused(advance(1), /qualified_apple_reconciliations_advance/);
  refused(() => abort(page(0, null, 'private-next')), /synthetic rollback/);
  assert.deepEqual(progress(), pending);
  assert.equal(count(observer, 'qualified_apple_reconciliation_pages'), 0);
  page(0, null, 'private-next')();
  assert.deepEqual(progress(), { expected_page: 1, provider_revision: 'private-next', outcome_json: '{"status":"page_ready"}' });
  assert.equal(count(observer, 'qualified_apple_reconciliation_pages'), 1);
  refused(page(0, null, 'private-next'), /qualified_apple_reconciliation_pages_(order|replacement)/);
  refused(advance(2), /qualified_apple_reconciliations_advance/);
  refused(advance(0), /qualified_apple_reconciliations_advance/);
  refused(() => f.db.exec("UPDATE qualified_apple_reconciliations SET provider_revision='different'"), /qualified_apple_reconciliations_advance/);
  refused(page(1, 'wrong-token', null), /qualified_apple_reconciliation_pages_order/);
  refused(page(1, 'private-next', null, policy.maxPageSize + 1), /qualified_apple_reconciliation_pages_policy_item_count/);
  refused(page(1, 'private-next', null, 1, items(policy.maxPageSize + 1)), /qualified_apple_reconciliation_pages_policy_item_count/);
  refused(page(1, 'private-next', null, 1, '{"items":[1],"items":[1,2,3,4,5,6]}'), /qualified_apple_reconciliation_pages_policy_item_count/);
  refused(page(1, 'private-next', null, 1, JSON.stringify({ pad: 'x'.repeat(policy.maxEvidenceBytes) })), /qualified_apple_reconciliation_pages_policy_body_json/);
  page(1, 'private-next', null)();
  assert.deepEqual(progress(), { expected_page: 2, provider_revision: null, outcome_json: '{"status":"page_ready"}' });
  refused(page(2, null, null), /qualified_apple_reconciliation_pages_order/);
  refused(() => f.db.prepare('UPDATE qualified_apple_reconciliation_pages SET body_json=?').run('{}'), /qualified_apple_reconciliation_pages_immutable/);
  refused(() => f.db.prepare('DELETE FROM qualified_apple_reconciliation_pages').run(), /qualified_apple_reconciliation_pages_retained/);
  refused(() => f.db.prepare('UPDATE qualified_apple_reconciliations SET account_id=? WHERE handle=?').run(ACCOUNT_B.accountId, 'handle-one'), /qualified_apple_reconciliations_binding/);
  refused(() => f.db.prepare('DELETE FROM qualified_apple_reconciliations').run(), /qualified_apple_reconciliations_retained/);

  f.db.prepare('INSERT INTO qualified_apple_notification_history VALUES(?,?,?,?,?,?,?,?,?)').run(key, 'history-one', '{}', '{}', 'delivery1', STORE_GENERATION, 0, null, '{}');
  const historyPage = (number: number, token: string | null, next: string | null, declared: number, body = items(declared)) =>
    () => f.db.prepare('INSERT INTO qualified_apple_notification_history_pages VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(key, 'history-one', number, token, '{}', body, declared, sha(body), next, '{"status":"pending"}');
  const historyProgress = () => observer.prepare('SELECT expected_page,current_token,outcome_json FROM qualified_apple_notification_history').get();
  const initial = historyProgress();
  refused(historyPage(0, null, 'history-next', policy.maxHistoryItems + 1), /qualified_apple_notification_history_pages_policy_item_count/);
  refused(historyPage(0, null, 'history-next', 1, items(policy.maxHistoryItems + 1)), /qualified_apple_notification_history_pages_policy_item_count/);
  refused(historyPage(0, null, 'history-next', 1, '{"items":[1],"items":[1,2,3,4,5,6]}'), /qualified_apple_notification_history_pages_policy_item_count/);
  refused(historyPage(0, null, 'history-next', 1, JSON.stringify({ pad: 'x'.repeat(policy.maxHistoryPageBytes) })), /qualified_apple_notification_history_pages_policy_page_json/);
  refused(historyPage(1, null, null, 1), /qualified_apple_notification_history_pages_order/);
  refused(() => abort(historyPage(0, null, 'history-next', 1)), /synthetic rollback/);
  assert.deepEqual(historyProgress(), initial);
  assert.equal(count(observer, 'qualified_apple_notification_history_pages'), 0);
  historyPage(0, null, 'history-next', policy.maxHistoryItems)();
  assert.equal(count(observer, 'qualified_apple_notification_history_pages'), 1);
  assert.deepEqual(historyProgress(), { expected_page: 1, current_token: 'history-next', outcome_json: '{"status":"pending"}' });
  refused(historyPage(0, null, 'history-next', 1), /qualified_apple_notification_history_pages_(order|replacement)/);
  refused(historyPage(1, 'wrong-token', null, 1), /qualified_apple_notification_history_pages_order/);
  refused(() => f.db.exec("UPDATE qualified_apple_notification_history SET current_token='other'"), /qualified_apple_notification_history_advance/);
  refused(() => f.db.prepare('UPDATE qualified_apple_notification_history SET expected_page=2').run(), /qualified_apple_notification_history_advance/);
  historyPage(1, 'history-next', null, 1)();
  assert.deepEqual(historyProgress(), { expected_page: 2, current_token: null, outcome_json: '{"status":"pending"}' });
  refused(historyPage(2, null, null, 1), /qualified_apple_notification_history_pages_order/);
  refused(() => f.db.prepare('UPDATE qualified_apple_notification_history SET store_generation=?').run('other'), /qualified_apple_notification_history_binding/);
  refused(() => f.db.prepare('DELETE FROM qualified_apple_notification_history_pages').run(), /qualified_apple_notification_history_pages_retained/);
  refused(() => f.db.prepare('DELETE FROM qualified_apple_notification_history').run(), /qualified_apple_notification_history_retained/);
});

test('status observations take one global monotonic sequence; projections advance by one revision on bound, matching evidence', async t => {
  const f = await qualified(t);
  seedAccount(f.db, ACCOUNT_A); seedAccount(f.db, ACCOUNT_B);
  seedOwner(f.db, SBX_A, '1000', ACCOUNT_A); seedOwner(f.db, PRD_A, '1000', ACCOUNT_B);
  const first = seedStatusObservation(f.db, SBX_A, { original: '1000', account: ACCOUNT_A });
  const second = seedStatusObservation(f.db, PRD_A, { original: '1000', account: ACCOUNT_B });
  assert.deepEqual([first.sequence, second.sequence], [1, 2], 'one sequence spans namespaces so cross-namespace pagination has a total order');
  const insert = (sequence: number) => () => f.db.prepare(`INSERT INTO qualified_apple_status_observations SELECT namespace_key,?,?,encoding_version,account_id,original_transaction_id,owner_binding_digest,
    event_kind,?,request_id,lifecycle_epoch,database_generation,schema_digest,continuity_digest,proof_transaction_id,proof_hash,binding_json,evidence_json,content_digest,observed_at_ms
    FROM qualified_apple_status_observations WHERE sequence=1`).run(sequence, sha(`copy${sequence}`), sha(`event${sequence}`));
  refused(insert(2), /qualified_apple_status_observations_(sequence|replacement)/);
  refused(insert(5), /qualified_apple_status_observations_sequence/);
  refused(insert(0), /qualified_apple_status_observations_sequence|CHECK constraint failed/);
  seedStatusObservation(f.db, PRD_A, { original: '1000', account: ACCOUNT_B });
  refused(() => f.db.prepare('UPDATE qualified_apple_status_observations SET observed_at_ms=1').run(), /qualified_apple_status_observations_immutable/);
  refused(() => f.db.prepare('DELETE FROM qualified_apple_status_observations').run(), /qualified_apple_status_observations_retained/);
  refused(() => seedStatusObservation(f.db, SBX_A, { original: '1000', account: ACCOUNT_B }), /FOREIGN KEY constraint failed/);
  refused(() => f.db.prepare(`INSERT INTO qualified_apple_status_observations(namespace_key,sequence,observation_id,encoding_version,account_id,original_transaction_id,owner_binding_digest,
    event_kind,event_key,request_id,lifecycle_epoch,database_generation,schema_digest,continuity_digest,binding_json,evidence_json,content_digest,observed_at_ms)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(nsKey(SBX_A), 4, sha('big'), 'qualified-status-v1', ACCOUNT_A.accountId, '1000', sha('o'), 'status', sha('k'), sha('r'), 0, STORE_GENERATION,
    allSchemaDigest(f.db), sha('c'), '{}', JSON.stringify({ pad: 'x'.repeat(policy.maxEvidenceBytes) }), sha('d'), 1), /qualified_apple_status_observations_policy_evidence_json/);

  const projected = seedProjection(f.db, SBX_A, { original: '1000', account: ACCOUNT_A, observation: first });
  assert.equal(projected.revision, 1);
  const set = (sql: string, ...params: unknown[]) => () => f.db.prepare(sql).run(...params);
  refused(set('UPDATE qualified_apple_status_projection SET revision=3 WHERE namespace_key=?', nsKey(SBX_A)), /qualified_apple_status_projection_advancing/);
  refused(set('UPDATE qualified_apple_status_projection SET revision=2,last_seen_at_ms=1 WHERE namespace_key=?', nsKey(SBX_A)), /qualified_apple_status_projection_advancing/);
  refused(set('UPDATE qualified_apple_status_projection SET revision=2,account_id=? WHERE namespace_key=?', ACCOUNT_B.accountId, nsKey(SBX_A)), /qualified_apple_status_projection_(binding|bound_update)/);
  refused(set('DELETE FROM qualified_apple_status_projection'), /qualified_apple_status_projection_retained/);
  // Current evidence must be a status observation of the same owner, epoch, store generation and schema: not another lineage's.
  refused(set('UPDATE qualified_apple_status_projection SET revision=2,current_observation_id=? WHERE namespace_key=?', second.id, nsKey(SBX_A)), /qualified_apple_status_projection_bound_update|FOREIGN KEY/);
  seedOwner(f.db, SBX_A, '1001', ACCOUNT_A);
  refused(() => seedProjection(f.db, SBX_A, { original: '1001', account: ACCOUNT_A, observation: first }), /qualified_apple_status_projection_bound_insert/);
  for (const stale of [{ schemaDigest: sha('stale-schema') }, { generation: 'stale-generation' }, { epoch: 4 }]) {
    const evidence = seedStatusObservation(f.db, SBX_A, { original: '1001', account: ACCOUNT_A, ...stale });
    refused(() => seedProjection(f.db, SBX_A, { original: '1001', account: ACCOUNT_A, observation: evidence }), /qualified_apple_status_projection_bound_insert/);
  }
  assert.equal(count(f.db, 'qualified_apple_status_projection'), 1);
});

test('a status proof must resolve to the same account and original transaction in its namespace', async t => {
  const f = await qualified(t);
  seedAccount(f.db, ACCOUNT_A); seedAccount(f.db, ACCOUNT_B);
  seedOwner(f.db, SBX_A, '1000', ACCOUNT_A); seedOwner(f.db, SBX_A, '1001', ACCOUNT_A); seedOwner(f.db, SBX_A, '1002', ACCOUNT_B);
  const create = (transactionId: string, original: string, account: typeof ACCOUNT_A) => {
    const proof = seedTransaction(f.db, SBX_A, { transactionId, original, account });
    seedProofObservation(f.db, SBX_A, proof);
    return proof;
  };
  const own = create('2000', '1000', ACCOUNT_A);
  const otherLineage = create('2001', '1001', ACCOUNT_A);
  const otherAccount = create('2002', '1002', ACCOUNT_B);
  for (const proof of [otherLineage, otherAccount]) {
    refused(() => seedStatusObservation(f.db, SBX_A, { original: '1000', account: ACCOUNT_A, proof }), /qualified_apple_status_observations_proof/);
  }
  const { id } = seedStatusObservation(f.db, SBX_A, { original: '1000', account: ACCOUNT_A, proof: own });
  assert.deepEqual(f.db.prepare(`SELECT observation_id,account_id,original_transaction_id,proof_transaction_id,proof_hash
    FROM qualified_apple_status_observations`).all(), [{
    observation_id: id, account_id: ACCOUNT_A.accountId, original_transaction_id: '1000',
    proof_transaction_id: '2000', proof_hash: own.proofHash,
  }]);
});

test('exactly one account-only dispatch index serialises one active status request per account across lineages and namespaces', async t => {
  const f = await qualified(t);
  seedAccount(f.db, ACCOUNT_A); seedAccount(f.db, ACCOUNT_B);
  seedOwner(f.db, SBX_A, '1000', ACCOUNT_A); seedOwner(f.db, SBX_A, '1001', ACCOUNT_A); seedOwner(f.db, PRD_A, '1000', ACCOUNT_A); seedOwner(f.db, SBX_A, '1002', ACCOUNT_B);
  const indexes = (schemaObjects(f.db) as { type: string; name: string; sql: string }[]).filter(row => row.type === 'index' && /qualified_apple_status_one_dispatch/.test(row.name));
  assert.equal(indexes.length, 1);
  assert.match(indexes[0]!.sql, /ON qualified_apple_status_projection\(account_id\) WHERE active_request_id IS NOT NULL$/);
  const dispatch = (namespace: typeof SBX_A, original: string, account: typeof ACCOUNT_A) => {
    const observation = seedStatusObservation(f.db, namespace, { original, account, kind: 'dispatch' });
    const status = seedStatusObservation(f.db, namespace, { original, account });
    return { observation, status };
  };
  const active = (namespace: typeof SBX_A, original: string, account: typeof ACCOUNT_A, request: string, status: { id: string; sequence: number }) => () => {
    seedProjection(f.db, namespace, { original, account, observation: status });
    f.db.prepare('UPDATE OR REPLACE qualified_apple_status_projection SET revision=2,active_request_id=?,dispatch_state=?,request_deadline_ms=? WHERE namespace_key=? AND original_transaction_id=?')
      .run(request, 'dispatching', 5_000_000, nsKey(namespace), original);
  };
  const one = dispatch(SBX_A, '1000', ACCOUNT_A), two = dispatch(SBX_A, '1001', ACCOUNT_A), three = dispatch(PRD_A, '1000', ACCOUNT_A), other = dispatch(SBX_A, '1002', ACCOUNT_B);
  active(SBX_A, '1000', ACCOUNT_A, one.observation.id, one.status)();
  refused(active(SBX_A, '1001', ACCOUNT_A, two.observation.id, two.status), /qualified_apple_status_projection_dispatch_collision_update/);
  refused(active(PRD_A, '1000', ACCOUNT_A, three.observation.id, three.status), /qualified_apple_status_projection_dispatch_collision_update/);
  active(SBX_A, '1002', ACCOUNT_B, other.observation.id, other.status)();
  // A request id must be a dispatch observation of the same lineage; a status observation cannot masquerade as one.
  const forged = dispatch(SBX_A, '1000', ACCOUNT_A);
  refused(() => f.db.prepare('UPDATE qualified_apple_status_projection SET revision=3,active_request_id=? WHERE namespace_key=? AND original_transaction_id=?')
    .run(forged.status.id, nsKey(SBX_A), '1000'), /qualified_apple_status_projection_bound_update/);
  const actives = f.db.prepare('SELECT count(*) n FROM qualified_apple_status_projection WHERE active_request_id IS NOT NULL').get() as { n: number };
  assert.equal(actives.n, 2);
});

test('notification application and projection dependency rows bind exact accepted inbox identities', async t => {
  const f = await qualified(t);
  seedAccount(f.db, ACCOUNT_A); seedOwner(f.db, SBX_A, '1000', ACCOUNT_A); seedOwner(f.db, PRD_A, '1000', ACCOUNT_A);
  const a = f.inbox(), accepted = await a.accept(A_PAYLOADS[0], SBX_A, A_UUID);
  const unrelated = await a.accept(A_PAYLOADS[1], SBX_A, B_UUID);
  const claim = a.claim(accepted.receiptId);
  const request = { operationId: randomUUID(), claim, applicationInput: 'exact-effect' };
  const input = { uuid: A_UUID, aggregateId: accepted.aggregateId, receiptId: accepted.receiptId, original: '1000', account: ACCOUNT_A,
    request, payloadDigest: notificationPayloadDigest(accepted.capture.signedPayload) };
  const insert = (namespace = SBX_A, overrides: Partial<typeof input> = {}) => () => seedNotification(f.db, namespace, { ...input, ...overrides });
  refused(insert(SBX_A, { uuid: B_UUID }), /qualified_apple_notifications_bound/);
  refused(insert(PRD_A), /qualified_apple_notifications_bound/);
  refused(insert(SBX_A, { aggregateId: unrelated.aggregateId }), /qualified_apple_notifications_bound/);
  refused(insert(SBX_A, { receiptId: unrelated.receiptId }), /qualified_apple_notifications_bound/);
  refused(insert(SBX_A, { payloadDigest: sha('wrong') }), /qualified_apple_notifications_bound/);
  refused(insert(), /FOREIGN KEY constraint failed/);
  const tampered = a.committer().commit(request, insert(SBX_A, { request: { ...request, applicationInput: 'other-effect' } }), () => true);
  assert.notEqual(tampered.status, 'ok');
  assert.equal(count(f.db, 'qualified_apple_notifications'), 0);
  assert.equal(f.db.prepare('SELECT disposition FROM notification_inbox_state WHERE receipt_id=?').pluck().get(accepted.receiptId), 'claimed');
  assert.equal(f.db.prepare('SELECT 1 FROM notification_inbox_operations WHERE operation_id=?').get(request.operationId), undefined);
  const successful = a.committer().commit(request, insert(), () => true);
  assert.equal(successful.status, 'ok');
  assert.deepEqual(f.db.prepare('SELECT * FROM qualified_apple_notifications').get(), {
    namespace_key: nsKey(SBX_A), notification_uuid: A_UUID, aggregate_id: accepted.aggregateId, receipt_id: accepted.receiptId,
    payload_digest: input.payloadDigest, application_input: request.applicationInput, account_id: ACCOUNT_A.accountId,
    original_transaction_id: '1000', outcome_json: '{"status":"applied"}', applied_at_ms: 1000,
    operation_id: request.operationId,
  });
  refused(() => f.db.prepare('UPDATE qualified_apple_notifications SET outcome_json=?').run('{}'), /qualified_apple_notifications_immutable/);
  refused(() => f.db.prepare('DELETE FROM qualified_apple_notifications').run(), /qualified_apple_notifications_retained/);

  const projected = seedProjection(f.db, SBX_A, { original: '1000', account: ACCOUNT_A, provenance: 'notification_evidence', accepted });
  const dependency = (namespace: typeof SBX_A, revision: number, aggregateId: string, version: number) => () =>
    seedDependency(f.db, namespace, { original: '1000', revision, aggregateId, version });
  refused(dependency(SBX_A, projected.revision, accepted.aggregateId, 2), /qualified_apple_projection_dependencies_bound/);
  refused(dependency(SBX_A, projected.revision + 1, accepted.aggregateId, 1), /qualified_apple_projection_dependencies_bound/);
  refused(dependency(SBX_A, projected.revision, unrelated.aggregateId, 1), /qualified_apple_projection_dependencies_bound/);
  dependency(SBX_A, projected.revision, accepted.aggregateId, 1)();
  refused(() => f.db.prepare('UPDATE qualified_apple_projection_dependencies SET aggregate_version=9').run(), /qualified_apple_projection_dependencies_immutable/);
  refused(() => f.db.prepare('DELETE FROM qualified_apple_projection_dependencies').run(), /qualified_apple_projection_dependencies_retained/);
  seedProjection(f.db, PRD_A, { original: '1000', account: ACCOUNT_A, provenance: 'notification_evidence' });
  refused(dependency(PRD_A, 1, accepted.aggregateId, 1), /qualified_apple_projection_dependencies_bound/);

  const context = f.context(ACCOUNT_A, SBX_A);
  assert.equal(f.reader.projection(context, '1000').status, 'synthetic_current');
  const application = f.db.prepare('SELECT * FROM qualified_apple_notifications').all();
  const acceptance = f.db.prepare('SELECT * FROM qualified_apple_notification_commits').all();
  assert.deepEqual(acceptance, [{ namespace_key: nsKey(SBX_A), notification_uuid: A_UUID, operation_id: request.operationId }]);
  a.control.now = 32_000;
  assert.equal(a.inbox.expireIdentityAndAudit(a.caps.dispose, { operationId: randomUUID(), receiptId: accepted.receiptId,
    expectedVersion: successful.status === 'ok' ? successful.version : 0 }).status, 'ok');
  assert.equal(f.db.prepare('SELECT 1 FROM notification_inbox_operations WHERE receipt_id=?').get(accepted.receiptId), undefined);
  assert.equal(f.db.prepare('SELECT 1 FROM notification_inbox_receipts WHERE receipt_id=?').get(accepted.receiptId), undefined);
  assert.deepEqual(f.reader.projection(context, '1000'), { status: 'held', reason: 'dependency_missing', revision: 1,
    namespace: SBX_A, selectionGeneration: 'selection-one' });
  assert.deepEqual(f.db.prepare('SELECT * FROM qualified_apple_notifications').all(), application);
  assert.deepEqual(f.db.prepare('SELECT * FROM qualified_apple_notification_commits').all(), acceptance);
  assertQualifiedPurchaseSchema(f.db);
});

test('the schema validator refuses every irregularity of the extended store and repairs nothing', async t => {
  const f = await qualified(t);
  assertQualifiedPurchaseSchema(f.db);
  const unavailable = /qualified_purchase_schema_unavailable/;
  const mutate: [string, (db: Sqlite) => void][] = [
    ['dropped immutability trigger', db => db.exec('DROP TRIGGER qualified_apple_owners_immutable')],
    ['dropped fence trigger', db => db.exec('DROP TRIGGER qualified_apple_fence_apple_purchase_owners_insert')],
    ['dropped dispatch index', db => db.exec('DROP INDEX qualified_apple_status_one_dispatch_per_account')],
    ['extra qualified index', db => db.exec('CREATE INDEX qualified_apple_extra ON qualified_apple_owners(created_at_ms)')],
    ['unreceipted table', db => db.exec('CREATE TABLE stray(x)')],
    ['altered old table', db => db.exec('ALTER TABLE form_accounts ADD COLUMN stray TEXT')],
    ['changed quoted literal', db => {
      db.unsafeMode(true);
      db.pragma('writable_schema = ON');
      try {
        assert.equal(db.prepare(`UPDATE main.sqlite_master SET sql=replace(sql,'Auto-Renewable Subscription','Auto-Renewable  Subscription')
          WHERE name='qualified_apple_transactions'`).run().changes, 1);
      } finally {
        db.pragma('writable_schema = OFF');
        db.unsafeMode(false);
      }
    }],
    ['extra receipt', db => db.prepare('INSERT INTO form_migrations VALUES(28,?,?)').run('x', 'now')],
    ['removed receipt', db => db.exec('DELETE FROM form_migrations WHERE version=27')],
    ['changed receipt checksum', db => db.exec("UPDATE form_migrations SET checksum='tampered' WHERE version=3")],
    ['missing store row', db => { db.exec('DROP TRIGGER qualified_apple_store_retained'); db.exec('DELETE FROM qualified_apple_store'); }],
    ['inbox store removed', db => db.exec('DELETE FROM notification_inbox_store')],
    ['inbox store generation drift', db => db.prepare('UPDATE notification_inbox_store SET generation=?').run('drift')],
    ['inbox store ingress invalid', db => db.prepare('UPDATE notification_inbox_store SET ingress=?').run('bad ingress!')],
    ['inbox policy damaged', db => db.prepare('UPDATE notification_inbox_store SET policy_json=?').run('{}')],
    ['foreign key enforcement off', db => db.pragma('foreign_keys = OFF')],
  ];
  for (const [label, change] of mutate) {
    // A throwaway copy per case keeps the cases independent without reinstalling.
    const copy = join(f.root, `${label.replace(/\W/g, '-')}.sqlite`);
    f.db.pragma('wal_checkpoint(TRUNCATE)');
    copyFileSync(f.path, copy);
    const db = f.track(new Database(copy));
    db.pragma('foreign_keys = ON');
    change(db);
    assert.throws(() => assertQualifiedPurchaseSchema(db), unavailable, label);
    db.close();
  }
  // Predecessor tables must be empty on reopen too; an old purchase row refuses even if the fence is later restored.
  const copy = join(f.root, 'old-row.sqlite');
  copyFileSync(f.path, copy);
  const db = f.track(new Database(copy));
  db.pragma('foreign_keys = ON');
  const fence = qualifiedPurchaseDescriptors.find(item => item.name === 'qualified_apple_fence_apple_purchase_owners_insert')!;
  db.exec(`DROP TRIGGER ${fence.name}`); populate(db, 'apple_purchase_owners'); db.exec(fence.sql);
  assert.throws(() => assertQualifiedPurchaseSchema(db), unavailable);
  db.close();
  assertQualifiedPurchaseSchema(f.db);
});

// ---------------------------------------------------------------------------------------------------------------------
// Strict predecessor preflight and the fresh, empty-upgrade and reopen envelopes
// ---------------------------------------------------------------------------------------------------------------------

test('exact EMPTY Source27 upgrade: verified backup, three attested phases, borrowed handle, atomic extension', async t => {
  const g = await emptySource27(t);
  const before = snapshot(g.db);
  const rows = (db: Sqlite) => ({
    exercises: db.prepare('SELECT id,data FROM exercises ORDER BY id').all(),
    receipts: db.prepare('SELECT * FROM form_migrations ORDER BY version').all(),
  });
  const beforeRows = rows(g.db);
  assertEmptySource27ForQualifiedPurchases(g.db);
  const probe = currentnessProbe();
  const storage = await upgradeEmptySyntheticQualifiedPurchaseStorage(g.db, g.path, storeInput({ currentness: probe.currentness }));
  assert.equal(storage.ownership, 'borrowed');
  assert.equal(storage.db, g.db);
  assert.equal('close' in storage, false, 'a borrowed handle exposes no close for another owner\'s database');
  assert.deepEqual(probe.phases, ['before-backup', 'after-backup', 'under-lock']);
  assert.equal(g.db.open, true);
  assert.equal(storage.ownership === 'borrowed' && storage.backups.length, 1);
  const backup = storage.ownership === 'borrowed' ? storage.backups[0]! : '';
  assert.equal(dirname(backup), join(g.root, 'backups'));
  const old = new Database(backup, { readonly: true });
  try {
    assert.equal(snapshot(old), before, 'the verified backup is the exact pre-extension state');
    assert.deepEqual(rows(old), beforeRows, 'every retained predecessor value is identical in the backup');
    assert.equal(names(old, 'qualified_apple_').length, 0);
  } finally { old.close(); }
  assertQualifiedPurchaseSchema(g.db);
  assert.deepEqual(rows(g.db), beforeRows);
  assert.equal(storage.schemaDigest, allSchemaDigest(g.db));
  assert.deepEqual(migrationRows(g.db).map(row => row.version), Array.from({ length: 27 }, (_, index) => index + 1));
  assert.equal(count(g.db, 'qualified_apple_namespaces'), 4);
  assert.equal(g.db.pragma('foreign_keys', { simple: true }), 1);
  // A second attempt is no longer an empty Source27 and is refused without touching the extended store.
  const extended = snapshot(g.db);
  await assert.rejects(upgradeEmptySyntheticQualifiedPurchaseStorage(g.db, g.path, storeInput()), emptyRequired);
  assert.equal(snapshot(g.db), extended);
});

test('fresh installation uses the real storage constructor and an owned handle, and fails closed on every stale or unsafe path', async t => {
  const s = scratch(t);
  const probe = currentnessProbe();
  const storage = await openSyntheticQualifiedPurchaseStorage(s.path('fresh.sqlite'), storeInput({ currentness: probe.currentness }));
  s.track(storage.db);
  assert.equal(storage.ownership, 'owned');
  assert.deepEqual(probe.phases, ['before-backup', 'under-lock']);
  assert.equal(storage.db.pragma('journal_mode', { simple: true }), 'wal');
  assert.equal(storage.db.pragma('synchronous', { simple: true }), 2);
  assert.equal(storage.db.pragma('foreign_keys', { simple: true }), 1);
  if (storage.ownership === 'owned') storage.close();
  assert.equal(storage.db.open, false);

  // Any existing database or sidecar makes the path non-fresh and is refused before anything is touched.
  const existing = s.path('existing.sqlite');
  writeFileSync(existing, '');
  await assert.rejects(openSyntheticQualifiedPurchaseStorage(existing, storeInput()), /qualified_purchase_fresh_path_required/);
  for (const suffix of ['-wal', '-shm', '-journal']) {
    const path = s.path(`sidecar${suffix.replace('-', '')}.sqlite`);
    writeFileSync(path + suffix, '');
    await assert.rejects(openSyntheticQualifiedPurchaseStorage(path, storeInput()), /qualified_purchase_fresh_path_required/, suffix);
    assert.equal(existsSync(path), false);
  }
  // A failed attestation closes the handle and writes no extension.
  for (const decide of [() => false, () => 'true', () => Promise.resolve(true), () => { throw new Error('private-callback-detail'); }]) {
    const path = s.path(`attest-${Math.random().toString(36).slice(2)}.sqlite`);
    await assert.rejects(openSyntheticQualifiedPurchaseStorage(path, storeInput({ currentness: currentnessProbe(decide).currentness })), (error: unknown) =>
      error instanceof Error && error.message === 'qualified_purchase_currentness_required' && !JSON.stringify(error).includes('private-callback-detail'));
    const check = s.track(new Database(path));
    assert.equal(names(check, 'qualified_apple_').length, 0);
    assert.equal(count(check, 'form_migrations'), 27);
    check.close();
  }
  // A late failure under the write lock rolls the whole extension back.
  const late = s.path('late.sqlite');
  await assert.rejects(openSyntheticQualifiedPurchaseStorage(late, storeInput({ currentness: currentnessProbe(phase => phase !== 'under-lock').currentness })), /qualified_purchase_currentness_required/);
  const check = s.track(new Database(late));
  assert.equal(names(check, 'qualified_apple_').length, 0);
  assert.equal(names(check, 'notification_inbox').length, 0);
  check.close();
});

test('every predecessor irregularity refuses before the extension and leaves history 1..27 and old state unchanged', async t => {
  const g = await emptySource27(t);
  g.db.pragma('wal_checkpoint(TRUNCATE)');
  const pristine = join(g.root, 'pristine.sqlite');
  copyFileSync(g.path, pristine);
  const baseline = backupsOf(g.root);
  const cases: [string, (db: Sqlite) => void][] = [
    ['wrong receipt checksum', db => db.exec("UPDATE form_migrations SET checksum='wrong' WHERE version=27")],
    ['wrong early receipt checksum', db => db.exec("UPDATE form_migrations SET checksum='wrong' WHERE version=1")],
    ['receipt gap', db => db.exec('DELETE FROM form_migrations WHERE version=13')],
    ['extra receipt 28', db => db.prepare('INSERT INTO form_migrations VALUES(28,?,?)').run('x', 'now')],
    ['history stops at 16', db => db.exec('DELETE FROM form_migrations WHERE version>16')],
    ['history stops at 26', db => db.exec('DELETE FROM form_migrations WHERE version>26')],
    ['no receipts', db => db.exec('DELETE FROM form_migrations')],
    ['unreceipted table', db => db.exec('CREATE TABLE unreceipted(x)')],
    ['unreceipted index', db => db.exec('CREATE INDEX unreceipted_index ON form_accounts(created_at)')],
    ['unreceipted trigger', db => db.exec('CREATE TRIGGER unreceipted_trigger BEFORE INSERT ON form_accounts BEGIN SELECT 1; END')],
    ['altered old table', db => db.exec('ALTER TABLE form_accounts ADD COLUMN altered TEXT')],
    ['dropped old index', db => db.exec(`DROP INDEX ${(db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND sql IS NOT NULL LIMIT 1").get() as { name: string }).name}`)],
    ['partial inbox extension', db => db.exec(notificationInboxSql)],
    ['partial qualified extension', db => db.exec(qualifiedPurchaseDescriptors.find(item => item.name === 'qualified_apple_store')!.sql)],
    ['one fence only', db => db.exec(qualifiedPurchaseDescriptors.find(item => item.name.startsWith('qualified_apple_fence_'))!.sql)],
    ['dropped predecessor table', db => db.exec('DROP TABLE apple_purchase_status_projection')],
  ];
  for (const [label, change] of cases) {
    const path = join(g.root, `case-${label.replace(/\W/g, '-')}.sqlite`);
    copyFileSync(pristine, path);
    const db = g.track(new Database(path));
    db.pragma('foreign_keys = ON'); db.pragma('journal_mode = WAL'); db.pragma('synchronous = FULL');
    change(db);
    const before = snapshot(db), probe = currentnessProbe();
    assert.throws(() => assertEmptySource27ForQualifiedPurchases(db), emptyRequired, label);
    await assert.rejects(upgradeEmptySyntheticQualifiedPurchaseStorage(db, path, storeInput({ currentness: probe.currentness })), emptyRequired, label);
    assert.equal(snapshot(db), before, `${label}: nothing deleted, repaired, installed or reset`);
    assert.deepEqual(backupsOf(dirname(path)), baseline, `${label}: refused before any backup`);
    db.close();
  }
  // The pristine copy still upgrades, proving each refusal above was caused by its own irregularity.
  const db = g.track(new Database(pristine));
  db.pragma('foreign_keys = ON'); db.pragma('journal_mode = WAL'); db.pragma('synchronous = FULL');
  const storage = await upgradeEmptySyntheticQualifiedPurchaseStorage(db, pristine, storeInput());
  assert.equal(storage.ownership, 'borrowed');
  db.close();
});

test('a row in any single predecessor table refuses, attributed to that table; deleting it restores the exact empty predicate', async t => {
  const g = await emptySource27(t);
  g.db.pragma('wal_checkpoint(TRUNCATE)');
  const pristine = join(g.root, 'pristine.sqlite');
  copyFileSync(g.path, pristine);
  const tables = genuinePredecessorSchema().tables.filter(name => name !== 'form_migrations' && name !== 'exercises');
  assert.ok(tables.length >= 40, `expected the full Source27 table set, got ${tables.length}`);
  for (const required of [...predecessorPurchaseTables, 'account_provider_revocation_intents', 'account_action_challenges', 'account_action_proof_consumptions', 'form_accounts', 'user'])
    assert.ok(tables.includes(required), required);
  const guarded: string[] = [];
  for (const table of tables) {
    const path = join(g.root, `populated-${table}.sqlite`);
    copyFileSync(pristine, path);
    const db = g.track(new Database(path));
    db.pragma('foreign_keys = ON');
    if (plant(db, table)) guarded.push(table);
    // Some tables populate dependents through their own triggers; the refusal names the first populated table in genuine order.
    const populatedNow = tables.filter(name => count(db, name) > 0);
    assert.ok(populatedNow.includes(table), table);
    assert.throws(() => assertEmptySource27ForQualifiedPurchases(db), (error: unknown) => emptyRequired.test((error as Error).message) && cause(error) === `populated:${populatedNow[0]}`, table);
    db.close();
  }
  assert.ok(guarded.length > 0 && guarded.length < 10, `tables whose own triggers guard inserts: ${guarded.join(', ')}`);
  // Only the receipt table and the catalog may hold rows.
  const rows = tableCounts(g.db);
  assert.ok(rows.form_migrations === 27 && (rows.exercises ?? 0) > 0);
  assertEmptySource27ForQualifiedPurchases(g.db);
});

test('currentness is attested before and after the backup and again under the write lock; a competing row is caught under the final lock', async t => {
  const g = await emptySource27(t);
  g.db.pragma('wal_checkpoint(TRUNCATE)');
  const pristine = join(g.root, 'pristine.sqlite');
  copyFileSync(g.path, pristine);
  const open = (name: string) => {
    const path = join(g.root, name);
    copyFileSync(pristine, path);
    const db = g.track(new Database(path));
    db.pragma('foreign_keys = ON'); db.pragma('journal_mode = WAL'); db.pragma('synchronous = FULL');
    return { path, db };
  };
  // A row that appears after the backup was verified is found by the repeated check, before attestation and before install.
  const racing = open('racing.sqlite');
  let raced = false;
  const probe = currentnessProbe(phase => { if (phase === 'after-backup' && !raced) { raced = true; populate(racing.db, 'apple_purchase_owners'); } return true; });
  await assert.rejects(upgradeEmptySyntheticQualifiedPurchaseStorage(racing.db, racing.path, storeInput({ currentness: probe.currentness })), (error: unknown) =>
    emptyRequired.test((error as Error).message) && cause(error) === 'populated:apple_purchase_owners');
  assert.deepEqual(probe.phases, ['before-backup', 'after-backup', 'under-lock']);
  assert.equal(names(racing.db, 'qualified_apple_').length, 0);
  assert.equal(names(racing.db, 'notification_inbox').length, 0);
  assert.equal(count(racing.db, 'apple_purchase_owners'), 1, 'the competing row is neither deleted nor adopted');

  // A row that appears between the post-backup check and the immediate lock is found by the final locked check.
  const late = open('late.sqlite');
  const lateProbe = currentnessProbe(phase => { if (phase === 'under-lock') { populate(late.db, 'apple_purchase_commands'); } return true; });
  await assert.rejects(upgradeEmptySyntheticQualifiedPurchaseStorage(late.db, late.path, storeInput({ currentness: lateProbe.currentness })), (error: unknown) =>
    emptyRequired.test((error as Error).message) && cause(error) === 'populated:apple_purchase_commands');
  assert.equal(names(late.db, 'qualified_apple_').length, 0);

  // Failed attestation at each phase refuses and installs nothing; only the last two phases happen after a backup exists.
  for (const failing of ['before-backup', 'after-backup', 'under-lock']) {
    const current = open(`attest-${failing}.sqlite`);
    const before = snapshot(current.db), backups = backupsOf(g.root).length;
    const phases = currentnessProbe(phase => phase !== failing);
    await assert.rejects(upgradeEmptySyntheticQualifiedPurchaseStorage(current.db, current.path, storeInput({ currentness: phases.currentness })), /qualified_purchase_currentness_required/, failing);
    assert.equal(snapshot(current.db), before, failing);
    assert.equal(backupsOf(g.root).length - backups, failing === 'before-backup' ? 0 : 1, `${failing}: a backup exists only once the first attestation passed`);
  }
  // Settings and handle preconditions: read-only, foreign key enforcement off, rolled-back, wrong path or an open transaction.
  const guarded = open('guarded.sqlite');
  guarded.db.pragma('foreign_keys = OFF');
  await assert.rejects(upgradeEmptySyntheticQualifiedPurchaseStorage(guarded.db, guarded.path, storeInput()), /qualified_purchase_settings_required/);
  guarded.db.pragma('foreign_keys = ON');
  await assert.rejects(upgradeEmptySyntheticQualifiedPurchaseStorage(guarded.db, join(g.root, 'elsewhere.sqlite'), storeInput()), /qualified_purchase_path_required/);
  guarded.db.exec('BEGIN');
  try { await assert.rejects(upgradeEmptySyntheticQualifiedPurchaseStorage(guarded.db, guarded.path, storeInput()), /qualified_purchase_upgrade_rejected/); }
  finally { guarded.db.exec('ROLLBACK'); }
  assert.equal(names(guarded.db, 'qualified_apple_').length, 0);
});

test('reopen accepts the exact inbox and qualified extension with populated qualified rows and refuses any drift without repairing it', async t => {
  const f = await qualified(t);
  seedAccount(f.db, ACCOUNT_A);
  seedOwner(f.db, SBX_A, '1000', ACCOUNT_A);
  const tx = seedTransaction(f.db, SBX_A, { transactionId: '2000', original: '1000', account: ACCOUNT_A });
  seedProofObservation(f.db, SBX_A, tx);
  const populated = snapshot(f.db);
  if (f.storage.ownership === 'owned') f.storage.close();

  const probe = currentnessProbe();
  const reopened = reopenSyntheticQualifiedPurchaseStorage(f.path, storeInput({ currentness: probe.currentness }));
  f.track(reopened.db);
  assert.equal(reopened.ownership, 'owned');
  assert.deepEqual(probe.phases, ['reopen']);
  assert.equal(snapshot(reopened.db), populated, 'reopen neither backfills, migrates nor adds a row');
  assert.equal(count(reopened.db, 'qualified_apple_transactions'), 1);
  assert.equal(reopened.db.pragma('foreign_keys', { simple: true }), 1);
  if (reopened.ownership === 'owned') reopened.close();

  const held = /qualified_purchase_held/;
  const drift: [string, Record<string, unknown>][] = [
    ['configuration revision', { configuration: configurationFor(ALL_NAMESPACES, 'config2') }],
    ['configuration namespaces', { configuration: configurationFor([SBX_A, PRD_A]) }],
    ['policy', { policy: { ...policy, maxPageSize: 4 } }],
    ['policy revision', { policy: { ...policy, revision: 'policy2' } }],
    ['store id', { storeId: 'other-store' }],
    ['generation', { generation: 'other-generation' }],
    ['inbox ingress', { inbox: { ingress: 'other', policy: inboxPolicy } }],
    ['inbox policy', { inbox: { ingress: 'fixture', policy: { ...inboxPolicy, maxPageSize: 9 } } }],
  ];
  for (const [label, override] of drift) {
    assert.throws(() => reopenSyntheticQualifiedPurchaseStorage(f.path, storeInput(override)), held, label);
  }
  assert.throws(() => reopenSyntheticQualifiedPurchaseStorage(f.path, storeInput({ currentness: currentnessProbe(() => false).currentness })), /qualified_purchase_currentness_required/);
  assert.throws(() => reopenSyntheticQualifiedPurchaseStorage(join(f.root, 'missing.sqlite'), storeInput()), /qualified_purchase_path_required/);
  assert.throws(() => reopenSyntheticQualifiedPurchaseStorage('relative.sqlite', storeInput()), /qualified_purchase_path_required/);

  // Schema drift on the stored database: removed fence, an old purchase row behind a restored fence, extra objects.
  const db = f.track(new Database(f.path));
  db.pragma('foreign_keys = ON');
  const fence = qualifiedPurchaseDescriptors.find(item => item.name === 'qualified_apple_fence_apple_purchase_deliveries_delete')!;
  db.exec(`DROP TRIGGER ${fence.name}`);
  db.close();
  assert.throws(() => reopenSyntheticQualifiedPurchaseStorage(f.path, storeInput()), /qualified_purchase_schema_unavailable/);
  // Restoring the exact fence SQL makes the same file acceptable again: every refusal above came from its own drift.
  const restored = new Database(f.path);
  restored.exec(fence.sql);
  restored.close();
  const final = reopenSyntheticQualifiedPurchaseStorage(f.path, storeInput());
  f.track(final.db);
  assert.equal(count(final.db, 'qualified_apple_transactions'), 1);
});

// ---------------------------------------------------------------------------------------------------------------------
// Qualified effects and the inbox terminal disposition commit atomically through the inbox's own synthetic committer
// ---------------------------------------------------------------------------------------------------------------------

test('a failed qualified write or a failed terminal completion leaves neither the qualified effect nor an applied disposition; success persists both', async t => {
  const f = await qualified(t);
  seedAccount(f.db, ACCOUNT_A);
  const a = f.inbox();
  const dispositions = (receiptId: string) => (f.db.prepare('SELECT disposition,reason FROM notification_inbox_state WHERE receipt_id=?').get(receiptId) as { disposition: string; reason: string });
  const effect = (db: Sqlite, original: string, accepted: Awaited<ReturnType<typeof a.accept>>, request: Parameters<ReturnType<typeof a.committer>['commit']>[0]) => {
    seedOwner(db, SBX_A, original, ACCOUNT_A);
    const tx = seedTransaction(db, SBX_A, { transactionId: `${original}9`, original, account: ACCOUNT_A });
    seedProofObservation(db, SBX_A, tx);
    seedNotification(db, SBX_A, { uuid: A_UUID, aggregateId: accepted.aggregateId, receiptId: accepted.receiptId,
      original, account: ACCOUNT_A, request, payloadDigest: notificationPayloadDigest(accepted.capture.signedPayload) });
  };
  const sample = () => ({ owners: count(f.db, 'qualified_apple_owners'), transactions: count(f.db, 'qualified_apple_transactions'), notifications: count(f.db, 'qualified_apple_notifications') });

  // 1. The qualified fixture write fails after writing part of its effect.
  const one = await a.accept('synthetic.tx.one', SBX_A, A_UUID), claimOne = a.claim(one.receiptId);
  const failed = a.committer().commit({ operationId: randomUUID(), claim: claimOne, applicationInput: 'effect-one' }, db => {
    seedOwner(db, SBX_A, '1000', ACCOUNT_A);
    seedTransaction(db, SBX_A, { transactionId: '10009', original: '1000', account: ACCOUNT_A });
    seedTransaction(db, SBX_A, { transactionId: '10009', original: '1000', account: ACCOUNT_A }); // primary key collision
  }, () => true);
  assert.notEqual(failed.status, 'ok');
  assert.equal(failed.acknowledge, false);
  assert.deepEqual(sample(), { owners: 0, transactions: 0, notifications: 0 });
  assert.notEqual(dispositions(one.receiptId).disposition, 'applied');

  // 2. The qualified effect succeeds but the terminal completion guard fails: the whole transaction rolls back.
  let calls = 0;
  const unguardedRequest = { operationId: randomUUID(), claim: claimOne, applicationInput: 'effect-two' };
  const unguarded = a.committer().commit(unguardedRequest, db => effect(db, '1000', one, unguardedRequest), () => ++calls === 1);
  assert.notEqual(unguarded.status, 'ok');
  assert.deepEqual(sample(), { owners: 0, transactions: 0, notifications: 0 });
  assert.notEqual(dispositions(one.receiptId).disposition, 'applied');

  // 3. A throwing application callback is likewise atomic.
  const throwingRequest = { operationId: randomUUID(), claim: claimOne, applicationInput: 'effect-three' };
  const thrown = a.committer().commit(throwingRequest, db => {
    effect(db, '1000', one, throwingRequest); throw new Error('application failed');
  }, () => true);
  assert.notEqual(thrown.status, 'ok');
  assert.deepEqual(sample(), { owners: 0, transactions: 0, notifications: 0 });

  // 4. Success persists the qualified effect and the applied disposition together.
  const successfulRequest = { operationId: randomUUID(), claim: claimOne, applicationInput: 'effect-four' };
  const success = a.committer().commit(successfulRequest, db => effect(db, '1000', one, successfulRequest), () => true);
  assert.equal(success.status, 'ok', JSON.stringify(success));
  assert.deepEqual(sample(), { owners: 1, transactions: 1, notifications: 1 });
  assert.deepEqual(dispositions(one.receiptId), { disposition: 'applied', reason: 'applied' });
  const operation = f.db.prepare('SELECT receipt_id,input_json,result_json FROM notification_inbox_operations WHERE operation_id=?')
    .get(successfulRequest.operationId) as { receipt_id: string; input_json: string; result_json: string };
  assert.equal(operation.result_json, JSON.stringify(success));
  assert.deepEqual(f.db.prepare('SELECT receipt_id,application_input,operation_id,payload_digest FROM qualified_apple_notifications').get(), {
    receipt_id: operation.receipt_id, application_input: successfulRequest.applicationInput, operation_id: successfulRequest.operationId,
    payload_digest: notificationPayloadDigest(one.capture.signedPayload),
  });
  assert.equal(operation.input_json, JSON.stringify({ kind: 'purchase_commit', ...successfulRequest }));
  assert.deepEqual(f.db.prepare('SELECT * FROM qualified_apple_notification_commits').all(), [
    { namespace_key: nsKey(SBX_A), notification_uuid: A_UUID, operation_id: successfulRequest.operationId },
  ]);
  assert.deepEqual(f.db.pragma('foreign_key_check'), []);
});

// ---------------------------------------------------------------------------------------------------------------------
// Scope: nothing is selected, mounted, registered, enabled or created by this source slice
// ---------------------------------------------------------------------------------------------------------------------

const walk = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap(entry =>
  entry.isDirectory() ? walk(join(directory, entry.name)) : entry.name.endsWith('.ts') ? [join(directory, entry.name)] : []);

test('the qualified source is unmounted: no other module imports it and it imports no runtime, server, CLI, factory or provider client', () => {
  const own = walk(join(sourceRoot, 'purchases')).filter(path => /qualified-purchase/.test(path));
  assert.deepEqual(own.map(path => path.slice(path.lastIndexOf('/') + 1)).sort(), [
    'qualified-purchase-context.ts', 'qualified-purchase-preflight.ts', 'qualified-purchase-schema.ts', 'qualified-purchase-store.ts', 'qualified-purchase.types.ts']);
  for (const path of walk(sourceRoot)) {
    if (own.includes(path)) continue;
    assert.equal(/qualified-purchase/.test(readFileSync(path, 'utf8')), false, `${path} must not select or mount the qualified source`);
  }
  const allowed = new Set(['node:crypto', 'node:fs', 'node:path', 'better-sqlite3']);
  for (const path of own) {
    const text = readFileSync(path, 'utf8');
    for (const match of text.matchAll(/from '([^']+)'/g)) {
      const target = match[1]!;
      if (allowed.has(target) || target.startsWith('./qualified-purchase') || target === '../storage.js' || target === '../lifecycle/types.js' || target === '../lifecycle/evidence-codec.js') continue;
      assert.match(target, /^\.\/(notification-inbox(-schema|-capabilities|\.types)?|status-source-migrations|configuration|types)\.js$/, `${path} imports ${target}`);
    }
    assert.doesNotMatch(text, /\bprocess\.env\b|\bcreateServer\b|\blisten\(|\bfetch\(|\bhttp[s]?:\/\/|\bmigration28\b|\bsetTimeout\b|\bsetInterval\b|\bchild_process\b/);
    assert.doesNotMatch(text, /INSERT INTO\s+("user"|session|account|form_accounts|form_migrations)/i, 'no account, session or migration creation');
    assert.doesNotMatch(text, /\b(createPurchaseEvidenceCommitter|PurchaseEvidenceCommitter|enableCharge|chargeEnabled|createNativeReceipt|signedTransactionInfo)\b/);
  }
});

test('no migration 28 exists or is registered; the genuine selection stays exactly 1..27', () => {
  const selection = selectSourceSubscriptionStatusMigrations();
  assert.equal(selection.length, 27);
  assert.deepEqual(selection.map(migration => migration.version), Array.from({ length: 27 }, (_, index) => index + 1));
  for (const path of walk(join(sourceRoot, 'purchases'))) {
    if (/qualified-purchase/.test(path)) continue;
    assert.doesNotMatch(readFileSync(path, 'utf8'), /qualified_apple_/, `${path} must not know the successor schema`);
  }
  for (const migration of selection) assert.doesNotMatch(migration.sql, /qualified_apple_/);
});

test('readers are synchronous and the fixture store never grants, acknowledges or calls a producer', async t => {
  const f = await qualified(t);
  seedAccount(f.db, ACCOUNT_A); seedOwner(f.db, SBX_A, '1000', ACCOUNT_A);
  const context = f.context(ACCOUNT_A, SBX_A);
  const before = snapshot(f.db);
  const owner = f.reader.owner(context, '1000');
  assert.equal(typeof (owner as { then?: unknown } | null)?.then, 'undefined');
  assert.equal(snapshot(f.db), before, 'a read writes nothing: no grant, acknowledgement, claim or entitlement');
  for (const table of ['qualified_apple_grants', 'notification_inbox_claims', 'notification_inbox_work', 'notification_inbox_transitions'] as const) assert.equal(count(f.db, table), 0, table);
  assert.ok(userTables(f.db).includes('qualified_apple_grants'));
});
