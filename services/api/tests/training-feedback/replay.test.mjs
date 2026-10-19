import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { replayFeedback } from '../../src/training-feedback/index.ts';

const accountId = 'synthetic-account';
const session = { kind: 'session', contextId: 'context-a', sessionId: 'session-a', planId: 'plan-a' };
const plan = { kind: 'plan', contextId: 'context-a', planId: 'plan-a' };
const context = { kind: 'context', contextId: 'context-a' };
const sourceRefs = [{ sourceId: 'synthetic-note', revision: 'note-v1', locator: 'field:feedback', qualification: 'Synthetic user report; no clinical evidence.' }];
const ruleRefs = [{ sourceId: 'synthetic-replay-rule', revision: 'rule-v1', locator: 'identity', qualification: 'Test-only identity transformation; no prescription.' }];
const qualifications = ['Self-report; no causal or growth inference.'];

function content(value = 2, scope = session) {
  return { scope: structuredClone(scope), sourceRefs: structuredClone(sourceRefs), qualifications: [...qualifications],
    payload: { kind: 'feedback', signals: [{ dimension: 'rir', state: 'reported', value, unit: 'repetitions', scale: 'user RIR estimate' }] } };
}
function event(kind, expectedRevision, extra = {}) {
  return { eventId: `${kind}-${expectedRevision}`, accountId, recordId: 'feedback-a', expectedRevision, kind, ...extra };
}
function recorded(data = content()) {
  return [event('record', 0, { content: data }), event('confirm', 1)];
}
function recipe(id = 'history', extra = {}) {
  return { id, version: 'synthetic-v1', kind: 'history', scope: session,
    sourceIds: ['feedback-a'], dependsOn: [], sourceRefs: ruleRefs, qualifications,
    compute: ({ sources }) => sources[0].content.payload.signals[0].value, ...extra };
}
function chain(scope = session) {
  return [recipe('history', { scope }), recipe('summary', { kind: 'summary', scope, sourceIds: [], dependsOn: ['history'], compute: ({ parents }) => ({ reported: parents[0].value }) }),
    recipe('recommendation', { kind: 'recommendation', scope, sourceIds: [], dependsOn: ['summary'], compute: ({ parents }) => ({ reviewInput: parents[0].value }) })];
}
function replay(events, derivations = chain()) { return replayFeedback({ accountId, events, derivations }); }

test('separate dimensions retain zero, source qualifications, units and explicit missingness', () => {
  const data = content();
  data.payload.signals = [
    { dimension: 'rir', state: 'reported', value: 0, unit: 'repetitions', scale: 'uncertain estimate' },
    { dimension: 'effort', state: 'reported', value: 'hard', unit: null, scale: 'own words' },
    { dimension: 'discomfort', state: 'reported', value: 0, unit: null, scale: 'reported scale' },
    { dimension: 'weakness', state: 'reported', value: false, unit: null, scale: null },
    { dimension: 'function', state: 'missing', reason: 'not-asked' },
    { dimension: 'performance', state: 'reported', value: { repetitions: 8, load: 20 }, unit: 'kg', scale: null },
    { dimension: 'sensation', state: 'reported', value: 'right spot', unit: null, scale: null },
    { dimension: 'soreness', state: 'missing', reason: 'declined' },
  ];
  const result = replay(recorded(data));
  assert.deepEqual(result.records[0].content, data);
  assert.equal(result.derivations[0].value, 0);
  assert.deepEqual(result.derivations[2].lineage[0].sourceRefs, sourceRefs);
  assert.deepEqual(result.derivations[2].lineage[0].qualifications, qualifications);
  assert.deepEqual(result.derivations[2].recipeLineage.map(r => r.id), ['history', 'summary', 'recommendation']);
  assert.equal(result.derivations.some(d => Object.hasOwn(d, 'growth')), false);
});

test('unconfirmed reports block all downstream computation and do not infer missing as zero', () => {
  let calls = 0;
  const result = replay([recorded()[0]], [recipe('history', { compute: () => { calls++; return 0; } })]);
  assert.equal(calls, 0);
  assert.equal(result.derivations[0].status, 'blocked');
  assert.equal(result.derivations[0].value, null);
  assert.deepEqual(result.derivations[0].blockedBy, ['source:feedback-a:unconfirmed']);
});

test('correction invalidates the whole chain immediately, then confirmed replay recomputes values', () => {
  const original = recorded();
  assert.deepEqual(replay(original).derivations[2].value, { reviewInput: { reported: 2 } });
  const changed = content(4);
  changed.sourceRefs[0].revision = 'note-v2';
  const corrected = [...original, event('correct', 2, { content: changed })];
  const blocked = replay(corrected);
  assert.deepEqual(blocked.receipts.at(-1).invalidatedDerivationIds, ['history', 'summary', 'recommendation']);
  assert.ok(blocked.derivations.every(d => d.status === 'blocked' && d.value === null));
  const confirmed = replay([...corrected, event('confirm', 3)]);
  assert.deepEqual(confirmed.derivations[2].value, { reviewInput: { reported: 4 } });
  assert.equal(confirmed.derivations[2].lineage[0].revision, 4);
  assert.equal(confirmed.derivations[2].lineage[0].sourceRefs[0].revision, 'note-v2');
});

test('undo restores content but never a pre-correction confirmation or revision', () => {
  for (const confirmFirst of [false, true]) {
    const corrected = [...recorded(), event('correct', 2, { content: content(9) })];
    if (confirmFirst) corrected.push(event('confirm', 3));
    const revision = confirmFirst ? 4 : 3;
    const events = [...corrected, event('undo', revision, { targetEventId: 'correct-2' })];
    const undone = replay(events);
    assert.equal(undone.records[0].content.payload.signals[0].value, 2);
    assert.equal(undone.records[0].confirmed, false);
    assert.equal(undone.records[0].revision, revision + 1);
    assert.ok(undone.derivations.every(d => d.status === 'blocked'));
    assert.equal(undone.receipts.at(-1).cause, 'undo');
    assert.equal(replay([...events, event('confirm', revision + 1)]).derivations[0].value, 2);
  }
});

test('undo of confirmation preserves the latest correction target but later edits fence stale undo', () => {
  const corrected = [...recorded(), event('correct', 2, { content: content(9) }), event('confirm', 3)];
  const unconfirmed = [...corrected, event('undo', 4, { targetEventId: 'confirm-3' })];
  assert.equal(replay(unconfirmed).records[0].confirmed, false);
  const undone = replay([...unconfirmed, event('undo', 5, { targetEventId: 'correct-2' })]);
  assert.equal(undone.records[0].content.payload.signals[0].value, 2);
  assert.equal(undone.records[0].revision, 6);
  const intervening = [...corrected, event('correct', 4, { content: content(7) }), event('confirm', 5)];
  const stale = replay([...intervening, event('undo', 6, { targetEventId: 'correct-2' })]);
  assert.equal(stale.receipts.at(-1).reason, 'undo-target-conflict');
  assert.equal(stale.records[0].revision, 6);
  assert.equal(stale.records[0].content.payload.signals[0].value, 7);
});

test('withdrawal blocks all descendants; undo requires confirmation before reuse', () => {
  const withdrawnEvents = [...recorded(), event('correct', 2, { content: content(9) }), event('confirm', 3), event('withdraw', 4)];
  const withdrawn = replay(withdrawnEvents);
  assert.ok(withdrawn.derivations.every(d => d.status === 'blocked' && d.value === null));
  assert.ok(withdrawn.derivations[2].blockedBy.includes('source:feedback-a:withdrawn'));
  const undoneEvents = [...withdrawnEvents, event('undo', 5, { targetEventId: 'withdraw-4' })];
  assert.ok(replay(undoneEvents).derivations.every(d => d.status === 'blocked'));
  const confirmed = replay([...undoneEvents, event('confirm', 6)]);
  assert.ok(confirmed.derivations.every(d => d.status === 'ready'));
  assert.equal(confirmed.derivations[0].value, 9);
});

test('deletion returns a terminal redacted projection, without resurrecting deleted data on undo', () => {
  const deletion = event('delete', 2);
  const events = [...recorded(), deletion];
  const removed = replay(events);
  assert.equal(removed.records[0].content, null);
  assert.ok(removed.derivations.every(d => d.value === null && d.status === 'blocked'));
  assert.deepEqual(removed.derivations[2].lineage[0].sourceRefs, []);
  assert.deepEqual(removed.derivations[2].lineage[0].qualifications, []);
  for (const command of [event('undo', 3, { targetEventId: deletion.eventId }), event('confirm', 3), event('correct', 3, { content: content() })]) {
    const result = replay([...events, command]);
    assert.equal(result.receipts.at(-1).reason, 'deleted-terminal');
    assert.equal(result.receipts.at(-1).outcome, 'rejected');
    assert.equal(result.records[0].revision, 3);
    assert.equal(result.records[0].content, null);
  }
});

test('session edits remain explicit and cannot transitively become durable plan changes', () => {
  const edit = { scope: session, sourceRefs, qualifications, payload: { kind: 'edit', field: 'exercise-order', before: ['a', 'b'], after: ['b', 'a'] } };
  const derivations = [recipe('history', { scope: context, compute: ({ sources }) => sources[0].content.payload.after }),
    recipe('summary', { kind: 'summary', scope: context, sourceIds: [], dependsOn: ['history'], compute: ({ parents }) => parents[0].value }),
    recipe('durable', { kind: 'recommendation', scope: plan, sourceIds: [], dependsOn: ['summary'], compute: () => 'must not run' })];
  const result = replay(recorded(edit), derivations);
  assert.deepEqual(result.derivations[0].value, ['b', 'a']);
  assert.equal(result.derivations[2].status, 'blocked');
  assert.ok(result.derivations[2].blockedBy.includes('source:feedback-a:scope-mismatch'));
  assert.equal(result.records[0].content.scope.kind, 'session');
});

test('explicit scope correction and fresh confirmation permit a plan-scoped consumer', () => {
  const original = recorded();
  const corrected = [...original, event('correct', 2, { content: content(2, plan) })];
  const defs = [recipe('plan-view', { kind: 'recommendation', scope: plan })];
  assert.equal(replay(corrected, defs).derivations[0].status, 'blocked');
  const result = replay([...corrected, event('confirm', 3)], defs);
  assert.equal(result.derivations[0].status, 'ready');
  assert.deepEqual(result.receipts[2].scopeBefore, session);
  assert.deepEqual(result.receipts[2].scopeAfter, plan);
});

test('recommendations cannot cross unrelated sessions, plans, contexts or parent scopes', () => {
  for (const target of [{ ...session, sessionId: 'session-b' }, { ...session, planId: 'plan-b' }, { ...session, contextId: 'context-b' }, plan, context]) {
    assert.equal(replay(recorded(), [recipe('rec', { kind: 'recommendation', scope: target })]).derivations[0].status, 'blocked');
  }
  const defs = [recipe('local-rec', { kind: 'recommendation', scope: session }), recipe('durable-rec', {
    kind: 'recommendation', scope: context, sourceIds: [], dependsOn: ['local-rec'], compute: () => 'not allowed',
  })];
  const result = replay(recorded(content(2, context)), defs);
  assert.equal(result.derivations[0].status, 'ready');
  assert.ok(result.derivations[1].blockedBy.includes('derivation:local-rec:scope-mismatch'));
});

test('stale, wrong-account, missing-target and stale-undo commands reject without fabricated revisions', () => {
  for (const command of [event('correct', 0, { content: content(9) }), event('withdraw', 2, { accountId: 'other-account' }),
    event('confirm', 0, { recordId: 'missing' }), event('undo', 2, { targetEventId: 'absent-event' })]) {
    const result = replay([...recorded(), command]);
    assert.equal(result.receipts.at(-1).outcome, 'rejected');
    assert.deepEqual(result.receipts.at(-1).invalidatedDerivationIds, []);
    assert.equal(result.records[0].revision, 2);
    assert.equal(result.derivations[0].value, 2);
  }
});

test('identical event retries and already-confirmed commands are unchanged; reused IDs with new input reject', () => {
  const events = recorded();
  const result = replay([...events, structuredClone(events[1]), event('confirm', 2)]);
  assert.deepEqual(result.receipts.map(r => r.outcome), ['changed', 'changed', 'unchanged', 'unchanged']);
  assert.equal(result.records[0].revision, 2);
  assert.equal(replay([...events, event('withdraw', 2, { eventId: events[1].eventId })]).receipts.at(-1).reason, 'event-id-conflict');
});

test('undoing initial entry removes its usable content and blocks dependencies', () => {
  const events = [recorded()[0], event('undo', 1, { targetEventId: 'record-0' })];
  const result = replay(events);
  assert.equal(result.records[0].status, 'undone');
  assert.equal(result.records[0].content, null);
  assert.ok(result.derivations.every(d => d.status === 'blocked'));
});

test('missing sources block descendants; unrelated sources avoid invalidation', () => {
  const defs = [...chain(), recipe('independent', { sourceIds: ['other-feedback'] })];
  const result = replay(recorded(), defs);
  assert.equal(result.derivations.at(-1).status, 'blocked');
  assert.deepEqual(result.derivations.at(-1).blockedBy, ['source:other-feedback:missing']);
  assert.ok(result.receipts.every(r => !r.invalidatedDerivationIds.includes('independent')));
});

test('exceptions, undefined, nonfinite and non-JSON computations block rather than expose stale values', () => {
  for (const compute of [() => { throw new Error('private error body'); }, () => undefined, () => NaN, () => new Date(), () => ({ bad: Infinity })]) {
    const defs = chain();
    defs[0].compute = compute;
    const result = replay(recorded(), defs);
    assert.ok(result.derivations.every(d => d.status === 'blocked' && d.value === null));
    assert.equal(JSON.stringify(result).includes('private error body'), false);
  }
});

test('cycles, missing parents, duplicate IDs and unbound recipes are invalid definitions', () => {
  for (const defs of [
    [recipe('a', { dependsOn: ['b'] }), recipe('b', { dependsOn: ['a'] })],
    [recipe('a', { dependsOn: ['absent'] })], [recipe('same'), recipe('same')],
    [recipe('a', { sourceRefs: [] })], [recipe('a', { sourceIds: [] })],
  ]) assert.throws(() => replay(recorded(), defs), /feedback derivation/);
});

test('invalid signal or source qualifications reject entry without coercion', () => {
  for (const mutate of [data => { data.payload.signals[0].value = null; }, data => { data.sourceRefs = []; },
    data => { data.qualifications = []; }, data => { data.payload.signals[0].dimension = 'growth'; },
    data => { data.payload.signals[0].value = NaN; }, data => { data.scope = { kind: 'durable' }; }]) {
    const data = content(); mutate(data);
    const result = replay([event('record', 0, { content: data })]);
    assert.equal(result.records.length, 0);
    assert.equal(result.receipts[0].reason, 'invalid-content');
    assert.equal(result.receipts[0].revision, 0);
  }
});

test('replay is deterministic and callbacks cannot mutate records, predecessor results or caller events', () => {
  const events = recorded();
  const before = structuredClone(events);
  const defs = chain();
  defs[1].compute = ({ parents }) => { parents[0].value = 999; parents[0].lineage[0].sourceRefs.length = 0; return 'synthetic'; };
  const first = replay(events, defs);
  assert.equal(first.derivations[0].value, 2);
  assert.deepEqual(first.derivations[0].lineage[0].sourceRefs, sourceRefs);
  assert.deepEqual(first, replay(events, defs));
  assert.deepEqual(events, before);
  first.records[0].content.payload.signals[0].value = 123;
  assert.deepEqual(events, before);
});

test('local check contract names the only module and exact source invocation', () => {
  const contract = JSON.parse(readFileSync(new URL('./checks.json', import.meta.url), 'utf8'));
  assert.deepEqual(contract.groups['FORM-WS30-feedback-replay'].tests, ['services/api/tests/training-feedback/replay.test.mjs']);
  assert.equal(contract.command, 'node --test --test-isolation=none --test-concurrency=1 services/api/tests/training-feedback/replay.test.mjs');
});
