import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const apiRoot = fileURLToPath(new URL('../../', import.meta.url));
export const manifest = JSON.parse(readFileSync(new URL('./test-modules.json', import.meta.url), 'utf8'));
const suffix = /\.test\.(?:ts|mjs|cjs)$/;

export function discoverSources(root = apiRoot) {
  const found = [];
  const walk = relative => {
    for (const entry of readdirSync(join(root, relative), { withFileTypes: true })) {
      const path = `${relative}/${entry.name}`;
      assert.ok(!entry.isSymbolicLink(), `Test discovery refuses symlinks: ${path}`);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && suffix.test(entry.name)) found.push(path);
    }
  };
  walk('tests');
  return found.sort();
}

export function moduleArguments(contract = manifest, sources = discoverSources()) {
  assert.equal(contract.schema, 'form.api-test-discovery/v1');
  const baseline = Object.values(contract.groups).flat();
  const safe = path => typeof path === 'string' && path.startsWith('tests/') && suffix.test(path) &&
    !path.includes('\\') && path.split('/').every(part => part !== '' && part !== '.' && part !== '..');
  assert.ok([...baseline, ...sources].every(safe), 'Invalid test source path');
  assert.equal(new Set(baseline).size, baseline.length, 'Duplicate test source');
  assert.equal(new Set(sources).size, sources.length, 'Duplicate discovered source');
  const actual = new Set(sources);
  for (const path of baseline) assert.ok(actual.has(path), `Declared baseline test source is missing: ${path}`);
  const args = [...sources].sort().map(path => path.endsWith('.ts') ? `dist/${path.slice(0, -3)}.js` : path);
  assert.equal(new Set(args).size, args.length, 'Duplicate test invocation');
  return args;
}

export function runnerArguments(modules) {
  return ['--experimental-transform-types', '--import', new URL('./source-hook.mjs', import.meta.url).href,
    '--test', '--test-concurrency=1', ...modules];
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2];
  assert.ok(process.argv.length === 3 && ['--list', '--run'].includes(mode), 'Use --list or --run');
  const modules = moduleArguments();
  const args = runnerArguments(modules);
  if (mode === '--list') {
    process.stdout.write(JSON.stringify({ cwd: apiRoot, executable: process.execPath, moduleCount: modules.length, argv: args }, null, 2) + '\n');
  } else {
    for (const path of modules) assert.ok(existsSync(join(apiRoot, path)), `Missing test module; run npm run build: ${path}`);
    const child = spawn(process.execPath, args, { cwd: apiRoot, stdio: 'inherit' });
    const interrupt = () => child.kill('SIGINT');
    const terminate = () => child.kill('SIGTERM');
    process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
    child.on('error', error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
    child.on('close', (code, signal) => {
      process.off('SIGINT', interrupt); process.off('SIGTERM', terminate);
      process.exitCode = code ?? (signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1);
    });
  }
}
