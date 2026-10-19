import { LifecycleError, POLICY, recoveryReceipt, type RecoveryReceipt } from './contracts';
import type { FormTransport } from '../api/transport';

export type LifecycleApi = {
  baseURL: string;
  settings(): Promise<unknown>;
  grant(purpose: 'account_export' | 'account_delete', password: string): Promise<unknown>;
  export(grant: string): Promise<unknown>;
  initiate(receipt: RecoveryReceipt): Promise<unknown>;
  confirm(requestId: string, grant: string): Promise<unknown>;
  status(receipt: RecoveryReceipt): Promise<unknown>;
};
export function createLifecycleApi(transport: Pick<FormTransport, 'baseURL' | 'request'>, fetcher: typeof fetch = fetch): LifecycleApi {
  const baseURL = transport.baseURL.replace(/\/$/, '');
  return {
    baseURL,
    settings: () => transport.request('/v1/me/settings'),
    grant: (purpose, password) => transport.request('/v1/me/account-action-grants', 'POST', { purpose, password }),
    export: grant => transport.request('/v1/me/account-export', 'POST', { grant }),
    initiate: receipt => transport.request('/v1/me/deletion-requests', 'POST', {
      requestId: receipt.requestId, policyVersion: POLICY, confirmation: 'delete_whole_account', statusSecret: receipt.statusSecret,
    }, receipt.commandKey),
    confirm: (requestId, grant) => transport.request(`/v1/me/deletion-requests/${encodeURIComponent(requestId)}/confirm`, 'POST', {
      grant, policyVersion: POLICY, confirmation: 'delete_whole_account',
    }),
    async status(receipt) {
      recoveryReceipt(receipt, receipt.accountId, baseURL);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      try {
        const response = await fetcher(baseURL + '/v1/account-deletion/status', {
          method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `DeletionReceipt ${receipt.statusSecret}` },
          body: JSON.stringify({ requestId: receipt.requestId }), signal: controller.signal, redirect: 'error', credentials: 'omit',
        });
        if (!response.ok) throw new LifecycleError(response.status === 401 ? 'status_receipt_invalid' : 'status_unavailable');
        return await response.json();
      } catch (error) {
        if (error instanceof LifecycleError) throw error;
        throw new LifecycleError('status_unavailable');
      } finally { clearTimeout(timeout); }
    },
  };
}
