"""
F35-A — hero buildings: draw the OSM outlines (and optional extra rings) over the LiDAR heights and the
aerial photo, to check that the sources agree before modelling.

  python3 tools/hero/overlay.py --site /tmp/hero/<name> [--match <substring of name or id>] [--rings extra.json]

Writes <site>/overlay-ndsm.png and <site>/overlay-aerial.jpg. Building outlines are yellow, building
parts cyan (labelled with their levels or height), `--rings` (a JSON list of [[x, z], ...] rings in the
local frame, e.g. your own fitted footprint) magenta. Look at both images: the LiDAR shows the true
footprint and heights; the aerial shows roofs displaced away from the photo centre on tall buildings.
"""
import argparse, json

import numpy as np
from PIL import Image, ImageDraw


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--site', required=True)
    ap.add_argument('--match', default=None)
    ap.add_argument('--rings', default=None)
    ap.add_argument('--scale', type=float, default=None, help='nDSM metres shown as white (default: 99th percentile)')
    a = ap.parse_args()
    d = np.load(f'{a.site}/lidar.npz')
    nd = np.nan_to_num(d['dsm'] - d['dem'])
    scale = a.scale or max(10.0, float(np.percentile(nd, 99)))
    feats = json.load(open(f'{a.site}/osm.json'))['features']
    if a.match:
        feats = [f for f in feats if a.match in f['id'] or a.match.lower() in (f['tags'].get('name') or '').lower() or f['kind'] == 'part']
    extra = json.load(open(a.rings)) if a.rings else []

    def draw(img, k):  # k = pixels per metre
        g = ImageDraw.Draw(img)
        for f in feats:
            if len(f['ring']) < 2:
                continue
            col = (0, 230, 255) if f['kind'] == 'part' else (255, 220, 0)
            g.line([(x * k, z * k) for x, z in f['ring']], fill=col, width=2)
            if f['kind'] == 'part':
                xs, zs = zip(*f['ring'])
                lab = f['tags'].get('height') or (f['tags'].get('building:levels', '?') + 'L')
                g.text((sum(xs) / len(xs) * k, sum(zs) / len(zs) * k), lab, fill=col)
        for r in extra:
            g.line([(x * k, z * k) for x, z in r] + [(r[0][0] * k, r[0][1] * k)], fill=(255, 0, 255), width=2)
        return img

    k = 3
    gray = (np.clip(nd / scale, 0, 1) * 255).astype(np.uint8)
    im = Image.fromarray(gray).convert('RGB').resize((nd.shape[1] * k, nd.shape[0] * k), Image.NEAREST)
    draw(im, k).save(f'{a.site}/overlay-ndsm.png')
    ae = Image.open(f'{a.site}/aerial.jpg').convert('RGB')
    ka = ae.width / nd.shape[1]
    draw(ae, ka).save(f'{a.site}/overlay-aerial.jpg', quality=85)
    print(f'{a.site}/overlay-ndsm.png  {a.site}/overlay-aerial.jpg  (white = {scale:.0f} m)')


if __name__ == '__main__':
    main()
