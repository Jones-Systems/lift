import { BrowserVoiceError, sameFence, validAccount } from './mic-owner.mjs';

const reasons = new Set(['user_stop', 'navigation', 'background', 'logout', 'account_changed', 'interruption', 'aborted', 'failed', 'expiry']);
const accountMatches = (a, b) => a.accountId === b.accountId && a.authSessionId === b.authSessionId && a.accountEpoch === b.accountEpoch;
const noSession = () => Object.freeze({ local: Promise.resolve({ status: 'released', failedSteps: [] }), server: Promise.resolve({ status: 'unknown' }) });
const safeError = error => error instanceof BrowserVoiceError ? error : new BrowserVoiceError('voice_session_failed');

export function createBrowserStandardVoiceProvider({ mode, account, signal, createRecorder, createPlayback,
  bindTurn, assertDisclosureCurrent, requestSessionStop, onState = () => {} } = {}) {
  const unavailable = () => new BrowserVoiceError('voice_provider_unavailable');
  const synchronous = value => {
    if (value && typeof value.then === 'function') { void Promise.resolve(value).catch(() => {}); throw unavailable(); }
    if (value === false) throw unavailable();
    return value;
  };
  if (mode !== 'standard' || !validAccount(account) || typeof signal?.addEventListener !== 'function' ||
      typeof signal?.removeEventListener !== 'function' ||
      [createRecorder, createPlayback, bindTurn, assertDisclosureCurrent, requestSessionStop, onState].some(value => typeof value !== 'function')) throw unavailable();
  let turn;
  try {
    if (signal.aborted) throw unavailable();
    synchronous(assertDisclosureCurrent(account));
    turn = synchronous(bindTurn({ account }));
    if (!['assertAvailable', 'run', 'abortPending', 'closeTransport', 'requestServerStop'].every(name => typeof turn?.[name] === 'function')) throw unavailable();
    synchronous(turn.assertAvailable()); synchronous(assertDisclosureCurrent(account));
    if (signal.aborted) throw unavailable();
  } catch { throw unavailable(); }

  let connection = null, recorder = null, player = null, capture = null, operation = null;
  let stopped = false, phase = 'idle', error = null, review = null, observerFailed = false, manualFallback = false;
  let turnPending = false, dispatched = false, outcome = null, accounting = null, stopRequestFailed = false;
  let audioCleanup = 'none';
  const attempts = new Map(), cleanupStates = { abortPending: 'none', closeTransport: 'none' };
  const outcomes = new Set(['succeeded', 'not_dispatched', 'rejected', 'unknown']);
  const accountingStates = new Set(['not_reserved', 'replay', 'released', 'settled', 'not_consumed', 'unknown', 'unresolved']);
  const reviewablePlaybackErrors = new Set(['voice_playback_blocked', 'voice_playback_failed',
    'voice_playback_duration_limit']);

  function check() {
    if (stopped || signal.aborted || !connection) throw new BrowserVoiceError('voice_session_stale');
    connection.assertCurrent(); synchronous(turn.assertAvailable()); synchronous(assertDisclosureCurrent(account)); connection.assertCurrent();
    if (stopped || signal.aborted) throw new BrowserVoiceError('voice_session_stale');
  }
  function snapshot() {
    if (review && !stopped) { try { check(); } catch (cause) { failSession(cause); } }
    const cleanup = [audioCleanup, ...Object.values(cleanupStates)];
    const localCleanup = stopRequestFailed || cleanup.includes('incomplete') ? 'incomplete' :
      cleanup.every(value => value === 'released') ? 'released' : cleanup.every(value => value === 'none') ? 'none' : 'pending';
    return Object.freeze({ phase, error, manualFallback, outcome, accounting, turnPending, localCleanup, observerFailed,
      review: review ? Object.freeze({ ...review }) : null });
  }
  function notify() { try { onState(snapshot()); } catch { observerFailed = true; } }
  function invoke(effect) { try { return Promise.resolve(effect()); } catch (cause) { return Promise.reject(cause); } }
  function once(name, effect) {
    if (attempts.has(name)) return attempts.get(name);
    let resolve, reject;
    const result = new Promise((yes, no) => { resolve = yes; reject = no; });
    attempts.set(name, result);
    void result.catch(() => {});
    invoke(effect).then(resolve, reject);
    return result;
  }
  async function requireCleanup(tasks) {
    if ((await Promise.allSettled(tasks)).some(value => value.status === 'rejected')) throw new BrowserVoiceError('voice_standard_cleanup_incomplete');
  }
  function clearLocal() {
    stopped = true; review = null;
    if (!error || phase === 'review') phase = 'stopped';
    signal.removeEventListener('abort', onAbort);
    return once('audio', () => {
      audioCleanup = 'pending';
      const pending = requireCleanup([
        invoke(() => capture ? capture.cancel() : recorder?.dispose()),
        invoke(() => player && connection ? player.stop(connection.fence) : undefined),
      ]);
      notify();
      return pending.then(() => { audioCleanup = 'released'; capture = recorder = player = connection = null; notify(); }, cause => {
        audioCleanup = 'incomplete'; error ??= 'voice_standard_cleanup_incomplete'; manualFallback = true; phase = 'error'; notify(); throw cause;
      });
    });
  }
  function failSession(cause) {
    if (stopped) return;
    error = safeError(cause).code; manualFallback = true; phase = 'error';
    void clearLocal().catch(() => {});
    try { requestSessionStop('failed'); }
    catch { stopRequestFailed = true; error = 'voice_session_stop_failed'; notify(); }
  }
  function onAbort() { void clearLocal().catch(() => {}); }
  function teardown(name, reason) {
    const audio = clearLocal();
    return once(name, () => {
      cleanupStates[name] = 'pending';
      const pending = requireCleanup([audio, invoke(() => turn[name](reason))]);
      notify();
      return pending.then(() => { cleanupStates[name] = 'released'; notify(); }, cause => {
        cleanupStates[name] = 'incomplete'; error ??= 'voice_standard_cleanup_incomplete'; manualFallback = true; phase = 'error'; notify(); throw cause;
      });
    });
  }
  function finishReview(code, value = review) {
    if (!value) throw new BrowserVoiceError(code);
    check(); review = value; error = code; manualFallback = true; phase = 'review';
    notify(); check();
  }
  function connect(input) {
    if (connection || stopped) throw new BrowserVoiceError('voice_standard_busy');
    if (input?.signal !== signal || !accountMatches(input?.fence ?? {}, account) ||
        !Number.isSafeInteger(input?.fence?.generation) || input.fence.generation < 1 || typeof input?.assertCurrent !== 'function') throw unavailable();
    connection = Object.freeze({ fence: input.fence, stream: input.stream, signal, assertCurrent: input.assertCurrent });
    try {
      check(); signal.addEventListener('abort', onAbort, { once: true }); check();
      recorder = createRecorder(); player = createPlayback();
      if (!['start', 'dispose'].every(name => typeof recorder?.[name] === 'function') ||
          typeof player?.play !== 'function' || typeof player?.stop !== 'function') throw unavailable();
      check(); capture = recorder.start(connection); check(); phase = 'recording';
      void capture.result.catch(cause => { failSession(cause); });
      notify(); check();
    } catch (cause) { failSession(cause); throw safeError(cause); }
  }
  function finishRecording() {
    if (operation) return operation;
    if (!capture || stopped) return Promise.reject(new BrowserVoiceError('voice_recording_not_started'));
    // Publish one operation before observers can reenter finish; it owns the original pending turn.
    let resolve, reject;
    operation = new Promise((yes, no) => { resolve = yes; reject = no; });
    void operation.catch(() => {});
    void (async () => {
      try {
        check(); phase = 'finishing'; notify(); check();
        let input = await capture.finish(); check();
        capture = recorder = null;
        if (input?.format !== 'webm' || !(input.audio instanceof Blob)) throw new BrowserVoiceError('voice_recording_data_invalid');
        phase = 'waiting'; notify(); check();
        dispatched = turnPending = true; accounting = 'unresolved';
        let result;
        try {
          const pending = turn.run({ audio: input.audio, format: 'webm', fence: connection.fence, signal, assertCurrent: connection.assertCurrent });
          input = null; result = await pending;
        } finally { input = null; turnPending = false; }
        check();
        if (!outcomes.has(result?.outcome?.kind) || !accountingStates.has(result?.accounting) ||
            (result.outcome.kind !== 'succeeded' && typeof result.outcome.reason !== 'string')) throw new BrowserVoiceError('voice_turn_result_invalid');
        outcome = result.outcome.kind; accounting = result.accounting;
        if (result.review !== undefined) {
          if (typeof result.review?.transcript !== 'string' || (result.review.reply !== undefined && typeof result.review.reply !== 'string')) throw new BrowserVoiceError('voice_turn_result_invalid');
          const copied = { transcript: result.review.transcript, ...(result.review.reply === undefined ? {} : { reply: result.review.reply }) };
          check(); review = copied;
        }
        if (outcome !== 'succeeded' || accounting !== 'settled') {
          finishReview(outcome !== 'succeeded' ? `voice_turn_${outcome}` : 'voice_turn_unsettled');
          resolve(); return;
        }
        check(); phase = 'playing'; notify(); check();
        try { await player.play({ ...connection, speech: result.outcome.value }); }
        catch (cause) {
          const code = safeError(cause).code;
          if (!review || !reviewablePlaybackErrors.has(code)) throw cause;
          const copied = review; review = null; notify();
          check(); await player.stop(connection.fence); check();
          finishReview(code, copied); resolve(); return;
        }
        check(); phase = 'complete'; notify(); check(); resolve();
      } catch (cause) {
        // Rejection or a stale response cannot establish remote cancellation or settled accounting.
        if (dispatched && outcome === null) { outcome = 'unknown'; accounting = 'unresolved'; }
        failSession(cause); reject(safeError(cause));
      }
    })();
    return operation;
  }
  return Object.freeze({ connect, finishRecording, snapshot,
    abortPending: reason => teardown('abortPending', reason),
    closeTransport: reason => teardown('closeTransport', reason),
    requestServerStop: reason => once('server', () => turn.requestServerStop(reason)) });
}

export function createBrowserVoiceController({ mic, createSession, readAccount, assertAccountCurrent,
  createProvider, isForeground, onEvent = () => {}, now = Date.now,
  setTimer = globalThis.setTimeout, clearTimer = globalThis.clearTimeout } = {}) {
  const configured = mic && ['acquire', 'streamFor', 'snapshot'].every(key => typeof mic[key] === 'function') &&
    [createSession, readAccount, assertAccountCurrent, createProvider, isForeground, onEvent, now, setTimer, clearTimer].every(value => typeof value === 'function');
  let current = null, latest = null, disposed = false, lastTeardown = null;
  let state = configured ? 'idle' : 'unavailable', error = configured ? null : 'voice_ports_unavailable';
  const listeners = new Set();
  let observerFailed = false;

  function snapshot() {
    return Object.freeze({ status: disposed ? 'disposed' : state, error, reason: latest?.reason ?? null,
      localTeardown: latest?.localStatus ?? 'none', serverStop: latest?.serverStatus ?? 'none',
      microphone: mic?.snapshot?.() ?? null, observerFailed, runtimeQualified: false });
  }
  function notify() {
    for (const listener of [...listeners]) {
      try { listener(snapshot()); } catch { observerFailed = true; }
    }
  }
  function binding() {
    const value = readAccount();
    if (!validAccount(value?.account) || !Number.isFinite(value.expiresAtMs)) throw new BrowserVoiceError('voice_account_unavailable');
    if (now() >= value.expiresAtMs) throw new BrowserVoiceError('voice_session_expired');
    return Object.freeze({ account: Object.freeze({ accountId: value.account.accountId,
      authSessionId: value.account.authSessionId, accountEpoch: value.account.accountEpoch }), expiresAtMs: value.expiresAtMs });
  }
  function checkAccount(fence) {
    const value = binding();
    if (!accountMatches(value.account, fence)) throw new BrowserVoiceError('voice_account_changed');
    assertAccountCurrent(fence);
    if (isForeground() !== true) throw new BrowserVoiceError('voice_background');
    if (current && now() >= current.binding.expiresAtMs) throw new BrowserVoiceError('voice_session_expired');
  }
  const session = configured ? createSession({ mic, assertAccountCurrent: checkAccount }) : null;
  if (configured && !['start', 'stop', 'assertCurrent'].every(key => typeof session?.[key] === 'function')) {
    throw new TypeError('voice_session_port_invalid');
  }

  function assertCurrent(record) {
    try {
      if (disposed || current !== record || record.teardown || record.abort.signal.aborted || !record.fence) throw new BrowserVoiceError('voice_session_stale');
      checkAccount(record.fence);
      session.assertCurrent(record.fence);
      mic.streamFor(record.fence);
    } catch (cause) {
      if (current === record && !record.teardown) stop(cause?.code === 'voice_session_expired' ? 'expiry' :
        cause?.code === 'voice_background' ? 'background' : 'account_changed');
      throw safeError(cause);
    }
  }
  function armExpiry(record) {
    const remaining = Math.min(record.binding.expiresAtMs, binding().expiresAtMs) - now();
    if (remaining <= 0) { stop('expiry'); return; }
    record.timer = setTimer(() => {
      record.timer = null;
      if (current !== record || record.teardown) return;
      try {
        if (record.fence) checkAccount(record.fence);
        else if (!accountMatches(binding().account, record.binding.account)) throw new BrowserVoiceError('voice_account_changed');
        armExpiry(record);
      }
      catch (cause) { stop(cause?.code === 'voice_session_expired' ? 'expiry' : 'account_changed'); }
    }, Math.min(remaining, 2147483647));
  }

  function stop(reason = 'user_stop') {
    if (!reasons.has(reason)) throw new TypeError('voice_teardown_reason_invalid');
    const record = current;
    if (!record) return lastTeardown ?? noSession();
    if (record.teardown) return record.teardown;
    let resolveLocal, resolveServer;
    const teardown = Object.freeze({ local: new Promise(resolve => { resolveLocal = resolve; }),
      server: new Promise(resolve => { resolveServer = resolve; }) });
    record.teardown = lastTeardown = teardown;
    record.reason = reason; record.localStatus = record.serverStatus = 'pending'; state = 'stopping';
    if (record.timer !== null) { clearTimer(record.timer); record.timer = null; }
    const portableReason = reason === 'expiry' ? 'aborted' : reason;
    record.abort.abort(portableReason);
    let delegated;
    try { delegated = record.started ? session.stop(portableReason) : noSession(); }
    catch { delegated = { local: Promise.resolve({ status: 'incomplete', failedSteps: ['sessionStop'] }), server: Promise.resolve({ status: 'unknown' }) }; }
    Promise.resolve(delegated.local).catch(() => ({ status: 'incomplete', failedSteps: ['sessionStop'] })).then(result => {
      record.localStatus = result.status === 'released' ? 'released' : 'incomplete';
      if (record.localStatus === 'released' && current === record) current = null;
      if (latest === record) { state = record.localStatus === 'incomplete' || error ? 'error' : 'stopped'; notify(); }
      resolveLocal(result);
    });
    Promise.resolve(delegated.server).catch(() => ({ status: 'unknown' })).then(result => {
      record.serverStatus = result.status === 'acknowledged' ? 'acknowledged' : 'unknown';
      if (latest === record) notify();
      resolveServer(result);
    });
    notify();
    return teardown;
  }

  async function start(mode = 'standard') {
    if (!configured || disposed) throw new BrowserVoiceError(disposed ? 'voice_disposed' : 'voice_ports_unavailable');
    if (current) throw new BrowserVoiceError('voice_session_busy');
    if (!['dictation', 'standard', 'realtime'].includes(mode)) throw new BrowserVoiceError('voice_mode_invalid');
    let admitted;
    try {
      if (isForeground() !== true) throw new BrowserVoiceError('voice_background');
      admitted = binding();
    } catch (cause) {
      error = safeError(cause).code; state = 'unavailable'; notify(); throw safeError(cause);
    }
    const record = { binding: admitted, abort: new AbortController(), fence: null, started: false,
      teardown: null, timer: null, reason: null, localStatus: 'none', serverStatus: 'none' };
    current = latest = record; lastTeardown = null; state = 'requesting'; error = null;
    try {
      const provider = createProvider({ mode, account: record.binding.account, signal: record.abort.signal });
      if (!['connect', 'abortPending', 'closeTransport', 'requestServerStop'].every(key => typeof provider?.[key] === 'function')) {
        throw new BrowserVoiceError('voice_provider_unavailable');
      }
      armExpiry(record); notify();
      if (record.teardown || record.abort.signal.aborted) throw new BrowserVoiceError('voice_aborted');
      record.started = true;
      record.fence = await session.start({ mode, account: record.binding.account, signal: record.abort.signal, transport: provider });
      assertCurrent(record);
      state = 'connecting'; notify(); assertCurrent(record);
      const emit = (event, fence = record.fence) => {
        assertCurrent(record);
        if (!sameFence(fence, record.fence)) throw new BrowserVoiceError('voice_event_stale');
        return onEvent(event, record.fence);
      };
      await provider.connect({ fence: record.fence, stream: mic.streamFor(record.fence), signal: record.abort.signal,
        assertCurrent: () => assertCurrent(record), emit });
      assertCurrent(record); state = 'active'; notify();
      return snapshot();
    } catch (cause) {
      const failure = safeError(cause);
      if (current === record && !record.teardown) { error = failure.code; stop('failed'); }
      throw failure;
    }
  }
  function subscribe(listener) {
    if (typeof listener !== 'function') throw new TypeError('voice_listener_invalid');
    if (disposed) throw new BrowserVoiceError('voice_disposed');
    listeners.add(listener);
    return () => listeners.delete(listener);
  }
  function dispose() {
    disposed = true;
    const result = stop('navigation');
    listeners.clear();
    return result;
  }
  return Object.freeze({ start, stop, snapshot, subscribe, dispose,
    accountChanged: () => stop('account_changed'), logout: () => stop('logout'),
    navigation: () => stop('navigation'), background: () => stop('background'), expire: () => stop('expiry') });
}
