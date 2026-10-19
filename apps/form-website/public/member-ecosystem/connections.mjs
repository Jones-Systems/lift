const categories = Object.freeze({ workouts: 'Workout history', plans: 'Saved plans' });
const requests = Object.freeze({
  workouts: Object.freeze({ category: 'workouts', title: 'Review a workout summary', detail: 'Fictional session: Tuesday strength · 3 movements · 35 minutes.', effect: 'Read example only. No account data is retrieved.' }),
  plans: Object.freeze({ category: 'plans', title: 'Review a saved plan', detail: 'Fictional plan: Full-body foundations · 3 movements · 30 minutes.', effect: 'Read example only. No account data is retrieved.' }),
  change: Object.freeze({ category: 'plans', title: 'Review a plan change', detail: 'Fictional plan: Full-body foundations. Proposed name: Friday foundations.', effect: 'Change example only. Confirming reviews this proposal; it does not change a plan.' }),
});
const scenarios = Object.freeze({ disconnected: 'No account is connected.', unavailable: 'The provider connection is unavailable.', error: 'Fictional connection error. No request was sent. Clear the example to start again.' });
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fresh = () => ({ providerStatus: 'unavailable', scenario: 'disconnected', selected: [], request: 'workouts', pending: null, receipt: null, message: '' });
const copy = value => JSON.parse(JSON.stringify(value));

export function createConnectionsReview() {
  let state = fresh();
  let sequence = 0;
  const snapshot = () => copy(state);
  const invalidate = () => { state.pending = null; state.receipt = null; };
  function perform(action, value) {
    if (action === 'clear') { state = fresh(); state.message = 'Local choices and review cleared. No provider permission was changed.'; }
    else if (action === 'category') {
      if (!value || !Object.hasOwn(categories, value.category) || typeof value.selected !== 'boolean') return snapshot();
      state.selected = Object.keys(categories).filter(category => category === value.category ? value.selected : state.selected.includes(category));
      invalidate(); state.message = 'Local data choices updated. Review the request again.';
    } else if (action === 'request') {
      if (!Object.hasOwn(requests, value)) return snapshot();
      state.request = value; invalidate(); state.message = '';
    } else if (action === 'scenario') {
      if (!Object.hasOwn(scenarios, value)) return snapshot();
      state.scenario = value; invalidate(); state.message = '';
    } else if (action === 'review') {
      if (!state.selected.includes(requests[state.request].category)) {
        invalidate(); state.message = 'Choose the data category needed for this example first.';
      } else {
        // A review ID is local deduplication only, never a server idempotency key.
        state.pending ??= { id: `local-review-${++sequence}`, request: state.request };
        state.receipt = null; state.message = 'Check the fictional request below before confirming the local review.';
      }
    } else if (action === 'cancel') {
      invalidate(); state.message = 'Review cancelled. Nothing was sent or changed.';
    } else if (action === 'confirm') {
      if (!state.pending || state.pending.id !== value || !state.selected.includes(requests[state.pending.request].category)) return snapshot();
      state.receipt = { ...state.pending, outcome: 'reviewed-locally', dispatched: false, persisted: false };
      state.pending = null; state.message = 'Local review confirmed. No request sent, OAuth permission granted, or workout changed.';
    }
    return snapshot();
  }
  return Object.freeze({ snapshot, perform, reset() { state = fresh(); return snapshot(); } });
}

const button = (action, text, disabled = false, value = '') => `<button type="button" data-connections-action="${action}" data-connections-value="${escape(value)}"${disabled ? ' disabled' : ''}>${text}</button>`;

export function renderConnections(state = fresh()) {
  const request = requests[state.request] ?? requests.workouts;
  const selected = Array.isArray(state.selected) ? state.selected.filter(key => Object.hasOwn(categories, key)) : [];
  return `<section class="connections" aria-label="Connections and local request review">
    <header class="connections-intro"><p class="connections-eyebrow">YOUR CONNECTIONS</p><h2>Choose what you share.</h2><p>Explore how a request review could work, using fictional data. Your Form account stays separate.</p></header>
    <div class="connections-provider"><div><h3>Form in ChatGPT</h3><p>No account connected · provider unavailable</p></div><span class="connections-badge">Not available</span></div>
    <p class="connections-boundary">Local demonstration only. These choices are not OAuth scopes or an access grant. Nothing is sent or saved, and no connection is activated.</p>
    <div class="connections-grid"><section class="connections-card"><h3>1. Choose data for the example</h3><p>Start with nothing selected. Choose only what this request needs.</p><fieldset><legend>Local data categories</legend>${Object.entries(categories).map(([key, label]) => `<label class="connections-check"><input type="checkbox" data-connections-category="${key}"${selected.includes(key) ? ' checked' : ''}><span>${label}</span></label>`).join('')}</fieldset><p class="connections-small">Profile, injury details, microphone audio and payments are excluded from these examples.</p></section>
    <section class="connections-card"><h3>2. Choose a fictional request</h3><label>Request example<select data-connections-field="request">${Object.entries(requests).map(([key, item]) => `<option value="${key}"${state.request === key ? ' selected' : ''}>${item.title}</option>`).join('')}</select></label><p>${request.detail}</p><p class="connections-small">Needs: ${categories[request.category]} only.</p>${button('review', 'Review fictional request', !selected.includes(request.category))}</section></div>
    <div class="connections-notice" role="status" aria-live="polite">${escape(state.message)}</div>
    ${state.pending ? `<section class="connections-review" aria-label="Fictional request to review"><p class="connections-eyebrow">NOT SENT</p><h3>${request.title}</h3><p>${request.detail}</p><p>${request.effect}</p><p>Data included in this example: ${categories[request.category]}. Other selected categories are not included.</p><p class="connections-small">Reference ${escape(state.pending.id)} · local to this view</p><div class="connections-actions">${button('confirm', 'Confirm local review', false, state.pending.id)}${button('cancel', 'Cancel review')}</div></section>` : ''}
    ${state.receipt ? `<section class="connections-receipt" aria-label="Local review receipt"><h3>Reviewed in this view</h3><p>${escape(requests[state.receipt.request]?.title)}</p><p>Reference ${escape(state.receipt.id)} · no dispatch · no change to Form</p><p class="connections-small">This is a temporary review receipt, not a persisted audit record or proof of a provider action. Repeating the same confirmation does not create another receipt.</p></section>` : ''}
    <div class="connections-actions">${button('clear', 'Clear local consent and review')}</div>
    <details class="connections-states"><summary>Explore connection states</summary><label>Fictional display state<select data-connections-field="scenario">${Object.keys(scenarios).map(key => `<option value="${key}"${state.scenario === key ? ' selected' : ''}>${key[0].toUpperCase() + key.slice(1)}</option>`).join('')}</select></label><p>${scenarios[state.scenario] ?? scenarios.unavailable}</p><p class="connections-small">Changing this display does not contact a provider. The actual connection remains unavailable.</p></details>
    <footer class="connections-footer"><h3>Looking for an API?</h3><p>No public API is offered on this website. Account linking and external writes are not available here.</p></footer>
  </section>`;
}

export function mountConnections(root, { readAccount, runtimeQualified } = {}) {
  if (!root || typeof root.addEventListener !== 'function' || typeof root.removeEventListener !== 'function') throw new TypeError('A Connections root is required.');
  const review = createConnectionsReview();
  let destroyed = false;
  function context() {
    if (runtimeQualified !== false || typeof readAccount !== 'function') return null;
    try {
      const value = readAccount();
      return value?.synthetic === true && typeof value.accountId === 'string' && value.accountId.length > 0 &&
        Number.isSafeInteger(value.generation) && value.generation >= 0 ? JSON.stringify([value.accountId, value.generation]) : null;
    } catch { return null; }
  }
  let identity = context();
  function reconcile() {
    const next = context();
    if (next !== identity) { review.reset(); identity = next; }
    return identity !== null;
  }
  function paint(focusSelector) {
    const open = root.querySelector?.('.connections-states')?.open;
    root.innerHTML = renderConnections(review.snapshot());
    if (!identity) {
      root.innerHTML = '<section class="connections"><h2>Connections unavailable</h2><p>No connection is active. Local review is available only in the fictional sample account.</p></section>';
    }
    if (open) { const details = root.querySelector?.('.connections-states'); if (details) details.open = true; }
    if (focusSelector) root.querySelector?.(focusSelector)?.focus();
  }
  function perform(action, value) {
    if (destroyed) return review.snapshot();
    if (!reconcile()) { review.reset(); paint(); return review.snapshot(); }
    const state = review.perform(action, value);
    let focus = null;
    if (action === 'category' && Object.hasOwn(categories, value?.category)) focus = `[data-connections-category="${value.category}"]`;
    if (action === 'request' || action === 'scenario') focus = `[data-connections-field="${action}"]`;
    if (action === 'review') focus = state.pending ? '[data-connections-action="confirm"]' : '[data-connections-action="review"]';
    if (action === 'cancel' || action === 'confirm') focus = '[data-connections-action="review"]';
    if (action === 'clear') focus = '[data-connections-action="clear"]';
    paint(focus); return state;
  }
  const click = event => {
    const target = event.target?.closest?.('[data-connections-action]');
    if (!target || !root.contains(target) || target.disabled) return;
    event.preventDefault(); event.stopPropagation();
    perform(target.dataset.connectionsAction, target.dataset.connectionsValue);
  };
  const change = event => {
    const target = event.target;
    if (!target || !root.contains(target)) return;
    if (target.dataset?.connectionsCategory) perform('category', { category: target.dataset.connectionsCategory, selected: target.checked });
    else if (['request', 'scenario'].includes(target.dataset?.connectionsField)) perform(target.dataset.connectionsField, target.value);
  };
  root.addEventListener('click', click); root.addEventListener('change', change); paint();
  return Object.freeze({ snapshot() { if (!destroyed) { const prior = identity; reconcile(); if (prior !== identity) paint(); } return review.snapshot(); },
    accountChanged() { if (!destroyed) { review.reset(); identity = context(); paint(); } return review.snapshot(); },
    dispose() { if (destroyed) return; destroyed = true; root.removeEventListener('click', click); root.removeEventListener('change', change); review.reset(); root.innerHTML = ''; },
  });
}
