import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createGroundingRetriever, type SourceObservation, type ResearchCoverage } from '../../src/grounding/index.js';
import { digest, inputDigest, syntheticFixture } from './fixture.js';

// One exact retained record is exercised in a selected-record fixture, not a full corpus export.
test('selected retained ACH-S01 record keeps exact packet identity and native qualifications', () => {
  const root = new URL('../../../../../sources/businesslessons/core/research/form-knowledge-campaign-2026-10-01/', import.meta.url);
  const packet = readFileSync(new URL('sources/achilles-appraisal.md', root));
  const coverageBytes = readFileSync(new URL('coverage.md', root));
  assert.equal(digest(packet), 'cea5e777dc83a56913ed09d63d4b54b57496e954f87dceae360b2c960a1aa4c2');
  assert.equal(digest(coverageBytes), 'f948114d1d6c9079694afa44698648899e38c37fd091663a8d8f96c99968e756');
  const record = JSON.parse(packet.toString('utf8').split('```json\n')[1]!.split('\n```')[0]!) as SourceObservation;
  const coverage = JSON.parse(coverageBytes.toString('utf8').split('```json\n')[1]!.split('\n```')[0]!) as ResearchCoverage;
  assert.equal(record.id, 'ACH-S01');
  assert.equal(record.access_level, 'partial');
  assert.equal(record.published, '2024-11-27 online; 2024-12 issue');
  assert.equal(record.source_native_certainty, 'A strong; B moderate; E theoretical/foundational. These are recommendation grades, not GRADE certainty.');
  const fixture = syntheticFixture();
  const inputs = [{ source_path: 'coverage.md', sha256: digest(coverageBytes) }, { source_path: 'sources/achilles-appraisal.md', sha256: digest(packet) }];
  const projection = {
    ...fixture.projection, inputs, corpus_input_sha256: inputDigest(inputs), coverage,
    records: [{ record, source_path: 'sources/achilles-appraisal.md', line: 5, source_packet_sha256: digest(packet) }],
    corpus_status: { ...fixture.projection.corpus_status,
      units_without_observations: coverage.units.map(unit => unit.unit_id).filter(id => !record.topic_ids.includes(id)), source_packets_without_records: [] },
  };
  const binding = { repository: 'Jones-Systems/BusinessLessons', revision: '7636efca55195b1dc6a5980864452575478116b7', corpusRoot: 'research/form-knowledge-campaign-2026-10-01', corpusInputSha256: projection.corpus_input_sha256 };
  const result = createGroundingRetriever(projection, binding).retrieve({ query: 'Achilles strong', access: 'partial', topic: 'INJ-K5' });
  assert.equal(result.status, 'observations');
  assert.deepEqual(result.observations, projection.records);
  assert.deepEqual(result.coverage, coverage);
  assert.deepEqual(result.source, binding);
  assert.equal(result.verbatimPassagesAvailable, false);
});
