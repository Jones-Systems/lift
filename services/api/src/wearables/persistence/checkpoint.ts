import type { Metric, WearableStore } from '../types.js';
import { fail, instant, integer, text } from '../validation.js';
import type { HealthKitCheckpoint, HealthKitCheckpointBinding, HealthKitType, WearablePersistenceDependencies } from './types.js';

const emittedMetrics: Record<HealthKitType, readonly Metric[]> = {
  steps: ['steps'], activeEnergy: ['active_energy'], restingHeartRate: ['resting_hr'],
  hrvSdnn: ['hrv_sdnn'], sleep: ['sleep_asleep','sleep_in_bed'], bodyMass: ['body_mass'],
  workouts: ['workout_duration','workout_energy','workout_distance'],
};

export function createHealthKitCheckpoint(deps: WearablePersistenceDependencies, store: WearableStore,
  input: HealthKitCheckpointBinding): HealthKitCheckpoint {
  const bound=structuredClone(input);
  const ctx=Object.freeze(bound.ctx);
  const {connectionId,generation,type,from,to}=bound;
  function check() {
    deps.lifecycle.assertActive(ctx);
    deps.assertImportAllowed(ctx,'healthkit');
    text(connectionId);integer(generation);
    if(!Object.hasOwn(emittedMetrics,type))fail('health_invalid_type');
    instant(from);instant(to);
    if(Date.parse(from)>Date.parse(to))fail('health_invalid_window');
    const connection=store.connection(ctx,connectionId);
    if(!connection)fail('health_not_found',404);
    if(connection.generation!==generation)fail('health_connection_changed',409);
    if(connection.provider!=='healthkit')fail('health_route_mismatch',403);
    if(!connection.connected||!connection.retentionConsent)fail('health_consent_required',403);
    // Native queries have no metric subset; every metric emitted by the selected type needs consent.
    if(emittedMetrics[type].some(metric=>!connection.types.includes(metric)))fail('health_type_not_consented',403);
    deps.lifecycle.assertActive(ctx);
  }
  return {
    read() {
      check();
      const stream=JSON.stringify(['healthkit-v1',type,from,to]);
      const cursor=store.cursor(ctx,connectionId,generation,stream);
      check();
      // A committed cursor neither identifies its originating session nor reconciles an unknown page/key.
      return {stream,cursor};
    },
  };
}
