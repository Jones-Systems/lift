import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import Database from 'better-sqlite3';
import type { Sqlite } from '../../../src/storage.js';
import { assertActive, bindSuppressionAuthority } from '../../../src/lifecycle/guards.js';
import type { AccountContext, DisableRecord } from '../../../src/lifecycle/types.js';
import { createGroundingRetriever, type GroundingRetriever } from '../../../src/grounding/index.js';
import { createNutritionCitationConversation } from '../../../src/domain-features/nutrition/citation-followthrough.js';
import type { NutritionConversationInput } from '../../../src/domain-features/nutrition/conversation.js';
import { syntheticFixture, syntheticRecord } from '../../grounding/fixture.js';
import { createNutritionConversationHost, createRetainedNutritionConversationHost, NutritionConversationUnavailable,
  type NutritionConversationHost, type NutritionHostBindings } from '../../../src/integration/nutrition-conversation/index.js';

const initial = (): NutritionConversationInput => ({ choice: 'ask', previousTurnId: null, job: 'protein',
  question: 'strength', userContext: ['Synthetic context.'], correction: null });
const correction = (): NutritionConversationInput => ({ choice: 'correct-question', previousTurnId: 1, job: 'protein',
  question: 'running', userContext: ['Complete replacement context.'], correction: 'Replace the question.' });
function source(): GroundingRetriever {
  const fixture = syntheticFixture([syntheticRecord('SYN-S01', { topic_ids: ['NUT-I3'] })]);
  fixture.projection.coverage.units[0]!.unit_id = 'NUT-I3';
  fixture.projection.corpus_status.units_without_observations = fixture.projection.coverage.units
    .map(unit => unit.unit_id).filter(id => id !== 'NUT-I3');
  return createGroundingRetriever(fixture.projection, fixture.binding);
}
function fixture(t: TestContext) {
  const db: Sqlite = new Database(':memory:');
  t.after(() => db.close());
  db.exec(`CREATE TABLE form_accounts(id TEXT PRIMARY KEY,auth_user_id TEXT NOT NULL);
    CREATE TABLE session(id TEXT PRIMARY KEY,userId TEXT NOT NULL,expiresAt INTEGER NOT NULL);
    CREATE TABLE account_lifecycle(account_id TEXT PRIMARY KEY,state TEXT NOT NULL,epoch INTEGER NOT NULL);
    INSERT INTO form_accounts VALUES('a','user-a'); INSERT INTO account_lifecycle VALUES('a','active',0);`);
  db.prepare('INSERT INTO session VALUES(?,?,?)').run('session-a', 'user-a', Date.now() + 600000);
  const records = new Map<string, DisableRecord>();
  bindSuppressionAuthority(db, { currentSequence: () => records.size, lookup: id => records.get(id) ?? null,
    reconcileRestore: apply => { for (const record of records.values()) apply(record); return records.size; },
    recordDisable: input => { const record = { ...input, sequence: records.size + 1 }; records.set(record.accountId, record); return record; } });
  const actor = { accountId: 'a', authUserId: 'user-a', sessionId: 'session-a', epoch: 0 };
  let currentActor: AccountContext = { ...actor };
  const lifetime = { conversation: {}, generation: {} };
  let currentLifetime = { ...lifetime };
  let requestIdentity = {};
  const controller = new AbortController();
  let calls = 0;
  let checks = 0;
  const checked: AccountContext[] = [];
  const bindings: NutritionHostBindings = { actor, lifetime,
    lifecycle: { assertActive: captured => { checks += 1; checked.push(captured); assertActive(db, captured); } },
    isCurrentHost: (captured, account) => captured.conversation === currentLifetime.conversation &&
      captured.generation === currentLifetime.generation && account.accountId === currentActor.accountId &&
      account.authUserId === currentActor.authUserId && account.sessionId === currentActor.sessionId && account.epoch === currentActor.epoch,
    captureRequest: () => ({ identity: requestIdentity, signal: controller.signal }),
    isCurrentRequest: captured => captured === requestIdentity };
  const native = source();
  const hooks: { retrieve?: () => void } = {};
  const host = createNutritionConversationHost({ bindings, retriever: { retrieve(request) {
    calls += 1; hooks.retrieve?.(); return native.retrieve(request);
  } } });
  assert.equal(host.status, 'available');
  if (host.status !== 'available') throw new Error('fixture binding failed');
  t.after(host.dispose);
  return { host, bindings, actor, checked, hooks, controller, calls: () => calls, checks: () => checks,
    switchAccount: () => { currentActor = { ...currentActor, accountId: 'other' }; },
    switchSession: () => { currentActor = { ...currentActor, sessionId: 'other' }; },
    changeGeneration: () => { currentLifetime = { ...currentLifetime, generation: {} }; },
    changeConversation: () => { currentLifetime = { ...currentLifetime, conversation: {} }; },
    staleRequest: () => { requestIdentity = {}; },
    revokeSession: () => { db.prepare('DELETE FROM session WHERE id=?').run('session-a'); },
    changeEpoch: () => { db.prepare('UPDATE account_lifecycle SET epoch=epoch+1').run(); },
    suppress: () => { records.set('a', { accountId: 'a', authUserId: 'user-a', epoch: 1, requestId: 'synthetic-disable', disabledAtMs: 0, sequence: 1 }); },
  };
}
const unavailable = (outcome: 'unknown' | 'not-started') => (error: unknown): boolean =>
  error instanceof NutritionConversationUnavailable && error.outcome === outcome && !('state' in error);

function available(result: ReturnType<typeof createNutritionConversationHost>): NutritionConversationHost {
  if (result.status !== 'available') throw new Error('expected available synthetic host');
  return result;
}

test('default and missing source/lifetime bindings are unavailable; retained constructor rejects non-pinned bytes', t => {
  assert.deepEqual(createNutritionConversationHost(), { status: 'unavailable', reason: 'nutrition_host_binding_required' });
  assert.equal(createNutritionConversationHost({ retriever: source() }).status, 'unavailable');
  const h = fixture(t);
  assert.equal(createNutritionConversationHost({ bindings: h.bindings }).status, 'unavailable');
  assert.equal(createRetainedNutritionConversationHost().status, 'unavailable');
  assert.equal(createRetainedNutritionConversationHost({ bindings: h.bindings }).status, 'unavailable');
  assert.deepEqual(createRetainedNutritionConversationHost({ bindings: h.bindings, projectionBytes: new TextEncoder().encode('{}') }),
    { status: 'unavailable', reason: 'retained_grounding_unavailable' });
  assert.equal(h.calls(), 0);
});

test('native answers, citations, qualifications, gaps, rights and explicit user choice pass through unchanged', async t => {
  const h = fixture(t);
  const native = createNutritionCitationConversation(source());
  const expected = await native.submit(initial());
  assert.deepEqual(await h.host.submit(initial()), expected);
  const selection = { parentTurnId: 1, statementId: 'SYN-S01' };
  assert.deepEqual(h.host.selectCitation(selection), native.selectCitation(selection));
  assert.deepEqual(h.host.snapshot(), native.snapshot());
  assert.equal(h.calls(), 1);
  assert.ok(h.checks() >= 6);
  const answer = h.host.snapshot().conversation.currentExplanation;
  assert.equal(answer?.choice.automaticAdoption, false);
  assert.equal(h.host.snapshot().currentSelection?.statement.citation.record.clinical_readiness, 'CL-0');
  assert.ok(h.host.snapshot().currentSelection?.sources.gaps.some(gap => gap.code === 'policy-unavailable'));
});

test('canonical actor snapshot is immutable and current session/epoch/suppression guards run before retrieval', async t => {
  const captured = fixture(t);
  captured.actor.accountId = 'mutated-original';
  await captured.host.submit(initial());
  assert.ok(captured.checked.every(actor => actor.accountId === 'a' && Object.isFrozen(actor)));
  for (const revoke of ['revokeSession', 'changeEpoch', 'suppress'] as const) {
    const h = fixture(t); h[revoke]();
    await assert.rejects(h.host.submit(initial()), unavailable('not-started'));
    assert.equal(h.calls(), 0);
  }
});

test('account/session/conversation/generation changes during submit suppress delivery and discard retained host state', async t => {
  for (const revoke of ['switchAccount', 'switchSession', 'changeConversation', 'changeGeneration'] as const) {
    const h = fixture(t);
    const pending = h.host.submit(initial());
    h[revoke]();
    await assert.rejects(pending, unavailable('unknown'));
    assert.throws(() => h.host.snapshot(), unavailable('not-started'));
    assert.throws(() => h.host.selectCitation({ parentTurnId: 1, statementId: 'SYN-S01' }), unavailable('not-started'));
    assert.equal(h.calls(), 1);
  }
});

test('dispose, aborted signal and stale request drop pending output without replay or a cancellation claim', async t => {
  for (const revoke of ['dispose', 'abort', 'staleRequest'] as const) {
    const h = fixture(t);
    const pending = h.host.submit(initial());
    if (revoke === 'dispose') h.host.dispose();
    else if (revoke === 'abort') h.controller.abort();
    else h.staleRequest();
    await assert.rejects(pending, unavailable('unknown'));
    await assert.rejects(h.host.submit(initial()), unavailable('not-started'));
    assert.equal(h.calls(), 1);
  }
});

test('canonical epoch and current-request guards surround synchronous retrieval, including thrown retrieval', async t => {
  for (const fault of ['epoch', 'error'] as const) {
    const h = fixture(t);
    h.hooks.retrieve = () => {
      if (fault === 'epoch') h.changeEpoch();
      else { h.staleRequest(); throw new Error('private synthetic retrieval error'); }
    };
    await assert.rejects(h.host.submit(initial()), unavailable('unknown'));
    assert.throws(() => h.host.snapshot(), unavailable('not-started'));
    assert.equal(h.calls(), 1);
  }
});

test('rejected-input error settlement rechecks canonical session before exposing the producer error', async t => {
  const h = fixture(t);
  await h.host.submit(initial());
  const pending = h.host.submit({ ...correction(), previousTurnId: 0 });
  h.revokeSession();
  await assert.rejects(pending, unavailable('unknown'));
  assert.throws(() => h.host.snapshot(), unavailable('not-started'));
  assert.equal(h.calls(), 1);
});

test('snapshot and selection require fresh host/request and canonical currentness at each synchronous operation', async t => {
  for (const operation of ['snapshot', 'select'] as const) {
    for (const revoke of ['switchAccount', 'revokeSession', 'changeEpoch', 'suppress'] as const) {
      const h = fixture(t); await h.host.submit(initial()); h[revoke]();
      assert.throws(() => operation === 'snapshot' ? h.host.snapshot() :
        h.host.selectCitation({ parentTurnId: 1, statementId: 'SYN-S01' }), unavailable('not-started'));
      assert.equal(h.calls(), 1);
    }
  }
  const h = fixture(t);
  let current = true;
  const host = available(createNutritionConversationHost({ retriever: source(), bindings: {
    ...h.bindings, isCurrentRequest: () => current,
  } }));
  await host.submit(initial()); current = false;
  assert.throws(() => host.snapshot(), unavailable('not-started'));
});

test('producer owns pending/concurrent/stale turns and accepted corrections clear citations without selection retrieval', async t => {
  const h = fixture(t);
  const first = h.host.submit(initial());
  await assert.rejects(h.host.submit(initial()), /nutrition-turn-in-progress/);
  await first;
  h.host.selectCitation({ parentTurnId: 1, statementId: 'SYN-S01' });
  await assert.rejects(h.host.submit({ ...correction(), previousTurnId: 0 }), /stale-nutrition-turn/);
  assert.equal(h.host.snapshot().currentSelection?.statementId, 'SYN-S01');
  const pending = h.host.submit(correction());
  assert.equal(h.host.snapshot().currentSelection, null);
  assert.equal(h.host.snapshot().conversation.turns.at(-1)?.status, 'pending');
  assert.equal(h.host.selectCitation({ parentTurnId: 1, statementId: 'SYN-S01' }).selections.at(-1)?.status, 'stale-turn');
  const completed = await pending;
  assert.deepEqual(completed.conversation.turns.at(-1)?.input, correction());
  assert.deepEqual(completed.conversation.turns.at(-1)?.sources?.request.corrections, [correction().correction]);
  h.host.selectCitation({ parentTurnId: 2, statementId: 'SYN-S01' });
  assert.equal(h.calls(), 2);
});

test('lost delivery is unknown and previousTurnId cannot revive discarded output or act as a request receipt', async t => {
  const h = fixture(t);
  const pending = h.host.submit(initial()); h.staleRequest();
  await assert.rejects(pending, unavailable('unknown'));
  await assert.rejects(h.host.submit(correction()), unavailable('not-started'));
  const replacement = available(createNutritionConversationHost({ bindings: h.bindings, retriever: source() }));
  await assert.rejects(replacement.submit(correction()), /stale-nutrition-turn/);
  assert.equal(replacement.snapshot().conversation.currentTurnId, null);
  assert.equal(h.calls(), 1);
});


test('delivery guard checks host again after canonical authority returns', async t => {
  const h = fixture(t);
  let invalidate = false;
  let current = true;
  const host = available(createNutritionConversationHost({ retriever: source(), bindings: {
    ...h.bindings,
    isCurrentHost: () => current,
    lifecycle: { assertActive: actor => {
      h.bindings.lifecycle.assertActive(actor);
      if (invalidate) current = false;
    } },
  } }));
  await host.submit(initial());
  let checks = 0;
  const deliveryHost = available(createNutritionConversationHost({ retriever: source(), bindings: {
    ...h.bindings,
    isCurrentHost: () => current,
    lifecycle: { assertActive: actor => {
      h.bindings.lifecycle.assertActive(actor);
      checks += 1;
      if (checks === 4) current = false;
    } },
  } }));
  await assert.rejects(deliveryHost.submit(initial()), unavailable('unknown'));
  assert.equal(checks, 4);
  current = true; invalidate = true;
  assert.throws(() => host.snapshot(), unavailable('not-started'));
});
