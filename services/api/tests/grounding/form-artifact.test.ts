import test from 'node:test';
import { proteinOriginal, proteinCoverage, proteinCorpusStatus } from './evaluation/form-nutrition-oracle.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createFormFollowupGroundingRetriever } from '../../src/grounding/form-artifact.js';
import { composeGroundedAnswer } from '../../src/grounding/answer.js';
import { GroundingInputError, type CorpusStatus, type ObservationEntry, type ResearchCoverage } from '../../src/grounding/index.js';

const projectionSha256 = '8fcb4cd3ac9a1edf1140fb591b731e74172095a7b534d758fb5f8d30d027de10';
const readArtifact = (digest = projectionSha256): Buffer =>
  readFileSync(new URL(`../../grounding/${digest}/projection.json`, import.meta.url));
const expectedSource = {
  repository: 'Jones-Systems/Form', revision: '0c68e72727f04a7307407a4a6b73d43b7dca61a6',
  corpusRoot: 'docs/knowledge/research-followups',
  corpusInputSha256: 'd2e4403c99d91d8069d5a124a3ad0e9c9008c669f04f7d1cff8982799b884971',
};
const ids = ['ANA-S10', 'ANA-S11', 'ANA-S12', 'ANA-S13', 'BCM-S09', 'BCM-S10', 'BEH-S14', 'FLE-S01', 'FLE-S02', 'FLE-S03', 'FLE-S04', 'FLE-S05', 'HLT-S13', 'HLT-S14', 'HLT-S15', 'HLT-S16', 'HLT-S17', 'HLT-S18', 'HLT-S19', 'HLT-S20', 'HLT-S21', 'HLT-S22', 'HLT-S23', 'HLT-S24', 'HLT-S25', 'NUT-S034'];
const decode = (bytes: Buffer): { records: ObservationEntry[]; coverage: ResearchCoverage; corpus_status: CorpusStatus } =>
  JSON.parse(bytes.toString('utf8'));

test('Form factory authenticates the twenty-six-record successor and preserves complete citations and local coverage', () => {
  const bytes = readArtifact();
  assert.equal(bytes.byteLength, 80588);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), projectionSha256);
  const projection = decode(bytes);
  const result = createFormFollowupGroundingRetriever(bytes).retrieve({ query: 'source_observation', limit: 100 });
  assert.equal(result.status, 'observations');
  assert.deepEqual(result.source, expectedSource);
  assert.deepEqual(result.observations.map(entry => entry.record.id), ids);
  assert.equal(result.totalMatches, 26);
  assert.equal(result.truncated, false);
  for (const entry of result.observations) {
    assert.deepEqual(entry, projection.records.find(original => original.record.id === entry.record.id));
    assert.equal(entry.record.clinical_readiness, 'CL-0');
  }
  assert.deepEqual(result.coverage, projection.coverage);
  assert.equal(result.coverage.units.length, 106);
  assert.deepEqual(result.coverage.units.filter(unit => unit.state === 'partial').map(unit => unit.unit_id).sort(), ['ANA-C2', 'BCM-Z1', 'BEH-X1', 'DOS-E1', 'EXU-B4', 'EXU-B5', 'HLT-Y1', 'NUT-I3']);
  assert.equal(result.coverage.units.filter(unit => unit.state === 'unsearched').length, 98);
  assert.deepEqual(result.corpusStatus, projection.corpus_status);
  assert.equal(result.corpusStatus.units_without_observations.length, 98);
  assert.deepEqual(result.corpusStatus.source_packets_without_records, []);
  assert.equal(result.clinicalReadiness, 'CL-0');
  assert.equal(result.verbatimPassagesAvailable, false);
  assert.deepEqual(result.observations.find(entry => entry.record.id === 'NUT-S034'), proteinOriginal);
  assert.deepEqual(result.coverage, proteinCoverage);
  assert.deepEqual(result.corpusStatus, proteinCorpusStatus);

  const soleus = result.observations.find(entry => entry.record.id === 'ANA-S13')!.record;
  assert.ok(soleus.form_appraisal.includes('No direct walking soleus force or selective muscle intervention'));
  assert.ok(soleus.form_appraisal.includes('Sequence constrains causal attribution'));
  const cold = result.observations.find(entry => entry.record.id === 'HLT-S16')!.record;
  assert.ok(cold.form_appraisal.includes('Abstract says five bouts; Methods/figures four'));
  assert.ok(cold.form_appraisal.includes('Methods describes an oro-nasal mask; Discussion mouthpiece/noseclip'));
  assert.ok(cold.form_appraisal.includes('Uncontrolled metabolic demand'));
  assert.ok(cold.form_appraisal.includes('10/20°C comparison is nonmonotonic'));
  assert.ok(cold.applicability.includes('Null significance is not equivalence or safety'));
  const postpartum = result.observations.find(entry => entry.record.id === 'HLT-S20')!.record;
  assert.equal(postpartum.access_level, 'abstract');
  assert.ok(postpartum.form_appraisal.includes('Adult ages, full measurement protocol, attrition, adherence and achieved exposure unverified'));
  assert.ok(postpartum.rights_status.includes('subtype/product reuse unresolved'));
  assert.ok(postpartum.freshness_status.includes('not comprehensive clearance'));

  const behavior = result.observations.find(entry => entry.record.id === 'BEH-S14')!.record;
  assert.ok(behavior.summary.includes('an attendance endpoint, definition, denominator and attrition were unavailable'));
  assert.ok(behavior.freshness_status.includes('10.1519/JSC.0000000000001850'));
  assert.ok(behavior.freshness_status.includes('Scope unknown'));
  const waist = result.observations.find(entry => entry.record.id === 'BCM-S09')!.record;
  assert.ok(waist.summary.includes('The Discussion incorrectly labels 0.95 as participant–technician'));
  assert.ok(waist.applicability.includes('No universal detectable-change threshold'));
  const skinfold = result.observations.find(entry => entry.record.id === 'BCM-S10')!.record;
  assert.ok(skinfold.summary.includes('the two most distant readings were selected and averaged'));
  assert.ok(skinfold.applicability.includes('No validated between-day/home longitudinal tracking'));
  const straps = result.observations.find(entry => entry.record.id === 'HLT-S24')!.record;
  assert.deepEqual(straps.topic_ids, ['HLT-Y1', 'EXU-B4']);
  assert.ok(straps.summary.includes('straps at that same load, or straps at 80% strapped maximum'));
  const wraps = result.observations.find(entry => entry.record.id === 'HLT-S25')!.record;
  assert.ok(wraps.summary.includes('Endurance protocol and results remain unverified despite the title'));
  assert.ok(wraps.source_native_certainty.includes('null significance does not establish equivalence'));

  const fleIds = ['FLE-S01', 'FLE-S02', 'FLE-S03', 'FLE-S04', 'FLE-S05'];
  const fle = result.observations.filter(entry => fleIds.includes(entry.record.id));
  assert.deepEqual(fle.map(entry => entry.line), [5, 35, 65, 93, 123]);
  for (const entry of fle) {
    assert.equal(entry.source_path, 'sources/stretch-rom-008.md');
    assert.equal(entry.source_packet_sha256, '91bfca77d93d13317819b0a601cb71572f27eb12904ed6228faab836618e59cd');
    assert.deepEqual(entry.record.topic_ids, ['EXU-B5', 'DOS-E1']);
    assert.deepEqual(entry.record.conflicts, ['FLE-S01', 'FLE-S02', 'FLE-S04'].includes(entry.record.id) ? [entry.record.id] : []);
  }
  assert.equal(fle[4]!.record.access_level, 'abstract');
  assert.ok(fle[4]!.record.form_appraisal.includes('mention-only'));
  assert.ok(fle[4]!.record.rights_status.includes('unknown'));
  const retriever = createFormFollowupGroundingRetriever(bytes);
  for (const topic of ['DOS-E1', 'EXU-B5']) {
    assert.deepEqual(retriever.retrieve({ query: 'source_observation', topic }).observations.map(entry => entry.record.id), fleIds);
  }
  const page = retriever.retrieve({ query: 'source_observation' });
  assert.equal(page.limit, 20);
  assert.equal(page.totalMatches, 26);
  assert.equal(page.truncated, true);
  assert.deepEqual(page.observations, projection.records.slice(0, 20));
});

test('Form factory rejects invalid, altered, truncated and reserialized bytes plus historical Form and BL artifacts', () => {
  const historical = readFileSync(new URL(
    '../../../tests/grounding/fixtures/form-followup-historical-four.json', import.meta.url,
  ));
  assert.equal(historical.byteLength, 27221);
  assert.equal(createHash('sha256').update(historical).digest('hex'),
    'b472272084ea749cbb336dac000988aa1a917d986be8640da4576a274ee95691');
  const historicalTwelve = readFileSync(new URL(
    '../../../tests/grounding/fixtures/form-followup-historical-twelve.json', import.meta.url,
  ));
  assert.equal(historicalTwelve.byteLength, 47439);
  assert.equal(createHash('sha256').update(historicalTwelve).digest('hex'),
    '59ac6994ed00e79092ddf5c8a5f9eea174910bec57880d928cde5c1f7c71e55b');
  assert.equal(decode(historicalTwelve).records.length, 12);
  const historicalTwenty = readFileSync(new URL(
    '../../../tests/grounding/fixtures/form-followup-historical-twenty.json', import.meta.url,
  ));
  assert.equal(historicalTwenty.byteLength, 66509);
  assert.equal(createHash('sha256').update(historicalTwenty).digest('hex'),
    'dfd9ad93bf39a17a3c7f9b81407a3461a27b1830f64a3e53a126e13a3e196480');
  assert.equal(decode(historicalTwenty).records.length, 20);
  const historicalTwentyFive = readFileSync(new URL(
    '../../../tests/grounding/fixtures/form-followup-historical-twenty-five.json', import.meta.url,
  ));
  assert.equal(historicalTwentyFive.byteLength, 76175);
  assert.equal(createHash('sha256').update(historicalTwentyFive).digest('hex'),
    'd542be0c5e2fe23330c17d3302146c309e8d0410c12b250c82500792be223e40');
  assert.equal(decode(historicalTwentyFive).records.length, 25);
  const valid = readArtifact();
  assert.deepEqual(decode(valid).records.filter(entry => entry.record.id !== 'NUT-S034'), decode(historicalTwentyFive).records);
  assert.deepEqual(decode(valid).coverage.units.filter(unit => unit.unit_id !== 'NUT-I3'),
    decode(historicalTwentyFive).coverage.units.filter(unit => unit.unit_id !== 'NUT-I3'));
  const changed = Buffer.from(valid);
  changed[100] = changed[100]! ^ 1;
  const invalid: unknown[] = [
    undefined, null, {}, valid.toString('utf8'), valid.buffer, new DataView(new ArrayBuffer(1)),
    new Uint8Array(), Buffer.from([0xff, 0xfe]), valid.subarray(0, -1),
    Buffer.concat([valid, Buffer.from('\n')]), changed,
    Buffer.from(JSON.stringify(decode(valid), null, 2)),
    historical, historicalTwelve, historicalTwenty, historicalTwentyFive,
    readArtifact('84530977a646d138ff1194d22d8723989ff6646dc3f69a8ab5c390783de55ad8'),
  ];
  for (const input of invalid) {
    assert.throws(() => createFormFollowupGroundingRetriever(input as Uint8Array),
      error => error instanceof GroundingInputError && error.code === 'invalid_projection');
  }
});

test('Form factory owns the supplied byte view and returns immutable evidence', () => {
  const valid = readArtifact();
  const backing = new Uint8Array(valid.byteLength + 2);
  backing.set(valid, 1);
  const input = backing.subarray(1, -1);
  const retriever = createFormFollowupGroundingRetriever(input);
  const request = { query: 'ANA-S13', topic: 'ANA-C2' };
  const expected = retriever.retrieve(request);
  backing.fill(0);
  const result = retriever.retrieve(request);
  assert.deepEqual(result, expected);
  const entry = result.observations.find(item => item.record.id === 'ANA-S13');
  assert.ok(entry);
  assert.ok(Object.isFrozen(result.source));
  assert.ok(Object.isFrozen(result.coverage.units));
  assert.ok(Object.isFrozen(entry.record));
  assert.throws(() => (entry.record.conflicts as string[]).push('BAD-S1'), TypeError);
  assert.throws(() => Object.assign(entry.record, { summary: 'changed' }), TypeError);
  assert.deepEqual(retriever.retrieve(request), expected);
});

test('Form artifact composes qualified literature with user choice and adds qualified protein while preserving an uncovered protein question as a gap', () => {
  const bytes = readArtifact();
  const retriever = createFormFollowupGroundingRetriever(bytes);
  const original = decode(bytes).records.find(entry => entry.record.id === 'BEH-S14');
  assert.ok(original);
  const context = {
    revision: 'form-artifact-context-1', supersedesRevision: null,
    facts: [{ id: 'interest', text: 'I want to understand whether choosing workout order changed attendance.', origin: 'user_provided' as const }],
  };
  const retrieval = { query: 'BEH-S14', topic: 'BEH-X1' };
  const answer = composeGroundedAnswer(retriever, { retrieval, context });
  assert.equal(answer.status, 'informative');
  assert.deepEqual(answer.evidence, retriever.retrieve(retrieval));
  assert.deepEqual(answer.evidence.source, expectedSource);
  assert.deepEqual(answer.context, context);
  assert.equal(answer.contextUse, 'acknowledged_not_applicability_assessed');
  const statement = answer.statements.find(item => item.id === original.record.id);
  assert.ok(statement);
  assert.deepEqual(statement.citation, original);
  assert.equal(statement.text, original.record.summary);
  assert.equal(statement.originalPassageVerified, false);
  assert.equal(answer.evidence.verbatimPassagesAvailable, false);
  assert.equal(answer.evidence.clinicalReadiness, 'CL-0');
  assert.equal(answer.choice.decisionOwner, 'user');
  assert.equal(answer.choice.automaticAdoption, false);
  assert.ok(answer.options.every(option => option.adoption === 'not_applied'));
  assert.deepEqual(answer.options.find(option => option.statementId === original.record.id), {
    id: original.record.id, kind: 'literature_consideration', title: original.record.title,
    statementId: original.record.id, adoption: 'not_applied',
  });
  const pageRetrieval = { query: 'source_observation' };
  const page = composeGroundedAnswer(retriever, { retrieval: pageRetrieval, context });
  assert.equal(page.status, 'informative');
  assert.deepEqual(page.context, context);
  assert.deepEqual(page.evidence, retriever.retrieve(pageRetrieval));
  assert.equal(page.evidence.totalMatches, 26);
  assert.equal(page.evidence.limit, 20);
  assert.equal(page.evidence.truncated, true);
  assert.equal(page.statements.length, 20);
  assert.deepEqual(page.statements.map(statement => statement.id), ids.slice(0, 20));
  for (const [index, statement] of page.statements.entries()) {
    const entry = page.evidence.observations[index]!;
    assert.deepEqual(statement.citation, entry);
    assert.equal(statement.text, entry.record.summary);
    assert.equal(statement.originalPassageVerified, false);
  }
  assert.deepEqual(page.conflicts, ['FLE-S01', 'FLE-S02', 'FLE-S04'].map(id => ({
    observationId: id, conflictingObservationId: id, referencedObservationIncluded: true,
    disposition: 'unresolved',
  })));
  assert.equal(page.conflicts.filter(edge => !edge.referencedObservationIncluded).length, 0);
  assert.equal(page.options.length, 20);
  assert.ok(page.options.every(option => option.adoption === 'not_applied'));
  assert.equal(page.choice.automaticAdoption, false);
  assert.equal(page.choice.decisionOwner, 'user');
  assert.equal(page.contextUse, 'acknowledged_not_applicability_assessed');
  assert.equal(page.evidence.verbatimPassagesAvailable, false);
  assert.equal(page.evidence.clinicalReadiness, 'CL-0');
  const protein = composeGroundedAnswer(retriever, { retrieval: { query: 'protein', topic: 'NUT-I3' }, context });
  assert.equal(protein.status, 'informative');
  assert.deepEqual(protein.evidence.observations, [proteinOriginal]);
  assert.deepEqual(protein.evidence.source, expectedSource);
  assert.deepEqual(protein.evidence.coverage, proteinCoverage);
  assert.deepEqual(protein.evidence.corpusStatus, proteinCorpusStatus);
  assert.deepEqual(protein.statements, [{ id: 'NUT-S034', evidenceKind: 'retained_source_observation',
    text: proteinOriginal.record.summary, citation: proteinOriginal, originalPassageVerified: false }]);
  assert.deepEqual(protein.context, context);
  assert.equal(protein.contextUse, 'acknowledged_not_applicability_assessed');
  assert.equal(protein.choice.automaticAdoption, false);
  assert.equal(protein.choice.decisionOwner, 'user');
  assert.ok(protein.options.every(option => option.adoption === 'not_applied'));
  assert.equal(protein.evidence.clinicalReadiness, 'CL-0');
  assert.equal(protein.evidence.verbatimPassagesAvailable, false);
  const gap = composeGroundedAnswer(retriever, {
    retrieval: { query: 'How should I distribute protein across breakfast and dinner?', topic: 'NUT-I3' }, context,
  });
  assert.equal(gap.status, 'gap');
  assert.equal(gap.evidence.status, 'gap');
  if (gap.evidence.status === 'gap') assert.equal(gap.evidence.reason, 'no_matching_observations');
  assert.deepEqual(gap.evidence.source, expectedSource);
  assert.deepEqual(gap.statements, []);
  assert.deepEqual(gap.options, []);
  assert.equal(gap.evidence.clinicalReadiness, 'CL-0');
  assert.equal(gap.evidence.verbatimPassagesAvailable, false);
  assert.equal(gap.choice.automaticAdoption, false);
});
