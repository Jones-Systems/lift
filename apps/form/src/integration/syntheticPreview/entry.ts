import type { FixtureCase, PreviewDenial } from '../../features/syntheticPreviewContract';

export type PreviewSelection =
  | Readonly<{ status: 'off' }>
  | Readonly<{ status: 'denied'; reason: PreviewDenial }>
  | Readonly<{ status: 'selected'; scenario: FixtureCase }>;

/** Reads the real build/entry state; callers cannot substitute a development flag. */
export function readSyntheticPreviewSelection(): PreviewSelection {
  const selector = process.env.EXPO_PUBLIC_FORM_SYNTHETIC_PREVIEW;
  if (selector === undefined || selector === '') return Object.freeze({ status: 'off' });
  if (typeof __DEV__ === 'undefined' || __DEV__ !== true) {
    return Object.freeze({ status: 'denied', reason: 'release_or_unknown_build' });
  }
  switch (selector) {
    case 'rest-running':
    case 'rest-paused':
    case 'com01-owner-current':
    case 'com01-admin-current':
    case 'com01-member-current':
    case 'com01-stale':
      break;
    default:
      return Object.freeze({ status: 'denied', reason: 'unknown_case' });
  }
  try {
    if (typeof window !== 'undefined' && typeof window.location?.search === 'string' &&
        new URLSearchParams(window.location.search).get('gallery') === '1') {
      return Object.freeze({ status: 'denied', reason: 'conflicting_entry' });
    }
  } catch {
    return Object.freeze({ status: 'denied', reason: 'conflicting_entry' });
  }
  return Object.freeze({ status: 'selected', scenario: selector });
}
