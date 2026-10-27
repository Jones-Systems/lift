import type { Witness } from '../runtime-modules/currentness.js';
import type { DisableRecord } from './types.js';

export type CompletionIdentity = Pick<DisableRecord, 'requestId' | 'accountId' | 'authUserId' | 'epoch' | 'sequence'>;
export type CompletionCheckpoint = Readonly<Pick<Witness,
  'authorityId' | 'ledgerSchemaDigest' | 'revision' | 'committedSequence' | 'committedHeadDigest'>>;
export type CompletionBinding = CompletionIdentity & Readonly<{
  databaseGeneration: string; schemaDigest: string; cohort: string; checkpoint: CompletionCheckpoint;
}>;
export type CompletionTarget =
  | Readonly<{ kind: 'category'; category: string }>
  | Readonly<{ kind: 'provider'; provider: string; clientDigest: string; subjectDigest: string; referenceVersion: string }>
  | Readonly<{ kind: 'backup'; inventoryDigest: string; policyVersion: string }>;
export type CompletionWitness =
  | Readonly<{ kind: 'local_purge_readback'; evidenceDigest: string; observedAtMs: number }>
  | Readonly<{ kind: 'provider_revocation_acknowledgment'; evidenceDigest: string; observedAtMs: number }>
  | Readonly<{ kind: 'backup_disposition'; disposition: 'destruction_witnessed' | 'expiry_witnessed';
    evidenceDigest: string; observedAtMs: number; inventoryWitnessDigest: string }>;
export type EvidenceStatus = 'missing' | 'unknown' | 'pending' | 'unavailable' | 'retained' | 'not_qualifying' | 'conflicting' | 'qualifying';
export type CompletionFact = Readonly<{
  operationId: string; binding: CompletionBinding; target: CompletionTarget; resolves: readonly string[];
}> & (
  | Readonly<{ status: 'qualifying'; witness: CompletionWitness }>
  | Readonly<{ status: Exclude<EvidenceStatus, 'missing' | 'qualifying'>; witness: null }>
);
export type CompletionHistory = Readonly<{ identity: CompletionIdentity; facts: readonly CompletionFact[] }>;
// Input observations require a future qualified snapshot adapter and final recheck. They cannot substitute for LocalPurgeAuthority.
export type CompletionContext = Readonly<{
  binding: CompletionBinding;
  request: 'present' | 'missing' | 'unknown' | 'conflicting';
  authority:
    | Readonly<{ status: 'qualified_current'; suppression: DisableRecord }>
    | Readonly<{ status: 'unknown' | 'unavailable' | 'pending' | 'conflicting' }>;
  requirements: readonly CompletionTarget[];
}>;
export type CompletionCalculation = Readonly<{
  scope: 'declared_targets_only'; binding: CompletionBinding; eligibility: EvidenceStatus;
  hold: 'request_missing_restore_held' | 'request_unknown' | 'identity_conflict' | 'authority_unqualified' | 'evidence_conflict' | null;
  targets: readonly Readonly<{ target: CompletionTarget; status: EvidenceStatus; operationIds: readonly string[] }>[];
  historicalFactCount: number; staleFactCount: number;
  wholeAccountDeviceProviderErasure: 'unproven'; identityAnchors: 'retained';
}>;

const digest = /^[a-f0-9]{64}$/;
const id = /^[A-Za-z0-9_.:-]{1,256}$/;
const validId = (value: unknown): boolean => typeof value === 'string' && id.test(value);
const statuses = ['unknown', 'pending', 'unavailable', 'retained', 'not_qualifying', 'conflicting', 'qualifying'];
const nonnegative = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;
function requireValue(value: boolean): void {
  if (!value) throw new Error('completion_input_invalid');
}
function validateIdentity(value: CompletionIdentity): void {
  requireValue([value.requestId, value.accountId, value.authUserId].every(part => typeof part === 'string' && id.test(part)) &&
    nonnegative(value.epoch) && value.epoch > 0 && nonnegative(value.sequence) && value.sequence > 0);
}
function identityKey(value: CompletionIdentity): string {
  return JSON.stringify([value.requestId, value.accountId, value.authUserId, value.epoch, value.sequence]);
}
function validateBinding(value: CompletionBinding): void {
  validateIdentity(value);
  const checkpoint = value.checkpoint;
  requireValue(validId(value.databaseGeneration) && digest.test(value.schemaDigest) && validId(value.cohort) &&
    validId(checkpoint.authorityId) && digest.test(checkpoint.ledgerSchemaDigest) && nonnegative(checkpoint.revision) &&
    nonnegative(checkpoint.committedSequence) && checkpoint.committedSequence >= value.sequence && digest.test(checkpoint.committedHeadDigest));
}
function bindingKey(value: CompletionBinding): string {
  const c = value.checkpoint;
  return JSON.stringify([identityKey(value), value.databaseGeneration, value.schemaDigest, value.cohort,
    c.authorityId, c.ledgerSchemaDigest, c.revision, c.committedSequence, c.committedHeadDigest]);
}
function targetKey(value: CompletionTarget): string {
  switch (value.kind) {
    case 'category':
      requireValue(validId(value.category));
      return JSON.stringify([value.kind, value.category]);
    case 'provider':
      requireValue(validId(value.provider) && digest.test(value.clientDigest) && digest.test(value.subjectDigest) && validId(value.referenceVersion));
      return JSON.stringify([value.kind, value.provider, value.clientDigest, value.subjectDigest, value.referenceVersion]);
    case 'backup':
      requireValue(digest.test(value.inventoryDigest) && validId(value.policyVersion));
      return JSON.stringify([value.kind, value.inventoryDigest, value.policyVersion]);
    default: throw new Error('completion_input_invalid');
  }
}
function validateFact(value: CompletionFact): void {
  validateBinding(value.binding);
  targetKey(value.target);
  requireValue(validId(value.operationId) && statuses.includes(value.status) && Array.isArray(value.resolves) &&
    value.resolves.every(part => typeof part === 'string' && id.test(part) && part !== value.operationId) &&
    new Set(value.resolves).size === value.resolves.length);
  if (value.status !== 'qualifying') {
    requireValue(value.witness === null && value.resolves.length === 0);
    return;
  }
  const witness = value.witness;
  requireValue(witness !== null && typeof witness === 'object' && digest.test(witness.evidenceDigest) && nonnegative(witness.observedAtMs));
  const expected = { category: 'local_purge_readback', provider: 'provider_revocation_acknowledgment', backup: 'backup_disposition' };
  requireValue(witness.kind === expected[value.target.kind]);
  if (witness.kind === 'backup_disposition') requireValue(digest.test(witness.inventoryWitnessDigest) &&
    ['destruction_witnessed', 'expiry_witnessed'].includes(witness.disposition));
}

// Copy only declared metadata: no provider payload, credential, policy deadline or caller-owned mutable object enters history.
function copyIdentity(value: CompletionIdentity): CompletionIdentity {
  return Object.freeze({ requestId: value.requestId, accountId: value.accountId, authUserId: value.authUserId, epoch: value.epoch, sequence: value.sequence });
}
function copyBinding(value: CompletionBinding): CompletionBinding {
  const c = value.checkpoint;
  return Object.freeze({ ...copyIdentity(value), databaseGeneration: value.databaseGeneration, schemaDigest: value.schemaDigest, cohort: value.cohort,
    checkpoint: Object.freeze({ authorityId: c.authorityId, ledgerSchemaDigest: c.ledgerSchemaDigest, revision: c.revision,
      committedSequence: c.committedSequence, committedHeadDigest: c.committedHeadDigest }) });
}
function copyTarget(value: CompletionTarget): CompletionTarget {
  switch (value.kind) {
    case 'category': return Object.freeze({ kind: value.kind, category: value.category });
    case 'provider': return Object.freeze({ kind: value.kind, provider: value.provider, clientDigest: value.clientDigest,
      subjectDigest: value.subjectDigest, referenceVersion: value.referenceVersion });
    case 'backup': return Object.freeze({ kind: value.kind, inventoryDigest: value.inventoryDigest, policyVersion: value.policyVersion });
  }
}
function copyFact(value: CompletionFact): CompletionFact {
  const common = { operationId: value.operationId, binding: copyBinding(value.binding), target: copyTarget(value.target),
    resolves: Object.freeze([...value.resolves].sort()) };
  if (value.status !== 'qualifying') return Object.freeze({ ...common, status: value.status, witness: null });
  const w = value.witness;
  const witness = w.kind === 'backup_disposition'
    ? Object.freeze({ kind: w.kind, disposition: w.disposition, evidenceDigest: w.evidenceDigest,
      observedAtMs: w.observedAtMs, inventoryWitnessDigest: w.inventoryWitnessDigest })
    : Object.freeze({ kind: w.kind, evidenceDigest: w.evidenceDigest, observedAtMs: w.observedAtMs });
  return Object.freeze({ ...common, status: value.status, witness });
}
function factKey(value: CompletionFact): string { return JSON.stringify(copyFact(value)); }
function freezeHistory(identity: CompletionIdentity, facts: readonly CompletionFact[]): CompletionHistory {
  return Object.freeze({ identity: copyIdentity(identity), facts: Object.freeze([...facts]) });
}
export function createCompletionHistory(identity: CompletionIdentity): CompletionHistory {
  validateIdentity(identity);
  return freezeHistory(identity, []);
}

// This is a calculation over observations, not a capability issuer or proof verifier. Qualification belongs to the future bound store.
export function appendCompletionFact(history: CompletionHistory, input: CompletionFact): Readonly<{
  history: CompletionHistory; effect: 'appended' | 'duplicate' | 'conflict';
}> {
  validateIdentity(history.identity);
  validateFact(input);
  if (identityKey(history.identity) !== identityKey(input.binding)) throw new Error('completion_identity_mismatch');
  const fact = copyFact(input);
  const prior = history.facts.filter(item => item.operationId === fact.operationId);
  if (prior.some(item => factKey(item) === factKey(fact))) {
    return Object.freeze({ history, effect: new Set(prior.map(factKey)).size > 1 ? 'conflict' : 'duplicate' });
  }
  return Object.freeze({ history: freezeHistory(history.identity, [...history.facts, fact]), effect: prior.length ? 'conflict' : 'appended' });
}

function combine(states: readonly EvidenceStatus[]): EvidenceStatus {
  // These are blocking precedence rules, not a monotonic ordering of lifecycle steps.
  for (const state of ['conflicting', 'not_qualifying', 'retained', 'unavailable', 'unknown', 'pending', 'missing'] as const) {
    if (states.includes(state)) return state;
  }
  return states.length ? 'qualifying' : 'missing';
}
function targetStatus(facts: readonly CompletionFact[]): EvidenceStatus {
  if (!facts.length) return 'missing';
  const resolved = new Set<string>();
  for (const [index, fact] of facts.entries()) {
    if (fact.status !== 'qualifying') continue;
    for (const operationId of fact.resolves) {
      const prior = facts.slice(0, index).find(item => item.operationId === operationId);
      // A positive witness can explicitly resolve an uncertain attempt, never erase contradictory or retained evidence.
      if (!prior || !['pending', 'unknown', 'unavailable'].includes(prior.status)) return 'conflicting';
      resolved.add(operationId);
    }
  }
  const unresolved = facts.filter(fact => !resolved.has(fact.operationId));
  const witnesses = unresolved.filter((fact): fact is CompletionFact & { status: 'qualifying' } => fact.status === 'qualifying');
  if (new Set(witnesses.map(fact => JSON.stringify(fact.witness))).size > 1) return 'conflicting';
  return combine(unresolved.map(fact => fact.status));
}

export function calculateCompletion(history: CompletionHistory, context: CompletionContext): CompletionCalculation {
  validateIdentity(history.identity);
  validateBinding(context.binding);
  requireValue(['present', 'missing', 'unknown', 'conflicting'].includes(context.request));
  requireValue(['qualified_current', 'unknown', 'unavailable', 'pending', 'conflicting'].includes(context.authority.status));
  const keys = context.requirements.map(targetKey);
  requireValue(new Set(keys).size === keys.length);
  const operations = new Map<string, Set<string>>();
  for (const fact of history.facts) {
    validateFact(fact);
    const entries = operations.get(fact.operationId) ?? new Set<string>();
    entries.add(factKey(fact)); operations.set(fact.operationId, entries);
  }
  const currentKey = bindingKey(context.binding);
  const current = history.facts.filter(fact => bindingKey(fact.binding) === currentKey);
  const targets = Object.freeze(context.requirements.map(target => {
    const facts = current.filter(fact => targetKey(fact.target) === targetKey(target));
    return Object.freeze({ target: copyTarget(target), status: targetStatus(facts),
      operationIds: Object.freeze([...new Set(facts.map(fact => fact.operationId))]) });
  }));
  let hold: CompletionCalculation['hold'] = null;
  let eligibility = combine(targets.map(target => target.status));
  if (identityKey(history.identity) !== identityKey(context.binding) || context.request === 'conflicting' ||
      history.facts.some(fact => identityKey(fact.binding) !== identityKey(history.identity))) {
    hold = 'identity_conflict'; eligibility = 'conflicting';
  } else if ([...operations.values()].some(entries => entries.size > 1) || targets.some(target => target.status === 'conflicting')) {
    hold = 'evidence_conflict'; eligibility = 'conflicting';
  } else if (context.request !== 'present') {
    hold = context.request === 'missing' ? 'request_missing_restore_held' : 'request_unknown';
    eligibility = context.request === 'missing' ? 'missing' : 'unknown';
  } else if (context.authority.status !== 'qualified_current') {
    hold = 'authority_unqualified'; eligibility = context.authority.status;
  } else {
    const record = context.authority.suppression;
    if (identityKey(record) !== identityKey(context.binding) || !nonnegative(record.disabledAtMs)) {
      hold = 'identity_conflict'; eligibility = 'conflicting';
    } else if (current.some(fact => fact.status === 'qualifying' && fact.witness.observedAtMs < record.disabledAtMs)) {
      hold = 'evidence_conflict'; eligibility = 'conflicting';
    }
  }
  return Object.freeze({ scope: 'declared_targets_only', binding: copyBinding(context.binding), eligibility, hold, targets,
    historicalFactCount: history.facts.length, staleFactCount: history.facts.length - current.length,
    wholeAccountDeviceProviderErasure: 'unproven', identityAnchors: 'retained' });
}
