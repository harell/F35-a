"""
Real suburbs 7/9 (#126), step 1: real houses along the whole Whenuapai → Airport corridor, from the LINZ building
outlines, the 2024 LiDAR and the 2024 aerial photo, fitted exactly as #121's houses are (tools/linz/houses.py: an
oriented rectangle per outline, a LiDAR roof, the photo's roof colour).

    python3 tools/linz/corridor-houses.py [<work dir>]                     (default /home/user/work/corridor)
    AREA=east python3 tools/linz/corridor-houses.py /home/user/work/east   (an area added to the corridor's tiles: AREAS)

The corridor: the box of epic #119's count (lon 174.58 … 174.86, lat −37.03 … −36.76: Whenuapai, Hobsonville, Te Atatū,
Henderson, Avondale, Mt Albert, Mt Roskill, Onehunga, Māngere, the airport, the isthmus and the North Shore's south)
inside the Auckland 2024 LiDAR Part 1 sheets of CORRIDOR_SHEETS (1:10k sheets, 4.8 × 7.2 km). The box's edges outside
those sheets (≈ 15.6 k outlines, ≈ 4 %: a 1 km strip west of Hobsonville, a 0.4 km strip of Ōtāhuhu east of
E 1765600, Papatoetoe south-east of the airport and the Manukau shore of BB31_0103/0104) stay procedural.

Inputs (cached under <work>/..):
  - the LINZ NZ Building Outlines (layer 101290) per sheet, as canopy.py (#123) cached them in canopy/outlines/;
  - the Part 1 DSM and DEM sheets in lidar/part1/ (houses.py and canopy.py fetch them);
  - the 2024 7.5 cm aerial at its COG overview 1/16 (1.2 m), one mosaic per sheet (aerial.py mosaic(), cached in
    aerial/aerial-mosaic-corridor-<sheet>.npz; ≈ 150 tiles a sheet, range requests): roof colours and the
    trees-vs-roofs test of the LiDAR-only buildings.

Per outline of MIN_AREA … MAX_AREA m² whose centroid lies in the corridor: houses.py process_chunk (rectangle, gone
since 2017, roof fit, colour), in 1 km chunks over four processes. Unlike #121, buildings over 600 m² are kept (shops,
warehouses, apartment blocks: nothing else draws them here, and the procedural sheds step aside under the real houses);
corridor-houses.ts splits the ones too big for a record and drops those on #124's landmark sites, in the CBD region,
on the hero neighbourhoods and #121's coverage. The houses stay where the LINZ outlines put them: the game shows no
photo here to register them to (#121's per-block lean field is left out).

Output: <work>/corridor-houses.json (lon/lat; read by corridor-houses.ts) with the palette (k-means, PALETTE colours at
the city square's exposure, as houses.py), the corridor's outline (lon/lat rings) and a tally.

Areas added later (#274, AREAS): the same fit over another box and its sheets, next to the corridor's box (not over it).
Their roofs are quantised to the shipped corridor.json palette instead of a k-means of their own, so the corridor's
tiles stay as they are; corridor-houses.ts adds the area's tiles to the manifest and merges the tiles both share.
"""
import importlib.util
import json
import multiprocessing as mp
import os
import sys
import time

import numpy as np
import rasterio
import shapely
from scipy.cluster.vq import kmeans2
from shapely.geometry import Polygon, box as sbox, shape
from shapely.ops import unary_union

HERE = os.path.dirname(os.path.abspath(__file__))
WORK = sys.argv[1] if len(sys.argv) > 1 else '/home/user/work/corridor'
ROOT = os.path.dirname(WORK.rstrip('/'))
AERIAL = os.path.join(ROOT, 'aerial')
OUTLINES = os.path.join(ROOT, 'canopy', 'outlines')
os.makedirs(WORK, exist_ok=True)


def load(name, path, argv=None):
    saved = sys.argv
    if argv is not None:
        sys.argv = argv
    try:
        spec = importlib.util.spec_from_file_location(name, path)
        m = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(m)
        return m
    finally:
        sys.argv = saved


sys.path.insert(0, HERE)
H = load('houses', os.path.join(HERE, 'houses.py'), ['houses.py', os.path.join(ROOT, 'houses'), AERIAL])
A = load('aerial', os.path.join(HERE, 'aerial.py'))

AREAS = {
    # the corridor (#126): the box of epic #119's count (358,687 outlines) inside the Part 1 sheets
    'corridor': dict(box=(174.58, -37.03, 174.86, -36.76), parts=(1,), sheets=[
        'BA31_10000_0303', 'BA31_10000_0304', 'BA31_10000_0305', 'BA31_10000_0403', 'BA31_10000_0404', 'BA31_10000_0405',
        'BA31_10000_0503', 'BA31_10000_0504', 'BA31_10000_0505', 'BA32_10000_0301', 'BA32_10000_0302', 'BA32_10000_0401',
        'BA32_10000_0402', 'BA32_10000_0501', 'BA32_10000_0502', 'BB31_10000_0105', 'BB32_10000_0101', 'BB32_10000_0102',
        'BB32_10000_0201',
    ]),
    # East Auckland (#274): Glendowie's east, Pakuranga, Howick, Bucklands Beach, Half Moon Bay, Cockle Bay, Botany and
    # East Tāmaki, east of the corridor's box; Part 2 fills the Part 1 sheets' gaps along the east coast
    'east': dict(box=(174.86, -36.98, 174.96, -36.84), parts=(1, 2), sheets=[
        'BA32_10000_0402', 'BA32_10000_0403', 'BA32_10000_0404', 'BA32_10000_0502', 'BA32_10000_0503', 'BA32_10000_0504',
        'BB32_10000_0102', 'BB32_10000_0103', 'BB32_10000_0104',
    ]),
}
AREA = os.environ.get('AREA', 'corridor')
BOX = AREAS[AREA]['box']  # lon0, lat0, lon1, lat1
CORRIDOR_SHEETS = AREAS[AREA]['sheets']
MANIFEST = os.path.join(HERE, '../../src/world/terrain/data/corridor/corridor.json')
MIN_AREA = 20.0
MAX_AREA = 20000.0   # m²: larger outlines (a port shed, the airport's terminals) are left to their own sites
OV = 16              # the aerial's COG overview read: 1.2 m
PALETTE = 256
CHUNK = 1000.0
WORKERS = int(os.environ.get('WORKERS', '4'))


def sheet_bounds(name):
    with rasterio.open(os.path.join(H.LIDAR, 'part1', 'dsm', f'{name}.tiff')) as s:
        return tuple(s.bounds)


def corridor():
    """The corridor in NZTM: the lon/lat box (densified, it is not square in NZTM) ∩ the sheets."""
    lo0, la0, lo1, la1 = BOX
    t = np.linspace(0, 1, 50)
    ring = [(lo0 + (lo1 - lo0) * s, la0) for s in t] + [(lo1, la0 + (la1 - la0) * s) for s in t] + \
           [(lo1 - (lo1 - lo0) * s, la1) for s in t] + [(lo0, la1 - (la1 - la0) * s) for s in t]
    e, n = H.to_nztm.transform([p[0] for p in ring], [p[1] for p in ring])
    boxp = Polygon(list(zip(e, n)))
    sheets = unary_union([sbox(*sheet_bounds(s)) for s in CORRIDOR_SHEETS])
    return boxp.intersection(sheets)


CHUNKS = {}
NEAR = None
NEAR_TREE = None
CORR = None
_last = [None]


def work_chunk(key):
    sheet, ci, cj = key
    if _last[0] != sheet:
        H._photos.clear()  # one sheet's mosaic at a time per process
        _last[0] = sheet
    ps = CHUNKS[key]
    b = np.array([q.bounds for q, _ in ps])
    E0 = float(np.floor(min(b[:, 0].min(), ci * CHUNK) - 25))
    N0 = float(np.floor(min(b[:, 1].min(), cj * CHUNK) - 25))
    E1 = float(np.ceil(max(b[:, 2].max(), ci * CHUNK + CHUNK) + 25))
    N1 = float(np.ceil(max(b[:, 3].max(), cj * CHUNK + CHUNK) + 25))
    near = [NEAR[k] for k in NEAR_TREE.query(sbox(E0, N0, E1, N1))]
    out, st = H.process_chunk(sheet, ps, near, E0, N0, E1, N1)
    keep = []
    for r in out:
        if r['src'] == 'lidar':
            # a LiDAR-only building: this chunk's own square (each chunk owns its inner part), in the corridor
            if not (ci * CHUNK <= r['e'] < ci * CHUNK + CHUNK and cj * CHUNK <= r['n'] < cj * CHUNK + CHUNK):
                continue
            if not CORR.contains(shapely.Point(r['e'], r['n'])):
                continue
        keep.append(r)
    return key, keep, st


def main():
    global NEAR, NEAR_TREE, CORR
    t0 = time.time()
    corr = corridor()
    CORR = corr
    shapely.prepare(CORR)
    print(f'{AREA}: {corr.area / 1e6:.1f} km² ({len(CORRIDOR_SHEETS)} sheets)', flush=True)
    grade = os.path.join(AERIAL, 'aerial-grade.json')
    k = json.load(open(grade))['exposure'] if os.path.exists(grade) else H.EXPOSURE_FALLBACK

    # outlines: each once (by its LINZ id), in the sheet holding its centroid
    seen = set()
    near = []
    tally = dict(outlines=0, outside=0, under_20=0, over_max=0)
    only = os.environ.get('SHEETS')  # a comma list, for a quick partial run
    for s in CORRIDOR_SHEETS:
        if only and s not in only.split(','):
            continue
        sb = sheet_bounds(s)
        # the photo mosaic over the sheet (aerial.py caches it)
        xs, zs = [], []
        for e in (sb[0], sb[2]):
            for n in (sb[1], sb[3]):
                x, z = H.nztm_to_game(e, n)
                xs.append(x)
                zs.append(z)
        A.mosaic(AERIAL, f'corridor-{s}', min(xs), min(zs), max(xs), max(zs), OV)
        H.AREAS[s] = dict(box=None, parts=AREAS[AREA]['parts'], photos=(f'corridor-{s}',))
        feats = json.load(open(os.path.join(OUTLINES, f'{s}.json')))['features']
        for f in feats:
            fid = int(str(f['id']).split('.')[-1])
            if fid in seen:
                continue
            g = shape(f['geometry'])
            if g.geom_type == 'MultiPolygon':
                g = max(g.geoms, key=lambda q: q.area)
            if g.geom_type != 'Polygon':
                continue
            p = Polygon(g.exterior).buffer(0)
            if p.geom_type != 'Polygon' or p.is_empty:
                continue
            c = p.centroid
            if not (sb[0] <= c.x < sb[2] and sb[1] <= c.y < sb[3]):
                continue  # its own sheet's
            seen.add(fid)
            near.append(p)
            tally['outlines'] += 1
            if not corr.contains(c):
                tally['outside'] += 1
                continue
            if p.area < MIN_AREA:
                tally['under_20'] += 1
                continue
            if p.area > MAX_AREA:
                tally['over_max'] += 1
                continue
            CHUNKS.setdefault((s, int(c.x // CHUNK), int(c.y // CHUNK)), []).append((p.simplify(0.3, preserve_topology=True), fid))
        print(f'{s}: {len(feats)} outlines, {time.time() - t0:.0f} s', flush=True)
    NEAR = near
    NEAR_TREE = shapely.STRtree(near)
    print(f'outlines: {tally}; {sum(len(v) for v in CHUNKS.values())} to fit in {len(CHUNKS)} chunks', flush=True)

    houses = []
    gone = nolidar = 0
    keys = sorted(CHUNKS)
    if os.environ.get('CHUNK_LIMIT'):  # a quick timing run
        keys = keys[:int(os.environ['CHUNK_LIMIT'])]
    with mp.get_context('fork').Pool(WORKERS) as pool:
        for i, (key, out, st) in enumerate(pool.imap(work_chunk, keys, chunksize=1)):
            houses += out
            gone += st['gone']
            nolidar += st['nolidar']
            if i % 25 == 0:
                print(f'  chunk {i + 1}/{len(keys)} {key}: {len(houses)} houses, {time.time() - t0:.0f} s', flush=True)
    tally.update(gone=gone, no_lidar=nolidar, houses=len(houses), lidar_only=sum(1 for h in houses if h['src'] == 'lidar'),
                 pitched=sum(1 for h in houses if h['roof'] == 'pitched'))
    print(f'tally: {tally}', flush=True)

    # roof colours at the city square's exposure, quantised to the corridor's own palette (as houses.py); an added area
    # takes the shipped one
    have = np.array([h['rgb'] is not None for h in houses])
    raw = np.array([h['rgb'] if h['rgb'] is not None else [128, 128, 128] for h in houses], np.float64) / 255
    graded = H.lin_to_srgb(H.srgb_to_lin(raw) * k)
    if AREA == 'corridor':
        rng = np.random.default_rng(1)
        sample = graded[have][rng.permutation(int(have.sum()))[:60000]]
        pal, _ = kmeans2(sample, PALETTE, seed=rng, minit='++', iter=30)
    else:
        pal = np.array([[(c >> 16) & 255, (c >> 8) & 255, c & 255] for c in json.load(open(MANIFEST))['palette']], np.float64) / 255
    idx = np.zeros(len(houses), np.int64)
    for s in range(0, len(houses), 20000):
        d = ((graded[s:s + 20000, None, :] - pal[None, :, :]) ** 2).sum(2)
        idx[s:s + 20000] = np.argmin(d, 1)
    med = np.median(graded[have], 0)
    idx[~have] = int(np.argmin(((pal - med) ** 2).sum(1)))
    for h, i in zip(houses, idx):
        h['c'] = int(i)
        h.pop('rgb')
        h.pop('area', None)
    palette = [[int(round(v * 255)) for v in c] for c in np.clip(pal, 0, 1)]
    rings = []
    for g in getattr(corr, 'geoms', [corr]):
        e, n = np.asarray(g.exterior.coords).T
        lon, lat = H.to_wgs.transform(e, n)
        rings.append([[round(a, 7), round(b, 7)] for a, b in zip(lon, lat)])
    json.dump(dict(area=AREA, palette=palette, houses=houses, tally=tally, exposure=k, corridor=rings, sheets=CORRIDOR_SHEETS),
              open(os.path.join(WORK, 'corridor-houses.json'), 'w'))
    print(f'houses: {len(houses)} in {time.time() - t0:.0f} s; wrote {os.path.join(WORK, "corridor-houses.json")}', flush=True)


if __name__ == '__main__':
    main()
