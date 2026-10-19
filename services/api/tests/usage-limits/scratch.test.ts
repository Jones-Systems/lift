import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import test from 'node:test';

for (const mode of ['success', 'failure', 'cancel']) test(`fixture owns exact cleanup on ${mode}`, { timeout: 15_000 }, async t => {
  const child = fork(new URL('./scratch-probe.js', import.meta.url), [mode], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let root: string | undefined;
  let output = '';
  child.stdout!.on('data', data => { if (output.length < 8_192) output += String(data); });
  child.stderr!.on('data', data => { if (output.length < 8_192) output += String(data); });
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
    child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  t.signal.addEventListener('abort', () => { child.kill('SIGTERM'); }, { once: true });
  try {
    await new Promise<void>((resolve, reject) => {
      child.once('message', message => {
        root = (message as { root: string }).root;
        if (mode === 'cancel') child.kill('SIGTERM');
        resolve();
      });
      child.once('error', reject);
      child.once('exit', () => { if (!root) reject(new Error(`scratch probe exited before creating fixture: ${output}`)); });
    });
    const result = await exited;
    assert.equal(result.signal, null, output);
    assert.equal(result.code, mode === 'success' ? 0 : mode === 'failure' ? 1 : 143, output);
    assert.ok(root);
    assert.equal(existsSync(root), false, `fixture leaked ${root}`);
    if (mode === 'failure') assert.match(output, /intentional scratch probe failure/);
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await exited; }
    if (root && existsSync(root)) rmSync(root, { recursive: true, force: true });
  }
});
