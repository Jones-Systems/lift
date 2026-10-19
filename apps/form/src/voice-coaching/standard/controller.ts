import type { SharedVoiceScope } from '../../integration/sharedVoice';
import type { LocalTeardownResult, StandardTurnReview, TeardownReason, VoiceFence } from '../contracts';
import type {
  StandardClientAccounting, StandardClientTurnResult, StandardVoiceConsumer, StandardVoiceConsumerOptions,
  StandardVoiceFailure, StandardVoiceHandle, StandardVoicePhase, StandardVoiceSnapshot,
} from './contracts';

type Operation = {
  sessionId: string;
  abort: AbortController;
  valid: boolean;
  acquisitionStarted: boolean;
  acquisition: Promise<Pick<StandardVoiceHandle, 'stop'> | null>;
  handle?: StandardVoiceHandle;
  fence?: VoiceFence;
  sent: boolean;
  terminal: boolean;
  cleanup?: Promise<LocalTeardownResult>;
  afterStop: StandardVoicePhase;
  failure?: StandardVoiceFailure;
};
const accountingValues = new Set<StandardClientAccounting>(['not_reserved', 'replay', 'released', 'settled', 'not_consumed', 'unknown', 'unresolved']);
const released = (): LocalTeardownResult => Object.freeze({ status: 'released', failedSteps: Object.freeze([]) });
const incomplete = (): LocalTeardownResult => Object.freeze({ status: 'incomplete', failedSteps: Object.freeze(['standard_handle']) });
const fail = (code: string): Error => new Error(code);
const MAX_AUDIO_BYTES = 25_000_000;

function acceptedResult(result: StandardClientTurnResult): boolean {
  if (!result || !accountingValues.has(result.accounting) || !result.outcome) return false;
  const outcome = result.outcome;
  if (outcome.kind === 'succeeded') return outcome.value?.mediaType === 'audio/wav'
    && outcome.value.audio instanceof Uint8Array && outcome.value.audio.byteLength > 0
    && outcome.value.audio.byteLength <= MAX_AUDIO_BYTES;
  return ['not_dispatched', 'rejected', 'unknown'].includes(outcome.kind) && typeof outcome.reason === 'string';
}

function reviewFrom(result: StandardClientTurnResult): StandardTurnReview | undefined {
  try {
    const value = result.review;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const { transcript, reply } = value;
    if (typeof transcript !== 'string' || (reply !== undefined && typeof reply !== 'string')) return undefined;
    return Object.freeze({ transcript, ...(reply !== undefined ? { reply } : {}) });
  } catch { return undefined; }
}

export function createStandardVoiceConsumer(options: StandardVoiceConsumerOptions): StandardVoiceConsumer {
  const account = Object.freeze({ ...options.scope.account });
  const checkScope = options.scope.isCurrent.bind(options.scope);
  const scope: SharedVoiceScope = Object.freeze({ account, isCurrent: checkScope });
  const host = options.host && Object.freeze({ startStandard: options.host.startStandard.bind(options.host) });
  const turn = options.turn && Object.freeze({ run: options.turn.run.bind(options.turn) });
  const newSessionId = options.newSessionId;
  const onManual = options.onManual;
  const observers = new Set<(snapshot: StandardVoiceSnapshot) => void>();
  let state: StandardVoiceSnapshot = Object.freeze({ phase: 'idle', cleanup: 'not_started', reviewAvailable: false });
  let currentReview: Readonly<{ op: Operation; value: StandardTurnReview }> | undefined;
  let active: Operation | undefined;
  let disposed = false;
  let manualRequested = false;
  let lastSessionId: string | undefined;
  let lastCleanup: Promise<LocalTeardownResult> | undefined;

  function publish(next: Omit<StandardVoiceSnapshot, 'reviewAvailable'>): void {
    state = Object.freeze({ ...next, reviewAvailable: currentReview !== undefined });
    for (const observer of [...observers]) {
      try { observer(state); } catch {}
    }
  }
  function scopeCurrent(): boolean {
    try { return scope.isCurrent(); } catch { return false; }
  }
  function assertCurrent(op: Operation): void {
    if (disposed || active !== op || !op.valid || op.abort.signal.aborted || !scopeCurrent()) throw fail('standard_session_stale');
    op.handle?.assertCurrent();
    if (disposed || active !== op || !op.valid || op.abort.signal.aborted || !scopeCurrent()) throw fail('standard_session_stale');
  }
  function clearReview(): void {
    currentReview = undefined;
    state = Object.freeze({ ...state, reviewAvailable: false });
  }
  function review(): StandardTurnReview | null {
    const captured = currentReview;
    if (!captured) return null;
    try {
      assertCurrent(captured.op);
      return currentReview === captured ? captured.value : null;
    } catch {
      if (currentReview === captured) { clearReview(); publish(state); }
      return null;
    }
  }
  function sameAccount(fence: VoiceFence): boolean {
    return fence.accountId === account.accountId && fence.authSessionId === account.authSessionId
      && fence.accountEpoch === account.accountEpoch && Number.isSafeInteger(fence.generation) && fence.generation > 0;
  }
  function beginCleanup(op: Operation, reason: TeardownReason): Promise<LocalTeardownResult> {
    if (currentReview?.op === op) clearReview();
    if (op.cleanup) return op.cleanup;
    op.valid = false;
    let resolve!: (result: LocalTeardownResult) => void;
    op.cleanup = new Promise<LocalTeardownResult>(yes => { resolve = yes; });
    lastCleanup = op.cleanup;
    op.abort.abort(reason);
    publish({ ...state, phase: 'stopping', cleanup: 'pending',
      ...(op.failure ? { failure: op.failure } : {}),
      ...(op.sent && !op.terminal ? { outcome: 'unknown' as const, accounting: 'unknown' as const } : {}),
    });
    void (async () => {
      let result: LocalTeardownResult;
      try {
        const handle = await op.acquisition;
        if (handle) {
          const receipt = await handle.stop(reason);
          result = receipt?.status === 'released' && Array.isArray(receipt.failedSteps) && receipt.failedSteps.length === 0
            ? released() : incomplete();
        } else result = op.acquisitionStarted ? incomplete() : released();
      } catch { result = incomplete(); }
      op.handle = undefined;
      op.fence = undefined;
      if (active === op) {
        if (result.status === 'released') active = undefined;
        publish({ ...state, phase: result.status === 'incomplete' ? 'cleanup_incomplete' : op.afterStop,
          cleanup: result.status, ...(result.status === 'incomplete' ? { failure: 'cleanup_failed' as const } : {}),
        });
      }
      resolve(result);
    })();
    return op.cleanup;
  }
  function terminate(op: Operation, failure: StandardVoiceFailure, phase: 'failed' | 'unknown' = 'failed'): Promise<LocalTeardownResult> {
    if (!op.cleanup) {
      op.failure = failure;
      op.afterStop = phase;
    }
    return beginCleanup(op, scopeCurrent() ? 'failed' : 'account_changed');
  }

  async function finishFailure(op: Operation, failure: StandardVoiceFailure, phase: 'failed' | 'unknown'): Promise<void> {
    if (currentReview?.op === op) {
      assertCurrent(op);
      publish({ ...state, phase, failure });
    } else await terminate(op, failure, phase);
  }

  function start(): Promise<void> {
    if (disposed) return Promise.reject(fail('standard_consumer_disposed'));
    if (active) return Promise.reject(fail('standard_consumer_busy'));
    manualRequested = false;
    if (!scopeCurrent()) {
      publish({ phase: 'failed', cleanup: 'not_started', failure: 'session_changed' });
      return Promise.resolve();
    }
    if (!host || !turn) {
      publish({ phase: 'unavailable', cleanup: 'not_started', failure: !host ? 'host_unavailable' : 'turn_unavailable' });
      return Promise.resolve();
    }
    let sessionId: string;
    try {
      sessionId = newSessionId();
      if (typeof sessionId !== 'string' || !sessionId.trim() || sessionId.length > 128 || sessionId === lastSessionId) throw fail('invalid');
    } catch {
      publish({ phase: 'failed', cleanup: 'not_started', failure: 'session_id_invalid' });
      return Promise.resolve();
    }
    lastSessionId = sessionId;
    let acquired!: (handle: Pick<StandardVoiceHandle, 'stop'> | null) => void;
    const op: Operation = { sessionId, abort: new AbortController(), valid: true, acquisitionStarted: false,
      acquisition: new Promise(resolve => { acquired = resolve; }), sent: false, terminal: false, afterStop: 'idle' };
    active = op;
    lastCleanup = undefined;
    publish({ phase: 'acquiring', cleanup: 'not_started' });
    return (async () => {
      try {
        assertCurrent(op);
        op.acquisitionStarted = true;
        const supplied = await host.startStandard(scope, sessionId, op.abort.signal);
        const stop = supplied.stop.bind(supplied);
        acquired(Object.freeze({ stop }));
        const checkShared = supplied.assertCurrent;
        if (typeof checkShared !== 'function') {
          if (!op.cleanup) { op.failure = 'host_unavailable'; op.afterStop = 'unavailable'; }
          await beginCleanup(op, 'failed');
          return;
        }
        const handle = Object.freeze({
          assertCurrent: checkShared.bind(supplied),
          fence: Object.freeze({ ...supplied.fence }),
          startCapture: supplied.startCapture.bind(supplied),
          finishCapture: supplied.finishCapture.bind(supplied),
          play: supplied.play.bind(supplied),
          stop,
        });
        op.handle = handle;
        assertCurrent(op);
        if (!sameAccount(handle.fence)) throw fail('standard_fence_mismatch');
        op.fence = Object.freeze({ ...handle.fence });
        await handle.startCapture();
        assertCurrent(op);
        publish({ phase: 'capturing', cleanup: 'not_started' });
      } catch {
        acquired(null);
        if (op.cleanup) { await op.cleanup; return; }
        await terminate(op, scopeCurrent() ? (op.handle ? 'capture_failed' : 'acquisition_failed') : 'session_changed');
      }
    })();
  }

  function finishAndSend(): Promise<void> {
    const op = active;
    if (disposed) return Promise.reject(fail('standard_consumer_disposed'));
    if (!op || !op.valid || state.phase !== 'capturing' || op.sent) return Promise.reject(fail('standard_capture_not_ready'));
    return (async () => {
      try {
        assertCurrent(op);
        publish({ ...state, phase: 'processing' });
        assertCurrent(op);
        const audioBlob = await op.handle!.finishCapture();
        assertCurrent(op);
        if (!(audioBlob instanceof Blob) || audioBlob.type !== 'audio/wav' || audioBlob.size === 0 || audioBlob.size > MAX_AUDIO_BYTES) {
          await terminate(op, 'audio_invalid'); return;
        }
        op.sent = true;
        const result = await turn!.run({ scope, fence: op.fence!, sessionId: op.sessionId, audioBlob,
          signal: op.abort.signal, assertCurrent: () => assertCurrent(op) });
        assertCurrent(op);
        if (!acceptedResult(result)) { await terminate(op, 'turn_unknown', 'unknown'); return; }
        const acceptedReview = reviewFrom(result);
        assertCurrent(op);
        currentReview = acceptedReview ? Object.freeze({ op, value: acceptedReview }) : undefined;
        op.terminal = true;
        publish({ ...state, outcome: result.outcome.kind, accounting: result.accounting });
        assertCurrent(op);
        if (result.outcome.kind !== 'succeeded') {
          await finishFailure(op, result.outcome.kind === 'unknown' ? 'turn_unknown'
            : result.outcome.kind === 'rejected' ? 'turn_rejected' : 'turn_not_dispatched',
          result.outcome.kind === 'unknown' ? 'unknown' : 'failed');
          return;
        }
        if (result.accounting !== 'settled') { await finishFailure(op, 'accounting_unresolved', 'unknown'); return; }
        const speech = new Blob([new Uint8Array(result.outcome.value.audio).buffer], { type: 'audio/wav' });
        publish({ ...state, phase: 'playing' });
        assertCurrent(op);
        await op.handle!.play(speech);
        assertCurrent(op);
        publish({ ...state, phase: 'completed' });
      } catch {
        if (op.cleanup) { await op.cleanup; return; }
        await terminate(op, !scopeCurrent() ? 'session_changed' : !op.sent ? 'capture_failed'
          : op.terminal ? 'playback_failed' : 'turn_unknown', op.sent && !op.terminal ? 'unknown' : 'failed');
      }
    })();
  }

  function stop(reason: TeardownReason): Promise<LocalTeardownResult> {
    clearReview();
    const op = active;
    if (op) {
      if (!op.cleanup) op.afterStop = disposed ? 'disposed' : manualRequested ? 'manual' : 'idle';
      return beginCleanup(op, reason);
    }
    publish({ ...state, phase: disposed ? 'disposed' : manualRequested ? 'manual' : 'idle', cleanup: 'released' });
    return lastCleanup ?? Promise.resolve(released());
  }
  function useManual(): Promise<LocalTeardownResult> {
    if (disposed) return Promise.reject(fail('standard_consumer_disposed'));
    const wasRequested = manualRequested;
    manualRequested = true;
    if (active) active.afterStop = 'manual';
    const cleanup = stop(scopeCurrent() ? 'user_stop' : 'account_changed');
    if (!wasRequested && scopeCurrent()) {
      try { onManual(); } catch { publish({ ...state, failure: 'manual_unavailable' }); }
    }
    return cleanup;
  }
  function dispose(): Promise<LocalTeardownResult> {
    disposed = true;
    observers.clear();
    if (active) active.afterStop = 'disposed';
    return stop('navigation');
  }
  return Object.freeze({
    start, finishAndSend, stop, useManual, dispose, review,
    snapshot: () => { review(); return state; },
    subscribe(observer: (snapshot: StandardVoiceSnapshot) => void) {
      if (!disposed) observers.add(observer);
      return { remove: () => { observers.delete(observer); } };
    },
  });
}
