import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import Database from 'better-sqlite3';
import { createServer, type FormServer } from '../../../src/server.js';
import { hash, migrations } from '../../../src/storage.js';
import { lifecycleMigration } from '../../../src/lifecycle/migration.js';
import type { SuppressionLedger } from '../../../src/lifecycle/types.js';
import { nutritionWireSchema, type NutritionConversationInput, type NutritionCitationState,
  type NutritionWireBinding, type NutritionWireOperation, type NutritionWireResponse } from '../../../src/integration/nutrition-conversation/wire.js';
import type { GroundingResult } from '../../../src/grounding/index.js';
import { expectedSource, expectedCoverage, expectedCorpusStatus } from './retained-oracle.js';
import { nutritionHttpPackets } from './nutrition-http-oracle.js';

const digest = '84530977a646d138ff1194d22d8723989ff6646dc3f69a8ab5c390783de55ad8';
const projectionBytes = readFileSync(new URL(`../../../grounding/${digest}/projection.json`, import.meta.url));
assert.equal(projectionBytes.byteLength, 1488603);
assert.equal(createHash('sha256').update(projectionBytes).digest('hex'), digest);
const origin = 'http://127.0.0.1:47937';
const prefix = '/v1/nutrition/conversations';
const missingQuestion = 'formws37httpunretainednutrition997';
const startingContext = ['Artificial participant asks for literature explanations across seven nutrition jobs.',
  'No dietary, supplement or training choice has been applied.'];
const replacementContext = ['Correction: I avoid dairy.', 'Explain the study qualifications; do not change my diet.'];
const correction = 'Replace the earlier dietary context; no personal applicability has been assessed.';

type Actor = { token: string; accountId: string; sessionId: string };
type Packet = typeof nutritionHttpPackets[number];

function input(packet: Packet, previousTurnId: number | null): NutritionConversationInput {
  return { choice: previousTurnId === null ? 'ask' : 'continue-question', previousTurnId,
    job: packet.job, question: packet.question, userContext: startingContext, correction: null };
}

function evidenceFor(turn: NutritionConversationInput): GroundingResult {
  const packet = nutritionHttpPackets.find(value => value.job === turn.job)!;
  assert.ok(packet, 'each accepted job needs an independent packet binding');
  assert.ok(turn.question === packet.question || turn.question === missingQuestion);
  const observations = turn.question === missingQuestion ? [] : [packet.entry];
  const common = { schema: 'form.observation-grounding/v1' as const, source: expectedSource,
    clinicalReadiness: 'CL-0' as const, coverage: expectedCoverage, corpusStatus: expectedCorpusStatus,
    query: turn.question, filters: { topic: packet.topic, access: null }, limit: 20,
    totalMatches: observations.length, truncated: false, verbatimPassagesAvailable: false as const };
  return observations.length === 0
    ? { ...common, status: 'gap', reason: 'no_matching_observations', observations: [] }
    : { ...common, status: 'observations', observations };
}

function qualifiedHistory(state: NutritionCitationState, accepted: readonly NutritionConversationInput[]): void {
  assert.equal(state.conversation.automaticAdoption, 'none');
  assert.equal(state.conversation.currentTurnId, accepted.length || null);
  assert.deepEqual(state.conversation.turns.map(turn => turn.input), accepted);
  const corrections: string[] = [];
  for (const [index, turn] of state.conversation.turns.entries()) {
    const expectedInput = accepted[index]!;
    if (expectedInput.correction !== null) corrections.push(expectedInput.correction);
    assert.equal(turn.id, index + 1);
    assert.equal(turn.supersedesTurnId, expectedInput.correction === null ? null : expectedInput.previousTurnId);
    assert.equal(turn.status, 'explanation');
    assert.ok(turn.explanation && turn.sources);
    const evidence = evidenceFor(expectedInput);
    const entries = evidence.observations;
    const conflicts = entries.flatMap(entry => entry.record.conflicts.map(id => ({
      observationId: entry.record.id, conflictingObservationId: id,
      referencedObservationIncluded: entries.some(value => value.record.id === id), disposition: 'unresolved',
    })));
    assert.deepEqual(turn.explanation, {
      schema: 'form.grounded-answer/v1', status: entries.length ? 'informative' : 'gap', evidence,
      context: { revision: `nutrition-turn-${turn.id}`,
        supersedesRevision: expectedInput.previousTurnId === null ? null : `nutrition-turn-${expectedInput.previousTurnId}`,
        facts: expectedInput.userContext.map((text, fact) => ({ id: `nutrition-turn-${turn.id}-fact-${fact + 1}`, text, origin: 'user_provided' })) },
      contextUse: 'acknowledged_not_applicability_assessed',
      introduction: entries.length
        ? 'These retained research observations describe what the cited literature reports. Their qualifications and unresolved differences are included below.'
        : 'No matching observations were found for this search in the retained corpus.',
      statements: entries.map(entry => ({ id: entry.record.id, evidenceKind: 'retained_source_observation',
        text: entry.record.summary, citation: entry, originalPassageVerified: false })),
      conflicts, options: entries.map(entry => ({ id: entry.record.id, kind: 'literature_consideration',
        title: entry.record.title, statementId: entry.record.id, adoption: 'not_applied' })),
      choice: { decisionOwner: 'user', automaticAdoption: false,
        text: 'You can use these observations when considering your options. No choice or change has been applied.' },
    });
    assert.deepEqual(turn.sources.retrievalContext, evidence);
    assert.deepEqual(turn.sources.request, { job: expectedInput.job, question: expectedInput.question,
      corrections: [...corrections], consumer: 'CHAT', topicIds: [evidence.filters.topic] });
    assert.equal(turn.sources.adviceAuthority, 'none');
    assert.equal(turn.sources.scientificAppraisal, 'not-performed');
    assert.equal(turn.sources.status, 'evidence-gap');
    assert.deepEqual(turn.sources.boundary, { status: 'unavailable', reason: 'medical-boundary-policy-not-bound' });
    assert.ok(turn.sources.gaps.some(gap => gap.code === 'policy-unavailable'));
    assert.deepEqual(turn.sources.traceableCandidateIndexes, entries.map((_, i) => i));
    assert.deepEqual(turn.sources.candidates, entries.map(entry => ({ observation: entry, topicIds: entry.record.topic_ids,
      provenance: { status: 'source-observation', sourceRevision: expectedSource.revision,
        locator: `${expectedSource.corpusRoot}/${entry.source_path}:${entry.line}`,
        limits: [expectedCorpusStatus.limitation, `access-level: ${entry.record.access_level}`, entry.record.source_native_certainty,
          entry.record.form_appraisal, entry.record.applicability, entry.record.rights_status,
          entry.record.freshness_status, entry.record.provenance] } })));
    if (entries.length === 0) {
      assert.ok(turn.sources.gaps.some(gap => gap.code === 'no-traceable-observations'));
      assert.ok(turn.sources.gaps.some(gap => gap.code === 'retrieval-gap' && gap.detail.includes('no match within this bounded projection')));
    }
  }
  assert.deepEqual(state.conversation.currentExplanation, state.conversation.turns.at(-1)?.explanation ?? null);
  if (state.currentSelection !== null) {
    const selected = state.currentSelection;
    assert.equal(selected.parentTurnId, accepted.length);
    const turn = state.conversation.turns.at(-1)!;
    assert.deepEqual(selected.statement, turn.explanation!.statements.find(statement => statement.id === selected.statementId));
    assert.deepEqual(selected.sources, turn.sources);
    assert.deepEqual(selected.conflicts, turn.explanation!.conflicts.filter(edge =>
      edge.observationId === selected.statementId || edge.conflictingObservationId === selected.statementId));
  }
}

function empty(state: NutritionCitationState): void {
  assert.deepEqual(state, { conversation: { turns: [], rejectedChoices: [], currentTurnId: null,
    currentExplanation: null, automaticAdoption: 'none' }, selections: [], currentSelection: null });
}

function decode(response: Response, raw: unknown, requestId: string, operation: NutritionWireOperation): NutritionWireResponse {
  assert.ok(raw && typeof raw === 'object');
  const value = raw as NutritionWireResponse;
  assert.deepEqual(Object.keys(value).sort(), ['schema', 'requestId', 'operation', 'status', 'code', 'binding',
    'stateVersion', 'state', 'resetRequired'].sort());
  assert.equal(value.schema, nutritionWireSchema);
  assert.equal(value.requestId, requestId);
  assert.equal(value.operation, operation);
  assert.match(response.headers.get('content-type') ?? '', /^application\/json(?:;|$)/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.status, value.status === 'reset' ? 201 : 200);
  assert.ok(['reset', 'ok', 'rejected', 'unavailable', 'unknown', 'disposed'].includes(value.status));
  if (value.binding !== null) {
    assert.deepEqual(Object.keys(value.binding).sort(), ['id', 'expiresAt'].sort());
    assert.match(value.binding.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(new Date(value.binding.expiresAt).toISOString(), value.binding.expiresAt);
    assert.ok(Number.isSafeInteger(value.stateVersion) && value.stateVersion! > 0);
    assert.ok(value.state);
  } else {
    assert.equal(value.stateVersion, null);
    assert.equal(value.state, null);
  }
  return value;
}

async function fixture(t: TestContext) {
  const parent = fileURLToPath(new URL('../../../../tests/grounding/evaluation/.scratch/', import.meta.url));
  const root = join(parent, `nutrition-http-${randomUUID()}`);
  let allocated = false, seed: Database.Database | undefined, backend: FormServer | undefined;
  let constructing: Promise<FormServer> | undefined, cleaning: Promise<void> | undefined;
  const cleanup = (): Promise<void> => cleaning ??= (async () => {
    try {
      if (constructing) { try { backend = await constructing; } catch { /* Failed server construction owns its internal close. */ } }
      try { if (seed?.open) seed.close(); } finally { if (backend) await backend.close(false); }
    } finally {
      if (allocated) { rmSync(root, { recursive: true, force: true }); assert.equal(existsSync(root), false); }
    }
  })();
  const signal = (code: number) => { void cleanup().then(() => process.exit(code), error => {
    console.error('nutrition HTTP evaluation cleanup failed', error); process.exit(code);
  }); };
  const interrupted = () => signal(130), terminated = () => signal(143);
  process.once('SIGINT', interrupted); process.once('SIGTERM', terminated);
  t.after(async () => {
    try { await cleanup(); } finally { process.off('SIGINT', interrupted); process.off('SIGTERM', terminated); }
  });
  try {
    mkdirSync(parent, { recursive: true });
    mkdirSync(root, { mode: 0o700 }); allocated = true;
    seed = new Database(join(root, 'evaluation.sqlite'));
    seed.exec('CREATE TABLE form_migrations(version INTEGER PRIMARY KEY,checksum TEXT NOT NULL,applied_at TEXT NOT NULL)');
    for (const migration of migrations) {
      seed.exec(migration.sql);
      seed.prepare('INSERT INTO form_migrations VALUES(?,?,?)').run(migration.version, hash(migration.sql), 'evaluation');
    }
    seed.exec(lifecycleMigration.sql); seed.close();
    const ledger: SuppressionLedger = { currentSequence: () => 0, lookup: () => null, reconcileRestore: () => 0,
      recordDisable: () => { throw new Error('The artificial evaluation ledger cannot issue disable records.'); } };
    constructing = createServer({ dbPath: join(root, 'evaluation.sqlite'), baseURL: origin,
      secret: 'artificial-ws37-http-evaluation-secret-over-32-characters',
      registration: { mode: 'allowlist', emails: ['one@evaluation.invalid', 'two@evaluation.invalid'] },
      lifecycle: { ledger }, sourceNutritionConversations: { projectionBytes } });
    backend = await constructing;
  } catch (error) {
    try { await cleanup(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Evaluation setup and cleanup failed'); }
    throw error;
  }
  assert.ok(backend, 'successful server construction must return its cleanup-owned handle');
  const server = backend;
  const request = (path: string, token?: string, value?: unknown) => server.handleRequest(new Request(origin + path, {
    method: value === undefined ? 'GET' : 'POST', headers: { origin, 'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(value === undefined ? {} : { body: JSON.stringify(value) }),
  }), '192.0.2.37');
  const authenticate = async (name: 'one' | 'two', signup = true): Promise<Actor> => {
    const result = await request(`/api/auth/${signup ? 'sign-up' : 'sign-in'}/email`, undefined, {
      ...(signup ? { name: `Artificial ${name}` } : {}), email: `${name}@evaluation.invalid`, password: 'Artificial-evaluation-password-1234',
    });
    assert.equal(result.status, 200);
    const token = result.headers.get('set-auth-token'); assert.ok(token);
    assert.equal((await request('/v1/me', token)).status, 200);
    const session = await server.auth.api.getSession({ headers: new Headers({ authorization: `Bearer ${token}` }) });
    assert.ok(session);
    const row = server.db.prepare('SELECT s.id AS sessionId,f.id AS accountId FROM session s JOIN form_accounts f ON f.auth_user_id=s.userId WHERE s.id=? AND s.userId=?')
      .get(session.session.id, session.user.id) as { sessionId: string; accountId: string } | undefined;
    assert.ok(row);
    return { token, ...row };
  };
  const versions = new Map<string, number>();
  const wire = async (actor: Actor, operation: NutritionWireOperation, binding?: NutritionWireBinding,
    turnInput?: NutritionConversationInput | { parentTurnId: number; statementId: string }) => {
    const requestId = randomUUID();
    const suffix = operation === 'resetFreshEmpty' ? '/reset-fresh-empty'
      : `/${binding!.id}/${operation === 'selectCitation' ? 'select-citation' : operation}`;
    const response = await request(prefix + suffix, actor.token, { schema: nutritionWireSchema, requestId,
      ...(turnInput ? { input: turnInput } : {}) });
    const reply = decode(response, await response.json(), requestId, operation);
    if (reply.binding !== null) {
      if (binding) assert.equal(reply.binding.id, binding.id);
      assert.ok(reply.stateVersion! >= (versions.get(reply.binding.id) ?? 1));
      versions.set(reply.binding.id, reply.stateVersion!);
    }
    return reply;
  };
  return { server, request, authenticate, wire };
}

function unavailable(reply: NutritionWireResponse): void {
  assert.equal(reply.status, 'unavailable'); assert.equal(reply.code, 'conversation_unavailable');
  assert.equal(reply.resetRequired, true); assert.equal(reply.binding, null);
  assert.equal(reply.state, null); assert.equal(reply.stateVersion, null);
}

async function begin(f: Awaited<ReturnType<typeof fixture>>, actor: Actor) {
  const reset = await f.wire(actor, 'resetFreshEmpty');
  assert.equal(reset.status, 'reset'); assert.equal(reset.code, null); assert.equal(reset.resetRequired, false);
  assert.equal(reset.stateVersion, 1); assert.ok(reset.binding && reset.state); empty(reset.state);
  return reset.binding;
}

async function qualifiedChoice(f: Awaited<ReturnType<typeof fixture>>, actor: Actor, binding: NutritionWireBinding) {
  const first = input(nutritionHttpPackets[2]!, null);
  const answer = await f.wire(actor, 'submit', binding, first);
  assert.equal(answer.status, 'ok'); assert.ok(answer.state); qualifiedHistory(answer.state, [first]);
  const choice = await f.wire(actor, 'selectCitation', binding, { parentTurnId: 1, statementId: 'OLP-S02' });
  assert.equal(choice.status, 'ok'); assert.ok(choice.state); qualifiedHistory(choice.state, [first]);
  assert.equal(choice.state.currentSelection?.status, 'selected');
  assert.deepEqual(choice.state.currentSelection?.conflicts, [{ observationId: 'OLP-S02', conflictingObservationId: 'OLP-S03',
    referencedObservationIncluded: false, disposition: 'unresolved' }]);
  return { first, choice: choice.state };
}

test('EVAL-HTTP-01: mounted seven-job ten-turn history preserves packet evidence, explicit choices, correction and bounded gap', async t => {
  const f = await fixture(t);
  assert.equal((await f.request(prefix + '/reset-fresh-empty', undefined, { schema: nutritionWireSchema, requestId: randomUUID() })).status, 401);
  const actor = await f.authenticate('one');
  const binding = await begin(f, actor);
  const accepted: NutritionConversationInput[] = [];
  let version = 1;
  const invoke = async (operation: 'submit' | 'selectCitation' | 'snapshot', value?: NutritionConversationInput | { parentTurnId: number; statementId: string }) => {
    const reply = await f.wire(actor, operation, binding, value);
    assert.equal(reply.binding?.id, binding.id); assert.equal(reply.resetRequired, false);
    assert.ok(reply.stateVersion! >= version); version = reply.stateVersion!;
    assert.ok(reply.state); qualifiedHistory(reply.state, accepted);
    return reply;
  };
  for (const packet of nutritionHttpPackets) {
    const next = input(packet, accepted.length || null); accepted.push(next);
    const answer = await invoke('submit', next);
    assert.equal(answer.status, 'ok'); assert.equal(answer.code, null); assert.equal(answer.state!.currentSelection, null);
    const selected = await invoke('selectCitation', { parentTurnId: accepted.length, statementId: packet.entry.record.id });
    assert.equal(selected.status, 'ok'); assert.equal(selected.state!.currentSelection?.statementId, packet.entry.record.id);
  }
  const corrected: NutritionConversationInput = { ...input(nutritionHttpPackets[2]!, 7), choice: 'update-context',
    userContext: replacementContext, correction };
  accepted.push(corrected);
  const changed = await invoke('submit', corrected);
  assert.equal(changed.status, 'ok'); assert.equal(changed.state!.currentSelection, null);
  assert.equal(changed.state!.selections.length, 7);
  const stale = await invoke('selectCitation', { parentTurnId: 7, statementId: 'NBR-S002' });
  assert.equal(stale.status, 'rejected'); assert.equal(stale.code, 'stale_turn');
  assert.equal(stale.state!.currentSelection, null); assert.equal(stale.state!.selections.at(-1)?.status, 'stale-turn');
  const selected = await invoke('selectCitation', { parentTurnId: 8, statementId: 'OLP-S02' });
  assert.equal(selected.status, 'ok'); assert.equal(selected.state!.currentSelection?.statementId, 'OLP-S02');
  const gap: NutritionConversationInput = { ...input(nutritionHttpPackets[2]!, 8), question: missingQuestion, userContext: replacementContext };
  accepted.push(gap); const bounded = await invoke('submit', gap);
  assert.equal(bounded.status, 'ok'); assert.equal(bounded.state!.conversation.currentExplanation!.status, 'gap');
  assert.equal(bounded.state!.currentSelection, null);
  const followup: NutritionConversationInput = { ...input(nutritionHttpPackets[0]!, 9), userContext: replacementContext };
  accepted.push(followup); assert.equal((await invoke('submit', followup)).status, 'ok');
  const finalChoice = await invoke('selectCitation', { parentTurnId: 10, statementId: 'ENE-S03' });
  assert.equal(finalChoice.status, 'ok');
  const snapshot = await invoke('snapshot'); assert.equal(snapshot.status, 'ok');
  assert.deepEqual(snapshot.state, finalChoice.state);
  assert.equal(snapshot.state!.conversation.turns.length, 10);
  assert.deepEqual(snapshot.state!.selections.map(value => value.status), [...Array<string>(7).fill('selected'), 'stale-turn', 'selected', 'selected']);
  assert.deepEqual(snapshot.state!.conversation.rejectedChoices, []);
  assert.equal((f.server.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE '%nutrition%' OR name LIKE '%conversation%'").get() as { n: number }).n, 0);
});

test('EVAL-HTTP-OWNERSHIP: canonical foreign account and new authenticated session cannot obtain prior qualified content', async t => {
  const f = await fixture(t), actor = await f.authenticate('one'), other = await f.authenticate('two');
  const binding = await begin(f, actor); const saved = await qualifiedChoice(f, actor, binding);
  unavailable(await f.wire(other, 'snapshot', binding));
  unavailable(await f.wire(other, 'selectCitation', binding, { parentTurnId: 1, statementId: 'OLP-S02' }));
  const newSession = await f.authenticate('one', false);
  assert.equal(newSession.accountId, actor.accountId); assert.notEqual(newSession.sessionId, actor.sessionId);
  unavailable(await f.wire(newSession, 'snapshot', binding));
  const fresh = await begin(f, newSession);
  assert.notEqual(fresh.id, binding.id);
  assert.deepEqual((await f.wire(actor, 'snapshot', binding)).state, saved.choice);
  const freshSnapshot = await f.wire(newSession, 'snapshot', fresh); assert.ok(freshSnapshot.state); empty(freshSnapshot.state);
});

// A zero-buffer streamed read supplies a deterministic post-authentication, pre-invocation loss seam.
async function streamedLoss(f: Awaited<ReturnType<typeof fixture>>, actor: Actor, binding: NutritionWireBinding,
  effect: () => void, signal?: AbortSignal) {
  const bytes = new TextEncoder().encode(JSON.stringify({ schema: nutritionWireSchema, requestId: randomUUID(),
    input: { ...input(nutritionHttpPackets[2]!, 1), choice: 'update-context', userContext: replacementContext, correction } }));
  let reads = 0;
  const stream = new ReadableStream<Uint8Array>({ pull(controller) {
    if (reads++ === 0) controller.enqueue(bytes.subarray(0, 20));
    else { controller.enqueue(bytes.subarray(20)); controller.close(); effect(); }
  } }, { highWaterMark: 0 });
  const init: RequestInit & { duplex: 'half' } = { method: 'POST', duplex: 'half', body: stream,
    headers: { origin, authorization: `Bearer ${actor.token}`, 'content-type': 'application/json' }, ...(signal ? { signal } : {}) };
  const response = await f.server.handleRequest(new Request(`${origin}${prefix}/${binding.id}/submit`, init), '192.0.2.37');
  assert.equal(reads, 2);
  return response;
}

for (const loss of ['session', 'epoch', 'account'] as const) {
  test(`EVAL-HTTP-LOSS-${loss}: streamed canonical authority loss withholds correction and requires a fresh authorized binding`, async t => {
    const f = await fixture(t), actor = await f.authenticate('one');
    const binding = await begin(f, actor); const saved = await qualifiedChoice(f, actor, binding);
    const response = await streamedLoss(f, actor, binding, () => {
      if (loss === 'session') f.server.db.prepare('DELETE FROM session WHERE id=?').run(actor.sessionId);
      else if (loss === 'epoch') f.server.db.prepare('UPDATE account_lifecycle SET epoch=epoch+1 WHERE account_id=?').run(actor.accountId);
      else f.server.db.prepare("UPDATE account_lifecycle SET state='disabled',epoch=epoch+1,disabled_at_ms=1,suppression_seq=1 WHERE account_id=?").run(actor.accountId);
    });
    assert.equal(response.status, loss === 'session' ? 401 : 403);
    assert.equal((await response.json() as { error: { code: string } }).error.code,
      loss === 'session' ? 'account_session_invalid' : loss === 'epoch' ? 'account_epoch_changed' : 'account_disabled');
    assert.equal(saved.choice.conversation.turns.length, 1); qualifiedHistory(saved.choice, [saved.first]);
    const current = loss === 'session' ? await f.authenticate('one', false)
      : loss === 'account' ? await f.authenticate('two') : actor;
    unavailable(await f.wire(current, 'snapshot', binding));
    unavailable(await f.wire(current, 'selectCitation', binding, { parentTurnId: 1, statementId: 'OLP-S02' }));
    const fresh = await begin(f, current); assert.notEqual(fresh.id, binding.id);
    const first = input(nutritionHttpPackets[0]!, null);
    const useful = await f.wire(current, 'submit', fresh, first);
    assert.equal(useful.status, 'ok'); assert.ok(useful.state); qualifiedHistory(useful.state, [first]);
    assert.deepEqual(useful.state.selections, []); assert.equal(useful.state.currentSelection, null);
  });
}

test('EVAL-HTTP-ABORT: pre-invocation request cancellation delivers no correction or automatic replay', async t => {
  const f = await fixture(t), actor = await f.authenticate('one');
  const binding = await begin(f, actor); const saved = await qualifiedChoice(f, actor, binding);
  const controller = new AbortController();
  const response = await streamedLoss(f, actor, binding, () => controller.abort(), controller.signal);
  assert.equal(response.status, 400); assert.equal((await response.json() as { error: { code: string } }).error.code, 'request_aborted');
  const authoritative = await f.wire(actor, 'snapshot', binding);
  assert.equal(authoritative.status, 'ok'); assert.deepEqual(authoritative.state, saved.choice);
  const fresh = await begin(f, actor); assert.notEqual(fresh.id, binding.id);
  unavailable(await f.wire(actor, 'snapshot', binding));
  const snapshot = await f.wire(actor, 'snapshot', fresh); assert.ok(snapshot.state); empty(snapshot.state);
});

test('EVAL-HTTP-DISPOSE: mounted lifetime disposal rejects old content and choice; explicit reset starts empty without replay', async t => {
  const f = await fixture(t), actor = await f.authenticate('one');
  const binding = await begin(f, actor); const saved = await qualifiedChoice(f, actor, binding);
  const disposed = await f.wire(actor, 'dispose', binding);
  assert.equal(disposed.status, 'disposed'); assert.equal(disposed.code, null); assert.equal(disposed.resetRequired, true);
  assert.equal(disposed.state, null); assert.equal(disposed.binding, null);
  unavailable(await f.wire(actor, 'snapshot', binding));
  unavailable(await f.wire(actor, 'selectCitation', binding, { parentTurnId: 1, statementId: 'OLP-S02' }));
  const fresh = await begin(f, actor); assert.notEqual(fresh.id, binding.id);
  const reply = await f.wire(actor, 'snapshot', fresh); assert.ok(reply.state); empty(reply.state);
  qualifiedHistory(saved.choice, [saved.first]);
});
