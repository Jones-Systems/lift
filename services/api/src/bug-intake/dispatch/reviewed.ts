import { z } from 'zod';
import { assertBugTechnicalEvidenceCurrent, bugEvidenceCandidateDigest, createBugTechnicalEvidence,
  parseBugEvidenceCandidate, type BugEvidenceAccess, type BugEvidenceRecipientPolicy,
  type BugTechnicalExtract } from '../evidence.js';
import { dispatchOutcomeSchema, reportIdSchema, reportInputSchema, trustedBindingSchema,
  type TrustedBinding } from '../schemas.js';
import { bugReportFingerprint } from '../triage.js';
import type { BugIntakeDependencies, DispatchOutcome, PreparedHandoff } from '../types.js';

export type JonesReviewedGrant = Readonly<{
  reportId: string;
  reportFingerprint: string;
  binding: TrustedBinding;
  candidateDigest: string;
  recipientPolicy: BugEvidenceRecipientPolicy;
}>;
export type JonesReviewedPort = Readonly<{ submit: (payload: BugTechnicalExtract) => Promise<unknown> }>;
export type JonesReviewedDispatchBindings = Readonly<{
  binding: TrustedBinding;
  evidence: BugEvidenceAccess;
  currentGrantFor?: (request: JonesReviewedGrant) => unknown;
  port?: JonesReviewedPort;
}>;

const handoffSchema = z.object({ handoffId: reportIdSchema, binding: trustedBindingSchema,
  report: z.object({ kind: z.literal('untrusted_user_report'), content: reportInputSchema }).strict(),
}).strict();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const grantSchema = z.object({ reportId: reportIdSchema, reportFingerprint: digest, binding: trustedBindingSchema,
  candidateDigest: digest, recipientPolicy: z.unknown() }).strict();
const sameBinding = (a: TrustedBinding, b: TrustedBinding) => a.repository === b.repository &&
  a.sourceRevision === b.sourceRevision && a.acceptedScopeId === b.acceptedScopeId && a.authorityId === b.authorityId;
const samePolicy = (a: BugEvidenceRecipientPolicy, b: BugEvidenceRecipientPolicy) =>
  a.recipientId === b.recipientId && a.policyRevision === b.policyRevision && a.purpose === b.purpose &&
  a.retentionPolicyId === b.retentionPolicyId && a.exportPolicyId === b.exportPolicyId && a.purgePolicyId === b.purgePolicyId;

export function createReviewedJonesBugDispatchAdapter(bindings: JonesReviewedDispatchBindings): NonNullable<BugIntakeDependencies['dispatch']> {
  const expectedBinding = Object.freeze(trustedBindingSchema.parse(bindings.binding));
  const access: BugEvidenceAccess = Object.freeze({ context: Object.freeze({ ...bindings.evidence.context }),
    assertActive: bindings.evidence.assertActive,
    ...(bindings.evidence.source ? { source: Object.freeze({ ...bindings.evidence.source }) } : {}) });
  const currentGrantFor = bindings.currentGrantFor, port = bindings.port;
  return Object.freeze({
    async submit(handoff: PreparedHandoff): Promise<DispatchOutcome> {
      let payload: BugTechnicalExtract;
      try {
        access.assertActive();
        const parsed = handoffSchema.parse(handoff);
        if (!access.source || !currentGrantFor || !port || !sameBinding(parsed.binding, expectedBinding))
          return { status: 'known_no_effect' };
        const fingerprint = bugReportFingerprint(parsed.report.content);
        const result = createBugTechnicalEvidence({ ...access, reportId: parsed.handoffId });
        if (result.status !== 'prepared') return { status: 'known_no_effect' };
        const candidate = result.evidence.candidate;
        if (candidate.binding.reportId !== parsed.handoffId || candidate.binding.reportFingerprint !== fingerprint ||
          candidate.binding.investigation.repository !== expectedBinding.repository ||
          candidate.binding.investigation.sourceRevision !== expectedBinding.sourceRevision)
          return { status: 'known_no_effect' };
        const candidateDigest = bugEvidenceCandidateDigest(candidate);
        const request: JonesReviewedGrant = Object.freeze({ reportId: parsed.handoffId, reportFingerprint: fingerprint,
          binding: expectedBinding, candidateDigest, recipientPolicy: candidate.recipientPolicy });
        const rawGrant = currentGrantFor(request);
        const current = assertBugTechnicalEvidenceCurrent(access, result.evidence);
        const grant = grantSchema.parse(rawGrant);
        const grantPolicy = parseBugEvidenceCandidate({ ...current.candidate, recipientPolicy: grant.recipientPolicy }).recipientPolicy;
        if (grant.reportId !== request.reportId || grant.reportFingerprint !== request.reportFingerprint ||
          !sameBinding(grant.binding, expectedBinding) || grant.candidateDigest !== candidateDigest ||
          !samePolicy(grantPolicy, candidate.recipientPolicy)) return { status: 'known_no_effect' };
        payload = current.candidate.payload;
      } catch {
        return { status: 'known_no_effect' };
      }
      // Only the reviewed technical payload crosses the port; the service retains the durable unknown-effect fence.
      try {
        return dispatchOutcomeSchema.parse(await port!.submit(payload));
      } catch {
        return { status: 'unknown' };
      }
    },
  });
}
