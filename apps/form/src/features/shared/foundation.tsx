// Shell-level foundation: one provider for the motion preference, toasts and Today→Workout continuity, and
// the route-stack transition container. The account shell mounts both, so signed-out, onboarding and
// signed-in screens share one toast host. Screens import these through `./ui`.
import { useEffect, useRef, type ReactNode } from 'react';
import type { StyleProp, ViewStyle } from 'react-native';
import { ContinuityProvider } from './motionContinuity';
import { MotionProvider } from './motionProvider';
import { StackTransition, useStackDirection } from './motionTransitions';
import { ToastProvider, useToast } from './toast';

type ScopeKey = string | number | null | undefined;

/** Clears every toast when the scope changes, so one account session's messages and actions never reach the next. */
function ToastScope({ scopeKey }: { scopeKey: ScopeKey }) {
  const toast = useToast();
  const previous = useRef(scopeKey);
  useEffect(() => {
    if (Object.is(previous.current, scopeKey)) return;
    previous.current = scopeKey;
    toast.clear();
  }, [scopeKey, toast]);
  return null;
}

/**
 * Motion preference + toast host + continuity overlay, mounted once at the shell root. Render it as the same
 * root element in every shell phase so toasts survive phase changes; change `scopeKey` (the account session)
 * to drop toasts that belong to the previous session. `reduceMotion` overrides the system value (tests, gallery).
 */
export function FoundationProvider({ children, scopeKey, reduceMotion, toastPlacement, toastBottomOffset }: {
  children: ReactNode;
  scopeKey?: ScopeKey;
  reduceMotion?: boolean;
  toastPlacement?: 'top' | 'bottom';
  toastBottomOffset?: number;
}) {
  return (
    <MotionProvider reduceMotion={reduceMotion}>
      <ToastProvider placement={toastPlacement} bottomOffset={toastBottomOffset}>
        <ToastScope scopeKey={scopeKey} />
        <ContinuityProvider>{children}</ContinuityProvider>
      </ToastProvider>
    </MotionProvider>
  );
}

/**
 * Push/pop container for a route stack. When `routeKey` changes, a deeper `depth` slides the new route in
 * (push) and a shallower one brings it back from the left (pop); the same depth swaps without motion, and so
 * does a `resetKey` change (for example a new account session). Reduce Motion: a short crossfade.
 */
export function ShellStack({ routeKey, depth, resetKey, children, style, testID }: {
  routeKey: string;
  depth: number;
  resetKey?: ScopeKey;
  children?: ReactNode;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}) {
  const direction = useStackDirection(depth);
  const previousReset = useRef(resetKey);
  const reset = !Object.is(previousReset.current, resetKey);
  useEffect(() => { previousReset.current = resetKey; });
  return (
    <StackTransition routeKey={`${String(resetKey ?? '')}|${routeKey}`} direction={reset ? 'none' : direction} style={style} testID={testID}>
      {children}
    </StackTransition>
  );
}
