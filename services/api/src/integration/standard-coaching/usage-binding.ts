import { DomainError } from '../../errors.js';
import { canonical, hash } from '../../storage.js';
import type { UsageLedger } from '../../usage-limits/types.js';
import { standardTurnStages } from '../../voice-coaching/turn-controller.js';
import type { StandardTurnEvidence, StandardTurnResolution } from '../../voice-coaching/turn-controller.js';
import type { StandardCoachingTurnBindings, StandardCoachingTurnRequest } from './composition.js';

/**
 * Binds one Standard coaching turn to the real usage ledger as a single `coach_messages` unit.
 *
 * The bindings carry only message charges: this module never emits a `live_voice_ms` charge, so Standard can never be
 * charged time. It chooses no default policy, grant or limit; the ledger's configured policy decides admission, and the
 * caller must say explicitly how a partly failed turn is counted.
 */
export const standardVoiceTurnOperation = 'standard_voice_turn';
/**
 * What to do when at least one provider stage succeeded but the whole turn did not complete (and nothing is uncertain):
 * `settle_one` counts the turn, `settle_zero` settles it as zero units and holds nothing, `retain_unknown` keeps the unit
 * held as unknown until trusted reconciliation. There is no default; the owner has not decided.
 */
export type StandardPartialTurnCounting = 'settle_one' | 'settle_zero' | 'retain_unknown';
export const standardNoStageSucceededEvidenceId = 'standard-turn-no-stage-succeeded-v1';

const identifierPattern = /^[A-Za-z0-9_.:/@+-]{1,160}$/;
const digestPattern = /^[a-f0-9]{64}$/;
const countingModes: readonly string[] = ['settle_one', 'settle_zero', 'retain_unknown'];

export function createStandardTurnUsageBinding(options: Readonly<{
  ledger: Pick<UsageLedger, 'usage' | 'trusted'>;
  turn: StandardCoachingTurnRequest;
  subjectId: string;
  partialTurnCounting: StandardPartialTurnCounting;
}>): Pick<StandardCoachingTurnBindings, 'usage' | 'trusted' | 'policy'> {
  const { ledger, turn, subjectId, partialTurnCounting } = options;
  // Composition faults are server errors and take precedence over the client's missing header.
  if (!ledger?.usage || !ledger.trusted || typeof subjectId !== 'string' || !identifierPattern.test(subjectId)
    || typeof partialTurnCounting !== 'string' || !countingModes.includes(partialTurnCounting)
    || typeof turn?.requestSha256 !== 'string' || !digestPattern.test(turn.requestSha256))
    throw new DomainError(503, 'standard_coaching_usage_binding_invalid');
  const idempotencyKey = turn.idempotencyKey;
  if (idempotencyKey === undefined) throw new DomainError(400, 'idempotency_key_required');
  const { requestSha256 } = turn;
  const settle = (amount: 0 | 1): StandardTurnResolution => ({
    kind: 'settle', settlement: { charges: [{ metric: 'coach_messages', amount }] },
  });
  return {
    usage: ledger.usage,
    trusted: ledger.trusted,
    policy: {
      intent: {
        operation: standardVoiceTurnOperation, idempotencyKey,
        intentHash: hash(canonical({ v: 1, operation: standardVoiceTurnOperation, subjectId, requestSha256 })),
        subjectId, charges: [{ metric: 'coach_messages', amount: 1 }], dispatchStages: [...standardTurnStages],
      },
      // The controller has already forced `unknown` when any stage is uncertain or unknown, before this is called.
      resolve(evidence: StandardTurnEvidence): StandardTurnResolution {
        if (evidence.completed) return settle(1);
        if (!evidence.stages.some(stage => stage.outcome === 'succeeded'))
          return { kind: 'not_consumed', evidenceId: standardNoStageSucceededEvidenceId };
        if (partialTurnCounting === 'settle_one') return settle(1);
        if (partialTurnCounting === 'settle_zero') return settle(0);
        return { kind: 'unknown' };
      },
    },
  };
}
