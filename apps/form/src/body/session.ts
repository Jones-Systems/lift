// Memory-only manual body session: measurement constructs, validation, ratios and lifecycle.
// Pure: no React, native, storage, network or telemetry imports. Nothing here is serialized or sent anywhere;
// root must never copy this state into shared persistent app state, profile, plan or command payloads.
// Clearing drops references only; it is not a forensic or native zero-persistence guarantee.

/* ---------------- constructs ---------------- */

export type LengthUnit = 'cm' | 'mm';
export type Side = 'left' | 'right';
export type MeasuredBy = 'self' | 'helper' | 'professional';
export type Instrument = 'tape' | 'stadiometer' | 'other';

/**
 * Externally measured, protocol-defined lengths only. Deliberately absent: femur/thigh (a tape or photo cannot
 * observe skeletal femur endpoints), sitting height as "torso" (it includes head and neck), hip level, pelvic tilt
 * and posture. Adding a construct requires an explicit endpoint protocol, not a relabelled photo distance.
 */
export const CONSTRUCTS = {
  stature: {
    label: 'Standing height',
    endpoints: 'Floor to the top of the head, standing without shoes, looking straight ahead.',
    sided: false,
    protocol: 'form.body.manual.stature/1',
  },
  armSpan: {
    label: 'Arm span',
    endpoints: 'Fingertip to fingertip, arms straight out to the sides at shoulder height.',
    sided: false,
    protocol: 'form.body.manual.arm-span/1',
  },
  upperArm: {
    label: 'Upper arm',
    endpoints: 'Bony tip of the shoulder to the point of the elbow, elbow bent to a right angle.',
    sided: true,
    protocol: 'form.body.manual.upper-arm/1',
  },
  forearm: {
    label: 'Forearm',
    endpoints: 'Point of the elbow to the bony bump on the little-finger side of the wrist, elbow bent to a right angle.',
    sided: true,
    protocol: 'form.body.manual.forearm/1',
  },
} as const;

export type ConstructId = keyof typeof CONSTRUCTS;
export const CONSTRUCT_IDS = Object.keys(CONSTRUCTS) as ConstructId[];

/* ---------------- entries ---------------- */

export type MeasurementDraft = {
  construct: ConstructId | null;
  valueText: string;
  unit: LengthUnit;
  side: Side | null;
  measuredBy: MeasuredBy | null;
  instrument: Instrument | null;
};

export type ReportedMeasurement = {
  /** `${construct}:${side}`; one entry per construct and side. */
  id: string;
  construct: ConstructId;
  side: Side | null;
  entered: { value: number; unit: LengthUnit };
  /** Canonical whole millimetres, used only so ratios cancel units. */
  mm: number;
  provenance: {
    source: 'user_reported';
    measuredBy: MeasuredBy;
    instrument: Instrument | null;
    protocol: string;
    /** Form never checks a reported value. */
    verifiedByForm: false;
  };
  /** No validated uncertainty exists for self-reported lengths; never substitute a model score. */
  uncertainty: null;
};

export type DraftError =
  | 'construct_missing'
  | 'value_missing'
  | 'value_not_number'
  | 'value_not_positive'
  | 'value_too_precise'
  | 'value_too_large'
  | 'side_missing'
  | 'measured_by_missing';

/** Typo guard on entry, not a body range: 300 cm accepts any human length and rejects unit slips like 1750 cm. */
export const MAX_MM = 3000;

export const emptyDraft = (): MeasurementDraft => ({
  construct: null, valueText: '', unit: 'cm', side: null, measuredBy: null, instrument: null,
});

export const measurementId = (construct: ConstructId, side: Side | null) => `${construct}:${side ?? 'none'}`;

/** Digits with at most one decimal separator; rejects signs, exponents, Infinity and NaN text outright. */
const NUMBER = /^(\d+)(?:[.,](\d+))?$/;

export function parseLength(text: string, unit: LengthUnit): { ok: true; value: number; mm: number } | { ok: false; error: DraftError } {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, error: 'value_missing' };
  const match = NUMBER.exec(trimmed);
  if (!match) return { ok: false, error: /^-\s*\d/.test(trimmed) ? 'value_not_positive' : 'value_not_number' };
  const decimals = match[2]?.length ?? 0;
  // cm to one decimal and mm as whole numbers keep the canonical value an exact integer of millimetres.
  if (decimals > (unit === 'cm' ? 1 : 0)) return { ok: false, error: 'value_too_precise' };
  const value = Number(`${match[1]}.${match[2] ?? '0'}`);
  if (!Number.isFinite(value)) return { ok: false, error: 'value_not_number' };
  if (value <= 0) return { ok: false, error: 'value_not_positive' };
  const mm = unit === 'cm' ? Math.round(value * 10) : value;
  if (mm > MAX_MM) return { ok: false, error: 'value_too_large' };
  return { ok: true, value, mm };
}

export function validateDraft(draft: MeasurementDraft): { ok: true; measurement: ReportedMeasurement } | { ok: false; errors: DraftError[] } {
  const errors: DraftError[] = [];
  if (!draft.construct) errors.push('construct_missing');
  const parsed = parseLength(draft.valueText, draft.unit);
  if (!parsed.ok) errors.push(parsed.error);
  const sided = draft.construct ? CONSTRUCTS[draft.construct].sided : false;
  if (sided && !draft.side) errors.push('side_missing');
  if (!draft.measuredBy) errors.push('measured_by_missing');
  if (errors.length || !draft.construct || !parsed.ok || !draft.measuredBy) return { ok: false, errors };
  const side = sided ? draft.side : null;
  return {
    ok: true,
    measurement: {
      id: measurementId(draft.construct, side),
      construct: draft.construct,
      side,
      entered: { value: parsed.value, unit: draft.unit },
      mm: parsed.mm,
      provenance: {
        source: 'user_reported',
        measuredBy: draft.measuredBy,
        instrument: draft.instrument,
        protocol: CONSTRUCTS[draft.construct].protocol,
        verifiedByForm: false,
      },
      uncertainty: null,
    },
  };
}

export function draftFrom(measurement: ReportedMeasurement): MeasurementDraft {
  return {
    construct: measurement.construct,
    valueText: String(measurement.entered.value),
    unit: measurement.entered.unit,
    side: measurement.side,
    measuredBy: measurement.provenance.measuredBy,
    instrument: measurement.provenance.instrument,
  };
}

/* ---------------- ratios ---------------- */

/** Named numerator/denominator pairs of compatible external lengths. Sided pairs require the same side. */
export const RATIOS = {
  armSpanToStature: { label: 'Arm span ÷ standing height', numerator: 'armSpan', denominator: 'stature' },
  forearmToUpperArm: { label: 'Forearm ÷ upper arm', numerator: 'forearm', denominator: 'upperArm' },
} as const satisfies Record<string, { label: string; numerator: ConstructId; denominator: ConstructId }>;

export type RatioId = keyof typeof RATIOS;

export type RatioResult =
  | {
    status: 'computed';
    id: RatioId;
    side: Side | null;
    numerator: ReportedMeasurement;
    denominator: ReportedMeasurement;
    /** Dimensionless; describes two reported entries only. */
    value: number;
    uncertainty: null;
  }
  | { status: 'missing'; id: RatioId; side: Side | null; needs: ConstructId[] };

export function computeRatios(measurements: readonly ReportedMeasurement[]): RatioResult[] {
  const find = (construct: ConstructId, side: Side | null) =>
    measurements.find((m) => m.construct === construct && m.side === side) ?? null;
  const results: RatioResult[] = [];
  for (const id of Object.keys(RATIOS) as RatioId[]) {
    const def = RATIOS[id];
    const sided = CONSTRUCTS[def.numerator].sided;
    // Ratios never mix sides; a sided pair is reported per side that has at least one entry.
    const sides: (Side | null)[] = !sided ? [null]
      : (['left', 'right'] as const).filter((side) => find(def.numerator, side) || find(def.denominator, side));
    if (sided && sides.length === 0) sides.push(null);
    for (const side of sides) {
      const numerator = side === null && sided ? null : find(def.numerator, side);
      const denominator = side === null && sided ? null : find(def.denominator, side);
      const value = numerator && denominator && denominator.mm > 0 ? numerator.mm / denominator.mm : NaN;
      if (numerator && denominator && Number.isFinite(value) && value > 0) {
        results.push({ status: 'computed', id, side, numerator, denominator, value, uncertainty: null });
      } else {
        const needs = [def.numerator, def.denominator].filter((c) => !(c === def.numerator ? numerator : denominator));
        results.push({ status: 'missing', id, side, needs });
      }
    }
  }
  return results;
}

/** Two decimals: enough to read, not a claim of precision the inputs lack. */
export const formatRatio = (value: number) => value.toFixed(2);

export function formatLength(measurement: Pick<ReportedMeasurement, 'entered'>): string {
  const { value, unit } = measurement.entered;
  return `${unit === 'cm' ? value.toFixed(1) : String(value)} ${unit}`;
}

/* ---------------- session lifecycle ---------------- */

export type BodyRoute = 'overview' | 'purpose' | 'protocol' | 'measure' | 'results' | 'choices' | 'limits';
export type BodyEntry = 'overview' | 'choices';
export type CaptureView = 'front' | 'side';
export type ClearReason = 'close' | 'cancel' | 'background' | 'account_changed' | 'done';

/** Only the session-only choice exists; retained modes are absent until qualified, never a disabled default. */
export type ProcessingChoice = 'session_only';

export type ChecklistId =
  | 'one_person' | 'full_body' | 'camera_level' | 'even_light' | 'clothing' | 'stance' | 'front_facing' | 'side_facing';

export const CHECKLIST: Readonly<Record<CaptureView, readonly ChecklistId[]>> = Object.freeze({
  front: Object.freeze(['one_person', 'full_body', 'camera_level', 'even_light', 'clothing', 'stance', 'front_facing'] as const),
  side: Object.freeze(['one_person', 'full_body', 'camera_level', 'even_light', 'clothing', 'stance', 'side_facing'] as const),
});

export type BodySessionState = {
  accountId: string;
  /** Fences late callbacks: every clear or account change advances it, and stale actions are ignored. */
  generation: number;
  entry: BodyEntry;
  route: BodyRoute;
  processing: ProcessingChoice | null;
  view: CaptureView;
  checked: ChecklistId[];
  draft: MeasurementDraft;
  /** Measurement being edited, or null when adding. */
  editing: string | null;
  draftErrors: DraftError[];
  measurements: ReportedMeasurement[];
};

/** A user or lifecycle command; the caller stamps it with the generation it was rendered under. */
export type BodyCommand =
  | { type: 'navigate'; route: BodyRoute }
  | { type: 'choose_processing'; choice: ProcessingChoice }
  | { type: 'set_view'; view: CaptureView }
  | { type: 'toggle_check'; id: ChecklistId }
  | { type: 'edit_draft'; patch: Partial<MeasurementDraft> }
  | { type: 'commit_draft' }
  | { type: 'edit_measurement'; id: string }
  | { type: 'remove_measurement'; id: string }
  | { type: 'new_measurement' }
  | { type: 'clear'; reason: ClearReason };

export type BodyAction = BodyCommand & { generation: number };

/** Root signal, accepted at any generation: a different account always starts from nothing. */
export type BodyAccountAction = { type: 'account'; accountId: string };

export function createBodySession(accountId: string, entry: BodyEntry = 'overview', generation = 0): BodySessionState {
  return {
    accountId, generation, entry, route: entry, processing: null, view: 'front', checked: [],
    draft: emptyDraft(), editing: null, draftErrors: [], measurements: [],
  };
}

/** Routes that hold or collect session data require the explicit session-only choice first. */
const NEEDS_CHOICE: readonly BodyRoute[] = ['protocol', 'measure', 'results'];

export function canEnter(state: BodySessionState, route: BodyRoute): boolean {
  if (NEEDS_CHOICE.includes(route) && state.processing !== 'session_only') return false;
  if (route === 'results' && state.measurements.length === 0) return false;
  return true;
}

export function bodyReducer(state: BodySessionState, action: BodyAction | BodyAccountAction): BodySessionState {
  if (action.type === 'account') {
    return action.accountId === state.accountId ? state : createBodySession(action.accountId, state.entry, state.generation + 1);
  }
  if (action.generation !== state.generation) return state;
  switch (action.type) {
    case 'clear':
      return createBodySession(state.accountId, state.entry, state.generation + 1);
    case 'navigate':
      return canEnter(state, action.route) ? { ...state, route: action.route } : state;
    case 'choose_processing':
      return { ...state, processing: action.choice };
    case 'set_view':
      return { ...state, view: action.view };
    case 'toggle_check':
      return {
        ...state,
        checked: state.checked.includes(action.id) ? state.checked.filter((id) => id !== action.id) : [...state.checked, action.id],
      };
    case 'edit_draft': {
      const draft = { ...state.draft, ...action.patch };
      if (draft.construct && !CONSTRUCTS[draft.construct].sided) draft.side = null;
      return { ...state, draft, draftErrors: [] };
    }
    case 'new_measurement':
      return { ...state, draft: emptyDraft(), editing: null, draftErrors: [] };
    case 'commit_draft': {
      if (state.processing !== 'session_only') return state;
      const result = validateDraft(state.draft);
      if (!result.ok) return { ...state, draftErrors: result.errors };
      const kept = state.measurements.filter((m) => m.id !== result.measurement.id && m.id !== state.editing);
      return { ...state, measurements: [...kept, result.measurement], draft: emptyDraft(), editing: null, draftErrors: [] };
    }
    case 'edit_measurement': {
      const found = state.measurements.find((m) => m.id === action.id);
      return found ? { ...state, route: 'measure', draft: draftFrom(found), editing: found.id, draftErrors: [] } : state;
    }
    case 'remove_measurement': {
      const measurements = state.measurements.filter((m) => m.id !== action.id);
      const removedEdit = state.editing === action.id;
      const route = state.route === 'results' && measurements.length === 0 ? 'measure' : state.route;
      return {
        ...state, route, measurements, editing: removedEdit ? null : state.editing,
        draft: removedEdit ? emptyDraft() : state.draft, draftErrors: [],
      };
    }
  }
}

/** Where Back goes from the current page; 'close' clears the session and leaves the flow. */
export function previousRoute(state: BodySessionState): BodyRoute | 'close' {
  switch (state.route) {
    case 'overview': return 'close';
    case 'purpose': case 'limits': return 'overview';
    case 'protocol': return 'purpose';
    case 'measure': return state.measurements.length ? 'results' : 'protocol';
    case 'results': return 'measure';
    case 'choices': return state.entry === 'choices' ? 'close' : 'overview';
  }
}

/** True when the session holds anything a person entered. */
export const holdsSessionData = (state: BodySessionState) =>
  state.processing !== null || state.measurements.length > 0 || state.checked.length > 0 || state.draft.valueText !== ''
  || state.draft.construct !== null;
