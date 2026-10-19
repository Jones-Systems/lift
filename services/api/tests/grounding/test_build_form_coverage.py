"""Form producer group: source identity, local semantics, determinism and owned publication cleanup."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

HERE = Path(__file__).absolute().parent
REPO = HERE.parents[3]
SCRIPT = REPO / 'services/api/scripts/grounding/build-form-coverage.py'
SPEC = importlib.util.spec_from_file_location('form_coverage_build_under_test', SCRIPT)
BUILDER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BUILDER)
SYNTHETIC_BUNDLE = {'projection.json': b'synthetic projection', 'receipt.json': b'synthetic receipt'}


class BuildFormCoverageTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='.form-coverage-test-', dir=HERE)
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)

    def copied_source(self):
        repo = self.root / 'repository'
        declaration = json.loads((REPO / BUILDER.DECLARATION_PATH).read_bytes())
        paths = [BUILDER.DECLARATION_PATH] + [entry['path'] for entry in declaration['files']]
        self.assertEqual(len(paths), 29)
        for relative in paths:
            target = repo / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(REPO / relative, target)
        return repo

    def test_real_render_is_deterministic_with_source_bound_records_and_local_coverage(self):
        first = BUILDER.render(REPO)
        self.assertEqual(first, BUILDER.render(REPO))
        corpus = json.loads(first['projection.json'])
        receipt = json.loads(first['receipt.json'])
        declaration = json.loads((REPO / BUILDER.DECLARATION_PATH).read_bytes())
        self.assertEqual([entry['record']['id'] for entry in corpus['records']], ['ANA-S10', 'ANA-S11', 'ANA-S12', 'ANA-S13', 'BCM-S09', 'BCM-S10', 'BEH-S14', 'FLE-S01', 'FLE-S02', 'FLE-S03', 'FLE-S04', 'FLE-S05', 'HLT-S13', 'HLT-S14', 'HLT-S15', 'HLT-S16', 'HLT-S17', 'HLT-S18', 'HLT-S19', 'HLT-S20', 'HLT-S21', 'HLT-S22', 'HLT-S23', 'HLT-S24', 'HLT-S25', 'NUT-S034'])
        self.assertEqual(len(corpus['inputs']), 23)
        self.assertEqual(corpus['corpus_input_sha256'], 'd2e4403c99d91d8069d5a124a3ad0e9c9008c669f04f7d1cff8982799b884971')
        self.assertEqual(len(corpus['coverage']['units']), 106)
        self.assertEqual([unit['unit_id'] for unit in corpus['coverage']['units'] if unit['state'] == 'partial'], ['ANA-C2', 'BCM-Z1', 'BEH-X1', 'DOS-E1', 'EXU-B4', 'EXU-B5', 'HLT-Y1', 'NUT-I3'])
        self.assertEqual(sum(unit['state'] == 'unsearched' for unit in corpus['coverage']['units']), 98)
        self.assertEqual(len(corpus['corpus_status']['units_without_observations']), 98)
        self.assertEqual(corpus['corpus_status']['source_packets_without_records'], [])
        for entry in corpus['records']:
            packet = (REPO / BUILDER.CORPUS_ROOT / entry['source_path']).read_bytes()
            lines = packet.decode('utf-8').splitlines()
            self.assertEqual(lines[entry['line'] - 1], '```json')
            end = lines.index('```', entry['line'])
            self.assertEqual(entry['record'], json.loads('\n'.join(lines[entry['line']:end])))
            self.assertEqual(entry['source_packet_sha256'], BUILDER.digest(packet))

        retained_path = 'sources/businesslessons/core/research/form-knowledge-campaign-2026-10-01/sources/stretch-rom-008.md'
        original = (REPO / retained_path).read_bytes()
        copied = (REPO / BUILDER.CORPUS_ROOT / 'sources/stretch-rom-008.md').read_bytes()
        self.assertEqual(copied, original)
        self.assertEqual(len(original), 9578)
        self.assertEqual(BUILDER.digest(original), '91bfca77d93d13317819b0a601cb71572f27eb12904ed6228faab836618e59cd')
        fle = [entry for entry in corpus['records'] if entry['record']['id'].startswith('FLE-')]
        self.assertEqual([entry['line'] for entry in fle], [5, 35, 65, 93, 123])
        self.assertEqual(len(corpus['records']) - len(fle), 21)
        for entry in fle:
            record = entry['record']
            self.assertEqual(entry['source_path'], 'sources/stretch-rom-008.md')
            self.assertEqual(record['topic_ids'], ['EXU-B5', 'DOS-E1'])
            self.assertEqual(record['conflicts'], [record['id']] if record['id'] in {'FLE-S01', 'FLE-S02', 'FLE-S04'} else [])
        self.assertEqual(fle[-1]['record']['access_level'], 'abstract')
        self.assertEqual(receipt['retained_packets'], declaration['retained_packets'])

        historical_bytes = (HERE / 'fixtures/form-followup-historical-twenty-five.json').read_bytes()
        self.assertEqual(len(historical_bytes), 76175)
        self.assertEqual(BUILDER.digest(historical_bytes), 'd542be0c5e2fe23330c17d3302146c309e8d0410c12b250c82500792be223e40')
        historical = json.loads(historical_bytes)
        self.assertEqual(len(historical['records']), 25)
        self.assertEqual([entry for entry in corpus['records'] if entry['record']['id'] != 'NUT-S034'], historical['records'])
        historical_inputs = {entry['source_path']: entry['sha256'] for entry in historical['inputs']}
        current_inputs = {entry['source_path']: entry['sha256'] for entry in corpus['inputs']}
        for path, sha in historical_inputs.items():
            if path != 'coverage.md':
                self.assertEqual(current_inputs[path], sha)
        self.assertEqual([unit for unit in corpus['coverage']['units'] if unit['unit_id'] != 'NUT-I3'],
                         [unit for unit in historical['coverage']['units'] if unit['unit_id'] != 'NUT-I3'])

        by_id = {entry['record']['id']: entry['record'] for entry in corpus['records']}
        self.assertIn('eight volunteers', by_id['ANA-S11']['summary'])
        self.assertIn('ten', by_id['ANA-S11']['summary'])
        self.assertIn('not directly measured', by_id['ANA-S11']['form_appraisal'])
        self.assertIn('absence of all metabolic disease was not established', by_id['HLT-S13']['applicability'])
        self.assertIn('not rates per lift exposure', by_id['HLT-S14']['summary'])
        self.assertIn('second-order impedance', by_id['ANA-S12']['summary'])
        self.assertIn('Neither method directly measured individual-muscle force', by_id['ANA-S12']['form_appraisal'])
        self.assertIn('conditions were sequential', by_id['ANA-S13']['summary'])
        self.assertIn('calculated centre-of-mass energy', by_id['ANA-S13']['summary'])
        self.assertIn('No direct walking soleus force or selective muscle intervention', by_id['ANA-S13']['form_appraisal'])
        self.assertIn('whole-body energy loss cannot isolate soleus work', by_id['ANA-S13']['form_appraisal'])
        self.assertIn('Calculated energy omits segment-relative/rotational energy', by_id['ANA-S13']['form_appraisal'])
        self.assertIn('third-party exceptions', by_id['ANA-S13']['rights_status'])
        self.assertIn('two participants had incomplete spirometry', by_id['HLT-S15']['summary'])
        self.assertIn('Methods names FEV1/FVC; Table I labels FVC:FEV1', by_id['HLT-S15']['form_appraisal'])
        self.assertIn('do not establish equivalence, absence of harm or real-wildfire safety', by_id['HLT-S15']['applicability'])
        self.assertIn('Exercise was the exposure task, not a demonstrated benefit', by_id['HLT-S15']['applicability'])
        self.assertIn('Abstract says five bouts; Methods/figures four', by_id['HLT-S16']['form_appraisal'])
        self.assertIn('Methods describes an oro-nasal mask; Discussion mouthpiece/noseclip enforcing oral breathing', by_id['HLT-S16']['form_appraisal'])
        self.assertIn('Uncontrolled metabolic demand prevents isolating thermal ventilatory-control effects', by_id['HLT-S16']['form_appraisal'])
        self.assertIn('10/20°C comparison is nonmonotonic, with table/prose contrast-order inconsistency', by_id['HLT-S16']['form_appraisal'])
        self.assertIn('Small, selected, young, mostly male sample excluding exercise-/cold-induced asthma', by_id['HLT-S16']['applicability'])
        self.assertIn('Null significance is not equivalence or safety', by_id['HLT-S16']['applicability'])
        self.assertIn('Stage was not randomized', by_id['HLT-S17']['form_appraisal'])
        self.assertIn('prevent stage-equivalence claims', by_id['HLT-S17']['form_appraisal'])
        self.assertIn('Strict perimenopause-specific question eligibility remains partial', by_id['HLT-S17']['form_appraisal'])
        self.assertEqual(by_id['HLT-S17']['access_level'], 'abstract')
        self.assertIn('Direct PubMed abstract and separately indexed original fragments; not verified full text', by_id['HLT-S17']['provenance'])
        self.assertIn('commercial/product reuse remains uncleared', by_id['HLT-S17']['rights_status'])
        self.assertIn('not comprehensive current-notice clearance', by_id['HLT-S17']['freshness_status'])
        self.assertIn('Non-AGAD screening did not establish diagnosis-free participants; mental-health treatment was permitted', by_id['HLT-S18']['form_appraisal'])
        self.assertIn('Strict nonclinical eligibility remains partial', by_id['HLT-S18']['form_appraisal'])
        self.assertIn('Questionnaire changes do not establish diagnosis, clinical treatment efficacy', by_id['HLT-S18']['applicability'])
        self.assertEqual(by_id['HLT-S18']['access_level'], 'full')
        self.assertIn('Publisher PDF and PubMed readable; publisher HTML identity redirect inaccessible and PMC challenge', by_id['HLT-S18']['provenance'])
        self.assertIn('product-specific rights remain unassessed', by_id['HLT-S18']['rights_status'])
        self.assertIn('not exhaustive clearance', by_id['HLT-S18']['freshness_status'])
        self.assertIn('normobaric simulation, not mountain exposure', by_id['HLT-S19']['summary'])
        self.assertIn('Null significance is not equivalence', by_id['HLT-S19']['form_appraisal'])
        self.assertIn('Peak saturation: abstract/Table 2 five points, Results prose six', by_id['HLT-S19']['form_appraisal'])
        self.assertIn('familiarization five versus ten minutes. Age SD eleven versus twelve', by_id['HLT-S19']['form_appraisal'])
        self.assertIn('Pre-exercise hypoxic duration unestablished', by_id['HLT-S19']['form_appraisal'])
        self.assertIn('No acclimatization, long-term benefit, clinical transfer, personal threshold or prescription established', by_id['HLT-S19']['applicability'])
        self.assertEqual(by_id['HLT-S19']['access_level'], 'partial')
        self.assertIn('Indexed original PMC methods/results/limitations/license; indexed publisher disclosures', by_id['HLT-S19']['provenance'])
        self.assertIn('no verified full-text access or runtime adoption', by_id['HLT-S19']['provenance'])
        self.assertIn('CC BY 4.0 reported; product-specific rights unassessed', by_id['HLT-S19']['rights_status'])
        self.assertIn('not comprehensive current-notice clearance', by_id['HLT-S19']['freshness_status'])
        self.assertIn('distinct distance and strength endpoints', by_id['HLT-S20']['source_native_certainty'])
        self.assertIn('Adult ages, full measurement protocol, attrition, adherence and achieved exposure unverified', by_id['HLT-S20']['form_appraisal'])
        self.assertIn('Diagnosed postpartum population; strict adult/general-population eligibility remains partial', by_id['HLT-S20']['form_appraisal'])
        self.assertIn('One distance condition cannot represent every site or contraction condition', by_id['HLT-S20']['form_appraisal'])
        self.assertIn('No everyday-function, body-image, closure, clinical treatment, universal safety, equivalence or safe-load conclusion; no adoption/avoidance instruction', by_id['HLT-S20']['applicability'])
        self.assertEqual(by_id['HLT-S20']['access_level'], 'abstract')
        self.assertIn('Direct PubMed abstract; indexed publisher footer. Full methods/PDF inaccessible; registration shell only', by_id['HLT-S20']['provenance'])
        self.assertIn('PubMed all-rights-reserved notice versus indexed publisher unspecified Creative Commons license; subtype/product reuse unresolved', by_id['HLT-S20']['rights_status'])
        self.assertIn('bounded notice search found none, not comprehensive clearance', by_id['HLT-S20']['freshness_status'])
        self.assertIn('The Discussion incorrectly labels 0.95 as participant–technician', by_id['BCM-S09']['summary'])
        self.assertIn('TEM formula and numerical agreement limits unverified', by_id['BCM-S09']['form_appraisal'])
        self.assertIn('No universal detectable-change threshold, home longitudinal fat-change validation', by_id['BCM-S09']['applicability'])
        self.assertIn('Triplicates were nonconsecutive within one session; the two most distant readings were selected and averaged', by_id['BCM-S10']['summary'])
        self.assertIn('TEM/SEM/minimal-difference formulas unspecified', by_id['BCM-S10']['form_appraisal'])
        self.assertIn('No validated between-day/home longitudinal tracking, raw-thickness-to-percent-fat conversion', by_id['BCM-S10']['applicability'])
        self.assertIn('an attendance endpoint, definition, denominator and attrition were unavailable', by_id['BEH-S14']['summary'])
        self.assertIn('same investigation, not an independent replication', by_id['BEH-S14']['summary'])
        self.assertIn('adult eligibility remains unresolved', by_id['BEH-S14']['form_appraisal'])
        self.assertIn('10.1519/JSC.0000000000001850', by_id['BEH-S14']['freshness_status'])
        self.assertIn('Scope unknown; no current-notice clearance or new invalidation event asserted', by_id['BEH-S14']['freshness_status'])
        self.assertIn('not resting/cuff readings or verified mean-arterial-pressure values', by_id['HLT-S21']['summary'])
        self.assertIn('personal pressure/load threshold, belt effect or breathing instruction', by_id['HLT-S21']['applicability'])
        self.assertIn('Only 12/11 completed; all 47 analyzed using a selected imputation dataset', by_id['HLT-S22']['summary'])
        self.assertIn('Measured walking tests are not generalized function or muscle growth', by_id['HLT-S22']['applicability'])
        self.assertIn('Intra-abdominal pressure is not arterial pressure', by_id['HLT-S23']['applicability'])
        self.assertIn('Pressure/EMG does not establish spinal compression, injury protection, safety', by_id['HLT-S23']['applicability'])
        self.assertIn('no straps at 80% unstrapped maximum, straps at that same load, or straps at 80% strapped maximum', by_id['HLT-S24']['summary'])
        self.assertIn('unstrapped velocity exceeded strapped-maximum loading', by_id['HLT-S24']['summary'])
        self.assertIn('Perceived security is not safety', by_id['HLT-S24']['applicability'])
        self.assertIn('Endurance protocol and results remain unverified despite the title', by_id['HLT-S25']['summary'])
        self.assertIn('Reported null significance does not establish equivalence', by_id['HLT-S25']['source_native_certainty'])
        self.assertIn('No mechanical-stabilization, injury-prevention, pain-treatment', by_id['HLT-S25']['applicability'])
        self.assertEqual(by_id['HLT-S24']['topic_ids'], ['HLT-Y1', 'EXU-B4'])
        protein = by_id['NUT-S034']
        self.assertEqual(protein['topic_ids'], ['NUT-I3'])
        self.assertEqual(protein['access_level'], 'partial')
        self.assertIn('0.30 kg (95% CI 0.09–0.52; p=0.007) across 27 studies', protein['summary'])
        self.assertIn('49 studies / 1,863 participants; the FFM endpoint participant denominator is unknown', protein['summary'])
        self.assertIn('a proxy, not direct muscle mass or an individual benefit guarantee', protein['summary'])
        self.assertIn('healthy and non-energy-restricted', protein['summary'])
        self.assertIn('training at least six weeks and at least twice weekly', protein['summary'])
        self.assertIn('no individual ceiling or intake target', protein['summary'])
        self.assertIn('no formal certainty grade captured', protein['source_native_certainty'])
        self.assertIn('not this entire record', protein['form_appraisal'])
        self.assertIn('disclosure alone establishes neither bias magnitude nor invalidity', protein['form_appraisal'])
        self.assertIn('Individual applicability is unassessed', protein['applicability'])
        self.assertIn('remain uncovered', protein['applicability'])
        self.assertIn('publication/product reuse rights remain unassessed', protein['rights_status'])
        self.assertIn('correction body was not reverified', protein['freshness_status'])
        self.assertIn('current notices remain unknown', protein['freshness_status'])
        self.assertIn('NUT-S001 and NUT-S016, claim NUT-CLM-001 and lineage WS36-LIN04', protein['provenance'])
        self.assertIn('not an independent replication', protein['provenance'])
        self.assertIn('No runtime adoption or original-passage-verification promotion', protein['provenance'])
        self.assertTrue(all(record['clinical_readiness'] == 'CL-0' for record in by_id.values()))
        self.assertEqual(receipt['source'], {
            'repository': 'Jones-Systems/Form', 'revision': '0c68e72727f04a7307407a4a6b73d43b7dca61a6',
            'corpusRoot': BUILDER.CORPUS_ROOT, 'corpusInputSha256': corpus['corpus_input_sha256'],
        })
        self.assertEqual(receipt['input_count'], 23)
        self.assertEqual(receipt['observation_count'], 26)
        self.assertEqual(receipt['source_declaration'], {
            'path': 'docs/knowledge/research-followups/source-inputs.json',
            'sha256': '9d4fbc8208b1fdfa62abb4c15f6a81eed39b6aa1870cbc4459f3c8648e0e5b00', 'bytes': 10041,
        })
        self.assertEqual(receipt['source_plan'], declaration['source_plan'])
        self.assertEqual(corpus['coverage']['source_plan_revision'], '8a5cac17ae5cfae942c76bbeeb24bf2bd2a12902')
        self.assertEqual(receipt['source_plan']['retained_ancestry']['revision'], '7636efca55195b1dc6a5980864452575478116b7')
        self.assertEqual(receipt['projection_sha256'], BUILDER.digest(first['projection.json']))
        self.assertEqual(receipt['projection_bytes'], len(first['projection.json']))
        target = BUILDER.publish(self.root, first)
        self.assertEqual(target.name, receipt['projection_sha256'])
        self.assertEqual(BUILDER.publish(self.root, first), target)
        self.assertEqual(set(self.root.iterdir()), {target})
        for name, data in first.items():
            self.assertEqual((target / name).read_bytes(), data)

    def test_each_declared_witness_and_declaration_tamper_fails_before_output(self):
        repo = self.copied_source()
        declaration = json.loads((repo / BUILDER.DECLARATION_PATH).read_bytes())
        for relative in [BUILDER.DECLARATION_PATH] + [entry['path'] for entry in declaration['files']]:
            with self.subTest(path=relative):
                path = repo / relative
                original = path.read_bytes()
                try:
                    path.write_bytes(original + b'\n')
                    with self.assertRaises(BUILDER.BuildError):
                        BUILDER.build(repo)
                    self.assertFalse((repo / 'services/api/dist').exists())
                finally:
                    path.write_bytes(original)

        witnesses = {entry['path']: (repo / entry['path']).read_bytes() for entry in declaration['files']}
        for field, replacement in (
            ('repository', 'other/repository'), ('revision', '0' * 40),
            ('path', 'research/other.md'), ('git_blob', '0' * 40),
            ('local_path', 'sources/other.md'), ('destination', BUILDER.CORPUS_ROOT + '/sources/other.md'),
            ('bytes', 0), ('sha256', '0' * 64),
        ):
            with self.subTest(binding_field=field):
                altered = copy.deepcopy(declaration)
                altered['retained_packets'][0][field] = replacement
                with self.assertRaises(BUILDER.BuildError):
                    BUILDER.verify_ancestry(altered, witnesses)
        for packet_bindings in (None, [], declaration['retained_packets'] * 2):
            altered = dict(declaration, retained_packets=packet_bindings)
            with self.assertRaises(BUILDER.BuildError):
                BUILDER.verify_ancestry(altered, witnesses)
        for missing_field in (True, False):
            altered = copy.deepcopy(declaration)
            if missing_field:
                del altered['retained_packets'][0]['git_blob']
            else:
                altered['retained_packets'][0]['unrecognized'] = 'synthetic'
            with self.assertRaises(BUILDER.BuildError):
                BUILDER.verify_ancestry(altered, witnesses)
        for key in ('local_path', 'destination'):
            path = declaration['retained_packets'][0][key]
            for replacement in (None, witnesses[path] + b'\n'):
                with self.subTest(witness=key, missing=replacement is None):
                    altered = dict(witnesses)
                    if replacement is None:
                        del altered[path]
                    else:
                        altered[path] = replacement
                    with self.assertRaises(BUILDER.BuildError):
                        BUILDER.verify_ancestry(declaration, altered)
        manifest = json.loads(witnesses['sources/manifest.json'])
        retained = declaration['retained_packets'][0]
        packet_entry = next(item for item in manifest['files'] if item['destination'] == retained['local_path'])
        for field, replacement in (('repository', 'other'), ('revision', '0' * 40),
                                   ('git_blob', '0' * 40), ('destination', 'other'),
                                   ('bytes', 0), ('sha256', '0' * 64), ('source_path', 'other'), ('group', 'other')):
            with self.subTest(manifest_field=field):
                original_value = packet_entry[field]
                try:
                    packet_entry[field] = replacement
                    altered = dict(witnesses, **{'sources/manifest.json': json.dumps(manifest).encode()})
                    with self.assertRaises(BUILDER.BuildError):
                        BUILDER.verify_ancestry(declaration, altered)
                finally:
                    packet_entry[field] = original_value
        self.assertFalse((repo / 'services/api/dist').exists())

    def test_missing_and_extra_packets_fail_before_output(self):
        repo = self.copied_source()
        packet = repo / BUILDER.CORPUS_ROOT / 'sources/ana-c2-coactivation.md'
        original = packet.read_bytes()
        packet.unlink()
        try:
            with self.assertRaises(FileNotFoundError):
                BUILDER.build(repo)
        finally:
            packet.write_bytes(original)
        for name in ('extra.md', 'extra.txt', 'nested'):
            with self.subTest(extra=name):
                extra = packet.parent / name
                if name == 'nested':
                    extra.mkdir()
                else:
                    extra.write_text('Synthetic undeclared packet; no corpus quotation.\n')
                try:
                    with self.assertRaisesRegex(BUILDER.BuildError, 'directory mismatch'):
                        BUILDER.build(repo)
                    self.assertFalse((repo / 'services/api/dist').exists())
                finally:
                    if extra.is_dir():
                        extra.rmdir()
                    else:
                        extra.unlink()

    def test_valid_syntax_state_and_id_changes_are_not_accepted_as_new_inputs(self):
        repo = self.copied_source()
        for relative, old, new in (
            ('coverage.md', '"state": "partial"', '"state": "saturated"'),
            ('sources/ana-c2-coactivation.md', '"id": "ANA-S11"', '"id": "ANA-S99"'),
        ):
            with self.subTest(path=relative):
                path = repo / BUILDER.CORPUS_ROOT / relative
                original = path.read_text()
                self.assertIn(old, original)
                try:
                    path.write_text(original.replace(old, new, 1))
                    with self.assertRaisesRegex(BUILDER.BuildError, 'witness bytes mismatch'):
                        BUILDER.build(repo)
                finally:
                    path.write_text(original)
        self.assertFalse((repo / 'services/api/dist').exists())

    def test_semantic_gate_rejects_projection_state_id_topic_and_omission_variance(self):
        original = json.loads(BUILDER.render(REPO)['projection.json'])
        declaration = json.loads((REPO / BUILDER.DECLARATION_PATH).read_bytes())
        def canonical(value):
            return (json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')) + '\n').encode('utf-8')
        def validate(value):
            BUILDER.validate_corpus(value, declaration, original['coverage'], original['inputs'], canonical)
        validate(original)
        changes = (
            lambda value: value['coverage']['units'][0].update(state='saturated'),
            lambda value: value['coverage'].update(source_plan_revision='0' * 40),
            lambda value: value['records'][0]['record'].update(id='ANA-S99'),
            lambda value: value['records'][0]['record'].update(topic_ids=['HLT-Y1']),
            lambda value: value['records'][0]['record'].update(clinical_readiness='CL-1'),
            lambda value: value['records'][0].update(source_packet_sha256='0' * 64),
            lambda value: value['corpus_status'].update(units_without_observations=[]),
            lambda value: value['corpus_status'].update(source_packets_without_records=['sources/extra.md']),
            lambda value: value['inputs'].pop(),
            lambda value: value.update(corpus_input_sha256='0' * 64),
        )
        for change in changes:
            with self.subTest(change=changes.index(change)):
                value = copy.deepcopy(original)
                change(value)
                with self.assertRaises(BUILDER.BuildError):
                    validate(value)

    def test_source_file_directory_and_output_symlinks_fail_without_donor_writes(self):
        repo = self.copied_source()
        packet = repo / BUILDER.CORPUS_ROOT / 'sources/ana-c2-coactivation.md'
        original = packet.read_bytes()
        donor = self.root / 'donor.md'
        donor.write_bytes(original)
        packet.unlink()
        packet.symlink_to(donor)
        try:
            with self.assertRaises(OSError):
                BUILDER.build(repo)
            self.assertEqual(donor.read_bytes(), original)
        finally:
            packet.unlink()
            packet.write_bytes(original)
        sources = packet.parent
        moved = sources.with_name('owned-source-fixture')
        sources.rename(moved)
        sources.symlink_to(moved, target_is_directory=True)
        try:
            with self.assertRaises(OSError):
                BUILDER.build(repo)
        finally:
            sources.unlink()
            moved.rename(sources)
        output_donor = self.root / 'output-donor'
        output_donor.mkdir()
        (repo / 'services/api/dist').symlink_to(output_donor, target_is_directory=True)
        with self.assertRaises(OSError):
            BUILDER.build(repo)
        self.assertEqual(list(output_donor.iterdir()), [])

    def test_existing_empty_wrong_extra_or_symlink_bundle_is_preserved(self):
        target = self.root / BUILDER.digest(SYNTHETIC_BUNDLE['projection.json'])
        target.mkdir()
        with self.assertRaises(BUILDER.BuildError):
            BUILDER.publish(self.root, SYNTHETIC_BUNDLE)
        self.assertEqual(list(target.iterdir()), [])
        for name, data in SYNTHETIC_BUNDLE.items():
            (target / name).write_bytes(data)
        (target / 'receipt.json').write_bytes(b'other invocation receipt')
        with self.assertRaises(BUILDER.BuildError):
            BUILDER.publish(self.root, SYNTHETIC_BUNDLE)
        self.assertEqual((target / 'receipt.json').read_bytes(), b'other invocation receipt')
        (target / 'receipt.json').write_bytes(SYNTHETIC_BUNDLE['receipt.json'])
        extra = target / 'other-owner-file'
        extra.write_bytes(b'preserve')
        with self.assertRaises(BUILDER.BuildError):
            BUILDER.publish(self.root, SYNTHETIC_BUNDLE)
        self.assertEqual(extra.read_bytes(), b'preserve')
        shutil.rmtree(target)
        target.symlink_to(self.root, target_is_directory=True)
        with self.assertRaises(OSError):
            BUILDER.publish(self.root, SYNTHETIC_BUNDLE)
        self.assertTrue(target.is_symlink())

    def test_matching_and_mismatching_publication_races_never_overwrite(self):
        native_rename = BUILDER.rename_exclusive
        for matching in (True, False):
            with self.subTest(matching=matching):
                parent = self.root / str(matching)
                parent.mkdir()
                def race(source, target):
                    target.mkdir()
                    for name, data in SYNTHETIC_BUNDLE.items():
                        (target / name).write_bytes(data if matching else b'other invocation')
                    native_rename(source, target)
                with mock.patch.object(BUILDER, 'rename_exclusive', side_effect=race):
                    if matching:
                        BUILDER.publish(parent, SYNTHETIC_BUNDLE)
                    else:
                        with self.assertRaises(BUILDER.BuildError):
                            BUILDER.publish(parent, SYNTHETIC_BUNDLE)
                target = parent / BUILDER.digest(SYNTHETIC_BUNDLE['projection.json'])
                self.assertEqual(set(parent.iterdir()), {target})
                self.assertEqual((target / 'projection.json').read_bytes(), SYNTHETIC_BUNDLE['projection.json'] if matching else b'other invocation')

    def test_write_rename_and_keyboard_failures_clean_only_owned_staging(self):
        sibling = self.root / '.form-coverage-build-sibling'
        sibling.mkdir()
        (sibling / 'keep').write_bytes(b'other invocation')
        for failure in (OSError('synthetic rename failure'), KeyboardInterrupt()):
            with self.subTest(failure=type(failure).__name__):
                with mock.patch.object(BUILDER, 'rename_exclusive', side_effect=failure):
                    with self.assertRaises(type(failure)):
                        BUILDER.publish(self.root, SYNTHETIC_BUNDLE)
                self.assertEqual(set(self.root.iterdir()), {sibling})
        native_open = Path.open
        def fail_receipt(path, *args, **kwargs):
            if path.name == 'receipt.json' and args == ('xb',):
                raise OSError('synthetic receipt write failure')
            return native_open(path, *args, **kwargs)
        with mock.patch.object(Path, 'open', autospec=True, side_effect=fail_receipt):
            with self.assertRaisesRegex(OSError, 'receipt write failure'):
                BUILDER.publish(self.root, SYNTHETIC_BUNDLE)
        self.assertEqual(set(self.root.iterdir()), {sibling})
        self.assertEqual((sibling / 'keep').read_bytes(), b'other invocation')

    def test_handled_sigterm_cleans_staging_and_returns_cancel_status(self):
        code = '''
import importlib.util, os, pathlib, signal, sys
spec = importlib.util.spec_from_file_location('builder', sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
def interrupt(source, target):
    os.kill(os.getpid(), signal.SIGTERM)
module.rename_exclusive = interrupt
module.build = lambda repo: module.publish(pathlib.Path(sys.argv[2]), {'projection.json': b'synthetic', 'receipt.json': b'synthetic'})
raise SystemExit(module.main())
'''
        result = subprocess.run([sys.executable, '-B', '-c', code, str(SCRIPT), str(self.root)], capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 128 + signal.SIGTERM, result.stderr.decode())
        self.assertIn(b'cancelled', result.stderr)
        self.assertEqual(list(self.root.iterdir()), [])

    def test_missing_no_replace_primitive_fails_without_fallback(self):
        with mock.patch.object(BUILDER.HELPERS.ctypes, 'CDLL', return_value=object()):
            with self.assertRaisesRegex(BUILDER.BuildError, 'renameat2 unavailable'):
                BUILDER.publish(self.root, SYNTHETIC_BUNDLE)
        self.assertEqual(list(self.root.iterdir()), [])


if __name__ == '__main__':
    unittest.main()
