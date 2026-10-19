import { isRunningInExpoGo, requireOptionalNativeModule } from 'expo';
import { Platform } from 'react-native';

export type NativeUnavailableReason = 'platform_unsupported' | 'expo_go' | 'native_module_missing' | 'native_probe_failed';
export type NativeBinding<T> = { module: T; reason?: never } | { module: null; reason: NativeUnavailableReason };
export type NativeSubscription = { remove(): void };

/** Local modules require a rebuilt iOS binary; import must remain safe in Expo Go and web. */
export function bindFormNativeModule<T>(name: 'FormSpeech' | 'FormStoreKit' | 'FormVoice' | 'FormHealth'): NativeBinding<T> {
  if (Platform.OS !== 'ios') return { module: null, reason: 'platform_unsupported' };
  try {
    if (isRunningInExpoGo()) return { module: null, reason: 'expo_go' };
    const module = requireOptionalNativeModule<T>(name);
    return module ? { module } : { module: null, reason: 'native_module_missing' };
  } catch {
    return { module: null, reason: 'native_probe_failed' };
  }
}

export class FormNativeError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'FormNativeError'; }
}
