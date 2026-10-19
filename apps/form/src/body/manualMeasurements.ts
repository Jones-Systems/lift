import { ApiError, captureFormRequestAttemptContext, type FormRequestAttemptContext } from '../api/transport';

import { captureManualRetentionGrantPayload, captureManualRetentionRevokePayload, captureManualRetentionCommandResult, captureManualRetentionCurrentResult, isManualRetentionDecisionId, type ManualRetentionGrantPayload, type ManualRetentionRevokePayload, type ManualRetentionCommandResult, type ManualRetentionCurrentResult, captureManualRetentionCapability } from './manualRetentionContract';
import { validateManualRetentionCommandConfirmation } from './manualRetentionConfirmation';

export type GrantManualRetentionCommand = Readonly<{ key: string; payload: ManualRetentionGrantPayload }>;
export type RevokeManualRetentionCommand = Readonly<{ key: string; decisionId: string; payload: ManualRetentionRevokePayload }>;
export type ManualRetentionAvailability = Readonly<{ grant: boolean; revoke: boolean; current: boolean }>;
export type CircumferenceKind = 'waist' | 'hips' | 'chest' | 'thigh' | 'upper_arm';
export type ManualMeasurementInput = Readonly<{
  value: number;
  measuredOn: string;
  note?: string;
} & ({ kind: CircumferenceKind; unit: 'cm' | 'in' } | { kind: 'weight'; unit: 'kg' | 'lb' })>;
export type ManualMeasurement = Readonly<{
  id: string;
  kind: CircumferenceKind | 'weight';
  value: number;
  unit: 'cm' | 'kg';
  originalUnit: 'cm' | 'in' | 'kg' | 'lb';
  measuredOn: string;
  note: string | null;
  provenance: 'manual_reported';
}>;
export type MeasurementRange = Readonly<{ from?: string; to?: string }>;
export type CreateMeasurementCommand = Readonly<{ key: string; payload: ManualMeasurementInput }>;
export type DeleteMeasurementCommand = Readonly<{
  id: string;
  key: string;
  payload: Readonly<Record<string, never>>;
}>;
export type ManualMeasurementAvailability = Readonly<{ create: boolean; list: boolean; delete: boolean }>;
export interface ManualMeasurementTransport {
  captureAuthContext(): { isCurrent(): boolean };
  request<T = unknown>(path: string, method?: string, body?: unknown, key?: string, attemptContext?: FormRequestAttemptContext): Promise<T>;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function retentionCapability(value: unknown): ManualRetentionAvailability {
  const capability = captureManualRetentionCapability(value);
  const available = capability?.status === 'available';
  return Object.freeze({ grant: available, revoke: available, current: available });
}

function manualAvailable(value: unknown): boolean {
  const capability = record(value);
  return capability?.status === 'available' && capability.scope === 'manual_only'
    && capability.provenance === 'manual_reported';
}

export function createManualMeasurementsClient(deps: {
  transport: ManualMeasurementTransport;
  isCurrentSession(): boolean;
}) {
  const { transport, isCurrentSession } = deps;
  const auth = transport.captureAuthContext();
  let closed = false;
  const current = () => !closed && auth.isCurrent() && isCurrentSession();
  const changed = (originalEffectUnknown = false) => new ApiError(409, 'session_changed',
    'The account session changed. Check the original account before repeating a change.', false, originalEffectUnknown);
  const assertCurrent = () => { if (!current()) throw changed(); };

  async function request<T>(path: string, method = 'GET', payload?: unknown, key?: string, attemptContext?: FormRequestAttemptContext): Promise<T> {
    assertCurrent();
    const write = method !== 'GET';
    try {
      const result = await transport.request<T>(path, method, payload, key, attemptContext);
      if (!current()) throw changed(write);
      return result;
    } catch (error) {
      if (!current()) throw changed(write || (error instanceof ApiError
        && (error.effectUnknown || error.originalEffectUnknown)));
      if (error instanceof ApiError) throw error;
      throw new ApiError(0, 'body_request_unconfirmed',
        'The result could not be confirmed. Check this action before retrying.', write);
    }
  }

  async function capabilityResponse() {
    const response = record(await request<unknown>('/v1/body/capabilities'));
    assertCurrent();
    const operations = record(response?.operations);
    const valid = response?.schema === 'form.body-capabilities/v1';
    const retention = retentionCapability(valid ? response?.manualRetention : undefined);
    return { retention, protocolSupported: valid && captureManualRetentionCapability(response?.manualRetention) !== null, measurements: Object.freeze({
      create: retention.grant && retention.revoke && retention.current && valid && manualAvailable(response?.retainedMeasurements) && manualAvailable(operations?.save_manual_measurement),
      list: valid && manualAvailable(response?.progress) && manualAvailable(operations?.list_progress),
      delete: valid && manualAvailable(response?.bodyDeletion) && manualAvailable(operations?.delete_assessment),
    }) };
  }

  const capabilities = async (): Promise<ManualMeasurementAvailability> => (await capabilityResponse()).measurements;
  const retentionCapabilities = async (): Promise<ManualRetentionAvailability> => (await capabilityResponse()).retention;

  async function requireCapability(operation: keyof ManualMeasurementAvailability): Promise<void> {
    const available = await capabilities();
    assertCurrent();
    if (!available[operation]) throw new ApiError(501, 'body_retention_unavailable',
      'Saved manual measurements are not available for this operation.');
  }

  // Retry identity belongs to the caller; this client never generates keys, queues writes or retries them.
  async function create(command: CreateMeasurementCommand, attemptContext?: FormRequestAttemptContext): Promise<ManualMeasurement> {
    assertCurrent();
    const context = captureFormRequestAttemptContext(attemptContext);
    if (!context) throw new ApiError(409, 'body_retention_authority_required', 'A manual retention attempt context is required.');
    const key = command.key, payload = Object.freeze({ ...command.payload });
    if (context.manualRetention === null) {
      if (!(await capabilityResponse()).protocolSupported) throw new ApiError(501, 'body_retention_unavailable', 'Manual receipt reconciliation is unavailable.');
    } else await requireCapability('create');
    context.assertCurrent();
    return request<ManualMeasurement>('/v1/body/measurements', 'POST', payload, key, context);
  }

  async function list(range: MeasurementRange = {}): Promise<{ items: ManualMeasurement[] }> {
    assertCurrent();
    const query = new URLSearchParams();
    if (range.from !== undefined) query.set('from', range.from);
    if (range.to !== undefined) query.set('to', range.to);
    const search = query.toString(), suffix = search ? `?${search}` : '';
    await requireCapability('list');
    return request<{ items: ManualMeasurement[] }>(`/v1/body/measurements${suffix}`);
  }

  async function remove(command: DeleteMeasurementCommand): Promise<{ deleted: true }> {
    assertCurrent();
    const key = command.key, id = command.id, payload = Object.freeze({ ...command.payload });
    await requireCapability('delete');
    return request<{ deleted: true }>(`/v1/body/measurements/${encodeURIComponent(id)}/delete`, 'POST', payload, key);
  }

  async function grantRetention(command: GrantManualRetentionCommand): Promise<ManualRetentionCommandResult> {
    assertCurrent();
    const key = command.key, payload = captureManualRetentionGrantPayload(command.payload);
    if (!payload) throw new ApiError(422, 'invalid_manual_retention', 'The manual retention decision is invalid.');
    if (!(await retentionCapabilities()).grant) throw new ApiError(501, 'body_retention_unavailable', 'Manual retention grants are unavailable.');
    const response = await request('/v1/body/manual-retention', 'POST', payload, key);
    const intent = { operation: 'grant_manual_retention', command: { key, payload } } as const;
    if (!validateManualRetentionCommandConfirmation(intent, response)) throw new ApiError(502, 'body_retention_unconfirmed', 'The retention result could not be confirmed.', true);
    return captureManualRetentionCommandResult(response)!;
  }
  async function revokeRetention(command: RevokeManualRetentionCommand): Promise<ManualRetentionCommandResult> {
    assertCurrent();
    const key = command.key, decisionId = command.decisionId, payload = captureManualRetentionRevokePayload(command.payload);
    if (!payload || !isManualRetentionDecisionId(decisionId)) throw new ApiError(422, 'invalid_manual_retention', 'The manual retention decision is invalid.');
    if (!(await retentionCapabilities()).revoke) throw new ApiError(501, 'body_retention_unavailable', 'Manual retention revocation is unavailable.');
    const response = await request(`/v1/body/manual-retention/${decisionId}/revoke`, 'POST', payload, key);
    const intent = { operation: 'revoke_manual_retention', command: { key, decisionId, payload } } as const;
    if (!validateManualRetentionCommandConfirmation(intent, response)) throw new ApiError(502, 'body_retention_unconfirmed', 'The retention result could not be confirmed.', true);
    return captureManualRetentionCommandResult(response)!;
  }
  async function currentRetention(decisionId: string): Promise<ManualRetentionCurrentResult> {
    assertCurrent();
    if (!isManualRetentionDecisionId(decisionId)) throw new ApiError(422, 'invalid_manual_retention', 'The manual retention decision is invalid.');
    if (!(await retentionCapabilities()).current) throw new ApiError(501, 'body_retention_unavailable', 'Manual retention status is unavailable.');
    const result = captureManualRetentionCurrentResult(await request(`/v1/body/manual-retention/${decisionId}`));
    if (!result || result.current !== null && result.current.decisionId !== decisionId)
      throw new ApiError(502, 'body_retention_unconfirmed', 'The retention status could not be confirmed.');
    return result;
  }

  // Terminal for this captured session, including pending results; resuming needs a new client instance.
  const clear = () => { closed = true; };
  return Object.freeze({ capabilities, retentionCapabilities, create, list, delete: remove, grantRetention, revokeRetention, currentRetention, clear, dispose: clear });
}
