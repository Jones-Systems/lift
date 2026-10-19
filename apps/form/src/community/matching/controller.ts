import { ApiError } from '../../api/transport';
import type {
  CommunityResources, CommunityMatching, CommunityPreferences, CommunityIntentInspection, CommunityViewError,
} from '../../api/community';

export type MatchingResources = Pick<CommunityResources,
  'readMatching' | 'enroll' | 'updateMatching' | 'cancelEnrollment' | 'retry' | 'inspectIntent'>;
export type MatchingSession = {
  isCurrent(): boolean;
  subscribe(listener: () => void): { remove(): void };
};
export type MatchingSnapshot = Readonly<{
  disposed: boolean;
  read: Readonly<{ status: 'idle' | 'loading' | 'ready' | 'stale' | 'error';
    data: CommunityMatching | null; error: CommunityViewError | null }>;
  command: Readonly<{ status: 'idle' | 'pending' | 'confirmed' | 'error';
    kind: 'enroll' | 'update' | 'cancel' | null; key: string | null;
    intent: CommunityIntentInspection | null; error: CommunityViewError | null }>;
}>;

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function empty(disposed = false): MatchingSnapshot {
  return freeze({ disposed, read: { status: 'idle', data: null, error: null },
    command: { status: 'idle', kind: null, key: null, intent: null, error: null } });
}
function viewError(error: ApiError): CommunityViewError {
  return { status: error.status, code: error.code, effectUnknown: error.effectUnknown,
    originalEffectUnknown: error.originalEffectUnknown };
}

/** One mounted account generation; the integration owner supplies its invalidation subscription. */
export class MatchingController {
  private state = empty();
  private readGeneration = 0;
  private readonly listeners = new Set<() => void>();
  private subscription: { remove(): void } | null = null;

  constructor(private readonly resources: MatchingResources, private readonly session: MatchingSession) {
    const subscription = session.subscribe(() => this.dispose());
    this.subscription = subscription;
    if (this.state.disposed || !session.isCurrent()) { subscription.remove(); this.dispose(); }
  }

  private current(): boolean { return !this.state.disposed && this.session.isCurrent(); }
  private changed(originalEffectUnknown = false, effectUnknown = false): ApiError {
    return new ApiError(409, 'session_changed', 'This mounted account session ended. Reconcile changes in the original account.',
      effectUnknown, originalEffectUnknown);
  }
  private assertCurrent(originalEffectUnknown = false): void {
    if (!this.current()) { this.dispose(); throw this.changed(originalEffectUnknown); }
  }
  getSnapshot(): MatchingSnapshot {
    if (!this.current()) this.dispose();
    return this.state;
  }
  subscribe(listener: () => void): { remove(): void } {
    this.assertCurrent(); this.listeners.add(listener);
    return { remove: () => { this.listeners.delete(listener); } };
  }
  private publish(state: MatchingSnapshot): void {
    this.state = freeze(state);
    // Observer exceptions must not turn a confirmed server outcome into an unknown write.
    for (const listener of this.listeners) { try { listener(); } catch {} }
  }
  dispose(): void {
    if (this.state.disposed) return;
    this.readGeneration++;
    this.subscription?.remove(); this.subscription = null;
    this.publish(empty(true)); this.listeners.clear();
  }
  private invalidate(): void {
    this.readGeneration++;
    this.state = freeze({ ...this.state, read: { status: 'stale', data: null, error: null } });
  }
  async load(): Promise<void> {
    this.assertCurrent();
    if (this.state.command.status === 'pending') throw new ApiError(409, 'matching_command_pending', 'Wait for the current change.');
    const generation = ++this.readGeneration;
    this.publish({ ...this.state, read: { status: 'loading', data: null, error: null } });
    try {
      this.assertCurrent();
      const data = await this.resources.readMatching(); this.assertCurrent();
      if (generation !== this.readGeneration) return;
      this.publish({ ...this.state, read: { status: 'ready', data: JSON.parse(JSON.stringify(data)) as CommunityMatching, error: null } });
    } catch (error) {
      if (error instanceof ApiError && (error.status === 401 || error.code === 'session_changed')) this.dispose();
      if (!this.current()) { this.dispose(); throw this.changed(); }
      if (generation !== this.readGeneration) return;
      const failure = error instanceof ApiError ? error : new ApiError(0, 'community_read_unavailable', 'Matching could not be read.');
      this.publish({ ...this.state, read: { status: 'error', data: null, error: viewError(failure) } });
      throw failure;
    }
  }
  private uncertain(): boolean {
    const command = this.state.command;
    return command.status === 'error' && Boolean(command.error?.effectUnknown || command.error?.originalEffectUnknown
      || command.intent?.originalEffectUnknown);
  }
  private revision(): number {
    this.assertCurrent();
    if (this.state.command.status === 'pending') throw new ApiError(409, 'matching_command_pending', 'Wait for the current change.');
    if (this.uncertain()) throw new ApiError(409, 'matching_reconciliation_required', 'Retry the retained change before starting another.', false, true);
    if (this.state.read.status !== 'ready' || !this.state.read.data)
      throw new ApiError(409, 'matching_read_required', 'Read current matching before starting a change.');
    return this.state.read.data.revision;
  }
  enroll(preferences: CommunityPreferences, key: string): Promise<void> {
    const expectedRevision = this.revision();
    this.newKey(key);
    const input = JSON.stringify({ expectedRevision, preferences });
    return this.command('enroll', key, () => this.resources.enroll(input, key));
  }
  update(preferences: CommunityPreferences, key: string): Promise<void> {
    const expectedRevision = this.revision();
    this.newKey(key);
    const input = JSON.stringify({ expectedRevision, preferences });
    return this.command('update', key, () => this.resources.updateMatching(input, key));
  }
  cancel(key: string): Promise<void> {
    const expectedRevision = this.revision();
    this.newKey(key);
    return this.command('cancel', key, () => this.resources.cancelEnrollment(expectedRevision, key));
  }
  private newKey(key: string): void {
    if (this.resources.inspectIntent(key))
      throw new ApiError(409, 'matching_key_used', 'Use a new key for a new change; uncertain changes use explicit retry.');
  }
  retry(): Promise<void> {
    this.assertCurrent();
    const { key, kind } = this.state.command;
    if (!this.uncertain() || !key || !kind)
      throw new ApiError(409, 'matching_retry_unavailable', 'No uncertain matching change is available to retry.');
    return this.command(kind, key, () => this.resources.retry(key));
  }
  private async command(kind: NonNullable<MatchingSnapshot['command']['kind']>, key: string,
    effect: () => Promise<unknown>): Promise<void> {
    const originalUnknown = this.uncertain();
    this.invalidate();
    this.publish({ ...this.state, command: { status: 'pending', kind, key, intent: null, error: null } });
    let dispatched = false;
    try {
      this.assertCurrent(originalUnknown);
      const request = effect(); dispatched = true;
      await request; this.assertCurrent(true);
      const intent = this.resources.inspectIntent(key);
      this.assertCurrent(true);
      // A replay receipt can predate assignment or cancellation. Only an explicit fresh read replaces the view.
      this.invalidate();
      this.publish({ ...this.state, command: { status: 'confirmed', kind, key, intent, error: null } });
    } catch (error) {
      const failure = error instanceof ApiError ? error : new ApiError(0, 'community_outcome_unknown', 'The change could not be confirmed.', true, true);
      const unknown = originalUnknown || failure.effectUnknown || failure.originalEffectUnknown;
      if (failure.status === 401 || failure.code === 'session_changed') this.dispose();
      if (!this.current()) { this.dispose(); throw this.changed(unknown || dispatched, failure.effectUnknown); }
      const intent = this.resources.inspectIntent(key);
      this.assertCurrent(unknown);
      const outcome = new ApiError(failure.status, failure.code, failure.message, failure.effectUnknown,
        unknown || Boolean(intent?.originalEffectUnknown));
      this.invalidate();
      this.publish({ ...this.state, command: { status: 'error', kind, key, intent, error: viewError(outcome) } });
      throw outcome;
    }
  }
}
