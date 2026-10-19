import { DomainError } from '../../errors.js';
import type { CoachingRequestScope } from '../../voice-coaching/contracts.js';
import { createGroundedCompletionPreparation } from '../../voice-coaching/grounded-preparation.js';
import { createStandardTurnController } from '../../voice-coaching/turn-controller.js';
import { createStandardWireHandler } from '../../voice-coaching/standard/wire-turn.js';
import { createStandardWireCodec, type StandardWireLimits } from '../../voice-coaching/standard/wire-codec.js';

type ControllerBindings = Parameters<typeof createStandardTurnController>[0];
type GroundingBinding = NonNullable<Parameters<typeof createGroundedCompletionPreparation>[0]>;
export type StandardCoachingTurnBindings = Omit<ControllerBindings, 'prepareCompletion'> & Readonly<{
  grounding: Omit<GroundingBinding, 'scope'>;
  /** Synchronously checks this turn's authorization, resource/context revisions and disclosure permission.
   * Capture trusted state in the factory; do not call the supplied scope.assertCurrent from this guard. */
  assertCurrent(): void;
}>;
export type StandardCoachingConfiguration = Readonly<{
  limits: StandardWireLimits;
  deadlineMs: number;
  forTurn(scope: CoachingRequestScope): StandardCoachingTurnBindings | undefined;
}>;

/** Trusted factories supply a new intent and authorization context for every independently admitted turn. */
export function createStandardCoachingComposition(configuration?: StandardCoachingConfiguration) {
  if (!configuration) return undefined;
  const limits = Object.freeze({ ...configuration.limits });
  const deadlineMs = configuration.deadlineMs, forTurn = configuration.forTurn;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0 || deadlineMs > 2_147_483_647 || typeof forTurn !== 'function')
    throw new DomainError(503, 'standard_coaching_configuration_required');
  createStandardWireCodec(limits);
  return Object.freeze({ limits, deadlineMs,
    async run(scope: CoachingRequestScope, request: string): Promise<string> {
      const signal = scope.signal, assertScopeCurrent = scope.assertCurrent.bind(scope);
      let assertTurnCurrent: (() => unknown) | undefined, checking = false;
      const guardedScope: CoachingRequestScope = Object.freeze({ actor: scope.actor, signal, assertCurrent() {
        signal.throwIfAborted();
        assertScopeCurrent();
        if (assertTurnCurrent) {
          if (checking) throw new DomainError(503, 'standard_coaching_currentness_invalid');
          checking = true;
          try {
            const result = assertTurnCurrent();
            if (result !== null && (typeof result === 'object' || typeof result === 'function')
              && typeof (result as { then?: unknown }).then === 'function') {
              void Promise.resolve(result).catch(() => {});
              throw new DomainError(503, 'standard_coaching_currentness_invalid');
            }
          } finally { checking = false; }
        }
        assertScopeCurrent();
        signal.throwIfAborted();
      } });
      // Each invocation owns its guard closure, including the wire handler's final release check.
      const handler = createStandardWireHandler({ limits, controller: {
        async run(receivedScope, audio) {
          receivedScope.assertCurrent();
          const bindings = forTurn(receivedScope);
          if (!bindings) throw new DomainError(503, 'standard_coaching_unavailable');
          if (typeof bindings.assertCurrent !== 'function') throw new DomainError(503, 'standard_coaching_currentness_required');
          assertTurnCurrent = bindings.assertCurrent.bind(bindings);
          receivedScope.assertCurrent();
          // Preparation and controller must retain precisely the wire handler's frozen scope identity.
          const prepareCompletion = createGroundedCompletionPreparation({ ...bindings.grounding, scope: receivedScope });
          const controller = createStandardTurnController({ provider: bindings.provider, usage: bindings.usage, trusted: bindings.trusted,
            ...(bindings.policy ? { policy: bindings.policy } : {}),
            ...(bindings.observeStages ? { observeStages: bindings.observeStages } : {}),
            ...(prepareCompletion ? { prepareCompletion } : {}),
          });
          receivedScope.assertCurrent();
          return controller.run(receivedScope, audio);
        },
      } });
      return handler.run(guardedScope, request);
    },
  });
}
