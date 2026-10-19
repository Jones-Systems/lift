const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const ts = require('typescript');

const compiled = new Map();
function load(relative, requireModule) {
  const file = resolve(__dirname, '..', relative);
  if (!compiled.has(file)) compiled.set(file, ts.transpileModule(readFileSync(file, 'utf8'), {
    fileName: file,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText);
  const module = { exports: {} };
  new Function('require', 'module', 'exports', compiled.get(file))(requireModule, module, module.exports);
  return module.exports;
}
const unexpected = name => { throw new Error(`Unexpected runtime import: ${name}`); };
const { ApiError } = load('../../api/transport.ts', unexpected);
const codec = load('../../api/trainingCodec.ts', name => name === './transport' ? { ApiError } : unexpected(name));
const { createSourceTrainingResources } = load('../../api/sourceTrainingResources.ts', name =>
  name === './transport' ? { ApiError } : name === './trainingCodec' ? codec : unexpected(name));
const copy = load('../shared/copy.ts', name => name === '../../api/client' ? { ApiError } : unexpected(name));
const drain = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const unknown = () => new ApiError(0, 'network_unavailable', 'Response lost', true);
const item = (changes = {}) => ({ id: 'item-1', exerciseId: 'goblet-squat', setTarget: 3, repMin: 8, repMax: 10, targetKg: 20, ...changes });
const plan = (changes = {}) => ({ id: 'plan-1', revision: 4, name: 'My plan', minutes: 30, items: [item()], archived: false,
  createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', ...changes });
const exercise = { id: 'goblet-squat', name: 'Goblet squat', retired: false };

function fixture(initial = plan(), overrides = {}) {
  const calls = { create: [], edit: [], read: 0, acquire: 0, saved: [], back: 0, unauthenticated: 0 };
  let authCurrent = true;
  const resources = {
    api: { captureAuthContext: () => ({ isCurrent: () => authCurrent }) },
    createPlan: async fields => plan({ ...fields, revision: 1 }),
    editPlan: async (base, body) => ({ ...base, ...body, revision: base.revision + 1 }),
    plans: async () => ({ items: [plan({ revision: 8 })] }),
    ...overrides,
  };
  for (const method of ['createPlan', 'editPlan']) {
    const invoke = resources[method];
    resources[method] = (...args) => { calls[method === 'createPlan' ? 'create' : 'edit'].push(args); return invoke(...args); };
  }
  const readPlans = resources.plans;
  resources.plans = () => assert.fail('The reconciliation reader must use the closed source-training port');
  const assertCurrent = () => { if (!authCurrent) throw new ApiError(409, 'session_changed', 'Synthetic stale session'); };
  resources.sourceTraining = async () => {
    calls.acquire++; assertCurrent();
    if (overrides.acquire) await overrides.acquire();
    assertCurrent();
    return createSourceTrainingResources(() => { calls.read++; return readPlans(); }, assertCurrent);
  };
  // Drive the real screen's callbacks with persistent hook slots; rendering, gestures and layout are outside this seam.
  const slots = []; const cleanups = []; let cursor = 0; let key = 0;
  const react = {
    useState(value) {
      const index = cursor++;
      slots[index] ??= { value: typeof value === 'function' ? value() : value };
      return [slots[index].value, next => { slots[index].value = typeof next === 'function' ? next(slots[index].value) : next; }];
    },
    useRef(value) { const index = cursor++; return slots[index] ??= { current: value }; },
    useMemo: fn => fn(), useCallback: fn => fn,
    useEffect(effect) { const index = cursor++; if (!slots[index]) { slots[index] = true; cleanups.push(effect()); } },
  };
  const client = { ApiError, commandKey: () => `plan-command-${++key}` };
  const commands = load('../shared/commands.ts', name => {
    if (name === 'react') return react;
    if (name === '../../api/client') return client;
    return unexpected(name);
  });
  const ui = Object.fromEntries(['AccountRow', 'Fields', 'Gutter', 'MetaLine', 'Nav', 'Notice', 'Panel', 'PlainAction',
    'PrimaryAction', 'Screen', 'Section', 'Sheet', 'StepperField', 'Subtitle', 'Title', 'Txt'].map(name => [name, name]));
  const tokens = { t: { space: {}, color: {}, stroke: {}, radius: {}, type: { sectionTitle: {} } },
    L: { movementRow: {}, plainAction: {}, icon: {} } };
  const { PlanEditScreen } = load('PlansScreens.tsx', name => {
    if (name === 'react') return react;
    if (name === 'react/jsx-runtime') return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }), Fragment: 'Fragment' };
    if (name === 'react-native') return { Pressable: 'Pressable', View: 'View', StyleSheet: { create: value => value } };
    if (name === '../../api/client') return client;
    if (name === '../shared/commands') return commands;
    if (name === '../shared/copy') return copy;
    if (name === '../shared/icons') return { Icon: 'Icon' };
    if (name === '../shared/tokens') return tokens;
    if (name === '../shared/ui') return ui;
    if (name === '../onboarding/model') return { KG_PER_LB: 0.45359237 };
    return unexpected(name);
  });
  const read = () => {
    cursor = 0;
    return PlanEditScreen({ resources, plan: initial, exercises: [exercise], appMode: 'advanced', loadUnit: 'kg', defaultMinutes: 30,
      onBack: () => calls.back++, onSaved: value => calls.saved.push(value), onUnauthenticated: () => calls.unauthenticated++ });
  };
  return { read, calls, expireAuth: () => { authCurrent = false; }, unmount: () => cleanups.forEach(cleanup => cleanup?.()) };
}

function nodes(value) {
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap(nodes);
  return [...(value.type ? [value] : []), ...Object.values(value.props ?? {}).flatMap(nodes)];
}
function find(tree, predicate) {
  const node = nodes(tree).find(predicate);
  assert.ok(node, 'Expected screen control is present');
  return node.props;
}
const control = (read, id) => find(read(), node => node.props.captureId === id || node.props.testID === id);
const movement = read => find(read(), node => node.type.name === 'MovementSheet');
const nav = read => find(read(), node => node.type === 'Nav');
const retry = read => find(read(), node => node.type === 'Notice').action.onPress;
const done = read => control(read, 'a-plan-done').onPress();
function edit(read, patch = {}) {
  control(read, 'a-plan-move-1').onPress();
  const sheet = movement(read); sheet.onSave({ ...sheet.editing.item, ...patch });
}
function add(read) {
  find(read(), node => node.type === 'AccountRow' && node.props.label === 'Goblet squat').onPress();
  const sheet = movement(read); sheet.onSave(sheet.editing.item);
}

test('unknown create keeps the original intent despite Done, stale sheet edits, picker and Back', async () => {
  const { read, calls } = fixture(null, { createPlan: async () => { throw unknown(); } });
  add(read); control(read, 'a-plan-move-1').onPress(); const staleSheet = movement(read);
  done(read); await drain();
  assert.equal(calls.create.length, 1);
  staleSheet.onSave({ ...staleSheet.editing.item, setTarget: 8 });
  control(read, 'a-plan-add').onPress(); nav(read).onBack(); done(read); await drain();
  assert.equal(calls.create.length, 1, 'A new command cannot replace unknown creation');
  assert.equal(calls.back, 0, 'Back cannot discard the retained command');
  assert.equal(movement(read).editing?.item.setTarget ?? calls.create[0][0].items[0].setTarget, 3);
  assert.equal(find(read(), node => node.type === 'Sheet' && node.props.testID === 'a-pick-sheet').visible, false);
});

test('pending edit freezes the submitted item body and blocks stale callbacks until it settles', async () => {
  const pending = deferred(); const { read, calls } = fixture(plan(), { editPlan: () => pending.promise });
  control(read, 'a-plan-move-1').onPress(); const sheet = movement(read);
  const submitted = { ...sheet.editing.item, repMax: 12 }; sheet.onSave(submitted);
  const oldDone = control(read, 'a-plan-done').onPress;
  oldDone(); oldDone(); submitted.repMax = 99;
  sheet.onRemove(submitted.id); nav(read).onBack();
  try {
    assert.equal(calls.edit.length, 1); assert.equal(calls.edit[0][1].items[0].repMax, 12);
    assert.equal(calls.back, 0); assert.ok(nodes(read()).some(node => node.props.testID === 'a-plan-move-1'));
  } finally { pending.resolve(plan({ revision: 5, items: [item({ repMax: 12 })] })); await drain(); }
  assert.equal(calls.saved.length, 1);
});

test('unknown create retains its same-key retry after later 422/500 rejection and then saves once', async () => {
  for (const rejection of [new ApiError(422, 'invalid_plan', 'Rejected'), new ApiError(500, 'server_error', 'Unavailable')]) {
    let attempts = 0;
    const { read, calls } = fixture(null, { createPlan: async fields => {
      if (++attempts === 1) throw unknown();
      if (attempts === 2) throw rejection;
      return plan({ ...fields, revision: 1 });
    } });
    add(read); done(read); await drain();
    const first = calls.create[0]; retry(read)(); await drain();
    assert.equal(typeof retry(read), 'function'); nav(read).onBack(); done(read); await drain();
    assert.equal(calls.back, 0); assert.equal(calls.create.length, 2);
    retry(read)(); await drain();
    assert.equal(calls.saved.length, 1); assert.equal(calls.create.length, 3);
    for (const request of calls.create) assert.deepEqual(request, first);
  }
});

test('edit stale readback retains local edits and requires explicit reconfirmation against latest revision', async () => {
  let attempts = 0;
  const { read, calls } = fixture(plan(), { editPlan: async (base, body) => {
    if (++attempts === 1) throw unknown();
    if (attempts === 2) throw new ApiError(409, 'stale_revision', 'Changed');
    return { ...base, ...body, revision: base.revision + 1 };
  } });
  edit(read, { repMax: 12 }); done(read); await drain(); retry(read)(); await drain();
  assert.equal(calls.read, 1); assert.equal(calls.saved.length, 0); assert.equal(calls.edit.length, 2);
  assert.match(find(read(), node => node.type === 'MetaLine').items.join(' '), /12/);
  done(read); await drain();
  assert.deepEqual(calls.edit.map(([base]) => base.revision), [4, 4, 8]);
  assert.deepEqual(calls.edit.map(([, body]) => body.items[0].repMax), [12, 12, 12]);
  assert.equal(calls.saved.length, 1);
});

test('definite first create failure releases intent for edited fields and a fresh key', async () => {
  let attempts = 0;
  const { read, calls } = fixture(null, { createPlan: async fields => {
    if (++attempts === 1) throw new ApiError(422, 'invalid_plan', 'Rejected');
    return plan({ ...fields, revision: 1 });
  } });
  add(read); done(read); await drain(); edit(read, { setTarget: 4 }); done(read); await drain();
  assert.equal(calls.create.length, 2); assert.notEqual(calls.create[0][1], calls.create[1][1]);
  assert.deepEqual(calls.create.map(([body]) => body.items[0].setTarget), [3, 4]); assert.equal(calls.saved.length, 1);
});

test('repeated unknown retry is single-flight and cannot be replaced through Done', async () => {
  const pending = deferred(); let attempts = 0;
  const { read, calls } = fixture(null, { createPlan: fields => ++attempts === 1 ? Promise.reject(unknown()) : pending.promise });
  add(read); done(read); await drain(); const again = retry(read); again(); again(); done(read); nav(read).onBack();
  try { assert.equal(calls.create.length, 2); assert.equal(calls.back, 0); }
  finally { pending.resolve(plan({ revision: 1 })); await drain(); }
  assert.equal(calls.saved.length, 1); assert.deepEqual(calls.create[1], calls.create[0]);
});

test('unknown edit with unavailable stale readback preserves the original retry and local draft', async () => {
  let attempts = 0;
  const { read, calls } = fixture(plan(), { editPlan: async () => {
    if (++attempts === 1) throw unknown();
    throw new ApiError(409, 'stale_revision', 'Changed');
  }, plans: async () => { throw new ApiError(0, 'network_unavailable', 'Offline'); } });
  edit(read, { repMax: 12 }); done(read); await drain(); retry(read)(); await drain();
  assert.equal(typeof retry(read), 'function'); nav(read).onBack(); done(read); await drain();
  assert.equal(calls.back, 0); assert.equal(calls.edit.length, 2); assert.equal(calls.saved.length, 0);
  assert.deepEqual(calls.edit[1], calls.edit[0]);
});

test('unmount discards late notifications and prevents stale Done or retry dispatch', async () => {
  const pending = deferred(); const { read, calls, unmount } = fixture(plan(), { editPlan: () => pending.promise });
  edit(read, { repMax: 12 }); const oldDone = control(read, 'a-plan-done').onPress;
  oldDone(); unmount(); pending.resolve(plan({ revision: 5 })); await drain(); oldDone(); await drain();
  assert.equal(calls.saved.length, 0); assert.equal(calls.edit.length, 1);
});

test('unchanged Done exits without sending a plan write', async () => {
  const { read, calls } = fixture(); done(read); await drain();
  assert.equal(calls.back, 1); assert.equal(calls.edit.length, 0); assert.equal(calls.create.length, 0);
});

function sourcePlan(id = 'source-plan') {
  const { minutes, ...base } = plan({ id });
  return { ...base, schema: 'form.source-prescription-plan/v1', origin: { kind: 'form-adaptation', id: 'synthetic-origin', revision: 'r1' },
    duration: { kind: 'estimated-range', minMinutes: 20, maxMinutes: 35 }, items: [{ id: 'source-item',
      native: { exercise_id: 'source-movement', movement_pattern: 'practice', role: 'practice', sets: 1, rest_seconds: 45 },
      registeredDomain: { exerciseId: 'domain-movement', variantId: 'variant:practice',
        identity: { repository: 'Synthetic/Source', revision: 'r1', path: 'native.json', sha256: 'a'.repeat(64), nativeId: 'source-movement' },
        registration: { id: 'synthetic-registration', revision: 'r1', digest: 'b'.repeat(64), bytes: 123 }, recordDigest: 'c'.repeat(64) },
      load: { kind: 'unspecified', basis: 'unknown' } }] };
}

test('closed mixed readback reconciles only the exact legacy plan without losing the submitted draft', async () => {
  let attempts = 0;
  const { read, calls } = fixture(plan(), {
    editPlan: async (base, body) => {
      if (++attempts === 1) throw new ApiError(409, 'stale_revision', 'Changed');
      return { ...base, ...body, revision: base.revision + 1 };
    }, plans: async () => ({ items: [sourcePlan(), plan({ revision: 8 })] }),
  });
  edit(read, { repMax: 12 }); done(read); await drain();
  assert.equal(calls.acquire, 1); assert.equal(calls.read, 1); assert.equal(calls.saved.length, 0);
  done(read); await drain();
  assert.deepEqual(calls.edit.map(([base]) => base.revision), [4, 8]);
  assert.equal(calls.saved[0].items[0].repMax, 12); assert.equal('schema' in calls.saved[0], false);
});

test('source replacement archived duplicate missing and malformed readbacks cannot settle an unknown legacy edit', async () => {
  const pages = [
    { items: [sourcePlan('plan-1')] }, { items: [plan({ archived: true })] }, { items: [plan(), plan()] },
    { items: [sourcePlan()] }, { items: [{ ...plan(), unexpected: true }] },
  ];
  for (const page of pages) {
    let attempts = 0;
    const { read, calls } = fixture(plan(), { plans: async () => page, editPlan: async () => {
      if (++attempts === 1) throw unknown();
      throw new ApiError(409, 'stale_revision', 'Changed');
    } });
    edit(read, { repMax: 12 }); done(read); await drain(); retry(read)(); await drain();
    assert.equal(calls.read, 1); assert.equal(calls.saved.length, 0); assert.equal(typeof retry(read), 'function');
    nav(read).onBack(); done(read); await drain(); assert.equal(calls.back, 0); assert.equal(calls.edit.length, 2);
    retry(read)(); await drain(); assert.deepEqual(calls.edit[2], calls.edit[0]);
  }
});

test('unmount during closed-port acquisition stops reconciliation before the read', async () => {
  const gate = deferred(), f = fixture(plan(), { acquire: () => gate.promise,
    editPlan: async () => { throw new ApiError(409, 'stale_revision', 'Changed'); } });
  try {
    edit(f.read, { repMax: 12 }); done(f.read); await drain();
    assert.equal(f.calls.edit.length, 1); assert.equal(f.calls.edit[0][1].items[0].repMax, 12);
    assert.equal(f.calls.acquire, 1); assert.equal(f.calls.read, 0); assert.equal(f.calls.back, 0);
  } finally { f.unmount(); gate.resolve(); await drain(); }
  assert.equal(f.calls.read, 0); assert.equal(f.calls.saved.length, 0); assert.equal(f.calls.unauthenticated, 0);
});

test('original auth loss before or during readback cannot promote a replacement revision', async () => {
  for (const duringRead of [false, true]) {
    const gate = deferred(), f = fixture(plan(), {
      editPlan: async () => {
        if (!duringRead) {
          assert.equal(f.calls.acquire, 0); assert.equal(f.calls.read, 0);
          f.expireAuth();
        }
        throw new ApiError(409, 'stale_revision', 'Changed');
      },
      plans: () => gate.promise,
    });
    try {
      edit(f.read, { repMax: 12 }); done(f.read); await drain();
      assert.equal(f.calls.edit.length, 1); assert.equal(f.calls.edit[0][1].items[0].repMax, 12);
      assert.equal(f.calls.back, 0); assert.equal(f.calls.acquire, duringRead ? 1 : 0);
      assert.equal(f.calls.read, duringRead ? 1 : 0); assert.equal(f.calls.saved.length, 0);
    } finally { f.expireAuth(); gate.resolve({ items: [plan({ revision: 99 })] }); await drain(); }
    assert.equal(f.calls.read, duringRead ? 1 : 0); assert.equal(f.calls.saved.length, 0);
    assert.equal(find(f.read(), node => node.type === 'Title').text, 'My plan');
  }
});
