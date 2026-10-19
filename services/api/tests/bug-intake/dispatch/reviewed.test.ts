import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { DomainError } from '../../../src/errors.js';
import { bugEvidenceCandidateDigest, parseBugEvidenceCandidate, type BugEvidenceSource,
  type BugTechnicalExtract, type ReviewedBugEvidence } from '../../../src/bug-intake/evidence.js';
import { bugReportFingerprint } from '../../../src/bug-intake/triage.js';
import { createReviewedJonesBugDispatchAdapter, type JonesReviewedDispatchBindings,
  type JonesReviewedGrant } from '../../../src/bug-intake/dispatch/index.js';
import type { PreparedHandoff } from '../../../src/bug-intake/types.js';
import { createBugIntakeService, bugOutcomeSnapshotDigest, createBugOutcomeView, createBugReporterOutcome,
  type BugOutcomeSnapshotContent, type BugOutcomeSnapshot, type BugOutcomeSource,
  type BugReporterProjectionAuthority } from '../../../src/bug-intake/index.js';
import { authority, binding, errorCode, fixture, input } from '../fixture.js';

const reportId = '11111111-1111-4111-8111-111111111111';
const reportInput = { ...input, diagnosticConsent: false };
const handoff = (): PreparedHandoff => ({ handoffId: reportId, binding,
  report: { kind: 'untrusted_user_report', content: reportInput } });
function syntheticEvidence(id = reportId): ReviewedBugEvidence {
  const candidate = parseBugEvidenceCandidate({
    binding: { reportId: id, reportFingerprint: bugReportFingerprint(reportInput), investigation: {
      repository: binding.repository, sourceRevision: binding.sourceRevision,
      investigationScopeId: 'synthetic-investigation-scope', authorityId: 'synthetic-investigator',
    } },
    recipientPolicy: { recipientId: 'synthetic-jones', policyRevision: 'policy-1', purpose: 'technical_bug_investigation',
      retentionPolicyId: 'synthetic-retention', exportPolicyId: 'synthetic-export', purgePolicyId: 'synthetic-purge' },
    payload: { schema: 'form.bug-technical-extract/v1', authorityEffect: 'none', executionAuthorized: false,
      facts: [{ id: 'synthetic-fact', kind: 'synthetic_reproduction', statement: 'Synthetic source fixture reproduces an inert workout button.',
        evidence: { artifactId: 'synthetic-fixture', artifactSha256: 'c'.repeat(64), sourceRevision: binding.sourceRevision } }] },
  });
  return { candidate, review: { reviewId: 'synthetic-review', reviewerAuthorityId: 'synthetic-reviewer',
    candidateDigest: bugEvidenceCandidateDigest(candidate), attestation: 'reviewed_source_and_synthetic_facts_only' } };
}
function receiverFixture() {
  const context = { accountId: 'account-A', authUserId: 'auth-A', sessionId: 'session-A', epoch: 0 };
  const events: string[] = [], received: BugTechnicalExtract[] = [];
  const state: {
    reportId: string; reviewed: unknown; active: boolean; access: boolean; reviewCurrent: boolean;
    grantCalls: number; portCalls: number; afterGrant: () => void;
    grant: (request: JonesReviewedGrant) => unknown; outcome: () => unknown | Promise<unknown>;
  } = { reportId, reviewed: syntheticEvidence(), active: true, access: true, reviewCurrent: true,
    grantCalls: 0, portCalls: 0, afterGrant() {}, grant: request => request,
    outcome: () => ({ status: 'accepted', receiptId: 'synthetic-reviewed-receipt' }) };
  const source: BugEvidenceSource = {
    assertReportAccess(actor, id) {
      events.push('access');
      if (!state.access || id !== state.reportId || actor.accountId !== 'account-A' || actor.authUserId !== 'auth-A' ||
        actor.sessionId !== 'session-A' || actor.epoch !== 0) throw new DomainError(403, 'synthetic_access_denied');
    },
    reviewedFor() { events.push('read'); return state.reviewed as ReviewedBugEvidence | null; },
    assertCurrent() { events.push('current'); if (!state.reviewCurrent) throw new Error('synthetic review/source/policy revoked'); },
  };
  const bindings: JonesReviewedDispatchBindings = { binding, evidence: { context,
    assertActive() { if (!state.active) throw new DomainError(403, 'synthetic_account_disabled'); }, source },
    currentGrantFor(request) { events.push('grant'); state.grantCalls++; const grant = state.grant(request); state.afterGrant(); return grant; },
    port: { async submit(payload) { events.push('port'); state.portCalls++; received.push(payload); return state.outcome(); } },
  };
  return { state, events, received, bindings, adapter: createReviewedJonesBugDispatchAdapter(bindings) };
}

test('reviewed producer forwards only detached frozen technical payload after grant and final currentness', async () => {
  const f = receiverFixture();
  assert.deepEqual(await f.adapter.submit(handoff()), { status: 'accepted', receiptId: 'synthetic-reviewed-receipt' });
  assert.equal(f.state.portCalls, 1); assert.equal(f.state.grantCalls, 1);
  const approved = f.state.reviewed as ReviewedBugEvidence;
  assert.deepEqual(f.received, [approved.candidate.payload]);
  assert.notEqual(f.received[0], approved.candidate.payload);
  assert.deepEqual(Object.keys(f.received[0]!).sort(), ['authorityEffect', 'executionAuthorized', 'facts', 'schema']);
  assert.ok(Object.isFrozen(f.received[0])); assert.ok(Object.isFrozen(f.received[0]!.facts));
  assert.ok(Object.isFrozen(f.received[0]!.facts[0]!.evidence));
  const outbound = JSON.stringify(f.received[0]);
  for (const privateValue of [reportId, reportInput.title, reportInput.description, 'account-A', 'auth-A', 'session-A',
    'synthetic-reviewer', 'synthetic-review', 'synthetic-retention', 'synthetic-investigation-scope', binding.acceptedScopeId])
    assert.equal(outbound.includes(privateValue), false);
  const grantIndex = f.events.indexOf('grant');
  assert.ok(f.events.indexOf('current', grantIndex) > grantIndex);
  assert.ok(f.events.indexOf('port') > f.events.indexOf('current', grantIndex));
});

test('missing source, grant or port remains known no effect without a native call', async () => {
  for (const missing of ['source', 'grant', 'port']) {
    const f = receiverFixture();
    const { source: _source, ...noSource } = f.bindings.evidence;
    const { currentGrantFor: _grant, ...noGrant } = f.bindings;
    const { port: _port, ...noPort } = f.bindings;
    const bindings = missing === 'source' ? { ...f.bindings, evidence: noSource } : missing === 'grant' ? noGrant : noPort;
    assert.deepEqual(await createReviewedJonesBugDispatchAdapter(bindings).submit(handoff()), { status: 'known_no_effect' });
    assert.equal(f.state.portCalls, 0); assert.equal(f.state.grantCalls, 0);
  }
});

test('trusted configuration captures context, binding, source and activity callbacks before caller mutation', async () => {
  const f = receiverFixture(), mutableBinding = { ...binding };
  const adapter = createReviewedJonesBugDispatchAdapter({ ...f.bindings, binding: mutableBinding });
  mutableBinding.sourceRevision = 'b'.repeat(40);
  Object.assign(f.bindings.evidence.context, { accountId: 'different-account' });
  Object.assign(f.bindings.evidence.source!, { assertCurrent() { throw new Error('replaced source'); } });
  Object.assign(f.bindings.evidence, { assertActive() { throw new Error('replaced activity callback'); } });
  assert.deepEqual(await adapter.submit(handoff()), { status: 'accepted', receiptId: 'synthetic-reviewed-receipt' });
  assert.equal(f.state.portCalls, 1);
});

test('private report text is never recast as technical evidence when review is absent or unproved', async () => {
  const missing = receiverFixture(); missing.state.reviewed = null;
  assert.deepEqual(await missing.adapter.submit(handoff()), { status: 'known_no_effect' });
  assert.equal(missing.state.grantCalls, 0); assert.equal(missing.state.portCalls, 0);
  const unproved = receiverFixture();
  const evidence = syntheticEvidence();
  const candidate = parseBugEvidenceCandidate({ ...evidence.candidate, payload: { ...evidence.candidate.payload,
    facts: [{ ...evidence.candidate.payload.facts[0], statement: reportInput.description }] } });
  unproved.state.reviewed = { candidate, review: { ...evidence.review, candidateDigest: bugEvidenceCandidateDigest(candidate) } };
  unproved.state.reviewCurrent = false;
  assert.deepEqual(await unproved.adapter.submit(handoff()), { status: 'known_no_effect' });
  assert.equal(unproved.state.grantCalls, 0); assert.equal(unproved.state.portCalls, 0);
});

test('account/access rejection and stale trusted review deny submission before grant', async () => {
  for (const field of ['active', 'access', 'reviewCurrent'] as const) {
    const f = receiverFixture(); f.state[field] = false;
    assert.deepEqual(await f.adapter.submit(handoff()), { status: 'known_no_effect' });
    assert.equal(f.state.grantCalls, 0); assert.equal(f.state.portCalls, 0);
  }
});

test('producer report, fingerprint and current source must match the accepted local handoff', async () => {
  for (const field of ['reportId', 'reportFingerprint', 'sourceRevision'] as const) {
    const f = receiverFixture(), original = syntheticEvidence();
    const changedBinding = field === 'sourceRevision'
      ? { ...original.candidate.binding, investigation: { ...original.candidate.binding.investigation, sourceRevision: 'b'.repeat(40) } }
      : { ...original.candidate.binding, [field]: field === 'reportId' ? '22222222-2222-4222-8222-222222222222' : 'b'.repeat(64) };
    const candidate = parseBugEvidenceCandidate({ ...original.candidate, binding: changedBinding,
      payload: { ...original.candidate.payload, facts: original.candidate.payload.facts.map(fact => ({ ...fact,
        evidence: { ...fact.evidence, sourceRevision: changedBinding.investigation.sourceRevision } })) } });
    f.state.reviewed = { candidate, review: { ...original.review, candidateDigest: bugEvidenceCandidateDigest(candidate) } };
    assert.deepEqual(await f.adapter.submit(handoff()), { status: 'known_no_effect' });
    assert.equal(f.state.grantCalls, 0); assert.equal(f.state.portCalls, 0);
  }
});

test('review digest mismatch and extra private producer fields deny any port invocation', async () => {
  for (const malformed of [
    { ...syntheticEvidence(), review: { ...syntheticEvidence().review, candidateDigest: 'd'.repeat(64) } },
    { ...syntheticEvidence(), originalReport: handoff().report },
    { ...syntheticEvidence(), candidate: { ...syntheticEvidence().candidate, privatePacket: 'synthetic-private' } },
    { ...syntheticEvidence(), candidate: { ...syntheticEvidence().candidate, recipientPolicy: null } },
  ]) {
    const f = receiverFixture(); f.state.reviewed = malformed;
    assert.deepEqual(await f.adapter.submit(handoff()), { status: 'known_no_effect' });
    assert.equal(f.state.grantCalls, 0); assert.equal(f.state.portCalls, 0);
  }
});

test('hand-off execution bindings are validated before producer or grant callbacks', async () => {
  for (const changed of [{ repository: 'Jones-Systems/Other' }, { sourceRevision: 'b'.repeat(40) },
    { acceptedScopeId: 'unaccepted-scope' }, { authorityId: 'forged-authority' }]) {
    const f = receiverFixture();
    assert.deepEqual(await f.adapter.submit({ ...handoff(), binding: { ...binding, ...changed } } as PreparedHandoff),
      { status: 'known_no_effect' });
    assert.deepEqual(f.events, []); assert.equal(f.state.portCalls, 0);
  }
});

test('separate grant binds exact report, fingerprint, candidate digest and accepted execution authority', async () => {
  for (const field of ['reportId', 'reportFingerprint', 'candidateDigest', 'repository', 'sourceRevision', 'acceptedScopeId', 'authorityId']) {
    const f = receiverFixture();
    f.state.grant = request => ['repository', 'sourceRevision', 'acceptedScopeId', 'authorityId'].includes(field)
      ? { ...request, binding: { ...request.binding, [field]: field === 'sourceRevision' ? 'b'.repeat(40) : 'different' } }
      : { ...request, [field]: field === 'reportId' ? '22222222-2222-4222-8222-222222222222' : 'b'.repeat(64) };
    assert.deepEqual(await f.adapter.submit(handoff()), { status: 'known_no_effect' });
    assert.equal(f.state.grantCalls, 1); assert.equal(f.state.portCalls, 0);
  }
});

test('separate grant binds every recipient policy field and rejects unexpected grant fields', async () => {
  for (const field of ['recipientId', 'policyRevision', 'purpose', 'retentionPolicyId', 'exportPolicyId', 'purgePolicyId', 'extra']) {
    const f = receiverFixture();
    f.state.grant = request => field === 'extra' ? { ...request, executionAuthorized: true }
      : { ...request, recipientPolicy: { ...request.recipientPolicy, [field]: 'different' } };
    assert.deepEqual(await f.adapter.submit(handoff()), { status: 'known_no_effect' }); assert.equal(f.state.portCalls, 0);
  }
});

test('grant revocation, absence and lookup failure prove no downstream invocation', async () => {
  for (const grant of [null, undefined, { revoked: true }]) {
    const f = receiverFixture(); f.state.grant = () => grant;
    assert.deepEqual(await f.adapter.submit(handoff()), { status: 'known_no_effect' }); assert.equal(f.state.portCalls, 0);
  }
  const f = receiverFixture(); f.state.grant = () => { throw new Error('synthetic grant unavailable'); };
  assert.deepEqual(await f.adapter.submit(handoff()), { status: 'known_no_effect' }); assert.equal(f.state.portCalls, 0);
});

test('grant callback invalidation triggers final producer/access/activity recheck before optional port', async () => {
  for (const field of ['reviewCurrent', 'access', 'active'] as const) {
    const f = receiverFixture(); f.state.afterGrant = () => { f.state[field] = false; };
    assert.deepEqual(await f.adapter.submit(handoff()), { status: 'known_no_effect' });
    assert.equal(f.state.grantCalls, 1); assert.equal(f.state.portCalls, 0);
  }
});

test('possibly invoked port throws or malformed receipts remain unknown without retry', async () => {
  for (const outcome of [() => { throw new Error('synthetic synchronous failure'); },
    () => Promise.reject(new Error('synthetic lost response')),
    () => ({ status: 'accepted', receiptId: '../private-path' }),
    () => ({ status: 'accepted', receiptId: 'ok', privateReport: 'synthetic' }),
    () => ({ status: 'known_no_effect', receiptId: 'contradictory' }), () => undefined]) {
    const f = receiverFixture(); f.state.outcome = outcome;
    assert.deepEqual(await f.adapter.submit(handoff()), { status: 'unknown' }); assert.equal(f.state.portCalls, 1);
  }
});

test('a directly throwing port is possibly invoked and remains unknown', async () => {
  const f = receiverFixture(); let calls = 0;
  const adapter = createReviewedJonesBugDispatchAdapter({ ...f.bindings,
    port: { submit() { calls++; throw new Error('synthetic immediate throw'); } } });
  assert.deepEqual(await adapter.submit(handoff()), { status: 'unknown' }); assert.equal(calls, 1);
});

test('service receipt acknowledges the reviewed handoff and duplicate intake cannot resend it', async t => {
  const receiver = receiverFixture(); const f = fixture({ authority, dispatch: receiver.adapter }); t.after(f.close);
  const id = f.A.submit(input, 'reviewed-request-1').report.id;
  receiver.state.reportId = id; receiver.state.reviewed = syntheticEvidence(id); f.A.prepare(id);
  receiver.state.outcome = () => { assert.equal(f.A.get(id).state, 'dispatch_unknown'); assert.equal(f.db.inTransaction, false);
    return { status: 'accepted', receiptId: 'synthetic-reviewed-receipt' }; };
  assert.deepEqual(await f.A.dispatch(id), { state: 'dispatched' });
  const duplicate = f.A.submit(input, 'reviewed-request-2');
  assert.equal(duplicate.duplicate, true); assert.equal(duplicate.report.id, id);
  assert.equal(duplicate.report.dispatchReceiptId, 'synthetic-reviewed-receipt');
  const recreated = f.serviceFor(f.contexts.A);
  await assert.rejects(recreated.dispatch(id), errorCode('bug_dispatch_reconciliation_required'));
  assert.throws(() => recreated.prepare(id), errorCode('bug_dispatch_reconciliation_required'));
  assert.equal(receiver.state.portCalls, 1);
});

test('service unknown effects survive concurrent dispatch, recreation and blind retry attempts', async t => {
  const receiver = receiverFixture(); let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  receiver.state.outcome = async () => { await waiting; throw new Error('synthetic lost response'); };
  const f = fixture({ authority, dispatch: receiver.adapter }); t.after(f.close);
  const id = f.A.submit(input, 'reviewed-request-1').report.id;
  receiver.state.reportId = id; receiver.state.reviewed = syntheticEvidence(id); f.A.prepare(id);
  const pending = f.A.dispatch(id), recreated = f.serviceFor(f.contexts.A);
  assert.equal(recreated.get(id).state, 'dispatch_unknown');
  await assert.rejects(recreated.dispatch(id), errorCode('bug_dispatch_reconciliation_required'));
  assert.throws(() => recreated.prepare(id), errorCode('bug_dispatch_reconciliation_required'));
  release(); assert.deepEqual(await pending, { state: 'dispatch_unknown' });
  await assert.rejects(recreated.dispatch(id), errorCode('bug_dispatch_reconciliation_required'));
  assert.equal(receiver.state.portCalls, 1);
});

test('service malformed downstream acceptance retains durable unknown and no receipt', async t => {
  const receiver = receiverFixture(); receiver.state.outcome = () => ({ status: 'accepted', receiptId: '../private-path' });
  const f = fixture({ authority, dispatch: receiver.adapter }); t.after(f.close);
  const id = f.A.submit(input, 'reviewed-request-1').report.id;
  receiver.state.reportId = id; receiver.state.reviewed = syntheticEvidence(id); f.A.prepare(id);
  assert.deepEqual(await f.A.dispatch(id), { state: 'dispatch_unknown' }); assert.equal(f.A.get(id).dispatchReceiptId, undefined);
  await assert.rejects(f.A.dispatch(id), errorCode('bug_dispatch_reconciliation_required'));
  assert.equal(receiver.state.portCalls, 1);
});

test('service known no effect allows explicit retry only after a fresh producer and grant check', async t => {
  const receiver = receiverFixture(); receiver.state.grant = () => null;
  const f = fixture({ authority, dispatch: receiver.adapter }); t.after(f.close);
  const id = f.A.submit(input, 'reviewed-request-1').report.id;
  receiver.state.reportId = id; receiver.state.reviewed = syntheticEvidence(id); f.A.prepare(id);
  assert.deepEqual(await f.A.dispatch(id), { state: 'dispatch_unavailable' }); assert.equal(receiver.state.portCalls, 0);
  receiver.state.grant = request => request;
  assert.deepEqual(await f.A.dispatch(id), { state: 'dispatched' });
  assert.equal(receiver.state.grantCalls, 2); assert.equal(receiver.state.portCalls, 1);
});

function outcomeJourney(t: TestContext) {
  const receiver = receiverFixture(), f = fixture({ authority, dispatch: receiver.adapter }); t.after(f.close);
  const report = f.A.submit(input, 'reviewed-outcome-request').report;
  receiver.state.reportId = report.id; receiver.state.reviewed = syntheticEvidence(report.id);
  const reference = { reportId: report.id, reportFingerprint: bugReportFingerprint(reportInput) };
  const resultRevision = 'd'.repeat(40);
  const ref = (artifactId: string, sourceRevision = binding.sourceRevision) => ({ artifactId, sourceRevision, artifactSha256: 'e'.repeat(64) });
  const planned: BugOutcomeSnapshotContent = { snapshotId: 'synthetic-outcome-snapshot',
    binding: { ...reference, investigation: syntheticEvidence(report.id).candidate.binding.investigation },
    classification: 'confirmed_defect', scopeImpact: 'within_existing_product_scope',
    observedBehavior: ref('synthetic-defect-reproduction'), expectedBehavior: ref('synthetic-accepted-start-behavior'),
    uncertainties: [], recommendationDigest: null, ownerDecision: { status: 'pending' },
    fix: { acceptedBinding: binding, acceptanceWitness: ref('synthetic-bounded-acceptance'),
      resultRevision: null, changeWitness: null, requiredCheckIds: ['synthetic-start-defect-check'], checks: [] } };
  const verified: BugOutcomeSnapshotContent = { ...planned, fix: { ...planned.fix!, resultRevision,
    changeWitness: ref('synthetic-start-change', resultRevision), checks: [{ checkId: 'synthetic-start-defect-check',
      result: 'passed', testedRevision: resultRevision, witness: ref('synthetic-start-check-result', resultRevision) }] } };
  const state = { snapshot: null as BugOutcomeSnapshot | null, current: true, provenance: true,
    defectCoverage: true, projectionAllowed: true, reads: 0, currentChecks: 0, projectionChecks: 0 };
  const source: BugOutcomeSource = {
    read(context, requested) { state.reads++; f.serviceFor(context).get(requested.reportId);
      assert.deepEqual(requested, reference); return state.snapshot; },
    assertCurrent(context, snapshot) { state.currentChecks++; f.serviceFor(context).get(snapshot.binding.reportId);
      assert.ok(state.current, 'synthetic outcome authority revoked');
      assert.ok(state.provenance, 'synthetic retained change/check provenance unproved');
      assert.ok(state.defectCoverage, 'synthetic required check must cover the accepted defect');
      assert.deepEqual(snapshot, state.snapshot); assert.deepEqual(snapshot.binding, planned.binding); },
  };
  const service = createBugIntakeService({ ...f.deps, outcomeSource: source }, f.contexts.A);
  const options = { reference, context: f.contexts.A, assertActive: service.assertActive, source };
  const projection: BugReporterProjectionAuthority = { assertCurrent(context, snapshot, summary) {
    state.projectionChecks++; f.serviceFor(context).get(summary.reportId);
    assert.ok(state.projectionAllowed, 'synthetic reporter projection revoked');
    assert.deepEqual(context, f.contexts.A); assert.deepEqual(snapshot, state.snapshot);
    assert.equal(summary.reportId, report.id);
  } };
  const retain = (content: BugOutcomeSnapshotContent) => { state.snapshot = { ...content, snapshotDigest: bugOutcomeSnapshotDigest(content) }; };
  return { receiver, f, report, reference, resultRevision, planned, verified, state, source, service, options, projection, retain };
}

test('integrated accepted receipt alone is unavailable and accepted bounded work without results stays unverified', async t => {
  const j = outcomeJourney(t); j.service.prepare(j.report.id);
  assert.deepEqual(await j.service.dispatch(j.report.id), { state: 'dispatched' });
  assert.equal(j.service.get(j.report.id).dispatchReceiptId, 'synthetic-reviewed-receipt');
  assert.deepEqual(j.receiver.received, [syntheticEvidence(j.report.id).candidate.payload]);
  assert.deepEqual(j.service.outcome(j.report.id), { status: 'unavailable', reason: 'outcome_missing' });
  assert.deepEqual(createBugReporterOutcome({ ...j.options, projection: j.projection }), {
    schema: 'form.bug-reporter-outcome/v1', reportId: j.report.id, status: 'unavailable',
    verificationScope: 'cited_checks_only', requiredChecks: 0, passedChecks: 0,
  });
  j.retain(j.planned);
  const view = j.service.outcome(j.report.id);
  if (view.status === 'unavailable') assert.fail('trusted accepted work should remain visible');
  assert.equal(view.status, 'fix_unverified');
  assert.equal(view.snapshot.fix?.resultRevision, null); assert.equal(view.snapshot.fix?.changeWitness, null);
  assert.deepEqual(createBugReporterOutcome({ ...j.options, projection: j.projection }), {
    schema: 'form.bug-reporter-outcome/v1', reportId: j.report.id, status: 'fix_unverified',
    verificationScope: 'cited_checks_only', requiredChecks: 1, passedChecks: 0,
  });
  assert.equal(j.receiver.state.portCalls, 1); assert.equal(j.service.get(j.report.id).state, 'dispatched');
});

test('integrated cited change and defect check yield only the current authorized six-field reporter outcome', async t => {
  const j = outcomeJourney(t); j.service.prepare(j.report.id); await j.service.dispatch(j.report.id);
  j.retain(j.verified);
  const before = j.f.db.prepare('SELECT * FROM bug_intake_reports').all();
  const view = j.service.outcome(j.report.id);
  if (view.status === 'unavailable') assert.fail('current cited synthetic result expected');
  assert.equal(view.status, 'fix_verified'); assert.deepEqual(createBugOutcomeView(j.options), view);
  assert.equal(view.authorityEffect, 'none'); assert.equal(view.executionAuthorized, false);
  assert.equal(view.snapshot.fix?.resultRevision, j.resultRevision);
  assert.equal(view.snapshot.fix?.changeWitness?.sourceRevision, j.resultRevision);
  assert.equal(view.snapshot.fix?.checks[0]?.testedRevision, j.resultRevision);
  assert.equal(view.snapshot.fix?.checks[0]?.witness.sourceRevision, j.resultRevision);
  const summary = createBugReporterOutcome({ ...j.options, projection: j.projection });
  assert.deepEqual(summary, { schema: 'form.bug-reporter-outcome/v1', reportId: j.report.id, status: 'fix_verified',
    verificationScope: 'cited_checks_only', requiredChecks: 1, passedChecks: 1 });
  assert.equal(Object.keys(summary).length, 6); assert.ok(Object.isFrozen(summary)); assert.equal(j.state.projectionChecks, 1);
  for (const privateValue of [j.reference.reportFingerprint, j.state.snapshot!.snapshotDigest, binding.sourceRevision,
    j.resultRevision, binding.acceptedScopeId, binding.authorityId, 'synthetic-outcome-snapshot', 'synthetic-start-change',
    'synthetic-start-defect-check', 'synthetic-start-check-result', 'synthetic-reviewed-receipt', input.title, input.description,
    j.f.contexts.A.accountId, j.f.contexts.A.authUserId, j.f.contexts.A.sessionId])
    assert.equal(JSON.stringify(summary).includes(privateValue), false);
  assert.deepEqual(j.f.db.prepare('SELECT * FROM bug_intake_reports').all(), before); assert.equal(j.receiver.state.portCalls, 1);
});

test('integrated outcome revocation/access/projection denial and unknown dispatch cannot disclose or auto-resend', async t => {
  const j = outcomeJourney(t); j.service.prepare(j.report.id); await j.service.dispatch(j.report.id); j.retain(j.verified);
  for (const field of ['current', 'provenance', 'defectCoverage'] as const) {
    j.state[field] = false;
    assert.deepEqual(j.service.outcome(j.report.id), { status: 'unavailable', reason: 'outcome_unqualified' });
    assert.equal(createBugReporterOutcome({ ...j.options, projection: j.projection }).status, 'unavailable');
    j.state[field] = true;
  }
  assert.equal(createBugReporterOutcome(j.options).status, 'unavailable');
  j.state.projectionAllowed = false;
  const denied = createBugReporterOutcome({ ...j.options, projection: j.projection });
  assert.equal(denied.status, 'unavailable'); assert.equal(denied.requiredChecks, 0); assert.equal(denied.passedChecks, 0);
  const reads = j.state.reads;
  const foreign = createBugIntakeService({ ...j.f.deps, outcomeSource: j.source }, j.f.contexts.B);
  assert.throws(() => foreign.outcome(j.report.id), errorCode('bug_report_not_found')); assert.equal(j.state.reads, reads);
  j.state.projectionAllowed = true;
  assert.throws(() => createBugReporterOutcome({ ...j.options, projection: { assertCurrent() {
    j.f.disabled.set(j.f.contexts.A.accountId, 1);
  } } }), errorCode('account_disabled'));
  assert.equal(j.receiver.state.portCalls, 1);
  const unknown = outcomeJourney(t); unknown.receiver.state.outcome = () => { throw new Error('synthetic routing response lost'); };
  unknown.service.prepare(unknown.report.id);
  assert.deepEqual(await unknown.service.dispatch(unknown.report.id), { state: 'dispatch_unknown' });
  assert.deepEqual(unknown.service.outcome(unknown.report.id), { status: 'unavailable', reason: 'outcome_missing' });
  assert.equal(createBugReporterOutcome({ ...unknown.options, projection: unknown.projection }).status, 'unavailable');
  await assert.rejects(unknown.service.dispatch(unknown.report.id), errorCode('bug_dispatch_reconciliation_required'));
  assert.throws(() => unknown.service.prepare(unknown.report.id), errorCode('bug_dispatch_reconciliation_required'));
  assert.equal(unknown.receiver.state.portCalls, 1); assert.equal(unknown.service.get(unknown.report.id).dispatchReceiptId, undefined);
});
