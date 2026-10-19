import type { PlanFields, PlanItem, SourcePrescriptionPlanFields, SourcePrescriptionItem, NativePrescription } from '../../schemas.js';

export type SourceReference = {
  id: string;
  revision: string;
  locator: string;
  currentness: 'current' | 'unknown' | 'superseded' | 'withdrawn';
  qualification: string;
};
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type NativeEvidence = { schema: string; value: JsonValue };
export type PlanningContext = {
  accountId: string;
  profile: {
    revision: number;
    goals: string[];
    trainingBackground: 'new' | 'returning' | 'regular' | null;
    injuryHistory: string;
    trainingContext?: string | undefined;
  };
  preferences: {
    revision: number;
    equipment: string[];
    sessionMinutes: number;
    trainingDaysPerWeek: number;
  };
};
export type ContextConfirmation = {
  accountId: string;
  profileRevision: number;
  preferencesRevision: number;
};
export type PlanCandidate = {
  id: string;
  qualification: 'qualified' | 'provisional';
  source: SourceReference;
  plan: PlanFields;
};
export type FirstPlanRequest = {
  context: PlanningContext;
  confirmation: ContextConfirmation | null;
  candidates: PlanCandidate[];
};
export type Gap = { code: string; itemId?: string | undefined; detail?: string | undefined };
export type Binding = { contextKey: string; candidateKey: string };
export type EvaluationInput = Binding & {
  context: PlanningContext;
  candidate: PlanCandidate;
  prescriptions: { itemId: string; prescriptionKey: string }[];
};
export type QualifiedCatalogItem = {
  itemId: string;
  exerciseId: string;
  variantId: string;
  prescriptionKey: string;
  retired: false;
  source: SourceReference;
};
export type CatalogDecision = Binding & { evidence?: NativeEvidence | undefined } & (
  | { status: 'qualified'; source: SourceReference; items: QualifiedCatalogItem[] }
  | { status: 'excluded' | 'unknown'; reasons: Gap[] }
);
export type QualifiedCatalog = Extract<CatalogDecision, { status: 'qualified' }>;
export type ConstraintRuleTrace = {
  ruleId: string;
  itemId?: string | undefined;
  outcome: 'satisfied' | 'violated' | 'unknown';
  source: SourceReference;
  reasons: Gap[];
};
export type ConstraintDecision = Binding & {
  status: 'eligible' | 'excluded' | 'unknown';
  source: SourceReference;
  reasons: Gap[];
  rules: ConstraintRuleTrace[];
  evidence?: NativeEvidence | undefined;
};
export type FirstPlanPorts = {
  qualifyCatalog?: (input: EvaluationInput) => CatalogDecision;
  evaluateConstraints?: (input: EvaluationInput, catalog: QualifiedCatalog) => ConstraintDecision;
};
export type CandidateTrace = {
  candidateId: string;
  candidateKey?: string;
  source?: SourceReference;
  status: 'eligible' | 'excluded' | 'unknown';
  reasons: Gap[];
  catalog?: CatalogDecision;
  constraints?: ConstraintDecision;
};
export type SelectionTrace = {
  version: 'form.first-plan-selection/v1';
  contextKey?: string;
  confirmation?: ContextConfirmation;
  selection: 'first-eligible-in-supplied-order';
  selectedCandidateId?: string;
  candidates: CandidateTrace[];
};
export type FirstPlanResult =
  | { status: 'ready'; plan: PlanFields; trace: SelectionTrace }
  | { status: 'blocked' | 'infeasible'; gaps: Gap[]; trace: SelectionTrace };

export type { PlanFields, PlanItem };

export type SourcePlanCandidate = Omit<PlanCandidate, 'plan'> & { plan: SourcePrescriptionPlanFields };
export type SourceFirstPlanRequest = Omit<FirstPlanRequest, 'candidates'> & { candidates: SourcePlanCandidate[] };
export type SourceEvaluationInput = Omit<EvaluationInput, 'candidate'> & {
  format: 'form.source-prescription-evaluation/v1';
  candidate: SourcePlanCandidate;
  comparisonMinutes: number;
};
export type SourceFirstPlanPorts = {
  qualifyCatalog?: (input: SourceEvaluationInput) => CatalogDecision;
  evaluateConstraints?: (input: SourceEvaluationInput, catalog: QualifiedCatalog) => ConstraintDecision;
};
export type SourceSelectionTrace = Omit<SelectionTrace, 'version'> & { version: 'form.source-first-plan-selection/v1' };
export type SourceFirstPlanResult =
  | { status: 'ready'; plan: SourcePrescriptionPlanFields; trace: SourceSelectionTrace }
  | { status: 'blocked' | 'infeasible'; gaps: Gap[]; trace: SourceSelectionTrace };
export type NormalizationRequest<Candidate> = {
  context: PlanningContext;
  confirmation: ContextConfirmation | null;
  candidate: Candidate;
};
export type NormalizationResult<Input> =
  | { status: 'valid'; input: Input; confirmation: ContextConfirmation }
  | { status: 'blocked'; gaps: Gap[] };
export type { SourcePrescriptionPlanFields, SourcePrescriptionItem, NativePrescription };
