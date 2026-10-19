import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';

// Native source uses the canonical hook; an explicit module root selects compiled JS. Databases remain in memory.
const moduleRoot = process.env.FORM_FEEDBACK_TEST_MODULE_ROOT
  ? pathToFileURL(resolve(process.env.FORM_FEEDBACK_TEST_MODULE_ROOT) + sep)
  : new URL('../../src/', import.meta.url);
const load = path => import(new URL(process.env.FORM_FEEDBACK_TEST_MODULE_ROOT ? path.replace(/\.ts$/, '.js') : path, moduleRoot).href);
const [{ migrations }, { lifecycleMigration }, guards, { Domain }, { DomainError }, { createFeedbackSessionSourceReader },
  { createSqliteFeedbackLedgerStore }, { createFeedbackLedgerService }, { createFeedbackLifecycleAdapter }, { feedbackMigrationSql, feedbackOwnedTables }] = await Promise.all([
  load('storage.ts'), load('lifecycle/migration.ts'), load('lifecycle/guards.ts'), load('domain.ts'), load('errors.ts'),
  load('training-feedback/session-source.ts'), load('training-feedback/ledger-store.ts'), load('training-feedback/ledger-service.ts'),
  load('training-feedback/lifecycle-adapter.ts'), load('training-feedback/migration.ts'),
]);
const code = expected => error => error instanceof DomainError && error.code === expected;

function fixture(t) {
  const db = new Database(':memory:'); t.after(() => db.close()); db.pragma('foreign_keys = ON');
  for (const migration of migrations.filter(value => value.version <= 7)) db.exec(migration.sql);
  db.exec(lifecycleMigration.sql); db.exec(feedbackMigrationSql);
  const disabled = new Map();
  guards.bindSuppressionAuthority(db, {
    currentSequence: () => disabled.size,
    lookup: accountId => disabled.get(accountId) ?? null,
    reconcileRestore: apply => { for (const value of disabled.values()) apply(value); return disabled.size; },
    recordDisable: record => { const value = { ...record, sequence: disabled.size + 1 }; disabled.set(record.accountId, value); return value; },
  });
  const domain = new Domain(db), contexts = {}, plans = {}, sessions = {}, sets = {}, selections = {}, contextIds = new Map();
  db.prepare('INSERT INTO exercises VALUES (?,?,0)').run('synthetic-press', JSON.stringify({ id: 'synthetic-press', name: 'Synthetic press', loadLabel: 'Total', cues: [] }));
  for (const name of ['A', 'B']) {
    const authUserId = `auth-${name}`, sessionId = `login-${name}`;
    db.prepare('INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,?,?,1,0,0)').run(authUserId, name, `${name}@example.invalid`);
    const accountId = domain.account(authUserId, name);
    contexts[name] = { accountId, authUserId, sessionId, epoch: 0 }; contextIds.set(accountId, `context-${name}`);
    db.prepare('INSERT INTO session(id,expiresAt,token,createdAt,updatedAt,userId) VALUES (?,?,?,0,0,?)')
      .run(sessionId, 8_000_000_000_000, `synthetic-session-${name}`, authUserId);
    plans[name] = domain.createPlan(accountId, { name: 'Synthetic plan', minutes: 30, items: [
      { id: 'item-one', exerciseId: 'synthetic-press', setTarget: 1, repMin: 5, repMax: 8, targetKg: 10 },
    ] });
    sessions[name] = domain.startSession(accountId, plans[name].id, plans[name].revision);
    selections[name] = { sessionId: sessions[name].id, occurrenceId: sessions[name].occurrences[0].id };
    sets[name] = domain.createSet(accountId, sessions[name].id, { occurrenceId: selections[name].occurrenceId,
      setNumber: 1, reps: 6, weightKg: 10, status: 'confirmed', expectedRevision: 1 }).set;
    domain.completeSession(accountId, sessions[name].id, 2);
  }
  let writer = null, writerStarts = 0;
  const assertWithinWrite = context => {
    assert.equal(db.inTransaction, true); assert.deepEqual(writer, context); guards.assertActive(db, context);
  };
  const lifecycle = {
    assertActive: context => guards.assertActive(db, context),
    withActiveWrite(context, effect) {
      assert.equal(db.inTransaction, false, 'public service must not nest a transaction'); writerStarts++;
      writer = context;
      try { return guards.withActiveWrite(db, context, effect); } finally { writer = null; }
    },
  };
  const sourceReader = createFeedbackSessionSourceReader({ domain, withReadSnapshot(context, effect) {
    assertWithinWrite(context); const value = effect(); assertWithinWrite(context); return value;
  } });
  const readContextWithinWrite = (context, request) => {
    assertWithinWrite(context);
    if (contextIds.get(context.accountId) !== request.scope.contextId) throw new DomainError(403, 'feedback_context_forbidden');
    const profile = domain.document(context.accountId, 'profile'), preferences = domain.document(context.accountId, 'preferences');
    const plan = request.scope.kind === 'plan' ? domain.plan(context.accountId, request.scope.planId) : null;
    return { contextId: contextIds.get(context.accountId), profileRevision: profile.revision, preferencesRevision: preferences.revision,
      sessionSource: request.selection ? sourceReader.read(context, request.selection) : null,
      targetPlan: plan ? { id: plan.id, revision: plan.revision, archived: plan.archived } : null };
  };
  const store = createSqliteFeedbackLedgerStore({ db, lifecycle, assertWithinWrite });
  const calls = [], authority = new Map([['observed', true], ['summary', true], ['later', false]]);
  const sessionScope = { kind: 'session', contextId: 'context-A', sessionId: sessions.A.id, planId: plans.A.id };
  const contextScope = { kind: 'context', contextId: 'context-A' };
  const recipeRefs = id => [{ sourceId: `synthetic-test-recipe-${id}`, revision: 'fixture-1',
    locator: `services/api/tests/training-feedback/ledger.test.mjs#${id}`,
    qualification: 'Synthetic test fixture only; no clinical or prescription evidence' }];
  const recipes = [
    { id: 'observed', version: '1', kind: 'history', scope: contextScope, sourceIds: ['feedback-one'], dependsOn: [], sourceRefs: recipeRefs('observed'), qualifications: ['Synthetic observation only'],
      compute({ sources }) { calls.push('observed'); return sources[0].content.payload; } },
    { id: 'summary', version: '1', kind: 'summary', scope: contextScope, sourceIds: [], dependsOn: ['observed'], sourceRefs: recipeRefs('summary'), qualifications: ['No prescription'],
      compute({ parents }) { calls.push('summary'); return parents[0].value; } },
    { id: 'later', version: '1', kind: 'recommendation', scope: contextScope, sourceIds: [], dependsOn: ['summary'], sourceRefs: recipeRefs('later'), qualifications: ['Rule authority unavailable'],
      compute() { calls.push('later'); return 'must not be prescribed'; } },
  ];
  const deps = { store, lifecycle, readContextWithinWrite, derivations: recipes,
    derivationAuthorityWithinWrite: (_context, recipe) => authority.get(recipe.id) === true };
  const service = createFeedbackLedgerService(deps);
  let nextEvent = 0, purgeReady = false;
  const control = {
    assertSuppression(accountId, epoch) { if (disabled.get(accountId)?.epoch !== epoch) throw new Error('canonical suppression absent'); },
    purgeReadiness(requestId, accountId) { return purgeReady && requestId === 'synthetic-purge' && disabled.has(accountId)
      ? { status: 'ready', epoch: disabled.get(accountId).epoch } : { status: 'unavailable', reason: 'purge_not_authorized' }; },
  };
  const adapter = createFeedbackLifecycleAdapter({ db, lifecycle, control });
  const content = (value = 'original qualitative observation', scope = sessionScope) => ({ scope: structuredClone(scope), sourceRefs: [
    { sourceId: 'synthetic-self-report', revision: '1', locator: 'session feedback', qualification: 'Self report; no clinical interpretation' },
  ], qualifications: ['Retain uncertainty'], payload: { kind: 'feedback', signals: [{ dimension: 'discomfort', state: 'reported', value, unit: null, scale: null }] } });
  const command = (kind, fields = {}, options = {}) => {
    const context = options.context ?? contexts.A, chosenService = options.service ?? service;
    const view = chosenService.read(context), recordId = options.recordId ?? 'feedback-one';
    const record = view.records.find(value => value.recordId === recordId);
    const bound = view.sources.find(value => value.recordId === recordId)?.binding;
    const scope = fields.content?.scope ?? record?.content?.scope ?? sessionScope;
    const selection = structuredClone(options.selection === undefined ? selections[context === contexts.B ? 'B' : 'A'] : options.selection);
    const expectedWitness = kind === 'confirm' ? bound?.witness ?? null : kind === 'record' || kind === 'correct'
      ? lifecycle.withActiveWrite(context, () => readContextWithinWrite(context, { scope, selection })) : null;
    const eventId = `event-${++nextEvent}`;
    return { idempotencyKey: `key-${eventId}`, expectedLedgerRevision: view.ledgerRevision, selection, expectedWitness,
      event: { eventId, accountId: context.accountId, recordId, expectedRevision: record?.revision ?? 0, kind, ...fields } };
  };
  const issue = (kind, fields = {}, options = {}) => (options.service ?? service).mutate(options.context ?? contexts.A, command(kind, fields, options));
  const dump = () => feedbackOwnedTables.map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY account_id`).all()]);
  const disable = (context = contexts.A) => {
    const record = { accountId: context.accountId, authUserId: context.authUserId, epoch: context.epoch + 1,
      requestId: 'synthetic-purge', disabledAtMs: 1, sequence: disabled.size + 1 };
    disabled.set(context.accountId, record);
    db.prepare("UPDATE account_lifecycle SET state='disabled',epoch=?,disabled_at_ms=1,suppression_seq=? WHERE account_id=?")
      .run(record.epoch, record.sequence, context.accountId);
    return record;
  };
  return { db, domain, contexts, plans, sessions, sets, selections, lifecycle, store, service, deps, authority, calls, recipes,
    adapter, control, disabled, contextScope, sessionScope, content, command, issue, dump, disable,
    writerStarts: () => writerStarts, allowPurge: () => { purgeReady = true; } };
}

function confirmed(f, content = f.content()) {
  f.issue('record', { content }); return f.issue('confirm');
}
function observed(view) { return view.derivations.find(value => value.id === 'observed'); }
function blocked(view) {
  for (const output of view.derivations) { assert.equal(output.status, 'blocked'); assert.equal(output.value, null); }
}

test('durable SQL retains distinct constructs and source qualifications; canonical writer is entered once', t => {
  const f = fixture(t), content = f.content();
  content.payload.signals = [
    { dimension: 'rir', state: 'reported', value: 0, unit: 'repetitions', scale: 'self report' },
    { dimension: 'effort', state: 'missing', reason: 'not-reported' },
    ...['discomfort', 'weakness', 'function', 'performance', 'sensation', 'soreness'].map(dimension => ({ dimension, state: 'reported', value: false, unit: null, scale: null })),
  ];
  const request = f.command('record', { content }), before = f.writerStarts();
  const written = f.service.mutate(f.contexts.A, request);
  assert.equal(f.writerStarts(), before + 1); assert.equal(written.receipt.outcome, 'changed'); blocked(written.current);
  const result = f.issue('confirm');
  assert.deepEqual(observed(result.current).value, content.payload);
  assert.deepEqual(result.current.records[0].content.sourceRefs, content.sourceRefs);
  assert.equal(result.current.sources[0].binding.witness.sessionSource.source.accountId, f.contexts.A.accountId);
  assert.equal(result.current.derivations.find(value => value.id === 'later').status, 'blocked');
  assert.equal(f.calls.includes('later'), false);
});

test('confirmed correction undo restores prior content and witness unconfirmed at a new revision', t => {
  const f = fixture(t); confirmed(f);
  const originalWitness = f.service.read(f.contexts.A).sources[0].binding.witness;
  const correction = f.issue('correct', { content: f.content('corrected observation') }); f.issue('confirm');
  const undone = f.issue('undo', { targetEventId: correction.receipt.eventId });
  assert.equal(undone.current.records[0].revision, 5); assert.equal(undone.current.records[0].confirmed, false);
  assert.deepEqual(undone.current.records[0].content, f.content());
  assert.deepEqual(undone.current.sources[0].binding.witness, originalWitness); blocked(undone.current);
  assert.equal(observed(f.issue('confirm').current).status, 'ready');
});

test('withdrawal undo and confirmation undo cannot reinstate an earlier confirmation', t => {
  const f = fixture(t); confirmed(f);
  const withdrawal = f.issue('withdraw'); blocked(withdrawal.current);
  const undo = f.issue('undo', { targetEventId: withdrawal.receipt.eventId });
  assert.equal(undo.current.records[0].status, 'active'); assert.equal(undo.current.records[0].confirmed, false); blocked(undo.current);
  const confirmation = f.issue('confirm');
  blocked(f.issue('undo', { targetEventId: confirmation.receipt.eventId }).current);
  const later = f.issue('correct', { content: f.content('later substantive change') });
  const stale = f.issue('undo', { targetEventId: withdrawal.receipt.eventId });
  assert.equal(stale.receipt.outcome, 'rejected'); assert.equal(stale.current.ledgerRevision, later.current.ledgerRevision);
});

test('duplicate keys and event IDs reject changed intent; identical retries return stable receipts and current views', t => {
  const f = fixture(t), request = f.command('record', { content: f.content('private-original-sentinel') });
  const first = f.service.mutate(f.contexts.A, request); f.issue('confirm');
  f.issue('correct', { content: f.content('private-corrected-sentinel') });
  const retry = f.service.mutate(f.contexts.A, structuredClone(request));
  assert.deepEqual(retry.receipt, first.receipt); assert.equal(retry.replayed, true);
  assert.equal(retry.current.records[0].content.payload.signals[0].value, 'private-corrected-sentinel'); blocked(retry.current);
  const altered = structuredClone(request); altered.event.content.payload.signals[0].value = 'changed intent';
  const conflict = f.service.mutate(f.contexts.A, altered);
  assert.equal(conflict.receipt.reason, 'idempotency-key-conflict'); assert.equal(conflict.current.ledgerRevision, retry.current.ledgerRevision);
  altered.idempotencyKey = 'different-key';
  assert.equal(f.service.mutate(f.contexts.A, altered).receipt.reason, 'event-id-conflict');
  const alias = f.service.mutate(f.contexts.A, { ...request, idempotencyKey: 'alias-key' });
  assert.deepEqual(alias.receipt, first.receipt);
  const receipts = JSON.stringify(f.db.prepare('SELECT * FROM feedback_receipts').all());
  assert.equal(receipts.includes('private-original-sentinel'), false); assert.equal(receipts.includes('private-corrected-sentinel'), false);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM command_receipts').get().n, 0);
});

test('ledger and record CAS reject stale writes and reserve rejected event identity without raw payload', t => {
  const f = fixture(t); confirmed(f);
  const request = f.command('correct', { content: f.content('rejected-private-sentinel') }); request.expectedLedgerRevision--;
  const result = f.service.mutate(f.contexts.A, request);
  assert.equal(result.receipt.reason, 'ledger-revision-conflict'); assert.equal(result.current.ledgerRevision, 2);
  const reused = { ...request, expectedLedgerRevision: 2, idempotencyKey: 'reused-rejection' };
  assert.equal(f.service.mutate(f.contexts.A, reused).receipt.reason, 'event-id-conflict');
  const staleRecord = f.command('correct', { content: f.content('stale-record') }); staleRecord.event.expectedRevision = 0;
  assert.equal(f.service.mutate(f.contexts.A, staleRecord).receipt.reason, 'revision-conflict');
  assert.equal(JSON.stringify(f.dump()).includes('rejected-private-sentinel'), false);
});

test('source correction invalidation removes all descendant caches inside the same transaction and rolls back together', t => {
  const f = fixture(t); confirmed(f);
  const before = f.dump(), original = f.domain.set(f.contexts.A.accountId, f.sessions.A.id, f.sets.A.id);
  const invalidate = () => {
    f.domain.voidSet(f.contexts.A.accountId, f.sessions.A.id, f.sets.A.id, original.revision);
    const calls = f.calls.length;
    const view = f.service.invalidateWithinWrite(f.contexts.A, [{ kind: 'session', id: f.sessions.A.id }]);
    blocked(view); assert.equal(f.calls.length, calls);
    blocked(JSON.parse(f.db.prepare('SELECT data FROM feedback_projections WHERE account_id=?').get(f.contexts.A.accountId).data));
  };
  assert.throws(() => f.lifecycle.withActiveWrite(f.contexts.A, () => { invalidate(); throw new Error('synthetic rollback'); }), /synthetic rollback/);
  assert.deepEqual(f.dump(), before); assert.deepEqual(f.domain.set(f.contexts.A.accountId, f.sessions.A.id, f.sets.A.id), original);
  f.lifecycle.withActiveWrite(f.contexts.A, invalidate);
  const current = f.service.read(f.contexts.A); blocked(current); assert.equal(current.sources[0].state, 'changed');
  assert.equal(current.ledgerRevision, 2); assert.ok(current.projectionRevision > 0);
});

test('confirmation cannot refresh a stale witness; correction can bind fresh source and undo restores the stale prior witness', t => {
  const f = fixture(t); confirmed(f);
  f.domain.patchSet(f.contexts.A.accountId, f.sessions.A.id, f.sets.A.id, { expectedRevision: 1, reps: 7, weightKg: 10, status: 'confirmed' });
  assert.equal(f.issue('confirm').receipt.reason, 'source-witness-conflict');
  const correction = f.issue('correct', { content: f.content('after completed set correction') });
  assert.equal(observed(f.issue('confirm').current).status, 'ready');
  const undo = f.issue('undo', { targetEventId: correction.receipt.eventId }); blocked(undo.current);
  assert.equal(undo.current.sources[0].state, 'changed'); assert.equal(f.issue('confirm').receipt.reason, 'source-witness-conflict');
});

test('client witness, foreign account and mismatched scope/occurrence selection cannot supply authority', t => {
  const f = fixture(t), request = f.command('record', { content: f.content() });
  const forged = structuredClone(request); forged.expectedWitness.profileRevision += 100;
  assert.equal(f.service.mutate(f.contexts.A, forged).receipt.reason, 'source-witness-conflict');
  assert.throws(() => f.service.mutate(f.contexts.B, request), code('feedback_account_mismatch'));
  const foreign = f.command('record', { content: f.content() }); foreign.selection = f.selections.B;
  assert.equal(f.service.mutate(f.contexts.A, foreign).receipt.reason, 'source-missing');
  const otherScope = f.command('record', { content: f.content() }); otherScope.event.content.scope.contextId = 'context-B';
  assert.throws(() => f.service.mutate(f.contexts.A, otherScope), code('feedback_context_forbidden'));
  const wrongOccurrence = f.command('record', { content: f.content() }); wrongOccurrence.selection.occurrenceId = 'not-an-occurrence';
  assert.throws(() => f.service.mutate(f.contexts.A, wrongOccurrence), /feedback_occurrence_missing/);
  assert.equal(f.service.read(f.contexts.B).records.length, 0);
});

test('saved plan edits preserve historical session witness but invalidate explicit durable plan scope', t => {
  const f = fixture(t); confirmed(f);
  f.domain.patchPlan(f.contexts.A.accountId, f.plans.A.id, { expectedRevision: 1, name: 'Revised saved plan' });
  const history = f.service.read(f.contexts.A); assert.equal(history.sources[0].state, 'current');
  assert.equal(history.sources[0].binding.witness.sessionSource.planSnapshot.planRevision, 1);
  const planScope = { kind: 'plan', contextId: 'context-A', planId: f.plans.A.id };
  f.issue('correct', { content: f.content('explicit plan-scoped feedback', planScope) }); f.issue('confirm');
  f.domain.patchPlan(f.contexts.A.accountId, f.plans.A.id, { expectedRevision: 2, name: 'Another saved plan revision' });
  const current = f.service.read(f.contexts.A); assert.equal(current.sources[0].state, 'changed'); blocked(current);
});

test('profile and preference changes invalidate actual context revisions without implicit promotion', t => {
  const f = fixture(t); confirmed(f);
  f.domain.patchDocument(f.contexts.A.accountId, 'preferences', { expectedRevision: 0, sessionMinutes: 40 });
  blocked(f.service.read(f.contexts.A));
  f.issue('correct', { content: f.content('explicit durable feedback', f.contextScope) });
  const confirmation = f.issue('confirm'); assert.equal(observed(confirmation.current).status, 'ready');
  assert.equal(confirmation.current.derivations.find(value => value.id === 'later').status, 'blocked');
  f.domain.patchDocument(f.contexts.A.accountId, 'profile', { expectedRevision: 0, injuryHistory: 'synthetic update' });
  blocked(f.service.read(f.contexts.A)); assert.equal(f.calls.includes('later'), false);
});

test('rule authority withdrawal blocks before compute and recipe version changes replace old results', t => {
  const f = fixture(t); confirmed(f);
  f.authority.set('observed', false); const calls = f.calls.length;
  blocked(f.service.read(f.contexts.A)); assert.equal(f.calls.length, calls);
  f.authority.set('observed', true);
  const updated = createFeedbackLedgerService({ ...f.deps, derivations: f.recipes.map(recipe => recipe.id === 'observed'
    ? { ...recipe, version: '2', compute: () => 'new qualified synthetic observation' } : recipe) });
  const view = updated.read(f.contexts.A); assert.equal(observed(view).version, '2');
  assert.equal(observed(view).value, 'new qualified synthetic observation');
  for (const value of [undefined, NaN]) {
    const invalid = createFeedbackLedgerService({ ...f.deps, derivations: f.recipes.map(recipe => recipe.id === 'observed'
      ? { ...recipe, compute: () => value } : recipe) });
    blocked(invalid.read(f.contexts.A));
  }
  const throws = createFeedbackLedgerService({ ...f.deps, derivations: f.recipes.map(recipe => recipe.id === 'observed'
    ? { ...recipe, compute: () => { throw new Error('private callback text'); } } : recipe) });
  const output = throws.read(f.contexts.A); blocked(output); assert.equal(JSON.stringify(output).includes('private callback text'), false);
});

test('missing source becomes blocked while denied authentication propagates instead of returning cached data', t => {
  const f = fixture(t); confirmed(f);
  const missing = createFeedbackLedgerService({ ...f.deps, readContextWithinWrite() { throw new DomainError(404, 'not_found'); } });
  const result = missing.read(f.contexts.A); blocked(result); assert.equal(result.sources[0].state, 'missing');
  f.service.read(f.contexts.A);
  f.db.prepare('UPDATE session SET expiresAt=0 WHERE id=?').run(f.contexts.A.sessionId);
  assert.throws(() => f.service.read(f.contexts.A), code('account_session_invalid'));
  assert.throws(() => f.adapter.inventory(f.contexts.A), code('account_session_invalid'));
});

test('event, receipt and projection SQL writes roll back as one unit on a post-write failure', t => {
  const f = fixture(t); confirmed(f);
  const request = f.command('correct', { content: f.content('rollback-only-sentinel') }), before = f.dump();
  const failingStore = { ...f.store, replaceWithinWrite(...args) { f.store.replaceWithinWrite(...args); throw new Error('synthetic store fault'); } };
  const failing = createFeedbackLedgerService({ ...f.deps, store: failingStore });
  assert.throws(() => failing.mutate(f.contexts.A, request), /synthetic store fault/);
  assert.deepEqual(f.dump(), before);
  assert.equal(f.service.mutate(f.contexts.A, request).receipt.outcome, 'changed');
});

test('trusted mutation port reuses an existing canonical writer and rejects use outside it', t => {
  const f = fixture(t), request = f.command('record', { content: f.content() }), starts = f.writerStarts();
  assert.throws(() => f.service.mutateWithinWrite(f.contexts.A, request), code('feedback_writer_transaction_required'));
  const result = f.lifecycle.withActiveWrite(f.contexts.A, () => f.service.mutateWithinWrite(f.contexts.A, request));
  assert.equal(result.receipt.outcome, 'changed'); assert.equal(f.writerStarts(), starts + 1);
  const correction = f.command('correct', { content: f.content('outer callback rollback') }), before = f.dump();
  assert.throws(() => f.lifecycle.withActiveWrite(f.contexts.A, () => {
    f.service.mutateWithinWrite(f.contexts.A, correction); throw new Error('outer source token changed');
  }), /outer source token changed/);
  assert.deepEqual(f.dump(), before);
});

test('per-record deletion is unavailable before any database write; lifecycle guards also fence store access', t => {
  const f = fixture(t); confirmed(f);
  const request = f.command('withdraw'); request.event.kind = 'delete'; const before = f.dump(), starts = f.writerStarts();
  assert.throws(() => f.service.mutate(f.contexts.A, request), code('feedback_deletion_policy_unavailable'));
  assert.deepEqual(f.dump(), before); assert.equal(f.writerStarts(), starts);
  assert.throws(() => f.store.loadWithinWrite(f.contexts.A), code('feedback_writer_transaction_required'));
  assert.throws(() => f.service.read({ ...f.contexts.A, epoch: 7 }), code('account_epoch_changed'));
  f.disable(); assert.throws(() => f.service.read(f.contexts.A), code('account_disabled'));
});

test('account export uses caller snapshot and excludes receipt digests, keys and cached derivations', t => {
  const f = fixture(t); confirmed(f, f.content('account-A-private'));
  f.issue('record', { content: f.content('account-B-private', { kind: 'context', contextId: 'context-B' }) }, { context: f.contexts.B, recordId: 'feedback-B' });
  const output = [], snapshot = { snapshotAtMs: 1, append: (category, value) => output.push({ category, value }) };
  assert.equal(f.adapter.export(f.contexts.A, snapshot).status, 'unavailable');
  const result = f.db.transaction(() => f.adapter.export(f.contexts.A, snapshot))();
  assert.equal(result.status, 'complete'); assert.ok(result.count > 0);
  const json = JSON.stringify(output); assert.equal(json.includes('account-A-private'), true); assert.equal(json.includes('account-B-private'), false);
  for (const field of ['intentDigest', 'intent_digest', 'idempotencyKey', 'idempotency_key', 'derivations']) assert.equal(json.includes(field), false);
  assert.throws(() => f.db.transaction(() => f.adapter.export(f.contexts.A, { snapshotAtMs: 1, append() { throw new Error('packaging exceeded'); } }))(), /packaging exceeded/);
});

test('account purge requires canonical suppression and readiness, rolls back on lost authority, and leaves other accounts', t => {
  const f = fixture(t); confirmed(f);
  f.issue('record', { content: f.content('account-B-retained', { kind: 'context', contextId: 'context-B' }) }, { context: f.contexts.B, recordId: 'feedback-B' });
  assert.equal(f.adapter.purge('synthetic-purge', f.contexts.A.accountId).status, 'unavailable');
  assert.equal(f.db.transaction(() => f.adapter.purge('synthetic-purge', f.contexts.A.accountId))().status, 'unavailable');
  const record = f.disable(); f.allowPurge();
  assert.equal(f.db.transaction(() => f.adapter.suppress(f.contexts.A.accountId, record.epoch))().status, 'complete');
  const before = f.dump(); let calls = 0;
  const lostAuthority = createFeedbackLifecycleAdapter({ db: f.db, lifecycle: f.lifecycle, control: { ...f.control,
    assertSuppression(...args) { if (++calls > 1) throw new Error('lost purge authority'); f.control.assertSuppression(...args); } } });
  assert.throws(() => f.db.transaction(() => lostAuthority.purge('synthetic-purge', f.contexts.A.accountId))(), /lost purge authority/);
  assert.deepEqual(f.dump(), before);
  assert.equal(f.db.transaction(() => f.adapter.purge('synthetic-purge', f.contexts.A.accountId))().status, 'complete');
  for (const table of feedbackOwnedTables) assert.equal(f.db.prepare(`SELECT count(*) AS n FROM ${table} WHERE account_id=?`).get(f.contexts.A.accountId).n, 0);
  assert.equal(f.adapter.verifySuppressed(f.contexts.A.accountId, record.epoch).status, 'complete');
  assert.throws(() => f.service.read(f.contexts.A), code('account_disabled'));
  assert.equal(f.service.read(f.contexts.B).records[0].content.payload.signals[0].value, 'account-B-retained');
});

test('returned views and caller-owned content cannot mutate persisted history or witnesses', t => {
  const f = fixture(t), content = f.content(), request = f.command('record', { content });
  const result = f.service.mutate(f.contexts.A, request);
  content.payload.signals[0].value = 'caller mutation'; result.current.records[0].content.payload.signals[0].value = 'output mutation';
  result.current.sources[0].binding.witness.sessionSource.sets[0].revision = 999;
  const reread = f.service.read(f.contexts.A);
  assert.equal(reread.records[0].content.payload.signals[0].value, 'original qualitative observation');
  assert.equal(reread.sources[0].binding.witness.sessionSource.sets[0].revision, 1);
});
