from pathlib import Path
from urllib.request import urlopen
from urllib.parse import quote
import hashlib
import json
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont

root = Path(__file__).resolve().parent
out = root / 'assets' / 'fonts'
out.mkdir(parents=True, exist_ok=True)
source = 'https://raw.githubusercontent.com/google/fonts/main/'
fonts = [
    ('Bricolage700', 'ofl/bricolagegrotesque/BricolageGrotesque[opsz,wdth,wght].ttf', {'opsz':32,'wdth':100,'wght':700}),
    ('AtkinsonNext400', 'ofl/atkinsonhyperlegiblenext/AtkinsonHyperlegibleNext[wght].ttf', {'wght':400}),
    ('AtkinsonNext600', 'ofl/atkinsonhyperlegiblenext/AtkinsonHyperlegibleNext[wght].ttf', {'wght':600}),
    ('AtkinsonNext700', 'ofl/atkinsonhyperlegiblenext/AtkinsonHyperlegibleNext[wght].ttf', {'wght':700}),
    ('BarlowSemiCondensed600', 'ofl/barlowsemicondensed/BarlowSemiCondensed-SemiBold.ttf', None),
    ('BarlowSemiCondensed700', 'ofl/barlowsemicondensed/BarlowSemiCondensed-Bold.ttf', None),
    ('Atkinson400', 'ofl/atkinsonhyperlegible/AtkinsonHyperlegible-Regular.ttf', None),
    ('Atkinson700', 'ofl/atkinsonhyperlegible/AtkinsonHyperlegible-Bold.ttf', None),
    *[(f'SchibstedGrotesk_{weight}{name}', 'ofl/schibstedgrotesk/SchibstedGrotesk[wght].ttf', {'wght':weight}) for weight,name in [(400,'Regular'),(500,'Medium'),(600,'SemiBold'),(700,'Bold'),(800,'ExtraBold'),(900,'Black')]],
    ('SchibstedGrotesk_500Medium_Italic', 'ofl/schibstedgrotesk/SchibstedGrotesk-Italic[wght].ttf', {'wght':500}),
    *[(f'IBMPlexMono_{weight}{name}', f'ofl/ibmplexmono/IBMPlexMono-{file}.ttf', None) for weight,name,file in [(400,'Regular','Regular'),(500,'Medium','Medium'),(600,'SemiBold','SemiBold')]],
]
manifest = []
for alias, path, axes in fonts:
    url = source + quote(path, safe='/')
    with urlopen(url, timeout=30) as response:
        data = response.read()
    target = out / (alias + '.ttf')
    if axes:
        import io
        font = TTFont(io.BytesIO(data))
        instantiateVariableFont(font, axes, inplace=True)
        font.save(target)
    else:
        target.write_bytes(data)
    license_path = path.rsplit('/',1)[0] + '/OFL.txt'
    license_file = out / (path.split('/')[1] + '-OFL.txt')
    if not license_file.exists():
        with urlopen(source + license_path, timeout=30) as response:
            license_file.write_bytes(response.read())
    manifest.append({'alias':alias,'file':target.name,'source':url,'axes':axes,'source_sha256':hashlib.sha256(data).hexdigest(),'sha256':hashlib.sha256(target.read_bytes()).hexdigest(),'license':license_file.name})
(out/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
print(json.dumps({'bundled':len(manifest),'bytes':sum((out/f['file']).stat().st_size for f in manifest)}))
