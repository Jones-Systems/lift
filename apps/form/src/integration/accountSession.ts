import type { FormResources } from '../api/resources';
import type { AuthAttemptGuard } from '../api/transport';

export function captureAccountSession(resources: FormResources, scope: Readonly<{
  accountId: string;
  sessionGeneration: string;
  isCurrentSession(): boolean;
}>, originalAuth: AuthAttemptGuard = resources.api.captureAuthContext()) {
  const { accountId, sessionGeneration } = scope;
  const viewCurrent = scope.isCurrentSession;
  let expired = false;
  const isCurrentSession = () => {
    if (!originalAuth.isCurrent() || !viewCurrent()) expired = true;
    return !expired;
  };
  return Object.freeze({ accountId, sessionGeneration, isCurrentSession,
    resources: resources.boundTo(isCurrentSession) });
}
