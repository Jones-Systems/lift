import { NATIVE_MOVEMENT_CATALOG } from '../../catalog-qualification/native-identity.js';
import { freeze } from './normalization.js';

export const FALLBACK_POLICY = freeze({
  id: 'form-strength-fallback',
  revision: '1',
  source: {
    id: 'form-strength-fallback', revision: '1',
    locator: 'docs/planning/first-plan/fallback-policy.md', currentness: 'current' as const,
    qualification: 'accepted_operational_defaults_not_medical_clearance',
  },
  nativeCatalog: NATIVE_MOVEMENT_CATALOG,
  sources: [
    { repository: 'Jones-Systems/BusinessLessons', revision: '7636efca55195b1dc6a5980864452575478116b7',
      path: 'research/workout-app-2026-08-20/synthesis/training-system.md',
      locator: 'Template matrix, template B; Dose matrix; Equipment-equivalent substitutions' },
    { repository: 'Jones-Systems/movement-engine', revision: '442c5cd07f14142326af10fe0eb6d079b0e62a71',
      path: 'docs/decisions/DD-004-programming-defaults-adaptation.md', locator: 'Decision' },
    { repository: 'Jones-Systems/movement-engine', revision: '442c5cd07f14142326af10fe0eb6d079b0e62a71',
      path: 'src/movement_engine/generator.py', locator: 'dose constants and _prescription_for_slot' },
    { repository: 'Jones-Systems/movement-engine', revision: '442c5cd07f14142326af10fe0eb6d079b0e62a71',
      path: 'src/movement_engine/models.py', locator: 'Prescription.to_dict' },
  ],
  duration: { kind: 'estimated-range' as const, minMinutes: 15, maxMinutes: 25 },
  equipment: ['bodyweight', 'wall', 'machine'],
  recipe: [
    { exercise_id: 'bodyweight-squat', movement_pattern: 'knee_dominant', role: 'primary',
      sets: 2, rest_seconds: 150, rep_range: [6, 12] as [number, number], target_rir: 3 },
    { exercise_id: 'wall-push-up', movement_pattern: 'push', role: 'accessory',
      sets: 2, rest_seconds: 150, rep_range: [6, 12] as [number, number], target_rir: 3 },
    { exercise_id: 'chest-supported-machine-row', movement_pattern: 'pull', role: 'accessory',
      sets: 2, rest_seconds: 150, rep_range: [6, 12] as [number, number], target_rir: 3 },
    { exercise_id: 'dead-bug', movement_pattern: 'trunk', role: 'accessory',
      sets: 2, rest_seconds: 90, notes: ['controlled practice task; no rep target'] },
  ],
});
