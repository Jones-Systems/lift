import type { ActivityRuntimeContext } from '../../FormRuntime';
import { ActivityEntryConsumer, type ActivityEntryState, type ActivityRead } from '../entryConsumer';
import type { ActivityEntry, ExerciseRef } from '../contracts';
import type { PendingActivityCommand } from '../drafts/controller';
import type { DraftResult } from '../drafts/model';
import { instantMilliseconds, localDateAt, parseCivilDate, validTimeZone } from '../drafts/dates';
import { clone, invalidateReview, receiptMatches, reviewProblems, sameValue, validEntry, validSnapshot } from './draftEditing';

export type ActivityView = { readonly context: ActivityRuntimeContext; readonly attachment: number };
export type ActivityRoute = 'list' | 'calendar' | 'editor' | 'review' | 'speech' | 'detail' | 'void';
export type ActivitySnapshot = {
  available: boolean; consumer: ActivityEntryState | null; route: ActivityRoute; viewEpoch: number; editVersion: number;
  selectedDate: string; rows: ActivityEntry[]; listStatus: 'idle' | 'loading' | 'ready' | 'unavailable';
  nextCursor: string | null; more: boolean; listError: string | null;
  detail: ActivityRead<ActivityEntry>; receipt: ActivityEntry | null; busy: boolean; notice: string | null;
  integrityUnavailable: boolean; custodyUnavailable: boolean;
};
type ActionStamp = { view: ActivityView; epoch: number; editVersion: number; draftEpoch: number; route: ActivityRoute };
type ReadTicket = { stamp: ActionStamp; id: string; minimumRevision: number };
type Issued = { epoch: number; command: PendingActivityCommand };
const unresolved = (phase: string) => phase === 'saving' || phase === 'unknown';
export function pendingChannels(state: ActivityEntryState): string[] {
  return [
    ['entry', state.draft.phase], ['void', state.voidIntent.phase], ['calendar', state.calendarIntent.phase],
    ['schedule', state.scheduleIntent.phase], ['personal-create', state.personalCreateIntent.phase], ['personal-change', state.personalChangeIntent.phase],
  ].filter(([, phase]) => unresolved(phase)).map(([channel]) => channel);
}
export function failureText(code?: string): string {
  switch (code) {
    case 'activity_persistability_unavailable': return 'Activity saving is unavailable in this configuration. Your draft has not been confirmed saved.';
    case 'stale_revision': return 'This entry changed. Explicitly load a fresh correction or void review before continuing.';
    case 'exercise_retired': return 'An exercise is no longer available for selection. Choose a current exercise and review again.';
    case 'not_found': return 'This entry is unavailable to this session.';
    case 'invalid_entry_response': return 'Entry integrity could not be established. No editable entry was admitted.';
    case 'speech_unavailable': return 'Speech is unavailable through the configured Activity ports. You can enter activity manually.';
    default: return 'The request could not be completed. Check the details and current availability before continuing.';
  }
}

/** Memory-only view owner. Detach never cancels the root controller or its original pending command. */
export class ActivityPresentation {
  readonly consumer: ActivityEntryConsumer;
  private state: ActivityEntryState;
  private snapshot!: ActivitySnapshot;
  private observers = new Set<() => void>();
  private view: ActivityView | null = null;
  private attachment = 0;
  private viewEpoch = 0;
  private editVersion = 0;
  private route: ActivityRoute = 'list';
  private selectedDate = '';
  private rows: ActivityEntry[] = [];
  private listStatus: ActivitySnapshot['listStatus'] = 'idle';
  private nextCursor: string | null = null;
  private listError: string | null = null;
  private more = false;
  private listRequest = 0;
  private detail: ActivityRead<ActivityEntry> = { status: 'idle' };
  private receipt: ActivityEntry | null = null;
  private busy = false;
  private notice: string | null = null;
  private integrityUnavailable = false;
  private custodyUnavailable = false;
  private retired = false;
  private readTicket: ReadTicket | null = null;
  private issued: Issued | null = null;
  private voidIssued: ActivityEntry | null = null;
  private receiptAwaitingView = false;
  private calendarReviewZone: string | null = null;
  private review: { epoch: number; version: number; result: DraftResult } | null = null;
  private origin: { route: 'list' | 'detail'; entry: ActivityEntry | null } = { route: 'list', entry: null };

  constructor(private readonly binding: ActivityRuntimeContext) {
    if (binding.sessionGeneration !== binding.activity.sessionGeneration) throw new Error('activity_session_mismatch');
    const read = async <T>(request: () => Promise<T>): Promise<T> => {
      const stamp = this.view ? this.stamp(this.view) : null;
      if (!stamp || !this.admit(stamp)) throw { status: 409, code: 'view_read_expired' };
      const value = await request();
      if (!this.admit(stamp)) throw { status: 409, code: 'view_read_expired' };
      return value;
    };
    const resources = { ...binding.activity.resources,
      calendar: () => read(async () => {
        const calendar = await binding.activity.resources.calendar();
        if (calendar !== null && (!calendar || !validTimeZone(calendar.timeZone) || !parseCivilDate(calendar.activationDate)
          || !Number.isSafeInteger(calendar.revision) || calendar.revision < 1 || calendar.calendarPolicy !== 'activity-calendar-intl-v1'
          || instantMilliseconds(calendar.createdAt) === null || localDateAt(calendar.createdAt, calendar.timeZone) !== calendar.activationDate)) throw { status: 502, code: 'activity_calendar_unavailable' };
        return calendar;
      }),
      catalog: () => read(async () => {
        const catalog = await binding.activity.resources.catalog();
        if (!catalog || !Array.isArray(catalog.items) || !catalog.items.every(validSnapshot) || !Array.isArray(catalog.selectionUses)
          || !catalog.selectionUses.every(use => ['manual', 'nativeSpeech', 'activityPlan', 'recommendationChoice'].includes(use))) throw { status: 502, code: 'activity_catalog_unavailable' };
        return catalog;
      }),
      entries: (query: Parameters<ActivityRuntimeContext['activity']['resources']['entries']>[0]) => read(() => binding.activity.resources.entries(query)),
      adherence: (from: string, to: string) => read(async () => {
        const value = await binding.activity.resources.adherence(from, to);
        if (!value || value.policyVersion !== 'activity-adherence-v1' || instantMilliseconds(value.asOf) === null
          || !validTimeZone(value.timeZone) || !parseCivilDate(value.throughDate)
          || (value.coverageStart !== null && !parseCivilDate(value.coverageStart)) || !Array.isArray(value.days)
          || !value.sourceGeneration || typeof value.sourceGeneration.legacyAvailable !== 'boolean'
          || !value.monthlyAllowance || ![0, 1].includes(value.monthlyAllowance.remaining)
          || typeof value.monthlyAllowance.month !== 'string'
          || (value.monthlyAllowance.protectedDate !== null && !parseCivilDate(value.monthlyAllowance.protectedDate))
          || !value.days.every(day => day && parseCivilDate(day.localDate) && validTimeZone(day.timeZone)
            && Number.isSafeInteger(day.revision) && day.revision >= 0
            && ['met', 'not_met', 'pending', 'unknown'].includes(day.actual)
            && ['activityRecorded', 'plannedRest', 'protectedMiss', 'missed', 'pending', 'unknownPlan'].includes(day.state))
          || ![value.currentPlanDays, value.longestPlanDays, value.satisfiedDaysInCurrentStreak, value.protectedDaysInCurrentStreak,
            value.sourceGeneration.activity, value.sourceGeneration.projectionRevision].every(number => Number.isSafeInteger(number) && number >= 0))
          throw { status: 502, code: 'activity_adherence_unavailable' };
        return value;
      }),
      entry: async (id: string) => {
      const ticket = this.readTicket;
      if (!ticket || ticket.id !== id || !this.admit(ticket.stamp)) throw { status: 409, code: 'view_read_expired' };
      const entry = await binding.activity.resources.entry(id);
      if (this.readTicket !== ticket || !this.admit(ticket.stamp)) throw { status: 409, code: 'view_read_expired' };
      if (!validEntry(entry, id, ticket.minimumRevision)) throw { status: 502, code: 'invalid_entry_response' };
      return entry;
    } };
    this.consumer = new ActivityEntryConsumer({ isCurrentSession: () => this.current(), activity: { ...binding.activity, resources } });
    this.state = this.consumer.getState();
    if (this.state.draft.phase === 'saved') this.integrityFailure();
    this.publish();
    this.consumer.subscribe(state => this.observe(state));
  }
  private current(): boolean {
    return !this.retired && this.binding.isCurrentSession()
      && this.binding.activity.sessionGeneration === this.binding.sessionGeneration
      && this.binding.activity.controller.getState().accountGeneration === this.binding.sessionGeneration;
  }
  attach(context: ActivityRuntimeContext): ActivityView {
    if (context.activity !== this.binding.activity || context.sessionGeneration !== this.binding.sessionGeneration
      || context.account.accountId !== this.binding.account.accountId || !context.isCurrentSession() || !this.current()) {
      this.retire(); throw new Error('activity_session_unavailable');
    }
    this.view = Object.freeze({ context, attachment: ++this.attachment });
    this.viewEpoch += 1; this.review = null; this.calendarReviewZone = null;
    if (this.route === 'review') this.route = 'editor';
    if (this.state.draft.phase === 'saved' && this.state.draft.saved && !this.integrityUnavailable) {
      this.receipt = clone(this.state.draft.saved); this.detail = { status: 'ready', value: clone(this.state.draft.saved) };
      this.route = 'detail'; this.receiptAwaitingView = true;
    }
    if (this.state.voidIntent.phase === 'voided' && !this.integrityUnavailable && this.validVoidReceipt(this.state.voidIntent.entry)) {
      this.receipt = clone(this.state.voidIntent.entry); this.detail = { status: 'ready', value: clone(this.state.voidIntent.entry) };
      this.route = 'detail'; this.receiptAwaitingView = true;
    }
    if (this.route === 'calendar' && this.state.calendarIntent.phase === 'configured') this.route = 'list';
    if (['structuredReview', 'rejected'].includes(this.state.draft.phase) && this.state.draft.result?.candidate.performedConfirmed)
      this.consumer.edit(invalidateReview(this.state.draft.result, true));
    this.publish(); return this.view;
  }
  detach(view: ActivityView): void {
    if (this.view !== view) return;
    this.view = null; this.viewEpoch += 1; this.review = null; this.calendarReviewZone = null; this.publish();
  }
  retire(): void {
    if (this.retired) return;
    this.retired = true; this.view = null; this.viewEpoch += 1; this.review = null;
    this.rows = []; this.detail = { status: 'idle' }; this.receipt = null; this.issued = null;
    this.voidIssued = null; this.origin = { route: 'list', entry: null }; this.selectedDate = ''; this.nextCursor = null; this.listError = null;
    this.notice = 'The account session changed. Old Activity actions are unavailable. Any unconfirmed original request remains unresolved; do not repeat it under another sign-in.';
    this.publish();
  }
  getSnapshot = (): ActivitySnapshot => this.snapshot;
  subscribe = (observer: () => void): (() => void) => { this.observers.add(observer); return () => { this.observers.delete(observer); }; };
  private observe(state: ActivityEntryState): void {
    const previous = this.state;
    this.state = state;
    if (!this.current() || !state.available) { this.retire(); return; }
    if (previous && (!sameValue(previous.draft.result, state.draft.result) || previous.draft.epoch !== state.draft.epoch)) this.editVersion += 1;
    if (state.draft.pending) this.issued = { epoch: state.draft.epoch, command: clone(state.draft.pending) };
    if (state.draft.phase === 'saved' && state.draft.saved && previous?.draft.phase !== 'saved') {
      if (!this.issued || this.issued.epoch !== state.draft.epoch || !receiptMatches(state.draft.saved, this.issued.command)) {
        this.integrityFailure();
      }
    }
    if (previous && unresolved(previous.draft.phase) && state.draft.phase === 'cancelled') {
      this.custodyUnavailable = true; this.review = null;
      this.notice = 'The original controller lost its pending activity intent during backgrounding or cancellation. Its server effect is unresolved. Exact retry and restart recovery are unavailable here; do not start a replacement intent.';
    }
    if (state.draft.phase === 'saved' && !this.integrityUnavailable && state.draft.saved && previous?.draft.phase !== 'saved') {
      // A remount may show the validated receipt; it does not replay a detached navigation callback.
      this.receipt = clone(state.draft.saved);
      this.receiptAwaitingView = true;
    }
    if (state.voidIntent.phase === 'voided' && previous?.voidIntent.phase !== 'voided') {
      if (!this.validVoidReceipt(state.voidIntent.entry)) this.integrityFailure();
      else { this.receipt = clone(state.voidIntent.entry); this.receiptAwaitingView = true; }
    }
    this.publish();
  }
  private publish(): void {
    const available = this.current() && this.state?.available !== false;
    this.snapshot = { available, consumer: available ? clone(this.state) : null, route: this.route,
      viewEpoch: this.viewEpoch, editVersion: this.editVersion, selectedDate: this.selectedDate,
      rows: available ? clone(this.rows) : [], listStatus: this.listStatus, nextCursor: this.nextCursor, more: this.more,
      listError: this.listError, detail: available ? clone(this.detail) : { status: 'idle' }, receipt: available ? clone(this.receipt) : null,
      busy: this.busy, notice: this.notice, integrityUnavailable: this.integrityUnavailable, custodyUnavailable: this.custodyUnavailable };
    for (const observer of this.observers) observer();
  }
  private stamp(view: ActivityView): ActionStamp {
    return { view, epoch: this.viewEpoch, editVersion: this.editVersion, draftEpoch: this.state.draft.epoch, route: this.route };
  }
  private admit(stamp: ActionStamp, draft = false): boolean {
    return this.current() && this.state.available && this.view === stamp.view && stamp.view.context.isCurrentSession()
      && stamp.epoch === this.viewEpoch && (!draft || (stamp.draftEpoch === this.state.draft.epoch && stamp.editVersion === this.editVersion));
  }
  private blocked(): boolean {
    return this.busy || this.integrityUnavailable || this.custodyUnavailable || pendingChannels(this.state).length > 0;
  }
  private navigate(route: ActivityRoute): void { this.route = route; this.viewEpoch += 1; this.review = null; this.notice = null; this.publish(); }
  private async perform(stamp: ActionStamp, work: () => void | Promise<void>, draft = false): Promise<void> {
    if (!this.current()) { this.retire(); return; }
    if (!this.admit(stamp, draft) || this.blocked()) return;
    try { await work(); } catch (error) {
      if (this.admit(stamp)) { this.notice = failureText((error as { code?: string; message?: string })?.code ?? (error as Error)?.message); this.publish(); }
    }
  }
  actions(view: ActivityView) {
    const stamp = this.stamp(view);
    const detailTarget = clone(this.detail.status === 'ready' ? this.detail.value : this.receipt);
    const rowTargets = this.rows.map(entry => ({ id: entry.id, revision: entry.revision }));
    const date = this.selectedDate, cursor = this.nextCursor;
    const voidTarget = this.state.voidIntent.phase === 'review' ? clone(this.state.voidIntent.entry) : null;
    const calendarTarget = this.state.calendarIntent.phase === 'review' && this.calendarReviewZone === this.state.calendarIntent.timeZone ? this.calendarReviewZone : null;
    return {
      initialize: () => this.perform(stamp, async () => {
        if (this.state.calendar.status === 'idle') await this.consumer.loadCalendar();
        if (this.admit(stamp) && this.state.catalog.status === 'idle') await this.consumer.loadCatalog();
        if (this.admit(stamp) && this.receiptAwaitingView && this.receipt) {
          this.receiptAwaitingView = false;
          await this.saved(stamp, this.receipt);
        }
      }),
      showReceipt: () => this.perform(stamp, async () => {
        if (this.receiptAwaitingView && this.receipt) { this.receiptAwaitingView = false; await this.saved(stamp, this.receipt); }
      }),
      reloadCalendar: () => this.perform(stamp, () => this.consumer.loadCalendar()),
      reloadCatalog: () => this.perform(stamp, () => this.consumer.loadCatalog()),
      loadDay: (date: string) => this.perform(stamp, () => this.loadDay(stamp, date, false)),
      loadMore: () => this.perform(stamp, async () => {
        if (date === this.selectedDate && cursor === this.nextCursor) await this.loadDay(stamp, date, true);
      }),
      reloadAdherence: () => this.perform(stamp, async () => { if (date && date === this.selectedDate) await this.consumer.loadAdherence(date, date); }),
      setupCalendar: () => this.perform(stamp, () => { if (this.state.calendar.status === 'ready' && this.state.calendar.value === null) this.navigate('calendar'); }),
      invalidateCalendarReview: () => this.perform(stamp, () => { this.calendarReviewZone = null; this.publish(); }),
      reviewCalendar: (zone: string) => this.perform(stamp, () => { this.consumer.reviewCalendar(zone); this.calendarReviewZone = zone; this.publish(); }),
      confirmCalendar: () => this.perform(stamp, async () => {
        if (this.state.calendarIntent.phase !== 'review' || !calendarTarget || this.calendarReviewZone !== calendarTarget || this.state.calendarIntent.timeZone !== calendarTarget) return;
        this.calendarReviewZone = null;
        this.busy = true; this.publish();
        try { await this.consumer.confirmCalendar(); } finally { this.busy = false; this.publish(); }
        const outcome = this.consumer.getState().calendarIntent;
        if (this.admit(stamp) && outcome.phase === 'configured') this.navigate('list');
      }),
      calendarDone: () => this.perform(stamp, () => { if (this.state.calendarIntent.phase === 'configured') this.navigate('list'); }),
      beginManual: () => this.perform(stamp, async () => { if (date === this.selectedDate) await this.begin(stamp, false); }),
      beginSpeech: () => this.perform(stamp, async () => { if (date === this.selectedDate) await this.begin(stamp, true); }),
      stopSpeech: () => this.perform(stamp, async () => {
        this.busy = true; this.publish();
        try { await this.consumer.stopSpeech(); } finally { this.busy = false; this.publish(); }
      }, true),
      acceptTranscript: (text: string) => this.perform(stamp, () => {
        if (this.state.draft.phase !== 'transcriptReview') return;
        this.consumer.acceptTranscript(text);
        this.navigate('editor');
      }, true),
      edit: (change: (result: DraftResult, issueKey: () => string) => DraftResult) => this.perform(stamp, () => {
        if (!this.state.draft.result || !['editor', 'review'].includes(this.route) || this.state.draft.phase === 'stale') return;
        const next = invalidateReview(change(clone(this.state.draft.result), this.binding.activity.newSecureKey));
        this.review = null; this.consumer.edit(next);
        if (this.route === 'review') this.navigate('editor');
      }, true),
      chooseExercise: (itemId: string, ref: ExerciseRef) => this.perform(stamp, () => {
        if (this.route !== 'editor' || this.state.draft.phase === 'stale') return;
        this.review = null; this.consumer.selectCatalogExercise(itemId, ref);
      }, true),
      review: () => this.perform(stamp, () => {
        const result = this.state.draft.result;
        if (!result || this.route !== 'editor' || this.state.draft.phase === 'stale') return;
        this.navigate('review');
        this.review = { epoch: this.state.draft.epoch, version: this.editVersion, result: clone(result) }; this.publish();
      }, true),
      save: () => this.perform(stamp, () => this.save(stamp), true),
      openEntry: (id: string) => this.perform(stamp, async () => {
        const row = rowTargets.find(entry => entry.id === id);
        if (row && date === this.selectedDate && this.rows.some(entry => entry.id === id && entry.revision === row.revision)) await this.openEntry(stamp, id);
      }),
      refreshDetail: () => this.perform(stamp, async () => {
        if (detailTarget && this.matchesDetail(detailTarget)) await this.readDetail(stamp, detailTarget.id, detailTarget.revision);
      }),
      correction: () => this.perform(stamp, async () => { if (detailTarget && this.matchesDetail(detailTarget)) await this.startEntryIntent(stamp, 'edit', detailTarget); }),
      beginVoid: () => this.perform(stamp, async () => { if (detailTarget && this.matchesDetail(detailTarget)) await this.startEntryIntent(stamp, 'void', detailTarget); }),
      confirmVoid: () => this.perform(stamp, async () => {
        if (voidTarget && this.state.voidIntent.phase === 'review' && sameValue(voidTarget, this.state.voidIntent.entry)) await this.confirmVoid(stamp);
      }),
      retry: (channel: string) => this.retry(stamp, channel),
      freshReview: () => this.perform(stamp, () => this.freshReview(stamp)),
      back: () => this.perform(stamp, async () => {
        if (this.route === 'review' && this.state.draft.result) {
          this.consumer.edit(invalidateReview(this.state.draft.result, true)); this.navigate('editor');
        } else if (['editor', 'speech', 'void', 'calendar'].includes(this.route)) {
          await this.consumer.cancel();
          if (!this.admit(stamp)) return;
          this.detail = this.origin.entry ? { status: 'ready', value: this.origin.entry } : { status: 'idle' };
          this.navigate(this.origin.route);
        } else if (this.route === 'detail') this.navigate('list');
        else if (this.admit(stamp)) stamp.view.context.close();
      }),
    };
  }
  private async loadDay(stamp: ActionStamp, date: string, more: boolean): Promise<void> {
    if (!parseCivilDate(date) || this.more || this.listStatus === 'loading') return;
    const cursor = more ? this.nextCursor : null;
    if (more && (!cursor || date !== this.selectedDate)) return;
    const request = ++this.listRequest;
    if (!more) { this.selectedDate = date; this.rows = []; this.nextCursor = null; this.listStatus = 'loading'; }
    this.more = more; this.listError = null; this.publish();
    const adherence = !more ? this.consumer.loadAdherence(date, date) : Promise.resolve();
    await this.consumer.loadEntries({ from: date, to: date, limit: 20, ...(cursor ? { cursor } : {}) });
    if (!this.admit(stamp) || request !== this.listRequest || date !== this.selectedDate) {
      this.more = false; if (this.listStatus === 'loading') this.listStatus = 'idle'; this.publish(); await adherence; return;
    }
    const result = this.state.entries;
    if (result.status === 'ready' && result.value && Array.isArray(result.value.items)
      && (result.value.nextCursor === null || (typeof result.value.nextCursor === 'string' && result.value.nextCursor.length <= 500
        && result.value.nextCursor !== cursor))
      && new Set(result.value.items.map(entry => entry?.id)).size === result.value.items.length
      && result.value.items.every(entry => validEntry(entry) && entry.date.localDate === date)) {
      const previous = more ? this.rows : [];
      const ids = new Set(previous.map(entry => entry.id));
      this.rows = [...previous, ...result.value.items.filter(entry => !ids.has(entry.id))];
      this.nextCursor = result.value.nextCursor; this.listStatus = 'ready';
    } else {
      this.listStatus = more && this.rows.length > 0 ? 'ready' : 'unavailable';
      this.listError = 'Entries are unavailable for this date. Previously loaded rows are retained; this is not an empty result.';
    }
    this.more = false; this.publish(); await adherence;
  }
  private async begin(stamp: ActionStamp, speech: boolean): Promise<void> {
    if (this.route !== 'list' || this.state.calendar.status !== 'ready' || !this.state.calendar.value) return;
    this.origin = { route: 'list', entry: null }; this.receipt = null;
    const input = { capturedAt: new Date().toISOString(), timeZone: this.state.calendar.value.timeZone, selectedDate: this.selectedDate || null };
    if (speech) {
      this.busy = true; this.publish();
      try { await this.consumer.beginSpeech(input, 'en-US'); } finally { this.busy = false; this.publish(); }
      if (this.admit(stamp)) this.navigate('speech');
    } else {
      this.consumer.beginManual(input);
      if (this.admit(stamp)) this.navigate('editor');
    }
    if (!this.selectedDate && this.state.draft.context) this.selectedDate = this.state.draft.context.referenceLocalDate;
    this.publish();
  }
  private async save(stamp: ActionStamp): Promise<void> {
    const review = this.review, result = this.state.draft.result;
    if (this.route !== 'review' || !review || !result || review.epoch !== this.state.draft.epoch
      || review.version !== this.editVersion || !sameValue(review.result, result) || reviewProblems(result).length) return;
    this.review = null; this.busy = true; this.publish();
    try {
      this.consumer.confirmReview();
      if (!this.state.draft.result) return;
      await this.consumer.save();
    } finally { this.busy = false; this.publish(); }
    if (this.admit(stamp) && this.state.draft.phase === 'saved' && !this.integrityUnavailable && this.state.draft.saved)
      await this.saved(stamp, this.state.draft.saved);
    else if (this.admit(stamp) && ['rejected', 'stale'].includes(this.state.draft.phase)) {
      const code = this.state.draft.error?.code;
      if (this.state.draft.phase === 'rejected' && this.state.draft.result) this.consumer.edit(invalidateReview(this.state.draft.result, true));
      this.navigate('editor');
      this.notice = failureText(code); this.publish();
    }
  }
  private async saved(stamp: ActionStamp, receipt: ActivityEntry): Promise<void> {
    if (!this.admit(stamp)) return;
    this.receipt = clone(receipt); this.detail = { status: 'ready', value: clone(receipt) };
    this.receiptAwaitingView = false;
    this.navigate('detail');
    const next = this.stamp(stamp.view);
    await this.readDetail(next, receipt.id, receipt.revision);
    if (this.admit(next)) await this.refreshDay(next);
  }
  private async openEntry(stamp: ActionStamp, id: string): Promise<void> {
    const row = this.rows.find(entry => entry.id === id);
    if (this.route !== 'list' || !row) return;
    this.receipt = null; this.detail = { status: 'idle' }; this.navigate('detail');
    await this.readDetail(this.stamp(stamp.view), id, row.revision);
  }
  private async readDetail(stamp: ActionStamp, id: string, minimumRevision: number): Promise<void> {
    if (!this.admit(stamp) || this.busy) return;
    this.busy = true; this.detail = { status: 'loading' }; this.publish();
    try {
      const entry = await this.binding.activity.resources.entry(id);
      if (!this.admit(stamp)) return;
      if (!validEntry(entry, id, minimumRevision)) throw { code: 'invalid_entry_response', status: 502 };
      this.detail = { status: 'ready', value: clone(entry) };
    } catch (error) {
      if ((error as { status?: number })?.status === 401 || (error as { code?: string })?.code === 'session_changed') { this.retire(); return; }
      if (this.admit(stamp)) {
        this.detail = { status: 'unavailable', error: { code: (error as { code?: string }).code ?? 'detail_unavailable', status: (error as { status?: number }).status ?? 0 } };
        this.notice = this.receipt ? 'Saved; latest detail unavailable. The save receipt below is retained.' : 'Entry detail unavailable. Try a fresh read.';
      }
    } finally { this.busy = false; this.publish(); }
  }
  private async startEntryIntent(stamp: ActionStamp, operation: 'edit' | 'void', explicitTarget?: ActivityEntry): Promise<void> {
    const entry = explicitTarget ?? (this.detail.status === 'ready' ? this.detail.value : this.receipt);
    if (!entry || entry.status !== 'recorded') return;
    this.origin = { route: 'detail', entry: clone(entry) };
    this.busy = true; this.readTicket = { stamp, id: entry.id, minimumRevision: entry.revision }; this.publish();
    try {
      if (operation === 'edit') await this.consumer.beginEntryEdit(entry.id); else await this.consumer.beginVoid(entry.id);
      if (!this.admit(stamp)) return;
      if (operation === 'edit' && this.state.draft.editTarget?.id === entry.id && this.state.entry.status === 'ready') this.navigate('editor');
      else if (operation === 'void' && this.state.voidIntent.phase === 'review' && this.state.voidIntent.entry.id === entry.id) this.navigate('void');
      else { this.notice = failureText(this.state.entry.status === 'unavailable' ? this.state.entry.error.code : undefined); }
    } finally { this.readTicket = null; this.busy = false; this.publish(); }
  }
  private matchesDetail(target: ActivityEntry): boolean {
    const current = this.detail.status === 'ready' ? this.detail.value : this.receipt;
    return current !== null && current.id === target.id && current.revision === target.revision && current.status === target.status;
  }
  private async confirmVoid(stamp: ActionStamp): Promise<void> {
    if (this.route !== 'void' || this.state.voidIntent.phase !== 'review') return;
    this.voidIssued = clone(this.state.voidIntent.entry);
    this.busy = true; this.publish();
    try { await this.consumer.confirmVoid(); } finally { this.busy = false; this.publish(); }
    const outcome = this.consumer.getState().voidIntent;
    if (this.admit(stamp) && outcome.phase === 'voided') await this.voidSaved(stamp, outcome.entry);
  }
  private integrityFailure(): void {
    this.integrityUnavailable = true; this.review = null;
    this.notice = 'Integrity unavailable: the returned receipt does not establish the issued activity intent. The server effect is unconfirmed here. The original command owner no longer retains an exact retry; do not manually resend this intent.';
  }
  private async voidSaved(stamp: ActionStamp, receipt: ActivityEntry): Promise<void> {
    if (!this.validVoidReceipt(receipt)) { this.integrityFailure(); this.publish(); return; }
    await this.saved(stamp, receipt);
  }
  private validVoidReceipt(receipt: ActivityEntry): boolean {
    const original = this.voidIssued;
    const content = ({ id: _id, revision: _revision, status: _status, updatedAt: _updated, ...entry }: ActivityEntry) => entry;
    return original !== null && validEntry(receipt, original.id, original.revision + 1) && receipt.revision === original.revision + 1
      && receipt.status === 'voided' && sameValue(content(receipt), content(original));
  }
  private async freshReview(stamp: ActionStamp): Promise<void> {
    const target = this.state.draft.editTarget;
    const intent = this.state.voidIntent;
    const entry = this.origin.entry;
    if (target && entry?.id === target.id) await this.startEntryIntent(stamp, 'edit', entry);
    else if (['stale', 'rejected'].includes(intent.phase) && entry) await this.startEntryIntent(stamp, 'void', entry);
  }
  private async retry(stamp: ActionStamp, channel: string): Promise<void> {
    if (!this.current()) { this.retire(); return; }
    if (!this.admit(stamp) || this.busy || this.integrityUnavailable || this.custodyUnavailable) return;
    if (pendingChannels(this.state).length !== 1 || !pendingChannels(this.state).includes(channel)) return;
    this.busy = true; this.publish();
    try {
      if (channel === 'entry' && this.state.draft.phase === 'unknown') await this.consumer.retryUnknown();
      else if (channel === 'void' && this.state.voidIntent.phase === 'unknown') await this.consumer.retryVoid();
      else if (channel === 'calendar' && this.state.calendarIntent.phase === 'unknown') await this.consumer.retryCalendar();
      else if (channel === 'schedule' && this.state.scheduleIntent.phase === 'unknown') await this.consumer.retrySchedule();
      else if (channel === 'personal-create' && this.state.personalCreateIntent.phase === 'unknown') await this.consumer.retryPersonalExercise();
      else if (channel === 'personal-change' && this.state.personalChangeIntent.phase === 'unknown') await this.consumer.retryPersonalExerciseChange();
    } catch { if (this.admit(stamp)) this.notice = 'The original retry is unavailable. No replacement intent was issued.'; }
    finally { this.busy = false; this.publish(); }
    if (!this.admit(stamp)) return;
    if (channel === 'entry' && this.state.draft.phase === 'saved' && this.state.draft.saved && !this.integrityUnavailable) await this.saved(stamp, this.state.draft.saved);
    else if (channel === 'entry' && ['rejected', 'stale'].includes(this.state.draft.phase)) {
      const code = this.state.draft.error?.code;
      if (this.state.draft.phase === 'rejected' && this.state.draft.result) this.consumer.edit(invalidateReview(this.state.draft.result, true));
      this.navigate('editor'); this.notice = failureText(code); this.publish();
    }
    if (channel === 'void' && this.state.voidIntent.phase === 'voided') await this.voidSaved(stamp, this.state.voidIntent.entry);
    if (channel === 'calendar' && this.state.calendarIntent.phase === 'configured') this.navigate('list');
  }
  private async refreshDay(stamp: ActionStamp): Promise<void> {
    if (!this.selectedDate || !this.admit(stamp)) return;
    this.listStatus = 'idle';
    await this.loadDay(stamp, this.selectedDate, false);
  }
}

const bindings = new WeakMap<ActivityRuntimeContext['activity'], Map<string, ActivityPresentation>>();
export function activityPresentation(context: ActivityRuntimeContext): ActivityPresentation {
  let generations = bindings.get(context.activity);
  if (!generations) { generations = new Map(); bindings.set(context.activity, generations); }
  let presentation = generations.get(context.sessionGeneration);
  if (!presentation) {
    for (const existing of generations.values()) existing.retire();
    presentation = new ActivityPresentation(context); generations.set(context.sessionGeneration, presentation);
  }
  return presentation;
}
export type ActivityActions = ReturnType<ActivityPresentation['actions']>;
