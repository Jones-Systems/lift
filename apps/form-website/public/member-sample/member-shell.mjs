import { mountApplication } from '../application-ui.mjs';
import { createSampleSession } from './sample-session.mjs';
import { mountConnections } from '../member-ecosystem/connections.mjs';

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const views = { workout: 'Workout', plans: 'Plan', data: 'Data', settings: 'Settings', premium: 'Premium', coach: 'Coach', connections: 'Connections' };
const applicationViews = { workout: 'workout', plans: 'plans', data: 'history', settings: 'preferences' };
const scenarios = {
  normal: 'Normal responses', empty: 'Empty fictional records (discards sample changes)',
  'read-error': 'Fail the next resource read', conflict: 'Conflict on the next change',
  'lost-write-response': 'Lose the next write response (change may apply)',
  'revoked-membership': 'Revoke fictional Plus access', 'account-switch': 'Switch fictional identity (discards drafts)',
  'malformed-response': 'Malformed next resource response',
};
const action = (name, label, attrs = '') => `<button type="button" data-member-action="${name}"${attrs}>${label}</button>`;
const explainError = error => ({ unknown_intent_pending: 'A sample write outcome is unknown. Resolve its preserved intent in the workspace before refreshing membership or account details.',
  operation_in_progress: 'Wait for the current sample operation to finish.', lifecycle_suspended: 'Resume the sample before continuing.',
  stale_generation: 'The account changed. The earlier response was discarded.' }[error.code ?? error.message] ?? 'This sample operation could not be confirmed. Review its current state or reset the fictional account.');

export function renderMemberFrame() {
  return `<div class="member-sample-shell"><aside class="member-sample-banner" role="note"><strong>Fictional sample account</strong><p>Synthetic data in this tab’s memory · nothing is saved. Account confirmations below describe this local simulation, not a real sign-in. Use fictional details only.</p></aside><nav class="member-navigation" aria-label="Member sample">${Object.entries(views).map(([id, label]) => action('navigate', label, ` data-member-view="${id}"`)).join('')}<a href="/app/journal/">Journal</a></nav><details class="member-controls"><summary>Sample controls</summary><p>Reset or switch discards this tab’s sample changes and drafts, including unresolved simulated changes. No real account is affected.</p><div>${action('reset', 'Reset fictional sample')}${action('switch', 'Switch fictional account')}${action('signout', 'Sign out of sample')}${action('refresh', 'Reload sample account')}</div><label>Scenario<select data-member-scenario>${Object.entries(scenarios).map(([id, label]) => `<option value="${id}">${label}</option>`).join('')}</select></label>${action('scenario', 'Apply scenario')}<p>A failure scenario affects a subsequent request; it does not manufacture a saved result.</p></details><p class="member-notice" role="status" aria-live="polite" data-member-notice></p><div data-member-resume hidden>${action('resume', 'Resume sample')}<p>The sample is paused. Return to this page to resume; earlier operations may have completed in memory.</p></div><div data-member-application></div><section data-member-premium hidden aria-label="Premium"></section><section data-member-coach hidden aria-label="Coach"></section><section data-member-connections hidden aria-label="Connections"></section><section data-member-privacy hidden aria-label="Sample data controls"></section></div>`;
}

export function renderSamplePremium(snapshot, { revokedAccountId = null } = {}) {
  const grants = snapshot.status === 'ready' ? snapshot.account.entitlements : null;
  const state = !grants ? 'unknown' : grants.active.includes('form_plus') ? 'active'
    : snapshot.account.account?.accountId === revokedAccountId ? 'revoked' : 'inactive-or-revoked';
  const text = !grants ? 'Sample membership is unknown. Reload the sample account to check its current state.'
    : state === 'active' ? 'Fictional Form Plus access is active in this in-memory sample. This is not a purchase.'
      : state === 'revoked' ? 'Revoked sample scenario: the current read confirms no active fictional Form Plus access.'
        : 'No active fictional Form Plus access. Inactive or revoked access does not authorize paid features.';
  return `<h2>Premium</h2><p data-membership-state="${state}">${text}</p><p>Purchase availability: unavailable. This website sample has no checkout, restore, cancellation, price or payment provider.</p><div><button disabled>Checkout unavailable</button><button disabled>Restore unavailable</button><button disabled>Cancel subscription unavailable</button></div>${action('refresh', 'Refresh sample membership')}${action('plus', 'Grant fictional Plus (no charge)')}<p>Plans, performed workout records and settings are sample interactions; this page makes no paid-feature promise.</p>`;
}

export function mountMemberSample({ root, transport, session = createSampleSession({ transport }), pageTarget, visibilityTarget,
  readVisibility, keyFactory, mountApplicationPort = mountApplication, mountConnectionsPort = mountConnections,
  loadCoach = () => import('../member-coach/coach-screen.mjs'), loadPrivacy = () => import('./privacy-flow.mjs'),
  coachPorts = {}, privacyPorts = {}, autoStart = true } = {}) {
  if (!root?.querySelector || typeof root.addEventListener !== 'function' || typeof readVisibility !== 'function') throw new TypeError('member_sample_ports_required');
  root.innerHTML = renderMemberFrame();
  const slots = Object.fromEntries(['application', 'premium', 'coach', 'connections', 'privacy', 'notice', 'resume']
    .map(name => [name, root.querySelector(`[data-member-${name}]`)]));
  if (Object.values(slots).some(slot => !slot)) throw new TypeError('member_sample_slots_required');
  let disposed = false, paused = readVisibility() !== 'visible', pagePresent = true, view = 'plans', sequence = 0;
  let actionEpoch = 0, seenAccount = null, finalDisposal = null, revokedAccountId = null;
  const cleanupTasks = new Set(), cleanupErrors = [];
  function trackCleanup(result) {
    if (!result || typeof result.then !== 'function') return;
    const task = Promise.resolve(result).then(value => {
      if (value?.cleanup === 'incomplete') throw new Error('coach_cleanup_incomplete');
    }).catch(error => {
      cleanupErrors.push(error);
      if (!disposed) slots.notice.textContent = 'Coach cleanup could not be confirmed. No replacement capture should be started.';
    }).finally(() => cleanupTasks.delete(task));
    cleanupTasks.add(task);
  }
  let app, coach = null, connections = null, privacy = null, coachLoad = null, privacyLoad = null;
  let coachEpoch = 0, privacyEpoch = 0, notice = '', seenGeneration = session.snapshot().generation;
  let lastApplicationView = session.snapshot().application.selectedView;
  const subscriptions = new Set();
  const readAccount = () => {
    const value = session.snapshot();
    return !disposed && !paused && value.status === 'ready' ? Object.freeze({ synthetic: true, kind: 'sample',
      accountId: value.account.account.accountId, generation: value.generation }) : null;
  };
  const readCoachAccount = () => !disposed && !paused ? session.readAccount() : null;
  const subscribeAccount = callback => { subscriptions.add(callback); return () => subscriptions.delete(callback); };
  function retireExtras() {
    coachEpoch++; privacyEpoch++; coachLoad = privacyLoad = null;
    const previous = [coach, connections, privacy]; coach = connections = privacy = null;
    for (const mounted of previous) {
      try { trackCleanup(mounted?.dispose()); }
      catch (error) { cleanupErrors.push(error); }
    }
    for (const name of ['coach', 'connections', 'privacy']) slots[name].innerHTML = '';
  }
  function signalAccount() {
    const callbacks = new Set([coach?.accountChanged, connections?.accountChanged, privacy?.accountChanged, ...subscriptions]);
    for (const callback of callbacks) {
      try { if (callback) trackCleanup(callback()); }
      catch (error) { cleanupErrors.push(error); }
    }
  }
  function mountApp() {
    app = mountApplicationPort({ root: slots.application, session, pageTarget, visibilityTarget, readVisibility,
      keyFactory: keyFactory ?? (() => `sample-intent-${++sequence}`) });
  }
  async function ensureCoach() {
    if (coach || coachLoad || disposed || paused || view !== 'coach') return;
    if (cleanupErrors.length) {
      slots.coach.innerHTML = '<h2>Coach paused</h2><p role="alert">Previous Coach cleanup could not be confirmed. A replacement Coach is held.</p>';
      return;
    }
    const ticket = ++coachEpoch;
    slots.coach.innerHTML = '<h2>Coach</h2><p role="status">Loading the local Coach tools…</p>';
    coachLoad = (async () => {
      try {
        const module = await loadCoach();
        if (disposed || paused || view !== 'coach' || ticket !== coachEpoch) return;
        coach = module.mountMemberCoach({ ...coachPorts, root: slots.coach, readAccount: readCoachAccount, subscribeAccount,
          pageTarget, visibilityTarget, readVisibility });
      } catch {
        if (!disposed && ticket === coachEpoch) slots.coach.innerHTML = `<h2>Coach unavailable</h2><p>The local Coach module could not be loaded. No microphone or provider was activated.</p>${action('retry-coach', 'Retry local Coach')}`;
      } finally { if (ticket === coachEpoch) coachLoad = null; }
    })();
    return coachLoad;
  }
  async function ensurePrivacy() {
    if (privacy || privacyLoad || disposed || paused || view !== 'data') return;
    const ticket = ++privacyEpoch;
    slots.privacy.innerHTML = '<h2>Sample data controls</h2><p role="status">Loading in-memory data controls…</p>';
    privacyLoad = (async () => {
      try {
        const module = await loadPrivacy();
        if (disposed || paused || view !== 'data' || ticket !== privacyEpoch) return;
        privacy = module.mountMemberPrivacy({ ...privacyPorts, root: slots.privacy, readAccount,
          onSampleDeleted: () => perform('signout') });
      } catch {
        if (!disposed && ticket === privacyEpoch) slots.privacy.innerHTML = `<h2>Sample data controls unavailable</h2><p>The local export and deletion simulation could not be loaded. No real data action was requested.</p>${action('retry-privacy', 'Retry sample data controls')}`;
      } finally { if (ticket === privacyEpoch) privacyLoad = null; }
    })();
    return privacyLoad;
  }
  function paint() {
    if (disposed) return;
    const value = session.snapshot();
    slots.notice.textContent = (cleanupErrors.length ? 'Coach cleanup could not be confirmed. A replacement Coach is held.' : notice) || (value.status === 'checking' ? 'Loading fictional account…' : value.status === 'anonymous' ? 'Sample signed out. Reset to open a fresh fictional account.' : '');
    slots.resume.hidden = !paused;
    slots.application.hidden = paused || !applicationViews[view];
    for (const name of ['premium', 'coach', 'connections']) slots[name].hidden = paused || view !== name;
    slots.privacy.hidden = paused || view !== 'data';
    for (const node of root.querySelectorAll?.('[data-member-view]') ?? []) {
      if (node.getAttribute('data-member-view') === view) node.setAttribute('aria-current', 'page');
      else node.removeAttribute('aria-current');
    }
    if (!paused && view === 'premium') slots.premium.innerHTML = renderSamplePremium(value, { revokedAccountId });
    if (!paused && view === 'connections' && !connections) connections = mountConnectionsPort(slots.connections, { readAccount, runtimeQualified: false });
    if (!paused && view === 'coach') void ensureCoach();
    if (!paused && view === 'data') void ensurePrivacy();
  }
  function observe(value) {
    if (disposed) return;
    if (value.generation !== seenGeneration) {
      seenGeneration = value.generation; signalAccount(); retireExtras();
    }
    if (value.application.selectedView !== lastApplicationView) {
      lastApplicationView = value.application.selectedView;
      const next = Object.keys(applicationViews).find(name => applicationViews[name] === lastApplicationView);
      if (next && next !== view && value.status === 'ready') { retireExtras(); view = next; }
    }
    const identity = JSON.stringify(readAccount());
    if (identity !== seenAccount) { seenAccount = identity; signalAccount(); }
    paint();
  }
  async function perform(name, value) {
    if (disposed) throw new Error('member_sample_disposed');
    if (name === 'resume') {
      if (!pagePresent || readVisibility() !== 'visible') throw new Error('lifecycle_suspended');
      await app.perform('resume'); paused = false; paint(); return;
    }
    if (paused || !pagePresent || readVisibility() !== 'visible') throw new Error('lifecycle_suspended');
    const ticket = ++actionEpoch;
    const current = () => !disposed && !paused && ticket === actionEpoch;
    notice = '';
    try {
      if (name === 'navigate') {
        if (!Object.hasOwn(views, value)) throw new TypeError('unknown_member_view');
        if (view !== value) retireExtras();
        view = value; paint();
        if (applicationViews[value]) await app.perform('navigate', { id: applicationViews[value] });
      } else if (name === 'reset' || name === 'switch') {
        revokedAccountId = null; app.dispose(); retireExtras();
        const result = name === 'reset' ? session.reset() : session.switchAccount();
        mountApp(); await result;
        if (!current()) return;
        await app.perform('resume'); await perform('navigate', 'plans');
      } else if (name === 'scenario') {
        if (!Object.hasOwn(scenarios, value)) throw new TypeError('unknown_sample_scenario');
        if (['empty', 'account-switch'].includes(value)) {
          revokedAccountId = null; app.dispose(); retireExtras(); const result = session.setScenario(value); mountApp();
          await result;
          if (!current()) return;
          await app.perform('resume'); await perform('navigate', 'plans');
        } else {
          await session.setScenario(value);
          if (current() && value === 'revoked-membership') {
            await app.perform('refresh');
            if (current()) revokedAccountId = session.snapshot().account.account?.accountId ?? null;
          }
        }
        if (current()) notice = `Sample scenario selected: ${scenarios[value]}.`;
      } else if (name === 'plus') {
        await session.setPlus(true); revokedAccountId = null; if (current()) await app.perform('resume');
      } else if (name === 'refresh' || name === 'signout') {
        await app.perform(name);
      } else if (name === 'retry-coach') await ensureCoach();
      else if (name === 'retry-privacy') await ensurePrivacy();
      else throw new TypeError('unknown_member_action');
    } catch (error) { if (current()) notice = explainError(error); throw error; }
    finally { if (current()) paint(); }
  }
  const click = event => {
    const target = event.target.closest?.('[data-member-action]');
    if (!target || !root.contains(target) || target.disabled) return;
    event.preventDefault();
    const name = target.getAttribute('data-member-action');
    const value = name === 'navigate' ? target.getAttribute('data-member-view') : root.querySelector('[data-member-scenario]')?.value;
    return perform(name, value).catch(() => {});
  };
  function suspend() { if (!disposed) { actionEpoch++; paused = true; signalAccount(); retireExtras(); slots.premium.innerHTML = ''; paint(); } }
  const visibilityChanged = () => { if (readVisibility() !== 'visible') suspend(); };
  const pageHidden = () => { pagePresent = false; suspend(); };
  const pageShown = () => { pagePresent = true; suspend(); };
  mountApp();
  const unsubscribe = session.subscribe(observe);
  root.addEventListener('click', click);
  visibilityTarget.addEventListener('visibilitychange', visibilityChanged);
  pageTarget.addEventListener('pagehide', pageHidden); pageTarget.addEventListener('pageshow', pageShown);
  paint();
  const ready = autoStart && !paused ? (async () => {
    const start = perform('refresh'), ticket = actionEpoch;
    await start;
    if (!disposed && !paused && ticket === actionEpoch) await perform('navigate', 'plans');
  })() : Promise.resolve();
  void ready.catch(() => {});
  return Object.freeze({ ready, perform, session, snapshot: () => ({ view, paused, disposed, cleanupPending: cleanupTasks.size, cleanupFailed: cleanupErrors.length > 0, session: session.snapshot() }),
    dispose() {
      if (disposed) return finalDisposal;
      disposed = true; actionEpoch++; signalAccount(); retireExtras(); unsubscribe(); subscriptions.clear(); app.dispose();
      root.removeEventListener('click', click); visibilityTarget.removeEventListener('visibilitychange', visibilityChanged);
      pageTarget.removeEventListener('pagehide', pageHidden); pageTarget.removeEventListener('pageshow', pageShown);
      root.innerHTML = '';
      finalDisposal = Promise.all([...cleanupTasks]).then(() => {
        if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'member_cleanup_unconfirmed');
      });
      void finalDisposal.catch(() => {});
      return finalDisposal;
    } });
}
