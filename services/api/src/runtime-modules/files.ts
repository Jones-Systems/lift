import { constants, closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { strictJson } from './configuration.js';
export const identitySchema = z.object({ device: z.string().regex(/^\d+$/), inode: z.string().regex(/^\d+$/), uid: z.number().int().nonnegative().safe() }).strict();
export type FileIdentity = z.infer<typeof identitySchema>;
export type FaultPoint = (point: string) => void;
export const noFault: FaultPoint = () => {};
export function lexicalPath(path: string): void {
  if (!isAbsolute(path) || resolve(path) !== path || path.includes('\0')) throw new Error('Noncanonical path');
}
export function canonicalPath(path: string, uid: number, directory = false, mode = directory ? 0o700 : 0o600): FileIdentity {
  lexicalPath(path);
  let cursor = path;
  for (;;) {
    const stat = lstatSync(cursor, { bigint: true });
    if (stat.isSymbolicLink()) throw new Error('Symlink component');
    if (cursor !== path && (!stat.isDirectory() || (Number(stat.mode) & 0o022) !== 0)) throw new Error('Writable path ancestor');
    const parent = dirname(cursor); if (cursor === parent) break; cursor = parent;
  }
  const stat = lstatSync(path, { bigint: true });
  if (realpathSync(path) !== path || (directory ? !stat.isDirectory() : !stat.isFile()) ||
    (!directory && stat.nlink !== 1n) || Number(stat.uid) !== uid || (Number(stat.mode) & 0o7777) !== mode) throw new Error('File custody mismatch');
  return { device: String(stat.dev), inode: String(stat.ino), uid: Number(stat.uid) };
}
export function sameIdentity(a: FileIdentity, b: FileIdentity): boolean { return a.device === b.device && a.inode === b.inode && a.uid === b.uid; }
export function assertIdentity(path: string, uid: number, expected: FileIdentity, directory = false): void {
  if (!sameIdentity(canonicalPath(path, uid, directory), expected)) throw new Error('File identity changed');
}
export function syncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
export function assertSeparate(authority: string, main: string): void {
  lexicalPath(authority); lexicalPath(main);
  const backupTree = join(dirname(main), 'backups');
  if (authority === main || main.startsWith(authority + sep) || authority === backupTree || authority.startsWith(backupTree + sep)) throw new Error('Authority intersects main backup custody');
}
export function fileDigest(path: string, uid: number, maxBytes = 1024 * 1024 * 1024, maxMs = 30000): string {
  const expected = canonicalPath(path, uid); const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const start = performance.now();
  try {
    const stat = fstatSync(fd, { bigint: true });
    if (String(stat.ino) !== expected.inode || String(stat.dev) !== expected.device || stat.size > BigInt(maxBytes)) throw new Error('Hash custody/budget mismatch');
    const hash = createHash('sha256'), buffer = Buffer.alloc(65536); let bytes = 0;
    for (;;) { const size = readSync(fd, buffer, 0, buffer.length, null); if (!size) break; bytes += size;
      if (bytes > maxBytes || performance.now() - start > maxMs) throw new Error('Hash budget exceeded'); hash.update(buffer.subarray(0, size)); }
    const after = fstatSync(fd, { bigint: true });
    if (after.size !== stat.size || after.mtimeNs !== stat.mtimeNs || after.ctimeNs !== stat.ctimeNs) throw new Error('File changed while hashing');
    assertIdentity(path, uid, expected); return hash.digest('hex');
  } finally { closeSync(fd); }
}
export function assertClosedMain(path: string): void {
  for (const suffix of ['-wal', '-shm', '-journal']) if (existsSync(path + suffix)) throw new Error('Closed main has unexpected SQLite sidecar');
}
export function syncFile(path: string, uid: number): void {
  const expected = canonicalPath(path, uid), fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const stat = fstatSync(fd, { bigint: true }); if (String(stat.ino) !== expected.inode || String(stat.dev) !== expected.device) throw new Error('File replaced'); fsyncSync(fd); }
  finally { closeSync(fd); }
  assertIdentity(path, uid, expected); syncDirectory(dirname(path));
}
export class JsonFile<T> {
  private identity: FileIdentity;
  private digest: string;
  private failed = false;
  constructor(readonly path: string, private readonly uid: number, private readonly schema: z.ZodType<T>, private readonly fault: FaultPoint = noFault) {
    this.identity = canonicalPath(path, uid); this.digest = fileDigest(path, uid, 65536); this.read();
  }
  private bytes(): string {
    if (this.failed) throw new Error('Authority file latched');
    assertIdentity(this.path, this.uid, this.identity);
    const fd = openSync(this.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(fd, { bigint: true });
      if (String(stat.ino) !== this.identity.inode || String(stat.dev) !== this.identity.device || stat.size > 65536n) throw new Error('Authority record custody/bounds');
      const buffer = Buffer.alloc(Number(stat.size)); let offset = 0;
      while (offset < buffer.length) { const read = readSync(fd, buffer, offset, buffer.length - offset, offset); if (!read) throw new Error('Short authority read'); offset += read; }
      const bytes = new TextDecoder('utf-8',{fatal:true}).decode(buffer); if (createHash('sha256').update(bytes).digest('hex') !== this.digest) throw new Error('Authority record externally changed');
      assertIdentity(this.path, this.uid, this.identity); return bytes;
    } catch (error) { this.failed = true; throw error; } finally { closeSync(fd); }
  }
  read(): T { try { return this.schema.parse(strictJson(this.bytes())); } catch (error) { this.failed = true; throw error; } }
  replace(value: T, label: string): void {
    this.read(); const bytes = JSON.stringify(this.schema.parse(value)) + '\n'; if (Buffer.byteLength(bytes) > 65536) throw new Error('Authority record bounds');
    const temporary = join(dirname(this.path), `.replace-${randomUUID()}`); let fd: number | undefined;
    try {
      this.fault(`${label}:before-write`); fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      writeFileSync(fd, bytes); this.fault(`${label}:before-fsync`); fsyncSync(fd); this.fault(`${label}:after-fsync`); closeSync(fd); fd = undefined;
      this.read(); renameSync(temporary, this.path); this.fault(`${label}:after-rename`); syncDirectory(dirname(this.path)); this.fault(`${label}:after-directory-fsync`);
      this.identity = canonicalPath(this.path, this.uid); this.digest = createHash('sha256').update(bytes).digest('hex');
      if (this.bytes() !== bytes) throw new Error('Authority replace readback');
    } catch (error) { this.failed = true; throw error; } finally { if (fd !== undefined) closeSync(fd); }
  }
  static create<T>(path: string, uid: number, schema: z.ZodType<T>, value: T, fault: FaultPoint = noFault): JsonFile<T> {
    const bytes = JSON.stringify(schema.parse(value)) + '\n'; if (Buffer.byteLength(bytes) > 65536) throw new Error('Authority bounds');
    const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
    syncDirectory(dirname(path)); return new JsonFile(path, uid, schema, fault);
  }
}
export class AuthorityLock {
  readonly directoryIdentity: FileIdentity;
  readonly lockPath: string;
  private readonly nonce = randomUUID();
  private readonly lockIdentity: FileIdentity;
  private readonly record: JsonFile<{ nonce: string; operationId: string }>;
  private released = false;
  constructor(readonly directory: string, readonly uid: number, operationId: string) {
    this.directoryIdentity = canonicalPath(directory, uid, true);
    this.lockPath = join(directory, 'owner.lock'); mkdirSync(this.lockPath, { mode: 0o700 }); syncDirectory(directory);
    this.lockIdentity = canonicalPath(this.lockPath, uid, true);
    this.record = JsonFile.create(join(this.lockPath, 'owner.json'), uid, z.object({ nonce: z.uuid(), operationId: z.uuid() }).strict(), { nonce: this.nonce, operationId });
    syncDirectory(this.lockPath);
  }
  assert(): void {
    if (this.released) throw new Error('Authority owner closed');
    assertIdentity(this.directory, this.uid, this.directoryIdentity, true); assertIdentity(this.lockPath, this.uid, this.lockIdentity, true);
    if (this.record.read().nonce !== this.nonce) throw new Error('Authority lock ownership lost');
  }
  release(): void {
    if (this.released) return; this.assert(); unlinkSync(join(this.lockPath, 'owner.json')); syncDirectory(this.lockPath);
    rmdirSync(this.lockPath); syncDirectory(this.directory); this.released = true;
  }
}
