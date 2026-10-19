import { createCredentialsPort, type CredentialsPort } from '../api/credentials';
import type { FormResources } from '../api/resources';
import type { AuthAttemptGuard } from '../api/transport';

/** One admitted credential view owns its replacement, but never a foreign auth intent. */
export function captureAccountSecuritySession(resources: FormResources, scope: Readonly<{
  accountId: string;
  sessionGeneration: string;
  isOwnerCurrent(): boolean;
  onForeignAuth(): void;
}>, originalAuth: AuthAttemptGuard) {
  let live = originalAuth.isCurrent(), foreign = false, replacing = false;
  let auth = originalAuth;
  let acquisition: ReturnType<typeof reacquire> | null = null;
  const ownerCurrent = () => {
    if (!scope.isOwnerCurrent()) live = false;
    return live && !foreign;
  };
  const port = createCredentialsPort(resources.api, { isCurrent: ownerCurrent });
  const subscription = resources.api.subscribeAuthChanges(source => {
    if (replacing && source === port.replacementGuard && ownerCurrent()) return;
    const wasCurrent = ownerCurrent();
    foreign = true; live = false;
    if (wasCurrent) scope.onForeignAuth();
  });
  const isCurrentSession = () => ownerCurrent() && port.isCurrent() && (replacing || auth.isCurrent());
  const credentials: CredentialsPort = Object.freeze({ ...port,
    async changePassword(input: Parameters<CredentialsPort['changePassword']>[0]) {
      if (!isCurrentSession()) return Object.freeze({ status: 'failed' as const,
        issue: Object.freeze({ code: 'session_changed' as const, status: 409, effectUnknown: false }) });
      if (replacing) return Object.freeze({ status: 'failed' as const,
        issue: Object.freeze({ code: 'operation_pending' as const, status: 409, effectUnknown: false }) });
      replacing = true;
      try { return await port.changePassword(input); }
      finally {
        if (ownerCurrent()) auth = resources.api.captureAuthContext();
        replacing = false;
      }
    },
  });
  async function reacquire() {
    if (replacing || !isCurrentSession()) return null;
    const capturedAuth = auth;
    const current = () => !replacing && auth === capturedAuth && capturedAuth.isCurrent() && isCurrentSession();
    const scoped = resources.boundTo(current);
    try {
      const [account, entitlements, settings] = await Promise.all([scoped.account(), scoped.entitlements(), scoped.settings()]);
      if (!current() || [account, entitlements, settings].some(value => value.accountId !== scope.accountId)) return null;
      return Object.freeze({ account, entitlements, settings, auth: capturedAuth, isCurrent: current });
    } catch { return null; }
  }
  return Object.freeze({ accountId: scope.accountId, sessionGeneration: scope.sessionGeneration, credentials, isCurrentSession,
    /** Reconciliation reads are shared while pending; no credential mutation is repeated. */
    reacquire() {
      if (acquisition) return acquisition;
      const result = reacquire(); acquisition = result;
      void result.finally(() => { if (acquisition === result) acquisition = null; });
      return result;
    },
    dispose() { live = false; subscription.remove(); port.dispose(); },
  });
}
