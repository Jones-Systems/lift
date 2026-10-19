import { confirmedCaptureKind, validateStoredConfirmedCapture, type StoredConfirmedCapture } from './integration/first-plan/confirmed-capture.js';
import { randomUUID } from 'node:crypto';
import { assertAccountActive, assertPrincipalActive } from './lifecycle/guards.js';
import type { Exercise } from './catalog.js';
import { DomainError, notFound, revision } from './errors.js';
import { planFields, planItem, sourcePrescriptionPlanFields, sourcePrescriptionItem, storedPlanFields, storedPlanRevisionFields, savedPlan, savedLegacyPlan, savedSourcePlan, savedPlanRevision, savedSet, sourcePerformance, sourceSetCreate, sourceSetPatch, setCreate, setPatch,
  type PlanFields, type PlanItem, type Preferences, type Profile, type PromoDefinition, type SourcePrescriptionPlanFields, type SourcePrescriptionItem, type SavedPlan, type SavedPlanRevision, type SavedSet, type SourceSetCreate, type SourceSetPatch } from './schemas.js';
import type { z } from 'zod';
import { assertSourceReportedLoadHistory, type SourceMigrationReceipt } from './integration/account-modules/migrations.js';
import { sourcePrescriptionMigration } from './source-prescription-migration.js';
import { canonical, hash, type Sqlite } from './storage.js';

type DocumentRow = { revision: number; data: string };
type PlanRow = DocumentRow & { id: string; archived: number; created_at: string; updated_at: string };
type SessionRow = { id: string; plan_id: string; plan_revision: number; revision: number; snapshot: string; status: 'active' | 'completed'; started_at: string; completed_at: string | null };
type SetRow = { id: string; occurrence_id: string; set_number: number; revision: number; reps: number | null; weight_kg: number | null; performance?: string | null; status: 'draft' | 'confirmed' | 'voided'; created_at: string; updated_at: string };
type SetInput = { occurrenceId: string; setNumber: number; reps: number; weightKg: number; status: 'draft' | 'confirmed'; expectedRevision: number };
type CuePreferences = { kept: string[]; rejected: string[]; order: string[]; replacementRequested: string[] };
type Onboarding = { step: string; answers: Partial<Profile>; preferences: Partial<Preferences>; status: 'draft' | 'completed'; completedAt: string | null };
type Patch<T> = { [K in keyof T]?: T[K] | undefined };
export const defaultPreferences: Preferences = { mascot: 'scholarly', animationStyle: 'short', appMode: 'basic', loadUnit: 'kg', heightUnit: 'cm', coachVoice: 'calm', communication: 'concise', trainingDaysPerWeek: 3, sessionMinutes: 35, equipment: [], remindersEnabled: false };
const now = () => new Date().toISOString();
const parsed = <T>(data: string): T => JSON.parse(data) as T;

function stored<T>(schema: z.ZodType<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) throw new DomainError(503, 'stored_training_data_invalid');
  return result.data;
}
function decoded(data: string): unknown {
  try { return JSON.parse(data) as unknown; }
  catch { throw new DomainError(503, 'stored_training_data_invalid'); }
}
const exerciseIdFor = (item: PlanItem | SourcePrescriptionItem): string =>
  'registeredDomain' in item ? item.registeredDomain.exerciseId : item.exerciseId;
export class Domain {
  private readonly sourcePrescriptionSelected: boolean;
  private readonly sourceReportedLoadSelected: boolean;
  constructor(public readonly db: Sqlite, capabilities: Readonly<{ sourcePrescription?: 'selected-migration-19'; sourceReportedLoad?: 'selected-migration-22' }> = {}) {
    this.sourceReportedLoadSelected = capabilities.sourceReportedLoad === 'selected-migration-22';
    this.sourcePrescriptionSelected = capabilities.sourcePrescription === 'selected-migration-19';
  }

  private requireSourcePrescription(): void {
    if (!this.sourcePrescriptionSelected) throw new DomainError(503, 'source_prescription_unavailable');
    if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='form_migrations'").get())
      throw new DomainError(503, 'source_prescription_unavailable');
    const row = this.db.prepare('SELECT checksum FROM form_migrations WHERE version=19').get() as { checksum: string } | undefined;
    if (row?.checksum !== hash(sourcePrescriptionMigration.sql)) throw new DomainError(503, 'source_prescription_unavailable');
  }

  private requireSourceReportedLoad(): void {
    if (!this.sourceReportedLoadSelected || !this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='form_migrations'").get())
      throw new DomainError(503, 'source_reported_load_unavailable');
    try {
      assertSourceReportedLoadHistory(this.db.prepare('SELECT version,checksum FROM form_migrations ORDER BY version').all() as SourceMigrationReceipt[], true);
    } catch { throw new DomainError(503, 'source_reported_load_unavailable'); }
  }

  account(authUserId: string, name: string): string {
    return this.db.transaction(() => {
      assertPrincipalActive(this.db, authUserId);
      const prior = this.db.prepare('SELECT id FROM form_accounts WHERE auth_user_id=?').get(authUserId) as { id: string } | undefined;
      if (prior) return prior.id;
      const id = randomUUID();
      this.db.prepare('INSERT INTO form_accounts VALUES (?,?,?)').run(id, authUserId, now());
      const profile: Profile = { name, age: null, heightCm: null, weightKg: null, trainingBackground: null, injuryHistory: '', goals: [] };
      this.createDocument(id, 'profile', profile);
      this.createDocument(id, 'preferences', defaultPreferences);
      this.createDocument(id, 'onboarding', { step: 'welcome', answers: {}, preferences: {}, status: 'draft', completedAt: null });
      return id;
    }).immediate();
  }

  private createDocument(accountId: string, kind: string, data: unknown): void {
    assertAccountActive(this.db, accountId);
    this.db.prepare('INSERT INTO documents VALUES (?,?,0,?)').run(accountId, kind, JSON.stringify(data));
    this.db.prepare('INSERT INTO document_revisions VALUES (?,?,0,?,?)').run(accountId, kind, JSON.stringify(data), now());
  }
  document<T extends object>(accountId: string, kind: string): T & { revision: number } {
    assertAccountActive(this.db, accountId);
    const row = this.db.prepare('SELECT revision,data FROM documents WHERE account_id=? AND kind=?').get(accountId, kind) as DocumentRow | undefined;
    if (!row) notFound();
    return { ...parsed<T>(row.data), revision: row.revision };
  }
  confirmedCapture(accountId: string): { revision: number; record: StoredConfirmedCapture } | null {
    assertAccountActive(this.db, accountId);
    const row = this.db.prepare('SELECT revision,data FROM documents WHERE account_id=? AND kind=?')
      .get(accountId, confirmedCaptureKind) as DocumentRow | undefined;
    if (!row) return null;
    const record = validateStoredConfirmedCapture(JSON.parse(row.data) as unknown);
    if (record.pin.accountId !== accountId || record.pin.revision !== String(row.revision))
      throw new DomainError(503, 'confirmed_capture_invalid_data');
    return { revision: row.revision, record };
  }

  replaceConfirmedCapture(accountId: string, expected: number | null, input: StoredConfirmedCapture): void {
    assertAccountActive(this.db, accountId);
    if (!this.db.inTransaction) throw new DomainError(503, 'confirmed_capture_transaction_required');
    const record = validateStoredConfirmedCapture(input);
    const current = this.confirmedCapture(accountId);
    if ((current?.revision ?? null) !== expected) throw new DomainError(409, 'stale_revision');
    if (record.pin.accountId !== accountId || record.pin.revision !== String((expected ?? -1) + 1) ||
      (current && record.pin.id !== current.record.pin.id)) throw new DomainError(400, 'capture_confirmation_invalid');
    if (expected === null) this.createDocument(accountId, confirmedCaptureKind, record);
    else this.writeDocument(accountId, confirmedCaptureKind, expected, record);
  }

  private writeDocument(accountId: string, kind: string, expected: number, data: unknown): void {
    assertAccountActive(this.db, accountId);
    const result = this.db.prepare('UPDATE documents SET data=?,revision=revision+1 WHERE account_id=? AND kind=? AND revision=?')
      .run(JSON.stringify(data), accountId, kind, expected);
    if (result.changes !== 1) throw new DomainError(409, 'stale_revision');
    this.db.prepare('INSERT INTO document_revisions VALUES (?,?,?,?,?)').run(accountId, kind, expected + 1, JSON.stringify(data), now());
  }
  patchDocument<T extends object>(accountId: string, kind: string, patch: Patch<T> & { expectedRevision: number }): T & { revision: number } {
    if (kind === confirmedCaptureKind) throw new DomainError(400, 'confirmed_capture_whole_record_required');
    assertAccountActive(this.db, accountId);
    return this.db.transaction(() => {
      assertAccountActive(this.db, accountId);
      const { revision: actual, ...current } = this.document<T>(accountId, kind);
      revision(actual, patch.expectedRevision);
      const { expectedRevision: _expected, ...changes } = patch;
      this.writeDocument(accountId, kind, actual, { ...current, ...changes });
      return this.document<T>(accountId, kind);
    }).immediate();
  }
  onboarding(accountId: string): Onboarding & { revision: number } {
    assertAccountActive(this.db, accountId); return this.document(accountId, 'onboarding'); }
  patchOnboarding(accountId: string, input: { expectedRevision: number; step: string; answers?: Patch<Profile> | undefined; preferences?: Patch<Preferences> | undefined }): Onboarding & { revision: number } {
    assertAccountActive(this.db, accountId);
    return this.db.transaction(() => {
      assertAccountActive(this.db, accountId);
      const { revision: actual, ...current } = this.onboarding(accountId);
      revision(actual, input.expectedRevision);
      if (current.status === 'completed') throw new DomainError(409, 'onboarding_completed');
      this.writeDocument(accountId, 'onboarding', actual, {
        ...current, step: input.step, answers: { ...current.answers, ...input.answers }, preferences: { ...current.preferences, ...input.preferences },
      });
      return this.onboarding(accountId);
    }).immediate();
  }
  completeOnboarding(accountId: string, expected: number): Onboarding & { revision: number } {
    assertAccountActive(this.db, accountId);
    const { revision: actual, ...current } = this.onboarding(accountId);
    revision(actual, expected);
    if (current.status === 'completed') throw new DomainError(409, 'onboarding_completed');
    const { revision: pr, ...profile } = this.document<Profile>(accountId, 'profile');
    const { revision: pf, ...preferences } = this.document<Preferences>(accountId, 'preferences');
    const merged = { ...profile, ...current.answers };
    if (!merged.name.trim()) throw new DomainError(422, 'onboarding_incomplete');
    this.writeDocument(accountId, 'profile', pr, merged);
    this.writeDocument(accountId, 'preferences', pf, { ...preferences, ...current.preferences });
    this.writeDocument(accountId, 'onboarding', actual, { ...current, step: 'review', status: 'completed', completedAt: now() });
    return this.onboarding(accountId);
  }
  exercises(): Exercise[] { return (this.db.prepare('SELECT data,retired FROM exercises ORDER BY id').all() as { data: string; retired: number }[]).map(x => ({ ...parsed<Exercise>(x.data), retired: !!x.retired })); }
  exercise(id: string): Exercise {
    const row = this.db.prepare('SELECT data,retired FROM exercises WHERE id=?').get(id) as { data: string; retired: number } | undefined;
    if (!row) notFound(); return { ...parsed<Exercise>(row.data), retired: !!row.retired };
  }
  private validateItems(accountId: string, planId: string, items: (PlanItem | SourcePrescriptionItem)[]): void {
    assertAccountActive(this.db, accountId);
    for (const item of items) {
      const exercise = this.exercise(exerciseIdFor(item));
      if (exercise.retired) throw new DomainError(422, 'exercise_retired');
      const original = this.db.prepare('SELECT exercise_id FROM plan_item_ids WHERE account_id=? AND plan_id=? AND id=?').get(accountId, planId, item.id) as { exercise_id: string } | undefined;
      if (original && original.exercise_id !== exerciseIdFor(item)) throw new DomainError(409, 'item_identity_conflict');
    }
  }
  private retainItems(accountId: string, planId: string, items: (PlanItem | SourcePrescriptionItem)[]): void {
    assertAccountActive(this.db, accountId);
    for (const item of items) this.db.prepare('INSERT INTO plan_item_ids VALUES (?,?,?,?) ON CONFLICT DO NOTHING').run(accountId, planId, item.id, exerciseIdFor(item));
  }
  plan(accountId: string, id: string): SavedPlan {
    assertAccountActive(this.db, accountId);
    const row = this.db.prepare('SELECT * FROM plans WHERE account_id=? AND id=?').get(accountId, id) as PlanRow | undefined;
    if (!row) notFound();
    return stored(savedPlan, { ...stored(storedPlanFields, decoded(row.data)), id: row.id, revision: row.revision, archived: !!row.archived, createdAt: row.created_at, updatedAt: row.updated_at });
  }
  planRevision(accountId: string, planId: string, expected: number): SavedPlanRevision {
    assertAccountActive(this.db, accountId);
    const row = this.db.prepare('SELECT data FROM plan_revisions WHERE account_id=? AND plan_id=? AND revision=?')
      .get(accountId, planId, expected) as { data: string } | undefined;
    if (!row) notFound();
    const value = stored(storedPlanRevisionFields, decoded(row.data));
    const plan = stored(savedPlanRevision, { ...value, id: planId, revision: expected });
    for (const item of plan.items) {
      const mapping = this.db.prepare('SELECT i.exercise_id FROM plan_item_ids i JOIN exercises e ON e.id=i.exercise_id WHERE i.account_id=? AND i.plan_id=? AND i.id=?')
        .get(accountId, planId, item.id) as { exercise_id: string } | undefined;
      if (mapping?.exercise_id !== exerciseIdFor(item)) throw new DomainError(503, 'stored_training_data_invalid');
    }
    return plan;
  }
  plans(accountId: string) {
    assertAccountActive(this.db, accountId);
    return (this.db.prepare('SELECT id FROM plans WHERE account_id=? ORDER BY created_at,id').all(accountId) as { id: string }[]).map(x => this.plan(accountId, x.id));
  }
  plansPage(accountId: string, limit: number) {
    assertAccountActive(this.db, accountId);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw new DomainError(422, 'invalid_plan_limit');
    const rows = this.db.prepare('SELECT id FROM plans WHERE account_id=? ORDER BY created_at,id LIMIT ?')
      .all(accountId, limit + 1) as { id: string }[];
    return { items: rows.slice(0, limit).map(row => this.plan(accountId, row.id)), hasMore: rows.length > limit };
  }
  createPlan(accountId: string, input: PlanFields) {
    assertAccountActive(this.db, accountId);
    input = planFields.parse(input);
    const id = randomUUID(), date = now(); this.validateItems(accountId, id, input.items);
    this.db.prepare('INSERT INTO plans VALUES (?,?,1,0,?,?,?)').run(accountId, id, JSON.stringify(input), date, date);
    this.db.prepare('INSERT INTO plan_revisions VALUES (?,?,1,?,?)').run(accountId, id, JSON.stringify({ ...input, archived: false }), date);
    this.retainItems(accountId, id, input.items); return stored(savedLegacyPlan, this.plan(accountId, id));
  }
  createSourcePlan(accountId: string, input: SourcePrescriptionPlanFields) {
    assertAccountActive(this.db, accountId); this.requireSourcePrescription();
    const value = sourcePrescriptionPlanFields.parse(input);
    return this.db.transaction(() => {
      assertAccountActive(this.db, accountId); this.requireSourcePrescription();
      const id = randomUUID(), date = now(); this.validateItems(accountId, id, value.items);
      this.db.prepare('INSERT INTO plans VALUES (?,?,1,0,?,?,?)').run(accountId, id, JSON.stringify(value), date, date);
      this.db.prepare('INSERT INTO plan_revisions VALUES (?,?,1,?,?)').run(accountId, id, JSON.stringify({ ...value, archived: false }), date);
      this.retainItems(accountId, id, value.items); return stored(savedSourcePlan, this.plan(accountId, id));
    }).immediate();
  }
  patchPlan(accountId: string, id: string, patch: Patch<PlanFields> & { expectedRevision: number }) {
    assertAccountActive(this.db, accountId);
    return this.db.transaction(() => {
      assertAccountActive(this.db, accountId);
      const current = this.plan(accountId, id); revision(current.revision, patch.expectedRevision);
      if ('schema' in current) throw new DomainError(409, 'source_plan_legacy_edit_denied');
      if (current.archived) throw new DomainError(409, 'plan_archived');
      const next: PlanFields = { name: patch.name ?? current.name, minutes: patch.minutes ?? current.minutes, items: patch.items ?? current.items };
      this.validateItems(accountId, id, next.items);
      this.db.prepare('UPDATE plans SET data=?,revision=revision+1,updated_at=? WHERE account_id=? AND id=? AND revision=?')
        .run(JSON.stringify(next), now(), accountId, id, current.revision);
      this.db.prepare('INSERT INTO plan_revisions VALUES (?,?,?,?,?)').run(accountId, id, current.revision + 1, JSON.stringify({ ...next, archived: false }), now());
      this.retainItems(accountId, id, next.items); return this.plan(accountId, id);
    }).immediate();
  }
  archivePlan(accountId: string, id: string, expected: number) {
    assertAccountActive(this.db, accountId);
    const current = this.plan(accountId, id); revision(current.revision, expected);
    if ('schema' in current) this.requireSourcePrescription();
    if (current.archived) throw new DomainError(409, 'plan_archived');
    this.db.prepare('UPDATE plans SET archived=1,revision=revision+1,updated_at=? WHERE account_id=? AND id=?').run(now(), accountId, id);
    this.db.prepare('INSERT INTO plan_revisions VALUES (?,?,?,?,?)')
      .run(accountId, id, current.revision + 1, JSON.stringify({ ...stored(storedPlanFields, 'schema' in current
        ? { schema: current.schema, name: current.name, origin: current.origin, duration: current.duration, items: current.items }
        : { name: current.name, minutes: current.minutes, items: current.items }), archived: true }), now());
    return this.plan(accountId, id);
  }
  startSession(accountId: string, planId: string, expected: number) {
    assertAccountActive(this.db, accountId);
    const plan = this.plan(accountId, planId); revision(plan.revision, expected);
    if ('schema' in plan) this.requireSourcePrescription();
    if (plan.archived) throw new DomainError(409, 'plan_archived');
    const id = randomUUID();
    this.db.prepare('INSERT INTO workout_sessions VALUES (?,?,?,?,1,?,\'active\',?,NULL)')
      .run(accountId, id, planId, plan.revision, JSON.stringify(plan), now());
    plan.items.forEach((item, position) => this.db.prepare('INSERT INTO session_occurrences VALUES (?,?,?,?,?,?,?)')
      .run(accountId, id, randomUUID(), item.id, exerciseIdFor(item), position, JSON.stringify(item)));
    return this.session(accountId, id);
  }
  private sessionRow(accountId: string, id: string): SessionRow {
    assertAccountActive(this.db, accountId);
    const row = this.db.prepare('SELECT * FROM workout_sessions WHERE account_id=? AND id=?').get(accountId, id) as SessionRow | undefined;
    if (!row) notFound(); return row;
  }
  session(accountId: string, id: string) {
    assertAccountActive(this.db, accountId);
    const row = this.sessionRow(accountId, id);
    const occurrences = this.db.prepare('SELECT * FROM session_occurrences WHERE account_id=? AND session_id=? ORDER BY position')
      .all(accountId, id) as { id: string; item_id: string; exercise_id: string; position: number; target: string }[];
    const sets = this.db.prepare('SELECT * FROM performed_sets WHERE account_id=? AND session_id=? ORDER BY created_at,id').all(accountId, id) as SetRow[];
    const snapshot = stored(savedPlan, decoded(row.snapshot));
    if (snapshot.id !== row.plan_id || snapshot.revision !== row.plan_revision) throw new DomainError(503, 'stored_training_data_invalid');
    const targets = occurrences.map(x => ({ id: x.id, itemId: x.item_id, exerciseId: x.exercise_id, position: x.position, target: this.occurrenceTarget(snapshot, x) }));
    const performance = sets.map(x => this.presentSet(x));
    if (targets.length !== snapshot.items.length || targets.some((target, index) => target.position !== index || target.itemId !== snapshot.items[index]!.id))
      throw new DomainError(503, 'stored_training_data_invalid');
    for (const set of performance) {
      const target = targets.find(item => item.id === set.occurrenceId)?.target;
      if (!target || ('registeredDomain' in target) !== ('schema' in set) ||
          ('registeredDomain' in target && 'schema' in set && set.performance.kind !== (target.native.rep_range === undefined ? 'controlled-practice' : 'repetitions')))
        throw new DomainError(503, 'stored_training_data_invalid');
    }
    return {
      id: row.id, planId: row.plan_id, planRevision: row.plan_revision, revision: row.revision, status: row.status,
      planSnapshot: snapshot, startedAt: row.started_at, completedAt: row.completed_at,
      occurrences: targets,
      sets: performance,
    };
  }
  private occurrenceTarget(snapshot: SavedPlan, row: { item_id: string; exercise_id: string; target: string }): PlanItem | SourcePrescriptionItem {
    const target = 'schema' in snapshot ? stored(sourcePrescriptionItem, decoded(row.target)) : stored(planItem, decoded(row.target));
    if (target.id !== row.item_id || exerciseIdFor(target) !== row.exercise_id ||
        !snapshot.items.some(item => item.id === target.id && canonical(item) === canonical(target)))
      throw new DomainError(503, 'stored_training_data_invalid');
    return target;
  }
  private presentSet(row: SetRow): SavedSet {
    const common = { id: row.id, occurrenceId: row.occurrence_id, setNumber: row.set_number, revision: row.revision,
      status: row.status, createdAt: row.created_at, updatedAt: row.updated_at };
    if (row.performance !== undefined && row.performance !== null) {
      if (row.reps !== null || row.weight_kg !== null) throw new DomainError(503, 'stored_training_data_invalid');
      const performance = stored(sourcePerformance, decoded(row.performance));
      return stored(savedSet, { ...common, schema: performance.schema === 'form.source-performance/v1'
        ? 'form.source-performed-set/v1' : 'form.source-performed-set/v2', performance });
    }
    return stored(savedSet, { ...common, reps: row.reps, weightKg: row.weight_kg });
  }
  set(accountId: string, sessionId: string, setId: string) {
    assertAccountActive(this.db, accountId);
    const set = this.session(accountId, sessionId).sets.find(value => value.id === setId);
    if (!set) notFound(); return set;
  }

  authorizeOccurrence(accountId: string, sessionId: string, occurrenceId: string): void {
    assertAccountActive(this.db, accountId);
    this.sessionRow(accountId, sessionId);
    if (!this.db.prepare('SELECT id FROM session_occurrences WHERE account_id=? AND session_id=? AND id=?').get(accountId, sessionId, occurrenceId)) notFound();
  }
  private matchPerformance(accountId: string, sessionId: string, occurrenceId: string, input: SetInput | SourceSetCreate | SourceSetPatch | { reps: number }): void {
    const session = this.session(accountId, sessionId), occurrence = session.occurrences.find(item => item.id === occurrenceId);
    if (!occurrence) notFound();
    const target = occurrence.target;
    if (('registeredDomain' in target) !== ('schema' in input)) throw new DomainError(409, 'set_format_mismatch');
    if ('registeredDomain' in target && 'schema' in input &&
        input.performance.kind !== (target.native.rep_range === undefined ? 'controlled-practice' : 'repetitions'))
      throw new DomainError(409, 'set_performance_kind_mismatch');
  }
  private setAudit(accountId: string, sessionId: string, setId: string): void {
    assertAccountActive(this.db, accountId);
    const set = this.set(accountId, sessionId, setId);
    this.db.prepare('INSERT INTO set_revisions VALUES (?,?,?,?,?,?)').run(accountId, sessionId, setId, set.revision, JSON.stringify(set), now());
  }
  createSet(accountId: string, sessionId: string, input: SetInput | SourceSetCreate) {
    assertAccountActive(this.db, accountId);
    input = 'schema' in input ? sourceSetCreate.parse(input) : setCreate.parse(input);
    if ('schema' in input) {
      this.requireSourcePrescription();
      if (input.schema === 'form.source-performed-set/v2') this.requireSourceReportedLoad();
    }
    const session = this.sessionRow(accountId, sessionId); revision(session.revision, input.expectedRevision);
    if (session.status !== 'active') throw new DomainError(409, 'session_completed');
    this.authorizeOccurrence(accountId, sessionId, input.occurrenceId);
    this.matchPerformance(accountId, sessionId, input.occurrenceId, input);
    if (this.db.prepare('SELECT id FROM performed_sets WHERE account_id=? AND session_id=? AND occurrence_id=? AND set_number=?')
      .get(accountId, sessionId, input.occurrenceId, input.setNumber)) throw new DomainError(409, 'set_number_exists');
    const id = randomUUID(), date = now();
    if ('schema' in input) this.db.prepare('INSERT INTO performed_sets (account_id,session_id,id,occurrence_id,set_number,revision,reps,weight_kg,status,created_at,updated_at,performance) VALUES (?,?,?,?,?,1,NULL,NULL,?,?,?,?)')
      .run(accountId, sessionId, id, input.occurrenceId, input.setNumber, input.status, date, date, JSON.stringify(input.performance));
    else this.db.prepare('INSERT INTO performed_sets (account_id,session_id,id,occurrence_id,set_number,revision,reps,weight_kg,status,created_at,updated_at) VALUES (?,?,?,?,?,1,?,?,?,?,?)')
      .run(accountId, sessionId, id, input.occurrenceId, input.setNumber, input.reps, input.weightKg, input.status, date, date);
    this.db.prepare('UPDATE workout_sessions SET revision=revision+1 WHERE account_id=? AND id=?').run(accountId, sessionId);
    this.setAudit(accountId, sessionId, id);
    return { set: this.set(accountId, sessionId, id), sessionRevision: session.revision + 1 };
  }
  patchSet(accountId: string, sessionId: string, setId: string, input: { expectedRevision: number; reps: number; weightKg: number; status: 'draft' | 'confirmed' } | SourceSetPatch) {
    assertAccountActive(this.db, accountId);
    return this.db.transaction(() => {
      assertAccountActive(this.db, accountId);
      input = 'schema' in input ? sourceSetPatch.parse(input) : setPatch.parse(input);
      if ('schema' in input) {
        this.requireSourcePrescription();
        if (input.schema === 'form.source-performed-set/v2') this.requireSourceReportedLoad();
      }
      const current = this.set(accountId, sessionId, setId); revision(current.revision, input.expectedRevision);
      if (('schema' in current) !== ('schema' in input)) throw new DomainError(409, 'set_format_mismatch');
      if ('schema' in current && current.schema === 'form.source-performed-set/v2' &&
          'schema' in input && input.schema !== current.schema) throw new DomainError(409, 'source_set_downgrade_denied');
      this.matchPerformance(accountId, sessionId, current.occurrenceId, input);
      if (current.status === 'voided') throw new DomainError(409, 'set_voided');
      if ('schema' in input) this.db.prepare('UPDATE performed_sets SET performance=?,status=?,revision=revision+1,updated_at=? WHERE account_id=? AND session_id=? AND id=?')
        .run(JSON.stringify(input.performance), input.status, now(), accountId, sessionId, setId);
      else this.db.prepare('UPDATE performed_sets SET reps=?,weight_kg=?,status=?,revision=revision+1,updated_at=? WHERE account_id=? AND session_id=? AND id=?')
        .run(input.reps, input.weightKg, input.status, now(), accountId, sessionId, setId);
      this.db.prepare('UPDATE workout_sessions SET revision=revision+1 WHERE account_id=? AND id=?').run(accountId, sessionId);
      this.setAudit(accountId, sessionId, setId);
      return { set: this.set(accountId, sessionId, setId), sessionRevision: this.sessionRow(accountId, sessionId).revision };
    }).immediate();
  }
  voidSet(accountId: string, sessionId: string, setId: string, expected: number) {
    assertAccountActive(this.db, accountId);
    const set = this.set(accountId, sessionId, setId); revision(set.revision, expected);
    if ('schema' in set) { this.requireSourcePrescription();
      if (set.schema === 'form.source-performed-set/v2') this.requireSourceReportedLoad(); }
    if (set.status === 'voided') throw new DomainError(409, 'set_voided');
    this.db.prepare('UPDATE performed_sets SET status=\'voided\',revision=revision+1,updated_at=? WHERE account_id=? AND session_id=? AND id=?').run(now(), accountId, sessionId, setId);
    this.db.prepare('UPDATE workout_sessions SET revision=revision+1 WHERE account_id=? AND id=?').run(accountId, sessionId);
    this.setAudit(accountId, sessionId, setId);
    return { set: this.set(accountId, sessionId, setId), sessionRevision: this.sessionRow(accountId, sessionId).revision };
  }
  completeSession(accountId: string, id: string, expected: number) {
    assertAccountActive(this.db, accountId);
    const row = this.sessionRow(accountId, id); revision(row.revision, expected);
    if ('schema' in this.session(accountId, id).planSnapshot) this.requireSourcePrescription();
    if (row.status !== 'active') throw new DomainError(409, 'session_completed');
    this.db.prepare('UPDATE workout_sessions SET status=\'completed\',completed_at=?,revision=revision+1 WHERE account_id=? AND id=?').run(now(), accountId, id);
    return this.session(accountId, id);
  }
  history(accountId: string, limit: number, before?: string) {
    assertAccountActive(this.db, accountId);
    let cursor: { startedAt: string; id: string } | undefined;
    if (before) {
      try {
        cursor = parsed<{ startedAt: string; id: string }>(Buffer.from(before, 'base64url').toString('utf8'));
        if (!cursor || typeof cursor.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(cursor.id) || typeof cursor.startedAt !== 'string' ||
          !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(cursor.startedAt) || Number.isNaN(Date.parse(cursor.startedAt))) throw new Error();
      } catch { throw new DomainError(422, 'invalid_cursor'); }
    }
    const rows = this.db.prepare('SELECT id FROM workout_sessions WHERE account_id=? AND (? IS NULL OR started_at < ? OR (started_at = ? AND id < ?)) ORDER BY started_at DESC,id DESC LIMIT ?')
      .all(accountId, cursor?.startedAt ?? null, cursor?.startedAt ?? null, cursor?.startedAt ?? null, cursor?.id ?? null, limit + 1) as { id: string }[];
    const items = rows.slice(0, limit).map(x => this.session(accountId, x.id));
    const last = items.at(-1);
    return { items, nextBefore: rows.length > limit && last ? Buffer.from(JSON.stringify({ startedAt: last.startedAt, id: last.id })).toString('base64url') : null };
  }
  stats(accountId: string) {
    assertAccountActive(this.db, accountId);
    const sourceColumn = (this.db.prepare('PRAGMA table_info(performed_sets)').all() as { name: string }[]).some(column => column.name === 'performance');
    const reps = sourceColumn ? "CASE WHEN s.performance IS NULL THEN s.reps WHEN json_extract(s.performance,'$.kind')='repetitions' THEN json_extract(s.performance,'$.reps') END" : 's.reps';
    const source = sourceColumn ? 's.performance IS NOT NULL' : '0';
    const practice = sourceColumn ? "json_extract(s.performance,'$.kind')='controlled-practice'" : '0';
    const metrics = `count(*) AS confirmedSets,count(${reps}) AS repetitionSets,count(s.weight_kg) AS loadSets,
      coalesce(sum(${source}),0) AS sourceSets,coalesce(sum(${practice}),0) AS practiceSets,
      coalesce(sum(${reps}),0) AS repetitions,coalesce(sum(s.reps*s.weight_kg),0) AS volumeKg,max(s.weight_kg) AS maxWeightKg`;
    type Totals = { confirmedSets: number; repetitionSets: number; loadSets: number; sourceSets: number; practiceSets: number;
      repetitions: number; volumeKg: number; maxWeightKg: number | null };
    const totals = this.db.prepare(`SELECT ${metrics} FROM performed_sets s WHERE s.account_id=? AND s.status='confirmed'`).get(accountId) as Totals;
    const { completedSessions } = this.db.prepare("SELECT count(*) AS completedSessions FROM workout_sessions WHERE account_id=? AND status='completed'").get(accountId) as { completedSessions: number };
    const byExercise = this.db.prepare(`SELECT o.exercise_id AS exerciseId,${metrics} FROM performed_sets s JOIN session_occurrences o
      ON o.account_id=s.account_id AND o.session_id=s.session_id AND o.id=s.occurrence_id
      WHERE s.account_id=? AND s.status='confirmed' GROUP BY o.exercise_id ORDER BY o.exercise_id`).all(accountId) as (Totals & { exerciseId: string })[];
    const present = (value: Totals, maximum: boolean) => ({ confirmedSets: value.confirmedSets,
      repetitions: value.repetitionSets === value.confirmedSets ? value.repetitions : null,
      volumeKg: value.loadSets === value.confirmedSets ? value.volumeKg : null,
      ...(maximum || value.sourceSets > 0 ? { maxWeightKg: value.loadSets === value.confirmedSets ? value.maxWeightKg : null } : {}),
      ...(value.sourceSets > 0 ? { coverage: { repetitionSets: value.repetitionSets, loadSets: value.loadSets, practiceSets: value.practiceSets } } : {}) });
    return { ...present(totals, false), completedSessions,
      byExercise: byExercise.map(value => ({ exerciseId: value.exerciseId, ...present(value, true) })),
      units: { load: 'kg', volume: 'kg-repetitions' }, includesActiveConfirmedSets: true };
  }
  cues(accountId: string, exerciseId: string) {
    assertAccountActive(this.db, accountId);
    const exercise = this.exercise(exerciseId), kind = `cues:${exerciseId}`;
    const current = this.db.prepare('SELECT revision,data FROM documents WHERE account_id=? AND kind=?').get(accountId, kind) as DocumentRow | undefined;
    if (!current) {
      this.db.transaction(() => {
      assertAccountActive(this.db, accountId);
        const existing = this.db.prepare('SELECT revision FROM documents WHERE account_id=? AND kind=?').get(accountId, kind);
        if (!existing) this.createDocument(accountId, kind, { kept: exercise.cues.map(x => x.id), rejected: [], order: exercise.cues.map(x => x.id), replacementRequested: [] });
      }).immediate();
    }
    return { ...this.document<CuePreferences>(accountId, kind), exerciseId, requiredConstraints: exercise.requiredConstraints, availableCues: exercise.cues };
  }
  patchCues(accountId: string, exerciseId: string, input: CuePreferences & { expectedRevision: number }) {
    assertAccountActive(this.db, accountId);
    const exercise = this.exercise(exerciseId);
    const valid = new Set(exercise.cues.map(x => x.id));
    for (const ids of [input.kept, input.rejected, input.order, input.replacementRequested]) {
      if (new Set(ids).size !== ids.length || ids.some(id => !valid.has(id))) throw new DomainError(422, 'invalid_cue_preferences');
    }
    if (input.kept.some(id => input.rejected.includes(id)) || input.order.length !== input.kept.length || input.order.some(id => !input.kept.includes(id)))
      throw new DomainError(422, 'invalid_cue_preferences');
    this.cues(accountId, exerciseId);
    this.patchDocument<CuePreferences>(accountId, `cues:${exerciseId}`, input);
    return this.cues(accountId, exerciseId);
  }
  configurePromos(definitions: PromoDefinition[]): void {
    this.db.transaction(() => {
      for (const definition of definitions) {
        const { code, ...terms } = definition, codeHash = hash(code.toUpperCase());
        const current = this.db.prepare('SELECT definition FROM promos WHERE code_hash=?').get(codeHash) as { definition: string } | undefined;
        if (current && current.definition !== canonical(terms)) throw new Error('A configured promo conflicts with durable terms');
        if (!current) this.db.prepare('INSERT INTO promos VALUES (?,?,0)').run(codeHash, canonical(terms));
      }
    }).immediate();
  }
  redeem(accountId: string, code: string) {
    assertAccountActive(this.db, accountId);
    const codeHash = hash(code.toUpperCase());
    const promo = this.db.prepare('SELECT definition,redeemed FROM promos WHERE code_hash=?').get(codeHash) as { definition: string; redeemed: number } | undefined;
    if (!promo) throw new DomainError(422, 'promo_unavailable');
    const terms = parsed<Omit<PromoDefinition, 'code'>>(promo.definition), date = now();
    const existing = this.db.prepare('SELECT id FROM entitlement_grants WHERE account_id=? AND source=\'promo\' AND source_id=?').get(accountId, codeHash);
    if (existing) throw new DomainError(409, 'promo_already_redeemed');
    if (Date.parse(terms.expiresAt) <= Date.parse(date) || promo.redeemed >= terms.maxRedemptions) throw new DomainError(422, 'promo_unavailable');
    const changed = this.db.prepare('UPDATE promos SET redeemed=redeemed+1 WHERE code_hash=? AND redeemed<?').run(codeHash, terms.maxRedemptions);
    if (changed.changes !== 1) throw new DomainError(422, 'promo_unavailable');
    const grant = { id: randomUUID(), entitlement: terms.entitlement, source: 'promo', grantedAt: date,
      expiresAt: new Date(Date.parse(date) + terms.days * 86400000).toISOString(), environment: 'zero_charge' };
    this.db.prepare('INSERT INTO entitlement_grants VALUES (?,?,?,?,?,?,?,?)').run(accountId, grant.id, grant.entitlement, 'promo', codeHash, date, grant.expiresAt, grant.environment);
    return { grant, charged: false };
  }
  entitlements(accountId: string) {
    assertAccountActive(this.db, accountId);
    const grants = this.db.prepare('SELECT id,entitlement,source,granted_at AS grantedAt,expires_at AS expiresAt,environment FROM entitlement_grants WHERE account_id=? ORDER BY granted_at,id')
      .all(accountId) as { id: string; entitlement: string; source: string; grantedAt: string; expiresAt: string; environment: string }[];
    return { grants: grants.map(x => ({ ...x, active: x.expiresAt > now() })), active: [...new Set(grants.filter(x => x.expiresAt > now()).map(x => x.entitlement))], purchases: { status: 'unconfigured' } };
  }
}
