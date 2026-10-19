import test from 'node:test';
import assert from 'node:assert/strict';
import { createActivityIntegration } from '../../../src/activity/integration/index.js';
import { createOwnerActivityRequestChannel } from '../../../src/activity/integration/request-channel.js';
import { fixture, code, personalFields } from './fixture.js';
import type { AccountContext } from '../../../src/lifecycle/types.js';
import type { ActivityOperation } from '../../../src/activity/types.js';

test('live request copies and freezes canonical identity; repeated checks and concurrent accounts stay distinct', t => {
  const f = fixture(); t.after(() => f.db.close());
  const a = f.integration.openOwnerRequest(f.contexts.A), b = f.integration.openOwnerRequest(f.contexts.B);
  assert.notEqual(a.context, f.contexts.A); assert.ok(Object.isFrozen(a.context));
  f.integration.service.createExercise(a.context, 'same-key', personalFields);
  f.integration.service.createExercise(b.context, 'same-key', { ...personalFields, name: 'B movement' });
  assert.equal(f.integration.service.exercises(a.context, {}).items.length, 1);
  assert.equal(f.integration.service.exercises(b.context, {}).items.length, 1);
  a.release(); a.release();
  assert.throws(() => f.integration.service.createExercise(a.context, 'same-key', personalFields), code('activity_owner_channel_required'));
  assert.equal(f.integration.service.createExercise(b.context, 'same-key', { ...personalFields, name: 'B movement' }).status, 201);
  b.release();
});
test('canonical, forged, copied and deserialized contexts cannot write or replay a receipt', t => {
  const f = fixture(); t.after(() => f.db.close());
  const lease = f.integration.openOwnerRequest(f.contexts.A);
  f.integration.service.createExercise(lease.context, 'existing-key', personalFields);
  for (const context of [f.contexts.A, { ...lease.context }, JSON.parse(JSON.stringify(lease.context)) as AccountContext,
    { ...lease.context, channel: 'owner-activity-input-v1', active: true }])
    assert.throws(() => f.integration.service.createExercise(context, 'existing-key', personalFields), code('activity_owner_channel_required'));
  lease.release();
});
test('release does not transfer a late request grant to a newly opened request', t => {
  const f = fixture(); t.after(() => f.db.close());
  const old = f.integration.openOwnerRequest(f.contexts.A); old.release();
  const fresh = f.integration.openOwnerRequest(f.contexts.A);
  assert.throws(() => f.integration.service.createExercise(old.context, 'late-key', personalFields), code('activity_owner_channel_required'));
  assert.equal(f.integration.service.createExercise(fresh.context, 'fresh-key', personalFields).status, 201);
  fresh.release();
});
test('channel checks a fixed operation allowlist without inspecting a hostile payload', t => {
  const f = fixture(); t.after(() => f.db.close());
  const channel = createOwnerActivityRequestChannel({ lifecycle: f.lifecycle, assertAuthority: () => f.lifecycle.assertActive(f.contexts.A) });
  const lease = channel.openOwnerRequest(f.contexts.A);
  const sentinel = new Proxy({}, { get() { throw new Error('payload_read'); }, ownKeys() { throw new Error('payload_keys'); } });
  channel.assertPersistable(lease.context, 'entry.create', sentinel);
  channel.assertPersistable(lease.context, 'plan.importLegacy', { origin: {}, legacySnapshot: sentinel });
  assert.throws(() => channel.assertPersistable(lease.context, 'profile.write' as ActivityOperation, sentinel), code('activity_owner_channel_required'));
  lease.release(); assert.throws(() => channel.assertPersistable(lease.context, 'entry.create', sentinel), code('activity_owner_channel_required'));
});
for (const variation of ['expired', 'revoked', 'epoch', 'suppression', 'authority-unavailable'] as const) {
  test(`canonical ${variation} is rechecked before write and receipt replay`, t => {
    const f = fixture(); t.after(() => f.db.close());
    const lease = f.integration.openOwnerRequest(f.contexts.A);
    f.integration.service.createExercise(lease.context, 'replay-key', personalFields);
    if (variation === 'expired') f.db.prepare('UPDATE session SET expiresAt=0 WHERE id=?').run(lease.context.sessionId);
    if (variation === 'revoked') f.db.prepare('DELETE FROM session WHERE id=?').run(lease.context.sessionId);
    if (variation === 'epoch') f.db.prepare('UPDATE account_lifecycle SET epoch=1 WHERE account_id=?').run(lease.context.accountId);
    if (variation === 'suppression') f.suppress(lease.context.accountId);
    if (variation === 'authority-unavailable') f.authorityAvailable(false);
    assert.throws(() => f.integration.service.createExercise(lease.context, 'replay-key', personalFields));
    assert.throws(() => f.integration.openOwnerRequest(f.contexts.A));
    lease.release();
  });
}
test('missing lifecycle schema or authority cannot accept epoch zero', t => {
  const cases: ReadonlyArray<{ lifecycleSchema?: boolean; authority?: boolean }> = [{ lifecycleSchema: false }, { authority: false }];
  for (const options of cases) {
    const f = fixture(options); t.after(() => f.db.close());
    assert.throws(() => f.integration.openOwnerRequest(f.contexts.A), code(options.lifecycleSchema === false
      ? 'activity_lifecycle_schema_required' : 'suppression_authority_required'));
    assert.throws(() => f.integration.service.calendar(f.contexts.A));
  }
});
test('uninitialized account and cross-account auth/session tuples cannot mint owner channels', t => {
  const f = fixture(); t.after(() => f.db.close());
  for (const context of [{ ...f.contexts.A, accountId: 'missing' }, { ...f.contexts.A, authUserId: f.contexts.B.authUserId },
    { ...f.contexts.A, sessionId: f.contexts.B.sessionId }]) assert.throws(() => f.integration.openOwnerRequest(context), code('account_session_invalid'));
});
test('source restore of active epoch zero does not undo surviving suppression authority', t => {
  const f = fixture(); t.after(() => f.db.close());
  const lease = f.integration.openOwnerRequest(f.contexts.A); f.suppress(lease.context.accountId);
  assert.equal((f.db.prepare('SELECT state FROM account_lifecycle WHERE account_id=?').get(lease.context.accountId) as { state: string }).state, 'active');
  assert.throws(() => f.integration.service.createExercise(lease.context, 'restored-key', personalFields), code('account_disabled'));
  assert.equal(f.integration.lifecycleAdapter.verifySuppressed(lease.context.accountId, 1).status, 'complete');
  assert.equal(f.integration.lifecycleAdapter.purge('not-authorized', lease.context.accountId).status, 'unavailable');
  lease.release();
});

for (const variation of ['session', 'epoch', 'suppression'] as const) {
  test(`late canonical ${variation} at writer entry rolls back without a receipt`, t => {
    const f = fixture(); t.after(() => f.db.close());
    const integration = createActivityIntegration({ db: f.db, lifecycleControl: f.lifecycleControl,
      lifecycle: { ...f.lifecycle, withActiveWrite<T>(context: AccountContext, effect: () => T): T {
        return f.lifecycle.withActiveWrite(context, () => {
          if (variation === 'session') f.db.prepare('DELETE FROM session WHERE id=?').run(context.sessionId);
          if (variation === 'epoch') f.db.prepare('UPDATE account_lifecycle SET epoch=1 WHERE account_id=?').run(context.accountId);
          if (variation === 'suppression') f.suppress(context.accountId);
          return effect();
        });
      } },
    });
    const lease = integration.openOwnerRequest(f.contexts.A);
    assert.throws(() => integration.service.createExercise(lease.context, 'late-writer-key', personalFields));
    assert.equal((f.db.prepare('SELECT count(*) AS n FROM activity_exercises').get() as { n: number }).n, 0);
    assert.equal((f.db.prepare('SELECT count(*) AS n FROM command_receipts').get() as { n: number }).n, 0);
    lease.release();
  });
}
