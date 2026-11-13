const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs'), path = require('node:path'), ts = require('typescript');
const root = path.resolve(__dirname, '../../..'), cache = new Map();
function load(relative) {
  const file = path.resolve(root, relative);
  assert.ok(file.startsWith(root + path.sep));
  if (cache.has(file)) return cache.get(file).exports;
  const module = { exports: {} }; cache.set(file, module);
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function('require', 'module', 'exports', code)(name => {
    assert.ok(name.startsWith('.'));
    return load(path.relative(root, path.resolve(path.dirname(file), name + '.ts')));
  }, module, module.exports);
  return module.exports;
}
const { CommunityResources } = load('api/community.ts');
const { FormTransport } = load('api/transport.ts');
const { createAliasExitPresentation } = load('community/alias-exit-ui/presentation.ts');
const { aliasValidation, confirmedReceipt, semanticNotice } = load('community/alias-exit-ui/projection.ts');
const G = '11111111-1111-4111-8111-111111111111', M = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const detail = (role = 'owner') => ({ id: G, name: 'Synthetic group', role, revision: 4, memberId: M,
  members: [{ memberId: M, alias: 'Leaf', role, revision: 7 }, { memberId: OTHER, alias: 'Other', role: 'member', revision: 9 }] });
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function fixture(mode = 'alias', options = {}) {
  const calls = [], state = { detail: detail(options.role), response: options.response ?? null, generation: 1, closed: 0 };
  const transport = new FormTransport('https://synthetic.invalid', { load: async () => null, save: async () => {}, clear: async () => {} }, async (url, init) => {
    if (url.includes('/api/auth/sign-in')) return new Response('{}', { headers: { 'set-auth-token': 'synthetic-session' } });
    const call = { path: new URL(url).pathname.replace('/v1/community', ''), method: init.method,
      body: init.body === undefined ? undefined : JSON.parse(init.body), raw: init.body, key: init.headers['Idempotency-Key'] };
    calls.push(call);
    const value = state.response ? await state.response(call) : call.method === 'GET' ? state.detail : call.path.endsWith('/me')
      ? { ...state.detail.members[0], alias: call.body.alias.trim(), revision: 8 } : call.path.endsWith('/leave') ? { left: true } : { closed: true };
    return value instanceof Response ? value : json(value);
  });
  await transport.signIn('synthetic@example.invalid', 'synthetic-password');
  const resources = new CommunityResources(transport, () => true), controller = resources.createGroupController();
  if (!options.idle) await controller.loadDetail(G);
  const context = { controller, groupId: G, sessionGeneration: 1, isCurrentSession: generation => state.generation === generation,
    onClose: () => { state.closed++; } };
  const create = (selected = mode, ctx = context) => createAliasExitPresentation(ctx, selected, randomUUID);
  const model = create(); model.attach();
  return { calls, state, controller, resources, context, model, create };
}
const writes = f => f.calls.filter(call => call.method !== 'GET');

test('entry loads idle detail once, preserves ready detail and requires explicit refresh of stale or mismatching detail', async () => {
  const waiting = deferred(), f = await fixture('alias', { idle: true, response: () => waiting.promise });
  assert.equal(f.calls.length, 1); assert.equal(f.model.getSnapshot().detailStatus, 'loading');
  assert.equal(f.model.getSnapshot().canSubmit, false); f.model.attach(); f.model.attach();
  assert.equal(f.calls.length, 1);
  const loaded = new Promise(resolve => {
    const subscription = f.model.subscribe(() => {
      if (f.model.getSnapshot().detailStatus === 'ready' && f.model.getSnapshot().canEdit) { subscription.remove(); resolve(); }
    });
  });
  waiting.resolve(detail()); await loaded;
  assert.equal(f.model.getSnapshot().draft, 'Leaf');
  f.state.response = () => { throw new Error('lost'); }; f.model.setDraft('Attempt'); await f.model.submit();
  const count = f.calls.length; f.model.detach(); const remount = f.create(); remount.attach();
  assert.equal(f.calls.length, count); assert.equal(remount.getSnapshot().canRefresh, false);
  const wrongGroup = f.create('alias', { ...f.context, groupId: OTHER }); wrongGroup.attach();
  assert.equal(f.calls.length, count); assert.equal(wrongGroup.getSnapshot().canSubmit, false);
  assert.equal(wrongGroup.getSnapshot().canRetry, false);
});

test('alias explicitly saves only own member with member revision and crypto key, never group revision', async () => {
  const f = await fixture(), before = f.calls.length;
  assert.equal(f.model.getSnapshot().draft, 'Leaf'); assert.equal(f.calls.length, before);
  f.model.setDraft(' New alias '); await f.model.submit();
  assert.equal(writes(f).length, 1);
  assert.deepEqual(writes(f)[0].body, { alias: 'New alias', expectedRevision: 7 });
  assert.match(writes(f)[0].key, /^[0-9a-f-]{36}$/);
  assert.equal(f.controller.getSnapshot().command.memberId, M);
  assert.equal(f.model.getSnapshot().receipt, 'Alias saved: New alias');
  assert.equal(f.model.getSnapshot().canSubmit, false); assert.equal(f.state.closed, 0);
  f.state.detail = { ...detail(), members: [{ ...detail().members[0], alias: 'New alias', revision: 8 }] };
  const count = writes(f).length; await f.model.refresh(); assert.equal(writes(f).length, count);
  assert.equal(f.model.getSnapshot().canEdit, false); assert.equal(f.model.getSnapshot().canReview, true);
  f.model.review(); assert.equal(f.model.getSnapshot().canEdit, true);
  f.model.setDraft('Second explicit alias'); await f.model.submit();
  assert.equal(writes(f).length, 2); assert.equal(writes(f)[1].body.expectedRevision, 8);
  assert.notEqual(writes(f)[1].key, writes(f)[0].key);
});

test('actual API empty length trim and forbidden-character rules are reflected without new URL/name policy', async () => {
  const f = await fixture();
  for (const value of ['', '  ', 'x'.repeat(61), '<tag>', 'a\nb']) {
    f.model.setDraft(value); assert.equal(f.model.getSnapshot().canSubmit, false); await f.model.submit();
  }
  assert.equal(writes(f).length, 0);
  for (const value of ['www.example.invalid', 'é'.repeat(60), '😀'.repeat(30)]) assert.equal(aliasValidation(value), null);
  assert.ok(aliasValidation('😀'.repeat(31)));
  f.model.setDraft('www.example.invalid'); await f.model.submit(); assert.equal(writes(f).length, 1);
});

test('wrong returned member is unknown, never receipt; retry preserves original body key and member guard', async () => {
  const f = await fixture(); f.model.setDraft('Original intent');
  f.state.response = () => ({ ...detail().members[0], memberId: OTHER, alias: 'Wrong member', revision: 8 });
  await f.model.submit();
  const first = writes(f)[0]; assert.equal(f.model.getSnapshot().receipt, null);
  assert.equal(f.controller.getSnapshot().command.intent.state, 'unknown');
  assert.equal(f.model.getSnapshot().canRetry, true);
  f.model.setDraft('Replacement'); await f.model.submit(); await f.model.refresh(); f.model.close();
  assert.equal(writes(f).length, 1); assert.equal(f.state.closed, 0);
  f.state.response = () => ({ ...detail().members[0], alias: 'Original intent', revision: 8 });
  await f.model.retry(); const last = writes(f).at(-1);
  assert.equal(last.key, first.key); assert.equal(last.raw, first.raw);
  assert.equal(f.model.getSnapshot().receipt, 'Alias saved: Original intent');
});

test('pending double activation is synchronously guarded and Back Cancel edit and reload cannot dispatch', async () => {
  const f = await fixture('leave'), waiting = deferred(); f.state.response = () => waiting.promise;
  const retainedClose = f.model.close, first = f.model.submit();
  await f.model.submit(); await f.model.retry(); await f.model.refresh(); retainedClose();
  assert.equal(writes(f).length, 1); assert.equal(f.model.getSnapshot().pending, true);
  assert.equal(f.model.getSnapshot().canClose, false); assert.equal(f.state.closed, 0);
  waiting.resolve({ left: true }); await first;
  assert.equal(f.model.getSnapshot().receipt, 'You left the group.');
  retainedClose(); assert.equal(f.state.closed, 1);
});

test('leave and close are separate explicit confirmations with strict result validation and no inferred exit', async () => {
  for (const mode of ['leave', 'close']) {
    const f = await fixture(mode); assert.equal(writes(f).length, 0);
    f.state.response = () => mode === 'leave' ? { left: false } : { closed: true, removed: true };
    await f.model.submit(); assert.equal(f.model.getSnapshot().receipt, null);
    assert.equal(f.model.getSnapshot().unresolved, true);
    assert.deepEqual(writes(f)[0].body, mode === 'leave' ? {} : { expectedRevision: 4 });
    f.state.response = () => mode === 'leave' ? { left: true } : { closed: true };
    await f.model.retry();
    assert.equal(f.model.getSnapshot().receipt, mode === 'leave' ? 'You left the group.' : 'The group is closed.');
    const otherMode = f.create(mode === 'leave' ? 'close' : 'leave'); otherMode.attach();
    assert.equal(otherMode.getSnapshot().receipt, null); otherMode.detach();
  }
});

test('close owner/group revision gate and owner leave denial never turn into automatic closure', async () => {
  for (const role of ['admin', 'member']) {
    const f = await fixture('close', { role }); assert.equal(f.model.getSnapshot().canSubmit, false);
    await f.model.submit(); assert.equal(writes(f).length, 0);
    await assert.rejects(f.controller.closeGroup(G, { expectedRevision: 4, confirmed: true }, randomUUID()), { code: 'community_forbidden' });
  }
  const f = await fixture('leave');
  f.state.response = () => json({ error: { code: 'community_owner_must_close', message: 'unsafe payload' } }, 409);
  await f.model.submit(); assert.equal(f.model.getSnapshot().receipt, null);
  assert.equal(f.model.getSnapshot().notice.text, 'The group owner cannot leave this group.');
  assert.deepEqual(writes(f).map(call => call.path), [`/groups/${G}/leave`]);
  const owner = await fixture('close');
  await assert.rejects(owner.controller.closeGroup(G, { expectedRevision: 7, confirmed: true }, randomUUID()), { code: 'community_membership_reload_required' });
  await owner.model.submit(); assert.deepEqual(writes(owner)[0].body, { expectedRevision: 4 });
});

test('unknown remount reads retained controller command and retry alone recovers its exact fields', async () => {
  const f = await fixture('alias'); f.model.setDraft('Retained');
  f.state.response = () => { throw new Error('lost response'); }; await f.model.submit();
  const original = writes(f)[0], retained = f.model.submit; f.model.detach();
  const remount = f.create(); remount.attach();
  assert.equal(remount.getSnapshot().canRetry, true); assert.equal(remount.getSnapshot().draft, '');
  await retained(); assert.equal(writes(f).length, 1);
  f.state.response = () => ({ ...detail().members[0], alias: 'Retained', revision: 8 });
  await remount.retry();
  assert.equal(writes(f).at(-1).raw, original.raw); assert.equal(writes(f).at(-1).key, original.key);
  assert.equal(remount.getSnapshot().receipt, 'Alias saved: Retained');
  assert.equal(f.controller.getSnapshot().disposed, false);
});

test('foreign group or kind pending/unknown is never overwritten or retried or reported successful here', async () => {
  for (const target of [G, OTHER]) {
    const f = await fixture('alias'); f.state.response = () => { throw new Error('lost'); };
    await assert.rejects(f.controller.leave(target, { confirmed: true }, 'foreign'));
    const reads = f.calls.length, view = f.model.getSnapshot();
    assert.equal(view.unresolved, true); assert.equal(view.canRetry, false); assert.equal(view.canClose, false);
    assert.equal(view.receipt, null); assert.match(view.notice.text, /Another Community change/);
    await f.model.submit(); await f.model.retry(); await f.model.refresh(); f.model.close();
    assert.equal(f.calls.length, reads); assert.equal(f.controller.getSnapshot().command.key, 'foreign');
  }
});

test('original uncertainty survives authoritative retry rejection and cannot be replaced with a new key', async () => {
  const f = await fixture('leave'); f.state.response = () => { throw new Error('lost'); }; await f.model.submit();
  const original = writes(f)[0];
  f.state.response = () => json({ error: { code: 'community_membership_changed' } }, 409); await f.model.retry();
  assert.equal(f.controller.getSnapshot().command.error.originalEffectUnknown, true);
  assert.equal(f.model.getSnapshot().canSubmit, false); assert.equal(f.model.getSnapshot().receipt, null);
  await f.model.submit(); assert.equal(writes(f).length, 2); assert.equal(writes(f)[1].key, original.key);
});

test('rejections sanitize server text and distinguish semantic codes without erasing transport uncertainty', async () => {
  const messages = new Set();
  for (const [code, status] of [['community_text_rejected', 422], ['community_text_moderation_unavailable', 503],
    ['stale_revision', 409], ['community_forbidden', 403], ['community_rate_limited', 429], ['community_unavailable', 503]]) {
    const f = await fixture(); f.model.setDraft('Sensitive rejected alias');
    f.state.response = () => json({ error: { code, message: 'Sensitive rejected alias', details: { alias: 'Sensitive rejected alias' } } }, status);
    await f.model.submit(); const view = f.model.getSnapshot();
    assert.equal(view.receipt, null); assert.equal(view.canSubmit, false);
    assert.ok(!view.notice.text.includes('Sensitive'));
    messages.add(semanticNotice(f.controller.getSnapshot().command.error).text);
    if (status >= 500) { assert.equal(view.unresolved, true); assert.equal(view.canRetry, true); }
    else assert.equal(view.unresolved, false);
    assert.equal(f.controller.getSnapshot().detail.status, 'stale');
  }
  assert.equal(messages.size, 6);
});

test('stale and replacement membership keep draft and original revision until explicit fresh review', async () => {
  const f = await fixture(); f.model.setDraft('Unsaved draft');
  f.state.detail = { ...detail(), revision: 5, members: [{ ...detail().members[0], alias: 'New current', revision: 10 }] };
  await f.controller.loadDetail(G);
  assert.equal(f.model.getSnapshot().draft, 'Unsaved draft'); assert.equal(f.model.getSnapshot().canSubmit, false);
  await f.model.submit(); assert.equal(writes(f).length, 0);
  f.model.review(); assert.equal(f.model.getSnapshot().draft, 'New current');
  f.model.setDraft('Reviewed intent'); await f.model.submit(); assert.equal(writes(f)[0].body.expectedRevision, 10);
});

test('missing own member is not an exit receipt; read loading stale and error do not enable alias', async () => {
  const f = await fixture(); const waiting = deferred(); f.state.response = () => waiting.promise;
  const read = f.controller.loadDetail(G); assert.equal(f.model.getSnapshot().detailStatus, 'loading');
  assert.equal(f.model.getSnapshot().canSubmit, false);
  waiting.resolve({ ...detail(), members: [] }); await read;
  assert.equal(f.model.getSnapshot().canEdit, false); assert.equal(f.model.getSnapshot().receipt, null);
  f.state.response = () => json({ error: { code: 'community_unavailable' } }, 503);
  await f.model.refresh(); assert.equal(f.model.getSnapshot().detailStatus, 'error'); assert.equal(f.model.getSnapshot().canSubmit, false);
});

test('late completion account-generation change and permanently detached callbacks cannot reveal or navigate', async () => {
  for (const change of ['session', 'detach', 'dispose']) {
    const f = await fixture('leave'), waiting = deferred(); f.state.response = () => waiting.promise;
    const retainedSubmit = f.model.submit, retainedClose = f.model.close, command = f.model.submit();
    if (change === 'session') f.state.generation++;
    else if (change === 'detach') f.model.detach();
    else f.controller.dispose();
    waiting.resolve({ left: true }); await command;
    const view = f.model.getSnapshot(); assert.equal(view.ended, true); assert.equal(view.groupName, null);
    assert.equal(view.draft, ''); assert.equal(view.receipt, null);
    f.state.generation = 1; await retainedSubmit(); retainedClose();
    assert.equal(writes(f).length, 1); assert.equal(f.state.closed, 0);
  }
});

test('observer invalidation before transport prevents dispatch; detach only removes presentation observers', async () => {
  const f = await fixture('leave'); let observed = 0;
  f.model.subscribe(() => { observed++; if (f.model.getSnapshot().pending) f.model.detach(); });
  await f.model.submit(); assert.equal(writes(f).length, 0); assert.ok(observed);
  assert.equal(f.controller.getSnapshot().disposed, false);
  f.model.attach(); assert.equal(f.model.getSnapshot().ended, true);
});

test('refresh rechecks the global command fence after observers synchronously start another change', async () => {
  const f = await fixture(), waiting = deferred(); f.state.response = () => waiting.promise;
  let started = false, command;
  f.model.subscribe(() => {
    if (!started && !f.model.getSnapshot().canRefresh) {
      started = true; command = f.controller.leave(OTHER, { confirmed: true }, randomUUID());
    }
  });
  await f.model.refresh();
  assert.equal(f.calls.filter(call => call.method === 'GET').length, 1);
  assert.equal(writes(f).length, 1); assert.equal(f.model.getSnapshot().canClose, false);
  waiting.resolve({ left: true }); await command;
  assert.equal(f.model.getSnapshot().receipt, null);
});

test('receipt projection rejects mismatched kind group member and false/empty values', async () => {
  const f = await fixture(); f.model.setDraft('Confirmed'); await f.model.submit(); const c = f.controller.getSnapshot().command;
  assert.equal(confirmedReceipt(c, OTHER, 'alias'), null); assert.equal(confirmedReceipt(c, G, 'leave'), null);
  assert.equal(confirmedReceipt({ ...c, memberId: OTHER }, G, 'alias'), null);
  for (const value of [null, {}, { kind: 'leave', value: { left: false } }])
    assert.equal(confirmedReceipt({ ...c, kind: 'leave', memberId: null, intent: null, membershipResult: value }, G, 'leave'), null);
});
