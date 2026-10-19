import type { MicLease, MicOwner, VoiceFence } from '../contracts';
import type { DictationNativePort } from './contracts';

type Reservation = {
  fence: VoiceFence;
  signal: AbortSignal;
  invalid: boolean;
  detach(): void;
  sessionId: string | null;
  startTask: Promise<void> | null;
  startPending: boolean;
  stopTask: Promise<void> | null;
  stopPending: boolean;
  cleanupTask: Promise<void> | null;
  releaseTask: Promise<void> | null;
};

const fail = (code: string) => new Error(code);
const sameFence = (a: VoiceFence, b: VoiceFence) => a.accountId === b.accountId
  && a.authSessionId === b.authSessionId && a.accountEpoch === b.accountEpoch && a.generation === b.generation;

function invoke(action: () => Promise<void>): Promise<void> {
  try { return Promise.resolve(action()); } catch (error) { return Promise.reject(error); }
}

export function createDictationDriver(options: Readonly<{
  port: DictationNativePort;
  assertCurrent(fence: VoiceFence): void;
}>) {
  const port = options.port;
  let active: Reservation | null = null;

  const assertRecord = (record: Reservation) => {
    const current = () => active === record && !record.invalid && !record.signal.aborted;
    if (!current()) throw fail('dictation_lease_stale');
    options.assertCurrent(record.fence);
    if (!current()) throw fail('dictation_lease_stale');
  };
  const select = (fence: VoiceFence) => {
    if (!active || !sameFence(active.fence, fence)) throw fail('dictation_lease_stale');
    return active;
  };
  const cleanup = (record: Reservation): Promise<void> => {
    record.invalid = true;
    record.detach();
    if (record.cleanupTask) return record.cleanupTask;
    let resolve!: () => void, reject!: (error: Error) => void;
    const task = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    record.cleanupTask = task;
    const id = record.sessionId;
    const started = record.startTask;
    const stopped = record.stopTask;
    const lateOperation = record.startPending || record.stopPending;
    if (id === null || started === null) { resolve(); return task; }

    // Cancel immediately, then dispose native work that can finish after the first cancellation.
    let failed = false;
    const firstCancel = invoke(() => port.cancel(id)).catch(() => { failed = true; });
    void (async () => {
      await Promise.allSettled([firstCancel, started, stopped]);
      if (lateOperation) await invoke(() => port.cancel(id)).catch(() => { failed = true; });
      if (failed) reject(fail('dictation_cleanup_incomplete'));
      else resolve();
    })();
    return task;
  };
  const release = (record: Reservation): Promise<void> => {
    record.releaseTask ??= cleanup(record).then(() => { if (active === record) active = null; });
    return record.releaseTask;
  };

  const micOwner: MicOwner = {
    async acquire(input): Promise<MicLease> {
      if (input.mode !== 'dictation') throw fail('dictation_mode_unsupported');
      if (active) throw fail('dictation_busy');
      const fence = Object.freeze({ ...input.fence });
      const signal = input.signal;
      const onAbort = () => { void cleanup(record).catch(() => {}); };
      const record: Reservation = {
        fence, signal, invalid: false, detach: () => signal.removeEventListener('abort', onAbort),
        sessionId: null, startTask: null, startPending: false, stopTask: null, stopPending: false,
        cleanupTask: null, releaseTask: null,
      };
      active = record;
      signal.addEventListener('abort', onAbort, { once: true });
      // A cancelled inert reservation still returns its lease so the shared owner can release it.
      if (signal.aborted) onAbort();
      return Object.freeze({
        fence,
        stopCapture: () => cleanup(record),
        stopPlayback: () => cleanup(record),
        deactivateAudio: () => cleanup(record),
        release: () => release(record),
      });
    },
  };

  return {
    micOwner,
    async start(fence: VoiceFence, input: Readonly<{ sessionId: string; locale: string }>): Promise<void> {
      const record = select(fence);
      const { sessionId, locale } = input;
      if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 128
        || typeof locale !== 'string' || !locale || locale.length > 80) throw fail('dictation_start_invalid');
      if (record.startTask) throw fail('dictation_already_started');
      try {
        assertRecord(record);
        let resolve!: () => void, reject!: (error: unknown) => void;
        record.startTask = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
        record.startPending = true;
        record.sessionId = sessionId;
        const request = Object.freeze({ sessionId, locale, fence: record.fence, signal: record.signal });
        invoke(() => port.start(request)).then(
          () => { record.startPending = false; resolve(); },
          error => { record.startPending = false; reject(error); },
        );
        await record.startTask;
        assertRecord(record);
      } catch {
        await cleanup(record).catch(() => {});
        throw fail('dictation_start_failed');
      }
    },
    async stopForReview(fence: VoiceFence): Promise<void> {
      const record = select(fence);
      const id = record.sessionId;
      const started = record.startTask;
      if (id === null || started === null) throw fail('dictation_not_started');
      try {
        assertRecord(record);
        if (!record.stopTask) {
          let resolve!: () => void, reject!: (error: unknown) => void;
          record.stopTask = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
          record.stopPending = true;
          void (async () => {
            await started;
            assertRecord(record);
            await invoke(() => port.stop(id));
          })().then(
            () => { record.stopPending = false; resolve(); },
            error => { record.stopPending = false; reject(error); },
          );
        }
        await record.stopTask;
        assertRecord(record);
      } catch {
        await cleanup(record).catch(() => {});
        throw fail('dictation_finalization_failed');
      }
    },
  };
}

export type DictationDriver = ReturnType<typeof createDictationDriver>;
