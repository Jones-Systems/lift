// Open Mat paper-cut movement illustrations for Form screens. A figure is drawn only where its pose matches
// the movement (the generated art has the squat pose today); otherwise callers get nothing or the empty mat,
// never a mismatched figure. Decorative: hidden from assistive tech, never a button, never carries meaning.
import { useEffect } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import Svg from 'react-native-svg';
import Reanimated, { cancelAnimation, useAnimatedStyle, useSharedValue, withDelay, withSequence, withTiming } from 'react-native-reanimated';
import { art } from '../../variants/a/assets/generatedart';
import { shape, type Element } from '../../variants/a/art';
import { motionEasing, timingConfig } from './motion';
import { useReduceMotion } from './motionProvider';
import { L, t } from './tokens';

/** Poses the generated Open Mat art can draw. */
export type Pose = 'squat';

/** Exact movement ids/names whose pose is drawn; extend only when a matching generated pose exists. */
export const movementPoses: Readonly<Record<string, Pose>> = {
  squat: 'squat',
  'goblet-squat': 'squat',
  'bodyweight-squat': 'squat',
  'air-squat': 'squat',
  'box-squat': 'squat',
  'chair-squat': 'squat',
  'supported-squat': 'squat',
  'sit-to-stand': 'squat',
};

const normalize = (value: string) => value.trim().toLowerCase().replace(/[\s_]+/g, '-');

/** Pose for a movement by catalog id or display name, or null when no drawn pose matches it. */
export function poseForMovement(movement: { exerciseId?: string | null; name?: string | null } | string | null | undefined): Pose | null {
  const keys = typeof movement === 'string' ? [movement] : [movement?.exerciseId, movement?.name];
  for (const key of keys) {
    if (key && movementPoses[normalize(key)]) return movementPoses[normalize(key)];
  }
  return null;
}

export type IllustrationSize = 'today' | 'workout' | 'small';

const SIZE: Record<IllustrationSize, { width: number; height: number }> = {
  today: { width: L.art.todayWidth, height: L.art.todayHeight },
  workout: { width: L.art.workoutWidth, height: L.art.workoutHeight },
  small: { width: L.art.smallWidth, height: L.art.smallHeight },
};

const squat = art.openMatSquat.elements as readonly Element[];
const MAT = squat.slice(0, 1);
const FIGURE = squat.slice(1);
const EMPTY = art.openMatEmpty.elements as readonly Element[];
/** One breath: inhale, hold, exhale (≤ 5 s, so no pause control is needed). Torso moves ~1–2 %. */
const BREATH = { inhale: 1600, hold: 400, exhale: 2000, scale: 1.015 } as const;

function useBreath(breathKey: unknown, enabled: boolean) {
  const reduceMotion = useReduceMotion();
  const scale = useSharedValue(1);
  useEffect(() => {
    if (!enabled || breathKey === undefined || breathKey === null || reduceMotion) {
      cancelAnimation(scale);
      scale.value = 1;
      return;
    }
    scale.value = withSequence(
      withTiming(BREATH.scale, timingConfig(BREATH.inhale, false, motionEasing.inOut)),
      withDelay(BREATH.hold, withTiming(1, timingConfig(BREATH.exhale, false, motionEasing.inOut))),
    );
  }, [breathKey, enabled, reduceMotion, scale]);
  return useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
}

/**
 * Movement illustration. `fallback="mat"` draws the empty mat when no pose matches (default draws nothing).
 * `breathKey`: each new non-null value plays one short ambient breath of the figure (the mat never moves);
 * pass e.g. the rest-start time or a first-visit flag. Off under Reduce Motion.
 */
export function MovementIllustration({ movement, size = 'workout', fallback = 'none', breathKey, testID, style }: {
  movement: Parameters<typeof poseForMovement>[0];
  size?: IllustrationSize;
  fallback?: 'none' | 'mat';
  breathKey?: unknown;
  testID?: string;
  style?: StyleProp<ViewStyle>;
}) {
  const pose = poseForMovement(movement);
  const breath = useBreath(breathKey, pose !== null);
  const box = SIZE[size];
  if (!pose && fallback === 'none') return null;
  const viewBox = art.openMatSquat.viewBox;
  return (
    <View testID={testID} style={[box, style]} accessible={false} accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants" pointerEvents="none">
      <Svg width={box.width} height={box.height} viewBox={pose ? viewBox : art.openMatEmpty.viewBox} style={{ position: 'absolute' }}>
        {(pose ? MAT : EMPTY).map((el, i) => shape(el, i, t.color.ink, {}))}
      </Svg>
      {pose ? (
        <Reanimated.View style={[box, { position: 'absolute', transformOrigin: 'bottom' }, breath]}>
          <Svg width={box.width} height={box.height} viewBox={viewBox}>{FIGURE.map((el, i) => shape(el, i, t.color.ink, {}))}</Svg>
        </Reanimated.View>
      ) : null}
    </View>
  );
}

/** Ambient breath length, for screens that sequence other cues after it. */
export const breathDuration = BREATH.inhale + BREATH.hold + BREATH.exhale;
