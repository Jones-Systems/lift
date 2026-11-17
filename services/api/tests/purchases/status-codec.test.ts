import test from 'node:test';
import assert from 'node:assert/strict';
import {
  STATUS_CODEC_V1, STATUS_CODEC_LIMITS, StatusCodecError,
  parseStatusBindingV1, parseStatusEvidenceV1, parseStatusProjectionV1,
  serializeStatusBindingV1, serializeStatusEvidenceV1, serializeStatusProjectionV1,
  statusBindingIdV1, statusEvidenceIdV1, statusProjectionIdV1,
  compareStatusEvidenceV1, reduceStatusEvidenceV1,
  type StatusBindingV1, type StatusEvidenceV1, type StatusObservationV1, type StatusProjectionV1,
} from '../../src/purchases/status-codec.js';

// Synthetic normalized records exercise shape and order only, never Apple proof or caller authority.
const hex = (n: number): string => n.toString(16).padStart(64, '0');
const uuid = '11111111-1111-4111-8111-111111111111';
function binding(): StatusBindingV1 {
  return {
    version: STATUS_CODEC_V1.binding,
    owner: { accountId: uuid, appAccountToken: uuid, originalTransactionId: '10000', bundleId: 'com.form.test', environment: 'Sandbox' },
    authActorDigest: hex(1), epoch: 1, nativeStoreDigest: hex(2), generation: 'generation-1',
    schemaCohort: 'selected-subscription-status-27', schemaDigest: hex(3), authorityId: 'authority-1', authoritySchema: 'authority-v1',
    suppression: { sequence: 1, headDigest: hex(4) },
    continuity: { revision: 1, highWaterMs: 100, digest: hex(5), restoreBoundaryMs: 0 },
  };
}
function status(tx = 100, renewal = 100): StatusObservationV1 {
  return {
    version: STATUS_CODEC_V1.evidence, kind: 'status', bindingId: statusBindingIdV1(binding()),
    originalTransactionId: '10000', requestId: 'request-1', recordedAtMs: 150,
    status: 'active', subscriptionGroupIdentifier: 'group-1',
    transaction: { transactionId: '10001', productId: 'form.plus.month', purchaseDate: 10, signedDate: tx,
      expiresDate: 1000, revocationDate: null, isUpgraded: false },
    renewal: { productId: 'form.plus.month', autoRenewProductId: null, signedDate: renewal,
      autoRenewStatus: 1, isInBillingRetryPeriod: false, gracePeriodExpiresDate: null },
    transactionProofHash: hex(tx), renewalProofHash: hex(renewal), providerResponseDigest: hex(6),
    normalizedClaimDigest: hex(tx * 1000 + renewal),
  };
}
function records(): StatusEvidenceV1[] {
  const s = status();
  const base = { version: s.version, bindingId: s.bindingId, originalTransactionId: s.originalTransactionId,
    requestId: s.requestId, recordedAtMs: s.recordedAtMs };
  return [
    { ...base, kind: 'dispatch', requestKeyDigest: hex(7), capturedRevision: 0,
      issuedAtMs: 100, deadlineAtMs: 200, rateWindowStartMs: 0, rateOrdinal: 1 },
    s,
    { ...base, kind: 'history', page: { handle: 'history-1', pageIndex: 0, pageDigest: hex(8) },
      transactionProofHashes: [hex(100)], renewalProofHashes: [hex(100)], reason: 'ledger_changed' },
    { ...base, kind: 'notification', notificationId: uuid, payloadDigest: hex(9),
      transactionProofHashes: [hex(100)], renewalProofHashes: [], reason: 'notification_changed' },
    { ...base, kind: 'outcome', outcome: 'observed', reason: 'observed', producerSettlement: 'settled_success',
      observationIds: [statusEvidenceIdV1(s)], resultingRevision: 1 },
  ];
}
function projection(): StatusProjectionV1 {
  return { version: STATUS_CODEC_V1.projection, bindingId: statusBindingIdV1(binding()), originalTransactionId: '10000',
    revision: 1, observationId: statusEvidenceIdV1(status()), ledgerFingerprintDigest: hex(10), result: 'held',
    reason: 'held', validUntilMs: null, activeDispatchObservationId: null };
}
function reversed(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reversed);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).reverse().map(([k, v]) => [k, reversed(v)]));
  return value;
}
const rejects = (effect: () => unknown) => assert.throws(effect, (e: unknown) => {
  assert.ok(e instanceof StatusCodecError);
  assert.equal(e.message, 'Invalid subscription status record');
  return true;
});

test('all seven record domains round trip canonically with deterministic key order and exact identity', () => {
  const triples = [
    [binding(), parseStatusBindingV1, serializeStatusBindingV1, statusBindingIdV1],
    ...records().map(v => [v, parseStatusEvidenceV1, serializeStatusEvidenceV1, statusEvidenceIdV1] as const),
    [projection(), parseStatusProjectionV1, serializeStatusProjectionV1, statusProjectionIdV1],
  ] as const;
  // Fixed vectors bind every documented domain, NUL separator and canonical UTF-8 encoding.
  const expected = [
    '2f298ff70faa9ca7b130ca482ea706fc476d1e6f064818c4fe2556c754863284',
    '4d4157c9fd73a469d524c45f73688c462ec91d9793766fe73a50fee4a2f70481',
    '39b642541a72a57c1f334419b6a7e9649325229dbd3a57a433abfa81c149eb49',
    '2f7093000ce30841f5675aceab6c649756d7bcf6aa432d0e488d33c1804d9655',
    '15815326d3fc3b8a59e8773c5a110ffe8d53ae266e3b96d4b206ea7fb2248bfa',
    'ed56385484c573519fd49d0bf357701aba55c76a271e311a13c1376fbe28108d',
    '517dc5a2c8ee03fc48363d3320b353d966441fed8d530064c71e4ab7a0e45b4c',
  ];
  const ids = new Set<string>();
  let vectorIndex = 0;
  for (const [value, parse, serialize, identity] of triples) {
    const canonical = serialize(value);
    assert.equal(serialize(parse(canonical)), canonical);
    assert.equal(serialize(reversed(value)), canonical);
    assert.equal(identity(reversed(value)), identity(value));
    assert.equal(serialize(' \n' + canonical + '\t'), canonical);
    assert.match(identity(value), /^[0-9a-f]{64}$/);
    assert.equal(identity(value), expected[vectorIndex++]);
    ids.add(identity(value));
  }
  assert.equal(ids.size, 7);
});

test('binding identities cover every owner, actor, schema, native, suppression and continuity field', () => {
  const b = binding();
  const changes: StatusBindingV1[] = [
    { ...b, owner: { ...b.owner, accountId: 'account-2' } },
    { ...b, owner: { ...b.owner, appAccountToken: '22222222-2222-4222-8222-222222222222' } },
    { ...b, owner: { ...b.owner, originalTransactionId: '20000' } },
    { ...b, owner: { ...b.owner, bundleId: 'com.form.other' } },
    { ...b, authActorDigest: hex(11) }, { ...b, epoch: 2 }, { ...b, nativeStoreDigest: hex(12) },
    { ...b, generation: 'generation-2' }, { ...b, schemaDigest: hex(13) }, { ...b, authorityId: 'authority-2' },
    { ...b, authoritySchema: 'authority-v2' }, { ...b, suppression: { ...b.suppression, sequence: 2 } },
    { ...b, suppression: { ...b.suppression, headDigest: hex(14) } },
    { ...b, continuity: { ...b.continuity, revision: 2 } }, { ...b, continuity: { ...b.continuity, highWaterMs: 101 } },
    { ...b, continuity: { ...b.continuity, digest: hex(15) } }, { ...b, continuity: { ...b.continuity, restoreBoundaryMs: 1 } },
  ];
  assert.equal(new Set([b, ...changes].map(statusBindingIdV1)).size, changes.length + 1);
  rejects(() => parseStatusBindingV1({ ...b, schemaCohort: 'selected-action-reauthentication-26' }));
});

test('evidence/projection hashes cover receipt, proofs, pointers, revision, decision and cutoff', () => {
  const s = status();
  const changes = [
    { ...s, bindingId: hex(90) }, { ...s, requestId: 'request-2' }, { ...s, originalTransactionId: '20000' },
    { ...s, recordedAtMs: 151 }, { ...s, transactionProofHash: hex(91) }, { ...s, renewalProofHash: hex(92) },
    { ...s, providerResponseDigest: hex(93) }, { ...s, normalizedClaimDigest: hex(94) },
    { ...s, transaction: { ...s.transaction, expiresDate: 1001 } },
  ];
  assert.equal(new Set([s, ...changes].map(statusEvidenceIdV1)).size, changes.length + 1);
  const p = projection();
  for (const changed of [{ ...p, revision: 2 }, { ...p, observationId: hex(16) }, { ...p, activeDispatchObservationId: hex(17) },
    { ...p, ledgerFingerprintDigest: hex(18) }, { ...p, result: 'inactive' }, { ...p, validUntilMs: 1000 }, { ...p, reason: 'stale' }]) {
    assert.notEqual(statusProjectionIdV1(changed), statusProjectionIdV1(p));
  }
});

test('parser copies and deeply freezes ordinary/null-prototype input without invoking hooks', () => {
  const raw = status();
  const copy = parseStatusEvidenceV1(raw);
  assert.notEqual(copy, raw);
  assert.equal(copy.kind, 'status');
  if (copy.kind !== 'status') throw new Error('fixture');
  assert.ok(Object.isFrozen(copy)); assert.ok(Object.isFrozen(copy.transaction));
  assert.equal(Object.getPrototypeOf(copy), null);
  assert.equal(serializeStatusEvidenceV1(Object.assign(Object.create(null), raw)), serializeStatusEvidenceV1(raw));
  assert.throws(() => { (copy.transaction as { signedDate: number }).signedDate = 900; }, TypeError);
  rejects(() => parseStatusEvidenceV1({ ...raw, toJSON() { throw new Error('must not run'); } }));
});

test('every record rejects missing/unknown keys, wrong version and discriminant', () => {
  for (const value of [binding(), ...records(), projection()]) {
    const parse = value.version === STATUS_CODEC_V1.binding ? parseStatusBindingV1
      : value.version === STATUS_CODEC_V1.projection ? parseStatusProjectionV1 : parseStatusEvidenceV1;
    for (const key of Object.keys(value)) {
      const changed: Record<string, unknown> = { ...value }; delete changed[key];
      rejects(() => parse(changed));
    }
    rejects(() => parse({ ...value, extra: true }));
    rejects(() => parse({ ...value, version: 'form.subscription-status.evidence/v2' }));
  }
  rejects(() => parseStatusEvidenceV1({ ...status(), kind: 'constructor' }));
  rejects(() => parseStatusEvidenceV1({ ...status(), transaction: { ...status().transaction, proof: 'raw' } }));
  rejects(() => parseStatusBindingV1({ ...binding(), owner: { ...binding().owner, verified: true } }));
  rejects(() => parseStatusProjectionV1({ ...projection(), verified: true }));
});

test('untrusted accessors, symbols, hidden keys, inherited fields, custom prototypes and proxies fail without executing hooks', () => {
  let touched = false;
  const getter = { ...status() };
  Object.defineProperty(getter, 'transaction', { enumerable: true, get() { touched = true; return {}; } });
  const hidden = { ...status() }; Object.defineProperty(hidden, 'secret', { value: 'never', enumerable: false });
  const symbolic = { ...status(), [Symbol('secret')]: true };
  const inherited = Object.create(status());
  const protoKey = Object.assign(Object.create(null), status(), { ['__proto__']: {} });
  const proxy = new Proxy(status(), { ownKeys() { touched = true; throw new Error('must not run'); } });
  for (const value of [getter, hidden, symbolic, inherited, protoKey, proxy, new Date(), new Map(), new Set()]) {
    rejects(() => parseStatusEvidenceV1(value));
  }
  assert.equal(touched, false);
  const cycle: Record<string, unknown> = { ...status() }; cycle.cycle = cycle;
  rejects(() => parseStatusEvidenceV1(cycle));
  for (const bad of [undefined, null, true, 1, () => status(), 1n, Symbol('record'), []]) rejects(() => parseStatusEvidenceV1(bad));
});

test('unsafe, nonfinite, negative and out-of-Date-range numbers and coercions are rejected', () => {
  for (const n of [NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, -1, -0, 1.5, 8_640_000_000_000_001, '100', undefined, new Date(100)]) {
    rejects(() => parseStatusEvidenceV1({ ...status(), transaction: { ...status().transaction, signedDate: n } }));
  }
  for (const n of [0, 8_640_000_000_000_000]) {
    const result = parseStatusEvidenceV1({ ...status(), transaction: { ...status().transaction, signedDate: n } });
    assert.equal(result.kind, 'status');
  }
  rejects(() => parseStatusBindingV1({ ...binding(), epoch: -1 }));
  rejects(() => parseStatusEvidenceV1({ ...status(), renewal: { ...status().renewal, autoRenewStatus: true } }));
  rejects(() => parseStatusEvidenceV1({ ...status(), transaction: { ...status().transaction, isUpgraded: 1 } }));
});

test('IDs, digests, enums, secrets and malformed Unicode cannot escape the closed fields', () => {
  for (const id of ['', 'x'.repeat(129), 'contact@example.invalid', 'a b', '../escape', 'é', '\ud800']) {
    rejects(() => parseStatusEvidenceV1({ ...status(), requestId: id }));
  }
  for (const hash of ['a'.repeat(63), 'A'.repeat(64), 'g'.repeat(64), 'a.b.c', null]) {
    rejects(() => parseStatusEvidenceV1({ ...status(), transactionProofHash: hash }));
  }
  for (const key of ['rawJws', 'privateKey', 'certificate', 'providerToken', 'contact', 'sessionToken', 'actionGrant', 'error', 'verified']) {
    rejects(() => serializeStatusEvidenceV1({ ...status(), [key]: 'sensitive-value-must-not-appear' }));
  }
  rejects(() => parseStatusEvidenceV1({ ...status(), status: 'REFUND_REVERSED' }));
  rejects(() => parseStatusEvidenceV1({ ...records()[4], reason: 'sensitive-value-must-not-appear' }));
  rejects(() => parseStatusBindingV1({ ...binding(), owner: { ...binding().owner, appAccountToken: 'not-a-uuid' } }));
  rejects(() => parseStatusEvidenceV1({ ...status(), renewal: { ...status().renewal, productId: 'x'.repeat(257) } }));
});

test('JSON text rejects duplicates at every depth including escaped-equivalent keys, malformed tokens and trailing data', () => {
  const json = serializeStatusEvidenceV1(status());
  for (const bad of [
    json.replace('"kind":"status"', '"kind":"status","kind":"status"'),
    json.replace('"kind":"status"', '"kind":"status","k\\u0069nd":"status"'),
    json.replace('"signedDate":100', '"signedDate":100,"signedDate":100'),
    json.replace('"signedDate":100', '"signedDate":-0'),
    json.replace('"signedDate":100', '"signedDate":1e999'),
    json.replace('"signedDate":100', '"signedDate":01'),
    json.replace('"signedDate":100', '"signedDate":1e-999'),
    json.replace('"signedDate":100', '"signedDate":1.00000000000000000001'),
    json.replace('"signedDate":100', '"signedDate":1e0'),
    json + '{}', json.slice(0, -1), json.replace('"kind":"status"', '"kind":undefined'),
    '{"__proto__":{}}', '{"prototype":{}}', '{"constructor":{}}', '[1,]', '{"a":1,}', 'NaN', '\ufeff' + json,
    json.replace('"request-1"', '"bad\\ud800"'),
  ]) rejects(() => parseStatusEvidenceV1(bad));
  assert.equal(serializeStatusEvidenceV1(json.replace('"kind":"status"', '"k\\u0069nd":"status"')), json);
});

test('byte, string, depth, node, key and container bounds reject before schema processing', () => {
  rejects(() => parseStatusEvidenceV1(' '.repeat(STATUS_CODEC_LIMITS.bytes + 1)));
  rejects(() => parseStatusEvidenceV1({ ...status(), requestId: 'x'.repeat(60_001) }));
  rejects(() => parseStatusEvidenceV1({ ...status(), requestId: '😀'.repeat(15_001) }));
  rejects(() => parseStatusEvidenceV1({ oversized: Array.from({ length: 18 }, () => 'x'.repeat(60_000)) }));
  let nested: unknown = 0;
  for (let i = 0; i < 13; i++) nested = { nested };
  rejects(() => parseStatusEvidenceV1(nested));
  rejects(() => parseStatusEvidenceV1(Array.from({ length: 100 }, () => Array(100).fill(0))));
  rejects(() => parseStatusEvidenceV1(Object.fromEntries(Array.from({ length: 33 }, (_, n) => ['key' + n, 0]))));
  const outcome = records()[4]!;
  rejects(() => parseStatusEvidenceV1({ ...outcome, observationIds: Array.from({ length: 101 }, (_, n) => hex(n)) }));
  rejects(() => parseStatusEvidenceV1({ ...outcome, observationIds: [hex(1), hex(1)] }));
  const sparse = new Array(1);
  const accessor = [hex(1)]; Object.defineProperty(accessor, '0', { get() { throw new Error('must not run'); } });
  const extra = [hex(1)]; Object.defineProperty(extra, 'extra', { value: 1 });
  for (const observationIds of [sparse, accessor, extra]) rejects(() => parseStatusEvidenceV1({ ...outcome, observationIds }));
  const largest = { ...outcome, observationIds: Array.from({ length: 100 }, (_, n) => hex(n)) };
  assert.equal(parseStatusEvidenceV1(largest).kind, 'outcome');
});

test('parse/serialization never assert correlation, provenance, currentness or access', () => {
  const inconsistent = { ...status(), renewal: { ...status().renewal, productId: 'other.product' } };
  assert.equal(parseStatusEvidenceV1(inconsistent).kind, 'status');
  const inactive = { ...projection(), result: 'active', observationId: null, validUntilMs: null };
  assert.equal(parseStatusProjectionV1(inactive).result, 'active');
  // These assertions document the caller's mandatory correlation/guard boundary; parsed facts are data.
  assert.equal(Object.hasOwn(parseStatusEvidenceV1(status()), 'verified'), false);
});

test('different heads use purchase chronology even when transaction IDs suggest the reverse', () => {
  const a = status();
  const successor = { ...status(90, 90), transaction: { ...status(90, 90).transaction, transactionId: '1', purchaseDate: 20, expiresDate: 21 } };
  assert.equal(compareStatusEvidenceV1(a, successor).relation, 'newer');
  assert.equal(compareStatusEvidenceV1(successor, a).relation, 'older');
  const equalDate = { ...successor, transaction: { ...successor.transaction, purchaseDate: 10 } };
  assert.equal(compareStatusEvidenceV1(a, equalDate).relation, 'ambiguous');
  assert.equal(reduceStatusEvidenceV1([a, equalDate]).state, 'ambiguous');
  const reduction = reduceStatusEvidenceV1([a, successor]);
  assert.equal(reduction.head?.transaction.transactionId, '1');
  assert.equal(reduction.head?.transaction.expiresDate, 21);
});

test('same-head signed pairs form a partial order; request/time cannot break an incomparable pair', () => {
  const a = status();
  for (const [tx, renewal] of [[110, 100], [100, 110], [110, 110]]) {
    const b = status(tx, renewal);
    assert.equal(compareStatusEvidenceV1(a, b).relation, 'newer');
    assert.equal(compareStatusEvidenceV1(b, a).relation, 'older');
  }
  const mixed = { ...status(90, 110), recordedAtMs: 9000, requestId: 'request-later' };
  assert.equal(compareStatusEvidenceV1(a, mixed).relation, 'held');
  assert.equal(compareStatusEvidenceV1(mixed, a).relation, 'held');
  assert.equal(reduceStatusEvidenceV1([a, mixed, status(120, 120)]).state, 'held');
});

test('exact semantic/proof replay retains the first fact and original receipt', () => {
  const a = status();
  const replay = { ...a, requestId: 'request-2', recordedAtMs: 9000 };
  assert.equal(compareStatusEvidenceV1(a, replay).relation, 'replay');
  assert.notEqual(statusEvidenceIdV1(a), statusEvidenceIdV1(replay));
  const reduced = reduceStatusEvidenceV1([a, replay]);
  assert.equal(reduced.state, 'selected');
  assert.equal(reduced.head?.recordedAtMs, 150);
  assert.equal(reduced.head?.requestId, 'request-1');
});

test('equal signed versions with changed claims/status/proofs/response are retained conflicts', () => {
  const a = status();
  for (const b of [
    { ...a, status: 'expired' }, { ...a, transactionProofHash: hex(90) }, { ...a, renewalProofHash: hex(91) },
    { ...a, normalizedClaimDigest: hex(92) }, { ...a, providerResponseDigest: hex(93) },
    { ...a, transaction: { ...a.transaction, expiresDate: 1100 } },
    { ...a, renewal: { ...a.renewal, autoRenewStatus: 0 } },
  ]) {
    assert.equal(compareStatusEvidenceV1(a, b).relation, 'conflict');
    assert.equal(reduceStatusEvidenceV1([a, b, status(120, 120)]).state, 'conflict');
  }
  const changedTxAtSameVersion = { ...status(100, 110), transaction: { ...a.transaction, expiresDate: 1100 } };
  assert.equal(compareStatusEvidenceV1(a, changedTxAtSameVersion).relation, 'conflict');
});

test('immutable head mutations and cross-lineage/binding comparisons never choose a winner', () => {
  const a = status();
  for (const transaction of [{ ...a.transaction, purchaseDate: 20 }, { ...a.transaction, productId: 'other.product' }]) {
    assert.equal(compareStatusEvidenceV1(a, { ...a, transaction }).relation, 'conflict');
  }
  assert.equal(compareStatusEvidenceV1(a, { ...a, subscriptionGroupIdentifier: 'group-2' }).relation, 'conflict');
  for (const other of [{ ...a, originalTransactionId: '20000' }, { ...a, bindingId: hex(90) }]) {
    assert.equal(compareStatusEvidenceV1(a, other).relation, 'held');
    assert.equal(reduceStatusEvidenceV1([a, other]).state, 'held');
  }
  rejects(() => compareStatusEvidenceV1(a, records()[0]));
});

test('revocation and upgrade stay sticky for the same transaction, without a permanent lineage ban', () => {
  const a = status();
  for (const denial of [{ ...a, transaction: { ...a.transaction, revocationDate: 50 } },
    { ...a, transaction: { ...a.transaction, isUpgraded: true } }]) {
    assert.equal(compareStatusEvidenceV1(denial, status(110, 110)).relation, 'conflict');
    assert.equal(compareStatusEvidenceV1(status(110, 110), denial).relation, 'conflict');
    const reduced = reduceStatusEvidenceV1([denial, status(110, 110)]);
    assert.equal(reduced.head, null);
    assert.ok(reduced.stickyRevoked || reduced.stickyUpgraded);
    const successor = { ...status(110, 110), transaction: { ...status(110, 110).transaction, transactionId: '2', purchaseDate: 20 } };
    assert.equal(compareStatusEvidenceV1(denial, successor).relation, 'newer');
    const next = reduceStatusEvidenceV1([denial, successor]);
    assert.equal(next.head?.transaction.transactionId, '2');
    assert.equal(next.stickyRevoked, false); assert.equal(next.stickyUpgraded, false);
  }
});

test('bounded reduction is order-independent for signed successors and keeps no head on conflicts', () => {
  const a = status(), b = status(110, 110), c = status(120, 120);
  for (const values of [[a, b, c], [c, a, b], [b, c, a]]) {
    assert.equal(reduceStatusEvidenceV1(values).head?.transaction.signedDate, 120);
  }
  assert.equal(reduceStatusEvidenceV1([]).state, 'empty');
  rejects(() => reduceStatusEvidenceV1(Array(101).fill(a)));
  const otherOldHead = { ...a, transaction: { ...a.transaction, transactionId: 'old-ambiguous' } };
  const newHead = { ...c, transaction: { ...c.transaction, transactionId: 'new-head', purchaseDate: 20 } };
  assert.equal(reduceStatusEvidenceV1([a, otherOldHead, newHead]).head?.transaction.transactionId, 'new-head');
});
