import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import type { PackagedFormFollowupProjection } from '../../src/grounding/packaged-form-artifact.js';

const digest = '8fcb4cd3ac9a1edf1140fb591b731e74172095a7b534d758fb5f8d30d027de10';
const authentic = fs.readFileSync(new URL(`../../grounding/${digest}/projection.json`, import.meta.url));
assert.equal(authentic.byteLength, 80588);
assert.equal(createHash('sha256').update(authentic).digest('hex'), digest);
const emitted = fs.readFileSync(new URL('../../src/grounding/packaged-form-artifact.js', import.meta.url));
const scratchParent = fileURLToPath(new URL('../../../tests/grounding/', import.meta.url));
type Layout = { root: string; artifact: string; read: () => Promise<PackagedFormFollowupProjection> };

async function withLayout(body: (layout: Layout) => Promise<void>, depth = 0): Promise<void> {
  const root = fs.mkdtempSync(`${scratchParent}.packaged-form-test-`);
  const cleanup = () => fs.rmSync(root, { recursive: true, force: true });
  const interrupt = () => { cleanup(); process.exit(130); };
  const terminate = () => { cleanup(); process.exit(143); };
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', terminate);
  let bodyFailed = false;
  let bodyError: unknown;
  try {
    const packageRoot = root + '/deep'.repeat(depth);
    const modulePath = `${packageRoot}/dist/src/grounding/packaged-form-artifact.mjs`;
    const artifact = `${packageRoot}/dist/grounding/${digest}/projection.json`;
    fs.mkdirSync(`${packageRoot}/dist/src/grounding`, { recursive: true });
    fs.mkdirSync(`${packageRoot}/dist/grounding/${digest}`, { recursive: true });
    fs.writeFileSync(modulePath, emitted);
    const loaded = await import(pathToFileURL(modulePath).href) as {
      readPackagedFormFollowupProjection: () => Promise<PackagedFormFollowupProjection>;
    };
    await body({ root, artifact, read: loaded.readPackagedFormFollowupProjection });
  } catch (error) {
    bodyFailed = true;
    bodyError = error;
    throw error;
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', terminate);
    try {
      cleanup();
      assert.equal(fs.existsSync(root), false);
    } catch (error) {
      if (bodyFailed) throw new AggregateError([bodyError, error], 'fixture failure followed by cleanup failure', { cause: bodyError });
      throw error;
    }
  }
}

function watchDescriptors(): { opened: number[]; closed: number[]; identities: { dev: number; ino: number }[] } {
  const opened: number[] = [];
  const closed: number[] = [];
  const identities: { dev: number; ino: number }[] = [];
  const open = fs.openSync;
  const close = fs.closeSync;
  mock.method(fs, 'openSync', (...args: Parameters<typeof fs.openSync>) => {
    const descriptor = open(...args);
    opened.push(descriptor);
    const { dev, ino } = fs.fstatSync(descriptor);
    identities.push({ dev, ino });
    return descriptor;
  });
  mock.method(fs, 'closeSync', (descriptor: number) => {
    closed.push(descriptor);
    close(descriptor);
  });
  syncBuiltinESMExports();
  return { opened, closed, identities };
}

function assertClosed(handles: { opened: number[]; closed: number[] }): void {
  assert.ok(handles.opened.length <= 64);
  assert.deepEqual(handles.closed, [...handles.opened].reverse());
  for (const descriptor of handles.opened) assert.throws(() => fs.fstatSync(descriptor), { code: 'EBADF' });
}

test('fixed packaged bytes are authenticated, independently owned, and all handles close', async () => {
  await withLayout(async ({ artifact, read }) => {
    fs.writeFileSync(artifact, authentic);
    const handles = watchDescriptors();
    const first = await read();
    assert.equal(first.status, 'available');
    if (first.status !== 'available') assert.fail('qualified Linux package unavailable');
    assert.deepEqual(first.projectionBytes, new Uint8Array(authentic));
    assert.ok(Object.isFrozen(first));
    assertClosed(handles);
    mock.restoreAll(); syncBuiltinESMExports();
    first.projectionBytes.fill(0);
    const second = await read();
    assert.equal(second.status, 'available');
    if (second.status === 'available') assert.deepEqual(second.projectionBytes, new Uint8Array(authentic));
  });
});

test('missing, historical, truncated, oversized and same-length adulterated files return only unavailable', async () => {
  const historical = fs.readFileSync(new URL('../../../tests/grounding/fixtures/form-followup-historical-twenty-five.json', import.meta.url));
  assert.equal(historical.byteLength, 76175);
  assert.equal(createHash('sha256').update(historical).digest('hex'), 'd542be0c5e2fe23330c17d3302146c309e8d0410c12b250c82500792be223e40');
  for (const bytes of [undefined, historical, authentic.subarray(0, -1), Buffer.concat([authentic, Buffer.from('x')]), Buffer.alloc(80588)]) {
    await withLayout(async ({ artifact, read }) => {
      if (bytes) fs.writeFileSync(artifact, bytes);
      const handles = watchDescriptors();
      assert.deepEqual(await read(), { status: 'unavailable' });
      assertClosed(handles);
    });
  }
});

test('directories and FIFO are rejected without reading or blocking', async (t) => {
  for (const kind of ['directory', 'fifo']) {
    await withLayout(async ({ artifact, read }) => {
      if (kind === 'directory') fs.mkdirSync(artifact);
      else {
        assert.throws(() => fs.lstatSync(artifact), { code: 'ENOENT' });
        try {
          execFileSync('/usr/bin/mkfifo', [artifact], { timeout: 5000 });
        } catch (error) {
          assert.ok(error instanceof Error);
          const result = error as Error & {
            code?: unknown; errno?: unknown; syscall?: unknown; path?: unknown;
            spawnargs?: unknown; status?: unknown; signal?: unknown; pid?: unknown;
          };
          assert.equal(result.code, 'EPERM');
          assert.equal(result.errno, -1);
          assert.equal(result.syscall, 'spawnSync /usr/bin/mkfifo');
          assert.equal(result.path, '/usr/bin/mkfifo');
          assert.deepEqual(result.spawnargs, [artifact]);
          assert.equal(result.status, 0);
          assert.equal(result.signal, null);
          assert.ok(typeof result.pid === 'number' && Number.isSafeInteger(result.pid) && result.pid > 0);
          t.diagnostic(JSON.stringify({
            fixtureCompletion: 'owned FIFO postcondition required after successful exit with reported EPERM',
            code: result.code, errno: result.errno, syscall: result.syscall, path: result.path,
            spawnargs: result.spawnargs, status: result.status, signal: result.signal, pid: result.pid,
          }));
        }
        const created = fs.lstatSync(artifact);
        assert.equal(created.isSymbolicLink(), false);
        assert.equal(created.isFIFO(), true);
        const ownerUid = process.getuid?.();
        assert.equal(typeof ownerUid, 'number');
        assert.equal(created.uid, ownerUid);
      }
      const handles = watchDescriptors();
      let reads = 0;
      mock.method(fs, 'readSync', () => { reads++; throw new Error('nonregular read'); });
      syncBuiltinESMExports();
      assert.deepEqual(await read(), { status: 'unavailable' });
      assert.equal(reads, 0);
      assertClosed(handles);
    });
  }
});

test('final and ancestor symlinks never open or read their donor targets', async () => {
  for (const component of ['file', 'digest', 'grounding']) {
    await withLayout(async ({ root, artifact, read }) => {
      const donor = `${root}/donor`;
      fs.mkdirSync(donor);
      fs.writeFileSync(`${donor}/projection.json`, authentic);
      let link = artifact;
      let target = `${donor}/projection.json`;
      if (component === 'digest') {
        link = `${root}/dist/grounding/${digest}`;
        target = donor;
        fs.rmdirSync(link);
      } else if (component === 'grounding') {
        link = `${root}/dist/grounding`;
        target = donor;
        fs.mkdirSync(`${donor}/${digest}`);
        fs.writeFileSync(`${donor}/${digest}/projection.json`, authentic);
        fs.rmSync(link, { recursive: true });
      }
      fs.symlinkSync(target, link);
      const donorStat = fs.statSync(target);
      const handles = watchDescriptors();
      let reads = 0;
      mock.method(fs, 'readSync', () => { reads++; throw new Error('symlink donor read'); });
      syncBuiltinESMExports();
      assert.deepEqual(await read(), { status: 'unavailable' });
      assert.equal(reads, 0);
      assert.equal(handles.identities.some(({ dev, ino }) => dev === donorStat.dev && ino === donorStat.ino), false);
      assertClosed(handles);
    });
  }
});

test('renaming an opened ancestor and replacing its name with a symlink cannot redirect the read', async () => {
  await withLayout(async ({ root, artifact, read }) => {
    fs.writeFileSync(artifact, authentic);
    const donor = `${root}/donor`;
    fs.mkdirSync(`${donor}/${digest}`, { recursive: true });
    fs.writeFileSync(`${donor}/${digest}/projection.json`, Buffer.alloc(80588));
    const open = fs.openSync;
    const opened: number[] = [];
    const closed: number[] = [];
    const close = fs.closeSync;
    const ancestor = fs.statSync(`${root}/dist/grounding`);
    let swapped = false;
    mock.method(fs, 'openSync', (...args: Parameters<typeof fs.openSync>) => {
      const descriptor = open(...args);
      opened.push(descriptor);
      const identity = fs.fstatSync(descriptor);
      if (!swapped && identity.dev === ancestor.dev && identity.ino === ancestor.ino) {
        swapped = true;
        fs.renameSync(`${root}/dist/grounding`, `${root}/held-grounding`);
        fs.symlinkSync(donor, `${root}/dist/grounding`);
      }
      return descriptor;
    });
    mock.method(fs, 'closeSync', (descriptor: number) => { closed.push(descriptor); close(descriptor); });
    syncBuiltinESMExports();
    const result = await read();
    assert.equal(swapped, true);
    assert.equal(result.status, 'available');
    if (result.status === 'available') assert.deepEqual(result.projectionBytes, new Uint8Array(authentic));
    assertClosed({ opened, closed });
  });
});

test('growth after initial stat is rejected with reads bounded to the expected size plus one', async () => {
  await withLayout(async ({ artifact, read }) => {
    fs.writeFileSync(artifact, authentic);
    const writer = fs.openSync(artifact, 'r+');
    const nativeClose = fs.closeSync;
    try {
      const handles = watchDescriptors();
      const nativeRead = fs.readSync;
      let grown = false;
      let requested = 0;
      mock.method(fs, 'readSync', (descriptor: number, buffer: Uint8Array, offset: number, length: number, position: number) => {
        assert.equal(buffer.byteLength, 80589);
        requested += length;
        if (!grown) {
          grown = true;
          fs.writeSync(writer, 'x', 80588, 'utf8');
        }
        return nativeRead(descriptor, buffer, offset, length, position);
      });
      syncBuiltinESMExports();
      assert.deepEqual(await read(), { status: 'unavailable' });
      assert.equal(requested, 80589);
      assertClosed(handles);
    } finally {
      nativeClose(writer);
    }
  });
});

test('I/O and cancellation-shaped failures close every descriptor; close failure never publishes bytes', async () => {
  for (const route of ['open', 'read', 'abort', 'close']) {
    await withLayout(async ({ artifact, read }) => {
      fs.writeFileSync(artifact, authentic);
      const handles = watchDescriptors();
      if (route === 'open') {
        const trackedOpen = fs.openSync;
        mock.method(fs, 'openSync', (...args: Parameters<typeof fs.openSync>) => {
          if (String(args[0]).endsWith('/projection.json')) throw new Error('synthetic I/O');
          return trackedOpen(...args);
        });
      } else if (route === 'close') {
        const trackedClose = fs.closeSync;
        mock.method(fs, 'closeSync', (descriptor: number) => { trackedClose(descriptor); throw new Error('synthetic close failure'); });
      } else {
        mock.method(fs, 'readSync', () => { throw Object.assign(new Error('synthetic read failure'), { name: route === 'abort' ? 'AbortError' : 'Error' }); });
      }
      syncBuiltinESMExports();
      assert.deepEqual(await read(), { status: 'unavailable' });
      assertClosed(handles);
    });
  }
});

test('unavailable native procfs capability fails closed before package access', async () => {
  await withLayout(async ({ artifact, read }) => {
    fs.writeFileSync(artifact, authentic);
    const handles = watchDescriptors();
    mock.method(fs, 'statfsSync', () => { throw new Error('procfs unavailable'); });
    syncBuiltinESMExports();
    assert.deepEqual(await read(), { status: 'unavailable' });
    assert.deepEqual(handles.opened, []);
  });
});

test('over-depth module-derived package path is rejected before opening any handle', async () => {
  await withLayout(async ({ artifact, read }) => {
    fs.writeFileSync(artifact, authentic);
    const handles = watchDescriptors();
    assert.deepEqual(await read(), { status: 'unavailable' });
    assert.deepEqual(handles.opened, []);
  }, 64);
});

test('owned fixture cleanup survives body failure and handled cancellation signals', async () => {
  let failedRoot = '';
  const failure = new Error('deliberate fixture failure');
  await assert.rejects(withLayout(async ({ root }) => {
    failedRoot = root;
    throw failure;
  }), error => error === failure);
  assert.equal(fs.existsSync(failedRoot), false);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    await withLayout(async ({ root }) => {
      const stopped = new Error('intercepted owned process exit');
      let exitCode: number | string | null | undefined;
      mock.method(process, 'exit', (code?: number | string | null): never => {
        exitCode = code;
        throw stopped;
      });
      assert.throws(() => process.emit(signal), error => error === stopped);
      assert.equal(exitCode, signal === 'SIGINT' ? 130 : 143);
      assert.equal(fs.existsSync(root), false);
    });
  }
});
