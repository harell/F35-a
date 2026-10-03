"""
F35-A — hero landmarks: Ports of Auckland measured from LiDAR, for tools/hero/examples/ports-of-auckland.html.

  python3 tools/hero/site.py --name ports --lat -36.8432 --lon 174.7800 --size 2400 --res 0.4 --scale 60
  python3 tools/hero/osm.py --site /tmp/hero/ports
  python3 tools/hero/sites/ports_of_auckland.py --site /tmp/hero/ports      → <site>/port_model.json

Scope: the OSM relation 11815188 "Port of Auckland" (industrial=port: Captain Cook, Marsden, Bledisloe, Jellicoe,
Freyberg and Fergusson wharves; Fergusson Container Terminal is relation 20079115 inside it). Everything is in
the site frame (x = E − E0 east, z = N1 − N south, metres; heights metres above NZVD2016):
  decks      the port rings, each at the median LiDAR ground (DEM) inside it (the wharves read 3.2 m, p5–p95 2.7–3.7)
  buildings  OSM building rings with most of their area in the port, roof = median DSM inside the ring
  stacks     container stacks: DSM 1.8–17 m above the deck, off buildings, cranes and masts, on land; each
             connected group is gridded at 1 m in its own best-fit orientation (minimum bounding box), its cells
             quantised to 2.6 m tiers, and merged into rectangles of equal tier (greedy meshing); colour = the mean
             of the 2024 aerial over the rectangle
  cranes     ship-to-shore cranes: blobs over 42 m. Axis from PCA (+u = towards the water), girder level from the
             10th percentile at the land end, apex from the max over the quay, boom up/down from the height over
             the water; the quay edge where the DEM drops below 1 m along the axis
  masts      floodlight masts: compact blobs 24–45 m high on port land
Data: LINZ 2024 LiDAR and aerial (CC BY 4.0); © OpenStreetMap contributors (ODbL).
"""
import argparse, json, math, os, sys, urllib.request
import xml.etree.ElementTree as ET

import numpy as np
from PIL import Image
from scipy import ndimage

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
from heights import ring_mask  # noqa: E402
from osm import stitch, to_nztm  # noqa: E402

Image.MAX_IMAGE_PIXELS = None
PORT, FERGUSSON = '11815188', '20079115'
TIER = 2.6  # m, a standard container's height (8 ft 6 in); high-cubes (2.9 m) round to the same tier count up to 5 high


def port_rings(site, S):
    """Outer rings of the port relations, from the main OSM API (cached in <site>/osm_port.osm)."""
    path = f'{S}/osm_port.osm'
    if not os.path.exists(path):
        lo0, la0, lo1, la1 = 174.7660, -36.8490, 174.7960, -36.8360
        url = f'https://api.openstreetmap.org/api/0.6/map?bbox={lo0},{la0},{lo1},{la1}'
        open(path, 'wb').write(urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'F35-A-hero-buildings/1.0'}), timeout=180).read())
    root = ET.parse(path).getroot()
    E0, _, _, N1 = site['box_nztm']
    nodes = {n.get('id'): (float(n.get('lon')), float(n.get('lat'))) for n in root.iter('node')}
    ways = {w.get('id'): [nd.get('ref') for nd in w.iter('nd')] for w in root.iter('way')}
    out = {}
    for rel in root.iter('relation'):
        if rel.get('id') in (PORT, FERGUSSON):
            outer = [ways[m.get('ref')] for m in rel.iter('member') if m.get('type') == 'way' and m.get('role') == 'outer' and m.get('ref') in ways]
            rings = []
            for ring in stitch(outer):
                xy = [(lambda E, N: [round(E - E0, 2), round(N1 - N, 2)])(*to_nztm.transform(*nodes[r])) for r in ring if r in nodes]
                if len(xy) >= 4:
                    rings.append(xy)
            out[rel.get('id')] = rings
    return out


def greedy(tier):
    """Rectangles [i0, j0, i1, j1, t] (exclusive ends) covering the cells of equal non-zero tier."""
    t = tier.copy()
    H, W = t.shape
    rects = []
    for j in range(H):
        i = 0
        while i < W:
            v = t[j, i]
            if v == 0:
                i += 1
                continue
            i1 = i
            while i1 < W and t[j, i1] == v:
                i1 += 1
            j1 = j + 1
            while j1 < H and (t[j1, i:i1] == v).all():
                j1 += 1
            t[j:j1, i:i1] = 0
            rects.append((i, j, i1, j1, int(v)))
            i = i1
    return rects


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--site', required=True)
    S = ap.parse_args().site
    site = json.load(open(f'{S}/site.json'))
    d = np.load(f'{S}/lidar.npz')
    dsm, dem = d['dsm'], d['dem']
    nd = dsm - dem
    H, W = dem.shape
    rings = port_rings(site, S)

    port = np.zeros(dem.shape, bool)
    decks = []
    for ring in rings[PORT]:
        m = ring_mask(dem.shape, ring)
        port |= m
        decks.append({'ring': ring, 'y': round(float(np.median(dem[m])), 2), 'area': int(m.sum())})
    print('decks', [(dk['area'], dk['y']) for dk in decks])

    # buildings: OSM rings mostly on port land
    bmask = np.zeros(dem.shape, bool)
    buildings = []
    for f in json.load(open(f'{S}/osm.json'))['features']:
        if f['kind'] != 'building' or len(f['ring']) < 4:
            continue
        m = ring_mask(dem.shape, f['ring'])
        if m.sum() < 20 or port[m].mean() < 0.5:
            continue
        core = ndimage.binary_erosion(m, iterations=1)
        core = core if core.sum() > 10 else m
        bmask |= m
        buildings.append({'id': f['id'], 'name': f['tags'].get('name', ''), 'ring': f['ring'], 'y0': round(float(np.percentile(dem[m], 10)), 2),
                          'y1': round(float(np.median(dsm[core])), 2), 'area': int(m.sum())})
    print('buildings', len(buildings))

    # cranes: one seed per crane from its A-frame and raised boom (over 62 m), then every LiDAR cell over 42 m goes to
    # the seed nearest along the quay (two neighbouring cranes on the west berth touch in the 42 m mask)
    near_port = ndimage.binary_dilation(port, iterations=30)
    hi = (nd > 42) & near_port
    seeds_lab, ns = ndimage.label(ndimage.binary_dilation((nd > 62) & near_port, iterations=2))
    seeds = [np.argwhere(seeds_lab == k)[:, ::-1].mean(0) + 0.5 for k in range(1, ns + 1) if (seeds_lab == k).sum() >= 15]
    lab, n = ndimage.label(ndimage.binary_dilation(hi, iterations=2))
    cranes, cmask = [], np.zeros(dem.shape, bool)
    for k in range(1, n + 1):
        blob = (lab == k) & hi
        ys, xs = np.where(blob)
        if len(ys) < 500:
            continue
        P = np.c_[xs, ys].astype(float) + 0.5
        ax = np.linalg.svd(P - P.mean(0))[2][0]
        rail = np.array([-ax[1], ax[0]])
        mine = [sd for sd in seeds if blob[int(sd[1]), int(sd[0])] or ndimage.binary_dilation(blob, iterations=3)[int(sd[1]), int(sd[0])]]
        if not mine:
            continue
        who = np.argmin(np.abs(np.array([(P - sd) @ rail for sd in mine])), axis=0)
        for q, sd in enumerate(mine):
            Pq = P[who == q]
            c = Pq.mean(0)
            hq = dsm[(Pq[:, 1]).astype(int), (Pq[:, 0]).astype(int)]
            axq = ax if (dem[int(c[1] + ax[1] * 60), int(c[0] + ax[0] * 60)] < dem[int(c[1] - ax[1] * 60), int(c[0] - ax[0] * 60)]) else -ax
            prq = (Pq - c) @ axq
            quay = next(u for u in np.arange(-60, 120, 0.5) if dem[int(c[1] + axq[1] * u), int(c[0] + axq[0] * u)] < 1.0)
            o = c + axq * quay
            nv = np.array([-axq[1], axq[0]])

            def top(u):  # highest return across the crane (±6 m) at u metres along the axis from the quay edge
                pts = o + axq * u + np.outer(np.arange(-6, 6.5, 1.0), nv)
                return float(dsm[pts[:, 1].astype(int).clip(0, H - 1), pts[:, 0].astype(int).clip(0, W - 1)].max())
            land = prq < prq.min() + 12
            girder = float(np.percentile(hq[land], 15))
            boom_up = bool(hq.max() > 100)
            apex = max(top(u) for u in np.arange(-30, -2, 1.0))
            back = next(u for u in np.arange(-30, -120, -1.0) if top(u) < girder - 8)
            tip = 5.0 if boom_up else next(u for u in np.arange(5, 120, 1.0) if top(u) < girder - 8)
            cranes.append({'x': round(float(o[0]), 2), 'z': round(float(o[1]), 2), 'ux': round(float(axq[0]), 4), 'uz': round(float(axq[1]), 4),
                           'back': round(back, 1), 'tip': round(tip, 1), 'girder': round(girder, 1), 'apex': round(apex, 1),
                           'boomUp': boom_up, 'boomTop': round(float(hq.max()), 1) if boom_up else None, 'deck': round(float(np.median(dem[blob & (dem > 1)])), 2)})
        cmask |= ndimage.binary_dilation(lab == k, iterations=4)
    cranes.sort(key=lambda c: (c['z'] < 1000, c['x']))
    for c in cranes:
        print('crane', c)

    # floodlight masts
    tall = (nd > 24) & (nd < 45) & port & ~bmask & ~cmask
    lab, n = ndimage.label(ndimage.binary_dilation(tall, iterations=1))
    masts = []
    for k in range(1, n + 1):
        ys, xs = np.where((lab == k) & tall)
        if 3 <= len(ys) <= 160 and (xs.max() - xs.min()) < 16 and (ys.max() - ys.min()) < 16:
            i = np.argmax(nd[ys, xs])
            masts.append([round(float(xs[i]) + 0.5, 1), round(float(ys[i]) + 0.5, 1), round(float(dem[ys[i], xs[i]]), 1), round(float(dsm[ys[i], xs[i]]), 1)])
    mmask = np.zeros(dem.shape, bool)
    for x, z, _, _ in masts:
        mmask[max(0, int(z) - 5):int(z) + 6, max(0, int(x) - 5):int(x) + 6] = True
    print('masts', len(masts))

    # container stacks
    st = port & ~ndimage.binary_dilation(bmask, iterations=2) & ~cmask & ~mmask & (nd > 1.8) & (nd < 17) & (dem > 1.5)
    aer = np.asarray(Image.open(f'{S}/aerial.jpg').convert('RGB'), dtype=np.float32)
    ppm = aer.shape[1] / W  # aerial pixels per metre
    integ = np.pad(aer.cumsum(0).cumsum(1), ((1, 0), (1, 0), (0, 0)))

    def mean_rgb(x0, z0, x1, z1):
        a0, b0 = int(max(0, min(x0, x1) * ppm)), int(max(0, min(z0, z1) * ppm))
        a1, b1 = int(min(aer.shape[1], max(x0, x1) * ppm)) + 1, int(min(aer.shape[0], max(z0, z1) * ppm)) + 1
        s = integ[b1, a1] - integ[b0, a1] - integ[b1, a0] + integ[b0, a0]
        return (s / max(1, (a1 - a0) * (b1 - b0))).round().astype(int).tolist()

    lab, n = ndimage.label(ndimage.binary_closing(st, iterations=1) & st | st, structure=np.ones((3, 3)))
    stacks = []
    angles = np.radians(np.arange(0, 90, 1.0))
    for k in range(1, n + 1):
        ys, xs = np.where(lab == k)
        if len(ys) < 12:
            continue
        P = np.c_[xs, ys].astype(float) + 0.5
        c = P.mean(0)
        Q = P - c
        areas = [np.ptp(Q @ [math.cos(a), math.sin(a)]) * np.ptp(Q @ [-math.sin(a), math.cos(a)]) for a in angles]
        a = float(angles[int(np.argmin(areas))])
        u, v = np.array([math.cos(a), math.sin(a)]), np.array([-math.sin(a), math.cos(a)])
        U, V = Q @ u, Q @ v
        i = np.floor(U - U.min()).astype(int)
        j = np.floor(V - V.min()).astype(int)
        t = np.zeros((j.max() + 1, i.max() + 1), np.int16)
        tiers = np.clip(np.round(nd[ys, xs] / TIER), 1, 6).astype(np.int16)
        np.maximum.at(t, (j, i), tiers)
        base = float(np.median(dem[ys, xs]))
        for i0, j0, i1, j1, tv in greedy(t):
            if (i1 - i0) * (j1 - j0) < 3:
                continue
            corners = [c + u * (U.min() + ii) + v * (V.min() + jj) for ii, jj in ((i0, j0), (i1, j0), (i1, j1), (i0, j1))]
            xs4, zs4 = [p[0] for p in corners], [p[1] for p in corners]
            rgb = mean_rgb(min(xs4), min(zs4), max(xs4), max(zs4)) if (i1 - i0) * (j1 - j0) < 400 else mean_rgb(*corners[0], *corners[2])
            stacks.append([round(float(q), 1) for p in corners for q in p] + [round(base, 1), tv] + rgb)
    print('stack rectangles', len(stacks), 'cells', int(st.sum()))

    json.dump({'decks': decks, 'buildings': buildings, 'cranes': cranes, 'masts': masts, 'stacks': stacks, 'tier': TIER,
               'fergusson': rings[FERGUSSON]}, open(f'{S}/port_model.json', 'w'), separators=(',', ':'))
    np.save(f'{S}/port_mask.npy', port)
    print('wrote', f'{S}/port_model.json', os.path.getsize(f'{S}/port_model.json') // 1024, 'kB')


if __name__ == '__main__':
    main()
