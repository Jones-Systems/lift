import type Database from 'better-sqlite3';
import { DomainError } from '../errors.js';
import type { AccountContext, AdultEligibility, LifecycleBindings } from '../lifecycle/types.js';
import { createCommunity, type CommunityService } from './service.js';
import { createCommunityExtension, type CommunityExtensionService } from './extension-service.js';
import { createFeatureBoard, type FeatureBoardService } from './board/service.js';
import { createCommunityLifecycleAdapter } from './lifecycle.js';
import { createCommunityExtensionLifecycleAdapter } from './extension-lifecycle.js';
import { createFeatureBoardLifecycleAdapter } from './board/lifecycle.js';
import { createComposedCommunityLifecycleAdapter } from './composed-lifecycle.js';
import type { AuthoritativeRestoreState, CommunityDependencies } from './types.js';
import type { ExtensionDependencies } from './extension-types.js';
import type { BoardDependencies } from './board/types.js';
import { snapshot as batchSnapshot, parse } from './extension-schemas.js';

export type CommunityIntegrationDependencies = Readonly<{
  db: Database.Database;
  now: () => Date;
  lifecycle: LifecycleBindings;
  subjectEligibility?: (accountId: string) => AdultEligibility;
  parent?: Omit<CommunityDependencies, 'db' | 'now' | 'lifecycle' | 'subjectEligibility' | 'extension'>;
  extension?: Omit<ExtensionDependencies, 'db' | 'now' | 'lifecycle' | 'subjectEligibility'>;
  board?: Omit<BoardDependencies, 'db' | 'now' | 'lifecycle' | 'subjectEligibility' | 'isBlocked'>;
}>;
export type CommunityIntegrationServices = Readonly<{ community: CommunityService; extension: CommunityExtensionService; board: FeatureBoardService }>;
const restoreTables = [
  'community_groups', 'community_members', 'community_share_settings', 'community_invitations', 'community_command_receipts',
  'community_group_policy', 'community_match_enrollments', 'community_match_runs', 'community_match_assignments', 'community_profile_shares', 'community_blocks',
  'community_motions', 'community_motion_electorate', 'community_ballots', 'community_seat_reservations', 'community_posts', 'community_reactions',
  'community_safety_references', 'community_reports', 'community_safety_notices', 'community_appeals', 'community_post_cursors', 'community_extension_receipts',
  'community_board_features', 'community_board_submissions', 'community_board_aliases', 'community_board_votes', 'community_board_vote_events',
  'community_board_merge_events', 'community_board_status_events', 'community_board_command_receipts', 'community_board_quota_events', 'community_board_correction_events',
] as const;
const accountColumns = new Set(['account_id', 'owner_account_id', 'issuer_account_id', 'redeemed_account_id', 'subject_account_id', 'sponsor_account_id', 'author_account_id', 'actor_account_id']);

// The caller supplies the authoritative ledger view and owns the already-open writer.
export function reconcileCommunityIntegrationRestore(db: Database.Database, services: CommunityIntegrationServices, authority: AuthoritativeRestoreState): Readonly<{
  parent: { invitationsRevoked: number; sharesReset: number };
  board: { submissionsHidden: number; votesReset: number };
  suppressed: number;
}> {
  if (!db.inTransaction || authority?.ready !== true || typeof authority.lookup !== 'function') throw new DomainError(503, 'community_restore_authority_required');
  const projections: string[] = [];
  for (const table of restoreTables) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!columns.length && table === 'community_board_correction_events') continue;
    if (!columns.length) throw new DomainError(503, 'community_restore_schema_unavailable');
    for (const column of columns) if (accountColumns.has(column.name)) projections.push(`SELECT ${column.name} account_id FROM ${table} WHERE ${column.name} IS NOT NULL`);
  }
  const query = projections.join(' UNION ');
  const bound = db.prepare(`SELECT count(*) n FROM (${query})`).get() as { n: number };
  if (bound.n > 1000) throw new DomainError(413, 'community_restore_capacity');
  const accounts = db.prepare(`${query} LIMIT 1001`).all() as { account_id: string }[];
  const accountIds = new Set(accounts.map(row => row.account_id));
  const runBound = db.prepare('SELECT count(*) n,coalesce(sum(length(CAST(snapshot AS BLOB))),0) bytes FROM community_match_runs').get() as { n: number; bytes: number };
  if (runBound.n > 200 || runBound.bytes > 2097152) throw new DomainError(413, 'community_restore_capacity');
  for (const run of db.prepare('SELECT snapshot FROM community_match_runs LIMIT 201').iterate() as Iterable<{ snapshot: string }>) {
    if (Buffer.byteLength(run.snapshot) > 524288) throw new DomainError(413, 'community_restore_capacity');
    let decoded: unknown;
    try { decoded = JSON.parse(run.snapshot); } catch { throw new DomainError(503, 'community_restore_snapshot_unproved'); }
    const snapshot = parse(batchSnapshot, decoded);
    for (const candidate of snapshot.candidates) accountIds.add(candidate.accountId);
    for (const pair of snapshot.excludedPairs) for (const id of pair) accountIds.add(id);
    if (accountIds.size > 1000) throw new DomainError(413, 'community_restore_capacity');
  }
  const states = new Map<string, { state: 'active' | 'suppressed'; epoch: number }>();
  for (const accountId of accountIds) {
    const state = authority.lookup(accountId);
    if (!state || !['active', 'suppressed'].includes(state.state) || !Number.isSafeInteger(state.epoch) || state.epoch < 0)
      throw new DomainError(503, 'community_restore_authority_required');
    states.set(accountId, Object.freeze({ ...state }));
  }
  const resolved: AuthoritativeRestoreState = { ready: true, lookup: accountId => states.get(accountId) };
  const suppressed = [...states].filter(([, state]) => state.state === 'suppressed').map(([accountId, state]) => ({ accountId, epoch: state.epoch }));
  const parent = services.community.reconcileCommunityRestore(resolved);
  services.extension.restoreBarrier({ ready: true, suppressed });
  const board = services.board.reconcileRestore(resolved);
  for (const entry of suppressed) {
    const readback = [services.community.verifySuppressed(entry.accountId, entry.epoch), services.extension.verifySuppressed(entry.accountId, entry.epoch), services.board.verifySuppressed(entry.accountId, entry.epoch)];
    if (readback.some(value => !value)) throw new DomainError(503, 'community_restore_suppression_unproved');
  }
  return { parent, board, suppressed: suppressed.length };
}

export function createCommunityIntegration(deps: CommunityIntegrationDependencies, actor?: AccountContext) {
  const identity = actor ? Object.freeze({ ...actor }) : undefined;
  const lifecycle: LifecycleBindings = identity ? {
    assertActive: context => { assertIdentity(context, identity); deps.lifecycle.assertActive(identity); },
    withActiveWrite: (context, effect) => { assertIdentity(context, identity); return deps.lifecycle.withActiveWrite(identity, effect); },
    adultEligibility: context => { assertIdentity(context, identity); return deps.lifecycle.adultEligibility(identity); },
  } : deps.lifecycle;
  const common = { db: deps.db, now: deps.now, lifecycle, ...(deps.subjectEligibility ? { subjectEligibility: deps.subjectEligibility } : {}) };
  const extension = createCommunityExtension({ ...deps.extension, ...common, assertReservedJoin: input => {
    lifecycle.assertActive(input.actor);
    const invite = deps.db.prepare("SELECT 1 FROM community_invitations WHERE id=? AND group_id=? AND state='pending' AND expires_at>?").get(input.invitationId, input.groupId, deps.now().toISOString());
    if (!invite) throw new DomainError(404, 'community_invitation_unavailable');
    deps.extension?.assertReservedJoin?.(input);
  } });
  const community = createCommunity({ ...deps.parent, ...common, extension });
  const board = createFeatureBoard({ ...deps.board, ...common, isBlocked: (viewer, authorAccountId) => extension.isBlocked(viewer, authorAccountId) });
  const services = { community, extension, board };
  const assertSerialized = () => { if (!deps.db.inTransaction) throw new DomainError(503, 'community_lifecycle_serialization_required'); };
  const lifecycleAdapter = createComposedCommunityLifecycleAdapter({
    b2: createCommunityLifecycleAdapter(community, { purgeQualified: false }),
    b4: createCommunityExtensionLifecycleAdapter(extension, { purgeQualified: false }),
    b5: createFeatureBoardLifecycleAdapter(board, { retentionAndAuditRedactionQualified: false }),
  }, { assertSerialized, exportBounds: { b2: context => community.exportBounds(context), b4: context => extension.exportBounds(context), b5: context => board.exportBounds(context) } });
  return { ...services, lifecycleAdapter, friendBridge: { status: 'available' as const, issue: community.issueFriendInvitation.bind(community) },
    reconcileRestore: (authority: AuthoritativeRestoreState) => reconcileCommunityIntegrationRestore(deps.db, services, authority) };
}
function assertIdentity(context: AccountContext, identity: AccountContext): void {
  if (context.accountId !== identity.accountId || context.authUserId !== identity.authUserId || context.sessionId !== identity.sessionId || context.epoch !== identity.epoch)
    throw new DomainError(403, 'community_request_scope_mismatch');
}
