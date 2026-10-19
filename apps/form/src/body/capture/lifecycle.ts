import { FormPhotoCaptureAdapter, PhotoCaptureError } from './adapter';
import { composeCaptureChoice } from './choices';
import type { CaptureChoice, CaptureChoiceSource, CaptureCleanup, CaptureCloseReason, CaptureFence,
  CaptureFrame, CaptureLease, CaptureReadiness, CaptureState, CaptureView, PhotoCapturePort,
  CapturePermission, CapturePreview, CaptureRetakeResult, CaptureScope } from './types';

export type PhotoCaptureLifecycleContext = Readonly<{
  shellSessionGeneration: string;
  isCurrentShellSession(): boolean;
  isCurrentAuth(): boolean;
  bodyFence: CaptureFence;
  isCurrentBodySession(): boolean;
  signal: AbortSignal;
  createRequestId?(): string;
}>;
export type PhotoCaptureLifecycleIdentity = Readonly<{ shellSessionGeneration: string; bodyFence: CaptureFence }>;
export interface PhotoCaptureLifecycle {
  readonly identity: PhotoCaptureLifecycleIdentity;
  availability(): Promise<CaptureReadiness>;
  permissionStatus(source: CaptureChoiceSource): Promise<CapturePermission>;
  requestPermission(source: CaptureChoiceSource): Promise<CapturePermission>;
  preview(view: CaptureView): Promise<CapturePreview>;
  retake(view: CaptureView): Promise<CaptureRetakeResult>;
  getScope(): CaptureScope | null;
  acquire(source: CaptureChoiceSource): Promise<CaptureLease>;
  capture(view: CaptureView): Promise<CaptureFrame>;
  getState(): CaptureState;
  getChoice(): CaptureChoice | null;
  close(reason: CaptureCloseReason): Promise<CaptureCleanup>;
}

export function createPhotoCaptureLifecycle(context: PhotoCaptureLifecycleContext,
  port?: Readonly<PhotoCapturePort>): Readonly<PhotoCaptureLifecycle> {
  if (typeof context.shellSessionGeneration !== 'string' || context.shellSessionGeneration.length === 0) {
    throw new PhotoCaptureError('invalid_session');
  }
  // The opaque shell token and original auth/shell guards never become a numeric body generation.
  const identity = Object.freeze({ shellSessionGeneration: context.shellSessionGeneration,
    bodyFence: Object.freeze({ accountId: context.bodyFence.accountId, generation: context.bodyFence.generation }) });
  const shellCurrent = context.isCurrentShellSession.bind(context);
  const authCurrent = context.isCurrentAuth.bind(context);
  const bodyCurrent = context.isCurrentBodySession.bind(context);
  const signal = context.signal;
  const createRequestId = context.createRequestId?.bind(context);
  const controller = new AbortController();
  let closed = false;
  let choice: CaptureChoice | null = null;
  let scope: CaptureScope | null = null;
  let cleanup: Promise<CaptureCleanup> | null = null;
  const current = () => {
    try { return !closed && !signal.aborted && shellCurrent() && authCurrent() && bodyCurrent(); }
    catch { return false; }
  };
  const adapter = new FormPhotoCaptureAdapter({ ...identity.bodyFence,
    signal: controller.signal, isCurrentSession: current, createRequestId }, port);
  const abort = () => { void close('cancel'); };

  function close(reason: CaptureCloseReason): Promise<CaptureCleanup> {
    closed = true;
    choice = null;
    scope = null;
    signal.removeEventListener('abort', abort);
    // Root retains original lease and permission identities on unknown cleanup after disposal; no reconciliation retry here.
    controller.abort();
    cleanup ??= adapter.close(reason);
    return cleanup;
  }
  function assertCurrent(): void {
    if (!current()) { void close('account_change'); throw new PhotoCaptureError('stale_session'); }
  }
  async function guarded<T>(operation: () => Promise<T>): Promise<T> {
    assertCurrent();
    try { const result = await operation(); assertCurrent(); return result; }
    catch (error) {
      if (['closing', 'released', 'unknown'].includes(adapter.getState().phase)) void close('error');
      throw error;
    }
  }
  function composeScope(source: CaptureChoiceSource): CaptureScope {
    const composed = composeCaptureChoice(source, identity.bodyFence);
    if (composed.status === 'blocked') throw new PhotoCaptureError(composed.reason);
    return Object.freeze({ ...identity.bodyFence, shellSessionGeneration: identity.shellSessionGeneration, choices: composed.choice });
  }
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) void close('cancel');

  return Object.freeze({
    identity,
    availability: async () => {
      assertCurrent();
      const result = await guarded(() => adapter.availability());
      assertCurrent();
      return result;
    },
    permissionStatus: async (source: CaptureChoiceSource) => {
      assertCurrent();
      const result = await guarded(() => adapter.permissionStatus(composeScope(source)));
      assertCurrent(); return result;
    },
    requestPermission: async (source: CaptureChoiceSource) => {
      assertCurrent();
      const result = await guarded(() => adapter.requestPermission(composeScope(source)));
      assertCurrent(); return result;
    },
    acquire: async (source: CaptureChoiceSource) => {
      assertCurrent();
      const original = composeScope(source);
      const lease = await guarded(() => adapter.acquire(original.choices, original));
      assertCurrent();
      choice = original.choices; scope = original;
      return lease;
    },
    preview: async (view: CaptureView) => {
      assertCurrent(); const result = await guarded(() => adapter.preview(view)); assertCurrent(); return result;
    },
    retake: async (view: CaptureView) => {
      assertCurrent(); const result = await guarded(() => adapter.retake(view)); assertCurrent(); return result;
    },
    getScope: () => { if (!current()) void close('account_change'); return scope; },
    capture: async (view: CaptureView) => {
      assertCurrent();
      const frame = await guarded(() => adapter.capture(view));
      assertCurrent();
      return frame;
    },
    getState: () => { if (!current()) void close('account_change'); return adapter.getState(); },
    getChoice: () => { if (!current()) void close('account_change'); return choice; },
    close,
  });
}
