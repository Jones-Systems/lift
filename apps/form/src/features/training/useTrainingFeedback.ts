import { useEffect, useRef, useState } from 'react';
import { ApiError } from '../../api/transport';
import { createTrainingFeedbackCaller, type TrainingFeedbackDependencies, type TrainingFeedbackEventRequest } from '../../api/training-feedback';
import type { AnalysisResult } from '../../../../../services/api/src/integration/account-modules/index';
import type { FeedbackCurrentView, FeedbackMinimalReceipt } from '../../../../../services/api/src/training-feedback/ledger-types';

export type TrainingFeedbackIntent = Readonly<Omit<TrainingFeedbackEventRequest, 'expectedWitness'> & { key: string }>;
export type TrainingFeedbackState = Readonly<{
  read: 'idle' | 'loading' | 'ready' | 'error';
  current: AnalysisResult<FeedbackCurrentView> | null;
  draft: TrainingFeedbackIntent | null;
  review: TrainingFeedbackEventRequest | null;
  reviewAnalysis: Readonly<{ current: AnalysisResult<FeedbackCurrentView>['analysis']; witness: AnalysisResult<FeedbackCurrentView>['analysis'] | null }> | null;
  status: 'idle' | 'reviewing' | 'reviewed' | 'pending' | 'unknown' | 'rejected' | 'succeeded' | 'error';
  error: ApiError | null;
  receipt: FeedbackMinimalReceipt | null;
}>;
export type TrainingFeedbackControls = Readonly<{
  state: TrainingFeedbackState;
  read(): Promise<void>;
  review(intent: TrainingFeedbackIntent): Promise<void>;
  send(): Promise<void>;
  retry(): Promise<void>;
}>;
type FeedbackAttempt = ReturnType<ReturnType<typeof createTrainingFeedbackCaller>['prepareEvent']>;

function capture<T>(input: T): T {
  const seen = new Set<object>(); let count = 0;
  const copy = (value: unknown, depth: number): unknown => {
    if (++count > 8192 || depth > 32) throw new Error('Feedback intent is too large.');
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (!value || typeof value !== 'object' || seen.has(value)) throw new Error('Feedback intent must be plain data.');
    const list = Array.isArray(value);
    if (Object.getPrototypeOf(value) !== (list ? Array.prototype : Object.prototype)) throw new Error('Feedback intent must be plain data.');
    const result: Record<string, unknown> | unknown[] = list ? [] : {};
    seen.add(value);
    for (const key of Reflect.ownKeys(value)) {
      if (list && key === 'length') continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (typeof key !== 'string' || !descriptor.enumerable || !('value' in descriptor)) throw new Error('Feedback intent must not contain accessors.');
      Object.defineProperty(result, key, { value: copy(descriptor.value, depth + 1), enumerable: true });
    }
    if (list && (result as unknown[]).length !== (value as unknown[]).length) throw new Error('Feedback intent must not contain sparse arrays.');
    seen.delete(value); return Object.freeze(result);
  };
  return copy(input, 0) as T;
}

function equal(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
  const left = Object.keys(a), right = Object.keys(b);
  return left.length === right.length && left.every(key => Object.hasOwn(b, key)
    && equal((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}

export function createTrainingFeedbackController(dependencies: TrainingFeedbackDependencies, changed: (state: TrainingFeedbackState) => void,
  onUnauthenticated: () => void = () => undefined) {
  const { api, accountId, sessionGeneration, isCurrentSession } = dependencies;
  let caller: ReturnType<typeof createTrainingFeedbackCaller> | null = null;
  let disposed = false, expired = false, reviewing = false, running = false, readGeneration = 0;
  let attempt: FeedbackAttempt | null = null;
  let reviewedAttempt: FeedbackAttempt | null = null;
  let state: TrainingFeedbackState = Object.freeze({ read: 'idle', current: null, draft: null, review: null, reviewAnalysis: null,
    status: 'idle', error: null, receipt: null });
  const current = () => {
    if (disposed) return false;
    try { if (isCurrentSession(accountId, sessionGeneration) !== true) expired = true; }
    catch { expired = true; }
    if (expired) caller?.dispose();
    return !disposed && !expired;
  };
  const getCaller = () => caller ??= createTrainingFeedbackCaller({ api, accountId, sessionGeneration, isCurrentSession });
  const publish = (next: Partial<TrainingFeedbackState>) => {
    if (current()) { state = Object.freeze({ ...state, ...next }); changed(state); }
  };
  const failure = (error: unknown) => {
    const value = error instanceof ApiError ? error : new ApiError(422, 'training_feedback_invalid_request',
      error instanceof Error ? error.message : 'Check the training feedback fields.');
    if (value.code === 'session_changed') { expired = true; caller?.dispose(); }
    if (value.status === 401 && current()) onUnauthenticated();
    return value;
  };
  const busy = () => reviewing || running || attempt !== null;
  const conflict = (code: string) => new ApiError(409, code, 'Read and explicitly review the feedback again.');
  async function read() {
    if (!current()) return;
    const generation = ++readGeneration; publish({ read: 'loading' });
    try {
      const value = await getCaller().read();
      if (current() && generation === readGeneration) {
        if (state.status === 'reviewed' && !equal(state.current, value)) {
          reviewedAttempt = null;
          publish({ read: 'ready', current: value, review: null, reviewAnalysis: null, status: 'error', error: conflict('training_feedback_review_changed') });
        } else publish({ read: 'ready', current: value });
      }
    } catch (error) {
      const value = failure(error);
      if (current() && generation === readGeneration) publish({ read: 'error', error: value });
    }
  }
  async function review(input: TrainingFeedbackIntent) {
    if (!current() || busy()) return;
    reviewing = true; reviewedAttempt = null;
    try {
      const draft = capture(input);
      if (!equal(Object.keys(draft).sort(), ['event', 'expectedLedgerRevision', 'key', 'selection'])) throw new Error('Feedback review fields are invalid.');
      publish({ draft, review: null, reviewAnalysis: null, status: 'reviewing', error: null, receipt: null });
      const generation = ++readGeneration;
      const value = await getCaller().read();
      if (!current()) return;
      if (generation === readGeneration) publish({ read: 'ready', current: value });
      const { event, selection, expectedLedgerRevision, key } = draft;
      if (value.result.ledgerRevision !== expectedLedgerRevision) throw conflict('training_feedback_ledger_changed');
      const record = value.result.records.find(row => row.recordId === event.recordId);
      if (event.expectedRevision !== (record?.revision ?? 0)) throw conflict('training_feedback_record_changed');
      const binding = value.result.sources.find(row => row.recordId === event.recordId)?.binding;
      const scope = event.kind === 'record' || event.kind === 'correct' ? event.content.scope : binding?.scope;
      let expectedWitness: TrainingFeedbackEventRequest['expectedWitness'] = null;
      let witnessAnalysis: AnalysisResult<FeedbackCurrentView>['analysis'] | null = null;
      if (event.kind === 'record' || event.kind === 'correct' || event.kind === 'confirm') {
        if (!scope) throw conflict('training_feedback_binding_missing');
        const fresh = await getCaller().witness({ scope, selection });
        if (!current()) return;
        // Confirmation preserves the saved binding; only an explicit correction may replace it.
        if (event.kind === 'confirm' && (!binding || !equal(selection, binding.selection) || !equal(fresh.result, binding.witness)))
          throw conflict('training_feedback_witness_changed');
        expectedWitness = fresh.result;
        witnessAnalysis = fresh.analysis;
      } else if (binding && !equal(selection, binding.selection)) throw conflict('training_feedback_selection_changed');
      if (generation !== readGeneration) throw conflict('training_feedback_review_changed');
      const request = capture({ expectedLedgerRevision, selection, event, expectedWitness });
      reviewedAttempt = getCaller().prepareEvent(request, key);
      publish({ review: request, reviewAnalysis: Object.freeze({ current: value.analysis, witness: witnessAnalysis }), status: 'reviewed', error: null });
    } catch (error) { publish({ review: null, reviewAnalysis: null, status: 'error', error: failure(error) }); }
    finally { reviewing = false; }
  }
  async function run() {
    if (!current() || running || !attempt) return;
    running = true; ++readGeneration; publish({ status: 'pending', error: null });
    try {
      const value = await attempt.run();
      if (!current()) return;
      ++readGeneration; attempt = null;
      publish({ current: Object.freeze({ analysis: value.analysis, result: value.result.current }), read: 'ready', review: null, reviewAnalysis: null,
        receipt: value.result.receipt, status: value.result.receipt.outcome === 'rejected' ? 'rejected' : 'succeeded', error: null });
    } catch (error) {
      const value = failure(error);
      if (!current()) return;
      if (value.effectUnknown || value.originalEffectUnknown) publish({ status: 'unknown', error: value });
      else { attempt = null; publish({ status: 'rejected', review: null, reviewAnalysis: null, error: value }); }
    } finally { running = false; }
  }
  async function send() {
    if (!current() || busy() || state.status !== 'reviewed' || !state.review || !state.draft) return;
    if (!reviewedAttempt) return;
    attempt = reviewedAttempt; reviewedAttempt = null;
    await run();
  }
  async function retry() { if (current() && !running && state.status === 'unknown' && attempt) await run(); }
  return Object.freeze({ read, review, send, retry, isCurrent: current, snapshot: () => state,
    dispose() { disposed = true; ++readGeneration; caller?.dispose(); } });
}

export function useTrainingFeedback(input: TrainingFeedbackDependencies & { onUnauthenticated(): void }): TrainingFeedbackControls {
  const [state, setState] = useState<TrainingFeedbackState>(() => Object.freeze({ read: 'idle', current: null, draft: null,
    review: null, reviewAnalysis: null, status: 'idle', error: null, receipt: null }));
  const owner = useRef({ ...input });
  const controller = useRef<ReturnType<typeof createTrainingFeedbackController> | null>(null);
  controller.current ??= createTrainingFeedbackController(owner.current, setState, owner.current.onUnauthenticated);
  if (owner.current.api !== input.api || owner.current.accountId !== input.accountId
    || owner.current.sessionGeneration !== input.sessionGeneration) controller.current.dispose();
  controller.current.isCurrent();
  useEffect(() => () => controller.current?.dispose(), []);
  return { state, read: controller.current.read, review: controller.current.review, send: controller.current.send, retry: controller.current.retry };
}

export function guardTrainingFeedback(feedback: TrainingFeedbackControls, canPresent: () => boolean): TrainingFeedbackControls {
  return { state: feedback.state,
    read: async () => { if (canPresent()) await feedback.read(); },
    review: async intent => { if (canPresent()) await feedback.review(intent); },
    send: async () => { if (canPresent()) await feedback.send(); },
    retry: async () => { if (canPresent()) await feedback.retry(); } };
}
