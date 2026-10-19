const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), ts = require('typescript');
const root = path.resolve(__dirname, '../..'), modules = new Map();
function load(name) {
  const file = path.resolve(root, name); assert.ok(file.startsWith(root + path.sep));
  if (modules.has(file)) return modules.get(file).exports;
  const module = { exports: {} }; modules.set(file, module);
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function('require', 'module', 'exports', code)(name => {
    assert.ok(name.startsWith('.'), `Unexpected runtime dependency: ${name}`);
    return load(path.relative(root, path.resolve(path.dirname(file), name + '.ts')));
  }, module, module.exports);
  return module.exports;
}
const { createCommandCustody, commandCustodyLimits } = load('integration/commandCustody.ts');
const { createManualMeasurementsClient } = load('body/manualMeasurements.ts');
const { createManualProgressController } = load('body/manualProgressController.ts');
const access = Object.freeze({ accountId: 'synthetic-original-account', sessionGeneration: 'original-generation' });
const createIntent = key => ({ operation: 'save_manual_measurement', command: { key,
  payload: { kind: 'waist', value: 80, unit: 'cm', measuredOn: '2026-10-11', note: 'Synthetic private note' } } });
const deleteIntent = key => ({ operation: 'delete_assessment', command: { key, id: 'synthetic-private-measurement', payload: {} } });
const measurement = { id: 'synthetic-created-id', kind: 'waist', value: 80, unit: 'cm', originalUnit: 'cm', measuredOn: '2026-10-11',
  note: 'Synthetic private note', provenance: 'manual_reported' };
function fixture(options = {}) {
  let auth = 1, account = access.accountId, generation = access.sessionGeneration, alive = true;
  const validated = [];
  const transport = { captureAuthContext() { const original = auth; return { isCurrent: () => auth === original }; } };
  const dependencies = { ...access, transport,
    isCurrentSession: (id, session) => alive && id === account && session === generation,
    validateConfirmation(intent, response) {
      validated.push({ intent, response });
      if (intent.operation === 'delete_assessment') return response?.deleted === true;
      return response?.id === measurement.id && response.kind === intent.command.payload.kind && response.value === intent.command.payload.value &&
        response.originalUnit === intent.command.payload.unit && response.measuredOn === intent.command.payload.measuredOn &&
        response.note === intent.command.payload.note && response.provenance === 'manual_reported';
    }, ...options };
  const owner = createCommandCustody(dependencies);
  return { owner, transport, dependencies, validated, hold: intent => owner.hold({ ...access, ...intent }),
    changeAuth: () => { auth++; }, changeAccount: () => { account = 'foreign-account'; },
    changeGeneration: () => { generation = 'replacement-generation'; }, expire: () => { alive = false; }, revive: () => { alive = true; } };
}
const unknown = settled => ({ status: 'unknown', settled });
const rejected = { status: 'rejected', settled: true };
const confirmed = response => ({ status: 'confirmed', settled: true, response });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const only = f => { const values = f.owner.snapshot(access); assert.equal(values.length, 1); return values[0]; };

test('hold captures exact immutable command synchronously and public metadata contains no private intent', () => {
  const f = fixture(), input = createIntent('private-key-one'), held = f.hold(input);
  assert.deepEqual(only(f), { id: held.id, operation: 'save_manual_measurement', effect: 'pending', attempts: 1, locallyPending: 1, retryAvailable: false });
  input.command.payload.value = 99; input.command.payload.note = 'Changed later'; input.command.key = 'changed-key';
  const original = held.readIntent(); assert.deepEqual(original, createIntent('private-key-one'));
  assert.ok(Object.isFrozen(original.command.payload)); assert.ok(Object.isFrozen(held));
  assert.doesNotMatch(JSON.stringify(f.owner.snapshot(access)), /private-key|Synthetic private note|waist|2026-10-11|80/);
  assert.doesNotMatch(JSON.stringify(held), /private-key|payload|note|measurement/);
  assert.equal(f.validated.length, 0);
});

test('unknown does not imply local promise settlement and retry rejection retains original uncertainty', () => {
  const f = fixture(), held = f.hold(createIntent('original-key')), recovery = f.owner.reconcile(access, held.id);
  held.report(unknown(false)); assert.equal(only(f).effect, 'unknown'); assert.equal(only(f).locallyPending, 1);
  assert.throws(() => recovery.retry(), { code: 'attempt_pending' });
  assert.throws(() => recovery.acknowledge(), { code: 'unresolved_command' });
  held.report(unknown(true)); assert.equal(only(f).retryAvailable, true);
  const retry = recovery.retry(); assert.equal(retry.readIntent(), held.readIntent()); assert.equal(only(f).locallyPending, 1);
  assert.throws(() => recovery.retry(), { code: 'attempt_pending' });
  retry.report(rejected); assert.equal(only(f).effect, 'unknown'); assert.equal(only(f).locallyPending, 0);
  assert.throws(() => recovery.acknowledge(), { code: 'unresolved_command' });
  const last = recovery.retry(); last.report(confirmed(measurement));
  assert.equal(only(f).effect, 'confirmed'); recovery.acknowledge(); assert.deepEqual(f.owner.snapshot(access), []);
});

test('late original confirmation can settle effect but cannot erase a still-pending retry', () => {
  const f = fixture(), original = f.hold(deleteIntent('delete-key'));
  original.report(unknown(true)); const recovery = f.owner.reconcile(access, original.id), retry = recovery.retry();
  original.report(confirmed({ deleted: true })); assert.equal(only(f).effect, 'confirmed'); assert.equal(only(f).locallyPending, 1);
  assert.throws(() => recovery.acknowledge(), { code: 'unresolved_command' });
  retry.report(unknown(true)); original.report(rejected); original.report(unknown(false));
  assert.equal(only(f).effect, 'confirmed'); assert.equal(only(f).locallyPending, 0);
  recovery.acknowledge(); assert.deepEqual(f.owner.snapshot(access), []);
});

test('reports are idempotent and stale report handles cannot overwrite newer confirmed state', () => {
  const f = fixture(), original = f.hold(createIntent('create-key'));
  original.report(unknown(true)); original.report(unknown(true));
  const retry = f.owner.reconcile(access, original.id).retry(); retry.report(confirmed(measurement)); retry.report(confirmed(measurement));
  original.report(rejected); original.report(unknown(false));
  assert.equal(only(f).effect, 'confirmed'); assert.equal(only(f).attempts, 2); assert.equal(f.validated.length, 1);
  assert.throws(() => original.assertCurrent(), { code: 'retry_unavailable' });
  assert.throws(() => retry.assertCurrent(), { code: 'retry_unavailable' });
});

test('missing or failing confirmation proof still admits holds and retains unknown liability', () => {
  for (const validateConfirmation of [undefined, () => false, () => { throw new Error('Unqualified'); }]) {
    const f = fixture({ validateConfirmation }), held = f.hold(createIntent('held-before-dispatch'));
    held.assertCurrent(); held.report(confirmed(measurement));
    assert.equal(only(f).effect, 'unknown'); assert.equal(only(f).locallyPending, 0);
    assert.throws(() => f.owner.acknowledge(access, held.id), { code: 'unresolved_command' });
  }
});

test('create confirmation must qualify the exact retained payload and cannot substitute another measurement', () => {
  const f = fixture(), held = f.hold(createIntent('qualified-key'));
  held.report(confirmed({ ...measurement, value: 999 })); assert.equal(only(f).effect, 'unknown');
  held.report(confirmed(measurement)); assert.equal(only(f).effect, 'confirmed');
  assert.equal(f.validated[0].intent, held.readIntent()); assert.equal(f.validated[1].intent.command.key, 'qualified-key');
});

test('delete confirmation requires exact deleted:true even when the injected qualifier accepts everything', () => {
  for (const response of [{ items: [] }, { deleted: false }, { deleted: true, id: 'extra' }, null]) {
    const f = fixture({ validateConfirmation: () => true }), held = f.hold(deleteIntent('delete-key'));
    held.report(confirmed(response)); assert.equal(only(f).effect, 'unknown');
    assert.throws(() => f.owner.acknowledge(access, held.id), { code: 'unresolved_command' });
  }
  const f = fixture(), held = f.hold(deleteIntent('exact-delete'));
  held.report(confirmed({ deleted: true })); assert.equal(only(f).effect, 'confirmed');
});

test('foreign selectors cannot enumerate, reconcile, drop or reserve original commands', () => {
  const f = fixture(), held = f.hold(deleteIntent('original-key'));
  for (const foreign of [{ ...access, accountId: 'foreign' }, { ...access, sessionGeneration: 'replacement' }]) {
    assert.throws(() => f.owner.snapshot(foreign), { code: 'session_changed' });
    assert.throws(() => f.owner.reconcile(foreign, held.id), { code: 'session_changed' });
    assert.throws(() => f.owner.acknowledge(foreign, held.id), { code: 'session_changed' });
    assert.throws(() => f.owner.hold({ ...foreign, ...deleteIntent('new-key') }), { code: 'session_changed' });
  }
  assert.equal(only(f).effect, 'pending');
  assert.throws(() => f.owner.reconcile(access, Object.freeze({})), { code: 'custody_missing' });
});

test('replacement auth, account, generation and expired host deny retained reads and retries but allow write-only late reporting', () => {
  for (const change of ['changeAuth', 'changeAccount', 'changeGeneration', 'expire']) {
    const f = fixture(), held = f.hold(createIntent('original-key')), recovery = f.owner.reconcile(access, held.id);
    f[change]();
    for (const action of [() => f.owner.snapshot(access), () => held.readIntent(), () => held.assertCurrent(),
      () => recovery.readIntent(), () => recovery.retry(), () => recovery.acknowledge()]) assert.throws(action, { code: 'session_changed' });
    assert.equal(held.report(confirmed(measurement)), undefined); assert.equal(f.validated.length, 1);
    assert.throws(() => recovery.snapshot(), { code: 'session_changed' });
    f.revive(); assert.throws(() => held.readIntent(), { code: 'session_changed' });
  }
});

test('dependency mutation cannot move custody to a new account or replace captured auth/currentness', () => {
  const f = fixture(), held = f.hold(createIntent('original-key'));
  f.dependencies.accountId = 'foreign'; f.dependencies.sessionGeneration = 'replacement'; f.dependencies.isCurrentSession = () => true;
  f.changeAuth(); f.dependencies.transport.captureAuthContext = () => ({ isCurrent: () => true });
  assert.throws(() => held.readIntent(), { code: 'session_changed' });
  assert.throws(() => f.owner.snapshot({ accountId: 'foreign', sessionGeneration: 'replacement' }), { code: 'session_changed' });
});

test('the real manual client dispatches only after a hold, and same-session reconciliation survives presentation disposal', async () => {
  const f = fixture(), late = deferred(), entered = deferred(), calls = [], contexts = [];
  const retention = load('body/manualRetentionContract.ts');
  // Synthetic unit authority exercises custody/client plumbing; actual grant evidence belongs to the joined HTTP tests.
  const authority = { protocol: retention.MANUAL_RETENTION_PROTOCOL, decisionId: '11111111-1111-4111-8111-111111111111',
    revision: 1, statementSha256: retention.MANUAL_RETENTION_STATEMENT_SHA256 };
  const requestContext = attempt => ({ ...attempt.readAttemptContext(), assertCurrent: attempt.assertCurrent });
  const available = () => ({ status: 'available', scope: 'manual_only', provenance: 'manual_reported' });
  let delay = true;
  const transport = { ...f.transport, async request(path, method, payload, key, attemptContext) {
    assert.equal(f.owner.snapshot(access).length, 1); assert.equal(only(f).locallyPending, 1);
    calls.push({ path, method, payload, key });
    if (path === '/v1/body/capabilities') return { schema: 'form.body-capabilities/v1',
      manualRetention: { schema: retention.MANUAL_RETENTION_CAPABILITY_SCHEMA, protocol: retention.MANUAL_RETENTION_PROTOCOL,
        status: 'available', grant: 'available', revoke: 'available', current: 'available', statement: retention.MANUAL_RETENTION_STATEMENT_BINDING },
      retainedMeasurements: available(), progress: available(), bodyDeletion: available(),
      operations: { save_manual_measurement: available(), list_progress: available(), delete_assessment: available() } };
    assert.deepEqual(attemptContext.manualRetention, authority); attemptContext.assertCurrent(); contexts.push(attemptContext);
    entered.resolve(); return delay ? late.promise : measurement;
  } };
  const controller = createManualProgressController({ ...access, transport, isCurrentSession: () => true });
  const client = createManualMeasurementsClient({ transport, isCurrentSession: () => true });
  const original = f.owner.hold({ ...access, ...createIntent('original-key') }, { manualRetention: authority }); original.assertCurrent();
  const pending = client.create(original.readIntent().command, requestContext(original)).then(response => original.report(confirmed(response)), error => {
    assert.equal(error.originalEffectUnknown, true); original.report(unknown(true));
  });
  try {
    await entered.promise; controller.dispose(); client.dispose();
    assert.equal(only(f).effect, 'pending'); late.resolve(measurement); await pending;
    assert.equal(only(f).effect, 'unknown'); assert.equal(controller.snapshot().active, false);
    delay = false;
    const recovery = f.owner.reconcile(access, original.id), retry = recovery.retry({ manualRetention: authority });
    const currentClient = createManualMeasurementsClient({ transport, isCurrentSession: () => true });
    try { retry.assertCurrent(); retry.report(confirmed(await currentClient.create(retry.readIntent().command, requestContext(retry)))); }
    finally { currentClient.dispose(); }
    const writes = calls.filter(call => call.path !== '/v1/body/capabilities');
    assert.deepEqual(writes[0], writes[1]); assert.equal(only(f).effect, 'confirmed');
    assert.equal(writes.length, 2); assert.equal(only(f).attempts, 2);
    assert.equal(retry.readIntent(), original.readIntent()); assert.deepEqual(original.readIntent(), createIntent('original-key'));
    assert.notEqual(contexts[0], contexts[1]); assert.notEqual(contexts[0].assertCurrent, contexts[1].assertCurrent);
    assert.deepEqual(original.readAttemptContext(), { manualRetention: authority });
    assert.deepEqual(retry.readAttemptContext(), { manualRetention: authority });
  } finally { late.resolve(measurement); client.dispose(); controller.dispose(); await pending; }
});

test('bounded capacity never evicts pending, unknown or unacknowledged terminal commands', () => {
  const f = fixture(), held = [];
  for (let index = 0; index < commandCustodyLimits.records; index++) held.push(f.hold(deleteIntent(`key-${index}`)));
  held[0].report(unknown(true)); held[1].report(rejected);
  assert.throws(() => f.hold(deleteIntent('overflow')), { code: 'custody_capacity' });
  assert.equal(f.owner.snapshot(access).length, commandCustodyLimits.records);
  assert.equal(f.owner.reconcile(access, held[0].id).snapshot().effect, 'unknown');
  assert.throws(() => f.owner.acknowledge(access, held[0].id), { code: 'unresolved_command' });
  f.owner.acknowledge(access, held[1].id); f.hold(deleteIntent('admitted-after-ack'));
  assert.equal(f.owner.snapshot(access).length, commandCustodyLimits.records);
});

test('attempt bound refuses further retries while preserving original unknown command', () => {
  const f = fixture(), first = f.hold(deleteIntent('bounded-key')), recovery = f.owner.reconcile(access, first.id);
  let attempt = first;
  for (let index = 1; index < commandCustodyLimits.attemptsPerCommand; index++) { attempt.report(unknown(true)); attempt = recovery.retry(); }
  attempt.report(unknown(true)); assert.throws(() => recovery.retry(), { code: 'attempt_capacity' });
  assert.equal(only(f).effect, 'unknown'); assert.equal(only(f).attempts, commandCustodyLimits.attemptsPerCommand);
  assert.equal(recovery.readIntent().command.key, 'bounded-key'); assert.equal(only(f).retryAvailable, false);
});

test('duplicate keys cannot claim pending custody or substitute a different payload or operation', () => {
  const f = fixture(), held = f.hold(createIntent('same-key'));
  for (const intent of [createIntent('same-key'), { ...createIntent('same-key'), command: { key: 'same-key', payload: { ...createIntent('x').command.payload, value: 99 } } }, deleteIntent('same-key')]) {
    assert.throws(() => f.hold(intent), { code: 'command_already_held' });
  }
  assert.equal(only(f).attempts, 1); assert.equal(held.readIntent().command.payload.value, 80);
});

test('reset, cancel and list absence cannot settle an attempt or imply deletion', () => {
  for (const outcome of [{ status: 'cancelled', settled: true }, { status: 'reset', settled: true },
    { status: 'confirmed', settled: true, response: { items: [] } }]) {
    const f = fixture(), held = f.hold(deleteIntent('delete-key'));
    held.report(outcome); assert.equal(only(f).effect, 'unknown');
    assert.throws(() => f.owner.acknowledge(access, held.id), { code: 'unresolved_command' });
    assert.equal('clear' in f.owner, false); assert.equal('reset' in f.owner, false); assert.equal('cancel' in f.owner, false);
  }
});

test('bounded exact commands reject secret-bearing extras and accessors without reading them', () => {
  const f = fixture(); let accessed = 0;
  const accessor = { ...createIntent('getter').command.payload };
  Object.defineProperty(accessor, 'note', { enumerable: true, get() { accessed++; return 'private'; } });
  for (const intent of [ { operation: 'save_manual_measurement', command: { key: 'getter', payload: accessor } },
    { ...deleteIntent('extra'), command: { ...deleteIntent('extra').command, bearer: 'synthetic-secret' } },
    { operation: 'save_manual_measurement', command: { key: 'big', payload: { ...createIntent('big').command.payload, note: 'x'.repeat(4096) } } } ]) {
    assert.throws(() => f.hold(intent), { code: 'invalid_command' });
  }
  assert.equal(accessed, 0); assert.deepEqual(f.owner.snapshot(access), []);
});

test('acknowledged records cannot be resurrected or mutate a later record through old report handles', () => {
  const f = fixture(), old = f.hold(deleteIntent('first-key'));
  old.report(rejected); f.owner.acknowledge(access, old.id);
  const next = f.hold(deleteIntent('next-key')); old.report(confirmed({ deleted: true })); old.report(unknown(false));
  assert.equal(only(f).id, next.id); assert.equal(only(f).effect, 'pending');
  assert.throws(() => old.readIntent(), { code: 'custody_missing' }); assert.equal(f.validated.length, 0);
});

const retention = load('body/manualRetentionContract.ts');
const decisionA = '11111111-1111-4111-8111-111111111111';
const decisionB = '22222222-2222-4222-8222-222222222222';
const authority = decisionId => ({ protocol: retention.MANUAL_RETENTION_PROTOCOL, decisionId, revision: 1,
  statementSha256: retention.MANUAL_RETENTION_STATEMENT_SHA256 });
const grantIntent = key => ({ operation: 'grant_manual_retention', command: { key, payload: {
  decisionId: decisionA, processing: retention.MANUAL_RETENTION_STATEMENT.processing,
  purpose: retention.MANUAL_RETENTION_STATEMENT.purpose, choice: 'retain',
  statementId: retention.MANUAL_RETENTION_STATEMENT.id, statementVersion: retention.MANUAL_RETENTION_STATEMENT.version,
  statementSha256: retention.MANUAL_RETENTION_STATEMENT_SHA256,
} } });
const revokeIntent = key => ({ operation: 'revoke_manual_retention', command: { key, decisionId: decisionA, payload: {} } });

test('retention controls retain exact frozen intent across unknown and cannot use a current read as confirmation', () => {
  for (const create of [grantIntent, revokeIntent]) {
    const f = fixture({ validateConfirmation: undefined }), input = create('control-key'), held = f.hold(input);
    input.command.key = 'replacement';
    if (input.operation === 'grant_manual_retention') input.command.payload.decisionId = decisionB;
    else input.command.decisionId = decisionB;
    assert.deepEqual(held.readIntent(), create('control-key'));
    assert.ok(Object.isFrozen(held.readIntent().command)); assert.ok(Object.isFrozen(held.readIntent().command.payload));
    assert.equal(held.readAttemptContext(), undefined);
    held.report(confirmed({ schema: retention.MANUAL_RETENTION_CURRENT_RESULT_SCHEMA, current: null }));
    assert.equal(only(f).effect, 'unknown');
    const recovery = f.owner.reconcile(access, held.id), retry = recovery.retry();
    assert.equal(retry.readIntent(), held.readIntent());
    retry.report(rejected); assert.equal(only(f).effect, 'unknown');
    assert.throws(() => recovery.acknowledge(), { code: 'unresolved_command' });
  }
});

test('measurement retries capture independent authority without changing original intent or earlier attempts', () => {
  const f = fixture(), input = createIntent('measurement-retention-key'), context = { manualRetention: authority(decisionA) };
  const original = f.owner.hold({ ...access, ...input }, context), captured = original.readAttemptContext();
  context.manualRetention.decisionId = decisionB;
  assert.deepEqual(captured, { manualRetention: authority(decisionA) });
  assert.ok(Object.isFrozen(captured)); assert.ok(Object.isFrozen(captured.manualRetention));
  original.report(unknown(true));
  const recovery = f.owner.reconcile(access, original.id), retry = recovery.retry({ manualRetention: authority(decisionB) });
  assert.equal(retry.readIntent(), original.readIntent());
  assert.deepEqual(original.readAttemptContext(), { manualRetention: authority(decisionA) });
  assert.deepEqual(retry.readAttemptContext(), { manualRetention: authority(decisionB) });
  retry.report(unknown(true));
  const reconciliation = recovery.retry({ manualRetention: null });
  assert.equal(reconciliation.readIntent(), original.readIntent());
  assert.deepEqual(reconciliation.readAttemptContext(), { manualRetention: null });
  assert.deepEqual(original.readIntent(), input);
  assert.doesNotMatch(JSON.stringify(f.owner.snapshot(access)), /11111111|22222222|manualRetention|statementSha256/);
  f.changeAuth(); assert.throws(() => original.readAttemptContext(), { code: 'session_changed' });
});

test('invalid attempt authority and control payloads fail before retaining a command or reserving a retry', () => {
  const f = fixture();
  for (const context of [{}, { manualRetention: { ...authority(decisionA), revision: 2 } },
    { manualRetention: authority(decisionA), headers: { Authorization: 'replacement' } },
    { get manualRetention() { assert.fail('Getter must not execute'); } }]) {
    assert.throws(() => f.owner.hold({ ...access, ...createIntent('invalid-context') }, context), { code: 'invalid_command' });
    assert.deepEqual(f.owner.snapshot(access), []);
  }
  for (const input of [grantIntent('control-context'), revokeIntent('control-context'), deleteIntent('control-context')]) {
    assert.throws(() => f.owner.hold({ ...access, ...input }, { manualRetention: null }), { code: 'invalid_command' });
  }
  const invalid = grantIntent('invalid-statement'); invalid.command.payload.statementSha256 = '0'.repeat(64);
  assert.throws(() => f.hold(invalid), { code: 'invalid_command' });
  const held = f.owner.hold({ ...access, ...createIntent('retained') }, { manualRetention: authority(decisionA) });
  held.report(unknown(true));
  assert.throws(() => f.owner.reconcile(access, held.id).retry({ manualRetention: { ...authority(decisionA), revision: 2 } }), { code: 'invalid_command' });
  assert.equal(only(f).attempts, 1);
  assert.equal(only(f).retryAvailable, true);
});

test('control caller validator false or throw preserves unknown rather than accepting a well-shaped receipt', () => {
  const response = retention.captureManualRetentionCommandResult({ schema: retention.MANUAL_RETENTION_COMMAND_RESULT_SCHEMA,
    receipt: { operation: 'grant', decisionId: decisionA, outcome: 'granted', decisionRevision: 1 },
    current: { decisionId: decisionA, state: 'granted', revision: 1, statement: retention.MANUAL_RETENTION_STATEMENT_BINDING } });
  assert.ok(response);
  for (const validateConfirmation of [() => false, () => { throw new Error('Caller denies proof'); }]) {
    const f = fixture({ validateConfirmation }), held = f.hold(grantIntent('denied-control'));
    held.report(confirmed(response)); assert.equal(only(f).effect, 'unknown');
  }
});

test('current reads cannot become control receipts even when a caller validator returns true', () => {
  const f = fixture({ validateConfirmation: () => true }), held = f.hold(grantIntent('current-is-not-receipt'));
  held.report(confirmed({ schema: retention.MANUAL_RETENTION_CURRENT_RESULT_SCHEMA,
    current: { decisionId: decisionA, state: 'granted', revision: 1, statement: retention.MANUAL_RETENTION_STATEMENT_BINDING } }));
  assert.equal(only(f).effect, 'unknown');
});

test('custody does not retain dispatch callbacks alongside immutable attempt authority', () => {
  const f = fixture();
  assert.throws(() => f.owner.hold({ ...access, ...createIntent('no-retained-callback') }, {
    manualRetention: authority(decisionA), assertCurrent() { assert.fail('Custody must not invoke a dispatch callback'); },
  }), { code: 'invalid_command' });
  assert.deepEqual(f.owner.snapshot(access), []);
});
