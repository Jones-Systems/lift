import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

// Native TS stripping binds actual modules; stock API/APP typechecks remain separate.
const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const paths = ['services/api/src/body/manual-retention-contract.ts', 'apps/form/src/body/manualRetentionContract.ts'];
const sources = paths.map(path => readFileSync(resolve(repoRoot, path)));
const contracts = await Promise.all(paths.map(path => import(pathToFileURL(resolve(repoRoot, path)).href)));
const decisionId = '11111111-1111-4111-8111-111111111111';
const otherId = '22222222-2222-4222-8222-222222222222';

test('actual API and APP bytes, exports, and canonical statement agree', () => {
  assert.deepEqual(sources[0], sources[1]);
  assert.deepEqual(Object.keys(contracts[0]).sort(), Object.keys(contracts[1]).sort());
  const canonical = value => JSON.stringify(Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])));
  for (const contract of contracts) {
    assert.equal(contract.MANUAL_RETENTION_PROTOCOL, 'form.manual-retention/v1');
    assert.equal(contract.MANUAL_RETENTION_STATEMENT_SHA256, '4ebd683942cc90b47ccd73613fc78c81cf8ed02bac57205349d798f42eda4ea3');
    assert.equal(createHash('sha256').update(canonical(contract.MANUAL_RETENTION_STATEMENT), 'utf8').digest('hex'), contract.MANUAL_RETENTION_STATEMENT_SHA256);
    assert.ok(Object.isFrozen(contract.MANUAL_RETENTION_STATEMENT));
    assert.ok(Object.isFrozen(contract.MANUAL_RETENTION_STATEMENT_BINDING));
  }
});

for (const [index, c] of contracts.entries()) {
  const binding = () => ({ ...c.MANUAL_RETENTION_STATEMENT_BINDING });
  const grant = () => ({ decisionId, processing: 'manual_entry', purpose: 'personal_measurement_progress', choice: 'retain',
    statementId: 'manual-personal-progress', statementVersion: 1, statementSha256: c.MANUAL_RETENTION_STATEMENT_SHA256 });
  const attempt = () => ({ protocol: c.MANUAL_RETENTION_PROTOCOL, decisionId, revision: 1, statementSha256: c.MANUAL_RETENTION_STATEMENT_SHA256 });
  const current = () => ({ decisionId, state: 'granted', revision: 1, statement: binding() });
  const tombstone = () => ({ decisionId, state: 'revoked', revision: 1, statement: null });
  const revoked = () => ({ decisionId, state: 'revoked', revision: 2, statement: binding() });
  const receipt = () => ({ operation: 'grant', decisionId, outcome: 'granted', decisionRevision: 1 });
  const result = state => ({ schema: c.MANUAL_RETENTION_COMMAND_RESULT_SCHEMA, receipt: receipt(), current: state });

  test(`${paths[index]} captures grant/revoke/attempt without activating or accepting authority fields`, () => {
    const raw = grant(), captured = c.captureManualRetentionGrantPayload(raw);
    assert.deepEqual(captured, raw); assert.notEqual(captured, raw); assert.ok(Object.isFrozen(captured));
    raw.decisionId = otherId; assert.equal(captured.decisionId, decisionId);
    assert.deepEqual(c.captureManualRetentionRevokePayload({}), {});
    assert.equal(c.captureManualRetentionRevokePayload({ decisionId }), null);
    assert.equal(c.captureManualRetentionGrantPayload({ ...grant(), accountId: 'injected' }), null);
    for (const change of [{ processing: 'photo' }, { purpose: 'training' }, { choice: 'unset' }, { statementVersion: 2 },
      { statementSha256: '0'.repeat(64) }, { decisionId: '' }, { statementId: 'form.body-consent/v1' }]) {
      assert.equal(c.captureManualRetentionGrantPayload({ ...grant(), ...change }), null);
    }
    const rawAttempt = attempt(), capturedAttempt = c.captureManualRetentionAttemptAuthority(rawAttempt);
    assert.deepEqual(capturedAttempt, rawAttempt); assert.ok(Object.isFrozen(capturedAttempt));
    rawAttempt.revision = 2; assert.equal(capturedAttempt.revision, 1);
    assert.equal(c.captureManualRetentionAttemptAuthority({ ...attempt(), bearer: 'forbidden' }), null);
    assert.equal(c.captureManualRetentionAttemptAuthority({ ...attempt(), revision: 2 }), null);
  });

  test(`${paths[index]} rejects accessors, inherited/hidden/symbol properties and throwing reflection`, () => {
    let getterCalls = 0;
    const accessor = grant(); Object.defineProperty(accessor, 'decisionId', { enumerable: true, get() { getterCalls++; return decisionId; } });
    assert.equal(c.captureManualRetentionGrantPayload(accessor), null); assert.equal(getterCalls, 0);
    assert.equal(c.captureManualRetentionGrantPayload(Object.create(grant())), null);
    const hidden = grant(); Object.defineProperty(hidden, 'secret', { value: true });
    assert.equal(c.captureManualRetentionGrantPayload(hidden), null);
    assert.equal(c.captureManualRetentionGrantPayload({ ...grant(), [Symbol('extra')]: true }), null);
    assert.equal(c.captureManualRetentionGrantPayload(new Proxy({}, { getPrototypeOf() { throw new Error('synthetic'); } })), null);
    const nullPrototype = Object.assign(Object.create(null), grant());
    assert.deepEqual(c.captureManualRetentionGrantPayload(nullPrototype), grant());
    assert.equal(c.captureManualRetentionRevokePayload([]), null);
    const nested = current(); Object.defineProperty(nested.statement, 'sha256', { enumerable: true, get() { getterCalls++; return c.MANUAL_RETENTION_STATEMENT_SHA256; } });
    assert.equal(c.captureManualRetentionCurrent(nested), null); assert.equal(getterCalls, 0);
  });

  test(`${paths[index]} receipt remains historical while current is fresh and semantically finite`, () => {
    for (const state of [current(), revoked()]) assert.deepEqual(c.captureManualRetentionCommandResult(result(state)), result(state));
    assert.equal(c.captureManualRetentionCommandResult(result(tombstone())), null);
    assert.equal(c.captureManualRetentionCommandResult(result({ ...current(), decisionId: otherId })), null);
    assert.equal(c.captureManualRetentionCurrent({ ...current(), revision: 2 }), null);
    assert.equal(c.captureManualRetentionCurrent({ ...current(), statement: null }), null);
    assert.equal(c.captureManualRetentionCurrent({ ...tombstone(), statement: binding() }), null);
    assert.equal(c.captureManualRetentionCurrent({ ...revoked(), statement: null }), null);
    for (const state of [tombstone(), revoked()]) {
      for (const operation of ['grant', 'revoke']) {
        const command = { schema: c.MANUAL_RETENTION_COMMAND_RESULT_SCHEMA,
          receipt: { operation, decisionId, outcome: operation === 'grant' ? 'blocked_by_revocation' : 'revoked', decisionRevision: state.revision }, current: state };
        const captured = c.captureManualRetentionCommandResult(command);
        assert.deepEqual(captured, command);
        assert.ok(Object.isFrozen(captured) && Object.isFrozen(captured.receipt) && Object.isFrozen(captured.current));
        assert.equal(c.captureManualRetentionCommandResult({ ...command, current: current() }), null);
      }
    }
    const raw = result(current()), captured = c.captureManualRetentionCommandResult(raw);
    raw.current.statement.sha256 = '0'.repeat(64); raw.receipt.decisionId = otherId;
    assert.equal(captured.current.statement.sha256, c.MANUAL_RETENTION_STATEMENT_SHA256);
    assert.equal(captured.receipt.decisionId, decisionId); assert.ok(Object.isFrozen(captured.current.statement));
    assert.equal(c.captureManualRetentionCommandResult({ ...result(current()), extra: true }), null);
  });

  test(`${paths[index]} GET has an explicit nullable envelope without receipt or fresh-choice inference`, () => {
    for (const state of [null, current(), tombstone(), revoked()]) {
      const input = { schema: 'form.manual-retention-current/v1', current: state };
      const captured = c.captureManualRetentionCurrentResult(input);
      assert.deepEqual(captured, input); assert.ok(Object.isFrozen(captured));
    }
    assert.equal(c.captureManualRetentionCurrentResult(current()), null);
    assert.equal(c.captureManualRetentionCurrentResult({ schema: 'form.manual-retention-current/v1' }), null);
    assert.equal(c.captureManualRetentionCurrentResult({ schema: 'form.manual-retention-current/v1', current: null, receipt: receipt() }), null);
    assert.equal(c.captureManualRetentionCurrentResult({ schema: c.MANUAL_RETENTION_COMMAND_RESULT_SCHEMA, current: null }), null);
  });

  test(`${paths[index]} exact single header grammar roundtrips and rejects combined, malformed or unknown bindings`, () => {
    const value = `v1;decision=${decisionId};revision=1;statement=${c.MANUAL_RETENTION_STATEMENT_SHA256}`;
    assert.equal(value.length, c.MANUAL_RETENTION_HEADER_LENGTH);
    assert.equal(c.formatManualRetentionHeader(attempt()), value);
    assert.deepEqual(c.parseManualRetentionHeader(value), attempt());
    for (const invalid of [null, [value], [value, value], `${value},${value}`, `${value};other=1`, ` ${value}`, `${value}\n`,
      value.replace('revision=1', 'revision=2'), value.replace('v1;', 'v2;'), value.replace('statement=', 'Statement='),
      value.replace(c.MANUAL_RETENTION_STATEMENT_SHA256, c.MANUAL_RETENTION_STATEMENT_SHA256.toUpperCase()),
      value.replace(c.MANUAL_RETENTION_STATEMENT_SHA256, '0'.repeat(64)), value.replace(decisionId, '0'.repeat(36))]) {
      assert.equal(c.parseManualRetentionHeader(invalid), null);
    }
    assert.equal(c.formatManualRetentionHeader({ ...attempt(), revision: 2 }), null);
  });
}
