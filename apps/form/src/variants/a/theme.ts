// Open Mat (A) theme: typed access to the generated tokens plus the few derived values
// the package defines as formulas (text-scale caps, ordinal column, motion easing).
import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { AccessibilityInfo, Platform, useWindowDimensions, type TextStyle, type ViewStyle } from 'react-native';
import { Easing } from 'react-native-reanimated';
import { tokens } from './tokens';

export const t = tokens;
export const L = tokens.layout;
export const IS_WEB = Platform.OS === 'web';

export type TypeRole = keyof typeof tokens.type;
export type ColorRole = Exclude<keyof typeof tokens.color, 'art' | 'chrome'>;

/** Bricolage roles carry the display cap (accessibility.displayMaxMultiplier) at large text. */
export const DISPLAY_ROLES: readonly TypeRole[] = ['display', 'pageTitle', 'sectionTitle', 'exerciseTitle', 'stat'];
/** Roles whose digits must align (tabular figures). */
const TABULAR_ROLES: readonly TypeRole[] = ['stat', 'value'];
export const tabular: TextStyle = { fontVariant: ['tabular-nums'] };

function textStyle(role: TypeRole): TextStyle {
  const spec = tokens.type[role];
  // fontWeight is deliberately omitted: each family alias is a static instance (no synthetic weight).
  return {
    fontFamily: spec.fontFamily,
    fontSize: spec.fontSize,
    lineHeight: spec.lineHeight,
    letterSpacing: spec.letterSpacing,
    ...(TABULAR_ROLES.includes(role) ? tabular : null),
  };
}

export const typeStyles = Object.fromEntries(
  (Object.keys(tokens.type) as TypeRole[]).map((role) => [role, textStyle(role)]),
) as Record<TypeRole, TextStyle>;

/** maxFontSizeMultiplier per role: display roles cap at 1.5, tab labels never grow (system large-content viewer). */
export function maxMultiplier(role: TypeRole): number | undefined {
  if (role === 'tab') return tokens.accessibility.referenceTextScale;
  return DISPLAY_ROLES.includes(role) ? tokens.accessibility.displayMaxMultiplier : undefined;
}

export const easeOut = Easing.bezier(...tokens.motion.easeOut);

/**
 * Large-text layout (DESIGN "At text scale 2.0"): fields stack, chips move under the label,
 * metadata stacks, Plan uses a day list, Today uses the week link, Workout art is hidden.
 * Switches when the system text scale reaches accessibility.largeTextScale (see DGR A-RN-03).
 */
export function useTextScale() {
  const { fontScale } = useWindowDimensions();
  const large = fontScale >= tokens.accessibility.largeTextScale;
  /** Effective multiplier for a role, mirroring RN's maxFontSizeMultiplier cap. */
  const scaleFor = (role: TypeRole) => {
    const cap = maxMultiplier(role);
    return cap ? Math.min(fontScale, cap) : fontScale;
  };
  return { fontScale, large, scaleFor };
}

export type Prefs = { reduceMotion: boolean; reduceTransparency: boolean; increaseContrast: boolean };

/** Reduce Motion, Reduce Transparency and Increase Contrast (iOS darker system colors), read from the OS and kept live. */
export function useAccessibilityPrefs(): Prefs {
  const [reduceMotion, setReduceMotion] = useState(false);
  const [reduceTransparency, setReduceTransparency] = useState(false);
  const [increaseContrast, setIncreaseContrast] = useState(false);
  useEffect(() => {
    let active = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((value) => { if (active) setReduceMotion(value); });
    const subscriptions = [AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion)];
    if (Platform.OS === 'ios') {
      void AccessibilityInfo.isReduceTransparencyEnabled().then((value) => { if (active) setReduceTransparency(value); });
      void AccessibilityInfo.isDarkerSystemColorsEnabled().then((value) => { if (active) setIncreaseContrast(value); });
      subscriptions.push(AccessibilityInfo.addEventListener('reduceTransparencyChanged', setReduceTransparency));
      subscriptions.push(AccessibilityInfo.addEventListener('darkerSystemColorsChanged', setIncreaseContrast));
    }
    return () => {
      active = false;
      for (const subscription of subscriptions) subscription.remove();
    };
  }, []);
  return useMemo(() => ({ reduceMotion, reduceTransparency, increaseContrast }), [reduceMotion, reduceTransparency, increaseContrast]);
}

export const PrefsContext = createContext<Prefs>({ reduceMotion: false, reduceTransparency: false, increaseContrast: false });
export const usePrefs = () => useContext(PrefsContext);

const CONTRAST_OUTLINE: ViewStyle = { borderColor: tokens.color.ink, borderWidth: tokens.accessibility.contrastIncreasedBorderWeight };

/** Increased Contrast: essential outlines switch from controlBorder to ink at contrastIncreasedBorderWeight. */
export function useEssentialOutline(): ViewStyle | null {
  return usePrefs().increaseContrast ? CONTRAST_OUTLINE : null;
}

/** Resolves a generated-art token path such as "art.mat" or "controlBorder" to its color. */
export function colorAt(path: string): string {
  let node: unknown = tokens.color;
  for (const part of path.split('.')) node = (node as Record<string, unknown>)[part];
  return typeof node === 'string' ? node : tokens.color.ink;
}

/** Resolves a generated token path such as "opacity.chromeTrack". */
export function numberAt(path: string): number {
  let node: unknown = tokens;
  for (const part of path.split('.')) node = (node as Record<string, unknown>)[part];
  return typeof node === 'number' ? node : tokens.opacity.visible;
}
