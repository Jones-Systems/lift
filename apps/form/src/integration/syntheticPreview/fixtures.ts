import type { NativePrescription, SourceUnknownLoad, SourceWorkoutSession } from '../../api/domain';
import type {
  CommunityGroup, CommunityGroupDetail, CommunityMember, CommunityReadState,
  CommunityGroupCommandState, CommunityViewError,
} from '../../api/community';
import type { SourceRest } from '../../features/training/source-rest';
import type { FixtureCase, Frozen, PreviewDenial, PreviewIdentity } from '../../features/syntheticPreviewContract';

export type PreviewCommand = Frozen<Pick<CommunityGroupCommandState, 'status' | 'kind' | 'error'> & {
  uncertainty: 'none' | 'current' | 'original';
}>;

export type RestFixture = Frozen<{
  kind: 'rest'; identity: PreviewIdentity; scenario: 'rest-running' | 'rest-paused';
  source: {
    session: { sessionId: string; sessionRevision: number; planId: string; planRevision: number;
      sessionStatus: SourceWorkoutSession['status'] };
    occurrence: Pick<SourceWorkoutSession['occurrences'][number], 'id' | 'itemId' | 'exerciseId' | 'position'>;
    prescription: Pick<NativePrescription, 'rest_seconds'>;
    prescribedLoad: SourceUnknownLoad;
  };
  restSeed: SourceRest;
}>;

export type CommunityFixture = Frozen<{
  kind: 'com01'; identity: PreviewIdentity;
  scenario: Exclude<FixtureCase, 'rest-running' | 'rest-paused'>;
  authority: 'none'; productionActions: 'denied';
  selectedGroupId: string; selectedMemberId: string;
  groups: CommunityReadState<readonly CommunityGroup[]>;
  detail: CommunityReadState<CommunityGroupDetail>;
  command: PreviewCommand;
}>;

export type PreviewFixture = RestFixture | CommunityFixture;

const groupId = '11111111-1111-4111-8111-111111111111';
const actorId = '22222222-2222-4222-8222-222222222222';
const targetId = '33333333-3333-4333-8333-333333333333';

function identity(): PreviewIdentity {
  return { kind: 'synthetic', fixtureSet: 'form.training-community.preview/v1', fixtureRevision: 1,
    accountId: 'synthetic:form-training-community:r1', authority: 'none' };
}

function seed(scenario: FixtureCase): PreviewFixture | null {
  if (scenario === 'rest-running' || scenario === 'rest-paused') {
    return { kind: 'rest', identity: identity(), scenario,
      source: {
        session: { sessionId: 'fixture-session-practice-1', sessionRevision: 1,
          planId: 'fixture-plan-practice-1', planRevision: 2, sessionStatus: 'active' },
        occurrence: { id: 'fixture-occurrence-practice-1', itemId: 'fixture-item-practice-1',
          exerciseId: 'fixture-exercise-practice-1', position: 1 },
        prescription: { rest_seconds: 90 }, prescribedLoad: { kind: 'unspecified', basis: 'unknown' },
      },
      // Projection at 23500 ms after a 1000 ms start; this seed runs no clock or countdown.
      restSeed: { occurrenceId: 'fixture-occurrence-practice-1', durationSeconds: 90,
        remainingMs: 67500, status: scenario === 'rest-running' ? 'running' : 'paused' },
    };
  }
  let role: CommunityMember['role'];
  switch (scenario) {
    case 'com01-owner-current': case 'com01-stale': role = 'owner'; break;
    case 'com01-admin-current': role = 'admin'; break;
    case 'com01-member-current': role = 'member'; break;
    default: return null;
  }
  const group: CommunityGroup = { id: groupId, name: 'Synthetic preview group', revision: 4, role, memberId: actorId };
  const detail: CommunityGroupDetail = { ...group, members: [
    { memberId: actorId, alias: 'Synthetic actor', role, revision: 7 },
    { memberId: targetId, alias: 'Synthetic target', role: 'member', revision: 9 },
  ] };
  return { kind: 'com01', identity: identity(), scenario, authority: 'none', productionActions: 'denied',
    selectedGroupId: groupId, selectedMemberId: targetId,
    groups: { status: 'ready', groupId: null, data: [group], error: null },
    detail: scenario === 'com01-stale'
      ? { status: 'stale', groupId, data: null, error: null }
      : { status: 'ready', groupId, data: detail, error: null },
    command: { status: 'idle', kind: null, error: null, uncertainty: 'none' },
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Only exact compiled DTO shapes are accepted, including array order and unique member rows. */
function same(value: unknown, expected: unknown): boolean {
  if (expected === null || typeof expected !== 'object') return value === expected;
  if (value === null || typeof value !== 'object' || Array.isArray(value) !== Array.isArray(expected)) return false;
  const actual = Object.getOwnPropertyDescriptors(value);
  const wanted = Object.getOwnPropertyDescriptors(expected);
  const keys = Reflect.ownKeys(actual);
  return keys.length === Reflect.ownKeys(wanted).length && keys.every(key =>
    Object.hasOwn(wanted, key) && 'value' in actual[key as string] &&
    same(actual[key as string].value, wanted[key as string].value));
}

/** Detach even the identity and nested read-state rows; provenance is never a live lease. */
export function frozenPreviewCopy<T>(value: T): Frozen<T> {
  if (value === null || typeof value !== 'object') return value as Frozen<T>;
  const copy = Array.isArray(value) ? value.map(child => frozenPreviewCopy(child))
    : Object.fromEntries(Object.entries(value).map(([key, child]) => [key, frozenPreviewCopy(child)]));
  return Object.freeze(copy) as Frozen<T>;
}

export function validatePreviewFixture(value: unknown): PreviewDenial | null {
  try {
    if (!record(value) || !record(value.identity)) return 'invalid_fixture';
    const expectedIdentity = identity();
    if (value.identity.fixtureRevision !== expectedIdentity.fixtureRevision) return 'stale_revision';
    if (!same(value.identity, expectedIdentity)) return 'foreign_identity';
    const expected = seed(value.scenario as FixtureCase);
    if (!expected) return 'invalid_fixture';
    if (expected.kind === 'rest' && record(value.source) && record(value.source.session)) {
      if (value.source.session.sessionRevision !== 1 || value.source.session.planRevision !== 2) return 'stale_revision';
    }
    if (expected.kind === 'com01' && record(value.detail) && record(value.detail.data)) {
      const detail = value.detail.data;
      if (detail.revision !== 4) return 'stale_revision';
      if (Array.isArray(detail.members)) {
        for (const member of detail.members) {
          if (record(member) && ((member.memberId === actorId && member.revision !== 7) ||
              (member.memberId === targetId && member.revision !== 9))) return 'stale_revision';
        }
      }
    }
    if (expected.kind === 'com01') {
      if (!validCommandObservation(value.command)) return 'invalid_fixture';
      return same(value, { ...expected, command: value.command }) ? null : 'invalid_fixture';
    }
    return same(value, expected) ? null : 'invalid_fixture';
  } catch {
    return 'invalid_fixture';
  }
}

/** Fixed data lookup only. It cannot register fixtures or create runtime authority. */
export function previewFixture(scenario: FixtureCase): PreviewFixture | null {
  const value = seed(scenario);
  return value && validatePreviewFixture(value) === null ? frozenPreviewCopy(value) : null;
}

function safeError(value: unknown): value is CommunityViewError {
  return record(value) && typeof value.status === 'number' && Number.isSafeInteger(value.status) &&
    value.status >= 0 && value.status <= 599 && typeof value.code === 'string' &&
    /^[a-z][a-z0-9_]{0,79}$/.test(value.code) && typeof value.effectUnknown === 'boolean' &&
    typeof value.originalEffectUnknown === 'boolean';
}

function validCommandObservation(value: unknown): boolean {
  if (!record(value) || !['none', 'current', 'original'].includes(value.uncertainty as string)) return false;
  const projected = projectPreviewCommand({ status: value.status, kind: value.kind, error: value.error,
    intent: value.uncertainty === 'none' ? null : {
      state: value.uncertainty === 'current' ? 'unknown' : 'rejected',
      originalEffectUnknown: value.uncertainty === 'original',
    },
  });
  return projected !== null && same(value, projected);
}

/** A narrow source observation, never a command port; original uncertainty takes precedence. */
export function projectPreviewCommand(value: unknown): PreviewCommand | null {
  if (!record(value) || !['idle', 'pending', 'confirmed', 'error'].includes(value.status as string) ||
      (value.kind !== null && value.kind !== 'role') ||
      (value.status !== 'idle' && value.kind !== 'role')) return null;
  const error = value.error;
  if (error !== null && !safeError(error)) return null;
  const intent = value.intent;
  if (intent !== null && (!record(intent) || !['pending', 'unknown', 'rejected', 'confirmed'].includes(intent.state as string) ||
      typeof intent.originalEffectUnknown !== 'boolean')) return null;
  if ((value.status === 'error') !== (error !== null) ||
      (value.status === 'idle' && (value.kind !== null || intent !== null))) return null;
  const sourceError = error as CommunityGroupCommandState['error'];
  const sourceIntent = intent as Pick<NonNullable<CommunityGroupCommandState['intent']>, 'state' | 'originalEffectUnknown'> | null;
  return frozenPreviewCopy({ status: value.status as PreviewCommand['status'], kind: value.kind as 'role' | null,
    error: sourceError === null ? null : { status: sourceError.status, code: sourceError.code,
      effectUnknown: sourceError.effectUnknown, originalEffectUnknown: sourceError.originalEffectUnknown },
    uncertainty: sourceIntent?.originalEffectUnknown || sourceError?.originalEffectUnknown ? 'original'
      : sourceIntent?.state === 'unknown' || sourceError?.effectUnknown ? 'current' : 'none',
  } as const);
}

export function previewRoleDenial(fixture: CommunityFixture): PreviewDenial | null {
  const invalid = validatePreviewFixture(fixture);
  if (invalid) return invalid;
  const { groups, detail, command } = fixture;
  if (groups.status !== 'ready' || detail.status !== 'ready' || detail.groupId !== fixture.selectedGroupId ||
      detail.data.id !== fixture.selectedGroupId) return 'not_current';
  if (command.status === 'pending' || command.status === 'error' || command.uncertainty !== 'none') return 'command_unresolved';
  const actor = detail.data.members.find(member => member.memberId === detail.data.memberId);
  const target = detail.data.members.find(member => member.memberId === fixture.selectedMemberId);
  return actor?.role === 'owner' && target && target.role !== 'owner' ? null : 'role_not_eligible';
}
