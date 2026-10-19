const owners = new WeakSet();
const operations = new Set(['refresh', 'signout', 'clear', 'invalidate', 'profile', 'saveProfile', 'reconcileProfile', 'preferences', 'reconcilePreferences',
  'savePreferences', 'plans', 'plan', 'reconcilePlan', 'createPlan', 'editPlan', 'archivePlan',
  'workout', 'startWorkout', 'addSet', 'editSet', 'voidSet', 'completeWorkout', 'history', 'stats', 'exercises']);
const transitions = new Set(['refresh', 'signout', 'clear', 'invalidate']);
const fail = code => { const error = new Error(code); error.code = code; throw error; };

export function createApplicationLifecycle({ session, pageTarget, visibilityTarget, readVisibility, onSnapshot, onSuspend } = {}) {
  if (!session || typeof session.snapshot !== 'function' || typeof session.selectView !== 'function' ||
      typeof readVisibility !== 'function' || typeof onSnapshot !== 'function' || typeof onSuspend !== 'function' ||
      [pageTarget, visibilityTarget].some(target => !target || typeof target.addEventListener !== 'function' || typeof target.removeEventListener !== 'function')) {
    throw new TypeError('application_lifecycle_inputs_required');
  }
  if (owners.has(session)) fail('session_already_owned');
  const currentSnapshot = session.snapshot.bind(session), navigate = session.selectView.bind(session);
  const dispatch = new Map([...operations].filter(name => typeof session[name] === 'function').map(name => [name, session[name].bind(session)]));
  const visibility = () => {
    const value = readVisibility();
    if (value !== 'visible' && value !== 'hidden') throw new TypeError('visibility_must_be_visible_or_hidden');
    return value;
  };
  let state = visibility() === 'visible' ? 'active' : 'suspended';
  let reason = state === 'active' ? null : 'hidden', generation = 0, pagePresent = true;
  let listeners = [];
  const status = () => Object.freeze({ state, reason, generation });
  const current = ticket => state === 'active' && ticket === generation;

  function suspend(nextReason) {
    if (state === 'disposed' || state === 'suspended') return status();
    state = 'suspended'; reason = nextReason; generation++;
    onSuspend(status());
    return status();
  }

  function visible() {
    try { return visibility() === 'visible'; }
    catch (error) { suspend('visibility-unavailable'); throw error; }
  }

  function assertActive() {
    if (state === 'disposed') fail('lifecycle_disposed');
    if (state !== 'active') fail('lifecycle_suspended');
    if (!pagePresent || !visible()) { suspend('hidden'); fail('lifecycle_suspended'); }
  }

  function publish(ticket) {
    if (!current(ticket)) return;
    if (!pagePresent || !visible()) { suspend('hidden'); return; }
    const value = currentSnapshot();
    if (current(ticket)) onSnapshot(value);
  }

  function reportFailure(ticket, error, notificationError) {
    if (notificationError) throw new AggregateError([error, notificationError], 'operation_and_notification_failed');
    try { publish(ticket); }
    catch (observerError) { throw new AggregateError([error, observerError], 'operation_and_notification_failed'); }
    throw error;
  }

  function execute(name, ...args) {
    assertActive();
    if (!dispatch.has(name)) fail('unknown_lifecycle_operation');
    if (transitions.has(name)) generation++;
    const ticket = generation;
    // Consumers receive current snapshots, never a possibly obsolete operation return value.
    publish(ticket);
    if (!current(ticket)) fail('lifecycle_changed');
    let result;
    try { result = dispatch.get(name)(...args); }
    catch (error) { return reportFailure(ticket, error); }
    if (!result || typeof result.then !== 'function') { publish(ticket); return result; }
    let notificationError;
    try { publish(ticket); } catch (error) { notificationError = error; }
    return Promise.resolve(result).then(value => {
      if (notificationError) throw notificationError;
      publish(ticket);
      return value;
    }, error => reportFailure(ticket, error, notificationError));
  }

  function selectView(view) {
    assertActive();
    const result = navigate(view);
    generation++;
    publish(generation);
    return result;
  }

  function resume() {
    if (state === 'disposed') fail('lifecycle_disposed');
    if (!pagePresent || !visible()) fail('page_not_visible');
    if (state === 'suspended') { state = 'active'; reason = null; generation++; }
    publish(generation);
    return status();
  }

  function removeListeners() {
    const failed = [], errors = [];
    for (const listener of listeners) {
      try { listener.remove(listener.type, listener.handler); }
      catch (error) { failed.push(listener); errors.push(error); }
    }
    listeners = failed;
    return errors;
  }

  function dispose() {
    const first = state !== 'disposed';
    if (first) { state = 'disposed'; reason = 'disposed'; generation++; owners.delete(session); }
    const errors = removeListeners();
    if (first) { try { onSuspend(status()); } catch (error) { errors.push(error); } }
    if (errors.length) throw new AggregateError(errors, 'lifecycle_disposal_failed');
    return status();
  }

  const onPageHide = () => { if (state !== 'disposed') { pagePresent = false; suspend('pagehide'); } };
  const onPageShow = () => { if (state !== 'disposed') { pagePresent = true; suspend('pageshow'); } };
  const onVisibility = () => { if (state !== 'disposed' && !visible()) suspend('hidden'); };
  owners.add(session);
  try {
    for (const [target, type, handler] of [[pageTarget, 'pagehide', onPageHide], [pageTarget, 'pageshow', onPageShow], [visibilityTarget, 'visibilitychange', onVisibility]]) {
      // Record before registration: a supplied target can install the listener and then throw.
      listeners.push({ type, handler, remove: target.removeEventListener.bind(target) });
      target.addEventListener(type, handler);
    }
    if (state === 'suspended') onSuspend(status());
  } catch (error) {
    state = 'disposed'; generation++; owners.delete(session);
    const errors = removeListeners();
    if (errors.length) throw new AggregateError([error, ...errors], 'lifecycle_registration_cleanup_failed');
    throw error;
  }
  return Object.freeze({ status, execute, selectView, resume, dispose });
}
