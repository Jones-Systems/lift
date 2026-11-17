import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { createUsageLedger, createUsageLimitsConfiguration, usageOperationKinds } from '../../src/usage-limits/index.js';
import type {
  UsageGrantsConfig, UsageIntent, UsageLedger, UsageLimitsConfiguration, UsageOperationKind, UsagePolicyConfig,
} from '../../src/usage-limits/index.js';
import { fixture } from './fixture.js';
import type { UsageFixture } from './fixture.js';

export type ExampleGrantState = { capabilities: string[] };

/**
 * Synthetic owner example values, not pricing. The message and generation limits below are illustrative only and exist
 * solely in this test helper: no source file may carry a default policy, period, zone, grant or these limits.
 */
export function exampleUsagePolicyConfig(overrides: Partial<UsagePolicyConfig> = {}): UsagePolicyConfig {
  return {
    policyId: 'synthetic-example-policy-v1',
    period: { kind: 'calendar_month_utc' },
    liveMessageCounting: 'excluded',
    limits: { live_voice_ms: 9_000_000, coach_messages: 1000, workout_generations: 100 },
    operations: {
      standard_voice_turn: { capability: 'cap.standard' },
      coach_message: { capability: 'cap.message' },
      workout_generation: { capability: 'cap.generate' },
      live_voice_session: { capability: 'cap.live' },
    },
    ...overrides,
  };
}

export const exampleCapabilities: readonly string[] = ['cap.standard', 'cap.message', 'cap.generate', 'cap.live'];
export function exampleGrantState(capabilities: readonly string[] = exampleCapabilities): ExampleGrantState {
  return { capabilities: [...capabilities] };
}

/** Reads the mutable `state.capabilities` on every call, so tests can grant and revoke between requests. */
export function exampleGrants(
  state: ExampleGrantState, configuredOperations: readonly UsageOperationKind[] = usageOperationKinds,
): UsageGrantsConfig {
  return { grantPolicyId: 'synthetic-example-grants-v1', configuredOperations: [...configuredOperations],
    resolveCapabilities: () => state.capabilities };
}

export type ConfiguredLedger = Readonly<{
  ledger: UsageLedger;
  configuration: UsageLimitsConfiguration;
  policy: UsageLimitsConfiguration['policy'];
  state: ExampleGrantState;
}>;

/** Builds a ledger over an existing fixture database from the explicit-configuration builders. */
export function ledgerOn(
  f: UsageFixture, config: UsagePolicyConfig = exampleUsagePolicyConfig(), state: ExampleGrantState = exampleGrantState(),
  configuredOperations: readonly UsageOperationKind[] = usageOperationKinds,
): ConfiguredLedger {
  const configuration = createUsageLimitsConfiguration({ policy: config, grants: exampleGrants(state, configuredOperations) });
  assert.ok(configuration, 'explicit configuration must build a ledger configuration');
  const ledger = createUsageLedger({ ...f.options(f.db, configuration.policy), resolveRights: configuration.resolveRights });
  return { ledger, configuration, policy: configuration.policy, state };
}

/** Reuses the existing ledger fixture's database, lifecycle and clock; its own policy and rights are replaced. */
export function configuredLedger(
  t: TestContext, config?: UsagePolicyConfig, state?: ExampleGrantState,
  configuredOperations?: readonly UsageOperationKind[],
): ConfiguredLedger & Readonly<{ f: UsageFixture }> {
  const f = fixture(t);
  return { ...ledgerOn(f, config, state, configuredOperations), f };
}

const standardStages = ['transcribe', 'complete', 'synthesize'] as const;
export const liveStage = 'createCall';
export const standardStageList: readonly string[] = standardStages;
export function liveIntent(key: string, milliseconds: number, withMessage = false): UsageIntent {
  return { operation: 'live_voice_session', idempotencyKey: key, intentHash: 'b'.repeat(64), subjectId: 'subject-live',
    charges: [{ metric: 'live_voice_ms', amount: milliseconds }, ...(withMessage ? [{ metric: 'coach_messages' as const, amount: 1 }] : [])],
    dispatchStages: [liveStage] };
}
export function standardIntent(key: string): UsageIntent {
  return { operation: 'standard_voice_turn', idempotencyKey: key, intentHash: 'c'.repeat(64), subjectId: 'subject-standard',
    charges: [{ metric: 'coach_messages', amount: 1 }], dispatchStages: standardStages };
}
export function generationIntent(key: string): UsageIntent {
  return { operation: 'workout_generation', idempotencyKey: key, intentHash: 'd'.repeat(64), subjectId: 'subject-generation',
    charges: [{ metric: 'workout_generations', amount: 1 }], dispatchStages: ['effect'] };
}
