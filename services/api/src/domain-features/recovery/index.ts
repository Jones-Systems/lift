import { z } from 'zod';
import type { GroundingRetriever } from '../../grounding/index.js';
import { createInformativeConsumer } from '../cardio/informative.js';
import { createResearchConsumer, type GroundingPort } from '../cardio/grounding.js';

const jobSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('sleep'), intent: z.literal('explain'), focus: z.enum(['duration', 'quality', 'training_relationship']) }),
  z.strictObject({ kind: z.literal('hydration'), intent: z.literal('explain'), focus: z.enum(['general_literacy', 'measurement_limits']) }),
  z.strictObject({ kind: z.literal('soreness_readiness'), intent: z.literal('explain'), construct: z.enum(['soreness', 'fatigue', 'weakness', 'function', 'performance', 'readiness_limitations']) }),
  z.strictObject({ kind: z.literal('recovery_modalities'), intent: z.literal('explain'), modality: z.enum(['active_recovery', 'massage', 'cold', 'heat', 'stretching', 'unspecified']) }),
  z.strictObject({ kind: z.literal('stress'), intent: z.literal('explain'), focus: z.enum(['recovery_relationship', 'measurement_limits']) }),
  z.strictObject({ kind: z.literal('injury_literacy'), intent: z.literal('explain'), focus: z.enum(['terminology', 'evidence_limits', 'regional_preflight']) }),
  z.strictObject({ kind: z.literal('return_framework'), intent: z.literal('explain'), focus: z.enum(['framework_literacy', 'clinician_plan_limits', 'uncertainty']) }),
]);
export type RecoveryJob = z.infer<typeof jobSchema>;
const queries: Record<RecoveryJob['kind'], string> = {
  sleep: 'sleep', hydration: 'hydration', soreness_readiness: 'soreness', recovery_modalities: 'recovery',
  stress: 'stress', injury_literacy: 'injury', return_framework: 'return',
};
export function createRecoveryConsumer(port: GroundingPort) {
  return createResearchConsumer(port, input => jobSchema.parse(input), job => queries[job.kind]);
}

const informativeJobSchema = z.union([jobSchema, z.strictObject({
  kind: z.literal('injury_literacy'), intent: z.literal('explain'),
  focus: z.enum(['terminology', 'evidence_limits', 'regional_preflight']),
  topic: z.enum(['INJ-K1', 'INJ-K2', 'INJ-K3', 'INJ-K4', 'INJ-K5', 'INJ-K6', 'INJ-K7', 'INJ-K8']),
})]);
export type InformativeRecoveryJob = z.infer<typeof informativeJobSchema>;
const informativeTopics = {
  sleep: 'REC-J1', hydration: 'REC-J2', soreness_readiness: 'REC-J3', recovery_modalities: 'REC-J4',
  stress: 'REC-J5', return_framework: 'INJ-K4',
};
function informativeTopic(job: InformativeRecoveryJob): string {
  if (job.kind !== 'injury_literacy') return informativeTopics[job.kind];
  if (!('topic' in job)) throw new Error('injury_topic_selection_required');
  return job.topic;
}

export function createInformativeRecoveryConsumer(retriever: GroundingRetriever) {
  return createInformativeConsumer(retriever, input => informativeJobSchema.parse(input), job => queries[job.kind], informativeTopic);
}
