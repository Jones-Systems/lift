import { z } from 'zod';
import type { GroundingRetriever } from '../../grounding/index.js';
import { createInformativeConsumer } from './informative.js';
import { createResearchConsumer, type GroundingPort } from './grounding.js';
export type { ConsumerContext, DomainResearchResponse, GroundingPort, ObservationGrounding } from './grounding.js';

const modality = z.enum(['walking', 'running', 'cycling', 'rowing', 'swimming', 'other', 'unspecified']);
const jobSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('activity_guidelines'), intent: z.literal('explain'), population: z.enum(['general_adult', 'older_adult', 'unspecified']) }),
  z.strictObject({ kind: z.literal('intensity'), intent: z.literal('explain'), method: z.enum(['heart_rate', 'rpe', 'talk_test', 'device_limitations']), modality }),
  z.strictObject({ kind: z.literal('modalities'), intent: z.literal('explain'), modality, comparison: modality }),
  z.strictObject({ kind: z.literal('concurrent_training'), intent: z.literal('explain'), modality,
    order: z.enum(['strength_first', 'cardio_first', 'unspecified']),
    spacing: z.enum(['same_session', 'separate_sessions', 'separate_days', 'unspecified']),
    outcome: z.enum(['strength', 'hypertrophy', 'endurance', 'power', 'unspecified']) }),
  z.strictObject({ kind: z.literal('energy_balance'), intent: z.literal('explain'), focus: z.enum(['expenditure_uncertainty', 'compensation', 'exercise_and_intake']) }),
]);
export type CardioJob = z.infer<typeof jobSchema>;

function researchQuery(job: CardioJob): string {
  switch (job.kind) {
    case 'activity_guidelines': return 'physical activity';
    case 'intensity': return { heart_rate: 'heart rate', rpe: 'perceived exertion', talk_test: 'talk test', device_limitations: 'device' }[job.method];
    case 'modalities': return job.modality === 'other' || job.modality === 'unspecified' ? 'aerobic' : job.modality;
    case 'concurrent_training': return 'concurrent';
    case 'energy_balance': return 'energy';
  }
}

export function createCardioConsumer(port: GroundingPort) {
  return createResearchConsumer(port, input => jobSchema.parse(input), researchQuery);
}

const informativeTopics: Record<CardioJob['kind'], string> = {
  activity_guidelines: 'CAR-H1', intensity: 'CAR-H2', modalities: 'CAR-H3', concurrent_training: 'CAR-H4', energy_balance: 'CAR-H5',
};

export function createInformativeCardioConsumer(retriever: GroundingRetriever) {
  return createInformativeConsumer(retriever, input => jobSchema.parse(input), researchQuery, job => informativeTopics[job.kind]);
}
export type { InformativeRequest, InformativeResponse, LiteratureSelection, LiteratureFollowThrough, QualificationColumn } from './informative.js';
