const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const root = path.resolve(__dirname, '../../..');
const cache = new Map();
// Compile the actual production modules in memory; no scratch, server, native runtime or persistent command store.
function load(name) {
  const file = path.resolve(root, name);
  assert.ok(file.startsWith(root + path.sep));
  if (cache.has(file)) return cache.get(file).exports;
  const module = { exports: {} }; cache.set(file, module);
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function('require', 'module', 'exports', code)(name => {
    assert.ok(name.startsWith('.'), `Unexpected runtime dependency ${name}`);
    return load(path.relative(root, path.resolve(path.dirname(file), name + '.ts')));
  }, module, module.exports);
  return module.exports;
}
const { createActivitySession } = load('integration/activitySession.ts');
const { ActivityResources } = load('activity/resources.ts');
const { activityPresentation, pendingChannels } = load('activity/presentation/presentation.ts');
const editing = load('activity/presentation/draftEditing.ts');
const model = load('activity/drafts/model.ts');
const { draftToActivityWrite } = load('activity/drafts/validation.ts');
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function deferredSpeech(text = 'press unknown load') {
  const starting = deferred(), observers = new Set(), retained = [];
  const calls = { starts: [], stops: 0, cancels: 0, accepts: [] };
  const draft = (state, value = text) => ({ sessionId: 'speech-one', locale: 'en-US', state,
    text: value, isFinal: state === 'review', error: null });
  const emit = value => { for (const observer of [...observers]) observer(value); };
  const port = {
    availability: async locale => ({ available: true, reason: 'available', locale, onDeviceSupported: true,
      permissions: { speech: 'granted', microphone: 'granted' } }),
    requestPermissions: async () => ({ speech: 'granted', microphone: 'granted' }),
    subscribe: observer => { observers.add(observer); retained.push(observer); return { remove: () => observers.delete(observer) }; },
    start: locale => { calls.starts.push(locale); emit(draft('starting', '')); return starting.promise; },
    stop: async () => { calls.stops += 1; emit(draft('review')); },
    acceptReview: review => { calls.accepts.push(review); return { ...review, source: 'apple_on_device', locale: 'en-US' }; },
    cancel: async () => { calls.cancels += 1; },
    dispose: async () => { observers.clear(); },
  };
  return { port, starting, calls, final: () => emit(draft('review')),
    lateFinal: () => { for (const observer of retained) observer(draft('review', 'old private speech')); } };
}
const exercise = { ref: { source: 'global', id: 'press' }, name: 'Press', description: '', movement: null,
  measurementType: 'repetitions', kind: 'resistance', loadApplicability: 'applicable', loadLabel: 'Weight',
  guidance: 'globalReference', cueStatus: 'globalReference', safetyAssessment: 'notEstablished' };
const calendar = { timeZone: 'America/New_York', activationDate: '2026-11-01', revision: 1,
  calendarPolicy: 'activity-calendar-intl-v1', createdAt: '2026-11-01T05:30:00Z' };
function entry(payload, changes = {}) {
  return { ...editing.clone(payload), id: 'entry-one', revision: 1, status: 'recorded',
    items: payload.items.map(item => ({ ...editing.clone(item), snapshot: editing.clone(exercise) })),
    createdAt: '2026-11-13T10:00:00Z', updatedAt: '2026-11-13T10:00:00Z', ...changes };
}
function existing(changes = {}) {
  const context = model.freezeCaptureContext({ accountGeneration: 'session-one', draftId: 'original-draft',
    capturedAt: '2026-11-12T01:30:00Z', timeZone: calendar.timeZone, selectedDate: '2026-11-10' });
  let draft = model.manualActivityDraft(context, exercise);
  draft = model.setDraftLoad(draft, draft.candidate.items[0].id, { state: 'knownValue', value: 0, unit: 'lb', basis: 'assistance' });
  return entry(draftToActivityWrite(model.confirmStructuredReview(draft)), changes);
}
function fixture(options = {}) {
  let current = true, serial = 0;
  const calls = [], stored = new Map();
  const request = async (url, method = 'GET', body, key) => {
    const pathname = url.split('?')[0];
    const call = { url, pathname, method, body: editing.clone(body), key }; calls.push(call);
    if (options.intercept) { const result = options.intercept(call); if (result !== undefined) return await result; }
    if (method === 'GET') {
      if (pathname.endsWith('/calendar')) return calendar;
      if (pathname.endsWith('/catalog')) return { items: [exercise], selectionUses: ['manual', 'nativeSpeech'] };
      if (pathname.endsWith('/entries')) return { items: [...stored.values()].filter(value => value.date.localDate === new URL(url, 'https://synthetic.invalid').searchParams.get('from')), nextCursor: null };
      if (pathname.endsWith('/adherence')) return { policyVersion: 'activity-adherence-v1', asOf: '2026-11-13T10:00:00Z', timeZone: calendar.timeZone,
        coverageStart: null, throughDate: '2026-11-12', currentPlanDays: 0, longestPlanDays: 0, satisfiedDaysInCurrentStreak: 0,
        protectedDaysInCurrentStreak: 0, monthlyAllowance: { month: '2026-11', protectedDate: null, remaining: 1 }, days: [],
        sourceGeneration: { activity: calls.length, projectionRevision: 1, legacyAvailable: false, legacy: [] } };
      const id = pathname.split('/').at(-1);
      if (stored.has(id)) return editing.clone(stored.get(id));
      throw { status: 404, code: 'not_found' };
    }
    if (pathname.endsWith('/entries') && method === 'POST') {
      const value = entry(body); stored.set(value.id, value); return editing.clone(value);
    }
    if (pathname.endsWith('/void')) {
      const id = pathname.split('/').at(-2), prior = stored.get(id);
      const value = { ...prior, status: 'voided', revision: body.expectedRevision + 1 };
      stored.set(id, value); return editing.clone(value);
    }
    if (method === 'PATCH') {
      const id = pathname.split('/').at(-1), { expectedRevision, ...payload } = body;
      const value = entry(payload, { id, revision: expectedRevision + 1 }); stored.set(id, value); return editing.clone(value);
    }
    throw new Error(`Unexpected request ${method} ${url}`);
  };
  const context = { account: { accountId: 'synthetic-account' }, appMode: 'basic', sessionGeneration: options.sessionGeneration ?? 'session-one',
    isCurrentSession: () => current, close: () => { calls.push({ method: 'CLOSE' }); } };
  context.activity = createActivitySession({ sessionGeneration: context.sessionGeneration, isCurrentSession: context.isCurrentSession,
    api: { request } }, () => `secure-key-${String(++serial).padStart(16, '0')}`, options.speech);
  const presentation = activityPresentation(context);
  let view = presentation.attach(context);
  const actions = () => presentation.actions(view);
  return { context, presentation, actions, calls, stored, expire: () => { current = false; },
    detach: () => presentation.detach(view), attach: () => { view = presentation.attach(context); return view; },
    state: () => presentation.getSnapshot(), keyCount: () => serial,
    writes: () => calls.filter(call => ['POST', 'PATCH'].includes(call.method)) };
}
async function manual(f) {
  await f.actions().initialize();
  await f.actions().loadDay('2026-11-10');
  await f.actions().beginManual();
  const id = f.state().consumer.draft.result.candidate.items[0].id;
  await f.actions().chooseExercise(id, exercise.ref);
  await f.actions().edit(result => editing.changeLoad(result, id, { state: 'unknown', confirmed: true }));
}
async function detail(f, value = existing()) {
  f.stored.set(value.id, value);
  await f.actions().initialize(); await f.actions().loadDay('2026-11-10'); await f.actions().openEntry(value.id);
  return value;
}

test('manual backdate -> editable review -> explicit save -> actual receipt/detail -> fresh correction -> reviewed void', async () => {
  const f = fixture(); await manual(f);
  assert.equal(f.writes().length, 0);
  assert.equal(f.state().consumer.draft.result.candidate.date.localDate, '2026-11-10');
  await f.actions().review(); assert.equal(f.writes().length, 0);
  await f.actions().save();
  assert.equal(f.state().route, 'detail'); assert.equal(f.state().detail.value.id, 'entry-one');
  const first = f.writes()[0];
  assert.equal(first.body.performedConfirmed, true); assert.equal(first.body.date.confirmed, true);
  const readsBefore = f.calls.filter(call => call.pathname === '/v1/activity/entries/entry-one').length;
  await f.actions().correction();
  assert.equal(f.calls.filter(call => call.pathname === '/v1/activity/entries/entry-one').length, readsBefore + 1);
  const draft = f.state().consumer.draft.result;
  assert.equal(draft.context.capturedAt, first.body.date.capturedAt);
  await f.actions().edit(result => editing.changeLoad(result, result.candidate.items[0].id,
    { state: 'knownValue', value: 0, unit: 'lb', basis: 'assistance' }));
  await f.actions().review(); await f.actions().save();
  assert.equal(f.state().detail.value.revision, 2);
  assert.equal(f.writes()[1].body.expectedRevision, 1);
  await f.actions().beginVoid(); assert.equal(f.writes().length, 2);
  await f.actions().confirmVoid();
  assert.equal(f.state().detail.value.status, 'voided'); assert.equal(f.state().detail.value.revision, 3);
  assert.equal(f.writes()[2].pathname, '/v1/activity/entries/entry-one/void');
  assert.equal(f.calls.some(call => call.pathname?.includes('/retire')), false);
  assert.ok(f.calls.filter(call => call.pathname === '/v1/activity/adherence').length >= 4);
});
test('repeated Save, stale review handlers and edits after review cannot dispatch twice or confirm an old draft', async () => {
  const pending = deferred();
  const f = fixture({ intercept: call => call.method === 'POST' && call.pathname.endsWith('/entries') ? pending.promise : undefined });
  await manual(f); await f.actions().review(); const stale = f.actions();
  await f.actions().back();
  assert.equal(f.state().consumer.draft.result.candidate.performedConfirmed, false);
  assert.equal(f.state().consumer.draft.result.candidate.date.confirmed, false);
  await stale.save(); assert.equal(f.writes().length, 0);
  await f.actions().review(); const save = f.actions(); const saving = save.save();
  await save.save(); await f.actions().beginManual(); await f.actions().back();
  assert.equal(f.writes().length, 1); assert.equal(f.state().consumer.draft.phase, 'saving');
  pending.resolve(entry(f.writes()[0].body)); await saving;
  assert.equal(f.state().receipt.id, 'entry-one');
});
test('unknown entry retries original key, byte-equivalent body and exact edit target; no new intent', async () => {
  let attempt = 0;
  const f = fixture({ intercept: call => call.method === 'PATCH' && ++attempt === 1 ? Promise.reject({ status: 503, code: 'unavailable' }) : undefined });
  await detail(f); await f.actions().correction(); await f.actions().review(); await f.actions().save();
  assert.equal(f.state().consumer.draft.phase, 'unknown');
  const original = f.writes()[0]; await f.actions().back(); await f.actions().beginManual();
  assert.equal(f.state().route, 'review'); assert.equal(f.writes().length, 1);
  await f.actions().retry('entry');
  assert.deepEqual(f.writes()[1], original); assert.equal(f.state().receipt.revision, 2);
});
test('wrong-ID and regressed-revision fresh reads never enter correction or void review', async () => {
  for (const operation of ['correction', 'beginVoid']) for (const changes of [{ id: 'other-entry' }, { revision: 0 }]) {
    let mismatch = false;
    const f = fixture({ intercept: call => mismatch && call.method === 'GET' && call.pathname === '/v1/activity/entries/entry-one'
      ? Promise.resolve({ ...existing(), ...changes }) : undefined });
    await detail(f); mismatch = true; await f.actions()[operation]();
    assert.equal(f.state().route, 'detail'); assert.equal(f.state().consumer.draft.editTarget, null);
    assert.notEqual(f.state().consumer.voidIntent.phase, 'review'); assert.equal(f.writes().length, 0);
  }
});
test('detail/edit/void starts serialize and a detached old read cannot overwrite a new attachment', async () => {
  const pending = deferred(); let block = false;
  const f = fixture({ intercept: call => block && call.method === 'GET' && call.pathname === '/v1/activity/entries/entry-one' ? pending.promise : undefined });
  await detail(f); block = true;
  const actions = f.actions(), read = actions.correction();
  await actions.beginVoid(); assert.equal(f.state().consumer.voidIntent.phase, 'idle');
  f.detach(); f.attach(); pending.resolve(existing()); await read;
  assert.equal(f.state().route, 'detail'); assert.equal(f.state().consumer.draft.editTarget, null);
  assert.match(f.state().consumer.entry.error.code, /view_read_expired/);
});
test('stale correction requires explicit fresh read and a newly reviewed server revision', async () => {
  let stale = true;
  const f = fixture({ intercept: call => stale && call.method === 'PATCH' ? Promise.reject({ status: 409, code: 'stale_revision' }) : undefined });
  await detail(f); await f.actions().correction(); await f.actions().review(); await f.actions().save();
  assert.equal(f.state().consumer.draft.phase, 'stale'); const before = f.writes().length;
  await f.actions().save(); assert.equal(f.writes().length, before);
  f.stored.set('entry-one', { ...existing(), revision: 4 }); stale = false;
  await f.actions().freshReview(); assert.equal(f.state().consumer.draft.editTarget.expectedRevision, 4);
  await f.actions().save(); assert.equal(f.writes().length, before);
  await f.actions().review(); await f.actions().save(); assert.equal(f.state().receipt.revision, 5);
});
test('same binding retains one consumer and cached snapshot; detached handlers stay invalid after remount', async () => {
  const f = fixture(); await manual(f); const old = f.actions();
  const adapter = activityPresentation(f.context), state = adapter.getSnapshot();
  assert.equal(adapter, f.presentation); assert.equal(adapter.getSnapshot(), state);
  f.detach(); f.attach(); await old.back(); await old.review();
  assert.equal(f.state().route, 'editor'); assert.ok(f.state().consumer.draft.result);
  await f.actions().review(); assert.equal(f.state().route, 'review');
});
test('save A then open distinct B stays on B across reattachment without replaying A reads or old callbacks', async () => {
  const f = fixture(); await manual(f); await f.actions().review(); await f.actions().save();
  const b = existing({ id: 'entry-two', draftId: 'draft-two', revision: 7 }); f.stored.set(b.id, b);
  await f.actions().back(); await f.actions().loadDay('2026-11-10'); await f.actions().openEntry(b.id);
  const old = f.actions(), reads = f.calls.length;
  f.detach(); f.attach(); await f.actions().initialize(); await f.actions().showReceipt();
  assert.equal(f.state().route, 'detail'); assert.deepEqual(f.state().detail.value, b); assert.equal(f.state().receipt, null);
  assert.equal(f.state().consumer.draft.saved.id, 'entry-one'); assert.equal(f.calls.length, reads);
  await old.correction(); await old.back(); assert.equal(f.calls.length, reads);
  await f.actions().correction();
  assert.deepEqual(f.state().consumer.draft.editTarget, { id: b.id, expectedRevision: 7 });
});
test('reattachment during a saved entry void review preserves its fresh target and current confirmation', async () => {
  const f = fixture(); await manual(f); await f.actions().review(); await f.actions().save();
  await f.actions().beginVoid(); const target = editing.clone(f.state().consumer.voidIntent.entry), old = f.actions();
  const reads = f.calls.length;
  f.detach(); f.attach(); await f.actions().initialize(); await f.actions().showReceipt();
  assert.equal(f.state().route, 'void'); assert.equal(f.state().consumer.voidIntent.phase, 'review');
  assert.deepEqual(f.state().consumer.voidIntent.entry, target); assert.equal(f.calls.length, reads);
  assert.equal(f.state().receipt, null); assert.equal(f.state().consumer.draft.saved.id, target.id);
  await old.confirmVoid(); assert.equal(f.writes().length, 1);
  await f.actions().confirmVoid(); assert.equal(f.writes().length, 2);
  assert.equal(f.writes()[1].pathname, `/v1/activity/entries/${target.id}/void`);
  assert.deepEqual(f.writes()[1].body, { expectedRevision: target.revision });
  assert.equal(f.state().route, 'detail'); assert.equal(f.state().receipt.status, 'voided');
});
test('an old void receipt cannot replace a later distinct correction editor on reattachment', async () => {
  const f = fixture(); await detail(f); await f.actions().beginVoid(); await f.actions().confirmVoid();
  const b = existing({ id: 'entry-two', draftId: 'draft-two', revision: 7 }); f.stored.set(b.id, b);
  await f.actions().back(); await f.actions().loadDay('2026-11-10'); await f.actions().openEntry(b.id); await f.actions().correction();
  const draft = editing.clone(f.state().consumer.draft), old = f.actions();
  f.detach(); f.attach(); await f.actions().initialize(); await f.actions().showReceipt();
  assert.equal(f.state().route, 'editor'); assert.deepEqual(f.state().consumer.draft, draft);
  assert.equal(f.state().consumer.voidIntent.phase, 'voided'); assert.equal(f.state().receipt, null);
  await old.review(); assert.equal(f.state().route, 'editor');
  await f.actions().review(); await f.actions().save();
  assert.equal(f.writes().length, 2); assert.equal(f.writes()[1].pathname, '/v1/activity/entries/entry-two');
  assert.equal(f.state().receipt.id, b.id); assert.equal(f.state().receipt.revision, 8);
});
test('a save or original unknown retry completed while detached restores only that operation receipt', async () => {
  for (const retry of [false, true]) {
    const pending = deferred(); let attempts = 0;
    const f = fixture({ intercept: call => call.method === 'POST' && call.pathname.endsWith('/entries')
      ? retry && ++attempts === 1 ? Promise.reject({ status: 503 }) : pending.promise : undefined });
    await manual(f); await f.actions().review(); const old = f.actions();
    let saving;
    if (retry) { await old.save(); assert.equal(f.state().consumer.draft.phase, 'unknown'); saving = f.actions().retry('entry'); }
    else saving = old.save();
    const original = editing.clone(f.writes()[0]); f.detach();
    const receipt = entry(original.body); f.stored.set(receipt.id, receipt); pending.resolve(receipt); await saving;
    assert.notEqual(f.state().route, 'detail'); assert.deepEqual(f.state().receipt, receipt);
    assert.equal(f.state().consumer.draft.phase, 'saved');
    f.attach(); assert.equal(f.state().route, 'detail'); await f.actions().initialize();
    assert.deepEqual(f.state().detail.value, receipt);
    const reads = f.calls.length; await f.actions().showReceipt(); await old.back(); await old.save();
    assert.equal(f.calls.length, reads); assert.equal(f.writes().length, retry ? 2 : 1);
    if (retry) assert.deepEqual(f.writes()[1], original);
    assert.equal(f.calls.some(call => call.method === 'CLOSE'), false);
  }
});
test('root Back invokes the current close callback once; retained detached and expired callbacks stay inert', async () => {
  const f = fixture(); await f.actions().initialize(); const old = f.actions();
  f.detach(); f.attach(); await old.back(); assert.equal(f.calls.some(call => call.method === 'CLOSE'), false);
  await f.actions().back(); assert.equal(f.calls.filter(call => call.method === 'CLOSE').length, 1);
  const expired = f.actions(); f.expire(); await expired.back(); await old.back();
  assert.equal(f.calls.filter(call => call.method === 'CLOSE').length, 1);
});
test('unknown command survives observed detach; completion under the original attachment cannot navigate a remount', async () => {
  const pending = deferred();
  const f = fixture({ intercept: call => call.method === 'POST' && call.pathname.endsWith('/entries') ? pending.promise : undefined });
  await manual(f); await f.actions().review(); const saving = f.actions().save();
  const original = f.writes()[0]; f.detach(); f.attach(); pending.reject({ status: 503, code: 'unavailable' }); await saving;
  assert.equal(f.state().consumer.draft.phase, 'unknown');
  assert.equal(f.state().consumer.draft.pending.key, original.key);
  assert.deepEqual(f.state().consumer.draft.pending.payload, original.body);
});
test('same-account replacement denies old private actions and results without retry under the new session', async () => {
  const pending = deferred();
  const f = fixture({ intercept: call => call.method === 'POST' && call.pathname.endsWith('/entries') ? pending.promise : undefined });
  await manual(f); await f.actions().review(); const old = f.actions(), saving = old.save();
  f.expire();
  const next = fixture(); assert.notEqual(next.context.activity, f.context.activity);
  pending.resolve(entry(f.writes()[0].body)); await saving;
  await old.retry('entry'); assert.equal(f.writes().length, 1);
  assert.equal(f.state().available, false); assert.equal(f.state().consumer, null); assert.equal(f.state().receipt, null);
  assert.equal(next.writes().length, 0);
});
test('root background exposes the volatile-custody limit and never fabricates a retry or replacement', async () => {
  const f = fixture({ intercept: call => call.method === 'POST' && call.pathname.endsWith('/entries') ? Promise.reject({ status: 503 }) : undefined });
  await manual(f); await f.actions().review(); await f.actions().save();
  await f.context.activity.background();
  assert.equal(f.state().custodyUnavailable, true); assert.equal(f.state().consumer.draft.pending, null);
  await f.actions().retry('entry'); await f.actions().beginManual(); assert.equal(f.writes().length, 1);
  assert.match(f.state().notice, /lost its pending/);
});
test('malformed create/edit receipt stays unknown with immutable original custody; valid exact retry confirms once', async () => {
  for (const correction of [false, true]) for (const mutate of [value => ({ ...value, draftId: 'wrong-draft' }),
    value => ({ ...value, revision: 99 }),
    value => ({ ...value, items: value.items.map(item => ({ ...item, load: { state: 'knownValue', value: 123, unit: 'kg', basis: 'total' } })) }),
    ...(correction ? [value => ({ ...value, id: 'wrong-entry' })] : [])]) {
    let attempts = 0, malformed, originalReceipt;
    const target = existing({ id: 'entry-to-correct', revision: 4 });
    const f = fixture({ intercept: call => {
      if (!['POST', 'PATCH'].includes(call.method) || call.pathname.endsWith('/void')) return undefined;
      if (++attempts !== 1) return Promise.resolve(editing.clone(originalReceipt));
      const { expectedRevision, ...payload } = call.body;
      originalReceipt = entry(payload, correction ? { id: target.id, revision: expectedRevision + 1 } : {});
      f.stored.set(originalReceipt.id, editing.clone(originalReceipt));
      malformed = mutate(editing.clone(originalReceipt));
      return Promise.resolve(malformed);
    } });
    let confirmations = 0, previousPhase;
    const subscription = f.context.activity.controller.subscribe(state => {
      if (state.phase === 'saved' && previousPhase !== 'saved') confirmations += 1;
      previousPhase = state.phase;
    });
    if (correction) { await detail(f, target); await f.actions().correction(); } else await manual(f);
    await f.actions().review(); await f.actions().save();
    const original = editing.clone(f.writes()[0]);
    const { expectedRevision, ...payload } = original.body;
    const pending = { key: original.key, payload, target: correction ? { id: target.id, expectedRevision: 4 } : null };
    assert.equal(f.state().consumer.draft.phase, 'unknown');
    assert.equal(f.state().consumer.draft.error.code, 'activity_receipt_unconfirmed');
    assert.equal(f.state().consumer.draft.error.originalEffectUnknown, true);
    assert.deepEqual(f.state().consumer.draft.pending, pending);
    assert.equal(f.state().integrityUnavailable, false); assert.equal(f.state().route, 'review');
    assert.equal(f.state().consumer.draft.saved, null); assert.equal(f.state().receipt, null); assert.equal(confirmations, 0);
    malformed.date.localDate = '2026-01-01'; malformed.items[0].id = 'mutated-response-item';
    await f.actions().back(); await f.actions().beginManual(); await f.actions().loadDay('2026-11-11');
    await f.actions().openEntry(target.id); await f.actions().correction(); await f.actions().beginVoid(); await f.actions().save();
    assert.equal(f.state().route, 'review'); assert.equal(f.state().selectedDate, '2026-11-10');
    assert.deepEqual(f.state().consumer.draft.pending, pending);
    assert.equal(f.writes().length, 1); assert.equal(f.calls.some(call => call.method === 'CLOSE'), false);
    const issuedKeys = f.keyCount(); await f.actions().retry('entry'); assert.equal(f.keyCount(), issuedKeys);
    assert.deepEqual(f.writes()[1], original); assert.equal(f.writes().length, 2);
    assert.equal(f.state().consumer.draft.phase, 'saved'); assert.equal(f.state().consumer.draft.pending, null);
    assert.equal(f.state().route, 'detail'); assert.equal(f.state().receipt.id, correction ? target.id : 'entry-one');
    assert.equal(f.state().receipt.revision, correction ? 5 : 1); assert.equal(f.state().receipt.status, 'recorded');
    assert.deepEqual(f.state().receipt, originalReceipt);
    assert.equal(confirmations, 1);
    await f.actions().retry('entry'); await f.actions().save();
    assert.equal(confirmations, 1); assert.equal(f.writes().length, 2); subscription.remove();
  }
});
test('editing directly from review invalidates the old Save callback and preserves exact item identity', async () => {
  const f = fixture(); await manual(f); await f.actions().review();
  const old = f.actions(), id = f.state().consumer.draft.result.candidate.items[0].id;
  await f.actions().edit(result => editing.changeLoad(result, id, { state: 'knownValue', value: 0, unit: 'kg', basis: 'perSide' }));
  await old.save(); assert.equal(f.writes().length, 0); assert.equal(f.state().route, 'editor');
  assert.equal(f.state().consumer.draft.result.candidate.items[0].id, id);
  assert.equal(f.state().consumer.draft.result.candidate.performedConfirmed, false);
  await f.actions().review(); await f.actions().save(); assert.equal(f.state().receipt.items[0].load.value, 0);
});
test('a stale detail handler cannot target a revision loaded after that handler was captured', async () => {
  const f = fixture(); await detail(f); const old = f.actions();
  f.stored.set('entry-one', { ...existing(), revision: 3 });
  await f.actions().refreshDetail(); const reads = f.calls.length;
  await old.correction(); await old.beginVoid(); assert.equal(f.calls.length, reads);
  await f.actions().correction(); assert.equal(f.state().consumer.draft.editTarget.expectedRevision, 3);
});
test('a valid but older revision is rejected before fresh editable state is admitted', async () => {
  let regress = false;
  const f = fixture({ intercept: call => regress && call.method === 'GET' && call.pathname.endsWith('/entry-one')
    ? Promise.resolve({ ...existing(), revision: 3 }) : undefined });
  f.stored.set('entry-one', { ...existing(), revision: 4 });
  await f.actions().initialize(); await f.actions().loadDay('2026-11-10'); await f.actions().openEntry('entry-one');
  regress = true; await f.actions().correction();
  assert.equal(f.state().route, 'detail'); assert.equal(f.state().detail.value.revision, 4);
  assert.equal(f.state().consumer.draft.editTarget, null); assert.equal(f.writes().length, 0);
});
test('fresh saved-exercise replacement uses a new secure item identity and rejects old item callbacks', async () => {
  const other = { ...exercise, name: 'Row', ref: { source: 'global', id: 'row' } };
  const f = fixture({ intercept: call => call.pathname.endsWith('/catalog')
    ? Promise.resolve({ items: [exercise, other], selectionUses: ['manual'] }) : undefined });
  await detail(f); await f.actions().correction();
  const old = f.actions(), id = f.state().consumer.draft.result.candidate.items[0].id;
  await f.actions().chooseExercise(id, other.ref);
  const replacement = f.state().consumer.draft.result.candidate.items[0];
  assert.notEqual(replacement.id, id); assert.match(replacement.id, /^secure-key-/); assert.equal(replacement.load.state, 'missing');
  await old.edit(result => editing.changeLoad(result, id, { state: 'unknown', confirmed: true }));
  assert.equal(f.state().consumer.draft.result.candidate.items[0].load.state, 'missing');
});
test('reversed adherence completion cannot relabel a newer dated list or fabricate its coverage', async () => {
  const first = deferred(), second = deferred(), firstRows = deferred(), secondRows = deferred();
  const f = fixture({ intercept: call => call.pathname.endsWith('/adherence')
    ? (call.url.includes('from=2026-11-10') ? first.promise : second.promise) : undefined });
  await f.actions().initialize();
  const remove = f.presentation.subscribe(() => {
    if (f.state().listStatus === 'ready') {
      if (f.state().selectedDate === '2026-11-10') firstRows.resolve(); else secondRows.resolve();
    }
  });
  const oldRead = f.actions().loadDay('2026-11-10'); await firstRows.promise;
  const newRead = f.actions().loadDay('2026-11-11'); await secondRows.promise;
  const value = date => ({ policyVersion: 'activity-adherence-v1', asOf: '2026-11-13T10:00:00Z', timeZone: calendar.timeZone,
    coverageStart: null, throughDate: date, currentPlanDays: 0, longestPlanDays: 0, satisfiedDaysInCurrentStreak: 0,
    protectedDaysInCurrentStreak: 0, monthlyAllowance: { month: '2026-11', protectedDate: null, remaining: 1 }, days: [],
    sourceGeneration: { activity: 1, projectionRevision: 1, legacyAvailable: false, legacy: [] } });
  second.resolve(value('2026-11-11')); await newRead;
  first.resolve(value('2026-11-10')); await oldRead; remove();
  assert.equal(f.state().selectedDate, '2026-11-11'); assert.equal(f.state().consumer.adherence.value.throughDate, '2026-11-11');
  assert.equal(f.state().consumer.adherence.value.coverageStart, null);
});
test('void unknown retries only its original target/revision/key and never calls exercise retirement', async () => {
  let count = 0;
  const f = fixture({ intercept: call => call.pathname.endsWith('/void') && ++count === 1 ? Promise.reject({ status: 503 }) : undefined });
  await detail(f); await f.actions().beginVoid(); await f.actions().confirmVoid();
  assert.equal(f.state().consumer.voidIntent.phase, 'unknown'); const original = f.writes()[0];
  await f.actions().back(); await f.actions().correction(); assert.equal(f.writes().length, 1);
  await f.actions().retry('void'); assert.deepEqual(f.writes()[1], original);
  assert.equal(f.state().receipt.status, 'voided'); assert.equal(f.state().receipt.revision, 2);
  assert.equal(f.calls.some(call => call.pathname?.endsWith('/retire')), false);
});
test('detached void completion retains its validated receipt without navigating through the detached handler', async () => {
  const pending = deferred();
  const f = fixture({ intercept: call => call.pathname.endsWith('/void') ? pending.promise : undefined });
  const original = await detail(f); await f.actions().beginVoid(); const saving = f.actions().confirmVoid();
  f.detach(); f.attach(); pending.resolve({ ...original, status: 'voided', revision: 2 }); await saving;
  assert.equal(f.state().route, 'void'); assert.equal(f.state().receipt.status, 'voided');
  await f.actions().showReceipt(); assert.equal(f.state().route, 'detail'); assert.equal(f.state().receipt.revision, 2);
  assert.equal(f.writes().length, 1);
});
test('an original unknown void retry completed while detached restores its own target receipt on reattachment', async () => {
  const pending = deferred(); let attempts = 0;
  const f = fixture({ intercept: call => call.pathname.endsWith('/void')
    ? ++attempts === 1 ? Promise.reject({ status: 503 }) : pending.promise : undefined });
  const originalEntry = await detail(f); await f.actions().beginVoid(); await f.actions().confirmVoid();
  assert.equal(f.state().consumer.voidIntent.phase, 'unknown'); const original = editing.clone(f.writes()[0]);
  const old = f.actions(), retry = old.retry('void'); f.detach();
  const receipt = { ...originalEntry, status: 'voided', revision: 2 };
  f.stored.set(receipt.id, receipt); pending.resolve(receipt); await retry;
  assert.equal(f.state().route, 'void'); assert.deepEqual(f.state().receipt, receipt);
  f.attach(); await f.actions().initialize();
  assert.equal(f.state().route, 'detail'); assert.deepEqual(f.state().detail.value, receipt);
  const reads = f.calls.length; await f.actions().showReceipt(); await old.retry('void'); await old.back();
  assert.equal(f.calls.length, reads); assert.equal(f.writes().length, 2); assert.deepEqual(f.writes()[1], original);
});
test('a semantically different void receipt fails closed even after the consumer has cleared its command', async () => {
  const f = fixture({ intercept: call => call.pathname.endsWith('/void') ? Promise.resolve({ ...existing(), status: 'voided', revision: 2, kind: 'exerciseSnack' }) : undefined });
  await detail(f); await f.actions().beginVoid(); await f.actions().confirmVoid();
  assert.equal(f.state().integrityUnavailable, true); assert.equal(f.state().receipt, null);
  await f.actions().retry('void'); assert.equal(f.writes().length, 1);
});
test('calendar field edits invalidate previously rendered confirmation handlers', async () => {
  const f = fixture({ intercept: call => call.pathname.endsWith('/calendar') ? Promise.resolve(null) : undefined });
  await f.actions().initialize(); await f.actions().setupCalendar(); await f.actions().reviewCalendar(calendar.timeZone);
  const old = f.actions(); await f.actions().invalidateCalendarReview(); await old.confirmCalendar();
  assert.equal(f.writes().length, 0);
});
test('null calendar setup forwards the real prototype method through the root session only on explicit confirmation', async () => {
  const f = fixture({ intercept: call => call.pathname.endsWith('/calendar')
    ? Promise.resolve(call.method === 'GET' ? null : calendar) : undefined });
  assert.ok(f.context.activity.resources instanceof ActivityResources);
  assert.equal(Object.hasOwn(f.context.activity.resources, 'createCalendar'), false);
  assert.equal(f.context.activity.resources.createCalendar, ActivityResources.prototype.createCalendar);
  await f.actions().initialize();
  assert.equal(f.state().consumer.calendar.status, 'ready'); assert.equal(f.state().consumer.calendar.value, null);
  await f.actions().setupCalendar(); assert.equal(f.writes().length, 0);
  await f.actions().reviewCalendar(calendar.timeZone); assert.equal(f.writes().length, 0);
  const confirmation = f.actions(); await confirmation.confirmCalendar(); await confirmation.confirmCalendar();
  assert.equal(f.writes().length, 1);
  assert.deepEqual(f.writes()[0], { url: '/v1/activity/calendar', pathname: '/v1/activity/calendar', method: 'POST',
    body: { timeZone: calendar.timeZone, confirmed: true }, key: 'secure-key-0000000000000001' });
  assert.equal(f.state().consumer.calendarIntent.phase, 'configured'); assert.equal(f.state().route, 'list');
  assert.deepEqual(f.state().consumer.calendar.value, calendar); assert.equal(f.keyCount(), 1);
  await f.actions().beginManual(); assert.equal(f.state().route, 'editor'); assert.equal(f.writes().length, 1);
});
test('root disposal clears pending custody; a fresh root does not reconstruct or replay it', async () => {
  const f = fixture({ intercept: call => call.method === 'POST' && call.pathname.endsWith('/entries') ? Promise.reject({ status: 503 }) : undefined });
  await manual(f); await f.actions().review(); await f.actions().save(); await f.context.activity.dispose();
  assert.equal(f.state().custodyUnavailable, true); assert.equal(f.state().consumer.draft.pending, null);
  const next = fixture(); await next.actions().initialize(); assert.equal(next.state().consumer.draft.pending, null);
  await f.actions().retry('entry'); assert.equal(f.writes().length, 1); assert.equal(next.writes().length, 0);
});
test('saved receipt followed by failed detail read remains saved, never becomes save failure', async () => {
  const f = fixture({ intercept: call => call.method === 'GET' && call.pathname === '/v1/activity/entries/entry-one'
    ? Promise.reject({ status: 503, code: 'unavailable' }) : undefined });
  await manual(f); await f.actions().review(); await f.actions().save();
  assert.equal(f.state().receipt.status, 'recorded'); assert.equal(f.state().detail.status, 'unavailable');
  assert.match(f.state().notice, /Saved; latest detail unavailable/); assert.equal(f.writes().length, 1);
});
test('failed pagination retains prior date rows and cursor; empty and unavailable remain distinct', async () => {
  const value = existing();
  const f = fixture({ intercept: call => call.pathname.endsWith('/entries') && call.method === 'GET'
    ? call.url.includes('cursor=') ? Promise.reject({ status: 503 }) : Promise.resolve({ items: [value], nextCursor: 'same-date-page-two' }) : undefined });
  await f.actions().initialize(); await f.actions().loadDay(value.date.localDate);
  await f.actions().loadMore();
  assert.equal(f.state().rows[0].id, value.id); assert.equal(f.state().selectedDate, value.date.localDate);
  assert.equal(f.state().nextCursor, 'same-date-page-two'); assert.ok(f.state().listError);
  assert.match(f.calls.at(-1).url, /from=2026-11-10&to=2026-11-10/);
});
test('calendar null is setup, failure is unavailable, unknown calendar retries only original zone/key', async () => {
  let attempt = 0;
  const f = fixture({ intercept: call => call.pathname.endsWith('/calendar') ? call.method === 'GET' ? Promise.resolve(null)
    : ++attempt === 1 ? Promise.reject({ status: 503 }) : Promise.resolve(calendar) : undefined });
  assert.ok(f.context.activity.resources instanceof ActivityResources);
  assert.equal(Object.hasOwn(f.context.activity.resources, 'createCalendar'), false);
  await f.actions().initialize(); assert.equal(f.state().consumer.calendar.value, null);
  await f.actions().setupCalendar(); await f.actions().reviewCalendar(calendar.timeZone); assert.equal(f.writes().length, 0);
  await f.actions().confirmCalendar(); assert.equal(f.writes().length, 1);
  assert.equal(f.state().consumer.calendarIntent.phase, 'unknown');
  const first = editing.clone(f.writes()[0]); const reads = f.calls.length, issuedKeys = f.keyCount();
  assert.equal(first.pathname, '/v1/activity/calendar'); assert.equal(first.method, 'POST');
  assert.deepEqual(first.body, { timeZone: calendar.timeZone, confirmed: true }); assert.ok(first.key);
  await f.actions().reloadCalendar(); assert.equal(f.calls.length, reads);
  await f.actions().retry('calendar'); assert.deepEqual(f.writes()[1], first);
  assert.equal(f.writes().length, 2); assert.equal(f.keyCount(), issuedKeys);
  assert.equal(f.state().consumer.calendarIntent.phase, 'configured');
  await f.actions().retry('calendar'); assert.equal(f.writes().length, 2);
  assert.equal(f.state().consumer.calendar.value.timeZone, calendar.timeZone);
  const failed = fixture({ intercept: call => call.pathname.endsWith('/calendar') ? Promise.reject({ status: 503 }) : undefined });
  await failed.actions().initialize(); assert.equal(failed.state().consumer.calendar.status, 'unavailable');
  await failed.actions().setupCalendar(); assert.equal(failed.state().route, 'list'); assert.equal(failed.writes().length, 0);
});
test('malformed calendar read is unavailable rather than setup; absent adherence witness is never populated', async () => {
  const f = fixture({ intercept: call => call.pathname.endsWith('/calendar') ? Promise.resolve({})
    : call.pathname.endsWith('/adherence') ? Promise.resolve({ days: [] }) : undefined });
  await f.actions().initialize(); assert.equal(f.state().consumer.calendar.status, 'unavailable');
  await f.actions().setupCalendar(); assert.equal(f.state().route, 'list');
  await f.actions().loadDay('2026-11-10'); assert.equal(f.state().consumer.adherence.status, 'unavailable');
});
test('foreign pending channels remain visible and block navigation/new activity', async () => {
  const f = fixture({ intercept: call => call.method === 'POST' && call.pathname.endsWith('/exercises') ? Promise.reject({ status: 503 }) : undefined });
  await f.actions().initialize();
  const { ref, guidance, cueStatus, safetyAssessment, ...fields } = exercise;
  f.presentation.consumer.reviewPersonalExercise(fields); await f.presentation.consumer.confirmPersonalExercise();
  assert.deepEqual(pendingChannels(f.state().consumer), ['personal-create']);
  await f.actions().back(); await f.actions().beginManual(); assert.equal(f.calls.some(call => call.method === 'CLOSE'), false);
  assert.equal(f.state().consumer.draft.phase, 'idle');
});
test('existing speech final review accepts into the same editable draft and never autosaves ambiguous input', async () => {
  let observer;
  const speech = { subscribe: fn => { observer = fn; return { remove() {} }; },
    start: async () => { observer({ state: 'starting', sessionId: 'speech-one', text: '', isFinal: false }); return 'speech-one'; },
    stop: async () => { observer({ state: 'review', sessionId: 'speech-one', text: 'last Friday press', isFinal: true }); },
    acceptReview: input => ({ ...input, source: 'apple_on_device', locale: 'en-US' }), cancel: async () => {}, dispose: async () => {} };
  const f = fixture({ speech }); await f.actions().initialize(); await f.actions().beginSpeech(); await f.actions().stopSpeech();
  assert.equal(f.state().consumer.draft.phase, 'transcriptReview');
  await f.actions().acceptTranscript('last Friday press');
  assert.equal(f.state().route, 'editor'); assert.equal(f.writes().length, 0);
  assert.ok(f.state().consumer.draft.result.issues.some(issue => issue.code === 'dateAmbiguous'));
  assert.equal(f.state().consumer.draft.result.candidate.items[0].load.state, 'missing');
});

test('deferred speech startup survives attachment changes with fresh Stop/transcript controls and one original capture', async () => {
  for (const settleDetached of [false, true]) {
    const speech = deferredSpeech(), f = fixture({ speech: speech.port });
    await f.actions().initialize(); await f.actions().loadDay('2026-11-10');
    const oldList = f.actions(), starting = oldList.beginSpeech(), oldSpeech = f.actions();
    const capture = editing.clone(f.context.activity.controller.getState());
    assert.equal(capture.phase, 'capture'); assert.equal(capture.sessionId, 'speech-one');
    assert.equal(f.state().route, 'speech'); assert.equal(f.state().busy, true);
    const keys = f.keyCount(); f.detach();
    if (!settleDetached) f.attach();
    speech.starting.resolve('speech-one'); await starting;
    if (settleDetached) f.attach();
    assert.equal(activityPresentation(f.context), f.presentation);
    assert.deepEqual(f.state().consumer.draft.context, capture.context);
    assert.equal(f.state().consumer.draft.epoch, capture.epoch); assert.equal(f.state().route, 'speech');
    assert.equal(f.state().busy, false);
    await oldList.beginSpeech(); await oldSpeech.stopSpeech(); await oldSpeech.back();
    await oldSpeech.acceptTranscript('old private speech');
    assert.deepEqual(speech.calls.starts, ['en-US']); assert.equal(speech.calls.stops, 0);
    assert.equal(speech.calls.cancels, 0); assert.equal(f.keyCount(), keys);
    await f.actions().stopSpeech();
    assert.equal(speech.calls.stops, 1); assert.equal(f.state().route, 'speech');
    assert.equal(f.state().consumer.draft.phase, 'transcriptReview');
    assert.equal(f.state().consumer.draft.transcript, 'press unknown load');
    const oldReview = f.actions(); f.detach(); f.attach(); await oldReview.acceptTranscript('old private speech');
    assert.equal(f.state().consumer.draft.phase, 'transcriptReview'); assert.equal(speech.calls.accepts.length, 0);
    await f.actions().acceptTranscript('press unknown load');
    assert.equal(f.state().route, 'editor'); assert.equal(f.writes().length, 0);
    assert.equal(f.state().consumer.draft.epoch, capture.epoch);
    assert.deepEqual(f.state().consumer.draft.result.context, capture.context);
    assert.equal(f.state().consumer.draft.result.candidate.source, 'nativeSpeech');
    assert.equal(f.state().consumer.draft.result.candidate.performedConfirmed, false);
    const id = f.state().consumer.draft.result.candidate.items[0].id;
    await f.actions().edit(result => editing.changeLoad(result, id, { state: 'knownValue', value: 0, unit: 'lb', basis: 'assistance' }));
    await f.actions().review(); assert.equal(f.writes().length, 0); await f.actions().save();
    assert.equal(f.state().route, 'detail'); assert.equal(f.writes().length, 1);
    assert.equal(f.state().receipt.draftId, capture.context.draftId);
    assert.equal(f.state().receipt.source, 'nativeSpeech');
    assert.deepEqual(f.state().receipt.items[0].load, { state: 'knownValue', value: 0, unit: 'lb', basis: 'assistance' });
    assert.equal(f.state().receipt.date.capturedAt, capture.context.capturedAt);
    assert.equal(f.state().receipt.date.localDate, '2026-11-10');
    assert.deepEqual(speech.calls.starts, ['en-US']); assert.equal(speech.calls.accepts.length, 1);
    await f.context.activity.dispose();
  }
});
test('final transcript arriving before deferred startup resolves remains reviewable on a fresh attachment', async () => {
  const speech = deferredSpeech('last Friday press'), f = fixture({ speech: speech.port });
  await f.actions().initialize(); const starting = f.actions().beginSpeech();
  f.detach(); speech.final(); f.attach(); speech.starting.resolve('speech-one'); await starting;
  assert.equal(f.state().route, 'speech'); assert.equal(f.state().consumer.draft.phase, 'transcriptReview');
  await f.actions().acceptTranscript('last Friday press');
  assert.equal(f.state().route, 'editor'); assert.equal(f.writes().length, 0);
  assert.ok(f.state().consumer.draft.result.issues.some(issue => issue.code === 'dateAmbiguous'));
  assert.equal(f.state().consumer.draft.result.candidate.items[0].load.state, 'missing');
  await f.context.activity.dispose();
});
test('failed or unbound speech startup never fabricates a live capture or loses its honest cancellation state', async () => {
  for (const failure of ['rejected', 'unbound']) {
    const speech = deferredSpeech(), f = fixture({ speech: speech.port }); await f.actions().initialize();
    const starting = f.actions().beginSpeech(), old = f.actions(); f.detach(); f.attach();
    if (failure === 'rejected') speech.starting.reject(new Error('synthetic startup failure'));
    else speech.starting.resolve('different-speech-session');
    await starting;
    assert.equal(f.state().busy, false); assert.equal(f.state().consumer.draft.phase, 'cancelled');
    assert.equal(f.state().consumer.draft.sessionId, null); assert.equal(f.state().consumer.draft.context, null);
    assert.match(f.state().notice, /ended without a reviewable transcript/);
    await old.stopSpeech(); await old.acceptTranscript('old private speech');
    assert.equal(speech.calls.stops, 0); assert.equal(speech.calls.accepts.length, 0); assert.equal(f.writes().length, 0);
    await f.actions().back(); await f.actions().initialize(); await f.actions().beginManual();
    const manual = editing.clone(f.state().consumer.draft);
    speech.lateFinal(); await old.beginSpeech();
    assert.equal(f.state().route, 'editor'); assert.deepEqual(f.state().consumer.draft, manual);
    assert.deepEqual(speech.calls.starts, ['en-US']);
    await f.context.activity.dispose();
  }
  const absent = fixture(); await absent.actions().initialize(); await absent.actions().beginSpeech();
  assert.equal(absent.state().route, 'list'); assert.equal(absent.state().consumer.draft.phase, 'idle');
  assert.match(absent.state().notice, /Speech is unavailable/); await absent.context.activity.dispose();
});
test('background or disposal cancels deferred speech custody; late startup cannot repave an unrelated manual route', async () => {
  for (const boundary of ['background', 'dispose']) {
    const speech = deferredSpeech(), f = fixture({ speech: speech.port }); await f.actions().initialize();
    const starting = f.actions().beginSpeech(), old = f.actions(); f.detach();
    await f.context.activity[boundary](); f.attach(); speech.starting.resolve('speech-one'); await starting;
    assert.equal(f.state().consumer.draft.phase, 'cancelled'); assert.equal(f.state().consumer.draft.sessionId, null);
    assert.equal(f.state().consumer.draft.result, null); assert.equal(f.state().busy, false);
    assert.match(f.state().notice, /ended without a reviewable transcript/);
    await old.stopSpeech(); await old.acceptTranscript('old private speech');
    assert.equal(speech.calls.stops, 0); assert.equal(speech.calls.accepts.length, 0); assert.equal(f.writes().length, 0);
    if (boundary === 'background') {
      await f.actions().back(); await f.actions().initialize(); await f.actions().beginManual();
      const unrelated = editing.clone(f.state().consumer.draft); speech.lateFinal();
      assert.equal(f.state().route, 'editor'); assert.deepEqual(f.state().consumer.draft, unrelated);
      await f.context.activity.dispose();
    }
    assert.deepEqual(speech.calls.starts, ['en-US']);
  }
});
test('different root or generation never adopts an old deferred capture or its late private transcript', async () => {
  for (const generation of ['session-one', 'session-two']) {
    const speech = deferredSpeech(), f = fixture({ speech: speech.port }); await f.actions().initialize();
    const starting = f.actions().beginSpeech(), old = f.actions(); f.detach(); f.expire();
    const next = fixture({ sessionGeneration: generation }); await manual(next);
    const unrelated = editing.clone(next.state());
    speech.starting.resolve('speech-one'); await starting; speech.lateFinal();
    await old.beginSpeech(); await old.stopSpeech(); await old.acceptTranscript('old private speech');
    assert.equal(f.state().available, false); assert.equal(f.state().consumer, null); assert.equal(f.state().receipt, null);
    assert.deepEqual(next.state(), unrelated); assert.notEqual(next.presentation, f.presentation);
    assert.equal(next.state().route, 'editor'); assert.equal(next.state().consumer.draft.result.candidate.source, 'manual');
    assert.equal(next.state().consumer.draft.transcript, ''); assert.equal(next.writes().length, 0);
    assert.deepEqual(speech.calls.starts, ['en-US']); assert.equal(speech.calls.stops, 0); assert.equal(speech.calls.accepts.length, 0);
    await f.context.activity.dispose(); await next.context.activity.dispose();
  }
});
