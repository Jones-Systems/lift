import type { RegisteredBinding, RegistrationPin } from '../../catalog-qualification/registered-identity.js';
import { sourcePrescriptionPlanFields } from '../../schemas.js';
import { FALLBACK_POLICY } from './fallback-policy.js';
import { freeze, normalizeContext, sourceSchema } from './normalization.js';
import type { ContextConfirmation, Gap, PlanningContext, SourcePlanCandidate, SourceReference } from './types.js';

export { FALLBACK_POLICY } from './fallback-policy.js';
export type FallbackProductionRequest = {
  context: PlanningContext;
  confirmation: ContextConfirmation | null;
  policy: { qualification: 'qualified' | 'provisional'; source: SourceReference } | null;
  registration: { pin: RegistrationPin; bindings: readonly RegisteredBinding[] } | null;
};
export type FallbackProductionResult =
  | { status: 'produced'; candidate: SourcePlanCandidate }
  | { status: 'blocked'; gaps: Gap[] };

export function produceFallbackCandidate(request: FallbackProductionRequest): FallbackProductionResult {
  const blocked = (code: string): FallbackProductionResult => ({ status: 'blocked', gaps: [{ code }] });
  const context = normalizeContext(request.context, request.confirmation);
  if (context.status === 'blocked') return context;
  const policy = request.policy;
  const source = sourceSchema.safeParse(policy?.source);
  if (policy?.qualification !== 'qualified' || !source.success ||
    Object.entries(FALLBACK_POLICY.source).some(([field, value]) =>
      source.data[field as keyof SourceReference] !== value)) return blocked('fallback_policy_unavailable');
  if (FALLBACK_POLICY.equipment.some(equipment => !context.context.preferences.equipment.includes(equipment)))
    return blocked('fallback_equipment_unavailable');
  if (context.context.preferences.sessionMinutes < FALLBACK_POLICY.duration.maxMinutes)
    return blocked('fallback_time_exceeds_limit');
  const registration = request.registration;
  if (!registration || !Array.isArray(registration.bindings) || registration.bindings.length !== FALLBACK_POLICY.recipe.length)
    return blocked('fallback_registration_unavailable');
  try {
    const { pin, bindings } = registration;
    const identities = new Set<string>(), domainIds = new Set<string>();
    for (const binding of bindings) {
      if (binding.schema !== 'form.registered-native-binding/v1' || binding.status !== 'bound' ||
        binding.qualificationScope !== 'operational_identity_only')
        return blocked('fallback_registration_unavailable');
      const identity = binding.identity;
      if (identities.has(identity.nativeId) || domainIds.has(binding.exerciseId) ||
        !FALLBACK_POLICY.recipe.some(item => item.exercise_id === identity.nativeId) ||
        identity.repository !== FALLBACK_POLICY.nativeCatalog.repository || identity.revision !== FALLBACK_POLICY.nativeCatalog.revision ||
        identity.path !== FALLBACK_POLICY.nativeCatalog.path || identity.sha256 !== FALLBACK_POLICY.nativeCatalog.sha256 ||
        binding.variantId !== `movement-engine:${identity.revision}:${identity.nativeId}` ||
        binding.registration.id !== pin.id || binding.registration.revision !== pin.revision || binding.registration.digest !== pin.digest ||
        binding.catalogRevision !== pin.revision) return blocked('fallback_registration_mismatch');
      identities.add(identity.nativeId); domainIds.add(binding.exerciseId);
    }
    const plan = sourcePrescriptionPlanFields.safeParse({
      schema: 'form.source-prescription-plan/v1', name: 'Strength fallback',
      origin: { kind: 'form-adaptation', id: FALLBACK_POLICY.id, revision: FALLBACK_POLICY.revision },
      duration: FALLBACK_POLICY.duration,
      items: FALLBACK_POLICY.recipe.map(native => {
        const binding = bindings.find(item => item.status === 'bound' && item.identity.nativeId === native.exercise_id);
        if (!binding || binding.status !== 'bound') throw new Error('Missing exact binding');
        return {
          id: `fallback-${native.exercise_id}`, native,
          registeredDomain: { exerciseId: binding.exerciseId, variantId: binding.variantId, identity: binding.identity,
            registration: pin, recordDigest: binding.recordDigest },
          load: { kind: 'unspecified', basis: 'unknown' },
        };
      }),
    });
    if (!plan.success) return blocked('fallback_registration_invalid');
    return freeze({ status: 'produced', candidate: {
      id: 'form-strength-fallback-v1', qualification: policy.qualification, source: source.data, plan: plan.data,
    } });
  } catch {
    return blocked('fallback_registration_invalid');
  }
}
