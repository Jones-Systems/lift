import { createConfiguredAccountAdapter, configuredSessionOptions } from './account.mjs';
import { createConfiguredApplicationController } from './application-controller.mjs';
import { ResourceError } from './resource-client.mjs';

const sameIdentity = (a, b) => a && b && a.accountId === b.accountId && a.appAccountToken === b.appAccountToken;
const failure = error => Object.freeze({ code: error.code ?? error.message, status: error.status ?? null, effect: error.effect ?? 'none' });

export function createConfiguredBrowserSession(options) {
  // Whole operations acquire this barrier once, inside each consumer; transitions never wrap them in it.
  let barrier = Promise.resolve();
  const sessionDispatch = Object.freeze({ run(operation) {
    const result = barrier.then(operation);
    barrier = result.catch(() => {});
    return result;
  } });
  const configured = configuredSessionOptions({ ...options, sessionDispatch });
  const account = createConfiguredAccountAdapter(configured);
  const application = createConfiguredApplicationController(configured);
  let generation = 0, admitted = false, status = 'empty', error = null, signoutUnconfirmed = false, pendingSignout = null;

  function observeIdentity() {
    if (admitted && !sameIdentity(account.snapshot().account, application.snapshot().account)) {
      admitted = false;
      account.clear();
      status = 'unavailable';
      error = failure(new ResourceError('account_changed'));
    }
  }

  function snapshot(presentationOptions) {
    observeIdentity();
    return Object.freeze({ status, generation, error, runtimeQualified: false,
      account: account.snapshot(), application: application.snapshot(presentationOptions) });
  }

  function transition(nextStatus) {
    generation++;
    admitted = false;
    application.clear();
    account.clear();
    status = nextStatus;
    if (!signoutUnconfirmed) error = null;
    return generation;
  }

  function clear() {
    transition(signoutUnconfirmed ? 'unknown' : 'empty');
    return snapshot();
  }

  async function refresh() {
    if (pendingSignout) throw new ResourceError('session_transition_pending');
    observeIdentity();
    if (admitted && Object.values(application.snapshot().resources).some(state => state.status === 'unknown')) {
      throw new ResourceError('unknown_intent_pending');
    }
    const ticket = transition('checking');
    try {
      const checked = await account.refresh();
      if (ticket !== generation) return snapshot();
      if (checked.status !== 'authenticated') {
        status = signoutUnconfirmed && checked.status !== 'anonymous' ? 'unknown' : checked.status;
        if (checked.status === 'anonymous') { signoutUnconfirmed = false; error = null; }
        return snapshot();
      }
      // This continuation runs after the account operation releases the barrier.
      const bound = await application.bindIdentity();
      if (ticket !== generation) return snapshot();
      if (!sameIdentity(checked.account, bound.account)) {
        application.clear(); account.clear();
        status = signoutUnconfirmed ? 'unknown' : 'unavailable';
        if (!signoutUnconfirmed) error = failure(new ResourceError('account_changed'));
        return snapshot();
      }
      admitted = true; status = 'ready'; error = null; signoutUnconfirmed = false;
      return snapshot();
    } catch (cause) {
      if (ticket === generation) {
        admitted = false; application.clear(); account.clear();
        status = signoutUnconfirmed ? 'unknown' : 'unavailable';
        if (!signoutUnconfirmed) error = failure(cause);
      }
      throw cause;
    }
  }

  function signout() {
    if (pendingSignout) return pendingSignout;
    if (signoutUnconfirmed) return Promise.resolve(snapshot());
    const ticket = transition('signing-out');
    pendingSignout = account.signout().then(result => {
      if (result.status === 'unknown') {
        signoutUnconfirmed = true; error = result.error; status = 'unknown';
      } else if (ticket === generation) {
        status = result.status; error = result.error;
      }
      return snapshot();
    }).finally(() => { pendingSignout = null; });
    return pendingSignout;
  }

  const { snapshot: ignoredSnapshot, clear: ignoredClear, invalidate: ignoredInvalidate,
    bindIdentity: ignoredBind, selectView, ...resourceOperations } = application;
  const operations = Object.fromEntries(Object.entries(resourceOperations).map(([name, operation]) => [name, (...args) => {
    observeIdentity();
    if (!admitted) throw new ResourceError('session_not_ready');
    const ticket = generation;
    const result = operation(...args);
    return Promise.resolve(result).then(value => {
      if (ticket !== generation) throw new ResourceError('stale_generation');
      observeIdentity();
      return value;
    });
  }]));
  const credentialsUnavailable = () => { throw new ResourceError('credential_submission_unavailable'); };
  return Object.freeze({ ...operations, snapshot, refresh, signout, clear, invalidate: clear,
    selectView: view => { selectView(view); return snapshot(); },
    signin: credentialsUnavailable, signup: credentialsUnavailable, switchAccount: credentialsUnavailable });
}
