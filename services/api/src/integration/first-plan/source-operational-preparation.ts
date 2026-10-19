import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Domain } from '../../domain.js';
import { DomainError } from '../../errors.js';
import { createRegisteredNativeCatalogFactory, type RegistrationPin, type RegisteredNativeCatalogInput } from '../../catalog-qualification/registered-identity.js';
import { assertActive } from '../../lifecycle/guards.js';
import type { AccountContext } from '../../lifecycle/types.js';
import type { CapturePin } from '../../planning/constraints/confirmed-capture.js';
import { copyCandidateEquipment } from '../../planning/constraints/index.js';
import { evaluateSourceFirstPlanConstraints, type ConfirmedConstraintReceipt } from '../../planning/constraints/first-plan-adapter.js';
import { normalizeSourceFirstPlanInput, sourcePrescriptionKey, type CatalogDecision, type SourceEvaluationInput,
  type SourcePlanCandidate, type PlanningContext, type QualifiedCatalog } from '../../planning/first-plan/index.js';
import type { Preferences, Profile } from '../../schemas.js';
import { canonical, hash } from '../../storage.js';
import type { CanonicalAccountWriter } from '../account-modules/canonical-writer.js';
import type { PreparedSourceFirstPlan } from './contracts.js';

export type OperationalSourceCandidatePacket = Readonly<{
  candidate: SourcePlanCandidate; receipt: ConfirmedConstraintReceipt | null;
}>;
export type OperationalSourceFirstPlanPacket = Readonly<{
  capture: CapturePin;
  registration: Readonly<{ acceptedPins: readonly RegistrationPin[]; input: RegisteredNativeCatalogInput }>;
  candidates: readonly OperationalSourceCandidatePacket[];
}>;
export type OperationalSourceFirstPlanSource = Readonly<{
  capture(actor: AccountContext, context: PlanningContext): Promise<OperationalSourceFirstPlanPacket | null>;
  // Trusted producers must return null or throw after capture/R1 revocation, even when a cached receipt still matches.
  // A CapturePin authenticates no R1 authority by itself; this composer cannot recover a revoked witness from a receipt.
  readCurrent(actor: AccountContext, context: PlanningContext): OperationalSourceFirstPlanPacket | null;
}>;
type Row = { id: string; data: string; retired: number };
function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !(value instanceof Uint8Array)) {
    Object.values(value).forEach(freeze); Object.freeze(value);
  }
  return value;
}
function copy(packet: OperationalSourceFirstPlanPacket): OperationalSourceFirstPlanPacket {
  if (!packet || !packet.capture || !Array.isArray(packet.candidates) || packet.candidates.length === 0 || packet.candidates.length > 64 ||
    packet.candidates.some(entry => !Array.isArray(entry?.candidate?.plan?.items) || entry.candidate.plan.items.length > 50) ||
    !Array.isArray(packet.registration?.acceptedPins) || !(packet.registration.input?.legacyBytes instanceof Uint8Array) ||
    !(packet.registration.input.registrationBytes === null || packet.registration.input.registrationBytes instanceof Uint8Array))
    throw new DomainError(503, 'first_plan_preparation_unavailable');
  try {
    // Validate receipt equipment before cloning can invoke accessors; this check grants no operational authority.
    for (const entry of packet.candidates) {
      if (entry.receipt === null) continue;
      copyCandidateEquipment(entry.receipt.candidate);
      if (entry.receipt.snapshot.baseline !== null) copyCandidateEquipment(entry.receipt.snapshot.baseline);
    }
    return freeze(structuredClone(packet));
  } catch {
    throw new DomainError(503, 'first_plan_preparation_unavailable');
  }
}
function fingerprint(packet: OperationalSourceFirstPlanPacket): string {
  const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
  return hash(canonical({ ...packet, registration: { ...packet.registration, input: { ...packet.registration.input,
    legacyBytes: digest(packet.registration.input.legacyBytes), registrationBytes: packet.registration.input.registrationBytes === null
      ? null : digest(packet.registration.input.registrationBytes) } } }));
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

export function createOperationalSourceFirstPlanPreparation(domain: Domain, source: OperationalSourceFirstPlanSource,
  writer: CanonicalAccountWriter): (actor: AccountContext, context: PlanningContext) => Promise<PreparedSourceFirstPlan> {
  if (!source || !writer) throw new DomainError(503, 'first_plan_preparation_unavailable');
  const receiver = source, capture = source.capture, readCurrent = source.readCurrent, db = domain.db;
  const options = writer.lifecycleStoreOptions, assertRootWriter = options?.assertRootWriter, assertWithinWrite = writer.assertWithinWrite;
  if (typeof capture !== 'function' || typeof readCurrent !== 'function' || options?.db !== db ||
    typeof assertRootWriter !== 'function' || typeof assertWithinWrite !== 'function')
    throw new DomainError(503, 'first_plan_preparation_unavailable');
  const assertBinding = () => {
    if (domain.db !== db || !db.open || receiver.capture !== capture || receiver.readCurrent !== readCurrent ||
      writer.lifecycleStoreOptions !== options || options.assertRootWriter !== assertRootWriter || writer.assertWithinWrite !== assertWithinWrite)
      throw new DomainError(409, 'first_plan_sources_changed');
  };
  return async (actorInput, contextInput): Promise<PreparedSourceFirstPlan> => {
    assertBinding();
    if (db.inTransaction) throw new DomainError(503, 'first_plan_capture_transaction_forbidden');
    const actor = freeze(structuredClone(actorInput)), context = freeze(structuredClone(contextInput));
    const assertActorContext = () => {
      assertBinding(); assertActive(db, actor);
      if (!isDeepStrictEqual(currentContext(domain, actor), context)) throw new DomainError(409, 'first_plan_confirmation_stale');
    };
    assertActorContext();
    let captured: OperationalSourceFirstPlanPacket | null;
    try { captured = await capture.call(receiver, actor, context); }
    finally { assertActorContext(); }
    if (captured === null) throw new DomainError(503, 'first_plan_preparation_unavailable');
    const packet = copy(captured), packetFingerprint = fingerprint(packet), pin = packet.capture;
    const normalized = packet.candidates.map(entry => normalizeSourceFirstPlanInput({ context, candidate: entry.candidate,
      confirmation: { accountId: actor.accountId, profileRevision: context.profile.revision, preferencesRevision: context.preferences.revision } }));
    if (![pin.id, pin.revision].every(value => typeof value === 'string' && value.trim().length > 0) ||
      !/^[a-f0-9]{64}$/.test(pin.digest) || pin.accountId !== actor.accountId || pin.sessionId !== actor.sessionId ||
      pin.profileRevision !== context.profile.revision || pin.preferencesRevision !== context.preferences.revision ||
      normalized.some(value => value.status !== 'valid' || value.input.contextKey !== pin.contextKey))
      throw new DomainError(503, 'first_plan_preparation_unavailable');
    const registered = createRegisteredNativeCatalogFactory(packet.registration.acceptedPins)(packet.registration.input);
    const ids = [...new Set(packet.candidates.flatMap(entry => entry.candidate.plan.items.map(item => item.registeredDomain.exerciseId)))];
    const readRow = (id: string): Row | null => (db.prepare('SELECT id,data,retired FROM exercises WHERE id=?').get(id) as Row | undefined) ?? null;
    const rows = new Map(ids.map(id => [id, readRow(id)]));
    const assertCurrent = () => {
      assertActorContext();
      assertRootWriter.call(options, db); assertWithinWrite.call(writer, actor);
      const current: unknown = readCurrent.call(receiver, actor, context);
      if (current !== null && (typeof current === 'object' || typeof current === 'function') &&
        typeof (current as { then?: unknown }).then === 'function') {
        void Promise.resolve(current).catch(() => {});
        throw new DomainError(409, 'first_plan_sources_changed');
      }
      assertActorContext();
      if (!current || fingerprint(copy(current as OperationalSourceFirstPlanPacket)) !== packetFingerprint)
        throw new DomainError(409, 'first_plan_sources_changed');
      for (const id of ids) if (!isDeepStrictEqual(readRow(id), rows.get(id))) throw new DomainError(409, 'first_plan_sources_changed');
      assertRootWriter.call(options, db); assertWithinWrite.call(writer, actor); assertActorContext();
    };
    const entryFor = (input: SourceEvaluationInput) => packet.candidates.find((entry, index) => {
      const value = normalized[index];
      return value?.status === 'valid' && isDeepStrictEqual(value.input, input) && entry.candidate.id === input.candidate.id;
    });
    const unknown = (input: SourceEvaluationInput, code: string): CatalogDecision => ({ contextKey: input.contextKey,
      candidateKey: input.candidateKey, status: 'unknown', reasons: [{ code }] });
    const qualifyCatalog = (input: SourceEvaluationInput): CatalogDecision => {
      assertCurrent();
      const receipt = entryFor(input)?.receipt;
      if (!receipt) return unknown(input, 'constraint_receipt_unavailable');
      if (receipt.contextKey !== input.contextKey || receipt.candidateKey !== input.candidateKey ||
        receipt.catalog.contextKey !== input.contextKey || receipt.catalog.candidateKey !== input.candidateKey ||
        receipt.catalog.items.length !== input.candidate.plan.items.length)
        return unknown(input, 'operational_catalog_binding_mismatch');
      if (!registered.registration) return unknown(input, 'registered_catalog_unavailable');
      for (let index = 0; index < input.candidate.plan.items.length; index++) {
        const item = input.candidate.plan.items[index]!, association = item.registeredDomain;
        const proof = receipt.catalog.items.find(value => value.itemId === item.id);
        const record = registered.getRegisteredRecord(association.exerciseId), row = rows.get(association.exerciseId);
        if (!record || !row || row.id !== association.exerciseId || row.retired !== 0)
          return unknown(input, 'registered_domain_row_unavailable');
        let parsed: unknown;
        try { parsed = JSON.parse(row.data); } catch { return unknown(input, 'registered_domain_row_invalid'); }
        if (!isDeepStrictEqual(parsed, record)) return unknown(input, 'registered_domain_row_mismatch');
        const binding = registered.bindRegisteredDomainExercise({ nativeId: item.native.exercise_id,
          exerciseId: association.exerciseId, active: { exerciseId: row.id, embeddedId: record.id,
            recordDigest: hash(canonical(parsed)), retired: row.retired !== 0,
            registration: { id: registered.registration.id, revision: registered.registration.revision, digest: registered.registration.digest },
            sourceIdentity: record.provenance.sourceIdentity, catalogRevision: registered.registration.revision, currentness: 'current' } });
        if (binding.status !== 'bound' || association.variantId !== binding.variantId ||
          !isDeepStrictEqual(association.identity, binding.identity) || !isDeepStrictEqual(association.registration, registered.registration) ||
          association.recordDigest !== binding.recordDigest || !proof || proof.exerciseId !== association.exerciseId ||
          proof.variantId !== binding.variantId || proof.retired !== false || proof.prescriptionKey !== sourcePrescriptionKey(item) ||
          input.prescriptions[index]?.itemId !== item.id || input.prescriptions[index]?.prescriptionKey !== proof.prescriptionKey)
          return unknown(input, 'registered_prescription_association_mismatch');
      }
      const decision = evaluateSourceFirstPlanConstraints(input, receipt.catalog, receipt);
      if (decision.status === 'unknown') return { contextKey: input.contextKey, candidateKey: input.candidateKey,
        status: 'unknown', reasons: decision.reasons.length ? decision.reasons : [{ code: 'constraint_receipt_unqualified' }] };
      return structuredClone(receipt.catalog);
    };
    return freeze({ schema: 'form.source-first-plan-preparation/v1' as const,
      candidates: packet.candidates.map(entry => structuredClone(entry.candidate)),
      ports: { qualifyCatalog, evaluateConstraints(input: SourceEvaluationInput, catalog: QualifiedCatalog) {
        assertCurrent();
        const receipt = entryFor(input)?.receipt ?? null;
        return evaluateSourceFirstPlanConstraints(input, catalog, receipt && isDeepStrictEqual(catalog, receipt.catalog) ? receipt : null);
      } }, assertCurrent });
  };
}
