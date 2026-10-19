const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');

const appRoot = path.resolve(__dirname, '..');
const standalone = 'scripts/test-api-transport.cjs';
const embeddedBy = 'src/api/tests/phone-signin.test.cjs';

function selectTests(tracked) {
  const candidates = [...new Set(tracked.filter(file => file.endsWith('.test.cjs')))].sort();
  const omitted = candidates.filter(file => file.split('/').some(part =>
    ['fixtures', '__fixtures__', 'node_modules', '.scratch'].includes(part)));
  const modules = candidates.filter(file => !omitted.includes(file));
  if (!modules.length) throw new Error('No tracked APP CJS test modules found.');
  if (!tracked.includes(standalone)) throw new Error('Missing tracked standalone transport suite.');
  const embedded = modules.includes(embeddedBy);
  return {
    modules,
    entrypoints: embedded ? modules : [...modules, standalone],
    omitted,
    transport: { path: standalone, embeddedBy: embedded ? embeddedBy : null },
  };
}

function discover(root = appRoot) {
  const tracked = execFileSync('git', ['ls-files', '-z', '--', '.'], { cwd: root, encoding: 'utf8' })
    .split('\0').filter(Boolean);
  return selectTests(tracked);
}

async function runSuite(root, entrypoints) {
  const parent = path.join(root, '.scratch');
  fs.mkdirSync(parent, { recursive: true });
  const scratch = fs.mkdtempSync(path.join(parent, 'app-tests-'));
  const legacyOutput = path.join(parent, 'api-tests');
  let ownsLink = false;
  let child;
  let cancelled = 0;
  let status = 0;
  const handlers = new Map(['SIGINT', 'SIGTERM', 'SIGHUP'].map((signal, index) => [signal, () => {
    cancelled ||= [130, 143, 129][index];
    if (child) {
      try {
        // Only the process group created by this invocation is signalled.
        if (process.platform === 'win32') child.kill(signal);
        else process.kill(-child.pid, signal);
      } catch (error) { if (error.code !== 'ESRCH') console.error(error); }
    }
  }]));
  for (const [signal, handler] of handlers) process.on(signal, handler);
  const run = args => new Promise((resolve, reject) => {
    if (cancelled) return resolve(cancelled);
    const env = { ...process.env, TMPDIR: scratch, TMP: scratch, TEMP: scratch };
    // A harness regression may itself run under node:test; its child must be
    // an independent runner, rather than silently skipping recursive discovery.
    delete env.NODE_TEST_CONTEXT;
    child = spawn(process.execPath, args, {
      cwd: root, stdio: 'inherit', detached: process.platform !== 'win32',
      env,
    });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      child = undefined;
      resolve(cancelled || code || (signal ? 1 : 0));
    });
  });
  try {
    // The unchanged standalone suite requires this compatibility path. An
    // exclusive symlink reserves it; existing scratch is never replaced.
    fs.symlinkSync(scratch, legacyOutput, 'dir');
    ownsLink = true;
    status = await run(['node_modules/typescript/bin/tsc', 'src/api/transport.ts',
      '--target', 'ES2022', '--module', 'commonjs', '--strict', '--skipLibCheck',
      '--lib', 'ES2022,DOM', '--outDir', scratch]);
    if (!status) status = await run(['--test', '--test-concurrency=1', ...entrypoints]);
  } catch (error) {
    console.error(error);
    status = cancelled || 1;
  } finally {
    try {
      if (ownsLink) {
        if (!fs.lstatSync(legacyOutput).isSymbolicLink() || fs.readlinkSync(legacyOutput) !== scratch)
          throw new Error('APP test scratch ownership changed; reconcile before cleanup.');
        fs.unlinkSync(legacyOutput);
      }
      fs.rmSync(scratch, { recursive: true });
    } catch (error) {
      console.error('APP test cleanup failed:', error);
      status ||= 1;
    }
    for (const [signal, handler] of handlers) process.removeListener(signal, handler);
  }
  return cancelled || status;
}

async function main(args) {
  if (args.length && (args.length !== 1 || args[0] !== '--list'))
    throw new Error('Usage: node scripts/run-app-tests.cjs [--list]');
  const receipt = discover();
  if (args[0] === '--list') {
    process.stdout.write(JSON.stringify(receipt, null, 2) + '\n');
    return 0;
  }
  return runSuite(appRoot, receipt.entrypoints);
}

module.exports = { selectTests, discover, runSuite };
if (require.main === module) main(process.argv.slice(2)).then(code => { process.exitCode = code; }, error => {
  console.error(error);
  process.exitCode = 1;
});
