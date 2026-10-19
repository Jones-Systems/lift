// Frame registry for capture and focus return. Elements register by their
// package a11y id (also their testID); frames are read fresh with measureInWindow
// and expressed in logical pt relative to the variant root, so a scaled web
// capture frame and a native window give the same numbers.
import { useCallback, useEffect } from 'react';
import { AccessibilityInfo, Platform, type View } from 'react-native';

type Measurable = Pick<View, 'measureInWindow'>;
type Rect = [number, number, number, number];
export type CaptureFrame = { a11y_id: string; frame_pt: Rect };

const nodes = new Map<string, Measurable>();
const cache = new Map<string, Rect>();
let root: { node: Measurable; width: number } | null = null;

function measure(node: Measurable): Promise<Rect | null> {
  return new Promise((resolve) => {
    try {
      node.measureInWindow((x, y, width, height) => {
        const rect: Rect = [x, y, width, height];
        resolve(rect.every(Number.isFinite) ? rect : null);
      });
    } catch {
      resolve(null);
    }
  });
}

const round = (value: number) => Math.round(value * 10) / 10;

export async function captureClubCircuitFrames(): Promise<{ elements: CaptureFrame[] }> {
  const origin = root ? await measure(root.node) : null;
  const scale = origin && root && root.width > 0 ? origin[2] / root.width : 1;
  const [ox, oy] = origin ?? [0, 0];
  const entries = await Promise.all(Array.from(nodes, async ([id, node]) => {
    const rect = (await measure(node)) ?? cache.get(id) ?? null;
    if (rect) cache.set(id, rect);
    return [id, rect] as const;
  }));
  const elements: CaptureFrame[] = [];
  for (const [id, rect] of entries) {
    if (!rect || (rect[2] === 0 && rect[3] === 0)) continue;
    elements.push({ a11y_id: id, frame_pt: [round((rect[0] - ox) / scale), round((rect[1] - oy) / scale), round(rect[2] / scale), round(rect[3] / scale)] });
  }
  return { elements };
}

/** Registers a host element under its a11y id; spread the result with testID={id}. */
export function useCapture(id?: string) {
  const ref = useCallback((node: Measurable | null) => {
    if (!id) return;
    if (node) nodes.set(id, node);
    else { nodes.delete(id); cache.delete(id); }
  }, [id]);
  const onLayout = useCallback(() => {
    const node = id ? nodes.get(id) : undefined;
    if (id && node) void measure(node).then((rect) => { if (rect) cache.set(id, rect); });
  }, [id]);
  useEffect(() => () => { if (id) { nodes.delete(id); cache.delete(id); } }, [id]);
  return { ref, onLayout };
}

/** The variant root anchors frame normalization; its layout width is the unscaled logical width. */
export function setCaptureRoot(node: Measurable | null, width: number) {
  root = node ? { node, width } : null;
}

export function installCaptureHook() {
  const scope = globalThis as typeof globalThis & { __FORM2_CAPTURE_FRAMES__?: typeof captureClubCircuitFrames };
  scope.__FORM2_CAPTURE_FRAMES__ = captureClubCircuitFrames;
  return () => {
    if (scope.__FORM2_CAPTURE_FRAMES__ === captureClubCircuitFrames) delete scope.__FORM2_CAPTURE_FRAMES__;
  };
}

/** Moves VoiceOver (native) or keyboard (web) focus to a registered element. */
export function focusElement(id: string | null | undefined) {
  const node = id ? nodes.get(id) : undefined;
  if (!node) return;
  if (Platform.OS === 'web') {
    (node as Measurable & { focus?: () => void }).focus?.();
    return;
  }
  AccessibilityInfo.sendAccessibilityEvent(node as Parameters<typeof AccessibilityInfo.sendAccessibilityEvent>[0], 'focus');
}
