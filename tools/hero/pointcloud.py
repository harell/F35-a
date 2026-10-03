"""
F35-A — hero buildings: the classified LINZ 2024 Auckland LiDAR point cloud over a site (CC BY 4.0).

The 1 m DSM/DEM rasters (tools/hero/site.py) keep one height per metre: roofs, not walls. The point cloud keeps every
return (~20 points/m² on a tower), including the ones that hit walls at the scanner's 10–20° angles, so it gives what
the rasters lose: slab levels and storey height, wall lines, parapets, roof plant, thin things (masts, cranes, trusses).

The tiles are on OpenTopography's public bucket (no key), named like the 1:1000 aerial tiles site.json lists:
  https://opentopography.s3.sdsc.edu/pc-bulk/NZ24_Auckland/CL2_<sheet>_2024_1000_<rrcc>.laz

  python3 tools/hero/pointcloud.py --site /tmp/hero/<id> [--match <OSM name>] [--buffer 4]

Writes into the site folder:
  points.npz       the points in the box (x, z in the site frame, y = height above datum, class, intensity)
  storeys.json     per matched OSM building: points inside, slab levels (peaks of the wall/balcony points'
                   heights), their median spacing (the storey height), roof (p95) and top (max) heights
  pc_<side>.png    side views (north, south, east, west) of the matched buildings' points, 0.1 m per pixel, height
                   ticks every 5 m: count the storeys, see setbacks, balconies, fins
Tiles are cached in /tmp/hero/_laz. Needs: pip install "laspy[lazrs]" shapely scipy.
"""
import argparse, json, os, re, urllib.request

import numpy as np
from PIL import Image, ImageDraw

BUCKET = 'https://opentopography.s3.sdsc.edu/pc-bulk/NZ24_Auckland'
CACHE = '/tmp/hero/_laz'


def tiles_for(site):
    """LAZ tile names from the 1:1000 aerial tiles site.py recorded (same grid)."""
    names = set()
    for t in site['tiles'].get('aerial', []):
        m = re.match(r'(BA\d\d)_1000_(\d{4})', t)
        if m:
            names.add(f'CL2_{m.group(1)}_2024_1000_{m.group(2)}.laz')
    return sorted(names)


def fetch(name):
    os.makedirs(CACHE, exist_ok=True)
    path = f'{CACHE}/{name}'
    if not os.path.exists(path):
        urllib.request.urlretrieve(f'{BUCKET}/{name}', path + '.part')
        os.replace(path + '.part', path)
    return path


def side_view(x, z, y, side, path, px=0.1):
    """Orthographic side view: nearest points drawn last, colour by depth."""
    u, d = {'south': (x, z), 'north': (-x, -z), 'east': (-z, x), 'west': (z, -x)}[side]
    u0, y0 = np.percentile(u, 0.5), max(0.0, float(np.percentile(y, 0.5)) - 2)
    W = int((np.percentile(u, 99.5) - u0) / px) + 1
    H = int((y.max() - y0) / px) + 40
    if W < 2 or H < 2 or W * H > 60e6:
        return
    iu, iv = ((u - u0) / px).astype(int), (H - 1 - (y - y0) / px).astype(int)
    ok = (iu >= 0) & (iu < W) & (iv >= 0) & (iv < H)
    o = np.argsort(d[ok])
    t = (d[ok][o] - d.min()) / (np.ptp(d) or 1)
    img = np.full((H, W, 3), 255, np.uint8)
    img[iv[ok][o], iu[ok][o]] = np.stack([40 + 160 * t, 60 + 120 * t, 200 - 60 * t], 1).astype(np.uint8)
    im = Image.fromarray(img)
    dr = ImageDraw.Draw(im)
    for h in range(int(y0 // 5 + 1) * 5, int(y.max()) + 1, 5):
        v = int(H - 1 - (h - y0) / px)
        dr.line([(0, v), (30, v)], fill=(200, 30, 30), width=2)
        dr.text((34, v - 6), f'{h} m', fill=(200, 30, 30))
    im.save(path)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--site', required=True)
    ap.add_argument('--match', default='', help='OSM building name to analyse (substring); default: every named building')
    ap.add_argument('--buffer', type=float, default=4, help='m around the outlines kept for the side views')
    a = ap.parse_args()
    import laspy
    from shapely import contains_xy
    from shapely.geometry import Polygon
    from shapely.ops import unary_union
    from scipy.signal import find_peaks

    site = json.load(open(f'{a.site}/site.json'))
    E0, N0, E1, N1 = site['box_nztm']
    X, Y, Z, C, I = [], [], [], [], []
    for name in tiles_for(site):
        try:
            f = laspy.read(fetch(name))
        except Exception as e:  # noqa: BLE001 — a tile can be missing at the edge of the survey
            print('skip', name, e)
            continue
        x, y = np.asarray(f.x), np.asarray(f.y)
        m = (x >= E0) & (x < E1) & (y >= N0) & (y < N1)
        X.append(x[m] - E0); Z.append(N1 - y[m]); Y.append(np.asarray(f.z)[m]); C.append(np.asarray(f.classification)[m]); I.append(np.asarray(f.intensity)[m])
        print(name, int(m.sum()), 'points in the box')
    X, Y, Z, C, I = [np.concatenate(v) for v in (X, Y, Z, C, I)]
    keep = (C != 7) & (C != 18)  # noise
    X, Y, Z, C, I = X[keep], Y[keep], Z[keep], C[keep], I[keep]
    np.savez_compressed(f'{a.site}/points.npz', x=X, z=Z, y=Y, cls=C, intensity=I)

    feats = [f for f in json.load(open(f'{a.site}/osm.json'))['features'] if f['kind'] == 'building' and len(f['ring']) > 3]
    feats = [f for f in feats if (a.match.lower() in f['tags'].get('name', '').lower()) and (a.match or f['tags'].get('name'))]
    out = {}
    for f in feats:
        p = Polygon(f['ring']).buffer(0)
        inside = contains_xy(p, X, Z)
        ys = Y[inside]
        if len(ys) < 200:
            continue
        roof = float(np.percentile(ys, 95))
        # slab edges and balconies: the returns well below the roof pile up at each floor level
        g = float(np.percentile(Y[contains_xy(p.buffer(6), X, Z) & (C == 2)], 50)) if ((C == 2) & contains_xy(p.buffer(6), X, Z)).any() else float(ys.min())
        w = ys[(ys > g + 4) & (ys < roof - 2.5)]
        levels = []
        if len(w) > 100:
            h, e = np.histogram(w, bins=np.arange(g + 4, roof - 2.5, 0.1))
            hs = np.convolve(h, np.ones(3) / 3, 'same')
            pk, _ = find_peaks(hs, distance=20, prominence=max(1.0, float(np.median(hs)) * 0.5))
            levels = [round(float(e[k]) + 0.05, 2) for k in pk]
        sp = np.diff(levels)
        storey = round(float(np.median(sp)), 2) if len(sp) else None
        name = f['tags'].get('name') or f['id']
        out[name] = {'id': f['id'], 'points': int(inside.sum()), 'per_m2': round(float(inside.sum() / p.area), 1), 'ground': round(g, 2),
                     'roof_p95': round(roof, 2), 'top': round(float(ys.max()), 2), 'slab_levels': levels, 'storey_height': storey}
        print(name, {k: v for k, v in out[name].items() if k != 'slab_levels'}, len(levels), 'levels')
    json.dump(out, open(f'{a.site}/storeys.json', 'w'), indent=1)
    if feats:
        u = unary_union([Polygon(f['ring']).buffer(0) for f in feats]).buffer(a.buffer)
        m = contains_xy(u, X, Z)
        for side in ('south', 'north', 'east', 'west'):
            side_view(X[m], Z[m], Y[m], side, f'{a.site}/pc_{side}.png')
    print('wrote', f'{a.site}/points.npz, storeys.json, pc_*.png')


if __name__ == '__main__':
    main()
