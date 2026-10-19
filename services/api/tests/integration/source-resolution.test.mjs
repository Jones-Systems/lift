import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { apiRoot } from '../../scripts/integration/test-discovery.mjs';
import { createSourceResolver } from '../../scripts/integration/source-resolution.mjs';

function fixture(run) {
  const directory = mkdtempSync(join(apiRoot, '.test-source-resolution-'));
  try {
    const root = join(directory, 'source'); mkdirSync(root);
    const parent = join(root, 'parent.ts'); writeFileSync(parent, 'export {};');
    const target = join(root, 'target.ts'); writeFileSync(target, 'export {};');
    const original = Object.assign(new Error('missing original module'), { code: 'ERR_MODULE_NOT_FOUND' });
    const calls = [];
    const next = specifier => {
      calls.push(specifier);
      if (specifier.startsWith('file:')) return { url: specifier, format: 'module' };
      throw original;
    };
    return run({ directory, root, parent, target, original, calls, next,
      context: { parentURL: pathToFileURL(parent).href }, resolver: createSourceResolver([root]) });
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

test('test resolver maps only a missing relative JS source import to its canonical TS identity', () => fixture(h => {
  assert.deepEqual(h.resolver('./target.js', h.context, h.next), { url: pathToFileURL(h.target).href, format: 'module' });
  assert.deepEqual(h.calls, ['./target.js', pathToFileURL(h.target).href]);
  const native = { url: 'file:///already-resolved.js', format: 'module' };
  assert.equal(h.resolver('./target.js', h.context, () => native), native);
  const otherError = Object.assign(new Error('denied'), { code: 'ERR_ACCESS_DENIED' });
  assert.throws(() => h.resolver('./target.js', h.context, () => { throw otherError; }), error => error === otherError);
}));

test('test resolver preserves missing errors for unknown, escaped, encoded and non-source requests', () => fixture(h => {
  writeFileSync(join(h.directory, 'outside.ts'), 'export {};');
  for (const specifier of ['./absent.js', '../outside.js', './%74arget.js', './target.js?x', './target.js#x',
    './target\\.js', 'target.js', '/target.js', './target.mjs']) {
    assert.throws(() => h.resolver(specifier, h.context, h.next), error => error === h.original, specifier);
  }
  for (const parentURL of [pathToFileURL(join(h.directory, 'outside.ts')).href, pathToFileURL(join(h.root, 'parent.js')).href,
    'https://example.invalid/parent.ts']) {
    assert.throws(() => h.resolver('./target.js', { parentURL }, h.next), error => error === h.original);
  }
}));

test('test resolver refuses symlink files, directories, parents and roots', () => fixture(h => {
  symlinkSync(h.target, join(h.root, 'linked.ts'));
  assert.throws(() => h.resolver('./linked.js', h.context, h.next), /refuses symlinks/);
  mkdirSync(join(h.root, 'nested')); writeFileSync(join(h.root, 'nested', 'child.ts'), 'export {};');
  symlinkSync(join(h.root, 'nested'), join(h.root, 'alias'));
  assert.throws(() => h.resolver('./alias/child.js', h.context, h.next), /refuses symlinks/);
  symlinkSync(h.parent, join(h.root, 'linked-parent.ts'));
  assert.throws(() => h.resolver('./target.js', { parentURL: pathToFileURL(join(h.root, 'linked-parent.ts')).href }, h.next), /refuses symlinks/);
  const alias = join(h.directory, 'alias'); symlinkSync(h.root, alias);
  assert.throws(() => createSourceResolver([alias])('./target.js', { parentURL: pathToFileURL(join(alias, 'parent.ts')).href }, h.next), /refuses symlink roots/);
}));

test('runner hook loads both source roots and preserves DomainError identity with parameter properties', () => {
  const source = relative => new URL(relative, import.meta.url).href;
  const script = `
    import assert from 'node:assert/strict';
    import { DomainError } from ${JSON.stringify(source('../../src/errors.ts'))};
    import { suppressionAuthority } from ${JSON.stringify(source('../../src/lifecycle/guards.ts'))};
    import ${JSON.stringify(source('../../src/wearables/providers/oauth.ts'))};
    import ${JSON.stringify(source('../../src/wearables/direct-provider-transport/index.ts'))};
    import ${JSON.stringify(source('../../../../apps/form/src/wearables/importer.ts'))};
    assert.throws(() => suppressionAuthority({}), error => error instanceof DomainError &&
      error.status === 503 && error.code === 'suppression_authority_required');
  `;
  const child = spawnSync(process.execPath, ['--experimental-transform-types', '--import',
    source('../../scripts/integration/source-hook.mjs'), '--input-type=module', '--eval', script],
  { cwd: apiRoot, encoding: 'utf8', timeout: 10000 });
  assert.ifError(child.error);
  assert.equal(child.signal, null);
  assert.equal(child.status, 0, child.stderr);
});
