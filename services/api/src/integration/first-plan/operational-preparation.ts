import { createHash } from 'node:crypto';
import type { Domain } from '../../domain.js';
import { DomainError } from '../../errors.js';
import { createRegisteredNativeCatalogFactory, type RegistrationPin, type RegisteredNativeCatalogInput } from '../../catalog-qualification/registered-identity.js';
import { assertActive } from '../../lifecycle/guards.js';
import type { AccountContext } from '../../lifecycle/types.js';
import { evaluateFirstPlanConstraints, type ConfirmedConstraintReceipt } from '../../planning/constraints/first-plan-adapter.js';
import { prescriptionKey, type CatalogDecision, type EvaluationInput, type PlanCandidate, type PlanningContext, type QualifiedCatalog } from '../../planning/first-plan/index.js';
import type { Preferences, Profile } from '../../schemas.js';
import { canonical, hash } from '../../storage.js';
import type { FirstPlanPreparationPort } from './contracts.js';

export type OperationalCandidatePacket = Readonly<{ candidate: PlanCandidate; receipt: ConfirmedConstraintReceipt | null }>;
export type OperationalFirstPlanPacket = Readonly<{
  registration: Readonly<{ acceptedPins: readonly RegistrationPin[]; input: RegisteredNativeCatalogInput }>;
  candidates: readonly OperationalCandidatePacket[];
}>;
export type OperationalFirstPlanSource = Readonly<{
  capture(actor: AccountContext, context: PlanningContext): Promise<OperationalFirstPlanPacket | null>;
  readCurrent(actor: AccountContext, context: PlanningContext): OperationalFirstPlanPacket | null;
}>;
type Row = { id: string; data: string; retired: number };
function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !(value instanceof Uint8Array)) {
    Object.values(value).forEach(freeze); Object.freeze(value);
  }
  return value;
}
function copy(packet: OperationalFirstPlanPacket): OperationalFirstPlanPacket {
  if (!packet || !Array.isArray(packet.candidates) || packet.candidates.length > 64 ||
    packet.candidates.some(entry => !Array.isArray(entry?.candidate?.plan?.items) || entry.candidate.plan.items.length > 50) ||
    !Array.isArray(packet.registration?.acceptedPins) || !(packet.registration.input?.legacyBytes instanceof Uint8Array) ||
    !(packet.registration.input.registrationBytes === null || packet.registration.input.registrationBytes instanceof Uint8Array))
    throw new DomainError(503, 'first_plan_preparation_unavailable');
  return freeze(structuredClone(packet));
}
function fingerprint(packet: OperationalFirstPlanPacket): string {
  const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
  return hash(canonical({ registration: { acceptedPins: packet.registration.acceptedPins,
    legacy: digest(packet.registration.input.legacyBytes), registration: packet.registration.input.registrationBytes === null
      ? null : digest(packet.registration.input.registrationBytes) }, candidates: packet.candidates }));
}
function currentContext(domain: Domain, actor: AccountContext): PlanningContext {
  const profile = domain.document<Profile>(actor.accountId, 'profile');
  const preferences = domain.document<Preferences>(actor.accountId, 'preferences');
  return { accountId: actor.accountId, profile: { revision: profile.revision, goals: [...profile.goals],
    trainingBackground: profile.trainingBackground, injuryHistory: profile.injuryHistory,
    ...(profile.trainingContext === undefined ? {} : { trainingContext: profile.trainingContext }) },
    preferences: { revision: preferences.revision, equipment: [...preferences.equipment],
      sessionMinutes: preferences.sessionMinutes, trainingDaysPerWeek: preferences.trainingDaysPerWeek } };
}

export function createOperationalFirstPlanPreparation(domain: Domain, source: OperationalFirstPlanSource): FirstPlanPreparationPort {
  if (!source) throw new DomainError(503, 'first_plan_preparation_unavailable');
  const receiver = source, capture = source.capture, readCurrent = source.readCurrent;
  if (typeof capture !== 'function' || typeof readCurrent !== 'function')
    throw new DomainError(503, 'first_plan_preparation_unavailable');
  const db = domain.db;
  const assertBinding = () => {
    if (domain.db !== db || !db.open || receiver.capture !== capture || receiver.readCurrent !== readCurrent)
      throw new DomainError(409, 'first_plan_sources_changed');
  };
  return async (actorInput, contextInput) => {
    assertBinding();
    if (db.inTransaction) throw new DomainError(503, 'first_plan_capture_transaction_forbidden');
    const actor = freeze(structuredClone(actorInput)), context = freeze(structuredClone(contextInput));
    const contextFingerprint = canonical(context);
    const assertActorContext = () => {
      assertBinding();
      assertActive(db, actor);
      if (canonical(currentContext(domain, actor)) !== contextFingerprint)
        throw new DomainError(409, 'first_plan_confirmation_stale');
    };
    assertActorContext();
    let captured: OperationalFirstPlanPacket | null;
    try { captured = await capture.call(receiver, actor, context); }
    finally { assertActorContext(); }
    if (captured === null) throw new DomainError(503, 'first_plan_preparation_unavailable');
    const packet = copy(captured), packetFingerprint = fingerprint(packet);
    const registered = createRegisteredNativeCatalogFactory(packet.registration.acceptedPins)(packet.registration.input);
    const ids = [...new Set(packet.candidates.flatMap(entry => entry.candidate.plan.items.map(item => item.exerciseId)))];
    const readRow = (id: string): Row | null => (db.prepare('SELECT id,data,retired FROM exercises WHERE id=?').get(id) as Row | undefined) ?? null;
    const rows = new Map(ids.map(id => [id, readRow(id)]));
    const rowFingerprint = (row: Row | null) => row === null ? null : canonical({ id: row.id, digest: hash(row.data), retired: row.retired });
    const snapshots = new Map([...rows].map(([id, row]) => [id, rowFingerprint(row)]));
    const entryFor = (input: EvaluationInput) => packet.candidates.find(entry => entry.candidate.id === input.candidate.id &&
      canonical(entry.candidate) === canonical(input.candidate));
    const unknown = (input: EvaluationInput, code: string): CatalogDecision => ({ contextKey: input.contextKey,
      candidateKey: input.candidateKey, status: 'unknown', reasons: [{ code }] });
    const qualifyCatalog = (input: EvaluationInput): CatalogDecision => {
      const entry = entryFor(input), receipt = entry?.receipt;
      if (!receipt) return unknown(input, 'constraint_receipt_unavailable');
      if (canonical(input.context) !== contextFingerprint || receipt.contextKey !== input.contextKey ||
        receipt.candidateKey !== input.candidateKey || receipt.catalog.contextKey !== input.contextKey ||
        receipt.catalog.candidateKey !== input.candidateKey || receipt.catalog.items.length !== input.candidate.plan.items.length)
        return unknown(input, 'operational_catalog_binding_mismatch');
      if (!registered.registration) return unknown(input, 'registered_catalog_unavailable');
      for (let index = 0; index < input.candidate.plan.items.length; index++) {
        const item = input.candidate.plan.items[index]!, proof = receipt.catalog.items.find(value => value.itemId === item.id);
        const record = registered.getRegisteredRecord(item.exerciseId), row = rows.get(item.exerciseId);
        if (!record || !row || row.id !== item.exerciseId || row.retired !== 0)
          return unknown(input, 'registered_domain_row_unavailable');
        let parsed: unknown;
        try { parsed = JSON.parse(row.data); } catch { return unknown(input, 'registered_domain_row_invalid'); }
        if (canonical(parsed) !== canonical(record)) return unknown(input, 'registered_domain_row_mismatch');
        const binding = registered.bindRegisteredDomainExercise({ nativeId: record.provenance.sourceIdentity.nativeId,
          exerciseId: item.exerciseId, active: { exerciseId: row.id, embeddedId: record.id,
            recordDigest: hash(canonical(parsed)), retired: false, registration: { id: registered.registration.id,
              revision: registered.registration.revision, digest: registered.registration.digest },
            sourceIdentity: record.provenance.sourceIdentity, catalogRevision: registered.registration.revision, currentness: 'current' } });
        if (binding.status !== 'bound' || !proof || proof.exerciseId !== item.exerciseId || proof.variantId !== binding.variantId ||
          proof.retired !== false || proof.prescriptionKey !== prescriptionKey(item) ||
          input.prescriptions[index]?.itemId !== item.id || input.prescriptions[index]?.prescriptionKey !== proof.prescriptionKey)
          return unknown(input, 'registered_prescription_association_mismatch');
      }
      const decision = evaluateFirstPlanConstraints(input, receipt.catalog, receipt);
      if (decision.status === 'unknown') return { contextKey: input.contextKey, candidateKey: input.candidateKey,
        status: 'unknown', reasons: decision.reasons.length ? decision.reasons : [{ code: 'constraint_receipt_unqualified' }] };
      return structuredClone(receipt.catalog);
    };
    return {
      candidates: freeze(packet.candidates.map(entry => structuredClone(entry.candidate))),
      ports: { qualifyCatalog, evaluateConstraints(input: EvaluationInput, catalog: QualifiedCatalog) {
        const receipt = entryFor(input)?.receipt ?? null;
        return evaluateFirstPlanConstraints(input, catalog,
          receipt && canonical(catalog) === canonical(receipt.catalog) ? receipt : null);
      } },
      assertCurrent() {
        assertActorContext();
        const current: unknown = readCurrent.call(receiver, actor, context);
        assertActorContext();
        if (current !== null && (typeof current === 'object' || typeof current === 'function') &&
          typeof (current as { then?: unknown }).then === 'function')
          throw new DomainError(409, 'first_plan_sources_changed');
        if (!current || fingerprint(copy(current as OperationalFirstPlanPacket)) !== packetFingerprint)
          throw new DomainError(409, 'first_plan_sources_changed');
        for (const id of ids) if (rowFingerprint(readRow(id)) !== snapshots.get(id))
          throw new DomainError(409, 'first_plan_sources_changed');
        assertActorContext();
      },
    };
  };
}
