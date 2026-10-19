import type { MicLease, MicOwner, VoiceFence } from '../contracts';
import type { NativeBinding } from '../../native/runtime';
import type { FormVoiceNative, VoiceAvailability, VoiceNativeInvalidation, VoiceNativeLimits, VoiceProviderBounds } from './contracts';

const HARD_BYTES = 25_000_000;
const fail = (code: string) => new Error(code);
const positiveInteger = (value: number) => Number.isSafeInteger(value) && value > 0;
const sameFence = (a: VoiceFence, b: VoiceFence) => a.accountId === b.accountId
  && a.authSessionId === b.authSessionId && a.accountEpoch === b.accountEpoch && a.generation === b.generation;

export function validateVoiceLimits(limits: VoiceNativeLimits, provider: VoiceProviderBounds): VoiceNativeLimits {
  if (!positiveInteger(provider.maxAudioBytes) || !positiveInteger(provider.maxSpeechBytes)
    || provider.maxAudioBytes > HARD_BYTES || provider.maxSpeechBytes > HARD_BYTES
    || !positiveInteger(limits.maxCaptureBytes) || limits.maxCaptureBytes < 46
    || (limits.maxCaptureBytes - 44) % 2 !== 0 || limits.maxCaptureBytes > provider.maxAudioBytes
    || !positiveInteger(limits.maxPlaybackBytes) || limits.maxPlaybackBytes > provider.maxSpeechBytes
    || !positiveInteger(limits.maxCaptureDurationMs) || ![16000, 24000].includes(limits.sampleRate)) {
    throw fail('voice_limits_invalid');
  }
  const bytesPerSecond = limits.sampleRate * 2;
  const maximumDuration = Math.floor((limits.maxCaptureBytes - 44) * 1000 / bytesPerSecond);
  if (limits.maxCaptureDurationMs > maximumDuration
    || Math.ceil(limits.maxCaptureDurationMs * bytesPerSecond / 1000) + 44 > limits.maxCaptureBytes) {
    throw fail('voice_limits_incompatible');
  }
  return Object.freeze({ ...limits });
}

function waveSignature(bytes: Uint8Array): boolean {
  return bytes.length >= 12 && [82, 73, 70, 70].every((v, i) => bytes[i] === v)
    && [87, 65, 86, 69].every((v, i) => bytes[i + 8] === v);
}

function validateCapture(bytes: Uint8Array, limits: VoiceNativeLimits): void {
  if (!(bytes instanceof Uint8Array) || bytes.length < 46 || bytes.length > limits.maxCaptureBytes || !waveSignature(bytes)) {
    throw fail('voice_capture_invalid');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = (at: number, chars: string) => [...chars].every((char, i) => bytes[at + i] === char.charCodeAt(0));
  if (!text(12, 'fmt ') || !text(36, 'data') || view.getUint32(4, true) !== bytes.length - 8
    || view.getUint32(16, true) !== 16 || view.getUint16(20, true) !== 1 || view.getUint16(22, true) !== 1
    || view.getUint32(24, true) !== limits.sampleRate || view.getUint32(28, true) !== limits.sampleRate * 2
    || view.getUint16(32, true) !== 2 || view.getUint16(34, true) !== 16
    || view.getUint32(40, true) !== bytes.length - 44 || (bytes.length - 44) % 2 !== 0
    || (bytes.length - 44) * 1000 > limits.maxCaptureDurationMs * limits.sampleRate * 2) {
    throw fail('voice_capture_invalid');
  }
}

type CleanupStep = 'stopCapture' | 'stopPlayback' | 'deactivateAudio' | 'release';
type LeaseRecord = {
  id: string; fence: VoiceFence; signal: AbortSignal; invalid: boolean; openStarted: boolean;
  opened: Promise<void>; detach(): void; cleanup?: Promise<void>;
  attempts: Map<CleanupStep, Promise<void>>; passed: Set<CleanupStep>; failed: Set<CleanupStep>;
  phase: 'idle' | 'capturing' | 'finishing' | 'playing';
};

export function createFormVoiceDriver(options: Readonly<{
  binding: NativeBinding<FormVoiceNative>;
  limits: VoiceNativeLimits;
  providerBounds: VoiceProviderBounds;
  sharedOwnershipReady?: boolean;
  nativeQualified?: boolean;
  newLeaseId(): string;
  assertCurrent(fence: VoiceFence): void;
  onInvalidated(fence: VoiceFence, event: VoiceNativeInvalidation['reason']): void;
}>) {
  const limits = validateVoiceLimits(options.limits, options.providerBounds);
  const binding = options.binding;
  const native = binding.module;
  const sharedReady = options.sharedOwnershipReady === true;
  const qualified = options.nativeQualified === true;
  let active: LeaseRecord | null = null;
  let disposed = false;
  let lastLeaseId: string | null = null;

  const disabled = (reason: VoiceAvailability['reason']): VoiceAvailability => ({ available: false, reason, permission: 'unknown' });
  const gate = (): VoiceAvailability | null => {
    if (disposed) return disabled('module_destroyed');
    if (!sharedReady) return disabled('shared_ownership_unready');
    if (!qualified) return disabled('native_unqualified');
    if (!binding.module) return disabled(binding.reason);
    return null;
  };
  const availability = async (): Promise<VoiceAvailability> => {
    const unavailable = gate();
    if (unavailable) return unavailable;
    try { const result = await native!.availability(); return gate() ?? result; }
    catch { return disabled('native_probe_failed'); }
  };
  const assertRecord = (record: LeaseRecord) => {
    if (disposed || record.invalid || active !== record || record.signal.aborted) throw fail('voice_lease_stale');
    options.assertCurrent(record.fence);
  };
  const selected = (fence: VoiceFence): LeaseRecord => {
    const record = active;
    if (!record || !sameFence(record.fence, fence)) throw fail('voice_lease_stale');
    assertRecord(record);
    return record;
  };
  const invalidate = (record: LeaseRecord) => { record.invalid = true; record.detach(); };
  const step = (record: LeaseRecord, name: CleanupStep): Promise<void> => {
    invalidate(record);
    let task = record.attempts.get(name);
    if (!task) {
      task = Promise.resolve().then(async () => {
        try { await record.opened; } catch { /* A failed open may still have created the exact native lease. */ }
        if (record.openStarted) await native![name](record.id);
        if (name === 'release') {
          if (record.failed.size || !['stopCapture', 'stopPlayback', 'deactivateAudio'].every(s => record.passed.has(s as CleanupStep))) {
            throw fail('voice_cleanup_incomplete');
          }
          if (active === record) active = null;
        }
        record.passed.add(name);
      }).catch(() => { record.failed.add(name); throw fail(`voice_${name}_failed`); });
      record.attempts.set(name, task);
    }
    return task;
  };
  const cleanup = (record: LeaseRecord): Promise<void> => {
    invalidate(record);
    if (!record.cleanup) {
      record.cleanup = Promise.resolve().then(async () => {
        await Promise.allSettled([step(record, 'stopCapture'), step(record, 'stopPlayback')]);
        await step(record, 'deactivateAudio').catch(() => {});
        await step(record, 'release').catch(() => {});
        if (record.failed.size) throw fail('voice_cleanup_incomplete');
      });
    }
    return record.cleanup;
  };
  const notifyInvalidated = (record: LeaseRecord, reason: VoiceNativeInvalidation['reason']) => {
    invalidate(record);
    void cleanup(record).catch(() => {});
    try { options.onInvalidated(record.fence, reason); } catch { /* Observer errors cannot skip native cleanup. */ }
  };
  const subscription = native?.addListener('onInvalidated', event => {
    if (active?.id === event.leaseId) notifyInvalidated(active, event.reason);
  });
  const perform = async <T>(record: LeaseRecord, operation: () => Promise<T>): Promise<T> => {
    try {
      assertRecord(record);
      const value = await operation();
      assertRecord(record);
      return value;
    } catch {
      notifyInvalidated(record, 'audio_error');
      throw fail('voice_operation_failed');
    }
  };

  const micOwner: MicOwner = {
    async acquire(input): Promise<MicLease> {
      const fence = Object.freeze({ ...input.fence });
      const signal = input.signal;
      signal.throwIfAborted();
      options.assertCurrent(fence);
      if (input.mode !== 'standard') throw fail('voice_mode_unsupported');
      if (active) throw fail('voice_native_busy');
      const status = await availability();
      signal.throwIfAborted(); options.assertCurrent(fence);
      if (!status.available || !native) throw fail(`voice_${status.reason}`);
      if (active) throw fail('voice_native_busy');
      const id = options.newLeaseId();
      if (!id || id.length > 128 || id === lastLeaseId) throw fail('voice_lease_id_invalid');
      signal.throwIfAborted(); options.assertCurrent(fence);
      lastLeaseId = id;
      let resolveOpen!: () => void, rejectOpen!: (error: unknown) => void;
      const record: LeaseRecord = {
        id, fence, signal, invalid: false, openStarted: false,
        opened: new Promise<void>((resolve, reject) => { resolveOpen = resolve; rejectOpen = reject; }),
        detach: () => signal.removeEventListener('abort', onAbort),
        attempts: new Map(), passed: new Set(), failed: new Set(), phase: 'idle',
      };
      const onAbort = () => { invalidate(record); void cleanup(record).catch(() => {}); };
      active = record;
      signal.addEventListener('abort', onAbort, { once: true });
      try {
        assertRecord(record);
        record.openStarted = true;
        Promise.resolve(native.openLease(id, fence)).then(resolveOpen, rejectOpen);
      } catch (error) { rejectOpen(error); }
      try { await record.opened; assertRecord(record); }
      catch {
        await cleanup(record).catch(() => {});
        throw fail('voice_acquisition_failed');
      }
      return Object.freeze({
        fence,
        stopCapture: () => step(record, 'stopCapture'),
        stopPlayback: () => step(record, 'stopPlayback'),
        deactivateAudio: () => step(record, 'deactivateAudio'),
        release: () => step(record, 'release'),
      });
    },
  };

  return {
    micOwner,
    availability,
    async requestPermission() {
      const unavailable = gate();
      if (unavailable || !native) throw fail(`voice_${unavailable?.reason ?? 'native_module_missing'}`);
      const result = await native.requestPermission();
      if (gate()) throw fail('voice_permission_stale');
      return result;
    },
    capture: {
      async start(fence: VoiceFence): Promise<void> {
        const record = selected(fence);
        if (record.phase !== 'idle') throw fail('voice_native_busy');
        record.phase = 'capturing';
        await perform(record, () => native!.startCapture(record.id, limits));
      },
      async finish(fence: VoiceFence): Promise<Blob> {
        const record = selected(fence);
        if (record.phase !== 'capturing') throw fail('voice_capture_not_started');
        record.phase = 'finishing';
        return perform(record, async () => {
          const bytes = await native!.finishCapture(record.id);
          assertRecord(record);
          validateCapture(bytes, limits);
          const blob = new Blob([new Uint8Array(bytes).buffer], { type: 'audio/wav' });
          record.phase = 'idle';
          return blob;
        });
      },
    },
    playback: {
      async play(fence: VoiceFence, blob: Blob): Promise<void> {
        const record = selected(fence);
        if (record.phase !== 'idle') throw fail('voice_native_busy');
        if (!positiveInteger(blob.size) || blob.size > limits.maxPlaybackBytes) throw fail('voice_playback_too_large');
        record.phase = 'playing';
        await perform(record, async () => {
          const bytes = new Uint8Array(await blob.arrayBuffer());
          assertRecord(record);
          if (bytes.byteLength !== blob.size || !waveSignature(bytes)) throw fail('voice_playback_invalid');
          await native!.playWav(record.id, bytes);
          assertRecord(record);
          record.phase = 'idle';
        });
      },
    },
    async dispose(): Promise<void> {
      disposed = true;
      try { if (active) await cleanup(active); }
      finally { subscription?.remove(); }
    },
  };
}

export type FormVoiceDriver = ReturnType<typeof createFormVoiceDriver>;
