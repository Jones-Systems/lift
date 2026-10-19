// Owned vector art and Lucide icons rendered with react-native-svg from generated geometry.
// Path data is the package's, unchanged; paint resolves through tokens (colorAt).
import { useEffect } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import Svg, { Circle, Line, Path, Rect } from 'react-native-svg';
import Reanimated, { useAnimatedProps, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { art } from './assets/generatedart';
import { icons, type IconName } from './assets/generatedicons';
import { colorAt, easeOut, L, numberAt, t } from './theme';

type Element = { readonly tag: string; readonly [key: string]: string | number | undefined };

function paint(el: Element, key: 'fill' | 'stroke', current: string): string | undefined {
  const token = el[`${key}Token`];
  if (typeof token === 'string') return colorAt(token);
  const raw = el[key];
  if (raw === 'currentColor') return current;
  return typeof raw === 'string' ? raw : undefined;
}

function shape(el: Element, index: number, current: string, defaults: { fill?: string; stroke?: string }) {
  const fill = paint(el, 'fill', current) ?? defaults.fill;
  const stroke = paint(el, 'stroke', current) ?? defaults.stroke;
  const common = {
    fill,
    stroke,
    strokeWidth: typeof el.strokeWidth === 'number' ? el.strokeWidth : undefined,
    strokeLinecap: el.strokeLinecap as 'round' | undefined,
    strokeLinejoin: el.strokeLinejoin as 'round' | undefined,
    strokeOpacity: typeof el.strokeOpacityToken === 'string' ? numberAt(el.strokeOpacityToken) : undefined,
    fillOpacity: typeof el.fillOpacityToken === 'string' ? numberAt(el.fillOpacityToken) : undefined,
  };
  switch (el.tag) {
    case 'path':
      return <Path key={index} d={String(el.d)} {...common} />;
    case 'rect':
      return <Rect key={index} x={el.x} y={el.y} width={el.width} height={el.height} rx={el.rx} {...common} />;
    case 'circle':
      return <Circle key={index} cx={el.cx} cy={el.cy} r={el.r} {...common} />;
    case 'line':
      return <Line key={index} x1={el.x1} x2={el.x2} y1={el.y1} y2={el.y2} {...common} />;
    default:
      return null;
  }
}

/** Lucide icon: 2 pt round outline (stroke.icon), currentColor = `color`. Always decorative; labels live on controls. */
export function Icon({ name, size, color }: { name: IconName; size: number; color: string }) {
  const icon = icons[name];
  return (
    <Svg width={size} height={size} viewBox={icon.viewBox} fill="none" stroke={color} strokeWidth={t.stroke.icon}
      strokeLinecap={icon.strokeLinecap} strokeLinejoin={icon.strokeLinejoin}
      accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {(icon.elements as readonly Element[]).map((el, i) => shape(el, i, color, {}))}
    </Svg>
  );
}

const AnimatedPath = Reanimated.createAnimatedComponent(Path);
const CHECK = icons.check;
const CHECK_D = String((CHECK.elements as readonly Element[])[0].d);

/**
 * CMP-A10 done-chip check. When `draw` is set (first confirmed set of a session only) the
 * stroke draws over motion.confirm with motion.easeOut; Reduce Motion fades it in over
 * motion.reduced instead. The static check is the end frame.
 */
export function CheckMark({ size, color, draw, reduceMotion }: { size: number; color: string; draw: boolean; reduceMotion: boolean }) {
  const length = CHECK.pathLength;
  const progress = useSharedValue<number>(draw ? t.opacity.hidden : t.opacity.visible);
  useEffect(() => {
    if (!draw) return;
    progress.value = withTiming(t.opacity.visible, { duration: reduceMotion ? t.motion.reduced : t.motion.confirm, easing: easeOut });
  }, [draw, reduceMotion, progress]);
  const strokeProps = useAnimatedProps(() => ({
    strokeDashoffset: reduceMotion ? t.opacity.hidden : length * (t.opacity.visible - progress.value),
  }));
  const fade = useAnimatedStyle(() => ({ opacity: reduceMotion ? progress.value : t.opacity.visible }));
  return (
    <Reanimated.View style={fade} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <Svg width={size} height={size} viewBox={CHECK.viewBox} fill="none" stroke={color} strokeWidth={t.stroke.icon}
        strokeLinecap={CHECK.strokeLinecap} strokeLinejoin={CHECK.strokeLinejoin}>
        <AnimatedPath d={CHECK_D} strokeDasharray={[length, length]} animatedProps={strokeProps} />
      </Svg>
    </Reanimated.View>
  );
}

type ArtProps = { variant: 'today' | 'workout' | 'small'; testID?: string; style?: StyleProp<ViewStyle>; captureRef?: (node: Pick<View, 'measureInWindow'> | null) => void };

const ART_SIZE = {
  today: { width: L.art.todayWidth, height: L.art.todayHeight },
  workout: { width: L.art.workoutWidth, height: L.art.workoutHeight },
  small: { width: L.art.smallWidth, height: L.art.smallHeight },
} as const;

/** CMP-A03 OpenMatArt. Decorative (hidden from VoiceOver); never a button, card, chart or animation. */
export function OpenMatArt({ variant, testID, style, captureRef }: ArtProps) {
  const size = ART_SIZE[variant];
  const asset = variant === 'small' ? art.openMatEmpty : art.openMatSquat;
  return (
    <View ref={captureRef} testID={testID} style={[size, style]} accessible={false}
      accessibilityElementsHidden importantForAccessibility="no-hide-descendants" pointerEvents="none">
      <Svg width={size.width} height={size.height} viewBox={asset.viewBox}>
        {(asset.elements as readonly Element[]).map((el, i) => shape(el, i, t.color.ink, {}))}
      </Svg>
    </View>
  );
}

/** Simulated status-bar glyphs (web reference frame only; the OS draws the real ones natively). */
export function StatusGlyph({ name, color }: { name: 'signal' | 'wifi' | 'battery'; color: string }) {
  const glyph = art.statusGlyphs.glyphs[name];
  const [, , vw, vh] = glyph.viewBox.split(' ').map(Number);
  return (
    <Svg width={vw} height={vh} viewBox={glyph.viewBox} fill={glyph.fill === 'currentColor' ? color : undefined}>
      {(glyph.elements as readonly Element[]).map((el, i) => shape(el, i, color, {}))}
    </Svg>
  );
}
