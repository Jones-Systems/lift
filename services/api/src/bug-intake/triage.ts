import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { AccountContext } from '../lifecycle/types.js';
import { parseInput, reportIdSchema, type ReportInput } from './schemas.js';
import type { BugReport } from './types.js';

export const bugTriageLimits = Object.freeze({ snapshotBytes: 16 * 1024, evidenceCount: 8, statementLength: 1000, listCount: 6, listItemLength: 300 });
const identifier = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const revision = z.string().regex(/^[a-f0-9]{40}$/);
const boundedText = (limit: number) => z.string().min(1).max(limit).refine(value => value.length <= limit && value.trim().length > 0);
const statement = boundedText(bugTriageLimits.statementLength);
const shortList = z.array(boundedText(bugTriageLimits.listItemLength)).max(bugTriageLimits.listCount);
const investigationBindingSchema = z.object({
  repository: z.literal('Jones-Systems/Form'), sourceRevision: revision,
  investigationScopeId: identifier, authorityId: identifier,
}).strict();
const evidenceSchema = z.object({
  id: identifier, kind: z.enum(['source_observation', 'synthetic_reproduction', 'accepted_behavior_reference']),
  summary: statement, artifactId: identifier, artifactSha256: sha256, sourceRevision: revision,
}).strict();
const investigationSchema = z.object({
  classification: z.enum(['confirmed_defect', 'expected_behavior', 'improvement_request', 'inconclusive']),
  observedBehavior: statement, expectedBehavior: statement.nullable(),
  evidence: z.array(evidenceSchema).min(1).max(bugTriageLimits.evidenceCount),
  openQuestions: shortList,
}).strict().refine(value => value.classification !== 'inconclusive' || value.openQuestions.length > 0)
  .refine(value => value.classification !== 'confirmed_defect' || value.expectedBehavior !== null);
const recommendationSchema = z.object({
  action: z.enum(['change', 'retain_behavior', 'investigate_more', 'defer']),
  summary: statement, proposedChange: statement.nullable(),
  buildNeeds: shortList, reasonsFor: shortList.min(1), reasonsAgainst: shortList.min(1),
  scopeImpact: z.enum(['no_change', 'within_existing_product_scope', 'scope_expansion', 'undetermined']),
  evidenceIds: z.array(identifier).min(1).max(bugTriageLimits.evidenceCount),
}).strict().refine(value => value.action !== 'change' || value.proposedChange !== null && value.buildNeeds.length > 0 && value.scopeImpact !== 'no_change');
const snapshotContentSchema = z.object({
  reportId: reportIdSchema, reportFingerprint: sha256, binding: investigationBindingSchema,
  investigation: investigationSchema, recommendation: recommendationSchema.nullable(),
}).strict().superRefine((value, context) => {
  const ids = value.investigation.evidence.map(item => item.id);
  const cited = value.recommendation?.evidenceIds ?? [];
  if (new Set(ids).size !== ids.length || new Set(cited).size !== cited.length || cited.some(id => !ids.includes(id)))
    context.addIssue({ code: 'custom', message: 'invalid_evidence_references' });
});
const retainedSnapshotSchema = z.object({
  snapshotId: identifier, retainedBy: identifier, snapshotFingerprint: sha256, content: snapshotContentSchema,
}).strict();
export type BugInvestigationBinding = Readonly<z.infer<typeof investigationBindingSchema>>;
export type BugTriageSnapshotContent = Readonly<z.infer<typeof snapshotContentSchema>>;
export type RetainedBugTriageSnapshot = Readonly<z.infer<typeof retainedSnapshotSchema>>;
export type BugTriageRequest = Readonly<{ reportId: string; reportFingerprint: string; binding: BugInvestigationBinding }>;
export type BugTriageSource = Readonly<{
  bindingFor: (context: AccountContext, reportId: string) => BugInvestigationBinding | null;
  // Reads an already retained, sanitized technical snapshot. This port must not start an investigation or store report data.
  snapshotFor: (context: AccountContext, request: BugTriageRequest) => RetainedBugTriageSnapshot | null;
  assertCurrent: (context: AccountContext, request: BugTriageRequest, snapshot: Readonly<{ snapshotId: string; snapshotFingerprint: string }> | null) => void;
}>;
type PacketBase = Readonly<{
  schema: 'form.bug-triage/v1'; authorityEffect: 'none'; executionAuthorized: false;
  originalReport: Readonly<{ kind: 'untrusted_user_report'; report: BugReport }>;
  reportFingerprint: string;
}>;
export type BugTriageUnavailableReason = 'source_unavailable' | 'source_binding_missing' | 'source_binding_invalid' | 'source_binding_stale'
  | 'investigation_unavailable' | 'snapshot_invalid' | 'snapshot_too_large' | 'report_binding_mismatch' | 'source_binding_mismatch' | 'snapshot_fingerprint_mismatch';
export type BugTriagePacket = PacketBase & (
  | Readonly<{ status: 'unavailable'; reason: BugTriageUnavailableReason }>
  | Readonly<{ status: 'investigation_required'; reason: 'investigation_missing'; binding: BugInvestigationBinding }>
  | Readonly<{ status: 'investigation_required'; reason: 'recommendation_missing'; binding: BugInvestigationBinding; snapshot: RetainedBugTriageSnapshot }>
  | Readonly<{ status: 'owner_decision_required'; binding: BugInvestigationBinding; snapshot: RetainedBugTriageSnapshot;
      ownerDecision: Readonly<{ status: 'pending'; decisionAuthority: 'product_owner';
        choices: readonly ['approve_bounded_change', 'retain_current_behavior', 'request_more_investigation', 'defer'] }> }>
);
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
export function bugReportFingerprint(input: ReportInput): string {
  return createHash('sha256').update(JSON.stringify(parseInput(input))).digest('hex');
}
// Retainers hash the strict schema's canonical field order; this identifier binds content, not approval or storage availability.
export function bugTriageSnapshotFingerprint(content: BugTriageSnapshotContent): string {
  return createHash('sha256').update(JSON.stringify(snapshotContentSchema.parse(content))).digest('hex');
}

export function createBugTriagePacket(options: Readonly<{
  report: BugReport; context: AccountContext; assertActive: () => void; source?: BugTriageSource;
}>): BugTriagePacket {
  const { assertActive, source } = options;
  assertActive();
  const context = Object.freeze({ ...options.context });
  const report = JSON.parse(JSON.stringify(options.report)) as BugReport;
  const reportFingerprint = bugReportFingerprint({ title: report.title, description: report.description, diagnosticConsent: report.diagnosticConsent,
    ...(report.diagnostics === undefined ? {} : { diagnostics: report.diagnostics }) });
  const base: PacketBase = freeze({ schema: 'form.bug-triage/v1', authorityEffect: 'none', executionAuthorized: false,
    originalReport: { kind: 'untrusted_user_report', report }, reportFingerprint });
  const finish = (packet: BugTriagePacket): BugTriagePacket => { assertActive(); const result = freeze(packet); assertActive(); return result; };
  const unavailable = (reason: BugTriageUnavailableReason) => finish({ ...base, status: 'unavailable', reason });
  const callback = <T>(effect: () => T): T => { assertActive(); try { return effect(); } finally { assertActive(); } };
  if (!source) return unavailable('source_unavailable');
  let binding: BugInvestigationBinding;
  try {
    const candidate = callback(() => source.bindingFor(context, report.id));
    if (candidate === null) return unavailable('source_binding_missing');
    const parsed = investigationBindingSchema.safeParse(candidate);
    if (!parsed.success) return unavailable('source_binding_invalid');
    binding = freeze(parsed.data);
  } catch { return unavailable('source_unavailable'); }
  const request: BugTriageRequest = freeze({ reportId: report.id, reportFingerprint, binding });
  try { callback(() => source.assertCurrent(context, request, null)); }
  catch { return unavailable('source_binding_stale'); }
  let raw: RetainedBugTriageSnapshot | null;
  try { raw = callback(() => source.snapshotFor(context, request)); }
  catch { return unavailable('investigation_unavailable'); }
  if (raw === null) {
    try { callback(() => source.assertCurrent(context, request, null)); }
    catch { return unavailable('source_binding_stale'); }
    return finish({ ...base, status: 'investigation_required', reason: 'investigation_missing', binding });
  }
  let snapshot: RetainedBugTriageSnapshot;
  try {
    const parsed = retainedSnapshotSchema.safeParse(raw);
    if (!parsed.success) return unavailable('snapshot_invalid');
    snapshot = parsed.data;
    if (Buffer.byteLength(JSON.stringify(snapshot)) > bugTriageLimits.snapshotBytes) return unavailable('snapshot_too_large');
  } catch { return unavailable('snapshot_invalid'); }
  if (snapshot.content.reportId !== report.id || snapshot.content.reportFingerprint !== reportFingerprint) return unavailable('report_binding_mismatch');
  if (JSON.stringify(snapshot.content.binding) !== JSON.stringify(binding)) return unavailable('source_binding_mismatch');
  if (bugTriageSnapshotFingerprint(snapshot.content) !== snapshot.snapshotFingerprint) return unavailable('snapshot_fingerprint_mismatch');
  try { callback(() => source.assertCurrent(context, request, freeze({ snapshotId: snapshot.snapshotId, snapshotFingerprint: snapshot.snapshotFingerprint }))); }
  catch { return unavailable('source_binding_stale'); }
  if (!snapshot.content.recommendation) return finish({ ...base, status: 'investigation_required', reason: 'recommendation_missing', binding, snapshot });
  return finish({ ...base, status: 'owner_decision_required', binding, snapshot,
    ownerDecision: { status: 'pending', decisionAuthority: 'product_owner', choices: ['approve_bounded_change', 'retain_current_behavior', 'request_more_investigation', 'defer'] } });
}
