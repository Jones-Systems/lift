import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mountApplication } from '../public/application-ui.mjs';
import { createSampleTransport } from '../public/member-sample/sample-transport.mjs';
import { mountMemberSample, renderMemberFrame, renderSamplePremium } from '../public/member-sample/member-shell.mjs';
import { mountSamplePage } from '../public/member-sample/sample-entry.mjs';

class Target {
  listeners = new Map(); innerHTML = ''; textContent = ''; hidden = false;
  addEventListener(type, handler) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(handler); }
  removeEventListener(type, handler) { this.listeners.get(type)?.delete(handler); }
  async emit(type, event = {}) { for (const handler of [...(this.listeners.get(type) ?? [])]) await handler(event); }
  contains(node) { return node?.owner === this; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  count() { return [...this.listeners.values()].reduce((sum, values) => sum + values.size, 0); }
}
class Root extends Target {
  slots = Object.fromEntries(['application', 'premium', 'coach', 'connections', 'privacy', 'notice', 'resume'].map(name => [name, new Target()]));
  querySelector(selector) { return this.slots[selector.match(/^\[data-member-(.*)\]$/)?.[1]] ?? null; }
}
const deferred = () => { let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; };
const flush = async () => { for (let index = 0; index < 8; index++) await Promise.resolve(); };
function mounted(options = {}) {
  const root = new Root(), page = new Target(), visibility = new Target(); let visible = 'visible', app;
  const transport = createSampleTransport({ now: () => Date.parse('2026-10-18T12:00:00.000Z'), seed: 53 });
  const ui = mountMemberSample({ root, transport, pageTarget: page, visibilityTarget: visibility, readVisibility: () => visible,
    mountApplicationPort: ports => { app = mountApplication(ports); return app; }, ...options });
  return { ui, root, page, visibility, transport, app: () => app,
    async hide() { visible = 'hidden'; await visibility.emit('visibilitychange'); },
    async show() { visible = 'visible'; await visibility.emit('visibilitychange'); } };
}

test('member frame provides persistent fictional disclosure, navigation and honest scenario controls', () => {
  const html = renderMemberFrame();
  assert.match(html, /role="note"/); assert.match(html, /nothing is saved/); assert.match(html, /not a real sign-in/);
  for (const label of ['Workout', 'Plan', 'Data', 'Settings', 'Premium', 'Coach', 'Connections', 'Journal']) assert.ok(html.includes(label));
  assert.match(html, /href="\/app\/journal\/"/); assert.match(html, /lost-write-response/);
  assert.doesNotMatch(html, /type="(?:email|password)"/);
});

test('shell mounts the unmodified application, retains Profile controls and wipes drafts on switch', async () => {
  const m = mounted(); await m.ui.ready;
  assert.match(m.root.slots.application.innerHTML, /Sample full-body session/);
  await m.ui.perform('navigate', 'settings');
  assert.match(m.root.slots.application.innerHTML, /Load profile/);
  await m.app().perform('equipment-add', { equipment: ['Unsaved fictional draft'] });
  assert.match(m.root.slots.application.innerHTML, /Unsaved fictional draft/);
  const before = m.ui.session.readAccount();
  await m.ui.perform('switch'); await m.ui.perform('navigate', 'settings');
  assert.doesNotMatch(m.root.slots.application.innerHTML, /Unsaved fictional draft/);
  assert.notEqual(before.accountId, m.ui.session.readAccount().accountId);
  assert.match(m.root.innerHTML, /Fictional sample account/);
  await m.ui.dispose(); assert.equal(m.page.count(), 0); assert.equal(m.visibility.count(), 0);
});

test('premium derives active, inactive/revoked and unknown state with all purchase actions disabled', async () => {
  const m = mounted(); await m.ui.ready; await m.ui.perform('navigate', 'premium');
  assert.match(m.root.slots.premium.innerHTML, /data-membership-state="inactive-or-revoked"/);
  await m.ui.perform('plus');
  assert.match(m.root.slots.premium.innerHTML, /data-membership-state="active"/);
  await m.ui.perform('scenario', 'revoked-membership');
  assert.match(m.root.slots.premium.innerHTML, /data-membership-state="revoked"/);
  assert.match(m.root.slots.premium.innerHTML, /<button disabled>Checkout/);
  assert.match(m.root.slots.premium.innerHTML, /<button disabled>Restore/);
  assert.match(m.root.slots.premium.innerHTML, /<button disabled>Cancel/);
  await m.ui.perform('signout');
  assert.match(renderSamplePremium(m.ui.session.snapshot()), /data-membership-state="unknown"/);
  assert.equal(m.ui.session.readAccount(), null); await m.ui.dispose();
});

test('Coach slot remains stable on ordinary repaint; view exit retires async mount and mounted handle', async () => {
  const loading = deferred(); let mounts = 0, stops = 0, captured;
  const m = mounted({ loadCoach: () => loading.promise }); await m.ui.ready;
  await m.ui.perform('navigate', 'coach');
  await m.ui.perform('navigate', 'plans');
  loading.resolve({ mountMemberCoach(ports) { mounts++; captured = ports; return { accountChanged() {}, dispose() { stops++; } }; } });
  await flush(); assert.equal(mounts, 0);
  await m.ui.perform('navigate', 'coach'); await flush(); assert.equal(mounts, 1);
  const account = captured.readAccount(); assert.notEqual(account.authSessionId, account.accountId);
  await m.ui.session.plans(); await flush(); assert.equal(mounts, 1); assert.equal(stops, 0);
  await m.ui.perform('navigate', 'premium'); assert.equal(stops, 1);
  await m.ui.dispose();
});

test('delayed Coach cleanup does not block navigation, and final disposal waits for its completion', async () => {
  const cleanup = deferred(); let stops = 0, mounts = 0;
  const m = mounted({ loadCoach: async () => ({ mountMemberCoach() {
    mounts++; return { accountChanged() {}, dispose() { stops++; return cleanup.promise; } };
  } }) }); await m.ui.ready;
  await m.ui.perform('navigate', 'coach'); await flush();
  await m.ui.perform('navigate', 'premium');
  assert.equal(stops, 1); assert.equal(m.root.slots.premium.hidden, false);
  assert.equal(m.ui.snapshot().cleanupPending, 1);
  await m.ui.perform('navigate', 'coach'); await flush();
  assert.equal(mounts, 2); // The real Coach module's shared gate owns replacement-capture admission.
  let completed = false; const disposal = m.ui.dispose().then(() => { completed = true; });
  await flush(); assert.equal(completed, false); assert.equal(m.root.innerHTML, '');
  cleanup.resolve({ cleanup: 'complete' }); await disposal;
  assert.equal(m.ui.snapshot().cleanupPending, 0);
});

test('Coach cleanup rejection and fulfilled incomplete cleanup are reported without claiming disposal', async () => {
  for (const outcome of ['rejected', 'incomplete']) {
    const cleanup = deferred();
    const m = mounted({ loadCoach: async () => ({ mountMemberCoach: () => ({ accountChanged() {}, dispose: () => cleanup.promise }) }) });
    await m.ui.ready; await m.ui.perform('navigate', 'coach'); await flush();
    await m.ui.perform('navigate', 'premium');
    if (outcome === 'rejected') cleanup.reject(new Error('fixture_cleanup_failed'));
    else cleanup.resolve({ cleanup: 'incomplete' });
    await flush(); assert.equal(m.ui.snapshot().cleanupFailed, true);
    assert.match(m.root.slots.notice.textContent, /cleanup could not be confirmed/);
    await assert.rejects(m.ui.dispose(), /member_cleanup_unconfirmed/);
  }
});

test('Connections and privacy receive synthetic account ports and are retired across account transitions', async () => {
  let connectionPorts, privacyPorts, stopped = 0, changed = 0;
  const handle = () => ({ accountChanged() { changed++; }, dispose() { stopped++; } });
  const m = mounted({ mountConnectionsPort(root, ports) { connectionPorts = ports; return handle(); },
    loadPrivacy: async () => ({ mountMemberPrivacy(ports) { privacyPorts = ports; return handle(); } }) });
  await m.ui.ready; await m.ui.perform('navigate', 'connections');
  assert.equal(connectionPorts.runtimeQualified, false);
  assert.equal(connectionPorts.readAccount().synthetic, true);
  await m.ui.perform('navigate', 'data'); await flush();
  assert.equal(privacyPorts.readAccount().kind, 'sample');
  assert.match(m.root.slots.application.innerHTML, /Showing only this loaded page/);
  const previous = changed; await m.ui.session.stats();
  assert.equal(changed, previous, 'ordinary data read must not erase privacy recovery');
  await privacyPorts.onSampleDeleted();
  assert.equal(m.ui.session.snapshot().status, 'anonymous');
  assert.equal(privacyPorts.readAccount(), null); assert.ok(stopped >= 2); assert.ok(changed > previous);
  await m.ui.dispose();
});

test('hidden and pagehide suspend all member actions until explicit visible resume without requests', async () => {
  const m = mounted(); await m.ui.ready;
  await m.ui.perform('navigate', 'premium');
  const requests = m.transport.calls.length;
  await m.hide(); assert.equal(m.root.slots.premium.hidden, true);
  await assert.rejects(m.ui.perform('reset'), /lifecycle_suspended/);
  await m.show(); assert.equal(m.ui.snapshot().paused, true);
  await m.ui.perform('resume'); assert.equal(m.ui.snapshot().paused, false);
  assert.equal(m.transport.calls.length, requests);
  await m.page.emit('pagehide'); await assert.rejects(m.ui.perform('resume'), /lifecycle_suspended/);
  await m.page.emit('pageshow'); await m.ui.perform('resume');
  await m.ui.dispose();
});

test('sample entry does not mount a production root or request runtime configuration', async () => {
  const calls = [];
  const value = mountSamplePage({ documentTarget: { querySelector(selector) { calls.push(selector); return null; } } });
  assert.equal(value, null); assert.deepEqual(calls, ['[data-member-sample]']);
  const production = await readFile(new URL('../public/application-entry.mjs', import.meta.url), 'utf8');
  const sample = await readFile(new URL('../public/member-sample/sample-entry.mjs', import.meta.url), 'utf8');
  const facade = await readFile(new URL('../public/member-sample/sample-session.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(production, /member-sample|createSample/);
  assert.doesNotMatch(sample + facade, /runtime-config|createConfiguredBrowserSession|localStorage|sessionStorage/);
  assert.match(facade, /createSyntheticApplicationController/);
});
