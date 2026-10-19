import test from 'node:test';
import assert from 'node:assert/strict';
import {
  derivePresentation, deriveWorkoutSummary, deriveHistoryWindow, deriveOperationPresentation,
} from '../public/presentation-model.mjs';

// Synthetic resource fixtures only; no renderer, provider, persistence, network, or scratch.
const preferences = (changes = {}) => ({
  revision: 0, appMode: 'basic', mascot: 'scholarly', animationStyle: 'short',
  loadUnit: 'kg', heightUnit: 'cm', coachVoice: 'calm', communication: 'concise',
  trainingDaysPerWeek: 3, sessionMinutes: 35, equipment: [], remindersEnabled: false,
  ...changes,
});
const startedAt = '2026-10-09T12:00:00.000Z';
const item = (id = 'item-1', changes = {}) => ({
  id, exerciseId: 'exercise-1', setTarget: 3, repMin: 8, repMax: 12, targetKg: 20, ...changes,
});
const performedSet = (id, changes = {}) => ({
  id, occurrenceId: 'occurrence-1', setNumber: 1, revision: 1, reps: 8, weightKg: 10,
  status: 'confirmed', createdAt: startedAt, updatedAt: startedAt, ...changes,
});
const session = (changes = {}) => {
  const sets = changes.sets ?? [performedSet('set-1')];
  return {
    id: 'session-1', planId: 'plan-1', planRevision: 1,
    revision: 1 + sets.reduce((sum, set) => sum + set.revision, 0) + (changes.status === 'completed' ? 1 : 0),
    status: 'active',
    planSnapshot: { id: 'plan-1', revision: 1, name: 'Synthetic plan', minutes: 35,
      items: [item()], archived: false, createdAt: '2026-10-01T12:00:00.000Z', updatedAt: '2026-10-01T12:00:00.000Z' },
    occurrences: [{ id: 'occurrence-1', itemId: 'item-1', exerciseId: 'exercise-1', position: 0, target: item() }],
    sets, startedAt, completedAt: null, ...changes,
  };
};

test('server default choices are consumed; unknown or missing preferences are rejected', () => {
  assert.deepEqual(derivePresentation(preferences(), { assetReady: true }), {
    appMode: 'basic', mascot: 'scholarly', animationStyle: 'short', mascotVisible: true,
    equivalence: { resultsWaitForMotion: false, controlsWaitForMotion: false, decorationInterceptsInput: false },
  });
  for (const changes of [{ appMode: 'expert' }, { mascot: 'default' }, { animationStyle: 'static' }]) {
    assert.throws(() => derivePresentation(preferences(changes)));
  }
  for (const key of ['appMode', 'mascot', 'animationStyle']) {
    const missing = preferences(); delete missing[key];
    assert.throws(() => derivePresentation(missing));
  }
  assert.throws(() => derivePresentation(null));
  assert.throws(() => derivePresentation(preferences(), { reduceMotion: 'false' }), TypeError);
  assert.throws(() => derivePresentation(preferences(), { assetReady: 1 }), TypeError);
});

test('motion and assets cannot change saved global preferences or result/control equivalence', () => {
  const safety = derivePresentation(preferences()).equivalence;
  for (const appMode of ['basic', 'advanced']) {
    for (const mascot of ['scholarly', 'baby', 'buff', 'none']) {
      for (const animationStyle of ['short', 'long']) {
        const saved = preferences({ appMode, mascot, animationStyle });
        const before = structuredClone(saved);
        for (const reduceMotion of [false, true]) {
          for (const assetReady of [false, true]) {
            const effective = derivePresentation(saved, { reduceMotion, assetReady });
            assert.equal(effective.appMode, appMode);
            assert.equal(effective.mascot, mascot);
            assert.equal(effective.animationStyle,
              reduceMotion || !assetReady || mascot === 'none' ? 'static' : animationStyle);
            assert.equal(effective.mascotVisible, assetReady && mascot !== 'none');
            assert.deepEqual(effective.equivalence, safety);
            assert.equal(Object.isFrozen(effective), true);
            assert.equal(Object.isFrozen(effective.equivalence), true);
            assert.deepEqual(saved, before);
            assert.equal(Object.isFrozen(saved), false);
          }
        }
      }
    }
  }
});

test('a system motion change is temporary and independent of units, voice and communication', () => {
  const saved = preferences({ appMode: 'advanced', mascot: 'buff', animationStyle: 'long',
    loadUnit: 'lb', coachVoice: 'direct', communication: 'detailed' });
  assert.equal(derivePresentation(saved, { assetReady: true, reduceMotion: true }).animationStyle, 'static');
  assert.equal(derivePresentation(saved, { assetReady: true }).animationStyle, 'long');
  assert.equal(saved.animationStyle, 'long');
  assert.equal(saved.coachVoice, 'direct');
  assert.equal(saved.loadUnit, 'lb');
});

test('active confirmed performance excludes draft/voided sets and never counts targets', () => {
  const source = session({ sets: [
    performedSet('set-1'),
    performedSet('set-2', { setNumber: 2, reps: 99, weightKg: 400, status: 'draft' }),
    performedSet('set-3', { setNumber: 3, revision: 2, reps: 99, weightKg: 400, status: 'voided' }),
    performedSet('set-4', { setNumber: 4, reps: 5, weightKg: 0 }),
  ] });
  const before = structuredClone(source);
  const summary = deriveWorkoutSummary(source);
  assert.deepEqual(summary.performed, { confirmedSets: 2, repetitions: 13, volumeKg: 80 });
  assert.deepEqual(summary.units, { load: 'kg', volume: 'kg-repetitions' });
  assert.equal(summary.status, 'active'); assert.equal(summary.readOnly, false);
  assert.deepEqual(summary.occurrences[0].target, {
    itemId: 'item-1', setTarget: 3, repMin: 8, repMax: 12, targetKg: 20,
  });
  assert.deepEqual(summary.occurrences[0].performed, summary.performed);
  assert.deepEqual(source, before);
  assert.equal(Object.isFrozen(summary.occurrences), true);
  assert.throws(() => { summary.occurrences[0].target.targetKg = 100; }, TypeError);
});

test('repeated exercise occurrences retain distinct targets and performed facts', () => {
  const second = item('item-2', { setTarget: 2, targetKg: 30 });
  const source = session({
    planSnapshot: { ...session().planSnapshot, items: [item(), second] },
    occurrences: [session().occurrences[0], {
      id: 'occurrence-2', itemId: 'item-2', exerciseId: 'exercise-1', position: 1, target: second,
    }],
    sets: [performedSet('set-2', { occurrenceId: 'occurrence-2', reps: 4, weightKg: 25 })],
  });
  const summary = deriveWorkoutSummary(source);
  assert.deepEqual(summary.occurrences[0].performed, { confirmedSets: 0, repetitions: 0, volumeKg: 0 });
  assert.deepEqual(summary.occurrences[1].performed, { confirmedSets: 1, repetitions: 4, volumeKg: 100 });
  assert.equal(summary.occurrences[1].target.targetKg, 30);
  const completed = deriveWorkoutSummary(session({ status: 'completed', completedAt: startedAt }));
  assert.equal(completed.readOnly, true);
  assert.deepEqual(completed.performed, { confirmedSets: 1, repetitions: 8, volumeKg: 80 });
});

test('unperformed workouts have zero performed facts; malformed facts never become zero', () => {
  assert.deepEqual(deriveWorkoutSummary(session({ sets: [] })).performed,
    { confirmedSets: 0, repetitions: 0, volumeKg: 0 });
  for (const changes of [{ status: 'done' }, { reps: -1 }, { weightKg: NaN }]) {
    assert.throws(() => deriveWorkoutSummary(session({ sets: [performedSet('set-1', changes)] })));
  }
  assert.throws(() => deriveWorkoutSummary(null));
});

test('history exposes loaded count and opaque continuation with conservative window coverage', () => {
  const earlier = '2026-10-08T12:00:00.000Z';
  const source = { items: [session(), session({ id: 'session-2', startedAt: earlier,
    status: 'completed', completedAt: startedAt })], nextBefore: 'opaque-cursor' };
  const before = structuredClone(source);
  const window = deriveHistoryWindow(source);
  assert.equal(window.loadedCount, 2); assert.equal(window.activeCount, 1); assert.equal(window.completedCount, 1);
  assert.equal(window.hasMore, true); assert.equal(window.nextBefore, 'opaque-cursor');
  assert.deepEqual(window.coverage, { scope: 'loaded-window', oldestStartedAt: earlier,
    newestStartedAt: startedAt, olderItemsRemain: true, newerCoverage: 'unknown', allHistory: false, weekComplete: false });
  assert.deepEqual(source, before);
  assert.equal(Object.isFrozen(window.coverage), true);
  const lastPage = deriveHistoryWindow({ items: [session()], nextBefore: null });
  assert.equal(lastPage.hasMore, false); assert.equal(lastPage.coverage.allHistory, false);
  assert.equal(lastPage.coverage.weekComplete, false);
  const empty = deriveHistoryWindow({ items: [], nextBefore: null });
  assert.equal(empty.loadedCount, 0); assert.equal(empty.coverage.oldestStartedAt, null);
  assert.throws(() => deriveHistoryWindow({ items: [] }));
});

test('operation observer requires explicit evidence and never invents retrieval or voice activity', () => {
  for (const state of ['idle', 'loading', 'processing', 'response', 'error', 'cancelled', 'disconnected', 'unknown']) {
    const view = deriveOperationPresentation({ state, retrievalEvidence: null, resultAvailable: true });
    assert.equal(view.state, state);
    assert.equal(view.activityOngoing, ['loading', 'processing', 'response'].includes(state));
    assert.equal(view.resultAvailable, true);
    assert.equal(view.claimsPaperRetrieval, false); assert.equal(view.claimsAudioPlayback, false);
    assert.equal(view.claimsLipSync, false); assert.equal(view.visualBinding, null);
    assert.equal(view.equivalence.resultsWaitForMotion, false);
    assert.equal(Object.isFrozen(view), true);
  }
  assert.equal(deriveOperationPresentation({ state: 'loading', retrievalEvidence: null, resultAvailable: false }).resultAvailable, false);
  const evidence = { source: 'synthetic-observation' };
  const view = deriveOperationPresentation({ state: 'processing', retrievalEvidence: evidence, resultAvailable: true });
  assert.equal(view.retrievalEvidencePresent, true); assert.equal(view.claimsPaperRetrieval, false);
  assert.equal(Object.isFrozen(evidence), false);
  for (const source of [undefined, {}, { state: 'researching', retrievalEvidence: null, resultAvailable: true },
    { state: 'loading', resultAvailable: true }, { state: 'loading', retrievalEvidence: true, resultAvailable: true },
    { state: 'response', retrievalEvidence: null }]) {
    assert.throws(() => deriveOperationPresentation(source), TypeError);
  }
});
