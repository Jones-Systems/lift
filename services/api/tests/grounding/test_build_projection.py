"""Bounded build checks; every copied input and output lives in one test-owned workspace root."""
import hashlib
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
SCRIPT = REPO / 'services/api/scripts/grounding/build-projection.py'
SPEC = importlib.util.spec_from_file_location('grounding_build_under_test', SCRIPT)
BUILDER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BUILDER)


class BuildProjectionTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='.artifact-build-test-', dir=HERE)
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)

    def copied_source(self):
        repo = self.root / 'repository'
        manifest = json.loads((REPO / 'sources/manifest.json').read_bytes())
        paths = ['sources/manifest.json'] + [entry['destination'] for entry in manifest['files']
            if entry['group'] == 'BL-CORE' and (entry['source_path'] == 'scripts/form_corpus.py'
                or entry['source_path'] == BUILDER.CORPUS_ROOT + '/coverage.md'
                or entry['source_path'].startswith(BUILDER.CORPUS_ROOT + '/sources/')
                and '/' not in entry['source_path'][len(BUILDER.CORPUS_ROOT + '/sources/'):]
                and entry['source_path'].endswith('.md'))]
        self.assertEqual(len(paths), 100)
        for path in paths:
            target = repo / path
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(REPO / path, target)
        return repo

    def test_two_real_builds_are_byte_identical_and_reuse_exact_bundle(self):
        first = BUILDER.render(REPO)
        second = BUILDER.render(REPO)
        self.assertEqual(first, second)
        target = BUILDER.publish(self.root, first)
        self.assertEqual(BUILDER.publish(self.root, second), target)
        self.assertEqual(set(self.root.iterdir()), {target})
        for name, data in first.items():
            self.assertEqual((target / name).read_bytes(), data)
        corpus = json.loads(first['projection.json'])
        self.assertEqual(len(first['projection.json']), 1488603)
        self.assertEqual(hashlib.sha256(first['projection.json']).hexdigest(), BUILDER.OUTPUT_SHA)
        self.assertEqual((len(corpus['inputs']), len(corpus['records']), len(corpus['coverage']['units'])), (98, 838, 106))
        packet = (REPO / BUILDER.RETAINED_ROOT / BUILDER.CORPUS_ROOT / 'sources/achilles-appraisal.md').read_text()
        record = json.loads(packet.split('```json\n')[1].split('\n```')[0])
        selected = next(entry for entry in corpus['records'] if entry['record']['id'] == 'ACH-S01')
        self.assertEqual(selected['record'], record)
        self.assertEqual(selected['line'], 5)
        self.assertEqual(selected['source_path'], 'sources/achilles-appraisal.md')
        receipt = json.loads(first['receipt.json'])
        self.assertEqual(receipt['repository'], 'Jones-Systems/BusinessLessons')
        self.assertEqual(receipt['revision'], BUILDER.REVISION)
        self.assertEqual(receipt['manifest_sha256'], BUILDER.MANIFEST_SHA)
        self.assertEqual(receipt['projector']['git_blob'], BUILDER.PROJECTOR_BLOB)
        self.assertNotEqual(receipt['historical_source_repository'], receipt['repository'])
        self.assertEqual(receipt['corpus_input_sha256'], corpus['corpus_input_sha256'])

    def test_script_manifest_packet_omission_and_addition_fail_before_publication(self):
        repo = self.copied_source()
        corpus = repo / BUILDER.RETAINED_ROOT / BUILDER.CORPUS_ROOT
        packet = corpus / 'sources/achilles-appraisal.md'
        for path in [repo / BUILDER.PROJECTOR_PATH, repo / 'sources/manifest.json', packet]:
            with self.subTest(tampered=path.name):
                original = path.read_bytes()
                try:
                    path.write_bytes(original + b'\n')
                    with self.assertRaises(BUILDER.BuildError):
                        BUILDER.build(repo)
                    self.assertFalse((repo / 'services/api/dist').exists())
                finally:
                    path.write_bytes(original)
        original = packet.read_bytes()
        packet.unlink()
        try:
            with self.assertRaises(FileNotFoundError):
                BUILDER.build(repo)
        finally:
            packet.write_bytes(original)
        extra = corpus / 'sources/synthetic-extra.md'
        extra.write_text('Synthetic unsupported extra packet.\n')
        with self.assertRaises(BUILDER.BuildError):
            BUILDER.build(repo)
        self.assertFalse((repo / 'services/api/dist').exists())

    def test_retained_symlinks_fail_and_output_symlink_does_not_write_to_donor(self):
        repo = self.copied_source()
        packet = repo / BUILDER.RETAINED_ROOT / BUILDER.CORPUS_ROOT / 'sources/achilles-appraisal.md'
        original = packet.read_bytes()
        donor = self.root / 'donor-packet.md'
        donor.write_bytes(original)
        packet.unlink()
        packet.symlink_to(donor)
        with self.assertRaises(OSError):
            BUILDER.build(repo)
        packet.unlink()
        packet.write_bytes(original)
        donor_dir = self.root / 'donor-output'
        donor_dir.mkdir()
        api = repo / 'services/api'
        api.mkdir(parents=True)
        (api / 'dist').symlink_to(donor_dir, target_is_directory=True)
        with self.assertRaises(OSError):
            BUILDER.build(repo)
        self.assertEqual(list(donor_dir.iterdir()), [])

    def test_existing_empty_mismatched_or_symlink_bundle_is_preserved(self):
        files = {'projection.json': b'synthetic projection', 'receipt.json': b'synthetic receipt'}
        target = self.root / BUILDER.OUTPUT_SHA
        target.mkdir()
        with self.assertRaises(BUILDER.BuildError):
            BUILDER.publish(self.root, files)
        self.assertEqual(list(target.iterdir()), [])
        (target / 'projection.json').write_bytes(b'other owner bytes')
        (target / 'receipt.json').write_bytes(files['receipt.json'])
        with self.assertRaises(BUILDER.BuildError):
            BUILDER.publish(self.root, files)
        self.assertEqual((target / 'projection.json').read_bytes(), b'other owner bytes')
        shutil.rmtree(target)
        target.symlink_to(self.root, target_is_directory=True)
        with self.assertRaises(OSError):
            BUILDER.publish(self.root, files)
        self.assertTrue(target.is_symlink())

    def test_failure_and_keyboard_cancel_remove_only_owned_staging(self):
        files = {'projection.json': b'synthetic projection', 'receipt.json': b'synthetic receipt'}
        sibling = self.root / '.grounding-build-sibling'
        sibling.mkdir()
        (sibling / 'keep').write_text('Other invocation synthetic sentinel')
        for failure in (OSError('synthetic publication failure'), KeyboardInterrupt()):
            with self.subTest(failure=type(failure).__name__):
                with mock.patch.object(BUILDER, 'rename_exclusive', side_effect=failure):
                    with self.assertRaises(type(failure)):
                        BUILDER.publish(self.root, files)
                self.assertEqual(set(self.root.iterdir()), {sibling})
                self.assertTrue((sibling / 'keep').is_file())

    def test_racing_destination_is_never_overwritten(self):
        files = {'projection.json': b'synthetic projection', 'receipt.json': b'synthetic receipt'}
        native_rename = BUILDER.rename_exclusive
        for matching in (True, False):
            with self.subTest(matching=matching):
                parent = self.root / str(matching)
                parent.mkdir()
                def race(source, target):
                    target.mkdir()
                    for name, data in files.items():
                        (target / name).write_bytes(data if matching else b'other invocation')
                    native_rename(source, target)
                with mock.patch.object(BUILDER, 'rename_exclusive', side_effect=race):
                    if matching:
                        BUILDER.publish(parent, files)
                    else:
                        with self.assertRaises(BUILDER.BuildError):
                            BUILDER.publish(parent, files)
                self.assertEqual(set(parent.iterdir()), {parent / BUILDER.OUTPUT_SHA})
                self.assertEqual((parent / BUILDER.OUTPUT_SHA / 'projection.json').read_bytes(), files['projection.json'] if matching else b'other invocation')

    def test_handled_sigterm_cleans_owned_staging_and_preserves_cancel_status(self):
        code = '''
import importlib.util, os, pathlib, signal, sys
spec = importlib.util.spec_from_file_location('builder', sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
signal.signal(signal.SIGTERM, module.cancel)
def interrupt(source, target):
    os.kill(os.getpid(), signal.SIGTERM)
module.rename_exclusive = interrupt
try:
    module.publish(pathlib.Path(sys.argv[2]), {'projection.json': b'synthetic', 'receipt.json': b'synthetic'})
except module.BuildCancelled as exc:
    raise SystemExit(128 + exc.signum)
'''
        result = subprocess.run([sys.executable, '-B', '-c', code, str(SCRIPT), str(self.root)], capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 128 + signal.SIGTERM, result.stderr.decode())
        self.assertEqual(list(self.root.iterdir()), [])

    def test_unavailable_atomic_primitive_fails_without_fallback(self):
        files = {'projection.json': b'synthetic projection', 'receipt.json': b'synthetic receipt'}
        with mock.patch.object(BUILDER.ctypes, 'CDLL', return_value=object()):
            with self.assertRaisesRegex(BUILDER.BuildError, 'renameat2 unavailable'):
                BUILDER.publish(self.root, files)
        self.assertEqual(list(self.root.iterdir()), [])


if __name__ == '__main__':
    unittest.main()
