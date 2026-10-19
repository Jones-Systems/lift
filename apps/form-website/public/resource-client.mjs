import { validateRuntimeConfig, parseMe, parseEntitlements, configuredSessionOptions } from './account.mjs';
import { parseProfile, parsePreferences, parsePlan, parsePlans, parseSet, parseSession, parseHistory, parseStats, parseExercises } from './resource-contract.mjs';

export class ResourceError extends Error {
  constructor(code, { status = null, effect = 'none' } = {}) {
    super(code); this.name = 'ResourceError'; this.code = code; this.status = status; this.effect = effect;
  }
}
const fail = code => { throw new ResourceError(code); };
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const integer = (x, min, max) => Number.isSafeInteger(x) && x >= min && x <= max;
const revision = x => integer(x, 0, Number.MAX_SAFE_INTEGER);
const resourceId = x => typeof x === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(x) ? x : fail('invalid_id');
const canonical = value => JSON.stringify(value, (_, x) => object(x) ? Object.fromEntries(Object.keys(x).sort().map(k => [k, x[k]])) : x);
const freeze = x => {
  if (x && typeof x === 'object') { Object.values(x).forEach(freeze); Object.freeze(x); }
  return x;
};
const detached = x => freeze(JSON.parse(JSON.stringify(x)));
const keys = (x, allowed, required = []) => {
  if (!object(x) || Object.keys(x).some(k => !allowed.includes(k)) || required.some(k => !Object.hasOwn(x, k)) || Object.values(x).some(v => v === undefined)) fail('invalid_fields');
};
const text = (x, max) => typeof x === 'string' && x.trim().length > 0 && x.length <= max;
function profilePatch(current, changes) {
  const parsed = parseProfile(current);
  keys(changes, ['name', 'age', 'heightCm', 'weightKg', 'trainingBackground', 'trainingContext', 'injuryHistory', 'goals']);
  if (!Object.keys(changes).length || parsed.revision === Number.MAX_SAFE_INTEGER) fail('invalid_fields');
  const normalized = { ...changes };
  for (const field of ['name', 'trainingContext', 'injuryHistory']) if (Object.hasOwn(normalized, field)) {
    if (typeof normalized[field] !== 'string') fail('invalid_fields');
    normalized[field] = normalized[field].trim();
  }
  if (Object.hasOwn(normalized, 'goals')) {
    if (!Array.isArray(normalized.goals) || normalized.goals.some(value => typeof value !== 'string')) fail('invalid_fields');
    normalized.goals = normalized.goals.map(value => value.trim());
  }
  parseProfile({ ...parsed, ...normalized });
  return detached({ ...normalized, expectedRevision: parsed.revision });
}
function profileResult(body) {
  const { expectedRevision, ...changes } = body;
  return value => {
    const parsed = parseProfile(value);
    if (parsed.revision <= expectedRevision || Object.entries(changes).some(([name, item]) => canonical(parsed[name]) !== canonical(item))) fail('invalid_profile_result');
    return parsed;
  };
}
function preferencesPatch(current, changes) {
  const fields = ['appMode', 'mascot', 'animationStyle', 'loadUnit', 'heightUnit', 'coachVoice', 'communication', 'trainingDaysPerWeek', 'sessionMinutes', 'equipment', 'remindersEnabled'];
  const parsed = parsePreferences(current);
  keys(changes, fields);
  if (!Object.keys(changes).length) fail('invalid_fields');
  parsePreferences({ ...parsed, ...changes });
  return detached({ ...changes, expectedRevision: parsed.revision });
}
function planFields(input, partial = false) {
  keys(input, ['name', 'minutes', 'items'], partial ? [] : ['name', 'minutes', 'items']);
  if (!Object.keys(input).length || ('name' in input && !text(input.name, 100)) || ('minutes' in input && !integer(input.minutes, 5, 180))) fail('invalid_fields');
  if ('items' in input) {
    if (!Array.isArray(input.items) || input.items.length < 1 || input.items.length > 50) fail('invalid_fields');
    const ids = new Set();
    for (const item of input.items) {
      keys(item, ['id', 'exerciseId', 'setTarget', 'repMin', 'repMax', 'targetKg'], ['id', 'exerciseId', 'setTarget', 'repMin', 'repMax', 'targetKg']);
      resourceId(item.id); resourceId(item.exerciseId);
      if (ids.has(item.id) || !integer(item.setTarget, 1, 20) || !integer(item.repMin, 1, 100) || !integer(item.repMax, item.repMin, 100) || !Number.isFinite(item.targetKg) || item.targetKg < 0 || item.targetKg > 500) fail('invalid_fields');
      ids.add(item.id);
    }
  }
  return detached(input);
}
function setFields(input, create) {
  const fields = create ? ['occurrenceId', 'setNumber', 'reps', 'weightKg', 'status'] : ['reps', 'weightKg', 'status'];
  keys(input, fields, fields);
  if (create) resourceId(input.occurrenceId);
  if ((create && !integer(input.setNumber, 1, 100)) || !integer(input.reps, create && input.status === 'draft' ? 0 : 1, 100) || !Number.isFinite(input.weightKg) || input.weightKg < 0 || input.weightKg > 500 || !['draft', 'confirmed'].includes(input.status)) fail('invalid_fields');
  return detached(input);
}
function parseSetResult(value) {
  keys(value, ['set', 'sessionRevision'], ['set', 'sessionRevision']);
  if (!revision(value.sessionRevision)) fail('invalid_set_result');
  return freeze({ set: parseSet(value.set), sessionRevision: value.sessionRevision });
}
const identified = (parser, id) => value => { const parsed = parser(value); if (parsed.id !== id) fail('invalid_resource_identity'); return parsed; };
function setResultFor(session, expected, creation = false) {
  expected = detached(expected);
  return value => {
    const result = parseSetResult(value);
    if (result.sessionRevision <= session.revision || result.set.occurrenceId !== expected.occurrenceId || result.set.reps !== expected.reps || result.set.weightKg !== expected.weightKg || result.set.status !== expected.status ||
        (creation ? result.set.setNumber !== expected.setNumber : result.set.id !== expected.id || result.set.revision <= expected.revision)) fail('invalid_set_result');
    return result;
  };
}
const sameIdentity = (a, b) => a && b && a.accountId === b.accountId && a.appAccountToken === b.appAccountToken;
const allowed = (path, method) => {
  if (method === 'GET') return ['/v1/me', '/v1/entitlements', '/v1/me/profile', '/v1/me/preferences', '/v1/plans', '/v1/stats', '/v1/exercises'].includes(path) || /^\/v1\/(plans|workout-sessions)\/[a-zA-Z0-9_-]{1,80}$/.test(path) || /^\/v1\/history\?limit=(?:[1-9]|[1-4][0-9]|50)(?:&before=[A-Za-z0-9_%.-]+)?$/.test(path);
  if (method === 'PATCH') return ['/v1/me/profile', '/v1/me/preferences'].includes(path) || /^\/v1\/plans\/[a-zA-Z0-9_-]{1,80}$/.test(path) || /^\/v1\/workout-sessions\/[a-zA-Z0-9_-]{1,80}\/sets\/[a-zA-Z0-9_-]{1,80}$/.test(path);
  return method === 'POST' && (['/v1/plans', '/v1/workout-sessions'].includes(path) || /^\/v1\/plans\/[a-zA-Z0-9_-]{1,80}\/archive$/.test(path) || /^\/v1\/workout-sessions\/[a-zA-Z0-9_-]{1,80}\/(sets|complete|sets\/[a-zA-Z0-9_-]{1,80}\/void)$/.test(path));
};

function client(options = {}, transportEnabled = false, sessionDispatch = null) {
  const runtime = validateRuntimeConfig(options.config, options.browserOrigin);
  let generation = 0, account = null, entitlements = null;
  let cache = new Map(), intents = new Map(), unknown = null;
  // Retain the physical barrier across invalidation: a dispatched cookie write cannot be cancelled locally.
  let barrier = Promise.resolve();
  const available = transportEnabled && runtime !== null;
  const idle = () => freeze({ status: available ? 'empty' : 'unavailable', data: null, error: null, pending: null });
  const snapshot = slot => slot ? cache.get(slot) ?? idle() : freeze({ status: available ? (account ? 'ready' : 'empty') : 'unavailable', account, entitlements, generation, resources: freeze(Object.fromEntries(cache)) });
  const publish = (slot, status, data = null, error = null, pending = null) => {
    const state = freeze({ status, data, error: error ? { code: error.code ?? error.message, status: error.status ?? null, effect: error.effect ?? 'none' } : null, pending });
    cache.set(slot, state); return state;
  };
  function clear() {
    generation++; account = null; entitlements = null; cache = new Map(); intents = new Map(); unknown = null;
    return snapshot();
  }
  const current = ticket => ticket === generation;
  const assertCurrent = ticket => { if (!current(ticket)) fail('stale_generation'); };
  function serialize(operation) {
    if (sessionDispatch) return sessionDispatch.run(operation);
    const result = barrier.then(operation); barrier = result.catch(() => {}); return result;
  }
  async function request(path, method = 'GET', body, key) {
    if (!available) fail('unavailable');
    if (!allowed(path, method)) fail('invalid_endpoint');
    let response;
    try {
      response = await options.fetchImpl(`${runtime.apiBase}${path}`, { method, credentials: 'include', cache: 'no-store', redirect: 'error',
        headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(key === undefined ? {} : { 'Idempotency-Key': key }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    } catch { throw new ResourceError('transport_failed', { effect: method === 'GET' ? 'none' : 'unknown' }); }
    if (!response || !Number.isInteger(response.status) || typeof response.json !== 'function') throw new ResourceError('invalid_response', { effect: method === 'GET' ? 'none' : 'unknown' });
    if (response.status < 200 || response.status >= 300) throw new ResourceError(response.status === 401 ? 'unauthenticated' : response.status === 409 ? 'conflict' : 'request_failed', { status: response.status, effect: method !== 'GET' && response.status >= 500 ? 'unknown' : 'none' });
    try { return await response.json(); } catch { throw new ResourceError('invalid_json', { effect: method === 'GET' ? 'none' : 'unknown' }); }
  }
  async function fence(ticket, identity) {
    assertCurrent(ticket);
    const me = parseMe(await request('/v1/me'));
    assertCurrent(ticket);
    if (!sameIdentity(me, identity)) { clear(); fail('account_changed'); }
  }
  async function bindIdentity() {
    clear(); const ticket = generation;
    if (!available) return snapshot();
    return serialize(async () => {
      try {
        assertCurrent(ticket);
        const first = parseMe(await request('/v1/me')); assertCurrent(ticket);
        const grants = parseEntitlements(await request('/v1/entitlements'), first); assertCurrent(ticket);
        const last = parseMe(await request('/v1/me')); assertCurrent(ticket);
        if (!sameIdentity(first, last)) fail('account_changed');
        account = first; entitlements = grants; return snapshot();
      } catch (error) {
        if (!current(ticket)) return snapshot();
        clear(); publish('identity', 'error', null, error); return snapshot();
      }
    });
  }
  function read(slot, path, parser, reconciliation = false, preserveUnknown = false) {
    const ticket = generation, identity = account;
    if (!available) return Promise.resolve(idle());
    if (!identity) return Promise.resolve(publish(slot, 'error', null, new ResourceError('identity_required')));
    const previous = cache.get(slot)?.data ?? null;
    if (preserveUnknown && unknown?.slot === slot) {
      publish(slot, 'unknown', previous, new ResourceError('unknown_intent_pending', { effect: 'unknown' }),
        detached({ path: unknown.path, method: unknown.method, body: unknown.body, key: null }));
    } else publish(slot, previous ? 'stale' : 'loading', previous);
    return serialize(async () => {
      try {
        await fence(ticket, identity);
        assertCurrent(ticket);
        const data = parser(await request(path));
        await fence(ticket, identity);
        if (!reconciliation && unknown?.slot === slot) return publish(slot, 'unknown', data, new ResourceError('unknown_intent_pending', { effect: preserveUnknown ? 'unknown' : 'none' }), detached({ path: unknown.path, method: unknown.method, body: unknown.body, key: unknown.key ?? null }));
        return publish(slot, Array.isArray(data.items) && data.items.length === 0 ? 'empty' : 'ready', data);
      } catch (error) {
        if (!current(ticket)) return snapshot(slot);
        const pending = preserveUnknown && unknown?.slot === slot ? unknown : null;
        if (pending) {
          if (error.status === 401) {
            clear();
            return publish(slot, 'unknown', null, new ResourceError('unauthenticated', { status: 401, effect: 'unknown' }));
          }
          return publish(slot, 'unknown', previous, new ResourceError(error.code ?? error.message, { status: error.status, effect: 'unknown' }),
            detached({ path: pending.path, method: pending.method, body: pending.body, key: null }));
        }
        if (error.status === 401) { clear(); return publish(slot, 'error', null, error); }
        return publish(slot, previous ? 'stale' : 'error', previous, error);
      }
    });
  }
  function write(slot, path, method, payload, parser, key, guard = () => {}, replayUnknown = true) {
    if (key !== undefined && (typeof key !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(key))) fail('invalid_key');
    const body = detached(payload), fingerprint = canonical({ path, method, body }), ticket = generation, identity = account;
    if (!available) return Promise.resolve(idle());
    if (!identity) return Promise.resolve(publish(slot, 'error', null, new ResourceError('identity_required')));
    const intentId = key === undefined ? `revision:${slot}` : `${method}:${path}:${key}`;
    const existing = intents.get(intentId);
    if (existing && existing.fingerprint !== fingerprint) fail('key_payload_conflict');
    const intent = existing ?? { fingerprint, body, key, slot, path, method, parser, guard, result: null };
    if (!existing) intents.set(intentId, intent);
    return serialize(async () => {
      if (!current(ticket)) return snapshot(slot);
      if (unknown && (unknown !== intent || !replayUnknown)) return publish(slot, 'unknown', cache.get(slot)?.data ?? null, new ResourceError('unknown_intent_pending', { effect: replayUnknown ? 'none' : 'unknown' }), detached({ path: unknown.path, method: unknown.method, body: unknown.body, key: unknown.key ?? null }));
      const previous = cache.get(slot)?.data ?? null;
      let dispatched = false;
      try {
        await fence(ticket, identity);
        if (intent.result) return intent.result;
        if (unknown !== intent) intent.guard();
        assertCurrent(ticket);
        publish(slot, 'loading', previous, null, detached({ path, method, body, key: key ?? null }));
        dispatched = true;
        const data = intent.parser(await request(path, method, intent.body, key));
        await fence(ticket, identity);
        if (unknown === intent) unknown = null;
        for (const [name, state] of cache) if (name !== slot && state.data) publish(name, 'stale', state.data);
        const result = publish(slot, 'ready', data); intent.result = result;
        if (key === undefined) intents.delete(intentId);
        return result;
      } catch (error) {
        if (!current(ticket)) return snapshot(slot);
        if (error.status === 401) { clear(); return publish(slot, dispatched ? 'unknown' : 'error', null, new ResourceError('unauthenticated', { status: 401, effect: dispatched ? 'unknown' : 'none' })); }
        // Successful HTTP with invalid schema or a lost post-write fence cannot establish the effect.
        const uncertain = dispatched && (error.effect === 'unknown' || error.status === null || error.status === undefined || error.status === 401);
        if (uncertain) {
          unknown = intent;
          return publish(slot, 'unknown', previous, new ResourceError(error.code ?? error.message, { status: error.status, effect: 'unknown' }), detached({ path, method, body: intent.body, key: key ?? null }));
        }
        if (unknown === intent) {
          return publish(slot, 'unknown', previous, error, detached({ path, method, body: intent.body, key: key ?? null }));
        }
        if (key === undefined) intents.delete(intentId);
        return publish(slot, error.status === 409 ? 'conflict' : 'error', previous, error);
      }
    });
  }
  function active(session, key) {
    const value = parseSession(session);
    if (value.status !== 'active' || (cache.get(`workout:${value.id}`)?.data?.status === 'completed' && !(unknown && key !== undefined && unknown.key === key))) fail('session_completed');
    return value;
  }
  const sessionGuard = session => () => { active(session); };
  function reconcileRevision(slot, path, parser, preserveUnknown = false) {
    const pending = unknown;
    return read(slot, path, parser, pending?.slot === slot && pending.key === undefined, preserveUnknown).then(state => {
      if (pending && unknown === pending && pending.slot === slot && pending.key === undefined && state.status === 'ready') {
        const { expectedRevision, ...changes } = pending.body;
        const matches = Object.entries(changes).every(([k, v]) => canonical(state.data[k]) === canonical(v));
        if (state.data.revision > expectedRevision) {
          unknown = null; intents.delete(`revision:${slot}`);
          return matches ? state : publish(slot, 'conflict', state.data, new ResourceError('reconciliation_conflict'));
        }
        return publish(slot, 'unknown', state.data, new ResourceError('unknown_intent_pending', { effect: preserveUnknown ? 'unknown' : 'none' }), detached({ path: pending.path, method: pending.method, body: pending.body, key: null }));
      }
      return state;
    });
  }
  return Object.freeze({ snapshot, clear, invalidate: clear, bindIdentity,
    profile: () => read('profile', '/v1/me/profile', parseProfile, false, true),
    saveProfile: (current, changes, ...extra) => {
      if (extra.length) fail('invalid_fields');
      const body = profilePatch(current, changes);
      // Profile has no keyed receipt: even an identical queued command must reconcile uncertainty first.
      return write('profile', '/v1/me/profile', 'PATCH', body, profileResult(body), undefined, undefined, false);
    },
    reconcileProfile: () => reconcileRevision('profile', '/v1/me/profile', parseProfile, true),
    reconcilePreferences: () => reconcileRevision('preferences', '/v1/me/preferences', parsePreferences),
    reconcilePlan: id => reconcileRevision(`plan:${resourceId(id)}`, `/v1/plans/${resourceId(id)}`, identified(parsePlan, id)),
    preferences: () => read('preferences', '/v1/me/preferences', parsePreferences),
    savePreferences: (current, changes, key) => write('preferences', '/v1/me/preferences', 'PATCH', preferencesPatch(current, changes), parsePreferences, key),
    plans: () => read('plans', '/v1/plans', parsePlans),
    plan: id => read(`plan:${resourceId(id)}`, `/v1/plans/${resourceId(id)}`, identified(parsePlan, id)),
    createPlan: (fields, key) => { if (key === undefined) fail('key_required'); return write('plans:create', '/v1/plans', 'POST', planFields(fields), parsePlan, key); },
    editPlan: (current, changes) => { const p = parsePlan(current); return write(`plan:${p.id}`, `/v1/plans/${resourceId(p.id)}`, 'PATCH', { ...planFields(changes, true), expectedRevision: p.revision }, identified(parsePlan, p.id)); },
    archivePlan: (current, key) => { const p = parsePlan(current); if (key === undefined) fail('key_required'); return write(`plan:${p.id}`, `/v1/plans/${resourceId(p.id)}/archive`, 'POST', { expectedRevision: p.revision }, identified(parsePlan, p.id), key); },
    workout: id => read(`workout:${resourceId(id)}`, `/v1/workout-sessions/${resourceId(id)}`, identified(parseSession, id)),
    startWorkout: (current, key) => { const p = parsePlan(current); if (key === undefined) fail('key_required'); return write('workout:start', '/v1/workout-sessions', 'POST', { planId: p.id, expectedPlanRevision: p.revision }, value => { const result = parseSession(value); if (result.planId !== p.id || result.planRevision !== p.revision) fail('invalid_session'); return result; }, key); },
    addSet: (session, fields, key) => { const s = active(session, key); if (key === undefined) fail('key_required'); return write(`sets:${s.id}`, `/v1/workout-sessions/${resourceId(s.id)}/sets`, 'POST', { ...setFields(fields, true), expectedRevision: s.revision }, setResultFor(s, fields, true), key, sessionGuard(s)); },
    editSet: (session, current, changes, key) => { const s = active(session, key), set = parseSet(current); if (key === undefined) fail('key_required'); return write(`sets:${s.id}`, `/v1/workout-sessions/${resourceId(s.id)}/sets/${resourceId(set.id)}`, 'PATCH', { ...setFields(changes, false), expectedRevision: set.revision }, setResultFor(s, { ...set, ...changes }), key, sessionGuard(s)); },
    voidSet: (session, current, key) => { const s = active(session, key), set = parseSet(current); if (key === undefined) fail('key_required'); return write(`sets:${s.id}`, `/v1/workout-sessions/${resourceId(s.id)}/sets/${resourceId(set.id)}/void`, 'POST', { expectedRevision: set.revision }, setResultFor(s, { ...set, status: 'voided' }), key, sessionGuard(s)); },
    completeWorkout: (session, key) => { const s = active(session, key); if (key === undefined) fail('key_required'); return write(`workout:${s.id}`, `/v1/workout-sessions/${resourceId(s.id)}/complete`, 'POST', { expectedRevision: s.revision }, identified(parseSession, s.id), key, sessionGuard(s)); },
    history: ({ before, limit = 20 } = {}) => { if (!integer(limit, 1, 50) || (before !== undefined && (typeof before !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(before)))) fail('invalid_history_query'); return read(`history:${before ?? ''}:${limit}`, `/v1/history?limit=${limit}${before === undefined ? '' : `&before=${encodeURIComponent(before)}`}`, parseHistory); },
    stats: () => read('stats', '/v1/stats', parseStats),
    exercises: () => read('exercises', '/v1/exercises', parseExercises),
  });
}

// The default has no activation option; configured source and synthetic tests are explicit factories.
export function createResourceClient(options) { return client(options, false); }
export function createConfiguredResourceClient(options) {
  const configured = configuredSessionOptions(options);
  return client(configured, true, configured.sessionDispatch);
}
export function createSyntheticResourceClient(options) {
  const runtime = validateRuntimeConfig(options?.config, options?.browserOrigin);
  if (!runtime || ![runtime.apiBase, runtime.verifiedBrowserOrigin].every(origin => new URL(origin).hostname.endsWith('.invalid')) || typeof options?.fetchImpl !== 'function' || options.fetchImpl === globalThis.fetch) fail('synthetic_transport_required');
  return client(options, true);
}
