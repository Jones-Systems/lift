import { ApiError, type AuthAttemptGuard } from '../api/transport';
import { ActivityResources, type ActivityApi } from '../activity/resources';
import { DraftController } from '../activity/drafts/controller';
import type { SpeechPort } from '../features/contract';
import { createActivityDataflow } from './activityDataflow';

export type ActivitySessionBinding = {
  sessionGeneration: string;
  isCurrentSession(): boolean;
  api: ActivityApi;
  auth?: AuthAttemptGuard;
};

/** Root-owned session seam; all state stays in memory and speech is dedicated to this view. */
export function createActivitySession(binding: ActivitySessionBinding, newSecureKey: () => string, speech?: SpeechPort) {
  let disposed = false;
  const current = () => !disposed && (binding.auth?.isCurrent() ?? true) && binding.isCurrentSession();
  const dataflow = createActivityDataflow({ ...binding, isCurrentSession: current });
  const changed = (originalEffectUnknown = false) => new ApiError(409, 'session_changed',
    'The account session changed. Check the original account before repeating a change.', false, originalEffectUnknown);
  const api: ActivityApi = {
    async request<T>(path: string, method = 'GET', body?: unknown, key?: string): Promise<T> {
      if (!current()) throw changed();
      try {
        const value = await dataflow.ownerInputApi.request<T>(path, method, body, key);
        if (!current()) throw changed(method !== 'GET');
        return value;
      } catch (error) {
        if (!current()) throw changed(method !== 'GET' ||
          (error instanceof ApiError && (error.effectUnknown || error.originalEffectUnknown)));
        throw error;
      }
    },
  };
  const resources = new ActivityResources(api);
  const issueSecureKey = () => {
    if (!current()) throw changed();
    return newSecureKey();
  };
  const controller = new DraftController(binding.sessionGeneration, resources, issueSecureKey, speech);
  return {
    sessionGeneration: binding.sessionGeneration,
    newSecureKey: issueSecureKey,
    resources,
    controller,
    background: () => controller.background(),
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      dataflow.dispose();
      await controller.dispose();
    },
  };
}
