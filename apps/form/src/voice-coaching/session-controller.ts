import type {
  LocalTeardownResult, MicLease, MicOwner, TeardownReason, VoiceAccount, VoiceFence,
  VoiceMode, VoiceTeardown, VoiceTransportTeardown,
} from './contracts';

export function sameVoiceFence(left: VoiceFence, right: VoiceFence): boolean {
  return left.accountId === right.accountId && left.authSessionId === right.authSessionId
    && left.accountEpoch === right.accountEpoch && left.generation === right.generation;
}

function invoke<T>(effect: () => T | Promise<T>): Promise<T> {
  try { return Promise.resolve(effect()); } catch (error) { return Promise.reject(error); }
}

export class ExclusiveMicOwner implements MicOwner {
  private occupied = false;
  private readonly driver: MicOwner;
  constructor(driver: MicOwner) { this.driver = driver; }

  async acquire(input: Parameters<MicOwner['acquire']>[0]): Promise<MicLease> {
    input.signal.throwIfAborted();
    if (this.occupied) throw new Error('voice_microphone_busy');
    this.occupied = true;
    const fence = Object.freeze({ ...input.fence });
    // A rejected driver acquisition is unproved ownership; only proved cleanup opens the gate.
    const lease = await this.driver.acquire({ ...input, fence });
    const attempts = new Map<string, Promise<void>>();
    const succeeded = new Set<string>();
    const once = (step: string, effect: () => void | Promise<void>): Promise<void> => {
      const prior = attempts.get(step);
      if (prior) return prior;
      const attempt = Promise.resolve().then(effect).then(() => { succeeded.add(step); });
      attempts.set(step, attempt);
      return attempt;
    };
    return Object.freeze({
      fence: Object.freeze({ ...lease.fence }),
      stopCapture: (reason: TeardownReason) => once('capture', () => lease.stopCapture(reason)),
      stopPlayback: (reason: TeardownReason) => once('playback', () => lease.stopPlayback(reason)),
      deactivateAudio: (reason: TeardownReason) => once('deactivate', () => lease.deactivateAudio(reason)),
      release: (reason: TeardownReason) => once('release', async () => {
        await lease.release(reason);
        if (sameVoiceFence(lease.fence, fence) && ['capture', 'playback', 'deactivate'].every(step => succeeded.has(step))) this.occupied = false;
      }),
    });
  }
}

type Session = {
  fence: VoiceFence;
  abort: AbortController;
  transport: VoiceTransportTeardown;
  acquisition: Promise<MicLease>;
  acquisitionStarted: boolean;
  detach: () => void;
  teardown?: VoiceTeardown;
};

export class VoiceSessionController {
  private generation = 0;
  private session: Session | undefined;
  private lastTeardown: VoiceTeardown | undefined;

  private readonly mic: MicOwner;
  private readonly assertAccountCurrent: (fence: VoiceFence) => void;
  constructor(mic: MicOwner, assertAccountCurrent: (fence: VoiceFence) => void) {
    this.mic = mic;
    this.assertAccountCurrent = assertAccountCurrent;
  }

  async start(input: Readonly<{
    mode: VoiceMode;
    account: VoiceAccount;
    signal: AbortSignal;
    transport: VoiceTransportTeardown;
  }>): Promise<VoiceFence> {
    input.signal.throwIfAborted();
    if (this.session) throw new Error('voice_session_busy');
    const fence = Object.freeze({
      accountId: input.account.accountId,
      authSessionId: input.account.authSessionId,
      accountEpoch: input.account.accountEpoch,
      generation: ++this.generation,
    });
    this.assertAccountCurrent(fence);
    input.signal.throwIfAborted();
    const abort = new AbortController();
    const mode = input.mode;
    const session: Session = {
      fence, abort, transport: input.transport, acquisitionStarted: false,
      acquisition: Promise.resolve().then(() => {
        abort.signal.throwIfAborted();
        session.acquisitionStarted = true;
        return this.mic.acquire({ mode, fence, signal: abort.signal });
      }),
      detach: () => input.signal.removeEventListener('abort', onAbort),
    };
    const onAbort = () => { this.stop('aborted'); };
    this.session = session;
    this.lastTeardown = undefined;
    input.signal.addEventListener('abort', onAbort, { once: true });
    if (input.signal.aborted) onAbort();
    try {
      const lease = await session.acquisition;
      this.assertCurrent(fence);
      if (!sameVoiceFence(lease.fence, fence)) throw new Error('voice_lease_fence_mismatch');
      return fence;
    } catch (error) {
      if (this.session === session && !session.teardown) this.stop('failed');
      throw error;
    }
  }

  assertCurrent(fence: VoiceFence): void {
    const session = this.session;
    if (!session || session.teardown || this.generation !== fence.generation
      || !sameVoiceFence(session.fence, fence)) throw new Error('voice_session_stale');
    session.abort.signal.throwIfAborted();
    this.assertAccountCurrent(session.fence);
  }

  stop(reason: TeardownReason): VoiceTeardown {
    const session = this.session;
    if (!session) {
      return this.lastTeardown ?? {
        local: Promise.resolve({ status: 'released', failedSteps: [] }),
        server: Promise.resolve({ status: 'unknown' }),
      };
    }
    if (session.teardown) return session.teardown;
    ++this.generation;
    session.detach();
    // Publish the handle before abort listeners or injected cleanup can reenter stop().
    let resolveLocal!: (result: LocalTeardownResult) => void;
    let resolveServer!: (result: { status: 'acknowledged' | 'unknown' }) => void;
    const teardown: VoiceTeardown = Object.freeze({
      local: new Promise<LocalTeardownResult>(resolve => { resolveLocal = resolve; }),
      server: new Promise<{ status: 'acknowledged' | 'unknown' }>(resolve => { resolveServer = resolve; }),
    });
    session.teardown = teardown;
    this.lastTeardown = teardown;
    session.abort.abort(reason);
    const failures: string[] = [];
    const attempt = (step: string, effect: () => void | Promise<void>) =>
      invoke(effect).catch(() => { failures.push(step); });
    const pending = attempt('abortPending', () => session.transport.abortPending(reason));
    const transport = attempt('closeTransport', () => session.transport.closeTransport(reason));
    void (async () => {
      let lease: MicLease | undefined;
      try { lease = await session.acquisition; } catch { if (session.acquisitionStarted) failures.push('acquire'); }
      if (lease) {
        if (!sameVoiceFence(lease.fence, session.fence)) failures.push('leaseFence');
        await Promise.all([
          attempt('stopCapture', () => lease.stopCapture(reason)),
          attempt('stopPlayback', () => lease.stopPlayback(reason)),
        ]);
        await attempt('deactivateAudio', () => lease.deactivateAudio(reason));
        await attempt('release', () => lease.release(reason));
      }
      await Promise.all([pending, transport]);
      const status = failures.length === 0 ? 'released' : 'incomplete';
      if (status === 'released' && this.session === session) this.session = undefined;
      resolveLocal(Object.freeze({ status, failedSteps: Object.freeze([...failures]) }));
    })();
    // Server acknowledgement is independent and does not prove remote termination.
    void invoke(() => session.transport.requestServerStop(reason)).then(
      () => resolveServer({ status: 'acknowledged' }),
      () => resolveServer({ status: 'unknown' }),
    );
    return teardown;
  }
}
