import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

const parent = resolve('.scratch');
mkdirSync(parent, { recursive: true });
const scratch = mkdtempSync(join(parent, 'install-'));
const cache = join(scratch, 'cache');
let child;
let signal;
const interrupt = name => {
  signal = name;
  child?.kill(name);
};
const sigint = () => interrupt('SIGINT');
const sigterm = () => interrupt('SIGTERM');
process.on('SIGINT', sigint);
process.on('SIGTERM', sigterm);
try {
  child = spawn('npm', ['install', '--cache', cache, '--no-fund', '--no-audit'], {
    stdio: 'inherit', env: { ...process.env, TMPDIR: scratch, npm_config_cache: cache },
  });
  process.exitCode = await new Promise((accept, reject) => {
    child.once('error', reject);
    child.once('exit', (code, exitSignal) => accept(code ?? (exitSignal ? 130 : 1)));
  });
  if (signal) process.exitCode = signal === 'SIGINT' ? 130 : 143;
} finally {
  process.off('SIGINT', sigint); process.off('SIGTERM', sigterm);
  rmSync(scratch, { recursive: true, force: true });
}
