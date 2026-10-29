import type { EmbeddedReadonly } from '../../planning/synthetic-lineage/subcodec-types.js';
import type { SourcePlanFieldsV1 } from '../../planning/synthetic-lineage/types.js';

/** Invented identity recipe: no dose calculation, advice or clinical meaning. */
export const fixtureRecipe = Object.freeze({ id: 'syn_recipe_identity', version: 'identity-fixture-v1',
  constants: Object.freeze({ fixtureId: 'syn_constants_identity', meaning: 'synthetic identity transform; no prescription' }) });
export function fixtureAfter(before: EmbeddedReadonly<SourcePlanFieldsV1>): EmbeddedReadonly<SourcePlanFieldsV1> { return before; }
