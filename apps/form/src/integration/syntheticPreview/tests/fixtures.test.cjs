'use strict';
// Source-authored acceptance cases. Execution requires a separately admitted test stage.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), ts = require('typescript');
const file = path.resolve(__dirname, '../fixtures.ts');
const moduleValue = { exports: {} };
const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  fileName: file, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
new Function('require', 'module', 'exports', code)(name => assert.fail(`Unexpected runtime dependency: ${name}`),
  moduleValue, moduleValue.exports);
const { previewFixture, validatePreviewFixture, frozenPreviewCopy, projectPreviewCommand, previewRoleDenial } = moduleValue.exports;
const clone = value => JSON.parse(JSON.stringify(value));
const owner = () => clone(previewFixture('com01-owner-current'));
const rest = () => clone(previewFixture('rest-running'));
const scenarios = ['rest-running', 'rest-paused', 'com01-owner-current', 'com01-admin-current', 'com01-member-current', 'com01-stale'];

test('fixed six seeds are independently detached, deeply frozen and carry only synthetic provenance', () => {
  for (const scenario of scenarios) {
    const a = previewFixture(scenario), b = previewFixture(scenario);
    assert.equal(validatePreviewFixture(a), null);
    assert.notEqual(a, b); assert.notEqual(a.identity, b.identity);
    assert.deepEqual(a.identity, { kind: 'synthetic', fixtureSet: 'form.training-community.preview/v1',
      fixtureRevision: 1, accountId: 'synthetic:form-training-community:r1', authority: 'none' });
    const inspect = value => {
      if (value === null || typeof value !== 'object') return;
      assert.ok(Object.isFrozen(value));
      for (const [key, child] of Object.entries(value)) {
        assert.ok(!['account', 'resources', 'transport', 'provider', 'storage', 'auth', 'token', 'receipt',
          'registration', 'planSnapshot', 'membershipResult', 'sessionToken', 'email'].includes(key));
        assert.notEqual(typeof child, 'function'); inspect(child);
      }
    };
    inspect(a);
    assert.ok(!JSON.stringify(a).includes('https://'));
  }
  for (const invalid of ['arbitrary', 'constructor', '__proto__', '', undefined, null]) assert.equal(previewFixture(invalid), null);
});

test('rest seeds retain one occurrence, separate domain revisions and unknown load without a source plan or countdown', () => {
  for (const [scenario, status] of [['rest-running', 'running'], ['rest-paused', 'paused']]) {
    const f = previewFixture(scenario);
    assert.equal(f.kind, 'rest');
    assert.equal(f.source.session.sessionRevision, 1);
    assert.equal(f.source.session.planRevision, 2);
    assert.equal(f.source.occurrence.id, 'fixture-occurrence-practice-1');
    assert.deepEqual(f.source.prescription, { rest_seconds: 90 });
    assert.deepEqual(f.source.prescribedLoad, { kind: 'unspecified', basis: 'unknown' });
    assert.deepEqual(f.restSeed, { occurrenceId: 'fixture-occurrence-practice-1', durationSeconds: 90,
      remainingMs: 67500, status });
    assert.equal(Object.hasOwn(f.source, 'plan'), false);
    assert.equal(Object.hasOwn(f.source.prescription, 'rep_range'), false);
    assert.equal(Object.hasOwn(f.source.prescription, 'target_rir'), false);
  }
});

test('malformed duration, occurrence, load and extra accepted-data fields cannot validate as rest fixtures', () => {
  for (const mutate of [
    f => { f.source.prescription.rest_seconds = undefined; }, f => { f.source.prescription.rest_seconds = '90'; },
    f => { f.source.prescription.rest_seconds = -1; }, f => { f.source.prescription.rest_seconds = 0.5; },
    f => { f.source.prescription.rest_seconds = 10801; }, f => { f.source.prescription.rest_seconds = NaN; },
    f => { f.restSeed.occurrenceId = 'foreign'; }, f => { f.restSeed.remainingMs = 90000; },
    f => { f.source.occurrence.id = 'foreign'; }, f => { f.source.prescribedLoad = { kind: 'kg', value: 20 }; },
    f => { f.source.planSnapshot = {}; }, f => { f.source.registration = { accepted: true }; },
  ]) {
    const value = rest(); mutate(value); assert.equal(validatePreviewFixture(value), 'invalid_fixture');
  }
});

test('foreign identities, accounts, fixture revisions and domain revisions are rejected distinctly', () => {
  for (const [make, mutate, reason] of [
    [owner, f => { f.identity.accountId = 'real-looking-account'; }, 'foreign_identity'],
    [owner, f => { f.identity.kind = 'authenticated'; }, 'foreign_identity'],
    [owner, f => { f.identity.authority = 'owner'; }, 'foreign_identity'],
    [owner, f => { f.identity.fixtureSet = 'foreign'; }, 'foreign_identity'],
    [owner, f => { f.identity.fixtureRevision = 2; }, 'stale_revision'],
    [owner, f => { f.detail.data.revision = 9; }, 'stale_revision'],
    [owner, f => { f.detail.data.members[0].revision = 4; }, 'stale_revision'],
    [owner, f => { f.detail.data.members[1].revision = 7; }, 'stale_revision'],
    [rest, f => { f.source.session.sessionRevision = 2; }, 'stale_revision'],
    [rest, f => { f.source.session.planRevision = 1; }, 'stale_revision'],
  ]) {
    const value = make(); mutate(value); assert.equal(validatePreviewFixture(value), reason);
  }
  for (const value of [null, undefined, [], {}, { identity: null }, { identity: {} }]) {
    assert.notEqual(validatePreviewFixture(value), null);
  }
});

test('COM01 own member, selected group, detail rows and roles must match with no duplicates or foreign targets', () => {
  for (const mutate of [
    f => { f.groups.data.push(clone(f.groups.data[0])); },
    f => { f.detail.data.members.push(clone(f.detail.data.members[0])); },
    f => { f.detail.data.memberId = f.selectedMemberId; },
    f => { f.detail.data.members[0].memberId = 'foreign'; },
    f => { f.detail.data.members[0].role = 'member'; },
    f => { f.detail.data.members[1].role = 'owner'; },
    f => { f.detail.data.role = 'admin'; },
    f => { f.selectedGroupId = 'foreign'; },
    f => { f.detail.groupId = 'foreign'; },
    f => { f.detail.data.id = 'foreign'; },
    f => { f.selectedMemberId = 'foreign'; },
    f => { f.groups.data[0].role = 'member'; },
    f => { f.authority = 'owner'; }, f => { f.productionActions = 'allowed'; },
  ]) {
    const value = owner(); mutate(value);
    assert.equal(validatePreviewFixture(value), 'invalid_fixture');
    assert.equal(previewRoleDenial(value), 'invalid_fixture');
  }
});

test('only the current owner case is role eligible; stale is preserved as null data rather than empty success', () => {
  for (const [scenario, denial] of [['com01-owner-current', null], ['com01-admin-current', 'role_not_eligible'],
    ['com01-member-current', 'role_not_eligible'], ['com01-stale', 'not_current']]) {
    const f = previewFixture(scenario);
    assert.equal(previewRoleDenial(f), denial);
    assert.equal(f.groups.data[0].revision, 4);
    if (scenario === 'com01-stale') {
      assert.equal(f.detail.status, 'stale'); assert.equal(f.detail.data, null);
    } else {
      assert.equal(f.detail.data.members[0].revision, 7);
      assert.equal(f.detail.data.members[1].revision, 9);
    }
  }
  for (const state of [
    { status: 'loading', data: null, error: null }, { status: 'idle', data: null, error: null },
    { status: 'error', data: null, error: { status: 403, code: 'forbidden', effectUnknown: false, originalEffectUnknown: false } },
    { status: 'unknown', data: null, error: null }, { status: 'empty', data: [], error: null },
  ]) {
    const value = owner(); value.detail = { ...state, groupId: value.selectedGroupId };
    assert.equal(validatePreviewFixture(value), 'invalid_fixture');
    assert.notEqual(previewRoleDenial(value), null);
    assert.equal(value.detail.status, state.status);
    assert.equal(value.detail.data, state.data);
  }
});

const command = (overrides = {}) => ({ status: 'idle', kind: null, error: null, intent: null, ...overrides });
const error = (overrides = {}) => ({ status: 503, code: 'role_unavailable', effectUnknown: false,
  originalEffectUnknown: false, ...overrides });
const inspection = (overrides = {}) => ({ state: 'rejected', originalEffectUnknown: false, ...overrides });

test('command projection preserves source status and original uncertainty over later current-known errors', () => {
  for (const [source, uncertainty] of [
    [command(), 'none'],
    [command({ status: 'pending', kind: 'role', intent: inspection({ state: 'pending' }) }), 'none'],
    [command({ status: 'confirmed', kind: 'role', intent: inspection({ state: 'confirmed' }) }), 'none'],
    [command({ status: 'error', kind: 'role', error: error() }), 'none'],
    [command({ status: 'error', kind: 'role', error: error({ effectUnknown: true }) }), 'current'],
    [command({ status: 'error', kind: 'role', error: error(), intent: inspection({ state: 'unknown' }) }), 'current'],
    [command({ status: 'error', kind: 'role', error: error({ effectUnknown: true, originalEffectUnknown: true }) }), 'original'],
    [command({ status: 'error', kind: 'role', error: error(), intent: inspection({ originalEffectUnknown: true }) }), 'original'],
    [command({ status: 'confirmed', kind: 'role', intent: inspection({ state: 'confirmed', originalEffectUnknown: true }) }), 'original'],
  ]) {
    const projected = projectPreviewCommand(source);
    assert.equal(projected.status, source.status); assert.equal(projected.uncertainty, uncertainty);
    assert.ok(Object.isFrozen(projected));
    if (projected.error) {
      assert.notEqual(projected.error, source.error); assert.ok(Object.isFrozen(projected.error));
    }
    const fixture = owner(); fixture.command = projected;
    assert.equal(validatePreviewFixture(fixture), null);
    assert.equal(previewRoleDenial(fixture), source.status === 'pending' || source.status === 'error' || uncertainty !== 'none'
      ? 'command_unresolved' : null);
  }
});

test('unknown command statuses and malformed uncertainty are rejected; exception text and real command fields are omitted', () => {
  for (const source of [
    command({ status: 'unknown' }), command({ kind: 'updateRole' }), command({ status: 'error' }),
    command({ error: error() }), command({ intent: inspection() }),
    command({ status: 'error', kind: 'role', error: error({ effectUnknown: 'false' }) }),
    command({ status: 'error', kind: 'role', error: error({ code: 'arbitrary server exception text' }) }),
    command({ status: 'pending', kind: 'role', intent: inspection({ state: 'arbitrary' }) }),
    command({ status: 'pending', kind: 'role', intent: inspection({ originalEffectUnknown: undefined }) }),
  ]) assert.equal(projectPreviewCommand(source), null);
  const source = command({ status: 'error', kind: 'role', key: 'real-command-key', membershipResult: { role: 'owner' },
    error: error({ message: 'private server exception text' }), intent: inspection({ path: '/real/role', key: 'real-command-key' }) });
  const projected = projectPreviewCommand(source);
  assert.deepEqual(Object.keys(projected).sort(), ['error', 'kind', 'status', 'uncertainty']);
  assert.deepEqual(Object.keys(projected.error).sort(), ['code', 'effectUnknown', 'originalEffectUnknown', 'status']);
  assert.ok(!JSON.stringify(projected).includes('private server'));
  assert.ok(!JSON.stringify(projected).includes('real-command'));
  const unresolved = owner();
  unresolved.command = { ...projected, uncertainty: 'none', error: error({ originalEffectUnknown: true }) };
  assert.equal(validatePreviewFixture(unresolved), 'invalid_fixture');
  const unknown = owner(); unknown.command.status = 'unknown';
  assert.equal(validatePreviewFixture(unknown), 'invalid_fixture');
});

test('detachment never freezes or retains mutable inputs and forged extra fields cannot enter the registry', () => {
  const supplied = owner(), copy = frozenPreviewCopy(supplied);
  supplied.detail.data.members[1].alias = 'changed';
  assert.equal(copy.detail.data.members[1].alias, 'Synthetic target');
  assert.equal(Object.isFrozen(supplied), false);
  assert.ok(Object.isFrozen(copy.detail.data.members));
  assert.throws(() => copy.detail.data.members.push({}), TypeError);
  assert.equal(previewFixture('com01-owner-current').detail.data.members[1].alias, 'Synthetic target');
  const malformed = owner(); malformed.resources = {};
  assert.equal(validatePreviewFixture(malformed), 'invalid_fixture');
});
