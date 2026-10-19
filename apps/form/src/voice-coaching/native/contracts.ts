import type { VoiceFence } from '../contracts';
import type { NativeSubscription, NativeUnavailableReason } from '../../native/runtime';

export type MicrophonePermission = 'granted' | 'denied' | 'undetermined' | 'unknown';
export type VoiceNativeLimits = Readonly<{
  maxCaptureBytes: number;
  maxCaptureDurationMs: number;
  maxPlaybackBytes: number;
  sampleRate: 16000 | 24000;
}>;
export type VoiceProviderBounds = Readonly<{ maxAudioBytes: number; maxSpeechBytes: number }>;
export type VoiceAvailability = Readonly<{
  available: boolean;
  reason: NativeUnavailableReason | 'available' | 'shared_ownership_unready' | 'native_unqualified'
    | 'configuration_missing' | 'permission_denied' | 'permission_required' | 'permission_unknown'
    | 'background' | 'module_destroyed' | 'busy';
  permission: MicrophonePermission;
}>;
export type VoiceNativeInvalidation = Readonly<{
  leaseId: string;
  reason: 'background' | 'interruption' | 'route_changed' | 'media_reset' | 'destroyed'
    | 'capture_limit' | 'audio_error' | 'cleanup_failed';
}>;
export interface FormVoiceNative {
  availability(): Promise<VoiceAvailability>;
  requestPermission(): Promise<MicrophonePermission>;
  openLease(leaseId: string, fence: VoiceFence): Promise<void>;
  startCapture(leaseId: string, limits: VoiceNativeLimits): Promise<void>;
  finishCapture(leaseId: string): Promise<Uint8Array>;
  playWav(leaseId: string, bytes: Uint8Array): Promise<void>;
  stopCapture(leaseId: string): Promise<void>;
  stopPlayback(leaseId: string): Promise<void>;
  deactivateAudio(leaseId: string): Promise<void>;
  release(leaseId: string): Promise<void>;
  addListener(name: 'onInvalidated', listener: (event: VoiceNativeInvalidation) => void): NativeSubscription;
}

export type DictationStartInput = Readonly<{
  sessionId: string;
  locale: string;
  fence: VoiceFence;
  signal: AbortSignal;
}>;

export interface DictationNativePort {
  start(input: DictationStartInput): Promise<void>;
  stop(sessionId: string): Promise<void>;
  // Resolve only after this session is stopped, deactivated and its audio settings restored.
  // Reject uncertain cleanup or a different active session; an ended event is not this proof.
  cancel(sessionId: string): Promise<void>;
}
