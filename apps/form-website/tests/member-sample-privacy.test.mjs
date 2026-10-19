import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createMemberPrivacyController, mountMemberPrivacy } from '../public/member-sample/privacy-flow.mjs';

const sample = (accountId = 'fictional-a', generation = 1) => ({ synthetic: true, kind: 'sample', accountId, generation });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

// This event target drives the shipped mount handlers; it performs no browser, file, network or storage I/O.
class Root {
  innerHTML = '';
  listeners = new Map();
  confirmButton = { disabled: true };
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  removeEventListener(type, listener) { if (this.listeners.get(type) === listener) this.listeners.delete(type); }
  contains(target) { return target?.owner === this; }
  querySelector(selector) { return selector === '[data-privacy-action="confirm-delete"]' ? this.confirmButton : null; }
  async emit(type, target) { await this.listeners.get(type)?.({ target }); }
  async click(action, extra = {}) {
    assert.ok(this.innerHTML.includes(`data-privacy-action="${action}"`), `rendered control ${action}`);
    const target = { owner: this, dataset: { privacyAction: action }, disabled: false, ...extra };
    target.closest = () => target;
    await this.emit('click', target);
  }
  async choose(scenario) {
    await this.emit('change', { owner: this, value: scenario, matches: selector => selector === '[data-privacy-scenario]' });
  }
  async type(value) {
    await this.emit('input', { owner: this, value, matches: selector => selector === '[data-privacy-confirmation]' });
  }
}

function mount(options = {}) {
  const root = new Root(), downloads = [], deletions = [];
  let account = sample();
  const ui = mountMemberPrivacy({ root, readAccount: () => account,
    onSampleDeleted: context => { deletions.push(context); }, downloadSample: text => downloads.push(JSON.parse(text)), ...options });
  return { root, ui, downloads, deletions, change(value, notify = true) { account = value; if (notify) ui.accountChanged(); } };
}
async function exportSample(f) { await f.root.click('reauth-export'); await f.root.click('export'); }
async function confirmSample(f) {
  await f.root.click('request-delete'); await f.root.click('reauth-delete');
  await f.root.type('DELETE SAMPLE'); await f.root.click('confirm-delete');
}

test('mounted sample export previews fictional incomplete data and downloads only on an explicit click', async () => {
  const f = mount();
  assert.match(f.root.innerHTML, /Sample receipt in memory only/);
  assert.match(f.root.innerHTML, /No production persistence or recovery guarantee/);
  await f.root.click('export');
  assert.equal(f.ui.snapshot().exportPreview, null);
  await exportSample(f);
  assert.equal(f.downloads.length, 0);
  const preview = f.ui.snapshot().exportPreview;
  assert.equal(preview.synthetic, true); assert.equal(preview.complete, false);
  assert.deepEqual(preview.omissions, ['Other account categories', 'External providers', 'Backups', 'Native device copies']);
  preview.records.length = 0;
  assert.equal(f.ui.snapshot().exportPreview.records.length, 1);
  await f.root.click('download');
  assert.equal(f.downloads.length, 1); assert.equal(f.downloads[0].complete, false);
  assert.match(f.ui.snapshot().message, /saved file is not confirmed/);
  f.ui.dispose();
});

test('lost export consumes its grant before waiting and holds all commands with no automatic or manual retry', async () => {
  const pending = deferred(), operations = [];
  const f = mount({ settle: operation => { operations.push(operation); return pending.promise; } });
  await f.root.choose('lost-export-response'); await f.root.click('reauth-export');
  const action = f.root.click('export');
  assert.equal(f.ui.snapshot().exportConsumed, true); assert.equal(f.ui.snapshot().grant, null);
  await f.root.click('export');
  pending.resolve(); await action;
  assert.equal(f.ui.snapshot().phase, 'unknown'); assert.equal(f.ui.snapshot().held, true);
  await f.root.choose('normal'); await f.root.click('reauth-export'); await f.root.click('export');
  await f.root.click('request-delete'); await f.root.click('reconcile');
  assert.deepEqual(operations, ['export']); assert.equal(f.ui.snapshot().scenario, 'lost-export-response');
  assert.equal(f.ui.snapshot().exportPreview, null); assert.equal(f.ui.snapshot().receipt, null);
  assert.equal(f.downloads.length, 0); assert.equal(f.deletions.length, 0);
  assert.match(f.ui.snapshot().message, /Do not retry/);
  f.ui.dispose();
});

test('lost deletion reconciles the original retained identity and notifies the fixture once', async () => {
  const calls = [];
  const f = mount({ settle: (operation, context) => { calls.push({ operation, ...context }); } });
  await f.root.choose('lost-deletion-response');
  await confirmSample(f);
  assert.equal(f.ui.snapshot().phase, 'unknown'); assert.equal(f.deletions.length, 0);
  const original = f.ui.snapshot().receipt;
  assert.match(original.requestId, /^fictional-/); assert.equal(original.complete, false);
  assert.equal(calls[0].operation, 'initiate');
  assert.equal(calls[0].receipt.requestId, original.requestId);
  assert.equal(calls[0].receipt.commandKey, original.commandKey);
  await f.root.click('request-delete'); await f.root.click('confirm-delete');
  assert.equal(calls.length, 2);
  await f.root.click('reconcile');
  assert.equal(calls[2].operation, 'status');
  assert.deepEqual(calls[2].receipt, original);
  assert.equal(f.ui.snapshot().receipt.requestId, original.requestId);
  assert.equal(f.ui.snapshot().receipt.disabled, true); assert.equal(f.ui.snapshot().receipt.complete, false);
  assert.deepEqual(f.deletions, [sample()]);
  await f.root.click('reconcile'); assert.equal(f.deletions.length, 1);
  assert.deepEqual(calls.map(call => call.operation), ['initiate', 'confirm', 'status', 'status']);
  f.ui.dispose();
});

test('normal deletion requires purpose-bound unexpired simulated permission and exact confirmation', async () => {
  let time = 0;
  const f = mount({ now: () => time });
  await f.root.click('reauth-export'); await f.root.click('request-delete');
  assert.equal(f.ui.snapshot().grant, null);
  await f.root.type('DELETE SAMPLE'); await f.root.click('confirm-delete');
  assert.equal(f.deletions.length, 0);
  await f.root.click('reauth-delete'); time = 300_000;
  await f.root.click('confirm-delete'); assert.equal(f.deletions.length, 0);
  assert.match(f.ui.snapshot().message, /permission expired/);
  await f.root.click('reauth-delete'); await f.root.type('DELETE');
  assert.equal(f.root.confirmButton.disabled, true);
  await f.root.click('confirm-delete'); assert.equal(f.deletions.length, 0);
  const htmlBeforeTyping = f.root.innerHTML;
  await f.root.type('DELETE SAMPLE');
  assert.equal(f.root.innerHTML, htmlBeforeTyping, 'typing must preserve the focused element');
  assert.equal(f.root.confirmButton.disabled, false);
  await f.root.click('confirm-delete');
  assert.equal(f.deletions.length, 1); assert.equal(f.ui.snapshot().complete, false);
  assert.match(f.ui.snapshot().message, /billing cancellation was not performed/);
  f.ui.dispose();
});

test('accountChanged synchronously clears receipts and rejects late confirmation, including the same account with a new generation', async () => {
  for (const next of [sample('fictional-b'), sample('fictional-a', 2), null]) {
    const pending = deferred();
    const f = mount({ settle: operation => operation === 'confirm' ? pending.promise : undefined });
    await f.root.click('request-delete'); await f.root.click('reauth-delete'); await f.root.type('DELETE SAMPLE');
    const action = f.root.click('confirm-delete');
    assert.equal(f.ui.snapshot().message, 'Confirming fictional deletion…');
    f.change(next);
    assert.equal(f.ui.snapshot().receipt, null); assert.equal(f.ui.snapshot().confirmation, '');
    assert.equal(f.ui.snapshot().grant, null); assert.equal(f.ui.snapshot().busy, false);
    assert.match(f.ui.snapshot().message, /recovery receipt was discarded/);
    pending.resolve(); await action;
    assert.equal(f.ui.snapshot().receipt, null); assert.equal(f.deletions.length, 0);
    assert.deepEqual(f.ui.snapshot().account, next);
    f.ui.dispose();
  }
});

test('late export is discarded on observed account change even before the parent hook runs', async () => {
  const pending = deferred();
  const f = mount({ settle: () => pending.promise });
  await f.root.click('reauth-export'); const action = f.root.click('export');
  f.change(sample('fictional-b'), false);
  pending.resolve(); await action;
  assert.equal(f.ui.snapshot().exportPreview, null); assert.equal(f.ui.snapshot().grant, null);
  assert.match(f.root.innerHTML, /workflow cleared/);
  f.ui.dispose();
});

test('late status failure cannot overwrite a new account or release its workflow hold', async () => {
  const pending = deferred();
  const f = mount({ settle: operation => operation === 'status' ? pending.promise : undefined });
  await f.root.choose('lost-deletion-response'); await confirmSample(f);
  const action = f.root.click('reconcile');
  f.change(sample('fictional-b'));
  await f.root.choose('lost-export-response'); await exportSample(f);
  const before = f.ui.snapshot();
  pending.reject(Error('old status failed')); await action;
  assert.deepEqual(f.ui.snapshot(), before); assert.equal(f.deletions.length, 0);
  f.ui.dispose();
});

test('parent fixture clear during callback cannot restore an old receipt and dispose removes handlers and rejects pending results', async () => {
  let f;
  f = mount({ onSampleDeleted: (target, { isCurrent }) => {
    assert.deepEqual(target, sample()); assert.equal(isCurrent(), true);
    f.change(null); assert.equal(isCurrent(), false);
  } });
  await confirmSample(f);
  assert.equal(f.ui.snapshot().receipt, null); assert.equal(f.ui.snapshot().account, null);
  f.ui.dispose(); assert.equal(f.root.listeners.size, 0); assert.equal(f.root.innerHTML, '');
  const pending = deferred(), next = mount({ settle: () => pending.promise });
  await next.root.click('reauth-export'); const action = next.root.click('export');
  next.ui.dispose(); pending.resolve(); await action;
  assert.equal(next.ui.snapshot().phase, 'disposed'); assert.equal(next.ui.snapshot().exportPreview, null);
  assert.equal(next.root.innerHTML, ''); assert.equal(next.root.listeners.size, 0);
});

test('failure reconciliation preserves receipt; fixture callback errors never cause repeated cleanup', async () => {
  let failInitiate = true, callbacks = 0;
  const f = mount({ settle: operation => { if (operation === 'initiate' && failInitiate) throw Error('lost'); },
    onSampleDeleted: () => { callbacks++; throw Error('cleanup unknown'); } });
  await f.root.click('request-delete');
  const original = f.ui.snapshot().receipt.requestId;
  assert.equal(f.ui.snapshot().held, true);
  failInitiate = false; await f.root.click('reconcile');
  assert.equal(f.ui.snapshot().receipt.requestId, original);
  await f.root.click('reauth-delete'); await f.root.type('DELETE SAMPLE'); await f.root.click('confirm-delete');
  assert.equal(callbacks, 1); assert.match(f.ui.snapshot().message, /cleanup could not be confirmed/);
  await f.root.click('reconcile'); assert.equal(callbacks, 1);
  assert.equal(f.ui.snapshot().cleanupUnknown, true); assert.equal(f.ui.snapshot().held, true);
  assert.match(f.ui.snapshot().message, /cleanup is still unknown/);
  f.ui.dispose();
});

test('non-sample contexts cannot enter the workflow; exported account text is escaped', async () => {
  for (const invalid of [null, { ...sample(), synthetic: false }, { ...sample(), kind: 'real' },
    { accountId: 'real', generation: 1 }, { ...sample(), generation: NaN }]) {
    const f = mount({ readAccount: () => invalid });
    await f.root.click('reauth-export'); await f.root.click('request-delete');
    assert.equal(f.ui.snapshot().phase, 'unavailable'); assert.equal(f.ui.snapshot().receipt, null);
    f.ui.dispose();
  }
  const f = mount(); f.change(sample('<img src=x onerror=bad>'));
  await exportSample(f); assert.doesNotMatch(f.root.innerHTML, /<img/); assert.match(f.root.innerHTML, /&lt;img/);
  f.ui.dispose();
});

test('download error stays honest and module has no transport, persistent storage or real secret input', async () => {
  const f = mount({ downloadSample: () => { throw Error('unavailable'); } });
  await exportSample(f); await f.root.click('download');
  assert.match(f.ui.snapshot().message, /could not be requested/); f.ui.dispose();
  const source = readFileSync(new URL('../public/member-sample/privacy-flow.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\b(?:fetch|XMLHttpRequest|WebSocket|localStorage|sessionStorage|indexedDB|sendBeacon)\b|\/v1\//);
  assert.doesNotMatch(source, /type="password"|statusSecret/);
});

test('controller ignores attempts to mutate its returned receipt or change scenario during a held operation', async () => {
  const controller = createMemberPrivacyController({ readAccount: () => sample() });
  await controller.perform('request-delete');
  const receipt = controller.snapshot().receipt; receipt.requestId = 'replacement';
  await controller.perform('scenario', 'lost-export-response');
  assert.notEqual(controller.snapshot().receipt.requestId, 'replacement');
  assert.equal(controller.snapshot().scenario, 'normal'); controller.dispose();
});
