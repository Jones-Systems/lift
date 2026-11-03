import type { FixtureCase, PreviewDenial, PreviewFence, PreviewResult } from '../../features/syntheticPreviewContract';
import type { COM01GroupListProps, COM01MembersProps, COM01RoleStateProps,
  COM01RoleState, RolePreviewIntent } from '../../community/group-ui/contracts';
import type { SourceWorkoutViewProps, ForegroundRestState } from '../../features/training/source-ui/contracts';
import { createSourceRest, monotonicRestTiming } from '../../features/training/source-rest';
import type { RestTiming } from '../../features/training/source-rest';
import { bindSyntheticPreview, openSyntheticPreview } from './admission';
import type { PreviewHost } from './admission';
import { frozenPreviewCopy, previewRoleDenial } from './fixtures';
import type { CommunityFixture, PreviewFixture } from './fixtures';

export type Presentation =
  | Readonly<{ kind: 'denied'; reason: PreviewDenial }>
  | Readonly<{ kind: 'rest'; props: SourceWorkoutViewProps }>
  | Readonly<{ kind: 'groups'; props: COM01GroupListProps }>
  | Readonly<{ kind: 'members'; props: COM01MembersProps }>
  | Readonly<{ kind: 'role'; props: COM01RoleStateProps; underlay: COM01MembersProps }>;

const ignored = (reason: PreviewDenial): PreviewResult => Object.freeze({ status: 'ignored', reason });
const previewed = (): PreviewResult => Object.freeze({ status: 'previewed', effect: 'local-only' });
const sameFence = (a: PreviewFence, b: PreviewFence) => a.scenario === b.scenario &&
  a.sessionGeneration === b.sessionGeneration && a.presentationGeneration === b.presentationGeneration &&
  a.selectionGeneration === b.selectionGeneration && a.identity.kind === b.identity.kind &&
  a.identity.accountId === b.identity.accountId && a.identity.fixtureSet === b.identity.fixtureSet &&
  a.identity.fixtureRevision === b.identity.fixtureRevision && a.identity.authority === b.identity.authority;

/** Call from committed host setup only. DTOs and injected clocks cannot mint admission. */
export function createPreviewPresentation(changed: (view: Presentation) => void,
  runtime: RestTiming = monotonicRestTiming) {
  let host: PreviewHost | null = null, fixture: PreviewFixture | null = null, fence: PreviewFence | null = null;
  let closed: PreviewDenial | null = null, revision = 0, stage: 'groups' | 'members' | 'role' = 'groups';
  let groupId: string | null = null, memberId: string | null = null, underlay: COM01MembersProps | null = null;
  let rest: ReturnType<typeof createSourceRest> | null = null;
  let restFailure: PreviewDenial | null = null;
  let view: Presentation = Object.freeze({ kind: 'denied', reason: 'not_current' });
  let publishing = false;

  const stop = (reason: PreviewDenial) => {
    if (closed) return;
    closed = reason; revision++;
    rest?.dispose(); rest = null;
    host?.dispose();
    view = Object.freeze({ kind: 'denied', reason });
    changed(view);
  };
  const check = (capturedHost = host, capturedFence = fence, capturedRevision = revision): PreviewDenial | null => {
    if (closed) return closed;
    if (!capturedHost || !capturedFence || capturedHost !== host || capturedRevision !== revision) return 'selection_changed';
    const snapshot = capturedHost.snapshot();
    if (snapshot.status === 'ignored') { stop(snapshot.reason); return snapshot.reason; }
    if (!sameFence(snapshot.fence, capturedFence)) { stop('presentation_changed'); return 'presentation_changed'; }
    return null;
  };
  const bind = (expectedScenario?: FixtureCase): PreviewDenial | null => {
    const entry = openSyntheticPreview();
    if (entry.admission.status !== 'admitted') return entry.admission.status === 'denied' ? entry.admission.reason : 'not_current';
    const binding = bindSyntheticPreview(entry.instance);
    if (binding.status !== 'bound') return binding.reason;
    const snapshot = binding.host.snapshot();
    if (snapshot.status !== 'current') { binding.host.dispose(); return snapshot.reason; }
    if (expectedScenario && snapshot.fence.scenario !== expectedScenario) {
      binding.host.invalidateSelection(); binding.host.dispose(); return 'selection_changed';
    }
    host = binding.host; fixture = snapshot.fixture; fence = snapshot.fence;
    return null;
  };
  const currentDetail = (data: CommunityFixture) => {
    if (data.detail.status !== 'ready' || data.groups.status !== 'ready' ||
        groupId !== data.selectedGroupId || data.detail.groupId !== groupId || data.detail.data.id !== groupId) return null;
    const detail = data.detail.data;
    const own = detail.members.filter(row => row.memberId === detail.memberId);
    const group = data.groups.data.filter(row => row.id === groupId);
    if (own.length !== 1 || own[0].role !== detail.role || group.length !== 1 ||
        group[0].memberId !== detail.memberId || group[0].role !== detail.role ||
        group[0].revision !== detail.revision || new Set(detail.members.map(row => row.memberId)).size !== detail.members.length) return null;
    return detail;
  };
  const idle = (data: CommunityFixture) => data.command.status === 'idle' && data.command.error === null &&
    data.command.uncertainty === 'none' && (data.command.kind === null || data.command.kind === 'role');

  function publish() {
    if (publishing || check() || !fixture || !fence || !host) return;
    publishing = true;
    const originalHost = host, originalFence = fence, originalRevision = revision;
    const capturedGroup = groupId, capturedMember = memberId, capturedStage = stage;
    const guard = () => check(originalHost, originalFence, originalRevision) ??
      (capturedGroup !== groupId || capturedMember !== memberId || capturedStage !== stage ? 'selection_changed' : null);
    const onClose = () => { if (!guard()) { originalHost.close(); stop('not_current'); } };
    // Replacement expires the original capability before any new props can be published.
    const replace = (selection: () => void): PreviewResult => {
      const reason = guard(); if (reason) return ignored(reason);
      originalHost.invalidateSelection(); originalHost.dispose(); revision++;
      const denied = bind(originalFence.scenario);
      if (denied) { stop(denied); return ignored(denied); }
      selection(); publish(); return previewed();
    };
    const onReloadFixture = () => {
      const reason = guard(); if (reason) return ignored(reason);
      if (fixture?.kind !== 'com01') return ignored('unsupported_state');
      // This requests the same fixed local snapshot, preserving its command observation.
      return replace(() => {});
    };
    if (fixture.kind === 'rest') {
      const act = (operation: 'pause' | 'resume'): PreviewResult => {
        const reason = guard(); if (reason) return ignored(reason);
        const value = rest?.snapshot();
        if (!value || value.status !== (operation === 'pause' ? 'running' : 'paused')) return ignored('unsupported_state');
        publishing = true;
        let success = false;
        try { success = rest![operation](); }
        catch { restFailure = 'unsupported_state'; rest?.dispose(); }
        finally { publishing = false; }
        const expired = guard(); if (expired) return ignored(expired);
        revision++;
        if (!success) {
          // The helper has no diagnostic reason; false alone does not prove clock failure.
          restFailure = rest?.snapshot()?.status === 'finished' ? null : 'unsupported_state';
          if (restFailure) rest?.dispose();
        }
        publish();
        return success ? previewed() : ignored(restFailure ?? 'unsupported_state');
      };
      const value = rest?.snapshot();
      let state: ForegroundRestState;
      if (restFailure) state = { status: 'unavailable', value: null, reason: restFailure };
      else if (!value) state = { status: 'unavailable', value: null, reason: 'clock_unavailable' };
      else if (value.status === 'finished') state = { status: 'unavailable', value: null, reason: 'rest_finished' };
      else if (value.status === 'running') state = { status: 'running', value: { ...value, status: 'running' }, onPause: () => act('pause') };
      else state = { status: 'paused', value: { ...value, status: 'paused' }, onResume: () => act('resume') };
      view = { kind: 'rest', props: { fence, context: fixture.source, rest: state, onClose } };
    } else {
      const data = fixture;
      const common = { fence, authority: 'none', productionActions: 'denied', onClose } as const;
      if (stage === 'groups') {
        view = { kind: 'groups', props: { ...common, groups: data.groups, onReloadFixture,
          onSelectGroup(id) {
            const reason = guard(); if (reason) return ignored(reason);
            if (data.groups.status !== 'ready' || id !== data.selectedGroupId ||
                data.groups.data.filter(row => row.id === id).length !== 1) return ignored('not_current');
            return replace(() => { groupId = id; memberId = null; stage = 'members'; });
          } } };
      } else {
        const members: COM01MembersProps = { ...common, selectedGroupId: groupId!, detail: data.detail,
          command: data.command, onReloadFixture,
          onSelectMember(id) {
            const reason = guard(); if (reason) return ignored(reason);
            const detail = currentDetail(data);
            if (!detail) return ignored('not_current');
            if (!idle(data)) return ignored('command_unresolved');
            const target = detail.members.filter(row => row.memberId === id);
            if (id !== data.selectedMemberId || id === detail.memberId || target.length !== 1) return ignored('selection_changed');
            return replace(() => { memberId = id; stage = 'role'; underlay = Object.freeze(members); });
          } };
        if (stage === 'members') view = { kind: 'members', props: members };
        else {
          const detail = currentDetail(data);
          const target = detail?.members.find(row => row.memberId === memberId);
          let roleState: COM01RoleState = { status: 'not-current', subject: null,
            reason: data.detail.status === 'stale' ? 'stale' : 'not_current' };
          if (detail && target && memberId === data.selectedMemberId && underlay) {
            const subject = frozenPreviewCopy({ group: { id: detail.id, name: detail.name, role: detail.role,
              memberId: detail.memberId, revision: detail.revision }, target, currentness: 'fixture-current' } as const);
            const denial = previewRoleDenial(data);
            if (denial === 'role_not_eligible' || denial === 'command_unresolved') roleState = { status: 'denied', subject, reason: denial };
            else if (!denial && idle(data)) roleState = { status: 'current', subject,
              eligibility: 'owner-to-non-owner-fixture', onPreviewRoleChange(intent: RolePreviewIntent) {
                const reason = guard(); if (reason) return ignored(reason);
                const actual = currentDetail(data), row = actual?.members.find(item => item.memberId === memberId);
                if (!actual || !row || !idle(data)) return ignored('not_current');
                if (intent.groupId !== groupId || intent.memberId !== memberId) return ignored('selection_changed');
                if (intent.expectedGroupRevision !== actual.revision || intent.expectedMemberRevision !== row.revision) return ignored('stale_revision');
                const expired = guard(); if (expired) return ignored(expired);
                const result = originalHost.previewRoleChange(intent);
                if (result.status === 'previewed') { revision++; publish(); }
                return result;
              } };
          }
          view = underlay ? { kind: 'role', props: { ...common, roleState, command: data.command, onReloadFixture }, underlay }
            : { kind: 'denied', reason: 'not_current' };
        }
      }
    }
    if (view.kind === 'rest') {
      if (view.props.rest.value) Object.freeze(view.props.rest.value);
      Object.freeze(view.props.rest);
    }
    if (view.kind === 'role') Object.freeze(view.props.roleState);
    if (view.kind !== 'denied') Object.freeze(view.props);
    view = Object.freeze(view); publishing = false; changed(view);
  }

  function initialize() {
    const denied = bind();
    if (denied) stop(denied);
    else if (fixture?.kind === 'rest') {
      const data = fixture, owner = host!, ownerFence = fence!;
      let seeding = true, seedNow = 1000, seedTick: (() => void) | null = null;
      let baseNow = NaN, baseWall = NaN;
      let subscribed: { tick: () => void; cleanup: (() => void) | null; live: boolean } | null = null;
      const live = () => check(owner, ownerFence, revision) === null;
      const timing: RestTiming = {
        now: () => seeding ? seedNow : 23500 + (runtime.now() - baseNow),
        wallNow: () => seeding ? seedNow : 23500 + (runtime.wallNow() - baseWall),
        subscribe(tick) {
          const item = { tick, cleanup: null as (() => void) | null, live: true };
          subscribed = item; seedTick = tick;
          if (!seeding) item.cleanup = runtime.subscribe(() => { if (item.live && live()) tick(); });
          return () => { item.live = false; item.cleanup?.(); if (subscribed === item) subscribed = null; };
        },
      };
      publishing = true;
      rest = createSourceRest([{ id: data.source.occurrence.id,
        target: { native: { rest_seconds: data.source.prescription.rest_seconds } } }],
      // Rest actions change the prop revision, but retain the same original admitted helper.
      () => check(owner, ownerFence, revision) === null, () => { if (!publishing) publish(); }, timing);
      try {
        if (!rest.start(data.source.occurrence.id)) restFailure = 'unsupported_state';
        seedNow = 23500;
        (seedTick as (() => void) | null)?.();
        if (data.scenario === 'rest-paused' && !rest.pause()) restFailure = 'unsupported_state';
        baseNow = runtime.now(); baseWall = runtime.wallNow();
        seeding = false;
        if (!Number.isFinite(baseNow) || baseNow < 0 || !Number.isFinite(baseWall) || baseWall < 0) restFailure = 'clock_unavailable';
        if (restFailure) rest.dispose();
        else {
          const item = subscribed as { tick: () => void; cleanup: (() => void) | null; live: boolean } | null;
          if (item) item.cleanup = runtime.subscribe(() => {
            if (item.live && check(owner, ownerFence, revision) === null) item.tick();
          });
        }
      } catch { restFailure = 'clock_unavailable'; rest.dispose(); }
      publishing = false; publish();
    } else publish();
  }
  initialize();

  return Object.freeze({
    snapshot: () => view,
    leaveForeground() { host?.leaveForeground(); stop('not_foreground'); },
    invalidateSession() { host?.invalidateSession(); stop('session_changed'); },
    invalidatePresentation() { host?.invalidatePresentation(); stop('presentation_changed'); },
    dispose() { host?.dispose(); stop('not_current'); },
  });
}
