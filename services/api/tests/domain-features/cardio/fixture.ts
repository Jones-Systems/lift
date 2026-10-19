import type { ConsumerContext } from '../../../src/domain-features/cardio/index.js';

export const context: ConsumerContext = {
  contextRevision: 'manual-context-v1', sourceRevision: 'a'.repeat(40), corpusInputSha256: 'b'.repeat(64),
  regionalPreflight: 'unresolved', trainingRoute: 'urgent', regionalRoute: 'emergency',
  escalation_route: 'owner-route-preserved', confirmation_state: 'unconfirmed',
};

// Synthetic research records test preservation only; none contains scientific advice.
export function observation(query = 'concurrent') {
  return {
    schema: 'form.observation-grounding/v1' as const, source: { repository: 'synthetic', revision: context.sourceRevision,
      corpusRoot: 'synthetic/packets', corpusInputSha256: context.corpusInputSha256 },
    clinicalReadiness: 'CL-0' as const, corpusStatus: { scientific_coverage: 'partial', omissions: ['original passages'] },
    coverage: [{ topic_id: 'fixture', state: 'partial', searched: ['synthetic'], not_searched: ['originals'] }],
    query, filters: { topic: null, access: null }, limit: 20, totalMatches: 1, truncated: false,
    verbatimPassagesAvailable: false as const, status: 'observations' as const, observations: [{
      record: { id: 'SYN-1', kind: 'source_observation' as const, clinical_readiness: 'CL-0' as const,
        title: 'Synthetic observation', summary: 'Synthetic retained summary', locator: 'source-native locator',
        conflicts: ['SYN-outside-page'], applicability: { population: 'unavailable' },
        source_native_certainty: null, freshness_status: 'unreviewed', rights_status: 'unknown' },
      source_path: 'synthetic/packets/fixture.md', line: 12, source_packet_sha256: 'c'.repeat(64),
    }],
  };
}
