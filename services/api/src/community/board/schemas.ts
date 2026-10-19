import { z } from 'zod';
import { DomainError } from '../../errors.js';
import { BOARD_POLICY_VERSION, boardCategories, boardStatuses } from './types.js';
const plain = (min: number, max: number) => z.string().refine(value => {
  const length = [...value].length;
  return length >= min && length <= max && value.trim() === value && !/[<>\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
    && !/(?:\b[a-z][a-z0-9+.-]*:\/\/|\b(?:https?:|www\.|mailto:|data:)|\b[\p{L}\p{N}-]+\.[\p{L}]{2,63}\b)/iu.test(value);
}, 'Bounded plain text without links or markup required');
export const identifier = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/u);
export const key = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_.:-]+$/u);
export const expectedRevision = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
export const submit = z.object({ title: plain(5, 100), description: plain(20, 2000), category: z.enum(boardCategories),
  policyVersion: z.literal(BOARD_POLICY_VERSION), policyAccepted: z.literal(true), audienceAccepted: z.literal(true), voteOnSubmit: z.boolean().default(false) }).strict();
export const correction = submit.omit({ voteOnSubmit: true }).extend({ expectedRevision, expectedCanonicalFeatureId: identifier }).strict();
export const vote = z.object({ active: z.boolean(), expectedRevision }).strict();
export const withdraw = z.object({ expectedRevision }).strict();
export const moderation = z.object({ expectedRevision, visibility: z.enum(['published', 'hidden']) }).strict();
export const merge = z.object({ sourceId: identifier, targetId: identifier, sourceRevision: expectedRevision,
  targetRevision: expectedRevision, reason: plain(5, 500), semanticEquivalent: z.literal(true) }).strict();
export const status = z.object({ expectedRevision, status: z.enum(boardStatuses), reason: plain(5, 500), releaseEvidence: plain(1, 200).optional() }).strict();
export const report = z.object({ reason: z.enum(['harassment', 'privacy', 'unsafe', 'other']) }).strict();
export const query = z.object({ q: plain(1, 100).optional(), category: z.enum(boardCategories).optional(), status: z.enum(boardStatuses).optional(),
  mine: z.enum(['submissions', 'votes']).optional(), sort: z.enum(['newest', 'most_supported']).default('newest'),
  page: z.number().int().min(1).max(200).default(1), pageSize: z.number().int().min(1).max(50).default(20) }).strict();
export const ownQuery = z.object({ page: z.number().int().min(1).max(200).default(1), pageSize: z.number().int().min(1).max(50).default(20) }).strict();
export function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value); if (!result.success) throw new DomainError(422, 'board_invalid_input'); return result.data;
}

export const correctionReceipt = z.object({ schema: z.literal('form.feature-board-correction/v1'), key, eventId: identifier,
  submissionId: identifier, featureId: identifier, expectedRevision, resultRevision: expectedRevision,
  canonicalFeatureId: identifier, canonicalRevision: expectedRevision,
  successor: z.object({ submissionId: identifier, featureId: identifier }).strict(),
  replacement: submit.omit({ voteOnSubmit: true }), createdAt: z.string().datetime(),
}).strict().refine(value => value.resultRevision === value.expectedRevision + 1 && value.successor.submissionId !== value.submissionId && value.successor.featureId !== value.featureId);
