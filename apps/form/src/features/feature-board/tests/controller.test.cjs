const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), ts = require('typescript');
const root = path.resolve(__dirname, '../../..'), cache = new Map();
function load(relative) {
  const file = path.resolve(root, relative);
  assert.ok(file.startsWith(root + path.sep));
  if (cache.has(file)) return cache.get(file).exports;
  const module = { exports: {} }; cache.set(file, module);
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function('require', 'module', 'exports', code)(name => {
    assert.ok(name.startsWith('.'));
    return load(path.relative(root, path.resolve(path.dirname(file), name + '.ts')));
  }, module, module.exports);
  return module.exports;
}
const { FeatureBoardController } = load('features/feature-board/controller.ts');
const { FeatureBoardResources } = load('api/featureBoard.ts');
const { ApiError, FormTransport } = load('api/transport.ts');
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function detail(id = 'feature-a', revision = 7, voteCount = 10, supported = false) {
  return { requestedId: id, canonicalId: id, combined: false,
    feature: { id, title: 'Larger timer text', description: 'A larger timer during workouts.', category: 'accessibility',
      status: 'planned', statusReason: null, revision, createdAt: '2026-10-01T00:00:00Z', visibility: 'published',
      authorLabel: 'Form member', voteCount, supported } };
}
const page = id => ({ features: [detail(id).feature], page: 1, pageSize: 20, hasMore: false });
function fixture(overrides = {}) {
  const calls = { browse: [], detail: [], setVote: [], ownSubmissions: [], ownVotes: [], withdraw: [], capabilities: [], submit: [], report: [], correct: [] };
  const state = { current: true, keys: 0, notifications: 0 };
  const resources = Object.fromEntries(Object.keys(calls).map(method => [method, (...args) => {
    const pending = deferred(); calls[method].push({ args, ...pending }); return pending.promise;
  }]));
  const board = new FeatureBoardController({ resources: { ...resources, ...overrides }, sessionGeneration: 'session-one',
    isCurrentSession: () => state.current, keyFactory: () => `intent-${++state.keys}` });
  board.subscribe(() => state.notifications++);
  return { board, calls, state };
}
async function open(f, value = detail()) {
  const pending = f.board.openDetail(value.requestedId);
  f.calls.detail.at(-1).resolve(value); await pending;
}
async function flush() { await Promise.resolve(); await Promise.resolve(); }
function submission(overrides = {}) {
  return { id: 'submission-a', featureId: 'original-a', canonicalFeatureId: 'canonical-a',
    title: 'Original submission title', description: 'Original member request wording.', category: 'accessibility',
    revision: 4, visibility: 'pending', createdAt: '2026-10-01T00:00:00Z', ...overrides };
}
async function own(f, rows = [submission()], query = {}) {
  const pending = f.board.loadOwnSubmissions(query);
  f.calls.ownSubmissions.at(-1).resolve({ submissions: rows }); await pending;
}
const submissionInput = () => ({ title: 'Larger workout timer', description: 'Please allow a larger timer during workouts.',
  category: 'accessibility', policyVersion: 'form_feature_board_v1', policyAccepted: true, audienceAccepted: true });
const capabilities = port => ({ submissions: 'pending_author_only', liveActivation: 'unqualified',
  purge: 'pending_qualification', moderation: port, steward: port, safety: port, retention: port,
  support: port, publicProjection: port });

test('out-of-order browse and detail are independently fenced; changing selection clears actionable detail', async () => {
  const f = fixture(); await open(f);
  const b1 = f.board.browse({ q: 'first' }), b2 = f.board.browse({ q: 'second' });
  const d1 = f.board.openDetail('first');
  assert.equal(f.board.getSnapshot().detail.value, null);
  await f.board.setSupport(true); assert.equal(f.calls.setVote.length, 0);
  const d2 = f.board.openDetail('second');
  f.calls.browse[1].resolve(page('second')); f.calls.detail[2].resolve(detail('second'));
  await Promise.all([b2, d2]);
  f.calls.browse[0].reject(new ApiError(503, 'unavailable', 'Late failure'));
  f.calls.detail[1].resolve(detail('first')); await Promise.all([b1, d1]);
  assert.equal(f.board.getSnapshot().browse.value.features[0].id, 'second');
  assert.equal(f.board.getSnapshot().detail.value.canonicalId, 'second');
  await assert.rejects(f.board.browse({ mine: 'votes' }), { code: 'board_invalid_input' });
  assert.equal(f.calls.browse.length, 2);
});

for (const ending of ['dispose', 'session']) {
  test(`${ending} clears account data, fences late reads and SET, and permanently denies retained callbacks`, async () => {
    const f = fixture(); await open(f);
    const vote = f.board.setSupport(true), browse = f.board.browse(), read = f.board.openDetail('second');
    const notifications = f.state.notifications;
    if (ending === 'dispose') f.board.dispose(); else f.state.current = false;
    const ended = f.board.getSnapshot();
    assert.equal(ended.phase, 'ended'); assert.equal(ended.selectedId, null);
    assert.equal(ended.browse.value, null); assert.equal(ended.detail.value, null);
    assert.equal(ended.vote.status, 'unreconciled');
    f.calls.setVote[0].resolve({ featureId: 'feature-a', active: true, revision: 1 });
    f.calls.browse[0].resolve(page('old-account')); f.calls.detail[1].resolve(detail('old-account'));
    await Promise.all([vote, browse, read]);
    f.state.current = true;
    await f.board.retryUncertainVote(); await f.board.setSupport(false);
    await f.board.browse(); await f.board.openDetail('new-account');
    assert.equal(f.calls.setVote.length, 1); assert.equal(f.calls.browse.length, 1); assert.equal(f.calls.detail.length, 2);
    assert.equal(f.state.notifications, notifications); assert.equal(f.board.getSnapshot(), ended);
  });
}

test('combined detail preserves original text and identities; vote uses canonical ID and feature revision', async () => {
  const f = fixture();
  const alias = { ...detail('canonical', 23), requestedId: 'original', combined: true,
    original: { title: 'Original request title', description: 'Original member wording.' } };
  await open(f, alias);
  assert.deepEqual(f.board.getSnapshot().detail.value, alias);
  const pending = f.board.setSupport(true);
  assert.deepEqual(f.calls.setVote[0].args, ['canonical', true, 23, 'intent-1']);
  f.calls.setVote[0].resolve({ featureId: 'canonical', active: true, revision: 2 });
  await flush();
  assert.deepEqual(f.calls.detail[1].args, ['original']);
  f.calls.detail[1].resolve({ ...alias, feature: { ...alias.feature, supported: true, voteCount: 42 } });
  await pending;
  assert.equal(f.board.getSnapshot().detail.value.feature.voteCount, 42);
  assert.deepEqual(f.board.getSnapshot().detail.value.original, alias.original);
});

test('pending and rejected SET do not change counts; acknowledged SET invalidates projections and failed refresh is unavailable', async () => {
  const f = fixture(); await open(f);
  const browse = f.board.browse(); f.calls.browse[0].resolve(page('feature-a')); await browse;
  const failed = f.board.setSupport(true);
  await f.board.setSupport(false);
  assert.equal(f.calls.setVote.length, 1);
  assert.equal(f.board.getSnapshot().detail.value.feature.voteCount, 10);
  assert.equal(f.board.getSnapshot().detail.value.feature.supported, false);
  f.calls.setVote[0].reject(new ApiError(403, 'not_allowed', 'Unavailable')); await failed;
  assert.equal(f.board.getSnapshot().vote.status, 'failed');
  assert.equal(f.board.getSnapshot().detail.value.feature.voteCount, 10);
  const saved = f.board.setSupport(true);
  f.calls.setVote[1].resolve({ featureId: 'feature-a', active: true, revision: 99 }); await flush();
  assert.equal(f.board.getSnapshot().browse.status, 'stale');
  assert.equal(f.board.getSnapshot().detail.value, null);
  f.calls.detail[1].reject(new ApiError(503, 'unavailable', 'Try later')); await saved;
  assert.equal(f.board.getSnapshot().vote.status, 'saved');
  assert.equal(f.board.getSnapshot().detail.status, 'unavailable');
  await f.board.setSupport(false); assert.equal(f.calls.setVote.length, 2);
});

for (const flag of ['effectUnknown', 'originalEffectUnknown']) {
  test(`${flag} retains the exact command across new reads and only explicit retries dispatch`, async () => {
    const f = fixture(); await open(f);
    const first = f.board.setSupport(true);
    const uncertain = new ApiError(0, 'unknown', 'Reconcile'); uncertain[flag] = true;
    f.calls.setVote[0].reject(uncertain); await first;
    assert.equal(f.board.getSnapshot().vote.status, 'unknown');
    await open(f, { ...detail('new-canonical', 51, 80, true), requestedId: 'feature-a', combined: true });
    await f.board.setSupport(false); assert.equal(f.calls.setVote.length, 1);
    const retry = f.board.retryUncertainVote();
    await f.board.retryUncertainVote(); await f.board.setSupport(false);
    assert.equal(f.calls.setVote.length, 2); assert.deepEqual(f.calls.setVote[1].args, f.calls.setVote[0].args);
    f.calls.setVote[1].reject(new ApiError(503, 'unavailable', 'Reconciliation unavailable')); await retry;
    assert.equal(f.board.getSnapshot().vote.status, 'unknown');
    const retryAgain = f.board.retryUncertainVote();
    assert.equal(f.calls.setVote.length, 3); assert.deepEqual(f.calls.setVote[2].args, f.calls.setVote[0].args);
    assert.equal(f.state.keys, 1);
    f.calls.setVote[2].resolve({ featureId: 'feature-a', active: true, revision: 2 }); await flush();
    f.calls.detail[2].resolve(detail('new-canonical', 52, 83, true)); await retryAgain;
    assert.equal(f.board.getSnapshot().vote.status, 'saved');
    assert.equal(f.board.getSnapshot().detail.value.feature.voteCount, 83);
    await f.board.retryUncertainVote(); assert.equal(f.calls.setVote.length, 3);
  });
}

test('stale feature revision refreshes detail without automatically issuing another SET', async () => {
  const f = fixture(); await open(f);
  const vote = f.board.setSupport(true);
  f.calls.setVote[0].reject(new ApiError(409, 'stale_revision', 'Review the latest feature')); await flush();
  assert.equal(f.board.getSnapshot().detail.value, null);
  f.calls.detail[1].resolve(detail('feature-a', 8, 19)); await vote;
  assert.equal(f.board.getSnapshot().vote.status, 'stale');
  assert.equal(f.board.getSnapshot().detail.value.feature.revision, 8);
  await f.board.retryUncertainVote(); assert.equal(f.calls.setVote.length, 1);
});

test('late SET acknowledgment and late refresh cannot replace a newly selected detail', async () => {
  const f = fixture(); await open(f);
  const vote = f.board.setSupport(true); await open(f, detail('other'));
  f.calls.setVote[0].resolve({ featureId: 'feature-a', active: true, revision: 1 }); await vote;
  assert.equal(f.calls.detail.length, 2);
  assert.equal(f.board.getSnapshot().detail.value.canonicalId, 'other');
  const second = f.board.setSupport(true);
  f.calls.setVote[1].resolve({ featureId: 'other', active: true, revision: 1 }); await flush();
  await open(f, detail('third'));
  f.calls.detail[2].resolve(detail('other', 8, 11, true)); await second;
  assert.equal(f.board.getSnapshot().detail.value.canonicalId, 'third');
});

test('own-submission pages preserve author text, original/canonical IDs and server visibility while fencing old responses', async () => {
  const f = fixture();
  const first = f.board.loadOwnSubmissions({ page: 1, pageSize: 2 });
  const second = f.board.loadOwnSubmissions({ page: 2, pageSize: 2 });
  const rows = [submission(), submission({ id: 'submission-b', visibility: 'hidden' })];
  f.calls.ownSubmissions[1].resolve({ submissions: rows }); await second;
  f.calls.ownSubmissions[0].resolve({ submissions: [submission({ title: 'Old response' })] }); await first;
  assert.deepEqual(f.board.getSnapshot().ownSubmissions.value, rows);
  assert.deepEqual(f.calls.ownSubmissions[1].args, [{ page: 2, pageSize: 2 }]);
  assert.equal(f.calls.browse.length, 0); assert.equal(f.calls.detail.length, 0);
});

test('withdrawal captures submission revision, waits for acknowledgment, refreshes current page and never removes support', async () => {
  const f = fixture(); await own(f); await open(f, detail('canonical-a', 99, 12, true));
  await f.board.withdrawSubmission('not-in-own-page'); assert.equal(f.calls.withdraw.length, 0);
  const failed = f.board.withdrawSubmission('submission-a');
  assert.deepEqual(f.calls.withdraw[0].args, ['submission-a', 4, 'intent-1']);
  assert.equal(f.board.getSnapshot().ownSubmissions.value[0].visibility, 'pending');
  assert.equal(f.board.getSnapshot().detail.value.feature.voteCount, 12);
  await f.board.withdrawSubmission('submission-a'); await f.board.setSupport(false);
  assert.equal(f.calls.withdraw.length, 1); assert.equal(f.calls.setVote.length, 0);
  f.calls.withdraw[0].reject(new ApiError(403, 'not_allowed', 'Unavailable')); await failed;
  assert.equal(f.board.getSnapshot().withdrawal.status, 'failed');
  assert.equal(f.board.getSnapshot().ownSubmissions.value[0].visibility, 'pending');
  const saved = f.board.withdrawSubmission('submission-a');
  const oldRead = f.board.loadOwnSubmissions({ page: 2, pageSize: 2 });
  await open(f, detail('unrelated'));
  f.calls.withdraw[1].resolve(submission({ visibility: 'withdrawn', revision: 5 })); await flush();
  assert.equal(f.board.getSnapshot().ownSubmissions.value, null);
  assert.equal(f.board.getSnapshot().browse.status, 'stale');
  assert.equal(f.board.getSnapshot().detail.value.canonicalId, 'unrelated');
  assert.deepEqual(f.calls.ownSubmissions[2].args, [{ page: 2, pageSize: 2 }]);
  f.calls.ownSubmissions[2].resolve({ submissions: [submission({ visibility: 'withdrawn', revision: 5 })] });
  await saved;
  f.calls.ownSubmissions[1].resolve({ submissions: [submission()] }); await oldRead;
  assert.equal(f.board.getSnapshot().withdrawal.status, 'saved');
  assert.equal(f.board.getSnapshot().ownSubmissions.value[0].visibility, 'withdrawn');
  await f.board.withdrawSubmission('submission-a'); await f.board.retryUncertainWithdrawal();
  assert.equal(f.calls.withdraw.length, 2); assert.equal(f.calls.setVote.length, 0);
});

for (const outcome of ['saved', 'stale']) {
  test(`${outcome} withdrawal invalidates affected detail and failed own refresh stays unavailable without automatic mutation`, async () => {
    const f = fixture(); await own(f); await open(f, detail('original-a'));
    const pending = f.board.withdrawSubmission('submission-a');
    if (outcome === 'saved') f.calls.withdraw[0].resolve(submission({ visibility: 'withdrawn', revision: 5 }));
    else f.calls.withdraw[0].reject(new ApiError(409, 'stale_revision', 'Review the latest submission'));
    await flush();
    assert.equal(f.board.getSnapshot().detail.status, 'stale');
    assert.equal(f.board.getSnapshot().detail.value, null);
    f.calls.ownSubmissions[1].reject(new ApiError(503, 'unavailable', 'Try later')); await pending;
    assert.equal(f.board.getSnapshot().withdrawal.status, outcome);
    assert.equal(f.board.getSnapshot().ownSubmissions.status, 'unavailable');
    await f.board.withdrawSubmission('submission-a'); await f.board.retryUncertainWithdrawal();
    assert.equal(f.calls.withdraw.length, 1); assert.equal(f.calls.setVote.length, 0);
  });
}

for (const flag of ['effectUnknown', 'originalEffectUnknown']) {
  test(`withdrawal ${flag} retries identical submission intent despite changed rows and blocks competing commands`, async () => {
    const f = fixture(); await own(f); await open(f);
    const vote = f.board.setSupport(true); await f.board.withdrawSubmission('submission-a');
    assert.equal(f.calls.withdraw.length, 0);
    f.calls.setVote[0].reject(new ApiError(403, 'not_allowed', 'Unavailable')); await vote;
    const first = f.board.withdrawSubmission('submission-a');
    const uncertain = new ApiError(0, 'unknown', 'Reconcile'); uncertain[flag] = true;
    f.calls.withdraw[0].reject(uncertain); await first;
    await own(f, [submission({ revision: 9, canonicalFeatureId: 'new-canonical' })]);
    await f.board.withdrawSubmission('submission-a'); await f.board.setSupport(false);
    assert.equal(f.calls.withdraw.length, 1); assert.equal(f.calls.setVote.length, 1);
    const retry = f.board.retryUncertainWithdrawal(); await f.board.retryUncertainWithdrawal();
    assert.equal(f.calls.withdraw.length, 2); assert.deepEqual(f.calls.withdraw[1].args, f.calls.withdraw[0].args);
    f.calls.withdraw[1].reject(new ApiError(503, 'unavailable', 'Retry unavailable')); await retry;
    assert.equal(f.board.getSnapshot().withdrawal.status, 'unknown');
    const again = f.board.retryUncertainWithdrawal();
    assert.deepEqual(f.calls.withdraw[2].args, ['submission-a', 4, 'intent-2']);
    assert.equal(f.state.keys, 2);
    f.calls.withdraw[2].resolve(submission({ visibility: 'withdrawn', revision: 10 })); await flush();
    f.calls.ownSubmissions[2].resolve({ submissions: [submission({ visibility: 'withdrawn', revision: 10 })] });
    await again; assert.equal(f.board.getSnapshot().withdrawal.status, 'saved');
    await f.board.retryUncertainWithdrawal(); assert.equal(f.calls.withdraw.length, 3);
  });
}

for (const ending of ['dispose', 'session']) {
  test(`${ending} clears own submissions and permanently fences late withdrawal/read and retry callbacks`, async () => {
    const f = fixture(); await own(f);
    const withdrawal = f.board.withdrawSubmission('submission-a'), read = f.board.loadOwnSubmissions();
    const notifications = f.state.notifications;
    if (ending === 'dispose') f.board.dispose(); else f.state.current = false;
    const ended = f.board.getSnapshot();
    assert.equal(ended.ownSubmissions.value, null); assert.equal(ended.withdrawal.status, 'unreconciled');
    f.calls.withdraw[0].resolve(submission({ visibility: 'withdrawn' }));
    f.calls.ownSubmissions[1].resolve({ submissions: [submission()] });
    await Promise.all([withdrawal, read]); f.state.current = true;
    await f.board.loadOwnSubmissions(); await f.board.withdrawSubmission('submission-a');
    await f.board.retryUncertainWithdrawal();
    assert.equal(f.calls.ownSubmissions.length, 2); assert.equal(f.calls.withdraw.length, 1);
    assert.equal(f.state.notifications, notifications); assert.equal(f.board.getSnapshot(), ended);
  });
}

test('capability readback preserves unqualified and unavailable ports and fences out-of-order responses', async () => {
  const f = fixture();
  const first = f.board.loadCapabilities(), second = f.board.loadCapabilities();
  const value = capabilities('injected_unqualified');
  f.calls.capabilities[1].resolve(value); await second;
  f.calls.capabilities[0].reject(new ApiError(503, 'unavailable', 'Late failure')); await first;
  assert.deepEqual(f.board.getSnapshot().capabilities.value, value);
  const third = f.board.loadCapabilities(); f.calls.capabilities[2].resolve(capabilities('unavailable')); await third;
  assert.deepEqual(f.board.getSnapshot().capabilities.value, capabilities('unavailable'));
  const failed = f.board.loadCapabilities(); f.calls.capabilities[3].reject(new ApiError(503, 'unavailable', 'Retry later'));
  await failed; assert.equal(f.board.getSnapshot().capabilities.status, 'unavailable');
  assert.equal(f.board.getSnapshot().capabilities.value, null);
});

test('submission uses actual typed API acknowledgment validation and never adds an implicit vote', async () => {
  const requests = [];
  const api = new FeatureBoardResources({ request: async (...args) => { requests.push(args); return submission(); } }, () => true);
  const f = fixture({ submit: api.submit.bind(api) });
  for (const input of [{ ...submissionInput(), policyAccepted: false }, { ...submissionInput(), audienceAccepted: undefined },
    { ...submissionInput(), policyVersion: 'other' }, { ...submissionInput(), voteOnSubmit: 'true' }]) {
    await f.board.submitRequest(input);
    assert.equal(f.board.getSnapshot().submission.status, 'failed');
  }
  assert.equal(requests.length, 0);
  const pending = f.board.submitRequest(submissionInput()); await flush();
  assert.deepEqual(requests[0].slice(0, 3), ['/v1/community/board/features', 'POST', submissionInput()]);
  assert.equal('voteOnSubmit' in requests[0][2], false);
  f.calls.ownSubmissions[0].resolve({ submissions: [submission()] }); await pending;
  assert.equal(f.board.getSnapshot().submitted.visibility, 'pending');
  assert.equal(f.calls.setVote.length, 0);
});

for (const visibility of ['pending', 'withdrawn']) {
  test(`submission acknowledgment preserves authoritative ${visibility} result even when own refresh fails`, async () => {
    const f = fixture();
    const read = f.board.loadCapabilities(); f.calls.capabilities[0].resolve(capabilities('unavailable')); await read;
    const pending = f.board.submitRequest(submissionInput());
    assert.equal(f.board.getSnapshot().submitted, null);
    assert.equal(f.board.getSnapshot().submission.status, 'pending');
    const value = submission({ visibility, revision: 9, canonicalFeatureId: 'merged-target' });
    f.calls.submit[0].resolve(value); await flush();
    assert.deepEqual(f.board.getSnapshot().submitted, value);
    assert.equal(f.board.getSnapshot().browse.status, 'stale');
    f.calls.ownSubmissions[0].reject(new ApiError(503, 'unavailable', 'Refresh unavailable')); await pending;
    assert.equal(f.board.getSnapshot().submission.status, 'saved');
    assert.equal(f.board.getSnapshot().ownSubmissions.status, 'unavailable');
    assert.deepEqual(f.board.getSnapshot().submitted, value);
    assert.equal(f.calls.setVote.length, 0);
  });
}

test('text rejection clears the submission command and never echoes rejected content in exposed errors or results', async () => {
  const f = fixture();
  const input = submissionInput();
  const pending = f.board.submitRequest(input);
  f.calls.submit[0].reject(new ApiError(422, 'board_text_rejected', input.description)); await pending;
  assert.equal(f.board.getSnapshot().submission.status, 'failed');
  assert.equal(f.board.getSnapshot().submitted, null);
  assert.equal(f.board.getSnapshot().submission.error.message.includes(input.description), false);
  assert.equal(JSON.stringify(f.board.getSnapshot()).includes(input.description), false);
  await f.board.retryUncertainSubmission(); assert.equal(f.calls.submit.length, 1);
  const corrected = f.board.submitRequest({ ...input, title: 'Corrected workout request' });
  assert.equal(f.calls.submit[1].args[1], 'intent-2');
  f.calls.submit[1].reject(new ApiError(422, 'board_text_rejected', 'Rejected')); await corrected;
});

for (const flag of ['effectUnknown', 'originalEffectUnknown']) {
  test(`submission ${flag} retains private exact input and key across edits and blocks competing commands`, async () => {
    const f = fixture(); await open(f); await own(f);
    const vote = f.board.setSupport(true); await f.board.submitRequest(submissionInput());
    assert.equal(f.calls.submit.length, 0);
    f.calls.setVote[0].reject(new ApiError(403, 'not_allowed', 'Unavailable')); await vote;
    const withdrawal = f.board.withdrawSubmission('submission-a'); await f.board.submitRequest(submissionInput());
    assert.equal(f.calls.submit.length, 0);
    f.calls.withdraw[0].reject(new ApiError(403, 'not_allowed', 'Unavailable')); await withdrawal;
    const input = { ...submissionInput(), voteOnSubmit: true }, expected = { ...input };
    const pending = f.board.submitRequest(input);
    input.title = 'Edited after dispatch'; input.voteOnSubmit = false;
    const uncertain = new ApiError(503, 'board_safety_unavailable', 'Unavailable'); uncertain[flag] = true;
    f.calls.submit[0].reject(uncertain); await pending;
    assert.equal(f.board.getSnapshot().submission.status, 'unknown');
    assert.equal(JSON.stringify(f.board.getSnapshot()).includes(expected.description), false);
    await f.board.submitRequest(input); await f.board.withdrawSubmission('submission-a'); await f.board.setSupport(false);
    assert.equal(f.calls.submit.length, 1); assert.equal(f.calls.withdraw.length, 1); assert.equal(f.calls.setVote.length, 1);
    const retry = f.board.retryUncertainSubmission(); await f.board.retryUncertainSubmission();
    assert.equal(f.calls.submit.length, 2); assert.deepEqual(f.calls.submit[1].args, [expected, 'intent-3']);
    f.calls.submit[1].reject(new ApiError(429, 'board_rate_limited', 'Try later')); await retry;
    assert.equal(f.board.getSnapshot().submission.status, 'unknown');
    const again = f.board.retryUncertainSubmission(); assert.deepEqual(f.calls.submit[2].args, f.calls.submit[0].args);
    f.calls.submit[2].resolve(submission({ visibility: 'withdrawn', revision: 8 })); await flush();
    f.calls.ownSubmissions[1].resolve({ submissions: [submission({ visibility: 'withdrawn', revision: 8 })] }); await again;
    assert.equal(f.board.getSnapshot().submitted.visibility, 'withdrawn');
    await f.board.retryUncertainSubmission(); assert.equal(f.calls.submit.length, 3); assert.equal(f.state.keys, 3);
  });
}

for (const ending of ['dispose', 'session']) {
  test(`${ending} permanently clears and fences submission results, capability reads and retained callbacks`, async () => {
    const f = fixture();
    const pending = f.board.submitRequest(submissionInput()), read = f.board.loadCapabilities();
    const notifications = f.state.notifications;
    if (ending === 'dispose') f.board.dispose(); else f.state.current = false;
    const ended = f.board.getSnapshot();
    assert.equal(ended.submitted, null); assert.equal(ended.submission.status, 'unreconciled');
    assert.equal(ended.capabilities.value, null);
    f.calls.submit[0].resolve(submission()); f.calls.capabilities[0].resolve(capabilities('injected_unqualified'));
    await Promise.all([pending, read]); f.state.current = true;
    await f.board.submitRequest(submissionInput()); await f.board.retryUncertainSubmission(); await f.board.loadCapabilities();
    assert.equal(f.calls.submit.length, 1); assert.equal(f.calls.capabilities.length, 1);
    assert.equal(f.calls.ownSubmissions.length, 0); assert.equal(f.state.notifications, notifications);
    assert.equal(f.board.getSnapshot(), ended);
  });
}

test('reporting uses the actual reason-only API and exposes only a pending receipt for the supplied feature', async () => {
  const requests = [];
  const api = new FeatureBoardResources({ request: async (...args) => {
    requests.push(args); return { receiptId: `receipt-${requests.length}`, status: 'pending' };
  } }, () => true);
  const f = fixture({ report: api.report.bind(api) });
  await f.board.reportFeature('privacy'); assert.equal(requests.length, 0);
  await open(f, { ...detail('canonical'), requestedId: 'original', combined: true });
  for (const reason of ['custom free text', { reason: 'privacy', quote: 'User text' }]) {
    await f.board.reportFeature(reason);
    assert.equal(f.board.getSnapshot().report.status, 'failed');
  }
  assert.equal(requests.length, 0);
  for (const reason of ['harassment', 'privacy', 'unsafe', 'other']) {
    await f.board.reportFeature(reason);
    assert.deepEqual(requests.at(-1).slice(0, 3), ['/v1/community/board/features/original/report', 'POST', { reason }]);
    assert.deepEqual(f.board.getSnapshot().reportReceipt,
      { featureId: 'original', receiptId: `receipt-${requests.length}`, status: 'pending' });
    assert.equal(f.board.getSnapshot().report.status, 'saved');
  }
  assert.equal(f.calls.detail.length, 1); assert.equal(f.calls.browse.length, 0);
  f.board.dispose(); assert.equal(f.board.getSnapshot().reportReceipt, null);
});

test('a late report receipt stays associated with its original request and cannot replace a newer selection', async () => {
  const f = fixture(); await open(f, { ...detail('canonical'), requestedId: 'original', combined: true });
  const pending = f.board.reportFeature('unsafe');
  assert.deepEqual(f.calls.report[0].args, ['original', 'unsafe', 'intent-1']);
  assert.equal(f.board.getSnapshot().report.status, 'pending'); assert.equal(f.board.getSnapshot().reportReceipt, null);
  await open(f, detail('other'));
  f.calls.report[0].resolve({ receiptId: 'receipt-a', status: 'pending' }); await pending;
  assert.equal(f.board.getSnapshot().detail.value.canonicalId, 'other');
  assert.deepEqual(f.board.getSnapshot().reportReceipt, { featureId: 'original', receiptId: 'receipt-a', status: 'pending' });
  await f.board.retryUncertainReport(); assert.equal(f.calls.report.length, 1);
  assert.equal(f.calls.setVote.length, 0); assert.equal(f.calls.withdraw.length, 0);
});

for (const flag of ['effectUnknown', 'originalEffectUnknown']) {
  test(`report ${flag} retries the exact original ID, reason and key with sanitized errors and competing commands blocked`, async () => {
    const f = fixture(); await open(f, { ...detail('canonical'), requestedId: 'original', combined: true }); await own(f);
    const pending = f.board.reportFeature('privacy');
    await f.board.reportFeature('other'); await f.board.setSupport(true);
    await f.board.withdrawSubmission('submission-a'); await f.board.submitRequest(submissionInput());
    assert.equal(f.calls.report.length, 1); assert.equal(f.calls.setVote.length, 0);
    assert.equal(f.calls.withdraw.length, 0); assert.equal(f.calls.submit.length, 0);
    const uncertain = new ApiError(503, 'board_safety_unavailable', 'Sensitive reported content'); uncertain[flag] = true;
    f.calls.report[0].reject(uncertain); await pending;
    assert.equal(f.board.getSnapshot().report.status, 'unknown'); assert.equal(f.board.getSnapshot().reportReceipt, null);
    assert.equal(f.board.getSnapshot().report.error[flag], true);
    assert.equal(f.board.getSnapshot().report.error.message.includes('Sensitive reported content'), false);
    await open(f, detail('new-canonical', 99));
    await f.board.reportFeature('harassment'); await f.board.setSupport(false);
    await f.board.withdrawSubmission('submission-a'); await f.board.submitRequest(submissionInput());
    assert.equal(f.calls.report.length, 1); assert.equal(f.calls.setVote.length, 0);
    assert.equal(f.calls.withdraw.length, 0); assert.equal(f.calls.submit.length, 0);
    const retry = f.board.retryUncertainReport(); await f.board.retryUncertainReport();
    assert.equal(f.calls.report.length, 2); assert.deepEqual(f.calls.report[1].args, ['original', 'privacy', 'intent-1']);
    f.calls.report[1].reject(new ApiError(403, 'not_allowed', 'Private rejection text')); await retry;
    assert.equal(f.board.getSnapshot().report.status, 'unknown');
    assert.equal(f.board.getSnapshot().report.error.message.includes('Private rejection text'), false);
    const again = f.board.retryUncertainReport(); assert.deepEqual(f.calls.report[2].args, f.calls.report[0].args);
    f.calls.report[2].resolve({ receiptId: 'receipt-a', status: 'pending' }); await again;
    assert.equal(f.board.getSnapshot().reportReceipt.featureId, 'original');
    assert.equal(f.board.getSnapshot().detail.value.canonicalId, 'new-canonical');
    assert.equal(f.state.keys, 1);
  });
}

test('pending or uncertain vote, withdrawal and submission each block a new report', async () => {
  for (const operation of ['vote', 'withdrawal', 'submission']) {
    const f = fixture(); await open(f); await own(f);
    const pending = operation === 'vote' ? f.board.setSupport(true) : operation === 'withdrawal' ?
      f.board.withdrawSubmission('submission-a') : f.board.submitRequest(submissionInput());
    await f.board.reportFeature('privacy'); assert.equal(f.calls.report.length, 0);
    const calls = operation === 'vote' ? f.calls.setVote : operation === 'withdrawal' ? f.calls.withdraw : f.calls.submit;
    calls[0].reject(new ApiError(0, 'unknown', 'Unknown effect', true)); await pending;
    await f.board.reportFeature('privacy'); assert.equal(f.calls.report.length, 0);
    f.board.dispose();
  }
});

for (const ending of ['dispose', 'session']) {
  test(`${ending} clears report state and permanently fences late receipt and retained report callbacks`, async () => {
    const f = fixture(); await open(f);
    const pending = f.board.reportFeature('privacy');
    const notifications = f.state.notifications;
    if (ending === 'dispose') f.board.dispose(); else f.state.current = false;
    const ended = f.board.getSnapshot();
    assert.equal(ended.report.status, 'unreconciled'); assert.equal(ended.reportReceipt, null);
    f.calls.report[0].resolve({ receiptId: 'old-account-receipt', status: 'pending' }); await pending;
    f.state.current = true;
    await f.board.reportFeature('other'); await f.board.retryUncertainReport();
    assert.equal(f.calls.report.length, 1); assert.equal(f.state.notifications, notifications);
    assert.equal(f.board.getSnapshot(), ended); assert.equal(f.board.getSnapshot().reportReceipt, null);
  });
}

test('own votes uses actual pagination API and preserves only authoritative vote-row projections', async () => {
  const requests = [], rows = [{ featureId: 'hidden-feature', active: false, revision: 42 },
    { featureId: 'canonical-feature', active: true, revision: 3 }];
  const api = new FeatureBoardResources({ request: async (...args) => { requests.push(args); return { votes: rows }; } }, () => true);
  const f = fixture({ ownVotes: api.ownVotes.bind(api) });
  await f.board.loadOwnVotes({ page: 2, pageSize: 10 });
  assert.equal(requests[0][0], '/v1/community/board/me/votes?page=2&pageSize=10');
  assert.deepEqual(f.board.getSnapshot().ownVotes.value, rows);
  assert.equal(f.calls.detail.length, 0); assert.equal(f.calls.browse.length, 0);
  await f.board.setSupport(false); assert.equal(f.calls.setVote.length, 0);
  for (const query of [{ page: 0 }, { pageSize: 51 }, { mine: 'votes' }, { q: 'private text' }]) {
    await f.board.loadOwnVotes(query);
    assert.equal(f.board.getSnapshot().ownVotes.status, 'unavailable');
    assert.equal(f.board.getSnapshot().ownVotes.error.code, 'board_invalid_input');
  }
  assert.equal(requests.length, 1);
});

test('own-vote reads fence old responses independently and expose read failure without stale rows', async () => {
  const f = fixture();
  const first = f.board.loadOwnVotes({ page: 1 }), second = f.board.loadOwnVotes({ page: 2 });
  await own(f); await open(f);
  const rows = [{ featureId: 'second-page', active: true, revision: 5 }];
  f.calls.ownVotes[1].resolve({ votes: rows }); await second;
  f.calls.ownVotes[0].reject(new ApiError(503, 'unavailable', 'Old failure')); await first;
  assert.deepEqual(f.board.getSnapshot().ownVotes.value, rows);
  assert.equal(f.board.getSnapshot().ownSubmissions.status, 'ready');
  assert.equal(f.board.getSnapshot().detail.status, 'ready');
  const failed = f.board.loadOwnVotes();
  assert.equal(f.board.getSnapshot().ownVotes.value, null);
  f.calls.ownVotes[2].reject(new ApiError(503, 'unavailable', 'Try later')); await failed;
  assert.equal(f.board.getSnapshot().ownVotes.status, 'unavailable');
  assert.equal(f.board.getSnapshot().ownVotes.value, null);
});

test('acknowledged support invalidates own votes and late reads while SET still uses the feature revision', async () => {
  const f = fixture(); await open(f, detail('feature-a', 7));
  const rows = [{ featureId: 'feature-a', active: false, revision: 92 }];
  const read = f.board.loadOwnVotes(); f.calls.ownVotes[0].resolve({ votes: rows }); await read;
  const pending = f.board.setSupport(true);
  assert.deepEqual(f.calls.setVote[0].args, ['feature-a', true, 7, 'intent-1']);
  assert.deepEqual(f.board.getSnapshot().ownVotes.value, rows);
  const old = f.board.loadOwnVotes();
  f.calls.setVote[0].resolve({ featureId: 'feature-a', active: true, revision: 93 }); await flush();
  assert.equal(f.board.getSnapshot().ownVotes.status, 'stale');
  assert.equal(f.board.getSnapshot().ownVotes.value, null);
  f.calls.ownVotes[1].resolve({ votes: rows }); await old;
  assert.equal(f.board.getSnapshot().ownVotes.status, 'stale');
  f.calls.detail[1].resolve(detail('feature-a', 8, 20, true)); await pending;
  assert.equal(f.calls.ownVotes.length, 2);
  const refreshed = f.board.loadOwnVotes();
  const updated = [{ featureId: 'feature-a', active: true, revision: 93 }];
  f.calls.ownVotes[2].resolve({ votes: updated }); await refreshed;
  assert.deepEqual(f.board.getSnapshot().ownVotes.value, updated);
});

test('only explicit vote-on-submit invalidates own votes, including reads dispatched before acknowledgment', async () => {
  for (const choice of [undefined, false, true]) {
    const f = fixture(), rows = [{ featureId: 'existing-feature', active: true, revision: 9 }];
    const read = f.board.loadOwnVotes(); f.calls.ownVotes[0].resolve({ votes: rows }); await read;
    const ready = f.board.getSnapshot().ownVotes;
    const old = choice === true ? f.board.loadOwnVotes() : null;
    const input = { ...submissionInput(), ...(choice === undefined ? {} : { voteOnSubmit: choice }) };
    const pending = f.board.submitRequest(input);
    f.calls.submit[0].resolve(submission()); await flush();
    if (choice === true) {
      assert.equal(f.board.getSnapshot().ownVotes.status, 'stale');
      f.calls.ownVotes[1].resolve({ votes: rows }); await old;
      assert.equal(f.board.getSnapshot().ownVotes.status, 'stale');
      assert.equal(f.board.getSnapshot().ownVotes.value, null);
    } else assert.equal(f.board.getSnapshot().ownVotes, ready);
    f.calls.ownSubmissions[0].resolve({ submissions: [submission()] }); await pending;
    assert.equal(f.calls.setVote.length, 0);
  }
});

for (const ending of ['dispose', 'session']) {
  test(`${ending} clears own votes and fences late read results and retained read callbacks`, async () => {
    const f = fixture(), rows = [{ featureId: 'old-account-feature', active: true, revision: 13 }];
    const read = f.board.loadOwnVotes(); f.calls.ownVotes[0].resolve({ votes: rows }); await read;
    const pending = f.board.loadOwnVotes({ page: 2 });
    const notifications = f.state.notifications;
    if (ending === 'dispose') f.board.dispose(); else f.state.current = false;
    const ended = f.board.getSnapshot(); assert.equal(ended.ownVotes.value, null);
    f.calls.ownVotes[1].resolve({ votes: rows }); await pending;
    f.state.current = true; await f.board.loadOwnVotes();
    assert.equal(f.calls.ownVotes.length, 2); assert.equal(f.state.notifications, notifications);
    assert.equal(f.board.getSnapshot(), ended); assert.equal(f.board.getSnapshot().ownVotes.value, null);
  });
}

// Synthetic responses exercise the real resource and transport; no server or account is contacted.
function correctionFixture() {
  const requests = [];
  const transport = new FormTransport('https://form.example', {
    load: async () => null, save: async () => {}, clear: async () => {},
  }, (url, init) => {
    const pending = deferred();
    requests.push({ url, method: init.method, body: JSON.parse(init.body), key: init.headers['Idempotency-Key'], ...pending });
    return pending.promise;
  });
  let f;
  const resources = new FeatureBoardResources(transport, () => f.state.current);
  f = fixture({ correct: resources.correct.bind(resources) });
  return { ...f, requests, resources, transport };
}
function correctionResult(request, original = submission()) {
  const { expectedRevision, expectedCanonicalFeatureId, ...replacement } = request.body;
  const receipt = { schema: 'form.feature-board-correction/v1', key: request.key, eventId: 'correction-event',
    submissionId: original.id, featureId: original.featureId, expectedRevision, resultRevision: expectedRevision + 1,
    canonicalFeatureId: expectedCanonicalFeatureId, canonicalRevision: 137,
    successor: { submissionId: 'successor-submission', featureId: 'successor-feature' }, replacement,
    createdAt: '2026-10-12T00:00:00.000Z' };
  return { receipt, successor: { id: receipt.successor.submissionId, featureId: receipt.successor.featureId,
    canonicalFeatureId: receipt.successor.featureId, title: replacement.title, description: replacement.description,
    category: replacement.category, revision: 1, visibility: 'pending', createdAt: receipt.createdAt,
    predecessorSubmissionId: original.id } };
}
async function correctionResponse(f, index, body, status = 201) {
  f.requests[index].resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
  await new Promise(resolve => setImmediate(resolve));
}
const correctionIntent = request => ({ url: request.url, method: request.method, body: request.body, key: request.key });
async function competingCommands(board) {
  await board.setSupport(true); await board.setSupport(false); await board.withdrawSubmission('submission-a');
  await board.submitRequest(submissionInput()); await board.reportFeature('privacy');
  await board.correctSubmission('submission-a', submissionInput());
}

test('correction binds the owned submission fence through the actual transport and leaves original text and support unchanged', async () => {
  const f = correctionFixture(), original = submission(); await own(f, [original]);
  const combined = { ...detail('canonical-a', 99, 12, true), requestedId: 'original-a', combined: true,
    original: { title: original.title, description: original.description } };
  await open(f, combined);
  const votes = f.board.loadOwnVotes();
  const voteRows = [{ featureId: 'canonical-a', active: true, revision: 48 }];
  f.calls.ownVotes[0].resolve({ votes: voteRows }); await votes;
  const pending = f.board.correctSubmission(original.id, submissionInput());
  assert.deepEqual(correctionIntent(f.requests[0]), {
    url: 'https://form.example/v1/community/board/submissions/submission-a/correct', method: 'POST',
    body: { ...submissionInput(), expectedRevision: 4, expectedCanonicalFeatureId: 'canonical-a' }, key: 'intent-1',
  });
  assert.equal('voteOnSubmit' in f.requests[0].body, false);
  assert.equal(f.board.getSnapshot().correction.status, 'pending');
  assert.equal(f.board.getSnapshot().correctionReceipt, null);
  assert.deepEqual(f.board.getSnapshot().detail.value, combined);
  assert.deepEqual(f.board.getSnapshot().ownSubmissions.value, [original]);
  const result = correctionResult(f.requests[0]); await correctionResponse(f, 0, result);
  assert.equal(f.board.getSnapshot().detail.status, 'stale');
  assert.equal(f.board.getSnapshot().detail.value, null);
  assert.equal(f.board.getSnapshot().browse.status, 'stale');
  assert.deepEqual(f.board.getSnapshot().ownVotes.value, voteRows);
  f.calls.ownSubmissions[1].resolve({ submissions: [{ ...original, revision: 5, successorSubmissionId: result.successor.id }, result.successor] });
  await pending;
  assert.deepEqual(f.board.getSnapshot().correctionReceipt, result.receipt);
  assert.equal(f.board.getSnapshot().correctionReceipt.canonicalRevision, 137);
  assert.equal(f.board.getSnapshot().correctionReceipt.resultRevision, 5);
  assert.equal(f.board.getSnapshot().correctionSuccessor.visibility, 'pending');
  assert.ok(Object.isFrozen(f.board.getSnapshot().correctionReceipt.replacement));
  assert.equal(original.revision, 4); assert.equal(original.title, 'Original submission title');
  assert.equal(combined.feature.voteCount, 12); assert.equal(combined.feature.supported, true);
  assert.equal(f.calls.withdraw.length, 0); assert.equal(f.calls.setVote.length, 0); assert.equal(f.calls.submit.length, 0);
});

test('correction needs a current owned unsuperseded submission and resource acceptance without manufacturing authority', async () => {
  const f = correctionFixture();
  await f.board.correctSubmission('submission-a', submissionInput());
  for (const row of [submission({ visibility: 'withdrawn' }), submission({ successorSubmissionId: 'later' })]) {
    await own(f, [row]); await f.board.correctSubmission(row.id, submissionInput());
  }
  await own(f); await f.board.correctSubmission('not-owned', submissionInput());
  assert.equal(f.requests.length, 0); assert.equal(f.state.keys, 0);
  for (const extra of [{ policyAccepted: false }, { audienceAccepted: false }, { voteOnSubmit: true }, { accountId: 'foreign' }]) {
    await f.board.correctSubmission('submission-a', { ...submissionInput(), ...extra });
    assert.equal(f.board.getSnapshot().correction.status, 'failed');
    assert.equal(f.board.getSnapshot().correctionReceipt, null);
  }
  assert.equal(f.requests.length, 0);
  const pending = f.board.correctSubmission('submission-a', submissionInput());
  await correctionResponse(f, 0, { error: { code: 'board_text_rejected', message: submissionInput().description } }, 422);
  await pending;
  assert.equal(f.board.getSnapshot().correction.status, 'failed');
  assert.equal(JSON.stringify(f.board.getSnapshot()).includes(submissionInput().description), false);
  await f.board.retryUncertainCorrection(); assert.equal(f.requests.length, 1);
});

test('correction retries an immutable original body and key after edits, fresh reads and successive conflicts', async () => {
  const f = correctionFixture(), original = submission(); await own(f, [original]); await open(f);
  const input = submissionInput(), pending = f.board.correctSubmission(original.id, input);
  const intent = correctionIntent(f.requests[0]);
  input.title = 'Edited replacement'; original.revision = 87; original.featureId = 'changed-original';
  original.canonicalFeatureId = 'changed-canonical';
  f.requests[0].reject(new Error('Lost acknowledgment')); await pending;
  assert.equal(f.board.getSnapshot().correction.status, 'unknown');
  for (const code of ['stale_revision', 'board_canonical_changed', 'board_already_corrected', 'board_text_rejected']) {
    await own(f, [submission({ revision: 88, canonicalFeatureId: 'new-canonical', successorSubmissionId: 'successor-submission' })]);
    await open(f, detail('new-canonical', 501));
    assert.equal(f.board.getSnapshot().correction.status, 'unknown');
    await f.board.correctSubmission('submission-a', input); assert.equal(f.state.keys, 1);
    const retry = f.board.retryUncertainCorrection(); await f.board.retryUncertainCorrection();
    const index = f.requests.length - 1;
    assert.deepEqual(correctionIntent(f.requests[index]), intent);
    await correctionResponse(f, index, { error: { code, message: 'Private rejection text' } }, 409); await retry;
    assert.equal(f.board.getSnapshot().correction.status, 'unknown');
    assert.equal(f.board.getSnapshot().correction.error.message.includes('Private rejection text'), false);
    assert.equal(f.board.getSnapshot().correctionReceipt, null);
  }
  const retry = f.board.retryUncertainCorrection(), index = f.requests.length - 1;
  assert.deepEqual(correctionIntent(f.requests[index]), intent);
  const result = correctionResult(f.requests[index]); result.successor = null;
  await correctionResponse(f, index, result);
  f.calls.ownSubmissions.at(-1).resolve({ submissions: [] }); await retry;
  assert.equal(f.board.getSnapshot().correction.status, 'saved');
  assert.deepEqual(f.board.getSnapshot().correctionReceipt, result.receipt);
  assert.equal(f.board.getSnapshot().correctionSuccessor, null);
  await f.board.retryUncertainCorrection(); assert.equal(f.requests.length, index + 1); assert.equal(f.state.keys, 1);
});

test('malformed and mismatched correction receipts cannot settle an intent even with a fresh successor', async () => {
  const corruptions = [
    r => { delete r.receipt; }, r => { r.receipt.key = 'other'; }, r => { r.receipt.submissionId = 'other'; },
    r => { r.receipt.featureId = 'unrelated-original'; }, r => { r.receipt.expectedRevision = 99; },
    r => { r.receipt.resultRevision = 99; }, r => { r.receipt.canonicalFeatureId = 'other'; },
    r => { r.receipt.replacement.title = 'An unrelated replacement'; }, r => { r.receipt.extra = 'private'; },
    r => { r.successor.predecessorSubmissionId = 'unrelated'; },
  ];
  for (const corrupt of corruptions) {
    const f = correctionFixture(); await own(f);
    const pending = f.board.correctSubmission('submission-a', submissionInput());
    const result = correctionResult(f.requests[0]); corrupt(result);
    await correctionResponse(f, 0, result); await pending;
    assert.equal(f.board.getSnapshot().correction.status, 'unknown');
    assert.equal(f.board.getSnapshot().correction.error.code, 'board_correction_response_invalid');
    assert.equal(f.board.getSnapshot().correctionReceipt, null); assert.equal(f.board.getSnapshot().correctionSuccessor, null);
    assert.equal(f.calls.ownSubmissions.length, 1);
    await own(f, [correctionResult(f.requests[0]).successor]);
    assert.equal(f.board.getSnapshot().correction.status, 'unknown');
    const retry = f.board.retryUncertainCorrection();
    assert.deepEqual(correctionIntent(f.requests[1]), correctionIntent(f.requests[0]));
    const valid = correctionResult(f.requests[1]); await correctionResponse(f, 1, valid);
    f.calls.ownSubmissions.at(-1).resolve({ submissions: [valid.successor] }); await retry;
    assert.equal(f.board.getSnapshot().correction.status, 'saved'); f.board.dispose();
  }
});

test('matching correction receipt remains authoritative with nullable, hidden, withdrawn, merged or further-corrected successor', async () => {
  for (const state of ['absent', 'hidden', 'withdrawn', 'merged', 'corrected']) {
    const f = correctionFixture(); await own(f);
    const pending = f.board.correctSubmission('submission-a', submissionInput());
    const result = correctionResult(f.requests[0]);
    if (state === 'absent') result.successor = null;
    else {
      result.successor.revision = 17;
      if (state === 'hidden' || state === 'withdrawn') result.successor.visibility = state;
      if (state === 'merged') result.successor.canonicalFeatureId = 'later-merge-root';
      if (state === 'corrected') result.successor.successorSubmissionId = 'third-submission';
    }
    await correctionResponse(f, 0, result);
    f.calls.ownSubmissions.at(-1).reject(new ApiError(503, 'unavailable', 'Read failed')); await pending;
    assert.equal(f.board.getSnapshot().correction.status, 'saved');
    assert.deepEqual(f.board.getSnapshot().correctionReceipt, result.receipt);
    assert.deepEqual(f.board.getSnapshot().correctionSuccessor, result.successor);
    assert.equal(f.board.getSnapshot().ownSubmissions.status, 'unavailable');
    assert.equal(f.board.getSnapshot().selectedId, null); assert.equal(f.calls.detail.length, 0);
    await f.board.correctSubmission('successor-submission', submissionInput()); assert.equal(f.requests.length, 1);
    f.board.dispose(); assert.equal(f.board.getSnapshot().correctionReceipt, null);
    assert.equal(f.board.getSnapshot().correctionSuccessor, null);
  }
});

test('pending and uncertain correction excludes every other mutation and duplicate retry', async () => {
  const f = correctionFixture(); await own(f); await open(f);
  const pending = f.board.correctSubmission('submission-a', submissionInput());
  await competingCommands(f.board); await f.board.retryUncertainCorrection();
  assert.equal(f.requests.length, 1);
  f.requests[0].reject(new Error('Lost')); await pending;
  await competingCommands(f.board);
  for (const method of ['setVote', 'withdraw', 'submit', 'report', 'correct']) assert.equal(f.calls[method].length, 0);
  assert.equal(f.requests.length, 1); assert.equal(f.state.keys, 1);
  const retry = f.board.retryUncertainCorrection(); await competingCommands(f.board); await f.board.retryUncertainCorrection();
  assert.equal(f.requests.length, 2);
  await correctionResponse(f, 1, { error: { code: 'stale_revision', message: 'Changed' } }, 409); await retry;
  assert.equal(f.board.getSnapshot().correction.status, 'unknown'); f.board.dispose();
});

test('pending and uncertain vote, withdrawal, submission and report each exclude a new correction', async () => {
  for (const operation of ['setVote', 'withdraw', 'submit', 'report']) {
    const f = correctionFixture(); await own(f); await open(f);
    const pending = operation === 'setVote' ? f.board.setSupport(true) : operation === 'withdraw' ?
      f.board.withdrawSubmission('submission-a') : operation === 'submit' ? f.board.submitRequest(submissionInput()) :
        f.board.reportFeature('privacy');
    await f.board.correctSubmission('submission-a', submissionInput()); assert.equal(f.requests.length, 0);
    f.calls[operation][0].reject(new ApiError(0, 'unknown', 'Uncertain effect', true)); await pending;
    await f.board.correctSubmission('submission-a', submissionInput()); assert.equal(f.requests.length, 0);
    assert.equal(f.state.keys, 1); f.board.dispose();
  }
});

test('correction acknowledgment refreshes the current own page and fences older browse, page and successor detail responses', async () => {
  const f = correctionFixture(); await own(f, [submission()], { page: 1, pageSize: 2 });
  const pending = f.board.correctSubmission('submission-a', submissionInput());
  const oldPage = f.board.loadOwnSubmissions({ page: 2, pageSize: 2 });
  const oldBrowse = f.board.browse({ page: 2 }), oldDetail = f.board.openDetail('successor-feature');
  const result = correctionResult(f.requests[0]); await correctionResponse(f, 0, result);
  assert.deepEqual(f.calls.ownSubmissions[2].args, [{ page: 2, pageSize: 2 }]);
  assert.equal(f.board.getSnapshot().detail.status, 'stale'); assert.equal(f.board.getSnapshot().browse.status, 'stale');
  f.calls.ownSubmissions[1].resolve({ submissions: [submission()] });
  f.calls.browse[0].resolve(page('old')); f.calls.detail[0].resolve(detail('successor-feature'));
  await Promise.all([oldPage, oldBrowse, oldDetail]);
  assert.equal(f.board.getSnapshot().ownSubmissions.status, 'loading');
  assert.equal(f.board.getSnapshot().browse.value, null); assert.equal(f.board.getSnapshot().detail.value, null);
  const thirdPage = f.board.loadOwnSubmissions({ page: 3, pageSize: 2 });
  const newest = submission({ id: 'third-page-item', predecessorSubmissionId: 'hidden-predecessor' });
  f.calls.ownSubmissions[3].resolve({ submissions: [newest] }); await thirdPage;
  f.calls.ownSubmissions[2].resolve({ submissions: [result.successor] }); await pending;
  assert.deepEqual(f.board.getSnapshot().ownSubmissions.value, [newest]);
  assert.equal(f.calls.detail.length, 1); assert.equal(f.board.getSnapshot().correction.status, 'saved');
});

test('late correction acknowledgment preserves unrelated selection and invalidates related merged successor aliases', async () => {
  for (const related of [false, true]) {
    const f = correctionFixture(); await own(f); await open(f, detail('original-a'));
    const pending = f.board.correctSubmission('submission-a', submissionInput());
    const selected = related ? { ...detail('later-merge-root'), requestedId: 'successor-alias', combined: true } : detail('unrelated');
    await open(f, selected);
    const result = correctionResult(f.requests[0]); result.successor.canonicalFeatureId = 'later-merge-root';
    await correctionResponse(f, 0, result);
    assert.equal(f.board.getSnapshot().selectedId, selected.requestedId);
    if (related) assert.equal(f.board.getSnapshot().detail.status, 'stale');
    else assert.deepEqual(f.board.getSnapshot().detail.value, selected);
    f.calls.ownSubmissions[1].resolve({ submissions: [result.successor] }); await pending;
    assert.equal(f.calls.detail.length, 2); assert.equal(f.board.getSnapshot().correctionReceipt.submissionId, 'submission-a');
  }
});

test('further correction uses only the latest current owned successor and leaves hidden predecessor identity unexpanded', async () => {
  const f = correctionFixture(); await own(f);
  const pending = f.board.correctSubmission('submission-a', submissionInput());
  const result = correctionResult(f.requests[0]); await correctionResponse(f, 0, result);
  const successor = { ...result.successor, revision: 8, canonicalFeatureId: 'new-merge-root' };
  f.calls.ownSubmissions[1].resolve({ submissions: [submission({ revision: 5, successorSubmissionId: successor.id }), successor] });
  await pending;
  await f.board.correctSubmission('submission-a', submissionInput()); assert.equal(f.requests.length, 1);
  const input = { ...submissionInput(), title: 'A further corrected timer' };
  const next = f.board.correctSubmission(successor.id, input);
  assert.equal(f.requests[1].url.endsWith('/submissions/successor-submission/correct'), true);
  assert.deepEqual(f.requests[1].body, { ...input, expectedRevision: 8, expectedCanonicalFeatureId: 'new-merge-root' });
  assert.equal(f.requests[1].key, 'intent-2');
  const nextResult = correctionResult(f.requests[1], successor);
  nextResult.receipt.eventId = 'second-event';
  nextResult.receipt.successor = { submissionId: 'third-submission', featureId: 'third-feature' };
  nextResult.successor = null;
  await correctionResponse(f, 1, nextResult);
  f.calls.ownSubmissions[2].resolve({ submissions: [] }); await next;
  assert.equal(f.board.getSnapshot().correction.status, 'saved');
  assert.equal(f.board.getSnapshot().correctionSuccessor, null); assert.equal(f.calls.detail.length, 0);
});

for (const ending of ['dispose', 'session']) {
  test(`${ending} clears correction authority and data, fences late transport acknowledgment and denies retries in another session`, async () => {
    const f = correctionFixture(); await own(f); await open(f);
    const pending = f.board.correctSubmission('submission-a', submissionInput());
    const read = f.board.loadOwnSubmissions();
    const notifications = f.state.notifications;
    if (ending === 'dispose') f.board.dispose(); else f.state.current = false;
    const ended = f.board.getSnapshot();
    assert.equal(ended.phase, 'ended'); assert.equal(ended.correction.status, 'unreconciled');
    assert.equal(ended.correctionReceipt, null); assert.equal(ended.correctionSuccessor, null);
    assert.equal(ended.ownSubmissions.value, null); assert.equal(ended.detail.value, null);
    await correctionResponse(f, 0, correctionResult(f.requests[0]));
    f.calls.ownSubmissions[1].resolve({ submissions: [submission()] }); await Promise.all([pending, read]);
    f.state.current = true;
    await f.board.retryUncertainCorrection(); await f.board.correctSubmission('submission-a', submissionInput());
    await f.board.loadOwnSubmissions();
    assert.equal(f.requests.length, 1); assert.equal(f.calls.ownSubmissions.length, 2);
    assert.equal(f.board.getSnapshot(), ended); assert.equal(f.state.notifications, notifications);
  });
}

test('correction receipt and successor are cleared when the session ends during its own-page refresh', async () => {
  const f = correctionFixture(); await own(f);
  const pending = f.board.correctSubmission('submission-a', submissionInput());
  await correctionResponse(f, 0, correctionResult(f.requests[0]));
  assert.equal(f.board.getSnapshot().correction.status, 'saved');
  assert.notEqual(f.board.getSnapshot().correctionReceipt, null);
  f.state.current = false; const ended = f.board.getSnapshot();
  assert.equal(ended.correctionReceipt, null); assert.equal(ended.correctionSuccessor, null);
  f.calls.ownSubmissions[1].resolve({ submissions: [submission()] }); await pending;
  assert.equal(f.board.getSnapshot(), ended); assert.equal(ended.correction.status, 'idle');
});

test('correction invalidates an earlier submitted projection without rewriting its original content', async () => {
  const f = correctionFixture(), original = submission();
  const submitted = f.board.submitRequest(submissionInput());
  f.calls.submit[0].resolve(original); await flush();
  f.calls.ownSubmissions[0].resolve({ submissions: [original] }); await submitted;
  assert.deepEqual(f.board.getSnapshot().submitted, original);
  const pending = f.board.correctSubmission(original.id, submissionInput());
  assert.equal(f.board.getSnapshot().submitted, original);
  const result = correctionResult(f.requests[0]); await correctionResponse(f, 0, result);
  assert.equal(f.board.getSnapshot().submitted, null);
  f.calls.ownSubmissions[1].resolve({ submissions: [result.successor] }); await pending;
  assert.equal(original.title, 'Original submission title'); assert.equal(original.revision, 4);
  assert.equal(f.calls.setVote.length, 0);
});

test('correction rejects accessors and non-plain replacement descriptors before calling getters or the real transport', async () => {
  const f = correctionFixture(); await own(f);
  let getterCalls = 0, pending;
  const accessor = submissionInput();
  Object.defineProperty(accessor, 'title', { enumerable: true, get() { getterCalls++; return 'Larger workout timer'; } });
  const hidden = submissionInput(); Object.defineProperty(hidden, 'title', { enumerable: false });
  const inherited = Object.assign(Object.create({ title: 'Inherited title' }), submissionInput());
  const missing = submissionInput(); delete missing.policyAccepted;
  try {
    for (const input of [accessor, hidden, inherited, missing, { ...submissionInput(), [Symbol('hidden')]: true },
      { ...submissionInput(), expectedRevision: 99 }, { ...submissionInput(), expectedCanonicalFeatureId: 'foreign' }]) {
      pending = f.board.correctSubmission('submission-a', input);
      assert.equal(getterCalls, 0); assert.equal(f.requests.length, 0);
      await pending;
      assert.equal(f.board.getSnapshot().correction.status, 'failed');
      assert.equal(f.board.getSnapshot().correction.error.code, 'board_invalid_input');
      assert.equal(f.board.getSnapshot().correctionReceipt, null);
      assert.equal(f.board.getSnapshot().correctionSuccessor, null);
      assert.equal(f.state.keys, 0);
    }
  } finally {
    for (const request of f.requests) request.reject(new Error('Synthetic request cleanup'));
    await pending?.catch(() => {});
    f.board.dispose();
  }
});
