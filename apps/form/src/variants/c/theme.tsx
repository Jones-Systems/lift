import React, { createContext, useContext, useEffect, useState } from 'react';
import { AccessibilityInfo, PixelRatio, Platform, useWindowDimensions, type TextStyle, type ViewStyle } from 'react-native';
import { Easing } from 'react-native-reanimated';
import { tokens as t } from './generatedtokens';

export { t };
export type TypeRole = keyof typeof t.type;
export type TextTone = keyof typeof t.role.text;
export const easingOut = Easing.bezier(...t.motion.easing.out);
export const easingStandard = Easing.bezier(...t.motion.easing.standard);
export const shadow = (kind: keyof typeof t.shadow) => t.shadow[kind].map(s => ({ color:s.color, offsetX:s.offsetX, offsetY:s.offsetY, blurRadius:s.blur, spreadDistance:s.spread }));
export const MarginEnvironment = createContext({ stacked:false, webLarge:false, reducedMotion:false, width:t.render.phoneWidth as number });
export const useMargin = () => useContext(MarginEnvironment);
export function useMarginEnvironment(width: number) {
  const { fontScale } = useWindowDimensions();
  const [reducedMotion, setReduced] = useState(false);
  const webLarge = Platform.OS === 'web' && typeof location !== 'undefined' && new URLSearchParams(location.search).get('dynamic_type') === 'accessibility1';
  useEffect(() => {
    AccessibilityInfo.isReduceMotionEnabled().then(setReduced);
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduced);
    return () => sub.remove();
  }, []);
  return { width, reducedMotion, webLarge, stacked:webLarge || Math.max(fontScale, PixelRatio.getFontScale()) >= t.a11y.stackedMarginScale };
}
export function textStyle(role: TypeRole, webLarge = false): TextStyle {
  const type = t.type[role];
  return { fontFamily:type.fontFamily, fontSize:webLarge ? t.accessibilityType[role].size : type.fontSize, lineHeight:webLarge ? t.accessibilityType[role].line_height : type.lineHeight, letterSpacing:type.letterSpacing, color:t.role.text.primary, fontVariant:role.startsWith('entry') || role.startsWith('figure') ? ['tabular-nums'] : undefined };
}
export const contentStyle = (stacked: boolean): ViewStyle => ({ marginLeft:stacked ? t.layout.stackedMarginContentLeft : t.layout.contentLeft, marginRight:t.layout.contentRightInset });
export const focusStyle: ViewStyle = { outlineColor:t.role.line.focus, outlineWidth:t.border.focus, outlineOffset:t.border.focusOffset, outlineStyle:'solid' };
export const s = {
  flex: { flex:1 }, row: { flexDirection:'row', alignItems:'flex-start', gap:t.space.xs },
  copy: { flex:1, minWidth:t.space.none, flexShrink:1 },
  detail: { marginTop:t.space.xxs }, smallGap:{ marginTop:t.space.xs }, gap:{ marginTop:t.space.sm },
  footerGap:{ marginTop:t.space.xl }, well:{ backgroundColor:t.role.surface.well, borderRadius:t.radius.sm, borderCurve:'continuous', padding:t.space.md, marginTop:t.space.sm },
  paper:{ backgroundColor:t.role.surface.page },
} satisfies Record<string,ViewStyle>;
