// Shared-element continuity for custom routing (no navigator, so no sharedTransitionTag): a source registers
// a measurable view, the caller captures its window rect just before navigating, and the destination
// target FLIPs from that rect to its own while its contents fade in. Every failure (no provider, no or stale
// capture, zero-size or off-screen rects, measurement timeout) degrades to a plain fade. Nothing here hides
// the source, so there is nothing to restore; the only pointerEvents="none" view is the overlay ghost layer.
import {
  createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState,
  type ReactNode, type RefObject,
} from 'react';
import { Dimensions, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import Reanimated, { useAnimatedStyle, useSharedValue, withDelay, withSpring, withTiming } from 'react-native-reanimated';
import { fadeTiming, motionDuration, springConfig, timingConfig } from './motion';
import { useReduceMotion } from './motionProvider';

type Rect = { x: number; y: number; width: number; height: number };
type Capture = { rect: Rect; at: number; ghost: ReactNode };
type SourceEntry = { node: RefObject<View | null>; ghost: () => ReactNode };
type Flight = { key: number; ghost: ReactNode; from: Rect; to: Rect };

type ContinuityApi = {
  register: (id: string, entry: SourceEntry) => () => void;
  capture: (id: string) => Promise<boolean>;
  fresh: (id: string) => Capture | null;
  consume: (id: string) => void;
  clear: (id?: string) => void;
  fly: (capture: Capture, to: Rect) => void;
};

/** A capture older than this is ignored (the user has moved on; never fly to a stale rect). */
const CAPTURE_MAX_AGE_MS = 1500;
/** measureInWindow can fail to call back for unmounted or detached views; give up after this long. */
const MEASURE_TIMEOUT_MS = 250;
/** Notional flight length for staging the content fade and ghost removal (the spring has no fixed end). */
const FLIGHT_MS = motionDuration.page;
/** Destination content starts fading in at this fraction of the flight; the ghost is gone by GHOST_GONE_AT. */
const CONTENT_FADE_FROM = 0.35;
const GHOST_GONE_AT = 0.55;
/** Container-transform scale ratios outside this range look wrong; fade instead. */
const MIN_RATIO = 0.15;
const MAX_RATIO = 6.5;

const Context = createContext<ContinuityApi | null>(null);

const isRect = (rect: Rect) =>
  Number.isFinite(rect.x) && Number.isFinite(rect.y) && Number.isFinite(rect.width) && Number.isFinite(rect.height)
  && rect.width > 0 && rect.height > 0;

/** Window rect of a view, or null when unavailable, zero-size or the platform never answers. */
function measureNode(node: View | null | undefined): Promise<Rect | null> {
  return new Promise((resolve) => {
    if (!node || typeof node.measureInWindow !== 'function') {
      resolve(null);
      return;
    }
    let settled = false;
    const timer = setTimeout(() => finish(null), MEASURE_TIMEOUT_MS);
    const finish = (rect: Rect | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(rect);
    };
    try {
      node.measureInWindow((x, y, width, height) => {
        const rect = { x, y, width, height };
        finish(isRect(rect) ? rect : null);
      });
    } catch {
      finish(null);
    }
  });
}

function canFlip(from: Rect, to: Rect): boolean {
  if (!isRect(from) || !isRect(to)) return false;
  const ratios = [from.width / to.width, from.height / to.height];
  if (ratios.some((ratio) => ratio < MIN_RATIO || ratio > MAX_RATIO)) return false;
  const window = Dimensions.get('window');
  return from.x + from.width > 0 && from.y + from.height > 0 && from.x < window.width && from.y < window.height;
}

/**
 * Owns the source registry, captures and the ghost overlay. Mount once in the shell, around the routed
 * content; it renders a `flex: 1` container with a touch-transparent ghost layer on top.
 */
export function ContinuityProvider({ children }: { children?: ReactNode }) {
  const sources = useRef(new Map<string, SourceEntry>());
  const captures = useRef(new Map<string, Capture>());
  const overlay = useRef<View>(null);
  const flightKey = useRef(0);
  const [flights, setFlights] = useState<readonly Flight[]>([]);

  const api = useMemo<ContinuityApi>(() => ({
    register(id, entry) {
      sources.current.set(id, entry);
      return () => { if (sources.current.get(id) === entry) sources.current.delete(id); };
    },
    async capture(id) {
      const entry = sources.current.get(id);
      if (!entry) return false;
      const rect = await measureNode(entry.node.current);
      if (!rect) return false;
      captures.current.set(id, { rect, at: Date.now(), ghost: entry.ghost() });
      return true;
    },
    fresh(id) {
      const found = captures.current.get(id);
      if (!found) return null;
      if (Date.now() - found.at <= CAPTURE_MAX_AGE_MS) return found;
      captures.current.delete(id);
      return null;
    },
    consume(id) { captures.current.delete(id); },
    clear(id) {
      if (id === undefined) captures.current.clear();
      else captures.current.delete(id);
    },
    fly(capture, to) {
      void measureNode(overlay.current).then((origin) => {
        if (!origin) return;
        const shift = (rect: Rect): Rect => ({ ...rect, x: rect.x - origin.x, y: rect.y - origin.y });
        flightKey.current += 1;
        const flight = { key: flightKey.current, ghost: capture.ghost, from: shift(capture.rect), to: shift(to) };
        setFlights((current) => [...current, flight]);
      });
    },
  }), []);

  const land = (key: number) => setFlights((current) => current.filter((flight) => flight.key !== key));

  return (
    <Context.Provider value={api}>
      <View style={styles.root} collapsable={false}>
        {children}
        <View ref={overlay} collapsable={false} style={[StyleSheet.absoluteFill, styles.overlay]}>
          {flights.map((flight) => <GhostFlight key={flight.key} flight={flight} onDone={() => land(flight.key)} />)}
        </View>
      </View>
    </Context.Provider>
  );
}

/** Lightweight copy of the source flying to the target rect, fading out over the first part of the flight. */
function GhostFlight({ flight, onDone }: { flight: Flight; onDone: () => void }) {
  const { from, to } = flight;
  const progress = useSharedValue(0);
  const opacity = useSharedValue(1);
  const dx = to.x + to.width / 2 - (from.x + from.width / 2);
  const dy = to.y + to.height / 2 - (from.y + from.height / 2);
  const sx = to.width / from.width;
  const sy = to.height / from.height;

  useEffect(() => {
    progress.value = withSpring(1, springConfig('morph', false));
    opacity.value = withTiming(0, timingConfig(Math.round(FLIGHT_MS * GHOST_GONE_AT), false));
    const timer = setTimeout(onDone, FLIGHT_MS);
    return () => clearTimeout(timer);
  }, []);

  const style = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [
      { translateX: dx * progress.value },
      { translateY: dy * progress.value },
      { scaleX: 1 + (sx - 1) * progress.value },
      { scaleY: 1 + (sy - 1) * progress.value },
    ],
  }));
  return (
    <Reanimated.View
      style={[{ position: 'absolute', left: from.x, top: from.y, width: from.width, height: from.height }, style]}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {flight.ghost}
    </Reanimated.View>
  );
}

/**
 * Registers a measurable view under `id` so the caller can capture its rect before navigating. `ghost` is an
 * optional lightweight copy that flies in the overlay; without it only the target container moves.
 */
export function ContinuitySource({ id, children, style, testID, ghost }: {
  id: string;
  children?: ReactNode;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  ghost?: ReactNode;
}) {
  const api = useContext(Context);
  const node = useRef<View>(null);
  const latestGhost = useRef(ghost);
  latestGhost.current = ghost;
  useEffect(() => api?.register(id, { node, ghost: () => latestGhost.current }), [api, id]);
  return <View ref={node} collapsable={false} testID={testID} style={style}>{children}</View>;
}

/** What a target did on mount: `flip` from a captured source rect, or a plain `fade`. */
export type ContinuityMode = 'flip' | 'fade';

/**
 * Destination of a continuity transition. On mount it consumes a fresh capture for `id` (at most 1500 ms old,
 * used once), measures itself and FLIPs its container from the source rect with the `morph` spring while its
 * contents fade in from ~35% of the flight; a registered ghost flies in the overlay at the same time. Without a
 * provider, a usable capture or valid rects it fades in instead; Reduce Motion always fades. Children are
 * wrapped in a content view (style it with `contentStyle`). `onTransition` reports which mode ran.
 */
export function ContinuityTarget({ id, children, style, contentStyle, testID, onTransition }: {
  id: string;
  children?: ReactNode;
  style?: StyleProp<ViewStyle>;
  contentStyle?: StyleProp<ViewStyle>;
  testID?: string;
  onTransition?: (mode: ContinuityMode) => void;
}) {
  const api = useContext(Context);
  const reduce = useReduceMotion();
  const probe = useRef<View>(null);
  const opacity = useSharedValue(0);
  const content = useSharedValue(0);
  const progress = useSharedValue(1);
  const dx = useSharedValue(0);
  const dy = useSharedValue(0);
  const sx = useSharedValue(1);
  const sy = useSharedValue(1);
  const report = useRef(onTransition);
  report.current = onTransition;

  useLayoutEffect(() => {
    let cancelled = false;
    const fade = () => {
      content.value = 1;
      opacity.value = withTiming(1, fadeTiming(reduce, motionDuration.quick));
      report.current?.('fade');
    };
    const capture = api?.fresh(id) ?? null;
    if (!api || !capture || reduce) {
      if (capture) api?.consume(id);
      fade();
      return undefined;
    }
    const run = async () => {
      const to = await measureNode(probe.current);
      if (cancelled) return;
      api.consume(id);
      if (!to || !canFlip(capture.rect, to)) {
        fade();
        return;
      }
      const from = capture.rect;
      dx.value = from.x + from.width / 2 - (to.x + to.width / 2);
      dy.value = from.y + from.height / 2 - (to.y + to.height / 2);
      sx.value = from.width / to.width;
      sy.value = from.height / to.height;
      progress.value = 0;
      content.value = 0;
      opacity.value = 1;
      progress.value = withSpring(1, springConfig('morph', false));
      content.value = withDelay(
        Math.round(FLIGHT_MS * CONTENT_FADE_FROM),
        withTiming(1, fadeTiming(false, Math.round(FLIGHT_MS * (1 - CONTENT_FADE_FROM)))),
      );
      if (capture.ghost) api.fly(capture, to);
      report.current?.('flip');
    };
    run().catch(() => { if (!cancelled) fade(); });
    return () => { cancelled = true; };
  }, []);

  const containerStyle = useAnimatedStyle(() => {
    const remaining = 1 - progress.value;
    return {
      opacity: opacity.value,
      transform: [
        { translateX: dx.value * remaining },
        { translateY: dy.value * remaining },
        { scaleX: 1 + (sx.value - 1) * remaining },
        { scaleY: 1 + (sy.value - 1) * remaining },
      ],
    };
  });
  const contentFade = useAnimatedStyle(() => ({ opacity: content.value }));

  return (
    <Reanimated.View testID={testID} style={[style, containerStyle]}>
      <View ref={probe} collapsable={false} testID={testID ? `${testID}-probe` : undefined} style={StyleSheet.absoluteFill} />
      <Reanimated.View style={[styles.content, contentStyle, contentFade]}>{children}</Reanimated.View>
    </Reanimated.View>
  );
}

/**
 * Capture and clear for the caller that navigates. `capture(id)` measures the registered source now and
 * resolves false when it is unavailable; `clear` drops one or all captures. Safe outside a provider (it
 * resolves false and does nothing) and never throws.
 */
export function useContinuity(): { capture: (id: string) => Promise<boolean>; clear: (id?: string) => void } {
  const api = useContext(Context);
  return useMemo(() => ({
    capture: async (id: string) => {
      try {
        return api ? await api.capture(id) : false;
      } catch {
        return false;
      }
    },
    clear: (id?: string) => {
      try {
        api?.clear(id);
      } catch {
        // Clearing is best effort.
      }
    },
  }), [api]);
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  overlay: { pointerEvents: 'none' },
  content: { flexGrow: 1 },
});
