import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createConnectionsReview, renderConnections, mountConnections } from '../public/member-ecosystem/connections.mjs';

const choose = (review, category = 'workouts') => review.perform('category', { category, selected: true });

test('review starts with no permission and cannot confirm without a selected category and exact request', () => {
  const review = createConnectionsReview();
  assert.deepEqual(review.snapshot().selected, []);
  assert.equal(review.perform('review').pending, null);
  assert.equal(review.perform('confirm', 'invented').receipt, null);
  choose(review);
  const pending = review.perform('review').pending;
  assert.equal(review.perform('confirm', 'wrong').receipt, null);
  const result = review.perform('confirm', pending.id);
  assert.equal(result.receipt.outcome, 'reviewed-locally');
  assert.equal(result.receipt.dispatched, false);
  assert.equal(result.receipt.persisted, false);
  assert.deepEqual(review.perform('confirm', pending.id), result);
});

test('changing permission, request or scenario invalidates review; cancellation and clear remove receipts', () => {
  for (const [action, value] of [['category', { category: 'workouts', selected: false }], ['request', 'plans'], ['scenario', 'error'], ['cancel'], ['clear']]) {
    const review = createConnectionsReview(); choose(review);
    const pending = review.perform('review').pending;
    review.perform(action, value);
    assert.equal(review.perform('confirm', pending.id).receipt, null);
    assert.equal(review.snapshot().pending, null);
  }
  const review = createConnectionsReview(); choose(review);
  review.perform('confirm', review.perform('review').pending.id);
  assert.deepEqual(review.perform('clear').selected, []);
  assert.equal(review.snapshot().receipt, null);
});

test('reset cannot recycle an old confirmation and snapshots cannot mutate held state', () => {
  const review = createConnectionsReview(); choose(review);
  const old = review.perform('review').pending.id;
  review.reset(); choose(review);
  const current = review.perform('review').pending.id;
  assert.notEqual(old, current);
  assert.equal(review.perform('confirm', old).receipt, null);
  const snapshot = review.snapshot(); snapshot.selected.length = 0; snapshot.pending.id = 'forged';
  assert.equal(review.snapshot().pending.id, current);
  assert.deepEqual(review.snapshot().selected, ['workouts']);
});

test('write example remains local and excludes extra selected data', () => {
  const review = createConnectionsReview(); choose(review); choose(review, 'plans');
  review.perform('request', 'change');
  const html = renderConnections(review.perform('review'));
  assert.match(html, /Data included in this example: Saved plans\. Other selected categories are not included/);
  assert.match(html, /does not change a plan/);
  assert.match(html, /Confirm local review/);
  assert.doesNotMatch(html, /\/v1\/|form:.*:write/);
});

class Root {
  innerHTML = '';
  listeners = new Map();
  addEventListener(name, fn) { this.listeners.set(name, fn); }
  removeEventListener(name, fn) { if (this.listeners.get(name) === fn) this.listeners.delete(name); }
  contains() { return true; }
  querySelector() { return null; }
  category(category, selected = true) { this.listeners.get('change')?.({ target: { dataset: { connectionsCategory: category }, checked: selected } }); }
  click(action, value = '') {
    const target = { dataset: { connectionsAction: action, connectionsValue: value }, disabled: false };
    this.listeners.get('click')?.({ target: { closest: () => target }, preventDefault() {}, stopPropagation() {} });
  }
}

test('mount requires explicitly synthetic context and refuses runtime-qualified use', () => {
  for (const options of [{}, { runtimeQualified: true, readAccount: () => ({ synthetic: true, accountId: 'sample', generation: 0 }) }, { runtimeQualified: false, readAccount: () => ({ accountId: 'real', generation: 0 }) }]) {
    const root = new Root(); const mounted = mountConnections(root, options);
    root.category('workouts'); root.click('review');
    assert.equal(mounted.snapshot().pending, null);
    assert.match(root.innerHTML, /Connections unavailable/);
    mounted.dispose();
  }
});

test('account lifecycle clears state and late confirmation cannot cross identities', () => {
  let account = { synthetic: true, accountId: 'sample', generation: 0 };
  const root = new Root(); const mounted = mountConnections(root, { runtimeQualified: false, readAccount: () => account });
  root.category('workouts'); root.click('review');
  const id = mounted.snapshot().pending.id;
  account = { ...account, generation: 1 };
  root.click('confirm', id);
  assert.equal(mounted.snapshot().receipt, null);
  assert.deepEqual(mounted.snapshot().selected, []);
  root.category('plans'); mounted.accountChanged();
  assert.deepEqual(mounted.snapshot().selected, []);
  account = null; mounted.snapshot();
  assert.match(root.innerHTML, /Connections unavailable/);
  mounted.dispose(); mounted.dispose();
  assert.equal(root.listeners.size, 0); assert.equal(root.innerHTML, '');
});

test('all display scenarios keep actual provider unavailable and escape notice text', () => {
  const review = createConnectionsReview();
  for (const scenario of ['disconnected', 'unavailable', 'error']) {
    const state = review.perform('scenario', scenario);
    assert.equal(state.providerStatus, 'unavailable');
    assert.match(renderConnections(state), /provider unavailable/);
  }
  assert.match(renderConnections({ ...review.snapshot(), message: '<script>bad()</script>' }), /&lt;script&gt;/);
});

test('browser module exposes no provider transport, credential, storage or route-list dependency', () => {
  const source = readFileSync(new URL('../public/member-ecosystem/connections.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\b(?:fetch|XMLHttpRequest|WebSocket|localStorage|sessionStorage|indexedDB|sendBeacon)\b|\/v1\//);
  assert.doesNotMatch(source, /^import\s/m);
});
