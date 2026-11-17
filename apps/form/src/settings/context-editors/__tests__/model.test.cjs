const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const ts = require('typescript');
const source = readFileSync(require('node:path').join(__dirname, '..', 'model.ts'), 'utf8');
const mod = { exports: {} };
new Function('require', 'module', 'exports', ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText)(name => { throw new Error(`Unexpected runtime dependency ${name}`); }, mod, mod.exports);
const { createContextEditorController: create } = mod.exports;
const profile = () => ({ revision: 4, name: 'Synthetic', age: null, heightCm: null, weightKg: null,
  trainingBackground: null, goals: ['unfamiliar goal', 'strength'], injuryHistory: '' });
const preferences = () => ({ revision: 7, trainingDaysPerWeek: 3, sessionMinutes: 30, equipment: ['unfamiliar equipment', 'barbell'] });
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { resolve, promise }; }
function host(target = 'name', response) {
  let current = true;
  let latestProfile = profile(); let latestPreferences = preferences();
  const displayedProfile = latestProfile; const displayedPreferences = latestPreferences;
  const calls = []; let closes = 0;
  const entry = { target, accountId: 'synthetic', attachment: {}, profile: displayedProfile, preferences: displayedPreferences,
    isCurrentEditor: () => current,
    saveProfileFromEntry: async changes => {
      assert.ok(current); calls.push({ changes, expectedRevision: displayedProfile.revision });
      return response ? response(changes) : { status: 'saved', value: { ...latestProfile, ...changes, revision: 5 } };
    },
    savePreferencesFromEntry: async changes => {
      assert.ok(current); calls.push({ changes, expectedRevision: displayedPreferences.revision });
      return response ? response(changes) : { status: 'saved', value: { ...latestPreferences, ...changes, revision: 8 } };
    }, closeFromEntry: () => { assert.ok(current); closes++; } };
  return { entry, calls, closes: () => closes, retire: () => { current = false; },
    refresh: () => { latestProfile = { ...latestProfile, revision: 40, name: 'Refreshed' };
      latestPreferences = { ...latestPreferences, revision: 70, sessionMinutes: 90 }; } };
}

test('displayed baseline and frozen intent survive a later host refresh without adding unrelated fields', async () => {
  for (const [target, field, value, expectedRevision] of [['name', 'name', '  Edited  ', 4], ['schedule', 'trainingDaysPerWeek', '5', 7]]) {
    const h = host(target); const m = create(h.entry, h.entry.attachment);
    m.edit(field, value); h.refresh(); await m.save();
    assert.deepEqual(h.calls, [{ changes: { [field]: target === 'name' ? 'Edited' : 5 }, expectedRevision }]);
    assert.ok(Object.isFrozen(h.calls[0].changes));
    assert.equal(m.snapshot().status, 'saved'); await m.save(); assert.equal(h.calls.length, 1);
  }
});

test('validation keeps nullable age, exact numeric bounds and intended-only schedule changes', async () => {
  for (const [target, field, invalid, valid, expected] of [
    ['name', 'name', ' ', 'A', 'A'], ['age', 'age', '12', '13', 13], ['age', 'age', '120.5', '', null],
    ['experience', 'trainingBackground', 'expert', 'regular', 'regular'],
    ['schedule', 'trainingDaysPerWeek', '8', '7', 7], ['schedule', 'sessionMinutes', '181', '5', 5],
  ]) {
    const h = host(target); const m = create(h.entry, h.entry.attachment);
    m.edit(field, invalid); assert.equal(m.snapshot().canSave, false); await m.save(); assert.equal(h.calls.length, 0);
    m.edit(field, valid); await m.save(); assert.deepEqual(h.calls[0].changes, { [field]: expected });
  }
});

test('lists retain unfamiliar strings and order; edits and explicit removal affect only selected field', async () => {
  for (const field of ['goals', 'equipment']) {
    const h = host(field); const m = create(h.entry, h.entry.attachment);
    const values = [...m.snapshot().draft[field], ' new custom value '];
    m.edit(field, values); values.push('caller mutation'); await m.save();
    assert.deepEqual(h.calls[0].changes[field], [`unfamiliar ${field === 'goals' ? 'goal' : 'equipment'}`, field === 'goals' ? 'strength' : 'barbell', 'new custom value']);
    const second = host(field); const editor = create(second.entry, second.entry.attachment);
    editor.edit(field, Array(31).fill('x')); await editor.save(); assert.equal(second.calls.length, 0);
    editor.edit(field, []); await editor.save(); assert.deepEqual(second.calls[0].changes, { [field]: [] });
  }
});

test('pending and unknown serialize duplicate calls, block editing/back, and use only returned retry', async () => {
  const first = deferred(); const retried = deferred(); let retries = 0;
  const h = host('name', () => first.promise); const m = create(h.entry, h.entry.attachment);
  m.edit('name', 'Original'); const flight = m.save(); await m.save();
  m.edit('name', 'Wrong'); m.close(); assert.equal(h.calls.length, 1); assert.equal(h.closes(), 0);
  first.resolve({ status: 'unknown', retry: () => { retries++; return retried.promise; } }); await flight;
  assert.deepEqual(m.snapshot().intent, { name: 'Original' });
  h.refresh(); m.edit('name', 'Wrong'); m.close(); await m.save();
  const retryFlight = m.retry(); await m.retry(); assert.equal(retries, 1); assert.equal(h.calls.length, 1);
  retried.resolve({ status: 'saved', value: { ...profile(), name: 'Original', revision: 5 } }); await retryFlight;
  assert.equal(m.snapshot().draft.name, 'Original'); assert.equal(m.snapshot().canRetry, false);
});

test('stale shows supplied latest and requires explicit close and re-entry without reapplying intent', async () => {
  const h = host('name', () => ({ status: 'stale', latest: { ...profile(), name: 'Latest', revision: 9 } }));
  const m = create(h.entry, h.entry.attachment); m.edit('name', 'Old intent'); await m.save();
  assert.equal(m.snapshot().draft.name, 'Latest'); assert.equal(m.snapshot().intent, null);
  m.edit('name', 'Replay'); await m.save(); await m.retry(); assert.equal(h.calls.length, 1);
  m.close(); m.close(); await m.save(); assert.equal(h.closes(), 1); assert.equal(m.snapshot().status, 'retired');
});

test('attachment and same-account session replacement retire retained handlers and ignore late completions', async () => {
  for (const replace of ['attachment', 'session', 'currentness', 'dispose']) {
    const d = deferred(); let retries = 0; const h = host('name', () => d.promise);
    const m = create(h.entry, h.entry.attachment); const save = m.save; const close = m.close; const retry = m.retry;
    m.edit('name', 'Original'); const flight = save();
    if (replace === 'attachment') m.reconcile(h.entry, {});
    else if (replace === 'session') m.reconcile({ ...h.entry, attachment: {} }, {});
    else if (replace === 'currentness') h.retire(); else m.dispose();
    d.resolve({ status: 'unknown', retry: async () => { retries++; return { status: 'saved', value: profile() }; } }); await flight;
    await save(); await retry(); close();
    assert.equal(h.calls.length, 1); assert.equal(retries, 0); assert.equal(h.closes(), 0);
    assert.equal(m.snapshot().status, 'retired'); assert.deepEqual(m.snapshot().draft, {});
  }
});

test('unknown retry rechecks original currentness and a pending observer can retire before dispatch', async () => {
  let retries = 0; const h = host('name', () => ({ status: 'unknown', retry: async () => { retries++; return { status: 'saved', value: profile() }; } }));
  const m = create(h.entry, h.entry.attachment); m.edit('name', 'A'); await m.save(); h.retire(); await m.retry(); assert.equal(retries, 0);
  const other = host(); const editor = create(other.entry, other.entry.attachment);
  editor.edit('name', 'B'); editor.subscribe(() => { if (editor.snapshot().status === 'pending') editor.dispose(); });
  await editor.save(); assert.equal(other.calls.length, 0);
});

test('thrown uncertainty cannot invent retry or unlock editing', async () => {
  const h = host('name', () => { throw new Error('Unconfirmed'); }); const m = create(h.entry, h.entry.attachment);
  m.edit('name', 'A'); await m.save(); assert.equal(m.snapshot().status, 'unknown'); assert.equal(m.snapshot().canRetry, false);
  m.edit('name', 'B'); await m.save(); m.close(); assert.equal(h.calls.length, 1); assert.equal(h.closes(), 0);
});
