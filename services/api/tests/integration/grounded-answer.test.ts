import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { createServer, type FormServer, type ServerConfig } from '../../src/server.js';
import { createGroundedAnswerHost } from '../../src/integration/grounded-answer.js';
import { assertActive } from '../../src/lifecycle/guards.js';
import { migrations } from '../../src/storage.js';
import type { AccountContext } from '../../src/lifecycle/types.js';
import type { GroundedAnswer } from '../../src/grounding/answer.js';

const digest = '8fcb4cd3ac9a1edf1140fb591b731e74172095a7b534d758fb5f8d30d027de10';
function artifact(hash = digest) { return readFileSync(new URL(`../../grounding/${hash}/projection.json`, import.meta.url)); }
function declaration() {
  const bytes = readFileSync(new URL('../../../../../docs/knowledge/research-followups/output-declaration.json', import.meta.url));
  assert.equal(bytes.length, 2458);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), '516d6f009fedec71633e564d97c4308dab7bb61b739bd03fe3911f501aa00066');
  return JSON.parse(bytes.toString('utf8'));
}
const expectedSource = { repository: 'Jones-Systems/Form', revision: '0c68e72727f04a7307407a4a6b73d43b7dca61a6',
  corpusRoot: 'docs/knowledge/research-followups', corpusInputSha256: 'd2e4403c99d91d8069d5a124a3ad0e9c9008c669f04f7d1cff8982799b884971' };
const context = { revision: 'context:1', facts: [{ id: 'one', text: 'I walk regularly.', origin: 'user_provided' as const }], supersedesRevision: null };
const input = (query = 'ANA-S13') => ({ retrieval: { query }, context });
const origin = 'http://127.0.0.1:47931', secret = 'synthetic-grounded-answer-secret-over-32-characters';
const password = 'Synthetic-grounded-password-12345';

async function fixture(run: (server: FormServer, request: (path: string, token?: string, value?: unknown) => Promise<Response>, token: string) => Promise<void>, configured = true) {
  mkdirSync(resolve('.scratch'), { recursive: true });
  const root = mkdtempSync(join(resolve('.scratch'), 'grounded-answer-'));
  let server: FormServer | undefined, acquisition: Promise<FormServer> | undefined, disposal: Promise<void> | undefined, stopped = false;
  const dispose = () => {
    stopped = true;
    return disposal ??= (async () => {
      try { server ??= await acquisition; await server?.close(); }
      finally { rmSync(root, { recursive: true, force: true }); }
    })();
  };
  const interrupt = () => { void dispose().finally(() => process.exit(130)); };
  const terminate = () => { void dispose().finally(() => process.exit(143)); };
  process.once('SIGINT', interrupt); process.once('SIGTERM', terminate);
  try {
    acquisition = createServer({ dbPath: join(root, 'durable.sqlite'), baseURL: origin, secret,
      registration: { mode: 'allowlist', emails: ['one@synthetic.invalid'] },
      ...(configured ? { sourceGroundedAnswers: { projectionBytes: artifact() } } : {}) });
    server = await acquisition; assert.equal(stopped, false);
    const current = server;
    const request = (path: string, token?: string, value?: unknown) => Promise.resolve(current.handleRequest(new Request(origin + path, {
      method: value === undefined ? 'GET' : 'POST', headers: { origin, 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }),
    }), '192.0.2.31'));
    const signup = await request('/api/auth/sign-up/email', undefined, { name: 'One', email: 'one@synthetic.invalid', password });
    assert.equal(signup.status, 200); const token = signup.headers.get('set-auth-token'); assert.ok(token); await signup.json();
    assert.equal((await request('/v1/me', token)).status, 200);
    await run(server, request, token);
  } finally {
    try { await dispose(); }
    finally { process.off('SIGINT', interrupt); process.off('SIGTERM', terminate); }
    assert.equal(existsSync(root), false);
  }
}

test('fixed Form host preserves independent artifact observations through canonical in-memory actor guards', () => {
  const bytes = artifact(); assert.equal(bytes.length, 80588); assert.equal(createHash('sha256').update(bytes).digest('hex'), digest);
  const declared = declaration(), projection = JSON.parse(bytes.toString('utf8'));
  assert.equal(declared.projection.sha256, digest); assert.equal(declared.projection.bytes, bytes.length); assert.deepEqual(declared.source, expectedSource);
  const db = new Database(':memory:');
  try {
    db.exec(migrations[0]!.sql);
    db.prepare('INSERT INTO "user" VALUES (?,?,?,0,NULL,?,?)').run('user', 'Synthetic', 'one@synthetic.invalid', 1, 1);
    db.prepare('INSERT INTO form_accounts VALUES (?,?,?)').run('account', 'user', '2026-10-11T00:00:00Z');
    db.prepare('INSERT INTO session VALUES (?,?,?,?,?,NULL,NULL,?)').run('session', Date.now() + 60000, 'synthetic-token', 1, 1, 'user');
    const actor: AccountContext = { accountId: 'account', authUserId: 'user', sessionId: 'session', epoch: 0 };
    const host = createGroundedAnswerHost({ projectionBytes: bytes }); bytes.fill(0);
    const answer = host.answer(actor, input(), original => { assert.equal(db.inTransaction, false); assert.deepEqual(original, actor); assertActive(db, original); });
    assert.deepEqual(answer.evidence.source, expectedSource);
    assert.deepEqual(answer.statements.find(statement => statement.id === 'ANA-S13')!.citation, projection.records.find((entry: any) => entry.record.id === 'ANA-S13'));
    assert.equal(answer.choice.automaticAdoption, false);
    const full = host.answer(actor, input('source_observation'), original => assertActive(db, original));
    assert.deepEqual(full.statements.map(statement => statement.id), declared.expected.observation_ids.slice(0, 20));
    assert.equal(full.evidence.totalMatches, 26);
    assert.equal(full.evidence.limit, 20); assert.equal(full.evidence.truncated, true);
    assert.equal(full.evidence.observations.length, 20); assert.equal(full.options.length, 20);
    assert.equal(full.statements.at(-1)!.id, 'HLT-S20');
    assert.deepEqual(full.evidence.coverage.units.filter(unit => unit.state === 'partial').map(unit => unit.unit_id).sort(), declared.expected.partial_units);
    assert.equal(full.evidence.corpusStatus.units_without_observations.length, declared.expected.units_without_observations);
    for (const statement of full.statements) assert.deepEqual(statement.citation, projection.records.find((entry: any) => entry.record.id === statement.id));
    assert.equal(full.statements.find(statement => statement.id === 'HLT-S24'), undefined);
    const explicit = host.answer(actor, input('HLT-S24'), original => assertActive(db, original));
    assert.equal(explicit.evidence.query, 'HLT-S24'); assert.equal(explicit.evidence.truncated, false);
    assert.deepEqual(explicit.statements.find(statement => statement.id === 'HLT-S24')!.citation, projection.records.find((entry: any) => entry.record.id === 'HLT-S24'));
    let checks = 0;
    assert.throws(() => host.answer(actor, input(), original => {
      if (++checks === 2) db.prepare('DELETE FROM session WHERE id=?').run(actor.sessionId);
      assertActive(db, original);
    }), /account_session_invalid/);
  } finally { db.close(); }
});

test('unconfigured host refuses without reading input or composing', () => {
  const hostile = { get retrieval() { return assert.fail('unavailable must not read the request'); } };
  assert.throws(() => createGroundedAnswerHost().answer({ accountId: 'a', authUserId: 'u', sessionId: 's', epoch: 0 }, hostile, () => {}), /grounded_answer_unavailable/);
});

test('invalid, historical F20 and BL configured artifacts fail before database allocation, and RuntimeOwner rejects injection', async () => {
  mkdirSync(resolve('.scratch'), { recursive: true }); const root = mkdtempSync(join(resolve('.scratch'), 'grounded-config-'));
  const dispose = () => rmSync(root, { recursive: true, force: true });
  const interrupt = () => { dispose(); process.exit(130); }, terminate = () => { dispose(); process.exit(143); };
  process.once('SIGINT', interrupt); process.once('SIGTERM', terminate);
  try {
    const changed = artifact(); changed[100] = changed[100]! ^ 1;
    const config = { dbPath: join(root, 'must-not-open.sqlite'), baseURL: origin, secret };
    const historical = readFileSync(new URL('../../../tests/grounding/fixtures/form-followup-historical-twenty.json', import.meta.url));
    assert.equal(historical.length, 66509);
    assert.equal(createHash('sha256').update(historical).digest('hex'), 'dfd9ad93bf39a17a3c7f9b81407a3461a27b1830f64a3e53a126e13a3e196480');
    for (const bytes of [changed, historical, artifact('84530977a646d138ff1194d22d8723989ff6646dc3f69a8ab5c390783de55ad8')]) {
      await assert.rejects(createServer({ ...config, sourceGroundedAnswers: { projectionBytes: bytes } }), /Form follow-up projection digest mismatch/);
      assert.deepEqual(readdirSync(root), []);
    }
    let closed = false;
    await assert.rejects(createServer({ ...config, sourceGroundedAnswers: { projectionBytes: artifact() },
      runtimeOwner: { close() { closed = true; } } as unknown as NonNullable<ServerConfig['runtimeOwner']> }), /cannot mix source injections/);
    assert.equal(closed, true); assert.deepEqual(readdirSync(root), []);
  } finally { process.off('SIGINT', interrupt); process.off('SIGTERM', terminate); dispose(); }
});

test('actual authenticated route preserves Form provenance, context, question and honest lexical gap', async () => fixture(async (_server, request, token) => {
  assert.equal((await request('/v1/grounded-answers', undefined, input())).status, 401);
  const response = await request('/v1/grounded-answers', token, input()); assert.equal(response.status, 200);
  const answer = await response.json() as GroundedAnswer;
  assert.deepEqual(answer.evidence.source, expectedSource); assert.equal(answer.evidence.query, 'ANA-S13');
  assert.deepEqual(answer.context, context);
  const original = JSON.parse(artifact().toString('utf8')).records.find((entry: any) => entry.record.id === 'ANA-S13');
  assert.deepEqual(answer.statements.find(statement => statement.id === 'ANA-S13')!.citation, original);
  const full = await (await request('/v1/grounded-answers', token, input('source_observation'))).json() as GroundedAnswer;
  assert.deepEqual(full.statements.map(statement => statement.id), declaration().expected.observation_ids.slice(0, 20));
  assert.equal(full.evidence.totalMatches, 26); assert.equal(full.evidence.limit, 20); assert.equal(full.evidence.truncated, true);
  assert.equal(full.evidence.observations.length, 20); assert.equal(full.options.length, 20);
  assert.equal(full.statements.at(-1)!.id, 'HLT-S20');
  assert.equal(full.statements.find(statement => statement.id === 'HLT-S24'), undefined);
  const projection = JSON.parse(artifact().toString('utf8'));
  const fle = full.statements.filter(statement => statement.id.startsWith('FLE-'));
  assert.deepEqual(fle.map(statement => statement.id), ['FLE-S01', 'FLE-S02', 'FLE-S03', 'FLE-S04', 'FLE-S05']);
  assert.deepEqual(fle.map(statement => statement.citation.line), [5, 35, 65, 93, 123]);
  for (const statement of fle) {
    assert.deepEqual(statement.citation, projection.records.find((entry: any) => entry.record.id === statement.id));
    assert.equal(statement.citation.source_path, 'sources/stretch-rom-008.md');
    assert.equal(statement.citation.source_packet_sha256, '91bfca77d93d13317819b0a601cb71572f27eb12904ed6228faab836618e59cd');
    assert.deepEqual(statement.citation.record.topic_ids, ['EXU-B5', 'DOS-E1']);
    assert.equal(statement.citation.record.clinical_readiness, 'CL-0');
    assert.equal(statement.originalPassageVerified, false);
  }
  assert.equal(fle[4]!.citation.record.access_level, 'abstract');
  assert.equal(fle[4]!.citation.record.form_appraisal, 'unknown; unadopted; mention-only');
  assert.equal(fle[4]!.citation.record.rights_status, 'unknown; no full-text copying or rights activation');
  assert.deepEqual(full.conflicts, ['FLE-S01', 'FLE-S02', 'FLE-S04'].map(id => ({
    observationId: id, conflictingObservationId: id, referencedObservationIncluded: true, disposition: 'unresolved',
  })));
  const explicit = await (await request('/v1/grounded-answers', token, input('HLT-S24'))).json() as GroundedAnswer;
  assert.equal(explicit.evidence.query, 'HLT-S24');
  assert.deepEqual(explicit.statements.find(statement => statement.id === 'HLT-S24')!.citation.record.topic_ids, ['HLT-Y1', 'EXU-B4']);
  assert.deepEqual(explicit.statements.find(statement => statement.id === 'HLT-S24')!.citation, projection.records.find((entry: any) => entry.record.id === 'HLT-S24'));
  const question = 'What does this mean for my uniquely unspecified training situation?';
  const gap = await (await request('/v1/grounded-answers', token, input(question))).json() as GroundedAnswer;
  assert.equal(gap.status, 'gap'); assert.equal(gap.evidence.query, question); assert.deepEqual(gap.statements, []);
  assert.equal(gap.evidence.totalMatches, 0); assert.equal(gap.evidence.truncated, false); assert.deepEqual(gap.options, []);
  for (const value of [{ ...input(), accountId: 'foreign' }, { ...input(), retrieval: { query: 'ANA-S13', corpus: 'BL' } },
    { ...input(), context: { ...context, facts: [{ id: 'one', text: 'Claimed', origin: 'clinical' }] } }]) {
    assert.equal((await request('/v1/grounded-answers', token, value)).status, 422);
  }
}));

test('actual unconfigured route is authenticated and unavailable without body decoding', async () => fixture(async (_server, request, token) => {
  assert.equal((await request('/v1/grounded-answers', undefined, {})).status, 401);
  const response = await request('/v1/grounded-answers', token, {}); assert.equal(response.status, 501);
  assert.equal((await response.json() as any).error.code, 'grounded_answer_unavailable');
}, false));

test('delayed chunked body cannot adopt a same-account replacement session', async () => fixture(async (server, request, token) => {
  let ready!: () => void, controller!: ReadableStreamDefaultController<Uint8Array>;
  const reading = new Promise<void>(resolve => { ready = resolve; });
  const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value; }, pull() { ready(); } }, { highWaterMark: 0 });
  const pending = server.handleRequest(new Request(origin + '/v1/grounded-answers', {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: stream, duplex: 'half',
  } as RequestInit & { duplex: 'half' }), '192.0.2.31');
  try {
    await reading; assert.equal(server.db.inTransaction, false);
    server.db.prepare('DELETE FROM session').run();
    const replacement = await request('/api/auth/sign-in/email', undefined, { email: 'one@synthetic.invalid', password });
    assert.equal(replacement.status, 200); await replacement.json();
    controller.enqueue(new TextEncoder().encode(JSON.stringify(input()))); controller.close();
    const response = await pending; assert.equal(response.status, 401);
    assert.equal((await response.json() as any).error.code, 'account_session_invalid');
  } finally { try { controller.close(); } catch {} await pending; }
}));

test('grounded route retains the 64 KiB limit after authentication', async () => fixture(async (_server, request, token) => {
  const response = await request('/v1/grounded-answers', token, input('x'.repeat(65537)));
  assert.equal(response.status, 413); assert.equal((await response.json() as any).error.code, 'body_too_large');
}));
