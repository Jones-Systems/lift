import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeDurableEvidence, decodeDurableEvidence, evidenceDigest, compareEvidenceReplay } from '../src/lifecycle/evidence-codec.js';

const value = () => ({ version: 1, evidenceId: 'fact-one', attemptId: 'attempt-one', observedAtMs: 100,
  policyVersion: 'form-account-lifecycle-v1', fact: { operationId: 'fact-one', status: 'qualifying', resolves: [],
    binding: { requestId: 'request-one', accountId: 'account-one', authUserId: 'auth-one', epoch: 1, sequence: 1,
      databaseGeneration: 'independent-generation-one', schemaDigest: 'a'.repeat(64), cohort: 'lifecycle-evidence-v1',
      checkpoint: { authorityId: 'authority-one', ledgerSchemaDigest: 'b'.repeat(64), revision: 2, committedSequence: 1, committedHeadDigest: 'c'.repeat(64) } },
    target: { kind: 'category', category: 'form_training_history' },
    witness: { kind: 'local_purge_readback', evidenceDigest: 'd'.repeat(64), observedAtMs: 100 } } });

test('durable codec canonicalizes metadata, preserves first observation and distinguishes conflicting replay', () => {
  const input = value(), bytes = encodeDurableEvidence(input);
  assert.deepEqual(decodeDurableEvidence(bytes), input);
  assert.equal(encodeDurableEvidence({ ...input, fact: { ...input.fact } }), bytes);
  assert.equal(compareEvidenceReplay(bytes, encodeDurableEvidence(input)), 'identical');
  const changed = value(); changed.observedAtMs++; changed.fact.witness.observedAtMs++;
  assert.equal(compareEvidenceReplay(bytes, encodeDurableEvidence(changed)), 'conflict');
  input.fact.binding.accountId = 'changed-after-encoding';
  assert.equal(decodeDurableEvidence(bytes).fact.binding.accountId, 'account-one');
  assert.notEqual(evidenceDigest(decodeDurableEvidence(bytes)), evidenceDigest(changed));
});

test('strict codec rejects secret-bearing unknown fields, duplicate keys, noncanonical and oversized rows with bounded errors', () => {
  const sensitive = 'synthetic-secret-that-must-never-be-reflected';
  for (const input of [{ ...value(), accessToken: sensitive },
    { ...value(), fact: { ...value().fact, witness: { ...value().fact.witness, rawJws: sensitive } } },
    { ...value(), fact: { ...value().fact, binding: { ...value().fact.binding, statusSecret: sensitive } } },
    { ...value(), attemptId: 'x'.repeat(257) }, { ...value(), observedAtMs: -1 },
    { ...value(), fact: { ...value().fact, resolves: Array.from({ length: 33 }, (_, i) => `old-${i}`) } }]) {
    assert.throws(() => encodeDurableEvidence(input), error => error instanceof Error && error.message === 'lifecycle_evidence_codec_invalid' && !error.message.includes(sensitive));
  }
  const bytes = encodeDurableEvidence(value());
  for (const encoded of [bytes + ' ', bytes.replace('"version":1', '"version":1,"version":1'), 'x'.repeat(16385),
    bytes.replace('"epoch":1', '"epoch":9007199254740992')]) assert.throws(() => decodeDurableEvidence(encoded), /lifecycle_evidence_codec_invalid/);
});

test('discriminated facts require matching scoped witnesses and never accept deadlines as backup disposition', () => {
  const baseline = value();
  for (const change of [{ status: 'retained' }, { witness: null }, { operationId: 'another-fact' },
    { target: { kind: 'provider', provider: 'apple', clientDigest: 'a'.repeat(64), subjectDigest: 'b'.repeat(64), referenceVersion: 'v1' } },
    { target: { kind: 'backup', inventoryDigest: 'a'.repeat(64), policyVersion: 'synthetic-policy' } },
    { witness: { ...baseline.fact.witness, observedAtMs: 99 } }])
    assert.throws(() => encodeDurableEvidence({ ...baseline, fact: { ...baseline.fact, ...change } }), /lifecycle_evidence_codec_invalid/);
  const retained = { ...baseline, fact: { ...baseline.fact, status: 'retained', witness: null } };
  assert.equal(decodeDurableEvidence(encodeDurableEvidence(retained)).fact.status, 'retained');
  const backup = { ...baseline, fact: { ...baseline.fact, target: { kind: 'backup', inventoryDigest: 'a'.repeat(64), policyVersion: 'synthetic-policy' },
    witness: { kind: 'backup_disposition', disposition: 'expiry_witnessed', evidenceDigest: 'd'.repeat(64), inventoryWitnessDigest: 'e'.repeat(64), observedAtMs: 100 } } };
  assert.equal(decodeDurableEvidence(encodeDurableEvidence(backup)).fact.target.kind, 'backup');
  assert.throws(() => encodeDurableEvidence({ ...backup, retainUntilMs: 100 }), /lifecycle_evidence_codec_invalid/);
});
