// Pure toast queue logic: timing defaults, dedupe by key, the visible window and the swipe decision.
// No React Native imports so it can be unit-tested directly; toast.tsx owns rendering and motion.
import type { IconName } from './icons';
import type { HapticIntent } from './motion';

export type ToastTone = 'info' | 'success' | 'warning' | 'error';
export type ToastDismissReason = 'timeout' | 'swipe' | 'close' | 'action' | 'replaced' | 'overflow' | 'programmatic';

export type ToastAction = { label: string; onPress: () => void; icon?: IconName };

/** Newest toasts are on top; older transient ones are dropped (or persistent ones queued) past this count. */
export const TOAST_MAX_VISIBLE = 3;

/** Default display times per tone in ms. Mirrors motionDuration.toast*; a unit test keeps them in sync. */
export const TOAST_DURATION = { info: 4000, success: 3600, warning: 6000, error: 7000, actionMin: 10000 } as const;

/** Swipe commit thresholds: distance in points, velocity in points per second. */
export const TOAST_SWIPE = { distance: 45, velocity: 110 } as const;

/** A resumed countdown never restarts below this, so a brief touch cannot cut the toast short. */
export const TOAST_RESUME_MIN_MS = 800;

export type ToastTiming = { persistent: boolean; durationMs: number | null };

/**
 * Persistent toasts stay until acted on: explicit `persistent`, else an error/warning that carries an action.
 * Otherwise the display time is the explicit duration or the tone default, never below `actionMin` when an
 * action is attached so there is time to reach it. A non-positive explicit duration means persistent.
 */
export function resolveToastTiming(opts: {
  tone: ToastTone; action?: unknown; persistent?: boolean; durationMs?: number;
}): ToastTiming {
  const hasAction = !!opts.action;
  const persistent = opts.persistent
    ?? (opts.durationMs !== undefined && opts.durationMs <= 0 ? true : hasAction && (opts.tone === 'error' || opts.tone === 'warning'));
  if (persistent) return { persistent: true, durationMs: null };
  const base = opts.durationMs !== undefined && opts.durationMs > 0 ? opts.durationMs : TOAST_DURATION[opts.tone];
  return { persistent: false, durationMs: hasAction ? Math.max(base, TOAST_DURATION.actionMin) : base };
}

export type ToastRecord = {
  id: string;
  /** Same key = same logical toast: a later show updates it in place. */
  key?: string;
  tone: ToastTone;
  title: string;
  body?: string;
  persistent: boolean;
  durationMs: number | null;
  /** Bumps on every in-place update; the card restarts its timer and re-announces when it changes. */
  version: number;
  action?: ToastAction;
  icon?: IconName;
  haptic?: HapticIntent;
  testID?: string;
  onDismiss?: (id: string, reason: ToastDismissReason) => void;
  /** Set once dismissal starts; the card plays its exit and the host then sends `remove`. */
  leaving?: ToastDismissReason;
  /** Explicit timing inputs, kept so an update can re-resolve the defaults. */
  timingInput?: { persistent?: boolean; durationMs?: number };
};

export type ToastInput = Omit<ToastRecord, 'persistent' | 'durationMs' | 'version' | 'leaving' | 'timingInput'>
  & { persistent?: boolean; durationMs?: number };

export type ToastState = {
  /** Newest first. Leaving records stay until `remove` so their exit can play. */
  visible: readonly ToastRecord[];
  /** Persistent toasts waiting for a free slot, oldest first. */
  queue: readonly ToastRecord[];
};

export const initialToastState: ToastState = { visible: [], queue: [] };

export type ToastEvent =
  | { type: 'show'; toast: ToastInput }
  | { type: 'update'; id: string; patch: Partial<ToastInput> }
  | { type: 'dismiss'; id: string; reason?: ToastDismissReason }
  | { type: 'remove'; id: string }
  | { type: 'clear'; reason?: ToastDismissReason };

const live = (list: readonly ToastRecord[]) => list.filter((item) => !item.leaving);

function build(input: ToastInput, version: number): ToastRecord {
  const { persistent, durationMs, ...rest } = input;
  const timingInput = { ...(persistent === undefined ? null : { persistent }), ...(durationMs === undefined ? null : { durationMs }) };
  return { ...rest, ...resolveToastTiming({ tone: input.tone, action: input.action, ...timingInput }), version, timingInput };
}

function merge(record: ToastRecord, patch: Partial<ToastInput>): ToastRecord {
  const { persistent, durationMs, ...rest } = patch;
  const timingInput = {
    ...record.timingInput,
    ...(persistent === undefined ? null : { persistent }),
    ...(durationMs === undefined ? null : { durationMs }),
  };
  const next = { ...record, ...rest, id: record.id, timingInput };
  return { ...next, ...resolveToastTiming({ tone: next.tone, action: next.action, ...timingInput }), version: record.version + 1 };
}

/** Fill free slots from the queue; promoted toasts go on top because they are the newest. */
function promote(state: ToastState): ToastState {
  let visible = state.visible;
  let queue = state.queue;
  while (queue.length > 0 && live(visible).length < TOAST_MAX_VISIBLE) {
    visible = [queue[0], ...visible];
    queue = queue.slice(1);
  }
  return visible === state.visible && queue === state.queue ? state : { visible, queue };
}

function mark(list: readonly ToastRecord[], id: string, reason: ToastDismissReason): readonly ToastRecord[] {
  return list.map((item) => (item.id === id && !item.leaving ? { ...item, leaving: reason } : item));
}

export function toastReducer(state: ToastState, action: ToastEvent): ToastState {
  switch (action.type) {
    case 'show': {
      const { toast } = action;
      const match = toast.key === undefined ? undefined
        : [...state.visible, ...state.queue].find((item) => item.key === toast.key && !item.leaving);
      if (match) {
        const replace = (list: readonly ToastRecord[]) => list.map((item) => (item.id === match.id ? build({ ...toast, id: match.id }, item.version + 1) : item));
        return { visible: replace(state.visible), queue: replace(state.queue) };
      }
      const record = build(toast, 1);
      if (live(state.visible).length < TOAST_MAX_VISIBLE) return { ...state, visible: [record, ...state.visible] };
      // Full window: drop the oldest transient toast, or hold the new one back when every slot is persistent.
      const victim = [...state.visible].reverse().find((item) => !item.leaving && !item.persistent);
      if (!victim) return { ...state, queue: [...state.queue, record] };
      return { ...state, visible: [record, ...mark(state.visible, victim.id, 'overflow')] };
    }
    case 'update': {
      const apply = (list: readonly ToastRecord[]) => list.map((item) => (item.id === action.id && !item.leaving ? merge(item, action.patch) : item));
      return { visible: apply(state.visible), queue: apply(state.queue) };
    }
    case 'dismiss': {
      const reason = action.reason ?? 'programmatic';
      return promote({ visible: mark(state.visible, action.id, reason), queue: state.queue.filter((item) => item.id !== action.id) });
    }
    case 'remove':
      return promote({ visible: state.visible.filter((item) => item.id !== action.id), queue: state.queue.filter((item) => item.id !== action.id) });
    case 'clear': {
      const reason = action.reason ?? 'programmatic';
      return { visible: state.visible.map((item) => (item.leaving ? item : { ...item, leaving: reason })), queue: [] };
    }
  }
}

/** Toasts to show: live ones only, newest first, at most TOAST_MAX_VISIBLE. */
export function visibleToasts(state: ToastState): ToastRecord[] {
  return live(state.visible).slice(0, TOAST_MAX_VISIBLE);
}

/** What the host renders: the visible window plus toasts still playing their exit, newest first. */
export function renderedToasts(state: ToastState): readonly ToastRecord[] {
  return state.visible;
}

export function findToast(state: ToastState, id: string): ToastRecord | undefined {
  return [...state.visible, ...state.queue].find((item) => item.id === id);
}

export function findToastByKey(state: ToastState, key: string): ToastRecord | undefined {
  return [...state.visible, ...state.queue].find((item) => item.key === key && !item.leaving);
}

/** Records that started leaving between two states, plus queued ones removed outright (never shown). */
export function newlyDismissed(before: ToastState, after: ToastState): { record: ToastRecord; reason: ToastDismissReason }[] {
  const out: { record: ToastRecord; reason: ToastDismissReason }[] = [];
  for (const item of [...before.visible, ...before.queue]) {
    if (item.leaving) continue;
    const next = findToast(after, item.id);
    if (next?.leaving) out.push({ record: item, reason: next.leaving });
    else if (!next) out.push({ record: item, reason: 'programmatic' });
  }
  return out;
}

export type SwipeEdge = 'top' | 'bottom';
export type SwipeResult = { axis: 'x' | 'y'; sign: -1 | 1 } | null;

/**
 * Commit decision for a release: horizontal either way, plus toward the screen edge the stack hangs from.
 * Distance (points) or velocity (points per second) past the threshold commits; the larger axis wins.
 */
export function resolveSwipe(edge: SwipeEdge, dx: number, dy: number, vx: number, vy: number): SwipeResult {
  const toEdge = edge === 'top' ? -1 : 1;
  const x = Math.abs(dx) >= TOAST_SWIPE.distance || Math.abs(vx) >= TOAST_SWIPE.velocity;
  const y = dy * toEdge >= TOAST_SWIPE.distance || vy * toEdge >= TOAST_SWIPE.velocity;
  if (x && (!y || Math.abs(dx) >= Math.abs(dy))) return { axis: 'x', sign: (dx !== 0 ? Math.sign(dx) : Math.sign(vx)) < 0 ? -1 : 1 };
  if (y) return { axis: 'y', sign: toEdge };
  return null;
}
