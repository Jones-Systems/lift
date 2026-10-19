import type { NativeSubscription, NativeUnavailableReason } from './runtime';

export type SpeechPermission = 'granted' | 'denied' | 'restricted' | 'undetermined' | 'unknown';
export type SpeechPermissions = { speech: SpeechPermission; microphone: SpeechPermission };
export type SpeechNativeReason = 'available' | 'configuration_missing' | 'locale_unsupported' | 'on_device_unsupported'
  | 'shared_scope_unavailable' | 'session_changed' | 'recognizer_unavailable' | 'permission_denied' | 'permission_required' | 'permission_unknown' | 'module_destroyed';
export type SpeechAvailability = {
  available: boolean;
  reason: SpeechNativeReason | NativeUnavailableReason;
  locale: string;
  permissions: SpeechPermissions | null;
  onDeviceSupported: boolean;
};
export type SpeechResult = { sessionId: string; text: string; isFinal: boolean; locale: string };
export type SpeechEndReason = 'final' | 'cancelled' | 'backgrounded' | 'destroyed' | 'interrupted' | 'error';
export type SpeechState = { sessionId: string } & (
  | { state: 'recording' | 'stopping' }
  | { state: 'ended'; reason: SpeechEndReason }
);
export type SpeechError = {
  sessionId: string;
  code: 'recognition_failed' | 'final_timeout' | 'audio_cleanup_failed';
  message: string;
  nativeCode?: number;
};
export interface FormSpeechNative {
  availability(locale: string): Promise<SpeechAvailability>;
  requestPermissions(): Promise<SpeechPermissions>;
  start(locale: string, sessionId: string): Promise<{ sessionId: string }>;
  /** Requests final recognition; resolution is not proof that the audio session was released. */
  stop(sessionId: string): Promise<void>;
  /** Resolves only after this session stops, deactivates audio and restores prior settings; rejects incomplete cleanup or a different active session. */
  cancel(sessionId: string): Promise<void>;
  addListener(name: 'onResult', listener: (event: SpeechResult) => void): NativeSubscription;
  addListener(name: 'onState', listener: (event: SpeechState) => void): NativeSubscription;
  addListener(name: 'onError', listener: (event: SpeechError) => void): NativeSubscription;
}
export type SpeechDraft = {
  sessionId: string;
  locale: string;
  text: string;
  state: 'starting' | 'recording' | 'stopping' | 'review' | 'discarded';
  isFinal: boolean;
  error: SpeechError | null;
};
export type ReviewedSpeechText = {
  source: 'apple_on_device';
  sessionId: string;
  locale: string;
  text: string;
  reviewed: true;
};

/** Root session hook; its driver must call raw native methods, never this adapter. */
export interface SpeechSessionHook {
  onDispose?(): void;
  isCurrent(): boolean;
  start(locale: string, sessionId: string): Promise<{ sessionId: string }>;
  stop(sessionId: string): Promise<void>;
  cancel(sessionId: string): Promise<void>;
}
