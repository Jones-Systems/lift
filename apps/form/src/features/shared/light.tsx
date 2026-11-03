// Luminous Open Mat light layers built from `light` tokens: a page backdrop (warm sun + aqua mat-light over
// paper), a raised surface with layered elevation and a top sheen, and a soft glow. Decorative layers are
// hidden from assistive tech and never take touches. Text on these layers uses `lightTextPairs` colours.
import { useId, type ReactNode } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import Svg, { Defs, LinearGradient, RadialGradient, Rect, Stop } from 'react-native-svg';
import { light, t } from './tokens';

type Stops = readonly (readonly [number, string, number])[];

function stops(list: Stops) {
  return list.map(([offset, color, opacity]) => <Stop key={offset} offset={offset} stopColor={color} stopOpacity={opacity} />);
}

const hidden = { accessibilityElementsHidden: true, importantForAccessibility: 'no-hide-descendants' as const, pointerEvents: 'none' as const };

/**
 * Full-bleed page light behind screen content (place it first inside a relative container). Static: depth
 * comes from layered tokens, not motion, so it is the same under Reduce Motion.
 */
export function LightBackdrop({ style, testID }: { style?: StyleProp<ViewStyle>; testID?: string }) {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const sun = light.gradient.pageSun;
  const aqua = light.gradient.pageAqua;
  return (
    <View testID={testID} style={[StyleSheet.absoluteFill, { backgroundColor: light.color.paper }, style]} {...hidden}>
      <Svg width="100%" height="100%">
        <Defs>
          <RadialGradient id={`${id}-sun`} cx={sun.cx} cy={sun.cy} rx={sun.rx} ry={sun.ry} fx={sun.cx} fy={sun.cy} gradientUnits="objectBoundingBox">
            {stops(sun.stops)}
          </RadialGradient>
          <RadialGradient id={`${id}-aqua`} cx={aqua.cx} cy={aqua.cy} rx={aqua.rx} ry={aqua.ry} fx={aqua.cx} fy={aqua.cy} gradientUnits="objectBoundingBox">
            {stops(aqua.stops)}
          </RadialGradient>
        </Defs>
        <Rect x="0" y="0" width="100%" height="100%" fill={`url(#${id}-sun)`} />
        <Rect x="0" y="0" width="100%" height="100%" fill={`url(#${id}-aqua)`} />
      </Svg>
    </View>
  );
}

/** Top-lit sheen overlay for a raised surface (absolute; clip with the parent's radius + overflow hidden). */
export function Sheen({ style }: { style?: StyleProp<ViewStyle> }) {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  return (
    <View style={[StyleSheet.absoluteFill, style]} {...hidden}>
      <Svg width="100%" height="100%">
        <Defs>
          <LinearGradient id={`${id}-sheen`} x1="0" y1="0" x2="0" y2="1">{stops(light.gradient.sheen)}</LinearGradient>
        </Defs>
        <Rect x="0" y="0" width="100%" height="100%" fill={`url(#${id}-sheen)`} />
      </Svg>
    </View>
  );
}

export type Elevation = keyof typeof light.elevation;

/** Style for a raised surface: luminous white, hairline edge, layered ink-tinted shadow. */
export function elevationStyle(level: Exclude<Elevation, 'sheenInset' | 'sheet'> = 'e1'): ViewStyle {
  return { backgroundColor: light.color.surface, boxShadow: `${light.elevation[level]}, ${light.elevation.sheenInset}` };
}

/** A raised, top-lit card on the light page. `glow` adds a warm or success halo for one highlighted card. */
export function LightSurface({ children, level = 'e1', glow, sheen = true, radius = light.radius.card, style, testID }: {
  children: ReactNode; level?: Exclude<Elevation, 'sheenInset' | 'sheet'>; glow?: keyof typeof light.glow; sheen?: boolean;
  radius?: number; style?: StyleProp<ViewStyle>; testID?: string;
}) {
  const shadow = glow ? `${light.glow[glow]}, ${light.elevation[level]}` : light.elevation[level];
  // The shadow lives on the outer view; only the inner view clips, so the sheen follows the radius.
  return (
    <View testID={testID} style={[s.surface, { borderRadius: radius, boxShadow: shadow }, style]}>
      <View style={[s.clip, { borderRadius: radius }]} {...hidden}>{sheen ? <Sheen /> : null}</View>
      {children}
    </View>
  );
}

const s = StyleSheet.create({
  surface: { backgroundColor: light.color.surface, borderCurve: 'continuous', padding: t.space.s20 },
  clip: { ...StyleSheet.absoluteFill, overflow: 'hidden', borderCurve: 'continuous' },
});
