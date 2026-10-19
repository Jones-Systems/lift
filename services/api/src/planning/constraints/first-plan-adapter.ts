import { isDeepStrictEqual } from 'node:util';
import { normalizeSourceFirstPlanInput, prescriptionKey, sourcePrescriptionKey } from '../first-plan/index.js';
import type {
  Binding, ConstraintDecision, ConstraintRuleTrace, EvaluationInput, Gap, JsonValue,
  QualifiedCatalog, SourceEvaluationInput, SourceReference,
} from '../first-plan/types.js';
import { copyCandidateEquipment, evaluateConstraints, isGroupedEquipmentRequirements } from './index.js';
import type { CandidatePlan, EvaluationRequest, Reason, SourceRef } from './index.js';
import type { NativeRecordIdentity } from '../../catalog-qualification/native-identity.js';

export type ConfirmedConstraintReceipt = Readonly<Binding & {
  scope: 'form.confirmed-constraint-snapshot/v1';
  accountId: string;
  profileRevision: number;
  preferencesRevision: number;
  source: SourceRef;
  candidateSource: SourceReference;
  catalog: QualifiedCatalog;
  candidate: CandidatePlan;
  structuredContext: Readonly<{ value: string; source: SourceRef }> | null;
  snapshot: Omit<EvaluationRequest, 'limits' | 'candidates'>;
}>;

function sameBinding(input: Binding, other: Binding): boolean {
  return input.contextKey === other.contextKey && input.candidateKey === other.candidateKey;
}

function sameSource(left: SourceReference, right: SourceReference): boolean {
  return left.id === right.id && left.revision === right.revision && left.locator === right.locator &&
    left.currentness === right.currentness && left.qualification === right.qualification;
}

function sourceIdentity(left: SourceReference, right: SourceReference): boolean {
  return left.id === right.id && left.revision === right.revision && left.locator === right.locator &&
    left.currentness === right.currentness;
}

function qualifiedSource(source: SourceRef): boolean {
  return [source.id, source.revision, source.locator].every((value) => typeof value === 'string' && value.trim().length > 0) &&
    source.currentness === 'current' && source.qualification === 'qualified';
}

function gap(reason: Reason): Gap {
  return { code: reason.code, ...(reason.itemId === null ? {} : { itemId: reason.itemId }),
    detail: `${reason.refId}: ${reason.detail}` };
}

function json(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

type ReceiptItem = { id: string; exerciseId: string };
type ReceiptInput<Item extends ReceiptItem> = Binding & {
  context: EvaluationInput['context'];
  candidate: Pick<EvaluationInput['candidate'], 'id' | 'qualification' | 'source'> & {
    plan: { minutes: number; items: readonly Item[] };
  };
  prescriptions: EvaluationInput['prescriptions'];
};

function unavailable(input: Binding, catalog: QualifiedCatalog, code: string): ConstraintDecision {
  return {
    contextKey: input.contextKey, candidateKey: input.candidateKey, status: 'unknown',
    source: structuredClone(catalog.source), reasons: [{ code }], rules: [],
    evidence: { schema: 'form.constraints.first-plan-adapter/v1', value: {
      status: 'unavailable', gap: code, applied: false,
    } },
  };
}

function validateReceipt<Item extends ReceiptItem>(input: ReceiptInput<Item>, catalog: QualifiedCatalog,
  receipt: ConfirmedConstraintReceipt, keyOf: (item: Item) => string, variantOf?: (item: Item) => string,
  identityOf?: (item: Item) => NativeRecordIdentity): string | null {
  if (!sameBinding(input, catalog) || !sameBinding(input, receipt) || !sameBinding(input, receipt.catalog)) {
    return 'constraint_receipt_binding_mismatch';
  }
  if (receipt.accountId !== input.context.accountId || receipt.profileRevision !== input.context.profile.revision ||
    receipt.preferencesRevision !== input.context.preferences.revision || receipt.snapshot.binding.context !== input.contextKey) {
    return 'constraint_receipt_context_mismatch';
  }
  if (receipt.scope !== 'form.confirmed-constraint-snapshot/v1' || !qualifiedSource(receipt.source)) {
    return 'constraint_receipt_not_qualified_current';
  }
  if ([input.candidate.source, catalog.source, ...catalog.items.map((item) => item.source)]
    .some((source) => sourceIdentity(source, receipt.source)) ||
    !sameSource(receipt.candidate.source, receipt.source)) return 'constraint_qualification_lineage_invalid';
  if (receipt.structuredContext !== null &&
    (typeof receipt.structuredContext.value !== 'string' || receipt.structuredContext.value.trim().length === 0 ||
      !qualifiedSource(receipt.structuredContext.source))) {
    return 'constraint_structured_context_unqualified';
  }
  if (input.candidate.qualification !== 'qualified' || input.candidate.source.currentness !== 'current' ||
    catalog.status !== 'qualified' || catalog.source.currentness !== 'current' ||
    receipt.candidate.source.currentness !== 'current' || receipt.candidate.source.qualification !== 'qualified') {
    return 'constraint_candidate_not_qualified_current';
  }
  if (!sameSource(catalog.source, receipt.catalog.source) ||
    receipt.snapshot.binding.catalog !== catalog.source.revision) return 'constraint_receipt_catalog_mismatch';
  if (receipt.candidate.id !== input.candidate.id || receipt.candidate.minutes !== input.candidate.plan.minutes ||
    !sameSource(receipt.candidateSource, input.candidate.source)) {
    return 'constraint_receipt_candidate_mismatch';
  }
  const planItems = input.candidate.plan.items;
  const catalogItems = new Map(catalog.items.map((item) => [item.itemId, item]));
  const receiptCatalog = new Map(receipt.catalog.items.map((item) => [item.itemId, item]));
  const keys = new Map(input.prescriptions.map((item) => [item.itemId, item.prescriptionKey]));
  if (catalogItems.size !== catalog.items.length || receiptCatalog.size !== receipt.catalog.items.length ||
    keys.size !== input.prescriptions.length || catalogItems.size !== planItems.length ||
    receiptCatalog.size !== planItems.length || keys.size !== planItems.length ||
    receipt.candidate.items.length !== planItems.length) return 'constraint_receipt_items_incomplete';
  for (let index = 0; index < planItems.length; index++) {
    const planItem = planItems[index]!;
    const proof = catalogItems.get(planItem.id);
    const retained = receiptCatalog.get(planItem.id);
    const metadata = receipt.candidate.items[index];
    const key = keyOf(planItem);
    if (!proof || !retained || !metadata || proof.retired !== false || retained.retired !== false ||
      proof.source.currentness !== 'current' || retained.source.currentness !== 'current' ||
      proof.exerciseId !== planItem.exerciseId || retained.exerciseId !== planItem.exerciseId ||
      proof.prescriptionKey !== key || retained.prescriptionKey !== key || keys.get(planItem.id) !== key ||
      proof.variantId !== retained.variantId || !sameSource(proof.source, retained.source) ||
      (variantOf !== undefined && proof.variantId !== variantOf(planItem)) ||
      metadata.id !== planItem.id || metadata.exerciseId !== planItem.exerciseId ||
      metadata.variantId !== proof.variantId || metadata.prescriptionKey !== key) {
      return 'constraint_receipt_item_mismatch';
    }
    if (isGroupedEquipmentRequirements(metadata.equipment)) {
      const grouped = metadata.equipment;
      // The legacy plan has no native tuple and cannot bind this additive metadata.
      if (identityOf === undefined || variantOf === undefined || grouped.native.variantId !== variantOf(planItem) ||
        !(['repository', 'revision', 'path', 'sha256', 'nativeId'] as const)
          .every(field => grouped.native.identity[field] === identityOf(planItem)[field])) {
        return 'constraint_equipment_identity_mismatch';
      }
    }
  }
  return null;
}

/** Receipt qualification and completeness come from trusted owners, never from profile text or this adapter. */
export function evaluateFirstPlanConstraints(
  input: EvaluationInput,
  catalog: QualifiedCatalog,
  receipt: ConfirmedConstraintReceipt | null,
): ConstraintDecision {
  if (receipt === null) return unavailable(input, catalog, 'constraint_receipt_unavailable');
  try {
    receipt = copyReceiptEquipment(receipt);
    const invalid = validateReceipt(input, catalog, receipt, prescriptionKey);
    if (invalid !== null) return unavailable(input, catalog, invalid);
    return evaluateReceipt(input, catalog, receipt);
  } catch {
    return unavailable(input, catalog, 'constraint_receipt_invalid');
  }
}

function sourceEvidence(input: SourceEvaluationInput) {
  return { sourceFormat: input.format, sourcePlan: input.candidate.plan,
    comparisonMinutes: input.comparisonMinutes, comparisonBasis: 'estimated-duration-upper-bound' };
}

function sourceUnavailable(input: Binding, catalog: QualifiedCatalog, code: string,
  sourceInput?: SourceEvaluationInput): ConstraintDecision {
  return { ...unavailable(input, catalog, code),
    evidence: { schema: 'form.constraints.source-first-plan-adapter/v1', value: json({
      status: 'unavailable', gap: code, applied: false, ...(sourceInput ? sourceEvidence(sourceInput) : {}),
    }) } };
}

/** Source normalization binds content only; accepted metadata, confirmation and R1 remain independently supplied. */
export function evaluateSourceFirstPlanConstraints(
  input: SourceEvaluationInput,
  catalog: QualifiedCatalog,
  receipt: ConfirmedConstraintReceipt | null,
): ConstraintDecision {
  if (receipt === null) return sourceUnavailable(input, catalog, 'constraint_receipt_unavailable');
  let normalizedInput: SourceEvaluationInput | undefined;
  try {
    receipt = copyReceiptEquipment(receipt);
    const normalized = normalizeSourceFirstPlanInput({ context: input.context, candidate: input.candidate,
      confirmation: { accountId: receipt.accountId, profileRevision: receipt.profileRevision,
        preferencesRevision: receipt.preferencesRevision } });
    if (normalized.status === 'blocked') return sourceUnavailable(input, catalog, 'constraint_source_input_invalid');
    normalizedInput = normalized.input;
    if (!isDeepStrictEqual(input, normalizedInput)) {
      return sourceUnavailable(input, catalog, 'constraint_source_binding_mismatch', normalizedInput);
    }
    const view = {
      contextKey: normalizedInput.contextKey, candidateKey: normalizedInput.candidateKey,
      context: normalizedInput.context, prescriptions: normalizedInput.prescriptions,
      candidate: { id: normalizedInput.candidate.id, qualification: normalizedInput.candidate.qualification,
        source: normalizedInput.candidate.source, plan: {
          minutes: normalizedInput.comparisonMinutes,
          items: normalizedInput.candidate.plan.items.map(item => ({ id: item.id,
            exerciseId: item.registeredDomain.exerciseId, variantId: item.registeredDomain.variantId,
            identity: item.registeredDomain.identity,
            prescriptionKey: sourcePrescriptionKey(item) })),
        } },
    };
    const invalid = validateReceipt(view, catalog, receipt, item => item.prescriptionKey, item => item.variantId, item => item.identity);
    if (invalid !== null) return sourceUnavailable(input, catalog, invalid, normalizedInput);
    return evaluateReceipt(view, catalog, receipt, normalizedInput);
  } catch {
    return sourceUnavailable(input, catalog, 'constraint_receipt_invalid', normalizedInput);
  }
}

function copyReceiptEquipment(receipt: ConfirmedConstraintReceipt): ConfirmedConstraintReceipt {
  return { ...receipt, candidate: copyCandidateEquipment(receipt.candidate) };
}

function evaluateReceipt(input: ReceiptInput<ReceiptItem>, catalog: QualifiedCatalog,
  receipt: ConfirmedConstraintReceipt, sourceInput?: SourceEvaluationInput): ConstraintDecision {
  const request: EvaluationRequest = {
    ...receipt.snapshot,
    limits: {
      maxMinutes: input.context.preferences.sessionMinutes,
      equipment: [...new Set(input.context.preferences.equipment)],
      context: receipt.structuredContext?.value ?? null,
    },
    candidates: [{ ...receipt.candidate, minutes: input.candidate.plan.minutes }],
  };
  const evaluation = evaluateConstraints(request);
  const decision = evaluation.candidates[0]!;
  const rules: ConstraintRuleTrace[] = decision.rules
    .filter((trace) => trace.outcome !== 'not_applicable')
    .map((trace) => ({
      ruleId: trace.ruleId, itemId: trace.itemId,
      outcome: trace.outcome === 'matched' ? 'satisfied' : trace.outcome === 'unmatched' ? 'violated' : 'unknown',
      source: { ...trace.source }, reasons: trace.reasons.map(gap),
    }));
  return {
    contextKey: input.contextKey, candidateKey: input.candidateKey,
    status: decision.status, source: { ...receipt.source }, reasons: decision.reasons.map(gap), rules,
    evidence: { schema: sourceInput ? 'form.constraints.source-first-plan-adapter/v1' : 'form.constraints.first-plan-adapter/v1', value: json({
      evaluation,
      receiptSource: receipt.source,
      qualificationScope: receipt.scope,
      structuredContext: receipt.structuredContext,
      accountId: receipt.accountId,
      profileRevision: receipt.profileRevision,
      preferencesRevision: receipt.preferencesRevision,
      contextKey: input.contextKey,
      candidateKey: input.candidateKey,
      candidateSource: input.candidate.source,
      catalogSource: catalog.source,
      catalogItems: catalog.items,
      ...(sourceInput ? sourceEvidence(sourceInput) : {}),
    }) },
  };
}
