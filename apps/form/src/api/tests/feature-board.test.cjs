const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), ts = require('typescript');
const root = path.resolve(__dirname, '../..'), cache = new Map();
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
const { FeatureBoardResources } = load('api/featureBoard.ts');
const { ApiError } = load('api/transport.ts');
function fixture(response = async () => ({})) {
  const calls = [], state = { current: true };
  const api = { async request(...args) { calls.push(args); return response(...args); } };
  return { calls, state, board: new FeatureBoardResources(api, () => state.current) };
}
const input = () => ({ title: 'Larger workout text', description: 'Please allow larger text in the workout timer.',
  category: 'accessibility', policyVersion: 'form_feature_board_v1', policyAccepted: true, audienceAccepted: true });

test('submission requires both explicit acknowledgments and rejects private authority fields before dispatch', () => {
  const f = fixture();
  for (const value of [{ ...input(), policyAccepted: false }, { ...input(), audienceAccepted: undefined },
    { ...input(), accountId: 'other-account' }, { ...input(), published: true }])
    assert.throws(() => f.board.submit(value, 'intent-1'), { code: 'board_invalid_input' });
  assert.equal(f.calls.length, 0);
});
test('the exact pending-submission contract is sent without automatic upvote or publication', async () => {
  const f = fixture(); const value = input();
  await f.board.submit(value, 'retained-intent');
  assert.deepEqual(f.calls[0], ['/v1/community/board/features', 'POST', value, 'retained-intent']);
  assert.equal('voteOnSubmit' in f.calls[0][2], false);
  assert.equal('visibility' in f.calls[0][2], false);
});
test('canonical feature vote SET uses feature revision and caller key; uncertainty is never replayed automatically', async () => {
  const error = new ApiError(0, 'network_unknown', 'Uncertain save', true);
  const f = fixture(async () => { throw error; });
  await assert.rejects(f.board.setVote('canonical-feature', true, 7, 'same-key'), error);
  assert.equal(f.calls.length, 1);
  await assert.rejects(f.board.setVote('canonical-feature', true, 7, 'same-key'), error);
  assert.deepEqual(f.calls[0], f.calls[1]);
  assert.deepEqual(f.calls[0], ['/v1/community/board/features/canonical-feature/vote', 'POST',
    { active: true, expectedRevision: 7 }, 'same-key']);
});
test('withdraw, report and own-only pagination use bounded accepted paths and fields', async () => {
  const f = fixture();
  await f.board.withdraw('submission-1', 3, 'withdraw-1');
  await f.board.report('feature-1', 'privacy', 'report-1');
  await f.board.ownSubmissions({ page: 2, pageSize: 10 });
  await f.board.ownVotes();
  assert.deepEqual(f.calls.map(c => c[0]), ['/v1/community/board/submissions/submission-1/withdraw',
    '/v1/community/board/features/feature-1/report', '/v1/community/board/me/submissions?page=2&pageSize=10',
    '/v1/community/board/me/votes']);
  assert.throws(() => f.board.ownVotes({ q: 'private text' }), { code: 'board_invalid_input' });
});
test('search encodes text as one parameter and rejects invalid path IDs, links and range overflow', async () => {
  const f = fixture();
  await f.board.browse({ q: 'larger text & labels', category: 'accessibility', sort: 'most_supported', pageSize: 50 });
  const url = new URL(f.calls[0][0], 'https://synthetic.invalid');
  assert.equal(url.searchParams.get('q'), 'larger text & labels');
  assert.equal(url.searchParams.size, 4);
  for (const query of [{ page: 201 }, { pageSize: 51 }, { q: 'https://synthetic.invalid' }, { accountId: 'other' }])
    assert.throws(() => f.board.browse(query), { code: 'board_invalid_input' });
  assert.throws(() => f.board.detail('../other'), { code: 'board_invalid_input' });
  assert.throws(() => f.board.setVote('feature', true, 0, 'key'), { code: 'board_invalid_input' });
});
test('an expired mounted account cannot dispatch board reads or writes', async () => {
  const f = fixture(); f.state.current = false;
  await assert.rejects(f.board.browse(), { code: 'session_changed' });
  await assert.rejects(f.board.submit(input(), 'old-intent'), { code: 'session_changed' });
  assert.equal(f.calls.length, 0);
});
test('late mutation cannot return another account data and retains original-effect uncertainty', async () => {
  let resolve;
  const f = fixture(() => new Promise(done => { resolve = done; }));
  const pending = f.board.setVote('feature', true, 1, 'old-key');
  f.state.current = false; resolve({ featureId: 'feature', active: true, revision: 2 });
  await assert.rejects(pending, error => error.code === 'session_changed' && error.originalEffectUnknown === true);
  assert.equal(f.calls.length, 1);
});
test('revision conflicts remain inspectable and late reads do not imply a mutation', async () => {
  const stale = new ApiError(409, 'stale_revision', 'Review the latest feature');
  const f = fixture(async () => { throw stale; });
  await assert.rejects(f.board.setVote('feature', true, 1, 'key'), stale);
  let resolve;
  const read = fixture(() => new Promise(done => { resolve = done; }));
  const pending = read.board.detail('feature'); read.state.current = false; resolve({ private: 'old account' });
  await assert.rejects(pending, error => error.code === 'session_changed' && !error.originalEffectUnknown);
});
test('route disposal denies retained callbacks even while the same account remains signed in', async () => {
  let resolve;
  const f = fixture(() => new Promise(done => { resolve = done; }));
  const pending = f.board.withdraw('submission', 1, 'old-withdraw');
  f.board.dispose(); resolve({ visibility: 'withdrawn' });
  await assert.rejects(pending, error => error.code === 'session_changed' && error.originalEffectUnknown);
  await assert.rejects(f.board.setVote('feature', false, 2, 'new-key'), { code: 'session_changed' });
  assert.equal(f.calls.length, 1);
});

const correctionInput = () => ({ ...input(), expectedRevision: 2, expectedCanonicalFeatureId: 'canonical-feature' });
function correctionResult(value = correctionInput(), key = 'correction-key') {
  const { expectedRevision, expectedCanonicalFeatureId, ...replacement } = value;
  const receipt = { schema: 'form.feature-board-correction/v1', key, eventId: 'event-1', submissionId: 'submission-1',
    featureId: 'original-feature', expectedRevision, resultRevision: expectedRevision + 1,
    canonicalFeatureId: expectedCanonicalFeatureId, canonicalRevision: 9,
    successor: { submissionId: 'successor-1', featureId: 'new-feature' }, replacement, createdAt: '2026-10-12T00:00:00.000Z' };
  return { receipt, successor: { id: 'successor-1', featureId: 'new-feature', canonicalFeatureId: 'new-feature',
    ...replacement, revision: 1, visibility: 'pending', createdAt: receipt.createdAt, predecessorSubmissionId: 'submission-1' } };
}
function validCorrection(value, key) {
  const result = correctionResult(value, key);
  for (const name of ['policyVersion', 'policyAccepted', 'audienceAccepted']) delete result.successor[name];
  return result;
}
test('correction captures exact intent and closed immutable receipt with fresh advanced successor', async () => {
  const value = correctionInput(), result = validCorrection(value, 'correction-key');
  result.successor.revision = 5; result.successor.visibility = 'withdrawn'; result.successor.successorSubmissionId = 'later-successor';
  const f = fixture(async () => result); const pending = f.board.correct('submission-1', value, 'correction-key');
  value.title = 'Mutation after dispatch'; const decoded = await pending;
  assert.deepEqual(f.calls[0].slice(0, 2), ['/v1/community/board/submissions/submission-1/correct', 'POST']);
  assert.equal(f.calls[0][2].title, input().title); assert.equal(f.calls[0][2].voteOnSubmit, undefined);
  assert.ok(Object.isFrozen(f.calls[0][2])); assert.ok(Object.isFrozen(decoded.receipt.replacement));
  assert.equal(decoded.successor.visibility, 'withdrawn'); assert.equal(decoded.receipt.resultRevision, 3);
  assert.notEqual(decoded.receipt, result.receipt);
});
test('correction rejects getters symbols mixed authority and invalid submission fences before dispatch', () => {
  const f = fixture(); let getters = 0;
  const accessor = { ...correctionInput() }; Object.defineProperty(accessor, 'title', { enumerable: true, get() { getters++; return input().title; } });
  for (const value of [accessor, { ...correctionInput(), [Symbol('hidden')]: true }, { ...correctionInput(), voteOnSubmit: false },
    { ...correctionInput(), expectedRevision: 0 }, { ...correctionInput(), expectedCanonicalFeatureId: '../bad' }, { ...correctionInput(), accountId: 'foreign' }])
    assert.throws(() => f.board.correct('submission-1', value, 'correction-key'), { code: 'board_invalid_input' });
  assert.equal(getters, 0); assert.equal(f.calls.length, 0);
});
test('malformed or nonmatching correction acknowledgement stays effect unknown without another dispatch', async () => {
  for (const corrupt of [r => { r.receipt.key = 'other'; }, r => { r.receipt.resultRevision = 2; },
    r => { r.receipt.replacement.title = 'Unrelated replacement'; }, r => { r.receipt.canonicalFeatureId = 'other'; },
    r => { r.successor.id = 'unrelated'; }, r => { r.receipt.extra = 'private'; }]) {
    const result = validCorrection(correctionInput(), 'correction-key'); corrupt(result); const f = fixture(async () => result);
    await assert.rejects(f.board.correct('submission-1', correctionInput(), 'correction-key'), error => error.code === 'board_correction_response_invalid' && error.effectUnknown);
    assert.equal(f.calls.length, 1);
  }
});
test('lost acknowledgement can explicitly retry unchanged intent and accept original receipt with no successor', async () => {
  let attempts = 0; const result = validCorrection(correctionInput(), 'correction-key'); result.successor = null;
  const f = fixture(async () => { if (++attempts === 1) throw new ApiError(0, 'network_unknown', 'Lost', true); return result; });
  await assert.rejects(f.board.correct('submission-1', correctionInput(), 'correction-key'), error => error.effectUnknown);
  const decoded = await f.board.correct('submission-1', correctionInput(), 'correction-key');
  assert.deepEqual(f.calls[0], f.calls[1]); assert.equal(decoded.successor, null); assert.equal(decoded.receipt.key, 'correction-key');
});
test('late correction acknowledgement after disposal retains original uncertainty without exposing receipt', async () => {
  let resolve; const f = fixture(() => new Promise(done => { resolve = done; }));
  const pending = f.board.correct('submission-1', correctionInput(), 'correction-key');
  f.board.dispose(); resolve(validCorrection(correctionInput(), 'correction-key'));
  await assert.rejects(pending, error => error.code === 'session_changed' && error.originalEffectUnknown);
  assert.equal(f.calls.length, 1);
});
