import { createSyntheticApplicationController } from '../application-controller.mjs';
import { ResourceError } from '../resource-client.mjs';

let nextSession = 0;
const failure = error => Object.freeze({ code: error.code ?? error.message, status: error.status ?? null, effect: error.effect ?? 'none' });
const replacementScenarios = new Set(['empty', 'account-switch']);

export function createSampleSession({ transport } = {}) {
  if (!transport || ['fetchImpl', 'reset', 'signout', 'switchAccount', 'setScenario'].some(name => typeof transport[name] !== 'function')) {
    throw new TypeError('sample_transport_required');
  }
  const application = createSyntheticApplicationController({
    config: { apiBase: 'https://api.invalid', verifiedBrowserOrigin: 'https://web.invalid', trackingEnabled: false },
    browserOrigin: 'https://web.invalid', fetchImpl: transport.fetchImpl,
  });
  const handle = `fictional-session-${++nextSession}`, listeners = new Set(), active = new Set();
  let phase = 'empty', transition = 0, transitionError = null, signingOut = null;
  function snapshot(options) {
    const value = application.snapshot(options);
    const error = transitionError ?? value.resources.identity?.error ??
      Object.values(value.resources).find(state => state.error?.status === 401)?.error ?? null;
    const status = ['checking', 'signing-out', 'unknown'].includes(phase) ? phase
      : value.account ? 'ready' : error?.status === 401 || phase === 'anonymous' ? 'anonymous'
        : error ? 'unavailable' : 'empty';
    return Object.freeze({ status, generation: value.generation, runtimeQualified: false, synthetic: true, error,
      account: Object.freeze({ status: status === 'ready' ? 'authenticated' : status,
        account: value.account, entitlements: value.entitlements }), application: value });
  }
  function publish() { const value = snapshot(); for (const listener of [...listeners]) listener(value); return value; }
  function track(result) {
    const promise = Promise.resolve(result).finally(() => active.delete(promise));
    active.add(promise); return promise;
  }
  function clear() {
    transition++; application.clear(); phase = 'empty'; transitionError = null;
    return publish();
  }
  function assertRefreshable() {
    if (active.size || ['checking', 'signing-out'].includes(phase)) throw new ResourceError('operation_in_progress');
    if (Object.values(application.snapshot().resources).some(state => state.status === 'unknown')) throw new ResourceError('unknown_intent_pending');
  }
  function refresh() {
    assertRefreshable();
    const ticket = ++transition;
    phase = 'checking'; transitionError = null;
    const result = application.bindIdentity(); publish();
    return track(Promise.resolve(result).finally(() => {
      if (ticket === transition) { phase = 'empty'; publish(); }
    }).then(() => snapshot()));
  }
  function signout() {
    if (signingOut) return signingOut;
    if (phase === 'unknown') return Promise.resolve(snapshot());
    const admitted = [...active], ticket = ++transition;
    application.clear(); phase = 'signing-out'; transitionError = null; publish();
    signingOut = track((async () => {
      await Promise.allSettled(admitted);
      if (ticket !== transition) return snapshot();
      try { await transport.signout(); if (ticket === transition) phase = 'anonymous'; }
      catch (error) {
        if (ticket === transition) { phase = 'unknown'; transitionError = failure(error); }
        throw error;
      } finally { if (ticket === transition) publish(); }
      return snapshot();
    })()).finally(() => { signingOut = null; });
    return signingOut;
  }
  function replace(name, ...args) {
    // Only explicit fictional replacement discards unresolved intents; drain physical work before changing the fixture.
    const admitted = [...active], ticket = ++transition;
    application.clear(); phase = 'checking'; transitionError = null; publish();
    return track((async () => {
      await Promise.allSettled(admitted);
      if (ticket !== transition) return snapshot();
      try {
        await transport[name](...args);
        if (ticket !== transition) return snapshot();
        await application.bindIdentity();
        if (ticket === transition) phase = 'empty';
      } catch (error) {
        if (ticket === transition) { phase = 'empty'; transitionError = failure(error); }
        throw error;
      } finally { if (ticket === transition) publish(); }
      return snapshot();
    })());
  }
  const { snapshot: unusedSnapshot, selectView, clear: unusedClear, invalidate: unusedInvalidate,
    bindIdentity: unusedBind, ...resources } = application;
  const operations = Object.fromEntries(Object.entries(resources).map(([name, operation]) => [name, (...args) => {
    if (snapshot().status !== 'ready') throw new ResourceError('session_not_ready');
    const ticket = application.snapshot().generation;
    const result = operation(...args); publish();
    return track(Promise.resolve(result).then(value => {
      if (ticket !== application.snapshot().generation) throw new ResourceError('stale_generation');
      return value;
    }).finally(publish));
  }]));
  return Object.freeze({ ...operations, snapshot, refresh, signout, clear, invalidate: clear,
    selectView(view) { selectView(view); return publish(); },
    reset: () => replace('reset'), switchAccount: account => replace('switchAccount', account),
    setScenario(name) {
      if (replacementScenarios.has(name)) return replace('setScenario', name);
      assertRefreshable(); transport.setScenario(name); return publish();
    },
    setPlus(value) {
      assertRefreshable();
      if (typeof transport.setPlus !== 'function') throw new ResourceError('sample_plus_unavailable');
      transport.setPlus(value); return refresh();
    },
    readAccount() {
      const value = snapshot();
      return value.status === 'ready' ? Object.freeze({ accountId: value.account.account.accountId,
        authSessionId: `${handle}-${value.generation}`, accountEpoch: value.generation }) : null;
    },
    subscribe(listener) {
      if (typeof listener !== 'function') throw new TypeError('sample_listener_required');
      listeners.add(listener); return () => listeners.delete(listener);
    },
  });
}
