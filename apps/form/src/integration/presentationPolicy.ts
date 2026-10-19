import type { AnimationStyle, AppMode, MascotVariant, Preferences } from '../api/domain';

export type PresentationPolicy = Readonly<{
  appMode: AppMode;
  mascot: MascotVariant;
  savedAnimationStyle: AnimationStyle;
  effectiveAnimationStyle: 'static' | AnimationStyle;
  mascotVisible: boolean;
  resultAccessDelayMs: 0;
}>;

// System accessibility changes presentation only; they never produce a preference PATCH.
// An unresolved Reduce Motion query uses the static equivalent until the system value is known.
export function resolvePresentationPolicy(
  preferences: Pick<Preferences, 'appMode' | 'mascot' | 'animationStyle'>,
  reduceMotion: boolean | null,
): PresentationPolicy {
  if (!['basic', 'advanced'].includes(preferences.appMode) ||
      !['scholarly', 'baby', 'buff', 'none'].includes(preferences.mascot) ||
      !['short', 'long'].includes(preferences.animationStyle)) {
    throw new TypeError('Unrecognized account presentation preferences');
  }
  return Object.freeze({
    appMode: preferences.appMode,
    mascot: preferences.mascot,
    savedAnimationStyle: preferences.animationStyle,
    effectiveAnimationStyle: reduceMotion === false ? preferences.animationStyle : 'static',
    mascotVisible: preferences.mascot !== 'none',
    resultAccessDelayMs: 0,
  });
}
