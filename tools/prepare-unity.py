#!/usr/bin/env python3
"""Prepare/verify Unity photo derivatives and the explicitly approved OFL font."""
import argparse
import hashlib
import json
from pathlib import Path

from PIL import Image, __version__ as pillow_version

ROOT = Path(__file__).resolve().parents[1]
PHOTOS = ROOT / 'prototype/assets/photos'
OUTPUT = ROOT / 'unity/Assets/Resources/Photos'
FONTS = ROOT / 'unity/Assets/Resources/Fonts'
APPROVED_FONT_SOURCE = Path('D:/app/RingHaven/Assets/Resources/Fonts')
FONT_FILES = ('NotoSansCJKsc.otf', 'NotoSansCJKsc-LICENSE.txt')
SETTINGS = {'format': 'JPEG', 'mode': 'RGB', 'quality': 90, 'subsampling': 0,
            'optimize': True, 'progressive': False, 'resize': False}


def digest(data):
    return hashlib.sha256(data).hexdigest()


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true', help='Verify without writing files.')
    args = parser.parse_args()
    canonical_bytes = (PHOTOS / 'manifest.json').read_bytes()
    canonical = json.loads(canonical_bytes)
    assets = canonical['assets']
    if len(assets) != 25 or len({a['key'] for a in assets}) != 25:
        raise ValueError('Expected exactly 25 unique canonical photo assets.')
    expected_names = {a['key'] + '.jpg' for a in assets}
    if args.check:
        generated = json.loads((OUTPUT / 'manifest.json').read_text(encoding='utf-8'))
        if generated['canonicalManifestSha256'] != digest(canonical_bytes):
            raise ValueError('Canonical photo manifest changed; regenerate Unity assets.')
        if generated['conversion'] != SETTINGS or len(generated['assets']) != 25:
            raise ValueError('Unity photo conversion manifest is invalid.')
        recorded = {a['key']: a for a in generated['assets']}
    else:
        OUTPUT.mkdir(parents=True, exist_ok=True)
        FONTS.mkdir(parents=True, exist_ok=True)
        recorded = {}
    results = []
    for asset in assets:
        key = asset['key']
        if not key or any(c not in 'abcdefghijklmnopqrstuvwxyz0123456789-' for c in key):
            raise ValueError('Unsafe canonical photo key.')
        if asset['file'] != key + '.webp':
            raise ValueError('Unexpected canonical photo file.')
        original = (PHOTOS / asset['file']).read_bytes()
        if digest(original) != asset['sha256'] or len(original) != asset['bytes']:
            raise ValueError('Canonical photo hash/size mismatch: ' + key)
        destination = OUTPUT / (key + '.jpg')
        with Image.open(PHOTOS / asset['file']) as photo:
            if photo.size != (asset['width'], asset['height']):
                raise ValueError('Canonical photo dimensions mismatch: ' + key)
            if not args.check:
                photo.convert('RGB').save(destination, 'JPEG', quality=90, subsampling=0,
                                          optimize=True, progressive=False)
        converted = destination.read_bytes()
        result = {'key': key, 'file': destination.name,
                  'width': asset['width'], 'height': asset['height'],
                  'bytes': len(converted), 'sha256': digest(converted),
                  'source': 'prototype/assets/photos/' + asset['file'],
                  'sourceSha256': asset['sha256']}
        with Image.open(destination) as photo:
            if photo.format != 'JPEG' or photo.mode != 'RGB' or photo.size != (asset['width'], asset['height']):
                raise ValueError('Unity photo encoding mismatch: ' + key)
        if args.check and recorded.get(key) != result:
            raise ValueError('Unity photo manifest/hash mismatch: ' + key)
        results.append(result)
    if set(p.name for p in OUTPUT.glob('*.jpg')) != expected_names:
        raise ValueError('Unexpected or missing Unity photo JPEGs; inspect manually.')
    if not args.check:
        write_json(OUTPUT / 'manifest.json', {
            'schema': 1,
            'description': 'AI-generated photographic examples; not actual farm photographs or live video.',
            'canonicalManifest': 'prototype/assets/photos/manifest.json',
            'canonicalManifestSha256': digest(canonical_bytes),
            'generationPrompts': 'See canonical manifest; source photos remain the single asset authority.',
            'generator': 'Pillow ' + pillow_version,
            'conversion': SETTINGS, 'assets': results})
        for name in FONT_FILES:
            source = APPROVED_FONT_SOURCE / name
            (FONTS / name).write_bytes(source.read_bytes())
        write_json(FONTS / 'provenance.json', {
            'schema': 1, 'family': 'Noto Sans CJK SC', 'license': 'OFL-1.1',
            'upstream': 'https://github.com/notofonts/noto-cjk',
            'provenance': 'Unmodified copies of the two explicitly approved local font/license files.',
            'files': [{'file': name, 'bytes': (FONTS / name).stat().st_size,
                       'sha256': digest((FONTS / name).read_bytes())} for name in FONT_FILES]})
    font_manifest = json.loads((FONTS / 'provenance.json').read_text(encoding='utf-8'))
    if font_manifest['license'] != 'OFL-1.1' or {f['file'] for f in font_manifest['files']} != set(FONT_FILES):
        raise ValueError('Invalid font provenance manifest.')
    for entry in font_manifest['files']:
        data = (FONTS / entry['file']).read_bytes()
        if len(data) != entry['bytes'] or digest(data) != entry['sha256']:
            raise ValueError('Font/license digest mismatch.')
    license_text = (FONTS / FONT_FILES[1]).read_text(encoding='utf-8')
    if 'SIL OPEN FONT LICENSE' not in license_text.upper():
        raise ValueError('The copied font license does not contain the OFL notice.')
    print(('Verified' if args.check else 'Prepared') + ' 25 Unity JPEGs and the OFL font/license; no Unity process launched.')


if __name__ == '__main__':
    main()
