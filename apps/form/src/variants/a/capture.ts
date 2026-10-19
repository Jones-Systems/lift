// Frame registry for capture and focus return. Elements register by their package
// a11y id (also their testID). Frames are measured fresh with measureInWindow on the
// actual host views and expressed in logical pt relative to the variant root, so a
// scaled web capture frame and a native window give the same numbers. Nothing is cached
// or estimated: an element that cannot be measured now is omitted.
import { useCallback, useEffect, useRef } from 'react';
import { AccessibilityInfo, findNodeHandle, Platform, type View } from 'react-native';

type Measurable = Pick<View, 'measureInWindow'>;
type Rect = [number, number, number, number];
export type CaptureFrame = { a11y_id: string; frame_pt: Rect };

const nodes = new Map<string, Measurable>();
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

export async function captureOpenMatFrames(): Promise<{ elements: CaptureFrame[] }> {
  const origin = root ? await measure(root.node) : null;
  const scale = origin && root && root.width > 0 ? origin[2] / root.width : 1;
  const [ox, oy] = origin ?? [0, 0];
  const entries = await Promise.all(Array.from(nodes, async ([id, node]) => [id, await measure(node)] as const));
  const elements: CaptureFrame[] = [];
  for (const [id, rect] of entries) {
    if (!rect || (rect[2] === 0 && rect[3] === 0)) continue;
    elements.push({
      a11y_id: id,
      frame_pt: [round((rect[0] - ox) / scale), round((rect[1] - oy) / scale), round(rect[2] / scale), round(rect[3] / scale)],
    });
  }
  return { elements };
}

/**
 * Registers a host element under its a11y id; spread `ref` and set testID={id}.
 * Unregistration only removes the entry this ref owns, so a remounted element with the
 * same id is never dropped by its predecessor's cleanup.
 */
export function useCapture(id?: string): (node: Measurable | null) => void {
  const owned = useRef<Measurable | null>(null);
  const ref = useCallback((node: Measurable | null) => {
    if (!id) return;
    if (node) {
      owned.current = node;
      nodes.set(id, node);
    } else if (owned.current && nodes.get(id) === owned.current) {
      nodes.delete(id);
      owned.current = null;
    }
  }, [id]);
  useEffect(() => () => {
    if (id && owned.current && nodes.get(id) === owned.current) nodes.delete(id);
  }, [id]);
  return ref;
}

/** The variant root anchors frame normalization; its layout width is the unscaled logical width. */
export function setCaptureRoot(node: Measurable | null, width: number) {
  root = node ? { node, width } : null;
}

/** Installs globalThis.__FORM2_CAPTURE_FRAMES__; the cleanup removes it only if it is still ours. */
export function installCaptureHook() {
  const scope = globalThis as typeof globalThis & { __FORM2_CAPTURE_FRAMES__?: typeof captureOpenMatFrames };
  scope.__FORM2_CAPTURE_FRAMES__ = captureOpenMatFrames;
  return () => {
    if (scope.__FORM2_CAPTURE_FRAMES__ === captureOpenMatFrames) delete scope.__FORM2_CAPTURE_FRAMES__;
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
  const handle = findNodeHandle(node as unknown as View);
  if (handle) AccessibilityInfo.setAccessibilityFocus(handle);
}
