import { parsePreferences, parseSession, parseHistory } from './resource-contract.mjs';

const equivalence = Object.freeze({
  resultsWaitForMotion: false,
  controlsWaitForMotion: false,
  decorationInterceptsInput: false,
});
const units = Object.freeze({ load: 'kg', volume: 'kg-repetitions' });
const boolean = (value, name) => {
  if (typeof value !== 'boolean') throw new TypeError(`${name} must be a boolean`);
  return value;
};

/** Consume confirmed server preferences; never supply missing account defaults or save overrides. */
export function derivePresentation(preferences, { reduceMotion = false, assetReady = false } = {}) {
  const saved = parsePreferences(preferences);
  boolean(reduceMotion, 'reduceMotion');
  boolean(assetReady, 'assetReady');
  const mascotVisible = saved.mascot !== 'none' && assetReady;
  return Object.freeze({
    appMode: saved.appMode,
    mascot: saved.mascot,
    animationStyle: reduceMotion || !mascotVisible ? 'static' : saved.animationStyle,
    mascotVisible,
    equivalence,
  });
}

function performedTotals(sets) {
  let confirmedSets = 0, repetitions = 0, volumeKg = 0;
  for (const set of sets) {
    if (set.status !== 'confirmed') continue;
    confirmedSets += 1;
    repetitions += set.reps;
    volumeKg += set.reps * set.weightKg;
  }
  return Object.freeze({ confirmedSets, repetitions, volumeKg });
}

/** Targets remain separate from performed facts, including while a session is active. */
export function deriveWorkoutSummary(session) {
  const confirmed = parseSession(session);
  const occurrences = confirmed.occurrences.map(occurrence => Object.freeze({
    occurrenceId: occurrence.id,
    exerciseId: occurrence.exerciseId,
    position: occurrence.position,
    target: Object.freeze({
      itemId: occurrence.itemId,
      setTarget: occurrence.target.setTarget,
      repMin: occurrence.target.repMin,
      repMax: occurrence.target.repMax,
      targetKg: occurrence.target.targetKg,
    }),
    performed: performedTotals(confirmed.sets.filter(set => set.occurrenceId === occurrence.id)),
  }));
  return Object.freeze({
    sessionId: confirmed.id,
    status: confirmed.status,
    revision: confirmed.revision,
    readOnly: confirmed.status === 'completed',
    performed: performedTotals(confirmed.sets),
    occurrences: Object.freeze(occurrences),
    units,
  });
}

/** A page, even its final cursor, cannot establish coverage before its request cursor. */
export function deriveHistoryWindow(history) {
  const confirmed = parseHistory(history);
  const times = confirmed.items.map(item => item.startedAt).sort((a, b) => Date.parse(a) - Date.parse(b));
  const hasMore = confirmed.nextBefore !== null;
  return Object.freeze({
    loadedCount: confirmed.items.length,
    activeCount: confirmed.items.filter(item => item.status === 'active').length,
    completedCount: confirmed.items.filter(item => item.status === 'completed').length,
    hasMore,
    nextBefore: confirmed.nextBefore,
    coverage: Object.freeze({
      scope: 'loaded-window',
      oldestStartedAt: times[0] ?? null,
      newestStartedAt: times.at(-1) ?? null,
      olderItemsRemain: hasMore,
      newerCoverage: 'unknown',
      allHistory: false,
      weekComplete: false,
    }),
  });
}

const operationStates = new Set(['idle', 'loading', 'processing', 'response', 'error', 'cancelled', 'disconnected', 'unknown']);

/** Observe caller evidence only. Shared READY design owns all labels and visual state bindings. */
export function deriveOperationPresentation(operation) {
  if (!operation || typeof operation !== 'object' || Array.isArray(operation) ||
      !Object.hasOwn(operation, 'state') || !operationStates.has(operation.state) ||
      !Object.hasOwn(operation, 'retrievalEvidence')) {
    throw new TypeError('Explicit operation state and retrievalEvidence are required');
  }
  const evidence = operation.retrievalEvidence;
  if (evidence !== null && (typeof evidence !== 'object' || Array.isArray(evidence))) {
    throw new TypeError('retrievalEvidence must be an evidence object or explicit null');
  }
  const resultAvailable = boolean(operation.resultAvailable, 'resultAvailable');
  return Object.freeze({
    state: operation.state,
    activityOngoing: ['loading', 'processing', 'response'].includes(operation.state),
    resultAvailable,
    retrievalEvidencePresent: evidence !== null,
    // Evidence presence alone establishes neither retrieval meaning nor a provider/voice contract.
    claimsPaperRetrieval: false,
    claimsAudioPlayback: false,
    claimsLipSync: false,
    visualBinding: null,
    equivalence,
  });
}
