import { createHash } from 'node:crypto';
import { DomainError } from '../errors.js';
import type { AccountContext } from '../lifecycle/types.js';
import type { ComparisonRead } from '../progress-comparison/persistence-types.js';
import type { DerivedFeedback, FeedbackRecord } from './index.js';
import { feedbackCanonical } from './ledger-store.js';
import type { ComparableFeedbackInput, ComparisonAssociation, FeedbackBinding, FeedbackComparisonLineage,
  FeedbackDerivationSpec, FeedbackServiceDependencies, FeedbackSourceKey } from './ledger-types.js';

const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const equal = (a: unknown, b: unknown) => feedbackCanonical(a) === feedbackCanonical(b);
const failure = (): never => { throw new DomainError(503, 'feedback_comparison_binding_invalid'); };

// Declarations are trusted registration data; only fresh producer reads can supply compute values.
export function createFeedbackComparisonInputs(deps: FeedbackServiceDependencies, recipes: readonly FeedbackDerivationSpec[]) {
  const registry = deps.comparisonRegistry ? structuredClone(deps.comparisonRegistry) : null;
  if (registry && (registry.schema !== 'feedback-comparison-inputs-v1' || !text(registry.version)
      || !Array.isArray(registry.inputs) || new Set(registry.inputs.map(input => input.id)).size !== registry.inputs.length
      || registry.inputs.some(input => !text(input.id) || !text(input.contextId)))) failure();
  const declarations = new Map(registry?.inputs.map(input => [input.id, input]) ?? []);
  const registryDigest = createHash('sha256').update(feedbackCanonical(registry)).digest('hex');
  for (const recipe of recipes) if (recipe.comparisonIds && (!Array.isArray(recipe.comparisonIds)
      || recipe.comparisonIds.some(id => !text(id)) || new Set(recipe.comparisonIds).size !== recipe.comparisonIds.length)) failure();

  return function prepare(context: AccountContext, records: readonly FeedbackRecord[], bindings: ReadonlyMap<string, FeedbackBinding | null>,
    graph: readonly DerivedFeedback[]) {
    const recordMap = new Map(records.map(record => [record.recordId, record]));
    const roots = new Map(graph.map(node => [node.id, node.lineage.map(source => source.recordId)]));
    function readAll(): Map<string, FeedbackComparisonLineage[]> {
      const observed = new Map<string, ComparisonRead | null>();
      for (const id of new Set(recipes.flatMap(recipe => recipe.comparisonIds ?? []))) {
        const declaration = declarations.get(id);
        if (!declaration || !deps.readComparisonWithinWrite) { observed.set(id, null); continue; }
        deps.lifecycle.assertActive(context);
        const read = deps.readComparisonWithinWrite(context, structuredClone({ contextId: declaration.contextId, ...declaration.selections }));
        deps.lifecycle.assertActive(context);
        feedbackCanonical(read);
        if (read.status === 'observed') {
          const witness = read.witness;
          if (witness.witnessVersion !== 'progress-comparison-witness-v2' || witness.accountId !== context.accountId
              || witness.contextId !== declaration.contextId || witness.interpretation !== 'observed_work_only'
              || !text(witness.evidenceToken) || witness.result.evidenceToken !== witness.evidenceToken) failure();
          for (const side of ['baseline', 'current'] as const) {
            const selected = declaration.selections[side], source = witness.scope[side];
            if (source.accountId !== context.accountId || source.kind !== selected.kind || source.id !== selected.id
                || source.itemId !== selected.itemId || !equal(source, witness.inputs[side].scope.source)) failure();
          }
        } else if (read.status !== 'unavailable' || !['reader_unavailable', 'source_missing', 'item_missing'].includes(read.reason)
            || !['baseline', 'current'].includes(read.side)) failure();
        observed.set(id, structuredClone(read));
      }
      const result = new Map<string, FeedbackComparisonLineage[]>();
      for (const recipe of recipes) {
        const lineage: FeedbackComparisonLineage[] = [];
        for (const inputId of recipe.comparisonIds ?? []) {
          const declaration = declarations.get(inputId) ?? null, producer = observed.get(inputId) ?? null;
          const blockedBy: string[] = [];
          let association: ComparisonAssociation | null = null;
          if (!declaration) blockedBy.push('comparison:undeclared');
          else if (declaration.contextId !== recipe.scope.contextId) blockedBy.push('comparison:context-mismatch');
          if (declaration && !deps.readComparisonWithinWrite) blockedBy.push('comparison:producer-unbound');
          if (producer?.status === 'unavailable') blockedBy.push(`comparison:${producer.reason}:${producer.side}`);
          if (producer?.status === 'observed') {
            const witness = producer.witness;
            if (witness.result.status !== 'comparable') blockedBy.push(`comparison:${witness.result.status}`);
            if (witness.inputs.baseline.identity.state !== 'qualified' || witness.inputs.current.identity.state !== 'qualified')
              blockedBy.push('comparison:identity-unqualified');
            if (declaration && declaration.contextId === recipe.scope.contextId && deps.associateComparisonWithinWrite) {
              deps.lifecycle.assertActive(context);
              association = deps.associateComparisonWithinWrite(context, structuredClone({
                recipe: { id: recipe.id, version: recipe.version, kind: recipe.kind, scope: recipe.scope }, declaration, witness,
                feedback: (roots.get(recipe.id) ?? []).flatMap(id => {
                  const record = recordMap.get(id);
                  return record ? [{ record, binding: bindings.get(id) ?? null }] : [];
                }),
              }));
              deps.lifecycle.assertActive(context);
              if (association?.status === 'associated') {
                if (!text(association.evidenceToken) || !Array.isArray(association.sourceRefs) || !association.sourceRefs.length
                    || association.sourceRefs.some(ref => !text(ref.sourceId) || !text(ref.revision) || !text(ref.locator) || !text(ref.qualification))) failure();
              } else association = { status: 'unavailable', reason: 'association_unproved' };
            }
          }
          if (association?.status !== 'associated') blockedBy.push('comparison:association-unproved');
          lineage.push({ registryVersion: registry?.version ?? null, registryDigest, recipeId: recipe.id, recipeVersion: recipe.version,
            inputId, declaration: structuredClone(declaration), producer: structuredClone(producer), association: structuredClone(association), blockedBy });
        }
        result.set(recipe.id, lineage);
      }
      return result;
    }
    const before = readAll();
    return {
      input(recipeId: string): { blockedBy: string[]; comparisons: Readonly<Record<string, ComparableFeedbackInput>> } {
        const lineage = before.get(recipeId) ?? [];
        return { blockedBy: lineage.flatMap(item => [...item.blockedBy]), comparisons: Object.fromEntries(lineage.flatMap(item =>
          !item.blockedBy.length && item.producer?.status === 'observed' && item.producer.witness.result.status === 'comparable'
            ? [[item.inputId, structuredClone(item.producer.witness) as ComparableFeedbackInput]] : [])) };
      },
      lineage(node: DerivedFeedback): FeedbackComparisonLineage[] {
        return structuredClone(node.recipeLineage.flatMap(recipe => before.get(recipe.id) ?? []));
      },
      assertUnchanged() {
        if (!equal([...before], [...readAll()])) throw new DomainError(409, 'feedback_comparison_changed_during_consume');
      },
    };
  };
}

export function feedbackComparisonDependencies(lineage: readonly FeedbackComparisonLineage[]): FeedbackSourceKey[] {
  const keys: FeedbackSourceKey[] = [];
  for (const item of lineage) {
    if (!item.declaration) continue;
    keys.push({ kind: 'context', id: item.declaration.contextId });
    for (const side of ['baseline', 'current'] as const) {
      const source = item.declaration.selections[side];
      keys.push({ kind: source.kind, id: source.id }, { kind: 'comparisonIdentity', sourceKind: source.kind, sourceId: source.id, itemId: source.itemId });
      const scope = item.producer?.status === 'observed' ? item.producer.witness.inputs[side].scope : null;
      if (scope?.session) keys.push({ kind: 'plan', id: scope.session.planId });
    }
  }
  return [...new Map(keys.map(key => [feedbackCanonical(key), key])).values()];
}
