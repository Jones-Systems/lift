// Public integration contract for the account-backed Form shell.
// Mirrors docs/workstreams/form-accounts-onboarding/continuation/mobile/onboarding/integration-contract.md.
import type { ReactNode } from 'react';
import type { ApiError } from '../api/client';
import type { AuthAttemptGuard } from '../api/transport';
import type { CredentialsPort } from '../api/credentials';
import type {
  Account, AppMode, Capabilities, Entitlements, Exercise, Plan, Preferences, Profile, SourcePlan, StoredPlan,
} from '../api/domain';
import type { FormResources } from '../api/resources';
import type { AccountSettings } from '../api/settings';
import type { LifecycleHostSession, LifecycleShellBinding } from '../integration/lifecycleSession';
import type { CommandOwner, CommandOwnerSession } from '../integration/commandOwnerSession';
import type { SharedVoiceScope } from '../integration/sharedVoice';
import type { StandardCoachingSession } from '../integration/standardCoachingSession';
import type { ManualProgressController } from '../integration/manualProgressSession';
import type { StandardVoiceConsumerOptions } from '../voice-coaching/standard';
import type { TeardownReason } from '../voice-coaching/contracts';
import type { PresentationPolicy } from '../integration/presentationPolicy';
import type { SourceTrainingRenderer } from './training';
import type { createContextConfirmation, ContextConfirmationResult } from '../integration/contextConfirmation';
import type { SavedFirstPlanDestination } from '../integration/savedFirstPlanDestination';
import type { ReviewedSpeechText, SpeechAvailability, SpeechDraft, SpeechPermissions } from '../native/speech.types';

export type { AppMode, StandardCoachingSession, ManualProgressController };

export type FormAccountAppProps = {
  /** Root-owned transport; the shell uses resources.api for restore/sign-in/sign-out and FormResources for data. */
  resources: FormResources;
  onBeforeVoiceExit?: (input: Readonly<{ scope: SharedVoiceScope; reason: TeardownReason }>) => void;
  /** Authoritative account-wide mode: account.preferences.appMode ?? 'basic'. Only Settings selects it. */
  appMode: AppMode;
  /** Settings component slot; the only place appMode is chosen. */
  renderSettings: (ctx: SettingsSlotContext) => ReactNode;
  openEdit?: SettingsSlotContext['openEdit'];
  renderAccountSecurity?: (ctx: AccountSecuritySlotContext) => ReactNode;
  renderMembership?: (ctx: FeatureSlotContext) => ReactNode;
  renderHealth?: (ctx: FeatureSlotContext) => ReactNode;
  /** Home root (training leaf). Without it the v1 today.account-entry is shown, with no workout start. */
  renderHome?: (ctx: HomeSlotContext) => ReactNode;
  /**
   * Optional Context consumer: retain one initial capture promise per admitted entry across rerenders/effect reattachment.
   * Renderer cleanup must not dispose the controller or recapture a pending/unknown command.
   */
  renderContextConfirmation?: (ctx: ContextConfirmationSlotContext) => ReactNode;
  /** A supplied source-aware renderer is required before a saved source plan can be opened. */
  renderSourcePlanDetail?: (ctx: SourcePlanDetailSlotContext) => ReactNode;
  /** Source training actions require an explicitly supplied source-aware presentation. */
  renderSourceTraining?: SourceTrainingRenderer;
  /** Optional body-assessment seam; absent means no entry point is shown. */
  renderBody?: (ctx: FeatureSlotContext) => ReactNode;
  /** Community lane (groups/privacy). Navigation seam only; absent means no entry point. */
  renderCommunity?: (ctx: FeatureSlotContext) => ReactNode;
  /** Activity lane (logging/catalog/streaks). Navigation seam only; absent means no entry point. */
  renderActivity?: (ctx: FeatureSlotContext) => ReactNode;
  /**
   * Feature requests board (B5, Community-owned module and screens). Navigation seam only: when present, Settings shows
   * one "Feature requests" row in its grouped list. Absent means no entry point. No new tab.
   */
  renderFeatureRequests?: (ctx: FeatureSlotContext) => ReactNode;
  identity?: IdentityPorts;
  /** Standalone speech factory; the root shared factory takes precedence when supplied. */
  speech?: () => SpeechPort;
  scopedSpeech?: (scope: SharedVoiceScope | null) => SpeechPort;
  lifecycleSession?: (binding: LifecycleShellBinding) => LifecycleHostSession;
  commandOwnerForSession?: (session: CommandOwnerSession) => CommandOwner | null;
  /** Root/backend-owned first-plan generator. Absent or null means no plan is invented. */
  firstPlan?: (account: Account, exercises: Exercise[]) => PlanDraft | null;
  /** Shown only while purchases are configured and the account has no active entitlement. */
  onMemberships?: () => void;
  onOpenSystemSettings?: () => void;
  /** Notification permission port. Absent: the reminders toggle is hidden (server effect is preference-only). */
  notifications?: { request(): Promise<'granted' | 'denied'> };
  /**
   * Root-owned session revocation transport (paths from AccountSettings.capabilities). Must keep the Keychain session
   * when the result is unknown. After revokeAllSessions is saved the shell returns to sign-in.
   */
  onSessionAction?: (action: SessionAction) => Promise<SaveResult<null>>;
  onSnapshot?: (snapshot: FormAccountSnapshot) => void;
};

export type SessionAction = 'revokeOtherSessions' | 'revokeAllSessions';

export type PlanDraft = Pick<Plan, 'name' | 'minutes' | 'items'>;
export type FirstPlanCommand = FormResources['createFirstPlan'];

export type SessionPhase = 'restoring' | 'signed-out' | 'loading' | 'onboarding' | 'ready' | 'error';

export type FormAccountSnapshot = {
  phase: SessionPhase;
  account: Account | null;
  entitlements: Entitlements | null;
  capabilities: Capabilities | null;
};

export type SaveResult<T> =
  | { status: 'saved'; value: T }
  | { status: 'stale'; latest: T }
  | { status: 'unknown'; retry: () => Promise<SaveResult<T>> }
  | { status: 'failed'; error: ApiError };

export type SettingsSlotContext = {
  lifecycle?: LifecycleHostSession;
  presentation?: PresentationPolicy;
  account: Account;
  appMode: AppMode;
  resources: FormResources;
  /** GET /v1/me/settings; null while loading or unavailable. */
  settings: AccountSettings | null;
  /** Present only when root supplies onSessionAction. */
  sessionAction?: (action: SessionAction) => Promise<SaveResult<null>>;
  capabilities: Capabilities | null;
  entitlements: Entitlements | null;
  savePreferences(changes: Partial<Omit<Preferences, 'revision'>>): Promise<SaveResult<Preferences>>;
  saveProfile(changes: Partial<Omit<Profile, 'revision'>>): Promise<SaveResult<Profile>>;
  signOut(): Promise<SaveResult<null>>;
  openAccess(): void;
  openPlans(): void;
  openAccount(): void;
  close(): void;
  reload(): Promise<void>;
  openAccountSecurity?: () => void;
  openMembership?: () => void;
  openHealth?: () => void;
  /* Optional additive seams (settings-training v2 contracts.md#slot-adapter). Each is absent-safe: Settings draws the
     documented fallback (openEdit → openAccount; no system-settings link; no body or community row). */
  /** The shell's existing edit sheets/screens for one Profile or Training row. */
  openEdit?: (target: SettingsEditTarget) => void;
  /** Movement list for Settings → Training → Cues (DGR-016). */
  openCuesIndex?: () => void;
  /** Forwarded FormAccountAppProps.onOpenSystemSettings. */
  openSystemSettings?: () => void;
  /** Present only when root supplies renderBody (DGR-015). */
  openBody?: () => void;
  /** Present only when root supplies renderCommunity; group privacy lives in that lane. */
  openCommunitySettings?: () => void;
  /** Present only when root supplies renderFeatureRequests (B5, Community-owned board). */
  openFeatureRequests?: () => void;
  /** Body lane privacy summary; absent → unavailable. Settings displays it and never interprets body data. */
  bodyPrivacy?: BodyPrivacySummary;
  openBodyChoice?: (row: 'photos' | 'derived' | 'improvement') => void;
};

export type AccountSecuritySlotContext = SettingsSlotContext & {
  credentials: CredentialsPort;
  sessionGeneration: string;
  isCurrentSession(): boolean;
  onSignedOut(): void;
};

export type SettingsEditTarget =
  | 'name' | 'age' | 'body' | 'experience' | 'goals' | 'workAround' | 'schedule' | 'equipment' | 'coach' | 'cues';

/** Three independent purpose-specific body choices; never combined into one row (compliance report 2026-10-09). */
export type BodyChoiceRow = { label: string; value: string };
export type BodyPrivacySummary =
  | { status: 'unavailable'; reason: string }
  | { status: 'loading' }
  | { status: 'error'; error: ApiError }
  | { status: 'ready'; photos: BodyChoiceRow; derived: BodyChoiceRow; improvement: BodyChoiceRow };

export type HomeSlotContext = {
  presentation?: PresentationPolicy;
  sessionGeneration: string;
  isCurrentSession(): boolean;
  account: Account;
  appMode: AppMode;
  resources: FormResources;
  plans: Plan[];
  activePlan: Plan | null;
  readonly storedPlans: readonly StoredPlan[];
  renderSourceTraining?: SourceTrainingRenderer;
  /** Register the persistent Home owner for selection only; disposal must unregister this exact owner. */
  registerSourceTraining?: (selectExactPlan: (plan: SourcePlan) => boolean) => () => void;
  exercises: Exercise[];
  entitlements: Entitlements | null;
  openAccount(): void;
  openPlans(): void;
  openPlan(planId: string): void;
  /** Only a confirmed saved receipt can create a guarded, read-only destination. */
  savedFirstPlanDestination(saved: ContextConfirmationResult): SavedFirstPlanDestination | null;
  openContextConfirmation?: () => void;
  openCues(exerciseId: string, backLabel: string): void;
  openSettings(): void;
  openBody?: () => void;
  openCommunity?: () => void;
  openActivity?: () => void;
  reload(): Promise<void>;
};

/** The verified source snapshot remains in its original account session; this port does not provide an editor. */
export type SourcePlanDetailSlotContext = Readonly<{
  account: Account;
  appMode: AppMode;
  resources: FormResources;
  sessionGeneration: string;
  isCurrentSession(): boolean;
  plan: SourcePlan;
  /** Select this exact plan in persistent Home. Starting a workout still requires its explicit user action. */
  start?: () => boolean;
  close(): void;
}>;

/** The shell retains the controller across presentation; only session teardown disposes it. */
export type ContextConfirmationSlotContext = Readonly<{
  sessionGeneration: string;
  isCurrentSession(): boolean;
  confirmation: ReturnType<typeof createContextConfirmation>;
  savedFirstPlanDestination: HomeSlotContext['savedFirstPlanDestination'];
  close(): void;
}>;

/** Context for external full-screen lanes (body, community, activity). appMode is the one account-wide mode. */
export type FeatureSlotContext = {
  commandOwner?: CommandOwner;
  presentation?: PresentationPolicy;
  account: Account; appMode: AppMode; resources: FormResources; close(): void;
  /** Memory-only identity for this sign-in, including a fresh sign-in of the same account. */
  sessionGeneration: string;
  voiceScope?: SharedVoiceScope;
  createStandardCoaching?: (onManual: StandardVoiceConsumerOptions['onManual']) => StandardCoachingSession | null;
  createManualProgress?: () => ManualProgressController | null;
  /** Recheck before dispatch and after asynchronous work; never replay an old intent under a new session. */
  isCurrentSession(): boolean;
};
/** @deprecated alias kept for the published contract draft. */
export type BodySlotContext = FeatureSlotContext;

export type IdentityPorts = {
  apple?: (guard?: AuthAttemptGuard) => Promise<unknown>;
  google?: (guard?: AuthAttemptGuard) => Promise<unknown>;
  /** Construct an attempt for one current auth flow; default native binding uses async cryptographic bytes. */
  phoneFactory?: (guard: AuthAttemptGuard) => PhoneAuthPort & { dispose(): void };
  phone?: PhoneAuthPort;
};

export type PhoneChallenge = { challengeId: string; phoneNumber: string; status: string; expiresAt: string; resendAfter: string };

export interface PhoneAuthPort {
  challenge(phoneNumber: string, key: string): Promise<PhoneChallenge>;
  resend(challenge: PhoneChallenge, key: string): Promise<PhoneChallenge>;
  verify(challenge: PhoneChallenge, code: string, key: string): Promise<unknown>;
}

export interface SpeechPort {
  availability(locale: string): Promise<SpeechAvailability>;
  requestPermissions(): Promise<SpeechPermissions>;
  start(locale: string): Promise<string>;
  stop(): Promise<void>;
  cancel(): Promise<void>;
  subscribe(observer: (draft: SpeechDraft | null) => void): { remove(): void };
  acceptReview(review: { sessionId: string; text: string; reviewed: true }): ReviewedSpeechText;
  dispose(): Promise<void>;
}
