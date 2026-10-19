export type VoiceMode = 'dictation' | 'standard' | 'realtime';
export type VoiceFence = Readonly<{
  accountId: string;
  authSessionId: string;
  accountEpoch: number;
  generation: number;
}>;
export type VoiceAccount = Omit<VoiceFence, 'generation'>;
export type TeardownReason = 'user_stop' | 'navigation' | 'background' | 'logout' | 'account_changed' | 'interruption' | 'aborted' | 'failed';
export type MicLease = Readonly<{
  fence: VoiceFence;
  stopCapture(reason: TeardownReason): void | Promise<void>;
  stopPlayback(reason: TeardownReason): void | Promise<void>;
  deactivateAudio(reason: TeardownReason): Promise<void>;
  release(reason: TeardownReason): Promise<void>;
}>;
export type MicOwner = Readonly<{
  acquire(input: Readonly<{ mode: VoiceMode; fence: VoiceFence; signal: AbortSignal }>): Promise<MicLease>;
}>;
export type VoiceTransportTeardown = Readonly<{
  abortPending(reason: TeardownReason): void | Promise<void>;
  closeTransport(reason: TeardownReason): void | Promise<void>;
  requestServerStop(reason: TeardownReason): Promise<void>;
}>;
export type LocalTeardownResult = Readonly<{
  status: 'released' | 'incomplete';
  failedSteps: readonly string[];
}>;
export type ServerStopResult = Readonly<{ status: 'acknowledged' | 'unknown' }>;
export type VoiceTeardown = Readonly<{
  local: Promise<LocalTeardownResult>;
  server: Promise<ServerStopResult>;
}>;

export type StandardTurnReview = Readonly<{
  transcript: string;
  reply?: string;
}>;
