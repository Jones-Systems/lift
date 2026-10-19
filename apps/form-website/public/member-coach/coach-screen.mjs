import { createBrowserMicOwner, validAccount } from '../voice/mic-owner.mjs';
import { deriveOperationPresentation } from '../presentation-model.mjs';

const examples = Object.freeze([
  { id: 'targets', question: 'Is my target the same as what I logged?', answer: 'A target describes the plan. A confirmed set describes what you entered as performed. For example, a target of 8 repetitions and a confirmed set of 6 remain two different facts. This written example does not change your plan or log.' },
  { id: 'history', question: 'What does loaded history tell me?', answer: 'Loaded history shows the sessions currently available in the view. It is not a complete week or an assessment of improvement. In this authored example, two loaded sessions mean two visible sessions, not that you trained only twice.' },
  { id: 'context', question: 'What would a useful coaching question include?', answer: 'An example question is: “My plan lists three sets, but I logged two. Can you explain the difference without changing my plan?” This page only displays this written example. It does not send the question, assess your movement or provide a personal training recommendation.' },
]);
const events = Object.freeze([
  { state: 'idle', label: 'Ready', detail: 'Fictional session ready. No device or provider is connected.' },
  { state: 'loading', label: 'Request started', detail: 'Fictional request event. No request was sent.' },
  { state: 'processing', label: 'Working', detail: 'Fictional processing event. No papers, account records or audio were retrieved.' },
  { state: 'response', label: 'Written answer', detail: 'Fictional answer: “Your planned target and your logged set remain separate.” This is authored text, not generated advice.' },
  { state: 'error', label: 'Provider unavailable', detail: 'Fictional unavailable event. There is no connected AI provider and nothing is retried.' },
  { state: 'unknown', label: 'Outcome unknown', detail: 'Fictional unknown outcome. Do not infer success or retry automatically.' },
  { state: 'disconnected', label: 'Disconnected', detail: 'Fictional connection loss. No real connection was opened.' },
  { state: 'cancelled', label: 'Cancelled', detail: 'Fictional cancellation event. No microphone was used.' },
]);
const messages = Object.freeze({
  idle: 'Ready for an optional local microphone check.',
  insecure: 'Microphone unavailable: this page requires a secure browser context (HTTPS or a supported local origin).',
  unavailable: 'Microphone unavailable: this browser does not provide the required capture and audio APIs.',
  disconnected: 'Account not connected. Written examples and the fictional walkthrough still work. Connect an account or use the dedicated sample account to check a microphone.',
  requesting: 'Waiting for browser permission. Stop cancels this check, but cannot dismiss the browser permission prompt.',
  listening: 'Local microphone level only. Nothing is uploaded, recorded, saved or transcribed. Stops automatically within 30 seconds.',
  stopping: 'Stopping the local check; cleanup is still in progress.',
  'cancelled-prompt': 'Check cancelled. The browser prompt may remain open; any late grant will be stopped. Another check stays blocked until it settles.',
  stopped: 'Local check stopped. Capture and audio cleanup completed.',
  timeout: 'The 30-second limit was reached. The local check was cancelled.',
  hidden: 'The local check was cancelled because the page became hidden.',
  navigation: 'The local check was cancelled because you left the page.',
  denied: 'Microphone permission denied or blocked. Review browser permissions before choosing to try again.',
  'no-mic': 'No usable microphone was found.',
  'device-busy': 'The microphone could not be read; it may be busy or unavailable to this browser.',
  'revoked-ended': 'The microphone ended or was removed, or permission was revoked. The local check has stopped.',
  interrupted: 'Microphone input was interrupted. The local check has stopped.',
  'account-changed': 'Account or session changed. The previous check was cancelled. Choose local-only access again to start a new check.',
  signedout: 'Signed out. The microphone check was cancelled and local-only access was reset.',
  failed: 'The local check could not start. No automatic retry will occur.',
  'cleanup-incomplete': 'Cleanup could not be confirmed. Another check is blocked. Close this tab and check the browser microphone indicator.',
  disposed: 'Coaching view closed. Cleanup completed.',
});
const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const invoke = effect => { try { return Promise.resolve(effect()); } catch (error) { return Promise.reject(error); } };
const identityMatches = (a, b) => Boolean(a && b && a.accountId === b.accountId && a.authSessionId === b.authSessionId && a.accountEpoch === b.accountEpoch);

// A view repaint must not create a second owner while an old browser prompt or cleanup is pending.
// This gate holds only local resource ownership; it never activates an account or synthetic mode.
const browserGates = new WeakMap();
function gateFor(mediaDevices) {
  if (!mediaDevices || (typeof mediaDevices !== 'object' && typeof mediaDevices !== 'function')) return { current: null, observers: new Set() };
  if (!browserGates.has(mediaDevices)) browserGates.set(mediaDevices, { current: null, observers: new Set() });
  return browserGates.get(mediaDevices);
}

function renderMemberCoach(view) {
  const example = examples.find(value => value.id === view.exampleId);
  const event = events[view.demoStep] ?? events[0];
  return `<section class="member-coach" aria-label="Coaching">
    <header class="member-coach__intro"><p class="member-coach__eyebrow">Your session · Coach</p>
      <h2>A little clarity for your next step.</h2>
      <p>Explore written examples, walk through fictional coaching events, or check your microphone locally.</p>
      <span class="member-coach__badge">Live AI coaching unavailable</span></header>
    <div class="member-coach__grid">
      <section class="member-coach__card"><p class="member-coach__eyebrow">01 · Written examples</p>
        <h3>Start with a question</h3><p>Selected, authored examples. No AI generation, corpus search or personal advice. No free text is sent.</p>
        <div class="member-coach__questions">${examples.map(value => `<button type="button" data-coach-action="example" data-example="${value.id}" aria-pressed="${view.exampleId === value.id}">${escape(value.question)}</button>`).join('')}</div>
        <div class="member-coach__answer" role="status"><strong>${example ? 'Authored example answer' : 'Choose an example above'}</strong><p>${escape(example?.answer ?? 'Your selection stays in this view and changes no account data.')}</p></div>
      </section>
      <section class="member-coach__card"><p class="member-coach__eyebrow">02 · Fictional event walkthrough</p>
        <h3>See how states are explained</h3><p>Every event and answer here is fictional. This walkthrough never uses your microphone, a network connection or storage.</p>
        <div class="member-coach__event" role="status"><span class="member-coach__badge">Fictional · ${view.demoStep + 1} of ${events.length}</span><h4>${escape(event.label)}</h4><p>${escape(event.detail)}</p></div>
        <div class="member-coach__actions"><button type="button" data-coach-action="demo-next">${view.demoStep === events.length - 1 ? 'Restart walkthrough' : 'Next fictional event'}</button><button type="button" data-coach-action="demo-reset">Reset walkthrough</button></div>
        <p class="member-coach__small">No paper retrieval, audio playback, lip sync or mascot animation is claimed.</p>
      </section>
    </div>
    <section class="member-coach__card member-coach__mic"><p class="member-coach__eyebrow">03 · Optional device check</p>
      <h3>Check a microphone. Keep it local.</h3><p>Only the input level is measured in this tab. No upload, recording, saving, transcript, logging, playback or AI connection. The check lasts at most 30 seconds, including time waiting for permission.</p>
      <label class="member-coach__choice"><input type="checkbox" data-coach-choice="local" ${view.localOnly ? 'checked' : ''} ${view.active || view.disposed ? 'disabled' : ''}> I choose a local-only microphone level check.</label>
      <div class="member-coach__actions"><button type="button" data-coach-action="mic-start" ${view.canStart ? '' : 'disabled'}>Start local mic check</button><button type="button" data-coach-action="mic-stop" ${view.active ? '' : 'disabled'}>Stop / cancel check</button></div>
      <div class="member-coach__meter" role="meter" aria-label="Local microphone input level" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" aria-valuetext="No active input"><span data-coach-meter-fill></span></div>
      <p class="member-coach__mic-status" role="status" data-coach-mic-status>${escape(messages[view.micState] ?? messages.failed)}</p>
      ${view.cleanup === 'pending' ? '<p class="member-coach__small">Resource cleanup pending; release is not yet confirmed.</p>' : ''}
      ${view.cleanup === 'pending' && view.pendingPermission ? '<p class="member-coach__small">The browser permission prompt cannot be dismissed by this page. A late grant will be stopped; another check remains blocked until it settles.</p>' : ''}
      ${view.cleanup === 'complete' ? '<p class="member-coach__small">Capture and audio cleanup completed.</p>' : ''}
      ${view.gateBlocked ? '<p class="member-coach__small">An earlier check still owns the microphone or is awaiting cleanup. It must settle before another check can start.</p>' : ''}
      <p class="member-coach__small">Browser permission only permits this device check. It is separate from any future choice to send audio to an AI service.</p>
    </section>
    <section class="member-coach__card"><h3>Your choices stay separate</h3>
      <p>AI coaching is unavailable. No accepted AI recipient or retention terms are configured here, so AI consent cannot be given. No consent has been saved to a server.</p>
      <div class="member-coach__choices"><label><input type="checkbox" disabled> Send audio to an AI recipient — unavailable</label>
      <label><input type="checkbox" disabled> Retain coaching progress — off, unavailable, no effect</label>
      <label><input type="checkbox" disabled> Use coaching data for improvement — off, unavailable, no effect</label></div>
    </section>
  </section>`;
}

export function mountMemberCoach({ root, readAccount = () => null, subscribeAccount,
  pageTarget = globalThis.window, visibilityTarget = globalThis.document,
  readVisibility = () => globalThis.document?.visibilityState ?? 'visible',
  mediaDevices = globalThis.navigator?.mediaDevices, secureContext = globalThis.isSecureContext === true,
  AudioContextClass = globalThis.AudioContext ?? globalThis.webkitAudioContext,
  requestFrame = callback => globalThis.requestAnimationFrame(callback),
  cancelFrame = handle => globalThis.cancelAnimationFrame(handle),
  setTimer = (callback, delay) => globalThis.setTimeout(callback, delay),
  clearTimer = handle => globalThis.clearTimeout(handle),
} = {}) {
  if (!root || typeof root.addEventListener !== 'function' || typeof root.removeEventListener !== 'function' ||
      typeof readAccount !== 'function' || (subscribeAccount !== undefined && typeof subscribeAccount !== 'function')) throw new TypeError('member_coach_ports_invalid');
  const readIdentity = () => {
    try { const value = readAccount(); return validAccount(value) ? { accountId: value.accountId, authSessionId: value.authSessionId, accountEpoch: value.accountEpoch } : null; }
    catch { return null; }
  };
  let account = readIdentity(), disposed = false, localOnly = false, generation = 0, job = null;
  let exampleId = null, demoStep = 0, micState, cleanup = 'none', unsubscribe = null, disposal = null;
  const gate = gateFor(mediaDevices);
  const availability = () => !secureContext ? 'insecure' :
    typeof mediaDevices?.getUserMedia !== 'function' || typeof AudioContextClass !== 'function' ? 'unavailable' :
      !account ? 'disconnected' : 'idle';
  micState = availability();
  function snapshot() {
    return Object.freeze({ exampleId, demoStep, localOnly, micState, cleanup, disposed,
      active: Boolean(job), pendingPermission: job?.pending === true, gateBlocked: Boolean(gate.current && gate.current !== job),
      canStart: !disposed && !job && !gate.current && localOnly && availability() === 'idle' && readVisibility() !== 'hidden',
      provider: 'unavailable', aiConsent: false, retainProgress: false, improvement: false,
      operation: deriveOperationPresentation({ state: events[demoStep].state, retrievalEvidence: null, resultAvailable: events[demoStep].state === 'response' }) });
  }
  function paint() {
    if (disposed) return;
    const focused = root.ownerDocument?.activeElement;
    const action = root.contains(focused) ? focused?.getAttribute?.('data-coach-action') : null;
    const example = focused?.getAttribute?.('data-example');
    const choice = root.contains(focused) && focused?.getAttribute?.('data-coach-choice') === 'local';
    root.innerHTML = renderMemberCoach(snapshot());
    // All selector values originate in this module's fixed markup, never in account/provider text.
    if (choice) root.querySelector?.('[data-coach-choice="local"]')?.focus();
    else if (action && ['example', 'demo-next', 'demo-reset', 'mic-start', 'mic-stop'].includes(action)) {
      const selector = action === 'example' && examples.some(value => value.id === example) ? `[data-example="${example}"]` : `[data-coach-action="${action}"]`;
      const next = root.querySelector?.(selector);
      if (next?.disabled) (root.querySelector?.('[data-coach-action="mic-stop"]:not(:disabled)') ??
        root.querySelector?.('[data-coach-action="mic-start"]:not(:disabled)') ??
        root.querySelector?.('[data-coach-choice="local"]:not(:disabled)'))?.focus();
      else next?.focus();
    }
  }
  const add = (record, target, name, handler) => {
    if (!target?.addEventListener) return;
    target.addEventListener(name, handler);
    record.removers.push(() => target.removeEventListener(name, handler));
  };
  function stop(reason = 'stopped') {
    const finalState = Object.hasOwn(messages, reason) ? reason : 'stopped';
    const current = job;
    if (!current) return Promise.resolve(snapshot());
    if (current.cleanupPromise) return current.cleanupPromise;
    current.cancelled = true;
    current.finalState = finalState;
    cleanup = 'pending';
    micState = current.pending && finalState === 'stopped' ? 'cancelled-prompt' : finalState === 'stopped' ? 'stopping' : finalState;
    // Abort synchronously fences capture, including permission grants arriving after navigation.
    current.abort.abort();
    current.cancelResume?.(); current.cancelResume = null;
    const work = [];
    const attempt = effect => { try { effect(); } catch { current.cleanupFailed = true; } };
    if (current.frame !== null) attempt(() => cancelFrame(current.frame));
    if (current.timer !== null) attempt(() => clearTimer(current.timer));
    current.frame = current.timer = null;
    for (const remove of current.removers.splice(0)) attempt(remove);
    for (const node of [current.source, current.analyser]) if (node) attempt(() => node.disconnect());
    current.source = current.analyser = null;
    if (current.context) {
      const context = current.context;
      current.context = null;
      work.push(invoke(() => context.close()));
    }
    // Acquisition is not abortable. Keep the gate and await the same lease before declaring release.
    work.push(current.acquisition.then(lease => lease ? lease.release(finalState) : undefined));
    current.cleanupPromise = Promise.allSettled(work).then(results => {
      const failed = current.cleanupFailed || results.some(value => value.status === 'rejected');
      cleanup = failed ? 'incomplete' : 'complete';
      micState = failed ? 'cleanup-incomplete' : current.finalState;
      current.lease = null;
      if (!failed && gate.current === current) gate.current = null;
      if (job === current) job = null;
      for (const observer of gate.observers) observer();
      return snapshot();
    });
    paint();
    return current.cleanupPromise;
  }
  function accountChanged() {
    if (disposed) return disposal ?? Promise.resolve(snapshot());
    account = readIdentity();
    localOnly = false;
    exampleId = null; demoStep = 0;
    const reason = account ? 'account-changed' : 'signedout';
    micState = cleanup === 'incomplete' ? 'cleanup-incomplete' : reason;
    if (job?.cleanupPromise) job.finalState = reason;
    const result = stop(reason);
    paint();
    return result;
  }
  function tick(current) {
    current.frame = null;
    if (disposed || current.cancelled || job !== current) return;
    if (!identityMatches(current.fence, readIdentity())) { void accountChanged(); return; }
    if (readVisibility() === 'hidden') { void stop('hidden'); return; }
    try {
      // Samples live only in this tick. Retain no audio buffer or waveform in state or DOM.
      const samples = new Float32Array(current.analyser.fftSize);
      current.analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (const sample of samples) sum += sample * sample;
      const level = Math.round(Math.min(1, Math.sqrt(sum / samples.length)) * 100);
      const meter = root.querySelector?.('[role="meter"]');
      meter?.setAttribute('aria-valuenow', String(level));
      meter?.setAttribute('aria-valuetext', `${level}% input level`);
      const fill = root.querySelector?.('[data-coach-meter-fill]');
      if (fill) fill.style.width = `${level}%`;
      current.frame = requestFrame(() => tick(current));
    } catch { void stop('failed'); }
  }
  function start() {
    if (disposed || job || gate.current || !localOnly) return;
    const nextAccount = readIdentity();
    if (!account && !nextAccount) { micState = availability(); paint(); return; }
    if (!identityMatches(account, nextAccount)) { void accountChanged(); return; }
    if (availability() !== 'idle' || readVisibility() === 'hidden') { micState = availability(); paint(); return; }
    const current = { abort: new AbortController(), fence: Object.freeze({ ...account, generation: ++generation }),
      pending: true, cancelled: false, lease: null, frame: null, timer: null, context: null, source: null,
      analyser: null, removers: [], cleanupFailed: false, cleanupPromise: null, acquisition: Promise.resolve(null) };
    job = gate.current = current;
    cleanup = 'none'; micState = 'requesting';
    let deviceBusy = false;
    const owner = createBrowserMicOwner({ secureContext, mediaDevices: { getUserMedia(constraints) {
      return invoke(() => mediaDevices.getUserMedia(constraints)).catch(error => {
        deviceBusy = error?.name === 'NotReadableError' || error?.name === 'TrackStartError';
        // Pass only the bounded error name to the existing owner; never retain/display native text.
        throw { name: typeof error?.name === 'string' ? error.name : 'Error' };
      });
    } } });
    try {
      add(current, pageTarget, 'pagehide', () => { void stop('navigation'); });
      add(current, visibilityTarget, 'visibilitychange', () => { if (readVisibility() === 'hidden') void stop('hidden'); });
      current.timer = setTimer(() => { void stop('timeout'); }, 30_000);
      // Construct/resume on the explicit click, while browser user activation is still present.
      current.context = new AudioContextClass();
      const resumed = Promise.race([
        invoke(() => current.context.resume()).then(() => true, () => false),
        new Promise(resolve => { current.cancelResume = () => resolve(false); }),
      ]);
      current.acquisition = owner.acquire({ mode: 'dictation', fence: current.fence, signal: current.abort.signal }).then(lease => {
        current.pending = false; current.lease = lease; return lease;
      }, error => {
        current.pending = false;
        current.failure = deviceBusy ? 'device-busy' : ({ voice_permission_denied: 'denied', voice_microphone_unavailable: 'no-mic', voice_capture_interrupted: 'interrupted' })[error?.code] ?? 'failed';
        return null;
      });
      void current.acquisition.then(async lease => {
        if (current.cancelled) return;
        if (!lease) { void stop(current.failure); return; }
        if (!identityMatches(current.fence, readIdentity())) { void accountChanged(); return; }
        for (const track of owner.streamFor(current.fence).getTracks()) {
          add(current, track, 'ended', () => { void stop('revoked-ended'); });
          add(current, track, 'mute', () => { void stop('interrupted'); });
        }
        if (!(await resumed)) { if (!current.cancelled) void stop('failed'); return; }
        current.cancelResume = null;
        if (current.cancelled || disposed) return;
        if (readVisibility() === 'hidden') { void stop('hidden'); return; }
        if (!identityMatches(current.fence, readIdentity())) { void accountChanged(); return; }
        current.source = current.context.createMediaStreamSource(owner.streamFor(current.fence));
        current.analyser = current.context.createAnalyser();
        current.analyser.fftSize = 256;
        current.source.connect(current.analyser);
        // Deliberately never connect to destination: this check has no speaker/playback path.
        micState = 'listening'; paint(); tick(current);
      }).catch(error => {
        if (!current.cancelled) void stop(error?.code === 'voice_microphone_unavailable' ? 'no-mic' : 'failed');
      });
      paint();
    } catch { void stop('failed'); }
  }
  function click(event) {
    const button = event.target?.closest?.('[data-coach-action]');
    if (!button || !root.contains(button) || button.disabled || disposed) return;
    const action = button.getAttribute('data-coach-action');
    if (action === 'mic-start') start();
    else if (action === 'mic-stop') return stop();
    else if (action === 'example') {
      const id = button.getAttribute('data-example');
      if (examples.some(value => value.id === id)) { exampleId = id; paint(); }
    } else if (action === 'demo-next' || action === 'demo-reset') {
      demoStep = action === 'demo-reset' ? 0 : (demoStep + 1) % events.length; paint();
    }
  }
  function change(event) {
    const input = event.target;
    if (disposed || job || !root.contains(input) || input?.getAttribute?.('data-coach-choice') !== 'local') return;
    localOnly = input.checked === true; paint();
  }
  function dispose() {
    if (disposal) return disposal;
    disposed = true; localOnly = false;
    gate.observers.delete(paint);
    root.removeEventListener('click', click); root.removeEventListener('change', change);
    let unsubscribeFailed = false;
    try { unsubscribe?.(); } catch { unsubscribeFailed = true; }
    unsubscribe = null;
    if (job?.cleanupPromise) job.finalState = 'disposed';
    disposal = stop('disposed').then(() => {
      if (unsubscribeFailed) { cleanup = 'incomplete'; micState = 'cleanup-incomplete'; }
      else if (cleanup !== 'incomplete') micState = 'disposed';
      return snapshot();
    });
    root.innerHTML = '';
    return disposal;
  }
  gate.observers.add(paint);
  paint();
  root.addEventListener('click', click); root.addEventListener('change', change);
  try {
    if (subscribeAccount) {
      unsubscribe = subscribeAccount(accountChanged);
      if (typeof unsubscribe !== 'function') throw new TypeError('member_coach_unsubscribe_required');
    }
  } catch (error) { void dispose(); throw error; }
  return Object.freeze({ snapshot, accountChanged, stop, dispose });
}
