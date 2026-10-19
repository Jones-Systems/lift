import { z } from 'zod';

export const bodyConsentVersion = 'form.body-consent/v1' as const;
const identifier = z.string().min(1).max(120).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const positiveLength = z.number().finite().positive();

// Future retained contracts only; schema acceptance never enables a server capability.
export const bodyPurposeChoicesSchema = z.object({
  consentVersion: z.literal(bodyConsentVersion),
  retention: z.enum(['no_save', 'measurements_only', 'photos_only', 'photos_and_measurements']),
  retainImages: z.boolean(),
  retainMeasurements: z.boolean(),
  externalProviderProcessing: z.boolean(),
  sharedSystemImprovement: z.boolean(),
}).strict().superRefine((choice, context) => {
  const images = choice.retention === 'photos_only' || choice.retention === 'photos_and_measurements';
  const measurements = choice.retention === 'measurements_only' || choice.retention === 'photos_and_measurements';
  if (choice.retainImages !== images || choice.retainMeasurements !== measurements) {
    context.addIssue({ code: 'custom', message: 'Retention requires matching explicit purpose choices.' });
  }
  if (choice.retention === 'no_save' && (choice.externalProviderProcessing || choice.sharedSystemImprovement)) {
    context.addIssue({ code: 'custom', message: 'No-save excludes remote processing and shared improvement.' });
  }
});

export const manualExternalLengthSchema = z.object({
  construct: z.enum(['external_upper_arm', 'external_forearm', 'external_upper_leg', 'arm_span', 'sitting_height', 'stature']),
  value: positiveLength,
  unit: z.enum(['cm', 'mm']),
  side: z.enum(['left', 'right', 'not_applicable']),
  protocol: z.object({
    id: identifier,
    version: identifier,
    startEndpoint: identifier,
    endEndpoint: identifier,
    pose: identifier,
    instrument: identifier,
  }).strict(),
  provenance: z.object({
    kind: z.literal('manual_reported'),
    operator: z.enum(['self_reported', 'assisted_reported']),
    methodVersion: identifier,
    measuredAt: z.iso.datetime({ offset: true }),
  }).strict(),
}).strict().superRefine((measurement, context) => {
  const bilateral = ['external_upper_arm', 'external_forearm', 'external_upper_leg'].includes(measurement.construct);
  if (bilateral === (measurement.side === 'not_applicable')) {
    context.addIssue({ code: 'custom', message: 'Side must match the external measurement construct.' });
  }
  if (measurement.protocol.startEndpoint === measurement.protocol.endEndpoint) {
    context.addIssue({ code: 'custom', message: 'Distinct endpoints are required.' });
  }
});

export const retainedManualMeasurementRequestSchema = z.object({
  expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  choices: bodyPurposeChoicesSchema,
  measurements: z.array(manualExternalLengthSchema).min(1).max(32),
}).strict().superRefine((request, context) => {
  if (request.choices.retention !== 'measurements_only' || !request.choices.retainMeasurements ||
    request.choices.retainImages || request.choices.externalProviderProcessing || request.choices.sharedSystemImprovement) {
    context.addIssue({ code: 'custom', message: 'Manual retention requires measurements-only consent without external or improvement use.' });
  }
});

// This validates future reported geometry inputs; it computes no anatomy or assessment.
export const reportedExternalRatioInputSchema = z.object({
  construct: z.literal('reported_external_length_ratio'),
  numerator: manualExternalLengthSchema,
  denominator: manualExternalLengthSchema,
}).strict().superRefine((input, context) => {
  if (input.numerator.unit !== input.denominator.unit ||
    input.numerator.protocol.id !== input.denominator.protocol.id ||
    input.numerator.protocol.version !== input.denominator.protocol.version ||
    input.numerator.protocol.pose !== input.denominator.protocol.pose ||
    input.numerator.protocol.instrument !== input.denominator.protocol.instrument ||
    input.numerator.provenance.methodVersion !== input.denominator.provenance.methodVersion ||
    input.numerator.provenance.measuredAt !== input.denominator.provenance.measuredAt) {
    context.addIssue({ code: 'custom', message: 'Ratio inputs require compatible units, protocol, pose, instrument, method and measurement time.' });
  }
  const quotient = input.numerator.value / input.denominator.value;
  if (!Number.isFinite(quotient) || quotient <= 0) {
    context.addIssue({ code: 'custom', message: 'Ratio inputs must have a finite positive quotient.' });
  }
});

export type BodyPurposeChoices = z.infer<typeof bodyPurposeChoicesSchema>;
export type ManualExternalLength = z.infer<typeof manualExternalLengthSchema>;
export type RetainedManualMeasurementRequest = z.infer<typeof retainedManualMeasurementRequestSchema>;

export interface BodyAccountContext {
  readonly accountId: string;
}

export interface FutureRetainedBodyCommand {
  readonly context: BodyAccountContext;
  readonly commandKey: string;
  readonly request: RetainedManualMeasurementRequest;
}

export type FutureBodyDeletionState = 'accepted' | 'pending' | 'complete' | 'failed';
