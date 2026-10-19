#!/usr/bin/env python3
"""Give bundled static native faces unique identities without changing glyphs."""
import argparse
import hashlib
import io
import json
from pathlib import Path

from fontTools.ttLib import TTFont

ROOT = Path(__file__).resolve().parent.parent


def digest(data):
    return hashlib.sha256(data).hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    manifest_path = ROOT / 'assets/fonts/manifest.json'
    manifest = json.loads(manifest_path.read_text())
    records = []
    prepared = []
    for entry in manifest:
        path = ROOT / 'assets/fonts' / entry['file']
        before = path.read_bytes()
        assert digest(before) == entry['sha256'], path
        font = TTFont(io.BytesIO(before), recalcTimestamp=False)
        old_name = font['name'].getDebugName(6)
        native_name = 'Form2' + entry['alias'].replace('_', '').replace('-', '')
        if old_name == native_name:
            records.append({'file': entry['file'], 'already_repaired': True})
            continue
        tables = {tag: font.reader[tag] for tag in font.reader.keys()}
        original_names = {str(n): font['name'].getDebugName(n) for n in (1, 2, 3, 4, 6, 16, 17)}
        values = {1: native_name, 2: 'Regular', 3: native_name,
                  4: native_name, 6: native_name, 16: native_name, 17: 'Regular'}
        for record in font['name'].names:
            if record.nameID in values:
                record.string = values[record.nameID].encode(record.getEncoding())
        output = io.BytesIO()
        font.save(output)
        after = output.getvalue()
        verified = TTFont(io.BytesIO(after), recalcTimestamp=False)
        assert verified['name'].getDebugName(6) == native_name
        assert set(verified.reader.keys()) == set(tables)
        unchanged = [tag for tag in tables if tag not in ('name', 'head')]
        assert all(verified.reader[tag] == tables[tag] for tag in unchanged), path
        old_head = bytearray(tables['head'])
        new_head = bytearray(verified.reader['head'])
        old_head[8:12] = new_head[8:12] = b'\0' * 4
        assert old_head == new_head, path
        records.append({'file': entry['file'], 'original_names': original_names,
                        'native_postscript_name': native_name,
                        'before_sha256': digest(before), 'after_sha256': digest(after),
                        'unchanged_tables': unchanged,
                        'head_change': 'checksumAdjustment only'})
        prepared.append((path, after, entry, native_name, digest(before)))
    if args.apply:
        for path, after, entry, native_name, old_digest in prepared:
            entry.setdefault('pre_native_identity_sha256', old_digest)
            entry['sha256'] = digest(after)
            entry['native_postscript_name'] = native_name
            entry['native_identity_transform'] = 'Unique Form2 family/full/PostScript names; all glyph, metrics, hinting, and layout tables byte-unchanged.'
            path.write_bytes(after)
        manifest_path.write_text(json.dumps(manifest, indent=2) + '\n')
    print(json.dumps({'applied': args.apply, 'faces': records}, indent=2))


if __name__ == '__main__':
    main()
