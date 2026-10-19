import type { createCommandCustody, CommandAttempt, CommandCustodyId, CommandMetadata, CommandIntent } from '../integration/commandCustody';
import { ApiError, type ManualMeasurementAttemptContext, type FormRequestAttemptContext } from '../api/transport';
import {
  createManualMeasurementsClient,
  type CircumferenceKind, type ManualMeasurement, type ManualMeasurementAvailability,
  type ManualMeasurementInput, type ManualMeasurementTransport, type MeasurementRange,
  type CreateMeasurementCommand, type DeleteMeasurementCommand, type GrantManualRetentionCommand, type RevokeManualRetentionCommand,
} from './manualMeasurements';
import { createRetentionSession, retentionPermission, retentionReducer, manualRetentionAuthority, type RetentionFence, type RetentionState } from './retention';

import { MANUAL_RETENTION_PROTOCOL, captureManualRetentionCommandResult } from './manualRetentionContract';

export type ManualProgressError = Readonly<{
  code: string; status: number; effectUnknown: boolean; originalEffectUnknown: boolean;
}>;
export type ManualProgressState =
  | Readonly<{ status: 'idle' | 'loading' | 'unavailable' }>
  | Readonly<{ status: 'empty'; items: readonly ManualMeasurement[] }>
  | Readonly<{ status: 'data'; items: readonly ManualMeasurement[] }>
  | Readonly<{ status: 'error'; error: ManualProgressError }>;
export type ManualCapabilityState = Readonly<{
  status: 'unavailable' | 'loading' | 'ready' | 'error';
  value: ManualMeasurementAvailability;
  error?: ManualProgressError;
}>;
export type ManualProgressSnapshot = Readonly<{
  active: boolean;
  presentationOpen: boolean;
  retention: RetentionState | null;
  capabilities: ManualCapabilityState;
  progress: ManualProgressState;
  // Server availability remains separate from original-session command custody.
  writes: Readonly<{ available: false; reason: 'command_owner_unbound' | 'command_owner_unavailable' }>
    | Readonly<{ available: true; commands: readonly CommandMetadata[]; error?: ManualProgressError }>;
}>;

const unavailable: ManualMeasurementAvailability = Object.freeze({ create: false, list: false, delete: false });
const writes = Object.freeze({ available: false, reason: 'command_owner_unbound' } as const);
const kinds: readonly (CircumferenceKind | 'weight')[] = ['waist', 'hips', 'chest', 'thigh', 'upper_arm', 'weight'];
function civilDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}
function measurement(value: unknown): value is ManualMeasurement {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  const weight = row.kind === 'weight';
  return typeof row.id === 'string' && row.id.length > 0 && kinds.includes(row.kind as CircumferenceKind | 'weight')
    && typeof row.value === 'number' && Number.isFinite(row.value) && row.value > 0
    && row.unit === (weight ? 'kg' : 'cm')
    && (weight ? row.originalUnit === 'kg' || row.originalUnit === 'lb' : row.originalUnit === 'cm' || row.originalUnit === 'in')
    && civilDate(row.measuredOn) && (row.note === null || typeof row.note === 'string') && row.provenance === 'manual_reported';
}
function listResult(value: unknown): readonly ManualMeasurement[] {
  const items = value && typeof value === 'object' && !Array.isArray(value)
    ? (value as { items?: unknown }).items : undefined;
  if (!Array.isArray(items) || items.length > 10000 || !items.every(measurement)
    || new Set(items.map(item => item.id)).size !== items.length)
    throw new ApiError(502, 'body_invalid_progress_response', 'Manual progress could not be confirmed.');
  return Object.freeze(items.map(item => Object.freeze({ id: item.id, kind: item.kind, value: item.value,
    unit: item.unit, originalUnit: item.originalUnit, measuredOn: item.measuredOn, note: item.note, provenance: item.provenance })));
}
const errorInfo = (error: unknown): ManualProgressError => Object.freeze(error instanceof ApiError
  ? { code: error.code, status: error.status, effectUnknown: error.effectUnknown, originalEffectUnknown: error.originalEffectUnknown }
  : { code: 'body_request_unconfirmed', status: 0, effectUnknown: false, originalEffectUnknown: false });

export function createManualProgressController(deps: {
  accountId: string;
  sessionGeneration: string | number;
  transport: ManualMeasurementTransport;
  isCurrentSession(): boolean;
  commandOwner?: ReturnType<typeof createCommandCustody> | null;
}) {
  const { accountId, sessionGeneration, transport, isCurrentSession } = deps;
  const auth = transport.captureAuthContext();
  const owner = deps.commandOwner;
  const access = Object.freeze({ accountId, sessionGeneration });
  // Presentation-local duplicate-ID fence only; command/result custody stays with the original host owner.
  const usedDecisions = new Set<string>();
  let commandError: ManualProgressError | undefined;
  let active = true, presentationOpen = true;
  let retention = createRetentionSession(accountId);
  let capabilities: ManualCapabilityState = Object.freeze({ status: 'unavailable', value: unavailable });
  let progress: ManualProgressState = Object.freeze({ status: 'idle' });
  let capabilityRequest = 0, progressRequest = 0;
  const listeners = new Set<() => void>();
  const current = () => active && auth.isCurrent() && isCurrentSession();
  const fence = () => ({ accountId, generation: retention.generation });
  const makeClient = () => {
    const generation = retention.generation;
    return createManualMeasurementsClient({ transport,
      isCurrentSession: () => current() && retention.generation === generation });
  };
  let client = makeClient();
  function commandSnapshot(): ManualProgressSnapshot['writes'] {
    if (!owner) return writes;
    if (!active) return Object.freeze({ available: false, reason: 'command_owner_unavailable' });
    try { return Object.freeze({ available: true, commands: owner.snapshot(access), ...(commandError ? { error: commandError } : {}) }); }
    catch { return Object.freeze({ available: false, reason: 'command_owner_unavailable' }); }
  }
  const snapshotValue = (): ManualProgressSnapshot => Object.freeze({ active, presentationOpen,
    retention: active ? retention : null, capabilities, progress, writes: commandSnapshot() });
  let snapshot = snapshotValue();
  function publish() {
    snapshot = snapshotValue();
    for (const listener of listeners) listener();
  }
  function resetReads() {
    capabilityRequest++; progressRequest++;
    capabilities = Object.freeze({ status: 'unavailable', value: unavailable });
    progress = Object.freeze({ status: 'idle' });
  }
  function terminate() {
    if (!active) return;
    active = false; presentationOpen = false; client.dispose();
    retention = createRetentionSession(accountId, retention.generation + 1);
    commandError = undefined; resetReads(); publish();
  }
  function checkCurrent(): boolean {
    if (current()) return true;
    terminate(); return false;
  }
  function valid(generation: number): boolean {
    return checkCurrent() && retention.generation === generation;
  }
  function accepts(captured: RetentionFence): boolean {
    return checkCurrent() && captured?.accountId === accountId && captured.generation === retention.generation;
  }
  function rotateClient() {
    client.dispose(); client = makeClient(); resetReads();
  }

  async function readCapabilities(): Promise<ManualMeasurementAvailability | null> {
    if (!checkCurrent()) return null;
    const generation = retention.generation, ticket = ++capabilityRequest, issuingClient = client;
    capabilities = Object.freeze({ status: 'loading', value: unavailable }); publish();
    if (!valid(generation)) return null;
    try {
      const value = await issuingClient.capabilities();
      if (!valid(generation)) return null;
      if (ticket === capabilityRequest) {
        capabilities = Object.freeze({ status: value.create || value.list || value.delete ? 'ready' : 'unavailable', value });
        publish();
      }
      return value;
    } catch (error) {
      if (!valid(generation)) return null;
      if (error instanceof ApiError && error.code === 'session_changed') { terminate(); return null; }
      if (ticket === capabilityRequest) {
        capabilities = Object.freeze({ status: 'error', value: unavailable, error: errorInfo(error) }); publish();
      }
      throw error;
    }
  }

  async function refreshCapabilities(): Promise<void> {
    try { await readCapabilities(); } catch { /* The current capability error is recorded without claiming availability. */ }
  }
  async function loadProgress(range: MeasurementRange = {}): Promise<void> {
    if (!checkCurrent()) return;
    const input = Object.freeze({ ...range }), generation = retention.generation, issuingClient = client;
    // readCapabilities publishes synchronously; capture this request before observers can start another one.
    const ticket = ++progressRequest;
    progress = Object.freeze({ status: 'loading' }); publish();
    if (!valid(generation) || ticket !== progressRequest) return;
    try {
      const availability = await readCapabilities();
      if (!valid(generation) || ticket !== progressRequest || !availability) return;
      if (!availability.list) { progress = Object.freeze({ status: 'unavailable' }); publish(); return; }
      const response = await issuingClient.list(input);
      if (!valid(generation) || ticket !== progressRequest) return;
      const items = listResult(response);
      progress = Object.freeze({ status: items.length ? 'data' : 'empty', items }); publish();
    } catch (error) {
      if (!valid(generation) || ticket !== progressRequest) return;
      if (error instanceof ApiError && error.code === 'session_changed') { terminate(); return; }
      progress = error instanceof ApiError && error.code === 'body_retention_unavailable'
        ? Object.freeze({ status: 'unavailable' }) : Object.freeze({ status: 'error', error: errorInfo(error) });
      publish();
    }
  }

  function chooseProcessing(captured: RetentionFence) {
    if (!accepts(captured)) return;
    retention = retentionReducer(retention, { type: 'choose_processing', choice: 'manual_entry', ...captured }); publish();
  }
  function chooseDerivedRetention(consentVersion: string, captured: RetentionFence) {
    if (!accepts(captured)) return;
    retention = retentionReducer(retention, { type: 'choose', purpose: 'derived', choice: 'retain', consentVersion, ...captured }); publish();
  }
  function revokeDerivedRetention(captured: RetentionFence) {
    if (!accepts(captured)) return;
    retention = retentionReducer(retention, { type: 'revoke', purpose: 'derived', ...captured });
    rotateClient(); publish();
  }
  function stageMeasurement(input: ManualMeasurementInput, captured: RetentionFence) {
    if (!accepts(captured)) return;
    retention = retentionReducer(retention, { type: 'stage_measurement', measurement: input, ...captured }); publish();
  }

  const denied = () => new ApiError(409, 'body_command_not_started', 'This manual action is not currently permitted.');
  function requireAction(intent: CommandIntent, captured: RetentionFence, reconciliationOnly = false, terminalGrant = false) {
    if (!owner || !accepts(captured)) throw denied();
    // Receipt reconciliation retains the original host/attempt fence, but needs no local retain choice.
    if (intent.operation === 'save_manual_measurement' && !reconciliationOnly && !manualRetentionAuthority(retention)) throw denied();
    if (intent.operation === 'grant_manual_retention' && !terminalGrant && (retention.processing !== 'manual_entry'
      || retention.choices.derived.choice !== 'retain' || retention.choices.derived.consentVersion !== MANUAL_RETENTION_PROTOCOL
      || retention.manualDecision?.decisionId !== intent.command.payload.decisionId
      || retention.manualDecision.stopped || retention.manualDecision.revoke !== 'not_requested')) throw denied();
  }
  function metadata(id: CommandCustodyId): CommandMetadata | null {
    if (!active || !owner) return null;
    try { return owner.reconcile(access, id).snapshot(); } catch { return null; }
  }
  async function issue(attempt: CommandAttempt, captured: RetentionFence, terminalGrant = false): Promise<CommandMetadata | null> {
    let dispatched = false, response: unknown;
    let retainedIntent: CommandIntent | undefined;
    const context = attempt.readAttemptContext();
    const reconciliationOnly = context?.manualRetention === null;
    const consentVersion = retention.choices.derived.consentVersion;
    try {
      const intent = attempt.readIntent(); retainedIntent = intent;
      requireAction(intent, captured, reconciliationOnly, terminalGrant);
      if (intent.operation === 'delete_assessment') retention = retentionReducer(retention, { type: 'deletion_started',
        purpose: 'derived', measurementId: intent.command.id, key: intent.command.key, ...captured });
      if (intent.operation === 'grant_manual_retention' || intent.operation === 'revoke_manual_retention') {
        retention = retentionReducer(retention, { type: 'control_result',
          operation: intent.operation === 'grant_manual_retention' ? 'grant' : 'revoke',
          decisionId: intent.operation === 'grant_manual_retention' ? intent.command.payload.decisionId : intent.command.decisionId,
          outcome: 'pending', ...captured });
      }
      commandError = undefined; publish();
      requireAction(intent, captured, reconciliationOnly, terminalGrant); attempt.assertCurrent();
      // This original client survives presentation disposal for result reporting. Only dispatch uses the local fence.
      const assertDispatch = () => {
        requireAction(intent, captured, reconciliationOnly, terminalGrant); attempt.assertCurrent();
        if (intent.operation === 'save_manual_measurement' && !reconciliationOnly) {
          const authority = manualRetentionAuthority(retention);
          if (!authority || !context?.manualRetention || authority.decisionId !== context.manualRetention.decisionId
            || retention.choices.derived.consentVersion !== consentVersion) throw denied();
        }
      };
      const guardedTransport: ManualMeasurementTransport = {
        captureAuthContext: () => auth,
        request<T>(path: string, method = 'GET', payload?: unknown, key?: string,
          requestContext?: FormRequestAttemptContext): Promise<T> {
          if (method !== 'GET') { assertDispatch(); dispatched = true; }
          // Forward this exact synchronous guard across the transport's dynamic-import and final-fetch awaits.
          return transport.request<T>(path, method, payload, key, requestContext);
        },
      };
      const issuingClient = createManualMeasurementsClient({ transport: guardedTransport,
        isCurrentSession: () => auth.isCurrent() && isCurrentSession() });
      try {
        requireAction(intent, captured, reconciliationOnly, terminalGrant); attempt.assertCurrent();
        // Associate only this attempt's original guarded promise with its write-only report channel.
        switch (intent.operation) {
          case 'save_manual_measurement':
            if (!context) throw denied();
            response = await issuingClient.create(intent.command, Object.freeze({ ...context, assertCurrent: assertDispatch })); break;
          case 'delete_assessment': response = await issuingClient.delete(intent.command); break;
          case 'grant_manual_retention': response = await issuingClient.grantRetention(intent.command); break;
          case 'revoke_manual_retention': response = await issuingClient.revokeRetention(intent.command); break;
        }
      } finally { issuingClient.dispose(); }
      if (terminalGrant && captureManualRetentionCommandResult(response)?.current.state !== 'revoked')
        throw new ApiError(502, 'body_retention_unconfirmed', 'Terminal retention reconciliation could not be confirmed.', true);
      attempt.report({ status: 'confirmed', settled: true, response });
    } catch (error) {
      const info = error instanceof ApiError ? errorInfo(error)
        : Object.freeze({ code: 'body_request_unconfirmed', status: 0, effectUnknown: true, originalEffectUnknown: true });
      const unknown = info.effectUnknown || info.originalEffectUnknown || (dispatched && !(error instanceof ApiError));
      attempt.report(unknown ? { status: 'unknown', settled: true } : { status: 'rejected', settled: true });
      if (active && accepts(captured)) commandError = info;
    }
    // Custody's original effect wins over the most recent rejection, including unknown -> rejected retries.
    const result = metadata(attempt.id);
    if (active && accepts(captured)) {
      if (result?.effect === 'unknown' && commandError) commandError = Object.freeze({ ...commandError, originalEffectUnknown: true });
      if (retainedIntent?.operation === 'grant_manual_retention' || retainedIntent?.operation === 'revoke_manual_retention') {
        const operation = retainedIntent.operation === 'grant_manual_retention' ? 'grant' : 'revoke';
        const decisionId = retainedIntent.operation === 'grant_manual_retention'
          ? retainedIntent.command.payload.decisionId : retainedIntent.command.decisionId;
        const proof = result?.effect === 'confirmed' ? captureManualRetentionCommandResult(response) : null;
        retention = retentionReducer(retention, { type: 'control_result', operation, decisionId, ...captured,
          outcome: result?.effect === 'confirmed' ? 'confirmed' : result?.effect === 'not_applied' ? 'failed' : 'unknown',
          ...(proof ? { current: proof.current } : {}) });
      }
      if (retainedIntent?.operation === 'delete_assessment' && result) {
        retention = retentionReducer(retention, { type: 'deletion_result', purpose: 'derived',
          measurementId: retainedIntent.command.id, key: retainedIntent.command.key, ...captured,
          outcome: result.effect === 'confirmed' ? 'confirmed' : result.effect === 'not_applied' ? 'failed' : 'unknown', response });
      }
      publish();
    } else if (checkCurrent()) {
      // Revocation fences presentation state, while same-session custody still publishes settlement metadata.
      publish();
    }
    return result;
  }
  function begin(intent: CommandIntent, captured: RetentionFence): Promise<CommandMetadata | null> {
    requireAction(intent, captured);
    const context = intent.operation === 'save_manual_measurement'
      ? Object.freeze({ manualRetention: manualRetentionAuthority(retention)! }) : undefined;
    const attempt = owner!.hold({ ...access, ...intent }, context);
    return issue(attempt, Object.freeze({ ...captured }));
  }
  function grantRetention(command: GrantManualRetentionCommand, captured: RetentionFence) {
    if (!owner || !accepts(captured) || retention.processing !== 'manual_entry'
      || retention.choices.derived.consentVersion !== MANUAL_RETENTION_PROTOCOL
      || usedDecisions.has(command.payload.decisionId)
      || retention.manualDecision && retention.choices.derived.choice === 'retain'
        && !retention.manualDecision.stopped) throw denied();
    const attempt = owner.hold({ ...access, operation: 'grant_manual_retention', command });
    const intent = attempt.readIntent();
    if (intent.operation !== 'grant_manual_retention') throw denied();
    usedDecisions.add(intent.command.payload.decisionId);
    retention = retentionReducer(retention, { type: 'grant_started', decisionId: intent.command.payload.decisionId, ...captured });
    return issue(attempt, Object.freeze({ ...captured }));
  }
  function revokeRetention(command: RevokeManualRetentionCommand, captured: RetentionFence) {
    if (!owner || !accepts(captured)) throw denied();
    // Local revocation takes effect even if custody/capability admission subsequently fails.
    revokeDerivedRetention(captured);
    const next = Object.freeze(fence());
    const attempt = owner.hold({ ...access, operation: 'revoke_manual_retention', command });
    retention = retentionReducer(retention, { type: 'control_result', operation: 'revoke',
      decisionId: command.decisionId, outcome: 'pending', ...next });
    return issue(attempt, next);
  }
  async function refreshRetention(decisionId: string, captured: RetentionFence) {
    if (!accepts(captured)) throw denied();
    const response = await client.currentRetention(decisionId);
    if (accepts(captured)) {
      retention = retentionReducer(retention, { type: 'current_result', decisionId, current: response.current, ...captured });
      publish();
    }
    return response;
  }
  function retry(id: CommandCustodyId, captured: RetentionFence, reconciliationOnly: boolean) {
    if (!checkCurrent()) throw denied();
    const recovery = owner!.reconcile(access, id), intent = recovery.readIntent();
    if (reconciliationOnly && intent.operation !== 'save_manual_measurement') throw denied();
    requireAction(intent, captured, reconciliationOnly);
    const context: ManualMeasurementAttemptContext | undefined = intent.operation === 'save_manual_measurement'
      ? Object.freeze({ manualRetention: reconciliationOnly ? null : manualRetentionAuthority(retention)! }) : undefined;
    return issue(recovery.retry(context), Object.freeze({ ...captured }));
  }
  async function reconcileGrant(id: CommandCustodyId, captured: RetentionFence) {
    if (!owner || !accepts(captured)) throw denied();
    const recovery = owner.reconcile(access, id), intent = recovery.readIntent();
    if (intent.operation !== 'grant_manual_retention') throw denied();
    const result = await client.currentRetention(intent.command.payload.decisionId);
    if (!accepts(captured) || result.current?.state !== 'revoked') throw denied();
    // Server revocation is terminal: only this evidence permits replay of a stopped grant's original receipt.
    return issue(recovery.retry(), Object.freeze({ ...captured }), true);
  }
  const commandActions = owner ? {
    grantRetention, revokeRetention, reconcileGrant,
    create: (command: CreateMeasurementCommand, captured: RetentionFence) =>
      begin({ operation: 'save_manual_measurement', command }, captured),
    delete: (command: DeleteMeasurementCommand, captured: RetentionFence) =>
      begin({ operation: 'delete_assessment', command }, captured),
    recoverCommand: (id: CommandCustodyId) => {
      if (!checkCurrent()) throw denied();
      const recovery = owner.reconcile(access, id);
      return Object.freeze({ metadata: recovery.snapshot(), intent: recovery.readIntent() });
    },
    retryCommand: (id: CommandCustodyId, captured: RetentionFence) => retry(id, captured, false),
    reconcileCommand: (id: CommandCustodyId, captured: RetentionFence) => retry(id, captured, true),
    acknowledgeCommand: (id: CommandCustodyId) => {
      if (!checkCurrent()) throw denied();
      owner.acknowledge(access, id); commandError = undefined; publish();
    },
  } : {};

  return Object.freeze({
    snapshot: () => { checkCurrent(); return snapshot; },
    // Capture when rendering/beginning an action; a delayed handler must retain this fence, not obtain another one.
    captureFence: (): RetentionFence | null => checkCurrent() ? Object.freeze(fence()) : null,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    ...commandActions,
    refreshCapabilities, loadProgress, refreshRetention, chooseProcessing, chooseDerivedRetention, revokeDerivedRetention, stageMeasurement,
    retentionPermission: () => checkCurrent()
      ? retentionPermission(retention, 'derived', fence(), capabilities.status === 'ready' ? capabilities.value : undefined)
      : { allowed: false as const, reason: 'stale_session' as const },
    // Presentation dismissal does not clear the owning controller or change the authentication session.
    dismissPresentation: () => { if (checkCurrent()) { presentationOpen = false; publish(); } },
    showPresentation: () => { if (checkCurrent()) { presentationOpen = true; publish(); } },
    syncSession: (nextAccountId: string, nextGeneration: string | number) => {
      if (nextAccountId !== accountId || nextGeneration !== sessionGeneration) terminate(); else checkCurrent();
    },
    background: terminate, close: terminate, dispose: terminate,
  });
}
