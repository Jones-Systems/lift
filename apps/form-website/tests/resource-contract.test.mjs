import test from 'node:test';
import assert from 'node:assert/strict';
import { parseProfile, parsePreferences, parsePlan, parsePlans, parseSet, parseSession, parseHistory, parseStats, parseExercises } from '../public/resource-contract.mjs';

const syntheticCreatedAt = '2026-10-09T12:00:00.000Z';
const syntheticStartedAt = '2026-10-09T12:01:00.000Z';
const syntheticSetAt = '2026-10-09T12:02:00.000Z';
const syntheticCompletedAt = '2026-10-09T12:03:00.000Z';
const syntheticPreferences = () => ({ revision: 0, appMode: 'basic', mascot: 'scholarly', animationStyle: 'short', loadUnit: 'kg', heightUnit: 'cm', coachVoice: 'calm', communication: 'concise', trainingDaysPerWeek: 3, sessionMinutes: 35, equipment: ['barbell'], remindersEnabled: false });
const syntheticPlan = () => ({ id: 'synthetic-plan', revision: 1, name: 'Synthetic plan', minutes: 35, archived: false, createdAt: syntheticCreatedAt, updatedAt: syntheticCreatedAt, items: [{ id: 'synthetic-item', exerciseId: 'synthetic-exercise', setTarget: 3, repMin: 5, repMax: 8, targetKg: 50 }] });
const syntheticSet = () => ({ id: 'synthetic-set', occurrenceId: 'synthetic-occurrence', setNumber: 1, revision: 1, reps: 6, weightKg: 40, status: 'confirmed', createdAt: syntheticSetAt, updatedAt: syntheticSetAt });
const syntheticSession = () => {
  const planSnapshot = syntheticPlan();
  return { id: 'synthetic-session', planId: planSnapshot.id, planRevision: 1, revision: 2, status: 'active', planSnapshot, occurrences: [{ id: 'synthetic-occurrence', itemId: 'synthetic-item', exerciseId: 'synthetic-exercise', position: 0, target: { ...planSnapshot.items[0] } }], sets: [syntheticSet()], startedAt: syntheticStartedAt, completedAt: null };
};
const syntheticStats = () => ({ confirmedSets: 1, repetitions: 6, volumeKg: 240, completedSessions: 0, byExercise: [{ exerciseId: 'synthetic-exercise', confirmedSets: 1, repetitions: 6, volumeKg: 240, maxWeightKg: 40 }], units: { load: 'kg', volume: 'kg-repetitions' }, includesActiveConfirmedSets: true });
const syntheticExercises = () => ({ items: [{ id: 'synthetic-exercise', name: 'Synthetic exercise', loadLabel: 'External load', retired: false, provenance: { source: 'synthetic-only', nested: { labels: ['illustrative'] } }, requiredConstraints: [{ id: 'synthetic-safety', text: 'Synthetic safety constraint', required: true }], cues: [{ id: 'synthetic-cue', text: 'Synthetic optional cue', required: false }] }] });
const invalid = (parser, value, code) => assert.throws(() => parser(value), error => error instanceof Error && error.message === code);
const syntheticProfile = () => ({ revision: 0, name: '  Synthetic member  ', age: null, heightCm: null, weightKg: null,
  trainingBackground: null, injuryHistory: '', goals: [] });

test('profile preserves provisioned optional absence and stored text without normalizing or inventing facts', () => {
  const input = syntheticProfile(), output = parseProfile(input);
  assert.deepEqual(output, input); assert.equal(Object.hasOwn(output, 'trainingContext'), false);
  const stored = { ...input, trainingContext: '  Stored context\n', injuryHistory: ' Stored history ', goals: ['  Own goal  ', 'Own goal'] };
  const parsed = parseProfile(stored);
  assert.deepEqual(parsed, stored); stored.goals.push('Later mutation');
  assert.equal(parsed.goals.length, 2); assert.ok(Object.isFrozen(parsed)); assert.ok(Object.isFrozen(parsed.goals));
  assert.throws(() => parsed.goals.push('Changed'), TypeError);
  assert.equal(parseProfile({ ...input, trainingContext: '' }).trainingContext, '');
});

test('profile validates every stored field bound and nullable value with no eligibility inference', () => {
  for (const age of [null, 13, 120]) for (const trainingBackground of [null, 'new', 'returning', 'regular']) {
    assert.equal(parseProfile({ ...syntheticProfile(), age, trainingBackground }).age, age);
  }
  for (const [heightCm, weightKg] of [[null, null], [50, 15], [172.5, 80.2], [260, 500]]) {
    assert.equal(parseProfile({ ...syntheticProfile(), heightCm, weightKg }).heightCm, heightCm);
  }
  assert.equal(parseProfile({ ...syntheticProfile(), revision: Number.MAX_SAFE_INTEGER, name: 'x'.repeat(100),
    trainingContext: 'x'.repeat(4000), injuryHistory: 'x'.repeat(4000), goals: Array(30).fill('x'.repeat(200)) }).goals.length, 30);
  for (const changes of [{ revision: -1 }, { revision: 0.5 }, { revision: Number.MAX_SAFE_INTEGER + 1 },
    { name: '' }, { name: '  ' }, { name: 'x'.repeat(101) }, { name: null }, { age: 12 }, { age: 121 }, { age: 13.5 }, { age: '30' },
    { heightCm: 49 }, { heightCm: 261 }, { heightCm: Infinity }, { weightKg: 14 }, { weightKg: 501 }, { weightKg: NaN },
    { trainingBackground: 'expert' }, { trainingContext: null }, { trainingContext: 'x'.repeat(4001) },
    { injuryHistory: null }, { injuryHistory: 'x'.repeat(4001) }, { goals: null }, { goals: [''] }, { goals: [' '] },
    { goals: ['x'.repeat(201)] }, { goals: Array(31).fill('Own goal') }, { eligible: true }]) {
    invalid(parseProfile, { ...syntheticProfile(), ...changes }, 'invalid_profile');
  }
  for (const field of Object.keys(syntheticProfile())) {
    const incomplete = syntheticProfile(); delete incomplete[field]; invalid(parseProfile, incomplete, 'invalid_profile');
  }
});

test('profile optional fields and nested lists obey defensive descriptor and JSON shape checks', () => {
  let reads = 0;
  const accessor = syntheticProfile(); Object.defineProperty(accessor, 'trainingContext', { enumerable: true, get() { reads++; return 'Hidden'; } });
  invalid(parseProfile, accessor, 'invalid_profile'); assert.equal(reads, 0);
  const sparse = syntheticProfile(); sparse.goals = Array(1); invalid(parseProfile, sparse, 'invalid_profile');
  const cyclic = syntheticProfile(); cyclic.goals.push(cyclic); invalid(parseProfile, cyclic, 'invalid_profile');
  const symbol = syntheticProfile(); symbol[Symbol('hidden')] = true; invalid(parseProfile, symbol, 'invalid_profile');
  invalid(parseProfile, { ...syntheticProfile(), trainingContext: undefined }, 'invalid_profile');
  invalid(parseProfile, Object.assign(Object.create({ hidden: true }), syntheticProfile()), 'invalid_profile');
  invalid(parseProfile, JSON.parse('{"__proto__":{"polluted":true}}'), 'invalid_profile');
});

test('current global preferences preserve independent B3 settings and reject legacy/unknown values', () => {
  for (const appMode of ['basic', 'advanced']) for (const mascot of ['scholarly', 'baby', 'buff', 'none']) for (const animationStyle of ['short', 'long']) {
    const input = { ...syntheticPreferences(), appMode, mascot, animationStyle };
    assert.deepEqual(parsePreferences(input), input);
  }
  for (const changes of [{ mascot: 'default' }, { animationStyle: 'static' }, { appMode: 'expert' }, { loadUnit: 'stone' }, { heightUnit: 'm' }, { coachVoice: 'medical' }, { communication: 'automatic' }, { remindersEnabled: 1 }, { trainingDaysPerWeek: 0 }, { trainingDaysPerWeek: 8 }, { sessionMinutes: 181 }, { revision: -1 }, { revision: 0.5 }, { revision: Number.MAX_SAFE_INTEGER + 1 }, { equipment: Array(31).fill('barbell') }, { equipment: [''] }, { privacy: true }]) invalid(parsePreferences, { ...syntheticPreferences(), ...changes }, 'invalid_preferences');
  for (const field of ['appMode', 'mascot', 'animationStyle']) {
    const legacy = syntheticPreferences(); delete legacy[field]; invalid(parsePreferences, legacy, 'invalid_preferences');
  }
});

test('plan limits, item identity and target relationships use server bounds', () => {
  const boundary = syntheticPlan(); boundary.minutes = 180;
  boundary.items = Array.from({ length: 50 }, (_, index) => ({ id: `synthetic-item-${index}`, exerciseId: 'synthetic-exercise', setTarget: 20, repMin: 1, repMax: 100, targetKg: 500 }));
  assert.equal(parsePlan(boundary).items.length, 50);
  for (const changes of [{ id: '../plan' }, { revision: 0 }, { minutes: 4 }, { minutes: 181 }, { name: ' ' }, { name: 'x'.repeat(101) }, { items: [] }, { items: [...boundary.items, boundary.items[0]] }, { updatedAt: '2026-02-30T12:00:00.000Z' }, { updatedAt: '2026-10-08T12:00:00.000Z' }, { createdAt: '2026-10-09T12:00:00Z' }, { archived: 'false' }]) invalid(parsePlan, { ...syntheticPlan(), ...changes }, 'invalid_plan');
  for (const changes of [{ setTarget: 21 }, { repMin: 0 }, { repMax: 4 }, { targetKg: -1 }, { targetKg: Infinity }, { reps: 5 }]) {
    const input = syntheticPlan(); Object.assign(input.items[0], changes); invalid(parsePlan, input, 'invalid_plan');
  }
  const duplicate = syntheticPlan(); duplicate.items.push({ ...duplicate.items[0] }); invalid(parsePlan, duplicate, 'invalid_plan');
  invalid(parsePlans, { items: [syntheticPlan(), syntheticPlan()] }, 'invalid_plans');
  invalid(parsePlans, { items: Array(1001).fill(syntheticPlan()) }, 'invalid_plans');
  assert.deepEqual(parsePlans({ items: [] }), { items: [] });
});

test('performed values remain distinct from targets; draft and voided zero repetitions are valid', () => {
  assert.equal(parseSet(syntheticSet()).weightKg, 40);
  for (const status of ['draft', 'voided']) assert.equal(parseSet({ ...syntheticSet(), status, reps: 0 }).reps, 0);
  assert.equal(parseSet({ ...syntheticSet(), setNumber: 100, reps: 100, weightKg: 500 }).setNumber, 100);
  for (const changes of [{ status: 'complete' }, { status: 'confirmed', reps: 0 }, { reps: 101 }, { setNumber: 0 }, { setNumber: 101 }, { weightKg: 501 }, { weightKg: NaN }, { revision: 0 }, { targetKg: 40 }, { updatedAt: syntheticCreatedAt }]) invalid(parseSet, { ...syntheticSet(), ...changes }, 'invalid_set');
});

test('session binds full immutable plan snapshot and exact occurrences without fabricating performance', () => {
  const parsed = parseSession(syntheticSession());
  assert.equal(parsed.planSnapshot.items[0].targetKg, 50);
  assert.equal(parsed.sets[0].weightKg, 40);
  const empty = syntheticSession(); empty.sets = []; empty.revision = 1;
  assert.equal(parseSession(empty).sets.length, 0);
  const completed = syntheticSession(); completed.status = 'completed'; completed.completedAt = syntheticCompletedAt; completed.revision = 3;
  assert.equal(parseSession(completed).status, 'completed');
  const editedAfterCompletion = structuredClone(completed); editedAfterCompletion.sets[0].revision = 2; editedAfterCompletion.sets[0].updatedAt = '2026-10-09T12:04:00.000Z'; editedAfterCompletion.revision = 4;
  assert.equal(parseSession(editedAfterCompletion).sets[0].revision, 2);
  const breakRelationship = [
    value => { value.planId = 'other-plan'; },
    value => { value.planRevision = 2; },
    value => { value.planSnapshot.archived = true; },
    value => { delete value.planSnapshot.id; },
    value => { value.occurrences[0].position = 1; },
    value => { value.occurrences[0].itemId = 'other-item'; },
    value => { value.occurrences[0].exerciseId = 'other-exercise'; },
    value => { value.occurrences[0].target.targetKg = 51; },
    value => { value.occurrences = []; },
    value => { value.sets[0].occurrenceId = 'other-occurrence'; },
    value => { value.sets.push({ ...value.sets[0], id: 'second-set' }); value.revision++; },
    value => { value.sets.push({ ...value.sets[0], setNumber: 2 }); value.revision++; },
    value => { value.revision = 1; },
    value => { value.revision = 99; },
    value => { value.completedAt = syntheticCompletedAt; },
    value => { value.status = 'completed'; },
    value => { value.sets[0].createdAt = syntheticCreatedAt; },
    value => { value.startedAt = syntheticCompletedAt; },
  ];
  for (const mutate of breakRelationship) { const value = syntheticSession(); mutate(value); invalid(parseSession, value, 'invalid_session'); }
  const duplicateOccurrence = syntheticSession();
  const secondItem = { ...duplicateOccurrence.planSnapshot.items[0], id: 'synthetic-item-two' };
  duplicateOccurrence.planSnapshot.items.push(secondItem);
  duplicateOccurrence.occurrences.push({ ...duplicateOccurrence.occurrences[0], itemId: secondItem.id, position: 1, target: { ...secondItem } });
  invalid(parseSession, duplicateOccurrence, 'invalid_session');
});

test('history preserves unfinished sessions, opaque pagination and descending stable identities', () => {
  const recent = syntheticSession(), older = syntheticSession(); older.id = 'synthetic-older'; older.startedAt = syntheticCreatedAt; older.planSnapshot.updatedAt = syntheticCreatedAt;
  const page = { items: [recent, older], nextBefore: 'synthetic_opaque-cursor' };
  assert.equal(parseHistory(page).items[0].status, 'active');
  assert.equal(parseHistory(page).nextBefore, page.nextBefore);
  assert.deepEqual(parseHistory({ items: [], nextBefore: null }), { items: [], nextBefore: null });
  const tied = syntheticSession(); tied.id = 'synthetic-session-a';
  assert.equal(parseHistory({ items: [tied, recent], nextBefore: null }).items.length, 2);
  invalid(parseHistory, { items: [recent, tied], nextBefore: null }, 'invalid_history');
  for (const value of [{ items: [older, recent], nextBefore: null }, { items: [recent, recent], nextBefore: null }, { items: [], nextBefore: 'cursor' }, { items: [recent], nextBefore: 'a'.repeat(257) }, { items: [recent], nextBefore: '../cursor' }, { items: Array(51).fill(recent), nextBefore: null }, { items: [recent], nextBefore: null, complete: true }]) invalid(parseHistory, value, 'invalid_history');
});

test('statistics mean confirmed sets including active sessions in kg and kg-repetitions', () => {
  assert.deepEqual(parseStats(syntheticStats()), syntheticStats());
  const empty = { confirmedSets: 0, repetitions: 0, volumeKg: 0, completedSessions: 8, byExercise: [], units: { load: 'kg', volume: 'kg-repetitions' }, includesActiveConfirmedSets: true };
  assert.equal(parseStats(empty).completedSessions, 8);
  for (const changes of [{ includesActiveConfirmedSets: false }, { units: { load: 'lb', volume: 'lb-repetitions' } }, { confirmedSets: 2 }, { repetitions: 0 }, { repetitions: 101 }, { volumeKg: -1 }, { volumeKg: 241 }, { completedSessions: -1 }, { byExercise: [] }, { targetVolumeKg: 500 }]) invalid(parseStats, { ...syntheticStats(), ...changes }, 'invalid_stats');
  const duplicate = syntheticStats(); duplicate.byExercise.push({ ...duplicate.byExercise[0] }); duplicate.confirmedSets = 2; duplicate.repetitions = 12; duplicate.volumeKg = 480;
  invalid(parseStats, duplicate, 'invalid_stats');
  const impossibleMax = syntheticStats(); impossibleMax.byExercise[0].maxWeightKg = 39; invalid(parseStats, impossibleMax, 'invalid_stats');
  const rounded = syntheticStats(); rounded.byExercise[0].volumeKg = 0.30000000000000004; rounded.byExercise[0].maxWeightKg = 0.05; rounded.volumeKg = 0.3;
  assert.equal(parseStats(rounded).volumeKg, 0.3);
});

test('exercise safety constraints remain required, unique and detached with bounded JSON provenance', () => {
  const input = syntheticExercises(), output = parseExercises(input);
  input.items[0].provenance.nested.labels[0] = 'changed'; input.items[0].requiredConstraints[0].text = 'changed';
  assert.equal(output.items[0].provenance.nested.labels[0], 'illustrative');
  assert.equal(output.items[0].requiredConstraints[0].text, 'Synthetic safety constraint');
  assert.throws(() => output.items[0].provenance.nested.labels.push('new'), TypeError);
  for (const mutate of [
    value => { value.items[0].requiredConstraints[0].required = false; },
    value => { value.items[0].cues[0].required = 'false'; },
    value => { value.items[0].cues[0].id = 'synthetic-safety'; },
    value => { value.items[0].cues[0].text = ''; },
    value => { value.items[0].cues = Array(21).fill(value.items[0].cues[0]); },
    value => { value.items.push(value.items[0]); },
    value => { value.items[0].provenance = []; },
    value => { value.items[0].provenance = JSON.parse('{"__proto__":{"polluted":true}}'); },
  ]) { const value = syntheticExercises(); mutate(value); invalid(parseExercises, value, 'invalid_exercises'); }
});

test('every parser rejects non-JSON shapes with its own concise error', () => {
  for (const [parser, code] of [[parseProfile, 'invalid_profile'], [parsePreferences, 'invalid_preferences'], [parsePlan, 'invalid_plan'], [parsePlans, 'invalid_plans'], [parseSet, 'invalid_set'], [parseSession, 'invalid_session'], [parseHistory, 'invalid_history'], [parseStats, 'invalid_stats'], [parseExercises, 'invalid_exercises']]) {
    for (const value of [null, undefined, true, [], 'data', new Date(), { surprise: 1 }]) invalid(parser, value, code);
  }
  let reads = 0;
  const accessor = syntheticPreferences(); Object.defineProperty(accessor, 'mascot', { enumerable: true, get() { reads++; return 'scholarly'; } });
  invalid(parsePreferences, accessor, 'invalid_preferences'); assert.equal(reads, 0);
  const cyclic = syntheticExercises(); cyclic.items[0].provenance.self = cyclic; invalid(parseExercises, cyclic, 'invalid_exercises');
  const sparse = syntheticPlan(); sparse.items = Array(1); invalid(parsePlan, sparse, 'invalid_plan');
  const symbol = syntheticPreferences(); symbol[Symbol('hidden')] = true; invalid(parsePreferences, symbol, 'invalid_preferences');
  const inherited = Object.assign(Object.create({ unexpected: true }), syntheticPreferences()); invalid(parsePreferences, inherited, 'invalid_preferences');
});

test('resource output remains detached and frozen throughout sessions and preferences', () => {
  const input = syntheticSession(), output = parseSession(input);
  input.planSnapshot.items[0].targetKg = 1; input.occurrences[0].target.targetKg = 2; input.sets[0].reps = 99;
  assert.equal(output.planSnapshot.items[0].targetKg, 50); assert.equal(output.occurrences[0].target.targetKg, 50); assert.equal(output.sets[0].reps, 6);
  assert.notEqual(output.planSnapshot.items[0], output.occurrences[0].target);
  assert.throws(() => { output.sets[0].reps = 7; }, TypeError);
  assert.throws(() => { output.occurrences[0].target.targetKg = 0; }, TypeError);
  assert.throws(() => output.sets.push(syntheticSet()), TypeError);
  const preferences = parsePreferences(syntheticPreferences()); assert.throws(() => preferences.equipment.push('new'), TypeError);
});
