import type { GroupedEquipmentRequirements } from '../planning/constraints/index.js';
import { NATIVE_MOVEMENT_CATALOG, type NativeMovementCatalog } from './native-identity.js';
import { freeze, requireValue } from './validation.js';

/** Projects authenticated native metadata only; operational acceptance remains independently owned. */
export function projectNativeEquipmentRequirements(
  catalog: NativeMovementCatalog, nativeId: string,
): GroupedEquipmentRequirements | null {
  const variant = catalog.get(nativeId);
  if (variant === null) return null;
  requireValue(variant.qualification === 'source_native_operational_identity' &&
    variant.identity.nativeId === nativeId &&
    (['repository', 'revision', 'path', 'sha256'] as const)
      .every(key => variant.identity[key] === NATIVE_MOVEMENT_CATALOG[key]) &&
    variant.variantId === `movement-engine:${variant.identity.revision}:${nativeId}`,
  'invalid_request', 'native equipment identity mismatch');
  return freeze<GroupedEquipmentRequirements>({
    schema: 'form.equipment-requirements/v1',
    required: [...variant.equipment.required],
    alternatives: variant.equipment.alternatives.map(group => [...group]),
    native: { identity: { ...variant.identity }, variantId: variant.variantId,
      qualification: 'source_native_operational_identity' },
    operationalSource: null,
  });
}
