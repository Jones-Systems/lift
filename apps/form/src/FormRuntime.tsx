import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AccessibilityInfo, AppState } from 'react-native';
import * as Crypto from 'expo-crypto';
import { createPhoneSignInAttempt } from './api/phoneSignIn';
import { FeatureBoardResources } from './api/featureBoard';
import { CommunityResources } from './api/community';
import { ApiError, commandKey } from './api/client';
import type { AppMode } from './api/domain';
import { formResources } from './api/resources';
import { signInWithApple } from './api/appleSignIn';
import { BodyFlow, bodyPrivacySummary } from './body';
import { bindFormNativeModule } from './native/runtime';
import type { FormSpeechNative } from './native/speech.types';
import { createSharedVoice, type SharedVoiceScope, type SharedVoiceStandardConfiguration, type SharedVoiceStandardInvalidation } from './integration/sharedVoice';
import { nativeReceiptCustody } from './account-lifecycle/native';
import { createLifecycleSession, type LifecycleShellBinding } from './integration/lifecycleSession';
import { createCommandOwnerRegistry, type CommandConfirmationValidator, type CommandOwnerSession } from './integration/commandOwnerSession';
import { createActivitySession } from './integration/activitySession';
import { createStandardCoachingProducer } from './integration/standardCoachingSession';
import { createStandardCoachingTransport, type StandardCoachingTransportConfiguration } from './integration/standardCoachingTransport';
import { createManualProgressSession } from './integration/manualProgressSession';
import { validateManualCommandConfirmation } from './body/manualCommandConfirmation';
import { validateManualRetentionCommandConfirmation } from './body/manualRetentionConfirmation';
import type { StandardClientTurnPort, StandardVoiceHost } from './voice-coaching/standard';
import type { LocalTeardownResult, TeardownReason } from './voice-coaching/contracts';
import { resolvePresentationPolicy } from './integration/presentationPolicy';
import { observeSystemMotion } from './integration/systemMotion';
import { appModeFrom } from './settings/appMode';
import {
  FormAccountApp, type FormAccountAppProps, type FormAccountSnapshot,
  type SaveResult, type SessionAction, type FeatureSlotContext, type SpeechPort,
} from './features';

type RuntimeProps = Omit<FormAccountAppProps,
  'commandOwnerForSession' | 'lifecycleSession' | 'speech' | 'scopedSpeech' | 'appMode' | 'resources' | 'renderBody' | 'renderActivity' | 'renderCommunity' | 'renderFeatureRequests' | 'onSessionAction'> & {
  resources?: FormAccountAppProps['resources'];
  standardNative?: SharedVoiceStandardConfiguration;
  standardTurn?: StandardClientTurnPort;
  standardTransport?: StandardCoachingTransportConfiguration;
  validateConfirmation?: CommandConfirmationValidator;
  renderBody?: (ctx: FeatureSlotContext) => ReactNode;
  renderActivity?: (ctx: ActivityRuntimeContext) => ReactNode;
  renderCommunity?: (ctx: CommunityRuntimeContext) => ReactNode;
  renderFeatureRequests?: (ctx: FeatureBoardRuntimeContext) => ReactNode;
};

export type ActivityRuntimeContext = FeatureSlotContext & {
  activity: ReturnType<typeof createActivitySession>;
};
export type FeatureBoardRuntimeContext = FeatureSlotContext & { board: FeatureBoardResources };
export type CommunityRuntimeContext = FeatureSlotContext & { community: CommunityResources };

export function FormRuntime({ resources = formResources, standardNative, standardTurn, standardTransport, onSnapshot, identity, renderSettings, renderBody, renderActivity, renderCommunity, renderFeatureRequests, validateConfirmation, ...slots }: RuntimeProps) {
  const bodyRenderer = useRef(renderBody);
  const bodyPresentationEnd = useRef<(() => void) | null>(null);
  if (bodyRenderer.current !== renderBody) {
    bodyRenderer.current = renderBody;
    // The departing boundary does not render when its renderer is removed.
    try { bodyPresentationEnd.current?.(); } catch { /* Captured account disposal retains the failure. */ }
  }
  const retainBodyPresentation = useCallback((end: () => void) => {
    bodyPresentationEnd.current = end;
    return () => { if (bodyPresentationEnd.current === end) bodyPresentationEnd.current = null; };
  }, []);
  const configuredStandardTurn = useMemo(() => standardTurn ?? createStandardCoachingTransport(resources.api, standardTransport),
    [resources, standardTurn, standardTransport]);
  const [accountDisposals] = useState(() => new Map<string, Set<AccountDisposal>>());
  const selectedVoiceOwners = useCallback((scope: SharedVoiceScope) =>
    [...(accountDisposals.get(scope.account.authSessionId) ?? [])].filter(entry => entry.scope &&
      entry.scope.account.accountId === scope.account.accountId && entry.scope.account.accountEpoch === scope.account.accountEpoch &&
      entry.scope.account.authSessionId === scope.account.authSessionId), [accountDisposals]);
  const stopScopeConsumers = useCallback((scope: SharedVoiceScope, reason: TeardownReason) => {
    const attempts = selectedVoiceOwners(scope).map(entry => {
      try { return Promise.resolve(entry.stopImmediately?.(reason)); } catch (error) { return Promise.reject(error); }
    });
    return settleAudioStops(attempts);
  }, [selectedVoiceOwners]);
  const [voice] = useState(() => createSharedVoice({ speech: bindFormNativeModule<FormSpeechNative>('FormSpeech'), standard: standardNative,
    onStandardInvalidated(input) {
      for (const entry of selectedVoiceOwners(input.scope)) {
        try { const result = entry.stopInvalidated?.(input); if (result) void result.catch(() => {}); }
        catch { /* Continue matching original owners; the shared host still tears down its exact record. */ }
      }
    },
  }));
  const stopScopedVoice = useCallback((scope: SharedVoiceScope, reason: TeardownReason) => {
    const attempts: Promise<LocalTeardownResult>[] = [];
    try { attempts.push(stopScopeConsumers(scope, reason)); } catch (error) { attempts.push(Promise.reject(error)); }
    try { attempts.push(Promise.resolve(voice.stopScope(scope, reason))); } catch (error) { attempts.push(Promise.reject(error)); }
    return settleAudioStops(attempts);
  }, [stopScopeConsumers, voice]);
  useEffect(() => {
    const stopImmediately = (reason: TeardownReason) => {
      const captured = [...accountDisposals.values()].flatMap(entries => [...entries]);
      for (const entry of captured) {
        try { const result = entry.stopImmediately?.(reason); if (result) void result.catch(() => {}); }
        catch { /* Continue stopping each captured consumer and the shared host. */ }
      }
    };
    const auth = resources.api.subscribeAuthChanges(() => { stopImmediately('account_changed'); void voice.stop('account_changed'); });
    const app = AppState.addEventListener('change', state => {
      if (state !== 'active') { stopImmediately('background'); void voice.stop('background'); }
    });
    return () => { auth.remove(); app.remove(); stopImmediately('account_changed'); void voice.stop('account_changed'); };
  }, [voice, resources, accountDisposals]);
  useEffect(() => () => { void voice.dispose().catch(() => {}); }, [voice]);
  const scopedSpeech = useCallback((scope: SharedVoiceScope | null) => voice.speech(scope), [voice]);
  const [commandOwners] = useState(() => createCommandOwnerRegistry(validateConfirmation ?? ((intent, response) =>
    intent.operation === 'grant_manual_retention' || intent.operation === 'revoke_manual_retention'
      ? validateManualRetentionCommandConfirmation(intent, response)
      : validateManualCommandConfirmation(intent, response))));
  const commandOwnerForSession = useCallback((session: CommandOwnerSession) => commandOwners.forSession(session), [commandOwners]);
  const retainDisposal = useCallback<RetainAccountDisposal>((key, dispose, stopImmediately, metadata) => {
    let entries = accountDisposals.get(key);
    if (!entries) { entries = new Set(); accountDisposals.set(key, entries); }
    const retained = entries;
    const entry = { dispose, stopImmediately, ...metadata };
    retained.add(entry);
    return () => { retained.delete(entry); if (!retained.size && accountDisposals.get(key) === retained) accountDisposals.delete(key); };
  }, [accountDisposals]);
  const lifecycleSession = useCallback((shell: LifecycleShellBinding) => createLifecycleSession({
    api: resources.api, shell, receiptCustody: nativeReceiptCustody,
    captureResources() {
      return commandOwners.captureCleanup({ accountId: shell.accountId,
        sessionGeneration: shell.sessionKey, resources }, [...(accountDisposals.get(shell.sessionKey) ?? [])].map(entry => entry.dispose));
    },
    stopAudio: () => stopScopedVoice(shell.voiceScope, 'account_changed'),
  }), [resources, accountDisposals, commandOwners, stopScopedVoice]);
  const [appMode, setAppMode] = useState<AppMode>('basic');
  const [reduceMotion, setReduceMotion] = useState<boolean | null>(null);
  useEffect(() => observeSystemMotion(AccessibilityInfo, setReduceMotion), []);
  const receiveSnapshot = useCallback((snapshot: FormAccountSnapshot) => {
    setAppMode(appModeFrom(snapshot.account));
    onSnapshot?.(snapshot);
  }, [onSnapshot]);

  const runtimeIdentity = useMemo(() => identity ?? (resources === formResources ? {
    apple: signInWithApple,
    phoneFactory: (guard: import('./api/transport').AuthAttemptGuard) => createPhoneSignInAttempt(resources.api, {
      randomBytes32: () => Crypto.getRandomBytesAsync(32), isCurrentSession: guard.isCurrent,
    }),
  } : {}), [identity, resources]);

  const sessionAction = useCallback(async (action: SessionAction): Promise<SaveResult<null>> => {
    try {
      if (action === 'revokeAllSessions') await resources.api.revokeAllSessions();
      else await resources.api.revokeOtherSessions();
      return { status: 'saved', value: null };
    } catch (error) {
      if (error instanceof ApiError && !error.effectUnknown) return { status: 'failed', error };
      return { status: 'unknown', retry: () => sessionAction(action) };
    }
  }, [resources]);
  const activitySpeech = useCallback((ctx: FeatureSlotContext) => scopedSpeech(ctx.voiceScope ?? null), [scopedSpeech]);

  return <FormAccountApp
    {...slots}
    resources={resources}
    onBeforeVoiceExit={input => {
      void stopScopedVoice(input.scope, input.reason).catch(() => {});
      slots.onBeforeVoiceExit?.(input);
    }}
    scopedSpeech={scopedSpeech}
    lifecycleSession={lifecycleSession}
    commandOwnerForSession={commandOwnerForSession}
    appMode={appMode}
    identity={runtimeIdentity}
    onSnapshot={receiveSnapshot}
    renderHome={slots.renderHome ? (ctx) => slots.renderHome!({
      ...ctx, presentation: resolvePresentationPolicy(ctx.account.preferences, reduceMotion),
    }) : undefined}
    renderCommunity={renderCommunity ? (ctx) => <CommunityBoundary
      key={ctx.sessionGeneration}
      ctx={{ ...ctx, presentation: resolvePresentationPolicy(ctx.account.preferences, reduceMotion) }}
      render={renderCommunity}
      retainDisposal={retainDisposal}
    /> : undefined}
    onSessionAction={sessionAction}
    renderFeatureRequests={renderFeatureRequests ? (ctx) => <FeatureBoardBoundary
      key={ctx.sessionGeneration}
      ctx={{ ...ctx, presentation: resolvePresentationPolicy(ctx.account.preferences, reduceMotion) }}
      render={renderFeatureRequests}
      retainDisposal={retainDisposal}
    /> : undefined}
    renderActivity={renderActivity ? (ctx) => <ActivityBoundary
      key={ctx.sessionGeneration}
      ctx={{ ...ctx, presentation: resolvePresentationPolicy(ctx.account.preferences, reduceMotion) }}
      render={renderActivity}
      speech={activitySpeech}
      standardHost={voice}
      standardTurn={configuredStandardTurn}
      retainDisposal={retainDisposal}
    /> : undefined}
    renderSettings={(ctx) => renderSettings({ ...ctx, bodyPrivacy: bodyPrivacySummary(),
      presentation: resolvePresentationPolicy(ctx.account.preferences, reduceMotion) })}
    renderBody={(ctx) => renderBody ? <ManualProgressBoundary
      key={ctx.sessionGeneration} ctx={ctx} render={renderBody} retainDisposal={retainDisposal}
      rendererCurrent={() => bodyRenderer.current === renderBody} retainPresentation={retainBodyPresentation}
    /> : <BodyFlow
      key={ctx.sessionGeneration}
      accountId={ctx.account.accountId}
      appMode={ctx.appMode}
      onClose={ctx.close}
    />}
  />;
}

type VoiceStopMetadata = Readonly<{
  scope: SharedVoiceScope;
  stopInvalidated?: (input: SharedVoiceStandardInvalidation) => Promise<LocalTeardownResult> | null;
}>;
type ImmediateVoiceStop = (reason: TeardownReason) => void | Promise<LocalTeardownResult>;
type AccountDisposal = Readonly<{ dispose: () => Promise<void>; stopImmediately?: ImmediateVoiceStop }> & Partial<VoiceStopMetadata>;
type RetainAccountDisposal = (sessionKey: string, dispose: () => Promise<void>, stopImmediately?: ImmediateVoiceStop,
  metadata?: VoiceStopMetadata) => () => void;

async function settleAudioStops(attempts: readonly Promise<LocalTeardownResult | void>[]): Promise<LocalTeardownResult> {
  const results = await Promise.allSettled(attempts);
  const failedSteps: string[] = [];
  let incomplete = false;
  for (const result of results) {
    if (result.status === 'rejected') { incomplete = true; failedSteps.push('voice_stop'); }
    else if (result.value) {
      failedSteps.push(...result.value.failedSteps);
      if (result.value.status !== 'released' || result.value.failedSteps.length > 0) incomplete = true;
    }
  }
  return Object.freeze({ status: incomplete ? 'incomplete' : 'released', failedSteps: Object.freeze(failedSteps) });
}

function ManualProgressBoundary({ ctx, render, retainDisposal, rendererCurrent, retainPresentation }: {
  ctx: FeatureSlotContext;
  render: (ctx: FeatureSlotContext) => ReactNode;
  retainDisposal: RetainAccountDisposal;
  rendererCurrent(): boolean;
  retainPresentation(end: () => void): () => void;
}) {
  const physical = useRef({ resources: ctx.resources, generation: ctx.sessionGeneration, accountId: ctx.account.accountId,
    owner: ctx.commandOwner, render, scope: ctx.voiceScope });
  physical.current = { resources: ctx.resources, generation: ctx.sessionGeneration, accountId: ctx.account.accountId,
    owner: ctx.commandOwner, render, scope: ctx.voiceScope };
  const [binding, setBinding] = useState<{
    session: ReturnType<typeof createManualProgressSession>;
    isCurrentPresentation(): boolean;
    endPresentation(): void;
    close(): void;
  } | null>(null);
  if (binding && !binding.isCurrentPresentation()) {
    try { binding.endPresentation(); } catch { /* The captured registry disposer retains this failure. */ }
  }
  useEffect(() => {
    const original = physical.current, scope = original.scope;
    const coordinates = scope && Object.freeze({ ...scope.account });
    const scopeMatches = !coordinates || (coordinates.accountId === original.accountId && coordinates.authSessionId === original.generation &&
      Number.isSafeInteger(coordinates.accountEpoch) && coordinates.accountEpoch >= 0);
    const isCurrentPresentation = () => rendererCurrent() && scopeMatches && physical.current.resources === original.resources &&
      physical.current.generation === original.generation && physical.current.accountId === original.accountId &&
      physical.current.owner === original.owner && physical.current.render === original.render && physical.current.scope === scope &&
      (!coordinates || (scope?.account.accountId === coordinates.accountId && scope.account.authSessionId === coordinates.authSessionId &&
        scope.account.accountEpoch === coordinates.accountEpoch));
    const session = createManualProgressSession(ctx);
    const originalClose = ctx.close.bind(ctx), hostCurrent = ctx.isCurrentSession.bind(ctx);
    let ended = false, failed = false, failure: unknown;
    const endPresentation = () => {
      if (!ended) {
        ended = true;
        try { session.dispose(); } catch (error) { failed = true; failure = error; }
      }
      if (failed) throw failure;
    };
    const close = () => {
      if (ended || !isCurrentPresentation() || !hostCurrent()) return;
      try { endPresentation(); }
      finally { if (isCurrentPresentation() && hostCurrent()) originalClose(); }
    };
    if (!scopeMatches) endPresentation();
    const releasePresentation = retainPresentation(endPresentation);
    setBinding({ session, isCurrentPresentation, endPresentation, close });
    const dispose = async () => { endPresentation(); };
    const release = retainDisposal(ctx.sessionGeneration, dispose, endPresentation, scope && scopeMatches ? { scope } : undefined);
    return () => {
      releasePresentation(); release();
      try { endPresentation(); } catch { /* Already retained for any captured account cleanup. */ }
    };
  }, [ctx.resources, ctx.sessionGeneration, ctx.account.accountId, ctx.commandOwner, ctx.voiceScope,
    ctx.voiceScope?.account.accountId, ctx.voiceScope?.account.authSessionId, ctx.voiceScope?.account.accountEpoch, render, retainDisposal, retainPresentation]);
  return binding && binding.isCurrentPresentation() && ctx.isCurrentSession()
    ? <>{render({ ...ctx, close: binding.close, createManualProgress: binding.session.create })}</> : null;
}

function CommunityBoundary({ ctx, render, retainDisposal }: {
  retainDisposal: RetainAccountDisposal;
  ctx: FeatureSlotContext; render: (ctx: CommunityRuntimeContext) => ReactNode;
}) {
  const [binding, setBinding] = useState<{
    resources: FeatureSlotContext['resources']; generation: FeatureSlotContext['sessionGeneration']; community: CommunityResources;
  } | null>(null);
  useEffect(() => {
    let mounted = true;
    const community = new CommunityResources(ctx.resources.api, () => mounted && ctx.isCurrentSession());
    setBinding({ resources: ctx.resources, generation: ctx.sessionGeneration, community });
    const dispose = async () => { mounted = false; community.dispose(); };
    const release = retainDisposal(ctx.sessionGeneration, dispose);
    return () => { release(); void dispose().catch(() => {}); };
  }, [ctx.sessionGeneration, ctx.resources, retainDisposal]);
  return binding && binding.resources === ctx.resources && binding.generation === ctx.sessionGeneration && ctx.isCurrentSession()
    ? <>{render({ ...ctx, community: binding.community })}</> : null;
}

function FeatureBoardBoundary({ ctx, render, retainDisposal }: {
  retainDisposal: RetainAccountDisposal;
  ctx: FeatureSlotContext; render: (ctx: FeatureBoardRuntimeContext) => ReactNode;
}) {
  const [binding, setBinding] = useState<{
    resources: FeatureSlotContext['resources']; generation: FeatureSlotContext['sessionGeneration']; board: FeatureBoardResources;
  } | null>(null);
  useEffect(() => {
    let mounted = true;
    const board = new FeatureBoardResources(ctx.resources.api, () => mounted && ctx.isCurrentSession());
    setBinding({ resources: ctx.resources, generation: ctx.sessionGeneration, board });
    const dispose = async () => { mounted = false; board.dispose(); };
    const release = retainDisposal(ctx.sessionGeneration, dispose);
    return () => { release(); void dispose().catch(() => {}); };
  }, [ctx.sessionGeneration, ctx.resources, retainDisposal]);
  return binding && binding.resources === ctx.resources && binding.generation === ctx.sessionGeneration && ctx.isCurrentSession()
    ? <>{render({ ...ctx, board: binding.board })}</> : null;
}

function ActivityBoundary({ ctx, render, speech, retainDisposal, standardHost, standardTurn }: {
  retainDisposal: RetainAccountDisposal;
  ctx: FeatureSlotContext;
  render: (ctx: ActivityRuntimeContext) => ReactNode;
  speech: (ctx: FeatureSlotContext) => SpeechPort;
  standardHost: StandardVoiceHost;
  standardTurn?: StandardClientTurnPort;
}) {
  const physical = useRef({ resources: ctx.resources, generation: ctx.sessionGeneration, scope: ctx.voiceScope, standardHost, standardTurn });
  physical.current = { resources: ctx.resources, generation: ctx.sessionGeneration, scope: ctx.voiceScope, standardHost, standardTurn };
  const [binding, setBinding] = useState<{
    resources: FeatureSlotContext['resources']; generation: FeatureSlotContext['sessionGeneration']; activity: ReturnType<typeof createActivitySession>;
    coaching: ReturnType<typeof createStandardCoachingProducer>;
  } | null>(null);
  useEffect(() => {
    let mounted = true;
    const original = physical.current;
    const current = () => mounted && physical.current.resources === original.resources && physical.current.generation === original.generation &&
      physical.current.scope === original.scope && physical.current.standardHost === original.standardHost &&
      physical.current.standardTurn === original.standardTurn && ctx.isCurrentSession();
    const next = createActivitySession({
      sessionGeneration: ctx.sessionGeneration,
      isCurrentSession: current,
      api: ctx.resources.api,
      auth: ctx.resources.api.captureAuthContext(),
    }, commandKey, speech(ctx));
    const coaching = createStandardCoachingProducer({ resources: ctx.resources, accountId: ctx.account.accountId,
      sessionGeneration: ctx.sessionGeneration, scope: ctx.voiceScope, isCurrentSession: current,
      host: standardHost, turn: standardTurn, newSessionId: commandKey });
    setBinding({ resources: ctx.resources, generation: ctx.sessionGeneration, activity: next, coaching });
    const subscription = AppState.addEventListener('change', state => {
      if (state !== 'active') void next.background().catch(() => {});
    });
    let disposal: Promise<void> | undefined;
    const dispose = () => {
      mounted = false;
      subscription.remove();
      disposal ??= Promise.allSettled([
        Promise.resolve().then(() => next.dispose()),
        Promise.resolve().then(() => coaching.dispose()).then(receipt => {
          if (receipt.status !== 'released' || receipt.failedSteps.length > 0) throw receipt;
        }),
      ]).then(results => {
        if (results[1].status === 'rejected') throw results[1].reason;
        for (const result of results) if (result.status === 'rejected') throw result.reason;
      });
      return disposal;
    };
    const release = retainDisposal(ctx.sessionGeneration, dispose, coaching.stop,
      coaching.scope ? { scope: coaching.scope, stopInvalidated: coaching.stopInvalidated } : undefined);
    return () => { release(); void dispose().catch(() => {}); };
  }, [ctx.sessionGeneration, ctx.resources, ctx.voiceScope, speech, retainDisposal, standardHost, standardTurn]);
  return binding && binding.resources === ctx.resources && binding.generation === ctx.sessionGeneration && ctx.isCurrentSession()
    ? <>{render({ ...ctx, activity: binding.activity, createStandardCoaching: binding.coaching.create })}</> : null;
}
