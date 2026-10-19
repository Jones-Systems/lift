import { confirmedCaptureKind, confirmedCaptureOperation, confirmedCaptureReceiptSchema, exportConfirmedCapture } from '../integration/first-plan/confirmed-capture.js';
import { z } from 'zod';
import { sourcePrescriptionPlanFields, sourcePrescriptionItem, savedSourcePlan, savedPlanRevision, savedSourceSet, sourcePerformance, resourceId } from '../schemas.js';
import { DomainError } from '../errors.js';
import { firstPlanOperation, firstPlanReceiptSchema } from '../integration/first-plan/contracts.js';
import type { Sqlite } from '../storage.js';
import type { AccountContext, ExportSnapshot, LifecycleAdapter, SafeExportSection } from './types.js';

export const ACCOUNT_EXPORT_MAX_BYTES = 16 * 1024 * 1024;
export type AccountExport = Readonly<{ json: string; bytes: number; snapshotAtMs: number; complete: false }>;
type Row = Record<string, unknown>;
type Category = { category: string; status: SafeExportSection['status']; count: number; omittedCount?: number; reason?: string };
type Projection = { category: string; from: string; fields: string; json?: string; shape?: readonly string[];
  predicate?: string; optionalTable?: string };

const profile = ['name', 'age', 'heightCm', 'weightKg', 'trainingBackground', 'trainingContext', 'injuryHistory', 'goals'];
const preferences = ['appMode', 'loadUnit', 'heightUnit', 'coachVoice', 'communication', 'trainingDaysPerWeek', 'sessionMinutes', 'equipment', 'remindersEnabled', 'mascot', 'animationStyle'];
const cues = ['kept', 'rejected', 'order', 'replacementRequested'];
const item = ['id', 'exerciseId', 'setTarget', 'repMin', 'repMax', 'targetKg'];
const plan = ['id', 'name', 'minutes', 'items', 'revision', 'archived', 'createdAt', 'updatedAt'];
const set = ['id', 'occurrenceId', 'setNumber', 'revision', 'reps', 'weightKg', 'status', 'createdAt', 'updatedAt'];
const claims = ['transactionId', 'originalTransactionId', 'bundleId', 'environment', 'productId', 'type', 'appAccountToken', 'inAppOwnershipType', 'purchaseDate', 'signedDate', 'quantity', 'expiresDate', 'revocationDate', 'revocationReason', 'isUpgraded'];
const receipt = [...profile, ...preferences, ...cues, ...plan, ...set, ...claims, 'step', 'answers', 'preferences', 'completedAt', 'status',
  'set', 'sessionRevision', 'planId', 'planRevision', 'planSnapshot', 'startedAt', 'occurrences', 'sets', 'itemId', 'position', 'target',
  'exerciseId', 'requiredConstraints', 'availableCues', 'text', 'grant', 'grants', 'charged', 'entitlement', 'source', 'sourceId', 'grantedAt',
  'expiresAt', 'active', 'purchases', 'serverDeliveryId'];

const projections: readonly Projection[] = [
  { category: 'identity', from: 'form_accounts a JOIN "user" u ON u.id=a.auth_user_id', fields: 'a.id AS accountId,u.name AS name,u.email AS email,u.emailVerified AS emailVerified,u.phoneNumber AS phoneNumber,u.phoneNumberVerified AS phoneNumberVerified,a.created_at AS createdAt' },
  { category: 'documents', from: 'documents', fields: 'kind,revision,data', json: 'data' },
  { category: 'documentRevisions', from: 'document_revisions', fields: 'kind,revision,data,created_at AS createdAt', json: 'data' },
  { category: 'plans', from: 'plans', fields: 'id,revision,archived,data,created_at AS createdAt,updated_at AS updatedAt', json: 'data', shape: plan },
  { category: 'planRevisions', from: 'plan_revisions', fields: 'plan_id AS planId,revision,data,created_at AS createdAt', json: 'data', shape: plan },
  { category: 'planItemIdentities', from: 'plan_item_ids', fields: 'plan_id AS planId,id,exercise_id AS exerciseId' },
  { category: 'workoutSessions', from: 'workout_sessions', fields: 'id,plan_id AS planId,plan_revision AS planRevision,revision,snapshot,status,started_at AS startedAt,completed_at AS completedAt', json: 'snapshot', shape: plan },
  { category: 'sessionOccurrences', from: 'session_occurrences', fields: 'session_id AS sessionId,id,item_id AS itemId,exercise_id AS exerciseId,position,target', json: 'target', shape: item },
  { category: 'performedSets', from: 'performed_sets', fields: 'session_id AS sessionId,id,occurrence_id AS occurrenceId,set_number AS setNumber,revision,reps,weight_kg AS weightKg,status,created_at AS createdAt,updated_at AS updatedAt' },
  { category: 'setRevisions', from: 'set_revisions', fields: 'session_id AS sessionId,set_id AS setId,revision,data,created_at AS createdAt', json: 'data', shape: set },
  { category: 'transcripts', from: 'transcription_attempts', fields: 'id,status,text,created_at AS createdAt,updated_at AS updatedAt' },
  { category: 'promoHistory', from: 'entitlement_grants', fields: 'id,entitlement,source,granted_at AS grantedAt,expires_at AS expiresAt,environment' },
  { category: 'operationHistory', from: 'command_receipts', fields: 'operation,status,result,created_at AS createdAt', json: 'result', shape: receipt },
  { category: 'purchaseOwners', from: 'apple_purchase_owners', fields: 'original_transaction_id AS originalTransactionId,bundle_id AS bundleId,environment,created_at_ms AS createdAtMs' },
  { category: 'purchaseTransactions', from: 'apple_purchase_transactions', fields: 'transaction_id AS transactionId,original_transaction_id AS originalTransactionId,product_id AS productId,product_type AS productType,app_account_token AS appAccountToken,purchase_date_ms AS purchaseDateMs,signed_date_ms AS signedDateMs,expires_date_ms AS expiresDateMs,revocation_date_ms AS revocationDateMs,is_upgraded AS isUpgraded,updated_at_ms AS updatedAtMs' },
  { category: 'purchaseGrants', from: 'apple_purchase_grants', fields: 'transaction_id AS transactionId,id,entitlement,granted_at_ms AS grantedAtMs' },
  { category: 'purchaseObservations', from: 'apple_purchase_observations o JOIN apple_purchase_transactions t ON t.transaction_id=o.transaction_id', fields: 'o.transaction_id AS transactionId,o.claims AS claims,o.observed_at_ms AS observedAtMs', json: 'claims', shape: claims },
  { category: 'purchaseCommands', from: 'apple_purchase_commands', fields: 'transaction_id AS transactionId,product_id AS productId' },
  { category: 'purchaseDeliveries', from: 'apple_purchase_deliveries', fields: 'transaction_id AS transactionId,server_delivery_id AS serverDeliveryId,product_id AS productId,delivered_at_ms AS deliveredAtMs' },
  { category: 'phoneChallengeHistory', from: 'phone_challenges', fields: 'phone,status,created_at AS createdAtMs,expires_at AS expiresAtMs,last_send_at AS lastSendAtMs,send_count AS sendCount,attempt_count AS attemptCount,approved_at AS approvedAtMs', predicate: 'auth_user_id=@authUserId' },
  { category: 'phoneOperationHistory', from: 'phone_operations o JOIN phone_challenges c ON c.id=o.challenge_id', fields: 'c.phone AS phone,o.operation AS operation,o.status AS status,o.created_at AS createdAtMs', predicate: 'c.auth_user_id=@authUserId' },
  { category: 'accountLifecycle', from: 'account_lifecycle', fields: 'state,epoch,disabled_at_ms AS disabledAtMs', optionalTable: 'account_lifecycle' },
  { category: 'deletionStatus', from: 'account_deletion_requests', fields: 'id,policy_version AS policyVersion,phase,requested_at_ms AS requestedAtMs,verified_at_ms AS verifiedAtMs,verification_method AS verificationMethod,disabled_at_ms AS disabledAtMs,local_purged_at_ms AS localPurgedAtMs,completed_at_ms AS completedAtMs', optionalTable: 'account_deletion_requests' },
  { category: 'deletionSteps', from: 'account_deletion_steps s JOIN account_deletion_requests r ON r.id=s.request_id', fields: 's.request_id AS requestId,s.category AS category,s.status AS status,s.retain_until_ms AS retainUntilMs,s.updated_at_ms AS updatedAtMs', predicate: 'r.account_id=@accountId', optionalTable: 'account_deletion_steps' },
];
const requiredAdapters = ['body', 'phone', 'activity', 'community', 'privacyChoices', 'deletionStatus'];
const forbidden = /password|credential|secret|hash|jws|oauth|otp|hmac|bearer|cookie|token|binding|private.?log|internal|raw.?body|raw.?coach|derived.?plan/i;

const sourceExportPlan = z.union([sourcePrescriptionPlanFields, savedSourcePlan, savedPlanRevision,
  sourcePrescriptionPlanFields.extend({ archived: z.boolean() }).strict()]);
function typedSource(value: Row): unknown {
  let result;
  if (Object.hasOwn(value, 'native') && Object.hasOwn(value, 'registeredDomain')) result = sourcePrescriptionItem.safeParse(value);
  else if (value.schema === 'form.source-prescription-plan/v1') result = sourceExportPlan.safeParse(value);
  else if (value.schema === 'form.source-performance/v1' || value.schema === 'form.source-performance/v2') result = sourcePerformance.safeParse(value);
  else if (value.schema === 'form.source-performed-set/v1' || value.schema === 'form.source-performed-set/v2') {
    if (Object.hasOwn(value, 'sessionId')) {
      const { sessionId, ...set } = value;
      const parsed = savedSourceSet.safeParse(set), session = resourceId.safeParse(sessionId);
      if (!parsed.success || !session.success) throw new DomainError(503, 'account_export_invalid_data');
      return { sessionId: session.data, ...parsed.data };
    }
    result = savedSourceSet.safeParse(value);
  } else {
    if (typeof value.schema === 'string' && value.schema.startsWith('form.source-')) throw new DomainError(503, 'account_export_invalid_data');
    return undefined;
  }
  if (!result.success) throw new DomainError(503, 'account_export_invalid_data');
  return result.data;
}

function packagingRequired(): never { throw new DomainError(413, 'account_export_packaging_required'); }

// Tokens are bounded before joining; even JSON escaping cannot allocate a huge string first.
class JsonBudget {
  readonly parts: string[] = [];
  bytes = 0;
  constructor(readonly maximum: number) {}
  add(token: string): void {
    const size = Buffer.byteLength(token, 'utf8');
    if (size > this.maximum - this.bytes) packagingRequired();
    this.parts.push(token); this.bytes += size;
  }
  string(value: string): void {
    this.add('"');
    for (let offset = 0; offset < value.length;) {
      let end = Math.min(offset + 1024, value.length);
      const last = value.charCodeAt(end - 1);
      if (end < value.length && last >= 0xd800 && last <= 0xdbff) end--;
      this.add(JSON.stringify(value.slice(offset, end)).slice(1, -1)); offset = end;
    }
    this.add('"');
  }
  value(value: unknown, allowed?: readonly string[], omitted?: () => void, depth = 0,
    captureBindingPath?: readonly string[]): void {
    if (depth > 64) packagingRequired();
    if (value === null) { this.add('null'); return; }
    if (typeof value === 'string') { this.string(value); return; }
    if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) { this.add(String(value)); return; }
    if (Array.isArray(value)) {
      this.add('[');
      for (let i = 0; i < value.length; i++) { if (i) this.add(','); this.value(value[i], allowed, omitted, depth + 1); }
      this.add(']'); return;
    }
    if (typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype)
      throw new DomainError(503, 'account_export_invalid_data');
    const source = typedSource(value as Row);
    if (source !== undefined) { value = source; allowed = undefined; }
    this.add('{'); let first = true;
    for (const key of Object.keys(value as Row)) {
      const onCaptureBindingPath = captureBindingPath?.[0] === key;
      const publicBindingKey = onCaptureBindingPath && (key === 'contentBinding' || key === 'bindingDigest');
      if ((key !== 'appAccountToken' && !publicBindingKey && forbidden.test(key)) || key === '__proto__' || key === 'constructor' || key === 'prototype' || (allowed && !allowed.includes(key))) {
        omitted?.(); continue;
      }
      if (!first) this.add(','); first = false; this.string(key); this.add(':');
      const nested = allowed === undefined ? undefined
        : key === 'items' || key === 'target' ? item : key === 'answers' ? profile : key === 'preferences' ? preferences : allowed;
      this.value((value as Row)[key], nested, omitted, depth + 1,
        onCaptureBindingPath ? captureBindingPath?.slice(1) : undefined);
    }
    this.add('}');
  }
}

/** Synchronous only. Caller releases returned bytes immediately, with no await between this check and send. */
export function buildAccountExport(db: Sqlite, context: AccountContext, assertActive: (context: AccountContext) => void,
  adapters: readonly LifecycleAdapter[] = [], maxBytes = ACCOUNT_EXPORT_MAX_BYTES): AccountExport {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > ACCOUNT_EXPORT_MAX_BYTES)
    throw new DomainError(422, 'invalid_account_export_limit');
  if (db.inTransaction) throw new DomainError(503, 'account_export_requires_outermost_snapshot');
  assertActive(context);
  const result = db.transaction(() => {
    const mapping = db.prepare('SELECT id FROM form_accounts WHERE id=? AND auth_user_id=?').get(context.accountId, context.authUserId);
    if (!mapping) throw new DomainError(403, 'account_session_mismatch');
    const snapshotAtMs = Date.now();
    const output = new JsonBudget(maxBytes);
    const categories = new Map<string, Category>();
    const absentSchema: string[] = [];
    let omittedFields = 0;
    output.add('{"records":[');
    let records = 0;
    const append = (category: string, value: unknown, shape?: readonly string[], captureBindingPath?: readonly string[]): void => {
      if (records++) output.add(',');
      output.add('{"category":'); output.string(category); output.add(',"value":');
      output.value(value, shape, () => omittedFields++, 0, captureBindingPath); output.add('}');
      const entry = categories.get(category);
      if (!entry) throw new DomainError(503, 'account_export_invalid_category');
      entry.count++;
    };
    for (const source of projections) {
      if (source.optionalTable && !db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(source.optionalTable)) {
        absentSchema.push(source.category); continue;
      }
      const entry: Category = { category: source.category, status: 'complete', count: 0 };
      categories.set(source.category, entry);
      const predicate = source.predicate ?? (source.category === 'identity' ? 'a.id=@accountId' : source.category === 'purchaseObservations' ? 't.account_id=@accountId' : 'account_id=@accountId');
      const performanceColumn = source.category === 'performedSets' &&
        (db.prepare('PRAGMA table_info(performed_sets)').all() as { name: string }[]).some(column => column.name === 'performance');
      const fields = source.fields + (performanceColumn ? ',performance' : '');
      const query = `SELECT ${fields} FROM ${source.from} WHERE ${predicate}`;
      // Static projections only. SQLite suppresses oversized values before transferring a row to JS/JSON.parse.
      const names = fields.split(',').map(field => field.trim().split(/\s+AS\s+/i).at(-1)!.split('.').at(-1)!);
      const size = names.map(name => `coalesce(length(CAST("${name}" AS BLOB)),0)`).join('+');
      const boundedFields = names.map(name => `CASE WHEN (${size})<=@limit THEN "${name}" ELSE NULL END AS "${name}"`).join(',');
      // No ORDER BY: an unbounded SQLite sorter could spill export scratch to disk before iteration.
      const statement = db.prepare(`SELECT (${size})>@limit AS oversized,${boundedFields} FROM (${query})`);
      const owner = predicate.includes('@authUserId') ? { authUserId: context.authUserId } : { accountId: context.accountId };
      for (const raw of statement.iterate({ limit: maxBytes, ...owner })) {
        const row = raw as Row;
        let captureBindingPath: readonly string[] | undefined;
        if (row.oversized) packagingRequired();
        delete row.oversized;
        if (performanceColumn) {
          const performance = row.performance; delete row.performance;
          if (performance !== null) {
            if (typeof performance !== 'string' || row.reps !== null || row.weightKg !== null)
              throw new DomainError(503, 'account_export_invalid_data');
            let decoded: unknown;
            try { decoded = JSON.parse(performance) as unknown; } catch { throw new DomainError(503, 'account_export_invalid_data'); }
            delete row.reps; delete row.weightKg;
            const parsed = sourcePerformance.safeParse(decoded);
            if (!parsed.success) throw new DomainError(503, 'account_export_invalid_data');
            row.schema = parsed.data.schema === 'form.source-performance/v1' ? 'form.source-performed-set/v1' : 'form.source-performed-set/v2';
            row.performance = parsed.data;
            typedSource(row);
          }
        }
        if (source.json) {
          const serialized = row[source.json];
          if (typeof serialized !== 'string') throw new DomainError(503, 'account_export_invalid_data');
          if (Buffer.byteLength(serialized, 'utf8') > maxBytes - output.bytes) packagingRequired();
          let shape = source.shape;
          if (source.category === 'documents' || source.category === 'documentRevisions') {
            const kind = row.kind;
            shape = kind === 'profile' ? profile : kind === 'preferences' ? preferences : kind === 'onboarding'
              ? ['step', 'answers', 'preferences', 'status', 'completedAt', 'trainingContext'] : typeof kind === 'string' && kind.startsWith('cues:') ? cues : undefined;
            if (!shape && kind !== confirmedCaptureKind) {
              entry.status = 'pending'; entry.reason = 'document_kind_requires_safe_projection';
              entry.omittedCount = (entry.omittedCount ?? 0) + 1; continue;
            }
          }
          let parsed: unknown;
          try { parsed = JSON.parse(serialized) as unknown; }
          catch { throw new DomainError(503, 'account_export_invalid_data'); }
          if ((source.category === 'documents' || source.category === 'documentRevisions') && row.kind === confirmedCaptureKind) {
            try {
              const capture = exportConfirmedCapture(parsed);
              if (capture.pin.accountId !== context.accountId || capture.pin.revision !== String(row.revision))
                throw new DomainError(503, 'account_export_invalid_data');
              parsed = capture;
              captureBindingPath = ['contentBinding', 'bindingDigest'];
            }
            catch { throw new DomainError(503, 'account_export_invalid_data'); }
            shape = undefined;
          }
          if (source.category === 'operationHistory' && row.operation === confirmedCaptureOperation) {
            const receipt = confirmedCaptureReceiptSchema.safeParse(parsed);
            if (!receipt.success || receipt.data.capture.pin.accountId !== context.accountId)
              throw new DomainError(503, 'account_export_invalid_data');
            parsed = receipt.data; shape = undefined;
            captureBindingPath = ['capture', 'contentBinding', 'bindingDigest'];
          }
          if (source.category === 'sessionOccurrences' && parsed && typeof parsed === 'object' && 'registeredDomain' in parsed) {
            const target = sourcePrescriptionItem.safeParse(parsed);
            if (!target.success) throw new DomainError(503, 'account_export_invalid_data');
            parsed = target.data; shape = undefined;
          }
          if (source.category === 'operationHistory' && row.operation === firstPlanOperation) {
            const receipt = firstPlanReceiptSchema.safeParse(parsed);
            if (!receipt.success) throw new DomainError(503, 'account_export_invalid_data');
            parsed = receipt.data;
            shape = [...plan, ...item, 'plan', 'provenance', 'schema', 'contextKey', 'selectedCandidateId',
              'profileRevision', 'preferencesRevision', 'sources', 'candidates', 'status', 'gapCodes'];
          }
          const safe = new JsonBudget(maxBytes - output.bytes);
          // Only the validated account-bound capture branches supply this exact public binding path.
          safe.value(parsed, shape, () => omittedFields++, 0, captureBindingPath);
          // Parse only the already bounded safe projection; append never receives raw persisted JSON.
          row[source.json] = JSON.parse(safe.parts.join('')) as unknown;
        }
        append(source.category, row, undefined,
          captureBindingPath && source.json ? [source.json, ...captureBindingPath] : undefined);
      }
    }
    const snapshot: ExportSnapshot = { snapshotAtMs, append: (category, value) => append(category, value) };
    for (const adapter of adapters) {
      if (!/^[A-Za-z][A-Za-z0-9_.:-]{0,79}$/.test(adapter.category) || categories.has(adapter.category))
        throw new DomainError(503, 'account_export_invalid_category');
      const entry: Category = { category: adapter.category, status: 'pending', count: 0, reason: 'adapter_not_finished' };
      categories.set(adapter.category, entry);
      let open = true;
      const scoped: ExportSnapshot = { snapshotAtMs: snapshot.snapshotAtMs, append: (category, value) => {
        if (!open || category !== adapter.category) throw new DomainError(503, 'account_export_invalid_category');
        snapshot.append(category, value);
      } };
      let section: SafeExportSection;
      try { section = adapter.export(context, scoped); } finally { open = false; }
      if (section.category !== adapter.category || !['complete', 'pending', 'unavailable', 'unknown', 'retained'].includes(section.status))
        throw new DomainError(503, 'account_export_invalid_adapter');
      entry.status = section.status;
      if (section.status === 'complete') delete entry.reason;
      else entry.reason = adapter.category === 'body' && section.reason === 'manual_retention_metadata_omitted'
        ? 'manual_retention_metadata_omitted' : `adapter_reported_${section.status}`;
    }
    for (const category of requiredAdapters) if (!categories.has(category))
      categories.set(category, { category, status: 'unavailable', count: 0, reason: 'qualified_adapter_not_supplied' });
    for (const category of absentSchema) if (!categories.has(category))
      categories.set(category, { category, status: 'unavailable', count: 0, reason: 'lifecycle_schema_not_present' });
    output.add('],"manifest":');
    output.value({ schemaVersion: 'form.account-export.v1', snapshotAtMs, complete: false,
      scope: { accountId: context.accountId, epoch: context.epoch },
      provenance: { source: 'account-scoped-sqlite-read-transaction', consistency: 'single-connection-snapshot',
        authorization: 'caller-authoritative-session-epoch-suppression-before-generation-and-release', adapterConsistency: 'caller-qualified-synchronous-adapters' },
      categories: [...categories.values()],
      omissions: [{ category: 'authenticationAndInternalEvidence', reason: 'credentials_sessions_oauth_otp_hashes_raw_proofs_internal_secrets_private_logs_excluded' },
        { category: 'unprojectedFields', reason: 'safe_field_projection', count: omittedFields },
        ...[...categories.values()].filter(entry => entry.status !== 'complete').map(entry => ({ category: entry.category, reason: entry.reason }))],
      residuals: [{ category: 'purchaseRawProofs', status: 'retained', reason: 'immutable_evidence_not_in_export' },
        { category: 'unboundPhoneChallenges', status: 'unavailable', reason: 'exact_subject_attribution_requires_qualified_phone_adapter' },
        { category: 'backupsAndExternalProviders', status: 'unavailable', reason: 'no_qualified_snapshot_or_retention_adapter' },
        { category: 'deviceCopies', status: 'unavailable', reason: 'outside_server_snapshot' }],
    });
    output.add('}');
    return { json: output.parts.join(''), bytes: output.bytes, snapshotAtMs, complete: false as const };
  }).deferred();
  // This must run after COMMIT: checking a revoked session inside the snapshot can see stale authority.
  assertActive(context);
  return result;
}
