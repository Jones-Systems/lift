import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRetainedGroundingRetriever } from '../../src/grounding/artifact.js';
import { GroundingInputError, type ObservationEntry } from '../../src/grounding/index.js';

const artifact = new URL('../../grounding/84530977a646d138ff1194d22d8723989ff6646dc3f69a8ab5c390783de55ad8/projection.json', import.meta.url);
const bytes = (): Buffer => readFileSync(artifact);

test('pinned artifact yields retained qualifiers and a fixed canonical source binding', () => {
  const input = bytes();
  assert.equal(input.byteLength, 1488603);
  assert.equal(createHash('sha256').update(input).digest('hex'), '84530977a646d138ff1194d22d8723989ff6646dc3f69a8ab5c390783de55ad8');
  const result = createRetainedGroundingRetriever(input).retrieve({ query: 'Achilles strong', topic: 'INJ-K5', access: 'partial' });
  const parsed = JSON.parse(input.toString('utf8')) as { records: ObservationEntry[]; coverage: unknown; corpus_status: unknown };
  const retained = parsed.records.find(entry => entry.record.id === 'ACH-S01');
  assert.ok(retained);
  assert.deepEqual(result.observations.find(entry => entry.record.id === 'ACH-S01'), retained);
  assert.equal(retained.line, 5);
  assert.equal(retained.source_path, 'sources/achilles-appraisal.md');
  assert.equal(retained.source_packet_sha256, 'cea5e777dc83a56913ed09d63d4b54b57496e954f87dceae360b2c960a1aa4c2');
  assert.equal(retained.record.source_native_certainty, 'A strong; B moderate; E theoretical/foundational. These are recommendation grades, not GRADE certainty.');
  assert.deepEqual(result.source, {
    repository: 'Jones-Systems/BusinessLessons', revision: '7636efca55195b1dc6a5980864452575478116b7',
    corpusRoot: 'research/form-knowledge-campaign-2026-10-01', corpusInputSha256: '78ffb7674b95dfb946f9f30d318ba6dfa07332cad364298f6c7daf4c8055b824',
  });
  assert.deepEqual(result.coverage, parsed.coverage);
  assert.deepEqual(result.corpusStatus, parsed.corpus_status);
  assert.equal(result.verbatimPassagesAvailable, false);
  assert.equal(result.clinicalReadiness, 'CL-0');
});

test('byte adapter fails closed for absent, malformed, truncated, altered, and reserialized exports', () => {
  const valid = bytes();
  const changed = Buffer.from(valid);
  changed[100] = changed[100]! ^ 1;
  const invalid: unknown[] = [undefined, null, {}, valid.toString('utf8'), new Uint8Array(), Buffer.from([0xff, 0xfe]), valid.subarray(0, -1), Buffer.concat([valid, Buffer.from('\n')]), changed, Buffer.from(JSON.stringify(JSON.parse(valid.toString('utf8'))))];
  for (const input of invalid) {
    assert.throws(() => createRetainedGroundingRetriever(input as Uint8Array), error => error instanceof GroundingInputError && error.code === 'invalid_projection');
  }
});

test('accepted retriever owns input bytes and retains immutable conflicts and gaps', () => {
  const input = bytes();
  const parsed = JSON.parse(input.toString('utf8')) as { records: ObservationEntry[] };
  const conflicting = parsed.records.find(entry => entry.record.conflicts.length > 0);
  assert.ok(conflicting, 'the pinned real corpus must exercise conflict retention');
  const retriever = createRetainedGroundingRetriever(input);
  input.fill(0);
  const result = retriever.retrieve({ query: conflicting.record.id, limit: 100 });
  const entry = result.observations.find(entry => entry.record.id === conflicting.record.id);
  assert.deepEqual(entry, conflicting);
  assert.ok(Object.isFrozen(entry?.record.conflicts));
  assert.throws(() => (entry!.record.conflicts as string[]).push('BAD-S1'), TypeError);
  const gap = retriever.retrieve({ query: 'syntheticuniquetokenneverincorpus987654321' });
  assert.equal(gap.status, 'gap');
  if (gap.status === 'gap') assert.equal(gap.reason, 'no_matching_observations');
  assert.equal(gap.clinicalReadiness, 'CL-0');
  assert.equal(gap.verbatimPassagesAvailable, false);
});
