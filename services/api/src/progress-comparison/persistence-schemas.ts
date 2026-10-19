import { z } from 'zod';
import { exerciseRef, resourceId, expectedRevision } from '../activity/schemas.js';

const identityText = z.string().min(1).max(160).refine(value => value === value.trim());
export const sourceSelection = z.object({ kind: z.enum(['session', 'activity']), id: resourceId, itemId: resourceId }).strict();
export const performedIdentity = z.object({ variantId: identityText.nullable(), equipmentId: identityText.nullable(),
  laterality: z.enum(['bilateral', 'left', 'right', 'alternating']).nullable(),
  loadBasis: z.enum(['total', 'perImplement', 'perSide', 'assistance']).nullable() }).strict();
export const identityProvenance = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user_reported') }).strict(),
  z.object({ kind: z.literal('source_native'), repo: identityText, revision: identityText,
    path: z.string().min(1).max(500).refine(value => value === value.trim()),
    sha256: z.string().regex(/^[a-f0-9]{64}$/), nativeId: identityText }).strict(),
]);
export const storedIdentityData = z.object({ exercise: exerciseRef, identity: performedIdentity, provenance: identityProvenance }).strict();
export const confirmIdentity = z.object({ source: sourceSelection, expectedSourceRevision: expectedRevision.min(1),
  expectedBindingRevision: expectedRevision, identity: performedIdentity, provenance: identityProvenance,
  confirmed: z.literal(true) }).strict();
export const withdrawIdentity = z.object({ source: sourceSelection, expectedBindingRevision: expectedRevision.min(1) }).strict();
export const comparisonSelection = z.object({ baseline: sourceSelection, current: sourceSelection }).strict();
export const historyQuery = z.object({ limit: z.number().int().min(1).max(50), before: z.string().min(1).max(500).optional() }).strict();
export const contextId = resourceId;
