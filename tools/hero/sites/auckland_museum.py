"""
F35-A — hero landmarks: Tāmaki Paenga Hira / Auckland War Memorial Museum, a layer that stands on top of the Auckland
Domain (tools/hero/sites/auckland_domain.py), for tools/hero/examples/auckland-domain-museum.html.

  python3 tools/hero/site.py --name museum --lat -36.86071 --lon 174.77781 --size 260 --res 0.1 --scale 40
  python3 tools/hero/osm.py --site /tmp/hero/museum
  python3 tools/hero/sites/auckland_museum.py --site /tmp/hero/museum        → <site>/museum_model.json + tex_*.jpg

The OSM outline (way 23906678) holds a 1929 stone block with 1950s wings round two courtyards, the 2006 glass and copper
atrium dome over the southern courtyard and the north portico, so one height per outline is wrong (nDSM p10–p90
14.7–23.8 m). Shape, all from the LiDAR inside the outline:
  terraces   the DSM (3 m median) classed in absolute height bands (courts < 88 m, low 88–93, main 93–97.5, upper
             97.5–100.5, top > 100.5), traced at 0.5 m and simplified 1.0 m (scene_beach_road.polys); the dome and the
             portico are cut out. Each terrace is a prism from the lowest ground in the outline to its median DSM.
  dome       the atrium dome (OSM part 832497372, roof:shape=dome) as a heightfield: the DSM on a 1 m grid inside its ring,
             returns that fell through the glass (< 97 m) filled from the nearest roof cell, smoothed 1.5 m
  portico    the OSM portico part (832497384) as the entablature, its top at the median DSM; the 8 OSM columns
             (832497376–83) as cylinders from the ground to the entablature's underside
Colours: Auckland Council's 2023 3D mesh, projected straight onto four side planes and the roof (tools/hero/mesh3d.py
sample_points): tex_{north,south,east,west}.jpg map u = x (north/south) or z (east/west) over the outline's extent, v =
height from Y0 to Y0 + VH; tex_top.jpg maps the outline's box. Each wall takes the side its outward normal faces most.
Composition: `footprint` is the outline in this site's frame with `E0`, `N1`; a base layer (the Domain) clears its trees
and buildings inside it and fills its aerial under it. Heights are absolute (NZVD2016), so both layers meet on the same
LiDAR ground; on the game's terrain both move by meshHeightAt − DEM (the museum by one value, so it stays level).
Data: LINZ 2024 LiDAR (CC BY 4.0); Auckland Council 3D mesh 2023 (CC BY 4.0); © OpenStreetMap contributors (ODbL).
"""
import argparse, json, math, os, sys

import numpy as np
from PIL import Image
from scipy import ndimage
from shapely.geometry import Polygon
from shapely.ops import unary_union

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from heights import ring_mask  # noqa: E402
from mesh3d import sample_points  # noqa: E402
from scene_beach_road import polys, rings_of  # noqa: E402

MUSEUM, DOME, PORTICO = 'way/23906678', 'way/832497372', 'way/832497384'
COLUMNS = [f'way/8324973{k}' for k in range(76, 84)]
BANDS = [(0, 88, 'court'), (88, 93, 'low'), (93, 97.5, 'main'), (97.5, 100.5, 'upper'), (100.5, 200, 'top')]
VH, PX = 36.0, 0.08  # side textures: height span (m) and m per pixel


def r2(ring):
    return [[round(float(x), 2), round(float(z), 2)] for x, z in ring]


def splat(u, v, d, col, W, H, nearest_last):
    """Orthographic image from points: nearest point wins; small gaps filled from the nearest painted pixel."""
    iu, iv = u.astype(int), v.astype(int)
    ok = (iu >= 0) & (iu < W) & (iv >= 0) & (iv < H)
    o = np.argsort(d[ok] if nearest_last else -d[ok])
    img = np.zeros((H, W, 3), np.uint8)
    hit = np.zeros((H, W), bool)
    img[iv[ok][o], iu[ok][o]] = col[ok][o]
    hit[iv[ok][o], iu[ok][o]] = True
    dist, (ri, ci) = ndimage.distance_transform_edt(~hit, return_indices=True)
    img = img[ri, ci]
    img[dist > 6] = (205, 200, 190)  # nothing within 6 px: plain stone
    # the mesh texture is speckled with unsampled texels: a 3 px median per channel removes them
    return np.stack([ndimage.median_filter(img[..., k], size=3) for k in range(3)], -1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--site', required=True)
    a = ap.parse_args()
    S = json.load(open(os.path.join(a.site, 'site.json')))
    E0, N0, E1, N1 = S['box_nztm']
    L = np.load(os.path.join(a.site, 'lidar.npz'))
    dsm, dem = L['dsm'].astype(np.float32), L['dem'].astype(np.float32)
    feats = {f['id']: f for f in json.load(open(os.path.join(a.site, 'osm.json')))['features']}
    outline = Polygon(feats[MUSEUM]['ring']).buffer(0)
    dome_p, port_p = Polygon(feats[DOME]['ring']).buffer(0), Polygon(feats[PORTICO]['ring']).buffer(0)
    m = ring_mask(dsm.shape, feats[MUSEUM]['ring'])
    G0 = float(np.min(dem[m]))

    # ── terraces ──
    med = ndimage.median_filter(np.where(np.isnan(dsm), G0, dsm), size=3)
    cls = np.full(dsm.shape, -1, np.int8)
    for k, (lo, hi, _) in enumerate(BANDS):
        cls[m & (med >= lo) & (med < hi)] = k
    cut = outline.difference(dome_p.buffer(0.5)).difference(port_p)
    terraces = []
    for k, (_, _, kind) in enumerate(BANDS):
        km = cls == k
        if km.sum() < 20:
            continue
        for p in polys(km):
            for q in rings_of(p.intersection(cut).simplify(1.0, preserve_topology=True)):
                cells = ring_mask(dsm.shape, list(q.exterior.coords)) & (cls == k)
                if cells.sum() < 10:
                    continue
                terraces.append({'kind': kind, 'ring': r2(q.exterior.coords[:-1]), 'y0': round(G0, 2),
                                 'y1': round(float(np.median(med[cells])), 2), 'area': round(q.area, 1)})
    # anything in the outline no band covered (thin slivers at the edge) joins the main terrace's height
    covered = unary_union([Polygon(t['ring']) for t in terraces] + [dome_p, port_p]).buffer(0.01)
    main_h = float(np.median([t['y1'] for t in terraces if t['kind'] == 'main']))
    for q in rings_of(outline.difference(covered).buffer(-0.3).buffer(0.3)):
        if q.area > 15:
            terraces.append({'kind': 'fill', 'ring': r2(q.exterior.coords[:-1]), 'y0': round(G0, 2), 'y1': round(main_h, 2), 'area': round(q.area, 1)})

    # ── atrium dome as a heightfield ──
    x0, z0, x1, z1 = [int(math.floor(v)) for v in dome_p.bounds[:2]] + [int(math.ceil(v)) for v in dome_p.bounds[2:]]
    dm = ring_mask(dsm.shape, feats[DOME]['ring'])[z0:z1 + 1, x0:x1 + 1]
    patch = dsm[z0:z1 + 1, x0:x1 + 1].copy()
    good = dm & (patch > 97)
    _, (ri, ci) = ndimage.distance_transform_edt(~good, return_indices=True)
    patch = ndimage.gaussian_filter(patch[ri, ci], 1.5)
    dome = {'ring': r2(feats[DOME]['ring']), 'x0': x0 + 0.5, 'z0': z0 + 0.5, 'nx': x1 - x0 + 1, 'nz': z1 - z0 + 1,
            'h': [round(float(v), 2) for v in patch.ravel()], 'top': round(float(patch[dm].max()), 2), 'rim': round(float(np.percentile(patch[dm], 5)), 2)}

    # ── portico ──
    pm = ring_mask(dsm.shape, feats[PORTICO]['ring'])
    ent_top = float(np.median(med[pm]))
    cols = []
    for cid in COLUMNS:
        P = Polygon(feats[cid]['ring'])
        cols.append([round(P.centroid.x, 2), round(P.centroid.y, 2), round(0.6 * math.sqrt(P.area / math.pi), 2)])
    portico = {'ring': r2(feats[PORTICO]['ring']), 'top': round(ent_top, 2), 'under': round(ent_top - 4.2, 2), 'columns': cols}

    # ── colours from the 2023 mesh: four side planes and the roof ──
    area = Polygon([(E0 + x, N1 - z) for x, z in outline.buffer(1.5).exterior.coords])
    x, z, y, col = sample_points(S, area, PX)
    bx0, bz0, bx1, bz1 = outline.bounds
    tex = {'y0': round(G0, 2), 'vh': VH, 'x': [round(bx0 - 2, 2), round(bx1 + 2, 2)], 'z': [round(bz0 - 2, 2), round(bz1 + 2, 2)]}
    H = int(VH / PX)
    v = (G0 + VH - y) / PX
    for side, (u, lo, hi, d, last) in {
        'north': (x, *tex['x'], z, False), 'south': (x, *tex['x'], z, True),
        'east': (z, *tex['z'], x, True), 'west': (z, *tex['z'], x, False),
    }.items():
        W = int((hi - lo) / PX)
        Image.fromarray(splat((u - lo) / PX, v, d, col, W, H, last)).save(os.path.join(a.site, f'tex_{side}.jpg'), quality=86)
    W, Hh = int((tex['x'][1] - tex['x'][0]) / PX), int((tex['z'][1] - tex['z'][0]) / PX)
    Image.fromarray(splat((x - tex['x'][0]) / PX, (z - tex['z'][0]) / PX, y, col, W, Hh, True)).save(os.path.join(a.site, 'tex_top.jpg'), quality=86)

    out = {'E0': E0, 'N1': N1, 'footprint': r2(feats[MUSEUM]['ring']), 'ground': round(G0, 2), 'terraces': terraces,
           'dome': dome, 'portico': portico, 'tex': tex}
    json.dump(out, open(os.path.join(a.site, 'museum_model.json'), 'w'))
    print('ground', round(G0, 2), 'dome top', dome['top'], 'rim', dome['rim'], 'portico top', portico['top'])
    for t in sorted(terraces, key=lambda t: -t['area']):
        print(f"{t['kind']:6s} {t['area']:8.1f} m²  roof {t['y1']:.1f}  (+{t['y1'] - G0:.1f} m)")


if __name__ == '__main__':
    main()
