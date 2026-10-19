const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, ApiError, id, input, report, receipt, deferred, fixture } = require('./fixture.cjs');
const { BugIntakeController } = load('features/bug-intake/controller.ts');
const { bugIntakeCopy, reportStatusCopy } = load('features/bug-intake/model.ts');

test('session construction is inert and diagnostics require explicit consent', t => {
  const f = fixture(); t.after(f.close);
  assert.equal(f.calls.length, 0); assert.equal(f.state.issuedKeys, 0);
  assert.equal(f.controller.getState().canSubmit, false);
  f.controller.edit(input());
  assert.equal(f.controller.getState().canSubmit, true);
  assert.deepEqual(f.controller.getState().draft, { ...input(), diagnosticConsent: false });
  f.controller.setDiagnostics(true, { platform: 'ios', appVersion: '1.0.0', screen: 'workout' });
  assert.equal(f.controller.getState().draft.diagnosticConsent, true);
  f.controller.setDiagnostics(false);
  assert.equal(f.controller.getState().draft.diagnostics, undefined);
  assert.equal(f.calls.length, 0);
  assert.throws(() => f.controller.edit({ accountId: 'other' }), { code: 'invalid_bug_report' });
  assert.throws(() => f.controller.setDiagnostics(true, { platform: 'ios', appVersion: '1.0.0', healthData: 'private' }), { code: 'invalid_bug_report' });
});

test('double submission has one flight and clears the draft only after validated acknowledgment', async t => {
  const pending = deferred(), f = fixture(() => pending.promise); t.after(f.close);
  f.controller.edit(input());
  const first = f.controller.submit(); await f.controller.submit();
  assert.equal(f.calls.length, 1); assert.equal(f.state.issuedKeys, 1);
  assert.equal(f.controller.getState().phase, 'submitting');
  assert.throws(() => f.controller.edit({ title: 'Changed' }), { code: 'bug_submission_pending' });
  assert.throws(() => f.controller.beginNew(), { code: 'bug_submission_pending' });
  pending.resolve(receipt()); await first;
  const state = f.controller.getState();
  assert.equal(state.phase, 'submitted'); assert.equal(state.submitted.id, id);
  assert.equal(state.draft.description, ''); assert.equal(state.canRetrySubmission, false);
  f.controller.beginNew(); assert.equal(f.controller.getState().phase, 'editing');
});

test('unknown report submission preserves immutable key and payload for explicit retry only', async t => {
  let attempts = 0;
  const f = fixture(async (_path, _method, body) => {
    if (++attempts === 1) throw new ApiError(0, 'network_unavailable', 'private raw error', true);
    return receipt(body, { replayed: true });
  }); t.after(f.close);
  f.controller.edit(input());
  f.controller.setDiagnostics(true, { platform: 'ios', appVersion: '1.2.3' });
  await f.controller.submit();
  assert.equal(f.controller.getState().phase, 'submission_unknown');
  assert.equal(f.controller.getState().canRetrySubmission, true);
  assert.equal(f.calls.length, 1);
  assert.throws(() => f.controller.edit({ description: 'New payload' }), { code: 'bug_submission_pending' });
  assert.throws(() => f.controller.setDiagnostics(false), { code: 'bug_submission_pending' });
  assert.throws(() => f.controller.beginNew(), { code: 'bug_submission_pending' });
  await assert.rejects(f.controller.submit(), { code: 'bug_submission_pending' });
  const exposed = f.controller.getState(); exposed.draft.title = 'Mutated snapshot'; exposed.draft.diagnostics.appVersion = '9.9.9';
  assert.equal(JSON.stringify(exposed).includes('synthetic-key-'), false);
  await f.controller.retrySubmission();
  assert.deepEqual(f.calls[0], f.calls[1]); assert.equal(f.state.issuedKeys, 1);
  assert.equal(f.controller.getState().phase, 'submitted');
  assert.equal(f.controller.getState().submitted.title, input().title);
});

test('a malformed acknowledgment is unknown, never displayed as success', async t => {
  const f = fixture(async () => ({ report: { id }, success: true })); t.after(f.close);
  f.controller.edit(input()); await f.controller.submit();
  assert.equal(f.controller.getState().phase, 'submission_unknown');
  assert.equal(f.controller.getState().submitted, null); assert.equal(f.calls.length, 1);
});

test('later known rejection does not erase an earlier uncertain submission', async t => {
  let attempts = 0;
  const f = fixture(async () => { throw ++attempts === 1
    ? new ApiError(0, 'network_unavailable', 'private', true) : new ApiError(429, 'bug_intake_report_limit', 'private'); }); t.after(f.close);
  f.controller.edit(input()); await f.controller.submit(); await f.controller.retrySubmission();
  assert.equal(f.controller.getState().phase, 'submission_unknown');
  assert.equal(f.controller.getState().canEdit, false); assert.equal(f.state.issuedKeys, 1);
  assert.deepEqual(f.calls[0], f.calls[1]);
});

test('conflicting retry keys stay blocked for reconciliation without replacement submission', async t => {
  let attempts = 0;
  const f = fixture(async () => { throw ++attempts === 1
    ? new ApiError(0, 'network_unavailable', 'private', true) : new ApiError(409, 'idempotency_key_conflict', 'private'); }); t.after(f.close);
  f.controller.edit(input()); await f.controller.submit(); await f.controller.retrySubmission();
  const state = f.controller.getState();
  assert.equal(state.phase, 'submission_unknown'); assert.equal(state.reason, 'idempotency_conflict'); assert.equal(state.canRetrySubmission, false);
  await assert.rejects(f.controller.retrySubmission(), { code: 'bug_retry_unavailable' });
  assert.equal(f.calls.length, 2); assert.equal(f.state.issuedKeys, 1);
});

test('known initial rejection stays editable and never leaks server error text', async t => {
  const f = fixture(async () => { throw new ApiError(429, 'bug_intake_report_limit', 'SECRET server text'); }); t.after(f.close);
  f.controller.edit(input()); await f.controller.submit();
  const state = f.controller.getState();
  assert.equal(state.phase, 'rejected'); assert.equal(state.reason, 'report_limit'); assert.equal(state.canEdit, true);
  assert.equal(JSON.stringify(state).includes('SECRET'), false);
  f.controller.edit({ title: 'Edited draft' }); assert.equal(f.controller.getState().reason, null);
});

test('invalid draft or key generates no request', async t => {
  const f = fixture(); t.after(f.close);
  await f.controller.submit(); assert.equal(f.controller.getState().reason, 'invalid_input');
  assert.equal(f.state.issuedKeys, 0);
  const controller = new BugIntakeController(f.resources, () => 'bad'); t.after(() => controller.dispose());
  controller.edit(input()); await controller.submit();
  assert.equal(controller.getState().reason, 'invalid_input'); assert.equal(f.calls.length, 0);
});

test('auth intent synchronously clears private state and late write cannot populate a new account', async t => {
  const pending = deferred(), f = fixture(() => pending.promise); t.after(f.close);
  const observed = []; f.controller.subscribe(state => observed.push(state));
  f.controller.edit(input()); const request = f.controller.submit();
  f.changeAuth();
  const cleared = f.controller.getState();
  assert.equal(cleared.phase, 'unavailable'); assert.equal(cleared.draft.description, ''); assert.equal(cleared.submitted, null);
  assert.equal(cleared.originalEffectUnknown, true); assert.equal(cleared.canRetrySubmission, false);
  assert.equal(observed.at(-1).phase, 'unavailable');
  const events = observed.length;
  pending.resolve(receipt()); await request;
  assert.equal(f.controller.getState().submitted, null); assert.equal(observed.length, events);
  await assert.rejects(f.controller.retrySubmission(), { code: 'session_changed' });
  assert.equal(f.calls.length, 1);
});

test('unknown report cannot retry after account change or same-account session replacement', async t => {
  for (const change of ['root', 'auth']) {
    const f = fixture(async () => { throw new ApiError(0, 'network_unavailable', 'unknown', true); }); t.after(f.close);
    f.controller.edit(input()); await f.controller.submit();
    if (change === 'root') f.state.current = false; else f.changeAuth();
    await assert.rejects(f.controller.retrySubmission(), { code: 'session_changed' });
    const state = f.controller.getState();
    assert.equal(state.phase, 'unavailable'); assert.equal(state.draft.title, ''); assert.equal(state.originalEffectUnknown, true);
    assert.equal(f.calls.length, 1);
  }
});

test('disposal clears private caches and observers and denies all retained callbacks', async t => {
  const f = fixture(async path => path.endsWith(id) ? { report: report() } : { reports: [report()] }); t.after(f.close);
  await f.controller.refresh(); await f.controller.loadReport(id);
  f.controller.edit(input());
  assert.equal(f.controller.getState().reports.length, 1); assert.equal(f.observers.size, 1);
  f.session.dispose();
  const state = f.controller.getState();
  assert.equal(state.phase, 'unavailable'); assert.equal(state.reason, 'disposed'); assert.deepEqual(state.reports, []);
  assert.equal(state.selected, null); assert.equal(state.draft.title, ''); assert.equal(f.observers.size, 0);
  await assert.rejects(f.controller.refresh(), { code: 'session_changed' });
  await assert.rejects(f.controller.submit(), { code: 'session_changed' }); assert.equal(f.calls.length, 2);
});

test('late read is dropped without mutation uncertainty; read failure preserves pending submission', async t => {
  const pending = deferred(), f = fixture(() => pending.promise); t.after(f.close);
  const read = f.controller.refresh(); f.changeAuth(); pending.resolve({ reports: [report()] }); await read;
  assert.deepEqual(f.controller.getState().reports, []); assert.equal(f.controller.getState().originalEffectUnknown, false);
  const other = fixture(async () => { throw new ApiError(503, 'unavailable', 'private', true); }); t.after(other.close);
  other.controller.edit(input()); await other.controller.submit(); await other.controller.refresh();
  assert.equal(other.controller.getState().phase, 'submission_unknown'); assert.equal(other.controller.getState().readReason, 'read_unavailable');
  assert.equal(other.controller.getState().canRetrySubmission, true);
});

test('dispatch_unknown is display-only and report status never claims a fix', async t => {
  const f = fixture(async () => ({ report: report(input(), { state: 'dispatch_unknown' }) })); t.after(f.close);
  await f.controller.loadReport(id);
  assert.equal(f.controller.getState().selected.state, 'dispatch_unknown'); assert.equal(f.controller.getState().canRetrySubmission, false);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0][1], 'GET');
  assert.match(reportStatusCopy.dispatch_unknown, /unconfirmed/);
  assert.match(reportStatusCopy.dispatched, /does not confirm a fix/);
  assert.match(bugIntakeCopy.unknown, /same report/);
});

test('authentication rejection invalidates the controller rather than allowing another submission', async t => {
  const f = fixture(async () => { throw new ApiError(401, 'authentication_required', 'private'); }); t.after(f.close);
  f.controller.edit(input()); await f.controller.submit();
  assert.equal(f.controller.getState().phase, 'unavailable'); assert.equal(f.controller.getState().reason, 'authentication_required');
  assert.equal(f.controller.getState().draft.description, '');
  await assert.rejects(f.controller.submit(), { code: 'session_changed' }); assert.equal(f.calls.length, 1);
});
