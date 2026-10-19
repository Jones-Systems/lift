const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const ts = require('typescript');

// Synthetic pure state tests; exact source is compiled in memory without files, native capture or requests.
function load(file, resolve) {
  const compiled = ts.transpileModule(readFileSync(join(__dirname, '..', file), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', compiled)(resolve, mod, mod.exports);
  return mod.exports;
}
const caps = load('capabilities.ts', name => { throw new Error(`unexpected import ${name}`); });
const contract = load('manualRetentionContract.ts', name => { throw new Error(`unexpected import ${name}`); });
const { BODY_RETENTION_POLICY, createRetentionSession, retentionReducer, retentionPermission, manualRetentionAuthority } = load('retention.ts', name => {
  const allowed = { './capabilities': caps, './manualRetentionContract': contract };
  assert.ok(allowed[name], `unexpected import ${name}`); return allowed[name];
});
const manual = Object.freeze({ create: true, list: true, delete: true });
const measurement = Object.freeze({ kind: 'waist', unit: 'cm', value: 80, measuredOn: '2026-10-11', note: 'Synthetic' });
const stamp = state => ({ accountId: state.accountId, generation: state.generation });
const run = (state, event) => retentionReducer(state, { ...event, ...stamp(state) });
const choose = (state, purpose) => run(state, { type: 'choose', purpose, choice: 'retain', consentVersion: contract.MANUAL_RETENTION_PROTOCOL });
const processing = state => run(state, { type: 'choose_processing', choice: 'manual_entry' });
const deletion = { purpose: 'derived', measurementId: 'synthetic-measurement', key: 'synthetic-delete' };

test('defaults are unset, non-retaining and have no fabricated processing or consent', () => {
  const state = createRetentionSession('synthetic-a');
  assert.equal(state.processing, null);
  assert.deepEqual(state.choices, { photos: { choice: 'unset', consentVersion: null }, derived: { choice: 'unset', consentVersion: null } });
  assert.deepEqual(state.stagedMeasurements, []);
  for (const purpose of ['photos', 'derived']) assert.equal(retentionPermission(state, purpose, stamp(state), manual).allowed, false);
  assert.equal(run(state, { type: 'stage_measurement', measurement }), state);
  assert.equal(run(state, { type: 'choose_processing', choice: 'retained' }), state);
});

test('explicit manual-entry processing permits local staging without choosing retention', () => {
  let state = processing(createRetentionSession('synthetic-a'));
  const input = { ...measurement };
  state = run(state, { type: 'stage_measurement', measurement: input }); input.value = 999;
  assert.equal(state.stagedMeasurements[0].value, 80);
  assert.ok(Object.isFrozen(state.stagedMeasurements[0]));
  assert.equal(state.choices.derived.choice, 'unset');
  assert.equal(retentionPermission(state, 'derived', stamp(state), manual).allowed, false);
});

test('legacy session-only processing cannot authorize collection or optional retained writes', () => {
  const state = choose(createRetentionSession('synthetic-a'), 'derived');
  const legacy = run(state, { type: 'choose_processing', choice: 'session_only' });
  assert.equal(legacy, state);
  assert.equal(legacy.processing, null);
  assert.equal(run(legacy, { type: 'stage_measurement', measurement }), legacy);
  assert.equal(retentionPermission(legacy, 'derived', stamp(legacy), manual).reason, 'processing_not_chosen');
  const explicit = processing(legacy);
  assert.equal(explicit.processing, 'manual_entry');
  assert.equal(retentionPermission(explicit, 'derived', stamp(explicit), manual).allowed, false);
});

test('photo and derived choices are explicit and separate, with no implicit consent version', () => {
  let state = processing(createRetentionSession('synthetic-a'));
  assert.equal(run(state, { type: 'choose', purpose: 'derived', choice: 'retain', consentVersion: '' }), state);
  state = choose(state, 'derived');
  assert.equal(state.choices.photos.choice, 'unset');
  assert.equal(retentionPermission(state, 'derived', stamp(state), manual).allowed, false);
  state = choose(state, 'photos');
  assert.equal(state.choices.derived.choice, 'retain');
  state = run(state, { type: 'revoke', purpose: 'photos' });
  assert.equal(state.choices.photos.consentVersion, null);
  assert.equal(state.choices.derived.choice, 'retain');
});

test('retention needs corresponding evidence; user choices and runtime flags cannot qualify photos', () => {
  const state = choose(choose(processing(createRetentionSession('synthetic-a')), 'photos'), 'derived');
  assert.equal(retentionPermission(state, 'derived', stamp(state)).allowed, false);
  assert.equal(retentionPermission(state, 'derived', stamp(state), { ...manual, create: false }).allowed, false);
  assert.equal(retentionPermission(state, 'derived', stamp(state), manual).allowed, false);
  assert.equal(retentionPermission(state, 'photos', stamp(state), { ...manual, photos: true, cameraCapture: true }).allowed, false);
  assert.equal(caps.BODY_CAPABILITIES.cameraCapture.status, 'unsupported');
  assert.equal(caps.BODY_CAPABILITIES.retainedPhotos.status, 'unconfigured');
  assert.ok(Object.isFrozen(caps.BODY_CAPABILITIES.retainedPhotos));
  assert.equal(retentionPermission(state, 'derived', { accountId: 'synthetic-b', generation: state.generation }, manual).reason, 'stale_session');
});

test('private progress choices authorize no rankings, sale, promotions, research or training', () => {
  assert.equal(BODY_RETENTION_POLICY.audience, 'same_user_only');
  for (const key of ['rankings', 'sale', 'promotionalReuse', 'researchReuse', 'modelTrainingReuse', 'noSaveGuarantee'])
    assert.equal(BODY_RETENTION_POLICY[key], false);
  for (const key of ['nativePersistence', 'cachePersistence', 'vendorPersistence', 'backupDeletion'])
    assert.equal(BODY_RETENTION_POLICY[key], 'unqualified');
  assert.ok(Object.isFrozen(BODY_RETENTION_POLICY));
  assert.deepEqual(Object.keys(createRetentionSession('synthetic-a').choices).sort(), ['derived', 'photos']);
});

test('revocation immediately stops future manual retention, clears staging and fences late events', () => {
  let state = choose(processing(createRetentionSession('synthetic-a')), 'derived');
  state = run(state, { type: 'stage_measurement', measurement });
  const old = stamp(state);
  assert.equal(retentionPermission(state, 'derived', old, manual).allowed, false);
  state = run(state, { type: 'revoke', purpose: 'derived' });
  assert.equal(state.generation, old.generation + 1);
  assert.equal(retentionPermission(state, 'derived', stamp(state), manual).allowed, false);
  assert.deepEqual(state.stagedMeasurements, []);
  assert.equal(state.deletion.derived.status, 'not_requested');
  for (const event of [{ type: 'stage_measurement', measurement },
    { type: 'choose', purpose: 'derived', choice: 'retain', consentVersion: 'old' }])
    assert.equal(retentionReducer(state, { ...event, ...old }), state);
});

test('deletion tracks the exact manual request and never mistakes pending, unknown or failure for confirmation', () => {
  let state = createRetentionSession('synthetic-a');
  state = run(state, { type: 'deletion_started', ...deletion });
  assert.equal(state.deletion.derived.status, 'pending');
  for (const patch of [{ key: 'different' }, { measurementId: 'different' }, { purpose: 'photos' }])
    assert.equal(run(state, { type: 'deletion_result', ...deletion, outcome: 'confirmed', response: { deleted: true }, ...patch }), state);
  for (const response of [undefined, {}, { deleted: false }, { deleted: true, allData: true }]) {
    state = run(state, { type: 'deletion_result', ...deletion, outcome: 'confirmed', response });
    assert.equal(state.deletion.derived.status, 'unknown');
  }
  assert.equal(run(state, { type: 'deletion_started', ...deletion, key: 'different' }), state);
  state = run(state, { type: 'deletion_result', ...deletion, outcome: 'failed' });
  assert.equal(state.deletion.derived.status, 'failed');
  state = run(state, { type: 'deletion_started', ...deletion });
  state = run(state, { type: 'deletion_result', ...deletion, outcome: 'unknown' });
  assert.equal(state.deletion.derived.status, 'unknown');
  state = run(state, { type: 'deletion_result', ...deletion, outcome: 'confirmed', response: { deleted: true } });
  assert.equal(state.deletion.derived.status, 'confirmed');
  assert.equal(state.deletion.derived.measurementId, deletion.measurementId);
  assert.equal(state.deletion.photos.status, 'unavailable');
});

test('revoke preserves deletion uncertainty; an old completion cannot confirm in the new generation', () => {
  let state = run(createRetentionSession('synthetic-a'), { type: 'deletion_started', ...deletion });
  const old = stamp(state);
  state = run(state, { type: 'revoke', purpose: 'derived' });
  assert.equal(state.deletion.derived.status, 'unknown');
  const result = { type: 'deletion_result', ...deletion, outcome: 'confirmed', response: { deleted: true } };
  assert.equal(retentionReducer(state, { ...result, ...old }), state);
  assert.equal(run(state, result), state, 'restamping an old request cannot make it current');
  state = run(state, { type: 'deletion_started', ...deletion });
  state = run(state, result);
  assert.equal(state.deletion.derived.status, 'confirmed');
});

test('photo deletion remains unavailable even when a caller supplies a successful-looking outcome', () => {
  let state = choose(processing(createRetentionSession('synthetic-a')), 'photos');
  state = run(state, { type: 'revoke', purpose: 'photos' });
  for (const event of [{ type: 'deletion_started' }, { type: 'deletion_result', outcome: 'confirmed', response: { deleted: true } }])
    assert.equal(run(state, { ...event, ...deletion, purpose: 'photos' }), state);
  assert.equal(state.deletion.photos.status, 'unavailable');
});

test('close, cancel and background clear choices/data and discard every prior-generation event', () => {
  for (const reason of ['close', 'cancel', 'background']) {
    let state = choose(processing(createRetentionSession('synthetic-a')), 'derived');
    state = run(state, { type: 'stage_measurement', measurement });
    state = run(state, { type: 'deletion_started', ...deletion });
    const old = stamp(state); state = run(state, { type: 'clear', reason });
    assert.deepEqual(state, createRetentionSession('synthetic-a', old.generation + 1));
    for (const event of [{ type: 'stage_measurement', measurement }, { type: 'choose_processing', choice: 'manual_entry' },
      { type: 'choose', purpose: 'derived', choice: 'retain', consentVersion: 'old' },
      { type: 'deletion_result', ...deletion, outcome: 'confirmed', response: { deleted: true } }])
      assert.equal(retentionReducer(state, { ...event, ...old }), state);
  }
});

test('account changes erase session state and old account events cannot change the new user', () => {
  let state = choose(processing(createRetentionSession('synthetic-a')), 'derived');
  state = run(state, { type: 'stage_measurement', measurement });
  const old = stamp(state);
  assert.equal(run(state, { type: 'account', nextAccountId: 'synthetic-a' }), state);
  state = run(state, { type: 'account', nextAccountId: 'synthetic-b' });
  assert.deepEqual(state, createRetentionSession('synthetic-b', old.generation + 1));
  assert.equal(retentionReducer(state, { type: 'account', nextAccountId: 'synthetic-a', ...old }), state);
  assert.equal(retentionReducer(state, { type: 'choose', purpose: 'derived', choice: 'retain', consentVersion: 'old',
    accountId: 'synthetic-a', generation: state.generation }), state);
});

test('fresh choices need a confirmed current grant; reads never supply a command receipt or restore permission', () => {
  const decisionId = '12345678-1234-4234-8234-123456789012';
  const current = { decisionId, state: 'granted', revision: 1, statement: contract.MANUAL_RETENTION_STATEMENT_BINDING };
  let state = choose(processing(createRetentionSession('synthetic-a')), 'derived');
  assert.equal(manualRetentionAuthority(state), null);
  state = run(state, { type: 'grant_started', decisionId });
  state = run(state, { type: 'current_result', decisionId, current });
  assert.equal(manualRetentionAuthority(state), null);
  state = run(state, { type: 'control_result', operation: 'grant', decisionId, outcome: 'confirmed', current });
  assert.equal(retentionPermission(state, 'derived', stamp(state), manual).allowed, true);
  assert.equal(manualRetentionAuthority(state).decisionId, decisionId);
  state = run(state, { type: 'current_result', decisionId, current: { ...current, state: 'revoked', revision: 2 } });
  state = run(state, { type: 'control_result', operation: 'grant', decisionId, outcome: 'confirmed', current });
  assert.equal(manualRetentionAuthority(state), null);
  assert.equal(state.manualDecision.current.state, 'revoked');
  assert.equal(createRetentionSession('synthetic-a').manualDecision, null);
});

test('local revocation is terminal for an interval even after explicit retain is chosen again', () => {
  const decisionId = '12345678-1234-4234-8234-123456789012';
  let state = choose(processing(createRetentionSession('synthetic-a')), 'derived');
  state = run(state, { type: 'grant_started', decisionId });
  state = run(state, { type: 'control_result', operation: 'grant', decisionId, outcome: 'confirmed',
    current: { decisionId, state: 'granted', revision: 1, statement: contract.MANUAL_RETENTION_STATEMENT_BINDING } });
  state = run(state, { type: 'revoke', purpose: 'derived' }); state = choose(state, 'derived');
  assert.equal(manualRetentionAuthority(state), null);
  assert.equal(run(state, { type: 'grant_started', decisionId }), state);
});
