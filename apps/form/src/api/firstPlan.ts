import { ApiError } from './transport';
import type { Plan, PlanItem, StoredPlan } from './domain';
import { decodePlan } from './trainingCodec';

export type FirstPlanConfirmation = Readonly<{ profileRevision: number; preferencesRevision: number }>;
export type FirstPlanProvenance = {
  schema: 'form.first-plan-provenance/v1'; contextKey: string; selectedCandidateId: string;
  profileRevision: number; preferencesRevision: number;
  sources: { id: string; revision: string }[];
  candidates: { id: string; status: 'eligible' | 'excluded' | 'unknown'; gapCodes: string[] }[];
};
export type FirstPlanReceipt = { plan: Plan; provenance: FirstPlanProvenance };
export type StoredFirstPlanReceipt = { plan: StoredPlan; provenance: FirstPlanProvenance };
const invalid = (): never => { throw Error('invalid_first_plan_value'); };
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return invalid();
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length || own.some(key => typeof key !== 'string' || !keys.includes(key))) return invalid();
  return value as Record<string, unknown>;
}
function number(value: unknown, min: number, max: number, integer = true): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || (integer && !Number.isSafeInteger(value)) || value < min || value > max) return invalid();
  return value;
}
const revision = (value: unknown) => number(value, 0, Number.MAX_SAFE_INTEGER);
function identifier(value: unknown, provenance = false): string {
  if (typeof value !== 'string' || !value.length || value.length > (provenance ? 128 : 80) ||
    !(provenance ? /^[A-Za-z0-9_.:-]+$/ : /^[A-Za-z0-9_-]+$/).test(value)) return invalid();
  return value;
}
function array<T>(value: unknown, min: number, max: number, parse: (item: unknown) => T): T[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) return invalid();
  return Array.from(value, parse);
}
function instant(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?Z$/.test(value)) return invalid();
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value.slice(0, 10)) return invalid();
  return value;
}
function confirmation(value: unknown): FirstPlanConfirmation {
  const row = object(value, ['profileRevision', 'preferencesRevision']);
  return Object.freeze({ profileRevision: revision(row.profileRevision), preferencesRevision: revision(row.preferencesRevision) });
}
export function captureFirstPlanConfirmation(value: unknown): FirstPlanConfirmation {
  try { return confirmation(value); }
  catch { throw new ApiError(422, 'invalid_request', 'Confirm the current profile and preferences before creating a plan.'); }
}
function planItem(value: unknown): PlanItem {
  const row = object(value, ['id', 'exerciseId', 'setTarget', 'repMin', 'repMax', 'targetKg']);
  const item = { id: identifier(row.id), exerciseId: identifier(row.exerciseId), setTarget: number(row.setTarget, 1, 20),
    repMin: number(row.repMin, 1, 100), repMax: number(row.repMax, 1, 100), targetKg: number(row.targetKg, 0, 500, false) };
  if (item.repMax < item.repMin) return invalid();
  return item;
}
function plan(value: unknown): Plan {
  const row = object(value, ['id', 'name', 'minutes', 'items', 'revision', 'archived', 'createdAt', 'updatedAt']);
  if (typeof row.name !== 'string' || !row.name.trim().length || row.name.trim().length > 100 || typeof row.archived !== 'boolean') return invalid();
  const items = array(row.items, 1, 50, planItem);
  if (new Set(items.map(item => item.id)).size !== items.length) return invalid();
  return { id: identifier(row.id), name: row.name.trim(), minutes: number(row.minutes, 5, 180), items,
    revision: revision(row.revision), archived: row.archived, createdAt: instant(row.createdAt), updatedAt: instant(row.updatedAt) };
}
function provenance(value: unknown): FirstPlanProvenance {
  const row = object(value, ['schema', 'contextKey', 'selectedCandidateId', 'profileRevision', 'preferencesRevision', 'sources', 'candidates']);
  if (row.schema !== 'form.first-plan-provenance/v1') return invalid();
  const result: FirstPlanProvenance = { schema: row.schema, contextKey: identifier(row.contextKey, true), selectedCandidateId: identifier(row.selectedCandidateId),
    profileRevision: revision(row.profileRevision), preferencesRevision: revision(row.preferencesRevision),
    sources: array(row.sources, 0, 256, value => { const source = object(value, ['id', 'revision']);
      return { id: identifier(source.id, true), revision: identifier(source.revision, true) }; }),
    candidates: array(row.candidates, 0, 64, value => { const candidate = object(value, ['id', 'status', 'gapCodes']);
      if (candidate.status !== 'eligible' && candidate.status !== 'excluded' && candidate.status !== 'unknown') return invalid();
      return { id: identifier(candidate.id), status: candidate.status,
        gapCodes: array(candidate.gapCodes, 0, 64, value => identifier(value, true)) }; }),
  };
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > 64 * 1024) return invalid();
  return result;
}
export function decodeFirstPlanReceipt(value: unknown, expected: FirstPlanConfirmation): FirstPlanReceipt {
  try {
    const captured = confirmation(expected), row = object(value, ['plan', 'provenance']);
    const result = { plan: plan(row.plan), provenance: provenance(row.provenance) };
    if (result.provenance.profileRevision !== captured.profileRevision || result.provenance.preferencesRevision !== captured.preferencesRevision) return invalid();
    return result;
  } catch {
    throw new ApiError(0, 'first_plan_response_invalid', 'The saved plan response could not be verified. Keep the original request before retrying.', true);
  }
}

export function decodeStoredFirstPlanReceipt(value: unknown, expected: FirstPlanConfirmation): StoredFirstPlanReceipt {
  try {
    const captured = confirmation(expected), row = object(value, ['plan', 'provenance']);
    const result = { plan: decodePlan(row.plan), provenance: provenance(row.provenance) };
    if (result.provenance.profileRevision !== captured.profileRevision || result.provenance.preferencesRevision !== captured.preferencesRevision) return invalid();
    return result;
  } catch {
    throw new ApiError(0, 'first_plan_response_invalid', 'The saved plan response could not be verified. Keep the original request before retrying.', true);
  }
}
