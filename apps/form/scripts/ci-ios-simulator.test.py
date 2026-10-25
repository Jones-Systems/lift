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
from unittest.mock import Mock, patch

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
                    if command[:2] == ['sysctl', '-n']: return '3'
                    if command[:3] in (['xcrun', 'simctl', 'shutdown'], ['xcrun', 'simctl', 'delete']):
                        calls.append(command)
                        return ''
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
                    if command[:2] == ['git', 'archive']:
                        with tarfile.open(command[4], 'w') as archive:
                            archive.add(source / 'apps', arcname='apps')
                            archive.add(source / 'services', arcname='services')
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
                     patch.object(ci, 'start_sampler'), patch.object(ci, 'timing_summary_support', return_value=False), \
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


class ShutdownClassificationTests(unittest.TestCase):
    setUp = LifecycleTests.setUp

    def test_exit_racing_either_escalation_is_clean_when_owned_group_is_absent(self):
        for branch in ['leader-timeout', 'group-deadline']:
            with self.subTest(branch=branch):
                child = ci.OwnedChild.__new__(ci.OwnedChild)
                child.name, child.manifest = 'sampler', {}
                child.log = self.parent / (branch + '.log')
                child.log.write_bytes(b'bounded sampler evidence\n')
                child.log_limit = 4096
                child.result = {'returncode': -signal.SIGTERM, 'bytes': child.log.stat().st_size,
                                'truncated': False}
                child.process = Mock(pid=424242)
                child.process.poll.return_value = -signal.SIGTERM
                child.process.stdout.closed = True
                child.process.wait.side_effect = ([subprocess.TimeoutExpired('sampler', 0), -signal.SIGTERM]
                                                 if branch == 'leader-timeout' else [-signal.SIGTERM])
                child.done = Mock()
                child.done.is_set.return_value = False
                child.waiter, child.reader = Mock(), Mock()
                child.waiter.is_alive.return_value = child.reader.is_alive.return_value = False
                signals = []
                def signal_group(pid, sig):
                    self.assertEqual(pid, 424242)
                    signals.append(sig)
                    if sig == signal.SIGKILL or (sig == 0 and
                            (branch == 'leader-timeout' or signals.count(0) > 1)):
                        raise ProcessLookupError('group exited before escalation')
                ticks = iter(range(100, 2000, 10))
                with patch.object(ci.os, 'killpg', side_effect=signal_group), \
                     patch.object(ci.time, 'monotonic', side_effect=lambda: next(ticks)), \
                     patch.object(ci.time, 'sleep', side_effect=AssertionError('oracle must not sleep')):
                    child.close()
                self.assertIn(signal.SIGKILL, signals)
                self.assertTrue(child.result['stopped'])
                self.assertFalse(child.manifest.get('cleanup_errors'))


class ShutdownPostconditionTests(unittest.TestCase):
    setUp = LifecycleTests.setUp

    def child_fixture(self):
        child = ci.OwnedChild.__new__(ci.OwnedChild)
        child.name, child.manifest = 'sampler', {}
        child.log = self.parent / 'shutdown.log'
        child.log.write_bytes(b'bounded evidence\n')
        child.log_limit = 4096
        child.result = {'returncode': -signal.SIGTERM, 'bytes': child.log.stat().st_size,
                        'truncated': False}
        child.process = Mock(pid=424242)
        child.process.poll.return_value = -signal.SIGTERM
        child.process.stdout.closed = True
        child.done = Mock()
        child.done.is_set.return_value = False
        child.waiter, child.reader = Mock(), Mock()
        child.waiter.is_alive.return_value = child.reader.is_alive.return_value = False
        return child

    def test_both_escalation_branches_record_delivery_and_final_postconditions(self):
        for branch in ['leader-timeout', 'group-deadline']:
            for delivered in [False, True]:
                with self.subTest(branch=branch, delivered=delivered):
                    child = self.child_fixture()
                    child.process.wait.side_effect = ([subprocess.TimeoutExpired('sampler', 0), -signal.SIGTERM]
                                                     if branch == 'leader-timeout' else [-signal.SIGTERM])
                    probes = []
                    def signal_group(pid, sig):
                        self.assertEqual(pid, child.process.pid)
                        if sig == signal.SIGKILL and not delivered:
                            raise ProcessLookupError('exited before escalation')
                        if sig == 0:
                            probes.append(sig)
                            if branch == 'leader-timeout' or len(probes) > 1:
                                raise ProcessLookupError('group absent')
                    ticks = iter(range(100, 2000, 10))
                    with patch.object(ci.os, 'killpg', side_effect=signal_group), \
                         patch.object(ci.time, 'monotonic', side_effect=lambda: next(ticks)), \
                         patch.object(ci.time, 'sleep', side_effect=AssertionError('must not sleep')):
                        child.close()
                    shutdown = child.result['shutdown']
                    self.assertEqual(shutdown['escalation_reason'], 'leader_wait_timeout' if
                                     branch == 'leader-timeout' else 'owned_group_present_at_deadline')
                    self.assertEqual([a['signal'] for a in shutdown['signal_attempts']], ['SIGTERM', 'SIGKILL'])
                    self.assertEqual(shutdown['signal_attempts'][-1]['outcome'],
                                     'delivered' if delivered else 'group_absent')
                    self.assertEqual(shutdown['sigkill_delivered'], delivered)
                    self.assertEqual(shutdown['leader_returncode'], -signal.SIGTERM)
                    self.assertEqual(shutdown['final_owned_group']['state'], 'absent')
                    for key in ['leader_reaped', 'waiter_complete', 'reader_complete', 'log_closed',
                                'log_hashed', 'log_within_limit']:
                        self.assertTrue(shutdown[key], key)
                    self.assertEqual(child.result['sha256'], ci.sha256(child.log))
                    self.assertGreaterEqual(shutdown['finished_monotonic_seconds'],
                                            shutdown['started_monotonic_seconds'])
                    self.assertEqual(shutdown['clean'], not delivered)
                    self.assertEqual(bool(child.manifest.get('cleanup_errors')), delivered)

    def test_clean_close_requires_group_leader_threads_and_closed_bounded_hashed_log(self):
        cases = ['clean', 'group-present', 'group-unknown', 'leader-unreaped', 'waiter-pending',
                 'reader-pending', 'log-open', 'log-error', 'log-missing', 'log-oversized']
        for case in cases:
            with self.subTest(case=case):
                child = self.child_fixture()
                if case == 'leader-unreaped': child.process.poll.return_value = None
                if case == 'waiter-pending': child.waiter.is_alive.return_value = True
                if case == 'reader-pending': child.reader.is_alive.return_value = True
                if case == 'log-open': child.process.stdout.closed = False
                if case == 'log-error': child.result['log_error'] = 'injected write failure'
                if case == 'log-missing': child.log.unlink()
                if case == 'log-oversized': child.log_limit = 1
                def signal_group(pid, sig):
                    self.assertEqual((pid, sig), (424242, 0))
                    if case == 'group-present': return
                    if case == 'group-unknown': raise OSError('injected observation unavailable')
                    raise ProcessLookupError('group absent')
                with patch.object(ci, 'stop_process', return_value=False), \
                     patch.object(ci.os, 'killpg', side_effect=signal_group):
                    child.close()
                shutdown = child.result['shutdown']
                self.assertEqual(shutdown['clean'], case == 'clean')
                self.assertEqual(bool(child.manifest.get('cleanup_errors')), case != 'clean')
                self.assertEqual(shutdown['final_owned_group']['state'],
                                 {'group-present': 'present', 'group-unknown': 'unknown'}.get(case, 'absent'))
                if case != 'clean':
                    self.assertEqual(shutdown['leader_returncode'], None if case == 'leader-unreaped'
                                     else -signal.SIGTERM)


class PerformanceTests(unittest.TestCase):
    setUp = LifecycleTests.setUp

    def test_hosted_bash_cancel_retains_upload_point_evidence(self):
        import ctypes
        import shlex
        import shutil
        import time
        parent = self.parent / 'hosted-cancel'
        parent.mkdir()
        program = r'''import importlib.util,json,os,pathlib,signal,sys
spec=importlib.util.spec_from_file_location('checks',sys.argv[1])
checks=importlib.util.module_from_spec(spec);spec.loader.exec_module(checks)
parent=pathlib.Path(sys.argv[2])
for sig in (signal.SIGINT,signal.SIGTERM,signal.SIGHUP):
    signal.signal(sig,checks.ci.interrupted)
(parent/'driver.json').write_text(json.dumps({'pid':os.getpid(),'ppid':os.getppid(),'argv':sys.argv}))
original=checks.ci.subprocess.Popen
def popen(command,**kwargs):
    process=original(command,**kwargs)
    kind=('sampler' if 'CPU PhysMem VM swap' in str(command) else
          'xcodebuild' if 'signal-ready' in str(command) else None)
    if kind:
        (parent/(kind+'.json')).write_text(json.dumps({'pid':process.pid,'pgid':os.getpgid(process.pid),
            'argv':command,'cwd':str(kwargs.get('cwd'))}))
    return process
checks.ci.subprocess.Popen=popen
case=checks.PerformanceTests();case.parent=parent
case.build_case(failure='signal')
'''
        script = parent / 'step.sh'
        script.write_text(shlex.join([sys.executable, '-B', '-c', program,
                                     str(Path(__file__).resolve()), str(parent)]) + '\n')
        receipt = {'wait_limits_seconds': [0.75, 0.25, 0.5], 'signals': [],
                   'driver_sha256': ci.sha256(Path(ci.__file__)),
                   'test_sha256': ci.sha256(Path(__file__)),
                   'workflow_sha256': ci.sha256(Path(__file__).parents[3] /
                                                '.github/workflows/form-ios-simulator.yml')}
        # Adopt only our orphans on Linux so even killed grandchildren are reaped.
        libc, previous_subreaper = None, ctypes.c_int()
        if sys.platform == 'linux':
            libc = ctypes.CDLL(None, use_errno=True)
            self.assertEqual(libc.prctl(37, ctypes.byref(previous_subreaper), 0, 0, 0), 0)
            self.assertEqual(libc.prctl(36, 1, 0, 0, 0), 0)
        process, owned = None, {}
        try:
            with (parent / 'step.log').open('w') as log:
                process = subprocess.Popen(['bash', '-e', str(script)], stdout=log,
                                           stderr=subprocess.STDOUT, start_new_session=True)
                receipt['bash_pid'] = process.pid
                self.wait_file(parent / 'signal-ready')
                for kind in ['driver', 'sampler', 'xcodebuild']:
                    self.wait_file(parent / (kind + '.json'))
                    owned[kind] = json.loads((parent / (kind + '.json')).read_text())
                receipt['processes'] = owned
                self.assertEqual(owned['driver']['ppid'], process.pid)
                for sig, delay in zip([signal.SIGINT, signal.SIGTERM, signal.SIGKILL],
                                      receipt['wait_limits_seconds']):
                    sent = time.monotonic()
                    delivered = process.poll() is None
                    if delivered:
                        os.kill(process.pid, sig)
                    try:
                        process.wait(timeout=delay)
                    except subprocess.TimeoutExpired:
                        pass
                    # Model the runner's pipe grace even if bash has exited.
                    if sig == signal.SIGKILL:
                        time.sleep(max(0, delay - (time.monotonic() - sent)))
                    receipt['signals'].append({'signal': sig.name, 'delivered': delivered,
                                               'elapsed_seconds': time.monotonic() - sent})
                output = next(parent.glob('*/evidence'))
                snapshot = {p.name: p.read_text(errors='replace') for p in output.iterdir()
                            if p.is_file()}
                receipt['upload_point'] = snapshot
                try:
                    manifest = json.loads(snapshot.get('manifest.json', ''))
                except ValueError:
                    manifest = {}
                try:
                    os.kill(owned['driver']['pid'], 0)
                    alive = True
                except ProcessLookupError:
                    alive = False
                stages = manifest.get('stage_timestamps', [])
                finished = [r for r in manifest.get('commands', []) if r.get('returncode') is not None]
                inflight = [r for r in manifest.get('commands', [])
                            if r.get('name') == 'xcodebuild.log' and r.get('returncode') is None]
                receipt['OA1'] = alive
                receipt['OA2'] = bool(manifest and manifest.get('status') != 'passed' and
                    [r.get('stage') for r in stages] ==
                    ['identity', 'scratch', 'archive', 'install', 'prebuild', 'pods', 'build'] and
                    all(isinstance(r.get('offset_seconds'), (int, float)) and r['offset_seconds'] >= 0
                        for r in stages) and finished and
                    all(isinstance(r.get('seconds'), (int, float)) and r['seconds'] >= 0 for r in finished) and
                    len(inflight) == 1 and isinstance(inflight[0].get('start_offset_seconds'), (int, float)) and
                    inflight[0]['start_offset_seconds'] >= 0 and
                    manifest.get('source_sha') == 'a' * 40 and manifest.get('host') and
                    manifest.get('xcode') == 'Xcode 27.0\nBuild version 27A266a' and
                    manifest.get('xcode_jobs') == 1)
                receipt['OA3'] = 'CPU PhysMem VM swap' in snapshot.get('host-resources.log', '')
        finally:
            # Read registrations even when a barrier or assertion failed.
            for kind in ['driver', 'sampler', 'xcodebuild']:
                path = parent / (kind + '.json')
                if kind not in owned and path.exists():
                    owned[kind] = json.loads(path.read_text())
            drained = {}
            for kind, row in owned.items():
                try:
                    os.kill(row['pid'], signal.SIGKILL)
                except ProcessLookupError:
                    pass
            if process is not None:
                if process.poll() is None:
                    process.kill()
                process.wait(timeout=3)
            for kind, row in owned.items():
                deadline = time.monotonic() + 3
                while time.monotonic() < deadline:
                    try:
                        os.waitpid(row['pid'], os.WNOHANG)
                    except ChildProcessError:
                        pass
                    try:
                        os.kill(row['pid'], 0)
                    except ProcessLookupError:
                        drained[kind] = True
                        break
                    time.sleep(0.01)
                drained.setdefault(kind, False)
            if libc is not None:
                self.assertEqual(libc.prctl(36, previous_subreaper.value, 0, 0, 0), 0)
            receipt['drained'] = drained
            receipt['processes'] = owned
            destination = os.environ.get('AM7_EVIDENCE_DIR')
            if destination:
                retained = Path(destination)
                retained.mkdir(parents=True, exist_ok=False)
                (retained / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
                shutil.copyfile(parent / 'step.log', retained / 'step.log')
            shutil.rmtree(parent)
            receipt['scratch_removed'] = not parent.exists()
            print('Hosted cancellation oracle: ' + json.dumps(receipt), flush=True)
            self.assertTrue(all(drained.values()), drained)
        self.assertTrue(receipt['OA1'], 'O3: driver did not survive bash cancellation')
        for assertion in ['OA2', 'OA3']:
            with self.subTest(assertion=assertion):
                self.assertTrue(receipt[assertion], assertion + ' missing at upload point')

    def test_command_timing_keeps_failure_and_capture_exit_status(self):
        manifest = {}
        import time
        with patch.object(ci, 'MEASUREMENTS', {'manifest': manifest, 'origin': time.monotonic()}):
            with self.assertRaises(subprocess.CalledProcessError):
                ci.run([sys.executable, '-c', 'raise SystemExit(23)'], cwd=self.parent,
                       env=os.environ.copy(), log=self.parent / 'failed.log')
            self.assertEqual(ci.capture([sys.executable, '-c', 'print("captured")'],
                                        cwd=self.parent, env=os.environ.copy()), 'captured')
        self.assertEqual([r['returncode'] for r in manifest['commands']], [23, 0])
        for row in manifest['commands']:
            for key in ['start_offset_seconds', 'seconds', 'children_user_seconds', 'children_system_seconds']:
                self.assertGreaterEqual(row[key], 0)

    def test_sampler_bounds_hash_and_term_resistant_cleanup(self):
        for resistant in [False, True]:
            with self.subTest(resistant=resistant):
                manifest = {}
                ready = self.parent / ('ready-' + str(resistant))
                program = ('import signal,time,pathlib; ' +
                           ('signal.signal(signal.SIGTERM, signal.SIG_IGN); ' if resistant else '') +
                           'print("x" * 10000, flush=True); pathlib.Path(' + repr(str(ready)) +
                           ').touch(); time.sleep(30)')
                child = ci.OwnedChild([sys.executable, '-c', program], cwd=self.parent,
                                      env=os.environ.copy(), log=self.parent / ('sampler-' + str(resistant)),
                                      manifest=manifest, name='sampler', limit=4096)
                try:
                    self.wait_file(ready)
                finally:
                    with patch.object(ci, 'CANCELLED', True):
                        child.close()
                self.assertTrue(child.result['stopped'])
                self.assertTrue(child.result['truncated'])
                self.assertEqual(child.log.stat().st_size, 4096)
                self.assertEqual(child.result['returncode'], -9 if resistant else -15)
                self.assertEqual(bool(manifest.get('cleanup_errors')), resistant)
                self.assertEqual(child.result['shutdown']['sigkill_delivered'], resistant)
                self.assertEqual(child.result['shutdown']['final_owned_group']['state'], 'absent')
                self.assertEqual(child.result['shutdown']['clean'], not resistant)
                ci.e2e.write_evidence_manifest(self.parent, dict(manifest, status='failed', source_sha='a' * 40))
                evidence = json.loads((self.parent / 'manifest.json').read_text())
                self.assertEqual(evidence['evidence_sha256'][child.log.name], ci.sha256(child.log))
                with self.assertRaises(ProcessLookupError):
                    os.kill(child.process.pid, 0)

    def wait_file(self, path):
        import time
        deadline = time.monotonic() + 5
        while not path.exists() and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertTrue(path.exists())

    def build_case(self, *, early=False, failure=None, jobs=1, summary=False, mode='launch', cpus=3):
        from types import SimpleNamespace
        import tarfile
        import time
        root = self.parent / str(len(list(self.parent.iterdir())))
        root.mkdir()
        source = root / 'source'
        app = source / 'apps/form'
        (app / 'ios').mkdir(parents=True)
        for name in ['package.json', 'package-lock.json', 'ios/Podfile.lock']:
            (app / name).write_text('{}')
        (source / 'services/api').mkdir(parents=True)
        (source / 'services/api/package-lock.json').write_text('{}')
        (app / 'e2e').mkdir()
        (app / 'e2e/journeys.json').write_text((Path(__file__).parents[1] / 'e2e/journeys.json').read_text())
        output = root / 'evidence'
        args = SimpleNamespace(source=str(source), output=str(output), scratch_parent=str(root),
                               sha='a' * 40, mode=mode, early_boot=early, xcode_jobs=jobs)
        events, children = [], []
        original_run, original_popen, original_hash = ci.run, ci.subprocess.Popen, ci.sha256
        original_capture = ci.capture
        def popen(command, **kwargs):
            events.append(list(command))
            if command[0] == 'top':
                command = [sys.executable, '-c', 'import signal,time; ' +
                           ('signal.signal(signal.SIGTERM, signal.SIG_IGN); ' if failure == 'sampler-kill' else '') +
                           'print("CPU PhysMem VM swap",flush=True); time.sleep(30)']
            elif command[:3] == ['xcrun', 'simctl', 'bootstatus']:
                command = [sys.executable, '-c', 'import time; time.sleep(30)' if failure == 'join' else 'print("ready")']
            process = original_popen(command, **kwargs)
            children.append(process)
            return process
        def capture(command, *, cwd, **kwargs):
            self.assertTrue(Path(cwd).is_dir())
            events.append(list(command))
            if command[:2] == ['git', 'rev-parse']: return args.sha
            if command[:2] == ['git', 'status']: return ''
            if command == ['uname', '-m']: return 'arm64'
            if command[:2] == ['sysctl', '-n']: return str(cpus)
            if command == ['xcodebuild', '-version']: return 'Xcode 27.0\nBuild version 27A266a'
            if command[:3] == ['xcrun', 'simctl', 'create']:
                if failure == 'create-cancel': raise SystemExit(143)
                if failure == 'create-signal':
                    return original_capture([sys.executable, '-c',
                        'import pathlib,time; pathlib.Path(' + repr(str(self.parent / 'signal-ready')) +
                        ').touch(); time.sleep(30)'], cwd=cwd, **kwargs)
                return 'owned-device'
            if command[:4] == ['xcrun', 'simctl', 'list', 'devices']:
                name = next(c[3] for c in events if c[:3] == ['xcrun', 'simctl', 'create'])
                return json.dumps({'devices': {'runtime': [{'name': name, 'udid': 'owned-device'},
                                                         {'name': name + '-other', 'udid': 'unrelated'}]}})
            if command[:3] == ['xcrun', 'simctl', 'launch']: return 'app: 123'
            if 'resolve' in command: return 'FormSpeech FormStoreKit FormHealth FormPhotoCapture FormVoice'
            return 'version'
        def run(command, *, cwd, env, log, **kwargs):
            self.assertTrue(Path(cwd).is_dir())
            events.append(list(command))
            if command[:2] == ['git', 'archive']:
                with tarfile.open(command[4], 'w') as archive:
                    archive.add(source / 'apps', arcname='apps')
                    archive.add(source / 'services', arcname='services')
            if command[0] == 'xcodebuild':
                built = Path(command[command.index('-derivedDataPath') + 1]) / 'Build/Products/Release-iphonesimulator/Form.app'
                built.mkdir(parents=True)
                (built / 'main.jsbundle').write_text('bundle')
                (built / 'Form').write_text('executable')
            if command[0] == 'ditto': Path(command[-1]).write_text('archive')
            if command[0] == 'xcodebuild' and failure == 'signal':
                return original_run([sys.executable, '-c',
                    'import pathlib,time; pathlib.Path(' + repr(str(self.parent / 'signal-ready')) +
                    ').touch(); time.sleep(30)'], cwd=cwd, env=env, log=log)
            failing = failure in ['install', 'pods', 'build'] and log.stem == failure.replace('build', 'xcodebuild')
            return original_run([sys.executable, '-c', 'raise SystemExit(23)' if failing else 'print("fixture")'],
                                cwd=cwd, env=env, log=log, **kwargs)
        def digest(path):
            if path.name == 'expo-template.tgz': return '6b19d4235ab57c66fac699de7a2c57fe0ea277bf8a355ed45b2a37258bd93366'
            return original_hash(path)
        original_join = ci.OwnedChild.join
        def join(child, timeout):
            events.append(['join', child.name])
            return original_join(child, 0.01 if failure == 'join' else timeout)
        error = None
        with patch.object(ci, 'capture', side_effect=capture), patch.object(ci, 'run', side_effect=run), \
             patch.object(ci.subprocess, 'Popen', side_effect=popen), patch.object(ci.sys, 'platform', 'darwin'), \
             patch.object(ci.urllib.request, 'urlretrieve'), patch.object(ci, 'sha256', side_effect=digest), \
             patch.object(ci, 'timing_summary_support', return_value=summary), \
             patch.object(ci, 'prepare_e2e_entitlements', return_value=b'der'), patch.object(ci, 'verify_e2e_simulator'), \
             patch.object(ci.e2e, 'execute'), patch.object(ci, 'check_launch'), \
             patch.object(ci.OwnedChild, 'join', join), patch.object(ci.time, 'sleep'), redirect_stdout(io.StringIO()):
            try:
                ci.build(args)
            except (ValueError, RuntimeError, subprocess.SubprocessError, SystemExit) as exc:
                error = exc
        manifest = json.loads((output / 'manifest.json').read_text())
        self.assertTrue(all(p.poll() is not None for p in children))
        self.assertFalse(list(root.glob('form-ios-*')))
        return manifest, events, error

    def test_budget_validation_precedes_scratch_or_device_effects(self):
        for jobs, cpus in [(0, 3), (4, 3), (2, 1), ('2', 3), (True, 3)]:
            manifest, events, error = self.build_case(jobs=jobs, cpus=cpus)
            self.assertIsInstance(error, ValueError)
            self.assertNotIn('scratch_root', manifest)
            self.assertFalse(any(c[0] == 'top' or c[:2] == ['xcrun', 'simctl'] for c in events))

    def test_control_argv_and_optional_early_boot_ordering(self):
        for early, jobs, summary in [(False, 1, False), (True, 2, True), (True, 3, False)]:
            manifest, events, error = self.build_case(early=early, jobs=jobs, summary=summary, mode='e2e')
            self.assertIsNone(error)
            self.assertEqual(manifest['status'], 'passed')
            self.assertEqual(manifest['xcode_jobs'], jobs)
            self.assertIn('hw.ncpu', manifest['host'])
            build = next(c for c in events if c[:2] == ['xcodebuild', '-workspace'])
            self.assertEqual(manifest['xcodebuild_argv'], build)
            derived, workspace = build[build.index('-derivedDataPath') + 1], build[2]
            self.assertEqual(build, ['xcodebuild', '-workspace', workspace, '-scheme', 'Form',
                '-configuration', 'Release', '-sdk', 'iphonesimulator', '-destination',
                'generic/platform=iOS Simulator', '-derivedDataPath', derived, '-jobs', str(jobs),
                *(['-showBuildTimingSummary'] if summary else []), 'ARCHS=arm64', 'ONLY_ACTIVE_ARCH=YES',
                'CODE_SIGNING_ALLOWED=NO', 'CODE_SIGNING_REQUIRED=NO', 'CODE_SIGN_IDENTITY=', 'build'])
            create = next(i for i,c in enumerate(events) if c[:3] == ['xcrun','simctl','create'])
            archive = next(i for i,c in enumerate(events) if c[:2] == ['git','archive'])
            self.assertEqual(create < archive, early)
            self.assertRegex(events[create][3], r'^Form-CI-a{12}-[^-]+-[^-]+$')
            package = next(i for i,c in enumerate(events) if c[0] == 'ditto')
            install = next(i for i,c in enumerate(events) if c[:3] == ['xcrun','simctl','install'])
            self.assertLess(package, install)
            if early:
                self.assertLess(package, events.index(['join', 'bootstatus']))
                self.assertGreaterEqual(manifest['bootstatus_blocked_wait_seconds'], 0)
                self.assertIsNotNone(manifest['bootstatus_readiness_seconds'])
            self.assertTrue(manifest['background_children']['sampler']['stopped'])
            self.assertIn('host-resources.log', manifest['evidence_sha256'])

    def test_injected_dependency_and_compiler_failures_clean_both_boot_modes(self):
        for early in [False, True]:
            for failure in ['install', 'pods', 'build']:
                with self.subTest(early=early, failure=failure):
                    manifest, events, error = self.build_case(early=early, failure=failure)
                    self.assertIsInstance(error, subprocess.CalledProcessError)
                    self.assertEqual(error.returncode, 23)
                    self.assertEqual(manifest['stage'], failure)
                    self.assertEqual(next(r for r in manifest['commands'] if r['name'] == failure.replace('build', 'xcodebuild') + '.log')['returncode'], 23)
                    self.assertTrue(manifest['scratch_removed'])
                    self.assertFalse(manifest.get('cleanup_errors'))
                    self.assertTrue(manifest['background_children']['sampler']['stopped'])
                    if early:
                        self.assertTrue(manifest['background_children']['bootstatus']['stopped'])
                        self.assertEqual(events[-2:], [['xcrun','simctl','shutdown','owned-device'],
                                                      ['xcrun','simctl','delete','owned-device']])

    def test_signal_during_child_registration_still_has_cleanup_owner(self):
        children, manifest = [], {}
        previous_handlers = {sig: signal.getsignal(sig) for sig in ci.e2e.SIGNALS}
        self.addCleanup(lambda: [signal.signal(sig, handler) for sig, handler in previous_handlers.items()])
        original_child = ci.OwnedChild
        def construct(*args, **kwargs):
            child = original_child(*args, **kwargs)
            ci.interrupted(signal.SIGTERM, None)
            return child
        with patch.object(ci, 'CANCELLED', False), patch.object(ci, 'OwnedChild', side_effect=construct):
            with self.assertRaises(SystemExit) as error:
                with ci.owned_children() as children:
                    ci.start_owned_child(children, [sys.executable, '-c', 'import time; time.sleep(30)'],
                                         cwd=self.parent, env=os.environ.copy(), log=self.parent / 'registration.log',
                                         manifest=manifest, name='sampler')
            self.assertEqual(error.exception.code, 143)
        self.assertEqual(len(children), 1)
        self.assertTrue(children[0].result['stopped'])
        self.assertFalse(manifest.get('cleanup_errors'))

    def test_bounded_help_detection_summary_and_best_effort_flags(self):
        original_popen = ci.subprocess.Popen
        for advertised in [True, False]:
            manifest = {}
            def popen(command, **kwargs):
                self.assertEqual(command, ['xcodebuild', '-help'])
                return original_popen([sys.executable, '-c',
                    'print("usage: -showBuildTimingSummary")' if advertised else 'print("other help")'], **kwargs)
            with patch.object(ci.subprocess, 'Popen', side_effect=popen):
                supported = ci.timing_summary_support(cwd=self.parent, env=os.environ.copy(),
                                                      output=self.parent, manifest=manifest)
            self.assertEqual(supported, advertised)
            self.assertLessEqual((self.parent / 'xcodebuild-help.log').stat().st_size, 256 * 1024)
            self.assertTrue(manifest['background_children']['xcodebuild-help']['stopped'])
        (self.parent / 'xcodebuild.log').write_text('swiftc -j3 -num-threads 2\n' +
            'Build Timing Summary\n' + 'task 1 second\n' * 10000)
        ci.build_log_evidence(self.parent, manifest)
        self.assertEqual(manifest['compiler_flags_observed'], {'-j': {'3': 1}, '-num-threads': {'2': 1}})
        summary = self.parent / 'build-timing-summary.log'
        self.assertTrue(summary.read_text().startswith('Build Timing Summary'))
        self.assertLessEqual(summary.stat().st_size, 65536)

    def test_sampler_kill_fails_otherwise_successful_build(self):
        manifest, events, error = self.build_case(failure='sampler-kill')
        self.assertIsInstance(error, RuntimeError)
        self.assertEqual(manifest['status'], 'failed')
        self.assertTrue(any('sampler: SIGKILL required' in e for e in manifest['cleanup_errors']))

    def test_sigterm_during_build_and_unknown_create_drains_owned_children(self):
        for early, failure in [(False, 'signal'), (True, 'signal'), (True, 'create-signal')]:
            with self.subTest(early=early, failure=failure):
                parent = self.parent / ('signal-' + str(early) + failure)
                parent.mkdir()
                program = r'''import importlib.util,json,pathlib,signal,sys
spec=importlib.util.spec_from_file_location('checks',sys.argv[1])
checks=importlib.util.module_from_spec(spec);spec.loader.exec_module(checks)
checks.ci.signal.signal(signal.SIGTERM,checks.ci.interrupted)
case=checks.PerformanceTests();case.parent=pathlib.Path(sys.argv[2])
manifest,events,error=case.build_case(early=sys.argv[3]=='True',failure=sys.argv[4])
(case.parent/'receipt.json').write_text(json.dumps({'manifest':manifest,'events':events,'error':str(error)}))
raise SystemExit(error.code if isinstance(error,SystemExit) else 1)
'''
                with (parent / 'child.log').open('w') as log:
                    process = subprocess.Popen([sys.executable, '-B', '-c', program, str(Path(__file__).resolve()),
                                                str(parent), str(early), failure], stdout=log, stderr=subprocess.STDOUT)
                    try:
                        self.wait_file(parent / 'signal-ready')
                        process.send_signal(signal.SIGTERM)
                        self.assertEqual(process.wait(timeout=15), 143)
                    finally:
                        if process.poll() is None:
                            process.kill()
                        process.wait(timeout=3)
                receipt = json.loads((parent / 'receipt.json').read_text())
                manifest = receipt['manifest']
                self.assertTrue(manifest['scratch_removed'])
                self.assertFalse(manifest.get('cleanup_errors'))
                self.assertTrue(manifest['background_children']['sampler']['stopped'])
                if early:
                    self.assertEqual(receipt['events'][-1], ['xcrun','simctl','delete','owned-device'])
                if failure == 'create-signal':
                    self.assertEqual(manifest['simulator_reconciled_udid'], 'owned-device')
                else:
                    failing = next(r for r in manifest['commands'] if r['name'] == 'xcodebuild.log')
                    self.assertEqual(failing['returncode'], -signal.SIGTERM)

    def test_unknown_create_cancellation_and_join_timeout_cleanup(self):
        for failure in ['create-cancel', 'join']:
            manifest, events, error = self.build_case(early=True, failure=failure)
            self.assertIsNotNone(error)
            self.assertTrue(manifest['scratch_removed'])
            self.assertFalse(manifest.get('cleanup_errors'))
            self.assertEqual(events[-1], ['xcrun','simctl','delete','owned-device'])
            if failure == 'create-cancel':
                self.assertEqual(manifest['simulator_reconciled_udid'], 'owned-device')
                self.assertTrue(any(c[:4] == ['xcrun','simctl','list','devices'] for c in events))
            else:
                self.assertIsInstance(error, subprocess.TimeoutExpired)
                self.assertTrue(manifest['background_children']['bootstatus']['stopped'])


if __name__ == '__main__':
    unittest.main()
