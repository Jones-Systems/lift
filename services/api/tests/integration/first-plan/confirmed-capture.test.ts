import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Domain } from '../../../src/domain.js';
import { DomainError } from '../../../src/errors.js';
import { createCanonicalAccountWriter } from '../../../src/integration/account-modules/canonical-writer.js';
import { createConfirmedCaptureHost, confirmedCaptureKind, confirmedCaptureOperation,
  type CaptureContent } from '../../../src/integration/first-plan/confirmed-capture.js';
import { createR1CaptureContentPort, r1IntakeContentDigest, r1IntakeDefinition,
  type R1ContentAuthority } from '../../../src/integration/first-plan/r1-intake-content.js';
import { inspectConstraintCapture, type ConstraintCapture } from '../../../src/planning/constraints/confirmed-capture.js';
import { fixture as accountFixture } from '../account-modules/fixture.js';

// Invented content exercises persistence only; no production consent or clinical authority is supplied.
const content: CaptureContent = {
  inventory: { id: 'synthetic-questions', revision: '1',
    source: { id: 'synthetic-source', revision: '1', locator: 'fixture:invented', currentness: 'current', qualification: 'qualified' },
    questions: [{ id: 'synthetic-question', revision: '1', prompt: 'Synthetic literal prompt?', kind: 'text', required: true }],
    consent: { id: 'synthetic-consent', revision: '1', text: 'Synthetic retention permission only.' } },
  permission: { id: 'synthetic-policy', revision: '1', inventoryId: 'synthetic-questions', inventoryRevision: '1',
    statementId: 'synthetic-consent', statementRevision: '1', decision: 'granted', retention: 'retain_confirmed_capture_and_history' },
};
const payload = {
  answers: [{ questionId: 'synthetic-question', questionRevision: '1', response: { state: 'answered' as const, literal: '  Original literal answer.  ' } }],
  facts: [{ id: 'reported', kind: 'user_reported_history' as const, wording: '  My literal report.  ', region: 'unknown',
    side: 'unknown' as const, resolution: 'unknown' as const, reportedDate: null, reviewDate: null }],
  restrictionInventory: { response: { state: 'no' as const, literal: 'No instructions reported.' }, instructionIds: [] },
  consent: { decision: 'granted' as const, statementId: 'synthetic-consent', statementRevision: '1' },
};
const code = (value: string) => (error: unknown) => error instanceof DomainError && error.code === value;
function fixture(t: TestContext) {
  const f = accountFixture(); t.after(f.close);
  const domain = new Domain(f.db), writer = createCanonicalAccountWriter(f.db);
  let current: CaptureContent | null = structuredClone(content);
  const host = createConfirmedCaptureHost(domain, writer, { readWithinWrite: actor => {
    writer.assertWithinWrite(actor); return current;
  } });
  const input = () => {
    const result = host.review(f.one); assert.equal(result.status, 'ready');
    if (result.status !== 'ready') throw new Error('synthetic review unavailable');
    return { review: result.review, payload: structuredClone(payload) };
  };
  const count = (table: string) => (f.db.prepare(`SELECT count(*) n FROM ${table} WHERE account_id=?`).get(f.one.accountId) as { n: number }).n;
  const read = (receipt: ReturnType<typeof host.confirm>) => writer.lifecycle.withActiveWrite(f.one,
    () => host.readCurrentWithinWrite(f.one, { ...receipt.capture.pin, sessionId: f.one.sessionId }));
  return { ...f, domain, writer, host, input, count, read, configure: (next: CaptureContent | null) => { current = next; } };
}

test('unconfigured or revoked content and declined consent write neither documents nor receipts', t => {
  const f = fixture(t), input = f.input(), before = f.count('documents');
  const unconfigured = createConfirmedCaptureHost(f.domain, f.writer);
  assert.deepEqual(unconfigured.review(f.one), { status: 'unavailable' });
  assert.throws(() => unconfigured.confirm(f.one, 'missing', input), code('capture_unavailable'));
  f.configure(null);
  assert.throws(() => f.host.confirm(f.one, 'revoked', input), code('capture_unavailable'));
  f.configure(structuredClone(content));
  assert.throws(() => f.host.confirm(f.one, 'declined', { ...input, payload: { ...payload, consent: { ...payload.consent, decision: 'declined' } } }), code('capture_unavailable'));
  assert.equal(f.count('documents'), before); assert.equal(f.count('command_receipts'), 0);
});

test('literal capture and unresolved facts persist losslessly with inspected digest and server confirmation', t => {
  const f = fixture(t), input = f.input();
  const receipt = f.host.confirm(f.one, 'confirm', input);
  assert.equal(receipt.revision, 0); assert.deepEqual(receipt.capture.payload, payload);
  assert.deepEqual(receipt.capture.inventory, content.inventory);
  const inspected = inspectConstraintCapture(payload, content.inventory); assert.equal(inspected.status, 'captured');
  if (inspected.status === 'captured') assert.equal(receipt.capture.pin.digest, inspected.digest);
  assert.match(receipt.capture.confirmation.id, /^[a-f0-9-]{36}$/);
  assert.ok(Number.isFinite(Date.parse(receipt.capture.confirmation.confirmedAt)));
  assert.ok(Object.isFrozen(receipt.capture.payload.facts[0]));
  assert.equal(f.read(receipt).status, 'current');
  assert.equal(f.count('document_revisions'), 4); // Three initial account documents plus this capture.
  assert.equal(f.count('command_receipts'), 1);
});

test('complete replacement preserves identity, advances revision and leaves immutable original history', t => {
  const f = fixture(t), first = f.host.confirm(f.one, 'first', f.input());
  const input = f.input(); input.payload.answers[0]!.response.literal = 'Replacement literal.';
  const second = f.host.confirm(f.one, 'second', input);
  assert.equal(second.revision, 1); assert.equal(second.capture.pin.id, first.capture.pin.id);
  assert.notEqual(second.capture.confirmation.id, first.capture.confirmation.id);
  assert.equal(f.read(first).status, 'unavailable'); assert.equal(f.read(second).status, 'current');
  const rows = f.db.prepare('SELECT data FROM document_revisions WHERE account_id=? AND kind=? ORDER BY revision')
    .all(f.one.accountId, confirmedCaptureKind) as { data: string }[];
  assert.equal(rows.length, 2); assert.deepEqual(JSON.parse(rows[0]!.data).payload, payload);
  assert.throws(() => f.db.prepare('UPDATE document_revisions SET data=? WHERE account_id=? AND kind=?')
    .run('{}', f.one.accountId, confirmedCaptureKind), /immutable_document_history/);
  assert.throws(() => f.domain.patchDocument(f.one.accountId, confirmedCaptureKind, { expectedRevision: 1 }), code('confirmed_capture_whole_record_required'));
});

test('full profile and preference content CAS rejects unchanged-revision tampering', t => {
  for (const kind of ['profile', 'preferences']) {
    const f = fixture(t), input = f.input();
    const document = f.domain.document<Record<string, unknown>>(f.one.accountId, kind);
    const { revision: _revision, ...data } = document;
    if (kind === 'profile') data.name = 'Changed name outside planning subset'; else data.coachVoice = 'direct';
    f.db.prepare('UPDATE documents SET data=? WHERE account_id=? AND kind=?').run(JSON.stringify(data), f.one.accountId, kind);
    assert.throws(() => f.host.confirm(f.one, 'stale', input), code('capture_confirmation_stale'));
    assert.equal(f.count('command_receipts'), 0);
  }
});

test('original acknowledgment replays after correction but current witness fails and changed intent conflicts', t => {
  const f = fixture(t), input = f.input(), receipt = f.host.confirm(f.one, 'same-key', input);
  f.domain.patchDocument<{ name: string }>(f.one.accountId, 'profile', { expectedRevision: 0, name: 'Corrected' });
  assert.deepEqual(f.host.confirm(f.one, 'same-key', input), receipt);
  assert.equal(f.read(receipt).status, 'unavailable');
  const next = f.input();
  assert.throws(() => f.host.confirm(f.one, 'same-key', next), code('idempotency_mismatch'));
  f.configure(null);
  assert.deepEqual(f.host.confirm(f.one, 'same-key', input), receipt);
  assert.equal(f.read(receipt).status, 'unavailable');
});

test('same account replacement session cannot replay original actor intent or use original capture', t => {
  const f = fixture(t), input = f.input(), receipt = f.host.confirm(f.one, 'same-key', input);
  f.db.prepare('INSERT INTO session(id,userId,token,expiresAt,createdAt,updatedAt) VALUES(?,?,?,?,?,?)')
    .run('replacement', f.one.authUserId, 'synthetic-replacement', Date.now() + 600000, 1, 1);
  const replacement = { ...f.one, sessionId: 'replacement' };
  assert.throws(() => f.host.confirm(replacement, 'same-key', input), code('idempotency_mismatch'));
  assert.throws(() => f.host.confirm(replacement, 'new-key', input), code('capture_confirmation_stale'));
  assert.equal(f.writer.lifecycle.withActiveWrite(replacement,
    () => f.host.readCurrentWithinWrite(replacement, { ...receipt.capture.pin, sessionId: f.one.sessionId })).status, 'unavailable');
  f.db.prepare('DELETE FROM session WHERE id=?').run(f.one.sessionId);
  assert.throws(() => f.host.confirm(f.one, 'same-key', input), code('account_session_invalid'));
});

test('fresh witness requires canonical same-database transaction and exact pin', t => {
  const f = fixture(t), receipt = f.host.confirm(f.one, 'write', f.input());
  const pin = { ...receipt.capture.pin, sessionId: f.one.sessionId };
  assert.throws(() => f.host.readCurrentWithinWrite(f.one, pin));
  assert.throws(() => f.db.transaction(() => f.host.readCurrentWithinWrite(f.one, pin))());
  assert.equal(f.writer.lifecycle.withActiveWrite(f.one,
    () => f.host.readCurrentWithinWrite(f.one, { ...pin, digest: '0'.repeat(64) })).status, 'unavailable');
  const other = fixture(t);
  const foreign = createConfirmedCaptureHost(f.domain, other.writer, { readWithinWrite: () => content });
  assert.throws(() => foreign.review(other.one));
});

test('inventory or permission change invalidates currentness even without a changed inventory revision', t => {
  const f = fixture(t), receipt = f.host.confirm(f.one, 'write', f.input());
  const changed = structuredClone(content); changed.inventory.questions[0]!.prompt = 'Corrected prompt.';
  f.configure(changed); assert.equal(f.read(receipt).status, 'unavailable');
  f.configure({ ...structuredClone(content), permission: { ...content.permission, revision: '2' } });
  assert.equal(f.read(receipt).status, 'unavailable');
  f.configure({ ...structuredClone(content), permission: { ...content.permission, statementRevision: 'wrong' } });
  assert.equal(f.read(receipt).status, 'unavailable'); assert.equal(f.host.review(f.one).status, 'unavailable');
});

test('late trusted content changes roll back document, immutable history and command receipt together', t => {
  const f = fixture(t), input = f.input(); let calls = 0;
  const host = createConfirmedCaptureHost(f.domain, f.writer, { readWithinWrite: () => ++calls < 3 ? content : null });
  const documents = f.count('documents'), history = f.count('document_revisions');
  assert.throws(() => host.confirm(f.one, 'rollback', input), code('capture_confirmation_stale'));
  assert.equal(f.count('documents'), documents); assert.equal(f.count('document_revisions'), history);
  assert.equal(f.count('command_receipts'), 0);
});

test('unknown fields, wrong question revisions and inconsistent persisted digests fail closed', t => {
  const f = fixture(t), input = f.input();
  assert.throws(() => f.host.confirm(f.one, 'extra', { ...input, clinicalAuthority: true }), code('capture_confirmation_invalid'));
  input.payload.answers[0]!.questionRevision = 'missing';
  assert.throws(() => f.host.confirm(f.one, 'wrong-question', input), code('capture_confirmation_invalid'));
  const receipt = f.host.confirm(f.one, 'valid', f.input());
  const stored = f.domain.confirmedCapture(f.one.accountId)!;
  f.db.prepare('UPDATE documents SET data=? WHERE account_id=? AND kind=?')
    .run(JSON.stringify({ ...stored.record, pin: { ...stored.record.pin, digest: '0'.repeat(64) } }), f.one.accountId, confirmedCaptureKind);
  assert.throws(() => f.read(receipt), code('confirmed_capture_invalid_data'));
  assert.equal((f.db.prepare('SELECT count(*) n FROM command_receipts WHERE operation=?').get(confirmedCaptureOperation) as { n: number }).n, 1);
});


test('epoch change and account suppression deny writes and original replay before publication', t => {
  const f = fixture(t), input = f.input();
  f.host.confirm(f.one, 'original', input);
  f.db.prepare('UPDATE account_lifecycle SET epoch=epoch+1 WHERE account_id=?').run(f.one.accountId);
  assert.throws(() => f.host.confirm(f.one, 'original', input), code('account_epoch_changed'));
  const advanced = { ...f.one, epoch: 1 };
  assert.throws(() => f.host.confirm(advanced, 'original', input), code('idempotency_mismatch'));
  f.db.prepare("UPDATE account_lifecycle SET state='disabled',epoch=epoch+1,disabled_at_ms=1,suppression_seq=1 WHERE account_id=?").run(f.one.accountId);
  assert.throws(() => f.host.review(advanced), code('account_disabled'));
  assert.equal(f.count('command_receipts'), 1);
});

function r1Fixture(t: TestContext) {
  const f = fixture(t);
  // Synthetic policy callbacks prove receiver mechanics, not adoption of the real consent promise.
  let available = true;
  const trusted = {
    contentDigest: r1IntakeContentDigest,
    source: { id: 'synthetic-r1-content', revision: '1', locator: 'fixture:r1-only', currentness: 'current', qualification: 'qualified' },
    permission: { id: 'synthetic-r1-policy', revision: '1', inventoryId: r1IntakeDefinition.id,
      inventoryRevision: r1IntakeDefinition.revision, statementId: r1IntakeDefinition.consent.id,
      statementRevision: r1IntakeDefinition.consent.revision, decision: 'granted', retention: 'retain_confirmed_capture_and_history' },
    assertCurrent() { if (!available) throw new Error('synthetic-r1-revoked'); },
    assertPrivateCaptureOnly() {},
  } satisfies R1ContentAuthority;
  const actors: unknown[] = [];
  const port = createR1CaptureContentPort(actor => {
    f.writer.assertWithinWrite(actor); actors.push(actor); return available ? trusted : null;
  });
  const host = createConfirmedCaptureHost(f.domain, f.writer, port);
  const draft = (): ConstraintCapture => ({
    answers: r1IntakeDefinition.questions.filter(question => question.branch === 'core').map(question => ({
      questionId: question.id, questionRevision: question.revision,
      response: question.kind === 'text' ? { state: 'answered', literal: '  Synthetic literal context.  ' } :
        { state: ['form.r1.C03', 'form.r1.T23', 'form.r1.T24'].includes(question.id) ? 'yes' : 'no', literal: 'Synthetic response' },
    })), facts: [], restrictionInventory: { response: { state: 'no', literal: 'No reported instructions' }, instructionIds: [] },
    consent: { decision: 'granted', statementId: r1IntakeDefinition.consent.id, statementRevision: r1IntakeDefinition.consent.revision },
  });
  const input = (payload = draft()) => {
    const result = host.review(f.one, payload);
    assert.equal(result.status, 'ready');
    if (result.status !== 'ready') throw new Error('synthetic draft review unavailable');
    return { review: result.review, payload };
  };
  const read = (receipt: ReturnType<typeof host.confirm>) => f.writer.lifecycle.withActiveWrite(f.one,
    () => host.readCurrentWithinWrite(f.one, { ...receipt.capture.pin, sessionId: f.one.sessionId }));
  return { ...f, host, input, draft, read, port, trusted, actors, revoke() { available = false; } };
}

test('draft content requires a real draft and configured authority; decline never resolves authority or writes', t => {
  const f = r1Fixture(t), before = f.count('documents');
  assert.equal(f.host.review(f.one).status, 'unavailable');
  const declined = f.draft(); declined.consent.decision = 'declined';
  assert.equal(f.host.review(f.one, declined).status, 'unavailable');
  assert.equal(f.actors.length, 0);
  const absent = createConfirmedCaptureHost(f.domain, f.writer, createR1CaptureContentPort());
  assert.equal(absent.review(f.one, f.draft()).status, 'unavailable');
  const input = f.input();
  assert.throws(() => f.host.confirm(f.one, 'decline', { ...input, payload: declined }), code('capture_unavailable'));
  assert.throws(() => absent.confirm(f.one, 'absent', input), code('capture_unavailable'));
  assert.equal(f.count('documents'), before); assert.equal(f.count('command_receipts'), 0);
});

test('actual R1 answer and fact branches bind requiredness, literal payload and producer digests', t => {
  const f = r1Fixture(t), value = f.draft();
  for (const questionId of ['T12', 'T16', 'T20', 'T21', 'T22'].map(code => `form.r1.${code}`))
    value.answers.find(answer => answer.questionId === questionId)!.response = { state: 'yes', literal: '  Yes, as reported.  ' };
  value.answers.push({ questionId: 'form.r1.R04', questionRevision: '1', response: { state: 'yes', literal: 'Unresolved component report' } });
  value.facts.push({ id: 'literal-report', kind: 'user_reported_history', wording: '  Report only.  ', region: 'knee',
    side: 'left', resolution: 'reported', reportedDate: null, reviewDate: null });
  const input = f.input(value), receipt = f.host.confirm(f.one, 'r1', input);
  assert.deepEqual(receipt.capture.payload, value);
  assert.deepEqual(receipt.capture.contentBinding, input.review.contentBinding);
  assert.equal(receipt.capture.contentBinding!.contentDigest, r1IntakeContentDigest);
  assert.equal(receipt.capture.contentBinding!.captureDigest, receipt.capture.pin.digest);
  assert.equal(receipt.capture.inventory.questions.length, 64);
  for (const id of ['R01', 'H01', 'H02', 'V01', 'V02', 'N01', 'N07', 'N08', 'N12'])
    assert.equal(receipt.capture.inventory.questions.find(question => question.id === `form.r1.${id}`)!.required, true);
  assert.equal(f.read(receipt).status, 'current');
  assert.ok(f.actors.every(actor => { assert.deepEqual(actor, f.one); return Object.isFrozen(actor); }));
  assert.ok(Object.isFrozen(receipt.capture.contentBinding));
});

test('literal correction with identical branch requiredness invalidates the original draft review', t => {
  const f = r1Fixture(t), input = f.input(), original = structuredClone(input.payload);
  input.payload.answers[0]!.response.literal = 'Different literal with the same answer state';
  const next = f.input(input.payload);
  assert.deepEqual(next.review.inventory, input.review.inventory);
  assert.notEqual(next.review.contentBinding!.bindingDigest, input.review.contentBinding!.bindingDigest);
  assert.throws(() => f.host.confirm(f.one, 'stale-literal', input), code('capture_confirmation_stale'));
  assert.equal(f.count('command_receipts'), 0);
  const receipt = f.host.confirm(f.one, 'original-literal', { review: input.review, payload: original });
  assert.deepEqual(receipt.capture.payload, original);
});

test('current draft read materializes only the stored payload after verifying the original actor and pin', t => {
  const f = r1Fixture(t), input = f.input(), receipt = f.host.confirm(f.one, 'saved', input);
  input.payload.answers[0]!.response.literal = 'Caller mutation after confirmation';
  const priorCalls = f.actors.length;
  assert.equal(f.writer.lifecycle.withActiveWrite(f.one, () => f.host.readCurrentWithinWrite(f.one,
    { ...receipt.capture.pin, digest: '0'.repeat(64), sessionId: f.one.sessionId })).status, 'unavailable');
  assert.equal(f.actors.length, priorCalls);
  const current = f.read(receipt);
  assert.equal(current.status, 'current');
  if (current.status === 'current') assert.deepEqual(current.capture.payload, receipt.capture.payload);
  assert.notDeepEqual(receipt.capture.payload, input.payload);
});

test('every full content binding component is compared even when inventory and literal answers are unchanged', t => {
  for (const field of ['contentDigest', 'inventoryDigest', 'bindingDigest'] as const) {
    const f = r1Fixture(t); let changed = false;
    const host = createConfirmedCaptureHost(f.domain, f.writer, { readForCaptureWithinWrite(actor, capture) {
      const result = f.port.readForCaptureWithinWrite!(actor, capture);
      if (!result || !changed) return result;
      return { ...result, contentBinding: { ...result.contentBinding, [field]: '0'.repeat(64) } };
    } });
    const value = f.draft(), ready = host.review(f.one, value);
    if (ready.status !== 'ready') throw new Error('synthetic review unavailable');
    const input = { review: ready.review, payload: value };
    changed = true;
    assert.throws(() => host.confirm(f.one, 'changed-before-write', input), code('capture_confirmation_stale'));
    assert.equal(f.count('command_receipts'), 0);
    changed = false;
    const receipt = host.confirm(f.one, 'original', input);
    changed = true;
    assert.equal(f.writer.lifecycle.withActiveWrite(f.one, () => host.readCurrentWithinWrite(f.one,
      { ...receipt.capture.pin, sessionId: f.one.sessionId })).status, 'unavailable');
    assert.throws(() => host.confirm(f.one, 'changed', input), code('capture_confirmation_stale'));
    assert.deepEqual(host.confirm(f.one, 'original', input), receipt);
  }
});

test('revoked content or changed permission blocks currentness without rewriting historical acknowledgment', t => {
  const f = r1Fixture(t), input = f.input(), receipt = f.host.confirm(f.one, 'original', input);
  f.trusted.permission.revision = '2';
  assert.equal(f.read(receipt).status, 'unavailable');
  assert.deepEqual(f.host.confirm(f.one, 'original', input), receipt);
  f.revoke();
  assert.equal(f.read(receipt).status, 'unavailable');
  assert.deepEqual(f.host.confirm(f.one, 'original', input), receipt);
});

test('changing the original draft assertion after the write rolls back capture, history and receipt', t => {
  const f = r1Fixture(t), input = f.input(), documents = f.count('documents'), history = f.count('document_revisions');
  const replace = f.domain.replaceConfirmedCapture.bind(f.domain);
  f.domain.replaceConfirmedCapture = (...args) => {
    const result = replace(...args);
    f.trusted.assertCurrent = () => {};
    return result;
  };
  assert.throws(() => f.host.confirm(f.one, 'late-callback', input), /r1_content_changed/);
  assert.equal(f.count('documents'), documents); assert.equal(f.count('document_revisions'), history);
  assert.equal(f.count('command_receipts'), 0);
});

test('late draft assertions cannot publish a current witness after unchanged-revision profile mutation', t => {
  const f = r1Fixture(t), receipt = f.host.confirm(f.one, 'saved', f.input());
  let assertions = 0;
  const host = createConfirmedCaptureHost(f.domain, f.writer, { readForCaptureWithinWrite(actor, capture) {
    const result = f.port.readForCaptureWithinWrite!(actor, capture)!;
    return { ...result, assertCurrent(value) {
      result.assertCurrent(value);
      if (++assertions === 2) {
        const { revision: _revision, ...profile } = f.domain.document<Record<string, unknown>>(actor.accountId, 'profile');
        f.db.prepare('UPDATE documents SET data=? WHERE account_id=? AND kind=?')
          .run(JSON.stringify({ ...profile, name: 'Changed during assertion' }), actor.accountId, 'profile');
      }
    } };
  } });
  assert.equal(f.writer.lifecycle.withActiveWrite(f.one, () => host.readCurrentWithinWrite(f.one,
    { ...receipt.capture.pin, sessionId: f.one.sessionId })).status, 'unavailable');
  assert.equal(assertions, 2);
});

test('draft materialization cannot return a superseded pin when its authority replaces the stored capture', t => {
  const f = r1Fixture(t), receipt = f.host.confirm(f.one, 'saved', f.input());
  const original = f.domain.confirmedCapture(f.one.accountId)!;
  const replacement = structuredClone(original.record);
  replacement.pin.revision = '1'; replacement.confirmation.captureRevision = '1'; replacement.source.revision = '1';
  replacement.source.locator = `documents/${confirmedCaptureKind}/${replacement.pin.id}/1`;
  let replaced = false;
  const host = createConfirmedCaptureHost(f.domain, f.writer, { readForCaptureWithinWrite(actor, capture) {
    const result = f.port.readForCaptureWithinWrite!(actor, capture);
    if (!replaced) { replaced = true; f.domain.replaceConfirmedCapture(actor.accountId, 0, replacement); }
    return result;
  } });
  assert.equal(f.writer.lifecycle.withActiveWrite(f.one, () => host.readCurrentWithinWrite(f.one,
    { ...receipt.capture.pin, sessionId: f.one.sessionId })).status, 'unavailable');
  assert.equal(f.domain.confirmedCapture(f.one.accountId)!.revision, 1);
});

test('draft ports reject mismatched capture digests, asynchronous assertions and ambiguous configuration', t => {
  const f = r1Fixture(t);
  const mismatched = createConfirmedCaptureHost(f.domain, f.writer, { readForCaptureWithinWrite(actor, capture) {
    const result = f.port.readForCaptureWithinWrite!(actor, capture)!;
    return { ...result, contentBinding: { ...result.contentBinding, captureDigest: '0'.repeat(64) } };
  } });
  assert.equal(mismatched.review(f.one, f.draft()).status, 'unavailable');
  const asynchronous = createConfirmedCaptureHost(f.domain, f.writer, { readForCaptureWithinWrite(actor, capture) {
    const result = f.port.readForCaptureWithinWrite!(actor, capture)!;
    return { ...result, assertCurrent: async () => {} };
  } });
  assert.throws(() => asynchronous.review(f.one, f.draft()), code('capture_synchronous_content_required'));
  // @ts-expect-error A port must choose one content source; the runtime boundary enforces the same rule.
  assert.throws(() => createConfirmedCaptureHost(f.domain, f.writer, { readWithinWrite: () => content, readForCaptureWithinWrite: () => null }), code('capture_content_port_invalid'));
  assert.equal(f.count('command_receipts'), 0);
});
