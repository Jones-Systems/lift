import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import Database from 'better-sqlite3';
import { Domain } from '../../src/domain.ts';
import { DomainError } from '../../src/errors.ts';
import { activityMigration } from '../../src/activity/migration.ts';
import { communityMigration } from '../../src/community/migration.ts';
import { communityExtensionMigration } from '../../src/community/extension-migration.ts';
import { featureBoardMigrationVersion, featureBoardMigrationSql } from '../../src/community/board/migration.ts';
import { composeAccountMigrations } from '../../src/lifecycle/composition.ts';
import { bindSuppressionAuthority } from '../../src/lifecycle/guards.ts';
import { createCanonicalAccountWriter } from '../../src/integration/account-modules/canonical-writer.ts';
import { createSourceAccountModules } from '../../src/integration/account-modules/index.ts';
import { createProgressComparisonService } from '../../src/progress-comparison/service.ts';
import { progressComparisonMigrationSql } from '../../src/progress-comparison/migration.ts';
import { feedbackMigrationSql, feedbackOwnedTables } from '../../src/training-feedback/migration.ts';
import { createTrainingFeedbackRoutes } from '../../src/training-feedback/routes.ts';
import { trainingFeedbackHttpLimits } from '../../src/training-feedback/request-schema.ts';

const prefix = '/v1/training-feedback';
const refs = [{ sourceId: 'synthetic-feedback', revision: '1', locator: 'http.test.mjs', qualification: 'Synthetic reported input; no clinical authority' }];
function fixture(t) {
  const db = new Database(':memory:'); t.after(() => db.close()); db.pragma('foreign_keys = ON');
  for (const migration of composeAccountMigrations(activityMigration, communityMigration,
    { extension: communityExtensionMigration, board: { version: featureBoardMigrationVersion, sql: featureBoardMigrationSql } })) db.exec(migration.sql);
  db.exec(progressComparisonMigrationSql); db.exec(feedbackMigrationSql);
  bindSuppressionAuthority(db, { currentSequence: () => 0, lookup: () => null, reconcileRestore: () => 0,
    recordDisable() { throw new Error('No synthetic suppression writer'); } });
  const domain = new Domain(db), writer = createCanonicalAccountWriter(db);
  const actors = ['primary', 'foreign'].map(id => {
    db.prepare('INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,?,?,1,0,0)').run(id, id, `${id}@fixture.invalid`);
    const accountId = domain.account(id, id);
    db.prepare('INSERT INTO session(id,userId,token,expiresAt,createdAt,updatedAt) VALUES (?,?,?,?,0,0)').run(id, id, `synthetic-${id}`, 8_000_000_000_000);
    return { accountId, authUserId: id, sessionId: id, epoch: 0 };
  });
  const [actor, other] = actors;
  db.prepare('INSERT INTO exercises VALUES (?,?,0)').run('fixture-exercise', JSON.stringify({ id: 'fixture-exercise', name: 'Synthetic exercise', cues: [] }));
  const planFor = owner => domain.createPlan(owner.accountId, { name: 'Fixture plan', minutes: 30,
    items: [{ id: 'fixture-item', exerciseId: 'fixture-exercise', setTarget: 1, repMin: 4, repMax: 8, targetKg: 10 }] });
  const plan = planFor(actor), otherPlan = planFor(other);
  const sessionFor = (owner, selectedPlan, reps) => {
    const session = domain.startSession(owner.accountId, selectedPlan.id, selectedPlan.revision);
    domain.createSet(owner.accountId, session.id, { occurrenceId: session.occurrences[0].id, expectedRevision: 1,
      setNumber: 1, reps, weightKg: 10, status: 'confirmed' });
    return domain.completeSession(owner.accountId, session.id, 2);
  };
  const sessions = [sessionFor(actor, plan, 5), sessionFor(actor, plan, 7)], foreignSession = sessionFor(other, otherPlan, 6);
  const selections = { baseline: { kind: 'session', id: sessions[0].id, itemId: sessions[0].occurrences[0].id },
    current: { kind: 'session', id: sessions[1].id, itemId: sessions[1].occurrences[0].id } };
  const progress = createProgressComparisonService({ db, domain, lifecycleControl: writer,
    assertIdentityAllowed: candidate => writer.lifecycle.assertActive(candidate), assertPersistable: candidate => writer.lifecycle.assertActive(candidate),
    comparisonBindingFor: () => null });
  for (const [side, source] of Object.entries(selections)) progress.confirm(actor, `fixture-${side}`, { source,
    expectedSourceRevision: domain.session(actor.accountId, source.id).revision, expectedBindingRevision: 0,
    identity: { variantId: 'synthetic', equipmentId: 'synthetic', laterality: 'bilateral', loadBasis: 'total' },
    provenance: { kind: 'user_reported' }, confirmed: true });
  let retained = true, onRetain = () => {}, contextCalls = 0, onCapture = () => {}, principal = { ...actor };
  const training = createSourceAccountModules(db, writer.lifecycle, { domain, writer,
    registrationWithinWrite(candidate, current) {
      writer.assertWithinWrite(candidate);
      const scope = { kind: 'context', contextId: current.contextId };
      return { derivations: [
        { id: 'observed', version: '1', kind: 'history', scope, sourceIds: ['feedback'], dependsOn: [], sourceRefs: refs,
          qualifications: ['Synthetic observed work only'], comparisonIds: ['work'], compute({ comparisons }) { return comparisons.work.result.delta.repetitions; } },
        { id: 'summary', version: '1', kind: 'summary', scope, sourceIds: [], dependsOn: ['observed'], sourceRefs: refs,
          qualifications: ['Synthetic summary'], compute({ parents }) { return parents[0].value; } },
        { id: 'later', version: '1', kind: 'recommendation', scope, sourceIds: [], dependsOn: ['summary'], sourceRefs: refs,
          qualifications: ['No prescription rule'], compute() { throw new Error('Rule unavailable'); } },
      ], comparisonRegistry: { schema: 'feedback-comparison-inputs-v1', version: 'fixture-1', inputs: [
        { id: 'work', contextId: current.contextId, selections },
      ] }, derivationAuthorityWithinWrite: (_ctx, recipe) => recipe.id !== 'later',
      comparisonBindingFor: (ctx, record) => { writer.assertWithinWrite(ctx); return {
        source: record.source, revision: record.revision, confirmed: true, identity: record.data.identity,
      }; } };
    },
    retentionAllowedWithinWrite(candidate, request) { writer.assertWithinWrite(candidate); onRetain(request); return retained; },
  }).trainingFeedback;
  const appFor = (service = training) => {
    const app = new Hono();
    // This injected fixture principal is not the production signed-auth middleware.
    app.use('*', (c, next) => { c.set('actor', principal); return next(); });
    app.route(prefix, createTrainingFeedbackRoutes({ context(c) { contextCalls++; onCapture(); return c.get('actor'); },
      assertActive: candidate => writer.lifecycle.assertActive(candidate), training: service }));
    return app;
  };
  const app = appFor();
  const json = async (method, path, value, key, chosenApp = app) => {
    const suffix = path === '/' || path.startsWith('/?') ? path.slice(1) : path;
    const response = await chosenApp.request(`http://fixture.invalid${prefix}${suffix}`, { method,
      headers: { 'Content-Type': 'application/json', ...(key === undefined ? {} : { 'Idempotency-Key': key }) },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
    return { response, body: await response.json() };
  };
  let sequence = 0;
  const command = async kind => {
    const view = await json('GET', '/'); assert.equal(view.response.status, 200);
    const scope = { kind: 'context', contextId: view.body.analysis.contextId };
    const selection = { sessionId: sessions[1].id, occurrenceId: sessions[1].occurrences[0].id };
    const witness = await json('POST', '/witness', { scope, selection }); assert.equal(witness.response.status, 200);
    const eventId = `event-${++sequence}`, event = { eventId, recordId: 'feedback', expectedRevision: view.body.result.records[0]?.revision ?? 0, kind };
    if (kind === 'record' || kind === 'correct') event.content = { scope, sourceRefs: structuredClone(refs), qualifications: ['Reported, not clinical'],
      payload: { kind: 'feedback', signals: [{ dimension: 'effort', state: 'reported', value: 0, unit: null, scale: null },
        { dimension: 'discomfort', state: 'missing', reason: 'not-reported' }] } };
    return { expectedLedgerRevision: view.body.result.ledgerRevision, event, selection, expectedWitness: witness.body.result };
  };
  const issue = async request => json('POST', '/events', request, request.event.eventId);
  const seed = async () => {
    const first = await command('record'); assert.equal((await issue(first)).body.result.receipt.outcome, 'changed');
    const confirmation = await command('confirm'), confirmed = await issue(confirmation);
    assert.equal(confirmed.response.status, 200); assert.equal(confirmed.body.result.receipt.outcome, 'changed');
    return { first, confirmation, confirmed };
  };
  const dump = () => feedbackOwnedTables.map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY account_id`).all()]);
  const changeGoals = () => domain.patchDocument(actor.accountId, 'profile', {
    expectedRevision: domain.document(actor.accountId, 'profile').revision, goals: ['Explicit changed fixture goal'],
  });
  return { db, domain, writer, actor, other, sessions, foreignSession, plan, selections, training, app, appFor, json, command, issue, seed, dump, changeGoals,
    denyRetention: () => { retained = false; }, onRetain: effect => { onRetain = effect; }, captures: () => contextCalls,
    onCapture: effect => { onCapture = effect; }, replacePrincipal: value => { Object.assign(principal, value); principal = { ...value }; },
    revoke: () => db.prepare('DELETE FROM session WHERE id=?').run(actor.sessionId) };
}
function blocked(view) { assert.ok(view.derivations.every(result => result.status === 'blocked' && result.value === null)); }
function observed(view) { return view.derivations.find(result => result.id === 'observed'); }

test('HTTP captures a witness, confirms explicit feedback and revalidates minimal same-key receipts after source correction', async t => {
  const f = fixture(t), { confirmation, confirmed } = await f.seed();
  const view = confirmed.body.result.current;
  assert.equal(observed(view).value, 2); assert.equal(view.derivations.find(result => result.id === 'later').status, 'blocked');
  assert.equal(view.records[0].content.payload.signals[0].value, 0); assert.equal(view.records[0].content.payload.signals[1].state, 'missing');
  assert.equal(confirmed.body.analysis.basis, 'current_profile_and_goals');
  const session = f.sessions[0], set = session.sets[0];
  f.domain.patchSet(f.actor.accountId, session.id, set.id, { expectedRevision: 1, reps: 6, weightKg: 10, status: 'confirmed' });
  const replay = await f.issue(confirmation); assert.equal(replay.response.status, 200);
  assert.deepEqual(replay.body.result.receipt, confirmed.body.result.receipt); assert.equal(replay.body.result.replayed, true);
  blocked(replay.body.result.current); assert.equal(replay.body.result.current.ledgerRevision, 2);
  assert.equal(JSON.stringify(replay.body.result.receipt).includes('signals'), false);
  const stored = JSON.parse(f.db.prepare('SELECT data FROM feedback_projections WHERE account_id=?').get(f.actor.accountId).data);
  blocked(stored); assert.equal(replay.response.headers.get('cache-control'), 'no-store');
});

test('current goal correction blocks an old confirmed witness without promoting or silently reconfirming feedback', async t => {
  const f = fixture(t), { confirmation, confirmed } = await f.seed(); f.changeGoals();
  const replay = await f.issue(confirmation); assert.deepEqual(replay.body.result.receipt, confirmed.body.result.receipt);
  assert.equal(replay.body.analysis.profileRevision, 1); blocked(replay.body.result.current);
  const freshConfirmation = await f.command('confirm'), rejected = await f.issue(freshConfirmation);
  assert.equal(rejected.body.result.receipt.reason, 'source-witness-conflict');
  assert.equal(rejected.body.result.current.ledgerRevision, 2);
});

test('correct, confirm, withdraw and undo retain revision-bound lifecycle behavior through HTTP', async t => {
  const f = fixture(t); await f.seed();
  const correction = await f.command('correct'); correction.event.content.payload.signals[0].value = 'revised self report';
  const changed = await f.issue(correction); assert.equal(changed.body.result.current.records[0].confirmed, false);
  await f.issue(await f.command('confirm'));
  const withdrawal = await f.command('withdraw'), withdrawn = await f.issue(withdrawal); blocked(withdrawn.body.result.current);
  const undo = await f.command('undo'); undo.event.targetEventId = withdrawal.event.eventId;
  const restored = await f.issue(undo); assert.equal(restored.body.result.current.records[0].confirmed, false);
  assert.equal(restored.body.result.current.records[0].revision, 6); blocked(restored.body.result.current);
});

test('client actor, authority, recipe, delete and unknown query fields are rejected before any ledger write', async t => {
  const f = fixture(t), request = await f.command('record'), before = f.dump();
  const forged = [
    { ...request, accountId: f.other.accountId }, { ...request, actor: f.other }, { ...request, derivations: [] },
    { ...request, authority: true }, { ...request, comparisonRegistry: {} }, { ...request, idempotencyKey: 'body-key' },
    { ...request, event: { ...request.event, accountId: f.other.accountId } },
    { ...request, event: { ...request.event, authority: true } },
    { ...request, event: { eventId: 'delete', recordId: 'feedback', expectedRevision: 0, kind: 'delete' } },
    { ...request, expectedWitness: { ...request.expectedWitness, trusted: true } },
    { ...request, selection: { ...request.selection, accountId: f.other.accountId } },
  ];
  for (const value of forged) assert.equal((await f.json('POST', '/events', value, 'request-key')).response.status, 422);
  for (const [method, path, value] of [['GET', '/?accountId=foreign'], ['POST', '/witness?scope=all', {}], ['POST', '/events?extra=1', request]])
    assert.equal((await f.json(method, path, value, 'request-key')).response.status, 422);
  assert.deepEqual(f.dump(), before);
  for (const path of ['/invalidate', '/identity', '/delete']) {
    const response = await f.app.request(`http://fixture.invalid${prefix}${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    assert.equal(response.status, 404); assert.equal(await response.text(), '404 Not Found');
  }
});

test('foreign selectors and forged expected witness account IDs cannot borrow another account source', async t => {
  const f = fixture(t), request = await f.command('record'), before = f.dump();
  const foreign = { sessionId: f.foreignSession.id, occurrenceId: f.foreignSession.occurrences[0].id };
  const denied = await f.json('POST', '/witness', { scope: request.event.content.scope, selection: foreign });
  assert.equal(denied.response.status, 404); assert.deepEqual(denied.body, { error: { code: 'not_found' } });
  const forged = structuredClone(request); forged.expectedWitness.sessionSource.source.accountId = f.other.accountId;
  const rejected = await f.issue(forged); assert.equal(rejected.body.result.receipt.reason, 'source-witness-conflict');
  assert.equal(rejected.body.result.current.ledgerRevision, 0); assert.equal(rejected.body.result.current.records.length, 0);
  assert.deepEqual(f.dump().find(([table]) => table === 'feedback_events'), before.find(([table]) => table === 'feedback_events'));
});

test('strict witness and content schemas reject malformed structure and bounded JSON violations', async t => {
  const f = fixture(t), request = await f.command('record'), before = f.dump();
  const mutations = [
    value => { value.event.expectedRevision = -1; }, value => { value.expectedLedgerRevision = 0.5; },
    value => { value.expectedWitness.profileRevision = '0'; }, value => { value.expectedWitness.sessionSource.source.kind = 'activity'; },
    value => { value.expectedWitness.sessionSource.occurrence.exerciseId = ''; },
    value => { value.expectedWitness.sessionSource.sets[0].status = 'invented'; },
    value => { value.expectedWitness.sessionSource.sets.push(value.expectedWitness.sessionSource.sets[0]); },
    value => { value.expectedWitness.targetPlan = { id: 'plan', revision: 0, archived: false }; },
    value => { value.event.content.sourceRefs[0].qualification = ''; },
    value => { value.event.content.sourceRefs[0].authority = 'prescription'; },
    value => { value.event.content.qualifications = []; }, value => { value.event.content.payload.signals[0].dimension = 'growth'; },
    value => { value.event.content.payload.signals[0].value = null; },
    value => { value.event.content.payload.signals[1].value = 0; },
    value => { value.event.content.payload.signals[0].value = 'x'.repeat(trainingFeedbackHttpLimits.text + 1); },
    value => { value.event.content.payload.signals[0].value = Array(trainingFeedbackHttpLimits.collection + 1).fill(0); },
    value => { let nested = 0; for (let i = 0; i <= trainingFeedbackHttpLimits.jsonDepth; i++) nested = [nested]; value.event.content.payload.signals[0].value = nested; },
    value => { value.event.content.payload.signals[0].value = Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`key-${i}`, i])); },
    value => { value.event.content.payload.signals[0].value = Array.from({ length: 128 }, () => Array(17).fill(0)); },
    value => { value.event.content.payload.signals[0].value = { ['k'.repeat(129)]: 0 }; },
  ];
  for (const mutate of mutations) { const value = structuredClone(request); mutate(value);
    assert.equal((await f.json('POST', '/events', value, 'invalid-shape')).response.status, 422); }
  const witness = { scope: request.event.content.scope, selection: request.selection, authority: true };
  assert.equal((await f.json('POST', '/witness', witness)).response.status, 422); assert.deepEqual(f.dump(), before);
});

test('edit payloads preserve bounded reported JSON and separate session scope without applying a plan edit', async t => {
  const f = fixture(t), request = await f.command('record');
  request.event.content.scope = { kind: 'session', contextId: request.expectedWitness.contextId, sessionId: f.sessions[1].id, planId: f.plan.id };
  const witness = await f.json('POST', '/witness', { scope: request.event.content.scope, selection: request.selection });
  request.expectedWitness = witness.body.result;
  request.event.content.payload = { kind: 'edit', field: 'reported preference', before: null, after: { preferred: ['reported value'], known: false } };
  const result = await f.issue(request); assert.equal(result.response.status, 200);
  assert.deepEqual(result.body.result.current.records[0].content.payload, request.event.content.payload);
  assert.equal(result.body.result.current.records[0].content.scope.kind, 'session');
  assert.equal(f.domain.plan(f.actor.accountId, f.plan.id).revision, 1);
});

test('required bounded idempotency headers preserve changed-intent conflict without generic response caching', async t => {
  const f = fixture(t), request = await f.command('record'), before = f.dump();
  for (const key of [undefined, '', 'has space', 'comma,joined', 'x'.repeat(129), 'slash/key']) {
    const invalid = await f.json('POST', '/events', request, key);
    assert.equal(invalid.response.status, key === undefined || key === '' ? 400 : 422);
  }
  assert.deepEqual(f.dump(), before);
  const first = await f.issue(request), changed = structuredClone(request); changed.event.content.payload.signals[0].value = 3;
  const conflict = await f.issue(changed); assert.equal(conflict.response.status, 200);
  assert.equal(conflict.body.result.receipt.reason, 'idempotency-key-conflict');
  assert.equal(conflict.body.result.current.ledgerRevision, first.body.result.current.ledgerRevision);
});

test('64 KiB streaming limit, fatal UTF-8, invalid JSON and media type failures release readers and retain no feedback', async t => {
  const f = fixture(t), initial = await f.json('GET', '/'), before = f.dump();
  for (const [bytes, contentType, expected] of [
    [new Uint8Array(trainingFeedbackHttpLimits.bodyBytes + 1), 'application/json', 413],
    [new Uint8Array([0x7b, 0xff, 0x7d]), 'application/json', 400],
    [new TextEncoder().encode('{broken'), 'application/json', 400],
    [new TextEncoder().encode('{}'), 'text/plain', 415],
  ]) {
    let cancelled = false;
    const stream = new ReadableStream({ start(controller) { controller.enqueue(bytes); if (expected === 400) controller.close(); }, cancel() { cancelled = true; } });
    const response = await f.app.request(new Request(`http://fixture.invalid${prefix}/witness`, {
      method: 'POST', headers: { 'Content-Type': contentType }, body: stream, duplex: 'half',
    }));
    assert.equal(response.status, expected); assert.equal(stream.locked, false);
    if (expected !== 400) assert.equal(cancelled, true);
  }
  const valid = JSON.stringify({ scope: { kind: 'context', contextId: initial.body.analysis.contextId }, selection: null });
  const exact = await f.app.request(`http://fixture.invalid${prefix}/witness`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: valid + ' '.repeat(trainingFeedbackHttpLimits.bodyBytes - Buffer.byteLength(valid)) });
  assert.equal(exact.status, 200);
  const failedStream = new ReadableStream({ start(controller) { controller.error(new Error('private stream failure')); } });
  const failed = await f.app.request(new Request(`http://fixture.invalid${prefix}/witness`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: failedStream, duplex: 'half' }));
  assert.equal(failed.status, 503); assert.deepEqual(await failed.json(), { error: { code: 'training_feedback_unavailable' } });
  assert.equal(failedStream.locked, false);
  assert.deepEqual(f.dump(), before);
});

test('a revoked original principal during streamed input cannot be replaced by another valid principal', async t => {
  const f = fixture(t), request = await f.command('record'), before = f.dump(), captures = f.captures();
  let captured, controller, cancelled = false;
  const admitted = new Promise(resolve => { captured = resolve; }); f.onCapture(captured);
  const stream = new ReadableStream({ start(value) { controller = value; }, cancel() { cancelled = true; } });
  const pending = f.app.request(new Request(`http://fixture.invalid${prefix}/events`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': request.event.eventId }, body: stream, duplex: 'half' }));
  await admitted; f.revoke(); f.replacePrincipal(f.other); controller.enqueue(new TextEncoder().encode(JSON.stringify(request)));
  const response = await pending; assert.equal(response.status, 401); assert.deepEqual(await response.json(), { error: { code: 'account_session_invalid' } });
  assert.equal(f.captures(), captures + 1); assert.equal(cancelled, true); assert.equal(stream.locked, false); assert.deepEqual(f.dump(), before);
});

test('an active original principal stays captured when the middleware object changes during an await', async t => {
  const f = fixture(t), request = await f.command('record'), captures = f.captures();
  let captured, controller;
  const admitted = new Promise(resolve => { captured = resolve; }); f.onCapture(captured);
  const stream = new ReadableStream({ start(value) { controller = value; } });
  const pending = f.app.request(new Request(`http://fixture.invalid${prefix}/events`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': request.event.eventId }, body: stream, duplex: 'half' }));
  await admitted; f.replacePrincipal(f.other); controller.enqueue(new TextEncoder().encode(JSON.stringify(request))); controller.close();
  const response = await pending; assert.equal(response.status, 200); assert.equal(f.captures(), captures + 1); assert.equal(stream.locked, false);
  const saved = JSON.parse(f.db.prepare('SELECT data FROM feedback_events').get().data);
  assert.equal(saved.event.accountId, f.actor.accountId); assert.notEqual(saved.event.accountId, f.other.accountId);
});

test('absent service and denied retention stay explicit while witness capture remains nonretaining', async t => {
  const f = fixture(t), request = await f.command('record'), before = f.dump();
  const unavailable = f.appFor(null);
  assert.equal((await f.json('GET', '/', undefined, undefined, unavailable)).response.status, 503);
  f.denyRetention();
  for (const result of [await f.json('GET', '/'), await f.issue(request)]) {
    assert.equal(result.response.status, 503); assert.deepEqual(result.body, { error: { code: 'training_feedback_retention_unavailable' } });
  }
  assert.equal((await f.json('POST', '/witness', { scope: request.event.content.scope, selection: request.selection })).response.status, 200);
  assert.deepEqual(f.dump(), before);
});

test('HTTP witness distinguishes historical session plan revision from the current saved-plan target', async t => {
  const f = fixture(t), request = await f.command('record');
  f.domain.patchPlan(f.actor.accountId, f.plan.id, { expectedRevision: 1, name: 'Current saved revision' });
  const scope = { kind: 'plan', contextId: request.expectedWitness.contextId, planId: f.plan.id };
  const result = await f.json('POST', '/witness', { scope, selection: request.selection });
  assert.equal(result.response.status, 200); assert.equal(result.body.result.sessionSource.planSnapshot.planRevision, 1);
  assert.equal(result.body.result.targetPlan.revision, 2); assert.equal(result.body.result.targetPlan.id, f.plan.id);
});

test('actual module conflict after persistence returns 409 and rolls back the source correction and ledger before publication', async t => {
  const f = fixture(t), record = await f.command('record'); await f.issue(record);
  const confirmation = await f.command('confirm'), before = f.dump(), profile = f.domain.document(f.actor.accountId, 'profile');
  f.onRetain(request => {
    if (request.operation === 'mutate' && f.db.prepare('SELECT COUNT(*) AS n FROM feedback_events').get().n === 2) f.changeGoals();
  });
  const result = await f.issue(confirmation); assert.equal(result.response.status, 409);
  assert.deepEqual(result.body, { error: { code: 'current_analysis_changed' } });
  assert.deepEqual(f.dump(), before); assert.deepEqual(f.domain.document(f.actor.accountId, 'profile'), profile);
});

test('service and serialization denials publish only safe errors and recheck the original principal', async t => {
  const f = fixture(t);
  const broken = f.appFor({ ...f.training, read() { throw new Error('private stack and raw feedback'); } });
  const unknown = await f.json('GET', '/', undefined, undefined, broken); assert.equal(unknown.response.status, 503);
  assert.deepEqual(unknown.body, { error: { code: 'training_feedback_unavailable' } });
  const denied = f.appFor({ ...f.training, read() { throw new DomainError(409, 'fixture_conflict', 'private details'); } });
  assert.deepEqual((await f.json('GET', '/', undefined, undefined, denied)).body, { error: { code: 'fixture_conflict' } });
  const late = f.appFor({ ...f.training, read() { return { toJSON() { f.revoke(); return { privateFeedback: 'must not publish' }; } }; } });
  const result = await f.json('GET', '/', undefined, undefined, late); assert.equal(result.response.status, 401);
  assert.deepEqual(result.body, { error: { code: 'account_session_invalid' } });
});
