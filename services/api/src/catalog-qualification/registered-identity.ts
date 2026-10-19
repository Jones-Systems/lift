import { createHash } from 'node:crypto';
import { createNativeMovementCatalogFromRetained, type NativeMovementCatalog, type NativeRecordIdentity } from './native-identity.js';
import { CatalogQualificationError, dataArray, fields, freeze, requireValue, textValue } from './validation.js';

export type RegistrationRef = Readonly<{ id: string; revision: string }>;
export type RegistrationPin = Readonly<{ id: string; revision: string; digest: string; bytes: number }>;
export type RegisteredNativeExercise = Readonly<{
  id: string; name: string; loadLabel: 'Load (unspecified basis)'; retired: false;
  provenance: Readonly<{
    sourceIdentity: NativeRecordIdentity; registration: RegistrationRef;
    loadBasis: 'unknown'; cueStatus: 'withheld';
  }>;
  requiredConstraints: readonly []; cues: readonly [];
}>;
export type NativeDomainRegistrationV1 = Readonly<{
  schema: 'form.native-domain-registration/v1'; id: string; revision: string;
  entries: readonly Readonly<{
    exerciseId: string; sourceIdentity: NativeRecordIdentity;
    recordDigest: string; record: RegisteredNativeExercise;
  }>[];
}>;
export type RegisteredDomainProjection = Readonly<{
  exerciseId: string; embeddedId: string; recordDigest: string; retired: boolean;
  registration: Readonly<{ id: string; revision: string; digest: string }>;
  sourceIdentity: NativeRecordIdentity; catalogRevision: string;
  currentness: 'current' | 'stale' | 'unavailable';
}>;
export type RegisteredBindingRequest = Readonly<{
  nativeId: string; exerciseId: string; active: RegisteredDomainProjection | null;
}>;
export type RegisteredBindingUnavailableReason =
  | 'registry_unavailable' | 'unknown_registration' | 'unknown_exercise_id' | 'unknown_native_id'
  | 'domain_absent' | 'domain_id_mismatch' | 'source_identity_mismatch' | 'record_digest_mismatch'
  | 'retired' | 'registration_not_current';
export type RegisteredBinding =
  | Readonly<{
    schema: 'form.registered-native-binding/v1'; status: 'bound'; exerciseId: string; variantId: string;
    identity: NativeRecordIdentity; registration: Readonly<{ id: string; revision: string; digest: string }>;
    recordDigest: string; catalogRevision: string; qualificationScope: 'operational_identity_only';
  }>
  | Readonly<{
    schema: 'form.registered-native-binding/v1'; status: 'unavailable'; nativeId: string;
    exerciseId: string; reasons: readonly RegisteredBindingUnavailableReason[];
  }>;
export type RegisteredNativeCatalog = Readonly<{
  source: NativeMovementCatalog['source']; registration: RegistrationPin | null;
  getRegisteredRecord(exerciseId: string): RegisteredNativeExercise | null;
  bindRegisteredDomainExercise(request: RegisteredBindingRequest): RegisteredBinding;
}>;
export type RegisteredNativeCatalogInput = Readonly<{
  legacyBytes: Uint8Array; registrationBytes: Uint8Array | null;
}>;

type ErrorCode = CatalogQualificationError['code'];
type Entry = NativeDomainRegistrationV1['entries'][number];
const identityKeys = ['repository', 'revision', 'path', 'sha256', 'nativeId'] as const;

function domainId(value: unknown, code: ErrorCode): string {
  const id = textValue(value, code);
  requireValue(id.length <= 80 && /^[a-zA-Z0-9_-]+$/u.test(id), code, 'invalid Domain resource ID');
  return id;
}
function digest(value: unknown, code: ErrorCode): string {
  requireValue(typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value), code, 'invalid SHA256 digest');
  return value;
}
function identity(value: unknown, code: ErrorCode): NativeRecordIdentity {
  const row = fields(value, identityKeys, code);
  return {
    repository: textValue(row.repository, code), revision: textValue(row.revision, code),
    path: textValue(row.path, code), sha256: digest(row.sha256, code), nativeId: domainId(row.nativeId, code),
  };
}
function sameIdentity(left: NativeRecordIdentity, right: NativeRecordIdentity): boolean {
  return identityKeys.every(key => left[key] === right[key]);
}
function ref(value: unknown, code: ErrorCode): RegistrationRef {
  const row = fields(value, ['id', 'revision'], code);
  return { id: textValue(row.id, code), revision: textValue(row.revision, code) };
}
function sameRef(left: RegistrationRef, right: RegistrationRef): boolean {
  return left.id === right.id && left.revision === right.revision;
}
function readPin(value: unknown): RegistrationPin {
  const row = fields(value, ['id', 'revision', 'digest', 'bytes'], 'invalid_policy');
  requireValue(typeof row.bytes === 'number' && Number.isSafeInteger(row.bytes) && row.bytes > 0, 'invalid_policy', 'invalid pinned byte count');
  return { ...ref({ id: row.id, revision: row.revision }, 'invalid_policy'),
    digest: digest(row.digest, 'invalid_policy'), bytes: row.bytes };
}

// Match storage.ts canonical(record) exactly without importing its database graph; record arrays remain ordered.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`;
  return JSON.stringify(value);
}
function record(value: unknown, entryIdentity: NativeRecordIdentity, registration: RegistrationRef,
  native: NativeMovementCatalog): RegisteredNativeExercise {
  const row = fields(value, ['id', 'name', 'loadLabel', 'retired', 'provenance', 'requiredConstraints', 'cues'], 'invalid_artifact');
  const provenance = fields(row.provenance, ['sourceIdentity', 'registration', 'loadBasis', 'cueStatus'], 'invalid_artifact');
  const sourceIdentity = identity(provenance.sourceIdentity, 'invalid_artifact');
  const registrationRef = ref(provenance.registration, 'invalid_artifact');
  const variant = native.get(entryIdentity.nativeId);
  requireValue(variant && sameIdentity(entryIdentity, variant.identity) && sameIdentity(sourceIdentity, variant.identity), 'invalid_artifact', 'record native identity mismatch');
  const name = textValue(row.name, 'invalid_artifact');
  requireValue(name === variant.name && sameRef(registrationRef, registration), 'invalid_artifact', 'record name or registration mismatch');
  requireValue(row.loadLabel === 'Load (unspecified basis)' && row.retired === false && provenance.loadBasis === 'unknown' && provenance.cueStatus === 'withheld', 'invalid_artifact', 'record qualification boundary mismatch');
  dataArray(row.requiredConstraints, 'invalid_artifact', 0);
  dataArray(row.cues, 'invalid_artifact', 0);
  return { id: domainId(row.id, 'invalid_artifact'), name, loadLabel: 'Load (unspecified basis)', retired: false,
    provenance: { sourceIdentity, registration: registrationRef, loadBasis: 'unknown', cueStatus: 'withheld' },
    requiredConstraints: [], cues: [] };
}
function readArtifact(owned: Uint8Array, pin: RegistrationPin, native: NativeMovementCatalog): readonly Entry[] {
  let decoded: unknown;
  try { decoded = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(owned)); }
  catch { throw new CatalogQualificationError('invalid_artifact', 'invalid registration JSON encoding'); }
  const root = fields(decoded, ['schema', 'id', 'revision', 'entries'], 'invalid_artifact');
  requireValue(root.schema === 'form.native-domain-registration/v1', 'invalid_artifact', 'unknown registration schema');
  const registration = ref({ id: root.id, revision: root.revision }, 'invalid_artifact');
  requireValue(sameRef(registration, pin), 'invalid_artifact', 'registration pin reference mismatch');
  const entries = dataArray(root.entries, 'invalid_artifact', Infinity).map(value => {
    const row = fields(value, ['exerciseId', 'sourceIdentity', 'recordDigest', 'record'], 'invalid_artifact');
    const exerciseId = domainId(row.exerciseId, 'invalid_artifact'), sourceIdentity = identity(row.sourceIdentity, 'invalid_artifact');
    const fullRecord = record(row.record, sourceIdentity, registration, native);
    requireValue(exerciseId === fullRecord.id, 'invalid_artifact', 'registered and embedded ID mismatch');
    const recordDigest = digest(row.recordDigest, 'invalid_artifact');
    requireValue(createHash('sha256').update(canonical(fullRecord), 'utf8').digest('hex') === recordDigest, 'invalid_artifact', 'canonical record digest mismatch');
    return { exerciseId, sourceIdentity, recordDigest, record: fullRecord };
  });
  requireValue(new Set(entries.map(entry => entry.exerciseId)).size === entries.length, 'invalid_artifact', 'duplicate registered Domain ID');
  return freeze(entries);
}
function projection(value: unknown): RegisteredDomainProjection {
  const row = fields(value, ['exerciseId', 'embeddedId', 'recordDigest', 'retired', 'registration', 'sourceIdentity', 'catalogRevision', 'currentness'], 'invalid_request');
  const registration = fields(row.registration, ['id', 'revision', 'digest'], 'invalid_request');
  requireValue(typeof row.retired === 'boolean', 'invalid_request', 'invalid persisted retirement state');
  requireValue(row.currentness === 'current' || row.currentness === 'stale' || row.currentness === 'unavailable', 'invalid_request', 'invalid registration currentness');
  return { exerciseId: domainId(row.exerciseId, 'invalid_request'), embeddedId: domainId(row.embeddedId, 'invalid_request'),
    recordDigest: digest(row.recordDigest, 'invalid_request'), retired: row.retired,
    registration: { ...ref({ id: registration.id, revision: registration.revision }, 'invalid_request'), digest: digest(registration.digest, 'invalid_request') },
    sourceIdentity: identity(row.sourceIdentity, 'invalid_request'), catalogRevision: textValue(row.catalogRevision, 'invalid_request'), currentness: row.currentness };
}

// Only trusted composition supplies independently accepted pins; deriving them from request bytes does not authenticate an artifact.
export function createRegisteredNativeCatalogFactory(trustedAcceptedPins: readonly RegistrationPin[] = []):
  (input: RegisteredNativeCatalogInput) => RegisteredNativeCatalog {
  const pins = freeze(dataArray(trustedAcceptedPins, 'invalid_policy', Infinity).map(readPin));
  requireValue(new Set(pins.map(pin => JSON.stringify([pin.id, pin.revision]))).size === pins.length && new Set(pins.map(pin => pin.digest)).size === pins.length, 'invalid_policy', 'duplicate or conflicting registration pins');
  return (input: RegisteredNativeCatalogInput): RegisteredNativeCatalog => {
    const values = fields(input, ['legacyBytes', 'registrationBytes'], 'invalid_artifact');
    const native = createNativeMovementCatalogFromRetained(values.legacyBytes as Uint8Array);
    const bytes = values.registrationBytes;
    requireValue(bytes === null || bytes instanceof Uint8Array, 'invalid_artifact', 'expected registration bytes or null');
    let registration: RegistrationPin | null = null;
    let entries: readonly Entry[] = [];
    const candidates = bytes === null ? [] : pins.filter(pin => pin.bytes === bytes.byteLength);
    if (bytes !== null && candidates.length > 0) {
      const owned = new Uint8Array(bytes);
      const hash = createHash('sha256').update(owned).digest('hex');
      const pin = candidates.find(candidate => candidate.digest === hash);
      if (pin) {
        entries = readArtifact(owned, pin, native);
        if (entries.length > 0) registration = pin;
      }
    }
    const index = new Map(entries.map(entry => [entry.exerciseId, entry]));
    return freeze({
      source: native.source, registration,
      getRegisteredRecord(exerciseId: string) { return index.get(domainId(exerciseId, 'invalid_request'))?.record ?? null; },
      bindRegisteredDomainExercise(input: RegisteredBindingRequest): RegisteredBinding {
        const row = fields(input, ['nativeId', 'exerciseId', 'active'], 'invalid_request');
        const nativeId = domainId(row.nativeId, 'invalid_request'), exerciseId = domainId(row.exerciseId, 'invalid_request');
        const active = row.active === null ? null : projection(row.active);
        const variant = native.get(nativeId), entry = index.get(exerciseId);
        const reasons: RegisteredBindingUnavailableReason[] = [];
        if (!registration) reasons.push('registry_unavailable');
        if (!variant) reasons.push('unknown_native_id');
        if (registration && !entry) reasons.push('unknown_exercise_id');
        if (!active) reasons.push('domain_absent');
        else {
          if (registration && (!sameRef(active.registration, registration) || active.registration.digest !== registration.digest)) reasons.push('unknown_registration');
          if (active.exerciseId !== exerciseId || active.embeddedId !== exerciseId) reasons.push('domain_id_mismatch');
          if (variant && (!sameIdentity(active.sourceIdentity, variant.identity) || (entry && !sameIdentity(entry.sourceIdentity, variant.identity)))) reasons.push('source_identity_mismatch');
          if (entry && active.recordDigest !== entry.recordDigest) reasons.push('record_digest_mismatch');
          if (active.retired) reasons.push('retired');
          if (active.currentness !== 'current') reasons.push('registration_not_current');
        }
        if (reasons.length > 0) return freeze({ schema: 'form.registered-native-binding/v1', status: 'unavailable', nativeId, exerciseId, reasons });
        return freeze({ schema: 'form.registered-native-binding/v1', status: 'bound', exerciseId, variantId: variant!.variantId,
          identity: variant!.identity, registration: { id: registration!.id, revision: registration!.revision, digest: registration!.digest },
          recordDigest: entry!.recordDigest, catalogRevision: active!.catalogRevision, qualificationScope: 'operational_identity_only' });
      },
    });
  };
}
