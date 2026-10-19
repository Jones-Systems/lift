import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { bugReportFingerprint, bugEvidenceCandidateDigest, createBugTechnicalEvidence, assertBugTechnicalEvidenceCurrent,
  parseBugEvidenceCandidate, parseReviewedBugEvidence, type BugEvidenceCandidate, type ReviewedBugEvidence,
  type BugEvidenceSource, type BugEvidenceAccess } from '../../src/bug-intake/index.js';
import { fixture, input, errorCode } from './fixture.js';

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const fingerprint = (report: { title: string; description: string; diagnosticConsent: boolean }) =>
  bugReportFingerprint({ title: report.title, description: report.description, diagnosticConsent: report.diagnosticConsent });
function sign(candidate: BugEvidenceCandidate): ReviewedBugEvidence {
  return { candidate, review: { reviewId: 'synthetic-review-1', reviewerAuthorityId: 'synthetic-reviewer',
    candidateDigest: bugEvidenceCandidateDigest(candidate), attestation: 'reviewed_source_and_synthetic_facts_only' } };
}
function setup(t: TestContext) {
  let dispatchCalls = 0;
  const f = fixture({ dispatch: { async submit() { dispatchCalls++; return { status: 'unknown' }; } } }); t.after(f.close);
  const original = f.A.submit({ ...input, description: 'Private synthetic member detail; never include this in the extract.' }, 'request-key-A').report;
  const candidate: BugEvidenceCandidate = {
    binding: { reportId: original.id, reportFingerprint: fingerprint(original), investigation: {
      repository: 'Jones-Systems/Form', sourceRevision: 'a'.repeat(40), investigationScopeId: 'investigation-only', authorityId: 'source-review-authority',
    } },
    recipientPolicy: { recipientId: 'synthetic-recipient', policyRevision: 'synthetic-policy-v1', purpose: 'technical_bug_investigation',
      retentionPolicyId: 'synthetic-retention', exportPolicyId: 'synthetic-export', purgePolicyId: 'synthetic-purge' },
    payload: { schema: 'form.bug-technical-extract/v1', authorityEffect: 'none', executionAuthorized: false,
      facts: [{ id: 'fact-1', kind: 'synthetic_reproduction', statement: 'A synthetic Start tap produced no navigation transition.',
        evidence: { artifactId: 'synthetic-reproduction', artifactSha256: 'b'.repeat(64), sourceRevision: 'a'.repeat(40) } }] },
  };
  const approved = sign(candidate);
  const state = { reviewCurrent: true, policyCurrent: true, reads: 0, checks: 0 };
  const source: BugEvidenceSource = {
    assertReportAccess(context, id) { f.serviceFor(context).get(id); },
    reviewedFor() { state.reads++; return clone(approved); },
    assertCurrent(context, evidence) {
      state.checks++;
      assert.equal(state.reviewCurrent, true); assert.equal(state.policyCurrent, true);
      const report = f.serviceFor(context).get(evidence.candidate.binding.reportId);
      assert.equal(evidence.candidate.binding.reportFingerprint, fingerprint(report));
      assert.deepEqual(evidence, approved);
    },
  };
  const access: BugEvidenceAccess = { context: f.contexts.A, assertActive: f.A.assertActive, source };
  return { f, original, candidate, approved, state, source, access, dispatchCalls: () => dispatchCalls,
    prepare: (override: BugEvidenceSource = source) => createBugTechnicalEvidence({ ...access, source: override, reportId: original.id }) };
}

test('prepared technical facts are immutable and exclude original report and local qualification metadata from the payload', t => {
  const f = setup(t), before = f.f.db.prepare('SELECT * FROM bug_intake_reports').all();
  const result = f.prepare(); assert.equal(result.status, 'prepared');
  if (result.status !== 'prepared') assert.fail('trusted review required');
  assert.deepEqual(result.evidence, f.approved);
  assert.deepEqual(Object.keys(result.evidence.candidate.payload).sort(), ['authorityEffect', 'executionAuthorized', 'facts', 'schema']);
  const payload = JSON.stringify(result.evidence.candidate.payload);
  for (const excluded of [f.original.description, f.original.title, f.original.id, f.candidate.binding.reportFingerprint,
    'synthetic-recipient', 'synthetic-reviewer', 'synthetic-retention', 'account-A', 'session-A', 'diagnostics']) assert.equal(payload.includes(excluded), false);
  assert.throws(() => { (result.evidence.candidate.payload as { executionAuthorized: boolean }).executionAuthorized = true; }, TypeError);
  assert.deepEqual(f.f.db.prepare('SELECT * FROM bug_intake_reports').all(), before);
  assert.equal(f.dispatchCalls(), 0); assert.equal(f.state.reads, 1); assert.equal(f.state.checks, 1);
});

test('structural parsing and a matching digest never prove trusted review or text privacy', t => {
  const f = setup(t), forged = sign({ ...f.candidate, payload: { ...f.candidate.payload,
    facts: [{ ...f.candidate.payload.facts[0]!, statement: f.original.description }] } });
  assert.deepEqual(parseReviewedBugEvidence(forged), forged);
  const result = f.prepare({ ...f.source, reviewedFor: () => forged });
  assert.deepEqual(result, { status: 'unavailable', reason: 'review_unproved' });
  assert.equal(JSON.stringify(result).includes(f.original.description), false);
  assert.equal(f.dispatchCalls(), 0);
});

test('absent source, absent review, absent policy and provider failures remain unavailable', t => {
  const f = setup(t);
  assert.deepEqual(createBugTechnicalEvidence({ context: f.f.contexts.A, assertActive: f.f.A.assertActive, reportId: f.original.id }),
    { status: 'unavailable', reason: 'source_unavailable' });
  assert.deepEqual(f.prepare({ ...f.source, reviewedFor: () => null }), { status: 'unavailable', reason: 'review_missing' });
  const noPolicy = { ...f.approved, candidate: { ...f.candidate, recipientPolicy: undefined } } as unknown as ReviewedBugEvidence;
  assert.deepEqual(f.prepare({ ...f.source, reviewedFor: () => noPolicy }), { status: 'unavailable', reason: 'recipient_policy_missing' });
  const result = f.prepare({ ...f.source, reviewedFor() { throw new Error('private provider diagnostic'); } });
  assert.deepEqual(result, { status: 'unavailable', reason: 'source_unavailable' });
  assert.equal(JSON.stringify(result).includes('private provider diagnostic'), false);
});

test('wrong-account access is denied before reading reviewed evidence', t => {
  const f = setup(t);
  assert.throws(() => createBugTechnicalEvidence({ context: f.f.contexts.B, assertActive: f.f.B.assertActive, source: f.source, reportId: f.original.id }),
    errorCode('bug_evidence_access_denied'));
  assert.equal(f.state.reads, 0); assert.equal(f.state.checks, 0);
});

test('report identity, canonical fingerprint, source and policy substitution cannot qualify', t => {
  const f = setup(t);
  const otherId = f.f.B.submit(input, 'request-key-B').report.id;
  assert.deepEqual(f.prepare({ ...f.source, reviewedFor: () => sign({ ...f.candidate, binding: { ...f.candidate.binding, reportId: otherId } }) }),
    { status: 'unavailable', reason: 'binding_mismatch' });
  for (const candidate of [
    { ...f.candidate, binding: { ...f.candidate.binding, reportFingerprint: 'c'.repeat(64) } },
    { ...f.candidate, binding: { ...f.candidate.binding, investigation: { ...f.candidate.binding.investigation, investigationScopeId: 'other-scope' } } },
    { ...f.candidate, recipientPolicy: { ...f.candidate.recipientPolicy, recipientId: 'other-recipient' } },
  ]) assert.deepEqual(f.prepare({ ...f.source, reviewedFor: () => sign(candidate) }), { status: 'unavailable', reason: 'review_unproved' });
});

test('changed facts or review identity cannot reuse an approved witness', t => {
  const f = setup(t);
  const changed = { ...f.approved, candidate: { ...f.candidate, payload: { ...f.candidate.payload,
    facts: [{ ...f.candidate.payload.facts[0]!, statement: 'Changed after review' }] } } };
  assert.deepEqual(f.prepare({ ...f.source, reviewedFor: () => changed }), { status: 'unavailable', reason: 'evidence_invalid' });
  assert.deepEqual(f.prepare({ ...f.source, reviewedFor: () => ({ ...f.approved, review: { ...f.approved.review, reviewId: 'forged-review' } }) }),
    { status: 'unavailable', reason: 'review_unproved' });
});

test('strict fields, UTF-16 bounds, evidence revisions, distinct ids and total byte bounds are enforced', t => {
  const f = setup(t), fact = f.candidate.payload.facts[0]!;
  const withFacts = (facts: unknown[]) => ({ ...f.candidate, payload: { ...f.candidate.payload, facts } });
  for (const raw of [
    { ...f.candidate, originalReport: f.original },
    { ...f.candidate, payload: { ...f.candidate.payload, diagnostics: { screen: 'workout' } } },
    { ...f.candidate, payload: { ...f.candidate.payload, executionAuthorized: true } },
    withFacts([{ ...fact, statement: '😀'.repeat(500) + 'x' }]),
    withFacts([{ ...fact, evidence: { ...fact.evidence, artifactId: 'https://private.invalid/log' } }]),
    withFacts([{ ...fact, evidence: { ...fact.evidence, sourceRevision: 'c'.repeat(40) } }]),
    withFacts([fact, fact]), withFacts(Array.from({ length: 9 }, (_, index) => ({ ...fact, id: `fact-${index}` }))),
    withFacts(Array.from({ length: 8 }, (_, index) => ({ ...fact, id: `fact-${index}`, statement: '界'.repeat(1000) }))),
  ]) assert.throws(() => parseBugEvidenceCandidate(raw), errorCode('bug_evidence_evidence_invalid'));
});

test('suppression during access, review retrieval or currentness prevents any evidence disclosure', t => {
  for (const stage of ['access', 'read', 'current'] as const) {
    const f = setup(t), disable = () => f.f.disabled.set(f.f.contexts.A.accountId, 1);
    const source: BugEvidenceSource = {
      assertReportAccess(context, id) { f.source.assertReportAccess(context, id); if (stage === 'access') disable(); },
      reviewedFor(context, id) { const result = f.source.reviewedFor(context, id); if (stage === 'read') disable(); return result; },
      assertCurrent(context, evidence) { f.source.assertCurrent(context, evidence); if (stage === 'current') disable(); },
    };
    assert.throws(() => f.prepare(source), errorCode('account_disabled'));
    assert.equal(f.dispatchCalls(), 0);
  }
});

test('currentness must be rechecked after a separate grant read and never refreshes a stale review', t => {
  const f = setup(t), result = f.prepare();
  if (result.status !== 'prepared') assert.fail('prepared evidence required');
  assert.deepEqual(assertBugTechnicalEvidenceCurrent(f.access, result.evidence), result.evidence);
  f.state.policyCurrent = false;
  assert.throws(() => assertBugTechnicalEvidenceCurrent(f.access, result.evidence), errorCode('bug_evidence_review_unproved'));
  f.state.policyCurrent = true; f.state.reviewCurrent = false;
  assert.throws(() => assertBugTechnicalEvidenceCurrent(f.access, result.evidence), errorCode('bug_evidence_review_unproved'));
  assert.equal(f.state.reads, 1); assert.equal(f.dispatchCalls(), 0);
});
