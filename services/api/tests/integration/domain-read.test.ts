import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { Domain } from '../../src/domain.js';
import { migrations } from '../../src/storage.js';
import { lifecycleMigration } from '../../src/lifecycle/migration.js';
import { bindSuppressionAuthority } from '../../src/lifecycle/guards.js';
import type { DisableRecord, SuppressionLedger } from '../../src/lifecycle/types.js';
import { createDomainReadDependencies } from '../../src/integration/domain-read.js';

function fixture(run: (value: {
  db: Database.Database; domain: Domain; deps: ReturnType<typeof createDomainReadDependencies>;
  one: string; two: string; disabled: Map<string, DisableRecord>;
}) => void) {
  const db = new Database(':memory:');
  try {
    db.pragma('foreign_keys = ON');
    for (const migration of migrations) db.exec(migration.sql);
    db.exec(lifecycleMigration.sql);
    const disabled = new Map<string, DisableRecord>();
    const ledger: SuppressionLedger = { currentSequence: () => disabled.size, lookup: id => disabled.get(id) ?? null,
      reconcileRestore: apply => { for (const record of disabled.values()) apply(record); return disabled.size; },
      recordDisable: record => { const value = { ...record, sequence: disabled.size + 1 }; disabled.set(record.accountId, value); return value; } };
    bindSuppressionAuthority(db, ledger);
    for (const id of ['subject-one', 'subject-two', 'unprovisioned'])
      db.prepare('INSERT INTO "user"(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,1,?,?)').run(id, id, `${id}@synthetic.invalid`, 1, 1);
    const domain = new Domain(db), one = domain.account('subject-one', 'One'), two = domain.account('subject-two', 'Two');
    run({ db, domain, deps: createDomainReadDependencies(domain), one, two, disabled });
  } finally { db.close(); }
}

test('read resolver returns existing mappings without provisioning missing subjects', () => fixture(({ db, domain, deps, one }) => {
  domain.account = () => { throw new Error('Provisioning is forbidden'); };
  assert.equal(deps.resolveAccount('subject-one'), one);
  for (const subject of ['unprovisioned', 'missing', '', "subject-one' OR 1=1 --"])
    assert.equal(deps.resolveAccount(subject), null);
  assert.equal((db.prepare('SELECT count(*) n FROM form_accounts').get() as { n: number }).n, 2);
  const result = { value: 'read' };
  assert.equal(deps.withActiveAccountRead({ accountId: one, subject: 'subject-one' }, () => result), result);
}));

test('read guard rejects mismatched or suppressed identities before calling the consumer', () => fixture(({ deps, one, two, disabled }) => {
  let calls = 0;
  for (const context of [{ accountId: one, subject: 'subject-two' }, { accountId: two, subject: 'missing' }, { accountId: '', subject: 'subject-one' }])
    assert.throws(() => deps.withActiveAccountRead(context, () => { calls++; }), { code: 'account_subject_mismatch' });
  disabled.set(one, { accountId: one, authUserId: 'subject-one', epoch: 1, requestId: 'synthetic', disabledAtMs: 1, sequence: 1 });
  assert.throws(() => deps.withActiveAccountRead({ accountId: one, subject: 'subject-one' }, () => { calls++; }), { code: 'account_disabled' });
  assert.equal(calls, 0);
}));

test('canonical account mapping cannot be reassigned during a read', () => fixture(({ db, deps, one }) => {
  assert.throws(() => deps.withActiveAccountRead({ accountId: one, subject: 'subject-one' }, () => {
    db.prepare('UPDATE form_accounts SET auth_user_id=? WHERE id=?').run('unprovisioned', one);
    return 'must not escape';
  }), { code: 'SQLITE_CONSTRAINT_TRIGGER' });
  assert.equal(deps.resolveAccount('subject-one'), one);
  assert.equal(deps.resolveAccount('unprovisioned'), null);
}));

test('read guard rejects suppression activated during the read without returning its payload', () => fixture(({ deps, one, disabled }) => {
  let calls = 0;
  let returned: string | undefined;
  assert.throws(() => {
    returned = deps.withActiveAccountRead({ accountId: one, subject: 'subject-one' }, () => {
      calls++;
      disabled.set(one, { accountId: one, authUserId: 'subject-one', epoch: 1, requestId: 'synthetic', disabledAtMs: 1, sequence: 1 });
      return 'must not escape';
    });
  }, { code: 'account_disabled' });
  assert.equal(calls, 1);
  assert.equal(returned, undefined);
}));

test('read guard rechecks epoch and rejects asynchronous results', () => fixture(({ db, deps, one }) => {
  const context = { accountId: one, subject: 'subject-one' };
  assert.throws(() => deps.withActiveAccountRead(context, () => {
    db.prepare('UPDATE account_lifecycle SET epoch=epoch+1 WHERE account_id=?').run(one);
    return 'must not escape';
  }), { code: 'account_epoch_changed' });
  assert.throws(() => deps.withActiveAccountRead(context, () => Promise.resolve('async')), { code: 'synchronous_account_read_required' });
  assert.equal(deps.withActiveAccountRead(context, () => 'current'), 'current');
}));

test('plan page uses a bounded query and hydrates only returned account-scoped plans', () => fixture(({ db, domain, deps, one, two }) => {
  const insert = db.prepare('INSERT INTO plans VALUES(?,?,1,0,?,?,?)');
  const plan = { name: 'Synthetic', minutes: 30, items: [
    { id: 'item-one', exerciseId: 'floor-press', setTarget: 2, repMin: 8, repMax: 10, targetKg: 0 },
  ] };
  const timestamp = '2026-10-11T00:00:00.000Z';
  for (let i = 0; i < 25; i++) insert.run(one, `plan-${String(i).padStart(2, '0')}`, JSON.stringify(plan), timestamp, timestamp);
  insert.run(two, 'other-plan', JSON.stringify(plan), timestamp, timestamp);
  domain.plans = () => { throw new Error('Unbounded plans fallback is forbidden'); };
  const hydrate = domain.plan.bind(domain), hydrated: string[] = [];
  domain.plan = (accountId, id) => { hydrated.push(id); return hydrate(accountId, id); };
  const prepare = db.prepare.bind(db), queries: unknown[][] = [];
  db.prepare = ((sql: string) => {
    const statement = prepare(sql);
    if (sql.startsWith('SELECT id FROM plans')) {
      assert.match(sql, /LIMIT \?$/);
      const all = statement.all.bind(statement);
      statement.all = ((...args: unknown[]) => { queries.push(args); return all(...args); }) as typeof statement.all;
    }
    return statement;
  }) as typeof db.prepare;
  const page = deps.plansPage(one, 2);
  assert.deepEqual(queries, [[one, 3]]);
  assert.equal(page.hasMore, true); assert.deepEqual(hydrated, ['plan-00', 'plan-01']);
  assert.equal(page.items.length, 2);
  assert.deepEqual(deps.plansPage(two, 20).items.map(item => item.id), ['other-plan']);
  assert.equal(deps.plansPage(two, 20).hasMore, false);
  for (const limit of [0, -1, 21, 1.5, NaN, Infinity]) assert.throws(() => deps.plansPage(one, limit), { code: 'invalid_plan_limit' });
}));
