import { createHash } from 'node:crypto';
import { z } from 'zod';
import { DomainError } from '../errors.js';
import type { AccountContext } from '../lifecycle/types.js';
import { reportIdSchema } from './schemas.js';

export const bugEvidenceLimits = Object.freeze({ bytes: 16 * 1024, facts: 8, statementLength: 1000 });
const identifier = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const revision = z.string().regex(/^[a-f0-9]{40}$/);
const statement = z.string().min(1).max(bugEvidenceLimits.statementLength)
  .refine(value => value.length <= bugEvidenceLimits.statementLength && value.trim().length > 0);
const factSchema = z.object({
  id: identifier, kind: z.enum(['source_observation', 'synthetic_reproduction']), statement,
  evidence: z.object({ artifactId: identifier, artifactSha256: digest, sourceRevision: revision }).strict(),
}).strict();
const payloadSchema = z.object({
  schema: z.literal('form.bug-technical-extract/v1'), authorityEffect: z.literal('none'), executionAuthorized: z.literal(false),
  facts: z.array(factSchema).min(1).max(bugEvidenceLimits.facts),
}).strict();
const bindingSchema = z.object({
  reportId: reportIdSchema, reportFingerprint: digest,
  investigation: z.object({ repository: z.literal('Jones-Systems/Form'), sourceRevision: revision,
    investigationScopeId: identifier, authorityId: identifier }).strict(),
}).strict();
const recipientPolicySchema = z.object({
  recipientId: identifier, policyRevision: identifier, purpose: z.literal('technical_bug_investigation'),
  retentionPolicyId: identifier, exportPolicyId: identifier, purgePolicyId: identifier,
}).strict();
const candidateSchema = z.object({ binding: bindingSchema, recipientPolicy: recipientPolicySchema, payload: payloadSchema }).strict()
  .superRefine((value, context) => {
    const ids = value.payload.facts.map(fact => fact.id);
    if (new Set(ids).size !== ids.length || value.payload.facts.some(fact => fact.evidence.sourceRevision !== value.binding.investigation.sourceRevision))
      context.addIssue({ code: 'custom', message: 'invalid_fact_binding' });
  });
const reviewSchema = z.object({ reviewId: identifier, reviewerAuthorityId: identifier, candidateDigest: digest,
  attestation: z.literal('reviewed_source_and_synthetic_facts_only') }).strict();
const reviewedSchema = z.object({ candidate: candidateSchema, review: reviewSchema }).strict();
type Immutable<T> = T extends readonly unknown[] ? { readonly [K in keyof T]: Immutable<T[K]> }
  : T extends object ? { readonly [K in keyof T]: Immutable<T[K]> } : T;
export type TechnicalFact = Immutable<z.infer<typeof factSchema>>;
export type BugTechnicalExtract = Immutable<z.infer<typeof payloadSchema>>;
export type BugEvidenceBinding = Immutable<z.infer<typeof bindingSchema>>;
export type BugEvidenceRecipientPolicy = Immutable<z.infer<typeof recipientPolicySchema>>;
export type BugEvidenceCandidate = Immutable<z.infer<typeof candidateSchema>>;
export type BugEvidenceReviewWitness = Immutable<z.infer<typeof reviewSchema>>;
export type ReviewedBugEvidence = Immutable<z.infer<typeof reviewedSchema>>;
export type BugEvidenceSource = Readonly<{
  assertReportAccess(context: AccountContext, reportId: string): void;
  reviewedFor(context: AccountContext, reportId: string): ReviewedBugEvidence | null;
  // Proves actual report fingerprint/source, reviewer authority, exact review digest and recipient policies are current.
  assertCurrent(context: AccountContext, evidence: ReviewedBugEvidence): void;
}>;
export type BugEvidenceAccess = Readonly<{ context: AccountContext; assertActive(): void; source?: BugEvidenceSource }>;
export type BugEvidenceUnavailableReason = 'source_unavailable' | 'review_missing' | 'recipient_policy_missing'
  | 'evidence_invalid' | 'binding_mismatch' | 'review_unproved';
export type BugEvidenceResult = Readonly<{ status: 'unavailable'; reason: BugEvidenceUnavailableReason }>
  | Readonly<{ status: 'prepared'; evidence: ReviewedBugEvidence }>;
const failure = (reason: BugEvidenceUnavailableReason) => new DomainError(503, `bug_evidence_${reason}`);
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function parse<T>(schema: z.ZodType<T>, raw: unknown): T {
  try {
    const value = schema.parse(raw);
    if (Buffer.byteLength(JSON.stringify(value)) > bugEvidenceLimits.bytes) throw failure('evidence_invalid');
    return freeze(value);
  } catch { throw failure('evidence_invalid'); }
}

/** Structural validation and canonical copying only; text privacy and trusted review are not established here. */
export function parseBugEvidenceCandidate(raw: unknown): BugEvidenceCandidate { return parse(candidateSchema, raw); }
export function bugEvidenceCandidateDigest(candidate: BugEvidenceCandidate): string {
  return createHash('sha256').update(JSON.stringify(parseBugEvidenceCandidate(candidate))).digest('hex');
}
/** Structural validation plus digest integrity; a matching witness is not proof of authorized review. */
export function parseReviewedBugEvidence(raw: unknown): ReviewedBugEvidence {
  const value = parse(reviewedSchema, raw);
  if (bugEvidenceCandidateDigest(value.candidate) !== value.review.candidateDigest) throw failure('evidence_invalid');
  return value;
}
function access(options: BugEvidenceAccess) {
  const { assertActive, source } = options, context = Object.freeze({ ...options.context });
  const callback = <T>(effect: () => T): T => { assertActive(); try { return effect(); } finally { assertActive(); } };
  const authorize = (reportId: string) => {
    assertActive();
    if (!source) throw failure('source_unavailable');
    try { callback(() => source.assertReportAccess(context, reportId)); }
    catch (error) {
      assertActive();
      if (error instanceof DomainError && [401, 403, 404].includes(error.status)) throw new DomainError(error.status, 'bug_evidence_access_denied');
      throw failure('review_unproved');
    }
  };
  return { assertActive, source, context, callback, authorize };
}

/** Call again after reading a separate execution grant, immediately before an optional external port. */
export function assertBugTechnicalEvidenceCurrent(options: BugEvidenceAccess, raw: unknown): ReviewedBugEvidence {
  const guard = access(options);
  guard.assertActive();
  if (!guard.source) throw failure('source_unavailable');
  const evidence = parseReviewedBugEvidence(raw);
  guard.authorize(evidence.candidate.binding.reportId);
  try { guard.callback(() => guard.source!.assertCurrent(guard.context, evidence)); }
  catch { guard.assertActive(); throw failure('review_unproved'); }
  guard.authorize(evidence.candidate.binding.reportId);
  guard.assertActive();
  return evidence;
}

export function createBugTechnicalEvidence(options: BugEvidenceAccess & Readonly<{ reportId: string }>): BugEvidenceResult {
  const guard = access(options);
  const finish = (value: BugEvidenceResult): BugEvidenceResult => { guard.assertActive(); return freeze(value); };
  guard.assertActive();
  if (!guard.source) return finish({ status: 'unavailable', reason: 'source_unavailable' });
  const parsedId = reportIdSchema.safeParse(options.reportId);
  if (!parsedId.success) return finish({ status: 'unavailable', reason: 'binding_mismatch' });
  guard.authorize(parsedId.data);
  let raw: ReviewedBugEvidence | null;
  try { raw = guard.callback(() => guard.source!.reviewedFor(guard.context, parsedId.data)); }
  catch { return finish({ status: 'unavailable', reason: 'source_unavailable' }); }
  guard.authorize(parsedId.data);
  if (raw === null) return finish({ status: 'unavailable', reason: 'review_missing' });
  let evidence: ReviewedBugEvidence;
  try {
    if (raw?.candidate && raw.candidate.recipientPolicy == null)
      return finish({ status: 'unavailable', reason: 'recipient_policy_missing' });
    evidence = parseReviewedBugEvidence(raw);
  } catch { return finish({ status: 'unavailable', reason: 'evidence_invalid' }); }
  if (evidence.candidate.binding.reportId !== parsedId.data) return finish({ status: 'unavailable', reason: 'binding_mismatch' });
  try {
    evidence = assertBugTechnicalEvidenceCurrent({ context: guard.context, assertActive: guard.assertActive, source: guard.source }, evidence);
  } catch (error) {
    guard.assertActive();
    if (error instanceof DomainError && [401, 403, 404].includes(error.status)) throw error;
    return finish({ status: 'unavailable', reason: 'review_unproved' });
  }
  return finish({ status: 'prepared', evidence });
}
