"""Build the pinned retained corpus; runtime consumers receive bytes, not source paths."""
import ctypes
import errno
import hashlib
import json
import os
from pathlib import Path
import signal
import stat
import sys
import tempfile

MANIFEST_SHA = 'bb87a03258981f3b85612ebd8b9a61b8933220e59cfd29ddb58ed349b3814dc7'
PROJECTOR_SHA = '6622ddcd2b2f1ded4fded23fb5b53caa5fa67e0db8159efd799ad81352551345'
PROJECTOR_BLOB = 'e7522bc0d3d88e6abec84a508a3e40ba9d5873e7'
REVISION = '7636efca55195b1dc6a5980864452575478116b7'
INPUT_SHA = '78ffb7674b95dfb946f9f30d318ba6dfa07332cad364298f6c7daf4c8055b824'
OUTPUT_SHA = '84530977a646d138ff1194d22d8723989ff6646dc3f69a8ab5c390783de55ad8'
OUTPUT_BYTES = 1488603
REPOSITORY = 'Jones-Systems/BusinessLessons'
RETAINED_ROOT = 'sources/businesslessons/core'
CORPUS_ROOT = 'research/form-knowledge-campaign-2026-10-01'
PROJECTOR_PATH = RETAINED_ROOT + '/scripts/form_corpus.py'


class BuildError(ValueError):
    pass


class BuildCancelled(BaseException):
    def __init__(self, signum):
        self.signum = signum


def require(condition, message):
    if not condition:
        raise BuildError(message)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def directory(path):
    """Open every path component without following symlinks, including ancestors."""
    path = Path(os.path.abspath(path))
    descriptor = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in path.parts[1:]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = child
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


def read_regular(root, relative):
    path = Path(relative)
    require(not path.is_absolute() and all(p not in ('', '.', '..') for p in relative.split('/')), 'invalid retained relative path')
    descriptor = directory(Path(root) / path.parent)
    child = None
    try:
        child = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=descriptor)
        require(stat.S_ISREG(os.fstat(child).st_mode), 'expected regular retained file')
        with os.fdopen(child, 'rb', closefd=False) as handle:
            return handle.read()
    finally:
        if child is not None:
            os.close(child)
        os.close(descriptor)


def render(repo):
    manifest_bytes = read_regular(repo, 'sources/manifest.json')
    require(digest(manifest_bytes) == MANIFEST_SHA, 'retained manifest digest mismatch')
    manifest = json.loads(manifest_bytes)
    group = next(group for group in manifest['groups'] if group['id'] == 'BL-CORE')
    require(group['revision'] == REVISION and group['destination'] == RETAINED_ROOT, 'retained group identity mismatch')
    prefix = CORPUS_ROOT + '/'
    selected = [entry for entry in manifest['files'] if entry['group'] == 'BL-CORE' and (
        entry['source_path'] == 'scripts/form_corpus.py'
        or entry['source_path'] == prefix + 'coverage.md'
        or entry['source_path'].startswith(prefix + 'sources/')
        and '/' not in entry['source_path'][len(prefix + 'sources/'):]
        and entry['source_path'].endswith('.md'))]
    require(len(selected) == 99, 'expected 98 corpus inputs and one projector')
    expected_inputs = {}
    projector_bytes = None
    for entry in selected:
        require(entry['revision'] == REVISION and entry['repository'] == group['source_repository'], 'retained file revision mismatch')
        require(entry['destination'] == RETAINED_ROOT + '/' + entry['source_path'], 'retained destination mismatch')
        content = read_regular(repo, entry['destination'])
        require(len(content) == entry['bytes'] and digest(content) == entry['sha256'], 'retained file bytes mismatch: ' + entry['source_path'])
        if entry['source_path'] == 'scripts/form_corpus.py':
            require(entry['git_blob'] == PROJECTOR_BLOB and digest(content) == PROJECTOR_SHA, 'projector identity mismatch')
            projector_bytes = content
        else:
            relative = entry['source_path'][len(prefix):]
            require(relative not in expected_inputs, 'duplicate retained input')
            expected_inputs[relative] = entry['sha256']
    require(projector_bytes is not None and len(expected_inputs) == 98, 'missing retained input')
    # Execute the bytes just verified, never an import that can reread changed source or write bytecode.
    namespace = {'__name__': 'form_retained_projector', '__file__': str(Path(repo) / PROJECTOR_PATH)}
    exec(compile(projector_bytes, PROJECTOR_PATH, 'exec'), namespace)
    corpus = namespace['load_corpus'](Path(repo) / RETAINED_ROOT / CORPUS_ROOT)
    actual_inputs = {item['source_path']: item['sha256'] for item in corpus['inputs']}
    require(len(corpus['inputs']) == 98 and actual_inputs == expected_inputs, 'projected input set mismatch')
    require(corpus['corpus_input_sha256'] == INPUT_SHA and len(corpus['records']) == 838 and len(corpus['coverage']['units']) == 106, 'projected corpus identity mismatch')
    projection = namespace['canonical_bytes'](corpus)
    require(len(projection) == OUTPUT_BYTES and digest(projection) == OUTPUT_SHA, 'projection bytes mismatch')
    receipt = {
        'schema': 'form.retained-grounding-artifact/v1', 'authority_effect': 'none',
        'manifest_sha256': MANIFEST_SHA, 'repository': REPOSITORY, 'revision': REVISION,
        'historical_source_repository': group['source_repository'],
        'projector': {'retained_path': PROJECTOR_PATH, 'sha256': PROJECTOR_SHA, 'git_blob': PROJECTOR_BLOB},
        'corpus_root': CORPUS_ROOT, 'corpus_input_sha256': INPUT_SHA,
        'projection_sha256': OUTPUT_SHA, 'projection_bytes': OUTPUT_BYTES,
        'input_count': 98, 'observation_count': 838, 'coverage_unit_count': 106,
    }
    return {'projection.json': projection, 'receipt.json': namespace['canonical_bytes'](receipt)}


def rename_exclusive(source, target):
    # Linux RENAME_NOREPLACE prevents even an empty destination directory from being overwritten.
    require(sys.platform == 'linux', 'artifact publication requires Linux renameat2')
    libc = ctypes.CDLL(None, use_errno=True)
    rename = getattr(libc, 'renameat2', None)
    require(rename is not None, 'Linux renameat2 unavailable; no overwrite fallback')
    rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    rename.restype = ctypes.c_int
    if rename(-100, os.fsencode(source), -100, os.fsencode(target), 1) != 0:
        error = ctypes.get_errno()
        if error == errno.EEXIST:
            raise FileExistsError(error, os.strerror(error), str(target))
        raise OSError(error, os.strerror(error), str(target))


def verify_bundle(target, files):
    descriptor = directory(target)
    try:
        require(set(os.listdir(descriptor)) == set(files), 'existing artifact file set mismatch')
    finally:
        os.close(descriptor)
    for name, content in files.items():
        require(read_regular(target, name) == content, 'existing artifact bytes mismatch: ' + name)


def publish(parent, files):
    parent = Path(parent)
    os.close(directory(parent))
    target = parent / OUTPUT_SHA
    if os.path.lexists(target):
        verify_bundle(target, files)
        return target
    # The unique staging root is invocation-owned; only its complete child is published.
    with tempfile.TemporaryDirectory(prefix='.grounding-build-', dir=parent) as temporary:
        stage = Path(temporary) / 'bundle'
        stage.mkdir()
        for name, content in files.items():
            with (stage / name).open('xb') as handle:
                handle.write(content)
        try:
            rename_exclusive(stage, target)
        except FileExistsError:
            verify_bundle(target, files)
        verify_bundle(target, files)
    return target


def build(repo):
    repo = Path(repo)
    files = render(repo)
    descriptor = directory(repo)
    try:
        for part in ('services', 'api', 'dist', 'grounding'):
            try:
                os.mkdir(part, dir_fd=descriptor)
            except FileExistsError:
                pass
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = child
    finally:
        os.close(descriptor)
    return publish(repo / 'services/api/dist/grounding', files)


def cancel(signum, frame):
    raise BuildCancelled(signum)


def main():
    previous = {number: signal.signal(number, cancel) for number in (signal.SIGINT, signal.SIGTERM)}
    try:
        target = build(Path(__file__).absolute().parents[4])
        print('Retained grounding artifact: dist/grounding/' + target.name)
        return 0
    except BuildCancelled as exc:
        print('grounding artifact build cancelled', file=sys.stderr)
        return 128 + exc.signum
    except Exception as exc:
        print('grounding artifact build failed: ' + str(exc), file=sys.stderr)
        return 2
    finally:
        for number, handler in previous.items():
            signal.signal(number, handler)


if __name__ == '__main__':
    raise SystemExit(main())
