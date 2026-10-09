"""
Game shots next to the real 2024 photo (#124, epic #119's "Done when"): for each view of an e2e shot script, the game's
frame beside a north-up crop of the LINZ Auckland 0.075 m Urban Aerial Photos (2024-2025) round the point the camera
looks at, with the camera's position and line of sight drawn on the photo.

    python3 photo-compare.py <work> <shots dir> [--script=e2e/landmark-shots.mjs] [--prefix=124] [--tag=after]
                             [--out=docs/screenshots/real-suburbs] [--only=view,view]

Reads the VIEWS table (`name: { cam: [x, y, z], look: [x, y, z] }`) from the shot script, so the two never drift, and
the game frames <shots dir>/<prefix>-<view>-<tag>.png that script wrote. Writes <out>/<prefix>-<view>.jpg: the frame
(960 x 540) and the photo (540 x 540, north up, scale bar). The photo comes from aerial.py's STAC index and COG
mosaic (cached in <work>), read at the 1/16 overview (1.2 m). The tiles are listed from their names in the
collection (the 1:1000 grid, `tiles_in`), not from aerial.py's full STAC crawl of ~17,700 item files.

pip install numpy scipy rasterio pyproj pillow
"""
import os
import re
import sys

import numpy as np
from PIL import Image, ImageDraw

# The bucket answers a ranged GET with a stray 404 now and then (seen through the cloud container's proxy, about one
# request in four on 2026-10-09); GDAL caches the miss unless it retries on every code.
for k, v in dict(GDAL_HTTP_MAX_RETRY='8', GDAL_HTTP_RETRY_DELAY='0.3', GDAL_HTTP_RETRY_CODES='ALL',
                 GDAL_DISABLE_READDIR_ON_OPEN='EMPTY_DIR').items():
    os.environ.setdefault(k, v)
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import aerial  # noqa: E402

FRAME = (960, 540)
CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'  # the Topo50 sheet letters (no I, no O)
SIDE = 540  # photo px
OV = 16


def tiles_in(work, x0, z0, x1, z1, margin=200):
    """The collection's 1:1000 tiles over a game box. Topo50 sheets are 24 x 36 km (sheet BA32's north-west corner
    is E 1,756,000, N 5,946,000), each cut into 50 x 50 tiles of 480 x 720 m named <sheet>_1000_<row><col>."""
    path = os.path.join(work, 'collection.json')
    if not os.path.exists(path):
        aerial.urllib.request.urlretrieve(aerial.BASE + '/collection.json', path)
    have = {l['href'][2:-5] for l in aerial.json.load(open(path))['links'] if l['rel'] == 'item'}
    xs, zs = np.meshgrid([x0 - margin, x1 + margin], [z0 - margin, z1 + margin])
    E, N = aerial.game_to_nztm(xs, zs)
    out = []
    e0 = 1756000 + np.floor((E.min() - 1756000) / 480) * 480  # tile edges are counted from the sheet grid's origin
    n0 = 5946000 - np.floor((5946000 - N.max()) / 720) * 720
    for e in np.arange(e0, E.max(), 480):
        for n in np.arange(n0, N.min(), -720):
            row = int((5946000 - n) // 36000) + 24  # BA is pair 1 * 24 + 0
            col = int((e - 1756000) // 24000) + 32
            r, c = int((5946000 - (row - 24) * 36000 - n) // 720) + 1, int((e - 1756000 - (col - 32) * 24000) // 480) + 1
            name = f'{CHARS[row // 24]}{CHARS[row % 24]}{col:02d}_1000_{r:02d}{c:02d}'
            if name in have:
                out.append({'item': f'./{name}.json', 'tif': [f'./{name}.tiff']})
    return out


def views_of(script):
    src = open(os.path.join(aerial.ROOT, script)).read()
    num = r'\[\s*(-?[\d.]+),\s*(-?[\d.]+),\s*(-?[\d.]+)\s*\]'
    return {m[0]: dict(cam=[float(v) for v in m[1:4]], look=[float(v) for v in m[4:7]])
            for m in re.findall(r'(\w+):\s*\{\s*cam:\s*' + num + r',\s*look:\s*' + num, src)}


def photo(work, name, v):
    """North-up crop round the look point, big enough to hold the camera; (image, metres per px, origin)."""
    (cx, _, cz), (lx, _, lz) = v['cam'], v['look']
    half = max(350.0, 1.4 * float(np.hypot(cx - lx, cz - lz)))
    x0, z0 = lx - half, lz - half
    px = 2 * half / SIDE
    mos = aerial.mosaic(work, f'compare-{name}', x0, z0, x0 + 2 * half, z0 + 2 * half, OV)
    rgb = aerial.warp(mos, x0, z0, SIDE, SIDE, px)  # +z (south) runs down the rows: north up
    img = Image.fromarray((np.clip(rgb, 0, 1) * 255).astype(np.uint8))
    d = ImageDraw.Draw(img)
    to_px = lambda x, z: ((x - x0) / px, (z - z0) / px)  # noqa: E731
    c, l = to_px(cx, cz), to_px(lx, lz)
    d.line([c, l], fill=(255, 220, 0), width=2)
    d.ellipse([c[0] - 6, c[1] - 6, c[0] + 6, c[1] + 6], outline=(255, 220, 0), width=2)
    d.ellipse([l[0] - 3, l[1] - 3, l[0] + 3, l[1] + 3], fill=(255, 220, 0))
    bar = 100 if half < 600 else 500  # m
    d.rectangle([12, SIDE - 26, 12 + bar / px, SIDE - 20], fill=(255, 255, 255))
    d.text((12, SIDE - 42), f'{bar} m', fill=(255, 255, 255))
    d.text((SIDE - 22, 10), 'N', fill=(255, 255, 255))
    return img


def main():
    aerial.items_in = tiles_in
    a = dict(arg[2:].split('=', 1) for arg in sys.argv[3:] if arg.startswith('--') and '=' in arg)
    work, shots = sys.argv[1], sys.argv[2]
    prefix, tag = a.get('prefix', '124'), a.get('tag', 'after')
    out = os.path.join(aerial.ROOT, a.get('out', 'docs/screenshots/real-suburbs'))
    os.makedirs(out, exist_ok=True)
    only = a['only'].split(',') if 'only' in a else None
    for name, v in views_of(a.get('script', 'e2e/landmark-shots.mjs')).items():
        frame = os.path.join(shots, f'{prefix}-{name}-{tag}.png')
        if (only and name not in only) or not os.path.exists(frame):
            continue
        sheet = Image.new('RGB', (FRAME[0] + SIDE, SIDE), (0, 0, 0))
        sheet.paste(Image.open(frame).convert('RGB').resize(FRAME, Image.LANCZOS), (0, 0))
        sheet.paste(photo(work, name, v), (FRAME[0], 0))
        d = ImageDraw.Draw(sheet)
        d.text((10, 8), f'{name}: game, medium tier', fill=(255, 255, 255))
        d.text((FRAME[0] + 10, 8), 'LINZ / Auckland Council 2024-25 aerial (CC BY 4.0)', fill=(255, 255, 255))
        path = os.path.join(out, f'{prefix}-{name}.jpg')
        sheet.save(path, quality=72, optimize=True)
        print(path, os.path.getsize(path), 'B', flush=True)


if __name__ == '__main__':
    main()
