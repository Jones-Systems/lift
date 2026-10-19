import { ApiError } from '../../api/transport';
import { bugReportKey, bugReportLimits, canonicalBugReport, type BugDiagnostics, type BugIntakeResources,
  type BugReport, type BugReportQuery, type CanonicalBugReportInput } from '../../api/bugIntake';
import { emptyBugDraft, type BugDraft, type BugIntakePhase, type BugIntakeReason, type BugIntakeState } from './model';

type PendingSubmission = Readonly<{ key: string; payload: CanonicalBugReportInput }>;
export type BugIntakePort = Pick<BugIntakeResources, 'isCurrent' | 'submit' | 'get' | 'list'>;
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const changed = () => new ApiError(409, 'session_changed', 'This report session ended.');

export class BugIntakeController {
  private active = true;
  private phase: BugIntakePhase = 'editing';
  private draft: BugDraft = emptyBugDraft();
  private submitted: BugReport | null = null;
  private reports: readonly BugReport[] = [];
  private selected: BugReport | null = null;
  private reason: BugIntakeReason | null = null;
  private readReason: 'read_unavailable' | null = null;
  private reading = false;
  private writeStarted = false;
  private originalEffectUnknown = false;
  private pending: PendingSubmission | null = null;
  private readonly observers = new Set<(state: BugIntakeState) => void>();

  constructor(private readonly resources: BugIntakePort, private readonly newKey: () => string) {}

  getState(): BugIntakeState {
    this.current();
    const canEdit = this.active && ['editing', 'rejected'].includes(this.phase);
    let valid = false;
    if (canEdit) { try { canonicalBugReport(this.draft); valid = true; } catch { /* Incomplete drafts are editable, never dispatchable. */ } }
    return copy({ phase: this.phase, draft: this.draft, submitted: this.submitted, reports: this.reports, selected: this.selected,
      reading: this.reading, reason: this.reason, readReason: this.readReason, originalEffectUnknown: this.originalEffectUnknown,
      canEdit, canSubmit: canEdit && valid, canRetrySubmission: this.active && this.phase === 'submission_unknown' && !!this.pending && this.reason !== 'idempotency_conflict' });
  }
  subscribe(observer: (state: BugIntakeState) => void): { remove(): void } {
    if (this.current()) this.observers.add(observer);
    observer(this.getState());
    return { remove: () => { this.observers.delete(observer); } };
  }
  edit(fields: Readonly<{ title?: string; description?: string }>): void {
    this.requireEditable();
    if (!fields || typeof fields !== 'object' || Array.isArray(fields) || Object.keys(fields).some(key => key !== 'title' && key !== 'description')
      || fields.title !== undefined && (typeof fields.title !== 'string' || fields.title.length > bugReportLimits.title)
      || fields.description !== undefined && (typeof fields.description !== 'string' || fields.description.length > bugReportLimits.description))
      throw new ApiError(422, 'invalid_bug_report', 'Check the report fields.');
    this.draft = { ...this.draft, ...(fields.title === undefined ? {} : { title: fields.title }),
      ...(fields.description === undefined ? {} : { description: fields.description }) };
    this.phase = 'editing'; this.reason = null; this.publish();
  }
  setDiagnostics(consent: boolean, details?: BugDiagnostics): void {
    this.requireEditable();
    if (typeof consent !== 'boolean') throw new ApiError(422, 'invalid_bug_report', 'Choose whether to include technical details.');
    const checked = canonicalBugReport({ title: 'Diagnostic validation', description: 'Diagnostic validation', diagnosticConsent: consent,
      ...(consent && details !== undefined ? { diagnostics: details } : {}) });
    this.draft = { title: this.draft.title, description: this.draft.description, diagnosticConsent: consent,
      ...(checked.diagnostics === undefined ? {} : { diagnostics: checked.diagnostics }) };
    this.phase = 'editing'; this.reason = null; this.publish();
  }
  beginNew(): void {
    this.requireCurrent();
    if (this.phase === 'submitting' || this.phase === 'submission_unknown') throw new ApiError(409, 'bug_submission_pending', 'Resolve the current report before starting another.');
    this.draft = emptyBugDraft(); this.pending = null; this.submitted = null;
    this.phase = 'editing'; this.reason = null; this.originalEffectUnknown = false; this.publish();
  }
  async submit(): Promise<void> {
    this.requireCurrent();
    if (this.phase === 'submitting') return;
    this.requireEditable();
    try {
      const payload = canonicalBugReport(this.draft);
      const key = bugReportKey(this.newKey());
      this.pending = Object.freeze({ key, payload });
    } catch {
      this.phase = 'rejected'; this.reason = 'invalid_input'; this.pending = null; this.publish(); return;
    }
    await this.attempt(false);
  }
  async retrySubmission(): Promise<void> {
    this.requireCurrent();
    if (this.phase === 'submitting') return;
    if (this.phase !== 'submission_unknown' || !this.pending || this.reason === 'idempotency_conflict')
      throw new ApiError(409, 'bug_retry_unavailable', 'There is no report available for this retry.');
    await this.attempt(true);
  }
  async refresh(query: BugReportQuery = {}): Promise<void> {
    await this.read(async () => { const reports = await this.resources.list(query); return () => { this.reports = reports; }; });
  }
  async loadReport(id: string): Promise<void> {
    await this.read(async () => { const report = await this.resources.get(id); return () => { this.selected = report; }; });
  }
  invalidate(reason: 'session_changed' | 'disposed' | 'authentication_required' | 'account_disabled' = 'session_changed', unknown = false): void {
    if (!this.active) { this.originalEffectUnknown ||= unknown; return; }
    this.originalEffectUnknown ||= unknown || this.writeStarted || this.phase === 'submission_unknown';
    this.active = false; this.phase = 'unavailable'; this.reason = reason;
    this.draft = emptyBugDraft(); this.pending = null; this.submitted = null; this.reports = []; this.selected = null;
    this.reading = false; this.readReason = null; this.writeStarted = false;
    this.publish(); this.observers.clear();
  }
  dispose(): void { this.invalidate('disposed'); }

  private current(): boolean {
    if (this.active && !this.resources.isCurrent()) this.invalidate('session_changed');
    return this.active;
  }
  private requireCurrent(): void { if (!this.current()) throw changed(); }
  private requireEditable(): void {
    this.requireCurrent();
    if (!['editing', 'rejected'].includes(this.phase)) throw new ApiError(409, 'bug_submission_pending', 'Resolve the current report before editing.');
  }
  private publish(): void { for (const observer of this.observers) observer(this.getState()); }
  private sessionFailure(error: unknown): boolean {
    if (!(error instanceof ApiError)) return false;
    if (error.code === 'session_changed' || error.originalEffectUnknown || error.status === 401 || error.code === 'account_disabled') {
      this.invalidate(error.status === 401 ? 'authentication_required' : error.code === 'account_disabled' ? 'account_disabled' : 'session_changed',
        error.effectUnknown || error.originalEffectUnknown);
      return true;
    }
    return false;
  }
  private async attempt(wasUnknown: boolean): Promise<void> {
    const command = this.pending!;
    this.phase = 'submitting'; this.reason = null; this.publish();
    if (!this.current()) return;
    this.writeStarted = true;
    try {
      const result = await this.resources.submit(command.payload, command.key);
      if (!this.current()) return;
      this.submitted = result.report; this.pending = null; this.draft = emptyBugDraft();
      this.phase = 'submitted'; this.reason = null; this.originalEffectUnknown = false;
    } catch (error) {
      if (this.sessionFailure(error) || !this.current()) return;
      const conflict = error instanceof ApiError && error.code === 'idempotency_key_conflict';
      if (wasUnknown || !(error instanceof ApiError) || error.effectUnknown || error.status === 0 || error.status >= 500) {
        // A later rejection cannot erase the unresolved effect of an earlier attempt with this same command.
        this.phase = 'submission_unknown'; this.reason = conflict ? 'idempotency_conflict' : 'submission_unconfirmed';
      } else {
        this.phase = 'rejected'; this.pending = null;
        this.reason = conflict ? 'idempotency_conflict' : error.status === 429 ? 'report_limit' : 'submission_rejected';
      }
    } finally { this.writeStarted = false; if (this.current()) this.publish(); }
  }
  private async read(operation: () => Promise<() => void>): Promise<void> {
    this.requireCurrent();
    if (this.reading) return;
    this.reading = true; this.readReason = null; this.publish();
    try {
      if (!this.current()) return;
      const commit = await operation();
      if (this.current()) commit();
    } catch (error) {
      if (!this.sessionFailure(error) && this.current()) this.readReason = 'read_unavailable';
    } finally { this.reading = false; if (this.current()) this.publish(); }
  }
}
