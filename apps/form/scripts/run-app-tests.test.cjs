const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { selectTests, runSuite } = require('./run-app-tests.cjs');

const transport = 'scripts/test-api-transport.cjs';
const phone = 'src/api/tests/phone-signin.test.cjs';

test('tracked discovery covers all app areas, excludes fixture modules, and deduplicates transport', () => {
  const files = [transport, phone, 'src/integration/tests/a.test.cjs', 'src/body/__tests__/b.test.cjs',
    'scripts/runner.test.cjs', 'src/tests/fixtures/fake.test.cjs', 'src/__fixtures__/fake.test.cjs'];
  const result = selectTests([...files, phone]);
  assert.equal(result.modules.length, 4);
  assert.equal(result.omitted.length, 2);
  assert.deepEqual(result.entrypoints, result.modules);
  assert.equal(result.transport.embeddedBy, phone);
  const fallback = selectTests(files.filter(file => file !== phone));
  assert.equal(fallback.entrypoints.filter(file => file === transport).length, 1);
  assert.throws(() => selectTests([transport]), /No tracked/);
  assert.throws(() => selectTests([phone]), /Missing tracked/);
  const phoneSource = fs.readFileSync(path.resolve(__dirname, '..', phone), 'utf8');
  assert.match(phoneSource, /scripts\/test-api-transport\.cjs/);
  assert.match(phoneSource, /new Function\('require', fs\.readFileSync\(transportTests, 'utf8'\)\)/);
});

function fixture(t, compiler = "require('node:fs').writeFileSync(require('node:path').join(process.argv.at(-1), 'transport.js'), 'module.exports = 42;');") {
  const fallback = path.resolve(__dirname, '../.scratch');
  const parent = process.env.TMPDIR?.startsWith(fallback + path.sep) ? process.env.TMPDIR : fallback;
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'runner-check-'));
  t.after(() => fs.rmSync(root, { recursive: true }));
  fs.mkdirSync(path.join(root, 'node_modules/typescript/bin'), { recursive: true });
  fs.writeFileSync(path.join(root, 'node_modules/typescript/bin/tsc'), compiler);
  fs.writeFileSync(path.join(root, 'case.test.cjs'), "require('node:assert/strict').equal(require('./.scratch/api-tests/transport.js'), 42);");
  return root;
}

test('successful compilation and serial test execution clean only owned scratch', async t => {
  const root = fixture(t);
  assert.equal(await runSuite(root, ['case.test.cjs']), 0);
  assert.deepEqual(fs.readdirSync(path.join(root, '.scratch')), []);
});

test('compiler failure preserves its status and cleans scratch without starting tests', async t => {
  const root = fixture(t, 'process.exitCode = 7;');
  fs.writeFileSync(path.join(root, 'case.test.cjs'), "require('node:fs').writeFileSync('unexpected', 'ran');");
  assert.equal(await runSuite(root, ['case.test.cjs']), 7);
  assert.equal(fs.existsSync(path.join(root, 'unexpected')), false);
  assert.deepEqual(fs.readdirSync(path.join(root, '.scratch')), []);
});

test('test failure preserves nonzero status and cleans scratch', async t => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, 'case.test.cjs'), 'throw new Error("intentional fixture failure");');
  assert.equal(await runSuite(root, ['case.test.cjs']), 1);
  assert.deepEqual(fs.readdirSync(path.join(root, '.scratch')), []);
});

test('an existing compatibility path is preserved and the new invocation cleans its own root', async t => {
  const root = fixture(t);
  const foreign = path.join(root, '.scratch/api-tests');
  fs.mkdirSync(foreign, { recursive: true });
  fs.writeFileSync(path.join(foreign, 'sentinel'), 'owned elsewhere');
  assert.equal(await runSuite(root, ['case.test.cjs']), 1);
  assert.equal(fs.readFileSync(path.join(foreign, 'sentinel'), 'utf8'), 'owned elsewhere');
  assert.deepEqual(fs.readdirSync(path.dirname(foreign)), ['api-tests']);
});

test('cleanup ownership failure cannot hide the original compiler failure', async t => {
  const root = fixture(t, `const fs = require('node:fs');
    fs.unlinkSync('.scratch/api-tests');
    fs.mkdirSync('.scratch/api-tests');
    process.exitCode = 7;`);
  assert.equal(await runSuite(root, ['case.test.cjs']), 7);
  assert.ok(fs.statSync(path.join(root, '.scratch/api-tests')).isDirectory());
});

test('a concurrent invocation refuses the reserved path without removing the active root', async t => {
  const root = fixture(t);
  const active = runSuite(root, ['case.test.cjs']);
  const reserved = fs.readlinkSync(path.join(root, '.scratch/api-tests'));
  assert.equal(await runSuite(root, ['case.test.cjs']), 1);
  assert.ok(fs.existsSync(reserved));
  assert.equal(await active, 0);
  assert.deepEqual(fs.readdirSync(path.join(root, '.scratch')), []);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  test(`${signal} cancellation cleans scratch and returns the signal exit status`, async t => {
    const root = fixture(t, "process.stdout.write('compiler-ready\\n'); setInterval(() => {}, 1000);");
    const launcher = path.join(root, 'launch.cjs');
    fs.writeFileSync(launcher, `require(${JSON.stringify(require.resolve('./run-app-tests.cjs'))}).runSuite(__dirname, ['case.test.cjs']).then(code => { process.exitCode = code; });`);
    const child = spawn(process.execPath, [launcher], { stdio: ['ignore', 'pipe', 'pipe'] });
    const closed = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, killedBy) => resolve({ code, killedBy }));
    });
    const timer = setTimeout(() => child.kill('SIGTERM'), 10000);
    t.after(() => clearTimeout(timer));
    await new Promise((resolve, reject) => {
      child.stdout.once('data', resolve);
      child.once('error', reject);
      child.once('exit', () => reject(new Error('Fixture exited before readiness')));
    });
    child.kill(signal);
    assert.deepEqual(await closed, { code: signal === 'SIGINT' ? 130 : 143, killedBy: null });
    assert.deepEqual(fs.readdirSync(path.join(root, '.scratch')), []);
  });
}
