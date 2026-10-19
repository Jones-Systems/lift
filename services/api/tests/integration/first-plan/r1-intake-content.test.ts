import test from 'node:test';
import assert from 'node:assert/strict';
import { createR1CaptureContentPort, materializeR1Intake, r1IntakeContentDigest, r1IntakeDefinition,
  type R1ContentAuthority, type R1Materialization } from '../../../src/integration/first-plan/r1-intake-content.js';
import { captureInventorySchema } from '../../../src/integration/first-plan/confirmed-capture.js';
import { inspectConstraintCapture, type ConstraintCapture } from '../../../src/planning/constraints/confirmed-capture.js';

type Response = ConstraintCapture['answers'][number]['response'];
type Materialized = Extract<R1Materialization, { status: 'materialized' }>;
const id = (code: string) => `form.r1.${code}`;
const yes = (): Response => ({ state: 'yes', literal: 'Yes' });
const no = (): Response => ({ state: 'no', literal: 'No' });
const unknown = (): Response => ({ state: 'unknown', literal: 'Not sure', reason: 'unclear' });
function capture(): ConstraintCapture {
  return {
    answers: r1IntakeDefinition.questions.filter(question => question.branch === 'core').map(question => ({
      questionId: question.id, questionRevision: question.revision,
      response: question.kind === 'text' ? { state: 'answered', literal: `  Synthetic ${question.id}.  ` } :
        ['C03', 'T23', 'T24'].some(code => id(code) === question.id) ? yes() : no(),
    })),
    facts: [], restrictionInventory: { response: no(), instructionIds: [] },
    consent: { decision: 'granted', statementId: r1IntakeDefinition.consent.id, statementRevision: '1' },
  };
}
function authority(): R1ContentAuthority {
  return {
    contentDigest: r1IntakeContentDigest,
    source: { id: 'synthetic-content-attestation', revision: '1', locator: 'fixture:content-only', currentness: 'current', qualification: 'qualified' },
    permission: { id: 'synthetic-private-capture-permission', revision: '1', inventoryId: r1IntakeDefinition.id,
      inventoryRevision: r1IntakeDefinition.revision, statementId: r1IntakeDefinition.consent.id,
      statementRevision: '1', decision: 'granted', retention: 'retain_confirmed_capture_and_history' },
    assertCurrent() {}, assertPrivateCaptureOnly() {},
  };
}
function answer(value: ConstraintCapture, code: string, response: Response): void {
  const existing = value.answers.find(entry => entry.questionId === id(code));
  if (existing) existing.response = response;
  else value.answers.push({ questionId: id(code), questionRevision: '1', response });
}
function materialized(value: ConstraintCapture = capture(), trusted = authority()): Materialized {
  const result = materializeR1Intake(value, trusted);
  assert.equal(result.status, 'materialized');
  if (result.status !== 'materialized') throw new Error('Expected synthetic materialization');
  return result;
}
const hasGap = (value: R1Materialization, code: string) => value.gaps.some(gap => gap.code === code);
const required = (value: Materialized, code: string) => value.content.inventory.questions.find(question => question.id === id(code))!.required;
const branch = (value: Materialized, name: string) => value.branches.find(entry => entry.branch === name)!;
function instruction(value: ConstraintCapture): void {
  value.facts.push({ id: 'reported-instruction', kind: 'clinician_instruction_as_reported', wording: '  Original instruction, not interpreted.  ',
    region: 'knee', side: 'left', resolution: 'reported', reportedDate: null, reviewDate: null });
  value.restrictionInventory = { response: yes(), instructionIds: ['reported-instruction'] };
  answer(value, 'C01', yes());
}

test('fixed Form content preserves fifty original IDs, two leg followups and twelve neurological clarifications', () => {
  const expected = [
    ...Array.from({ length: 24 }, (_, index) => `T${String(index + 1).padStart(2, '0')}`),
    'E01', 'E02', 'L01', 'L02', 'L03', 'L04', 'C01', 'C02', 'C03', 'P01', 'P02', 'P03',
    ...Array.from({ length: 12 }, (_, index) => `R${String(index + 1).padStart(2, '0')}`), 'H01', 'H02', 'V01', 'V02',
    ...Array.from({ length: 12 }, (_, index) => `N${String(index + 1).padStart(2, '0')}`),
  ].map(id);
  assert.deepEqual(r1IntakeDefinition.questions.map(question => question.id), expected);
  assert.equal(new Set(expected).size, 64);
  assert.equal(r1IntakeDefinition.originalQuestionCount, 50);
  assert.equal(r1IntakeDefinition.additionalFollowupCount, 14);
  assert.equal(r1IntakeDefinition.neurologicalFollowupCount, 12);
  assert.equal(r1IntakeDefinition.questions.filter(question => question.branch === 'core').length, 33);
  assert.ok(r1IntakeDefinition.questions.every(question => question.revision === (question.id === id('T07') ? '2' : '1')));
  assert.match(r1IntakeDefinition.authorship, /not a validated instrument/);
  assert.match(r1IntakeContentDigest, /^[a-f0-9]{64}$/);
  assert.ok(Object.isFrozen(r1IntakeDefinition.questions[0]));
});

test('corrected literal questions, consent and separate confirmation remain exact', () => {
  const prompt = (code: string) => r1IntakeDefinition.questions.find(question => question.id === id(code))!.prompt;
  assert.equal(prompt('T01'), 'Are you experiencing muscle cramps, aches or pains that are more severe than expected?');
  assert.equal(prompt('T03'), 'Are you experiencing weakness or tiredness that prevents you from completing tasks or a workout you could previously manage?');
  assert.equal(prompt('T07'), 'Have you suddenly developed facial weakness or drooping, difficulty speaking, limb weakness, one-sided numbness, or blurred or lost vision, including symptoms that have now stopped?');
  assert.equal(prompt('V01'), 'Does this concern include pain or swelling in that leg?');
  assert.equal(prompt('V02'), 'Are you short of breath or having chest pain?');
  assert.equal(r1IntakeDefinition.consent.text, 'Allow Form to privately save these answers and instructions in your account, including their revision history, to prepare and explain your training choices. Form will not advertise with, sell, share or reuse this capture for another purpose. You can decline. Confirming your answers does not provide medical clearance.');
  assert.equal(r1IntakeDefinition.confirmation, 'These are my answers and the instructions I supplied. Use this exact version for this request.');
  assert.deepEqual(r1IntakeDefinition.unknownChoices, [
    { label: 'Not sure', state: 'unknown', reason: 'unclear' }, { label: 'Prefer not to say', state: 'unknown', reason: 'declined' },
  ]);
});

test('materialization uses the actual inventory and capture digest without producing clearance', () => {
  const input = capture(), result = materialized(input);
  assert.deepEqual(captureInventorySchema.parse(result.content.inventory), result.content.inventory);
  const inspected = inspectConstraintCapture(input, result.content.inventory);
  assert.equal(inspected.status, 'captured');
  if (inspected.status === 'captured') assert.equal(result.captureDigest, inspected.digest);
  assert.deepEqual(result.capture, input);
  assert.equal(result.contentDigest, r1IntakeContentDigest);
  for (const value of [result.inventoryDigest, result.captureDigest, result.bindingDigest]) assert.match(value, /^[a-f0-9]{64}$/);
  for (const code of ['r1_clinical_classifier_unavailable', 'r1_primary_rule_carrier_unavailable', 'r1_care_resources_unavailable']) assert.ok(hasGap(result, code));
  for (const key of ['qualified', 'complete', 'r1', 'clearance', 'rules', 'receipt']) assert.equal(Object.hasOwn(result, key), false);
  result.assertCurrent(input);
});

test('declined consent returns no capture or digest and invokes no trusted authority callback', () => {
  const input = capture(); input.consent.decision = 'declined';
  let calls = 0;
  const trusted = { ...authority(), assertCurrent() { calls++; throw new Error('unexpected'); }, assertPrivateCaptureOnly() { calls++; throw new Error('unexpected'); } };
  assert.deepEqual(materializeR1Intake(input, trusted), { status: 'declined', gaps: [{ code: 'capture_consent_declined' }] });
  assert.equal(calls, 0);
  assert.deepEqual(materializeR1Intake(input), { status: 'declined', gaps: [{ code: 'capture_consent_declined' }] });
});

test('missing, changed or unqualified trusted content and private-capture permission stay unavailable', () => {
  const trusted = authority();
  assert.equal(materializeR1Intake(capture()).status, 'unavailable');
  const invalidAuthorities: R1ContentAuthority[] = [
    { ...trusted, contentDigest: '0'.repeat(64) },
    { ...trusted, source: { ...trusted.source, currentness: 'unknown' } },
    { ...trusted, source: { ...trusted.source, qualification: 'unreviewed' } },
    { ...trusted, permission: { ...trusted.permission, inventoryRevision: 'other' } },
    { ...trusted, permission: { ...trusted.permission, statementId: 'other' } },
    { ...trusted, assertPrivateCaptureOnly() { throw new Error('private use not enforced'); } },
    { ...trusted, assertCurrent() { throw new Error('superseded'); } },
    { ...trusted, assertCurrent: () => Promise.resolve() },
  ];
  for (const candidate of invalidAuthorities) assert.equal(materializeR1Intake(capture(), candidate).status, 'unavailable');
  const input = capture(); input.consent.statementRevision = 'other';
  assert.equal(materializeR1Intake(input, trusted).status, 'unavailable');
  let calls = 0;
  const changesDuringCallback = { ...authority(), assertPrivateCaptureOnly() {
    if (++calls === 2) this.permission.statementRevision = 'changed-during-final-assertion';
  } };
  assert.equal(materializeR1Intake(capture(), changesDuringCallback).status, 'unavailable');
});

test('canonical unknown reasons and literal choices survive without negative inference', () => {
  for (const reason of ['unclear', 'declined', 'blank', 'conflicting', 'unavailable', 'unresolved'] as const) {
    const input = capture(); answer(input, 'T22', { state: 'unknown', literal: reason === 'declined' ? 'Prefer not to say' : '  Original uncertainty  ', reason });
    const result = materialized(input);
    assert.deepEqual(result.capture.answers.find(entry => entry.questionId === id('T22')), input.answers.find(entry => entry.questionId === id('T22')));
    assert.equal(branch(result, 'regional').state, 'unresolved');
    assert.ok(hasGap(result, 'r1_branch_trigger_unresolved'));
  }
  const input = capture();
  assert.equal(materializeR1Intake({ ...input, qualified: true }, authority()).status, 'invalid');
  assert.equal(materializeR1Intake({ ...input, answers: [{ questionId: id('T22'), questionRevision: '1', response: { state: 'unknown', literal: 'Not sure', reason: 'not_sure' } }] }, authority()).status, 'invalid');
});

test('only explicit positive or region-bearing reported evidence requires the regional branch', () => {
  const input = capture(); answer(input, 'T22', yes());
  const result = materialized(input);
  assert.equal(branch(result, 'regional').state, 'required');
  for (let index = 1; index <= 10; index++) assert.equal(required(result, `R${String(index).padStart(2, '0')}`), true);
  assert.equal(required(result, 'R11'), false); assert.equal(required(result, 'R12'), false);
  assert.ok(hasGap(result, 'r1_region_identity_unavailable'));
  const history = capture(); history.facts.push({ id: 'history', kind: 'user_reported_history', wording: 'My own report', region: 'ankle', side: 'right', resolution: 'reported', reportedDate: null, reviewDate: null });
  assert.equal(branch(materialized(history), 'regional').state, 'required');
  history.facts[0]!.region = 'none';
  assert.equal(branch(materialized(history), 'regional').state, 'not_required');
  history.facts[0]!.region = 'unknown';
  const unresolved = materialized(history);
  assert.equal(branch(unresolved, 'regional').state, 'unresolved');
  assert.deepEqual(unresolved.gaps.find(gap => gap.code === 'capture_fact_unresolved'), { code: 'capture_fact_unresolved', factId: 'history' });
});

test('region-only clinician instructions preserve unknown familiarity and original wording', () => {
  const input = capture(); instruction(input); answer(input, 'R09', unknown());
  const result = materialized(input);
  assert.equal(branch(result, 'regional').state, 'required');
  assert.deepEqual(branch(result, 'regional').factIds, ['reported-instruction']);
  assert.equal(result.capture.facts[0]!.wording, '  Original instruction, not interpreted.  ');
  assert.equal(result.capture.answers.find(entry => entry.questionId === id('R09'))!.response.state, 'unknown');
  assert.ok(hasGap(result, 'r1_instruction_mapping_unavailable'));
  assert.ok(result.gaps.some(gap => gap.code === 'capture_answer_unknown' && gap.questionId === id('R09')));
  input.facts[0]!.wording = ''; input.facts[0]!.side = 'unknown';
  assert.ok(materialized(input).gaps.some(gap => gap.code === 'capture_fact_unresolved' && gap.factId === 'reported-instruction'));
  const { side: _side, ...incomplete } = input.facts[0]!;
  assert.equal(materializeR1Intake({ ...input, facts: [incomplete] }, authority()).status, 'invalid');
});

test('selected variant exclusion alone never creates a symptom branch or a qualified mapping', () => {
  const input = capture(); answer(input, 'C02', yes());
  input.facts.push({ id: 'excluded', kind: 'user_exclusion', wording: 'Do not use this variant.', region: 'shoulder', side: 'left', resolution: 'reported', reportedDate: null, reviewDate: null, variantIds: ['actual-selected-variant'] });
  input.restrictionInventory = { response: yes(), instructionIds: ['excluded'] };
  const result = materialized(input);
  assert.equal(branch(result, 'regional').state, 'not_required');
  assert.deepEqual(branch(result, 'regional').factIds, []);
  assert.deepEqual(result.capture.facts, input.facts);
  assert.ok(hasGap(result, 'r1_selected_variant_inventory_unavailable'));
});

test('health and leg followups derive requiredness from their exact original trigger answers', () => {
  for (const [trigger, followup, branchName] of [['T21', 'H01', 'condition'], ['T20', 'H02', 'return_to_exercise'], ['T12', 'V01', 'leg_followup']] as const) {
    const input = capture(); assert.equal(required(materialized(input), followup), false);
    answer(input, trigger, yes());
    const positive = materialized(input);
    assert.equal(required(positive, followup), true); assert.equal(branch(positive, branchName).state, 'required');
    if (trigger === 'T12') assert.equal(required(positive, 'V02'), true);
    answer(input, trigger, unknown());
    assert.equal(branch(materialized(input), branchName).state, 'unresolved');
  }
});

test('planning questions remain optional and omission does not infer equipment or time', () => {
  const input = capture(), result = materialized(input);
  for (const code of ['P01', 'P02', 'P03']) {
    assert.equal(required(result, code), false);
    assert.equal(result.capture.answers.some(entry => entry.questionId === id(code)), false);
  }
  answer(input, 'P03', { state: 'answered', literal: '  I have not chosen a duration.  ' });
  assert.equal(materialized(input).capture.answers.find(entry => entry.questionId === id('P03'))!.response.literal, '  I have not chosen a duration.  ');
});

test('empty restriction coverage requires the explicit three-answer combination', () => {
  const empty = materialized();
  assert.equal(hasGap(empty, 'r1_empty_restriction_inventory_unconfirmed'), false);
  for (const [code, response] of [['C01', yes()], ['C02', yes()], ['C03', no()], ['C03', unknown()]] as const) {
    const input = capture(); answer(input, code, response);
    const result = materialized(input);
    assert.ok(hasGap(result, 'r1_empty_restriction_inventory_unconfirmed'));
    assert.ok(hasGap(result, code === 'C03' ? 'r1_restriction_coverage_unconfirmed' : 'r1_instruction_answer_mismatch'));
  }
  const input = capture(); instruction(input); answer(input, 'C01', no());
  assert.ok(hasGap(materialized(input), 'r1_instruction_answer_mismatch'));
});

test('each corrected CDC sign independently matches only an unqualified immediate-attention proposal', () => {
  for (const code of ['T01', 'T02', 'T03']) {
    const input = capture(); answer(input, code, yes());
    const result = materialized(input), predicate = result.predicates.find(entry => entry.id === 'cdc_rhabdomyolysis_signs')!;
    assert.equal(predicate.state, 'matched'); assert.equal(predicate.action, 'immediate_medical_attention');
    assert.equal(predicate.authority, 'primary_carrier_required');
    assert.ok(hasGap(result, 'r1_primary_rule_carrier_unavailable'));
    assert.equal(JSON.stringify(result).includes('ambulance'), false);
  }
});

test('NHS conjunction needs both exact followups and never substitutes compound T13', () => {
  const input = capture(); answer(input, 'T12', yes()); answer(input, 'T13', yes());
  const predicate = (value: ConstraintCapture) => materialized(value).predicates.find(entry => entry.id === 'nhs_leg_pain_swelling_and_breathlessness_or_chest_pain')!;
  assert.equal(predicate(input).state, 'unresolved');
  answer(input, 'V01', yes()); answer(input, 'V02', yes());
  assert.equal(predicate(input).state, 'matched');
  assert.deepEqual(predicate(input).questionIds, ['T12', 'V01', 'V02'].map(id));
  for (const missing of ['V01', 'V02']) for (const otherState of [yes(), no()]) {
    answer(input, missing === 'V01' ? 'V02' : 'V01', otherState); answer(input, missing, unknown());
    assert.equal(predicate(input).state, 'unresolved');
  }
  answer(input, 'V01', no()); answer(input, 'V02', no());
  assert.equal(predicate(input).state, 'not_matched');
});

test('unsupported neurological and regional meanings do not acquire lower-urgency rules', () => {
  const input = capture();
  for (const code of ['T16', 'T17', 'R03', 'R04']) answer(input, code, yes());
  const result = materialized(input);
  assert.equal(result.predicates.length, 2);
  assert.ok(hasGap(result, 'r1_clinical_classifier_unavailable'));
  assert.equal(JSON.stringify(result).includes('same_day'), false);
  assert.equal(JSON.stringify(result).includes('clinical_review'), false);
});

test('missing mandatory answers remain explicit and malformed answer bindings reject', () => {
  const input = capture(); input.answers = input.answers.filter(entry => entry.questionId !== id('T01'));
  assert.ok(materialized(input).gaps.some(gap => gap.code === 'capture_answer_unknown' && gap.questionId === id('T01')));
  for (const mutate of [
    (value: ConstraintCapture) => { value.answers.push(structuredClone(value.answers[0]!)); },
    (value: ConstraintCapture) => { value.answers[0]!.questionRevision = '2'; },
    (value: ConstraintCapture) => { value.answers.find(entry => entry.questionId === id('T07'))!.questionRevision = '1'; },
    (value: ConstraintCapture) => { answer(value, 'T01', { state: 'answered', literal: 'Unparsed prose' }); },
    (value: ConstraintCapture) => { answer(value, 'unlisted', no()); },
  ]) {
    const candidate = capture(); mutate(candidate);
    assert.equal(materializeR1Intake(candidate, authority()).status, 'invalid');
  }
});

test('literal, order, branch and instruction corrections invalidate the exact binding', () => {
  const input = capture(), trusted = authority(), original = materialized(input, trusted);
  const changes: ((value: ConstraintCapture) => void)[] = [
    value => { value.answers[0]!.response.literal = 'No, corrected literal'; },
    value => { value.answers.reverse(); },
    value => { answer(value, 'T22', yes()); },
    value => { instruction(value); },
  ];
  for (const change of changes) {
    const corrected = structuredClone(input); change(corrected);
    assert.throws(() => original.assertCurrent(corrected), /r1_capture_changed/);
    const next = materialized(corrected, trusted);
    assert.notEqual(next.captureDigest, original.captureDigest); assert.notEqual(next.bindingDigest, original.bindingDigest);
  }
  const changedBranch = structuredClone(input); answer(changedBranch, 'T22', yes());
  assert.notEqual(materialized(changedBranch, trusted).inventoryDigest, original.inventoryDigest);
  const declined = structuredClone(input); declined.consent.decision = 'declined';
  assert.throws(() => original.assertCurrent(declined), /r1_capture_changed/);
});

test('detached frozen content cannot change through caller payload or trusted-port mutation', () => {
  const input = capture(), trusted = authority(), result = materialized(input, trusted);
  const originalLiteral = result.capture.answers[0]!.response.literal;
  input.answers[0]!.response.literal = 'Changed externally';
  assert.equal(result.capture.answers[0]!.response.literal, originalLiteral);
  assert.ok(Object.isFrozen(result.capture.answers[0]!.response));
  assert.ok(Object.isFrozen(result.content.inventory.questions[0]));
  assert.throws(() => { result.capture.answers[0]!.response.literal = 'Cannot mutate'; }, TypeError);
  trusted.permission.statementRevision = 'replacement';
  assert.throws(() => result.assertCurrent(capture()), /r1_content_changed/);
  assert.equal(result.content.permission.statementRevision, '1');
});

test('captured currentness and original trusted callbacks are rechecked after materialization', () => {
  let current = true;
  const trusted = { ...authority(), assertCurrent() { if (!current) throw new Error('original session expired'); } };
  const input = capture(), result = materialized(input, trusted);
  current = false;
  assert.throws(() => result.assertCurrent(input), /original session expired/);
  current = true; trusted.assertCurrent = () => {};
  assert.throws(() => result.assertCurrent(input), /r1_content_changed/);
});

test('draft receiver factory passes the original detached actor and exact materialized binding', () => {
  const actor = { accountId: 'synthetic-account', authUserId: 'synthetic-auth', sessionId: 'synthetic-session', epoch: 2 };
  const original = structuredClone(actor), input = capture(), trusted = authority(), expected = materialized(input, trusted);
  let resolvedActor: unknown;
  const port = createR1CaptureContentPort(value => { resolvedActor = value; return trusted; });
  const result = port.readForCaptureWithinWrite!(actor, input)!;
  assert.deepEqual(resolvedActor, original); assert.ok(Object.isFrozen(resolvedActor));
  assert.deepEqual(result.content, expected.content);
  assert.deepEqual(result.contentBinding, { schema: 'form.r1-capture-binding/v1', contentDigest: expected.contentDigest,
    inventoryDigest: expected.inventoryDigest, captureDigest: expected.captureDigest, bindingDigest: expected.bindingDigest });
  actor.sessionId = 'replacement'; input.answers[0]!.response.literal = 'Changed literal';
  assert.deepEqual(resolvedActor, original);
  assert.throws(() => result.assertCurrent(input), /r1_capture_changed/);
  assert.doesNotThrow(() => result.assertCurrent(capture()));
});

test('draft receiver factory installs no authority default and declines before consulting the resolver', () => {
  const actor = { accountId: 'synthetic-account', authUserId: 'synthetic-auth', sessionId: 'synthetic-session', epoch: 0 };
  const input = capture(); let calls = 0;
  const port = createR1CaptureContentPort(() => { calls++; return null; });
  assert.equal(createR1CaptureContentPort().readForCaptureWithinWrite!(actor, input), null);
  input.consent.decision = 'declined';
  assert.equal(port.readForCaptureWithinWrite!(actor, input), null); assert.equal(calls, 0);
  input.consent.decision = 'granted';
  assert.equal(port.readForCaptureWithinWrite!(actor, input), null); assert.equal(calls, 1);
  const failure = new Error('original actor unavailable');
  const failing = createR1CaptureContentPort(() => { throw failure; });
  assert.throws(() => failing.readForCaptureWithinWrite!(actor, input), error => error === failure);
});

test('finite neurological clarifications retain exact timing, distribution, component and context wording', () => {
  const prompts = [
    'Did the weakness or numbness start suddenly?',
    'Has weakness developed and progressively worsened on both sides over four weeks or less?',
    'Has numbness on both sides been worsening over hours to days, together with weakness or balance difficulty?',
    'Has one-limb or one-sided weakness worsened over hours to days?',
    'Has limb or neck weakness worsened over weeks to months?',
    'Are you having difficulty swallowing?',
    'Are you breathless at rest or while lying flat?',
    'Do you have severe low-back pain spreading into a leg?',
    'Have you developed numbness around your genitals or anus?',
    'Do you have new trouble starting to urinate, inability to urinate, or bladder-control loss that is not normal for you?',
    'Have you newly lost awareness of needing to pass stool, or bowel control, in a way that is not normal for you?',
    'Has your sexual function newly changed?',
  ];
  const questions = r1IntakeDefinition.questions.filter(question => question.id.startsWith('form.r1.N'));
  assert.deepEqual(questions.map(question => question.prompt), prompts);
  assert.ok(questions.every(question => question.kind === 'yes_no' && question.revision === '1'));
  assert.equal(r1IntakeDefinition.revision, '1.1.0');
  const evidence = r1IntakeDefinition.neurologicalClarification;
  assert.equal(evidence.validatedInstrument, false); assert.equal(evidence.clinicalClearance, false);
  assert.equal(evidence.runtimeQualification, 'not_established');
  assert.deepEqual(evidence.sources.map(source => [source.id, source.access]),
    [['A', 'direct'], ['B', 'official_indexed_text_only'], ['C', 'direct']]);
  const nice = evidence.sources.find(source => source.id === 'B')!;
  assert.equal(nice.directHtmlStatus, 403); assert.equal(nice.directPdfStatus, 403);
});

test('positive neurological triggers require only their finite clarification branch and retain unknown or declined answers', () => {
  const neurological = Array.from({ length: 7 }, (_, index) => `N${String(index + 1).padStart(2, '0')}`);
  const spinal = Array.from({ length: 5 }, (_, index) => `N${String(index + 8).padStart(2, '0')}`);
  const baseline = materialized();
  for (const code of [...neurological, ...spinal]) assert.equal(required(baseline, code), false);
  for (const trigger of ['T16', 'T17', 'R03']) {
    const input = capture(); answer(input, trigger, yes());
    const result = materialized(input);
    assert.equal(branch(result, 'neurological_clarification').state, 'required');
    for (const code of neurological) {
      assert.equal(required(result, code), true);
      assert.ok(result.gaps.some(gap => gap.code === 'capture_answer_unknown' && gap.questionId === id(code)));
    }
    for (const code of spinal) assert.equal(required(result, code), false);
  }
  const input = capture(); answer(input, 'T16', unknown());
  assert.equal(branch(materialized(input), 'neurological_clarification').state, 'unresolved');
  answer(input, 'T16', yes());
  answer(input, 'N02', { state: 'unknown', literal: 'Prefer not to say', reason: 'declined' });
  const declined = materialized(input);
  assert.equal(declined.capture.answers.find(entry => entry.questionId === id('N02'))!.response.state, 'unknown');
  assert.ok(declined.gaps.some(gap => gap.code === 'capture_answer_unknown' && gap.questionId === id('N02')));
});

test('compound regional report requires component clarification and never infers urgency or reassurance', () => {
  const input = capture(); answer(input, 'R04', yes());
  let result = materialized(input);
  assert.equal(branch(result, 'spinal_clarification').state, 'required');
  for (let number = 8; number <= 12; number++) assert.equal(required(result, `N${String(number).padStart(2, '0')}`), true);
  assert.equal(required(result, 'N01'), false);
  answer(input, 'N08', no()); answer(input, 'N12', yes());
  result = materialized(input);
  assert.equal(result.predicates.length, 2);
  assert.ok(hasGap(result, 'r1_clinical_classifier_unavailable'));
  assert.ok(result.gaps.some(gap => gap.code === 'capture_answer_unknown' && gap.questionId === id('N09')));
  answer(input, 'R04', unknown());
  assert.equal(branch(materialized(input), 'spinal_clarification').state, 'unresolved');
});

test('missing neurological clarification does not suppress an existing higher-urgency source proposal', () => {
  const input = capture(); answer(input, 'T01', yes()); answer(input, 'T07', yes()); answer(input, 'T16', yes());
  const result = materialized(input);
  assert.equal(result.predicates.find(predicate => predicate.id === 'cdc_rhabdomyolysis_signs')!.state, 'matched');
  assert.ok(result.gaps.some(gap => gap.code === 'capture_answer_unknown' && gap.questionId === id('N01')));
  assert.ok(hasGap(result, 'r1_primary_rule_carrier_unavailable'));
  assert.ok(hasGap(result, 'r1_care_resources_unavailable'));
  const corrected = structuredClone(input); answer(corrected, 'N01', no());
  assert.throws(() => result.assertCurrent(corrected), /r1_capture_changed/);
  assert.notEqual(materialized(corrected).bindingDigest, result.bindingDigest);
});
