"""
Real suburbs 4/9 (#123), step 1: the real tree canopy of the suburbs and the gulf islands from the Auckland 2024 LiDAR.

    LINZ_API_KEY=… python3 tools/linz/canopy.py fetch [<work dir>]   # LiDAR sheets, building outlines, test areas
    python3 tools/linz/canopy.py bake [<work dir>]                    # → <work>/canopy-grid.bin + canopy-grid.json
    npx vite-node tools/linz/canopy.ts [<work dir>]                   # → src/world/terrain/data/auckland-canopy.bin

Canopy height model = DSM − DEM (1 m), Auckland LiDAR 2024:
  - Part 1 (s3://nz-elevation/auckland/auckland-part-1_2024/) over the 20 sheets of PART1_SHEETS: Devonport, the North
    Shore to Takapuna, the CBD and the isthmus, and the flight corridor from Whenuapai and Hobsonville through Te Atatū,
    Henderson, Avondale, Mt Albert, Mt Roskill and Onehunga to Māngere and the airport;
  - Part 2 (auckland-part-2_2024) over the gulf islands' photo boxes (#120: Rangitoto and Motutapu, Browns Island,
    Motuihe, Rakino, Waiheke with Pakatoa and Rotoroa).
Tree pixel: on land (DEM ≥ LAND_DEM, which also keeps boats and mangroves off), CHM ≥ MIN_TREE, not a building:
  - the LINZ NZ Building Outlines (layer 101290, WFS by sheet, cached), buffered by OUTLINE_BUFFER;
  - #121's LiDAR-only houses (new since 2017) on the Devonport peninsula and the islands, where #121 told them from
    pōhutukawa crowns with the photo's greenness (houses.json, read from <work>/../houses);
  - elsewhere the buildings since 2017 by the CBD bake's test (buildings.py): smooth at 1 m (the 3 × 3 CHM spread, its
    5 × 5 median under 0.5 m) components of MIN_LIDAR_BUILDING … MAX_LIDAR_BUILDING m² that are compact and
    straight-edged (a canopy's outline wanders; a bigger one is a pine block or a stand of pōhutukawa). Hedges, sheds and cranes can still count as trees: at 16 m they average out (#123, decided).
  - components under MIN_TREE_PX pixels (a pole, a wire) are dropped.
Per 16 m cell of the game's land-use lattice (aucklandLandUse.ts: x0 = z0 = −40 000 m), in game XZ (the game's own
geoToWorld through a per-sheet quadratic fit of NZTM → game, a few cm off): tree pixels and land pixels, summed into the
shipped OUT_CELL (32 m) cells: tree / land (16 m cells at 16 levels were ≈ 640 kB coded, over the 100–250 kB budget; 32 m
at 16 levels ≈ 180 kB); and per 128 m cell the 75th percentile of the trees' heights. A cell is covered when at least half its pixels are LiDAR data of a covered
sheet (Part 1) or box (the islands); elsewhere the game keeps its Topo50 cover.

Also the LiDAR canopy share of the test areas (LINZ NZ Suburbs and Localities, layer 113764: Mount Albert, Devonport,
Māngere, Hobsonville; Rangitoto Island, Motutapu Island, Waiheke Island), measured at 1 m directly from the polygons,
for tests/world-canopy.test.ts (written to <work>/canopy-areas.json; canopy.ts copies it into tests/fixtures).
"""
import concurrent.futures as cf
import json
import os
import subprocess
import sys

import numpy as np
import rasterio
from pyproj import Transformer
from rasterio import features
from scipy import ndimage
from shapely.geometry import mapping, shape
from shapely.ops import transform as shp_transform

os.environ.setdefault('GDAL_DISABLE_READDIR_ON_OPEN', 'EMPTY_DIR')

CMD = sys.argv[1] if len(sys.argv) > 1 else 'bake'
WORK = sys.argv[2] if len(sys.argv) > 2 else '/home/user/work/canopy'
LIDAR = os.path.join(os.path.dirname(WORK.rstrip('/')), 'lidar')
os.makedirs(os.path.join(WORK, 'outlines'), exist_ok=True)

O = (-36.8485, 174.7622)  # AKL_ORIGIN (src/core/auckland.ts)
MLAT = 110950
MLON = 111320 * np.cos(np.radians(O[0]))
to_wgs = Transformer.from_crs(2193, 4326, always_xy=True)
to_nztm = Transformer.from_crs(4326, 2193, always_xy=True)

S3 = 'https://nz-elevation.s3.ap-southeast-2.amazonaws.com/auckland/auckland-part-{part}_2024/{kind}_1m/2193'
PART1_SHEETS = [
    'BA31_10000_0303', 'BA31_10000_0304', 'BA31_10000_0305',                    # Whenuapai, Hobsonville, Birkenhead
    'BA31_10000_0403', 'BA31_10000_0404', 'BA31_10000_0405',                    # Henderson, Te Atatū, Pt Chevalier
    'BA31_10000_0503', 'BA31_10000_0504', 'BA31_10000_0505',                    # Glen Eden, New Lynn, Mt Albert / Roskill
    'BA32_10000_0301', 'BA32_10000_0302', 'BA32_10000_0401', 'BA32_10000_0402',  # Takapuna, Devonport, the CBD, Ōrākei
    'BA32_10000_0404', 'BA32_10000_0501', 'BA32_10000_0502',                    # (St Heliers), Onehunga, Penrose
    'BB31_10000_0105', 'BB32_10000_0101', 'BB32_10000_0102', 'BB32_10000_0201',  # Ihumātao, Māngere, the airport
]
# the islands' photo boxes of #120 (aerial.py OUTER; houses.py ISLAND_BOXES), game XZ
ISLAND_BOXES = [
    dict(name='waiheke', x0=19380, z0=-12420, w=20040, h=12580),
    dict(name='rangitoto_motutapu', x0=5720, z0=-13280, w=10060, h=9080),
    dict(name='motuihe', x0=15140, z0=-5500, w=2500, h=2720),
    dict(name='rakino', x0=15660, z0=-15660, w=1600, h=2560),
    dict(name='browns', x0=11120, z0=-2580, w=1300, h=1340),
]
LAND_DEM = 1.0           # m (NZVD2016): ground lower than this is the sea, a beach or mangroves
MIN_TREE = 3.0           # m: canopy at least this high is a tree (#123)
OUTLINE_BUFFER = 1.0     # m round every LINZ outline
MIN_LIDAR_BUILDING = 30  # m²: a smooth, compact, straight-edged component this big is a building …
MAX_LIDAR_BUILDING = 2500  # m²: … and no bigger (a pine block or a stand of pōhutukawa is smooth and square too)
# #121's areas (houses.py AREAS: the Devonport peninsula under the photo and the island boxes): its LiDAR-only houses
# (traced with the photo's greenness, which tells a pōhutukawa crown from a roof) stand in for the smooth test there
HOUSES_JSON = os.path.join(os.path.dirname(WORK.rstrip('/')), 'houses', 'houses.json')
HOUSE_AREAS = [(-1600, -5500, 5000, -1500)] + [(b['x0'], b['z0'], b['x0'] + b['w'], b['z0'] + b['h']) for b in [
    dict(x0=19380, z0=-12420, w=20040, h=12580), dict(x0=5720, z0=-13280, w=10060, h=9080), dict(x0=15140, z0=-5500, w=2500, h=2720),
    dict(x0=15660, z0=-15660, w=1600, h=2560), dict(x0=11120, z0=-2580, w=1300, h=1340)]]
MIN_TREE_PX = 3          # px: smaller tree components are poles and wires
LAT0, CELL = -40000.0, 16.0   # the land-use lattice (aucklandLandUse.ts)
HCELL = 64.0                  # the height grid's cell (m)
OUT_HCELL = 128.0             # the shipped height grid's cell (m): 64 m added ≈ 75 kB of noise
OUT_CELL = 32.0               # the shipped grid's cell (m): 16 m was over the size budget (#123: 100–250 kB)
# the grid's box (game XZ, on the lattice)
GX0, GZ0, GX1, GZ1 = -16000.0, -15712.0, 39424.0, 25024.0
NX, NZ = int((GX1 - GX0) / CELL), int((GZ1 - GZ0) / CELL)
HNX, HNZ = int(np.ceil((GX1 - GX0) / HCELL)), int(np.ceil((GZ1 - GZ0) / HCELL))
HBINS = 60                    # 0.5 m height bins from MIN_TREE
AREAS = [
    # (key, LINZ name, kind)
    ('mt_albert', 'Mount Albert', 'suburb'), ('devonport', 'Devonport', 'suburb'), ('mangere', 'Mangere', 'suburb'),
    ('hobsonville', 'Hobsonville', 'suburb'), ('rangitoto', 'Rangitoto Island', 'island'),
    ('motutapu', 'Motutapu Island', 'island'), ('waiheke', 'Waiheke Island', 'island'),
]


def nztm_to_game(e, n):
    lon, lat = to_wgs.transform(e, n)
    return (np.asarray(lon) - O[1]) * MLON, (O[0] - np.asarray(lat)) * MLAT


def game_to_nztm(x, z):
    return to_nztm.transform(O[1] + np.asarray(x) / MLON, O[0] - np.asarray(z) / MLAT)


def sheet_list():
    """(part, name) of every sheet the bake reads: the Part 1 list and the Part 2 sheets over the island boxes."""
    out = [(1, s) for s in PART1_SHEETS]
    import importlib.util
    spec = importlib.util.spec_from_file_location('hero_site', os.path.join(os.path.dirname(__file__), '../hero/site.py'))
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    for b in ISLAND_BOXES:
        e, n = game_to_nztm([b['x0'], b['x0'] + b['w']], [b['z0'] + b['h'], b['z0']])
        lo, la = to_wgs.transform(e, n)
        urls = m.stac_tiles(S3.format(part=2, kind='dsm'), (lo[0], la[0], lo[1], la[1]), os.path.join(os.path.dirname(WORK.rstrip('/')), 'hero/_stac'))
        for u in urls:
            s = u.split('/')[-1][:-5]
            if (2, s) not in out:
                out.append((2, s))
    return out


def sheet_path(part, kind, name):
    return os.path.join(LIDAR, f'part{part}', kind, f'{name}.tiff')


def outlines_path(name):
    return os.path.join(WORK, 'outlines', f'{name}.json')


def fetch():
    sl = sheet_list()
    jobs = [(p, k, s) for p, s in sl for k in ('dsm', 'dem')]

    def get(job):
        part, kind, t = job
        f = sheet_path(part, kind, t)
        os.makedirs(os.path.dirname(f), exist_ok=True)
        if not os.path.exists(f):
            subprocess.run(['curl', '-sSf', '--retry', '4', '-o', f + '.part', f'{S3.format(part=part, kind=kind)}/{t}.tiff'], check=True)
            os.replace(f + '.part', f)
        return f

    with cf.ThreadPoolExecutor(8) as ex:
        print(f'LiDAR sheets: {len(list(ex.map(get, jobs)))} files', flush=True)
    key = os.environ.get('LINZ_API_KEY')

    def wfs(out, layer, cql, srs):
        if os.path.exists(out):
            return
        if not key:
            sys.exit(f'{out} is not cached and LINZ_API_KEY is not set (free key: https://data.linz.govt.nz)')
        q = {'service': 'WFS', 'version': '2.0.0', 'request': 'GetFeature', 'outputFormat': 'json', 'srsName': srs,
             'typeNames': layer, 'cql_filter': cql}
        if layer == 'layer-101290':
            q['propertyName'] = 'shape'
        args = ['curl', '-sSfG', '--retry', '4', f'https://data.linz.govt.nz/services;key={key}/wfs']
        for k, v in q.items():
            args += ['--data-urlencode', f'{k}={v}']
        subprocess.run(args + ['-o', out + '.part'], check=True)
        os.replace(out + '.part', out)

    for part, s in sl:
        with rasterio.open(sheet_path(part, 'dsm', s)) as src:
            b = src.bounds
        wfs(outlines_path(s), 'layer-101290', f'BBOX(shape,{b.bottom - 5},{b.left - 5},{b.top + 5},{b.right + 5})', 'EPSG:2193')
    names = ','.join(f"'{n}'" for _, n, _ in AREAS)
    wfs(os.path.join(WORK, 'areas.json'), 'layer-113764', f"name_ascii IN ({names}) AND territorial_authority='Auckland'", 'EPSG:2193')
    print('outlines and test areas cached', flush=True)


def areas_nztm():
    d = json.load(open(os.path.join(WORK, 'areas.json')))
    by = {f['properties']['name_ascii']: shape(f['geometry']) for f in d['features']}
    return [(k, by[n], kind) for k, n, kind in AREAS]


_lidar_houses = None


def lidar_houses():
    """#121's LiDAR-only houses (new since 2017) as NZTM squares round their rectangles."""
    global _lidar_houses
    if _lidar_houses is None:
        from shapely.geometry import box
        from shapely import affinity
        _lidar_houses = []
        if os.path.exists(HOUSES_JSON):
            for h in json.load(open(HOUSES_JSON))['houses']:
                if h['src'] != 'lidar':
                    continue
                s = max(h['w'], h['d'])
                _lidar_houses.append(affinity.rotate(box(h['e'] - s / 2, h['n'] - s / 2, h['e'] + s / 2, h['n'] + s / 2), h['ang'], use_radians=True))
    return _lidar_houses


def building_mask(name, shape_, transform):
    """LINZ outlines (buffered) and #121's LiDAR-only houses on the sheet's grid."""
    feats = json.load(open(outlines_path(name)))['features']
    geoms = [mapping(p.buffer(OUTLINE_BUFFER, join_style=2)) for p in lidar_houses()
             if transform.c <= p.centroid.x <= transform.c + shape_[1] * transform.a and transform.f + shape_[0] * transform.e <= p.centroid.y <= transform.f]
    for f in feats:
        try:
            g = shape(f['geometry']).buffer(OUTLINE_BUFFER, join_style=2)
        except Exception:  # noqa: BLE001 — a broken ring
            continue
        if not g.is_empty:
            geoms.append(mapping(g))
    if not geoms:
        return np.zeros(shape_, bool), 0
    m = features.rasterize(((g, 1) for g in geoms), out_shape=shape_, transform=transform, fill=0, dtype='uint8', all_touched=True)
    return m.astype(bool), len(geoms)


def lidar_buildings(chm, cand_base, transform):
    """Buildings since 2017 (no outline) by the CBD bake's test: smooth, compact and straight-edged components of
    MIN_LIDAR_BUILDING … MAX_LIDAR_BUILDING m²."""
    z = np.nan_to_num(chm, nan=0.0)
    mean = ndimage.uniform_filter(z, 3)
    sq = ndimage.uniform_filter(z * z, 3)
    rough = np.sqrt(np.maximum(0.0, sq - mean * mean))
    smooth = ndimage.median_filter(rough, 5) < 0.5
    cand = cand_base & smooth
    cand = ndimage.binary_opening(cand, iterations=1)
    lab, n = ndimage.label(cand)
    if n == 0:
        return np.zeros_like(cand)
    sizes = ndimage.sum(cand, lab, range(1, n + 1))
    big = np.nonzero((sizes >= MIN_LIDAR_BUILDING) & (sizes <= MAX_LIDAR_BUILDING))[0] + 1
    out = np.zeros_like(cand)
    sl = ndimage.find_objects(lab)
    from shapely.geometry import shape as shp
    from shapely.ops import unary_union
    for c in big:
        s = sl[c - 1]
        sub = lab[s] == c
        polys = [shp(g) for g, v in features.shapes(sub.astype(np.uint8), mask=sub, transform=rasterio.Affine(1, 0, 0, 0, 1, 0))]
        if not polys:
            continue
        p = unary_union(polys).simplify(1.0)
        if p.is_empty or p.area <= 0:
            continue
        mrr = p.minimum_rotated_rectangle
        if mrr.area <= 0 or p.area / mrr.area < 0.45 or p.length / max(mrr.length, 1e-6) > 1.15:
            continue
        out[s] |= sub
    return ndimage.binary_dilation(out, iterations=1)


def read_sheet(parts, name, kind):
    """A sheet's raster (NaN = no data) and transform: the first part's, its gaps filled from the next (Part 1 has
    no data over most of Devonport's east and St Heliers' sheets: Part 2 flew them)."""
    out, tr = None, None
    for part in parts:
        p = sheet_path(part, kind, name)
        if not os.path.exists(p):
            continue
        with rasterio.open(p) as s:
            a = s.read(1).astype(np.float32)
            a[a == s.nodata] = np.nan
            if out is None:
                out, tr = a, s.transform
            else:
                m = np.isnan(out)
                out[m] = a[m]
    return out, tr


def process(job):
    parts, name, covered_boxes = job
    cache = os.path.join(WORK, 'sheets', f'{name}.npz')
    if os.path.exists(cache):
        d = np.load(cache, allow_pickle=True)
        return name, d['box'], d['seen'], d['land'], d['tree'], d['hbox'], d['hist'], d['area'].item()
    dsm, tr = read_sheet(parts, name, 'dsm')
    dem, _ = read_sheet(parts, name, 'dem')
    part = parts[0]
    H, W = dsm.shape
    seen = np.isfinite(dsm) & np.isfinite(dem)
    chm = dsm - dem
    land = seen & (dem >= LAND_DEM)
    bld, nout = building_mask(name, (H, W), tr)
    high = land & (chm >= MIN_TREE)
    # game XZ of the pixel centres: a quadratic fit of NZTM → game over the sheet (cm off)
    u = np.linspace(0, W, 11)
    v = np.linspace(0, H, 11)
    U, V = np.meshgrid(u, v)
    gx, gz = nztm_to_game(tr.c + U.ravel() * tr.a, tr.f + V.ravel() * tr.e)

    def basis(a, b):
        a, b = a / 1000.0, b / 1000.0
        return [np.ones_like(a + b), a, b, a * a, a * b, b * b]

    A = np.stack(basis(U.ravel(), V.ravel()), 1)
    cx, *_ = np.linalg.lstsq(A, gx, rcond=None)
    cz, *_ = np.linalg.lstsq(A, gz, rcond=None)
    err = max(np.abs(A @ cx - gx).max(), np.abs(A @ cz - gz).max())
    col = (np.arange(W, dtype=np.float64) + 0.5)[None, :]
    row = (np.arange(H, dtype=np.float64) + 0.5)[:, None]
    bs = basis(col, row)
    X = sum(c * b for c, b in zip(cx, bs)).astype(np.float32)
    Z = sum(c * b for c, b in zip(cz, bs)).astype(np.float32)
    # buildings without an outline (outside #121's areas, whose own LiDAR-only houses are in bld)
    houses_area = np.zeros((H, W), bool)
    for x0, z0, x1, z1 in HOUSE_AREAS:
        houses_area |= (X >= x0) & (X < x1) & (Z >= z0) & (Z < z1)
    lbld = lidar_buildings(chm, high & ~bld & ~houses_area, tr)
    tree = high & ~bld & ~lbld
    tree = ndimage.binary_opening(tree, structure=np.ones((2, 2), bool))  # wires and poles: 1 px wide
    lab, n = ndimage.label(tree)
    if n:
        sizes = ndimage.sum(tree, lab, range(1, n + 1))
        tree &= (sizes >= MIN_TREE_PX)[np.maximum(lab - 1, 0)] | (lab == 0)
    # covered pixels: a Part 1 sheet, or inside an island box
    cov = seen.copy()
    if covered_boxes is not None:
        inb = np.zeros_like(cov)
        for b in covered_boxes:
            inb |= (X >= b['x0']) & (X < b['x0'] + b['w']) & (Z >= b['z0']) & (Z < b['z0'] + b['h'])
        cov &= inb
    ci = np.floor((X - GX0) / CELL).astype(np.int64)
    cj = np.floor((Z - GZ0) / CELL).astype(np.int64)
    ok = cov & (ci >= 0) & (ci < NX) & (cj >= 0) & (cj < NZ)
    if ok.any():
        i0, i1, j0, j1 = int(ci[ok].min()), int(ci[ok].max()) + 1, int(cj[ok].min()), int(cj[ok].max()) + 1
    else:
        i0, i1, j0, j1 = 0, 1, 0, 1
    bw, bh = i1 - i0, j1 - j0
    k = ((cj - j0) * bw + (ci - i0))[ok]
    seen_c = np.bincount(k, minlength=bw * bh).astype(np.uint16).reshape(bh, bw)
    land_c = np.bincount(k, weights=land[ok], minlength=bw * bh).astype(np.uint16).reshape(bh, bw)
    tree_c = np.bincount(k, weights=tree[ok], minlength=bw * bh).astype(np.uint16).reshape(bh, bw)
    # heights: 0.5 m bins per 64 m cell (summed into OUT_HCELL cells in bake)
    tk = ok & tree
    hi = np.floor((X[tk] - GX0) / HCELL).astype(np.int64)
    hj = np.floor((Z[tk] - GZ0) / HCELL).astype(np.int64)
    hb = np.clip(((chm[tk] - MIN_TREE) / 0.5).astype(np.int64), 0, HBINS - 1)
    hi0, hj0 = i0 // 4, j0 // 4
    hw, hh = (i1 + 3) // 4 - hi0, (j1 + 3) // 4 - hj0
    hist = np.bincount(((hj - hj0) * hw + (hi - hi0)) * HBINS + hb, minlength=hw * hh * HBINS).astype(np.uint32).reshape(hh, hw, HBINS)
    # the test areas, at 1 m
    area = {}
    for key, poly, _ in AREAS_NZTM:
        pb = poly.bounds
        if pb[0] > tr.c + W or pb[2] < tr.c or pb[1] > tr.f or pb[3] < tr.f - H:
            continue
        m = features.geometry_mask([mapping(poly)], (H, W), tr, invert=True)
        m &= cov
        if m.any():
            area[key] = (int((land & m).sum()), int((tree & m).sum()))
    box = np.array([i0, j0, i1, j1])
    hbox = np.array([hi0, hj0, hi0 + hw, hj0 + hh])
    os.makedirs(os.path.dirname(cache), exist_ok=True)
    np.savez_compressed(cache, box=box, seen=seen_c, land=land_c, tree=tree_c, hbox=hbox, hist=hist, area=np.array(area, dtype=object))
    print(f'{name} (part {part}): {nout} outlines, LiDAR buildings {int(lbld.sum())} px, tree {tree.sum() / max(land.sum(), 1) * 100:.1f} % of land, fit {err:.2f} m', flush=True)
    return name, box, seen_c, land_c, tree_c, hbox, hist, area


AREAS_NZTM = []


def bake():
    global AREAS_NZTM
    AREAS_NZTM = areas_nztm()
    sl = sheet_list()
    jobs = []
    for part, s in sl:
        if part == 2 and (1, s) in sl:
            continue
        if not os.path.exists(sheet_path(part, 'dsm', s)):
            sys.exit(f'missing {sheet_path(part, "dsm", s)}: run canopy.py fetch')
        # a Part 1 sheet is covered whole, its gaps filled from Part 2; a Part 2 sheet only inside the island boxes
        jobs.append(((1, 2), s, None) if part == 1 else ((2,), s, ISLAND_BOXES))
    seen = np.zeros((NZ, NX), np.uint32)
    land = np.zeros((NZ, NX), np.uint32)
    tree = np.zeros((NZ, NX), np.uint32)
    hist = np.zeros((HNZ, HNX, HBINS), np.uint32)
    areas = {}
    with cf.ProcessPoolExecutor(int(os.environ.get('CANOPY_JOBS', '3'))) as ex:
        for name, b, sc, lc, tc, hb, hc, ar in ex.map(process, jobs):
            seen[b[1]:b[3], b[0]:b[2]] += sc
            land[b[1]:b[3], b[0]:b[2]] += lc
            tree[b[1]:b[3], b[0]:b[2]] += tc
            hist[hb[1]:hb[3], hb[0]:hb[2]] += hc
            for k, (l, t) in ar.items():
                a = areas.setdefault(k, [0, 0])
                a[0] += l
                a[1] += t
    # the shipped grid: OUT_CELL m cells (2 × 2 of the bake's), sums of the counts (a land-weighted share)
    k = int(OUT_CELL / CELL)
    seen, land, tree = (a.reshape(NZ // k, k, NX // k, k).sum((1, 3)) for a in (seen, land, tree))
    covered = seen >= OUT_CELL * OUT_CELL / 2
    share = np.where(land > 0, tree / np.maximum(land, 1), 0.0)
    # 75th percentile height per OUT_HCELL m cell (0 where no trees)
    kh = int(OUT_HCELL / HCELL)
    hist = np.pad(hist, ((0, (-HNZ) % kh), (0, (-HNX) % kh), (0, 0)))
    hist = hist.reshape(hist.shape[0] // kh, kh, hist.shape[1] // kh, kh, HBINS).sum((1, 3))
    tot = hist.sum(2)
    cum = np.cumsum(hist, 2)
    p75 = np.argmax(cum >= (0.75 * tot)[..., None], axis=2)
    height = np.where(tot > 0, MIN_TREE + (p75 + 0.5) * 0.5, 0.0)
    share_q = np.where(covered, np.round(share * 250), 255).astype(np.uint8)
    height_q = np.clip(np.round(height), 0, 254).astype(np.uint8)
    with open(os.path.join(WORK, 'canopy-grid.bin'), 'wb') as f:
        f.write(share_q.tobytes())
        f.write(height_q.tobytes())
    land_frac = np.where(covered, land / np.maximum(seen, 1), 0)
    np.save(os.path.join(WORK, 'canopy-land.npy'), (land_frac * 255).round().astype(np.uint8))
    # the test areas' polygons in game XZ
    out_areas = []
    for key, poly, kind in AREAS_NZTM:
        l, t = areas.get(key, (0, 0))
        g = shp_transform(lambda e, n, z=None: nztm_to_game(e, n), poly.simplify(4.0))
        rings = []
        for p in (g.geoms if g.geom_type == 'MultiPolygon' else [g]):
            if p.area < 20_000:
                continue
            rings.append([round(v, 1) for xy in p.exterior.coords[:-1] for v in xy])
        out_areas.append(dict(key=key, kind=kind, land=l, tree=t, share=round(t / max(l, 1), 4), rings=rings))
        print(f'{key}: LiDAR canopy {t / max(l, 1) * 100:.1f} % of {l / 1e6:.2f} km² land', flush=True)
    json.dump(dict(x0=GX0, z0=GZ0, cell=OUT_CELL, cols=NX // k, rows=NZ // k, hcell=OUT_HCELL, hcols=hist.shape[1], hrows=hist.shape[0], minTree=MIN_TREE,
                   covered=int(covered.sum()), areas=out_areas), open(os.path.join(WORK, 'canopy-grid.json'), 'w'))
    print(f'grid {NX // k} x {NZ // k} cells of {OUT_CELL:.0f} m, covered {covered.sum() * OUT_CELL * OUT_CELL / 1e6:.0f} km², '
          f'mean share {share[covered & (land > 128)].mean() * 100:.1f} % on land', flush=True)


if __name__ == '__main__':
    if CMD == 'fetch':
        fetch()
    elif CMD == 'bake':
        bake()
    else:
        sys.exit(__doc__)
