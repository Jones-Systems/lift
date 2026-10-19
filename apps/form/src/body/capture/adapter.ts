import { createPhotoCapturePort, UNAVAILABLE_PHOTO_CAPTURE_PORT } from './native';
import { snapshotCaptureChoice, snapshotCaptureScope } from './choices';
import type { CaptureChoice, CaptureCleanup, CaptureContext, CaptureFence, CaptureFrame,
  CaptureCloseReason, CaptureLease, CaptureReadiness, CaptureState, CaptureView, PhotoCapturePort,
  CapturePermission, CapturePermissionOperation, CapturePermissionRetirement, CapturePreview, CaptureRetakeResult, CaptureScope, PhotoCaptureGuidancePort } from './types';

let sequence = 0;
export class PhotoCaptureError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'PhotoCaptureError'; }
}
const boundedId = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= 128;

export class FormPhotoCaptureAdapter {
  private readonly fence: CaptureFence;
  private readonly signal: AbortSignal;
  private readonly isCurrentSession: () => boolean;
  private readonly createRequestId: (() => string) | undefined;
  private readonly port: Readonly<PhotoCapturePort & PhotoCaptureGuidancePort>;
  private readonly abort = () => { void this.close('cancel'); };
  private invalidated = false;
  private phase: CaptureState['phase'] = 'idle';
  private lease: CaptureLease | null = null;
  private frames: CaptureFrame[] = [];
  private previews: CapturePreview[] = [];
  private permission: CapturePermission | null = null;
  private permissionRetirement: CapturePermissionRetirement = Object.freeze({ operation: null, status: 'not_requested' });
  private scope: CaptureScope | null = null;
  private previewInvalidation: CaptureState['previewInvalidation'] = 'not_requested';
  private pending: Promise<unknown> | null = null;
  private cleanup: Promise<CaptureCleanup> | null = null;

  constructor(context: CaptureContext, port: Readonly<PhotoCapturePort> = UNAVAILABLE_PHOTO_CAPTURE_PORT) {
    if (!boundedId(context.accountId) || !Number.isSafeInteger(context.generation) || context.generation < 0) {
      throw new PhotoCaptureError('invalid_session');
    }
    this.fence = Object.freeze({ accountId: context.accountId, generation: context.generation });
    this.signal = context.signal;
    this.isCurrentSession = context.isCurrentSession;
    this.createRequestId = context.createRequestId?.bind(context);
    // Copy methods so later mutation of an injected binding cannot replace the lease owner.
    this.port = createPhotoCapturePort(port);
    this.signal.addEventListener('abort', this.abort, { once: true });
    if (this.signal.aborted) this.invalidated = true;
  }

  getState(): CaptureState {
    return Object.freeze({ phase: this.phase, lease: this.lease,
      frames: Object.freeze([...this.frames]), previews: Object.freeze([...this.previews]),
      permission: this.permission, permissionRetirement: this.permissionRetirement,
      previewInvalidation: this.previewInvalidation, assessment: 'unable_to_assess' });
  }

  async availability(): Promise<CaptureReadiness> {
    this.assertCurrent();
    let result: CaptureReadiness;
    try { result = await this.port.availability(); }
    catch { result = { ready: false, reason: 'native_probe_failed' }; }
    this.assertCurrent();
    if (!result || typeof result !== 'object'
      || Object.keys(result).sort().join(',') !== 'ready,reason'
      || !((result.ready === true && result.reason === 'ready')
        || (result.ready === false && ['native_capture_unqualified', 'native_module_missing', 'native_probe_failed',
          'native_capture_unavailable', 'configuration_missing', 'permission_required'].includes(result.reason)))) {
      return Object.freeze({ ready: false, reason: 'native_probe_failed' });
    }
    return Object.freeze({ ready: result.ready, reason: result.reason });
  }

  async acquire(choice: CaptureChoice, scope?: CaptureScope): Promise<CaptureLease> {
    this.assertCurrent();
    if (this.phase !== 'idle') throw new PhotoCaptureError('busy');
    if (this.permissionRetirement.status === 'unknown') throw new PhotoCaptureError('permission_cleanup_unknown');
    if (!snapshotCaptureChoice(choice)) {
      throw new PhotoCaptureError('explicit_choice_required');
    }
    const capturedScope = scope ? snapshotCaptureScope(scope, this.fence) : null;
    if (scope && (!capturedScope || JSON.stringify(capturedScope.choices) !== JSON.stringify(snapshotCaptureChoice(choice)))) {
      throw new PhotoCaptureError('scope_mismatch');
    }
    this.scope = capturedScope;
    this.phase = 'acquiring';
    try {
      const readiness = await this.availability();
      this.assertCurrent();
      if (readiness.ready !== true) throw new PhotoCaptureError(readiness.reason);
      const requestId = this.originalRequestId();
      const lease = Object.freeze({ ...this.fence, leaseId: requestId, requestId });
      this.lease = lease;
      const pending = Promise.resolve().then(() => { this.assertCurrent(); return this.port.acquire(lease, capturedScope ?? undefined); });
      this.pending = pending;
      const result = await pending;
      if (!result || typeof result !== 'object' || result.leaseId !== lease.leaseId
        || !((this.port.synthetic === true && Object.keys(result).join(',') === 'leaseId')
          || (Object.keys(result).sort().join(',') === 'leaseId,operationId,requestId'
            && result.requestId === requestId && boundedId(result.operationId)))) throw new PhotoCaptureError('lease_mismatch');
      if (result.operationId) this.lease = Object.freeze({ ...lease, operationId: result.operationId });
      this.assertCurrent();
      this.phase = 'active';
      return this.lease;
    } catch (error) {
      if (this.lease) await this.close('error');
      else if (!this.invalidated) this.phase = 'idle';
      throw error;
    } finally { this.pending = null; }
  }

  async capture(view: CaptureView): Promise<CaptureFrame> {
    this.assertCurrent();
    const lease = this.lease;
    if (this.phase !== 'active' || !lease) throw new PhotoCaptureError('capture_unavailable');
    if (!['front', 'side'].includes(view) || this.frames.some(frame => frame.view === view)) {
      throw new PhotoCaptureError('invalid_view');
    }
    this.phase = 'capturing';
    try {
      const pending = Promise.resolve().then(() => { this.assertCurrent(); return this.port.capture(lease, view, this.scope ?? undefined); });
      this.pending = pending;
      const frame = await pending;
      this.assertCurrent();
      if (!frame || typeof frame !== 'object' || frame.leaseId !== lease.leaseId || frame.view !== view || !boundedId(frame.frameId)
        || this.frames.some(other => other.frameId === frame.frameId)
        || Object.keys(frame).sort().join(',') !== 'frameId,leaseId,view') {
        throw new PhotoCaptureError('invalid_frame');
      }
      const staged = Object.freeze({ leaseId: frame.leaseId, frameId: frame.frameId, view });
      this.frames.push(staged);
      this.phase = 'active';
      return staged;
    } catch (error) { await this.close('error'); throw error; }
    finally { this.pending = null; }
  }

  async permissionStatus(scope: CaptureScope): Promise<CapturePermission> {
    return this.permissionOperation(scope, false);
  }
  async requestPermission(scope: CaptureScope): Promise<CapturePermission> {
    return this.permissionOperation(scope, true);
  }
  private async permissionOperation(scope: CaptureScope, request: boolean): Promise<CapturePermission> {
    this.assertCurrent();
    if (this.phase !== 'idle') throw new PhotoCaptureError('busy');
    if (this.permissionRetirement.status === 'unknown') throw new PhotoCaptureError('permission_cleanup_unknown');
    const original = snapshotCaptureScope(scope, this.fence);
    if (!original) throw new PhotoCaptureError('scope_mismatch');
    request = request && this.port !== UNAVAILABLE_PHOTO_CAPTURE_PORT;
    const requestId = request ? this.originalRequestId() : '';
    this.phase = 'permission_request';
    const operation: CapturePermissionOperation = Object.freeze({ requestId, scope: original });
    if (request) this.permissionRetirement = Object.freeze({ operation, status: 'unknown' });
    try {
      let value: unknown;
      try { value = await (request ? this.port.requestPermission(original, requestId) : this.port.permissionStatus(original)); }
      catch { value = null; }
      this.assertCurrent();
      const keys = value && typeof value === 'object' ? Object.keys(value).sort().join(',') : '';
      const result = value as { status?: unknown; reason?: unknown; requestId?: unknown } | null;
      const suffix = request ? ',requestId,status' : ',status';
      const plain = request ? 'requestId,status' : 'status';
      const valid = result && (!request || result.requestId === requestId)
        && ((keys === plain && ['not_determined', 'granted', 'denied', 'restricted', 'unknown'].includes(result.status as string))
          || (keys === `reason${suffix}` && result.status === 'unavailable'
            && ['native_capture_unqualified', 'native_module_missing', 'configuration_missing', 'native_capture_unavailable'].includes(result.reason as string)));
      this.permission = valid ? Object.freeze(result!.status === 'unavailable'
        ? { status: 'unavailable', reason: result!.reason } : { status: result!.status }) as CapturePermission
        : Object.freeze({ status: 'unknown' });
      return this.permission;
    } finally {
      if (request) this.readPermissionRetirement(operation);
      if (!this.invalidated) this.phase = 'idle';
    }
  }

  private originalRequestId(): string {
    this.assertCurrent();
    const id = this.createRequestId ? this.createRequestId()
      : this.port.synthetic === true ? `synthetic-photo-${++sequence}` : null;
    this.assertCurrent();
    if (!boundedId(id)) throw new PhotoCaptureError('creator_identity_unavailable');
    return id;
  }

  private readPermissionRetirement(operation: CapturePermissionOperation): CapturePermissionRetirement {
    let status: CapturePermissionRetirement['status'] = 'unknown';
    try {
      const value = this.port.permissionRetirement(operation);
      const scope = value?.operation && snapshotCaptureScope(value.operation.scope, this.fence);
      if (value && Object.keys(value).sort().join(',') === 'operation,status'
        && value.operation && Object.keys(value.operation).sort().join(',') === 'requestId,scope'
        && value.operation.requestId === operation.requestId && scope
        && JSON.stringify(scope) === JSON.stringify(operation.scope)
        && ['retired', 'not_requested'].includes(value.status)) status = value.status;
    } catch { /* Only an exact producer witness retires the original OS request; settlement is insufficient. */ }
    this.permissionRetirement = Object.freeze({ operation, status });
    return this.permissionRetirement;
  }

  async preview(view: CaptureView): Promise<CapturePreview> {
    this.assertCurrent();
    const frame = this.frames.find(value => value.view === view), lease = this.lease, scope = this.scope;
    if (this.phase !== 'active' || !frame || !lease || !scope) throw new PhotoCaptureError('preview_unavailable');
    const cached = this.previews.find(value => value.frameId === frame.frameId);
    if (cached) return cached;
    this.phase = 'previewing';
    try {
      const pending = Promise.resolve().then(() => { this.assertCurrent(); return this.port.preview(lease, frame, scope); });
      this.pending = pending;
      const value = await pending;
      this.assertCurrent();
      if (!value || Object.keys(value).sort().join(',') !== 'frameId,leaseId,previewId,view'
        || value.leaseId !== lease.leaseId || value.frameId !== frame.frameId || value.view !== view || !boundedId(value.previewId)) {
        throw new PhotoCaptureError('invalid_preview');
      }
      const preview = Object.freeze({ leaseId: lease.leaseId, frameId: frame.frameId, view, previewId: value.previewId });
      this.previews.push(preview); this.phase = 'active';
      return preview;
    } catch (error) { await this.close('error'); throw error; }
    finally { this.pending = null; }
  }

  async retake(view: CaptureView): Promise<CaptureRetakeResult> {
    this.assertCurrent();
    const frame = this.frames.find(value => value.view === view), lease = this.lease, scope = this.scope;
    if (this.phase !== 'active' || !frame || !lease || !scope) throw new PhotoCaptureError('retake_unavailable');
    // The obsolete selected frame and preview disappear before dispatch; the other view remains staged.
    this.frames = this.frames.filter(value => value !== frame);
    this.previews = this.previews.filter(value => value.frameId !== frame.frameId);
    this.invalidatePreview(frame);
    this.phase = 'retaking';
    try {
      const pending = Promise.resolve().then(() => { this.assertCurrent(); return this.port.retake(lease, frame, scope); });
      this.pending = pending;
      const value = await pending;
      this.assertCurrent();
      if (!value || value.leaseId !== lease.leaseId || value.view !== view || value.replacedFrameId !== frame.frameId
        || !((value.status === 'captured' && Object.keys(value).sort().join(',') === 'frameId,leaseId,replacedFrameId,status,view'
          && boundedId(value.frameId) && value.frameId !== frame.frameId
          && !this.frames.some(other => other.frameId === value.frameId))
          || (value.status === 'failed' && Object.keys(value).sort().join(',') === 'leaseId,reason,replacedFrameId,status,view'
            && value.reason === 'capture_failed'))) throw new PhotoCaptureError('invalid_retake');
      if (value.status === 'captured') this.frames.push(Object.freeze({ leaseId: lease.leaseId, frameId: value.frameId, view }));
      this.phase = 'active';
      return Object.freeze({ ...value });
    } catch (error) { await this.close('error'); throw error; }
    finally { this.pending = null; }
  }

  private invalidatePreview(frame: CaptureFrame | null): void {
    if (!this.lease || !this.scope) return;
    this.previewInvalidation = 'unknown';
    try {
      const value = this.port.invalidatePreviews(this.lease, frame, this.scope);
      if (value && Object.keys(value).sort().join(',') === 'leaseId,status'
        && value.leaseId === this.lease.leaseId && value.status === 'invalidated') this.previewInvalidation = 'invalidated';
    } catch { /* Rendering lifetime remains unknown; original lease cleanup still proceeds without a retry. */ }
  }

  // Invalidate before awaiting native work. Complete release also requires original permission retirement, never erasure.
  close(_reason: CaptureCloseReason): Promise<CaptureCleanup> {
    this.invalidated = true;
    this.frames = [];
    this.previews = [];
    this.permission = null;
    this.signal.removeEventListener('abort', this.abort);
    if (this.cleanup) return this.cleanup;
    this.invalidatePreview(null);
    this.phase = 'closing';
    const originalLease = this.lease;
    const pending = this.pending;
    const permission = this.permissionRetirement.operation
      ? this.readPermissionRetirement(this.permissionRetirement.operation) : this.permissionRetirement;
    const scope = this.scope;
    this.cleanup = (async () => {
      if (pending) { try { await pending; } catch { /* Exact lease still needs cancellation after an acquire failure. */ } }
      // An acknowledgement may arrive after invalidation; it adds custody identity, never current-session authority.
      const lease = this.lease ?? originalLease;
      let status: CaptureCleanup['status'] = 'released';
      if (lease) {
        status = 'unknown';
        try {
          const result = await this.port.cancel(lease, scope ?? undefined);
          if (result.leaseId === lease.leaseId && result.status === 'released') status = 'released';
        } catch { /* Preserve the original lease on an uncertain native effect; do not retry automatically. */ }
      }
      const leaseStatus = status;
      if (permission.status === 'unknown') status = 'unknown';
      this.phase = status;
      return Object.freeze({ lease, status, leaseStatus, permissionRetirement: permission, erasureConfirmed: false });
    })();
    return this.cleanup;
  }

  private assertCurrent(): void {
    if (this.invalidated || this.signal.aborted || !this.isCurrentSession()) {
      void this.close('account_change');
      throw new PhotoCaptureError('stale_session');
    }
  }
}
