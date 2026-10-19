import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fork } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createDomainReadPorts } from '../src/domain-ports.mjs';
import { createFormAdapter } from '../src/index.mjs';
import { createFormMcpHandler } from '../src/mcp-handler.mjs';
import { createFormOAuthResourceHandler } from '../src/oauth-resource.mjs';
import { oauthFixture, oauthRequest, callRequest } from './oauth-fixtures.mjs';
import { admissionDecision, withOwnedScratch, qualifiedApiLock } from '../scripts/check-domain-sqlite.mjs';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = process.env.FORM_CHATGPT_TEST_API_ROOT;
assert.ok(root && dirname(root) === packageRoot && root.startsWith(join(packageRoot, '.scratch-api-')),
  'Run scripts/check-domain-sqlite.mjs: a qualified isolated build is required; this group never skips');
assert.equal(realpathSync(root), root);
const bindingBytes = readFileSync(join(packageRoot, 'tests/api-source-binding.json'));
const provenance = JSON.parse(readFileSync(join(root, 'provenance.json'), 'utf8'));
assert.equal(provenance.sourceRevision, JSON.parse(bindingBytes).sourceRevision);
assert.equal(provenance.bindingSha256, createHash('sha256').update(bindingBytes).digest('hex'));
const load = name => import(pathToFileURL(join(root, 'dist/src', name)).href);
const [{ Domain }, { migrations, hash }, { lifecycleMigration }, { bindSuppressionAuthority }, { createDomainReadDependencies }] =
  await Promise.all([load('domain.js'), load('storage.js'), load('lifecycle/migration.js'), load('lifecycle/guards.js'), load('integration/domain-read.js')]);
const [{ composeAccountMigrations }, { activityMigration }, { communityMigration }, { communityExtensionMigration },
  { featureBoardMigrationVersion, featureBoardMigrationSql }, { selectAccountModuleMigrations, appendSourceReportedLoadMigration },
  { createCanonicalAccountWriter }] = await Promise.all([
  load('lifecycle/composition.js'), load('activity/migration.js'), load('community/migration.js'),
  load('community/extension-migration.js'), load('community/board/migration.js'),
  load('integration/account-modules/migrations.js'), load('integration/account-modules/canonical-writer.js'),
]);
const sourceBase = composeAccountMigrations(activityMigration, communityMigration, {
  extension: communityExtensionMigration, board: { version: featureBoardMigrationVersion, sql: featureBoardMigrationSql },
});
function sourceMigrations(version) {
  const selected = selectAccountModuleMigrations({ mode: 'source-only', modules: version === 19
    ? 'usage-bug-training-feedback-and-source-prescription' : 'usage-bug-training-feedback-source-prescription-and-board-correction' }, sourceBase);
  return version === 22 ? appendSourceReportedLoadMigration(selected) : selected;
}
const Database = createRequire(pathToFileURL(join(root, 'package.json')))('better-sqlite3');
const now = () => 1000;
const identity = (key = 'A') => ({ subject: `auth-${key}`, accountId: `form-${key}`, expiresAtMs: 2000,
  scopes: ['form:workouts:read', 'form:plans:read'] });
const stamp = '2026-10-09T16:00:00.000Z';
const privateValue = 'SYNTHETIC_HEALTH_WEARABLE_PRIVATE';

function seedSourceRecords(db, domain, version) {
  const writer = createCanonicalAccountWriter(db), records = {};
  for (const key of ['A', 'B']) {
    const actor = { accountId: `form-${key}`, authUserId: `auth-${key}`, sessionId: `synthetic-${key}`, epoch: 0 };
    db.prepare('INSERT INTO session(id,userId,token,expiresAt,createdAt,updatedAt) VALUES(?,?,?,?,?,?)')
      .run(actor.sessionId, actor.authUserId, actor.sessionId, Date.now() + 600000, 0, 0);
    const within = effect => writer.lifecycle.withActiveWrite(actor, effect);
    const plan = within(() => domain.createSourcePlan(actor.accountId, {
      schema: 'form.source-prescription-plan/v1', name: `Source ${key}`,
      origin: { kind: 'form-adaptation', id: 'synthetic', revision: 'v1' },
      duration: { kind: 'estimated-range', minMinutes: 10, maxMinutes: 20 },
      items: [{ id: 'source-item', native: { exercise_id: 'native', movement_pattern: 'press', role: 'synthetic',
        sets: 4, rest_seconds: 60, rep_range: [6, 10], notes: [privateValue] },
      registeredDomain: { exerciseId: 'floor-press', variantId: 'synthetic:variant',
        identity: { repository: 'synthetic/repository', revision: 'v1', path: 'fixture', sha256: 'a'.repeat(64), nativeId: 'native' },
        registration: { id: 'synthetic', revision: 'v1', digest: 'b'.repeat(64), bytes: 1 }, recordDigest: 'c'.repeat(64) },
      load: { kind: 'unspecified', basis: 'unknown' } }],
    }));
    const session = within(() => domain.startSession(actor.accountId, plan.id, 1));
    const performances = [{ schema: 'form.source-performance/v1', kind: 'repetitions', reps: 8,
      load: { kind: 'unspecified', basis: 'unknown' } }, ...(version === 22 ? [
      { state: 'knownValue', value: 0, unit: 'lb', basis: 'total' },
      { state: 'knownValue', value: 22, unit: 'lb', basis: 'assistance' },
      { state: 'knownValue', value: 12, unit: 'kg', basis: 'perSide' },
    ].map(load => ({ schema: 'form.source-performance/v2', kind: 'repetitions', reps: 8, load })) : [])];
    for (const [index, performance] of performances.entries()) {
      const saved = within(() => domain.createSet(actor.accountId, session.id, {
        schema: performance.schema.replace('source-performance', 'source-performed-set'), performance,
        expectedRevision: domain.session(actor.accountId, session.id).revision,
        occurrenceId: session.occurrences[0].id, setNumber: index + 1, status: 'confirmed',
      }));
      if (index === performances.length - 1) within(() => domain.voidSet(actor.accountId, session.id, saved.set.id, 1));
    }
    // Keep both confirmed and voided v1 records in the pre-v2 fixtures.
    if (version !== 22) within(() => domain.createSet(actor.accountId, session.id, {
      schema: 'form.source-performed-set/v1', performance: performances[0],
      expectedRevision: domain.session(actor.accountId, session.id).revision,
      occurrenceId: session.occurrences[0].id, setNumber: 2, status: 'confirmed',
    }));
    const completed = within(() => domain.completeSession(actor.accountId, session.id, domain.session(actor.accountId, session.id).revision));
    assert.deepEqual(new Set(completed.sets.map(set => set.status)), new Set(['confirmed', 'voided']));
    assert.ok(completed.sets.every(set => set.schema.replace('source-performed-set', 'source-performance') === set.performance.schema));
    records[key] = { plan, session: completed };
  }
  return records;
}

function fixture(t, options = {}) {
  const sql = [];
  const db = new Database(':memory:', { verbose: statement => sql.push(statement) });
  try {
    db.pragma('foreign_keys = ON');
    // Apply schema SQL only: storage.migrate/openStorage also own filesystem backup behavior.
    if (options.sourceVersion) {
      db.exec('CREATE TABLE form_migrations(version INTEGER PRIMARY KEY,checksum TEXT NOT NULL,applied_at TEXT NOT NULL)');
      db.transaction(() => {
        for (const migration of sourceMigrations(options.sourceVersion)) {
          db.exec(migration.sql);
          db.prepare('INSERT INTO form_migrations VALUES(?,?,?)').run(migration.version, hash(migration.sql), stamp);
        }
      }).immediate();
    } else {
      for (const migration of migrations.filter(value => value.version <= 7)) db.exec(migration.sql);
      db.exec(lifecycleMigration.sql);
    }
    db.prepare('INSERT INTO exercises(id,data,retired) VALUES (?,?,0)')
      .run('floor-press', JSON.stringify({ id: 'floor-press', name: 'Floor press', cues: [] }));
    for (const [key, weight] of [['A', 12], ['B', 99]]) {
      const account = `form-${key}`;
      db.prepare('INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,?,?,1,0,0)')
        .run(`auth-${key}`, `Synthetic ${key}`, `${key}@example.invalid`);
      db.prepare('INSERT INTO form_accounts VALUES (?,?,?)').run(account, `auth-${key}`, stamp);
      db.prepare('INSERT INTO documents VALUES (?, ?, 0, ?)').run(account, 'profile', JSON.stringify({ injuryHistory: privateValue }));
      const target = { id: 'same-item', exerciseId: 'floor-press', setTarget: 2, repMin: 8, repMax: 10, targetKg: weight };
      for (const id of ['same-plan', 'second-plan', ...(key === 'B' ? ['foreign-plan'] : [])]) {
        const data = { name: options.malformed ? null : `Plan ${key}`, minutes: 30, items: [target] };
        db.prepare('INSERT INTO plans VALUES (?,?,3,0,?,?,?)').run(account, id, JSON.stringify(data), stamp, stamp);
        db.prepare('INSERT INTO plan_revisions VALUES (?,?,3,?,?)').run(account, id, JSON.stringify(data), stamp);
        db.prepare('INSERT INTO plan_item_ids VALUES (?,?,?,?)').run(account, id, target.id, target.exerciseId);
      }
      for (const [index, id] of ['same-session', 'older-session', ...(key === 'B' ? ['foreign-session'] : [])].entries()) {
        const started = index === 0 ? stamp : '2026-10-08T16:00:00.000Z';
        db.prepare('INSERT INTO workout_sessions VALUES (?,?,?,3,4,?,?,?,?)')
          .run(account, id, 'same-plan', JSON.stringify({ id: 'same-plan', revision: 3, archived: false, createdAt: stamp, updatedAt: stamp,
            name: `Plan ${key}`, minutes: 30, items: [target] }), 'completed', started, stamp);
        db.prepare('INSERT INTO session_occurrences VALUES (?,?,?,?,?,?,?)')
          .run(account, id, 'same-occurrence', target.id, target.exerciseId, 0, JSON.stringify(target));
        for (const [number, status] of [[1, 'confirmed'], [2, 'voided']]) {
          db.prepare('INSERT INTO performed_sets(account_id,session_id,id,occurrence_id,set_number,revision,reps,weight_kg,status,created_at,updated_at) VALUES (?,?,?,?,?,2,?,?,?,?,?)')
            .run(account, id, `same-set-${number}`, 'same-occurrence', number, 8, weight, status, stamp, stamp);
        }
      }
    }
    if (options.disabled) db.prepare("UPDATE account_lifecycle SET state='disabled',epoch=1,disabled_at_ms=1,suppression_seq=1 WHERE account_id='form-A'").run();
    const records = new Map(); let sequence = 0, available = true;
    const ensure = () => { if (!available) throw new Error(privateValue); };
    const ledger = {
      currentSequence() { ensure(); return sequence; }, lookup(account) { ensure(); return records.get(account) ?? null; },
      recordDisable(record) { ensure(); const value = { ...record, sequence: ++sequence }; records.set(record.accountId, value); return value; },
      reconcileRestore(apply) { ensure(); for (const record of records.values()) apply(record); return sequence; },
    };
    if (options.authority !== false) bindSuppressionAuthority(db, ledger);
    const suppress = () => ledger.recordDisable({ accountId: 'form-A', authUserId: 'auth-A', epoch: 1, requestId: 'synthetic-disable', disabledAtMs: 1 });
    const domain = new Domain(db, options.sourceVersion ? { sourcePrescription: 'selected-migration-19',
      ...(options.sourceVersion === 22 ? { sourceReportedLoad: 'selected-migration-22' } : {}) } : {});
    const sourceRecords = options.sourceVersion ? seedSourceRecords(db, domain, options.sourceVersion) : {};
    const readsBeforeSuppression = [];

    domain.account = () => assert.fail('Provisioning is forbidden');
    domain.plans = () => assert.fail('Unbounded plan read is forbidden');
    if (options.suppressAfterRead) {
      const session = domain.session.bind(domain);
      domain.session = (...args) => {
        const value = session(...args);
        readsBeforeSuppression.push({ accountId: args[0], requestedId: args[1], returnedId: value.id });
        suppress(); return value;
      };
    }
    const dependencies = createDomainReadDependencies(domain);
    const ports = createDomainReadPorts({ ...dependencies, now });
    db.pragma('query_only = ON');
    const changes = db.prepare('SELECT total_changes() AS count').get().count;
    t.after(() => {
      try {
        assert.equal(db.pragma('query_only', { simple: true }), 1);
        assert.equal(db.prepare('SELECT total_changes() AS count').get().count, changes);
        assert.equal(db.prepare('SELECT count(*) AS count FROM form_accounts').get().count, 2);
      } finally { db.close(); }
    });
    sql.length = 0;
    return { db, sql, domain, dependencies, ports, suppress, sourceRecords, readsBeforeSuppression, authorityAvailable(value) { available = value; },
      adapter: caller => createFormAdapter({ ports, now, verifyIdentity: () => caller ?? identity() }) };
  } catch (error) { db.close(); throw error; }
}
const resultData = result => { assert.equal(result.structuredContent.ok, true, JSON.stringify(result)); return result.structuredContent.data; };
const dataQueries = sql => sql.filter(text => /SELECT .*FROM (workout_sessions|session_occurrences|performed_sets|plans)\b/i.test(text));

function assertUnavailable(result) {
  assert.deepEqual(result, {
    isError: true,
    content: [{ type: 'text', text: 'This Form read is unavailable.' }],
    structuredContent: { ok: false, error: { code: 'unavailable', message: 'This Form read is unavailable.' } },
  });
}

function assertMcpUnavailable(result, mode) {
  assert.deepEqual(result, {
    isError: true,
    content: [{ type: 'text', text: '{"ok":false,"error":{"code":"unavailable","message":"This Form read is unavailable."}}' }],
    structuredContent: { ok: false, error: { code: 'unavailable', message: 'This Form read is unavailable.' } },
    ...(mode === 'legacy' ? {} : { _meta: {
      'io.modelcontextprotocol/serverInfo': { name: 'form-read-tools', version: '0.2.0' },
    } }),
  });
}

async function assertOAuthUnavailable(client, responses, name, args) {
  const before = responses.length;
  await assert.rejects(client.callTool({ name, arguments: args }), error => {
    assert.equal(error.data.status, 503);
    assert.equal(error.data.text, '{"error":"Form MCP is unavailable."}');
    return true;
  });
  assert.deepEqual(responses.slice(before), [{
    tool: name, arguments: args, status: 503, cacheControl: 'no-store', authenticate: null,
    body: '{"error":"Form MCP is unavailable."}',
  }]);
}

function assertMcpNotFound(result, mode) {
  assert.deepEqual(result, {
    isError: true,
    content: [{ type: 'text', text: '{"ok":false,"error":{"code":"not_found","message":"The requested Form record was not found."}}' }],
    structuredContent: { ok: false, error: { code: 'not_found', message: 'The requested Form record was not found.' } },
    ...(mode === 'legacy' ? {} : { _meta: {
      'io.modelcontextprotocol/serverInfo': { name: 'form-read-tools', version: '0.2.0' },
    } }),
  });
}

for (const sourceVersion of [19, 20, 22]) test(`genuine source migration ${sourceVersion} keeps detail unavailable and mixed history bounded`, async t => {
  const f = fixture(t, { sourceVersion }), adapter = f.adapter();
  assert.deepEqual(f.db.prepare('SELECT version,checksum FROM form_migrations ORDER BY version').all(),
    sourceMigrations(sourceVersion).map(migration => ({ version: migration.version, checksum: hash(migration.sql) })));
  for (const [key, record] of Object.entries(f.sourceRecords)) {
    const own = f.adapter(identity(key));
    assertUnavailable(await own.dispatch('form_get_plan', { planId: record.plan.id }));
    assertUnavailable(await own.dispatch('form_get_workout', { workoutId: record.session.id }));
    const rows = f.db.prepare('SELECT performance,reps,weight_kg FROM performed_sets WHERE account_id=? AND session_id=? ORDER BY set_number')
      .all(`form-${key}`, record.session.id);
    assert.ok(rows.every(row => row.reps === null && row.weight_kg === null));
    assert.deepEqual(rows.map(row => JSON.parse(row.performance)), [...record.session.sets]
      .sort((a, b) => a.setNumber - b.setNumber).map(set => set.performance));
    if (sourceVersion === 22) assert.deepEqual(rows.slice(1).map(row => JSON.parse(row.performance).load), [
      { state: 'knownValue', value: 0, unit: 'lb', basis: 'total' },
      { state: 'knownValue', value: 22, unit: 'lb', basis: 'assistance' },
      { state: 'knownValue', value: 12, unit: 'kg', basis: 'perSide' },
    ]);
    const foreign = f.sourceRecords[key === 'A' ? 'B' : 'A'];
    for (const [name, args] of [['form_get_plan', { planId: foreign.plan.id }], ['form_get_workout', { workoutId: foreign.session.id }]])
      assert.equal((await own.dispatch(name, args)).structuredContent.error.code, 'not_found');
    const seen = [], cursors = new Set(); let before;
    do {
      const page = resultData(await own.dispatch('form_list_workouts', { limit: 1, ...(before ? { before } : {}) }));
      assert.equal(page.items.length, 1); seen.push(page.items[0].id);
      assert.ok(!JSON.stringify(page).includes(privateValue));
      assert.equal(page.items[0].sets, undefined); assert.equal(page.items[0].occurrences, undefined);
      before = page.nextBefore;
      if (before) { assert.ok(!cursors.has(before)); cursors.add(before); }
      assert.ok(seen.length <= 4);
    } while (before);
    assert.deepEqual(new Set(seen), new Set([record.session.id, 'same-session', 'older-session', ...(key === 'B' ? ['foreign-session'] : [])]));
    assert.equal(resultData(await own.dispatch('form_get_workout', { workoutId: 'same-session' })).sets[0].weightKg, key === 'A' ? 12 : 99);
    assert.equal(resultData(await own.dispatch('form_get_plan', { planId: 'same-plan' })).items[0].targetKg, key === 'A' ? 12 : 99);
  }
  assert.ok(f.sql.some(text => /SELECT id FROM workout_sessions WHERE account_id='form-A'.*LIMIT 2/.test(text)));
  f.sql.length = 0;
  assert.equal((await adapter.dispatch('form_list_workouts', { limit: 21 })).structuredContent.error.code, 'invalid_input');
  assert.equal(dataQueries(f.sql).length, 0);
});

for (const mode of ['legacy', { pin: '2026-07-28' }]) for (const oauthEnabled of [false, true]) {
  test(`source detail and account isolation survive offline ${oauthEnabled ? 'OAuth' : 'MCP'} (${JSON.stringify(mode)})`, async t => {
    const f = fixture(t, { sourceVersion: 22 }); let key = 'A';
    const oauth = oauthFixture({ dependencies: f.dependencies });
    const bind = oauth.options.bindAuthorization;
    oauth.options.bindAuthorization = token => {
      const accountKey = token.subject === 'external|a' ? 'A' : 'B';
      return { ...bind(token), formAuthUserId: `auth-${accountKey}`, accountId: `form-${accountKey}` };
    };
    const handler = oauthEnabled ? createFormOAuthResourceHandler(oauth.options) : createFormMcpHandler({
      enabled: true, allowedHosts: ['form.example'], now, admitRequest: () => true, verifyRequest: () => identity(key), ports: f.ports,
    });
    const client = new Client({ name: 'form-source-real-domain', version: '1.0.0' }, { versionNegotiation: { mode } });
    const responses = [];
    const transport = new StreamableHTTPClientTransport(new URL('https://form.example/mcp'), { fetch: async (input, init) => {
      const request = new Request(input, init); request.headers.set('host', 'form.example');
      if (oauthEnabled) request.headers.set('authorization', `Bearer synthetic-${key.toLowerCase()}`);
      const message = request.method === 'POST' ? await request.clone().json() : null;
      const response = await handler.fetch(request);
      if (message?.method === 'tools/call') responses.push({
        tool: message.params.name, arguments: message.params.arguments, status: response.status,
        cacheControl: response.headers.get('cache-control'), authenticate: response.headers.get('www-authenticate'),
        body: await response.clone().text(),
      });
      return response;
    } });
    try {
      await client.connect(transport);
      for (key of ['A', 'B']) {
        const own = f.sourceRecords[key], foreign = f.sourceRecords[key === 'A' ? 'B' : 'A'];
        for (const [name, args] of [['form_get_plan', { planId: own.plan.id }], ['form_get_workout', { workoutId: own.session.id }]]) {
          if (oauthEnabled) await assertOAuthUnavailable(client, responses, name, args);
          else assertMcpUnavailable(await client.callTool({ name, arguments: args }), mode);
        }
        assertMcpNotFound(await client.callTool({ name: 'form_get_workout', arguments: { workoutId: foreign.session.id } }), mode);
        assertMcpNotFound(await client.callTool({ name: 'form_get_plan', arguments: { planId: foreign.plan.id } }), mode);
        const history = resultData(await client.callTool({ name: 'form_list_workouts', arguments: { limit: 1 } }));
        assert.equal(history.items.length, 1); assert.equal(history.items[0].id, own.session.id);
        assert.ok(!JSON.stringify(history).includes(privateValue));
        assert.equal(resultData(await client.callTool({ name: 'form_get_workout', arguments: { workoutId: 'same-session' } })).sets[0].weightKg, key === 'A' ? 12 : 99);
      }
    } finally { try { await client.close(); } finally { await handler.close(); } }
  });
}

test('source history is withheld after lifecycle suppression inside the actual SQLite read', async t => {
  const f = fixture(t, { sourceVersion: 22, suppressAfterRead: true });
  assertUnavailable(await f.adapter().dispatch('form_list_workouts', { limit: 1 }));
  assert.deepEqual(f.readsBeforeSuppression, [{ accountId: 'form-A',
    requestedId: f.sourceRecords.A.session.id, returnedId: f.sourceRecords.A.session.id }]);
  assert.ok(f.sql.some(text => /SELECT id FROM workout_sessions WHERE account_id='form-A'.*LIMIT 2/.test(text)));
});

test('OAuth revocation after source history read withholds all projected records', async t => {
  const f = fixture(t, { sourceVersion: 22 }), oauth = oauthFixture();
  const bind = oauth.options.bindAuthorization;
  oauth.options.bindAuthorization = token => ({ ...bind(token), formAuthUserId: 'auth-A', accountId: 'form-A' });
  oauth.options.dependencies = { ...f.dependencies, domain: { ...f.dependencies.domain,
    history(...args) { const result = f.dependencies.domain.history(...args); oauth.state.current = false; return result; },
  } };
  const handler = createFormOAuthResourceHandler(oauth.options);
  try {
    const response = await handler.fetch(oauthRequest(callRequest('form_list_workouts', { limit: 1 })));
    assert.equal(response.status, 200); assert.ok(dataQueries(f.sql).length > 0);
    const body = await response.text();
    assert.ok(body.includes('mcp/www_authenticate'));
    for (const value of [privateValue, f.sourceRecords.A.session.id, f.sourceRecords.A.plan.id]) assert.ok(!body.includes(value));
  } finally { await handler.close(); }
});

test('API lock compatibility accepts only the original pin or qualified alias-only carrier', () => {
  const bytes = readFileSync(resolve(packageRoot, '../../services/api/package-lock.json'));
  const original = JSON.parse(bindingBytes).apiLockSha256;
  assert.equal(qualifiedApiLock(bytes, original), true);
  assert.equal(qualifiedApiLock(Buffer.concat([bytes, Buffer.from('\n')]), original), false);
  assert.equal(qualifiedApiLock(bytes, 'unqualified-carrier'), false);
});

for (const mode of ['legacy', { pin: '2026-07-28' }]) test(`OAuth authority composes real Domain and read-only SQLite (${JSON.stringify(mode)})`, async t => {
  const f = fixture(t), oauth = oauthFixture({ dependencies: f.dependencies });
  const bind = oauth.options.bindAuthorization;
  oauth.options.bindAuthorization = token => {
    const result = bind(token), key = token.subject === 'external|a' ? 'A' : 'B';
    return { ...result, formAuthUserId: `auth-${key}`, accountId: `form-${key}` };
  };
  const handler = createFormOAuthResourceHandler(oauth.options);
  let key = 'a';
  const client = new Client({ name: 'form-oauth-real-domain', version: '1.0.0' }, { versionNegotiation: { mode } });
  const transport = new StreamableHTTPClientTransport(new URL('https://form.example/mcp'), { fetch: (input, init) => {
    const request = new Request(input, init); request.headers.set('host', 'form.example');
    request.headers.set('authorization', `Bearer synthetic-${key}`); return handler.fetch(request);
  } });
  try {
    await client.connect(transport);
    for (const [accountKey, weight] of [['a', 12], ['b', 99]]) {
      key = accountKey;
      const result = await client.callTool({ name: 'form_get_workout', arguments: { workoutId: 'same-session' } });
      assert.equal(resultData(result).sets[0].weightKg, weight);
      assert.ok(!JSON.stringify(result).includes(privateValue));
      assert.equal(resultData(await client.callTool({ name: 'form_list_plans', arguments: { limit: 1 } })).items.length, 1);
    }
    key = 'a';
    const foreign = await client.callTool({ name: 'form_get_workout', arguments: { workoutId: 'foreign-session' } });
    assert.equal(foreign.structuredContent.error.code, 'not_found');
    const count = dataQueries(f.sql).length;
    oauth.state.current = false;
    const denied = await handler.fetch(oauthRequest(callRequest('form_get_workout', { workoutId: 'same-session' })));
    assert.equal(denied.status, 401); assert.equal(dataQueries(f.sql).length, count);
    assert.ok(!(await denied.text()).includes('same-session'));
  } finally { await client.close(); await handler.close(); }
});

test('OAuth post-read revocation suppresses a real SQLite result without writes', async t => {
  const f = fixture(t), oauth = oauthFixture();
  const bind = oauth.options.bindAuthorization;
  oauth.options.bindAuthorization = token => ({ ...bind(token), formAuthUserId: 'auth-A', accountId: 'form-A' });
  oauth.options.dependencies = { ...f.dependencies, domain: { ...f.dependencies.domain,
    session(...args) { const result = f.dependencies.domain.session(...args); oauth.state.current = false; return result; },
  } };
  const handler = createFormOAuthResourceHandler(oauth.options);
  try {
    const denied = await handler.fetch(oauthRequest(callRequest('form_get_workout', { workoutId: 'same-session' })));
    assert.equal(denied.status, 200); assert.ok(dataQueries(f.sql).length > 0);
    const body = await denied.text();
    assert.ok(!body.includes('same-session')); assert.ok(body.includes('mcp/www_authenticate'));
  } finally { await handler.close(); }
});

for (const mode of ['legacy', { pin: '2026-07-28' }]) test(`official offline client reaches real Domain and SQLite (${JSON.stringify(mode)})`, async t => {
  const f = fixture(t);
  let caller = identity();
  const handler = createFormMcpHandler({ enabled: true, allowedHosts: ['form.example'], now,
    admitRequest: () => true, verifyRequest: () => caller, ports: f.ports });
  const client = new Client({ name: 'form-real-domain-fixture', version: '1.0.0' }, { versionNegotiation: { mode } });
  const transport = new StreamableHTTPClientTransport(new URL('https://form.example/mcp'), { fetch: (input, init) => {
    const request = new Request(input, init); request.headers.set('host', 'form.example'); return handler.fetch(request);
  } });
  try {
    await client.connect(transport);
    assert.equal((await client.listTools()).tools.length, 5);
    for (const [key, weight] of [['A', 12], ['B', 99]]) {
      caller = identity(key);
      const workout = resultData(await client.callTool({ name: 'form_get_workout', arguments: { workoutId: 'same-session' } }));
      assert.equal(workout.revision, 4); assert.equal(workout.planRevision, 3); assert.equal(workout.startedAt, stamp);
      assert.deepEqual(workout.sets.map(set => [set.weightKg, set.status]), [[weight, 'confirmed'], [weight, 'voided']]);
      assert.equal(workout.occurrences[0].target.targetKg, weight);
      const plan = resultData(await client.callTool({ name: 'form_get_plan', arguments: { planId: 'same-plan' } }));
      assert.equal(plan.name, `Plan ${key}`); assert.equal(plan.items[0].targetKg, weight);
      assert.ok(!JSON.stringify({ workout, plan }).includes(privateValue));
      assert.equal(workout.planSnapshot, undefined); assert.equal(workout.sets[0].revision, undefined);
    }
    caller = identity();
    for (const [name, args] of [['form_get_workout', { workoutId: 'foreign-session' }], ['form_get_plan', { planId: 'foreign-plan' }]]) {
      assert.equal((await client.callTool({ name, arguments: args })).structuredContent.error.code, 'not_found');
    }
    assert.ok(!f.sql.some(text => /FROM documents\b/i.test(text)));
  } finally { try { await client.close(); } finally { await handler.close(); } }
});

test('native history cursor and bounded plansPage read only one scoped parent per requested page', async t => {
  const f = fixture(t), adapter = f.adapter();
  const first = resultData(await adapter.dispatch('form_list_workouts', { limit: 1 }));
  assert.equal(first.items[0].id, 'same-session'); assert.ok(first.nextBefore);
  const second = resultData(await adapter.dispatch('form_list_workouts', { limit: 1, before: first.nextBefore }));
  assert.equal(second.items[0].id, 'older-session'); assert.equal(second.nextBefore, null);
  f.sql.length = 0;
  const plans = resultData(await adapter.dispatch('form_list_plans', { limit: 1 }));
  assert.equal(plans.items.length, 1); assert.equal(plans.hasMore, true);
  assert.ok(f.sql.some(text => /SELECT id FROM plans WHERE account_id='form-A' ORDER BY created_at,id LIMIT 2/.test(text)));
  assert.equal(f.sql.filter(text => text.startsWith('SELECT * FROM plans')).length, 1);
  f.sql.length = 0;
  for (const limit of [0, 21, 1.5]) assert.throws(() => f.dependencies.plansPage('form-A', limit), { code: 'invalid_plan_limit' });
  assert.equal(dataQueries(f.sql).length, 0);
  assert.equal((await adapter.dispatch('form_list_workouts', { before: 'broken' })).structuredContent.error.code, 'unavailable');
});

test('mapping, identity and model-input denial cannot query training records or provision accounts', async t => {
  const f = fixture(t);
  for (const caller of [identity('unknown'), { ...identity(), accountId: 'form-B' },
    { ...identity(), expiresAtMs: 1000 }, { ...identity(), scopes: [] }]) {
    assert.equal((await f.adapter(caller).dispatch('form_get_workout', { workoutId: 'same-session' })).structuredContent.ok, false);
  }
  assert.equal((await f.adapter().dispatch('form_get_workout', { workoutId: 'same-session', accountId: 'form-B' })).structuredContent.ok, false);
  assert.equal(dataQueries(f.sql).length, 0);
  assert.equal(f.dependencies.resolveAccount('auth-unknown'), null);
});

for (const options of [{ disabled: true }, { authority: false }, { unavailable: true }, { suppressed: true }, { suppressAfterRead: true }]) {
  test(`real lifecycle boundary denies without exposing data ${JSON.stringify(options)}`, async t => {
    const f = fixture(t, options);
    if (options.unavailable) f.authorityAvailable(false);
    if (options.suppressed) f.suppress();
    const result = await f.adapter().dispatch('form_get_workout', { workoutId: 'same-session' });
    assert.equal(result.structuredContent.error.code, 'unavailable');
    assert.ok(!JSON.stringify(result).includes(privateValue)); assert.equal(result.structuredContent.data, undefined);
    assert.equal(dataQueries(f.sql).length > 0, options.suppressAfterRead === true);
  });
}

test('factory rejects thenables; malformed persisted data and missing wiring remain safely unavailable', async t => {
  const f = fixture(t, { malformed: true });
  assert.throws(() => f.dependencies.withActiveAccountRead(identity(), () => Promise.resolve('private')), { code: 'synchronous_account_read_required' });
  const result = await f.adapter().dispatch('form_get_plan', { planId: 'same-plan' });
  assert.equal(result.structuredContent.error.code, 'unavailable'); assert.ok(!JSON.stringify(result).includes(privateValue));
  f.sql.length = 0;
  const handler = createFormMcpHandler({ ports: f.ports, verifyRequest: () => assert.fail('Disabled verifier') });
  try { assert.equal((await handler.fetch(new Request('https://form.example/mcp'))).status, 503); }
  finally { await handler.close(); }
  const partial = createDomainReadPorts({ domain: f.domain, resolveAccount: f.dependencies.resolveAccount });
  assert.deepEqual(partial, {}); assert.equal(f.sql.length, 0);
});

function probe(mode) {
  const child = fork(join(packageRoot, 'scripts/check-domain-sqlite.mjs'), [mode], { execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const done = new Promise((accept, reject) => { child.once('error', reject); child.once('exit', (code, signal) => accept({ code, signal })); });
  const ready = new Promise((accept, reject) => {
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('Probe ready deadline')); }, 3000);
    child.once('message', value => { clearTimeout(timer); accept(value); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', () => { clearTimeout(timer); reject(new Error('Probe exited before ready')); });
  });
  return { child, done, ready };
}

test('runner removes its exact scratch on success, failure and concurrent cancellation', { timeout: 10000 }, async () => {
  const probes = [];
  try {
    for (const [mode, code] of [['--probe-success', 0], ['--probe-failure', 23]]) {
      const p = probe(mode); probes.push(p); const { root: path } = await p.ready;
      assert.deepEqual(await p.done, { code, signal: null }); assert.equal(existsSync(path), false);
    }
    const first = probe('--probe-child'), second = probe('--probe-wait'); probes.push(first, second);
    const [{ root: a }, { root: b }] = await Promise.all([first.ready, second.ready]);
    assert.notEqual(a, b);
    first.child.kill('SIGTERM'); assert.deepEqual(await first.done, { code: 143, signal: null });
    assert.equal(existsSync(a), false); assert.equal(existsSync(join(b, 'owned.txt')), true);
    second.child.kill('SIGINT'); assert.deepEqual(await second.done, { code: 130, signal: null }); assert.equal(existsSync(b), false);
    const disconnected = probe('--probe-child'); probes.push(disconnected);
    const { root: c } = await disconnected.ready;
    disconnected.child.disconnect();
    assert.deepEqual(await disconnected.done, { code: 143, signal: null }); assert.equal(existsSync(c), false);
    await withOwnedScratch(async ({ run }) => {
      const firstCommand = run(process.execPath, ['-e', 'setTimeout(() => {}, 10)']);
      try { await assert.rejects(run(process.execPath, ['-e', 'process.exit(99)']), /awaited sequentially/); }
      finally { await firstCommand; }
    });
  } finally {
    for (const p of probes) if (p.child.exitCode === null && p.child.signalCode === null) p.child.kill('SIGTERM');
    await Promise.all(probes.map(p => p.done));
  }
});

test('admission permits at most one start and denies pressure, malformed or missing evidence', () => {
  const healthy = { schema: 'work-capacity-admission/v1', status: 'ok', errors: [], admission: {
    serial_test_process_ceiling: 1, broad_test_allowed: true,
    measurements: { cpu_used_percent: 25, ram_available_gib: 16, one_fully_used_core_percent: 6.25 },
  } };
  assert.equal(admissionDecision(healthy).starts, 1);
  assert.equal(admissionDecision({ ...healthy, status: 'partial' }).starts, 1);
  assert.equal(admissionDecision({ ...healthy, admission: { ...healthy.admission,
    measurements: { ...healthy.admission.measurements, cpu_used_percent: 84.99 } } }).starts, 1);
  const denied = [null, {}, { ...healthy, schema: 'unexpected' }, { ...healthy, status: 'error' },
    { ...healthy, errors: ['failed'] }, { ...healthy, errors: undefined },
    ...[0, 2, '1'].map(value => ({ ...healthy, admission: { ...healthy.admission, serial_test_process_ceiling: value } })),
    { ...healthy, admission: { ...healthy.admission, broad_test_allowed: false } }];
  for (const [field, values] of Object.entries({ cpu_used_percent: [undefined, NaN, Infinity, -1, '25', 85, 99, 101],
    ram_available_gib: [undefined, NaN, Infinity, -1, '16'], one_fully_used_core_percent: [undefined, NaN, Infinity, 0, -1, '6.25'] })) {
    for (const value of values) denied.push({ ...healthy, admission: { ...healthy.admission,
      measurements: { ...healthy.admission.measurements, [field]: value } } });
  }
  for (const document of denied) assert.equal(admissionDecision(document).starts, 0);
});

test('cleanup failure stays visible without masking the primary failure code', async () => {
  for (const primary of [false, true]) {
    let owned;
    await assert.rejects(withOwnedScratch(async ({ root: path }) => {
      owned = path; if (primary) throw Object.assign(new Error('Synthetic primary'), { exitCode: 23 });
    }, path => { rmSync(path, { recursive: true }); throw new Error('Synthetic cleanup reporting failure'); }), error => {
      assert.equal(error.exitCode, primary ? 23 : 1); assert.ok(error instanceof AggregateError); return true;
    });
    assert.equal(existsSync(owned), false);
  }
});
