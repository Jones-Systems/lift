import type { Account, AppMode } from '../api/domain';

/** Account snapshot only: unknown/legacy values display Basic without repairing or writing preferences. */
export function appModeFrom(account: Pick<Account, 'preferences'> | null): AppMode {
  return account?.preferences?.appMode === 'advanced' ? 'advanced' : 'basic';
}
