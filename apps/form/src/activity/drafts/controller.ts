import type { ActivityEntry, ActivityWrite, ExerciseSnapshot } from '../contracts';
import type { ActivityResources } from '../resources';
import type { SpeechPort } from '../../features/contract';
import type { ReviewedSpeechText, SpeechDraft } from '../../native/speech.types';
import type { CaptureContext, DraftResult } from './model';
import { draftFromEntry, manualActivityDraft, sameCaptureContext } from './model';
import { parseReviewedActivity } from './parser';
import { commandId, draftToActivityWrite, revision } from './validation';
export type DraftPhase = 'idle' | 'capture' | 'transcriptReview' | 'structuredReview' | 'saving' | 'saved' | 'rejected' | 'stale' | 'unknown' | 'cancelled';
export type EntryTarget = { id: string; expectedRevision: number };
export type PendingActivityCommand = Readonly<{ key: string; payload: ActivityWrite; target: EntryTarget | null }>;
export type DraftState = {
  phase: DraftPhase; accountGeneration: string; epoch: number; sessionId: string | null;
  context: CaptureContext | null; editTarget: EntryTarget | null; transcript: string; result: DraftResult | null;
  pending: PendingActivityCommand | null; saved: ActivityEntry | null; error: { code: string; status: number; originalEffectUnknown?: boolean } | null;
};
export type DraftEvent =
  | { type: 'begin'; accountGeneration: string; context: CaptureContext; manual: DraftResult | null; target?: EntryTarget }
  | { type: 'speech'; epoch: number; accountGeneration: string; draft: SpeechDraft }
  | { type: 'structured'; result: DraftResult }
  | { type: 'saving'; command: PendingActivityCommand }
  | { type: 'outcome'; epoch: number; accountGeneration: string; status: 'saved'; value: ActivityEntry }
  | { type: 'outcome'; epoch: number; accountGeneration: string; status: 'unknown' | 'stale' | 'rejected'; error: { code: string; status: number; originalEffectUnknown?: boolean } }
  | { type: 'cancel'; accountGeneration: string };
export function initialDraftState(accountGeneration: string): DraftState {
  return { phase: 'idle', accountGeneration, epoch: 0, sessionId: null, context: null, editTarget: null, transcript: '', result: null, pending: null, saved: null, error: null };
}
export function draftReducer(state: DraftState, event: DraftEvent): DraftState {
  if (event.type === 'cancel') return { ...initialDraftState(event.accountGeneration), phase: 'cancelled', epoch: state.epoch + 1 };
  if (event.type === 'begin') {
    if (event.accountGeneration !== state.accountGeneration || event.context.accountGeneration !== state.accountGeneration || ['saving', 'unknown'].includes(state.phase)) return state;
    return { ...initialDraftState(state.accountGeneration), epoch: state.epoch + 1, phase: event.manual ? 'structuredReview' : 'capture', context: Object.freeze({ ...event.context }), result: event.manual, editTarget: event.target ?? null };
  }
  if (event.type === 'speech') {
    if (event.epoch !== state.epoch || event.accountGeneration !== state.accountGeneration || !['capture', 'transcriptReview'].includes(state.phase)) return state;
    if (state.sessionId && state.sessionId !== event.draft.sessionId) return state;
    if (!state.sessionId && event.draft.state !== 'starting') return state;
    if (event.draft.state === 'discarded' || event.draft.error) return { ...initialDraftState(state.accountGeneration), epoch: state.epoch + 1, phase: 'cancelled' };
    return { ...state, sessionId: event.draft.sessionId, transcript: event.draft.text,
      phase: event.draft.state === 'review' && event.draft.isFinal ? 'transcriptReview' : 'capture' };
  }
  if (event.type === 'structured') {
    if (!['transcriptReview', 'structuredReview', 'rejected', 'stale'].includes(state.phase) || event.result.context.accountGeneration !== state.accountGeneration || event.result.draftId !== state.context?.draftId) return state;
    return { ...state, phase: 'structuredReview', result: event.result, transcript: '', sessionId: null, pending: null, error: null, saved: null };
  }
  if (event.type === 'saving') {
    if (!['structuredReview', 'unknown'].includes(state.phase)) return state;
    if (state.phase === 'unknown' && event.command !== state.pending) return state;
    return { ...state, phase: 'saving', pending: event.command, transcript: '', error: null, result: state.result ? { ...state.result, reviewedText: '', unsupportedFragments: [], issues: state.result.issues.map(({ fragment: _fragment, ...issue }) => issue) } : null };
  }
  if (event.epoch !== state.epoch || event.accountGeneration !== state.accountGeneration || state.phase !== 'saving') return state;
  if (event.status === 'saved') return { ...state, phase: 'saved', saved: event.value, context: null, editTarget: null, transcript: '', result: null, pending: null, sessionId: null, error: null };
  if (event.error.status === 401 || event.error.code === 'session_changed') return { ...initialDraftState(state.accountGeneration), epoch: state.epoch + 1, phase: 'rejected', error: event.error };
  return { ...state, phase: event.status, error: event.error, pending: event.status === 'unknown' ? state.pending : null };
}
function copy<T>(value: T): T {
  if (Array.isArray(value)) return value.map(copy) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, copy(entry)])) as T;
  return value;
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value;
}
export type ActivityCommandPort = Pick<ActivityResources, 'createEntry' | 'editEntry'>;
export class DraftController {
  private state: DraftState;
  private subscription: { remove(): void } | null = null;
  private observers = new Set<(state: DraftState) => void>();
  private disposed = false;
  private requiresGenerationRefresh = false;
  constructor(accountGeneration: string, private readonly resources: ActivityCommandPort, private readonly newKey: () => string, private readonly speech?: SpeechPort) {
    this.state = initialDraftState(accountGeneration);
  }
  getState(): DraftState { return copy(this.state); }
  subscribe(observer: (state: DraftState) => void): { remove(): void } {
    this.observers.add(observer); observer(this.getState()); return { remove: () => this.observers.delete(observer) };
  }
  beginManual(context: CaptureContext, exercise?: ExerciseSnapshot): void {
    this.requireCanBegin(context); this.detachSpeech();
    this.dispatch({ type: 'begin', accountGeneration: this.state.accountGeneration, context, manual: manualActivityDraft(context, exercise) });
  }
  beginEntryEdit(entry: ActivityEntry): void {
    if (entry.status !== 'recorded') throw new Error('voided_entry_edit_unavailable');
    const result = draftFromEntry(this.state.accountGeneration, entry); this.requireCanBegin(result.context); this.detachSpeech();
    this.dispatch({ type: 'begin', accountGeneration: this.state.accountGeneration, context: result.context, manual: result, target: { id: entry.id, expectedRevision: entry.revision } });
  }
  async beginSpeech(context: CaptureContext, locale: string): Promise<void> {
    this.requireCanBegin(context);
    if (!this.speech) throw new Error('speech_unavailable');
    this.detachSpeech();
    this.dispatch({ type: 'begin', accountGeneration: this.state.accountGeneration, context, manual: null });
    const epoch = this.state.epoch, accountGeneration = this.state.accountGeneration;
    this.subscription = this.speech.subscribe(draft => {
      if (!draft || this.disposed) return;
      this.dispatch({ type: 'speech', epoch, accountGeneration, draft });
      if (this.state.phase === 'cancelled') this.detachSpeech();
    });
    try {
      const id = await this.speech.start(locale);
      if (this.disposed || epoch !== this.state.epoch || accountGeneration !== this.state.accountGeneration) return;
      if (this.state.sessionId !== id) { await this.cancel(); throw new Error('speech_session_unbound'); }
    } catch (error) {
      if (epoch === this.state.epoch && accountGeneration === this.state.accountGeneration) await this.cancel();
      throw error;
    }
  }
  async stopSpeech(): Promise<void> { if (this.state.phase === 'capture') await this.speech?.stop(); }
  acceptTranscript(text: string, catalog: ExerciseSnapshot[]): void {
    if (!this.speech || this.state.phase !== 'transcriptReview' || !this.state.sessionId || !this.state.context) throw new Error('transcript_review_unavailable');
    // Detach before acceptReview clears the adapter and emits its discarded event.
    this.detachSpeech();
    const reviewed = this.speech.acceptReview({ sessionId: this.state.sessionId, text, reviewed: true });
    this.acceptReviewedText(reviewed, this.state.context, catalog);
  }
  acceptReviewedText(reviewed: ReviewedSpeechText, context: CaptureContext, catalog: ExerciseSnapshot[]): void {
    if (this.disposed || this.requiresGenerationRefresh || context.accountGeneration !== this.state.accountGeneration || !this.state.context || !sameCaptureContext(context, this.state.context) || this.state.phase !== 'transcriptReview' || reviewed.sessionId !== this.state.sessionId) throw new Error('stale_speech_review');
    const result = parseReviewedActivity(reviewed, context, catalog);
    this.dispatch({ type: 'structured', result });
  }
  edit(result: DraftResult): void {
    if (this.disposed || !['structuredReview', 'rejected', 'stale'].includes(this.state.phase)) throw new Error('draft_edit_unavailable');
    if (!this.state.context || !sameCaptureContext(result.context, this.state.context) || result.draftId !== this.state.context.draftId) throw new Error('stale_draft');
    this.dispatch({ type: 'structured', result: copy(result) });
  }
  async save(target: EntryTarget | null = this.state.editTarget): Promise<DraftState> {
    if (this.disposed || this.state.phase !== 'structuredReview' || !this.state.result) throw new Error('explicit_structured_save_required');
    const payload = draftToActivityWrite(this.state.result);
    const command = freeze({ key: commandId(this.newKey()), payload, target: target ? { id: target.id, expectedRevision: revision(target.expectedRevision) } : null });
    return this.execute(command);
  }
  async retryUnknown(): Promise<DraftState> {
    if (this.disposed || this.state.phase !== 'unknown' || !this.state.pending) throw new Error('unknown_retry_unavailable');
    return this.execute(this.state.pending);
  }
  async cancel(): Promise<void> {
    this.detachSpeech(); this.dispatch({ type: 'cancel', accountGeneration: this.state.accountGeneration });
    await this.speech?.cancel();
  }
  background(): Promise<void> { return this.cancel(); }
  async accountChanged(accountGeneration: string): Promise<void> {
    if (this.requiresGenerationRefresh && accountGeneration === this.state.accountGeneration) throw new Error('account_generation_refresh_required');
    this.requiresGenerationRefresh = false; this.detachSpeech(); this.dispatch({ type: 'cancel', accountGeneration }); await this.speech?.cancel();
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    try { await this.cancel(); } finally { this.observers.clear(); await this.speech?.dispose(); }
  }
  private requireCanBegin(context: CaptureContext): void {
    if (this.disposed || this.requiresGenerationRefresh || context.accountGeneration !== this.state.accountGeneration || ['saving', 'unknown', 'capture', 'transcriptReview'].includes(this.state.phase)) throw new Error('capture_unavailable');
  }
  private async execute(command: PendingActivityCommand): Promise<DraftState> {
    const epoch = this.state.epoch, accountGeneration = this.state.accountGeneration;
    this.dispatch({ type: 'saving', command });
    try {
      const value = command.target ? await this.resources.editEntry(command.target.id, command.target.expectedRevision, command.payload, command.key) : await this.resources.createEntry(command.payload, command.key);
      this.dispatch({ type: 'outcome', epoch, accountGeneration, status: 'saved', value });
    } catch (error) {
      const failure = error as { effectUnknown?: boolean; originalEffectUnknown?: boolean; status?: number; code?: string };
      if (epoch === this.state.epoch && accountGeneration === this.state.accountGeneration && (failure.code === 'session_changed' || failure.status === 401)) this.requiresGenerationRefresh = true;
      const unknown = failure.effectUnknown === true || failure.status === undefined || failure.status === 0 || failure.status >= 500;
      this.dispatch({ type: 'outcome', epoch, accountGeneration, status: unknown ? 'unknown' : failure.status === 409 ? 'stale' : 'rejected', error: { code: typeof failure.code === 'string' ? failure.code : 'request_unconfirmed', status: failure.status ?? 0, ...(failure.originalEffectUnknown ? { originalEffectUnknown: true } : {}) } });
    }
    return this.getState();
  }
  private dispatch(event: DraftEvent): void {
    this.state = draftReducer(this.state, event);
    for (const observer of this.observers) observer(this.getState());
  }
  private detachSpeech(): void { this.subscription?.remove(); this.subscription = null; }
}
