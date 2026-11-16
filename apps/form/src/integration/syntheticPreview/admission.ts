import type {
  PreviewAdmission, PreviewDenial, PreviewFence, PreviewResult,
} from '../../features/syntheticPreviewContract';
import { readSyntheticPreviewSelection } from './entry';
import {
  frozenPreviewCopy, previewFixture, previewRoleDenial, validatePreviewFixture,
} from './fixtures';
import type { PreviewFixture } from './fixtures';

export type PreviewEntry = Readonly<{ admission: PreviewAdmission; instance: object | null }>;
export type LocalRoleIntent = Readonly<{
  groupId: string; expectedGroupRevision: number; memberId: string;
  expectedMemberRevision: number; role: 'admin' | 'member';
}>;
type RoleObservation = Readonly<{ memberId: string; role: 'admin' | 'member' }>;
export type PreviewSnapshot =
  | Readonly<{ status: 'ignored'; reason: PreviewDenial }>
  | Readonly<{ status: 'current'; fence: PreviewFence; fixture: PreviewFixture;
      rolePreview: RoleObservation | null }>;

export type PreviewHost = Readonly<{
  check(): PreviewResult;
  snapshot(): PreviewSnapshot;
  previewRoleChange(intent: LocalRoleIntent): PreviewResult;
  invalidateSession(): void;
  invalidatePresentation(): void;
  invalidateSelection(): void;
  leaveForeground(): void;
  close(): void;
  dispose(): void;
}>;

type Lease = {
  fence: PreviewFence; fixture: PreviewFixture; closed: PreviewDenial | null;
  rolePreview: RoleObservation | null;
};
const instances = new WeakMap<object, Lease>();
let current: Lease | null = null;
let generation = 0;

function ignored(reason: PreviewDenial): Extract<PreviewResult, { status: 'ignored' }> {
  return Object.freeze({ status: 'ignored', reason });
}
function previewed(): PreviewResult { return Object.freeze({ status: 'previewed', effect: 'local-only' }); }

function invalidate(lease: Lease, reason: PreviewDenial): void {
  lease.closed ??= reason;
  lease.rolePreview = null;
  if (current === lease) current = null;
}

/** Captured leases expire permanently; a matching later selector cannot restore one. */
function denial(lease: Lease): PreviewDenial | null {
  if (lease.closed) return lease.closed;
  let reason: PreviewDenial | null = current === lease ? null : 'not_current';
  const selection = readSyntheticPreviewSelection();
  if (!reason && selection.status === 'denied') reason = selection.reason;
  if (!reason && selection.status === 'off') reason = 'not_current';
  if (!reason && selection.status === 'selected' && selection.scenario !== lease.fence.scenario) reason = 'selection_changed';
  if (!reason) reason = validatePreviewFixture(lease.fixture);
  if (!reason && (lease.fixture.identity.accountId !== lease.fence.identity.accountId ||
      lease.fixture.identity.fixtureSet !== lease.fence.identity.fixtureSet ||
      lease.fixture.identity.kind !== lease.fence.identity.kind ||
      lease.fixture.identity.authority !== lease.fence.identity.authority)) reason = 'foreign_identity';
  if (!reason && lease.fixture.identity.fixtureRevision !== lease.fence.identity.fixtureRevision) reason = 'stale_revision';
  if (reason) invalidate(lease, reason);
  return reason;
}

/** No parameters: only the trusted entry and compiled fixtures can mint a private instance. */
export function openSyntheticPreview(): PreviewEntry {
  const selection = readSyntheticPreviewSelection();
  if (current) invalidate(current, selection.status === 'denied' ? selection.reason
    : selection.status === 'off' ? 'not_current'
    : selection.scenario !== current.fence.scenario ? 'selection_changed' : 'presentation_changed');
  if (selection.status !== 'selected') return Object.freeze({ admission: selection, instance: null });
  const fixture = previewFixture(selection.scenario);
  if (!fixture || validatePreviewFixture(fixture) !== null || !Number.isSafeInteger(generation + 1)) {
    return Object.freeze({ admission: Object.freeze({ status: 'denied', reason: 'invalid_fixture' }), instance: null });
  }
  generation += 1;
  const fence: PreviewFence = frozenPreviewCopy({ identity: fixture.identity, scenario: selection.scenario,
    sessionGeneration: `synthetic-preview:${generation}`, presentationGeneration: generation, selectionGeneration: generation });
  const lease: Lease = { fence, fixture, closed: null, rolePreview: null };
  const instance = Object.freeze({});
  instances.set(instance, lease);
  current = lease;
  // The DTO and its fence are detached provenance. Only the separately minted instance binds a host.
  return Object.freeze({ admission: frozenPreviewCopy({ status: 'admitted', fence } as const), instance });
}

export function bindSyntheticPreview(instance: unknown):
  | Readonly<{ status: 'ignored'; reason: PreviewDenial }>
  | Readonly<{ status: 'bound'; host: PreviewHost }> {
  const lease = instance !== null && typeof instance === 'object' ? instances.get(instance) : undefined;
  if (!lease) return ignored('foreign_identity');
  const invalid = denial(lease);
  if (invalid) return ignored(invalid);
  const host: PreviewHost = Object.freeze({
    check(): PreviewResult {
      const reason = denial(lease);
      return reason ? ignored(reason) : previewed();
    },
    snapshot(): PreviewSnapshot {
      const reason = denial(lease);
      return reason ? ignored(reason) : frozenPreviewCopy({ status: 'current', fence: lease.fence,
        fixture: lease.fixture, rolePreview: lease.rolePreview } as const);
    },
    previewRoleChange(intent: LocalRoleIntent): PreviewResult {
      const reason = denial(lease);
      if (reason) return ignored(reason);
      if (lease.fixture.kind !== 'com01') return ignored('unsupported_state');
      const eligibility = previewRoleDenial(lease.fixture);
      if (eligibility) return ignored(eligibility);
      if (intent === null || typeof intent !== 'object' ||
          Object.keys(intent).length !== 5 || !['groupId', 'expectedGroupRevision', 'memberId', 'expectedMemberRevision', 'role']
            .every(key => Object.hasOwn(intent, key))) return ignored('invalid_fixture');
      const { groupId, expectedGroupRevision, memberId, expectedMemberRevision, role } = intent;
      if (groupId !== lease.fixture.selectedGroupId || memberId !== lease.fixture.selectedMemberId) return ignored('selection_changed');
      if (role !== 'admin' && role !== 'member') return ignored('role_not_eligible');
      const detail = lease.fixture.detail;
      if (detail.status !== 'ready') return ignored('not_current');
      const target = detail.data.members.find(member => member.memberId === memberId);
      if (!target || expectedGroupRevision !== detail.data.revision || expectedMemberRevision !== target.revision) return ignored('stale_revision');
      const expired = denial(lease);
      if (expired) return ignored(expired);
      // Keep simulation separate from immutable source rows and their domain revisions.
      lease.rolePreview = frozenPreviewCopy({ memberId, role });
      return previewed();
    },
    invalidateSession(): void { invalidate(lease, 'session_changed'); },
    invalidatePresentation(): void { invalidate(lease, 'presentation_changed'); },
    invalidateSelection(): void { invalidate(lease, 'selection_changed'); },
    // The future host must call these synchronously on non-active AppState and unmount.
    leaveForeground(): void { invalidate(lease, 'not_foreground'); },
    close(): void { invalidate(lease, 'not_current'); },
    dispose(): void { invalidate(lease, 'not_current'); },
  });
  return Object.freeze({ status: 'bound', host });
}
