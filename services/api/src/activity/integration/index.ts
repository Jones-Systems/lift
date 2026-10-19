import { DomainError } from '../../errors.js';
import { hasLifecycleSchema, suppressionAuthority } from '../../lifecycle/guards.js';
import type { AccountContext, LifecycleAdapter, LifecycleBindings } from '../../lifecycle/types.js';
import type { Sqlite } from '../../storage.js';
import { createActivityLifecycleAdapter } from '../lifecycle.js';
import { createActivityService, type ActivityService } from '../service.js';
import type { ActivityLifecycleControl, LegacyTrainingReader } from '../types.js';
import { createOwnerActivityRequestChannel, type OwnerActivityRequest } from './request-channel.js';

export { createLegacyTrainingReader } from './legacy-reader.js';
export type { OwnerActivityRequest } from './request-channel.js';
export type ActivityIntegration = Readonly<{
  service: ActivityService;
  openOwnerRequest(context: AccountContext): OwnerActivityRequest;
  lifecycleAdapter: LifecycleAdapter;
}>;
export function globalActivityExerciseKind(id: string): 'resistance' | null {
  switch (id) {
    case 'goblet-squat': case 'floor-press': case 'supported-row': case 'dumbbell-hinge': case 'calf-raise':
      return 'resistance';
    default: return null;
  }
}

// Does not mount routes, migrate storage, grant dataset eligibility, or register a second Activity adapter.
export function createActivityIntegration(input: Readonly<{
  db: Sqlite;
  lifecycle: LifecycleBindings;
  lifecycleControl: ActivityLifecycleControl;
  legacy?: LegacyTrainingReader;
  now?: () => Date;
}>): ActivityIntegration {
  if (!input.lifecycle?.assertActive || !input.lifecycle.withActiveWrite || !input.lifecycle.adultEligibility ||
    !input.lifecycleControl?.assertSuppression || !input.lifecycleControl.purgeReadiness)
    throw new DomainError(503, 'activity_bindings_required');
  const assertAuthority = (): void => {
    if (!hasLifecycleSchema(input.db)) throw new DomainError(503, 'activity_lifecycle_schema_required');
    suppressionAuthority(input.db);
  };
  const lifecycle: LifecycleBindings = {
    assertActive(context): void { assertAuthority(); input.lifecycle.assertActive(context); },
    withActiveWrite<T>(context: AccountContext, effect: () => T): T {
      assertAuthority();
      return input.lifecycle.withActiveWrite(context, () => {
        lifecycle.assertActive(context);
        const value = effect();
        lifecycle.assertActive(context);
        return value;
      });
    },
    adultEligibility(context) { lifecycle.assertActive(context); return input.lifecycle.adultEligibility(context); },
  };
  const channel = createOwnerActivityRequestChannel({ lifecycle, assertAuthority });
  const service = createActivityService({ db: input.db, lifecycle, lifecycleControl: input.lifecycleControl,
    assertPersistable: channel.assertPersistable, globalExerciseKind: globalActivityExerciseKind,
    ...(input.legacy === undefined ? {} : { legacy: input.legacy }), ...(input.now === undefined ? {} : { now: input.now }) });
  return Object.freeze({ service, openOwnerRequest: channel.openOwnerRequest,
    lifecycleAdapter: createActivityLifecycleAdapter(service) });
}
