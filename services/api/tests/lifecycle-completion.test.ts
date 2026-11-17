import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appendCompletionFact, calculateCompletion, createCompletionHistory,
  type CompletionBinding, type CompletionContext, type CompletionFact, type CompletionHistory,
  type CompletionTarget, type CompletionWitness, type EvidenceStatus,
} from '../src/lifecycle/completion.js';
import type { DisableRecord } from '../src/lifecycle/types.js';

const hash = (letter: string): string => letter.repeat(64);
const category: CompletionTarget = { kind: 'category', category: 'phone' };
const otherCategory: CompletionTarget = { kind: 'category', category: 'activity' };
const provider: CompletionTarget = { kind: 'provider', provider: 'apple', clientDigest: hash('a'), subjectDigest: hash('b'), referenceVersion: 'v1' };
const backup: CompletionTarget = { kind: 'backup', inventoryDigest: hash('c'), policyVersion: 'synthetic-policy-v1' };
function fixture() {
  const record: DisableRecord = { requestId: 'request-a', accountId: 'account-a', authUserId: 'auth-a', epoch: 1, sequence: 4, disabledAtMs: 100 };
  const binding: CompletionBinding = { requestId: record.requestId, accountId: record.accountId, authUserId: record.authUserId,
    epoch: record.epoch, sequence: record.sequence, databaseGeneration: 'generation-a', schemaDigest: hash('d'), cohort: 'runtime16',
    checkpoint: { authorityId: 'authority-a', ledgerSchemaDigest: hash('e'), revision: 8, committedSequence: 4, committedHeadDigest: hash('f') } };
  const context: CompletionContext = { binding, request: 'present', authority: { status: 'qualified_current', suppression: record }, requirements: [category, provider, backup] };
  return { binding, record, context, history: createCompletionHistory(record) };
}
function fact(binding: CompletionBinding, target: CompletionTarget, operationId: string,
  status: Exclude<EvidenceStatus, 'missing'> = 'qualifying', resolves: readonly string[] = []): CompletionFact {
  const common = { binding, target, operationId, resolves };
  if (status !== 'qualifying') return { ...common, status, witness: null };
  const witness: CompletionWitness = target.kind === 'backup'
    ? { kind: 'backup_disposition', disposition: 'destruction_witnessed', evidenceDigest: hash('1'), observedAtMs: 200, inventoryWitnessDigest: hash('2') }
    : { kind: target.kind === 'category' ? 'local_purge_readback' : 'provider_revocation_acknowledgment', evidenceDigest: hash('1'), observedAtMs: 200 };
  return { ...common, status, witness };
}
function append(history: CompletionHistory, ...facts: CompletionFact[]): CompletionHistory {
  return facts.reduce((current, next) => appendCompletionFact(current, next).history, history);
}
function witnessed() {
  const f = fixture();
  return { ...f, history: append(f.history, fact(f.binding, category, 'purge-a'), fact(f.binding, provider, 'revoke-a'), fact(f.binding, backup, 'backup-a')) };
}

test('qualifies only declared targets; retains anchors and makes no whole-account/device/provider erasure claim', () => {
  const f = witnessed();
  const result = calculateCompletion(f.history, f.context);
  assert.equal(result.eligibility, 'qualifying');
  assert.equal(result.hold, null);
  assert.deepEqual(result.targets.map(target => target.status), ['qualifying', 'qualifying', 'qualifying']);
  assert.equal(result.wholeAccountDeviceProviderErasure, 'unproven');
  assert.equal(result.identityAnchors, 'retained');
  assert.equal(result.scope, 'declared_targets_only');
  assert.equal(calculateCompletion(f.history, { ...f.context, requirements: [] }).eligibility, 'missing');
});

test('missing, unknown, pending, unavailable, retained and false observations are distinct and cannot prove completion', () => {
  const f = fixture();
  const context = { ...f.context, requirements: [category] };
  assert.equal(calculateCompletion(f.history, context).eligibility, 'missing');
  for (const status of ['unknown', 'pending', 'unavailable', 'retained', 'not_qualifying', 'conflicting'] as const) {
    const history = append(f.history, fact(f.binding, category, `attempt-${status}`, status));
    assert.equal(calculateCompletion(history, context).eligibility, status);
  }
});

test('category coverage is independent and cannot fill provider or backup gaps', () => {
  const f = fixture();
  const history = append(f.history, fact(f.binding, category, 'purge-a'));
  const result = calculateCompletion(history, { ...f.context, requirements: [category, otherCategory, provider, backup] });
  assert.deepEqual(result.targets.map(target => target.status), ['qualifying', 'missing', 'missing', 'missing']);
  assert.equal(result.eligibility, 'missing');
  for (const status of ['unknown', 'pending', 'unavailable'] as const) {
    const external = append(history, fact(f.binding, provider, 'revoke-a', status), fact(f.binding, backup, 'backup-a', status));
    assert.equal(calculateCompletion(external, f.context).eligibility, status);
  }
});

test('generation, schema, cohort, authority, ledger schema, revision, floor and head rollovers invalidate current eligibility only', () => {
  const f = witnessed();
  const changes: CompletionBinding[] = [
    { ...f.binding, databaseGeneration: 'restored-generation' },
    { ...f.binding, schemaDigest: hash('3') },
    { ...f.binding, cohort: 'source23' },
    ...[
      { authorityId: 'authority-b' }, { ledgerSchemaDigest: hash('3') }, { revision: 9 },
      { committedSequence: 5 }, { committedHeadDigest: hash('3') },
    ].map(change => ({ ...f.binding, checkpoint: { ...f.binding.checkpoint, ...change } })),
  ];
  for (const binding of changes) {
    const result = calculateCompletion(f.history, { ...f.context, binding });
    assert.equal(result.eligibility, 'missing');
    assert.equal(result.staleFactCount, 3);
    assert.equal(result.historicalFactCount, 3);
    assert.equal(calculateCompletion(f.history, f.context).eligibility, 'qualifying');
  }
  const restored = changes[0]!;
  const renewed = append(f.history, fact(restored, category, 'purge-restored'), fact(restored, provider, 'revoke-restored'), fact(restored, backup, 'backup-restored'));
  assert.equal(calculateCompletion(renewed, { ...f.context, binding: restored }).eligibility, 'qualifying');
  assert.equal(calculateCompletion(renewed, { ...f.context, binding: restored }).staleFactCount, 3);
  assert.equal(f.history.facts.length, 3);
});

test('stable retries do not append facts; incompatible operation reuse preserves both versions and holds every retry', () => {
  const f = witnessed();
  const original = f.history.facts[0]!;
  const duplicate = appendCompletionFact(f.history, original);
  assert.equal(duplicate.effect, 'duplicate');
  assert.strictEqual(duplicate.history, f.history);
  const conflict = appendCompletionFact(f.history, { ...original, target: otherCategory });
  assert.equal(conflict.effect, 'conflict');
  assert.equal(conflict.history.facts.length, 4);
  assert.deepEqual(conflict.history.facts[0], original);
  const retry = appendCompletionFact(conflict.history, original);
  assert.equal(retry.effect, 'conflict');
  assert.strictEqual(retry.history, conflict.history);
  assert.equal(calculateCompletion(retry.history, f.context).hold, 'evidence_conflict');
  const restored = { ...f.binding, databaseGeneration: 'new-generation' };
  assert.equal(appendCompletionFact(f.history, { ...original, binding: restored }).effect, 'conflict');
});

test('foreign request, account, auth-user, epoch and suppression sequence are rejected without altering history', () => {
  const f = witnessed();
  for (const change of [{ requestId: 'request-b' }, { accountId: 'account-b' }, { authUserId: 'auth-b' }, { epoch: 2 }, { sequence: 3 }]) {
    const binding = { ...f.binding, ...change };
    assert.throws(() => appendCompletionFact(f.history, fact(binding, category, 'foreign')), /completion_identity_mismatch/);
    assert.equal(calculateCompletion(f.history, { ...f.context, binding }).hold, 'identity_conflict');
    assert.equal(calculateCompletion(f.history, { ...f.context, authority: { status: 'qualified_current', suppression: { ...f.record, ...change } } }).hold, 'identity_conflict');
  }
  assert.equal(f.history.facts.length, 3);
});

test('suppression alone never reconstructs a missing restored request or completed intent', () => {
  const f = witnessed();
  for (const history of [f.history, createCompletionHistory(f.record)]) {
    const result = calculateCompletion(history, { ...f.context, request: 'missing' });
    assert.equal(result.eligibility, 'missing');
    assert.equal(result.hold, 'request_missing_restore_held');
    assert.equal(result.historicalFactCount, history.facts.length);
  }
  assert.equal(calculateCompletion(f.history, { ...f.context, request: 'unknown' }).eligibility, 'unknown');
});

test('missing current authority or a conflicting suppression mapping holds witnessed evidence', () => {
  const f = witnessed();
  for (const status of ['unknown', 'unavailable', 'pending', 'conflicting'] as const) {
    const result = calculateCompletion(f.history, { ...f.context, authority: { status } });
    assert.equal(result.eligibility, status);
    assert.equal(result.hold, 'authority_unqualified');
  }
  assert.throws(() => calculateCompletion(f.history, { ...f.context,
    binding: { ...f.binding, checkpoint: { ...f.binding.checkpoint, committedSequence: 3 } } }), /completion_input_invalid/);
  assert.equal(calculateCompletion(f.history, { ...f.context,
    authority: { status: 'qualified_current', suppression: { ...f.record, disabledAtMs: 201 } } }).hold, 'evidence_conflict');
});

test('unknown attempt requires explicit same-target resolution; a later acknowledgment cannot silently discard it', () => {
  const f = fixture();
  const context = { ...f.context, requirements: [provider] };
  const uncertain = append(f.history, fact(f.binding, provider, 'attempt-a', 'unknown'));
  const unboundAck = append(uncertain, fact(f.binding, provider, 'ack-a'));
  assert.equal(calculateCompletion(unboundAck, context).eligibility, 'unknown');
  const resolved = append(uncertain, fact(f.binding, provider, 'ack-a', 'qualifying', ['attempt-a']));
  assert.equal(calculateCompletion(resolved, context).eligibility, 'qualifying');
  assert.equal(resolved.facts.length, 2);
  assert.equal(resolved.facts[0]!.status, 'unknown');
  for (const target of [category, { ...provider, referenceVersion: 'v2' }]) {
    const wrongTarget = append(uncertain, fact(f.binding, target, 'ack-a', 'qualifying', ['attempt-a']));
    assert.equal(calculateCompletion(wrongTarget, { ...context, requirements: [target] }).eligibility, 'conflicting');
  }
  const beforeAttempt = append(f.history, fact(f.binding, provider, 'ack-a', 'qualifying', ['future-attempt']),
    fact(f.binding, provider, 'future-attempt', 'unknown'));
  assert.equal(calculateCompletion(beforeAttempt, context).eligibility, 'conflicting');
});

test('different positive witnesses, false evidence and retained residuals hold instead of overwriting success', () => {
  const f = fixture();
  const context = { ...f.context, requirements: [category] };
  const positive = fact(f.binding, category, 'readback-a');
  assert.equal(positive.status, 'qualifying');
  if (positive.status !== 'qualifying') throw new Error('fixture');
  const contradicted = append(f.history, positive, { ...positive, operationId: 'readback-b', witness: { ...positive.witness, evidenceDigest: hash('4') } });
  assert.equal(calculateCompletion(contradicted, context).eligibility, 'conflicting');
  for (const status of ['not_qualifying', 'retained', 'conflicting'] as const) {
    const blocked = append(f.history, fact(f.binding, category, 'blocked', status), positive);
    assert.equal(calculateCompletion(blocked, context).eligibility, status);
    const invalidResolution = append(blocked, fact(f.binding, category, 'readback-c', 'qualifying', ['blocked']));
    assert.equal(calculateCompletion(invalidResolution, context).eligibility, 'conflicting');
  }
});

test('backup inventory/policy and provider subject/client/version are independent exact targets', () => {
  const f = witnessed();
  const changedTargets: CompletionTarget[] = [
    { ...backup, inventoryDigest: hash('5') }, { ...backup, policyVersion: 'new-policy' },
    { ...provider, subjectDigest: hash('5') }, { ...provider, clientDigest: hash('5') }, { ...provider, referenceVersion: 'v2' },
  ];
  for (const target of changedTargets) {
    assert.equal(calculateCompletion(f.history, { ...f.context, requirements: [target] }).eligibility, 'missing');
  }
});

test('a deadline, false proof, provider acknowledgment or absent inventory witness cannot stand in for backup disposition', () => {
  const f = fixture();
  const syntheticInputs: unknown[] = [
    { ...fact(f.binding, backup, 'deadline'), status: 'qualifying', witness: { kind: 'retention_deadline', retainUntilMs: 1 } },
    { ...fact(f.binding, backup, 'false'), status: 'qualifying', witness: false },
    { ...fact(f.binding, backup, 'ack'), status: 'qualifying', witness: { kind: 'provider_revocation_acknowledgment', evidenceDigest: hash('1'), observedAtMs: 200 } },
    { ...fact(f.binding, backup, 'no-inventory'), status: 'qualifying', witness: { kind: 'backup_disposition', disposition: 'destruction_witnessed', evidenceDigest: hash('1'), observedAtMs: 200 } },
    { ...fact(f.binding, backup, 'retention'), status: 'qualifying', witness: { kind: 'backup_disposition', disposition: 'retention_elapsed', evidenceDigest: hash('1'), observedAtMs: 200, inventoryWitnessDigest: hash('2') } },
  ];
  for (const input of syntheticInputs) assert.throws(() => appendCompletionFact(f.history, input as CompletionFact), /completion_input_invalid/);
  assert.equal(f.history.facts.length, 0);
});

test('history owns immutable copies, drops undeclared payloads and normalizes resolution order for retries', () => {
  const f = fixture();
  const withPayload = { ...fact(f.binding, category, 'copy'), forbiddenPayload: 'synthetic-do-not-retain' };
  const history = append(f.history, withPayload);
  assert.equal(JSON.stringify(history).includes('synthetic-do-not-retain'), false);
  assert.ok(Object.isFrozen(history) && Object.isFrozen(history.facts) && Object.isFrozen(history.facts[0]!.binding.checkpoint));
  Object.assign(f.binding.checkpoint, { committedSequence: 99 });
  assert.equal(history.facts[0]!.binding.checkpoint.committedSequence, 4);
  assert.throws(() => Object.assign(history.facts[0]!.binding.checkpoint, { committedSequence: 99 }));
  const fresh = fixture();
  const uncertain = append(fresh.history, fact(fresh.binding, category, 'attempt-b', 'pending'), fact(fresh.binding, category, 'attempt-a', 'unknown'));
  const resolved = append(uncertain, fact(fresh.binding, category, 'resolved', 'qualifying', ['attempt-b', 'attempt-a']));
  const retry = appendCompletionFact(resolved, fact(fresh.binding, category, 'resolved', 'qualifying', ['attempt-a', 'attempt-b']));
  assert.equal(retry.effect, 'duplicate');
  assert.strictEqual(retry.history, resolved);
});
