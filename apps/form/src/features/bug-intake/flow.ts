import { ApiError } from '../../api/transport';
import { canonicalBugReport, type BugDiagnostics, type BugReportQuery, type CanonicalBugReportInput } from '../../api/bugIntake';
import type { FeatureSlotContext } from '../contract';
import { bugIntakeCopy, type BugIntakeState } from './model';
import { createBugIntakeSession } from './session';

export type BugIntakeFlowBinding = Pick<FeatureSlotContext, 'resources' | 'sessionGeneration' | 'isCurrentSession'>;
export type BugReportReview = Readonly<{
  reviewRevision: number;
  payload: CanonicalBugReportInput;
  privacy: string;
  diagnosticsNotice: string;
}>;
export type BugIntakeFlowState = Readonly<Omit<BugIntakeState, 'canSubmit'> & {
  review: BugReportReview | null;
  canReview: boolean;
  canSubmitReviewed: boolean;
}>;

/** A member reviews private report content here; this confirmation is not evidence review or execution approval. */
export function createBugIntakeFlow(binding: BugIntakeFlowBinding, newSecureKey: () => string) {
  const session = createBugIntakeSession({ sessionGeneration: binding.sessionGeneration,
    isCurrentSession: binding.isCurrentSession, api: binding.resources.api }, newSecureKey);
  const controller = session.controller;
  let review: BugReportReview | null = null, revision = 0;
  const observers = new Set<(state: BugIntakeFlowState) => void>();
  const currentState = () => {
    const state = controller.getState();
    if (!state.canEdit) review = null;
    return state;
  };
  const requireCurrent = () => {
    const state = currentState();
    if (state.phase === 'unavailable') throw new ApiError(409, 'session_changed', 'This report session ended.');
    return state;
  };
  const getState = (): BugIntakeFlowState => {
    const { canSubmit, ...state } = currentState();
    return { ...state, review, canReview: canSubmit, canSubmitReviewed: canSubmit && review !== null };
  };
  const publish = () => { for (const observer of observers) observer(getState()); };
  const subscription = controller.subscribe(state => {
    if (!state.canEdit) review = null;
    publish();
    if (state.phase === 'unavailable') observers.clear();
  });
  return Object.freeze({
    getState,
    subscribe(observer: (state: BugIntakeFlowState) => void) {
      const state = getState();
      if (state.phase !== 'unavailable') observers.add(observer);
      observer(state);
      return { remove: () => { observers.delete(observer); } };
    },
    edit(fields: Readonly<{ title?: string; description?: string }>) {
      requireCurrent(); review = null;
      try { controller.edit(fields); } finally { publish(); }
    },
    setDiagnostics(consent: boolean, details?: BugDiagnostics) {
      requireCurrent(); review = null;
      try { controller.setDiagnostics(consent, details); } finally { publish(); }
    },
    review(): BugReportReview {
      const state = requireCurrent();
      if (!state.canEdit) throw new ApiError(409, 'bug_submission_pending', 'Resolve the current report before reviewing another.');
      const payload = canonicalBugReport(state.draft);
      const prepared = Object.freeze({ reviewRevision: ++revision, payload, privacy: bugIntakeCopy.privacy,
        diagnosticsNotice: bugIntakeCopy.diagnostics });
      review = prepared; publish(); requireCurrent();
      if (review !== prepared) throw new ApiError(409, 'bug_review_required', 'Review the current report before sending.');
      return prepared;
    },
    async submitReviewed(reviewRevision: number): Promise<void> {
      const state = requireCurrent(), prepared = review;
      if (!prepared || !state.canSubmit || prepared.reviewRevision !== reviewRevision
        || JSON.stringify(canonicalBugReport(state.draft)) !== JSON.stringify(prepared.payload))
        throw new ApiError(409, 'bug_review_required', 'Review the current report before sending.');
      review = null;
      await controller.submit();
    },
    async retrySubmission(): Promise<void> { requireCurrent(); await controller.retrySubmission(); },
    beginNew() {
      requireCurrent(); review = null;
      try { controller.beginNew(); } finally { publish(); }
    },
    async refresh(query: BugReportQuery = {}): Promise<void> { requireCurrent(); await controller.refresh(query); },
    async loadReport(id: string): Promise<void> { requireCurrent(); await controller.loadReport(id); },
    dispose() { review = null; session.dispose(); subscription.remove(); observers.clear(); },
  });
}
export type BugIntakeFlow = ReturnType<typeof createBugIntakeFlow>;
