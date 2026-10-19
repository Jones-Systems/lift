// User-facing error copy keyed by server/native code (design/form-onboarding/v1/copy.md).
// Evidence copy and its qualifiers live beside their screens and change only with a cited source.
import { ApiError } from '../../api/client';

export const COPY = {
  network: 'Couldn’t reach Form. Check your connection, then try again.',
  invalidCredentials: 'That email and password don’t match an account. Check both and try again.',
  registrationUnavailable: 'This email isn’t on the invite list. Check it, or ask for an invite.',
  stale: 'This changed on another device. We’ve loaded the latest, so check it and save again.',
  promoUnavailable: 'That code has expired or has already been used. Check it, or ask for a new one.',
  promoAlreadyRedeemed: 'You’ve already used this code. Your access is in Account.',
  onboardingIncomplete: 'A few answers are missing. We’ll take you back to them.',
  signedOut: 'You’ve been signed out. Sign in to pick up where you left off.',
  speechDenied: 'Form doesn’t have access to the microphone. Turn it on in Settings, or type your answer.',
  speechMissed: 'We didn’t catch that. Try again, or type it.',
  providersPending: 'Apple, Google and phone sign-in aren’t set up yet. Use your email for now.',
  appleUnconfigured: 'Apple sign-in isn’t set up yet. Use your email for now.',
  appleUnavailable: 'Apple sign-in isn’t available on this device. Use your email instead.',
  appleInvalid: 'We couldn’t confirm your Apple sign-in. Try again, or use your email.',
} as const;

/** "This iPhone can't turn speech into text on the device for <locale> right now…" */
export const speechUnavailableCopy = (localeName: string) =>
  `This iPhone can’t turn speech into text on the device for ${localeName} right now. Your answer won’t be sent anywhere else.`;

/** Unknown-effect copy comes from the transport: it already says to retry the same action unchanged. */
export function errorCopy(error: unknown): string {
  if (!(error instanceof ApiError)) return COPY.network;
  switch (error.code) {
    case 'network_unavailable': return error.effectUnknown ? error.message : COPY.network;
    case 'invalid_response': return error.message;
    case 'registration_unavailable': return COPY.registrationUnavailable;
    case 'stale_revision': return COPY.stale;
    case 'promo_unavailable': return COPY.promoUnavailable;
    case 'promo_already_redeemed': return COPY.promoAlreadyRedeemed;
    case 'onboarding_incomplete': return COPY.onboardingIncomplete;
    case 'unauthenticated': return COPY.signedOut;
    case 'apple_unconfigured': return COPY.appleUnconfigured;
    case 'apple_unavailable': return COPY.appleUnavailable;
    case 'invalid_apple_response': return COPY.appleInvalid;
    default:
      if (error.status === 401) return COPY.invalidCredentials;
      if (error.status === 0 || error.status >= 500) return COPY.network;
      return error.message;
  }
}

/** The Apple sheet cancelled by the user is not an error state. */
export function isUserCancel(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === 'ERR_REQUEST_CANCELED' || code === 'ERR_CANCELED';
}

export const setWord = (n: number) => `${n} ${n === 1 ? 'set' : 'sets'}`;
export const repsText = (min: number, max: number) => (min === max ? `${min} reps` : `${min}–${max} reps`);
export const movementWord = (n: number) => `${n} ${n === 1 ? 'movement' : 'movements'}`;

/** Weight label honoring loadUnit; storage stays canonical kg. */
export function loadText(kg: number, unit: 'kg' | 'lb'): string {
  if (kg === 0) return 'body weight';
  if (unit === 'lb') return `${Math.round(kg * 2.20462 * 2) / 2} lb`;
  return `${kg} kg`;
}

export function shortDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
