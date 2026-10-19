import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createFormFollowupGroundingRetriever } from '../../dist/src/grounding/form-artifact.js';
import { proteinOriginal, proteinCoverage, proteinCorpusStatus } from '../../dist/tests/grounding/evaluation/form-nutrition-oracle.js';
import { composeGroundedAnswer } from '../../dist/src/grounding/answer.js';

// Run explicitly after producer qualification; discovery must not infer an absent artifact is passing.
const read = relative => readFileSync(new URL(relative, new URL('../../../../', import.meta.url)));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const decode = bytes => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
const dataRevision = '0c68e72727f04a7307407a4a6b73d43b7dca61a6';
const inputSha = 'd2e4403c99d91d8069d5a124a3ad0e9c9008c669f04f7d1cff8982799b884971';
const declarationPath = 'docs/knowledge/research-followups/output-declaration.json';
const trustedDeclarationSha = process.argv[2];
assert.equal(process.argv.length, 3, 'supply the accepted output-declaration SHA256');
assert.match(trustedDeclarationSha ?? '', /^[0-9a-f]{64}$/);
const declarationBytes = read(declarationPath);
assert.equal(declarationBytes.byteLength, 2458);
assert.equal(hash(declarationBytes), trustedDeclarationSha, 'output declaration must have an external trust anchor');
const d = decode(declarationBytes);
assert.equal(d.schema, 'form.followup-grounding-output/v1');
assert.equal(d.authority_effect, 'none');
assert.deepEqual(d.source, {
  repository: 'Jones-Systems/Form', revision: dataRevision,
  corpusRoot: 'docs/knowledge/research-followups', corpusInputSha256: inputSha,
});
assert.deepEqual(d.source_inputs, {
  path: 'docs/knowledge/research-followups/source-inputs.json', revision: dataRevision,
  sha256: '9d4fbc8208b1fdfa62abb4c15f6a81eed39b6aa1870cbc4459f3c8648e0e5b00',
});
const sourceInputsBytes = read(d.source_inputs.path);
assert.equal(sourceInputsBytes.byteLength, 10041);
assert.equal(hash(sourceInputsBytes), d.source_inputs.sha256);
assert.equal(d.projection.sha256, '8fcb4cd3ac9a1edf1140fb591b731e74172095a7b534d758fb5f8d30d027de10');
assert.equal(d.projection.bytes, 80588);
assert.ok(Number.isSafeInteger(d.projection.bytes) && d.projection.bytes > 0);
assert.equal(d.projection.path, `services/api/dist/grounding/${d.projection.sha256}/projection.json`);
assert.deepEqual(d.receipt, {
  path: `services/api/dist/grounding/${d.projection.sha256}/receipt.json`,
  sha256: 'd2004cf92a4e8ea79bf66cc138da4ded18a16f0a00c05bd38a3de53d9b6a7ca1', bytes: 2389,
});
const receiptBytes = read(d.receipt.path);
assert.equal(receiptBytes.byteLength, d.receipt.bytes);
assert.equal(hash(receiptBytes), d.receipt.sha256);
const bytes = new Uint8Array(read(d.projection.path));
const verifyBytes = candidate => {
  assert.equal(candidate.byteLength, d.projection.bytes);
  assert.equal(hash(candidate), d.projection.sha256);
};
verifyBytes(bytes);
const altered = bytes.slice();
altered[0] ^= 1;
assert.throws(() => verifyBytes(altered));
assert.throws(() => verifyBytes(bytes.slice(1)));

const projection = decode(bytes);
const ids = ['ANA-S10', 'ANA-S11', 'ANA-S12', 'ANA-S13', 'BCM-S09', 'BCM-S10', 'BEH-S14', 'FLE-S01', 'FLE-S02', 'FLE-S03', 'FLE-S04', 'FLE-S05', 'HLT-S13', 'HLT-S14', 'HLT-S15', 'HLT-S16', 'HLT-S17', 'HLT-S18', 'HLT-S19', 'HLT-S20', 'HLT-S21', 'HLT-S22', 'HLT-S23', 'HLT-S24', 'HLT-S25', 'NUT-S034'];
assert.deepEqual(d.expected, {
  observation_ids: ids, coverage_units: 106, partial_units: ['ANA-C2', 'BCM-Z1', 'BEH-X1', 'DOS-E1', 'EXU-B4', 'EXU-B5', 'HLT-Y1', 'NUT-I3'],
  unsearched_units: 98, units_without_observations: 98, source_packets_without_records: [],
});
assert.deepEqual(projection.records.map(entry => entry.record.id).sort(), ids);
assert.equal(projection.inputs.length, 23);
assert.equal(projection.coverage.units.length, 106);
assert.deepEqual(projection.coverage.units.filter(unit => unit.state === 'partial')
  .map(unit => unit.unit_id).sort(), ['ANA-C2', 'BCM-Z1', 'BEH-X1', 'DOS-E1', 'EXU-B4', 'EXU-B5', 'HLT-Y1', 'NUT-I3']);
assert.equal(projection.coverage.units.filter(unit => unit.state === 'unsearched').length, 98);
assert.equal(projection.corpus_status.units_without_observations.length, 98);
assert.deepEqual(projection.corpus_status.source_packets_without_records, []);
assert.equal(projection.corpus_input_sha256, inputSha);

const perimenopause = projection.records.find(entry => entry.record.id === 'HLT-S17')?.record;
const anxiety = projection.records.find(entry => entry.record.id === 'HLT-S18')?.record;
assert.ok(perimenopause);
assert.ok(anxiety);
assert.ok(perimenopause.form_appraisal.includes('Stage was not randomized'));
assert.ok(perimenopause.form_appraisal.includes('prevent stage-equivalence claims'));
assert.ok(perimenopause.form_appraisal.includes('Strict perimenopause-specific question eligibility remains partial'));
assert.equal(perimenopause.access_level, 'abstract');
assert.ok(perimenopause.provenance.includes('Direct PubMed abstract and separately indexed original fragments; not verified full text'));
assert.ok(perimenopause.rights_status.includes('commercial/product reuse remains uncleared'));
assert.ok(perimenopause.freshness_status.includes('not comprehensive current-notice clearance'));
assert.ok(anxiety.form_appraisal.includes('Non-AGAD screening did not establish diagnosis-free participants; mental-health treatment was permitted'));
assert.ok(anxiety.form_appraisal.includes('Strict nonclinical eligibility remains partial'));
assert.ok(anxiety.applicability.includes('Questionnaire changes do not establish diagnosis, clinical treatment efficacy'));
assert.equal(anxiety.access_level, 'full');
assert.ok(anxiety.provenance.includes('Publisher PDF and PubMed readable; publisher HTML identity redirect inaccessible and PMC challenge'));
assert.ok(anxiety.rights_status.includes('product-specific rights remain unassessed'));
assert.ok(anxiety.freshness_status.includes('not exhaustive clearance'));

const altitude = projection.records.find(entry => entry.record.id === 'HLT-S19')?.record;
const postpartum = projection.records.find(entry => entry.record.id === 'HLT-S20')?.record;
assert.ok(altitude);
assert.ok(postpartum);
assert.ok(altitude.summary.includes('normobaric simulation, not mountain exposure'));
assert.ok(altitude.form_appraisal.includes('Null significance is not equivalence'));
assert.ok(altitude.form_appraisal.includes('Peak saturation: abstract/Table 2 five points, Results prose six'));
assert.ok(altitude.form_appraisal.includes('familiarization five versus ten minutes. Age SD eleven versus twelve'));
assert.ok(altitude.form_appraisal.includes('Pre-exercise hypoxic duration unestablished'));
assert.ok(altitude.applicability.includes('No acclimatization, long-term benefit, clinical transfer, personal threshold or prescription established'));
assert.equal(altitude.access_level, 'partial');
assert.ok(altitude.provenance.includes('Indexed original PMC methods/results/limitations/license; indexed publisher disclosures'));
assert.ok(altitude.provenance.includes('no verified full-text access or runtime adoption'));
assert.ok(altitude.rights_status.includes('CC BY 4.0 reported; product-specific rights unassessed'));
assert.ok(altitude.freshness_status.includes('not comprehensive current-notice clearance'));
assert.ok(postpartum.source_native_certainty.includes('distinct distance and strength endpoints'));
assert.ok(postpartum.form_appraisal.includes('Adult ages, full measurement protocol, attrition, adherence and achieved exposure unverified'));
assert.ok(postpartum.form_appraisal.includes('Diagnosed postpartum population; strict adult/general-population eligibility remains partial'));
assert.ok(postpartum.form_appraisal.includes('One distance condition cannot represent every site or contraction condition'));
assert.ok(postpartum.applicability.includes('No everyday-function, body-image, closure, clinical treatment, universal safety, equivalence or safe-load conclusion; no adoption/avoidance instruction'));
assert.equal(postpartum.access_level, 'abstract');
assert.ok(postpartum.provenance.includes('Direct PubMed abstract; indexed publisher footer. Full methods/PDF inaccessible; registration shell only'));
assert.ok(postpartum.rights_status.includes('PubMed all-rights-reserved notice versus indexed publisher unspecified Creative Commons license; subtype/product reuse unresolved'));
assert.ok(postpartum.freshness_status.includes('bounded notice search found none, not comprehensive clearance'));

const byId = new Map(projection.records.map(entry => [entry.record.id, entry.record]));
assert.ok(byId.get('BCM-S09')?.summary.includes('The Discussion incorrectly labels 0.95 as participant–technician'));
assert.ok(byId.get('BCM-S09')?.form_appraisal.includes('TEM formula and numerical agreement limits unverified'));
assert.ok(byId.get('BCM-S09')?.applicability.includes('No universal detectable-change threshold, home longitudinal fat-change validation'));
assert.ok(byId.get('BCM-S10')?.summary.includes('Triplicates were nonconsecutive within one session; the two most distant readings were selected and averaged'));
assert.ok(byId.get('BCM-S10')?.form_appraisal.includes('TEM/SEM/minimal-difference formulas unspecified'));
assert.ok(byId.get('BCM-S10')?.applicability.includes('No validated between-day/home longitudinal tracking, raw-thickness-to-percent-fat conversion'));
assert.ok(byId.get('BEH-S14')?.summary.includes('an attendance endpoint, definition, denominator and attrition were unavailable'));
assert.ok(byId.get('BEH-S14')?.summary.includes('same investigation, not an independent replication'));
assert.ok(byId.get('BEH-S14')?.form_appraisal.includes('adult eligibility remains unresolved'));
assert.ok(byId.get('BEH-S14')?.freshness_status.includes('10.1519/JSC.0000000000001850'));
assert.ok(byId.get('BEH-S14')?.freshness_status.includes('Scope unknown; no current-notice clearance or new invalidation event asserted'));
assert.ok(byId.get('HLT-S21')?.summary.includes('not resting/cuff readings or verified mean-arterial-pressure values'));
assert.ok(byId.get('HLT-S21')?.applicability.includes('personal pressure/load threshold, belt effect or breathing instruction'));
assert.ok(byId.get('HLT-S22')?.summary.includes('Only 12/11 completed; all 47 analyzed using a selected imputation dataset'));
assert.ok(byId.get('HLT-S22')?.applicability.includes('Measured walking tests are not generalized function or muscle growth'));
assert.ok(byId.get('HLT-S23')?.applicability.includes('Intra-abdominal pressure is not arterial pressure'));
assert.ok(byId.get('HLT-S23')?.applicability.includes('Pressure/EMG does not establish spinal compression, injury protection, safety'));
assert.ok(byId.get('HLT-S24')?.summary.includes('no straps at 80% unstrapped maximum, straps at that same load, or straps at 80% strapped maximum'));
assert.ok(byId.get('HLT-S24')?.summary.includes('unstrapped velocity exceeded strapped-maximum loading'));
assert.ok(byId.get('HLT-S24')?.applicability.includes('Perceived security is not safety'));
assert.ok(byId.get('HLT-S25')?.summary.includes('Endurance protocol and results remain unverified despite the title'));
assert.ok(byId.get('HLT-S25')?.source_native_certainty.includes('Reported null significance does not establish equivalence'));
assert.ok(byId.get('HLT-S25')?.applicability.includes('No mechanical-stabilization, injury-prevention, pain-treatment'));
assert.deepEqual(byId.get('HLT-S24')?.topic_ids, ['HLT-Y1', 'EXU-B4']);

const fleIds = ['FLE-S01', 'FLE-S02', 'FLE-S03', 'FLE-S04', 'FLE-S05'];
const fleLines = [5, 35, 65, 93, 123];
const retainedPacket = read('sources/businesslessons/core/research/form-knowledge-campaign-2026-10-01/sources/stretch-rom-008.md');
assert.equal(retainedPacket.byteLength, 9578);
assert.equal(hash(retainedPacket), '91bfca77d93d13317819b0a601cb71572f27eb12904ed6228faab836618e59cd');
assert.deepEqual(read('docs/knowledge/research-followups/sources/stretch-rom-008.md'), retainedPacket);
const packetLines = retainedPacket.toString('utf8').split('\n');
for (const [index, id] of fleIds.entries()) {
  const entry = projection.records.find(item => item.record.id === id);
  assert.ok(entry);
  assert.equal(entry.source_path, 'sources/stretch-rom-008.md');
  assert.equal(entry.source_packet_sha256, hash(retainedPacket));
  assert.equal(entry.line, fleLines[index]);
  assert.equal(packetLines[entry.line - 1], '```json');
  const end = packetLines.indexOf('```', entry.line);
  assert.ok(end > entry.line);
  assert.deepEqual(entry.record, JSON.parse(packetLines.slice(entry.line, end).join('\n')));
  assert.deepEqual(entry.record.topic_ids, ['EXU-B5', 'DOS-E1']);
  assert.deepEqual(entry.record.conflicts, ['FLE-S01', 'FLE-S02', 'FLE-S04'].includes(id) ? [id] : []);
}
assert.equal(byId.get('FLE-S05')?.access_level, 'abstract');
assert.ok(byId.get('FLE-S05')?.form_appraisal.includes('mention-only'));
assert.ok(byId.get('FLE-S05')?.rights_status.includes('unknown'));
assert.ok(byId.get('FLE-S05')?.summary.includes('sex/age, exact holds, achieved exposure'));
assert.ok(byId.get('FLE-S03')?.applicability.includes('durability and active-ROM transfer unknown'));

// Python producer cases separately authenticate original packet/fence parity; this checks actual compiled consumers.
assert.deepEqual(projection.records.find(entry => entry.record.id === 'NUT-S034'), proteinOriginal);
assert.deepEqual(projection.coverage, proteinCoverage);
assert.deepEqual(projection.corpus_status, proteinCorpusStatus);
const retriever = createFormFollowupGroundingRetriever(bytes);
assert.throws(() => createFormFollowupGroundingRetriever(altered));
assert.throws(() => createFormFollowupGroundingRetriever(bytes.slice(1)));
const historical = read('services/api/tests/grounding/fixtures/form-followup-historical-twenty-five.json');
assert.equal(historical.byteLength, 76175);
assert.equal(hash(historical), 'd542be0c5e2fe23330c17d3302146c309e8d0410c12b250c82500792be223e40');
assert.throws(() => createFormFollowupGroundingRetriever(historical));
assert.deepEqual(projection.records.filter(entry => entry.record.id !== 'NUT-S034'), decode(historical).records);
assert.deepEqual(projection.coverage.units.filter(unit => unit.unit_id !== 'NUT-I3'),
  decode(historical).coverage.units.filter(unit => unit.unit_id !== 'NUT-I3'));
for (const entry of projection.records) {
  const context = { revision: `fixture-${entry.record.id}`,
    facts: [{ id: 'interest', text: 'I want to understand what this study measured and what remains uncertain.', origin: 'user_provided' }],
    supersedesRevision: null };
  const retrieval = { query: entry.record.id, topic: entry.record.topic_ids[0], limit: 100 };
  const expectedEvidence = retriever.retrieve(retrieval);
  const answer = composeGroundedAnswer(retriever, { retrieval, context });
  assert.equal(answer.status, 'informative');
  assert.deepEqual(answer.evidence.source, d.source);
  assert.deepEqual(answer.evidence, expectedEvidence);
  assert.deepEqual(answer.context, context);
  const statement = answer.statements.find(item => item.id === entry.record.id);
  assert.ok(statement);
  assert.deepEqual(statement.citation, entry);
  assert.equal(statement.text, entry.record.summary);
  assert.equal(statement.originalPassageVerified, false);
  if (fleIds.includes(entry.record.id)) {
    const expectedConflicts = ['FLE-S01', 'FLE-S02', 'FLE-S04'].includes(entry.record.id) ? [{
      observationId: entry.record.id, conflictingObservationId: entry.record.id,
      referencedObservationIncluded: true, disposition: 'unresolved',
    }] : [];
    assert.deepEqual(answer.conflicts, expectedConflicts);
  }
  assert.equal(answer.evidence.clinicalReadiness, 'CL-0');
  assert.equal(answer.evidence.verbatimPassagesAvailable, false);
  assert.equal(answer.contextUse, 'acknowledged_not_applicability_assessed');
  assert.equal(answer.choice.decisionOwner, 'user');
  assert.equal(answer.choice.automaticAdoption, false);
  assert.ok(answer.options.every(option => option.adoption === 'not_applied'));
  assert.deepEqual(answer.options.find(option => option.statementId === entry.record.id), {
    id: entry.record.id, kind: 'literature_consideration', title: entry.record.title,
    statementId: entry.record.id, adoption: 'not_applied',
  });
  console.log(`PASS ${entry.record.id}: authenticated source binding, unchanged citation/summary/qualifiers, user choice`);
}
for (const topic of ['DOS-E1', 'EXU-B5']) {
  const result = retriever.retrieve({ query: 'source_observation', topic, limit: 100 });
  assert.equal(result.totalMatches, 5);
  assert.deepEqual(result.observations.map(entry => entry.record.id), fleIds);
}
assert.deepEqual(retriever.retrieve({ query: 'source_observation', topic: 'EXU-B5', access: 'abstract' })
  .observations.map(entry => entry.record.id), ['FLE-S05']);
assert.deepEqual(retriever.retrieve({ query: 'HLT-S24', topic: 'EXU-B4' }).observations
  .map(entry => entry.record.id), ['HLT-S24']);
assert.deepEqual(retriever.retrieve({ query: 'protein', topic: 'NUT-I3' }).observations, [proteinOriginal]);
assert.equal(retriever.retrieve({ query: 'How should I distribute protein across breakfast and dinner?', topic: 'NUT-I3' }).status, 'gap');
console.log('PASS qualified protein matches the independent packet oracle; uncovered question stays a gap; historical/tampered/truncated bytes rejected');
console.log('Form follow-up artifact witness complete; no runtime mount or scientific/rights adoption assessed');
