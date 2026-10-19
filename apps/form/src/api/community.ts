import { ApiError, FormTransport, type AuthAttemptGuard } from './transport';

type Parser<T> = (value: unknown) => T;
type Shape = Record<string, Parser<unknown>>;
type Parsed<S extends Shape> = { [K in keyof S as undefined extends ReturnType<S[K]> ? never : K]: ReturnType<S[K]> } &
  { [K in keyof S as undefined extends ReturnType<S[K]> ? K : never]?: Exclude<ReturnType<S[K]>, undefined> };
function invalid(): never { throw new ApiError(422, 'community_invalid_input', 'Check the Community fields.'); }
const bytes = (value: string) => new TextEncoder().encode(value).byteLength;
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Reflect.ownKeys(value).some(k => typeof k !== 'string')) invalid();
  return value as Record<string, unknown>;
}
function exact<S extends Shape>(shape: S): Parser<Parsed<S>> {
  return value => {
    const input = record(value); if (Object.keys(input).some(k => !Object.hasOwn(shape, k))) invalid();
    const output: Record<string, unknown> = {};
    for (const [key, parse] of Object.entries(shape)) {
      const parsed = parse(input[key]); if (parsed !== undefined) output[key] = parsed;
    }
    return output as Parsed<S>;
  };
}
const optional = <T>(parse: Parser<T>): Parser<T | undefined> => value => value === undefined ? undefined : parse(value);
const nullable = <T>(parse: Parser<T>): Parser<T | null> => value => value === null ? null : parse(value);
const literal = <T extends string | boolean>(expected: T): Parser<T> => value => value === expected ? expected : invalid();
const enumeration = <T extends string>(values: readonly T[]): Parser<T> => value =>
  typeof value === 'string' && values.includes(value as T) ? value as T : invalid();
const boolean: Parser<boolean> = value => typeof value === 'boolean' ? value : invalid();
const number = (min: number, max = Number.MAX_SAFE_INTEGER, integer = true): Parser<number> => value =>
  typeof value === 'number' && Number.isFinite(value) && (!integer || Number.isSafeInteger(value)) && value >= min && value <= max ? value : invalid();
const revision = number(1), extensionRevision = number(0);
function string(max: number, min = 1): Parser<string> {
  return value => typeof value === 'string' && value.length >= min && value.length <= max ? value : invalid();
}
function text(max: number, extension = false): Parser<string> {
  return value => {
    if (typeof value !== 'string') invalid(); const result = value.trim();
    if (!(extension ? [...result].length : result.length) || (extension ? [...result].length : result.length) > max ||
      /[\u0000-\u001f\u007f<>]/u.test(result) || (extension && (bytes(result) > 2048 || /https?:\/\/|www\./iu.test(result)))) invalid();
    return result;
  };
}
const identifier: Parser<string> = value => typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value) ? value : invalid();
const commandKey: Parser<string> = value => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value) ? value : invalid();
const token: Parser<string> = value => typeof value === 'string' && /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(value) ? value : invalid();
const date: Parser<string> = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) invalid();
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) invalid(); return value;
};
const instant: Parser<string> = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?Z$/.test(value) || !Number.isFinite(Date.parse(value))) invalid();
  date(value.slice(0, 10)); return value;
};
function array<T>(parse: Parser<T>, max: number, unique = false): Parser<T[]> {
  return value => {
    if (!Array.isArray(value) || value.length > max) invalid();
    const result = value.map(parse); if (unique && new Set(result).size !== result.length) invalid();
    const ids = result.map(row => row && typeof row === 'object' ? ((row as { id?: unknown; memberId?: unknown }).id ?? (row as { memberId?: unknown }).memberId) : undefined);
    if (ids.every(id => id !== undefined) && new Set(ids).size !== ids.length) invalid();
    return result;
  };
}
const role = enumeration(['owner', 'admin', 'member'] as const);
export const communityShareFields = ['participation', 'workout', 'exerciseSnack', 'planAdherence', 'workoutMinutes', 'exerciseCount', 'streakDays'] as const;
export type CommunityShareFlags = Readonly<Record<typeof communityShareFields[number], boolean>>;
const flags = exact({ participation: boolean, workout: boolean, exerciseSnack: boolean, planAdherence: boolean,
  workoutMinutes: boolean, exerciseCount: boolean, streakDays: boolean });
const empty = exact({});
const baseRevision = exact({ expectedRevision: revision });
const extRevision = exact({ expectedRevision: extensionRevision });
const groupShape = { id: identifier, name: text(80), revision, role, memberId: identifier };
const group = exact(groupShape);
const member = exact({ memberId: identifier, alias: text(60), role, revision });
const groupDetail = exact({ ...groupShape, members: array(member, 50) });
const removedMembership = exact({ groupId: identifier, memberId: identifier, membershipGeneration: revision, removedAt: nullable(instant),
  groupLabel: (value: unknown) => record(value).status === 'available'
    ? exact({ status: literal('available'), value: text(80) })(value) : exact({ status: literal('unavailable') })(value) });
const removedMemberships: Parser<ReturnType<typeof removedMembership>[]> = value => {
  const rows = array(removedMembership, 1000)(value);
  if (new Set(rows.map(row => row.groupId)).size !== rows.length) invalid(); return rows;
};
const invitationShape = { id: identifier, groupId: identifier, revision, createdAt: instant, expiresAt: instant,
  state: enumeration(['pending', 'redeemed', 'revoked', 'expired'] as const) };
const friendInvitation = exact({ id: identifier, revision, state: invitationShape.state, expiresAt: instant });
const invitation = exact({ ...invitationShape, tokenAvailable: literal(false) });
const invitationPreview = exact({ name: text(80), expiresAt: instant, membershipDisclosure: string(512) });
const invitationJoinResult = exact({ groupId: identifier, memberId: identifier });
const invitationPreviewInput = exact({ token });
const invitationJoinInput = exact({ token, alias: text(60), membershipDisclosureAccepted: literal(true) });
const issuedInvitation: Parser<CommunityIssuedInvitation> = value => {
  const input = record(value);
  return input.tokenAvailable === true ? exact({ ...invitationShape, tokenAvailable: literal(true), token })(input) : invitation(input);
};
const sharingShape = exact({ revision, flags, enabledAt: exact({ participation: optional(instant), workout: optional(instant),
  exerciseSnack: optional(instant), planAdherence: optional(instant), workoutMinutes: optional(instant), exerciseCount: optional(instant), streakDays: optional(instant) }) });
const ownSharing: Parser<ReturnType<typeof sharingShape>> = value => {
  const result = sharingShape(value);
  for (const field of communityShareFields) if (result.flags[field] !== (result.enabledAt[field] !== undefined)) invalid();
  if ((result.flags.workoutMinutes || result.flags.exerciseCount) && !result.flags.workout || result.flags.streakDays && !result.flags.planAdherence) invalid();
  return result;
};
const recorded = enumeration(['recorded', 'not_recorded', 'unknown'] as const);
const adherence = enumeration(['met', 'not_met', 'pending', 'unknown', 'not_applicable'] as const);
const sharedDay = exact({ localDate: date, participation: optional(recorded), workout: optional(recorded), exerciseSnack: optional(recorded),
  planAdherence: optional(adherence), workoutMinutes: optional(number(0, 2880, false)), exerciseCount: optional(number(0, 10000)), streakDays: optional(number(0, 100000)) });
const summary = exact({ summaryStatus: enumeration(['available', 'unavailable'] as const),
  members: array(exact({ memberId: identifier, alias: text(60), days: array(sharedDay, 31) }), 50) });
const intent = enumeration(['accountability', 'supportive_community'] as const);
const region = nullable(enumeration(['US-NE', 'US-SE', 'US-MW', 'US-SW', 'US-W', 'CA', 'EU', 'OTHER'] as const));
const priorities: Parser<('location' | 'goals')[]> = value => {
  const result = array(enumeration(['location', 'goals'] as const), 2, true)(value); return result.length === 2 ? result : invalid();
};
const preferences = exact({ alias: text(60, true), intent, language: enumeration(['en', 'es', 'fr'] as const),
  goals: array(enumeration(['strength', 'mobility', 'consistency'] as const), 3, true), region,
  location: enumeration(['local_preferred', 'nonlocal_preferred', 'anywhere', 'diverse_preferred'] as const), priorities,
  relax: exact({ broaderRegion: boolean, mixedGoals: boolean }), willingHost: boolean, fillExistingGroups: boolean,
  membershipDisclosureAccepted: literal(true), policyVersion: literal('community-v1') });
const enrollment = exact({ expectedRevision: extensionRevision, preferences });
const matchingShape = exact({ revision: extensionRevision, generation: extensionRevision, state: enumeration(['queued', 'cancelled', 'assigned'] as const), assignedGroupId: nullable(identifier),
  preferences: nullable(preferences), queuedAt: nullable(instant), cooldownUntil: nullable(instant), missedBatches: extensionRevision,
  relaxation: array(enumeration(['broader_region', 'mixed_goals'] as const), 2, true) });
const matching: Parser<ReturnType<typeof matchingShape>> = value => {
  const result = matchingShape(value); if (result.state !== 'assigned' && result.assignedGroupId !== null) invalid(); return result;
};
const profileFlags = exact({ age: literal(false), sex: boolean, region: boolean, avatar: boolean, adherence: boolean, ranking: boolean });
const profileFields = { flags: profileFlags, sexDescription: nullable(text(60, true)), region,
  avatar: nullable(enumeration(['leaf', 'sun', 'mountain'] as const)) };
const profileShape = exact({ revision: extensionRevision, ...profileFields });
const profile: Parser<ReturnType<typeof profileShape>> = value => {
  const result = profileShape(value);
  if (!result.flags.sex && result.sexDescription !== null || !result.flags.region && result.region !== null || !result.flags.avatar && result.avatar !== null) invalid();
  return result;
};
const profileInput = exact({ expectedRevision: extensionRevision, ...profileFields, audiencePreviewAccepted: literal(true) });
const profiles = array(exact({ memberId: identifier, alias: text(60, true), profile: exact({ sexDescription: optional(text(60, true)),
  region: optional(enumeration(['US-NE', 'US-SE', 'US-MW', 'US-SW', 'US-W', 'CA', 'EU', 'OTHER'] as const)),
  avatar: optional(enumeration(['leaf', 'sun', 'mountain'] as const)) }) }), 50);
const policy = exact({ kind: literal('matched'), intent, capacity: number(4, 20), revision });
const motionProjection = exact({ id: identifier, places: nullable(number(1, 4)), subjectMemberId: nullable(identifier), kind: enumeration(['growth', 'friend', 'removal'] as const), revision, state: string(80),
  expiresAt: instant, electorateSize: number(3, 20), requiredYes: number(3, 20),
  ownBallot: nullable(enumeration(['yes', 'no', 'abstain'] as const)), ballotRevision: extensionRevision });
const motion: Parser<ReturnType<typeof motionProjection>> = value => {
  const result = motionProjection(value);
  if (result.kind !== 'removal' && result.subjectMemberId !== null || (result.kind === 'growth') !== (result.places !== null)) invalid();
  return result;
};
const friendReservation = exact({ id: identifier, motionId: identifier, state: enumeration(['available', 'cancelled', 'consumed'] as const),
  expiresAt: instant, invitationId: nullable(identifier) });
const block = exact({ id: identifier, revision, active: boolean });
const safetyShape = { id: identifier, revision, state: string(80), createdAt: instant, expiresAt: instant,
  support: enumeration(['unavailable', 'pending'] as const) };
const safety = exact(safetyShape);
const safetyReference = exact({ id: identifier, expiresAt: instant });
const notice = exact({ ...safetyShape, reason: string(2048), rule: string(200), appealUntil: instant });
const postShape = { id: identifier, revision, kind: enumeration(['check_in', 'win'] as const),
  state: enumeration(['pending', 'published', 'hidden', 'rejected'] as const), createdAt: instant, expiresAt: instant,
  text: optional(text(500, true)), template: optional(enumeration(['checking_in', 'at_my_pace'] as const)), memberId: optional(identifier), alias: optional(text(60, true)) };
const post = exact(postShape);
const posts = exact({ posts: array(post, 50), nextCursor: nullable(identifier) });

export type CommunityGroup = ReturnType<typeof group>;
export type CommunityRemovedMembership = ReturnType<typeof removedMembership>;
export function communityRemovedMembershipMessage(value: CommunityRemovedMembership): string {
  return value.groupLabel.status === 'available' ? `You're no longer a member of ${value.groupLabel.value}.` : "You're no longer a member of this group.";
}
export type CommunityGroupDetail = ReturnType<typeof groupDetail>;
export type CommunityMember = ReturnType<typeof member>;
export type CommunityInvitation = ReturnType<typeof invitation>;
export type CommunityInvitationPreview = ReturnType<typeof invitationPreview>;
export type CommunityJoinResult = ReturnType<typeof invitationJoinResult>;
export type CommunityIssuedInvitation = Omit<CommunityInvitation, 'tokenAvailable'> &
  ({ tokenAvailable: true; token: string } | { tokenAvailable: false });
export type CommunitySharing = ReturnType<typeof ownSharing>;
export type CommunitySummary = ReturnType<typeof summary>;
export type CommunityMatching = ReturnType<typeof matching>;
export type CommunityPreferences = ReturnType<typeof preferences>;
export type CommunityProfile = ReturnType<typeof profile>;
export type CommunityPolicy = ReturnType<typeof policy>;
export type CommunityMotion = ReturnType<typeof motion>;
export type CommunityFriendInvitation = ReturnType<typeof friendInvitation>;
export type CommunityFriendReservation = ReturnType<typeof friendReservation>;
export type CommunityBlock = ReturnType<typeof block>;
export type CommunitySafetyReference = ReturnType<typeof safetyReference>;
export type CommunitySafetyReferenceInput = { kind: 'member' | 'post'; resourceId: string };
export type CommunitySafetyCase = ReturnType<typeof safety>;
export type CommunitySafetyNotice = ReturnType<typeof notice>;
export type CommunityPost = ReturnType<typeof post>;
export type CommunityPostsPage = ReturnType<typeof posts>;
export type CommunityHiddenPost = Awaited<ReturnType<CommunityResources['hidePost']>>;
export type CommunityAliasInput = { alias: string; expectedRevision: number };
export type CommunityLeaveInput = { confirmed: true };
export type CommunityCloseGroupInput = { expectedRevision: number; confirmed: true };
export type CommunityLeaveResult = Readonly<{ left: true }>;
export type CommunityCloseGroupResult = Readonly<{ closed: true }>;
export type CommunityGroupMembershipResult = Readonly<
  { kind: 'alias' | 'role'; value: CommunityMember } | { kind: 'leave'; value: CommunityLeaveResult } | { kind: 'close'; value: CommunityCloseGroupResult }
>;
export type CommunityRemoveMemberInput = { expectedRevision: number; confirmed: true };
export type CommunityCreateGrowthMotionInput = { places: number; expectedRevision: number; confirmed: true };
export type CommunityFinalizeGrowthMotionInput = { confirmed: true };
export type CommunityCreateRemovalMotionInput = { expectedRevision: number; confirmed: true };
export type CommunityFinalizeRemovalMotionInput = { confirmed: true };
export type CommunityRemovalResult = Readonly<{ removed: true }>;
export type CommunityCreateInput = { name: string; alias: string; membershipDisclosureAccepted: true };
export type CommunityJoinInput = { token: string; alias: string; membershipDisclosureAccepted: true };
export type CommunityEnrollmentInput = { expectedRevision: number; preferences: CommunityPreferences };
export type CommunityProfileInput = ReturnType<typeof profileInput>;
export type CommunityPostInput = { kind: 'check_in'; template: 'checking_in' | 'at_my_pace'; policyVersion: 'community-v1'; audiencePreviewAccepted: true } |
  { kind: 'win'; text?: string; policyVersion: 'community-v1'; audiencePreviewAccepted: true };
export type CommunityMotionInput = { kind: 'growth'; places: number; expectedRevision: number } |
  { kind: 'friend'; expectedRevision: number } | { kind: 'removal'; memberId: string; expectedRevision: number };
export type CommunityIntentInspection = Readonly<{ key: string; path: string; method: string; state: 'pending' | 'unknown' | 'rejected' | 'confirmed';
  expectedRevision?: number; originalEffectUnknown: boolean; disposition: 'explicit_same_intent_retry' | 'reload_before_new_intent' | 'revoke_or_replace' | 'confirmed' }>;
type Intent = { key: string; path: string; method: string; body: unknown; encoded: string; parse: Parser<unknown>;
  state: CommunityIntentInspection['state']; originalUnknown: boolean; inFlight: boolean; invitation: boolean; tokenDelivered: boolean; secret: boolean };

function payload<T>(input: unknown, parse: Parser<T>): { body: T; encoded: string } {
  let value = input;
  if (typeof value === 'string') {
    if (bytes(value) > 8192) invalid(); try { value = JSON.parse(value); } catch { invalid(); }
  }
  const body = parse(value); const encoded = canonical(body);
  if (bytes(encoded) > 8192) invalid(); return { body: JSON.parse(encoded) as T, encoded };
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(value) as string;
}

/** One mounted auth generation. Explicit retries preserve exact intent; child view state stays in memory and ends with this session. */
export class CommunityResources {
  private disposed = false;
  private readonly context: AuthAttemptGuard;
  private readonly subscription: { remove(): void };
  private readonly intents = new Map<string, Intent>();
  private readonly completedSecrets = new Set<string>();
  private readonly controllers = new Set<{ dispose(): void }>();
  constructor(private readonly transport: FormTransport, private readonly isMountedCurrent: () => boolean = () => true) {
    this.context = transport.captureAuthContext();
    this.subscription = transport.subscribeAuthChanges(() => this.dispose());
  }
  dispose(): void {
    this.disposed = true;
    for (const intent of this.intents.values()) { intent.body = undefined; intent.encoded = ''; }
    this.intents.clear(); this.completedSecrets.clear(); this.subscription.remove();
    for (const controller of this.controllers) controller.dispose();
    this.controllers.clear();
  }
  createGroupController(): CommunityGroupController {
    this.assertCurrent();
    const controller = new MountedCommunityGroupController(this, () => this.current(), () => this.controllers.delete(controller));
    this.controllers.add(controller); return controller;
  }
  createInvitationJoinController(): CommunityInvitationJoinController {
    this.assertCurrent();
    const controller = new MountedCommunityInvitationJoinController(this, () => this.current(), () => this.controllers.delete(controller));
    this.controllers.add(controller); return controller;
  }
  createSafetyController(): CommunitySafetyController {
    this.assertCurrent();
    const controller = new MountedCommunitySafetyController(this, () => this.current(), () => this.controllers.delete(controller));
    this.controllers.add(controller); return controller;
  }
  createFriendInvitationController(groupId: string): CommunityFriendInvitationController {
    this.assertCurrent(); identifier(groupId);
    const controller = new MountedCommunityFriendInvitationController(this, groupId, () => this.current(), () => this.controllers.delete(controller));
    this.controllers.add(controller); return controller;
  }
  createPostsController(groupId: string): CommunityPostsController {
    this.assertCurrent(); identifier(groupId);
    const controller = new MountedCommunityPostsController(this, groupId, () => this.current(), () => this.controllers.delete(controller));
    this.controllers.add(controller); return controller;
  }
  private current(): boolean { return !this.disposed && this.context.isCurrent() && this.isMountedCurrent(); }
  private assertCurrent(originalUnknown = false): void {
    if (!this.current()) { this.dispose(); throw this.changed(originalUnknown); }
  }
  private changed(originalUnknown: boolean, effectUnknown = false): ApiError {
    return new ApiError(409, 'session_changed', 'This mounted account session ended. Reconcile uncertain changes in the original account.', effectUnknown, originalUnknown);
  }
  private async read<T>(path: string, parse: Parser<T>, body?: unknown): Promise<T> {
    this.assertCurrent();
    try {
      const result = await this.transport.request(`/v1/community${path}`, body === undefined ? 'GET' : 'POST', body);
      this.assertCurrent();
      const parsed = this.response(result, parse, false, path); this.assertCurrent(); return parsed;
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) this.dispose();
      // Invitation preview is a read even though transport classifies POST failures as uncertain writes.
      if (!this.current()) throw this.changed(false);
      if (error instanceof ApiError) throw new ApiError(error.status, error.code, error.message, false, false);
      throw new ApiError(0, 'community_read_unavailable', 'Community could not be read.');
    }
  }
  private response<T>(value: unknown, parse: Parser<T>, mutation: boolean, path: string): T {
    try {
      // Bound projection materialization; never accept raw account, health, contacts or extra fields.
      if (bytes(JSON.stringify(value)) > 1048576) invalid();
      const result = parse(value); this.assertProjection(path, result); return result;
    } catch { throw new ApiError(502, 'community_invalid_response', 'The Community result could not be confirmed. Reload current state.', mutation); }
  }
  private assertProjection(path: string, value: unknown): void {
    const groupId = /^\/groups\/([^/?]+)/.exec(path)?.[1];
    for (const result of Array.isArray(value) ? value : [value]) {
      if (!result || typeof result !== 'object') continue;
      const row = result as Record<string, unknown>;
      if (groupId && row.groupId !== undefined && row.groupId !== groupId) invalid();
      if (groupId && path === `/groups/${groupId}` && row.id !== groupId) invalid();
      const target = /\/(?:invitations|members|motions|posts)\/([^/?]+)\/(revoke|role|ballot|hide|finalize)$/.exec(path);
      if (target && row[target[2] === 'role' ? 'memberId' : 'id'] !== target[1]) invalid();
    }
  }
  private mutate<T>(path: string, method: string, input: unknown, parseInput: Parser<unknown>, parse: Parser<T>, key: string,
    invitationCommand = false, secret = false): Promise<T> {
    this.assertCurrent(); commandKey(key);
    let prepared: { body: unknown; encoded: string };
    try { prepared = payload(input, parseInput); }
    catch (error) {
      const prior = this.intents.get(key);
      if (error instanceof ApiError && prior?.originalUnknown) throw new ApiError(error.status, error.code, error.message, error.effectUnknown, true);
      throw error;
    }
    if (this.completedSecrets.has(key)) throw new ApiError(409, 'community_secret_consumed', 'This token intent completed. Read current membership instead.');
    let intent = this.intents.get(key);
    if (intent) {
      if (intent.path !== path || intent.method !== method || intent.encoded !== prepared.encoded)
        throw new ApiError(409, 'idempotency_conflict', 'Use the retained key with its exact original fields and revision.', false, intent.originalUnknown);
    } else {
      if (this.intents.size + this.completedSecrets.size >= 64) throw new ApiError(429, 'community_intent_capacity', 'Reconcile this mounted session before starting more changes.');
      intent = { key, path, method, body: freeze(prepared.body), encoded: prepared.encoded, parse, state: 'pending', originalUnknown: false,
        inFlight: false, invitation: invitationCommand, tokenDelivered: false, secret };
      this.intents.set(key, intent);
    }
    return this.dispatch(intent) as Promise<T>;
  }
  private async dispatch(intent: Intent): Promise<unknown> {
    this.assertCurrent(intent.originalUnknown);
    if (intent.inFlight) throw new ApiError(409, 'community_intent_in_flight', 'Wait for this exact change to finish.', false, intent.originalUnknown);
    intent.inFlight = true; intent.state = 'pending';
    try {
      const result = await this.transport.request(`/v1/community${intent.path}`, intent.method, intent.body, intent.key);
      this.assertCurrent(true);
      let parsed = this.response(result, intent.parse, true, intent.path);
      this.assertCurrent(true);
      if (intent.invitation) {
        const issued = parsed as CommunityIssuedInvitation;
        if (issued.tokenAvailable && intent.originalUnknown) throw new ApiError(502, 'community_invitation_replay_invalid', 'A lost invitation must be explicitly revoked or replaced.', true, true);
        if (issued.tokenAvailable && intent.tokenDelivered) {
          const { token: _secret, ...metadata } = issued; parsed = { ...metadata, tokenAvailable: false };
        }
        if (issued.tokenAvailable) intent.tokenDelivered = true;
      }
      intent.state = 'confirmed';
      if (intent.secret) { this.intents.delete(intent.key); this.completedSecrets.add(intent.key); intent.body = undefined; intent.encoded = ''; }
      return parsed;
    } catch (error) {
      const failure = error instanceof ApiError ? error : new ApiError(0, 'community_outcome_unknown', 'The result could not be confirmed. Retry only this exact intent.', true);
      intent.originalUnknown ||= failure.effectUnknown || failure.originalEffectUnknown;
      intent.state = intent.originalUnknown ? 'unknown' : 'rejected';
      if (failure.status === 401) this.dispose();
      if (!this.current()) throw this.changed(intent.originalUnknown, failure.effectUnknown);
      throw new ApiError(failure.status, failure.code, failure.message, failure.effectUnknown, intent.originalUnknown);
    } finally { intent.inFlight = false; }
  }
  /** Reconcile explicitly under the same mounted actor; never allocates another key or revision. */
  retry(key: string): Promise<unknown> {
    this.assertCurrent(); commandKey(key); const intent = this.intents.get(key);
    if (!intent) throw new ApiError(404, 'community_intent_not_found', 'No retained change exists in this mounted session.');
    return this.dispatch(intent);
  }
  inspectIntent(key: string): CommunityIntentInspection | null {
    this.assertCurrent(); commandKey(key); const intent = this.intents.get(key); if (!intent) return null;
    const expectedRevision = (intent.body as { expectedRevision?: number })?.expectedRevision;
    return Object.freeze({ key, path: intent.path, method: intent.method, state: intent.state,
      ...(expectedRevision === undefined ? {} : { expectedRevision }), originalEffectUnknown: intent.originalUnknown,
      disposition: intent.invitation && (intent.originalUnknown || (intent.state === 'confirmed' && !intent.tokenDelivered)) ? 'revoke_or_replace' :
        intent.state === 'confirmed' ? 'confirmed' : intent.state === 'rejected' ? 'reload_before_new_intent' : 'explicit_same_intent_retry' });
  }
  capabilities(): Promise<never> {
    this.assertCurrent(); return Promise.reject(new ApiError(503, 'community_capabilities_unavailable', 'The Community HTTP capabilities route is unavailable.'));
  }
  listGroups = () => this.read('/groups', array(group, 20));
  listRemovedMemberships = () => this.read('/me/removed-memberships', removedMemberships);
  readGroup = (groupId: string) => this.read(`/groups/${identifier(groupId)}`, groupDetail);
  createGroup = (input: CommunityCreateInput | string, key: string) => this.mutate('/groups', 'POST', input,
    exact({ name: text(80), alias: text(60), membershipDisclosureAccepted: literal(true) }), group, key);
  renameGroup = (groupId: string, input: { name: string; expectedRevision: number } | string, key: string) =>
    this.mutate(`/groups/${identifier(groupId)}`, 'PATCH', input, exact({ name: text(80), expectedRevision: revision }), group, key);
  updateAlias = (groupId: string, input: { alias: string; expectedRevision: number } | string, key: string, expectation?: Readonly<{ memberId: string }>) => {
    const expected = expectation === undefined ? undefined : exact({ memberId: identifier })(expectation);
    return this.mutate(`/groups/${identifier(groupId)}/me`, 'PATCH', input, exact({ alias: text(60), expectedRevision: revision }), value => {
      const result = member(value); if (expected && result.memberId !== expected.memberId) invalid(); return result;
    }, key);
  };
  readSharing = (groupId: string) => this.read(`/groups/${identifier(groupId)}/me/sharing`, ownSharing);
  updateSharing = (groupId: string, input: { flags: CommunityShareFlags; expectedRevision: number } | string, key: string) =>
    this.mutate(`/groups/${identifier(groupId)}/me/sharing`, 'PATCH', input, exact({ flags, expectedRevision: revision }), ownSharing, key);
  listInvitations = (groupId: string) => this.read(`/groups/${identifier(groupId)}/invitations`, array(invitation, 100));
  issueInvitation = (groupId: string, key: string) => this.mutate(`/groups/${identifier(groupId)}/invitations`, 'POST', {}, empty, issuedInvitation, key, true);
  issueFriendInvitation = (groupId: string, reservationId: string, key: string) =>
    this.mutate(`/groups/${identifier(groupId)}/reservations/${identifier(reservationId)}/invitations`, 'POST', {}, empty, issuedInvitation, key, true);
  previewInvitation(input: { token: string } | string) {
    const body = payload(input, invitationPreviewInput).body;
    return this.read('/invitations/preview', invitationPreview, body);
  }
  joinInvitation = (input: CommunityJoinInput | string, key: string) => this.mutate('/invitations/join', 'POST', input,
    invitationJoinInput, invitationJoinResult, key, false, true);
  revokeInvitation = (groupId: string, inviteId: string, expectedRevision: number, key: string) =>
    this.mutate(`/groups/${identifier(groupId)}/invitations/${identifier(inviteId)}/revoke`, 'POST', { expectedRevision }, baseRevision, invitation, key);
  replaceInvitation = (groupId: string, inviteId: string, expectedRevision: number, key: string, expectation?: Readonly<{ differentId: true }>) => {
    const expected = expectation === undefined ? undefined : exact({ differentId: literal(true) })(expectation);
    return this.mutate(`/groups/${identifier(groupId)}/invitations/${identifier(inviteId)}/replace`, 'POST', { expectedRevision }, baseRevision, value => {
      const result = issuedInvitation(value); if (expected && result.id === inviteId) invalid(); return result;
    }, key, true);
  };
  updateRole = (groupId: string, memberId: string, input: { role: 'admin' | 'member'; expectedRevision: number } | string, key: string) =>
    this.mutate(`/groups/${identifier(groupId)}/members/${identifier(memberId)}/role`, 'PATCH', input,
      exact({ role: enumeration(['admin', 'member'] as const), expectedRevision: revision }), member, key);
  removeMember = (groupId: string, memberId: string, expectedRevision: number, key: string) =>
    this.mutate(`/groups/${identifier(groupId)}/members/${identifier(memberId)}/remove`, 'POST', { expectedRevision }, baseRevision, exact({ removed: literal(true) }), key);
  allowReinvite = (groupId: string, memberId: string, expectedRevision: number, key: string) =>
    this.mutate(`/groups/${identifier(groupId)}/members/${identifier(memberId)}/allow-reinvite`, 'POST', { expectedRevision }, baseRevision, exact({ allowed: literal(true) }), key);
  leave = (groupId: string, key: string) => this.mutate(`/groups/${identifier(groupId)}/leave`, 'POST', {}, empty, exact({ left: literal(true) }), key);
  withdraw = (groupId: string, key: string) => this.mutate(`/groups/${identifier(groupId)}/me/withdraw`, 'POST', {}, empty, exact({ withdrawn: literal(true) }), key);
  closeGroup = (groupId: string, expectedRevision: number, key: string) => this.mutate(`/groups/${identifier(groupId)}/close`, 'POST', { expectedRevision }, baseRevision, exact({ closed: literal(true) }), key);
  readSummary(groupId: string, input: { from: string; to: string } | string) {
    const range = payload(input, exact({ from: date, to: date })).body;
    const span = (Date.parse(range.to) - Date.parse(range.from)) / 86400000; if (span < 0 || span >= 31) invalid();
    return this.read(`/groups/${identifier(groupId)}/summary?from=${range.from}&to=${range.to}`, value => {
      const result = summary(value);
      if (result.summaryStatus === 'unavailable' && result.members.length) invalid();
      for (const row of result.members) {
        const dates = new Set<string>();
        for (const day of row.days) { if (day.localDate < range.from || day.localDate > range.to || dates.has(day.localDate)) invalid(); dates.add(day.localDate); }
      }
      return result;
    });
  }
  readMatching = () => this.read('/me/matching', matching);
  enroll = (input: CommunityEnrollmentInput | string, key: string) => this.mutate('/me/matching/enroll', 'POST', input, enrollment, matching, key);
  updateMatching = (input: CommunityEnrollmentInput | string, key: string) => this.mutate('/me/matching', 'PATCH', input, enrollment, matching, key);
  cancelEnrollment = (expectedRevision: number, key: string) => this.mutate('/me/matching/cancel', 'POST', { expectedRevision }, extRevision, matching, key);
  readPolicy = (groupId: string) => this.read(`/groups/${identifier(groupId)}/policy`, policy);
  readProfile = (groupId: string) => this.read(`/groups/${identifier(groupId)}/me/profile-sharing`, profile);
  updateProfile = (groupId: string, input: CommunityProfileInput | string, key: string) =>
    this.mutate(`/groups/${identifier(groupId)}/me/profile-sharing`, 'PATCH', input, profileInput, profile, key);
  rosterProfiles = (groupId: string) => this.read(`/groups/${identifier(groupId)}/profiles`, profiles);
  listMotions = (groupId: string) => this.read(`/groups/${identifier(groupId)}/motions`, array(motion, 50));
  listFriendReservations = (groupId: string) => this.read(`/groups/${identifier(groupId)}/me/friend-reservations`, array(friendReservation, 50));
  readFriendInvitation = (groupId: string, reservationId: string) =>
    this.read(`/groups/${identifier(groupId)}/me/friend-reservations/${identifier(reservationId)}/invitation`, friendInvitation);
  finalizeMotion = (groupId: string, motionId: string, key: string, expectation?: Readonly<{ kind: 'removal' } | { kind: 'growth'; places: number }>) => {
    const expected = expectation === undefined ? undefined : expectation.kind === 'growth'
      ? exact({ kind: literal('growth'), places: number(1, 4) })(expectation) : exact({ kind: literal('removal') })(expectation);
    return this.mutate(`/groups/${identifier(groupId)}/motions/${identifier(motionId)}/finalize`, 'POST', {}, empty, value => {
      const result = motion(value);
      if (expected && (result.kind !== expected.kind || expected.kind === 'growth' && result.places !== expected.places)) invalid();
      return result;
    }, key);
  };
  createMotion(groupId: string, input: CommunityMotionInput | string, key: string, expectation?: Readonly<{ kind: 'removal'; memberId: string } | { kind: 'growth'; places: number }>) {
    const parse: Parser<unknown> = value => {
      const row = record(value);
      if (row.kind === 'growth') return exact({ kind: literal('growth'), places: number(1, 4), expectedRevision: extensionRevision })(row);
      if (row.kind === 'friend') return exact({ kind: literal('friend'), expectedRevision: extensionRevision })(row);
      return exact({ kind: literal('removal'), memberId: identifier, expectedRevision: extensionRevision })(row);
    };
    const expected = expectation === undefined ? undefined : expectation.kind === 'growth'
      ? exact({ kind: literal('growth'), places: number(1, 4) })(expectation) : exact({ kind: literal('removal'), memberId: identifier })(expectation);
    return this.mutate(`/groups/${identifier(groupId)}/motions`, 'POST', input, parse, value => {
      const result = motion(value);
      if (expected && (result.kind !== expected.kind || (expected.kind === 'growth' ? result.places !== expected.places :
        result.subjectMemberId !== null && result.subjectMemberId !== expected.memberId))) invalid();
      return result;
    }, key);
  }
  setBallot = (groupId: string, motionId: string, input: { choice: 'yes' | 'no' | 'abstain'; expectedRevision: number } | string, key: string) =>
    this.mutate(`/groups/${identifier(groupId)}/motions/${identifier(motionId)}/ballot`, 'POST', input,
      exact({ choice: enumeration(['yes', 'no', 'abstain'] as const), expectedRevision: extensionRevision }), motion, key);
  blockMember = (groupId: string, memberId: string, key: string) =>
    this.mutate(`/groups/${identifier(groupId)}/members/${identifier(memberId)}/block`, 'POST', {}, empty, block, key);
  listBlocks = () => this.read('/me/blocks', array(block, 500));
  unblock = (blockId: string, expectedRevision: number, key: string) =>
    this.mutate(`/me/blocks/${identifier(blockId)}/unblock`, 'POST', { expectedRevision }, extRevision, block, key);
  createSafetyReference = (groupId: string, input: CommunitySafetyReferenceInput | string, key: string) =>
    this.mutate(`/groups/${identifier(groupId)}/safety-references`, 'POST', input,
      exact({ kind: enumeration(['member', 'post'] as const), resourceId: identifier }), safetyReference, key);
  report = (input: { category: 'harassment' | 'privacy' | 'danger' | 'other'; text: string; safetyReference?: string } | string, key: string) =>
    this.mutate('/reports', 'POST', input, exact({ category: enumeration(['harassment', 'privacy', 'danger', 'other'] as const),
      text: text(1000, true), safetyReference: optional(identifier) }), safety, key);
  listReports = () => this.read('/me/reports', array(safety, 200));
  listNotices = () => this.read('/me/safety-notices', array(notice, 200));
  appeal = (noticeId: string, input: { text: string; expectedRevision: number } | string, key: string) =>
    this.mutate(`/me/safety-notices/${identifier(noticeId)}/appeal`, 'POST', input, exact({ text: text(1000, true), expectedRevision: extensionRevision }), safety, key);
  listAppeals = () => this.read('/me/appeals', array(safety, 200));
  rankings = (groupId: string, metric: 'current_streak' | 'month_adherence' | 'longest_streak') =>
    this.read(`/groups/${identifier(groupId)}/rankings?metric=${enumeration(['current_streak', 'month_adherence', 'longest_streak'] as const)(metric)}`, exact({ status: literal('unavailable') }));
  readPosts(groupId: string, input: { cursor?: string; limit?: number } = {}) {
    const query = payload(input, exact({ cursor: optional(identifier), limit: optional(number(1, 50)) })).body;
    const params = new URLSearchParams(); if (query.cursor) params.set('cursor', query.cursor); if (query.limit !== undefined) params.set('limit', String(query.limit));
    return this.read(`/groups/${identifier(groupId)}/posts${params.size ? `?${params}` : ''}`, posts);
  }
  createPost(groupId: string, input: CommunityPostInput | string, key: string) {
    const parse: Parser<unknown> = value => record(value).kind === 'check_in'
      ? exact({ kind: literal('check_in'), template: enumeration(['checking_in', 'at_my_pace'] as const), policyVersion: literal('community-v1'), audiencePreviewAccepted: literal(true) })(value)
      : exact({ kind: literal('win'), text: optional(text(500, true)), policyVersion: literal('community-v1'), audiencePreviewAccepted: literal(true) })(value);
    return this.mutate(`/groups/${identifier(groupId)}/posts`, 'POST', input, parse, post, key);
  }
  hidePost = (groupId: string, postId: string, expectedRevision: number, key: string) =>
    this.mutate(`/groups/${identifier(groupId)}/posts/${identifier(postId)}/hide`, 'POST', { expectedRevision }, extRevision,
      exact({ id: identifier, revision, state: literal('hidden') }), key);
  setReaction = (groupId: string, postId: string, input: { active: boolean; reaction: 'cheer' | 'thanks' | 'with_you'; expectedRevision: number } | string, key: string) =>
    this.mutate(`/groups/${identifier(groupId)}/posts/${identifier(postId)}/react`, 'POST', input,
      exact({ active: boolean, reaction: enumeration(['cheer', 'thanks', 'with_you'] as const), expectedRevision: extensionRevision }),
      exact({ active: boolean, revision: extensionRevision }), key);
}

export type CommunityViewError = Readonly<Pick<ApiError, 'status' | 'code' | 'effectUnknown' | 'originalEffectUnknown'>>;
export type CommunityReadState<T> = Readonly<
  { status: 'idle' | 'loading' | 'stale'; groupId: string | null; data: null; error: null } |
  { status: 'ready' | 'empty'; groupId: string | null; data: T; error: null } |
  { status: 'error'; groupId: string | null; data: null; error: CommunityViewError }
>;
export type CommunityGroupInvitationResult = Readonly<{ kind: 'issue_invitation' | 'revoke_invitation' | 'replace_invitation'; value: CommunityInvitation }>;
type GroupData = { invitations: readonly CommunityInvitation[]; groups: readonly CommunityGroup[]; removedMemberships: readonly CommunityRemovedMembership[]; detail: CommunityGroupDetail; policy: CommunityPolicy; sharing: CommunitySharing; motions: readonly CommunityMotion[] };
type GroupReadName = keyof GroupData;
type RemovalCommandTarget = Readonly<{ kind: 'growth_motion' | 'finalize_growth'; groupId: string; motionId: string | null; memberId: null } |
  { kind: 'remove' | 'removal_motion'; groupId: string; motionId: null; memberId: string } |
  { kind: 'finalize_removal'; groupId: string; motionId: string; memberId: string | null }>;
type MembershipCommandTarget = Readonly<{ kind: 'alias' | 'role'; groupId: string; memberId: string; motionId: null } |
  { kind: 'leave' | 'close'; groupId: string; memberId: null; motionId: null }>;
type InvitationCommandTarget = Readonly<{ kind: CommunityGroupInvitationResult['kind']; groupId: string; invitationId: string | null; memberId: null; motionId: null }>;
type GroupCommandTarget = Readonly<{ kind: 'create'; groupId: null; motionId: null } |
  { kind: 'sharing' | 'ballot'; groupId: string; motionId: string | null }> | RemovalCommandTarget | MembershipCommandTarget | InvitationCommandTarget;
export type CommunityGroupCommandState = Readonly<{
  status: 'idle' | 'pending' | 'confirmed' | 'error'; key: string | null;
  kind: GroupCommandTarget['kind'] | null; groupId: string | null; motionId: string | null; memberId: string | null;
  invitationResult: CommunityGroupInvitationResult | null;
  removed: CommunityRemovalResult | null; motion: CommunityMotion | null; membershipResult: CommunityGroupMembershipResult | null;
  intent: CommunityIntentInspection | null; error: CommunityViewError | null; createdGroup: CommunityGroup | null;
}>;
export type CommunityGroupSnapshot = Readonly<{ [K in GroupReadName]: CommunityReadState<GroupData[K]> }> &
  Readonly<{ disposed: boolean; command: CommunityGroupCommandState }>;
export interface CommunityGroupController {
  getSnapshot(): CommunityGroupSnapshot;
  subscribe(listener: () => void): { remove(): void };
  dispose(): void;
  loadGroups(): Promise<void>;
  loadRemovedMemberships(): Promise<void>;
  loadDetail(groupId: string): Promise<void>;
  loadSharing(groupId: string): Promise<void>;
  loadMotions(groupId: string): Promise<void>;
  loadPolicy(groupId: string): Promise<void>;
  loadInvitations(groupId: string): Promise<void>;
  issueInvitation(groupId: string, key: string): Promise<CommunityIssuedInvitation>;
  revokeInvitation(groupId: string, invitationId: string, expectedRevision: number, key: string): Promise<CommunityInvitation>;
  replaceInvitation(groupId: string, invitationId: string, expectedRevision: number, key: string): Promise<CommunityIssuedInvitation>;
  updateAlias(groupId: string, input: CommunityAliasInput, key: string): Promise<CommunityMember>;
  updateRole(groupId: string, memberId: string, input: { role: 'admin' | 'member'; expectedRevision: number }, key: string): Promise<CommunityMember>;
  leave(groupId: string, input: CommunityLeaveInput, key: string): Promise<CommunityLeaveResult>;
  closeGroup(groupId: string, input: CommunityCloseGroupInput, key: string): Promise<CommunityCloseGroupResult>;
  createGrowthMotion(groupId: string, input: CommunityCreateGrowthMotionInput, key: string): Promise<CommunityMotion>;
  finalizeGrowthMotion(groupId: string, motionId: string, input: CommunityFinalizeGrowthMotionInput, key: string): Promise<CommunityMotion>;
  createRemovalMotion(groupId: string, memberId: string, input: CommunityCreateRemovalMotionInput, key: string): Promise<CommunityMotion>;
  finalizeRemovalMotion(groupId: string, motionId: string, input: CommunityFinalizeRemovalMotionInput, key: string): Promise<CommunityMotion>;
  removeMember(groupId: string, memberId: string, input: CommunityRemoveMemberInput, key: string): Promise<CommunityRemovalResult>;
  createGroup(input: CommunityCreateInput | string, key: string): Promise<CommunityGroup>;
  updateSharing(groupId: string, input: { flags: CommunityShareFlags; expectedRevision: number } | string, key: string): Promise<CommunitySharing>;
  setBallot(groupId: string, motionId: string, input: { choice: 'yes' | 'no' | 'abstain'; expectedRevision: number } | string, key: string): Promise<CommunityMotion>;
  inspectIntent(key: string): CommunityIntentInspection | null;
  retry(key: string): Promise<unknown>;
}
function groupSnapshot(disposed = false): CommunityGroupSnapshot {
  const idle = { status: 'idle' as const, groupId: null, data: null, error: null };
  return freeze<CommunityGroupSnapshot>({ disposed, invitations: idle, groups: idle, removedMemberships: idle, detail: idle, policy: idle, sharing: idle, motions: idle,
    command: { status: 'idle', key: null, kind: null, groupId: null, motionId: null, memberId: null, removed: null, motion: null, membershipResult: null, invitationResult: null, intent: null, error: null, createdGroup: null } });
}
function viewError(error: ApiError): CommunityViewError {
  return freeze({ status: error.status, code: error.code, effectUnknown: error.effectUnknown, originalEffectUnknown: error.originalEffectUnknown });
}
export type CommunityInvitationJoinSnapshot = Readonly<{
  disposed: boolean;
  preview: CommunityReadState<CommunityInvitationPreview>;
  command: Readonly<{
    status: 'idle' | 'pending' | 'confirmed' | 'error'; key: string | null;
    intent: CommunityIntentInspection | null; error: CommunityViewError | null;
    originalEffectUnknown: boolean; result: CommunityJoinResult | null;
  }>;
}>;
export interface CommunityInvitationJoinController {
  getSnapshot(): CommunityInvitationJoinSnapshot;
  subscribe(listener: () => void): { remove(): void };
  dispose(): void;
  previewInvitation(input: { token: string } | string): Promise<void>;
  joinInvitation(input: CommunityJoinInput | string, key: string): Promise<CommunityJoinResult>;
  inspectIntent(key: string): CommunityIntentInspection | null;
  retry(key: string): Promise<unknown>;
}
function invitationJoinSnapshot(disposed = false): CommunityInvitationJoinSnapshot {
  return freeze<CommunityInvitationJoinSnapshot>({ disposed, preview: { status: 'idle', groupId: null, data: null, error: null },
    command: { status: 'idle', key: null, intent: null, error: null, originalEffectUnknown: false, result: null } });
}
class MountedCommunityInvitationJoinController implements CommunityInvitationJoinController {
  private state = invitationJoinSnapshot();
  private previewToken: string | null = null;
  private previewGeneration = 0;
  private inFlight = false;
  private readonly listeners = new Set<() => void>();
  constructor(private readonly resources: CommunityResources, private readonly sessionCurrent: () => boolean, private readonly release: () => void) {}
  private current(): boolean { return !this.state.disposed && this.sessionCurrent(); }
  private changed(originalEffectUnknown = false, effectUnknown = false): ApiError {
    return new ApiError(409, 'session_changed', 'This mounted Community session ended.', effectUnknown, originalEffectUnknown);
  }
  private assertCurrent(originalEffectUnknown = false): void {
    if (!this.current()) { this.dispose(); throw this.changed(originalEffectUnknown); }
  }
  private failure(error: unknown, mutation: boolean): ApiError {
    const fallback = mutation ? 'community_outcome_unknown' : 'community_read_unavailable';
    if (!(error instanceof ApiError)) return new ApiError(0, fallback, 'The invitation result could not be confirmed.', mutation, mutation);
    // Server messages and unbounded codes can echo a submitted invitation code.
    const code = /^[a-z][a-z0-9_]{0,41}$/.test(error.code) ? error.code : fallback;
    return new ApiError(error.status, code, 'The invitation result could not be confirmed.', error.effectUnknown, error.originalEffectUnknown);
  }
  private publish(state: CommunityInvitationJoinSnapshot): void {
    this.state = freeze(state);
    for (const listener of this.listeners) { try { listener(); } catch {} }
  }
  getSnapshot(): CommunityInvitationJoinSnapshot {
    if (!this.current()) this.dispose(); return this.state;
  }
  subscribe(listener: () => void): { remove(): void } {
    this.assertCurrent(); this.listeners.add(listener); return { remove: () => { this.listeners.delete(listener); } };
  }
  dispose(): void {
    if (this.state.disposed) return;
    this.previewToken = null; this.previewGeneration++;
    this.publish(invitationJoinSnapshot(true)); this.listeners.clear(); this.release();
  }
  private clearPreview(): void {
    this.previewToken = null; this.previewGeneration++;
    this.publish({ ...this.state, preview: { status: 'stale', groupId: null, data: null, error: null } });
  }
  async previewInvitation(input: { token: string } | string): Promise<void> {
    this.assertCurrent(); const generation = ++this.previewGeneration; this.previewToken = null;
    this.publish({ ...this.state, preview: { status: 'loading', groupId: null, data: null, error: null } });
    try {
      this.assertCurrent(); const body = payload(input, invitationPreviewInput).body;
      const data = await this.resources.previewInvitation(body); this.assertCurrent();
      if (generation !== this.previewGeneration) return;
      if (JSON.stringify(data).includes(body.token)) throw new ApiError(502, 'community_invalid_response', 'The invitation preview could not be confirmed.');
      this.previewToken = body.token;
      this.publish({ ...this.state, preview: { status: 'ready', groupId: null, data, error: null } });
    } catch (error) {
      if (!this.current()) { this.dispose(); throw this.changed(); }
      if (generation !== this.previewGeneration) return;
      const failure = this.failure(error, false);
      this.publish({ ...this.state, preview: { status: 'error', groupId: null, data: null, error: viewError(failure) } });
      throw failure;
    }
  }
  inspectIntent(key: string): CommunityIntentInspection | null {
    this.assertCurrent(); commandKey(key);
    if (key !== this.state.command.key) return null;
    const intent = this.resources.inspectIntent(key);
    return intent?.path === '/invitations/join' && intent.method === 'POST' ? intent : null;
  }
  private assertAvailable(retry: boolean): void {
    this.assertCurrent();
    const originalUnknown = this.state.command.originalEffectUnknown;
    if (this.inFlight) throw new ApiError(409, 'community_intent_in_flight', 'Wait for this exact join to finish.', false, originalUnknown);
    if (!retry && this.state.command.intent?.state === 'unknown')
      throw new ApiError(409, 'community_join_reconcile_required', 'Reconcile the original join before starting another.', false, true);
  }
  async joinInvitation(input: CommunityJoinInput | string, key: string): Promise<CommunityJoinResult> {
    this.assertAvailable(false);
    let body: CommunityJoinInput;
    try {
      body = payload(input, invitationJoinInput).body; commandKey(key);
      if (key.includes(body.token) || body.alias.includes(body.token)) invalid();
      if (this.state.preview.status !== 'ready' || this.previewToken !== body.token)
        throw new ApiError(409, 'community_invitation_preview_required', 'Preview this invitation before accepting its disclosure.');
    } catch (error) {
      const failure = this.failure(error, false);
      this.publish({ ...this.state, command: { status: 'error', key: null, intent: null, error: viewError(failure), originalEffectUnknown: false, result: null } });
      throw failure;
    }
    return this.command(key, () => this.resources.joinInvitation(body, key));
  }
  retry(key: string): Promise<unknown> {
    this.assertAvailable(true); const intent = this.inspectIntent(key);
    if (!intent) throw new ApiError(404, 'community_intent_not_found', 'No retained join exists in this controller.');
    return this.command(key, () => this.resources.retry(key) as Promise<CommunityJoinResult>);
  }
  private async command(key: string, effect: () => Promise<CommunityJoinResult>): Promise<CommunityJoinResult> {
    this.assertCurrent(); this.inFlight = true;
    const prior = this.resources.inspectIntent(key);
    const originalUnknown = prior?.originalEffectUnknown ?? false;
    const pending: CommunityInvitationJoinSnapshot['command'] = {
      status: 'pending', key, intent: prior?.path === '/invitations/join' ? prior : null,
      error: null, originalEffectUnknown: originalUnknown, result: null,
    };
    try {
      this.clearPreview(); this.assertCurrent(originalUnknown);
      this.publish({ ...this.state, command: pending }); this.assertCurrent(originalUnknown);
      const request = effect();
      if (this.current()) this.publish({ ...this.state, command: { ...pending, intent: this.inspectIntent(key) } });
      const result = await request; this.assertCurrent(true);
      this.clearPreview(); this.assertCurrent(true);
      this.publish({ ...this.state, command: { ...pending, status: 'confirmed', intent: null, result } });
      this.assertCurrent(true); return result;
    } catch (error) {
      const failure = this.failure(error, true);
      if (!this.current()) { this.dispose(); throw this.changed(originalUnknown || failure.originalEffectUnknown || failure.effectUnknown, failure.effectUnknown); }
      const intent = this.inspectIntent(key);
      this.publish({ ...this.state, command: { ...pending, status: 'error', intent, error: viewError(failure),
        originalEffectUnknown: originalUnknown || failure.originalEffectUnknown || failure.effectUnknown } });
      throw failure;
    } finally { this.inFlight = false; }
  }
}
class MountedCommunityGroupController implements CommunityGroupController {
  private state = groupSnapshot();
  private invitationInFlight = false;
  private invitationKey: string | null = null;
  private readonly invitationTargets = new Map<string, InvitationCommandTarget>();
  private membershipInFlight = false;
  private membershipKey: string | null = null;
  private readonly membershipTargets = new Map<string, MembershipCommandTarget>();
  private removalInFlight = false;
  private removalKey: string | null = null;
  private readonly removalTargets = new Map<string, RemovalCommandTarget>();
  private readonly listeners = new Set<() => void>();
  private readonly reads: Record<GroupReadName, number> = { invitations: 0, groups: 0, removedMemberships: 0, detail: 0, policy: 0, sharing: 0, motions: 0 };
  private commandGeneration = 0;
  constructor(private readonly resources: CommunityResources, private readonly sessionCurrent: () => boolean, private readonly release: () => void) {}
  private current(): boolean { return !this.state.disposed && this.sessionCurrent(); }
  private changed(originalEffectUnknown = false, effectUnknown = false): ApiError {
    return new ApiError(409, 'session_changed', 'This mounted Community session ended.', effectUnknown, originalEffectUnknown);
  }
  private assertCurrent(originalEffectUnknown = false): void {
    if (!this.current()) { this.dispose(); throw this.changed(originalEffectUnknown); }
  }
  getSnapshot(): CommunityGroupSnapshot {
    if (!this.current()) this.dispose();
    return this.state;
  }
  subscribe(listener: () => void): { remove(): void } {
    this.assertCurrent(); this.listeners.add(listener); return { remove: () => { this.listeners.delete(listener); } };
  }
  private publish(state: CommunityGroupSnapshot): void {
    this.state = freeze(state);
    // Observer failures cannot change the recorded outcome of a server command.
    for (const listener of this.listeners) { try { listener(); } catch {} }
  }
  dispose(): void {
    if (this.state.disposed) return;
    this.commandGeneration++;
    for (const name of Object.keys(this.reads) as GroupReadName[]) this.reads[name]++;
    this.removalKey = null; this.removalTargets.clear();
    this.membershipKey = null; this.membershipTargets.clear();
    this.invitationKey = null; this.invitationTargets.clear();
    this.publish(groupSnapshot(true)); this.listeners.clear(); this.release();
  }
  private setRead<K extends GroupReadName>(name: K, state: CommunityReadState<GroupData[K]>): void {
    this.publish({ ...this.state, [name]: state });
  }
  private async load<K extends GroupReadName>(name: K, groupId: string | null, read: () => Promise<GroupData[K]>): Promise<void> {
    this.assertCurrent(); const generation = ++this.reads[name];
    this.setRead(name, { status: 'loading', groupId, data: null, error: null });
    try {
      this.assertCurrent(); const data = await read(); this.assertCurrent();
      if (generation !== this.reads[name]) return;
      this.setRead(name, { status: Array.isArray(data) && data.length === 0 ? 'empty' : 'ready', groupId, data, error: null });
    } catch (error) {
      if (!this.current()) { this.dispose(); throw this.changed(); }
      if (generation !== this.reads[name]) return;
      const failure = error instanceof ApiError ? error : new ApiError(0, 'community_read_unavailable', 'Community could not be read.');
      this.setRead(name, { status: 'error', groupId, data: null, error: viewError(failure) }); throw failure;
    }
  }
  loadGroups = () => this.load('groups', null, () => this.resources.listGroups());
  loadRemovedMemberships = () => this.load('removedMemberships', null, async () => {
    try { return await this.resources.listRemovedMemberships(); }
    catch (error) {
      const code = error instanceof ApiError && ['session_changed', 'community_invalid_response', 'community_lifecycle_capacity', 'community_unavailable'].includes(error.code)
        ? error.code : 'community_read_unavailable';
      throw new ApiError(error instanceof ApiError ? error.status : 0, code, 'Removed memberships could not be read.');
    }
  });
  loadDetail = (groupId: string) => this.load('detail', identifier(groupId), () => this.resources.readGroup(groupId));
  loadSharing = (groupId: string) => this.load('sharing', identifier(groupId), () => this.resources.readSharing(groupId));
  loadMotions = (groupId: string) => this.load('motions', identifier(groupId), () => this.resources.listMotions(groupId));
  loadPolicy = (groupId: string) => this.load('policy', identifier(groupId), async () => {
    try { return await this.resources.readPolicy(groupId); }
    catch (error) {
      const code = error instanceof ApiError && ['session_changed', 'community_invalid_response', 'community_not_found',
        'community_adult_eligibility_unavailable', 'community_unavailable'].includes(error.code) ? error.code : 'community_read_unavailable';
      throw new ApiError(error instanceof ApiError ? error.status : 0, code, 'The group policy could not be read.');
    }
  });
  async loadInvitations(groupId: string): Promise<void> {
    this.assertCurrent(); identifier(groupId); const generation = ++this.reads.invitations;
    this.setRead('invitations', { status: 'loading', groupId, data: null, error: null });
    try {
      this.assertCurrent(); const data = await this.resources.listInvitations(groupId); this.assertCurrent();
      if (generation !== this.reads.invitations) return;
      this.setRead('invitations', { status: data.length ? 'ready' : 'empty', groupId, data, error: null }); this.assertCurrent();
    } catch (error) {
      if (!this.current()) { this.dispose(); throw this.changed(); }
      if (generation !== this.reads.invitations) return;
      const failure = this.invitationFailure(error, false), state = { ...this.state };
      if ([401, 403, 404].includes(failure.status) && state.detail.groupId === groupId) {
        this.reads.detail++; state.detail = { status: 'stale', groupId, data: null, error: null };
      }
      state.invitations = { status: 'error', groupId, data: null, error: viewError(failure) };
      this.publish(state); this.assertCurrent(); throw failure;
    }
  }
  private target(intent: CommunityIntentInspection): GroupCommandTarget {
    if (intent.path === '/groups' && intent.method === 'POST') return { kind: 'create', groupId: null, motionId: null };
    const sharing = /^\/groups\/([^/]+)\/me\/sharing$/.exec(intent.path);
    if (sharing && intent.method === 'PATCH') return { kind: 'sharing', groupId: sharing[1]!, motionId: null };
    const ballot = /^\/groups\/([^/]+)\/motions\/([^/]+)\/ballot$/.exec(intent.path);
    if (ballot && intent.method === 'POST') return { kind: 'ballot', groupId: ballot[1]!, motionId: ballot[2]! };
    const invitation = this.invitationTargets.get(intent.key);
    if (invitation && intent.method === 'POST') {
      const path = invitation.kind === 'issue_invitation' ? `/groups/${invitation.groupId}/invitations` :
        `/groups/${invitation.groupId}/invitations/${invitation.invitationId}/${invitation.kind === 'revoke_invitation' ? 'revoke' : 'replace'}`;
      if (intent.path === path) return invitation;
    }
    const membership = this.membershipTargets.get(intent.key);
    if (membership) {
      const path = membership.kind === 'alias' ? `/groups/${membership.groupId}/me` : membership.kind === 'role' ?
        `/groups/${membership.groupId}/members/${membership.memberId}/role` : `/groups/${membership.groupId}/${membership.kind}`;
      if (intent.path === path && intent.method === (membership.kind === 'alias' || membership.kind === 'role' ? 'PATCH' : 'POST')) return membership;
    }
    const removal = this.removalTargets.get(intent.key);
    if (removal && intent.method === 'POST') {
      const path = removal.kind === 'remove' ? `/groups/${removal.groupId}/members/${removal.memberId}/remove` :
        removal.kind === 'removal_motion' || removal.kind === 'growth_motion' ? `/groups/${removal.groupId}/motions` : `/groups/${removal.groupId}/motions/${removal.motionId}/finalize`;
      if (intent.path === path) return removal;
    }
    throw new ApiError(404, 'community_controller_intent_unavailable', 'This change is not available to this group controller.');
  }
  inspectIntent(key: string): CommunityIntentInspection | null {
    this.assertCurrent(); const intent = this.resources.inspectIntent(key);
    if (intent) this.target(intent); return intent;
  }
  private invalidate(target: GroupCommandTarget): void {
    const name = target.kind === 'create' ? 'groups' : target.kind === 'sharing' ? 'sharing' : 'motions';
    if (this.state[name].groupId !== target.groupId) return;
    this.reads[name]++; this.setRead(name, { status: 'stale', groupId: target.groupId, data: null, error: null });
  }
  private async command<T>(target: GroupCommandTarget, key: string, effect: () => Promise<T>): Promise<T> {
    this.removalAvailable(); commandKey(key); const generation = ++this.commandGeneration;
    this.invalidate(target);
    const pending: CommunityGroupCommandState = { ...target, memberId: null, removed: null, motion: null, membershipResult: null, invitationResult: null, status: 'pending', key, intent: this.inspectIntent(key), error: null, createdGroup: null };
    if (generation === this.commandGeneration) this.publish({ ...this.state, command: pending });
    try {
      this.assertCurrent(); const request = effect();
      if (this.current() && generation === this.commandGeneration)
        this.publish({ ...this.state, command: { ...pending, intent: this.resources.inspectIntent(key) } });
      const result = await request; this.assertCurrent(true);
      this.invalidate(target);
      if (generation === this.commandGeneration) this.publish({ ...this.state, command: { ...pending, status: 'confirmed', intent: this.inspectIntent(key),
        createdGroup: target.kind === 'create' ? result as CommunityGroup : null } });
      this.assertCurrent(true); return result;
    } catch (error) {
      const failure = error instanceof ApiError ? error : new ApiError(0, 'community_outcome_unknown', 'The change could not be confirmed.', true, true);
      if (!this.current()) { this.dispose(); throw this.changed(failure.originalEffectUnknown || failure.effectUnknown, failure.effectUnknown); }
      this.invalidate(target);
      if (!this.current()) throw this.changed(failure.originalEffectUnknown || failure.effectUnknown, failure.effectUnknown);
      if (generation === this.commandGeneration) this.publish({ ...this.state, command: { ...pending, status: 'error', intent: this.inspectIntent(key), error: viewError(failure) } });
      throw failure;
    }
  }
  private removalAvailable(retryKey?: string): void {
    this.invitationFence(retryKey);
    this.membershipFence(retryKey);
    this.assertCurrent(); const intent = this.removalKey ? this.resources.inspectIntent(this.removalKey) : null;
    const kind = this.removalKey ? this.removalTargets.get(this.removalKey)?.kind : undefined;
    const growth = kind === 'growth_motion' || kind === 'finalize_growth';
    if (this.removalInFlight || intent?.state === 'pending')
      throw new ApiError(409, 'community_intent_in_flight', growth ? 'Wait for the original expansion.' : 'Wait for the original removal.', false, intent?.originalEffectUnknown ?? false);
    if (intent?.state === 'unknown' && retryKey !== this.removalKey)
      throw new ApiError(409, growth ? 'community_growth_reconcile_required' : 'community_removal_reconcile_required',
        growth ? 'Retry the original expansion before starting another change.' : 'Retry the original removal before starting another change.', false, true);
  }
  private invalidateRemoval(target: RemovalCommandTarget, accessRejected = false, stalePolicy = false): void {
    const groupId = target.groupId, state = { ...this.state };
    const names: ('detail' | 'motions' | 'policy' | 'invitations')[] = target.kind === 'finalize_growth' && !accessRejected ? ['policy', 'motions'] :
      (target.kind === 'removal_motion' || target.kind === 'growth_motion') && !accessRejected ? ['motions'] : ['detail', 'motions'];
    if (accessRejected) names.push('invitations');
    if ((accessRejected && target.kind !== 'remove') || stalePolicy) names.push('policy');
    for (const name of names) {
      if (state[name].groupId !== groupId) continue;
      this.reads[name]++; state[name] = { status: 'stale', groupId, data: null, error: null };
    }
    if (accessRejected) { this.reads.groups++; state.groups = { status: 'stale', groupId: null, data: null, error: null }; }
    this.publish(state);
  }
  private async removalCommand<T extends CommunityRemovalResult | CommunityMotion>(target: RemovalCommandTarget, key: string,
    effect: () => Promise<T>): Promise<T> {
    if (target.kind === 'growth_motion' || target.kind === 'finalize_growth') this.growthAvailable(key); else this.removalAvailable(key);
    this.removalInFlight = true; this.removalKey = key; this.removalTargets.set(key, target);
    const generation = ++this.commandGeneration;
    const pending: CommunityGroupCommandState = { ...target, status: 'pending', key, intent: this.resources.inspectIntent(key),
      error: null, createdGroup: null, removed: null, motion: null, membershipResult: null, invitationResult: null };
    try {
      this.publish({ ...this.state, command: pending }); this.assertCurrent();
      this.invalidateRemoval(target); this.assertCurrent();
      const request = effect();
      if (this.current()) this.publish({ ...this.state, command: { ...pending, intent: this.resources.inspectIntent(key) } });
      const result = await request; this.assertCurrent(true);
      this.invalidateRemoval(target); this.assertCurrent(true);
      if (generation === this.commandGeneration)
        this.publish({ ...this.state, command: { ...pending, status: 'confirmed', intent: this.resources.inspectIntent(key),
          removed: target.kind === 'remove' ? result as CommunityRemovalResult : null,
          motion: target.kind === 'remove' ? null : result as CommunityMotion } });
      this.assertCurrent(true); return result;
    } catch (error) {
      const codes = ['community_invalid_response', 'community_not_found', 'community_forbidden', 'community_adult_eligibility_unavailable',
        'community_governed_action_required', 'community_membership_changed', 'stale_revision', 'idempotency_conflict',
        'community_intent_capacity', 'community_unavailable', 'community_outcome_unknown', 'session_changed',
        'community_motion_tenure_required', 'community_motion_not_due', 'community_motion_expired', 'community_motion_quota',
        'community_motion_cooldown', 'community_electorate_unavailable', 'community_account_tenure_unavailable',
        'community_limiter_unavailable', 'community_receipt_capacity', 'community_rate_limited'];
      const growth = target.kind === 'growth_motion' || target.kind === 'finalize_growth';
      if (growth) codes.push('community_growth_unavailable', 'community_capacity_unavailable');
      const message = growth ? 'The expansion could not be confirmed.' : 'The removal could not be confirmed.';
      const failure = error instanceof ApiError
        ? new ApiError(error.status, codes.includes(error.code) ? error.code : growth ? 'community_growth_unavailable' : 'community_removal_unavailable', message, error.effectUnknown, error.originalEffectUnknown)
        : new ApiError(0, 'community_outcome_unknown', message, true, true);
      if (!this.current()) { this.dispose(); throw this.changed(failure.originalEffectUnknown || failure.effectUnknown, failure.effectUnknown); }
      if (!this.resources.inspectIntent(key)) this.removalTargets.delete(key);
      this.invalidateRemoval(target, ([401, 403, 404].includes(failure.status) &&
        (target.kind === 'remove' || failure.code !== 'community_motion_tenure_required')) || failure.code === 'community_membership_changed',
        (target.kind === 'removal_motion' || target.kind === 'growth_motion') && failure.code === 'stale_revision');
      this.assertCurrent(failure.originalEffectUnknown);
      if (generation === this.commandGeneration)
        this.publish({ ...this.state, command: { ...pending, status: 'error', intent: this.resources.inspectIntent(key), error: viewError(failure) } });
      throw failure;
    } finally { this.removalInFlight = false; }
  }
  private invitationFailure(error: unknown, mutation: boolean): ApiError {
    const codes = ['community_invalid_input', 'community_invalid_response', 'community_not_found', 'community_forbidden',
      'community_adult_eligibility_unavailable', 'community_governed_action_required', 'community_membership_changed',
      'community_invitation_used', 'community_invitation_unavailable', 'community_invitation_capacity', 'community_invitation_replay_invalid',
      'stale_revision', 'idempotency_conflict', 'community_intent_capacity', 'community_limiter_unavailable', 'community_rate_limited',
      'community_unavailable', 'community_outcome_unknown', 'session_changed'];
    const fallback = mutation ? 'community_outcome_unknown' : 'community_read_unavailable';
    return error instanceof ApiError ? new ApiError(error.status, codes.includes(error.code) ? error.code : fallback,
      'The invitation result could not be confirmed.', error.effectUnknown, error.originalEffectUnknown) :
      new ApiError(0, fallback, 'The invitation result could not be confirmed.', mutation, mutation);
  }
  private invitationFence(retryKey?: string): void {
    this.assertCurrent(); const intent = this.invitationKey ? this.resources.inspectIntent(this.invitationKey) : null;
    if (this.invitationInFlight || intent?.state === 'pending')
      throw new ApiError(409, 'community_intent_in_flight', 'Wait for the original invitation change.', false, intent?.originalEffectUnknown ?? false);
    if (intent?.state === 'unknown' && retryKey !== this.invitationKey)
      throw new ApiError(409, 'community_invitation_reconcile_required', 'Retry the original invitation change.', false, true);
  }
  private invitationAvailable(retryKey?: string): void {
    this.removalAvailable(retryKey);
    const intent = this.state.command.key ? this.resources.inspectIntent(this.state.command.key) : null;
    if (this.state.command.status === 'pending' || intent?.state === 'pending')
      throw new ApiError(409, 'community_intent_in_flight', 'Wait for the original change.', false, intent?.originalEffectUnknown ?? false);
    if (intent?.state === 'unknown' && retryKey !== this.state.command.key)
      throw new ApiError(409, 'community_invitation_reconcile_required', 'Retry the original change before managing invitations.', false, true);
  }
  private invitationManager(groupId: string): void {
    const detail = this.state.detail;
    if (detail.status !== 'ready' || detail.groupId !== groupId)
      throw new ApiError(409, 'community_invitation_reload_required', 'Load the current group before managing invitations.');
    if (detail.data.role !== 'owner' && detail.data.role !== 'admin') {
      this.invalidateInvitations(groupId);
      throw new ApiError(403, 'community_forbidden', 'Only a group manager can use this invitation action.');
    }
  }
  private selectInvitation(groupId: string, invitationId: string, expectedRevision: number): void {
    const invitations = this.state.invitations, result = this.state.command.status === 'confirmed' ? this.state.command.invitationResult?.value : undefined;
    const listed = invitations.status === 'ready' && invitations.groupId === groupId ? invitations.data.find(value => value.id === invitationId) : undefined;
    const selected = listed ?? (result?.groupId === groupId && result.id === invitationId ? result : undefined);
    if (!selected || selected.revision !== expectedRevision)
      throw new ApiError(409, 'community_invitation_reload_required', 'Select current invitation metadata before changing it.');
  }
  private invalidateInvitations(groupId: string, inaccessible = false): void {
    const state = { ...this.state };
    if (state.invitations.groupId === groupId) {
      this.reads.invitations++; state.invitations = { status: 'stale', groupId, data: null, error: null };
    }
    if (inaccessible && state.detail.groupId === groupId) {
      this.reads.detail++; state.detail = { status: 'stale', groupId, data: null, error: null };
    }
    this.publish(state);
  }
  private async invitationCommand<T extends CommunityIssuedInvitation>(target: InvitationCommandTarget, key: string, effect: () => Promise<T>): Promise<T> {
    this.invitationAvailable(key); this.invitationInFlight = true; this.invitationKey = key; this.invitationTargets.set(key, target);
    const generation = ++this.commandGeneration;
    const pending: CommunityGroupCommandState = { kind: target.kind, groupId: target.groupId, memberId: null, motionId: null, status: 'pending', key, intent: this.resources.inspectIntent(key),
      error: null, createdGroup: null, removed: null, motion: null, membershipResult: null, invitationResult: null };
    try {
      this.publish({ ...this.state, command: pending }); this.assertCurrent(); this.invalidateInvitations(target.groupId); this.assertCurrent();
      const request = effect();
      if (this.current()) this.publish({ ...this.state, command: { ...pending, intent: this.resources.inspectIntent(key) } });
      const value = await request; this.assertCurrent(true); this.invalidateInvitations(target.groupId); this.assertCurrent(true);
      const metadata: CommunityInvitation = { id: value.id, groupId: value.groupId, revision: value.revision, state: value.state,
        createdAt: value.createdAt, expiresAt: value.expiresAt, tokenAvailable: false };
      if (generation === this.commandGeneration)
        this.publish({ ...this.state, command: { ...pending, status: 'confirmed', intent: this.resources.inspectIntent(key), invitationResult: { kind: target.kind, value: metadata } } });
      this.assertCurrent(true); return value;
    } catch (error) {
      const failure = this.invitationFailure(error, true);
      if (!this.current()) { this.dispose(); throw this.changed(failure.originalEffectUnknown || failure.effectUnknown, failure.effectUnknown); }
      if (!this.resources.inspectIntent(key)) this.invitationTargets.delete(key);
      this.invalidateInvitations(target.groupId, [401, 403, 404].includes(failure.status) || failure.code === 'community_membership_changed');
      this.assertCurrent(failure.originalEffectUnknown);
      if (generation === this.commandGeneration)
        this.publish({ ...this.state, command: { ...pending, status: 'error', intent: this.resources.inspectIntent(key), error: viewError(failure) } });
      throw failure;
    } finally { this.invitationInFlight = false; }
  }
  async issueInvitation(groupId: string, key: string): Promise<CommunityIssuedInvitation> {
    this.invitationAvailable(); identifier(groupId); commandKey(key); this.invitationManager(groupId);
    if (this.resources.inspectIntent(key)) throw new ApiError(409, 'community_controller_intent_unavailable', 'Use explicit retry for the retained invitation.');
    return this.invitationCommand({ kind: 'issue_invitation', groupId, invitationId: null, memberId: null, motionId: null }, key,
      () => this.resources.issueInvitation(groupId, key));
  }
  async revokeInvitation(groupId: string, invitationId: string, expectedRevision: number, key: string): Promise<CommunityInvitation> {
    this.invitationAvailable(); identifier(groupId); identifier(invitationId); revision(expectedRevision); commandKey(key); this.invitationManager(groupId);
    if (this.resources.inspectIntent(key)) throw new ApiError(409, 'community_controller_intent_unavailable', 'Use explicit retry for the retained revocation.');
    this.selectInvitation(groupId, invitationId, expectedRevision);
    return this.invitationCommand({ kind: 'revoke_invitation', groupId, invitationId, memberId: null, motionId: null }, key,
      () => this.resources.revokeInvitation(groupId, invitationId, expectedRevision, key));
  }
  async replaceInvitation(groupId: string, invitationId: string, expectedRevision: number, key: string): Promise<CommunityIssuedInvitation> {
    this.invitationAvailable(); identifier(groupId); identifier(invitationId); revision(expectedRevision); commandKey(key); this.invitationManager(groupId);
    if (this.resources.inspectIntent(key)) throw new ApiError(409, 'community_controller_intent_unavailable', 'Use explicit retry for the retained replacement.');
    this.selectInvitation(groupId, invitationId, expectedRevision);
    return this.invitationCommand({ kind: 'replace_invitation', groupId, invitationId, memberId: null, motionId: null }, key,
      () => this.resources.replaceInvitation(groupId, invitationId, expectedRevision, key, { differentId: true }));
  }
  private membershipFence(retryKey?: string): void {
    this.assertCurrent(); const intent = this.membershipKey ? this.resources.inspectIntent(this.membershipKey) : null;
    if (this.membershipInFlight || intent?.state === 'pending')
      throw new ApiError(409, 'community_intent_in_flight', 'Wait for the original membership change.', false, intent?.originalEffectUnknown ?? false);
    if (intent?.state === 'unknown' && retryKey !== this.membershipKey)
      throw new ApiError(409, 'community_membership_reconcile_required', 'Retry the original membership change.', false, true);
  }
  private membershipAvailable(retryKey?: string): void {
    this.removalAvailable(retryKey);
    const intent = this.state.command.key ? this.resources.inspectIntent(this.state.command.key) : null;
    if (this.state.command.status === 'pending' || intent?.state === 'pending')
      throw new ApiError(409, 'community_intent_in_flight', 'Wait for the original change.', false, intent?.originalEffectUnknown ?? false);
    if (intent?.state === 'unknown' && retryKey !== this.state.command.key)
      throw new ApiError(409, 'community_membership_reconcile_required', 'Retry the original change before starting a membership change.', false, true);
  }
  private invalidateMembership(target: MembershipCommandTarget, accessRejected = false): void {
    const state = { ...this.state }, groupId = target.groupId;
    const names: ('detail' | 'sharing' | 'policy' | 'motions' | 'invitations')[] = target.kind === 'alias' && !accessRejected ? ['detail'] : ['detail', 'sharing', 'policy', 'motions', 'invitations'];
    for (const name of names) {
      if (state[name].groupId !== groupId) continue;
      this.reads[name]++; state[name] = { status: 'stale', groupId, data: null, error: null };
    }
    if (target.kind !== 'alias' || accessRejected) { this.reads.groups++; state.groups = { status: 'stale', groupId: null, data: null, error: null }; }
    this.publish(state);
  }
  private async membershipCommand<T extends CommunityMember | CommunityLeaveResult | CommunityCloseGroupResult>(target: MembershipCommandTarget,
    key: string, effect: () => Promise<T>): Promise<T> {
    this.membershipAvailable(key); this.membershipInFlight = true; this.membershipKey = key; this.membershipTargets.set(key, target);
    const generation = ++this.commandGeneration;
    const pending: CommunityGroupCommandState = { ...target, status: 'pending', key, intent: this.resources.inspectIntent(key),
      error: null, createdGroup: null, removed: null, motion: null, membershipResult: null, invitationResult: null };
    try {
      this.publish({ ...this.state, command: pending }); this.assertCurrent();
      this.invalidateMembership(target); this.assertCurrent();
      const request = effect();
      if (this.current()) this.publish({ ...this.state, command: { ...pending, intent: this.resources.inspectIntent(key) } });
      const result = await request; this.assertCurrent(true);
      this.invalidateMembership(target); this.assertCurrent(true);
      const membershipResult: CommunityGroupMembershipResult = target.kind === 'alias' || target.kind === 'role' ? { kind: target.kind, value: result as CommunityMember } :
        target.kind === 'leave' ? { kind: 'leave', value: result as CommunityLeaveResult } : { kind: 'close', value: result as CommunityCloseGroupResult };
      if (generation === this.commandGeneration)
        this.publish({ ...this.state, command: { ...pending, status: 'confirmed', intent: this.resources.inspectIntent(key), membershipResult } });
      this.assertCurrent(true); return result;
    } catch (error) {
      const codes = ['community_invalid_response', 'community_not_found', 'community_forbidden', 'community_adult_eligibility_unavailable',
        'community_membership_changed', 'community_owner_must_close', 'community_governed_action_required', 'stale_revision', 'idempotency_conflict', 'community_intent_capacity',
        'community_unavailable', 'community_outcome_unknown', 'session_changed', 'community_text_rejected', 'community_text_moderation_unavailable',
        'community_limiter_unavailable', 'community_receipt_capacity', 'community_rate_limited'];
      const code = error instanceof ApiError && codes.includes(error.code) ? error.code : error instanceof ApiError ? 'community_membership_unavailable' : 'community_outcome_unknown';
      const message = code === 'community_text_rejected' ? 'This alias cannot be used in Form groups. Rephrase it and try again.' : 'The membership change could not be confirmed.';
      const failure = error instanceof ApiError ? new ApiError(error.status, code, message, error.effectUnknown, error.originalEffectUnknown) : new ApiError(0, code, message, true, true);
      if (!this.current()) { this.dispose(); throw this.changed(failure.originalEffectUnknown || failure.effectUnknown, failure.effectUnknown); }
      if (!this.resources.inspectIntent(key)) this.membershipTargets.delete(key);
      this.invalidateMembership(target, [401, 403, 404].includes(failure.status) || failure.code === 'community_membership_changed');
      this.assertCurrent(failure.originalEffectUnknown);
      if (generation === this.commandGeneration)
        this.publish({ ...this.state, command: { ...pending, status: 'error', intent: this.resources.inspectIntent(key), error: viewError(failure) } });
      throw failure;
    } finally { this.membershipInFlight = false; }
  }
  async updateAlias(groupId: string, input: CommunityAliasInput, key: string): Promise<CommunityMember> {
    this.membershipAvailable(); identifier(groupId); commandKey(key);
    const body = exact({ alias: text(60), expectedRevision: revision })(input);
    if (this.resources.inspectIntent(key)) throw new ApiError(409, 'community_controller_intent_unavailable', 'Use explicit retry for the retained alias change.');
    const detail = this.state.detail;
    const own = detail.status === 'ready' && detail.groupId === groupId ? detail.data.members.find(value => value.memberId === detail.data.memberId) : undefined;
    if (!own || own.revision !== body.expectedRevision)
      throw new ApiError(409, 'community_membership_reload_required', 'Load the current own membership before changing the alias.');
    return this.membershipCommand({ kind: 'alias', groupId, memberId: own.memberId, motionId: null }, key,
      () => this.resources.updateAlias(groupId, body, key, { memberId: own.memberId }));
  }
  async updateRole(groupId: string, memberId: string, input: { role: 'admin' | 'member'; expectedRevision: number }, key: string): Promise<CommunityMember> {
    this.membershipAvailable(); identifier(groupId); identifier(memberId); commandKey(key);
    const body = exact({ role: enumeration(['admin', 'member'] as const), expectedRevision: revision })(input);
    if (this.resources.inspectIntent(key)) throw new ApiError(409, 'community_controller_intent_unavailable', 'Use explicit retry for the retained role change.');
    const detail = this.state.detail;
    if (detail.status !== 'ready' || detail.groupId !== groupId)
      throw new ApiError(409, 'community_membership_reload_required', 'Load the current group before changing a role.');
    const target = detail.data.members.find(value => value.memberId === memberId);
    if (!target || target.revision !== body.expectedRevision)
      throw new ApiError(409, 'community_membership_reload_required', 'Load the current member before changing a role.');
    if (detail.data.role !== 'owner' || target.role === 'owner')
      throw new ApiError(403, 'community_forbidden', 'Only the group owner can change a non-owner role.');
    return this.membershipCommand({ kind: 'role', groupId, memberId, motionId: null }, key,
      () => this.resources.updateRole(groupId, memberId, body, key));
  }
  async leave(groupId: string, input: CommunityLeaveInput, key: string): Promise<CommunityLeaveResult> {
    this.membershipAvailable(); identifier(groupId); commandKey(key); exact({ confirmed: literal(true) })(input);
    if (this.resources.inspectIntent(key)) throw new ApiError(409, 'community_controller_intent_unavailable', 'Use explicit retry for the retained leave request.');
    return this.membershipCommand({ kind: 'leave', groupId, memberId: null, motionId: null }, key, () => this.resources.leave(groupId, key));
  }
  async closeGroup(groupId: string, input: CommunityCloseGroupInput, key: string): Promise<CommunityCloseGroupResult> {
    this.membershipAvailable(); identifier(groupId); commandKey(key);
    const body = exact({ expectedRevision: revision, confirmed: literal(true) })(input);
    if (this.resources.inspectIntent(key)) throw new ApiError(409, 'community_controller_intent_unavailable', 'Use explicit retry for the retained closure.');
    const detail = this.state.detail;
    if (detail.status !== 'ready' || detail.groupId !== groupId || detail.data.revision !== body.expectedRevision)
      throw new ApiError(409, 'community_membership_reload_required', 'Load the current group before confirming closure.');
    if (detail.data.role !== 'owner') throw new ApiError(403, 'community_forbidden', 'Only the group owner can close this group.');
    return this.membershipCommand({ kind: 'close', groupId, memberId: null, motionId: null }, key,
      () => this.resources.closeGroup(groupId, body.expectedRevision, key));
  }
  async removeMember(groupId: string, memberId: string, input: CommunityRemoveMemberInput, key: string): Promise<CommunityRemovalResult> {
    this.removalAvailable(); identifier(groupId); identifier(memberId); commandKey(key);
    const body = exact({ expectedRevision: revision, confirmed: literal(true) })(input);
    if (this.resources.inspectIntent(key)) throw new ApiError(409, 'community_controller_intent_unavailable', 'Use explicit retry for the retained removal.');
    const detail = this.state.detail;
    if (detail.status !== 'ready' || detail.groupId !== groupId)
      throw new ApiError(409, 'community_removal_reload_required', 'Load the current group before confirming removal.');
    const target = detail.data.members.find(value => value.memberId === memberId);
    if (!target || target.revision !== body.expectedRevision)
      throw new ApiError(409, 'community_removal_reload_required', 'Load the current member before confirming removal.');
    if (detail.data.role === 'member' || memberId === detail.data.memberId || target.role === 'owner' ||
      (detail.data.role === 'admin' && target.role !== 'member'))
      throw new ApiError(403, 'community_forbidden', 'This member cannot be removed through this action.');
    return this.removalCommand({ kind: 'remove', groupId, memberId, motionId: null }, key,
      () => this.resources.removeMember(groupId, memberId, body.expectedRevision, key));
  }
  private growthAvailable(retryKey?: string): void {
    this.removalAvailable(retryKey);
    const intent = this.state.command.key ? this.resources.inspectIntent(this.state.command.key) : null;
    if (this.state.command.status === 'pending' || intent?.state === 'pending')
      throw new ApiError(409, 'community_intent_in_flight', 'Wait for the original change.');
    if (intent?.state === 'unknown' && retryKey !== this.state.command.key)
      throw new ApiError(409, 'community_growth_reconcile_required', 'Retry the original change before requesting expansion.', false, true);
  }
  async createGrowthMotion(groupId: string, input: CommunityCreateGrowthMotionInput, key: string): Promise<CommunityMotion> {
    this.growthAvailable(); identifier(groupId); commandKey(key);
    const body = exact({ places: number(1, 4), expectedRevision: revision, confirmed: literal(true) })(input);
    if (this.resources.inspectIntent(key)) throw new ApiError(409, 'community_controller_intent_unavailable', 'Use explicit retry for the retained motion.');
    const policy = this.state.policy;
    if (policy.status !== 'ready' || policy.groupId !== groupId || policy.data.revision !== body.expectedRevision)
      throw new ApiError(409, 'community_growth_reload_required', 'Load the current policy before confirming expansion.');
    return this.removalCommand({ kind: 'growth_motion', groupId, motionId: null, memberId: null }, key,
      () => this.resources.createMotion(groupId, { kind: 'growth', places: body.places, expectedRevision: body.expectedRevision }, key, { kind: 'growth', places: body.places }));
  }
  async finalizeGrowthMotion(groupId: string, motionId: string, input: CommunityFinalizeGrowthMotionInput, key: string): Promise<CommunityMotion> {
    this.growthAvailable(); identifier(groupId); identifier(motionId); commandKey(key); exact({ confirmed: literal(true) })(input);
    if (this.resources.inspectIntent(key)) throw new ApiError(409, 'community_controller_intent_unavailable', 'Use explicit retry for the retained finalization.');
    const motions = this.state.motions;
    const selected = motions.status === 'ready' && motions.groupId === groupId ? motions.data.find(value => value.id === motionId && value.kind === 'growth') : undefined;
    if (!selected || selected.places === null)
      throw new ApiError(409, 'community_growth_reload_required', 'Select a current expansion motion before confirming finalization.');
    const places = selected.places;
    return this.removalCommand({ kind: 'finalize_growth', groupId, motionId, memberId: null }, key,
      () => this.resources.finalizeMotion(groupId, motionId, key, { kind: 'growth', places }));
  }
  async createRemovalMotion(groupId: string, memberId: string, input: CommunityCreateRemovalMotionInput, key: string): Promise<CommunityMotion> {
    this.removalAvailable(); identifier(groupId); identifier(memberId); commandKey(key);
    const body = exact({ expectedRevision: revision, confirmed: literal(true) })(input);
    if (this.resources.inspectIntent(key)) throw new ApiError(409, 'community_controller_intent_unavailable', 'Use explicit retry for the retained removal motion.');
    const detail = this.state.detail, policy = this.state.policy;
    if (detail.status !== 'ready' || detail.groupId !== groupId || policy.status !== 'ready' || policy.groupId !== groupId || policy.data.revision !== body.expectedRevision)
      throw new ApiError(409, 'community_removal_reload_required', 'Load the current group and policy before confirming this motion.');
    const target = detail.data.members.find(value => value.memberId === memberId);
    if (!target) throw new ApiError(409, 'community_removal_reload_required', 'Load the current member before confirming this motion.');
    if (target.role !== 'member' || memberId === detail.data.memberId)
      throw new ApiError(403, 'community_forbidden', 'This member cannot be the subject of this motion.');
    return this.removalCommand({ kind: 'removal_motion', groupId, memberId, motionId: null }, key,
      () => this.resources.createMotion(groupId, { kind: 'removal', memberId, expectedRevision: body.expectedRevision }, key, { kind: 'removal', memberId }));
  }
  async finalizeRemovalMotion(groupId: string, motionId: string, input: CommunityFinalizeRemovalMotionInput, key: string): Promise<CommunityMotion> {
    this.removalAvailable(); identifier(groupId); identifier(motionId); commandKey(key); exact({ confirmed: literal(true) })(input);
    if (this.resources.inspectIntent(key)) throw new ApiError(409, 'community_controller_intent_unavailable', 'Use explicit retry for the retained finalization.');
    const motions = this.state.motions;
    if (motions.status !== 'ready' || motions.groupId !== groupId)
      throw new ApiError(409, 'community_removal_reload_required', 'Load the current motions before confirming finalization.');
    const selected = motions.data.find(value => value.id === motionId);
    if (!selected || selected.kind !== 'removal')
      throw new ApiError(409, 'community_removal_reload_required', 'Select a current removal motion before confirming finalization.');
    return this.removalCommand({ kind: 'finalize_removal', groupId, motionId, memberId: selected.subjectMemberId }, key,
      () => this.resources.finalizeMotion(groupId, motionId, key, { kind: 'removal' }));
  }
  createGroup = (input: CommunityCreateInput | string, key: string) =>
    this.command({ kind: 'create', groupId: null, motionId: null }, key, () => this.resources.createGroup(input, key));
  updateSharing = (groupId: string, input: { flags: CommunityShareFlags; expectedRevision: number } | string, key: string) =>
    this.command({ kind: 'sharing', groupId: identifier(groupId), motionId: null }, key, () => this.resources.updateSharing(groupId, input, key));
  setBallot = (groupId: string, motionId: string, input: { choice: 'yes' | 'no' | 'abstain'; expectedRevision: number } | string, key: string) =>
    this.command({ kind: 'ballot', groupId: identifier(groupId), motionId: identifier(motionId) }, key, () => this.resources.setBallot(groupId, motionId, input, key));
  retry(key: string): Promise<unknown> {
    const intent = this.inspectIntent(key);
    if (!intent) throw new ApiError(404, 'community_intent_not_found', 'No retained change exists in this mounted session.');
    const target = this.target(intent);
    if (target.kind === 'issue_invitation' || target.kind === 'revoke_invitation' || target.kind === 'replace_invitation')
      return this.invitationCommand(target, key, () => this.resources.retry(key) as Promise<CommunityIssuedInvitation>);
    if (target.kind === 'alias' || target.kind === 'role' || target.kind === 'leave' || target.kind === 'close')
      return this.membershipCommand(target, key, () => this.resources.retry(key) as Promise<CommunityMember | CommunityLeaveResult | CommunityCloseGroupResult>);
    if (target.kind === 'remove' || target.kind === 'removal_motion' || target.kind === 'finalize_removal' || target.kind === 'growth_motion' || target.kind === 'finalize_growth')
      return this.removalCommand(target, key, () => this.resources.retry(key) as Promise<CommunityRemovalResult | CommunityMotion>);
    return this.command(target, key, () => this.resources.retry(key));
  }
}

type SafetyData = { reports: readonly CommunitySafetyCase[]; notices: readonly CommunitySafetyNotice[];
  appeals: readonly CommunitySafetyCase[]; blocks: readonly CommunityBlock[] };
type SafetyReadName = keyof SafetyData;
export type CommunitySafetyResult = Readonly<
  { kind: 'reference'; value: CommunitySafetyReference } |
  { kind: 'report' | 'appeal'; value: CommunitySafetyCase } |
  { kind: 'block' | 'unblock'; value: CommunityBlock }
>;
export type CommunitySafetyCommandState = Readonly<{
  status: 'idle' | 'pending' | 'confirmed' | 'error'; kind: CommunitySafetyResult['kind'] | null;
  key: string | null; intent: CommunityIntentInspection | null; error: CommunityViewError | null;
  result: CommunitySafetyResult | null;
}>;
export type CommunitySafetySnapshot = Readonly<{ [K in SafetyReadName]: CommunityReadState<SafetyData[K]> }> &
  Readonly<{ disposed: boolean; command: CommunitySafetyCommandState }>;
export interface CommunitySafetyController {
  getSnapshot(): CommunitySafetySnapshot;
  subscribe(listener: () => void): { remove(): void };
  dispose(): void;
  loadReports(): Promise<void>;
  loadNotices(): Promise<void>;
  loadAppeals(): Promise<void>;
  loadBlocks(): Promise<void>;
  createSafetyReference(...args: Parameters<CommunityResources['createSafetyReference']>): Promise<CommunitySafetyReference>;
  report(...args: Parameters<CommunityResources['report']>): Promise<CommunitySafetyCase>;
  appeal(...args: Parameters<CommunityResources['appeal']>): Promise<CommunitySafetyCase>;
  blockMember(...args: Parameters<CommunityResources['blockMember']>): Promise<CommunityBlock>;
  unblock(...args: Parameters<CommunityResources['unblock']>): Promise<CommunityBlock>;
  inspectIntent(key: string): CommunityIntentInspection | null;
  retry(key: string): Promise<unknown>;
}
function safetySnapshot(disposed = false): CommunitySafetySnapshot {
  const idle = { status: 'idle' as const, groupId: null, data: null, error: null };
  return freeze<CommunitySafetySnapshot>({ disposed, reports: idle, notices: idle, appeals: idle, blocks: idle,
    command: { status: 'idle', kind: null, key: null, intent: null, error: null, result: null } });
}
const safetyErrorCodes = new Set(['community_invalid_input', 'community_invalid_response', 'community_not_found',
  'community_forbidden', 'community_adult_eligibility_unavailable', 'stale_revision',
  'idempotency_conflict', 'community_appeal_expired', 'community_appeal_exists', 'community_report_quota',
  'community_reference_capacity', 'community_block_capacity', 'community_receipt_capacity', 'community_limiter_unavailable',
  'community_rate_limited', 'community_unavailable', 'community_outcome_unknown',
  'community_read_unavailable', 'session_changed']);
class MountedCommunitySafetyController implements CommunitySafetyController {
  private state = safetySnapshot();
  private inFlight = false;
  private readonly reads: Record<SafetyReadName, number> = { reports: 0, notices: 0, appeals: 0, blocks: 0 };
  private readonly listeners = new Set<() => void>();
  constructor(private readonly resources: CommunityResources, private readonly sessionCurrent: () => boolean, private readonly release: () => void) {}
  private current(): boolean { return !this.state.disposed && this.sessionCurrent(); }
  private changed(originalEffectUnknown = false, effectUnknown = false): ApiError {
    return new ApiError(409, 'session_changed', 'This mounted Community session ended.', effectUnknown, originalEffectUnknown);
  }
  private assertCurrent(originalEffectUnknown = false): void {
    if (!this.current()) { this.dispose(); throw this.changed(originalEffectUnknown); }
  }
  private failure(error: unknown, mutation: boolean): ApiError {
    const fallback = mutation ? 'community_outcome_unknown' : 'community_read_unavailable';
    if (!(error instanceof ApiError)) return new ApiError(0, fallback, 'The safety result could not be confirmed.', mutation, mutation);
    return new ApiError(error.status, safetyErrorCodes.has(error.code) ? error.code : fallback,
      'The safety result could not be confirmed.', error.effectUnknown, error.originalEffectUnknown);
  }
  private publish(state: CommunitySafetySnapshot): void {
    this.state = freeze(state);
    for (const listener of this.listeners) {
      if (this.state !== state) break;
      try { listener(); } catch {}
    }
  }
  getSnapshot(): CommunitySafetySnapshot {
    if (!this.current()) this.dispose(); return this.state;
  }
  subscribe(listener: () => void): { remove(): void } {
    this.assertCurrent(); this.listeners.add(listener); return { remove: () => { this.listeners.delete(listener); } };
  }
  dispose(): void {
    if (this.state.disposed) return;
    for (const name of Object.keys(this.reads) as SafetyReadName[]) this.reads[name]++;
    this.publish(safetySnapshot(true)); this.listeners.clear(); this.release();
  }
  private async load<K extends SafetyReadName>(name: K, read: () => Promise<SafetyData[K]>): Promise<void> {
    this.assertCurrent(); const generation = ++this.reads[name];
    this.publish({ ...this.state, [name]: { status: 'loading', groupId: null, data: null, error: null } });
    try {
      this.assertCurrent(); const data = await read(); this.assertCurrent();
      if (generation !== this.reads[name]) return;
      this.publish({ ...this.state, [name]: { status: data.length ? 'ready' : 'empty', groupId: null, data, error: null } });
      this.assertCurrent();
    } catch (error) {
      if (!this.current()) { this.dispose(); throw this.changed(); }
      if (generation !== this.reads[name]) return;
      const failure = this.failure(error, false);
      this.publish({ ...this.state, [name]: { status: 'error', groupId: null, data: null, error: viewError(failure) } });
      throw failure;
    }
  }
  loadReports = () => this.load('reports', () => this.resources.listReports());
  loadNotices = () => this.load('notices', () => this.resources.listNotices());
  loadAppeals = () => this.load('appeals', () => this.resources.listAppeals());
  loadBlocks = () => this.load('blocks', () => this.resources.listBlocks());
  inspectIntent(key: string): CommunityIntentInspection | null {
    this.assertCurrent(); commandKey(key);
    return key === this.state.command.key ? this.resources.inspectIntent(key) : null;
  }
  private invalidate(kind: CommunitySafetyResult['kind']): void {
    const names: SafetyReadName[] = kind === 'report' ? ['reports'] : kind === 'appeal' ? ['appeals', 'notices'] :
      kind === 'block' || kind === 'unblock' ? ['blocks'] : [];
    if (!names.length) return;
    const state = { ...this.state };
    for (const name of names) { this.reads[name]++; state[name] = { status: 'stale', groupId: null, data: null, error: null }; }
    this.publish(state);
  }
  private available(retry: boolean): void {
    this.assertCurrent(); const intent = this.state.command.key ? this.resources.inspectIntent(this.state.command.key) : null;
    if (this.inFlight) throw new ApiError(409, 'community_intent_in_flight', 'Wait for the original safety command.', false, intent?.originalEffectUnknown ?? false);
    if (!retry && intent?.state === 'unknown') throw new ApiError(409, 'community_safety_reconcile_required', 'Retry the original safety command.', false, true);
  }
  private async command<T>(kind: CommunitySafetyResult['kind'], key: string, effect: () => Promise<T>, retry = false): Promise<T> {
    this.available(retry); commandKey(key);
    if (!retry && this.resources.inspectIntent(key))
      throw new ApiError(409, 'community_controller_intent_unavailable', 'Use explicit retry for this controller’s retained command.');
    this.inFlight = true;
    const pending: CommunitySafetyCommandState = { status: 'pending', kind, key, intent: retry ? this.inspectIntent(key) : null, error: null, result: null };
    try {
      this.publish({ ...this.state, command: pending }); this.assertCurrent();
      this.invalidate(kind); this.assertCurrent();
      const request = effect();
      if (this.current()) this.publish({ ...this.state, command: { ...pending, intent: this.inspectIntent(key) } });
      const value = await request; this.assertCurrent(true);
      this.invalidate(kind); this.assertCurrent(true);
      const result: CommunitySafetyResult = kind === 'reference' ? { kind, value: value as CommunitySafetyReference } :
        kind === 'report' || kind === 'appeal' ? { kind, value: value as CommunitySafetyCase } : { kind, value: value as CommunityBlock };
      this.publish({ ...this.state, command: { ...pending, status: 'confirmed', intent: this.inspectIntent(key), result } });
      this.assertCurrent(true); return value;
    } catch (error) {
      const failure = this.failure(error, true);
      if (!this.current()) { this.dispose(); throw this.changed(failure.originalEffectUnknown || failure.effectUnknown, failure.effectUnknown); }
      this.invalidate(kind); this.assertCurrent(failure.originalEffectUnknown);
      this.publish({ ...this.state, command: { ...pending, status: 'error', intent: this.inspectIntent(key), error: viewError(failure) } });
      throw failure;
    } finally { this.inFlight = false; }
  }
  createSafetyReference = (...args: Parameters<CommunityResources['createSafetyReference']>) =>
    this.command('reference', args[2], () => this.resources.createSafetyReference(...args));
  report = (...args: Parameters<CommunityResources['report']>) => this.command('report', args[1], () => this.resources.report(...args));
  appeal = (...args: Parameters<CommunityResources['appeal']>) => this.command('appeal', args[2], () => this.resources.appeal(...args));
  blockMember = (...args: Parameters<CommunityResources['blockMember']>) => this.command('block', args[2], () => this.resources.blockMember(...args));
  unblock = (...args: Parameters<CommunityResources['unblock']>) => this.command('unblock', args[2], () => this.resources.unblock(...args));
  retry(key: string): Promise<unknown> {
    this.available(true); const intent = this.inspectIntent(key), kind = this.state.command.kind;
    if (!intent || !kind) throw new ApiError(404, 'community_intent_not_found', 'No retained safety command exists in this controller.');
    return this.command(kind, key, () => this.resources.retry(key), true);
  }
}

type FriendData = { policy: CommunityPolicy; motions: readonly CommunityMotion[];
  reservations: readonly CommunityFriendReservation[]; invitation: CommunityFriendInvitation };
type FriendReadName = keyof FriendData;
type FriendCommandKind = 'motion' | 'ballot' | 'finalize' | 'issue' | 'revoke';
export type CommunityFriendInvitationResult = Readonly<
  { kind: 'motion' | 'ballot' | 'finalize'; value: CommunityMotion } |
  { kind: 'issue' | 'revoke'; value: CommunityInvitation }
>;
export type CommunityFriendInvitationCommandState = Readonly<{
  status: 'idle' | 'pending' | 'confirmed' | 'error'; kind: FriendCommandKind | null; key: string | null;
  intent: CommunityIntentInspection | null; error: CommunityViewError | null; result: CommunityFriendInvitationResult | null;
}>;
export type CommunityFriendInvitationSnapshot = Readonly<{ [K in FriendReadName]: CommunityReadState<FriendData[K]> }> &
  Readonly<{ disposed: boolean; groupId: string | null; invitationReservationId: string | null; command: CommunityFriendInvitationCommandState }>;
export interface CommunityFriendInvitationController {
  getSnapshot(): CommunityFriendInvitationSnapshot;
  subscribe(listener: () => void): { remove(): void };
  dispose(): void;
  loadPolicy(): Promise<void>;
  loadMotions(): Promise<void>;
  loadReservations(): Promise<void>;
  loadInvitation(reservationId: string): Promise<void>;
  createFriendMotion(expectedRevision: number, key: string): Promise<CommunityMotion>;
  setBallot(motionId: string, input: { choice: 'yes' | 'no' | 'abstain'; expectedRevision: number } | string, key: string): Promise<CommunityMotion>;
  finalizeMotion(motionId: string, key: string): Promise<CommunityMotion>;
  issueFriendInvitation(reservationId: string, key: string): Promise<CommunityIssuedInvitation>;
  revokeInvitation(invitationId: string, expectedRevision: number, key: string): Promise<CommunityInvitation>;
  inspectIntent(key: string): CommunityIntentInspection | null;
  retry(key: string): Promise<unknown>;
}
function friendSnapshot(groupId: string | null, disposed = false): CommunityFriendInvitationSnapshot {
  const idle = { status: 'idle' as const, groupId, data: null, error: null };
  return freeze<CommunityFriendInvitationSnapshot>({ disposed, groupId, invitationReservationId: null,
    policy: idle, motions: idle, reservations: idle, invitation: idle,
    command: { status: 'idle', kind: null, key: null, intent: null, error: null, result: null } });
}
const friendErrorCodes = new Set(['community_invalid_input', 'community_invalid_response', 'community_not_found',
  'community_adult_eligibility_unavailable', 'stale_revision', 'idempotency_conflict', 'community_motion_not_due',
  'community_motion_expired', 'community_motion_tenure_required', 'community_motion_quota', 'community_motion_cooldown',
  'community_electorate_unavailable', 'community_account_tenure_unavailable', 'community_limiter_unavailable',
  'community_friend_bridge_unavailable', 'community_invitation_unavailable', 'community_invitation_capacity',
  'community_invitation_used', 'community_invitation_replay_invalid', 'community_governed_action_required',
  'community_intent_capacity', 'community_receipt_capacity', 'community_unavailable', 'session_changed']);
class MountedCommunityFriendInvitationController implements CommunityFriendInvitationController {
  private state: CommunityFriendInvitationSnapshot;
  private inFlight = false;
  private readonly reads: Record<FriendReadName, number> = { policy: 0, motions: 0, reservations: 0, invitation: 0 };
  private readonly listeners = new Set<() => void>();
  constructor(private readonly resources: CommunityResources, private readonly groupId: string,
    private readonly sessionCurrent: () => boolean, private readonly release: () => void) { this.state = friendSnapshot(groupId); }
  private current(): boolean { return !this.state.disposed && this.sessionCurrent(); }
  private changed(originalEffectUnknown = false, effectUnknown = false): ApiError {
    return new ApiError(409, 'session_changed', 'This mounted Community session ended.', effectUnknown, originalEffectUnknown);
  }
  private assertCurrent(originalEffectUnknown = false): void {
    if (!this.current()) { this.dispose(); throw this.changed(originalEffectUnknown); }
  }
  private failure(error: unknown, mutation: boolean): ApiError {
    const fallback = mutation ? 'community_outcome_unknown' : 'community_read_unavailable';
    if (!(error instanceof ApiError)) return new ApiError(0, fallback, 'The friend invitation result could not be confirmed.', mutation, mutation);
    return new ApiError(error.status, friendErrorCodes.has(error.code) ? error.code : fallback,
      'The friend invitation result could not be confirmed.', error.effectUnknown, error.originalEffectUnknown);
  }
  private publish(state: CommunityFriendInvitationSnapshot): void {
    this.state = freeze(state);
    for (const listener of this.listeners) { if (this.state !== state) break; try { listener(); } catch {} }
  }
  getSnapshot(): CommunityFriendInvitationSnapshot {
    if (!this.current()) this.dispose(); return this.state;
  }
  subscribe(listener: () => void): { remove(): void } {
    this.assertCurrent(); this.listeners.add(listener); return { remove: () => { this.listeners.delete(listener); } };
  }
  dispose(): void {
    if (this.state.disposed) return;
    for (const name of Object.keys(this.reads) as FriendReadName[]) this.reads[name]++;
    this.publish(friendSnapshot(null, true)); this.listeners.clear(); this.release();
  }
  private async load<K extends FriendReadName>(name: K, read: () => Promise<FriendData[K]>, reservationId: string | null = null): Promise<void> {
    this.assertCurrent(); const generation = ++this.reads[name];
    this.publish({ ...this.state, ...(name === 'invitation' ? { invitationReservationId: reservationId } : {}),
      [name]: { status: 'loading', groupId: this.groupId, data: null, error: null } });
    try {
      this.assertCurrent(); if (reservationId !== null) identifier(reservationId);
      const data = await read(); this.assertCurrent();
      if (generation !== this.reads[name]) return;
      this.publish({ ...this.state, [name]: { status: Array.isArray(data) && !data.length ? 'empty' : 'ready', groupId: this.groupId, data, error: null } });
      this.assertCurrent();
    } catch (error) {
      if (!this.current()) { this.dispose(); throw this.changed(); }
      if (generation !== this.reads[name]) return;
      const failure = this.failure(error, false);
      this.publish({ ...this.state, [name]: { status: 'error', groupId: this.groupId, data: null, error: viewError(failure) } });
      throw failure;
    }
  }
  loadPolicy = () => this.load('policy', () => this.resources.readPolicy(this.groupId));
  loadMotions = () => this.load('motions', () => this.resources.listMotions(this.groupId));
  loadReservations = () => this.load('reservations', () => this.resources.listFriendReservations(this.groupId));
  loadInvitation = (reservationId: string) => this.load('invitation', () => this.resources.readFriendInvitation(this.groupId, reservationId), identifier(reservationId));
  inspectIntent(key: string): CommunityIntentInspection | null {
    this.assertCurrent(); commandKey(key); return key === this.state.command.key ? this.resources.inspectIntent(key) : null;
  }
  private invalidate(kind: FriendCommandKind, inaccessible = false): void {
    const names: FriendReadName[] = inaccessible ? ['policy', 'motions', 'reservations', 'invitation'] :
      kind === 'ballot' ? ['motions'] : kind === 'motion' ? ['policy', 'motions'] :
      kind === 'finalize' ? ['policy', 'motions', 'reservations'] : ['reservations', 'invitation'];
    const state = { ...this.state };
    for (const name of names) { this.reads[name]++; state[name] = { status: 'stale', groupId: this.groupId, data: null, error: null }; }
    this.publish(state);
  }
  private available(retry: boolean): void {
    this.assertCurrent(); const intent = this.state.command.key ? this.resources.inspectIntent(this.state.command.key) : null;
    if (this.inFlight) throw new ApiError(409, 'community_intent_in_flight', 'Wait for the original friend command.', false, intent?.originalEffectUnknown ?? false);
    if (!retry && intent?.state === 'unknown') throw new ApiError(409, 'community_friend_reconcile_required', 'Retry the original friend command.', false, true);
  }
  private async command<T>(kind: FriendCommandKind, key: string, effect: () => Promise<T>, retry = false): Promise<T> {
    this.available(retry); commandKey(key);
    if (!retry && this.resources.inspectIntent(key)) throw new ApiError(409, 'community_controller_intent_unavailable', 'Use explicit retry for this controller’s retained command.');
    this.inFlight = true;
    const pending: CommunityFriendInvitationCommandState = { status: 'pending', kind, key, intent: retry ? this.inspectIntent(key) : null, error: null, result: null };
    try {
      this.publish({ ...this.state, command: pending }); this.assertCurrent(); this.invalidate(kind); this.assertCurrent();
      const request = effect();
      if (this.current()) this.publish({ ...this.state, command: { ...pending, intent: this.inspectIntent(key) } });
      const value = await request; this.assertCurrent(true); this.invalidate(kind); this.assertCurrent(true);
      let result: CommunityFriendInvitationResult;
      if (kind === 'issue' || kind === 'revoke') {
        const issued = value as CommunityIssuedInvitation;
        result = { kind, value: { id: issued.id, groupId: issued.groupId, revision: issued.revision,
          state: issued.state, createdAt: issued.createdAt, expiresAt: issued.expiresAt, tokenAvailable: false } };
      } else result = { kind, value: value as CommunityMotion };
      this.publish({ ...this.state, command: { ...pending, status: 'confirmed', intent: this.inspectIntent(key), result } });
      this.assertCurrent(true); return value;
    } catch (error) {
      const failure = this.failure(error, true);
      if (!this.current()) { this.dispose(); throw this.changed(failure.originalEffectUnknown || failure.effectUnknown, failure.effectUnknown); }
      this.invalidate(kind, failure.status === 403 || failure.status === 404); this.assertCurrent(failure.originalEffectUnknown);
      this.publish({ ...this.state, command: { ...pending, status: 'error', intent: this.inspectIntent(key), error: viewError(failure) } });
      throw failure;
    } finally { this.inFlight = false; }
  }
  createFriendMotion = (expectedRevision: number, key: string) =>
    this.command('motion', key, () => this.resources.createMotion(this.groupId, { kind: 'friend', expectedRevision }, key));
  setBallot = (motionId: string, input: { choice: 'yes' | 'no' | 'abstain'; expectedRevision: number } | string, key: string) =>
    this.command('ballot', key, () => this.resources.setBallot(this.groupId, motionId, input, key));
  finalizeMotion = (motionId: string, key: string) => this.command('finalize', key, () => this.resources.finalizeMotion(this.groupId, motionId, key));
  issueFriendInvitation = (reservationId: string, key: string) => this.command('issue', key, () => this.resources.issueFriendInvitation(this.groupId, reservationId, key));
  revokeInvitation = (invitationId: string, expectedRevision: number, key: string) =>
    this.command('revoke', key, () => this.resources.revokeInvitation(this.groupId, invitationId, expectedRevision, key));
  retry(key: string): Promise<unknown> {
    this.available(true); const intent = this.inspectIntent(key), kind = this.state.command.kind;
    if (!intent || !kind) throw new ApiError(404, 'community_intent_not_found', 'No retained friend command exists in this controller.');
    return this.command(kind, key, () => this.resources.retry(key), true);
  }
}

export const COMMUNITY_POST_TEXT_REJECTED_MESSAGE = "This can't be posted in Form groups. Rephrase it and try again.";
export type CommunityPostsResult = Readonly<{ kind: 'create'; value: CommunityPost } | { kind: 'hide'; value: CommunityHiddenPost }>;
export type CommunityPostsCommandState = Readonly<{
  status: 'idle' | 'pending' | 'confirmed' | 'error'; kind: CommunityPostsResult['kind'] | null; key: string | null;
  intent: CommunityIntentInspection | null; error: CommunityViewError | null; result: CommunityPostsResult | null;
}>;
export type CommunityPostsSnapshot = Readonly<{
  disposed: boolean; groupId: string | null; page: CommunityReadState<CommunityPostsPage>; command: CommunityPostsCommandState;
}>;
export interface CommunityPostsController {
  getSnapshot(): CommunityPostsSnapshot;
  subscribe(listener: () => void): { remove(): void };
  dispose(): void;
  loadPage(input?: { cursor?: string; limit?: number }): Promise<void>;
  createPost(input: CommunityPostInput | string, key: string): Promise<CommunityPost>;
  hidePost(postId: string, expectedRevision: number, key: string): Promise<CommunityHiddenPost>;
  inspectIntent(key: string): CommunityIntentInspection | null;
  retry(key: string): Promise<unknown>;
}
function postsSnapshot(groupId: string | null, disposed = false): CommunityPostsSnapshot {
  return freeze<CommunityPostsSnapshot>({ disposed, groupId, page: { status: 'idle', groupId, data: null, error: null },
    command: { status: 'idle', kind: null, key: null, intent: null, error: null, result: null } });
}
const postsErrorCodes = new Set(['community_invalid_input', 'community_invalid_response', 'community_not_found',
  'community_adult_eligibility_unavailable', 'stale_revision', 'idempotency_conflict', 'community_posting_unavailable',
  'community_text_rejected', 'community_text_moderation_unavailable', 'community_post_quota', 'community_cursor_capacity',
  'community_limiter_unavailable', 'community_intent_capacity', 'community_receipt_capacity', 'community_unavailable', 'session_changed']);
class MountedCommunityPostsController implements CommunityPostsController {
  private state: CommunityPostsSnapshot;
  private inFlight = false;
  private readGeneration = 0;
  private readonly listeners = new Set<() => void>();
  constructor(private readonly resources: CommunityResources, private readonly groupId: string,
    private readonly sessionCurrent: () => boolean, private readonly release: () => void) { this.state = postsSnapshot(groupId); }
  private current(): boolean { return !this.state.disposed && this.sessionCurrent(); }
  private changed(originalEffectUnknown = false, effectUnknown = false): ApiError {
    return new ApiError(409, 'session_changed', 'This mounted Community session ended.', effectUnknown, originalEffectUnknown);
  }
  private assertCurrent(originalEffectUnknown = false): void {
    if (!this.current()) { this.dispose(); throw this.changed(originalEffectUnknown); }
  }
  private failure(error: unknown, mutation: boolean): ApiError {
    const fallback = mutation ? 'community_outcome_unknown' : 'community_read_unavailable';
    if (!(error instanceof ApiError)) return new ApiError(0, fallback, 'The group post result could not be confirmed.', mutation, mutation);
    const code = postsErrorCodes.has(error.code) ? error.code : fallback;
    return new ApiError(error.status, code, code === 'community_text_rejected' ? COMMUNITY_POST_TEXT_REJECTED_MESSAGE :
      'The group post result could not be confirmed.', error.effectUnknown, error.originalEffectUnknown);
  }
  private publish(state: CommunityPostsSnapshot): void {
    this.state = freeze(state);
    for (const listener of this.listeners) { if (this.state !== state) break; try { listener(); } catch {} }
  }
  getSnapshot(): CommunityPostsSnapshot {
    if (!this.current()) this.dispose(); return this.state;
  }
  subscribe(listener: () => void): { remove(): void } {
    this.assertCurrent(); this.listeners.add(listener); return { remove: () => { this.listeners.delete(listener); } };
  }
  dispose(): void {
    if (this.state.disposed) return;
    this.readGeneration++; this.publish(postsSnapshot(null, true)); this.listeners.clear(); this.release();
  }
  async loadPage(input: { cursor?: string; limit?: number } = {}): Promise<void> {
    this.assertCurrent(); const generation = ++this.readGeneration;
    this.publish({ ...this.state, page: { status: 'loading', groupId: this.groupId, data: null, error: null } });
    try {
      this.assertCurrent(); const data = await this.resources.readPosts(this.groupId, input); this.assertCurrent();
      if (generation !== this.readGeneration) return;
      this.publish({ ...this.state, page: { status: data.posts.length ? 'ready' : 'empty', groupId: this.groupId, data, error: null } });
      this.assertCurrent();
    } catch (error) {
      if (!this.current()) { this.dispose(); throw this.changed(); }
      if (generation !== this.readGeneration) return;
      const failure = this.failure(error, false);
      this.publish({ ...this.state, page: { status: 'error', groupId: this.groupId, data: null, error: viewError(failure) } });
      throw failure;
    }
  }
  inspectIntent(key: string): CommunityIntentInspection | null {
    this.assertCurrent(); commandKey(key); return key === this.state.command.key ? this.resources.inspectIntent(key) : null;
  }
  private invalidate(): void {
    this.readGeneration++;
    this.publish({ ...this.state, page: { status: 'stale', groupId: this.groupId, data: null, error: null } });
  }
  private available(retry: boolean): void {
    this.assertCurrent(); const intent = this.state.command.key ? this.resources.inspectIntent(this.state.command.key) : null;
    if (this.inFlight) throw new ApiError(409, 'community_intent_in_flight', 'Wait for the original post command.', false, intent?.originalEffectUnknown ?? false);
    if (!retry && intent?.state === 'unknown') throw new ApiError(409, 'community_posts_reconcile_required', 'Retry the original post command.', false, true);
  }
  private async command<T>(kind: CommunityPostsResult['kind'], key: string, effect: () => Promise<T>, retry = false): Promise<T> {
    this.available(retry); commandKey(key);
    if (!retry && this.resources.inspectIntent(key)) throw new ApiError(409, 'community_controller_intent_unavailable', 'Use explicit retry for this controller’s retained command.');
    this.inFlight = true;
    const pending: CommunityPostsCommandState = { status: 'pending', kind, key, intent: retry ? this.inspectIntent(key) : null, error: null, result: null };
    try {
      this.publish({ ...this.state, command: pending }); this.assertCurrent(); this.invalidate(); this.assertCurrent();
      const request = effect();
      if (this.current()) this.publish({ ...this.state, command: { ...pending, intent: this.inspectIntent(key) } });
      const value = await request; this.assertCurrent(true); this.invalidate(); this.assertCurrent(true);
      const result: CommunityPostsResult = kind === 'create' ? { kind, value: value as CommunityPost } : { kind, value: value as CommunityHiddenPost };
      this.publish({ ...this.state, command: { ...pending, status: 'confirmed', intent: this.inspectIntent(key), result } });
      this.assertCurrent(true); return value;
    } catch (error) {
      const failure = this.failure(error, true);
      if (!this.current()) { this.dispose(); throw this.changed(failure.originalEffectUnknown || failure.effectUnknown, failure.effectUnknown); }
      this.invalidate(); this.assertCurrent(failure.originalEffectUnknown);
      this.publish({ ...this.state, command: { ...pending, status: 'error', intent: this.inspectIntent(key), error: viewError(failure) } });
      throw failure;
    } finally { this.inFlight = false; }
  }
  createPost = (input: CommunityPostInput | string, key: string) => this.command('create', key, () => this.resources.createPost(this.groupId, input, key));
  hidePost = (postId: string, expectedRevision: number, key: string) => this.command('hide', key, () => this.resources.hidePost(this.groupId, postId, expectedRevision, key));
  retry(key: string): Promise<unknown> {
    this.available(true); const intent = this.inspectIntent(key), kind = this.state.command.kind;
    if (!intent || !kind) throw new ApiError(404, 'community_intent_not_found', 'No retained post command exists in this controller.');
    return this.command(kind, key, () => this.resources.retry(key), true);
  }
}
