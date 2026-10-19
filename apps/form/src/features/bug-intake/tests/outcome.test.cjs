const assert = require('node:assert/strict');
const test = require('node:test');
const { load, fixture, id, otherId, deferred, ApiError } = require('./fixture.cjs');
const { createBugOutcomeConsumer, parseBugReporterOutcome } = load('features/bug-intake/outcome.ts');
const summary = (reportId = id) => ({ schema: 'form.bug-reporter-outcome/v1', reportId, status: 'fix_verified',
  verificationScope: 'cited_checks_only', requiredChecks: 2, passedChecks: 2 });
const changed = error => error instanceof ApiError && error.code === 'session_changed';
function consumer(t, port) {
  const f = fixture();
  const reader = createBugOutcomeConsumer({ resources: { api: f.api }, sessionGeneration: 'synthetic-generation-A',
    isCurrentSession: () => f.state.current }, port);
  t.after(() => { reader.dispose(); f.close(); });
  return { ...f, reader };
}

test('missing reporter-safe read port defaults unavailable without any transport request', async t => {
  const f = consumer(t);
  assert.deepEqual(f.reader.getState(), { phase: 'idle', reportId: null, outcome: null });
  await f.reader.load(id);
  assert.deepEqual(f.reader.getState(), { phase: 'unavailable', reportId: id, outcome: null });
  assert.equal(f.calls.length, 0);
});

test('qualified current summary preserves the six-field cited-check scope without a network route', async t => {
  const calls = [], permissions = [], value = summary();
  const f = consumer(t, { async read(reportId) { calls.push(reportId); return value; },
    assertCurrent(reportId, proposed) { permissions.push(reportId); assert.deepEqual(proposed, value); } });
  await f.reader.load(id);
  assert.deepEqual(f.reader.getState(), { phase: 'ready', reportId: id, outcome: value });
  assert.equal(Object.isFrozen(f.reader.getState().outcome), true);
  value.status = 'unavailable';
  assert.equal(f.reader.getState().outcome.status, 'fix_verified');
  assert.deepEqual(calls, [id]); assert.deepEqual(permissions, [id]); assert.equal(f.calls.length, 0);
});

test('private snapshots, wrong reports, expanded fields and impossible counts cannot become reporter outcomes', async t => {
  for (const raw of [
    { status: 'fix_verified', snapshot: { binding: { reportFingerprint: 'private-binding' } } },
    summary(otherId), { ...summary(), sourceRevision: 'a'.repeat(40) },
    { ...summary(), status: 'deployed' }, { ...summary(), requiredChecks: 17, passedChecks: 17 },
    { ...summary(), requiredChecks: 0, passedChecks: 0 }, { ...summary(), passedChecks: 1 },
    { ...summary(), status: 'expected_behavior' }, { ...summary(), passedChecks: 2.5 },
  ]) {
    let permissions = 0;
    const f = consumer(t, { async read() { return raw; }, assertCurrent() { permissions++; } });
    await f.reader.load(id);
    assert.deepEqual(f.reader.getState(), { phase: 'unavailable', reportId: id, outcome: null });
    assert.equal(permissions, 0); assert.equal(f.calls.length, 0);
  }
});

test('structural validity cannot replace explicit current reporter disclosure permission', async t => {
  const value = summary(); assert.deepEqual(parseBugReporterOutcome(value, id), value);
  let permissions = 0;
  const f = consumer(t, { async read() { return value; }, assertCurrent() { permissions++; throw new Error('private policy diagnostic'); } });
  await f.reader.load(id);
  assert.deepEqual(f.reader.getState(), { phase: 'unavailable', reportId: id, outcome: null });
  assert.equal(permissions, 1); assert.equal(JSON.stringify(f.reader.getState()).includes('private policy diagnostic'), false);
});

test('read errors remain unavailable and only an explicit new read invokes the port again', async t => {
  let reads = 0;
  const f = consumer(t, { async read() { if (++reads === 1) throw new Error('private reader failure'); return summary(); }, assertCurrent() {} });
  await f.reader.load(id);
  assert.equal(f.reader.getState().phase, 'unavailable'); assert.equal(reads, 1);
  await f.reader.load(id);
  assert.equal(f.reader.getState().phase, 'ready'); assert.equal(reads, 2);
  assert.equal(f.calls.length, 0);
});

test('auth replacement clears selection and fences a late qualified response', async t => {
  const waiting = deferred(); let permissions = 0;
  const f = consumer(t, { read: () => waiting.promise, assertCurrent() { permissions++; } });
  const pending = f.reader.load(id);
  try {
    assert.equal(f.reader.getState().phase, 'loading'); f.changeAuth();
    assert.deepEqual(f.reader.getState(), { phase: 'unavailable', reportId: null, outcome: null });
  } finally { waiting.resolve(summary()); await pending; }
  assert.deepEqual(f.reader.getState(), { phase: 'unavailable', reportId: null, outcome: null });
  assert.equal(permissions, 0); await assert.rejects(f.reader.load(id), changed);
});

test('root session invalidation during disclosure qualification prevents publication', async t => {
  let f;
  f = consumer(t, { async read() { return summary(); }, assertCurrent() { f.state.current = false; } });
  await f.reader.load(id);
  assert.deepEqual(f.reader.getState(), { phase: 'unavailable', reportId: null, outcome: null });
  await assert.rejects(f.reader.load(id), changed);
});

test('a late previous selection cannot replace the current requested report', async t => {
  const waiting = deferred();
  const permissions = [];
  const f = consumer(t, { read: reportId => reportId === id ? waiting.promise : Promise.resolve(summary(reportId)),
    assertCurrent(reportId) { permissions.push(reportId); } });
  const first = f.reader.load(id);
  try { await f.reader.load(otherId); assert.equal(f.reader.getState().reportId, otherId); }
  finally { waiting.resolve(summary()); await first; }
  assert.deepEqual(f.reader.getState(), { phase: 'ready', reportId: otherId, outcome: summary(otherId) });
  assert.deepEqual(permissions, [otherId]);
});

test('disposal clears reporter state and retained readers cannot request again', async t => {
  let reads = 0; const seen = [];
  const f = consumer(t, { async read() { reads++; return summary(); }, assertCurrent() {} });
  const subscription = f.reader.subscribe(state => seen.push(state));
  await f.reader.load(id); f.reader.dispose();
  assert.deepEqual(seen.at(-1), { phase: 'unavailable', reportId: null, outcome: null });
  await assert.rejects(f.reader.load(id), changed);
  subscription.remove(); assert.equal(reads, 1); assert.equal(f.calls.length, 0);
});
