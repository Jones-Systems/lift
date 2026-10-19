"""Generate Club Circuit (B) native inputs from the sealed b/v1 package.

Writes only inside this directory:
  generatedtokens.ts    tokens.py ts output for v1/tokens.json (canonical DTCG), unchanged
  generatedicons.ts     owned icon geometry (assets/icons/icons.json + SVG attributes)
  generatedfixtures.ts  v1/fixtures.json verbatim
  generatedguide.ts     design-system guide text parsed from the package and system prose
  evidence/generation.json  input/output sha256 and counts

The guide carries words and token paths only; every visual value is read from
generatedtokens.ts at render time. Refuses to run if the bound package hashes differ.
"""
import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path

import yaml

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[4]
PACKAGE = ROOT / 'design/form2-three-directions/b/v1'
SYSTEM = ROOT / 'design/form2-three-directions/b/system'
TOKENS_PY = ROOT / '.codex/skills/ui-design-craft/scripts/tokens.py'
BOUND = {
    'handoff.yaml': '311ed21bae060a56ded1d2fdca4944e3e0b94146d474a2c898001969d95b5231',
    'tokens.json': '67831f3764ec1079f08449f40ee0b7052cca4edc2d0d73cc8fe7ecd5d8894e07',
    'DESIGN.md': '8b8b3490c623f3ad8abf69fca6f42130d9e202f27892f740a360b1108fd86a16',
}
HEADER = '// Generated from the sealed b/v1 package by generate-source.py. Do not edit.\n'


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


for name, digest in BOUND.items():
    actual = sha(PACKAGE / name)
    if actual != digest:
        sys.exit(f'{name} sha256 {actual} does not match bound {digest}; refusing to generate.')

handoff = yaml.safe_load((PACKAGE / 'handoff.yaml').read_text())
if handoff.get('status') != 'ready' or handoff.get('version') != 1:
    sys.exit('handoff is not ready v1; refusing to generate.')

# ---- tokens: the skill's canonical generator, output kept byte-for-byte ----
tokens_ts = subprocess.run([sys.executable, str(TOKENS_PY), 'ts', str(PACKAGE / 'tokens.json')],
                           check=True, capture_output=True, text=True).stdout
(HERE / 'generatedtokens.ts').write_text(tokens_ts)

# ---- icons ----
icons_json = json.loads((PACKAGE / 'assets/icons/icons.json').read_text())
assets = {a['id'].removeprefix('icon.'): a for a in handoff['assets'] if a.get('kind') == 'svg'}
icons = {}
for name, info in icons_json.items():
    svg = (PACKAGE / f'assets/icons/{name}.svg').read_text()
    attr = lambda key: re.search(rf'\b{key}="([^"]+)"', svg).group(1)
    path_d = re.search(r'<path d="([^"]+)"', svg).group(1)
    if path_d != info['d']:
        sys.exit(f'icon {name}: SVG path differs from icons.json')
    icons[name] = {
        'd': info['d'], 'viewBox': attr('viewBox'), 'strokeLinecap': attr('stroke-linecap'),
        'strokeLinejoin': attr('stroke-linejoin'), 'sfSymbol': info['sf'], 'lucide': info['lucide'],
        'label': assets.get(name, {}).get('label'), 'decorative': bool(assets.get(name, {}).get('decorative')),
    }
(HERE / 'generatedicons.ts').write_text(HEADER + 'export const icons = ' + json.dumps(icons, ensure_ascii=False, indent=2) + ' as const;\nexport type IconName = keyof typeof icons;\n')

# ---- fixtures ----
fixtures = json.loads((PACKAGE / 'fixtures.json').read_text())
(HERE / 'generatedfixtures.ts').write_text(HEADER + 'export const fixtures = ' + json.dumps(fixtures, ensure_ascii=False, indent=2) + ' as const;\n')

# ---- guide ----
system_md = (SYSTEM / 'system.md').read_text()
contract_md = (SYSTEM / 'component-contract.md').read_text()
design_md = (PACKAGE / 'DESIGN.md').read_text()
flow_md = (PACKAGE / 'flow.md').read_text()
refs_md = (PACKAGE / 'references.md').read_text()


def clean(text: str) -> str:
    text = re.sub(r'\[([^\]]+)\]\([^)]+\)', r'\1', text)
    return text.replace('**', '').replace('`', '').strip()


def table(text: str) -> list[list[str]]:
    rows = [[clean(c) for c in line.strip().strip('|').split('|')]
            for line in text.splitlines() if line.startswith('|')]
    return [r for r in rows if not all(re.fullmatch(r':?-+:?', c) for c in r)]


def section(text: str, start: str, end: str | None = None) -> str:
    body = text.split(start, 1)[1]
    return body.split(end, 1)[0] if end else body


def paragraphs(text: str) -> list[str]:
    out = []
    for block in text.strip().split('\n\n'):
        block = block.strip()
        if not block or block.startswith('|') or block.startswith('#'):
            continue
        out.append(clean(' '.join(line.strip() for line in block.splitlines())))
    return out


def bullets(text: str) -> list[str]:
    return [clean(line[2:]) for line in text.splitlines() if line.startswith('- ')]


def with_header(rows: list[list[str]]) -> dict:
    return {'columns': rows[0], 'rows': rows[1:]}


type_table = table(section(system_md, '## 6. Type and rhythm', '## 7.'))
type_rows = []
type_ramp = {}
for row in type_table[1:]:
    token = row[0].removeprefix('type.')
    type_rows.append({'token': token, 'face': row[1], 'scale': row[2], 'dynamicType': row[3], 'use': row[4]})
    type_ramp[token] = row[3]
# type.wordmark and type.statusTime have no mapped Dynamic Type role in the package.

components = []
for chunk in re.split(r'\n## CMP-', contract_md)[1:]:
    first, body = chunk.split('\n', 1)
    number, name = first.split(' — ', 1)
    body = body.split('\n## Minimum live showcase', 1)[0]
    tables = []
    for block in re.split(r'\n\n', body):
        if block.strip().startswith('|'):
            tables.append(with_header(table(block)))
    variants = next((c['variants'] for c in handoff['components'] if c['id'].startswith(f'CMP-{number}-')), {})
    components.append({'id': f'CMP-{number}', 'name': clean(name), 'notes': paragraphs(body),
                       'tables': tables, 'variants': variants})

contrast = []
for line in (PACKAGE / 'contrast-report.txt').read_text().splitlines():
    m = re.match(r'PASS light (\S+) on (\S+) ([\d.]+):1 \(min ([\d.]+)\)', line)
    if m:
        contrast.append({'fg': m.group(1), 'bg': m.group(2), 'ratio': m.group(3), 'min': m.group(4)})

guide = {
    'package': {'id': handoff['id'], 'version': handoff['version'], 'status': handoff['status'],
                'handoffSha256': BOUND['handoff.yaml'], 'tokensSha256': BOUND['tokens.json']},
    'thesis': clean(re.search(r'The visual thesis is \*\*(.+?)\*\*', system_md).group(1)),
    'idea': paragraphs(section(design_md, '## Idea', '## Color')),
    'earn': ['capable', 'welcoming', 'legible'],
    'avoid': ['tactical', 'clinical', 'childish'],
    'emotionalTarget': 'I know where to begin, and changing the plan is allowed.',
    'sources': with_header(table(section(system_md, '## 2. Source-to-decision map', '## 3.'))),
    'structure': with_header(table(section(system_md, '## 3. Structural', '## 4.'))),
    'conventions': {'keep': bullets(section(refs_md, '## Conventions to keep', '## Conventions to break')),
                    'break': bullets(section(refs_md, '## Conventions to break'))},
    'identity': paragraphs(section(system_md, '## 4. Identity and the single signature', '## 5.')),
    'signature': paragraphs(section(design_md, '## Signature element', '## Accessory removed')),
    'accessoryRemoved': paragraphs(section(design_md, '## Accessory removed', '## Do / Don')),
    'colorRoles': with_header(table(section(system_md, '## 5. Semantic color and contrast', 'Measured intended pairs'))),
    'colorRules': paragraphs(section(system_md, 'Measured intended pairs', '## 6.'))[1:],
    'contrast': contrast,
    'typeRoles': type_rows,
    'typeRamp': type_ramp,
    'typeRules': paragraphs(section(system_md, '| type.tab', '## 7.').split('\n', 1)[1]),
    'space': paragraphs(section(system_md, '## 7. Space, geometry and surfaces', '## 8.')),
    'shape': paragraphs(section(design_md, '## Shape and elevation', '## Components')),
    'art': paragraphs(section(system_md, '## 8. Icons and original art', '## 9.')),
    'iconAdapter': handoff['x-icon-adapter'],
    'motion': paragraphs(section(system_md, '## 9. Motion and feedback', '## 10.')),
    'motionMeasured': paragraphs(section(design_md, '## Motion', '## Signature element')),
    'interactions': handoff['interactions'],
    'voice': with_header(table(section(system_md, '## 10. Voice, copy and accessibility', '## 11.'))),
    'voiceRules': [p for p in paragraphs(section(system_md, '## 10. Voice, copy and accessibility', '## 11.'))],
    'doDont': bullets(section(design_md, '## Do / Don', '## System revisions')),
    'accessibility': handoff['intent_not_in_mockup'],
    'doNotChange': handoff['do_not_change'],
    'pageJobs': with_header(table(section(system_md, '### Page jobs', '## 2.'))),
    'pageStates': with_header(table(section(flow_md, '## Screens', '## Transitions'))),
    'transitions': bullets(section(flow_md, '## Transitions', '## Edge cases')),
    'edgeCases': bullets(section(flow_md, '## Edge cases')),
    'pageIntent': bullets(section(design_md, '## Pages', '## Motion')),
    'components': components,
    'revisions': with_header(table(section(design_md, '## System revisions'))),
    'designGapRequests': handoff.get('x-design-gap-requests', []),
}
(HERE / 'generatedguide.ts').write_text(HEADER + 'export const guide = ' + json.dumps(guide, ensure_ascii=False, indent=2) + ' as const;\n')

# ---- evidence ----
outputs = ['generatedtokens.ts', 'generatedicons.ts', 'generatedfixtures.ts', 'generatedguide.ts']
inputs = sorted(p for p in PACKAGE.rglob('*') if p.is_file())
(HERE / 'evidence').mkdir(exist_ok=True)
record = {
    'generator': 'apps/form2-gallery/src/variants/b/generate-source.py',
    'tokenGenerator': TOKENS_PY.relative_to(ROOT).as_posix(),
    'bound': BOUND,
    'systemInputs': {p.name: sha(p) for p in [SYSTEM / 'system.md', SYSTEM / 'component-contract.md']},
    'packageFiles': {p.relative_to(PACKAGE).as_posix(): sha(p) for p in inputs},
    'outputs': {name: sha(HERE / name) for name in outputs},
    'counts': {'icons': len(icons), 'components': len(components), 'contrastPairs': len(contrast),
               'typeRoles': len(type_rows), 'packageFiles': len(inputs)},
}
(HERE / 'evidence/generation.json').write_text(json.dumps(record, indent=2) + '\n')
print(json.dumps({'outputs': record['outputs'], 'counts': record['counts']}, indent=2))
