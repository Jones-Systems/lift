import test from 'node:test';
import assert from 'node:assert/strict';
import { digest } from '../../src/wearables/validation.ts';
import { fixture, faultStore, a, b, direct, tokens, controllerFixture, ouraPage, ouraRange } from './provider-controller-fixture.mjs';

test('existing disconnect consumes auth purge with local data removal and remote revocation still pending', t => {
  const h = fixture(t); h.seed({ generation: 1 }); h.seed(); h.seed({ generation: 4 });
  const future = h.seed({ generation: 5 }), other = h.seed({ connectionId: 'invented-other' }), foreign = h.seed({ ctx: b });
  h.populateImport();
  const result = h.service.disconnect(a, 'invented-disconnect', { connectionId: direct.id, generation: direct.generation });
  assert.deepEqual(result, { disconnected: true, purged: true, remoteRevocation: 'pending' });
  assert.deepEqual(h.rows().map(row => row.record_key).sort(), [future.key, other.key, foreign.key].sort());
  assert.deepEqual(h.store.connection(a, direct.id), { ...direct, generation: 4, connected: false, retentionConsent: false, lastImportAt: '2026-10-11T00:00:00Z' });
  for (const table of ['wearable_provider_intents', 'wearable_cursors', 'wearable_measures']) {
    assert.equal(h.db.prepare(`SELECT count(*) AS n FROM ${table} WHERE account_id=? AND connection_id=?`).get(a.accountId, direct.id).n, 0);
  }
  assert.throws(() => h.service.disconnect(a, 'invented-disconnect', { connectionId: direct.id, generation: direct.generation }), /receipt_purged/);
  assert.equal(h.calls(), 1);
});

test('disconnected but consented pending connection is not retirement authority', t => {
  const h = fixture(t); h.seed(); const before = h.rows();
  h.write(a, () => { h.retire({ retentionConsent: true }); assert.equal(h.hook(a, h.retired).status, 'unknown'); });
  assert.deepEqual(h.rows(), before);
});

test('connected, missing, HealthKit or wrong-generation connection cannot authorize auth purge', t => {
  const h = fixture(t); h.seed(); const before = h.rows();
  h.write(a, () => {
    assert.equal(h.hook(a, { connectionId: direct.id, generation: direct.generation }).status, 'unknown');
    assert.equal(h.hook(a, { connectionId: 'missing', generation: 1 }).status, 'unknown');
    h.retire(); assert.equal(h.hook(a, { ...h.retired, generation: 3 }).status, 'unknown');
    h.store.putConnection(a, { ...h.store.connection(a, 'hk'), generation: 2, connected: false, retentionConsent: false });
    assert.equal(h.hook(a, { connectionId: 'hk', generation: 2 }).status, 'unknown');
  });
  assert.deepEqual(h.rows(), before);
});

test('existing exact root writer custody is mandatory; purge never opens its own transaction', t => {
  const h = fixture(t); h.seed(); h.write(a, () => h.retire()); const before = h.rows();
  assert.equal(h.hook(a, h.retired).status, 'unknown');
  h.db.transaction(() => assert.equal(h.hook(a, h.retired).status, 'unknown')).immediate();
  assert.deepEqual(h.rows(), before);
});

test('original account, auth identity, session and epoch must match root writer context', t => {
  const h = fixture(t); h.seed(); const before = h.rows();
  h.write(a, () => {
    h.retire();
    for (const changed of [{ ...a, accountId: b.accountId }, { ...a, authUserId: b.authUserId },
      { ...a, sessionId: b.sessionId }, { ...a, epoch: a.epoch + 1 }]) assert.equal(h.hook(changed, h.retired).status, 'unknown');
  });
  assert.deepEqual(h.rows(), before);
});

test('bounded account overflow fails closed before deleting any matching record', t => {
  const h = fixture(t); h.seed({ generation: 1 }); h.seed(); const before = h.rows();
  const hook = h.makeHook({ maxAccountRecords: 1 });
  h.write(a, () => { h.retire(); assert.equal(hook(a, h.retired).status, 'unknown'); });
  assert.deepEqual(h.rows(), before);
  for (const maxAccountRecords of [0, 257, 1.5]) assert.throws(() => h.makeHook({ maxAccountRecords }), /provider_auth_purge_invalid/);
});

test('failed second CAS delete rolls back first deletion even when root catches the unknown result', t => {
  const h = fixture(t); h.seed({ generation: 1 }); h.seed(); const before = h.rows(); let deletes = 0;
  const hook = h.makeHook({ authStore: faultStore(h.authStore, tx => ({ ...tx,
    delete(key, revision) { return ++deletes === 2 ? false : tx.delete(key, revision); } })) });
  h.write(a, () => {
    h.retire(); h.db.prepare('INSERT INTO provider_fixture_markers VALUES(?)').run('root-kept');
    assert.equal(hook(a, h.retired).status, 'unknown');
  });
  assert.equal(deletes, 2); assert.deepEqual(h.rows(), before);
  assert.equal(h.db.prepare('SELECT count(*) AS n FROM provider_fixture_markers').get().n, 1);
});

test('failed zero-record readback rolls back successful deletes', t => {
  const h = fixture(t), seeded = h.seed(), before = h.rows(); let lists = 0;
  const hook = h.makeHook({ authStore: faultStore(h.authStore, tx => ({ ...tx,
    listAccount(account, limit) { return ++lists === 2 ? [structuredClone(seeded)] : tx.listAccount(account, limit); } })) });
  h.write(a, () => { h.retire(); assert.equal(hook(a, h.retired).status, 'unknown'); });
  assert.equal(lists, 2); assert.deepEqual(h.rows(), before);
});

test('late loss of retired-connection proof rolls back both deletion and the injected connection change', t => {
  const h = fixture(t); h.seed(); const before = h.rows();
  const hook = h.makeHook({ authStore: faultStore(h.authStore, tx => ({ ...tx,
    delete(key, revision) { const result = tx.delete(key, revision); h.retire({ retentionConsent: true }); return result; } })) });
  h.write(a, () => { h.retire(); assert.equal(hook(a, h.retired).status, 'unknown'); });
  assert.deepEqual(h.rows(), before); assert.equal(h.store.connection(a, direct.id).retentionConsent, false);
});

test('late root currentness failure rolls back deletes before returning unknown', t => {
  const h = fixture(t); h.seed(); const before = h.rows(); let deleted = false;
  const hook = h.makeHook({ assertActive(ctx) { h.deps.lifecycle.assertActive(ctx); if (deleted) throw Error('invented-private-currentness'); },
    authStore: faultStore(h.authStore, tx => ({ ...tx, delete(key, revision) { const result = tx.delete(key, revision); deleted = true; return result; } })) });
  h.write(a, () => { h.retire(); assert.deepEqual(hook(a, h.retired), { status: 'unknown', reason: 'local_connection_auth_purge_unproved' }); });
  assert.deepEqual(h.rows(), before);
});

test('unknown auth purge denies the existing service purged result and rolls back connection retirement', t => {
  const h = fixture(t); h.seed(); h.populateImport(); const before = h.rows(), connection = h.store.connection(a, direct.id);
  h.setHook(h.makeHook({ authStore: faultStore(h.authStore, tx => ({ ...tx, delete: () => false })) }));
  assert.throws(() => h.service.disconnect(a, 'invented-failed-disconnect', { connectionId: direct.id, generation: direct.generation }));
  assert.deepEqual(h.rows(), before); assert.deepEqual(h.store.connection(a, direct.id), connection);
  assert.equal(h.db.prepare('SELECT count(*) AS n FROM wearable_provider_intents WHERE account_id=?').get(a.accountId).n, 1);
});

test('outer disconnect failure rolls back a successful inner auth purge', t => {
  const h = fixture(t); h.seed(); const before = h.rows();
  h.setAfterHook(result => { assert.equal(result.status, 'complete'); throw Error('invented-outer-failure'); });
  assert.throws(() => h.service.disconnect(a, 'invented-outer-disconnect', { connectionId: direct.id, generation: direct.generation }));
  assert.deepEqual(h.rows(), before); assert.deepEqual(h.store.connection(a, direct.id), direct);
});

test('retirement fences late token completion after purging an unresolved exchange', t => {
  const h = fixture(t), auth = h.makeAuth();
  const state = new URL(auth.beginAuthorization('https://form.invalid/callback', ['daily']).url).searchParams.get('state');
  const callback = auth.consumeCallback(state, 'invented-code'), lease = auth.vault.begin('code', callback.operationId);
  const result = h.service.disconnect(a, 'invented-uncertain-disconnect', { connectionId: direct.id, generation: direct.generation });
  assert.equal(result.remoteRevocation, 'pending'); assert.equal(h.rows().length, 0);
  assert.throws(() => auth.vault.commit(lease.id, tokens)); assert.equal(h.rows().length, 0);
});

test('empty local readback completes only with retirement proof and exposes no remote claim', t => {
  const h = fixture(t);
  h.write(a, () => { h.retire(); assert.deepEqual(h.hook(a, h.retired), {
    status: 'complete', count: 0, reason: 'local_connection_auth_absent_remote_revocation_unproved' }); });
  assert.equal(h.hook(a, { ...h.retired, generation: -1 }).status, 'unknown');
});

test('controller consumes pending prepare, persistent OAuth and guarded activation before Oura ingestion', async t => {
  const h = controllerFixture(t), binding = h.prepare(), pending = h.store.connection(a, binding.connectionId);
  assert.equal(pending.connected, false); assert.deepEqual(pending.pendingAuthorization, { sessionId: a.sessionId, epoch: a.epoch });
  assert.throws(() => h.controller.wearables.authorizeImport(a, 'oura', binding.connectionId, binding.generation));
  const auth = h.authorize(binding); h.state.responses.push(tokens);
  const receipt = await auth.session.completeCode(auth.callbackState, 'invented-code'); assert.equal(receipt.version, 1);
  const live = h.store.connection(a, binding.connectionId); assert.equal(live.connected, true); assert.equal(live.pendingAuthorization, undefined);
  h.state.responses.push(ouraPage); const imported = await auth.session.importOuraPage(ouraRange); assert.equal(imported.accepted, 2);
  const values = h.db.prepare('SELECT data FROM wearable_measures WHERE connection_id=?').all(binding.connectionId).map(row => JSON.parse(row.data));
  assert.ok(values.every(value => value.aiEligible === false && value.provenance === 'unqualified_import'));
  assert.deepEqual(h.controller.wearables.coachInputs(a), []); assert.equal(h.state.releases, 1);
  assert.equal(JSON.stringify(h.authRecord(binding)).includes(tokens.access_token), false);
});

test('activation write failure rolls back token CAS and leaves connection pending with an unknown exchange', async t => {
  const h = controllerFixture(t), auth = h.authorize();
  h.db.exec(`CREATE TRIGGER fixture_activation_failure BEFORE UPDATE ON wearable_connections
    WHEN json_extract(NEW.data,'$.connected')=1 BEGIN SELECT RAISE(ABORT,'invented activation failure'); END`);
  h.state.responses.push(tokens); await assert.rejects(auth.session.completeCode(auth.callbackState, 'invented-code'));
  assert.equal(h.authRecord(auth.binding).tokens, null); assert.equal(h.authRecord(auth.binding).operations[0].phase, 'unknown');
  assert.equal(h.store.connection(a, auth.binding.connectionId).connected, false);
  assert.equal(h.db.prepare("SELECT count(*) AS n FROM wearable_receipts WHERE key LIKE '%provider-activation%'").get().n, 0);
});

test('activation guard rejects fabricated, refresh and wrong-version proof; accepts original code receipt after rotation', async t => {
  const h = controllerFixture(t), auth = await h.connected(), code = h.authRecord(auth.binding).operations[0];
  const key = 'provider-activation:' + digest([
    { accountId: a.accountId, sessionId: a.sessionId, epoch: a.epoch, provider: 'oura', connectionId: auth.binding.connectionId, generation: auth.binding.generation }, code.operationId]);
  for (const proof of [{ operationId: 'invented-forged', version: 1 }, { operationId: code.operationId, version: 2 }]) {
    h.write(a, () => assert.throws(() => h.controller.wearables.activateDirectProviderConnectionWithinWrite(a, 'forged-key', auth.binding, proof)));
  }
  h.write(a, () => {
    assert.throws(() => h.controller.wearables.activateDirectProviderConnectionWithinWrite(b, 'wrong-context', auth.binding, { operationId: code.operationId, version: 1 }));
    assert.throws(() => h.controller.wearables.activateDirectProviderConnectionWithinWrite(a, 'wrong-provider', { ...auth.binding, provider: 'garmin' }, { operationId: code.operationId, version: 1 }));
  });
  h.state.responses.push({ ...tokens, access_token: 'invented-access-2', refresh_token: 'invented-refresh-2' });
  assert.equal((await auth.session.refresh('invented-refresh-op')).version, 2);
  h.write(a, () => {
    assert.throws(() => h.controller.wearables.activateDirectProviderConnectionWithinWrite(a, 'forged-refresh', auth.binding, { operationId: 'invented-refresh-op', version: 2 }));
    assert.deepEqual(h.controller.wearables.activateDirectProviderConnectionWithinWrite(a, key, auth.binding, { operationId: code.operationId, version: 1 }), auth.binding);
  });
  assert.throws(() => h.controller.wearables.activateDirectProviderConnectionWithinWrite(a, key, auth.binding, { operationId: code.operationId, version: 1 }));
});

test('lost import acknowledgement replays the persisted original page without another provider read', async t => {
  const h = controllerFixture(t), auth = await h.connected();
  h.db.exec("CREATE TRIGGER fixture_ack_failure BEFORE DELETE ON wearable_provider_intents BEGIN SELECT RAISE(ABORT,'invented ack loss'); END");
  const mutableRange = { ...ouraRange };
  h.state.afterDispatch = () => { mutableRange.cursor = 'changed-cursor'; mutableRange.to = '2026-10-11'; };
  h.state.responses.push(ouraPage); await assert.rejects(auth.session.importOuraPage(mutableRange)); h.state.afterDispatch = null;
  assert.equal(h.db.prepare('SELECT count(*) AS n FROM wearable_measures').get().n, 2);
  assert.equal(h.db.prepare('SELECT count(*) AS n FROM wearable_provider_intents').get().n, 1);
  h.db.exec('DROP TRIGGER fixture_ack_failure');
  await assert.rejects(auth.session.importOuraPage({ ...ouraRange, cursor: 'invented-next' }));
  const result = await h.make().session(auth.binding).importOuraPage(ouraRange);
  assert.equal(result.accepted, 2); assert.equal(h.state.calls.filter(call => call.method === 'GET').length, 1);
  assert.equal(h.db.prepare('SELECT count(*) AS n FROM wearable_provider_intents').get().n, 0);
});

test('no-save and provider admission deny dispatch and late no-save prevents intent or measure persistence', async t => {
  const h = controllerFixture(t), auth = await h.connected(); h.setPermitted(false);
  await assert.rejects(auth.session.importOuraPage(ouraRange)); assert.equal(h.state.calls.length, 1);
  h.setPermitted(true); h.state.allowed = false;
  await assert.rejects(auth.session.importOuraPage(ouraRange)); assert.equal(h.state.calls.length, 1);
  h.state.allowed = true; h.state.afterDispatch = () => h.setPermitted(false); h.state.responses.push(ouraPage);
  await assert.rejects(auth.session.importOuraPage(ouraRange));
  assert.equal(h.db.prepare('SELECT count(*) AS n FROM wearable_measures').get().n, 0);
  assert.equal(h.db.prepare('SELECT count(*) AS n FROM wearable_provider_intents').get().n, 0);
});

test('unknown OAuth outcome survives controller recreation and callback replay never redispatches', async t => {
  const h = controllerFixture(t), auth = h.authorize(); h.state.responses.push(Error('invented ambiguous network failure'));
  await assert.rejects(auth.session.completeCode(auth.callbackState, 'invented-code'));
  const operation = h.authRecord(auth.binding).operations[0], recreated = h.make().session(auth.binding);
  assert.deepEqual(recreated.reconcile(operation.operationId), { status: 'unknown' });
  assert.throws(() => recreated.beginAuthorization('https://form.invalid/callback', ['daily']));
  assert.throws(() => recreated.completeCode(auth.callbackState, 'invented-code')); assert.equal(h.state.calls.length, 1);
});

test('original session, lifecycle epoch and connection generation fence controller reuse', async t => {
  for (const field of ['session', 'epoch', 'generation']) {
    const h = controllerFixture(t), auth = await h.connected();
    if (field === 'session') h.db.prepare('DELETE FROM session WHERE id=?').run(a.sessionId);
    if (field === 'epoch') h.db.prepare('UPDATE account_lifecycle SET epoch=epoch+1 WHERE account_id=?').run(a.accountId);
    if (field === 'generation') h.write(a, () => h.store.putConnection(a, { ...h.store.connection(a, auth.binding.connectionId), generation: 2 }));
    assert.throws(() => h.make().session(auth.binding));
    await assert.rejects(auth.session.importOuraPage(ouraRange)); assert.equal(h.state.calls.length, 1);
  }
});

test('controller disconnect composes auth purge with other duties and never promotes missing coverage', async t => {
  const h = controllerFixture(t), auth = await h.connected();
  const absent = h.make({ root: { ...h.deps, externalConnectionPurge: undefined, externalLifecycle: undefined } });
  assert.throws(() => absent.disconnect('missing-duties', auth.binding));
  assert.equal(absent.lifecycle.inventory(a).status, 'unavailable');
  assert.equal(h.store.connection(a, auth.binding.connectionId).connected, true); assert.ok(h.authRecord(auth.binding));
  const unknown = h.make({ root: { ...h.deps, externalConnectionPurge: () => ({ status: 'unknown', reason: 'invented-other-unknown' }) } });
  assert.throws(() => unknown.disconnect('unknown-duties', auth.binding)); assert.ok(h.authRecord(auth.binding));
  assert.deepEqual(h.controller.disconnect('complete-duties', auth.binding), { disconnected: true, purged: true, remoteRevocation: 'pending' });
  assert.equal(h.authRecord(auth.binding), null); assert.throws(() => auth.session.beginAuthorization('https://form.invalid/callback', ['daily']));
});

test('Garmin public registration uses persistent OAuth while missing decoders and private health remain unavailable', async t => {
  const h = controllerFixture(t), auth = await h.connected('garmin'); h.state.responses.push({ userId: 'invented-garmin-user' });
  assert.deepEqual(await auth.session.garminUserId(), { userId: 'invented-garmin-user' });
  await assert.rejects(auth.session.garminPermissions()); assert.throws(() => auth.session.garminHealthUnavailable());
  assert.equal(h.state.calls.length, 2);
  const configured = h.make({ decodeGarminPermissions: body => body.granted }).session(auth.binding);
  h.state.responses.push({ granted: ['invented-permission'] }); assert.deepEqual(await configured.garminPermissions(), ['invented-permission']);
});

test('activation proof reads original unsuppressed committed code state rather than caller assertions', async t => {
  const h = controllerFixture(t), auth = await h.connected(), original = h.authRecord(auth.binding), code = original.operations[0];
  for (const mutate of [
    value => { value.scope.sessionId = 'invented-other-session'; },
    value => { value.suppressedEpoch = 1; },
    value => { const op = value.operations[0]; op.phase = 'ready'; op.leaseId = null; op.startedAtMs = null; op.receipt = null; op.tokenDigest = null; },
    value => { value.operations[0].kind = 'refresh'; },
  ]) {
    h.write(a, () => {
      const modified = structuredClone(original); mutate(modified);
      h.db.prepare('UPDATE wearable_provider_auth_state SET data=? WHERE record_key=?').run(JSON.stringify(modified), original.key);
      assert.throws(() => h.controller.wearables.activateDirectProviderConnectionWithinWrite(a, 'invented-proof-check', auth.binding, { operationId: code.operationId, version: 1 }), /provider_committed_code_required/);
      h.db.prepare('UPDATE wearable_provider_auth_state SET data=? WHERE record_key=?').run(JSON.stringify(original), original.key);
    });
  }
});

test('expanded Oura pages above canonical batch capacity leave intent, cursor and measures unchanged', async t => {
  const h = controllerFixture(t), auth = await h.connected();
  h.state.responses.push({ data: Array.from({ length: 251 }, (_, index) => ({ ...ouraPage.data[0], id: 'invented-day-' + index })), next_token: 'invented-next' });
  await assert.rejects(auth.session.importOuraPage(ouraRange), /health_batch_limit/);
  for (const table of ['wearable_provider_intents', 'wearable_cursors', 'wearable_measures']) assert.equal(h.db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, 0);
  assert.equal(h.state.calls.filter(call => call.method === 'GET').length, 1);
});

test('authoritative suppression during OAuth response prevents activation and preserves unresolved local effect', async t => {
  const h = controllerFixture(t), auth = h.authorize(); h.state.responses.push(tokens); h.state.afterDispatch = () => h.disable(a);
  await assert.rejects(auth.session.completeCode(auth.callbackState, 'invented-code'));
  const stored = h.authRecord(auth.binding); assert.equal(stored.tokens, null); assert.ok(['leased', 'unknown'].includes(stored.operations[0].phase));
  const connection = JSON.parse(h.db.prepare('SELECT data FROM wearable_connections WHERE account_id=? AND connection_id=?').get(a.accountId, auth.binding.connectionId).data);
  assert.equal(connection.connected, false); assert.throws(() => h.make().session(auth.binding)); assert.equal(h.state.calls.length, 1);
});
