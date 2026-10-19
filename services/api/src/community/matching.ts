import { createHash } from 'node:crypto';
import { DomainError } from '../errors.js';
import type { BatchCandidate, BatchSnapshot, EnrollmentPreferences, MatchBatchPlan, MatchBatchPolicy, PlannedCohort } from './extension-types.js';
export function sundayPolicy(cutoffLocalDate: string, runtimeVersion = process.versions.tz): MatchBatchPolicy {
 const civil = new Date(`${cutoffLocalDate}T00:00:00.000Z`);
 if (!/^\d{4}-\d{2}-\d{2}$/.test(cutoffLocalDate) || !Number.isFinite(civil.getTime()) || civil.toISOString().slice(0, 10) !== cutoffLocalDate || civil.getUTCDay() !== 0 || !runtimeVersion)
  throw new DomainError(503, 'community_schedule_unavailable');
 const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
 const resolve = (date: string, hour: number): string => {
  const desired = Date.parse(`${date}T${hour}:00:00.000Z`); let instant = desired;
  for (let i = 0; i < 4; i++) { const parts = Object.fromEntries(formatter.formatToParts(new Date(instant)).map(p => [p.type, p.value]));
   const represented = Date.parse(`${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:00.000Z`); instant += desired - represented; }
  const parts = Object.fromEntries(formatter.formatToParts(new Date(instant)).map(p => [p.type, p.value]));
  if (`${parts.year}-${parts.month}-${parts.day}` !== date || Number(parts.hour) !== hour || parts.minute !== '00') throw new DomainError(503, 'community_schedule_resolution_unavailable');
  return new Date(instant).toISOString();
 };
 const monday = new Date(civil); monday.setUTCDate(monday.getUTCDate() + 1);
 return { policyVersion: 'community-v1', batchZone: 'America/New_York', cutoffLocalDate, cutoffAt: resolve(cutoffLocalDate, 17), runAt: resolve(cutoffLocalDate, 18), resumeUntil: resolve(monday.toISOString().slice(0, 10), 18), runtimeVersion, resolution: 'exact', minimum: 4, target: 12, startCapacity: 12, growCapacity: 20 };
}
export function nextSundayPolicy(now: Date, runtimeVersion = process.versions.tz): MatchBatchPolicy {
 if (!Number.isFinite(now.getTime())) throw new DomainError(503, 'community_clock_unavailable');
 const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now).map(p => [p.type, p.value]));
 const civil = new Date(`${parts.year}-${parts.month}-${parts.day}T00:00:00Z`); civil.setUTCDate(civil.getUTCDate() + (7 - civil.getUTCDay()) % 7);
 let policy = sundayPolicy(civil.toISOString().slice(0, 10), runtimeVersion);
 if (now.toISOString() >= policy.cutoffAt) { civil.setUTCDate(civil.getUTCDate() + 7); policy = sundayPolicy(civil.toISOString().slice(0, 10), runtimeVersion); }
 return policy;
}
export const batchIdentity = (policy: MatchBatchPolicy, intent: string, language: string): string => createHash('sha256').update(JSON.stringify([policy.policyVersion, policy.batchZone, policy.cutoffLocalDate, intent, language])).digest('hex');
export function pairRelaxations(a: EnrollmentPreferences, b: EnrollmentPreferences): ('broader_region' | 'mixed_goals')[] | null {
 const result: ('broader_region' | 'mixed_goals')[] = [];
 if (a.region && b.region && ((a.location === 'local_preferred' && a.region !== b.region) || (a.location === 'nonlocal_preferred' && a.region === b.region))) {
  if (!a.relax.broaderRegion) return null; result.push('broader_region'); }
 if (a.goals.length && b.goals.length && !a.goals.some(g => b.goals.includes(g))) { if (!a.relax.mixedGoals) return null; result.push('mixed_goals'); }
 return result;
}
export function planCommunityBatch(snapshot: BatchSnapshot, policy: MatchBatchPolicy): MatchBatchPlan {
 if (snapshot.candidates.length > 500 || snapshot.excludedPairs.length > 125000) return { status: 'pending_capacity', cohorts: [], pendingEnrollmentIds: [] };
 if (!snapshot.exclusionsKnown) return { status: 'pending_authority', cohorts: [], pendingEnrollmentIds: snapshot.candidates.map(c => c.enrollmentId) };
 const ids = new Set<string>(), accounts = new Set<string>();
 for (const c of snapshot.candidates) { if (ids.has(c.enrollmentId) || accounts.has(c.accountId)) throw new DomainError(409, 'community_duplicate_candidate'); ids.add(c.enrollmentId); accounts.add(c.accountId); }
 const excluded = new Set(snapshot.excludedPairs.flatMap(([a, b]) => [`${a}:${b}`, `${b}:${a}`]));
 const compatible = (a: BatchCandidate, b: BatchCandidate) => a.preferences.intent === b.preferences.intent && a.preferences.language === b.preferences.language && !excluded.has(`${a.accountId}:${b.accountId}`) && pairRelaxations(a.preferences, b.preferences) !== null && pairRelaxations(b.preferences, a.preferences) !== null;
 const waiting = snapshot.candidates.filter(c => c.eligible && c.preferences.intent === snapshot.intent && c.preferences.language === snapshot.language && c.consentAt < policy.cutoffAt && c.queuedAt < policy.cutoffAt).sort((a, b) => a.queuedAt.localeCompare(b.queuedAt) || a.enrollmentId.localeCompare(b.enrollmentId));
 const cohorts: PlannedCohort[] = []; const skipped = new Set<string>();
 while (waiting.length >= 4 && cohorts.length < 50) {
  const seed = waiting.find(c => !skipped.has(c.enrollmentId)); if (!seed) break;
  const count = Math.ceil(waiting.length / 12), size = Math.max(4, Math.min(12, Math.ceil(waiting.length / count)));
  const selected = [seed];
  const score = (c: BatchCandidate, dimension: 'location' | 'goals'): number => dimension === 'goals' ? seed.preferences.goals.filter(g => c.preferences.goals.includes(g)).length : !seed.preferences.region || !c.preferences.region ? 0 : seed.preferences.location === 'local_preferred' ? Number(seed.preferences.region === c.preferences.region) : seed.preferences.location === 'anywhere' ? 0 : Number(seed.preferences.region !== c.preferences.region);
  const candidates = waiting.filter(c => c !== seed).sort((a, b) => { for (const p of seed.preferences.priorities) { const delta = score(b, p) - score(a, p); if (delta) return delta; } return a.queuedAt.localeCompare(b.queuedAt) || a.enrollmentId.localeCompare(b.enrollmentId); });
  if (!seed.preferences.willingHost) { const host = candidates.find(c => c.preferences.willingHost && compatible(seed, c)); if (host) selected.push(host); }
  for (const c of candidates) { if (selected.length === size) break; if (!selected.includes(c) && selected.every(p => compatible(p, c))) selected.push(c); }
  const host = selected.filter(c => c.preferences.willingHost).sort((a, b) => a.queuedAt.localeCompare(b.queuedAt) || a.enrollmentId.localeCompare(b.enrollmentId))[0];
  if (selected.length < 4 || !host) { skipped.add(seed.enrollmentId); continue; }
  const relaxation: Record<string, ('broader_region' | 'mixed_goals')[]> = {};
  for (const c of selected) relaxation[c.enrollmentId] = [...new Set(selected.filter(p => p !== c).flatMap(p => pairRelaxations(c.preferences, p.preferences) ?? []))];
  cohorts.push({ enrollmentIds: selected.map(c => c.enrollmentId), hostEnrollmentId: host.enrollmentId, relaxation });
  for (const c of selected) waiting.splice(waiting.indexOf(c), 1);
 }
 const assigned = new Set(cohorts.flatMap(c => [...c.enrollmentIds]));
 return { status: 'planned', cohorts, pendingEnrollmentIds: snapshot.candidates.filter(c => !assigned.has(c.enrollmentId)).map(c => c.enrollmentId) };
}
