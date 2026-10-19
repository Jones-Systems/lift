import { isRunningInExpoGo, requireOptionalNativeModule } from 'expo';
import { AppState, Platform } from 'react-native';
import { FormNativeError } from './runtime';
import type { NativeBinding, NativeSubscription } from './runtime';
import type { FormHealthNative, HealthType, NativePage } from './healthKit.types';

export type * from './healthKit.types';

export const HEALTH_KIT_CAPABILITIES = Object.freeze({ query: false as const });
const healthTypes = new Set<HealthType>(['workouts', 'steps', 'activeEnergy', 'restingHeartRate', 'hrvSdnn', 'sleep', 'bodyMass']);
export type HealthKitLifecycle = {
  readonly currentState: string | null;
  addEventListener(event: 'change', listener: (state: string) => void): NativeSubscription;
};

export function bindHealthKitNative(): NativeBinding<FormHealthNative> {
  if (Platform.OS !== 'ios') return { module: null, reason: 'platform_unsupported' };
  try {
    if (isRunningInExpoGo()) return { module: null, reason: 'expo_go' };
    const module = requireOptionalNativeModule<FormHealthNative>('FormHealth');
    if (!module) return { module: null, reason: 'native_module_missing' };
    if (['availability', 'requestRead', 'query', 'cancelAll'].some(key => typeof module[key as keyof FormHealthNative] !== 'function')) {
      return { module: null, reason: 'native_probe_failed' };
    }
    return { module };
  } catch { return { module: null, reason: 'native_probe_failed' }; }
}

function validAvailability(value: unknown): Awaited<ReturnType<FormHealthNative['availability']>> {
  if (value === 'available' || value === 'unavailable_device' || value === 'restricted') return value;
  throw new FormNativeError('health_invalid_response', 'Unexpected HealthKit availability response.');
}

export async function getHealthKitCapabilities(binding = bindHealthKitNative()) {
  if (!binding.module) return { available: false, requestRead: false, query: false as const, reason: binding.reason };
  try {
    const status = validAvailability(await binding.module.availability());
    return { available: status === 'available', requestRead: status === 'available', query: false as const, reason: status };
  } catch { return { available: false, requestRead: false, query: false as const, reason: 'native_probe_failed' as const }; }
}

/** One adapter belongs to one active app/account binding. Dispose it before rebinding. */
export class FormHealthAdapter implements FormHealthNative {
  readonly capabilities = HEALTH_KIT_CAPABILITIES;
  protected epoch = 0;
  private disposed = false;
  private backgrounded: boolean;
  private readonly lifecycleSubscription: NativeSubscription;
  private readonly pending = new Map<symbol, (error: Error) => void>();
  private requestToken: symbol | null = null;
  private cancelling: Promise<void> | null = null;
  private cancellationFailed = false;

  constructor(protected readonly binding = bindHealthKitNative(), lifecycle: HealthKitLifecycle = AppState) {
    this.backgrounded = lifecycle.currentState === 'background';
    this.lifecycleSubscription = lifecycle.addEventListener('change', state => {
      this.backgrounded = state === 'background';
      if (this.backgrounded) {
        // A failed native cancellation blocks future requests until an explicit retry succeeds.
        void this.cancelAll().catch(() => {});
      }
    });
  }

  availability(): ReturnType<FormHealthNative['availability']> {
    return this.track(async () => this.binding.module
      ? validAvailability(await this.binding.module.availability()) : 'unavailable_device');
  }

  async requestRead(types: HealthType[]): Promise<'prompted' | 'unnecessary'> {
    this.assertActive();
    if (!Array.isArray(types) || types.length === 0 || types.length > healthTypes.size
      || new Set(types).size !== types.length || types.some(type => !healthTypes.has(type))) {
      throw new FormNativeError('health_invalid_types', 'Choose a nonempty unique subset of supported health types.');
    }
    if (this.backgrounded) throw new FormNativeError('health_backgrounded', 'Request HealthKit access from the active app.');
    if (this.requestToken) throw new FormNativeError('health_busy', 'Another HealthKit request is in progress.');
    const native = this.binding.module;
    if (!native) throw new FormNativeError('health_native_unavailable', `HealthKit is unavailable: ${this.binding.reason}.`);
    const selected = [...types];
    const generation = this.epoch;
    const token = Symbol();
    this.requestToken = token;
    try {
      return await this.track(async () => {
        const status = validAvailability(await native.availability());
        this.assertActive();
        if (generation !== this.epoch) throw new FormNativeError('health_cancelled', 'HealthKit request was cancelled.');
        if (status !== 'available') throw new FormNativeError('health_native_unavailable', `HealthKit is ${status}.`);
        const result = await native.requestRead(selected);
        // Neither completion value establishes read permission for any requested type.
        if (result !== 'prompted' && result !== 'unnecessary') {
          throw new FormNativeError('health_invalid_response', 'Unexpected HealthKit request response.');
        }
        return result;
      });
    } finally { if (this.requestToken === token) this.requestToken = null; }
  }

  async query(_input: Parameters<FormHealthNative['query']>[0]): Promise<NativePage> {
    throw new FormNativeError('health_query_unavailable', 'The durable original upload-intent consumer is not qualified.');
  }

  cancelAll(): Promise<void> {
    if (this.cancelling) return this.cancelling;
    this.epoch += 1;
    const error = new FormNativeError(this.disposed ? 'health_module_destroyed' : 'health_cancelled',
      'Form cancelled this HealthKit operation; system permissions are unchanged.');
    for (const reject of this.pending.values()) reject(error);
    this.pending.clear();
    const cancellation = Promise.resolve().then(() => this.binding.module?.cancelAll()).then(
      () => { this.cancellationFailed = false; },
      () => {
        this.cancellationFailed = true;
        throw new FormNativeError('health_cancel_failed', 'Native HealthKit cancellation could not be confirmed.');
      },
    ).finally(() => { if (this.cancelling === cancellation) this.cancelling = null; });
    this.cancelling = cancellation;
    return cancellation;
  }

  async dispose(): Promise<void> {
    if (!this.disposed) {
      this.disposed = true;
      this.lifecycleSubscription.remove();
    }
    await this.cancelAll();
  }

  protected assertActive(): void {
    if (this.disposed) throw new FormNativeError('health_module_destroyed', 'HealthKit adapter was disposed.');
    if (this.cancelling || this.cancellationFailed) {
      throw new FormNativeError('health_cancel_pending', 'Complete native cancellation before starting another HealthKit operation.');
    }
  }

  protected track<T>(operation: () => Promise<T>): Promise<T> {
    try { this.assertActive(); } catch (error) { return Promise.reject(error); }
    const generation = this.epoch;
    const token = Symbol();
    return new Promise<T>((resolve, reject) => {
      this.pending.set(token, reject);
      const settle = (callback: () => void) => {
        if (this.pending.delete(token) && generation === this.epoch && !this.disposed) callback();
      };
      try {
        operation().then(value => settle(() => resolve(value)), error => settle(() => reject(error)));
      } catch (error) { settle(() => reject(error)); }
    });
  }
}
