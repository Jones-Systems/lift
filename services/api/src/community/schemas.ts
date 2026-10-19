import { z } from 'zod';
import { DomainError } from '../errors.js';
import { shareFields, type OwnShareFlags } from './types.js';

const text = (max: number) => z.string().trim().min(1).max(max).refine(v => !/[\u0000-\u001f\u007f<>]/.test(v), 'Plain text required');
export const identifier = z.string().uuid();
export const commandKey = z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/);
const expectedRevision = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
export const tokenSchema = z.string().length(43).regex(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/);
export const flagsSchema = z.strictObject({ participation: z.boolean(), workout: z.boolean(), exerciseSnack: z.boolean(),
  planAdherence: z.boolean(), workoutMinutes: z.boolean(), exerciseCount: z.boolean(), streakDays: z.boolean() });
export const createGroupSchema = z.strictObject({ name: text(80), alias: text(60), membershipDisclosureAccepted: z.literal(true) });
export const issueInvitationSchema = z.strictObject({});
export const previewInvitationSchema = z.strictObject({ token: tokenSchema });
export const joinInvitationSchema = z.strictObject({ token: tokenSchema, alias: text(60), membershipDisclosureAccepted: z.literal(true) });
export const revisionSchema = z.strictObject({ expectedRevision });
export const aliasSchema = z.strictObject({ alias: text(60), expectedRevision });
export const renameSchema = z.strictObject({ name: text(80), expectedRevision });
export const roleSchema = z.strictObject({ role: z.enum(['admin', 'member']), expectedRevision });
export const sharingSchema = z.strictObject({ flags: flagsSchema, expectedRevision });
export const emptySchema = z.strictObject({});
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v => {
  const d = new Date(`${v}T00:00:00.000Z`); return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === v;
});
export const rangeSchema = z.strictObject({ from: date, to: date }).refine(v => {
  const span = (Date.parse(v.to) - Date.parse(v.from)) / 86400000; return span >= 0 && span < 31;
});
export const activityDaySchema = z.strictObject({ localDate: date, timeZone: z.string().min(1).max(100),
  dayStartAt: z.iso.datetime(), dayEndAt: z.iso.datetime(), revision: expectedRevision,
  workout: z.enum(['recorded', 'not_recorded', 'unknown']).optional(),
  exerciseSnack: z.enum(['recorded', 'not_recorded', 'unknown']).optional(),
  planAdherence: z.enum(['met', 'not_met', 'pending', 'unknown', 'not_applicable']).optional(),
  workoutMinutes: z.number().finite().nonnegative().max(2880).optional(),
  exerciseCount: z.number().int().nonnegative().max(10000).optional(),
  streakDays: z.number().int().nonnegative().max(100000).optional() });
export const activityResultSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('unavailable') }),
  z.strictObject({ status: z.literal('available'), days: z.array(activityDaySchema).max(31) }),
]);
export function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new DomainError(422, 'community_invalid_input');
  return result.data;
}
export function allFalse(): OwnShareFlags {
  return Object.fromEntries(shareFields.map(f => [f, false])) as OwnShareFlags;
}
