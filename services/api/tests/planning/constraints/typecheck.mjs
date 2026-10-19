import { closeSync, fstatSync, lstatSync, mkdtempSync, openSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { constants } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const donor = process.env.FORM_API_NODE_MODULES;
if (!donor) throw new Error('FORM_API_NODE_MODULES must name the verified read-only API dependencies');
const api = fileURLToPath(new URL('../../../', import.meta.url));
const config = JSON.parse(readFileSync(resolve(api, 'tsconfig.json'), 'utf8'));
const { outDir: _outDir, ...options } = config.compilerOptions;
if (options.incremental || options.composite) throw new Error('Incremental/composite compilation needs a separate output envelope');
const boundedConfig = {
  compilerOptions: {
    ...options, noEmit: true, rootDir: api,
    types: ['node'], typeRoots: [resolve(donor, '@types')],
    paths: { zod: [resolve(donor, 'zod/index.d.ts')] },
  },
  files: [resolve(api, 'src/planning/constraints/index.ts'), resolve(api, 'src/planning/constraints/first-plan-adapter.ts'),
    resolve(api, 'src/planning/constraints/confirmed-capture.ts')],
};
const contents = Buffer.from(JSON.stringify(boundedConfig));
if (contents.length > 2048) throw new Error('Typecheck config exceeds the approved 2 KiB limit');
const { default: getExePath } = await import(pathToFileURL(resolve(donor, 'typescript/lib/getExePath.js')).href);
const executable = getExePath();
const testRoot = fileURLToPath(new URL('./', import.meta.url));
let scratch, configPath, configIdentity, child, cancellation, spawnError;
let launchAttempted = false, childClosed = false, exitCode = 2;
const report = (phase, fields = {}) => console.error(JSON.stringify({ check: 'constraints-consumer-types', phase, ...fields }));
const cancel = signal => {
  if (cancellation) return;
  cancellation = signal;
  if (child) {
    try { child.kill(signal); }
    catch (error) { report('cancellation-unavailable', { code: error.code ?? 'unknown' }); }
  }
};
const interrupt = () => cancel('SIGINT'), terminate = () => cancel('SIGTERM');
process.on('SIGINT', interrupt);
process.on('SIGTERM', terminate);
try {
  scratch = mkdtempSync(resolve(testRoot, '.typecheck-'));
  configPath = resolve(scratch, 'tsconfig.json');
  const descriptor = openSync(configPath, 'wx', 0o600);
  try {
    configIdentity = fstatSync(descriptor);
    writeFileSync(descriptor, contents);
  } finally { closeSync(descriptor); }
  report('compiler-start', { executable, argv: ['--project', configPath], configBytes: contents.length });
  launchAttempted = true;
  child = spawn(executable, ['--project', configPath], { stdio: 'inherit' });
  child.once('error', error => { spawnError = error; });
  const result = await new Promise(resolveClose => child.once('close', (code, signal) => {
    childClosed = true;
    resolveClose({ code, signal });
  }));
  if (spawnError) {
    report('compiler-unavailable', { code: spawnError.code ?? 'unknown', message: spawnError.message });
    exitCode = 2;
  } else if (cancellation || result.signal) {
    report('compiler-interrupted', { requestedSignal: cancellation ?? null, observedSignal: result.signal });
    exitCode = 128 + (constants.signals[cancellation ?? result.signal] ?? 0);
  } else {
    exitCode = result.code ?? 2;
    report('compiler-exited', { code: result.code });
  }
} catch (error) {
  report('harness-failed', { code: error.code ?? 'unknown', message: error.message });
} finally {
  process.removeListener('SIGINT', interrupt);
  process.removeListener('SIGTERM', terminate);
  if (launchAttempted && !childClosed) {
    report('scratch-preserved', { configPath, reason: 'compiler effect or exit unknown' });
  } else if (scratch) {
    try {
      if (configIdentity) {
        const current = lstatSync(configPath);
        if (!current.isFile() || current.dev !== configIdentity.dev || current.ino !== configIdentity.ino) {
          throw new Error('Owned config identity changed; preserved without removal');
        }
        unlinkSync(configPath);
      }
      rmdirSync(scratch);
      report('scratch-removed', { configPath });
    } catch (error) {
      report('cleanup-failed', { configPath, message: error.message });
      if (exitCode === 0) exitCode = 2;
    }
  }
}
process.exitCode = exitCode;
