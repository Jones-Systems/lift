import type { CommandIntent } from '../integration/commandCustody';
import { captureManualRetentionCommandResult, captureManualRetentionGrantPayload,
  captureManualRetentionRevokePayload, isManualRetentionDecisionId } from './manualRetentionContract';

function data(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return null;
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length) return null;
  const copy: Record<string, unknown> = Object.create(null);
  for (const key of own) {
    if (typeof key !== 'string' || !keys.includes(key)) return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !('value' in descriptor)) return null;
    copy[key] = descriptor.value;
  }
  return copy;
}

// A historical grant receipt confirms its command, including a now-revoked decision; it grants no local permission.
export function validateManualRetentionCommandConfirmation(intent: CommandIntent, response: unknown): boolean {
  try {
    const input = data(intent, ['operation', 'command']);
    if (!input) return false;
    const grant = input.operation === 'grant_manual_retention';
    if (!grant && input.operation !== 'revoke_manual_retention') return false;
    const command = data(input.command, grant ? ['key', 'payload'] : ['key', 'decisionId', 'payload']);
    if (!command || typeof command.key !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(command.key)) return false;
    const payload = grant ? captureManualRetentionGrantPayload(command.payload) : captureManualRetentionRevokePayload(command.payload);
    if (!payload) return false;
    const decisionId = grant ? (payload as { decisionId: string }).decisionId : command.decisionId;
    if (!isManualRetentionDecisionId(decisionId)) return false;
    const result = captureManualRetentionCommandResult(response);
    return result !== null && result.receipt.operation === (grant ? 'grant' : 'revoke')
      && result.receipt.decisionId === decisionId;
  } catch { return false; }
}
