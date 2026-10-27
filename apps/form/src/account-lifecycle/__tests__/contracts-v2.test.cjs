const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createHash } = require('node:crypto');
const ts = require('typescript');
function load(name) {
  const source = fs.readFileSync(path.resolve(__dirname, '..', name), 'utf8');
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    reportDiagnostics: true,
  });
  assert.equal(code.diagnostics.filter(d => d.category === ts.DiagnosticCategory.Error).length, 0);
  const sha = text => createHash('sha256').update(text).digest('hex');
  console.log(`# lifecycle-v2 ${name} TypeScript ${ts.version} input ${sha(source)} emission ${sha(code.outputText)}`);
  const module = { exports: {} };
  new Function('require', 'module', 'exports', code.outputText)(name => { throw new Error(`Unexpected import ${name}`); }, module, module.exports);
  return module.exports;
}
const client = load('contracts-v2.ts'), v1 = load('contracts.ts');
const apiRoot = path.resolve(__dirname, '../../../../../services/api');
const emission = path.join(apiRoot, 'dist/src/lifecycle/wire-v2.js');
// Real backend emission is mandatory; absent or older output fails this suite.
assert.ok(fs.statSync(emission).mtimeMs >= fs.statSync(path.join(apiRoot, 'src/lifecycle/wire-v2.ts')).mtimeMs, 'Compile the current backend codec first');
const serverPromise = import(pathToFileURL(emission).href);
const V = 'form.account-lifecycle.v2', R = '11111111-1111-4111-8111-111111111111';
const steps = ['form_training_history', 'phone_challenges', 'purchase_proofs', 'auth_identity', 'backups', 'providers', 'activity', 'community'];
const absent = state => ({ state, reason: 'evidence_missing', projection: null });
const current = () => ({ state: 'current', reason: null, projection: { bindingDigest: 'a'.repeat(64), observedAtMs: 1800000000000 } });
const wrap = (kind, payload) => ({ schemaVersion: V, kind, payload });
const expect = kind => ({ schemaVersion: V, kind, ...(kind === 'deletion' ? { requestId: R } : kind === 'action_grant'
  ? { purpose: 'account_delete', nowMs: 0, allowedMethods: ['password'] } : kind === 'export' ? { accountId: 'fixture-account', epoch: 7 } : { accountId: 'fixture-account' }) });
const capability = configured => wrap('capabilities', { accountId: 'fixture-account', status: configured ? 'configured_unverified' : 'unavailable', initiation: configured,
  actionReauthenticationMethods: configured ? ['password'] : [], policyVersion: 'form-account-lifecycle-v1', wholeAccountDeletionComplete: false, exportMaxBytes: 16777216, billingCancellation: 'not_performed' });
const grant = (method = 'password') => wrap('action_grant', { grant: 'fixture-private-secret'.padEnd(43, 'x'), purpose: 'account_delete', method, expiresAt: '2026-10-28T00:00:00.000Z' });
function deletion(state = 'unavailable') {
  return wrap('deletion', { requestId: R, phase: 'awaiting_reauthentication', initiated: true, disabled: false, localPurged: false, complete: false,
    requestedAt: '2026-10-01T00:00:00.000Z', verifiedActionMethod: null, backupExpiryAt: null,
    backup: { status: 'unavailable', policyVersion: null, inventoryDigest: null, dispositionEvidenceDigest: null }, billingCancellation: 'not_performed',
    completion: { scope: 'declared_server_targets', status: state, requiredCategories: [...steps], localCategories: ['form_training_history'], evidence: absent(state) },
    steps: steps.map(category => ({ category, status: category === 'backups' ? 'unavailable' : 'pending', reason: null, retainUntilMs: null, retentionPolicyVersion: null })) });
}
function terminal(partial = false) {
  const v = deletion(), p = v.payload;
  Object.assign(p, { phase: partial ? 'pending_external' : 'declared_scope_complete', disabled: true, localPurged: true, verifiedActionMethod: 'password' });
  Object.assign(p.completion, { status: partial ? 'pending' : 'complete', evidence: current() });
  p.steps.forEach(s => { s.status = 'complete'; });
  if (partial) Object.assign(p.steps[2], { status: 'retained', reason: 'required_retention' });
  Object.assign(p.backup, { status: 'complete', policyVersion: 'fixture-policy', inventoryDigest: 'b'.repeat(64), dispositionEvidenceDigest: 'c'.repeat(64) });
  return v;
}
function exported() {
  return wrap('export', { records: [{ category: 'identity', value: { accountId: 'fixture-account', note: 'é🧘漢\n' } }], manifest: {
    schemaVersion: 'form.account-export.v2', snapshotAtMs: 1800000000000, complete: false, scope: { accountId: 'fixture-account', epoch: 7 },
    provenance: { source: 'account-scoped-sqlite-read-transaction', consistency: 'single-connection-snapshot', authorization: 'caller-authoritative-session-epoch-suppression-before-generation-and-release', adapterConsistency: 'caller-qualified-synchronous-adapters' },
    categories: [{ category: 'identity', status: 'complete', count: 1, omittedCount: 0, reason: null }],
    omissions: [{ category: 'credentials', reason: 'internal_authentication', count: null, effect: 'excluded_from_scope' }],
    residuals: [{ category: 'device_copies', status: 'unknown', reason: 'outside_server_scope' }],
    snapshotCompletion: { scope: 'declared_server_snapshot', status: 'complete', requiredCategories: ['identity'], evidence: current() },
  } });
}
function rejected(codec, wire, expected, code) {
  assert.throws(() => codec.decodeLifecycleV2(wire, expected), e => {
    assert.ok(e instanceof codec.LifecycleV2Error);
    assert.equal(e.message, e.code); assert.equal(e.effectUnknown, true);
    if (code) assert.equal(e.code, code);
    for (const secret of ['fixture-private-secret', 'fixture-record-private', wire]) assert.ok(!e.message.includes(secret));
    assert.ok(!Object.keys(e).some(key => /payload|grant|retry|requestId/.test(key))); return true;
  });
}
function frozen(value) {
  if (value && typeof value === 'object') { assert.ok(Object.isFrozen(value)); if (!Array.isArray(value)) assert.equal(Object.getPrototypeOf(value), Object.prototype); Object.values(value).forEach(frozen); }
}

test('fresh real backend encoder interoperates with independent client on every kind and evidence state', async () => {
  const server = await serverPromise;
  const disabled = deletion('unknown'); disabled.payload.disabled = true; disabled.payload.phase = 'disabled_pending_reconciliation';
  const unresolvedExport = exported(); unresolvedExport.payload.manifest.categories[0].status = 'unknown';
  Object.assign(unresolvedExport.payload.manifest.snapshotCompletion, { status: 'unknown', evidence: absent('unknown') });
  for (const vector of [capability(false), capability(true), grant(), deletion(), disabled, terminal(true), terminal(), exported(), unresolvedExport]) {
    const wire = server.encodeLifecycleV2(vector), expected = expect(vector.kind);
    for (const codec of [server, client]) {
      const decoded = codec.decodeLifecycleV2(wire, expected);
      assert.deepEqual(decoded, vector); frozen(decoded);
      assert.notEqual(decoded, vector); assert.notEqual(decoded.payload, vector.payload);
      const again = codec.decodeLifecycleV2(wire, expected); assert.notEqual(again.payload, decoded.payload);
    }
    assert.equal(server.encodeLifecycleV2(client.decodeLifecycleV2(wire, expected)), wire);
  }
});

test('v1 readers retain valid fixtures and reject complete v2 envelopes; v2 never upgrades v1', async () => {
  const server = await serverPromise;
  const oldDelete = { ...deletion().payload, reauthentication: 'password_only_qualified_source', steps: steps.map(category => ({ category, status: 'pending', retain_until_ms: null })) };
  delete oldDelete.completion; delete oldDelete.backup; delete oldDelete.verifiedActionMethod;
  const oldGrant = grant().payload;
  const oldExport = exported().payload; oldExport.manifest.schemaVersion = 'form.account-export.v1';
  const settings = { accountId: 'fixture-account', stagedAccountLifecycle: { status: 'configured_unverified', initiation: true, passwordActionReauthentication: true,
    phoneActionReauthentication: false, oauthActionReauthentication: false, wholeAccountDeletionComplete: false, exportMaxBytes: 16777216, billingCancellation: 'not_performed' } };
  assert.equal(v1.availableSettings(settings, 'fixture-account'), true);
  assert.deepEqual(v1.deletionReceipt(oldDelete, R), oldDelete);
  assert.equal(v1.grantReceipt(oldGrant, 'account_delete', 0), oldGrant.grant);
  assert.deepEqual(v1.exportReceipt(oldExport, 'fixture-account'), oldExport);
  for (const [kind, old] of [['capabilities', settings], ['deletion', oldDelete], ['action_grant', oldGrant], ['export', oldExport]]) {
    for (const codec of [server, client]) rejected(codec, JSON.stringify(old), expect(kind), 'unsupported_lifecycle_version');
  }
  assert.throws(() => v1.availableSettings(capability(true), 'fixture-account'));
  assert.throws(() => v1.deletionReceipt(deletion(), R));
  assert.throws(() => v1.grantReceipt(grant(), 'account_delete', 0));
  assert.throws(() => v1.exportReceipt(exported(), 'fixture-account'));
});

test('explicit expected selection, subject, epoch, grant ceremony and expiry cannot be inferred', async () => {
  const server = await serverPromise;
  for (const codec of [server, client]) {
    for (const kind of ['capabilities', 'deletion', 'export', 'action_grant']) {
      const vector = { capabilities: capability(true), deletion: deletion(), export: exported(), action_grant: grant() }[kind];
      const wire = server.encodeLifecycleV2(vector);
      rejected(codec, wire, undefined, 'unsupported_lifecycle_version');
      for (const schemaVersion of [undefined, 'form.account-lifecycle.v1', 'form.account-lifecycle.v3']) {
        rejected(codec, JSON.stringify({ ...vector, schemaVersion }), expect(kind), 'unsupported_lifecycle_version');
        rejected(codec, wire, { ...expect(kind), schemaVersion }, 'unsupported_lifecycle_version');
      }
      rejected(codec, wire, expect(kind === 'export' ? 'deletion' : 'export'), 'lifecycle_kind_mismatch');
    }
    rejected(codec, server.encodeLifecycleV2(capability(false)), { ...expect('capabilities'), accountId: 'wrong' }, 'lifecycle_subject_mismatch');
    rejected(codec, server.encodeLifecycleV2(deletion()), { ...expect('deletion'), requestId: '22222222-2222-4222-8222-222222222222' }, 'lifecycle_subject_mismatch');
    rejected(codec, server.encodeLifecycleV2(exported()), { ...expect('export'), epoch: 8 }, 'lifecycle_subject_mismatch');
    rejected(codec, server.encodeLifecycleV2(exported()), { ...expect('export'), accountId: 'wrong' }, 'lifecycle_subject_mismatch');
    rejected(codec, server.encodeLifecycleV2(grant()), { ...expect('action_grant'), purpose: 'account_export' }, 'lifecycle_grant_mismatch');
    rejected(codec, server.encodeLifecycleV2(grant()), { ...expect('action_grant'), nowMs: Date.parse(grant().payload.expiresAt) }, 'lifecycle_grant_mismatch');
    for (const method of ['email_action_code', 'phone_action_code']) {
      const wire = server.encodeLifecycleV2(grant(method));
      rejected(codec, wire, expect('action_grant'), 'lifecycle_grant_mismatch');
      assert.equal(codec.decodeLifecycleV2(wire, { ...expect('action_grant'), allowedMethods: [method] }).payload.method, method);
    }
    for (const method of ['email_otp', 'phone_login', 'password_reset', 'recent_oauth']) rejected(codec, JSON.stringify(grant(method)), expect('action_grant'));
  }
});

test('both validators enforce declaration closure, all field types, exact dates and error precedence', async () => {
  const server = await serverPromise;
  for (const vector of [capability(true), grant(), terminal(), exported()]) {
    const paths = [];
    function visit(value, at) {
      if (!value || typeof value !== 'object' || at.join('.') === 'payload.records.0.value') return;
      if (!Array.isArray(value)) paths.push(at);
      for (const [key, child] of Object.entries(value)) visit(child, [...at, key]);
    }
    visit(vector, []);
    for (const at of paths) {
      const extra = structuredClone(vector); let target = extra; for (const key of at) target = target[key]; target.extra = null;
      for (const codec of [server, client]) rejected(codec, JSON.stringify(extra), expect(vector.kind), 'invalid_lifecycle_v2');
      for (const field of Object.keys(target).filter(k => k !== 'extra')) {
        const missing = structuredClone(vector); let target = missing; for (const key of at) target = target[key]; delete target[field];
        for (const codec of [server, client]) rejected(codec, JSON.stringify(missing), expect(vector.kind));
      }
    }
  }
  for (const codec of [server, client]) {
    const invalid = deletion(); invalid.payload.complete = true;
    rejected(codec, JSON.stringify(invalid), { ...expect('deletion'), requestId: 'wrong' }, 'invalid_lifecycle_v2');
    invalid.schemaVersion = 'wrong'; rejected(codec, JSON.stringify(invalid), expect('export'), 'unsupported_lifecycle_version');
    for (const date of ['2026-10-01T00:00:00Z', '2026-10-01T01:00:00.000+01:00', '2026-02-30T00:00:00.000Z', '1969-12-31T23:59:59.999Z']) {
      const v = grant(); v.payload.expiresAt = date; rejected(codec, JSON.stringify(v), expect('action_grant'));
    }
    for (const n of ['7', -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) { const v = exported(); v.payload.manifest.scope.epoch = n; rejected(codec, JSON.stringify(v), expect('export')); }
    const trailing = capability(true); trailing.payload.accountId += '\n'; rejected(codec, JSON.stringify(trailing), expect('capabilities'));
    const badGrant = grant(); badGrant.payload.grant += '\n'; rejected(codec, JSON.stringify(badGrant), expect('action_grant'));
    const hostile = new Proxy({}, { get() { throw new Error('fixture-private-secret'); } });
    rejected(codec, JSON.stringify(grant()), hostile);
    const disguised = new codec.LifecycleV2Error('invalid_lifecycle_v2'); disguised.message = 'fixture-private-secret';
    rejected(codec, JSON.stringify(grant()), new Proxy({}, { get() { throw disguised; } }));
  }
});

test('both validators reject counterfeit scoped completion, local proof, backup inference and partial success', async () => {
  const server = await serverPromise;
  const mutations = [
    p => { p.complete = true; }, p => { p.phase = 'complete'; }, p => { p.localPurged = false; }, p => { p.disabled = false; },
    p => { p.completion.requiredCategories = []; }, p => { p.completion.localCategories = []; },
    p => { p.completion.localCategories.push('missing'); }, p => { p.completion.requiredCategories.push('missing'); },
    p => { p.completion.requiredCategories.push('backups'); }, p => { p.steps.pop(); }, p => { p.steps.push(p.steps[0]); },
    p => { p.steps[0].status = 'unknown'; }, p => { p.steps[0].status = 'failed'; },
    p => { p.completion.evidence = absent('unknown'); }, p => { p.completion.evidence.projection.bindingDigest = 'bad'; },
    p => { p.completion.evidence.projection.observedAtMs = '1800000000000'; }, p => { p.verifiedActionMethod = null; },
    p => { p.phase = 'awaiting_reauthentication'; p.disabled = false; },
    p => { p.backupExpiryAt = '2099-01-01T00:00:00.000Z'; },
    p => { p.backupExpiryAt = '2026-10-01T00:00:00.000Z'; p.backup.dispositionEvidenceDigest = null; },
    p => { p.backup.policyVersion = null; }, p => { p.backup.inventoryDigest = null; },
    p => { p.steps[0].retainUntilMs = 1; },
  ];
  for (const mutate of mutations) {
    const v = terminal(); mutate(v.payload);
    for (const codec of [server, client]) rejected(codec, JSON.stringify(v), expect('deletion'));
  }
  for (const state of ['unavailable', 'unknown']) {
    for (const status of ['pending', 'retained', 'unknown', 'unavailable']) {
      const v = deletion(state); v.payload.steps[0].status = status;
      for (const codec of [server, client]) assert.deepEqual(codec.decodeLifecycleV2(server.encodeLifecycleV2(v), expect('deletion')), v);
    }
    const v = deletion(state); v.payload.localPurged = true;
    for (const codec of [server, client]) rejected(codec, JSON.stringify(v), expect('deletion'));
  }
  const ttl = deletion(); ttl.payload.backupExpiryAt = '2026-10-01T00:00:00.000Z'; ttl.payload.steps[4].retainUntilMs = 1; ttl.payload.steps[4].retentionPolicyVersion = 'fixture-policy';
  for (const codec of [server, client]) rejected(codec, JSON.stringify(ttl), expect('deletion'));
  const backup = terminal(); backup.payload.backupExpiryAt = '2026-10-01T00:00:00.000Z';
  for (const codec of [server, client]) assert.deepEqual(codec.decodeLifecycleV2(server.encodeLifecycleV2(backup), expect('deletion')), backup);
});

test('export category counts, scope, evidence, omissions and residuals survive genuine interop', async () => {
  const server = await serverPromise;
  for (const mutate of [
    e => { e.records[0].value.accountId = 'wrong'; }, e => { e.records[0].category = 'unmapped'; },
    e => { e.manifest.categories[0].count = 0; }, e => { e.manifest.categories.push(e.manifest.categories[0]); },
    e => { e.manifest.snapshotCompletion.requiredCategories = ['missing']; }, e => { e.manifest.snapshotCompletion.requiredCategories = []; },
    e => { e.manifest.omissions[0].effect = 'in_scope_missing'; }, e => { e.manifest.categories[0].omittedCount = 1; },
    e => { e.manifest.snapshotCompletion.evidence = absent('unavailable'); }, e => { e.manifest.provenance.consistency = 'eventual'; },
    e => { e.manifest.schemaVersion = 'form.account-export.v1'; }, e => { e.manifest.complete = true; },
    e => { e.manifest.residuals.push(e.manifest.residuals[0]); }, e => { e.manifest.omissions.push(e.manifest.omissions[0]); },
  ]) { const v = exported(); mutate(v.payload); for (const codec of [server, client]) rejected(codec, JSON.stringify(v), expect('export')); }
  for (const count of [0, 1, null]) {
    const v = exported(); Object.assign(v.payload.manifest.omissions[0], { effect: 'in_scope_missing', count }); v.payload.manifest.snapshotCompletion.status = count === 0 ? 'complete' : 'pending';
    for (const codec of [server, client]) assert.deepEqual(codec.decodeLifecycleV2(server.encodeLifecycleV2(v), expect('export')), v);
  }
});

test('raw JSON preserves duplicate and escaped duplicate detection at every depth', async () => {
  const server = await serverPromise;
  const wire = JSON.stringify(exported());
  const source = JSON.stringify(exported().payload.records[0].value);
  const vectors = [wire + ' true', '{', wire.replace('"kind":', '"kind":"export","k\\u0069nd":'),
    wire.replace('"scope":', '"scope":{},"scope":'), wire.replace('"epoch":7', '"epoch":"7"'),
    wire.replace(source, '{"nested":{"value":1,"v\\u0061lue":2}}'), wire.replace(source, '{"__proto__":{}}'),
    wire.replace(source, '{"constructor":{}}'), wire.replace(source, '{"prototype":{}}'), wire.replace(source, '"\\ud800"'),
    wire.replace(source, '"\udfff"'), wire.replace(source, '1e999'), wire.replace(source, 'NaN'), wire.replace(source, 'Infinity')];
  for (const codec of [server, client]) for (const raw of vectors) rejected(codec, raw, expect('export'));
  const escapes = exported(); escapes.payload.records[0].value.note = '"\\\b\f\n\r\t\u0000é🧘';
  for (const codec of [server, client]) assert.deepEqual(codec.decodeLifecycleV2(server.encodeLifecycleV2(escapes), expect('export')), escapes);
});

test('256 metadata entries accepts; 257 rejects; records exceed 256 without truncation', async () => {
  const server = await serverPromise;
  const v = deletion(); while (v.payload.steps.length < 256) v.payload.steps.push({ ...v.payload.steps[0], category: `fixture_${v.payload.steps.length}` });
  for (const codec of [server, client]) assert.equal(codec.decodeLifecycleV2(server.encodeLifecycleV2(v), expect('deletion')).payload.steps.length, 256);
  v.payload.steps.push({ ...v.payload.steps[0], category: 'overflow' });
  for (const codec of [server, client]) rejected(codec, JSON.stringify(v), expect('deletion'), 'lifecycle_v2_limit_exceeded');
  v.schemaVersion = 'form.account-lifecycle.v3';
  for (const codec of [server, client]) rejected(codec, JSON.stringify(v), expect('deletion'), 'lifecycle_v2_limit_exceeded');
  const e = exported(); e.payload.records = Array.from({ length: 300 }, () => ({ category: 'identity', value: { accountId: 'fixture-account' } })); e.payload.manifest.categories[0].count = 300;
  e.payload.records[0].value.nested = Array.from({ length: 300 }, (_, i) => i);
  for (const codec of [server, client]) assert.equal(codec.decodeLifecycleV2(server.encodeLifecycleV2(e), expect('export')).payload.records.length, 300);
});

test('exact depth and total UTF8 byte boundaries agree across independent parsers', async () => {
  const server = await serverPromise;
  const deep = exported(); deep.payload.records[0].category = 'data'; deep.payload.manifest.categories[0].category = 'data'; deep.payload.manifest.snapshotCompletion.requiredCategories = ['data'];
  let nested = 'fixture-record-private'; for (let i = 0; i < 60; i++) nested = [nested]; deep.payload.records[0].value = nested;
  for (const codec of [server, client]) assert.equal(codec.decodeLifecycleV2(server.encodeLifecycleV2(deep), expect('export')).kind, 'export');
  deep.payload.records[0].value = [nested]; for (const codec of [server, client]) rejected(codec, JSON.stringify(deep), expect('export'), 'lifecycle_v2_limit_exceeded');
  const small = JSON.stringify(deletion()), exactSmall = small + ' '.repeat(65536 - Buffer.byteLength(small));
  for (const codec of [server, client]) {
    assert.equal(codec.decodeLifecycleV2(exactSmall, expect('deletion')).kind, 'deletion');
    rejected(codec, exactSmall + ' ', expect('deletion'), 'lifecycle_v2_limit_exceeded');
    rejected(codec, JSON.stringify({ ...exported(), kind: 'unknown' }) + ' '.repeat(65536), expect('export'), 'lifecycle_v2_limit_exceeded');
  }
  const e = exported(); e.payload.records[0].value.note = '';
  const overhead = Buffer.byteLength(JSON.stringify(e)), room = 16777216 - overhead;
  e.payload.records[0].value.note = 'é'.repeat(Math.floor(room / 2)) + 'x'.repeat(room % 2);
  const wire = server.encodeLifecycleV2(e); assert.equal(Buffer.byteLength(wire), 16777216);
  for (const codec of [server, client]) { assert.equal(codec.decodeLifecycleV2(wire, expect('export')).kind, 'export'); rejected(codec, wire + ' ', expect('export'), 'lifecycle_v2_limit_exceeded'); }
});
