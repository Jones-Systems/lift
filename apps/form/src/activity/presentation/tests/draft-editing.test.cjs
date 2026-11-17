const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const root = path.resolve(__dirname, '../../..');
const modules = new Map();
function load(name) {
  const file = path.resolve(root, name);
  assert.ok(file.startsWith(root + path.sep));
  if (modules.has(file)) return modules.get(file).exports;
  const module = { exports: {} }; modules.set(file, module);
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function('require', 'module', 'exports', code)(name => {
    assert.ok(name.startsWith('.'));
    return load(path.relative(root, path.resolve(path.dirname(file), name + '.ts')));
  }, module, module.exports);
  return module.exports;
}
const e = load('activity/presentation/draftEditing.ts');
const model = load('activity/drafts/model.ts');
const validation = load('activity/drafts/validation.ts');
const exercise = { ref: { source: 'global', id: 'press' }, name: 'Press', description: '', movement: null,
  measurementType: 'repetitions', kind: 'resistance', loadApplicability: 'applicable', loadLabel: 'Weight',
  guidance: 'globalReference', cueStatus: 'globalReference', safetyAssessment: 'notEstablished' };
const context = model.freezeCaptureContext({ accountGeneration: 'session-one', draftId: 'secure-draft-0000000001',
  capturedAt: '2026-11-01T05:30:00Z', timeZone: 'America/New_York', selectedDate: '2026-10-31' });
const draft = () => model.manualActivityDraft(context, exercise);
const write = result => validation.draftToActivityWrite(model.confirmStructuredReview(result));

test('all load dispositions remain distinct through actual validation, including known zero, original unit and basis', () => {
  const base = draft(), id = base.candidate.items[0].id;
  assert.ok(e.reviewProblems(base).some(problem => problem.code === 'load_review_required'));
  for (const load of [{ state: 'unknown', confirmed: true },
    { state: 'notApplicable', reason: 'bodyweight' }, { state: 'notApplicable', reason: 'unloaded' },
    { state: 'notApplicable', reason: 'timedActivity' },
    { state: 'knownValue', value: 0, unit: 'kg', basis: 'total' },
    { state: 'knownValue', value: 0, unit: 'lb', basis: 'assistance' }]) {
    const changed = e.changeLoad(base, id, load);
    assert.deepEqual(write(changed).items[0].load, load);
    assert.equal(changed.candidate.performedConfirmed, false);
  }
  assert.equal(base.candidate.items[0].load.state, 'missing');
});
test('optional blank fields are absent; count never manufactures observations, repetitions or zero values', () => {
  let result = draft(), id = result.candidate.items[0].id;
  result = e.changeItem(result, id, item => e.optionalNumber(item, 'reportedSetCount', '3'), 'reportedSetCount');
  assert.equal(result.candidate.items[0].reportedSetCount, 3);
  assert.equal(result.candidate.items[0].sets, undefined);
  result = e.changeItem(result, id, item => e.optionalNumber(item, 'reportedSetCount', '   '), 'reportedSetCount');
  assert.equal(Object.hasOwn(result.candidate.items[0], 'reportedSetCount'), false);
  result = e.changeItem(result, id, item => e.optionalNumber(item, 'durationSeconds', 'not-a-number'));
  result = e.changeLoad(result, id, { state: 'unknown', confirmed: true });
  assert.ok(e.reviewProblems(result).some(problem => problem.code === 'invalid_number'));
});
test('multiple items, sets and splits retain exact supplied secure identities across edits/removal/resequencing', () => {
  let serial = 0;
  const key = () => `secure-observation-${++serial}`;
  let result = e.addItem(draft(), key);
  const originalId = result.candidate.items[0].id, addedId = result.candidate.items[1].id;
  assert.equal(addedId, 'secure-observation-1');
  result = e.addSet(result, originalId, key); result = e.addSet(result, addedId, key);
  const firstSet = result.candidate.items[0].sets[0].id;
  result = e.changeSet(result, originalId, firstSet, set => ({ ...set, repetitions: 5 }));
  assert.equal(result.candidate.items[0].sets[0].id, firstSet);
  assert.equal(result.candidate.items[1].sets[0].id, 'secure-observation-3');
  result = e.addSplit(result, addedId, key); result = e.addSplit(result, addedId, key);
  const [a, b] = result.candidate.items[1].splits;
  assert.equal(Number.isNaN(a.durationSeconds), true);
  result = e.changeSplit(result, addedId, b.id, split => ({ ...split, durationSeconds: 60 }));
  result = e.removeSplit(result, addedId, a.id);
  assert.equal(result.candidate.items[1].splits[0].id, b.id); assert.equal(result.candidate.items[1].splits[0].sequence, 1);
  assert.throws(() => e.addItem(result, () => b.id), /fresh_observation_identity_required/);
  result = e.removeItem(result, originalId);
  assert.equal(result.candidate.items[0].id, addedId); assert.equal(result.candidate.items[0].sets[0].id, 'secure-observation-3');
});
test('semantic edits and Review Back clear performance/date confirmation while preserving capture provenance', () => {
  let result = model.confirmStructuredReview(model.setDraftLoad(draft(), draft().candidate.items[0].id, { state: 'unknown', confirmed: true }));
  const capture = e.clone(result.context);
  result = e.changeDate(result, '2026-10-30');
  assert.equal(result.candidate.performedConfirmed, false); assert.equal(result.candidate.date.confirmed, false);
  assert.deepEqual(result.context, capture); assert.equal(result.candidate.date.capturedAt, capture.capturedAt);
  result = e.invalidateReview(model.confirmStructuredReview(result), true);
  assert.equal(result.candidate.performedConfirmed, false); assert.equal(result.candidate.date.confirmed, false);
  assert.equal(result.candidate.date.referenceLocalDate, '2026-11-01');
});
test('running duration and optional distance/pace/speed/splits use existing validator without inferred metrics or equal splits', () => {
  const run = { ...exercise, ref: { source: 'global', id: 'run' }, name: 'Running', kind: 'run', measurementType: 'duration' };
  let result = model.manualActivityDraft(context, run), id = result.candidate.items[0].id;
  result = e.changeLoad(result, id, { state: 'notApplicable', reason: 'timedActivity' });
  assert.ok(e.reviewProblems(result).some(problem => problem.code === 'run_duration_or_load_required'));
  result = e.changeItem(result, id, item => ({ ...item, durationSeconds: 600, distance: { value: 1, unit: 'mi' },
    pace: { secondsPerUnit: 600, unit: 'mi' }, speed: { value: 6, unit: 'mi/h' } }));
  result = e.addSplit(result, id, () => 'split-observed-one');
  result = e.changeSplit(result, id, 'split-observed-one', split => ({ ...split, durationSeconds: 180, distance: { value: 0.3, unit: 'mi' } }));
  result = e.changeItem(result, id, item => ({ ...item, splitCoverage: 'partial' }));
  const actual = write(result).items[0];
  assert.equal(actual.splits.length, 1); assert.equal(actual.splits[0].durationSeconds, 180);
  assert.equal(actual.splits[0].pace, undefined); assert.equal(actual.splits[0].speed, undefined);
  assert.equal(actual.durationSeconds, 600); assert.equal(actual.distance.unit, 'mi');
});
test('unresolved parser issues survive edits and require an explicit supported resolution', () => {
  const base = draft(); base.issues.push({ id: 'ambiguous-date', fieldPath: 'date', code: 'dateAmbiguous', blocking: true,
    message: 'Choose the intended civil date.', fragment: 'last Friday' });
  const edited = e.changeDate(base, '2026-10-30');
  assert.equal(edited.issues[0].resolution, undefined); assert.equal(edited.issues[0].fragment, 'last Friday');
  assert.ok(e.reviewProblems(edited).some(problem => problem.code === 'dateAmbiguous'));
  const resolved = e.resolveIssue(edited, 'ambiguous-date', { kind: 'edited' });
  assert.equal(resolved.candidate.performedConfirmed, false);
  assert.equal(e.changeDate(resolved, '2026-10-29').issues[0].resolution, undefined);
  assert.throws(() => e.resolveIssue(base, 'ambiguous-date', { kind: 'acknowledged', code: 'approximateMetrics' }), /issue_requires_edit/);
});
