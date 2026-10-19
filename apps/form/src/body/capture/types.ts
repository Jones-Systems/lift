export const PHOTO_CAPTURE_QUALIFICATION = Object.freeze({
  deviceCapture: false,
  nativeMemory: false,
  cacheBehavior: false,
  vendorBehavior: false,
  backupBehavior: false,
  deletion: false,
  noSave: false,
} as const);

export type CaptureFence = Readonly<{ accountId: string; generation: number }>;
export type CaptureLease = Readonly<CaptureFence & { leaseId: string; requestId?: string; operationId?: string }>;
export type CaptureContext = CaptureFence & {
  signal: AbortSignal;
  isCurrentSession(): boolean;
  createRequestId?(): string;
};
export type CapturePurposeChoice = Readonly<{ choice: 'session_only'; consentVersion: null }
  | { choice: 'retain'; consentVersion: string }>;
export type CaptureChoice = Readonly<Record<'photos' | 'derived', CapturePurposeChoice>>;
// Structural WS10 choice input only; manual_entry processing is not native capture authority.
export type CaptureChoiceSource = Readonly<CaptureFence & {
  choices: Readonly<Record<'photos' | 'derived', CapturePurposeChoice
    | Readonly<{ choice: 'unset' | 'session_only'; consentVersion: null }>>>;
}>;
export type CaptureChoiceComposition = Readonly<{ status: 'ready'; choice: CaptureChoice }
  | { status: 'blocked'; reason: 'stale_session' | 'explicit_choice_required' }>;
export type CaptureCloseReason = 'cancel' | 'background' | 'revoke' | 'account_change' | 'unmount' | 'error';
export type CaptureView = 'front' | 'side';
// Opaque handles only; the native owner must keep bytes, metadata and file paths off this bridge.
export type CaptureFrame = Readonly<{ leaseId: string; frameId: string; view: CaptureView }>;
export type CaptureScope = Readonly<CaptureFence & { shellSessionGeneration: string; choices: CaptureChoice }>;
export type CapturePermission = Readonly<{ status: 'unavailable';
  reason: 'native_capture_unqualified' | 'native_module_missing' | 'configuration_missing' | 'native_capture_unavailable' }
  | { status: 'not_determined' | 'granted' | 'denied' | 'restricted' | 'unknown' }>;
export type CapturePermissionResponse = CapturePermission & Readonly<{ requestId: string }>;
export type CapturePermissionOperation = Readonly<{ requestId: string; scope: CaptureScope }>;
export type CapturePermissionRetirement = Readonly<{ operation: CapturePermissionOperation | null;
  status: 'retired' | 'not_requested' | 'unknown' }>;
export type CapturePreview = Readonly<CaptureFrame & { previewId: string }>;
export type CaptureRetakeResult = Readonly<(CaptureFrame & { status: 'captured'; replacedFrameId: string })
  | { status: 'failed'; leaseId: string; view: CaptureView; replacedFrameId: string; reason: 'capture_failed' }>;
export type CapturePreviewInvalidation = Readonly<{ leaseId: string; status: 'invalidated' | 'unknown' }>;
// A native ref consumer renders tokens only. Attached is source ownership, not proof of pixels, cache behavior or erasure.
export interface PhotoCapturePreviewRenderer {
  show(preview: CapturePreview, scope: CaptureScope): Promise<Readonly<{ previewId: string; status: 'attached' }>>;
  clear(): Promise<void>;
}
export interface PhotoCaptureGuidancePort {
  permissionStatus(scope: CaptureScope): Promise<CapturePermission>;
  requestPermission(scope: CaptureScope, requestId: string): Promise<CapturePermissionResponse>;
  permissionRetirement(operation: CapturePermissionOperation): CapturePermissionRetirement;
  preview(lease: CaptureLease, frame: CaptureFrame, scope: CaptureScope): Promise<CapturePreview>;
  retake(lease: CaptureLease, frame: CaptureFrame, scope: CaptureScope): Promise<CaptureRetakeResult>;
  invalidatePreviews(lease: CaptureLease, frame: CaptureFrame | null, scope: CaptureScope): CapturePreviewInvalidation;
}
export type CaptureReadiness = Readonly<{ ready: boolean;
  reason: 'ready' | 'native_capture_unqualified' | 'native_module_missing' | 'native_probe_failed'
    | 'native_capture_unavailable' | 'configuration_missing' | 'permission_required' }>;
export type CaptureCleanup = Readonly<{ lease: CaptureLease | null;
  status: 'released' | 'unknown'; leaseStatus: 'released' | 'unknown';
  permissionRetirement: CapturePermissionRetirement; erasureConfirmed: false }>;

// An acquire rejection may have had an effect. Cancel must address this exact original lease idempotently.
export interface PhotoCapturePort extends Partial<PhotoCaptureGuidancePort> {
  readonly synthetic?: true;
  availability(): Promise<CaptureReadiness>;
  acquire(lease: CaptureLease, scope?: CaptureScope): Promise<Readonly<{ leaseId: string; requestId?: string; operationId?: string }>>;
  capture(lease: CaptureLease, view: CaptureView, scope?: CaptureScope): Promise<CaptureFrame>;
  cancel(lease: CaptureLease, scope?: CaptureScope): Promise<Readonly<{ leaseId: string; status: 'released' | 'unknown' }>>;
}

export type CaptureState = Readonly<{
  phase: 'idle' | 'permission_request' | 'acquiring' | 'active' | 'capturing' | 'previewing' | 'retaking' | 'closing' | 'released' | 'unknown';
  lease: CaptureLease | null;
  frames: readonly CaptureFrame[];
  previews: readonly CapturePreview[];
  permission: CapturePermission | null;
  permissionRetirement: CapturePermissionRetirement;
  previewInvalidation: 'not_requested' | 'invalidated' | 'unknown';
  assessment: 'unable_to_assess';
}>;
