const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const root = path.resolve(__dirname, '../..');
const modules = new Map();
// Compile production modules in memory; no disk queue, generated files, native speech or provider calls.
function load(name) {
  const file = path.resolve(root, name); assert.ok(file.startsWith(root + path.sep));
  if (modules.has(file)) return modules.get(file).exports;
  const module = { exports: {} }; modules.set(file, module);
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function('require', 'module', 'exports', code)(name => {
    assert.ok(name.startsWith('.'), `Unexpected runtime dependency: ${name}`);
    return load(path.relative(root, path.resolve(path.dirname(file), name + '.ts')));
  }, module, module.exports);
  return module.exports;
}
const { createActivityDataflow } = load('integration/activityDataflow.ts');
const { createActivitySession } = load('integration/activitySession.ts');
const { ApiError } = load('api/transport.ts');
const d = load('activity/drafts/index.ts');
const exercise = { ref: { source: 'global', id: 'floor-press' }, name: 'Floor press', description: '', movement: null,
  measurementType: 'unspecified', kind: 'resistance', loadApplicability: 'unspecified', loadLabel: null,
  guidance: 'globalReference', cueStatus: 'unknown', safetyAssessment: 'notEstablished' };
const context = (draftId = 'draft-one') => d.freezeCaptureContext({ accountGeneration: 'generation-one', draftId,
  capturedAt: '2026-10-09T16:00:00.000Z', timeZone: 'America/New_York', selectedDate: null });
function confirmed(result) {
  const updated = d.setDraftLoad(result, result.candidate.items[0].id, { state: 'unknown', confirmed: true });
  return { ...updated, candidate: { ...updated.candidate, performedConfirmed: true, date: { ...updated.candidate.date, confirmed: true } } };
}
const entry = payload => ({ ...payload, id: 'entry-one', revision: 1, status: 'recorded',
  items: payload.items.map(item => ({ ...item, snapshot: exercise })), createdAt: '2026-10-09T16:00:00.000Z', updatedAt: '2026-10-09T16:00:00.000Z' });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function fixture(request, speech) {
  let current = true, keys = 0;
  const flow = createActivityDataflow({ sessionGeneration: 'generation-one', isCurrentSession: () => current, api: { request } });
  const session = createActivitySession({ sessionGeneration: 'generation-one', isCurrentSession: () => current, api: flow.ownerInputApi },
    () => `secure-command-key-${++keys}`, speech);
  return { flow, session, expire() { current = false; }, keys: () => keys };
}
const changed = original => error => error.code === 'session_changed' && error.effectUnknown === false && error.originalEffectUnknown === original;

test('no-save denies every method before sentinel property access, clone, stringify, hash or forwarding', async () => {
  let inspected = 0, forwarded = 0;
  const body = new Proxy({}, { get() { inspected++; throw new Error('sentinel_read'); },
    ownKeys() { inspected++; throw new Error('sentinel_keys'); }, getOwnPropertyDescriptor() { inspected++; throw new Error('sentinel_clone'); } });
  const f = fixture(async () => { forwarded++; });
  for (const method of [undefined, 'GET', 'POST', 'PATCH', 'DELETE'])
    await assert.rejects(f.flow.noSaveApi.request('/v1/activity/entries', method, body, 'no-save-key'), error => error.code === 'activity_no_save_channel');
  assert.equal(inspected, 0); assert.equal(forwarded, 0);
  f.flow.dispose(); await f.session.dispose();
});
test('body channel/source/review flags and ordinary derivative numbers cannot promote the negative closure', async () => {
  const calls = []; const f = fixture(async (...args) => { calls.push(args); return null; });
  for (const body of [{ channel: 'owner-activity-input-v1', active: true, source: 'manual', reviewed: true },
    { name: 'neutral', minutes: 42, source: 'nativeSpeech', performedConfirmed: true }, { targetKg: 0 }])
    await assert.rejects(f.flow.noSaveApi.request('/v1/activity/plans', 'POST', body, 'derived-key'), error => error.code === 'activity_no_save_channel');
  assert.equal(await f.flow.ownerInputApi.request('/v1/activity/calendar'), null);
  assert.equal(calls.length, 1); f.flow.dispose(); await f.session.dispose();
});
test('owner API allows the exact production Activity method/path combinations without copying the payload or key', async () => {
  const calls = []; const f = fixture(async (...args) => { calls.push(args); return 'ok'; });
  const routes = [
    ...['capabilities', 'calendar', 'catalog', 'exercises', 'plans', 'schedule', 'entries', 'adherence'].map(path => ['GET', path]),
    ...['exercises/item-one', 'plans/plan-one', 'entries/entry-one'].map(path => ['GET', path]),
    ...['calendar', 'exercises', 'plans', 'plans/import-legacy', 'schedule', 'entries', 'exercises/item-one/retire', 'plans/plan-one/archive',
      'entries/entry-one/void', 'schedule/days/2026-10-09/correct'].map(path => ['POST', path]),
    ...['exercises/item-one', 'plans/plan-one', 'entries/entry-one'].map(path => ['PATCH', path]),
    ['GET', 'entries?from=2026-10-01&to=2026-10-09&limit=10'],
  ];
  const body = { synthetic: 42 };
  for (const [method, route] of routes) assert.equal(await f.flow.ownerInputApi.request(`/v1/activity/${route}`, method, body, 'same-key'), 'ok');
  assert.equal(calls.length, routes.length); assert.ok(calls.every(call => call[2] === body && call[3] === 'same-key'));
  f.flow.dispose(); await f.session.dispose();
});
test('unrelated routes, wrong verbs, encoded path escapes and mutation query variants never dispatch', async () => {
  let calls = 0; const f = fixture(async () => { calls++; });
  for (const [path, method] of [
    ['/v1/profile', 'PATCH'], ['/v1/plans', 'POST'], ['/v1/telemetry', 'POST'], ['/v1/activity/transcript', 'POST'],
    ['/v1/activity/entries', 'DELETE'], ['/v1/activity/catalog', 'POST'], ['/v1/activity/entries', 'PUT'],
    ['/v1/activity/entries/x/void', 'GET'], ['/v1/activity/entries/%2Fprofile', 'PATCH'],
    ['/v1/activity/entries/../profile', 'PATCH'], ['/v1/activity/entries?source=manual', 'POST'],
    ['/v1/activity/calendar#fragment', 'GET'], ['https://other.invalid/v1/activity/calendar', 'GET'],
  ]) await assert.rejects(f.flow.ownerInputApi.request(path, method, {}), error => error.code === 'activity_route_not_allowed');
  assert.equal(calls, 0); f.flow.dispose(); await f.session.dispose();
});
test('stale generation and disposal deny before dispatch, including retained API aliases', async () => {
  let calls = 0; const f = fixture(async () => { calls++; }); const alias = f.flow.ownerInputApi;
  f.expire(); await assert.rejects(alias.request('/v1/activity/entries', 'POST', {}, 'old-key'), changed(false));
  f.flow.dispose(); f.flow.dispose(); await assert.rejects(alias.request('/v1/activity/calendar'), changed(false));
  assert.equal(calls, 0); await f.session.dispose();
});
for (const outcome of ['resolve', 'reject']) {
  test(`late mutation ${outcome} preserves original uncertainty and never dispatches under a new generation`, async () => {
    const pending = deferred(); let calls = 0;
    const f = fixture(() => { calls++; return pending.promise; });
    const result = f.flow.ownerInputApi.request('/v1/activity/entries', 'POST', {}, 'original-key');
    f.expire(); pending[outcome](outcome === 'resolve' ? {} : new ApiError(503, 'unknown', 'Unknown', true));
    await assert.rejects(result, changed(true));
    await assert.rejects(f.flow.ownerInputApi.request('/v1/activity/entries', 'POST', {}, 'retry-key'), changed(false));
    assert.equal(calls, 1); f.flow.dispose(); await f.session.dispose();
  });
}
test('late read hides the old private result; transported original uncertainty survives a late read error', async () => {
  for (const original of [false, true]) {
    const pending = deferred(); const f = fixture(() => pending.promise);
    const result = f.flow.ownerInputApi.request('/v1/activity/calendar'); f.flow.dispose();
    if (original) pending.reject(new ApiError(409, 'session_changed', 'Changed', false, true)); else pending.resolve({ private: 'synthetic' });
    await assert.rejects(result, changed(original)); await f.session.dispose();
  }
});
test('production manual draft and edits never write until explicit Save', async () => {
  const calls = []; const f = fixture(async (...args) => { calls.push(args); return entry(args[2]); });
  f.session.controller.beginManual(context(), exercise);
  f.session.controller.edit(confirmed(f.session.controller.getState().result));
  assert.equal(calls.length, 0); assert.equal(f.keys(), 0);
  assert.equal((await f.session.controller.save()).phase, 'saved');
  assert.equal(calls.length, 1); assert.equal(calls[0][0], '/v1/activity/entries'); assert.equal(calls[0][1], 'POST');
  assert.equal(calls[0][2].source, 'manual'); f.flow.dispose(); await f.session.dispose();
});
function speechFixture() {
  let listener = null, current = null, reviews = 0;
  const emit = (state, text = '', isFinal = false) => {
    current = { sessionId: 'speech-one', locale: 'en-US', state, text, isFinal, error: null }; listener?.(current);
  };
  return { emit, reviews: () => reviews, port: {
    subscribe(fn) { listener = fn; return { remove() { listener = null; } }; },
    async start() { emit('starting'); return 'speech-one'; },
    async stop() {}, async cancel() { current = null; }, async dispose() { current = null; listener = null; },
    acceptReview(review) {
      assert.equal(current.state, 'review'); assert.equal(review.sessionId, current.sessionId); reviews++;
      return { source: 'apple_on_device', reviewed: true, sessionId: review.sessionId, locale: current.locale, text: review.text };
    },
  } };
}
test('production speech partial/final/acceptReview/structured review performs no writes until explicit Save', async () => {
  const speech = speechFixture(), calls = [];
  const f = fixture(async (...args) => { calls.push(args); return entry(args[2]); }, speech.port);
  await f.session.controller.beginSpeech(context(), 'en-US');
  speech.emit('recording', 'Floor', false); speech.emit('review', 'I did floor press with unknown weight', true);
  assert.equal(f.session.controller.getState().phase, 'transcriptReview'); assert.equal(calls.length, 0);
  f.session.controller.acceptTranscript('I did floor press with unknown weight', [exercise]);
  assert.equal(speech.reviews(), 1); assert.equal(f.session.controller.getState().phase, 'structuredReview');
  f.session.controller.edit(confirmed(f.session.controller.getState().result));
  assert.equal(calls.length, 0); assert.equal(f.keys(), 0);
  assert.equal((await f.session.controller.save()).phase, 'saved'); assert.equal(calls[0][2].source, 'nativeSpeech');
  assert.ok(!('text' in calls[0][2])); f.flow.dispose(); await f.session.dispose();
});
test('unknown edit retries exact target/revision/key/payload/draftId; changed draft cannot replace it', async () => {
  const calls = []; let attempts = 0;
  const f = fixture(async (...args) => {
    calls.push(args); if (++attempts === 1) throw new ApiError(0, 'network_unknown', 'Unconfirmed', true);
    return entry(args[2]);
  });
  f.session.controller.beginManual(context(), exercise);
  f.session.controller.edit(confirmed(f.session.controller.getState().result));
  assert.equal((await f.session.controller.save({ id: 'original-entry', expectedRevision: 4 })).phase, 'unknown');
  const pending = f.session.controller.getState().pending;
  assert.equal(pending.payload.draftId, 'draft-one'); assert.equal(pending.target.id, 'original-entry'); assert.equal(pending.target.expectedRevision, 4);
  const leaked = f.session.controller.getState(); leaked.pending.payload.items[0].load = { state: 'notApplicable', reason: 'bodyweight' };
  assert.throws(() => f.session.controller.edit(confirmed(d.manualActivityDraft(context(), exercise))), /draft_edit_unavailable/);
  assert.equal((await f.session.controller.retryUnknown()).phase, 'saved');
  assert.deepEqual(calls[0], calls[1]); assert.equal(calls[0][0], '/v1/activity/entries/original-entry'); assert.equal(calls[0][1], 'PATCH');
  assert.equal(calls[0][2].expectedRevision, 4); assert.equal(calls[0][2].draftId, 'draft-one'); assert.equal(f.keys(), 1);
  f.flow.dispose(); await f.session.dispose();
});
test('unknown retry after generation replacement clears volatile tuple and cannot issue a second request', async () => {
  let calls = 0; const f = fixture(async () => { calls++; throw new ApiError(0, 'unknown', 'Unconfirmed', true); });
  f.session.controller.beginManual(context(), exercise); f.session.controller.edit(confirmed(f.session.controller.getState().result));
  assert.equal((await f.session.controller.save()).phase, 'unknown'); f.expire();
  assert.equal((await f.session.controller.retryUnknown()).phase, 'rejected');
  assert.equal(f.session.controller.getState().pending, null); assert.equal(calls, 1);
  await assert.rejects(f.session.controller.retryUnknown(), /unknown_retry_unavailable/); f.flow.dispose(); await f.session.dispose();
});
test('key loss through background/cancel/disposal cannot recreate an unknown tuple or silently save', async () => {
  let calls = 0; const f = fixture(async () => { calls++; throw new ApiError(0, 'unknown', 'Unconfirmed', true); });
  f.session.controller.beginManual(context(), exercise); f.session.controller.edit(confirmed(f.session.controller.getState().result));
  await f.session.controller.save(); assert.equal(f.keys(), 1);
  await f.session.background(); assert.equal(f.session.controller.getState().pending, null);
  await assert.rejects(f.session.controller.retryUnknown(), /unknown_retry_unavailable/);
  f.flow.dispose(); await f.session.dispose(); await assert.rejects(f.session.controller.save(), /explicit_structured_save_required/);
  assert.equal(calls, 1); assert.equal(f.keys(), 1);
  // Reconciliation of the original account after termination is a root UI/server gate, not an invented body-hash retry key.
});

test('late mutation through existing controller records original uncertainty and does not retain a retry tuple', async () => {
  const pending = deferred(); let calls = 0; const f = fixture(() => { calls++; return pending.promise; });
  f.session.controller.beginManual(context(), exercise); f.session.controller.edit(confirmed(f.session.controller.getState().result));
  const saving = f.session.controller.save(); f.expire(); pending.resolve(entry({ ...d.draftToActivityWrite(confirmed(d.manualActivityDraft(context(), exercise))) }));
  const outcome = await saving;
  assert.equal(outcome.phase, 'rejected'); assert.equal(outcome.error.originalEffectUnknown, true); assert.equal(outcome.pending, null);
  assert.equal(calls, 1); await assert.rejects(f.session.controller.retryUnknown(), /unknown_retry_unavailable/);
  f.flow.dispose(); await f.session.dispose();
});
test('stale server revision requires a new reviewed edit and never silently retries or overwrites', async () => {
  let calls = 0; const f = fixture(async () => { calls++; throw new ApiError(409, 'stale_revision', 'Refresh'); });
  f.session.controller.beginManual(context(), exercise); f.session.controller.edit(confirmed(f.session.controller.getState().result));
  assert.equal((await f.session.controller.save({ id: 'original-entry', expectedRevision: 4 })).phase, 'stale');
  await assert.rejects(f.session.controller.retryUnknown(), /unknown_retry_unavailable/);
  assert.equal(f.session.controller.getState().pending, null); assert.equal(calls, 1);
  f.flow.dispose(); await f.session.dispose();
});
