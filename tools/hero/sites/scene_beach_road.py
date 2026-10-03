"""
F35-A — hero buildings: the Scene apartments on Beach Road, Auckland CBD (Scene One, 2 Beach Rd; Scene Two, 18 Beach Rd;
Scene Three, 30 Beach Rd), for tools/hero/examples/scene-beach-road.html.

  python3 tools/hero/site.py --name scene --lat -36.84555 --lon 174.77215 --size 320 --res 0.15 --scale 70
  python3 tools/hero/osm.py --site /tmp/hero/scene
  python3 tools/hero/sites/scene_beach_road.py --site /tmp/hero/scene        → <site>/scene_model.json

Each OSM outline (ways 355401751, 355401752, 23907610) holds a ~49 m apartment slab on Beach Road and a 8–15 m podium
behind it (the supermarket, car park, pool and tennis court), so one height per outline is wrong. Inside each outline
the LiDAR height above ground is classed into terraces (tower > 30 m, upper podium 12.5–30 m, podium 5–12.5 m, low
< 5 m), cleaned with a 3 m mode filter, traced into polygons at 0.5 m (skimage contours → shapely, simplified 1.2 m,
pieces under 25 m² dropped) and clipped to the outline. Each terrace gets its median DSM as a flat roof; lift overruns and
plant (> 2 m over a tower roof, > 12 m²) become boxes. Walls start at the 10th percentile of the ground inside the
outline. Facades are from Mapillary street imagery (CC BY-SA 4.0, 2021–25): see the page.
Data: LINZ 2024 LiDAR (CC BY 4.0); © OpenStreetMap contributors (ODbL).
"""
import argparse, json, os, sys

import numpy as np
from scipy import ndimage
from shapely.geometry import Polygon, MultiPolygon
from shapely.ops import unary_union
from skimage import measure

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
from heights import ring_mask  # noqa: E402

TOWERS = {'way/355401751': 'Scene One', 'way/355401752': 'Scene Two', 'way/23907610': 'Scene Three'}
CLASSES = [(30, 99, 'tower'), (12.5, 30, 'podium_high'), (5, 12.5, 'podium'), (-5, 5, 'low')]
UP = 2  # trace masks at 0.5 m


def polys(mask):
    """Polygons (shapely) around the True cells of a 1 m mask, in site metres."""
    big = np.kron(mask, np.ones((UP, UP), dtype=bool))
    out = []
    for c in measure.find_contours(np.pad(big, 1).astype(float), 0.5):
        pts = [((x - 1) / UP, (y - 1) / UP) for y, x in c]
        if len(pts) >= 4:
            p = Polygon(pts).buffer(0)
            if p.area > 1:
                out.append(p)
    # contours of holes come back as separate rings: subtract the ones inside others
    out.sort(key=lambda p: -p.area)
    shapes = []
    for p in out:
        host = next((s for s in shapes if s.contains(p.representative_point())), None)
        if host is None:
            shapes.append(p)
        else:
            shapes[shapes.index(host)] = host.difference(p)
    return shapes


def rings_of(geom):
    gs = geom.geoms if isinstance(geom, MultiPolygon) else [geom]
    return [g for g in gs if g.area >= 25]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--site', required=True)
    S = ap.parse_args().site
    d = np.load(f'{S}/lidar.npz')
    dsm, dem = d['dsm'], d['dem']
    nd = dsm - dem
    feats = {f['id']: f for f in json.load(open(f'{S}/osm.json'))['features']}
    terraces, plant = [], []
    for wid, name in TOWERS.items():
        ring = feats[wid]['ring']
        m = ring_mask(dem.shape, ring)
        outline = Polygon(ring).buffer(0)
        g0 = float(np.percentile(dem[m], 10))
        cls = np.full(dem.shape, -1, np.int8)
        for k, (lo, hi, _) in enumerate(CLASSES):
            cls[m & (nd >= lo) & (nd < hi)] = k
        cls = ndimage.generic_filter(cls, lambda v: np.bincount(v[v >= 0].astype(int), minlength=4).argmax() if (v >= 0).any() else -1, size=3, mode='nearest').astype(np.int8)
        cls[~m] = -1
        for k, (_, _, kind) in enumerate(CLASSES):
            km = cls == k
            if km.sum() < 25:
                continue
            for p in polys(km):
                for q in rings_of(p.intersection(outline).simplify(1.2, preserve_topology=True)):
                    cells = ring_mask(dem.shape, list(q.exterior.coords)) & m & (cls == k)
                    if cells.sum() < 10:
                        continue
                    roof = float(np.median(dsm[cells]))
                    terraces.append({'building': name, 'kind': kind, 'ring': [[round(x, 2), round(z, 2)] for x, z in q.exterior.coords][:-1],
                                     'holes': [[[round(x, 2), round(z, 2)] for x, z in h.coords][:-1] for h in q.interiors if Polygon(h).area > 20],
                                     'y0': round(g0, 2), 'y1': round(roof, 2), 'area': round(q.area, 1)})
                    if kind == 'tower':
                        lab, n = ndimage.label(cells & (dsm > roof + 2.0))
                        for j in range(1, n + 1):
                            ys, xs = np.where(lab == j)
                            if len(ys) < 12:
                                continue
                            hull = Polygon(np.c_[xs + 0.5, ys + 0.5]).convex_hull if len(ys) > 2 else None
                            rect = unary_union([Polygon([(x, y), (x + 1, y), (x + 1, y + 1), (x, y + 1)]) for x, y in zip(xs, ys)]).minimum_rotated_rectangle
                            plant.append({'building': name, 'ring': [[round(x, 2), round(z, 2)] for x, z in rect.exterior.coords][:-1],
                                          'y0': round(roof, 2), 'y1': round(float(np.percentile(dsm[ys, xs], 90)), 2)})
        print(name, 'ground', round(g0, 2), [(t['kind'], t['area'], round(t['y1'] - g0, 1)) for t in terraces if t['building'] == name])
    print('plant boxes', len(plant))
    json.dump({'terraces': terraces, 'plant': plant, 'outlines': {n: feats[w]['ring'] for w, n in TOWERS.items()}}, open(f'{S}/scene_model.json', 'w'))


if __name__ == '__main__':
    main()
