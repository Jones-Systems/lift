"""Copy sealed package fixtures and documentation into typed native inputs."""
import hashlib
import json
import re
from pathlib import Path

HERE = Path(__file__).resolve().parent
# Resolve from the exact workspace; this file never writes outside its own cone.
PACKAGE = HERE.parents[4] / 'design/form2-three-directions/c/v3'
source = (PACKAGE / 'assets/fixtures.js').read_text()
fixtures = json.loads(source.removeprefix('window.MARGIN_FIXTURES = ').strip().removesuffix(';'))
header = '// Generated from the sealed c/v3 package by generate-source.py. Do not edit.\n'
(HERE / 'generatedfixtures.ts').write_text(header + 'export const fixtures = ' + json.dumps(fixtures, ensure_ascii=False, indent=2) + ' as const;\n')
design = (PACKAGE / 'DESIGN.md').read_text()
contract = (PACKAGE / 'component-contract.md').read_text()
def clean(s):
    return s.replace('**','').replace('`','').strip()
def table_rows(text):
    return [[clean(c) for c in line.strip().strip('|').split('|')] for line in text.splitlines() if line.startswith('|') and not re.match(r'^\|[\s:|-]+\|$',line)]
def section(start,end):
    return design.split(start,1)[1].split(end,1)[0]
components=[]
for chunk in re.split(r'\n## C-',contract)[1:]:
    first,body=chunk.split('\n',1)
    number,name=first.split(' · ',1)
    tables=table_rows(body)
    states=[]; collecting=False
    for row in tables:
        if row[0] in ['State','Variant / state','Speaker']:
            collecting=True;continue
        if collecting and row[0] not in ['---','']:
            states.append({'name':row[0], 'description':' · '.join(row[1:])})
    if not states:
        states=[{'name':'default','description':clean(body.split('\n\n')[0])}]
    components.append({'id':'C-'+number,'key':'c'+number,'name':name,'anatomy':clean(body),'states':states})
roles=json.loads((PACKAGE/'tokens.json').read_text())
def collect_tokens(group,path=''):
    out=[]
    for k,v in group.items():
        if k.startswith('$'):continue
        p=path+'.'+k if path else k
        if '$value' in v:out.append({'path':p,'description':v.get('$description','')})
        else:out.extend(collect_tokens(v,p))
    return out
guide={
 'thesis':'Your training is the page; the coach writes in the margin.',
 'adjectives':['spacious','legible','accountable'], 'avoided':['clinical','cute','hyped'],
 'sources':table_rows(section('## 2. Sources → decisions','## 3. Color'))[1:],
 'contrast':table_rows(section('### Contrast (computed','### Never combine'))[1:],
 'forbidden':table_rows(section('### Never combine','## 4. Typography'))[1:],
 'motion':table_rows(section('## 8. Motion','## 9. Voice'))[1:],
 'voice':table_rows(section('### Voice','### Accessibility adaptations'))[1:],
 'a11y':table_rows(section('### Accessibility adaptations','## 10. Scope overrides'))[1:],
 'purposes':table_rows((PACKAGE/'pages.md').read_text().split('## Page purposes')[1].split('## Shared state')[0])[1:],
 'components':components,
 'tokens':collect_tokens(roles),
 'flow':(PACKAGE/'flow.md').read_text().split('\n\n')[1:],
 'separation':'Separation methods are exclusive: space, ruling, border or shadow. Choose one per surface.',
}
(HERE/'generatedguide.ts').write_text(header+'export const guide = '+json.dumps(guide,ensure_ascii=False,indent=2)+' as const;\n')
manifest={p.relative_to(PACKAGE).as_posix():hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(PACKAGE.rglob('*')) if p.is_file()}
(HERE/'evidence/package-files.json').write_text(json.dumps(manifest,indent=2)+'\n')
print('Generated fixture and guide modules; package manifest includes',len(manifest),'files.')
