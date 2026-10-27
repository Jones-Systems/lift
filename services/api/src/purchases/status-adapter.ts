import type { AppStoreServerAPIClient } from '@apple/app-store-server-library';
import type { AppleStatusTransport } from './reconciliation.types.js';

/** Uses only a supplied SDK client; no credentials, network destinations or client factory. */
export function createAppleStatusTransport(client: Pick<AppStoreServerAPIClient, 'getAllSubscriptionStatuses'>): AppleStatusTransport {
  return Object.freeze({
    // Omit status filters so expired, retry, grace and revoked evidence cannot be hidden.
    statuses: (originalTransactionId: string) => client.getAllSubscriptionStatuses(originalTransactionId),
  });
}
