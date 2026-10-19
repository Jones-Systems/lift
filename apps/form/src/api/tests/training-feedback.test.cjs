const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), ts = require('typescript');
function load(name, imports = {}) {
  const module = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../' + name + '.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function('require', 'module', 'exports', code)(name => {
    assert.ok(Object.hasOwn(imports, name), 'Unexpected runtime dependency: ' + name); return imports[name];
  }, module, module.exports);
  return module.exports;
}
const transport = load('transport'), { ApiError, FormTransport } = transport;
const { createTrainingFeedbackCaller } = load('training-feedback', { './transport': transport });
const clone = value => JSON.parse(JSON.stringify(value));
const scope = { kind: 'session', contextId: 'context', sessionId: 'session', planId: 'plan' };
const selection = { sessionId: 'session', occurrenceId: 'occurrence' };
const ref = { sourceId: 'source', revision: '1', locator: 'set:1', qualification: 'observed work only' };
const source = (kind = 'session', id = 'session') => ({ accountId: 'account', kind, id, revision: 1, itemId: 'occurrence' });
const witness = () => ({ contextId: 'context', profileRevision: 0, preferencesRevision: 0,
  sessionSource: { source: source(), sessionStatus: 'completed', planSnapshot: { planId: 'plan', planRevision: 1 },
    occurrence: { id: 'occurrence', itemId: 'item', exerciseId: 'exercise' }, sets: [{ id: 'set', revision: 1, status: 'confirmed' }] },
  targetPlan: { id: 'plan', revision: 1, archived: false } });
const content = () => ({ scope: clone(scope), sourceRefs: [clone(ref)], qualifications: ['Self reported; not clinical'],
  payload: { kind: 'feedback', signals: [
    { dimension: 'rir', state: 'reported', value: 0, unit: null, scale: null },
    { dimension: 'soreness', state: 'missing', reason: 'not-reported' },
  ] } });
const command = () => ({ expectedLedgerRevision: 0, event: { kind: 'record', eventId: 'event', recordId: 'record', expectedRevision: 0, content: content() },
  selection: clone(selection), expectedWitness: witness() });
const record = () => ({ recordId: 'record', revision: 1, status: 'active', confirmed: true, content: content() });
const input = (kind = 'session', id = 'session') => ({
  scope: { source: source(kind, id), exercise: kind === 'session' ? { source: 'global', id: 'exercise' } : { source: 'personal', id: 'exercise', revision: 1 },
    session: kind === 'session' ? { planId: 'plan', planRevision: 1, occurrence: { id: 'occurrence', itemId: 'item', exerciseId: 'exercise' } } : null },
  identity: { id: 'identity', revision: 1, status: 'confirmed', current: true, state: 'qualified' },
});
const summary = () => ({ confirmedSets: 1, repetitions: 5, volumeKgRepetitions: 0, loads: [{ setId: 'set', repetitions: 5, kg: 0 }] });
const comparison = () => ({ status: 'observed', witness: { accountId: 'account', contextId: 'context', witnessVersion: 'progress-comparison-witness-v2',
  inputs: { baseline: input(), current: input('activity', 'activity') }, scope: { baseline: source(), current: source('activity', 'activity') },
  bindings: [{ id: 'identity', revision: 1, status: 'confirmed', current: true }], sourceRefs: [clone(ref)],
  result: { status: 'comparable', policy: 'confirmed-work-comparison-v1', evidenceToken: 'comparison-token', baseline: summary(), current: summary(),
    delta: { confirmedSets: 0, repetitions: 0, volumeKgRepetitions: 0 }, units: { load: 'kg', volume: 'kg-repetitions' }, interpretation: 'observed_work_only' },
  evidenceToken: 'witness-token', interpretation: 'observed_work_only' } });
const derivation = () => ({ id: 'recipe', version: '1', kind: 'recommendation', scope: clone(scope), status: 'blocked', value: null,
  blockedBy: ['authority_unavailable'], lineage: [{ recordId: 'record', revision: 1, status: 'active', confirmed: true, scope: clone(scope), sourceRefs: [clone(ref)], qualifications: ['unadopted'] }],
  recipeLineage: [{ id: 'recipe', version: '1', sourceRefs: [clone(ref)], qualifications: ['unadopted'] }],
  comparisonLineage: [{ registryVersion: '1', registryDigest: 'registry-digest', recipeId: 'recipe', recipeVersion: '1', inputId: 'comparison',
    declaration: { id: 'comparison', contextId: 'context', selections: { baseline: { kind: 'session', id: 'session', itemId: 'occurrence' }, current: { kind: 'activity', id: 'activity', itemId: 'occurrence' } } },
    producer: comparison(), association: { status: 'associated', evidenceToken: 'association-token', sourceRefs: [clone(ref)] }, blockedBy: [] }],
  comparisonDependencies: [{ kind: 'context', id: 'context' }, { kind: 'plan', id: 'plan' }, { kind: 'session', id: 'session' }, { kind: 'activity', id: 'activity' },
    { kind: 'comparisonIdentity', sourceKind: 'activity', sourceId: 'activity', itemId: 'occurrence' }] });
const view = () => ({ ledgerRevision: 1, projectionRevision: 1, records: [record()], derivations: [derivation()],
  sources: [{ recordId: 'record', state: 'current', binding: { scope: clone(scope), selection: clone(selection), witness: witness() } }] });
const envelope = result => ({ analysis: { basis: 'current_profile_and_goals', contextId: 'context', profileRevision: 0, preferencesRevision: 0 }, result });
const mutation = () => ({ receipt: { eventId: 'event', recordId: 'record', cause: 'record', outcome: 'changed', revision: 1, reason: null, acceptedLedgerRevision: 1 }, replayed: false, current: view() });
function fixture() {
  const calls = [], responses = []; let current = true;
  const api = new FormTransport('http://127.0.0.1:47930', { async load() { return null; }, async save() {}, async clear() {} }, async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body });
    assert.ok(responses.length, 'No injected response');
    const next = responses.shift();
    if (next instanceof Error) throw next;
    const response = typeof next === 'function' ? await next() : next;
    return { ok: (response.status ?? 200) < 400, status: response.status ?? 200, headers: new Headers(), json: async () => response.body };
  });
  const caller = createTrainingFeedbackCaller({ api, accountId: 'account', sessionGeneration: 'original',
    isCurrentSession: (account, generation) => current && account === 'account' && generation === 'original' });
  return { api, caller, calls, responses, replace() { current = false; }, restore() { current = true; } };
}
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const invalid = error => error instanceof ApiError && error.code === 'training_feedback_invalid_response';
const unknown = error => error instanceof ApiError && error.effectUnknown && error.originalEffectUnknown;
function frozen(value) { if (value && typeof value === 'object') { assert.ok(Object.isFrozen(value)); Object.values(value).forEach(frozen); } }

test('read preserves complete current view, comparison dependencies, provenance and zero values as detached frozen JSON', async () => {
  const f = fixture(), original = envelope(view()); f.responses.push({ body: original });
  const result = await f.caller.read(); assert.deepEqual(result, original); assert.notEqual(result, original); frozen(result);
  original.result.records[0].content.payload.signals[0].value = 99;
  assert.equal(result.result.records[0].content.payload.signals[0].value, 0);
  assert.equal(result.result.derivations[0].comparisonLineage[0].producer.witness.result.current.loads[0].kg, 0);
  assert.deepEqual(f.calls.map(call => [call.url, call.method, call.body]), [['http://127.0.0.1:47930/v1/training-feedback', 'GET', undefined]]);
});

test('witness and every allowed event shape use exact routes, nullable fields and stable header key', async () => {
  const f = fixture(); f.responses.push({ body: envelope(witness()) });
  assert.deepEqual(await f.caller.witness({ scope, selection }), envelope(witness()));
  assert.equal(f.calls[0].url, 'http://127.0.0.1:47930/v1/training-feedback/witness');
  assert.deepEqual(JSON.parse(f.calls[0].body), { scope, selection });
  for (const kind of ['record', 'correct', 'confirm', 'withdraw', 'undo']) {
    const value = command(); value.event.kind = kind;
    if (!['record', 'correct'].includes(kind)) delete value.event.content;
    if (kind === 'undo') value.event.targetEventId = 'original-event';
    if (['withdraw', 'undo'].includes(kind)) { value.selection = null; value.expectedWitness = null; }
    const response = mutation(); response.receipt.cause = kind; f.responses.push({ body: envelope(response) });
    await f.caller.prepareEvent(value, 'key:' + kind).run();
    assert.equal(f.calls.at(-1).url, 'http://127.0.0.1:47930/v1/training-feedback/events');
    assert.equal(f.calls.at(-1).headers['Idempotency-Key'], 'key:' + kind);
    assert.deepEqual(JSON.parse(f.calls.at(-1).body), value); assert.equal(Object.hasOwn(value.event, 'accountId'), false);
  }
});

test('comparison unavailable, unknown, incomparable, null-load and missing identity branches remain explicit', async () => {
  const variants = [
    line => { line.producer = { status: 'unavailable', reason: 'reader_unavailable', side: 'baseline' }; line.association = null; },
    line => { line.producer = { status: 'unavailable', reason: 'source_missing', side: 'current' }; },
    line => { line.producer = { status: 'unavailable', reason: 'item_missing', side: 'baseline' }; },
    line => { line.producer = null; line.declaration = null; line.registryVersion = null; line.association = { status: 'unavailable', reason: 'association_unproved' }; },
    line => { line.producer.witness.result = { policy: 'confirmed-work-comparison-v1', evidenceToken: 't', status: 'unknown', reasons: ['identity_unknown'] };
      line.producer.witness.inputs.baseline.identity = { id: null, revision: null, status: 'missing', current: false, state: 'missing' };
      line.producer.witness.inputs.baseline.scope.exercise = null; line.producer.witness.inputs.baseline.scope.session.occurrence = null; },
    line => { line.producer.witness.result = { policy: 'confirmed-work-comparison-v1', evidenceToken: 't', status: 'incomparable', reasons: ['identity_provenance_mismatch'] }; },
    line => { const result = line.producer.witness.result; result.baseline.volumeKgRepetitions = null; result.current.volumeKgRepetitions = null;
      result.baseline.loads[0].kg = null; result.current.loads[0].kg = null; result.delta.volumeKgRepetitions = null; },
  ];
  for (const change of variants) {
    const f = fixture(), value = envelope(view()); change(value.result.derivations[0].comparisonLineage[0]);
    f.responses.push({ body: value }); assert.deepEqual(await f.caller.read(), value);
  }
});

test('strict response codecs reject unknown or missing fields throughout lineage and foreign account sources', async () => {
  const changes = [
    v => { v.extra = 1; }, v => { v.analysis.basis = 'clinical'; }, v => { v.analysis.profileRevision = -1; },
    v => { delete v.result.projectionRevision; }, v => { v.result.records[0].extra = true; },
    v => { v.result.sources[0].binding.witness.sessionSource.source.accountId = 'replacement'; },
    v => { v.result.derivations[0].lineage[0].sourceRefs[0].sourceReference = 'alias'; },
    v => { delete v.result.derivations[0].comparisonDependencies; },
    v => { v.result.derivations[0].comparisonLineage[0].opaque = {}; },
    v => { v.result.derivations[0].comparisonLineage[0].producer.witness.witnessVersion = 'v1'; },
    v => { v.result.derivations[0].comparisonLineage[0].producer.witness.accountId = 'replacement'; },
    v => { v.result.derivations[0].comparisonLineage[0].producer.witness.inputs.current.scope.session = {}; },
    v => { delete v.result.derivations[0].comparisonLineage[0].producer.witness.inputs.baseline.identity.state; },
    v => { v.result.derivations[0].comparisonLineage[0].producer.witness.result.units.load = 'lb'; },
    v => { v.result.derivations[0].comparisonLineage[0].producer.witness.result = { policy: 'confirmed-work-comparison-v1', evidenceToken: 't', status: 'unknown', reasons: ['identity_provenance_mismatch'] }; },
    v => { v.result.derivations[0].comparisonLineage[0].association.status = 'assumed'; },
    v => { v.result.derivations[0].comparisonDependencies[0].kind = 'unknown'; },
  ];
  for (const change of changes) { const f = fixture(), value = envelope(view()); change(value); f.responses.push({ body: value }); await assert.rejects(f.caller.read(), invalid); }
});

test('request validation rejects getters, symbols, prototypes, sparse arrays, cycles and nonfinite JSON without dispatch', () => {
  const bad = []; let getters = 0;
  const getter = command(); Object.defineProperty(getter, 'selection', { enumerable: true, get() { getters++; return null; } }); bad.push(getter);
  const symbol = command(); symbol[Symbol('hidden')] = true; bad.push(symbol);
  const proto = command(); Object.setPrototypeOf(proto, { inherited: true }); bad.push(proto);
  const sparse = command(); sparse.event.content.qualifications = Array(1); bad.push(sparse);
  const cycle = command(); cycle.event.content.payload = { kind: 'edit', field: 'x', before: cycle, after: null }; bad.push(cycle);
  for (const value of [NaN, Infinity, undefined, () => {}, 1n]) { const c = command(); c.event.content.payload.signals[0].value = value; bad.push(c); }
  const f = fixture(); for (const c of bad) assert.throws(() => f.caller.prepareEvent(c, 'key'), /Check the training feedback fields/);
  assert.equal(f.calls.length, 0); assert.equal(getters, 0);
});

test('request bounds mirror HTTP schema including payload depth nodes arrays keys and full UTF8 body', () => {
  const changes = [
    c => { c.event.eventId = 'x'.repeat(161); }, c => { c.event.recordId = ' '; }, c => { c.event.kind = 'delete'; },
    c => { c.event.accountId = 'account'; }, c => { delete c.selection; }, c => { delete c.expectedWitness; },
    c => { c.expectedLedgerRevision = -1; }, c => { c.expectedWitness.sessionSource.source.accountId = 'foreign'; },
    c => { c.event.content.sourceRefs = []; }, c => { c.event.content.sourceRefs = Array(65).fill(ref); },
    c => { c.event.content.qualifications = Array(33).fill('q'); }, c => { c.event.content.qualifications = []; },
    c => { c.event.content.payload.signals = []; }, c => { c.event.content.payload.signals = Array(33).fill(c.event.content.payload.signals[0]); },
    c => { c.event.content.qualifications = ['x'.repeat(4097)]; },
    c => { c.expectedWitness.sessionSource.sets = Array.from({ length: 257 }, (_, i) => ({ id: String(i), revision: 1, status: 'draft' })); },
    c => { c.expectedWitness.sessionSource.sets.push(clone(c.expectedWitness.sessionSource.sets[0])); },
    c => { let v = 0; for (let i = 0; i < 9; i++) v = [v]; c.event.content.payload.signals[0].value = v; },
    c => { c.event.content.payload.signals[0].value = Array(128).fill(Array(16).fill(0)); },
    c => { c.event.content.payload.signals[0].value = Array(129).fill(0); },
    c => { c.event.content.payload.signals[0].value = Object.fromEntries(Array.from({ length: 65 }, (_, i) => [String(i), 0])); },
    c => { c.event.content.payload.signals[0].value = { ['x'.repeat(129)]: 0 }; },
    c => { c.event.content.qualifications = Array(32).fill('界'.repeat(4096)); },
    c => { c.event.content.payload.signals[0].value = null; },
  ];
  const f = fixture();
  for (const change of changes) { const c = command(); change(c); assert.throws(() => f.caller.prepareEvent(c, 'key'), /Check the training feedback fields/); }
  for (const key of ['', 'x'.repeat(129), ' key', '-key', 'key/other']) assert.throws(() => f.caller.prepareEvent(command(), key), /valid idempotency key/);
  assert.throws(() => f.caller.witness({ scope, selection, extra: true }), /Check the training feedback fields/);
  assert.equal(f.calls.length, 0);
});

test('valid request boundaries and edit nulls are retained without coercion', async () => {
  const f = fixture(), c = command(); c.event.eventId = 'x'.repeat(160);
  c.event.content.payload = { kind: 'edit', field: 'work', before: null, after: { value: false, zero: 0, empty: '', items: Array(128).fill(null) } };
  c.event.content.sourceRefs = Array(64).fill(ref); c.event.content.qualifications = Array(32).fill('q');
  c.expectedWitness.sessionSource.sets = Array.from({ length: 256 }, (_, i) => ({ id: String(i), revision: 1, status: 'draft' }));
  const response = mutation(); response.receipt.eventId = c.event.eventId; f.responses.push({ body: envelope(response) });
  await f.caller.prepareEvent(c, 'x'.repeat(128)).run(); assert.deepEqual(JSON.parse(f.calls[0].body), c);
});

test('immutable same-key retry resolves lost acknowledgement with original receipt and fresh blocked current analysis', async () => {
  const f = fixture(), value = command(), original = clone(value), attempt = f.caller.prepareEvent(value, 'stable:key');
  assert.ok(Object.isFrozen(attempt)); value.event.content.payload.signals[0].value = 99; value.expectedLedgerRevision = 99;
  f.responses.push(new Error('lost acknowledgement')); await assert.rejects(attempt.run(), unknown);
  const recovered = envelope(mutation()); recovered.result.replayed = true; recovered.analysis.profileRevision = 2;
  recovered.analysis.preferencesRevision = 3; recovered.result.current.projectionRevision = 8;
  recovered.result.current.derivations[0].status = 'blocked'; recovered.result.current.derivations[0].blockedBy = ['source_changed'];
  f.responses.push({ body: recovered }); const result = await attempt.run(); assert.deepEqual(result, recovered); frozen(result);
  assert.equal(f.calls.length, 2); assert.equal(f.calls[0].body, f.calls[1].body);
  assert.deepEqual(JSON.parse(f.calls[1].body), original); assert.equal(f.calls[1].headers['Idempotency-Key'], 'stable:key');
});

test('later HTTP rejection, conflict, unavailable and successful read do not settle original unknown', async () => {
  const f = fixture(), attempt = f.caller.prepareEvent(command(), 'key');
  f.responses.push(new Error('lost')); await assert.rejects(attempt.run(), unknown);
  for (const status of [422, 409, 501]) {
    f.responses.push({ status, body: { error: { code: 'rejected', message: 'Rejected' } } }); await assert.rejects(attempt.run(), unknown);
  }
  f.responses.push({ body: envelope(view()) }); await f.caller.read();
  for (const reason of ['source-witness-required', 'idempotency-key-conflict', 'event-id-conflict', 'ledger-revision-conflict']) {
    const result = mutation(); result.receipt.outcome = 'rejected'; result.receipt.reason = reason;
    f.responses.push({ body: envelope(result) }); await assert.rejects(attempt.run(), unknown);
  }
  const original = mutation(); original.replayed = true; original.receipt.outcome = 'rejected'; original.receipt.reason = 'source-witness-required';
  f.responses.push({ body: envelope(original) }); assert.equal((await attempt.run()).result.receipt.outcome, 'rejected');
});

test('first definite domain rejection differs from a lost effect, and conflicts never prove original acceptance', async () => {
  const f = fixture(), attempt = f.caller.prepareEvent(command(), 'key');
  f.responses.push({ status: 422, body: { error: { code: 'invalid', message: 'Invalid' } } });
  await assert.rejects(attempt.run(), error => error instanceof ApiError && !error.effectUnknown && !error.originalEffectUnknown);
  const rejected = mutation(); rejected.receipt.outcome = 'rejected'; rejected.receipt.reason = 'source-witness-required';
  f.responses.push({ body: envelope(rejected) }); assert.equal((await attempt.run()).result.receipt.outcome, 'rejected');
  f.responses.push(new Error('lost')); await assert.rejects(attempt.run(), unknown);
  rejected.replayed = true; rejected.receipt.reason = 'idempotency-key-conflict';
  f.responses.push({ body: envelope(rejected) }); await assert.rejects(attempt.run(), unknown);
});

test('malformed or mismatched success and server failure remain unknown until matching receipt', async () => {
  for (const change of [r => { r.receipt.eventId = 'different'; }, r => { r.receipt.recordId = 'different'; }, r => { r.receipt.cause = 'undo'; },
    r => { r.receipt.extra = true; }, r => { delete r.current.derivations[0].lineage; }]) {
    const f = fixture(), attempt = f.caller.prepareEvent(command(), 'key'), result = mutation(); change(result);
    f.responses.push({ body: envelope(result) }); await assert.rejects(attempt.run(), unknown);
    f.responses.push({ status: 503, body: { error: { code: 'unavailable' } } }); await assert.rejects(attempt.run(), unknown);
    f.responses.push({ body: envelope(mutation()) }); assert.equal((await attempt.run()).result.receipt.eventId, 'event');
  }
});

test('replacement session and disposal fence late success or error and prevent retry dispatch', async () => {
  for (const change of ['replace', 'dispose', 'auth']) for (const outcome of ['success', 'error']) {
    const f = fixture(), gate = deferred(), attempt = f.caller.prepareEvent(command(), 'key');
    f.responses.push(() => gate.promise); const pending = attempt.run();
    try {
      if (change === 'replace') f.replace(); else if (change === 'dispose') f.caller.dispose();
      else { f.responses.push({ body: { status: false } }); await assert.rejects(f.api.signIn('synthetic@invalid.test', 'synthetic')); }
      if (outcome === 'success') gate.resolve({ body: envelope(mutation()) }); else gate.reject(new Error('late failure'));
      await assert.rejects(pending, unknown); const count = f.calls.length;
      f.restore(); await assert.rejects(attempt.run(), unknown); assert.equal(f.calls.length, count);
    } finally { gate.resolve({ body: envelope(mutation()) }); await pending.catch(() => {}); }
  }
});

test('late read and witness responses cannot publish into replacement or disposed session', async () => {
  for (const operation of ['read', 'witness']) for (const end of ['replace', 'dispose']) {
    const f = fixture(), gate = deferred(); f.responses.push(() => gate.promise);
    const pending = operation === 'read' ? f.caller.read() : f.caller.witness({ scope, selection });
    if (end === 'replace') f.replace(); else f.caller.dispose();
    gate.resolve({ body: envelope(operation === 'read' ? view() : witness()) });
    await assert.rejects(pending, error => error.code === 'session_changed');
    const count = f.calls.length; await assert.rejects(f.caller.read(), error => error.code === 'session_changed'); assert.equal(f.calls.length, count);
  }
});

test('parallel calls on one attempt do not dispatch a second mutation or replace its intent', async () => {
  const f = fixture(), gate = deferred(), attempt = f.caller.prepareEvent(command(), 'key');
  f.responses.push(() => gate.promise); const pending = attempt.run();
  try {
    await assert.rejects(attempt.run(), error => error.code === 'training_feedback_attempt_pending'); assert.equal(f.calls.length, 1);
    gate.resolve({ body: envelope(mutation()) }); await pending;
  } finally { gate.resolve({ body: envelope(mutation()) }); await pending.catch(() => {}); }
});

test('response accessors and unsupported JSON never invoke getters or escape the closed codec', async () => {
  let getters = 0;
  const variants = [
    value => { Object.defineProperty(value.result, 'records', { enumerable: true, get() { getters++; return []; } }); },
    value => { value.result[Symbol('hidden')] = true; }, value => { value.result.records = Array(1); },
    value => { value.result.derivations[0].value = value; }, value => { value.result.derivations[0].value = Infinity; },
    value => { Object.setPrototypeOf(value.result, { inherited: true }); },
  ];
  for (const change of variants) { const f = fixture(), value = envelope(view()); change(value); f.responses.push({ body: value }); await assert.rejects(f.caller.read(), invalid); }
  assert.equal(getters, 0);
});

test('nullable witnesses, historical source states and ready derivations retain their complete shapes', async () => {
  const f = fixture();
  for (const scope of [{ kind: 'context', contextId: 'context' }, { kind: 'plan', contextId: 'context', planId: 'plan' },
    { kind: 'session', contextId: 'context', sessionId: 'session', planId: null }]) {
    const value = { contextId: 'context', profileRevision: 0, preferencesRevision: 0, sessionSource: null, targetPlan: null };
    f.responses.push({ body: envelope(value) }); assert.deepEqual((await f.caller.witness({ scope, selection: null })).result, value);
  }
  const value = view(); value.records[0].status = 'withdrawn'; value.records[0].confirmed = false; value.records[0].content = null;
  value.sources[0].state = 'unbound'; value.sources[0].binding = null;
  value.derivations[0].kind = 'history'; value.derivations[0].status = 'ready'; value.derivations[0].value = { observed: false, count: 0, unknown: null };
  value.derivations[0].blockedBy = []; value.derivations[0].lineage[0].status = 'missing'; value.derivations[0].lineage[0].scope = null;
  value.derivations[0].lineage[0].sourceRefs = []; value.derivations[0].lineage[0].qualifications = [];
  f.responses.push({ body: envelope(value) }); assert.deepEqual((await f.caller.read()).result, value);
});

test('original session loss before dispatch remains definite and never borrows a replacement session', async () => {
  const f = fixture(), attempt = f.caller.prepareEvent(command(), 'key'); f.replace();
  await assert.rejects(attempt.run(), error => error.code === 'session_changed' && !error.originalEffectUnknown);
  f.restore(); await assert.rejects(f.caller.read(), error => error.code === 'session_changed');
  assert.throws(() => f.caller.prepareEvent(command(), 'another'), error => error.code === 'session_changed');
  assert.equal(f.calls.length, 0);
});
