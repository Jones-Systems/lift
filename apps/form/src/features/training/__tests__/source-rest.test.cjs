const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const ts = require('typescript');
const mod = { exports: {} };
const compiled = ts.transpileModule(readFileSync(resolve(__dirname, '../source-rest.ts'), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
new Function('module', 'exports', compiled)(mod, mod.exports);
const { createSourceRest } = mod.exports;
const occurrence = (id, rest_seconds) => ({ id, target: { native: { rest_seconds } } });

function fixture(occurrences = [occurrence('strength', 150), occurrence('practice', 90), occurrence('zero', 0)]) {
  let clock = 1000, wall = 1000, current = true, changes = 0;
  const callbacks = new Set(), retained = [];
  const timer = createSourceRest(occurrences, () => current, () => changes++, {
    now: () => clock, wallNow: () => wall,
    subscribe: tick => { callbacks.add(tick); retained.push(tick); return () => callbacks.delete(tick); },
  });
  return { timer, callbacks, retained, time: value => { clock = value; wall = value; },
    wallTime: value => { wall = value; },
    tick: () => [...callbacks].forEach(tick => tick()), expire: () => { current = false; }, changes: () => changes };
}

for (const [id, seconds] of [['strength', 150], ['practice', 90]]) {
  test(`source ${seconds}s rest uses a wall deadline across delayed ticks and repeated pauses`, () => {
    const f = fixture(); assert.equal(f.timer.start(id), true);
    f.time(21750); f.tick(); assert.equal(f.timer.snapshot().remainingMs, seconds * 1000 - 20750);
    f.time(22500); assert.equal(f.timer.pause(), true);
    assert.equal(f.timer.snapshot().remainingMs, seconds * 1000 - 21500);
    assert.equal(f.callbacks.size, 0); assert.equal(f.timer.pause(), false);
    f.time(80000); assert.equal(f.timer.resume(), true); assert.equal(f.timer.resume(), false);
    f.time(81250); f.timer.pause();
    assert.equal(f.timer.snapshot().remainingMs, seconds * 1000 - 22750);
    f.time(200000); f.timer.resume(); f.time(200000 + seconds * 1000); f.tick();
    assert.equal(f.timer.snapshot().status, 'finished'); assert.equal(f.timer.snapshot().remainingMs, 0);
    assert.equal(f.callbacks.size, 0); assert.equal(f.timer.resume(), false);
  });
}

test('selection replaces the occurrence timer and stale ticks cannot affect the new selection or dismissal', () => {
  const f = fixture(); f.timer.start('strength'); const oldTick = f.retained[0];
  f.time(10000); f.timer.start('practice'); oldTick();
  assert.equal(f.timer.snapshot().occurrenceId, 'practice'); assert.equal(f.timer.snapshot().remainingMs, 90000);
  const tick = f.retained[1]; f.timer.dismiss(); const changes = f.changes();
  f.time(12000); oldTick(); tick(); assert.equal(f.timer.snapshot(), null);
  assert.equal(f.callbacks.size, 0); assert.equal(f.changes(), changes);
  assert.equal(f.timer.start('zero'), true); assert.equal(f.timer.snapshot().status, 'finished');
  assert.equal(f.timer.snapshot().remainingMs, 0); assert.equal(f.callbacks.size, 0);
});

test('unknown and duplicate occurrences and malformed supplied durations are refused without a default', () => {
  for (const duration of [undefined, null, '90', NaN, Infinity, -1, 0.5, 10801, Number.MAX_SAFE_INTEGER]) {
    const f = fixture([occurrence('invalid', duration)]);
    assert.equal(f.timer.start('invalid'), false); assert.equal(f.timer.snapshot(), null); assert.equal(f.callbacks.size, 0);
  }
  const f = fixture([occurrence('same', 90), occurrence('same', 150)]);
  assert.equal(f.timer.start('same'), false); assert.equal(f.timer.start('missing'), false);
});

test('rest timing retains the original supplied occurrence duration', () => {
  const supplied = occurrence('practice', 90), f = fixture([supplied]); supplied.target.native.rest_seconds = 150;
  assert.equal(f.timer.start('practice'), true); assert.equal(f.timer.snapshot().durationSeconds, 90); f.timer.dispose();
});

test('invalid or backward clocks cannot invent elapsed time and clear an unsafe running countdown', () => {
  for (const invalid of [NaN, Infinity, -1, 999]) {
    const f = fixture(); f.timer.start('strength'); f.time(invalid); f.tick();
    assert.equal(f.timer.snapshot(), null); assert.equal(f.callbacks.size, 0);
  }
  const f = fixture(); f.time(NaN); assert.equal(f.timer.start('strength'), false);
  f.time(1000); f.timer.start('practice'); f.timer.pause(); f.time(999);
  assert.equal(f.timer.resume(), false); assert.equal(f.timer.snapshot().status, 'paused');
});

test('expiry and disposal remove subscriptions and prevent captured controls from reviving timing', () => {
  for (const close of [f => f.expire(), f => f.timer.dispose()]) {
    const f = fixture(); f.timer.start('practice'); const tick = f.retained[0], changed = f.changes();
    close(f); tick();
    assert.equal(f.timer.start('strength'), false); assert.equal(f.timer.pause(), false);
    assert.equal(f.timer.resume(), false); assert.equal(f.timer.dismiss(), false);
    assert.equal(f.timer.snapshot(), null); assert.equal(f.callbacks.size, 0); assert.equal(f.changes(), changed);
  }
});

test('a throwing clock is refused without subscribing', () => {
  const timer = createSourceRest([occurrence('practice', 90)], () => true, () => assert.fail('No countdown was started'), {
    now: () => { throw new Error('Clock unavailable'); }, wallNow: () => 1000, subscribe: () => assert.fail('Invalid clock cannot subscribe'),
  });
  assert.equal(timer.start('practice'), false); assert.equal(timer.snapshot(), null);
});


test('wall deadline catches up after 120 seconds of sleep with a frozen monotonic clock', () => {
  const f = fixture(); assert.equal(f.timer.start('strength'), true);
  f.wallTime(121000); f.tick();
  assert.equal(f.timer.snapshot().remainingMs, 30000); assert.equal(f.timer.snapshot().status, 'running');
  f.wallTime(151000); f.tick();
  assert.equal(f.timer.snapshot().remainingMs, 0); assert.equal(f.timer.snapshot().status, 'finished');
  assert.equal(f.callbacks.size, 0);
});

test('invalid or backward wall readings clear running rest and refuse paused resume', () => {
  for (const wall of [NaN, Infinity, -1, 999]) {
    const f = fixture(); assert.equal(f.timer.start('strength'), true);
    f.time(2000); f.wallTime(wall); f.tick();
    assert.equal(f.timer.snapshot(), null); assert.equal(f.callbacks.size, 0);
    const paused = fixture(); paused.timer.start('strength'); paused.timer.pause();
    paused.time(2000); paused.wallTime(wall);
    assert.equal(paused.timer.resume(), false); assert.equal(paused.timer.snapshot().status, 'paused');
    assert.equal(paused.timer.snapshot().remainingMs, 150000); assert.equal(paused.callbacks.size, 0);
    paused.timer.dispose();
  }
});

test('paused rest excludes sleep when its deadline is rebased on resume', () => {
  const f = fixture(); f.timer.start('strength'); f.time(11000); f.timer.pause();
  assert.equal(f.timer.snapshot().remainingMs, 140000);
  f.wallTime(131000); f.tick(); assert.equal(f.timer.snapshot().remainingMs, 140000);
  assert.equal(f.timer.resume(), true); f.tick(); assert.equal(f.timer.snapshot().remainingMs, 140000);
  f.wallTime(141000); f.tick(); assert.equal(f.timer.snapshot().remainingMs, 130000);
  f.timer.dispose(); assert.equal(f.callbacks.size, 0);
});
