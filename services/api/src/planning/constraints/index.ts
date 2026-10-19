import type { NativeRecordIdentity } from '../../catalog-qualification/native-identity.js';

export type Side = 'left' | 'right' | 'bilateral' | 'none' | 'unknown';
export type Currentness = 'current' | 'unknown' | 'superseded' | 'withdrawn';
export type SourceRef = Readonly<{
  id: string;
  revision: string;
  locator: string;
  currentness: Currentness;
  qualification: 'qualified' | 'accepted_instruction' | 'unreviewed' | 'hypothesis' | 'creator_assertion';
}>;
export type GroupedEquipmentRequirements = Readonly<{
  schema: 'form.equipment-requirements/v1';
  required: readonly string[];
  alternatives: readonly (readonly string[])[];
  native: Readonly<{
    identity: NativeRecordIdentity;
    variantId: string;
    qualification: 'source_native_operational_identity';
  }>;
  operationalSource: SourceRef | null;
}>;
export type EquipmentRequirements = readonly string[] | null | GroupedEquipmentRequirements;
export type EquipmentTrace = Readonly<{
  itemId: string;
  requirements: GroupedEquipmentRequirements;
  availability: readonly string[] | null;
  outcome: 'matched' | 'missing' | 'unknown' | 'not_evaluated';
  missingRequired: readonly string[];
  missingAlternativeGroups: readonly (readonly string[])[];
  alternativeGroups: readonly Readonly<{ members: readonly string[]; availableMembers: readonly string[] }>[];
}>;
export type RevisionSet = Readonly<{ context: string; catalog: string; rules: string; preflight: string }>;
export type TrainingState = 'urgent' | 'same_day' | 'clinical_review' | 'safety_unknown' |
  'clinician_plan' | 'adapted' | 'self_directed';
export type RegionRoute = 'emergency' | 'urgent_assessment' | 'clinician_routed' |
  'unknown' | 'screened_self_management';
export type RestrictionCoverage = Readonly<{
  complete: boolean;
  ruleIds: readonly string[];
  instructions: readonly Readonly<{
    factId: string;
    disposition: 'mapped' | 'explicit_no_limits';
    ruleIds: readonly string[];
  }>[];
}>;
export type Preflight = Readonly<{
  complete: boolean;
  trainingState: TrainingState;
  source: SourceRef;
  regions: readonly Readonly<{ region: string; side: Side; route: RegionRoute }>[];
  restrictionCoverage: RestrictionCoverage;
}>;
export type ContextFact = Readonly<{
  id: string;
  revision: string;
  kind: 'user_reported_history' | 'clinician_instruction_as_reported' | 'user_exclusion';
  region: string;
  side: Side;
  resolution: 'confirmed' | 'unknown' | 'declined' | 'conflicting';
  source: SourceRef;
}>;
export type DemandValue = number | string | boolean;
export type Demand = Readonly<{
  key: string;
  region: string;
  side: Side;
  value: DemandValue | null;
  unit: string;
  source: SourceRef;
}>;
export type DemandTest = Readonly<{
  key: string;
  region: string;
  side: Side;
  unit: string;
}> & (Readonly<{ operator: 'equals'; value: DemandValue }> |
  Readonly<{ operator: 'at_most' | 'at_least'; value: number }>);
export type ConstraintRule = Readonly<{
  id: string;
  revision: string;
  origin: 'qualified_rule' | 'clinician_instruction' | 'user_exclusion';
  source: SourceRef;
  factIds: readonly string[];
  variantIds: readonly string[] | 'all';
  effect: Readonly<{ kind: 'exclude' }> | Readonly<{ kind: 'require_demand'; test: DemandTest }>;
}>;
export type CandidateItem = Readonly<{
  id: string;
  exerciseId: string;
  variantId: string;
  prescriptionKey: string;
  equipment: EquipmentRequirements;
  contexts: readonly string[] | 'any' | null;
  purposes: readonly string[];
  demands: readonly Demand[];
}>;
export type CandidatePlan = Readonly<{
  id: string;
  minutes: number | null;
  source: SourceRef;
  items: readonly CandidateItem[];
}>;
export type LockedItem = Readonly<{ itemId: string; variantId: string; prescriptionKey: string }>;
export type SoftPreference = Readonly<{
  id: string;
  kind: 'favorite' | 'progression';
  variantIds: readonly string[];
}>;
export type EvaluationRequest = Readonly<{
  binding: RevisionSet;
  current: RevisionSet;
  preflight: Preflight;
  facts: readonly ContextFact[];
  requiredFactIds: readonly string[];
  rules: readonly ConstraintRule[];
  limits: Readonly<{
    maxMinutes: number | 'unrestricted' | null;
    equipment: readonly string[] | null;
    context: string | null;
  }>;
  purposes: Readonly<{ required: readonly string[]; preferred: readonly string[] }>;
  locks: readonly LockedItem[];
  preferences: readonly SoftPreference[];
  candidates: readonly CandidatePlan[];
  baseline: CandidatePlan | null;
}>;
export type Reason = Readonly<{
  code: string;
  refId: string;
  itemId: string | null;
  detail: string;
}>;
export type RuleTrace = Readonly<{
  ruleId: string;
  ruleRevision: string;
  itemId: string;
  outcome: 'matched' | 'unmatched' | 'unknown' | 'not_applicable';
  source: SourceRef;
  facts: readonly Readonly<{ id: string; revision: string }>[];
  demandSources: readonly SourceRef[];
  reasons: readonly Reason[];
}>;
export type Comparison = Readonly<{
  minutes: number | null;
  minutesDelta: number | null;
  preservedPurposes: readonly string[];
  lostPurposes: readonly string[];
  addedPurposes: readonly string[];
  missingPreferredPurposes: readonly string[];
  removedItemIds: readonly string[];
  changedItemIds: readonly string[];
  addedItemIds: readonly string[];
  preferences: readonly Readonly<{ id: string; kind: SoftPreference['kind']; satisfied: boolean }>[];
}>;
export type CandidateDecision = Readonly<{
  candidateId: string;
  status: 'eligible' | 'excluded' | 'unknown';
  reasons: readonly Reason[];
  rules: readonly RuleTrace[];
  equipmentTrace?: readonly EquipmentTrace[];
  comparison: Comparison | null;
}>;
export type Evaluation = Readonly<{
  status: 'eligible' | 'infeasible' | 'unavailable';
  binding: RevisionSet;
  routing: Preflight;
  reasons: readonly Reason[];
  candidates: readonly CandidateDecision[];
  eligibleCandidateIds: readonly string[];
  applied: false;
}>;

const sides: readonly Side[] = ['left', 'right', 'bilateral', 'none', 'unknown'];
const states: readonly TrainingState[] = ['urgent', 'same_day', 'clinical_review', 'safety_unknown',
  'clinician_plan', 'adapted', 'self_directed'];
const routes: readonly RegionRoute[] = ['emergency', 'urgent_assessment', 'clinician_routed',
  'unknown', 'screened_self_management'];
const currentness: readonly Currentness[] = ['current', 'unknown', 'superseded', 'withdrawn'];
const qualifications: readonly SourceRef['qualification'][] = ['qualified', 'accepted_instruction',
  'unreviewed', 'hypothesis', 'creator_assertion'];

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function demandValue(value: unknown): value is DemandValue {
  return typeof value === 'boolean' || nonempty(value) ||
    (typeof value === 'number' && Number.isFinite(value));
}

function requireInput(condition: unknown, field: string): asserts condition {
  if (!condition) throw new TypeError(`Invalid constraint input: ${field}`);
}

function strings(value: readonly string[], field: string, allowEmpty = true): void {
  requireInput(Array.isArray(value) && (allowEmpty || value.length > 0) &&
    value.every(nonempty) && new Set(value).size === value.length, field);
}

function uniqueIds(values: readonly { id: string }[], field: string): void {
  requireInput(Array.isArray(values), field);
  strings(values.map((value) => value.id), field);
}

function validateSource(source: SourceRef): void {
  requireInput(source && nonempty(source.id) && nonempty(source.revision) && nonempty(source.locator) &&
    currentness.includes(source.currentness) && qualifications.includes(source.qualification), 'source');
}

function closedData(value: unknown, keys: readonly string[], field: string): Record<string, unknown> {
  requireInput(value !== null && typeof value === 'object' && !Array.isArray(value), field);
  const prototype = Object.getPrototypeOf(value);
  requireInput(prototype === Object.prototype || prototype === null, field);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const actual = Reflect.ownKeys(value);
  requireInput(actual.length === keys.length && actual.every(key => typeof key === 'string' && keys.includes(key)), field);
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = descriptors[key];
    requireInput(descriptor && 'value' in descriptor && descriptor.enumerable, field);
    result[key] = descriptor.value;
  }
  return result;
}

function denseData(value: unknown, field: string): unknown[] {
  requireInput(Array.isArray(value) && value.length <= 1000 && Object.getPrototypeOf(value) === Array.prototype, field);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  requireInput(Reflect.ownKeys(value).length === value.length + 1, field);
  const result: unknown[] = [];
  for (let index = 0; index < value.length; index++) {
    const descriptor = descriptors[String(index)];
    requireInput(descriptor && 'value' in descriptor && descriptor.enumerable, field);
    result.push(descriptor.value);
  }
  return result;
}

function exactText(value: unknown, field: string): string {
  requireInput(typeof value === 'string' && value.length > 0 && value.length <= 512 &&
    value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value), field);
  return value;
}

function equipmentStrings(value: unknown, field: string): string[] {
  const result = denseData(value, field).map(member => exactText(member, field));
  requireInput(new Set(result).size === result.length, field);
  return result;
}

function freezeOwned<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freezeOwned(child);
    Object.freeze(value);
  }
  return value;
}

/** Copies closed data before use; this shape check grants no operational authority. */
export function copyGroupedEquipmentRequirements(value: unknown): GroupedEquipmentRequirements {
  const row = closedData(value, ['schema', 'required', 'alternatives', 'native', 'operationalSource'], 'equipment');
  requireInput(row.schema === 'form.equipment-requirements/v1', 'equipment.schema');
  const required = equipmentStrings(row.required, 'equipment.required');
  const alternatives = denseData(row.alternatives, 'equipment.alternatives')
    .map(group => equipmentStrings(group, 'equipment.alternatives.group'));
  requireInput(alternatives.every(group => group.length >= 2), 'equipment.alternatives.group');
  const signatures = alternatives.map(group => JSON.stringify([...group].sort()));
  const members = alternatives.flat();
  requireInput(new Set(signatures).size === signatures.length && new Set(members).size === members.length &&
    members.every(member => !required.includes(member)), 'equipment.overlap');
  const native = closedData(row.native, ['identity', 'variantId', 'qualification'], 'equipment.native');
  const identity = closedData(native.identity, ['repository', 'revision', 'path', 'sha256', 'nativeId'], 'equipment.identity');
  const ownedIdentity = {
    repository: exactText(identity.repository, 'equipment.identity.repository'),
    revision: exactText(identity.revision, 'equipment.identity.revision'),
    path: exactText(identity.path, 'equipment.identity.path'),
    sha256: exactText(identity.sha256, 'equipment.identity.sha256'),
    nativeId: exactText(identity.nativeId, 'equipment.identity.nativeId'),
  };
  requireInput(/^[a-f0-9]{64}$/u.test(ownedIdentity.sha256) && ownedIdentity.nativeId.length <= 80 &&
    /^[a-zA-Z0-9_-]+$/u.test(ownedIdentity.nativeId), 'equipment.identity');
  const variantId = exactText(native.variantId, 'equipment.variantId');
  requireInput(variantId === `movement-engine:${ownedIdentity.revision}:${ownedIdentity.nativeId}` &&
    native.qualification === 'source_native_operational_identity', 'equipment.native');
  let operationalSource: SourceRef | null = null;
  if (row.operationalSource !== null) {
    const source = closedData(row.operationalSource, ['id', 'revision', 'locator', 'currentness', 'qualification'], 'equipment.operationalSource');
    operationalSource = {
      id: exactText(source.id, 'equipment.operationalSource.id'),
      revision: exactText(source.revision, 'equipment.operationalSource.revision'),
      locator: exactText(source.locator, 'equipment.operationalSource.locator'),
      currentness: source.currentness as Currentness,
      qualification: source.qualification as SourceRef['qualification'],
    };
    validateSource(operationalSource);
  }
  return freezeOwned<GroupedEquipmentRequirements>({ schema: 'form.equipment-requirements/v1', required, alternatives,
    native: { identity: ownedIdentity, variantId, qualification: 'source_native_operational_identity' }, operationalSource });
}

export function isGroupedEquipmentRequirements(value: EquipmentRequirements): value is GroupedEquipmentRequirements {
  return value !== null && !Array.isArray(value);
}

export function copyCandidateEquipment(candidate: CandidatePlan): CandidatePlan {
  return { ...candidate, items: candidate.items.map(item => {
    const descriptor = Object.getOwnPropertyDescriptor(item, 'equipment');
    requireInput(descriptor && 'value' in descriptor && descriptor.enumerable, 'item.equipment');
    const equipment = descriptor.value as EquipmentRequirements;
    return { ...item, equipment: isGroupedEquipmentRequirements(equipment)
      ? copyGroupedEquipmentRequirements(equipment) : equipment };
  }) };
}

function validateCandidate(candidate: CandidatePlan): void {
  requireInput(nonempty(candidate.id) && (candidate.minutes === null ||
    (Number.isFinite(candidate.minutes) && candidate.minutes > 0)), 'candidate');
  validateSource(candidate.source);
  uniqueIds(candidate.items, 'candidate.items');
  for (const item of candidate.items) {
    requireInput(nonempty(item.exerciseId) && nonempty(item.variantId) && nonempty(item.prescriptionKey), 'item');
    if (item.equipment !== null && !isGroupedEquipmentRequirements(item.equipment)) strings(item.equipment, 'item.equipment');
    if (item.contexts !== null && item.contexts !== 'any') strings(item.contexts, 'item.contexts', false);
    strings(item.purposes, 'item.purposes');
    requireInput(Array.isArray(item.demands), 'item.demands');
    for (const demand of item.demands) {
      requireInput(nonempty(demand.key) && nonempty(demand.region) && sides.includes(demand.side) &&
        nonempty(demand.unit) && (demand.value === null || demandValue(demand.value)), 'demand');
      validateSource(demand.source);
    }
  }
}

function validate(request: EvaluationRequest): void {
  for (const key of ['context', 'catalog', 'rules', 'preflight'] as const) {
    requireInput(nonempty(request.binding[key]) && nonempty(request.current[key]), `binding.${key}`);
  }
  requireInput(typeof request.preflight.complete === 'boolean' &&
    states.includes(request.preflight.trainingState), 'preflight');
  validateSource(request.preflight.source);
  requireInput(Array.isArray(request.preflight.regions), 'preflight.regions');
  for (const region of request.preflight.regions) {
    requireInput(nonempty(region.region) && sides.includes(region.side) && routes.includes(region.route), 'region');
  }
  const coverage = request.preflight.restrictionCoverage;
  requireInput(typeof coverage.complete === 'boolean', 'restrictionCoverage.complete');
  strings(coverage.ruleIds, 'restrictionCoverage.ruleIds');
  requireInput(Array.isArray(coverage.instructions), 'restrictionCoverage.instructions');
  strings(coverage.instructions.map((entry) => entry.factId), 'restrictionCoverage.factIds');
  for (const entry of coverage.instructions) {
    requireInput(entry.disposition === 'mapped' || entry.disposition === 'explicit_no_limits', 'instruction.disposition');
    strings(entry.ruleIds, 'instruction.ruleIds', entry.disposition === 'explicit_no_limits');
    requireInput(entry.disposition !== 'explicit_no_limits' || entry.ruleIds.length === 0, 'instruction.noLimits');
  }
  uniqueIds(request.facts, 'facts');
  for (const fact of request.facts) {
    requireInput(nonempty(fact.revision) && nonempty(fact.region) && sides.includes(fact.side) &&
      ['user_reported_history', 'clinician_instruction_as_reported', 'user_exclusion'].includes(fact.kind) &&
      ['confirmed', 'unknown', 'declined', 'conflicting'].includes(fact.resolution), 'fact');
    validateSource(fact.source);
  }
  strings(request.requiredFactIds, 'requiredFactIds');
  uniqueIds(request.rules, 'rules');
  for (const rule of request.rules) {
    requireInput(nonempty(rule.revision) &&
      ['qualified_rule', 'clinician_instruction', 'user_exclusion'].includes(rule.origin), 'rule');
    validateSource(rule.source);
    strings(rule.factIds, 'rule.factIds');
    if (rule.variantIds !== 'all') strings(rule.variantIds, 'rule.variantIds', false);
    requireInput(rule.effect.kind === 'exclude' || rule.effect.kind === 'require_demand', 'rule.effect');
    if (rule.effect.kind === 'require_demand') {
      const predicate = rule.effect.test;
      requireInput(nonempty(predicate.key) && nonempty(predicate.region) && sides.includes(predicate.side) &&
        nonempty(predicate.unit) && ['equals', 'at_most', 'at_least'].includes(predicate.operator) &&
        demandValue(predicate.value) && (predicate.operator === 'equals' ||
          typeof predicate.value === 'number'), 'rule.test');
    }
  }
  const maximum = request.limits.maxMinutes;
  requireInput(maximum === null || maximum === 'unrestricted' ||
    (typeof maximum === 'number' && Number.isFinite(maximum) && maximum >= 0), 'limits.maxMinutes');
  if (request.limits.equipment !== null) strings(request.limits.equipment, 'limits.equipment');
  requireInput(request.limits.context === null || nonempty(request.limits.context), 'limits.context');
  strings(request.purposes.required, 'purposes.required');
  strings(request.purposes.preferred, 'purposes.preferred');
  requireInput(Array.isArray(request.locks), 'locks');
  strings(request.locks.map((lock) => lock.itemId), 'locks.itemId');
  for (const lock of request.locks) {
    requireInput(nonempty(lock.variantId) && nonempty(lock.prescriptionKey), 'lock');
  }
  uniqueIds(request.preferences, 'preferences');
  for (const preference of request.preferences) {
    requireInput(preference.kind === 'favorite' || preference.kind === 'progression', 'preference.kind');
    strings(preference.variantIds, 'preference.variantIds', false);
  }
  uniqueIds(request.candidates, 'candidates');
  for (const candidate of request.candidates) validateCandidate(candidate);
  if (request.baseline !== null) validateCandidate(request.baseline);
}

function reason(code: string, refId: string, detail: string, itemId: string | null = null): Reason {
  return { code, refId, itemId, detail };
}

function qualified(source: SourceRef): boolean {
  return source.currentness === 'current' && source.qualification === 'qualified';
}

function sameEquipmentSource(left: SourceRef, right: SourceRef): boolean {
  return (['id', 'revision', 'locator', 'currentness', 'qualification'] as const)
    .every(key => left[key] === right[key]);
}

function equipmentTrace(item: CandidateItem, candidate: CandidatePlan, availability: readonly string[] | null,
  blocked = false): EquipmentTrace {
  const requirements = item.equipment as GroupedEquipmentRequirements;
  const trace = { itemId: item.id, requirements, availability,
    missingRequired: [] as string[], missingAlternativeGroups: [] as (readonly string[])[],
    alternativeGroups: requirements.alternatives.map(members => ({ members, availableMembers: [] as string[] })) };
  if (blocked) return { ...trace, outcome: 'not_evaluated' };
  const source = requirements.operationalSource;
  if (source === null || !qualified(source) || !qualified(candidate.source) ||
    !sameEquipmentSource(source, candidate.source) || requirements.native.variantId !== item.variantId ||
    (availability === null && (requirements.required.length > 0 || requirements.alternatives.length > 0))) {
    return { ...trace, outcome: 'unknown' };
  }
  const missingRequired = requirements.required.filter(member => !availability?.includes(member));
  const missingAlternativeGroups = requirements.alternatives.filter(group => !group.some(member => availability?.includes(member)));
  const alternativeGroups = requirements.alternatives.map(members => ({ members,
    availableMembers: members.filter(member => availability?.includes(member)) }));
  return { ...trace, missingRequired, missingAlternativeGroups, alternativeGroups,
    outcome: missingRequired.length > 0 || missingAlternativeGroups.length > 0 ? 'missing' : 'matched' };
}

function sideCovered(actual: Side, needed: Side): boolean {
  return actual === needed || (actual === 'bilateral' && (needed === 'left' || needed === 'right'));
}

function requiredSides(side: Side): readonly Side[] {
  return side === 'bilateral' ? ['left', 'right'] : [side];
}

function preflightReasons(request: EvaluationRequest): Reason[] {
  const reasons: Reason[] = [];
  for (const key of ['context', 'catalog', 'rules', 'preflight'] as const) {
    if (request.binding[key] !== request.current[key]) {
      reasons.push(reason('stale_binding', key, `${key} revision changed; reevaluate from current inputs.`));
    }
  }
  const preflight = request.preflight;
  if (!preflight.complete || !qualified(preflight.source)) {
    reasons.push(reason('preflight_unavailable', preflight.source.id, 'A complete current qualified R1 preflight is required.'));
  }
  if (!['self_directed', 'adapted', 'clinician_plan'].includes(preflight.trainingState)) {
    reasons.push(reason('training_route_blocks', preflight.trainingState, 'The supplied R1 route does not permit generic training.'));
  }
  for (const region of preflight.regions) {
    if (region.side === 'unknown' || !['screened_self_management', 'clinician_routed'].includes(region.route)) {
      reasons.push(reason('regional_route_blocks', region.region, `Unresolved or blocking regional route: ${region.route}.`));
    }
  }
  const facts = new Map(request.facts.map((fact) => [fact.id, fact]));
  const coverage = preflight.restrictionCoverage;
  if (!coverage.complete || coverage.ruleIds.length !== request.rules.length ||
    !coverage.ruleIds.every((id) => request.rules.some((rule) => rule.id === id))) {
    reasons.push(reason('restriction_coverage_incomplete', 'preflight', 'The complete accepted restriction inventory must match the supplied rules.'));
  }
  for (const instruction of coverage.instructions) {
    const fact = facts.get(instruction.factId);
    const expectedOrigin = fact?.kind === 'user_exclusion' ? 'user_exclusion' : 'clinician_instruction';
    if (!fact || fact.kind === 'user_reported_history' ||
      (instruction.disposition === 'explicit_no_limits' && fact.kind !== 'clinician_instruction_as_reported') ||
      !instruction.ruleIds.every((id) => request.rules.some((rule) =>
        rule.id === id && rule.origin === expectedOrigin && rule.factIds.includes(instruction.factId)))) {
      reasons.push(reason('instruction_coverage_invalid', instruction.factId, 'Individual instruction coverage is missing or does not match its accepted rules.'));
    }
  }
  for (const fact of request.facts.filter((fact) => fact.kind !== 'user_reported_history')) {
    const entry = coverage.instructions.find((entry) => entry.factId === fact.id);
    if (!entry || request.rules.some((rule) => rule.origin !== 'qualified_rule' &&
      rule.factIds.includes(fact.id) && !entry.ruleIds.includes(rule.id))) {
      reasons.push(reason('instruction_coverage_missing', fact.id, 'An individual instruction lacks a complete accepted mapping.'));
    }
  }
  const clinicianRouted = preflight.trainingState === 'clinician_plan' ||
    preflight.regions.some((region) => region.route === 'clinician_routed');
  if (clinicianRouted && !coverage.instructions.some((entry) =>
    facts.get(entry.factId)?.kind === 'clinician_instruction_as_reported')) {
    reasons.push(reason('clinician_instructions_missing', 'preflight', 'Clinician routing requires retained current individual guidance.'));
  }
  for (const region of preflight.regions.filter((region) => region.route === 'clinician_routed')) {
    if (!requiredSides(region.side).every((side) => coverage.instructions.some((entry) => {
      const fact = facts.get(entry.factId);
      return fact?.kind === 'clinician_instruction_as_reported' && fact.region === region.region &&
        sideCovered(fact.side, side);
    }))) {
      reasons.push(reason('clinician_instructions_missing', region.region,
        'Clinician guidance does not cover this routed region and side.'));
    }
  }
  const requiredIds = new Set([...request.requiredFactIds, ...request.rules.flatMap((rule) => rule.factIds),
    ...coverage.instructions.map((entry) => entry.factId)]);
  for (const id of requiredIds) {
    const fact = facts.get(id);
    if (!fact || fact.resolution !== 'confirmed' || fact.source.currentness !== 'current' || fact.side === 'unknown') {
      reasons.push(reason('required_fact_unknown', id, 'A required fact is missing, unresolved, withdrawn or stale.'));
      continue;
    }
    if (!['qualified', 'accepted_instruction'].includes(fact.source.qualification)) {
      reasons.push(reason('fact_not_accepted', id, 'Unreviewed assertions cannot satisfy required context.'));
    }
    if (fact.region !== 'none' && !requiredSides(fact.side).every((side) => preflight.regions.some((region) =>
      region.region === fact.region && sideCovered(region.side, side)))) {
      reasons.push(reason('regional_preflight_missing', id, 'Preflight does not cover the required region and side.'));
    }
  }
  for (const rule of request.rules) {
    const sourceAccepted = rule.origin === 'qualified_rule'
      ? qualified(rule.source)
      : rule.source.currentness === 'current' && rule.source.qualification === 'accepted_instruction';
    if (!sourceAccepted) {
      reasons.push(reason('rule_not_qualified_current', rule.id, 'Operational restrictions require accepted current provenance.'));
    }
    if (rule.origin !== 'qualified_rule' && rule.factIds.length === 0) {
      reasons.push(reason('instruction_fact_missing', rule.id, 'An accepted instruction must retain its individual fact.'));
    }
    if (rule.origin !== 'qualified_rule' && !rule.factIds.some((id) =>
      facts.get(id)?.kind === (rule.origin === 'clinician_instruction'
        ? 'clinician_instruction_as_reported' : 'user_exclusion'))) {
      reasons.push(reason('instruction_origin_mismatch', rule.id, 'The instruction lacks a fact of the declared origin.'));
    }
    if (rule.effect.kind === 'require_demand' && rule.effect.test.side === 'unknown') {
      reasons.push(reason('rule_laterality_unknown', rule.id, 'The supplied restriction has unresolved laterality.'));
    }
  }
  return reasons;
}

function evaluateRule(rule: ConstraintRule, item: CandidateItem, facts: readonly ContextFact[]): RuleTrace {
  const trace = {
    ruleId: rule.id, ruleRevision: rule.revision, itemId: item.id, source: rule.source,
    facts: rule.factIds.map((id) => {
      const fact = facts.find((value) => value.id === id)!;
      return { id: fact.id, revision: fact.revision };
    }),
    demandSources: [] as SourceRef[], reasons: [] as Reason[],
  };
  if (rule.variantIds !== 'all' && !rule.variantIds.includes(item.variantId)) {
    return { ...trace, outcome: 'not_applicable' };
  }
  if (rule.effect.kind === 'exclude') {
    trace.reasons.push(reason('explicit_exclusion', rule.id, 'The accepted restriction excludes this variant.', item.id));
    return { ...trace, outcome: 'unmatched' };
  }
  const predicate = rule.effect.test;
  let unknown = false;
  let failed = false;
  for (const side of requiredSides(predicate.side)) {
    const cells = item.demands.filter((demand) => demand.key === predicate.key &&
      demand.region === predicate.region && sideCovered(demand.side, side));
    trace.demandSources.push(...cells.map((cell) => cell.source));
    const cell = cells[0];
    if (cells.length !== 1 || !cell || cell.value === null || !qualified(cell.source) ||
      cell.unit !== predicate.unit || typeof cell.value !== typeof predicate.value) {
      unknown = true;
      trace.reasons.push(reason('demand_unknown', rule.id,
        `Missing, ambiguous, unqualified or incompatible ${predicate.key} demand for ${side}.`, item.id));
      continue;
    }
    const matches = predicate.operator === 'equals' ? cell.value === predicate.value :
      predicate.operator === 'at_most' ? (cell.value as number) <= predicate.value :
        (cell.value as number) >= predicate.value;
    if (!matches) {
      failed = true;
      trace.reasons.push(reason('demand_mismatch', rule.id, `Demand does not satisfy the accepted ${side} restriction.`, item.id));
    }
  }
  return { ...trace, outcome: failed ? 'unmatched' : unknown ? 'unknown' : 'matched' };
}

function purposes(candidate: CandidatePlan): string[] {
  return [...new Set(candidate.items.flatMap((item) => item.purposes))];
}

function compare(candidate: CandidatePlan, request: EvaluationRequest): Comparison {
  const before = request.baseline;
  const previousPurposes = before === null ? [] : purposes(before);
  const nextPurposes = purposes(candidate);
  const previousItems = new Map(before?.items.map((item) => [item.id, item]) ?? []);
  const nextItems = new Map(candidate.items.map((item) => [item.id, item]));
  return {
    minutes: candidate.minutes,
    minutesDelta: before?.minutes != null && candidate.minutes !== null ? candidate.minutes - before.minutes : null,
    preservedPurposes: previousPurposes.filter((purpose) => nextPurposes.includes(purpose)),
    lostPurposes: previousPurposes.filter((purpose) => !nextPurposes.includes(purpose)),
    addedPurposes: nextPurposes.filter((purpose) => !previousPurposes.includes(purpose)),
    missingPreferredPurposes: request.purposes.preferred.filter((purpose) => !nextPurposes.includes(purpose)),
    removedItemIds: [...previousItems.keys()].filter((id) => !nextItems.has(id)),
    changedItemIds: candidate.items.filter((item) => {
      const previous = previousItems.get(item.id);
      return previous && (item.variantId !== previous.variantId || item.prescriptionKey !== previous.prescriptionKey);
    }).map((item) => item.id),
    addedItemIds: candidate.items.filter((item) => !previousItems.has(item.id)).map((item) => item.id),
    preferences: request.preferences.map((preference) => ({
      id: preference.id, kind: preference.kind,
      satisfied: candidate.items.some((item) => preference.variantIds.includes(item.variantId)),
    })),
  };
}

function evaluateCandidate(candidate: CandidatePlan, request: EvaluationRequest): CandidateDecision {
  const exclusions: Reason[] = [];
  const unknowns: Reason[] = [];
  const equipmentTraces: EquipmentTrace[] = [];
  if (!qualified(candidate.source)) {
    unknowns.push(reason('candidate_not_qualified_current', candidate.id, 'The candidate catalog and prescription provenance is not current and qualified.'));
  }
  if (candidate.items.length === 0) {
    exclusions.push(reason('empty_plan', candidate.id, 'An empty plan is not a training alternative.'));
  }
  const maximum = request.limits.maxMinutes;
  if (maximum === null || (maximum !== 'unrestricted' && candidate.minutes === null)) {
    unknowns.push(reason('time_unknown', candidate.id, 'The time budget or required duration is unknown.'));
  } else if (maximum !== 'unrestricted' && candidate.minutes !== null && candidate.minutes > maximum) {
    exclusions.push(reason('time_exceeded', candidate.id, 'The candidate exceeds the accepted time budget.'));
  }
  for (const item of candidate.items) {
    if (isGroupedEquipmentRequirements(item.equipment)) {
      const trace = equipmentTrace(item, candidate, request.limits.equipment);
      equipmentTraces.push(trace);
      if (trace.outcome === 'unknown') {
        unknowns.push(reason('equipment_unknown', candidate.id, 'Grouped equipment identity, acceptance or availability is unknown.', item.id));
      } else if (trace.outcome === 'missing') {
        exclusions.push(reason('equipment_missing', candidate.id, 'Required equipment or an entire alternative group is unavailable.', item.id));
      }
    } else if (item.equipment === null || (item.equipment.length > 0 && request.limits.equipment === null)) {
      unknowns.push(reason('equipment_unknown', candidate.id, 'Equipment availability or requirements are unknown.', item.id));
    } else if (item.equipment.some((equipment) => !request.limits.equipment?.includes(equipment))) {
      exclusions.push(reason('equipment_missing', candidate.id, 'Required equipment is unavailable.', item.id));
    }
    if (item.contexts === null || (item.contexts !== 'any' && request.limits.context === null)) {
      unknowns.push(reason('context_unknown', candidate.id, 'Exercise context compatibility is unknown.', item.id));
    } else if (item.contexts !== 'any' && !item.contexts.includes(request.limits.context!)) {
      exclusions.push(reason('context_mismatch', candidate.id, 'The variant is not qualified for the accepted context.', item.id));
    }
  }
  const candidatePurposes = purposes(candidate);
  for (const purpose of request.purposes.required) {
    if (!candidatePurposes.includes(purpose)) {
      exclusions.push(reason('required_purpose_missing', purpose, 'The candidate does not retain a locked purpose.'));
    }
  }
  for (const lock of request.locks) {
    const item = candidate.items.find((value) => value.id === lock.itemId);
    if (!item || item.variantId !== lock.variantId || item.prescriptionKey !== lock.prescriptionKey) {
      exclusions.push(reason('lock_conflict', lock.itemId, 'The candidate removes or changes a locked item, variant or prescription.', lock.itemId));
    }
  }
  const traces = request.rules.flatMap((rule) => candidate.items.map((item) => evaluateRule(rule, item, request.facts)));
  for (const trace of traces) {
    if (trace.outcome === 'unmatched') exclusions.push(...trace.reasons);
    else if (trace.outcome === 'unknown') unknowns.push(...trace.reasons);
  }
  return {
    candidateId: candidate.id,
    status: exclusions.length > 0 ? 'excluded' : unknowns.length > 0 ? 'unknown' : 'eligible',
    reasons: [...exclusions, ...unknowns], rules: traces, comparison: compare(candidate, request),
    ...(equipmentTraces.length ? { equipmentTrace: equipmentTraces } : {}),
  };
}

/** Trusted, current, owner-qualified inputs only; this is neither R1 screening nor clinical qualification. */
export function evaluateConstraints(request: EvaluationRequest): Evaluation {
  request = { ...request, candidates: request.candidates.map(copyCandidateEquipment),
    baseline: request.baseline === null ? null : copyCandidateEquipment(request.baseline) };
  if (request.candidates.some(candidate => candidate.items.some(item => isGroupedEquipmentRequirements(item.equipment))) &&
    request.limits.equipment !== null) {
    request = { ...request, limits: { ...request.limits,
      equipment: freezeOwned(equipmentStrings(request.limits.equipment, 'limits.equipment')) } };
  }
  validate(request);
  const reasons = preflightReasons(request);
  const blocked = reasons.length > 0;
  const candidates: CandidateDecision[] = blocked
    ? request.candidates.map((candidate) => {
      const traces = candidate.items.filter(item => isGroupedEquipmentRequirements(item.equipment))
        .map(item => equipmentTrace(item, candidate, request.limits.equipment, true));
      return { candidateId: candidate.id, status: 'unknown' as const, reasons: [...reasons], rules: [], comparison: null,
        ...(traces.length ? { equipmentTrace: traces } : {}) };
    })
    : request.candidates.map((candidate) => evaluateCandidate(candidate, request));
  const eligibleCandidateIds = candidates.filter((candidate) => candidate.status === 'eligible')
    .map((candidate) => candidate.candidateId);
  const status = blocked ? 'unavailable' : eligibleCandidateIds.length > 0 ? 'eligible' :
    candidates.some((candidate) => candidate.status === 'unknown') ? 'unavailable' : 'infeasible';
  if (!blocked && candidates.length === 0) {
    reasons.push(reason('no_candidates', 'catalog', 'No qualified alternatives were supplied; restrictions remain in force.'));
  } else if (status === 'infeasible') {
    reasons.push(reason('no_feasible_candidate', 'constraints', 'Every supplied alternative conflicts with accepted limitations.'));
  }
  return structuredClone({
    status, binding: request.binding, routing: request.preflight, reasons, candidates, eligibleCandidateIds, applied: false,
  });
}
