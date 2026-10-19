import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

mkdirSync(resolve('.scratch'), { recursive: true });
mkdirSync(resolve('evidence'), { recursive: true });
const scratch = mkdtempSync(join(resolve('.scratch'), 'audit-'));
let child;
const stop = signal => child?.kill(signal);
const sigint = () => stop('SIGINT'), sigterm = () => stop('SIGTERM');
process.on('SIGINT', sigint); process.on('SIGTERM', sigterm);
try {
  child = spawn('npm', ['audit', '--omit=dev', '--json', '--cache', join(scratch, 'cache')], {
    stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, TMPDIR: scratch },
  });
  const chunks = []; let bytes = 0;
  child.stdout.on('data', chunk => {
    bytes += chunk.length;
    if (bytes > 1024 * 1024) child.kill('SIGTERM'); else chunks.push(chunk);
  });
  const code = await new Promise((accept, reject) => {
    child.once('error', reject); child.once('exit', code => accept(code ?? 1));
  });
  const audit = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  writeFileSync(resolve('evidence/npm-audit-production.json'), JSON.stringify({
    observedAt: new Date().toISOString(), command: 'npm audit --omit=dev --json', exitCode: code, audit,
  }, null, 2) + '\n');
  console.log(JSON.stringify({ exitCode: code, vulnerabilities: audit.metadata?.vulnerabilities ?? null }));
  process.exitCode = code;
} finally {
  process.off('SIGINT', sigint); process.off('SIGTERM', sigterm);
  rmSync(scratch, { recursive: true, force: true });
}
