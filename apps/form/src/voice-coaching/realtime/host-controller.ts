import type { LocalTeardownResult, ServerStopResult, TeardownReason, VoiceAccount, VoiceTeardown } from '../contracts';
import type { RealtimeController, RealtimeStartResult } from './peer-slot';

export type PreparedRealtimeAttempt = Readonly<{
  kind: 'new';
  operationId: string;
  // Inert until start is invoked. From that invocation, the trusted factory/server owns
  // reservation reconciliation, including disabled, failed and cancelled start outcomes.
  attempt: RealtimeController;
  // The trusted owner may release only its original unstaged reservation, never unknown dispatch.
  abandonUnstarted(): Promise<void>;
}>;
export type RealtimeAdmission = PreparedRealtimeAttempt | Readonly<{ kind: 'replay' | 'denied' }>;
export type RealtimeHostStartResult = RealtimeStartResult | Readonly<{ status: 'busy' | 'blocked' | 'replay' | 'denied' }>;
type HostState = 'idle' | 'preparing' | 'starting' | 'connected' | 'stopping' | 'stopped' | 'blocked' | 'disposed';
type Failure = 'prepareNewAttempt' | 'abandonUnstarted' | 'lateLocalCleanup' | 'attemptStop' | 'attemptStart' | 'hostSubscription' | 'hostUnsubscribe';
type Run = {
  abort: AbortController;
  valid: boolean;
  reason: TeardownReason;
  state: HostState;
  detach(): void;
  prepared: PreparedRealtimeAttempt | null;
  startInvoked: boolean;
  startTask: Promise<RealtimeStartResult> | null;
  teardown: VoiceTeardown | null;
  attemptTeardown: VoiceTeardown | null;
  local: LocalTeardownResult | null;
  abandonTask: Promise<void> | null;
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
function invoke<T>(action: () => T | Promise<T>): Promise<T> {
  try { return Promise.resolve(action()); } catch (error) { return Promise.reject(error); }
}
const released = (): LocalTeardownResult => Object.freeze({ status: 'released', failedSteps: Object.freeze([]) });
const unknown = (): ServerStopResult => Object.freeze({ status: 'unknown' });

export function createRealtimeHostController(options: Readonly<{
  account: VoiceAccount;
  // Must include foreground, route ownership and the originally captured account/auth context.
  isCurrent(): boolean;
  subscribeInvalidation?(listener: (reason: TeardownReason) => void): { remove(): void };
  // Account coordinates teardown only. Server admission must verify its own actor, rights and usage.
  prepareNewAttempt?(input: Readonly<{ account: VoiceAccount; intentKey: string; signal: AbortSignal }>): Promise<RealtimeAdmission>;
}>) {
  const account = Object.freeze({ ...options.account });
  const prepare = options.prepareNewAttempt;
  const work = new Set<Promise<unknown>>();
  const failures = new Set<Failure>();
  let active: Run | null = null;
  let disposed = false;
  let expired = false;
  let admissionUnknown = false;
  let localUnknown = false;
  let subscription: { remove(): void } | null = null;
  let subscribed = false;

  const track = <T>(promise: Promise<T>): Promise<T> => {
    const task = promise.finally(() => { work.delete(task); });
    work.add(task);
    void task.catch(() => {});
    return task;
  };
  const hostCurrent = () => {
    if (disposed || expired) return false;
    try { return options.isCurrent() && !disposed && !expired; }
    catch { return false; }
  };
  const current = (run: Run) => run.valid && active === run && !run.abort.signal.aborted
    && hostCurrent() && run.valid && active === run && !run.abort.signal.aborted;

  const stopPrepared = (run: Run): VoiceTeardown => {
    if (run.attemptTeardown) return run.attemptTeardown;
    const local = deferred<LocalTeardownResult>(), server = deferred<ServerStopResult>();
    const handle = Object.freeze({ local: local.promise, server: server.promise });
    run.attemptTeardown = handle;
    try {
      const result = run.prepared!.attempt.stop(run.reason);
      void result.local.then(local.resolve, () => {
        failures.add('attemptStop');
        local.resolve({ status: 'incomplete', failedSteps: ['attemptStop'] });
      });
      void result.server.then(server.resolve, () => server.resolve(unknown()));
    } catch {
      failures.add('attemptStop');
      local.resolve({ status: 'incomplete', failedSteps: ['attemptStop'] });
      server.resolve(unknown());
    }
    return handle;
  };
  const abandon = (run: Run) => {
    if (run.abandonTask || !run.prepared || run.startInvoked) return;
    const finished = deferred<void>();
    run.abandonTask = track(finished.promise);
    const local = stopPrepared(run).local.then(result => {
      if (result.status !== 'released') { localUnknown = true; failures.add('lateLocalCleanup'); }
    });
    const admission = invoke(() => run.prepared!.abandonUnstarted()).catch(() => {
      admissionUnknown = true;
      failures.add('abandonUnstarted');
    });
    void Promise.allSettled([local, admission]).then(() => finished.resolve());
  };
  const stopRun = (run: Run, reason: TeardownReason): VoiceTeardown => {
    run.valid = false;
    run.detach();
    if (run.teardown) return run.teardown;
    run.reason = reason;
    run.state = 'stopping';
    const local = deferred<LocalTeardownResult>(), server = deferred<ServerStopResult>();
    const handle = Object.freeze({ local: local.promise, server: server.promise });
    run.teardown = handle;
    const finishLocal = (result: LocalTeardownResult) => {
      run.local = result;
      run.state = result.status === 'released' ? 'stopped' : 'blocked';
      local.resolve(result);
    };
    run.abort.abort(reason);
    if (run.prepared) {
      const result = stopPrepared(run);
      void result.local.then(finishLocal);
      void result.server.then(server.resolve);
      abandon(run);
    } else {
      // Admission is inert: remote preparation/reconciliation cannot delay local hardware release.
      finishLocal(released());
      server.resolve(unknown());
    }
    return handle;
  };
  const stop = (reason: TeardownReason): VoiceTeardown => {
    if (reason === 'navigation' || reason === 'logout' || reason === 'account_changed') expired = true;
    return active ? stopRun(active, reason) : { local: Promise.resolve(released()), server: Promise.resolve(unknown()) };
  };

  if (options.subscribeInvalidation) {
    try { subscription = options.subscribeInvalidation(reason => { stop(reason); }); subscribed = true; }
    catch { failures.add('hostSubscription'); }
  }

  return {
    snapshot() {
      return Object.freeze({
        state: disposed ? 'disposed' as const : active?.state ?? 'idle',
        operationId: active?.prepared?.operationId ?? null,
        local: active?.local?.status ?? (active?.teardown ? 'pending' : 'not_started'),
        // Observed preparation/abandonment work only; this is not the server usage ledger.
        admissionCleanup: Object.freeze({ pending: work.size, unknown: admissionUnknown }),
        cleanupFailures: Object.freeze([...failures]),
      });
    },
    async startNewAttempt(intentKey: string, signal: AbortSignal): Promise<RealtimeHostStartResult> {
      if (!prepare || !subscribed) return { status: 'disabled', reason: 'host_unconfigured' };
      if (signal.aborted || !hostCurrent()) return { status: 'cancelled' };
      if (localUnknown || active?.local?.status === 'incomplete') return { status: 'blocked' };
      if (active && active.local?.status !== 'released') return { status: 'busy' };
      if (typeof intentKey !== 'string' || !intentKey.trim()) return { status: 'denied' };
      const abort = new AbortController();
      const onAbort = () => { stopRun(run, 'aborted'); };
      const run: Run = {
        abort, valid: true, reason: 'aborted', state: 'preparing',
        detach: () => signal.removeEventListener('abort', onAbort),
        prepared: null, startInvoked: false, startTask: null, teardown: null,
        attemptTeardown: null, local: null, abandonTask: null,
      };
      active = run;
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted || !current(run)) { stopRun(run, 'aborted'); return { status: 'cancelled' }; }
      let admission: RealtimeAdmission;
      try { admission = await track(invoke(() => prepare(Object.freeze({ account, intentKey, signal: abort.signal })))); }
      catch {
        admissionUnknown = true;
        failures.add('prepareNewAttempt');
        stopRun(run, 'failed');
        return { status: 'failed' };
      }
      if (admission.kind === 'new') run.prepared = admission;
      if (!current(run)) {
        stopRun(run, 'aborted');
        abandon(run);
        return { status: 'cancelled' };
      }
      if (admission.kind !== 'new') {
        stopRun(run, 'user_stop');
        return { status: admission.kind };
      }
      run.state = 'starting';
      run.startInvoked = true;
      const started = deferred<RealtimeStartResult>();
      run.startTask = started.promise;
      void invoke(() => admission.attempt.start(abort.signal)).then(started.resolve, () => {
        failures.add('attemptStart');
        started.resolve({ status: 'failed' });
      });
      const result = await run.startTask;
      if (!current(run)) { stopRun(run, 'aborted'); return { status: 'cancelled' }; }
      if (result.status === 'connected') run.state = 'connected';
      else stopRun(run, 'failed');
      return result;
    },
    stop,
    dispose(): VoiceTeardown {
      disposed = true;
      const result = stop('navigation');
      const owned = subscription;
      subscription = null;
      try { owned?.remove(); } catch { failures.add('hostUnsubscribe'); }
      return result;
    },
    // Observe admission cleanup only; server stop acknowledgement is deliberately independent.
    async settled(): Promise<void> {
      while (work.size) await Promise.allSettled([...work]);
    },
  };
}

export type RealtimeHostController = ReturnType<typeof createRealtimeHostController>;
