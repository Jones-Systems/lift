import { useCallback, useEffect, useRef } from 'react';
import { AccessibilityInfo, findNodeHandle, Platform, type View } from 'react-native';

type Measurable = Pick<View, 'measureInWindow'>;
export type CaptureFrame = { a11y_id: string; frame_pt: [number, number, number, number] };
const nodes = new Map<string, Measurable>();
const frames = new Map<string, CaptureFrame>();
export async function captureMarginFrames() {
  await Promise.all(Array.from(nodes, ([id, node]) => new Promise<void>((resolve) => {
    node.measureInWindow((x, y, width, height) => {
      if ([x,y,width,height].every(Number.isFinite)) frames.set(id, { a11y_id: id, frame_pt: [x,y,width,height] });
      resolve();
    });
  })));
  return { elements: Array.from(frames.values()) };
}
export function useFrame<T extends Measurable>(id?: string) {
  const node = useRef<T | null>(null);
  const ref = useCallback((value: T | null) => {
    node.current = value;
    if (id && value) nodes.set(id, value);
    else if (id) { nodes.delete(id); frames.delete(id); }
  }, [id]);
  const onLayout = useCallback(() => {
    if (id && node.current) node.current.measureInWindow((x,y,width,height) => {
      frames.set(id, { a11y_id: id, frame_pt: [x,y,width,height] });
    });
  }, [id]);
  useEffect(() => () => { if (id) { nodes.delete(id); frames.delete(id); } }, [id]);
  return { ref, onLayout };
}
export function installCaptureHook() {
  if (__DEV__) {
    (globalThis as typeof globalThis & { __FORM2_CAPTURE_FRAMES__?: typeof captureMarginFrames }).__FORM2_CAPTURE_FRAMES__ = captureMarginFrames;
  }
}

export function focusMarginElement(id: string) {
 const node=nodes.get(id);if(!node)return;
 if(Platform.OS==='web'){const element=node as Measurable & {focus?:()=>void};element.focus?.();return;}
 const handle=findNodeHandle(node as View);if(handle)AccessibilityInfo.setAccessibilityFocus(handle);
}
