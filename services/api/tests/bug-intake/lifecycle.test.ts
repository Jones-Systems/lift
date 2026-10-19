import assert from 'node:assert/strict';
import test from 'node:test';
import { createBugIntakeLifecycleAdapter } from '../../src/bug-intake/index.js';
import { authority, errorCode, fixture, input } from './fixture.js';

test('export includes only owned report content, excluding keys and trusted authority', t => {
  const f = fixture({ authority }); t.after(f.close);
  const report = f.A.submit(input, 'private-key-A').report; f.A.prepare(report.id);
  f.B.submit({ ...input, title: 'Other account private report' }, 'private-key-B');
  const exported: unknown[] = [];
  const result = f.adapter.export(f.contexts.A, { snapshotAtMs: Date.now(), append(category, value) { assert.equal(category, 'bugIntake'); exported.push(value); } });
  assert.equal(result.status, 'complete'); assert.equal(result.count, 1);
  const serialized = JSON.stringify(exported);
  assert.match(serialized, /Workout button/);
  for (const excluded of ['private-key', 'Other account', 'authorityId', 'sourceRevision', 'account-A', 'session-A']) assert.equal(serialized.includes(excluded), false);
  assert.equal(f.adapter.inventory(f.contexts.A).count, 2);
});

test('suppression requires canonical transaction, blocks reads and replay, purge is scoped', t => {
  const f = fixture(); t.after(f.close);
  f.A.submit(input, 'request-key-A'); const other = f.B.submit(input, 'request-key-B');
  assert.equal(f.adapter.suppress(f.contexts.A.accountId, 1).status, 'unavailable');
  assert.equal(f.db.transaction(() => f.adapter.suppress(f.contexts.A.accountId, 1))().status, 'unknown');
  f.disabled.set(f.contexts.A.accountId, 1);
  assert.equal(f.db.transaction(() => f.adapter.suppress(f.contexts.A.accountId, 1))().status, 'complete');
  assert.throws(() => f.A.list(), errorCode('account_disabled'));
  assert.throws(() => f.A.submit(input, 'request-key-A'), errorCode('account_disabled'));
  assert.throws(() => f.adapter.export(f.contexts.A, { snapshotAtMs: Date.now(), append() {} }), errorCode('account_disabled'));
  assert.equal(f.adapter.purge('approved-purge', f.contexts.A.accountId).status, 'unavailable');
  assert.equal(f.db.transaction(() => f.adapter.purge('wrong-request', f.contexts.A.accountId))().status, 'unavailable');
  assert.equal(f.db.transaction(() => f.adapter.purge('approved-purge', f.contexts.A.accountId))().status, 'complete');
  for (const table of ['bug_intake_reports', 'bug_intake_keys', 'bug_intake_suppression']) {
    assert.equal((f.db.prepare(`SELECT count(*) AS n FROM ${table} WHERE account_id=?`).get(f.contexts.A.accountId) as { n: number }).n, 0);
  }
  assert.equal(f.B.get(other.report.id).id, other.report.id);
  assert.throws(() => f.A.submit(input, 'request-key-A'), errorCode('account_disabled'));
});

test('unknown external effects keep suppression honest and stop purge', async t => {
  const f = fixture({ authority, dispatch: { async submit() { throw new Error('lost response'); } } }); t.after(f.close);
  const id = f.A.submit(input, 'request-key-A').report.id; f.A.prepare(id); await f.A.dispatch(id);
  f.disabled.set(f.contexts.A.accountId, 1);
  assert.equal(f.db.transaction(() => f.adapter.suppress(f.contexts.A.accountId, 1))().status, 'unknown');
  assert.equal(f.db.transaction(() => f.adapter.purge('approved-purge', f.contexts.A.accountId))().status, 'unknown');
  assert.equal((f.db.prepare('SELECT count(*) AS n FROM bug_intake_reports').get() as { n: number }).n, 1);
});

test('suppression while dispatch is pending prevents late response disclosure or purge', async t => {
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  const f = fixture({ authority, dispatch: { async submit() { await wait; return { status: 'accepted', receiptId: 'receipt-late' }; } } }); t.after(f.close);
  const id = f.A.submit(input, 'request-key-A').report.id; f.A.prepare(id);
  const pending = f.A.dispatch(id);
  f.disabled.set(f.contexts.A.accountId, 1);
  assert.equal(f.db.transaction(() => f.adapter.suppress(f.contexts.A.accountId, 1))().status, 'unknown');
  release(); await assert.rejects(pending, errorCode('account_disabled'));
  assert.deepEqual(f.db.prepare('SELECT state,dispatch_receipt FROM bug_intake_reports').get(), { state: 'dispatch_unknown', dispatch_receipt: null });
});

test('lifecycle control absence is unavailable and oversized persisted export is bounded before parsing', t => {
  const f = fixture(); t.after(f.close);
  const adapter = createBugIntakeLifecycleAdapter({ db: f.db, lifecycle: f.deps.lifecycle });
  assert.equal(adapter.verifySuppressed(f.contexts.A.accountId, 1).status, 'unavailable');
  const id = f.A.submit(input, 'request-key-A').report.id;
  f.db.prepare('UPDATE bug_intake_reports SET data=? WHERE id=?').run(JSON.stringify({ ...input, description: 'x'.repeat(20000) }), id);
  assert.throws(() => f.adapter.export(f.contexts.A, { snapshotAtMs: Date.now(), append() { assert.fail('oversized data must not be exported'); } }), errorCode('account_export_packaging_required'));
});

test('empty source inventory never substitutes for canonical suppression or a valid epoch', t => {
  const f = fixture(); t.after(f.close);
  const accountId = f.contexts.A.accountId;
  assert.equal(f.adapter.verifySuppressed(accountId, 1).status, 'unknown');
  f.disabled.set(accountId, 1);
  const unbound = createBugIntakeLifecycleAdapter({ db: f.db, lifecycle: f.deps.lifecycle });
  assert.equal(unbound.verifySuppressed(accountId, 1).status, 'unavailable');
  for (const epoch of [-1, 0.5, Number.NaN]) assert.equal(f.adapter.verifySuppressed(accountId, epoch).status, 'unavailable');
  assert.equal(f.adapter.verifySuppressed(accountId, 2).status, 'unknown');
});

test('residual source rows still require a current local suppression marker', t => {
  const f = fixture(); t.after(f.close);
  const accountId = f.contexts.A.accountId;
  f.A.submit(input, 'request-key-A'); f.disabled.set(accountId, 2);
  assert.equal(f.adapter.verifySuppressed(accountId, 2).status, 'pending');
  assert.equal(f.db.transaction(() => f.adapter.suppress(accountId, 1))().status, 'complete');
  assert.equal(f.adapter.verifySuppressed(accountId, 2).status, 'pending');
  assert.equal(f.db.transaction(() => f.adapter.suppress(accountId, 2))().status, 'complete');
  assert.equal(f.adapter.verifySuppressed(accountId, 2).status, 'complete');
  assert.equal((f.db.prepare('SELECT count(*) AS n FROM bug_intake_reports').get() as { n: number }).n, 1);
});
