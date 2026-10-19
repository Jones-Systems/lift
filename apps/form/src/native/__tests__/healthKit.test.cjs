const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const ts = require('typescript');

// Execute the real adapter in memory with synthetic platform/native boundaries.
// These checks do not establish Swift compilation or Apple authorization behavior.
const compiled = ts.transpileModule(readFileSync(join(__dirname, '../healthKit.ts'), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function lifecycle(initial = 'active') {
  let state = initial;
  const listeners = new Set();
  return {
    get currentState() { return state; },
    addEventListener(event, listener) {
      assert.equal(event, 'change');
      listeners.add(listener);
      return { remove: () => listeners.delete(listener) };
    },
    emit(next) { state = next; for (const listener of listeners) listener(next); },
    get listenerCount() { return listeners.size; },
  };
}

function load({ platform = 'ios', expoGo = false, module = null, probeThrows = false } = {}) {
  let probes = 0;
  const appState = lifecycle();
  const loaded = { exports: {} };
  class FormNativeError extends Error {
    constructor(code, message) { super(message); this.code = code; }
  }
  new Function('require', 'module', 'exports', compiled)(name => {
    if (name === './runtime') return { FormNativeError };
    if (name === 'react-native') return { AppState: appState, Platform: { OS: platform } };
    assert.equal(name, 'expo');
    return {
      isRunningInExpoGo: () => expoGo,
      requireOptionalNativeModule: name => {
        assert.equal(name, 'FormHealth');
        probes += 1;
        if (probeThrows) throw new Error('synthetic probe failure');
        return module;
      },
    };
  }, loaded, loaded.exports);
  return { ...loaded.exports, appState, probes: () => probes };
}

function seam(overrides = {}, initial = 'active') {
  const calls = [];
  const readStarted = deferred();
  const native = {
    availability: async () => 'available',
    requestRead: async types => { calls.push(['read', types]); readStarted.resolve(types); return 'prompted'; },
    query: async () => { calls.push(['query']); throw new Error('query must not be called'); },
    cancelAll: async () => { calls.push(['cancel']); },
    ...overrides,
  };
  const api = load({ module: native });
  const state = lifecycle(initial);
  const adapter = new api.FormHealthAdapter({ module: native }, state);
  return { ...api, adapter, native, state, calls, readStarted };
}

test('web, Android, Expo Go and missing modules stay safe without loading a native bridge', async () => {
  for (const [options, reason, expectedProbes] of [
    [{ platform: 'web' }, 'platform_unsupported', 0],
    [{ platform: 'android' }, 'platform_unsupported', 0],
    [{ expoGo: true }, 'expo_go', 0],
    [{}, 'native_module_missing', 1],
    [{ probeThrows: true }, 'native_probe_failed', 1],
    [{ module: { availability: async () => 'available' } }, 'native_probe_failed', 1],
  ]) {
    const api = load(options);
    const binding = api.bindHealthKitNative();
    assert.equal(binding.reason, reason);
    assert.equal(api.probes(), expectedProbes);
    assert.deepEqual(await api.getHealthKitCapabilities(binding), {
      available: false, requestRead: false, query: false, reason,
    });
    const adapter = new api.FormHealthAdapter(binding);
    assert.equal(await adapter.availability(), 'unavailable_device');
    await assert.rejects(adapter.requestRead(['steps']), { code: 'health_native_unavailable' });
    await adapter.cancelAll();
    await adapter.dispose();
    assert.equal(api.appState.listenerCount, 0);
  }
});

test('capability never enables query, including available and malformed native responses', async () => {
  for (const status of ['available', 'restricted', 'unavailable_device', 'granted']) {
    const s = seam({ availability: async () => status });
    const result = await s.getHealthKitCapabilities({ module: s.native });
    assert.equal(result.query, false);
    assert.equal(result.requestRead, status === 'available');
    assert.equal(result.available, status === 'available');
    assert.equal(result.reason, status === 'granted' ? 'native_probe_failed' : status);
    assert.deepEqual(s.adapter.capabilities, { query: false });
    await assert.rejects(s.adapter.query({ type: 'steps', from: '2026-01-01', to: '2026-01-02', anchor: null, limit: 10 }),
      { code: 'health_query_unavailable' });
    assert.deepEqual(s.calls, []);
    await s.adapter.dispose();
  }
});

test('read requests forward only the selected allowlisted types and preserve request-only outcomes', async () => {
  const all = ['workouts', 'steps', 'activeEnergy', 'restingHeartRate', 'hrvSdnn', 'sleep', 'bodyMass'];
  for (const result of ['prompted', 'unnecessary']) {
    const seen = [];
    const s = seam({ requestRead: async types => { seen.push(types); return result; } });
    const selected = [...all];
    const pending = s.adapter.requestRead(selected);
    selected.length = 0;
    assert.equal(await pending, result);
    assert.deepEqual(seen, [all]);
    await s.adapter.dispose();
  }
  const s = seam();
  assert.equal(await s.adapter.requestRead(['sleep']), 'prompted');
  assert.deepEqual(s.calls, [['read', ['sleep']]]);
  for (const types of [[], ['steps', 'steps'], ['clinicalRecords'], ['Steps'], null, 'steps', [undefined], [...all, 'steps']]) {
    await assert.rejects(s.adapter.requestRead(types), { code: 'health_invalid_types' });
  }
  assert.equal(s.calls.length, 1);
  await s.adapter.dispose();
});

test('unavailable, restricted, failed and malformed probes never request authorization', async () => {
  for (const status of ['restricted', 'unavailable_device', 'granted']) {
    const s = seam({ availability: async () => status });
    await assert.rejects(s.adapter.requestRead(['steps']), {
      code: status === 'granted' ? 'health_invalid_response' : 'health_native_unavailable',
    });
    assert.deepEqual(s.calls, []);
    await s.adapter.dispose();
  }
  const error = new Error('synthetic configuration failure');
  const s = seam({ availability: async () => { throw error; } });
  await assert.rejects(s.adapter.requestRead(['steps']), failure => failure === error);
  assert.deepEqual(s.calls, []);
  await s.adapter.dispose();
});

test('grant/deny booleans cannot masquerade as request outcomes', async () => {
  for (const result of [true, false, 'granted', 'denied', null]) {
    const s = seam({ requestRead: async () => result });
    await assert.rejects(s.adapter.requestRead(['steps']), { code: 'health_invalid_response' });
    await s.adapter.dispose();
  }
});

test('cancel settles a pending probe immediately and late availability cannot launch a request', async () => {
  const probe = deferred();
  const s = seam({ availability: () => probe.promise });
  const request = s.adapter.requestRead(['steps']);
  const rejected = assert.rejects(request, { code: 'health_cancelled' });
  await s.adapter.cancelAll();
  await rejected;
  probe.resolve('available');
  await Promise.resolve();
  assert.deepEqual(s.calls, [['cancel']]);
  await s.adapter.dispose();
});

test('cancel rejects read completion and isolates the next generation from late callbacks', async () => {
  const result = deferred();
  const started = deferred();
  let reads = 0;
  const s = seam({ requestRead: () => {
    reads += 1;
    if (reads === 1) { started.resolve(); return result.promise; }
    return Promise.resolve('unnecessary');
  } });
  const request = s.adapter.requestRead(['sleep']);
  const rejected = assert.rejects(request, { code: 'health_cancelled' });
  await started.promise;
  await assert.rejects(s.adapter.requestRead(['steps']), { code: 'health_busy' });
  await s.adapter.cancelAll();
  await rejected;
  assert.equal(await s.adapter.requestRead(['steps']), 'unnecessary');
  result.resolve('prompted');
  await Promise.resolve();
  assert.equal(reads, 2);
  await s.adapter.dispose();
});

test('background cancels pending work, inactive does not cancel a system permission sheet, and dispose removes listeners', async () => {
  const probe = deferred();
  const s = seam({ availability: () => probe.promise });
  const request = s.adapter.requestRead(['sleep']);
  const rejected = assert.rejects(request, { code: 'health_cancelled' });
  s.state.emit('inactive');
  assert.deepEqual(s.calls, []);
  s.state.emit('background');
  await s.adapter.cancelAll();
  await rejected;
  await assert.rejects(s.adapter.requestRead(['steps']), { code: 'health_backgrounded' });
  probe.resolve('available');
  s.state.emit('active');
  assert.equal(await s.adapter.requestRead(['steps']), 'prompted');
  await s.adapter.dispose();
  assert.equal(s.state.listenerCount, 0);
  await assert.rejects(s.adapter.requestRead(['steps']), { code: 'health_module_destroyed' });
  await assert.rejects(s.adapter.availability(), { code: 'health_module_destroyed' });
});

test('dispose rejects pending availability before a native callback arrives', async () => {
  const probe = deferred();
  const s = seam({ availability: () => probe.promise });
  const availability = s.adapter.availability();
  const rejected = assert.rejects(availability, { code: 'health_module_destroyed' });
  await s.adapter.dispose();
  await rejected;
  probe.reject(new Error('late native error'));
  await Promise.resolve();
  assert.equal(s.state.listenerCount, 0);
});

test('pending or failed native cancellation holds new work until confirmed recovery', async () => {
  const cleanup = deferred();
  let attempts = 0;
  const s = seam({ cancelAll: () => { attempts += 1; return attempts === 1 ? cleanup.promise : Promise.resolve(); } });
  const cancellation = s.adapter.cancelAll();
  assert.equal(s.adapter.cancelAll(), cancellation);
  const rejected = assert.rejects(cancellation, { code: 'health_cancel_failed' });
  await assert.rejects(s.adapter.requestRead(['steps']), { code: 'health_cancel_pending' });
  cleanup.reject(new Error('synthetic native failure'));
  await rejected;
  await assert.rejects(s.adapter.availability(), { code: 'health_cancel_pending' });
  await s.adapter.cancelAll();
  assert.equal(await s.adapter.requestRead(['steps']), 'prompted');
  assert.equal(attempts, 2);
  await s.adapter.dispose();
});
