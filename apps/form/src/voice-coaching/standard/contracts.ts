import type { createSharedVoice, SharedVoiceScope } from '../../integration/sharedVoice';
import type { LocalTeardownResult, StandardTurnReview, TeardownReason, VoiceFence } from '../contracts';

export type StandardVoiceHandle = Awaited<ReturnType<ReturnType<typeof createSharedVoice>['startStandard']>>
  & Readonly<{ assertCurrent(): void }>;
export type StandardVoiceHost = Readonly<{
  startStandard(scope: SharedVoiceScope, sessionId: string, signal: AbortSignal): Promise<StandardVoiceHandle>;
}>;
export type StandardClientAccounting = 'not_reserved' | 'replay' | 'released' | 'settled' | 'not_consumed' | 'unknown' | 'unresolved';
export type StandardClientOutcome =
  | Readonly<{ kind: 'succeeded'; value: Readonly<{ audio: Uint8Array; mediaType: 'audio/wav' }> }>
  | Readonly<{ kind: 'not_dispatched' | 'rejected' | 'unknown'; reason: string }>;
export type StandardClientTurnResult = Readonly<{
  outcome: StandardClientOutcome;
  accounting: StandardClientAccounting;
  review?: StandardTurnReview;
}>;
export type StandardClientTurnPort = Readonly<{
  run(input: Readonly<{
    scope: SharedVoiceScope;
    fence: VoiceFence;
    sessionId: string;
    audioBlob: Blob;
    signal: AbortSignal;
    assertCurrent(): void;
  }>): Promise<StandardClientTurnResult>;
}>;
export type StandardVoiceConsumerOptions = Readonly<{
  scope: SharedVoiceScope;
  host?: StandardVoiceHost;
  turn?: StandardClientTurnPort;
  newSessionId(): string;
  onManual(): void;
}>;
export type StandardVoicePhase = 'idle' | 'acquiring' | 'capturing' | 'processing' | 'playing' | 'completed'
  | 'stopping' | 'unavailable' | 'failed' | 'unknown' | 'cleanup_incomplete' | 'manual' | 'disposed';
export type StandardVoiceFailure = 'host_unavailable' | 'turn_unavailable' | 'session_changed' | 'session_id_invalid'
  | 'acquisition_failed' | 'capture_failed' | 'audio_invalid' | 'turn_rejected' | 'turn_not_dispatched'
  | 'turn_unknown' | 'accounting_unresolved' | 'playback_failed' | 'cleanup_failed' | 'manual_unavailable';
export type StandardVoiceSnapshot = Readonly<{
  reviewAvailable: boolean;
  phase: StandardVoicePhase;
  cleanup: 'not_started' | 'pending' | 'released' | 'incomplete';
  failure?: StandardVoiceFailure;
  outcome?: StandardClientOutcome['kind'];
  accounting?: StandardClientAccounting;
}>;
export type StandardVoiceConsumer = Readonly<{
  start(): Promise<void>;
  finishAndSend(): Promise<void>;
  stop(reason: TeardownReason): Promise<LocalTeardownResult>;
  useManual(): Promise<LocalTeardownResult>;
  dispose(): Promise<LocalTeardownResult>;
  review(): StandardTurnReview | null;
  snapshot(): StandardVoiceSnapshot;
  subscribe(observer: (snapshot: StandardVoiceSnapshot) => void): { remove(): void };
}>;
export type StandardCoachingComponentProps = Readonly<{
  consumer: StandardVoiceConsumer;
}>;
