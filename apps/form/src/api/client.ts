import { Platform } from 'react-native';
import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';

export const API_BASE = process.env.EXPO_PUBLIC_FORM_API_URL ?? 'http://127.0.0.1:9';
const SESSION_KEY = 'form.private.session.v1';
const KEYCHAIN = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };

import { FormTransport } from './transport';
import type { SessionStorage } from './transport';
export { ApiError } from './transport';
export type { SessionStorage } from './transport';

// Browser reference sessions deliberately live only in memory; native secrets use this app's Keychain item.
let webSession: string | null = null;
export const sessionStorage: SessionStorage = {
  load: () => Platform.OS === 'web' ? Promise.resolve(webSession) : SecureStore.getItemAsync(SESSION_KEY, KEYCHAIN),
  save: async (token) => {
    if (Platform.OS === 'web') webSession = token;
    else await SecureStore.setItemAsync(SESSION_KEY, token, KEYCHAIN);
  },
  clear: async () => {
    if (Platform.OS === 'web') webSession = null;
    else await SecureStore.deleteItemAsync(SESSION_KEY, KEYCHAIN);
  },
};

export function commandKey(): string { return Crypto.randomUUID(); }

export class FormApi extends FormTransport {
  constructor(baseURL = API_BASE, storage = sessionStorage) { super(baseURL, storage); }
}

export const formApi = new FormApi();
