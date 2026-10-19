const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const activityRoot = path.resolve(__dirname, '../..');
const cache = new Map();
// Production modules compile in memory. No filesystem scratch, network or native runtime is created.
function load(file) {
  const filename = path.resolve(activityRoot, file);
  assert.ok(filename.startsWith(activityRoot + path.sep));
  if (cache.has(filename)) return cache.get(filename).exports;
  const module = { exports: {} }; cache.set(filename, module);
  const compiled = ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  new Function('require', 'module', 'exports', compiled)(name => {
    assert.ok(name.startsWith('.'), `Unexpected runtime dependency ${name}`);
    return load(path.relative(activityRoot, path.resolve(path.dirname(filename), name + '.ts')));
  }, module, module.exports);
  return module.exports;
}
const d = load('drafts/index.ts');
const { ActivityResources } = load('resources.ts');
const { ActivityEntryConsumer } = load('entryConsumer.ts');
const chest = { ref: { source: 'global', id: 'chest-press' }, name: 'Chest press', description: '', movement: null,
  measurementType: 'repetitions', kind: 'resistance', loadApplicability: 'applicable', loadLabel: 'Weight',
  guidance: 'globalReference', cueStatus: 'globalReference', safetyAssessment: 'notEstablished' };
const run = { ...chest, ref: { source: 'personal', id: 'running', revision: 1 }, name: 'Running', kind: 'run',
  description: 'My running entry', movement: 'Run', measurementType: 'duration', loadApplicability: 'notApplicable', loadLabel: null,
  guidance: 'userDefinedUnassessed', cueStatus: 'unknown' };
const context = (changes = {}) => d.freezeCaptureContext({ accountGeneration: 'account-generation-1', draftId: 'draft-1',
  capturedAt: '2026-10-09T03:59:00Z', timeZone: 'America/New_York', selectedDate: null, ...changes });
const parse = (text, ctx = context(), catalog = [chest, run], locale = 'en-US') => d.parseReviewedActivity({
  source: 'apple_on_device', reviewed: true, sessionId: 'speech-1', locale, text,
}, ctx, catalog);
function confirm(result) {
  return { ...result, candidate: { ...result.candidate, date: { ...result.candidate.date, confirmed: true }, performedConfirmed: true } };
}
function manual(ctx = context(), exercise = chest, load = { state: 'unknown', confirmed: true }) {
  return confirm(d.setDraftLoad(d.manualActivityDraft(ctx, exercise), `${ctx.draftId.slice(0, 50)}_item_0`, load));
}
const write = () => d.draftToActivityWrite(manual());
const entry = payload => ({ ...payload, id: 'entry-1', revision: 1, status: 'recorded',
  items: payload.items.map(item => ({ ...item, snapshot: { ...chest, ref: { ...chest.ref } } })), createdAt: '2026-10-09T04:00:00Z', updatedAt: '2026-10-09T04:00:00Z' });
function configuredCalendar() {
  return { timeZone: 'America/New_York', activationDate: '2026-10-09', revision: 1,
    calendarPolicy: 'activity-calendar-intl-v1', createdAt: '2026-10-09T04:00:00Z' };
}

test('civil arithmetic handles leap, century, month and year boundaries without instant subtraction', () => {
  assert.equal(d.addCivilDays('2028-03-01', -1), '2028-02-29');
  assert.equal(d.addCivilDays('2100-03-01', -1), '2100-02-28');
  assert.equal(d.addCivilDays('2026-01-01', -1), '2025-12-31');
  assert.equal(d.addCivilDays('2026-05-01', -1), '2026-04-30');
  for (const invalid of ['2027-02-29', '2028-02-30', '2026-04-31', '2026-00-01', '2026-13-01', '26-02-01']) assert.equal(d.parseCivilDate(invalid), null);
});
test('frozen yesterday across spring transition and midnight uses civil reference', () => {
  const ctx = context({ capturedAt: '2026-03-09T04:30:00Z' });
  assert.equal(ctx.referenceLocalDate, '2026-03-09');
  assert.equal(parse('Yesterday I did chest press with unknown weight', ctx).candidate.date.localDate, '2026-03-08');
  assert.equal(parse('Yesterday I did chest press with unknown weight').candidate.date.localDate, '2026-10-07');
});
test('Intl New York spring and fall boundaries are actual 23 and 25 hour days', () => {
  for (const [date, hours] of [['2026-03-08', 23], ['2026-11-01', 25]]) {
    const boundary = d.civilDayBoundaries(date, 'America/New_York');
    assert.equal(boundary.status, 'available');
    assert.equal((new Date(boundary.endAt) - new Date(boundary.startAt)) / 3600000, hours);
  }
  assert.equal(d.localDateAt('2026-11-01T05:30:00Z', 'America/New_York'), '2026-11-01');
  assert.equal(d.localDateAt('2026-11-01T06:30:00Z', 'America/New_York'), '2026-11-01');
  assert.equal(d.localDateAt('2026-01-01T18:20:00Z', 'Asia/Kathmandu'), '2026-01-02');
});
test('invalid zones and Apia skipped civil day are unavailable, never shifted', () => {
  assert.equal(d.civilDayBoundaries('2026-03-08', 'No/SuchZone').status, 'unavailable');
  assert.deepEqual(d.civilDayBoundaries('2011-12-30', 'Pacific/Apia'), { status: 'unavailable', reason: 'skippedCivilDay' });
  assert.throws(() => context({ timeZone: 'No/SuchZone' }), /capture_context_unavailable/);
});
test('offset-bearing capture must be syntactically valid and cannot normalize invalid dates', () => {
  for (const value of ['2026-02-30T00:00:00Z', '2026-10-08T24:00:00Z', 'yesterday', '2026-10-08', '2026-10-08T12:30:00']) assert.equal(d.instantMilliseconds(value), null);
});
test('selected-spoken disagreement retains both candidates and cannot save', () => {
  const result = parse('Yesterday chest press 75 pounds', context({ selectedDate: '2026-10-03' }));
  assert.equal(result.candidate.date.localDate, '2026-10-03');
  assert.deepEqual(result.issues.find(issue => issue.code === 'dateConflict').candidates.map(item => item.id), ['2026-10-03', '2026-10-07']);
  assert.throws(() => d.draftToActivityWrite(confirm(result)), d.ActivityValidationError);
});
test('explicit ISO and month-name year are supported; yearless numeric weekday and multi-day need review', () => {
  for (const text of ['2028-02-29', 'February 29, 2028']) assert.equal(parse(`${text} chest press unknown weight`).candidate.date.localDate, '2028-02-29');
  for (const text of ['February 29', '03/04', 'last Friday']) assert.ok(parse(`${text} chest press unknown weight`).issues.some(issue => issue.code === 'dateAmbiguous'));
  assert.ok(parse('Today and yesterday chest press unknown weight').issues.some(issue => issue.code === 'dateConflict'));
  assert.ok(parse('2027-02-29 chest press unknown weight').issues.some(issue => issue.code === 'dateUnavailable'));
});
test('future completed-date policy compares only caller-supplied server today', () => {
  assert.equal(d.validateActivityDateAgainstServerToday('2026-10-10', 'America/New_York', '2026-10-09'), 'future_activity_date');
  assert.equal(d.validateActivityDateAgainstServerToday('1900-01-01', 'America/New_York', '2026-10-09'), null);
  assert.equal(d.validateActivityDateAgainstServerToday('1899-12-31', 'America/New_York', '2026-10-09'), 'invalid_activity_date');
  assert.equal(d.validateActivityDateAgainstServerToday('2026-10-08', 'America/New_York', ''), 'server_today_unavailable');
});
test('negation future intent questions and full corrections never become performance items', () => {
  for (const text of ["I didn't run", 'Tomorrow I will run 56 minutes', 'Should I run 56 minutes?', 'Chest press 75—no, 65 pounds']) {
    const result = parse(text); assert.equal(result.candidate.items.length, 0); assert.equal(result.candidate.performedConfirmed, false); assert.ok(result.issues.length);
  }
});
test('unsupported locale stays editable text without fabricated structured values', () => {
  const result = parse('Chest press 75 pounds', context(), [chest], 'fr-FR');
  assert.equal(result.candidate.items.length, 0); assert.equal(result.reviewedText, 'Chest press 75 pounds');
  assert.equal(result.issues[0].code, 'unsupportedLocale');
});
test('manual one-exercise unknown load is enough after explicit structured review', () => {
  const payload = write(); assert.equal(payload.items.length, 1); assert.deepEqual(payload.items[0].load, { state: 'unknown', confirmed: true });
  assert.equal(payload.items[0].sets, undefined); assert.equal(payload.items[0].reportedSetCount, undefined);
  assert.throws(() => d.draftToActivityWrite(d.manualActivityDraft(context(), chest)), /Review/);
});
test('missing, unknown, explicit unloaded and known zero are four different dispositions', () => {
  const missing = parse('I did chest press'); assert.deepEqual(missing.candidate.items[0].load, { state: 'missing' });
  assert.equal(missing.issues.filter(issue => issue.code === 'loadMissing').length, 1);
  for (const [text, state] of [["I did chest press I don't remember the weight", 'unknown'], ['I did chest press no added weight', 'notApplicable'], ['I did chest press 0 kg', 'knownValue']]) {
    const result = parse(text); assert.equal(result.candidate.items[0].load.state, state); assert.equal(result.issues.some(issue => issue.code === 'loadMissing'), false);
    assert.equal(d.draftToActivityWrite(confirm(result)).items[0].load.state, state);
  }
  assert.equal(d.sanitizeLoad({ state: 'knownValue', value: 0, unit: 'kg', basis: 'unspecified' }).value, 0);
});
test('three sets retain reported count/load without invented reps or equal observations', () => {
  const result = parse('I did three sets of chest press 75 pounds');
  assert.equal(result.candidate.items[0].reportedSetCount, 3); assert.equal(result.candidate.items[0].sets, undefined);
  assert.equal(result.candidate.items[0].load.value, 75); assert.equal(result.issues.length, 0);
});
test('explicit reps produce inspectable stable set IDs and conflicting count needs review', () => {
  const result = parse('Chest press 8 reps 0 kg');
  assert.equal(result.candidate.items[0].sets[0].repetitions, 8);
  assert.equal(result.candidate.items[0].sets[0].id, parse('Chest press 8 reps 0 kg').candidate.items[0].sets[0].id);
  const conflict = parse('Chest press 3 sets 8 reps 75 pounds');
  assert.ok(conflict.issues.some(issue => issue.code === 'metricConflict'));
});
test('duplicate names require explicit catalog identity selection and custom mentions are candidates only', () => {
  const duplicate = { ...chest, ref: { source: 'personal', id: 'custom-chest', revision: 2 }, movement: 'Cable press' };
  const result = parse('Chest press unknown weight', context(), [chest, duplicate]);
  assert.equal(result.candidate.items[0].exercise.state, 'ambiguous');
  assert.ok(result.issues.some(issue => issue.code === 'exerciseAmbiguous'));
  const ref = parse('personal:custom-chest@2 unknown weight', context(), [chest, duplicate]);
  assert.equal(ref.candidate.items[0].exercise.ref.id, 'custom-chest');
  const custom = parse('Exercise called seated towel pull for 2 minutes');
  assert.equal(custom.candidate.items[0].exercise.state, 'custom');
  assert.equal(custom.candidate.items[0].exercise.fields.name, 'seated towel pull');
  assert.throws(() => d.draftToActivityWrite(confirm(custom)), d.ActivityValidationError);
});
test('repeated exercise clauses preserve separate stable item identities', () => {
  const result = parse('Chest press 75 pounds; chest press 65 pounds');
  assert.equal(result.candidate.items.length, 2); assert.notEqual(result.candidate.items[0].id, result.candidate.items[1].id);
  assert.equal(result.candidate.items[1].load.value, 65);
});
test('run 56 minutes and 8:30 mile pace preserve exact units and derive distance only for display', () => {
  const result = parse('I ran for 56 minutes at an 8:30 mile pace');
  const item = result.candidate.items[0]; assert.equal(item.durationSeconds, 3360); assert.deepEqual(item.pace, { secondsPerUnit: 510, unit: 'mi' });
  assert.equal(item.distance, undefined); assert.deepEqual(item.load, { state: 'notApplicable', reason: 'timedActivity' });
  const derived = d.deriveDisplayMetrics(item); assert.equal(derived[0].derived, true); assert.equal(derived[0].value.value, 3360 / 510);
  const payload = d.draftToActivityWrite(confirm(result)); assert.equal(payload.items[0].distance, undefined);
});
test('run duration required while optional speed/pace/distance remain absent', () => {
  assert.ok(parse('I ran').issues.some(issue => issue.code === 'durationMissing'));
  const result = parse('I ran 56 minutes'); assert.equal(d.draftToActivityWrite(confirm(result)).items[0].pace, undefined);
  for (const text of ['I ran 56 minutes pace 8:30', 'I ran 56 minutes speed 6']) assert.ok(parse(text).issues.some(issue => issue.code === 'unitMissing'));
});
test('mile lb pace and speed conversions preserve original report and roundtrip values', () => {
  assert.equal(d.distanceMetres({ value: 1, unit: 'mi' }), 1609.344);
  assert.equal(d.KG_PER_POUND, 0.45359237);
  assert.equal(d.paceSecondsPerMetre({ secondsPerUnit: 510, unit: 'mi' }) * 1609.344, 510);
  assert.ok(Math.abs(d.speedMetresPerSecond({ value: 6, unit: 'mi/h' }) * 3600 / 1609.344 - 6) < 1e-12);
  const result = parse('I ran 56 minutes 6 mph 5 miles');
  assert.deepEqual(result.candidate.items[0].speed, { value: 6, unit: 'mi/h' });
  assert.deepEqual(result.candidate.items[0].distance, { value: 5, unit: 'mi' });
  assert.ok(result.issues.some(issue => issue.code === 'metricConflict'));
});
test('incremental partial and complete splits are inspectable and contradictions need review', () => {
  const partial = parse('I ran 56 minutes partial incremental splits 20 minutes, 10 minutes');
  assert.equal(partial.candidate.items[0].splits.length, 2); assert.equal(partial.candidate.items[0].splitCoverage, 'partial');
  assert.equal(partial.issues.length, 0); d.draftToActivityWrite(confirm(partial));
  const complete = parse('I ran 56 minutes complete incremental splits 28 minutes, 28 minutes');
  assert.equal(complete.issues.length, 0);
  assert.ok(parse('I ran 56 minutes complete incremental splits 20 minutes, 10 minutes').issues.some(issue => issue.code === 'metricConflict'));
  assert.ok(parse('I ran 56 minutes cumulative splits 20 minutes, 30 minutes').issues.some(issue => issue.code === 'unsupportedPhrase'));
});
test('then-separated running splits stay with the run through reviewed speech and explicit save', async () => {
  const speech = speechPort(), calls = [];
  const controller = new d.DraftController('account-generation-1', {
    createEntry: async payload => { calls.push(payload); return entry(payload); },
    editEntry: async () => { throw new Error('unused'); },
  }, () => 'command-key-0001', speech);
  const text = 'Yesterday I ran 56 minutes partial incremental splits 20 minutes then ten minutes then chest press 75 pounds';
  await controller.beginSpeech(context(), 'en-US');
  speech.emit({ state: 'review', isFinal: true, text });
  controller.acceptTranscript(text, [chest, run]);
  const result = controller.getState().result;
  assert.equal(result.candidate.items.length, 2);
  assert.deepEqual(result.candidate.items[0].splits.map(split => split.durationSeconds), [1200, 600]);
  assert.equal(result.candidate.items[0].durationSeconds, 3360);
  assert.equal(result.candidate.items[1].exercise.ref.id, 'chest-press');
  assert.equal(result.candidate.items[1].load.value, 75);
  assert.equal(result.candidate.date.localDate, '2026-10-07');
  assert.deepEqual(result.issues, []);
  assert.equal(calls.length, 0);
  await assert.rejects(controller.save(), d.ActivityValidationError);
  assert.equal(calls.length, 0);
  controller.edit(confirm(result));
  assert.equal((await controller.save()).phase, 'saved');
  assert.deepEqual(calls[0].items[0].splits.map(split => split.durationSeconds), [1200, 600]);
  assert.equal(calls[0].items[0].pace, undefined);
  assert.equal(calls[0].items[1].sets, undefined);
});
test('unsupported fragments remain visible and cannot silently save as complete capture', () => {
  const result = parse('Chest press 75 pounds and banana pancakes');
  assert.ok(result.unsupportedFragments.some(value => value.includes('banana pancakes')));
  assert.throws(() => d.draftToActivityWrite(confirm(result)), d.ActivityValidationError);
});
test('strict nested schema rejects extra body/derived/transcript data before dispatch', () => {
  const calls = [], resources = new ActivityResources({ request: (...args) => { calls.push(args); return Promise.resolve({}); } });
  const valid = write();
  for (const invalid of [{ ...valid, bodyData: 'NO-SAVE-BODY' }, { ...valid, transcript: 'NO-SAVE-TRANSCRIPT' },
    { ...valid, items: [{ ...valid.items[0], derived: true }] }, { ...valid, items: [{ ...valid.items[0], load: { state: 'unknown', confirmed: true, image: 'NO-SAVE-IMAGE' } }] }]) {
    assert.throws(() => resources.createEntry(invalid, 'command-key-0001'), d.ActivityValidationError);
  }
  assert.equal(calls.length, 0);
  for (const invalid of [NaN, Infinity, -1, 100000]) assert.throws(() => d.sanitizeLoad({ state: 'knownValue', value: invalid, unit: 'kg', basis: 'total' }), d.ActivityValidationError);
  assert.throws(() => d.sanitizeLoad({ state: 'unknown', confirmed: false }), d.ActivityValidationError);
});
test('client resource injects existing transport and uses keyed exact routes/revisions', async () => {
  const calls = [], resources = new ActivityResources({ request: (...args) => { calls.push(args); return Promise.resolve({}); } });
  await resources.editEntry('entry-1', 3, write(), 'command-key-0001');
  assert.equal(calls[0][0], '/v1/activity/entries/entry-1'); assert.equal(calls[0][1], 'PATCH');
  assert.equal(calls[0][2].expectedRevision, 3); assert.equal(calls[0][3], 'command-key-0001');
  await resources.entries({ from: '2026-10-01', to: '2026-10-09', limit: 10 });
  assert.ok(calls[1][0].includes('from=2026-10-01')); assert.ok(calls[1][0].includes('to=2026-10-09'));
  assert.throws(() => resources.entries({ limit: 10 }), d.ActivityValidationError);
});
test('personal full fields retain unknown guidance boundary and reject arbitrary metadata', async () => {
  const calls = [], resources = new ActivityResources({ request: (...args) => { calls.push(args); return Promise.resolve({}); } });
  const fields = { name: 'Own pull', description: 'My movement description', movement: 'Pull', measurementType: 'duration', kind: 'timed', loadApplicability: 'unspecified', loadLabel: null };
  await resources.createPersonalExercise(fields, 'command-key-0001'); assert.deepEqual(calls[0][2], fields);
  assert.throws(() => resources.createPersonalExercise({ ...fields, safetyAssessment: 'safe' }, 'command-key-0002'), d.ActivityValidationError);
});
test('reducer ignores old account/session/epoch callbacks after cancellation', () => {
  let state = d.initialDraftState('generation-a'); const ctx = context({ accountGeneration: 'generation-a' });
  state = d.draftReducer(state, { type: 'begin', accountGeneration: 'generation-a', context: ctx, manual: null });
  const epoch = state.epoch;
  state = d.draftReducer(state, { type: 'cancel', accountGeneration: 'generation-b' });
  const before = state;
  state = d.draftReducer(state, { type: 'speech', epoch, accountGeneration: 'generation-a', draft: { sessionId: 's', state: 'review', text: 'PRIVATE LATE', isFinal: true, error: null } });
  assert.equal(state, before); assert.equal(state.transcript, ''); assert.equal(state.context, null);
});
test('unknown write retains identical sanitized payload/key/revision and explicit edit gets a new key', async () => {
  const calls = []; let attempts = 0, keys = 0;
  const controller = new d.DraftController('account-generation-1', {
    createEntry: async (payload, key) => { calls.push([payload, key]); if (++attempts === 1) throw { status: 0, effectUnknown: true }; return entry(payload); },
    editEntry: async (id, expectedRevision, payload, key) => { calls.push([payload, key, id, expectedRevision]); if (++attempts === 1) throw { status: 0, effectUnknown: true }; return entry(payload); },
  }, () => `command-key-${++keys}-0000`);
  controller.beginManual(context(), chest); controller.edit(manual());
  assert.equal((await controller.save({ id: 'entry-1', expectedRevision: 4 })).phase, 'unknown');
  assert.throws(() => controller.edit(manual()), /draft_edit_unavailable/);
  const leaked = controller.getState(); leaked.pending.payload.items[0].load = { state: 'notApplicable', reason: 'bodyweight' };
  assert.equal((await controller.retryUnknown()).phase, 'saved');
  assert.equal(calls[0][0], calls[1][0]); assert.equal(calls[0][1], calls[1][1]); assert.equal(calls[1][3], 4); assert.equal(keys, 1);
  controller.beginManual(context({ draftId: 'draft-2' }), chest); controller.edit(manual(context({ draftId: 'draft-2' })));
  await controller.save(); assert.equal(keys, 2); assert.notEqual(calls[1][1], calls[2][1]);
});
test('account switch while saving clears text/pending and late completion cannot repopulate', async () => {
  let resolve;
  const controller = new d.DraftController('account-generation-1', { createEntry: payload => new Promise(done => { resolve = () => done(entry(payload)); }), editEntry: async () => { throw new Error('unused'); } }, () => 'command-key-0001');
  controller.beginManual(context(), chest); controller.edit(manual()); const saving = controller.save();
  await controller.accountChanged('new-generation'); resolve(); await saving;
  assert.equal(controller.getState().phase, 'cancelled'); assert.equal(controller.getState().pending, null);
  assert.equal(controller.getState().saved, null); assert.equal(controller.getState().transcript, '');
});
function speechPort() {
  let listener, id = 0, current;
  return {
    availability: async () => ({ available: true }), requestPermissions: async () => ({}),
    subscribe: fn => { listener = fn; return { remove: () => { listener = null; } }; },
    start: async locale => { current = { sessionId: `speech-${++id}`, locale, text: '', state: 'starting', isFinal: false, error: null }; listener?.(current); return current.sessionId; },
    stop: async () => {}, cancel: async () => { if (current) { current = { ...current, text: '', state: 'discarded' }; listener?.(current); } }, dispose: async () => {},
    acceptReview: review => { assert.equal(current.state, 'review'); assert.equal(review.sessionId, current.sessionId); const accepted = { source: 'apple_on_device', reviewed: true, sessionId: review.sessionId, locale: current.locale, text: review.text }; current = { ...current, text: '', state: 'discarded' }; listener?.(current); return accepted; },
    emit: changes => { current = { ...current, ...changes }; listener?.(current); },
    savedListener: () => listener,
  };
}
test('recognizer events never call API, acceptReview must still lead to structured review and explicit Save', async () => {
  const speech = speechPort(), calls = [];
  const controller = new d.DraftController('account-generation-1', { createEntry: async value => { calls.push(value); return entry(value); }, editEntry: async () => { throw new Error('unused'); } }, () => 'command-key-0001', speech);
  await controller.beginSpeech(context(), 'en-US'); speech.emit({ state: 'recording', text: 'partial', isFinal: false });
  assert.throws(() => controller.acceptTranscript('partial', [chest]), /transcript_review_unavailable/);
  speech.emit({ state: 'review', text: 'Chest press 75 pounds', isFinal: true });
  controller.acceptTranscript('Chest press 75 pounds', [chest]); assert.equal(controller.getState().phase, 'structuredReview'); assert.equal(calls.length, 0);
  controller.edit(confirm(controller.getState().result)); await controller.save(); assert.equal(calls.length, 1);
});
test('background clears reviewed text and detached late callback cannot restore it', async () => {
  const speech = speechPort();
  const controller = new d.DraftController('account-generation-1', { createEntry: async () => { throw new Error('unused'); }, editEntry: async () => { throw new Error('unused'); } }, () => 'command-key-0001', speech);
  await controller.beginSpeech(context(), 'en-US'); const late = speech.savedListener();
  speech.emit({ state: 'recording', text: 'PRIVATE TRANSCRIPT' }); await controller.background();
  late({ sessionId: 'speech-1', state: 'review', text: 'PRIVATE LATE', isFinal: true, error: null });
  assert.equal(controller.getState().transcript, ''); assert.equal(controller.getState().result, null);
});
test('known revision conflict stays stale without automatic overwrite, malformed/5xx response stays unknown', async () => {
  for (const [failure, phase] of [[{ status: 409, code: 'stale_revision' }, 'stale'], [{ status: 401, code: 'unauthenticated' }, 'rejected'], [{ status: 502 }, 'unknown']]) {
    let calls = 0;
    const controller = new d.DraftController('account-generation-1', { createEntry: async () => { calls++; throw failure; }, editEntry: async () => { throw failure; } }, () => 'command-key-0001');
    controller.beginManual(context(), chest); controller.edit(manual()); assert.equal((await controller.save()).phase, phase); assert.equal(calls, 1);
  }
});
test('decimal load remains a load and decimal pace without explicit sexagesimal meaning needs review', () => {
  const result = parse('Chest press 75.5 pounds'); assert.equal(result.candidate.items[0].load.value, 75.5); assert.equal(result.issues.length, 0);
  assert.ok(parse('I ran 56 minutes at 8.3 mile pace').issues.length > 0);
});
test('catalog snapshot and saved historical metadata freeze independently from later edits', () => {
  const mutable = { ...chest, ref: { ...chest.ref } };
  const draft = d.manualActivityDraft(context(), mutable); mutable.name = 'New catalog name'; mutable.description = 'new'; mutable.ref.id = 'changed';
  assert.equal(draft.candidate.items[0].exercise.snapshot.name, 'Chest press'); assert.equal(draft.candidate.items[0].exercise.snapshot.ref.id, 'chest-press');
  const logged = entry(write()), corrected = d.draftFromEntry('account-generation-1', logged);
  logged.items[0].snapshot.name = 'Mutated response'; assert.equal(corrected.candidate.items[0].exercise.snapshot.name, 'Chest press');
  assert.equal(corrected.draftId, logged.draftId); assert.equal(corrected.candidate.date.capturedAt, logged.date.capturedAt);
  assert.equal(corrected.candidate.performedConfirmed, false);
});
test('saved exercise replacement gets fresh identity and resets observations instead of reusing history identity', () => {
  const result = d.replaceDraftExercise(manual(), 'draft-1_item_0', 'fresh-item-2', run);
  assert.equal(result.candidate.items[0].id, 'fresh-item-2'); assert.equal(result.candidate.items[0].exercise.ref.id, 'running');
  assert.equal(result.candidate.items[0].load.state, 'missing');
  assert.throws(() => d.replaceDraftExercise(manual(), 'draft-1_item_0', 'draft-1_item_0', run), /replacement_identity_required/);
});
test('plans carry optional reviewed targets rather than performed load/reps or default zero', async () => {
  const calls = [], resources = new ActivityResources({ request: (...args) => { calls.push(args); return Promise.resolve({}); } });
  const plan = { name: 'Own plan', minutes: null, items: [{ id: 'plan-item-1', exercise: run.ref, target: {} }] };
  await resources.createPlan(plan, 'command-key-0001'); assert.deepEqual(calls[0][2], plan);
  assert.throws(() => resources.createPlan({ ...plan, items: [{ ...plan.items[0], load: { state: 'unknown', confirmed: true } }] }, 'command-key-0002'), d.ActivityValidationError);
  assert.throws(() => resources.createPlan({ ...plan, items: [{ ...plan.items[0], target: { repMin: 8 } }] }, 'command-key-0002'), d.ActivityValidationError);
  assert.throws(() => resources.createPlan({ ...plan, body: 'NO-SAVE' }, 'command-key-0002'), d.ActivityValidationError);
});
test('calendar/correction/schedule use confirmed zone and seven reviewed weekdays with keyed writes', async () => {
  const calls = [], resources = new ActivityResources({ request: (...args) => { calls.push(args); return Promise.resolve({}); } });
  await resources.createCalendar('America/New_York', 'command-key-0001'); assert.equal(calls[0][2].confirmed, true);
  const correction = { expectedRevision: 0, expectation: 'rest', plan: null, reason: 'scheduleWasIncorrect', confirmed: true };
  await resources.correctDay('2026-10-01', correction, 'command-key-0002'); assert.deepEqual(calls[1][2], correction);
  assert.throws(() => resources.correctDay('2026-10-01', { ...correction, confirmed: false }, 'command-key-0002'), d.ActivityValidationError);
  const week = Array.from({ length: 7 }, (_, index) => ({ isoWeekday: index + 1, expectation: index === 0 ? 'workout' : 'rest', plan: null }));
  await resources.saveSchedule({ expectedRevision: 0, effectiveFrom: '2026-10-09', week }, 'command-key-0003');
  assert.equal(calls[2][2].week.length, 7);
  assert.throws(() => resources.saveSchedule({ expectedRevision: 0, effectiveFrom: '2026-10-09', week: week.map(day => ({ ...day, expectation: 'rest' })) }, 'command-key-0004'), d.ActivityValidationError);
});
test('structured save discards reviewed transcript while retaining only sanitized unknown command state', async () => {
  const speech = speechPort(), controller = new d.DraftController('account-generation-1', { createEntry: async () => { throw { status: 0, effectUnknown: true }; }, editEntry: async () => {} }, () => 'command-key-0001', speech);
  await controller.beginSpeech(context(), 'en-US'); speech.emit({ state: 'review', isFinal: true, text: 'Chest press 75 pounds' });
  controller.acceptTranscript('Chest press 75 pounds', [chest]); controller.edit(confirm(controller.getState().result)); await controller.save();
  assert.equal(controller.getState().phase, 'unknown'); assert.equal(controller.getState().result.reviewedText, ''); assert.equal(controller.getState().transcript, '');
  assert.equal(controller.getState().pending.payload.transcript, undefined);
});
test('bare numeric load needs explicit unit and decimal minutes per mile stays distinct from M:SS', () => {
  assert.ok(parse('Chest press 75').issues.some(issue => issue.code === 'unitMissing'));
  const decimal = parse('I ran 56 minutes at 8.3 minutes per mile');
  assert.equal(decimal.candidate.items[0].pace.secondsPerUnit, 8.3 * 60); assert.equal(decimal.candidate.items[0].durationSeconds, 3360);
  const ambiguous = parse('I ran 56 minutes at 8.3 mile pace');
  assert.equal(ambiguous.candidate.items[0].distance, undefined); assert.equal(ambiguous.candidate.items[0].pace, undefined); assert.ok(ambiguous.issues.some(issue => issue.code === 'unsupportedPhrase'));
});
test('explicit unknown missing-load resolution does not repeat prompts or change known zero', () => {
  const missing = parse('Chest press; chest press 0 kg');
  const reviewed = d.confirmUnknownMissingLoads(missing);
  assert.equal(reviewed.candidate.items[0].load.state, 'unknown'); assert.equal(reviewed.candidate.items[1].load.value, 0);
  assert.equal(reviewed.issues.filter(issue => issue.code === 'loadMissing' && !issue.resolution).length, 0);
});
test('frozen capture provenance cannot be edited while the user changes a selected activity date', () => {
  const controller = new d.DraftController('account-generation-1', { createEntry: async () => {}, editEntry: async () => {} }, () => 'command-key-0001');
  controller.beginManual(context(), chest);
  const result = manual();
  assert.throws(() => controller.edit({ ...result, context: { ...result.context, timeZone: 'UTC' } }), /stale_draft/);
  assert.throws(() => d.draftToActivityWrite({ ...result, candidate: { ...result.candidate, date: { ...result.candidate.date, capturedAt: '2026-10-10T03:59:00Z' } } }), d.ActivityValidationError);
  controller.edit(d.selectDraftDate(result, '2026-10-01')); assert.equal(controller.getState().result.candidate.date.localDate, '2026-10-01');
});
test('root session_changed preserves prior effect uncertainty but forbids old command retry/new save until generation refresh', async () => {
  const controller = new d.DraftController('account-generation-1', { createEntry: async () => { throw { status: 409, code: 'session_changed', effectUnknown: false, originalEffectUnknown: true }; }, editEntry: async () => {} }, () => 'command-key-0001');
  controller.beginManual(context(), chest); controller.edit(manual()); const state = await controller.save();
  assert.equal(state.phase, 'rejected'); assert.equal(state.pending, null); assert.equal(state.result, null); assert.equal(state.error.originalEffectUnknown, true);
  await assert.rejects(controller.retryUnknown(), /unknown_retry_unavailable/);
  assert.throws(() => controller.beginManual(context(), chest), /capture_unavailable/);
  await assert.rejects(controller.accountChanged('account-generation-1'), /account_generation_refresh_required/);
  await controller.accountChanged('account-generation-2'); controller.beginManual(context({ accountGeneration: 'account-generation-2' }), chest);
  assert.equal(controller.getState().phase, 'structuredReview');
});
test('a late old-account rejection does not invalidate a newly refreshed controller generation', async () => {
  let reject;
  const controller = new d.DraftController('account-generation-1', { createEntry: () => new Promise((_, fail) => { reject = fail; }), editEntry: async () => {} }, () => 'command-key-0001');
  controller.beginManual(context(), chest); controller.edit(manual()); const pending = controller.save();
  await controller.accountChanged('account-generation-2');
  reject({ status: 409, code: 'session_changed', originalEffectUnknown: true }); await pending;
  controller.beginManual(context({ accountGeneration: 'account-generation-2' }), chest);
  assert.equal(controller.getState().phase, 'structuredReview'); assert.equal(controller.getState().error, null);
});

test('entry consumer fetches the recorded revision, preserves historical fields, and retries the same unknown edit', async () => {
  const calls = [], recorded = { ...entry(write()), revision: 7 };
  recorded.items[0].snapshot.name = 'Historical retired name';
  let attempts = 0;
  const resources = new ActivityResources({ request: async (path, method, payload, key) => {
    calls.push({ path, method, payload, key });
    if (path.includes('?')) return { items: [recorded], nextCursor: 'next-page' };
    if (method !== 'PATCH') return recorded;
    if (++attempts === 1) throw { status: 0, effectUnknown: true };
    return { ...recorded, ...payload, revision: 8, items: recorded.items };
  } });
  let keys = 0;
  const newSecureKey = () => `command-key-${++keys}-0000`;
  const controller = new d.DraftController('account-generation-1', resources, newSecureKey);
  const consumer = new ActivityEntryConsumer({ isCurrentSession: () => true,
    activity: { resources, controller, newSecureKey, sessionGeneration: 'account-generation-1' } });
  await consumer.loadEntries({ from: '2026-10-01', to: '2026-10-09', limit: 5 });
  assert.equal(consumer.getState().entries.value.nextCursor, 'next-page');
  await consumer.beginEntryEdit('entry-1');
  let state = consumer.getState();
  assert.equal(calls[1].path, '/v1/activity/entries/entry-1');
  assert.equal(state.draft.editTarget.expectedRevision, 7);
  assert.equal(state.draft.result.candidate.items[0].exercise.snapshot.name, 'Historical retired name');
  assert.equal(state.draft.result.candidate.date.capturedAt, recorded.date.capturedAt);
  await assert.rejects(consumer.save(), d.ActivityValidationError);
  consumer.confirmReview(); await consumer.save();
  assert.equal(consumer.getState().draft.phase, 'unknown');
  await assert.rejects(consumer.beginEntryEdit('entry-1'), /capture_unavailable/);
  await consumer.retryUnknown();
  assert.equal(calls[2].key, calls[3].key);
  assert.deepEqual(calls[2].payload, calls[3].payload);
  assert.equal(calls[3].payload.expectedRevision, 7);
  assert.equal(keys, 1);
  state = consumer.getState();
  assert.equal(state.draft.phase, 'saved');
  assert.equal(state.entries.status, 'idle');
  assert.equal(state.adherence.status, 'idle');
  await consumer.dispose();
});

test('entry consumer keeps failed reads distinct from empty lists and null calendar, and explicit stale reload requires review', async () => {
  let failed = true, currentRevision = 1;
  const resources = new ActivityResources({ request: async (path, method) => {
    if (path === '/v1/activity/calendar') return null;
    if (path.includes('?')) { if (failed) throw { status: 503, code: 'offline' }; return { items: [], nextCursor: null }; }
    if (method === 'PATCH') { currentRevision = 2; throw { status: 409, code: 'stale_revision' }; }
    return { ...entry(write()), revision: currentRevision };
  } });
  const newSecureKey = () => 'command-key-0001';
  const controller = new d.DraftController('account-generation-1', resources, newSecureKey);
  const consumer = new ActivityEntryConsumer({ isCurrentSession: () => true,
    activity: { resources, controller, newSecureKey, sessionGeneration: 'account-generation-1' } });
  await consumer.loadEntries({ from: '2026-10-01', to: '2026-10-09' });
  assert.deepEqual(consumer.getState().entries, { status: 'unavailable', error: { status: 503, code: 'offline' } });
  failed = false; await consumer.loadEntries({ from: '2026-10-01', to: '2026-10-09' });
  assert.deepEqual(consumer.getState().entries, { status: 'ready', value: { items: [], nextCursor: null } });
  await consumer.loadCalendar(); assert.deepEqual(consumer.getState().calendar, { status: 'ready', value: null });
  await consumer.beginEntryEdit('entry-1'); consumer.confirmReview(); await consumer.save();
  assert.equal(consumer.getState().draft.phase, 'stale');
  assert.equal(consumer.getState().draft.editTarget.expectedRevision, 1);
  await consumer.beginEntryEdit('entry-1');
  assert.equal(consumer.getState().draft.editTarget.expectedRevision, 2);
  assert.equal(consumer.getState().draft.result.candidate.performedConfirmed, false);
  await assert.rejects(consumer.save(), d.ActivityValidationError);
  await consumer.dispose();
});

test('entry consumer binds manual backdates and reviewed speech to actual session capture and loaded catalog', async () => {
  const speech = speechPort(), writes = [];
  const resources = new ActivityResources({ request: async (path, method, payload) => {
    if (path === '/v1/activity/calendar') return configuredCalendar();
    if (path === '/v1/activity/catalog') return { items: [chest, run], selectionUses: ['manual', 'nativeSpeech'] };
    writes.push(payload); return entry(payload);
  } });
  let keys = 0;
  const newSecureKey = () => `command-key-${++keys}-0000`;
  const controller = new d.DraftController('account-generation-1', resources, newSecureKey, speech);
  const consumer = new ActivityEntryConsumer({ isCurrentSession: () => true,
    activity: { resources, controller, newSecureKey, sessionGeneration: 'account-generation-1' } });
  const input = { capturedAt: '2026-10-09T03:59:00Z', timeZone: 'America/New_York', selectedDate: '2026-10-02' };
  await consumer.loadCalendar();
  consumer.beginManual(input, chest);
  let result = consumer.getState().draft.result;
  assert.equal(result.context.referenceLocalDate, '2026-10-08');
  assert.equal(result.candidate.date.localDate, '2026-10-02');
  assert.equal(result.candidate.items[0].load.state, 'missing');
  consumer.edit(d.setDraftLoad(result, result.candidate.items[0].id, { state: 'unknown', confirmed: true }));
  consumer.confirmReview(); await consumer.save();
  assert.equal(writes[0].items[0].sets, undefined);
  assert.equal(writes[0].date.localDate, '2026-10-02');
  await consumer.beginSpeech({ ...input, selectedDate: null }, 'en-US');
  speech.emit({ state: 'review', isFinal: true, text: 'Yesterday chest press 0 kg' });
  assert.throws(() => consumer.acceptTranscript('Yesterday chest press 0 kg'), /activity_catalog_unavailable/);
  await consumer.loadCatalog(); consumer.acceptTranscript('Yesterday chest press 0 kg');
  result = consumer.getState().draft.result;
  assert.equal(result.candidate.date.localDate, '2026-10-07');
  assert.equal(result.candidate.items[0].load.value, 0);
  assert.equal(writes.length, 1);
  await consumer.background();
  assert.equal(consumer.getState().draft.result, null);
  assert.equal(consumer.getState().catalog.status, 'idle');
  await consumer.dispose();
});

test('entry consumer fences out-of-order reads, background callbacks and invalidated session snapshots', async () => {
  const pending = [];
  const resources = new ActivityResources({ request: () => new Promise((resolve, reject) => pending.push({ resolve, reject })) });
  let current = true;
  const newSecureKey = () => 'command-key-0001';
  const controller = new d.DraftController('account-generation-1', resources, newSecureKey);
  const consumer = new ActivityEntryConsumer({ isCurrentSession: () => current,
    activity: { resources, controller, newSecureKey, sessionGeneration: 'account-generation-1' } });
  const first = consumer.loadEntries({ from: '2026-10-01', to: '2026-10-01' });
  const second = consumer.loadEntries({ from: '2026-10-02', to: '2026-10-02' });
  pending[1].resolve({ items: [], nextCursor: null }); await second;
  pending[0].resolve({ items: [entry(write())], nextCursor: null }); await first;
  assert.equal(consumer.getState().entries.value.items.length, 0);
  const edit = consumer.beginEntryEdit('entry-1'); await consumer.background();
  pending[2].resolve(entry(write())); await edit;
  assert.equal(consumer.getState().entry.status, 'idle');
  assert.equal(consumer.getState().draft.result, null);
  const list = consumer.loadEntries({ from: '2026-10-01', to: '2026-10-09' });
  current = false;
  assert.equal(consumer.getState().available, false);
  pending[3].resolve({ items: [entry(write())], nextCursor: null }); await list;
  assert.equal(consumer.getState().entries.status, 'idle');
  assert.throws(() => consumer.beginManual({ capturedAt: '2026-10-09T03:59:00Z', timeZone: 'America/New_York', selectedDate: null }, chest), /activity_session_unavailable/);
  await consumer.dispose();
});

test('entry consumer clears all read state on unauthorized or session_changed and blocks the old binding', async () => {
  for (const failure of [{ status: 401, code: 'unauthenticated' }, { status: 409, code: 'session_changed' }]) {
    let unauthorized = false;
    const resources = new ActivityResources({ request: async () => {
      if (unauthorized) throw failure;
      return { items: [chest], selectionUses: ['manual'] };
    } });
    const newSecureKey = () => 'command-key-0001';
    const controller = new d.DraftController('account-generation-1', resources, newSecureKey);
    const consumer = new ActivityEntryConsumer({ isCurrentSession: () => true,
      activity: { resources, controller, newSecureKey, sessionGeneration: 'account-generation-1' } });
    await consumer.loadCatalog(); unauthorized = true;
    await consumer.loadCalendar();
    assert.equal(consumer.getState().available, false);
    assert.deepEqual(consumer.getState().invalidation, failure);
    assert.equal(consumer.getState().catalog.status, 'idle');
    await assert.rejects(consumer.loadEntries({ from: '2026-10-01', to: '2026-10-09' }), /activity_session_unavailable/);
    await consumer.dispose();
  }
});

test('entry consumer preserves uncertain-write notice without old-account data and cannot cancel a refreshed generation', async () => {
  const resources = new ActivityResources({ request: async () => {
    throw { status: 409, code: 'session_changed', effectUnknown: false, originalEffectUnknown: true };
  } });
  const newSecureKey = () => 'command-key-0001';
  const controller = new d.DraftController('account-generation-1', resources, newSecureKey);
  const consumer = new ActivityEntryConsumer({ isCurrentSession: () => true,
    activity: { resources, controller, newSecureKey, sessionGeneration: 'account-generation-1' } });
  controller.beginManual(context(), chest); consumer.edit(manual()); await consumer.save();
  const state = consumer.getState();
  assert.deepEqual(state.invalidation, { status: 409, code: 'session_changed', originalEffectUnknown: true });
  assert.equal(state.draft.result, null); assert.equal(state.draft.pending, null);
  await controller.accountChanged('account-generation-2');
  controller.beginManual(context({ accountGeneration: 'account-generation-2' }), chest);
  await consumer.dispose();
  assert.equal(controller.getState().phase, 'structuredReview');
  assert.equal(controller.getState().accountGeneration, 'account-generation-2');
});

test('void intent requires fresh recorded entry and confirmation, then retries identical target revision and key', async () => {
  const recorded = { ...entry(write()), revision: 4 }, calls = [];
  recorded.items[0].snapshot.name = 'Retired historical exercise';
  const voided = { ...recorded, status: 'voided', revision: 5 };
  let attempts = 0, keys = 0;
  const resources = new ActivityResources({ request: async (path, method, payload, key) => {
    calls.push({ path, method, payload, key });
    if (method !== 'POST') return recorded;
    if (++attempts === 1) throw { status: 0, effectUnknown: true };
    return voided;
  } });
  const newSecureKey = () => `command-key-${++keys}-0000`;
  const controller = new d.DraftController('account-generation-1', resources, newSecureKey);
  const consumer = new ActivityEntryConsumer({ isCurrentSession: () => true,
    activity: { resources, controller, newSecureKey, sessionGeneration: 'account-generation-1' } });
  await assert.rejects(consumer.confirmVoid(), /explicit_void_confirmation_required/);
  await consumer.beginEntryEdit(recorded.id);
  await consumer.beginVoid(recorded.id);
  assert.equal(consumer.getState().voidIntent.phase, 'review');
  assert.equal(keys, 0); assert.equal(calls.filter(x => x.method === 'POST').length, 0);
  await consumer.confirmVoid();
  assert.equal(consumer.getState().voidIntent.phase, 'unknown');
  await assert.rejects(consumer.save(), /void_intent_in_progress/);
  await assert.rejects(consumer.beginEntryEdit(recorded.id), /void_intent_in_progress/);
  await assert.rejects(consumer.beginVoid(recorded.id), /void_intent_in_progress/);
  assert.throws(() => consumer.beginManual({ capturedAt: recorded.date.capturedAt, timeZone: recorded.date.timeZone, selectedDate: null }), /void_intent_in_progress/);
  consumer.getState().voidIntent.target.expectedRevision = 99;
  await consumer.retryVoid();
  const commands = calls.filter(x => x.method === 'POST');
  assert.deepEqual(commands[0], commands[1]);
  assert.equal(commands[0].path, '/v1/activity/entries/entry-1/void');
  assert.deepEqual(commands[0].payload, { expectedRevision: 4 });
  assert.equal(keys, 1);
  const state = consumer.getState();
  assert.equal(state.voidIntent.phase, 'voided');
  assert.deepEqual(state.voidIntent.entry.items, recorded.items);
  assert.equal(state.draft.result, null);
  for (const name of ['entry', 'entries', 'adherence']) assert.equal(state[name].status, 'idle');
  await consumer.dispose();
});

test('void stale revision requires an explicit fresh read and new confirmation; an already voided entry cannot start intent', async () => {
  let recorded = { ...entry(write()), revision: 1 }, keys = 0, posts = 0;
  const resources = new ActivityResources({ request: async (_path, method, payload) => {
    if (method !== 'POST') return recorded;
    posts++;
    if (posts === 1) { recorded = { ...recorded, revision: 2 }; throw { status: 409, code: 'stale_revision' }; }
    assert.equal(payload.expectedRevision, 2);
    return recorded = { ...recorded, revision: 3, status: 'voided' };
  } });
  const newSecureKey = () => `command-key-${++keys}-0000`;
  const controller = new d.DraftController('account-generation-1', resources, newSecureKey);
  const consumer = new ActivityEntryConsumer({ isCurrentSession: () => true,
    activity: { resources, controller, newSecureKey, sessionGeneration: 'account-generation-1' } });
  await consumer.beginVoid(recorded.id); await consumer.confirmVoid();
  assert.equal(consumer.getState().voidIntent.phase, 'stale');
  await assert.rejects(consumer.retryVoid(), /void_retry_unavailable/);
  await assert.rejects(consumer.confirmVoid(), /explicit_void_confirmation_required/);
  await consumer.beginVoid(recorded.id);
  assert.equal(consumer.getState().voidIntent.entry.revision, 2); assert.equal(posts, 1);
  await consumer.confirmVoid(); assert.equal(keys, 2);
  await consumer.beginVoid(recorded.id);
  assert.equal(consumer.getState().voidIntent.phase, 'rejected');
  await assert.rejects(consumer.confirmVoid(), /explicit_void_confirmation_required/);
  assert.equal(posts, 2);
  await consumer.dispose();
});

test('void background drops private data while preserving unknown command identity and ignoring its late result', async () => {
  const recorded = entry(write()), calls = [];
  let resolve;
  const resources = new ActivityResources({ request: async (path, method, payload, key) => {
    if (method !== 'POST') return recorded;
    calls.push({ path, payload, key });
    if (calls.length === 1) return new Promise(done => { resolve = done; });
    return { ...recorded, status: 'voided', revision: 2 };
  } });
  const newSecureKey = () => 'command-key-0001';
  const controller = new d.DraftController('account-generation-1', resources, newSecureKey);
  const consumer = new ActivityEntryConsumer({ isCurrentSession: () => true,
    activity: { resources, controller, newSecureKey, sessionGeneration: 'account-generation-1' } });
  await consumer.beginVoid(recorded.id); const pending = consumer.confirmVoid();
  assert.equal(consumer.getState().voidIntent.phase, 'saving');
  await consumer.background();
  assert.equal(consumer.getState().voidIntent.phase, 'unknown');
  assert.equal(consumer.getState().voidIntent.entry, undefined);
  assert.equal(consumer.getState().entry.status, 'idle');
  resolve({ ...recorded, status: 'voided', revision: 2 }); await pending;
  assert.equal(consumer.getState().voidIntent.phase, 'unknown');
  await consumer.retryVoid();
  assert.equal(consumer.getState().voidIntent.phase, 'voided');
  assert.deepEqual(calls[0], calls[1]);
  await consumer.dispose();
});

test('void session failure or disposal clears targets and prevents old-command retry without claiming rollback', async () => {
  for (const end of ['session_changed', 'dispose']) {
    const recorded = entry(write()); let reject;
    const resources = new ActivityResources({ request: async (_path, method) => {
      if (method !== 'POST') return recorded;
      return new Promise((_, fail) => { reject = fail; });
    } });
    const newSecureKey = () => 'command-key-0001';
    const controller = new d.DraftController('account-generation-1', resources, newSecureKey);
    const consumer = new ActivityEntryConsumer({ isCurrentSession: () => true,
      activity: { resources, controller, newSecureKey, sessionGeneration: 'account-generation-1' } });
    await consumer.beginVoid(recorded.id); const pending = consumer.confirmVoid();
    if (end === 'dispose') await consumer.dispose();
    reject({ status: 409, code: 'session_changed', effectUnknown: false, originalEffectUnknown: true }); await pending;
    const state = consumer.getState();
    assert.equal(state.available, false); assert.equal(state.invalidation.originalEffectUnknown, true);
    assert.equal(state.voidIntent.phase, 'idle'); assert.equal(state.entry.status, 'idle');
    await assert.rejects(consumer.retryVoid(), /activity_session_unavailable/);
    await consumer.dispose();
  }
});

test('void malformed success stays unknown rather than clearing a still recorded entry', async () => {
  const recorded = entry(write());
  const resources = new ActivityResources({ request: async () => recorded });
  const newSecureKey = () => 'command-key-0001';
  const controller = new d.DraftController('account-generation-1', resources, newSecureKey);
  const consumer = new ActivityEntryConsumer({ isCurrentSession: () => true,
    activity: { resources, controller, newSecureKey, sessionGeneration: 'account-generation-1' } });
  await consumer.beginVoid(recorded.id); await consumer.confirmVoid();
  assert.equal(consumer.getState().voidIntent.phase, 'unknown');
  assert.equal(consumer.getState().voidIntent.error.code, 'invalid_void_response');
  await consumer.dispose();
});

const scheduleInput = () => ({ effectiveFrom: '2026-10-09', week: Array.from({ length: 7 }, (_, i) => ({
  isoWeekday: i + 1, expectation: i === 0 ? 'workout' : 'rest', plan: null,
})) });
const scheduleResponse = payload => ({ id: 'schedule-1', revision: payload.expectedRevision + 1,
  timeZone: 'America/New_York', createdAt: '2026-10-09T04:00:00Z', effectiveFrom: payload.effectiveFrom,
  week: payload.week.map(day => ({ isoWeekday: day.isoWeekday, expectation: day.expectation,
    planSnapshot: day.plan === null ? null : { ...day.plan } })) });
function scheduleConsumer(request, isCurrentSession = () => true) {
  const resources = new ActivityResources({ request }); let keys = 0;
  const newSecureKey = () => `schedule-command-${++keys}`;
  const controller = new d.DraftController('account-generation-1', resources, newSecureKey);
  const consumer = new ActivityEntryConsumer({ isCurrentSession,
    activity: { resources, controller, newSecureKey, sessionGeneration: 'account-generation-1' } });
  return { consumer, controller, keys: () => keys };
}

test('schedule consumer confirms reviewed revision only and retries an immutable unknown command before invalidating old adherence reads', async () => {
  const calls = []; let resolveAdherence;
  const existing = scheduleResponse({ ...scheduleInput(), expectedRevision: 3 });
  const { consumer, keys } = scheduleConsumer(async (path, method, payload, key) => {
    if (path === '/v1/activity/calendar') return { timeZone: 'America/New_York' };
    if (path.startsWith('/v1/activity/adherence')) return new Promise(done => { resolveAdherence = done; });
    if (method !== 'POST') return existing;
    calls.push({ path, payload, key });
    if (calls.length === 1) throw { status: 0, effectUnknown: true };
    return scheduleResponse(payload);
  });
  await consumer.beginSchedule();
  await assert.rejects(consumer.confirmSchedule(), /explicit_schedule_confirmation_required/);
  const input = scheduleInput(); input.week[0].plan = { id: 'personal-plan', revision: 2 };
  consumer.reviewSchedule(input); input.week[0].plan.revision = 99;
  consumer.getState().scheduleIntent.write.week[0].expectation = 'rest';
  assert.equal(keys(), 0); assert.equal(calls.length, 0);
  await consumer.confirmSchedule();
  assert.equal(consumer.getState().scheduleIntent.phase, 'unknown');
  assert.equal(calls[0].payload.expectedRevision, 4); assert.equal(calls[0].payload.week[0].plan.revision, 2);
  await assert.rejects(consumer.beginSchedule(), /schedule_intent_in_progress/);
  assert.throws(() => consumer.reviewSchedule(scheduleInput()), /schedule_review_unavailable/);
  await assert.rejects(consumer.beginVoid('entry-1'), /schedule_intent_in_progress/);
  await assert.rejects(consumer.beginEntryEdit('entry-1'), /schedule_intent_in_progress/);
  assert.throws(() => consumer.beginManual(context(), chest), /schedule_intent_in_progress/);
  await assert.rejects(consumer.beginSpeech(context(), 'en-US'), /schedule_intent_in_progress/);
  assert.throws(() => consumer.edit(manual()), /schedule_intent_in_progress/);
  assert.throws(() => consumer.confirmReview(), /schedule_intent_in_progress/);
  await assert.rejects(consumer.save(), /schedule_intent_in_progress/);
  await assert.rejects(consumer.retryUnknown(), /schedule_intent_in_progress/);
  const oldRead = consumer.loadAdherence('2026-10-01', '2026-10-09');
  await consumer.retrySchedule();
  assert.deepEqual(calls[0], calls[1]); assert.equal(keys(), 1);
  assert.equal(consumer.getState().scheduleIntent.phase, 'saved');
  assert.equal(consumer.getState().schedule.value.revision, 5);
  resolveAdherence({ currentPlanDays: 999 }); await oldRead;
  assert.equal(consumer.getState().adherence.status, 'idle');
  await consumer.dispose();
});

test('schedule consumer distinguishes absent calendar and failed reads from an authoritative first schedule', async () => {
  let mode = 'no-calendar'; const posts = [];
  const { consumer } = scheduleConsumer(async (path, method, payload) => {
    if (path === '/v1/activity/calendar') {
      if (mode === 'calendar-error') throw { status: 503, code: 'calendar_offline' };
      return mode === 'no-calendar' ? null : { timeZone: 'America/New_York' };
    }
    if (method === 'POST') { posts.push(payload); return scheduleResponse(payload); }
    if (mode === 'schedule-error') throw { status: 503, code: 'schedule_offline' };
    return null;
  });
  for (const value of ['no-calendar', 'calendar-error', 'schedule-error']) {
    mode = value; await consumer.beginSchedule();
    assert.equal(consumer.getState().scheduleIntent.phase, 'rejected');
    assert.throws(() => consumer.reviewSchedule(scheduleInput()), /schedule_review_unavailable/);
    await assert.rejects(consumer.confirmSchedule(), /explicit_schedule_confirmation_required/);
    if (value === 'no-calendar') assert.deepEqual(consumer.getState().calendar, { status: 'ready', value: null });
    else assert.equal(consumer.getState()[value === 'calendar-error' ? 'calendar' : 'schedule'].status, 'unavailable');
  }
  assert.equal(posts.length, 0);
  mode = 'ready'; await consumer.beginSchedule();
  assert.deepEqual(consumer.getState().schedule, { status: 'ready', value: null });
  assert.throws(() => consumer.reviewSchedule({ ...scheduleInput(), transcript: 'must not persist' }), d.ActivityValidationError);
  consumer.reviewSchedule(scheduleInput()); await consumer.confirmSchedule();
  assert.equal(posts[0].expectedRevision, 0); assert.equal(consumer.getState().scheduleIntent.phase, 'saved');
  await consumer.dispose();
});

test('schedule consumer requires a fresh read and review after known conflict or prospective-date rejection', async () => {
  for (const failure of [{ status: 409, code: 'stale_revision' }, { status: 422, code: 'schedule_must_be_prospective' }]) {
    const posts = []; let current = null;
    const { consumer, keys } = scheduleConsumer(async (path, method, payload, key) => {
      if (path === '/v1/activity/calendar') return { timeZone: 'America/New_York' };
      if (method !== 'POST') return current;
      posts.push({ payload, key });
      if (posts.length === 1) { current = scheduleResponse(payload); throw failure; }
      return scheduleResponse(payload);
    });
    await consumer.beginSchedule(); consumer.reviewSchedule(scheduleInput()); await consumer.confirmSchedule();
    assert.equal(consumer.getState().scheduleIntent.phase, failure.status === 409 ? 'stale' : 'rejected');
    assert.equal(consumer.getState().schedule.status, 'idle');
    await assert.rejects(consumer.retrySchedule(), /schedule_retry_unavailable/);
    assert.throws(() => consumer.reviewSchedule(scheduleInput()), /schedule_review_unavailable/);
    await consumer.beginSchedule();
    await assert.rejects(consumer.confirmSchedule(), /explicit_schedule_confirmation_required/);
    consumer.reviewSchedule({ ...scheduleInput(), effectiveFrom: '2026-10-10' }); await consumer.confirmSchedule();
    assert.equal(posts[1].payload.expectedRevision, 1); assert.equal(posts[1].payload.effectiveFrom, '2026-10-10');
    assert.notEqual(posts[0].key, posts[1].key); assert.equal(keys(), 2);
    await consumer.dispose();
  }
});

test('schedule background hides reviewed week, ignores late success and retains only the exact retry command', async () => {
  let finish; const calls = [];
  const { consumer } = scheduleConsumer(async (path, method, payload, key) => {
    if (path === '/v1/activity/calendar') return { timeZone: 'America/New_York' };
    if (method !== 'POST') return null;
    calls.push({ payload, key });
    if (calls.length === 1) return new Promise(done => { finish = done; });
    return scheduleResponse(payload);
  });
  await consumer.beginSchedule(); consumer.reviewSchedule(scheduleInput()); const pending = consumer.confirmSchedule();
  await consumer.background();
  assert.equal(consumer.getState().scheduleIntent.phase, 'unknown');
  assert.equal(consumer.getState().scheduleIntent.write, undefined); assert.equal(consumer.getState().schedule.status, 'idle');
  finish(scheduleResponse(calls[0].payload)); await pending;
  assert.equal(consumer.getState().scheduleIntent.phase, 'unknown');
  await consumer.retrySchedule(); assert.deepEqual(calls[0], calls[1]);
  assert.equal(consumer.getState().scheduleIntent.phase, 'saved');
  await consumer.dispose();
});

test('schedule session change and disposal purge account commands and fence late outcomes', async () => {
  for (const end of ['session_changed', 'dispose', 'currentness']) {
    let reject, current = true;
    const { consumer } = scheduleConsumer(async (path, method) => {
      if (path === '/v1/activity/calendar') return { timeZone: 'America/New_York' };
      if (method !== 'POST') return null;
      return new Promise((_, fail) => { reject = fail; });
    }, () => current);
    await consumer.beginSchedule(); consumer.reviewSchedule(scheduleInput()); const pending = consumer.confirmSchedule();
    if (end === 'dispose') await consumer.dispose();
    if (end === 'currentness') { current = false; consumer.getState(); }
    reject({ status: 409, code: 'session_changed', originalEffectUnknown: true }); await pending;
    const state = consumer.getState();
    assert.equal(state.available, false); assert.equal(state.invalidation.originalEffectUnknown, true);
    assert.equal(state.schedule.status, 'idle'); assert.equal(state.scheduleIntent.phase, 'idle');
    await assert.rejects(consumer.retrySchedule(), /activity_session_unavailable/);
    await consumer.dispose();
  }
});

test('schedule consumer fences cancelled setup reads and cannot replace an active void or entry command', async () => {
  let finishCalendar;
  const { consumer, controller } = scheduleConsumer(async (path, method) => {
    if (path === '/v1/activity/calendar') return new Promise(done => { finishCalendar = done; });
    if (method === 'POST') throw { status: 0, effectUnknown: true };
    return entry(write());
  });
  const loading = consumer.beginSchedule(); await consumer.cancel();
  finishCalendar({ timeZone: 'America/New_York' }); await loading;
  assert.equal(consumer.getState().scheduleIntent.phase, 'idle'); assert.equal(consumer.getState().calendar.status, 'idle');
  await consumer.beginVoid('entry-1'); await assert.rejects(consumer.beginSchedule(), /void_intent_in_progress/);
  await consumer.cancel();
  controller.beginManual(context(), chest); consumer.edit(manual()); await consumer.save();
  assert.equal(consumer.getState().draft.phase, 'unknown');
  await assert.rejects(consumer.beginSchedule(), /capture_unavailable/);
  await consumer.dispose();
});

test('schedule mismatched success remains unknown and cannot authorize a replacement', async () => {
  const calls = [];
  const { consumer } = scheduleConsumer(async (path, method, payload, key) => {
    if (path === '/v1/activity/calendar') return { timeZone: 'America/New_York' };
    if (method !== 'POST') return null;
    calls.push({ payload, key });
    return calls.length === 1 ? { ...scheduleResponse(payload), effectiveFrom: '2026-10-10' } : scheduleResponse(payload);
  });
  await consumer.beginSchedule(); consumer.reviewSchedule(scheduleInput()); await consumer.confirmSchedule();
  assert.equal(consumer.getState().scheduleIntent.phase, 'unknown');
  assert.equal(consumer.getState().scheduleIntent.error.code, 'invalid_schedule_response');
  await assert.rejects(consumer.beginSchedule(), /schedule_intent_in_progress/);
  await consumer.retrySchedule(); assert.deepEqual(calls[0], calls[1]);
  await consumer.dispose();
});

const personalFields = () => ({ name: 'Seated squeeze', description: 'My movement', movement: null,
  measurementType: 'repetitions', kind: 'resistance', loadApplicability: 'applicable', loadLabel: 'Weight' });
const personalResponse = fields => ({ ...fields, id: 'personal-1', revision: 1, retired: false,
  createdAt: '2026-10-09T04:00:00Z', updatedAt: '2026-10-09T04:00:00Z' });
const personalCatalogItem = () => ({ ...personalFields(), ref: { source: 'personal', id: 'personal-1', revision: 1 },
  guidance: 'userDefinedUnassessed', cueStatus: 'unknown', safetyAssessment: 'notEstablished' });
function personalConsumer(request, speech, isCurrentSession = () => true) {
  const resources = new ActivityResources({ request }); let keys = 0;
  const newSecureKey = () => `personal-command-${++keys}`;
  const controller = new d.DraftController('account-generation-1', resources, newSecureKey, speech);
  const consumer = new ActivityEntryConsumer({ isCurrentSession,
    activity: { resources, controller, newSecureKey, sessionGeneration: 'account-generation-1' } });
  return { consumer, controller, keys: () => keys };
}

test('personal create requires full reviewed fields and leaves speech custom selection explicit with other issues intact', async () => {
  const speech = speechPort(), posts = []; let created = false, allowSpeech = false;
  const { consumer, keys } = personalConsumer(async (path, method, fields) => {
    if (path === '/v1/activity/calendar') return configuredCalendar();
    if (path === '/v1/activity/catalog') return { items: created ? [personalCatalogItem()] : [], selectionUses: allowSpeech ? ['manual', 'nativeSpeech'] : ['manual'] };
    assert.equal(path, '/v1/activity/exercises'); assert.equal(method, 'POST'); posts.push(fields); created = true;
    return personalResponse(fields);
  }, speech);
  await consumer.loadCalendar(); await consumer.loadCatalog();
  await consumer.beginSpeech({ capturedAt: '2026-10-09T03:59:00Z', timeZone: 'America/New_York', selectedDate: '2026-10-05' }, 'en-US');
  const text = 'Yesterday I did exercise called Seated squeeze for 3 sets then exercise called Ankle circles for 2 sets';
  speech.emit({ state: 'review', isFinal: true, text }); consumer.acceptTranscript(text);
  const before = consumer.getState().draft.result, itemId = before.candidate.items[0].id;
  assert.equal(before.candidate.items[0].exercise.state, 'custom');
  assert.ok(before.issues.some(issue => issue.code === 'dateConflict'));
  assert.ok(before.issues.some(issue => issue.code === 'loadMissing'));
  const priorKeys = keys();
  assert.throws(() => consumer.reviewPersonalExercise({ name: 'Seated squeeze' }), d.ActivityValidationError);
  await assert.rejects(consumer.confirmPersonalExercise(), /explicit_personal_create_confirmation_required/);
  const fields = personalFields(); consumer.reviewPersonalExercise(fields); fields.name = 'Mutated input';
  assert.equal(posts.length, 0); assert.equal(keys(), priorKeys);
  await consumer.confirmPersonalExercise();
  assert.deepEqual(posts[0], personalFields()); assert.equal(keys(), priorKeys + 1);
  assert.deepEqual(consumer.getState().draft.result, before);
  assert.throws(() => consumer.selectCatalogExercise(itemId, personalCatalogItem().ref), /activity_catalog_unavailable/);
  await consumer.loadCatalog();
  assert.throws(() => consumer.selectCatalogExercise(itemId, personalCatalogItem().ref), /catalog_selection_unavailable/);
  allowSpeech = true; await consumer.loadCatalog(); consumer.selectCatalogExercise(itemId, personalCatalogItem().ref);
  const selected = consumer.getState().draft.result;
  assert.deepEqual(selected.context, before.context); assert.deepEqual(selected.candidate.date, before.candidate.date);
  assert.deepEqual(selected.candidate.items[0].exercise.snapshot, personalCatalogItem());
  const { exercise: oldExercise, ...observations } = before.candidate.items[0];
  const { exercise: newExercise, ...selectedObservations } = selected.candidate.items[0];
  assert.deepEqual(selectedObservations, observations); assert.equal(selected.candidate.performedConfirmed, false);
  for (const issue of before.issues) {
    const after = selected.issues.find(value => value.id === issue.id);
    if (issue.fieldPath === 'items.0.exercise' && issue.code === 'customExercise') assert.deepEqual(after.resolution, { kind: 'edited' });
    else assert.deepEqual(after, issue);
  }
  assert.equal(selected.candidate.items[1].exercise.state, 'custom');
  await assert.rejects(consumer.save(), d.ActivityValidationError); assert.equal(posts.length, 1);
  await consumer.dispose();
});

test('personal create invalidates old catalog reads and requires available exact refreshed identity before selection', async () => {
  let finishOld, catalogMode = 'old'; const writes = [];
  const { consumer } = personalConsumer(async (path, _method, fields) => {
    if (path === '/v1/activity/calendar') return configuredCalendar();
    if (path === '/v1/activity/entries') {
      writes.push(fields); return { ...entry(fields), items: fields.items.map(item => ({ ...item, snapshot: personalCatalogItem() })) };
    }
    if (path !== '/v1/activity/catalog') return personalResponse(fields);
    if (catalogMode === 'old') return new Promise(done => { finishOld = done; });
    if (catalogMode === 'error') throw { status: 503, code: 'catalog_offline' };
    return { items: catalogMode === 'empty' ? [] : [personalCatalogItem()], selectionUses: catalogMode === 'ineligible' ? ['nativeSpeech'] : ['manual'] };
  });
  await consumer.loadCalendar();
  consumer.beginManual({ capturedAt: '2026-10-09T03:59:00Z', timeZone: 'America/New_York', selectedDate: null });
  const itemId = consumer.getState().draft.result.candidate.items[0].id;
  const oldRead = consumer.loadCatalog(); consumer.reviewPersonalExercise(personalFields()); await consumer.confirmPersonalExercise();
  finishOld({ items: [personalCatalogItem()], selectionUses: ['manual'] }); await oldRead;
  assert.equal(consumer.getState().catalog.status, 'idle');
  catalogMode = 'error'; await consumer.loadCatalog();
  assert.throws(() => consumer.selectCatalogExercise(itemId, personalCatalogItem().ref), /activity_catalog_unavailable/);
  catalogMode = 'empty'; await consumer.loadCatalog();
  assert.throws(() => consumer.selectCatalogExercise(itemId, personalCatalogItem().ref), /catalog_exercise_unavailable/);
  catalogMode = 'ineligible'; await consumer.loadCatalog();
  assert.throws(() => consumer.selectCatalogExercise(itemId, personalCatalogItem().ref), /catalog_selection_unavailable/);
  catalogMode = 'ready'; await consumer.loadCatalog();
  assert.throws(() => consumer.selectCatalogExercise(itemId, { source: 'personal', id: 'personal-1', revision: 2 }), /catalog_exercise_unavailable/);
  assert.throws(() => consumer.selectCatalogExercise('absent-item', personalCatalogItem().ref), /draft_item_unavailable/);
  consumer.selectCatalogExercise(itemId, personalCatalogItem().ref);
  assert.equal(consumer.getState().draft.result.candidate.items[0].exercise.ref.revision, 1);
  consumer.edit(d.confirmUnknownMissingLoads(consumer.getState().draft.result)); consumer.confirmReview(); await consumer.save();
  assert.equal(consumer.getState().draft.phase, 'saved');
  assert.deepEqual(writes[0].items[0].exercise, personalCatalogItem().ref);
  assert.deepEqual(writes[0].items[0].load, { state: 'unknown', confirmed: true });
  assert.equal(writes[0].items[0].exercise.fields, undefined);
  await consumer.dispose();
});

test('personal create unknown command blocks competing intents and survives background with exact private retry', async () => {
  const calls = []; let finish;
  const { consumer, keys } = personalConsumer(async (_path, _method, fields, key) => {
    calls.push({ fields, key });
    if (calls.length === 1) return new Promise(done => { finish = done; });
    return personalResponse(fields);
  });
  consumer.reviewPersonalExercise(personalFields()); const pending = consumer.confirmPersonalExercise();
  assert.throws(() => consumer.reviewPersonalExercise(personalFields()), /personal_create_in_progress/);
  await assert.rejects(consumer.beginSchedule(), /personal_create_in_progress/);
  await assert.rejects(consumer.beginVoid('entry-1'), /personal_create_in_progress/);
  await assert.rejects(consumer.beginEntryEdit('entry-1'), /personal_create_in_progress/);
  assert.throws(() => consumer.beginManual(context()), /personal_create_in_progress/);
  await assert.rejects(consumer.beginSpeech(context(), 'en-US'), /personal_create_in_progress/);
  await assert.rejects(consumer.save(), /personal_create_in_progress/);
  await assert.rejects(consumer.retryUnknown(), /personal_create_in_progress/);
  assert.throws(() => consumer.selectCatalogExercise('item', personalCatalogItem().ref), /personal_create_in_progress/);
  await consumer.background();
  let state = consumer.getState();
  assert.equal(state.personalCreateIntent.phase, 'unknown'); assert.equal(state.personalCreateIntent.fields, undefined);
  assert.equal(state.draft.result, null); assert.equal(state.catalog.status, 'idle');
  finish(personalResponse(calls[0].fields)); await pending;
  assert.equal(consumer.getState().personalCreateIntent.phase, 'unknown');
  assert.throws(() => consumer.reviewPersonalExercise(personalFields()), /personal_create_in_progress/);
  await consumer.retryPersonalExercise();
  assert.deepEqual(calls[0], calls[1]); assert.equal(keys(), 1);
  assert.equal(consumer.getState().personalCreateIntent.phase, 'created');
  await consumer.dispose();
});

test('personal create session invalidation and disposal purge fields and prevent late outcome reuse', async () => {
  for (const end of ['session_changed', 'dispose', 'currentness']) {
    let reject, current = true;
    const { consumer } = personalConsumer(() => new Promise((_, fail) => { reject = fail; }), undefined, () => current);
    consumer.reviewPersonalExercise(personalFields()); const pending = consumer.confirmPersonalExercise();
    if (end === 'dispose') await consumer.dispose();
    if (end === 'currentness') { current = false; consumer.getState(); }
    reject({ status: 409, code: 'session_changed', originalEffectUnknown: true }); await pending;
    const state = consumer.getState();
    assert.equal(state.available, false); assert.equal(state.invalidation.originalEffectUnknown, true);
    assert.equal(state.personalCreateIntent.phase, 'idle'); assert.equal(state.catalog.status, 'idle');
    await assert.rejects(consumer.retryPersonalExercise(), /activity_session_unavailable/);
    await consumer.dispose();
  }
});

test('personal create distinguishes known rejection from mismatched success and preserves the unknown payload', async () => {
  for (const failure of ['known', 'malformed', 'network']) {
    const calls = [];
    const { consumer, keys } = personalConsumer(async (_path, _method, fields, key) => {
      calls.push({ fields, key });
      if (calls.length === 1) {
        if (failure === 'known') throw { status: 422, code: 'invalid_request' };
        if (failure === 'network') throw { status: 0, effectUnknown: true };
        return { ...personalResponse(fields), name: 'Unreviewed response' };
      }
      return personalResponse(fields);
    });
    consumer.reviewPersonalExercise(personalFields()); await consumer.confirmPersonalExercise();
    if (failure === 'known') {
      assert.equal(consumer.getState().personalCreateIntent.phase, 'rejected');
      await assert.rejects(consumer.retryPersonalExercise(), /personal_create_retry_unavailable/);
      consumer.reviewPersonalExercise(personalFields()); await consumer.confirmPersonalExercise();
      assert.equal(keys(), 2); assert.notEqual(calls[0].key, calls[1].key);
    } else {
      assert.equal(consumer.getState().personalCreateIntent.phase, 'unknown');
      await consumer.retryPersonalExercise(); assert.equal(keys(), 1); assert.deepEqual(calls[0], calls[1]);
    }
    await consumer.dispose();
  }
});

test('personal catalog selection preserves historical same-reference snapshot and gives recorded replacements a fresh identity', async () => {
  const recorded = entry(write()); recorded.items[0].snapshot.name = 'Historical name';
  const { consumer } = personalConsumer(async path => path === '/v1/activity/catalog'
    ? { items: [chest, personalCatalogItem()], selectionUses: ['manual'] } : recorded);
  await consumer.beginEntryEdit(recorded.id); await consumer.loadCatalog();
  const before = consumer.getState().draft.result, original = before.candidate.items[0];
  consumer.selectCatalogExercise(original.id, chest.ref);
  assert.deepEqual(consumer.getState().draft.result.candidate.items[0], original);
  consumer.selectCatalogExercise(original.id, personalCatalogItem().ref);
  const after = consumer.getState().draft.result, replacement = after.candidate.items[0];
  assert.notEqual(replacement.id, original.id); assert.deepEqual(replacement.exercise.snapshot, personalCatalogItem());
  assert.deepEqual(replacement.load, { state: 'missing' }); assert.equal(replacement.sets, undefined);
  assert.deepEqual(after.context, before.context); assert.deepEqual(after.candidate.date, before.candidate.date);
  assert.equal(after.candidate.performedConfirmed, false);
  assert.equal(recorded.items[0].snapshot.name, 'Historical name');
  await consumer.dispose();
});

test('personal create review cannot replace an active schedule, void, or unknown entry command', async () => {
  const { consumer, controller } = personalConsumer(async (path, method) => {
    if (path === '/v1/activity/calendar') return { timeZone: 'America/New_York' };
    if (path === '/v1/activity/schedule') return null;
    if (method === 'POST') throw { status: 0, effectUnknown: true };
    return entry(write());
  });
  await consumer.beginSchedule();
  assert.throws(() => consumer.reviewPersonalExercise(personalFields()), /schedule_intent_in_progress/);
  await consumer.cancel(); await consumer.beginVoid('entry-1');
  assert.throws(() => consumer.reviewPersonalExercise(personalFields()), /void_intent_in_progress/);
  await consumer.cancel(); controller.beginManual(context(), chest); consumer.edit(manual()); await consumer.save();
  assert.throws(() => consumer.reviewPersonalExercise(personalFields()), /capture_unavailable/);
  await consumer.dispose();
});

test('personal lifecycle edits only a fresh detail revision after full field review and preserves historical drafts', async () => {
  const calls = [], recorded = entry(write()); recorded.items[0].snapshot.name = 'Historical exercise';
  const detail = { ...personalResponse(personalFields()), revision: 4 };
  const { consumer, keys } = personalConsumer(async (path, method, payload, key) => {
    calls.push({ path, method, payload, key });
    if (path.startsWith('/v1/activity/entries/')) return recorded;
    if (path.includes('?')) return { items: [{ ...detail, revision: 1 }], nextCursor: 'next-owner-page' };
    if (method !== 'PATCH') return detail;
    const { expectedRevision, ...fields } = payload;
    return { ...detail, ...fields, revision: expectedRevision + 1 };
  });
  await consumer.beginEntryEdit(recorded.id); const draft = consumer.getState().draft;
  await consumer.loadPersonalExercises({ retired: 'true', limit: 2 });
  assert.equal(calls.at(-1).path, '/v1/activity/exercises?limit=2&retired=true');
  assert.equal(consumer.getState().personalExercises.value.nextCursor, 'next-owner-page');
  await consumer.beginPersonalExerciseEdit(detail.id);
  assert.equal(consumer.getState().personalChangeIntent.exercise.revision, 4);
  await assert.rejects(consumer.confirmPersonalExerciseChange(), /explicit_personal_change_confirmation_required/);
  assert.throws(() => consumer.reviewPersonalExerciseEdit({ name: 'Incomplete' }), d.ActivityValidationError);
  const fields = { ...personalFields(), name: 'Reviewed new name' };
  consumer.reviewPersonalExerciseEdit(fields); fields.name = 'Mutated input';
  consumer.getState().personalChangeIntent.fields.name = 'Mutated snapshot';
  assert.equal(keys(), 0); await consumer.confirmPersonalExerciseChange();
  assert.equal(calls.at(-1).payload.expectedRevision, 4); assert.equal(calls.at(-1).payload.name, 'Reviewed new name');
  assert.equal(keys(), 1); assert.equal(consumer.getState().personalExercise.value.revision, 5);
  assert.equal(consumer.getState().personalExercises.status, 'idle'); assert.equal(consumer.getState().catalog.status, 'idle');
  assert.deepEqual(consumer.getState().draft, draft); assert.equal(recorded.items[0].snapshot.name, 'Historical exercise');
  await consumer.dispose();
});

test('personal lifecycle retirement invalidates late catalog, list and detail reads without rewriting a recorded snapshot', async () => {
  const active = personalResponse(personalFields()), retired = { ...active, revision: 2, retired: true };
  const recorded = entry(write()); recorded.items[0] = { ...recorded.items[0], exercise: personalCatalogItem().ref, snapshot: personalCatalogItem() };
  let delayReads = false, finished = false; const deferred = [], posts = [];
  const { consumer } = personalConsumer(async (path, method, payload, key) => {
    if (path.startsWith('/v1/activity/entries/')) return recorded;
    if (method === 'POST') { posts.push({ path, payload, key }); finished = true; return retired; }
    if (delayReads && !finished) return new Promise(done => { deferred.push({ path, done }); });
    if (path === '/v1/activity/catalog') return { items: finished ? [] : [personalCatalogItem()], selectionUses: ['manual'] };
    return active;
  });
  await consumer.beginEntryEdit(recorded.id); const before = consumer.getState().draft;
  await consumer.beginPersonalExerciseRetirement(active.id); assert.equal(posts.length, 0);
  delayReads = true;
  const reads = [consumer.loadCatalog(), consumer.loadPersonalExercises(), consumer.loadPersonalExercise(active.id)];
  await consumer.confirmPersonalExerciseChange();
  assert.deepEqual(posts[0].payload, { expectedRevision: 1 }); assert.equal(posts[0].path, '/v1/activity/exercises/personal-1/retire');
  for (const { path, done } of deferred) done(path === '/v1/activity/catalog' ? { items: [personalCatalogItem()], selectionUses: ['manual'] }
    : path === '/v1/activity/exercises' ? { items: [active], nextCursor: null } : active);
  await Promise.all(reads);
  assert.equal(consumer.getState().personalExercise.value.retired, true);
  assert.equal(consumer.getState().personalExercises.status, 'idle'); assert.equal(consumer.getState().catalog.status, 'idle');
  assert.deepEqual(consumer.getState().draft, before);
  await consumer.loadCatalog();
  assert.throws(() => consumer.selectCatalogExercise(recorded.items[0].id, personalCatalogItem().ref), /catalog_exercise_unavailable/);
  assert.deepEqual(consumer.getState().draft, before);
  await consumer.dispose();
});

test('personal lifecycle unknown edit and retire retry identical operation target revision payload and key', async () => {
  for (const operation of ['edit', 'retire']) {
    const active = { ...personalResponse(personalFields()), revision: 7 }, calls = [];
    const { consumer, keys } = personalConsumer(async (path, method, payload, key) => {
      if (!method) return active;
      calls.push({ path, method, payload, key });
      if (calls.length === 1) throw { status: 0, effectUnknown: true };
      const { expectedRevision, ...fields } = payload;
      return { ...active, ...(operation === 'edit' ? fields : {}), revision: expectedRevision + 1, retired: operation === 'retire' };
    });
    if (operation === 'edit') { await consumer.beginPersonalExerciseEdit(active.id); consumer.reviewPersonalExerciseEdit(personalFields()); }
    else await consumer.beginPersonalExerciseRetirement(active.id);
    await consumer.confirmPersonalExerciseChange(); assert.equal(consumer.getState().personalChangeIntent.phase, 'unknown');
    await assert.rejects(consumer.beginPersonalExerciseEdit(active.id), /personal_change_in_progress/);
    await assert.rejects(consumer.beginPersonalExerciseRetirement(active.id), /personal_change_in_progress/);
    assert.throws(() => consumer.reviewPersonalExercise(personalFields()), /personal_change_in_progress/);
    await assert.rejects(consumer.beginSchedule(), /personal_change_in_progress/);
    await assert.rejects(consumer.beginVoid('entry-1'), /personal_change_in_progress/);
    await assert.rejects(consumer.beginEntryEdit('entry-1'), /personal_change_in_progress/);
    assert.throws(() => consumer.beginManual(context()), /personal_change_in_progress/);
    await assert.rejects(consumer.save(), /personal_change_in_progress/);
    await assert.rejects(consumer.retryUnknown(), /personal_change_in_progress/);
    await consumer.retryPersonalExerciseChange();
    assert.deepEqual(calls[0], calls[1]); assert.equal(calls[1].payload.expectedRevision, 7); assert.equal(keys(), 1);
    assert.equal(consumer.getState().personalChangeIntent.phase, 'saved');
    await consumer.dispose();
  }
});

test('personal lifecycle distinguishes failed and empty reads, includes retired detail, and rereads conflicts before review', async () => {
  let mode = 'unavailable', revision = 2, posts = 0;
  const { consumer, keys } = personalConsumer(async (path, method, payload) => {
    if (mode === 'unavailable') throw { status: 503, code: 'offline' };
    if (path === '/v1/activity/exercises') return { items: [], nextCursor: null };
    if (!method) return { ...personalResponse(personalFields()), revision, retired: mode === 'retired' };
    if (++posts === 1) { revision = 3; throw { status: 409, code: 'stale_revision' }; }
    const { expectedRevision, ...fields } = payload;
    return { ...personalResponse(fields), revision: expectedRevision + 1 };
  });
  await consumer.loadPersonalExercises(); assert.equal(consumer.getState().personalExercises.status, 'unavailable');
  await consumer.beginPersonalExerciseEdit('personal-1'); assert.equal(consumer.getState().personalExercise.status, 'unavailable');
  await assert.rejects(consumer.confirmPersonalExerciseChange(), /explicit_personal_change_confirmation_required/);
  mode = 'retired'; await consumer.loadPersonalExercises(); assert.deepEqual(consumer.getState().personalExercises.value.items, []);
  for (const begin of ['beginPersonalExerciseEdit', 'beginPersonalExerciseRetirement']) {
    await consumer[begin]('personal-1'); assert.equal(consumer.getState().personalExercise.value.retired, true);
    assert.equal(consumer.getState().personalChangeIntent.error.code, 'exercise_retired');
    await assert.rejects(consumer.confirmPersonalExerciseChange(), /explicit_personal_change_confirmation_required/);
  }
  assert.equal(keys(), 0); mode = 'active';
  await consumer.beginPersonalExerciseEdit('personal-1'); consumer.reviewPersonalExerciseEdit(personalFields()); await consumer.confirmPersonalExerciseChange();
  assert.equal(consumer.getState().personalChangeIntent.phase, 'stale');
  await assert.rejects(consumer.retryPersonalExerciseChange(), /personal_change_retry_unavailable/);
  assert.throws(() => consumer.reviewPersonalExerciseEdit(personalFields()), /personal_edit_review_unavailable/);
  await consumer.beginPersonalExerciseEdit('personal-1');
  assert.equal(consumer.getState().personalChangeIntent.exercise.revision, 3);
  await assert.rejects(consumer.confirmPersonalExerciseChange(), /explicit_personal_change_confirmation_required/);
  consumer.reviewPersonalExerciseEdit(personalFields()); await consumer.confirmPersonalExerciseChange();
  assert.equal(consumer.getState().personalExercise.value.revision, 4); assert.equal(keys(), 2);
  await consumer.dispose();
});

test('personal lifecycle background clears private data while retaining an exact retry and ignoring late success', async () => {
  const active = personalResponse(personalFields()), calls = []; let finish;
  const { consumer } = personalConsumer(async (path, method, payload, key) => {
    if (!method) return active;
    calls.push({ path, method, payload, key });
    if (calls.length === 1) return new Promise(done => { finish = done; });
    return { ...active, revision: 2, retired: true };
  });
  await consumer.beginPersonalExerciseRetirement(active.id); const pending = consumer.confirmPersonalExerciseChange();
  await consumer.background();
  assert.equal(consumer.getState().personalExercise.status, 'idle'); assert.equal(consumer.getState().personalChangeIntent.phase, 'unknown');
  assert.equal(consumer.getState().personalChangeIntent.exercise, undefined); assert.equal(consumer.getState().personalChangeIntent.fields, undefined);
  finish({ ...active, revision: 2, retired: true }); await pending;
  assert.equal(consumer.getState().personalChangeIntent.phase, 'unknown');
  await consumer.retryPersonalExerciseChange(); assert.deepEqual(calls[0], calls[1]);
  await consumer.dispose();
});

test('personal lifecycle session failure and disposal purge commands and fence late detail reads', async () => {
  for (const end of ['session_changed', 'dispose', 'currentness']) {
    let reject, current = true;
    const { consumer } = personalConsumer(async (_path, method) => !method ? personalResponse(personalFields())
      : new Promise((_, fail) => { reject = fail; }), undefined, () => current);
    await consumer.beginPersonalExerciseEdit('personal-1'); consumer.reviewPersonalExerciseEdit(personalFields());
    const pending = consumer.confirmPersonalExerciseChange();
    if (end === 'dispose') await consumer.dispose();
    if (end === 'currentness') { current = false; consumer.getState(); }
    reject({ status: 401, code: 'session_changed', originalEffectUnknown: true }); await pending;
    assert.equal(consumer.getState().available, false); assert.equal(consumer.getState().invalidation.originalEffectUnknown, true);
    assert.equal(consumer.getState().personalExercise.status, 'idle'); assert.equal(consumer.getState().personalChangeIntent.phase, 'idle');
    await assert.rejects(consumer.retryPersonalExerciseChange(), /activity_session_unavailable/); await consumer.dispose();
  }
  let finish;
  const { consumer } = personalConsumer(() => new Promise(done => { finish = done; }));
  const reading = consumer.beginPersonalExerciseEdit('personal-1'); await consumer.cancel();
  finish(personalResponse(personalFields())); await reading;
  assert.equal(consumer.getState().personalExercise.status, 'idle'); assert.equal(consumer.getState().personalChangeIntent.phase, 'idle');
  await consumer.dispose();
});

test('personal lifecycle malformed mutation responses retain unknown and confirmed creation invalidates the personal list', async () => {
  for (const change of [{ id: 'another-exercise' }, { revision: 1 }, { retired: true }, { name: 'Unreviewed' }]) {
    const { consumer } = personalConsumer(async (_path, method) => method ? { ...personalResponse(personalFields()), revision: 2, ...change }
      : personalResponse(personalFields()));
    await consumer.beginPersonalExerciseEdit('personal-1'); consumer.reviewPersonalExerciseEdit(personalFields()); await consumer.confirmPersonalExerciseChange();
    assert.equal(consumer.getState().personalChangeIntent.phase, 'unknown');
    assert.equal(consumer.getState().personalChangeIntent.error.code, 'invalid_personal_change_response');
    await consumer.dispose();
  }
  let finish;
  const { consumer } = personalConsumer(async (_path, method, fields) => method ? personalResponse(fields)
    : new Promise(done => { finish = done; }));
  const oldList = consumer.loadPersonalExercises(); consumer.reviewPersonalExercise(personalFields()); await consumer.confirmPersonalExercise();
  finish({ items: [], nextCursor: null }); await oldList;
  assert.equal(consumer.getState().personalExercises.status, 'idle'); await consumer.dispose();
});

test('personal lifecycle cannot replace create review, schedule review, void review or an unknown entry command', async () => {
  const { consumer, controller } = personalConsumer(async (path, method) => {
    if (path === '/v1/activity/calendar') return { timeZone: 'America/New_York' };
    if (path === '/v1/activity/schedule') return null;
    if (method === 'POST') throw { status: 0, effectUnknown: true };
    return entry(write());
  });
  consumer.reviewPersonalExercise(personalFields());
  await assert.rejects(consumer.beginPersonalExerciseEdit('personal-1'), /personal_create_in_progress/);
  await consumer.cancel(); await consumer.beginSchedule();
  await assert.rejects(consumer.beginPersonalExerciseRetirement('personal-1'), /schedule_intent_in_progress/);
  await consumer.cancel(); await consumer.beginVoid('entry-1');
  await assert.rejects(consumer.beginPersonalExerciseEdit('personal-1'), /void_intent_in_progress/);
  await consumer.cancel(); controller.beginManual(context(), chest); consumer.edit(manual()); await consumer.save();
  await assert.rejects(consumer.beginPersonalExerciseRetirement('personal-1'), /capture_unavailable/);
  await consumer.dispose();
});

test('calendar setup requires authoritative absence and explicit valid zone confirmation and retains server activation', async () => {
  let unavailable = true; const calls = [];
  const authoritative = { ...configuredCalendar(), activationDate: '2026-10-01', createdAt: '2026-10-01T14:12:00Z' };
  const { consumer, keys } = personalConsumer(async (path, method, payload, key) => {
    assert.equal(path, '/v1/activity/calendar');
    if (!method) { if (unavailable) throw { status: 503, code: 'offline' }; return null; }
    calls.push({ payload, key }); return authoritative;
  });
  assert.throws(() => consumer.reviewCalendar('America/New_York'), /activity_calendar_unavailable/);
  await consumer.loadCalendar(); assert.equal(consumer.getState().calendar.status, 'unavailable');
  assert.throws(() => consumer.reviewCalendar('America/New_York'), /activity_calendar_unavailable/);
  unavailable = false; await consumer.loadCalendar();
  assert.deepEqual(consumer.getState().calendar, { status: 'ready', value: null });
  for (const zone of ['No/SuchZone', '+04:00', '']) assert.throws(() => consumer.reviewCalendar(zone), /invalid_calendar_zone/);
  await assert.rejects(consumer.confirmCalendar(), /explicit_calendar_confirmation_required/);
  consumer.reviewCalendar('America/New_York'); consumer.getState().calendarIntent.timeZone = 'UTC';
  assert.equal(calls.length, 0); assert.equal(keys(), 0);
  await consumer.confirmCalendar();
  assert.deepEqual(calls[0].payload, { timeZone: 'America/New_York', confirmed: true }); assert.equal(keys(), 1);
  assert.deepEqual(consumer.getState().calendar.value, authoritative);
  assert.equal(consumer.getState().calendarIntent.phase, 'configured');
  assert.throws(() => consumer.reviewCalendar('UTC'), /activity_calendar_fixed/);
  assert.throws(() => consumer.reviewCalendar('America/New_York'), /activity_calendar_fixed/);
  await consumer.dispose();
});

test('calendar capture readiness rejects absent unavailable or mismatched zones before key or speech startup and freezes valid backdates', async () => {
  let mode = 'absent', starts = 0; const speech = speechPort(), start = speech.start;
  speech.start = async locale => { starts++; return start(locale); };
  const { consumer, keys } = personalConsumer(async path => {
    if (path === '/v1/activity/catalog') return { items: [chest], selectionUses: ['manual', 'nativeSpeech'] };
    if (mode === 'error') throw { status: 503, code: 'offline' };
    return mode === 'absent' ? null : configuredCalendar();
  }, speech);
  const input = { capturedAt: '2026-03-09T04:30:00Z', timeZone: 'America/New_York', selectedDate: '2025-01-01' };
  for (const readMode of ['absent', 'error']) {
    mode = readMode; await consumer.loadCalendar();
    assert.throws(() => consumer.beginManual(input, chest), /activity_calendar_required/);
    await assert.rejects(consumer.beginSpeech(input, 'en-US'), /activity_calendar_required/);
  }
  mode = 'configured'; await consumer.loadCalendar();
  assert.throws(() => consumer.beginManual({ ...input, timeZone: 'UTC' }, chest), /activity_zone_mismatch/);
  await assert.rejects(consumer.beginSpeech({ ...input, timeZone: 'UTC' }, 'en-US'), /activity_zone_mismatch/);
  assert.equal(keys(), 0); assert.equal(starts, 0);
  consumer.beginManual(input, chest);
  const frozen = consumer.getState().draft.result.context;
  assert.equal(frozen.referenceLocalDate, '2026-03-09'); assert.equal(frozen.selectedDate, '2025-01-01');
  assert.equal(consumer.getState().draft.result.candidate.date.localDate, '2025-01-01');
  input.selectedDate = '2026-10-10'; assert.equal(consumer.getState().draft.result.context.selectedDate, '2025-01-01');
  await consumer.cancel(); await consumer.loadCalendar(); await consumer.loadCatalog();
  await consumer.beginSpeech({ ...input, selectedDate: null }, 'en-US');
  speech.emit({ state: 'review', isFinal: true, text: 'Yesterday chest press 0 kg' }); consumer.acceptTranscript('Yesterday chest press 0 kg');
  assert.equal(starts, 1); assert.equal(consumer.getState().draft.result.candidate.date.localDate, '2026-03-08');
  assert.equal(consumer.getState().draft.result.context.capturedAt, '2026-03-09T04:30:00Z');
  assert.equal(consumer.getState().draft.result.candidate.performedConfirmed, false);
  await consumer.dispose();
});

test('calendar unknown setup retains exact zone and key and blocks competing commands even after a reconciliation read', async () => {
  const calls = []; let created = false;
  const { consumer, keys } = personalConsumer(async (_path, method, payload, key) => {
    if (!method) return created ? configuredCalendar() : null;
    calls.push({ payload, key }); created = true;
    if (calls.length === 1) throw { status: 0, effectUnknown: true };
    return configuredCalendar();
  });
  await consumer.loadCalendar(); consumer.reviewCalendar('America/New_York'); await consumer.confirmCalendar();
  assert.equal(consumer.getState().calendarIntent.phase, 'unknown');
  await consumer.loadCalendar(); assert.equal(consumer.getState().calendar.value.timeZone, 'America/New_York');
  assert.equal(consumer.getState().calendarIntent.phase, 'unknown');
  assert.throws(() => consumer.reviewCalendar('UTC'), /calendar_intent_in_progress/);
  assert.throws(() => consumer.beginManual(context()), /calendar_intent_in_progress/);
  await assert.rejects(consumer.beginSpeech(context(), 'en-US'), /calendar_intent_in_progress/);
  await assert.rejects(consumer.beginSchedule(), /calendar_intent_in_progress/);
  await assert.rejects(consumer.beginVoid('entry-1'), /calendar_intent_in_progress/);
  assert.throws(() => consumer.reviewPersonalExercise(personalFields()), /calendar_intent_in_progress/);
  await assert.rejects(consumer.beginPersonalExerciseEdit('personal-1'), /calendar_intent_in_progress/);
  await assert.rejects(consumer.save(), /calendar_intent_in_progress/);
  await consumer.retryCalendar(); assert.deepEqual(calls[0], calls[1]); assert.equal(keys(), 1);
  assert.equal(consumer.getState().calendarIntent.phase, 'configured'); await consumer.dispose();
});

test('calendar setup fences older reads and a concurrent fixed-zone conflict requires authoritative reload', async () => {
  let delayed = false, finishWrite; const pendingReads = [];
  const { consumer } = personalConsumer(async (path, method) => {
    if (method) return new Promise(done => { finishWrite = done; });
    if (delayed) return new Promise(done => { pendingReads.push({ path, done }); });
    return null;
  });
  await consumer.loadCalendar(); consumer.reviewCalendar('America/New_York'); const writing = consumer.confirmCalendar();
  delayed = true;
  const reading = [consumer.loadCalendar(), consumer.loadAdherence('2026-10-01', '2026-10-09')];
  finishWrite(configuredCalendar()); await writing;
  for (const { path, done } of pendingReads) done(path === '/v1/activity/calendar' ? null : { currentPlanDays: 999 });
  await Promise.all(reading);
  assert.deepEqual(consumer.getState().calendar.value, configuredCalendar());
  assert.equal(consumer.getState().adherence.status, 'idle'); assert.equal(consumer.getState().schedule.status, 'idle');
  await consumer.dispose();
  let concurrent = false;
  const other = personalConsumer(async (_path, method) => {
    if (!method) return concurrent ? { ...configuredCalendar(), timeZone: 'UTC' } : null;
    concurrent = true; throw { status: 409, code: 'activity_calendar_fixed' };
  }).consumer;
  await other.loadCalendar(); other.reviewCalendar('America/New_York'); await other.confirmCalendar();
  assert.equal(other.getState().calendarIntent.phase, 'rejected'); assert.equal(other.getState().calendar.status, 'idle');
  await assert.rejects(other.retryCalendar(), /calendar_retry_unavailable/);
  assert.throws(() => other.reviewCalendar('UTC'), /activity_calendar_unavailable/);
  await other.loadCalendar(); assert.equal(other.getState().calendar.value.timeZone, 'UTC');
  assert.throws(() => other.reviewCalendar('America/New_York'), /activity_calendar_fixed/); await other.dispose();
});

test('calendar background preserves exact private retry while session changes and disposal purge it', async () => {
  for (const end of ['background', 'session_changed', 'dispose', 'currentness']) {
    let finish, reject, current = true; const calls = [];
    const { consumer } = personalConsumer(async (_path, method, payload, key) => {
      if (!method) return null;
      calls.push({ payload, key });
      if (calls.length > 1) return configuredCalendar();
      return new Promise((done, fail) => { finish = done; reject = fail; });
    }, undefined, () => current);
    await consumer.loadCalendar(); consumer.reviewCalendar('America/New_York'); const writing = consumer.confirmCalendar();
    if (end === 'background') {
      await consumer.background(); assert.equal(consumer.getState().calendarIntent.timeZone, undefined);
      assert.equal(consumer.getState().calendar.status, 'idle');
      finish(configuredCalendar()); await writing; assert.equal(consumer.getState().calendarIntent.phase, 'unknown');
      await consumer.retryCalendar(); assert.deepEqual(calls[0], calls[1]);
    } else {
      if (end === 'dispose') await consumer.dispose();
      if (end === 'currentness') { current = false; consumer.getState(); }
      reject({ status: 409, code: 'session_changed', originalEffectUnknown: true }); await writing;
      assert.equal(consumer.getState().available, false); assert.equal(consumer.getState().invalidation.originalEffectUnknown, true);
      assert.equal(consumer.getState().calendarIntent.phase, 'idle');
      await assert.rejects(consumer.retryCalendar(), /activity_session_unavailable/);
    }
    await consumer.dispose();
  }
});

test('calendar malformed receipt remains unknown and calendar review cannot replace another pending intent', async () => {
  for (const changed of [{ timeZone: 'UTC' }, { revision: 2 }, { activationDate: '2026-10-08' }, { calendarPolicy: 'unrecognized' }]) {
    const { consumer } = personalConsumer(async (_path, method) => method ? { ...configuredCalendar(), ...changed } : null);
    await consumer.loadCalendar(); consumer.reviewCalendar('America/New_York'); await consumer.confirmCalendar();
    assert.equal(consumer.getState().calendarIntent.phase, 'unknown');
    assert.equal(consumer.getState().calendarIntent.error.code, 'invalid_calendar_response'); await consumer.dispose();
  }
  const { consumer, controller } = personalConsumer(async (path, method) => {
    if (path === '/v1/activity/calendar') return null;
    if (method) throw { status: 0, effectUnknown: true };
    return entry(write());
  });
  await consumer.loadCalendar(); consumer.reviewPersonalExercise(personalFields());
  assert.throws(() => consumer.reviewCalendar('America/New_York'), /personal_create_in_progress/);
  await consumer.cancel(); await consumer.beginVoid('entry-1');
  assert.throws(() => consumer.reviewCalendar('America/New_York'), /void_intent_in_progress/);
  await consumer.cancel(); controller.beginManual(context(), chest); consumer.edit(manual()); await consumer.save();
  assert.throws(() => consumer.reviewCalendar('America/New_York'), /capture_unavailable/); await consumer.dispose();
});
