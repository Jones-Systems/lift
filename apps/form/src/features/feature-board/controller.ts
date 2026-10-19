import type { FeatureBoardCapabilities, FeatureBoardResources, FeatureDetail, FeaturePage,
  FeatureCorrectionInput, FeatureCorrectionReceipt, FeatureCorrectionResult,
  FeatureQuery, FeatureSubmission, FeatureSubmissionInput, FeatureVote } from '../../api/featureBoard';
import { ApiError } from '../../api/transport';

export type BoardBrowseQuery = Omit<FeatureQuery, 'mine'>;
export type BoardLoad<T> = Readonly<
  | { status: 'idle' | 'loading' | 'stale'; value: null }
  | { status: 'ready'; value: T }
  | { status: 'unavailable'; value: null; error: ApiError }
>;
export type BoardCommandState = Readonly<{
  status: 'idle' | 'pending' | 'unknown' | 'saved' | 'stale' | 'failed' | 'unreconciled';
  error?: ApiError;
}>;
export type BoardVoteState = BoardCommandState;
export type BoardOwnQuery = Pick<FeatureQuery, 'page' | 'pageSize'>;
export type BoardReportReason = Parameters<FeatureBoardResources['report']>[1];
export type BoardReportReceipt = Readonly<{ featureId: string; receiptId: string; status: 'pending' }>;
export type BoardCorrectionInput = Omit<FeatureCorrectionInput, 'expectedRevision' | 'expectedCanonicalFeatureId'>;
export type FeatureBoardSnapshot = Readonly<{
  sessionGeneration: string;
  phase: 'active' | 'ended';
  browse: BoardLoad<FeaturePage>;
  selectedId: string | null;
  detail: BoardLoad<FeatureDetail>;
  vote: BoardVoteState;
  ownSubmissions: BoardLoad<readonly FeatureSubmission[]>;
  /** Vote-row revisions; support mutations still require the loaded feature revision. */
  ownVotes: BoardLoad<readonly FeatureVote[]>;
  withdrawal: BoardCommandState;
  capabilities: BoardLoad<FeatureBoardCapabilities>;
  submission: BoardCommandState;
  submitted: FeatureSubmission | null;
  report: BoardCommandState;
  reportReceipt: BoardReportReceipt | null;
  correction: BoardCommandState;
  correctionReceipt: FeatureCorrectionReceipt | null;
  correctionSuccessor: FeatureSubmission | null;
}>;
export type FeatureBoardControllerOptions = Readonly<{
  resources: Pick<FeatureBoardResources, 'browse' | 'detail' | 'setVote' | 'ownSubmissions' | 'withdraw' |
    'capabilities' | 'submit' | 'report' | 'ownVotes' | 'correct'>;
  sessionGeneration: string;
  isCurrentSession: () => boolean;
  keyFactory: () => string;
}>;
type VoteCommand = Readonly<{ canonicalId: string; active: boolean; expectedRevision: number; key: string }>;
type WithdrawalCommand = Readonly<{
  submissionId: string; expectedRevision: number; key: string; featureId: string; canonicalFeatureId: string;
}>;
type SubmissionCommand = Readonly<{ input: Readonly<FeatureSubmissionInput>; key: string }>;
type ReportCommand = Readonly<{ featureId: string; reason: BoardReportReason; key: string }>;
type CorrectionCommand = Readonly<{
  submissionId: string; featureId: string; input: FeatureCorrectionInput; key: string;
}>;
const apiError = (error: unknown) => error instanceof ApiError ? error :
  new ApiError(0, 'board_unavailable', 'Feature requests are unavailable.');

function snapshotCorrectionInput(input: BoardCorrectionInput): BoardCorrectionInput {
  const invalid = () => new ApiError(422, 'board_invalid_input', 'Check the feature request fields.');
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw invalid();
  const keys: readonly string[] = ['title', 'description', 'category', 'policyVersion', 'policyAccepted', 'audienceAccepted'];
  const fields: Record<string, unknown> = {};
  for (const name of Reflect.ownKeys(input)) {
    if (typeof name !== 'string' || !keys.includes(name)) throw invalid();
    const descriptor = Object.getOwnPropertyDescriptor(input, name);
    if (!descriptor?.enumerable || !('value' in descriptor)) throw invalid();
    fields[name] = descriptor.value;
  }
  if (keys.some(name => !Object.hasOwn(fields, name))) throw invalid();
  // Detach data properties without invoking accessors; the resource still validates every field value.
  return Object.freeze(fields) as BoardCorrectionInput;
}

/** One mounted session only. The owner must dispose on unmount or session replacement. */
export class FeatureBoardController {
  private readonly resources: FeatureBoardControllerOptions['resources'];
  private readonly isCurrentSession: () => boolean;
  private readonly keyFactory: () => string;
  private readonly observers = new Set<() => void>();
  private browseRequest = 0;
  private detailRequest = 0;
  private selection = 0;
  private command: VoteCommand | null = null;
  private voteBusy = false;
  private ownRequest = 0;
  private ownVotesRequest = 0;
  private ownQuery: BoardOwnQuery = {};
  private withdrawalCommand: WithdrawalCommand | null = null;
  private withdrawalBusy = false;
  private capabilitiesRequest = 0;
  private submissionCommand: SubmissionCommand | null = null;
  private submissionBusy = false;
  private reportCommand: ReportCommand | null = null;
  private reportBusy = false;
  private correctionCommand: CorrectionCommand | null = null;
  private correctionBusy = false;
  private snapshot: FeatureBoardSnapshot;

  constructor(options: FeatureBoardControllerOptions) {
    this.resources = options.resources;
    this.isCurrentSession = options.isCurrentSession;
    this.keyFactory = options.keyFactory;
    this.snapshot = { sessionGeneration: options.sessionGeneration, phase: 'active',
      browse: { status: 'idle', value: null }, selectedId: null,
      detail: { status: 'idle', value: null }, vote: { status: 'idle' },
      ownSubmissions: { status: 'idle', value: null }, ownVotes: { status: 'idle', value: null },
      withdrawal: { status: 'idle' },
      capabilities: { status: 'idle', value: null }, submission: { status: 'idle' }, submitted: null,
      report: { status: 'idle' }, reportReceipt: null,
      correction: { status: 'idle' }, correctionReceipt: null, correctionSuccessor: null };
  }

  private end() {
    if (this.snapshot.phase === 'ended') return;
    const unresolved = this.command !== null;
    const unresolvedWithdrawal = this.withdrawalCommand !== null;
    const unresolvedSubmission = this.submissionCommand !== null;
    const unresolvedReport = this.reportCommand !== null;
    const unresolvedCorrection = this.correctionCommand !== null;
    this.command = null;
    this.withdrawalCommand = null;
    this.submissionCommand = null;
    this.reportCommand = null;
    this.correctionCommand = null;
    this.browseRequest++;
    this.detailRequest++;
    this.ownRequest++;
    this.ownVotesRequest++;
    this.capabilitiesRequest++;
    this.snapshot = { sessionGeneration: this.snapshot.sessionGeneration, phase: 'ended',
      browse: { status: 'idle', value: null }, selectedId: null,
      detail: { status: 'idle', value: null }, vote: { status: unresolved ? 'unreconciled' : 'idle' },
      ownSubmissions: { status: 'idle', value: null }, ownVotes: { status: 'idle', value: null },
      withdrawal: { status: unresolvedWithdrawal ? 'unreconciled' : 'idle' },
      capabilities: { status: 'idle', value: null }, submitted: null,
      submission: { status: unresolvedSubmission ? 'unreconciled' : 'idle' },
      report: { status: unresolvedReport ? 'unreconciled' : 'idle' }, reportReceipt: null,
      correction: { status: unresolvedCorrection ? 'unreconciled' : 'idle' },
      correctionReceipt: null, correctionSuccessor: null };
    this.observers.clear();
  }

  private current() {
    if (this.snapshot.phase === 'ended') return false;
    if (!this.isCurrentSession()) { this.end(); return false; }
    return true;
  }

  private publish(changes: Partial<FeatureBoardSnapshot>) {
    if (!this.current()) return;
    this.snapshot = { ...this.snapshot, ...changes };
    for (const observer of this.observers) {
      if (!this.current()) break;
      observer();
    }
  }

  getSnapshot = (): FeatureBoardSnapshot => { this.current(); return this.snapshot; };
  subscribe = (observer: () => void): (() => void) => {
    if (this.current()) this.observers.add(observer);
    return () => { this.observers.delete(observer); };
  };
  dispose = () => { this.end(); };

  browse = async (query: BoardBrowseQuery = {}): Promise<void> => {
    if (!this.current()) return;
    if ('mine' in query) throw new ApiError(422, 'board_invalid_input', 'This board only browses public requests.');
    const request = ++this.browseRequest;
    this.publish({ browse: { status: 'loading', value: null } });
    if (!this.current() || request !== this.browseRequest) return;
    try {
      const value = await this.resources.browse({ ...query });
      if (!this.current() || request !== this.browseRequest) return;
      this.publish({ browse: { status: 'ready', value } });
    } catch (error) {
      if (!this.current() || request !== this.browseRequest) return;
      if (error instanceof ApiError && error.code === 'session_changed') { this.end(); return; }
      this.publish({ browse: { status: 'unavailable', value: null, error: apiError(error) } });
    }
  };

  openDetail = async (id: string): Promise<void> => {
    if (!this.current()) return;
    this.selection++;
    await this.loadDetail(id);
    this.current();
  };

  private async loadDetail(id: string) {
    if (!this.current()) return;
    const request = ++this.detailRequest;
    this.publish({ selectedId: id, detail: { status: 'loading', value: null } });
    if (!this.current() || request !== this.detailRequest) return;
    try {
      const value = await this.resources.detail(id);
      if (!this.current() || request !== this.detailRequest) return;
      this.publish({ detail: { status: 'ready', value } });
    } catch (error) {
      if (!this.current() || request !== this.detailRequest) return;
      if (error instanceof ApiError && error.code === 'session_changed') { this.end(); return; }
      this.publish({ detail: { status: 'unavailable', value: null, error: apiError(error) } });
    }
  }

  setSupport = async (active: boolean): Promise<void> => {
    if (!this.current() || this.voteBusy || this.command || this.withdrawalBusy || this.withdrawalCommand ||
      this.submissionBusy || this.submissionCommand || this.reportBusy || this.reportCommand ||
      this.correctionBusy || this.correctionCommand ||
      this.snapshot.detail.status !== 'ready') return;
    const detail = this.snapshot.detail.value;
    const command = Object.freeze({ canonicalId: detail.canonicalId, active,
      expectedRevision: detail.feature.revision, key: this.keyFactory() });
    if (!this.current()) return;
    this.command = command;
    await this.sendVote(command, false);
    this.current();
  };

  retryUncertainVote = async (): Promise<void> => {
    if (!this.current() || this.voteBusy || !this.command || this.snapshot.vote.status !== 'unknown') return;
    await this.sendVote(this.command, true);
    this.current();
  };

  private async sendVote(command: VoteCommand, retry: boolean) {
    if (!this.current()) return;
    this.voteBusy = true;
    const selectedId = this.snapshot.selectedId;
    const selection = this.selection;
    this.publish({ vote: { status: 'pending' } });
    try {
      if (!this.current()) return;
      await this.resources.setVote(command.canonicalId, command.active, command.expectedRevision, command.key);
      if (!this.current()) return;
      this.command = null;
      await this.refreshAfterVote('saved', selectedId, selection);
      this.current();
    } catch (error) {
      if (!this.current()) return;
      const failure = apiError(error);
      if (failure.code === 'session_changed') { this.end(); return; }
      if (failure.effectUnknown || failure.originalEffectUnknown) {
        this.publish({ vote: { status: 'unknown', error: failure } });
      } else if (failure.code === 'stale_revision') {
        this.command = null;
        await this.refreshAfterVote('stale', selectedId, selection);
        this.current();
      } else {
        // A failed reconciliation request does not prove the original command failed.
        if (!retry) this.command = null;
        this.publish({ vote: { status: retry ? 'unknown' : 'failed', error: failure } });
      }
    } finally {
      this.voteBusy = false;
    }
  }

  private async refreshAfterVote(status: 'saved' | 'stale', id: string | null, selection: number) {
    if (!this.current()) return;
    this.browseRequest++;
    this.ownVotesRequest++;
    const refresh = id !== null && this.selection === selection;
    if (refresh) this.detailRequest++;
    this.publish({ browse: { status: 'stale', value: null }, ownVotes: { status: 'stale', value: null }, vote: { status },
      ...(refresh ? { detail: { status: 'stale' as const, value: null } } : {}) });
    if (!this.current() || !refresh || this.selection !== selection) return;
    await this.loadDetail(id);
    this.current();
  }

  loadOwnSubmissions = async (query: BoardOwnQuery = {}): Promise<void> => {
    if (!this.current()) return;
    const request = ++this.ownRequest;
    const input = { ...query };
    this.ownQuery = input;
    this.publish({ ownSubmissions: { status: 'loading', value: null } });
    if (!this.current() || request !== this.ownRequest) return;
    try {
      const result = await this.resources.ownSubmissions(input);
      if (!this.current() || request !== this.ownRequest) return;
      this.publish({ ownSubmissions: { status: 'ready', value: result.submissions } });
    } catch (error) {
      if (!this.current() || request !== this.ownRequest) return;
      if (error instanceof ApiError && error.code === 'session_changed') { this.end(); return; }
      this.publish({ ownSubmissions: { status: 'unavailable', value: null, error: apiError(error) } });
    }
  };

  loadOwnVotes = async (query: BoardOwnQuery = {}): Promise<void> => {
    if (!this.current()) return;
    const request = ++this.ownVotesRequest;
    const input = { ...query };
    this.publish({ ownVotes: { status: 'loading', value: null } });
    if (!this.current() || request !== this.ownVotesRequest) return;
    try {
      const result = await this.resources.ownVotes(input);
      if (!this.current() || request !== this.ownVotesRequest) return;
      this.publish({ ownVotes: { status: 'ready', value: result.votes } });
    } catch (error) {
      if (!this.current() || request !== this.ownVotesRequest) return;
      if (error instanceof ApiError && error.code === 'session_changed') { this.end(); return; }
      this.publish({ ownVotes: { status: 'unavailable', value: null, error: apiError(error) } });
    }
  };

  withdrawSubmission = async (id: string): Promise<void> => {
    if (!this.current() || this.voteBusy || this.command || this.withdrawalBusy || this.withdrawalCommand ||
      this.submissionBusy || this.submissionCommand || this.reportBusy || this.reportCommand ||
      this.correctionBusy || this.correctionCommand ||
      this.snapshot.ownSubmissions.status !== 'ready') return;
    const row = this.snapshot.ownSubmissions.value.find(submission => submission.id === id);
    if (!row || row.visibility === 'withdrawn') return;
    const command = Object.freeze({ submissionId: row.id, expectedRevision: row.revision,
      featureId: row.featureId, canonicalFeatureId: row.canonicalFeatureId, key: this.keyFactory() });
    if (!this.current()) return;
    this.withdrawalCommand = command;
    await this.sendWithdrawal(command, false);
    this.current();
  };

  retryUncertainWithdrawal = async (): Promise<void> => {
    if (!this.current() || this.withdrawalBusy || !this.withdrawalCommand ||
      this.snapshot.withdrawal.status !== 'unknown') return;
    await this.sendWithdrawal(this.withdrawalCommand, true);
    this.current();
  };

  private async sendWithdrawal(command: WithdrawalCommand, retry: boolean) {
    if (!this.current()) return;
    this.withdrawalBusy = true;
    this.publish({ withdrawal: { status: 'pending' } });
    try {
      if (!this.current()) return;
      await this.resources.withdraw(command.submissionId, command.expectedRevision, command.key);
      if (!this.current()) return;
      this.withdrawalCommand = null;
      await this.refreshOwnProjections(command, { withdrawal: { status: 'saved' } });
      this.current();
    } catch (error) {
      if (!this.current()) return;
      const failure = apiError(error);
      if (failure.code === 'session_changed') { this.end(); return; }
      if (failure.effectUnknown || failure.originalEffectUnknown) {
        this.publish({ withdrawal: { status: 'unknown', error: failure } });
      } else if (failure.code === 'stale_revision') {
        this.withdrawalCommand = null;
        await this.refreshOwnProjections(command, { withdrawal: { status: 'stale' } });
        this.current();
      } else {
        // Failure of a retry leaves the original withdrawal unresolved.
        if (!retry) this.withdrawalCommand = null;
        this.publish({ withdrawal: { status: retry ? 'unknown' : 'failed', error: failure } });
      }
    } finally {
      this.withdrawalBusy = false;
    }
  }

  private async refreshOwnProjections(command: Pick<FeatureSubmission, 'featureId' | 'canonicalFeatureId'>,
    outcome: Partial<Pick<FeatureBoardSnapshot, 'withdrawal' | 'submission' | 'submitted'>>) {
    if (!this.current()) return;
    const request = ++this.ownRequest;
    const query = { ...this.ownQuery };
    this.browseRequest++;
    const affectedDetail = this.snapshot.selectedId === command.featureId ||
      this.snapshot.selectedId === command.canonicalFeatureId ||
      this.snapshot.detail.status === 'ready' &&
        this.snapshot.detail.value.canonicalId === command.canonicalFeatureId;
    if (affectedDetail) this.detailRequest++;
    this.publish({ ownSubmissions: { status: 'stale', value: null }, browse: { status: 'stale', value: null },
      ...outcome, ...(affectedDetail ? { detail: { status: 'stale' as const, value: null } } : {}) });
    if (!this.current() || request !== this.ownRequest) return;
    await this.loadOwnSubmissions(query);
    this.current();
  }

  loadCapabilities = async (): Promise<void> => {
    if (!this.current()) return;
    const request = ++this.capabilitiesRequest;
    this.publish({ capabilities: { status: 'loading', value: null } });
    if (!this.current() || request !== this.capabilitiesRequest) return;
    try {
      const value = await this.resources.capabilities();
      if (!this.current() || request !== this.capabilitiesRequest) return;
      this.publish({ capabilities: { status: 'ready', value } });
    } catch (error) {
      if (!this.current() || request !== this.capabilitiesRequest) return;
      if (error instanceof ApiError && error.code === 'session_changed') { this.end(); return; }
      this.publish({ capabilities: { status: 'unavailable', value: null, error: apiError(error) } });
    }
  };

  submitRequest = async (input: FeatureSubmissionInput): Promise<void> => {
    if (!this.current() || this.voteBusy || this.command || this.withdrawalBusy || this.withdrawalCommand ||
      this.submissionBusy || this.submissionCommand || this.reportBusy || this.reportCommand ||
      this.correctionBusy || this.correctionCommand) return;
    const command = Object.freeze({ input: Object.freeze({ ...input }), key: this.keyFactory() });
    if (!this.current()) return;
    this.submissionCommand = command;
    await this.sendSubmission(command, false);
    this.current();
  };

  retryUncertainSubmission = async (): Promise<void> => {
    if (!this.current() || this.submissionBusy || !this.submissionCommand ||
      this.snapshot.submission.status !== 'unknown') return;
    await this.sendSubmission(this.submissionCommand, true);
    this.current();
  };

  private async sendSubmission(command: SubmissionCommand, retry: boolean) {
    if (!this.current()) return;
    this.submissionBusy = true;
    this.publish({ submission: { status: 'pending' }, submitted: null });
    try {
      if (!this.current()) return;
      const value = await this.resources.submit(command.input, command.key);
      if (!this.current()) return;
      this.submissionCommand = null;
      if (command.input.voteOnSubmit) {
        this.ownVotesRequest++;
        this.publish({ ownVotes: { status: 'stale', value: null } });
      }
      await this.refreshOwnProjections(value, { submission: { status: 'saved' }, submitted: value });
      this.current();
    } catch (error) {
      if (!this.current()) return;
      const failure = apiError(error);
      if (failure.code === 'session_changed') { this.end(); return; }
      const visibleError = failure.code === 'board_text_rejected' ?
        new ApiError(failure.status, failure.code, 'This feature request could not be accepted.',
          failure.effectUnknown, failure.originalEffectUnknown) : failure;
      if (failure.effectUnknown || failure.originalEffectUnknown || retry && failure.code !== 'board_text_rejected') {
        this.publish({ submission: { status: 'unknown', error: visibleError } });
      } else {
        this.submissionCommand = null;
        this.publish({ submission: { status: 'failed', error: visibleError } });
      }
    } finally {
      this.submissionBusy = false;
    }
  }

  reportFeature = async (reason: BoardReportReason): Promise<void> => {
    if (!this.current() || this.voteBusy || this.command || this.withdrawalBusy || this.withdrawalCommand ||
      this.submissionBusy || this.submissionCommand || this.reportBusy || this.reportCommand ||
      this.correctionBusy || this.correctionCommand ||
      this.snapshot.detail.status !== 'ready') return;
    // Preserve the requested alias for authorization; the server resolves its canonical reporting target.
    const command = Object.freeze({ featureId: this.snapshot.detail.value.requestedId, reason, key: this.keyFactory() });
    if (!this.current()) return;
    this.reportCommand = command;
    await this.sendReport(command, false);
    this.current();
  };

  retryUncertainReport = async (): Promise<void> => {
    if (!this.current() || this.reportBusy || !this.reportCommand || this.snapshot.report.status !== 'unknown') return;
    await this.sendReport(this.reportCommand, true);
    this.current();
  };

  private async sendReport(command: ReportCommand, retry: boolean) {
    if (!this.current()) return;
    this.reportBusy = true;
    this.publish({ report: { status: 'pending' }, reportReceipt: null });
    try {
      if (!this.current()) return;
      const receipt = await this.resources.report(command.featureId, command.reason, command.key);
      if (!this.current()) return;
      this.reportCommand = null;
      this.publish({ report: { status: 'saved' },
        reportReceipt: { featureId: command.featureId, receiptId: receipt.receiptId, status: receipt.status } });
    } catch (error) {
      if (!this.current()) return;
      const failure = apiError(error);
      if (failure.code === 'session_changed') { this.end(); return; }
      const visibleError = new ApiError(failure.status, failure.code, 'The report could not be confirmed.',
        failure.effectUnknown, failure.originalEffectUnknown);
      if (failure.effectUnknown || failure.originalEffectUnknown || retry) {
        this.publish({ report: { status: 'unknown', error: visibleError } });
      } else {
        this.reportCommand = null;
        this.publish({ report: { status: 'failed', error: visibleError } });
      }
    } finally {
      this.reportBusy = false;
    }
  }

  correctSubmission = async (id: string, input: BoardCorrectionInput): Promise<void> => {
    if (!this.current() || this.voteBusy || this.command || this.withdrawalBusy || this.withdrawalCommand ||
      this.submissionBusy || this.submissionCommand || this.reportBusy || this.reportCommand ||
      this.correctionBusy || this.correctionCommand || this.snapshot.ownSubmissions.status !== 'ready') return;
    const row = this.snapshot.ownSubmissions.value.find(submission => submission.id === id);
    if (!row || row.visibility === 'withdrawn' || row.successorSubmissionId) return;
    let replacement: BoardCorrectionInput;
    try { replacement = snapshotCorrectionInput(input); }
    catch {
      this.publish({ correction: { status: 'failed', error: new ApiError(422, 'board_invalid_input', 'Check the feature request fields.') },
        correctionReceipt: null, correctionSuccessor: null });
      return;
    }
    const command = Object.freeze({ submissionId: row.id, featureId: row.featureId,
      input: Object.freeze({ ...replacement, expectedRevision: row.revision, expectedCanonicalFeatureId: row.canonicalFeatureId }),
      key: this.keyFactory() });
    if (!this.current()) return;
    this.correctionCommand = command;
    await this.sendCorrection(command, false);
    this.current();
  };

  retryUncertainCorrection = async (): Promise<void> => {
    if (!this.current() || this.correctionBusy || !this.correctionCommand ||
      this.snapshot.correction.status !== 'unknown') return;
    await this.sendCorrection(this.correctionCommand, true);
    this.current();
  };

  private async sendCorrection(command: CorrectionCommand, retry: boolean) {
    if (!this.current()) return;
    this.correctionBusy = true;
    this.publish({ correction: { status: 'pending' }, correctionReceipt: null, correctionSuccessor: null });
    try {
      if (!this.current()) return;
      const result = await this.resources.correct(command.submissionId, command.input, command.key);
      if (!this.current()) return;
      const receipt = result.receipt;
      // The resource validates the receipt; only this owner has the original feature binding.
      if (receipt.featureId !== command.featureId) throw new ApiError(0, 'board_correction_response_invalid',
        'The correction could not be confirmed. Retry the same correction.', true);
      this.correctionCommand = null;
      await this.refreshAfterCorrection(command, result);
      this.current();
    } catch (error) {
      if (!this.current()) return;
      const failure = apiError(error);
      if (failure.code === 'session_changed') { this.end(); return; }
      const visibleError = new ApiError(failure.status, failure.code, 'The correction could not be confirmed.',
        failure.effectUnknown, failure.originalEffectUnknown);
      // A conflict or fresh successor cannot settle an earlier uncertain correction.
      if (failure.effectUnknown || failure.originalEffectUnknown || retry) {
        this.publish({ correction: { status: 'unknown', error: visibleError } });
      } else {
        this.correctionCommand = null;
        this.publish({ correction: { status: 'failed', error: visibleError } });
      }
    } finally {
      this.correctionBusy = false;
    }
  }

  private async refreshAfterCorrection(command: CorrectionCommand, result: FeatureCorrectionResult) {
    if (!this.current()) return;
    const request = ++this.ownRequest;
    const query = { ...this.ownQuery };
    this.browseRequest++;
    const affectedIds = new Set([command.featureId, command.input.expectedCanonicalFeatureId,
      result.receipt.successor.featureId, ...(result.successor ? [result.successor.canonicalFeatureId] : [])]);
    const affectedDetail = this.snapshot.selectedId !== null && affectedIds.has(this.snapshot.selectedId) ||
      this.snapshot.detail.status === 'ready' && affectedIds.has(this.snapshot.detail.value.canonicalId);
    if (affectedDetail) this.detailRequest++;
    this.publish({ correction: { status: 'saved' }, correctionReceipt: result.receipt, correctionSuccessor: result.successor,
      submitted: this.snapshot.submitted && (affectedIds.has(this.snapshot.submitted.featureId) ||
        affectedIds.has(this.snapshot.submitted.canonicalFeatureId)) ? null : this.snapshot.submitted,
      ownSubmissions: { status: 'stale', value: null }, browse: { status: 'stale', value: null },
      ...(affectedDetail ? { detail: { status: 'stale' as const, value: null } } : {}) });
    if (!this.current() || request !== this.ownRequest) return;
    await this.loadOwnSubmissions(query);
    this.current();
  }
}
