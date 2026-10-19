const assert = require('node:assert/strict');
const test = require('node:test');
const { load, ApiError, fixture, input, receipt, report, deferred } = require('./fixture.cjs');
const { createBugIntakeFlow } = load('features/bug-intake/flow.ts');
const { reportStatusCopy } = load('features/bug-intake/model.ts');
const errorCode = code => error => error instanceof ApiError && error.code === code;
const diagnostics = { platform: 'ios', appVersion: '1.2.3', screen: 'workout' };

function consumer(t, respond) {
  const f = fixture(respond);
  let keys = 0;
  const flow = createBugIntakeFlow({ resources: { api: f.api }, sessionGeneration: 'synthetic-generation-A',
    isCurrentSession: () => f.state.current }, () => `reviewed-key-${++keys}`);
  t.after(() => { flow.dispose(); f.close(); });
  return { ...f, flow, keys: () => keys };
}

test('review shows the exact canonical private payload without issuing a request or key', async t => {
  const f = consumer(t);
  assert.equal(f.flow.getState().canReview, false);
  assert.equal(f.flow.getState().canSubmitReviewed, false);
  f.flow.edit({ title: `  ${input().title}  `, description: `  ${input().description}  ` });
  await assert.rejects(f.flow.submitReviewed(1), errorCode('bug_review_required'));
  assert.equal(f.flow.getState().canReview, true);
  const review = f.flow.review();
  assert.deepEqual(review.payload, { ...input(), diagnosticConsent: false });
  assert.match(review.privacy, /health records/);
  assert.match(review.diagnosticsNotice, /Optional technical details/);
  assert.equal(Object.isFrozen(review), true); assert.equal(Object.isFrozen(review.payload), true);
  assert.equal(f.calls.length, 0); assert.equal(f.keys(), 0);
  assert.equal(f.flow.getState().canSubmitReviewed, true);
  await f.flow.submitReviewed(review.reviewRevision);
  assert.equal(f.keys(), 1); assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0][0], '/v1/bug-reports'); assert.equal(f.calls[0][1], 'POST');
  assert.deepEqual(f.calls[0][2], review.payload);
  assert.equal(f.flow.getState().phase, 'submitted'); assert.equal(f.flow.getState().review, null);
  assert.equal(reportStatusCopy[f.flow.getState().submitted.state], 'Report received.');
  await assert.rejects(f.flow.submitReviewed(review.reviewRevision), errorCode('bug_review_required'));
  assert.equal(f.calls.length, 1);
});

test('text and diagnostic consent edits invalidate review and only the latest revision may send', async t => {
  const f = consumer(t);
  f.flow.edit(input()); const first = f.flow.review();
  f.flow.edit({ description: 'Changed synthetic steps' });
  assert.equal(f.flow.getState().review, null);
  await assert.rejects(f.flow.submitReviewed(first.reviewRevision), errorCode('bug_review_required'));
  const second = f.flow.review();
  f.flow.setDiagnostics(true, diagnostics);
  await assert.rejects(f.flow.submitReviewed(second.reviewRevision), errorCode('bug_review_required'));
  const third = f.flow.review();
  assert.deepEqual(third.payload.diagnostics, diagnostics);
  assert.equal(Object.isFrozen(third.payload.diagnostics), true);
  f.flow.setDiagnostics(false, diagnostics);
  await assert.rejects(f.flow.submitReviewed(third.reviewRevision), errorCode('bug_review_required'));
  const current = f.flow.review();
  assert.equal(current.payload.diagnostics, undefined); assert.equal(current.payload.diagnosticConsent, false);
  assert.ok(current.reviewRevision > third.reviewRevision);
  assert.equal(f.calls.length, 0); assert.equal(f.keys(), 0);
  await f.flow.submitReviewed(current.reviewRevision);
  assert.deepEqual(f.calls[0][2], current.payload); assert.equal(f.keys(), 1);
});

test('unknown submission retries the same reviewed command explicitly without creating another review or key', async t => {
  let calls = 0;
  const f = consumer(t, async (_path, _method, body) => {
    if (++calls === 1) throw new ApiError(0, 'network_unavailable', 'Synthetic lost response', true);
    return receipt(body);
  });
  f.flow.edit(input()); f.flow.setDiagnostics(true, diagnostics);
  const review = f.flow.review(); await f.flow.submitReviewed(review.reviewRevision);
  assert.equal(f.flow.getState().phase, 'submission_unknown'); assert.equal(f.flow.getState().review, null);
  assert.equal(f.flow.getState().canRetrySubmission, true);
  assert.throws(() => f.flow.edit({ title: 'Changed' }), errorCode('bug_submission_pending'));
  assert.throws(() => f.flow.review(), errorCode('bug_submission_pending'));
  assert.throws(() => f.flow.beginNew(), errorCode('bug_submission_pending'));
  await assert.rejects(f.flow.submitReviewed(review.reviewRevision), errorCode('bug_review_required'));
  assert.equal(f.calls.length, 1); assert.equal(f.keys(), 1);
  await f.flow.retrySubmission();
  assert.equal(f.calls.length, 2); assert.equal(f.keys(), 1);
  assert.deepEqual(f.calls[1], f.calls[0]); assert.deepEqual(f.calls[1][2], review.payload);
  assert.equal(f.flow.getState().phase, 'submitted');
});

test('routing uncertainty is display-only and report reads remain actual session resource operations', async t => {
  const saved = report(input(), { state: 'dispatch_unknown' });
  const f = consumer(t, async (path, method, body) => {
    if (method === 'POST') return receipt(body, { report: saved });
    return path === '/v1/bug-reports' ? { reports: [saved] } : { report: saved };
  });
  f.flow.edit(input()); await f.flow.submitReviewed(f.flow.review().reviewRevision);
  await f.flow.refresh(); await f.flow.loadReport(saved.id);
  assert.equal(f.flow.getState().phase, 'submitted'); assert.equal(f.flow.getState().canRetrySubmission, false);
  assert.deepEqual(f.flow.getState().selected, saved); assert.deepEqual(f.flow.getState().reports, [saved]);
  assert.equal(reportStatusCopy[saved.state], 'Report received. The routing result is unconfirmed.');
  await assert.rejects(f.flow.retrySubmission(), errorCode('bug_retry_unavailable'));
  assert.deepEqual(f.calls.map(call => call[1]), ['POST', 'GET', 'GET']);
});

test('auth invalidation clears private review synchronously and rejects retained confirmation callbacks', async t => {
  const f = consumer(t), seen = [];
  const subscription = f.flow.subscribe(state => seen.push(state));
  f.flow.edit(input()); f.flow.setDiagnostics(true, diagnostics);
  const review = f.flow.review();
  f.changeAuth();
  const state = f.flow.getState();
  assert.equal(state.phase, 'unavailable'); assert.equal(state.review, null);
  assert.deepEqual(state.draft, { title: '', description: '', diagnosticConsent: false });
  assert.equal(seen.at(-1).review, null); assert.equal(seen.at(-1).phase, 'unavailable');
  await assert.rejects(f.flow.submitReviewed(review.reviewRevision), errorCode('session_changed'));
  assert.throws(() => f.flow.review(), errorCode('session_changed'));
  assert.equal(f.calls.length, 0); assert.equal(f.keys(), 0);
  subscription.remove();
});

test('late acknowledgement after auth replacement cannot repopulate private flow state', async t => {
  const waiting = deferred();
  const f = consumer(t, () => waiting.promise);
  f.flow.edit(input()); const review = f.flow.review();
  const submission = f.flow.submitReviewed(review.reviewRevision);
  try {
    assert.equal(f.flow.getState().phase, 'submitting');
    f.changeAuth();
    assert.equal(f.flow.getState().phase, 'unavailable');
  } finally { waiting.resolve(receipt(review.payload)); await submission; }
  const state = f.flow.getState();
  assert.equal(state.submitted, null); assert.equal(state.selected, null); assert.deepEqual(state.reports, []);
  assert.equal(state.review, null); assert.equal(state.originalEffectUnknown, true);
  await assert.rejects(f.flow.retrySubmission(), errorCode('session_changed'));
  assert.equal(f.calls.length, 1); assert.equal(f.keys(), 1);
});

test('root session guard and disposal both invalidate reviewed content without transport auth events', async t => {
  for (const invalidate of ['root', 'dispose']) {
    const f = consumer(t);
    f.flow.edit(input()); const review = f.flow.review();
    if (invalidate === 'root') f.state.current = false;
    else f.flow.dispose();
    assert.equal(f.flow.getState().review, null); assert.equal(f.flow.getState().canSubmitReviewed, false);
    await assert.rejects(f.flow.submitReviewed(review.reviewRevision), errorCode('session_changed'));
    assert.equal(f.calls.length, 0); assert.equal(f.keys(), 0);
  }
});

test('new reports require new review and unsubscribed consumers receive no further state', async t => {
  const f = consumer(t); let updates = 0;
  const subscription = f.flow.subscribe(() => { updates++; });
  f.flow.edit(input()); const first = f.flow.review();
  await f.flow.submitReviewed(first.reviewRevision);
  f.flow.beginNew(); f.flow.edit(input());
  await assert.rejects(f.flow.submitReviewed(first.reviewRevision), errorCode('bug_review_required'));
  const next = f.flow.review(); assert.ok(next.reviewRevision > first.reviewRevision);
  subscription.remove(); const before = updates;
  await f.flow.submitReviewed(next.reviewRevision);
  assert.equal(updates, before); assert.equal(f.keys(), 2);
});
