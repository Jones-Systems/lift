import { createGroundingRetriever } from '../../../src/grounding/index.js';
import { syntheticFixture, syntheticRecord } from '../../grounding/fixture.js';
import type { CardioJob, InformativeRequest } from '../../../src/domain-features/cardio/index.js';

export function informativeFixture() {
  const records = Array.from({ length: 22 }, (_, index) => syntheticRecord(`SYN-S${100 + index}`, {
    topic_ids: ['CAR-H4'],
    summary: `Synthetic concurrent observation ${index}; applicability uncertain.`,
    conflicts: index === 0 ? ['SYN-S121'] : [],
  }));
  records.push(
    ...(['sleep', 'hydration', 'soreness', 'recovery', 'stress', 'injury', 'return'] as const).map((term, index) => syntheticRecord(`SYN-S${200 + index}`, {
      topic_ids: [['REC-J1'], ['REC-J2'], ['REC-J3'], ['REC-J4'], ['REC-J5'], ['INJ-K7'], ['INJ-K4']][index]!,
      summary: `Synthetic ${term} observation; concurrent activity is mentioned, without establishing a concurrent-training outcome.`,
    })),
  );
  const fixture = syntheticFixture(records);
  const topics = [...Array.from({ length: 5 }, (_, i) => `CAR-H${i + 1}`), ...Array.from({ length: 5 }, (_, i) => `REC-J${i + 1}`), ...Array.from({ length: 8 }, (_, i) => `INJ-K${i + 1}`)];
  fixture.projection.coverage.units = [...topics, ...Array.from({ length: 106 - topics.length }, (_, i) => `SYN-A${i + 1}`)]
    .map(unit_id => ({ unit_id, title: `Synthetic coverage for ${unit_id}`, state: 'partial' }));
  const represented = new Set(records.flatMap(record => record.topic_ids));
  fixture.projection.corpus_status.units_without_observations = fixture.projection.coverage.units.map(unit => unit.unit_id).filter(id => !represented.has(id));
  const retriever = createGroundingRetriever(fixture.projection, fixture.binding);
  const input: InformativeRequest<CardioJob> = {
    jobRevision: 'job-1',
    job: { kind: 'concurrent_training', intent: 'explain', modality: 'cycling', order: 'strength_first', spacing: 'separate_days', outcome: 'power' },
    userContext: { revision: 'user-1', supersedesRevision: null, facts: [{ id: 'goal', text: 'I want to understand the literature.', origin: 'user_provided' }] },
    routing: { contextRevision: 'route-1', sourceRevision: fixture.binding.revision, corpusInputSha256: fixture.binding.corpusInputSha256,
      regionalPreflight: 'unresolved', trainingRoute: 'urgent', regionalRoute: 'emergency', escalation_route: 'accepted-route', confirmation_state: 'unconfirmed' },
  };
  return { ...fixture, retriever, input };
}
