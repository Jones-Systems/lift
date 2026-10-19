import { createHash } from 'node:crypto';
import { z } from 'zod';
import { DomainError } from '../errors.js';
import type { AccountContext } from '../lifecycle/types.js';
import { reportIdSchema, trustedBindingSchema } from './schemas.js';

export const bugOutcomeLimits = Object.freeze({ bytes: 16 * 1024, checks: 16, uncertainties: 8 });
const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const revision = z.string().regex(/^[a-f0-9]{40}$/);
const evidenceSchema = z.object({ artifactId: id, artifactSha256: digest, sourceRevision: revision }).strict();
const referenceSchema = z.object({ reportId: reportIdSchema, reportFingerprint: digest }).strict();
const bindingSchema = referenceSchema.extend({ investigation: z.object({ repository: z.literal('Jones-Systems/Form'),
  sourceRevision: revision, investigationScopeId: id, authorityId: id }).strict() }).strict();
const decisionSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('pending') }).strict(),
  z.object({ status: z.literal('recorded'), decisionAuthority: z.literal('product_owner'),
    choice: z.enum(['approve_bounded_change', 'retain_current_behavior', 'request_more_investigation', 'defer']),
    recommendationDigest: digest, witness: evidenceSchema }).strict(),
]);
const fixSchema = z.object({ acceptedBinding: trustedBindingSchema, acceptanceWitness: evidenceSchema,
  resultRevision: revision.nullable(), changeWitness: evidenceSchema.nullable(),
  requiredCheckIds: z.array(id).min(1).max(bugOutcomeLimits.checks),
  checks: z.array(z.object({ checkId: id, result: z.enum(['passed', 'failed', 'inconclusive']),
    testedRevision: revision, witness: evidenceSchema }).strict()).max(bugOutcomeLimits.checks),
}).strict();
const shape = {
  snapshotId: id, binding: bindingSchema,
  classification: z.enum(['confirmed_defect', 'expected_behavior', 'improvement_request', 'inconclusive']),
  scopeImpact: z.enum(['within_existing_product_scope', 'scope_expansion', 'undetermined', 'no_change']),
  observedBehavior: evidenceSchema, expectedBehavior: evidenceSchema.nullable(),
  uncertainties: z.array(evidenceSchema).max(bugOutcomeLimits.uncertainties),
  recommendationDigest: digest.nullable(), ownerDecision: decisionSchema, fix: fixSchema.nullable(),
};
const contentSchema = z.object(shape).strict().superRefine((value, context) => {
  const evidence = [value.observedBehavior, ...(value.expectedBehavior ? [value.expectedBehavior] : []), ...value.uncertainties];
  const ids = value.fix?.requiredCheckIds ?? [], checks = value.fix?.checks.map(check => check.checkId) ?? [];
  if (evidence.some(ref => ref.sourceRevision !== value.binding.investigation.sourceRevision)
    || value.classification === 'confirmed_defect' && !value.expectedBehavior
    || value.classification === 'inconclusive' && value.uncertainties.length === 0
    || value.ownerDecision.status === 'recorded' && value.ownerDecision.recommendationDigest !== value.recommendationDigest
    || value.fix && ((value.fix.resultRevision === null) !== (value.fix.changeWitness === null)
      || value.fix.resultRevision === null && value.fix.checks.length !== 0)
    || new Set(ids).size !== ids.length || new Set(checks).size !== checks.length || checks.some(check => !ids.includes(check)))
    context.addIssue({ code: 'custom', message: 'invalid_outcome_binding' });
});
const snapshotSchema = z.object({ ...shape, snapshotDigest: digest }).strict();
type Immutable<T> = T extends object ? { readonly [K in keyof T]: Immutable<T[K]> } : T;
export type OutcomeEvidenceRef = Immutable<z.infer<typeof evidenceSchema>>;
export type BugOutcomeReference = Immutable<z.infer<typeof referenceSchema>>;
export type BugOutcomeBinding = Immutable<z.infer<typeof bindingSchema>>;
export type BugOwnerDecision = Immutable<z.infer<typeof decisionSchema>>;
export type BugFixReadback = Immutable<z.infer<typeof fixSchema>>;
export type BugOutcomeSnapshotContent = Immutable<z.infer<typeof contentSchema>>;
export type BugOutcomeSnapshot = BugOutcomeSnapshotContent & Readonly<{ snapshotDigest: string }>;
export type BugOutcomeSource = Readonly<{
  read(context: AccountContext, reference: BugOutcomeReference): BugOutcomeSnapshot | null;
  // Must prove ownership, current retained authority/provenance, scopeImpact, and that required checks cover the accepted defect/reproduction/fix.
  // Green counts and routing receipts alone never establish coverage or a verified fix.
  assertCurrent(context: AccountContext, snapshot: BugOutcomeSnapshot): void;
}>;
export type BugOutcomeReadOptions = Readonly<{
  reference: BugOutcomeReference; context: AccountContext; assertActive(): void; source?: BugOutcomeSource;
}>;
export type BugOutcomeStatus = 'investigation_pending' | 'owner_decision_pending' | 'expected_behavior'
  | 'decision_recorded' | 'fix_unverified' | 'fix_verified';
export type BugOutcomeView = Readonly<{ status: 'unavailable'; reason: 'source_unavailable' | 'outcome_missing' | 'outcome_unqualified' }>
  | Readonly<{ status: BugOutcomeStatus; snapshot: BugOutcomeSnapshot; authorityEffect: 'none'; executionAuthorized: false }>;
export type BugReporterOutcome = Readonly<{
  schema: 'form.bug-reporter-outcome/v1'; reportId: string; status: BugOutcomeStatus | 'unavailable';
  verificationScope: 'cited_checks_only'; requiredChecks: number; passedChecks: number;
}>;
export type BugReporterProjectionAuthority = Readonly<{
  // Confirms current permission to disclose exactly this summary to the reporting account, not a private packet.
  assertCurrent(context: AccountContext, snapshot: BugOutcomeSnapshot, summary: BugReporterOutcome): void;
}>;
const invalid = () => new DomainError(503, 'bug_outcome_unqualified');
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function parse<T>(schema: z.ZodType<T>, raw: unknown): T {
  try {
    const value = schema.parse(raw);
    if (Buffer.byteLength(JSON.stringify(value)) > bugOutcomeLimits.bytes) throw invalid();
    return freeze(value);
  } catch { throw invalid(); }
}
export function bugOutcomeSnapshotDigest(content: BugOutcomeSnapshotContent): string {
  return createHash('sha256').update(JSON.stringify(parse(contentSchema, content))).digest('hex');
}
/** Structural validation and digest integrity cannot establish that a fix ran or that a witness is genuine. */
export function parseBugOutcomeSnapshot(raw: unknown): BugOutcomeSnapshot {
  const parsed = parse(snapshotSchema, raw), { snapshotDigest, ...content } = parsed;
  if (bugOutcomeSnapshotDigest(content) !== snapshotDigest) throw invalid();
  return parsed;
}
function passedChecks(fix: BugFixReadback | null): number {
  return fix?.checks.filter(check => check.result === 'passed' && check.testedRevision === fix.resultRevision
    && check.witness.sourceRevision === fix.resultRevision).length ?? 0;
}
function status(snapshot: BugOutcomeSnapshot): BugOutcomeStatus {
  const { fix, ownerDecision: decision, binding } = snapshot;
  if (fix) {
    const expansion = snapshot.scopeImpact === 'scope_expansion' || snapshot.classification === 'improvement_request';
    const decisionAllows = decision.status === 'pending' ? !expansion : decision.choice === 'approve_bounded_change';
    const qualified = ['confirmed_defect', 'improvement_request'].includes(snapshot.classification)
      && ['within_existing_product_scope', 'scope_expansion'].includes(snapshot.scopeImpact)
      && snapshot.uncertainties.length === 0 && decisionAllows
      && fix.acceptedBinding.repository === binding.investigation.repository
      && fix.acceptedBinding.sourceRevision === binding.investigation.sourceRevision
      && fix.acceptedBinding.acceptedScopeId !== binding.investigation.investigationScopeId
      && fix.acceptanceWitness.sourceRevision === fix.acceptedBinding.sourceRevision
      && fix.resultRevision !== null && fix.changeWitness !== null
      && fix.changeWitness.sourceRevision === fix.resultRevision
      && passedChecks(fix) === fix.requiredCheckIds.length;
    return qualified ? 'fix_verified' : 'fix_unverified';
  }
  if (snapshot.classification === 'inconclusive' || decision.status === 'recorded' && decision.choice === 'request_more_investigation')
    return 'investigation_pending';
  if (decision.status === 'pending') return 'owner_decision_pending';
  if (snapshot.classification === 'expected_behavior' && decision.choice === 'retain_current_behavior') return 'expected_behavior';
  return 'decision_recorded';
}
function guard(options: BugOutcomeReadOptions) {
  const { assertActive, source } = options, context = Object.freeze({ ...options.context });
  const callback = <T>(effect: () => T): T => { assertActive(); try { return effect(); } finally { assertActive(); } };
  return { assertActive, source, context, callback };
}
export function createBugOutcomeView(options: BugOutcomeReadOptions): BugOutcomeView {
  const g = guard(options);
  const unavailable = (reason: Extract<BugOutcomeView, { status: 'unavailable' }>['reason']): BugOutcomeView => {
    g.assertActive(); return Object.freeze({ status: 'unavailable', reason });
  };
  g.assertActive();
  if (!g.source) return unavailable('source_unavailable');
  try {
    const reference = parse(referenceSchema, options.reference);
    const raw = g.callback(() => g.source!.read(g.context, reference));
    if (raw === null) return unavailable('outcome_missing');
    const snapshot = parseBugOutcomeSnapshot(raw);
    if (snapshot.binding.reportId !== reference.reportId || snapshot.binding.reportFingerprint !== reference.reportFingerprint)
      return unavailable('outcome_unqualified');
    g.callback(() => g.source!.assertCurrent(g.context, snapshot));
    const result = freeze({ status: status(snapshot), snapshot, authorityEffect: 'none' as const, executionAuthorized: false as const });
    g.assertActive(); return result;
  } catch { return unavailable('outcome_unqualified'); }
}
export function createBugReporterOutcome(options: BugOutcomeReadOptions & Readonly<{ projection?: BugReporterProjectionAuthority }>): BugReporterOutcome {
  const g = guard(options), projection = options.projection;
  g.assertActive();
  const reportId = parse(reportIdSchema, options.reference.reportId);
  const unavailable = (): BugReporterOutcome => {
    g.assertActive(); return Object.freeze({ schema: 'form.bug-reporter-outcome/v1', reportId, status: 'unavailable',
      verificationScope: 'cited_checks_only', requiredChecks: 0, passedChecks: 0 });
  };
  g.assertActive();
  if (!projection || !g.source) return unavailable();
  const view = createBugOutcomeView(options);
  if (view.status === 'unavailable') return unavailable();
  const summary: BugReporterOutcome = Object.freeze({ schema: 'form.bug-reporter-outcome/v1', reportId, status: view.status,
    verificationScope: 'cited_checks_only', requiredChecks: view.snapshot.fix?.requiredCheckIds.length ?? 0,
    passedChecks: passedChecks(view.snapshot.fix) });
  try {
    g.callback(() => g.source!.assertCurrent(g.context, view.snapshot));
    g.callback(() => projection.assertCurrent(g.context, view.snapshot, summary));
  } catch { return unavailable(); }
  g.assertActive(); return summary;
}
