"""Portable lifecycle checks; native compilation is qualified by the hosted job."""

import importlib.util
from contextlib import redirect_stdout
import io
import json
import os
import plistlib
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('simulator_ci', Path(__file__).with_name('ci-ios-simulator.py'))
ci = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ci)


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
        for mode in ('launch', 'e2e'):
            with self.subTest(mode=mode):
                source = self.parent / (mode + '-source')
                app = source / 'apps/form'
                (app / 'ios').mkdir(parents=True)
                (app / 'package-lock.json').write_text('{}')
                (app / 'package.json').write_text('{}')
                (app / 'ios/Podfile.lock').write_text('locked')
                (source / 'services/api').mkdir(parents=True)
                (source / 'services/api/package-lock.json').write_text('{}')
                (app / 'e2e').mkdir()
                (app / 'e2e/journeys.json').write_text((Path(__file__).parents[1] / 'e2e/journeys.json').read_text())
                output = self.parent / (mode + '-evidence')
                args = SimpleNamespace(source=str(source), output=str(output),
                                       scratch_parent=str(self.parent), sha='a' * 40)
                if mode == 'e2e':
                    args.mode = mode
                calls = []
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
                    if command[:2] == ['codesign', '--display']:
                        entitlements = {'application-identifier': 'com.jonessystems.form.private',
                                        'keychain-access-groups': ['com.jonessystems.form.private']}
                        return subprocess.CompletedProcess(command, 0, plistlib.dumps(entitlements).decode(),
                                                           'Identifier=com.jonessystems.form.private\nSignature=adhoc\n')
                    return subprocess.CompletedProcess(command, 0, '', '')
                def run(command, *, cwd, env, log, **kwargs):
                    self.assertEqual(env['EXPO_PUBLIC_FORM_API_URL'],
                                     'http://127.0.0.1:47621' if mode == 'e2e' else 'http://127.0.0.1:9')
                    calls.append(command)
                    if command[0] == 'xcodebuild':
                        built = Path(command[command.index('-derivedDataPath') + 1]) / 'Build/Products/Release-iphonesimulator/Form.app'
                        built.mkdir(parents=True)
                        (built / 'main.jsbundle').write_text('bundle')
                        (built / 'Form').write_text('executable')
                        (built / 'Info.plist').write_bytes(plistlib.dumps({
                            'CFBundleIdentifier': 'com.jonessystems.form.private',
                            'CFBundleExecutable': 'Form', 'CFBundleSupportedPlatforms': ['iPhoneSimulator']}))
                    if command[:2] == ['codesign', '--force']:
                        (Path(command[-1]) / 'Form').write_text('signed executable')
                    if command[0] == 'ditto': Path(command[-1]).write_text('archive fixture')
                    log.write_text('fixture command completed')
                    return 0
                actual_hash = ci.sha256
                def digest(path):
                    if path.name == 'Form': calls.append(['hash-executable', path.read_text()])
                    if path.name == 'expo-template.tgz':
                        return '6b19d4235ab57c66fac699de7a2c57fe0ea277bf8a355ed45b2a37258bd93366'
                    return actual_hash(path)
                with patch.object(ci, 'capture', side_effect=capture), patch.object(ci, 'run', side_effect=run), \
                     patch.object(ci.subprocess, 'run', side_effect=native), patch.object(ci.sys, 'platform', 'darwin'), \
                     patch.object(ci.urllib.request, 'urlretrieve'), patch.object(ci, 'sha256', side_effect=digest), \
                     patch.object(ci.time, 'sleep'), patch.object(ci, 'check_launch') as launch, \
                     patch.object(ci.e2e, 'execute') as journeys, redirect_stdout(io.StringIO()):
                    ci.build(args)
                manifest = json.loads((output / 'manifest.json').read_text())
                self.assertEqual(manifest['status'], 'passed')
                self.assertEqual(manifest['mode'], mode)
                signing = [c for c in calls if c[0] == 'codesign']
                if mode == 'e2e':
                    self.assertEqual(len(signing), 3, 'E2E must sign, verify and read back its signature')
                    sign, verify, readback = signing
                    self.assertEqual(sign[1:4], ['--force', '--sign', '-'])
                    self.assertIn('--entitlements', sign)
                    self.assertEqual(verify[1:3], ['--verify', '--strict'])
                    self.assertIn('--entitlements', readback)
                    hash_index = next(i for i, c in enumerate(calls) if c[0] == 'hash-executable')
                    zip_index = next(i for i, c in enumerate(calls) if c[0] == 'ditto')
                    install_index = next(i for i, c in enumerate(calls) if c[:3] == ['xcrun', 'simctl', 'install'])
                    self.assertLess(calls.index(readback), hash_index)
                    self.assertLess(hash_index, zip_index)
                    self.assertLess(zip_index, install_index)
                    self.assertEqual(calls[hash_index][1], 'signed executable')
                    self.assertEqual(manifest['signing'], 'ad-hoc-simulator')
                    self.assertTrue(manifest['signing_verified'])
                    self.assertEqual(manifest['signing_entitlements'], {
                        'application-identifier': 'com.jonessystems.form.private',
                        'keychain-access-groups': ['com.jonessystems.form.private']})
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


    def test_e2e_signing_rejects_unverified_or_incorrect_readback(self):
        bundle_id = 'com.jonessystems.form.private'
        expected = {'application-identifier': bundle_id, 'keychain-access-groups': [bundle_id]}
        valid_xml = plistlib.dumps(expected).decode()
        valid_details = 'Identifier=' + bundle_id + '\nSignature=adhoc\n'
        cases = [
            ('missing', plistlib.dumps({}).decode(), valid_details, 0, None),
            ('wrong-app', plistlib.dumps(dict(expected, **{'application-identifier': 'other.app'})).decode(), valid_details, 0, None),
            ('extra-group', plistlib.dumps(dict(expected, **{'keychain-access-groups': [bundle_id, 'other.app']})).decode(), valid_details, 0, None),
            ('extra-entitlement', plistlib.dumps(dict(expected, **{'get-task-allow': True})).decode(), valid_details, 0, None),
            ('malformed', 'not a plist', valid_details, 0, None),
            ('empty', '', valid_details, 0, None),
            ('non-adhoc', valid_xml, valid_details.replace('adhoc', 'developer'), 0, None),
            ('wrong-identifier', valid_xml, valid_details.replace(bundle_id, 'other.app'), 0, None),
            ('failed-readback', valid_xml, valid_details, 1, None),
            ('failed-verify', valid_xml, valid_details, 0, '--verify'),
            ('failed-sign', valid_xml, valid_details, 0, '--force'),
        ]
        built = self.parent / 'Form.app'
        built.mkdir()
        (built / 'Info.plist').write_bytes(plistlib.dumps({
            'CFBundleIdentifier': bundle_id, 'CFBundleExecutable': 'Form',
            'CFBundleSupportedPlatforms': ['iPhoneSimulator']}))
        for name, xml, details, status, failure in cases:
            with self.subTest(name=name):
                manifest = {}
                def run(command, **kwargs):
                    if '--entitlements' in command:
                        path = Path(command[command.index('--entitlements') + 1])
                        self.assertEqual(plistlib.loads(path.read_bytes()), expected)
                    if failure in command:
                        raise subprocess.CalledProcessError(1, command)
                    return 0
                result = subprocess.CompletedProcess(['codesign'], status, xml, details)
                with patch.object(ci, 'run', side_effect=run), \
                        patch.object(ci.subprocess, 'run', return_value=result):
                    with self.assertRaises((RuntimeError, ValueError, subprocess.CalledProcessError)):
                        ci.sign_e2e_simulator(built, scratch=self.parent, cwd=self.parent,
                                              env={}, output=self.parent, manifest=manifest)
                self.assertFalse(manifest['signing_verified'])
                self.assertEqual(manifest['signing'], 'ad-hoc-simulator-unverified')

    def test_e2e_signing_rejects_other_app_or_device_build_before_mutation(self):
        built = self.parent / 'Form.app'
        built.mkdir()
        for key, value in [('CFBundleIdentifier', 'other.app'),
                           ('CFBundleExecutable', 'Other'),
                           ('CFBundleSupportedPlatforms', ['iPhoneOS'])]:
            with self.subTest(key=key):
                info = {'CFBundleIdentifier': 'com.jonessystems.form.private',
                        'CFBundleExecutable': 'Form', 'CFBundleSupportedPlatforms': ['iPhoneSimulator']}
                info[key] = value
                (built / 'Info.plist').write_bytes(plistlib.dumps(info))
                with patch.object(ci, 'run') as run, patch.object(ci.subprocess, 'run') as native:
                    with self.assertRaisesRegex(RuntimeError, 'requires the Form simulator app'):
                        ci.sign_e2e_simulator(built, scratch=self.parent, cwd=self.parent,
                                              env={}, output=self.parent, manifest={})
                run.assert_not_called()
                native.assert_not_called()


if __name__ == '__main__':
    unittest.main()
