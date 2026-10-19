import type { TeardownReason, VoiceAccount, VoiceFence, VoiceTeardown, VoiceTransportTeardown } from '../contracts';
import type { VoiceSessionController } from '../session-controller';

type Completion = void | Promise<void>;

export interface RealtimePeer {
  close(reason: string): Completion;
  stopPlayback(reason: string): Completion;
  // Completion means bounded local command delivery, never a provider acknowledgement wait.
  cancelResponse(responseId: string | null): Completion;
  clearPlayback(): Completion;
}

export interface RealtimeConnector {
  connect(input: Readonly<{
    fence: VoiceFence;
    signal: AbortSignal;
    isCurrent(): boolean;
  }>): Promise<RealtimePeer>;
  abortPending(reason: string): Completion;
  // Confirmed requires provider-terminal evidence, not acknowledgement or a local timer.
  requestServerStop(reason: string): Promise<'confirmed' | 'unknown'>;
}

export type RealtimePlaybackEvent = Readonly<{
  type: 'response.started' | 'response.done' | 'playback.started' | 'playback.stopped' | 'playback.cleared';
  responseId: string;
}>;

export type RealtimePeerState = Readonly<{
  connection: 'idle' | 'connecting' | 'connected' | 'closed' | 'failed';
  generating: boolean;
  playing: boolean;
  cleanupFailures: readonly string[];
}>;

export type RealtimeConnectResult = 'connected' | 'cancelled' | 'failed' | 'already_started';

export function createRealtimePeerSlot(options: Readonly<{
  fence: VoiceFence;
  connector: RealtimeConnector;
  isCurrent(fence: VoiceFence): boolean;
}>) {
  const fence = Object.freeze({ ...options.fence });
  const abort = new AbortController();
  let valid = true;
  let started = false;
  let peer: RealtimePeer | null = null;
  let connection: RealtimePeerState['connection'] = 'idle';
  let responseId: string | null = null;
  let interrupted: string | null = null;
  let generating = false;
  let playing = false;
  let closeReason = 'stopped';
  let closeTask: Promise<void> | null = null;
  let abortTask: Promise<void> | null = null;
  let stopTask: Promise<'confirmed' | 'unknown'> | null = null;
  let connectionTask: Promise<RealtimeConnectResult> | null = null;
  const cleanupFailures: string[] = [];

  const current = () => valid && !abort.signal.aborted && options.isCurrent(fence);
  const attempt = (step: string, action: () => Completion): Promise<void> => {
    try {
      return Promise.resolve(action()).catch(() => { cleanupFailures.push(step); });
    } catch {
      cleanupFailures.push(step);
      return Promise.resolve();
    }
  };
  const invalidate = (reason: string) => {
    valid = false;
    closeReason = reason;
    generating = false;
    playing = false;
    connection = 'closed';
    abort.abort();
  };
  const dispose = (resource: RealtimePeer) => Promise.all([
    attempt('stopPlayback', () => resource.stopPlayback(closeReason)),
    attempt('closePeer', () => resource.close(closeReason)),
  ]).then(() => undefined);

  const slot = {
    snapshot(): RealtimePeerState {
      return Object.freeze({ connection, generating, playing, cleanupFailures: Object.freeze([...cleanupFailures]) });
    },
    connect(): Promise<RealtimeConnectResult> {
      if (!current()) return Promise.resolve('cancelled');
      if (started) return Promise.resolve('already_started');
      started = true;
      connection = 'connecting';
      let complete!: (result: RealtimeConnectResult) => void;
      connectionTask = new Promise(resolve => { complete = resolve; });
      void (async (): Promise<RealtimeConnectResult> => {
        try {
          const resource = await options.connector.connect({ fence, signal: abort.signal, isCurrent: current });
          if (!current()) {
            if (valid) invalidate('stale');
            await dispose(resource);
            return 'cancelled';
          }
          peer = resource;
          connection = 'connected';
          return 'connected';
        } catch {
          if (!current()) return 'cancelled';
          connection = 'failed';
          return 'failed';
        }
      })().then(complete, () => complete('failed'));
      return connectionTask;
    },
    observe(event: RealtimePlaybackEvent): boolean {
      if (!current() || !peer) return false;
      if (event.type === 'response.started') {
        if (event.responseId === interrupted) return false;
        responseId = event.responseId;
        generating = true;
        playing = false;
        return true;
      }
      if (event.responseId !== responseId || event.responseId === interrupted) return false;
      if (event.type === 'response.done') generating = false;
      else playing = event.type === 'playback.started';
      return true;
    },
    async interrupt(): Promise<Readonly<{ attempted: boolean; failures: readonly string[] }>> {
      if (!current() || !peer || (responseId !== null && responseId === interrupted)) {
        return { attempted: false, failures: [] };
      }
      interrupted = responseId;
      generating = false;
      playing = false;
      const resource = peer;
      const interruptedResponse = responseId;
      const failures: string[] = [];
      const run = (step: string, action: () => Completion) => {
        try { return Promise.resolve(action()).catch(() => { failures.push(step); }); }
        catch { failures.push(step); return Promise.resolve(); }
      };
      // Local silence and clear still run when generation already ended or cancel fails.
      const silence = run('stopPlayback', () => resource.stopPlayback('interrupt'));
      await run('cancelResponse', () => resource.cancelResponse(interruptedResponse));
      await Promise.all([silence, run('clearPlayback', () => resource.clearPlayback())]);
      return { attempted: true, failures };
    },
    abortPending(reason: string): Promise<void> {
      invalidate(reason);
      abortTask ??= Promise.resolve().then(() => attempt('abortPending', () => options.connector.abortPending(reason))).then(() => {
        if (cleanupFailures.includes('abortPending')) throw new Error('realtime_abort_incomplete');
      });
      return abortTask;
    },
    closeTransport(reason: string): Promise<void> {
      invalidate(reason);
      if (!closeTask) {
        const resource = peer;
        peer = null;
        closeTask = Promise.resolve().then(async () => {
          await Promise.all([resource ? dispose(resource) : Promise.resolve(), connectionTask]);
          if (cleanupFailures.includes('stopPlayback') || cleanupFailures.includes('closePeer')) {
            throw new Error('realtime_peer_cleanup_incomplete');
          }
        });
      }
      return closeTask;
    },
    requestServerStop(reason: string): Promise<'confirmed' | 'unknown'> {
      if (!stopTask) {
        stopTask = Promise.resolve().then(() => options.connector.requestServerStop(reason)).catch((): 'unknown' => 'unknown');
      }
      return stopTask;
    },
    // This observes late peer disposal; it never waits for server settlement.
    async settled(): Promise<void> {
      await Promise.allSettled([connectionTask, closeTask, abortTask]);
    },
  };
  return slot;
}

export type RealtimePeerSlot = ReturnType<typeof createRealtimePeerSlot>;

export type RealtimeAvailability =
  | Readonly<{ available: true }>
  | Readonly<{
    available: false;
    reason: 'native_unavailable' | 'microphone_denied' | 'provider_unconfigured' | 'transport_policy_pending';
  }>;

export type RealtimeStartResult =
  | Readonly<{ status: 'connected' | 'cancelled' | 'failed' | 'already_started' }>
  | Readonly<{ status: 'disabled'; reason: string }>;

export function createRealtimeController(options: Readonly<{
  account: VoiceAccount;
  // Each attempt receives a fresh controller backed by the canonical shared MicOwner.
  createSession(): VoiceSessionController;
  connector?: RealtimeConnector;
  availability?: RealtimeAvailability;
}>) {
  const account = Object.freeze({ ...options.account });
  let session: VoiceSessionController | null = null;
  let peer: RealtimePeerSlot | null = null;
  let started = false;
  let stopped = false;
  let state: 'idle' | 'disabled' | 'starting' | 'connected' | 'stopping' | 'stopped' | 'failed' = 'idle';
  let teardown: VoiceTeardown | null = null;
  let detach = () => {};
  const stop = (reason: TeardownReason): VoiceTeardown => {
    if (teardown) return teardown;
    stopped = true;
    state = 'stopping';
    detach();
    teardown = session?.stop(reason) ?? {
      local: Promise.resolve({ status: 'released', failedSteps: [] }),
      server: Promise.resolve({ status: 'unknown' }),
    };
    void teardown.local.then(result => { state = result.status === 'released' ? 'stopped' : 'failed'; });
    return teardown;
  };
  const transport: VoiceTransportTeardown = {
    abortPending: reason => peer?.abortPending(reason),
    closeTransport: reason => peer?.closeTransport(reason),
    async requestServerStop(reason) {
      if (!peer || await peer.requestServerStop(reason) !== 'confirmed') {
        throw new Error('realtime_server_stop_unknown');
      }
    },
  };

  return {
    snapshot() { return Object.freeze({ state, peer: peer?.snapshot() ?? null }); },
    async start(signal: AbortSignal): Promise<RealtimeStartResult> {
      if (stopped || signal.aborted) return { status: 'cancelled' };
      if (started) return { status: 'already_started' };
      started = true;
      const availability = options.availability ?? { available: false, reason: 'transport_policy_pending' };
      if (!availability.available || !options.connector) {
        state = 'disabled';
        return { status: 'disabled', reason: availability.available ? 'provider_unconfigured' : availability.reason };
      }
      state = 'starting';
      const onAbort = () => { stop('aborted'); };
      detach = () => signal.removeEventListener('abort', onAbort);
      signal.addEventListener('abort', onAbort, { once: true });
      try {
        session = options.createSession();
        if (stopped || signal.aborted) return { status: 'cancelled' };
        const fence = await session.start({ mode: 'realtime', account, signal, transport });
        if (stopped) return { status: 'cancelled' };
        session.assertCurrent(fence);
        peer = createRealtimePeerSlot({
          fence,
          connector: options.connector,
          isCurrent(captured) {
            if (stopped || !session) return false;
            try { session.assertCurrent(captured); return true; }
            catch { return false; }
          },
        });
        const result = await peer.connect();
        if (result !== 'connected' || stopped) {
          stop('failed');
          return { status: result === 'failed' ? 'failed' : 'cancelled' };
        }
        session.assertCurrent(fence);
        state = 'connected';
        return { status: 'connected' };
      } catch {
        const cancelled = stopped || signal.aborted;
        stop(cancelled ? 'aborted' : 'failed');
        return { status: cancelled ? 'cancelled' : 'failed' };
      }
    },
    observe(event: RealtimePlaybackEvent) { return peer?.observe(event) ?? false; },
    interrupt() { return peer?.interrupt() ?? Promise.resolve({ attempted: false, failures: [] }); },
    stop,
  };
}

export type RealtimeController = ReturnType<typeof createRealtimeController>;
