import { GetTransactionHistoryVersion, type AppStoreServerAPIClient } from '@apple/app-store-server-library';
import type { AppleHistoryReader } from './reconciliation.types.js';

/** Accepts an already configured SDK client; this module never reads keys or constructs authenticated clients. */
export function createAppleHistoryReader(client: Pick<AppStoreServerAPIClient, 'getTransactionHistory'>): AppleHistoryReader {
  return Object.freeze({
    page: (originalTransactionId: string, revision: string | null) =>
      client.getTransactionHistory(originalTransactionId, revision, {}, GetTransactionHistoryVersion.V2),
  });
}
