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

    def report(self, names=None, extra='', status='SUCCESS'):
        names = e2e.FLOW_NAMES if names is None else names
        return '<testsuites><testsuite tests="' + str(len(names)) + '" failures="0">' + ''.join(
            '<testcase name="' + name + '" status="' + status + '">' + extra + '</testcase>' for name in names
        ) + '</testsuite></testsuites>'

    def test_junit_accepts_the_hosted_maestro_success_report(self):
        # Run 39670865743 passed all seven journeys; Maestro 2.11.0 wrote status="SUCCESS".
        # Preserve that report shape with the current journey names and count.
        report = self.root / 'junit.xml'
        report.write_text('<?xml version=\'1.0\' encoding=\'UTF-8\'?>\n<testsuites>\n  <testsuite name="Test Suite" '
                          f'device="Form-CI - iOS 27.0" tests="{len(e2e.FLOW_NAMES)}" failures="0" time="978.288">\n' + ''.join(
                              '    <testcase id="' + name + '" name="' + name + '" classname="' + name + '" file="/flows/'
                              + name + '.yaml" time="1.0" status="SUCCESS"/>\n' for name in e2e.FLOW_NAMES)
                          + '  </testsuite>\n</testsuites>\n')
        self.assertEqual(e2e.validate_junit(report, e2e.FLOW_NAMES), e2e.FLOW_NAMES)

    def test_journey_screenshot_is_the_one_flattened_debug_capture(self):
        flow = {'name': '07-body-session-only', 'screenshot': '07-body-session-only'}
        debug = self.root / 'maestro-debug' / flow['name'] / 'takeScreenshot'
        debug.mkdir(parents=True)
        (debug / '07-body-session-only-results.png').write_bytes(png_bytes())
        with self.assertRaisesRegex(RuntimeError, 'expected one screenshot'):
            e2e.journey_screenshot(self.root, flow)
        (debug / '07-body-session-only.png').write_bytes(png_bytes())
        self.assertEqual(e2e.journey_screenshot(self.root, flow), debug / '07-body-session-only.png')
        copy = self.root / 'maestro-results'
        copy.mkdir()
        (copy / '07-body-session-only.png').write_bytes(png_bytes())
        with self.assertRaisesRegex(RuntimeError, 'expected one screenshot'):
            e2e.journey_screenshot(self.root, flow)

    def test_junit_missing_malformed_empty_skipped_wrong_name_duplicate_or_failure_refused(self):
        report = self.root / 'junit.xml'
        with self.assertRaises(FileNotFoundError):
            e2e.validate_junit(report, e2e.FLOW_NAMES)
        invalid = ['', '<broken', self.report([]), self.report(e2e.FLOW_NAMES[:-1]),
                   self.report(['wrong'] + e2e.FLOW_NAMES[1:]), self.report(e2e.FLOW_NAMES + [e2e.FLOW_NAMES[0]]),
                   self.report(extra='<skipped/>'), self.report(extra='<error/>'), self.report(extra='<failure/>'),
                   self.report(status='SKIPPED'), self.report(status='PENDING'), self.report(status='PASSED'),
                   self.report(status='success'), self.report(status='WARNING'), self.report(status='ERROR'),
                   self.report(status='CANCELED'), self.report(status='STOPPED'),
                   self.report().replace(' status="SUCCESS"', ''),
                   self.report().replace('failures="0"', 'failures="1"'),
                   self.report().replace(f'tests="{len(e2e.FLOW_NAMES)}"', 'tests="0"')]
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


    def diagnostic_fixture(self):
        from types import SimpleNamespace
        home = self.root / 'java17'
        (home / 'bin').mkdir(parents=True)
        for name in ('java', 'jcmd'):
            (home / 'bin' / name).touch()
        (home / 'release').write_text('JAVA_VERSION="17.0.1"\n')
        children = e2e.Children(self.root, {'JAVA_HOME': str(home),
                                'JAVA_TOOL_OPTIONS': '-Djava.io.tmpdir=' + str(self.root)}, self.root)
        process = SimpleNamespace(pid=12345, poll=lambda: None,
                                  wait=unittest.mock.Mock(side_effect=subprocess.TimeoutExpired('hidden', 60)))
        children.processes['maestro-version'] = process
        return children, process, home

    def test_version_timeout_retains_hashable_sanitized_diagnostic_without_changing_failure_or_deadline(self):
        children, process, home = self.diagnostic_fixture()
        raw = (b'"secret-thread-name" arbitrary properties private-test-token\n'
               b'   java.lang.Thread.State: WAITING (parking)\n'
               b'\tat java.base@17.0.1/java.lang.Thread.sleep(Native Method)\n'
               b'\tat maestro.cli.Main.main(Main.kt:12)\n'
               b'  - locked <secret-address>\n' + b'x' * 800)
        captures = [('complete', f'12345 12345 S {home}/bin/java\n'.encode()), ('complete', raw)]
        with patch.object(children, 'start', return_value=process), \
             patch.object(e2e.os, 'getpgid', return_value=12345), \
             patch.object(e2e, 'diagnostic_capture', side_effect=captures, create=True) as capture:
            with self.assertRaisesRegex(TimeoutError, '^maestro-version timed out$'):
                children.command('maestro-version', ['/owned/maestro', '--version'])
        self.assertTrue((self.root / 'maestro-version-diagnostic.json').is_file(), 'timeout diagnostic must be retained')
        process.wait.assert_called_once_with(timeout=60)
        self.assertEqual(capture.call_args_list[0].args[0], ['/bin/ps', '-p', '12345', '-o', 'pid=,pgid=,state=,comm='])
        self.assertEqual(capture.call_args_list[1].args[0], [str(home / 'bin/jcmd'), '12345', 'Thread.print'])
        self.assertLessEqual(capture.call_args_list[1].args[3] - capture.call_args_list[0].args[3], 4)
        path = self.root / 'maestro-version-diagnostic.json'
        text = path.read_text()
        self.assertNotIn('secret', text)
        self.assertNotIn('private-test-token', text)
        self.assertNotIn(str(home), text)
        self.assertEqual(len(json.loads(text)['load_average']), 3)
        self.assertEqual(json.loads(text)['cpu_count'], os.cpu_count())
        self.assertEqual(json.loads(text)['frames'], ['java.lang.Thread.State: WAITING',
                         'at java.base@17.0.1/java.lang.Thread.sleep(Native Method)',
                         'at maestro.cli.Main.main(Main.kt:12)'])
        manifest = {'status': 'failed', 'source_sha': '1' * 40}
        with patch.dict(os.environ, {}, clear=True):
            e2e.write_evidence_manifest(self.root, manifest)
        self.assertEqual(manifest['evidence_sha256'][path.name], e2e.sha256(path))

    def test_diagnostic_never_attaches_without_owned_selected_java_leader(self):
        children, process, home = self.diagnostic_fixture()
        for kind in ('foreign_group', 'exited', 'replaced_owner', 'shell', 'missing_tool', 'wrong_java', 'changed_group'):
            with self.subTest(kind=kind):
                children.processes['maestro-version'] = process
                process.poll = lambda: 0 if kind == 'exited' else None
                if kind == 'replaced_owner': children.processes['maestro-version'] = object()
                if kind == 'missing_tool': (home / 'bin/jcmd').unlink()
                executable = '/bin/sh' if kind == 'shell' else '/other/java' if kind == 'wrong_java' else str(home / 'bin/java')
                groups = [999] if kind == 'foreign_group' else [12345, 999] if kind == 'changed_group' else [12345, 12345]
                with patch.object(e2e.os, 'getpgid', side_effect=groups), \
                     patch.object(e2e, 'diagnostic_capture', return_value=('complete', f'12345 12345 S {executable}'.encode())) as capture:
                    children.maestro_timeout_diagnostic(process)
                self.assertLessEqual(capture.call_count, 1)
                (home / 'bin/jcmd').touch()

    def test_missing_failed_or_hung_probe_preserves_timeout_and_cancellation_propagates(self):
        children, process, home = self.diagnostic_fixture()
        for outcome in ('unavailable', 'failed', 'timed_out', 'output_limit'):
            with self.subTest(outcome=outcome), patch.object(children, 'start', return_value=process), \
                 patch.object(e2e.os, 'getpgid', return_value=12345), \
                 patch.object(e2e, 'diagnostic_capture', return_value=(outcome, b'private-test-token')):
                with self.assertRaisesRegex(TimeoutError, '^maestro-version timed out$'):
                    children.command('maestro-version', ['secret-argument'])
                self.assertNotIn('private-test-token', (self.root / 'maestro-version-diagnostic.json').read_text())
        for cancellation in (KeyboardInterrupt(), SystemExit(143)):
            with patch.object(children, 'start', return_value=process), \
                 patch.object(e2e.os, 'getpgid', side_effect=cancellation):
                with self.assertRaises(type(cancellation)) as caught:
                    children.command('maestro-version', ['secret-argument'])
            self.assertIs(caught.exception, cancellation)
            self.assertEqual(json.loads((self.root / 'maestro-version-diagnostic.json').read_text())['state'], 'interrupted')
            with patch.object(children, 'start', return_value=process), \
                 patch.object(e2e.os, 'getpgid', side_effect=ProcessLookupError), \
                 patch.object(Path, 'write_text', side_effect=cancellation):
                with self.assertRaises(type(cancellation)) as caught:
                    children.command('maestro-version', ['secret-argument'])
            self.assertIs(caught.exception, cancellation)
        with patch.object(children, 'start', return_value=process), \
             patch.object(e2e.os, 'getpgid', side_effect=ProcessLookupError), \
             patch.object(Path, 'write_text', side_effect=OSError):
            with self.assertRaisesRegex(TimeoutError, '^maestro-version timed out$'):
                children.command('maestro-version', ['secret-argument'])

    def test_other_commands_and_successful_version_do_not_probe(self):
        children, process, _ = self.diagnostic_fixture()
        with patch.object(children, 'start', return_value=process), patch.object(children, 'maestro_timeout_diagnostic') as diagnostic:
            with self.assertRaises(TimeoutError): children.command('other', ['hidden'])
            diagnostic.assert_not_called()
            process.wait.side_effect = None
            process.wait.return_value = 0
            (self.root / 'maestro-version.log').write_text('2.11.0\n')
            with patch.object(children, 'stop'):
                self.assertEqual(children.command('maestro-version', ['hidden']), '2.11.0\n')
            diagnostic.assert_not_called()
        self.assertEqual(list(children.durations), ['maestro-version'])
        self.assertGreaterEqual(children.durations['maestro-version'], 0)

    def test_probe_capture_bounds_output_time_and_reaps_owned_children(self):
        processes = []
        original = subprocess.Popen
        def launch(*args, **kwargs):
            child = original(*args, **kwargs)
            processes.append(child)
            return child
        with patch.object(e2e.subprocess, 'Popen', side_effect=launch):
            state, raw = e2e.diagnostic_capture([sys.executable, '-c', 'import os; os.write(1,b"x"*10000)'],
                                              self.root, {}, time.monotonic() + 2, limit=100)
            self.assertEqual((state, len(raw)), ('output_limit', 100))
            start = time.monotonic()
            state, _ = e2e.diagnostic_capture([sys.executable, '-c', 'import time; time.sleep(30)'],
                                            self.root, {}, start + 0.1)
            self.assertEqual(state, 'timed_out')
            self.assertLess(time.monotonic() - start, 1.5)
        self.assertTrue(all(child.poll() is not None for child in processes))
        self.assertEqual(list(self.root.iterdir()), [])

    def test_expired_probe_budget_starts_nothing_and_frame_retention_is_bounded(self):
        with patch.object(e2e.subprocess, 'Popen') as launch:
            self.assertEqual(e2e.diagnostic_capture(['not-run'], self.root, {}, time.monotonic() - 1),
                             ('timed_out', b''))
            launch.assert_not_called()
        raw = b'at java.lang.Thread.sleep(Native Method)\n' * 1000
        self.assertEqual(len(e2e.sanitized_thread_frames(raw)), 256)

    def test_host_settle_is_bounded_records_samples_and_never_fails(self):
        cpus = os.cpu_count() or 1
        def run(loads):
            now, sleeps = [0.0], []
            def sleep(seconds):
                sleeps.append(seconds)
                now[0] += seconds
            with patch.object(e2e.os, 'getloadavg', side_effect=[(value, 0, 0) for value in loads]):
                return e2e.settle_host(sleep=sleep, clock=lambda: now[0]), sleeps
        result, sleeps = run([cpus + 3, cpus + 1, cpus - 0.5])
        self.assertEqual((result['settled'], result['seconds'], len(result['samples'])), (True, 10.0, 3))
        self.assertEqual(sleeps, [e2e.HOST_SETTLE_INTERVAL] * 2)
        steps = e2e.HOST_SETTLE_SECONDS // e2e.HOST_SETTLE_INTERVAL
        result, sleeps = run([cpus * 4] * (steps + 1))
        self.assertFalse(result['settled'])
        self.assertEqual(result['seconds'], e2e.HOST_SETTLE_SECONDS)
        self.assertEqual(len(sleeps), steps)
        self.assertLessEqual(len(result['samples']), 60)
        with patch.object(e2e.os, 'getloadavg', side_effect=OSError):
            result = e2e.settle_host(sleep=self.fail, clock=lambda: 0.0)
        self.assertEqual((result['settled'], result['samples']), (False, [[0.0, None]]))

    def test_group_signal_tolerates_darwin_eperm_only_after_leader_exit(self):
        import errno
        processes = []
        original, real_killpg = subprocess.Popen, os.killpg
        def launch(*args, **kwargs):
            child = original(*args, **kwargs)
            processes.append(child)
            return child
        def darwin_killpg(pid, signum):
            # Darwin rejects signalling a group whose members have all exited.
            real_killpg(pid, signal.SIGKILL)
            next(child for child in processes if child.pid == pid).wait()
            raise PermissionError(errno.EPERM, 'Operation not permitted')
        with patch.object(e2e.subprocess, 'Popen', side_effect=launch), \
             patch.object(e2e.os, 'killpg', side_effect=darwin_killpg), \
             patch.object(e2e.selectors, 'DefaultSelector') as selector:
            selector.return_value.__enter__.return_value.select.side_effect = SystemExit(143)
            with self.assertRaises(SystemExit) as caught:
                e2e.diagnostic_capture([sys.executable, '-c', 'import time; time.sleep(30)'],
                                       self.root, {}, time.monotonic() + 2)
        self.assertEqual(caught.exception.code, 143)
        self.assertTrue(all(child.poll() is not None for child in processes))
        live = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'], start_new_session=True)
        self.addCleanup(live.wait)
        self.addCleanup(live.kill)
        with patch.object(e2e.os, 'killpg', side_effect=PermissionError(errno.EPERM, 'Operation not permitted')):
            with self.assertRaises(PermissionError):
                e2e.signal_group(live, signal.SIGTERM)

    def test_probe_capture_cancellation_reaps_probe_and_keeps_maestro_cleanup_owned(self):
        from types import SimpleNamespace
        processes = []
        original = subprocess.Popen
        def launch(*args, **kwargs):
            child = original(*args, **kwargs)
            processes.append(child)
            return child
        # Freeze the driver clock so slow hosted process launches cannot expire the
        # probe budget before the injected cancellation is reached.
        frozen = SimpleNamespace(monotonic=lambda: 0.0, sleep=time.sleep)
        for cancellation in (KeyboardInterrupt(), SystemExit(143)):
            with patch.object(e2e, 'time', frozen), \
                 patch.object(e2e.subprocess, 'Popen', side_effect=launch), \
                 patch.object(e2e.selectors, 'DefaultSelector') as selector:
                selector.return_value.__enter__.return_value.select.side_effect = cancellation
                with self.assertRaises(type(cancellation)) as caught:
                    e2e.diagnostic_capture([sys.executable, '-c', 'import time; time.sleep(30)'],
                                           self.root, {}, 2)
            self.assertIs(caught.exception, cancellation)
        self.assertTrue(all(child.poll() is not None for child in processes))
        children = e2e.Children(self.root, {}, self.root)
        child = children.start('maestro-version', [sys.executable, '-c', 'import time; time.sleep(30)'])
        for sig in e2e.SIGNALS:
            self.addCleanup(signal.signal, sig, signal.getsignal(sig))
        with patch.object(children, 'stop', wraps=children.stop) as stop:
            children.cleanup({}, SystemExit(143))
        self.assertIn(unittest.mock.call('maestro-version', signal.SIGTERM, 0.2), stop.call_args_list)
        self.assertIsNotNone(child.poll())

        program = r'''
import importlib.util, pathlib, sys, time, types
from unittest.mock import patch
spec = importlib.util.spec_from_file_location('e2e', sys.argv[1])
e2e = importlib.util.module_from_spec(spec); spec.loader.exec_module(e2e)
root = pathlib.Path(sys.argv[2])
children = e2e.Children(root, {}, root)
error = None
try:
    # The frozen driver clock keeps the ps probe budget open on slow runners;
    # subprocess.wait still uses the real clock, so the version timeout fires.
    with patch.object(e2e, 'time', types.SimpleNamespace(monotonic=lambda: 0.0, sleep=time.sleep)), \
         patch.object(e2e.selectors, 'DefaultSelector') as selector:
        selector.return_value.__enter__.return_value.select.side_effect = SystemExit(143)
        children.command('maestro-version', [sys.executable, '-c', 'import time; time.sleep(30)'], timeout=.01)
except BaseException as exc:
    error = exc
    raise
finally:
    children.cleanup({}, error)
    assert all(p.poll() is not None for p in children.processes.values())
'''
        completed = subprocess.run([sys.executable, '-B', '-c', program,
                                    str(Path(__file__).with_name('ios_e2e.py')), str(self.root)],
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=5)
        self.assertEqual(completed.returncode, 143, completed.stderr.decode())
        self.assertEqual(json.loads((self.root / 'maestro-version-diagnostic.json').read_text())['state'], 'interrupted')

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
                        self.durations = {'java-version': 0.5}
                    def command(self, name, command, timeout=60):
                        events.append(name)
                        if name == 'java-version': return 'openjdk version "17.0.1"'
                        if name == 'maestro-version': return '2.11.0\n'
                        if outcome == 'failed': raise RuntimeError('journey failed')
                        if outcome == 'timeout': raise TimeoutError('journey timed out')
                        (output / 'junit.xml').write_text(owner.report())
                        for flow in e2e.FLOW_NAMES:
                            images = output / 'maestro-debug' / flow / 'takeScreenshot'
                            images.mkdir(parents=True)
                            (images / (flow + '.png')).write_bytes(png_bytes())
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
                     patch.object(e2e, 'settle_host', side_effect=lambda: events.append('settle') or {'settled': True}), \
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
                self.assertEqual(manifest['startup_seconds'], {'java-version': 0.5})
                self.assertEqual(events[:2], ['settle', 'java-version'])
                self.assertEqual(manifest['host_settle'], {'settled': True})
                self.assertIn('load_at_finish', manifest)
                if outcome == 'passed':
                    self.assertEqual(manifest['journeys_passed'], e2e.FLOW_NAMES)
                    self.assertEqual(sorted(manifest['journey_screenshots']), sorted(
                        'maestro-debug/' + flow + '/takeScreenshot/' + flow + '.png' for flow in e2e.FLOW_NAMES))
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
        self.assertEqual(re.findall(r'^  - "([^"]+)\.yaml"$', config, re.M), e2e.FLOW_NAMES)
        self.assertEqual(sorted(path.stem for path in flows.glob('*.yaml') if path.name != 'config.yaml'),
                         sorted(e2e.FLOW_NAMES))
        for flow in contract['flows']:
            source = (flows / (flow['name'] + '.yaml')).read_text()
            self.assertIn('\nname: ' + flow['name'] + '\n', source)
            self.assertIn('\n- takeScreenshot: ' + flow['screenshot'] + '\n', source)
            self.assertRegex(source, r'assertVisible:|assertNotVisible:|extendedWaitUntil:')

    def test_pressable_row_values_are_asserted_through_their_merged_row_text(self):
        # A Pressable AccountRow is one accessibility element: "label, [detail, ]value".
        flows = '\n'.join(path.read_text() for path in (REPO / 'apps/form/e2e/maestro').rglob('*.yaml'))
        self.assertNotIn('assertVisible: "${E2E_EXPECTED_NAME}"', flows)
        self.assertNotIn('assertVisible: "170.0 cm"', flows)
        self.assertEqual(flows.count('text: "Name, ${E2E_EXPECTED_NAME}"'), 2)
        self.assertIn("text: 'Standing height, 170\\.0 cm'", flows)
        self.assertIn("text: 'Standing height, .*, 170\\.0 cm'", flows)
        settings = (REPO / 'apps/form/src/settings/SettingsScreen.tsx').read_text()
        self.assertIn('<AccountRow label="Name" value={profile.name} testID="a-row-name" onPress=', settings)
        self.assertIn("label: 'Standing height'", (REPO / 'apps/form/src/body/session.ts').read_text())
        row = (REPO / 'apps/form/src/features/shared/ui.tsx').read_text()
        self.assertRegex(row, r'\{label\}</Txt>\s*\{detail \?[^\n]*\n[^\n]*\n\s*\{value \?')

    def test_body_footer_screens_centre_scroll_targets_clear_of_the_footer(self):
        # Run 39658529514 tapped a footer-covered checklist row through to body-protocol-enter.
        for name in ('body-setup.yaml', 'body-measurement.yaml'):
            text = (REPO / 'apps/form/e2e/maestro/helpers' / name).read_text()
            with self.subTest(helper=name):
                self.assertGreater(text.count('scrollUntilVisible:'), 0)
                self.assertEqual(text.count('scrollUntilVisible:'), text.count('centerElement: true'))
                self.assertNotIn('centerElement: false', text)

    def test_body_value_keyboard_is_dismissed_and_proved_gone_before_commit(self):
        # Run 39664906828: hideKeyboard left the decimal pad up and the commit tap typed a 0.
        text = (REPO / 'apps/form/e2e/maestro/helpers/body-measurement.yaml').read_text()
        self.assertNotIn('- hideKeyboard', text)
        steps = [text.index(step) for step in (
            'inputText: "170"', "tapOn: 'Who measured\\?'", 'notVisible: "Delete"', 'id: body-measure-commit')]
        self.assertEqual(steps, sorted(steps))
        self.assertIn("measuredBy: 'Who measured?'", (REPO / 'apps/form/src/body/copy.ts').read_text())
        self.assertIn('keyboardType="decimal-pad"', (REPO / 'apps/form/src/body/BodyFlow.tsx').read_text())

    def test_today_rows_below_the_plan_are_reached_only_after_the_plan_loads(self):
        # Run 39677396386 attempt 2 tapped a-entry-body before the plan loaded and hit Start.
        settled = (REPO / 'apps/form/e2e/maestro/helpers/today-settled.yaml').read_text()
        self.assertIn('      id: a-today-primary\n      text: "Start"\n', settled)
        reached = 0
        for path in sorted((REPO / 'apps/form/e2e/maestro').glob('0*.yaml')):
            lines = path.read_text().splitlines()
            for index, line in enumerate(lines):
                if line in ('      id: a-entry-body', '      id: a-today-primary') and lines[index - 2] == '- scrollUntilVisible:':
                    reached += 1
                    with self.subTest(flow=path.name, line=index + 1):
                        self.assertEqual(lines[index - 3], '- runFlow: helpers/today-settled.yaml')
        self.assertEqual(reached, 5)
        today = (REPO / 'apps/form/src/features/training/screens.tsx').read_text()
        self.assertIn('<PrimaryAction label="Start" captureId="a-today-primary" onPress={onStart} />', today)
        self.assertIn('<PrimaryAction label="Create a plan" icon="plus" captureId="a-today-primary"', today)

    def test_session_only_clearing_checks_match_values_inside_merged_rows(self):
        # A bare full-text "170.0 cm" never matches a merged row, so its absence proves nothing.
        text = (REPO / 'apps/form/e2e/maestro/07-body-session-only.yaml').read_text()
        self.assertNotIn('assertNotVisible: "170.0 cm"', text)
        self.assertEqual(text.count("assertNotVisible: '.*170\\.0 cm.*'"), 3)

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
            'a-unit-load-${E2E_EXPECTED_LOAD_UNIT}': '`${testID}-${item.value}`',
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


class ShardTests(unittest.TestCase):
    setUp = EvidenceTests.setUp
    report = EvidenceTests.report

    def test_exact_layouts_refuse_duplicates_unknown_empty_order_and_wrong_replay_tax(self):
        expected = {1: [[0,1,2,3,4]], 2: [[0,4],[0,1,2,3]],
                    3: [[0,4],[0,2],[0,1,3]], 4: [[0,4],[0,2],[0,1],[0,3]]}
        for count, layout in expected.items():
            parts = [[e2e.FLOW_NAMES[i] for i in part] for part in layout]
            self.assertEqual(e2e.shard_partitions(count), parts)
            self.assertEqual(e2e.shard_matrix(count), {'include': [
                {'index': index, 'partition': ','.join(part)} for index, part in enumerate(parts)]})
            self.assertEqual(sum(part.count(e2e.FLOW_NAMES[0]) for part in parts), count)
        for names in ([], [e2e.FLOW_NAMES[1]], [e2e.FLOW_NAMES[0], 'unknown'],
                      [e2e.FLOW_NAMES[0]] * 2, [e2e.FLOW_NAMES[i] for i in (0,3,2)]):
            with self.assertRaises(ValueError): e2e.validate_partition(names)
        for count in (0, 5, True, '2'):
            with self.assertRaises(ValueError): e2e.shard_partitions(count)
        for parts in ([[e2e.FLOW_NAMES[0]]], [e2e.FLOW_NAMES, e2e.FLOW_NAMES], []):
            with self.assertRaises(ValueError): e2e.validate_coverage(parts)

    def test_partition_execution_keeps_real_account_setup_helpers_evidence_and_full_only_assertion(self):
        import io
        import shutil
        contract = e2e.load_contract(REPO / 'apps/form/e2e/journeys.json')
        tree = self.root / 'source'
        shutil.copytree(REPO / 'apps/form/e2e', tree / 'apps/form/e2e')
        (tree / 'services/api').mkdir(parents=True)
        for count, index in ((1,0), (4,0), (4,1), (4,2), (4,3)):
            names = e2e.shard_partitions(count)[index]
            scratch = self.root / f'scratch-{count}-{index}'
            output = self.root / f'output-{count}-{index}'
            scratch.mkdir(); output.mkdir()
            events, owner = [], self
            class FakeChildren:
                def __init__(self, *args): self.durations = {}
                def command(self, name, command, timeout=60):
                    events.append(name)
                    if name == 'java-version': return 'openjdk version "17.0.1"'
                    if name == 'maestro-version': return '2.11.0\n'
                    selected = Path(command[-1])
                    owner.assertEqual([path.stem for path in sorted(selected.glob('*.yaml'))], names)
                    for flow in names:
                        owner.assertEqual((selected / (flow + '.yaml')).read_bytes(),
                                          (tree / 'apps/form/e2e/maestro' / (flow + '.yaml')).read_bytes())
                    owner.assertEqual((selected / 'helpers/revoke-sessions.js').read_bytes(),
                                      (tree / 'apps/form/e2e/maestro/helpers/revoke-sessions.js').read_bytes())
                    owner.assertEqual(timeout, 1200)
                    (output / 'junit.xml').write_text(owner.report(names))
                    for flow in names:
                        images = output / 'maestro-debug' / flow / 'takeScreenshot'
                        images.mkdir(parents=True)
                        (images / (flow + '.png')).write_bytes(png_bytes())
                def start(self, name, command):
                    events.append(name)
                    if name == 'backend':
                        (scratch / 'backend-data').mkdir()
                        (scratch / 'backend-ready.json').write_text(json.dumps({
                            'origin': contract['api_origin'], 'control_url': 'http://127.0.0.1:47622'}))
                    else: (output / 'recorder.log').write_text('Recording started')
                def wait_ready(self, name, predicate, timeout): owner.assertTrue(predicate())
                def cleanup(self, manifest, error):
                    events.append('cleanup')
                    shutil.rmtree(scratch / 'backend-data')
                    (output / 'journeys.mp4').write_bytes(atom(b'ftyp', b'isom') + atom(b'mdat', b'data') + atom(b'moov', b'meta'))
            class Response(io.BytesIO): status = 200
            def final_state(request, timeout):
                events.append('final-state')
                self.assertEqual(json.loads(request.data), contract['expected'])
                return Response(b'{"accepted":true}')
            manifest = {}
            with patch.object(e2e, 'Children', FakeChildren), patch.object(e2e, 'settle_host'), \
                 patch.object(e2e, 'install_maestro', return_value=Path('/owned/maestro')), \
                 patch.object(e2e.urllib.request, 'urlopen', side_effect=final_state):
                e2e.execute(tree=tree, scratch=scratch, output=output, device='owned-device',
                            env={}, manifest=manifest, partition=names)
            self.assertEqual(manifest['journeys_passed'], names)
            self.assertEqual(manifest['aggregate_assertion'], 'passed' if count == 1 else 'partition-not-applicable')
            self.assertEqual('final-state' in events, count == 1)
            self.assertEqual('backend_final_state' in manifest, count == 1)
            self.assertTrue(manifest['timing_only'])
            self.assertFalse(manifest['authenticated_acceptance'])
            self.assertTrue(manifest['backend_root_removed'])
            self.assertEqual(manifest['video_validation']['state'], 'valid')
            self.assertEqual(len(manifest['journey_screenshots']), len(names))

    def aggregate_fixture(self, count):
        root = self.root / ('artifacts-' + str(count))
        root.mkdir()
        proof = dict(schema='lift.e2e-shard-app/v1', source_sha='a' * 40, run_id='123', run_attempt='1',
                     mode='e2e', api_url='http://127.0.0.1:47621')
        proof.update({name + '_sha256': str(index) * 64 for index, name in enumerate(
            ('archive', 'executable', 'embedded_js', 'der', 'xml', 'info'))})
        for index, names in enumerate(e2e.shard_partitions(count)):
            output = root / ('lift-s6-consumer-123-1-' + str(index))
            output.mkdir()
            (output / 'junit.xml').write_text(self.report(names))
            for flow in names:
                images = output / 'maestro-debug' / flow / 'takeScreenshot'
                images.mkdir(parents=True)
                (images / (flow + '.png')).write_bytes(png_bytes())
            (output / 'journeys.mp4').write_bytes(atom(b'ftyp', b'isom') + atom(b'mdat', b'data') + atom(b'moov', b'meta'))
            manifest = dict(schema='form-ios-simulator/v1', source_sha=proof['source_sha'], mode='e2e',
                            operation='consume', status='passed', timing_only=True, authenticated_acceptance=False,
                            partition=names, partition_index=index, shard_count=count,
                            producer_proof=proof, app_artifact_id='456', app_artifact_digest='d' * 64,
                            scratch_removed=True, backend_root_removed=True, signing_verified=True,
                            app_integrity_verified=True,
                            run_id='123', run_attempt='1', journeys_passed=names,
                            aggregate_assertion='passed' if count == 1 else 'partition-not-applicable')
            if count == 1: manifest['backend_final_state'] = {'accepted': True}
            with patch.dict(os.environ, GITHUB_STEP_SUMMARY=''):
                e2e.write_evidence_manifest(output, manifest)
        return root, proof

    def aggregate(self, root, proof, count, **kwargs):
        with patch.dict(os.environ, GITHUB_RUN_ID='123', GITHUB_RUN_ATTEMPT='1'):
            return e2e.aggregate_shards(root, count=count, proof=proof, artifact_id='456',
                                        artifact_digest='d' * 64, consumer_result=kwargs.get('result', 'success'))

    def test_aggregate_exact_junit_union_identity_outcomes_and_complete_evidence(self):
        for count in range(1, 5):
            root, proof = self.aggregate_fixture(count)
            result = self.aggregate(root, proof, count)
            self.assertEqual(result['status'], 'passed')
            self.assertTrue(result['timing_only'])
            self.assertFalse(result['combined_state_qualification'])
            self.assertEqual(result['account_setup_replays'], count - 1)
            with self.assertRaisesRegex(ValueError, 'every matrix'): self.aggregate(root, proof, count, result='failure')
            path = root / 'lift-s6-consumer-123-1-0/manifest.json'
            original = json.loads(path.read_text())
            for key, value in [('source_sha', 'b' * 40), ('run_attempt', '2'), ('partition_index', 9),
                               ('producer_proof', {}), ('status', 'failed'), ('scratch_removed', False),
                               ('aggregate_assertion', 'wrong'), ('app_artifact_id', '999'),
                               ('authenticated_acceptance', True), ('cleanup_errors', ['failure']),
                               ('journeys_passed', [e2e.FLOW_NAMES[0]])]:
                path.write_text(json.dumps(dict(original, **{key: value})))
                with self.subTest(count=count, key=key), self.assertRaises(ValueError): self.aggregate(root, proof, count)
            path.write_text(json.dumps(original))
            junit = path.parent / 'junit.xml'
            junit.write_text(self.report([e2e.FLOW_NAMES[0]]))
            with self.assertRaises(ValueError): self.aggregate(root, proof, count)
            junit.write_text(self.report(e2e.shard_partitions(count)[0]))
            (path.parent / 'journeys.mp4').unlink()
            with self.assertRaises(ValueError): self.aggregate(root, proof, count)

    def test_aggregate_refuses_omitted_extra_and_stale_artifacts(self):
        root, proof = self.aggregate_fixture(2)
        other = root / 'lift-s6-consumer-123-1-1'
        moved = self.root / 'omitted'
        other.rename(moved)
        with self.assertRaisesRegex(ValueError, 'artifact'): self.aggregate(root, proof, 2)
        moved.rename(other)
        (root / 'stale-attempt').mkdir()
        with self.assertRaisesRegex(ValueError, 'artifact'): self.aggregate(root, proof, 2)
        with self.assertRaises(ValueError):
            self.aggregate(root, dict(proof, run_attempt='2'), 2)

    def test_aggregate_validates_subset_order_png_and_mp4_beyond_inventory_hashes(self):
        import copy
        root, proof = self.aggregate_fixture(2)
        output = root / 'lift-s6-consumer-123-1-1'
        manifest_path = output / 'manifest.json'
        original = json.loads(manifest_path.read_text())
        names = e2e.shard_partitions(2)[1]
        jpeg = output / 'maestro-debug' / names[0] / 'takeScreenshot' / (names[0] + '.png')
        for path, contents in [(output / 'junit.xml', self.report(names[:1]).encode()),
                               (output / 'junit.xml', self.report(list(reversed(names))).encode()),
                               (output / 'junit.xml', self.report(names, status='SKIPPED').encode()),
                               (jpeg, b'invalid PNG'), (output / 'journeys.mp4', b'not an MP4')]:
            before = path.read_bytes()
            path.write_bytes(contents)
            manifest = copy.deepcopy(original)
            manifest['evidence_sha256'][str(path.relative_to(output))] = e2e.sha256(path)
            manifest_path.write_text(json.dumps(manifest))
            with self.subTest(file=path.name, contents=contents[:60]), self.assertRaises(ValueError):
                self.aggregate(root, proof, 2)
            path.write_bytes(before)
        manifest_path.write_text(json.dumps(original))
        self.assertEqual(self.aggregate(root, proof, 2)['status'], 'passed')

    def test_experiment_workflow_keeps_pins_same_run_ids_guards_and_original_full_command(self):
        workflow = (REPO / '.github/workflows/lift-ios-e2e.yml').read_text()
        original = workflow.split('\n  shard-producer:', 1)[0]
        self.assertIn('run: python3 tooling/apps/form/scripts/ci-ios-simulator.py --mode e2e --source source --output evidence --scratch-parent "$GITHUB_WORKSPACE" --sha "$SOURCE_SHA"', original)
        self.assertIn("  schedule:\n    - cron: '0 5 * * *'\n      timezone: 'America/New_York'\n", workflow)
        self.assertEqual(workflow.count('actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333'), 2)
        consumer = workflow.split('\n  shard-consumer:', 1)[1].split('\n  shard-aggregate:', 1)[0]
        self.assertIn('artifact-ids: ${{ needs.shard-producer.outputs.artifact-id }}', consumer)
        self.assertIn('digest-mismatch: error', consumer)
        self.assertNotIn('run-id:', consumer)
        self.assertNotIn('github-token:', workflow)
        self.assertIn('fail-fast: false', consumer)
        self.assertIn('matrix: ${{ fromJSON(needs.shard-producer.outputs.matrix) }}', consumer)
        self.assertIn('CONSUMER_RESULT: ${{ needs.shard-consumer.result }}', workflow)
        self.assertIn('needs: [shard-producer, shard-consumer]', workflow)
        self.assertIn('if: always() && github.event_name', workflow)
        self.assertNotRegex(workflow, r'run:.*\$\{\{')
        self.assertNotIn('<<:', workflow)

    def test_dispatch_routes_default_to_original_and_experiments_only_to_producer(self):
        workflow = (REPO / '.github/workflows/lift-ios-e2e.yml').read_text()
        native_guard = re.search(r'^    if: (.+)$', workflow, re.MULTILINE).group(1)
        producer_guard = re.search(r'^    if: (.+)$', workflow.split('\n  shard-producer:', 1)[1], re.MULTILINE).group(1)
        script = r'''
const vm = require('node:vm');
const {nativeGuard, producerGuard} = JSON.parse(require('node:fs').readFileSync(0, 'utf8'));
const project = expression => expression.replaceAll(
  'github.event.pull_request.labels.*.name', 'github.event.pull_request.labels.map(label => label.name)');
const result = [];
for (const count of ['0','1','2','3','4']) {
  const inputs = {shard_count:count};
  const github = {event_name:'workflow_dispatch', event:{inputs}};
  result.push([vm.runInNewContext(project(nativeGuard),{github,inputs}),
    vm.runInNewContext(project(producerGuard),{github,inputs})]);
}
process.stdout.write(JSON.stringify(result));
'''
        result = subprocess.run(['node', '-e', script], input=json.dumps(
            {'nativeGuard': native_guard, 'producerGuard': producer_guard}),
            text=True, capture_output=True, timeout=10, check=True)
        self.assertEqual(json.loads(result.stdout), [[True,False]] + [[False,True]] * 4)


if __name__ == '__main__':
    unittest.main()
