import { z } from 'zod';
import { Domain } from '../domain.js';
import { DomainError } from '../errors.js';
import type { CanonicalAccountWriter } from '../integration/account-modules/canonical-writer.js';
import type { AccountContext } from '../lifecycle/types.js';
import { planFields, type SavedPlan } from '../schemas.js';
import { canonical, command } from '../storage.js';
import type { PlanRevisionPort } from '../wearables/types.js';

const lineage = z.object({
  operation: z.enum(['suggestion_accept', 'suggestion_undo']), suggestionId: z.string().min(1),
  planId: z.string().min(1), fromRevision: z.number().int().positive(), toRevision: z.number().int().positive(),
  undoOf: z.string().nullable(),
}).strict().refine(value => value.toRevision === value.fromRevision + 1 &&
  value.undoOf === (value.operation === 'suggestion_undo' ? value.suggestionId : null));
type Lineage = z.infer<typeof lineage>;

function readLineage(value: unknown): Lineage {
  const result = lineage.safeParse(value);
  if (!result.success) throw new DomainError(503, 'plan_receipt_invalid');
  return result.data;
}

// Source-only composition: callers must use this same writer for their store and
// suggestion receipt transaction. This factory does not mount a runtime port.
export function createPlanRevisionPort(domain: Domain, writer: CanonicalAccountWriter, binding: Readonly<{
  afterPlanWriteWithinWrite(actor: AccountContext, plan: SavedPlan): void;
}>): PlanRevisionPort {
  if (typeof binding?.afterPlanWriteWithinWrite !== 'function') throw new DomainError(503, 'plan_invalidation_binding_required');
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
      context = Object.freeze({ ...context });
      assertWriter(context);
      return db.transaction(() => {
        if (input.receipt.operation !== 'suggestion_accept' && input.receipt.operation !== 'suggestion_undo')
          throw new DomainError(400, 'plan_receipt_operation_invalid');
        const operation = `plan.${input.receipt.operation}`;
        // Copy intent before use so both the fingerprint and mutation see identical data.
        const intent = structuredClone({ context, planId: input.planId, expectedRevision: input.expectedRevision,
          items: input.items, receipt: input.receipt });
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
              let value: unknown;
              try { value = JSON.parse(receipt.result) as unknown; }
              catch { throw new DomainError(503, 'plan_receipt_invalid'); }
              const accepted = readLineage(value);
              if (accepted.operation !== 'suggestion_accept' || accepted.suggestionId !== intent.receipt.suggestionId || accepted.planId !== intent.planId || accepted.undoOf !== null ||
                accepted.toRevision !== intent.expectedRevision || plan.revision !== accepted.toRevision)
                throw new DomainError(409, 'plan_changed_since_apply');
              const before = domain.planRevision(context.accountId, intent.planId, accepted.fromRevision);
              const after = domain.planRevision(context.accountId, intent.planId, accepted.toRevision);
              if ('schema' in before || 'schema' in after || canonical(plan.items) !== canonical(after.items) ||
                canonical(items) !== canonical(before.items)) throw new DomainError(409, 'plan_changed_since_apply');
              undoOf = intent.receipt.suggestionId;
            }
            const next = domain.mutatePlanWithinWrite(context.accountId, intent.planId,
              { expectedRevision: intent.expectedRevision, items }, plan => {
                assertWriter(context);
                const effect: unknown = binding.afterPlanWriteWithinWrite(context, plan);
                if (effect && typeof (effect as { then?: unknown }).then === 'function') {
                  void Promise.resolve(effect).catch(() => {});
                  throw new DomainError(503, 'plan_callback_must_be_synchronous');
                }
                assertWriter(context);
              });
            const body: Lineage = { operation: intent.receipt.operation, suggestionId: intent.receipt.suggestionId, planId: intent.planId, fromRevision: intent.expectedRevision,
              toRevision: next.revision, undoOf };
            assertWriter(context);
            return { status: 200, body };
          });
        const committed = readLineage(result.body);
        if (committed.operation !== intent.receipt.operation || committed.suggestionId !== intent.receipt.suggestionId || committed.planId !== intent.planId || committed.fromRevision !== intent.expectedRevision ||
          committed.undoOf !== (intent.receipt.operation === 'suggestion_undo' ? intent.receipt.suggestionId : null))
          throw new DomainError(503, 'plan_receipt_invalid');
        assertWriter(context);
        return { revision: committed.toRevision };
      }).immediate();
    },
  });
}
