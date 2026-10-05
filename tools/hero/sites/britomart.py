"""
F35-A — hero buildings: Britomart (Waitematā) station, measured for src/core/britomart.ts.

The station is three things above ground:
  the Chief Post Office (1912, the main entrance on Te Komititanga): the CBD tower kit already traces its LiDAR terraces
    (cbd_towers.tsv row 202); here its two corner domes (OSM building:parts with roof:shape=dome, height from the point
    cloud) and the flagpole on the front pediment (the highest point-cloud returns off the domes);
  the Glasshouse (2003, Jasmax/Mario Madayag: the glass pavilion behind it, the east entrance): one LiDAR terrace inside
    its OSM outline (p90 of the 1 m DSM, since glass lets returns through) and its roof plant;
  the skylight cones over the tracks in Takutai Square (OSM parts tagged brick with a glass roof): centre and radius of
    each from its outline, height from the 1 m DSM.
Every number comes out in game metres (origin the Sky Tower, +x east, +z south), heights above the ground under it.

  python3 tools/hero/site.py --name britomart --lat -36.8441 --lon 174.7683 --size 320
  python3 tools/hero/osm.py --site /tmp/hero/britomart
  python3 tools/hero/pointcloud.py --site /tmp/hero/britomart --match "Chief Post Office"
  python3 tools/hero/sites/britomart.py --site /tmp/hero/britomart   → <site>/britomart.json (paste into britomart.ts)

Data: LINZ 2024 Auckland LiDAR (DSM/DEM 1 m and the classified point cloud, CC BY 4.0); © OpenStreetMap contributors
(ODbL) for the outlines.
"""
import argparse, json, math, os, sys

import numpy as np
from pyproj import Transformer
from shapely.geometry import Polygon

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..'))
from heights import ring_mask  # noqa: E402

ORIGIN = (-36.8485, 174.7622)  # src/core/auckland.ts AKL_ORIGIN
MLAT = 110_950
MLON = 111_320 * math.cos(math.radians(ORIGIN[0]))
to_wgs = Transformer.from_crs(2193, 4326, always_xy=True)

GLASSHOUSE = 'way/24252617'
DOMES = ['way/1176872738', 'way/1176872739']
CONES = [f'way/{1034984721 + i}' for i in range(11)]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--site', required=True)
    a = ap.parse_args()
    site = json.load(open(f'{a.site}/site.json'))
    E0, N0, E1, N1 = site['box_nztm']
    li = np.load(f'{a.site}/lidar.npz')
    dsm, dem = li['dsm'], li['dem']
    pc = np.load(f'{a.site}/points.npz')
    feats = {f['id']: f for f in json.load(open(f'{a.site}/osm.json'))['features']}

    def game(x, z):
        lon, lat = to_wgs.transform(E0 + x, N1 - z)
        return round((lon - ORIGIN[1]) * MLON, 2), round((ORIGIN[0] - lat) * MLAT, 2)

    def flat(ring):
        return [c for x, z in ring for c in game(x, z)]

    def cells(ring):
        m = ring_mask(dsm.shape, ring) & ~np.isnan(dsm)
        return dsm[m], dem[m], m

    out = {}

    # the Glasshouse: one terrace at the p90 roof over the median ground inside it; plant over it
    ring = feats[GLASSHOUSE]['ring']
    top, ground, m = cells(ring)
    g = float(np.median(ground))
    roof = float(np.percentile(top, 90)) - g
    hi = m & (dsm - g > roof + 2.5)
    plant = []
    if hi.sum() >= 12:
        zz, xx = np.nonzero(hi)
        r = Polygon(list(zip(xx + 0.5, zz + 0.5))).minimum_rotated_rectangle
        plant = [{'h': round(float(np.percentile(dsm[hi], 90)) - g, 1), 'ring': flat(list(r.exterior.coords)[:-1])}]
    poly = Polygon(ring)
    out['glasshouse'] = {
        'ground': round(g, 2), 'h': round(roof, 1), 'median': round(float(np.median(top)) - g, 1),
        'ring': flat(poly.simplify(0.5).exterior.coords[:-1]), 'plant': plant,
        'centre': game(poly.centroid.x, poly.centroid.y), 'area': round(poly.area),
    }

    # the CPO's ground: the median DEM inside its outline (the kit's heights are over it)
    cpo = next(f for f in feats.values() if f['tags'].get('name') == 'Chief Post Office')
    _, cg, _ = cells(cpo['ring'])
    g0 = float(np.median(cg))
    out['cpo_ground'] = round(g0, 2)

    # the domes: centre and equal-area radius from the outline, top from the point cloud
    domes = []
    for fid in DOMES:
        p = Polygon(feats[fid]['ring'])
        cx, cz = p.centroid.x, p.centroid.y
        r = math.sqrt(p.area / math.pi)
        k = np.hypot(pc['x'] - cx, pc['z'] - cz) < r
        ys = pc['y'][k]
        top = float(np.percentile(ys, 99.5)) - g0
        # the drum's top: where the returns stop spreading out to the full radius
        rr = np.hypot(pc['x'][k] - cx, pc['z'][k] - cz)
        yy = ys - g0
        base = float(np.percentile(yy[(rr > 0.8 * r) & (yy > top - 2 * r)], 20))
        domes.append({'x': game(cx, cz)[0], 'z': game(cx, cz)[1], 'r': round(r, 2), 'base': round(base, 1), 'top': round(top, 1)})
    out['domes'] = domes

    # the flagpole: the highest returns inside the CPO off the domes
    cp = Polygon(cpo['ring'])
    from shapely import contains_xy
    k = contains_xy(cp, pc['x'], pc['z'])
    for d in DOMES:
        q = Polygon(feats[d]['ring']).buffer(2)
        k &= ~contains_xy(q, pc['x'], pc['z'])
    i = np.argsort(pc['y'][k])[-5:]
    fx, fz, fy = pc['x'][k][i].mean(), pc['z'][k][i].mean(), pc['y'][k][i].max()
    out['flagpole'] = {'x': game(fx, fz)[0], 'z': game(fx, fz)[1], 'top': round(float(fy) - g0, 1)}

    # the cones in Takutai Square
    cones = []
    for fid in CONES:
        p = Polygon(feats[fid]['ring'])
        top, ground, _ = cells(feats[fid]['ring'])
        h = float(top.max() - np.median(ground)) if top.size else 0
        cx, cz = game(p.centroid.x, p.centroid.y)
        cones.append([cx, cz, round(math.sqrt(p.area / math.pi), 2), round(h, 1)])
    out['cones'] = cones
    json.dump(out, open(f'{a.site}/britomart.json', 'w'), indent=1)
    print(json.dumps(out, indent=1))


if __name__ == '__main__':
    main()
