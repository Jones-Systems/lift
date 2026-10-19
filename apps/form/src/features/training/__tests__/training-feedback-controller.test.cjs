const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const ts = require('typescript');

const compiled = new Map();
function load(relative, imports) {
  const file = resolve(__dirname, '..', relative), module = { exports: {} };
  if (!compiled.has(file)) compiled.set(file, ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
  } }).outputText);
  new Function('require', 'module', 'exports', compiled.get(file))(name => {
    assert.ok(Object.hasOwn(imports, name), `Bound runtime dependency ${name}`); return imports[name];
  }, module, module.exports);
  return module.exports;
}
const { ApiError } = load('../../api/transport.ts', {});
const caller = load('../../api/training-feedback.ts', { './transport': { ApiError } });
const react = {};
const { createTrainingFeedbackController, guardTrainingFeedback, useTrainingFeedback } = load('useTrainingFeedback.ts', {
  react, '../../api/transport': { ApiError }, '../../api/training-feedback': caller,
});
const clone = value => JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const drain = () => new Promise(resolve => setImmediate(resolve));
const contextScope = { kind: 'context', contextId: 'context_1' };
const planScope = { kind: 'plan', contextId: 'context_1', planId: 'plan_1' };
const sessionScope = { kind: 'session', contextId: 'context_1', sessionId: 'session_1', planId: 'plan_1' };
const selection = { sessionId: 'session_1', occurrenceId: 'occurrence_1' };
const reference = { sourceId: 'owner_report', revision: 'capture_1', locator: 'feedback', qualification: 'reported-only' };
const analysis = (revision = 1) => ({ basis: 'current_profile_and_goals', contextId: 'context_1', profileRevision: revision, preferencesRevision: 1 });
const witness = (scope = contextScope, revision = 1) => ({ contextId: 'context_1', profileRevision: revision, preferencesRevision: 1,
  sessionSource: scope.kind !== 'session' ? null : { source: { accountId: 'account_1', kind: 'session', id: 'session_1', revision: 1, itemId: 'occurrence_1' },
    sessionStatus: 'completed', planSnapshot: { planId: 'plan_1', planRevision: 2 },
    occurrence: { id: 'occurrence_1', itemId: 'item_1', exerciseId: 'exercise_1' }, sets: [] },
  targetPlan: scope.kind === 'context' ? null : { id: 'plan_1', revision: 2, archived: false } });
const content = (scope = contextScope) => ({ scope: clone(scope), sourceRefs: [clone(reference)], qualifications: ['reported-only'],
  payload: { kind: 'feedback', signals: [{ dimension: 'effort', state: 'reported', value: 7, unit: null, scale: 'owner_scale' },
    { dimension: 'discomfort', state: 'missing', reason: 'not-reported' }] } });
const empty = (ledgerRevision = 0) => ({ ledgerRevision, projectionRevision: ledgerRevision, records: [], derivations: [], sources: [] });
function intent(kind = 'record', revision = 0, ledger = revision, overrides = {}) {
  return { key: `key_${kind}_${ledger}`, expectedLedgerRevision: ledger, selection: null,
    event: { eventId: `event_${kind}_${ledger}`, recordId: 'record_1', expectedRevision: revision, kind,
      ...(kind === 'record' || kind === 'correct' ? { content: content() } : kind === 'undo' ? { targetEventId: 'event_withdraw_3' } : {}) }, ...overrides };
}
function binding(scope = contextScope, revision = 1) { return { scope: clone(scope), selection: scope.kind === 'session' ? clone(selection) : null, witness: witness(scope, revision) }; }
function recorded(revision = 1, ledger = revision, scope = contextScope, witnessRevision = 1) {
  return { ...empty(ledger), records: [{ recordId: 'record_1', revision, status: 'active', confirmed: false, content: content(scope) }],
    sources: [{ recordId: 'record_1', state: 'current', binding: binding(scope, witnessRevision) }] };
}
function response(body, current, overrides = {}) {
  return { analysis: analysis(), result: { receipt: { eventId: body.event.eventId, recordId: body.event.recordId,
    cause: body.event.kind, outcome: 'changed', revision: body.event.expectedRevision + 1, reason: null,
    acceptedLedgerRevision: current.ledgerRevision }, replayed: false, current: clone(current), ...overrides } };
}
function fixture(options = {}) {
  let ownerCurrent = true, authCurrent = true, captures = 0, reloads = 0;
  const calls = [], published = []; let view = options.view ?? empty(), witnessRevision = 1;
  const api = { captureAuthContext() { captures++; return { isCurrent: () => authCurrent }; },
    async request(url, method = 'GET', body, key) {
      const call = { url, method, body, key }; calls.push(call);
      if (options.respond) { const result = await options.respond(call); if (result !== undefined) return result; }
      if (url === '/v1/training-feedback') return { analysis: analysis(witnessRevision), result: clone(view) };
      if (url === '/v1/training-feedback/witness') return { analysis: analysis(witnessRevision), result: witness(body.scope, witnessRevision) };
      assert.equal(url, '/v1/training-feedback/events');
      const event = body.event, next = event.expectedRevision + 1;
      const previous = view.records.find(row => row.recordId === event.recordId);
      const savedContent = event.content ?? previous?.content ?? content();
      const status = event.kind === 'withdraw' ? 'withdrawn' : 'active';
      view = { ...view, ledgerRevision: view.ledgerRevision + 1, projectionRevision: view.projectionRevision + 1,
        records: [{ recordId: event.recordId, revision: next, status, confirmed: event.kind === 'confirm', content: savedContent }],
        sources: [{ recordId: event.recordId, state: 'current', binding: event.kind === 'record' || event.kind === 'correct'
          ? { scope: savedContent.scope, selection: body.selection, witness: body.expectedWitness } : view.sources[0]?.binding ?? null }] };
      return response(body, view);
    } };
  const controller = createTrainingFeedbackController({ api, accountId: 'account_1', sessionGeneration: 'generation_1',
    isCurrentSession: (account, generation) => ownerCurrent && account === 'account_1' && generation === 'generation_1' },
  state => published.push(state), () => { reloads++; });
  return { controller, calls, published, api, snapshot: controller.snapshot, captures: () => captures, reloads: () => reloads,
    view: value => { view = value; }, witnessRevision: value => { witnessRevision = value; },
    owner: value => { ownerCurrent = value; }, auth: value => { authCurrent = value; } };
}
const writes = f => f.calls.filter(call => call.url.endsWith('/events'));

test('actual caller is lazy, explicitly records qualified reported content then confirms its saved binding', async () => {
  const f = fixture(); assert.equal(f.calls.length, 0); assert.equal(f.captures(), 0);
  const draft = intent(); await f.controller.review(draft);
  assert.equal(f.snapshot().status, 'reviewed'); assert.equal(writes(f).length, 0); assert.equal(f.captures(), 1);
  assert.deepEqual(f.snapshot().reviewAnalysis, { current: analysis(), witness: analysis() });
  draft.event.content.payload.signals[0].value = 99;
  await f.controller.send(); assert.equal(f.snapshot().status, 'succeeded');
  assert.equal(writes(f)[0].body.event.content.payload.signals[0].value, 7);
  assert.ok(Object.isFrozen(writes(f)[0].body.event.content.sourceRefs));
  await f.controller.review(intent('confirm', 1)); await f.controller.send();
  assert.equal(f.snapshot().current.result.records[0].confirmed, true);
  assert.deepEqual(writes(f)[1].body.expectedWitness, writes(f)[0].body.expectedWitness);
  assert.deepEqual(f.snapshot().current.analysis, analysis()); f.controller.dispose();
});

test('record, plan and session scopes retain explicit selection, provenance, qualifications and revisions', async () => {
  for (const scope of [contextScope, planScope, sessionScope]) {
    const f = fixture(), input = intent(); input.event.content = content(scope); input.selection = scope.kind === 'session' ? clone(selection) : null;
    await f.controller.review(input); await f.controller.send(); const sent = writes(f)[0];
    assert.deepEqual(sent.body.event.content, content(scope)); assert.deepEqual(sent.body.selection, input.selection);
    assert.deepEqual(sent.body.expectedWitness, witness(scope)); assert.equal(sent.key, input.key);
    assert.equal(sent.body.expectedLedgerRevision, 0); assert.equal(sent.body.event.expectedRevision, 0); f.controller.dispose();
  }
});

test('witness drift blocks confirm until explicit correction and a new explicit confirmation review', async () => {
  const f = fixture({ view: recorded() }); f.witnessRevision(2);
  await f.controller.review(intent('confirm', 1)); assert.equal(f.snapshot().status, 'error');
  assert.equal(f.snapshot().error.code, 'training_feedback_witness_changed'); await f.controller.send(); assert.equal(writes(f).length, 0);
  const corrected = intent('correct', 1); corrected.event.content.payload = { kind: 'edit', field: 'reported_goal', before: 'before', after: 'after' };
  await f.controller.review(corrected); await f.controller.send();
  assert.equal(writes(f)[0].body.expectedWitness.profileRevision, 2);
  await f.controller.send(); assert.equal(writes(f).length, 1, 'No automatic confirm or resend');
  await f.controller.review(intent('confirm', 2)); await f.controller.send();
  assert.equal(writes(f)[1].body.expectedWitness.profileRevision, 2); assert.equal(f.snapshot().current.result.records[0].confirmed, true); f.controller.dispose();
});

test('withdraw and explicit undo preserve historical selection without fetching or replacing a witness', async () => {
  const f = fixture({ view: recorded(3, 3, sessionScope) }); f.witnessRevision(9);
  await f.controller.review(intent('withdraw', 3, 3, { selection: clone(selection) })); await f.controller.send();
  const undo = intent('undo', 4, 4, { selection: clone(selection) }); undo.event.targetEventId = 'event_withdraw_3';
  await f.controller.review(undo); await f.controller.send();
  assert.equal(f.calls.filter(call => call.url.endsWith('/witness')).length, 0);
  assert.deepEqual(writes(f).map(call => call.body.expectedWitness), [null, null]);
  assert.equal(writes(f)[1].body.event.targetEventId, 'event_withdraw_3');
  assert.deepEqual(f.snapshot().current.result.sources[0].binding, binding(sessionScope));
  const missingTarget = intent('undo', 5); delete missingTarget.event.targetEventId;
  await f.controller.review(missingTarget); await f.controller.send(); assert.equal(writes(f).length, 2); f.controller.dispose();
});

test('local ledger/record conflict retains the draft and never substitutes fresh revisions', async () => {
  for (const input of [intent('correct', 1, 0), intent('correct', 0, 1)]) {
    const f = fixture({ view: recorded() }); await f.controller.review(input); await f.controller.send();
    assert.equal(f.snapshot().status, 'error'); assert.deepEqual(f.snapshot().draft, input); assert.equal(writes(f).length, 0);
    assert.equal(f.calls.filter(call => call.url.endsWith('/witness')).length, 0); f.controller.dispose();
  }
});

test('terminal server CAS rejection retains reviewed draft and requires explicit rereview', async () => {
  const newer = recorded(0, 1);
  const f = fixture({ respond: call => call.url.endsWith('/events') ? response(call.body, newer, {
    receipt: { eventId: call.body.event.eventId, recordId: 'record_1', cause: 'record', outcome: 'rejected', revision: 0,
      reason: 'ledger-revision-conflict', acceptedLedgerRevision: 1 },
  }) : undefined });
  const original = intent(); await f.controller.review(original); await f.controller.send();
  assert.equal(f.snapshot().status, 'rejected'); assert.deepEqual(f.snapshot().draft, original); assert.equal(f.snapshot().review, null);
  await f.controller.send(); await f.controller.retry(); await f.controller.read(); await f.controller.send();
  assert.equal(writes(f).length, 1); assert.deepEqual(writes(f)[0].body.event, original.event); f.controller.dispose();
});

test('unknown effect remains immutable through later rejection, GET similarity and exact single-flight retry', async () => {
  const pending = deferred(); let count = 0;
  const f = fixture({ respond(call) {
    if (!call.url.endsWith('/events')) return;
    count++; if (count === 1) throw new ApiError(0, 'lost', 'Lost', true);
    if (count === 2) throw new ApiError(422, 'rejected', 'Rejected');
    return pending.promise;
  } });
  const input = intent(); await f.controller.review(input); await f.controller.send();
  const retained = f.snapshot().review; assert.equal(f.snapshot().status, 'unknown');
  const retainedAnalysis = f.snapshot().reviewAnalysis;
  f.view(recorded()); await f.controller.read(); assert.equal(f.snapshot().status, 'unknown');
  assert.strictEqual(f.snapshot().reviewAnalysis, retainedAnalysis);
  await f.controller.review(intent('correct', 1)); await f.controller.send(); assert.equal(writes(f).length, 1);
  await f.controller.retry(); assert.equal(f.snapshot().status, 'unknown'); assert.strictEqual(f.snapshot().review, retained);
  const third = f.controller.retry(); await f.controller.retry(); await f.controller.review(intent('correct', 1));
  assert.equal(writes(f).length, 3); assert.equal(f.snapshot().status, 'pending');
  assert.strictEqual(writes(f)[0].body, writes(f)[1].body); assert.strictEqual(writes(f)[1].body, writes(f)[2].body);
  assert.deepEqual(writes(f).map(call => call.key), Array(3).fill(input.key));
  pending.resolve(response(writes(f)[0].body, recorded(), { replayed: true })); await third;
  assert.equal(f.snapshot().status, 'succeeded'); assert.equal(f.snapshot().receipt.eventId, input.event.eventId); f.controller.dispose();
});

test('a conflicting or non-replayed rejection receipt cannot settle an earlier unknown attempt', async () => {
  for (const reason of ['event-id-conflict', 'idempotency-key-conflict', 'ledger-revision-conflict', 'record-revision-conflict']) {
    let count = 0; const f = fixture({ respond(call) {
      if (!call.url.endsWith('/events')) return;
      if (++count === 1) throw new ApiError(0, 'lost', 'Lost', true);
      return response(call.body, empty(), { receipt: { eventId: call.body.event.eventId, recordId: 'record_1', cause: 'record',
        outcome: 'rejected', revision: 0, reason, acceptedLedgerRevision: 0 }, replayed: false });
    } });
    await f.controller.review(intent()); await f.controller.send(); await f.controller.retry();
    assert.equal(f.snapshot().status, 'unknown'); assert.equal(f.snapshot().receipt, null); assert.equal(writes(f).length, 2); f.controller.dispose();
  }
});

test('authoritative view and analysis replace together including blocked derivations, lineage and source states', async () => {
  const f = fixture(); await f.controller.read();
  const derived = { id: 'derivation_1', version: 'v1', kind: 'recommendation', scope: contextScope, status: 'blocked',
    value: null, blockedBy: ['unqualified-source'], lineage: [{ recordId: 'record_1', revision: 1, status: 'withdrawn', confirmed: false,
      scope: contextScope, sourceRefs: [reference], qualifications: ['reported-only'] }], recipeLineage: [], comparisonLineage: [],
    comparisonDependencies: [{ kind: 'context', id: 'context_1' }] };
  const current = { ...recorded(), derivations: [derived], sources: [{ recordId: 'record_1', state: 'changed', binding: binding() }] };
  f.view(current); f.witnessRevision(8); await f.controller.read();
  assert.deepEqual(f.snapshot().current, { analysis: analysis(8), result: current });
  const ready = { ...current, projectionRevision: 2, derivations: [{ ...derived, status: 'ready', value: { reported: true }, blockedBy: [] }] };
  f.view(ready); await f.controller.read(); assert.deepEqual(f.snapshot().current.result, ready); f.controller.dispose();
});

test('late reads cannot replace a newer read or acknowledged mutation and cannot settle unknown effects', async () => {
  const first = deferred(), beforeMutation = deferred(); let reads = 0;
  const f = fixture({ respond(call) {
    if (call.url === '/v1/training-feedback') {
      reads++; if (reads === 1) return first.promise; if (reads === 4) return beforeMutation.promise;
    }
  } });
  const old = f.controller.read(); f.witnessRevision(2); await f.controller.read();
  first.resolve({ analysis: analysis(1), result: empty(0) }); await old; assert.equal(f.snapshot().current.analysis.profileRevision, 2);
  await f.controller.review(intent()); const stale = f.controller.read(); await f.controller.send();
  beforeMutation.resolve({ analysis: analysis(1), result: empty() }); await stale;
  assert.equal(f.snapshot().current.result.ledgerRevision, 1); f.controller.dispose();
});

test('changed authoritative view or analysis invalidates unsent review rather than refreshing its body', async () => {
  for (const change of ['ledger', 'analysis']) {
    const f = fixture(); const draft = intent(); await f.controller.review(draft);
    if (change === 'ledger') f.view(empty(1)); else f.witnessRevision(2);
    await f.controller.read(); await f.controller.send();
    assert.equal(f.snapshot().status, 'error'); assert.equal(f.snapshot().error.code, 'training_feedback_review_changed');
    assert.equal(f.snapshot().review, null); assert.deepEqual(f.snapshot().draft, draft); assert.equal(writes(f).length, 0); f.controller.dispose();
  }
  const pending = deferred(); let firstWitness = true;
  const f = fixture({ respond: call => { if (call.url.endsWith('/witness') && firstWitness) { firstWitness = false; return pending.promise; } } });
  const reviewing = f.controller.review(intent()); await drain(); f.witnessRevision(2); await f.controller.read();
  pending.resolve({ analysis: analysis(1), result: witness() }); await reviewing; await f.controller.send();
  assert.equal(f.snapshot().status, 'error'); assert.equal(writes(f).length, 0); f.controller.dispose();
});

test('pending review and mutation publish nothing after sticky owner/auth expiry or disposal', async () => {
  for (const stage of ['review', 'mutation']) for (const expire of ['owner', 'auth', 'dispose']) {
    const pending = deferred();
    const f = fixture({ respond: call => stage === 'review' && call.url.endsWith('/witness') || stage === 'mutation' && call.url.endsWith('/events') ? pending.promise : undefined });
    let operation;
    if (stage === 'review') { operation = f.controller.review(intent()); await drain(); }
    else { await f.controller.review(intent()); operation = f.controller.send(); }
    if (expire === 'dispose') f.controller.dispose(); else f[expire](false);
    const count = f.published.length;
    pending.resolve(stage === 'review' ? { analysis: analysis(), result: witness() } : response(writes(f)[0].body, recorded()));
    await operation; assert.equal(f.published.length, count);
    if (expire !== 'dispose') f[expire](true);
    const requests = f.calls.length; await f.controller.read(); await f.controller.review(intent()); await f.controller.send(); await f.controller.retry();
    assert.equal(f.calls.length, requests); f.controller.dispose();
  }
});

test('presentation guards do not discard the underlying owner attempt', async () => {
  const f = fixture({ respond: call => { if (call.url.endsWith('/events')) throw new ApiError(0, 'lost', 'Lost', true); } });
  await f.controller.review(intent()); await f.controller.send();
  let present = true; const facade = guardTrainingFeedback({ state: f.snapshot(), ...f.controller }, () => present);
  present = false; const count = f.calls.length;
  await facade.read(); await facade.review(intent()); await facade.send(); await facade.retry(); assert.equal(f.calls.length, count);
  assert.equal(f.snapshot().status, 'unknown');
  const currentFacade = guardTrainingFeedback({ state: f.snapshot(), ...f.controller }, () => true);
  await currentFacade.retry(); assert.equal(writes(f).length, 2); assert.strictEqual(writes(f)[0].body, writes(f)[1].body); f.controller.dispose();
});

test('actual hook permanently disposes the captured caller after account, API, generation or owner replacement', async () => {
  for (const replacement of ['accountId', 'api', 'sessionGeneration', 'current']) {
    const f = fixture(), slots = [], cleanups = []; let cursor = 0, ownerCurrent = true;
    react.useRef = value => { const index = cursor++; return slots[index] ??= { current: value }; };
    react.useState = initial => { const index = cursor++; slots[index] ??= { value: typeof initial === 'function' ? initial() : initial };
      return [slots[index].value, value => { slots[index].value = value; }]; };
    react.useEffect = effect => { const index = cursor++; if (!slots[index]) { slots[index] = true; cleanups.push(effect()); } };
    const input = { api: f.api, accountId: 'account_1', sessionGeneration: 'generation_1',
      isCurrentSession: () => ownerCurrent, onUnauthenticated() {} };
    const render = () => { cursor = 0; return useTrainingFeedback(input); };
    const old = render(); assert.equal(f.calls.length, 0); await old.review(intent()); await render().send();
    if (replacement === 'current') ownerCurrent = false;
    else input[replacement] = replacement === 'api' ? { ...f.api } : 'replacement';
    render(); ownerCurrent = true;
    input.api = f.api; input.accountId = 'account_1'; input.sessionGeneration = 'generation_1'; render();
    const count = f.calls.length;
    await old.read(); await old.review(intent('confirm', 1)); await old.send(); await old.retry();
    await render().read(); assert.equal(f.calls.length, count); cleanups.forEach(cleanup => cleanup?.()); f.controller.dispose();
  }
});
