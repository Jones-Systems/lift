import { parsePlan, parseProfile, parsePreferences, parseSession, parseSet } from '../resource-contract.mjs';

const clone = value => JSON.parse(JSON.stringify(value));
const canonical = value => JSON.stringify(value, (_, entry) => entry && typeof entry === 'object' && !Array.isArray(entry)
  ? Object.fromEntries(Object.keys(entry).sort().map(key => [key, entry[key]])) : entry);
const fail = (status, code) => { throw Object.assign(new Error(code), { status }); };
const requireRevision = (actual, expected) => { if (actual !== expected) fail(409, 'revision_conflict'); };
const requireFields = (body, allowed, required = allowed) => {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !allowed.includes(key)) ||
      required.some(key => !Object.hasOwn(body, key))) fail(422, 'invalid_fields');
};
const response = (body, status = 200) => {
  const saved = clone(body);
  return Object.freeze({ ok: status >= 200 && status < 300, status, json: async () => clone(saved) });
};
const identities = Object.freeze({ primary: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', alternate: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' });
const scenarios = new Set(['normal', 'empty', 'read-error', 'conflict', 'lost-write-response', 'revoked-membership', 'account-switch', 'malformed-response']);
const catalog = [
  ['goblet-squat', 'Goblet squat', 'One dumbbell'],
  ['floor-press', 'Dumbbell floor press', 'Each dumbbell'],
  ['supported-row', 'One-arm dumbbell row', 'Each side; one dumbbell'],
  ['dumbbell-hinge', 'Dumbbell Romanian deadlift', 'Each dumbbell'],
  ['calf-raise', 'Standing calf raise', 'Bodyweight; added weight'],
].map(([id, name, loadLabel]) => ({ id, name, loadLabel, retired: false,
  provenance: { qualification: 'Fictional sample catalog; names match the retained catalog, not a training recommendation.' },
  requiredConstraints: [], cues: [] }));

// Isolated fictional memory only. Consumer fencing/reset obligations live in member/transport.md.
export function createSampleTransport({ now = () => Date.now(), seed = 1, plus = false } = {}) {
  if (typeof now !== 'function' || !Number.isSafeInteger(seed) || seed < 0 || typeof plus !== 'boolean') throw new TypeError('invalid_sample_options');
  let serial = 0, epoch = 0, lastTime = -Infinity, selected = 'primary', signedIn = true, fault = null;
  let accounts = new Map();
  const calls = [];
  const stamp = () => {
    const value = new Date(now()).getTime();
    if (!Number.isFinite(value)) throw new TypeError('invalid_sample_clock');
    lastTime = Math.max(lastTime, value);
    return new Date(lastTime).toISOString();
  };
  const newId = kind => `sample_${seed}_${epoch}_${kind}_${++serial}`;
  const current = () => accounts.get(selected);
  const identity = () => ({ accountId: identities[selected], appAccountToken: identities[selected] });
  const lookup = (map, id) => map.get(id) ?? fail(404, 'not_found');
  function validateItems(account, planId, items) {
    for (const item of items) {
      if (!catalog.some(exercise => exercise.id === item.exerciseId && !exercise.retired)) fail(422, 'invalid_exercise');
      const original = account.itemIds.get(`${planId}:${item.id}`);
      if (original && original !== item.exerciseId) fail(409, 'item_identity_conflict');
    }
  }
  const retainItems = (account, plan) => plan.items.forEach(item => account.itemIds.set(`${plan.id}:${item.id}`, item.exerciseId));
  function makeSession(plan, startedAt) {
    return { id: newId('workout'), planId: plan.id, planRevision: plan.revision, revision: 1, status: 'active',
      planSnapshot: clone(plan), occurrences: plan.items.map((item, position) => ({ id: newId('occurrence'),
        itemId: item.id, exerciseId: item.exerciseId, position, target: clone(item) })), sets: [], startedAt, completedAt: null };
  }
  function makeAccount(name, empty = false) {
    const date = stamp();
    const account = { profile: { revision: 0, name, age: null, heightCm: null, weightKg: null,
      trainingBackground: 'returning', injuryHistory: '', goals: ['Explore the fictional sample'], trainingContext: 'Sample data only' },
    preferences: { revision: 0, appMode: 'basic', mascot: 'none', animationStyle: 'short', loadUnit: 'kg', heightUnit: 'cm',
      coachVoice: 'calm', communication: 'concise', trainingDaysPerWeek: 3, sessionMinutes: 30, equipment: ['Dumbbells'], remindersEnabled: false },
    plus, hadPlus: plus, grantDate: date, plans: new Map(), workouts: new Map(), receipts: new Map(), itemIds: new Map(), cursors: new Map() };
    if (!empty) {
      const earlier = new Date(Date.parse(date) - 3 * 86400000).toISOString();
      const plan = { id: newId('plan'), revision: 1, name: 'Sample full-body session', minutes: 30, archived: false,
        createdAt: earlier, updatedAt: earlier, items: [
          { id: 'sample_squat', exerciseId: 'goblet-squat', setTarget: 3, repMin: 6, repMax: 8, targetKg: 16 },
          { id: 'sample_row', exerciseId: 'supported-row', setTarget: 2, repMin: 8, repMax: 10, targetKg: 12 },
        ] };
      account.plans.set(plan.id, plan); retainItems(account, plan);
      for (const daysAgo of [2, 1]) {
        const startedAt = new Date(Date.parse(date) - daysAgo * 86400000).toISOString();
        const session = makeSession(plan, startedAt);
        session.sets = session.occurrences.map((occurrence, index) => ({ id: newId('set'), occurrenceId: occurrence.id,
          setNumber: 1, revision: 1, reps: index ? 8 : 6, weightKg: index ? 10 : 12, status: 'confirmed',
          createdAt: startedAt, updatedAt: startedAt }));
        session.revision = 4; session.status = 'completed';
        session.completedAt = new Date(Date.parse(startedAt) + 20 * 60000).toISOString();
        parseSession(session); account.workouts.set(session.id, session);
      }
    }
    return account;
  }
  function reset() {
    epoch++; serial = 0; selected = 'primary'; signedIn = true; fault = null; calls.length = 0;
    accounts = new Map([['primary', makeAccount('Alex · fictional sample')], ['alternate', makeAccount('Sam · fictional sample')]]);
  }
  function switchAccount(account = selected === 'primary' ? 'alternate' : 'primary') {
    if (!Object.hasOwn(identities, account)) throw new TypeError('unknown_sample_account');
    selected = account; signedIn = true; fault = null;
  }
  function setPlus(enabled) {
    if (typeof enabled !== 'boolean') throw new TypeError('invalid_sample_membership');
    current().plus = enabled; current().hadPlus ||= enabled;
  }
  function setScenario(name) {
    if (!scenarios.has(name)) throw new TypeError('unknown_sample_scenario');
    fault = null;
    if (name === 'empty') accounts.set(selected, makeAccount(selected === 'primary' ? 'Alex · fictional sample' : 'Sam · fictional sample', true));
    else if (name === 'revoked-membership') { current().hadPlus = true; setPlus(false); }
    else if (name === 'account-switch') switchAccount();
    else if (name !== 'normal') fault = name;
  }
  function totals(account) {
    const byExercise = new Map(); let completedSessions = 0;
    for (const session of account.workouts.values()) {
      if (session.status === 'completed') completedSessions++;
      for (const set of session.sets.filter(value => value.status === 'confirmed')) {
        const exerciseId = session.occurrences.find(value => value.id === set.occurrenceId).exerciseId;
        const entry = byExercise.get(exerciseId) ?? { exerciseId, confirmedSets: 0, repetitions: 0, volumeKg: 0, maxWeightKg: 0 };
        entry.confirmedSets++; entry.repetitions += set.reps; entry.volumeKg += set.reps * set.weightKg;
        entry.maxWeightKg = Math.max(entry.maxWeightKg, set.weightKg); byExercise.set(exerciseId, entry);
      }
    }
    const rows = [...byExercise.values()].sort((a, b) => a.exerciseId.localeCompare(b.exerciseId));
    const sum = field => rows.reduce((total, entry) => total + entry[field], 0);
    return { confirmedSets: sum('confirmedSets'), repetitions: sum('repetitions'), volumeKg: sum('volumeKg'), completedSessions,
      byExercise: rows, units: { load: 'kg', volume: 'kg-repetitions' }, includesActiveConfirmedSets: true };
  }
  function read(account, url) {
    const path = url.pathname;
    if (path === '/v1/me') return { ...identity(), profile: account.profile, preferences: account.preferences,
      onboarding: { revision: 1, status: 'completed' } };
    if (path === '/v1/entitlements') return { ...identity(), grants: account.hadPlus ? [{ id: 'sample_promo', entitlement: 'form_plus',
      source: 'promo', environment: 'zero_charge', grantedAt: account.grantDate,
      expiresAt: new Date(Date.parse(account.grantDate) + 365 * 86400000).toISOString(), active: account.plus }] : [],
    active: account.plus ? ['form_plus'] : [], purchases: { status: 'unconfigured', environment: 'Sandbox', chargesEnabled: false,
      verification: 'apple_jws_offline', onlineCertificateRevocation: false } };
    if (path === '/v1/me/profile') return account.profile;
    if (path === '/v1/me/preferences') return account.preferences;
    if (path === '/v1/exercises') return { items: catalog };
    if (path === '/v1/plans') return { items: [...account.plans.values()].sort((a, b) => a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1) };
    if (/^\/v1\/plans\/[a-zA-Z0-9_-]+$/.test(path)) return lookup(account.plans, path.split('/')[3]);
    if (/^\/v1\/workout-sessions\/[a-zA-Z0-9_-]+$/.test(path)) return lookup(account.workouts, path.split('/')[3]);
    if (path === '/v1/stats') return totals(account);
    if (path === '/v1/history') {
      const limit = Number(url.searchParams.get('limit') ?? 20), before = url.searchParams.get('before');
      if (!Number.isInteger(limit) || limit < 1 || limit > 50) fail(422, 'invalid_limit');
      const cursor = before === null ? null : account.cursors.get(before);
      if (before !== null && !cursor) fail(422, 'invalid_cursor');
      const rows = [...account.workouts.values()].filter(value => !cursor || value.startedAt < cursor.startedAt ||
        (value.startedAt === cursor.startedAt && value.id < cursor.id))
        .sort((a, b) => a.startedAt > b.startedAt ? -1 : a.startedAt < b.startedAt ? 1 : a.id > b.id ? -1 : 1);
      const items = rows.slice(0, limit); let nextBefore = null;
      if (rows.length > limit) {
        const last = items.at(-1); nextBefore = `cursor_${last.id}`;
        account.cursors.set(nextBefore, { startedAt: last.startedAt, id: last.id });
      }
      return { items, nextBefore };
    }
    fail(404, 'not_found');
  }
  function mutate(account, path, method, body) {
    const date = stamp();
    if (method === 'PATCH' && ['/v1/me/profile', '/v1/me/preferences'].includes(path)) {
      const slot = path.endsWith('profile') ? 'profile' : 'preferences', previous = account[slot];
      const fields = Object.keys(previous).filter(key => key !== 'revision');
      requireFields(body, [...fields, 'expectedRevision'], ['expectedRevision']);
      if (Object.keys(body).length < 2) fail(422, 'invalid_fields');
      requireRevision(previous.revision, body.expectedRevision);
      const { expectedRevision, ...changes } = body;
      const next = { ...previous, ...changes, revision: previous.revision + 1 };
      if (slot === 'profile') {
        for (const key of ['name', 'trainingContext', 'injuryHistory']) if (Object.hasOwn(changes, key) && typeof next[key] === 'string') next[key] = next[key].trim();
        if (Object.hasOwn(changes, 'goals') && Array.isArray(next.goals)) next.goals = next.goals.map(value => typeof value === 'string' ? value.trim() : value);
        parseProfile(next);
      } else parsePreferences(next);
      account[slot] = next; return { status: 200, body: next };
    }
    if (method === 'POST' && path === '/v1/plans') {
      requireFields(body, ['name', 'minutes', 'items']);
      const plan = { ...body, name: typeof body.name === 'string' ? body.name.trim() : body.name,
        id: newId('plan'), revision: 1, archived: false, createdAt: date, updatedAt: date };
      parsePlan(plan); validateItems(account, plan.id, plan.items);
      account.plans.set(plan.id, plan); retainItems(account, plan); return { status: 201, body: plan };
    }
    const planMatch = path.match(/^\/v1\/plans\/([a-zA-Z0-9_-]+)(\/archive)?$/);
    if (planMatch && ((method === 'PATCH' && !planMatch[2]) || (method === 'POST' && planMatch[2]))) {
      const previous = lookup(account.plans, planMatch[1]);
      requireFields(body, planMatch[2] ? ['expectedRevision'] : ['name', 'minutes', 'items', 'expectedRevision'], ['expectedRevision']);
      if (!planMatch[2] && Object.keys(body).length < 2) fail(422, 'invalid_fields');
      requireRevision(previous.revision, body.expectedRevision);
      if (previous.archived) fail(409, 'plan_archived');
      const { expectedRevision, ...changes } = body;
      const plan = { ...previous, ...changes, revision: previous.revision + 1, updatedAt: date, archived: !!planMatch[2] };
      if (typeof plan.name === 'string') plan.name = plan.name.trim();
      parsePlan(plan); validateItems(account, plan.id, plan.items);
      account.plans.set(plan.id, plan); retainItems(account, plan); return { status: 200, body: plan };
    }
    if (method === 'POST' && path === '/v1/workout-sessions') {
      requireFields(body, ['planId', 'expectedPlanRevision']);
      const plan = lookup(account.plans, body.planId); requireRevision(plan.revision, body.expectedPlanRevision);
      if (plan.archived) fail(409, 'plan_archived');
      const session = makeSession(plan, date); parseSession(session);
      account.workouts.set(session.id, session); return { status: 201, body: session };
    }
    const match = path.match(/^\/v1\/workout-sessions\/([a-zA-Z0-9_-]+)\/(complete|sets)(?:\/([a-zA-Z0-9_-]+)(\/void)?)?$/);
    if (!match) fail(404, 'not_found');
    const [, sessionId, action, setId, voiding] = match;
    if ((method !== 'POST' && method !== 'PATCH') || (action === 'complete' && (method !== 'POST' || setId)) ||
        (action === 'sets' && (method === 'PATCH' ? (!setId || voiding) : (setId && !voiding)))) fail(404, 'not_found');
    const session = clone(lookup(account.workouts, sessionId));
    if (session.status !== 'active') fail(409, 'session_completed');
    if (action === 'complete') {
      requireFields(body, ['expectedRevision']); requireRevision(session.revision, body.expectedRevision);
      session.status = 'completed'; session.completedAt = date; session.revision++;
      parseSession(session); account.workouts.set(sessionId, session); return { status: 200, body: session };
    }
    let set;
    if (!setId) {
      requireFields(body, ['occurrenceId', 'setNumber', 'reps', 'weightKg', 'status', 'expectedRevision']);
      requireRevision(session.revision, body.expectedRevision);
      if (!session.occurrences.some(value => value.id === body.occurrenceId)) fail(404, 'not_found');
      if (session.sets.some(value => value.occurrenceId === body.occurrenceId && value.setNumber === body.setNumber)) fail(409, 'set_number_exists');
      const { expectedRevision, ...fields } = body;
      set = { ...fields, id: newId('set'), revision: 1, createdAt: date, updatedAt: date };
      session.sets.push(set);
    } else {
      requireFields(body, voiding ? ['expectedRevision'] : ['reps', 'weightKg', 'status', 'expectedRevision']);
      if (!voiding && (!Number.isInteger(body.reps) || body.reps < 1)) fail(422, 'invalid_repetitions');
      set = session.sets.find(value => value.id === setId) ?? fail(404, 'not_found');
      requireRevision(set.revision, body.expectedRevision);
      if (set.status === 'voided') fail(409, 'set_voided');
      const { expectedRevision, ...changes } = body;
      Object.assign(set, changes, { status: voiding ? 'voided' : changes.status, revision: set.revision + 1, updatedAt: date });
    }
    if (!voiding && !['draft', 'confirmed'].includes(set.status)) fail(422, 'invalid_set_status');
    parseSet(set); session.revision++; parseSession(session);
    account.workouts.set(sessionId, session); return { status: setId ? 200 : 201, body: { set, sessionRevision: session.revision } };
  }
  async function fetchImpl(input, init = {}) {
    const url = new URL(input);
    if (url.origin !== 'https://api.invalid' || url.username || url.password || url.hash) throw new TypeError('sample_origin_required');
    const method = init.method ?? 'GET', path = url.pathname;
    const headers = new Headers(init.headers);
    if (headers.has('authorization') || headers.has('cookie')) throw new TypeError('sample_credentials_forbidden');
    if (init.signal?.aborted) throw new Error('sample_request_aborted');
    if (path.startsWith('/api/auth/') && path !== '/api/auth/sign-out') return response({ error: 'not_found' }, 404);
    if ([...url.searchParams.keys()].some(key => path !== '/v1/history' || !['limit', 'before'].includes(key))) return response({ error: 'invalid_query' }, 422);
    const key = headers.get('idempotency-key');
    let body;
    try { body = init.body === undefined ? undefined : JSON.parse(init.body); }
    catch { return response({ error: 'invalid_json' }, 422); }
    calls.push(Object.freeze({ path: path + url.search, method, accountId: signedIn ? identities[selected] : null,
      key, ...(body === undefined ? {} : { body: clone(body) }) }));
    if (method === 'GET' && path === '/v1/capabilities') return response({ authentication: {
      emailPassword: { status: 'configured_unverified', registration: 'closed', passwordRecovery: 'unconfigured', emailChange: 'unconfigured' },
      session: { transport: 'signed_bearer_or_cookie', expiresInSeconds: 604800 } } });
    if (method === 'POST' && path === '/api/auth/sign-out') { signedIn = false; fault = null; return response({ success: true }); }
    if (!signedIn) return response({ error: 'unauthenticated' }, 401);
    const account = current();
    const resourceRead = method === 'GET' && !['/v1/me', '/v1/entitlements'].includes(path);
    if (resourceRead && fault === 'read-error') { fault = null; return response({ error: 'sample_read_failed' }, 503); }
    if (resourceRead && fault === 'malformed-response') { fault = null; return response({ malformed: true }); }
    if (method !== 'GET' && fault === 'conflict') { fault = null; return response({ error: 'revision_conflict' }, 409); }
    let result;
    try {
      if (method === 'GET') return response(read(account, url));
      const keyed = (method === 'POST' && (path === '/v1/plans' || path === '/v1/workout-sessions' || /^\/v1\/(plans|workout-sessions)\//.test(path))) ||
        (method === 'PATCH' && (/^\/v1\/workout-sessions\/.+\/sets\//.test(path) || (path === '/v1/me/preferences' && key !== null)));
      if (keyed && (key === null || !/^[a-zA-Z0-9_-]{1,128}$/.test(key))) fail(422, 'idempotency_key_required');
      const receiptId = `${method}:${path}:${key}`, fingerprint = canonical(body);
      const receipt = keyed ? account.receipts.get(receiptId) : null;
      if (receipt) {
        if (receipt.fingerprint !== fingerprint) fail(409, 'idempotency_conflict');
        result = clone(receipt.result);
      } else {
        result = mutate(account, path, method, body);
        if (keyed) account.receipts.set(receiptId, { fingerprint, result: clone(result) });
      }
    } catch (error) { return response({ error: error.message }, error.status ?? 422); }
    // Commit and receipt precede the injected loss; only explicit exact replay can recover it.
    if (fault === 'lost-write-response') { fault = null; throw new Error('sample_response_lost_after_write'); }
    return response(result.body, result.status);
  }
  reset();
  return Object.freeze({ fetchImpl, reset, calls, setScenario, signout: () => { signedIn = false; fault = null; }, switchAccount, setPlus,
    runtimeQualified: false });
}
