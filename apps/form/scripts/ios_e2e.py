"""Synthetic installed-app acceptance; the caller owns scratch and the simulator."""

from collections import Counter
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import selectors
import signal
import stat
import struct
import subprocess
import sys
import time
import urllib.request
import xml.etree.ElementTree as ET
import zipfile
import zlib

MAESTRO_VERSION = '2.11.0'
MAESTRO_SHA256 = '5384593cb4e7a106489e75a821d157dd43f4e438df6bc308b72e82c685e1283a'
MAESTRO_URL = 'https://github.com/mobile-dev-inc/Maestro/releases/download/cli-2.11.0/maestro.zip'
SIGNALS = (signal.SIGINT, signal.SIGTERM, signal.SIGHUP)
FLOW_NAMES = ['01-auth-create', '02-onboarding-first-plan', '03-workout-log',
              '04-restore-signout', '05-authoritative-401', '06-settings',
              '07-body-session-only']


def sha256(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def load_contract(path):
    data = json.loads(path.read_text())
    if (data.get('schema') != 'form.native-e2e/v1'
            or data.get('api_origin') != 'http://127.0.0.1:47621'
            or data.get('control_port') != 47622
            or data.get('flows') != [{'name': name, 'screenshot': name} for name in FLOW_NAMES]):
        raise ValueError('unexpected native E2E contract')
    for section, fields in [('account', ('email', 'password', 'name')),
                            ('expected', ('displayName', 'loadUnit'))]:
        if not all(isinstance(data.get(section, {}).get(key), str)
                   and data[section][key] for key in fields):
            raise ValueError('missing native E2E ' + section)
    if not data['account']['email'].endswith('@synthetic.invalid'):
        raise ValueError('E2E requires a synthetic account')
    return data


def install_maestro(scratch, download=urllib.request.urlretrieve):
    archive = scratch / 'maestro.zip'
    download(MAESTRO_URL, archive)
    if sha256(archive) != MAESTRO_SHA256:
        raise ValueError('Maestro ZIP checksum mismatch; nothing executed')
    destination = scratch / 'maestro-cli'
    destination.mkdir()
    with zipfile.ZipFile(archive) as package:
        for item in package.infolist():
            target = destination / item.filename
            if not target.resolve().is_relative_to(destination.resolve()):
                raise ValueError('unsafe Maestro archive path')
            mode = item.external_attr >> 16
            if stat.S_ISLNK(mode):
                raise ValueError('unexpected Maestro archive symlink')
            package.extract(item, destination)
            if not item.is_dir():
                target.chmod(0o755 if mode & 0o111 else 0o644)
    binary = destination / 'maestro/bin/maestro'
    if not binary.is_file():
        raise ValueError('Maestro launcher missing')
    binary.chmod(0o755)
    return binary


def validate_junit(path, expected):
    root = ET.parse(path).getroot()
    if root.tag not in ('testsuites', 'testsuite'):
        raise ValueError('JUnit root is not a test suite')
    cases = list(root.iter('testcase'))
    if Counter(case.get('name') for case in cases) != Counter(expected):
        raise ValueError('JUnit requires every exact journey name once')
    for node in root.iter():
        if node.tag in ('failure', 'error', 'skipped'):
            raise ValueError('JUnit contains failure, error or skip')
        for key in ('failures', 'errors', 'skipped', 'disabled'):
            if key in node.attrib and int(node.get(key)) != 0:
                raise ValueError('JUnit reports ' + key)
        if node.tag in ('testsuites', 'testsuite') and 'tests' in node.attrib:
            if int(node.get('tests')) != len(list(node.iter('testcase'))):
                raise ValueError('JUnit test count mismatch')
    for case in cases:
        if case.get('status', 'PASSED').upper() not in ('PASSED', 'PASS'):
            raise ValueError('JUnit journey did not pass')
    return [case.get('name') for case in cases]


def validate_png(path):
    data = path.read_bytes()
    if data[:8] != b'\x89PNG\r\n\x1a\n':
        raise ValueError('invalid PNG signature: ' + path.name)
    offset, chunks, compressed, header = 8, [], bytearray(), None
    while offset < len(data):
        if offset + 12 > len(data):
            raise ValueError('truncated PNG chunk')
        size = struct.unpack('>I', data[offset:offset + 4])[0]
        kind = data[offset + 4:offset + 8]
        end = offset + 12 + size
        if end > len(data):
            raise ValueError('truncated PNG payload')
        payload = data[offset + 8:end - 4]
        if zlib.crc32(kind + payload) & 0xffffffff != struct.unpack('>I', data[end - 4:end])[0]:
            raise ValueError('PNG CRC mismatch')
        chunks.append(kind)
        if kind == b'IHDR':
            if len(chunks) != 1 or size != 13:
                raise ValueError('invalid PNG header')
            header = struct.unpack('>IIBBBBB', payload)
        elif kind == b'IDAT':
            compressed.extend(payload)
        elif kind == b'IEND':
            if size or end != len(data):
                raise ValueError('invalid PNG end')
        offset = end
    if not header or not compressed or chunks[-1:] != [b'IEND']:
        raise ValueError('incomplete PNG')
    width, height, depth, color, compression, filtering, interlace = header
    channels = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}.get(color)
    valid_depths = {0: (1, 2, 4, 8, 16), 2: (8, 16), 3: (1, 2, 4, 8), 4: (8, 16), 6: (8, 16)}
    if (not width or not height or not channels or depth not in valid_depths.get(color, ())
            or compression or filtering or interlace):
        raise ValueError('unsupported or invalid PNG image header')
    row_bytes = (width * channels * depth + 7) // 8
    expected = height * (1 + row_bytes)
    if expected > 100 * 1024 * 1024:
        raise ValueError('PNG decoded size exceeds evidence bound')
    decoder = zlib.decompressobj()
    decoded = decoder.decompress(bytes(compressed), expected + 1)
    if len(decoded) != expected or not decoder.eof or decoder.unused_data:
        raise ValueError('invalid PNG image data')
    if any(decoded[index] > 4 for index in range(0, len(decoded), row_bytes + 1)):
        raise ValueError('invalid PNG row filter')
    return {'width': width, 'height': height}


def validate_mp4(path):
    size = path.stat().st_size
    kinds = []
    with path.open('rb') as stream:
        offset = 0
        while offset < size:
            header = stream.read(8)
            if len(header) != 8:
                raise ValueError('truncated MP4 atom')
            length, kind = struct.unpack('>I4s', header)
            header_size = 8
            if length == 1:
                large = stream.read(8)
                if len(large) != 8:
                    raise ValueError('truncated MP4 large atom')
                length, header_size = struct.unpack('>Q', large)[0], 16
            elif length == 0:
                length = size - offset
            if length < header_size or offset + length > size:
                raise ValueError('invalid MP4 atom length')
            if length > header_size:
                kinds.append(kind)
            offset += length
            stream.seek(offset)
    if not all(kind in kinds for kind in (b'ftyp', b'moov', b'mdat')):
        raise ValueError('MP4 requires finalized moov and video payload')
    return {'bytes': size, 'finalized': True}


@contextmanager
def cleanup_signals(cancelled):
    previous = {sig: signal.signal(sig, signal.SIG_IGN) for sig in SIGNALS}
    try:
        yield
    finally:
        # Cancellation is already unwinding the entire driver; keep its cleanup uninterrupted.
        if not cancelled:
            for sig, handler in previous.items():
                signal.signal(sig, handler)


HOST_SETTLE_SECONDS = 240
HOST_SETTLE_INTERVAL = 5


def sample_load():
    try:
        return round(os.getloadavg()[0], 2)
    except OSError:
        return None


def settle_host(sleep=time.sleep, clock=time.monotonic):
    """Bounded wait for fresh-simulator background work to stop oversubscribing the host.

    Hosted runs showed trivial JVM starts taking 18s and local API calls exceeding
    the app's 15s request limit right after the new device booted. This never
    fails the run; it records the samples so the effect stays measurable.
    """
    cpus = os.cpu_count() or 1
    start, samples, settled = clock(), [], False
    while True:
        load, elapsed = sample_load(), round(clock() - start, 1)
        samples.append([elapsed, load])
        if load is None:
            break
        if load <= cpus:
            settled = True
            break
        if elapsed >= HOST_SETTLE_SECONDS:
            break
        sleep(HOST_SETTLE_INTERVAL)
    return {'cpu_count': cpus, 'threshold_load': cpus, 'settled': settled,
            'seconds': samples[-1][0], 'samples': samples[-60:]}


def signal_group(process, signum):
    """Signal an owned session group that may already have exited."""
    try:
        os.killpg(process.pid, signum)
    except ProcessLookupError:
        pass
    except PermissionError:
        # Darwin reports EPERM, not ESRCH, once only exited members remain.
        if process.poll() is None:
            raise


def diagnostic_capture(command, cwd, env, deadline, limit=65536):
    """Keep raw diagnostic bytes in bounded memory; always reap the owned probe group."""
    if time.monotonic() >= deadline:
        return 'timed_out', b''
    process = None
    data = bytearray()
    state = 'unavailable'
    try:
        process = subprocess.Popen(command, cwd=cwd, env=env, stdout=subprocess.PIPE,
                                   stderr=subprocess.DEVNULL, start_new_session=True)
        with selectors.DefaultSelector() as selector:
            selector.register(process.stdout, selectors.EVENT_READ)
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    state = 'timed_out'
                    break
                if not selector.select(remaining):
                    state = 'timed_out'
                    break
                block = os.read(process.stdout.fileno(), min(4096, limit + 1 - len(data)))
                if not block:
                    status = process.wait(timeout=max(0.001, deadline - time.monotonic()))
                    state = 'complete' if status == 0 else 'failed'
                    break
                data.extend(block)
                if len(data) > limit:
                    state = 'output_limit'
                    break
    except subprocess.TimeoutExpired:
        state = 'timed_out'
    except (KeyboardInterrupt, SystemExit):
        raise
    except Exception:
        state = 'unavailable'
    finally:
        if process is not None:
            # The probe has its own session; never signal the observed Maestro group here.
            with cleanup_signals(False):
                signal_group(process, signal.SIGKILL)
                process.wait(timeout=0.5)
                process.stdout.close()
    return state, bytes(data[:limit])


def sanitized_thread_frames(raw):
    """Omit thread names, lock identities, arbitrary text and VM properties."""
    frames = []
    for line in raw.decode('utf-8', errors='replace').splitlines():
        text = line.strip()
        if re.fullmatch(r'java\.lang\.Thread\.State: (NEW|RUNNABLE|BLOCKED|WAITING|TIMED_WAITING|TERMINATED)( \([a-z ]+\))?', text):
            frames.append(text.split(' (')[0])
        elif len(text) <= 512 and re.fullmatch(
                r'at (?:java|javax|jdk|sun|kotlin|kotlinx|maestro|picocli|okhttp3|okio|io\.grpc|com\.google)'
                r'[A-Za-z0-9_.$/]*(?:@[0-9.]+)?/[A-Za-z0-9_.$<>]+\((?:[A-Za-z0-9_$-]+\.(?:java|kt):[0-9]+|Native Method|Unknown Source)\)'
                r'|at (?:java|javax|jdk|sun|kotlin|kotlinx|maestro|picocli|okhttp3|okio|io\.grpc|com\.google)'
                r'\.[A-Za-z0-9_.$<>]+\((?:[A-Za-z0-9_$-]+\.(?:java|kt):[0-9]+|Native Method|Unknown Source)\)', text):
            frames.append(text)
        if len(frames) == 256:
            break
    return frames


class Children:
    def __init__(self, cwd, env, output):
        self.cwd, self.env, self.output = cwd, env, output
        self.processes = {}
        # Completed command durations separate slow startup from a hang across runs.
        self.durations = {}

    def start(self, name, command, env=None):
        if name in self.processes and self.processes[name].poll() is None:
            raise RuntimeError('child already running: ' + name)
        with (self.output / (name + '.log')).open('ab') as log:
            process = subprocess.Popen(command, cwd=self.cwd, env=env or self.env,
                                       stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        self.processes[name] = process
        return process

    def command(self, name, command, timeout=60):
        started = time.monotonic()
        process = self.start(name, command)
        try:
            status = process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            if name == 'maestro-version':
                self.maestro_timeout_diagnostic(process)
            raise TimeoutError(name + ' timed out') from None
        if status:
            # Arguments include the ephemeral control token; never embed them in an exception.
            raise RuntimeError(name + ' exited ' + str(status))
        self.durations[name] = round(time.monotonic() - started, 3)
        if name != 'maestro':
            self.stop(name, signal.SIGTERM, 2)
            del self.processes[name]
        return (self.output / (name + '.log')).read_text(errors='replace')

    def maestro_timeout_diagnostic(self, process):
        report = {'schema': 'form.maestro-timeout/v1', 'state': 'unavailable'}
        deadline = time.monotonic() + 4
        try:
            try:
                # Host saturation evidence that needs no subprocess or attach.
                report.update(load_average=[round(value, 2) for value in os.getloadavg()],
                              cpu_count=os.cpu_count())
            except OSError:
                pass
            def owned():
                return (self.processes.get('maestro-version') is process and process.poll() is None
                        and os.getpgid(process.pid) == process.pid)
            if not owned():
                report['state'] = 'ownership_unavailable'
                return
            report.update(pid=process.pid, process_group=process.pid)
            state, raw = diagnostic_capture(['/bin/ps', '-p', str(process.pid), '-o', 'pid=,pgid=,state=,comm='],
                                            self.cwd, {}, min(deadline, time.monotonic() + 1))
            report['process_probe'] = state
            fields = raw.decode('utf-8', errors='replace').strip().split(maxsplit=3)
            if state != 'complete' or len(fields) != 4 or fields[:2] != [str(process.pid)] * 2:
                return
            if re.fullmatch(r'[RSDTIZUXW][A-Za-z+<Nsl]*', fields[2]):
                report['process_state'] = fields[2][0]
            home = Path(self.env.get('JAVA_HOME', ''))
            java, jcmd = home / 'bin/java', home / 'bin/jcmd'
            if not home.is_absolute() or not java.is_file() or not jcmd.is_file():
                report['state'] = 'java_tool_unavailable'
                return
            if not re.search(r'^JAVA_VERSION="17(?:[.\"]|$)', (home / 'release').read_text(), re.M):
                report['state'] = 'java_tool_unavailable'
                return
            if not Path(fields[3]).is_absolute() or Path(fields[3]).resolve() != java.resolve():
                report['state'] = 'leader_not_selected_java'
                return
            if not owned() or time.monotonic() >= deadline:
                report['state'] = 'ownership_unavailable'
                return
            # Attach only to the live owned leader after the pinned launcher has exec'd Java.
            probe_env = {'JAVA_HOME': str(home), 'PATH': str(home / 'bin'),
                         'JAVA_TOOL_OPTIONS': self.env.get('JAVA_TOOL_OPTIONS', '') + ' -XX:-UsePerfData'}
            state, raw = diagnostic_capture([str(jcmd), str(process.pid), 'Thread.print'],
                                            self.cwd, probe_env, deadline)
            report.update(state=state, frames=sanitized_thread_frames(raw))
        except (KeyboardInterrupt, SystemExit):
            report['state'] = 'interrupted'
            raise
        except Exception:
            report['state'] = 'unavailable'
        finally:
            # Ordinary diagnostic failure must not replace timeout; cancellation must reach caller cleanup.
            try:
                (self.output / 'maestro-version-diagnostic.json').write_text(json.dumps(report) + '\n')
            except Exception:
                pass

    def wait_ready(self, name, predicate, timeout):
        deadline = time.monotonic() + timeout
        while True:
            if self.processes[name].poll() is not None:
                raise RuntimeError(name + ' exited before ready')
            if predicate():
                return
            if time.monotonic() >= deadline:
                raise TimeoutError(name + ' readiness timed out')
            time.sleep(0.1)

    def stop(self, name, signum, timeout):
        process = self.processes.get(name)
        if process is None:
            return
        was_running = process.poll() is None
        # Signal the group even after its leader exited: driver descendants may remain.
        signal_group(process, signum)
        if was_running:
            try:
                process.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                signal_group(process, signal.SIGKILL)
                process.wait(timeout=0.3)
                raise RuntimeError(name + ' needed forced termination')
        signal_group(process, signal.SIGKILL)
        if name in ('recorder', 'backend'):
            if not was_running:
                raise RuntimeError(name + ' exited before requested teardown')
            if process.returncode not in (0, -signum, 128 + signum):
                raise RuntimeError(name + ' failed with status ' + str(process.returncode))

    def cleanup(self, manifest, original_error=None):
        cancelled = isinstance(original_error, (SystemExit, KeyboardInterrupt))
        with cleanup_signals(cancelled):
            for name, signum, timeout in [('recorder', signal.SIGINT, 4 if cancelled else 20),
                                          ('maestro', signal.SIGTERM, 1.5 if cancelled else 5),
                                          ('backend', signal.SIGTERM, 1 if cancelled else 5)]:
                try:
                    self.stop(name, signum, timeout)
                except Exception as exc:
                    manifest.setdefault('cleanup_errors', []).append(str(exc))
            for name in self.processes.keys() - {'recorder', 'maestro', 'backend'}:
                try:
                    self.stop(name, signal.SIGTERM, 0.2 if cancelled else 2)
                except Exception as exc:
                    manifest.setdefault('cleanup_errors', []).append(str(exc))
        if manifest.get('cleanup_errors') and original_error is None:
            raise RuntimeError('E2E child cleanup failed')


def maestro_command(binary, device, flows, output, variables):
    command = [str(binary), '--device', device, '--platform', 'ios', 'test',
               '--format', 'JUNIT', '--output', str(output / 'junit.xml'),
               '--test-output-dir', str(output / 'maestro-results'),
               '--debug-output', str(output / 'maestro-debug'), '--flatten-debug-output']
    for key, value in variables.items():
        command.extend(['-e', key + '=' + value])
    command.append(str(flows))
    return command


def redact_token(output, token):
    for path in output.rglob('*'):
        if path.is_file() and path.suffix.lower() in ('.log', '.json', '.xml', '.txt', '.yaml', '.yml', '.html'):
            data = path.read_bytes()
            if token.encode() in data:
                path.write_bytes(data.replace(token.encode(), b'[REDACTED-E2E-CONTROL-TOKEN]'))


def execute(*, tree, scratch, output, device, env, manifest):
    contract_path = tree / 'apps/form/e2e/journeys.json'
    contract = load_contract(contract_path)
    token = secrets.token_urlsafe(32)
    child_env = dict(env, E2E_CONTROL_TOKEN=token, MAESTRO_CLI_NO_ANALYTICS='1',
                     MAESTRO_DISABLE_UPDATE_CHECK='true', MAESTRO_API_URL='http://127.0.0.1:9',
                     XDG_STATE_HOME=str(scratch / 'maestro-state'),
                     JAVA_TOOL_OPTIONS='-Djava.io.tmpdir=' + str(scratch))
    children = Children(tree / 'services/api', child_env, output)
    manifest['startup_seconds'] = children.durations
    manifest.update(journeys_contract_sha256=sha256(contract_path), maestro_version=MAESTRO_VERSION,
                    maestro_zip_sha256=MAESTRO_SHA256)
    original_error = None
    database = scratch / 'backend-data'
    try:
        manifest['host_settle'] = settle_host()
        java = children.command('java-version', ['java', '-version'])
        match = re.search(r'version "(\d+)', java)
        if not match or int(match.group(1)) < 17:
            raise RuntimeError('Java 17 or newer is required')
        manifest['java'] = java.strip()
        binary = install_maestro(scratch)
        version = children.command('maestro-version', [str(binary), '--version'])
        if MAESTRO_VERSION not in version.splitlines():
            raise RuntimeError('unexpected Maestro version')
        manifest['maestro_reported_version'] = MAESTRO_VERSION
        ready = scratch / 'backend-ready.json'
        if database.exists() or ready.exists():
            raise RuntimeError('backend paths must be unused')
        children.start('backend', ['node', '--experimental-transform-types', '--import',
                                  './scripts/integration/source-hook.mjs', 'tests/e2e/native-backend.ts',
                                  '--origin', contract['api_origin'], '--control-port', str(contract['control_port']),
                                  '--allow-email', contract['account']['email'], '--root', str(database),
                                  '--ready', str(ready)])
        children.wait_ready('backend', ready.is_file, 60)
        state = json.loads(ready.read_text())
        control = 'http://127.0.0.1:' + str(contract['control_port'])
        if state.get('origin') != contract['api_origin'] or state.get('control_url') != control:
            raise RuntimeError('backend ready identity mismatch')
        children.start('recorder', ['xcrun', 'simctl', 'io', device, 'recordVideo', '--codec=h264',
                                    str(output / 'journeys.mp4')])
        children.wait_ready('recorder', lambda: 'Recording started' in
                            (output / 'recorder.log').read_text(errors='replace'), 30)
        variables = {'E2E_EMAIL': contract['account']['email'], 'E2E_PASSWORD': contract['account']['password'],
                     'E2E_NAME': contract['account']['name'], 'E2E_EXPECTED_NAME': contract['expected']['displayName'],
                     'E2E_EXPECTED_LOAD_UNIT': contract['expected']['loadUnit'],
                     'E2E_CONTROL_URL': control, 'E2E_CONTROL_TOKEN': token}
        children.command('maestro', maestro_command(binary, device, tree / 'apps/form/e2e/maestro',
                                                   output, variables), timeout=1200)
        manifest['journeys_passed'] = validate_junit(output / 'junit.xml', FLOW_NAMES)
        screenshots = {}
        for flow in contract['flows']:
            paths = list((output / 'maestro-results').rglob(flow['screenshot'] + '.png'))
            if len(paths) != 1:
                raise RuntimeError('expected one screenshot for ' + flow['name'])
            screenshots[str(paths[0].relative_to(output))] = validate_png(paths[0])
        manifest['journey_screenshots'] = screenshots
        request = urllib.request.Request(control + '/assert-final-state',
                    data=json.dumps(contract['expected']).encode(), method='POST',
                    headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})
        with urllib.request.urlopen(request, timeout=15) as response:
            if response.status != 200:
                raise RuntimeError('backend final state rejected')
            result = json.load(response)
        (output / 'backend-final-state.json').write_text(json.dumps(result, indent=2) + '\n')
        manifest['backend_final_state'] = result
    except BaseException as exc:
        original_error = exc
        raise
    finally:
        manifest['load_at_finish'] = sample_load()
        try:
            children.cleanup(manifest, original_error)
        finally:
            pending_error = sys.exc_info()[0] is not None or original_error is not None
            finalization_errors = []
            manifest['backend_root_removed'] = not database.exists()
            if not manifest['backend_root_removed']:
                finalization_errors.append('backend did not remove its owned database root')
            try:
                manifest['video'] = validate_mp4(output / 'journeys.mp4')
                manifest['video_validation'] = {'state': 'valid'}
            except (OSError, ValueError) as exc:
                state = 'unavailable' if isinstance(exc, FileNotFoundError) else 'invalid'
                manifest['video_validation'] = {'state': state, 'reason': str(exc)}
                finalization_errors.append('video evidence ' + state)
            try:
                redact_token(output, token)
            except Exception as exc:
                finalization_errors.append('evidence redaction: ' + str(exc))
            if finalization_errors:
                manifest.setdefault('evidence_errors', []).extend(finalization_errors)
                if not pending_error:
                    raise RuntimeError('; '.join(finalization_errors))


def write_evidence_manifest(output, manifest):
    summary = output / 'summary.md'
    summary.write_text('Native simulator ' + manifest.get('mode', 'launch') + ': **' + manifest['status'] + '**\n\n'
                       + 'Source: `' + manifest['source_sha'] + '`\n\n'
                       + 'Scope: ' + manifest.get('acceptance_scope', 'process survival and launch screenshot') + '\n\n'
                       + 'Journey results: ' + str(len(manifest.get('journeys_passed', []))) + '/7\n\n'
                       + 'Video validation: ' + manifest.get('video_validation', {}).get('state', 'unavailable') + '\n\n'
                       + 'Backend root removed: ' + str(manifest.get('backend_root_removed', 'unavailable')) + '\n\n'
                       + 'Cleanup errors: ' + str(len(manifest.get('cleanup_errors', []))) + '\n')
    manifest['evidence_sha256'] = {str(path.relative_to(output)): sha256(path)
                                 for path in sorted(output.rglob('*'))
                                 if path.is_file() and path != output / 'manifest.json'}
    path = output / 'manifest.json'
    path.write_text(json.dumps(manifest, indent=2) + '\n')
    destination = os.environ.get('GITHUB_STEP_SUMMARY')
    if destination:
        with open(destination, 'a') as stream:
            stream.write(summary.read_text() + '\nManifest SHA256: `' + sha256(path) + '`\n')
