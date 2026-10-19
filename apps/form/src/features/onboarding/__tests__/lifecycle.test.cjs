const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const ts = require('typescript');

// Execute the actual component callbacks and effects with controlled promises, without a native renderer or scratch.
function harness(file) {
  const slots = []; let cursor = 0; let effects = []; let props; let tree; let commandKeys = 0;
  const react = {
    useState(initial) {
      const i = cursor++;
      if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial;
      return [slots[i], value => { slots[i] = typeof value === 'function' ? value(slots[i]) : value; }];
    },
    useRef(initial) { const i = cursor++; return slots[i] ??= { current: initial }; },
    useCallback(fn, deps) { return react.useMemo(() => fn, deps); },
    useMemo(fn, deps) {
      const i = cursor++; const old = slots[i];
      if (!old || deps.some((value, n) => !Object.is(value, old.deps[n]))) slots[i] = { deps, value: fn() };
      return slots[i].value;
    },
    useEffect(fn, deps) {
      const i = cursor++; const old = slots[i];
      if (!old || deps.some((value, n) => !Object.is(value, old.deps[n]))) {
        effects.push(() => { old?.cleanup?.(); slots[i] = { deps, cleanup: fn() }; });
      }
    },
  };
  const jsx = (type, props) => ({ type, props: props ?? {} });
  let ApiError;
  const names = new Proxy({}, { get: (_, key) => key });
  const tokens = new Proxy(() => {}, { get: () => tokens });
  const cache = new Map();
  function load(path) {
    if (cache.has(path)) return cache.get(path);
    const mod = { exports: {} }; cache.set(path, mod.exports);
    const source = readFileSync(path, 'utf8');
    const compiled = ts.transpileModule(source, { fileName: path, compilerOptions: {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
    } }).outputText;
    const localRequire = name => {
      if (name === 'react') return react;
      if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx, Fragment: 'Fragment' };
      if (name === 'react-native') return { View: 'View', TextInput: 'TextInput', StyleSheet: { create: value => value } };
      if (name === 'react-native-svg') return { default: 'Svg', Circle: 'Circle', Path: 'Path' };
      if (name === 'react-native-reanimated') return { default: { createAnimatedComponent: value => value }, Easing: {},
        useSharedValue: value => ({ value }), useAnimatedStyle: fn => fn(), useAnimatedProps: fn => fn() };
      if (name.endsWith('/shared/ui')) return names;
      if (name.endsWith('/shared/icons')) return names;
      if (name.endsWith('/shared/tokens')) return { t: tokens, L: tokens };
      if (name.endsWith('/theme')) return { typeStyles: {}, useAccessibilityPrefs: () => ({ reduceMotion: true }) };
      if (name.endsWith('/api/client')) return { ApiError, commandKey: () => `synthetic-command-${++commandKeys}` };
      if (name.endsWith('/shared/copy')) return { COPY: { stale: 'Stale' }, errorCopy: error => error.message,
        speechUnavailableCopy: () => 'Unavailable', movementWord: () => '' };
      if (name === './VoiceSheet') return { VoiceSheet: 'VoiceSheet' };
      const target = resolve(path, '..', name);
      if (target === resolve(__dirname, '../../../api/client')) return { ApiError, formApi: null };
      return load(target + '.ts');
    };
    new Function('require', 'module', 'exports', compiled)(localRequire, mod, mod.exports);
    cache.set(path, mod.exports); return mod.exports;
  }
  ApiError = load(resolve(__dirname, '../../../api/transport.ts')).ApiError;
  const Component = load(resolve(__dirname, '..', file))[file.replace('.tsx', '')];
  function render(next = props) {
    props = next; cursor = 0; effects = []; tree = Component(props);
    for (const effect of effects) effect();
    return tree;
  }
  function find(predicate, node = tree) {
    if (!node || typeof node !== 'object') return null;
    if (Array.isArray(node)) { for (const child of node) { const found = find(predicate, child); if (found) return found; } return null; }
    if (predicate(node)) return node;
    if (typeof node.type === 'function' && node.type.name === 'Actions') return find(predicate, node.type(node.props));
    for (const key of ['children', 'actions', 'footer', 'nav', 'notice']) {
      const child = node.props?.[key];
      if (child === undefined) continue;
      const found = find(predicate, child); if (found) return found;
    }
    return null;
  }
  return { render, find, ApiError, loadModule: name => load(resolve(__dirname, '../../..', name)),
    dispose: () => { for (const slot of slots) slot?.cleanup?.(); }, id: id => find(node => node.props?.testID === id || node.props?.captureId === id) };
}
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function settle() { for (let n = 0; n < 12; n++) await Promise.resolve(); }
const available = { available: true, reason: 'available' };
function speechFixture(overrides = {}) {
  const calls = []; const observers = new Set();
  return { calls, emit: draft => { for (const observer of observers) observer(draft); },
    availability: async () => available, requestPermissions: async () => ({}),
    start: async () => { calls.push('start'); return 'current'; }, cancel: async () => { calls.push('cancel'); },
    stop: async () => {}, acceptReview: review => ({ text: review.text }),
    subscribe: observer => { observers.add(observer); return { remove: () => observers.delete(observer) }; }, ...overrides };
}
const draft = (sessionId, state = 'review') => ({ sessionId, state, text: 'Reviewed answer', error: null, isFinal: state === 'review', locale: 'en-US' });

test('a dismissed availability result cannot start capture after reopening', async () => {
  const h = harness('VoiceSheet.tsx'); const a = deferred(); const b = deferred(); let probes = 0;
  const speech = speechFixture({ availability: () => (++probes === 1 ? a : b).promise });
  const props = { visible: true, speech, onUse() {}, onClose() {} };
  h.render(props); h.render({ ...props, visible: false }); h.render(props);
  a.resolve(available); await settle();
  assert.equal(speech.calls.filter(call => call === 'start').length, 0);
  b.resolve(available); await settle();
  assert.equal(speech.calls.filter(call => call === 'start').length, 1);
});

test('old permission continuation cannot probe a new presentation', async () => {
  const h = harness('VoiceSheet.tsx'); const permission = deferred(); let probes = 0;
  const speech = speechFixture({ availability: async () => { probes++; return { available: false, reason: 'permission_required' }; },
    requestPermissions: () => permission.promise });
  const props = { visible: true, speech, onUse() {}, onClose() {} };
  h.render(props); await settle(); h.render(); h.id('a-voice-allow').props.onPress();
  h.render({ ...props, visible: false }); h.render(props); await settle();
  permission.resolve({}); await settle();
  assert.equal(probes, 2);
});

test('stale start rejection cannot replace the new presentation state', async () => {
  const h = harness('VoiceSheet.tsx'); const start = deferred(); const nextProbe = deferred(); let probes = 0;
  const speech = speechFixture({ availability: () => ++probes === 1 ? Promise.resolve(available) : nextProbe.promise,
    start: () => start.promise });
  const props = { visible: true, speech, onUse() {}, onClose() {} };
  h.render(props); await settle(); h.render({ ...props, visible: false }); h.render(props);
  start.reject(new Error('old start')); await settle(); h.render();
  assert.equal(h.find(node => node.type === 'Sheet').props.title, 'Answer with your voice');
});

test('only the started capture session enters editable review and explicit Use this', async () => {
  const h = harness('VoiceSheet.tsx'); const applied = []; const speech = speechFixture();
  h.render({ visible: true, speech, onUse: text => applied.push(text), onClose() {} }); await settle();
  speech.emit(draft('previous')); h.render(); assert.equal(h.id('a-voice-transcript'), null);
  speech.emit(draft('current')); h.render();
  h.id('a-voice-transcript').props.onChangeText('Manual correction'); h.render();
  assert.deepEqual(applied, []); h.id('a-voice-use').props.onPress();
  assert.deepEqual(applied, ['Manual correction']);
});

test('synchronous adapter drafts wait for the returned capture session before review', async () => {
  const h = harness('VoiceSheet.tsx'); const started = deferred();
  const speech = speechFixture({ start: () => {
    speech.emit(draft('previous')); speech.emit(draft('current'));
    return started.promise;
  } });
  h.render({ visible: true, speech, onUse() {}, onClose() {} }); await settle(); h.render();
  assert.equal(h.id('a-voice-transcript'), null);
  started.resolve('current'); await settle(); h.render();
  assert.equal(h.id('a-voice-transcript').props.value, 'Reviewed answer');
});

function onboardingProps(resources) {
  return { resources, speech: {}, onAccount() {}, onUnauthenticated() {}, onDone() {}, account: {
    accountId: 'synthetic', profile: { name: 'Original' }, preferences: { heightUnit: 'cm', loadUnit: 'kg' },
    onboarding: { revision: 4, step: 'name', status: 'draft', answers: {}, preferences: {} },
  } };
}
test('unknown onboarding save retains original retry while manual edits cannot replace its intent', async () => {
  const h = harness('OnboardingFlow.tsx'); const calls = [];
  const props = onboardingProps({ onboarding: async (base, patch) => {
    calls.push({ revision: base.revision, name: patch.answers.name });
    if (calls.length === 1) throw new h.ApiError(0, 'network', 'Unknown', true);
    return { ...base, ...patch, revision: 5 };
  } });
  h.render(props); h.find(node => node.type === 'StepFooter').props.onPress(); await settle(); h.render();
  const retry = h.id('a-onboarding-notice').props.action.onPress;
  h.id('a-name-field').props.onChangeText('Edited meanwhile'); h.render();
  h.find(node => node.type === 'StepFooter').props.onPress(); await settle(); h.render();
  assert.equal(calls.length, 1);
  assert.equal(h.id('a-onboarding-notice').props.action.onPress, retry);
  retry(); await settle(); h.render();
  assert.deepEqual(calls, [{ revision: 4, name: 'Original' }, { revision: 4, name: 'Original' }]);
  assert.equal(h.id('a-name-field').props.value, 'Edited meanwhile');
  h.find(node => node.type === 'StepFooter').props.onPress(); await settle(); h.render();
  assert.deepEqual(calls[2], { revision: 5, name: 'Edited meanwhile' });
});

test('Back cannot discard an unresolved onboarding command', async () => {
  const h = harness('OnboardingFlow.tsx'); let writes = 0;
  const props = onboardingProps({ onboarding: async (base, patch) => {
    if (++writes === 2) throw new h.ApiError(0, 'network', 'Unknown', true);
    return { ...base, ...patch, revision: 5 };
  } });
  h.render(props); h.find(node => node.type === 'StepFooter').props.onPress(); await settle(); h.render();
  h.id('a-age-field').props.onStep(1); h.render(); h.find(node => node.type === 'StepFooter').props.onPress();
  await settle(); h.render(); h.find(node => node.type === 'Nav').props.onBack(); h.render();
  assert.ok(h.id('screen-onboarding-age'));
  assert.ok(h.id('a-onboarding-notice').props.action.onPress);
});

test('unknown first-plan retry keeps its original payload and key without rereading the catalog', async () => {
  const h = harness('OnboardingFlow.tsx'); const calls = []; let reads = 0; let generations = 0;
  const props = onboardingProps({
    completeOnboarding: async base => ({ ...base, status: 'completed' }),
    account: async () => props.account,
    exercises: async () => ({ items: [{ id: ++reads === 1 ? 'original-exercise' : 'later-exercise' }] }),
    createPlan: async (fields, key) => {
      calls.push({ fields, key });
      if (calls.length === 1) throw new h.ApiError(0, 'network', 'Unknown', true);
      return { ...fields, id: 'created-plan' };
    },
  });
  props.account.onboarding = { ...props.account.onboarding, step: 'review',
    preferences: { trainingDaysPerWeek: 3, sessionMinutes: 35, equipment: [] } };
  props.firstPlan = (_account, catalog) => {
    generations++;
    return Object.freeze({ name: 'First plan', minutes: 35, items: Object.freeze([
      Object.freeze({ id: 'item', exerciseId: catalog[0].id, setTarget: 2, repMin: 8, repMax: 12, targetKg: 0 }),
    ]) });
  };
  h.render(props); h.id('a-build').props.onPress(); await settle(); h.render();
  const original = calls[0]; assert.ok(original);
  h.id('a-onboarding-notice').props.action.onPress(); await settle(); h.render();
  assert.equal(reads, 1); assert.equal(generations, 1);
  assert.equal(calls.length, 2); assert.equal(calls[1].fields, original.fields); assert.equal(calls[1].key, original.key);
});

test('unknown completion retries the original revision and key despite edited plan answers', async () => {
  const h = harness('OnboardingFlow.tsx'); const calls = [];
  const props = onboardingProps({
    completeOnboarding: async (base, key) => {
      calls.push({ revision: base.revision, key });
      if (calls.length === 1) throw new h.ApiError(0, 'network', 'Unknown', true);
      return { ...base, status: 'completed' };
    },
    account: async () => props.account,
    onboarding: async () => { assert.fail('An unresolved completion cannot be replaced by a draft PATCH'); },
  });
  props.account.onboarding = { ...props.account.onboarding, step: 'review',
    preferences: { trainingDaysPerWeek: 3, sessionMinutes: 35, equipment: [] } };
  h.render(props); h.id('a-build').props.onPress(); await settle(); h.render();
  const retry = h.id('a-onboarding-notice').props.action.onPress;
  h.id('a-minutes-45').props.onPress(); h.render(); h.id('a-build').props.onPress(); await settle(); h.render();
  assert.equal(calls.length, 1); assert.equal(h.id('a-onboarding-notice').props.action.onPress, retry);
  retry(); await settle(); h.render();
  assert.equal(calls.length, 2); assert.deepEqual(calls[1], calls[0]);
  assert.equal(h.id('a-onboarding-notice'), null);
});

function experienceProps(resources) {
  const props = onboardingProps(resources);
  props.account.onboarding = { ...props.account.onboarding, step: 'background',
    answers: { trainingBackground: 'returning', injuryHistory: 'Separate injury answer' } };
  return props;
}

const textDestinations = [
  { label: 'name', step: 'name', field: 'a-name-field', limit: 100, answer: 'name' },
  { label: 'training context', step: 'background', field: 'a-exp-notes', limit: 4000, answer: 'trainingContext' },
  { label: 'injury note', step: 'injuries', field: 'a-injury-note', limit: 3000, answer: 'injuryHistory' },
];

function textBoundaryFixture(destination) {
  const h = harness('OnboardingFlow.tsx'), requests = [], accepted = [];
  const props = onboardingProps({});
  props.account.onboarding.step = destination.step;
  props.account.onboarding.answers = { name: 'Original', trainingBackground: 'returning', trainingContext: 'Original', injuryHistory: 'Original' };
  const { FormResources } = h.loadModule('api/resources.ts');
  props.resources = new FormResources({ request: async (path, method, body) => {
    requests.push({ path, method, body });
    return { ...props.account.onboarding, ...body, revision: 5 };
  } });
  props.speech = speechFixture({ acceptReview: review => { accepted.push(review); return { text: review.text }; } });
  h.render(props);
  return { h, props, requests, accepted, async review(text) {
    h.id(destination.field).props.onMic(); h.render();
    const sheet = harness('VoiceSheet.tsx');
    sheet.render(h.find(node => node.type === 'VoiceSheet').props); await settle();
    props.speech.emit({ ...draft('current'), text }); sheet.render();
    return sheet;
  }, async save() {
    h.find(node => node.type === 'StepFooter').props.onPress(); await settle(); h.render();
  } };
}

for (const destination of textDestinations) {
  test(`oversized voice ${destination.label} stays editable before acceptance and can be shortened`, async () => {
    const f = textBoundaryFixture(destination), oversized = 'x'.repeat(destination.limit + 1);
    const sheet = await f.review(oversized);
    assert.equal(sheet.id('a-voice-transcript').props.value, oversized);
    assert.equal(sheet.id('a-voice-use').props.disabled, true);
    sheet.id('a-voice-use').props.onPress(); sheet.render(); f.h.render();
    assert.deepEqual(f.accepted, []); assert.deepEqual(f.requests, []);
    assert.equal(sheet.id('a-voice-transcript').props.value, oversized);
    assert.equal(f.h.id(destination.field).props.value, 'Original');
    assert.equal(f.h.find(node => node.type === 'VoiceSheet').props.visible, true);
    const valid = 'x'.repeat(destination.limit);
    sheet.id('a-voice-transcript').props.onChangeText(valid); sheet.render();
    assert.equal(sheet.id('a-voice-use').props.disabled, false);
    sheet.id('a-voice-use').props.onPress(); f.h.render();
    assert.equal(f.accepted.length, 1); assert.equal(f.accepted[0].text, valid);
    assert.equal(f.h.id(destination.field).props.value, valid);
    assert.equal(f.h.find(node => node.type === 'VoiceSheet').props.visible, false);
    await f.save();
    assert.equal(f.requests.length, 1);
    const saved = f.requests[0].body.answers[destination.answer];
    assert.equal(destination.answer === 'injuryHistory' ? JSON.parse(saved).note : saved, valid);
  });

  test(`oversized manual ${destination.label} cannot dispatch and preserves the full answer`, async () => {
    const f = textBoundaryFixture(destination), oversized = 'x'.repeat(destination.limit + 1);
    f.h.id(destination.field).props.onChangeText(oversized); f.h.render();
    assert.equal(f.h.find(node => node.type === 'StepFooter').props.disabled, true);
    await f.save();
    assert.deepEqual(f.requests, []); assert.equal(f.h.id(destination.field).props.value, oversized);
  });

  test(`valid whitespace in voice ${destination.label} retains existing API trim semantics`, async () => {
    const f = textBoundaryFixture(destination), text = '  Reviewed answer  ';
    const sheet = await f.review(text); sheet.id('a-voice-use').props.onPress(); f.h.render();
    assert.equal(f.h.id(destination.field).props.value, text); await f.save();
    assert.equal(f.requests.length, 1);
    const saved = f.requests[0].body.answers[destination.answer];
    assert.equal(destination.answer === 'injuryHistory' ? JSON.parse(saved).note : saved,
      destination.answer === 'trainingContext' ? text : text.trim());
  });
}

for (const [label, character] of [['quotes', '"'], ['backslashes', '\\'], ['control characters', '\u0001']]) {
  test(`escaped injury ${label} cannot send a serialized answer over 4000 characters`, async () => {
    const f = textBoundaryFixture(textDestinations[2]), note = character.repeat(2000);
    f.h.id('a-injury-note').props.onChangeText(note); f.h.render();
    const { serializeInjury } = f.h.loadModule('features/onboarding/model.ts');
    assert.ok(serializeInjury({ areas: [], worsening: null, note, skipped: false }).length > 4000);
    assert.equal(f.h.find(node => node.type === 'StepFooter').props.disabled, true);
    await f.save();
    assert.deepEqual(f.requests, []); assert.equal(f.h.id('a-injury-note').props.value, note);
    f.h.id('a-injury-note').props.onChangeText('Corrected answer'); f.h.render(); await f.save();
    assert.equal(f.requests.length, 1);
    assert.equal(JSON.parse(f.requests[0].body.answers.injuryHistory).note, 'Corrected answer');
  });
}

test('an injury answer exactly at the serialized 4000-character boundary saves unchanged', async () => {
  const f = textBoundaryFixture(textDestinations[2]);
  const { serializeInjury } = f.h.loadModule('features/onboarding/model.ts');
  const overhead = serializeInjury({ areas: [], worsening: null, note: '', skipped: false }).length;
  const note = '"'.repeat(1000) + 'x'.repeat(4000 - overhead - 2000);
  f.h.id('a-injury-note').props.onChangeText(note); f.h.render(); await f.save();
  assert.equal(f.requests.length, 1); assert.equal(f.requests[0].body.answers.injuryHistory.length, 4000);
  assert.equal(JSON.parse(f.requests[0].body.answers.injuryHistory).note, note);
});

for (const [label, profile, answer, expected] of [
  ['draft takes precedence', 'Profile context', 'Draft context', 'Draft context'],
  ['empty draft preserves explicit clearing', 'Profile context', '', ''],
  ['profile fallback', 'Profile context', undefined, 'Profile context'],
  ['legacy absence', undefined, undefined, ''],
]) {
  test(`training context restoration: ${label}`, () => {
    const h = harness('OnboardingFlow.tsx'); const props = experienceProps({});
    if (profile !== undefined) props.account.profile.trainingContext = profile;
    if (answer !== undefined) props.account.onboarding.answers.trainingContext = answer;
    h.render(props);
    assert.equal(h.id('a-exp-notes').props.value, expected);
  });
}

for (const [method, text] of [['manual', 'Years of swimming'], ['voice', 'Warehouse work and cycling'], ['clear', '']]) {
  test(`background Continue persists ${method} training context independently of injuries`, async () => {
    const h = harness('OnboardingFlow.tsx'); const calls = [];
    const props = experienceProps({ onboarding: async (base, patch) => {
      calls.push({ revision: base.revision, patch });
      return { ...base, ...patch, answers: { ...base.answers, ...patch.answers }, revision: base.revision + 1 };
    } });
    props.account.profile.trainingContext = 'Previous context';
    h.render(props);
    if (method === 'voice') {
      h.id('a-exp-notes').props.onMic(); h.render();
      const voice = h.find(node => node.type === 'VoiceSheet');
      assert.equal(voice.props.visible, true);
      voice.props.onUse(text); h.render();
      assert.equal(h.find(node => node.type === 'VoiceSheet').props.visible, false);
    } else {
      h.id('a-exp-notes').props.onChangeText(text); h.render();
    }
    assert.equal(h.id('a-exp-notes').props.value, text);
    h.find(node => node.type === 'StepFooter').props.onPress(); await settle(); h.render();
    assert.deepEqual(calls, [{ revision: 4, patch: { step: 'background',
      answers: { trainingBackground: 'returning', trainingContext: text } } }]);
    assert.ok(h.id('screen-onboarding-injury'));
  });
}

test('unknown background save retries the original context before saving later local edits', async () => {
  const h = harness('OnboardingFlow.tsx'); const calls = [];
  const props = experienceProps({ onboarding: async (base, patch) => {
    calls.push({ revision: base.revision, patch });
    if (calls.length === 1) throw new h.ApiError(0, 'network', 'Unknown', true);
    return { ...base, ...patch, answers: { ...base.answers, ...patch.answers }, revision: base.revision + 1 };
  } });
  props.account.onboarding.answers.trainingContext = 'Original context';
  h.render(props); h.find(node => node.type === 'StepFooter').props.onPress(); await settle(); h.render();
  const retry = h.id('a-onboarding-notice').props.action.onPress;
  h.id('a-exp-notes').props.onChangeText('Edited context'); h.render();
  h.find(node => node.type === 'StepFooter').props.onPress(); await settle(); h.render();
  assert.equal(calls.length, 1); assert.equal(h.id('a-onboarding-notice').props.action.onPress, retry);
  retry(); await settle(); h.render();
  assert.equal(calls.length, 2); assert.deepEqual(calls[1], calls[0]);
  assert.equal(calls[1].patch.answers.trainingContext, 'Original context');
  assert.equal(h.id('a-exp-notes').props.value, 'Edited context');
  h.find(node => node.type === 'StepFooter').props.onPress(); await settle(); h.render();
  assert.deepEqual(calls[2], { revision: 5, patch: { step: 'background',
    answers: { trainingBackground: 'returning', trainingContext: 'Edited context' } } });
});

function persistedPlanFixture(options = {}) {
  const h = harness('OnboardingFlow.tsx'), calls = [], delivered = [], done = [];
  let current = true, unauthorized = 0, accountReads = 0;
  const preferences = { trainingDaysPerWeek: 3, sessionMinutes: 35, equipment: ['dumbbells'] };
  const answers = { name: 'Original', trainingBackground: 'returning', trainingContext: 'Swimming', goals: ['strength'] };
  const account = { accountId: 'synthetic', profile: { revision: 3, ...answers }, preferences: { revision: 4, ...preferences },
    onboarding: { revision: 5, step: 'review', status: 'draft', answers, preferences } };
  const completed = { ...account.onboarding, revision: 6, status: 'completed' };
  const fresh = { ...account, profile: { ...account.profile, revision: 4 }, preferences: { ...account.preferences, revision: 5 }, onboarding: completed };
  const plan = { id: 'persisted-plan', revision: 0, name: 'Persisted first plan', minutes: 35, archived: false,
    items: [{ id: 'item', exerciseId: 'movement', setTarget: 2, repMin: 8, repMax: 12, targetKg: 0 }],
    createdAt: '2026-10-11T00:00:00Z', updatedAt: '2026-10-11T00:00:00Z' };
  const receipt = { plan, provenance: { schema: 'form.first-plan-provenance/v1', contextKey: 'context:one', selectedCandidateId: 'candidate',
    profileRevision: 4, preferencesRevision: 5, sources: [], candidates: [{ id: 'candidate', status: 'eligible', gapCodes: [] }] } };
  const api = { captureAuthContext: () => ({ isCurrent: () => current }), async request(path, method = 'GET', body, key) {
    calls.push({ path, method, body, key });
    if (path === '/v1/me/onboarding/complete') return completed;
    if (path === '/v1/me') { accountReads++; return options.read ? options.read(fresh, accountReads) : fresh; }
    if (path === '/v1/plans/first') return options.send ? options.send(receipt, calls.filter(c => c.path === path).length, h) : receipt;
    assert.fail(`Unexpected request ${method} ${path}`);
  } };
  const { FormResources } = h.loadModule('api/resources.ts');
  const resources = new FormResources(api).boundTo(() => current);
  const props = { account, resources, speech: {}, firstPlanCommand: resources.createFirstPlan,
    firstPlan: () => assert.fail('Async command must never fall back to legacy generator'), isCurrentSession: () => current,
    onAccount: value => delivered.push(value), onDone: value => done.push(value), onUnauthenticated: () => { unauthorized++; } };
  return { h, props, calls, delivered, done, fresh, completed, receipt, plan,
    expire: () => { current = false; }, unauthorized: () => unauthorized, reads: () => accountReads,
    posts: () => calls.filter(c => c.path === '/v1/plans/first'),
    start() { h.render(props); h.id('a-build').props.onPress(); }, retry() { h.id('a-onboarding-notice').props.action.onPress(); } };
}

test('async first plan posts confirmed revisions once and adopts the persisted plan without legacy calls', async () => {
  const f = persistedPlanFixture();
  f.start(); await settle(); f.h.render();
  assert.equal(f.reads(), 1);
  assert.deepEqual(f.calls.map(c => c.path), ['/v1/me/onboarding/complete', '/v1/me', '/v1/plans/first']);
  assert.deepEqual(f.posts()[0].body, { profileRevision: 4, preferencesRevision: 5 });
  assert.ok(Object.isFrozen(f.posts()[0].body)); assert.ok(f.posts()[0].key);
  assert.ok(f.h.id('screen-onboarding-ready')); f.h.id('a-go-today').props.onPress();
  assert.deepEqual(f.done, [f.plan]); assert.deepEqual(f.delivered, [f.fresh]);
});

test('async first plan does not fall back to a stale account after a failed fresh read', async () => {
  const f = persistedPlanFixture({ read: () => { throw new Error('Synthetic fresh read failure'); } });
  f.start(); await settle(); f.h.render();
  assert.equal(f.posts().length, 0); assert.deepEqual(f.delivered, []); assert.deepEqual(f.done, []);
  assert.equal(f.h.id('screen-onboarding-ready'), null); assert.ok(f.h.id('a-onboarding-notice').props.action);
});

for (const change of ['account', 'revision', 'answers', 'profile', 'preferences']) {
  test(`async first plan holds at review for a changed confirmed ${change}`, async () => {
    const f = persistedPlanFixture({ read: fresh => {
      const copy = structuredClone(fresh);
      if (change === 'account') copy.accountId = 'foreign';
      if (change === 'revision') copy.onboarding.revision++;
      if (change === 'answers') copy.onboarding.answers.trainingContext = 'Other context';
      if (change === 'profile') copy.profile.trainingContext = 'Other context';
      if (change === 'preferences') copy.preferences.equipment = ['bands'];
      return copy;
    } });
    f.start(); await settle(); f.h.render();
    assert.equal(f.posts().length, 0); assert.deepEqual(f.delivered, []);
    assert.ok(f.h.id('screen-onboarding-plan')); assert.equal(f.h.id('a-onboarding-notice').props.text, 'Stale');
  });
}

for (const nextStatus of [422, 401, 501]) {
  test(`async unknown survives later definite ${nextStatus} and retries only the original request`, async () => {
    const f = persistedPlanFixture({ send: (receipt, attempt, h) => {
      if (attempt === 1) throw new h.ApiError(0, 'network_error', 'Unknown', true);
      if (attempt === 2) throw new h.ApiError(nextStatus, nextStatus === 501 ? 'first_plan_unavailable' : 'rejected', 'Rejected');
      return receipt;
    } });
    f.start(); await settle(); f.h.render(); f.retry(); await settle(); f.h.render();
    assert.equal(f.unauthorized(), 0); assert.ok(f.h.id('a-onboarding-notice').props.action);
    f.h.id('a-build').props.onPress(); await settle(); assert.equal(f.posts().length, 2);
    f.retry(); await settle(); f.h.render();
    assert.equal(f.reads(), 1); assert.equal(f.posts().length, 3);
    assert.deepEqual(f.posts()[1], f.posts()[0]); assert.deepEqual(f.posts()[2], f.posts()[0]);
    assert.ok(f.h.id('screen-onboarding-ready')); assert.deepEqual(f.delivered, [f.fresh]);
  });
}

test('malformed async success is unknown and cannot rotate the original command', async () => {
  const f = persistedPlanFixture({ send: (receipt, attempt) => attempt === 1 ? { plan: receipt.plan } : receipt });
  f.start(); await settle(); f.h.render(); assert.deepEqual(f.delivered, []);
  assert.equal(f.h.id('screen-onboarding-ready'), null); f.retry(); await settle(); f.h.render();
  assert.deepEqual(f.posts()[1], f.posts()[0]); assert.equal(f.reads(), 1); assert.ok(f.h.id('screen-onboarding-ready'));
});

test('initial exact unavailable response permits setup completion without inventing a plan', async () => {
  const f = persistedPlanFixture({ send: (_receipt, _attempt, h) => { throw new h.ApiError(501, 'first_plan_unavailable', 'Unavailable'); } });
  f.start(); await settle(); f.h.render(); assert.ok(f.h.id('screen-onboarding-ready'));
  assert.equal(f.h.id('a-onboarding-notice').props.text, 'Unavailable');
  f.h.id('a-go-today').props.onPress(); assert.deepEqual(f.done, [null]); assert.equal(f.posts().length, 1);
});

for (const stage of ['fresh-read', 'receipt']) {
  test(`original currentness blocks late ${stage} delivery`, async () => {
    const wait = deferred(); let saved;
    const f = persistedPlanFixture(stage === 'fresh-read' ? { read: value => { saved = value; return wait.promise; } }
      : { send: value => { saved = value; return wait.promise; } });
    f.start(); await settle(); f.expire(); wait.resolve(saved); await settle(); f.h.render();
    assert.deepEqual(f.delivered, []); assert.deepEqual(f.done, []);
    assert.equal(f.h.id('screen-onboarding-ready'), null);
    assert.equal(f.posts().length, stage === 'fresh-read' ? 0 : 1);
  });
}

test('onboarding disposal prevents late receipt delivery and disables captured retries', async () => {
  const wait = deferred(); let saved;
  const f = persistedPlanFixture({ send: (value, attempt, h) => {
    if (attempt === 1) throw new h.ApiError(0, 'network_error', 'Unknown', true);
    saved = value; return wait.promise;
  } });
  f.start(); await settle(); f.h.render();
  const retry = f.h.id('a-onboarding-notice').props.action.onPress;
  retry(); await settle(); f.h.dispose(); wait.resolve(saved); await settle(); retry(); await settle();
  assert.deepEqual(f.delivered, []); assert.deepEqual(f.done, []); assert.equal(f.posts().length, 2);
});

test('two build taps and repeated retry taps cannot dispatch concurrent first-plan commands', async () => {
  const wait = deferred(), f = persistedPlanFixture({ send: () => wait.promise });
  f.h.render(f.props); const press = f.h.id('a-build').props.onPress; press(); press(); await settle();
  assert.equal(f.posts().length, 1); wait.resolve(f.receipt); await settle(); f.h.render();
  assert.ok(f.h.id('screen-onboarding-ready'));
});

test('legacy unknown then definite rejection retains exact fields and key without regenerating', async () => {
  const h = harness('OnboardingFlow.tsx'), calls = []; let generations = 0;
  const props = onboardingProps({ completeOnboarding: async base => ({ ...base, status: 'completed' }), account: async () => props.account,
    exercises: async () => ({ items: [] }), createPlan: async (fields, key) => {
      calls.push({ fields, key });
      if (calls.length === 1) throw new h.ApiError(0, 'network_error', 'Unknown', true);
      if (calls.length === 2) throw new h.ApiError(422, 'rejected', 'Rejected');
      return { ...fields, id: 'saved' };
    } });
  props.account.onboarding = { ...props.account.onboarding, step: 'review', preferences: { trainingDaysPerWeek: 3, sessionMinutes: 35, equipment: [] } };
  props.firstPlan = () => { generations++; return { name: 'Legacy', minutes: 35, items: [] }; };
  h.render(props); h.id('a-build').props.onPress(); await settle(); h.render();
  h.id('a-onboarding-notice').props.action.onPress(); await settle(); h.render();
  assert.ok(h.id('a-go-today').props.disabled); h.id('a-onboarding-notice').props.action.onPress(); await settle(); h.render();
  assert.equal(generations, 1); assert.equal(calls.length, 3);
  assert.equal(calls[1].fields, calls[0].fields); assert.equal(calls[2].key, calls[0].key);
});

test('unknown completion remains unresolved after a later definite rejection', async () => {
  const h = harness('OnboardingFlow.tsx'), calls = []; let reads = 0;
  const props = onboardingProps({ completeOnboarding: async (base, key) => {
    calls.push({ base, key });
    if (calls.length === 1) throw new h.ApiError(0, 'network_error', 'Unknown', true);
    if (calls.length === 2) throw new h.ApiError(422, 'onboarding_incomplete', 'Rejected');
    return { ...base, status: 'completed' };
  }, account: async () => { reads++; return props.account; } });
  props.account.onboarding = { ...props.account.onboarding, step: 'review', preferences: { trainingDaysPerWeek: 3, sessionMinutes: 35, equipment: [] } };
  h.render(props); h.id('a-build').props.onPress(); await settle(); h.render();
  h.id('a-onboarding-notice').props.action.onPress(); await settle(); h.render();
  assert.ok(h.id('screen-onboarding-plan')); assert.equal(reads, 0);
  h.id('a-onboarding-notice').props.action.onPress(); await settle(); h.render();
  assert.equal(calls.length, 3); assert.deepEqual(calls[1], calls[0]); assert.deepEqual(calls[2], calls[0]);
  assert.ok(h.id('screen-onboarding-ready'));
});

test('an unknown async retry remains single flight while its response is pending', async () => {
  const wait = deferred(), f = persistedPlanFixture({ send: (_receipt, attempt, h) => {
    if (attempt === 1) throw new h.ApiError(0, 'network_error', 'Unknown', true);
    return wait.promise;
  } });
  f.start(); await settle(); f.h.render(); const retry = f.h.id('a-onboarding-notice').props.action.onPress;
  retry(); retry(); await settle(); assert.equal(f.posts().length, 2);
  wait.resolve(f.receipt); await settle(); f.h.render(); assert.ok(f.h.id('screen-onboarding-ready'));
});
