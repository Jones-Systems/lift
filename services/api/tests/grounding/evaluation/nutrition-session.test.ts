import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test, type TestContext } from 'node:test';
import Database from 'better-sqlite3';
import type { Sqlite } from '../../../src/storage.js';
import { assertActive, bindSuppressionAuthority } from '../../../src/lifecycle/guards.js';
import type { AccountContext } from '../../../src/lifecycle/types.js';
import { createRetainedNutritionConversationHost, NutritionConversationUnavailable,
  type NutritionHostBindings } from '../../../src/integration/nutrition-conversation/index.js';
import type { NutritionConversationInput } from '../../../src/domain-features/nutrition/conversation.js';
import type { NutritionCitationState } from '../../../src/domain-features/nutrition/citation-followthrough.js';
import { evaluateGroundedAnswer } from '../../../src/grounding/answer.js';
import type { GroundingResult, ObservationEntry } from '../../../src/grounding/index.js';
import { expectedSource, expectedCoverage, expectedCorpusStatus, expectedEntries } from './retained-oracle.js';
import { olderSoyDairy } from './nutrition-session-oracle.js';

const digest = '84530977a646d138ff1194d22d8723989ff6646dc3f69a8ab5c390783de55ad8';
const projectionBytes = readFileSync(new URL(`../../../grounding/${digest}/projection.json`, import.meta.url));
assert.equal(projectionBytes.byteLength, 1488603);
assert.equal(createHash('sha256').update(projectionBytes).digest('hex'), digest);
const firstQuestion = 'soy beef comparison';
const followupQuestion = 'soy dairy per protocol';
const missingQuestion = 'formws37unretainednutrition997';
const correctionText = 'Replace my dietary context; the literature is for explanation only.';
const initial = (): NutritionConversationInput => ({
  choice: 'ask', previousTurnId: null, job: 'protein', question: firstQuestion,
  userContext: ['Artificial participant asks to understand protein-source literature.', 'Artificial participant has not chosen a diet change.'], correction: null,
});
const corrected = (): NutritionConversationInput => ({
  choice: 'update-context', previousTurnId: 1, job: 'protein', question: firstQuestion,
  userContext: ['Correction: I avoid beef.', 'Explain study limitations; do not apply a diet change.'], correction: correctionText,
});

function entriesFor(question: string): readonly ObservationEntry[] {
  if (question === firstQuestion) return [expectedEntries['OLP-S01']!];
  if (question === followupQuestion) return [olderSoyDairy];
  assert.equal(question, missingQuestion, 'the trace must bind every query to its packet expectation');
  return [];
}

function packetEvidence(question: string): GroundingResult {
  const observations = entriesFor(question);
  const common = {
    schema: 'form.observation-grounding/v1' as const, source: expectedSource,
    clinicalReadiness: 'CL-0' as const, coverage: expectedCoverage, corpusStatus: expectedCorpusStatus,
    query: question, filters: { topic: 'NUT-I3', access: null }, limit: 20,
    totalMatches: observations.length, truncated: false, verbatimPassagesAvailable: false as const,
  };
  return observations.length === 0
    ? { ...common, status: 'gap', reason: 'no_matching_observations', observations: [] }
    : { ...common, status: 'observations', observations };
}

function qualifiedHistory(state: NutritionCitationState): void {
  assert.equal(state.conversation.automaticAdoption, 'none');
  const corrections: string[] = [];
  for (const turn of state.conversation.turns) {
    if (turn.input.correction !== null) corrections.push(turn.input.correction);
    if (turn.status === 'pending') {
      assert.equal(turn.explanation, null);
      assert.equal(turn.sources, null);
      continue;
    }
    assert.equal(turn.status, 'explanation');
    const answer = turn.explanation;
    const sources = turn.sources;
    assert.ok(answer && sources);
    const evidence = packetEvidence(turn.input.question);
    assert.deepEqual(answer.evidence, evidence);
    assert.deepEqual(sources.retrievalContext, evidence);
    assert.deepEqual(sources.request, {
      job: 'protein', question: turn.input.question, corrections: [...corrections], consumer: 'CHAT', topicIds: ['NUT-I3'],
    });
    assert.equal(sources.adviceAuthority, 'none');
    assert.equal(sources.scientificAppraisal, 'not-performed');
    assert.deepEqual(sources.boundary, { status: 'unavailable', reason: 'medical-boundary-policy-not-bound' });
    assert.ok(sources.gaps.some(gap => gap.code === 'policy-unavailable'));
    assert.equal(sources.status, 'evidence-gap');
    const context = {
      revision: `nutrition-turn-${turn.id}`,
      supersedesRevision: turn.id === 1 ? null : `nutrition-turn-${turn.id - 1}`,
      facts: turn.input.userContext.map((text, index) => ({ id: `nutrition-turn-${turn.id}-fact-${index + 1}`, text, origin: 'user_provided' as const })),
    };
    assert.deepEqual(answer.context, context);
    assert.equal(answer.contextUse, 'acknowledged_not_applicability_assessed');
    assert.equal(answer.status, evidence.status === 'gap' ? 'gap' : 'informative');
    assert.deepEqual(answer.statements, evidence.observations.map(entry => ({
      id: entry.record.id, evidenceKind: 'retained_source_observation', text: entry.record.summary,
      citation: entry, originalPassageVerified: false,
    })));
    assert.deepEqual(answer.options, evidence.observations.map(entry => ({
      id: entry.record.id, kind: 'literature_consideration', title: entry.record.title,
      statementId: entry.record.id, adoption: 'not_applied',
    })));
    assert.deepEqual(answer.choice, { decisionOwner: 'user', automaticAdoption: false,
      text: 'You can use these observations when considering your options. No choice or change has been applied.' });
    assert.deepEqual(evaluateGroundedAnswer(answer, evidence, context), {
      schema: 'form.grounded-answer-evaluation/v1', passed: true, scope: 'source_fidelity_and_contract', failures: [],
      scientificValidityAssessed: false, individualApplicabilityAssessed: false, publicationRightsAssessed: false,
    });
    assert.deepEqual(sources.candidates.map(candidate => candidate.observation), evidence.observations);
    assert.deepEqual(sources.traceableCandidateIndexes, evidence.observations.map((_, index) => index));
    for (const candidate of sources.candidates) {
      assert.equal(candidate.provenance.status, 'source-observation');
      if (candidate.provenance.status !== 'source-observation') throw new Error('unqualified packet candidate');
      const { record } = candidate.observation;
      assert.equal(candidate.provenance.sourceRevision, expectedSource.revision);
      assert.deepEqual(candidate.provenance.limits, [expectedCorpusStatus.limitation, `access-level: ${record.access_level}`,
        record.source_native_certainty, record.form_appraisal, record.applicability, record.rights_status, record.freshness_status, record.provenance]);
    }
  }
  if (state.currentSelection !== null) {
    const turn = state.conversation.turns.find(item => item.id === state.currentSelection!.parentTurnId)!;
    const entry = entriesFor(turn.input.question).find(item => item.record.id === state.currentSelection!.statementId)!;
    assert.deepEqual(state.currentSelection.statement.citation, entry);
    assert.deepEqual(state.currentSelection.sources, turn.sources);
    assert.equal(state.currentSelection.statement.originalPassageVerified, false);
    assert.equal(state.currentSelection.parentTurnId, state.conversation.currentTurnId);
  }
}

const losses = ['request-identity', 'abort-signal', 'conversation-identity', 'generation-identity',
  'account-switch', 'session-revocation', 'epoch-change', 'account-disabled', 'dispose'] as const;
type Loss = typeof losses[number];

function fixture(t: TestContext) {
  const db: Sqlite = new Database(':memory:');
  t.after(() => db.close());
  db.exec(`CREATE TABLE form_accounts(id TEXT PRIMARY KEY,auth_user_id TEXT NOT NULL);
    CREATE TABLE session(id TEXT PRIMARY KEY,userId TEXT NOT NULL,expiresAt INTEGER NOT NULL);
    CREATE TABLE account_lifecycle(account_id TEXT PRIMARY KEY,state TEXT NOT NULL,epoch INTEGER NOT NULL);
    INSERT INTO form_accounts VALUES('evaluation-account','evaluation-user');
    INSERT INTO account_lifecycle VALUES('evaluation-account','active',0);`);
  const restoreRows = () => {
    db.prepare('INSERT OR REPLACE INTO session VALUES(?,?,?)').run('evaluation-session', 'evaluation-user', Number.MAX_SAFE_INTEGER);
    db.prepare("UPDATE account_lifecycle SET state='active',epoch=0 WHERE account_id=?").run('evaluation-account');
  };
  restoreRows();
  bindSuppressionAuthority(db, {
    currentSequence: () => 0, lookup: () => null, reconcileRestore: () => 0,
    recordDisable: () => { throw new Error('the artificial ledger does not write disable records'); },
  });
  const actor: AccountContext = { accountId: 'evaluation-account', authUserId: 'evaluation-user', sessionId: 'evaluation-session', epoch: 0 };
  let currentActor = { ...actor };
  const lifetime = { conversation: {}, generation: {} };
  let currentLifetime = { ...lifetime };
  const firstRequestIdentity = {};
  let requestIdentity = firstRequestIdentity;
  let controller = new AbortController();
  let authorityChecks = 0;
  let scheduledLoss: { remainingChecks: number; loss: Loss } | null = null;
  const bindings: NutritionHostBindings = {
    actor, lifetime,
    lifecycle: { assertActive: captured => {
      authorityChecks++;
      assert.deepEqual(captured, actor);
      assert.ok(Object.isFrozen(captured));
      assertActive(db, captured);
      if (scheduledLoss !== null && --scheduledLoss.remainingChecks === 0) {
        const loss = scheduledLoss.loss;
        scheduledLoss = null;
        lose(loss);
      }
    } },
    isCurrentHost: (captured, capturedActor) => captured.conversation === currentLifetime.conversation
      && captured.generation === currentLifetime.generation && capturedActor.accountId === currentActor.accountId
      && capturedActor.authUserId === currentActor.authUserId && capturedActor.sessionId === currentActor.sessionId
      && capturedActor.epoch === currentActor.epoch,
    captureRequest: () => ({ identity: requestIdentity, signal: controller.signal }),
    isCurrentRequest: captured => captured === requestIdentity,
  };
  const result = createRetainedNutritionConversationHost({ bindings, projectionBytes });
  assert.equal(result.status, 'available');
  if (result.status !== 'available') throw new Error('the pinned production factory was unavailable');
  const host = result;
  t.after(host.dispose);
  function lose(loss: Loss): void {
    switch (loss) {
      case 'request-identity': requestIdentity = {}; break;
      case 'abort-signal': controller.abort(); break;
      case 'conversation-identity': currentLifetime = { ...currentLifetime, conversation: {} }; break;
      case 'generation-identity': currentLifetime = { ...currentLifetime, generation: {} }; break;
      case 'account-switch': currentActor = { ...currentActor, accountId: 'other-artificial-account' }; break;
      case 'session-revocation': db.prepare('DELETE FROM session WHERE id=?').run(actor.sessionId); break;
      case 'epoch-change': db.prepare('UPDATE account_lifecycle SET epoch=epoch+1 WHERE account_id=?').run(actor.accountId); break;
      case 'account-disabled': db.prepare("UPDATE account_lifecycle SET state='disabled' WHERE account_id=?").run(actor.accountId); break;
      case 'dispose': host.dispose(); break;
    }
  }
  function restoreBindings(): void {
    currentActor = { ...actor }; currentLifetime = { ...lifetime };
    requestIdentity = firstRequestIdentity; controller = new AbortController(); scheduledLoss = null; restoreRows();
  }
  return { host, lose, restoreBindings, authorityChecks: () => authorityChecks,
    loseAfterAuthorityChecks: (remainingChecks: number, loss: Loss) => { scheduledLoss = { remainingChecks, loss }; } };
}

const unavailable = (outcome: 'unknown' | 'not-started') => (error: unknown) =>
  error instanceof NutritionConversationUnavailable && error.code === 'nutrition_conversation_unavailable'
    && error.outcome === outcome && !Object.hasOwn(error, 'state');

async function informativeSelection(h: ReturnType<typeof fixture>): Promise<NutritionCitationState> {
  qualifiedHistory(await h.host.submit(initial()));
  const selected = h.host.selectCitation({ parentTurnId: 1, statementId: 'OLP-S01' });
  assert.equal(selected.currentSelection?.status, 'selected');
  qualifiedHistory(selected);
  return selected;
}

async function permanentlyUnavailable(h: ReturnType<typeof fixture>): Promise<void> {
  h.restoreBindings();
  assert.throws(() => h.host.snapshot(), unavailable('not-started'));
  assert.throws(() => h.host.selectCitation({ parentTurnId: 1, statementId: 'OLP-S01' }), unavailable('not-started'));
  await assert.rejects(h.host.submit(corrected()), unavailable('not-started'));
  await assert.rejects(h.host.submit(initial()), unavailable('not-started'));
}

test('EVAL-SESSION-01: retained nutrition host preserves a full correction/citation/gap/follow-up trace', async t => {
  const h = fixture(t);
  const original = await informativeSelection(h);
  const pending = h.host.submit(corrected());
  void pending.catch(() => undefined);
  const immediate = h.host.snapshot();
  assert.equal(immediate.currentSelection, null);
  assert.equal(immediate.conversation.currentExplanation, null);
  assert.equal(immediate.conversation.currentTurnId, 2);
  assert.equal(immediate.conversation.turns[1]?.status, 'pending');
  assert.deepEqual(immediate.conversation.turns[0], original.conversation.turns[0]);
  assert.deepEqual(immediate.selections[0], original.selections[0]);
  assert.equal(h.host.selectCitation({ parentTurnId: 1, statementId: 'OLP-S01' }).selections.at(-1)?.status, 'stale-turn');
  assert.equal(h.host.selectCitation({ parentTurnId: 2, statementId: 'OLP-S01' }).selections.at(-1)?.status, 'answer-unavailable');
  const replaced = await pending;
  qualifiedHistory(replaced);
  assert.equal(replaced.currentSelection, null);
  assert.equal(replaced.conversation.turns[1]?.supersedesTurnId, 1);
  assert.deepEqual(replaced.conversation.turns[0], original.conversation.turns[0]);
  const selectedCorrection = h.host.selectCitation({ parentTurnId: 2, statementId: 'OLP-S01' });
  qualifiedHistory(selectedCorrection);
  const staleInput = { ...corrected(), choice: 'continue-question' as const, previousTurnId: 1, correction: null };
  await assert.rejects(h.host.submit(staleInput), /stale-nutrition-turn/);
  assert.deepEqual(h.host.snapshot().currentSelection, selectedCorrection.currentSelection);

  const gapInput: NutritionConversationInput = { ...corrected(), choice: 'continue-question', previousTurnId: 2,
    question: missingQuestion, correction: null };
  const gapPending = h.host.submit(gapInput);
  void gapPending.catch(() => undefined);
  assert.equal(h.host.snapshot().conversation.currentExplanation, null);
  assert.equal(h.host.snapshot().currentSelection, null);
  const gap = await gapPending;
  qualifiedHistory(gap);
  assert.equal(gap.conversation.currentExplanation?.status, 'gap');
  assert.equal(gap.conversation.currentExplanation?.introduction, 'No matching observations were found for this search in the retained corpus.');
  assert.ok(gap.conversation.turns[2]?.sources?.gaps.some(item => item.code === 'no-traceable-observations'));
  const gapChoice = h.host.selectCitation({ parentTurnId: 3, statementId: 'OLP-S01' });
  assert.equal(gapChoice.selections.at(-1)?.status, 'unknown-statement');
  assert.equal(gapChoice.currentSelection, null);

  const followupInput: NutritionConversationInput = { ...gapInput, previousTurnId: 3, question: followupQuestion };
  const complete = await h.host.submit(followupInput);
  qualifiedHistory(complete);
  assert.deepEqual(complete.conversation.turns.map(turn => turn.input), [initial(), corrected(), gapInput, followupInput]);
  assert.deepEqual(complete.conversation.turns.map(turn => turn.id), [1, 2, 3, 4]);
  assert.deepEqual(complete.conversation.turns[2], gap.conversation.turns[2]);
  assert.deepEqual(complete.selections, gapChoice.selections);
  assert.deepEqual(complete.conversation.rejectedChoices, [{ input: staleInput, reason: 'stale-nutrition-turn' }]);
  const selectedFollowup = h.host.selectCitation({ parentTurnId: 4, statementId: 'OLP-S02' });
  qualifiedHistory(selectedFollowup);
  assert.deepEqual(selectedFollowup.currentSelection?.conflicts, [{ observationId: 'OLP-S02',
    conflictingObservationId: 'OLP-S03', referencedObservationIncluded: false, disposition: 'unresolved' }]);
  assert.equal(selectedFollowup.currentSelection?.statement.citation.record.access_level, 'partial');
  assert.equal(selectedFollowup.currentSelection?.statement.citation.record.freshness_status, 'Historical trial; final-table verification unresolved.');
  assert.deepEqual(selectedFollowup.selections.map(item => item.status), ['selected', 'stale-turn', 'answer-unavailable', 'selected', 'unknown-statement', 'selected']);
  assert.deepEqual(h.host.snapshot(), selectedFollowup);
  assert.ok(h.authorityChecks() > 0);
});

for (const [index, loss] of losses.entries()) {
  test(`EVAL-SESSION-LOSS-${String(index + 1).padStart(2, '0')}: ${loss} withholds an admitted corrected answer permanently`, async t => {
    const h = fixture(t);
    const historical = await informativeSelection(h);
    const historicalCopy = structuredClone(historical);
    const pending = h.host.submit(corrected());
    void pending.catch(() => undefined);
    const immediate = h.host.snapshot();
    assert.equal(immediate.currentSelection, null);
    assert.equal(immediate.conversation.currentExplanation, null);
    assert.equal(immediate.conversation.turns[1]?.status, 'pending');
    assert.deepEqual(immediate.conversation.turns[0], historical.conversation.turns[0]);
    h.lose(loss);
    await assert.rejects(pending, unavailable('unknown'));
    await permanentlyUnavailable(h);
    assert.deepEqual(historical, historicalCopy);
    qualifiedHistory(historical);
  });
}

for (const operation of ['snapshot', 'selectCitation'] as const) {
  test(`EVAL-SESSION-READ-${operation}: delivery-boundary loss suppresses a qualified read or choice`, async t => {
    for (const loss of ['request-identity', 'generation-identity', 'account-switch', 'abort-signal'] as const) {
      const h = fixture(t);
      const previous = await informativeSelection(h);
      const previousCopy = structuredClone(previous);
      h.loseAfterAuthorityChecks(2, loss);
      assert.throws(() => operation === 'snapshot' ? h.host.snapshot()
        : h.host.selectCitation({ parentTurnId: 1, statementId: 'OLP-S01' }), unavailable('unknown'));
      await permanentlyUnavailable(h);
      assert.deepEqual(previous, previousCopy);
      qualifiedHistory(previous);
    }
  });
}
