import type { Sqlite } from '../storage.js';
import { DomainError } from '../errors.js';
import { activityOwnedTables } from '../activity/migration.js';
import { progressComparisonOwnedTables } from '../progress-comparison/migration.js';
import { feedbackOwnedTables } from '../training-feedback/migration.js';
import type { LifecycleAdapter } from './types.js';

const owners = {
  'activity-owned-v1': { category: 'activity', tables: activityOwnedTables,
    receipts: "SELECT 1 FROM command_receipts WHERE account_id=? AND operation LIKE 'activity.%' LIMIT 1" },
  'progress-comparison-owned-v1': { category: 'progressComparison', tables: progressComparisonOwnedTables,
    receipts: "SELECT 1 FROM command_receipts WHERE account_id=? AND operation IN ('progressComparison.confirm','progressComparison.withdraw') LIMIT 1" },
  'training-feedback-owned-v1': { category: 'trainingFeedback', tables: feedbackOwnedTables, receipts: null },
} as const;
type Owner = keyof typeof owners;
declare const absenceBrand: unique symbol;
export type SourceLifecycleLocalAbsenceReader = Readonly<{ [absenceBrand]: true }>;
type Binding = Readonly<{ db: Sqlite; adapter: LifecycleAdapter; owner: Owner; category: string }>;
const bindings = new WeakMap<SourceLifecycleLocalAbsenceReader, Binding>();
function held(): never { throw new DomainError(503, 'lifecycle_local_absence_held'); }

// Trusted composition selects an exact owner inventory and adapter; category names alone grant no readback qualification.
export function bindSourceLifecycleLocalAbsenceReader(db: Sqlite, adapter: LifecycleAdapter, owner: Owner): SourceLifecycleLocalAbsenceReader {
  if (!db.open || !Object.hasOwn(owners, owner) || adapter.category !== owners[owner].category) held();
  const reader = Object.freeze(Object.create(null)) as SourceLifecycleLocalAbsenceReader;
  bindings.set(reader, Object.freeze({ db, adapter, owner, category: adapter.category }));
  return reader;
}
export function sourceLifecycleLocalAbsenceReadback(db: Sqlite, adapters: readonly LifecycleAdapter[], readers: readonly SourceLifecycleLocalAbsenceReader[]) {
  const selected = new Map<string, Binding>();
  for (const reader of readers) {
    const bound = bindings.get(reader);
    if (!bound || bound.db !== db || !adapters.includes(bound.adapter) || bound.adapter.category !== bound.category || selected.has(bound.category)) held();
    selected.set(bound.category, bound);
  }
  return Object.freeze({
    qualified: (category: string) => selected.has(category),
    absent(accountId: string, category: string): boolean {
      const bound = selected.get(category);
      if (!bound || !db.open || !db.inTransaction) return false;
      const owner = owners[bound.owner];
      try {
        return !owner.tables.some(table => db.prepare(`SELECT 1 FROM ${table} WHERE account_id=? LIMIT 1`).get(accountId)) &&
          (owner.receipts === null || !db.prepare(owner.receipts).get(accountId));
      } catch { return false; }
    },
  });
}
