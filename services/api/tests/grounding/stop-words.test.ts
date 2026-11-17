import test from 'node:test';
import assert from 'node:assert/strict';
import { createGroundingRetriever, type GroundingRequest, type GroundingResult } from '../../src/grounding/index.js';
import { groundingStopWords } from '../../src/grounding/stop-words.js';
import { createCardioConsumer, type CardioJob } from '../../src/domain-features/cardio/index.js';
import { createRecoveryConsumer, type RecoveryJob } from '../../src/domain-features/recovery/index.js';
import { context, observation } from '../domain-features/cardio/fixture.js';
import { syntheticFixture, syntheticRecord } from './fixture.js';

function retrieverFor(records = [syntheticRecord()]) {
  const { projection, binding } = syntheticFixture(records);
  return createGroundingRetriever(projection, binding);
}
const ids = (result: GroundingResult): string[] => result.observations.map(entry => entry.record.id);

// Independent reference for the legacy rule: every query token must occur in the record's text fields.
function legacyIds(records: ReturnType<typeof syntheticRecord>[], query: string): string[] {
  const tokenize = (text: string): string[] => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const terms = tokenize(query);
  return records.filter(record => {
    const text = Object.values(record).flatMap(value => Array.isArray(value) ? value : typeof value === 'string' ? [value] : []).join('\n');
    const available = new Set(tokenize(text));
    return terms.every(term => available.has(term));
  }).map(record => record.id).sort();
}

test('a natural question matches on its content words and echoes the exact question', () => {
  const retriever = retrieverFor();
  const question = '  WHAT is the Running   strength signal, for adults??  ';
  const natural = retriever.retrieve({ query: question });
  const keyword = retriever.retrieve({ query: 'running strength signal adults' });
  assert.equal(natural.status, 'observations');
  assert.equal(natural.query, question);
  assert.deepEqual(natural, { ...keyword, query: question });
});

test('honest gaps: an absent non-filler word still yields a gap and no synonym is applied', () => {
  const retriever = retrieverFor();
  for (const question of ['Does running improve strength?', 'What is the jogging strength signal?', 'How can I build strength?']) {
    const result = retriever.retrieve({ query: question });
    assert.equal(result.status, 'gap', question);
    assert.equal(result.query, question);
    assert.equal(result.totalMatches, 0);
  }
  assert.equal(retriever.retrieve({ query: 'Is the running strength signal for adults?' }).status, 'observations');
});

test('an all-stop-word query keeps the legacy AND rule and is not an invalid request', () => {
  const plain = retrieverFor();
  const result = plain.retrieve({ query: 'What is the' });
  assert.equal(result.status, 'gap');
  assert.equal(result.query, 'What is the');
  const records = [syntheticRecord('SYN-S1', { summary: 'What is the synthetic answer here.' }), syntheticRecord('SYN-S2')];
  const matched = retrieverFor(records).retrieve({ query: 'WHAT is the' });
  assert.equal(matched.status, 'observations');
  assert.deepEqual(ids(matched), ['SYN-S1']);
  assert.throws(() => plain.retrieve({ query: ' ... ' } as GroundingRequest), /query must contain words or numbers/);
});

test('ordering, counts, truncation and the topic and access filters are unchanged', () => {
  const records = [
    syntheticRecord('SYN-S2'), syntheticRecord('SYN-S10', { access_level: 'full' }),
    syntheticRecord('SYN-S1', { access_level: 'full', topic_ids: ['SYN-A2'] }),
  ];
  const retriever = retrieverFor(records);
  const question = 'What is the strength of the signal?';
  const all = retriever.retrieve({ query: question });
  assert.deepEqual(ids(all), ['SYN-S1', 'SYN-S10', 'SYN-S2']);
  assert.equal(all.totalMatches, 3);
  assert.equal(all.truncated, false);
  assert.equal(all.limit, 20);
  const limited = retriever.retrieve({ query: question, limit: 1 });
  assert.deepEqual(ids(limited), ['SYN-S1']);
  assert.equal(limited.totalMatches, 3);
  assert.equal(limited.truncated, true);
  const full = retriever.retrieve({ query: question, access: 'full' });
  assert.deepEqual(ids(full), ['SYN-S1', 'SYN-S10']);
  const topic = retriever.retrieve({ query: question, topic: 'SYN-A1' });
  assert.deepEqual(ids(topic), ['SYN-S10', 'SYN-S2']);
  const both = retriever.retrieve({ query: question, topic: 'SYN-A1', access: 'full', limit: 5 });
  assert.deepEqual(ids(both), ['SYN-S10']);
  assert.deepEqual(both.filters, { topic: 'SYN-A1', access: 'full' });
  assert.equal(retriever.retrieve({ query: question, topic: 'SYN-A106' }).status, 'gap');
});

test('matches are a superset of the legacy matches and identical without mixed stop words', () => {
  const records = [
    syntheticRecord('SYN-S1', { summary: 'Synthetic running strength signal.' }),
    syntheticRecord('SYN-S2', { summary: 'Synthetic cycling the strength signal of adults.' }),
    syntheticRecord('SYN-S3', { summary: 'What is the synthetic answer here.' }),
  ];
  const retriever = retrieverFor(records);
  const queries = ['strength', 'running strength', 'the strength', 'strength of the signal', 'what is the', 'the of', 'is',
    'what is the synthetic answer', 'running strength signal for adults', 'absentword', 'the absentword', 'cycling the strength'];
  const stopOnly = (query: string) => (query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).every(term => groundingStopWords.has(term));
  const noStop = (query: string) => (query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).every(term => !groundingStopWords.has(term));
  for (const query of queries) {
    const now = ids(retriever.retrieve({ query }));
    const before = legacyIds(records, query);
    for (const id of before) assert.ok(now.includes(id), `${query}: ${id}`);
    if (noStop(query) || stopOnly(query)) assert.deepEqual(now, before, query);
  }
  assert.deepEqual(ids(retriever.retrieve({ query: 'the strength' })), ['SYN-S1', 'SYN-S2', 'SYN-S3']);
  assert.deepEqual(legacyIds(records, 'the strength'), ['SYN-S2', 'SYN-S3']);
});

const goldenStopWords = `a an the
what which who whom whose when where why how
am is are was were be been do does did doing have has had having
can could should would will shall may might must
i me my mine myself we us our ours you your yours he him his she her hers it its they them their theirs this that these those
and or but if then than so as of to in on at by for from with about into
much many there here`.split(/\s+/);

test('stop-word list is frozen, lowercase ASCII, exact, and excludes content and negation words', () => {
  assert.ok(Object.isFrozen(groundingStopWords));
  assert.equal(groundingStopWords.size, 87);
  assert.equal(goldenStopWords.length, 87);
  assert.deepEqual([...groundingStopWords], goldenStopWords);
  for (const word of groundingStopWords) assert.match(word, /^[a-z]+$/);
  const denied = ['protein', 'creatine', 'muscle', 'weight', 'heart', 'rate', 'sleep', 'not', 'no', 'without', 'per', 'need', 'take', 'build'];
  for (const word of denied) assert.equal(groundingStopWords.has(word), false, word);
  const mutable = groundingStopWords as Set<string>;
  assert.throws(() => mutable.add('protein'), TypeError);
  assert.throws(() => mutable.delete('the'), TypeError);
  assert.throws(() => mutable.clear(), TypeError);
  assert.equal(groundingStopWords.size, 87);
});

function spy(): { port: { retrieve(request: { query: string }): ReturnType<typeof observation> }; queries: string[] } {
  const queries: string[] = [];
  return { queries, port: { retrieve(request) { queries.push(request.query); return observation(request.query); } } };
}
const product = <T>(...lists: T[][]): T[][] => lists.reduce<T[][]>((rows, list) => rows.flatMap(row => list.map(item => [...row, item])), [[]]);

test('fixed cardio and recovery queries contain no stop word for any job', () => {
  const modalities = ['walking', 'running', 'cycling', 'rowing', 'swimming', 'other', 'unspecified'] as const;
  const cardioJobs: CardioJob[] = [
    ...(['general_adult', 'older_adult', 'unspecified'] as const).map(population => ({ kind: 'activity_guidelines' as const, intent: 'explain' as const, population })),
    ...product<string>([...modalities], ['heart_rate', 'rpe', 'talk_test', 'device_limitations']).map(([modality, method]) =>
      ({ kind: 'intensity', intent: 'explain', method, modality }) as CardioJob),
    ...product<string>([...modalities], [...modalities]).map(([modality, comparison]) =>
      ({ kind: 'modalities', intent: 'explain', modality, comparison }) as CardioJob),
    ...product<string>([...modalities], ['strength_first', 'cardio_first', 'unspecified'],
      ['same_session', 'separate_sessions', 'separate_days', 'unspecified'],
      ['strength', 'hypertrophy', 'endurance', 'power', 'unspecified']).map(([modality, order, spacing, outcome]) =>
      ({ kind: 'concurrent_training', intent: 'explain', modality, order, spacing, outcome }) as CardioJob),
    ...(['expenditure_uncertainty', 'compensation', 'exercise_and_intake'] as const).map(focus => ({ kind: 'energy_balance' as const, intent: 'explain' as const, focus })),
  ];
  const recoveryJobs: RecoveryJob[] = [
    ...(['duration', 'quality', 'training_relationship'] as const).map(focus => ({ kind: 'sleep' as const, intent: 'explain' as const, focus })),
    ...(['general_literacy', 'measurement_limits'] as const).map(focus => ({ kind: 'hydration' as const, intent: 'explain' as const, focus })),
    ...(['soreness', 'fatigue', 'weakness', 'function', 'performance', 'readiness_limitations'] as const).map(construct => ({ kind: 'soreness_readiness' as const, intent: 'explain' as const, construct })),
    ...(['active_recovery', 'massage', 'cold', 'heat', 'stretching', 'unspecified'] as const).map(modality => ({ kind: 'recovery_modalities' as const, intent: 'explain' as const, modality })),
    ...(['recovery_relationship', 'measurement_limits'] as const).map(focus => ({ kind: 'stress' as const, intent: 'explain' as const, focus })),
    ...(['terminology', 'evidence_limits', 'regional_preflight'] as const).map(focus => ({ kind: 'injury_literacy' as const, intent: 'explain' as const, focus })),
    ...(['framework_literacy', 'clinician_plan_limits', 'uncertainty'] as const).map(focus => ({ kind: 'return_framework' as const, intent: 'explain' as const, focus })),
  ];
  const cardio = spy();
  const cardioConsumer = createCardioConsumer(cardio.port);
  for (const job of cardioJobs) cardioConsumer.evaluate(job, context);
  const recovery = spy();
  const recoveryConsumer = createRecoveryConsumer(recovery.port);
  for (const job of recoveryJobs) recoveryConsumer.evaluate(job, context);
  assert.equal(cardio.queries.length, cardioJobs.length);
  assert.equal(recovery.queries.length, recoveryJobs.length);
  assert.equal(cardioJobs.length, 3 + 28 + 49 + 420 + 3);
  for (const query of new Set([...cardio.queries, ...recovery.queries])) {
    const terms = query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
    assert.ok(terms.length > 0, query);
    for (const term of terms) assert.equal(groundingStopWords.has(term), false, `${query}: ${term}`);
  }
});
