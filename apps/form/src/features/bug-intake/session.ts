import type { FormTransport } from '../../api/transport';
import { BugIntakeResources } from '../../api/bugIntake';
import { BugIntakeController } from './controller';

export type BugIntakeSessionBinding = Readonly<{
  sessionGeneration: string;
  isCurrentSession(): boolean;
  api: Pick<FormTransport, 'request' | 'captureAuthContext' | 'subscribeAuthChanges'>;
}>;

/** Root supplies the authenticated session and key source. Construction performs no request or diagnostic collection. */
export function createBugIntakeSession(binding: BugIntakeSessionBinding, newSecureKey: () => string) {
  if (!binding.sessionGeneration) throw new Error('bug_intake_session_binding_required');
  let disposed = false;
  const resources = new BugIntakeResources(binding.api, () => !disposed && binding.isCurrentSession());
  const controller = new BugIntakeController(resources, newSecureKey);
  const subscription = binding.api.subscribeAuthChanges(() => {
    resources.dispose(); controller.invalidate('session_changed');
  });
  return Object.freeze({
    sessionGeneration: binding.sessionGeneration,
    resources,
    controller,
    dispose(): void {
      if (disposed) return;
      disposed = true; subscription.remove(); resources.dispose(); controller.dispose();
    },
  });
}
export type BugIntakeSession = ReturnType<typeof createBugIntakeSession>;
