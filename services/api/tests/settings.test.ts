import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { DomainError } from '../src/errors.js';
import { readAccountSettings } from '../src/settings.js';
import type { Sqlite } from '../src/storage.js';

function fixture(run: (db: Sqlite) => void): void {
  const db = new Database(':memory:');
  try {
    db.pragma('foreign_keys = ON');
    // Only the Settings read contract; no migration backups, files, sockets or services.
    db.exec(`
      CREATE TABLE "user" (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL,
        emailVerified INTEGER NOT NULL, phoneNumber TEXT, phoneNumberVerified INTEGER);
      CREATE TABLE form_accounts (id TEXT PRIMARY KEY, auth_user_id TEXT NOT NULL UNIQUE REFERENCES "user"(id));
      CREATE TABLE documents (account_id TEXT NOT NULL REFERENCES form_accounts(id), kind TEXT NOT NULL,
        revision INTEGER NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)), PRIMARY KEY(account_id, kind));
      CREATE TABLE account (id TEXT PRIMARY KEY, userId TEXT NOT NULL REFERENCES "user"(id), providerId TEXT NOT NULL,
        accountId TEXT NOT NULL, password TEXT, accessToken TEXT, refreshToken TEXT, idToken TEXT);
      CREATE TABLE session (id TEXT PRIMARY KEY, userId TEXT NOT NULL REFERENCES "user"(id), token TEXT NOT NULL);
    `);
    db.prepare('INSERT INTO "user" VALUES (?,?,?,?,?,?)').run('auth-a', 'Auth name A', 'a@synthetic.invalid', 1, '+12025550111', 1);
    db.prepare('INSERT INTO "user" VALUES (?,?,?,?,?,?)').run('auth-b', 'Auth name B', 'b@synthetic.invalid', 0, '+12025550122', 0);
    db.prepare('INSERT INTO form_accounts VALUES (?,?)').run('form-a', 'auth-a');
    db.prepare('INSERT INTO form_accounts VALUES (?,?)').run('form-b', 'auth-b');
    for (const suffix of ['a', 'b']) {
      db.prepare('INSERT INTO documents VALUES (?,?,?,?)').run(`form-${suffix}`, 'profile', 3, JSON.stringify({
        name: `Profile name ${suffix.toUpperCase()}`, injuryHistory: `synthetic-injury-${suffix}`, weightKg: 75,
      }));
      db.prepare('INSERT INTO documents VALUES (?,?,?,?)').run(`form-${suffix}`, 'preferences', 7,
        JSON.stringify({ remindersEnabled: suffix === 'a', appMode: 'basic' }));
      db.prepare('INSERT INTO session VALUES (?,?,?)').run(`session-${suffix}`, `auth-${suffix}`, `synthetic-session-secret-${suffix}`);
    }
    const insert = db.prepare('INSERT INTO account VALUES (?,?,?,?,?,?,?,?)');
    insert.run('credential-a', 'auth-a', 'credential', 'synthetic-subject-a', 'synthetic-password-hash', null, null, null);
    insert.run('google-a', 'auth-a', 'google', 'synthetic-google-subject', null, 'synthetic-access-secret', 'synthetic-refresh-secret', 'synthetic-id-secret');
    insert.run('google-a-2', 'auth-a', 'google', 'synthetic-google-subject-2', null, null, null, null);
    insert.run('unknown-a', 'auth-a', 'unrecognized-provider-secret', 'synthetic-unknown-subject', null, null, null, null);
    insert.run('apple-b', 'auth-b', 'apple', 'synthetic-apple-subject', null, 'synthetic-other-access-secret', null, null);
    run(db);
  } finally {
    db.close();
  }
}

test('Settings isolates safe identity and methods to the exact mapped account', () => fixture(db => {
  const first = readAccountSettings(db, 'form-a', 'auth-a');
  assert.equal(first.accountId, 'form-a');
  assert.deepEqual(first.identity, {
    displayName: 'Profile name A', displayNameSource: 'formProfile', email: 'a@synthetic.invalid',
    emailVerified: true, phoneNumber: '+12025550111', signInMethods: ['emailPassword', 'google', 'phone'],
  });
  assert.deepEqual(readAccountSettings(db, 'form-b', 'auth-b').identity, {
    displayName: 'Profile name B', displayNameSource: 'formProfile', email: 'b@synthetic.invalid',
    emailVerified: false, phoneNumber: null, signInMethods: ['apple'],
  });
  db.prepare('DELETE FROM account WHERE userId=?').run('auth-b');
  assert.deepEqual(readAccountSettings(db, 'form-b', 'auth-b').identity.signInMethods, []);
  const serialized = JSON.stringify(first);
  for (const excluded of ['Auth name A', 'synthetic-subject', 'synthetic-google-subject', 'synthetic-password-hash',
    'synthetic-access-secret', 'synthetic-refresh-secret', 'synthetic-id-secret', 'synthetic-session-secret',
    'unrecognized-provider-secret', 'synthetic-injury', 'weightKg', 'b@synthetic.invalid', '+12025550122'])
    assert.equal(serialized.includes(excluded), false, `Excluded Settings field/value: ${excluded}`);
}));

test('Settings rejects mismatched, missing and empty session mapping without identity disclosure', () => fixture(db => {
  for (const [accountId, authUserId] of [
    ['form-a', 'auth-b'], ['form-b', 'auth-a'], ['missing', 'auth-a'], ['form-a', 'missing'], ['', 'auth-a'], ['form-a', ''],
    ["form-a' OR 1=1 --", 'auth-a'],
  ] as const) assert.throws(() => readAccountSettings(db, accountId, authUserId), error => {
    assert.ok(error instanceof DomainError);
    assert.equal(error.status, 403);
    assert.equal(error.code, 'account_session_mismatch');
    assert.equal(error.details, undefined);
    return true;
  });
}));

test('Settings hides reserved phone email and reads only the current own verified phone', () => fixture(db => {
  db.prepare('UPDATE "user" SET email=? WHERE id=?').run('synthetic-placeholder@PHONE.FORM.INVALID', 'auth-a');
  assert.deepEqual(readAccountSettings(db, 'form-a', 'auth-a').identity, {
    displayName: 'Profile name A', displayNameSource: 'formProfile', email: null, emailVerified: false,
    phoneNumber: '+12025550111', signInMethods: ['emailPassword', 'google', 'phone'],
  });
  db.prepare('UPDATE "user" SET phoneNumberVerified=0 WHERE id=?').run('auth-a');
  assert.equal(readAccountSettings(db, 'form-a', 'auth-a').identity.phoneNumber, null);
  assert.deepEqual(readAccountSettings(db, 'form-a', 'auth-a').identity.signInMethods, ['emailPassword', 'google']);
  db.prepare('UPDATE "user" SET phoneNumber=?,phoneNumberVerified=1 WHERE id=?').run('+12025550133', 'auth-a');
  assert.equal(readAccountSettings(db, 'form-a', 'auth-a').identity.phoneNumber, '+12025550133');
  db.prepare('UPDATE "user" SET phoneNumber=? WHERE id=?').run('unusable-synthetic-phone', 'auth-a');
  assert.equal(readAccountSettings(db, 'form-a', 'auth-a').identity.phoneNumber, null);
  db.prepare('UPDATE "user" SET phoneNumber=NULL WHERE id=?').run('auth-a');
  assert.deepEqual(readAccountSettings(db, 'form-a', 'auth-a').identity.signInMethods, ['emailPassword', 'google']);
}));

test('Settings uses Form profile truth and fails closed if the display name is unavailable', () => fixture(db => {
  db.prepare('UPDATE documents SET data=json_set(data,\'$.name\',?),revision=revision+1 WHERE account_id=? AND kind=\'profile\'')
    .run('Edited Form name', 'form-a');
  assert.equal(readAccountSettings(db, 'form-a', 'auth-a').identity.displayName, 'Edited Form name');
  for (const name of [null, 123, '', '   ']) {
    db.prepare('UPDATE documents SET data=? WHERE account_id=? AND kind=?').run(JSON.stringify({ name }), 'form-a', 'profile');
    assert.throws(() => readAccountSettings(db, 'form-a', 'auth-a'), error =>
      error instanceof DomainError && error.status === 503 && error.code === 'settings_profile_unavailable');
  }
  db.prepare('DELETE FROM documents WHERE account_id=? AND kind=?').run('form-a', 'profile');
  assert.throws(() => readAccountSettings(db, 'form-a', 'auth-a'), error =>
    error instanceof DomainError && error.code === 'settings_profile_unavailable');
}));

test('Settings reports maintained Form session actions and unavailable deletion truthfully without writes', () => fixture(db => {
  const before = db.prepare('SELECT total_changes() AS changes').get();
  const result = readAccountSettings(db, 'form-a', 'auth-a');
  const action = (path: string, scope: string, requestBody = 'emptyObject') => ({
    supported: true, method: 'POST', path, scope, authentication: 'currentFormSession', requestBody,
  });
  assert.deepEqual(result.capabilities, {
    changePassword: { supported: true, status: 'available' },
    changeEmail: { supported: false, status: 'unconfigured' },
    passwordRecovery: { supported: false, status: 'unconfigured' },
    signOut: action('/api/auth/sign-out', 'currentFormSession'),
    revokeSession: action('/api/auth/revoke-session', 'selectedOwnFormSession', 'ownSessionToken'),
    revokeOtherSessions: action('/api/auth/revoke-other-sessions', 'otherFormSessions'),
    revokeAllSessions: action('/api/auth/revoke-sessions', 'allFormSessions'),
    accountDeletion: { supported: false, status: 'unavailable', reason: 'retentionCleanupNotImplemented' },
  });
  assert.deepEqual(result.policies, {
    sessions: { providerLogout: 'notClaimed', billingCancellation: 'notIncluded', deviceDataErasure: 'notIncluded' },
    reminders: {
      preferenceField: 'remindersEnabled', preferencePath: '/v1/me/preferences', effect: 'preferenceOnly',
      osPermission: 'unverified', scheduling: 'unverified', delivery: 'unverified',
    },
    privacy: { status: 'pendingIntegration', contractOwner: 'rootBodyContract', bodyRetention: 'unavailable', accountDataDeletion: 'unavailable' },
  });
  assert.deepEqual(db.prepare('SELECT total_changes() AS changes').get(), before);
  assert.equal(JSON.stringify(result).includes('/delete-user'), false);
  db.prepare('UPDATE documents SET data=json_set(data,\'$.remindersEnabled\',0) WHERE account_id=? AND kind=\'preferences\'')
    .run('form-a');
  assert.deepEqual(readAccountSettings(db, 'form-a', 'auth-a').policies.reminders, result.policies.reminders);
  result.identity.signInMethods.length = 0;
  assert.deepEqual(readAccountSettings(db, 'form-a', 'auth-a').identity.signInMethods, ['emailPassword', 'google', 'phone']);
}));
