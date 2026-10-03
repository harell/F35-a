"""
F35-A — hero landmarks: Auckland Domain (Pukekawa) measured from LiDAR, without the museum, for
tools/hero/examples/auckland-domain.html.

  python3 tools/hero/site.py --name auckland_domain --lat -36.8597 --lon 174.7748 --size 1500 --res 0.3 --scale 40
  curl -o /tmp/hero/auckland_domain/map.osm "https://api.openstreetmap.org/api/0.6/map?bbox=174.76655,-36.86659,174.78306,-36.85282"
  python3 tools/hero/sites/auckland_domain.py --site /tmp/hero/auckland_domain    → <site>/domain_model.json

Scope: the OSM park way 6029919 "Pukekawa / Auckland Domain". The Auckland War Memorial Museum (way 23906678)
is left out on purpose: it gets its own hero model; its footprint (+6 m) is cleared of trees and buildings and
the aerial under it is filled with one tone taken from the ground around it. Everything is in the site frame (x = E − E0 east,
z = N1 − N south, metres; heights metres above NZVD2016):
  ground     LiDAR 1 m DEM (bare earth), 3 m grid
  trees      one crown per LiDAR tree: canopy = nDSM > 2.5 m inside the park, off buildings; tops = local maxima of
             the smoothed nDSM (window grows with height), crowns = watershed of the canopy from those tops;
             [x, z, ground, top, radius, crown base, r, g, b]: radius from the crown's area (+10 %: equal-area circles
             leave gaps in a closed canopy), base 30 % of the top (50 % for crowns under 6 m), colour = the 2024 aerial's mean over the crown
  buildings  OSM building ways inside the park (not the museum): walls from the lowest DEM in the ring, roof at the
             median nDSM (p90 for the two glasshouses: glass lets the LiDAR through); the glasshouses carry a
             barrel vault along their long axis from the eave (p12) to the ridge (p98)
  ponds      OSM water inside the park, surface at the ring's median DEM
Data: LINZ 2024 LiDAR and aerial (CC BY 4.0); © OpenStreetMap contributors (ODbL).
"""
import argparse, json, math, os, sys
import xml.etree.ElementTree as ET

import numpy as np
from PIL import Image, ImageDraw, ImageFilter
from scipy import ndimage
from shapely.geometry import Polygon, Point
from skimage.segmentation import watershed

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
from heights import ring_mask  # noqa: E402
from osm import stitch, to_nztm  # noqa: E402

Image.MAX_IMAGE_PIXELS = None
PARK, MUSEUM = '6029919', '23906678'
GLASS = {'586399921', '586399922'}  # Temperate House, Tropical House


def load_osm(site, S):
    E0, N1 = S['box_nztm'][0], S['box_nztm'][3]
    r = ET.parse(os.path.join(site, 'map.osm')).getroot()
    nodes = {n.get('id'): to_nztm.transform(float(n.get('lon')), float(n.get('lat'))) for n in r.iter('node')}
    loc = lambda nid: (round(nodes[nid][0] - E0, 2), round(N1 - nodes[nid][1], 2))
    ways, feats = {}, []
    for w in r.iter('way'):
        ways[w.get('id')] = [nd.get('ref') for nd in w.findall('nd')]
    for el in r:
        if el.tag not in ('way', 'relation'):
            continue
        t = {x.get('k'): x.get('v') for x in el.findall('tag')}
        if el.tag == 'way':
            ids = ways[el.get('id')]
            if len(ids) < 4 or ids[0] != ids[-1] or any(i not in nodes for i in ids):
                continue
            rings = [[loc(i) for i in ids]]
        else:
            if t.get('type') != 'multipolygon':
                continue
            segs = [ways.get(m.get('ref')) for m in el.findall('member') if m.get('type') == 'way' and m.get('role') == 'outer']
            rings = [[loc(i) for i in rg] for rg in stitch([s for s in segs if s]) if rg[0] == rg[-1] and all(i in nodes for i in rg)]
        for rg in rings:
            feats.append({'id': el.get('id'), 'tags': t, 'ring': rg})
    return feats


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--site', required=True)
    a = ap.parse_args()
    S = json.load(open(os.path.join(a.site, 'site.json')))
    L = np.load(os.path.join(a.site, 'lidar.npz'))
    dsm, dem = L['dsm'].astype(np.float32), L['dem'].astype(np.float32)
    dem = np.where(np.isnan(dem), np.nanmedian(dem), dem)
    dsm = np.where(np.isnan(dsm), dem, dsm)
    nd = np.clip(dsm - dem, 0, None)
    H, W = nd.shape
    feats = load_osm(a.site, S)

    park = next(f for f in feats if f['id'] == PARK)
    museum = next(f for f in feats if f['id'] == MUSEUM)
    park_poly, mus_poly = Polygon(park['ring']), Polygon(museum['ring'])
    park_m = ring_mask(nd.shape, park['ring'])
    mus_m = ring_mask(nd.shape, list(mus_poly.buffer(6).exterior.coords))

    # ── buildings inside the park ──
    bld_m = np.zeros_like(park_m)
    buildings = []
    for f in feats:
        t = f['tags']
        if 'building' not in t or f['id'] == MUSEUM or len(f['ring']) < 4:
            continue
        P = Polygon(f['ring'])
        if not P.is_valid or P.area < 12 or not park_poly.contains(P.representative_point()) or mus_poly.buffer(6).contains(P.representative_point()):
            continue
        m = ring_mask(nd.shape, f['ring'])
        bld_m |= ndimage.binary_dilation(m, iterations=2)
        v = nd[m]
        if v.size < 6:
            continue
        g = float(np.min(dem[m]))
        glass = f['id'] in GLASS
        b = {'id': f['id'], 'name': t.get('name', ''), 'kind': t.get('building'), 'ring': f['ring'], 'y0': round(g, 2),
             'area': round(P.area), 'p25': round(float(np.percentile(v, 25)), 1), 'median': round(float(np.median(v)), 1),
             'p90': round(float(np.percentile(v, 90)), 1), 'max': round(float(v.max()), 1)}
        top = float(np.percentile(dsm[m], 90 if glass else 50))
        b['y1'] = round(max(top, g + 2.5), 2)
        if glass:  # barrel vault along the long axis of the minimum rotated rectangle
            rr = list(P.minimum_rotated_rectangle.exterior.coords)[:4]
            e1, e2 = np.subtract(rr[1], rr[0]), np.subtract(rr[2], rr[1])
            if np.hypot(*e1) < np.hypot(*e2):
                rr = rr[1:] + rr[:1]
            b['rect'] = [[round(x, 2), round(z, 2)] for x, z in rr]
            b['eave'] = round(float(np.percentile(dsm[m], 12)), 2)
            b['ridge'] = round(float(np.percentile(dsm[m], 98)), 2)
        buildings.append(b)

    # ── ponds ──
    ponds = []
    for f in feats:
        t = f['tags']
        if t.get('natural') == 'water' or t.get('water') in ('pond', 'basin') or t.get('leisure') == 'swimming_pool':
            P = Polygon(f['ring'])
            if P.is_valid and park_poly.contains(P.representative_point()):
                m = ring_mask(nd.shape, f['ring'])
                if m.sum() > 4:
                    ponds.append({'name': t.get('name', ''), 'ring': f['ring'], 'y': round(float(np.median(dem[m])) + 0.15, 2)})

    # ── trees: canopy, tops, watershed crowns ──
    canopy = (nd > 2.5) & park_m & ~bld_m & ~mus_m
    canopy = ndimage.binary_opening(canopy, iterations=1)
    sm = ndimage.gaussian_filter(np.where(canopy, nd, 0), 1.0)
    # local maxima: window 5 m under 12 m tall, 7 m to 22 m, 9 m above
    peaks = np.zeros_like(canopy)
    for lo, hi, w in ((3, 12, 3), (12, 22, 5), (22, 99, 7)):
        mx = ndimage.maximum_filter(sm, size=w)
        peaks |= (sm == mx) & (sm > lo) & (sm <= hi) & canopy
    lab, n = ndimage.label(peaks)
    tops = ndimage.center_of_mass(peaks, lab, range(1, n + 1))
    markers = np.zeros(nd.shape, np.int32)
    for i, (r, c) in enumerate(tops, 1):
        markers[int(round(r)), int(round(c))] = i
    crowns = watershed(-sm, markers, mask=canopy)
    aer = Image.open(os.path.join(a.site, 'aerial.jpg')).convert('RGB').resize((W, H), Image.BOX)
    rgb = np.asarray(aer, np.float32)
    idx = np.arange(1, n + 1)
    area = ndimage.sum(np.ones_like(nd), crowns, idx)
    top = ndimage.maximum(nd, crowns, idx)
    cr, cg, cb = (ndimage.mean(rgb[..., k], crowns, idx) for k in range(3))
    trees = []
    for i in range(n):
        if area[i] < 3 or top[i] < 3:
            continue
        r, c = tops[i]
        x, z = c + 0.5, r + 0.5
        h = float(top[i])
        rad = float(np.clip(1.1 * math.sqrt(area[i] / math.pi), 1.2, 17))
        base = h * (0.5 if h < 6 else 0.3)
        g = float(dem[int(r), int(c)])
        trees.append([round(x, 1), round(z, 1), round(g, 1), round(g + h, 1), round(rad, 1), round(g + base, 1),
                      int(cr[i]), int(cg[i]), int(cb[i])])

    # ── the aerial without the museum: fill its footprint from the ground around it ──
    full = Image.open(os.path.join(a.site, 'aerial.jpg')).convert('RGB')
    fw, fh = full.size
    k = fw / W
    hole = Image.new('L', full.size, 0)
    ImageDraw.Draw(hole).polygon([(x * k, z * k) for x, z in mus_poly.buffer(4).exterior.coords], fill=255)
    arr = np.asarray(full).copy()
    hm = np.asarray(hole) > 0
    # one flat tone: the median of the ring 4–20 m around it (forecourt, car park and lawn), with a little grain
    ring = Image.new('L', full.size, 0)
    ImageDraw.Draw(ring).polygon([(x * k, z * k) for x, z in mus_poly.buffer(20).exterior.coords], fill=255)
    rm = (np.asarray(ring) > 0) & ~hm
    tone = np.median(arr[rm], axis=0)
    grain = np.random.default_rng(1).normal(0, 4, (int(hm.sum()), 1))
    arr[hm] = np.clip(tone + grain, 0, 255).astype(np.uint8)
    Image.fromarray(arr).save(os.path.join(a.site, 'aerial_nomuseum.jpg'), quality=90)

    hts = np.array([t[3] - t[2] for t in trees])
    stats = {
        'park_area_ha': round(park_poly.area / 1e4, 1),
        'canopy_ha': round(float(canopy.sum()) / 1e4, 1),
        'canopy_pct': round(100 * float(canopy.sum()) / float((park_m & ~mus_m).sum()), 1),
        'trees': len(trees),
        'tree_h_median': round(float(np.median(hts)), 1), 'tree_h_p90': round(float(np.percentile(hts, 90)), 1),
        'tree_h_max': round(float(hts.max()), 1),
        'over_20m': int((hts > 20).sum()),
        'ground_min_in_park': round(float(dem[park_m].min()), 1), 'ground_max_in_park': round(float(dem[park_m].max()), 1),
    }
    out = {'park': park['ring'], 'museum': museum['ring'], 'buildings': buildings, 'ponds': ponds, 'trees': trees, 'stats': stats}
    json.dump(out, open(os.path.join(a.site, 'domain_model.json'), 'w'))
    print(json.dumps(stats, indent=1))
    for b in sorted(buildings, key=lambda b: -b['area']):
        print(f"{b['name'] or '(unnamed)':32s} {b['kind']:12s} {b['area']:6d} m²  nDSM p25 {b['p25']:5.1f} med {b['median']:5.1f} p90 {b['p90']:5.1f} max {b['max']:5.1f}")
    for p in ponds:
        print('pond', p['name'], p['y'])


if __name__ == '__main__':
    main()
