import { captureManualMeasurementAttemptContext, type AuthAttemptGuard, type ManualMeasurementAttemptContext } from '../api/transport';
import type { CreateMeasurementCommand, DeleteMeasurementCommand } from '../body/manualMeasurements';
import { captureManualRetentionAttemptAuthority, captureManualRetentionCommandResult, captureManualRetentionGrantPayload, captureManualRetentionRevokePayload, isManualRetentionDecisionId,
  type ManualRetentionGrantPayload, type ManualRetentionRevokePayload } from '../body/manualRetentionContract';

export const commandCustodyLimits = Object.freeze({ records: 16, attemptsPerCommand: 8, commandBytes: 4096 });
export type CommandAccess = Readonly<{ accountId: string; sessionGeneration: string | number }>;
export type ManualCommandIntent =
  | Readonly<{ operation: 'save_manual_measurement'; command: CreateMeasurementCommand }>
  | Readonly<{ operation: 'delete_assessment'; command: DeleteMeasurementCommand }>;
export type ManualRetentionCommandIntent =
  | Readonly<{ operation: 'grant_manual_retention'; command: Readonly<{ key: string; payload: ManualRetentionGrantPayload }> }>
  | Readonly<{ operation: 'revoke_manual_retention'; command: Readonly<{ key: string; decisionId: string; payload: ManualRetentionRevokePayload }> }>;
export type CommandIntent = ManualCommandIntent | ManualRetentionCommandIntent;
declare const custodyIdentity: unique symbol;
export type CommandCustodyId = Readonly<{ [custodyIdentity]: true }>;
export type CommandEffect = 'pending' | 'unknown' | 'confirmed' | 'not_applied';
export type CommandMetadata = Readonly<{
  id: CommandCustodyId;
  operation: CommandIntent['operation'];
  effect: CommandEffect;
  attempts: number;
  locallyPending: number;
  retryAvailable: boolean;
}>;
export type CommandOutcome =
  | Readonly<{ status: 'unknown'; settled: boolean }>
  | Readonly<{ status: 'rejected'; settled: true }>
  | Readonly<{ status: 'confirmed'; settled: true; response: unknown }>;
export type CommandAttempt = Readonly<{
  id: CommandCustodyId;
  readIntent(): CommandIntent;
  readAttemptContext(): ManualMeasurementAttemptContext | undefined;
  assertCurrent(): void;
  report(outcome: CommandOutcome): void;
}>;
export type CommandCustodyDependencies = CommandAccess & Readonly<{
  transport: { captureAuthContext(): AuthAttemptGuard };
  isCurrentSession(accountId: string, sessionGeneration: string | number): boolean;
  validateConfirmation?: (intent: CommandIntent, response: unknown) => boolean;
}>;

export class CommandCustodyError extends Error {
  constructor(readonly code: 'session_changed' | 'invalid_command' | 'custody_capacity' | 'command_already_held'
    | 'custody_missing' | 'attempt_pending' | 'retry_unavailable' | 'attempt_capacity' | 'unresolved_command') {
    super('Original command custody is unavailable for this action.');
    this.name = 'CommandCustodyError';
  }
}
const fail = (code: CommandCustodyError['code']): never => { throw new CommandCustodyError(code); };
function dataRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) return null;
  const result: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (typeof key !== 'string' || !descriptor.enumerable || !('value' in descriptor)) return null;
    Object.defineProperty(result, key, { value: descriptor.value, enumerable: true });
  }
  return result;
}
const exact = (value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []) =>
  required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
function captureIntent(value: unknown): CommandIntent {
  const input = dataRecord(value);
  if (!input || !exact(input, ['accountId', 'sessionGeneration', 'operation', 'command'])) return fail('invalid_command');
  const command = dataRecord(input.command), payload = command && dataRecord(command.payload);
  if (!command || !payload || !nonempty(command.key) || command.key.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(command.key)) return fail('invalid_command');
  if (input.operation === 'grant_manual_retention') {
    const captured = captureManualRetentionGrantPayload(payload);
    if (!exact(command, ['key', 'payload']) || !captured) return fail('invalid_command');
    return Object.freeze({ operation: input.operation, command: Object.freeze({ key: command.key, payload: captured }) });
  }
  if (input.operation === 'revoke_manual_retention') {
    const captured = captureManualRetentionRevokePayload(payload);
    if (!exact(command, ['key', 'decisionId', 'payload']) || !isManualRetentionDecisionId(command.decisionId) || !captured) return fail('invalid_command');
    return Object.freeze({ operation: input.operation,
      command: Object.freeze({ key: command.key, decisionId: command.decisionId, payload: captured }) });
  }
  if (input.operation === 'delete_assessment') {
    if (!exact(command, ['key', 'id', 'payload']) || !nonempty(command.id) || command.id.length > 128 || Object.keys(payload).length) return fail('invalid_command');
    return Object.freeze({ operation: input.operation, command: Object.freeze({ key: command.key, id: command.id, payload: Object.freeze({}) }) });
  }
  if (input.operation !== 'save_manual_measurement' || !exact(command, ['key', 'payload']) ||
    !exact(payload, ['kind', 'value', 'unit', 'measuredOn'], ['note']) ||
    typeof payload.kind !== 'string' || !['waist', 'hips', 'chest', 'thigh', 'upper_arm', 'weight'].includes(payload.kind) ||
    typeof payload.value !== 'number' || !Number.isFinite(payload.value) || payload.value <= 0 ||
    typeof payload.unit !== 'string' || !(payload.kind === 'weight' ? ['kg', 'lb'] : ['cm', 'in']).includes(payload.unit) ||
    typeof payload.measuredOn !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(payload.measuredOn) ||
    (Object.hasOwn(payload, 'note') && payload.note !== undefined && typeof payload.note !== 'string')) return fail('invalid_command');
  const captured = Object.freeze({ operation: input.operation, command: Object.freeze({ key: command.key,
    payload: Object.freeze({ ...payload }) }) });
  if (new TextEncoder().encode(JSON.stringify(captured.command)).length > commandCustodyLimits.commandBytes) return fail('invalid_command');
  return captured as ManualCommandIntent;
}

type Attempt = { settled: boolean; confirmationSeen: boolean };
type Entry = { id: CommandCustodyId; intent: CommandIntent; effect: CommandEffect;
  unknown: boolean; attempts: Attempt[] };

export function createCommandCustody(dependencies: CommandCustodyDependencies) {
  const { accountId, sessionGeneration, transport, isCurrentSession, validateConfirmation } = dependencies;
  const auth = transport.captureAuthContext();
  const entries = new Map<CommandCustodyId, Entry>();
  const keys = new Map<string, CommandCustodyId>();
  let expired = false;
  const assertOriginal = () => {
    try {
      if (!nonempty(accountId) || !(nonempty(sessionGeneration) || typeof sessionGeneration === 'number' && Number.isSafeInteger(sessionGeneration)) ||
        !auth.isCurrent() || !isCurrentSession(accountId, sessionGeneration)) expired = true;
    } catch { expired = true; }
    if (expired) fail('session_changed');
  };
  const access = (value: CommandAccess) => {
    assertOriginal();
    const provided = dataRecord(value);
    if (!provided || !exact(provided, ['accountId', 'sessionGeneration']) ||
      provided.accountId !== accountId || provided.sessionGeneration !== sessionGeneration) fail('session_changed');
  };
  const retained = (entry: Entry) => {
    assertOriginal();
    if (entries.get(entry.id) !== entry) fail('custody_missing');
  };
  const locallyPending = (entry: Entry) => entry.attempts.filter(attempt => !attempt.settled).length;
  const metadata = (entry: Entry): CommandMetadata => Object.freeze({ id: entry.id, operation: entry.intent.operation,
    effect: entry.effect, attempts: entry.attempts.length, locallyPending: locallyPending(entry),
    retryAvailable: entry.effect === 'unknown' && locallyPending(entry) === 0 && entry.attempts.length < commandCustodyLimits.attemptsPerCommand });
  const qualifies = (entry: Entry, response: unknown) => {
    if (typeof validateConfirmation !== 'function') return false;
    if (entry.intent.operation === 'delete_assessment') {
      const result = dataRecord(response);
      if (!result || !exact(result, ['deleted']) || result.deleted !== true) return false;
    }
    if ((entry.intent.operation === 'grant_manual_retention' || entry.intent.operation === 'revoke_manual_retention')
      && !captureManualRetentionCommandResult(response)) return false;
    try { return validateConfirmation(entry.intent, response) === true; } catch { return false; }
  };
  const captureContext = (intent: CommandIntent, context: ManualMeasurementAttemptContext | undefined) => {
    if (context !== undefined && intent.operation !== 'save_manual_measurement') return fail('invalid_command');
    try {
      const captured = captureManualMeasurementAttemptContext(context);
      if (!captured || captured.manualRetention === null) return captured;
      const authority = captureManualRetentionAttemptAuthority(captured.manualRetention);
      if (!authority) return fail('invalid_command');
      return Object.freeze({ manualRetention: authority });
    } catch { return fail('invalid_command'); }
  };
  const beginAttempt = (entry: Entry, context?: ManualMeasurementAttemptContext): CommandAttempt => {
    const attempt: Attempt = { settled: false, confirmationSeen: false };
    entry.attempts.push(attempt);
    return Object.freeze({ id: entry.id,
      readIntent() { retained(entry); return entry.intent; },
      readAttemptContext() { retained(entry); return context; },
      assertCurrent() { retained(entry); if (attempt.settled || entry.effect === 'confirmed' || entry.effect === 'not_applied') fail('retry_unavailable'); },
      report(outcome: CommandOutcome) {
        if (entries.get(entry.id) !== entry) return;
        const report = dataRecord(outcome);
        if (report?.status === 'confirmed' && report.settled === true && exact(report, ['status', 'settled', 'response'])) {
          if (attempt.confirmationSeen) return;
          attempt.settled = true;
          if (qualifies(entry, report.response)) { attempt.confirmationSeen = true; entry.effect = 'confirmed'; return; }
          if (entry.effect !== 'confirmed') { entry.unknown = true; entry.effect = 'unknown'; }
          return;
        }
        if (attempt.settled) return;
        if (report?.status === 'rejected' && report.settled === true && exact(report, ['status', 'settled'])) {
          attempt.settled = true;
          if (entry.effect !== 'confirmed') entry.effect = entry.unknown ? 'unknown' : 'not_applied';
          return;
        }
        if (entry.effect !== 'confirmed') { entry.unknown = true; entry.effect = 'unknown'; }
        if (report?.status === 'unknown' && typeof report.settled === 'boolean' && exact(report, ['status', 'settled'])) attempt.settled = report.settled;
      },
    });
  };
  const find = (authorization: CommandAccess, id: CommandCustodyId) => {
    access(authorization);
    const entry = entries.get(id);
    if (!entry) return fail('custody_missing');
    return entry;
  };
  const acknowledge = (authorization: CommandAccess, id: CommandCustodyId) => {
    const entry = find(authorization, id);
    if (locallyPending(entry) || !['confirmed', 'not_applied'].includes(entry.effect)) fail('unresolved_command');
    entries.delete(id); keys.delete(entry.intent.command.key);
  };
  return Object.freeze({
    hold(input: CommandAccess & CommandIntent, attemptContext?: ManualMeasurementAttemptContext): CommandAttempt {
      assertOriginal();
      const row = dataRecord(input);
      if (!row || row.accountId !== accountId || row.sessionGeneration !== sessionGeneration) return fail('session_changed');
      const intent = captureIntent(input);
      const context = captureContext(intent, attemptContext);
      assertOriginal();
      if (keys.has(intent.command.key)) return fail('command_already_held');
      if (entries.size >= commandCustodyLimits.records) return fail('custody_capacity');
      const id = Object.freeze({}) as CommandCustodyId;
      const entry: Entry = { id, intent, effect: 'pending', unknown: false, attempts: [] };
      entries.set(id, entry); keys.set(intent.command.key, id);
      return beginAttempt(entry, context);
    },
    snapshot(authorization: CommandAccess): readonly CommandMetadata[] {
      access(authorization); return Object.freeze([...entries.values()].map(metadata));
    },
    reconcile(authorization: CommandAccess, id: CommandCustodyId) {
      const entry = find(authorization, id);
      return Object.freeze({
        snapshot: () => { retained(entry); return metadata(entry); },
        readIntent: () => { retained(entry); return entry.intent; },
        retry(attemptContext?: ManualMeasurementAttemptContext): CommandAttempt {
          retained(entry);
          if (locallyPending(entry)) return fail('attempt_pending');
          if (entry.effect !== 'unknown') return fail('retry_unavailable');
          if (entry.attempts.length >= commandCustodyLimits.attemptsPerCommand) return fail('attempt_capacity');
          const context = captureContext(entry.intent, attemptContext);
          retained(entry);
          return beginAttempt(entry, context);
        },
        acknowledge: () => acknowledge({ accountId, sessionGeneration }, id),
      });
    },
    acknowledge,
  });
}
