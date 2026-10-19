import { createHash, randomUUID } from 'node:crypto';
import type { AccountContext } from '../../src/lifecycle/types.js';
import { hash, type Sqlite } from '../../src/storage.js';
import { createCanonicalAccountWriter } from '../../src/integration/account-modules/canonical-writer.js';
import { appendSourceBodyMeasurementMigration, appendSourceManualRetentionMigration,
  selectAccountModuleMigrations } from '../../src/integration/account-modules/migrations.js';
import { createManualMeasurements, measurementInput, type ManualMeasurement } from '../../src/body/measurements.js';
import { MANUAL_RETENTION_PROTOCOL, MANUAL_RETENTION_STATEMENT, MANUAL_RETENTION_STATEMENT_SHA256,
  type ManualRetentionAttemptAuthority, type ManualRetentionGrantPayload } from '../../src/body/manual-retention-contract.js';
import { baseMigrations, fixture as accountFixture } from '../integration/account-modules/fixture.js';

export const fullBodySourceConfiguration = { mode: 'source-only',
  modules: 'usage-bug-training-feedback-source-prescription-and-board-correction' } as const;
export const selectedManualRetentionMigrations = appendSourceManualRetentionMigration(appendSourceBodyMeasurementMigration(
  selectAccountModuleMigrations(fullBodySourceConfiguration, baseMigrations)));
export const manualRetentionGrant = (decisionId = randomUUID()): ManualRetentionGrantPayload => ({ decisionId,
  processing: MANUAL_RETENTION_STATEMENT.processing, purpose: MANUAL_RETENTION_STATEMENT.purpose, choice: 'retain',
  statementId: MANUAL_RETENTION_STATEMENT.id, statementVersion: 1, statementSha256: MANUAL_RETENTION_STATEMENT_SHA256 });
export const manualRetentionAttempt = (decisionId: string): ManualRetentionAttemptAuthority => ({
  protocol: MANUAL_RETENTION_PROTOCOL, decisionId, revision: 1, statementSha256: MANUAL_RETENTION_STATEMENT_SHA256,
});

export function manualRetentionFixture() {
  const f = accountFixture();
  try {
    for (const migration of selectedManualRetentionMigrations.filter(entry => entry.version > 16)) {
      f.db.exec(migration.sql);
      f.db.prepare('INSERT INTO form_migrations VALUES(?,?,?)').run(migration.version, hash(migration.sql), 'synthetic');
    }
    const writer = createCanonicalAccountWriter(f.db);
    const service = createManualMeasurements(f.db, writer.lifecycle, undefined, 'selected-migration-23');
    const grantFor = (actor: AccountContext) => {
      const payload = manualRetentionGrant();
      service.manualRetention!.grant(actor, payload, `grant:${payload.decisionId}`);
      return manualRetentionAttempt(payload.decisionId);
    };
    return { ...f, writer, service, grantFor };
  } catch (error) { f.close(); throw error; }
}

// Historical rows intentionally have no retention decision or attribution; this never calls the new-save path.
export function seedHistoricalMeasurement(db: Sqlite, accountId: string, raw: unknown, key: string,
  canonical: Pick<ManualMeasurement, 'value' | 'unit'>): ManualMeasurement {
  const input = measurementInput.parse(raw);
  const record: ManualMeasurement = { id: randomUUID(), kind: input.kind, value: canonical.value, unit: canonical.unit,
    originalUnit: input.unit, measuredOn: input.measuredOn, note: input.note ?? null, provenance: 'manual_reported' };
  db.transaction(() => {
    db.prepare('INSERT INTO body_manual_measurements VALUES(?,?,?,?,?,?,?,?,?)').run(record.id, accountId, record.kind,
      record.value, record.unit, record.originalUnit, record.measuredOn, record.note, 'synthetic historical');
    db.prepare('INSERT INTO body_manual_receipts VALUES(?,?,?,?,?)').run(accountId, key,
      createHash('sha256').update(JSON.stringify({ operation: 'create', input })).digest('hex'), record.id, 'create');
  }).immediate();
  return record;
}
