"""Portable lifecycle checks; native compilation is qualified by the hosted job."""

import importlib.util
from contextlib import redirect_stdout
import io
import json
import os
import plistlib
from pathlib import Path
import signal
import struct
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('simulator_ci', Path(__file__).with_name('ci-ios-simulator.py'))
ci = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ci)


EXPECTED_ENTITLEMENTS = {'application-identifier': 'com.jonessystems.form.private',
                         'keychain-access-groups': ['com.jonessystems.form.private']}
APP_INFO = {'CFBundleIdentifier': 'com.jonessystems.form.private',
            'CFBundleExecutable': 'Form', 'CFBundleSupportedPlatforms': ['iPhoneSimulator']}


# Native encoder output from hosted run 39348122865, source ecd1206a66443549f767858f44405b8619cf16f4.
# SHA256: 0c9973f433b0fe892339ce464e83373309d8467e2b8385f620d4b0c5fc787737
NATIVE_DER = bytes.fromhex(
    '7079020101b07430370c166170706c69636174696f6e2d6964656e7469666965720c1d'
    '636f6d2e6a6f6e657373797374656d732e666f726d2e7072697661746530390c166b65'
    '79636861696e2d6163636573732d67726f757073301f0c1d636f6d2e6a6f6e657373'
    '797374656d732e666f726d2e70726976617465')


def fake_derq(command):
    if (len(command) != 9 or command[:5] != ['/usr/bin/derq', 'query', '-f', 'xml', '-i'] or
            command[6] != '-o' or command[8] != '--raw'):
        raise subprocess.CalledProcessError(65, command, stderr='InvalidArguments')
    source = Path(command[5]).read_bytes()
    if plistlib.loads(source) != EXPECTED_ENTITLEMENTS:
        raise ValueError('Unexpected encoder input')
    Path(command[7]).write_bytes(NATIVE_DER)


def macho_fixture(xml=None, der=None, *, slots=(0,), flags=0x20002, segment=b'__TEXT'):
    sections = [(b'__entitlements', xml), (b'__ents_der', der)]
    sections = [(name, data) for name, data in sections if data is not None]
    segment_size = 72 + 80 * len(sections)
    payload_offset = 32 + segment_size + 16
    payload = b''
    section_commands = b''
    for name, data in sections:
        section_commands += struct.pack('<16s16sQQIIIIIIII', name, segment, 0, len(data),
                                        payload_offset + len(payload), 0, 0, 0, 0, 0, 0, 0)
        payload += data
    blob_offset = 12 + 8 * len(slots)
    index, blobs = b'', b''
    for slot in slots:
        blob = struct.pack('>IIII', 0xfade0c02 if slot == 0 else 0xfade7171, 16, 0x20400, flags)
        index += struct.pack('>II', slot, blob_offset + len(blobs))
        blobs += blob
    signature = struct.pack('>III', 0xfade0cc0, blob_offset + len(blobs), len(slots)) + index + blobs
    header = struct.pack('<IIIIIIII', 0xfeedfacf, 0x100000c, 0, 2, 2, segment_size + 16, 0, 0)
    segment_command = struct.pack('<II16sQQQQIIII', 0x19, segment_size, segment, 0, 0, 0, 0,
                                  0, 0, len(sections), 0) + section_commands
    signature_command = struct.pack('<IIII', 0x1d, 16, payload_offset + len(payload), len(signature))
    return header + segment_command + signature_command + payload + signature


class LifecycleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='form-ci-test-', dir=Path(__file__).parent)
        self.addCleanup(self.temp.cleanup)
        self.parent = Path(self.temp.name)

    def test_success_preserves_evidence_and_separate_invocation(self):
        first, second = {}, {}
        evidence = self.parent / 'retained.log'
        with ci.owned_scratch(self.parent, first) as a:
            with ci.owned_scratch(self.parent, second) as b:
                self.assertNotEqual(a, b)
                (b / 'owned').write_text('second')
                ci.run([sys.executable, '-c', 'print("proof")'], cwd=a,
                       env=os.environ.copy(), log=evidence)
            self.assertFalse(b.exists())
            self.assertTrue(a.exists())
        self.assertFalse(a.exists())
        self.assertIn('proof', evidence.read_text())

    def test_failure_status_and_log_survive_scratch_cleanup(self):
        manifest = {}
        log = self.parent / 'failed.log'
        with self.assertRaises(subprocess.CalledProcessError) as error:
            with ci.owned_scratch(self.parent, manifest) as scratch:
                ci.run([sys.executable, '-c', 'print("failure proof"); raise SystemExit(23)'],
                       cwd=scratch, env=os.environ.copy(), log=log)
        self.assertEqual(error.exception.returncode, 23)
        self.assertFalse(Path(manifest['scratch_root']).exists())
        self.assertIn('failure proof', log.read_text())

    def test_cleanup_failure_preserves_original_error(self):
        manifest = {}
        with patch.object(ci.shutil, 'rmtree', side_effect=OSError('cleanup denied')):
            with self.assertRaisesRegex(ValueError, 'original'):
                with ci.owned_scratch(self.parent, manifest):
                    raise ValueError('original')
        self.assertEqual(manifest['cleanup_errors'], ['cleanup denied'])

    def test_cleanup_failure_fails_success(self):
        manifest = {}
        with patch.object(ci.shutil, 'rmtree', side_effect=OSError('cleanup denied')):
            with self.assertRaisesRegex(OSError, 'cleanup denied'):
                with ci.owned_scratch(self.parent, manifest):
                    pass

    def test_diagnostics_retain_early_error_and_bounded_tail(self):
        log = self.parent / 'compiler.log'
        log.write_text('early error: compiler rejected source\n' +
                       ''.join('line-' + str(i) + ' ' + 'x' * 2000 + '\n' for i in range(300)))
        output = io.StringIO()
        with redirect_stdout(output):
            ci.print_failure_log(log)
        text = output.getvalue()
        self.assertIn('early error: compiler rejected source', text)
        self.assertIn('line-299 ', text)
        self.assertNotIn('line-100 ', text)
        self.assertLess(len(text), 82000)

    def test_signal_removes_only_owned_scratch_and_stops_child(self):
        program = '''
import importlib.util, os, pathlib, signal, sys
spec = importlib.util.spec_from_file_location('ci', sys.argv[1])
ci = importlib.util.module_from_spec(spec); spec.loader.exec_module(ci)
signal.signal(signal.SIGTERM, ci.interrupted)
parent = pathlib.Path(sys.argv[2])
with ci.owned_scratch(parent, {}) as scratch:
    (parent / 'root').write_text(str(scratch))
    child = "import os,pathlib,time; pathlib.Path(" + repr(str(parent / 'pid')) + ").write_text(str(os.getpid())); time.sleep(30)"
    ci.run([sys.executable, '-c', child], cwd=scratch, env=os.environ.copy(), log=parent / 'signal.log')
'''
        process = subprocess.Popen([sys.executable, '-c', program, str(Path(ci.__file__).resolve()), str(self.parent)])
        self.addCleanup(lambda: process.kill() if process.poll() is None else None)
        import time
        deadline = time.monotonic() + 5
        while not (self.parent / 'pid').exists() and time.monotonic() < deadline:
            time.sleep(0.02)
        self.assertTrue((self.parent / 'pid').exists())
        pid = int((self.parent / 'pid').read_text())
        process.send_signal(signal.SIGTERM)
        self.assertEqual(process.wait(timeout=15), 143)
        self.assertFalse(Path((self.parent / 'root').read_text()).exists())
        with self.assertRaises(ProcessLookupError):
            os.kill(pid, 0)
        self.assertTrue((self.parent / 'signal.log').exists())

    def test_diagnostic_nonzero_status_does_not_raise(self):
        manifest = {}
        with redirect_stdout(io.StringIO()):
            status = ci.diagnostic([sys.executable, '-c', 'print("probe failed"); raise SystemExit(7)'],
                                   cwd=self.parent, env=os.environ.copy(), output=self.parent,
                                   manifest=manifest, name='probe')
        self.assertEqual(status, 7)
        self.assertEqual(manifest['launch_diagnostics']['probe']['returncode'], 7)
        self.assertIn('probe failed', (self.parent / 'probe.log').read_text())

    def test_timeout_terminates_child_and_records_unknown_probe(self):
        pidfile = self.parent / 'timeout-pid'
        command = [sys.executable, '-c',
                   'import os,pathlib,time; pathlib.Path(' + repr(str(pidfile)) +
                   ').write_text(str(os.getpid())); time.sleep(30)']
        with self.assertRaises(subprocess.TimeoutExpired):
            ci.run(command, cwd=self.parent, env=os.environ.copy(),
                   log=self.parent / 'timeout.log', timeout=0.5)
        with self.assertRaises(ProcessLookupError):
            os.kill(int(pidfile.read_text()), 0)
        manifest = {}
        with patch.object(ci, 'run', side_effect=subprocess.TimeoutExpired(command, 30)):
            self.assertIsNone(ci.diagnostic(command, cwd=self.parent, env={}, output=self.parent,
                                            manifest=manifest, name='unavailable'))
        self.assertIn('error', manifest['launch_diagnostics']['unavailable'])

    def test_crash_identity_freshness_and_bounded_summary(self):
        bundle = 'com.jonessystems.form.private'
        report = {'pid': 123, 'exception': {'type': 'EXC_CRASH'},
                  'termination': {'namespace': 'SIGNAL'}, 'faultingThread': 0,
                  'threads': [{'frames': [{'symbol': 'fatal', 'imageIndex': 0}] * 20}],
                  'usedImages': [{'name': 'Form'}]}
        content = json.dumps({'bundleID': bundle}) + '\n' + json.dumps(report)
        self.assertIsNotNone(ci.matching_crash_report(content, bundle, '123'))
        self.assertIsNone(ci.matching_crash_report(content, bundle, '124'))
        self.assertIsNone(ci.matching_crash_report(content, 'other.app', '123'))
        summary = ci.crash_summary(report)
        self.assertEqual(len(summary['faulting_frames']), 15)
        self.assertEqual(summary['faulting_frames'][0]['image'], 'Form')
        reports = self.parent / 'reports'
        reports.mkdir()
        (reports / 'Form-current.ips').write_text(content)
        (reports / 'Form-other.ips').write_text(content.replace('123', '124'))
        (reports / 'Form-partial.ips').write_text('{')
        stale = reports / 'Form-stale.ips'
        stale.write_text(content)
        os.utime(stale, (1, 1))
        (reports / 'Form-link.ips').symlink_to(reports / 'Form-current.ips')
        manifest = {}
        printed = io.StringIO()
        with redirect_stdout(printed):
            ci.collect_crashes(reports, since=2, bundle_id=bundle, pid='123',
                               output=self.parent, manifest=manifest)
        self.assertEqual(manifest['matching_crash_reports'], ['Form-current.ips'])
        self.assertEqual((self.parent / 'crash-Form-current.ips').read_text(), content)
        self.assertFalse((self.parent / 'crash-Form-other.ips').exists())
        self.assertIn('EXC_CRASH', printed.getvalue())
        self.assertIn('SIGNAL', printed.getvalue())

    def test_screenshot_and_diagnostics_do_not_turn_dead_process_into_pass(self):
        calls = []
        def probe(command, *, name, **kwargs):
            calls.append(name)
            if name == 'screenshot':
                Path(command[-1]).write_bytes(b'\x89PNG\r\n\x1a\nimage fixture')
                return 0
            if name == 'processes':
                (self.parent / 'processes.log').write_text('-\t-6\tUIKitApplication:com.jonessystems.form.private\n')
                return 0
            return 1
        manifest = {}
        with patch.object(ci, 'diagnostic', side_effect=probe), patch.object(ci, 'collect_crashes') as crashes:
            with redirect_stdout(io.StringIO()), self.assertRaisesRegex(RuntimeError, 'process.*unverified'):
                ci.check_launch(device='own-device', bundle_id='com.jonessystems.form.private', pid='123',
                                launch_epoch=1, built=self.parent / 'Form.app', cwd=self.parent,
                                env={}, output=self.parent, manifest=manifest)
        self.assertEqual(calls[0], 'screenshot')
        self.assertIn('screenshot_sha256', manifest)
        self.assertIn('app-startup', calls)
        self.assertIn('app-signature', calls)
        self.assertEqual(crashes.call_count, 1)
        self.assertNotEqual(manifest.get('status'), 'passed')

    def test_live_exact_process_and_png_survive_unavailable_launchctl(self):
        def probe(command, *, name, **kwargs):
            if name == 'screenshot':
                Path(command[-1]).write_bytes(b'\x89PNG\r\n\x1a\nimage fixture')
                return 0
            if name == 'app-process':
                (self.parent / 'app-process.log').write_text(
                    '123 Ss 01:29 /runner/Library/Developer/CoreSimulator/Devices/own-device/'
                    'data/Containers/Bundle/Application/install-id/Form.app/Form\n')
                return 0
            return None
        manifest = {}
        with patch.object(ci, 'diagnostic', side_effect=probe), patch.object(ci, 'collect_crashes'):
            ci.check_launch(device='own-device', bundle_id='com.jonessystems.form.private', pid='123',
                            launch_epoch=1, built=self.parent / 'Form.app', cwd=self.parent,
                            env={}, output=self.parent, manifest=manifest)
        self.assertEqual(manifest['app_process']['state'], 'alive')
        self.assertIn('screenshot_sha256', manifest)

    def test_launchctl_row_cannot_replace_unverified_process_identity(self):
        def probe(command, *, name, **kwargs):
            if name == 'screenshot':
                Path(command[-1]).write_bytes(b'\x89PNG\r\n\x1a\nimage fixture')
                return 0
            if name == 'processes':
                (self.parent / 'processes.log').write_text(
                    '123 0 UIKitApplication:com.jonessystems.form.private\n')
                return 0
            if name == 'app-process':
                (self.parent / 'app-process.log').write_text('malformed process evidence\n')
                return 0
            return None
        with patch.object(ci, 'diagnostic', side_effect=probe), patch.object(ci, 'collect_crashes'):
            with self.assertRaisesRegex(RuntimeError, 'process.*unverified'):
                ci.check_launch(device='own-device', bundle_id='com.jonessystems.form.private', pid='123',
                                launch_epoch=1, built=self.parent / 'Form.app', cwd=self.parent,
                                env={}, output=self.parent, manifest={})

    def test_process_evidence_requires_same_pid_device_executable_and_survival(self):
        command = '/runner/Devices/own-device/data/Containers/Bundle/Application/id/Form.app/Form'
        def state(row, returncode=0):
            return ci.app_process_evidence(row, returncode=returncode, device='own-device',
                                           pid='123', built=self.parent / 'Form.app')['state']
        self.assertEqual(state('123 Ss 00:15 ' + command), 'alive')
        self.assertEqual(state('123 Ss 1-02:03:04 ' + command), 'alive')
        self.assertEqual(state('123 Z 00:15 ' + command), 'dead')
        for row, status in [('', 0), ('malformed', 0),
                            ('123 Ss 00:14 ' + command, 0),
                            ('124 Ss 00:15 ' + command, 0),
                            ('123 Ss 00:15 ' + command.replace('own-device', 'other-device'), 0),
                            ('123 Ss 00:15 ' + command.replace('Form.app/Form', 'Other.app/Other'), 0),
                            ('123 Ss invalid ' + command, 0),
                            ('123 Ss 00:15 ' + command, None)]:
            with self.subTest(row=row, status=status):
                self.assertEqual(state(row, status), 'unknown')

    def test_screenshot_timeout_then_valid_second_capture(self):
        def probe(command, *, name, timeout, **kwargs):
            self.assertEqual(timeout, 60)
            path = Path(command[-1])
            if name == 'screenshot':
                path.write_bytes(b'partial')
                return None
            path.write_bytes(b'\x89PNG\r\n\x1a\nsecond image fixture')
            return 0
        manifest = {}
        with patch.object(ci, 'diagnostic', side_effect=probe) as calls, patch.object(ci.time, 'sleep') as sleep:
            ci.launch_screenshot(device='own-device', cwd=self.parent, env={},
                                 output=self.parent, manifest=manifest)
        self.assertEqual(calls.call_count, 2)
        sleep.assert_called_once_with(5)
        self.assertEqual((self.parent / 'launch-attempt-1.png').read_bytes(), b'partial')
        self.assertEqual(manifest['screenshot_sha256'], ci.sha256(self.parent / 'launch.png'))
        self.assertEqual([x['valid_png'] for x in manifest['screenshot_attempts']], [False, True])

    def test_screenshot_exhaustion_fails_even_when_exact_process_survives(self):
        def probe(command, *, name, **kwargs):
            if name.startswith('screenshot'):
                Path(command[-1]).write_bytes(b'')
                return 0
            if name == 'app-process':
                (self.parent / 'app-process.log').write_text(
                    '123 Ss 01:29 /runner/Devices/own-device/'
                    'data/Containers/Bundle/Application/id/Form.app/Form\n')
                return 0
            return None
        manifest = {}
        with patch.object(ci, 'diagnostic', side_effect=probe), patch.object(ci.time, 'sleep'), \
                patch.object(ci, 'collect_crashes'):
            with self.assertRaisesRegex(RuntimeError, 'screenshot capture failed'):
                ci.check_launch(device='own-device', bundle_id='com.jonessystems.form.private', pid='123',
                                launch_epoch=1, built=self.parent / 'Form.app', cwd=self.parent,
                                env={}, output=self.parent, manifest=manifest)
        self.assertEqual(manifest['app_process']['state'], 'alive')
        self.assertEqual(len(manifest['screenshot_attempts']), 2)
        self.assertNotIn('screenshot_sha256', manifest)


    def test_launch_default_and_e2e_each_build_once_with_distinct_api_and_archive(self):
        from types import SimpleNamespace
        import tarfile
        for mode, verify_failure in [('launch', False), ('e2e', False), ('e2e', True)]:
            with self.subTest(mode=mode, verify_failure=verify_failure):
                case = mode + ('-verify-failure' if verify_failure else '')
                source = self.parent / (case + '-source')
                app = source / 'apps/form'
                (app / 'ios').mkdir(parents=True)
                (app / 'package-lock.json').write_text('{}')
                (app / 'package.json').write_text('{}')
                (app / 'ios/Podfile.lock').write_text('locked')
                (source / 'services/api').mkdir(parents=True)
                (source / 'services/api/package-lock.json').write_text('{}')
                (app / 'e2e').mkdir()
                (app / 'e2e/journeys.json').write_text((Path(__file__).parents[1] / 'e2e/journeys.json').read_text())
                output = self.parent / (case + '-evidence')
                args = SimpleNamespace(source=str(source), output=str(output),
                                       scratch_parent=str(self.parent), sha='a' * 40)
                if mode == 'e2e':
                    args.mode = mode
                calls, inputs = [], {}
                def capture(command, **kwargs):
                    if command[:2] == ['git', 'rev-parse']: return args.sha
                    if command[:2] == ['git', 'status']: return ''
                    if command == ['uname', '-m']: return 'arm64'
                    if command == ['xcodebuild', '-version']: return 'Xcode 27.0\nBuild version 27A266a'
                    if command[:3] == ['xcrun', 'simctl', 'create']: return 'owned-device'
                    if command[:3] == ['xcrun', 'simctl', 'launch']: return 'com.jonessystems.form.private: 123'
                    if 'resolve' in command: return 'FormSpeech FormStoreKit FormHealth FormPhotoCapture FormVoice'
                    return 'version'
                def native(command, **kwargs):
                    if command[:2] == ['git', 'archive']:
                        with tarfile.open(command[4], 'w') as archive:
                            archive.add(source / 'apps', arcname='apps')
                            archive.add(source / 'services', arcname='services')
                    calls.append(command)
                    return subprocess.CompletedProcess(command, 0, '', '')
                def run(command, *, cwd, env, log, **kwargs):
                    self.assertEqual(env['EXPO_PUBLIC_FORM_API_URL'],
                                     'http://127.0.0.1:47621' if mode == 'e2e' else 'http://127.0.0.1:9')
                    calls.append(command)
                    if command[0] == '/usr/bin/derq':
                        fake_derq(command)
                    if command[:2] == ['node', '-e']:
                        flags = json.loads(command[-1])
                        self.assertEqual(flags[:7], ['-Xlinker', '-sectcreate', '-Xlinker', '__TEXT',
                                                      '-Xlinker', '__entitlements', '-Xlinker'])
                        self.assertEqual(flags[8:15], ['-Xlinker', '-sectcreate', '-Xlinker', '__TEXT',
                                                       '-Xlinker', '__ents_der', '-Xlinker'])
                        inputs['xml'] = Path(flags[7]).read_bytes()
                        inputs['der'] = Path(flags[15]).read_bytes()
                        self.assertEqual(plistlib.loads(inputs['xml']), EXPECTED_ENTITLEMENTS)
                        self.assertEqual(inputs['der'], NATIVE_DER)
                    if command[0] == 'xcodebuild':
                        if mode == 'e2e':
                            self.assertTrue(inputs, 'E2E XML and DER inputs must be configured before linking')
                        else:
                            self.assertFalse(inputs)
                        self.assertIn('CODE_SIGNING_ALLOWED=NO', command)
                        self.assertFalse(any(c.startswith('OTHER_LDFLAGS=') for c in command))
                        built = Path(command[command.index('-derivedDataPath') + 1]) / 'Build/Products/Release-iphonesimulator/Form.app'
                        built.mkdir(parents=True)
                        (built / 'main.jsbundle').write_text('bundle')
                        binary = macho_fixture(inputs.get('xml'), inputs.get('der'))
                        (built / 'Form').write_bytes(binary)
                        inputs['executable'] = binary
                        (built / 'Info.plist').write_bytes(plistlib.dumps(APP_INFO))
                    if command[0] == 'codesign':
                        if '--verify' in command:
                            if '--ignore-resources' not in command and Path(command[-1]).parent.suffix == '.app':
                                raise subprocess.CalledProcessError(1, command, stderr='code has no resources but signature indicates they must be present')
                            for name, expected in [('diagnostic-Form-executable.bin', inputs['executable']),
                                                   ('diagnostic-Form-Info.plist', plistlib.dumps(APP_INFO))]:
                                self.assertEqual((output / name).read_bytes(), expected)
                            if verify_failure:
                                raise subprocess.CalledProcessError(1, command, stderr='invalid executable signature')
                        self.assertNotIn('--force', command, 'Never replace the linker signature')
                        self.assertNotIn('--sign', command)
                        self.assertEqual(Path(command[-1]).read_bytes(), inputs['executable'])
                    if command[0] == 'ditto': Path(command[-1]).write_text('archive fixture')
                    log.write_text('fixture command completed')
                    return 0
                actual_hash = ci.sha256
                def digest(path):
                    if path.name == 'Form': calls.append(['hash-executable', path.read_bytes()])
                    if path.name == 'expo-template.tgz':
                        return '6b19d4235ab57c66fac699de7a2c57fe0ea277bf8a355ed45b2a37258bd93366'
                    return actual_hash(path)
                with patch.object(ci, 'capture', side_effect=capture), patch.object(ci, 'run', side_effect=run), \
                     patch.object(ci.subprocess, 'run', side_effect=native), patch.object(ci.sys, 'platform', 'darwin'), \
                     patch.object(ci.urllib.request, 'urlretrieve'), patch.object(ci, 'sha256', side_effect=digest), \
                     patch.object(ci.time, 'sleep'), patch.object(ci, 'check_launch') as launch, \
                     patch.object(ci.e2e, 'execute') as journeys, redirect_stdout(io.StringIO()):
                    if verify_failure:
                        with self.assertRaises(subprocess.CalledProcessError) as error:
                            ci.build(args)
                        self.assertEqual(error.exception.returncode, 1)
                    else:
                        ci.build(args)
                manifest = json.loads((output / 'manifest.json').read_text())
                if verify_failure:
                    self.assertEqual(manifest['status'], 'failed')
                    self.assertFalse(manifest['signing_verified'])
                    self.assertEqual(manifest['signing'], 'linker-ad-hoc-simulator-unverified')
                    self.assertFalse(manifest['authenticated_acceptance'])
                    self.assertTrue(manifest['scratch_removed'])
                    self.assertNotIn('executable_sha256', manifest)
                    self.assertFalse(any(c[0] == 'ditto' or c[:3] == ['xcrun', 'simctl', 'install'] for c in calls))
                    journeys.assert_not_called()
                    for name in ('diagnostic-Form-executable.bin', 'diagnostic-Form-Info.plist'):
                        self.assertEqual(manifest['diagnostic_files_sha256'][name], actual_hash(output / name))
                        self.assertEqual(manifest['evidence_sha256'][name], actual_hash(output / name))
                    continue
                self.assertEqual(manifest['status'], 'passed')
                self.assertEqual(manifest['mode'], mode)
                signing = [c for c in calls if c[0] == 'codesign']
                if mode == 'e2e':
                    self.assertEqual(sum(c[0] == '/usr/bin/derq' for c in calls), 1)
                    self.assertEqual(len(signing), 2)
                    self.assertEqual(signing[0][1:3], ['--verify', '--strict'])
                    self.assertEqual(signing[1][1], '--display')
                    hash_index = next(i for i, c in enumerate(calls) if c[0] == 'hash-executable')
                    zip_index = next(i for i, c in enumerate(calls) if c[0] == 'ditto')
                    install_index = next(i for i, c in enumerate(calls) if c[:3] == ['xcrun', 'simctl', 'install'])
                    self.assertLess(calls.index(signing[-1]), hash_index)
                    self.assertLess(hash_index, zip_index)
                    self.assertLess(zip_index, install_index)
                    self.assertEqual(calls[hash_index][1], inputs['executable'])
                    self.assertEqual(manifest['signing'], 'linker-ad-hoc-simulator')
                    self.assertTrue(manifest['signing_verified'])
                    self.assertEqual(manifest['simulator_entitlements'], EXPECTED_ENTITLEMENTS)
                    self.assertEqual(manifest['host_signature_slots'], [0])
                    self.assertEqual(manifest['host_signature_flags'], '0x20002')
                    for name in ('simulator-entitlements-embedded.plist', 'simulator-entitlements-embedded.der',
                                 'simulator-entitlements-input.der', 'simulator-entitlements-input.plist'):
                        self.assertIn(name, manifest['evidence_sha256'])
                else:
                    self.assertEqual(signing, [])
                    self.assertEqual(manifest['signing'], 'disabled')
                self.assertTrue(manifest['scratch_removed'])
                self.assertEqual(manifest['authenticated_acceptance'], mode == 'e2e')
                archive = 'Form-e2e-simulator-arm64.zip' if mode == 'e2e' else 'Form-simulator-arm64.zip'
                self.assertTrue((output / archive).is_file())
                self.assertEqual(sum(c[0] == 'xcodebuild' for c in calls), 1)
                self.assertEqual(sum(c[:3] == ['xcrun', 'simctl', 'install'] for c in calls), 1)
                self.assertEqual(sum(c[:2] == ['npm', 'ci'] for c in calls), 2 if mode == 'e2e' else 1)
                self.assertEqual(launch.call_count, int(mode == 'launch'))
                self.assertEqual(journeys.call_count, int(mode == 'e2e'))
                self.assertEqual(calls[-2:], [['xcrun', 'simctl', 'shutdown', 'owned-device'],
                                             ['xcrun', 'simctl', 'delete', 'owned-device']])


    def test_e2e_readback_rejects_missing_malformed_mismatched_sections_and_signature(self):
        xml = plistlib.dumps(EXPECTED_ENTITLEMENTS)
        der = NATIVE_DER
        other = plistlib.dumps(dict(EXPECTED_ENTITLEMENTS, **{'application-identifier': 'other.app'}))
        extra = plistlib.dumps(dict(EXPECTED_ENTITLEMENTS, **{'keychain-access-groups': ['other.app']}))
        cases = [
            ('missing-xml', macho_fixture(None, der)),
            ('missing-der', macho_fixture(xml, None)),
            ('empty-xml', macho_fixture(b'', der)),
            ('empty-der', macho_fixture(xml, b'')),
            ('malformed-xml', macho_fixture(b'not XML', der)),
            ('malformed-der', macho_fixture(xml, b'not DER')),
            ('wrong-xml-app', macho_fixture(other, der)),
            ('wrong-xml-group', macho_fixture(extra, der)),
            ('wrong-der-app', macho_fixture(xml, NATIVE_DER.replace(b'private', b'foreign', 1))),
            ('wrong-der-group', macho_fixture(xml, NATIVE_DER[:-1] + b'x')),
            ('extra-entitlement', macho_fixture(plistlib.dumps(dict(EXPECTED_ENTITLEMENTS, extra=True)), der)),
            ('signature-xml-entitlements', macho_fixture(xml, der, slots=(0, 5))),
            ('signature-der-entitlements', macho_fixture(xml, der, slots=(0, 7))),
            ('signature-not-linker', macho_fixture(xml, der, flags=2)),
            ('signature-not-adhoc', macho_fixture(xml, der, flags=0x20000)),
            ('wrong-segment', macho_fixture(xml, der, segment=b'__DATA')),
            ('truncated', macho_fixture(xml, der)[:-1]),
        ]
        built = self.parent / 'Form.app'
        built.mkdir()
        (built / 'Info.plist').write_bytes(plistlib.dumps(APP_INFO))
        for name, data in cases:
            with self.subTest(name=name):
                (built / 'Form').write_bytes(data)
                manifest = {}
                with patch.object(ci, 'run') as run:
                    with self.assertRaises((RuntimeError, ValueError)):
                        ci.verify_e2e_simulator(built, expected_der=NATIVE_DER, cwd=self.parent,
                                                env={}, output=self.parent, manifest=manifest)
                run.assert_not_called()
                self.assertFalse(manifest['signing_verified'])
                self.assertEqual((built / 'Form').read_bytes(), data)

    def test_macho_reader_rejects_invalid_ranges_headers_and_duplicate_evidence(self):
        xml = plistlib.dumps(EXPECTED_ENTITLEMENTS)
        valid = macho_fixture(xml, NATIVE_DER)
        mutations = [(0, 0), (4, 7), (12, 6), (16, 0), (20, 0xffffffff),
                     (36, 7), (96, 0xffff), (152, 0xffffffff)]
        executable = self.parent / 'Form'
        for offset, value in mutations:
            with self.subTest(offset=offset):
                data = bytearray(valid)
                struct.pack_into('<I', data, offset, value)
                executable.write_bytes(data)
                with self.assertRaises(RuntimeError):
                    ci.simulator_macho_evidence(executable)
        duplicate = bytearray(valid)
        duplicate[184:200] = duplicate[104:120]
        for data in [duplicate, macho_fixture(xml, b'der', slots=(0, 0)),
                     macho_fixture(xml, b'der', slots=())]:
            executable.write_bytes(data)
            with self.assertRaises(RuntimeError):
                ci.simulator_macho_evidence(executable)

    def test_e2e_signature_command_failure_remains_unverified(self):
        built = self.parent / 'Form.app'
        built.mkdir()
        xml = plistlib.dumps(EXPECTED_ENTITLEMENTS)
        data = macho_fixture(xml, NATIVE_DER)
        (built / 'Form').write_bytes(data)
        (built / 'Info.plist').write_bytes(plistlib.dumps(APP_INFO))
        for failing in ('--verify', '--display'):
            with self.subTest(failing=failing):
                manifest = {}
                def run(command, **kwargs):
                    self.assertEqual(command[0], 'codesign')
                    if failing in command: raise subprocess.CalledProcessError(1, command)
                    return 0
                with patch.object(ci, 'run', side_effect=run), self.assertRaises(subprocess.CalledProcessError):
                    ci.verify_e2e_simulator(built, expected_der=NATIVE_DER, cwd=self.parent, env={}, output=self.parent, manifest=manifest)
                self.assertFalse(manifest['signing_verified'])
                self.assertEqual(manifest['signing'], 'linker-ad-hoc-simulator-unverified')
                self.assertEqual((built / 'Form').read_bytes(), data)
                self.assertEqual((self.parent / 'diagnostic-Form-executable.bin').read_bytes(), data)
                self.assertEqual((self.parent / 'diagnostic-Form-Info.plist').read_bytes(), (built / 'Info.plist').read_bytes())
                for name in ('diagnostic-Form-executable.bin', 'diagnostic-Form-Info.plist'):
                    self.assertEqual(manifest['diagnostic_files_sha256'][name], ci.sha256(self.parent / name))

    def test_e2e_diagnostic_copies_and_hashes_precede_signature_commands(self):
        built = self.parent / 'Form.app'
        built.mkdir()
        info = plistlib.dumps(APP_INFO)
        data = macho_fixture(plistlib.dumps(EXPECTED_ENTITLEMENTS), NATIVE_DER)
        (built / 'Form').write_bytes(data)
        (built / 'Info.plist').write_bytes(info)
        manifest = {}
        def run(command, **kwargs):
            self.assertFalse(manifest['signing_verified'])
            for name, original in [('diagnostic-Form-executable.bin', data),
                                   ('diagnostic-Form-Info.plist', info)]:
                path = self.parent / name
                self.assertEqual(path.read_bytes(), original)
                self.assertEqual(manifest['diagnostic_files_sha256'][name], ci.sha256(path))
            if '--verify' in command:
                self.assertEqual(command, ['codesign', '--verify', '--strict', '--ignore-resources', str(built / 'Form')])
            return 0
        with patch.object(ci, 'run', side_effect=run):
            ci.verify_e2e_simulator(built, expected_der=NATIVE_DER, cwd=self.parent,
                                    env={}, output=self.parent, manifest=manifest)
        self.assertTrue(manifest['signing_verified'])
        self.assertEqual((built / 'Form').read_bytes(), data)
        self.assertEqual((built / 'Info.plist').read_bytes(), info)

    def test_e2e_verification_rejects_other_app_or_device_before_commands(self):
        built = self.parent / 'Form.app'
        built.mkdir()
        for key, value in [('CFBundleIdentifier', 'other.app'), ('CFBundleExecutable', 'Other'),
                           ('CFBundleSupportedPlatforms', ['iPhoneOS'])]:
            with self.subTest(key=key):
                (built / 'Info.plist').write_bytes(plistlib.dumps(dict(APP_INFO, **{key: value})))
                with patch.object(ci, 'run') as run, self.assertRaisesRegex(RuntimeError, 'requires the Form simulator app'):
                    ci.verify_e2e_simulator(built, expected_der=NATIVE_DER, cwd=self.parent, env={}, output=self.parent, manifest={})
                run.assert_not_called()

    def test_e2e_der_generation_failure_cleans_scratch_before_linking(self):
        for failure in ('encode', 'missing', 'empty', 'oversized', 'changed-xml'):
            with self.subTest(failure=failure):
                manifest = {}
                def run(command, **kwargs):
                    self.assertEqual(command[0], '/usr/bin/derq')
                    if failure == 'encode':
                        raise subprocess.CalledProcessError(65, command)
                    if failure == 'missing':
                        return 0
                    fake_derq(command)
                    if failure in ('empty', 'oversized'):
                        Path(command[7]).write_bytes(b'' if failure == 'empty' else b'x' * 65537)
                    if failure == 'changed-xml':
                        Path(command[5]).write_bytes(plistlib.dumps({}))
                    return 0
                with patch.object(ci, 'run', side_effect=run):
                    with self.assertRaises((RuntimeError, subprocess.CalledProcessError)):
                        with ci.owned_scratch(self.parent, manifest) as scratch:
                            ci.prepare_e2e_entitlements(app=self.parent, scratch=scratch, env={},
                                                        output=self.parent, manifest=manifest)
                self.assertFalse(Path(manifest['scratch_root']).exists())

    def test_e2e_encoder_rejects_wrong_xml_before_native_command(self):
        wrong_xml = plistlib.dumps({'application-identifier': 'other.app'})
        with patch.object(ci.plistlib, 'dumps', return_value=wrong_xml), patch.object(ci, 'run') as run:
            with self.assertRaisesRegex(RuntimeError, 'XML encoder input mismatch'):
                ci.prepare_e2e_entitlements(app=self.parent, scratch=self.parent, env={},
                                            output=self.parent, manifest={})
        run.assert_not_called()

    def test_e2e_readback_rejects_invalid_or_altered_expected_der(self):
        built = self.parent / 'Form.app'
        built.mkdir()
        (built / 'Info.plist').write_bytes(plistlib.dumps(APP_INFO))
        (built / 'Form').write_bytes(macho_fixture(plistlib.dumps(EXPECTED_ENTITLEMENTS), NATIVE_DER))
        for expected in (None, b'', b'x' * 65537, NATIVE_DER[:-1] + b'x'):
            with self.subTest(expected_size=None if expected is None else len(expected)):
                manifest = {}
                with patch.object(ci, 'run') as run, self.assertRaises(RuntimeError):
                    ci.verify_e2e_simulator(built, expected_der=expected, cwd=self.parent,
                                            env={}, output=self.parent, manifest=manifest)
                run.assert_not_called()
                self.assertFalse(manifest['signing_verified'])

    def test_e2e_expected_der_is_retained_from_owned_encoder_invocation(self):
        built = self.parent / 'Form.app'
        built.mkdir()
        (built / 'Info.plist').write_bytes(plistlib.dumps(APP_INFO))
        (built / 'Form').write_bytes(macho_fixture(plistlib.dumps(EXPECTED_ENTITLEMENTS), NATIVE_DER))
        manifest = {}
        def run(command, **kwargs):
            if command[0] == '/usr/bin/derq': fake_derq(command)
            return 0
        with ci.owned_scratch(self.parent, manifest) as scratch, patch.object(ci, 'run', side_effect=run) as commands:
            expected = ci.prepare_e2e_entitlements(app=self.parent, scratch=scratch, env={},
                                                   output=self.parent, manifest=manifest)
            self.assertEqual(expected, NATIVE_DER)
            (scratch / 'e2e-simulator-entitlements.der').write_bytes(b'altered after encoding')
            ci.verify_e2e_simulator(built, expected_der=expected, cwd=self.parent,
                                    env={}, output=self.parent, manifest=manifest)
            self.assertEqual(sum(call.args[0][0] == '/usr/bin/derq' for call in commands.call_args_list), 1)
            self.assertTrue(manifest['simulator_der_matches_input'])
        self.assertFalse(scratch.exists())

    def test_link_settings_change_only_form_release_and_preserve_existing_flags(self):
        module = self.parent / 'node_modules/xcode'
        module.mkdir(parents=True)
        (module / 'index.js').write_text("""
const fs = require('fs');
exports.project = path => {
    let data;
    return {
        parseSync: () => { data = JSON.parse(fs.readFileSync(path)); },
        pbxNativeTargetSection: () => data.targets,
        pbxXCConfigurationList: () => data.lists,
        pbxXCBuildConfigurationSection: () => data.configurations,
        writeSync: () => JSON.stringify(data),
    };
};
""")
        project = self.parent / 'project.pbxproj'
        initial = {
            'targets': {'app': {'name': 'Form', 'productType': '"com.apple.product-type.application"',
                                'buildConfigurationList': 'form-list'},
                        'other': {'name': 'Other', 'productType': '"com.apple.product-type.application"',
                                  'buildConfigurationList': 'other-list'}},
            'lists': {'form-list': {'buildConfigurations': [{'value': 'release'}, {'value': 'debug'}]},
                      'other-list': {'buildConfigurations': [{'value': 'other-release'}]}},
            'configurations': {'release': {'name': 'Release', 'buildSettings': {'OTHER_LDFLAGS': ['"$(inherited)"', '-ObjC']}},
                               'debug': {'name': 'Debug', 'buildSettings': {'OTHER_LDFLAGS': '-ObjC'}},
                               'other-release': {'name': 'Release', 'buildSettings': {'OTHER_LDFLAGS': '-ObjC'}}}}
        flags = ['-Xlinker', '-sectcreate', '-Xlinker', '__TEXT', '-Xlinker', '__entitlements',
                 '-Xlinker', '/fixture/path with spaces/entitlements.plist']
        project.write_text(json.dumps(initial))
        result = subprocess.run(['node', '-e', ci.E2E_LINK_SCRIPT, str(project), json.dumps(flags)],
                                cwd=self.parent, capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        actual = json.loads(project.read_text())
        initial['configurations']['release']['buildSettings']['OTHER_LDFLAGS'] += [json.dumps(flag) for flag in flags]
        self.assertEqual(actual, initial)
        initial['targets']['duplicate'] = initial['targets']['app']
        project.write_text(json.dumps(initial))
        result = subprocess.run(['node', '-e', ci.E2E_LINK_SCRIPT, str(project), json.dumps(flags)],
                                cwd=self.parent, capture_output=True, text=True, timeout=10)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(json.loads(project.read_text()), initial)


if __name__ == '__main__':
    unittest.main()
