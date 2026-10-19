import test, { type TestContext } from 'node:test';
import { proteinOriginal, proteinCoverage, proteinCorpusStatus } from '../grounding/evaluation/form-nutrition-oracle.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { createServer } from '../../src/server.js';
import { RuntimeOwner } from '../../src/runtime-modules/admission.js';
import type { GroundedAnswer, GroundedAnswerRequest } from '../../src/grounding/answer.js';
import type { ObservationEntry } from '../../src/grounding/index.js';
import { nutritionJobTopics } from '../../src/domain-features/nutrition/index.js';
import { nutritionWireSchema, type NutritionConversationInput, type NutritionWireResponse } from '../../src/integration/nutrition-conversation/wire.js';
import { deployment, provision, start, login, request, registerStreamCancellation, emails, origin, secret } from './fixture.js';

const digest = '8fcb4cd3ac9a1edf1140fb591b731e74172095a7b534d758fb5f8d30d027de10';
const expectedSource = { repository: 'Jones-Systems/Form', revision: '0c68e72727f04a7307407a4a6b73d43b7dca61a6',
  corpusRoot: 'docs/knowledge/research-followups', corpusInputSha256: 'd2e4403c99d91d8069d5a124a3ad0e9c9008c669f04f7d1cff8982799b884971' };
const input = (query = 'FLE-S05'): GroundedAnswerRequest => ({ retrieval: { query }, context: {
  revision: 'original-context:1', facts: [{ id: 'reported', text: 'I walk regularly.', origin: 'user_provided' }], supersedesRevision: null,
} });
const nutritionPrefix = '/v1/nutrition/conversations';
const nutritionEnvelope = () => ({ schema: nutritionWireSchema, requestId: randomUUID() });
function authentic() {
  const bytes = fs.readFileSync(new URL(`../../grounding/${digest}/projection.json`, import.meta.url));
  assert.equal(bytes.length, 80588); assert.equal(createHash('sha256').update(bytes).digest('hex'), digest);
  return bytes;
}
function watchPackage(t: TestContext, onRead: () => void = () => {}) {
  let calls = 0;
  const original = fs.openSync;
  const mocked = t.mock.method(fs, 'openSync', (...args: Parameters<typeof fs.openSync>) => {
    if (typeof args[0] === 'string' && args[0].startsWith('/proc/self/fd/') && args[0].endsWith(`/${digest}`)) {
      calls++; onRead();
    }
    return original(...args);
  });
  syncBuiltinESMExports();
  const restore = () => { mocked.mock.restore(); syncBuiltinESMExports(); };
  t.after(restore);
  return { calls: () => calls, restore };
}

test('actual runtime startup reads fixed Form26 once and authenticated answers retain exact citations', async t => {
  const bytes = authentic(), projection = JSON.parse(bytes.toString('utf8')) as { records: ObservationEntry[] };
  const d = await deployment(t); await provision(d);
  const watched = watchPackage(t), { server } = await start(d);
  assert.equal(watched.calls(), 1);
  assert.equal((await request(server, '/health')).status, 200);
  assert.equal((await request(server, '/v1/grounded-answers', undefined, 'POST', input())).status, 401);
  const user = await login(server, emails[0], true);
  const response = await request(server, '/v1/grounded-answers', user, 'POST', input());
  assert.equal(response.status, 200);
  const answer = await response.json() as GroundedAnswer;
  assert.deepEqual(answer.context, input().context); assert.deepEqual(answer.evidence.source, expectedSource);
  assert.equal(answer.evidence.query, 'FLE-S05'); assert.equal(answer.choice.automaticAdoption, false);
  assert.deepEqual(answer.statements.find(statement => statement.id === 'FLE-S05')!.citation,
    projection.records.find(record => record.record.id === 'FLE-S05'));
  assert.equal(answer.statements[0]!.originalPassageVerified, false);
  const allResponse = await request(server, '/v1/grounded-answers', user, 'POST', input('source_observation'));
  assert.equal(allResponse.status, 200);
  const all = await allResponse.json() as GroundedAnswer;
  assert.equal(all.evidence.totalMatches, 26); assert.equal(all.evidence.limit, 20); assert.equal(all.evidence.truncated, true);
  assert.equal(all.statements.length, 20);
  for (const statement of all.statements) assert.deepEqual(statement.citation, projection.records.find(record => record.record.id === statement.id));
  const literal = 'What does this mean for my uniquely unspecified training situation?';
  const gapResponse = await request(server, '/v1/grounded-answers', user, 'POST', input(literal));
  assert.equal(gapResponse.status, 200); const gap = await gapResponse.json() as GroundedAnswer;
  assert.equal(gap.status, 'gap'); assert.equal(gap.evidence.query, literal); assert.deepEqual(gap.statements, []);
  assert.equal(watched.calls(), 1); assert.deepEqual(authentic(), bytes);
});

test('runtime Form26 protein preserves qualified evidence through authenticated correction, context, citation, gap, follow-up and reset', async t => {
  const bytes = authentic();
  const d = await deployment(t); await provision(d);
  const watched = watchPackage(t), { server } = await start(d);
  assert.equal(watched.calls(), 1);
  assert.equal((await request(server, nutritionPrefix + '/reset-fresh-empty', undefined, 'POST', nutritionEnvelope())).status, 401);
  const user = await login(server, emails[0], true);
  const reset = await request(server, nutritionPrefix + '/reset-fresh-empty', user, 'POST', nutritionEnvelope());
  assert.equal(reset.status, 201);
  const fresh = await reset.json() as NutritionWireResponse;
  assert.equal(fresh.status, 'reset'); assert.equal(fresh.code, null);
  assert.deepEqual(fresh.state?.conversation.turns, []);
  const path = `${nutritionPrefix}/${fresh.binding!.id}`;
  const initial: NutritionConversationInput = { choice: 'ask', previousTurnId: null, job: 'protein',
    question: 'protein supplementation resistance training',
    userContext: ['Artificial participant wants to understand protein supplementation research.'], correction: null };
  const corrected: NutritionConversationInput = { ...initial, choice: 'correct-question', previousTurnId: 1,
    question: 'FFM proxy', correction: 'Focus my question on the measured endpoint.' };
  const replacement: NutritionConversationInput = { ...corrected, choice: 'update-context', previousTurnId: 2,
    userContext: ['I am restricting energy intake.', 'Explain the study scope without choosing a supplement or intake target.'],
    correction: 'Replace my context: I am restricting energy intake.' };
  const gap: NutritionConversationInput = { ...replacement, choice: 'continue-question', previousTurnId: 3,
    question: 'How should I distribute protein across breakfast and dinner?', correction: null };
  const followup: NutritionConversationInput = { ...gap, previousTurnId: 4, question: 'FFM proxy' };
  const submissions = [initial, corrected, replacement, gap, followup];
  for (const [index, submitted] of submissions.entries()) {
    const response = await request(server, path + '/submit', user, 'POST', { ...nutritionEnvelope(), input: submitted });
    assert.equal(response.status, 200);
    const result = await response.json() as NutritionWireResponse;
    assert.equal(result.status, 'ok'); assert.equal(result.code, null); assert.equal(result.resetRequired, false);
    const state = result.state!, conversation = state.conversation, turn = conversation.turns.at(-1)!;
    assert.equal(conversation.turns.length, index + 1); assert.equal(turn.id, index + 1);
    assert.deepEqual(conversation.turns.map(item => item.input), submissions.slice(0, index + 1));
    assert.deepEqual(turn.input, submitted); assert.equal(turn.status, 'explanation');
    assert.equal(turn.supersedesTurnId, index === 1 || index === 2 ? index : null);
    assert.equal(state.currentSelection, null);
    const answer = turn.explanation!, sources = turn.sources!, isGap = index === 3;
    assert.equal(answer.status, isGap ? 'gap' : 'informative');
    assert.deepEqual(answer.evidence, {
      schema: 'form.observation-grounding/v1', source: expectedSource, clinicalReadiness: 'CL-0',
      coverage: proteinCoverage, corpusStatus: proteinCorpusStatus, query: submitted.question,
      filters: { topic: 'NUT-I3', access: null }, limit: 20, truncated: false, verbatimPassagesAvailable: false,
      ...(isGap ? { totalMatches: 0, status: 'gap', reason: 'no_matching_observations', observations: [] }
        : { totalMatches: 1, status: 'observations', observations: [proteinOriginal] }),
    });
    assert.deepEqual(answer.statements, isGap ? [] : [{ id: 'NUT-S034', evidenceKind: 'retained_source_observation',
      text: proteinOriginal.record.summary, citation: proteinOriginal, originalPassageVerified: false }]);
    assert.deepEqual(answer.options, isGap ? [] : [{ id: 'NUT-S034', kind: 'literature_consideration',
      title: proteinOriginal.record.title, statementId: 'NUT-S034', adoption: 'not_applied' }]);
    assert.deepEqual(answer.conflicts, []);
    assert.equal(answer.choice.decisionOwner, 'user'); assert.equal(answer.choice.automaticAdoption, false);
    assert.equal(answer.contextUse, 'acknowledged_not_applicability_assessed');
    assert.deepEqual(answer.context, { revision: `nutrition-turn-${index + 1}`,
      supersedesRevision: index === 0 ? null : `nutrition-turn-${index}`,
      facts: submitted.userContext.map((text, i) => ({ id: `nutrition-turn-${index + 1}-fact-${i + 1}`, text, origin: 'user_provided' })) });
    assert.deepEqual(sources.retrievalContext, answer.evidence);
    assert.deepEqual(sources.request, { job: 'protein', question: submitted.question,
      corrections: submissions.slice(0, index + 1).flatMap(value => value.correction === null ? [] : [value.correction]),
      consumer: 'CHAT', topicIds: ['NUT-I3'] });
    assert.deepEqual(sources.candidates.map(candidate => candidate.observation), isGap ? [] : [proteinOriginal]);
    assert.deepEqual(sources.traceableCandidateIndexes, isGap ? [] : [0]);
    for (const candidate of sources.candidates) {
      assert.equal(candidate.provenance.status, 'source-observation');
      if (candidate.provenance.status !== 'source-observation') assert.fail('source provenance missing');
      assert.equal(candidate.provenance.sourceRevision, expectedSource.revision);
      assert.equal(candidate.provenance.locator, 'docs/knowledge/research-followups/sources/nut-i3-protein-original.md:9');
      assert.deepEqual(candidate.provenance.limits, [proteinCorpusStatus.limitation, 'access-level: partial',
        proteinOriginal.record.source_native_certainty, proteinOriginal.record.form_appraisal, proteinOriginal.record.applicability,
        proteinOriginal.record.rights_status, proteinOriginal.record.freshness_status, proteinOriginal.record.provenance]);
    }
    assert.equal(sources.status, 'evidence-gap');
    assert.deepEqual(sources.boundary, { status: 'unavailable', reason: 'medical-boundary-policy-not-bound' });
    assert.ok(sources.gaps.some(item => item.code === 'policy-unavailable'));
    if (isGap) assert.ok(sources.gaps.some(item => item.code === 'no-traceable-observations'));
    assert.equal(sources.adviceAuthority, 'none'); assert.equal(sources.scientificAppraisal, 'not-performed');
    assert.equal(conversation.automaticAdoption, 'none'); assert.deepEqual(conversation.currentExplanation, answer);
    if (index > 0) {
      const staleResponse = await request(server, path + '/select-citation', user, 'POST', { ...nutritionEnvelope(),
        input: { parentTurnId: index, statementId: 'NUT-S034' } });
      assert.equal(staleResponse.status, 200);
      const stale = await staleResponse.json() as NutritionWireResponse;
      assert.equal(stale.status, 'rejected'); assert.equal(stale.code, 'stale_turn');
      assert.equal(stale.state!.currentSelection, null); assert.equal(stale.state!.selections.at(-1)!.status, 'stale-turn');
      assert.deepEqual(stale.state!.conversation, conversation);
    }
    const selection = await request(server, path + '/select-citation', user, 'POST', { ...nutritionEnvelope(),
      input: { parentTurnId: index + 1, statementId: 'NUT-S034' } });
    assert.equal(selection.status, 200);
    const selected = await selection.json() as NutritionWireResponse;
    assert.equal(selected.status, isGap ? 'rejected' : 'ok');
    assert.equal(selected.code, isGap ? 'unknown_statement' : null);
    assert.equal(selected.state!.selections.at(-1)!.status, isGap ? 'unknown-statement' : 'selected');
    if (isGap) assert.equal(selected.state!.currentSelection, null);
    else {
      const citation = selected.state!.currentSelection!;
      assert.equal(citation.parentTurnId, index + 1);
      assert.deepEqual(citation.statement.citation, proteinOriginal);
      assert.equal(citation.statement.originalPassageVerified, false);
      assert.deepEqual(citation.sources, sources);
    }
    assert.deepEqual(selected.state!.conversation, conversation);
    const snapshot = await request(server, path + '/snapshot', user, 'POST', nutritionEnvelope());
    assert.equal(snapshot.status, 200);
    const saved = await snapshot.json() as NutritionWireResponse;
    assert.equal(saved.status, 'ok'); assert.deepEqual(saved.state, selected.state);
  }
  const restartedResponse = await request(server, nutritionPrefix + '/reset-fresh-empty', user, 'POST', nutritionEnvelope());
  assert.equal(restartedResponse.status, 201);
  const restarted = await restartedResponse.json() as NutritionWireResponse;
  assert.equal(restarted.status, 'reset'); assert.equal(restarted.code, null);
  assert.notEqual(restarted.binding!.id, fresh.binding!.id);
  assert.deepEqual(restarted.state, { conversation: { turns: [], rejectedChoices: [], currentTurnId: null,
    currentExplanation: null, automaticAdoption: 'none' }, selections: [], currentSelection: null });
  assert.equal(watched.calls(), 1); assert.deepEqual(authentic(), bytes);
  assert.equal((await request(server, '/health')).status, 200);
});

test('runtime Form26 nutrition preserves honest gaps, correction and replacement context for the six uncovered jobs', async t => {
  const bytes = authentic();
  const projection = JSON.parse(bytes.toString('utf8')) as { records: ObservationEntry[] };
  assert.equal(projection.records.length, 26);
  assert.deepEqual(projection.records.filter(entry => entry.record.topic_ids.some(topic => /^NUT-I[1-7]$/.test(topic))), [proteinOriginal]);
  const d = await deployment(t); await provision(d);
  const watched = watchPackage(t), { server } = await start(d);
  assert.equal((await request(server, nutritionPrefix + '/reset-fresh-empty', undefined, 'POST', nutritionEnvelope())).status, 401);
  const user = await login(server, emails[0], true);
  const uncoveredJobs = (Object.keys(nutritionJobTopics) as NutritionConversationInput['job'][]).filter(job => job !== 'protein');
  assert.equal(uncoveredJobs.length, 6);
  for (const job of uncoveredJobs) {
    const reset = await request(server, nutritionPrefix + '/reset-fresh-empty', user, 'POST', nutritionEnvelope());
    assert.equal(reset.status, 201);
    const fresh = await reset.json() as NutritionWireResponse;
    assert.equal(fresh.status, 'reset'); assert.equal(fresh.code, null);
    assert.deepEqual(fresh.state?.conversation.turns, []);
    const path = `${nutritionPrefix}/${fresh.binding!.id}`;
    const initial: NutritionConversationInput = { choice: 'ask', previousTurnId: null, job,
      question: 'What does the retained nutrition evidence say?', userContext: ['Original user context.'], correction: null };
    const corrected: NutritionConversationInput = { ...initial, choice: 'correct-question', previousTurnId: 1,
      question: 'What does the retained evidence say about this corrected question?', correction: 'Correct my earlier question.' };
    const replacement: NutritionConversationInput = { ...corrected, choice: 'update-context', previousTurnId: 2,
      userContext: ['Replacement user context.'], correction: 'Replace the earlier context.' };
    for (const [index, submitted] of [initial, corrected, replacement].entries()) {
      const response = await request(server, path + '/submit', user, 'POST', { ...nutritionEnvelope(), input: submitted });
      assert.equal(response.status, 200);
      const result = await response.json() as NutritionWireResponse;
      assert.equal(result.status, 'ok'); assert.equal(result.code, null); assert.equal(result.resetRequired, false);
      const conversation = result.state!.conversation, turn = conversation.turns.at(-1)!;
      assert.equal(conversation.turns.length, index + 1); assert.equal(turn.id, index + 1);
      assert.deepEqual(turn.input, submitted); assert.equal(turn.status, 'explanation');
      assert.equal(turn.supersedesTurnId, index === 0 ? null : index);
      const answer = turn.explanation!, sources = turn.sources!;
      assert.equal(answer.status, 'gap'); assert.equal(sources.status, 'evidence-gap');
      assert.equal(answer.evidence.status, 'gap'); assert.equal(answer.evidence.clinicalReadiness, 'CL-0');
      assert.deepEqual(answer.evidence.source, expectedSource);
      assert.equal(answer.evidence.query, submitted.question); assert.equal(answer.evidence.filters.topic, nutritionJobTopics[job]);
      assert.equal(answer.evidence.totalMatches, 0); assert.deepEqual(answer.evidence.observations, []);
      assert.ok(answer.evidence.corpusStatus.units_without_observations.includes(nutritionJobTopics[job]));
      assert.equal(answer.evidence.verbatimPassagesAvailable, false);
      assert.equal(answer.evidence.coverage.units.find(unit => unit.unit_id === nutritionJobTopics[job])!.state, 'unsearched');
      assert.deepEqual(answer.statements, []); assert.deepEqual(answer.options, []); assert.deepEqual(answer.conflicts, []);
      assert.equal(answer.choice.decisionOwner, 'user'); assert.equal(answer.choice.automaticAdoption, false);
      assert.equal(answer.contextUse, 'acknowledged_not_applicability_assessed');
      assert.deepEqual(answer.context, { revision: `nutrition-turn-${index + 1}`, supersedesRevision: index === 0 ? null : `nutrition-turn-${index}`,
        facts: submitted.userContext.map((text, i) => ({ id: `nutrition-turn-${index + 1}-fact-${i + 1}`, text, origin: 'user_provided' })) });
      assert.deepEqual(sources.request.corrections, [initial, corrected, replacement].slice(0, index + 1)
        .flatMap(value => value.correction === null ? [] : [value.correction]));
      assert.deepEqual(sources.candidates, []); assert.deepEqual(sources.traceableCandidateIndexes, []);
      assert.equal(sources.boundary.status, 'unavailable');
      assert.ok(sources.gaps.some(gap => gap.code === 'policy-unavailable'));
      assert.ok(sources.gaps.some(gap => gap.code === 'no-traceable-observations'));
      assert.equal(sources.adviceAuthority, 'none'); assert.equal(sources.scientificAppraisal, 'not-performed');
      assert.equal(conversation.automaticAdoption, 'none'); assert.deepEqual(conversation.currentExplanation, answer);
      const snapshot = await request(server, path + '/snapshot', user, 'POST', nutritionEnvelope());
      assert.equal(snapshot.status, 200);
      const saved = await snapshot.json() as NutritionWireResponse;
      assert.equal(saved.status, 'ok'); assert.deepEqual(saved.state, result.state);
    }
    const selection = await request(server, path + '/select-citation', user, 'POST', { ...nutritionEnvelope(),
      input: { parentTurnId: 3, statementId: 'nonexistent-nutrition-statement' } });
    assert.equal(selection.status, 200);
    const selected = await selection.json() as NutritionWireResponse;
    assert.equal(selected.status, 'rejected'); assert.equal(selected.code, 'unknown_statement');
    assert.equal(selected.state!.currentSelection, null); assert.equal(selected.state!.selections.at(-1)!.status, 'unknown-statement');
  }
  assert.equal(watched.calls(), 1); assert.deepEqual(authentic(), bytes);
  assert.equal((await request(server, '/health')).status, 200);
});

test('typed package unavailability preserves runtime health and authenticated 501 without retrying the reader', async t => {
  const d = await deployment(t); await provision(d);
  const watched = watchPackage(t, () => { throw Object.assign(new Error('Synthetic absent package'), { code: 'ENOENT' }); });
  const { server } = await start(d); assert.equal(watched.calls(), 1);
  assert.equal((await request(server, '/health')).status, 200);
  const user = await login(server, emails[0], true);
  assert.equal((await request(server, '/v1/me', user)).status, 200);
  assert.equal((await request(server, nutritionPrefix + '/reset-fresh-empty', undefined, 'POST', nutritionEnvelope())).status, 401);
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await request(server, nutritionPrefix + '/reset-fresh-empty', user, 'POST', nutritionEnvelope());
    assert.equal(response.status, 200);
    const unavailable = await response.json() as NutritionWireResponse;
    assert.equal(unavailable.status, 'unavailable'); assert.equal(unavailable.code, 'nutrition_unconfigured');
    assert.equal(unavailable.binding, null); assert.equal(unavailable.state, null);
  }
  assert.equal((await request(server, '/v1/grounded-answers', undefined, 'POST', {})).status, 401);
  for (const body of [{}, input()]) {
    const response = await request(server, '/v1/grounded-answers', user, 'POST', body);
    assert.equal(response.status, 501); assert.deepEqual(await response.json(), {
      error: { code: 'grounded_answer_unavailable', message: 'grounded_answer_unavailable' },
    });
  }
  assert.equal(watched.calls(), 1);
});

for (const injection of ['sourceGroundedAnswers', 'sourceNutritionConversations'] as const) test(`runtime refuses ${injection} injection before package reads or main open`, async t => {
  const d = await deployment(t); await provision(d);
  const owner = new RuntimeOwner(d.configuration, d.path); t.after(() => owner.close(false));
  const before = fs.readFileSync(d.path), watched = watchPackage(t);
  const open = t.mock.method(owner, 'beforeOpen', () => assert.fail('Rejected injection must not open main storage'));
  const bytes = authentic();
  await assert.rejects(createServer({ dbPath: d.path, baseURL: origin, secret, runtimeOwner: owner,
    [injection]: { projectionBytes: bytes } }), /Runtime ownership cannot mix source injections/);
  assert.equal(watched.calls(), 0); assert.equal(open.mock.callCount(), 0);
  assert.deepEqual(fs.readFileSync(d.path), before); assert.throws(() => owner.assert(), { code: 'runtime_owner_unavailable' });
});

test('unvalidated runtime owner is refused before reading the package', async t => {
  const d = await deployment(t), watched = watchPackage(t);
  let closes = 0;
  const unvalidated = { close(clean: boolean) { assert.equal(clean, false); closes++; } } as unknown as RuntimeOwner;
  await assert.rejects(createServer({ dbPath: d.path, baseURL: origin, secret, runtimeOwner: unvalidated }), /Unvalidated runtime owner/);
  assert.equal(watched.calls(), 0); assert.equal(closes, 1); assert.equal(d.seed.db.open, true);
});

for (const available of [true, false]) test(`original owner lost across packaged await prevents main open when package available=${available}`, async t => {
  const d = await deployment(t); await provision(d);
  const owner = new RuntimeOwner(d.configuration, d.path); t.after(() => owner.close(false));
  const before = fs.readFileSync(d.path);
  const open = t.mock.method(owner, 'beforeOpen', () => assert.fail('Stale original owner must not open main storage'));
  const watched = watchPackage(t, () => {
    queueMicrotask(() => owner.close(false));
    if (!available) throw Object.assign(new Error('Synthetic absent package'), { code: 'ENOENT' });
  });
  await assert.rejects(createServer({ dbPath: d.path, baseURL: origin, secret, runtimeOwner: owner }), { code: 'runtime_owner_unavailable' });
  assert.equal(watched.calls(), 1); assert.equal(open.mock.callCount(), 0); assert.deepEqual(fs.readFileSync(d.path), before);
});

test('failed owner close remains a startup error alongside original owner loss', async t => {
  const d = await deployment(t); await provision(d);
  const owner = new RuntimeOwner(d.configuration, d.path), close = owner.close.bind(owner);
  t.after(() => close(false));
  const cleanupError = new Error('Synthetic close failure after actual closure');
  t.mock.method(owner, 'close', (clean: boolean) => { close(clean); throw cleanupError; });
  const open = t.mock.method(owner, 'beforeOpen', () => assert.fail('Owner loss must precede storage'));
  const watched = watchPackage(t, () => { queueMicrotask(() => close(false)); });
  await assert.rejects(createServer({ dbPath: d.path, baseURL: origin, secret, runtimeOwner: owner }), error => {
    assert.ok(error instanceof AggregateError); assert.equal(error.errors.length, 2);
    assert.equal((error.errors[0] as { code: string }).code, 'runtime_owner_unavailable');
    assert.equal(error.errors[1], cleanupError); return true;
  });
  assert.equal(watched.calls(), 1); assert.equal(open.mock.callCount(), 0);
});

test('runtime close fences pending answer delivery and subsequent requests', async t => {
  const d = await deployment(t); await provision(d); const { server } = await start(d);
  const user = await login(server, emails[0], true);
  let admitted!: () => void, controller!: ReadableStreamDefaultController<Uint8Array>;
  const reading = new Promise<void>(resolve => { admitted = resolve; });
  const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value; }, pull() { admitted(); } }, { highWaterMark: 0 });
  const cancel = () => { try { controller.error(new Error('Synthetic pending answer cleanup')); } catch {} };
  const unregister = registerStreamCancellation(server, cancel);
  const pending = Promise.resolve(server.handleRequest(new Request(origin + '/v1/grounded-answers', {
    method: 'POST', headers: { origin, authorization: `Bearer ${user.token}`, 'content-type': 'application/json' }, body: stream, duplex: 'half',
  } as RequestInit & { duplex: 'half' }), '127.0.0.1'));
  try {
    await Promise.race([reading, pending.then(response => { throw new Error(`Answer completed before body admission: ${response.status}`); })]);
    assert.throws(() => server.close(false), /Requests must drain before clean close/);
    controller.enqueue(new TextEncoder().encode(JSON.stringify(input()))); controller.close();
    const response = await pending; assert.ok([500, 503].includes(response.status));
    assert.equal(server.db.open, false);
    assert.equal((await request(server, '/v1/grounded-answers', user, 'POST', input())).status, 503);
  } finally { cancel(); unregister(); await pending.catch(() => {}); }
});

test('ordinary source-only startup stays unavailable and validates explicit bytes without invoking packaged reader', async t => {
  const watched = watchPackage(t, () => assert.fail('Source-only startup must not read packaged projection'));
  const d = await deployment(t);
  const user = await login(d.seed, emails[0], true);
  assert.equal((await request(d.seed, '/v1/grounded-answers', user, 'POST', input())).status, 501);
  const nutrition = await request(d.seed, nutritionPrefix + '/reset-fresh-empty', user, 'POST', nutritionEnvelope());
  assert.equal(nutrition.status, 200);
  const unavailable = await nutrition.json() as NutritionWireResponse;
  assert.equal(unavailable.status, 'unavailable'); assert.equal(unavailable.code, 'nutrition_unconfigured');
  const changed = authentic(); changed[100] = changed[100]! ^ 1;
  await assert.rejects(createServer({ dbPath: d.path, baseURL: origin, secret, sourceGroundedAnswers: { projectionBytes: changed } }),
    /Form follow-up projection digest mismatch/);
  assert.equal(watched.calls(), 0); assert.equal(d.seed.db.open, true);
});
