import type { GroundingResult, GroundingRetriever, ObservationEntry } from '../../grounding/index.js';
import type { NutritionGroundingPort } from './index.js';
import { captureNutritionQueryPolicy, nutritionQueryMatchesEvidence, resolveNutritionQuery,
  type NutritionQueryPolicySelection } from './job-query-policy.js';

export function createNutritionGroundingPort(
  retriever: GroundingRetriever,
  selection?: NutritionQueryPolicySelection,
): NutritionGroundingPort<ObservationEntry, GroundingResult> {
  const policy = captureNutritionQueryPolicy(selection);
  return {
    async retrieve(request) {
      const { query, topic } = resolveNutritionQuery(policy, request.job, request.question);
      const context = retriever.retrieve({ query, topic });
      if (policy.mode === 'form.nutrition-job-query/v1'
        && !nutritionQueryMatchesEvidence(policy, request.job, request.question, context)) {
        throw new TypeError('nutrition-query-evidence-mismatch');
      }
      const gaps = [
        `clinical-readiness: ${context.clinicalReadiness}; no recommendation authority.`,
        'verbatim-passages-unavailable: retained summaries are not verified original passages.',
        'scientific-appraisal-not-performed: retained appraisals are not adopted claims.',
        `corpus-partial: ${context.corpusStatus.limitation}`,
      ];
      const coverage = context.coverage.units.find(unit => unit.unit_id === topic);
      if (coverage?.state !== 'saturated') gaps.push(`topic-coverage: ${topic}; ${coverage?.state ?? 'unknown'}.`);
      if (context.corpusStatus.units_without_observations.length) {
        gaps.push(`units-without-observations: ${context.corpusStatus.units_without_observations.join(', ')}.`);
      }
      if (context.corpusStatus.source_packets_without_records.length) {
        gaps.push(`packets-without-records: ${context.corpusStatus.source_packets_without_records.join(', ')}.`);
      }
      if (context.status === 'gap') gaps.push(`retrieval-gap: ${context.reason}; no match within this bounded projection and query.`);
      if (context.truncated) gaps.push(`retrieval-truncated: ${context.observations.length} of ${context.totalMatches} matching observations returned.`);
      const candidates = context.observations.map(observation => {
        const record = observation.record;
        if (record.conflicts.length) gaps.push(`unresolved-conflicts: ${record.id}; ${record.conflicts.join(', ')}.`);
        return {
          observation, topicIds: record.topic_ids,
          provenance: {
            status: 'source-observation' as const, sourceRevision: context.source.revision,
            locator: `${context.source.corpusRoot}/${observation.source_path}:${observation.line}`,
            limits: [context.corpusStatus.limitation, `access-level: ${record.access_level}`,
              record.source_native_certainty, record.form_appraisal, record.applicability,
              record.rights_status, record.freshness_status, record.provenance],
          },
        };
      });
      return { context, candidates, gaps };
    },
  };
}
