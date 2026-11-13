const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), ts = require('typescript');
const root = path.resolve(__dirname, '../../..');
const modules = new Map();
function load(relative) {
  const file = path.resolve(root, relative);
  assert.ok(file.startsWith(root + path.sep));
  if (modules.has(file)) return modules.get(file).exports;
  const module = { exports: {} }; modules.set(file, module);
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { fileName: file, compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
  new Function('require', 'module', 'exports', code)(name => {
    if (name === 'react/jsx-runtime') return { jsx: (type, props) => ({ type, props }) };
    if (name === './ContextReviewScreen') return { ContextReviewScreen: () => { throw Error('Use the renderer suite for React'); } };
    if (name === './client') return { ApiError: load('api/transport.ts').ApiError, formApi: null };
    assert.ok(name.startsWith('.'), 'Unexpected runtime dependency: ' + name);
    const base = path.resolve(path.dirname(file), name);
    const target = ['.ts', '.tsx'].map(ext => base + ext).find(candidate => fs.existsSync(candidate));
    assert.ok(target, 'Missing source: ' + name);
    return load(path.relative(root, target));
  }, module, module.exports);
  return module.exports;
}
const { ApiError } = load('api/transport.ts');
const { FormResources } = load('api/resources.ts');
const { createContextConfirmation } = load('integration/contextConfirmation.ts');
const { createSavedFirstPlanDestination } = load('integration/savedFirstPlanDestination.ts');
const { createContextReviewRenderer } = load('features/training/context-review/presentation.tsx');
const { contextReviewRows } = load('features/training/context-review/rows.ts');
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const settled = () => new Promise(resolve => setImmediate(resolve));
const clone = value => JSON.parse(JSON.stringify(value));
function account() {
  return { accountId: 'synthetic',
    profile: { revision: 4, name: 'Captured name', age: null, heightCm: 171, weightKg: null, trainingBackground: 'returning',
      injuryHistory: 'Recorded limitation\nKeep this complete', goals: ['stronger', 'unfamiliar goal', 'third', 'fourth'], trainingContext: 'Captured context' },
    preferences: { revision: 7, appMode: 'basic', mascot: 'none', animationStyle: 'short', loadUnit: 'kg', heightUnit: 'cm',
      coachVoice: 'direct', communication: 'detailed', trainingDaysPerWeek: 3, sessionMinutes: 30, equipment: ['dumbbells', 'unfamiliar equipment'], remindersEnabled: false } };
}
function receipt() {
  return { plan: { id: 'saved-plan', name: 'Saved plan', minutes: 30, revision: 1, archived: false,
    createdAt: '2026-10-11T12:00:00.000Z', updatedAt: '2026-10-11T12:00:00.000Z',
    items: [{ id: 'item', exerciseId: 'exercise', setTarget: 3, repMin: 6, repMax: 10, targetKg: 0 }] },
    provenance: { schema: 'form.first-plan-provenance/v1', contextKey: 'context:v1', selectedCandidateId: 'candidate', profileRevision: 4, preferencesRevision: 7,
      sources: [{ id: 'source', revision: 'revision' }], candidates: [{ id: 'candidate', status: 'eligible', gapCodes: [] }] } };
}
function fixture({ editable = true, renderer = createContextReviewRenderer(), generation = 'one' } = {}) {
  const f = { current: true, value: account(), reads: 0, writes: [], keys: 0, edits: [], closes: 0, destinations: [], opened: [], planReads: 0,
    get: null, post: null, plans: null, destination: undefined, onOpened: null };
  const api = { captureAuthContext: () => ({ isCurrent: () => f.current }), async request(route, method, body, key) {
    if (route === '/v1/me') { f.reads++; return f.get ? f.get() : clone(f.value); }
    if (route === '/v1/plans/first') { f.writes.push({ body, key }); return f.post ? f.post() : receipt(); }
    assert.equal(route, '/v1/plans'); f.planReads++; return f.plans ? f.plans() : { items: [receipt().plan] };
  } };
  const resources = new FormResources(api);
  const scope = { accountId: 'synthetic', sessionGeneration: generation, originalAuth: { isCurrent: () => f.current },
    isCurrentSession: binding => f.current && binding.resources === resources && binding.sessionGeneration === generation };
  const controller = createContextConfirmation({ resources, scope, newIdempotencyKey: () => { f.keys++; return 'original-key'; },
    ...(editable ? { openEdit: target => f.edits.push(target) } : {}) });
  const ctx = { confirmation: controller, sessionGeneration: generation, isCurrentSession: () => f.current,
    savedFirstPlanDestination(saved) {
      f.destinations.push(saved);
      return f.destination !== undefined ? f.destination : createSavedFirstPlanDestination({ saved, resources, scope,
        adoptAndOpen: plan => { f.opened.push(plan); f.onOpened?.(); return f.current; } });
    }, close: () => { f.closes++; } };
  const presentation = renderer(ctx).props.presentation;
  return Object.assign(f, { controller, ctx, presentation, renderer,
    attach: (observer = () => {}) => presentation.attach(ctx, observer), view: () => presentation.view(ctx) });
}
test('one capture survives factory rerenders, observer detach/reattach and genuine remount while a read is in flight', async () => {
  const f = fixture(), read = deferred(); f.get = () => read.promise;
  let detachedNotifications = 0;
  const first = f.attach(() => detachedNotifications++);
  await settled(); assert.equal(f.reads, 1); assert.equal(f.view().snapshot.status, 'loading');
  first.detach(); const before = detachedNotifications;
  const rerendered = f.renderer({ ...f.ctx }).props.presentation;
  assert.equal(rerendered, f.presentation);
  const second = rerendered.attach({ ...f.ctx }, () => {});
  read.resolve(clone(f.value)); await settled();
  assert.equal(f.reads, 1); assert.equal(f.view().review.profile.name, 'Captured name');
  assert.equal(detachedNotifications, before);
  first.confirm(f.view().review); await settled(); assert.equal(f.writes.length, 0);
  second.detach(); f.attach(); await settled(); assert.equal(f.reads, 1);
});
test('synchronous duplicate confirmation publishes pending immediately and sends the frozen revisions once', async () => {
  const f = fixture(), write = deferred(); f.post = () => write.promise;
  const a = f.attach(); await settled(); const review = f.view().review;
  f.value.profile.revision = 90; f.value.preferences.revision = 91;
  a.confirm(review); assert.equal(f.view().snapshot.status, 'pending'); a.confirm(review); a.close(); a.edit(review, 'goals'); a.capture();
  await settled(); assert.deepEqual(f.writes, [{ key: 'original-key', body: { profileRevision: 4, preferencesRevision: 7 } }]);
  assert.equal(f.closes, 0); assert.deepEqual(f.edits, []); assert.equal(f.reads, 1);
  a.detach(); const remounted = f.attach(); write.resolve(receipt()); await settled();
  assert.equal(f.view().saved, true); assert.equal(f.destinations.length, 1);
  a.open(); await settled(); assert.equal(f.planReads, 0);
  remounted.open(); remounted.open(); await settled(); assert.equal(f.planReads, 1); assert.equal(f.opened.length, 1);
  remounted.close(); assert.equal(f.closes, 1); assert.equal(f.controller.snapshot().effect, 'confirmed');
});
test('unknown retry never captures or cancels and retains exact command identity across reattachment', async () => {
  const f = fixture(); f.post = () => { throw Error('Lost response'); };
  const a = f.attach(); await settled(); a.confirm(f.view().review); await settled();
  assert.equal(f.view().snapshot.status, 'unknown'); a.capture(); a.close(); a.detach();
  const b = f.attach(); b.capture(); b.close(); await settled();
  assert.equal(f.reads, 1); assert.equal(f.closes, 0);
  f.value.profile.revision = 88; f.value.preferences.revision = 99;
  const write = deferred(); f.post = () => write.promise;
  b.retry(); b.retry(); assert.equal(f.view().snapshot.status, 'pending'); await settled();
  assert.equal(f.keys, 1); assert.deepEqual(f.writes[1], f.writes[0]);
  write.resolve(receipt()); await settled(); assert.equal(f.view().saved, true);
});
test('close before capture dispatch invalidates the token and late reads cannot repopulate a dismissed review', async () => {
  const f = fixture(), a = f.attach(); a.close(); await settled();
  assert.equal(f.reads, 0); assert.equal(f.closes, 1); assert.equal(f.view().review, undefined);
  a.capture(); a.retry(); await settled(); assert.equal(f.reads, 0);
  const read = deferred(); f.get = () => read.promise;
  const b = f.attach(); await settled(); b.close(); read.resolve(f.value); await settled();
  assert.equal(f.view().snapshot.status, 'cancelled'); assert.equal(f.view().review, undefined);
  f.get = null; f.attach(); await settled(); assert.equal(f.view().snapshot.status, 'ready');
});
test('edit invalidates old review callbacks; only explicit recapture and a fresh confirm may create', async () => {
  const f = fixture(), a = f.attach(); await settled(); const old = f.view().review;
  a.edit(old, 'goals'); a.confirm(old); await settled();
  assert.deepEqual(f.edits, ['goals']); assert.equal(f.view().review, undefined); assert.equal(f.reads, 1); assert.equal(f.writes.length, 0);
  a.capture(); await settled(); a.confirm(old); a.edit(old, 'name'); await settled();
  assert.equal(f.writes.length, 0); assert.deepEqual(f.edits, ['goals']);
  a.confirm(f.view().review); await settled(); assert.equal(f.writes.length, 1);
});
test('a missing edit port leaves issued rows read-only and cannot invoke an editor', async () => {
  const f = fixture({ editable: false }), a = f.attach(); await settled();
  assert.equal(f.view().snapshot.canEdit, false); a.edit(f.view().review, 'name');
  assert.equal(f.view().snapshot.status, 'ready'); assert.deepEqual(f.edits, []);
});
test('late capture and write completions cannot expose private context or destinations after session replacement', async () => {
  const renderer = createContextReviewRenderer(), old = fixture({ renderer }), read = deferred(); old.get = () => read.promise;
  const a = old.attach(); await settled(); old.current = false;
  const fresh = fixture({ renderer, generation: 'two' }); fresh.attach(); await settled();
  read.resolve(old.value); await settled(); a.capture();
  assert.equal(old.view().current, false); assert.equal(old.view().review, undefined); assert.equal(old.destinations.length, 0);
  assert.equal(fresh.reads, 1); assert.equal(fresh.view().snapshot.status, 'ready');
  const write = deferred(), b = fresh.attach(); fresh.post = () => write.promise;
  b.confirm(fresh.view().review); await settled(); fresh.current = false; write.resolve(receipt()); await settled();
  assert.equal(fresh.view().snapshot.effect, 'unknown'); assert.equal(fresh.view().saved, false); assert.equal(fresh.destinations.length, 0);
  b.retry(); b.close(); b.open(); await settled(); assert.equal(fresh.writes.length, 1); assert.equal(fresh.closes, 0);
});
test('cache identity includes generation even when a caller incorrectly reuses a controller', async () => {
  const f = fixture(); const a = f.attach(); await settled();
  const other = { ...f.ctx, sessionGeneration: 'other' }, presentation = f.renderer(other).props.presentation;
  assert.notEqual(presentation, f.presentation); assert.equal(presentation.view(other).review, undefined);
  a.detach(); assert.equal(f.view().snapshot.status, 'ready');
});
for (const reason of ['read_failed', 'invalid_readback', 'plan_missing', 'plan_changed', 'plan_archived']) {
  test('saved readback ' + reason + ' retries only reads through the exact retained destination', async () => {
    const f = fixture(), a = f.attach(); await settled(); a.confirm(f.view().review); await settled();
    assert.equal(f.view().saved, true); assert.ok(f.destinations[0].receipt);
    if (reason === 'read_failed') f.plans = () => { throw Error('Read failed'); };
    if (reason === 'invalid_readback') f.plans = () => ({ items: [{}] });
    if (reason === 'plan_missing') f.plans = () => ({ items: [] });
    if (reason === 'plan_changed') f.plans = () => ({ items: [{ ...receipt().plan, revision: 2 }] });
    if (reason === 'plan_archived') f.plans = () => ({ items: [{ ...receipt().plan, archived: true }] });
    a.open(); a.open(); await settled(); assert.deepEqual(f.view().openResult, { status: 'unavailable', reason });
    a.capture(); a.retry(); assert.equal(f.writes.length, 1); assert.equal(f.reads, 1);
    a.detach(); const b = f.attach(); f.plans = null; b.open(); await settled();
    assert.equal(f.destinations.length, 1); assert.equal(f.planReads, 2); assert.equal(f.opened.length, 1); assert.equal(f.writes.length, 1);
  });
}
test('a stale saved readback never navigates and a null destination never changes saving success', async () => {
  const f = fixture(), a = f.attach(); await settled(); a.confirm(f.view().review); await settled();
  const read = deferred(); f.plans = () => read.promise; a.open(); await settled(); f.current = false;
  read.resolve({ items: [receipt().plan] }); await settled(); assert.equal(f.opened.length, 0);
  const noDestination = fixture(); noDestination.destination = null;
  const b = noDestination.attach(); await settled(); b.confirm(noDestination.view().review); await settled();
  assert.equal(noDestination.view().saved, true); assert.equal(noDestination.view().canOpen, false);
  b.open(); b.capture(); b.retry(); await settled(); assert.equal(noDestination.writes.length, 1); assert.equal(noDestination.planReads, 0);
});
test('saved read custody survives a remount and permits only one in-flight exact-plan read', async () => {
  const f = fixture(), a = f.attach(); await settled(); a.confirm(f.view().review); await settled();
  const read = deferred(); f.plans = () => read.promise;
  a.open(); await settled(); assert.equal(f.view().opening, true); a.detach();
  const b = f.attach(); b.open(); await settled(); assert.equal(f.planReads, 1); assert.equal(f.destinations.length, 1);
  read.resolve({ items: [receipt().plan] }); await settled();
  assert.equal(f.view().openResult.status, 'opened'); assert.equal(f.view().opening, false); assert.equal(f.opened.length, 1);
});
test('a controller saved outside this factory cannot manufacture a receipt or a destination', async () => {
  const f = fixture(), issued = await f.controller.capture(); await issued.review.confirm();
  f.attach(); await settled(); assert.equal(f.view().snapshot.status, 'saved');
  assert.equal(f.view().saved, false); assert.equal(f.view().canOpen, false); assert.equal(f.destinations.length, 0); assert.equal(f.reads, 1);
});
test('a known stale write requires explicit recapture and never reuses the old review', async () => {
  const f = fixture(); f.post = () => { throw new ApiError(409, 'stale_revision', 'Stale revision'); };
  const a = f.attach(); await settled(); const old = f.view().review; a.confirm(old); await settled();
  assert.equal(f.view().snapshot.status, 'stale'); assert.equal(f.view().snapshot.effect, 'none'); assert.equal(f.view().review, undefined);
  a.confirm(old); a.retry(); await settled(); assert.equal(f.writes.length, 1); assert.equal(f.reads, 1);
  a.capture(); await settled(); a.confirm(old); await settled(); assert.equal(f.reads, 2); assert.equal(f.writes.length, 1);
});
test('unavailable creation remains honest and requires explicit review rather than an automatic loop', async () => {
  const f = fixture(); f.post = () => { throw new ApiError(501, 'first_plan_unavailable', 'Unavailable'); };
  const a = f.attach(); await settled(); a.confirm(f.view().review); await settled();
  assert.equal(f.view().snapshot.status, 'unavailable'); assert.equal(f.view().snapshot.effect, 'none');
  a.retry(); await settled(); assert.equal(f.writes.length, 1); assert.equal(f.reads, 1);
  a.capture(); await settled(); assert.equal(f.reads, 2); assert.equal(f.writes.length, 1);
});
test('row formatting preserves all unknown values, long limitations and absent versus empty context', () => {
  const value = account(), rows = () => contextReviewRows(value).flatMap(group => group.rows);
  assert.equal(rows().find(row => row.id === 'goals').text, 'Get stronger\nunfamiliar goal\nthird\nfourth');
  assert.equal(rows().find(row => row.id === 'equipment').text, 'Dumbbells\nunfamiliar equipment');
  assert.equal(rows().find(row => row.id === 'limitations').text, value.profile.injuryHistory);
  assert.equal(rows().find(row => row.id === 'age').text, 'Not shared');
  assert.equal(rows().find(row => row.id === 'context').edit, undefined);
  delete value.profile.trainingContext; assert.equal(rows().find(row => row.id === 'context').text, 'Not recorded');
  value.profile.trainingContext = ''; value.profile.goals = [];
  assert.equal(rows().find(row => row.id === 'context').text, 'Empty response');
  assert.equal(rows().find(row => row.id === 'goals').text, 'None recorded');
});

test('in-flight saved readback guards retained Close until completion, then confirmed Back remains allowed', async () => {
  const f = fixture(), a = f.attach(); await settled(); a.confirm(f.view().review); await settled();
  const read = deferred(); f.plans = () => read.promise;
  a.open(); a.open(); a.close(); await settled();
  assert.equal(f.closes, 0); assert.equal(f.planReads, 1); assert.equal(f.opened.length, 0);
  read.resolve({ items: [receipt().plan] }); await settled();
  assert.equal(f.opened.length, 1); assert.equal(f.closes, 0);
  a.close(); a.open(); await settled();
  assert.equal(f.closes, 1); assert.equal(f.opened.length, 1);
  assert.equal(f.controller.snapshot().effect, 'confirmed');
});
test('returning presentation can reopen the same receipt, while successful old callbacks stay spent', async () => {
  const f = fixture(), a = f.attach(); await settled(); a.confirm(f.view().review); await settled();
  a.open(); await settled(); a.open(); await settled();
  assert.equal(f.planReads, 1); assert.equal(f.view().canOpen, false);
  a.detach(); const b = f.attach();
  assert.equal(f.view().canOpen, true); a.open(); a.close();
  b.open(); b.open(); await settled();
  assert.equal(f.planReads, 2); assert.equal(f.opened.length, 2); assert.equal(f.closes, 0);
  assert.equal(f.destinations.length, 1); assert.equal(f.writes.length, 1); assert.equal(f.keys, 1); assert.equal(f.reads, 1);
});
test('late success belongs to its issuing attachment even if navigation synchronously reattaches before completion', async () => {
  const f = fixture(), a = f.attach(); await settled(); a.confirm(f.view().review); await settled();
  let returned;
  f.onOpened = () => { a.detach(); returned = f.attach(); f.onOpened = null; };
  a.open(); await settled();
  assert.equal(f.view().openResult.status, 'opened'); assert.equal(f.view().canOpen, true);
  a.open(); returned.open(); returned.open(); await settled();
  assert.equal(f.planReads, 2); assert.equal(f.opened.length, 2); assert.equal(f.destinations.length, 1);
  assert.equal(f.writes.length, 1); assert.equal(f.keys, 1);
});
