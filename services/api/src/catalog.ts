// Names/IDs only are imported; historical fixture history and clinical claims are excluded.
const provenance = {
  source: 'apps/form/src/variants/a/generatedfixtures.ts',
  variant: 'a/v2 Open Mat',
  revision: '9d3523697a0d1348c7a68e2178f4d1ec0d7813f0',
  qualification: 'Open Mat retained general-fitness names; not clinical guidance',
};
export const catalogSeed = [
  ['goblet-squat', 'Goblet squat', 'One dumbbell', 'squat'],
  ['floor-press', 'Dumbbell floor press', 'Each dumbbell', 'press'],
  ['supported-row', 'One-arm dumbbell row', 'Each side; one dumbbell', 'row'],
  ['dumbbell-hinge', 'Dumbbell Romanian deadlift', 'Each dumbbell', 'hinge'],
  ['calf-raise', 'Standing calf raise', 'Bodyweight; added weight', 'calf'],
].map(([id, name, loadLabel, sourceItemId]) => ({
  id: id!, name: name!, loadLabel: loadLabel!, retired: false, provenance: { ...provenance, sourceItemId },
  requiredConstraints: [{ id: 'comfortable-range', text: 'Use a controlled range you can perform comfortably.', required: true }],
  cues: [
    { id: 'controlled-tempo', text: 'Move with control.', required: false },
    { id: 'steady-setup', text: 'Pause to check your setup between sets.', required: false },
  ],
}));
export type Exercise = typeof catalogSeed[number];
