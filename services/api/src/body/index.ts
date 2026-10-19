import { MANUAL_RETENTION_PROTOCOL, MANUAL_RETENTION_STATEMENT_BINDING, MANUAL_RETENTION_CAPABILITY_SCHEMA } from './manual-retention-contract.js';
import { DomainError } from '../errors.js';
import type { BodyAccountContext } from './schemas.js';

export * from './schemas.js';

export const bodyOperations = [
  'upload_photo', 'infer_assessment', 'save_manual_measurement', 'save_assessment',
  'list_progress', 'delete_assessment', 'export_body_data', 'update_retention',
  'revoke_improvement_consent', 'contribute_improvement',
] as const;
export type BodyOperation = typeof bodyOperations[number];
export type BodyUnavailableReason = 'native_privacy_unqualified' | 'measurement_method_unqualified' |
  'protective_storage_and_deletion_unqualified' | 'external_provider_unqualified' |
  'improvement_lifecycle_unqualified' | 'account_deletion_unavailable' | 'client_only';
export type BodyCapabilityStatus = 'available' | 'unavailable';

function unavailable(reason: BodyUnavailableReason) {
  return { status: 'unavailable' as const, qualification: 'unqualified' as const, reason };
}

export function bodyCapabilities(manualMeasurementsEnabled = false, manualRetentionEnabled = false) {
  return {
    schema: 'form.body-capabilities/v1' as const,
    manualRetention: { schema: MANUAL_RETENTION_CAPABILITY_SCHEMA, protocol: MANUAL_RETENTION_PROTOCOL,
      status: manualMeasurementsEnabled && manualRetentionEnabled ? 'available' as const : 'unavailable' as const,
      statement: MANUAL_RETENTION_STATEMENT_BINDING,
      grant: manualMeasurementsEnabled && manualRetentionEnabled ? 'available' as const : 'unavailable' as const,
      revoke: manualMeasurementsEnabled && manualRetentionEnabled ? 'available' as const : 'unavailable' as const,
      current: manualMeasurementsEnabled && manualRetentionEnabled ? 'available' as const : 'unavailable' as const,
    },
    operations: Object.fromEntries(['save_manual_measurement', 'list_progress', 'delete_assessment', 'export_body_data'].map(operation => [operation, manualMeasurementsEnabled && (operation !== 'save_manual_measurement' || manualRetentionEnabled) ? { status: 'available', provenance: 'manual_reported', scope: 'manual_only' } : unavailable('protective_storage_and_deletion_unqualified')])),
    serverProcessing: unavailable('protective_storage_and_deletion_unqualified'),
    strictNoSave: { serverRequestsAllowed: false, nativeCapture: unavailable('native_privacy_unqualified'),
      manualProcessingLocation: 'client_ephemeral_only' as const, nativeZeroPersistenceVerified: false },
    constructs: {
      manualExternalLengths: { ...unavailable('client_only'), provenance: 'manual_reported' as const },
      reportedExternalRatios: unavailable('client_only'),
      projectedImageGeometry: unavailable('measurement_method_unqualified'),
      calibratedPhysicalSegments: unavailable('measurement_method_unqualified'),
      anatomicalFemur: unavailable('measurement_method_unqualified'),
      hipPelvicSymmetry: unavailable('measurement_method_unqualified'),
      pelvicTilt: unavailable('measurement_method_unqualified'),
      postureAssessment: unavailable('measurement_method_unqualified'),
      postureDrivenPrescription: unavailable('measurement_method_unqualified'),
    },
    photoUpload: unavailable('protective_storage_and_deletion_unqualified'),
    inference: unavailable('measurement_method_unqualified'),
    retainedMeasurements: manualMeasurementsEnabled ? { status: 'available' as const, provenance: 'manual_reported' as const, scope: 'manual_only' as const } : unavailable('protective_storage_and_deletion_unqualified'),
    progress: manualMeasurementsEnabled ? { status: 'available' as const, provenance: 'manual_reported' as const, scope: 'manual_only' as const } : unavailable('protective_storage_and_deletion_unqualified'),
    bodyDeletion: manualMeasurementsEnabled ? { status: 'available' as const, provenance: 'manual_reported' as const, scope: 'manual_only' as const } : unavailable('protective_storage_and_deletion_unqualified'),
    bodyExport: manualMeasurementsEnabled ? { status: 'available' as const, provenance: 'manual_reported' as const, scope: 'manual_only' as const } : unavailable('protective_storage_and_deletion_unqualified'),
    accountDeletion: unavailable('account_deletion_unavailable'),
    externalProvider: unavailable('external_provider_unqualified'),
    sharedSystemImprovement: unavailable('improvement_lifecycle_unqualified'),
  };
}

const ownerFields = ['accountId', 'account_id', 'ownerId', 'owner_id', 'userId', 'user_id', 'email'];
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireAccount(context: BodyAccountContext | null | undefined): void {
  if (!context || typeof context.accountId !== 'string' || context.accountId.trim().length === 0) {
    throw new DomainError(401, 'body_authentication_required');
  }
}

// Root must call before receipt lookup, storage.command, payload logging or persistence.
// The context comes from verified root routing, never from a request body.
export function rejectBodyOperation(context: BodyAccountContext | null | undefined,
  operation: BodyOperation, input?: unknown): never {
  requireAccount(context);
  if (record(input)) {
    const choices = record(input.choices) ? input.choices : undefined;
    if (input.retention === 'no_save' || choices?.retention === 'no_save') {
      throw new DomainError(403, 'body_no_save_server_request_forbidden');
    }
    if (ownerFields.some(field => Object.hasOwn(input, field))) {
      throw new DomainError(422, 'body_owner_identity_forbidden');
    }
  }
  if (!bodyOperations.includes(operation)) throw new DomainError(422, 'body_operation_invalid');
  if (operation === 'upload_photo') throw new DomainError(501, 'body_photo_upload_unavailable');
  if (operation === 'infer_assessment') throw new DomainError(501, 'body_inference_unavailable');
  if (operation === 'contribute_improvement' || operation === 'revoke_improvement_consent') {
    throw new DomainError(501, 'body_improvement_unavailable');
  }
  throw new DomainError(501, 'body_retention_unavailable');
}

export const bodyDomain = Object.freeze({ capabilities: bodyCapabilities, reject: rejectBodyOperation });
