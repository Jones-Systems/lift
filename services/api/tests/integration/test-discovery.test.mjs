import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { apiRoot, discoverSources, manifest, moduleArguments, runnerArguments } from '../../scripts/integration/test-discovery.mjs';

test('API test argv covers every current source module exactly once with the correct execution path', () => {
  const sources = discoverSources();
  const modules = moduleArguments();
  const fromArguments = modules.map(path => path.startsWith('dist/') ? path.slice(5, -3) + '.ts' : path);
  assert.deepEqual(fromArguments.sort(), sources);
  assert.equal(new Set(modules).size, sources.length);
  assert.deepEqual(runnerArguments(modules), ['--experimental-transform-types', '--import',
    new URL('../../scripts/integration/source-hook.mjs', import.meta.url).href, '--test', '--test-concurrency=1', ...modules]);
});

test('discovery retains every declared baseline source and accepted component group', () => {
  const selected = new Set(moduleArguments());
  for (const path of Object.values(manifest.groups).flat())
    assert.ok(selected.has(path.endsWith('.ts') ? `dist/${path.slice(0, -3)}.js` : path), path);
  for (const group of ['grounding', 'domain-features/nutrition', 'domain-features/cardio', 'domain-features/recovery',
    'usage-limits', 'bug-intake', 'voice-coaching', 'voice-coaching/realtime', 'wearables', 'wearables/persistence', 'direct-provider-transport'])
    assert.ok(manifest.groups[group]?.length > 0, group);
});

test('newly discovered sources execute without edits to the baseline manifest', () => {
  const sources = discoverSources();
  const appended = ['tests/new-component/addition.test.ts', 'tests/new-component/source.test.mjs', 'tests/new-component/portable.test.cjs'];
  const result = moduleArguments(manifest, [...sources, ...appended]);
  assert.deepEqual([...result].sort(), [...moduleArguments(), 'dist/tests/new-component/addition.test.js',
    'tests/new-component/source.test.mjs', 'tests/new-component/portable.test.cjs'].sort());
  const reduced = structuredClone(manifest); reduced.groups.grounding.pop();
  assert.deepEqual(moduleArguments(reduced), moduleArguments());
});

test('discovery refuses duplicated, invented or escaped baseline modules before test execution', () => {
  const changed = () => structuredClone(manifest);
  const duplicate = changed(); duplicate.groups.grounding.push(duplicate.groups.grounding[0]);
  assert.throws(() => moduleArguments(duplicate), /Duplicate test source/);
  const invented = changed(); invented.groups.future = ['tests/future/not-present.test.ts'];
  assert.throws(() => moduleArguments(invented), /Declared baseline test source is missing/);
  const escaped = changed(); escaped.groups.escaped = ['tests/../../elsewhere.test.ts'];
  assert.throws(() => moduleArguments(escaped), /Invalid test source path/);
});

test('package build publishes accepted grounding bytes and ordinary tests retain process isolation', () => {
  const pkg = JSON.parse(readFileSync(join(apiRoot, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.build, 'node node_modules/typescript/bin/tsc -p tsconfig.json && python3 -B scripts/grounding/build-projection.py && python3 -B scripts/grounding/build-form-coverage.py');
  assert.equal(manifest.groups.grounding.filter(path => path === 'tests/grounding/form-artifact.test.ts').length, 1);
  assert.ok(moduleArguments().includes('dist/tests/grounding/form-artifact.test.js'));
  assert.equal(pkg.scripts.test, 'node scripts/integration/test-discovery.mjs --run');
  assert.equal(pkg.scripts['test:list'], 'node scripts/integration/test-discovery.mjs --list');
  assert.equal(pkg.scripts['test:discovery'], 'node --test --test-isolation=none tests/integration/test-discovery.test.mjs');
  assert.equal(runnerArguments(moduleArguments()).some(arg => arg.includes('isolation')), false);
});
