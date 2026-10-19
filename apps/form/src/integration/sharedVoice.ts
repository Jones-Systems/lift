import { FormSpeechAdapter } from '../native/speech';
import { FormNativeError, type NativeBinding } from '../native/runtime';
import type { FormSpeechNative, SpeechSessionHook } from '../native/speech.types';
import { ExclusiveMicOwner, VoiceSessionController, sameVoiceFence } from '../voice-coaching/session-controller';
import { createDictationDriver } from '../voice-coaching/native/dictation-driver';
import { createFormVoiceDriver } from '../voice-coaching/native/driver';
import type { FormVoiceNative, VoiceNativeLimits, VoiceProviderBounds } from '../voice-coaching/native/contracts';
import type { LocalTeardownResult, TeardownReason, VoiceAccount, VoiceFence, VoiceMode, VoiceTeardown } from '../voice-coaching/contracts';

/** Client teardown coordinates only; these values are never server authority or credentials. */
export type SharedVoiceScope = Readonly<{
  account: VoiceAccount;
  isCurrent(): boolean;
}>;
export function captureSharedVoiceScope(
  api: { captureAuthContext(): { isCurrent(): boolean } },
  account: VoiceAccount,
  isCurrent: () => boolean,
): SharedVoiceScope {
  const auth = api.captureAuthContext();
  return Object.freeze({ account: Object.freeze({ ...account }), isCurrent: () => auth.isCurrent() && isCurrent() });
}
export type SharedVoiceStandardConfiguration = Readonly<{
  binding: NativeBinding<FormVoiceNative>;
  limits: VoiceNativeLimits;
  providerBounds: VoiceProviderBounds;
  newLeaseId(): string;
}>;
export type SharedVoiceStandardInvalidation = Readonly<{
  scope: SharedVoiceScope; fence: VoiceFence; sessionId: string; signal?: AbortSignal; reason: 'interruption';
}>;
type Record = {
  scope: SharedVoiceScope; mode: VoiceMode; sessionId: string; abort: AbortController;
  fence?: VoiceFence; teardown?: VoiceTeardown; detachAbort?: () => void; callerSignal?: AbortSignal;
};
const fail = (code: string) => new FormNativeError(code, 'Shared audio is unavailable for this session.');
const sameAccount = (a: VoiceAccount, b: VoiceAccount) => a.accountId === b.accountId &&
  a.authSessionId === b.authSessionId && a.accountEpoch === b.accountEpoch;

export function createSharedVoice(options: Readonly<{
  speech: NativeBinding<FormSpeechNative>;
  standard?: SharedVoiceStandardConfiguration;
  onStandardInvalidated?: (input: SharedVoiceStandardInvalidation) => void;
}>) {
  let disposed = false;
  let stopGeneration = 0;
  let active: Record | null = null;
  const adapters = new Map<FormSpeechAdapter, SharedVoiceScope | null>();
  const assertScope = (scope: SharedVoiceScope | null): SharedVoiceScope => {
    if (disposed) throw fail('module_destroyed');
    if (!scope || !scope.account.accountId || !scope.account.authSessionId ||
      !Number.isSafeInteger(scope.account.accountEpoch) || scope.account.accountEpoch < 0) throw fail('shared_scope_unavailable');
    if (!scope.isCurrent()) throw fail('session_changed');
    return scope;
  };
  let controller: VoiceSessionController;
  const assertFence = (fence: VoiceFence) => {
    if (!active || !sameAccount(active.scope.account, fence)) throw fail('session_changed');
    assertScope(active.scope);
    controller.assertCurrent(fence);
  };
  const raw = options.speech.module;
  const dictation = createDictationDriver({ assertCurrent: assertFence, port: {
    async start(input) {
      assertFence(input.fence); input.signal.throwIfAborted();
      if (!raw) throw fail(options.speech.reason ?? 'native_module_missing');
      const result = await raw.start(input.locale, input.sessionId);
      if (result.sessionId !== input.sessionId) throw fail('stale_session');
    },
    async stop(id) { if (!raw) throw fail('native_module_missing'); await raw.stop(id); },
    async cancel(id) { if (!raw) throw fail('native_module_missing'); await raw.cancel(id); },
  } });
  const standard = options.standard ? createFormVoiceDriver({ ...options.standard,
    sharedOwnershipReady: false, nativeQualified: false,
    assertCurrent: assertFence,
    onInvalidated: (fence) => {
      const record = active;
      if (record?.mode !== 'standard' || (record.fence && !sameVoiceFence(record.fence, fence))) return;
      try { assertFence(fence); } catch { return; }
      const invalidatedFence = record.fence ?? Object.freeze({ ...fence });
      record.detachAbort?.(); record.detachAbort = undefined;
      try {
        options.onStandardInvalidated?.(Object.freeze({ scope: record.scope, fence: invalidatedFence, sessionId: record.sessionId,
          signal: record.callerSignal, reason: 'interruption' }));
      } catch { /* The observer cannot skip cleanup of this exact shared record. */ }
      finally { void stopRecord(record, 'interruption').catch(() => {}); }
    },
  }) : null;
  const owner = new ExclusiveMicOwner({ acquire: input => {
    if (input.mode === 'dictation') return dictation.micOwner.acquire(input);
    if (input.mode === 'standard' && standard) return standard.micOwner.acquire(input);
    return Promise.reject(fail('voice_mode_unavailable'));
  } });
  controller = new VoiceSessionController(owner, fence => {
    if (!active || !sameAccount(active.scope.account, fence)) throw fail('session_changed');
    assertScope(active.scope);
  });
  async function stopRecord(record: Record, reason: TeardownReason): Promise<LocalTeardownResult> {
    if (!record.teardown && active !== record) throw fail('session_changed');
    record.detachAbort?.();
    record.detachAbort = undefined;
    record.teardown ??= controller.stop(reason);
    const result = await record.teardown.local;
    if (result.status === 'released' && active === record) active = null;
    return result;
  }
  async function begin(scope: SharedVoiceScope | null, mode: VoiceMode, sessionId: string, locale?: string, signal?: AbortSignal): Promise<Record> {
    signal?.throwIfAborted();
    const supplied = assertScope(scope);
    const original = Object.freeze({ account: Object.freeze({ ...supplied.account }), isCurrent: supplied.isCurrent });
    const startedIn = stopGeneration;
    if (mode === 'realtime') throw fail('realtime_disabled');
    if (mode === 'dictation') {
      if (!raw) throw fail(options.speech.reason ?? 'native_module_missing');
      const availability = await raw.availability(locale!);
      assertScope(original);
      if (!availability.available) throw fail(availability.reason);
    } else {
      const availability = await standard?.availability();
      assertScope(original);
      if (!availability?.available) throw fail(availability?.reason ?? 'native_unqualified');
    }
    signal?.throwIfAborted();
    if (startedIn !== stopGeneration) throw fail('cancelled');
    if (active) throw fail('voice_microphone_busy');
    const record: Record = { scope: original, mode, sessionId, abort: new AbortController(), callerSignal: signal };
    active = record;
    try {
      const starting = controller.start({ mode, account: original.account, signal: record.abort.signal,
        transport: { abortPending() {}, closeTransport() {}, async requestServerStop() { throw fail('server_stop_unavailable'); } } });
      if (signal) {
        const abort = () => { if (active === record) void stopRecord(record, 'aborted').catch(() => {}); };
        record.detachAbort = () => signal.removeEventListener('abort', abort);
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      }
      record.fence = await starting;
      assertScope(original);
      assertFence(record.fence);
      signal?.throwIfAborted();
      return record;
    } catch (error) { await stopRecord(record, 'failed'); throw error; }
  }
  function speech(scope: SharedVoiceScope | null) {
    const captured = scope ? Object.freeze({ account: Object.freeze({ ...scope.account }), isCurrent: scope.isCurrent }) : null;
    let record: Record | null = null;
    let cancelledId: string | null = null;
    const hook: SpeechSessionHook = {
      isCurrent: () => !disposed && !!captured?.isCurrent(),
      onDispose: () => { adapters.delete(adapter); },
      async start(locale, id) {
        cancelledId = null;
        record = null;
        const next = await begin(captured, 'dictation', id, locale);
        record = next;
        if (cancelledId === id || !hook.isCurrent()) {
          const result = await stopRecord(next, 'aborted');
          if (result.status !== 'released') throw fail('audio_cleanup_failed');
          throw fail('cancelled');
        }
        try { await dictation.start(next.fence!, { sessionId: id, locale }); return { sessionId: id }; }
        catch (error) { await stopRecord(next, 'failed'); throw error; }
      },
      async stop(id) {
        if (!record || record.sessionId !== id) throw fail('stale_session');
        assertScope(captured);
        try { await dictation.stopForReview(record.fence!); }
        catch (error) {
          if (!record.teardown || (await record.teardown.local).status !== 'released') throw error;
        }
      },
      async cancel(id) {
        cancelledId = id;
        if (!record) return;
        if (record.sessionId !== id) throw fail('stale_session');
        const result = await stopRecord(record, 'user_stop');
        if (result.status !== 'released') throw fail('audio_cleanup_failed');
      },
    };
    const adapter = new FormSpeechAdapter(options.speech, hook);
    adapters.set(adapter, captured);
    return adapter;
  }
  return {
    speech,
    async startStandard(scope: SharedVoiceScope, sessionId: string, signal?: AbortSignal) {
      const record = await begin(scope, 'standard', sessionId, undefined, signal);
      const assertCurrent = () => {
        if (active !== record || !record.fence) throw fail('session_changed');
        assertFence(record.fence);
        signal?.throwIfAborted();
      };
      try { assertCurrent(); }
      catch (error) { await stopRecord(record, 'aborted'); throw error; }
      return Object.freeze({ fence: record.fence!,
        assertCurrent,
        async startCapture() { assertCurrent(); await standard!.capture.start(record.fence!); assertCurrent(); },
        async finishCapture() { assertCurrent(); const result = await standard!.capture.finish(record.fence!); assertCurrent(); return result; },
        async play(blob: Blob) { assertCurrent(); await standard!.playback.play(record.fence!, blob); assertCurrent(); },
        stop: (reason: TeardownReason) => stopRecord(record, reason) });
    },
    async stopScope(scope: SharedVoiceScope, reason: TeardownReason = 'account_changed'): Promise<LocalTeardownResult> {
      const selected = [...adapters].filter(([, bound]) => bound && sameAccount(bound.account, scope.account)).map(([adapter]) => adapter);
      const stopping = active && sameAccount(active.scope.account, scope.account)
        ? stopRecord(active, reason) : Promise.resolve<LocalTeardownResult>({ status: 'released', failedSteps: [] });
      const results = await Promise.allSettled(selected.map(adapter => adapter.cancel()));
      const local = await stopping;
      return results.some(result => result.status === 'rejected')
        ? { status: 'incomplete', failedSteps: [...local.failedSteps, 'dictation_adapter'] } : local;
    },
    async stop(reason: TeardownReason): Promise<LocalTeardownResult> {
      stopGeneration += 1;
      const stopping = active ? stopRecord(active, reason) : Promise.resolve<LocalTeardownResult>({ status: 'released', failedSteps: [] });
      const results = await Promise.allSettled([...adapters.keys()].map(adapter => adapter.cancel()));
      const local = await stopping;
      return results.some(result => result.status === 'rejected')
        ? { status: 'incomplete', failedSteps: [...local.failedSteps, 'dictation_adapter'] } : local;
    },
    async dispose(): Promise<void> {
      disposed = true;
      stopGeneration += 1;
      const results = await Promise.allSettled([...adapters.keys()].map(adapter => adapter.dispose()));
      const local = active ? await stopRecord(active, 'navigation') : null;
      await standard?.dispose();
      if (local?.status === 'incomplete' || results.some(result => result.status === 'rejected')) throw fail('audio_cleanup_failed');
      adapters.clear();
    },
  };
}
