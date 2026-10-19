import type {
  EvaluationInput, FirstPlanPorts, FirstPlanRequest, FirstPlanResult, NormalizationResult, PlanCandidate,
  PlanningContext, SourceEvaluationInput, SourceFirstPlanPorts, SourceFirstPlanRequest, SourceFirstPlanResult,
} from '../../../src/planning/first-plan/types.js';
import type { PlanFields } from '../../../src/schemas.js';
import { normalizeFirstPlanInput, normalizeSourceFirstPlanInput, selectFirstPlan, selectSourceFirstPlan } from '../../../src/planning/first-plan/index.js';

type Assert<Check extends true> = Check;
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
export type LegacyCandidatePlan = Assert<Equal<PlanCandidate['plan'], PlanFields>>;
export type LegacyRequestContext = Assert<Equal<FirstPlanRequest['context'], PlanningContext>>;
export type LegacySelector = Assert<Equal<typeof selectFirstPlan, (request: FirstPlanRequest, ports?: FirstPlanPorts) => FirstPlanResult>>;
export type SourceSelector = Assert<Equal<typeof selectSourceFirstPlan, (request: SourceFirstPlanRequest, ports?: SourceFirstPlanPorts) => SourceFirstPlanResult>>;
export type LegacyNormalized = Assert<Equal<ReturnType<typeof normalizeFirstPlanInput>, NormalizationResult<EvaluationInput>>>;
export type SourceNormalized = Assert<Equal<ReturnType<typeof normalizeSourceFirstPlanInput>, NormalizationResult<SourceEvaluationInput>>>;
export type SourceIsNotLegacyInput = Assert<SourceEvaluationInput extends EvaluationInput ? false : true>;
export type SourceIsNotLegacyPorts = Assert<SourceFirstPlanPorts extends FirstPlanPorts ? false : true>;
