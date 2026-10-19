const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const ts = require('typescript');

// Compile the presentation model and its one runtime dependency (parser-lane civil-date helpers) in memory.
// No files are written. This checks display/mapping behavior only, not React rendering or TS type correctness.
function load(path, resolve) {
  const compiled = ts.transpileModule(readFileSync(join(__dirname, path), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', compiled)(resolve, mod, mod.exports);
  return mod.exports;
}
const dates = load('../../drafts/dates.ts', name => { throw new Error(`unexpected import ${name}`); });
const m = load('../model.ts', name => {
  assert.equal(name, '../drafts/dates');
  return dates;
});

test('civil dates format the date itself, with relative words only beside it', () => {
  assert.equal(m.formatCivilDate('2026-10-08'), 'Thu, Oct 8');
  assert.equal(m.formatCivilDate('2028-02-29', { long: true }), 'Tuesday, February 29');
  assert.equal(m.formatCivilDate('2025-12-31', { currentYear: 2026 }), 'Wed, Dec 31, 2025');
  assert.equal(m.relativeDayLabel('2026-10-08', '2026-10-09'), 'Yesterday, Thu Oct 8');
  assert.equal(m.relativeDayLabel('2026-10-09', '2026-10-09'), 'Today, Fri Oct 9');
  assert.equal(m.relativeDayLabel('2026-10-07', '2026-10-09'), 'Wed, Oct 7');
  assert.equal(m.relativeDayLabel('2026-03-01', '2026-03-02'), 'Yesterday, Sun Mar 1');
  assert.equal(m.formatCivilDate('2027-02-29'), '2027-02-29', 'an invalid civil date is shown raw, never shifted');
});

test('load text keeps known zero, unknown and no-added-weight distinct; missing asks instead', () => {
  assert.equal(m.loadText({ state: 'knownValue', value: 0, unit: 'kg', basis: 'unspecified' }), '0 kg');
  assert.equal(m.loadText({ state: 'knownValue', value: 75, unit: 'lb', basis: 'total' }), '75 lb');
  assert.equal(m.loadText({ state: 'knownValue', value: 12.5, unit: 'kg', basis: 'perImplement' }), '12.5 kg each');
  assert.equal(m.loadText({ state: 'unknown', confirmed: true }), 'Weight not remembered');
  assert.equal(m.loadText({ state: 'notApplicable', reason: 'bodyweight' }), 'No added weight');
  assert.equal(m.loadText({ state: 'notApplicable', reason: 'timedActivity' }), 'Timed');
  assert.equal(m.loadText({ state: 'missing' }), null);
});

test('run values render as entered: 56 min, 8:30 per mile, never decimal minutes', () => {
  assert.equal(m.durationText(3360), '56 min');
  assert.equal(m.durationText(3930), '1 hr 5 min 30 sec');
  assert.equal(m.durationText(undefined), null);
  assert.equal(m.durationText(0), null);
  assert.equal(m.paceText({ secondsPerUnit: 510, unit: 'mi' }), '8:30 per mile');
  assert.equal(m.paceText({ secondsPerUnit: 299.6, unit: 'km' }), '5:00 per km');
  assert.equal(m.distanceText({ value: 1, unit: 'mi' }), '1 mile');
  assert.equal(m.speedText({ value: 7.06, unit: 'mi/h' }), '7.06 mph');
  assert.equal(m.secondsFromFields(8, 30), 510);
  assert.equal(m.secondsFromFields(null, null), null);
  assert.equal(m.secondsFromFields(8, 60), null);
  assert.equal(m.secondsFromFields(8.3, 0), null);
});

test('day status always carries words and a VoiceOver suffix, never colour alone', () => {
  const ctx = { today: '2026-10-09', zone: 'America/New_York', allowanceMonth: '2026-10' };
  const states = ['activityRecorded', 'plannedRest', 'pending', 'protectedMiss', 'missed', 'unknownPlan'];
  const glyphs = new Set();
  for (const state of states) {
    const p = m.dayStatus({ localDate: '2026-10-03', state }, ctx);
    assert.ok(p.words.length > 0 && p.a11ySuffix.startsWith(', '), state);
    glyphs.add(`${state}:${p.glyph}`);
  }
  const protectedDay = m.dayStatus({ localDate: '2026-10-03', state: 'protectedMiss' }, ctx);
  assert.equal(protectedDay.countsAsDone, false, 'a protected miss is never reported as done');
  assert.equal(protectedDay.words, 'Not logged. Kept by October’s allowance.');
  assert.equal(m.dayStatus({ localDate: '2026-10-08', state: 'plannedRest' }, ctx).countsAsDone, true);
  const openRest = m.dayStatus({ localDate: '2026-10-09', state: 'pending' }, { ...ctx, expectation: 'rest' });
  assert.equal(openRest.countsAsDone, false);
  assert.match(openRest.words, /once the day ends/);
  assert.equal(m.dayStatus({ localDate: '2026-10-09', state: 'pending' }, { ...ctx, expectation: 'workout' }).words,
    'Workout planned. Open until midnight, New York time.');
  assert.equal(m.dayAccessibilityLabel('2026-10-08', m.dayStatus({ localDate: '2026-10-08', state: 'plannedRest' }, ctx)),
    'Thursday, October 8, rest day');
});

test('streak shows only reported counts; no coverage means starting, not zero', () => {
  assert.deepEqual(m.streakPresentation(null, '2026-10-09'), { kind: 'starting', text: m.ACTIVITY_COPY.streakStarting });
  const adherence = {
    policyVersion: 'activity-adherence-v1', asOf: '2026-10-09T23:40:00Z', timeZone: 'America/New_York',
    coverageStart: '2026-09-14', throughDate: '2026-10-08', currentPlanDays: 25, longestPlanDays: 25,
    satisfiedDaysInCurrentStreak: 24, protectedDaysInCurrentStreak: 1,
    monthlyAllowance: { month: '2026-10', protectedDate: '2026-10-03', remaining: 0 }, days: [],
  };
  const p = m.streakPresentation(adherence, '2026-10-09');
  assert.equal(p.count, 25);
  assert.equal(p.through, 'Through Thu, Oct 8. Today is still open.');
  assert.equal(p.breakdown, '24 followed your plan, 1 kept by an allowance');
  assert.equal(p.allowance, 'October: used for Sat, Oct 3');
  assert.equal(m.streakPresentation({ ...adherence, coverageStart: null }, '2026-10-09').kind, 'starting');
  const restarted = m.streakPresentation({ ...adherence, currentPlanDays: 0, satisfiedDaysInCurrentStreak: 0, protectedDaysInCurrentStreak: 0 }, '2026-10-09');
  assert.equal(restarted.kind, 'restarted', 'a reset never shows a bare 0');
  assert.equal(restarted.text, 'Your next plan day starts a new count. Longest so far: 25 plan days.');
  assert.equal(m.allowanceText({ month: '2026-11', protectedDate: null, remaining: 1 }), 'November: available');
});

test('save outcomes map to their notices; unknown keeps a retry, stale reloads', () => {
  assert.equal(m.saveOutcomeNotice('saving', null), null);
  assert.deepEqual(m.saveOutcomeNotice('saved', null, '2026-10-08'), { kind: 'success', text: 'Saved to Thu, Oct 8.' });
  assert.equal(m.saveOutcomeNotice('unknown', { code: 'network_unavailable', status: 0 }).action, 'retry');
  assert.equal(m.saveOutcomeNotice('stale', { code: 'stale_revision', status: 409 }).action, 'reload');
  assert.equal(m.saveOutcomeNotice('stale', { code: 'draft_identity_conflict', status: 409 }).text, m.ACTIVITY_COPY.duplicateDraft);
  assert.equal(m.saveOutcomeNotice('rejected', { code: 'future_activity_date', status: 422 }).action, 'editPlan');
  assert.equal(m.errorNotice({ code: 'invalid_request', status: 422 }).text, 'Check the highlighted details and try again.');
});

test('plan targets are optional and never defaulted', () => {
  assert.equal(m.planTargetText({}), 'No target set');
  assert.equal(m.planTargetText({ setCount: 3, repMin: 8, repMax: 10, load: { state: 'knownValue', value: 40, unit: 'kg', basis: 'total' } }), '3 sets, 8–10 reps, 40 kg');
  assert.equal(m.planTargetText({ setCount: 1, repMin: 12, repMax: 12, load: { state: 'knownValue', value: 0, unit: 'kg', basis: 'unspecified' } }), '1 set, 12 reps, 0 kg');
  assert.equal(m.planTargetText({ durationSeconds: 1200 }), '20 min');
  assert.equal(m.planMinutesText(null), 'No time set');
});

test('not-configured comes only from an explicit null or capability, never from a failed read', () => {
  const failed = { status: 'unavailable', error: { code: 'invalid_response', status: 200 } };
  assert.equal(m.calendarState({ status: 'loading' }), 'unknown');
  assert.equal(m.calendarState(failed), 'unknown');
  assert.equal(m.calendarState({ status: 'ready', value: null }), 'notConfigured');
  assert.equal(m.calendarState({ status: 'ready', value: { timeZone: 'America/New_York' } }), 'configured');
  assert.equal(m.calendarState(failed, { status: 'ready', value: { calendar: 'not_configured' } }), 'notConfigured');
  assert.equal(m.calendarState(failed, { status: 'unavailable', error: { code: 'network_unavailable', status: 0 } }), 'unknown');
  assert.equal(m.scheduleState({ status: 'ready', value: null }), 'notConfigured');
  assert.equal(m.scheduleState(failed), 'unknown', 'a failed schedule read is not "no weekly plan"');
});

test('Basic and Advanced differ in presentation flags only', () => {
  const basic = m.modePresentation('basic'), advanced = m.modePresentation('advanced');
  assert.deepEqual(Object.keys(basic), Object.keys(advanced));
  assert.ok(Object.values(basic).every(v => v === false));
  assert.ok(Object.values(advanced).every(v => v === true));
});

test('screen cache drops late responses after an account change', () => {
  const cache = new m.ActivityScreenCache('acct_a');
  const stamp = cache.current;
  assert.equal(cache.accept(stamp, 'catalog', ['x']), true);
  cache.reset('acct_b');
  assert.equal(cache.get('catalog'), undefined);
  assert.equal(cache.accept(stamp, 'catalog', ['late']), false);
  assert.equal(cache.get('catalog'), undefined);
  assert.equal(m.backLabel(null), 'Today');
  assert.equal(m.backLabel({ name: 'day', date: '2026-10-08' }), 'Thu, Oct 8');
});
