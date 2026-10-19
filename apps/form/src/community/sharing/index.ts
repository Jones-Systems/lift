import { CommunityResources, communityShareFields, type CommunityShareFlags, type CommunitySharing,
  type CommunityProfile, type CommunityProfileInput, type CommunitySummary, type CommunityIntentInspection } from '../../api/community';
import { ApiError } from '../../api/transport';

export const privateSharingFlags = (): CommunityShareFlags => Object.freeze({ participation: false, workout: false,
  exerciseSnack: false, planAdherence: false, workoutMinutes: false, exerciseCount: false, streakDays: false });
export const minimalSharingFlags = (): CommunityShareFlags => Object.freeze({ ...privateSharingFlags(), planAdherence: true });
export const privateProfileInput = (expectedRevision: number): CommunityProfileInput => ({ expectedRevision,
  flags: { age: false, sex: false, region: false, avatar: false, adherence: false, ranking: false },
  sexDescription: null, region: null, avatar: null, audiencePreviewAccepted: true });

type Roster = Awaited<ReturnType<CommunityResources['rosterProfiles']>>;
type SharedDay = CommunitySummary['members'][number]['days'][number];
export type SharingMembershipBoundary = Readonly<{ groupId: string; memberId: string;
  role: 'owner' | 'admin' | 'member'; memberRevision: number }>;
export type SharingSelection = Readonly<{ groupId: string; memberId: string; localDate: string }>;
export type FollowedPlanDisclosure = Readonly<{ status: 'shared'; value: NonNullable<SharedDay['planAdherence']> } |
  { status: 'not_shared' | 'unavailable' | 'not_loaded'; value: null }>;
export type SelectedSharingProjection = Readonly<{
  selection: SharingSelection; audience: 'entire_group'; alias: string | null;
  followedPlan: FollowedPlanDisclosure; activity: Readonly<Omit<SharedDay, 'localDate'>>;
  profile: Readonly<Roster[number]['profile']> | null;
  summaryReadStatus: SharingRead<CommunitySummary>['status'];
  profileReadStatus: SharingRead<Roster>['status']; rankings: 'unavailable';
  membershipReadStatus: SharingRead<SharingMembershipBoundary>['status']; membership: SharingMembershipBoundary | null;
}>;
type Data = { sharing: CommunitySharing; profile: CommunityProfile; roster: Roster; summary: CommunitySummary;
  membership: SharingMembershipBoundary };
type Name = keyof Data;
export type SharingError = Readonly<Pick<ApiError, 'status' | 'code' | 'effectUnknown' | 'originalEffectUnknown'>>;
export type SharingRead<T> = Readonly<{ status: 'idle' | 'loading' | 'stale' | 'error'; data: null; error: SharingError | null } |
  { status: 'ready' | 'empty'; data: T; error: null }>;
export type SharingGroup = Readonly<{ [K in Name]: SharingRead<Data[K]> }>;
export type SharingCommand = Readonly<{ status: 'idle' | 'pending' | 'confirmed' | 'error'; key: string | null;
  groupId: string | null; kind: 'sharing' | 'profile' | null; intent: CommunityIntentInspection | null; error: SharingError | null }>;
export type SharingSnapshot = Readonly<{ disposed: boolean; groups: Readonly<Record<string, SharingGroup>>; command: SharingCommand }>;
const idle = () => ({ status: 'idle' as const, data: null, error: null });
const group = (): SharingGroup => ({ sharing: idle(), profile: idle(), roster: idle(), summary: idle(), membership: idle() });
const initial = (disposed = false): SharingSnapshot => ({ disposed, groups: {}, command: {
  status: 'idle', key: null, groupId: null, kind: null, intent: null, error: null } });
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
const failureView = (error: ApiError): SharingError => ({ status: error.status, code: error.code,
  effectUnknown: error.effectUnknown, originalEffectUnknown: error.originalEffectUnknown });

export class SharingConsumer {
  private state = freeze(initial());
  private generations = new Map<string, number>();
  private summaryRanges = new Map<string, Readonly<{ from: string; to: string }>>();
  private membershipBoundaries = new Map<string, SharingMembershipBoundary>();
  private listeners = new Set<() => void>();
  private readonly lifetime;
  private readonly lifetimeSubscription;
  constructor(private readonly resources: CommunityResources) {
    this.lifetime = resources.createGroupController();
    this.lifetimeSubscription = this.lifetime.subscribe(() => {
      if (this.lifetime.getSnapshot().disposed) this.dispose();
    });
  }
  private current(): boolean {
    if (!this.state.disposed && this.lifetime.getSnapshot().disposed) this.dispose();
    return !this.state.disposed;
  }
  private assertCurrent(originalUnknown = false, effectUnknown = false): void {
    if (!this.current()) throw new ApiError(409, 'session_changed', 'This sharing session ended.', effectUnknown, originalUnknown);
  }
  getSnapshot(): SharingSnapshot { this.current(); return this.state; }
  subscribe(listener: () => void): { remove(): void } {
    this.assertCurrent(); this.listeners.add(listener); return { remove: () => { this.listeners.delete(listener); } };
  }
  private publish(state: SharingSnapshot): void {
    this.state = freeze(state);
    for (const listener of this.listeners) { try { listener(); } catch {} }
  }
  dispose(): void {
    if (this.state.disposed) return;
    this.generations.clear(); this.summaryRanges.clear(); this.membershipBoundaries.clear();
    this.publish(initial(true)); this.listeners.clear();
    this.lifetimeSubscription.remove(); this.lifetime.dispose();
  }
  private slot<K extends Name>(groupId: string, name: K, read: SharingRead<Data[K]>): void {
    this.publish({ ...this.state, groups: { ...this.state.groups,
      [groupId]: { ...(this.state.groups[groupId] ?? group()), [name]: read } } });
  }
  private bump(groupId: string, name: Name): number {
    const key = `${groupId}:${name}`, next = (this.generations.get(key) ?? 0) + 1;
    this.generations.set(key, next); return next;
  }
  private async load<K extends Name>(groupId: string, name: K, read: () => Promise<Data[K]>,
    accepted?: (data: Data[K]) => void): Promise<void> {
    this.assertCurrent(); const generation = this.bump(groupId, name);
    this.slot(groupId, name, { status: 'loading', data: null, error: null });
    try {
      const data = await read(); this.assertCurrent();
      if (this.generations.get(`${groupId}:${name}`) !== generation) return;
      accepted?.(data); this.assertCurrent();
      if (this.generations.get(`${groupId}:${name}`) !== generation) return;
      const empty = Array.isArray(data) && !data.length;
      this.slot(groupId, name, { status: empty ? 'empty' : 'ready', data, error: null });
    } catch (error) {
      this.assertCurrent();
      if (this.generations.get(`${groupId}:${name}`) !== generation) return;
      const failure = error instanceof ApiError ? error : new ApiError(0, 'community_read_unavailable', 'Sharing could not be read.');
      if (failure.status === 403) this.invalidateGroup(groupId);
      this.slot(groupId, name, { status: 'error', data: null, error: failureView(failure) }); throw failure;
    }
  }
  loadSharing = (groupId: string) => this.load(groupId, 'sharing', () => this.resources.readSharing(groupId));
  loadProfile = (groupId: string) => this.load(groupId, 'profile', () => this.resources.readProfile(groupId));
  loadRoster = (groupId: string) => this.load(groupId, 'roster', () => this.resources.rosterProfiles(groupId));
  refreshMembership(groupId: string): Promise<void> {
    return this.load(groupId, 'membership', async () => {
      const detail = await this.resources.readGroup(groupId);
      const own = detail.members.find(member => member.memberId === detail.memberId);
      if (!own || own.role !== detail.role)
        throw new ApiError(403, 'community_membership_unavailable', 'Current group membership could not be confirmed.');
      return { groupId, memberId: own.memberId, role: own.role, memberRevision: own.revision };
    }, boundary => {
      const prior = this.membershipBoundaries.get(groupId);
      if (!prior || prior.memberId !== boundary.memberId || prior.role !== boundary.role || prior.memberRevision !== boundary.memberRevision)
        this.invalidateProjections(groupId);
      this.membershipBoundaries.set(groupId, boundary);
    });
  }
  loadSummary = (groupId: string, range: { from: string; to: string }) => {
    this.assertCurrent(); const selectedRange = Object.freeze({ from: range.from, to: range.to });
    this.summaryRanges.set(groupId, selectedRange);
    return this.load(groupId, 'summary', () => this.resources.readSummary(groupId, selectedRange));
  };
  invalidateGroup(groupId: string): void {
    this.assertCurrent();
    this.membershipBoundaries.delete(groupId);
    for (const name of ['sharing', 'profile', 'roster', 'summary', 'membership'] as const) {
      this.assertCurrent();
      this.bump(groupId, name); this.slot(groupId, name, { status: 'stale', data: null, error: null });
    }
  }
  private invalidateProjections(groupId: string): void {
    for (const name of ['sharing', 'profile', 'roster', 'summary'] as const) {
      this.assertCurrent(); this.bump(groupId, name); this.slot(groupId, name, { status: 'stale', data: null, error: null });
    }
  }
  private invalidate(groupId: string, kind: 'sharing' | 'profile'): void {
    for (const name of kind === 'sharing' ? ['sharing', 'summary'] as const : ['profile', 'roster'] as const) {
      this.assertCurrent();
      this.bump(groupId, name); this.slot(groupId, name, { status: 'stale', data: null, error: null });
    }
  }
  private async command<T>(groupId: string, kind: 'sharing' | 'profile', key: string, effect: () => Promise<T>, retry = false): Promise<T> {
    this.assertCurrent(); const prior = this.state.command;
    if (prior.status === 'pending' || prior.intent?.state === 'unknown' && (!retry || key !== prior.key))
      throw new ApiError(409, 'sharing_unresolved_intent', 'Reconcile the retained sharing change first.', false, !!prior.intent?.originalEffectUnknown);
    if (!retry && prior.intent?.disposition === 'reload_before_new_intent' && prior.groupId && prior.kind &&
      this.state.groups[prior.groupId]?.[prior.kind].status !== 'ready')
      throw new ApiError(409, 'sharing_reload_required', 'Reload the rejected change’s settings before a new intent.');
    const pending: SharingCommand = { status: 'pending', groupId, kind, key, intent: null, error: null };
    this.publish({ ...this.state, command: pending }); this.invalidate(groupId, kind);
    try {
      this.assertCurrent();
      const request = effect();
      this.assertCurrent(); this.publish({ ...this.state, command: { ...pending, intent: this.resources.inspectIntent(key) } });
      const result = await request; this.assertCurrent(true); this.invalidate(groupId, kind); this.assertCurrent(true);
      this.publish({ ...this.state, command: { ...pending, status: 'confirmed', intent: this.resources.inspectIntent(key) } }); return result;
    } catch (error) {
      const failure = error instanceof ApiError ? error : new ApiError(0, 'community_outcome_unknown', 'Sharing could not be confirmed.', true, true);
      this.assertCurrent(failure.originalEffectUnknown || failure.effectUnknown, failure.effectUnknown); this.invalidate(groupId, kind);
      if (failure.status === 403) this.invalidateGroup(groupId);
      this.assertCurrent(failure.originalEffectUnknown || failure.effectUnknown, failure.effectUnknown);
      let intent: CommunityIntentInspection | null = null;
      try { intent = this.resources.inspectIntent(key); } catch {}
      this.publish({ ...this.state, command: { ...pending, status: 'error', intent, error: failureView(failure) } });
      throw failure;
    }
  }
  updateSharing = (groupId: string, input: { flags: CommunityShareFlags; expectedRevision: number }, key: string) =>
    this.command(groupId, 'sharing', key, () => this.resources.updateSharing(groupId, input, key));
  updateProfile = (groupId: string, input: CommunityProfileInput, key: string) =>
    this.command(groupId, 'profile', key, () => this.resources.updateProfile(groupId, input, key));
  retry(key: string): Promise<unknown> {
    this.assertCurrent(); const retained = this.state.command;
    if (retained.key !== key || !retained.groupId || !retained.kind)
      throw new ApiError(404, 'sharing_intent_not_found', 'This consumer has no matching retained intent.');
    return this.command(retained.groupId, retained.kind, key, () => this.resources.retry(key), true);
  }
  audiencePreview(groupId: string, proposed?: CommunityShareFlags) {
    this.assertCurrent(); const current = this.state.groups[groupId];
    if (proposed !== undefined && (!proposed || typeof proposed !== 'object' ||
      Reflect.ownKeys(proposed).length !== communityShareFields.length ||
      communityShareFields.some(field => !Object.hasOwn(proposed, field) || typeof proposed[field] !== 'boolean') ||
      (proposed.workoutMinutes || proposed.exerciseCount) && !proposed.workout || proposed.streakDays && !proposed.planAdherence))
      throw new ApiError(422, 'community_invalid_input', 'Check the sharing flags.');
    if (proposed === undefined && current?.sharing.status !== 'ready') return null;
    const flags = proposed ?? current!.sharing.data!.flags;
    return freeze({ groupId, scope: 'entire_group' as const, recipientSettings: 'unsupported' as const,
      fields: communityShareFields.filter(field => flags[field] === true) });
  }
  sharingAudiencePreview(groupId: string, proposed?: CommunityShareFlags,
    proposedProfile?: CommunityProfileInput['flags']) {
    this.assertCurrent(); const sharing = this.audiencePreview(groupId, proposed);
    const profile = this.state.groups[groupId]?.profile;
    const profileFields = ['age', 'sex', 'region', 'avatar', 'adherence', 'ranking'] as const;
    if (proposedProfile !== undefined && (!proposedProfile || typeof proposedProfile !== 'object' ||
      Reflect.ownKeys(proposedProfile).length !== profileFields.length || proposedProfile.age !== false ||
      profileFields.some(field => !Object.hasOwn(proposedProfile, field) || typeof proposedProfile[field] !== 'boolean')))
      throw new ApiError(422, 'community_invalid_input', 'Check the profile sharing flags.');
    if (this.state.groups[groupId]?.membership.status !== 'ready' || !sharing ||
      proposedProfile === undefined && profile?.status !== 'ready') return null;
    const flags = proposedProfile ?? profile!.data!.flags;
    return freeze({ ...sharing, settingsSubject: 'mounted_actor' as const,
      profileFields: profileFields.filter(field => flags[field] === true), age: false as const,
      rankings: 'unavailable' as const });
  }
  selectedMemberProjection(selection: SharingSelection,
    fields: readonly (typeof communityShareFields[number])[] = ['planAdherence']): SelectedSharingProjection {
    this.assertCurrent();
    const { groupId, memberId, localDate } = selection;
    const civilDate = /^\d{4}-\d{2}-\d{2}$/.test(localDate) ? new Date(`${localDate}T00:00:00.000Z`) : null;
    if (!civilDate || !Number.isFinite(civilDate.getTime()) || civilDate.toISOString().slice(0, 10) !== localDate ||
      !groupId || !memberId || fields.some(field => !communityShareFields.includes(field)) || new Set(fields).size !== fields.length)
      throw new ApiError(422, 'community_invalid_input', 'Select a group, member, civil date and permitted fields.');
    const current = this.state.groups[groupId], range = this.summaryRanges.get(groupId);
    const membership = current?.membership.status === 'ready' ? current.membership.data : null;
    const covered = !!range && localDate >= range.from && localDate <= range.to;
    const summary = membership && current?.summary.status === 'ready' && covered ? current.summary.data : null;
    const member = summary?.summaryStatus === 'available' ? summary.members.find(row => row.memberId === memberId) : undefined;
    const day = member?.days.find(row => row.localDate === localDate);
    const activity: Omit<SharedDay, 'localDate'> = {};
    for (const field of fields) if (day && Object.hasOwn(day, field)) Object.assign(activity, { [field]: day[field] });
    const roster = membership && (current?.roster.status === 'ready' || current?.roster.status === 'empty') ? current.roster.data : null;
    const person = roster?.find(row => row.memberId === memberId);
    const profile: Roster[number]['profile'] = {};
    for (const field of ['sexDescription', 'region', 'avatar'] as const)
      if (person && Object.hasOwn(person.profile, field)) Object.assign(profile, { [field]: person.profile[field] });
    const followedPlan: FollowedPlanDisclosure = !summary ? { status: 'not_loaded', value: null }
      : summary.summaryStatus === 'unavailable' ? { status: 'unavailable', value: null }
      : activity.planAdherence === undefined ? { status: 'not_shared', value: null }
      : { status: 'shared', value: activity.planAdherence };
    return freeze({ selection: { groupId, memberId, localDate }, audience: 'entire_group' as const,
      alias: person?.alias ?? member?.alias ?? null, followedPlan, activity, profile: person ? profile : null,
      summaryReadStatus: current?.summary.status ?? 'idle', profileReadStatus: current?.roster.status ?? 'idle',
      membershipReadStatus: current?.membership.status ?? 'idle', membership,
      rankings: 'unavailable' as const });
  }
  memberProjection(groupId: string, memberId: string) {
    this.assertCurrent(); const current = this.state.groups[groupId];
    const summary = current?.summary.status === 'ready' && current.summary.data.summaryStatus === 'available'
      ? current.summary.data.members.find(row => row.memberId === memberId) : undefined;
    const roster = current?.roster.status === 'ready' ? current.roster.data.find(row => row.memberId === memberId) : undefined;
    const days = summary?.days.map(day => {
      const fields: Record<string, unknown> = { localDate: day.localDate };
      for (const field of communityShareFields) if (Object.hasOwn(day, field)) fields[field] = day[field];
      return fields;
    });
    const profile: Record<string, unknown> = {};
    for (const field of ['sexDescription', 'region', 'avatar'] as const)
      if (roster && Object.hasOwn(roster.profile, field)) profile[field] = roster.profile[field];
    return freeze({ groupId, memberId, alias: roster?.alias ?? summary?.alias ?? null,
      summaryStatus: current?.summary.status === 'ready' ? current.summary.data.summaryStatus : 'unknown',
      days: days ?? null, profile: roster ? profile : null, rankings: 'unavailable' as const });
  }
}
export const createSharingConsumer = (resources: CommunityResources) => new SharingConsumer(resources);
