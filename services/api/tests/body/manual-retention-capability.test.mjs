import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import * as api from '../../src/body/manual-retention-contract.ts';
import * as app from '../../../../apps/form/src/body/manualRetentionContract.ts';
const apiSource = new URL('../../src/body/manual-retention-contract.ts', import.meta.url);
const appSource = new URL('../../../../apps/form/src/body/manualRetentionContract.ts', import.meta.url);

test('actual API and APP capability modules retain exact byte and exported constant parity', () => {
  assert.equal(readFileSync(apiSource, 'utf8'), readFileSync(appSource, 'utf8'));
  assert.equal(api.MANUAL_RETENTION_CAPABILITY_SCHEMA, app.MANUAL_RETENTION_CAPABILITY_SCHEMA);
  assert.deepEqual(api.MANUAL_RETENTION_STATEMENT_BINDING, app.MANUAL_RETENTION_STATEMENT_BINDING);
  for (const status of ['available', 'unavailable']) {
    const cap = { schema: api.MANUAL_RETENTION_CAPABILITY_SCHEMA, protocol: api.MANUAL_RETENTION_PROTOCOL, status,
      statement: api.MANUAL_RETENTION_STATEMENT_BINDING, grant: status, revoke: status, current: status };
    assert.deepEqual(api.captureManualRetentionCapability(cap), cap);
    assert.deepEqual(app.captureManualRetentionCapability(cap), cap);
    for (const invalid of [{ ...cap, extra: true }, { ...cap, statement: api.MANUAL_RETENTION_STATEMENT },
      { ...cap, protocol: 'form.manual-retention/v2' }, { ...cap, grant: status === 'available' ? 'unavailable' : 'available' },
      { ...cap, statement: { ...cap.statement, sha256: '0'.repeat(64) } }, { ...cap, status: 'ready' }]) {
      assert.equal(api.captureManualRetentionCapability(invalid), null);
      assert.equal(app.captureManualRetentionCapability(invalid), null);
    }
    const accessor = { ...cap }; Object.defineProperty(accessor, 'current', { enumerable: true, get() { throw new Error('Do not invoke'); } });
    assert.equal(api.captureManualRetentionCapability(accessor), null);
  }
});
