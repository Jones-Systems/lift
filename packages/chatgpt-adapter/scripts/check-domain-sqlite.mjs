import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync, lstatSync, realpathSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const apiRoot = resolve(packageRoot, '../../services/api');
const hash = value => createHash('sha256').update(value).digest('hex');
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const failure = (message, exitCode = 1) => Object.assign(new Error(message), { exitCode });
const admissionCollector = '/path/to/Form';

// WS01's exact PR65 lock adds only an unused TS5 test alias; the API graph and seven native donors retain their original binding.
export function qualifiedApiLock(bytes, originalSha256) {
  const digest = hash(bytes);
  return digest === originalSha256 ||
    (originalSha256 === '4b276382c3c4491bc4f31a9fed20addfe59bbcc8146174aaadc6c3b7b3cc3419' &&
     digest === 'eebbbca2644b14cc6b93aae2ce34674a48282726db95cdb9d545028e3e208040');
}

export function admissionDecision(document) {
  const admission = document?.admission, measured = admission?.measurements;
  const number = (value, minimum, maximum = Infinity) => typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum;
  const cpu = measured?.cpu_used_percent, ram = measured?.ram_available_gib, core = measured?.one_fully_used_core_percent;
  const valid = document?.schema === 'work-capacity-admission/v1' && ['ok', 'partial'].includes(document.status) &&
    Array.isArray(document.errors) && document.errors.length === 0 &&
    number(cpu, 0, 100) && number(ram, 0) && number(core, Number.MIN_VALUE);
  return { status: valid ? document.status : 'unavailable',
    cpuUsedPercent: number(cpu, 0, 100) ? cpu : null,
    ramAvailableGiB: number(ram, 0) ? ram : null,
    oneCorePercent: number(core, Number.MIN_VALUE) ? core : null,
    starts: valid && cpu < 85 && admission.serial_test_process_ceiling === 1 && admission.broad_test_allowed === true ? 1 : 0 };
}

async function requireAdmission(run, label) {
  let document;
  try {
    const output = await run('python3', ['-B', admissionCollector, '--format', 'admission'], process.env,
      { capture: true, timeoutMs: 10000 });
    document = JSON.parse(output);
  } catch (error) {
    console.log(`${label} admission: CPU unavailable; RAM unavailable; one core unavailable; starts 0`);
    throw failure('Fresh admission collection failed; next workload not started', error.exitCode ?? 1);
  }
  const decision = admissionDecision(document);
  const display = value => value === null ? 'unavailable' : value.toFixed(2);
  console.log(`${label} admission (${decision.status}): CPU ${display(decision.cpuUsedPercent)}% used; ` +
    `RAM ${display(decision.ramAvailableGiB)} GiB available; one fully used core ${display(decision.oneCorePercent)}% of capacity; starts ${decision.starts}`);
  if (decision.starts !== 1) throw failure('Fresh admission denied; next workload not started');
}

// Only this invocation's captured root is disposable; dependency links never transfer donor ownership.
export async function withOwnedScratch(work, remove = root => rmSync(root, { recursive: true })) {
  const root = mkdtempSync(join(packageRoot, '.scratch-api-'));
  const controller = new AbortController();
  let child, childClosed, primary, closed = false;
  const cancel = signal => {
    if (!controller.signal.aborted) controller.abort(failure(`Cancelled: ${signal}`, signal === 'SIGINT' ? 130 : 143));
    child?.kill('SIGTERM');
  };
  const interrupt = () => cancel('SIGINT'), terminate = () => cancel('SIGTERM');
  process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
  process.on('disconnect', terminate);
  const run = async (command, args, env = process.env, { capture = false, timeoutMs } = {}) => {
    if (closed || child) throw failure('Scratch commands must be awaited sequentially within their scope');
    controller.signal.throwIfAborted();
    return await new Promise((accept, reject) => {
      let spawnError, output = '', bytes = 0;
      child = spawn(command, args, { cwd: root, env, stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
      childClosed = new Promise(finished => child.once('close', finished));
      const timer = timeoutMs === undefined ? undefined : setTimeout(() => {
        spawnError = failure('Admission collector deadline exceeded'); child?.kill('SIGTERM');
      }, timeoutMs);
      if (capture) for (const [stream, retain] of [[child.stdout, true], [child.stderr, false]]) stream.on('data', data => {
        bytes += data.length;
        if (bytes > 65536) { spawnError = failure('Admission collector output exceeded 64 KiB'); child?.kill('SIGTERM'); }
        else if (retain) output += data.toString('utf8');
      });
      child.once('error', error => { spawnError = error; });
      child.once('close', (code, signal) => {
        clearTimeout(timer);
        child = undefined;
        if (controller.signal.aborted) reject(controller.signal.reason);
        else if (spawnError) reject(spawnError);
        else if (code === 0) accept(output);
        else reject(failure(`Child failed: ${signal ?? code}`, code || 1));
      });
    });
  };
  try {
    await work({ root, run, signal: controller.signal });
    controller.signal.throwIfAborted();
  } catch (error) { primary = error; }
  finally {
    closed = true;
    if (child) { child.kill('SIGTERM'); await childClosed; }
    try { remove(root); }
    catch (error) {
      primary = Object.assign(new AggregateError([...(primary ? [primary] : []), error], 'Scratch cleanup failed'),
        { exitCode: primary?.exitCode ?? 1 });
    }
    process.off('SIGINT', interrupt); process.off('SIGTERM', terminate); process.off('disconnect', terminate);
  }
  if (primary) throw primary;
}

function treeDigest(base) {
  const rows = [];
  function walk(path) {
    for (const name of readdirSync(path).sort()) {
      const entry = join(path, name), stat = lstatSync(entry);
      if (stat.isSymbolicLink()) throw failure('Dependency contains an unbound symlink');
      if (stat.isDirectory()) walk(entry);
      else if (stat.isFile()) rows.push([relative(base, entry).split('\\').join('/'), hash(readFileSync(entry))]);
      else throw failure('Unexpected dependency file kind');
    }
  }
  walk(base);
  return hash(rows.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([name, digest]) => `${name}\0${digest}\n`).join(''));
}

function snapshot(root) {
  const binding = json(join(packageRoot, 'tests/api-source-binding.json'));
  if (process.platform !== binding.platform || process.arch !== binding.arch || Number(process.versions.node.split('.')[0]) < 24) {
    throw failure('Qualified Linux x64 / Node >=24 dependency environment required');
  }
  if (!qualifiedApiLock(readFileSync(join(apiRoot, 'package-lock.json')), binding.apiLockSha256)) throw failure('API lock binding changed');
  const lock = json(join(apiRoot, 'package-lock.json'));
  if (realpathSync(binding.donor) !== binding.donor) throw failure('Donor root identity changed');
  for (const [name, expected] of Object.entries(binding.dependencies)) {
    const base = join(binding.donor, name), metadata = json(join(base, 'package.json'));
    const locked = lock.packages[`node_modules/${name}`];
    if (metadata.name !== name || metadata.version !== expected.version || locked.version !== expected.version ||
        locked.integrity !== expected.integrity || treeDigest(base) !== expected.treeSha256) throw failure(`Dependency binding changed: ${name}`);
    const link = join(root, 'node_modules', name);
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(base, link, 'dir');
  }
  for (const [name, expected] of Object.entries(binding.sources)) {
    const data = readFileSync(join(apiRoot, name));
    if (hash(data) !== expected) throw failure(`Qualified API source changed: ${name}`);
    const output = join(root, name);
    mkdirSync(dirname(output), { recursive: true }); writeFileSync(output, data);
  }
  writeFileSync(join(root, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
    target: 'ES2023', module: 'NodeNext', moduleResolution: 'NodeNext', lib: ['ES2023', 'DOM', 'DOM.Iterable'],
    strict: true, noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true, esModuleInterop: true,
    skipLibCheck: true, types: ['node'], rootDir: '.', outDir: 'dist', noEmitOnError: true,
  }, files: Object.keys(binding.sources) }));
  return binding;
}

async function main(mode) {
  if (!['--all', '--integration', '--probe-success', '--probe-failure', '--probe-wait', '--probe-child'].includes(mode)) {
    throw failure('Expected --all or --integration');
  }
  await withOwnedScratch(async ({ root, run, signal }) => {
    if (mode.startsWith('--probe-')) {
      writeFileSync(join(root, 'owned.txt'), 'synthetic lifecycle probe');
      process.send?.({ root });
      if (mode === '--probe-failure') throw failure('Synthetic primary failure', 23);
      if (mode === '--probe-child') await run(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
      if (mode === '--probe-wait') await new Promise((_, reject) => {
        const stopped = () => reject(signal.reason);
        if (signal.aborted) stopped(); else signal.addEventListener('abort', stopped, { once: true });
      });
      return;
    }
    const binding = snapshot(root);
    await requireAdmission(run, 'API compiler');
    await run(join(binding.donor, '@typescript/typescript-linux-x64/lib/tsc'), ['--project', join(root, 'tsconfig.json')]);
    writeFileSync(join(root, 'provenance.json'), JSON.stringify({ sourceRevision: binding.sourceRevision,
      bindingSha256: hash(readFileSync(join(packageRoot, 'tests/api-source-binding.json'))) }));
    const modules = mode === '--all' ? ['adapter.test.mjs', 'domain-ports.test.mjs', 'mcp-handler.test.mjs', 'oauth-resource.test.mjs', 'domain-sqlite.test.mjs'] : ['domain-sqlite.test.mjs'];
    console.log(`Qualified API source ${binding.sourceRevision}; isolated graph ${root}`);
    await requireAdmission(run, 'Serial test union');
    await run(process.execPath, ['--test', '--test-isolation=none', '--test-concurrency=1', ...modules.map(name => join(packageRoot, 'tests', name))],
      { ...process.env, FORM_CHATGPT_TEST_API_ROOT: root });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await main(process.argv[2]); }
  catch (error) { console.error(error); process.exitCode = error.exitCode ?? 1; }
  finally { if (process.connected) process.disconnect(); }
}
