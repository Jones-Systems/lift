import type Database from 'better-sqlite3';
import { DomainError } from '../errors.js';
export type CommunityExportBounds = Readonly<{ rows: number; bytes: number }>;
export const COMMUNITY_EXPORT_MAX_ROWS = 10000;
export const COMMUNITY_EXPORT_MAX_BYTES = 2097152;

// Callers supply fixed module-owned queries only; never request-derived SQL.
export function estimateCommunityRows(db: Database.Database, query: string, args: readonly unknown[] = []): CommunityExportBounds {
  const statement = db.prepare(query);
  const columns = statement.columns().map(column => `"${column.name.replaceAll('"', '""')}"`);
  const size = columns.map(column => `6*length(CAST(coalesce(${column},'') AS BLOB))`).join('+') || '0';
  const row = db.prepare(`SELECT count(*) rows,coalesce(sum(2048+${size}),0) bytes FROM (${query})`).get(...args) as CommunityExportBounds;
  return row;
}
export function addCommunityExportBounds(bounds: readonly CommunityExportBounds[]): CommunityExportBounds {
  const result = { rows: 0, bytes: 0 };
  for (const value of bounds) {
    if (!Number.isSafeInteger(value.rows) || value.rows < 0 || !Number.isSafeInteger(value.bytes) || value.bytes < 0)
      throw new DomainError(503, 'community_export_bounds_unproved');
    result.rows += value.rows; result.bytes += value.bytes;
    if (!Number.isSafeInteger(result.rows) || !Number.isSafeInteger(result.bytes)) throw new DomainError(413, 'community_export_capacity');
  }
  return result;
}
export function assertCommunityExportBounds(value: CommunityExportBounds, maxRows = COMMUNITY_EXPORT_MAX_ROWS, maxBytes = COMMUNITY_EXPORT_MAX_BYTES): void {
  addCommunityExportBounds([value]);
  if (value.rows > maxRows || value.bytes > maxBytes) throw new DomainError(413, 'community_export_capacity');
}
