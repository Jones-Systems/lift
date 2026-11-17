import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { captureNutritionQueryPolicy, resolveNutritionQuery,
  type NutritionQueryPolicySelection } from '../../../src/domain-features/nutrition/job-query-policy.js';

// Artificial navigation tokens only; this is no production query or natural-question corpus.
const rows = [
  ['energy-uncertainty', 'NUT-I1', 'syntheticnavalpha'],
  ['deficit-surplus-rate', 'NUT-I2', 'syntheticnavbravo'],
  ['protein', 'NUT-I3', 'syntheticnavcharlie'],
  ['nutrients-dietary-patterns', 'NUT-I4', 'syntheticnavdelta'],
  ['logging-accuracy', 'NUT-I5', 'syntheticnavecho'],
  ['supplements', 'NUT-I6', 'syntheticnavfoxtrot'],
  ['nutrition-boundaries', 'NUT-I7', 'syntheticnavgolf'],
] as const;
function injection() {
  return { mode: 'form.nutrition-job-query/v1' as const,
    mapping: { version: 'synthetic-map-1', queries: {
      'energy-uncertainty': 'syntheticnavalpha', 'deficit-surplus-rate': 'syntheticnavbravo',
      protein: 'syntheticnavcharlie', 'nutrients-dietary-patterns': 'syntheticnavdelta',
      'logging-accuracy': 'syntheticnavecho', supplements: 'syntheticnavfoxtrot',
      'nutrition-boundaries': 'syntheticnavgolf',
    } },
    corpus: { repository: 'synthetic/query-tests', revision: 'a'.repeat(40),
      corpusRoot: 'synthetic/corpus', corpusInputSha256: 'b'.repeat(64) } };
}
const asSelection = (value: unknown) => value as NutritionQueryPolicySelection;

test('omitted and explicit raw modes preserve every verbatim question and all seven exact topic filters', () => {
  for (const [job, topic] of rows) {
    for (const question of ['  MiXeD café 42  ', '!!!', 'form.nutrition-job-query/v1 syntheticnavcharlie']) {
      for (const policy of [undefined, { mode: 'form.nutrition-raw-question/v1' } as const]) {
        assert.deepEqual(resolveNutritionQuery(policy, job, question), { query: question, topic });
      }
    }
  }
});

test('the complete injected map selects fixed synthetic queries for all seven jobs independently of prose', () => {
  const policy = captureNutritionQueryPolicy(injection());
  for (const [job, topic, query] of rows) {
    for (const question of ['First synthetic detail?', 'Different timing or dose detail?']) {
      assert.deepEqual(resolveNutritionQuery(policy, job, question), { query, topic });
    }
  }
});

test('capture owns immutable mapping and corpus bytes and a canonical versioned SHA256 digest', () => {
  const input = injection();
  const policy = captureNutritionQueryPolicy(input);
  assert.equal(policy.mode, 'form.nutrition-job-query/v1');
  if (policy.mode !== 'form.nutrition-job-query/v1') assert.fail('expected opt-in policy');
  const expectedDigest = createHash('sha256').update(JSON.stringify([
    'form.nutrition-job-query/v1', 'synthetic-map-1', rows.map(([job, , query]) => [job, query]),
  ])).digest('hex');
  assert.equal(policy.mappingDigest, expectedDigest);
  input.mapping.queries.protein = 'caller mutation';
  input.mapping.version = 'changed-version';
  input.corpus.revision = 'c'.repeat(40);
  assert.equal(resolveNutritionQuery(policy, 'protein', 'question').query, 'syntheticnavcharlie');
  assert.equal(policy.mapping.version, 'synthetic-map-1');
  assert.equal(policy.corpus.revision, 'a'.repeat(40));
  for (const value of [policy, policy.mapping, policy.mapping.queries, policy.corpus]) assert.equal(Object.isFrozen(value), true);
  assert.throws(() => { (policy.mapping.queries as { protein: string }).protein = 'overwrite'; }, TypeError);
  assert.equal(captureNutritionQueryPolicy(policy), policy);
  const reordered = injection();
  reordered.mapping.queries = Object.fromEntries(Object.entries(reordered.mapping.queries).reverse()) as typeof reordered.mapping.queries;
  const equivalent = captureNutritionQueryPolicy(reordered);
  assert.equal(equivalent.mode === 'form.nutrition-job-query/v1' && equivalent.mappingDigest, expectedDigest);
  const changed = injection();
  changed.mapping.version = 'synthetic-map-2';
  const changedVersion = captureNutritionQueryPolicy(changed);
  assert.notEqual(changedVersion.mode === 'form.nutrition-job-query/v1' && changedVersion.mappingDigest, expectedDigest);
  const changedQuery = injection();
  changedQuery.mapping.queries.protein = 'syntheticreplacement';
  const replacement = captureNutritionQueryPolicy(changedQuery);
  assert.notEqual(replacement.mode === 'form.nutrition-job-query/v1' && replacement.mappingDigest, expectedDigest);
});

test('unknown or unavailable mode versions and malformed selections never default to raw', () => {
  const invalid: unknown[] = [null, false, '', [], {}, { mode: undefined },
    { mode: 'form.nutrition-job-query/v2' }, { mode: 'form.nutrition-raw-question/v2' },
    { mode: 'unknown' }, { mode: 'form.nutrition-job-query/v1' },
    { mode: 'form.nutrition-raw-question/v1', mapping: injection().mapping },
    Object.defineProperty({}, 'mode', { get() { assert.fail('accessor must not execute'); } })];
  for (const value of invalid) assert.throws(() => captureNutritionQueryPolicy(asSelection(value)), TypeError);
});

test('missing extra empty nonstring accessor symbol and invalid query-map entries fail at capture', () => {
  const valid = injection();
  const { protein: omitted, ...missing } = valid.mapping.queries;
  assert.ok(omitted);
  const maps: unknown[] = [missing, { ...valid.mapping.queries, extra: 'syntheticextra' },
    ...['', '   ', '!!!', '\uD800', 42, null, undefined].map(protein => ({ ...valid.mapping.queries, protein })),
    Object.defineProperty({ ...valid.mapping.queries }, 'protein', {
      enumerable: true, get() { assert.fail('query accessor must not execute'); },
    }), { ...valid.mapping.queries, [Symbol('extra')]: 'syntheticextra' }, []];
  for (const queries of maps) assert.throws(() => captureNutritionQueryPolicy(asSelection({
    ...valid, mapping: { ...valid.mapping, queries },
  })), TypeError);
  for (const version of ['', '  ', null, 2, '\uD800']) {
    assert.throws(() => captureNutritionQueryPolicy(asSelection({ ...valid,
      mapping: { ...valid.mapping, version } })), TypeError);
  }
  for (const corpus of [null, { ...valid.corpus, revision: 'not-a-revision' },
    { ...valid.corpus, corpusInputSha256: '' }, { ...valid.corpus, repository: '' },
    { ...valid.corpus, corpusRoot: '' }, { ...valid.corpus, extra: 'ignored?' }]) {
    assert.throws(() => captureNutritionQueryPolicy(asSelection({ ...valid, corpus })), TypeError);
  }
});

test('unknown jobs and empty original questions fail even with a complete policy', () => {
  for (const policy of [undefined, injection()]) {
    for (const job of ['unknown', '__proto__', 'toString']) {
      assert.throws(() => resolveNutritionQuery(policy, job as 'protein', 'question'), /unsupported-nutrition-job/);
    }
    for (const question of ['', ' ']) assert.throws(() => resolveNutritionQuery(policy, 'protein', question), /invalid-nutrition-question/);
  }
});
