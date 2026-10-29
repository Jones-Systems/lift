import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { createRegisteredNativeCatalogFactory, type RegistrationPin, type RegisteredNativeCatalogInput } from '../../catalog-qualification/registered-identity.js';
import type { OperationalSourceFirstPlanPacket, OperationalSourceFirstPlanSource } from '../../integration/first-plan/source-operational-preparation.js';
import type { AccountContext } from '../../lifecycle/types.js';
import { prepareConfirmedSourceConstraintReceipt, type AcceptedConstraintMetadata, type ConstraintCaptureHost } from '../constraints/confirmed-capture.js';
import { copyCandidateEquipment } from '../constraints/index.js';
import { FALLBACK_POLICY, produceFallbackCandidate } from './fallback-producer.js';
import { normalizeSourceFirstPlanInput, sourcePrescriptionKey } from './normalization.js';
import type { PlanningContext, QualifiedCatalog, SourcePlanCandidate } from './types.js';

type Registration = Readonly<{ acceptedPins: readonly RegistrationPin[]; input: RegisteredNativeCatalogInput }>;
type Ports = Readonly<{
  registration(): Registration | null;
  captureHost(actor: AccountContext, context: PlanningContext): ConstraintCaptureHost | null;
  acceptedMetadata(candidate: SourcePlanCandidate, context: PlanningContext): AcceptedConstraintMetadata | null;
}>;

function synchronous<T>(value: T): T {
  if (value !== null && (typeof value === 'object' || typeof value === 'function') &&
    'then' in value && typeof value.then === 'function') {
    void Promise.resolve(value).catch(() => {});
    throw new TypeError('Synchronous fallback port required');
  }
  return value;
}
function detached<T>(value: T): T {
  const copy = structuredClone(value);
  const freeze = (part: unknown): void => {
    if (part && typeof part === 'object' && !(part instanceof Uint8Array)) {
      Object.values(part).forEach(freeze); Object.freeze(part);
    }
  };
  freeze(copy); return copy;
}
function metadataCopy(value: AcceptedConstraintMetadata): AcceptedConstraintMetadata {
  return detached({ ...value, candidate: copyCandidateEquipment(value.candidate),
    baseline: value.baseline === null ? null : copyCandidateEquipment(value.baseline) });
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (object(value)) return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`;
  if (value === null || typeof value === 'string' || typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))) return JSON.stringify(value);
  throw new TypeError('Invalid registered record');
}

// Registration proves identity only. Installed-row currentness remains the canonical composer's responsibility.
function bind(registration: Registration) {
  const catalog = createRegisteredNativeCatalogFactory(registration.acceptedPins)(registration.input);
  const pin = catalog.registration, bytes = registration.input.registrationBytes;
  if (!pin || !bytes) return null;
  const decoded: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (!object(decoded) || !Array.isArray(decoded.entries)) return null;
  const entries: unknown[] = decoded.entries;
  const bindings = FALLBACK_POLICY.recipe.map(native => {
    const matches = entries.filter(entry => object(entry) && object(entry.sourceIdentity) &&
      entry.sourceIdentity.nativeId === native.exercise_id);
    const entry = matches.length === 1 ? matches[0] : null;
    if (!object(entry) || typeof entry.exerciseId !== 'string') return null;
    const record = catalog.getRegisteredRecord(entry.exerciseId);
    if (!record) return null;
    return catalog.bindRegisteredDomainExercise({ nativeId: native.exercise_id, exerciseId: entry.exerciseId,
      active: { exerciseId: record.id, embeddedId: record.id, retired: record.retired,
        recordDigest: createHash('sha256').update(canonical(record)).digest('hex'),
        registration: pin, sourceIdentity: record.provenance.sourceIdentity,
        catalogRevision: pin.revision, currentness: 'current' } });
  });
  if (bindings.some(value => !value || value.status !== 'bound')) return null;
  return { pin, bindings: bindings.filter(value => value !== null) };
}

export function createFallbackFirstPlanSource(ports: Ports): OperationalSourceFirstPlanSource {
  const registrationPort = ports.registration, hostPort = ports.captureHost, metadataPort = ports.acceptedMetadata;
  type Captured = { actor: AccountContext; context: PlanningContext; packet: OperationalSourceFirstPlanPacket;
    metadata: AcceptedConstraintMetadata; assertCurrent(): void };
  // The canonical composer retains this actor object across capture and synchronous reads.
  // Weak request custody prevents a concurrent same-session capture from replacing its original handles.
  const captured = new WeakMap<AccountContext, Captured>();
  const assertPorts = () => {
    if (ports.registration !== registrationPort || ports.captureHost !== hostPort || ports.acceptedMetadata !== metadataPort)
      throw new TypeError('Fallback ports changed');
  };
  return Object.freeze({
    async capture(actorInput: AccountContext, contextInput: PlanningContext) {
      captured.delete(actorInput);
      try {
        assertPorts();
        const actor = detached(actorInput), context = detached(contextInput);
        if (actor.accountId !== context.accountId) return null;
        const supplied = synchronous(registrationPort.call(ports));
        if (!supplied) return null;
        const registration = detached(supplied), bound = bind(registration);
        if (!bound) return null;
        const confirmation = { accountId: actor.accountId, profileRevision: context.profile.revision,
          preferencesRevision: context.preferences.revision };
        const produced = produceFallbackCandidate({ context, confirmation,
          policy: { qualification: 'qualified', source: FALLBACK_POLICY.source }, registration: bound });
        if (produced.status !== 'produced') return null;
        const candidate = produced.candidate;
        const normalized = normalizeSourceFirstPlanInput({ context, confirmation, candidate });
        if (normalized.status !== 'valid') return null;
        const input = normalized.input, original = synchronous(hostPort.call(ports, actor, context));
        if (!original) return null;
        const pin = detached(original.pin), read = original.readCurrent, active = original.assertActive;
        if (pin.accountId !== actor.accountId || pin.sessionId !== actor.sessionId || pin.contextKey !== input.contextKey ||
          pin.profileRevision !== context.profile.revision || pin.preferencesRevision !== context.preferences.revision ||
          typeof read !== 'function' || typeof active !== 'function') return null;
        const assertHost = () => {
          if (original.readCurrent !== read || original.assertActive !== active || !isDeepStrictEqual(original.pin, pin))
            throw new TypeError('Fallback capture host changed');
          synchronous(active.call(original));
        };
        const host: ConstraintCaptureHost = { pin, assertActive: assertHost,
          readCurrent() { assertHost(); const witnesses = synchronous(read.call(original)); assertHost(); return witnesses; } };
        const catalog: QualifiedCatalog = { contextKey: input.contextKey, candidateKey: input.candidateKey, status: 'qualified',
          source: { id: bound.pin.id, revision: bound.pin.revision, locator: `sha256:${bound.pin.digest}`,
            currentness: 'current', qualification: 'operational_identity_only' },
          items: candidate.plan.items.map(item => ({ itemId: item.id, exerciseId: item.registeredDomain.exerciseId,
            variantId: item.registeredDomain.variantId, prescriptionKey: sourcePrescriptionKey(item), retired: false,
            source: FALLBACK_POLICY.source })) };
        const accepted = synchronous(metadataPort.call(ports, candidate, context));
        if (!accepted) return null;
        const metadata = metadataCopy(accepted);
        const prepared = prepareConfirmedSourceConstraintReceipt(input, catalog, metadata, host);
        // Unknown decisions have no receipt/handles in the helper contract. Preserve blocked selection,
        // guarded by the original whole witness snapshot; never manufacture a receipt or R1 authority.
        if (prepared.status === 'unavailable' && (!prepared.evidence || prepared.decision?.status !== 'unknown')) return null;
        const evidence = detached(prepared.evidence);
        const assertCurrent = prepared.status === 'prepared' ? () => {
          synchronous(prepared.assertCurrent());
          if (!isDeepStrictEqual(synchronous(prepared.readCurrent()), prepared.receipt))
            throw new TypeError('Fallback receipt revoked');
        } : () => {
          host.assertActive();
          if (!isDeepStrictEqual(host.readCurrent(), evidence)) throw new TypeError('Fallback witnesses changed');
          host.assertActive();
        };
        const packet = detached({ capture: pin, registration,
          candidates: [{ candidate, receipt: prepared.status === 'prepared' ? prepared.receipt : null }] });
        assertPorts(); assertCurrent();
        if (!isDeepStrictEqual(detached(synchronous(registrationPort.call(ports))), registration)) return null;
        const currentMetadata = synchronous(metadataPort.call(ports, candidate, context));
        if (!currentMetadata || !isDeepStrictEqual(metadataCopy(currentMetadata), metadata)) return null;
        captured.set(actorInput, { actor, context, packet, metadata, assertCurrent });
        return detached(packet);
      } catch { return null; }
    },
    readCurrent(actor: AccountContext, context: PlanningContext) {
      const state = captured.get(actor);
      if (!state) return null;
      try {
        assertPorts();
        if (!isDeepStrictEqual(actor, state.actor) || !isDeepStrictEqual(context, state.context)) return null;
        const registration = synchronous(registrationPort.call(ports));
        if (!registration || !isDeepStrictEqual(detached(registration), state.packet.registration)) throw new TypeError('Registration changed');
        const metadata = synchronous(metadataPort.call(ports, state.packet.candidates[0]!.candidate, state.context));
        if (!metadata || !isDeepStrictEqual(metadataCopy(metadata), state.metadata)) throw new TypeError('Metadata changed');
        state.assertCurrent(); assertPorts();
        return detached(state.packet);
      } catch { captured.delete(actor); return null; }
    },
  });
}
