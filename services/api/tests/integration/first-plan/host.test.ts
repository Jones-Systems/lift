import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { Domain } from '../../../src/domain.js';
import { DomainError } from '../../../src/errors.js';
import { assertActive, withActiveWrite } from '../../../src/lifecycle/guards.js';
import { buildAccountExport } from '../../../src/lifecycle/export.js';
import { createFirstPlanHost } from '../../../src/integration/first-plan/index.js';
import { firstPlanOperation } from '../../../src/integration/first-plan/contracts.js';
import { command } from '../../../src/storage.js';
import type { Profile } from '../../../src/schemas.js';
import { fixture as accountFixture } from '../account-modules/fixture.js';
import { candidate, prepared } from './fixture.js';

const input = { profileRevision: 0, preferencesRevision: 0 };
const code = (expected: string) => (error: unknown) => error instanceof DomainError && error.code === expected;
function fixture(t: TestContext) {
  const f = accountFixture(); t.after(f.close);
  const domain = new Domain(f.db);
  for (const item of candidate.plan.items) f.db.prepare('INSERT INTO exercises(id,data) VALUES(?,?)')
    .run(item.exerciseId, JSON.stringify({ id: item.exerciseId, name: 'Invented fixture only', cues: [], requiredConstraints: [] }));
  const count = (table: 'plans' | 'plan_revisions' | 'plan_item_ids' | 'command_receipts') =>
    (f.db.prepare(`SELECT count(*) n FROM ${table}`).get() as { n: number }).n;
  return { ...f, domain, count };
}

test('missing preparation is unavailable and confirmation/body mistakes have no persistent effect', async t => {
  const f = fixture(t);
  await assert.rejects(createFirstPlanHost(f.domain).create(f.one, input, 'missing'), code('first_plan_unavailable'));
  const host = createFirstPlanHost(f.domain, async () => prepared());
  await assert.rejects(host.create(f.one, { ...input, profileRevision: 1 }, 'stale'), code('first_plan_confirmation_stale'));
  await assert.rejects(host.create(f.one, input, undefined), code('idempotency_key_required'));
  assert.equal(f.count('plans'), 0); assert.equal(f.count('command_receipts'), 0);
});

test('preparation receives frozen server context outside transactions and saves only bounded provenance', async t => {
  const f = fixture(t);
  f.domain.patchDocument<Profile>(f.one.accountId, 'profile', { expectedRevision: 0,
    trainingContext: 'PRIVATE-TRAINING-CONTEXT', injuryHistory: 'PRIVATE-INJURY-CONTEXT' });
  const host = createFirstPlanHost(f.domain, async (actor, context) => {
    assert.equal(f.db.inTransaction, false);
    assert.equal(actor.accountId, f.one.accountId); assert.ok(Object.isFrozen(actor));
    assert.equal(context.profile.trainingContext, 'PRIVATE-TRAINING-CONTEXT');
    assert.equal(context.profile.injuryHistory, 'PRIVATE-INJURY-CONTEXT');
    assert.ok(Object.isFrozen(context.profile.goals));
    await Promise.resolve(); assert.equal(f.db.inTransaction, false);
    return prepared(() => assert.equal(f.db.inTransaction, true));
  });
  const result = await host.create(f.one, { ...input, profileRevision: 1 }, 'create');
  assert.deepEqual(result.plan.items, candidate.plan.items);
  assert.equal(result.provenance.profileRevision, 1);
  const durable = (f.db.prepare('SELECT result FROM command_receipts').get() as { result: string }).result;
  for (const text of ['PRIVATE-', 'qualification', 'locator', 'evidence', 'injuryHistory', 'trainingContext']) assert.equal(durable.includes(text), false);
  assert.equal(f.count('plans'), 1); assert.equal(f.count('plan_revisions'), 1); assert.equal(f.count('plan_item_ids'), 2);
});

test('exact replay survives changed context and missing source binding without regeneration; payload changes conflict', async t => {
  const f = fixture(t); let calls = 0;
  const host = createFirstPlanHost(f.domain, async () => { calls++; return prepared(); });
  const first = await host.create(f.one, input, 'same');
  f.domain.patchDocument<Profile>(f.one.accountId, 'profile', { expectedRevision: 0, trainingContext: 'changed' });
  assert.deepEqual(await createFirstPlanHost(f.domain).create(f.one, input, 'same'), first);
  await assert.rejects(host.create(f.one, { ...input, profileRevision: 1 }, 'same'), code('idempotency_mismatch'));
  assert.equal(calls, 1); assert.equal(f.count('plans'), 1);
  f.db.prepare('DELETE FROM session WHERE id=?').run(f.one.sessionId);
  await assert.rejects(host.create(f.one, input, 'same'), code('account_session_invalid'));
});

test('concurrent identical commands commit one receipt/plan and receipts are account scoped', async t => {
  const f = fixture(t); let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const host = createFirstPlanHost(f.domain, async () => { await gate; return prepared(); });
  const a = host.create(f.one, input, 'same'), b = host.create(f.one, input, 'same');
  release(); const [one, two] = await Promise.all([a, b]); assert.deepEqual(one, two);
  const other = await host.create(f.two, input, 'same'); assert.notEqual(other.plan.id, one.plan.id);
  assert.equal(f.count('plans'), 2); assert.equal(f.count('command_receipts'), 2);
});

test('context/session/epoch changes during preparation prevent save, including error settlement', async t => {
  for (const change of ['context', 'session', 'epoch', 'error'] as const) {
    const f = fixture(t); let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const host = createFirstPlanHost(f.domain, async () => { await gate; if (change === 'error') throw Error('PRIVATE'); return prepared(); });
    const pending = host.create(f.one, input, 'changing');
    if (change === 'context') f.domain.patchDocument<Profile>(f.one.accountId, 'profile', { expectedRevision: 0, trainingContext: 'changed' });
    else if (change === 'epoch') f.db.prepare('UPDATE account_lifecycle SET epoch=epoch+1 WHERE account_id=?').run(f.one.accountId);
    else f.db.prepare('DELETE FROM session WHERE id=?').run(f.one.sessionId);
    release();
    await assert.rejects(pending, code(change === 'context' ? 'first_plan_confirmation_stale' : change === 'epoch' ? 'account_epoch_changed' : 'account_session_invalid'));
    assert.equal(f.count('plans'), 0); assert.equal(f.count('command_receipts'), 0);
  }
});

test('source invalidation after selection or insertion rolls back every plan row and receipt', async t => {
  for (const failAt of [1, 2, 3]) {
    const f = fixture(t); let checks = 0;
    const host = createFirstPlanHost(f.domain, async () => prepared(() => { if (++checks === failAt) throw Error('PRIVATE'); }));
    await assert.rejects(host.create(f.one, input, 'fail'), code('first_plan_sources_changed'));
    for (const table of ['plans', 'plan_revisions', 'plan_item_ids', 'command_receipts'] as const) assert.equal(f.count(table), 0);
  }
});

test('unknown/unqualified and infeasible candidates stay distinct known no-effect outcomes', async t => {
  for (const status of ['unknown', 'excluded'] as const) {
    const f = fixture(t); const supplied = prepared();
    supplied.ports.qualifyCatalog = evaluation => ({ contextKey: evaluation.contextKey, candidateKey: evaluation.candidateKey,
      status, reasons: [{ code: 'catalog_not_qualified', detail: 'PRIVATE-DETAIL' }] });
    await assert.rejects(createFirstPlanHost(f.domain, async () => supplied).create(f.one, input, 'blocked'),
      error => code(status === 'unknown' ? 'first_plan_blocked' : 'first_plan_infeasible')(error) && !JSON.stringify(error).includes('PRIVATE'));
    assert.equal(f.count('plans'), 0); assert.equal(f.count('command_receipts'), 0);
  }
});

test('unbounded/content-like provenance and asynchronous source checks reject before persistence', async t => {
  for (const kind of ['provenance', 'async'] as const) {
    const f = fixture(t); const supplied = prepared(kind === 'async' ? async () => {} : () => {});
    if (kind === 'provenance') supplied.candidates[0]!.source.id = 'private source prose';
    await assert.rejects(createFirstPlanHost(f.domain, async () => supplied).create(f.one, input, 'reject'),
      code(kind === 'async' ? 'synchronous_first_plan_source_check_required' : 'first_plan_provenance_unavailable'));
    assert.equal(f.count('plans'), 0); assert.equal(f.count('command_receipts'), 0);
  }
});

test('account export includes training context, original plan receipts and exact bounded first-plan wrapper', async t => {
  const f = fixture(t);
  f.domain.patchDocument<Profile>(f.one.accountId, 'profile', { expectedRevision: 0, trainingContext: 'USER-CONFIRMED-CONTEXT' });
  f.domain.patchOnboarding(f.one.accountId, { expectedRevision: 0, step: 'review', answers: { trainingContext: 'DRAFT-USER-CONTEXT' } });
  const generated = await createFirstPlanHost(f.domain, async () => prepared()).create(f.one, { ...input, profileRevision: 1 }, 'first');
  withActiveWrite(f.db, f.one, () => command(f.db, f.one.accountId, 'plan.create', 'manual', candidate.plan, () => {},
    () => ({ status: 201, body: f.domain.createPlan(f.one.accountId, candidate.plan) })));
  const output = buildAccountExport(f.db, f.one, actor => assertActive(f.db, actor));
  const records = (JSON.parse(output.json) as { records: { category: string; value: Record<string, unknown> }[] }).records;
  const receipt = records.find(row => row.category === 'operationHistory' && row.value.operation === firstPlanOperation);
  assert.deepEqual(receipt?.value.result, generated);
  const manual = records.find(row => row.category === 'operationHistory' && row.value.operation === 'plan.create');
  assert.equal((manual?.value.result as { name: string }).name, candidate.plan.name);
  assert.ok(output.json.includes('USER-CONFIRMED-CONTEXT'));
  assert.ok(output.json.includes('DRAFT-USER-CONTEXT'));
  assert.equal(output.json.includes('PRIVATE-TEST-EVIDENCE'), false);
  f.db.prepare('UPDATE command_receipts SET result=? WHERE operation=?').run(JSON.stringify({ ...generated, rawEvidence: 'PRIVATE' }), firstPlanOperation);
  assert.throws(() => buildAccountExport(f.db, f.one, actor => assertActive(f.db, actor)), code('account_export_invalid_data'));
});
