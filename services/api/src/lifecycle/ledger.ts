import Database from 'better-sqlite3';
import { realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import type { DisableRecord, SuppressionLedger } from './types.js';

export const suppressionLedgerSchema = `
CREATE TABLE suppression_authority(identity TEXT PRIMARY KEY, sequence INTEGER NOT NULL CHECK(sequence>=0));
CREATE TABLE suppression_records(sequence INTEGER PRIMARY KEY, account_id TEXT NOT NULL UNIQUE, auth_user_id TEXT NOT NULL UNIQUE,
 epoch INTEGER NOT NULL CHECK(epoch>0), request_id TEXT NOT NULL UNIQUE, disabled_at_ms INTEGER NOT NULL);
CREATE TRIGGER suppression_retained BEFORE DELETE ON suppression_records BEGIN SELECT RAISE(ABORT,'suppression_retained'); END;
CREATE TRIGGER suppression_immutable BEFORE UPDATE ON suppression_records BEGIN SELECT RAISE(ABORT,'suppression_immutable'); END;
CREATE TRIGGER suppression_sequence BEFORE UPDATE ON suppression_authority WHEN NEW.identity<>OLD.identity OR NEW.sequence<>OLD.sequence+1
 BEGIN SELECT RAISE(ABORT,'suppression_sequence'); END;
CREATE TRIGGER suppression_authority_retained BEFORE DELETE ON suppression_authority BEGIN SELECT RAISE(ABORT,'suppression_authority_retained'); END;
`;
type Row = { sequence: number; account_id: string; auth_user_id: string; epoch: number; request_id: string; disabled_at_ms: number };
const record = (r: Row): DisableRecord => ({ sequence: r.sequence, accountId: r.account_id, authUserId: r.auth_user_id,
  epoch: r.epoch, requestId: r.request_id, disabledAtMs: r.disabled_at_ms });

// Custody/provisioning is root-owned. This opens only an explicitly bound existing authority; it never creates one.
export class ExistingSuppressionLedger implements SuppressionLedger {
  private readonly db: Database.Database;
  private floor: number;
  private readonly inode: number;
  private readonly device: number;
  constructor(private readonly path: string, private readonly identity: string, minimumSequence: number) {
    if (!isAbsolute(path) || !identity || !Number.isSafeInteger(minimumSequence) || minimumSequence < 0 ||
      realpathSync(path) !== resolve(path) || !statSync(path).isFile() || (statSync(path).mode & 0o077) !== 0 || (statSync(dirname(path)).mode & 0o077) !== 0)
      throw new Error('Suppression authority must be an explicit restricted existing file');
    this.inode = statSync(path).ino; this.device = statSync(path).dev;
    this.db = new Database(path, { fileMustExist: true }); this.floor = minimumSequence;
    try { this.db.pragma('journal_mode = DELETE'); this.db.pragma('synchronous = FULL'); this.db.pragma('busy_timeout = 5000'); this.currentSequence(); }
    catch (error) { this.db.close(); throw error; }
  }
  currentSequence(): number {
    const file = statSync(this.path);
    if (realpathSync(this.path) !== resolve(this.path) || file.ino !== this.inode || file.dev !== this.device ||
      !file.isFile() || (file.mode & 0o077) !== 0 || (statSync(dirname(this.path)).mode & 0o077) !== 0)
      throw new Error('Suppression authority binding lost');
    const row = this.db.prepare('SELECT identity,sequence FROM suppression_authority').all() as { identity: string; sequence: number }[];
    const max = (this.db.prepare('SELECT COALESCE(MAX(sequence),0) AS sequence,COUNT(*) AS count FROM suppression_records').get() as { sequence: number; count: number });
    const value = row[0];
    if (row.length !== 1 || !value || value.identity !== this.identity || !Number.isSafeInteger(value.sequence) || value.sequence < this.floor ||
      value.sequence !== max.sequence || max.count !== max.sequence) throw new Error('Suppression authority currentness unknown');
    this.floor = value.sequence; return value.sequence;
  }
  lookup(accountId: string): DisableRecord | null {
    this.currentSequence();
    const row = this.db.prepare('SELECT * FROM suppression_records WHERE account_id=?').get(accountId) as Row | undefined;
    return row ? record(row) : null;
  }
  recordDisable(input: Omit<DisableRecord, 'sequence'>): DisableRecord {
    if (!input.accountId || !input.authUserId || !input.requestId || !Number.isSafeInteger(input.epoch) || input.epoch < 1 ||
      !Number.isSafeInteger(input.disabledAtMs) || input.disabledAtMs < 0) throw new Error('Invalid suppression evidence');
    return this.db.transaction(() => {
      const sequence = this.currentSequence(); const prior = this.lookup(input.accountId);
      if (prior) {
        if (prior.authUserId !== input.authUserId || prior.epoch !== input.epoch || prior.requestId !== input.requestId)
          throw new Error('Suppression evidence conflict');
        return prior;
      }
      this.db.prepare('UPDATE suppression_authority SET sequence=? WHERE identity=? AND sequence=?').run(sequence + 1, this.identity, sequence);
      this.db.prepare('INSERT INTO suppression_records VALUES(?,?,?,?,?,?)')
        .run(sequence + 1, input.accountId, input.authUserId, input.epoch, input.requestId, input.disabledAtMs);
      return { ...input, sequence: sequence + 1 };
    }).immediate();
  }
  reconcileRestore(apply: (entry: DisableRecord) => void): number {
    const before = this.currentSequence();
    for (const row of this.db.prepare('SELECT * FROM suppression_records ORDER BY sequence').iterate()) apply(record(row as Row));
    const after = this.currentSequence();
    if (before !== after) throw new Error('Suppression changed during restore admission');
    return after;
  }
  validateSchema(): void {
    const normalize = (sql: string) => sql.trim().replace(/\s+/g, ' ').replace(/;$/, '');
    const expected = new Map<string, string>();
    for (const match of suppressionLedgerSchema.matchAll(/CREATE TABLE (\w+)[\s\S]*?\);|CREATE TRIGGER (\w+)[\s\S]*?END;/g))
      expected.set((match[1] ?? match[2])!, normalize(match[0]));
    const inventory = this.db.prepare('SELECT count(*) n,COALESCE(max(length(CAST(sql AS BLOB))),0) bytes FROM sqlite_schema').get() as {n:number;bytes:number};
    if(inventory.n !== 10 || inventory.bytes > 65536) throw new Error('Suppression schema bounds');
    const actual = this.db.prepare("SELECT type,name,sql FROM sqlite_schema ORDER BY name").all() as {type:string;name:string;sql:string|null}[];
    const auto = new Set(['sqlite_autoindex_suppression_authority_1', 'sqlite_autoindex_suppression_records_1', 'sqlite_autoindex_suppression_records_2', 'sqlite_autoindex_suppression_records_3']);
    for (const row of actual) {
      if (row.sql === null && row.type === 'index' && auto.delete(row.name)) continue;
      if (!row.sql || normalize(row.sql) !== expected.get(row.name)) throw new Error('Suppression schema mismatch');
      expected.delete(row.name);
    }
    if (expected.size || auto.size || this.db.pragma('integrity_check', {simple:true}) !== 'ok') throw new Error('Suppression schema/integrity mismatch');
    const layouts: Record<string, readonly [string,string,number,number][]> = {
      suppression_authority: [['identity','TEXT',0,1],['sequence','INTEGER',1,0]],
      suppression_records: [['sequence','INTEGER',0,1],['account_id','TEXT',1,0],['auth_user_id','TEXT',1,0],['epoch','INTEGER',1,0],['request_id','TEXT',1,0],['disabled_at_ms','INTEGER',1,0]],
    };
    for (const [table, layout] of Object.entries(layouts)) {
      const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as {name:string;type:string;notnull:number;pk:number;dflt_value:unknown}[];
      if (JSON.stringify(columns.map(c => [c.name,c.type,c.notnull,c.pk])) !== JSON.stringify(layout) || columns.some(c => c.dflt_value !== null)) throw new Error('Suppression columns mismatch');
    }
  }
  forEachRecord(apply: (entry: DisableRecord) => void, maximum = 100000): void {
    this.validateSchema(); const sequence = this.currentSequence();
    if (sequence > maximum) throw new Error('Suppression traversal capacity');
    let expected = 1;
    for (const row of this.db.prepare(`SELECT sequence,epoch,disabled_at_ms,
      CASE WHEN length(CAST(account_id AS BLOB)) BETWEEN 1 AND 256 THEN account_id ELSE NULL END account_id,
      CASE WHEN length(CAST(auth_user_id AS BLOB)) BETWEEN 1 AND 256 THEN auth_user_id ELSE NULL END auth_user_id,
      CASE WHEN length(CAST(request_id AS BLOB)) BETWEEN 1 AND 256 THEN request_id ELSE NULL END request_id
      FROM suppression_records ORDER BY sequence`).iterate() as Iterable<Row>) {
      const entry = record(row);
      if (entry.sequence !== expected++ || !entry.accountId || !entry.authUserId || !entry.requestId ||
        !Number.isSafeInteger(entry.epoch) || entry.epoch < 1 || !Number.isSafeInteger(entry.disabledAtMs) || entry.disabledAtMs < 0) throw new Error('Suppression record invalid');
      apply(Object.freeze(entry));
    }
    if (expected - 1 !== sequence) throw new Error('Suppression traversal changed');
  }
  close(): void { if (this.db.open) this.db.close(); }
}
