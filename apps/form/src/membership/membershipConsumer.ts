import { MembershipController } from './controller';
import { FamilyMembershipConsumer } from './familyConsumer';
import type { FamilyConsumerState } from './familyConsumer';
import type { FamilyPorts, FamilyRecovery, FamilySession } from './family.types';
import type { MembershipPorts, MembershipRecovery, MembershipSession, MembershipState } from './types';

export type MembershipConsumerOptions = {
  scope: { accountId: string; generation: string; isCurrent(): boolean };
  membership: MembershipPorts;
  family?: FamilyPorts;
  navigation?: { openActivity(): void; openGroups(): void };
};
export type MembershipConsumerState = {
  membership: MembershipState;
  family: FamilyConsumerState;
  navigation: { activity: 'available' | 'unavailable'; groups: 'available' | 'unavailable' };
};
export type MembershipConsumerRecovery = { membership: MembershipRecovery | null; family: FamilyRecovery | null };
export interface MembershipConsumer {
  getState(): MembershipConsumerState;
  getRecovery(): MembershipConsumerRecovery;
  subscribe(listener: () => void): () => void;
  load(): Promise<void>;
  purchase(productId: string): Promise<void>;
  restore(): Promise<void>;
  redeem(code: string): Promise<void>;
  manageSubscriptions(): Promise<void>;
  checkAgain(): Promise<void>;
  loadFamily(): Promise<void>;
  acceptFamilyInvitation(invitationId: string): Promise<void>;
  createFamily(): Promise<void>;
  inviteFamilyAccount(inviteeAccountId: string): Promise<void>;
  revokeFamilyInvitation(invitationId: string): Promise<void>;
  removeFamilyMember(memberAccountId: string): Promise<void>;
  leaveFamily(): Promise<void>;
  checkFamilyAgain(): Promise<void>;
  openActivity(): boolean;
  openGroups(): boolean;
  dispose(): void;
}

const hiddenMembership = (reason: string): MembershipState => ({ status: 'unavailable', products: [], entitlements: null,
  reason, canPurchase: false, canRestore: false, canRedeem: false, canCheckAgain: false });
const hiddenFamily = (reason: string): FamilyConsumerState => ({ family: { status: 'unavailable', snapshot: null, reason },
  invitations: { status: 'unavailable', items: [], reason }, busy: false });

export function createMembershipConsumer(options: MembershipConsumerOptions): MembershipConsumer {
  const scope = options.scope;
  const { accountId, generation } = scope;
  const scopeCurrent = scope.isCurrent.bind(scope);
  const membershipPorts = options.membership;
  const familyPorts = options.family;
  const openActivity = options.navigation?.openActivity.bind(options.navigation);
  const openGroups = options.navigation?.openGroups.bind(options.navigation);
  const listeners = new Set<() => void>();
  let disposed = false;
  let expired = !accountId.trim() || !generation.trim();
  const current = (): boolean => {
    if (!disposed && !expired && (!scopeCurrent() || scope.accountId !== accountId || scope.generation !== generation)) expired = true;
    return !disposed && !expired;
  };
  const matches = (sourceAccount: string, sourceGeneration: string, sourceCurrent: boolean): boolean => {
    if (!current()) return false;
    if (!sourceCurrent || sourceAccount !== accountId || sourceGeneration !== generation) expired = true;
    return !expired;
  };
  const requireCurrent = (): void => { if (!current()) throw new Error('membership_session_changed'); };
  const captureMembership = (): MembershipSession | null => {
    if (!current()) return null;
    const source = membershipPorts.captureSession();
    if (!source || !matches(source.account.accountId, source.generation, source.isCurrent())) return null;
    const account = { ...source.account };
    const sourceCurrent = source.isCurrent.bind(source);
    const sourceMatches = () => {
      if (source.account.appAccountToken !== account.appAccountToken) expired = true;
      return matches(source.account.accountId, source.generation, sourceCurrent());
    };
    const read = source.readEntitlements.bind(source);
    const redeem = source.redeem.bind(source);
    return { account, generation, isCurrent: sourceMatches,
      readEntitlements: () => { requireCurrent(); if (!sourceMatches()) throw new Error('membership_session_changed'); return read(); },
      redeem: (code, key) => { requireCurrent(); if (!sourceMatches()) throw new Error('membership_session_changed'); return redeem(code, key); },
      // Late receipts stay on the captured authenticated delivery port, including after host disposal.
      deliver: source.deliver.bind(source),
    };
  };
  const captureFamily = (): FamilySession | null => {
    if (!current() || !familyPorts) return null;
    const source = familyPorts.captureSession();
    if (!source || !matches(source.accountId, source.generation, source.isCurrent())) return null;
    const sourceCurrent = source.isCurrent.bind(source);
    return { accountId, generation, isCurrent: () => matches(source.accountId, source.generation, sourceCurrent()),
      read: source.read.bind(source), command: source.command.bind(source), reconcile: source.reconcile.bind(source),
      ...(source.invitations ? { invitations: source.invitations.bind(source) } : {}),
    };
  };
  const membership = new MembershipController({
    captureSession: captureMembership,
    configuration: () => current() ? membershipPorts.configuration() : { purchases: 'unavailable', promos: false },
    native: {
      products: () => { requireCurrent(); return membershipPorts.native.products(); },
      purchase: (productId, token) => { requireCurrent(); return membershipPorts.native.purchase(productId, token); },
      restore: () => { requireCurrent(); return membershipPorts.native.restore(); },
      currentEntitlements: () => { requireCurrent(); return membershipPorts.native.currentEntitlements(); },
    },
    newIdempotencyKey: () => { requireCurrent(); return membershipPorts.newIdempotencyKey(); },
    openManageSubscriptions: () => { requireCurrent(); return membershipPorts.openManageSubscriptions(); },
  });
  const family = familyPorts ? new FamilyMembershipConsumer({ captureSession: captureFamily,
    newIdempotencyKey: () => { requireCurrent(); return familyPorts.newIdempotencyKey(); } }) : null;
  const notify = (): void => { if (current()) for (const listener of listeners) listener(); };
  const unsubscribeMembership = membership.subscribe(notify);
  const unsubscribeFamily = family?.subscribe(notify);
  const run = async (operation: () => Promise<void>): Promise<void> => { if (current()) await operation(); };
  const navigate = (callback: (() => void) | undefined): boolean => {
    if (!current() || !callback) return false;
    callback();
    return true;
  };

  return {
    getState() {
      const membershipState = membership.getState();
      const familyState = family?.getState() ?? hiddenFamily('family_unavailable');
      if (!current()) {
        const reason = disposed ? 'disposed' : 'session_changed';
        return { membership: hiddenMembership(reason), family: hiddenFamily(reason),
          navigation: { activity: 'unavailable', groups: 'unavailable' } };
      }
      return { membership: membershipState, family: familyState,
        navigation: { activity: openActivity ? 'available' : 'unavailable', groups: openGroups ? 'available' : 'unavailable' } };
    },
    getRecovery: () => ({ membership: membership.getRecovery(), family: family?.getRecovery() ?? null }),
    subscribe(listener) {
      if (!disposed) listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    load: () => run(() => membership.load()),
    purchase: productId => run(() => membership.purchase(productId)),
    restore: () => run(() => membership.restore()),
    redeem: code => run(() => membership.redeem(code)),
    manageSubscriptions: () => run(() => membership.manageSubscriptions()),
    checkAgain: () => run(() => membership.checkAgain()),
    loadFamily: () => run(async () => { await family?.load(); }),
    acceptFamilyInvitation: invitationId => run(async () => { await family?.acceptInvitation(invitationId); }),
    createFamily: () => run(async () => { await family?.createFamily(); }),
    inviteFamilyAccount: inviteeAccountId => run(async () => { await family?.inviteAccount(inviteeAccountId); }),
    revokeFamilyInvitation: invitationId => run(async () => { await family?.revokeInvitation(invitationId); }),
    removeFamilyMember: memberAccountId => run(async () => { await family?.removeMember(memberAccountId); }),
    leaveFamily: () => run(async () => { await family?.leaveFamily(); }),
    checkFamilyAgain: () => run(async () => { await family?.checkAgain(); }),
    openActivity: () => navigate(openActivity),
    openGroups: () => navigate(openGroups),
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribeMembership();
      unsubscribeFamily?.();
      membership.dispose();
      family?.dispose();
      listeners.clear();
    },
  };
}
