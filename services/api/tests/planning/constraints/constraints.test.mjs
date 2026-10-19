import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateConstraints } from '../../../src/planning/constraints/index.ts';
import { source, demand, item, candidate, fact, rule, request, cover, exclusion, reasons, groupedEquipment } from './fixture.mjs';

test('source-bound interacting restrictions compose and retain every item trace', () => {
  const second = rule({ id: 'rule-b', factIds: ['fact-a', 'fact-b'], effect: { kind: 'require_demand',
    test: { key: 'other-demand', region: 'invented-region', side: 'left', unit: 'category', operator: 'equals', value: 'permitted' } } });
  const input = request({ facts: [fact(), fact({ id: 'fact-b' })], rules: [rule(), second], candidates: [
    candidate({ items: [item({ demands: [demand(), demand({ key: 'other-demand', value: 'permitted', unit: 'category' })] })] }),
  ] });
  const result = evaluateConstraints(input);
  assert.equal(result.status, 'eligible');
  assert.equal(result.applied, false);
  assert.deepEqual(result.eligibleCandidateIds, ['candidate-a']);
  assert.deepEqual(result.routing, input.preflight);
  assert.deepEqual(result.candidates[0].rules.map((entry) => entry.outcome), ['matched', 'matched']);
  const trace = result.candidates[0].rules[1];
  assert.deepEqual(trace.facts, [{ id: 'fact-a', revision: 'fixture-1' }, { id: 'fact-b', revision: 'fixture-1' }]);
  assert.deepEqual(trace.source, second.source);
  assert.deepEqual(trace.demandSources, [input.candidates[0].items[0].demands[1].source]);
});

test('QA-05 unresolved regional preflight prevents all alternatives before rule evaluation', () => {
  const input = request();
  input.preflight.regions[0].route = 'unknown';
  input.candidates.push(candidate({ id: 'unaffected-looking', items: [item({ demands: [], equipment: [], contexts: 'any' })] }));
  const result = evaluateConstraints(input);
  assert.equal(result.status, 'unavailable');
  assert.deepEqual(result.eligibleCandidateIds, []);
  for (const decision of result.candidates) {
    assert.equal(decision.status, 'unknown');
    assert.deepEqual(decision.rules, []);
    assert.equal(decision.comparison, null);
  }
  assert(reasons(result).includes('regional_route_blocks'));
});

test('higher R1 routes, incomplete preflight and missing regional coverage never become fitness clearance', () => {
  for (const state of ['urgent', 'same_day', 'clinical_review', 'safety_unknown']) {
    const input = request(); input.preflight.trainingState = state;
    const result = evaluateConstraints(input);
    assert.equal(result.status, 'unavailable', state);
    assert.equal(result.routing.trainingState, state);
  }
  for (const route of ['emergency', 'urgent_assessment', 'unknown']) {
    const input = request(); input.preflight.regions[0].route = route;
    assert.equal(evaluateConstraints(input).status, 'unavailable', route);
  }
  const incomplete = request(); incomplete.preflight.complete = false;
  assert(reasons(evaluateConstraints(incomplete)).includes('preflight_unavailable'));
  const absent = request(); absent.preflight.regions = [];
  assert(reasons(evaluateConstraints(absent)).includes('regional_preflight_missing'));
});

test('correction, deletion, withdrawal and revision changes invalidate dependent evaluations', () => {
  for (const key of ['context', 'catalog', 'rules', 'preflight']) {
    const input = request(); input.current[key] = 'new-version';
    const result = evaluateConstraints(input);
    assert.equal(result.status, 'unavailable', key);
    assert(reasons(result).includes('stale_binding'));
  }
  for (const state of ['unknown', 'superseded', 'withdrawn']) {
    for (const target of ['fact', 'rule', 'preflight']) {
      const input = request();
      const ref = target === 'fact' ? input.facts[0].source : target === 'rule' ? input.rules[0].source : input.preflight.source;
      ref.currentness = state;
      assert.equal(evaluateConstraints(input).status, 'unavailable', `${target}:${state}`);
    }
  }
  const missing = request({ facts: [] });
  assert(reasons(evaluateConstraints(missing)).includes('required_fact_unknown'));
  for (const resolution of ['unknown', 'declined', 'conflicting']) {
    assert.equal(evaluateConstraints(request({ facts: [fact({ resolution })] })).status, 'unavailable');
  }
});

test('left and right stay separate; bilateral restrictions require both sides, and mirroring preserves outcomes', () => {
  const wrong = request({ candidates: [candidate({ items: [item({ demands: [demand({ side: 'right' })] })] })] });
  assert.equal(evaluateConstraints(wrong).candidates[0].status, 'unknown');
  const mirrored = request();
  mirrored.facts[0].side = 'right'; mirrored.preflight.regions[0].side = 'right';
  mirrored.rules[0].effect.test.side = 'right'; mirrored.candidates[0].items[0].demands[0].side = 'right';
  assert.equal(evaluateConstraints(mirrored).status, evaluateConstraints(request()).status);
  const bilateral = request(); bilateral.rules[0].effect.test.side = 'bilateral';
  assert.equal(evaluateConstraints(bilateral).candidates[0].status, 'unknown');
  bilateral.candidates[0].items[0].demands.push(demand({ side: 'right', value: 4 }));
  assert.equal(evaluateConstraints(bilateral).candidates[0].status, 'excluded');
  bilateral.candidates[0].items[0].demands = [demand({ side: 'bilateral' })];
  assert.equal(evaluateConstraints(bilateral).candidates[0].status, 'eligible');
});

test('demand missingness, ambiguous cells, incompatible units and unsourced estimates stay unknown', () => {
  const cases = [[], [demand({ value: null })], [demand(), demand()], [demand({ unit: 'different' })],
    [demand({ value: '2' })], [demand({ side: 'unknown' })],
    [demand({ source: source('hypothesis', { qualification: 'hypothesis' }) })],
    [demand({ source: source('withdrawn', { currentness: 'withdrawn' }) })]];
  for (const demands of cases) {
    const result = evaluateConstraints(request({ candidates: [candidate({ items: [item({ demands })] })] }));
    assert.equal(result.status, 'unavailable');
    assert.equal(result.candidates[0].rules[0].outcome, 'unknown');
    assert(reasons(result).includes('demand_unknown'));
  }
});

test('injected scalar predicates preserve inclusive numeric boundaries and explicit false or zero', () => {
  for (const [operator, limit, value, expected] of [
    ['at_most', 2, 2, 'eligible'], ['at_most', 2, 3, 'excluded'],
    ['at_least', 2, 2, 'eligible'], ['at_least', 2, 1, 'excluded'],
    ['equals', 0, 0, 'eligible'], ['equals', false, false, 'eligible'],
    ['equals', false, true, 'excluded'],
  ]) {
    const input = request(); input.rules[0].effect.test.operator = operator;
    input.rules[0].effect.test.value = limit; input.candidates[0].items[0].demands[0].value = value;
    assert.equal(evaluateConstraints(input).candidates[0].status, expected);
  }
});

test('all hard restrictions are traced even when an earlier restriction already excludes the candidate', () => {
  const input = request({ rules: [exclusion(), rule({ id: 'still-evaluate' })], candidates: [
    candidate({ items: [item({ demands: [demand({ value: 10 })] }), item({ id: 'slot-b', demands: [] })] }),
  ] });
  const result = evaluateConstraints(input);
  assert.equal(result.status, 'infeasible');
  assert.equal(result.candidates[0].rules.length, 4);
  assert.deepEqual(result.candidates[0].rules.map((trace) => trace.outcome), ['unmatched', 'unmatched', 'unmatched', 'unknown']);
  assert(reasons(result).includes('demand_unknown'));
});

test('explicit user and reported clinician instructions remain hard restrictions with original provenance', () => {
  for (const [origin, kind] of [['user_exclusion', 'user_exclusion'], ['clinician_instruction', 'clinician_instruction_as_reported']]) {
    const input = request({ facts: [fact({ kind })], rules: [exclusion({ origin,
      source: source('reported-original-wording', { qualification: 'accepted_instruction' }) })] });
    const result = evaluateConstraints(input);
    assert.equal(result.status, 'infeasible');
    assert.equal(result.candidates[0].rules[0].source.locator, 'synthetic-fixture:only');
    input.facts[0].kind = 'user_reported_history';
    assert(reasons(evaluateConstraints(input)).includes('instruction_origin_mismatch'));
  }
});

test('adding exclusions and tightening accepted demand predicates cannot enlarge the eligible set', () => {
  const input = request({ candidates: [1, 2, 3, 4].map((value) => candidate({ id: `candidate-${value}`,
    items: [item({ variantId: `variant-${value}`, demands: [demand({ value })] })] })) });
  const initial = evaluateConstraints(input).eligibleCandidateIds;
  assert.equal(initial.length, 3);
  for (let mask = 0; mask < 16; mask++) {
    const excluded = [1, 2, 3, 4].filter((value) => mask & (1 << (value - 1))).map((value) => `variant-${value}`);
    const result = evaluateConstraints(cover({ ...input, rules: excluded.length ? [...input.rules, exclusion({ variantIds: excluded })] : input.rules }));
    assert(result.eligibleCandidateIds.every((id) => initial.includes(id)));
    assert.deepEqual(result.eligibleCandidateIds, initial.filter((id) => !excluded.includes(id.replace('candidate', 'variant'))));
  }
  let previous = initial;
  for (const value of [2, 1, 0]) {
    const tighter = structuredClone(input); tighter.rules[0].effect.test.value = value;
    const ids = evaluateConstraints(tighter).eligibleCandidateIds;
    assert(ids.every((id) => previous.includes(id))); previous = ids;
  }
  assert.deepEqual(previous, []);
});

test('QA-13/22 time, equipment and context adaptation evaluates complete supplied alternatives', () => {
  const input = request({ candidates: [
    candidate({ id: 'too-long', minutes: 31 }),
    candidate({ id: 'missing-equipment', items: [item({ equipment: ['unavailable'] })] }),
    candidate({ id: 'wrong-context', items: [item({ contexts: ['elsewhere'] })] }),
    candidate({ id: 'fits', minutes: 15, items: [item({ equipment: [], contexts: 'any' })] }),
  ] });
  const result = evaluateConstraints(input);
  assert.deepEqual(result.eligibleCandidateIds, ['fits']);
  assert.deepEqual(result.candidates.slice(0, 3).map((entry) => entry.reasons[0].code),
    ['time_exceeded', 'equipment_missing', 'context_mismatch']);
  assert.equal(result.candidates[3].comparison.minutes, 15);
});

test('zero time and known empty equipment differ from unknown budgets and requirements', () => {
  const zero = request(); zero.limits.maxMinutes = 0;
  assert.equal(evaluateConstraints(zero).status, 'infeasible');
  for (const field of ['maxMinutes', 'equipment', 'context']) {
    const input = request(); input.limits[field] = null;
    assert.equal(evaluateConstraints(input).status, 'unavailable', field);
  }
  const bodyweight = request(); bodyweight.limits.equipment = []; bodyweight.candidates[0].items[0].equipment = [];
  assert.equal(evaluateConstraints(bodyweight).status, 'eligible');
  const empty = request(); empty.limits.equipment = [];
  assert.equal(evaluateConstraints(empty).status, 'infeasible');
  for (const field of ['equipment', 'contexts']) {
    const input = request(); input.candidates[0].items[0][field] = null;
    assert.equal(evaluateConstraints(input).status, 'unavailable');
  }
  const noDuration = request(); noDuration.candidates[0].minutes = null;
  assert.equal(evaluateConstraints(noDuration).status, 'unavailable');
  noDuration.limits.maxMinutes = 'unrestricted';
  assert.equal(evaluateConstraints(noDuration).status, 'eligible');
});

test('locks preserve item, variant and exact prescription and cannot override accepted exclusions', () => {
  const input = request({ locks: [{ itemId: 'slot-a', variantId: 'invented-variant-a', prescriptionKey: 'invented-dose-a' }] });
  assert.equal(evaluateConstraints(input).status, 'eligible');
  for (const change of [{ id: 'new-slot' }, { variantId: 'other' }, { prescriptionKey: 'other-dose' }]) {
    const changed = { ...input, candidates: [candidate({ items: [item(change)] })] };
    assert(reasons(evaluateConstraints(changed)).includes('lock_conflict'));
  }
  input.rules.push(exclusion());
  const conflict = evaluateConstraints(cover(input));
  assert.equal(conflict.status, 'infeasible');
  assert(reasons(conflict).includes('explicit_exclusion'));
});

test('purpose tradeoffs, changes and soft preferences are visible and cannot override hard limits', () => {
  const input = request({ baseline: candidate({ minutes: 30, items: [item({ purposes: ['invented-purpose-a', 'lost-purpose'] }), item({ id: 'removed' })] }),
    purposes: { required: ['invented-purpose-a'], preferred: ['lost-purpose'] },
    preferences: [{ id: 'favorite', kind: 'favorite', variantIds: ['invented-variant-a'] },
      { id: 'progression', kind: 'progression', variantIds: ['preferred-but-excluded'] }],
    candidates: [candidate({ items: [item({ prescriptionKey: 'changed', purposes: ['invented-purpose-a', 'new-purpose'] })] }),
      candidate({ id: 'bad-preferred', minutes: 40, items: [item({ variantId: 'preferred-but-excluded' })] })],
  });
  const result = evaluateConstraints(input);
  assert.deepEqual(result.eligibleCandidateIds, ['candidate-a']);
  const comparison = result.candidates[0].comparison;
  assert.equal(comparison.minutesDelta, -10);
  assert.deepEqual(comparison.preservedPurposes, ['invented-purpose-a']);
  assert.deepEqual(comparison.lostPurposes, ['lost-purpose']);
  assert.deepEqual(comparison.addedPurposes, ['new-purpose']);
  assert.deepEqual(comparison.missingPreferredPurposes, ['lost-purpose']);
  assert.deepEqual(comparison.changedItemIds, ['slot-a']);
  assert.deepEqual(comparison.removedItemIds, ['removed']);
  assert.equal(result.candidates[1].comparison.preferences[1].satisfied, true);
  assert.equal(result.candidates[1].status, 'excluded');
  const missingPurpose = request({ candidates: [candidate({ items: [item({ purposes: [] })] })] });
  assert(reasons(evaluateConstraints(missingPurpose)).includes('required_purpose_missing'));
});

test('empty or infeasible sets retain restrictions; unknown alternatives do not become an infeasibility claim', () => {
  const noCandidates = request({ candidates: [], rules: [exclusion()] });
  assert.equal(evaluateConstraints(noCandidates).status, 'infeasible');
  assert(reasons(evaluateConstraints(noCandidates)).includes('no_candidates'));
  assert.equal(noCandidates.rules.length, 1);
  const noItems = request({ candidates: [candidate({ items: [] })] });
  assert(reasons(evaluateConstraints(noItems)).includes('empty_plan'));
  const mixed = request({ candidates: [candidate({ id: 'excluded', minutes: 50 }),
    candidate({ id: 'unknown', source: source('not-reviewed', { qualification: 'unreviewed' }) })] });
  const result = evaluateConstraints(mixed);
  assert.equal(result.status, 'unavailable');
  assert.deepEqual(result.candidates.map((entry) => entry.status), ['excluded', 'unknown']);
});

test('hypotheses, creator assertions and co-occurrence do not establish operational rules or diagnosis', () => {
  const input = request({ facts: [fact(), fact({ id: 'co-occurring-report' })] });
  const ordinary = evaluateConstraints(input);
  assert.deepEqual(ordinary.eligibleCandidateIds, evaluateConstraints(request()).eligibleCandidateIds);
  for (const qualification of ['hypothesis', 'creator_assertion', 'unreviewed']) {
    const unsupported = request({ rules: [rule({ source: source('unsupported', { qualification }) })] });
    const result = evaluateConstraints(unsupported);
    assert.equal(result.status, 'unavailable');
    assert(reasons(result).includes('rule_not_qualified_current'));
    assert.deepEqual(result.candidates[0].rules, []);
  }
  const metadata = { ...input, anthropometry: { ratio: 123 }, causalHypotheses: ['invented unsupported cause'] };
  assert.deepEqual(evaluateConstraints(metadata), ordinary);
  assert(!JSON.stringify(ordinary).includes('diagnosis'));
});

test('missing rule inventory or individual instruction coverage holds evaluation before filtering', () => {
  const omitted = request(); omitted.rules = [];
  assert(reasons(evaluateConstraints(omitted)).includes('restriction_coverage_incomplete'));
  const incomplete = request(); incomplete.preflight.restrictionCoverage.complete = false;
  assert.equal(evaluateConstraints(incomplete).status, 'unavailable');
  const instruction = request({ facts: [fact({ kind: 'user_exclusion' })], rules: [exclusion({
    origin: 'user_exclusion', source: source('accepted', { qualification: 'accepted_instruction' }),
  })] });
  instruction.preflight.restrictionCoverage.instructions = [];
  assert(reasons(evaluateConstraints(instruction)).includes('instruction_coverage_missing'));
  instruction.preflight.restrictionCoverage.instructions = [{ factId: 'fact-a', disposition: 'explicit_no_limits', ruleIds: [] }];
  assert.equal(evaluateConstraints(instruction).status, 'unavailable');
});

test('clinician routing needs current reported guidance and explicit accepted limitation disposition', () => {
  for (const state of ['training', 'region']) {
    const input = request();
    if (state === 'training') input.preflight.trainingState = 'clinician_plan';
    else input.preflight.regions[0].route = 'clinician_routed';
    assert(reasons(evaluateConstraints(input)).includes('clinician_instructions_missing'));
    input.facts.push(fact({ id: 'guidance', kind: 'clinician_instruction_as_reported' }));
    input.preflight.restrictionCoverage.instructions = [{ factId: 'guidance', disposition: 'explicit_no_limits', ruleIds: [] }];
    assert.equal(evaluateConstraints(input).status, 'eligible');
    if (state === 'region') {
      input.facts[1].side = 'right';
      input.preflight.regions.push({ region: 'invented-region', side: 'right', route: 'screened_self_management' });
      assert(reasons(evaluateConstraints(input)).includes('clinician_instructions_missing'));
      input.facts[1].side = 'left';
    }
    input.facts[1].source.currentness = 'superseded';
    assert.equal(evaluateConstraints(input).status, 'unavailable');
  }
});

test('candidate order is stable and the evaluator neither mutates nor shares result references with input', () => {
  const input = request({ candidates: [candidate({ id: 'first' }), candidate({ id: 'favorite', items: [item({ variantId: 'favorite' })] })],
    preferences: [{ id: 'favorite', kind: 'favorite', variantIds: ['favorite'] }] });
  const original = structuredClone(input);
  const result = evaluateConstraints(input);
  assert.deepEqual(result.eligibleCandidateIds, ['first', 'favorite']);
  assert.deepEqual(input, original);
  assert.deepEqual(evaluateConstraints(input), result);
  result.routing.source.id = 'mutated-output';
  result.binding.context = 'mutated-output';
  result.candidates[0].rules[0].source.id = 'mutated-output';
  assert.deepEqual(input, original);
});

test('ambiguous identities, nonfinite values and invalid predicates reject malformed typed-port inputs', () => {
  const invalid = [
    () => request({ candidates: [candidate(), candidate()] }),
    () => request({ rules: [rule(), rule()] }),
    () => request({ candidates: [candidate({ items: [item(), item()] })] }),
    () => request({ candidates: [candidate({ minutes: NaN })] }),
    () => request({ candidates: [candidate({ items: [item({ demands: [demand({ value: Infinity })] })] })] }),
    () => request({ rules: [rule({ variantIds: [] })] }),
    () => { const input = request(); input.rules[0].effect.test.value = 'not-numeric'; return input; },
    () => { const input = request(); input.preflight.trainingState = 'invented-route'; return input; },
  ];
  for (const factory of invalid) assert.throws(() => evaluateConstraints(factory()), TypeError);
});

function groupedRequest() {
  const equipment = groupedEquipment();
  return request({ candidates: [candidate({ items: [item({ equipment, variantId: equipment.native.variantId })] })],
    limits: { maxMinutes: 30, equipment: ['invented-required', 'invented-first-b', 'invented-second-a'], context: 'invented-context' } });
}

test('grouped requirements require every AND token and one literal member from every OR group', () => {
  const input = groupedRequest(), before = structuredClone(input);
  const matched = evaluateConstraints(input);
  assert.equal(matched.status, 'eligible');
  const trace = matched.candidates[0].equipmentTrace[0];
  assert.equal(trace.outcome, 'matched');
  assert.deepEqual(trace.alternativeGroups.map(group => group.availableMembers), [['invented-first-b'], ['invented-second-a']]);
  for (const available of [[], ['invented-required'], ['invented-first-a', 'invented-second-b'],
    ['invented-required', 'invented-first-a'], ['invented-required', 'Invented-first-a', 'invented-second-a']]) {
    input.limits.equipment = available;
    const result = evaluateConstraints(input);
    assert.equal(result.status, 'infeasible'); assert(reasons(result).includes('equipment_missing'));
    assert.equal(result.candidates[0].equipmentTrace[0].outcome, 'missing');
  }
  input.limits.equipment = ['invented-required', 'invented-first-a', 'invented-first-b', 'invented-second-a', 'invented-second-b'];
  assert.deepEqual(evaluateConstraints(input).candidates[0].equipmentTrace[0].alternativeGroups.map(group => group.availableMembers),
    [['invented-first-a', 'invented-first-b'], ['invented-second-a', 'invented-second-b']]);
  assert.deepEqual(matched.candidates[0].equipmentTrace[0].requirements, before.candidates[0].items[0].equipment);
});

test('unavailable grouped metadata, independent acceptance and availability stay unknown while hard exclusions survive', () => {
  for (const mutate of [
    input => { input.limits.equipment = null; },
    input => { input.candidates[0].items[0].equipment.operationalSource = null; },
    ...['unknown', 'superseded', 'withdrawn'].map(state => input => { input.candidates[0].items[0].equipment.operationalSource.currentness = state; }),
    ...['unreviewed', 'hypothesis', 'creator_assertion', 'accepted_instruction'].map(qualification => input => {
      input.candidates[0].items[0].equipment.operationalSource.qualification = qualification;
    }),
    ...['id', 'revision', 'locator'].map(field => input => { input.candidates[0].items[0].equipment.operationalSource[field] += '-other'; }),
    input => { input.candidates[0].items[0].variantId = 'other'; },
  ]) {
    const input = groupedRequest(); mutate(input);
    assert.equal(evaluateConstraints(input).candidates[0].status, 'unknown');
    assert.equal(evaluateConstraints(input).candidates[0].equipmentTrace[0].outcome, 'unknown');
    input.rules = [exclusion({ variantIds: 'all' })];
    const excluded = evaluateConstraints(cover(input));
    assert.equal(excluded.candidates[0].status, 'excluded');
    assert(reasons(excluded).includes('equipment_unknown'));
  }
  const empty = groupedRequest(); empty.candidates[0].items[0].equipment.required = [];
  empty.candidates[0].items[0].equipment.alternatives = []; empty.limits.equipment = [];
  assert.equal(evaluateConstraints(empty).status, 'eligible');
  empty.candidates[0].items[0].equipment.operationalSource = null;
  assert.equal(evaluateConstraints(empty).status, 'unavailable');
});

test('grouped preflight holds are not evaluated and every other hard boundary remains effective', () => {
  for (const mutate of [input => { input.preflight.complete = false; }, input => { input.preflight.trainingState = 'urgent'; },
    input => { input.current.rules = 'newer'; }, input => { input.preflight.restrictionCoverage.complete = false; }]) {
    const input = groupedRequest(); mutate(input); const result = evaluateConstraints(input);
    assert.equal(result.status, 'unavailable'); assert.equal(result.candidates[0].equipmentTrace[0].outcome, 'not_evaluated');
    assert.deepEqual(result.candidates[0].rules, []); assert.equal(result.candidates[0].comparison, null);
  }
  for (const [mutate, expected] of [
    [input => { input.candidates[0].items[0].demands[0].value = 4; }, 'demand_mismatch'],
    [input => { input.candidates[0].items[0].demands = []; }, 'demand_unknown'],
    [input => { input.purposes.required.push('missing-purpose'); }, 'required_purpose_missing'],
    [input => { input.locks = [{ itemId: 'slot-a', variantId: 'other', prescriptionKey: 'invented-dose-a' }]; }, 'lock_conflict'],
    [input => { input.limits.maxMinutes = 1; }, 'time_exceeded'],
    [input => { input.candidates[0].items[0].contexts = ['other']; }, 'context_mismatch'],
  ]) {
    const input = groupedRequest(); mutate(input); assert(reasons(evaluateConstraints(input)).includes(expected));
  }
  const legacy = evaluateConstraints(request()); assert.equal(Object.hasOwn(legacy.candidates[0], 'equipmentTrace'), false);
});

test('closed grouped input rejects malformed fields, accessors, cycles, sparse lists and overlaps without reading getters', () => {
  const malformed = [
    equipment => { equipment.extra = true; }, equipment => { equipment.schema = 'other'; },
    equipment => { equipment.required.push(equipment.required[0]); }, equipment => { equipment.required = new Array(2); },
    equipment => { equipment.alternatives = new Array(2); },
    equipment => { equipment.alternatives.push([...equipment.alternatives[0]].reverse()); },
    equipment => { equipment.alternatives[1][0] = equipment.alternatives[0][0]; },
    equipment => { equipment.alternatives[0][0] = equipment.required[0]; },
    equipment => { equipment.alternatives[0] = ['single']; }, equipment => { equipment.alternatives[0].push(equipment.alternatives[0]); },
    equipment => { equipment.native.identity.sha256 = 'bad'; }, equipment => { equipment.native.variantId = 'alias'; },
    equipment => { equipment.native.identity[Symbol('extra')] = true; },
    equipment => { equipment.native.qualification = 'qualified'; }, equipment => { equipment.operationalSource.extra = true; },
    equipment => { Object.setPrototypeOf(equipment, { inherited: true }); },
  ];
  for (const mutate of malformed) {
    const input = groupedRequest(); mutate(input.candidates[0].items[0].equipment);
    assert.throws(() => evaluateConstraints(input), TypeError);
  }
  let reads = 0;
  for (const target of ['equipment', 'required', 'member', 'native', 'identity', 'source']) {
    const input = groupedRequest(), item = input.candidates[0].items[0], equipment = item.equipment;
    const [object, key] = target === 'equipment' ? [item, 'equipment'] : target === 'required' ? [equipment, 'required'] :
      target === 'member' ? [equipment.alternatives[0], '0'] : target === 'native' ? [equipment, 'native'] :
        target === 'identity' ? [equipment.native.identity, 'revision'] : [equipment.operationalSource, 'id'];
    Object.defineProperty(object, key, { enumerable: true, get() { reads++; throw new Error('must not read'); } });
    assert.throws(() => evaluateConstraints(input), TypeError);
  }
  assert.equal(reads, 0);
  const availability = groupedRequest();
  Object.defineProperty(availability.limits.equipment, '0', { enumerable: true, get() { reads++; return 'invented-required'; } });
  assert.throws(() => evaluateConstraints(availability), TypeError); assert.equal(reads, 0);
  availability.limits.equipment = new Array(1); assert.throws(() => evaluateConstraints(availability), TypeError);
});

test('grouped snapshots detach all caller-owned values without freezing inputs and revocation affects a new evaluation', () => {
  const input = groupedRequest(), before = structuredClone(input), result = evaluateConstraints(input);
  assert.deepEqual(input, before); assert.equal(Object.isFrozen(input.candidates[0].items[0].equipment), false);
  input.candidates[0].items[0].equipment.required.push('changed');
  input.candidates[0].items[0].equipment.operationalSource.currentness = 'withdrawn';
  input.limits.equipment.push('changed');
  assert.deepEqual(result.candidates[0].equipmentTrace[0].requirements, before.candidates[0].items[0].equipment);
  assert.deepEqual(result.candidates[0].equipmentTrace[0].availability, before.limits.equipment);
  assert.equal(evaluateConstraints(input).candidates[0].equipmentTrace[0].outcome, 'unknown');
  result.candidates[0].equipmentTrace[0].requirements.required.push('output-change');
  assert(!input.candidates[0].items[0].equipment.required.includes('output-change'));
});
