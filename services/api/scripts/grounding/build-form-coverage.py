"""Build the separate Form corpus; the receipt is evidence, not a runtime trust anchor."""
import hashlib
import json
import os
from pathlib import Path
import signal
import stat
import sys
import tempfile
from types import SimpleNamespace

REPO = Path(__file__).absolute().parents[4]
REVISION = '0c68e72727f04a7307407a4a6b73d43b7dca61a6'
REPOSITORY = 'Jones-Systems/Form'
CORPUS_ROOT = 'docs/knowledge/research-followups'
DECLARATION_PATH = CORPUS_ROOT + '/source-inputs.json'
DECLARATION_SHA = '9d4fbc8208b1fdfa62abb4c15f6a81eed39b6aa1870cbc4459f3c8648e0e5b00'
DECLARATION_BYTES = 10041
HELPER_PATH = 'services/api/scripts/grounding/build-projection.py'
HELPER_SHA = 'df50c11dddfa448a54dadb7280dbabf1c35991a0b3cd644cb4a2f9e703f150d2'
RECORD_TOPICS = {
    'ANA-S10': ['ANA-C2'], 'ANA-S11': ['ANA-C2'],
    'ANA-S12': ['ANA-C2'], 'ANA-S13': ['ANA-C2'],
    'BCM-S09': ['BCM-Z1'], 'BCM-S10': ['BCM-Z1'], 'BEH-S14': ['BEH-X1'],
    'FLE-S01': ['EXU-B5', 'DOS-E1'], 'FLE-S02': ['EXU-B5', 'DOS-E1'],
    'FLE-S03': ['EXU-B5', 'DOS-E1'], 'FLE-S04': ['EXU-B5', 'DOS-E1'],
    'FLE-S05': ['EXU-B5', 'DOS-E1'],
    'HLT-S13': ['HLT-Y1'], 'HLT-S14': ['HLT-Y1'],
    'HLT-S15': ['HLT-Y1'], 'HLT-S16': ['HLT-Y1'],
    'HLT-S17': ['HLT-Y1'], 'HLT-S18': ['HLT-Y1'],
    'HLT-S19': ['HLT-Y1'], 'HLT-S20': ['HLT-Y1'],
    'HLT-S21': ['HLT-Y1'], 'HLT-S22': ['HLT-Y1'],
    'HLT-S23': ['HLT-Y1'], 'HLT-S24': ['HLT-Y1', 'EXU-B4'],
    'HLT-S25': ['HLT-Y1'], 'NUT-S034': ['NUT-I3'],
}


def load_helpers():
    # Bootstrap only the pinned helper; subsequent reads reuse its safe reader.
    path = REPO / HELPER_PATH
    descriptor = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    child = None
    try:
        for part in path.parent.parts[1:]:
            next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = next_fd
        child = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=descriptor)
        if not stat.S_ISREG(os.fstat(child).st_mode):
            raise ValueError('publication helper must be a regular file')
        with os.fdopen(child, 'rb', closefd=False) as handle:
            content = handle.read()
    finally:
        if child is not None:
            os.close(child)
        os.close(descriptor)
    if hashlib.sha256(content).hexdigest() != HELPER_SHA:
        raise ValueError('publication helper digest mismatch')
    namespace = {'__name__': 'form_verified_publication_helpers', '__file__': str(path)}
    exec(compile(content, HELPER_PATH, 'exec'), namespace)
    return SimpleNamespace(**namespace)


HELPERS = load_helpers()
BuildError = HELPERS.BuildError
BuildCancelled = HELPERS.BuildCancelled
require = HELPERS.require
digest = HELPERS.digest
read_regular = HELPERS.read_regular
directory = HELPERS.directory
rename_exclusive = HELPERS.rename_exclusive
verify_bundle = HELPERS.verify_bundle
cancel = HELPERS.cancel


def verify_ancestry(declaration, witnesses):
    manifest = json.loads(witnesses['sources/manifest.json'])
    group = next(item for item in manifest['groups'] if item['id'] == 'BL-CORE')
    for identity, local_path in (
        (declaration['source_plan']['retained_ancestry'], declaration['source_plan']['path']),
        (declaration['projector'], declaration['projector']['local_path']),
    ):
        matches = [item for item in manifest['files'] if item['group'] == 'BL-CORE'
                   and item['source_path'] == identity['path']]
        require(len(matches) == 1, 'retained ancestry entry mismatch')
        entry = matches[0]
        require(identity['repository'] == 'Jones-Systems/BusinessLessons'
                and entry['revision'] == identity['revision'] == group['revision']
                and entry['repository'] == group['source_repository']
                and entry['git_blob'] == identity['git_blob']
                and entry['destination'] == local_path
                and len(witnesses[local_path]) == entry['bytes']
                and digest(witnesses[local_path]) == entry['sha256'], 'retained ancestry mismatch')
    packets = declaration.get('retained_packets')
    require(type(packets) is list and len(packets) == 1, 'retained packet binding count mismatch')
    packet = packets[0]
    require(type(packet) is dict and set(packet) == {
        'repository', 'revision', 'path', 'git_blob', 'local_path', 'destination', 'bytes', 'sha256',
    }, 'retained packet binding fields mismatch')
    require(packet['path'] == 'research/form-knowledge-campaign-2026-10-01/sources/stretch-rom-008.md'
            and packet['local_path'] == 'sources/businesslessons/core/' + packet['path']
            and packet['destination'] == CORPUS_ROOT + '/sources/stretch-rom-008.md',
            'retained packet path mismatch')
    matches = [item for item in manifest['files'] if item['group'] == 'BL-CORE'
               and item['source_path'] == packet['path']]
    require(len(matches) == 1, 'retained packet manifest entry mismatch')
    entry = matches[0]
    original = witnesses.get(packet['local_path'])
    copied = witnesses.get(packet['destination'])
    require(type(original) is bytes and type(copied) is bytes, 'retained packet witness missing')
    require(packet['repository'] == 'Jones-Systems/BusinessLessons'
            and packet['revision'] == entry['revision'] == group['revision']
            and entry['repository'] == group['source_repository']
            and packet['git_blob'] == entry['git_blob']
            and packet['local_path'] == entry['destination']
            and len(original) == entry['bytes'] == packet['bytes']
            and digest(original) == entry['sha256'] == packet['sha256']
            and copied == original, 'retained packet ancestry or copy mismatch')
    return group['source_repository']


def validate_corpus(corpus, declaration, expected_coverage, expected_inputs, canonical_bytes):
    expected = declaration['expected']
    require(corpus['schema'] == 'form.source-observation-projection/v1'
            and corpus['projector_version'] == '1', 'projection schema mismatch')
    require(corpus['inputs'] == expected_inputs, 'projected input set mismatch')
    require(corpus['corpus_input_sha256'] == digest(canonical_bytes(expected_inputs)), 'corpus input digest mismatch')
    cover = corpus['coverage']
    require(cover == expected_coverage, 'projected coverage identity mismatch')
    require(cover['source_plan'] == declaration['source_plan']['path']
            and cover['source_plan_revision'] == declaration['source_plan']['revision'], 'source plan binding mismatch')
    units = cover['units']
    require(len(units) == expected['coverage_units'] == 106, 'coverage count mismatch')
    partial = set(expected['partial_units'])
    require(partial == {'ANA-C2', 'BCM-Z1', 'BEH-X1', 'DOS-E1', 'EXU-B4', 'EXU-B5', 'HLT-Y1', 'NUT-I3'} and expected['unsearched_units'] == 98, 'local coverage expectation mismatch')
    require(all(unit['state'] == ('partial' if unit['unit_id'] in partial else 'unsearched')
                for unit in units), 'local coverage state mismatch')
    require(sum(unit['state'] == 'unsearched' for unit in units) == 98, 'local unsearched count mismatch')
    records = corpus['records']
    require([entry['record']['id'] for entry in records] == expected['records'] == sorted(RECORD_TOPICS), 'record ID set mismatch')
    inputs = {entry['source_path']: entry['sha256'] for entry in expected_inputs}
    for entry in records:
        record = entry['record']
        require(record['topic_ids'] == RECORD_TOPICS[record['id']]
                and record['clinical_readiness'] == 'CL-0', 'record topic or maturity mismatch')
        require(entry['source_path'].startswith('sources/')
                and entry['source_packet_sha256'] == inputs.get(entry['source_path'])
                and type(entry['line']) is int and entry['line'] > 0, 'record provenance mismatch')
    status = corpus['corpus_status']
    missing = sorted(unit['unit_id'] for unit in units if unit['unit_id'] not in partial)
    require(status['state'] == 'partial' and status['clinical_readiness'] == 'CL-0'
            and status['units_without_observations'] == missing
            and len(missing) == expected['units_without_observations'] == 98
            and status['source_packets_without_records'] == expected['source_packets_without_records'] == [],
            'corpus maturity or omissions mismatch')


def render(repo):
    repo = Path(repo)
    declaration_bytes = read_regular(repo, DECLARATION_PATH)
    require(len(declaration_bytes) == DECLARATION_BYTES and digest(declaration_bytes) == DECLARATION_SHA,
            'source declaration bytes mismatch')
    declaration = json.loads(declaration_bytes)
    require(declaration['schema'] == 'form.followup-corpus-inputs/v1'
            and declaration['repository'] == REPOSITORY and declaration['corpus_root'] == CORPUS_ROOT,
            'source declaration identity mismatch')
    witnesses = {}
    for entry in declaration['files']:
        require(entry['path'] not in witnesses, 'duplicate input witness')
        content = read_regular(repo, entry['path'])
        require(len(content) == entry['bytes'] and digest(content) == entry['sha256'],
                'input witness bytes mismatch: ' + entry['path'])
        witnesses[entry['path']] = content
    require(len(witnesses) == 28, 'input witness count mismatch')
    require(digest(witnesses[HELPER_PATH]) == HELPER_SHA, 'publication helper identity mismatch')
    historical_repository = verify_ancestry(declaration, witnesses)
    expected_inputs = [{'source_path': path, 'sha256': digest(witnesses[CORPUS_ROOT + '/' + path])}
                       for path in declaration['projector_inputs']]
    require(len(expected_inputs) == 23 and expected_inputs == sorted(expected_inputs, key=lambda item: item['source_path']),
            'projector input declaration mismatch')
    source_fd = directory(repo / CORPUS_ROOT / 'sources')
    try:
        require(set(os.listdir(source_fd)) == {item['source_path'].removeprefix('sources/')
                for item in expected_inputs if item['source_path'].startswith('sources/')}, 'source packet directory mismatch')
    finally:
        os.close(source_fd)
    projector = declaration['projector']
    projector_bytes = witnesses[projector['local_path']]
    require(digest(projector_bytes) == projector['sha256'], 'projector identity mismatch')
    namespace = {'__name__': 'form_verified_followup_projector', '__file__': str(repo / projector['local_path'])}
    exec(compile(projector_bytes, projector['local_path'], 'exec'), namespace)
    canonical = namespace['canonical_bytes']
    cover_blocks = namespace['json_blocks'](witnesses[CORPUS_ROOT + '/coverage.md'].decode('utf-8'), 'coverage.md')
    require(len(cover_blocks) == 1, 'coverage witness block mismatch')
    cover = cover_blocks[0][0]
    expected_coverage = dict(cover, units=sorted(cover['units'], key=lambda item: item['unit_id']))
    corpus = namespace['load_corpus'](repo / CORPUS_ROOT)
    validate_corpus(corpus, declaration, expected_coverage, expected_inputs, canonical)
    projection = canonical(corpus)
    receipt = {
        'schema': 'form.followup-grounding-artifact/v1', 'authority_effect': 'none',
        'source': {'repository': REPOSITORY, 'revision': REVISION, 'corpusRoot': CORPUS_ROOT,
                   'corpusInputSha256': corpus['corpus_input_sha256']},
        'source_declaration': {'path': DECLARATION_PATH, 'sha256': DECLARATION_SHA, 'bytes': DECLARATION_BYTES},
        'source_plan': declaration['source_plan'], 'projector': projector,
        'retained_packets': declaration['retained_packets'],
        'publication_helper': declaration['publication_helper'],
        'retained_manifest_sha256': digest(witnesses['sources/manifest.json']),
        'historical_source_repository': historical_repository,
        'projection_sha256': digest(projection), 'projection_bytes': len(projection),
        'input_count': len(expected_inputs), 'observation_count': len(corpus['records']),
        'coverage_unit_count': len(corpus['coverage']['units']),
    }
    return {'projection.json': projection, 'receipt.json': canonical(receipt)}


def publish(parent, files):
    require(set(files) == {'projection.json', 'receipt.json'} and all(type(value) is bytes for value in files.values()),
            'expected projection and receipt bytes')
    parent = Path(parent)
    os.close(directory(parent))
    target = parent / digest(files['projection.json'])
    if os.path.lexists(target):
        verify_bundle(target, files)
        return target
    # Only this invocation's staging root is cleaned; a racing destination is verified, never replaced.
    with tempfile.TemporaryDirectory(prefix='.form-coverage-build-', dir=parent) as temporary:
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


def main():
    previous = {number: signal.signal(number, cancel) for number in (signal.SIGINT, signal.SIGTERM)}
    try:
        target = build(REPO)
        print('Form coverage artifact: dist/grounding/' + target.name)
        print('Output digest measured by this build; consumer trust anchor requires the accepted output declaration.')
        return 0
    except BuildCancelled as exc:
        print('Form coverage build cancelled', file=sys.stderr)
        return 128 + exc.signum
    except Exception as exc:
        print('Form coverage build failed: ' + str(exc), file=sys.stderr)
        return 2
    finally:
        for number, handler in previous.items():
            signal.signal(number, handler)


if __name__ == '__main__':
    raise SystemExit(main())
