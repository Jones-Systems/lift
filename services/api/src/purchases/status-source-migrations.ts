import { createHash } from 'node:crypto';
import type { Migration, Sqlite } from '../storage.js';
import { openStorage } from '../storage.js';
import { DomainError } from '../errors.js';
import { selectSourceActionReauthenticationMigrations, assertSourceActionReauthenticationSelection,
  assertSourceActionReauthenticationHistory, assertActionReauthenticationPreflight } from '../lifecycle/reauthentication-source-migrations.js';
import { assertActionReauthenticationSchema } from '../lifecycle/reauthentication-migration.js';
import { assertProviderRevocationSchema } from '../lifecycle/providers/outbox-migration.js';
import { assertLifecycleEvidenceSchema } from '../lifecycle/evidence-store.js';
import { sourceSubscriptionStatusMigration, assertSubscriptionStatusSchema } from './status-migration.js';

export type SourceSubscriptionStatusSelection = 'selected-subscription-status-27';
export type SourceSubscriptionStatusConfiguration = Readonly<{ mode: 'source-only'; cohort: 'subscription-status-v1' }>;
export function assertSourceSubscriptionStatusConfiguration(c: SourceSubscriptionStatusConfiguration): void {
  if (!c || Object.keys(c).sort().join(',') !== 'cohort,mode' || c.mode !== 'source-only' || c.cohort !== 'subscription-status-v1')
    throw new DomainError(503, 'subscription_status_configuration_required');
}
const digest = (s: string) => createHash('sha256').update(s).digest('hex');
export function selectSourceSubscriptionStatusMigrations(): readonly Migration[] {
  return Object.freeze([...selectSourceActionReauthenticationMigrations(), sourceSubscriptionStatusMigration].map(m => Object.freeze({...m})));
}
export function assertSourceSubscriptionStatusSelection(selected: readonly Migration[]): void {
  const genuine = selectSourceSubscriptionStatusMigrations();
  if (selected.length !== 27 || selected.some((m,i) => m.version !== i+1 || digest(m.sql) !== digest(genuine[i]!.sql)))
    throw new Error('subscription_status_selection_invalid');
  assertSourceActionReauthenticationSelection(selected.slice(0,26));
}
export function assertSourceSubscriptionStatusHistory(rows: readonly {version:number; checksum:string}[], complete = false): void {
  const genuine = selectSourceSubscriptionStatusMigrations();
  if (rows.length > 27 || complete && rows.length !== 27 || rows.some((r,i) => r.version !== i+1 || r.checksum !== digest(genuine[i]!.sql)))
    throw new Error('subscription_status_history_invalid');
  assertSourceActionReauthenticationHistory(rows.slice(0,26), complete);
}
export function assertSubscriptionStatusPreflight(db: Sqlite, selected: boolean): void {
  const rows = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='form_migrations'").get()
    ? db.prepare('SELECT version,checksum FROM form_migrations ORDER BY version').all() as {version:number; checksum:string}[] : [];
  const installed = rows.some(r => r.version === 27);
  if (!selected) {
    if (installed) throw new DomainError(503, 'subscription_status_selection_required');
    return; // Legacy optional reconciliation remains owned by its old cohort.
  }
  assertSourceSubscriptionStatusHistory(rows);
  assertSubscriptionStatusSchema(db, installed);
  assertLifecycleEvidenceSchema(db, rows.length >= 24);
  assertProviderRevocationSchema(db, rows.length >= 25);
  assertActionReauthenticationSchema(db, rows.length >= 26);
  if (installed) return;
  if (rows.length < 26) assertActionReauthenticationPreflight(db, true);
  for (const table of ['account_provider_revocation_intents','account_action_challenges','account_action_proof_consumptions']) {
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table) && db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get())
      throw new DomainError(503, 'subscription_status_upgrade_held');
  }
}
export async function openSourceSubscriptionStatusStorage(path: string, configuration: SourceSubscriptionStatusConfiguration) {
  assertSourceSubscriptionStatusConfiguration(configuration);
  return openStorage(path, selectSourceSubscriptionStatusMigrations(), 'selected-migration-22', 'selected-migration-23',
    'selected-lifecycle-evidence-24', 'selected-provider-revocation-25', 'selected-action-reauthentication-26', 'selected-subscription-status-27');
}
