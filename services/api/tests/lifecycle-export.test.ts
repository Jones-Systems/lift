import { Domain } from '../src/domain.js';
import { createCanonicalAccountWriter } from '../src/integration/account-modules/canonical-writer.js';
import { createConfirmedCaptureHost, confirmedCaptureKind, confirmedCaptureOperation } from '../src/integration/first-plan/confirmed-capture.js';
import { createR1CaptureContentPort, r1IntakeContentDigest, r1IntakeDefinition } from '../src/integration/first-plan/r1-intake-content.js';
import { fixture as captureAccountFixture } from './integration/account-modules/fixture.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { DomainError } from '../src/errors.js';
import { migrations, type Sqlite } from '../src/storage.js';
import { ACCOUNT_EXPORT_MAX_BYTES, buildAccountExport } from '../src/lifecycle/export.js';
import type { AccountContext, LifecycleAdapter } from '../src/lifecycle/types.js';
import { lifecycleMigration } from '../src/lifecycle/migration.js';
import { createActivityLifecycleAdapter, type ActivityPlanSnapshot, type PersonalExercise } from '../src/activity/index.js';
import { fixture as activityFixture, personalFields, unknownLoad } from './activity/fixture.js';

const context: AccountContext = { accountId: 'form-a', authUserId: 'auth-a', sessionId: 'auth-session-a', epoch: 0 };
const date = '2026-10-09T00:00:00.000Z';
type ExportDocument = { records: { category: string; value: Record<string, unknown> }[];
  manifest: { complete: boolean; categories: { category: string; status: string; count: number; reason?: string }[];
    omissions: unknown[]; residuals: unknown[]; provenance: Record<string, string> } };
const unpack = (json: string) => JSON.parse(json) as ExportDocument;
const revoked = () => new DomainError(403, 'account_disabled');

function fixture(run: (db: Sqlite, path: string) => void): void {
  // Source and compiled test paths both resolve to this worktree's services/api/tests.
  const here = fileURLToPath(new URL('.', import.meta.url));
  const root = mkdtempSync(join(resolve(here, here.includes('/dist/tests/') ? '../../tests' : '.'), '.lifecycle-export-leaf-'));
  const path = join(root, 'synthetic.sqlite');
  let db: Sqlite | undefined;
  let cleaned = false;
  let failed = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    try { if (db?.open) db.close(); }
    finally { rmSync(root, { recursive: true, force: true }); }
  };
  const interrupt = () => { cleanup(); process.exit(130); };
  const terminate = () => { cleanup(); process.exit(143); };
  process.once('SIGINT', interrupt); process.once('SIGTERM', terminate);
  try {
    db = new Database(path);
    db.pragma('foreign_keys = ON'); db.pragma('journal_mode = WAL');
    for (const migration of migrations) db.exec(migration.sql);
    seed(db);
    run(db, path);
  } catch (error) {
    failed = true; throw error;
  } finally {
    try { cleanup(); assert.equal(existsSync(root), false); }
    catch (cleanupError) {
      if (!failed) throw cleanupError;
      process.emitWarning('Lifecycle export fixture cleanup failed; original test failure preserved.');
    }
    finally { process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', terminate); }
  }
}

function seed(db: Sqlite): void {
  db.prepare('INSERT INTO exercises(id,data) VALUES (?,?)').run('exercise', '{}');
  db.prepare('INSERT INTO promos VALUES (?,?,0)').run('private-promo-hash', JSON.stringify({ entitlement: 'form_plus', days: 30 }));
  for (const suffix of ['a', 'b']) {
    const account = `form-${suffix}`, auth = `auth-${suffix}`;
    db.prepare('INSERT INTO "user"(id,name,email,emailVerified,createdAt,updatedAt,phoneNumber,phoneNumberVerified) VALUES (?,?,?,?,?,?,?,?)')
      .run(auth, `identity-${suffix}`, `${suffix}@synthetic.invalid`, 1, 1, 1, `+1202555011${suffix === 'a' ? '1' : '2'}`, 1);
    db.prepare('INSERT INTO form_accounts VALUES (?,?,?)').run(account, auth, date);
    db.prepare('INSERT INTO session(id,expiresAt,token,createdAt,updatedAt,userId) VALUES (?,?,?,?,?,?)')
      .run(`auth-session-${suffix}`, 9999999999999, `session-secret-${suffix}`, 1, 1, auth);
    db.prepare('INSERT INTO account(id,accountId,providerId,userId,password,accessToken,refreshToken,idToken,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(`credential-${suffix}`, `provider-subject-${suffix}`, 'credential', auth, 'password-secret', 'oauth-access-secret', 'oauth-refresh-secret', 'oauth-id-secret', 1, 1);
    db.prepare('INSERT INTO verification VALUES (?,?,?,?,?,?)').run(`otp-${suffix}`, `otp-subject-${suffix}`, 'otp-secret', 9999999999999, 1, 1);
    db.prepare('INSERT INTO phone_challenges VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(`challenge-${suffix}`, `+1202555011${suffix === 'a' ? '1' : '2'}`, 'phone-binding-secret', `phone-start-key-${suffix}`,
        'consumed', `provider-sid-secret-${suffix}`, 1, 2, 1, 1, 1, 1, auth);
    db.prepare('INSERT INTO phone_operations VALUES (?,?,?,?,?,?)')
      .run(`challenge-${suffix}`, 'check', `phone-key-${suffix}`, 'phone-intent-hash-secret', 'done', 1);
    const docs: Record<string, unknown> = {
      profile: { name: `profile-current-${suffix}`, injuryHistory: `injury-current-${suffix}`, password: 'embedded-password-secret' },
      preferences: { communication: `preferences-current-${suffix}` },
      onboarding: { step: `onboarding-current-${suffix}`, answers: { injuryHistory: `onboarding-answer-${suffix}` } },
      'cues:exercise': { kept: [`cue-current-${suffix}`] },
    };
    for (const [kind, data] of Object.entries(docs)) {
      db.prepare('INSERT INTO documents VALUES (?,?,1,?)').run(account, kind, JSON.stringify(data));
      const historical = kind === 'profile' ? { name: `profile-history-${suffix}` } : kind === 'preferences'
        ? { communication: `preferences-history-${suffix}` } : kind === 'onboarding' ? { step: `onboarding-history-${suffix}` }
          : { rejected: [`cue-history-${suffix}`] };
      db.prepare('INSERT INTO document_revisions VALUES (?,?,?,?,?)').run(account, kind, 0, JSON.stringify(historical), date);
      db.prepare('INSERT INTO document_revisions VALUES (?,?,?,?,?)').run(account, kind, 1, JSON.stringify(data), date);
    }
    const planItem = { id: `item-${suffix}`, exerciseId: 'exercise', setTarget: 3, repMin: 8, repMax: 12, targetKg: 40 };
    db.prepare('INSERT INTO plans VALUES (?,?,2,1,?,?,?)').run(account, `plan-${suffix}`, JSON.stringify({ name: `plan-current-${suffix}`, items: [planItem] }), date, date);
    for (const revision of [1, 2]) db.prepare('INSERT INTO plan_revisions VALUES (?,?,?,?,?)')
      .run(account, `plan-${suffix}`, revision, JSON.stringify({ name: `plan-history-${revision}-${suffix}`, items: [planItem], archived: revision === 2 }), date);
    db.prepare('INSERT INTO plan_item_ids VALUES (?,?,?,?)').run(account, `plan-${suffix}`, planItem.id, 'exercise');
    db.prepare('INSERT INTO workout_sessions VALUES (?,?,?,?,1,?,\'completed\',?,?)')
      .run(account, `workout-${suffix}`, `plan-${suffix}`, 1, JSON.stringify({ name: `snapshot-${suffix}`, items: [planItem] }), date, date);
    db.prepare('INSERT INTO session_occurrences VALUES (?,?,?,?,?,?,?)')
      .run(account, `workout-${suffix}`, `occurrence-${suffix}`, planItem.id, 'exercise', 0, JSON.stringify(planItem));
    db.prepare('INSERT INTO performed_sets VALUES (?,?,?,?,?,1,?,?,?,?,?)')
      .run(account, `workout-${suffix}`, `set-${suffix}`, `occurrence-${suffix}`, 1, 8, 40, 'confirmed', date, date);
    for (const revision of [1, 2]) db.prepare('INSERT INTO set_revisions VALUES (?,?,?,?,?,?)')
      .run(account, `workout-${suffix}`, `set-${suffix}`, revision, JSON.stringify({ id: `set-history-${revision}-${suffix}`, reps: 8 }), date);
    db.prepare('INSERT INTO transcription_attempts VALUES (?,?,?,?,?,?,?,?,?)')
      .run(account, `transcript-${suffix}`, `transcript-key-${suffix}`, 'transcript-private-hash', 'succeeded', `stored-text-${suffix}`, null, date, date);
    db.prepare('INSERT INTO entitlement_grants VALUES (?,?,?,?,?,?,?,?)')
      .run(account, `promo-grant-${suffix}`, 'form_plus', 'promo', 'private-promo-hash', date, date, 'zero_charge');
    db.prepare('INSERT INTO command_receipts VALUES (?,?,?,?,?,?,?)').run(account, 'plan-create', `receipt-key-${suffix}`, 'receipt-private-hash', 201,
      JSON.stringify({ name: `receipt-unique-${suffix}`, rawJWS: 'receipt-jws-secret', statusToken: 'receipt-status-secret', internal: { text: 'private-log-secret' } }), date);
    db.prepare('INSERT INTO apple_purchase_owners VALUES (?,?,?,?,?)').run(`original-${suffix}`, account, 'synthetic.bundle', 'Sandbox', 1);
    db.prepare('INSERT INTO apple_purchase_transactions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(`transaction-${suffix}`, `original-${suffix}`, account, `product-${suffix}`, 'Non-Consumable', account, 1, 1, null, null, 0, 'proof-private-hash', 'raw-jws-secret', 1);
    db.prepare('INSERT INTO apple_purchase_grants VALUES (?,?,?,?,?)').run(`transaction-${suffix}`, account, `purchase-grant-${suffix}`, 'form_plus', 1);
    db.prepare('INSERT INTO apple_purchase_observations VALUES (?,?,?,?,?)').run(`transaction-${suffix}`, 'observation-private-hash',
      JSON.stringify({ productId: `observation-product-${suffix}`, transactionId: `transaction-${suffix}`, quantity: 1, rawJWS: 'observation-jws-secret' }), 'observation-raw-jws-secret', 1);
    db.prepare('INSERT INTO apple_purchase_commands VALUES (?,?,?,?)').run(account, `purchase-key-${suffix}`, `transaction-${suffix}`, `product-${suffix}`);
    db.prepare('INSERT INTO apple_purchase_deliveries VALUES (?,?,?,?,?,?,?)').run(`transaction-${suffix}`, 'delivery-private-hash', `delivery-${suffix}`, account, `product-${suffix}`, 'delivery-raw-jws-secret', 1);
  }
}

function adapter(category: string, status: 'complete' | 'pending' | 'unavailable' | 'unknown' | 'retained',
  effect?: LifecycleAdapter['export']): LifecycleAdapter {
  const result = () => ({ status });
  return { category, inventory: () => ({ category, status }), export: effect ?? (() => ({ category, status })),
    suppress: result, purge: result, verifySuppressed: result };
}

test('export covers current/history markers and unique receipts, with exact account isolation and exclusions', () => fixture(db => {
  db.prepare('INSERT INTO phone_challenges VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run('unbound-challenge', '+12025550111', 'unbound-binding-secret', 'unbound-start-key', 'unknown',
      'unbound-provider-secret', 99887766, 99887799, 99887766, 1, 0, null, null);
  const before = db.prepare('SELECT total_changes() AS count').get();
  let checks = 0;
  const result = buildAccountExport(db, context, received => { assert.deepEqual(received, context); checks++; });
  assert.equal(checks, 2);
  assert.deepEqual(db.prepare('SELECT total_changes() AS count').get(), before);
  assert.equal(result.bytes, Buffer.byteLength(result.json));
  assert.equal(result.complete, false);
  for (const marker of ['identity', 'profile-current', 'profile-history', 'injury-current', 'preferences-current', 'preferences-history',
    'onboarding-current', 'onboarding-answer', 'onboarding-history', 'cue-current', 'cue-history', 'plan-current', 'plan-history-1',
    'plan-history-2', 'item', 'snapshot', 'workout', 'occurrence', 'set', 'set-history-1', 'set-history-2', 'transcript', 'stored-text',
    'promo-grant', 'receipt-unique', 'original', 'transaction', 'product', 'purchase-grant', 'observation-product', 'delivery']) {
    assert.ok(result.json.includes(`${marker}-a`), `missing own ${marker}`);
    assert.equal(result.json.includes(`${marker}-b`), false, `other account ${marker}`);
  }
  for (const secret of ['session-secret', 'password-secret', 'oauth-access-secret', 'oauth-refresh-secret', 'oauth-id-secret', 'otp-secret',
    'embedded-password-secret', 'transcript-key', 'transcript-private-hash', 'receipt-key', 'receipt-private-hash', 'private-promo-hash',
    'proof-private-hash', 'raw-jws-secret', 'observation-private-hash', 'delivery-private-hash', 'purchase-key',
    'receipt-jws-secret', 'receipt-status-secret', 'private-log-secret', 'auth-session-a', 'provider-subject', 'b@synthetic.invalid',
    'phone-binding-secret', 'phone-start-key', 'provider-sid-secret', 'phone-key', 'phone-intent-hash-secret'])
    assert.equal(result.json.includes(secret), false, `leaked ${secret}`);
  const payload = unpack(result.json);
  const counts = new Map(payload.manifest.categories.map(entry => [entry.category, entry.count]));
  assert.equal(counts.get('documents'), 4); assert.equal(counts.get('documentRevisions'), 8);
  assert.equal(counts.get('planRevisions'), 2); assert.equal(counts.get('setRevisions'), 2);
  assert.equal(counts.get('phoneChallengeHistory'), 1); assert.equal(counts.get('phoneOperationHistory'), 1);
  assert.ok(result.json.includes('+12025550111')); assert.equal(result.json.includes('+12025550112'), false);
  assert.ok(result.json.includes('a@synthetic.invalid'));
  assert.equal(result.json.includes('99887766'), false, 'unbound challenge cannot be attributed by phone alone');
  for (const entry of payload.manifest.categories)
    assert.equal(entry.count, payload.records.filter(record => record.category === entry.category).length);
  assert.equal(payload.manifest.complete, false);
  assert.ok(payload.manifest.omissions.length); assert.ok(payload.manifest.residuals.length);
  assert.equal(payload.manifest.provenance.consistency, 'single-connection-snapshot');
}));

test('existing lifecycle schema exports deletion metadata and excludes grants, hashes and internal evidence', () => fixture(db => {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='account_lifecycle'").get()) db.exec(lifecycleMigration.sql);
  for (const suffix of ['a', 'b']) {
    db.prepare('INSERT INTO account_deletion_requests(id,account_id,command_key,intent_hash,policy_version,phase,requested_at_ms,status_token_hash,status_token_expires_at_ms) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(`delete-${suffix}`, `form-${suffix}`, `delete-command-key-${suffix}`, `delete-intent-hash-${suffix}`, 'synthetic-policy',
        'awaiting_reauthentication', 1, `deletion-status-secret-hash-${suffix}`, 9999999999999);
    db.prepare('INSERT INTO account_deletion_steps VALUES (?,?,?,?,?,?,?)')
      .run(`delete-${suffix}`, 'syntheticCategory', 'pending', 'private-policy-ref', null, 'private-evidence-ref', 1);
    db.prepare('INSERT INTO account_action_grants VALUES (?,?,?,?,?,?,?,?,?)')
      .run(`action-grant-secret-hash-${suffix}`, `form-${suffix}`, `auth-session-${suffix}`, 0, 'account_export', 'password', 1, 9999999999999, null);
  }
  const result = buildAccountExport(db, context, () => {});
  const payload = unpack(result.json);
  const status = payload.manifest.categories.find(entry => entry.category === 'deletionStatus');
  assert.equal(status?.status, 'complete'); assert.equal(status?.count, 1);
  assert.ok(result.json.includes('delete-a')); assert.equal(result.json.includes('delete-b'), false);
  assert.ok(result.json.includes('awaiting_reauthentication'));
  for (const secret of ['delete-command-key', 'delete-intent-hash', 'deletion-status-secret-hash', 'private-policy-ref', 'private-evidence-ref', 'action-grant-secret-hash'])
    assert.equal(result.json.includes(secret), false, `leaked lifecycle ${secret}`);
  assert.equal(result.complete, false);
}));

test('exact adapter envelopes preserve safe Activity item snapshots, loads and targets without applying legacy item shape', () => fixture(db => {
  const data = { id: 'synthetic-activity-plan', items: [{ id: 'movement', exercise: { source: 'personal', id: 'personal-a' },
    snapshot: { name: 'Independent movement', measurementType: 'timed' }, load: { state: 'unknown', confirmed: true },
    target: { durationSeconds: 30, load: { state: 'not_applicable', confirmed: true } }, durationSeconds: 45 }] };
  const result = buildAccountExport(db, context, () => {}, [adapter('activity', 'complete', (_actor, snapshot) => {
    snapshot.append('activity', { kind: 'activity_plan_revisions', data });
    return { category: 'activity', status: 'complete' };
  })]);
  assert.deepEqual(unpack(result.json).records.find(record => record.category === 'activity')?.value,
    { kind: 'activity_plan_revisions', data });
}));

test('actual Activity service and adapter round-trip plan history through bounded account export losslessly', t => {
  const f = activityFixture(); t.after(() => f.db.close());
  const actor = f.contexts.A;
  const exercise = f.service.createExercise(actor, 'actual-export-exercise', personalFields).body as PersonalExercise;
  const plan = f.service.createPlan(actor, 'actual-export-plan', { name: 'Independent synthetic plan', items: [{ id: 'movement',
    exercise: { source: 'personal', id: exercise.id, revision: exercise.revision },
    target: { load: unknownLoad, durationSeconds: 30, setCount: 3, repMin: 8, repMax: 12 } }] }).body as ActivityPlanSnapshot;
  const result = buildAccountExport(f.db, actor, f.lifecycle.assertActive, [createActivityLifecycleAdapter(f.service)]);
  const records = unpack(result.json).records.filter(record => record.category === 'activity' &&
    ['activity_plans', 'activity_plan_revisions'].includes(record.value.kind as string));
  assert.equal(records.length, 2);
  for (const record of records) assert.deepEqual((record.value.data as ActivityPlanSnapshot).items, plan.items);
  assert.equal(result.bytes, Buffer.byteLength(result.json));
  assert.ok(result.bytes <= ACCOUNT_EXPORT_MAX_BYTES); assert.equal(result.complete, false);
});

test('export rejects mismatched mapping, pre-generation revocation and nested snapshots', () => fixture(db => {
  assert.throws(() => buildAccountExport(db, { ...context, authUserId: 'auth-b' }, () => {}),
    error => error instanceof DomainError && error.code === 'account_session_mismatch');
  assert.throws(() => buildAccountExport(db, context, () => { throw revoked(); }),
    error => error instanceof DomainError && error.code === 'account_disabled');
  assert.throws(() => db.transaction(() => buildAccountExport(db, context, () => {}))(),
    error => error instanceof DomainError && error.code === 'account_export_requires_outermost_snapshot');
  assert.equal(db.inTransaction, false);
}));

test('export fails without truncation for oversized records and aggregate JSON including escaping/manifest', () => fixture(db => {
  const baseline = buildAccountExport(db, context, () => {});
  assert.equal(buildAccountExport(db, context, () => {}, [], baseline.bytes).bytes, baseline.bytes);
  const isPackaging = (error: unknown) => error instanceof DomainError && error.status === 413 && error.code === 'account_export_packaging_required';
  assert.throws(() => buildAccountExport(db, context, () => {}, [], baseline.bytes - 1), isPackaging);
  assert.throws(() => buildAccountExport(db, context, () => {}, [adapter('synthetic.escape', 'complete', (_context, snapshot) => {
    snapshot.append('synthetic.escape', { text: '\u0000'.repeat(4096) });
    return { category: 'synthetic.escape', status: 'complete' };
  })], baseline.bytes + 1000), isPackaging);
  db.prepare('UPDATE documents SET data=? WHERE account_id=? AND kind=?')
    .run(JSON.stringify({ name: 'x'.repeat(4096) }), 'form-a', 'profile');
  assert.throws(() => buildAccountExport(db, context, () => {}, [], 2048), isPackaging);
  db.prepare('UPDATE documents SET data=? WHERE account_id=? AND kind=?')
    .run(JSON.stringify({ name: '\u0000'.repeat(4096) }), 'form-a', 'profile');
  assert.throws(() => buildAccountExport(db, context, () => {}, [], 20000), isPackaging);
  db.prepare('UPDATE "user" SET name=? WHERE id=?').run('x'.repeat(4096), 'auth-a');
  assert.throws(() => buildAccountExport(db, context, () => {}, [], 2048), isPackaging);
  assert.throws(() => buildAccountExport(db, context, () => {}, [], ACCOUNT_EXPORT_MAX_BYTES + 1),
    error => error instanceof DomainError && error.code === 'invalid_account_export_limit');
  assert.equal(db.inTransaction, false);
}));

test('export snapshot stays consistent across another writer and release rechecks outside snapshot', () => fixture((db, path) => {
  const other = new Database(path);
  try {
    let checks = 0;
    const privacy = adapter('privacyChoices', 'pending', (_context, snapshot) => {
      other.prepare('UPDATE "user" SET name=? WHERE id=?').run('revoked-marker', 'auth-a');
      snapshot.append('privacyChoices', { choice: 'synthetic-choice' });
      return { category: 'privacyChoices', status: 'pending' };
    });
    assert.throws(() => buildAccountExport(db, context, () => {
      assert.equal(db.inTransaction, false); checks++;
      const row = db.prepare('SELECT name FROM "user" WHERE id=?').get('auth-a') as { name: string };
      if (row.name === 'revoked-marker') throw revoked();
    }, [privacy]), error => error instanceof DomainError && error.code === 'account_disabled');
    assert.equal(checks, 2); assert.equal(db.inTransaction, false);
    other.prepare('UPDATE "user" SET name=? WHERE id=?').run('identity-before', 'auth-a');
    const result = buildAccountExport(db, context, () => {}, [adapter('privacyChoices', 'complete', (_context, snapshot) => {
      other.prepare('UPDATE documents SET data=? WHERE account_id=? AND kind=?').run('{"name":"changed-after-snapshot"}', 'form-a', 'profile');
      const inside = db.prepare('SELECT data FROM documents WHERE account_id=? AND kind=?').get('form-a', 'profile') as { data: string };
      snapshot.append('privacyChoices', { previous: JSON.parse(inside.data) as unknown });
      return { category: 'privacyChoices', status: 'complete' };
    })]);
    assert.equal(result.json.includes('changed-after-snapshot'), false);
    assert.ok(result.json.includes('profile-current-a'));
  } finally { other.close(); }
}));

test('adapter statuses and missing projections cannot produce complete claims', () => fixture(db => {
  db.prepare('INSERT INTO documents VALUES (?,?,0,?)').run('form-a', 'future-private-module', '{"text":"unqualified-private-content"}');
  const adapters = ['pending', 'unavailable', 'unknown', 'retained', 'complete'].map(status => adapter(`synthetic.${status}`,
    status as 'pending' | 'unavailable' | 'unknown' | 'retained' | 'complete', (_context, snapshot) => {
      snapshot.append(`synthetic.${status}`, { marker: status, password: 'adapter-password-secret', rawJWS: 'adapter-jws-secret', token: 'adapter-token-secret' });
      return { category: `synthetic.${status}`, status: status as 'pending' | 'unavailable' | 'unknown' | 'retained' | 'complete' };
    }));
  const result = buildAccountExport(db, context, () => {}, adapters);
  const payload = unpack(result.json);
  for (const status of ['pending', 'unavailable', 'unknown', 'retained', 'complete']) {
    const entry = payload.manifest.categories.find(value => value.category === `synthetic.${status}`);
    assert.equal(entry?.status, status); assert.equal(entry?.count, 1);
  }
  assert.equal(payload.manifest.categories.find(entry => entry.category === 'body')?.status, 'unavailable');
  assert.equal(payload.manifest.categories.find(entry => entry.category === 'documents')?.status, 'pending');
  assert.equal(result.json.includes('unqualified-private-content'), false);
  assert.equal(result.json.includes('adapter-password-secret'), false); assert.equal(result.json.includes('adapter-jws-secret'), false);
  assert.equal(result.json.includes('adapter-token-secret'), false);
  assert.equal(payload.manifest.complete, false);
  assert.throws(() => buildAccountExport(db, context, () => {}, [adapter('documents', 'complete')]),
    error => error instanceof DomainError && error.code === 'account_export_invalid_category');
  assert.throws(() => buildAccountExport(db, context, () => {}, [adapter('synthetic.bad', 'complete', (_context, snapshot) => {
    snapshot.append('documents', { name: 'forged' }); return { category: 'synthetic.bad', status: 'complete' };
  })]), error => error instanceof DomainError && error.code === 'account_export_invalid_category');
}));

// The capture content below is invented test data, not a configured production consent inventory.
function captureExportFixture(t: import('node:test').TestContext) {
  const f = captureAccountFixture(); t.after(f.close);
  const domain = new Domain(f.db), writer = createCanonicalAccountWriter(f.db);
  const host = createConfirmedCaptureHost(domain, writer, { readWithinWrite: () => ({
    inventory: { id: 'synthetic', revision: '1', source: { id: 'test', revision: '1', locator: 'fixture:only',
      qualification: 'qualified', currentness: 'current' },
    questions: [{ id: 'literal', revision: '1', prompt: '  Exact synthetic prompt  ', kind: 'text', required: true }],
    consent: { id: 'consent', revision: '1', text: '  Exact synthetic consent  ' } },
    permission: { id: 'permission', revision: '1', inventoryId: 'synthetic', inventoryRevision: '1',
      statementId: 'consent', statementRevision: '1', decision: 'granted', retention: 'retain_confirmed_capture_and_history' },
  }) });
  const confirm = (literal: string, key: string) => {
    const review = host.review(f.one); if (review.status !== 'ready') throw new Error('synthetic review missing');
    return host.confirm(f.one, key, { review: review.review, payload: {
      answers: [{ questionId: 'literal', questionRevision: '1', response: { state: 'answered', literal } }], facts: [],
      restrictionInventory: { response: { state: 'no', literal: 'No reported instructions' }, instructionIds: [] },
      consent: { decision: 'granted', statementId: 'consent', statementRevision: '1' },
    } });
  };
  return { ...f, domain, writer, confirm, export: (limit?: number) => buildAccountExport(f.db, f.one,
    () => writer.lifecycle.assertActive(f.one), [], limit) };
}

test('typed capture exports current, immutable history and original receipt losslessly without private actor authority', t => {
  const f = captureExportFixture(t);
  const first = f.confirm('  Original literal  ', 'one'), second = f.confirm('  Corrected literal  ', 'two');
  const result = unpack(f.export().json);
  const current = result.records.find(row => row.category === 'documents' && row.value.kind === confirmedCaptureKind)!;
  assert.deepEqual(current.value.data, second.capture);
  const history = result.records.filter(row => row.category === 'documentRevisions' && row.value.kind === confirmedCaptureKind)
    .sort((a, b) => Number(a.value.revision) - Number(b.value.revision));
  assert.deepEqual(history.map(row => row.value.data), [first.capture, second.capture]);
  const receipts = result.records.filter(row => row.category === 'operationHistory' && row.value.operation === confirmedCaptureOperation);
  assert.deepEqual(receipts.map(row => row.value.result), [first, second]);
  const serialized = JSON.stringify([...history, current, ...receipts]);
  for (const key of ['privateContext', 'authUserId', 'sessionId', 'epoch']) assert.equal(serialized.includes(`"${key}"`), false);
  assert.ok(serialized.includes(first.capture.pin.accountId));
  assert.ok(serialized.includes(first.capture.confirmation.id));
  assert.throws(() => f.export(512), error => error instanceof DomainError && error.code === 'account_export_packaging_required');
});

test('invalid typed capture history or receipt aborts export while unknown kinds remain omitted', t => {
  const f = captureExportFixture(t), receipt = f.confirm('literal', 'one');
  f.db.prepare('INSERT INTO documents VALUES(?,?,0,?)').run(f.one.accountId, 'unknown-sensitive-kind', '{"text":"do-not-export"}');
  assert.equal(f.export().json.includes('do-not-export'), false);
  f.db.prepare('UPDATE command_receipts SET result=? WHERE account_id=? AND operation=?')
    .run(JSON.stringify({ ...receipt, capture: { ...receipt.capture, privateContext: { sessionId: 'private-session' } } }), f.one.accountId, confirmedCaptureOperation);
  assert.throws(() => f.export(), error => error instanceof DomainError && error.code === 'account_export_invalid_data');
  f.db.prepare('UPDATE command_receipts SET result=? WHERE account_id=? AND operation=?')
    .run(JSON.stringify(receipt), f.one.accountId, confirmedCaptureOperation);
  const original = f.domain.confirmedCapture(f.one.accountId)!;
  f.db.prepare('INSERT INTO document_revisions VALUES(?,?,?,?,?)').run(f.one.accountId, confirmedCaptureKind, 1,
    JSON.stringify({ ...original.record, pin: { ...original.record.pin, digest: '0'.repeat(64) } }), date);
  assert.throws(() => f.export(), error => error instanceof DomainError && error.code === 'account_export_invalid_data');
});

test('draft-bound capture exports full digest bindings and exact literal replacement history without session authority', t => {
  const f = captureAccountFixture(); t.after(f.close);
  const domain = new Domain(f.db), writer = createCanonicalAccountWriter(f.db);
  // This memory fixture supplies synthetic consent authority only, not an operational privacy attestation.
  const host = createConfirmedCaptureHost(domain, writer, createR1CaptureContentPort(actor => {
    writer.assertWithinWrite(actor); assert.deepEqual(actor, f.one);
    return { contentDigest: r1IntakeContentDigest,
      source: { id: 'synthetic-r1-source', revision: '1', locator: 'fixture:export', qualification: 'qualified', currentness: 'current' },
      permission: { id: 'synthetic-r1-permission', revision: '1', inventoryId: r1IntakeDefinition.id,
        inventoryRevision: r1IntakeDefinition.revision, statementId: r1IntakeDefinition.consent.id,
        statementRevision: r1IntakeDefinition.consent.revision, decision: 'granted', retention: 'retain_confirmed_capture_and_history' },
      assertCurrent() {}, assertPrivateCaptureOnly() {} };
  }));
  const confirm = (literal: string, key: string) => {
    const payload = { answers: [{ questionId: 'form.r1.T01', questionRevision: '1', response: { state: 'no', literal } }],
      facts: [], restrictionInventory: { response: { state: 'no', literal: 'No reported instructions' }, instructionIds: [] },
      consent: { decision: 'granted', statementId: r1IntakeDefinition.consent.id, statementRevision: r1IntakeDefinition.consent.revision } };
    const reviewed = host.review(f.one, payload);
    if (reviewed.status !== 'ready') throw new Error('synthetic R1 review unavailable');
    return host.confirm(f.one, key, { review: reviewed.review, payload });
  };
  const first = confirm('  Original no.  ', 'first'), second = confirm('  Corrected no.  ', 'second');
  assert.notEqual(first.capture.contentBinding!.bindingDigest, second.capture.contentBinding!.bindingDigest);
  assert.deepEqual(first.capture.inventory, second.capture.inventory);
  const result = unpack(buildAccountExport(f.db, f.one, () => writer.lifecycle.assertActive(f.one), []).json);
  const current = result.records.find(row => row.category === 'documents' && row.value.kind === confirmedCaptureKind)!;
  const history = result.records.filter(row => row.category === 'documentRevisions' && row.value.kind === confirmedCaptureKind)
    .sort((a, b) => Number(a.value.revision) - Number(b.value.revision));
  const receipts = result.records.filter(row => row.category === 'operationHistory' && row.value.operation === confirmedCaptureOperation);
  assert.deepEqual(current.value.data, second.capture);
  assert.deepEqual(history.map(row => row.value.data), [first.capture, second.capture]);
  assert.deepEqual(receipts.map(row => row.value.result), [first, second]);
  const serialized = JSON.stringify([current, ...history, ...receipts]);
  for (const field of ['privateContext', 'authUserId', 'sessionId', 'epoch']) assert.equal(serialized.includes(`"${field}"`), false);
  assert.ok(serialized.includes(first.capture.contentBinding!.contentDigest));
  assert.ok(serialized.includes(first.capture.confirmation.id));
  for (const contentBinding of [
    { ...first.capture.contentBinding!, captureDigest: '0'.repeat(64) },
    { ...first.capture.contentBinding!, sessionId: 'must-not-export' },
  ]) {
    f.db.prepare('UPDATE command_receipts SET result=? WHERE account_id=? AND operation=? AND key=?')
      .run(JSON.stringify({ ...first, capture: { ...first.capture, contentBinding } }), f.one.accountId, confirmedCaptureOperation, 'first');
    assert.throws(() => buildAccountExport(f.db, f.one, () => writer.lifecycle.assertActive(f.one), []),
      error => error instanceof DomainError && error.code === 'account_export_invalid_data');
  }
});


import { bindSuppressionAuthority } from '../src/lifecycle/guards.js';

function boundCaptureExportFixture(t: import('node:test').TestContext) {
  const f = captureAccountFixture(); t.after(f.close);
  const domain = new Domain(f.db), writer = createCanonicalAccountWriter(f.db);
  const host = createConfirmedCaptureHost(domain, writer, createR1CaptureContentPort(actor => {
    writer.assertWithinWrite(actor); assert.deepEqual(actor, f.one);
    return { contentDigest: r1IntakeContentDigest,
      source: { id: 'synthetic-bound-export', revision: '1', locator: 'fixture:bound-export', qualification: 'qualified', currentness: 'current' },
      permission: { id: 'synthetic-permission', revision: '1', inventoryId: r1IntakeDefinition.id,
        inventoryRevision: r1IntakeDefinition.revision, statementId: r1IntakeDefinition.consent.id,
        statementRevision: r1IntakeDefinition.consent.revision, decision: 'granted', retention: 'retain_confirmed_capture_and_history' },
      assertCurrent() {}, assertPrivateCaptureOnly() {} };
  }));
  const confirm = (literal: string, key: string) => {
    const payload = { answers: [{ questionId: 'form.r1.T01', questionRevision: '1', response: { state: 'no', literal } }],
      facts: [], restrictionInventory: { response: { state: 'no', literal: 'No reported instructions' }, instructionIds: [] },
      consent: { decision: 'granted', statementId: r1IntakeDefinition.consent.id, statementRevision: r1IntakeDefinition.consent.revision } };
    const review = host.review(f.one, payload);
    if (review.status !== 'ready') throw new Error('Synthetic bound review unavailable');
    return host.confirm(f.one, key, { review: review.review, payload });
  };
  return { ...f, domain, writer, confirm, export: (adapters: readonly LifecycleAdapter[] = [], limit?: number) =>
    buildAccountExport(f.db, f.one, () => writer.lifecycle.assertActive(f.one), adapters, limit) };
}

test('validated binding paths retain all four digests in current capture, two revisions and two receipts', t => {
  const f = boundCaptureExportFixture(t);
  const first = f.confirm('  First exact answer.  ', 'first'), second = f.confirm('  Corrected exact answer.  ', 'second');
  const exported = f.export(), result = unpack(exported.json);
  const current = result.records.filter(row => row.category === 'documents' && row.value.kind === confirmedCaptureKind);
  const history = result.records.filter(row => row.category === 'documentRevisions' && row.value.kind === confirmedCaptureKind)
    .sort((a, b) => Number(a.value.revision) - Number(b.value.revision));
  const receipts = result.records.filter(row => row.category === 'operationHistory' && row.value.operation === confirmedCaptureOperation);
  assert.equal(current.length, 1); assert.equal(history.length, 2); assert.equal(receipts.length, 2);
  assert.deepEqual(current[0]!.value.data, second.capture);
  assert.deepEqual(history.map(row => row.value.data), [first.capture, second.capture]);
  assert.deepEqual(receipts.map(row => row.value.result), [first, second]);
  for (const capture of [first.capture, second.capture]) {
    assert.ok(capture.contentBinding);
    for (const field of ['contentDigest', 'inventoryDigest', 'captureDigest', 'bindingDigest'] as const)
      assert.match(capture.contentBinding[field], /^[a-f0-9]{64}$/);
  }
  const firstBinding = first.capture.contentBinding, secondBinding = second.capture.contentBinding;
  assert.ok(firstBinding && secondBinding);
  assert.equal(firstBinding.contentDigest, secondBinding.contentDigest);
  assert.equal(firstBinding.inventoryDigest, secondBinding.inventoryDigest);
  assert.notEqual(firstBinding.captureDigest, secondBinding.captureDigest);
  assert.notEqual(firstBinding.bindingDigest, secondBinding.bindingDigest);
  const publicRecords = JSON.stringify([...current, ...history, ...receipts]);
  for (const field of ['privateContext', 'actor', 'authUserId', 'sessionId', 'epoch', 'profile', 'preferences'])
    assert.equal(publicRecords.includes(`"${field}"`), false);
  assert.equal(exported.bytes, Buffer.byteLength(exported.json));
});

test('matching capture schemas and binding keys in generic receipts, unknown kinds and adapters gain no preservation', t => {
  const f = boundCaptureExportFixture(t), receipt = f.confirm('Exact answer', 'original');
  const stored = f.domain.confirmedCapture(f.one.accountId)!;
  f.db.prepare('INSERT INTO documents VALUES(?,?,0,?)')
    .run(f.one.accountId, 'unrecognized-capture-kind', JSON.stringify(stored.record));
  f.db.prepare('INSERT INTO command_receipts(account_id,operation,key,intent_hash,status,result,created_at) VALUES(?,?,?,?,?,?,?)')
    .run(f.one.accountId, 'unrecognized:capture', 'unrelated', 'synthetic-intent', 201, JSON.stringify(receipt), date);
  const shape = { ...receipt, contentBinding: receipt.capture.contentBinding, bindingDigest: 'unrelated-binding',
    items: [{ contentBinding: receipt.capture.contentBinding, bindingDigest: 'nested-binding' }],
    nested: { capture: receipt.capture, contentBinding: receipt.capture.contentBinding } };
  const result = unpack(f.export([adapter('synthetic.capture', 'complete', (_actor, snapshot) => {
    snapshot.append('synthetic.capture', shape);
    return { category: 'synthetic.capture', status: 'complete' };
  })]).json);
  assert.equal(result.records.some(row => row.value.kind === 'unrecognized-capture-kind'), false);
  assert.equal(result.manifest.categories.find(row => row.category === 'documents')?.status, 'pending');
  const unrelated = result.records.find(row => row.category === 'operationHistory' && row.value.operation === 'unrecognized:capture')!;
  const adapted = result.records.find(row => row.category === 'synthetic.capture')!;
  for (const row of [unrelated, adapted]) {
    const json = JSON.stringify(row);
    assert.equal(json.includes('"contentBinding"'), false); assert.equal(json.includes('"bindingDigest"'), false);
  }
  const withoutBinding = { ...receipt.capture }; delete withoutBinding.contentBinding;
  assert.deepEqual(adapted.value.capture, withoutBinding);
  assert.deepEqual(result.records.find(row => row.category === 'operationHistory' && row.value.operation === confirmedCaptureOperation)!.value.result, receipt);
});

test('invalid binding or extra private payload in each selected capture location aborts export rather than filtering into validity', t => {
  const f = boundCaptureExportFixture(t), initialState = f.db.serialize();
  f.confirm('Exact answer', 'original');
  const baseline = unpack(f.export().json).records;
  const current = f.db.prepare('SELECT account_id,kind,revision,data FROM documents WHERE account_id=? AND kind=?')
    .raw().get(f.one.accountId, confirmedCaptureKind) as [string, string, number, string];
  const history = f.db.prepare('SELECT account_id,kind,revision,data,created_at FROM document_revisions WHERE account_id=? AND kind=? AND revision=?')
    .raw().get(f.one.accountId, confirmedCaptureKind, current[2]) as [string, string, number, string, string];
  const receipt = f.db.prepare('SELECT account_id,operation,key,intent_hash,status,result,created_at FROM command_receipts WHERE account_id=? AND operation=? AND key=?')
    .raw().get(f.one.accountId, confirmedCaptureOperation, 'original') as [string, string, string, string, number, string, string];
  const originalHistory = JSON.parse(history[3]) as { privateContext: { actor: AccountContext }; pin: { accountId: string; revision: string } };
  assert.deepEqual(originalHistory.privateContext.actor, f.one);
  assert.equal(originalHistory.pin.accountId, f.one.accountId);
  assert.equal(originalHistory.pin.revision, String(history[2]));
  assert.deepEqual(history.slice(0, 4), current);
  assert.equal(receipt[0], f.one.accountId);
  const seedHistory = (data: string) => {
    const db: Sqlite = new Database(initialState); t.after(() => db.close());
    db.pragma('foreign_keys = ON'); bindSuppressionAuthority(db, f.ledger);
    const writer = createCanonicalAccountWriter(db);
    writer.lifecycle.assertActive(f.one);
    assert.equal(db.prepare('SELECT 1 FROM documents WHERE account_id=? AND kind=?').get(f.one.accountId, confirmedCaptureKind), undefined);
    assert.equal(db.prepare('SELECT 1 FROM document_revisions WHERE account_id=? AND kind=?').get(f.one.accountId, confirmedCaptureKind), undefined);
    const inserted: typeof history = [history[0], history[1], history[2], data, history[4]];
    assert.equal((JSON.parse(data) as { pin: { revision: string } }).pin.revision, String(inserted[2]));
    db.prepare('INSERT INTO documents(account_id,kind,revision,data) VALUES(?,?,?,?)').run(...current);
    db.prepare('INSERT INTO command_receipts(account_id,operation,key,intent_hash,status,result,created_at) VALUES(?,?,?,?,?,?,?)').run(...receipt);
    db.prepare('INSERT INTO document_revisions(account_id,kind,revision,data,created_at) VALUES(?,?,?,?,?)').run(...inserted);
    assert.deepEqual(db.prepare('SELECT account_id,kind,revision,data,created_at FROM document_revisions WHERE account_id=? AND kind=? AND revision=?')
      .raw().get(history[0], history[1], history[2]), inserted);
    return { db, export: () => buildAccountExport(db, f.one, () => writer.lifecycle.assertActive(f.one), []) };
  };
  const control = seedHistory(history[3]);
  assert.deepEqual(unpack(control.export().json).records, baseline);
  assert.equal(control.db.inTransaction, false);
  for (const data of [history[3], JSON.stringify({ ...originalHistory, unexpected: 'must-not-replace-history' })]) {
    assert.throws(() => f.db.prepare('UPDATE document_revisions SET data=? WHERE account_id=? AND kind=? AND revision=?')
      .run(data, history[0], history[1], history[2]), /immutable_document_history/);
    assert.deepEqual(f.db.prepare('SELECT account_id,kind,revision,data,created_at FROM document_revisions WHERE account_id=? AND kind=? AND revision=?')
      .raw().get(history[0], history[1], history[2]), history);
    assert.deepEqual(unpack(f.export().json).records, baseline);
    assert.equal(f.db.inTransaction, false);
  }
  const locations = [
    { table: 'documents', column: 'data', where: 'account_id=? AND kind=?', args: [f.one.accountId, confirmedCaptureKind] },
    { table: 'document_revisions', column: 'data', where: 'account_id=? AND kind=? AND revision=?', args: [f.one.accountId, confirmedCaptureKind, 0] },
    { table: 'command_receipts', column: 'result', where: 'account_id=? AND operation=? AND key=?', args: [f.one.accountId, confirmedCaptureOperation, 'original'] },
  ];
  type TamperedCapture = { contentBinding: Record<string, unknown>; payload: Record<string, unknown>; pin: { accountId: string } };
  const changes: readonly ((capture: TamperedCapture) => void)[] = [
    capture => { capture.contentBinding.captureDigest = '0'.repeat(64); },
    capture => { capture.contentBinding.bindingDigest = 'invalid-digest'; },
    capture => { capture.contentBinding.sessionId = 'private-session-marker'; },
    capture => { capture.payload.privateContext = { profile: 'private-profile-marker' }; },
    capture => { capture.pin.accountId = f.two.accountId; },
  ];
  for (const location of locations) {
    const row = f.db.prepare(`SELECT ${location.column} AS value FROM ${location.table} WHERE ${location.where}`)
      .get(...location.args) as { value: string };
    for (const change of changes) {
      const value = JSON.parse(row.value) as { capture?: TamperedCapture } & TamperedCapture;
      change(location.table === 'command_receipts' ? value.capture! : value);
      if (location.table === 'document_revisions') {
        const seeded = seedHistory(JSON.stringify(value));
        assert.throws(() => seeded.export(), error => error instanceof DomainError && error.code === 'account_export_invalid_data');
        assert.equal(seeded.db.inTransaction, false);
        continue;
      }
      try {
        f.db.prepare(`UPDATE ${location.table} SET ${location.column}=? WHERE ${location.where}`)
          .run(JSON.stringify(value), ...location.args);
        assert.throws(() => f.export(), error => error instanceof DomainError && error.code === 'account_export_invalid_data');
        assert.equal(f.db.inTransaction, false);
      } finally {
        f.db.prepare(`UPDATE ${location.table} SET ${location.column}=? WHERE ${location.where}`).run(row.value, ...location.args);
      }
    }
  }
  assert.ok(f.export().bytes > 0);
});

test('preserved capture bindings remain inside aggregate byte and depth limits without partial release', t => {
  const f = boundCaptureExportFixture(t);
  const first = f.confirm('  Original literal.  ', 'one'); f.confirm('  Corrected literal.  ', 'two');
  const baseline = f.export();
  assert.ok(baseline.json.includes(first.capture.contentBinding!.bindingDigest));
  assert.equal(f.export([], baseline.bytes).bytes, baseline.bytes);
  const packaging = (error: unknown) => error instanceof DomainError && error.status === 413 && error.code === 'account_export_packaging_required';
  assert.throws(() => f.export([], baseline.bytes - 1), packaging);
  assert.throws(() => f.export([], 512), packaging);
  let nested: unknown = { capture: first.capture, contentBinding: first.capture.contentBinding };
  for (let depth = 0; depth < 65; depth++) nested = { nested };
  assert.throws(() => f.export([adapter('synthetic.depth', 'complete', (_actor, snapshot) => {
    snapshot.append('synthetic.depth', nested);
    return { category: 'synthetic.depth', status: 'complete' };
  })]), packaging);
  assert.equal(f.db.inTransaction, false);
  assert.equal(f.export().bytes, baseline.bytes);
});
