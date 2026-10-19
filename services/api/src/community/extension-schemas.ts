import { z } from 'zod';
import { DomainError } from '../errors.js';
export const id = z.string().uuid();
export const keySchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/);
export const expectedRevision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const plainText = (max: number) => z.string().trim().refine(v => [...v].length > 0 && [...v].length <= max && Buffer.byteLength(v) <= 2048 && !/[\u0000-\u001f\u007f<>]|https?:\/\/|www\./iu.test(v));
export const preferences = z.strictObject({ alias: plainText(60), intent: z.enum(['accountability', 'supportive_community']), language: z.enum(['en', 'es', 'fr']),
 goals: z.array(z.enum(['strength', 'mobility', 'consistency'])).max(3).refine(v => new Set(v).size === v.length),
 region: z.enum(['US-NE', 'US-SE', 'US-MW', 'US-SW', 'US-W', 'CA', 'EU', 'OTHER']).nullable(),
 location: z.enum(['local_preferred', 'nonlocal_preferred', 'anywhere', 'diverse_preferred']),
 priorities: z.array(z.enum(['location', 'goals'])).length(2).refine(v => new Set(v).size === 2),
 relax: z.strictObject({ broaderRegion: z.boolean(), mixedGoals: z.boolean() }), willingHost: z.boolean(),
 fillExistingGroups: z.boolean(), membershipDisclosureAccepted: z.literal(true), policyVersion: z.literal('community-v1') });
export const enrollment = z.strictObject({ expectedRevision, preferences });
export const revisionInput = z.strictObject({ expectedRevision });
export const profile = z.strictObject({ expectedRevision, flags: z.strictObject({ age: z.literal(false), sex: z.boolean(), region: z.boolean(), avatar: z.boolean(), adherence: z.boolean(), ranking: z.boolean() }),
 sexDescription: plainText(60).nullable(), region: preferences.shape.region, avatar: z.enum(['leaf', 'sun', 'mountain']).nullable(), audiencePreviewAccepted: z.literal(true) });
export const post = z.discriminatedUnion('kind', [
 z.strictObject({ kind: z.literal('check_in'), template: z.enum(['checking_in', 'at_my_pace']), policyVersion: z.literal('community-v1'), audiencePreviewAccepted: z.literal(true) }),
 z.strictObject({ kind: z.literal('win'), text: plainText(500).optional(), policyVersion: z.literal('community-v1'), audiencePreviewAccepted: z.literal(true) }),
]);
export const reaction = z.strictObject({ active: z.boolean(), reaction: z.enum(['cheer', 'thanks', 'with_you']), expectedRevision });
export const motion = z.discriminatedUnion('kind', [
 z.strictObject({ kind: z.literal('growth'), places: z.number().int().min(1).max(4), expectedRevision }),
 z.strictObject({ kind: z.literal('friend'), expectedRevision }),
 z.strictObject({ kind: z.literal('removal'), memberId: id, expectedRevision }),
]);
export const ballot = z.strictObject({ choice: z.enum(['yes', 'no', 'abstain']), expectedRevision });
export const safetyReference = z.strictObject({ kind: z.enum(['member', 'post']), resourceId: id });
export const report = z.strictObject({ category: z.enum(['harassment', 'privacy', 'danger', 'other']), text: plainText(1000), safetyReference: id.optional() });
export const appeal = z.strictObject({ text: plainText(1000), expectedRevision });
export const empty = z.strictObject({});
export function parse<T>(schema: z.ZodType<T>, value: unknown): T { const result = schema.safeParse(value); if (!result.success) throw new DomainError(422, 'community_invalid_input'); return result.data; }
export function boundedJson<T>(raw: string, schema: z.ZodType<T>): T { if (Buffer.byteLength(raw) > 8192) throw new DomainError(413, 'community_stored_value_too_large'); try { return parse(schema, JSON.parse(raw)); } catch (error) { if (error instanceof DomainError) throw error; throw new DomainError(503, 'community_integrity_unavailable'); } }
export const storedProfile = profile.omit({ expectedRevision: true, audiencePreviewAccepted: true }).extend({ revision: z.number().int().min(0) });
export const policy = z.strictObject({ policyVersion: z.literal('community-v1'), batchZone: z.literal('America/New_York'), cutoffLocalDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
 cutoffAt: z.iso.datetime(), runAt: z.iso.datetime(), resumeUntil: z.iso.datetime(), runtimeVersion: z.string().min(1).max(100), resolution: z.literal('exact'),
 minimum: z.literal(4), target: z.literal(12), startCapacity: z.literal(12), growCapacity: z.literal(20) });
export const batchCandidate = z.strictObject({ enrollmentId: id, accountId: id, revision: z.number().int().min(1), generation: z.number().int().min(1),
 queuedAt: z.iso.datetime(), consentAt: z.iso.datetime(), eligible: z.boolean(), exclusionRevision: z.number().int().min(0), preferences });
export const snapshot = z.strictObject({ intent: z.enum(['accountability', 'supportive_community']), language: z.enum(['en', 'es', 'fr']), candidates: z.array(batchCandidate).max(500),
 exclusionsKnown: z.boolean(), exclusionGeneration: z.number().int().min(0), excludedPairs: z.array(z.tuple([id, id])).max(125000) });
