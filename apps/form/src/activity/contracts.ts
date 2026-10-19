export type ExerciseRef = { source: 'global'; id: string } | { source: 'personal'; id: string; revision: number };
export type Load =
  | { state: 'knownValue'; value: number; unit: 'kg' | 'lb'; basis: 'total' | 'perImplement' | 'perSide' | 'assistance' | 'unspecified' }
  | { state: 'unknown'; confirmed: true }
  | { state: 'notApplicable'; reason: 'bodyweight' | 'unloaded' | 'timedActivity' };
export type PersonalExerciseFields = {
  name: string; description: string; movement: string | null;
  measurementType: 'repetitions' | 'duration' | 'distance' | 'mixed' | 'unspecified';
  kind: 'resistance' | 'timed' | 'run';
  loadApplicability: 'applicable' | 'notApplicable' | 'unspecified'; loadLabel: string | null;
};
export type ExerciseSnapshot = PersonalExerciseFields & {
  ref: ExerciseRef; guidance: 'globalReference' | 'userDefinedUnassessed';
  cueStatus: 'globalReference' | 'unknown'; safetyAssessment: 'notEstablished';
};
export type PersonalExercise = PersonalExerciseFields & {
  id: string; revision: number; retired: boolean; createdAt: string; updatedAt: string;
};
export type Distance = { value: number; unit: 'm' | 'km' | 'mi' };
export type Pace = { secondsPerUnit: number; unit: 'km' | 'mi' };
export type Speed = { value: number; unit: 'm/s' | 'km/h' | 'mi/h' };
export type Split = { id: string; sequence: number; durationSeconds: number; distance?: Distance; pace?: Pace; speed?: Speed };
export type SetObservation = { id: string; repetitions?: number; durationSeconds?: number; load: Load };
export type ActivityItemInput = {
  id: string; exercise: ExerciseRef; load: Load; sets?: SetObservation[]; reportedSetCount?: number;
  durationSeconds?: number; distance?: Distance; pace?: Pace; speed?: Speed; splits?: Split[]; splitCoverage?: 'partial' | 'complete';
};
export type ActivityDate = {
  localDate: string; timeZone: string; calendar: 'iso8601';
  source: 'selected' | 'spokenExplicit' | 'spokenRelative' | 'captureDefault';
  capturedAt: string; referenceLocalDate: string; confirmed: true;
};
export type ActivityWrite = {
  date: ActivityDate; kind: 'workout' | 'exerciseSnack'; items: ActivityItemInput[];
  performedConfirmed: true; source: 'manual' | 'nativeSpeech'; draftId: string;
  acknowledgedIssues: { fieldPath: string; code: 'approximateMetrics' | 'possibleDuplicate' }[];
};
export type ActivityEntry = Pick<ActivityWrite, 'performedConfirmed' | 'draftId' | 'acknowledgedIssues'> & {
  id: string; revision: number; status: 'recorded' | 'voided'; date: ActivityDate;
  kind: ActivityWrite['kind']; items: (ActivityItemInput & { snapshot: ExerciseSnapshot })[];
  source: ActivityWrite['source']; createdAt: string; updatedAt: string;
};
export type ActivityPage<T> = { items: T[]; nextCursor: string | null };
export type ActivityCalendar = { timeZone: string; activationDate: string; revision: number; calendarPolicy: 'activity-calendar-intl-v1'; createdAt: string };
export type ActivityPlanTarget = { setCount?: number; repMin?: number; repMax?: number; load?: Load; durationSeconds?: number; distance?: Distance };
export type ActivityPlanItemInput = { id: string; exercise: ExerciseRef; target: ActivityPlanTarget };
export type ActivityPlanFields = { name: string; minutes: number | null; items: ActivityPlanItemInput[] };
export type ActivityPlan = Omit<ActivityPlanFields, 'items'> & {
  items: (ActivityPlanItemInput & { snapshot: ExerciseSnapshot })[];
  id: string; revision: number; archived: boolean; createdAt: string; updatedAt: string;
  origin: { kind: 'manual' } | { kind: 'legacyPlan'; id: string; revision: number };
};
export type DayExpectation = 'workout' | 'exerciseSnack' | 'rest';
export type ScheduleDay = { isoWeekday: 1 | 2 | 3 | 4 | 5 | 6 | 7; expectation: DayExpectation; plan: { id: string; revision: number } | null };
export type ScheduleWrite = { expectedRevision: number; effectiveFrom: string; week: ScheduleDay[] };
export type ScheduleRevision = Omit<ScheduleWrite, 'expectedRevision' | 'week'> & { id: string; revision: number; timeZone: string; createdAt: string; week: { isoWeekday: number; expectation: DayExpectation; planSnapshot: ActivityPlan | null }[] };
export type DayCorrection = { expectedRevision: number; expectation: DayExpectation; plan: { id: string; revision: number } | null; reason: 'scheduleWasIncorrect'; confirmed: true };
export type PlanDaySnapshot = {
  localDate: string; revision: number; timeZone: string; dayStartAt: string; dayEndAt: string;
  calendarPolicy: 'activity-calendar-intl-v1'; scheduleId: string | null; scheduleRevision: number | null; expectation: DayExpectation;
  planSnapshot: ActivityPlan | null; origin: 'acceptedSchedule' | 'explicitDayCorrection'; supersedesRevision: number | null;
};
export type AdherenceDay = {
  actual: 'met' | 'not_met' | 'pending' | 'unknown'; currentPlanDays: number; longestPlanDays: number;
  localDate: string; state: 'activityRecorded' | 'plannedRest' | 'protectedMiss' | 'missed' | 'pending' | 'unknownPlan';
  dayStartAt: string; dayEndAt: string; timeZone: string; revision: number; planDay: PlanDaySnapshot | null;
};
export type Adherence = {
  policyVersion: 'activity-adherence-v1'; asOf: string; timeZone: string; coverageStart: string | null; throughDate: string;
  currentPlanDays: number; longestPlanDays: number; satisfiedDaysInCurrentStreak: number; protectedDaysInCurrentStreak: number;
  monthlyAllowance: { month: string; protectedDate: string | null; remaining: 0 | 1 }; days: AdherenceDay[];
  sourceGeneration: { activity: number; projectionRevision: number; legacyAvailable: boolean; legacy: { sessionId: string; revision: number }[] };
};
export type ActivityCatalog = { items: ExerciseSnapshot[]; selectionUses: ('manual' | 'nativeSpeech' | 'activityPlan' | 'recommendationChoice')[] };
export type ActivityCapabilities = {
  sourceStatus: 'candidate_unverified'; migrationVersion: 8; calendar: 'configured' | 'not_configured';
  calendarPolicy: 'activity-calendar-intl-v1'; legacyEvidence: 'bound_unverified' | 'unavailable';
  parser: 'client_only'; transcriptUpload: false;
};
