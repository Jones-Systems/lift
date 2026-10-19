import { Platform } from 'react-native';
import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { recoveryReceipt, type RecoveryReceipt } from './contracts';
import type { ReceiptStore } from './controller';

// This queue protects same-key writes within this JavaScript runtime, not across native processes.
const receiptWrites = new Map<string, Promise<void>>();
function serializeReceiptWrite(key: string, write: () => Promise<void>): Promise<void> {
  const result = (receiptWrites.get(key) ?? Promise.resolve()).then(write);
  const settled = result.then(() => undefined, () => undefined);
  receiptWrites.set(key, settled);
  void settled.then(() => {
    if (receiptWrites.get(key) === settled) receiptWrites.delete(key);
  });
  return result;
}

export async function nativeReceiptCustody(accountId: string, baseURL: string): Promise<{
  receipts: ReceiptStore; createReceipt(): Promise<RecoveryReceipt>;
} | null> {
  if (Platform.OS === 'web' || !await SecureStore.isAvailableAsync()) return null;
  const scope = baseURL.replace(/\/$/, '');
  const digest = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, JSON.stringify([scope, accountId]));
  const key = `form.lifecycle.receipt.${digest}`;
  const options = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
  return {
    receipts: {
      async load() {
        const value = await SecureStore.getItemAsync(key, options);
        return value === null ? null : recoveryReceipt(JSON.parse(value), accountId, scope);
      },
      async save(receipt) {
        recoveryReceipt(receipt, accountId, scope);
        const serialized = JSON.stringify(receipt);
        return serializeReceiptWrite(key, async () => {
          const previous = await SecureStore.getItemAsync(key, options);
          if (previous !== null && previous !== serialized) throw new Error('Receipt replacement is unavailable');
          await SecureStore.setItemAsync(key, serialized, options);
        });
      },
    },
    async createReceipt() {
      const bytes = await Crypto.getRandomBytesAsync(32);
      const statusSecret = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
      return { accountId, baseURL: scope, requestId: Crypto.randomUUID(), commandKey: Crypto.randomUUID(), statusSecret };
    },
  };
}
