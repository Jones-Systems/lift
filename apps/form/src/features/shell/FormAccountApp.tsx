// Account-backed Form shell: session restore, sign-in, onboarding, account/plans/cues/access and external slots.
// All state comes from the server through FormResources; nothing here grants access or invents success.
//
// Session isolation: every sign-in, restore and sign-out starts a new session epoch. Each async operation captures
// its actor (epoch + account) before it starts and rechecks it before EVERY state commit, error, navigation and retry.
// Obsolete responses are ignored, and an unknown result from an earlier session is never replayed under a new token.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AppState, Pressable, StyleSheet, View } from 'react-native';
import { ApiError, commandKey } from '../../api/client';
import type { Account, Capabilities, Entitlements, Exercise, Plan, Preferences, Profile, SourcePlan, StoredPlan } from '../../api/domain';
import { decodePlan } from '../../api/trainingCodec';
import type { AccountSettings } from '../../api/settings';
import type { AuthAttemptGuard } from '../../api/transport';
import type { TeardownReason } from '../../voice-coaching/contracts';
import type { LifecycleHostSession } from '../../integration/lifecycleSession';
import { captureAccountSession } from '../../integration/accountSession';
import { captureAccountSecuritySession } from '../../integration/accountSecuritySession';
import { createContextConfirmation } from '../../integration/contextConfirmation';
import { createSavedFirstPlanDestination } from '../../integration/savedFirstPlanDestination';
import { captureSharedVoiceScope, type SharedVoiceScope } from '../../integration/sharedVoice';
import { FormSpeechAdapter } from '../../native/speech';
import { AccountScreen, AccessScreen, type AccountRowId } from '../account/AccountScreens';
import { AuthFlow } from '../auth/AuthFlow';
import type {
  AccountSecuritySlotContext, FeatureSlotContext, FormAccountAppProps, HomeSlotContext, SaveResult, SessionAction, SessionPhase, SettingsSlotContext, SourcePlanDetailSlotContext, SpeechPort,
} from '../contract';
import { CuesScreen } from '../cues/CuesScreen';
import { OnboardingFlow } from '../onboarding/OnboardingFlow';
import { PlanEditScreen, PlansScreen } from '../plans/PlansScreens';
import { asApiError, guardedSave } from '../shared/commands';
import { COPY, errorCopy, movementWord, setWord } from '../shared/copy';
import { L, t } from '../shared/tokens';
import {
  AccountRow, Art, Gutter, MetaLine, Nav, Notice, PrimaryAction, Screen, Section, Spinner, Subtitle, Title, Txt, Wordmark,
} from '../shared/ui';

type Route =
  | { name: 'home' }
  | { name: 'account' }
  | { name: 'plans'; back: string }
  | { name: 'plan-edit'; planId: string | null; verifiedPlan?: Plan }
  | { name: 'source-plan-detail'; context: SourcePlanDetailSlotContext; render: NonNullable<FormAccountAppProps['renderSourcePlanDetail']> }
  | { name: 'cues-index'; back: string }
  | { name: 'cues'; exerciseId: string; back: string }
  | { name: 'access' }
  | { name: 'settings' }
  | { name: 'account-security'; admission: ReturnType<typeof captureAccountSecuritySession>; context: AccountSecuritySlotContext;
      render: NonNullable<FormAccountAppProps['renderAccountSecurity']> }
  | { name: 'membership' | 'health'; context: FeatureSlotContext; render: NonNullable<FormAccountAppProps['renderMembership']> }
  | { name: 'body' }
  | { name: 'community' }
  | { name: 'activity' }
  | { name: 'context-confirmation' }
  | { name: 'feature-requests' };

type Data = {
  account: Account | null;
  entitlements: Entitlements | null;
  settings: AccountSettings | null;
  plans: StoredPlan[];
  exercises: Exercise[];
  plansError: string | null;
};
const EMPTY: Data = { account: null, entitlements: null, settings: null, plans: [], exercises: [], plansError: null };

/** The session an async operation started in. accountId is null before the account is known. */
type Actor = { epoch: number; accountId: string | null };
type AuthTransition = {
  starting: boolean;
  completed: boolean;
  invalidated: { epoch: number; auth: AuthAttemptGuard } | null;
};

const sessionChanged = (originalEffectUnknown = false) => new ApiError(409, 'session_changed',
  'The account session changed. Check the original account before repeating a change.', false, originalEffectUnknown);

export function FormAccountApp(props: FormAccountAppProps) {
  const { resources, appMode, onSnapshot } = props;
  const [phase, setPhase] = useState<SessionPhase>('restoring');
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  const [data, setData] = useState<Data>(EMPTY);
  const [routes, setRoutes] = useState<Route[]>([{ name: 'home' }]);
  const [notice, setNotice] = useState<string | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const latest = useRef(data);
  latest.current = data;

  /* ---------------- session epoch and actor guard ---------------- */

  const epochRef = useRef(0);
  const authTransition = useRef<AuthTransition | null>(null);
  const [shellGeneration] = useState(commandKey);
  const mounted = useRef(true);
  const heldVoiceScope = useRef<SharedVoiceScope | null>(null);
  const voiceExitObserver = useRef(props.onBeforeVoiceExit);
  voiceExitObserver.current = props.onBeforeVoiceExit;
  const notifyVoiceExit = useCallback((scope: SharedVoiceScope | null, reason: TeardownReason) => {
    if (!scope) return;
    try { voiceExitObserver.current?.({ scope, reason }); } catch { /* A stop observer cannot block the admitted shell transition. */ }
  }, []);
  const expireVoiceScope = useCallback((reason: TeardownReason) => {
    const original = heldVoiceScope.current;
    notifyVoiceExit(original, reason);
    if (heldVoiceScope.current === original) heldVoiceScope.current = null;
  }, [notifyVoiceExit]);
  useEffect(() => {
    mounted.current = true;
    return () => { expireVoiceScope('navigation'); mounted.current = false; epochRef.current += 1; };
  }, [expireVoiceScope]);
  const actor = useCallback((): Actor => ({ epoch: epochRef.current, accountId: latest.current.account?.accountId ?? null }), []);
  const isCurrent = useCallback((who: Actor) => mounted.current && epochRef.current === who.epoch, []);
  /** Functional data update applied only while the same session and the same account are still shown. */
  const commitFor = useCallback((who: Actor, fn: (d: Data) => Data) => {
    if (!isCurrent(who)) return;
    setData((d) => (isCurrent(who) && d.account && d.account.accountId === who.accountId ? fn(d) : d));
  }, [isCurrent]);
  /** Binds a callback (child screen, slot ctx, navigation) to the session it was rendered in. */
  const bind = useCallback(<A extends unknown[]>(who: Actor, fn: (...args: A) => void) =>
    (...args: A) => { if (isCurrent(who)) fn(...args); }, [isCurrent]);

  const renderedEpoch = epochRef.current;
  const currentResources = useRef(resources);
  currentResources.current = resources;
  const editPort = useRef({ callback: props.openEdit, generation: 0 });
  if (editPort.current.callback !== props.openEdit) {
    editPort.current = { callback: props.openEdit, generation: editPort.current.generation + 1 };
  }
  const accountRenderers = useRef({ security: props.renderAccountSecurity, membership: props.renderMembership, health: props.renderHealth,
    generations: { security: 0, membership: 0, health: 0 } });
  if (accountRenderers.current.security !== props.renderAccountSecurity ||
    accountRenderers.current.membership !== props.renderMembership || accountRenderers.current.health !== props.renderHealth) {
    const previous = accountRenderers.current;
    accountRenderers.current = { security: props.renderAccountSecurity, membership: props.renderMembership, health: props.renderHealth,
      generations: {
        security: previous.generations.security + Number(previous.security !== props.renderAccountSecurity),
        membership: previous.generations.membership + Number(previous.membership !== props.renderMembership),
        health: previous.generations.health + Number(previous.health !== props.renderHealth),
      } };
  }
  const activeRoutes = useRef(routes);
  activeRoutes.current = routes;
  const securityAdmission = useRef<ReturnType<typeof captureAccountSecuritySession> | null>(null);
  const transitionRoutes = useCallback((next: Route[], current: () => boolean = () => true) => {
    if (!current()) return;
    const previous = activeRoutes.current[activeRoutes.current.length - 1];
    if (previous !== next[next.length - 1]) notifyVoiceExit(heldVoiceScope.current, 'navigation');
    if (!current()) return;
    // Expire the departing admission before React can defer the route state commit.
    activeRoutes.current = next;
    if (previous !== next[next.length - 1]) {
      if (previous.name === 'membership' || previous.name === 'health') previous.context.isCurrentSession();
      if (previous.name === 'account-security') { previous.admission.dispose(); securityAdmission.current = null; }
    }
    setRoutes(r => current() ? next : r);
  }, [notifyVoiceExit]);
  const retainedSecurity = securityAdmission.current;
  if (retainedSecurity && (!routes.some(route => route.name === 'account-security' && route.admission === retainedSecurity) ||
    !retainedSecurity.isCurrentSession())) {
    retainedSecurity.dispose(); securityAdmission.current = null;
  }
  useEffect(() => () => { securityAdmission.current?.dispose(); securityAdmission.current = null; }, []);
  const sourceRenderer = useRef(props.renderSourcePlanDetail);
  sourceRenderer.current = props.renderSourcePlanDetail;
  const sourcePresentation = useRef({ detail: props.renderSourcePlanDetail, training: props.renderSourceTraining,
    home: props.renderHome, generation: 0 });
  if (sourcePresentation.current.detail !== props.renderSourcePlanDetail ||
    sourcePresentation.current.training !== props.renderSourceTraining || sourcePresentation.current.home !== props.renderHome) {
    sourcePresentation.current = { detail: props.renderSourcePlanDetail, training: props.renderSourceTraining,
      home: props.renderHome, generation: sourcePresentation.current.generation + 1 };
  }
  const presentationGeneration = sourcePresentation.current.generation;
  const accountAuth = useRef<{ resources: FormAccountAppProps['resources']; guard: AuthAttemptGuard } | null>(null);
  const accountSession = useMemo(() => {
    const accountId = data.account?.accountId;
    if (!accountId || accountAuth.current?.resources !== resources) return null;
    const originalAuth = accountAuth.current.guard;
    const captured = captureAccountSession(resources, {
      accountId, sessionGeneration: `${shellGeneration}:${renderedEpoch}`,
      isCurrentSession: () => mounted.current && currentResources.current === resources &&
        epochRef.current === renderedEpoch && latest.current.account?.accountId === accountId,
    }, originalAuth);
    return Object.freeze({ ...captured, commandSession: Object.freeze({
      accountId, sessionGeneration: captured.sessionGeneration, resources, originalAuth,
      isCurrentSession: captured.isCurrentSession,
    }) });
  }, [resources, data.account?.accountId, renderedEpoch, shellGeneration]);
  const sourceTrainingOwner = useRef<{
    session: NonNullable<typeof accountSession>;
    presentationGeneration: number;
    selectPlan: (plan: SourcePlan) => boolean;
  } | null>(null);
  const registerSourceTraining = useMemo<HomeSlotContext['registerSourceTraining']>(() => {
    const session = accountSession;
    if (!session || !props.renderHome || !props.renderSourceTraining) return undefined;
    return selectPlan => {
      if (!session.isCurrentSession() || sourcePresentation.current.generation !== presentationGeneration) return () => {};
      const owner = { session, presentationGeneration, selectPlan };
      sourceTrainingOwner.current = owner;
      return () => { if (sourceTrainingOwner.current === owner) sourceTrainingOwner.current = null; };
    };
  }, [accountSession, presentationGeneration, props.renderHome, props.renderSourceTraining]);
  const contextConfirmation = useRef<{
    session: NonNullable<typeof accountSession>;
    editGeneration: number;
    confirmation: ReturnType<typeof createContextConfirmation>;
  } | null>(null);
  if (contextConfirmation.current && contextConfirmation.current.editGeneration !== editPort.current.generation) {
    const retained = contextConfirmation.current, state = retained.confirmation.snapshot();
    if (state.status === 'ready' || state.status === 'loading') retained.confirmation.cancel();
  }
  useEffect(() => () => {
    const retained = contextConfirmation.current;
    if (retained && retained.session === accountSession) {
      retained.confirmation.dispose();
      contextConfirmation.current = null;
    }
  }, [accountSession]);
  const commandOwner = useMemo(() => {
    if (!accountSession || !props.commandOwnerForSession) return null;
    try { return props.commandOwnerForSession(accountSession.commandSession); } catch { return null; }
  }, [accountSession, props.commandOwnerForSession]);
  const voiceScope = useMemo<SharedVoiceScope | null>(() => {
    const accountId = data.account?.accountId;
    if (!accountId) return null;
    return captureSharedVoiceScope(resources.api,
      { accountId, accountEpoch: renderedEpoch, authSessionId: `${shellGeneration}:${renderedEpoch}` },
      () => !!accountSession?.isCurrentSession());
  }, [resources, data.account?.accountId, renderedEpoch, shellGeneration, accountSession]);
  if (voiceScope && accountSession?.isCurrentSession()) heldVoiceScope.current = voiceScope;
  const speech = useMemo<SpeechPort>(() => props.scopedSpeech ? props.scopedSpeech(voiceScope)
    : props.speech ? props.speech() : new FormSpeechAdapter(), [props.scopedSpeech, props.speech, voiceScope]);
  useEffect(() => () => { void speech.dispose().catch(() => {}); }, [speech]);

  useEffect(() => {
    onSnapshot?.({ phase, account: data.account, entitlements: data.entitlements, capabilities });
  }, [phase, data.account, data.entitlements, capabilities, onSnapshot]);

  /* ---------------- session ---------------- */

  /** Ends the current session in the shell: new epoch, every account cache cleared, sign-in shown. */
  const signedOut = useCallback((message: string | null) => {
    if (!mounted.current) return;
    expireVoiceScope('account_changed');
    epochRef.current += 1;
    latest.current = EMPTY;
    setData(EMPTY);
    transitionRoutes([{ name: 'home' }]);
    setNotice(message);
    setPhase('signed-out');
  }, [transitionRoutes, expireVoiceScope]);

  useEffect(() => {
    const subscription = resources.api.subscribeAuthChanges(source => {
      if (!mounted.current || currentResources.current !== resources || !latest.current.account ||
        accountAuth.current?.resources !== resources || accountAuth.current.guard.isCurrent()) return;
      const security = securityAdmission.current;
      if (security && source === security.credentials.replacementGuard && security.isCurrentSession()) return;
      const transition = authTransition.current;
      // Our revocation intent must retain its uncertain-result retry; only its initial synchronous notification is exempt.
      if (transition?.starting) return;
      signedOut(COPY.signedOut);
      if (transition) transition.invalidated = { epoch: epochRef.current, auth: resources.api.captureAuthContext() };
    });
    return () => subscription.remove();
  }, [resources, signedOut]);

  const runAuthTransition = useCallback(async (transition: AuthTransition, work: () => Promise<SaveResult<null>>) => {
    authTransition.current = transition;
    transition.starting = true;
    transition.completed = false;
    transition.invalidated = null;
    try {
      const pending = work();
      transition.starting = false;
      const result = await pending;
      transition.completed = result.status === 'saved';
      return result;
    } finally {
      transition.starting = false;
      if (authTransition.current === transition) authTransition.current = null;
    }
  }, []);
  // A confirmed revocation may finish after its own notification cleared the shell, but never after a later auth intent.
  const authTransitionCurrent = useCallback((who: Actor, transition: AuthTransition) => isCurrent(who) ||
    (mounted.current && currentResources.current === resources && transition.completed && transition.invalidated !== null &&
      epochRef.current === transition.invalidated.epoch && transition.invalidated.auth.isCurrent()), [isCurrent, resources]);

  useEffect(() => {
    if (phase !== 'ready' || !voiceScope || !accountSession) return;
    const originalEpoch = epochRef.current, originalAuth = accountSession.commandSession.originalAuth;
    const originalResources = resources;
    let observation: ReturnType<typeof resources.api.observeSessionLifetime> | undefined;
    const current = () => mounted.current && currentResources.current === originalResources && epochRef.current === originalEpoch &&
      originalAuth.isCurrent() && accountSession.isCurrentSession() && heldVoiceScope.current === voiceScope;
    const observe = () => {
      if (!current() || observation) return;
      observation = resources.api.observeSessionLifetime(() => { if (current()) signedOut(COPY.signedOut); });
    };
    if (AppState.currentState !== 'background' && AppState.currentState !== 'inactive') observe();
    const app = AppState.addEventListener('change', state => {
      if (state === 'active') observe();
      else { observation?.remove(); observation = undefined; }
    });
    return () => { app.remove(); observation?.remove(); };
  }, [phase, resources, voiceScope, accountSession, signedOut]);

  const [lifecycleBinding, setLifecycleBinding] = useState<{ key: string; host: LifecycleHostSession } | null>(null);
  useEffect(() => {
    if (!props.lifecycleSession || !voiceScope) { setLifecycleBinding(null); return; }
    const { accountId, accountEpoch, authSessionId } = voiceScope.account;
    const host = props.lifecycleSession({ accountId, sessionKey: authSessionId, voiceScope,
      isCurrent: voiceScope.isCurrent,
      claimAccessDisabled() {
        if (!voiceScope.isCurrent() || epochRef.current !== accountEpoch || latest.current.account?.accountId !== accountId) throw sessionChanged();
        signedOut(null);
        const cleanupEpoch = epochRef.current;
        return { isCurrent: () => mounted.current && epochRef.current === cleanupEpoch && latest.current.account === null,
          disposeSpeech: () => speech.dispose() };
      },
    });
    setLifecycleBinding({ key: authSessionId, host });
    return () => host.dispose();
  }, [props.lifecycleSession, voiceScope, speech, signedOut]);

  /** A 401 or a settled result for `who`: acts only while that session is still the current one. */
  const unauthenticatedFor = useCallback((who: Actor) => { if (isCurrent(who)) signedOut(COPY.signedOut); }, [isCurrent, signedOut]);

  /**
   * Applies a write result for `who`, then returns it. Obsolete results are reported as session_changed and never
   * committed. An unknown result's retry re-checks the session first, so it can never run under a later token,
   * and its eventual result is committed through the same path (including revokeAllSessions → sign-in).
   */
  const settle = useCallback(function settleResult<T>(who: Actor, result: SaveResult<T>,
    commit: (result: SaveResult<T>) => void, current: () => boolean = () => isCurrent(who)): SaveResult<T> {
    if (!current()) return { status: 'failed', error: sessionChanged(
      result.status === 'saved' || result.status === 'unknown' || (result.status === 'failed' &&
        (result.error.effectUnknown || result.error.originalEffectUnknown))) };
    if (result.status === 'failed' && result.error.status === 401) { signedOut(COPY.signedOut); return result; }
    commit(result);
    if (result.status !== 'unknown') return result;
    const retry = result.retry;
    return {
      status: 'unknown',
      retry: async () => {
        if (!current()) return { status: 'failed', error: sessionChanged(true) };
        return settleResult(who, await retry(), commit, current);
      },
    };
  }, [isCurrent, signedOut]);

  const loadCapabilities = useCallback(async () => {
    const who = actor();
    try {
      const next = await resources.capabilities();
      if (isCurrent(who)) setCapabilities(next);
    } catch { if (isCurrent(who)) setCapabilities(null); }
  }, [resources, actor, isCurrent]);

  const loadPlans = useCallback(async (who: Actor) => {
    if (!isCurrent(who) || !who.accountId) return;
    const auth = resources.api.captureAuthContext();
    const current = () => currentResources.current === resources && auth.isCurrent() && isCurrent(who) && latest.current.account?.accountId === who.accountId;
    const scoped = resources.boundTo(current);
    try {
      if (!current()) return;
      const training = await scoped.sourceTraining();
      if (!current()) return;
      const plans = await training.plans();
      if (!current()) return;
      const exercises = await scoped.exercises();
      if (!current()) return;
      commitFor(who, (d) => current() ? { ...d, plans: sortPlans(plans.items), exercises: exercises.items, plansError: null } : d);
    } catch (error) {
      if (!current()) return;
      if (error instanceof ApiError && error.status === 401) { signedOut(COPY.signedOut); return; }
      commitFor(who, (d) => current() ? { ...d, plansError: errorCopy(error) } : d);
    }
  }, [resources, commitFor, isCurrent, signedOut]);

  /** Starts a new session epoch: anything still in flight from before belongs to an earlier session. */
  const loadAccount = useCallback(async () => {
    if (!mounted.current) return;
    expireVoiceScope('account_changed');
    epochRef.current += 1;
    const epoch = epochRef.current;
    latest.current = EMPTY;
    setData(EMPTY);
    transitionRoutes([{ name: 'home' }]);
    setPhase('loading'); setFatal(null);
    const auth = resources.api.captureAuthContext();
    try {
      const [account, entitlements] = await Promise.all([resources.account(), resources.entitlements()]);
      if (!auth.isCurrent() || !isCurrent({ epoch, accountId: account.accountId })) return;
      const settings = await resources.settings().catch(() => null);
      const who: Actor = { epoch, accountId: account.accountId };
      if (!auth.isCurrent() || !isCurrent(who)) return;
      if (entitlements.accountId !== account.accountId || (settings && settings.accountId !== account.accountId)) {
        setFatal(COPY.network);
        setPhase('error');
        return;
      }
      accountAuth.current = { resources, guard: auth };
      setData({ ...EMPTY, account, entitlements, settings });
      latest.current = { ...EMPTY, account, entitlements, settings };
      setNotice(null);
      // Existing accounts with completed onboarding go straight home; no onboarding or purchase step repeats.
      setPhase(account.onboarding.status === 'completed' ? 'ready' : 'onboarding');
      void loadPlans(who);
    } catch (error) {
      if (!isCurrent({ epoch, accountId: null })) return;
      if (error instanceof ApiError && error.status === 401) { signedOut(COPY.signedOut); return; }
      if (!auth.isCurrent()) return;
      setFatal(errorCopy(error));
      setPhase('error');
    }
  }, [resources, loadPlans, isCurrent, signedOut, transitionRoutes, expireVoiceScope]);

  const restore = useCallback(async () => {
    if (!mounted.current) return;
    expireVoiceScope('account_changed');
    epochRef.current += 1;
    const who: Actor = { epoch: epochRef.current, accountId: null };
    setPhase('restoring'); setFatal(null);
    void loadCapabilities();
    try {
      const restored = await resources.api.restore();
      if (!isCurrent(who)) return;
      if (restored) await loadAccount();
      else signedOut(null);
    } catch (error) {
      if (!isCurrent(who)) return;
      setFatal(errorCopy(error));
      setPhase('error');
    }
  }, [resources, loadAccount, loadCapabilities, isCurrent, signedOut, expireVoiceScope]);

  useEffect(() => { void restore(); }, [restore]);

  const reload = useCallback(async () => {
    const who = actor();
    if (!who.accountId || !accountSession?.isCurrentSession()) return;
    const scoped = accountSession.resources;
    try {
      const [account, entitlements] = await Promise.all([scoped.account(), scoped.entitlements()]);
      if (!accountSession.isCurrentSession()) return;
      const settings = await scoped.settings().catch(() => null);
      if (!accountSession.isCurrentSession() || account.accountId !== who.accountId || entitlements.accountId !== who.accountId) return;
      commitFor(who, (d) => ({
        ...d, account, entitlements, settings: settings && settings.accountId === who.accountId ? settings : d.settings,
      }));
      await loadPlans(who);
    } catch (error) {
      if (!accountSession.isCurrentSession()) return;
      if (error instanceof ApiError && error.status === 401) unauthenticatedFor(who);
    }
  }, [accountSession, actor, commitFor, loadPlans, unauthenticatedFor]);

  /* ---------------- account writes (revision-guarded) ---------------- */

  const savePreferences = useCallback(async (changes: Partial<Omit<Preferences, 'revision'>>): Promise<SaveResult<Preferences>> => {
    const who = actor();
    if (!accountSession?.isCurrentSession()) return { status: 'failed', error: sessionChanged() };
    const current = latest.current.account?.preferences;
    if (!current || !who.accountId) return { status: 'failed', error: new ApiError(401, 'unauthenticated', COPY.signedOut) };
    const result = await guardedSave(() => {
      if (!accountSession.isCurrentSession()) return Promise.reject(sessionChanged());
      return accountSession.resources.preferences(current, changes);
    }, async () => {
      if (!accountSession.isCurrentSession()) throw sessionChanged();
      return (await accountSession.resources.account()).preferences;
    });
    return settle(who, result, (r) => {
      if (r.status === 'saved') commitFor(who, (d) => ({ ...d, account: d.account && { ...d.account, preferences: r.value } }));
      if (r.status === 'stale') commitFor(who, (d) => ({ ...d, account: d.account && { ...d.account, preferences: r.latest } }));
    }, accountSession.isCurrentSession);
  }, [accountSession, actor, settle, commitFor]);

  const saveProfile = useCallback(async (changes: Partial<Omit<Profile, 'revision'>>): Promise<SaveResult<Profile>> => {
    const who = actor();
    if (!accountSession?.isCurrentSession()) return { status: 'failed', error: sessionChanged() };
    const current = latest.current.account?.profile;
    if (!current || !who.accountId) return { status: 'failed', error: new ApiError(401, 'unauthenticated', COPY.signedOut) };
    const result = await guardedSave(() => {
      if (!accountSession.isCurrentSession()) return Promise.reject(sessionChanged());
      return accountSession.resources.profile(current, changes);
    }, async () => {
      if (!accountSession.isCurrentSession()) throw sessionChanged();
      return (await accountSession.resources.account()).profile;
    });
    return settle(who, result, (r) => {
      if (r.status === 'saved') commitFor(who, (d) => ({ ...d, account: d.account && { ...d.account, profile: r.value } }));
      if (r.status === 'stale') commitFor(who, (d) => ({ ...d, account: d.account && { ...d.account, profile: r.latest } }));
    }, accountSession.isCurrentSession);
  }, [accountSession, actor, settle, commitFor]);

  /** The transport keeps the Keychain session when revocation is uncertain; only a confirmed sign-out clears state. */
  const signOut = useCallback(async (): Promise<SaveResult<null>> => {
    const who = actor();
    const originalVoiceScope = heldVoiceScope.current;
    const transition: AuthTransition = { starting: false, completed: false, invalidated: null };
    const attempt = async (): Promise<SaveResult<null>> => {
      if (!isCurrent(who)) return { status: 'failed', error: sessionChanged() };
      notifyVoiceExit(originalVoiceScope, 'logout');
      if (!isCurrent(who)) return { status: 'failed', error: sessionChanged() };
      return runAuthTransition(transition, async () => {
        try {
          await resources.api.signOut();
          return { status: 'saved', value: null };
        } catch (error) {
          const apiError = asApiError(error);
          // 401: the server no longer recognizes this session and the transport has cleared it.
          if (apiError.status === 401) return { status: 'saved', value: null };
          if (apiError.effectUnknown || apiError.status === 0 || apiError.status >= 500) return { status: 'unknown', retry: attempt };
          return { status: 'failed', error: apiError };
        }
      });
    };
    return settle(who, await attempt(), (r) => { if (r.status === 'saved') signedOut(null); },
      () => authTransitionCurrent(who, transition));
  }, [resources, actor, settle, signedOut, isCurrent, notifyVoiceExit, runAuthTransition, authTransitionCurrent]);

  const sessionAction = useMemo(() => {
    const handler = props.onSessionAction;
    if (!handler) return undefined;
    return async (action: SessionAction): Promise<SaveResult<null>> => {
      const who = actor();
      const originalVoiceScope = heldVoiceScope.current;
      const transition: AuthTransition = { starting: false, completed: false, invalidated: null };
      const attempt = async (work: () => Promise<SaveResult<null>>): Promise<SaveResult<null>> => {
        if (!isCurrent(who)) return { status: 'failed', error: sessionChanged() };
        if (action === 'revokeAllSessions') notifyVoiceExit(originalVoiceScope, 'logout');
        if (!isCurrent(who)) return { status: 'failed', error: sessionChanged() };
        const result = await (action === 'revokeAllSessions' ? runAuthTransition(transition, work) : work());
        return result.status === 'unknown' ? { status: 'unknown', retry: () => attempt(result.retry) } : result;
      };
      return settle(who, await attempt(() => handler(action)), (r) => {
        if (r.status === 'saved' && action === 'revokeAllSessions') signedOut(null);
      }, () => authTransitionCurrent(who, transition));
    };
  }, [props.onSessionAction, actor, settle, signedOut, isCurrent, notifyVoiceExit, runAuthTransition, authTransitionCurrent]);

  /* ---------------- render by phase ---------------- */

  if (phase === 'restoring' || phase === 'loading') {
    return <Screen testID="screen-loading"><Section><Spinner /></Section></Screen>;
  }
  if (phase === 'error') {
    return (
      <Screen testID="screen-error" nav={<Nav leading={<Wordmark />} />}>
        <Section><Notice kind="error" text={fatal ?? COPY.network} announce action={{ label: 'Try again', onPress: () => void restore() }} /></Section>
      </Screen>
    );
  }
  if (phase === 'signed-out' || !data.account || !accountSession) {
    const who = actor();
    return <AuthFlow resources={resources} capabilities={capabilities} identity={props.identity} notice={notice}
      onAuthenticated={bind(who, () => void loadAccount())} onRetryCapabilities={() => void loadCapabilities()} />;
  }

  const account = data.account;
  const who: Actor = { epoch: epochRef.current, accountId: account.accountId };
  const currentView = accountSession.isCurrentSession;
  const scopedResources = accountSession.resources;
  const scopedReload = async () => { if (currentView()) await reload(); };
  const scopedSavePreferences: SettingsSlotContext['savePreferences'] = (changes) =>
    currentView() ? savePreferences(changes) : Promise.resolve({ status: 'failed', error: sessionChanged() });
  const scopedSaveProfile: SettingsSlotContext['saveProfile'] = (changes) =>
    currentView() ? saveProfile(changes) : Promise.resolve({ status: 'failed', error: sessionChanged() });
  const scopedSignOut: SettingsSlotContext['signOut'] = () =>
    currentView() ? signOut() : Promise.resolve({ status: 'failed', error: sessionChanged() });
  const scopedSessionAction: SettingsSlotContext['sessionAction'] = sessionAction
    ? (action) => currentView() ? sessionAction(action) : Promise.resolve({ status: 'failed', error: sessionChanged() })
    : undefined;
  const unauthenticated = () => { if (currentView()) unauthenticatedFor(who); };
  /** Late child results for another account (or an earlier session) are dropped. */
  const commitAccount = (next: Account) => { if (currentView() && next.accountId === who.accountId) commitFor(who, (d) => ({ ...d, account: next })); };

  if (phase === 'onboarding') {
    return (
      <OnboardingFlow resources={scopedResources} account={account} speech={speech} firstPlan={props.firstPlan}
        firstPlanCommand={props.firstPlan ? undefined : scopedResources.createFirstPlan} isCurrentSession={currentView}
        notifications={props.notifications} onOpenSystemSettings={props.onOpenSystemSettings}
        onAccount={commitAccount} onUnauthenticated={unauthenticated}
        onDone={() => { if (currentView()) { setPhase('ready'); transitionRoutes([{ name: 'home' }], currentView); void reload(); } }} />
    );
  }

  // Read the retained command synchronously: an old Home or Back closure cannot dismiss an unresolved save.
  const contextNavigationBlocked = () => {
    const retained = contextConfirmation.current;
    if (retained?.session !== accountSession) return false;
    const state = retained.confirmation.snapshot();
    return state.status === 'pending' || state.effect === 'pending' || state.effect === 'unknown';
  };
  const push = (route: Route) => {
    if (!currentView() || contextNavigationBlocked()) return;
    transitionRoutes([...activeRoutes.current, route], () => currentView() && !contextNavigationBlocked());
  };
  const pop = () => {
    if (!currentView() || contextNavigationBlocked() || activeRoutes.current.length <= 1) return;
    transitionRoutes(activeRoutes.current.slice(0, -1), () => currentView() && !contextNavigationBlocked());
  };
  const originalOpenEdit = props.openEdit, editGeneration = editPort.current.generation;
  const editCurrent = () => currentView() && currentResources.current === resources &&
    editPort.current.callback === originalOpenEdit && editPort.current.generation === editGeneration;
  const openEdit: SettingsSlotContext['openEdit'] = originalOpenEdit ? target => {
    if (editCurrent() && !contextNavigationBlocked()) originalOpenEdit(target);
  } : undefined;
  const openContextConfirmation = props.renderContextConfirmation && typeof scopedResources.account === 'function' &&
    typeof scopedResources.createFirstPlan === 'function' ? () => {
      if (!currentView() || contextNavigationBlocked()) return;
      const retained = contextConfirmation.current, state = retained?.confirmation.snapshot();
      // A new edit port may serve a fresh review, but never replace issued-command custody.
      const replaceEditPort = retained?.editGeneration !== editGeneration &&
        state?.status !== 'pending' && state?.effect === 'none';
      if (retained?.session !== accountSession || replaceEditPort) {
        contextConfirmation.current?.confirmation.dispose();
        contextConfirmation.current = { session: accountSession, editGeneration, confirmation: createContextConfirmation({
          resources: scopedResources,
          scope: { accountId: account.accountId, sessionGeneration: accountSession.sessionGeneration,
            originalAuth: accountSession.commandSession.originalAuth,
            isCurrentSession: binding => binding.resources === scopedResources && binding.accountId === account.accountId &&
              binding.sessionGeneration === accountSession.sessionGeneration && currentView() },
          newIdempotencyKey: commandKey,
          ...(originalOpenEdit ? { openEdit: target => {
            if (!editCurrent()) throw new Error('context-edit-port-unavailable');
            originalOpenEdit(target);
          } } : {}),
        }) };
      }
      // The mounted consumer owns its initial capture promise and the actual issued review; entry performs no read.
      if (activeRoutes.current[activeRoutes.current.length - 1].name !== 'context-confirmation') push({ name: 'context-confirmation' });
    } : undefined;
  const route = routes[routes.length - 1];
  // Legacy screens receive a narrowed view; the single cache retains every decoded source plan unchanged.
  const availablePlans = data.plans.filter(plan => !plan.archived);
  const legacyPlans = availablePlans.filter(isLegacyPlan);
  const activePlan = legacyPlans[0] ?? null; // DGR-006: most recently updated non-archived legacy plan
  const openLegacyPlan = (planId: string) => {
    if (!currentView()) return;
    const plan = latest.current.plans.find(item => item.id === planId);
    if (plan && !plan.archived && isLegacyPlan(plan)) push({ name: 'plan-edit', planId });
  };

  const sessionKey = accountSession.sessionGeneration;
  const featureCtx: FeatureSlotContext = {
    commandOwner: commandOwner ?? undefined,
    account, appMode, resources: scopedResources, close: pop,
    sessionGeneration: sessionKey, voiceScope: voiceScope ?? undefined, isCurrentSession: currentView,
  };
  const renderSourcePlanDetail = props.renderSourcePlanDetail;
  const homeCtx: HomeSlotContext = {
    account, appMode, resources: scopedResources, plans: legacyPlans, activePlan, exercises: data.exercises, entitlements: data.entitlements,
    sessionGeneration: sessionKey, isCurrentSession: currentView,
    storedPlans: data.plans, renderSourceTraining: props.renderSourceTraining, registerSourceTraining,
    // DGR-001 (v2 superseded): the Today avatar and the former Account entry open Settings directly.
    openAccount: () => push({ name: 'settings' }),
    openPlans: () => push({ name: 'plans', back: 'Today' }),
    openPlan: openLegacyPlan,
    savedFirstPlanDestination: saved => createSavedFirstPlanDestination({ saved, resources: scopedResources,
      scope: { accountId: account.accountId, sessionGeneration: sessionKey, originalAuth: accountSession.commandSession.originalAuth,
        isCurrentSession: binding => binding.resources === scopedResources && binding.accountId === account.accountId &&
          binding.sessionGeneration === sessionKey && currentView() },
      adoptAndOpen(plan) {
        if (!currentView() || contextNavigationBlocked()) return false;
        const adopt = (d: Data): Data => ({ ...d, plans: sortPlans([plan, ...d.plans.filter(item => item.id !== plan.id)]), plansError: null });
        latest.current = adopt(latest.current);
        commitFor(who, d => currentView() ? adopt(d) : d);
        // Carry the verified plan on this route so React scheduling cannot expose create mode before the cache commit.
        push({ name: 'plan-edit', planId: plan.id, verifiedPlan: plan });
        return currentView();
      },
      ...(renderSourcePlanDetail ? { adoptSourceAndOpen: (plan: SourcePlan) => {
        const render = renderSourcePlanDetail;
        if (sourceRenderer.current !== render || sourcePresentation.current.generation !== presentationGeneration ||
          !currentView() || contextNavigationBlocked()) return false;
        const originalCurrent = () => sourceRenderer.current === render &&
          sourcePresentation.current.generation === presentationGeneration && currentView();
        const owner = sourceTrainingOwner.current;
        const canSelect = () => originalCurrent() && !contextNavigationBlocked() &&
          owner !== null && sourceTrainingOwner.current === owner && owner.session === accountSession &&
          owner.presentationGeneration === presentationGeneration;
        let handedOff = false;
        const context: SourcePlanDetailSlotContext = Object.freeze({
          account, appMode, resources: scopedResources, sessionGeneration: sessionKey, plan,
          isCurrentSession: originalCurrent,
          ...(props.renderSourceTraining && props.renderHome && canSelect() ? { start() {
            if (handedOff || !canSelect() || !owner || !owner.selectPlan(plan) || !canSelect()) return false;
            handedOff = true;
            transitionRoutes([{ name: 'home' }], () => originalCurrent() && !contextNavigationBlocked());
            return originalCurrent();
          } } : {}),
          close() { if (originalCurrent()) pop(); },
        });
        const adopt = (d: Data): Data => ({ ...d, plans: sortPlans([plan, ...d.plans.filter(item => item.id !== plan.id)]), plansError: null });
        latest.current = adopt(latest.current);
        commitFor(who, d => originalCurrent() ? adopt(d) : d);
        // Carry the verified frozen snapshot before React commits the same plan to the full cache.
        push({ name: 'source-plan-detail', context, render });
        return originalCurrent();
      } } : {}),
    }),
    ...(openContextConfirmation ? { openContextConfirmation } : {}),
    openCues: (exerciseId, back) => push({ name: 'cues', exerciseId, back }),
    openSettings: () => push({ name: 'settings' }),
    ...(props.renderBody ? { openBody: () => push({ name: 'body' }) } : {}),
    ...(props.renderCommunity ? { openCommunity: () => push({ name: 'community' }) } : {}),
    ...(props.renderActivity ? { openActivity: () => push({ name: 'activity' }) } : {}),
    reload: scopedReload,
  };
  const openSystemSettings = props.onOpenSystemSettings;
  const settingsCtx: SettingsSlotContext = {
    lifecycle: lifecycleBinding?.key === sessionKey ? lifecycleBinding.host : undefined,
    account, appMode, resources: scopedResources, settings: data.settings, capabilities, entitlements: data.entitlements,
    savePreferences: scopedSavePreferences, saveProfile: scopedSaveProfile, signOut: scopedSignOut,
    ...(scopedSessionAction ? { sessionAction: scopedSessionAction } : {}),
    openAccess: () => push({ name: 'access' }),
    openPlans: () => push({ name: 'plans', back: 'Settings' }),
    openAccount: () => push({ name: 'account' }),
    ...(openEdit ? { openEdit } : {}),
    close: pop,
    reload: scopedReload,
    openCuesIndex: () => push({ name: 'cues-index', back: 'Settings' }),
    ...(openSystemSettings ? { openSystemSettings: () => { if (currentView()) openSystemSettings(); } } : {}),
    ...(props.renderBody ? { openBody: () => push({ name: 'body' }) } : {}),
    ...(props.renderCommunity ? { openCommunitySettings: () => push({ name: 'community' }) } : {}),
    ...(props.renderFeatureRequests ? { openFeatureRequests: () => push({ name: 'feature-requests' }) } : {}),
  };

  const rendererGenerations = accountRenderers.current.generations;
  const openAccountFeature = (name: 'membership' | 'health', render: FormAccountAppProps['renderMembership']) => {
    if (!render || !currentView() || contextNavigationBlocked() || accountRenderers.current[name] !== render ||
      accountRenderers.current.generations[name] !== rendererGenerations[name]) return;
    let live = true;
    let destination: Extract<Route, { name: 'membership' | 'health' }>;
    const current = () => {
      if (!currentView() || accountRenderers.current[name] !== render || accountRenderers.current.generations[name] !== rendererGenerations[name] ||
        activeRoutes.current[activeRoutes.current.length - 1] !== destination) live = false;
      return live;
    };
    const context = Object.freeze({ ...featureCtx, resources: resources.boundTo(current), isCurrentSession: current,
      close() { if (current()) { live = false; pop(); } } });
    destination = { name, context, render };
    push(destination);
  };
  if (props.renderMembership) settingsCtx.openMembership = () => openAccountFeature('membership', props.renderMembership);
  if (props.renderHealth) settingsCtx.openHealth = () => openAccountFeature('health', props.renderHealth);
  const securityRenderer = props.renderAccountSecurity;
  if (securityRenderer) settingsCtx.openAccountSecurity = () => {
    if (!currentView() || contextNavigationBlocked() || accountRenderers.current.security !== securityRenderer ||
      accountRenderers.current.generations.security !== rendererGenerations.security || securityAdmission.current) return;
    let destination: Extract<Route, { name: 'account-security' }>;
    const physicalCurrent = (): boolean => mounted.current && currentResources.current === resources && epochRef.current === who.epoch &&
      latest.current.account?.accountId === who.accountId && accountRenderers.current.security === securityRenderer &&
      accountRenderers.current.generations.security === rendererGenerations.security && securityAdmission.current === admission &&
      activeRoutes.current[activeRoutes.current.length - 1] === destination;
    const admission: ReturnType<typeof captureAccountSecuritySession> = captureAccountSecuritySession(resources, {
      accountId: account.accountId, sessionGeneration: sessionKey, isOwnerCurrent: physicalCurrent,
      onForeignAuth() { if (mounted.current && currentResources.current === resources && epochRef.current === who.epoch) signedOut(COPY.signedOut); },
    }, accountSession.commandSession.originalAuth);
    securityAdmission.current = admission;
    const current = admission.isCurrentSession;
    let handedOff = false;
    const returnToSettings = async () => {
      if (handedOff || !current()) return;
      const acquired = await admission.reacquire();
      if (handedOff || !acquired || !acquired.isCurrent() || !physicalCurrent()) return;
      handedOff = true;
      expireVoiceScope('account_changed');
      admission.dispose(); securityAdmission.current = null;
      epochRef.current += 1;
      const epoch = epochRef.current;
      accountAuth.current = { resources, guard: acquired.auth };
      latest.current = { ...EMPTY, account: acquired.account, entitlements: acquired.entitlements, settings: acquired.settings };
      setData(latest.current); transitionRoutes([{ name: 'home' }, { name: 'settings' }]); setPhase('ready');
      void loadPlans({ epoch, accountId: account.accountId });
    };
    const guardedNavigation = (action: () => void) => () => {
      if (!current() || !currentView()) return;
      action();
    };
    const context: AccountSecuritySlotContext = Object.freeze({ ...settingsCtx,
      credentials: admission.credentials, sessionGeneration: sessionKey, isCurrentSession: current,
      savePreferences: (changes: Parameters<SettingsSlotContext['savePreferences']>[0]) => current() ? scopedSavePreferences(changes)
        : Promise.resolve({ status: 'failed' as const, error: sessionChanged() }),
      saveProfile: (changes: Parameters<SettingsSlotContext['saveProfile']>[0]) => current() ? scopedSaveProfile(changes)
        : Promise.resolve({ status: 'failed' as const, error: sessionChanged() }),
      signOut: () => current() ? scopedSignOut() : Promise.resolve({ status: 'failed' as const, error: sessionChanged() }),
      ...(scopedSessionAction ? { sessionAction: (action: SessionAction) => current() ? scopedSessionAction(action)
        : Promise.resolve({ status: 'failed' as const, error: sessionChanged() }) } : {}),
      openAccess: guardedNavigation(settingsCtx.openAccess), openPlans: guardedNavigation(settingsCtx.openPlans),
      openAccount: guardedNavigation(settingsCtx.openAccount),
      ...(settingsCtx.openCuesIndex ? { openCuesIndex: guardedNavigation(settingsCtx.openCuesIndex) } : {}),
      ...(settingsCtx.openSystemSettings ? { openSystemSettings: () => { if (current() && currentView()) settingsCtx.openSystemSettings?.(); } } : {}),
      ...(settingsCtx.openBody ? { openBody: guardedNavigation(settingsCtx.openBody) } : {}),
      ...(settingsCtx.openCommunitySettings ? { openCommunitySettings: guardedNavigation(settingsCtx.openCommunitySettings) } : {}),
      ...(settingsCtx.openFeatureRequests ? { openFeatureRequests: guardedNavigation(settingsCtx.openFeatureRequests) } : {}),
      ...(settingsCtx.openMembership ? { openMembership: guardedNavigation(settingsCtx.openMembership) } : {}),
      ...(settingsCtx.openHealth ? { openHealth: guardedNavigation(settingsCtx.openHealth) } : {}),
      openAccountSecurity: undefined,
      close() { void returnToSettings(); }, reload: returnToSettings,
      onSignedOut() { if (current()) signedOut(COPY.signedOut); },
    });
    destination = { name: 'account-security', admission, context, render: securityRenderer };
    push(destination);
  };

  // The home slot stays mounted under pushed screens so a workout's queued or unresolved commands survive navigation.
  // Its key is the session, so a new sign-in (even of the same account) starts with empty account-scoped state.
  const home = props.renderHome ? props.renderHome(homeCtx) : <TodayEntry ctx={homeCtx} />;

  let screen: ReactNode = null;
  switch (route.name) {
    case 'account-security':
      screen = props.renderAccountSecurity === route.render && route.admission.isCurrentSession()
        ? route.render(route.context) : null;
      break;
    case 'membership':
    case 'health':
      screen = accountRenderers.current[route.name] === route.render && route.context.isCurrentSession()
        ? route.render(route.context) : null;
      break;
    case 'account':
      screen = (
        <AccountScreen account={account} settings={data.settings} capabilities={capabilities} entitlements={data.entitlements}
          planCount={availablePlans.length} hasBodySeam={!!props.renderBody} onBack={pop}
          onRow={(row: AccountRowId) => push(row === 'plans' ? { name: 'plans', back: 'Account' }
            : row === 'cues' ? { name: 'cues-index', back: 'Account' } : row === 'access' ? { name: 'access' }
              : row === 'settings' ? { name: 'settings' } : { name: 'body' })}
          savePreferences={scopedSavePreferences} saveProfile={scopedSaveProfile} signOut={scopedSignOut} />
      );
      break;
    case 'plans':
      screen = (
        <PlansScreen plans={legacyPlans} activePlanId={activePlan?.id ?? null} backLabel={route.back} onBack={pop}
          onOpen={openLegacyPlan} onCreate={() => push({ name: 'plan-edit', planId: null })}
          error={data.plansError} onRetry={() => { if (currentView()) void loadPlans(who); }} />
      );
      break;
    case 'plan-edit': {
      const cached = data.plans.find(p => p.id === route.planId);
      if (cached && (cached.archived || !isLegacyPlan(cached))) break;
      const selected = route.verifiedPlan ?? cached;
      if (route.planId !== null && (!selected || selected.archived || !isLegacyPlan(selected))) break;
      const editable = selected && isLegacyPlan(selected) ? selected : null;
      screen = (
        <PlanEditScreen key={route.planId ?? 'new'} resources={scopedResources} plan={editable}
          exercises={data.exercises} appMode={appMode} loadUnit={account.preferences.loadUnit}
          defaultMinutes={account.preferences.sessionMinutes} onBack={pop} onUnauthenticated={unauthenticated}
          onSaved={bind(who, (plan: Plan) => {
            if (!currentView()) return;
            let decoded: StoredPlan;
            try { decoded = decodePlan(plan); } catch { return; }
            if (!isLegacyPlan(decoded) || decoded.archived || (route.planId !== null && decoded.id !== route.planId)) return;
            const existing = latest.current.plans.find(item => item.id === decoded.id);
            if (existing && !isLegacyPlan(existing)) return;
            commitFor(who, (d) => currentView()
              ? { ...d, plans: sortPlans([decoded, ...d.plans.filter(p => p.id !== decoded.id)]) } : d);
            pop();
          })} />
      );
      break;
    }
    case 'source-plan-detail':
      screen = currentView() && route.context.isCurrentSession() && props.renderSourcePlanDetail === route.render
        ? route.render(route.context) : null;
      break;
    case 'cues-index':
      screen = <CuesIndex plans={legacyPlans} exercises={data.exercises} backLabel={route.back} onBack={pop}
        onOpen={(exerciseId) => push({ name: 'cues', exerciseId, back: 'Cues' })} />;
      break;
    case 'cues':
      screen = (
        <CuesScreen key={route.exerciseId} resources={scopedResources} exerciseId={route.exerciseId} backLabel={route.back} appMode={appMode}
          exerciseName={data.exercises.find((e) => e.id === route.exerciseId)?.name ?? 'Movement'} onBack={pop} onUnauthenticated={unauthenticated} />
      );
      break;
    case 'access':
      screen = (
        <AccessScreen resources={scopedResources} entitlements={data.entitlements} onBack={pop} onUnauthenticated={unauthenticated}
          onMemberships={props.onMemberships ? () => { if (currentView()) props.onMemberships?.(); } : undefined}
          onChanged={(entitlements) => { if (currentView() && entitlements.accountId === who.accountId) commitFor(who, (d) => ({ ...d, entitlements })); }} />
      );
      break;
    case 'settings':
      screen = <View key={`settings:${sessionKey}`} style={s.fill}>{props.renderSettings(settingsCtx)}</View>;
      break;
    case 'context-confirmation': {
      const retained = contextConfirmation.current;
      screen = currentView() && retained?.session === accountSession && props.renderContextConfirmation
        ? props.renderContextConfirmation(Object.freeze({
          sessionGeneration: sessionKey, isCurrentSession: currentView, confirmation: retained.confirmation,
          savedFirstPlanDestination: homeCtx.savedFirstPlanDestination,
          close() {
            if (!currentView() || contextNavigationBlocked()) return;
            retained.confirmation.cancel();
            pop();
          },
        })) : null;
      break;
    }
    case 'body':
      screen = props.renderBody ? props.renderBody(featureCtx) : null;
      break;
    case 'community':
      screen = props.renderCommunity ? props.renderCommunity(featureCtx) : null;
      break;
    case 'activity':
      screen = props.renderActivity ? props.renderActivity(featureCtx) : null;
      break;
    case 'feature-requests':
      screen = props.renderFeatureRequests ? props.renderFeatureRequests(featureCtx) : null;
      break;
    default:
      screen = null;
  }
  const covered = screen !== null;
  return (
    <View style={s.fill}>
      <View key={`home:${sessionKey}`} style={[s.fill, covered && s.hidden]}
        accessibilityElementsHidden={covered} importantForAccessibility={covered ? 'no-hide-descendants' : 'auto'}>
        {home}
      </View>
      {covered ? <View key={`feature:${sessionKey}:${route.name}`} style={s.layer}>{screen}</View> : null}
    </View>
  );
}

function isLegacyPlan(plan: StoredPlan): plan is Plan {
  return !('schema' in plan);
}

function sortPlans(plans: StoredPlan[]): StoredPlan[] {
  return [...plans].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/* ---------------- fallback home: today.account-entry without a workout start (training leaf owns it) ---------------- */

function TodayEntry({ ctx }: { ctx: HomeSlotContext }) {
  const { account, activePlan } = ctx;
  const name = account.profile.name;
  const today = new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  const sets = activePlan?.items.reduce((n, i) => n + i.setTarget, 0) ?? 0;
  return (
    <Screen testID="screen-today" nav={(
      <Nav leading={<Wordmark />} trailing={(
        <View style={s.navTrail}>
          <Txt role="meta" tone="secondary">{today}</Txt>
          <Pressable testID="a-account-entry" accessibilityRole="button" accessibilityLabel={`Settings, ${name}`} onPress={ctx.openSettings} style={s.avatar}>
            <Txt role="bodyStrong">{(name.trim()[0] ?? '·').toUpperCase()}</Txt>
          </Pressable>
        </View>
      )} />
    )}>
      <Gutter>
        <Title display text={`Hello, ${name}.`} testID="a-today-title" />
        <Subtitle text="Let’s make room to move." />
      </Gutter>
      <Gutter style={s.gap32}><Art /></Gutter>
      <Gutter style={s.gap32}>
        {activePlan ? (
          <View style={s.session}>
            <Txt role="sectionTitle">{activePlan.name}</Txt>
            <MetaLine items={[`${activePlan.minutes} minutes`, movementWord(activePlan.items.length), setWord(sets)]} />
          </View>
        ) : (
          <PrimaryAction label="Create a plan" icon="plus" captureId="a-today-primary" onPress={ctx.openPlans} />
        )}
      </Gutter>
    </Screen>
  );
}

/** DGR-016: the Cues movement list; v1 does not draw one. Movements from the account's plans come first. */
function CuesIndex({ plans, exercises, backLabel, onBack, onOpen }: {
  plans: Plan[]; exercises: Exercise[]; backLabel: string; onBack: () => void; onOpen: (exerciseId: string) => void;
}) {
  const inPlans = new Set(plans.flatMap((p) => p.items.map((i) => i.exerciseId)));
  const list = exercises.filter((e) => !e.retired).sort((a, b) => Number(inPlans.has(b.id)) - Number(inPlans.has(a.id)));
  return (
    <Screen testID="screen-cues-index" nav={<Nav back={backLabel} onBack={onBack} />}>
      <Gutter><Title text="Cues" /><Subtitle text="Pick a movement to choose the cues that help." /></Gutter>
      <Section>
        {list.map((e, i) => <AccountRow key={e.id} label={e.name} onPress={() => onOpen(e.id)} last={i === list.length - 1} />)}
      </Section>
    </Screen>
  );
}

const s = StyleSheet.create({
  fill: { flex: 1, backgroundColor: t.color.canvas },
  hidden: { display: 'none' },
  layer: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, backgroundColor: t.color.canvas },
  gap32: { marginTop: t.space.s32 },
  session: { gap: t.space.s8 },
  navTrail: { flexDirection: 'row', alignItems: 'center', gap: t.space.s12 },
  avatar: {
    width: L.account.avatar, height: L.account.avatar, borderRadius: t.radius.capsule, backgroundColor: t.color.selection,
    alignItems: 'center', justifyContent: 'center',
  },
});
