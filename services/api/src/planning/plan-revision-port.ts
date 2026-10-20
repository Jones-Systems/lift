import { z } from 'zod';
import { Domain } from '../domain.js';
import { DomainError } from '../errors.js';
import type { CanonicalAccountWriter } from '../integration/account-modules/canonical-writer.js';
import type { AccountContext } from '../lifecycle/types.js';
import { planFields } from '../schemas.js';
import { canonical, command } from '../storage.js';
import type { PlanRevisionPort } from '../wearables/types.js';

const lineage = z.object({
  planId: z.string(), fromRevision: z.number().int().positive(), toRevision: z.number().int().positive(),
  undoOf: z.string().nullable(),
}).strict().refine(value => value.toRevision === value.fromRevision + 1);
type Lineage = z.infer<typeof lineage>;

function readLineage(value: unknown): Lineage {
  const result = lineage.safeParse(value);
  if (!result.success) throw new DomainError(503, 'plan_receipt_invalid');
  return result.data;
}

// Source-only composition: callers must use this same writer for their store and
// suggestion receipt transaction. This factory does not mount a runtime port.
export function createPlanRevisionPort(domain: Domain, writer: CanonicalAccountWriter): PlanRevisionPort {
  const db = domain.db;
  const assertWriter = (context: AccountContext): void => {
    writer.lifecycleStoreOptions.assertRootWriter(db);
    writer.assertWithinWrite(context);
  };
  const read = (context: AccountContext, planId: string) => {
    assertWriter(context);
    const plan = domain.plan(context.accountId, planId);
    if ('schema' in plan) throw new DomainError(409, 'source_plan_legacy_edit_denied');
    if (plan.archived) throw new DomainError(409, 'plan_archived');
    return plan;
  };
  const activeWorkout = (context: AccountContext, planId: string): boolean =>
    !!db.prepare("SELECT 1 FROM workout_sessions WHERE account_id=? AND plan_id=? AND status='active' LIMIT 1")
      .get(context.accountId, planId);

  return Object.freeze({
    capability: 'atomic_suggestions_v1' as const,
    readWithinWrite(context: AccountContext, planId: string) {
      const plan = read(context, planId);
      return { revision: plan.revision, items: plan.items, activeWorkout: activeWorkout(context, planId) };
    },
    applyWithinWrite(context: AccountContext, input: Parameters<PlanRevisionPort['applyWithinWrite']>[1]) {
      assertWriter(context);
      if (input.receipt.operation !== 'suggestion_accept' && input.receipt.operation !== 'suggestion_undo')
        throw new DomainError(400, 'plan_receipt_operation_invalid');
      const operation = `plan.${input.receipt.operation}`;
      // Copy intent before use so both the fingerprint and mutation see identical data.
      const intent = structuredClone({ context, ...input });
      const result = command(db, context.accountId, operation, intent.receipt.suggestionId, intent,
        () => { read(context, intent.planId); },
        () => {
          const plan = read(context, intent.planId);
          if (activeWorkout(context, intent.planId)) throw new DomainError(409, 'workout_in_progress');
          const items = planFields.shape.items.parse(intent.items);
          if (!Number.isSafeInteger(intent.expectedRevision) || intent.expectedRevision < 1)
            throw new DomainError(422, 'invalid_plan_revision');
          let undoOf: string | null = null;
          if (intent.receipt.operation === 'suggestion_undo') {
            const receipt = db.prepare('SELECT result FROM command_receipts WHERE account_id=? AND operation=? AND key=?')
              .get(context.accountId, 'plan.suggestion_accept', intent.receipt.suggestionId) as { result: string } | undefined;
            if (!receipt) throw new DomainError(409, 'plan_changed_since_apply');
            const accepted = readLineage(JSON.parse(receipt.result) as unknown);
            if (accepted.planId !== intent.planId || accepted.undoOf !== null ||
              accepted.toRevision !== intent.expectedRevision || plan.revision !== accepted.toRevision)
              throw new DomainError(409, 'plan_changed_since_apply');
            const before = domain.planRevision(context.accountId, intent.planId, accepted.fromRevision);
            const after = domain.planRevision(context.accountId, intent.planId, accepted.toRevision);
            if ('schema' in before || 'schema' in after || canonical(plan.items) !== canonical(after.items) ||
              canonical(items) !== canonical(before.items)) throw new DomainError(409, 'plan_changed_since_apply');
            undoOf = intent.receipt.suggestionId;
          }
          const next = domain.mutatePlanWithinWrite(context.accountId, intent.planId,
            { expectedRevision: intent.expectedRevision, items });
          const body: Lineage = { planId: intent.planId, fromRevision: intent.expectedRevision,
            toRevision: next.revision, undoOf };
          assertWriter(context);
          return { status: 200, body };
        });
      const committed = readLineage(result.body);
      if (committed.planId !== intent.planId || committed.fromRevision !== intent.expectedRevision ||
        committed.undoOf !== (intent.receipt.operation === 'suggestion_undo' ? intent.receipt.suggestionId : null))
        throw new DomainError(503, 'plan_receipt_invalid');
      assertWriter(context);
      return { revision: committed.toRevision };
    },
  });
}
