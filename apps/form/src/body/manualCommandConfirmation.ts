import type { ManualCommandIntent } from '../integration/commandCustody';

// Pure producer-response proof only; original account/key authority belongs to custody and the guarded attempt.
function data(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return null;
  const copy: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (typeof key !== 'string' || !descriptor.enumerable || !('value' in descriptor)) return null;
    copy[key] = descriptor.value;
  }
  return copy;
}
const exact = (row: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []) =>
  required.every(key => Object.hasOwn(row, key)) && Object.keys(row).every(key => required.includes(key) || optional.includes(key));
const uuid = (value: unknown) => typeof value === 'string'
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const validKey = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value);
const kinds = ['waist', 'hips', 'chest', 'thigh', 'upper_arm', 'weight'];
function civilDate(value: unknown): boolean {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}

export function validateManualCommandConfirmation(intent: ManualCommandIntent, response: unknown): boolean {
  try {
    const input = data(intent), command = input && data(input.command), payload = command && data(command.payload), row = data(response);
    if (!input || !exact(input, ['operation', 'command']) || !command || !payload || !row || !validKey(command.key)) return false;
    if (input.operation === 'delete_assessment') return exact(command, ['id', 'key', 'payload']) && uuid(command.id)
      && exact(payload, []) && exact(row, ['deleted']) && row.deleted === true;
    if (input.operation !== 'save_manual_measurement' || !exact(command, ['key', 'payload'])
      || !exact(payload, ['kind', 'value', 'unit', 'measuredOn'], ['note'])
      || typeof payload.kind !== 'string' || !kinds.includes(payload.kind)
      || typeof payload.value !== 'number' || !Number.isFinite(payload.value) || payload.value <= 0 || payload.value > 10000
      || !civilDate(payload.measuredOn)
      || (payload.note !== undefined && (typeof payload.note !== 'string' || payload.note.trim().length > 200))) return false;
    const weight = payload.kind === 'weight';
    if (!(weight ? payload.unit === 'kg' || payload.unit === 'lb' : payload.unit === 'cm' || payload.unit === 'in')) return false;
    const canonical = payload.value * (payload.unit === 'in' ? 2.54 : payload.unit === 'lb' ? 0.45359237 : 1);
    return exact(row, ['id', 'kind', 'value', 'unit', 'originalUnit', 'measuredOn', 'note', 'provenance']) && uuid(row.id)
      && row.kind === payload.kind && row.value === canonical && row.unit === (weight ? 'kg' : 'cm')
      && row.originalUnit === payload.unit && row.measuredOn === payload.measuredOn
      && row.note === (typeof payload.note === 'string' ? payload.note.trim() : null) && row.provenance === 'manual_reported';
  } catch { return false; }
}
