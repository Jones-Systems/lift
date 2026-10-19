import { Platform } from 'react-native';
import * as AppleAuthentication from 'expo-apple-authentication';
import * as Crypto from 'expo-crypto';
import { ApiError, formApi } from './client';
import type { AuthAttemptGuard } from './transport';
import { formResources } from './resources';

/** User-initiated only. Provisioning and a real device roundtrip remain separate acceptance gates. */
export async function signInWithApple(guard?: AuthAttemptGuard) {
  const assertCurrent = () => {
    if (guard && !guard.isCurrent()) throw new ApiError(409, 'session_changed', 'This sign-in attempt ended.');
  };
  assertCurrent();
  const capabilities = await formResources.capabilities();
  assertCurrent();
  if (capabilities.authentication.apple.status === 'unconfigured') {
    throw new ApiError(501, 'apple_unconfigured', 'Apple sign-in is not connected yet.');
  }
  if (Platform.OS !== 'ios' || !await AppleAuthentication.isAvailableAsync()) {
    throw new ApiError(501, 'apple_unavailable', 'Apple sign-in is unavailable on this device.');
  }
  assertCurrent();
  const nonce = Crypto.randomUUID();
  const state = Crypto.randomUUID();
  const credential = await AppleAuthentication.signInAsync({
    requestedScopes: [AppleAuthentication.AppleAuthenticationScope.FULL_NAME, AppleAuthentication.AppleAuthenticationScope.EMAIL],
    nonce, state,
  });
  assertCurrent();
  if (credential.state !== state || !credential.identityToken) {
    throw new ApiError(401, 'invalid_apple_response', 'Apple sign-in could not be verified. Please try again.');
  }
  return formApi.signInIdentity('apple', {
    token: credential.identityToken, nonce,
    user: {
      ...(credential.email ? { email: credential.email } : {}),
      ...(credential.fullName ? { name: {
        ...(credential.fullName.givenName ? { firstName: credential.fullName.givenName } : {}),
        ...(credential.fullName.familyName ? { lastName: credential.fullName.familyName } : {}),
      } } : {}),
    },
  }, guard);
}
