import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeLifecycleV2, decodeLifecycleV2, LifecycleV2Error, type ExpectedV2, type LifecycleV2ErrorCode } from '../src/lifecycle/wire-v2.js';

const version = 'form.account-lifecycle.v2' as const;
const requestId = '11111111-1111-4111-8111-111111111111';
const categoryNames = ['form_training_history', 'phone_challenges', 'purchase_proofs', 'auth_identity', 'backups', 'providers', 'activity', 'community'];
const current = () => ({ state: 'current', reason: null, projection: { bindingDigest: 'a'.repeat(64), observedAtMs: 1800000000000 } });
const unavailable = () => ({ state: 'unavailable', reason: 'evidence_unavailable', projection: null });
const expectedDeletion: ExpectedV2 = { schemaVersion: version, kind: 'deletion', requestId };
const expectedExport: ExpectedV2 = { schemaVersion: version, kind: 'export', accountId: 'fixture-account', epoch: 7 };
function deletion() {
  return { schemaVersion: version, kind: 'deletion', payload: { requestId, phase: 'awaiting_reauthentication', initiated: true,
    disabled: false, localPurged: false, complete: false, requestedAt: '2026-10-01T00:00:00.000Z', verifiedActionMethod: null as string | null,
    backupExpiryAt: null as string | null, backup: { status: 'unavailable', policyVersion: null as string | null, inventoryDigest: null as string | null, dispositionEvidenceDigest: null as string | null },
    billingCancellation: 'not_performed', completion: { scope: 'declared_server_targets', status: 'unavailable', requiredCategories: [...categoryNames], localCategories: ['form_training_history'], evidence: unavailable() as ReturnType<typeof unavailable> | ReturnType<typeof current> },
    steps: categoryNames.map(category => ({ category, status: category === 'backups' ? 'unavailable' : 'pending', reason: null as string | null, retainUntilMs: null as number | null, retentionPolicyVersion: null as string | null })) } };
}
function terminal() {
  const d = deletion(); d.payload.phase = 'declared_scope_complete'; d.payload.disabled = true; d.payload.localPurged = true; d.payload.verifiedActionMethod = 'password';
  d.payload.completion.status = 'complete'; d.payload.completion.evidence = current();
  d.payload.steps.forEach(s => { s.status = 'complete'; });
  Object.assign(d.payload.backup, { status: 'complete', policyVersion: 'fixture-policy', inventoryDigest: 'b'.repeat(64), dispositionEvidenceDigest: 'c'.repeat(64) });
  return d;
}
function exported() {
  return { schemaVersion: version, kind: 'export', payload: { records: [{ category: 'identity', value: { accountId: 'fixture-account', note: 'é🧘漢' } as unknown }],
    manifest: { schemaVersion: 'form.account-export.v2', snapshotAtMs: 1800000000000, complete: false, scope: { accountId: 'fixture-account', epoch: 7 },
      provenance: { source: 'account-scoped-sqlite-read-transaction', consistency: 'single-connection-snapshot', authorization: 'caller-authoritative-session-epoch-suppression-before-generation-and-release', adapterConsistency: 'caller-qualified-synchronous-adapters' },
      categories: [{ category: 'identity', status: 'complete', count: 1, omittedCount: 0, reason: null }],
      omissions: [{ category: 'credentials', reason: 'authentication_internal', count: null as number | null, effect: 'excluded_from_scope' }],
      residuals: [{ category: 'device_copies', status: 'unknown', reason: 'outside_server_scope' }],
      snapshotCompletion: { scope: 'declared_server_snapshot', status: 'complete', requiredCategories: ['identity'], evidence: current() } } } };
}
function error(call: () => unknown, code?: LifecycleV2ErrorCode): void {
  assert.throws(call, e => {
    assert.ok(e instanceof LifecycleV2Error);
    if (code) assert.equal(e.code, code);
    assert.equal(e.message, e.code); assert.equal(e.effectUnknown, true);
    assert.ok(!e.stack?.includes('fixture-private-secret')); return true;
  });
}
const rejectDeletion = (d: unknown, code?: LifecycleV2ErrorCode) => {
  error(() => encodeLifecycleV2(d), code);
  error(() => decodeLifecycleV2(JSON.stringify(d), expectedDeletion), code);
};

test('all four envelopes round-trip deterministically; scoped fixtures never claim whole completion', () => {
  const capability = { schemaVersion: version, kind: 'capabilities', payload: { accountId: 'fixture-account', status: 'unavailable', initiation: false,
    actionReauthenticationMethods: [], policyVersion: 'form-account-lifecycle-v1', wholeAccountDeletionComplete: false, exportMaxBytes: 16777216, billingCancellation: 'not_performed' } };
  const grant = { schemaVersion: version, kind: 'action_grant', payload: { grant: 'g'.repeat(43), purpose: 'account_export', method: 'password', expiresAt: '2026-10-28T00:00:00.000Z' } };
  const cases: [unknown, ExpectedV2][] = [[capability, { schemaVersion: version, kind: 'capabilities', accountId: 'fixture-account' }],
    [grant, { schemaVersion: version, kind: 'action_grant', purpose: 'account_export', nowMs: 0, allowedMethods: ['password'] }],
    [deletion(), expectedDeletion], [terminal(), expectedDeletion], [exported(), expectedExport]];
  for (const [value, expected] of cases) {
    const wire = encodeLifecycleV2(value), parsed = decodeLifecycleV2(wire, expected);
    assert.deepEqual(parsed, value); assert.equal(encodeLifecycleV2(parsed), wire);
    assert.ok(Object.isFrozen(parsed) && Object.isFrozen(parsed.payload));
  }
  const d = deletion(); const reversed = Object.fromEntries(Object.entries(d.payload).reverse());
  assert.equal(encodeLifecycleV2({ payload: reversed, kind: d.kind, schemaVersion: version }), encodeLifecycleV2(d));
});

test('current evidence derives local and scoped completion from nonempty unique closed sets', () => {
  const partial = terminal(); partial.payload.phase = 'pending_external'; partial.payload.completion.status = 'pending';
  partial.payload.steps[2]!.status = 'retained'; partial.payload.steps[2]!.reason = 'statutory_retention';
  assert.deepEqual(decodeLifecycleV2(encodeLifecycleV2(partial), expectedDeletion), partial);
  for (const mutate of [
    (d: ReturnType<typeof terminal>) => { d.payload.localPurged = false; },
    (d: ReturnType<typeof terminal>) => { d.payload.completion.requiredCategories = []; },
    (d: ReturnType<typeof terminal>) => { d.payload.completion.localCategories = []; },
    (d: ReturnType<typeof terminal>) => { d.payload.completion.localCategories.push('absent'); },
    (d: ReturnType<typeof terminal>) => { d.payload.completion.requiredCategories.push(categoryNames[0]!); },
    (d: ReturnType<typeof terminal>) => { d.payload.steps.pop(); },
    (d: ReturnType<typeof terminal>) => { d.payload.steps.push(d.payload.steps[0]!); },
    (d: ReturnType<typeof terminal>) => { d.payload.steps[0]!.status = 'pending'; },
    (d: ReturnType<typeof terminal>) => { d.payload.verifiedActionMethod = null; },
    (d: ReturnType<typeof terminal>) => { d.payload.phase = 'awaiting_reauthentication'; d.payload.disabled = false; },
    (d: ReturnType<typeof terminal>) => { d.payload.completion.evidence = unavailable(); },
  ]) { const d = terminal(); mutate(d); rejectDeletion(d, 'lifecycle_v2_inconsistent'); }
});

test('unavailable and unknown stay unresolved; old phase, complete booleans and raw adapter statuses reject', () => {
  for (const state of ['unavailable', 'unknown']) {
    const d = deletion(); d.payload.disabled = true; d.payload.phase = 'disabled_pending_reconciliation';
    d.payload.completion.evidence = { state, reason: 'evidence_missing', projection: null }; d.payload.completion.status = state;
    assert.deepEqual(decodeLifecycleV2(encodeLifecycleV2(d), expectedDeletion), d);
    d.payload.steps[0]!.status = 'complete'; rejectDeletion(d, 'lifecycle_v2_inconsistent');
  }
  const d = deletion(); d.payload.verifiedActionMethod = 'password'; rejectDeletion(d, 'lifecycle_v2_inconsistent');
  for (const phase of ['complete', 'running', 'failed']) rejectDeletion({ ...deletion(), payload: { ...deletion().payload, phase } });
  rejectDeletion({ ...deletion(), payload: { ...deletion().payload, complete: true } });
  for (const raw of ['running', 'failed', 'not_applicable']) { const d = deletion(); d.payload.steps[0]!.status = raw; rejectDeletion(d); }
});

test('backup cutoff needs actual current disposition and policy, never elapsed retention', () => {
  const d = terminal(); d.payload.backupExpiryAt = '2026-10-01T00:00:00.000Z';
  assert.deepEqual(decodeLifecycleV2(encodeLifecycleV2(d), expectedDeletion), d);
  for (const key of ['policyVersion', 'inventoryDigest', 'dispositionEvidenceDigest'] as const) { const bad = terminal(); bad.payload.backupExpiryAt = d.payload.backupExpiryAt; bad.payload.backup[key] = null; rejectDeletion(bad); }
  const future = terminal(); future.payload.backupExpiryAt = '2099-01-01T00:00:00.000Z'; rejectDeletion(future);
  const ttl = deletion(); ttl.payload.backupExpiryAt = d.payload.backupExpiryAt; ttl.payload.steps[4]!.retainUntilMs = 1; ttl.payload.steps[4]!.retentionPolicyVersion = 'fixture-policy'; rejectDeletion(ttl);
  const deadline = deletion(); deadline.payload.steps[0]!.retainUntilMs = 1; rejectDeletion(deadline);
});

test('export counts, snapshot scope, provenance, omissions and residuals are enforced separately', () => {
  for (const mutate of [
    (e: ReturnType<typeof exported>) => { e.payload.manifest.categories[0]!.count++; },
    (e: ReturnType<typeof exported>) => { e.payload.records[0]!.category = 'unmapped'; },
    (e: ReturnType<typeof exported>) => { e.payload.records[0]!.value = { accountId: 'wrong' }; },
    (e: ReturnType<typeof exported>) => { e.payload.manifest.categories.push(e.payload.manifest.categories[0]!); },
    (e: ReturnType<typeof exported>) => { e.payload.manifest.snapshotCompletion.requiredCategories = ['missing']; },
    (e: ReturnType<typeof exported>) => { e.payload.manifest.snapshotCompletion.requiredCategories = []; },
    (e: ReturnType<typeof exported>) => { e.payload.manifest.omissions[0]!.effect = 'in_scope_missing'; },
    (e: ReturnType<typeof exported>) => { e.payload.manifest.categories[0]!.omittedCount = 1; },
    (e: ReturnType<typeof exported>) => { e.payload.manifest.provenance.source = 'asserted_by_caller'; },
    (e: ReturnType<typeof exported>) => { e.payload.manifest.schemaVersion = 'form.account-export.v1'; },
  ]) { const e = exported(); mutate(e); error(() => encodeLifecycleV2(e)); error(() => decodeLifecycleV2(JSON.stringify(e), expectedExport)); }
  const partial = exported(); partial.payload.manifest.omissions[0]!.effect = 'in_scope_missing'; partial.payload.manifest.snapshotCompletion.status = 'pending';
  assert.deepEqual(decodeLifecycleV2(encodeLifecycleV2(partial), expectedExport), partial);
});

test('explicit version/kind precede semantic validation; expected subjects and grants bind only after it', () => {
  const d = deletion(), text = JSON.stringify(d);
  for (const schemaVersion of [undefined, 'form.account-lifecycle.v1', 'form.account-lifecycle.v3']) error(() => decodeLifecycleV2(JSON.stringify({ ...d, schemaVersion }), expectedDeletion), 'unsupported_lifecycle_version');
  error(() => decodeLifecycleV2(text, expectedExport), 'lifecycle_kind_mismatch');
  error(() => decodeLifecycleV2(text, { ...expectedDeletion, requestId: '22222222-2222-4222-8222-222222222222' }), 'lifecycle_subject_mismatch');
  error(() => decodeLifecycleV2(JSON.stringify(exported()), { ...expectedExport, epoch: 8 }), 'lifecycle_subject_mismatch');
  error(() => decodeLifecycleV2(JSON.stringify(exported()), { ...expectedExport, accountId: 'wrong' }), 'lifecycle_subject_mismatch');
  const grant = { schemaVersion: version, kind: 'action_grant', payload: { grant: 'fixture-private-secret'.padEnd(43, 'x'), purpose: 'account_delete', method: 'phone_action_code', expiresAt: '2026-10-28T00:00:00.000Z' } };
  const expected: ExpectedV2 = { schemaVersion: version, kind: 'action_grant', purpose: 'account_delete', nowMs: 0, allowedMethods: ['phone_action_code'] };
  assert.deepEqual(decodeLifecycleV2(encodeLifecycleV2(grant), expected), grant);
  for (const next of [{ ...expected, purpose: 'account_export' as const }, { ...expected, allowedMethods: ['password' as const] }, { ...expected, nowMs: Date.parse(grant.payload.expiresAt) }, { ...expected, allowedMethods: [] }]) error(() => decodeLifecycleV2(JSON.stringify(grant), next), 'lifecycle_grant_mismatch');
});

test('raw duplicate, escaped duplicate, prototype, invalid Unicode, malformed scalar and dates fail', () => {
  const wire = JSON.stringify(deletion());
  for (const raw of ['{', wire + 'x', wire.replace('"kind":', '"kind":"deletion","kind":'), wire.replace('"phase":', '"ph\\u0061se":"purging","phase":'),
    wire.replace('"complete":false', '"complete":"false"'), wire.replace('"localPurged":false', '"localPurged":NaN'),
    wire.replace('2026-10-01T00:00:00.000Z', '2026-02-30T00:00:00.000Z'), wire.replace('.000Z', 'Z'),
    wire.replace('"initiated":true', '"__proto__":{},"initiated":true'), wire.replace('"requestId":', '"constructor":{},"requestId":'),
    wire.replace('"scope":"declared_server_targets"', '"scope":"\\ud800"'), wire.replace('"initiated":true', '"initiated":true,"extra":null')]) error(() => decodeLifecycleV2(raw, expectedDeletion));
  const e = exported();
  for (const raw of ['{"a":1,"\\u0061":2}', '{"prototype":null}', '"\\udfff"', '1e999']) {
    error(() => decodeLifecycleV2(JSON.stringify(e).replace(JSON.stringify(e.payload.records[0]!.value), raw), expectedExport));
  }
});

test('encoder rejects getters without invocation, cycles, nonplain/symbol/undefined and nonfinite data', () => {
  let invoked = 0;
  const e = exported(), cycle: Record<string, unknown> = {}; cycle.self = cycle;
  const accessor = Object.defineProperty({}, 'secret', { enumerable: true, get() { invoked++; throw new Error('fixture-private-secret'); } });
  const hostile = new Proxy({ secret: 1 }, { getOwnPropertyDescriptor() { throw new Error('fixture-private-secret'); } });
  const forged = new LifecycleV2Error('invalid_lifecycle_v2'); forged.message = 'fixture-private-secret';
  const disguised = new Proxy({ secret: 1 }, { getOwnPropertyDescriptor() { throw forged; } });
  for (const value of [cycle, accessor, hostile, disguised, new Date(), new Map(), Symbol(), 1n, undefined, NaN, Infinity, '\ud800', { private: undefined }, { [Symbol()]: 1 }, Object.create({ inherited: 1 }), [,]]) {
    e.payload.records[0]!.value = value; error(() => encodeLifecycleV2(e));
  }
  assert.equal(invoked, 0);
});

test('metadata 256 accepts and 257 rejects while record rows have only the byte budget', () => {
  const d = deletion();
  while (d.payload.steps.length < 256) d.payload.steps.push({ ...d.payload.steps[0]!, category: `fixture_${d.payload.steps.length}` });
  assert.equal(decodeLifecycleV2(encodeLifecycleV2(d), expectedDeletion).kind, 'deletion');
  d.payload.steps.push({ ...d.payload.steps[0]!, category: 'overflow' }); rejectDeletion(d, 'lifecycle_v2_limit_exceeded');
  const e = exported(); e.payload.records = Array.from({ length: 257 }, () => ({ category: 'identity', value: { accountId: 'fixture-account' } })); e.payload.manifest.categories[0]!.count = 257;
  assert.equal(decodeLifecycleV2(encodeLifecycleV2(e), expectedExport).kind, 'export');
  e.payload.records[0]!.value = { accountId: 'fixture-account', nested: Array.from({ length: 300 }, (_, i) => i) };
  assert.equal(decodeLifecycleV2(encodeLifecycleV2(e), expectedExport).kind, 'export');
});

test('depth counts containers: exact 64 accepts and one deeper rejects', () => {
  const e = exported(); let nested: unknown = 0;
  for (let i = 0; i < 60; i++) nested = [nested];
  e.payload.records[0]!.category = 'data'; e.payload.manifest.categories[0]!.category = 'data'; e.payload.manifest.snapshotCompletion.requiredCategories = ['data']; e.payload.records[0]!.value = nested;
  assert.equal(decodeLifecycleV2(encodeLifecycleV2(e), expectedExport).kind, 'export');
  e.payload.records[0]!.value = [nested]; error(() => encodeLifecycleV2(e), 'lifecycle_v2_limit_exceeded'); error(() => decodeLifecycleV2(JSON.stringify(e), expectedExport), 'lifecycle_v2_limit_exceeded');
});

test('nonexport budget includes the envelope: exact 64KiB accepts, plus one rejects', () => {
  const d = deletion();
  while (d.payload.steps.length < 256) d.payload.steps.push({ ...d.payload.steps[0]!, category: `fixture_${d.payload.steps.length}` });
  let left = 65536 - Buffer.byteLength(JSON.stringify(d));
  for (const step of d.payload.steps) {
    if (left <= 0) break;
    const length = Math.min(256, left + 2); step.retentionPolicyVersion = 'p'.repeat(length); left -= length - 2;
  }
  assert.equal(left, 0); assert.equal(Buffer.byteLength(encodeLifecycleV2(d)), 65536);
  assert.equal(decodeLifecycleV2(encodeLifecycleV2(d), expectedDeletion).kind, 'deletion');
  const available = d.payload.steps.find(s => s.retentionPolicyVersion !== null && s.retentionPolicyVersion.length < 256)!;
  available.retentionPolicyVersion += 'p'; rejectDeletion(d, 'lifecycle_v2_limit_exceeded');
});

test('export UTF8 budget includes manifest/envelope overhead and multibyte text at 16MiB', () => {
  const e = exported(); e.payload.records[0]!.value = { accountId: 'fixture-account', note: '' };
  const room = 16777216 - Buffer.byteLength(JSON.stringify(e));
  e.payload.records[0]!.value = { accountId: 'fixture-account', note: '🧘'.repeat(Math.floor(room / 4)) + 'x'.repeat(room % 4) };
  const wire = encodeLifecycleV2(e); assert.equal(Buffer.byteLength(wire), 16777216);
  assert.equal(decodeLifecycleV2(wire, expectedExport).kind, 'export');
  e.payload.records[0]!.value = { accountId: 'fixture-account', note: '🧘'.repeat(Math.floor(room / 4)) + 'x'.repeat(room % 4 + 1) };
  error(() => encodeLifecycleV2(e), 'lifecycle_v2_limit_exceeded'); error(() => decodeLifecycleV2(JSON.stringify(e), expectedExport), 'lifecycle_v2_limit_exceeded');
});
