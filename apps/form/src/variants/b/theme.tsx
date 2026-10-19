// Club Circuit environment and text roles. Every value comes from generatedtokens.ts.
import React, { createContext, useContext, useEffect, useState } from 'react';
import { AccessibilityInfo, Platform, Text, useWindowDimensions, type TextProps, type TextStyle } from 'react-native';
import { tokens as t } from './generatedtokens';
import { guide } from './generatedguide';
import { useCapture } from './capture';

export { t };
export type TypeRole = keyof typeof t.type;
type ScaledRole = keyof typeof t.dynamicType.accessibilityLarge;
type Ramp = NonNullable<TextProps['dynamicTypeRamp']>;

export type Env = {
  /** Accessibility-large layout switches (rows stack, entries drop below labels, chart labels above bars). */
  stacked: boolean;
  /** Web preview of AX2 (`dt=accessibility-large`): explicit dynamicType.accessibilityLarge sizes. */
  webLarge: boolean;
  reduceMotion: boolean;
  /** iOS Increase Contrast: control boundary replaces the divider; active boundaries become 2 pt. */
  highContrast: boolean;
};
const EnvContext = createContext<Env>({ stacked: false, webLarge: false, reduceMotion: false, highContrast: false });
export const EnvProvider = EnvContext.Provider;
export const useEnv = () => useContext(EnvContext);

function webQuery(key: string) {
  return Platform.OS === 'web' && typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get(key) : null;
}

export function useClubEnvironment(): Env {
  const { fontScale } = useWindowDimensions();
  const [reduceMotion, setReduceMotion] = useState(false);
  const [highContrast, setHighContrast] = useState(false);
  const webLarge = webQuery('dt') === 'accessibility-large';
  useEffect(() => {
    let live = true;
    AccessibilityInfo.isReduceMotionEnabled().then((on) => { if (live) setReduceMotion(on); }, () => undefined);
    const motion = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
    let contrast: { remove: () => void } | null = null;
    if (Platform.OS === 'ios') {
      AccessibilityInfo.isDarkerSystemColorsEnabled().then((on) => { if (live) setHighContrast(on); }, () => undefined);
      contrast = AccessibilityInfo.addEventListener('darkerSystemColorsChanged', setHighContrast);
    }
    return () => { live = false; motion.remove(); contrast?.remove(); };
  }, []);
  return { stacked: webLarge || fontScale >= t.dataVisual.accessibilityTextScale, webLarge, reduceMotion, highContrast };
}

const RAMP = guide.typeRamp as Partial<Record<TypeRole, Ramp>>;
const TABULAR: readonly TypeRole[] = ['station', 'metric', 'number'];
/** R6: station numerals and tab labels keep their size at accessibility text sizes. */
const FIXED: readonly TypeRole[] = ['station', 'tab', 'statusTime'];

export function textStyle(role: TypeRole, env: Pick<Env, 'webLarge'>): TextStyle {
  const scaled = env.webLarge && role in t.dynamicType.accessibilityLarge
    ? t.dynamicType.accessibilityLarge[role as ScaledRole]
    : t.type[role];
  return {
    fontFamily: scaled.fontFamily,
    fontSize: scaled.fontSize,
    lineHeight: scaled.lineHeight,
    letterSpacing: scaled.letterSpacing,
    fontVariant: TABULAR.includes(role) ? ['tabular-nums'] : undefined,
  };
}

export const tones = {
  primary: t.color.text.primary,
  secondary: t.color.text.secondary,
  inverse: t.color.text.inverse,
  recorded: t.color.status.recorded,
  attention: t.color.status.attention,
  error: t.color.status.error,
} as const;
export type TextTone = keyof typeof tones;

export type TxtProps = Omit<TextProps, 'role'> & { type: TypeRole; tone?: TextTone; captureId?: string };

export function Txt({ type, tone = 'primary', captureId, style, testID, ...rest }: TxtProps) {
  const env = useEnv();
  const capture = useCapture(captureId);
  const fixed = FIXED.includes(type) || env.webLarge;
  return (
    <Text
      ref={capture.ref}
      onLayout={capture.onLayout}
      testID={testID ?? captureId}
      allowFontScaling={!fixed}
      dynamicTypeRamp={fixed ? undefined : RAMP[type]}
      style={[textStyle(type, env), { color: tones[tone] }, style]}
      {...rest}
    />
  );
}

export const dividerColor = (env: Env) => (env.highContrast ? t.color.border.control : t.color.border.divider);
export const activeWidth = (env: Env) => (env.highContrast ? t.stroke.active : t.stroke.control);
