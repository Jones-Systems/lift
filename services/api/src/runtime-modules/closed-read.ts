import Database from 'better-sqlite3';
import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, rmdirSync, unlinkSync, writeSync, type BigIntStats } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { AuthorityLock, assertClosedMain, assertIdentity, canonicalPath, sameIdentity, noFault, type FileIdentity, type FaultPoint } from './files.js';
import { migrationDigests } from './migrations.js';

const maxBytes = 1024 * 1024 * 1024, maxMs = 30000, maxSidecarBytes = 1024 * 1024;
const active = new WeakSet<AuthorityLock>(), held = new WeakSet<AuthorityLock>();
const suffixes = ['-wal', '-shm', '-journal'] as const;
// A source-only seam may lower bounds or supply a deterministic clock, never raise production ceilings.
export type ClosedReadBounds = { maxBytes?: number; maxMs?: number; now?: () => number };
function absent(path: string): boolean {
  try { lstatSync(path); return false; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true; throw error; }
}
export function assertStrictClosedMain(path: string): void {
  assertClosedMain(path);
  for (const suffix of suffixes) if (!absent(path + suffix)) throw new Error(`Closed main has unexpected SQLite sidecar: ${path + suffix}`);
}
function identity(stat: BigIntStats): FileIdentity { return {device:String(stat.dev), inode:String(stat.ino), uid:Number(stat.uid)}; }
function stable(a: BigIntStats, b: BigIntStats): boolean {
  return sameIdentity(identity(a), identity(b)) && a.mode === b.mode && a.nlink === b.nlink && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}
function receipts(db: Database.Database): string[] {
  if (db.pragma('integrity_check', {simple:true}) !== 'ok') throw new Error('Main integrity mismatch');
  const rows = db.prepare('SELECT version,checksum FROM form_migrations ORDER BY version LIMIT ?').all(migrationDigests.length + 1) as {version:number;checksum:string}[];
  if (rows.length < 7 || rows.length > migrationDigests.length || rows.some((row,index) => row.version !== index+1 || row.checksum !== migrationDigests[index])) throw new Error('Migration provenance mismatch');
  return rows.map(row => row.checksum);
}
function fail(errors: unknown[]): never {
  if (errors.length === 1) throw errors[0];
  throw new AggregateError(errors, 'Closed read failed; primary and cleanup/revalidation failures retained');
}

class Snapshot {
  private sourceFd: number | undefined;
  private snapshotFd: number | undefined;
  private db: Database.Database | undefined;
  private sourceStat: BigIntStats | undefined;
  private parent: FileIdentity | undefined;
  private parentMode = 0;
  private scratch: string | undefined;
  private scratchIdentity: FileIdentity | undefined;
  private mainIdentity: FileIdentity | undefined;
  private readonly sidecars = new Map<string, FileIdentity>();
  private readonly buffer = Buffer.alloc(65536);
  private readonly byteLimit: number;
  private readonly timeLimit: number;
  private readonly now: () => number;
  private startTime: number | undefined;
  private lastTime = -Infinity;
  constructor(private readonly lock: AuthorityLock, private readonly path: string, private readonly expected: FileIdentity,
    private readonly digest: string, private readonly fault: FaultPoint, bounds: ClosedReadBounds) {
    this.byteLimit = bounds.maxBytes ?? maxBytes; this.timeLimit = bounds.maxMs ?? maxMs; this.now = bounds.now ?? (() => performance.now());
    if (!Number.isSafeInteger(this.byteLimit) || this.byteLimit < 1 || this.byteLimit > maxBytes ||
      !Number.isFinite(this.timeLimit) || this.timeLimit <= 0 || this.timeLimit > maxMs || !/^[a-f0-9]{64}$/.test(digest)) throw new Error('Closed read bounds/binding mismatch');
  }
  private budget(): void {
    const now = this.now();
    if (!Number.isFinite(now) || now < this.lastTime) throw new Error('Closed read clock invalid');
    this.lastTime = now; this.startTime ??= now;
    if (now - this.startTime > this.timeLimit) throw new Error('Closed read cooperative budget exceeded');
  }
  private descriptor(fd: number, expected: FileIdentity): BigIntStats {
    const stat = fstatSync(fd, {bigint:true});
    if (!stat.isFile() || stat.nlink !== 1n || (stat.mode & 0o7777n) !== 0o600n || !sameIdentity(identity(stat), expected) ||
      stat.uid !== BigInt(this.lock.uid) || stat.size < 0n || stat.size > BigInt(this.byteLimit)) throw new Error('Closed read descriptor custody/size mismatch');
    return stat;
  }
  private source(): void {
    this.lock.assert(); assertIdentity(this.path, this.lock.uid, this.expected); assertStrictClosedMain(this.path);
    if (this.parent) {
      if (!sameIdentity(canonicalPath(dirname(this.path), this.lock.uid, true, this.parentMode), this.parent)) throw new Error('Closed read parent identity changed');
    }
    if (this.sourceFd !== undefined && this.sourceStat && !stable(this.sourceStat, this.descriptor(this.sourceFd, this.expected))) throw new Error('Closed read source metadata changed');
  }
  private hash(fd: number, expected: FileIdentity): string {
    this.budget(); const before = this.descriptor(fd, expected), size = Number(before.size), hash = createHash('sha256'); let offset = 0;
    while (offset < size) {
      this.budget(); const read = readSync(fd, this.buffer, 0, Math.min(this.buffer.length, size-offset), offset);
      if (!read) throw new Error('Closed read short hash read');
      hash.update(this.buffer.subarray(0, read)); offset += read; this.budget();
    }
    if (readSync(fd, this.buffer, 0, 1, size) !== 0 || !stable(before, this.descriptor(fd, expected))) throw new Error('Closed read hash growth/change');
    this.budget(); return hash.digest('hex');
  }
  private inventory(captureGenerated = false): void {
    if (!this.scratch || !this.scratchIdentity) return;
    this.lock.assert(); assertIdentity(this.scratch, this.lock.uid, this.scratchIdentity, true);
    if (this.mainIdentity) assertIdentity(join(this.scratch, 'main.sqlite'), this.lock.uid, this.mainIdentity);
    let total = 0n;
    for (const name of readdirSync(this.scratch)) {
      const path = join(this.scratch, name);
      if (name === 'main.sqlite') {
        if (!this.mainIdentity) throw new Error(`Uncaptured snapshot main: ${path}`);
        assertIdentity(path, this.lock.uid, this.mainIdentity); continue;
      }
      if (name !== 'main.sqlite-wal' && name !== 'main.sqlite-shm') throw new Error(`Unknown closed-read scratch retained: ${path}`);
      const stat = lstatSync(path, {bigint:true});
      if (!stat.isFile() || stat.nlink !== 1n || stat.uid !== BigInt(this.lock.uid) || (stat.mode & 0o7777n) !== 0o600n) throw new Error(`Unproved closed-read sidecar retained: ${path}`);
      const value = identity(stat), captured = this.sidecars.get(name);
      if (!captured && !captureGenerated) throw new Error(`Uncaptured closed-read sidecar retained: ${path}`);
      if (captured && !sameIdentity(captured, value)) throw new Error(`Changed closed-read sidecar retained: ${path}`);
      this.sidecars.set(name, value); total += stat.size;
      if (name === 'main.sqlite-wal' && stat.size !== 0n) throw new Error(`Nonempty snapshot WAL retained: ${path}`);
    }
    if (total > BigInt(maxSidecarBytes)) throw new Error(`Snapshot sidecar bound exceeded: ${this.scratch}`);
  }
  open(): Database.Database {
    this.budget(); this.source();
    const parentStat = lstatSync(dirname(this.path), {bigint:true}); this.parentMode = Number(parentStat.mode & 0o7777n);
    this.parent = canonicalPath(dirname(this.path), this.lock.uid, true, this.parentMode);
    this.sourceFd = openSync(this.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    this.sourceStat = this.descriptor(this.sourceFd, this.expected); this.source(); this.fault('closed-read:source-held'); this.budget(); this.source();
    const prior = readdirSync(this.lock.lockPath).find(name => name.startsWith('.closed-read-'));
    if (prior) throw new Error(`Prior closed-read scratch retained: ${join(this.lock.lockPath, prior)}`);
    const scratch = join(this.lock.lockPath, `.closed-read-${randomUUID()}`);
    mkdirSync(scratch, {mode:0o700}); this.scratch = scratch; this.scratchIdentity = canonicalPath(scratch, this.lock.uid, true);
    this.fault('closed-read:allocated'); this.budget(); this.lock.assert(); assertIdentity(scratch, this.lock.uid, this.scratchIdentity, true);
    const main = join(scratch, 'main.sqlite');
    this.snapshotFd = openSync(main, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    this.mainIdentity = identity(fstatSync(this.snapshotFd, {bigint:true})); this.descriptor(this.snapshotFd, this.mainIdentity);
    if (sameIdentity(this.mainIdentity, this.expected)) throw new Error('Snapshot aliases source');
    const hash = createHash('sha256'), size = Number(this.sourceStat.size); let offset = 0;
    while (offset < size) {
      this.budget(); this.fault('closed-read:copy');
      const read = readSync(this.sourceFd, this.buffer, 0, Math.min(this.buffer.length, size-offset), offset);
      if (!read) throw new Error('Closed read short source read');
      hash.update(this.buffer.subarray(0, read)); let written = 0;
      while (written < read) { this.budget(); const count = writeSync(this.snapshotFd, this.buffer, written, read-written, offset+written);
        if (!count) throw new Error('Closed read short snapshot write'); written += count; }
      offset += read; this.fault('closed-read:copied-chunk'); this.budget();
    }
    if (readSync(this.sourceFd, this.buffer, 0, 1, size) !== 0 || hash.digest('hex') !== this.digest ||
      this.descriptor(this.snapshotFd, this.mainIdentity).size !== BigInt(size) || this.hash(this.snapshotFd, this.mainIdentity) !== this.digest) throw new Error('Closed read copy digest/size/growth mismatch');
    this.source(); this.inventory(); this.fault('closed-read:before-open'); this.budget(); this.source(); this.inventory();
    this.db = new Database(main, {readonly:true, fileMustExist:true, timeout:0}); this.inventory(true); this.budget();
    this.db.pragma('temp_store = MEMORY'); this.db.pragma('cache_size = -2048'); this.db.pragma('mmap_size = 0');
    if (this.db.pragma('temp_store', {simple:true}) !== 2 || this.db.pragma('cache_size', {simple:true}) !== -2048 || this.db.pragma('mmap_size', {simple:true}) !== 0) throw new Error('Snapshot local resource settings mismatch');
    this.inventory(true); this.fault('closed-read:inspection'); this.budget(); this.source(); this.inventory(); return this.db;
  }
  afterInspection(): void { this.budget(); this.inventory(true); this.source(); }
  finish(): unknown[] {
    const errors: unknown[] = []; let closed = true;
    const attempt = (work: () => void): void => { try { work(); } catch (error) { errors.push(error); } };
    if (this.db) { try { this.db.close(); } catch (error) { errors.push(error); closed = false; } }
    attempt(() => this.fault('closed-read:after-close'));
    attempt(() => this.inventory(this.db !== undefined));
    if (closed && this.snapshotFd !== undefined && this.mainIdentity) attempt(() => {
      if (this.hash(this.snapshotFd!, this.mainIdentity!) !== this.digest) throw new Error('Snapshot bytes changed during inspection');
    });
    if (this.snapshotFd !== undefined) { try { closeSync(this.snapshotFd); this.snapshotFd = undefined; } catch (error) { errors.push(error); closed = false; } }
    if (closed) attempt(() => this.cleanup());
    else if (this.scratch) errors.push(new Error(`Unclosed snapshot retained: ${this.scratch}`));
    // Final descriptor digest and path/parent/lock checks happen after cleanup and before success.
    attempt(() => { this.fault('closed-read:before-final'); this.budget(); this.source();
      if (this.sourceFd !== undefined && this.hash(this.sourceFd, this.expected) !== this.digest) throw new Error('Closed read final source digest mismatch');
      this.source(); this.budget(); });
    if (this.sourceFd !== undefined) attempt(() => { closeSync(this.sourceFd!); this.sourceFd = undefined; });
    return errors;
  }
  private cleanup(): void {
    if (!this.scratch) return;
    this.fault('closed-read:cleanup');
    if (!this.scratchIdentity) throw new Error(`Unproved snapshot directory retained: ${this.scratch}`);
    this.inventory();
    const names = readdirSync(this.scratch);
    // Prevalidate the entire captured inventory before removing any member; unknown objects remain held.
    for (const name of names) {
      const expected = name === 'main.sqlite' ? this.mainIdentity : this.sidecars.get(name);
      if (!expected) throw new Error(`Uncaptured snapshot object retained: ${join(this.scratch, name)}`);
      assertIdentity(join(this.scratch, name), this.lock.uid, expected);
    }
    for (const name of names) {
      this.lock.assert(); assertIdentity(this.scratch, this.lock.uid, this.scratchIdentity, true);
      assertIdentity(join(this.scratch, name), this.lock.uid, name === 'main.sqlite' ? this.mainIdentity! : this.sidecars.get(name)!);
      unlinkSync(join(this.scratch, name));
    }
    this.lock.assert(); assertIdentity(this.scratch, this.lock.uid, this.scratchIdentity, true);
    rmdirSync(this.scratch); if (!absent(this.scratch)) throw new Error(`Snapshot cleanup unproved: ${this.scratch}`);
  }
}
function acquire(lock: AuthorityLock): void {
  if (!(lock instanceof AuthorityLock)) throw new Error('Closed read requires actual authority lock');
  lock.assert();
  if (active.has(lock) || held.has(lock)) throw new Error('Closed read owner active or held');
  active.add(lock);
}
export function readClosedReceipts(lock: AuthorityLock, path: string, expected: FileIdentity, digest: string,
  fault: FaultPoint = noFault, bounds: ClosedReadBounds = {}): string[] {
  acquire(lock); let snapshot: Snapshot | undefined, result: string[] | undefined; const errors: unknown[] = [];
  try { snapshot = new Snapshot(lock,path,expected,digest,fault,bounds); result = receipts(snapshot.open()); snapshot.afterInspection(); }
  catch (error) { errors.push(error); }
  finally { if (snapshot) errors.push(...snapshot.finish()); active.delete(lock); if (errors.length) held.add(lock); }
  if (errors.length) fail(errors);
  if (!result) throw new Error('Closed read result absent'); return result;
}
// Only the closed-storage consumer borrows this connection; its awaited settlement precedes all teardown.
// The cooperative deadline/cache settings do not forcibly interrupt native calls or cap total native memory.
export async function withClosedStorageSnapshot<T>(lock: AuthorityLock, path: string, expected: FileIdentity, digest: string,
  operation: (db: Database.Database) => Promise<T>, fault: FaultPoint = noFault, bounds: ClosedReadBounds = {}): Promise<T> {
  acquire(lock); let snapshot: Snapshot | undefined, result: T | undefined; const errors: unknown[] = [];
  try { snapshot = new Snapshot(lock,path,expected,digest,fault,bounds); result = await operation(snapshot.open()); snapshot.afterInspection(); }
  catch (error) { errors.push(error); }
  finally { if (snapshot) errors.push(...snapshot.finish()); active.delete(lock); if (errors.length) held.add(lock); }
  if (errors.length) fail(errors); return result as T;
}
