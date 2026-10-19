const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const ts = require('typescript');

// Exact TS source transpiled in memory: no React/native imports, scratch, DB or generated files.
function load(file, resolve) {
  const source = readFileSync(join(__dirname, '..', file), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', compiled)(resolve, mod, mod.exports);
  return mod.exports;
}
const mode = load('appMode.ts', name => { throw new Error(`unexpected import ${name}`); });
const model = load('model.ts', name => { assert.equal(name, './appMode'); return mode; });
const prefs = () => ({ revision: 4, appMode: 'basic', mascot: 'scholarly', animationStyle: 'short',
  loadUnit: 'kg', heightUnit: 'cm', coachVoice: 'calm', communication: 'concise', trainingDaysPerWeek: 3,
  sessionMinutes: 30, equipment: ['barbell'], remindersEnabled: true });
const profile = () => ({ revision: 2, name: 'Synthetic', age: null, heightCm: null, weightKg: null,
  trainingBackground: null, injuryHistory: '', goals: ['strength'] });
function ctx(overrides = {}) {
  const calls = [];
  const c = { account: { accountId: 'synthetic-a', profile: profile(), preferences: prefs() },
    appMode: 'basic', settings: null, capabilities: null, entitlements: null, resources: {},
    savePreferences: async payload => { calls.push(['preferences', payload]); return { status: 'saved', value: { ...prefs(), ...payload, revision: 5 } }; },
    saveProfile: async payload => { calls.push(['profile', payload]); return { status: 'saved', value: { ...profile(), ...payload, revision: 3 } }; },
    signOut: async () => { calls.push(['signOut']); return { status: 'saved', value: null }; },
    reload: async () => { calls.push(['reload']); }, close: () => calls.push(['close']),
    openAccess: () => calls.push(['access']), openPlans: () => calls.push(['plans']), openAccount: () => calls.push(['account']),
    ...overrides };
  return { c, calls };
}
function settings() {
  return { accountId: 'synthetic-a', identity: { displayName: 'Form name', email: null,
    phoneNumber: '+12025550111', signInMethods: ['apple', 'phone'] },
    capabilities: { revokeOtherSessions: { supported: true }, revokeAllSessions: { supported: true },
      accountDeletion: { supported: false } },
    policies: { reminders: { effect: 'preferenceOnly' }, sessions: { providerLogout: 'notClaimed',
      billingCancellation: 'notIncluded', deviceDataErasure: 'notIncluded' }, privacy: { bodyRetention: 'unavailable' } } };
}
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }

test('global mode is pure and account-derived, including unknown and legacy safe Basic', () => {
  for (const [saved, expected] of [['advanced', 'advanced'], ['basic', 'basic'], ['expert', 'basic'], [null, 'basic'], [undefined, 'basic']]) {
    const input = Object.freeze({ preferences: Object.freeze({ appMode: saved }) });
    assert.equal(mode.appModeFrom(input), expected);
    assert.equal(input.preferences.appMode, saved);
  }
  assert.equal(mode.appModeFrom(null), 'basic');
  const { c, calls } = ctx({ appMode: 'advanced' });
  assert.equal(model.settingsFacts(c).appMode, 'basic', 'conflicting screen prop cannot introduce a second mode');
  assert.deepEqual(calls, []);
});

test('future canonical values display safely without writes or default repairs; Reduce Motion never writes', async () => {
  const { c, calls } = ctx();
  c.account.preferences = { ...prefs(), appMode: 'future', mascot: 'future', animationStyle: 'future' };
  const m = model.createSettingsController(c);
  assert.deepEqual([m.snapshot().facts.appMode, m.snapshot().facts.mascot, m.snapshot().facts.animationStyle,
    m.snapshot().facts.effectiveAnimationStyle], ['basic', null, 'short', 'static']);
  await m.savePreferences({ appMode: 'future' }); await m.savePreferences({ mascot: 'future' });
  await m.savePreferences({ animationStyle: 'static' });
  assert.deepEqual(calls, []);
  const reduced = { ...c, account: { ...c.account, preferences: { ...prefs(), animationStyle: 'long' } },
    presentation: { mascot: 'scholarly', savedAnimationStyle: 'long', effectiveAnimationStyle: 'static', mascotVisible: true } };
  m.update(reduced);
  assert.equal(m.snapshot().facts.animationStyle, 'long');
  assert.equal(m.snapshot().facts.effectiveAnimationStyle, 'static');
  assert.deepEqual(calls, []);
});

test('saved and stale apply server snapshot only, never optimistically changing global mode', async () => {
  const d = deferred(); const { c } = ctx({ savePreferences: () => d.promise });
  const m = model.createSettingsController(c); const flight = m.savePreferences({ appMode: 'advanced' });
  assert.equal(m.snapshot().facts.appMode, 'basic'); assert.equal(m.snapshot().appModeControl.requested, 'advanced');
  d.resolve({ status: 'saved', value: { ...prefs(), revision: 5, appMode: 'advanced' } }); await flight;
  assert.equal(m.snapshot().facts.appMode, 'advanced'); assert.equal(m.snapshot().command.status, 'idle');
  m.update(c); assert.equal(m.snapshot().facts.appMode, 'advanced', 'older incoming props do not undo confirmed revision');
  m.update({ ...c, savePreferences: async () => ({ status: 'stale', latest: { ...prefs(), revision: 6, appMode: 'basic' } }) });
  await m.savePreferences({ appMode: 'advanced' });
  assert.equal(m.snapshot().facts.appMode, 'basic'); assert.equal(m.snapshot().command.status, 'conflict');
  assert.equal(m.snapshot().appModeControl.state.status, 'conflict'); assert.equal(m.snapshot().appModeControl.requested, null);
});

test('unknown retains exact retry closure and frozen deep payload; all new writes remain blocked', async () => {
  let saves = 0; let retries = 0; let sent; const d = deferred();
  const exactRetry = async () => { retries++; return d.promise; };
  const { c } = ctx({ savePreferences: async payload => { saves++; sent = payload; return { status: 'unknown', retry: exactRetry }; } });
  const m = model.createSettingsController(c); const payload = { equipment: ['kettlebell'] };
  await m.savePreferences(payload); payload.equipment[0] = 'mutated';
  assert.deepEqual(sent, { equipment: ['kettlebell'] }); assert.ok(Object.isFrozen(sent)); assert.ok(Object.isFrozen(sent.equipment));
  assert.equal(m.snapshot().command.status, 'unknown'); assert.equal(m.snapshot().canRetry, true);
  await m.savePreferences({ appMode: 'advanced' }); await m.saveProfile({ name: 'Another' }); await m.runSession('signOut'); await m.refresh();
  assert.equal(saves, 1);
  m.update({ ...c, savePreferences: async () => { throw new Error('must not reconstruct'); } });
  const flight = m.retry(); await m.retry(); assert.equal(retries, 1); assert.equal(m.snapshot().busy, true);
  d.resolve({ status: 'stale', latest: { ...prefs(), revision: 5, equipment: ['kettlebell'] } }); await flight;
  assert.equal(m.snapshot().command.status, 'conflict'); assert.equal(m.snapshot().retried, true);
  assert.doesNotMatch(m.snapshot().command.error.message, /another device/i);
  assert.equal(m.snapshot().canRetry, false); assert.equal(saves, 1);
});

test('unknown retry can return unknown then saved; failed keeps confirmed values', async () => {
  let count = 0;
  const second = async () => { count++; return { status: 'saved', value: { ...prefs(), revision: 5, animationStyle: 'long' } }; };
  const first = async () => { count++; return { status: 'unknown', retry: second }; };
  const { c } = ctx({ savePreferences: async () => ({ status: 'unknown', retry: first }) });
  const m = model.createSettingsController(c); await m.savePreferences({ animationStyle: 'long' });
  await m.retry(); assert.equal(m.snapshot().command.status, 'unknown'); assert.equal(m.snapshot().facts.animationStyle, 'short');
  await m.retry(); assert.equal(count, 2); assert.equal(m.snapshot().facts.animationStyle, 'long');
  m.update({ ...c, savePreferences: async () => ({ status: 'failed', error: { status: 422, code: 'invalid', message: 'Rejected', effectUnknown: false } }) });
  await m.savePreferences({ animationStyle: 'short' }); assert.equal(m.snapshot().facts.animationStyle, 'long');
  assert.equal(m.snapshot().command.status, 'failed'); assert.equal(m.snapshot().canRetry, false);
});

test('profile payload is immutable and single-flight blocks session/preferences writes', async () => {
  const d = deferred(); let sent; const { c, calls } = ctx({ saveProfile: payload => { sent = payload; return d.promise; } });
  const m = model.createSettingsController(c); const input = { goals: ['mobility'] };
  const flight = m.saveProfile(input); input.goals.push('changed');
  await m.savePreferences({ appMode: 'advanced' }); await m.runSession('signOut');
  assert.deepEqual(calls, []); assert.deepEqual(sent.goals, ['mobility']); assert.ok(Object.isFrozen(sent.goals));
  d.resolve({ status: 'saved', value: { ...profile(), revision: 3, goals: ['mobility'] } }); await flight;
  assert.deepEqual(m.snapshot().account.profile.goals, ['mobility']);
});

test('reset same account generation drops old events, captured command functions, in-flight results and retry', async () => {
  const d = deferred(); const { c, calls } = ctx({ savePreferences: () => d.promise });
  const m = model.createSettingsController(c); const old = m.events(); const oldSave = m.saveProfile; const oldRetry = m.retry;
  const flight = m.savePreferences({ appMode: 'advanced' });
  m.reset({ ...c, savePreferences: async () => ({ status: 'saved', value: prefs() }) });
  old.onSelectAppMode('advanced'); old.onRow('access'); old.onBack(); old.onSessionCommand('signOut'); await oldSave({ name: 'old' }); await oldRetry();
  assert.deepEqual(calls, []);
  d.resolve({ status: 'unknown', retry: async () => { throw new Error('stale retry'); } }); await flight;
  assert.equal(m.snapshot().command.status, 'idle'); assert.equal(m.snapshot().facts.appMode, 'basic'); assert.equal(m.snapshot().canRetry, false);
  m.events().onRow('access'); assert.deepEqual(calls, [['access']]);
});

test('account switch and unmount clear private state and block stale asynchronous dispatch', async () => {
  const d = deferred(); const { c, calls } = ctx({ savePreferences: () => d.promise });
  const m = model.createSettingsController(c); const old = m.events(); const flight = m.savePreferences({ mascot: 'buff' });
  m.update({ ...c, account: { ...c.account, accountId: 'synthetic-b' } });
  d.resolve({ status: 'saved', value: { ...prefs(), revision: 99, mascot: 'buff' } }); await flight;
  assert.equal(m.snapshot().facts.mascot, 'scholarly'); old.onBack(); assert.deepEqual(calls, []);
  const current = m.events(); m.dispose(); current.onBack(); current.onSelectAppMode('advanced');
  m.update(c); assert.equal(m.snapshot().active, false); assert.equal(m.snapshot().account, null);
  assert.equal(m.snapshot().intent, null); assert.equal(m.snapshot().facts, null); assert.deepEqual(calls, []);
});

test('unknown sign-out retains session; saved sign-out and revokeAll clear controller once, shell owns signout', async () => {
  let signouts = 0; let retries = 0;
  const { c } = ctx({ signOut: async () => { signouts++; return { status: 'unknown', retry: async () => {
    retries++; return { status: 'saved', value: null }; } }; } });
  const m = model.createSettingsController(c); await m.runSession('signOut');
  assert.equal(m.snapshot().active, true); await m.retry(); await m.retry(); await m.runSession('signOut');
  assert.equal(signouts, 1); assert.equal(retries, 1); assert.equal(m.snapshot().account, null);
  const calls = []; const other = ctx({ settings: settings(), sessionAction: async action => {
    calls.push(action); return { status: 'saved', value: null }; }, signOut: async () => { throw new Error('duplicate signout'); } });
  const all = model.createSettingsController(other.c); await all.runSession('revokeAllSessions'); await all.runSession('revokeAllSessions');
  assert.deepEqual(calls, ['revokeAllSessions']); assert.equal(all.snapshot().active, false);
});

test('failed session remains active and sessionChanged discards all retry state', async () => {
  const { c } = ctx({ signOut: async () => ({ status: 'failed', error: { status: 403, code: 'denied', message: 'Denied' } }) });
  const m = model.createSettingsController(c); await m.runSession('signOut'); assert.equal(m.snapshot().active, true);
  assert.equal(m.snapshot().session.state.status, 'failed');
  m.update({ ...c, signOut: async () => ({ status: 'failed', error: { code: 'session_changed', status: 401, message: 'Session changed' } }) });
  await m.runSession('signOut'); assert.equal(m.snapshot().active, false); assert.equal(m.snapshot().canRetry, false);
});

test('absent/mismatched capabilities, static reminders and separate body choices remain truthful', async () => {
  const { c, calls } = ctx(); const m = model.createSettingsController(c);
  assert.deepEqual(m.snapshot().facts.sessionCommands, ['signOut']); await m.runSession('revokeAllSessions');
  m.events().onSetReminders(false); await m.savePreferences({ remindersEnabled: false });
  assert.deepEqual(calls, []); assert.equal(m.snapshot().facts.notificationPermission, 'unsupported');
  assert.equal(m.snapshot().facts.reminders.interactive, false); assert.equal(m.snapshot().facts.accountDeletion.available, false);
  const bodyCalls = [];
  m.update({ ...c, settings: settings(), sessionAction: async action => { calls.push(action); return { status: 'saved', value: null }; },
    bodyPrivacy: { status: 'ready', photos: { label: 'Photos', value: 'Not chosen' },
      derived: { label: 'Derived', value: 'Not available yet' }, improvement: { label: 'Improvement', value: 'Not offered' } },
    openBodyChoice: row => bodyCalls.push(row) });
  assert.equal(m.snapshot().facts.phoneSuffix, '0111'); assert.equal(m.snapshot().facts.privacy.devicePersistenceVerified, false);
  assert.match(m.snapshot().facts.sessionLimits, /provider logout, billing cancellation or device data erasure/);
  assert.match(m.snapshot().facts.reminders.description, /not verified/);
  m.events().onBodyChoice('photos'); m.events().onBodyChoice('derived'); m.events().onBodyChoice('improvement');
  assert.deepEqual(bodyCalls, ['photos']); await m.runSession('revokeOtherSessions'); assert.equal(m.snapshot().active, true);
  m.update({ ...c, settings: { ...settings(), accountId: 'other' }, sessionAction: async () => { throw new Error('must hide'); } });
  assert.deepEqual(m.snapshot().facts.sessionCommands, ['signOut']); assert.deepEqual(m.snapshot().facts.signInMethods, []);
});

test('uncontracted thrown write uncertainty stays blocked, with no invented retry', async () => {
  const { c, calls } = ctx({ savePreferences: async () => { throw new Error('callback broke after dispatch'); } });
  const m = model.createSettingsController(c); await m.savePreferences({ mascot: 'baby' });
  assert.equal(m.snapshot().command.status, 'unknown'); assert.equal(m.snapshot().canRetry, false);
  await m.runSession('signOut'); await m.saveProfile({ name: 'new' }); assert.deepEqual(calls, []);
});

test('profile unknown uses retained closure with immutable goals and stale snapshot handling', async () => {
  let sent; let saves = 0; let retries = 0;
  const { c } = ctx({ saveProfile: async payload => { sent = payload; saves++; return { status: 'unknown', retry: async () => {
    retries++; return { status: 'stale', latest: { ...profile(), revision: 3, goals: ['mobility'] } }; } }; } });
  const m = model.createSettingsController(c); const goals = ['mobility']; await m.saveProfile({ goals }); goals.push('changed');
  assert.deepEqual(sent.goals, ['mobility']); assert.equal(m.snapshot().profileWrite.status, 'unknown');
  await m.retry(); assert.equal(saves, 1); assert.equal(retries, 1); assert.equal(m.snapshot().profileWrite.status, 'conflict');
  assert.deepEqual(m.snapshot().account.profile.goals, ['mobility']);
});

test('training context saves and explicitly clears without replacing the separate injury answer', async () => {
  let saved = { ...profile(), injuryHistory: 'Separate injury answer' }; const calls = [];
  const { c } = ctx({ saveProfile: async payload => {
    calls.push(payload); saved = { ...saved, ...payload, revision: saved.revision + 1 };
    return { status: 'saved', value: saved };
  } });
  c.account.profile = saved;
  const m = model.createSettingsController(c);
  await m.saveProfile({ trainingContext: 'Sports and past programs' });
  assert.equal(m.snapshot().account.profile.trainingContext, 'Sports and past programs');
  await m.saveProfile({ trainingContext: '' });
  assert.deepEqual(calls, [{ trainingContext: 'Sports and past programs' }, { trainingContext: '' }]);
  assert.equal(m.snapshot().account.profile.trainingContext, '');
  assert.equal(m.snapshot().account.profile.injuryHistory, 'Separate injury answer');
  assert.equal(m.snapshot().command.status, 'idle');
});

test('unknown training context retains its frozen intent and drops retry results after an account switch', async () => {
  const d = deferred(); let sent; let saves = 0; let retries = 0;
  const { c } = ctx({ saveProfile: async payload => {
    saves++; sent = payload;
    return { status: 'unknown', retry: async () => { retries++; return d.promise; } };
  } });
  const m = model.createSettingsController(c); const input = { trainingContext: 'Original context' };
  await m.saveProfile(input); input.trainingContext = 'Later edit';
  assert.equal(m.snapshot().profileWrite.status, 'unknown');
  assert.equal(m.snapshot().account.profile.trainingContext, undefined);
  assert.deepEqual(sent, { trainingContext: 'Original context' }); assert.ok(Object.isFrozen(sent));
  await m.saveProfile(input); assert.equal(saves, 1);
  m.update({ ...c, saveProfile: async () => { assert.fail('Retry must use the retained command'); } });
  const flight = m.retry(); assert.equal(retries, 1);
  m.update({ ...c, account: { ...c.account, accountId: 'synthetic-b',
    profile: { ...profile(), trainingContext: 'Other account context' } } });
  d.resolve({ status: 'saved', value: { ...profile(), ...sent, revision: 99 } }); await flight;
  assert.equal(m.snapshot().account.accountId, 'synthetic-b');
  assert.equal(m.snapshot().account.profile.trainingContext, 'Other account context');
  assert.equal(m.snapshot().command.status, 'idle'); assert.equal(m.snapshot().canRetry, false);
  assert.equal(saves, 1); assert.equal(retries, 1);
});

test('refresh reports unavailable details without defaults and ignores a disposed late refresh', async () => {
  const { c } = ctx(); const m = model.createSettingsController(c);
  assert.equal(m.snapshot().settings.status, 'loading'); await m.refresh(); assert.equal(m.snapshot().settings.status, 'error');
  m.update({ ...c, settings: settings() }); assert.equal(m.snapshot().settings.status, 'ready');
  const d = deferred(); m.update({ ...c, reload: () => d.promise }); const flight = m.refresh(); m.dispose(); d.resolve(); await flight;
  assert.equal(m.snapshot().account, null); assert.equal(m.snapshot().settings.status, 'loading');
});

test('synchronous lifecycle disposal in a pending observer prevents dispatch', async () => {
  const { c, calls } = ctx(); const m = model.createSettingsController(c);
  m.subscribe(() => { if (m.snapshot().busy) m.dispose(); });
  await m.savePreferences({ appMode: 'advanced' }); assert.deepEqual(calls, []); assert.equal(m.snapshot().active, false);
});

test('missing session action members remain absent-safe and optional routes use exact shell seams', () => {
  const { c, calls } = ctx({ settings: { ...settings(), capabilities: {} }, sessionAction: async () => ({ status: 'saved', value: null }) });
  const m = model.createSettingsController(c); assert.deepEqual(m.snapshot().facts.sessionCommands, ['signOut']);
  m.events().onRow('profile.name'); m.events().onRow('training.plans'); m.events().onRow('training.cues');
  m.events().onOpenSystemSettings(); m.events().onRow('community.featureRequests');
  assert.deepEqual(calls, [['account'], ['plans']]);
});
