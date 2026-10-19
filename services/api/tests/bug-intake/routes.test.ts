import assert from 'node:assert/strict';
import test from 'node:test';
import { bugIntakeLimits } from '../../src/bug-intake/index.js';
import { fixture, input } from './fixture.js';

const headers = { Authorization: 'Bearer synthetic-A', 'Content-Type': 'application/json', 'Idempotency-Key': 'request-key-A' };
const root = '/v1/bug-reports';

test('request context controls submission and owner-only read/list with private headers', async t => {
  const f = fixture(); t.after(f.close);
  const anonymous = await f.app.request(root); assert.equal(anonymous.status, 401);
  assert.deepEqual(await anonymous.json(), { error: { code: 'authentication_required' } });
  assert.equal(anonymous.headers.get('cache-control'), 'no-store');
  const response = await f.app.request(root, { method: 'POST', headers, body: JSON.stringify(input) });
  assert.equal(response.status, 201); assert.equal(response.headers.get('cache-control'), 'no-store');
  const value = await response.json() as { report: { id: string; state: string } };
  assert.equal(value.report.state, 'received');
  const replay = await f.app.request(root, { method: 'POST', headers, body: JSON.stringify(input) }); assert.equal(replay.status, 200);
  const other = await f.app.request(`${root}/${value.report.id}`, { headers: { Authorization: 'Bearer synthetic-B' } }); assert.equal(other.status, 404);
  const own = await f.app.request(`${root}/${value.report.id}`, { headers }); assert.equal(own.status, 200);
  const list = await f.app.request(root, { headers: { Authorization: 'Bearer synthetic-B' } });
  assert.deepEqual(await list.json(), { reports: [] });
  const conflict = await f.app.request(root, { method: 'POST', headers, body: JSON.stringify({ ...input, title: 'Different report' }) }); assert.equal(conflict.status, 409);
  assert.equal((await f.app.request(`${root}/${value.report.id}/dispatch`, { method: 'POST', headers })).status, 404);
});

test('bounded body and query reject oversized, malformed, duplicate and unknown inputs', async t => {
  const f = fixture(); t.after(f.close);
  for (const [data, expected] of [['{', 400], ['x'.repeat(bugIntakeLimits.bodyBytes + 1), 413], [JSON.stringify({ ...input, healthData: 'private' }), 422]] as const) {
    assert.equal((await f.app.request(root, { method: 'POST', headers, body: data })).status, expected);
  }
  assert.equal((await f.app.request(root, { method: 'POST', headers: { ...headers, 'Content-Type': 'text/plain' }, body: '{}' })).status, 415);
  assert.equal((await f.app.request(root, { method: 'POST', headers: { ...headers, 'Idempotency-Key': 'bad' }, body: JSON.stringify(input) })).status, 400);
  for (const query of ['?limit=0', '?limit=51', '?limit=2&limit=3', '?after=x&after=y', '?accountId=account-B', '?limit=2e1']) {
    assert.equal((await f.app.request(`${root}${query}`, { headers })).status, 400);
  }
  assert.equal(f.A.list().length, 0);
});

test('body stream size is enforced without trusting Content-Length', async t => {
  const f = fixture(); t.after(f.close);
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) { controller.enqueue(new Uint8Array(8192).fill(32)); },
    cancel() { cancelled = true; },
  });
  const request = new Request(`http://localhost${root}`, { method: 'POST', headers: { ...headers, 'Content-Length': '2' }, body: stream, duplex: 'half' } as RequestInit);
  assert.equal((await f.app.request(request)).status, 413);
  assert.equal(cancelled, true); assert.equal(f.A.list().length, 0);
});

test('account deactivation during body read prevents persistence', async t => {
  const f = fixture(); t.after(f.close);
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      f.disabled.set(f.contexts.A.accountId, 1);
      controller.enqueue(new TextEncoder().encode(JSON.stringify(input)));
    },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  const request = new Request(`http://localhost${root}`, { method: 'POST', headers, body: stream, duplex: 'half' } as RequestInit);
  assert.equal((await f.app.request(request)).status, 403);
  assert.equal(cancelled, true);
  assert.equal((f.db.prepare('SELECT count(*) AS n FROM bug_intake_reports').get() as { n: number }).n, 0);
});
