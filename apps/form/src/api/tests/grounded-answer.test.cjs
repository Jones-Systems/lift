const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), { pathToFileURL } = require('node:url');
const { createHash } = require('node:crypto'), ts = require('typescript');
function load(file, imports = {}) {
  const module = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../' + file + '.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function('require', 'module', 'exports', code)(name => {
    assert.ok(Object.hasOwn(imports, name), 'Unexpected runtime dependency: ' + name); return imports[name];
  }, module, module.exports);
  return module.exports;
}
const transport = load('transport'), { FormTransport } = transport;
const { createGroundedAnswerCaller, decodeGroundedAnswer } = load('groundedAnswer', { './transport': transport });
const root = path.resolve(__dirname, '../../../../..');
const digest = '8fcb4cd3ac9a1edf1140fb591b731e74172095a7b534d758fb5f8d30d027de10';
function declaration() {
  const bytes = fs.readFileSync(path.join(root, 'docs/knowledge/research-followups/output-declaration.json'));
  assert.equal(bytes.length, 2458);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), '516d6f009fedec71633e564d97c4308dab7bb61b739bd03fe3911f501aa00066');
  return JSON.parse(bytes);
}
const artifact = () => fs.readFileSync(path.join(root, 'services/api/dist/grounding', digest, 'projection.json'));
const native = name => import(pathToFileURL(path.join(root, 'services/api/dist/src', name + '.js')).href);
const expectedSource = { repository: 'Jones-Systems/Form', revision: '0c68e72727f04a7307407a4a6b73d43b7dca61a6',
  corpusRoot: 'docs/knowledge/research-followups', corpusInputSha256: 'd2e4403c99d91d8069d5a124a3ad0e9c9008c669f04f7d1cff8982799b884971' };
const context = () => ({ revision: 'context:1', facts: [{ id: 'walking', text: 'I walk regularly.', origin: 'user_provided' }], supersedesRevision: null });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
async function answer(question = 'ANA-S13', facts = context()) {
  const { createGroundedAnswerHost } = await native('integration/grounded-answer');
  const nativeAnswer = createGroundedAnswerHost({ projectionBytes: artifact() }).answer({ accountId: 'synthetic', authUserId: 'synthetic', sessionId: 'synthetic', epoch: 0 },
    { retrieval: { query: question }, context: facts }, () => {});
  return JSON.parse(JSON.stringify(nativeAnswer));
}
function scope(api) {
  let current = true, contextRevision = 'context:1', requestGeneration = 1;
  const dependencies = { api, accountId: 'original', sessionGeneration: 'shell:1', isCurrentSession: (account, generation) => current && account === 'original' && generation === 'shell:1',
    captureRequest() { const original = requestGeneration; return { isCurrent: () => requestGeneration === original }; },
    captureContext(value) { const original = value.revision; return { isCurrent: () => contextRevision === original }; } };
  return { dependencies, correction: () => { contextRevision = 'context:2'; }, requestChanged: () => { requestGeneration++; }, sessionChanged: () => { current = false; } };
}
function pendingFixture() {
  const calls = [], next = deferred(); let auth = true;
  const api = { captureAuthContext: () => ({ isCurrent: () => auth }), request(...args) { calls.push(args); return next.promise; } };
  const current = scope(api), caller = createGroundedAnswerCaller(current.dependencies);
  return { ...current, caller, calls, next, authChanged: () => { auth = false; } };
}
async function actual(run, configured = true) {
  const { createServer } = await native('server');
  const parent = path.join(root, 'apps/form/.scratch'); fs.mkdirSync(parent, { recursive: true });
  const scratch = fs.mkdtempSync(path.join(parent, 'grounded-answer-'));
  let server, acquisition, disposal, stopped = false;
  const dispose = () => { stopped = true; return disposal ??= (async () => {
    try { server ??= await acquisition; await server?.close(); }
    finally { fs.rmSync(scratch, { recursive: true, force: true }); }
  })(); };
  const interrupt = () => { void dispose().finally(() => process.exit(130)); }, terminate = () => { void dispose().finally(() => process.exit(143)); };
  process.once('SIGINT', interrupt); process.once('SIGTERM', terminate);
  try {
    const origin = 'http://127.0.0.1:47932', calls = [];
    let answerDelay;
    acquisition = createServer({ dbPath: path.join(scratch, 'durable.sqlite'), baseURL: origin,
      secret: 'synthetic-grounded-answer-app-secret-over-32-characters', registration: { mode: 'allowlist', emails: ['one@synthetic.invalid'] },
      ...(configured ? { sourceGroundedAnswers: { projectionBytes: artifact() } } : {}) });
    server = await acquisition; assert.equal(stopped, false);
    const fetcher = async (url, init) => {
      if (url.endsWith('/v1/grounded-answers')) calls.push(JSON.parse(init.body));
      const response = await server.handleRequest(new Request(url, init), '192.0.2.32');
      if (url.endsWith('/v1/grounded-answers') && answerDelay) await answerDelay();
      return response;
    };
    const api = new FormTransport(origin, { async load() { return null; }, async save() {}, async clear() {} }, fetcher);
    await api.signUp('One', 'one@synthetic.invalid', 'Synthetic-grounded-password-12345');
    const me = await api.request('/v1/me');
    const current = scope(api); current.dependencies.accountId = me.accountId;
    current.dependencies.isCurrentSession = (id, generation) => id === me.accountId && generation === 'shell:1';
    const caller = createGroundedAnswerCaller(current.dependencies);
    await run({ api, caller, calls, current, delayAnswers: delay => { answerDelay = delay; } });
  } finally {
    try { await dispose(); }
    finally { process.off('SIGINT', interrupt); process.off('SIGTERM', terminate); }
    assert.equal(fs.existsSync(scratch), false);
  }
}

test('portable decoder retains complete authentic Form observations and independent fixed provenance', async () => {
  const bytes = artifact(); assert.equal(bytes.length, 80588); assert.equal(createHash('sha256').update(bytes).digest('hex'), digest);
  const declared = declaration(), expected = JSON.parse(bytes);
  assert.equal(declared.projection.sha256, digest); assert.equal(declared.projection.bytes, bytes.length); assert.deepEqual(declared.source, expectedSource);
  const result = decodeGroundedAnswer(await answer('source_observation'), 'source_observation', context());
  assert.deepEqual(result.statements.map(statement => statement.id), declared.expected.observation_ids.slice(0, 20));
  assert.equal(result.evidence.totalMatches, 26);
  assert.equal(result.evidence.limit, 20); assert.equal(result.evidence.truncated, true);
  assert.equal(result.evidence.observations.length, 20); assert.equal(result.options.length, 20);
  assert.equal(result.statements.at(-1).id, 'HLT-S20');
  assert.deepEqual(result.evidence.coverage.units.filter(unit => unit.state === 'partial').map(unit => unit.unit_id).sort(), declared.expected.partial_units);
  assert.equal(result.evidence.corpusStatus.units_without_observations.length, declared.expected.units_without_observations);
  for (const statement of result.statements) assert.deepEqual(statement.citation, expected.records.find(entry => entry.record.id === statement.id));
  assert.deepEqual(result.evidence.source, expectedSource);
  assert.deepEqual(result.statements.find(statement => statement.id === 'ANA-S13').citation, expected.records.find(entry => entry.record.id === 'ANA-S13'));
  assert.deepEqual(result.evidence.coverage, expected.coverage); assert.deepEqual(result.evidence.corpusStatus, expected.corpus_status);
  assert.equal(Object.isFrozen(result.statements[0].citation.record), true);
});

test('decoder preserves authentic FLE qualifications, packet locations and unresolved self-conflicts', async () => {
  const expected = JSON.parse(artifact());
  const result = decodeGroundedAnswer(await answer('source_observation'), 'source_observation', context());
  const fle = result.statements.filter(statement => statement.id.startsWith('FLE-'));
  assert.deepEqual(fle.map(statement => statement.id), ['FLE-S01', 'FLE-S02', 'FLE-S03', 'FLE-S04', 'FLE-S05']);
  assert.deepEqual(fle.map(statement => statement.citation.line), [5, 35, 65, 93, 123]);
  for (const statement of fle) {
    assert.deepEqual(statement.citation, expected.records.find(entry => entry.record.id === statement.id));
    assert.equal(statement.citation.source_path, 'sources/stretch-rom-008.md');
    assert.equal(statement.citation.source_packet_sha256, '91bfca77d93d13317819b0a601cb71572f27eb12904ed6228faab836618e59cd');
    assert.deepEqual(statement.citation.record.topic_ids, ['EXU-B5', 'DOS-E1']);
    assert.equal(statement.citation.record.clinical_readiness, 'CL-0');
    assert.equal(statement.originalPassageVerified, false);
  }
  assert.equal(fle[4].citation.record.access_level, 'abstract');
  assert.equal(fle[4].citation.record.form_appraisal, 'unknown; unadopted; mention-only');
  assert.equal(fle[4].citation.record.rights_status, 'unknown; no full-text copying or rights activation');
  assert.deepEqual(result.conflicts, ['FLE-S01', 'FLE-S02', 'FLE-S04'].map(id => ({
    observationId: id, conflictingObservationId: id, referencedObservationIncluded: true, disposition: 'unresolved',
  })));
  const single = decodeGroundedAnswer(await answer('FLE-S05'), 'FLE-S05', context());
  assert.equal(single.evidence.totalMatches, 1); assert.equal(single.evidence.truncated, false);
  assert.deepEqual(single.statements.map(statement => statement.id), ['FLE-S05']);
});

test('closed decoder rejects nested qualifier, citation, source, conflict, missingness and choice corruption', async () => {
  const original = await answer('source_observation');
  assert.notEqual(original.statements[0].citation, original.evidence.observations[0]);
  assert.notEqual(original.statements[0].citation.record, original.evidence.observations[0].record);
  const mutations = [
    value => { value.evidence.source.repository = 'BusinessLessons'; },
    value => { value.evidence.source.revision = '0'.repeat(40); },
    value => { value.evidence.source.corpusInputSha256 = '0'.repeat(64); },
    value => { delete value.evidence.observations[0].record.form_appraisal; },
    value => { value.evidence.observations[0].source_packet_sha256 = 'unverified'; },
    value => { value.evidence.observations[0].source_path = '../foreign.md'; },
    value => { value.evidence.observations[0].record.clinical_readiness = 'CL-1'; },
    value => { value.statements[0].citation.record.applicability = 'Applicable'; assert.deepEqual(value.evidence, original.evidence); },
    value => { value.statements[0].citation.record.rights_status = 'Cleared'; assert.deepEqual(value.evidence, original.evidence); },
    value => { value.statements[0].originalPassageVerified = true; },
    value => { value.evidence.coverage.units[0].state = 'validated'; },
    value => { delete value.evidence.corpusStatus.units_without_observations; },
    value => { value.evidence.corpusStatus.units_without_observations.pop(); },
    value => { value.evidence.totalMatches++; },
    value => { value.evidence.totalMatches = 12; },
    value => { value.evidence.source.revision = 'd95ecc2c377680d77f8398bf3f30d7b47b42b13f'; value.evidence.source.corpusInputSha256 = '71893a14fca04018e960b908739dfcd6ce9a98e7ae11572e4460a7f0cf65cda0'; },
    value => { value.evidence.source.revision = '5a9290a4abca53e5391740f7d9e6d9ff12a6f808'; value.evidence.source.corpusInputSha256 = '2dae077c78ab1a1003522dc7fd61100f6ba12ceff1cbeee79ac34ad8f987dac8'; },
    value => { value.evidence.truncated = false; },
    value => { value.evidence.totalMatches = 20; },
    value => { value.evidence.observations.pop(); value.statements.pop(); value.options.pop(); },
    value => { value.statements.push(...value.statements.slice(0, 5)); },
    value => { value.options.push(...value.options.slice(0, 5)); },
    value => { value.evidence.observations[1].record.id = value.evidence.observations[0].record.id; },
    value => { value.evidence.observations[0].record.id = 'ANA-S99'; },
    value => { value.conflicts[0].disposition = 'resolved'; },
    value => { value.conflicts.pop(); },
    value => { value.conflicts[0].referencedObservationIncluded = false; },
    value => { value.statements.find(statement => statement.id === 'FLE-S05').citation.record.form_appraisal = 'Adopted'; },
    value => { value.conflicts.push({ observationId: 'ANA-S10', conflictingObservationId: 'ANA-S11', referencedObservationIncluded: true, disposition: 'resolved' }); },
    value => { value.context.facts[0].origin = 'clinician'; },
    value => { value.options[0].adoption = 'applied'; },
    value => { value.choice.automaticAdoption = true; },
    value => { value.unchecked = {}; },
  ];
  for (const mutate of mutations) {
    const value = structuredClone(original); mutate(value);
    assert.throws(() => decodeGroundedAnswer(value, 'source_observation', context()), error => error.code === 'grounded_answer_invalid');
  }
});

test('actual route to captured FormTransport caller forwards literal questions and selects current citation without retrieval', async () => actual(async ({ caller, calls }) => {
  const question = '  ANA-S13  ', submitted = context();
  const pending = caller.ask(question, submitted); submitted.facts[0].text = 'Changed after dispatch';
  const result = await pending; assert.equal(result.status, 'ready'); assert.equal(result.answer.evidence.query, question);
  assert.deepEqual(calls, [{ retrieval: { query: question }, context: context() }]);
  const citation = caller.selectCitation('ANA-S13'); assert.deepEqual(citation, result.answer.statements.find(statement => statement.id === 'ANA-S13'));
  assert.equal(calls.length, 1); assert.equal(caller.selectCitation('unknown'), null); assert.equal(calls.length, 1);
  const natural = 'What does this mean for my uniquely unspecified training situation?';
  const gap = await caller.ask(natural, context()); assert.equal(gap.status, 'ready'); assert.equal(gap.answer.status, 'gap');
  assert.equal(gap.answer.evidence.query, natural); assert.equal(gap.answer.evidence.totalMatches, 0);
  assert.equal(gap.answer.evidence.truncated, false); assert.deepEqual(gap.answer.options, []); assert.equal(caller.selectCitation('ANA-S13'), null);
  const full = await caller.ask('source_observation', context()); assert.equal(full.status, 'ready');
  assert.deepEqual(full.answer.statements.map(statement => statement.id), declaration().expected.observation_ids.slice(0, 20));
  assert.equal(full.answer.evidence.totalMatches, 26); assert.equal(full.answer.evidence.truncated, true);
  for (const id of ['BCM-S09', 'BCM-S10', 'BEH-S14', 'FLE-S05', 'HLT-S20']) assert.equal(caller.selectCitation(id).id, id);
  assert.equal(caller.selectCitation('HLT-S24'), null); assert.equal(caller.selectCitation('HLT-S25'), null);
  assert.equal(calls.length, 3);
  const explicit = await caller.ask('HLT-S24', context()); assert.equal(explicit.status, 'ready');
  assert.equal(calls.length, 4); assert.deepEqual(calls[3], { retrieval: { query: 'HLT-S24' }, context: context() });
  assert.deepEqual(caller.selectCitation('HLT-S24').citation, JSON.parse(artifact()).records.find(entry => entry.record.id === 'HLT-S24'));
  assert.deepEqual(caller.selectCitation('HLT-S24').citation.record.topic_ids, ['HLT-Y1', 'EXU-B4']);
  assert.equal(calls.length, 4);
}));

test('actual unconfigured route produces unavailable with no retry or synthetic answer', async () => actual(async ({ caller, calls }) => {
  const result = await caller.ask('ANA-S13', context()); assert.equal(result.status, 'unavailable');
  assert.equal(result.code, 'grounded_answer_unavailable'); assert.equal(result.answer, null); assert.equal(calls.length, 1);
}, false));

test('correction hides a delivered answer and its citation immediately', async () => actual(async ({ caller, current, calls }) => {
  assert.equal((await caller.ask('ANA-S13', context())).status, 'ready'); current.correction();
  assert.equal(caller.getSnapshot().status, 'stale'); assert.equal(caller.selectCitation('ANA-S13'), null); assert.equal(calls.length, 1);
}));

test('correction, original auth, session and request changes fence late success and error without replay', async () => {
  for (const change of ['correction', 'authChanged', 'sessionChanged', 'requestChanged']) for (const outcome of ['success', 'error']) {
    const f = pendingFixture(), pending = f.caller.ask('ANA-S13', context()); f[change]();
    assert.equal(f.caller.getSnapshot().answer, null);
    if (outcome === 'success') f.next.resolve(await answer()); else f.next.reject(new Error('Old response'));
    assert.equal((await pending).answer, null); assert.equal(f.caller.selectCitation('ANA-S13'), null); assert.equal(f.calls.length, 1);
  }
});

test('same-account real transport auth intent invalidates an already accepted answer', async () => actual(async ({ api, caller, calls }) => {
  assert.equal((await caller.ask('ANA-S13', context())).status, 'ready');
  await api.signIn('one@synthetic.invalid', 'Synthetic-grounded-password-12345');
  assert.equal(caller.getSnapshot().status, 'stale'); assert.equal(caller.selectCitation('ANA-S13'), null);
  assert.equal((await caller.ask('ANA-S13', context())).status, 'stale'); assert.equal(calls.length, 1);
}));

test('missing or unproved context witness is unavailable before dispatch', async () => {
  for (const captureContext of [undefined, () => undefined, () => ({ isCurrent: () => false }), () => ({ isCurrent: () => Promise.resolve(true) })]) {
    const f = pendingFixture(); const caller = createGroundedAnswerCaller({ ...f.dependencies, captureContext });
    assert.equal((await caller.ask('ANA-S13', context())).status, 'unavailable'); assert.equal(f.calls.length, 0);
  }
});

test('explicit invalidate and disposal prevent late publication and keep citation empty', async () => {
  for (const operation of ['invalidate', 'dispose']) {
    const f = pendingFixture(), pending = f.caller.ask('ANA-S13', context()); f.caller[operation](); f.next.resolve(await answer());
    assert.equal((await pending).answer, null); assert.equal(f.caller.getSnapshot().answer, null); assert.equal(f.caller.selectCitation('ANA-S13'), null);
  }
});

test('new requests hide old public state and a superseded response cannot overwrite the accepted answer', async () => {
  const first = deferred(), second = deferred(); let calls = 0;
  const current = scope({ captureAuthContext: () => ({ isCurrent: () => true }), request() { return ++calls === 1 ? first.promise : second.promise; } });
  const caller = createGroundedAnswerCaller(current.dependencies);
  const old = caller.ask('ANA-S13', context()), next = caller.ask('HLT-S16', context());
  assert.equal(caller.getSnapshot().status, 'pending'); assert.equal(caller.selectCitation('ANA-S13'), null);
  second.resolve(await answer('HLT-S16')); assert.equal((await next).status, 'ready');
  first.resolve(await answer()); assert.equal((await old).status, 'stale');
  assert.equal(caller.getSnapshot().answer.evidence.query, 'HLT-S16'); assert.equal(calls, 2);
});


test('same-account auth replacement fences a real route response awaiting app delivery', async () => actual(async ({ api, caller, calls, delayAnswers }) => {
  const ready = deferred(), release = deferred();
  delayAnswers(async () => { ready.resolve(); await release.promise; });
  const pending = caller.ask('ANA-S13', context());
  try {
    await ready.promise;
    await api.signIn('one@synthetic.invalid', 'Synthetic-grounded-password-12345');
    assert.equal(caller.getSnapshot().answer, null); release.resolve();
    assert.equal((await pending).answer, null); assert.equal(caller.selectCitation('ANA-S13'), null);
    assert.equal(calls.length, 1);
  } finally { release.resolve(); await pending; }
}));

test('malformed response stays unavailable without retry or citation leakage', async () => {
  const f = pendingFixture(), pending = f.caller.ask('ANA-S13', context());
  const original = await answer(), value = structuredClone(original);
  assert.notEqual(value.statements[0].citation, value.evidence.observations[0]);
  assert.notEqual(value.statements[0].citation.record, value.evidence.observations[0].record);
  value.statements[0].citation.record.rights_status = 'Granted';
  assert.deepEqual(value.evidence, original.evidence);
  f.next.resolve(value);
  const result = await pending; assert.equal(result.status, 'unavailable'); assert.equal(result.code, 'grounded_answer_invalid');
  assert.equal(f.caller.selectCitation('ANA-S13'), null); assert.equal(f.calls.length, 1);
});

test('fixed successor wire is admitted by the APP reader', async () => {
  const successorDigest = '8fcb4cd3ac9a1edf1140fb591b731e74172095a7b534d758fb5f8d30d027de10';
  const successorSource = { repository: 'Jones-Systems/Form', revision: '0c68e72727f04a7307407a4a6b73d43b7dca61a6',
    corpusRoot: 'docs/knowledge/research-followups', corpusInputSha256: 'd2e4403c99d91d8069d5a124a3ad0e9c9008c669f04f7d1cff8982799b884971' };
  const declaredBytes = fs.readFileSync(path.join(root, 'docs/knowledge/research-followups/output-declaration.json'));
  assert.equal(declaredBytes.length, 2458);
  assert.equal(createHash('sha256').update(declaredBytes).digest('hex'), '516d6f009fedec71633e564d97c4308dab7bb61b739bd03fe3911f501aa00066');
  const declared = JSON.parse(declaredBytes);
  assert.deepEqual(declared.source, successorSource); assert.equal(declared.projection.sha256, successorDigest);
  assert.equal(declared.projection.bytes, 80588); assert.equal(declared.expected.observation_ids.length, 26);
  assert.equal(declared.expected.observation_ids.at(-1), 'NUT-S034');
  const bytes = fs.readFileSync(path.join(root, 'services/api/dist/grounding', successorDigest, 'projection.json'));
  assert.equal(bytes.length, 80588); assert.equal(createHash('sha256').update(bytes).digest('hex'), successorDigest);
  const [{ createGroundedAnswerHost }, { proteinOriginal, proteinCoverage, proteinCorpusStatus }] = await Promise.all([
    native('integration/grounded-answer'), native('../tests/grounding/evaluation/form-nutrition-oracle'),
  ]);
  const host = createGroundedAnswerHost({ projectionBytes: bytes });
  const actor = { accountId: 'synthetic', authUserId: 'synthetic', sessionId: 'synthetic', epoch: 0 };
  const wire = question => JSON.parse(JSON.stringify(host.answer(actor,
    { retrieval: { query: question }, context: context() }, original => assert.deepEqual(original, actor))));
  const all = wire('source_observation'), nutrition = wire('NUT-S034');
  assert.deepEqual(all.evidence.source, successorSource); assert.equal(all.evidence.totalMatches, 26);
  assert.deepEqual(all.statements.map(statement => statement.id), declared.expected.observation_ids.slice(0, 20));
  assert.deepEqual(all.evidence.coverage, proteinCoverage); assert.deepEqual(all.evidence.corpusStatus, proteinCorpusStatus);
  assert.equal(nutrition.evidence.totalMatches, 1); assert.deepEqual(nutrition.evidence.observations, [proteinOriginal]);
  assert.deepEqual(nutrition.statements, [{ id: 'NUT-S034', evidenceKind: 'retained_source_observation',
    text: proteinOriginal.record.summary, citation: proteinOriginal, originalPassageVerified: false }]);
  assert.equal(nutrition.statements[0].citation.record.clinical_readiness, 'CL-0');
  assert.equal(nutrition.options[0].adoption, 'not_applied'); assert.equal(nutrition.choice.automaticAdoption, false);
  const decoded = decodeGroundedAnswer(all, 'source_observation', context());
  assert.equal(decoded.evidence.totalMatches, 26); assert.deepEqual(decoded.evidence.source, successorSource);
  const decodedNutrition = decodeGroundedAnswer(nutrition, 'NUT-S034', context());
  assert.deepEqual(decodedNutrition.statements[0].citation, proteinOriginal);
});

test('synthetic stale source pins and foreign observation IDs remain rejected by the successor reader', async () => {
  const original = await answer('NUT-S034');
  const oldRevision = '708fd809fc532084c937d833d38c9b56a057aa57';
  const oldInput = '78c041aa7ed12330258daad4e0cb2cd05c4240c854d889cf12845437cfb0b043';
  // These mutations are negative fixtures, not authenticated historical responses.
  for (const mutate of [
    value => { value.evidence.source.revision = oldRevision; },
    value => { value.evidence.source.corpusInputSha256 = oldInput; },
    value => { value.evidence.source.revision = oldRevision; value.evidence.source.corpusInputSha256 = oldInput; },
  ]) {
    const value = structuredClone(original); mutate(value);
    assert.throws(() => decodeGroundedAnswer(value, 'NUT-S034', context()), { code: 'grounded_answer_invalid' });
  }
  for (const id of ['NUT-S34', 'NUT-S035', 'ZZZ-S034']) {
    const value = structuredClone(original);
    value.evidence.observations[0].record.id = id;
    value.statements[0].id = id; value.statements[0].citation.record.id = id;
    value.options[0].id = id; value.options[0].statementId = id;
    assert.throws(() => decodeGroundedAnswer(value, 'NUT-S034', context()), { code: 'grounded_answer_invalid' });
  }
});

test('actual protein answer preserves the independent observation and correction hides its citation before an uncovered gap', async () => actual(async ({ caller, current, calls }) => {
  const { proteinOriginal } = await native('../tests/grounding/evaluation/form-nutrition-oracle');
  const result = await caller.ask('protein', context());
  assert.equal(result.status, 'ready'); assert.equal(result.answer.status, 'informative');
  const selected = caller.selectCitation('NUT-S034'); assert.ok(selected);
  assert.deepEqual(selected.citation, proteinOriginal); assert.equal(selected.originalPassageVerified, false);
  assert.equal(result.answer.evidence.clinicalReadiness, 'CL-0'); assert.equal(result.answer.evidence.verbatimPassagesAvailable, false);
  assert.equal(result.answer.choice.automaticAdoption, false); assert.ok(result.answer.options.every(option => option.adoption === 'not_applied'));
  assert.equal(calls.length, 1); assert.deepEqual(calls[0], { retrieval: { query: 'protein' }, context: context() });
  current.correction();
  assert.equal(caller.getSnapshot().status, 'stale'); assert.equal(caller.selectCitation('NUT-S034'), null); assert.equal(calls.length, 1);
  const corrected = { ...context(), revision: 'context:2', supersedesRevision: 'context:1' };
  const question = 'How should I distribute protein across breakfast and dinner?';
  const gap = await caller.ask(question, corrected);
  assert.equal(gap.status, 'ready'); assert.equal(gap.answer.status, 'gap'); assert.equal(gap.answer.evidence.totalMatches, 0);
  assert.equal(gap.answer.evidence.query, question); assert.deepEqual(gap.answer.context, corrected);
  assert.deepEqual(gap.answer.statements, []); assert.deepEqual(gap.answer.options, []);
  assert.equal(caller.selectCitation('NUT-S034'), null); assert.equal(calls.length, 2);
  assert.deepEqual(calls[1], { retrieval: { query: question }, context: corrected });
}));
