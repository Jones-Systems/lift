const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const ts = require('typescript');
const modules = new Map();
function load(file) {
  if (modules.has(file)) return modules.get(file);
  const compiled = ts.transpileModule(readFileSync(join(__dirname, '..', file), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', compiled)(name => {
    const allowed = { './manualRetentionContract': 'manualRetentionContract.ts' };
    assert.ok(allowed[name], `unexpected import ${name}`); return load(allowed[name]);
  }, mod, mod.exports);
  modules.set(file, mod.exports); return mod.exports;
}
const c = load('manualRetentionContract.ts');
const { validateManualRetentionCommandConfirmation: validate } = load('manualRetentionConfirmation.ts');
const id = '12345678-1234-4234-8234-123456789012';
const payload = { decisionId: id, processing: 'manual_entry', purpose: 'personal_measurement_progress', choice: 'retain',
  statementId: c.MANUAL_RETENTION_STATEMENT.id, statementVersion: 1, statementSha256: c.MANUAL_RETENTION_STATEMENT_SHA256 };
const grant = { operation: 'grant_manual_retention', command: { key: 'grant', payload } };
const revoke = { operation: 'revoke_manual_retention', command: { key: 'revoke', decisionId: id, payload: {} } };
const current = { decisionId: id, state: 'granted', revision: 1, statement: c.MANUAL_RETENTION_STATEMENT_BINDING };
const result = { schema: c.MANUAL_RETENTION_COMMAND_RESULT_SCHEMA,
  receipt: { operation: 'grant', decisionId: id, outcome: 'granted', decisionRevision: 1 }, current };

test('strict grant confirmation accepts historical receipts with terminal revoked current state', () => {
  assert.equal(validate(grant, result), true);
  assert.equal(validate(grant, { ...result, current: { ...current, state: 'revoked', revision: 2 } }), true);
  assert.equal(validate(revoke, result), false);
});
test('revoke-before-grant tombstone and blocked grant are valid distinct receipts', () => {
  const tombstone = { decisionId: id, state: 'revoked', revision: 1, statement: null };
  for (const revision of [1, 2]) {
    const state = revision === 1 ? tombstone : { ...current, state: 'revoked', revision: 2 };
    assert.equal(validate(revoke, { ...result, receipt: { operation: 'revoke', decisionId: id, outcome: 'revoked', decisionRevision: revision }, current: state }), true);
    assert.equal(validate(grant, { ...result, receipt: { operation: 'grant', decisionId: id, outcome: 'blocked_by_revocation', decisionRevision: revision }, current: state }), true);
  }
  assert.equal(validate(grant, { ...result, current: tombstone }), false);
});
test('mismatched identities, schemas, extras, accessors and malformed bindings cannot confirm', () => {
  for (const invalid of [null, {}, { ...result, extra: true }, { ...result, schema: c.MANUAL_RETENTION_CURRENT_RESULT_SCHEMA },
    { ...result, receipt: { ...result.receipt, decisionId: '22345678-1234-4234-8234-123456789012' } },
    { ...result, current: { ...current, statement: { ...current.statement, sha256: '0'.repeat(64) } } },
    { ...result, current: { ...current, state: 'revoked', revision: 1 } }]) assert.equal(validate(grant, invalid), false);
  let reads = 0;
  const accessor = { ...result }; Object.defineProperty(accessor, 'receipt', { enumerable: true, get() { reads++; return result.receipt; } });
  assert.equal(validate(grant, accessor), false); assert.equal(reads, 0);
  assert.equal(validate({ ...grant, extra: true }, result), false);
  assert.equal(validate({ ...grant, command: { ...grant.command, payload: { ...payload, choice: 'photos' } } }, result), false);
  assert.equal(validate({ operation: 'save_manual_measurement', command: grant.command }, result), false);
});
