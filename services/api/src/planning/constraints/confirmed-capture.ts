import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ConstraintDecision, EvaluationInput, Gap, QualifiedCatalog, SourceEvaluationInput, SourceReference } from '../first-plan/types.js';
import { evaluateFirstPlanConstraints, evaluateSourceFirstPlanConstraints, type ConfirmedConstraintReceipt } from './first-plan-adapter.js';
import type { ContextFact, ConstraintRule, EvaluationRequest, SourceRef } from './index.js';
import { copyCandidateEquipment } from './index.js';

const id = z.string().min(1).max(256).refine(value => value.trim().length > 0);
const literal = z.string().max(4000);
const nonblankLiteral = literal.refine(value => value.trim().length > 0);
const ids = z.array(id).max(256).refine(values => new Set(values).size === values.length);
const response = z.discriminatedUnion('state', [
  z.object({ state: z.enum(['yes', 'no']), literal: nonblankLiteral }).strict(),
  z.object({ state: z.literal('answered'), literal: nonblankLiteral }).strict(),
  z.object({ state: z.literal('unknown'), literal,
    reason: z.enum(['blank', 'unclear', 'declined', 'conflicting', 'unavailable', 'unresolved']) }).strict(),
]);
const factFields = {
  id, wording: literal, region: id,
  side: z.enum(['left', 'right', 'bilateral', 'none', 'unknown']),
  resolution: z.enum(['reported', 'unknown', 'declined', 'conflicting']),
  reportedDate: literal.nullable(), reviewDate: literal.nullable(),
};
const fact = z.discriminatedUnion('kind', [
  z.object({ ...factFields, kind: z.literal('user_reported_history') }).strict(),
  z.object({ ...factFields, kind: z.literal('clinician_instruction_as_reported') }).strict(),
  z.object({ ...factFields, kind: z.literal('user_exclusion'), variantIds: ids.refine(values => values.length > 0) }).strict(),
]);
export const constraintCaptureSchema = z.object({
  answers: z.array(z.object({ questionId: id, questionRevision: id, response }).strict()).max(256),
  facts: z.array(fact).max(256),
  restrictionInventory: z.object({ response, instructionIds: ids }).strict(),
  consent: z.object({ decision: z.enum(['granted', 'declined']), statementId: id, statementRevision: id }).strict(),
}).strict();
export type ConstraintCapture = z.infer<typeof constraintCaptureSchema>;
export type QuestionInventory = Readonly<{
  id: string; revision: string; source: SourceRef;
  questions: readonly Readonly<{ id: string; revision: string; prompt: string; kind: 'yes_no' | 'text'; required: boolean }>[];
  consent: Readonly<{ id: string; revision: string; text: string }>;
}>;
export type CapturePin = Readonly<{
  id: string; revision: string; digest: string;
  accountId: string; sessionId: string; contextKey: string;
  profileRevision: number; preferencesRevision: number;
}>;
export type ConfirmedCaptureRecord = Readonly<{
  pin: CapturePin;
  payload: unknown;
  source: Omit<SourceRef, 'qualification'>;
  confirmation: Readonly<{ id: string; captureRevision: string; captureDigest: string; confirmedAt: string }>;
}>;
export type VariantInventory = Readonly<{
  source: SourceReference;
  variants: readonly Readonly<{ id: string; source: SourceReference }>[];
}>;
export type R1CaptureWitness = Readonly<{
  capture: CapturePin;
  captureFactIds: readonly string[];
  snapshot: Pick<EvaluationRequest, 'binding' | 'current' | 'preflight' | 'facts' | 'requiredFactIds' | 'rules'>;
}>;
export type CaptureWitnesses = Readonly<{
  capture: ConfirmedCaptureRecord | null;
  questions: QuestionInventory;
  variants: VariantInventory;
  r1: R1CaptureWitness | null;
}>;
export type ConstraintCaptureHost = Readonly<{
  pin: CapturePin;
  assertActive: () => void;
  readCurrent: () => CaptureWitnesses;
}>;
export type AcceptedConstraintMetadata = Pick<ConfirmedConstraintReceipt, 'source' | 'candidate' | 'structuredContext'> &
  Pick<EvaluationRequest, 'purposes' | 'locks' | 'preferences' | 'baseline'>;
export type CaptureInspection =
  | { status: 'invalid'; gaps: Gap[] }
  | { status: 'captured'; capture: ConstraintCapture; digest: string; gaps: Gap[] };
export type PreparedConstraintReceipt =
  | { status: 'unavailable'; gaps: Gap[]; evidence?: CaptureWitnesses; decision?: ConstraintDecision }
  | { status: 'prepared'; receipt: ConfirmedConstraintReceipt; decision: ConstraintDecision;
      evidence: CaptureWitnesses; assertCurrent: () => void; readCurrent: () => ConfirmedConstraintReceipt | null };

function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort()
    .map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  throw new TypeError('Unsupported capture evidence value');
}
function digest(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}
function detached<T>(value: T): T {
  const result = structuredClone(value);
  const freeze = (part: unknown): void => {
    if (part && typeof part === 'object') { Object.values(part).forEach(freeze); Object.freeze(part); }
  };
  freeze(result);
  return result;
}
function sourceCurrent(source: Omit<SourceReference, 'qualification'>): boolean {
  return [source.id, source.revision, source.locator].every(value => id.safeParse(value).success) && source.currentness === 'current';
}
function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return new Set(left).size === left.length && new Set(right).size === right.length &&
    left.length === right.length && left.every(value => right.includes(value));
}
function fail(code: string): never { throw new ConstraintCaptureError(code); }
export class ConstraintCaptureError extends Error {
  readonly code: string;
  readonly gaps: Gap[];
  constructor(code: string, gaps: Gap[] = [{ code }]) {
    super(code); this.name = 'ConstraintCaptureError'; this.code = code; this.gaps = detached(gaps);
  }
}
function sync(value: unknown): void {
  if (value !== null && (typeof value === 'object' || typeof value === 'function') &&
    typeof (value as { then?: unknown }).then === 'function') fail('capture_synchronous_witness_required');
}

/** Inspection preserves reports; a digest proves content identity, never confirmation or R1 clearance. */
export function inspectConstraintCapture(raw: unknown, inventory: QuestionInventory): CaptureInspection {
  const parsed = constraintCaptureSchema.safeParse(raw);
  if (!parsed.success) return { status: 'invalid', gaps: [{ code: 'capture_invalid' }] };
  try {
    if (!id.safeParse(inventory.id).success || !id.safeParse(inventory.revision).success ||
      !sourceCurrent(inventory.source) || inventory.source.qualification !== 'qualified' ||
      inventory.questions.length === 0 || inventory.questions.length > 256 ||
      !sameIds(inventory.questions.map(question => question.id), inventory.questions.map(question => question.id)) ||
      inventory.questions.some(question => !id.safeParse(question.id).success || !id.safeParse(question.revision).success ||
        !nonblankLiteral.safeParse(question.prompt).success || !['yes_no', 'text'].includes(question.kind) || typeof question.required !== 'boolean') ||
      ![inventory.consent.id, inventory.consent.revision].every(value => id.safeParse(value).success) ||
      !nonblankLiteral.safeParse(inventory.consent.text).success) {
      return { status: 'invalid', gaps: [{ code: 'question_inventory_unavailable' }] };
    }
    const capture = parsed.data, gaps: Gap[] = [];
    const answers = new Map(capture.answers.map(answer => [answer.questionId, answer]));
    const facts = new Map(capture.facts.map(entry => [entry.id, entry]));
    if (answers.size !== capture.answers.length || facts.size !== capture.facts.length ||
      capture.answers.some(answer => !inventory.questions.some(question => question.id === answer.questionId &&
        question.revision === answer.questionRevision && (answer.response.state === 'unknown' ||
          (question.kind === 'text' ? answer.response.state === 'answered' : ['yes', 'no'].includes(answer.response.state)))))) {
      return { status: 'invalid', gaps: [{ code: 'capture_inventory_mismatch' }] };
    }
    for (const question of inventory.questions) {
      const answer = answers.get(question.id);
      if (question.required && (!answer || answer.response.state === 'unknown')) gaps.push({ code: 'capture_answer_unknown', detail: question.id });
    }
    const instructions = capture.facts.filter(entry => entry.kind !== 'user_reported_history').map(entry => entry.id);
    if (!sameIds(instructions, capture.restrictionInventory.instructionIds) ||
      capture.restrictionInventory.response.state === 'answered' ||
      (capture.restrictionInventory.response.state === 'no' && instructions.length > 0)) {
      return { status: 'invalid', gaps: [{ code: 'capture_restriction_inventory_mismatch' }] };
    }
    if (capture.restrictionInventory.response.state === 'unknown' ||
      (capture.restrictionInventory.response.state === 'yes' && instructions.length === 0)) {
      gaps.push({ code: 'capture_restriction_inventory_unknown' });
    }
    for (const entry of capture.facts) if (entry.resolution !== 'reported' || entry.side === 'unknown' ||
      entry.region === 'unknown' || entry.wording.trim().length === 0) gaps.push({ code: 'capture_fact_unresolved', detail: entry.id });
    if (capture.consent.decision !== 'granted' || capture.consent.statementId !== inventory.consent.id ||
      capture.consent.statementRevision !== inventory.consent.revision) gaps.push({ code: 'capture_consent_unavailable' });
    return { status: 'captured', capture: detached(capture), digest: digest({ capture, inventory }), gaps };
  } catch { return { status: 'invalid', gaps: [{ code: 'question_inventory_unavailable' }] }; }
}

function factSource(record: ConfirmedCaptureRecord): SourceRef {
  return { ...record.source, qualification: 'accepted_instruction' };
}
function factLocator(record: ConfirmedCaptureRecord, factId: string): string {
  return `${record.source.locator}#fact=${encodeURIComponent(factId)}`;
}
type CaptureInput = EvaluationInput | SourceEvaluationInput;
type ReceiptEvaluator<Input extends CaptureInput> =
  (input: Input, catalog: QualifiedCatalog, receipt: ConfirmedConstraintReceipt | null) => ConstraintDecision;

function buildReceipt<Input extends CaptureInput>(input: Input, catalog: QualifiedCatalog, metadata: AcceptedConstraintMetadata,
  pin: CapturePin, witnesses: CaptureWitnesses, evaluate: ReceiptEvaluator<Input>): { receipt: ConfirmedConstraintReceipt; decision: ConstraintDecision } {
  const record = witnesses.capture;
  if (!record) fail('confirmed_capture_unavailable');
  if (canonical(pin) !== canonical(record.pin) || pin.accountId !== input.context.accountId ||
    pin.contextKey !== input.contextKey || pin.profileRevision !== input.context.profile.revision ||
    pin.preferencesRevision !== input.context.preferences.revision ||
    ![pin.id, pin.revision, pin.digest, pin.accountId, pin.sessionId, pin.contextKey].every(value => id.safeParse(value).success)) {
    fail('confirmed_capture_binding_mismatch');
  }
  if (!sourceCurrent(record.source) || record.source.revision !== pin.revision ||
    !id.safeParse(record.confirmation.id).success || !z.iso.datetime().safeParse(record.confirmation.confirmedAt).success ||
    record.confirmation.captureRevision !== pin.revision || record.confirmation.captureDigest !== pin.digest) {
    fail('capture_confirmation_unavailable');
  }
  const inspection = inspectConstraintCapture(record.payload, witnesses.questions);
  if (inspection.status === 'invalid') fail(inspection.gaps[0]!.code);
  if (inspection.digest !== pin.digest) fail('capture_digest_mismatch');
  const rawFacts = inspection.capture.facts;
  const captureGaps = inspection.gaps.filter(gap => gap.code !== 'capture_fact_unresolved' ||
    rawFacts.find(entry => entry.id === gap.detail)?.kind !== 'user_reported_history');
  if (captureGaps.length) throw new ConstraintCaptureError(captureGaps[0]!.code, captureGaps);
  const r1 = witnesses.r1;
  if (!r1) fail('r1_witness_unavailable');
  if (canonical(r1.capture) !== canonical(pin) || !sameIds(r1.captureFactIds, rawFacts.map(entry => entry.id))) fail('r1_capture_mismatch');
  const projected = rawFacts.filter(entry => entry.kind !== 'user_exclusion');
  if (!sameIds(r1.snapshot.facts.map(entry => entry.id), projected.map(entry => entry.id)) ||
    new Set(r1.snapshot.requiredFactIds).size !== r1.snapshot.requiredFactIds.length ||
    r1.snapshot.requiredFactIds.some(value => !rawFacts.some(entry => entry.id === value))) fail('r1_fact_inventory_mismatch');
  for (const entry of projected) {
    const accepted = r1.snapshot.facts.find(value => value.id === entry.id)!;
    const resolution = entry.resolution === 'reported' ?
      (entry.wording.trim().length === 0 || entry.region === 'unknown' || entry.side === 'unknown' ? 'unknown' : 'confirmed') : entry.resolution;
    if (accepted.kind !== entry.kind || accepted.region !== entry.region || accepted.side !== entry.side ||
      accepted.resolution !== resolution || accepted.revision !== pin.revision ||
      accepted.source.locator !== factLocator(record, entry.id)) fail('r1_fact_projection_mismatch');
  }
  const exclusions = rawFacts.filter(entry => entry.kind === 'user_exclusion');
  const exclusionFacts: ContextFact[] = [], exclusionRules: ConstraintRule[] = [];
  if (exclusions.length && (!sourceCurrent(witnesses.variants.source) ||
    !sameIds(witnesses.variants.variants.map(entry => entry.id), witnesses.variants.variants.map(entry => entry.id)))) fail('exclusion_variants_unavailable');
  for (const entry of exclusions) {
    for (const variantId of entry.variantIds) {
      const variant = witnesses.variants.variants.find(value => value.id === variantId);
      if (!variant || !sourceCurrent(variant.source)) fail('exclusion_variant_unavailable');
    }
    const source = { ...factSource(record), locator: factLocator(record, entry.id) };
    exclusionFacts.push({ id: entry.id, revision: pin.revision, kind: 'user_exclusion', region: entry.region,
      side: entry.side, resolution: 'confirmed', source });
    exclusionRules.push({ id: `user-exclusion:${entry.id}`, revision: pin.revision, origin: 'user_exclusion',
      source, factIds: [entry.id], variantIds: [...entry.variantIds], effect: { kind: 'exclude' } });
  }
  const receipt: ConfirmedConstraintReceipt = {
    scope: 'form.confirmed-constraint-snapshot/v1', contextKey: input.contextKey, candidateKey: input.candidateKey,
    accountId: pin.accountId, profileRevision: pin.profileRevision, preferencesRevision: pin.preferencesRevision,
    source: metadata.source, candidateSource: input.candidate.source, catalog, candidate: metadata.candidate,
    structuredContext: metadata.structuredContext,
    snapshot: { ...r1.snapshot, facts: [...r1.snapshot.facts, ...exclusionFacts], rules: [...r1.snapshot.rules, ...exclusionRules],
      purposes: metadata.purposes, locks: metadata.locks, preferences: metadata.preferences, baseline: metadata.baseline },
  };
  const decision = evaluate(input, catalog, receipt);
  return { receipt: detached(receipt), decision: detached(decision) };
}

/** The host authenticates and reads current records; this seam never classifies symptoms or grants R1 authority. */
export function prepareConfirmedConstraintReceipt(input: EvaluationInput, catalog: QualifiedCatalog,
  metadata: AcceptedConstraintMetadata, host: ConstraintCaptureHost): PreparedConstraintReceipt {
  return prepareReceipt(input, catalog, metadata, host, evaluateFirstPlanConstraints);
}

/** Source plans retain the same original-session confirmation and R1 authority requirements as legacy plans. */
export function prepareConfirmedSourceConstraintReceipt(input: SourceEvaluationInput, catalog: QualifiedCatalog,
  metadata: AcceptedConstraintMetadata, host: ConstraintCaptureHost): PreparedConstraintReceipt {
  return prepareReceipt(input, catalog, metadata, host, evaluateSourceFirstPlanConstraints);
}

function prepareReceipt<Input extends CaptureInput>(input: Input, catalog: QualifiedCatalog,
  metadata: AcceptedConstraintMetadata, host: ConstraintCaptureHost, evaluate: ReceiptEvaluator<Input>): PreparedConstraintReceipt {
  let evidence: CaptureWitnesses | undefined, decision: ConstraintDecision | undefined;
  try {
    const pin = detached(host.pin), currentInput = detached(input), currentCatalog = detached(catalog);
    const accepted = detached({ ...metadata, candidate: copyCandidateEquipment(metadata.candidate),
      baseline: metadata.baseline === null ? null : copyCandidateEquipment(metadata.baseline) });
    const receiver = host, assertActive = host.assertActive, read = host.readCurrent;
    if (typeof assertActive !== 'function' || typeof read !== 'function') fail('capture_host_unavailable');
    const readWitnesses = (): CaptureWitnesses => {
      if (receiver.assertActive !== assertActive || receiver.readCurrent !== read || canonical(receiver.pin) !== canonical(pin)) fail('capture_host_changed');
      sync(assertActive.call(receiver));
      const current = read.call(receiver);
      sync(current);
      sync(assertActive.call(receiver));
      return detached(current);
    };
    const witnesses = readWitnesses();
    evidence = witnesses;
    const fingerprint = digest(witnesses);
    const built = buildReceipt(currentInput, currentCatalog, accepted, pin, witnesses, evaluate);
    decision = built.decision;
    const assertCurrent = (): void => {
      const current = readWitnesses();
      if (digest(current) !== fingerprint) fail('capture_witness_changed');
    };
    assertCurrent();
    if (built.decision.status === 'unknown') return { status: 'unavailable', evidence, decision,
      gaps: built.decision.reasons.length ? built.decision.reasons : [{ code: 'constraint_receipt_unavailable' }] };
    return { status: 'prepared', ...built, evidence: witnesses, assertCurrent,
      readCurrent() { try { assertCurrent(); return detached(built.receipt); } catch { return null; } } };
  } catch (error) {
    return { status: 'unavailable', gaps: error instanceof ConstraintCaptureError ? error.gaps : [{ code: 'capture_witness_invalid' }],
      ...(evidence === undefined ? {} : { evidence }), ...(decision === undefined ? {} : { decision }) };
  }
}
