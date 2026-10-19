export class BrowserVoiceError extends Error {
  constructor(code) { super(code); this.name = 'BrowserVoiceError'; this.code = code; }
}

export const sameFence = (a, b) => Boolean(a && b && a.accountId === b.accountId &&
  a.authSessionId === b.authSessionId && a.accountEpoch === b.accountEpoch && a.generation === b.generation);

export function validAccount(value) {
  return Boolean(value && typeof value.accountId === 'string' && value.accountId.length &&
    typeof value.authSessionId === 'string' && value.authSessionId.length &&
    Number.isSafeInteger(value.accountEpoch) && value.accountEpoch >= 0);
}

const invoke = effect => { try { return Promise.resolve(effect()); } catch (error) { return Promise.reject(error); } };
const mediaError = error => new BrowserVoiceError(
  ['NotAllowedError', 'PermissionDeniedError', 'SecurityError'].includes(error?.name) ? 'voice_permission_denied' :
    ['NotFoundError', 'DevicesNotFoundError', 'OverconstrainedError'].includes(error?.name) ? 'voice_microphone_unavailable' :
      error?.name === 'AbortError' ? 'voice_capture_interrupted' : 'voice_capture_failed');

export function createBrowserMicOwner({ mediaDevices = globalThis.navigator?.mediaDevices,
  secureContext = globalThis.isSecureContext === true,
  stopPlayback = () => {}, deactivateAudio = () => {} } = {}) {
  if (typeof stopPlayback !== 'function' || typeof deactivateAudio !== 'function') throw new TypeError('voice_audio_ports_invalid');
  let occupied = null, last = null;
  const supported = () => secureContext && typeof mediaDevices?.getUserMedia === 'function';
  function snapshot() {
    return Object.freeze({ status: last?.status ?? (supported() ? 'idle' : 'unavailable'),
      pendingPermission: last?.pending === true, error: last?.error ?? null });
  }

  function acquire({ mode, fence, signal } = {}) {
    if (!['dictation', 'standard', 'realtime'].includes(mode) || !validAccount(fence) ||
        !Number.isSafeInteger(fence.generation) || fence.generation < 1 ||
        typeof signal?.addEventListener !== 'function' || typeof signal?.removeEventListener !== 'function') {
      return Promise.reject(new BrowserVoiceError('voice_acquisition_invalid'));
    }
    if (signal.aborted) return Promise.reject(new BrowserVoiceError('voice_aborted'));
    if (!supported()) return Promise.reject(new BrowserVoiceError(secureContext ? 'voice_microphone_unavailable' : 'voice_secure_context_required'));
    if (occupied) return Promise.reject(new BrowserVoiceError('voice_microphone_busy'));
    const record = { fence: Object.freeze({ ...fence }), status: 'requesting', pending: true, error: null,
      stream: null, tracks: [], stopped: new Set(), revoked: false, trackFailure: false, attempts: new Map() };
    occupied = last = record;

    function stopTracks() {
      for (const track of record.tracks) {
        if (record.stopped.has(track)) continue;
        try { track.stop(); record.stopped.add(track); }
        catch { record.trackFailure = true; }
      }
      if (record.trackFailure) {
        record.status = 'incomplete'; record.error = 'voice_capture_cleanup_failed';
      } else if (!record.pending && record.status !== 'error') record.status = 'stopped';
    }
    function once(name, effect) {
      if (!record.attempts.has(name)) record.attempts.set(name, Promise.resolve().then(effect));
      return record.attempts.get(name);
    }
    const lease = Object.freeze({
      fence: record.fence,
      stopCapture() {
        record.revoked = true;
        stopTracks();
        return once('capture', async () => {
          try { await record.acquisition; } catch { /* No stream is returned on a browser rejection. */ }
          stopTracks();
          if (record.trackFailure) throw new BrowserVoiceError('voice_capture_cleanup_failed');
        });
      },
      stopPlayback: reason => once('playback', () => stopPlayback(record.fence, reason)),
      deactivateAudio: reason => once('audio', () => deactivateAudio(record.fence, reason)),
      release: reason => once('release', async () => {
        const stopped = await Promise.allSettled([lease.stopCapture(reason), lease.stopPlayback(reason)]);
        const audio = await Promise.allSettled([lease.deactivateAudio(reason)]);
        if ([...stopped, ...audio].some(result => result.status === 'rejected')) {
          record.status = 'incomplete'; record.error = 'voice_local_cleanup_incomplete';
          throw new BrowserVoiceError('voice_local_cleanup_incomplete');
        }
        signal.removeEventListener('abort', onAbort);
        record.stream = null; record.tracks = [];
        record.status = 'released';
        if (occupied === record) occupied = null;
      }),
    });
    const onAbort = () => {
      record.revoked = true;
      if (record.pending) record.status = 'cancelling';
      // getUserMedia cannot abort its prompt. The same lease disposes a late grant.
      void lease.stopCapture('aborted').catch(() => {});
      void lease.stopPlayback('aborted').catch(() => {});
      void lease.deactivateAudio('aborted').catch(() => {});
    };
    record.acquisition = invoke(() => mediaDevices.getUserMedia({ audio: true, video: false })).then(stream => {
      record.pending = false;
      record.stream = stream;
      try { record.tracks = stream.getTracks(); }
      catch {
        record.trackFailure = true; record.status = 'incomplete'; record.error = 'voice_capture_cleanup_failed';
        return lease;
      }
      if (!record.tracks.some(track => track.kind === 'audio' && track.readyState !== 'ended')) {
        record.revoked = true; record.error = 'voice_microphone_unavailable';
      }
      if (record.revoked || signal.aborted) { record.revoked = true; stopTracks(); }
      else record.status = 'granted';
      return lease;
    }, error => {
      record.pending = false; record.status = 'error'; record.error = mediaError(error).code;
      signal.removeEventListener('abort', onAbort);
      if (occupied === record) occupied = null;
      throw new BrowserVoiceError(record.error);
    });
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    return record.acquisition;
  }

  function streamFor(fence) {
    const record = occupied;
    if (!record || !sameFence(record.fence, fence) || record.revoked || record.status !== 'granted') {
      throw new BrowserVoiceError(record?.error ?? 'voice_capture_stale');
    }
    if (record.tracks.some(track => track.kind === 'audio' && track.readyState === 'ended')) {
      throw new BrowserVoiceError('voice_capture_interrupted');
    }
    return record.stream;
  }
  return Object.freeze({ acquire, streamFor, snapshot });
}
