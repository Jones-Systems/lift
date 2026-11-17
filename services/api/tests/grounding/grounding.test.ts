import test from 'node:test';
import assert from 'node:assert/strict';
import { createGroundingRetriever, GroundingInputError, type GroundingRequest } from '../../src/grounding/index.js';
import { syntheticFixture, syntheticRecord, packetPath } from './fixture.js';

function rejects(code: GroundingInputError['code'], action: () => unknown): void {
  assert.throws(action, error => error instanceof GroundingInputError && error.code === code);
}

test('preserves every qualifier, source locator, coverage omission, and conflict outside the page', () => {
  const first = syntheticRecord('SYN-S10', { conflicts: ['SYN-S2'] });
  const { projection, binding } = syntheticFixture([syntheticRecord(), first]);
  const result = createGroundingRetriever(projection, binding).retrieve({ query: '  STRENGTH  ', limit: 1 });
  assert.equal(result.status, 'observations');
  assert.deepEqual(result.observations[0]?.record, first);
  assert.deepEqual(result.observations[0], projection.records[1]);
  assert.deepEqual(result.source, binding);
  assert.deepEqual(result.coverage, projection.coverage);
  assert.deepEqual(result.corpusStatus, projection.corpus_status);
  assert.equal(result.clinicalReadiness, 'CL-0');
  assert.equal(result.verbatimPassagesAvailable, false);
  assert.equal(result.query, '  STRENGTH  ');
  assert.deepEqual(result.filters, { topic: null, access: null });
  assert.equal(result.totalMatches, 2);
  assert.equal(result.truncated, true);
  assert.equal('quotation' in result.observations[0]!, false);
  assert.equal('evidenceScore' in result, false);
});

test('AND whole Unicode tokens cross record fields without stemming or diacritic folding', () => {
  const { projection, binding } = syntheticFixture([syntheticRecord('SYN-S1', { applicability: 'Synthetic Δύναμη 東京 adults.' })]);
  const retriever = createGroundingRetriever(projection, binding);
  for (const query of ['STRENGTH uncertain', 'CAFÉ 42', 'δύναμη 東京', 'unknown adults', 'running running']) {
    assert.equal(retriever.retrieve({ query }).status, 'observations', query);
  }
  for (const query of ['strength absentword', 'run', 'cafe', 'strengths', 'synthetic-observations', 'SYN-S999']) {
    assert.equal(retriever.retrieve({ query }).status, 'gap', query);
  }
});

test('exact topic/access filters precede code-unit ordering, total count, and bounded limiting', () => {
  const records = [
    syntheticRecord('SYN-S2'), syntheticRecord('SYN-S10', { access_level: 'full' }),
    syntheticRecord('SYN-S1', { access_level: 'full', topic_ids: ['SYN-A2'] }),
  ];
  const { projection, binding } = syntheticFixture(records);
  const retriever = createGroundingRetriever(projection, binding);
  const all = retriever.retrieve({ query: 'strength' });
  assert.deepEqual(all.observations.map(entry => entry.record.id), ['SYN-S1', 'SYN-S10', 'SYN-S2']);
  assert.equal(all.limit, 20);
  assert.equal(all.totalMatches, 3);
  assert.equal(all.truncated, false);
  const limited = retriever.retrieve({ query: 'strength', access: 'full', limit: 1 });
  assert.equal(limited.totalMatches, 2);
  assert.equal(limited.truncated, true);
  assert.deepEqual(limited.observations.map(entry => entry.record.id), ['SYN-S1']);
  const exact = retriever.retrieve({ query: 'strength', access: 'full', topic: 'SYN-A1', limit: 100 });
  assert.equal(exact.totalMatches, 1);
  assert.deepEqual(exact.filters, { topic: 'SYN-A1', access: 'full' });
  assert.deepEqual(exact.observations.map(entry => entry.record.id), ['SYN-S10']);
  assert.equal(retriever.retrieve({ query: 'strength', topic: 'SYN-A106' }).status, 'gap');
});

test('gap is explicit bounded missingness and does not invent a passage or scientific absence', () => {
  const { projection, binding } = syntheticFixture([]);
  const result = createGroundingRetriever(projection, binding).retrieve({ query: 'strength' });
  assert.equal(result.status, 'gap');
  if (result.status !== 'gap') assert.fail('expected gap');
  assert.equal(result.reason, 'no_matching_observations');
  assert.deepEqual(result.observations, []);
  assert.equal(result.totalMatches, 0);
  assert.equal(result.truncated, false);
  assert.equal(result.verbatimPassagesAvailable, false);
  assert.deepEqual(result.corpusStatus, projection.corpus_status);
});

test('caller input changes and attempted result changes cannot alter accepted retrieval state', () => {
  const { projection, binding } = syntheticFixture();
  const original = structuredClone(projection);
  const retriever = createGroundingRetriever(projection, binding);
  (projection.records[0]!.record as { summary: string }).summary = 'tampered';
  (projection.records[0]!.record.topic_ids as string[]).push('SYN-A2');
  projection.coverage.units[0]!.title = 'tampered';
  projection.corpus_status.units_without_observations.length = 0;
  binding.repository = 'tampered';
  const result = retriever.retrieve({ query: 'strength' });
  assert.deepEqual(result.observations, original.records);
  assert.deepEqual(result.coverage, original.coverage);
  assert.deepEqual(result.corpusStatus, original.corpus_status);
  assert.equal(result.source.repository, 'synthetic/grounding-tests');
  for (const value of [retriever, result, result.source, result.filters, result.coverage, result.coverage.units, result.coverage.units[0], result.corpusStatus, result.corpusStatus.units_without_observations, result.observations, result.observations[0], result.observations[0]?.record, result.observations[0]?.record.topic_ids]) assert.ok(Object.isFrozen(value));
  assert.throws(() => { (result.observations[0]!.record as { summary: string }).summary = 'tampered'; }, TypeError);
  assert.throws(() => { (result.observations as unknown[]).pop(); }, TypeError);
  assert.deepEqual(retriever.retrieve({ query: 'strength' }), result);
});

test('invalid requests are typed errors; no silent filter, query, or limit coercion', () => {
  const { projection, binding } = syntheticFixture();
  const retriever = createGroundingRetriever(projection, binding);
  const invalid: unknown[] = [null, [], {}, { query: '' }, { query: ' _ - !!! ' }, { query: 3 }, { query: '\ud800' },
    { query: 'strength', topic: 'SYN-A107' }, { query: 'strength', topic: 'syn-a1' }, { query: 'strength', topic: null },
    { query: 'strength', access: 'Full' }, { query: 'strength', access: null }, { query: 'strength', extra: true },
    ...[0, 101, -1, 1.5, NaN, Infinity, '2', null, undefined].map(limit => ({ query: 'strength', limit })),
  ];
  for (const request of invalid) rejects('invalid_request', () => retriever.retrieve(request as GroundingRequest));
});

test('rejects invalid whole projections including records a query or page would exclude', () => {
  const mutations: ((projection: any) => void)[] = [
    p => { p.extra = true; }, p => { p.projector_version = 1; }, p => { p.schema = 'other'; },
    p => { p.coverage.units.pop(); }, p => { p.coverage.units[1] = p.coverage.units[0]; },
    p => { p.coverage.units[0].state = 'complete'; }, p => { p.coverage.units[0].extra = 1; },
    p => { p.coverage.source_plan_revision = 'a'.repeat(39); }, p => { p.coverage.source_plan = '../escape.md'; },
    p => { p.coverage.authority_effect = 'adopt'; },
    p => { delete p.records[1].record.applicability; }, p => { p.records[1].record.quote = 'invented'; },
    p => { p.records[1].record.id = p.records[0].record.id; }, p => { p.records[1].record.id = 'BAD'; },
    p => { p.records[1].record.kind = 'claim'; }, p => { p.records[1].record.clinical_readiness = 'CL-1'; },
    p => { p.records[1].record.access_level = 'public'; }, p => { p.records[1].record.topic_ids = []; },
    p => { p.records[1].record.topic_ids = ['SYN-A107']; }, p => { p.records[1].record.topic_ids = ['SYN-A1', 'SYN-A1']; },
    p => { p.records[1].record.conflicts = ['SYN-S999']; }, p => { p.records[1].record.conflicts = ['bad']; },
    p => { p.records[1].record.conflicts = ['SYN-S1', 'SYN-S1']; },
    p => { p.records[1].record.doi = 'bad'; }, p => { p.records[1].record.pmid = '001'; },
    p => { p.records[1].record.accessed = '2026-02-29'; }, p => { p.records[1].record.accessed = '0000-01-01'; },
    p => { p.records[1].record.accessed = '2026-1-01'; }, p => { p.records[1].record.summary = ' '; },
    p => { p.records[1].record.title = '\ud800'; }, p => { p.records[1].line = 0; }, p => { p.records[1].line = 1.5; },
    p => { p.records[1].line = p.records[0].line; }, p => { p.records[1].source_path = '../escape.md'; },
    p => { p.records[1].source_path = 'sources/absent.md'; }, p => { p.records[1].source_packet_sha256 = 'a'.repeat(64); },
    p => { p.inputs.push(p.inputs[0]); }, p => { p.inputs[1].sha256 = 'bad'; }, p => { p.corpus_input_sha256 = '0'.repeat(64); },
    p => { p.corpus_status.state = 'complete'; }, p => { p.corpus_status.limitation = 'clinically validated'; },
    p => { p.corpus_status.units_without_observations.pop(); }, p => { p.corpus_status.source_packets_without_records = [packetPath]; },
  ];
  for (const [index, mutate] of mutations.entries()) {
    const { projection, binding } = syntheticFixture([syntheticRecord('SYN-S1'), syntheticRecord('SYN-S2', { title: 'Excluded topic', topic_ids: ['SYN-A2'] })]);
    mutate(projection);
    assert.throws(() => createGroundingRetriever(projection, binding), error => error instanceof GroundingInputError && error.code === 'invalid_projection', `mutation ${index}`);
  }
});

test('URL validation excludes credentials, unsafe schemes, whitespace, bad ports, and backslashes', () => {
  for (const url of ['file:///source', 'https://u:p@example.invalid/', 'https://@example.invalid/', 'https://example.invalid:0/', 'https://example.invalid:65536/', 'https://example.invalid/white space', 'https://example.invalid\\evil', 'https:///']) {
    const { projection, binding } = syntheticFixture([syntheticRecord('SYN-S1', { url })]);
    rejects('invalid_projection', () => createGroundingRetriever(projection, binding));
  }
  const { projection, binding } = syntheticFixture([syntheticRecord('SYN-S1', { url: 'https://example.invalid:443/path', doi: '10.1234/example', pmid: '123', accessed: '2024-02-29' })]);
  assert.equal(createGroundingRetriever(projection, binding).retrieve({ query: 'strength' }).status, 'observations');
});

test('binding validates full revision, relative corpus root, exact keys, and input digest agreement', () => {
  const { projection, binding } = syntheticFixture();
  for (const replacement of [ { ...binding, revision: 'short' }, { ...binding, repository: '' },
    { ...binding, corpusRoot: '/absolute' }, { ...binding, corpusRoot: 'a/../b' },
    { ...binding, corpusInputSha256: '0'.repeat(64) }, { ...binding, extra: true },
  ]) rejects('invalid_binding', () => createGroundingRetriever(projection, replacement));
});

test('non-data objects and accessor inputs reject without invoking getters', () => {
  const { projection, binding } = syntheticFixture();
  let invoked = false;
  Object.defineProperty(projection.records[0]!.record, 'summary', { enumerable: true, get() { invoked = true; return 'strength'; } });
  rejects('invalid_projection', () => createGroundingRetriever(projection, binding));
  assert.equal(invoked, false);
  rejects('invalid_projection', () => createGroundingRetriever(new Date(), binding));
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
  rejects('invalid_projection', () => createGroundingRetriever(cyclic, binding));
});
