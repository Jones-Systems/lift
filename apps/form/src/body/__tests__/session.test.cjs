const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const ts = require('typescript');

// Compile the pure body modules in memory (no scratch files). Their imports are type-only, so each module runs alone.
// This tests session/validation/lifecycle logic with synthetic values only; it does not test React rendering,
// TS type correctness, native memory behavior or OS-level persistence.
function load(file) {
  const compiled = ts.transpileModule(readFileSync(join(__dirname, '..', file), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', compiled)((name) => {
    throw new Error(`unexpected runtime import ${name} from ${file}`);
  }, mod, mod.exports);
  return mod.exports;
}

const session = load('session.ts');
const caps = load('capabilities.ts');
const copy = load('copy.ts');
const {
  CONSTRUCTS, RATIOS, bodyReducer, computeRatios, createBodySession, emptyDraft, holdsSessionData, parseLength, previousRoute,
  validateDraft,
} = session;

const ACCOUNT_A = 'acct-synthetic-a';
const ACCOUNT_B = 'acct-synthetic-b';

function run(state, ...commands) {
  return commands.reduce((s, c) => bodyReducer(s, { ...c, generation: s.generation }), state);
}

function draft(patch) {
  return { ...emptyDraft(), ...patch };
}

function withEntries(entries) {
  let s = run(createBodySession(ACCOUNT_A), { type: 'choose_processing', choice: 'session_only' });
  for (const patch of entries) s = run(s, { type: 'edit_draft', patch }, { type: 'commit_draft' });
  return s;
}

/* ---------------- validation ---------------- */

test('lengths accept finite positive numbers and convert cm to whole mm', () => {
  assert.deepEqual(parseLength('33.5', 'cm'), { ok: true, value: 33.5, mm: 335 });
  assert.deepEqual(parseLength('33,5', 'cm'), { ok: true, value: 33.5, mm: 335 });
  assert.deepEqual(parseLength('335', 'mm'), { ok: true, value: 335, mm: 335 });
  assert.deepEqual(parseLength(' 172 ', 'cm'), { ok: true, value: 172, mm: 1720 });
});

test('invalid, non-finite, non-positive, over-precise and unit-slip lengths are rejected with no substitute', () => {
  const cases = [
    ['', 'cm', 'value_missing'], ['abc', 'cm', 'value_not_number'], ['Infinity', 'cm', 'value_not_number'],
    ['NaN', 'cm', 'value_not_number'], ['1e3', 'mm', 'value_not_number'], ['12..5', 'cm', 'value_not_number'],
    ['-5', 'cm', 'value_not_positive'], ['0', 'cm', 'value_not_positive'], ['0.0', 'cm', 'value_not_positive'],
    ['12.34', 'cm', 'value_too_precise'], ['335.5', 'mm', 'value_too_precise'],
    ['1750', 'cm', 'value_too_large'], ['3001', 'mm', 'value_too_large'],
  ];
  for (const [text, unit, error] of cases) {
    assert.deepEqual(parseLength(text, unit), { ok: false, error }, `${text} ${unit}`);
  }
});

test('sided constructs require a side and every entry requires who measured', () => {
  const result = validateDraft(draft({ construct: 'forearm', valueText: '26' }));
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors.sort(), ['measured_by_missing', 'side_missing']);
  const missingAll = validateDraft(emptyDraft());
  assert.deepEqual(missingAll.errors.sort(), ['construct_missing', 'measured_by_missing', 'value_missing']);
});

test('a valid entry keeps exact units, protocol and reported provenance, with null uncertainty', () => {
  const result = validateDraft(draft({ construct: 'upperArm', valueText: '33.5', side: 'left', measuredBy: 'helper', instrument: 'tape' }));
  assert.equal(result.ok, true);
  assert.deepEqual(result.measurement, {
    id: 'upperArm:left', construct: 'upperArm', side: 'left', entered: { value: 33.5, unit: 'cm' }, mm: 335,
    provenance: { source: 'user_reported', measuredBy: 'helper', instrument: 'tape', protocol: 'form.body.manual.upper-arm/1', verifiedByForm: false },
    uncertainty: null,
  });
  const unsided = validateDraft(draft({ construct: 'stature', valueText: '172', side: 'left', measuredBy: 'self' }));
  assert.equal(unsided.measurement.side, null);
});

/* ---------------- constructs and ratios ---------------- */

test('only external protocol constructs exist; no femur, thigh, torso, sitting, hip, pelvic or posture label', () => {
  assert.deepEqual(Object.keys(CONSTRUCTS).sort(), ['armSpan', 'forearm', 'stature', 'upperArm']);
  const text = JSON.stringify({ CONSTRUCTS, RATIOS });
  assert.doesNotMatch(text, /femur|thigh|torso|sitting|pelvi|hip|posture|tilt|percentile|normal|range/i);
});

test('ratios use named compatible pairs, cancel mixed cm/mm units and carry no uncertainty or ranges', () => {
  const s = withEntries([
    { construct: 'stature', valueText: '1720', unit: 'mm', measuredBy: 'self' },
    { construct: 'armSpan', valueText: '175.4', unit: 'cm', measuredBy: 'helper' },
  ]);
  const ratio = computeRatios(s.measurements).find((r) => r.id === 'armSpanToStature');
  assert.equal(ratio.status, 'computed');
  assert.equal(ratio.value, 1754 / 1720);
  assert.equal(ratio.uncertainty, null);
  assert.deepEqual(Object.keys(ratio).sort(), ['denominator', 'id', 'numerator', 'side', 'status', 'uncertainty', 'value']);
  assert.equal(session.formatRatio(ratio.value), '1.02');
});

test('sided ratios never mix left and right entries', () => {
  const s = withEntries([
    { construct: 'forearm', valueText: '26', side: 'left', measuredBy: 'self' },
    { construct: 'upperArm', valueText: '33', side: 'right', measuredBy: 'self' },
  ]);
  const sided = computeRatios(s.measurements).filter((r) => r.id === 'forearmToUpperArm');
  assert.deepEqual(sided.map((r) => [r.status, r.side, r.needs]), [
    ['missing', 'left', ['upperArm']],
    ['missing', 'right', ['forearm']],
  ]);
  const matched = run(s, { type: 'edit_draft', patch: { construct: 'upperArm', valueText: '330', unit: 'mm', side: 'left', measuredBy: 'self' } },
    { type: 'commit_draft' });
  const left = computeRatios(matched.measurements).find((r) => r.id === 'forearmToUpperArm' && r.side === 'left');
  assert.equal(left.status, 'computed');
  assert.equal(left.value, 260 / 330);
});

test('with no entries every ratio is missing, never zero or a default', () => {
  for (const r of computeRatios([])) {
    assert.equal(r.status, 'missing');
    assert.equal('value' in r, false);
  }
});

/* ---------------- explicit choice ---------------- */

test('no processing choice is preselected and data pages stay closed until the explicit session-only choice', () => {
  const initial = createBodySession(ACCOUNT_A);
  assert.equal(initial.processing, null);
  for (const route of ['protocol', 'measure', 'results']) {
    assert.equal(run(initial, { type: 'navigate', route }).route, 'overview', route);
  }
  const blocked = run(initial, { type: 'edit_draft', patch: { construct: 'stature', valueText: '172', measuredBy: 'self' } }, { type: 'commit_draft' });
  assert.deepEqual(blocked.measurements, []);
  const chosen = run(initial, { type: 'choose_processing', choice: 'session_only' }, { type: 'navigate', route: 'measure' });
  assert.equal(chosen.route, 'measure');
  assert.equal(run(chosen, { type: 'navigate', route: 'results' }).route, 'measure', 'results needs at least one entry');
});

/* ---------------- lifecycle ---------------- */

const LIFECYCLE = ['close', 'cancel', 'background', 'done'];

test('every clear reason drops entries, drafts, checklist and the choice, and advances the generation', () => {
  for (const reason of LIFECYCLE) {
    let s = withEntries([{ construct: 'stature', valueText: '123.4', measuredBy: 'self' }]);
    s = run(s, { type: 'toggle_check', id: 'full_body' }, { type: 'edit_draft', patch: { construct: 'armSpan', valueText: '99' } });
    assert.equal(holdsSessionData(s), true);
    const cleared = run(s, { type: 'clear', reason });
    assert.equal(holdsSessionData(cleared), false, reason);
    assert.equal(cleared.generation, s.generation + 1);
    assert.equal(cleared.processing, null, `${reason} requires a new explicit choice`);
    assert.doesNotMatch(JSON.stringify(cleared), /1234|123\.4|99/, reason);
  }
});

test('late commands stamped with an earlier generation are ignored after a clear', () => {
  const s = withEntries([]);
  const stale = s.generation;
  const cleared = run(s, { type: 'clear', reason: 'background' });
  const late = [
    { type: 'choose_processing', choice: 'session_only' },
    { type: 'edit_draft', patch: { construct: 'stature', valueText: '172', measuredBy: 'self' } },
    { type: 'commit_draft' },
    { type: 'navigate', route: 'results' },
  ].reduce((acc, c) => bodyReducer(acc, { ...c, generation: stale }), cleared);
  assert.equal(late, cleared);
});

test('an account change resets to an empty session at a new generation; the same account is a no-op', () => {
  const s = withEntries([{ construct: 'stature', valueText: '172', measuredBy: 'self' }]);
  assert.equal(bodyReducer(s, { type: 'account', accountId: ACCOUNT_A }), s);
  const switched = bodyReducer(s, { type: 'account', accountId: ACCOUNT_B });
  assert.equal(switched.accountId, ACCOUNT_B);
  assert.equal(holdsSessionData(switched), false);
  assert.equal(switched.generation, s.generation + 1);
  assert.equal(bodyReducer(switched, { type: 'commit_draft', generation: s.generation }), switched);
});

test('editing replaces one entry per construct and side; removing the last entry leaves results', () => {
  let s = withEntries([{ construct: 'stature', valueText: '172', measuredBy: 'self' }]);
  s = run(s, { type: 'navigate', route: 'results' }, { type: 'edit_measurement', id: 'stature:none' });
  assert.equal(s.route, 'measure');
  s = run(s, { type: 'edit_draft', patch: { valueText: '171.5' } }, { type: 'commit_draft' });
  assert.deepEqual(s.measurements.map((m) => [m.id, m.mm]), [['stature:none', 1715]]);
  s = run(s, { type: 'navigate', route: 'results' }, { type: 'remove_measurement', id: 'stature:none' });
  assert.deepEqual(s.measurements, []);
  assert.equal(s.route, 'measure');
});

test('back from the entry page closes; choices opened from Settings closes directly', () => {
  assert.equal(previousRoute(createBodySession(ACCOUNT_A)), 'close');
  assert.equal(previousRoute(createBodySession(ACCOUNT_A, 'choices')), 'close');
  assert.equal(previousRoute({ ...createBodySession(ACCOUNT_A), route: 'choices' }), 'overview');
});

/* ---------------- capabilities and consent ---------------- */

test('camera, automatic and anatomical capabilities are unsupported and retention is not configured', () => {
  const c = caps.BODY_CAPABILITIES;
  assert.equal(c.cameraCapture.status, 'unsupported');
  assert.equal(c.automaticEstimates.status, 'unsupported');
  assert.equal(c.anatomicalAssessment.status, 'unsupported');
  assert.equal(c.externalProcessing.status, 'unsupported');
  assert.equal(c.improvementContribution.status, 'unsupported');
  assert.equal(c.retainedMeasurements.status, 'unconfigured');
  assert.equal(c.retainedPhotos.status, 'unconfigured');
  assert.equal(Object.isFrozen(c) && Object.isFrozen(c.cameraCapture), true);
  for (const [id, capability] of Object.entries(c)) {
    if (id !== 'manualSession') assert.equal(caps.isUsable(capability), false, id);
  }
});

test('retention gate denies silence, missing consent and every current capability', () => {
  const accept = { photos: 'accept', derived: 'accept', consentVersion: 'synthetic-v1' };
  assert.deepEqual(caps.retentionGate(caps.BODY_CAPABILITIES, accept), { photos: false, derived: false, reason: 'capability_unqualified' });
  assert.equal(caps.retentionGate(caps.BODY_CAPABILITIES, { ...accept, derived: null }).reason, 'choice_missing');
  assert.equal(caps.retentionGate(caps.BODY_CAPABILITIES, { ...accept, consentVersion: null }).reason, 'consent_missing');
});

test('a hypothetical qualified future still needs both explicit answers and keeps images and derivatives separate', () => {
  const q = { status: 'qualified', reason: null };
  const future = { ...caps.BODY_CAPABILITIES, cameraCapture: q, retainedPhotos: q, retainedMeasurements: q };
  assert.equal(caps.retentionGate(future, { photos: 'accept', derived: null, consentVersion: 'v' }).photos, false);
  assert.deepEqual(caps.retentionGate(future, { photos: 'accept', derived: 'decline', consentVersion: 'v' }),
    { photos: true, derived: false, reason: 'allowed' });
  assert.deepEqual(caps.retentionGate(future, { photos: 'decline', derived: 'accept', consentVersion: 'v' }),
    { photos: false, derived: true, reason: 'allowed' });
  const noCamera = { ...future, cameraCapture: caps.BODY_CAPABILITIES.cameraCapture };
  assert.equal(caps.retentionGate(noCamera, { photos: 'accept', derived: 'accept', consentVersion: 'v' }).photos, false);
});

test('Settings privacy summary shows every choice as unavailable, never chosen or on', () => {
  const summary = caps.bodyPrivacySummary();
  assert.equal(summary.status, 'ready');
  assert.deepEqual([summary.photos.value, summary.derived.value, summary.improvement.value],
    ['Not available yet', 'Not available yet', 'Not offered']);
});

/* ---------------- copy claims ---------------- */

// Every user-facing string in copy.ts, flattened. Function-valued copy is called with a synthetic argument.
function copyStrings(value) {
  if (typeof value === 'string') return [value];
  if (typeof value === 'function') return copyStrings(value(['Synthetic']));
  if (value && typeof value === 'object') return Object.values(value).flatMap(copyStrings);
  return [];
}
const ALL_COPY = copyStrings(copy);

test('copy makes no diagnosis, accuracy, ranking, percentile or perfect-plan claim', () => {
  const scope = copy.BODY_COPY.overview.scope;
  // Scoped to these measurements, not to Form as a whole (injury context remains part of Form's goal).
  assert.match(scope, /^These measurements don’t diagnose or treat anything/);
  // The one scope disclaimer is the only place "diagnose" may appear.
  const text = JSON.stringify(copy).split(scope).join('');
  assert.doesNotMatch(text, /diagnos|accura|confiden|percentile|perfect|normal range|%|posterior|anterior|expert/i);
  assert.doesNotMatch(ALL_COPY.join('\n'), /Form doesn’t (diagnose|treat)/);
});

test('copy never promises that nothing is kept: native/OS persistence is unqualified', () => {
  // Absolute or device-level guarantees (negative-test fixture: each phrase was or could be a false claim).
  const absolute = [
    /nothing[^.]*\b(saved|kept|stored|sent|recorded|retained)\b/i, /keep(s)? nothing/i, /no(thing| data| trace)s? (is |are )?(left|persist)/i,
    /never (saved|stored|kept|retained|leaves)/i, /\b(anywhere|no trace|zero (persist\w*|data|traces?|retention)|forensic|permanently|completely private|fully private)\b/i,
    /\b(isn’t|is not|aren’t|are not|won’t be) (saved|stored|kept|sent)\b/i, /Form (doesn’t|does not|never) (save|store|keep|send|upload)/i,
    /\bonly on this (screen|device)\b/i,
  ];
  for (const text of ALL_COPY) {
    for (const pattern of absolute) assert.doesNotMatch(text, pattern, text);
  }
  // Scoped module claims are allowed only when they name these screens.
  for (const text of ALL_COPY.filter((t) => /(don’t|doesn’t|never) (save|upload|send|store|keep)/i.test(t))) {
    assert.match(text, /(These screens|Form’s body screens)/, text);
  }
});

test('session-only choice, overview, results and choices state the unchecked phone limitation', () => {
  const c = copy.BODY_COPY;
  assert.doesNotMatch(c.purpose.sessionOnly, /keep|save|nothing|once/i);
  for (const text of [c.overview.subtitle, c.purpose.sessionOnlyDetail, c.results.ephemeral, c.choices.sessionDetail]) {
    assert.match(text, /(These screens|Form’s body screens) don’t save or upload/, text);
    assert.match(text, /Form hasn’t yet checked what your phone itself may keep/, text);
  }
});
