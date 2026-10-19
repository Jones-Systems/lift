"""Generate Open Mat (A) native inputs from the immutable a/v2 ready package.

Writes only inside this directory:
  tokens.ts                    tokens.py ts output for v2/tokens.json, byte-for-byte
  assets/generatedicons.ts     Lucide icon nodes from v2/assets/icons/*.svg (cross-checked with app/icons.js)
  assets/generatedart.ts       owned vector art (open-mat-squat.svg, open-mat-empty.svg) and the
                               mockup's simulated status-bar glyphs (app/frame.js), path data unchanged
  generatedfixtures.ts         fixture literals parsed from v2/app/app.js (MOVES, DAYS, HISTORY, WEEKS, ...)
  generatedguide.ts            design-system guide text parsed from the package and its system prose
  evidence/generation.json     input/output sha256 and counts

Geometry stays in assets/ (vector data, exempt from the style lint). Colors in art are recorded as
the hex in the asset plus the token path that owns that hex; views resolve the token at render time.
The guide carries words and token paths only. Refuses to run if the bound package hashes differ.
"""
import hashlib
import json
import math
import re
import subprocess
import sys
from pathlib import Path

import yaml

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[4]
PACKAGE = ROOT / 'design/form2-three-directions/a/v2'
SYSTEM = ROOT / 'design/form2-three-directions/a/system'
TOKENS_PY = ROOT / '.codex/skills/ui-design-craft/scripts/tokens.py'
BOUND = {
    'handoff.yaml': 'ae6221e685bfc5b71139dd8e975a8bf6ef04c5f9fc10308de11cff5dab883323',
    'tokens.json': '0d93bb7f6226f8214d1d952139581c98c06e9974ab7792ea7cfc925e0e24b9f7',
    'DESIGN.md': '4c80b0d91cb5ae9b642386d4eb83de21b4d8ace53352530467d50be38aa31cce',
}
HEADER = '// Generated from the immutable a/v2 ready package by generate-source.py. Do not edit.\n'
# Mirrors scripts/check-token-styles.cjs: generated data outside assets/ must not use these keys.
VISUAL_KEY = re.compile(r'^(?:color|backgroundColor|border.*Color|fontFamily|fontSize|lineHeight|letterSpacing|padding.*|margin.*|gap|rowGap|columnGap|width|height|minWidth|minHeight|maxWidth|maxHeight|top|right|bottom|left|border.*Width|border.*Radius|shadowRadius|shadowColor|shadowOpacity|opacity|elevation)$')


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


for name, digest in BOUND.items():
    actual = sha(PACKAGE / name)
    if actual != digest:
        sys.exit(f'{name} sha256 {actual} does not match bound {digest}; refusing to generate.')

handoff = yaml.safe_load((PACKAGE / 'handoff.yaml').read_text())
if handoff.get('status') != 'ready' or handoff.get('version') != 2:
    sys.exit('handoff is not ready v2; refusing to generate.')

written: list[str] = []


def write(rel: str, text: str) -> None:
    path = HERE / rel
    path.parent.mkdir(exist_ok=True)
    path.write_text(text)
    written.append(rel)


# ---- tokens: the skill's canonical generator, output kept byte-for-byte ----
tokens_ts = subprocess.run([sys.executable, str(TOKENS_PY), 'ts', str(PACKAGE / 'tokens.json')],
                           check=True, capture_output=True, text=True).stdout
write('tokens.ts', tokens_ts)

# Resolved light token values (for hex -> token path mapping and contrast ratios).
tokens_json = subprocess.run([sys.executable, '-c', (
    'import json,sys;sys.path.insert(0,sys.argv[1]);import tokens as T;'
    'toks,probs=T.resolve_tokens(T.load_tokens(sys.argv[2]));'
    'print(json.dumps({t.path:t.light for t in toks}))'), str(TOKENS_PY.parent), str(PACKAGE / 'tokens.json')],
    check=True, capture_output=True, text=True).stdout
resolved = json.loads(tokens_json)
color_paths = {p: v for p, v in resolved.items() if p.startswith('color.') and isinstance(v, str)}

# ---- svg parsing ----
ATTR = re.compile(r'([a-zA-Z:-]+)="([^"]*)"')
ELEMENT = re.compile(r'<(path|rect|circle|line|g|/g)\b([^>]*?)/?>')
NUMERIC = {'x', 'y', 'width', 'height', 'rx', 'cx', 'cy', 'r', 'x1', 'x2', 'y1', 'y2', 'stroke-width', 'stroke-opacity', 'fill-opacity'}


def camel(name: str) -> str:
    head, *rest = name.split('-')
    return head + ''.join(part.title() for part in rest)


def num(value: str):
    number = float(value)
    return int(number) if number.is_integer() else number


# Hex in an owned asset -> token path that owns that exact value. Art roles win over UI roles.
PREFERENCE = ['color.art.', 'color.controlBorder', 'color.ink']


def token_for(hex_value: str) -> str:
    lowered = hex_value.lower()
    matches = [p for p, v in color_paths.items() if v == lowered]
    for prefix in PREFERENCE:
        for match in matches:
            if match.startswith(prefix):
                return match.removeprefix('color.')
    if not matches:
        sys.exit(f'art color {hex_value} has no token; refusing to generate.')
    return matches[0].removeprefix('color.')


def parse_svg(text: str, *, colors: bool) -> list[dict]:
    """Flatten an SVG body to drawing elements, inheriting <g> presentation attributes."""
    body = re.sub(r'<!--.*?-->', '', text, flags=re.S)
    body = re.sub(r'<svg\b[^>]*>|</svg>', '', body)
    out, stack = [], [{}]
    for tag, raw in ELEMENT.findall(body):
        if tag == '/g':
            stack.pop()
            continue
        attrs = {k: v for k, v in ATTR.findall(raw) if k != 'id'}
        if tag == 'g':
            stack.append({**stack[-1], **attrs})
            continue
        merged = {**stack[-1], **attrs}
        element = {'tag': tag}
        for key, value in merged.items():
            if key in ('fill', 'stroke'):
                if value in ('none', 'currentColor'):
                    element[key] = value
                elif colors:
                    element[key + 'Hex'] = value
                    element[key + 'Token'] = token_for(value)
                else:
                    sys.exit(f'unexpected literal paint {value} in icon')
            elif key in NUMERIC:
                element[camel(key)] = num(value)
            else:
                element[camel(key)] = value
        out.append(element)
    return out


def svg_root(text: str) -> dict:
    root = re.search(r'<svg\b([^>]*)>', text).group(1)
    return {camel(k): v for k, v in ATTR.findall(root) if k in ('viewBox', 'width', 'height', 'fill', 'stroke-width', 'stroke-linecap', 'stroke-linejoin')}


def polyline_length(d: str) -> float:
    """Length of a path made only of M/L/H/V moves (absolute or relative)."""
    tokens = re.findall(r'[MLHVmlhv]|-?\d*\.?\d+', d)
    x = y = 0.0
    length, cmd, i = 0.0, None, 0
    while i < len(tokens):
        if re.fullmatch(r'[MLHVmlhv]', tokens[i]):
            cmd = tokens[i]
            i += 1
            continue
        if cmd in 'Hh':
            nx = float(tokens[i]) + (x if cmd == 'h' else 0)
            length += abs(nx - x); x = nx; i += 1
            continue
        if cmd in 'Vv':
            ny = float(tokens[i]) + (y if cmd == 'v' else 0)
            length += abs(ny - y); y = ny; i += 1
            continue
        nx, ny = float(tokens[i]), float(tokens[i + 1])
        if cmd in 'ml':
            nx, ny = nx + x, ny + y
        if cmd in 'Ll':
            length += math.hypot(nx - x, ny - y)
        x, y = nx, ny
        if cmd == 'M':
            cmd = 'L'
        elif cmd == 'm':
            cmd = 'l'
        i += 2
    return round(length, 4)


# ---- icons ----
icons_js = (PACKAGE / 'app/icons.js').read_text()
js_bodies = dict(re.findall(r'"([a-z0-9-]+)":\s*"((?:[^"\\]|\\.)*)"', icons_js))
handoff_icons = {a['id'].removeprefix('icon-'): a for a in handoff['assets'] if a.get('kind') == 'lucide'}
stroke_icon = resolved['stroke.icon']
icons = {}
for svg_path in sorted((PACKAGE / 'assets/icons').glob('*.svg')):
    name = svg_path.stem
    text = svg_path.read_text()
    root = svg_root(text)
    inner = re.sub(r'<svg\b[^>]*>|</svg>', '', text).strip()
    js_inner = js_bodies.get(name, '').encode().decode('unicode_escape')
    if js_inner != inner:
        sys.exit(f'icon {name}: assets/icons SVG differs from app/icons.js')
    if float(root['strokeWidth']) != stroke_icon:
        sys.exit(f'icon {name}: stroke width differs from stroke.icon')
    meta = handoff_icons.get(name) or handoff_icons.get({'chart-no-axes-combined': 'chart', 'undo-2': 'undo', 'loader-circle': 'loader'}.get(name, ''), {})
    entry = {
        'viewBox': root['viewBox'], 'strokeLinecap': root['strokeLinecap'], 'strokeLinejoin': root['strokeLinejoin'],
        'lucide': meta.get('name'), 'sfSymbol': meta.get('sf_symbol'), 'use': meta.get('use'),
        'sha256': sha(svg_path), 'elements': parse_svg(text, colors=False),
    }
    if name == 'check':
        entry['pathLength'] = polyline_length(entry['elements'][0]['d'])
    icons[name] = entry
write('assets/generatedicons.ts', HEADER + '// Lucide 1.34.0 nodes (ISC, see design/form2-three-directions/a/v2/assets/icons/LUCIDE-LICENSE.txt).\n'
      + 'export const icons = ' + json.dumps(icons, ensure_ascii=False, indent=2) + ' as const;\n'
      + 'export type IconName = keyof typeof icons;\n')

# ---- owned art + simulated chrome glyphs ----
art = {}
for asset_id, rel in (('openMatSquat', 'assets/open-mat-squat.svg'), ('openMatEmpty', 'assets/open-mat-empty.svg')):
    text = (PACKAGE / rel).read_text()
    root = svg_root(text)
    art[asset_id] = {'file': rel, 'sha256': sha(PACKAGE / rel), 'viewBox': root['viewBox'],
                     'elements': parse_svg(text, colors=True)}
frame_js = (PACKAGE / 'app/frame.js').read_text()
glyphs = {}
for glyph in ('SIGNAL', 'WIFI', 'BATTERY'):
    text = re.search(rf"var {glyph} = '(.*?)';", frame_js).group(1)
    text = text.replace("' + TRACK + '", '0')
    root = svg_root(text)
    elements = parse_svg(text, colors=False)
    for element in elements:
        for key in ('strokeOpacity', 'fillOpacity'):
            if key in element:
                element[key + 'Token'] = 'opacity.chromeTrack'
                del element[key]
    glyphs[glyph.lower()] = {'viewBox': root['viewBox'], 'fill': root.get('fill', 'none'), 'elements': elements}
art['statusGlyphs'] = {'file': 'app/frame.js', 'sha256': sha(PACKAGE / 'app/frame.js'), 'glyphs': glyphs}
write('assets/generatedart.ts', HEADER + '// Original owned vectors; path data copied unchanged. Paint resolves through the named token.\n'
      + 'export const art = ' + json.dumps(art, ensure_ascii=False, indent=2) + ' as const;\n')

# ---- fixtures ----
app_js = (PACKAGE / 'app/app.js').read_text()


def js_array(name: str):
    literal = re.search(rf'var {name} = (\[.*?\]);', app_js, flags=re.S).group(1)
    literal = re.sub(r'([{,]\s*)([A-Za-z_]\w*)\s*:', r'\1"\2":', literal)
    return json.loads(literal)


def js_string(name: str) -> str:
    return json.loads(re.search(rf'var {name} = ("(?:[^"\\]|\\.)*");', app_js).group(1))


minutes = re.search(r'minutes: variant === "short" \? (\d+) : (\d+)', app_js)
fixtures = {
    'source': {'file': 'app/app.js', 'sha256': sha(PACKAGE / 'app/app.js')},
    'moves': js_array('MOVES'),
    'days': js_array('DAYS'),
    'history': js_array('HISTORY'),
    'weeks': js_array('WEEKS'),
    'restSeconds': int(re.search(r'var REST_SECONDS = (\d+);', app_js).group(1)),
    'planMinutes': {'short': int(minutes.group(1)), 'full': int(minutes.group(2))},
    'seedLine': js_string('SEED_LINE'),
    'footnote': js_string('FOOTNOTE'),
    'thisWeek': len(js_array('WEEKS')) - 1,
}
write('generatedfixtures.ts', HEADER + '// Fictional local demo data only (Alex; week Oct 5–11). No account, network or live coach.\n'
      + 'export const fixtures = ' + json.dumps(fixtures, ensure_ascii=False, indent=2) + ' as const;\n')

# ---- guide ----
system_md = (SYSTEM / 'system.md').read_text()
contract_md = (SYSTEM / 'component-contract.md').read_text()
design_md = (PACKAGE / 'DESIGN.md').read_text()
flow_md = (PACKAGE / 'flow.md').read_text()
refs_md = (PACKAGE / 'references.md').read_text()
brief_md = (PACKAGE / 'brief.md').read_text()
showcase_js = (PACKAGE / 'app/showcase.js').read_text()


def clean(text: str) -> str:
    text = re.sub(r'\[([^\]]+)\]\([^)]+\)', r'\1', text)
    return text.replace('**', '').replace('`', '').strip()


def table(text: str) -> list[list[str]]:
    rows = [[clean(c) for c in line.strip().strip('|').split('|')]
            for line in text.splitlines() if line.strip().startswith('|')]
    return [r for r in rows if not all(re.fullmatch(r':?-+:?', c.strip()) for c in r)]


def with_header(rows: list[list[str]]) -> dict:
    return {'columns': rows[0], 'rows': rows[1:]}


def section(text: str, start: str, end: str | None = None) -> str:
    body = text.split(start, 1)[1]
    return body.split(end, 1)[0] if end else body


def paragraphs(text: str) -> list[str]:
    out = []
    for block in text.strip().split('\n\n'):
        block = block.strip()
        if not block or block.startswith(('|', '#', '- ', '<!--')):
            continue
        out.append(clean(' '.join(line.strip() for line in block.splitlines())))
    return out


def bullets(text: str) -> list[str]:
    """Top-level bullets; indented continuation bullets are appended to their parent."""
    out: list[str] = []
    for line in text.splitlines():
        if line.startswith('- '):
            out.append(clean(line[2:]))
        elif line.startswith('  - ') and out:
            out.append(clean(line.strip()[2:]))
    return out


def flatten(value) -> list[str]:
    if isinstance(value, dict):
        return [f'{k}: {", ".join(map(str, v)) if isinstance(v, list) else v}' for k, v in value.items()]
    return [str(v) for v in value]


def luminance(hex_value: str) -> float:
    def channel(c: float) -> float:
        return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
    r, g, b = (int(hex_value[i:i + 2], 16) / 255 for i in (1, 3, 5))
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)


def ratio(fg: str, bg: str) -> float:
    a, b = sorted((luminance(fg), luminance(bg)), reverse=True)
    return (a + 0.05) / (b + 0.05)


contrast = []
for pair in handoff['contrast_pairs']:
    value = ratio(resolved[pair['fg']], resolved[pair['bg']])
    contrast.append({'fg': pair['fg'].removeprefix('color.'), 'bg': pair['bg'].removeprefix('color.'),
                     'ratio': f'{value:.2f}', 'min': str(pair['min']), 'pass': value >= pair['min']})
if not all(c['pass'] for c in contrast):
    sys.exit('a declared contrast pair fails; refusing to generate.')

type_table = table(section(system_md, '## Typography and local fonts', '## Space'))
type_roles = [{'token': r[0].removeprefix('type.'), 'face': r[1], 'scale': r[2], 'nativeStyle': r[3]} for r in type_table[1:]]

contract_rows = {r[0].split(' ', 1)[0]: r for r in table(section(contract_md, '## Numbered reusable components', 'State showcase'))[1:]}
design_rows = table(section(design_md, '## Components', '## Motion'))[1:]
components = []
for row in design_rows:
    cid = row[0]
    contract = contract_rows.get(cid, [cid, '', ''])
    variants = next((c.get('variants', {}) for c in handoff['components'] if c['id'].startswith(cid + '-')), {})
    components.append({'id': cid, 'name': row[1], 'shown': row[2], 'keyTokens': row[3],
                       'anatomy': contract[1], 'states': contract[2], 'variants': flatten(variants)})

never_pair = json.loads('[' + re.search(r'\["White text on yellow.*?\]', showcase_js).group(0)[1:-1] + ']')

guide = {
    'package': {'id': handoff['id'], 'version': handoff['version'], 'status': handoff['status'],
                'handoffSha256': BOUND['handoff.yaml'], 'tokensSha256': BOUND['tokens.json'], 'designSha256': BOUND['DESIGN.md']},
    'thesis': clean(re.search(r'\*\*Thesis:\*\* (.+)', system_md).group(1)),
    'idea': paragraphs(section(design_md, '## Idea', '## Color')),
    'intake': paragraphs(section(system_md, '## Intake and thesis', '## Sources')),
    'person': paragraphs(section(brief_md, '## Person and moment', '## Primary job')),
    'primaryJob': paragraphs(section(brief_md, '## Primary job', '## Emotional target')),
    'emotionalTarget': paragraphs(section(brief_md, '## Emotional target', '## Must earn')),
    'earnAvoid': bullets(section(brief_md, '## Must earn / must avoid', '## Constraints')),
    'sources': with_header(table(section(system_md, '## Sources → decisions', '## Color and contrast'))),
    'references': with_header(table(section(refs_md, '| Pattern', '## Conventions to keep').join(['| Pattern', '']))),
    'conventions': {'keep': bullets(section(refs_md, '## Conventions to keep', '## Conventions to break')),
                    'break': bullets(section(refs_md, '## Conventions to break'))},
    'colorRoles': with_header(table(section(design_md, '## Color', '## Typography'))),
    'colorSystem': with_header(table(section(system_md, '## Color and contrast', '## Typography'))),
    'colorRules': paragraphs(section(system_md, '## Color and contrast', '## Typography')),
    'colorNotes': paragraphs(section(design_md, '## Color', '## Typography')),
    'neverPair': never_pair,
    'contrast': contrast,
    'typeRoles': type_roles,
    'typeNotes': bullets(section(design_md, '## Typography', '## Layout and space')),
    'typeRules': paragraphs(section(system_md, '| `type.tab`', '## Space').split('\n', 1)[1]),
    'layout': bullets(section(design_md, '## Layout and space', '## Shape and elevation')),
    'space': paragraphs(section(system_md, '## Space, surfaces and geometry', '## Original art')),
    'shape': bullets(section(design_md, '## Shape and elevation', '## Components')),
    'art': paragraphs(section(system_md, '## Original art and icons', '## Motion and voice')),
    'signature': paragraphs(section(design_md, '## Signature element', '## Token additions')),
    'motion': bullets(section(design_md, '## Motion', '## Signature element')),
    'motionVoice': paragraphs(section(system_md, '## Motion and voice', '## Accessibility')),
    'accessibility': paragraphs(section(system_md, '## Accessibility and implementation constraints', '## Flow')),
    'platformRules': flatten(handoff['platform_rules']),
    'glass': flatten(handoff['glass_map']),
    'intentNotInMockup': handoff['intent_not_in_mockup'],
    'doNotChange': handoff['do_not_change'],
    'doDont': bullets(section(design_md, '## Do / Don')),
    'refinements': bullets(section(design_md, '## Deliberate refinements of the system contract', '## Do / Don')),
    'tokenAdditions': with_header(table(section(design_md, '## Token additions', '## Deliberate refinements'))),
    'pageJobs': with_header(table(section(system_md, '## Flow and page purposes', '## Required state coverage'))),
    'flowEntry': bullets(section(flow_md, '## Entry points', '## Screens')),
    'flowScreens': with_header(table(section(flow_md, '## Screens', 'Sheets (presented'))),
    'flowSheets': with_header(table(section(flow_md, 'Sheets (presented', '`exercise-list` and'))),
    'transitions': bullets(section(flow_md, '## Transitions', '## States and rules')),
    'stateRules': bullets(section(flow_md, '## States and rules', '## Edge cases')),
    'edgeCases': bullets(section(flow_md, '## Edge cases')),
    'stateCoverage': paragraphs(section(system_md, '## Required state coverage and downstream sequence', '## Open notes')),
    'screens': [{'id': s['id'], 'states': s['states'], 'textSizes': s['dynamic_type']} for s in handoff['screens']],
    'interactions': [{'id': i['id'], 'trigger': i['trigger'], 'target': i['target'], 'effect': i['effect'],
                      'motion': str(i['motion']), 'haptic': str(i['haptic']), 'reduceMotion': str(i['reduce_motion'])}
                     for i in handoff['interactions']],
    'components': components,
    'evidenceIds': bullets(section(contract_md, 'Use stable native testIDs', 'Dev-only deterministic fixtures')),
}


def check_keys(node, where='guide'):
    if isinstance(node, dict):
        for key, value in node.items():
            if VISUAL_KEY.match(key):
                sys.exit(f'{where}.{key}: generated key collides with the style lint; refusing to generate.')
            check_keys(value, f'{where}.{key}')
    elif isinstance(node, list):
        for item in node:
            check_keys(item, where)


check_keys(guide)
check_keys(fixtures, 'fixtures')
write('generatedguide.ts', HEADER + 'export const guide = ' + json.dumps(guide, ensure_ascii=False, indent=2) + ' as const;\n')

# ---- evidence ----
inputs = sorted(p for p in PACKAGE.rglob('*') if p.is_file() and 'evidence' not in p.relative_to(PACKAGE).parts[:1]
                and 'refs' not in p.relative_to(PACKAGE).parts[:1])
record = {
    'generator': 'apps/form2-gallery/src/variants/a/generate-source.py',
    'tokenGenerator': TOKENS_PY.relative_to(ROOT).as_posix(),
    'tokenGeneratorSha256': sha(TOKENS_PY),
    'bound': BOUND,
    'systemInputs': {p.name: sha(p) for p in [SYSTEM / 'system.md', SYSTEM / 'component-contract.md']},
    'packageFiles': {p.relative_to(PACKAGE).as_posix(): sha(p) for p in inputs},
    'outputs': {name: sha(HERE / name) for name in written},
    'counts': {'tokens': len(resolved), 'icons': len(icons), 'artAssets': 2, 'statusGlyphs': len(glyphs),
               'components': len(components), 'contrastPairs': len(contrast), 'typeRoles': len(type_roles),
               'interactions': len(guide['interactions']), 'moves': len(fixtures['moves']),
               'history': len(fixtures['history']), 'packageFilesHashed': len(inputs)},
}
write('evidence/generation.json', json.dumps(record, indent=2, ensure_ascii=False) + '\n')
print(json.dumps({'outputs': record['outputs'], 'counts': record['counts']}, indent=2))
