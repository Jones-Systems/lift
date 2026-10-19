const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const ts = require('typescript');

// Execute production JS admission/validation with scripted native responses.
// The fixtures do not implement or prove the Swift journal, aggregation or Apple API.
const compiled = new Map(['healthKit', 'healthKit.query'].map(name => [name, ts.transpileModule(
  readFileSync(join(__dirname, '../' + name + '.ts'), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText]));
const journalId = '11111111-1111-4111-8111-111111111111';
const incarnation = '22222222-2222-4222-8222-222222222222';
const nextCursor = 'hk1:' + journalId + ':33333333-3333-4333-8333-333333333333';
const id = 'hk1:' + 'a'.repeat(64) + ':' + incarnation;
const baseContext = {
  accountId: 'account-a', sessionGeneration: 'session-a', connectionId: 'connection-a', generation: 3,
  deviceGeneration: 'device-generation-a', type: 'steps', from: '2026-10-01T00:00:00.000Z',
  to: '2026-10-03T00:00:00.000Z', timeZone: 'UTC', normalizationVersion: 1,
};
const clone = value => structuredClone(value);
const stream = ctx => JSON.stringify(['healthkit-v1', ctx.type, ctx.from, ctx.to]);
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function output(ctx = baseContext) {
  return {
    records: [{
      id, kind: 'daily', type: ctx.type, day: '2026-10-01', zone: ctx.timeZone,
      start: ctx.from, end: '2026-10-02T00:00:00.000Z', sourceBundleId: 'test.synthetic.source',
      sourceName: 'Synthetic source', deviceModel: null, algorithm: null, originalId: null,
      revision: { token: 'hk1:' + journalId + ':1', order: 1 }, quality: 'unknown',
      values: [{ metric: 'steps', value: 123, unit: 'count', aggregation: 'sum' }],
    }],
    tombstones: [], anchor: nextCursor, more: false, logicalBucketsComplete: true,
  };
}
function fixture(options = {}) {
  const ctx = { ...baseContext, ...options.context };
  const calls = [];
  let current = true, cursor = options.cursor ?? null, serial = 1, revisionOrder = 0;
  let result = options.output ?? output(ctx);
  const handlers = new Set();
  const lifecycle = {
    currentState: 'active',
    addEventListener: (_, handler) => { handlers.add(handler); return { remove: () => handlers.delete(handler) }; },
    emit: state => { for (const handler of handlers) handler(state); },
  };
  const makeReceipt = cp => ({
    version: 1, context: clone(ctx), contextId: 'b'.repeat(64), journalId,
    journalSerial: serial, revisionOrder, stream: cp.stream, cursor: cp.cursor,
  });
  const native = {
    availability: async () => 'available',
    requestRead: async () => 'unnecessary',
    cancelAll: async () => { calls.push(['cancel']); },
    bindQueryContext: async (context, cp, mode) => { calls.push(['bind', clone(context), clone(cp), mode]); return makeReceipt(cp); },
    reconcileQueryCheckpoint: async (contextId, cp) => { calls.push(['reconcile', contextId, clone(cp)]); return makeReceipt(cp); },
    query: async input => {
      calls.push(['query', clone(input)]);
      serial = 2; revisionOrder = 1;
      return clone(result);
    },
    forgetQueryContext: async (...args) => { calls.push(['forget', ...clone(args)]); },
  };
  const owner = {
    context: ctx,
    checkpoint: { read: async () => { calls.push(['checkpoint']); return { stream: stream(ctx), cursor }; } },
    isCurrentSession: () => current,
  };
  const cache = new Map();
  class FormNativeError extends Error { constructor(code, message) { super(message); this.code = code; } }
  function load(name) {
    if (cache.has(name)) return cache.get(name).exports;
    const module = { exports: {} }; cache.set(name, module);
    new Function('require', 'module', 'exports', compiled.get(name))(dependency => {
      if (dependency === './runtime') return { FormNativeError };
      if (dependency === './healthKit') return load('healthKit');
      if (dependency === 'react-native') return { AppState: lifecycle, Platform: { OS: 'ios' } };
      assert.equal(dependency, 'expo');
      return { isRunningInExpoGo: () => false, requireOptionalNativeModule: () => native };
    }, module, module.exports);
    return module.exports;
  }
  const { FormHealthQuerySource } = load('healthKit.query');
  const adapter = new FormHealthQuerySource({ module: native }, lifecycle);
  const input = () => ({ type: ctx.type, from: ctx.from, to: ctx.to, anchor: cursor, limit: 100 });
  return {
    ctx, calls, native, owner, adapter, input, lifecycle, makeReceipt,
    publicAPI: load('healthKit'), result: value => { result = value; },
    revision: value => { revisionOrder = value; },
    acknowledge: value => { cursor = value; }, current: value => { current = value; },
    bind: mode => adapter.bindContext(owner, mode ?? 'create_connection'),
    proof: () => ({ accountId: ctx.accountId, connectionId: ctx.connectionId, generation: ctx.generation,
      deviceGeneration: ctx.deviceGeneration, receiptId: 'confirmed-purge-receipt' }),
  };
}

test('the source seam does not activate the public importer capability', async () => {
  const f = fixture();
  assert.equal(f.adapter.capabilities.query, false);
  assert.equal((await f.publicAPI.getHealthKitCapabilities({ module: f.native })).query, false);
  const publicAdapter = new f.publicAPI.FormHealthAdapter({ module: f.native });
  await assert.rejects(publicAdapter.query(f.input()), { code: 'health_query_unavailable' });
  await assert.rejects(f.adapter.query(f.input()), { code: 'health_context_unbound' });
  await publicAdapter.dispose(); await f.adapter.dispose();
});

test('binding supplies exact context and acknowledged cursor; accepted pages are detached and immutable on replay', async () => {
  const f = fixture();
  const bound = await f.bind();
  assert.equal(bound.cursor, null);
  assert.deepEqual(f.calls.find(call => call[0] === 'bind'), ['bind', f.ctx, { stream: stream(f.ctx), cursor: null }, 'create_connection']);
  bound.context.accountId = 'consumer mutation';
  const first = await f.adapter.query(f.input());
  first.records[0].values[0].value = 999;
  assert.equal((await f.adapter.query(f.input())).records[0].values[0].value, 123);
  assert.equal((await f.adapter.reconcileCheckpoint()).cursor, null);
  f.acknowledge(nextCursor);
  assert.equal((await f.adapter.reconcileCheckpoint()).cursor, nextCursor);
  await f.adapter.dispose();
});

test('resume failures never fall back to creating an empty journal', async () => {
  for (const code of ['health_journal_missing', 'health_journal_invalid', 'health_unknown_deletion', 'health_checkpoint_mismatch']) {
    const f = fixture({ cursor: nextCursor });
    f.native.bindQueryContext = async (_, cp, mode) => { f.calls.push(['bind-mode', mode]); throw Object.assign(new Error(code), { code }); };
    await assert.rejects(f.bind('resume'), { code });
    assert.deepEqual(f.calls.filter(call => call[0] === 'bind-mode'), [['bind-mode', 'resume']]);
    await assert.rejects(f.adapter.query(f.input()), { code: 'health_context_unbound' });
    await f.adapter.dispose();
  }
});

test('foreign or nonempty create checkpoints fail before native creation', async () => {
  for (const cp of [{ stream: 'foreign-stream', cursor: null }, { stream: stream(baseContext), cursor: 'foreign' },
    { stream: stream(baseContext), cursor: nextCursor }, { stream: stream(baseContext), cursor: null, extra: true }]) {
    const f = fixture();
    f.owner.checkpoint.read = async () => cp;
    await assert.rejects(f.bind());
    assert.equal(f.calls.some(call => call[0] === 'bind'), false);
    await f.adapter.dispose();
  }
});

test('invalid, changed or foreign journal receipts are rejected', async () => {
  for (const mutate of [
    value => { value.context.accountId = 'account-b'; },
    value => { value.context.sessionGeneration = 'session-b'; },
    value => { value.context.timeZone = 'America/New_York'; },
    value => { value.context.normalizationVersion = 2; },
    value => { value.journalSerial = -1; },
    value => { value.revisionOrder = Number.MAX_SAFE_INTEGER + 1; },
    value => { value.extra = true; },
  ]) {
    const f = fixture();
    f.native.bindQueryContext = async (_, cp) => { const result = f.makeReceipt(cp); mutate(result); return result; };
    await assert.rejects(f.bind());
    await assert.rejects(f.adapter.query(f.input()), { code: 'health_context_unbound' });
    await f.adapter.dispose();
  }
});

test('query input cannot change window, type, cursor, limit or closed shape', async () => {
  const f = fixture(); await f.bind();
  for (const change of [{ type: 'sleep' }, { from: '2026-10-02T00:00:00.000Z' }, { to: '2026-10-04T00:00:00.000Z' },
    { anchor: nextCursor }, { limit: 0 }, { limit: 101 }, { limit: 1.5 }, { extra: true }]) {
    await assert.rejects(f.adapter.query({ ...f.input(), ...change }));
  }
  assert.equal(f.calls.some(call => call[0] === 'query'), false);
  await f.adapter.dispose();
});

test('page validation rejects partial buckets, raw tombstones, bad revisions and forged metric shapes', async () => {
  const mutations = [
    value => { value.logicalBucketsComplete = false; },
    value => { value.extra = true; },
    value => { value.anchor = null; },
    value => { value.records[0].extra = true; },
    value => { value.records[0].type = 'sleep'; },
    value => { value.records[0].zone = 'America/New_York'; },
    value => { value.records[0].day = '2026-10-02'; },
    value => { value.records[0].start = '2026-10-01T00:00:01.000Z'; },
    value => { value.records[0].revision.order = 0; },
    value => { value.records[0].revision.token = 'HKSourceRevision:app-version'; },
    value => { value.records[0].revision.order = 2; value.records[0].revision.token = 'hk1:' + journalId + ':2'; },
    value => { value.records[0].values[0].unit = 'ms'; },
    value => { value.records[0].values[0].aggregation = 'mean'; },
    value => { value.records[0].values[0].value = -1; },
    value => { value.records[0].values[0].value = NaN; },
    value => { value.records[0].values = []; },
    value => { value.records.push(clone(value.records[0])); },
    value => { value.tombstones = [{ id: incarnation, revision: value.records[0].revision }]; },
    value => { value.tombstones = [{ id: id + ':steps', revision: value.records[0].revision }]; },
    value => { value.tombstones = [{ id: id + ':sleep_asleep', revision: value.records[0].revision }]; },
  ];
  for (const mutate of mutations) {
    const result = output(); mutate(result);
    const f = fixture({ output: result }); await f.bind();
    await assert.rejects(f.adapter.query(f.input()));
    await f.adapter.dispose();
  }
});

test('normalized tombstones and new incarnations can coexist without resurrecting the old normalized id', async () => {
  const result = output();
  const old = 'hk1:' + 'a'.repeat(64) + ':44444444-4444-4444-8444-444444444444';
  result.tombstones = [{ id: old + ':steps', revision: clone(result.records[0].revision) }];
  const f = fixture({ output: result }); await f.bind();
  assert.deepEqual(await f.adapter.query(f.input()), result);
  await f.adapter.dispose();
});

test('multi-metric retirement accepts a new incarnation and rejects later resurrection of either retired id', async () => {
  const old = 'hk1:' + 'a'.repeat(64) + ':44444444-4444-4444-8444-444444444444';
  const result = output();
  result.records[0].type = 'sleep';
  result.records[0].values = [{ metric: 'sleep_in_bed', value: 4000, unit: 's', aggregation: 'interval_union' }];
  result.tombstones = ['sleep_asleep', 'sleep_in_bed'].map(metric => ({
    id: old + ':' + metric, revision: clone(result.records[0].revision),
  }));
  const f = fixture({ context: { type: 'sleep' }, output: result }); await f.bind();
  assert.deepEqual(await f.adapter.query(f.input()), result);
  f.acknowledge(nextCursor);
  const revived = clone(result);
  revived.anchor = 'hk1:' + journalId + ':55555555-5555-4555-8555-555555555555';
  revived.tombstones = [];
  revived.records[0].id = old;
  revived.records[0].revision = { token: 'hk1:' + journalId + ':2', order: 2 };
  f.result(revived);
  const query = f.native.query;
  f.native.query = async input => { const value = await query(input); f.revision(2); return value; };
  for (const metric of ['sleep_asleep', 'sleep_in_bed']) {
    revived.records[0].values[0].metric = metric;
    f.result(revived);
    await assert.rejects(f.adapter.query(f.input()), { code: 'health_incarnation_reused' });
  }
  await f.adapter.dispose();
});

test('connection revision order cannot decrease on a newly acknowledged page', async () => {
  const f = fixture(); await f.bind(); await f.adapter.query(f.input());
  f.acknowledge(nextCursor);
  const stale = output();
  stale.anchor = 'hk1:' + journalId + ':55555555-5555-4555-8555-555555555555';
  f.result(stale);
  await assert.rejects(f.adapter.query(f.input()), { code: 'health_revision_invalid' });
  await f.adapter.dispose();
});

test('sleep and workout responses retain their exact supported metrics and semantics', async () => {
  for (const type of ['sleep', 'workouts']) {
    const result = output(); result.records[0].type = type;
    if (type === 'sleep') {
      result.records[0].values = [{ metric: 'sleep_asleep', value: 3600, unit: 's', aggregation: 'interval_union' },
        { metric: 'sleep_in_bed', value: 4000, unit: 's', aggregation: 'interval_union' }];
    } else {
      Object.assign(result.records[0], { kind: 'workout', originalId: incarnation,
        start: '2026-10-01T12:00:00.000Z', end: '2026-10-01T13:00:00.000Z' });
      result.records[0].values = [{ metric: 'workout_duration', value: 3600, unit: 's', aggregation: 'workout' },
        { metric: 'workout_energy', value: 100, unit: 'kcal', aggregation: 'workout' },
        { metric: 'workout_distance', value: 1000, unit: 'm', aggregation: 'workout' }];
    }
    const f = fixture({ context: { type }, output: result }); await f.bind();
    assert.deepEqual(await f.adapter.query(f.input()), result);
    await f.adapter.dispose();
  }
});

test('calendar-day validation accepts a complete 25-hour DST day', async () => {
  const ctx = { ...baseContext, from: '2026-11-01T04:00:00.000Z', to: '2026-11-02T05:00:00.000Z', timeZone: 'America/New_York' };
  const result = output(ctx);
  Object.assign(result.records[0], { day: '2026-11-01', start: ctx.from, end: ctx.to });
  const f = fixture({ context: ctx, output: result }); await f.bind();
  assert.deepEqual(await f.adapter.query(f.input()), result);
  await f.adapter.dispose();
});

test('changed replay content is rejected even when native reuses the same cursor', async () => {
  const f = fixture(); await f.bind(); await f.adapter.query(f.input());
  const changed = output(); changed.records[0].values[0].value += 1; f.result(changed);
  await assert.rejects(f.adapter.query(f.input()), { code: 'health_replay_changed' });
  await f.adapter.dispose();
});

test('native reconciliation errors propagate without fabricated pages or local acknowledgements', async () => {
  for (const code of ['health_unknown_deletion', 'health_missing_survivors', 'health_store_changed', 'health_journal_capacity']) {
    const f = fixture(); await f.bind();
    f.native.query = async () => { throw Object.assign(new Error(code), { code }); };
    await assert.rejects(f.adapter.query(f.input()), { code });
    assert.equal((await f.adapter.reconcileCheckpoint()).cursor, null);
    await f.adapter.dispose();
  }
});

test('cancellation during checkpoint loading prevents native binding and late callbacks cannot reactivate it', async () => {
  const f = fixture(), read = deferred(), started = deferred();
  f.owner.checkpoint.read = () => { started.resolve(); return read.promise; };
  const pending = f.bind(); const rejected = assert.rejects(pending, { code: 'health_cancelled' });
  await started.promise; await f.adapter.cancelAll(); await rejected;
  read.resolve({ stream: stream(f.ctx), cursor: null });
  await Promise.resolve();
  assert.equal(f.calls.some(call => call[0] === 'bind'), false);
  await assert.rejects(f.adapter.query(f.input()), { code: 'health_context_unbound' });
  await f.adapter.dispose();
});

test('background or account changes fence a native page already in flight', async () => {
  for (const action of ['background', 'account']) {
    const f = fixture(); await f.bind();
    const pending = deferred(), started = deferred();
    f.native.query = () => { started.resolve(); return pending.promise; };
    const query = f.adapter.query(f.input());
    const rejected = assert.rejects(query, { code: action === 'background' ? 'health_cancelled' : 'health_context_changed' });
    await started.promise;
    if (action === 'background') { f.lifecycle.emit('background'); await f.adapter.cancelAll(); }
    else f.current(false);
    pending.resolve(output()); await rejected;
    assert.equal(f.adapter.capabilities.query, false);
    await f.adapter.dispose();
  }
});

test('a checkpoint changing during query holds delivery and never calls an upload API', async () => {
  const f = fixture(); await f.bind();
  const original = f.native.query;
  f.native.query = async input => { const result = await original(input); f.acknowledge(nextCursor); return result; };
  await assert.rejects(f.adapter.query(f.input()), { code: 'health_checkpoint_changed' });
  await f.adapter.dispose();
});

test('an unknown acknowledged successor is held by native reconciliation before another query', async () => {
  const f = fixture(); await f.bind(); await f.adapter.query(f.input());
  f.acknowledge('hk1:' + journalId + ':55555555-5555-4555-8555-555555555555');
  f.native.reconcileQueryCheckpoint = async () => {
    throw Object.assign(new Error('unissued cursor'), { code: 'health_checkpoint_mismatch' });
  };
  const queries = f.calls.filter(call => call[0] === 'query').length;
  await assert.rejects(f.adapter.query(f.input()), { code: 'health_checkpoint_mismatch' });
  assert.equal(f.calls.filter(call => call[0] === 'query').length, queries);
  await f.adapter.dispose();
});

test('reconciliation serializes source work and fences a changed session before native admission', async () => {
  const f = fixture(); await f.bind();
  const read = deferred(), started = deferred();
  f.owner.checkpoint.read = () => { started.resolve(); return read.promise; };
  const reconciles = f.calls.filter(call => call[0] === 'reconcile').length;
  const pending = f.adapter.reconcileCheckpoint();
  const rejected = assert.rejects(pending, { code: 'health_context_changed' });
  await started.promise;
  await assert.rejects(f.adapter.query(f.input()), { code: 'health_busy' });
  await assert.rejects(f.adapter.forgetAfterConfirmedPurge(f.proof()), { code: 'health_busy' });
  f.current(false); read.resolve({ stream: stream(f.ctx), cursor: null });
  await rejected;
  assert.equal(f.calls.filter(call => call[0] === 'reconcile').length, reconciles);
  await f.adapter.dispose();
});

test('scoped purge is separate from cancel; an unknown purge retries only its original receipt', async () => {
  const f = fixture(); await f.bind(); await f.adapter.query(f.input());
  const proof = f.proof();
  await assert.rejects(f.adapter.forgetAfterConfirmedPurge({ ...proof, accountId: 'other' }), { code: 'health_purge_mismatch' });
  assert.equal(f.calls.some(call => call[0] === 'forget'), false);
  let tries = 0;
  f.native.forgetQueryContext = async (...args) => {
    f.calls.push(['forget', ...clone(args)]);
    tries += 1;
    if (tries === 1) throw Object.assign(new Error('unknown'), { code: 'health_journal_effect_unknown' });
  };
  await assert.rejects(f.adapter.forgetAfterConfirmedPurge(proof), { code: 'health_journal_effect_unknown' });
  await assert.rejects(f.bind('resume'), { code: 'health_reconciliation_required' });
  await assert.rejects(f.adapter.forgetAfterConfirmedPurge({ ...proof, receiptId: 'replacement' }), { code: 'health_purge_mismatch' });
  await f.adapter.forgetAfterConfirmedPurge(proof);
  const attempts = f.calls.filter(call => call[0] === 'forget');
  assert.equal(attempts.length, 2); assert.deepEqual(attempts[0], attempts[1]);
  assert.equal(attempts[0][2], journalId); assert.equal(attempts[0][3], 2);
  await f.adapter.dispose();
});
