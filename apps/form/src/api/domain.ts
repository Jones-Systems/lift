export type Revision = { revision: number };
export type AppMode = 'basic' | 'advanced';
export type MascotVariant = 'scholarly' | 'baby' | 'buff' | 'none';
export type AnimationStyle = 'short' | 'long';
export type Profile = Revision & {
  name: string; age: number | null; heightCm: number | null; weightKg: number | null;
  trainingBackground: 'new' | 'returning' | 'regular' | null; injuryHistory: string; goals: string[];
  trainingContext?: string;
};
export type Preferences = Revision & {
  appMode: AppMode;
  mascot: MascotVariant;
  animationStyle: AnimationStyle;
  loadUnit: 'kg' | 'lb'; heightUnit: 'cm' | 'ft-in'; coachVoice: 'calm' | 'direct' | 'encouraging';
  communication: 'concise' | 'detailed'; trainingDaysPerWeek: number; sessionMinutes: number;
  equipment: string[]; remindersEnabled: boolean;
};
export type Onboarding = Revision & {
  step: 'welcome' | 'name' | 'measurements' | 'background' | 'goals' | 'injuries' | 'preferences' | 'review';
  answers: Partial<Omit<Profile, 'revision'>>; preferences: Partial<Omit<Preferences, 'revision'>>;
  status: 'draft' | 'completed'; completedAt: string | null;
};
export type Account = { accountId: string; appAccountToken: string; profile: Profile; preferences: Preferences; onboarding: Onboarding };
export type Cue = { id: string; text: string; required: boolean };
export type Exercise = {
  id: string; name: string; loadLabel: string; retired: boolean; provenance: Record<string, unknown>;
  requiredConstraints: Cue[]; cues: Cue[];
};
export type PlanItem = {
  id: string; exerciseId: string; setTarget: number; repMin: number; repMax: number; targetKg: number;
};
export type Plan = Revision & {
  id: string; name: string; minutes: number; items: PlanItem[]; archived: boolean;
  createdAt: string; updatedAt: string;
};
export type PerformedSet = Revision & {
  id: string; occurrenceId: string; setNumber: number; reps: number; weightKg: number;
  status: 'draft' | 'confirmed' | 'voided'; createdAt: string; updatedAt: string;
};
export type WorkoutSession = Revision & {
  id: string; planId: string; planRevision: number; status: 'active' | 'completed';
  planSnapshot: Pick<Plan, 'name' | 'minutes' | 'items'>;
  occurrences: { id: string; itemId: string; exerciseId: string; position: number; target: PlanItem }[];
  sets: PerformedSet[]; startedAt: string; completedAt: string | null;
};
export type CuePreferences = Revision & {
  kept: string[]; rejected: string[]; order: string[]; replacementRequested: string[];
  exerciseId: string; requiredConstraints: Cue[]; availableCues: Cue[];
};
export type List<T> = { items: T[] };
export type History = List<WorkoutSession> & { nextBefore: string | null };
export type Stats = {
  confirmedSets: number; repetitions: number; volumeKg: number; completedSessions: number;
  byExercise: { exerciseId: string; confirmedSets: number; repetitions: number; volumeKg: number; maxWeightKg: number }[];
  units: { load: 'kg'; volume: 'kg-repetitions' }; includesActiveConfirmedSets: boolean;
};
export type EntitlementGrant = {
  id: string; entitlement: string; source: string; grantedAt: string; expiresAt: string | null;
  environment: string; active: boolean;
};
export type Entitlements = {
  accountId: string; appAccountToken: string; grants: EntitlementGrant[]; active: string[];
  purchases: {
    status: 'unconfigured' | 'configured_unverified'; environment: 'Sandbox'; chargesEnabled: false;
    verification: 'apple_jws_offline'; onlineCertificateRevocation: false;
  };
};
export type Capabilities = {
  authentication: {
    emailPassword: { status: string; registration: 'closed' | 'allowlist'; passwordRecovery: string };
    google: { status: string }; apple: { status: string }; phone: { status: string };
    session: { transport: string; expiresInSeconds: number };
  };
  transcription: { grok: { status: string }; appleOnDevice: { status: string } };
  purchases: { apple: { status: string }; chargesEnabled: false };
  promos: { status: string; chargesEnabled: false };
};

export type LegacyPlan = Plan;
export type SourceNativeRecordIdentity = {
  repository: string; revision: string; path: string; sha256: string; nativeId: string;
};
export type SourceRegistrationPin = { id: string; revision: string; digest: string; bytes: number };
export type NativePrescription = {
  exercise_id: string; movement_pattern: string; role: string; sets: number; rest_seconds: number;
  rep_range?: [number, number]; target_rir?: number; substituted_for?: string; notes?: string[];
};
export type SourceUnknownLoad = { kind: 'unspecified'; basis: 'unknown' };
export type SourcePrescriptionItem = {
  id: string; native: NativePrescription;
  registeredDomain: {
    exerciseId: string; variantId: string; identity: SourceNativeRecordIdentity;
    registration: SourceRegistrationPin; recordDigest: string;
  };
  load: SourceUnknownLoad;
};
export type SourcePrescriptionPlanFields = {
  schema: 'form.source-prescription-plan/v1'; name: string;
  origin: { kind: 'form-adaptation'; id: string; revision: string };
  duration: { kind: 'estimated-range'; minMinutes: number; maxMinutes: number };
  items: SourcePrescriptionItem[];
};
export type SourcePlan = SourcePrescriptionPlanFields & Revision & {
  id: string; archived: boolean; createdAt: string; updatedAt: string;
};
export type StoredPlan = LegacyPlan | SourcePlan;
export type SourceReportedLoad =
  | { state: 'knownValue'; value: number; unit: 'kg' | 'lb'; basis: 'total' | 'perImplement' | 'perSide' | 'assistance' }
  | { state: 'unknown'; confirmed: true }
  | { state: 'notApplicable'; reason: 'bodyweight' | 'unloaded' | 'timedActivity' };
export type SourcePerformanceV1 =
  | { schema: 'form.source-performance/v1'; kind: 'repetitions'; reps: number; load: SourceUnknownLoad }
  | { schema: 'form.source-performance/v1'; kind: 'controlled-practice'; load: SourceUnknownLoad };
export type SourcePerformanceV2 =
  | { schema: 'form.source-performance/v2'; kind: 'repetitions'; reps: number; load: SourceReportedLoad }
  | { schema: 'form.source-performance/v2'; kind: 'controlled-practice'; load: SourceReportedLoad };
export type SourcePerformance = SourcePerformanceV1 | SourcePerformanceV2;
type SourceSetVersion =
  | { schema: 'form.source-performed-set/v1'; performance: SourcePerformanceV1 }
  | { schema: 'form.source-performed-set/v2'; performance: SourcePerformanceV2 };
export type SourceSetPatch = SourceSetVersion & { expectedRevision: number; status: 'draft' | 'confirmed' };
export type SourceSetCreate = SourceSetPatch & { occurrenceId: string; setNumber: number };
export type SourcePerformedSet = Omit<PerformedSet, 'reps' | 'weightKg'> & SourceSetVersion;
export type SavedSet = PerformedSet | SourcePerformedSet;
export type StoredSetReceipt = { set: SavedSet; sessionRevision: number };
export type LegacyWorkoutSessionWire = Omit<WorkoutSession, 'planSnapshot'> & { planSnapshot: LegacyPlan };
export type SourceWorkoutSession = Omit<WorkoutSession, 'planSnapshot' | 'occurrences' | 'sets'> & {
  planSnapshot: SourcePlan;
  occurrences: { id: string; itemId: string; exerciseId: string; position: number; target: SourcePrescriptionItem }[];
  sets: SourcePerformedSet[];
};
export type StoredWorkoutSession = LegacyWorkoutSessionWire | SourceWorkoutSession;
export type StoredHistory = List<StoredWorkoutSession> & { nextBefore: string | null };
export type SourceStatsCoverage = { repetitionSets: number; loadSets: number; practiceSets: number };
export type SourceStatsMetrics = {
  confirmedSets: number; repetitions: number | null; volumeKg: null; maxWeightKg: null; coverage: SourceStatsCoverage;
};
export type StoredExerciseStats = Stats['byExercise'][number] | (SourceStatsMetrics & { exerciseId: string });
export type SourceStats = SourceStatsMetrics & {
  completedSessions: number; byExercise: StoredExerciseStats[];
  units: Stats['units']; includesActiveConfirmedSets: boolean;
};
export type StoredStats = Stats | SourceStats;
