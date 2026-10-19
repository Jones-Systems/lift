import { ApiError } from '../../api/transport';
import type { FeatureSlotContext } from '../contract';

export type BugReporterOutcomeStatus = 'unavailable' | 'investigation_pending' | 'owner_decision_pending' | 'expected_behavior'
  | 'decision_recorded' | 'fix_unverified' | 'fix_verified';
export type BugReporterOutcome = Readonly<{
  schema: 'form.bug-reporter-outcome/v1'; reportId: string; status: BugReporterOutcomeStatus;
  verificationScope: 'cited_checks_only'; requiredChecks: number; passedChecks: number;
}>;
export type BugReporterOutcomePort = Readonly<{
  read(reportId: string): Promise<unknown>;
  // Root must bind this to current permission for the exact reporter-safe projection, not structural validity alone.
  assertCurrent(reportId: string, summary: BugReporterOutcome): void;
}>;
export type BugOutcomeConsumerBinding = Pick<FeatureSlotContext, 'resources' | 'sessionGeneration' | 'isCurrentSession'>;
export type BugOutcomeConsumerState = Readonly<{
  phase: 'idle' | 'loading' | 'ready' | 'unavailable'; reportId: string | null; outcome: BugReporterOutcome | null;
}>;
const statuses: readonly string[] = ['unavailable', 'investigation_pending', 'owner_decision_pending', 'expected_behavior',
  'decision_recorded', 'fix_unverified', 'fix_verified'];
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const invalid = () => new ApiError(502, 'invalid_bug_outcome', 'The report outcome could not be confirmed.');
/** Validates the closed display shape only; the injected port must separately qualify disclosure. */
export function parseBugReporterOutcome(raw: unknown, requestedReportId: string): BugReporterOutcome {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw invalid();
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).sort().join(',') !== 'passedChecks,reportId,requiredChecks,schema,status,verificationScope'
    || value.schema !== 'form.bug-reporter-outcome/v1' || !uuid.test(requestedReportId) || value.reportId !== requestedReportId
    || typeof value.status !== 'string' || !statuses.includes(value.status) || value.verificationScope !== 'cited_checks_only'
    || typeof value.requiredChecks !== 'number' || !Number.isSafeInteger(value.requiredChecks) || value.requiredChecks < 0 || value.requiredChecks > 16
    || typeof value.passedChecks !== 'number' || !Number.isSafeInteger(value.passedChecks) || value.passedChecks < 0 || value.passedChecks > value.requiredChecks
    || value.status === 'fix_verified' && (value.requiredChecks === 0 || value.passedChecks !== value.requiredChecks)
    || !['fix_verified', 'fix_unverified'].includes(value.status) && (value.requiredChecks !== 0 || value.passedChecks !== 0)) throw invalid();
  return Object.freeze({ schema: 'form.bug-reporter-outcome/v1', reportId: requestedReportId, status: value.status as BugReporterOutcomeStatus,
    verificationScope: 'cited_checks_only', requiredChecks: value.requiredChecks, passedChecks: value.passedChecks });
}
export function createBugOutcomeConsumer(binding: BugOutcomeConsumerBinding, port?: BugReporterOutcomePort) {
  if (!binding.sessionGeneration) throw new Error('bug_outcome_session_binding_required');
  const api = binding.resources.api, auth = api.captureAuthContext(), isCurrentSession = binding.isCurrentSession;
  let active = true, request = 0;
  let state: BugOutcomeConsumerState = Object.freeze({ phase: 'idle', reportId: null, outcome: null });
  const observers = new Set<(value: BugOutcomeConsumerState) => void>();
  const publish = () => { for (const observer of observers) observer(getState()); };
  const invalidate = () => {
    if (!active) return;
    active = false; request++; state = Object.freeze({ phase: 'unavailable', reportId: null, outcome: null });
    publish(); observers.clear();
  };
  const current = () => {
    if (active && (!auth.isCurrent() || !isCurrentSession())) invalidate();
    return active;
  };
  const getState = (): BugOutcomeConsumerState => { current(); return state; };
  const subscription = api.subscribeAuthChanges(invalidate);
  return Object.freeze({
    getState,
    subscribe(observer: (value: BugOutcomeConsumerState) => void) {
      const value = getState(); if (active) observers.add(observer); observer(value);
      return { remove: () => { observers.delete(observer); } };
    },
    async load(reportId: string): Promise<void> {
      if (!current()) throw new ApiError(409, 'session_changed', 'This report session ended.');
      if (!uuid.test(reportId)) throw new ApiError(400, 'invalid_bug_report_id', 'Select a valid report.');
      const issued = ++request;
      const pending = () => current() && issued === request;
      const unavailable = () => {
        if (!pending()) return;
        state = Object.freeze({ phase: 'unavailable', reportId, outcome: null }); publish();
      };
      if (!port) { unavailable(); return; }
      state = Object.freeze({ phase: 'loading', reportId, outcome: null }); publish();
      if (!pending()) return;
      try {
        const raw = await port.read(reportId);
        if (!pending()) return;
        const summary = parseBugReporterOutcome(raw, reportId);
        if (!pending()) return;
        port.assertCurrent(reportId, summary);
        if (!pending()) return;
        state = Object.freeze({ phase: summary.status === 'unavailable' ? 'unavailable' : 'ready', reportId, outcome: summary }); publish();
      } catch { unavailable(); }
    },
    dispose() { invalidate(); subscription.remove(); observers.clear(); },
  });
}
export type BugOutcomeConsumer = ReturnType<typeof createBugOutcomeConsumer>;
