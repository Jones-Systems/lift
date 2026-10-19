const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const ts = require('typescript');

const appRoot = path.resolve(__dirname, '../..');
const repository = path.resolve(appRoot, '../../..');
const apiRoot = path.join(repository, 'services/api');
const origin = 'https://manual-progress.synthetic.invalid';
const password = 'Synthetic-manual-progress-password-12345';
const endpoint = '/v1/body/measurements';
const fullSelection = Object.freeze({ mode: 'source-only', modules: 'usage-bug-training-feedback-source-prescription-and-board-correction' });

// One cache composes actual APP modules; only the native singleton client boundary is replaced.
function appLoader() {
  const cache = new Map();
  function load(name) {
    let file = path.resolve(appRoot, name);
    if (!fs.existsSync(file)) file += fs.existsSync(file + '.ts') ? '.ts' : '.tsx';
    else if (fs.statSync(file).isDirectory()) file = path.join(file, 'index.ts');
    assert.ok(file.startsWith(appRoot + path.sep));
    if (path.relative(appRoot, file) === path.join('api', 'client.ts')) return { ...load('api/transport.ts'), formApi: null };
    if (cache.has(file)) return cache.get(file).exports;
    const module = { exports: {} }; cache.set(file, module);
    const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { fileName: file, compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
    } }).outputText;
    new Function('require', 'module', 'exports', code)(name => {
      assert.ok(name.startsWith('.'), `Unexpected APP runtime dependency: ${name}`);
      return load(path.relative(appRoot, path.resolve(path.dirname(file), name)));
    }, module, module.exports);
    return module.exports;
  }
  return load;
}
const load = appLoader();
const { FormTransport } = load('api/transport.ts');
const { FormResources } = load('api/resources.ts');
const { createManualProgressSession } = load('integration/manualProgressSession.ts');
const { createCommandOwnerRegistry } = load('integration/commandOwnerSession.ts');
const { validateManualCommandConfirmation } = load('body/manualCommandConfirmation.ts');
const { validateManualRetentionCommandConfirmation } = load('body/manualRetentionConfirmation.ts');
const contract = load('body/manualRetentionContract.ts');
const validateConfirmation = (intent, response) => intent.operation === 'grant_manual_retention' || intent.operation === 'revoke_manual_retention'
  ? validateManualRetentionCommandConfirmation(intent, response) : validateManualCommandConfirmation(intent, response);
const sha = value => createHash('sha256').update(value).digest('hex');
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const tick = () => new Promise(setImmediate);

// The root qualifies fresh dist against its exact source inventory; an old build is not implementation evidence.
async function apiInputs(t) {
  const files = ['src/server.ts', 'src/body/measurements.ts', 'src/runtime-modules/migrations.ts',
    'src/integration/account-modules/migrations.ts', 'dist/src/server.js', 'dist/src/body/measurements.js',
    'dist/src/runtime-modules/migrations.js', 'dist/src/integration/account-modules/migrations.js',
    ...['body/manual-retention', 'body/manual-retention-contract', 'body/manual-retention-migration', 'body/routes', 'source-reported-load-migration']
      .flatMap(name => ['src/' + name + '.ts', 'dist/src/' + name + '.js'])];
  const inventory = files.map(file => ({ file, sha256: sha(fs.readFileSync(path.join(apiRoot, file))) }));
  const identity = sha(JSON.stringify(inventory));
  t.diagnostic(`Manual HTTP API input inventory ${identity}: ${JSON.stringify(inventory)}`);
  // Canonical module URLs preserve the factory identity checked by createServer's source23 admission.
  const importInput = file => import(pathToFileURL(path.join(apiRoot, 'dist/src', file)).href);
  const [server, measurements, migrations, selector, storage, retention, reportedLoad] = await Promise.all([
    importInput('server.js'), importInput('body/measurements.js'), importInput('runtime-modules/migrations.js'),
    importInput('integration/account-modules/migrations.js'), importInput('storage.js'),
    importInput('body/manual-retention-migration.js'), importInput('source-reported-load-migration.js'),
  ]);
  return { ...server, ...measurements, ...migrations, ...selector, ...retention, ...reportedLoad, hash: storage.hash };
}

function localRetain(controller) {
  const fence = controller.captureFence(); assert.ok(fence);
  controller.chooseProcessing(fence); controller.chooseDerivedRetention(contract.MANUAL_RETENTION_PROTOCOL, fence);
  return fence;
}
const grantCommand = (decisionId = randomUUID(), key = 'grant-' + decisionId) => ({ key, payload: {
  decisionId, processing: 'manual_entry', purpose: 'personal_measurement_progress', choice: 'retain',
  statementId: 'manual-personal-progress', statementVersion: 1, statementSha256: contract.MANUAL_RETENTION_STATEMENT_SHA256,
} });
async function grant(controller) {
  const fence = localRetain(controller);
  const result = await controller.grantRetention(grantCommand(), fence);
  assert.equal(result.effect, 'confirmed');
  controller.acknowledgeCommand(result.id);
  return controller.captureFence();
}
const waist = Object.freeze({ kind: 'waist', value: 30, unit: 'in', measuredOn: '2026-10-10', note: '  Synthetic original waist  ' });
const command = (key, payload = waist) => ({ key, payload: { ...payload } });

async function fixture(t, run) {
  const inputs = await apiInputs(t);
  t.signal.throwIfAborted();
  const parent = path.join(repository, '.scratch'); fs.mkdirSync(parent, { recursive: true });
  const ownedRoot = fs.mkdtempSync(path.join(parent, 'manual-progress-http-'));
  const dbPath = path.join(ownedRoot, 'synthetic.sqlite');
  let backend, construction, cleanupResult, stopping = false;
  const requests = new Set(), operations = new Set(), presentations = new Set(), gates = new Set(), rules = new Map();
  const calls = [], registry = createCommandOwnerRegistry(validateConfirmation);
  const records = new Map(); let sequence = 0;
  const ledger = { currentSequence: () => sequence, lookup: id => records.get(id) ?? null,
    reconcileRestore: apply => { for (const value of records.values()) apply(value); return sequence; },
    recordDisable: value => { const record = { ...value, sequence: ++sequence }; records.set(value.accountId, record); return record; } };
  const track = (set, promise) => { set.add(promise); void promise.then(() => set.delete(promise), () => set.delete(promise)); return promise; };
  const cleanup = () => cleanupResult ??= (async () => {
    stopping = true;
    const failures = [];
    for (const gate of gates) gate.release();
    for (const presentation of presentations) {
      try { presentation.dispose(); } catch (error) { failures.push(error); }
    }
    try { if (construction) backend = await construction; } catch { /* Startup failure remains the test's primary result. */ }
    while (operations.size || requests.size) await Promise.allSettled([...operations, ...requests]);
    try { if (backend) await backend.close(false); } catch (error) { failures.push(error); }
    try {
      assert.equal(backend?.db.open ?? false, false, 'Actual backend must close before removing its owned database');
      fs.rmSync(ownedRoot, { recursive: true, force: true }); assert.equal(fs.existsSync(ownedRoot), false);
    }
    catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, 'Exact manual HTTP scratch cleanup failed');
  })();
  const interrupt = () => { void cleanup().then(() => process.exit(130), error => { process.stderr.write(String(error)); process.exit(130); }); };
  const terminate = () => { void cleanup().then(() => process.exit(143), error => { process.stderr.write(String(error)); process.exit(143); }); };
  const cancel = () => { void cleanup().catch(() => {}); };
  process.once('SIGINT', interrupt); process.once('SIGTERM', terminate); t.signal.addEventListener('abort', cancel, { once: true });
  let primary, failed = false;
  try {
    construction = inputs.createServer({ dbPath, baseURL: origin, secret: 'synthetic-manual-http-secret-longer-than-32-characters',
      registration: { mode: 'allowlist', emails: ['one@synthetic.invalid', 'two@synthetic.invalid'] },
      lifecycle: { ledger }, moduleMigrations: inputs.moduleMigrations,
      sourceRequestFactories: { mode: 'source-only', communityModules: 'b2-b4-b5' },
      sourceAccountModules: fullSelection, sourceBodyMeasurements: inputs.createManualMeasurements,
      sourceManualRetention: 'selected-migration-23' });
    backend = await construction;
    if (stopping) throw new Error('Manual HTTP fixture is closing');
    const genuineSourceMigrations = inputs.selectAccountModuleMigrations(fullSelection, inputs.runtimeMigrations);
    assert.deepEqual(genuineSourceMigrations.map(value => value.version), Array.from({ length: 20 }, (_, i) => i + 1));
    assert.deepEqual(backend.db.prepare('SELECT version,checksum FROM form_migrations ORDER BY version').all(),
      [...genuineSourceMigrations, { version: 21, sql: inputs.manualMeasurementMigrationSql }, inputs.sourceManualRetentionMigration].map(value => ({ version: value.version, checksum: inputs.hash(value.sql) })));
    assert.equal(inputs.hash(inputs.manualMeasurementMigrationSql), '5165c125d7bd499e7531a891abd593bad1d42ff8a0ff16fa88f90c364ff026f0');
    assert.equal(inputs.hash(inputs.sourceReportedLoadMigration.sql), 'b027ac49e4b5cc4eeb4a28aa5ade142b73e415fff02f3a88c620ea76936de771');
    assert.equal(inputs.hash(inputs.sourceManualRetentionMigration.sql), '88b9adec59474908695c044351683f72f38e28fe30811a9e7e3a2e5d5287aa66');
    assert.equal(backend.db.prepare('SELECT 1 FROM form_migrations WHERE version=22').get(), undefined);
    assert.equal(backend.lifecycle.adapters.filter(value => value.category === 'body').length, 1);
    assert.equal(backend.db.pragma('foreign_keys', { simple: true }), 1);
    assert.deepEqual(backend.db.pragma('foreign_key_check'), []);
    assert.ok(backend.migrationBackups.every(file => file.startsWith(ownedRoot + path.sep)));

    function dispatch(label, url, init = {}) {
      return track(requests, (async () => {
        if (stopping) throw new Error('Manual HTTP fixture is closing');
        const request = new Request(url, init), parsed = new URL(request.url);
        assert.equal(parsed.origin, origin);
        const call = { label, path: parsed.pathname + parsed.search, method: request.method,
          retention: request.headers.get(contract.MANUAL_RETENTION_HEADER), key: request.headers.get('idempotency-key'), authorization: request.headers.get('authorization'),
          body: request.method === 'GET' ? undefined : await request.clone().json(), status: null, response: undefined };
        calls.push(call);
        const ruleKey = label + ':' + call.method + ':' + call.path;
        const rule = rules.get(ruleKey);
        if (rule) rules.delete(ruleKey);
        if (rule?.before) { rule.entered.resolve(call); if (!stopping) await rule.delivery.promise; }
        const response = await backend.app.fetch(request);
        call.status = response.status; call.response = await response.clone().json();
        call.authToken = response.headers.get('set-auth-token');
        if (rule && !rule.before) {
          rule.entered.resolve(call);
          if (rule.lose) throw new Error('Synthetic loss of delivery after the actual backend response');
          if (!stopping) await rule.delivery.promise;
        }
        return response;
      })());
    }
    async function account(name) {
      let envelope = null;
      const storage = { async load() { return envelope; }, async save(value) { envelope = value; }, async clear() { envelope = null; } };
      const api = new FormTransport(origin, storage, (url, init) => dispatch(name, url, init));
      await api.signUp('Synthetic ' + name, name + '@synthetic.invalid', password);
      const signup = calls.at(-1);
      assert.equal(signup.path, '/api/auth/sign-up/email'); assert.equal(signup.method, 'POST');
      assert.ok(signup.status >= 200 && signup.status < 300); assert.ok(signup.authToken);
      assert.equal(JSON.parse(envelope).token, signup.authToken);
      const resources = new FormResources(api), value = await resources.account();
      const me = calls.at(-1);
      assert.equal(me.path, '/v1/me'); assert.equal(me.method, 'GET'); assert.equal(me.status, 200);
      assert.equal(me.authorization, 'Bearer ' + signup.authToken);
      assert.ok(value.accountId);
      const originalAuth = api.captureAuthContext(), generation = value.accountId + ':manual-http:1';
      const host = { current: true }, current = () => host.current && originalAuth.isCurrent();
      const selection = { accountId: value.accountId, sessionGeneration: generation, resources, originalAuth, isCurrentSession: current };
      const owner = registry.forSession(selection); assert.ok(owner);
      return { name, api, resources, value, owner, host, current, originalAuth, selection,
        access: { accountId: value.accountId, sessionGeneration: generation },
        storedToken: () => JSON.parse(envelope).token };
    }
    const one = await account('one'), two = await account('two');
    assert.notEqual(one.value.accountId, two.value.accountId); assert.notEqual(one.storedToken(), two.storedToken());
    const retainPresentation = session => {
      if (stopping) { session.dispose(); throw new Error('Manual HTTP fixture is closing'); }
      presentations.add(session); return session;
    };
    const presentation = account => {
      const session = createManualProgressSession({ account: account.value, resources: account.resources,
        sessionGeneration: account.selection.sessionGeneration, isCurrentSession: account.current, commandOwner: account.owner });
      return retainPresentation(session);
    };
    const heldRequest = (account, route = endpoint, { lose = false, before = false } = {}) => {
      if (stopping) throw new Error('Manual HTTP fixture is closing');
      const ruleKey = account.name + ':POST:' + route;
      assert.equal(rules.has(ruleKey), false);
      const entered = deferred(), delivery = deferred();
      const gate = { entered, delivery, lose, before, release: () => delivery.resolve(),
        wait: flight => Promise.race([entered.promise, flight.then(() => { throw new Error('Actual request settled without reaching held backend delivery'); })]) };
      gates.add(gate); rules.set(ruleKey, gate); return gate;
    };
    const heldCreate = (account, lose = false) => heldRequest(account, endpoint, { lose });
    const controls = account => calls.filter(call => call.label === account.name && call.path.startsWith('/v1/body/manual-retention'));
    const rows = account => backend.db.prepare('SELECT * FROM body_manual_measurements WHERE account_id=? ORDER BY id').all(account.value.accountId);
    const receipts = account => backend.db.prepare('SELECT * FROM body_manual_receipts WHERE account_id=? ORDER BY key').all(account.value.accountId);
    const writes = account => calls.filter(call => call.label === account.name && call.method === 'POST' && call.path.startsWith(endpoint));
    await run({ backend, calls, registry, one, two, presentation, retainPresentation, heldCreate, heldRequest, controls, rows, receipts, writes,
      operation: promise => track(operations, promise) });
  } catch (error) { failed = true; primary = error; }
  finally {
    try { await cleanup(); } catch (error) {
      if (failed) throw new AggregateError([primary, error], 'Manual HTTP assertion and exact scratch cleanup failed');
      throw error;
    } finally {
      process.off('SIGINT', interrupt); process.off('SIGTERM', terminate); t.signal.removeEventListener('abort', cancel);
    }
  }
  if (failed) throw primary;
}

test('manual HTTP actual eight-field measurements normalize original units and confirm original custody', { timeout: 30000 }, t => fixture(t, async f => {
  const session = f.presentation(f.one); assert.equal(f.writes(f.one).length, 0);
  const controller = session.create(); assert.equal(session.create(), controller);
  assert.equal(controller.snapshot().retention.choices.derived.choice, 'unset');
  assert.throws(() => controller.create(command('denied-without-consent'), controller.captureFence()), { code: 'body_command_not_started' });
  controller.chooseProcessing(controller.captureFence());
  assert.throws(() => controller.create(command('denied-processing-only'), controller.captureFence()), { code: 'body_command_not_started' });
  assert.equal(f.writes(f.one).length, 0); assert.equal(f.rows(f.one).length, 0); assert.equal(f.receipts(f.one).length, 0);
  localRetain(controller);
  assert.throws(() => controller.create(command('denied-local-choice-only'), controller.captureFence()), { code: 'body_command_not_started' });
  const fence = await f.operation(grant(controller));
  const inputs = [waist, { kind: 'hips', value: 90, unit: 'cm', measuredOn: '2026-10-11' },
    { kind: 'weight', value: 100, unit: 'lb', measuredOn: '2026-10-11', note: '  Synthetic pounds  ' },
    { kind: 'weight', value: 80, unit: 'kg', measuredOn: '2026-10-12' }];
  for (const [index, payload] of inputs.entries()) {
    const original = command('actual-unit-' + index, payload);
    const result = await f.operation(controller.create(original, fence));
    assert.equal(result.effect, 'confirmed'); assert.equal(result.attempts, 1);
    const call = f.writes(f.one).at(-1), response = call.response;
    assert.equal(call.status, 201); assert.equal(call.key, original.key);
    assert.equal(contract.parseManualRetentionHeader(call.retention)?.decisionId, controller.snapshot().retention.manualDecision.decisionId);
    assert.equal(call.authorization, 'Bearer ' + f.one.storedToken()); assert.deepEqual(call.body, original.payload);
    assert.deepEqual(Object.keys(response).sort(), ['id', 'kind', 'measuredOn', 'note', 'originalUnit', 'provenance', 'unit', 'value']);
    assert.match(response.id, /^[0-9a-f-]{36}$/i);
    assert.equal(response.value, payload.value * (payload.unit === 'in' ? 2.54 : payload.unit === 'lb' ? 0.45359237 : 1));
    assert.equal(response.unit, payload.kind === 'weight' ? 'kg' : 'cm'); assert.equal(response.originalUnit, payload.unit);
    assert.equal(response.measuredOn, payload.measuredOn); assert.equal(response.note, payload.note?.trim() ?? null);
    assert.equal(response.provenance, 'manual_reported');
    assert.equal(validateManualCommandConfirmation({ operation: 'save_manual_measurement', command: original }, response), true);
    const receipt = f.receipts(f.one).find(value => value.key === original.key);
    assert.ok(receipt); assert.equal(receipt.account_id, f.one.value.accountId);
    assert.equal(receipt.measurement_id, response.id); assert.equal(receipt.operation, 'create');
    assert.equal(receipt.intent_hash, sha(JSON.stringify({ operation: 'create', input: {
      ...original.payload, ...(payload.note === undefined ? {} : { note: payload.note.trim() }),
    } })));
    assert.equal(f.one.owner.reconcile(f.one.access, result.id).snapshot().effect, 'confirmed');
  }
  assert.equal(f.rows(f.one).length, 4); assert.equal(f.receipts(f.one).length, 4); assert.equal(f.rows(f.two).length, 0);
  await f.operation(controller.loadProgress({ from: '2026-10-11', to: '2026-10-11' }));
  assert.equal(controller.snapshot().progress.status, 'data'); assert.equal(controller.snapshot().progress.items.length, 2);
  assert.ok(f.calls.some(call => call.path === endpoint + '?from=2026-10-11&to=2026-10-11' && call.method === 'GET'));
}));

test('manual HTTP committed but undelivered create recovers exact key and explicitly retries one UUID', { timeout: 30000 }, t => fixture(t, async f => {
  const firstSession = f.presentation(f.one), first = firstSession.create(), original = command('lost-delivery-original');
  f.heldCreate(f.one, true);
  const unknown = await f.operation(first.create(original, await grant(first)));
  assert.equal(unknown.effect, 'unknown'); assert.equal(unknown.retryAvailable, true);
  assert.equal(f.rows(f.one).length, 1); assert.equal(f.receipts(f.one).length, 1); const id = f.rows(f.one)[0].id;
  await tick(); assert.equal(f.writes(f.one).length, 1);
  firstSession.dispose(); const reopened = f.presentation(f.one), next = reopened.create();
  assert.notEqual(next, first); assert.equal(f.registry.forSession(f.one.selection), f.one.owner);
  assert.equal(next.snapshot().retention.choices.derived.choice, 'unset');
  assert.deepEqual(next.recoverCommand(unknown.id).intent.command, original);
  assert.throws(() => next.retryCommand(unknown.id, next.captureFence()), { code: 'body_command_not_started' });
  assert.equal(f.writes(f.one).length, 1);
  const retry = await f.operation(next.retryCommand(unknown.id, await grant(next)));
  assert.equal(retry.effect, 'confirmed'); assert.equal(retry.attempts, 2);
  const [before, after] = f.writes(f.one); assert.equal(after.key, before.key); assert.deepEqual(after.body, before.body);
  assert.deepEqual(after.response, before.response); assert.equal(after.response.id, id);
  assert.equal(f.rows(f.one).length, 1); assert.equal(f.receipts(f.one).length, 1);
}));

test('manual HTTP actual revoke blocks future APP writes without deleting; explicit fresh-key delete proves and replays only that row', { timeout: 30000 }, t => fixture(t, async f => {
  const controller = f.presentation(f.one).create();
  const created = await f.operation(controller.create(command('create-before-revoke'), await grant(controller)));
  const id = f.rows(f.one)[0].id, before = f.writes(f.one).length;
  const decisionId = controller.snapshot().retention.manualDecision.decisionId;
  const revoked = await f.operation(controller.revokeRetention({ decisionId, key: 'actual-revoke', payload: {} }, controller.captureFence()));
  assert.equal(revoked.effect, 'confirmed');
  const current = await f.operation(controller.refreshRetention(decisionId, controller.captureFence()));
  assert.equal(current.current.state, 'revoked');
  assert.equal(controller.snapshot().retention.choices.derived.choice, 'session_only');
  assert.throws(() => controller.create(command('denied-after-revoke'), controller.captureFence()), { code: 'body_command_not_started' });
  await tick(); assert.equal(f.writes(f.one).length, before); assert.equal(f.rows(f.one).length, 1);
  const deletion = { id, key: 'explicit-delete-new-key', payload: {} };
  const removed = await f.operation(controller.delete(deletion, controller.captureFence()));
  assert.equal(removed.effect, 'confirmed'); assert.equal(controller.snapshot().retention.deletion.derived.status, 'confirmed');
  assert.equal(f.rows(f.one).length, 0); assert.equal(f.receipts(f.one).length, 2);
  const call = f.writes(f.one).at(-1); assert.equal(call.path, endpoint + '/' + id + '/delete');
  assert.equal(call.key, deletion.key); assert.deepEqual(call.body, {}); assert.deepEqual(call.response, { deleted: true });
  assert.notEqual(call.key, f.writes(f.one)[0].key);
  assert.equal(f.one.owner.reconcile(f.one.access, created.id).snapshot().effect, 'confirmed');
  controller.acknowledgeCommand(removed.id);
  const replay = await f.operation(controller.delete(deletion, controller.captureFence()));
  assert.equal(replay.effect, 'confirmed'); assert.deepEqual(f.writes(f.one).at(-1).response, { deleted: true });
  assert.equal(f.rows(f.one).length, 0); assert.equal(f.receipts(f.one).length, 2);
}));

test('manual HTTP same key is account scoped and B cannot list or delete A', { timeout: 30000 }, t => fixture(t, async f => {
  const a = f.presentation(f.one).create(), b = f.presentation(f.two).create();
  await f.operation(a.create(command('two-account-shared'), await grant(a)));
  await f.operation(b.create(command('two-account-shared', { kind: 'weight', value: 80, unit: 'kg', measuredOn: '2026-10-11' }), await grant(b)));
  const aId = f.rows(f.one)[0].id, bId = f.rows(f.two)[0].id; assert.notEqual(aId, bId);
  await f.operation(a.loadProgress()); await f.operation(b.loadProgress());
  assert.deepEqual(a.snapshot().progress.items.map(row => row.id), [aId]);
  assert.deepEqual(b.snapshot().progress.items.map(row => row.id), [bId]);
  const foreign = await f.operation(b.delete({ id: aId, key: 'B-cannot-delete-A', payload: {} }, b.captureFence()));
  assert.equal(foreign.effect, 'not_applied'); assert.equal(f.writes(f.two).at(-1).status, 404);
  assert.equal(f.rows(f.one).length, 1); assert.equal(f.rows(f.two).length, 1); assert.equal(f.receipts(f.two).length, 1);
  assert.equal(f.writes(f.one)[0].authorization, 'Bearer ' + f.one.storedToken());
  assert.equal(f.writes(f.two)[0].authorization, 'Bearer ' + f.two.storedToken());
}));

test('manual HTTP presentation closes after actual commit but original late delivery confirms same custody on reopen', { timeout: 30000 }, t => fixture(t, async f => {
  const session = f.presentation(f.one), old = session.create(), original = command('late-after-disposal');
  const gate = f.heldCreate(f.one), flight = f.operation(old.create(original, await grant(old)));
  const delivered = await gate.wait(flight); assert.equal(delivered.status, 201); assert.equal(f.rows(f.one).length, 1);
  const pending = f.one.owner.snapshot(f.one.access)[0]; assert.equal(pending.locallyPending, 1);
  session.dispose(); assert.equal(old.snapshot().active, false); assert.equal(session.create(), null); assert.equal(f.one.current(), true);
  assert.equal(f.one.owner.snapshot(f.one.access)[0].locallyPending, 1);
  const next = f.presentation(f.one).create(); assert.notEqual(next, old);
  assert.equal(next.snapshot().retention.choices.derived.choice, 'unset');
  assert.deepEqual(next.recoverCommand(pending.id).intent.command, original);
  assert.throws(() => next.retryCommand(pending.id, next.captureFence()), { code: 'body_command_not_started' });
  const renewed = await grant(next);
  assert.throws(() => next.retryCommand(pending.id, renewed), { code: 'attempt_pending' });
  assert.equal(f.writes(f.one).length, 1);
  gate.release(); assert.equal(await flight, null);
  const confirmation = f.one.owner.reconcile(f.one.access, pending.id).snapshot();
  assert.equal(confirmation.effect, 'confirmed'); assert.equal(confirmation.locallyPending, 0);
  assert.equal(next.recoverCommand(pending.id).metadata.effect, 'confirmed');
  await f.operation(next.loadProgress()); assert.equal(next.snapshot().progress.items[0].id, delivered.response.id);
  assert.equal(f.writes(f.one).length, 1); assert.equal(f.receipts(f.one).length, 1);
}));

test('manual HTTP auth replacement during held delivery cannot display retry or acknowledge original liability on B', { timeout: 30000 }, t => fixture(t, async f => {
  const session = f.presentation(f.one), old = session.create(), gate = f.heldCreate(f.one);
  const flight = f.operation(old.create(command('auth-replaced-original'), await grant(old)));
  const committed = await gate.wait(flight), pending = f.one.owner.snapshot(f.one.access)[0];
  const originalLiabilityCleanup = f.registry.captureCleanup(f.one.selection, []);
  assert.equal(committed.status, 201); assert.equal(f.rows(f.one).length, 1);
  const originalBearer = committed.authorization;
  await f.one.api.signIn('two@synthetic.invalid', password);
  assert.equal(f.one.originalAuth.isCurrent(), false); assert.notEqual('Bearer ' + f.one.storedToken(), originalBearer);
  gate.release(); assert.equal(await flight, null);
  assert.equal(old.snapshot().active, false); assert.equal(old.snapshot().progress.status, 'idle'); assert.equal(session.create(), null);
  assert.throws(() => old.recoverCommand(pending.id), { code: 'body_command_not_started' });
  assert.throws(() => old.retryCommand(pending.id, old.captureFence()), { code: 'body_command_not_started' });
  assert.throws(() => old.acknowledgeCommand(pending.id), { code: 'body_command_not_started' });
  assert.throws(() => f.one.owner.snapshot(f.one.access), { code: 'session_changed' });
  assert.throws(() => f.one.owner.acknowledge(f.one.access, pending.id), { code: 'session_changed' });
  await assert.rejects(originalLiabilityCleanup(), /cleanup is incomplete/);
  assert.equal(f.registry.forSession(f.one.selection), null);
  const replacementAccount = await f.one.resources.account(); assert.equal(replacementAccount.accountId, f.two.value.accountId);
  const auth = f.one.api.captureAuthContext(), generation = replacementAccount.accountId + ':manual-http:replacement';
  const current = () => auth.isCurrent();
  const replacementOwner = f.registry.forSession({ accountId: replacementAccount.accountId, resources: f.one.resources,
    sessionGeneration: generation, originalAuth: auth, isCurrentSession: current });
  assert.ok(replacementOwner);
  const access = { accountId: replacementAccount.accountId, sessionGeneration: generation };
  assert.deepEqual(replacementOwner.snapshot(access), []);
  assert.throws(() => replacementOwner.reconcile(access, pending.id), { code: 'custody_missing' });
  assert.throws(() => replacementOwner.acknowledge(access, pending.id), { code: 'custody_missing' });
  const replacementSession = f.retainPresentation(createManualProgressSession({ account: replacementAccount, resources: f.one.resources,
    sessionGeneration: generation, isCurrentSession: current, commandOwner: replacementOwner }));
  const next = replacementSession.create();
  try { await f.operation(next.loadProgress()); assert.equal(next.snapshot().progress.status, 'empty'); }
  finally { replacementSession.dispose(); }
  assert.equal(f.writes(f.one).length, 1); assert.equal(f.rows(f.one).length, 1); assert.equal(f.rows(f.two).length, 0);
  assert.equal(f.receipts(f.one).length, 1); assert.deepEqual(f.two.owner.snapshot(f.two.access), []);
}));

test('manual HTTP invalid civil date reaches actual API422 and settles not applied with no rows or receipts', { timeout: 30000 }, t => fixture(t, async f => {
  const controller = f.presentation(f.one).create();
  const result = await f.operation(controller.create(command('invalid-date-actual-api', { ...waist, measuredOn: '2026-02-30' }), await grant(controller)));
  assert.equal(result.effect, 'not_applied'); assert.equal(result.retryAvailable, false);
  const call = f.writes(f.one)[0]; assert.equal(call.status, 422); assert.equal(call.response.error.code, 'body_invalid_input');
  assert.equal(controller.snapshot().writes.error.status, 422);
  assert.equal(f.rows(f.one).length, 0); assert.equal(f.receipts(f.one).length, 0);
  assert.equal(f.one.owner.reconcile(f.one.access, result.id).snapshot().effect, 'not_applied');
  await tick(); assert.equal(f.writes(f.one).length, 1);
}));

test('manual HTTP retention controls use authenticated receipts; current reads and another account grant no local authority', { timeout: 30000 }, t => fixture(t, async f => {
  const session = f.presentation(f.one), controller = session.create(), original = grantCommand();
  const fence = localRetain(controller), pendingId = original.payload.decisionId;
  const absent = await f.operation(controller.refreshRetention(pendingId, fence));
  assert.deepEqual(absent, { schema: contract.MANUAL_RETENTION_CURRENT_RESULT_SCHEMA, current: null });
  assert.equal(controller.snapshot().retention.manualDecision, null);
  assert.throws(() => controller.create(command('read-is-not-a-grant'), fence), { code: 'body_command_not_started' });
  const result = await f.operation(controller.grantRetention(original, fence));
  assert.equal(result.effect, 'confirmed');
  const issued = f.controls(f.one).find(call => call.method === 'POST');
  assert.equal(issued.path, '/v1/body/manual-retention'); assert.equal(issued.key, original.key);
  assert.equal(issued.authorization, 'Bearer ' + f.one.storedToken()); assert.equal(issued.retention, null);
  assert.deepEqual(issued.body, original.payload); assert.equal(issued.response.receipt.outcome, 'granted');
  assert.equal(validateManualRetentionCommandConfirmation({ operation: 'grant_manual_retention', command: original }, issued.response), true);
  const current = await f.operation(controller.refreshRetention(pendingId, controller.captureFence()));
  assert.equal(current.current.state, 'granted');
  assert.equal(validateConfirmation({ operation: 'grant_manual_retention', command: original }, current), false);
  const other = f.presentation(f.two).create();
  assert.deepEqual(await f.operation(other.refreshRetention(pendingId, other.captureFence())),
    { schema: contract.MANUAL_RETENTION_CURRENT_RESULT_SCHEMA, current: null });
  assert.equal(other.snapshot().retention.choices.derived.choice, 'unset');
  const row = f.backend.db.prepare('SELECT * FROM body_manual_retention_decisions WHERE account_id=? AND decision_id=?').get(f.one.value.accountId, pendingId);
  assert.equal(row.state, 'granted'); assert.equal(row.revision, 1); assert.equal(row.statement_sha256, contract.MANUAL_RETENTION_STATEMENT_SHA256);
  assert.ok(row.auth_user_id); assert.ok(row.session_id); assert.ok(Number.isSafeInteger(row.epoch));
  assert.equal(f.backend.db.prepare('SELECT count(*) n FROM body_manual_retention_receipts WHERE account_id=?').get(f.one.value.accountId).n, 1);
  assert.equal(f.rows(f.one).length, 0); assert.equal(f.receipts(f.one).length, 0);
  assert.equal(controller.snapshot().retention.choices.photos.choice, 'unset');
  assert.deepEqual(controller.snapshot().retention.deletion.photos, { status: 'unavailable' });
  session.dispose(); const reopened = f.presentation(f.one).create();
  assert.equal(reopened.snapshot().retention.choices.derived.choice, 'unset');
  await f.operation(reopened.refreshRetention(pendingId, reopened.captureFence()));
  assert.equal(reopened.snapshot().retention.manualDecision, null);
  assert.throws(() => reopened.create(command('reopen-read-is-not-consent'), reopened.captureFence()), { code: 'body_command_not_started' });
  assert.equal(reopened.recoverCommand(result.id).metadata.effect, 'confirmed');
  assert.equal(f.writes(f.one).length, 0);
}));

test('manual HTTP null-authority reconciliation replays the original committed measurement after actual revoke', { timeout: 30000 }, t => fixture(t, async f => {
  const session = f.presentation(f.one), controller = session.create(), original = command('null-authority-original');
  const fence = await grant(controller), decisionId = controller.snapshot().retention.manualDecision.decisionId;
  f.heldCreate(f.one, true);
  const unknown = await f.operation(controller.create(original, fence)); assert.equal(unknown.effect, 'unknown');
  const initial = f.writes(f.one)[0], id = f.rows(f.one)[0].id;
  const revoked = await f.operation(controller.revokeRetention({ decisionId, key: 'revoke-before-reconcile', payload: {} }, controller.captureFence()));
  assert.equal(revoked.effect, 'confirmed'); assert.equal(f.rows(f.one).length, 1);
  session.dispose(); const next = f.presentation(f.one).create();
  assert.equal(next.snapshot().retention.choices.derived.choice, 'unset');
  assert.deepEqual(next.recoverCommand(unknown.id).intent.command, original);
  assert.throws(() => next.retryCommand(unknown.id, next.captureFence()), { code: 'body_command_not_started' });
  const replay = await f.operation(next.reconcileCommand(unknown.id, next.captureFence()));
  assert.equal(replay.effect, 'confirmed'); assert.equal(replay.attempts, 2);
  const last = f.writes(f.one).at(-1);
  assert.equal(last.retention, null); assert.ok(initial.retention);
  assert.equal(last.key, initial.key); assert.deepEqual(last.body, initial.body);
  assert.equal(last.authorization, initial.authorization); assert.deepEqual(last.response, initial.response); assert.equal(last.response.id, id);
  assert.equal(next.snapshot().retention.choices.derived.choice, 'unset'); assert.equal(next.snapshot().retention.manualDecision, null);
  assert.equal(f.rows(f.one).length, 1); assert.equal(f.receipts(f.one).length, 1);
  const attribution = f.backend.db.prepare('SELECT * FROM body_manual_retention_attributions WHERE account_id=?').all(f.one.value.accountId);
  assert.equal(attribution.length, 1); assert.equal(attribution[0].decision_id, decisionId); assert.equal(attribution[0].measurement_id, id);
  assert.equal(attribution[0].measurement_key, original.key);
  await assert.rejects(f.one.api.request(endpoint, 'POST', original.payload, 'new-key-without-authority',
    { manualRetention: null, assertCurrent() { assert.equal(f.one.current(), true); } }), { status: 403, code: 'body_manual_retention_required' });
  assert.equal(f.rows(f.one).length, 1); assert.equal(f.receipts(f.one).length, 1);
}));

test('manual HTTP deleted original result stays unknown on null-authority reconciliation and cannot recreate a row', { timeout: 30000 }, t => fixture(t, async f => {
  const session = f.presentation(f.one), controller = session.create(), original = command('deleted-original');
  const fence = await grant(controller), decisionId = controller.snapshot().retention.manualDecision.decisionId;
  f.heldCreate(f.one, true);
  const unknown = await f.operation(controller.create(original, fence)); assert.equal(unknown.effect, 'unknown');
  const id = f.rows(f.one)[0].id;
  assert.equal((await f.operation(controller.revokeRetention({ decisionId, key: 'revoke-deleted', payload: {} }, controller.captureFence()))).effect, 'confirmed');
  assert.equal((await f.operation(controller.delete({ id, key: 'delete-original-row', payload: {} }, controller.captureFence()))).effect, 'confirmed');
  assert.equal(f.rows(f.one).length, 0); session.dispose();
  const next = f.presentation(f.one).create();
  const result = await f.operation(next.reconcileCommand(unknown.id, next.captureFence()));
  assert.equal(result.effect, 'unknown'); assert.equal(result.attempts, 2);
  const call = f.writes(f.one).at(-1);
  assert.equal(call.status, 404); assert.equal(call.response.error.code, 'body_measurement_not_found');
  assert.equal(call.retention, null); assert.equal(call.key, original.key); assert.deepEqual(call.body, original.payload);
  assert.deepEqual(next.recoverCommand(unknown.id).intent.command, original);
  assert.equal(next.snapshot().writes.error.originalEffectUnknown, true);
  assert.equal(f.rows(f.one).length, 0); assert.equal(f.receipts(f.one).length, 2);
  const cleanup = f.registry.captureCleanup(f.one.selection, []);
  await assert.rejects(cleanup(), /cleanup is incomplete/);
}));

test('manual HTTP revoke before delayed grant is terminal and original receipt recovery cannot revive retention', { timeout: 30000 }, t => fixture(t, async f => {
  const controller = f.presentation(f.one).create(), original = grantCommand();
  const gate = f.heldRequest(f.one, '/v1/body/manual-retention', { before: true });
  const flight = f.operation(controller.grantRetention(original, localRetain(controller)));
  const issued = await gate.wait(flight);
  assert.equal(issued.status, null); assert.equal(issued.key, original.key);
  const originalId = f.one.owner.snapshot(f.one.access)[0].id;
  const stopped = await f.operation(controller.revokeRetention({ decisionId: original.payload.decisionId, key: 'revoke-ahead-of-grant', payload: {} }, controller.captureFence()));
  assert.equal(stopped.effect, 'confirmed');
  const current = await f.operation(controller.refreshRetention(original.payload.decisionId, controller.captureFence()));
  assert.equal(current.current.state, 'revoked'); assert.equal(current.current.revision, 1); assert.equal(current.current.statement, null);
  gate.release(); const result = await flight;
  assert.equal(result.effect, 'confirmed');
  assert.equal(issued.response.receipt.outcome, 'blocked_by_revocation');
  assert.equal(issued.response.current.state, 'revoked');
  assert.equal(controller.snapshot().retention.choices.derived.choice, 'session_only');
  assert.throws(() => controller.create(command('terminal-grant-no-create'), controller.captureFence()), { code: 'body_command_not_started' });
  assert.equal(controller.recoverCommand(originalId).metadata.effect, 'confirmed');
  assert.deepEqual(controller.recoverCommand(originalId).intent.command, original);
  const reopened = f.presentation(f.one).create();
  assert.equal(reopened.snapshot().retention.choices.derived.choice, 'unset');
  assert.equal(f.rows(f.one).length, 0); assert.equal(f.receipts(f.one).length, 0);
  assert.equal(f.backend.db.prepare('SELECT count(*) n FROM body_manual_retention_receipts WHERE account_id=?').get(f.one.value.accountId).n, 2);
}));

test('manual HTTP stopped unknown grant needs its original receipt after status read; historical success cannot revive permission', { timeout: 30000 }, t => fixture(t, async f => {
  const session = f.presentation(f.one), controller = session.create(), original = grantCommand();
  f.heldRequest(f.one, '/v1/body/manual-retention', { lose: true });
  const unknown = await f.operation(controller.grantRetention(original, localRetain(controller)));
  assert.equal(unknown.effect, 'unknown');
  const initial = f.controls(f.one).find(call => call.method === 'POST');
  assert.equal(initial.response.receipt.outcome, 'granted');
  const current = await f.operation(controller.refreshRetention(original.payload.decisionId, controller.captureFence()));
  assert.equal(current.current.state, 'granted');
  assert.equal(controller.recoverCommand(unknown.id).metadata.effect, 'unknown');
  assert.equal(controller.snapshot().retention.manualDecision.grant, 'unknown');
  assert.throws(() => controller.create(command('current-read-cannot-confirm'), controller.captureFence()), { code: 'body_command_not_started' });
  assert.equal((await f.operation(controller.revokeRetention({ decisionId: original.payload.decisionId,
    key: 'stop-unknown-grant', payload: {} }, controller.captureFence()))).effect, 'confirmed');
  session.dispose(); const next = f.presentation(f.one).create();
  const replay = await f.operation(next.reconcileGrant(unknown.id, next.captureFence()));
  assert.equal(replay.effect, 'confirmed'); assert.equal(replay.attempts, 2);
  const last = f.controls(f.one).filter(call => call.method === 'POST' && call.path === '/v1/body/manual-retention').at(-1);
  assert.equal(last.key, initial.key); assert.deepEqual(last.body, initial.body);
  assert.equal(last.authorization, initial.authorization); assert.equal(last.retention, null);
  assert.deepEqual(last.response.receipt, initial.response.receipt);
  assert.equal(last.response.current.state, 'revoked'); assert.equal(last.response.current.revision, 2);
  assert.equal(next.snapshot().retention.choices.derived.choice, 'unset'); assert.equal(next.snapshot().retention.manualDecision, null);
  assert.throws(() => next.create(command('historical-receipt-cannot-grant'), next.captureFence()), { code: 'body_command_not_started' });
  assert.deepEqual(next.recoverCommand(unknown.id).intent.command, original);
  assert.equal(f.rows(f.one).length, 0); assert.equal(f.receipts(f.one).length, 0);
  assert.equal(f.backend.db.prepare('SELECT count(*) n FROM body_manual_retention_receipts WHERE account_id=?').get(f.one.value.accountId).n, 2);
}));
