import { createManualProgressController } from '../body/manualProgressController';
import { ApiError, captureFormRequestAttemptContext, type FormRequestAttemptContext } from '../api/transport';
import type { FeatureSlotContext } from '../features/contract';

export type ManualProgressController = ReturnType<typeof createManualProgressController>;

/** Presentation admission ends locally; issued commands still report through the original host lifetime. */
export function createManualProgressSession(ctx: Pick<FeatureSlotContext,
  'account' | 'resources' | 'sessionGeneration' | 'isCurrentSession' | 'commandOwner'>) {
  const accountId = ctx.account.accountId, resources = ctx.resources, api = resources.api;
  const sessionGeneration = ctx.sessionGeneration, commandOwner = ctx.commandOwner;
  const hostCurrent = ctx.isCurrentSession.bind(ctx), auth = api.captureAuthContext();
  let expired = false, closed = false;
  let controller: ManualProgressController | null = null;
  const originalCurrent = () => {
    try { if (resources.api !== api || !auth.isCurrent() || !hostCurrent()) expired = true; }
    catch { expired = true; }
    return !expired;
  };
  const transport = Object.freeze({ captureAuthContext: () => auth,
    async request<T = unknown>(path: string, method = 'GET', body?: unknown, key?: string,
      attemptContext?: FormRequestAttemptContext): Promise<T> {
      const captured = captureFormRequestAttemptContext(attemptContext);
      if (!originalCurrent()) throw new ApiError(409, 'session_changed', 'The original manual progress session is unavailable.');
      const guarded = captured && Object.freeze({ manualRetention: captured.manualRetention, assertCurrent() {
        if (!originalCurrent()) throw new ApiError(409, 'session_changed', 'The original manual progress session is unavailable.');
        return captured.assertCurrent();
      } });
      return api.request<T>(path, method, body, key, guarded);
    },
  });
  return Object.freeze({
    create(): ManualProgressController | null {
      if (closed || !originalCurrent()) return null;
      if (controller && !controller.snapshot().active) { closed = true; return null; }
      controller ??= createManualProgressController({ accountId, sessionGeneration, commandOwner, transport,
        isCurrentSession: originalCurrent });
      return controller;
    },
    dispose(): void { closed = true; controller?.dispose(); },
  });
}
