import type { AccountContext, LifecycleBindings, LifecycleResult } from '../lifecycle/types.js';
import type { Sqlite } from '../storage.js';
import type { ActivityItemInput, ActivityWrite, ExerciseSnapshot, PersonalExerciseFields } from './schemas.js';

export type PersonalExercise = PersonalExerciseFields & { id: string; revision: number; retired: boolean; createdAt: string; updatedAt: string };
export type ActivityItem = ActivityItemInput & { snapshot: ExerciseSnapshot };
export type ActivityEntry = Omit<ActivityWrite, 'items'> & { id: string; revision: number; status: 'recorded' | 'voided'; items: ActivityItem[]; createdAt: string; updatedAt: string };
export type ActivityPlanItem = { id: string; exercise: import('./schemas.js').ExerciseRef; snapshot: ExerciseSnapshot; target: import('./schemas.js').PlanTarget };
export type ActivityPlanSnapshot = { id: string; revision: number; name: string; minutes: number | null; items: ActivityPlanItem[]; archived: boolean;
  origin: { kind: 'manual' } | { kind: 'legacyPlan'; id: string; revision: number }; legacySnapshot?: LegacyPlanSnapshot; createdAt: string; updatedAt: string };
export type ActivityCalendar = { timeZone: string; activationDate: string; revision: number; calendarPolicy: 'activity-calendar-intl-v1'; createdAt: string };
export type ScheduleDay = { isoWeekday: number; expectation: 'workout' | 'exerciseSnack' | 'rest'; planSnapshot: ActivityPlanSnapshot | null };
export type ScheduleRevision = { id: string; revision: number; effectiveFrom: string; timeZone: string; week: ScheduleDay[]; createdAt: string };
export type PlanDaySnapshot = { localDate: string; revision: number; timeZone: string; dayStartAt: string; dayEndAt: string;
  calendarPolicy: 'activity-calendar-intl-v1'; scheduleId: string | null; scheduleRevision: number | null;
  expectation: 'workout' | 'exerciseSnack' | 'rest'; planSnapshot: ActivityPlanSnapshot | null;
  origin: 'acceptedSchedule' | 'explicitDayCorrection'; supersedesRevision: number | null };
export type LegacyPlanSnapshot = { id: string; revision: number; name: string; minutes: number; archived: boolean;
  items: { id: string; exerciseId: string; setTarget: number; repMin: number; repMax: number; targetKg: number }[] };
export type LegacyActivityEvidence = { sessionId: string; sessionRevision: number; localDate: string;
  dateBasis: 'startedAt_in_confirmed_zone'; hasConfirmedPerformance: boolean; confirmedOccurrenceCount?: number };
export interface LegacyTrainingReader {
  readPlanRevision(accountId: string, planId: string, revision: number): LegacyPlanSnapshot | null;
  listCompletedEvidence(accountId: string, fromDate: string, toDate: string, timeZone: string): LegacyActivityEvidence[];
}
export type ActivityOperation = 'calendar.create' | 'exercise.create' | 'exercise.patch' | 'exercise.retire' | 'plan.create' |
  'plan.patch' | 'plan.archive' | 'plan.importLegacy' | 'schedule.write' | 'day.correct' | 'entry.create' | 'entry.patch' | 'entry.void';
export type ActivityLifecycleControl = Readonly<{
  assertSuppression: (accountId: string, epoch: number) => void;
  purgeReadiness: (requestId: string, accountId: string) => { status: 'ready'; epoch: number } | LifecycleResult;
}>;
export type ActivityDependencies = Readonly<{
  db: Sqlite;
  lifecycle: LifecycleBindings;
  lifecycleControl: ActivityLifecycleControl;
  // Root must bind trusted dataflow, including independently entered legacy origins, before hashing any command.
  assertPersistable: (context: AccountContext, operation: ActivityOperation, validatedIntent: unknown) => void;
  legacy?: LegacyTrainingReader;
  globalExerciseKind?: (id: string) => 'resistance' | 'timed' | 'run' | null;
  now?: () => Date;
}>;
export type ActivityCommunityField = 'workout' | 'exerciseSnack' | 'planAdherence' | 'workoutMinutes' | 'exerciseCount' | 'streakDays';
export type ActivityCommunityDay = Readonly<{
  localDate: string; timeZone: string; dayStartAt: string; dayEndAt: string; revision: number;
  workout?: 'recorded' | 'not_recorded' | 'unknown'; exerciseSnack?: 'recorded' | 'not_recorded' | 'unknown';
  planAdherence?: 'met' | 'not_met' | 'pending' | 'unknown' | 'not_applicable';
  workoutMinutes?: number; exerciseCount?: number; streakDays?: number;
}>;
export type CommunityReadInput = { subjectAccountId: string; from: string; to: string; fields: readonly ActivityCommunityField[] };
export type ActivityCommunityReader = Readonly<{ readDays: (input: CommunityReadInput) =>
  { status: 'available'; days: readonly ActivityCommunityDay[] } | { status: 'unavailable' } }>;
export type TrustedActivityCommunityContext = Readonly<{
  subjectAccountId: string;
  assertSubjectActive: () => void;
  // Rechecks canonical session, membership and current grants inside Community's synchronous read boundary.
  assertAuthorized: (input: CommunityReadInput) => void;
}>;
