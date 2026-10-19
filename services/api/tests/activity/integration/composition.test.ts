import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { createRequire } from 'node:module';
import * as storage from '../../../src/storage.js';
import type { ActivityService } from '../../../src/activity/service.js';
import type { ActivityEntry, ActivityPlanSnapshot, PersonalExercise } from '../../../src/activity/types.js';
import { globalActivityExerciseKind } from '../../../src/activity/integration/index.js';
import { fixture, code, personalFields, entryInput, unknownLoad, seedPlan } from './fixture.js';

const sourceRoot = resolve(process.cwd(), 'src');
function instrumentService(counters: { canonical: number; hash: number }): (deps: ActivityService['deps']) => ActivityService {
  const modules = new Map<string, { exports: Record<string, unknown> }>();
  const external = createRequire(import.meta.url);
  const compiledRoot = resolve(import.meta.dirname, '../../../src');
  function load(file: string): Record<string, unknown> {
    const cached = modules.get(file); if (cached) return cached.exports;
    const module = { exports: {} as Record<string, unknown> }; modules.set(file, module);
    // Execute the compiler-produced module with only its imports and named exports adapted for sink spies.
    const exported: string[] = [];
    const code = readFileSync(file, 'utf8')
      .replace(/^import \* as (\w+) from (['"][^'"]+['"]);$/gm, 'const $1 = require($2);')
      .replace(/^import \{([^}]+)\} from (['"][^'"]+['"]);$/gm, (_match, names: string, target: string) =>
        `const {${names.replace(/\bas\b/g, ':')}} = require(${target});`)
      .replace(/\bexport (class|function|const|let) (\w+)/g, (_match, kind: string, name: string) => {
        exported.push(name); return `${kind} ${name}`;
      });
    assert.ok(!/^import |\bexport /m.test(code), 'Unsupported fixture module syntax');
    new Function('require', 'module', 'exports', code + '\n' + exported.map(name => `exports.${name} = ${name};`).join('\n'))((name: string) => {
      if (!name.startsWith('.')) return external(name);
      const resolved = resolve(dirname(file), name);
      assert.ok(resolved.startsWith(compiledRoot + '/'));
      if (resolved === resolve(compiledRoot, 'storage.js')) return { ...storage,
        canonical(value: unknown) { counters.canonical++; return storage.canonical(value); },
        hash(value: string) { counters.hash++; return storage.hash(value); },
      };
      return load(resolved);
    }, module, module.exports);
    return module.exports;
  }
  return load(resolve(compiledRoot, 'activity/service.js')).createActivityService as (deps: ActivityService['deps']) => ActivityService;
}

test('unbound neutral no-save derivatives fail before real canonical/hash boundary, receipt and payload SQL', t => {
  const f = fixture(); t.after(() => f.db.close());
  const counters = { canonical: 0, hash: 0 };
  const service = instrumentService(counters)(f.integration.service.deps);
  f.sql.length = 0;
  const fields = { ...personalFields, name: 'SYNTHETIC_NOSAVE_NEUTRAL_LABEL', description: '42' };
  assert.throws(() => service.createExercise(f.contexts.A, 'rejected-key', fields), code('activity_owner_channel_required'));
  assert.deepEqual(counters, { canonical: 0, hash: 0 });
  assert.ok(!f.sql.some(sql => /command_receipts|activity_exercises|SYNTHETIC_NOSAVE_NEUTRAL_LABEL/.test(sql)));
  assert.ok(f.sql.some(sql => /session/.test(sql)));
  const lease = f.integration.openOwnerRequest(f.contexts.A);
  assert.equal(service.createExercise(lease.context, 'useful-key', personalFields).status, 201);
  assert.ok(counters.canonical > 0 && counters.hash > 0); lease.release();
  // Observable sinks: storage canonical/hash and executed SQL. External logs/proxies/OS/provider state are not instrumented.
});
test('frozen command ordering gates before canonical hash/receipt and repeats inside the writer', () => {
  const source = readFileSync(resolve(sourceRoot, 'activity/service.ts'), 'utf8');
  const command = source.slice(source.indexOf('private command<T>'), source.indexOf('private aggregate<T>'));
  const checks = [...command.matchAll(/this\.deps\.assertPersistable/g)].map(match => match.index);
  assert.equal(checks.length, 2);
  assert.ok(checks[0]! < command.indexOf('withActiveWrite'));
  assert.ok(checks[1]! < command.indexOf('const fingerprint = hash(canonical(intent))'));
  assert.ok(checks[1]! < command.indexOf('FROM command_receipts'));
});
test('composed service supports catalog, plans, dated schedules, manual/voice, backdate, edit, void and adherence', t => {
  const f = fixture(); t.after(() => f.db.close()); const { service } = f.integration;
  const lease = f.integration.openOwnerRequest(f.contexts.A); const a = lease.context;
  service.createCalendar(a, 'calendar-key', { timeZone: 'America/New_York', confirmed: true });
  const catalog = service.catalog(a);
  assert.equal(catalog.items.length, 5); assert.ok(catalog.items.every(item => item.kind === 'resistance'));
  const exercise = service.createExercise(a, 'exercise-key', personalFields).body as PersonalExercise;
  const fields = { name: 'Explicit target plan', minutes: null, items: [{ id: 'plan-item',
    exercise: { source: 'personal', id: exercise.id, revision: exercise.revision }, target: { load: unknownLoad } }] };
  const plan = service.createPlan(a, 'plan-key', fields).body as ActivityPlanSnapshot;
  assert.equal(plan.minutes, null); assert.equal(plan.items[0]!.snapshot.movement, null);
  const revised = service.patchPlan(a, plan.id, 'patch-plan-key', { ...fields, name: 'Revised target', expectedRevision: 1 }).body as ActivityPlanSnapshot;
  service.writeSchedule(a, 'schedule-key', { expectedRevision: 0, effectiveFrom: '2026-10-09', week: Array.from({ length: 7 }, (_, i) =>
    ({ isoWeekday: i + 1, expectation: i === 6 ? 'rest' : 'workout', plan: i === 6 ? null : { id: plan.id, revision: revised.revision } })) });
  service.correctDay(a, '2026-10-02', 'day-key', { expectedRevision: 0, expectation: 'rest', plan: null, reason: 'scheduleWasIncorrect', confirmed: true });
  const manual = service.createEntry(a, 'manual-key', entryInput('manual-draft', '2026-10-01')).body as ActivityEntry;
  const voice = service.createEntry(a, 'voice-key', entryInput('voice-draft', '2026-10-08', 'nativeSpeech')).body as ActivityEntry;
  assert.equal(manual.source, 'manual'); assert.equal(voice.source, 'nativeSpeech');
  const edit = service.patchEntry(a, manual.id, 'edit-key', { ...entryInput(manual.draftId, '2026-10-03'), expectedRevision: 1 }).body as ActivityEntry;
  assert.equal(edit.date.localDate, '2026-10-03'); assert.equal(edit.revision, 2);
  assert.equal((service.voidEntry(a, voice.id, 'void-key', { expectedRevision: 1 }).body as ActivityEntry).status, 'voided');
  assert.equal(service.adherence(a, { from: '2026-10-01', to: '2026-10-09' }).days.length, 9);
  const before = (f.db.prepare('SELECT total_changes() AS n').get() as { n: number }).n;
  service.adherence(a, { from: '2026-10-01', to: '2026-10-09' });
  assert.equal((f.db.prepare('SELECT total_changes() AS n').get() as { n: number }).n, before);
  const b = f.integration.openOwnerRequest(f.contexts.B);
  assert.throws(() => service.entry(b.context, manual.id), code('not_found'));
  assert.throws(() => service.plan(b.context, plan.id), code('not_found'));
  b.release(); lease.release();
});
test('exact legacy import freezes old snapshot, zero kg and nullable global metadata through source changes', t => {
  const f = fixture(); t.after(() => f.db.close()); const lease = f.integration.openOwnerRequest(f.contexts.A);
  seedPlan(f.db, lease.context.accountId);
  const imported = f.integration.service.importLegacyPlan(lease.context, 'import-key', { planId: 'same-plan', revision: 1 }).body as ActivityPlanSnapshot;
  assert.deepEqual(imported.items[0]!.target.load, { state: 'knownValue', value: 0, unit: 'kg', basis: 'unspecified' });
  assert.equal(imported.items[0]!.snapshot.movement, null); assert.equal(imported.items[0]!.snapshot.loadLabel, null);
  assert.equal(imported.items[0]!.snapshot.description, '');
  seedPlan(f.db, lease.context.accountId, 'same-plan', 2, { name: 'New name', minutes: 60, archived: true });
  assert.deepEqual(f.integration.service.plan(lease.context, imported.id), imported);
  assert.deepEqual(f.integration.service.importLegacyPlan(lease.context, 'import-key', { planId: 'same-plan', revision: 1 }).body, imported);
  assert.throws(() => f.integration.service.importLegacyPlan(lease.context, 'archived-key', { planId: 'same-plan', revision: 2 }), code('plan_archived'));
  assert.throws(() => f.integration.service.importLegacyPlan(lease.context, 'missing-key', { planId: 'same-plan', revision: 3 }), code('not_found'));
  lease.release();
});
test('same retry intent replays, changed intent conflicts, released channel cannot replay', t => {
  const f = fixture(); t.after(() => f.db.close()); const lease = f.integration.openOwnerRequest(f.contexts.A);
  const first = f.integration.service.createExercise(lease.context, 'unknown-key', personalFields);
  assert.deepEqual(f.integration.service.createExercise(lease.context, 'unknown-key', personalFields), first);
  assert.throws(() => f.integration.service.createExercise(lease.context, 'unknown-key', { ...personalFields, name: 'Changed' }), code('idempotency_mismatch'));
  lease.release(); assert.throws(() => f.integration.service.createExercise(lease.context, 'unknown-key', personalFields), code('activity_owner_channel_required'));
});
test('legacy omission leaves manual activity useful and accurately reports unavailable source', t => {
  const f = fixture({ legacy: false }); t.after(() => f.db.close()); const lease = f.integration.openOwnerRequest(f.contexts.A);
  assert.equal(f.integration.service.capabilities(lease.context).legacyEvidence, 'unavailable');
  assert.equal(f.integration.service.createExercise(lease.context, 'manual-key', personalFields).status, 201);
  assert.throws(() => f.integration.service.importLegacyPlan(lease.context, 'import-key', { planId: 'same-plan', revision: 1 }), code('activity_legacy_unavailable'));
  assert.equal(f.integration.lifecycleAdapter.category, 'activity');
  assert.equal(f.integration.lifecycleAdapter.inventory(lease.context).status, 'complete'); lease.release();
});
test('fixed five-ID mapping never infers new exercise kinds from labels', () => {
  for (const id of ['goblet-squat', 'floor-press', 'supported-row', 'dumbbell-hinge', 'calf-raise']) assert.equal(globalActivityExerciseKind(id), 'resistance');
  for (const id of ['unknown', 'resistance', 'Goblet squat', '__proto__']) assert.equal(globalActivityExerciseKind(id), null);
});

test('retired global remains readable in legacy history but cannot be selected by a new import', t => {
  const f = fixture(); t.after(() => f.db.close()); const lease = f.integration.openOwnerRequest(f.contexts.A);
  seedPlan(f.db, lease.context.accountId);
  f.db.prepare('UPDATE exercises SET retired=1 WHERE id=?').run('floor-press');
  assert.equal(f.db.transaction(() => f.legacy.readPlanRevision(lease.context.accountId, 'same-plan', 1)).deferred()!.items[0]!.exerciseId, 'floor-press');
  assert.throws(() => f.integration.service.importLegacyPlan(lease.context, 'retired-key', { planId: 'same-plan', revision: 1 }), code('exercise_retired'));
  assert.equal((f.db.prepare('SELECT count(*) AS n FROM activity_plans').get() as { n: number }).n, 0);
  lease.release();
});
test('supplied export adapter consumes canonical context without issuing a mutation lease', t => {
  const f = fixture(); t.after(() => f.db.close()); const lease = f.integration.openOwnerRequest(f.contexts.A);
  f.integration.service.createExercise(lease.context, 'export-exercise-key', personalFields); lease.release();
  const rows: { category: string; value: unknown }[] = [];
  assert.equal(f.integration.lifecycleAdapter.export(f.contexts.A, { snapshotAtMs: 1,
    append(category, value) { rows.push({ category, value }); } }).status, 'complete');
  assert.ok(rows.length > 0); assert.ok(rows.every(row => row.category === 'activity'));
  f.suppress(f.contexts.A.accountId);
  assert.throws(() => f.integration.lifecycleAdapter.export(f.contexts.A, { snapshotAtMs: 1, append() {} }), code('account_disabled'));
  // This scoped append observes the adapter shape. Root's real export serializer and registration remain separate gates.
});
