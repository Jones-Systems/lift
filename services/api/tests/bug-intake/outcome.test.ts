import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createHash } from 'node:crypto';
import { bugReportFingerprint, bugTriageSnapshotFingerprint, bugEvidenceCandidateDigest, createBugTechnicalEvidence,
  createBugIntakeService, bugOutcomeSnapshotDigest, createBugReporterOutcome, parseBugOutcomeSnapshot,
  type BugOutcomeSnapshotContent, type BugOutcomeSnapshot, type BugOutcomeSource, type BugOutcomeReadOptions,
  type BugTriageSource, type BugEvidenceCandidate, type ReviewedBugEvidence, type BugEvidenceSource } from '../../src/bug-intake/index.js';
import { authority, binding, fixture, input, errorCode } from './fixture.js';

const sourceRevision = 'a'.repeat(40), resultRevision = 'd'.repeat(40);
const ref = (artifactId: string, revision = sourceRevision) => ({ artifactId, artifactSha256: 'b'.repeat(64), sourceRevision: revision });
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const signed = (content: BugOutcomeSnapshotContent): BugOutcomeSnapshot => ({ ...content, snapshotDigest: bugOutcomeSnapshotDigest(content) });
function setup(t: TestContext) {
  let dispatchCalls = 0;
  const f = fixture({ authority, dispatch: { async submit() { dispatchCalls++; return { status: 'unknown' }; } } }); t.after(f.close);
  const original = f.A.submit(input, 'request-key-A').report;
  const reference = { reportId: original.id, reportFingerprint: bugReportFingerprint({ ...input, diagnosticConsent: false }) };
  const investigation = { repository: 'Jones-Systems/Form' as const, sourceRevision, investigationScopeId: 'investigation-only', authorityId: 'synthetic-investigator' };
  const recommendation = { action: 'change' as const, summary: 'Correct the missing transition.', proposedChange: 'Restore the accepted Start transition.',
    buildNeeds: ['Connect the accepted navigation action.'], reasonsFor: ['Restores expected behavior.'], reasonsAgainst: ['Requires navigation regression coverage.'],
    scopeImpact: 'within_existing_product_scope' as const, evidenceIds: ['evidence-1'] };
  const recommendationDigest = createHash('sha256').update(JSON.stringify(recommendation)).digest('hex');
  const triage: BugTriageSource = {
    bindingFor: () => investigation,
    snapshotFor(_context, request) {
      const content = { reportId: request.reportId, reportFingerprint: request.reportFingerprint, binding: request.binding,
        investigation: { classification: 'confirmed_defect' as const, observedBehavior: 'Synthetic Start tap did not transition.',
          expectedBehavior: 'Start opens the workout.', evidence: [{ id: 'evidence-1', kind: 'synthetic_reproduction' as const,
            summary: 'Synthetic navigation reproduction.', artifactId: 'synthetic-reproduction', artifactSha256: 'b'.repeat(64), sourceRevision }], openQuestions: [] },
        recommendation };
      return { snapshotId: 'triage-snapshot', retainedBy: 'synthetic-retainer', snapshotFingerprint: bugTriageSnapshotFingerprint(content), content };
    },
    assertCurrent(context, request) { f.serviceFor(context).get(request.reportId); assert.equal(request.reportFingerprint, reference.reportFingerprint); },
  };
  const content: BugOutcomeSnapshotContent = {
    snapshotId: 'outcome-snapshot', binding: { ...reference, investigation }, classification: 'confirmed_defect', scopeImpact: 'within_existing_product_scope',
    observedBehavior: ref('observed'), expectedBehavior: ref('expected'), uncertainties: [], recommendationDigest,
    ownerDecision: { status: 'recorded', decisionAuthority: 'product_owner', choice: 'approve_bounded_change', recommendationDigest, witness: ref('owner-decision') },
    fix: { acceptedBinding: binding, acceptanceWitness: ref('accepted-scope'), resultRevision, changeWitness: ref('change', resultRevision),
      requiredCheckIds: ['start-regression'], checks: [{ checkId: 'start-regression', result: 'passed', testedRevision: resultRevision, witness: ref('check', resultRevision) }] },
  };
  const state = { snapshot: signed(content) as BugOutcomeSnapshot | null, reads: 0, checks: 0, coverageQualified: true, provenanceQualified: true };
  const source: BugOutcomeSource = {
    read(context, request) { state.reads++; f.serviceFor(context).get(request.reportId); assert.deepEqual(request, reference); return clone(state.snapshot); },
    assertCurrent(context, snapshot) {
      state.checks++; f.serviceFor(context).get(snapshot.binding.reportId);
      assert.equal(state.coverageQualified, true, 'required checks must cover the accepted bounded defect and fix');
      assert.equal(state.provenanceQualified, true, 'artifact hashes alone are not retained provenance');
      assert.equal(snapshot.binding.reportFingerprint, reference.reportFingerprint); assert.deepEqual(snapshot, state.snapshot);
    },
  };
  const service = createBugIntakeService({ ...f.deps, triage, outcomeSource: source }, f.contexts.A);
  const options: BugOutcomeReadOptions = { context: f.contexts.A, reference, assertActive: service.assertActive, source };
  return { f, original, reference, investigation, content, state, source, service, options, dispatchCalls: () => dispatchCalls };
}

test('actual submit, triage, reviewed technical producer and outcome readback stay read-only and independently qualified', t => {
  const f = setup(t), before = f.f.db.prepare('SELECT * FROM bug_intake_reports').all();
  const triage = f.service.triage(f.original.id);
  if (triage.status !== 'owner_decision_required') assert.fail('actual triage packet required');
  assert.equal(triage.ownerDecision.status, 'pending');
  const candidate: BugEvidenceCandidate = { binding: { ...f.reference, investigation: triage.binding },
    recipientPolicy: { recipientId: 'synthetic-recipient', policyRevision: 'synthetic-v1', purpose: 'technical_bug_investigation',
      retentionPolicyId: 'synthetic-retention', exportPolicyId: 'synthetic-export', purgePolicyId: 'synthetic-purge' },
    payload: { schema: 'form.bug-technical-extract/v1', authorityEffect: 'none', executionAuthorized: false,
      facts: triage.snapshot.content.investigation.evidence.map(evidence => ({ id: evidence.id, kind: 'synthetic_reproduction' as const,
        statement: evidence.summary, evidence: { artifactId: evidence.artifactId, artifactSha256: evidence.artifactSha256, sourceRevision: evidence.sourceRevision } })) } };
  const reviewed: ReviewedBugEvidence = { candidate, review: { reviewId: 'synthetic-review', reviewerAuthorityId: 'synthetic-reviewer',
    candidateDigest: bugEvidenceCandidateDigest(candidate), attestation: 'reviewed_source_and_synthetic_facts_only' } };
  const source: BugEvidenceSource = { assertReportAccess(context, id) { f.f.serviceFor(context).get(id); }, reviewedFor: () => reviewed,
    assertCurrent(context, evidence) { f.f.serviceFor(context).get(evidence.candidate.binding.reportId); assert.deepEqual(evidence, reviewed); } };
  assert.equal(createBugTechnicalEvidence({ context: f.f.contexts.A, reportId: f.original.id, assertActive: f.service.assertActive, source }).status, 'prepared');
  const outcome = f.service.outcome(f.original.id);
  if (outcome.status === 'unavailable') assert.fail('qualified readback required');
  assert.equal(outcome.status, 'fix_verified');
  assert.equal(outcome.executionAuthorized, false); assert.equal(outcome.authorityEffect, 'none');
  assert.deepEqual(outcome.snapshot.binding, candidate.binding);
  assert.deepEqual(f.f.db.prepare('SELECT * FROM bug_intake_reports').all(), before);
  assert.equal(f.service.get(f.original.id).state, 'received'); assert.equal(f.dispatchCalls(), 0);
});

test('missing outcome source and wrong-account reads never invent outcomes or inspect foreign evidence', t => {
  const f = setup(t);
  assert.deepEqual(f.f.A.outcome(f.original.id), { status: 'unavailable', reason: 'source_unavailable' });
  const other = createBugIntakeService({ ...f.f.deps, outcomeSource: f.source }, f.f.contexts.B);
  assert.throws(() => other.outcome(f.original.id), errorCode('bug_report_not_found'));
  assert.equal(f.state.reads, 0);
  f.state.snapshot = null;
  assert.deepEqual(f.service.outcome(f.original.id), { status: 'unavailable', reason: 'outcome_missing' });
});

test('reporter projection requires separate current disclosure authority and exposes only the agreed enum/count carrier', t => {
  const f = setup(t);
  const absent = createBugReporterOutcome(f.options);
  assert.equal(absent.status, 'unavailable'); assert.equal(f.state.reads, 0);
  let permissions = 0;
  const summary = createBugReporterOutcome({ ...f.options, projection: { assertCurrent(context, snapshot, proposed) {
    permissions++; assert.equal(context.accountId, f.f.contexts.A.accountId);
    assert.equal(snapshot.binding.reportId, proposed.reportId); assert.equal(proposed.reportId, f.original.id);
  } } });
  assert.deepEqual(summary, { schema: 'form.bug-reporter-outcome/v1', reportId: f.original.id, status: 'fix_verified',
    verificationScope: 'cited_checks_only', requiredChecks: 1, passedChecks: 1 });
  assert.equal(permissions, 1); assert.equal(Object.isFrozen(summary), true);
  const denied = createBugReporterOutcome({ ...f.options, projection: { assertCurrent() { throw new Error('private disclosure policy'); } } });
  assert.deepEqual(denied, absent);
  for (const privateValue of [f.reference.reportFingerprint, sourceRevision, resultRevision, f.original.title, 'accepted-scope', 'owner-decision', 'private disclosure policy'])
    assert.equal(JSON.stringify(denied).includes(privateValue), false);
});

test('an accepted fix awaiting an actual result retains acceptance without inventing verification', t => {
  const f = setup(t), fix = { ...f.content.fix!, resultRevision: null, changeWitness: null, checks: [] };
  f.state.snapshot = signed({ ...f.content, ownerDecision: { status: 'pending' }, fix });
  const view = f.service.outcome(f.original.id);
  if (view.status === 'unavailable') assert.fail('accepted fix readback required');
  assert.equal(view.status, 'fix_unverified');
  assert.deepEqual(view.snapshot.fix?.acceptedBinding, binding);
  assert.equal(view.snapshot.fix?.resultRevision, null); assert.equal(view.snapshot.fix?.changeWitness, null);
  const summary = createBugReporterOutcome({ ...f.options, projection: { assertCurrent() {} } });
  assert.equal(summary.status, 'fix_unverified'); assert.equal(summary.requiredChecks, 1); assert.equal(summary.passedChecks, 0);
  assert.equal(f.service.get(f.original.id).state, 'received'); assert.equal(f.dispatchCalls(), 0);
  for (const invalidFix of [
    { ...fix, resultRevision }, { ...fix, changeWitness: ref('change', resultRevision) },
    { ...fix, checks: f.content.fix!.checks },
  ]) assert.throws(() => signed({ ...f.content, fix: invalidFix }), errorCode('bug_outcome_unqualified'));
});

test('a verified fix requires every required check on the exact result revision with matching artifact revision', t => {
  const f = setup(t), fix = f.content.fix!;
  for (const replacement of [
    { ...fix, checks: [] },
    { ...fix, requiredCheckIds: ['start-regression', 'missing-check'] },
    ...(['failed', 'inconclusive'] as const).map(result => ({ ...fix, checks: [{ ...fix.checks[0]!, result }] })),
    { ...fix, checks: [{ ...fix.checks[0]!, testedRevision: sourceRevision }] },
    { ...fix, checks: [{ ...fix.checks[0]!, witness: ref('wrong-check-revision') }] },
  ]) {
    f.state.snapshot = signed({ ...f.content, fix: replacement });
    assert.equal(f.service.outcome(f.original.id).status, 'fix_unverified');
  }
});

test('scope expansion, rejected owner choices, uncertainty and mismatched accepted/change bindings cannot qualify a fix', t => {
  const f = setup(t), fix = f.content.fix!, decision = f.content.ownerDecision;
  if (decision.status !== 'recorded') assert.fail('recorded fixture decision required');
  for (const replacement of [
    { ...f.content, scopeImpact: 'scope_expansion' as const, ownerDecision: { status: 'pending' as const } },
    { ...f.content, classification: 'improvement_request' as const, ownerDecision: { status: 'pending' as const } },
    { ...f.content, ownerDecision: { ...decision, choice: 'defer' as const } },
    { ...f.content, uncertainties: [ref('unresolved-question')] },
    { ...f.content, fix: { ...fix, acceptedBinding: { ...binding, acceptedScopeId: f.investigation.investigationScopeId } } },
    { ...f.content, fix: { ...fix, acceptedBinding: { ...binding, sourceRevision: resultRevision } } },
    { ...f.content, fix: { ...fix, changeWitness: ref('wrong-change-revision') } },
  ]) { f.state.snapshot = signed(replacement); assert.equal(f.service.outcome(f.original.id).status, 'fix_unverified'); }
});

test('expected behavior, pending decisions, inconclusive investigation and recorded deferral remain distinct', t => {
  const f = setup(t), decision = f.content.ownerDecision;
  if (decision.status !== 'recorded') assert.fail('recorded fixture decision required');
  for (const [content, expected] of [
    [{ ...f.content, fix: null, ownerDecision: { status: 'pending' as const } }, 'owner_decision_pending'],
    [{ ...f.content, fix: null, classification: 'expected_behavior' as const, scopeImpact: 'no_change' as const,
      ownerDecision: { ...decision, choice: 'retain_current_behavior' as const } }, 'expected_behavior'],
    [{ ...f.content, fix: null, classification: 'inconclusive' as const, uncertainties: [ref('open-question')] }, 'investigation_pending'],
    [{ ...f.content, fix: null, ownerDecision: { ...decision, choice: 'defer' as const } }, 'decision_recorded'],
  ] as const) { f.state.snapshot = signed(content); assert.equal(f.service.outcome(f.original.id).status, expected); }
});

test('green artifact-shaped checks are insufficient without actual retained coverage and authority provenance', t => {
  const f = setup(t);
  assert.equal(parseBugOutcomeSnapshot(f.state.snapshot).fix?.checks[0]?.result, 'passed');
  f.state.coverageQualified = false;
  assert.deepEqual(f.service.outcome(f.original.id), { status: 'unavailable', reason: 'outcome_unqualified' });
  f.state.coverageQualified = true; f.state.provenanceQualified = false;
  assert.deepEqual(f.service.outcome(f.original.id), { status: 'unavailable', reason: 'outcome_unqualified' });
  assert.equal(f.dispatchCalls(), 0);
});

test('wrong report fingerprints, changed digests, private fields and conflicting check identities are rejected', t => {
  const f = setup(t), original = f.state.snapshot!;
  f.state.snapshot = signed({ ...f.content, binding: { ...f.content.binding, reportFingerprint: 'f'.repeat(64) } });
  assert.deepEqual(f.service.outcome(f.original.id), { status: 'unavailable', reason: 'outcome_unqualified' });
  f.state.snapshot = { ...original, snapshotDigest: 'f'.repeat(64) };
  assert.deepEqual(f.service.outcome(f.original.id), { status: 'unavailable', reason: 'outcome_unqualified' });
  for (const raw of [
    { ...original, originalReport: f.original },
    { ...original, snapshotId: 'x'.repeat(129) },
    { ...original, uncertainties: Array.from({ length: 9 }, () => ref('uncertainty')) },
    { ...original, fix: { ...original.fix, requiredCheckIds: Array.from({ length: 17 }, (_, index) => `check-${index}`) } },
    { ...original, ownerDecision: { ...original.ownerDecision, decisionAuthority: 'reporter' } },
    { ...original, fix: { ...original.fix, requiredCheckIds: [] } },
    { ...original, fix: { ...original.fix, checks: [original.fix!.checks[0], original.fix!.checks[0]] } },
    { ...original, observedBehavior: { ...original.observedBehavior, artifactId: 'https://private.invalid/log' } },
  ]) assert.throws(() => parseBugOutcomeSnapshot(raw), errorCode('bug_outcome_unqualified'));
});

test('suppression around source and projection callbacks prevents private or safe readback disclosure', t => {
  for (const stage of ['read', 'current', 'projection'] as const) {
    const f = setup(t), disable = () => f.f.disabled.set(f.f.contexts.A.accountId, 1);
    const source: BugOutcomeSource = {
      read(context, reference) { const value = f.source.read(context, reference); if (stage === 'read') disable(); return value; },
      assertCurrent(context, snapshot) { f.source.assertCurrent(context, snapshot); if (stage === 'current') disable(); },
    };
    assert.throws(() => createBugReporterOutcome({ ...f.options, source, projection: { assertCurrent() { if (stage === 'projection') disable(); } } }),
      errorCode('account_disabled'));
    assert.equal(f.dispatchCalls(), 0);
  }
});
