const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

function load(relative) {
  const moduleValue = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(path.resolve(__dirname, relative), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function('module', 'exports', code)(moduleValue, moduleValue.exports);
  return moduleValue.exports;
}
const { createCompanionLifecycle } = load('../lifecycle.ts');
const { resolvePresentationPolicy } = load('../../integration/presentationPolicy.ts');
const policy = (mascot = 'scholarly', reduceMotion = false, animationStyle = 'long') =>
  resolvePresentationPolicy({ appMode: 'basic', mascot, animationStyle }, reduceMotion);
const event = (type, requestId = 'request-one', gen = 'session-one') => ({ type, requestId, gen });

function fixture(presentation = policy()) {
  let current = true;
  const controller = createCompanionLifecycle({ generation: 'session-one', isCurrentSession: () => current }, presentation);
  return { controller, expire: () => { current = false; }, restore: () => { current = true; } };
}

test('thinking, retrieval and text activity are distinct and require supplied events', () => {
  const { controller: c } = fixture();
  assert.equal(c.snapshot().phase, 'idle');
  const request = c.begin('request-one');
  assert.equal(c.snapshot().phase, 'thinking');
  for (const [type, phase] of [['retrieval-start', 'retrieving'], ['retrieval-end', 'thinking'],
    ['stream-chunk', 'responding'], ['stream-end', 'answered']]) {
    assert.equal(request.receive(event(type)), true);
    assert.equal(c.snapshot().phase, phase);
    assert.equal(c.snapshot().resultAvailable, false);
  }
});

test('ready is synchronous for every mascot, saved style and system-motion state', () => {
  for (const mascot of ['scholarly', 'baby', 'buff', 'none']) {
    for (const style of ['short', 'long']) for (const reduced of [false, true, null]) {
      const presentation = policy(mascot, reduced, style);
      const { controller: c } = fixture(presentation);
      const request = c.begin('request-one');
      assert.equal(request.receive(event('routine-ready')), true);
      const result = c.snapshot();
      assert.equal(result.phase, 'ready');
      assert.equal(result.resultAvailable, true);
      assert.equal(result.decorationAllowed, mascot !== 'none' && reduced === false);
      assert.equal(presentation.savedAnimationStyle, style);
      assert.equal(presentation.resultAccessDelayMs, 0);
      assert.equal(request.receive(event('stream-end')), false);
      assert.equal(c.snapshot().phase, 'ready');
    }
  }
});

test('wrong request and generation cannot alter the current phase', () => {
  const { controller: c } = fixture();
  const request = c.begin('request-one');
  for (const e of [event('routine-ready', 'other-request'), event('routine-ready', 'request-one', 'old-session')]) {
    assert.equal(request.receive(e), false);
    assert.equal(c.snapshot().phase, 'thinking');
    assert.equal(c.snapshot().resultAvailable, false);
  }
});

test('replacing a request invalidates retained callbacks even when an external ID is reused', () => {
  const { controller: c } = fixture();
  const old = c.begin('request-one');
  const next = c.begin('request-one');
  assert.equal(old.receive(event('routine-ready')), false);
  assert.equal(c.snapshot().phase, 'thinking');
  assert.equal(next.receive(event('routine-ready')), true);
});

test('stop and background are terminal for late completion; explicit new requests remain possible', () => {
  for (const reason of ['stop', 'background']) {
    const { controller: c } = fixture();
    const old = c.begin('request-one');
    c.interrupt(reason);
    assert.equal(old.receive(event('routine-ready')), false);
    assert.equal(c.snapshot().resultAvailable, false);
    assert.equal(c.snapshot().decorationAllowed, false);
    const next = c.begin('request-two');
    assert.equal(next.receive(event('routine-ready', 'request-two')), true);
  }
});

test('visual interruptions cancel decoration while content can still become ready', () => {
  for (const reason of ['user-scroll', 'keyboard', 'reflow', 'anchor-unavailable']) {
    const { controller: c } = fixture();
    const request = c.begin('request-one');
    c.interrupt(reason);
    assert.equal(request.receive(event('routine-ready')), true);
    assert.equal(c.snapshot().resultAvailable, true);
    assert.equal(c.snapshot().decorationAllowed, false);
  }
});

test('cancellation after ready preserves availability without decoration or late regression', () => {
  const { controller: c } = fixture();
  const request = c.begin('request-one');
  request.receive(event('routine-ready'));
  c.interrupt('stop');
  assert.equal(c.snapshot().resultAvailable, true);
  assert.equal(c.snapshot().phase, 'ready');
  assert.equal(c.snapshot().decorationAllowed, false);
  assert.equal(request.receive(event('retrieval-error')), false);
});

test('None and static policy transitions cancel decoration without resetting content or replaying it', () => {
  for (const suppressed of [policy('none'), policy('scholarly', true), policy('scholarly', null)]) {
    const { controller: c } = fixture();
    const request = c.begin('request-one');
    request.receive(event('routine-ready'));
    c.updatePresentation(suppressed);
    assert.equal(c.snapshot().resultAvailable, true);
    assert.equal(c.snapshot().decorationAllowed, false);
    c.updatePresentation(policy());
    assert.equal(c.snapshot().decorationAllowed, false);
    c.begin('request-two');
    assert.equal(c.snapshot().decorationAllowed, true);
  }
});

test('policy inputs and snapshots cannot be used as mutable state aliases', () => {
  const supplied = { ...policy() };
  const { controller: c } = fixture(supplied);
  c.begin('request-one');
  supplied.mascotVisible = false;
  supplied.effectiveAnimationStyle = 'static';
  assert.equal(c.snapshot().decorationAllowed, true);
  const snapshot = c.snapshot();
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(c), true);
  c.interrupt('stop');
  assert.equal(snapshot.phase, 'thinking');
  assert.equal(c.snapshot().phase, 'idle');
});

test('disconnect cancels the request and reconnect neither replays nor admits old completions', () => {
  const { controller: c } = fixture();
  const request = c.begin('request-one');
  c.connectionChanged(false);
  assert.equal(c.snapshot().connected, false);
  assert.equal(c.begin('request-two'), null);
  assert.equal(request.receive(event('routine-ready')), false);
  c.connectionChanged(true);
  assert.equal(c.snapshot().phase, 'idle');
  assert.equal(c.snapshot().resultAvailable, false);
  assert.equal(c.snapshot().decorationAllowed, false);
  assert.equal(request.receive(event('routine-ready')), false);
  const next = c.begin('request-two');
  assert.equal(next.receive(event('routine-ready', 'request-two')), true);
});

test('retrieval failure is terminal and never manufactures a ready result', () => {
  const { controller: c } = fixture();
  const request = c.begin('request-one');
  assert.equal(request.receive(event('retrieval-error')), true);
  assert.equal(c.snapshot().phase, 'error');
  assert.equal(c.snapshot().resultAvailable, false);
  assert.equal(c.snapshot().decorationAllowed, false);
  assert.equal(request.receive(event('routine-ready')), false);
});

test('actual caller currentness is checked on delivery and expiry is permanently revoking', () => {
  const f = fixture();
  const request = f.controller.begin('request-one');
  f.expire();
  assert.equal(request.receive(event('routine-ready')), false);
  assert.equal(f.controller.snapshot().disposed, true);
  assert.equal(f.controller.snapshot().requestId, null);
  f.restore();
  assert.equal(f.controller.begin('request-two'), null);
  assert.equal(f.controller.snapshot().resultAvailable, false);
});

test('session loss clears an already ready snapshot and unavailable guards fail closed', () => {
  const f = fixture();
  f.controller.begin('request-one').receive(event('routine-ready'));
  f.expire();
  assert.equal(f.controller.snapshot().resultAvailable, false);
  const c = createCompanionLifecycle({ generation: 'session-one', isCurrentSession() { throw new Error('gone'); } }, policy());
  assert.equal(c.begin('request-one'), null);
  assert.equal(c.snapshot().disposed, true);
});

test('unmount disposal is idempotent and all retained entry points stay inert', () => {
  const { controller: c } = fixture();
  const request = c.begin('request-one');
  c.dispose(); c.dispose();
  c.updatePresentation(policy()); c.connectionChanged(false); c.interrupt('stop');
  assert.equal(request.receive(event('routine-ready')), false);
  assert.equal(c.begin('request-two'), null);
  assert.equal(c.snapshot().disposed, true);
  assert.equal(c.snapshot().requestId, null);
  assert.equal(c.snapshot().decorationAllowed, false);
});
