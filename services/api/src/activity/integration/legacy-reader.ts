import { z } from 'zod';
import { DomainError } from '../../errors.js';
import { planFields, resourceId } from '../../schemas.js';
import type { Sqlite } from '../../storage.js';
import { assertCivilDate, assertTimeZone, dayBoundaries, localDate } from '../calendar.js';
import type { LegacyActivityEvidence, LegacyPlanSnapshot, LegacyTrainingReader } from '../types.js';

export const legacyReadLimits = Object.freeze({ planBytes: 64 * 1024, sessions: 10_000,
  setsPerSession: 5_000, totalSets: 100_000 });
const snapshotSchema = planFields.extend({ name: z.string().min(1).max(100).refine(value => value === value.trim()), archived: z.boolean() }).strict();
const unavailable = (): never => { throw new DomainError(503, 'activity_legacy_invalid_or_unavailable'); };
function selectedId(value: unknown): string {
  const result = resourceId.safeParse(value);
  return result.success ? result.data : unavailable();
}
function selectedRevision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) return unavailable();
  return value;
}
function selector(accountId: string, planId?: string, revision?: number): void {
  if (!resourceId.safeParse(accountId).success || (planId !== undefined && !resourceId.safeParse(planId).success) ||
    (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 1)))
    throw new DomainError(422, 'invalid_activity_legacy_selector');
}

// Internal reader for a root-qualified dataset. Canonical UTC timestamps are a Domain source invariant, not a DB CHECK.
export function createLegacyTrainingReader(input: Readonly<{
  db: Sqlite;
  assertReadable(accountId: string): void;
}>): LegacyTrainingReader {
  const { db } = input;
  const boundary = (accountId: string): void => {
    if (!db.inTransaction) throw new DomainError(503, 'activity_legacy_read_transaction_required');
    input.assertReadable(accountId);
  };
  return Object.freeze({
    readPlanRevision(accountId: string, planId: string, revision: number): LegacyPlanSnapshot | null {
      selector(accountId, planId, revision); boundary(accountId);
      const row = db.prepare(`SELECT r.revision, length(CAST(r.data AS BLOB)) AS bytes,
        CASE WHEN length(CAST(r.data AS BLOB)) <= ? THEN r.data ELSE NULL END AS data
        FROM plan_revisions r JOIN plans p ON p.account_id=r.account_id AND p.id=r.plan_id
        WHERE r.account_id=? AND r.plan_id=? AND r.revision=? LIMIT 1`)
        .get(legacyReadLimits.planBytes, accountId, planId, revision) as
        { revision: number; bytes: number; data: string | null } | undefined;
      if (!row) { boundary(accountId); return null; }
      if (!Number.isSafeInteger(row.bytes) || row.bytes < 1 || row.bytes > legacyReadLimits.planBytes ||
        typeof row.data !== 'string' || selectedRevision(row.revision) !== revision) return unavailable();
      let decoded: unknown;
      try { decoded = JSON.parse(row.data) as unknown; } catch { return unavailable(); }
      const result = snapshotSchema.safeParse(decoded);
      if (!result.success) return unavailable();
      const snapshot = result.data;
      const items = snapshot.items.map(item => {
        const mapping = db.prepare(`SELECT i.exercise_id FROM plan_item_ids i
          JOIN exercises e ON e.id=i.exercise_id
          WHERE i.account_id=? AND i.plan_id=? AND i.id=? LIMIT 1`).get(accountId, planId, item.id) as
          { exercise_id: string } | undefined;
        if (mapping?.exercise_id !== item.exerciseId) return unavailable();
        return { id: item.id, exerciseId: item.exerciseId, setTarget: item.setTarget,
          repMin: item.repMin, repMax: item.repMax, targetKg: item.targetKg };
      });
      boundary(accountId);
      return { id: planId, revision, name: snapshot.name, minutes: snapshot.minutes, archived: snapshot.archived, items };
    },
    listCompletedEvidence(accountId: string, fromDate: string, toDate: string, timeZone: string): LegacyActivityEvidence[] {
      selector(accountId); assertCivilDate(fromDate); assertCivilDate(toDate); assertTimeZone(timeZone);
      if (fromDate > toDate) throw new DomainError(422, 'invalid_activity_range');
      const fromInstant = dayBoundaries(fromDate, timeZone).dayStartAt;
      const untilInstant = dayBoundaries(toDate, timeZone).dayEndAt;
      boundary(accountId);
      const sessions = db.prepare(`SELECT id,revision,started_at FROM workout_sessions
        WHERE account_id=? AND status='completed' AND started_at>=? AND started_at<?
        ORDER BY started_at,id LIMIT ?`).all(accountId, fromInstant, untilInstant, legacyReadLimits.sessions + 1) as
        { id: string; revision: number; started_at: string }[];
      if (sessions.length > legacyReadLimits.sessions) return unavailable();
      let totalSets = 0;
      const evidence = sessions.map(session => {
        const sessionId = selectedId(session.id), sessionRevision = selectedRevision(session.revision);
        if (typeof session.started_at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(session.started_at)) return unavailable();
        const instant = new Date(session.started_at);
        if (!Number.isFinite(instant.getTime()) || instant.toISOString() !== session.started_at) return unavailable();
        const date = localDate(instant, timeZone);
        if (date < fromDate || date > toDate) return unavailable();
        const sets = db.prepare(`SELECT s.id,s.occurrence_id,s.reps,o.id AS matched_occurrence
          FROM performed_sets s LEFT JOIN session_occurrences o
          ON o.account_id=s.account_id AND o.session_id=s.session_id AND o.id=s.occurrence_id
          WHERE s.account_id=? AND s.session_id=? AND s.status='confirmed' AND s.reps>0
          ORDER BY s.occurrence_id,s.id LIMIT ?`).all(accountId, sessionId,
          Math.min(legacyReadLimits.setsPerSession, legacyReadLimits.totalSets - totalSets) + 1) as
          { id: string; occurrence_id: string; reps: number; matched_occurrence: string | null }[];
        totalSets += sets.length;
        if (sets.length > legacyReadLimits.setsPerSession || totalSets > legacyReadLimits.totalSets) return unavailable();
        const occurrences = new Set<string>();
        for (const set of sets) {
          selectedId(set.id);
          const occurrence = selectedId(set.occurrence_id);
          if (set.matched_occurrence !== occurrence || !Number.isInteger(set.reps) || set.reps < 1 || set.reps > 100) return unavailable();
          occurrences.add(occurrence);
        }
        return { sessionId, sessionRevision, localDate: date, dateBasis: 'startedAt_in_confirmed_zone' as const,
          hasConfirmedPerformance: occurrences.size > 0, confirmedOccurrenceCount: occurrences.size };
      });
      boundary(accountId);
      return evidence;
    },
  });
}
