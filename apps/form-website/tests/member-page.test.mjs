import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { memberPages } from '../src/member-page.mjs';
import { applicationPages } from '../src/application-page.mjs';

const publicRoot = fileURLToPath(new URL('../public/', import.meta.url));
async function importsFrom(entry, visited = new Set()) {
  const path = resolve(publicRoot, entry);
  if (visited.has(path)) return visited;
  assert.ok(path.startsWith(publicRoot));
  visited.add(path);
  const source = await readFile(path, 'utf8');
  for (const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)['"](\.[^'"]+)['"]/g)) {
    const target = resolve(dirname(path), match[1]);
    await importsFrom(target, visited);
  }
  return visited;
}

test('fictional workspace has a distinct mount, entry and persistent disclosure', () => {
  const [{ path, html }] = memberPages();
  assert.equal(path, 'app/sample/index.html');
  assert.match(html, /fictional data in this tab/);
  assert.match(html, /nothing is saved/);
  assert.match(html, /data-member-sample/);
  assert.match(html, /\/assets\/member-sample\/sample-entry.mjs/);
  assert.doesNotMatch(html, /type="password"|data-application/);
  assert.doesNotMatch(applicationPages()[0].html, /member-sample|data-member-sample/);
});

test('production application import graph cannot load a sample transport or entry', async () => {
  const files = await importsFrom('application-entry.mjs');
  assert.ok(files.size > 4);
  assert.ok([...files].every(path => !path.includes('/member-sample/')));
  const entry = await readFile(resolve(publicRoot, 'application-entry.mjs'), 'utf8');
  assert.doesNotMatch(entry, /createConfiguredBrowserSession|runtime-config|fetch\s*\(/);
});

test('sample composition uses the synthetic factory and never calls the configured session factory', async () => {
  const files = await importsFrom('member-sample/sample-entry.mjs');
  const sampleSources = await Promise.all([...files].filter(path => path.includes('/member-sample/')).map(path => readFile(path, 'utf8')));
  const code = sampleSources.join('\n');
  assert.match(code, /createSyntheticApplicationController/);
  assert.doesNotMatch(code, /createConfiguredBrowserSession|createConfiguredApplicationController|localStorage|sessionStorage/);
});
