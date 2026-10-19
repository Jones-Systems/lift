import type { ActivityCalendar, ActivityCatalog, ActivityEntry, ActivityPage, Adherence, ExerciseRef, ExerciseSnapshot, PersonalExercise, PersonalExerciseFields, ScheduleRevision, ScheduleWrite } from './contracts';
import type { ActivityEntryQuery, ActivityListQuery, ActivityResources } from './resources';
import type { DraftController, DraftState } from './drafts/controller';
import { initialDraftState } from './drafts/controller';
import { chooseExercise, confirmStructuredReview, freezeCaptureContext, replaceDraftExercise, resolveDraftIssue } from './drafts/model';
import type { DraftResult } from './drafts/model';
import { commandId, resourceId, sanitizePersonalExercise, sanitizeSchedule } from './drafts/validation';
import { localDateAt, validTimeZone } from './drafts/dates';
import type { ResourceState } from './screens/model';

export type ActivityRead<T> = { status: 'idle' } | ResourceState<T>;
export type ActivityEntryBinding = {
  isCurrentSession(): boolean;
  activity: {
    sessionGeneration: string;
    newSecureKey(): string;
    resources: Pick<ActivityResources, 'entries' | 'entry' | 'catalog' | 'calendar' | 'createCalendar' | 'adherence' | 'voidEntry' | 'schedule' | 'saveSchedule' | 'createPersonalExercise' | 'personalExercises' | 'personalExercise' | 'editPersonalExercise' | 'retirePersonalExercise'>;
    controller: DraftController;
  };
};
export type ActivityCaptureInput = { capturedAt: string; timeZone: string; selectedDate: string | null };
type VoidTarget = Readonly<{ id: string; expectedRevision: number }>;
export type ActivityVoidIntent =
  | { phase: 'idle' | 'loading' }
  | { phase: 'review' | 'voided'; entry: ActivityEntry }
  | { phase: 'saving'; target: VoidTarget }
  | { phase: 'unknown' | 'stale' | 'rejected'; target: VoidTarget | null; error: NonNullable<DraftState['error']> };
export type ActivityScheduleInput = Omit<ScheduleWrite, 'expectedRevision'>;
export type ActivityScheduleIntent =
  | { phase: 'idle' | 'loading' | 'editing' }
  | { phase: 'review'; write: ScheduleWrite }
  | { phase: 'saving' }
  | { phase: 'saved'; schedule: ScheduleRevision }
  | { phase: 'unknown' | 'stale' | 'rejected'; error: NonNullable<DraftState['error']> };
type ScheduleCommand = Readonly<{ write: ScheduleWrite; key: string; timeZone: string; id: string | null }>;
export type ActivityPersonalCreateIntent =
  | { phase: 'idle' | 'saving' }
  | { phase: 'review'; fields: PersonalExerciseFields }
  | { phase: 'created'; exercise: PersonalExercise }
  | { phase: 'unknown' | 'rejected'; error: NonNullable<DraftState['error']> };
type PersonalCreateCommand = Readonly<{ fields: PersonalExerciseFields; key: string }>;
export type ActivityPersonalChangeIntent =
  | { phase: 'idle' | 'loading' | 'saving' }
  | { phase: 'editing'; exercise: PersonalExercise }
  | { phase: 'review'; operation: 'edit' | 'retire'; exercise: PersonalExercise; fields: PersonalExerciseFields }
  | { phase: 'saved'; operation: 'edit' | 'retire'; exercise: PersonalExercise }
  | { phase: 'unknown' | 'stale' | 'rejected'; error: NonNullable<DraftState['error']> };
type PersonalChangeCommand = Readonly<{ operation: 'edit' | 'retire'; id: string; expectedRevision: number; fields: PersonalExerciseFields; key: string }>;
export type ActivityCalendarIntent =
  | { phase: 'idle' | 'saving' }
  | { phase: 'review'; timeZone: string }
  | { phase: 'configured'; calendar: ActivityCalendar }
  | { phase: 'unknown' | 'rejected'; error: NonNullable<DraftState['error']> };
type CalendarCommand = Readonly<{ timeZone: string; key: string }>;
export type ActivityEntryState = {
  available: boolean;
  invalidation: DraftState['error'];
  entries: ActivityRead<ActivityPage<ActivityEntry>>;
  entry: ActivityRead<ActivityEntry>;
  catalog: ActivityRead<ActivityCatalog>;
  calendar: ActivityRead<ActivityCalendar | null>;
  adherence: ActivityRead<Adherence>;
  schedule: ActivityRead<ScheduleRevision | null>;
  draft: DraftState;
  voidIntent: ActivityVoidIntent;
  scheduleIntent: ActivityScheduleIntent;
  personalCreateIntent: ActivityPersonalCreateIntent;
  personalExercises: ActivityRead<ActivityPage<PersonalExercise>>;
  personalExercise: ActivityRead<PersonalExercise>;
  personalChangeIntent: ActivityPersonalChangeIntent;
  calendarIntent: ActivityCalendarIntent;
};
type ReadKey = 'entries' | 'entry' | 'catalog' | 'calendar' | 'adherence' | 'schedule' | 'personalExercises' | 'personalExercise';
type ReadValue<K extends ReadKey> = Extract<ActivityEntryState[K], { status: 'ready' }>['value'];
const copy = <T>(value: T): T => {
  if (Array.isArray(value)) return value.map(copy) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, copy(item)])) as T;
  return value;
};

/** One view of the root-owned Activity session. Disposal cancels its draft, not the root session. */
export class ActivityEntryConsumer {
  private state: ActivityEntryState;
  private reads: Record<ReadKey, number> = { entries: 0, entry: 0, catalog: 0, calendar: 0, adherence: 0, schedule: 0, personalExercises: 0, personalExercise: 0 };
  private epoch = 0;
  private observers = new Set<(state: ActivityEntryState) => void>();
  private subscription: { remove(): void } | null = null;
  private pendingVoid: Readonly<VoidTarget & { key: string }> | null = null;
  private pendingSchedule: ScheduleCommand | null = null;
  private pendingPersonalCreate: PersonalCreateCommand | null = null;
  private pendingPersonalChange: PersonalChangeCommand | null = null;
  private pendingCalendar: CalendarCommand | null = null;
  constructor(private readonly binding: ActivityEntryBinding) {
    this.state = this.empty(true, binding.activity.controller.getState());
    this.subscription = binding.activity.controller.subscribe(draft => {
      if (!this.state.available) return;
      if (!this.current() || draft.error?.status === 401 || draft.error?.code === 'session_changed') {
        this.invalidate(draft.error); return;
      }
      const previous = this.state.draft;
      this.state.draft = draft;
      if (draft.phase === 'cancelled' && draft.epoch !== previous.epoch) {
        this.epoch += 1; this.state = this.empty(true, draft);
        if (this.pendingVoid) this.state.voidIntent = { phase: 'unknown', target: this.voidTarget(this.pendingVoid),
          error: { status: 0, code: 'request_unconfirmed', originalEffectUnknown: true } };
        if (this.pendingSchedule) this.state.scheduleIntent = { phase: 'unknown',
          error: { status: 0, code: 'request_unconfirmed', originalEffectUnknown: true } };
        if (this.pendingPersonalCreate) this.state.personalCreateIntent = { phase: 'unknown',
          error: { status: 0, code: 'request_unconfirmed', originalEffectUnknown: true } };
        if (this.pendingPersonalChange) this.state.personalChangeIntent = { phase: 'unknown',
          error: { status: 0, code: 'request_unconfirmed', originalEffectUnknown: true } };
        if (this.pendingCalendar) this.state.calendarIntent = { phase: 'unknown',
          error: { status: 0, code: 'request_unconfirmed', originalEffectUnknown: true } };
      } else if (draft.phase === 'saved' && draft.saved && previous.phase !== 'saved') {
        this.reads.entries += 1; this.reads.adherence += 1; this.reads.entry += 1;
        this.state.entries = { status: 'idle' }; this.state.adherence = { status: 'idle' };
        this.state.entry = { status: 'ready', value: draft.saved };
      }
      this.emit();
    });
    if (!this.state.available) this.subscription.remove();
    if (!this.current()) this.invalidate();
  }
  getState(): ActivityEntryState {
    if (this.state.available && !this.current()) this.invalidate();
    return copy(this.state);
  }
  subscribe(observer: (state: ActivityEntryState) => void): { remove(): void } {
    this.observers.add(observer); observer(this.getState());
    return { remove: () => this.observers.delete(observer) };
  }
  loadEntries(query: ActivityEntryQuery): Promise<void> {
    return this.read('entries', () => this.binding.activity.resources.entries({ ...query }));
  }
  loadCatalog(): Promise<void> { return this.read('catalog', () => this.binding.activity.resources.catalog()); }
  loadPersonalExercises(query?: ActivityListQuery): Promise<void> {
    return this.read('personalExercises', () => this.binding.activity.resources.personalExercises(query ? { ...query } : undefined));
  }
  loadPersonalExercise(id: string): Promise<void> {
    return this.read('personalExercise', () => this.binding.activity.resources.personalExercise(id));
  }
  loadCalendar(): Promise<void> { return this.read('calendar', () => this.binding.activity.resources.calendar()); }
  reviewCalendar(timeZone: string): void {
    this.requireCurrent(); this.requireNoVoid(); this.requireNoSchedule(); this.requireNoPersonalCreate(); this.requireNoPersonalChange();
    if (['saving', 'unknown'].includes(this.state.calendarIntent.phase)) throw new Error('calendar_intent_in_progress');
    if (['saving', 'unknown', 'capture', 'transcriptReview'].includes(this.state.draft.phase)) throw new Error('capture_unavailable');
    if (this.state.calendar.status !== 'ready') throw new Error('activity_calendar_unavailable');
    if (this.state.calendar.value !== null) throw new Error('activity_calendar_fixed');
    if (!validTimeZone(timeZone)) throw new Error('invalid_calendar_zone');
    this.state.calendarIntent = { phase: 'review', timeZone }; this.emit();
  }
  async confirmCalendar(): Promise<void> {
    this.requireCurrent();
    if (this.state.calendarIntent.phase !== 'review' || this.state.calendar.status !== 'ready' || this.state.calendar.value !== null)
      throw new Error('explicit_calendar_confirmation_required');
    this.pendingCalendar = { timeZone: this.state.calendarIntent.timeZone, key: commandId(this.binding.activity.newSecureKey()) };
    await this.executeCalendar(this.pendingCalendar);
  }
  async retryCalendar(): Promise<void> {
    this.requireCurrent();
    if (this.state.calendarIntent.phase !== 'unknown' || !this.pendingCalendar) throw new Error('calendar_retry_unavailable');
    await this.executeCalendar(this.pendingCalendar);
  }
  loadAdherence(from: string, to: string): Promise<void> {
    return this.read('adherence', () => this.binding.activity.resources.adherence(from, to));
  }
  async beginEntryEdit(id: string): Promise<void> {
    this.requireBegin();
    const draftEpoch = this.state.draft.epoch;
    await this.read('entry', () => this.binding.activity.resources.entry(id), entry => {
      if (this.binding.activity.controller.getState().epoch !== draftEpoch) return;
      this.requireBegin();
      this.binding.activity.controller.beginEntryEdit(entry);
    });
  }
  beginManual(input: ActivityCaptureInput, exercise?: ExerciseSnapshot): void {
    this.requireBegin(); this.reads.entry += 1; this.state.entry = { status: 'idle' };
    this.binding.activity.controller.beginManual(this.capture(input), exercise);
  }
  async beginSpeech(input: ActivityCaptureInput, locale: string): Promise<void> {
    this.requireBegin(); this.reads.entry += 1; this.state.entry = { status: 'idle' };
    await this.binding.activity.controller.beginSpeech(this.capture(input), locale);
  }
  stopSpeech(): Promise<void> { this.requireCurrent(); return this.binding.activity.controller.stopSpeech(); }
  acceptTranscript(text: string): void {
    this.requireCurrent();
    this.requireNoSchedule();
    this.requireNoPersonalCreate(); this.requireNoPersonalChange(); this.requireNoCalendar();
    if (this.state.catalog.status !== 'ready') throw new Error('activity_catalog_unavailable');
    this.binding.activity.controller.acceptTranscript(text, this.state.catalog.value.items);
  }
  edit(result: DraftResult): void { this.requireCurrent(); this.requireNoVoid(); this.requireNoSchedule(); this.requireNoPersonalCreate(); this.requireNoPersonalChange(); this.requireNoCalendar(); this.binding.activity.controller.edit(result); }
  confirmReview(): void {
    this.requireCurrent();
    this.requireNoVoid();
    this.requireNoSchedule();
    this.requireNoPersonalCreate(); this.requireNoPersonalChange(); this.requireNoCalendar();
    if (!this.state.draft.result) throw new Error('structured_review_unavailable');
    this.binding.activity.controller.edit(confirmStructuredReview(this.state.draft.result));
  }
  async save(): Promise<void> { this.requireCurrent(); this.requireNoVoid(); this.requireNoSchedule(); this.requireNoPersonalCreate(); this.requireNoPersonalChange(); this.requireNoCalendar(); await this.binding.activity.controller.save(); }
  async retryUnknown(): Promise<void> { this.requireCurrent(); this.requireNoVoid(); this.requireNoSchedule(); this.requireNoPersonalCreate(); this.requireNoPersonalChange(); this.requireNoCalendar(); await this.binding.activity.controller.retryUnknown(); }
  reviewPersonalExercise(fields: PersonalExerciseFields): void {
    this.requireCurrent(); this.requireNoVoid(); this.requireNoSchedule();
    this.requireNoPersonalChange(); this.requireNoCalendar();
    if (['saving', 'unknown'].includes(this.state.personalCreateIntent.phase)) throw new Error('personal_create_in_progress');
    if (['saving', 'unknown', 'capture', 'transcriptReview'].includes(this.state.draft.phase)) throw new Error('capture_unavailable');
    this.state.personalCreateIntent = { phase: 'review', fields: sanitizePersonalExercise(fields) }; this.emit();
  }
  async confirmPersonalExercise(): Promise<void> {
    this.requireCurrent();
    this.requireNoPersonalChange(); this.requireNoCalendar();
    if (this.state.personalCreateIntent.phase !== 'review') throw new Error('explicit_personal_create_confirmation_required');
    this.pendingPersonalCreate = { fields: copy(this.state.personalCreateIntent.fields), key: commandId(this.binding.activity.newSecureKey()) };
    await this.executePersonalCreate(this.pendingPersonalCreate);
  }
  async retryPersonalExercise(): Promise<void> {
    this.requireCurrent();
    this.requireNoPersonalChange(); this.requireNoCalendar();
    if (this.state.personalCreateIntent.phase !== 'unknown' || !this.pendingPersonalCreate) throw new Error('personal_create_retry_unavailable');
    await this.executePersonalCreate(this.pendingPersonalCreate);
  }
  beginPersonalExerciseEdit(id: string): Promise<void> { return this.beginPersonalChange(id, 'edit'); }
  beginPersonalExerciseRetirement(id: string): Promise<void> { return this.beginPersonalChange(id, 'retire'); }
  reviewPersonalExerciseEdit(fields: PersonalExerciseFields): void {
    this.requireCurrent();
    const intent = this.state.personalChangeIntent;
    if (intent.phase !== 'editing' && !(intent.phase === 'review' && intent.operation === 'edit')) throw new Error('personal_edit_review_unavailable');
    this.state.personalChangeIntent = { phase: 'review', operation: 'edit', exercise: intent.exercise, fields: sanitizePersonalExercise(fields) }; this.emit();
  }
  async confirmPersonalExerciseChange(): Promise<void> {
    this.requireCurrent();
    const intent = this.state.personalChangeIntent;
    if (intent.phase !== 'review') throw new Error('explicit_personal_change_confirmation_required');
    this.pendingPersonalChange = { operation: intent.operation, id: intent.exercise.id, expectedRevision: intent.exercise.revision,
      fields: copy(intent.fields), key: commandId(this.binding.activity.newSecureKey()) };
    await this.executePersonalChange(this.pendingPersonalChange);
  }
  async retryPersonalExerciseChange(): Promise<void> {
    this.requireCurrent();
    if (this.state.personalChangeIntent.phase !== 'unknown' || !this.pendingPersonalChange) throw new Error('personal_change_retry_unavailable');
    await this.executePersonalChange(this.pendingPersonalChange);
  }
  selectCatalogExercise(itemId: string, ref: ExerciseRef): void {
    this.requireCurrent(); this.requireNoVoid(); this.requireNoSchedule(); this.requireNoPersonalCreate(); this.requireNoPersonalChange(); this.requireNoCalendar();
    if (this.state.catalog.status !== 'ready') throw new Error('activity_catalog_unavailable');
    const sameRef = (left: ExerciseRef, right: ExerciseRef) => left.source === right.source && left.id === right.id
      && (left.source !== 'personal' || (right.source === 'personal' && left.revision === right.revision));
    const snapshot = this.state.catalog.value.items.find(item => sameRef(item.ref, ref));
    if (!snapshot) throw new Error('catalog_exercise_unavailable');
    let result = this.state.draft.result;
    if (!result || !['structuredReview', 'rejected', 'stale'].includes(this.state.draft.phase)) throw new Error('structured_review_unavailable');
    if (!this.state.catalog.value.selectionUses.includes(result.candidate.source)) throw new Error('catalog_selection_unavailable');
    const index = result.candidate.items.findIndex(item => item.id === itemId);
    if (index < 0) throw new Error('draft_item_unavailable');
    const item = result.candidate.items[index];
    const unchanged = item.exercise.state === 'selected' && sameRef(item.exercise.ref, snapshot.ref);
    if (!unchanged) result = this.state.draft.editTarget
      ? replaceDraftExercise(result, itemId, resourceId(this.binding.activity.newSecureKey()), snapshot)
      : chooseExercise(result, itemId, snapshot);
    for (const issue of result.issues) {
      if (issue.fieldPath === `items.${index}.exercise` && ['customExercise', 'exerciseMissing', 'exerciseAmbiguous'].includes(issue.code))
        result = resolveDraftIssue(result, issue.id, { kind: 'edited' });
    }
    this.binding.activity.controller.edit({ ...result, candidate: { ...result.candidate, performedConfirmed: false } });
  }
  async beginSchedule(): Promise<void> {
    this.requireBegin();
    this.state.scheduleIntent = { phase: 'loading' }; this.emit();
    const epoch = this.epoch;
    await this.loadCalendar();
    if (!this.state.available || epoch !== this.epoch) return;
    if (this.state.calendar.status !== 'ready' || !this.state.calendar.value) {
      this.state.scheduleIntent = { phase: 'rejected', error: this.state.calendar.status === 'unavailable'
        ? this.state.calendar.error : { status: 0, code: 'activity_calendar_required' } }; this.emit(); return;
    }
    await this.read('schedule', () => this.binding.activity.resources.schedule());
    if (!this.state.available || epoch !== this.epoch) return;
    this.state.scheduleIntent = this.state.schedule.status === 'ready' ? { phase: 'editing' }
      : { phase: 'rejected', error: this.state.schedule.status === 'unavailable'
        ? this.state.schedule.error : { status: 0, code: 'activity_schedule_unavailable' } };
    this.emit();
  }
  reviewSchedule(input: ActivityScheduleInput): void {
    this.requireCurrent();
    if (!['editing', 'review'].includes(this.state.scheduleIntent.phase) || this.state.schedule.status !== 'ready'
      || this.state.calendar.status !== 'ready' || !this.state.calendar.value) throw new Error('schedule_review_unavailable');
    const write = sanitizeSchedule({ ...input, expectedRevision: this.state.schedule.value?.revision ?? 0 });
    this.state.scheduleIntent = { phase: 'review', write }; this.emit();
  }
  async confirmSchedule(): Promise<void> {
    this.requireCurrent();
    this.requireNoPersonalCreate(); this.requireNoPersonalChange(); this.requireNoCalendar();
    if (this.state.scheduleIntent.phase !== 'review' || this.state.schedule.status !== 'ready'
      || this.state.calendar.status !== 'ready' || !this.state.calendar.value) throw new Error('explicit_schedule_confirmation_required');
    const key = commandId(this.binding.activity.newSecureKey());
    this.pendingSchedule = { write: copy(this.state.scheduleIntent.write), key,
      timeZone: this.state.calendar.value.timeZone, id: this.state.schedule.value?.id ?? null };
    await this.executeSchedule(this.pendingSchedule);
  }
  async retrySchedule(): Promise<void> {
    this.requireCurrent();
    this.requireNoPersonalCreate(); this.requireNoPersonalChange(); this.requireNoCalendar();
    if (this.state.scheduleIntent.phase !== 'unknown' || !this.pendingSchedule) throw new Error('schedule_retry_unavailable');
    await this.executeSchedule(this.pendingSchedule);
  }
  async beginVoid(id: string): Promise<void> {
    this.requireBegin();
    this.state.voidIntent = { phase: 'loading' };
    const epoch = this.epoch;
    await this.read('entry', () => this.binding.activity.resources.entry(id), entry => {
      if (entry.status !== 'recorded') throw new Error('voided_entry_edit_unavailable');
      this.state.voidIntent = { phase: 'review', entry: copy(entry) };
    });
    if (this.state.available && epoch === this.epoch && this.state.voidIntent.phase === 'loading' && this.state.entry.status === 'unavailable') {
      this.state.voidIntent = { phase: 'rejected', target: null, error: this.state.entry.error }; this.emit();
    }
  }
  async confirmVoid(): Promise<void> {
    this.requireCurrent();
    this.requireNoSchedule();
    this.requireNoPersonalCreate(); this.requireNoPersonalChange(); this.requireNoCalendar();
    if (this.state.voidIntent.phase !== 'review') throw new Error('explicit_void_confirmation_required');
    const entry = this.state.voidIntent.entry;
    const key = commandId(this.binding.activity.newSecureKey());
    this.pendingVoid = Object.freeze({ id: entry.id, expectedRevision: entry.revision, key });
    await this.executeVoid(this.pendingVoid);
  }
  async retryVoid(): Promise<void> {
    this.requireCurrent();
    this.requireNoSchedule();
    this.requireNoPersonalCreate(); this.requireNoPersonalChange(); this.requireNoCalendar();
    if (this.state.voidIntent.phase !== 'unknown' || !this.pendingVoid) throw new Error('void_retry_unavailable');
    await this.executeVoid(this.pendingVoid);
  }
  async cancel(): Promise<void> {
    this.requireCurrent(); this.epoch += 1;
    // This drops local input only. A dispatched write may still have applied on the server.
    if (this.binding.activity.controller.getState().accountGeneration === this.binding.activity.sessionGeneration)
      await this.binding.activity.controller.cancel();
  }
  async background(): Promise<void> { await this.cancel(); }
  async dispose(): Promise<void> {
    if (!this.state.available) { this.subscription?.remove(); this.observers.clear(); return; }
    const uncertain = this.pendingVoid !== null || this.pendingSchedule !== null || this.pendingPersonalCreate !== null || this.pendingPersonalChange !== null || this.pendingCalendar !== null;
    this.pendingVoid = null;
    this.pendingSchedule = null;
    this.pendingPersonalCreate = null;
    this.pendingPersonalChange = null;
    this.pendingCalendar = null;
    this.state.available = false; this.epoch += 1; this.subscription?.remove();
    this.state = this.empty(false, initialDraftState(this.binding.activity.sessionGeneration));
    if (uncertain) this.state.invalidation = { status: 0, code: 'request_unconfirmed', originalEffectUnknown: true };
    this.emit(); this.observers.clear();
    if (this.binding.activity.controller.getState().accountGeneration === this.binding.activity.sessionGeneration)
      await this.binding.activity.controller.cancel();
  }
  private capture(input: ActivityCaptureInput) {
    if (this.state.calendar.status !== 'ready' || !this.state.calendar.value) throw new Error('activity_calendar_required');
    if (input.timeZone !== this.state.calendar.value.timeZone) throw new Error('activity_zone_mismatch');
    return freezeCaptureContext({ ...input, accountGeneration: this.binding.activity.sessionGeneration,
      draftId: this.binding.activity.newSecureKey() });
  }
  private requireBegin(): void {
    this.requireCurrent();
    this.requireNoVoid();
    this.requireNoSchedule();
    this.requireNoPersonalCreate(); this.requireNoPersonalChange(); this.requireNoCalendar();
    if (['saving', 'unknown', 'capture', 'transcriptReview'].includes(this.state.draft.phase)) throw new Error('capture_unavailable');
  }
  private requireNoVoid(): void {
    if (['loading', 'review', 'saving', 'unknown'].includes(this.state.voidIntent.phase)) throw new Error('void_intent_in_progress');
  }
  private requireNoSchedule(): void {
    if (['loading', 'editing', 'review', 'saving', 'unknown'].includes(this.state.scheduleIntent.phase)) throw new Error('schedule_intent_in_progress');
  }
  private requireNoPersonalCreate(): void {
    if (['review', 'saving', 'unknown'].includes(this.state.personalCreateIntent.phase)) throw new Error('personal_create_in_progress');
  }
  private requireNoPersonalChange(): void {
    if (['loading', 'editing', 'review', 'saving', 'unknown'].includes(this.state.personalChangeIntent.phase)) throw new Error('personal_change_in_progress');
  }
  private requireNoCalendar(): void {
    if (['review', 'saving', 'unknown'].includes(this.state.calendarIntent.phase)) throw new Error('calendar_intent_in_progress');
  }
  private async executeCalendar(command: CalendarCommand): Promise<void> {
    const epoch = this.epoch;
    this.state.calendarIntent = { phase: 'saving' }; this.emit();
    try {
      const calendar = await this.binding.activity.resources.createCalendar(command.timeZone, command.key);
      if (this.state.available && !this.current()) this.invalidate();
      if (!this.state.available || epoch !== this.epoch || this.pendingCalendar !== command) return;
      if (!calendar || calendar.timeZone !== command.timeZone || calendar.revision !== 1 || calendar.calendarPolicy !== 'activity-calendar-intl-v1'
        || typeof calendar.createdAt !== 'string' || typeof calendar.activationDate !== 'string'
        || localDateAt(calendar.createdAt, command.timeZone) !== calendar.activationDate)
        throw { status: 502, code: 'invalid_calendar_response', effectUnknown: true };
      this.pendingCalendar = null;
      this.reads.calendar += 1; this.reads.schedule += 1; this.reads.adherence += 1;
      this.state.calendar = { status: 'ready', value: copy(calendar) };
      this.state.schedule = { status: 'idle' }; this.state.adherence = { status: 'idle' };
      this.state.calendarIntent = { phase: 'configured', calendar: copy(calendar) }; this.emit();
    } catch (error) {
      if (!this.state.available || epoch !== this.epoch || this.pendingCalendar !== command) return;
      const failure = error as { status?: number; code?: string; effectUnknown?: boolean; originalEffectUnknown?: boolean } | null;
      const detail = { status: failure?.status ?? 0, code: failure?.code ?? 'request_unconfirmed',
        ...(failure?.originalEffectUnknown ? { originalEffectUnknown: true } : {}) };
      if (!this.current() || detail.status === 401 || detail.code === 'session_changed') { this.invalidate(detail); return; }
      const unknown = failure?.effectUnknown === true || failure?.originalEffectUnknown === true || detail.status === 0 || detail.status >= 500;
      if (!unknown) { this.pendingCalendar = null; this.reads.calendar += 1; this.state.calendar = { status: 'idle' }; }
      this.state.calendarIntent = { phase: unknown ? 'unknown' : 'rejected', error: detail }; this.emit();
    }
  }
  private async beginPersonalChange(id: string, operation: 'edit' | 'retire'): Promise<void> {
    this.requireBegin();
    const epoch = this.epoch;
    this.state.personalChangeIntent = { phase: 'loading' }; this.emit();
    await this.read('personalExercise', () => this.binding.activity.resources.personalExercise(id), exercise => {
      if (exercise.id !== id || !Number.isSafeInteger(exercise.revision) || exercise.revision < 1 || typeof exercise.retired !== 'boolean')
        throw { status: 502, code: 'invalid_personal_exercise_response' };
      if (exercise.retired) {
        this.state.personalChangeIntent = { phase: 'rejected', error: { status: 409, code: 'exercise_retired' } }; return;
      }
      const { id: _, revision: __, retired: ___, createdAt: ____, updatedAt: _____, ...fields } = exercise;
      this.state.personalChangeIntent = operation === 'edit' ? { phase: 'editing', exercise: copy(exercise) }
        : { phase: 'review', operation, exercise: copy(exercise), fields: sanitizePersonalExercise(fields) };
    });
    if (this.state.available && epoch === this.epoch && this.state.personalChangeIntent.phase === 'loading') {
      this.state.personalChangeIntent = { phase: 'rejected', error: this.state.personalExercise.status === 'unavailable'
        ? this.state.personalExercise.error : { status: 0, code: 'personal_exercise_unavailable' } }; this.emit();
    }
  }
  private async executePersonalChange(command: PersonalChangeCommand): Promise<void> {
    const epoch = this.epoch;
    this.state.personalChangeIntent = { phase: 'saving' }; this.emit();
    try {
      const exercise = command.operation === 'edit'
        ? await this.binding.activity.resources.editPersonalExercise(command.id, command.expectedRevision, copy(command.fields), command.key)
        : await this.binding.activity.resources.retirePersonalExercise(command.id, command.expectedRevision, command.key);
      if (this.state.available && !this.current()) this.invalidate();
      if (!this.state.available || epoch !== this.epoch || this.pendingPersonalChange !== command) return;
      if (!exercise || exercise.id !== command.id || exercise.revision !== command.expectedRevision + 1 || exercise.retired !== (command.operation === 'retire')
        || !(Object.keys(command.fields) as (keyof PersonalExerciseFields)[]).every(key => exercise[key] === command.fields[key]))
        throw { status: 502, code: 'invalid_personal_change_response', effectUnknown: true };
      this.pendingPersonalChange = null;
      this.reads.catalog += 1; this.reads.personalExercises += 1; this.reads.personalExercise += 1;
      this.state.catalog = { status: 'idle' }; this.state.personalExercises = { status: 'idle' };
      this.state.personalExercise = { status: 'ready', value: copy(exercise) };
      this.state.personalChangeIntent = { phase: 'saved', operation: command.operation, exercise: copy(exercise) }; this.emit();
    } catch (error) {
      if (!this.state.available || epoch !== this.epoch || this.pendingPersonalChange !== command) return;
      const failure = error as { status?: number; code?: string; effectUnknown?: boolean; originalEffectUnknown?: boolean } | null;
      const detail = { status: failure?.status ?? 0, code: failure?.code ?? 'request_unconfirmed',
        ...(failure?.originalEffectUnknown ? { originalEffectUnknown: true } : {}) };
      if (!this.current() || detail.status === 401 || detail.code === 'session_changed') { this.invalidate(detail); return; }
      const unknown = failure?.effectUnknown === true || failure?.originalEffectUnknown === true || detail.status === 0 || detail.status >= 500;
      if (!unknown) {
        this.pendingPersonalChange = null; this.reads.personalExercise += 1; this.state.personalExercise = { status: 'idle' };
      }
      this.state.personalChangeIntent = { phase: unknown ? 'unknown' : detail.status === 409 ? 'stale' : 'rejected', error: detail }; this.emit();
    }
  }
  private async executePersonalCreate(command: PersonalCreateCommand): Promise<void> {
    const epoch = this.epoch;
    this.state.personalCreateIntent = { phase: 'saving' }; this.emit();
    try {
      const exercise = await this.binding.activity.resources.createPersonalExercise(copy(command.fields), command.key);
      if (this.state.available && !this.current()) this.invalidate();
      if (!this.state.available || epoch !== this.epoch || this.pendingPersonalCreate !== command) return;
      if (!exercise || typeof exercise.id !== 'string' || !exercise.id || exercise.revision !== 1 || exercise.retired !== false
        || !(Object.keys(command.fields) as (keyof PersonalExerciseFields)[]).every(key => exercise[key] === command.fields[key]))
        throw { status: 502, code: 'invalid_personal_create_response', effectUnknown: true };
      resourceId(exercise.id);
      this.pendingPersonalCreate = null;
      this.reads.catalog += 1; this.state.catalog = { status: 'idle' };
      this.reads.personalExercises += 1; this.state.personalExercises = { status: 'idle' };
      this.state.personalCreateIntent = { phase: 'created', exercise: copy(exercise) }; this.emit();
    } catch (error) {
      if (!this.state.available || epoch !== this.epoch || this.pendingPersonalCreate !== command) return;
      const failure = error as { status?: number; code?: string; effectUnknown?: boolean; originalEffectUnknown?: boolean } | null;
      const detail = { status: failure?.status ?? 0, code: failure?.code ?? 'request_unconfirmed',
        ...(failure?.originalEffectUnknown ? { originalEffectUnknown: true } : {}) };
      if (!this.current() || detail.status === 401 || detail.code === 'session_changed') { this.invalidate(detail); return; }
      const unknown = failure?.effectUnknown === true || failure?.originalEffectUnknown === true || detail.status === 0 || detail.status >= 500;
      if (!unknown) this.pendingPersonalCreate = null;
      this.state.personalCreateIntent = { phase: unknown ? 'unknown' : 'rejected', error: detail }; this.emit();
    }
  }
  private async executeSchedule(command: ScheduleCommand): Promise<void> {
    const epoch = this.epoch;
    this.state.scheduleIntent = { phase: 'saving' }; this.emit();
    try {
      const schedule = await this.binding.activity.resources.saveSchedule(copy(command.write), command.key);
      if (this.state.available && !this.current()) this.invalidate();
      if (!this.state.available || epoch !== this.epoch || this.pendingSchedule !== command) return;
      if (!schedule || !schedule.id || (command.id !== null && schedule.id !== command.id)
        || schedule.revision !== command.write.expectedRevision + 1 || schedule.timeZone !== command.timeZone
        || schedule.effectiveFrom !== command.write.effectiveFrom || !Array.isArray(schedule.week) || schedule.week.length !== 7
        || !command.write.week.every(day => schedule.week.some(saved => saved.isoWeekday === day.isoWeekday && saved.expectation === day.expectation
          && (day.plan === null ? saved.planSnapshot === null : saved.planSnapshot?.id === day.plan.id && saved.planSnapshot.revision === day.plan.revision))))
        throw { status: 502, code: 'invalid_schedule_response', effectUnknown: true };
      this.pendingSchedule = null;
      this.reads.adherence += 1; this.reads.schedule += 1;
      this.state.adherence = { status: 'idle' };
      this.state.schedule = { status: 'ready', value: copy(schedule) };
      this.state.scheduleIntent = { phase: 'saved', schedule: copy(schedule) }; this.emit();
    } catch (error) {
      if (!this.state.available || epoch !== this.epoch || this.pendingSchedule !== command) return;
      const failure = error as { status?: number; code?: string; effectUnknown?: boolean; originalEffectUnknown?: boolean } | null;
      const detail = { status: failure?.status ?? 0, code: failure?.code ?? 'request_unconfirmed',
        ...(failure?.originalEffectUnknown ? { originalEffectUnknown: true } : {}) };
      if (!this.current() || detail.status === 401 || detail.code === 'session_changed') { this.invalidate(detail); return; }
      const unknown = failure?.effectUnknown === true || failure?.originalEffectUnknown === true || detail.status === 0 || detail.status >= 500;
      if (!unknown) {
        this.pendingSchedule = null; this.reads.schedule += 1; this.state.schedule = { status: 'idle' };
      }
      this.state.scheduleIntent = { phase: unknown ? 'unknown' : detail.status === 409 ? 'stale' : 'rejected', error: detail }; this.emit();
    }
  }
  private voidTarget(command: VoidTarget): VoidTarget { return { id: command.id, expectedRevision: command.expectedRevision }; }
  private async executeVoid(command: Readonly<VoidTarget & { key: string }>): Promise<void> {
    const epoch = this.epoch;
    this.state.voidIntent = { phase: 'saving', target: this.voidTarget(command) }; this.emit();
    try {
      const entry = await this.binding.activity.resources.voidEntry(command.id, command.expectedRevision, command.key);
      if (this.state.available && !this.current()) this.invalidate();
      if (!this.state.available || epoch !== this.epoch || this.pendingVoid !== command) return;
      if (!entry || entry.id !== command.id || entry.status !== 'voided' || entry.revision !== command.expectedRevision + 1)
        throw { status: 502, code: 'invalid_void_response', effectUnknown: true };
      this.pendingVoid = null;
      // The server confirmed the void. Clear the old editable draft; native cancellation cannot undo that receipt.
      void this.binding.activity.controller.cancel().catch(() => {});
      this.state.voidIntent = { phase: 'voided', entry: copy(entry) }; this.emit();
    } catch (error) {
      if (!this.state.available || epoch !== this.epoch || this.pendingVoid !== command) return;
      const failure = error as { status?: number; code?: string; effectUnknown?: boolean; originalEffectUnknown?: boolean } | null;
      const detail = { status: failure?.status ?? 0, code: failure?.code ?? 'request_unconfirmed',
        ...(failure?.originalEffectUnknown ? { originalEffectUnknown: true } : {}) };
      if (!this.current() || detail.status === 401 || detail.code === 'session_changed') { this.invalidate(detail); return; }
      const unknown = failure?.effectUnknown === true || detail.status === 0 || detail.status >= 500;
      if (!unknown) this.pendingVoid = null;
      this.state.voidIntent = { phase: unknown ? 'unknown' : detail.status === 409 ? 'stale' : 'rejected', target: this.voidTarget(command), error: detail };
      this.emit();
    }
  }
  private current(): boolean {
    return this.binding.isCurrentSession() && this.binding.activity.controller.getState().accountGeneration === this.binding.activity.sessionGeneration;
  }
  private requireCurrent(): void {
    if (!this.state.available || !this.current()) { this.invalidate(); throw new Error('activity_session_unavailable'); }
  }
  private invalidate(error: DraftState['error'] = null): void {
    if (!this.state.available) return;
    const uncertain = this.pendingVoid !== null || this.pendingSchedule !== null || this.pendingPersonalCreate !== null || this.pendingPersonalChange !== null || this.pendingCalendar !== null || (!error && ['saving', 'unknown'].includes(this.state.draft.phase));
    this.pendingVoid = null;
    this.pendingSchedule = null;
    this.pendingPersonalCreate = null;
    this.pendingPersonalChange = null;
    this.pendingCalendar = null;
    this.epoch += 1; this.subscription?.remove();
    this.state = this.empty(false, initialDraftState(this.binding.activity.sessionGeneration));
    this.state.invalidation = { code: error?.code ?? 'session_changed', status: error?.status ?? 409,
      ...(uncertain || error?.originalEffectUnknown ? { originalEffectUnknown: true } : {}) };
    this.emit();
    if (this.binding.activity.controller.getState().accountGeneration === this.binding.activity.sessionGeneration)
      void this.binding.activity.controller.cancel().catch(() => {});
  }
  private empty(available: boolean, draft: DraftState): ActivityEntryState {
    return { available, invalidation: null, entries: { status: 'idle' }, entry: { status: 'idle' }, catalog: { status: 'idle' },
      calendar: { status: 'idle' }, adherence: { status: 'idle' }, schedule: { status: 'idle' }, draft,
      voidIntent: { phase: 'idle' }, scheduleIntent: { phase: 'idle' }, personalCreateIntent: { phase: 'idle' },
      personalExercises: { status: 'idle' }, personalExercise: { status: 'idle' }, personalChangeIntent: { phase: 'idle' }, calendarIntent: { phase: 'idle' } };
  }
  private emit(): void { for (const observer of this.observers) observer(copy(this.state)); }
  private async read<K extends ReadKey>(key: K, request: () => Promise<ReadValue<K>>, accept?: (value: ReadValue<K>) => void): Promise<void> {
    this.requireCurrent();
    const epoch = this.epoch, sequence = ++this.reads[key];
    this.state[key] = { status: 'loading' } as ActivityEntryState[K]; this.emit();
    try {
      const value = await request();
      if (this.state.available && !this.current()) this.invalidate();
      if (!this.state.available || epoch !== this.epoch || sequence !== this.reads[key]) return;
      accept?.(value);
      if (!this.state.available || epoch !== this.epoch || sequence !== this.reads[key]) return;
      this.state[key] = { status: 'ready', value: copy(value) } as ActivityEntryState[K]; this.emit();
    } catch (error) {
      if (!this.state.available || epoch !== this.epoch) return;
      const failure = error as { status?: number; code?: string; message?: string; originalEffectUnknown?: boolean } | null;
      if (!this.current() || failure?.status === 401 || failure?.code === 'session_changed') {
        this.invalidate({ code: failure?.code ?? 'session_changed', status: failure?.status ?? 409,
          ...(failure?.originalEffectUnknown ? { originalEffectUnknown: true } : {}) }); return;
      }
      if (sequence !== this.reads[key]) return;
      this.state[key] = { status: 'unavailable', error: { status: failure?.status ?? 0,
        code: failure?.code ?? (failure?.message === 'voided_entry_edit_unavailable' ? failure.message : 'activity_read_unavailable') } } as ActivityEntryState[K];
      this.emit();
    }
  }
}
