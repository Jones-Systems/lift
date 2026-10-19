export const now = () => 1000;
export const identity = (accountId = 'account_a') => ({
  accountId, subject: `subject_${accountId}`, expiresAtMs: 2000,
  scopes: ['form:workouts:read', 'form:plans:read'],
});
export const item = () => ({ id: 'item_1', exerciseId: 'squat', setTarget: 3, repMin: 8, repMax: 10, targetKg: 20 });
export const plan = () => ({ id: 'plan_1', name: 'Synthetic plan', minutes: 30, revision: 1, archived: false, items: [item()] });
export const workout = () => ({
  id: 'workout_1', planId: 'plan_1', planRevision: 1, revision: 2,
  status: 'completed', startedAt: '2026-10-10T12:00:00.000Z', completedAt: '2026-10-10T12:30:00.000Z',
  occurrences: [{ id: 'occurrence_1', itemId: 'item_1', exerciseId: 'squat', position: 0, target: item() }],
  sets: [{ id: 'set_1', occurrenceId: 'occurrence_1', setNumber: 1, reps: 8, weightKg: 20, status: 'voided' }],
});
