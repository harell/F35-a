"""
F35-A — hero buildings: LiDAR height statistics inside rings (OSM parts, your own outlines).

  python3 tools/hero/heights.py --site /tmp/hero/<name> [--match westfield]

For every OSM building / part ring in <site>/osm.json (optionally filtered), prints the nDSM
(height above ground) p10 / median / p90 / max inside it and its area, and writes <site>/heights-osm.json.
Use the median for a flat roof, p90 for parapets and plant, max for a spire or a dome top; a wide
p10–p90 spread means the ring holds several levels (split it, or fit planes as for Spark Arena).
Also importable: `ring_stats(nd, ring)` and `ring_mask(shape, ring)`.
"""
import argparse, json

import numpy as np
from PIL import Image, ImageDraw


def ring_mask(shape, ring):
    """Boolean mask (rows = z, cols = x, 1 m cells) of the pixels inside a local-frame ring."""
    im = Image.new('1', (shape[1], shape[0]), 0)
    ImageDraw.Draw(im).polygon([(x, z) for x, z in ring], fill=1)
    return np.array(im, dtype=bool)


def ring_stats(nd, ring):
    m = ring_mask(nd.shape, ring) & ~np.isnan(nd)
    v = nd[m]
    if v.size == 0:
        return None
    return {'area_m2': int(m.sum()), 'p10': round(float(np.percentile(v, 10)), 1), 'median': round(float(np.median(v)), 1),
            'p90': round(float(np.percentile(v, 90)), 1), 'max': round(float(v.max()), 1)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--site', required=True)
    ap.add_argument('--match', default=None)
    a = ap.parse_args()
    d = np.load(f'{a.site}/lidar.npz')
    nd = d['dsm'] - d['dem']
    out = []
    for f in json.load(open(f'{a.site}/osm.json'))['features']:
        if len(f['ring']) < 3:
            continue
        name = f['tags'].get('name') or ''
        if a.match and a.match.lower() not in name.lower() and f['kind'] != 'part':
            continue
        s = ring_stats(nd, f['ring'])
        if s:
            out.append({'id': f['id'], 'kind': f['kind'], 'name': name, 'levels': f['tags'].get('building:levels'), **s})
            print(f"{f['id']:>18} {f['kind']:<8} {name[:22]:<22} L{f['tags'].get('building:levels', '?'):<3} "
                  f"area {s['area_m2']:>6} m²  p10 {s['p10']:>5}  med {s['median']:>5}  p90 {s['p90']:>5}  max {s['max']:>5}")
    json.dump(out, open(f'{a.site}/heights-osm.json', 'w'), indent=1)


if __name__ == '__main__':
    main()
