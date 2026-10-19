import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { assertExternalRuntimeDatabase } from '../src/runtime-path.js';

function fixture(run: (root: string) => void): void {
  const scratch = resolve('.scratch');
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, 'runtime-path-'));
  const cleanup = () => rmSync(root, { recursive: true, force: true });
  const interrupt = () => { cleanup(); process.exit(130); };
  const terminate = () => { cleanup(); process.exit(143); };
  process.once('SIGINT', interrupt); process.once('SIGTERM', terminate);
  try { run(root); }
  finally {
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', terminate);
    cleanup();
    assert.equal(existsSync(root), false);
  }
}
function directory(root: string, relative: string): string {
  const path = join(root, relative); mkdirSync(path, { recursive: true }); return path;
}

test('immutable release accepts external owned state despite an unrelated HOME repository', () => fixture(root => {
  directory(root, 'home/.git');
  const source = directory(root, 'home/.local/state/form-api/releases/revision/services/api');
  const data = directory(root, 'home/.local/state/form-api/data');
  assert.doesNotThrow(() => assertExternalRuntimeDatabase(join(data, 'form.sqlite'), source));
}));
test('actual application checkout rejects source, sibling data and exact checkout root', () => fixture(root => {
  const checkout = directory(root, 'Form'); directory(checkout, '.git');
  const source = directory(checkout, 'services/api');
  for (const path of [source, join(source, 'data.sqlite'), checkout, join(checkout, 'data/form.sqlite')]) {
    assert.throws(() => assertExternalRuntimeDatabase(path, source), /outside/);
  }
  assert.doesNotThrow(() => assertExternalRuntimeDatabase(join(root, 'Form-state/form.sqlite'), source));
}));
test('linked-worktree Git marker files retain the application checkout boundary', () => fixture(root => {
  const checkout = directory(root, 'Form-task');
  writeFileSync(join(checkout, '.git'), 'gitdir: synthetic-unused\n');
  const source = directory(checkout, 'services/api');
  assert.throws(() => assertExternalRuntimeDatabase(join(checkout, 'private/form.sqlite'), source), /Git checkout/);
}));
test('a standalone API source cannot contain runtime state without a Git marker', () => fixture(root => {
  const source = directory(root, 'standalone-api');
  assert.throws(() => assertExternalRuntimeDatabase(join(source, 'data/form.sqlite'), source), /API source/);
  assert.doesNotThrow(() => assertExternalRuntimeDatabase(join(root, 'standalone-api-state/form.sqlite'), source));
}));
test('database parent symlinks cannot move nominally external state into source', () => fixture(root => {
  const source = directory(root, 'Form/services/api');
  symlinkSync(source, join(root, 'data-link'), 'dir');
  assert.throws(() => assertExternalRuntimeDatabase(join(root, 'data-link/new/form.sqlite'), source), /API source/);
}));
test('an existing database symlink cannot point into source', () => fixture(root => {
  const source = directory(root, 'Form/services/api');
  writeFileSync(join(source, 'synthetic.sqlite'), 'synthetic');
  symlinkSync(join(source, 'synthetic.sqlite'), join(root, 'external.sqlite'));
  assert.throws(() => assertExternalRuntimeDatabase(join(root, 'external.sqlite'), source), /API source/);
}));
test('source symlinks are canonicalized and relative database paths are rejected', () => fixture(root => {
  const source = directory(root, 'Form/services/api'); directory(root, 'Form/.git');
  symlinkSync(source, join(root, 'source-link'), 'dir');
  assert.throws(() => assertExternalRuntimeDatabase(join(root, 'Form/data/form.sqlite'), join(root, 'source-link')), /Git checkout/);
  assert.throws(() => assertExternalRuntimeDatabase('form.sqlite', source), /absolute/);
}));
