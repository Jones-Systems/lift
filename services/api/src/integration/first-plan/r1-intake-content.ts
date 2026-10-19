import { createHash } from 'node:crypto';
import { captureConsentPermissionSchema, captureInventorySchema, type CaptureContent,
  type CaptureContentPort, type DraftCaptureContent } from './confirmed-capture.js';
import type { AccountContext } from '../../lifecycle/types.js';
import { constraintCaptureSchema, inspectConstraintCapture, type ConstraintCapture,
  type QuestionInventory } from '../../planning/constraints/confirmed-capture.js';
import { freeze } from '../../planning/first-plan/normalization.js';

export type R1Branch = 'core' | 'regional' | 'condition' | 'return_to_exercise' | 'leg_followup' |
  'neurological_clarification' | 'spinal_clarification' | 'planning';
export type R1QuestionDefinition = QuestionInventory['questions'][number] & Readonly<{ branch: R1Branch }>;
const question = (code: string, prompt: string, kind: 'yes_no' | 'text' = 'yes_no',
  branch: R1Branch = 'core', required = true): R1QuestionDefinition => ({ id: `form.r1.${code}`, revision: '1', prompt, kind, branch, required });
export const r1IntakeDefinition = freeze({
  id: 'form.r1-intake/v1', revision: '1.1.0', authorship: 'Form-authored; not a validated instrument',
  retainedSource: { formRevision: 'f7ac8aeb2bf3cae5ef3a251d0a796af24207997b', businessLessonsRevision: '7636efca55195b1dc6a5980864452575478116b7',
    path: 'sources/businesslessons/core/research/workout-app-2026-08-20',
    locators: ['synthesis/training-system.md:81-131', 'reviews/luna-audits/disposition-04-training.md:21-61',
      'synthesis/body-region-navigator.md:28-78,168-184,254-268', 'lanes/22-neck-cervical.md:234-267'] },
  originalQuestionCount: 50, additionalFollowupCount: 14, neurologicalFollowupCount: 12,
  neurologicalClarification: {
    schema: 'form.r1-neurological-content-proposal/v1', authorityEffect: 'none', origin: 'Form-authored paraphrase',
    observedGuidance: true, validatedInstrument: false, clinicalClearance: false, runtimeQualification: 'not_established',
    accessedDate: '2026-10-11', accessedTimeZone: 'America/New_York',
    sources: [
      { id: 'A', url: 'https://www.nhs.uk/conditions/stroke/symptoms/', access: 'direct', reviewedDate: '2024-09-12',
        sections: ['symptoms', 'immediate action'] },
      { id: 'B', url: 'https://www.nice.org.uk/guidance/ng127/chapter/recommendations-for-adults-aged-over-16',
        access: 'official_indexed_text_only', publishedDate: '2019-05-01', updatedDate: '2023-10-02',
        directHtmlStatus: 403, directPdfStatus: 403, sections: ['1.7.1', '1.7.2', '1.7.3', '1.7.4', '1.7.5', '1.10.2'] },
      { id: 'C', url: 'https://www.nhs.uk/conditions/sciatica/', access: 'direct', reviewedDate: '2024-12-03',
        sections: ['immediate action'] },
    ],
    interpretationLimits: [
      'Self-report clarification is not a diagnostic examination or validated classifier.',
      'N03 is a narrower Form interpretation of indexed recommendation 1.10.2, not verified diagnostic symmetry.',
      'A compound positive does not establish every component, timing, distribution or context.',
      'No blanket same-day rule for T16/R03, clinical-review rule for T17, or isolated sexual-function urgency is supplied.',
      'A negative N08 does not exclude serious illness; referral wording does not establish ambulance transport.',
      'Established higher urgency must not wait for these clarifications; localized care resources remain independently supplied.',
    ],
  },
  unknownChoices: [{ label: 'Not sure', state: 'unknown', reason: 'unclear' }, { label: 'Prefer not to say', state: 'unknown', reason: 'declined' }],
  consent: { id: 'form.r1.private-account-capture', revision: '1',
    text: 'Allow Form to privately save these answers and instructions in your account, including their revision history, to prepare and explain your training choices. Form will not advertise with, sell, share or reuse this capture for another purpose. You can decline. Confirming your answers does not provide medical clearance.' },
  confirmation: 'These are my answers and the instructions I supplied. Use this exact version for this request.',
  questions: [
    question('T01', 'Are you experiencing muscle cramps, aches or pains that are more severe than expected?'),
    question('T02', 'Has your urine become tea- or cola-coloured?'),
    question('T03', 'Are you experiencing weakness or tiredness that prevents you from completing tasks or a workout you could previously manage?'),
    question('T04', 'Are you experiencing chest pressure, chest discomfort, or unexplained upper-body discomfort during exertion or with your current symptoms?'),
    question('T05', 'Are you experiencing severe breathlessness?'),
    question('T06', 'Have you fainted or collapsed in connection with your current symptoms or exercise?'),
    { ...question('T07', 'Have you suddenly developed facial weakness or drooping, difficulty speaking, limb weakness, one-sided numbness, or blurred or lost vision, including symptoms that have now stopped?'), revision: '2' },
    question('T08', 'Has a limb suddenly become cold, pale or blue, with new numbness, weakness or difficulty moving it?'),
    question('T09', 'Have you had major trauma with deformity or an open injury?'),
    question('T10', 'Are you experiencing sudden severe abdominal, testicular or pelvic pain?'),
    question('T11', 'Are you experiencing confusion or marked deterioration with a severe illness or heat-related episode?'),
    question('T12', 'Do you have new unexplained swelling, pain, warmth or colour change affecting one calf or leg?'),
    question('T13', 'Do you have new unexplained breathlessness that is not severe, or are you coughing up blood?'),
    question('T14', 'Is a joint or foot newly hot, red, markedly swollen or very painful, with or without fever?'),
    question('T15', 'Has an acute injury caused a major loss of your ability to walk, bear weight or use the affected part?'),
    question('T16', 'Do you have new or rapidly worsening weakness, foot or hand drop, or fixed loss of sensation?'),
    question('T17', 'Do you have persistent neurological symptoms or a recurring unexplained decline in function?'),
    question('T18', 'Do you have repeated locking, catching, giving-way or instability?'),
    question('T19', 'Do you have focal pain over a bone that is worsening, affects walking, causes a limp, or occurs at rest or night?'),
    question('T20', 'Have you had a hospitalization, procedure, fracture or acute illness that still affects your exercise choices?'),
    question('T21', 'Do you have a known health condition that affects your exercise choices?'),
    question('T22', 'Do you have a current symptom or body-area concern relevant to this session?'),
    question('T23', 'Can you set up, perform and leave the proposed task in a controlled way, using support if needed?'),
    question('T24', 'Can you control the equipment and environment available for this task?'),
    question('E01', 'What strength, aerobic or balance activity have you done recently, and has there been an interruption?', 'text'),
    question('E02', 'What task do you intend to do, and how demanding do you expect it to be?', 'text'),
    question('L01', 'Which country and region are you in for this session?', 'text'),
    question('L02', 'Which language should Form use for questions and care information?', 'text'),
    question('L03', 'What communication or accessibility support do you need? You can explicitly answer “none.”', 'text'),
    question('L04', 'Would you need help accessing care if the information you report calls for it?'),
    question('C01', 'Do you have current clinician instructions or restrictions that Form should preserve for this session?'),
    question('C02', 'Are there exercises or variants you want excluded from this session?'),
    question('C03', 'Have you included all current instructions, restrictions and exercise exclusions you want Form to apply to this session?'),
    question('P01', 'What goal or everyday task matters most for this session?', 'text', 'planning', false),
    question('P02', 'What equipment and support are actually available for this session?', 'text', 'planning', false),
    question('P03', 'How much time do you have, and what alternatives would you prefer?', 'text', 'planning', false),
    question('R01', 'Which body areas and sides are involved?', 'text', 'regional'),
    question('R02', 'How did this concern start—suddenly, gradually or unclearly—and was there an injury or other event? Include the date only if known.', 'text', 'regional'),
    question('R03', 'Is numbness, tingling or weakness spreading or getting worse?', 'yes_no', 'regional'),
    question('R04', 'Do you have new saddle or genital sensory changes, new bladder, bowel or sexual-function changes, or sudden inability to pass urine?', 'yes_no', 'regional'),
    question('R05', 'Do you have a new weak urinary stream, hesitancy, incomplete emptying or recurrent retention?', 'yes_no', 'regional'),
    question('R06', 'Is movement physically blocked by a fixed lock, rather than stopped because it hurts?', 'yes_no', 'regional'),
    question('R07', 'Are you pregnant or postpartum?', 'yes_no', 'regional'),
    question('R08', 'Is cancer, infection, immune suppression, inflammatory disease, osteoporosis, prior bone-stress injury or another bone-health concern relevant to what you are reporting?', 'yes_no', 'regional'),
    question('R09', 'Are these familiar symptoms that are stable or improving?', 'yes_no', 'regional'),
    question('R10', 'Can you still walk or use the area for ordinary daily activities without a loss of function?', 'yes_no', 'regional'),
    question('R11', 'What task or position brings the concern on, and what happens during it, afterwards and the next day?', 'text', 'regional', false),
    question('R12', 'What would you like to keep doing, and which alternatives would you consider?', 'text', 'regional', false),
    question('H01', 'Is the condition you reported currently stable, according to your understanding or existing care instructions?', 'yes_no', 'condition'),
    question('H02', 'Do you have current return-to-exercise instructions for the hospitalization, procedure, fracture or illness you reported?', 'yes_no', 'return_to_exercise'),
    question('V01', 'Does this concern include pain or swelling in that leg?', 'yes_no', 'leg_followup'),
    question('V02', 'Are you short of breath or having chest pain?', 'yes_no', 'leg_followup'),
    question('N01', 'Did the weakness or numbness start suddenly?', 'yes_no', 'neurological_clarification'),
    question('N02', 'Has weakness developed and progressively worsened on both sides over four weeks or less?', 'yes_no', 'neurological_clarification'),
    question('N03', 'Has numbness on both sides been worsening over hours to days, together with weakness or balance difficulty?', 'yes_no', 'neurological_clarification'),
    question('N04', 'Has one-limb or one-sided weakness worsened over hours to days?', 'yes_no', 'neurological_clarification'),
    question('N05', 'Has limb or neck weakness worsened over weeks to months?', 'yes_no', 'neurological_clarification'),
    question('N06', 'Are you having difficulty swallowing?', 'yes_no', 'neurological_clarification'),
    question('N07', 'Are you breathless at rest or while lying flat?', 'yes_no', 'neurological_clarification'),
    question('N08', 'Do you have severe low-back pain spreading into a leg?', 'yes_no', 'spinal_clarification'),
    question('N09', 'Have you developed numbness around your genitals or anus?', 'yes_no', 'spinal_clarification'),
    question('N10', 'Do you have new trouble starting to urinate, inability to urinate, or bladder-control loss that is not normal for you?', 'yes_no', 'spinal_clarification'),
    question('N11', 'Have you newly lost awareness of needing to pass stool, or bowel control, in a way that is not normal for you?', 'yes_no', 'spinal_clarification'),
    question('N12', 'Has your sexual function newly changed?', 'yes_no', 'spinal_clarification'),
  ],
});

function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  throw new TypeError('Unsupported intake evidence');
}
const digest = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex');
export const r1IntakeContentDigest = digest(r1IntakeDefinition);
export type R1ContentAuthority = Readonly<{
  contentDigest: string;
  source: QuestionInventory['source'];
  permission: CaptureContent['permission'];
  assertCurrent(): void;
  assertPrivateCaptureOnly(): void;
}>;
export type R1ContentGap = Readonly<{ code: string; questionId?: string; factId?: string }>;
export type R1BranchEvidence = Readonly<{
  branch: Exclude<R1Branch, 'core' | 'planning'>;
  state: 'required' | 'not_required' | 'unresolved'; answerIds: readonly string[]; factIds: readonly string[];
}>;
export type R1PredicateProposal = Readonly<{
  id: 'cdc_rhabdomyolysis_signs' | 'nhs_leg_pain_swelling_and_breathlessness_or_chest_pain';
  state: 'matched' | 'not_matched' | 'unresolved' | 'not_applicable';
  questionIds: readonly string[]; action: 'immediate_medical_attention' | 'immediate_action';
  authority: 'primary_carrier_required';
}>;
export type R1Materialization =
  | Readonly<{ status: 'declined'; gaps: readonly R1ContentGap[] }>
  | Readonly<{ status: 'invalid' | 'unavailable'; gaps: readonly R1ContentGap[] }>
  | Readonly<{ status: 'materialized'; capture: ConstraintCapture; content: CaptureContent;
      contentDigest: string; inventoryDigest: string; captureDigest: string; bindingDigest: string;
      branches: readonly R1BranchEvidence[]; predicates: readonly R1PredicateProposal[]; gaps: readonly R1ContentGap[];
      assertCurrent(currentCapture: unknown): void }>;

const qid = (code: string): string => `form.r1.${code}`;
function synchronous(callback: () => void): void {
  const result: unknown = callback();
  if (result !== undefined) throw new Error('r1_synchronous_assertion_required');
}
export function materializeR1Intake(raw: unknown, authority?: R1ContentAuthority): R1Materialization {
  const parsed = constraintCaptureSchema.safeParse(raw);
  if (!parsed.success) return freeze({ status: 'invalid', gaps: [{ code: 'capture_invalid' }] });
  const capture = parsed.data;
  if (capture.consent.decision === 'declined') return freeze({ status: 'declined', gaps: [{ code: 'capture_consent_declined' }] });
  if (capture.consent.statementId !== r1IntakeDefinition.consent.id || capture.consent.statementRevision !== r1IntakeDefinition.consent.revision)
    return freeze({ status: 'unavailable', gaps: [{ code: 'capture_consent_unavailable' }] });
  if (!authority) return freeze({ status: 'unavailable', gaps: [{ code: 'r1_content_authority_unavailable' }] });
  try {
    const assertCurrent = authority.assertCurrent, assertPrivate = authority.assertPrivateCaptureOnly;
    const trust = structuredClone({ contentDigest: authority.contentDigest, source: authority.source, permission: authority.permission });
    const assertTrustUnchanged = (): void => {
      if (authority.assertCurrent !== assertCurrent || authority.assertPrivateCaptureOnly !== assertPrivate ||
        canonical({ contentDigest: authority.contentDigest, source: authority.source, permission: authority.permission }) !== canonical(trust)) throw new Error('r1_content_changed');
    };
    const checkTrust = (): void => {
      assertTrustUnchanged();
      synchronous(() => assertCurrent.call(authority));
      assertTrustUnchanged();
      synchronous(() => assertPrivate.call(authority));
      assertTrustUnchanged();
    };
    checkTrust();
    const permission = captureConsentPermissionSchema.parse(trust.permission);
    if (trust.contentDigest !== r1IntakeContentDigest || trust.source.qualification !== 'qualified' || trust.source.currentness !== 'current' ||
      permission.inventoryId !== r1IntakeDefinition.id || permission.inventoryRevision !== r1IntakeDefinition.revision ||
      permission.statementId !== r1IntakeDefinition.consent.id || permission.statementRevision !== r1IntakeDefinition.consent.revision) throw new Error('r1_content_authority_unavailable');
    const answers = new Map(capture.answers.map(answer => [answer.questionId, answer]));
    const state = (code: string) => answers.get(qid(code))?.response.state;
    const branch = (name: R1BranchEvidence['branch'], code: string): R1BranchEvidence => ({ branch: name,
      state: state(code) === 'yes' ? 'required' : state(code) === 'no' ? 'not_required' : 'unresolved', answerIds: [qid(code)], factIds: [] });
    const regions = capture.facts.filter(fact => fact.kind !== 'user_exclusion');
    const positiveRegions = regions.filter(fact => fact.resolution === 'reported' && fact.region !== 'unknown' && fact.region !== 'none');
    const regional = branch('regional', 'T22');
    const regionalEvidence: R1BranchEvidence = { ...regional,
      state: positiveRegions.length ? 'required' : regions.some(fact => fact.resolution !== 'reported' || fact.region === 'unknown') && regional.state !== 'required' ? 'unresolved' : regional.state,
      factIds: regions.map(fact => fact.id) };
    const clarification = (name: 'neurological_clarification' | 'spinal_clarification', codes: string[]): R1BranchEvidence => {
      const applicable = codes.filter(code => !code.startsWith('R') || regionalEvidence.state !== 'not_required' || answers.has(qid(code)));
      return { branch: name, state: applicable.some(code => state(code) === 'yes') ? 'required' :
        applicable.some(code => state(code) !== 'no') ? 'unresolved' : 'not_required', answerIds: applicable.map(qid), factIds: [] };
    };
    const branches: R1BranchEvidence[] = [regionalEvidence, branch('condition', 'T21'), branch('return_to_exercise', 'T20'), branch('leg_followup', 'T12'),
      clarification('neurological_clarification', ['T16', 'T17', 'R03']), clarification('spinal_clarification', ['R04'])];
    const inventory = captureInventorySchema.parse({ id: r1IntakeDefinition.id, revision: r1IntakeDefinition.revision,
      source: trust.source, consent: r1IntakeDefinition.consent, questions: r1IntakeDefinition.questions.map(({ branch, ...question }) => ({ ...question,
        required: question.required && (branch === 'core' || branches.some(entry => entry.branch === branch && entry.state === 'required')) })) });
    const inspected = inspectConstraintCapture(capture, inventory);
    if (inspected.status === 'invalid') return freeze({ status: 'invalid', gaps: inspected.gaps.map(gap => ({ code: gap.code })) });
    const gaps: R1ContentGap[] = inspected.gaps.map(gap => ({ code: gap.code,
      ...(gap.detail ? gap.code === 'capture_fact_unresolved' ? { factId: gap.detail } : { questionId: gap.detail } : {}) }));
    for (const entry of branches) if (entry.state === 'unresolved') gaps.push({ code: 'r1_branch_trigger_unresolved', questionId: entry.answerIds[0]! });
    const instructions = capture.facts.filter(fact => fact.kind === 'clinician_instruction_as_reported');
    const exclusions = capture.facts.filter(fact => fact.kind === 'user_exclusion');
    for (const [code, facts] of [['C01', instructions], ['C02', exclusions]] as const) {
      if ((state(code) === 'yes' && facts.length === 0) || (state(code) === 'no' && facts.length > 0)) gaps.push({ code: 'r1_instruction_answer_mismatch', questionId: qid(code) });
    }
    if (state('C03') !== 'yes') gaps.push({ code: 'r1_restriction_coverage_unconfirmed', questionId: qid('C03') });
    if (!instructions.length && !exclusions.length && !(state('C01') === 'no' && state('C02') === 'no' && state('C03') === 'yes' && capture.restrictionInventory.response.state === 'no')) gaps.push({ code: 'r1_empty_restriction_inventory_unconfirmed' });
    for (const fact of instructions) gaps.push({ code: 'r1_instruction_mapping_unavailable', factId: fact.id });
    for (const fact of exclusions) gaps.push({ code: 'r1_selected_variant_inventory_unavailable', factId: fact.id });
    if (state('T22') === 'yes' && !positiveRegions.length) gaps.push({ code: 'r1_region_identity_unavailable', questionId: qid('R01') });
    const cdc = ['T01', 'T02', 'T03'].map(state);
    const nhs = state('T12') === 'no' ? 'not_applicable' : state('T12') !== 'yes' ? 'unresolved' :
      !['yes', 'no'].includes(state('V01') ?? '') || !['yes', 'no'].includes(state('V02') ?? '') ? 'unresolved' :
      state('V01') === 'yes' && state('V02') === 'yes' ? 'matched' : 'not_matched';
    const predicates: R1PredicateProposal[] = [
      { id: 'cdc_rhabdomyolysis_signs', state: cdc.includes('yes') ? 'matched' : cdc.every(value => value === 'no') ? 'not_matched' : 'unresolved', questionIds: ['T01', 'T02', 'T03'].map(qid), action: 'immediate_medical_attention', authority: 'primary_carrier_required' },
      { id: 'nhs_leg_pain_swelling_and_breathlessness_or_chest_pain', state: nhs, questionIds: ['T12', 'V01', 'V02'].map(qid), action: 'immediate_action', authority: 'primary_carrier_required' },
    ];
    gaps.push({ code: 'r1_clinical_classifier_unavailable' }, { code: 'r1_primary_rule_carrier_unavailable' }, { code: 'r1_care_resources_unavailable' });
    const content: CaptureContent = { inventory, permission };
    const inventoryDigest = digest(inventory), bindingDigest = digest({ contentDigest: r1IntakeContentDigest, inventoryDigest,
      captureDigest: inspected.digest, confirmation: r1IntakeDefinition.confirmation });
    const original = canonical(capture);
    checkTrust();
    return freeze({ status: 'materialized', capture: inspected.capture, content, contentDigest: r1IntakeContentDigest,
      inventoryDigest, captureDigest: inspected.digest, bindingDigest, branches, predicates, gaps,
      assertCurrent(currentCapture: unknown) {
        checkTrust();
        const current = constraintCaptureSchema.safeParse(currentCapture);
        if (!current.success || canonical(current.data) !== original) throw new Error('r1_capture_changed');
        checkTrust();
      } });
  } catch { return freeze({ status: 'unavailable', gaps: [{ code: 'r1_content_authority_unavailable' }] }); }
}

// The policy owner supplies real currentness and private-purpose authority; this factory supplies neither.
export function createR1CaptureContentPort(resolveAuthority?: (actor: AccountContext) => R1ContentAuthority | null): CaptureContentPort {
  return Object.freeze({
    readForCaptureWithinWrite(actor: AccountContext, capture: ConstraintCapture): DraftCaptureContent | null {
      if (!resolveAuthority || capture.consent.decision !== 'granted') return null;
      const originalActor = freeze({ ...actor });
      const authority = resolveAuthority(originalActor);
      if (!authority) return null;
      const result = materializeR1Intake(capture, authority);
      if (result.status !== 'materialized') return null;
      return freeze({ content: result.content,
        contentBinding: { schema: 'form.r1-capture-binding/v1', contentDigest: result.contentDigest,
          inventoryDigest: result.inventoryDigest, captureDigest: result.captureDigest, bindingDigest: result.bindingDigest },
        assertCurrent(currentCapture: ConstraintCapture) { result.assertCurrent(currentCapture); } });
    },
  });
}
