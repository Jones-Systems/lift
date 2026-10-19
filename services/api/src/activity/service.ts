import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import { DomainError, notFound, revision } from '../errors.js';
import type { AccountContext } from '../lifecycle/types.js';
import { canonical, hash, type CommandResult } from '../storage.js';
import * as s from './schemas.js';
import { addCalendarDays, calendarPolicy, dateRange, dayBoundaries, isoWeekday, localDate } from './calendar.js';
import { aggregateAdherenceRange } from './aggregates.js';
import { replayAdherence } from './adherence.js';
import { assertMetricReview } from './metrics.js';
import type { ActivityCalendar, ActivityDependencies, ActivityEntry, ActivityItem, ActivityOperation, ActivityPlanSnapshot,
  PersonalExercise, PlanDaySnapshot, ScheduleRevision, ActivityPlanItem } from './types.js';

type Row = { data: string };
type AggregateTable = 'activity_exercises' | 'activity_plans' | 'activity_entries';
type HistoryTable = 'activity_exercise_revisions' | 'activity_plan_revisions' | 'activity_entry_revisions';
const historyKeys = { activity_exercise_revisions: 'exercise_id', activity_plan_revisions: 'plan_id', activity_entry_revisions: 'entry_id' } as const;
const parseRow = <T>(row: Row): T => JSON.parse(row.data) as T;
const sameRef = (a: s.ExerciseRef, b: s.ExerciseRef) => canonical(a) === canonical(b);
export class ActivityService {
  readonly deps: ActivityDependencies;
  constructor(deps: ActivityDependencies) {
    if (!deps.lifecycle?.assertActive || !deps.lifecycle.withActiveWrite || !deps.lifecycle.adultEligibility ||
      !deps.assertPersistable || !deps.lifecycleControl?.assertSuppression || !deps.lifecycleControl.purgeReadiness)
      throw new DomainError(503, 'activity_bindings_required');
    this.deps = deps;
  }
  now(): string { return (this.deps.now?.() ?? new Date()).toISOString(); }
  assertActive(context: AccountContext): void {
    this.deps.lifecycle.assertActive(context);
  }
  read<T>(context: AccountContext, effect: () => T): T {
    this.assertActive(context);
    const work = () => { this.assertActive(context); const value = effect(); this.assertActive(context); return value; };
    const value = this.deps.db.inTransaction ? work() : this.deps.db.transaction(work).deferred();
    this.assertActive(context);
    return value;
  }
  private decode<T>(schema: z.ZodType<T>, input: unknown): T {
    // Strict schema rejection precedes canonicalization, hashing, receipt lookup and all source writes.
    const result = schema.safeParse(input);
    if (!result.success) throw new DomainError(422, 'invalid_request', 'Review the submitted Activity fields.');
    if (Buffer.byteLength(JSON.stringify(result.data), 'utf8') > 64 * 1024) throw new DomainError(413, 'body_too_large');
    return result.data;
  }
  private command<T>(context: AccountContext, operation: ActivityOperation, key: string | undefined, schema: z.ZodType<T>, input: unknown,
    authorize: (input: T) => void, effect: (input: T) => CommandResult, target?: string): CommandResult {
    this.assertActive(context);
    const validated = this.decode(schema, input);
    this.deps.assertPersistable(context, operation, validated);
    this.assertActive(context);
    if (!key || !/^[A-Za-z0-9_.:-]{1,128}$/.test(key)) throw new DomainError(400, 'idempotency_key_required');
    return this.deps.lifecycle.withActiveWrite(context, () => {
      if (!this.deps.db.inTransaction) throw new DomainError(503, 'activity_writer_boundary_required');
      this.assertActive(context);
      this.deps.assertPersistable(context, operation, validated);
      authorize(validated); this.assertActive(context);
      const intent = target === undefined ? validated : { target, input: validated };
      const fingerprint = hash(canonical(intent));
      const receipt = this.deps.db.prepare('SELECT intent_hash,status,result FROM command_receipts WHERE account_id=? AND operation=? AND key=?')
        .get(context.accountId, `activity.${operation}`, key) as { intent_hash: string; status: 200 | 201; result: string } | undefined;
      if (receipt) {
        if (receipt.intent_hash !== fingerprint) throw new DomainError(409, 'idempotency_mismatch');
        this.assertActive(context);
        return { status: receipt.status, body: JSON.parse(receipt.result) as unknown };
      }
      const result = effect(validated);
      this.assertActive(context);
      this.deps.db.prepare('INSERT INTO command_receipts(account_id,operation,key,intent_hash,status,result,created_at) VALUES (?,?,?,?,?,?,?)')
        .run(context.accountId, `activity.${operation}`, key, fingerprint, result.status, JSON.stringify(result.body), this.now());
      this.deps.db.prepare('INSERT INTO activity_state(account_id,generation) VALUES (?,1) ON CONFLICT(account_id) DO UPDATE SET generation=generation+1')
        .run(context.accountId);
      this.assertActive(context);
      return result;
    });
  }
  private aggregate<T>(table: AggregateTable, accountId: string, id: string): T {
    s.resourceId.parse(id);
    const row = this.deps.db.prepare(`SELECT data FROM ${table} WHERE account_id=? AND id=?`).get(accountId, id) as Row | undefined;
    if (!row) notFound();
    return parseRow<T>(row);
  }
  private history<T>(table: HistoryTable, accountId: string, id: string): T[] {
    return (this.deps.db.prepare(`SELECT data FROM ${table} WHERE account_id=? AND ${historyKeys[table]}=? ORDER BY revision`)
      .all(accountId, id) as Row[]).map(row => parseRow<T>(row));
  }
  private page<T>(context: AccountContext, operation: string, values: T[], input: unknown) {
    const query = this.decode(s.listQuery, input);
    let offset = 0;
    if (query.cursor) {
      try {
        const parsed = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8')) as { operation?: unknown; account?: unknown; offset?: unknown };
        if (parsed.operation !== operation || parsed.account !== hash(context.accountId) || typeof parsed.offset !== 'number' ||
          !Number.isSafeInteger(parsed.offset) || parsed.offset < 0) throw new Error('cursor');
        offset = parsed.offset;
      } catch { throw new DomainError(422, 'invalid_activity_cursor'); }
    }
    const items = values.slice(offset, offset + query.limit);
    return { items, nextCursor: offset + query.limit < values.length ? Buffer.from(JSON.stringify({ operation, account: hash(context.accountId),
      offset: offset + query.limit })).toString('base64url') : null };
  }
  private calendarFor(accountId: string): ActivityCalendar | null {
    const row = this.deps.db.prepare('SELECT data FROM activity_calendar WHERE account_id=?').get(accountId) as Row | undefined;
    return row ? parseRow<ActivityCalendar>(row) : null;
  }
  private requireCalendar(accountId: string): ActivityCalendar {
    const value = this.calendarFor(accountId);
    if (!value) throw new DomainError(409, 'activity_calendar_required');
    return value;
  }
  calendar(context: AccountContext) { return this.read(context, () => this.calendarFor(context.accountId)); }
  capabilities(context: AccountContext) { return this.read(context, () => ({ sourceStatus: 'candidate_unverified', migrationVersion: 8,
    calendar: this.calendarFor(context.accountId) ? 'configured' : 'not_configured', calendarPolicy,
    legacyEvidence: this.deps.legacy ? 'bound_unverified' : 'unavailable', parser: 'client_only', transcriptUpload: false })); }
  createCalendar(context: AccountContext, key: string | undefined, input: unknown): CommandResult {
    return this.command(context, 'calendar.create', key, s.calendarCreate, input, () => {}, value => {
      const existing = this.calendarFor(context.accountId);
      if (existing) {
        if (existing.timeZone !== value.timeZone) throw new DomainError(409, 'activity_calendar_fixed');
        return { status: 200, body: existing };
      }
      const createdAt = this.now(), date = localDate(createdAt, value.timeZone);
      dayBoundaries(date, value.timeZone);
      const calendar: ActivityCalendar = { timeZone: value.timeZone, activationDate: date, revision: 1, calendarPolicy, createdAt };
      this.deps.db.prepare('INSERT INTO activity_calendar(account_id,revision,time_zone,activation_date,data) VALUES (?,1,?,?,?)')
        .run(context.accountId, calendar.timeZone, date, JSON.stringify(calendar));
      return { status: 201, body: calendar };
    });
  }
  exercise(context: AccountContext, id: string): PersonalExercise {
    return this.read(context, () => this.aggregate<PersonalExercise>('activity_exercises', context.accountId, id));
  }
  exercises(context: AccountContext, input: unknown = {}) {
    return this.read(context, () => {
      const query = this.decode(s.listQuery, input);
      const rows = this.deps.db.prepare('SELECT data FROM activity_exercises WHERE account_id=? AND (?=1 OR retired=0) ORDER BY id')
        .all(context.accountId, query.retired === 'true' ? 1 : 0) as Row[];
      return this.page(context, 'exercises', rows.map(x => parseRow<PersonalExercise>(x)), query);
    });
  }
  createExercise(context: AccountContext, key: string | undefined, input: unknown): CommandResult {
    return this.command(context, 'exercise.create', key, s.personalExerciseFields, input, () => {}, fields => {
      const now = this.now();
      const value: PersonalExercise = { ...fields, id: randomUUID(), revision: 1, retired: false, createdAt: now, updatedAt: now };
      this.deps.db.prepare('INSERT INTO activity_exercises(account_id,id,revision,retired,data) VALUES (?,?,1,0,?)').run(context.accountId, value.id, JSON.stringify(value));
      this.deps.db.prepare('INSERT INTO activity_exercise_revisions(account_id,exercise_id,revision,data) VALUES (?,?,1,?)').run(context.accountId, value.id, JSON.stringify(value));
      return { status: 201, body: value };
    });
  }
  patchExercise(context: AccountContext, id: string, key: string | undefined, input: unknown): CommandResult {
    return this.command(context, 'exercise.patch', key, s.personalExerciseFields.extend({ expectedRevision: s.expectedRevision }).strict(), input,
      () => { this.aggregate('activity_exercises', context.accountId, id); }, value => {
        const current = this.aggregate<PersonalExercise>('activity_exercises', context.accountId, id); revision(current.revision, value.expectedRevision);
        if (current.retired) throw new DomainError(409, 'exercise_retired');
        const { expectedRevision: _, ...fields } = value;
        const next: PersonalExercise = { ...current, ...fields, revision: current.revision + 1, updatedAt: this.now() };
        this.writeExercise(context.accountId, next); return { status: 200, body: next };
      }, id);
  }
  retireExercise(context: AccountContext, id: string, key: string | undefined, input: unknown): CommandResult {
    return this.command(context, 'exercise.retire', key, s.revisionCommand, input, () => { this.aggregate('activity_exercises', context.accountId, id); }, value => {
      const current = this.aggregate<PersonalExercise>('activity_exercises', context.accountId, id); revision(current.revision, value.expectedRevision);
      const next = current.retired ? current : { ...current, retired: true, revision: current.revision + 1, updatedAt: this.now() };
      if (!current.retired) this.writeExercise(context.accountId, next);
      return { status: 200, body: next };
    }, id);
  }
  private writeExercise(accountId: string, next: PersonalExercise): void {
    this.deps.db.prepare('UPDATE activity_exercises SET revision=?,retired=?,data=? WHERE account_id=? AND id=?')
      .run(next.revision, Number(next.retired), JSON.stringify(next), accountId, next.id);
    this.deps.db.prepare('INSERT INTO activity_exercise_revisions(account_id,exercise_id,revision,data) VALUES (?,?,?,?)')
      .run(accountId, next.id, next.revision, JSON.stringify(next));
  }
  private authorizeRef(accountId: string, ref: s.ExerciseRef): void {
    if (ref.source === 'personal') {
      this.aggregate('activity_exercises', accountId, ref.id);
      if (!this.deps.db.prepare('SELECT 1 FROM activity_exercise_revisions WHERE account_id=? AND exercise_id=? AND revision=?').get(accountId, ref.id, ref.revision)) notFound();
    } else if (!this.deps.db.prepare('SELECT 1 FROM exercises WHERE id=?').get(ref.id)) notFound();
  }
  private resolveExercise(accountId: string, ref: s.ExerciseRef): s.ExerciseSnapshot {
    this.authorizeRef(accountId, ref);
    if (ref.source === 'personal') {
      const value = this.aggregate<PersonalExercise>('activity_exercises', accountId, ref.id);
      if (value.retired) throw new DomainError(422, 'exercise_retired');
      revision(value.revision, ref.revision);
      const { name, description, movement, measurementType, kind, loadApplicability, loadLabel } = value;
      return { ref, name, description, movement, measurementType, kind, loadApplicability, loadLabel,
        guidance: 'userDefinedUnassessed', cueStatus: 'unknown', safetyAssessment: 'notEstablished' };
    }
    const row = this.deps.db.prepare('SELECT data,retired FROM exercises WHERE id=?').get(ref.id) as Row & { retired: number };
    if (row.retired) throw new DomainError(422, 'exercise_retired');
    const kind = this.deps.globalExerciseKind?.(ref.id) ?? (['goblet-squat', 'floor-press', 'supported-row', 'dumbbell-hinge', 'calf-raise'].includes(ref.id) ? 'resistance' : null);
    if (!kind) throw new DomainError(503, 'activity_global_exercise_mapping_required');
    const data = JSON.parse(row.data) as { name: string; description?: string; movement?: string; loadLabel?: string; cues?: unknown[] };
    return s.exerciseSnapshot.parse({ ref, name: data.name, description: data.description ?? '', movement: data.movement ?? null,
      measurementType: 'unspecified', kind, loadApplicability: 'unspecified', loadLabel: data.loadLabel ?? null,
      guidance: 'globalReference', cueStatus: data.cues?.length ? 'globalReference' : 'unknown', safetyAssessment: 'notEstablished' });
  }
  catalog(context: AccountContext) {
    return this.read(context, () => {
      const global = (this.deps.db.prepare('SELECT id FROM exercises WHERE retired=0 ORDER BY id').all() as { id: string }[])
        .map(x => this.resolveExercise(context.accountId, { source: 'global', id: x.id }));
      const personal = (this.deps.db.prepare('SELECT id,revision FROM activity_exercises WHERE account_id=? AND retired=0 ORDER BY id')
        .all(context.accountId) as { id: string; revision: number }[]).map(x => this.resolveExercise(context.accountId, { source: 'personal', id: x.id, revision: x.revision }));
      return { items: [...global, ...personal], selectionUses: ['manual', 'nativeSpeech', 'activityPlan', 'recommendationChoice'] as const };
    });
  }
  private resolveItems(accountId: string, inputs: s.ActivityItemInput[], histories: readonly { items: ActivityItem[] }[], previous: readonly ActivityItem[],
    performance: boolean, acknowledgements: readonly { fieldPath: string; code: string }[] = []): ActivityItem[] {
    return inputs.map((input, i) => {
      const historical = histories.flatMap(x => x.items).filter(x => x.id === input.id);
      if (historical.some(x => !sameRef(x.exercise, input.exercise))) throw new DomainError(409, 'item_identity_conflict');
      for (const set of input.sets ?? []) if (histories.some(h => h.items.some(item => item.id !== input.id && item.sets?.some(x => x.id === set.id))))
        throw new DomainError(409, 'set_identity_conflict');
      const old = previous.find(x => x.id === input.id);
      const snapshot = old && sameRef(old.exercise, input.exercise) ? old.snapshot : this.resolveExercise(accountId, input.exercise);
      if (performance && snapshot.kind === 'run' && (input.durationSeconds === undefined || input.load.state !== 'notApplicable' || input.load.reason !== 'timedActivity'))
        throw new DomainError(422, 'run_duration_and_load_required');
      if (performance) assertMetricReview(input, `items[${i}]`, acknowledgements);
      return { ...input, snapshot };
    });
  }
  private resolvePlanItems(accountId: string, inputs: s.ActivityPlanItemInput[], histories: readonly ActivityPlanSnapshot[], previous: readonly ActivityPlanItem[]): ActivityPlanItem[] {
    return inputs.map(input => {
      if (histories.some(value => value.items.some(item => item.id === input.id && !sameRef(item.exercise, input.exercise))))
        throw new DomainError(409, 'item_identity_conflict');
      const old = previous.find(item => item.id === input.id);
      const snapshot = old && sameRef(old.exercise, input.exercise) ? old.snapshot : this.resolveExercise(accountId, input.exercise);
      return { ...input, snapshot };
    });
  }
  plan(context: AccountContext, id: string): ActivityPlanSnapshot { return this.read(context, () => this.aggregate('activity_plans', context.accountId, id)); }
  plans(context: AccountContext, input: unknown = {}) {
    return this.read(context, () => this.page(context, 'plans', (this.deps.db.prepare('SELECT data FROM activity_plans WHERE account_id=? ORDER BY id')
      .all(context.accountId) as Row[]).map(x => parseRow<ActivityPlanSnapshot>(x)), input));
  }
  createPlan(context: AccountContext, key: string | undefined, input: unknown): CommandResult {
    return this.command(context, 'plan.create', key, s.planFields, input, value => { value.items.forEach(x => this.authorizeRef(context.accountId, x.exercise)); }, value => {
      const now = this.now();
      const plan: ActivityPlanSnapshot = { id: randomUUID(), revision: 1, name: value.name, minutes: value.minutes,
        items: this.resolvePlanItems(context.accountId, value.items, [], []), archived: false, origin: { kind: 'manual' }, createdAt: now, updatedAt: now };
      this.insertPlan(context.accountId, plan); return { status: 201, body: plan };
    });
  }
  private insertPlan(accountId: string, value: ActivityPlanSnapshot): void {
    this.deps.db.prepare('INSERT INTO activity_plans(account_id,id,revision,archived,legacy_plan_id,legacy_plan_revision,data) VALUES (?,?,?,0,?,?,?)')
      .run(accountId, value.id, value.revision, value.origin.kind === 'legacyPlan' ? value.origin.id : null,
        value.origin.kind === 'legacyPlan' ? value.origin.revision : null, JSON.stringify(value));
    this.deps.db.prepare('INSERT INTO activity_plan_revisions(account_id,plan_id,revision,data) VALUES (?,?,?,?)').run(accountId, value.id, value.revision, JSON.stringify(value));
  }
  private writePlan(accountId: string, value: ActivityPlanSnapshot): void {
    this.deps.db.prepare('UPDATE activity_plans SET revision=?,archived=?,data=? WHERE account_id=? AND id=?')
      .run(value.revision, Number(value.archived), JSON.stringify(value), accountId, value.id);
    this.deps.db.prepare('INSERT INTO activity_plan_revisions(account_id,plan_id,revision,data) VALUES (?,?,?,?)')
      .run(accountId, value.id, value.revision, JSON.stringify(value));
  }
  patchPlan(context: AccountContext, id: string, key: string | undefined, input: unknown): CommandResult {
    return this.command(context, 'plan.patch', key, s.planPatch, input, value => {
      this.aggregate('activity_plans', context.accountId, id); value.items.forEach(x => this.authorizeRef(context.accountId, x.exercise));
    }, value => {
      const current = this.aggregate<ActivityPlanSnapshot>('activity_plans', context.accountId, id); revision(current.revision, value.expectedRevision);
      if (current.archived) throw new DomainError(409, 'plan_archived');
      const next = { ...current, name: value.name, minutes: value.minutes, items: this.resolvePlanItems(context.accountId, value.items,
        this.history<ActivityPlanSnapshot>('activity_plan_revisions', context.accountId, id), current.items), revision: current.revision + 1, updatedAt: this.now() };
      this.writePlan(context.accountId, next); return { status: 200, body: next };
    }, id);
  }
  archivePlan(context: AccountContext, id: string, key: string | undefined, input: unknown): CommandResult {
    return this.command(context, 'plan.archive', key, s.revisionCommand, input, () => { this.aggregate('activity_plans', context.accountId, id); }, value => {
      const current = this.aggregate<ActivityPlanSnapshot>('activity_plans', context.accountId, id); revision(current.revision, value.expectedRevision);
      const next = current.archived ? current : { ...current, archived: true, revision: current.revision + 1, updatedAt: this.now() };
      if (!current.archived) this.writePlan(context.accountId, next);
      return { status: 200, body: next };
    }, id);
  }
  importLegacyPlan(context: AccountContext, key: string | undefined, input: unknown): CommandResult {
    return this.command(context, 'plan.importLegacy', key, s.legacyImport, input, value => {
      if (!this.deps.legacy) throw new DomainError(503, 'activity_legacy_unavailable');
      const origin = this.deps.legacy.readPlanRevision(context.accountId, value.planId, value.revision);
      if (!origin) notFound();
      this.deps.assertPersistable(context, 'plan.importLegacy', { origin: value, legacySnapshot: origin });
    }, value => {
      const received = this.deps.legacy!.readPlanRevision(context.accountId, value.planId, value.revision);
      const original = received ? this.decode(s.legacyPlanSnapshot, received) : null;
      if (!original || original.id !== value.planId || original.revision !== value.revision) notFound();
      const existing = this.deps.db.prepare('SELECT data FROM activity_plans WHERE account_id=? AND legacy_plan_id=? AND legacy_plan_revision=?')
        .get(context.accountId, value.planId, value.revision) as Row | undefined;
      if (existing) return { status: 200, body: parseRow<ActivityPlanSnapshot>(existing) };
      if (original.archived) throw new DomainError(409, 'plan_archived');
      const fields = this.decode(s.planFields, { name: original.name, minutes: original.minutes, items: original.items.map(item => ({ id: item.id,
        exercise: { source: 'global', id: item.exerciseId }, target: { setCount: item.setTarget, repMin: item.repMin, repMax: item.repMax,
        load: { state: 'knownValue', value: item.targetKg, unit: 'kg', basis: 'unspecified' } } })) });
      const now = this.now();
      const plan: ActivityPlanSnapshot = { id: randomUUID(), revision: 1, name: fields.name, minutes: fields.minutes,
        items: this.resolvePlanItems(context.accountId, fields.items, [], []), archived: false,
        origin: { kind: 'legacyPlan', id: value.planId, revision: value.revision }, legacySnapshot: original, createdAt: now, updatedAt: now };
      // Include the exact reviewed origin payload in the trusted no-save lineage check before retaining it.
      this.deps.assertPersistable(context, 'plan.importLegacy', { origin: value, legacySnapshot: original });
      this.insertPlan(context.accountId, plan); return { status: 201, body: plan };
    });
  }
  private resolvePlan(accountId: string, reference: { id: string; revision: number } | null, newSelection = false): ActivityPlanSnapshot | null {
    if (reference === null) return null;
    const current = this.aggregate<ActivityPlanSnapshot>('activity_plans', accountId, reference.id);
    if (newSelection && current.archived) throw new DomainError(422, 'plan_archived');
    const row = this.deps.db.prepare('SELECT data FROM activity_plan_revisions WHERE account_id=? AND plan_id=? AND revision=?')
      .get(accountId, reference.id, reference.revision) as Row | undefined;
    if (!row) notFound();
    return parseRow<ActivityPlanSnapshot>(row);
  }
  private scheduleRevisions(accountId: string): ScheduleRevision[] {
    return (this.deps.db.prepare('SELECT data FROM activity_schedule_revisions WHERE account_id=? ORDER BY effective_from,revision')
      .all(accountId) as Row[]).map(x => parseRow<ScheduleRevision>(x));
  }
  schedule(context: AccountContext) {
    return this.read(context, () => {
      const row = this.deps.db.prepare('SELECT data FROM activity_schedules WHERE account_id=?').get(context.accountId) as Row | undefined;
      return row ? parseRow<ScheduleRevision>(row) : null;
    });
  }
  writeSchedule(context: AccountContext, key: string | undefined, input: unknown): CommandResult {
    return this.command(context, 'schedule.write', key, s.scheduleWrite, input, value => {
      this.requireCalendar(context.accountId); value.week.forEach(x => this.resolvePlan(context.accountId, x.plan));
    }, value => {
      const calendar = this.requireCalendar(context.accountId), today = localDate(this.now(), calendar.timeZone);
      if (value.effectiveFrom < today) throw new DomainError(422, 'schedule_must_be_prospective');
      dayBoundaries(value.effectiveFrom, calendar.timeZone);
      const row = this.deps.db.prepare('SELECT data FROM activity_schedules WHERE account_id=?').get(context.accountId) as Row | undefined;
      const current = row ? parseRow<ScheduleRevision>(row) : null;
      revision(current?.revision ?? 0, value.expectedRevision);
      const next: ScheduleRevision = { id: current?.id ?? randomUUID(), revision: (current?.revision ?? 0) + 1,
        effectiveFrom: value.effectiveFrom, timeZone: calendar.timeZone,
        week: [...value.week].sort((a, b) => a.isoWeekday - b.isoWeekday).map(x => ({ isoWeekday: x.isoWeekday, expectation: x.expectation,
          planSnapshot: this.resolvePlan(context.accountId, x.plan, true) })), createdAt: this.now() };
      this.deps.db.prepare('INSERT INTO activity_schedules(account_id,id,revision,data) VALUES (?,?,?,?) ON CONFLICT(account_id) DO UPDATE SET revision=excluded.revision,data=excluded.data')
        .run(context.accountId, next.id, next.revision, JSON.stringify(next));
      this.deps.db.prepare('INSERT INTO activity_schedule_revisions(account_id,schedule_id,revision,effective_from,data) VALUES (?,?,?,?,?)')
        .run(context.accountId, next.id, next.revision, next.effectiveFrom, JSON.stringify(next));
      if (next.effectiveFrom === today) this.materializeDay(context.accountId, today, true);
      return { status: 201, body: next };
    });
  }
  private derivedDay(accountId: string, date: string, schedules: readonly ScheduleRevision[]): PlanDaySnapshot | null {
    const calendar = this.requireCalendar(accountId);
    const accepted = schedules.filter(x => x.effectiveFrom <= date).at(-1);
    if (!accepted) return null;
    const weekday = accepted.week.find(x => x.isoWeekday === isoWeekday(date));
    if (!weekday) throw new DomainError(503, 'activity_schedule_corrupt');
    return { localDate: date, revision: 1, timeZone: calendar.timeZone, ...dayBoundaries(date, calendar.timeZone), calendarPolicy,
      scheduleId: accepted.id, scheduleRevision: accepted.revision, expectation: weekday.expectation,
      planSnapshot: weekday.planSnapshot, origin: 'acceptedSchedule', supersedesRevision: null };
  }
  private dayFor(accountId: string, date: string, schedules = this.scheduleRevisions(accountId)): PlanDaySnapshot | null {
    const row = this.deps.db.prepare('SELECT data FROM activity_days WHERE account_id=? AND local_date=?').get(accountId, date) as Row | undefined;
    return row ? parseRow<PlanDaySnapshot>(row) : this.derivedDay(accountId, date, schedules);
  }
  private persistDay(accountId: string, next: PlanDaySnapshot): void {
    this.deps.db.prepare('INSERT INTO activity_days(account_id,local_date,revision,data) VALUES (?,?,?,?) ON CONFLICT(account_id,local_date) DO UPDATE SET revision=excluded.revision,data=excluded.data')
      .run(accountId, next.localDate, next.revision, JSON.stringify(next));
    this.deps.db.prepare('INSERT INTO activity_day_revisions(account_id,local_date,revision,data) VALUES (?,?,?,?)')
      .run(accountId, next.localDate, next.revision, JSON.stringify(next));
  }
  private materializeDay(accountId: string, date: string, refresh = false): void {
    const row = this.deps.db.prepare('SELECT data FROM activity_days WHERE account_id=? AND local_date=?').get(accountId, date) as Row | undefined;
    if (row && !refresh) return;
    const current = row ? parseRow<PlanDaySnapshot>(row) : null;
    if (current?.origin === 'explicitDayCorrection') return;
    const derived = this.derivedDay(accountId, date, this.scheduleRevisions(accountId));
    if (!derived || (current && current.scheduleRevision === derived.scheduleRevision)) return;
    this.persistDay(accountId, current ? { ...derived, revision: current.revision + 1, supersedesRevision: current.revision } : derived);
  }
  correctDay(context: AccountContext, date: string, key: string | undefined, input: unknown): CommandResult {
    s.civilDate.parse(date);
    return this.command(context, 'day.correct', key, s.dayCorrection, input, value => {
      this.requireCalendar(context.accountId); this.resolvePlan(context.accountId, value.plan);
    }, value => {
      const calendar = this.requireCalendar(context.accountId);
      if (date > localDate(this.now(), calendar.timeZone)) throw new DomainError(422, 'future_day_correction');
      const current = this.dayFor(context.accountId, date); revision(current?.revision ?? 0, value.expectedRevision);
      if (current && !this.deps.db.prepare('SELECT 1 FROM activity_days WHERE account_id=? AND local_date=?').get(context.accountId, date)) this.persistDay(context.accountId, current);
      const next: PlanDaySnapshot = { localDate: date, timeZone: calendar.timeZone, ...dayBoundaries(date, calendar.timeZone), calendarPolicy,
        revision: (current?.revision ?? 0) + 1, scheduleId: current?.scheduleId ?? null, scheduleRevision: current?.scheduleRevision ?? null,
        expectation: value.expectation, planSnapshot: this.resolvePlan(context.accountId, value.plan, true), origin: 'explicitDayCorrection',
        supersedesRevision: current?.revision ?? null };
      this.persistDay(context.accountId, next); return { status: 200, body: next };
    }, date);
  }
  private validateDate(accountId: string, value: s.ActivityWrite['date']): void {
    const calendar = this.requireCalendar(accountId);
    if (value.timeZone !== calendar.timeZone) throw new DomainError(422, 'activity_zone_mismatch');
    if (value.referenceLocalDate !== localDate(value.capturedAt, value.timeZone)) throw new DomainError(422, 'date_review_required');
    if (Date.parse(value.capturedAt) > Date.parse(this.now()) + 300000 && value.source !== 'selected') throw new DomainError(422, 'date_review_required');
    if (value.source === 'captureDefault' && value.localDate !== value.referenceLocalDate) throw new DomainError(422, 'date_review_required');
    if (value.source === 'spokenRelative' && value.localDate !== value.referenceLocalDate && value.localDate !== addCalendarDays(value.referenceLocalDate, -1))
      throw new DomainError(422, 'date_review_required');
    if (value.localDate > localDate(this.now(), calendar.timeZone)) throw new DomainError(422, 'future_activity_date');
    dayBoundaries(value.localDate, calendar.timeZone);
  }
  entry(context: AccountContext, id: string): ActivityEntry { return this.read(context, () => this.aggregate('activity_entries', context.accountId, id)); }
  entries(context: AccountContext, input: unknown) {
    return this.read(context, () => {
      const query = this.decode(s.entriesQuery, input); dateRange(query.from, query.to);
      const rows = this.deps.db.prepare('SELECT data FROM activity_entries WHERE account_id=? AND local_date>=? AND local_date<=? ORDER BY local_date,id')
        .all(context.accountId, query.from, query.to) as Row[];
      const { from, to, ...page } = query;
      return this.page(context, `entries:${from}:${to}`, rows.map(x => parseRow<ActivityEntry>(x)), page);
    });
  }
  createEntry(context: AccountContext, key: string | undefined, input: unknown): CommandResult {
    return this.command(context, 'entry.create', key, s.activityWrite, input, value => {
      this.requireCalendar(context.accountId); value.items.forEach(x => this.authorizeRef(context.accountId, x.exercise));
    }, value => {
      const fingerprint = hash(canonical(value));
      const draft = this.deps.db.prepare('SELECT id,draft_intent_hash FROM activity_entries WHERE account_id=? AND draft_id=?')
        .get(context.accountId, value.draftId) as { id: string; draft_intent_hash: string } | undefined;
      if (draft) {
        if (draft.draft_intent_hash !== fingerprint) throw new DomainError(409, 'draft_identity_conflict');
        const original = this.deps.db.prepare('SELECT data FROM activity_entry_revisions WHERE account_id=? AND entry_id=? AND revision=1').get(context.accountId, draft.id) as Row;
        return { status: 200, body: parseRow<ActivityEntry>(original) };
      }
      this.validateDate(context.accountId, value.date);
      const now = this.now();
      const entry: ActivityEntry = { ...value, id: randomUUID(), revision: 1, status: 'recorded', createdAt: now, updatedAt: now,
        items: this.resolveItems(context.accountId, value.items, [], [], true, value.acknowledgedIssues) };
      this.deps.db.prepare('INSERT INTO activity_entries(account_id,id,draft_id,draft_intent_hash,revision,local_date,status,data) VALUES (?,?,?,?,1,?,?,?)')
        .run(context.accountId, entry.id, value.draftId, fingerprint, value.date.localDate, entry.status, JSON.stringify(entry));
      this.deps.db.prepare('INSERT INTO activity_entry_revisions(account_id,entry_id,revision,data) VALUES (?,?,1,?)')
        .run(context.accountId, entry.id, JSON.stringify(entry));
      this.materializeDay(context.accountId, value.date.localDate);
      return { status: 201, body: entry };
    });
  }
  private writeEntry(accountId: string, value: ActivityEntry): void {
    this.deps.db.prepare('UPDATE activity_entries SET revision=?,local_date=?,status=?,data=? WHERE account_id=? AND id=?')
      .run(value.revision, value.date.localDate, value.status, JSON.stringify(value), accountId, value.id);
    this.deps.db.prepare('INSERT INTO activity_entry_revisions(account_id,entry_id,revision,data) VALUES (?,?,?,?)')
      .run(accountId, value.id, value.revision, JSON.stringify(value));
  }
  patchEntry(context: AccountContext, id: string, key: string | undefined, input: unknown): CommandResult {
    return this.command(context, 'entry.patch', key, s.activityPatch, input, value => {
      this.aggregate('activity_entries', context.accountId, id); value.items.forEach(x => this.authorizeRef(context.accountId, x.exercise));
    }, value => {
      const current = this.aggregate<ActivityEntry>('activity_entries', context.accountId, id); revision(current.revision, value.expectedRevision);
      if (current.status === 'voided') throw new DomainError(409, 'activity_entry_voided');
      if (current.draftId !== value.draftId) throw new DomainError(409, 'draft_identity_conflict');
      this.validateDate(context.accountId, value.date);
      const { expectedRevision: _, ...fields } = value;
      const next: ActivityEntry = { ...current, ...fields, revision: current.revision + 1, updatedAt: this.now(),
        items: this.resolveItems(context.accountId, value.items, this.history<ActivityEntry>('activity_entry_revisions', context.accountId, id), current.items, true, value.acknowledgedIssues) };
      this.writeEntry(context.accountId, next);
      this.materializeDay(context.accountId, current.date.localDate); this.materializeDay(context.accountId, next.date.localDate);
      return { status: 200, body: next };
    }, id);
  }
  voidEntry(context: AccountContext, id: string, key: string | undefined, input: unknown): CommandResult {
    return this.command(context, 'entry.void', key, s.revisionCommand, input, () => { this.aggregate('activity_entries', context.accountId, id); }, value => {
      const current = this.aggregate<ActivityEntry>('activity_entries', context.accountId, id); revision(current.revision, value.expectedRevision);
      const next: ActivityEntry = current.status === 'voided' ? current : { ...current, status: 'voided', revision: current.revision + 1, updatedAt: this.now() };
      if (current.status !== 'voided') this.writeEntry(context.accountId, next);
      this.materializeDay(context.accountId, current.date.localDate);
      return { status: 200, body: next };
    }, id);
  }
  // Internal projection is account-scoped; Community obtains it only through its trusted context factory.
  projection(accountId: string, from: string, to: string) {
    dateRange(from, to);
    const calendar = this.requireCalendar(accountId), asOf = this.now(), today = localDate(asOf, calendar.timeZone);
    const schedules = this.scheduleRevisions(accountId);
    const storedDays = (this.deps.db.prepare('SELECT data FROM activity_days WHERE account_id=? ORDER BY local_date').all(accountId) as Row[])
      .map(row => parseRow<PlanDaySnapshot>(row));
    const dayMap = new Map(storedDays.map(x => [x.localDate, x]));
    const starts = [...schedules.map(x => x.effectiveFrom), ...storedDays.map(x => x.localDate)].filter(x => x <= today).sort();
    const coverageStart = starts[0] ?? null;
    const queryFrom = [from, coverageStart ?? from].sort()[0]!;
    const entries = (this.deps.db.prepare("SELECT data FROM activity_entries WHERE account_id=? AND status='recorded' AND local_date>=? AND local_date<=?")
      .all(accountId, queryFrom, today) as Row[]).map(x => parseRow<ActivityEntry>(x));
    const legacy = this.deps.legacy?.listCompletedEvidence(accountId, queryFrom, today, calendar.timeZone);
    const legacyDates = new Set((legacy ?? []).filter(x => x.hasConfirmedPerformance).map(x => s.civilDate.parse(x.localDate)));
    const byDate = new Map<string, ActivityEntry[]>();
    for (const entry of entries) byDate.set(entry.date.localDate, [...(byDate.get(entry.date.localDate) ?? []), entry]);
    const expectationFor = (date: string) => {
      const saved = dayMap.get(date);
      if (saved) return saved.expectation;
      const accepted = schedules.filter(x => x.effectiveFrom <= date).at(-1);
      return accepted?.week.find(x => x.isoWeekday === isoWeekday(date))?.expectation ?? null;
    };
    const replayDays = coverageStart ? dateRange(coverageStart, today, 3_000_000).map(date => ({ localDate: date,
      expectation: legacy === undefined && (byDate.get(date)?.length ?? 0) === 0 && expectationFor(date) !== 'rest' ? null : expectationFor(date),
      hasActivity: (byDate.get(date)?.length ?? 0) > 0 || legacyDates.has(date) })) : [];
    const replay = replayAdherence({ days: replayDays, timeZone: calendar.timeZone, asOf });
    const generation = (this.deps.db.prepare('SELECT generation FROM activity_state WHERE account_id=?').get(accountId) as { generation: number } | undefined)?.generation ?? 0;
    const dayOrdinal = Math.floor(Date.parse(`${today}T00:00:00Z`) / 86400000);
    const projectionRevision = generation + (legacy ?? []).reduce((sum, item) => sum + item.sessionRevision, 0) + dayOrdinal;
    if (!Number.isSafeInteger(projectionRevision) || projectionRevision < 0) throw new DomainError(503, 'activity_projection_revision_unavailable');
    const sourceGeneration = { activity: generation, projectionRevision, legacyAvailable: legacy !== undefined,
      legacy: (legacy ?? []).map(x => ({ sessionId: x.sessionId, revision: x.sessionRevision })) };
    return { calendar, replay, sourceGeneration, legacyDates, byDate,
      days: dateRange(from, to).map(date => ({ localDate: date,
        snapshot: dayMap.get(date) ?? this.derivedDay(accountId, date, schedules),
        boundaries: dayBoundaries(date, calendar.timeZone),
        adherence: replay.days.find(x => x.localDate === date) ?? null,
        entries: byDate.get(date) ?? [], legacyRecorded: legacyDates.has(date), legacyEvidence: (legacy ?? []).filter(x => x.localDate === date && x.hasConfirmedPerformance), legacyAvailable: legacy !== undefined })) };
  }
  rangeSummary(context: AccountContext, input: unknown) {
    return this.read(context, () => {
      const range = this.decode(s.rangeQuery, input), value = this.projection(context.accountId, range.from, range.to);
      const summary = aggregateAdherenceRange({ ...range, days: value.replay.days });
      return { ...summary, timeZone: value.calendar.timeZone, asOf: value.replay.asOf,
        currentPlanDays: value.replay.currentPlanDays, longestPlanDays: value.replay.longestPlanDays,
        policyVersion: value.replay.policyVersion, sourceGeneration: value.sourceGeneration };
    });
  }
  adherence(context: AccountContext, input: unknown) {
    return this.read(context, () => {
      const range = this.decode(s.rangeQuery, input), value = this.projection(context.accountId, range.from, range.to);
      const { allocations: _, days: __, ...totals } = value.replay;
      return { ...totals, days: value.days.map(day => ({ localDate: day.localDate, ...day.boundaries,
        timeZone: value.calendar.timeZone, revision: day.snapshot?.revision ?? 0,
        state: day.adherence?.state ?? 'unknownPlan', actual: day.adherence?.actual ?? 'unknown',
        currentPlanDays: day.adherence?.currentPlanDays ?? 0, longestPlanDays: day.adherence?.longestPlanDays ?? 0,
        planDay: day.snapshot })), sourceGeneration: value.sourceGeneration };
    });
  }
}
export function createActivityService(deps: ActivityDependencies): ActivityService { return new ActivityService(deps); }
