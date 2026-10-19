import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Sqlite } from '../storage.js';
import type { AccountContext, LifecycleBindings, LifecycleAdapter } from '../lifecycle/types.js';
import { DomainError } from '../errors.js';
import { createManualRetention } from './manual-retention.js';
import { manualRetentionOwnedTables } from './manual-retention-migration.js';
import { assertSourceManualRetentionHistory, type SourceMigrationReceipt } from '../integration/account-modules/migrations.js';
import type { SourceManualRetentionSelection } from '../storage.js';

const civilDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const time = Date.parse(`${value}T00:00:00Z`); return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
});
export const measurementInput = z.object({ kind: z.enum(['waist', 'hips', 'chest', 'thigh', 'upper_arm', 'weight']),
  value: z.number().finite().positive().max(10000), unit: z.enum(['cm', 'in', 'kg', 'lb']), measuredOn: civilDate,
  note: z.string().trim().max(200).optional(),
}).strict().refine(input => input.kind === 'weight' ? ['kg', 'lb'].includes(input.unit) : ['cm', 'in'].includes(input.unit));
export const measurementRange = z.object({ from: civilDate.optional(), to: civilDate.optional() }).strict()
  .refine(value => !value.from || !value.to || value.from <= value.to);
export type ManualMeasurement = { id: string; kind: string; value: number; unit: 'cm' | 'kg'; originalUnit: string; measuredOn: string; note: string | null; provenance: 'manual_reported' };

export { manualMeasurementMigrationSql } from './manual-measurement-migration.js';
export function createManualMeasurements(db: Sqlite, lifecycle: LifecycleBindings, now: () => Date = () => new Date(),
  sourceManualRetention?: SourceManualRetentionSelection) {
  if (sourceManualRetention !== undefined) {
    if (sourceManualRetention !== 'selected-migration-23') throw new DomainError(503, 'body_manual_retention_configuration_invalid');
    assertSourceManualRetentionHistory(db.prepare('SELECT version,checksum FROM form_migrations ORDER BY version').all() as SourceMigrationReceipt[], true);
    if (['body_manual_measurements', 'body_manual_receipts', ...manualRetentionOwnedTables].some(table => !db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)))
      throw new DomainError(503, 'body_manual_retention_migration_required');
  }
  const manualRetention = sourceManualRetention ? createManualRetention(db, lifecycle, now) : undefined;
  const retainedTables = [...manualRetentionOwnedTables].reverse().filter(table =>
    db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
  const allTables = [...retainedTables, 'body_manual_receipts', 'body_manual_measurements'];
  const parse = <T>(schema: z.ZodType<T>, value: unknown): T => { const result = schema.safeParse(value); if (!result.success) throw new DomainError(422, 'body_invalid_input'); return result.data; };
  const read = (actor: AccountContext, id: string): ManualMeasurement => {
    const row = db.prepare("SELECT id,kind,value,unit,original_unit AS originalUnit,measured_on AS measuredOn,note,'manual_reported' AS provenance FROM body_manual_measurements WHERE account_id=? AND id=?").get(actor.accountId, id) as ManualMeasurement | undefined;
    if (!row) throw new DomainError(404, 'body_measurement_not_found'); return row;
  };
  const command = <T>(actor: AccountContext, key: string, operation: string, input: unknown, effect: () => { id: string; result: T; afterReceipt?: () => void }, replay: (id: string) => T): T => lifecycle.withActiveWrite(actor, () => {
    parse(z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/), key);
    const hash = createHash('sha256').update(JSON.stringify({ operation, input })).digest('hex');
    const prior = db.prepare('SELECT intent_hash,measurement_id FROM body_manual_receipts WHERE account_id=? AND key=?').get(actor.accountId, key) as { intent_hash: string; measurement_id: string } | undefined;
    if (prior) { if (prior.intent_hash !== hash) throw new DomainError(409, 'idempotency_conflict'); return replay(prior.measurement_id); }
    const value = effect(); db.prepare('INSERT INTO body_manual_receipts VALUES(?,?,?,?,?)').run(actor.accountId, key, hash, value.id, operation); value.afterReceipt?.(); return value.result;
  });
  const service = {
    create(actor: AccountContext, raw: unknown, key: string, attemptAuthority?: unknown): ManualMeasurement {
      const input = parse(measurementInput, raw);
      return command(actor, key, 'create', input, () => {
        if (!manualRetention) throw new DomainError(403, 'body_manual_retention_required');
        const authority = manualRetention.requireAuthorityWithinWrite(actor, attemptAuthority);
        const count = db.prepare('SELECT count(*) n FROM body_manual_measurements WHERE account_id=?').get(actor.accountId) as { n: number };
        if (count.n >= 10000) throw new DomainError(409, 'body_measurement_capacity');
        const id = randomUUID(), unit = input.kind === 'weight' ? 'kg' : 'cm';
        const value = input.value * (input.unit === 'in' ? 2.54 : input.unit === 'lb' ? 0.45359237 : 1);
        db.prepare('INSERT INTO body_manual_measurements VALUES(?,?,?,?,?,?,?,?,?)').run(id, actor.accountId, input.kind, value, unit, input.unit, input.measuredOn, input.note ?? null, now().toISOString());
        return { id, result: read(actor, id), afterReceipt: () => manualRetention.attributeWithinWrite(actor, authority, key, id) };
      }, id => read(actor, id));
    },
    list(actor: AccountContext, raw: unknown = {}): { items: ManualMeasurement[] } {
      const range = parse(measurementRange, raw);
      return lifecycle.withActiveWrite(actor, () => ({ items: (db.prepare('SELECT id FROM body_manual_measurements WHERE account_id=? AND measured_on>=? AND measured_on<=? ORDER BY measured_on,id LIMIT 10000').all(actor.accountId, range.from ?? '0000-01-01', range.to ?? '9999-12-31') as { id: string }[]).map(row => read(actor, row.id)) }));
    },
    delete(actor: AccountContext, id: string, raw: unknown, key: string): { deleted: true } {
      parse(z.uuid(), id); parse(z.object({}).strict(), raw);
      return command(actor, key, 'delete', { id }, () => { read(actor, id); db.prepare('DELETE FROM body_manual_measurements WHERE account_id=? AND id=?').run(actor.accountId, id); return { id, result: { deleted: true as const } }; }, () => ({ deleted: true as const }));
    },
  };
  const serialized = () => { if (!db.inTransaction) throw new DomainError(503, 'body_lifecycle_serialization_required'); };
  const erase = (accountId: string) => { serialized(); let count = 0;
    for (const table of allTables) count += db.prepare(`DELETE FROM ${table} WHERE account_id=?`).run(accountId).changes;
    return { status: 'complete' as const, count };
  };
  const lifecycleAdapter: LifecycleAdapter = {
    category: 'body',
    inventory: actor => lifecycle.withActiveWrite(actor, () => ({ category: 'body', status: 'complete',
      count: allTables.reduce((total, table) => total + (db.prepare(`SELECT count(*) n FROM ${table} WHERE account_id=?`).get(actor.accountId) as { n: number }).n, 0) })),
    export: (actor, snapshot) => { const items = service.list(actor).items; snapshot.append('body', { measurements: items });
      return { category: 'body', status: 'unavailable', reason: 'manual_retention_metadata_omitted', count: items.length }; },
    suppress: accountId => erase(accountId),
    purge: (_requestId, accountId) => erase(accountId),
    verifySuppressed: accountId => { serialized();
      const retained = allTables.some(table => db.prepare(`SELECT 1 FROM ${table} WHERE account_id=? LIMIT 1`).get(accountId));
      return { status: retained ? 'pending' : 'complete' };
    },
  };
  return { ...service, lifecycleAdapter, manualRetention };
}
export type ManualMeasurements = ReturnType<typeof createManualMeasurements>;
