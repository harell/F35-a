"""
F35-A — hero buildings: Auckland War Memorial Museum (Tāmaki Paenga Hira) on Pukekawa / the Auckland Domain, for
src/core/museumData.ts (generated) — #143 item 3, #113 item 5.

  python3 tools/hero/site.py --name museum --lat -36.8604 --lon 174.7778 --size 260 --res 0.15 --scale 60
  python3 tools/hero/osm.py --site /tmp/hero/museum
  python3 tools/hero/mesh3d.py --site /tmp/hero/museum --match "War Memorial"     (colours, by eye)
  python3 tools/hero/sites/museum.py --site /tmp/hero/museum                        → src/core/museumData.ts

OpenStreetMap has the museum in 3D (way 23906678 and 15 building:parts): the neoclassical block, the portico's eight
columns and pediment, the 2007 Grand Atrium dome over the southern apse. The parts give the plan; the LiDAR gives every
height:
- the block: the LiDAR height above the ground inside the building outline (not inside the domes), classed into 3 m
  bands, mode-filtered 3 m, traced at 0.5 m and simplified 1 m (as the tower kit); each terrace's roof is its median;
- the two domes (the Grand Atrium, way 832497372, and the old central dome, which OSM doesn't outline: the largest
  group of cells over 24.5 m outside the atrium): nested prisms from the LiDAR's contours every 1.2 m, so they taper;
- the portico columns (ways 832497376–83): cylinders on their OSM outlines to their LiDAR p90.
Heights are over the 10th-percentile ground inside the outline (the museum stands on the crown of Pukekawa).
Colours from Auckland Council's 2023 3D mesh views: Portland-stone white walls, the atrium's blue-grey glass on a copper
ring, the central dome's verdigris.
Data: LINZ 2024 LiDAR (CC BY 4.0); © OpenStreetMap contributors (ODbL); Auckland Council 3D mesh 2023 (CC BY 4.0).
"""
import argparse, json, math, os, sys

import numpy as np
from scipy import ndimage
from shapely.geometry import Polygon
from shapely.ops import unary_union

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..'))
sys.path.insert(0, HERE)
from heights import ring_mask  # noqa: E402
from cbd_towers import parts_of, polys, px_to_game  # noqa: E402

BUILDING = 'way/23906678'
ATRIUM = 'way/832497372'
COLUMNS = [f'way/8324973{i}' for i in range(76, 84)]


def game_ring(poly, box):
    return [round(v, 2) for x, z in list(poly.exterior.coords)[:-1] for v in px_to_game(x, z, box)]


def dome_steps(mask, nd, g0, step, box):
    """Nested prisms over the cells of `mask`, one per LiDAR contour every `step` m."""
    out = []
    vals = nd[mask]
    lv, hi = float(np.percentile(vals, 5)), float(vals.max())
    while lv < hi - 0.4:
        cm = mask & (nd >= lv)
        lab, n = ndimage.label(cm)
        if n:
            big = lab == (np.bincount(lab.ravel())[1:].argmax() + 1)
            ps = polys(big)
            if ps:
                q = Polygon(max(ps, key=lambda q: q.area).simplify(0.5, preserve_topology=True).exterior)
                if q.area >= 3:
                    out.append({'ring': game_ring(q, box), 'h': round(float(np.median(nd[big])) - g0, 2)})
        lv += step
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--site', default='/tmp/hero/museum')
    ap.add_argument('--ts', default=os.path.join(HERE, '..', '..', '..', 'src', 'core', 'museumData.ts'))
    a = ap.parse_args()
    d = np.load(f'{a.site}/lidar.npz')
    dsm, dem = d['dsm'], d['dem']
    box = [float(v) for v in d['box']]
    feats = {f['id']: f for f in json.load(open(f'{a.site}/osm.json'))['features']}
    outline = Polygon(feats[BUILDING]['ring']).buffer(0)
    m = ring_mask(dem.shape, feats[BUILDING]['ring'])
    g0 = float(np.percentile(dem[m], 10))
    hr = dsm - g0  # over the ground the game stands it on
    atrium = ring_mask(dem.shape, feats[ATRIUM]['ring'])
    # the old dome: OSM doesn't outline it; the largest group over 24.5 m outside the atrium (≈ 9 m across)
    lab, n = ndimage.label(m & ~atrium & (hr > 24.5))
    centre = lab == (np.bincount(lab.ravel())[1:].argmax() + 1)

    # the block: 3 m bands outside the domes
    body = m & ~atrium & ~centre & (dsm - dem > 2.0)
    band = np.full(dem.shape, -1, np.int16)
    band[body] = np.clip((hr[body] / 3).astype(int), 0, 40)
    sub = ndimage.generic_filter(band, lambda v: np.bincount(v.astype(int) + 1, minlength=42).argmax() - 1, size=3, mode='nearest').astype(np.int16)
    sub[~body] = -1
    parts = []
    for k in sorted(set(sub[sub >= 0].ravel().tolist())):
        km = sub == k
        if km.sum() < 25:
            continue
        for p in polys(km):
            for q in parts_of(p.intersection(outline).simplify(1.0, preserve_topology=True)):
                q = Polygon(q.exterior)
                cells = ring_mask(dem.shape, list(q.exterior.coords)[:-1]) & km
                if cells.sum() < 15:
                    continue
                parts.append({'kind': 'block', 'ring': game_ring(q, box), 'h': round(float(np.median(hr[cells])), 2), 'cells': cells, 'poly': q})
    # the atrium's drum (the apse's walls up to the dome's springing) and the two domes
    drum_h = float(np.percentile(hr[atrium & (dsm - dem > 2)], 20))
    parts.append({'kind': 'block', 'ring': game_ring(Polygon(feats[ATRIUM]['ring']).buffer(0), box), 'h': round(drum_h, 2)})
    for s in dome_steps(atrium & (hr > drum_h + 0.5), hr, 0, 1.2, box):
        parts.append({'kind': 'atrium', **s})
    for s in dome_steps(centre, hr, 0, 1.2, box):
        parts.append({'kind': 'dome', **s})
    cols = []
    for cid in COLUMNS:
        r = feats[cid]['ring']
        c = Polygon(r).centroid
        cm = ring_mask(dem.shape, r)
        x, z = px_to_game(c.x, c.y, box)
        cols.append([round(x, 2), round(z, 2), round(math.sqrt(Polygon(r).area / math.pi), 2), round(float(np.percentile(hr[cm], 90)), 2)])
    # spot checks for the test: a flat cell well inside each of the three largest block terraces (3×3 median)
    from shapely import contains_xy
    spread = ndimage.maximum_filter(hr, 5) - ndimage.minimum_filter(hr, 5)
    spots = []
    for p in sorted([p for p in parts if 'cells' in p], key=lambda p: -p['poly'].area)[:3]:
        er = ndimage.binary_erosion(p['cells'], iterations=2) & (spread < 1.0)
        ys, xs = np.where(er)
        ok = contains_xy(p['poly'].buffer(-0.7), xs + 0.5, ys + 0.5)
        ys, xs = ys[ok], xs[ok]
        if len(ys):
            y, x = ys[len(ys) // 2], xs[len(xs) // 2]
            gx, gz = px_to_game(x + 0.5, y + 0.5, box)
            spots.append([round(gx, 1), round(gz, 1), round(float(np.median(hr[y - 1:y + 2, x - 1:x + 2])), 1)])
    for p in parts:
        p.pop('cells', None)
        p.pop('poly', None)
    # where the game stands it: the outline's centroid
    oc = outline.centroid
    cx, cz = px_to_game(oc.x, oc.y, box)
    lines = [
        '/**',
        ' * F35-A — GENERATED by tools/hero/sites/museum.py: Auckland War Memorial Museum (Tāmaki Paenga Hira) on Pukekawa.',
        ' * The neoclassical block as LiDAR terraces in its OpenStreetMap outline (way 23906678), the 2007 Grand Atrium dome',
        ' * and the old central dome as nested prisms from the LiDAR contours, the portico columns on their OSM parts.',
        ' * Heights over the 10th-percentile ground in the outline. Colours from Auckland Council\'s 2023 3D mesh.',
        ' * Sources: LINZ 2024 LiDAR (CC BY 4.0); © OpenStreetMap contributors (ODbL); Auckland Council 3D mesh (CC BY 4.0).',
        ' * Builder: world/scenery/museum.ts; the shared shape (scenery and sim): core/museum.ts. Do not edit by hand.',
        ' */',
        '',
        "export type MuseumPartKind = 'block' | 'atrium' | 'dome';",
        '',
        '/** Where the game stands the museum: its outline\'s centroid (game m). */',
        f'export const MUSEUM_CENTRE = {{ x: {cx:.1f}, z: {cz:.1f} }};',
        '',
        '/** Parts: a ring (flat [x0, z0, …], game m) up to h m over the ground; domes as nested rings, inner ones higher. */',
        'export const MUSEUM_PARTS: readonly { kind: MuseumPartKind; h: number; ring: readonly number[] }[] = [',
    ]
    for p in parts:
        lines.append(f"  {{ kind: '{p['kind']}', h: {p['h']}, ring: [{', '.join(str(v) for v in p['ring'])}] }},")
    lines += ['];', '', '/** The portico columns: [x, z, radius, top over the ground] (m). */',
              f'export const MUSEUM_COLUMNS: readonly (readonly number[])[] = {json.dumps(cols)};', '',
              '/** LiDAR spot checks [x, z, roof over the ground] (m, 3×3 median) on the block\'s three largest roofs. */',
              f'export const MUSEUM_SPOTS: readonly (readonly number[])[] = {json.dumps(spots)};', '',
              '/** The OSM outline (game m): nothing procedural stands inside it. */',
              f'export const MUSEUM_OUTLINE: readonly number[] = [{", ".join(str(v) for v in game_ring(outline, box))}];', '']
    open(a.ts, 'w').write('\n'.join(lines))
    print('parts', len(parts), {k: sum(1 for p in parts if p['kind'] == k) for k in ('block', 'atrium', 'dome')}, 'top',
          max(p['h'] for p in parts), 'columns', len(cols), 'centre', round(cx), round(cz))


if __name__ == '__main__':
    main()
