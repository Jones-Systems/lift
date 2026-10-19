import { createHash } from 'node:crypto';
import type { SourceObservation } from '../../src/grounding/index.js';

export const digest = (text: string | Buffer): string => createHash('sha256').update(text).digest('hex');
export const packetPath = 'sources/synthetic-observations.md';
export const packetDigest = digest('Synthetic packet bytes for grounding tests only.');
export function syntheticRecord(id = 'SYN-S2', overrides: Partial<SourceObservation> = {}): SourceObservation {
  return {
    id, kind: 'source_observation', topic_ids: ['SYN-A1'],
    title: 'Synthetic strength observation', url: 'https://example.invalid/synthetic',
    doi: null, pmid: null, published: 'Synthetic publication year unknown', accessed: '2026-10-01',
    access_level: 'abstract', locator: 'Synthetic abstract, limitations paragraph',
    summary: 'Synthetic running café 42 strength signal only.',
    source_native_certainty: 'Synthetic authors report uncertain association, no causal finding.',
    form_appraisal: 'Synthetic incomplete appraisal; full text unavailable.',
    applicability: 'Synthetic adults only; transfer to other populations unknown.',
    rights_status: 'Synthetic metadata; no original quotation rights inferred.',
    freshness_status: 'Synthetic dated search; updates unreviewed.', clinical_readiness: 'CL-0',
    provenance: 'Synthetic fixture, never clinical or retained-source evidence.', conflicts: [], ...overrides,
  };
}
export function syntheticFixture(records: readonly SourceObservation[] = [syntheticRecord()]) {
  const inputs = [
    { source_path: 'coverage.md', sha256: digest('Synthetic coverage bytes.') },
    { source_path: packetPath, sha256: packetDigest },
    { source_path: 'sources/synthetic-prose.md', sha256: digest('Synthetic prose, no records.') },
  ];
  const units = Array.from({ length: 106 }, (_, i) => ({ unit_id: `SYN-A${i + 1}`, title: `Synthetic coverage unit ${i + 1}`, state: 'partial' }));
  const represented = new Set(records.flatMap(record => record.topic_ids));
  const projection = {
    schema: 'form.source-observation-projection/v1', projector_version: '1',
    corpus_input_sha256: inputDigest(inputs), inputs,
    coverage: { schema: 'form.research-coverage/v1', authority_effect: 'none', source_plan: 'plans/synthetic.md', source_plan_revision: 'a'.repeat(40), units },
    corpus_status: {
      state: 'partial', scope: 'fenced source_observation records only', clinical_readiness: 'CL-0',
      limitation: 'Research observations only; no claim promotion, clinical validation, answer generation, catalog or cue ingestion.',
      units_without_observations: units.map(unit => unit.unit_id).filter(id => !represented.has(id)),
      source_packets_without_records: records.length ? ['sources/synthetic-prose.md'] : [packetPath, 'sources/synthetic-prose.md'],
    },
    records: records.map((record, index) => ({ record: structuredClone(record), source_path: packetPath, line: 5 + index * 30, source_packet_sha256: packetDigest })),
  };
  const binding = { repository: 'synthetic/grounding-tests', revision: 'b'.repeat(40), corpusRoot: 'synthetic/corpus', corpusInputSha256: projection.corpus_input_sha256 };
  return { projection, binding };
}
export function inputDigest(inputs: readonly { source_path: string; sha256: string }[]): string {
  return digest(`${JSON.stringify(inputs.map(input => ({ sha256: input.sha256, source_path: input.source_path })))}\n`);
}
