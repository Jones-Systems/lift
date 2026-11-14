import { createCredentialsPort, type CredentialsPort, type CredentialOutcome } from '../api/credentials';
import type { FormResources } from '../api/resources';
import type { AuthAttemptGuard } from '../api/transport';
import type { AccountSettings } from '../api/settings';
import { createChangePasswordController, createChangeEmailController, securityActions,
  type CredentialTransition } from '../features/credentials/model';

type Flow = Readonly<{ kind: 'password'; controller: ReturnType<typeof createChangePasswordController> }>
  | Readonly<{ kind: 'email'; controller: ReturnType<typeof createChangeEmailController> }>;
type HostState = Readonly<{ status: 'choosing' | 'editing' | 'returning' | 'disposed'; flow: Flow | null;
  reading: boolean; readFailed: boolean; completionNotice: string | null }>;

/** One admitted credential view owns its replacement, but never a foreign auth intent. */
export function captureAccountSecuritySession(resources: FormResources, scope: Readonly<{
  accountId: string;
  sessionGeneration: string;
  isOwnerCurrent(): boolean;
  onForeignAuth(): void;
  settings?: () => AccountSettings | null;
  returnToSettings?: (completion: CredentialTransition | null) => Promise<boolean>;
  onSessionEnded?: () => void;
}>, originalAuth: AuthAttemptGuard) {
  let live = originalAuth.isCurrent(), foreign = false, replacing = false;
  let auth = originalAuth;
  let acquisition: ReturnType<typeof reacquire> | null = null;
  let passwordFlight: Promise<CredentialOutcome> | null = null;
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
      const flight = port.changePassword(input);
      passwordFlight = flight;
      try { return await flight; }
      finally {
        if (ownerCurrent()) auth = resources.api.captureAuthContext();
        replacing = false; passwordFlight = null;
      }
    },
  });
  async function reacquire() {
    // Departure may stop presentation while an originating replacement still owns transport custody.
    if (passwordFlight) await passwordFlight;
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
  let hostState: HostState = Object.freeze({ status: 'choosing', flow: null, reading: false, readFailed: false, completionNotice: null });
  let completion: CredentialTransition | null = null, returnFlight: Promise<void> | null = null;
  const observers = new Set<() => void>();
  const update = (patch: Partial<HostState>) => {
    hostState = Object.freeze({ ...hostState, ...patch });
    for (const listener of [...observers]) listener();
  };
  const available = () => securityActions(scope.settings?.() ?? null, scope.accountId);
  const allowed = (kind: Flow['kind']) => kind === 'password' ? available().changePassword : available().changeEmail;
  function disposeFlow() {
    const previous = hostState.flow;
    // Remove dispatch authority before notifying the leaf's subscribed observers.
    hostState = Object.freeze({ ...hostState, flow: null });
    previous?.controller.dispose();
  }
  function disposeHost() {
    if (hostState.status === 'disposed') return;
    const previous = hostState.flow;
    hostState = Object.freeze({ status: 'disposed', flow: null, reading: false, readFailed: false, completionNotice: null });
    completion = null; previous?.controller.dispose();
    for (const listener of [...observers]) listener();
    observers.clear();
  }
  function hostCurrent() {
    if (!isCurrentSession()) disposeHost();
    return hostState.status !== 'disposed';
  }
  async function retryReturn() {
    if (!hostCurrent() || hostState.status !== 'returning') return;
    if (returnFlight) return returnFlight;
    update({ reading: true, readFailed: false });
    const flight = (async () => {
      let accepted = false;
      try { accepted = await scope.returnToSettings?.(completion) === true; }
      catch { /* Only the read is retried; confirmed and unknown mutations are never replayed. */ }
      if (hostState.status !== 'disposed') update({ reading: false, readFailed: !accepted });
    })();
    returnFlight = flight;
    try { await flight; } finally { if (returnFlight === flight) returnFlight = null; }
  }
  function depart() {
    if (!hostCurrent()) return Promise.resolve();
    if (hostState.status !== 'returning') {
      disposeFlow(); completion = null;
      update({ status: 'returning' });
    }
    return retryReturn();
  }
  function fenceAdmission() { live = false; subscription.remove(); port.dispose(); }
  function disposeAdmission() { fenceAdmission(); disposeHost(); }
  const host = Object.freeze({
    snapshot() {
      if (hostCurrent() && hostState.flow && !allowed(hostState.flow.kind)) void depart();
      return hostState;
    },
    available,
    subscribe(listener: () => void) {
      if (hostCurrent()) observers.add(listener);
      return () => { observers.delete(listener); };
    },
    open(kind: Flow['kind']) {
      if (!hostCurrent() || hostState.status === 'returning' || !allowed(kind)) return;
      const before = hostState.flow?.controller.snapshot();
      if (before && ['pending', 'unknown', 'saved'].includes(before.status)) return;
      disposeFlow();
      let flow: Flow;
      const flowPort: CredentialsPort = Object.freeze({ ...credentials,
        // A controller borrows this port. Only the shell admission may dispose its shared transport port.
        isCurrent: () => hostCurrent() && hostState.flow === flow && allowed(kind),
        dispose() {},
      });
      flow = kind === 'password'
        ? Object.freeze({ kind, controller: createChangePasswordController(flowPort) })
        : Object.freeze({ kind, controller: createChangeEmailController(flowPort, { currentEmail: available().email! }) });
      update({ status: 'editing', flow, readFailed: false });
    },
    complete() {
      if (!hostCurrent() || hostState.status !== 'editing' || !hostState.flow || !allowed(hostState.flow.kind)) return;
      // Ignore presentation-supplied targets: consume a fresh transition from the original current controller once.
      const transition = hostState.flow.controller.transition();
      if (!transition || !hostCurrent()) return;
      completion = transition;
      disposeFlow(); update({ status: 'returning', completionNotice: transition.destination === 'settings' ? transition.notice : null });
      if (transition.destination === 'sign-in') { scope.onSessionEnded?.(); return; }
      void retryReturn();
    },
    reconcile() {
      const flow = hostState.flow;
      if (!hostCurrent() || flow?.kind !== 'email' || flow.controller.snapshot().status !== 'unknown'
        || flow.controller.snapshot().step !== 'code') return Promise.resolve();
      return depart();
    },
    // Insertion teardown must fence synchronously without notifying React subscribers in that phase.
    fence: fenceAdmission,
    disposeWhenFenced() { if (!live) disposeHost(); },
    depart, retryReturn, dispose: disposeAdmission,
  });
  return Object.freeze({ accountId: scope.accountId, sessionGeneration: scope.sessionGeneration, credentials, isCurrentSession,
    host,
    /** Reconciliation reads are shared while pending; no credential mutation is repeated. */
    reacquire() {
      if (acquisition) return acquisition;
      const result = reacquire(); acquisition = result;
      void result.finally(() => { if (acquisition === result) acquisition = null; });
      return result;
    },
    dispose: disposeAdmission,
  });
}
