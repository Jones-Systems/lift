const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), ts = require('typescript');
const appFile = path.resolve(__dirname, '../nutritionConversation.ts');
const wireFile = path.resolve(__dirname, '../../../../../services/api/src/integration/nutrition-conversation/wire.ts');
const source = fs.readFileSync(appFile, 'utf8');
const moduleUnderTest = { exports: {} };
new Function('require', 'module', 'exports', ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText)(name => { throw new Error(`Unexpected runtime dependency: ${name}`); }, moduleUnderTest, moduleUnderTest.exports);
const { createNutritionConversation, nutritionWireSchema } = moduleUnderTest.exports;
const id = number => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const empty = { conversation: { turns: [], rejectedChoices: [], currentTurnId: null, currentExplanation: null,
  automaticAdoption: 'none' }, selections: [], currentSelection: null };
const answer = { conversation: { turns: [{ id: 1, input: { question: 'Unchanged question', userContext: ['Original context'], correction: null },
  sources: { qualifications: ['Retained limitation'], gaps: [{ code: 'policy-unavailable' }], adviceAuthority: 'none' },
  explanation: { statements: [{ id: 'statement-one', citation: { locator: 'synthetic-source', qualifications: ['Not individualized'] } }],
    conflicts: [{ disposition: 'unresolved' }], contextUse: 'acknowledged_not_applicability_assessed' } }],
  rejectedChoices: [], currentTurnId: 1, currentExplanation: { qualification: 'Unchanged synthetic explanation' }, automaticAdoption: 'none' },
  selections: [], currentSelection: null };
const selected = { ...answer, selections: [{ status: 'selected', statementId: 'statement-one', qualifications: ['Retained limitation'] }],
  currentSelection: { statementId: 'statement-one', conflicts: [{ disposition: 'unresolved' }] } };
const rejected = { ...selected, conversation: { ...selected.conversation, rejectedChoices: [{ reason: 'stale-nutrition-turn' }] } };
// Exact synthetic fixture equality tests transport custody, not native producer-state qualification.
const validation = {
  isComplete: value => [empty, answer, selected, rejected].some(fixture => JSON.stringify(value) === JSON.stringify(fixture)),
  isFreshEmpty: value => JSON.stringify(value) === JSON.stringify(empty),
};
const input = { choice: 'ask', previousTurnId: null, job: 'protein', question: '  Preserve this question  ', userContext: ['Owner context'], correction: null };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function response(call, state = empty, extra = {}) {
  const operation = call.path.endsWith('/reset-fresh-empty') ? 'resetFreshEmpty'
    : call.path.endsWith('/select-citation') ? 'selectCitation' : call.path.split('/').at(-1);
  return { schema: nutritionWireSchema, requestId: call.body.requestId, operation,
    status: operation === 'resetFreshEmpty' ? 'reset' : 'ok', code: null,
    binding: { id: operation === 'resetFreshEmpty' ? id(100) : call.path.split('/').at(-2), expiresAt: '2030-01-01T00:00:00.000Z' },
    stateVersion: operation === 'resetFreshEmpty' ? 1 : 2, state, resetRequired: false, ...extra };
}
function fixture(options = {}) {
  let generation = 1, account = 'account-one', session = 'session-one', requestCurrent = true;
  let issued = 0, handler = call => response(call), now = Date.parse('2026-10-11T00:00:00.000Z');
  const calls = [];
  const dependencies = { accountId: account, sessionGeneration: session,
    api: { captureAuthContext() { const captured = generation; return { isCurrent: () => captured === generation }; },
      async request(path, method, body, key) { const call = { path, method, body, key }; calls.push(call); return handler(call); } },
    isCurrentSession: (originalAccount, originalSession) => originalAccount === account && originalSession === session,
    captureRequest: () => ({ isCurrent: () => requestCurrent }), newRequestId: () => id(++issued), stateValidation: validation,
    now: () => now, ...options };
  const client = createNutritionConversation(dependencies);
  return { client, calls, dependencies, handle: next => { handler = next; }, issued: () => issued,
    changeAuth: () => { generation++; }, changeAccount: () => { account = 'account-two'; }, changeSession: () => { session = 'session-two'; },
    expireRequest: () => { requestCurrent = false; }, expireBinding: () => { now = Date.parse('2031-01-01T00:00:00.000Z'); } };
}
const hidden = value => { assert.equal(value.state, null); assert.equal(value.binding, null); assert.equal(value.stateVersion, null); assert.equal(value.resetRequired, true); };

test('mirrored protocol unions and response fields match the API wire without a backend runtime import', () => {
  const native = ts.createSourceFile('wire.ts', fs.readFileSync(wireFile, 'utf8'), ts.ScriptTarget.Latest, true);
  const app = ts.createSourceFile('app.ts', source, ts.ScriptTarget.Latest, true);
  const declaration = (file, name) => file.statements.find(node => ts.isTypeAliasDeclaration(node) && node.name.text === name);
  const literals = node => { const values = []; const visit = child => {
    if (ts.isLiteralTypeNode(child) && ts.isStringLiteral(child.literal)) values.push(child.literal.text);
    ts.forEachChild(child, visit);
  }; visit(node); return values.sort(); };
  for (const name of ['NutritionWireOperation', 'NutritionWireStatus', 'NutritionWireCode']) {
    assert.deepEqual(literals(declaration(app, name)), literals(declaration(native, name)), name);
  }
  const members = node => { const keys = []; const visit = child => {
    if (ts.isPropertySignature(child)) keys.push(child.name.getText()); ts.forEachChild(child, visit);
  }; visit(node); return keys.sort(); };
  for (const name of ['NutritionWireBinding', 'NutritionWireResponse']) {
    assert.deepEqual(members(declaration(app, name)), members(declaration(native, name)), name);
  }
  const inputType = declaration(app, 'NutritionConversationInput');
  const inputLiterals = property => literals(inputType.type.typeArguments[0].members.find(member => member.name.text === property));
  const nativeInput = native.statements.find(node => ts.isVariableStatement(node) &&
    node.declarationList.declarations.some(item => item.name.getText() === 'nutritionInput'));
  const nativeEnums = new Map();
  const findEnums = node => {
    if (ts.isPropertyAssignment(node) && ['choice', 'job'].includes(node.name.getText())) {
      nativeEnums.set(node.name.getText(), node.initializer.arguments[0].elements.map(item => item.text).sort());
    }
    ts.forEachChild(node, findEnums);
  };
  findEnums(nativeInput);
  for (const property of ['choice', 'job']) assert.deepEqual(inputLiterals(property), nativeEnums.get(property), property);
  assert.match(fs.readFileSync(wireFile, 'utf8'), /nutritionWireSchema = 'form\.nutrition-conversation-wire\/v1'/);
});

test('missing complete-state validator is unavailable without dispatch or key consumption', async () => {
  const f = fixture({ stateValidation: undefined });
  hidden(await f.client.resetFreshEmpty()); hidden(await f.client.submit(input));
  assert.equal(f.client.getSnapshot().code, 'validation_unavailable');
  assert.equal(f.calls.length, 0); assert.equal(f.issued(), 0);
});

test('missing request ownership or malformed validation ports remain unavailable without transport effects', async () => {
  for (const options of [{ captureRequest: undefined }, { stateValidation: { isComplete: true, isFreshEmpty: () => true } }]) {
    const f = fixture(options); hidden(await f.client.resetFreshEmpty());
    assert.equal(f.calls.length, 0); assert.equal(f.issued(), 0);
  }
});

test('reset confirms exact fresh EMPTY at version one and bodies contain no actor selectors or replay key', async () => {
  const f = fixture();
  hidden(await f.client.snapshot()); assert.equal(f.calls.length, 0);
  const result = await f.client.resetFreshEmpty();
  assert.equal(result.status, 'reset'); assert.equal(result.resetRequired, false); assert.deepEqual(result.state, empty);
  assert.equal(result.stateVersion, 1);
  assert.deepEqual(f.calls, [{ path: '/v1/nutrition/conversations/reset-fresh-empty', method: 'POST',
    body: { schema: nutritionWireSchema, requestId: id(1) }, key: undefined }]);
});

test('pending hides old content; successful submit and rejected selection retain all synthetic qualification data', async () => {
  const f = fixture(); await f.client.resetFreshEmpty();
  const wait = deferred(); f.handle(() => wait.promise);
  const pending = f.client.submit(input);
  assert.equal(f.client.getSnapshot().status, 'pending'); hidden(f.client.getSnapshot());
  assert.deepEqual(f.calls[1].body.input, input);
  input.userContext.push('Later caller mutation');
  assert.deepEqual(f.calls[1].body.input.userContext, ['Owner context']); input.userContext.pop();
  wait.resolve(response(f.calls[1], answer));
  assert.deepEqual((await pending).state, answer);
  f.handle(call => response(call, selected, { stateVersion: 3 }));
  assert.deepEqual((await f.client.selectCitation({ parentTurnId: 1, statementId: 'statement-one' })).state, selected);
  f.handle(call => response(call, rejected, { status: 'rejected', code: 'stale_turn', stateVersion: 4 }));
  const result = await f.client.selectCitation({ parentTurnId: 9, statementId: 'statement-one' });
  assert.equal(result.status, 'rejected'); assert.deepEqual(result.state, rejected);
  assert.equal(f.calls.length, 4); assert.equal(f.calls[2].path.endsWith('/select-citation'), true);
  assert.ok(Object.isFrozen(result.state.conversation));
});

test('request loss requires explicit fresh reset and snapshot cannot recover cached content', async () => {
  const f = fixture(); await f.client.resetFreshEmpty();
  f.handle(async () => { throw new Error('synthetic lost response'); });
  const unknown = await f.client.submit(input); assert.equal(unknown.status, 'unknown'); hidden(unknown);
  assert.equal(await f.client.snapshot(), unknown); assert.equal(await f.client.submit(input), unknown);
  assert.equal(f.calls.length, 2);
  f.handle(call => response(call, empty, { binding: { id: id(101), expiresAt: '2030-01-01T00:00:00.000Z' } }));
  assert.equal((await f.client.resetFreshEmpty()).status, 'reset'); assert.equal(f.calls.length, 3);
});

test('host unavailable and unknown outcomes retain no content; qualified unavailable native snapshots stay complete', async () => {
  const f = fixture();
  f.handle(call => response(call, null, { status: 'unavailable', code: 'nutrition_unconfigured', binding: null, stateVersion: null, resetRequired: true }));
  hidden(await f.client.resetFreshEmpty()); assert.equal(f.client.getSnapshot().code, 'nutrition_unconfigured');
  f.handle(call => response(call)); await f.client.resetFreshEmpty();
  f.handle(call => response(call, answer, { status: 'unavailable', code: 'synthesis_unavailable' }));
  assert.deepEqual((await f.client.submit(input)).state, answer);
  f.handle(call => response(call, null, { status: 'unknown', code: 'outcome_unknown', binding: null, stateVersion: null, resetRequired: true }));
  const unknown = await f.client.snapshot(); assert.equal(unknown.status, 'unknown'); hidden(unknown);
  await f.client.snapshot(); assert.equal(f.calls.length, 4);
});

test('auth, account and same-account session replacement reject requests before UUID consumption', async () => {
  for (const change of ['changeAuth', 'changeAccount', 'changeSession']) {
    const f = fixture(); await f.client.resetFreshEmpty(); f[change]();
    hidden(await f.client.submit(input)); hidden(await f.client.resetFreshEmpty());
    assert.equal(f.calls.length, 1); assert.equal(f.issued(), 1);
  }
});

test('mutating dependency selector values cannot rebind the captured account or auth guard', async () => {
  const f = fixture(); f.dependencies.accountId = 'replacement'; f.dependencies.sessionGeneration = 'replacement';
  assert.equal(f.client.accountId, 'account-one'); assert.equal(f.client.sessionGeneration, 'session-one');
  assert.equal((await f.client.resetFreshEmpty()).status, 'reset');
  f.changeAuth(); f.dependencies.api.captureAuthContext = () => ({ isCurrent: () => true });
  hidden(await f.client.resetFreshEmpty()); assert.equal(f.calls.length, 1);
});

test('late auth or request invalidation never releases old state', async () => {
  for (const change of ['changeAuth', 'expireRequest']) {
    const f = fixture(); await f.client.resetFreshEmpty(); const wait = deferred(); f.handle(() => wait.promise);
    const pending = f.client.submit(input); f[change](); wait.resolve(response(f.calls[1], answer));
    hidden(await pending); hidden(f.client.getSnapshot()); assert.equal(f.calls.length, 2);
  }
});

test('completed delivery remains hidden once its original request guard expires', async () => {
  const f = fixture(); await f.client.resetFreshEmpty(); f.expireRequest();
  hidden(f.client.getSnapshot()); hidden(await f.client.snapshot()); assert.equal(f.calls.length, 1);
});

test('reset supersedes an outstanding submit; its late response cannot replace or disclose the fresh result', async () => {
  const f = fixture(); await f.client.resetFreshEmpty(); const wait = deferred(); f.handle(() => wait.promise);
  const old = f.client.submit(input);
  f.handle(call => response(call, empty, { binding: { id: id(101), expiresAt: '2030-01-01T00:00:00.000Z' } }));
  const fresh = await f.client.resetFreshEmpty();
  wait.resolve(response(f.calls[1], answer)); hidden(await old);
  assert.equal(f.client.getSnapshot(), fresh); assert.deepEqual(fresh.state, empty);
});

test('dispose hides pending state, defeats late delivery and cannot be reset as the same client', async () => {
  const f = fixture(); await f.client.resetFreshEmpty(); const wait = deferred(); f.handle(() => wait.promise);
  const old = f.client.submit(input);
  f.handle(call => response(call, null, { status: 'disposed', binding: null, stateVersion: null, resetRequired: true }));
  const disposed = await f.client.dispose(); assert.equal(disposed.status, 'disposed'); hidden(disposed);
  wait.resolve(response(f.calls[1], answer)); hidden(await old);
  assert.equal(f.client.getSnapshot(), disposed); hidden(await f.client.resetFreshEmpty()); assert.equal(f.calls.length, 3);
});

test('schema, request, operation, binding, version, completeness and additional-field violations require reset', async () => {
  const changes = [{ schema: 'wrong' }, { requestId: id(999) }, { operation: 'snapshot' },
    { binding: { id: id(999), expiresAt: '2030-01-01T00:00:00.000Z' } }, { stateVersion: 0 },
    { state: { conversation: answer.conversation } }, { accountId: 'forbidden' }];
  for (const change of changes) {
    const f = fixture(); await f.client.resetFreshEmpty(); f.handle(call => response(call, answer, change));
    const result = await f.client.submit(input); hidden(result); assert.equal(result.code, 'invalid_wire');
    await f.client.snapshot(); assert.equal(f.calls.length, 2);
  }
});

test('same-binding version may stay equal but may never decrease', async () => {
  const f = fixture(); await f.client.resetFreshEmpty(); f.handle(call => response(call, answer, { stateVersion: 4 }));
  assert.equal((await f.client.submit(input)).stateVersion, 4); assert.equal((await f.client.snapshot()).stateVersion, 4);
  f.handle(call => response(call, answer, { stateVersion: 3 }));
  assert.equal((await f.client.snapshot()).code, 'invalid_wire'); hidden(f.client.getSnapshot());
});

test('reset rejects nonempty, wrong-version and previously issued binding confirmations', async () => {
  const freshBinding = { id: id(101), expiresAt: '2030-01-01T00:00:00.000Z' };
  for (const change of [{ state: answer, binding: freshBinding }, { stateVersion: 2, binding: freshBinding }, {}]) {
    const f = fixture(); await f.client.resetFreshEmpty(); f.handle(call => response(call, empty, change));
    const result = await f.client.resetFreshEmpty(); hidden(result); assert.equal(result.code, 'invalid_wire');
  }
});

test('expiry observed while pending prevents a late response from restoring content', async () => {
  const f = fixture(); await f.client.resetFreshEmpty(); const wait = deferred(); f.handle(() => wait.promise);
  const pending = f.client.submit(input); f.expireBinding(); hidden(f.client.getSnapshot());
  wait.resolve(response(f.calls[1], answer, { binding: { id: id(100), expiresAt: '2032-01-01T00:00:00.000Z' } }));
  hidden(await pending); hidden(f.client.getSnapshot()); await f.client.snapshot(); assert.equal(f.calls.length, 2);
});

test('invalid input including actor selectors or oversized unchanged text is rejected without dispatch', async () => {
  for (const invalid of [{ ...input, accountId: 'other' }, { ...input, question: 'x'.repeat(2001) },
    { ...input, correction: 'unexpected correction' }]) {
    const f = fixture(); await f.client.resetFreshEmpty();
    assert.equal((await f.client.submit(invalid)).code, 'invalid_input'); hidden(f.client.getSnapshot()); assert.equal(f.calls.length, 1);
  }
});

test('request guard and repeated correlation IDs fail before a new transport dispatch', async () => {
  const f = fixture(); await f.client.resetFreshEmpty(); f.expireRequest();
  hidden(await f.client.submit(input)); assert.equal(f.calls.length, 1); assert.equal(f.issued(), 1);
  const repeat = fixture({ newRequestId: () => id(1) }); await repeat.client.resetFreshEmpty();
  assert.equal((await repeat.client.submit(input)).code, 'invalid_input'); assert.equal(repeat.calls.length, 1);
});

test('auth change during request-ID issuance prevents dispatch and never borrows replacement authority', async () => {
  let f;
  f = fixture({ newRequestId: () => { f.changeAuth(); return id(1); } });
  hidden(await f.client.resetFreshEmpty()); assert.equal(f.calls.length, 0);
});

test('correction choice, context and text are sent once without trimming or selecting a second job', async () => {
  const f = fixture(); await f.client.resetFreshEmpty();
  const correction = { choice: 'correct-question', previousTurnId: 1, job: 'energy-uncertainty', question: '  Corrected question  ',
    userContext: [' First unchanged context ', 'Second context'], correction: '  Original correction wording  ' };
  f.handle(call => response(call, answer)); await f.client.submit(correction);
  assert.deepEqual(f.calls[1].body, { schema: nutritionWireSchema, requestId: id(2), input: correction });
  assert.equal(f.calls.length, 2);
});
