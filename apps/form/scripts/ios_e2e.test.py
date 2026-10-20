"""Portable evidence and subprocess checks; native rendering needs the hosted run."""

import importlib.util
import json
import os
from pathlib import Path
import re
import signal
import struct
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
import zipfile
import zlib

spec = importlib.util.spec_from_file_location('ios_e2e', Path(__file__).with_name('ios_e2e.py'))
e2e = importlib.util.module_from_spec(spec)
spec.loader.exec_module(e2e)
REPO = Path(__file__).resolve().parents[3]


def png_bytes():
    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xffffffff)
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', 1, 1, 8, 6, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(b'\0\xff\0\0\xff')) + chunk(b'IEND', b''))


def atom(kind, data):
    return struct.pack('>I4s', 8 + len(data), kind) + data


class EvidenceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='ios-e2e-test-', dir=Path(__file__).parent)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def test_checksum_refuses_untrusted_archive_before_extract_or_execution(self):
        def download(url, path):
            path.write_bytes(b'untrusted download')
        with patch.object(e2e.zipfile, 'ZipFile') as extract, patch.object(e2e.subprocess, 'Popen') as execute:
            with self.assertRaisesRegex(ValueError, 'checksum'):
                e2e.install_maestro(self.root, download)
        extract.assert_not_called()
        execute.assert_not_called()
        self.assertFalse((self.root / 'maestro-cli').exists())

    def test_verified_archive_restores_launcher_permissions_and_rejects_traversal(self):
        def download(url, path):
            with zipfile.ZipFile(path, 'w') as package:
                package.writestr('maestro/bin/maestro', '#!/bin/sh\nexit 0\n')
        with patch.object(e2e, 'sha256', return_value=e2e.MAESTRO_SHA256):
            binary = e2e.install_maestro(self.root, download)
        self.assertTrue(os.access(binary, os.X_OK))
        other = self.root / 'other'
        other.mkdir()
        def unsafe(url, path):
            with zipfile.ZipFile(path, 'w') as package:
                package.writestr('../escape', 'bad')
        with patch.object(e2e, 'sha256', return_value=e2e.MAESTRO_SHA256), self.assertRaisesRegex(ValueError, 'unsafe'):
            e2e.install_maestro(other, unsafe)
        self.assertFalse((other / 'escape').exists())

    def report(self, names=None, extra='', status='PASSED'):
        names = e2e.FLOW_NAMES if names is None else names
        return '<testsuites><testsuite tests="' + str(len(names)) + '" failures="0">' + ''.join(
            '<testcase name="' + name + '" status="' + status + '">' + extra + '</testcase>' for name in names
        ) + '</testsuite></testsuites>'

    def test_junit_exact_seven_passes(self):
        report = self.root / 'junit.xml'
        report.write_text(self.report())
        self.assertEqual(e2e.validate_junit(report, e2e.FLOW_NAMES), e2e.FLOW_NAMES)

    def test_junit_missing_malformed_empty_skipped_wrong_name_duplicate_or_failure_refused(self):
        report = self.root / 'junit.xml'
        with self.assertRaises(FileNotFoundError):
            e2e.validate_junit(report, e2e.FLOW_NAMES)
        invalid = ['', '<broken', self.report([]), self.report(e2e.FLOW_NAMES[:-1]),
                   self.report(['wrong'] + e2e.FLOW_NAMES[1:]), self.report(e2e.FLOW_NAMES + [e2e.FLOW_NAMES[0]]),
                   self.report(extra='<skipped/>'), self.report(extra='<error/>'), self.report(extra='<failure/>'),
                   self.report(status='SKIPPED'), self.report(status='PENDING'),
                   self.report().replace('failures="0"', 'failures="1"'),
                   self.report().replace('tests="7"', 'tests="0"')]
        for text in invalid:
            with self.subTest(report=text[:80]):
                report.write_text(text)
                with self.assertRaises((ValueError, e2e.ET.ParseError)):
                    e2e.validate_junit(report, e2e.FLOW_NAMES)

    def test_png_requires_complete_crc_checked_decodable_image(self):
        path = self.root / 'journey.png'
        valid = png_bytes()
        path.write_bytes(valid)
        self.assertEqual(e2e.validate_png(path), {'width': 1, 'height': 1})
        for content in (b'', b'\x89PNG\r\n\x1a\n', valid[:-4], valid + b'trailing',
                        valid[:42] + bytes([valid[42] ^ 1]) + valid[43:]):
            with self.subTest(size=len(content)):
                path.write_bytes(content)
                with self.assertRaises(ValueError):
                    e2e.validate_png(path)

    def test_mp4_requires_finalized_atom_and_payload_not_moov_string(self):
        path = self.root / 'journeys.mp4'
        valid = atom(b'ftyp', b'isom0000') + atom(b'mdat', b'video') + atom(b'moov', b'metadata')
        path.write_bytes(valid)
        self.assertTrue(e2e.validate_mp4(path)['finalized'])
        for content in (b'', b'moov', atom(b'mdat', b'moov'), valid[:-3],
                        atom(b'ftyp', b'isom') + atom(b'mdat', b'video')):
            path.write_bytes(content)
            with self.assertRaises(ValueError):
                e2e.validate_mp4(path)

    def test_exact_device_and_report_paths_and_no_automatic_rerun(self):
        variables = {'E2E_EMAIL': 'fixture@synthetic.invalid', 'E2E_CONTROL_TOKEN': 'private-test-token'}
        command = e2e.maestro_command(Path('/owned/maestro'), 'owned-udid', Path('/owned/flows'), self.root, variables)
        self.assertEqual(command[:6], ['/owned/maestro', '--device', 'owned-udid', '--platform', 'ios', 'test'])
        for flag, value in [('--output', self.root / 'junit.xml'),
                            ('--test-output-dir', self.root / 'maestro-results'),
                            ('--debug-output', self.root / 'maestro-debug')]:
            self.assertEqual(command[command.index(flag) + 1], str(value))
        self.assertEqual(command[-1], '/owned/flows')
        self.assertNotIn('--retry', command)
        self.assertIn('E2E_CONTROL_TOKEN=private-test-token', command)

    def test_manifest_hashes_all_retained_evidence_after_token_redaction(self):
        token = 'ephemeral-test-token'
        (self.root / 'maestro.log').write_text('env token=' + token)
        (self.root / 'nested').mkdir()
        (self.root / 'nested/flow.png').write_bytes(png_bytes())
        e2e.redact_token(self.root, token)
        manifest = {'status': 'failed', 'source_sha': '1' * 40, 'mode': 'e2e'}
        with patch.dict(os.environ, {}, clear=True):
            e2e.write_evidence_manifest(self.root, manifest)
        self.assertNotIn(token, (self.root / 'maestro.log').read_text())
        saved = json.loads((self.root / 'manifest.json').read_text())
        self.assertEqual(set(saved['evidence_sha256']), {'maestro.log', 'nested/flow.png', 'summary.md'})
        for name, digest in saved['evidence_sha256'].items():
            self.assertEqual(e2e.sha256(self.root / name), digest)

    def test_original_failure_survives_cleanup_failure_and_success_does_not(self):
        children = e2e.Children(self.root, os.environ.copy(), self.root)
        manifest = {}
        failure = RuntimeError('original journey failure')
        with patch.object(children, 'stop', side_effect=RuntimeError('cleanup failure')):
            children.cleanup(manifest, failure)
        self.assertEqual(len(manifest['cleanup_errors']), 3)
        with patch.object(children, 'stop', side_effect=RuntimeError('cleanup failure')):
            with self.assertRaisesRegex(RuntimeError, 'cleanup failed'):
                children.cleanup({})

    def test_cancellation_cleanup_order_and_short_budgets(self):
        children = e2e.Children(self.root, {}, self.root)
        for sig in e2e.SIGNALS:
            previous = signal.getsignal(sig)
            self.addCleanup(signal.signal, sig, previous)
        with patch.object(children, 'stop') as stop:
            children.cleanup({}, SystemExit(143))
        self.assertEqual(stop.call_args_list, [unittest.mock.call('recorder', signal.SIGINT, 4),
                                             unittest.mock.call('maestro', signal.SIGTERM, 1.5),
                                             unittest.mock.call('backend', signal.SIGTERM, 1)])

    def test_timeout_error_does_not_expose_command_arguments(self):
        children = e2e.Children(self.root, os.environ.copy(), self.root)
        failure = None
        try:
            with self.assertRaises(TimeoutError) as caught:
                children.command('maestro', [sys.executable, '-c', 'import time; time.sleep(30)',
                                            'private-test-token'], timeout=0.1)
            failure = caught.exception
            self.assertNotIn('private-test-token', str(failure))
        finally:
            children.cleanup({}, failure)
        self.assertIsNotNone(children.processes['maestro'].poll())

    def test_real_process_success_failure_timeout_and_repeated_signal_cleanup(self):
        program = r'''
import importlib.util, os, pathlib, signal, sys, time
spec = importlib.util.spec_from_file_location('ci', sys.argv[1])
ci = importlib.util.module_from_spec(spec); spec.loader.exec_module(ci)
root, mode = pathlib.Path(sys.argv[2]), sys.argv[3]
events = root / 'events'
for sig in ci.e2e.SIGNALS: signal.signal(sig, ci.interrupted)
with ci.owned_scratch(root, {}) as scratch:
    (root / 'scratch').write_text(str(scratch))
    children = ci.e2e.Children(scratch, os.environ.copy(), root)
    error = None
    try:
        for name in ['recorder', 'maestro', 'backend']:
            code = "import os,pathlib,signal,sys,time\nroot=pathlib.Path(sys.argv[1]); name=sys.argv[2]\ndef stop(sig,frame):\n with (root/'events').open('a') as f: f.write(name+'\\n')\n if name=='recorder': time.sleep(.25)\n raise SystemExit(0)\nsignal.signal(signal.SIGINT,stop); signal.signal(signal.SIGTERM,stop)\n(root/(name+'-ready')).write_text(str(os.getpid()))\ntime.sleep(30)"
            children.start(name, [sys.executable, '-c', code, str(root), name])
            children.wait_ready(name, (root/(name+'-ready')).exists, 5)
        (root / 'ready').touch()
        if mode == 'failure': raise RuntimeError('original journey failure')
        if mode == 'timeout': raise TimeoutError('maestro timed out')
        if mode == 'signal': time.sleep(30)
    except BaseException as exc:
        error = exc
        raise
    finally:
        children.cleanup({}, error)
        with events.open('a') as stream: stream.write('simulator-delete\n')
'''
        for mode in ('success', 'failure', 'timeout', 'signal'):
            with self.subTest(mode=mode):
                root = self.root / mode
                root.mkdir()
                sibling = root / 'unowned'
                sibling.mkdir()
                with (root / 'parent.log').open('w') as log:
                    process = subprocess.Popen([sys.executable, '-c', program,
                        str(Path(__file__).with_name('ci-ios-simulator.py')), str(root), mode],
                        stdout=log, stderr=subprocess.STDOUT)
                    self.addCleanup(lambda p=process: p.kill() if p.poll() is None else None)
                    deadline = time.monotonic() + 8
                    while not (root / 'ready').exists() and process.poll() is None and time.monotonic() < deadline:
                        time.sleep(0.02)
                    self.assertTrue((root / 'ready').exists(), (root / 'parent.log').read_text())
                    if mode == 'signal':
                        process.send_signal(signal.SIGTERM)
                        deadline = time.monotonic() + 2
                        while not (root / 'events').exists() and time.monotonic() < deadline:
                            time.sleep(0.01)
                        process.send_signal(signal.SIGTERM)
                    status = process.wait(timeout=10)
                self.assertEqual(status, 0 if mode == 'success' else 143 if mode == 'signal' else 1,
                                 (root / 'parent.log').read_text())
                self.assertEqual((root / 'events').read_text().splitlines(),
                                 ['recorder', 'maestro', 'backend', 'simulator-delete'])
                self.assertFalse(Path((root / 'scratch').read_text()).exists())
                self.assertTrue(sibling.is_dir())
                for name in ('recorder', 'maestro', 'backend'):
                    with self.assertRaises(ProcessLookupError):
                        os.kill(int((root / (name + '-ready')).read_text()), 0)
                if mode == 'failure':
                    self.assertIn('original journey failure', (root / 'parent.log').read_text())


    def test_execute_orders_readiness_evidence_final_assertion_and_cleanup(self):
        from types import SimpleNamespace
        import shutil
        import io
        contract = e2e.load_contract(REPO / 'apps/form/e2e/journeys.json')
        tree = self.root / 'source'
        (tree / 'apps/form/e2e').mkdir(parents=True)
        (tree / 'apps/form/e2e/journeys.json').write_text(json.dumps(contract))
        (tree / 'services/api').mkdir(parents=True)
        for outcome in ('passed', 'failed', 'timeout'):
            with self.subTest(outcome=outcome):
                scratch = self.root / (outcome + '-scratch')
                output = self.root / (outcome + '-output')
                scratch.mkdir(); output.mkdir()
                events = []
                owner = self
                class FakeChildren:
                    def __init__(self, cwd, env, output):
                        owner.assertEqual(cwd, tree / 'services/api')
                        self.env = env
                    def command(self, name, command, timeout=60):
                        events.append(name)
                        if name == 'java-version': return 'openjdk version "17.0.1"'
                        if name == 'maestro-version': return '2.11.0\n'
                        if outcome == 'failed': raise RuntimeError('journey failed')
                        if outcome == 'timeout': raise TimeoutError('journey timed out')
                        (output / 'junit.xml').write_text(owner.report())
                        images = output / 'maestro-results'
                        images.mkdir()
                        for flow in e2e.FLOW_NAMES: (images / (flow + '.png')).write_bytes(png_bytes())
                    def start(self, name, command):
                        events.append(name)
                        if name == 'backend':
                            (scratch / 'backend-data').mkdir()
                            (scratch / 'backend-ready.json').write_text(json.dumps({
                                'origin': contract['api_origin'], 'control_url': 'http://127.0.0.1:47622'}))
                        else:
                            owner.assertIn('owned-device', command)
                            (output / 'recorder.log').write_text('Recording started')
                    def wait_ready(self, name, predicate, timeout):
                        owner.assertTrue(predicate())
                        events.append(name + '-ready')
                    def cleanup(self, manifest, error):
                        events.append('recorder-finalize')
                        events.append('backend-stop')
                        shutil.rmtree(scratch / 'backend-data')
                        (output / 'journeys.mp4').write_bytes(atom(b'ftyp', b'isom') + atom(b'mdat', b'data') + atom(b'moov', b'meta'))
                class Response(io.BytesIO):
                    status = 200
                def assert_final(request, timeout):
                    events.append('assert-final')
                    self.assertEqual(json.loads(request.data), contract['expected'])
                    self.assertEqual(request.full_url, 'http://127.0.0.1:47622/assert-final-state')
                    self.assertTrue(request.get_header('Authorization').startswith('Bearer '))
                    return Response(b'{"accepted":true}')
                manifest = {}
                with patch.object(e2e, 'Children', FakeChildren), \
                     patch.object(e2e, 'install_maestro', return_value=Path('/owned/maestro')), \
                     patch.object(e2e.urllib.request, 'urlopen', side_effect=assert_final):
                    if outcome == 'passed':
                        e2e.execute(tree=tree, scratch=scratch, output=output, device='owned-device', env={}, manifest=manifest)
                    else:
                        with self.assertRaisesRegex((RuntimeError, TimeoutError), 'journey'):
                            e2e.execute(tree=tree, scratch=scratch, output=output, device='owned-device', env={}, manifest=manifest)
                self.assertLess(events.index('backend-ready'), events.index('recorder'))
                self.assertLess(events.index('recorder-ready'), events.index('maestro'))
                self.assertEqual(events[-2:], ['recorder-finalize', 'backend-stop'])
                if outcome == 'passed':
                    self.assertEqual(manifest['journeys_passed'], e2e.FLOW_NAMES)
                    self.assertTrue(manifest['backend_root_removed'])
                    self.assertIn('assert-final', events)
                else:
                    self.assertNotIn('assert-final', events)
                    self.assertEqual(manifest['video_validation']['state'], 'valid')
                    self.assertNotIn('journeys_passed', manifest)


class JourneyContractTests(unittest.TestCase):
    def test_email_navigation_waits_for_capability_notice_to_clear_before_targeting_buttons(self):
        source = (REPO / 'apps/form/e2e/maestro/helpers/open-email.yaml').read_text()
        commands = re.split(r'^- ', source.split('\n---\n', 1)[1], flags=re.M)[1:]
        self.assertTrue(commands)
        readiness = commands[0]
        self.assertTrue(readiness.startswith('extendedWaitUntil:\n'),
                        'Wait for capability readiness before evaluating or tapping either email button')
        self.assertRegex(readiness, r'(?m)^    notVisible:\n      id: a-signin-error$')
        timeout = re.search(r'(?m)^    timeout: (\d+)$', readiness)
        self.assertIsNotNone(timeout, 'The readiness wait must fail within a bounded deadline')
        self.assertGreater(int(timeout.group(1)), 0)
        self.assertLessEqual(int(timeout.group(1)), 30000)
        self.assertNotRegex(readiness, r'(?m)^\s*(?:when|runFlow|tapOn):')
        for selector in ('a-signin-email', 'a-signin-email-link'):
            with self.subTest(selector=selector):
                branches = [command for command in commands[1:-1]
                            if re.search(r'(?m)^        id: ' + selector + r'$', command)]
                self.assertEqual(len(branches), 1, 'Retain both conditional email navigation paths')
                self.assertTrue(branches[0].startswith('runFlow:\n'))
                self.assertRegex(branches[0], r'when:\n      visible:\n        id: ' + selector + r'\n')
                self.assertRegex(branches[0], r'tapOn:\n          id: ' + selector + r'(?:\n|$)')
        self.assertTrue(commands[-1].startswith('extendedWaitUntil:\n'))
        self.assertRegex(commands[-1], r'(?m)^    visible:\n      id: screen-email$')
        self.assertRegex(commands[-1], r'(?m)^    timeout: 30000$')

    def test_single_contract_names_order_and_screenshots(self):
        contract = e2e.load_contract(REPO / 'apps/form/e2e/journeys.json')
        flows = REPO / 'apps/form/e2e/maestro'
        config = (flows / 'config.yaml').read_text()
        self.assertIn('continueOnFailure: false', config)
        self.assertEqual(re.findall(r'^    - (\S+)$', config, re.M), e2e.FLOW_NAMES)
        for flow in contract['flows']:
            source = (flows / (flow['name'] + '.yaml')).read_text()
            self.assertIn('\nname: ' + flow['name'] + '\n', source)
            self.assertIn('\n- takeScreenshot: ' + flow['screenshot'] + '\n', source)
            self.assertRegex(source, r'assertVisible:|assertNotVisible:|extendedWaitUntil:')

    def test_flow_selectors_have_current_source_declarations(self):
        source_root = REPO / 'apps/form/src'
        source = '\n'.join(path.read_text() for path in source_root.rglob('*.tsx')
                           if '__tests__' not in path.parts)
        flows = '\n'.join(path.read_text() for path in (REPO / 'apps/form/e2e/maestro').rglob('*.yaml'))
        selectors = set(re.findall(r'^\s+id: ["\']?([^\n"\']+)', flows, re.M))
        dynamic = {
            'a-goal-1': '`a-goal-${i}`', 'a-exp-new': "`a-exp-${e.value === 'returning' ? 'some' : e.value}`",
            'a-area-knee': '`a-area-${a.key}`', 'a-style-direct': '`a-style-${c.id}`',
            'a-days-3': '`a-days-${d}`', 'a-minutes-35': '`a-minutes-${m}`',
            'a-equipment-dumbbells': '`a-equipment-${e.key}`',
            'a-history-.+': '`a-history-${session.id}`',
            'a-start-plan-.+': '`a-start-plan-${p.id}`',
            'a-mode-advanced': '`a-mode-${mode}`', 'a-mode-basic': '`a-mode-${mode}`',
            'a-setlog-1': '`a-setlog-${set.setNumber}`', 'a-setlog-2': '`a-setlog-${set.setNumber}`',
            'body-construct-stature': '`body-construct-${id}`',
            'body-by-self': '`body-by-${by}`', 'body-tool-tape': '`body-tool-${tool}`',
            'body-added-stature:none': '`body-added-${m.id}`', 'body-added-.+': '`body-added-${m.id}`',
            'body-result-stature:none': '`body-result-${m.id}`', 'body-result-.+': '`body-result-${m.id}`',
        }
        for selector in selectors:
            with self.subTest(selector=selector):
                if selector in dynamic:
                    self.assertTrue(dynamic[selector] in source, 'missing renderer for ' + selector)
                elif selector.startswith('screen-onboarding-'):
                    self.assertTrue('`screen-onboarding-${screen}`' in source, 'onboarding screen ID renderer drift')
                    self.assertTrue("'" + selector.removeprefix('screen-onboarding-') + "'" in source, "unknown onboarding screen " + selector)
                elif selector.endswith('-input'):
                    self.assertTrue('`${testID}-input`' in source, 'TextAnswer input ID drift')
                    self.assertTrue('"' + selector.removesuffix('-input') + '"' in source, 'missing input wrapper ' + selector)
                elif selector.startswith('body-check-'):
                    self.assertTrue('`body-check-${id}`' in source, 'body checklist renderer drift')
                    model = (source_root / 'body').rglob('*.ts')
                    self.assertTrue(selector.removeprefix('body-check-') in '\n'.join(p.read_text() for p in model), 'body checklist key drift: ' + selector)
                elif selector == 'screen-(today|sign-in)':
                    self.assertTrue('screen-today' in source, 'today screen missing')
                    self.assertTrue('screen-sign-in' in source, 'sign-in screen missing')
                else:
                    self.assertTrue(any(quote + selector + quote in source for quote in ('"', "'")), 'literal selector drift: ' + selector)
        onboarding = (source_root / 'features/onboarding/model.ts').read_text()
        self.assertRegex(onboarding, r'MINUTES\s*=\s*\[[^\]]*35')
        self.assertNotIn('id: a-minutes-30', flows)
        self.assertNotIn('id: a-tab-', flows)
        self.assertIn('text: "Native E2E plan,.*"', flows)
        body = '\n'.join(path.read_text() for path in source_root.rglob('*')
                         if path.suffix in ('.ts', '.tsx') and '__tests__' not in path.parts)
        for fragment in ('body-check-', 'body-construct-', 'body-added-', 'body-result-', 'a-setlog-'):
            self.assertTrue(fragment in body, 'missing dynamic family: ' + fragment)


if __name__ == '__main__':
    unittest.main()
