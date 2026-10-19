#!/usr/bin/env python3
"""Build an exact Form revision on a disposable GitHub macOS runner."""

import argparse
from collections import deque
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.request


@contextmanager
def owned_scratch(parent, manifest):
    path = Path(tempfile.mkdtemp(prefix='form-ios-', dir=parent))
    manifest['scratch_root'] = str(path)
    try:
        yield path
    finally:
        original_error = sys.exc_info()[0] is not None
        try:
            shutil.rmtree(path)
        except OSError as exc:
            manifest.setdefault('cleanup_errors', []).append(str(exc))
            if not original_error:
                raise


def sha256(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def run(command, *, cwd, env, log, timeout=None, check=True):
    """Retain output and terminate the exact child process group on interruption."""
    print('Running ' + str(command[0]) + ' (' + log.name + ')', flush=True)
    with log.open('a') as stream:
        stream.write('$ ' + ' '.join(map(str, command)) + '\n')
        stream.flush()
        process = subprocess.Popen(command, cwd=cwd, env=env, stdout=stream,
                                   stderr=subprocess.STDOUT, start_new_session=True)
        try:
            status = process.wait(timeout=timeout)
        except BaseException:
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGTERM)
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
            raise
        if status and check:
            stream.flush()
            print_failure_log(log)
            raise subprocess.CalledProcessError(status, command)
        return status


def print_failure_log(log):
    """Keep bounded diagnostics available even when artifact upload fails."""
    tail = deque(maxlen=80)
    errors = []
    with log.open(errors='replace') as stream:
        for line in stream:
            bounded = line.rstrip()[:1000]
            tail.append(bounded)
            if len(errors) < 20 and re.search(r'error:|fatal error|BUILD FAILED|No space left|Unhandled JS Exception|Terminating app|RCTFatal|Library not loaded', line, re.IGNORECASE):
                errors.append(bounded)
    print('Failure diagnostics from ' + log.name + ':', flush=True)
    for line in errors + list(tail):
        print(line, flush=True)


def capture(command, *, cwd, env):
    return subprocess.check_output(command, cwd=cwd, env=env, text=True).strip()


def diagnostic(command, *, cwd, env, output, manifest, name, echo=True, timeout=30):
    """A bounded probe must not replace the launch failure being diagnosed."""
    log = output / (name + '.log')
    result = {}
    try:
        result['returncode'] = run(command, cwd=cwd, env=env, log=log,
                                   timeout=timeout, check=False)
    except (OSError, subprocess.TimeoutExpired) as exc:
        result['error'] = str(exc)
    manifest.setdefault('launch_diagnostics', {})[name] = result
    if echo and log.exists():
        try:
            print_failure_log(log)
        except OSError as exc:
            result['log_error'] = str(exc)
    return result.get('returncode')


def matching_crash_report(text, bundle_id, pid):
    # Apple IPS reports contain a metadata object followed by the report object.
    header, end = json.JSONDecoder().raw_decode(text.lstrip())
    report = json.loads(text.lstrip()[end:])
    if header.get('bundleID') == bundle_id and report.get('pid') == int(pid):
        return report
    return None


def crash_summary(report):
    summary = {key: report.get(key) for key in ['pid', 'procPath', 'exception', 'termination', 'asi']}
    threads = report.get('threads', [])
    index = report.get('faultingThread')
    frames = threads[index].get('frames', []) if isinstance(index, int) and 0 <= index < len(threads) else []
    images = report.get('usedImages', [])
    summary['faulting_frames'] = []
    for frame in frames[:15]:
        item = {key: frame.get(key) for key in ['symbol', 'imageIndex', 'imageOffset']}
        index = frame.get('imageIndex')
        if isinstance(index, int) and 0 <= index < len(images):
            item['image'] = images[index].get('name') or images[index].get('path')
        summary['faulting_frames'].append(item)
    summary['lastExceptionBacktrace'] = report.get('lastExceptionBacktrace', [])[:15]
    return summary


def collect_crashes(directory, *, since, bundle_id, pid, output, manifest):
    """Read only fresh Form reports for this PID on the disposable CI host."""
    deadline = time.monotonic() + 10
    retained = []
    while True:
        for path in sorted(directory.glob('Form*.ips'))[:20]:
            try:
                if path.is_symlink() or path.stat().st_mtime < since:
                    continue
                with path.open('rb') as stream:
                    content = stream.read(4 * 1024 * 1024 + 1)
                if len(content) > 4 * 1024 * 1024:
                    continue
                report = matching_crash_report(content.decode('utf-8'), bundle_id, pid)
                if report is None:
                    continue
                (output / ('crash-' + path.name)).write_bytes(content)
                summary = output / ('crash-' + path.stem + '.json')
                fields = crash_summary(report)
                summary.write_text(json.dumps(fields, indent=2) + '\n')
                retained.append(path.name)
                for key, value in fields.items():
                    print('Form crash ' + key + ': ' + json.dumps(value)[:4000], flush=True)
            except (OSError, ValueError, TypeError, AttributeError, KeyError, IndexError):
                # A crash reporter may still be writing; retry within this deadline.
                continue
        if retained or time.monotonic() >= deadline:
            break
        time.sleep(1)
    manifest['matching_crash_reports'] = retained
    print('Matching Form crash reports: ' + json.dumps(retained), flush=True)


def app_process_evidence(text, *, returncode, device, pid, built):
    if returncode != 0:
        return {'state': 'unknown', 'reason': 'process query unavailable'}
    rows = [line.split(None, 3) for line in text.splitlines()
            if line.split() and line.split()[0] == pid]
    if len(rows) != 1 or len(rows[0]) != 4:
        return {'state': 'unknown', 'reason': 'matching PID row unavailable or malformed'}
    _, status, elapsed, executable = rows[0]
    marker = '/Devices/' + device + '/data/Containers/Bundle/Application/'
    if marker not in executable or not executable.endswith('/' + built.name + '/' + built.stem):
        return {'state': 'unknown', 'reason': 'PID executable identity mismatch'}
    if 'Z' in status or 'X' in status:
        return {'state': 'dead', 'reason': 'process is a zombie or exited'}
    try:
        days, clock = elapsed.split('-', 1) if '-' in elapsed else ('0', elapsed)
        fields = clock.split(':')
        if len(fields) not in (2, 3) or not all(x.isdigit() for x in [days, *fields]):
            raise ValueError('malformed elapsed time')
        hours, minutes, seconds = map(int, fields if len(fields) == 3 else ['0', *fields])
        if seconds >= 60 or (len(fields) == 3 and minutes >= 60):
            raise ValueError('malformed elapsed time')
        lifetime = int(days) * 86400 + hours * 3600 + minutes * 60 + seconds
    except ValueError:
        return {'state': 'unknown', 'reason': 'process lifetime unavailable'}
    if lifetime < 15:
        return {'state': 'unknown', 'reason': 'process lifetime below 15 seconds'}
    return {'state': 'alive', 'pid': pid, 'elapsed_seconds': lifetime,
            'executable': executable, 'status': status}


def launch_screenshot(*, device, cwd, env, output, manifest):
    # Fresh paths prevent a timed-out or partial capture from satisfying a later attempt.
    for attempt in range(2):
        path = output / ('launch-attempt-' + str(attempt + 1) + '.png')
        name = 'screenshot' if attempt == 0 else 'screenshot-retry'
        result = diagnostic(['xcrun', 'simctl', 'io', device, 'screenshot', str(path)],
                            cwd=cwd, env=env, output=output, manifest=manifest,
                            name=name, timeout=60)
        valid = False
        if result == 0 and path.is_file() and path.stat().st_size > 8:
            with path.open('rb') as stream:
                valid = stream.read(8) == b'\x89PNG\r\n\x1a\n'
        manifest.setdefault('screenshot_attempts', []).append(
            {'attempt': attempt + 1, 'returncode': result, 'valid_png': valid})
        if valid:
            screenshot = output / 'launch.png'
            path.replace(screenshot)
            manifest['screenshot_sha256'] = sha256(screenshot)
            return
        if attempt == 0:
            time.sleep(5)


def check_launch(*, device, bundle_id, pid, launch_epoch, built, cwd, env, output, manifest):
    launch_wall = time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(launch_epoch))
    probe = dict(cwd=cwd, env=env, output=output, manifest=manifest)
    launch_screenshot(device=device, **probe)
    diagnostic(['xcrun', 'simctl', 'get_app_container', device, bundle_id, 'app'],
               name='installed-container', **probe)
    processes_rc = diagnostic(['xcrun', 'simctl', 'spawn', device, 'launchctl', 'list'],
                              name='processes', echo=False, **probe)
    processes_path = output / 'processes.log'
    processes = processes_path.read_text() if processes_path.exists() else ''
    lines = processes.splitlines()
    manifest['launchctl_app_rows'] = [line[:1000] for line in lines if bundle_id in line][:20]
    manifest['launchctl_query_available'] = processes_rc == 0
    print('launchctl lines: ' + str(len(lines)) + '; app rows: ' +
          json.dumps(manifest['launchctl_app_rows']), flush=True)
    # A timed-out simctl query cannot establish process death; check the executable last.
    process_rc = diagnostic(['ps', '-ww', '-p', pid, '-o', 'pid=,stat=,etime=,comm='],
                            name='app-process', **probe)
    process_log = output / 'app-process.log'
    evidence = app_process_evidence(process_log.read_text() if process_log.exists() else '',
                                    returncode=process_rc, device=device, pid=pid, built=built)
    manifest['app_process'] = evidence
    if evidence['state'] != 'alive':
        diagnostic(['xcrun', 'simctl', 'spawn', device, 'log', 'show', '--info',
                    '--style', 'compact', '--start', launch_wall, '--predicate',
                    'process == "Form" OR ((process == "runningboardd" OR process == "SpringBoard") '
                    'AND eventMessage CONTAINS "' + bundle_id + '")'], name='app-startup', **probe)
        diagnostic(['codesign', '-dv', str(built)], name='app-signature', **probe)
        collect_crashes(Path.home() / 'Library/Logs/DiagnosticReports', since=launch_epoch,
                        bundle_id=bundle_id, pid=pid, output=output, manifest=manifest)
        raise RuntimeError('app process identity/survival unverified: ' + evidence['reason'])
    if 'screenshot_sha256' not in manifest:
        raise RuntimeError('launch screenshot capture failed; see diagnostics')


def interrupted(signum, _frame):
    raise SystemExit(128 + signum)


def build(args):
    source = Path(args.source).resolve()
    output = Path(args.output).resolve()
    output.mkdir(parents=True, exist_ok=False)
    manifest = {'schema': 'form-ios-simulator/v1', 'source_sha': args.sha,
                'status': 'failed', 'stage': 'identity', 'configuration': 'Release',
                'scheme': 'Form', 'architecture': 'arm64', 'signing': 'disabled',
                'api_url': 'http://127.0.0.1:9', 'authenticated_acceptance': False,
                'run_id': os.environ.get('GITHUB_RUN_ID'),
                'run_attempt': os.environ.get('GITHUB_RUN_ATTEMPT'),
                'runner_image': os.environ.get('ImageOS'),
                'runner_image_version': os.environ.get('ImageVersion'),
                'workflow_sha': os.environ.get('GITHUB_SHA')}
    env = os.environ.copy()
    device = None
    try:
        if not re.fullmatch('[0-9a-f]{40}', args.sha):
            raise ValueError('source SHA must be full lowercase hexadecimal')
        if capture(['git', 'rev-parse', 'HEAD'], cwd=source, env=env) != args.sha:
            raise ValueError('checkout does not match requested SHA')
        if capture(['git', 'status', '--porcelain'], cwd=source, env=env):
            raise ValueError('source checkout must be clean')
        if sys.platform != 'darwin' or capture(['uname', '-m'], cwd=source, env=env) != 'arm64':
            raise RuntimeError('requires an arm64 macOS runner')
        manifest['xcode'] = capture(['xcodebuild', '-version'], cwd=source, env=env)
        if manifest['xcode'] != 'Xcode 27.0\nBuild version 27A266a':
            raise RuntimeError('unexpected Xcode toolchain; requalify the image')
        manifest['sdk'] = capture(['xcrun', '--sdk', 'iphonesimulator', '--show-sdk-version'], cwd=source, env=env)
        manifest['node'] = capture(['node', '--version'], cwd=source, env=env)
        manifest['cocoapods'] = capture(['pod', '--version'], cwd=source, env=env)
        manifest['package_lock_sha256'] = sha256(source / 'apps/form/package-lock.json')
        with owned_scratch(Path(args.scratch_parent).resolve(), manifest) as scratch:
            env.update(TMPDIR=str(scratch), TMP=str(scratch), TEMP=str(scratch),
                       npm_config_cache=str(scratch / 'npm-cache'),
                       CP_HOME_DIR=str(scratch / 'cocoapods-home'),
                       CP_CACHE_DIR=str(scratch / 'cocoapods-cache'),
                       COCOAPODS_DISABLE_STATS='true',
                       EXPO_NO_DOTENV='1', EXPO_NO_TELEMETRY='1', CI='1',
                       EXPO_PUBLIC_FORM_API_URL='http://127.0.0.1:9')
            archive = scratch / 'source.tar'
            subprocess.run(['git', 'archive', '--format=tar', '-o', str(archive), args.sha],
                           cwd=source, check=True)
            tree = scratch / 'source'
            tree.mkdir()
            with tarfile.open(archive) as package:
                package.extractall(tree, filter='data')
            app = tree / 'apps/form'
            manifest['stage'] = 'install'
            run(['npm', 'ci', '--no-audit', '--no-fund'], cwd=app, env=env, log=output / 'install.log')
            autolinking = capture(['node', 'node_modules/expo-modules-autolinking/bin/expo-modules-autolinking.js',
                                   'resolve', '--platform', 'apple'], cwd=app, env=env)
            (output / 'autolinking.json').write_text(autolinking + '\n')
            for name in ['FormSpeech', 'FormStoreKit', 'FormHealth', 'FormPhotoCapture', 'FormVoice']:
                if name not in autolinking:
                    raise RuntimeError('missing local native module in autolinking: ' + name)
            manifest['stage'] = 'prebuild'
            template = scratch / 'expo-template.tgz'
            urllib.request.urlretrieve('https://registry.npmjs.org/expo-template-bare-minimum/-/expo-template-bare-minimum-57.0.26.tgz', template)
            template_hash = '6b19d4235ab57c66fac699de7a2c57fe0ea277bf8a355ed45b2a37258bd93366'
            if sha256(template) != template_hash:
                raise RuntimeError('Expo template integrity mismatch')
            manifest['template_sha256'] = template_hash
            run(['node', 'node_modules/expo/bin/cli', 'prebuild', '--platform', 'ios', '--no-install',
                 '--template', str(template), '--skip-dependency-update', 'expo,react,react-native'],
                cwd=app, env=env, log=output / 'prebuild.log')
            if sha256(app / 'package-lock.json') != manifest['package_lock_sha256']:
                raise RuntimeError('prebuild changed the locked dependencies')
            (output / 'generated-package.json').write_text((app / 'package.json').read_text())
            manifest['stage'] = 'pods'
            run(['pod', 'install'], cwd=app / 'ios', env=env, log=output / 'pods.log')
            (app / 'ios/.xcode.env.local').write_text('export NODE_BINARY=' + json.dumps(shutil.which('node')) + '\n')
            manifest['pod_lock_sha256'] = sha256(app / 'ios/Podfile.lock')
            manifest['stage'] = 'build'
            derived = scratch / 'DerivedData'
            run(['xcodebuild', '-workspace', str(app / 'ios/Form.xcworkspace'),
                 '-scheme', 'Form', '-configuration', 'Release', '-sdk', 'iphonesimulator',
                 '-destination', 'generic/platform=iOS Simulator', '-derivedDataPath', str(derived),
                 '-jobs', '1', 'ARCHS=arm64', 'ONLY_ACTIVE_ARCH=YES',
                 'CODE_SIGNING_ALLOWED=NO', 'CODE_SIGNING_REQUIRED=NO', 'CODE_SIGN_IDENTITY=', 'build'],
                cwd=app, env=env, log=output / 'xcodebuild.log')
            built = derived / 'Build/Products/Release-iphonesimulator/Form.app'
            bundle = built / 'main.jsbundle'
            if not bundle.is_file() or not bundle.stat().st_size:
                raise RuntimeError('Release app is missing its embedded JS bundle')
            manifest['embedded_js_sha256'] = sha256(bundle)
            manifest['executable_sha256'] = sha256(built / 'Form')
            manifest['stage'] = 'package'
            zipped = output / 'Form-simulator-arm64.zip'
            run(['ditto', '-c', '-k', '--sequesterRsrc', '--keepParent', str(built), str(zipped)],
                cwd=app, env=env, log=output / 'package.log')
            manifest['archive_sha256'] = sha256(zipped)
            manifest['stage'] = 'simulator'
            runtime = 'com.apple.CoreSimulator.SimRuntime.iOS-27-0'
            device_type = 'com.apple.CoreSimulator.SimDeviceType.iPhone-17'
            device = capture(['xcrun', 'simctl', 'create', 'Form-CI-' + args.sha[:12], device_type, runtime],
                             cwd=app, env=env)
            manifest.update(simulator_udid=device, simulator_runtime=runtime, simulator_device_type=device_type)
            for command in [['boot', device], ['bootstatus', device, '-b'],
                            ['install', device, str(built)]]:
                run(['xcrun', 'simctl', *command], cwd=app, env=env, log=output / 'simulator.log')
            manifest['stage'] = 'launch'
            bundle_id = 'com.jonessystems.form.private'
            launch_epoch = time.time()
            manifest['launch_started_epoch'] = launch_epoch
            launched = capture(['xcrun', 'simctl', 'launch', device, bundle_id], cwd=app, env=env)
            (output / 'launch.txt').write_text(launched + '\n')
            manifest['launch_result'] = launched
            pid = launched.rsplit(': ', 1)[-1]
            if not pid.isdigit():
                raise RuntimeError('simctl did not return an app process ID')
            time.sleep(15)
            check_launch(device=device, bundle_id=bundle_id, pid=pid, launch_epoch=launch_epoch,
                         built=built, cwd=app, env=env, output=output, manifest=manifest)
            manifest.update(status='passed', stage='complete', process_alive_after_seconds=15)
    except BaseException as exc:
        manifest['error'] = str(exc)
        raise
    finally:
        if device:
            for operation in ['shutdown', 'delete']:
                result = subprocess.run(['xcrun', 'simctl', operation, device], capture_output=True, text=True)
                if result.returncode:
                    manifest.setdefault('cleanup_errors', []).append(operation + ': ' + result.stderr.strip())
        manifest['scratch_removed'] = not Path(manifest.get('scratch_root', '/')).exists()
        cleanup_failed = bool(manifest.get('cleanup_errors')) and manifest['status'] == 'passed'
        if cleanup_failed:
            manifest['status'] = 'failed'
        (output / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
        print('Build manifest:\n' + json.dumps(manifest, indent=2), flush=True)
        if cleanup_failed:
            raise RuntimeError('simulator cleanup failed; see manifest')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for option in ['source', 'output', 'scratch-parent', 'sha']:
        parser.add_argument('--' + option, required=True)
    for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        signal.signal(sig, interrupted)
    build(parser.parse_args())
