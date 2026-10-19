import { z } from 'zod';
import { DomainError } from '../errors.js';

export const bugIntakeLimits = Object.freeze({ bodyBytes: 16 * 1024, reportBytes: 12 * 1024, reportsPerAccount: 100, keysPerAccount: 500, listPage: 50 });
export const reportIdSchema = z.string().uuid();
export const idempotencyKeySchema = z.string().min(8).max(128).regex(/^[A-Za-z0-9_-]+$/);
const diagnosticsSchema = z.object({
  platform: z.enum(['ios', 'android', 'web']),
  appVersion: z.string().max(32).regex(/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.]+)?$/),
  buildNumber: z.string().max(32).regex(/^[0-9]+$/).optional(),
  screen: z.enum(['home', 'workout', 'progress', 'settings', 'other']).optional(),
}).strict();
export const reportInputSchema = z.object({
  title: z.string().trim().min(1).max(160).refine(value => value.length <= 160),
  description: z.string().trim().min(1).max(4000).refine(value => value.length <= 4000),
  diagnosticConsent: z.boolean().default(false),
  diagnostics: diagnosticsSchema.optional(),
}).strict().refine(value => value.diagnostics === undefined || value.diagnosticConsent, 'diagnostic_consent_required');
export type ReportInput = z.infer<typeof reportInputSchema>;
export function parseInput(raw: unknown): ReportInput {
  const parsed = reportInputSchema.safeParse(raw);
  if (!parsed.success) throw new DomainError(422, 'invalid_bug_report');
  if (Buffer.byteLength(JSON.stringify(parsed.data)) > bugIntakeLimits.reportBytes) throw new DomainError(413, 'bug_report_too_large');
  return parsed.data;
}
export function parseKey(raw: unknown): string {
  const parsed = idempotencyKeySchema.safeParse(raw);
  if (!parsed.success) throw new DomainError(400, 'invalid_idempotency_key');
  return parsed.data;
}
export function parseId(raw: unknown): string {
  const parsed = reportIdSchema.safeParse(raw);
  if (!parsed.success) throw new DomainError(404, 'bug_report_not_found');
  return parsed.data;
}
export const trustedBindingSchema = z.object({
  repository: z.literal('Jones-Systems/Form'),
  sourceRevision: z.string().regex(/^[a-f0-9]{40}$/),
  acceptedScopeId: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/),
  authorityId: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/),
}).strict();
export type TrustedBinding = Readonly<z.infer<typeof trustedBindingSchema>>;

export const dispatchOutcomeSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('accepted'), receiptId: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/) }).strict(),
  z.object({ status: z.literal('known_no_effect') }).strict(),
  z.object({ status: z.literal('unknown') }).strict(),
]);
