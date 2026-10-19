import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mountMemberCoach } from '../public/member-coach/coach-screen.mjs';

const identity = Object.freeze({ accountId: 'example-account', authSessionId: 'example-session', accountEpoch: 1 });
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const flush = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };
class Target {
  listeners = new Map();
  addEventListener(name, callback) { if (!this.listeners.has(name)) this.listeners.set(name, new Set()); this.listeners.get(name).add(callback); }
  removeEventListener(name, callback) { this.listeners.get(name)?.delete(callback); }
  emit(name, event = {}) { for (const callback of [...(this.listeners.get(name) ?? [])]) callback(event); }
  count() { return [...this.listeners.values()].reduce((sum, set) => sum + set.size, 0); }
}
class Root extends Target {
  innerHTML = '';
  attributes = new Map();
  fill = { style: {} };
  contains(node) { return node?.owner === this; }
  querySelector(selector) {
    if (selector === '[role="meter"]') return { setAttribute: (key, value) => this.attributes.set(key, value) };
    if (selector === '[data-coach-meter-fill]') return this.fill;
    return null;
  }
  click(action, extra = {}) {
    const attrs = { 'data-coach-action': action, ...extra };
    const target = { owner: this, disabled: false, getAttribute: key => attrs[key], closest() { return this; } };
    this.emit('click', { target });
  }
  choose(checked = true) {
    this.emit('change', { target: { owner: this, checked, getAttribute: key => key === 'data-coach-choice' ? 'local' : null } });
  }
}
function track({ kind = 'audio', stopFails = false } = {}) {
  return Object.assign(new Target(), { kind, readyState: 'live', stops: 0,
    stop() { this.stops++; if (stopFails) throw new Error('private device error'); this.readyState = 'ended'; },
    end() { this.readyState = 'ended'; this.emit('ended'); },
  });
}
const stream = (...tracks) => ({ getTracks: () => tracks });

// In-memory browser ports only: no devices, timers, file writes, sockets, network or storage.
function fixture(options = {}) {
  const root = new Root(), page = new Target(), visibility = new Target(), pending = deferred();
  let account = options.account === undefined ? identity : options.account, visible = 'visible', sequence = 0;
  const calls = [], contexts = [], timers = new Map(), frames = new Map(), subscriptions = new Set();
  const mediaDevices = options.mediaDevices ?? { getUserMedia: constraints => { calls.push(constraints); return pending.promise; } };
  class Context {
    constructor() { this.closed = 0; this.sources = []; this.analysers = []; this.destination = { speaker: true }; contexts.push(this); }
    resume() { return options.resume ? options.resume() : Promise.resolve(); }
    close() { this.closed++; return options.close ? options.close() : Promise.resolve(); }
    createMediaStreamSource(input) {
      assert.ok(input);
      const node = { connections: [], disconnected: 0, connect(other) { this.connections.push(other); }, disconnect() { this.disconnected++; } };
      this.sources.push(node); return node;
    }
    createAnalyser() {
      const node = { fftSize: 256, disconnected: 0, getFloatTimeDomainData(data) { data.fill(.5); }, disconnect() { this.disconnected++; } };
      this.analysers.push(node); return node;
    }
  }
  const ports = { root, pageTarget: page, visibilityTarget: visibility, readVisibility: () => visible,
    readAccount: () => account, subscribeAccount: callback => { subscriptions.add(callback); return () => subscriptions.delete(callback); },
    mediaDevices, secureContext: true, AudioContextClass: Context,
    setTimer: (callback, delay) => { const id = ++sequence; timers.set(id, { callback, delay }); return id; },
    clearTimer: id => timers.delete(id), requestFrame: callback => { const id = ++sequence; frames.set(id, callback); return id; },
    cancelFrame: id => frames.delete(id), ...options.ports };
  const ui = mountMemberCoach(ports);
  return { ui, root, page, visibility, pending, calls, contexts, timers, frames, mediaDevices, ports, subscriptions,
    choose: () => root.choose(), start: () => root.click('mic-start'),
    setAccount(value, notify = true) { account = value; if (notify) for (const callback of subscriptions) callback(); },
    hide() { visible = 'hidden'; visibility.emit('visibilitychange'); },
    tick() { const current = [...frames]; frames.clear(); for (const [, callback] of current) callback(); },
    expire() { const current = [...timers]; timers.clear(); for (const [, { callback }] of current) callback(); },
  };
}
async function listening(f, ...tracks) {
  f.choose(); f.start(); f.pending.resolve(stream(...tracks)); await flush();
  assert.equal(f.ui.snapshot().micState, 'listening');
}
function released(f, tracks) {
  for (const item of tracks) { assert.equal(item.readyState, 'ended'); assert.equal(item.count(), 0); }
  for (const context of f.contexts) {
    assert.equal(context.closed, 1);
    for (const node of [...context.sources, ...context.analysers]) assert.equal(node.disconnected, 1);
  }
  assert.equal(f.frames.size, 0); assert.equal(f.timers.size, 0);
  assert.equal(f.page.count(), 0); assert.equal(f.visibility.count(), 0);
  assert.equal(f.ui.snapshot().cleanup, 'complete');
}

test('capture requires both a local-only choice and an explicit start click', async () => {
  const f = fixture();
  assert.deepEqual(f.calls, []); assert.equal(f.contexts.length, 0);
  f.start(); assert.deepEqual(f.calls, []);
  f.choose(); assert.deepEqual(f.calls, []);
  f.start(); assert.deepEqual(f.calls, [{ audio: true, video: false }]);
  assert.equal(f.ui.snapshot().micState, 'requesting');
  assert.deepEqual([...f.timers.values()].map(value => value.delay), [30_000]);
  f.pending.reject({ name: 'NotAllowedError' }); await flush(); await f.ui.dispose();
});

for (const [name, ports, state] of [
  ['insecure', { secureContext: false }, 'insecure'],
  ['missing capture API', { mediaDevices: {} }, 'unavailable'],
  ['missing audio API', { AudioContextClass: undefined }, 'unavailable'],
]) {
  test(`${name} is visibly unavailable without a permission request`, async () => {
    const f = fixture({ ports }); f.choose(); f.start();
    assert.equal(f.ui.snapshot().micState, state); assert.equal(f.ui.snapshot().canStart, false);
    assert.equal(f.calls.length, 0); assert.equal(f.contexts.length, 0);
    await f.ui.dispose();
  });
}

test('a missing account disables capture while authored examples and the demo remain useful', async () => {
  const f = fixture({ account: null }); f.choose(); f.start();
  assert.equal(f.calls.length, 0); assert.equal(f.ui.snapshot().micState, 'disconnected');
  f.root.click('example', { 'data-example': 'targets' });
  assert.match(f.root.innerHTML, /target of 8 repetitions and a confirmed set of 6/);
  f.root.click('demo-next'); assert.equal(f.ui.snapshot().operation.state, 'loading');
  await f.ui.dispose();
});

for (const [name, state] of [['NotAllowedError', 'denied'], ['NotFoundError', 'no-mic'], ['NotReadableError', 'device-busy'], ['AbortError', 'interrupted'], ['UnknownDeviceFailure', 'failed']]) {
  test(`${name} has bounded visible feedback, cleanup and no automatic retry`, async () => {
    const f = fixture(); f.choose(); f.start();
    f.pending.reject(Object.assign(new Error('PRIVATE DEVICE SERIAL'), { name })); await flush();
    assert.equal(f.ui.snapshot().micState, state); assert.doesNotMatch(f.root.innerHTML, /PRIVATE DEVICE SERIAL|UnknownDeviceFailure/);
    released(f, []); assert.equal(f.calls.length, 1);
    f.tick(); f.expire(); await flush(); assert.equal(f.calls.length, 1);
    await f.ui.dispose();
  });
}

test('RMS meter has no speaker connection; Stop synchronously ends every track and closes audio', async () => {
  const f = fixture(), audio = track(), extra = track({ kind: 'video' }); await listening(f, audio, extra);
  assert.equal(f.root.attributes.get('aria-valuenow'), '50');
  assert.deepEqual(f.contexts[0].sources[0].connections, [f.contexts[0].analysers[0]]);
  const stopped = f.ui.stop();
  assert.equal(audio.readyState, 'ended'); assert.equal(extra.readyState, 'ended');
  assert.equal(f.contexts[0].closed, 1); assert.equal(f.frames.size, 0); assert.equal(f.page.count(), 0);
  await stopped; released(f, [audio, extra]); assert.equal(f.ui.snapshot().micState, 'stopped');
  await f.ui.dispose(); assert.equal(f.root.count(), 0); assert.equal(f.subscriptions.size, 0);
});

for (const [name, trigger, state] of [
  ['timeout', f => f.expire(), 'timeout'],
  ['pagehide', f => f.page.emit('pagehide'), 'navigation'],
  ['hidden', f => f.hide(), 'hidden'],
  ['account switch', f => f.setAccount({ ...identity, accountId: 'other' }), 'account-changed'],
  ['session generation', f => f.setAccount({ ...identity, accountEpoch: 2 }), 'account-changed'],
  ['signout', f => f.setAccount(null), 'signedout'],
  ['navigation dispose', f => f.ui.dispose(), 'disposed'],
]) {
  test(`${name} immediately cancels active capture and cleans all resources`, async () => {
    const f = fixture(), audio = track(); await listening(f, audio);
    trigger(f); assert.equal(audio.readyState, 'ended'); assert.equal(f.contexts[0].closed, 1);
    await flush(); released(f, [audio]); assert.equal(f.ui.snapshot().micState, state);
    if (['account-changed', 'signedout'].includes(state)) assert.equal(f.ui.snapshot().localOnly, false);
    await f.ui.dispose(); assert.equal(f.root.count(), 0); assert.equal(f.subscriptions.size, 0);
  });
}

for (const [name, fire, state] of [['ended', audio => audio.end(), 'revoked-ended'], ['mute', audio => audio.emit('mute'), 'interrupted']]) {
  test(`${name} stops the level check without relying on track.stop emitting an event`, async () => {
    const f = fixture(), audio = track(); await listening(f, audio);
    fire(audio); await flush(); released(f, [audio]);
    assert.equal(f.ui.snapshot().micState, state); assert.equal(audio.stops, 1);
    await f.ui.dispose();
  });
}

test('cancelled permission stays owned until the same lease disposes a late grant', async () => {
  const f = fixture(), audio = track(); f.choose(); f.start();
  const stop = f.ui.stop(); let complete = false; void stop.then(() => { complete = true; });
  assert.equal(f.ui.snapshot().micState, 'cancelled-prompt'); assert.equal(f.contexts[0].closed, 1);
  f.start(); await flush(); assert.equal(f.calls.length, 1); assert.equal(complete, false);
  f.pending.resolve(stream(audio)); await stop;
  assert.equal(audio.stops, 1); released(f, [audio]); assert.equal(complete, true);
  assert.equal(f.contexts[0].sources.length, 0);
  await f.ui.dispose();
});

for (const [name, trigger] of [['navigation', f => f.page.emit('pagehide')], ['hidden', f => f.hide()], ['account', f => f.setAccount({ ...identity, authSessionId: 'new-session' })], ['signout', f => f.setAccount(null)]]) {
  test(`pending permission on ${name} cannot revive capture after late grant`, async () => {
    const f = fixture(), audio = track(); f.choose(); f.start(); trigger(f);
    assert.equal(f.contexts[0].closed, 1); f.pending.resolve(stream(audio)); await flush();
    assert.equal(audio.stops, 1); released(f, [audio]); assert.equal(f.contexts[0].sources.length, 0);
    await f.ui.dispose();
  });
}

test('dispose removes UI/subscription listeners synchronously and prevents ownership across repaint', async () => {
  const f = fixture(), audio = track(); f.choose(); f.start();
  const disposing = f.ui.dispose(); let disposed = false; void disposing.then(() => { disposed = true; });
  assert.equal(f.root.count(), 0); assert.equal(f.subscriptions.size, 0); assert.equal(f.root.innerHTML, '');
  const second = fixture({ mediaDevices: f.mediaDevices }); second.choose(); second.start();
  assert.equal(second.ui.snapshot().gateBlocked, true); assert.equal(f.calls.length, 1);
  await flush(); assert.equal(disposed, false);
  f.pending.resolve(stream(audio)); const result = await disposing;
  assert.equal(result.cleanup, 'complete'); assert.equal(audio.stops, 1);
  assert.equal(second.ui.snapshot().gateBlocked, false);
  assert.match(second.root.innerHTML, /data-coach-action="mic-start" >Start local mic check/);
  assert.equal(f.root.innerHTML, ''); await second.ui.dispose();
});

test('late rejection after cancellation completes cleanup and never opens an analyser', async () => {
  const f = fixture(); f.choose(); f.start(); const stopping = f.ui.stop();
  f.pending.reject({ name: 'NotAllowedError' }); await stopping;
  assert.equal(f.ui.snapshot().micState, 'stopped'); released(f, []);
  assert.equal(f.contexts[0].analysers.length, 0); await f.ui.dispose();
});

test('new capture is permitted only after complete cleanup and another explicit gesture', async () => {
  const captures = [deferred(), deferred()]; let requests = 0;
  const f = fixture({ mediaDevices: { getUserMedia: () => captures[requests++].promise } });
  f.choose(); f.start(); f.start(); assert.equal(requests, 1);
  const first = track(); captures[0].resolve(stream(first)); await flush(); await f.ui.stop();
  assert.equal(requests, 1); f.start(); assert.equal(requests, 2);
  const second = track(); captures[1].resolve(stream(second)); await flush(); await f.ui.dispose();
  assert.equal(first.stops, 1); assert.equal(second.stops, 1); released(f, [first, second]);
});

test('identity is checked after permission grant and each meter frame without subscription delivery', async () => {
  const f = fixture(), audio = track(); f.choose(); f.start(); f.setAccount(null, false);
  f.pending.resolve(stream(audio)); await flush();
  assert.equal(audio.stops, 1); assert.equal(f.ui.snapshot().micState, 'signedout');
  await f.ui.dispose();
  const other = fixture(), live = track(); await listening(other, live);
  other.setAccount({ ...identity, authSessionId: 'changed-without-event' }, false); other.tick(); await flush();
  assert.equal(live.stops, 1); assert.equal(other.ui.snapshot().micState, 'account-changed'); await other.ui.dispose();
});

test('audio resume failure and empty streams release capture instead of claiming listening', async () => {
  const f = fixture({ resume: () => Promise.reject(new Error('private audio failure')) }), audio = track();
  f.choose(); f.start(); f.pending.resolve(stream(audio)); await flush();
  assert.equal(f.ui.snapshot().micState, 'failed'); released(f, [audio]); await f.ui.dispose();
  const empty = fixture(); empty.choose(); empty.start(); empty.pending.resolve(stream()); await flush();
  assert.equal(empty.ui.snapshot().micState, 'no-mic'); released(empty, []); await empty.ui.dispose();
});

test('Stop closes audio and releases capture even while audio resume has not settled', async () => {
  const resume = deferred(), f = fixture({ resume: () => resume.promise }), audio = track();
  f.choose(); f.start(); f.pending.resolve(stream(audio)); await flush();
  await f.ui.stop(); released(f, [audio]); resume.resolve(); await flush();
  assert.equal(f.contexts[0].sources.length, 0); await f.ui.dispose();
});

test('track revocation during a pending audio resume stops capture immediately', async () => {
  const resume = deferred(), f = fixture({ resume: () => resume.promise }), audio = track();
  f.choose(); f.start(); f.pending.resolve(stream(audio)); await flush();
  audio.end(); assert.equal(f.contexts[0].closed, 1); await flush();
  assert.equal(f.ui.snapshot().micState, 'revoked-ended'); released(f, [audio]);
  resume.resolve(); await flush(); assert.equal(f.contexts[0].sources.length, 0); await f.ui.dispose();
});

for (const failure of ['track', 'context']) {
  test(`${failure} cleanup failure stays visible and blocks new ownership, including after dispose`, async () => {
    const f = fixture(failure === 'context' ? { close: () => Promise.reject(new Error('PRIVATE CLEANUP')) } : {});
    const audio = track({ stopFails: failure === 'track' }), other = track(); await listening(f, audio, other);
    const result = await f.ui.stop();
    assert.equal(result.cleanup, 'incomplete'); assert.equal(result.micState, 'cleanup-incomplete');
    assert.equal(other.readyState, 'ended'); assert.equal(f.contexts[0].closed, 1);
    assert.equal(f.frames.size, 0); assert.equal(f.page.count(), 0); assert.equal(f.visibility.count(), 0);
    assert.match(f.root.innerHTML, /Cleanup could not be confirmed/); assert.doesNotMatch(f.root.innerHTML, /PRIVATE CLEANUP/);
    f.start(); assert.equal(f.calls.length, 1);
    const disposal = await f.ui.dispose(); assert.equal(disposal.cleanup, 'incomplete');
    const second = fixture({ mediaDevices: f.mediaDevices }); second.choose(); second.start();
    assert.equal(second.ui.snapshot().gateBlocked, true); assert.equal(f.calls.length, 1); await second.ui.dispose();
  });
}

test('written selections and every fictional event perform zero capture, network or storage work', async t => {
  const forbidden = () => assert.fail('Unexpected external effect');
  t.mock.method(globalThis, 'fetch', forbidden);
  const storage = { getItem: forbidden, setItem: forbidden, removeItem: forbidden };
  const oldLocal = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const oldSession = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  t.after(() => {
    if (oldLocal) Object.defineProperty(globalThis, 'localStorage', oldLocal); else delete globalThis.localStorage;
    if (oldSession) Object.defineProperty(globalThis, 'sessionStorage', oldSession); else delete globalThis.sessionStorage;
  });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: forbidden });
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, get: forbidden });
  const f = fixture({ ports: { storage } });
  for (const id of ['targets', 'history', 'context']) f.root.click('example', { 'data-example': id });
  const states = [];
  for (let i = 0; i < 8; i++) {
    const view = f.ui.snapshot(); states.push(view.operation.state);
    assert.equal(view.operation.claimsPaperRetrieval, false); assert.equal(view.operation.claimsAudioPlayback, false);
    assert.equal(view.operation.claimsLipSync, false); assert.equal(view.operation.retrievalEvidencePresent, false);
    assert.equal(view.aiConsent, false); assert.equal(view.retainProgress, false); assert.equal(view.improvement, false);
    f.root.click('demo-next');
  }
  assert.deepEqual(states, ['idle', 'loading', 'processing', 'response', 'error', 'unknown', 'disconnected', 'cancelled']);
  assert.equal(f.calls.length, 0); assert.equal(f.contexts.length, 0); assert.equal(f.timers.size, 0); assert.equal(f.frames.size, 0);
  assert.match(f.root.innerHTML, /No consent has been saved to a server/);
  assert.match(f.root.innerHTML, /checkbox" disabled> Send audio/); await f.ui.dispose();
});

test('unknown synthetic outcome remains unknown until a manual event; account and event text is not interpolated', async () => {
  const injection = '<img src=x onerror="throw 1">';
  const f = fixture({ account: { ...identity, accountId: injection } });
  for (let i = 0; i < 5; i++) f.root.click('demo-next');
  f.expire(); f.tick(); await flush(); assert.equal(f.ui.snapshot().operation.state, 'unknown');
  assert.equal(f.calls.length, 0); assert.match(f.root.innerHTML, /Do not infer success or retry automatically/);
  f.root.click('example', { 'data-example': injection });
  assert.equal(f.ui.snapshot().exampleId, null); assert.doesNotMatch(f.root.innerHTML, /<img|onerror/);
  await f.ui.dispose();
});

test('coaching source imports the mic owner and presentation helper without mounting recorder or provider paths', async () => {
  const source = await readFile(new URL('../public/member-coach/coach-screen.mjs', import.meta.url), 'utf8');
  assert.match(source, /from '\.\.\/voice\/mic-owner\.mjs'/);
  assert.match(source, /from '\.\.\/presentation-model\.mjs'/);
  assert.doesNotMatch(source, /browser-audio|browser-voice-controller|MediaRecorder|localStorage|sessionStorage|fetch\s*\(|console\./);
});
