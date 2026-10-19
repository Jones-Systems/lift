import { MANUAL_RETENTION_PROTOCOL, MANUAL_RETENTION_STATEMENT_SHA256, captureManualRetentionCurrent, isManualRetentionDecisionId, type ManualRetentionCurrent, type ManualRetentionAttemptAuthority } from './manualRetentionContract';
import { BODY_CAPABILITIES } from './capabilities';
import type { ClearReason } from './session';
import type { ManualMeasurementAvailability, ManualMeasurementInput } from './manualMeasurements';

// Product-purpose restrictions, not proof of native, vendor or backup behavior.
export const BODY_RETENTION_POLICY = Object.freeze({
  photosPurpose: 'personal_progress_comparison',
  derivedPurpose: 'personal_measurement_progress',
  audience: 'same_user_only',
  rankings: false,
  sale: false,
  promotionalReuse: false,
  researchReuse: false,
  modelTrainingReuse: false,
  nativePersistence: 'unqualified',
  cachePersistence: 'unqualified',
  vendorPersistence: 'unqualified',
  backupDeletion: 'unqualified',
  noSaveGuarantee: false,
} as const);

export type RetentionPurpose = 'photos' | 'derived';
export type RetentionProcessingChoice = 'manual_entry';
export type RetentionChoice = Readonly<{ choice: 'unset' | 'session_only'; consentVersion: null }
  | { choice: 'retain'; consentVersion: string }>;
export type RetentionFence = Readonly<{ accountId: string; generation: number }>;
type DeletionRequest = Readonly<{ measurementId: string; key: string; generation: number }>;
export type MeasurementDeletion = Readonly<{ status: 'not_requested' }
  | ({ status: 'pending' | 'unknown' | 'failed' | 'confirmed' } & DeletionRequest)>;
export type RetentionState = Readonly<RetentionFence & {
  processing: RetentionProcessingChoice | null;
  manualDecision: Readonly<{ decisionId: string; current: ManualRetentionCurrent | null; stopped: boolean;
    grant: 'pending' | 'unknown' | 'failed' | 'confirmed'; revoke: 'not_requested' | 'pending' | 'unknown' | 'failed' | 'confirmed' }> | null;
  choices: Readonly<Record<RetentionPurpose, RetentionChoice>>;
  stagedMeasurements: readonly ManualMeasurementInput[];
  deletion: Readonly<{ photos: Readonly<{ status: 'unavailable' }>; derived: MeasurementDeletion }>;
}>;

type RetentionCommand =
  | { type: 'grant_started'; decisionId: string }
  | { type: 'control_result'; decisionId: string; operation: 'grant' | 'revoke'; outcome: 'pending' | 'unknown' | 'failed' | 'confirmed'; current?: ManualRetentionCurrent }
  | { type: 'current_result'; decisionId: string; current: ManualRetentionCurrent | null }
  | { type: 'choose_processing'; choice: RetentionProcessingChoice }
  | { type: 'choose'; purpose: RetentionPurpose; choice: 'session_only' }
  | { type: 'choose'; purpose: RetentionPurpose; choice: 'retain'; consentVersion: string }
  | { type: 'stage_measurement'; measurement: ManualMeasurementInput }
  | { type: 'revoke'; purpose: RetentionPurpose }
  | { type: 'clear'; reason: ClearReason }
  | { type: 'account'; nextAccountId: string }
  | { type: 'deletion_started'; purpose: RetentionPurpose; measurementId: string; key: string }
  | { type: 'deletion_result'; purpose: RetentionPurpose; measurementId: string; key: string;
      outcome: 'unknown' | 'failed' | 'confirmed'; response?: unknown };
// The caller stamps events when work begins, and supplies deletion outcomes from the matching manual client command.
// This reducer dispatches nothing; reusing a new session's stamp for an old result is not an accepted completion.
export type RetentionEvent = RetentionFence & RetentionCommand;

const unset = (): RetentionChoice => Object.freeze({ choice: 'unset', consentVersion: null });
function seal(state: RetentionState): RetentionState {
  Object.freeze(state.choices.photos); Object.freeze(state.choices.derived); Object.freeze(state.choices);
  for (const measurement of state.stagedMeasurements) Object.freeze(measurement);
  Object.freeze(state.stagedMeasurements);
  Object.freeze(state.deletion.photos); Object.freeze(state.deletion.derived); Object.freeze(state.deletion);
  if (state.manualDecision) Object.freeze(state.manualDecision);
  return Object.freeze(state);
}

export function createRetentionSession(accountId: string, generation = 0): RetentionState {
  return seal({ accountId, generation, processing: null, manualDecision: null,
    choices: { photos: unset(), derived: unset() }, stagedMeasurements: [],
    deletion: { photos: { status: 'unavailable' }, derived: { status: 'not_requested' } } });
}

const matches = (state: RetentionState, fence: RetentionFence) =>
  state.accountId === fence.accountId && state.generation === fence.generation;

export type RetentionPermission = Readonly<{ allowed: boolean;
  reason: 'allowed' | 'stale_session' | 'processing_not_chosen' | 'retention_not_chosen' | 'capability_unavailable' | 'grant_unconfirmed' }>;

// Manual evidence comes from the fenced client's capabilities(); that client still rechecks before every write.
// No caller-supplied capability can qualify photo capture or retained photos.
export function retentionPermission(state: RetentionState, purpose: RetentionPurpose, fence: RetentionFence,
  manual?: ManualMeasurementAvailability): RetentionPermission {
  if (!matches(state, fence)) return { allowed: false, reason: 'stale_session' };
  if (state.processing !== 'manual_entry') return { allowed: false, reason: 'processing_not_chosen' };
  if (state.choices[purpose].choice !== 'retain') return { allowed: false, reason: 'retention_not_chosen' };
  if (purpose === 'derived' && !manualRetentionAuthority(state)) return { allowed: false, reason: 'grant_unconfirmed' };
  const qualified = purpose === 'derived' ? manual?.create === true
    : BODY_CAPABILITIES.cameraCapture.status === 'qualified' && BODY_CAPABILITIES.retainedPhotos.status === 'qualified';
  return qualified ? { allowed: true, reason: 'allowed' } : { allowed: false, reason: 'capability_unavailable' };
}

export function manualRetentionAuthority(state: RetentionState): ManualRetentionAttemptAuthority | null {
  const decision = state.manualDecision;
  if (state.processing !== 'manual_entry' || state.choices.derived.choice !== 'retain'
    || state.choices.derived.consentVersion !== MANUAL_RETENTION_PROTOCOL || decision?.grant !== 'confirmed'
    || decision.stopped || decision.revoke !== 'not_requested' || decision.current?.state !== 'granted') return null;
  return Object.freeze({ protocol: MANUAL_RETENTION_PROTOCOL, decisionId: decision.decisionId,
    revision: 1, statementSha256: MANUAL_RETENTION_STATEMENT_SHA256 });
}

function stopRetention(state: RetentionState, purpose: RetentionPurpose): RetentionState {
  const prior = state.deletion.derived;
  return seal({ ...state, generation: state.generation + 1, stagedMeasurements: [],
    manualDecision: purpose === 'derived' && state.manualDecision
      ? { ...state.manualDecision, stopped: true } : state.manualDecision,
    choices: { ...state.choices, [purpose]: { choice: 'session_only', consentVersion: null } },
    deletion: { ...state.deletion,
      derived: prior.status === 'pending' ? { ...prior, status: 'unknown' } : prior } });
}

export function retentionReducer(state: RetentionState, event: RetentionEvent): RetentionState {
  if (!matches(state, event)) return state;
  switch (event.type) {
    case 'grant_started':
      if (!isManualRetentionDecisionId(event.decisionId) || state.manualDecision?.decisionId === event.decisionId
        || state.processing !== 'manual_entry' || state.choices.derived.choice !== 'retain'
        || state.choices.derived.consentVersion !== MANUAL_RETENTION_PROTOCOL) return state;
      return seal({ ...state, manualDecision: { decisionId: event.decisionId, current: null, stopped: false,
        grant: 'pending', revoke: 'not_requested' } });
    case 'control_result': {
      const prior = state.manualDecision;
      if (!prior || prior.decisionId !== event.decisionId) return state;
      const current = event.current === undefined ? prior.current : captureManualRetentionCurrent(event.current);
      if (event.current !== undefined && (!current || current.decisionId !== prior.decisionId)) return state;
      // Revocation is terminal locally too: late grant/current reads cannot resurrect its authority.
      const retained = prior.current?.state === 'revoked' ? prior.current : current;
      return seal({ ...state, manualDecision: { ...prior, current: retained, [event.operation]: event.outcome } });
    }
    case 'current_result': {
      const prior = state.manualDecision;
      if (!prior || prior.decisionId !== event.decisionId) return state;
      const current = event.current === null ? null : captureManualRetentionCurrent(event.current);
      if (event.current !== null && (!current || current.decisionId !== prior.decisionId)) return state;
      // A read may withdraw authority, never establish a grant receipt or a new choice.
      if (current?.state === 'granted') return state;
      return seal({ ...state, manualDecision: { ...prior,
        current: prior.current?.state === 'revoked' ? prior.current : current } });
    }
    case 'account':
      return event.nextAccountId === state.accountId ? state : createRetentionSession(event.nextAccountId, state.generation + 1);
    case 'clear':
      // Drop this model's references and choices; this does not erase remote data or prove native zero persistence.
      return createRetentionSession(state.accountId, state.generation + 1);
    case 'choose_processing':
      return event.choice === 'manual_entry' ? seal({ ...state, processing: event.choice }) : state;
    case 'choose':
      if (event.choice === 'session_only') return stopRetention(state, event.purpose);
      if (event.choice !== 'retain' || !event.consentVersion?.trim()) return state;
      return seal({ ...state, choices: { ...state.choices,
        [event.purpose]: { choice: 'retain', consentVersion: event.consentVersion } } });
    case 'stage_measurement':
      return state.processing === 'manual_entry'
        ? seal({ ...state, stagedMeasurements: [...state.stagedMeasurements, { ...event.measurement }] }) : state;
    case 'revoke':
      return stopRetention(state, event.purpose);
    case 'deletion_started': {
      if (event.purpose !== 'derived' || !event.measurementId || !event.key) return state;
      const prior = state.deletion.derived;
      if ((prior.status === 'pending' || prior.status === 'unknown')
        && (prior.measurementId !== event.measurementId || prior.key !== event.key)) return state;
      return seal({ ...state, deletion: { ...state.deletion, derived: { status: 'pending',
        measurementId: event.measurementId, key: event.key, generation: state.generation } } });
    }
    case 'deletion_result': {
      const prior = state.deletion.derived;
      if (event.purpose !== 'derived' || (prior.status !== 'pending' && prior.status !== 'unknown')
        || prior.generation !== event.generation || prior.measurementId !== event.measurementId || prior.key !== event.key) return state;
      // Only the matching command's exact accepted response confirms that one measurement, never all retained data.
      const response = event.response;
      const accepted = response !== null && typeof response === 'object' && !Array.isArray(response)
        && Object.keys(response).join(',') === 'deleted' && (response as { deleted?: unknown }).deleted === true;
      const status = event.outcome === 'confirmed' ? (accepted ? 'confirmed' : 'unknown') : event.outcome;
      return seal({ ...state, deletion: { ...state.deletion, derived: { ...prior, status } } });
    }
  }
}
