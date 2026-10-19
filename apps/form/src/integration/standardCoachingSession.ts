import type { FormResources } from '../api/resources';
import type { LocalTeardownResult, TeardownReason, VoiceFence } from '../voice-coaching/contracts';
import { sameVoiceFence } from '../voice-coaching/session-controller';
import { createStandardVoiceConsumer } from '../voice-coaching/standard/controller';
import type {
  StandardCoachingComponentProps, StandardVoiceConsumerOptions,
} from '../voice-coaching/standard';
import type { SharedVoiceScope, SharedVoiceStandardInvalidation } from './sharedVoice';

export type StandardCoachingSession = Readonly<{
  props: StandardCoachingComponentProps;
  dispose(): Promise<LocalTeardownResult>;
}>;

/** One Activity binding captures its ports before admitting an explicit consumer. */
export function createStandardCoachingProducer(options: Readonly<{
  resources: FormResources;
  accountId: string;
  sessionGeneration: string;
  scope?: SharedVoiceScope;
  isCurrentSession(): boolean;
  host: StandardVoiceConsumerOptions['host'];
  turn?: StandardVoiceConsumerOptions['turn'];
  newSessionId: StandardVoiceConsumerOptions['newSessionId'];
}>) {
  const { resources, accountId, sessionGeneration, newSessionId } = options;
  const api = resources.api, currentView = options.isCurrentSession;
  const originalScope = options.scope;
  const account = originalScope && Object.freeze({ ...originalScope.account });
  const checkScope = originalScope?.isCurrent.bind(originalScope);
  const startStandard = options.host?.startStandard.bind(options.host);
  let operation: { sessionId: string; signal: AbortSignal; fence?: VoiceFence } | undefined;
  const host = startStandard && Object.freeze({ async startStandard(scope: SharedVoiceScope, sessionId: string, signal: AbortSignal) {
    const captured = { sessionId, signal, fence: undefined as VoiceFence | undefined };
    operation = captured;
    const handle = await startStandard(scope, sessionId, signal);
    if (operation === captured) captured.fence = Object.freeze({ ...handle.fence });
    return handle;
  } });
  const turn = options.turn && Object.freeze({ run: options.turn.run.bind(options.turn) });
  let expired = false, closed = false;
  let session: StandardCoachingSession | null = null;
  let firstManual: StandardVoiceConsumerOptions['onManual'] | undefined;
  let consumer: StandardCoachingComponentProps['consumer'] | undefined;
  let disposal: Promise<LocalTeardownResult> | undefined;
  const current = () => {
    try {
      if (resources.api !== api || !currentView() || !checkScope?.() || !account ||
        account.accountId !== accountId || account.authSessionId !== sessionGeneration) expired = true;
    } catch { expired = true; }
    return !closed && !expired;
  };
  const scope = account && Object.freeze({ account, isCurrent: current });
  const released = (): LocalTeardownResult => Object.freeze({ status: 'released', failedSteps: Object.freeze([]) });
  const dispose = () => {
    closed = true;
    if (!disposal) {
      try { disposal = consumer ? consumer.dispose() : Promise.resolve(released()); }
      catch (error) { disposal = Promise.reject(error); }
    }
    return disposal;
  };
  return Object.freeze({
    scope,
    create(onManual: StandardVoiceConsumerOptions['onManual']): StandardCoachingSession | null {
      if (!scope || !current() || typeof onManual !== 'function') return null;
      if (session) {
        const phase = session.props.consumer.snapshot().phase;
        if (phase === 'disposed' || phase === 'cleanup_incomplete') { closed = true; return null; }
        if (phase === 'stopping') return null;
        return firstManual === onManual ? session : null;
      }
      firstManual = onManual;
      consumer = createStandardVoiceConsumer({ scope, host, turn, newSessionId,
        onManual() { if (current()) onManual(); },
      });
      session = Object.freeze({ props: Object.freeze({ consumer }), dispose });
      return session;
    },
    /** stop() aborts and clears review synchronously; its receipt still describes terminal cleanup. */
    stop(reason: TeardownReason): Promise<LocalTeardownResult> {
      if (reason === 'account_changed' || reason === 'logout' || reason === 'navigation') expired = true;
      return consumer ? consumer.stop(reason) : Promise.resolve(released());
    },
    stopInvalidated(input: SharedVoiceStandardInvalidation): Promise<LocalTeardownResult> | null {
      const captured = operation;
      const matches = (value: SharedVoiceScope['account']) => !!account && value.accountId === account.accountId &&
        value.authSessionId === account.authSessionId && value.accountEpoch === account.accountEpoch;
      if (!consumer || !captured || captured.sessionId !== input.sessionId || captured.signal !== input.signal ||
        !matches(input.scope.account) || !matches(input.fence) || !Number.isSafeInteger(input.fence.generation) || input.fence.generation <= 0 ||
        (captured.fence && !sameVoiceFence(captured.fence, input.fence))) return null;
      return consumer.stop(input.reason);
    },
    dispose,
  });
}
