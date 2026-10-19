const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const output = path.join(root, '.scratch/api-tests');
const apiTests = fs.readdirSync(path.join(root, 'src/api/tests'))
  .filter(name => name.endsWith('.test.cjs')).sort()
  .map(name => path.join('src/api/tests', name));
// Exact task-owned generated path only; refuse an unexplained previous writer.
if (fs.existsSync(output)) throw new Error('Reconcile existing .scratch/api-tests before testing.');
fs.mkdirSync(output, { recursive: true });
function run(args) {
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  return result.status ?? 1;
}
try {
  const compiled = run(['node_modules/typescript/bin/tsc', 'src/api/transport.ts', '--target', 'ES2022', '--module', 'commonjs', '--strict', '--skipLibCheck', '--lib', 'ES2022,DOM', '--outDir', '.scratch/api-tests']);
  // The phone suite embeds every transport case against the in-memory module.
  // Keep the standalone suite as the fallback without running those cases twice.
  const selectedTests = apiTests.includes(path.join('src/api/tests', 'phone-signin.test.cjs'))
    ? apiTests : ['scripts/test-api-transport.cjs', ...apiTests];
  process.exitCode = compiled || run(['--test', '--test-concurrency=1', ...selectedTests]);
} finally {
  const generated = path.join(output, 'transport.js');
  if (fs.existsSync(generated)) fs.unlinkSync(generated);
  fs.rmdirSync(output);
}
