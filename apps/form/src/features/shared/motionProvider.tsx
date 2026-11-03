// Live Reduce Motion state for every shared motion primitive. Built on observeSystemMotion (a later
// system event always wins over the initial query) and seeded with Reanimated's launch-time reading,
// so the first frame already knows the setting on native. An unresolved reading uses the static
// equivalent, matching resolvePresentationPolicy. Screens call useReduceMotion(); never the OS directly.
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { AccessibilityInfo } from 'react-native';
import * as Reanimated from 'react-native-reanimated';
import { observeSystemMotion } from '../../integration/systemMotion';

/** Reanimated's synchronous launch-time reading (a module constant there), or null when unavailable. */
const launchReading: boolean | null = (() => {
  const read = (Reanimated as { useReducedMotion?: () => boolean }).useReducedMotion;
  try {
    return typeof read === 'function' ? read() : null;
  } catch {
    return null;
  }
})();

export type MotionState = Readonly<{
  /** True when travel must be replaced by instant or opacity-only changes. */
  reduceMotion: boolean;
  /** False until the system setting has been read; unresolved readings behave as reduced. */
  resolved: boolean;
}>;

const MotionContext = createContext<MotionState | null>(null);

function useSystemMotionState(active: boolean): MotionState {
  const [system, setSystem] = useState<boolean | null>(launchReading);
  useEffect(() => {
    if (!active) return undefined;
    // observeSystemMotion first reports null (unknown); keep the launch reading until a real value arrives.
    return observeSystemMotion(AccessibilityInfo, (value) => setSystem((previous) => value ?? previous));
  }, [active]);
  return useMemo(() => ({ reduceMotion: system ?? true, resolved: system !== null }), [system]);
}

/**
 * Provides one live Reduce Motion subscription to a subtree. Mount once per shell. `reduceMotion` forces
 * a value (gallery demos and tests); omit it in product code.
 */
export function MotionProvider({ children, reduceMotion }: { children: ReactNode; reduceMotion?: boolean }) {
  const parent = useContext(MotionContext);
  const system = useSystemMotionState(reduceMotion === undefined && parent === null);
  const value = useMemo<MotionState>(() => {
    if (reduceMotion !== undefined) return { reduceMotion, resolved: true };
    return parent ?? system;
  }, [reduceMotion, parent, system]);
  return <MotionContext.Provider value={value}>{children}</MotionContext.Provider>;
}

/** Live motion state; works without a provider (it then owns its own subscription). */
export function useMotionState(): MotionState {
  const context = useContext(MotionContext);
  const own = useSystemMotionState(context === null);
  return context ?? own;
}

/** True when the OS Reduce Motion setting is on (or not yet known). Instant or opacity-only changes then. */
export function useReduceMotion(): boolean {
  return useMotionState().reduceMotion;
}
