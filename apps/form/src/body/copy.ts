// Body-lane copy. Pure strings so tests can check claims without rendering.
// Rules: describe reported inputs only; no diagnosis, ranges, percentiles, accuracy, confidence or plan changes.
// Unavailable features say why. Never claim photos were taken, checked or saved.
// Privacy claims stay scoped to these body screens (no save/upload, cleared on leave). Native/OS persistence
// (keyboard learning, app-switcher snapshots, crash reports) is unqualified, so never promise that nothing is kept.
import type { UnavailableReason } from './capabilities';
import type { ChecklistId, DraftError, Instrument, MeasuredBy } from './session';

export const BODY_COPY = {
  overview: {
    title: 'Body proportions',
    subtitle: 'Enter lengths you’ve measured and see simple ratios between them, for this session only. These screens don’t save or upload what you enter. Form hasn’t yet checked what your phone itself may keep, like keyboard suggestions.',
    availableHeading: 'Available now',
    manual: 'Enter your own measurements',
    manualDetail: 'Lengths you measured with a tape. Form shows them back to you and doesn’t check them.',
    checklist: 'Photo setup checklist',
    checklistDetail: 'Front and side setup steps, for your own reference.',
    unavailableHeading: 'Not available yet',
    limitsAction: 'What Form can’t measure',
    scope: 'These measurements don’t diagnose or treat anything, and they don’t change your plan.',
    continue: 'Continue',
    notNow: 'Not now',
  },
  purpose: {
    title: 'How should Form handle this session?',
    subtitle: 'Choose before you enter anything. Nothing is chosen for you.',
    sessionOnly: 'Use for this session',
    sessionOnlyDetail: 'What you enter stays on these screens and clears when you leave, switch accounts or Form goes to the background. These screens don’t save or upload it. Form hasn’t yet checked what your phone itself may keep, like keyboard suggestions or app previews.',
    unavailableHeading: 'Not available yet',
    saveMeasurements: 'Save measurements for progress',
    savePhotos: 'Save photos and measurements for progress',
    separateHeading: 'Separate choices',
    external: 'Send to an outside service',
    improve: 'Help improve Form',
    footnote: 'These are separate choices. Choosing one never turns on another.',
    continue: 'Continue',
  },
  protocol: {
    title: 'Photo setup',
    subtitle: 'Form can’t take photos yet, so nothing is taken here. Use these steps to set up the same way each time.',
    front: 'Front',
    side: 'Side',
    note: 'This checklist is for you. Form doesn’t look at photos or check your setup.',
    enter: 'Enter measurements',
    skip: 'Skip',
  },
  measure: {
    title: 'Add a measurement',
    editTitle: 'Edit measurement',
    subtitle: 'Use a measurement you took yourself or someone took for you. It stays on these screens for this session.',
    what: 'What did you measure?',
    value: 'Length',
    unit: 'Unit',
    side: 'Which side?',
    measuredBy: 'Who measured?',
    instrument: 'What with? (optional)',
    added: 'Added this session',
    add: 'Add measurement',
    save: 'Update measurement',
    remove: 'Remove this measurement',
    review: (n: number) => `Review ${n === 1 ? '1 measurement' : `${n} measurements`}`,
    skip: 'Skip for now',
    helper: 'Easier with someone helping.',
  },
  results: {
    title: 'Your measurements',
    eyebrow: 'Reported by you · not checked by Form',
    measurementsHeading: 'Measurements',
    ratiosHeading: 'Ratios',
    ratioDetail: 'No unit. Uncertainty not estimated.',
    needs: (labels: string[]) => `Add ${labels.join(' and ').toLowerCase()} to see this.`,
    meaning: 'These are your entries divided by each other. Form doesn’t compare them with other people, judge them, or use them to change your training.',
    ephemeral: 'These screens don’t save or upload your entries, and clear them when you leave. Form hasn’t yet checked what your phone itself may keep.',
    done: 'Done — clear and close',
    addAnother: 'Add another',
  },
  choices: {
    title: 'Body data choices',
    subtitle: 'Each choice is separate. None is on, because saving body data isn’t available yet.',
    session: 'Body sessions',
    sessionDetail: 'Form’s body screens don’t save or upload what you enter, and clear it when you leave. Form hasn’t yet checked what your phone itself may keep.',
    footnote: 'These are separate choices. Turning one on never turns on another.',
  },
  limits: {
    title: 'What Form can’t measure',
    subtitle: 'Some things can’t be measured reliably from photos or a tape measure. Form doesn’t estimate them.',
    items: [
      { title: 'Femur length', detail: 'The thigh bone’s ends are inside the body. A tape or photo measures skin and clothing, not bone.' },
      { title: 'Hip level and leg length differences', detail: 'Camera angle, stance, clothing and soft tissue change how hips look in a photo.' },
      { title: 'Pelvic tilt and posture', detail: 'Usual photo landmarks don’t include the pelvic points tilt is measured from, and pelvis shape itself differs from person to person.' },
      { title: 'Torso length', detail: 'Sitting height includes the head and neck, so it isn’t torso length.' },
      { title: 'Comparisons with other people', detail: 'Form doesn’t rank your proportions or call them long, short or unusual.' },
    ],
    close: 'Back',
  },
  covered: 'Hidden while Form isn’t in front.',
  cleared: 'Form cleared your entries from these screens when it went to the background.',
  close: 'Close',
} as const;

export const UNAVAILABLE_COPY: Record<UnavailableReason, string> = {
  no_memory_only_camera_path: 'Form can’t yet take a photo without the device saving a copy, so it doesn’t take photos.',
  no_qualified_method: 'No method has been tested for Form, so it doesn’t estimate lengths or angles from photos.',
  construct_not_observable: 'Photos and tape measurements can’t show these reliably, so Form doesn’t assess them.',
  no_qualified_storage_or_deletion: 'Form can’t yet store body data and fully delete it later, so these screens don’t offer saving.',
  not_offered: 'Not offered. These screens don’t send what you enter to outside services or use it to train Form’s systems.',
};

export const CAPABILITY_TITLES = {
  cameraCapture: 'Photo capture',
  automaticEstimates: 'Automatic estimates from photos',
  anatomicalAssessment: 'Femur length, hip level, pelvic tilt and posture',
  retainedMeasurements: 'Saving and progress history',
} as const;

export const CHECKLIST_COPY: Record<ChecklistId, string> = {
  one_person: 'Only you in the frame',
  full_body: 'Head to feet in view, nothing cut off',
  camera_level: 'Camera level and steady — propped up or held by someone else',
  even_light: 'Even light, and a plain background if you can',
  clothing: 'Fitted clothes you’re comfortable in. You don’t need to undress.',
  stance: 'Stand the way you usually do. Don’t force a posture.',
  front_facing: 'Face the camera with your arms relaxed a little away from your sides',
  side_facing: 'Turn side-on and note which side faces the camera',
};

export const DRAFT_ERROR_COPY: Record<DraftError, string> = {
  construct_missing: 'Choose what you measured.',
  value_missing: 'Enter the length.',
  value_not_number: 'Enter the length as a number, like 33.5.',
  value_not_positive: 'Enter a length greater than zero.',
  value_too_precise: 'Use up to one decimal place in cm, or whole numbers in mm.',
  value_too_large: 'That’s more than 300 cm. Check the number and the unit.',
  side_missing: 'Choose the side you measured.',
  measured_by_missing: 'Choose who measured.',
};

export const MEASURED_BY_COPY: Record<MeasuredBy, string> = {
  self: 'I did',
  helper: 'Someone helped',
  professional: 'A professional',
};

export const INSTRUMENT_COPY: Record<Instrument, string> = {
  tape: 'Tape measure',
  stadiometer: 'Height measure',
  other: 'Something else',
};

export const sideLabel = (side: 'left' | 'right' | null) => (side === 'left' ? 'Left' : side === 'right' ? 'Right' : '');
