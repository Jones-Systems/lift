import { ApiError } from '../api/transport';
import type { FormResources } from '../api/resources';
import { createReadOnlyFormAdapter, createSessionController,
  type PreviewResult } from './healthPreview/portable-adapter.mjs';

export type HealthPreviewBinding = {
  resources: FormResources;
  sessionGeneration: string;
  isCurrentSession(): boolean;
};

/** Optional saved-template preview only; no health import, recommendation or plan-write capability. */
export function createHealthPlanPreview(binding: HealthPreviewBinding,
  render: (result: PreviewResult) => void) {
  let disposed = false;
  const auth = binding.resources.api.captureAuthContext();
  const current = () => !disposed && auth.isCurrent() && binding.isCurrentSession();
  const resources = binding.resources.boundTo(current);
  const port = createReadOnlyFormAdapter({
    async getPlan(id) {
      const plans = await resources.plans();
      const matches = plans.items.filter(plan => plan.id === id);
      return matches.length === 1 ? matches[0] : undefined;
    },
  });
  const controller = createSessionController({ isCurrentSession: current }, port, render);
  return Object.freeze({
    capability: port.capability,
    sessionGeneration: binding.sessionGeneration,
    async reviewPlan(id: string): Promise<PreviewResult> {
      if (!current()) return { status: 'rejected', code: 'stale_session' };
      if (!id || id.length > 2048) return { status: 'rejected', code: 'invalid_input' };
      try { return await controller.reviewPlan(id); }
      catch (error) {
        if (!current() || (error instanceof ApiError && error.code === 'session_changed')) {
          return { status: 'rejected', code: 'stale_session' };
        }
        return { status: 'rejected', code: 'plan_unavailable' };
      }
    },
    dispatch: controller.dispatch,
    dispose() { disposed = true; controller.dispose(); },
  });
}
