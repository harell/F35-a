"""
LINZ phase 2b, step 1: CBD building footprints with LiDAR heights.

    LINZ_API_KEY=… python3 buildings.py <work dir>

Inputs
  - NZ Building Outlines (LDS layer 101290, the current outlines; not 'All Sources' 101292), every
    outline in the CBD box, from the LINZ Data Service WFS in NZTM2000 (cached as <work>/outlines.json).
  - Auckland Part 1 LiDAR 1 m DSM and DEM (2024), s3://nz-elevation/auckland/auckland-part-1_2024/
    {dsm,dem}_1m/2193: only the CBD window, at full resolution (Cloud-Optimised GeoTIFF range requests,
    cached as <work>/lidar.npz). The DEM of the same survey, not the national mosaic: same epoch and
    same ground classification as the DSM, so DSM − DEM is the height above ground.

Heights: nDSM = DSM − DEM inside each footprint, on the pixels at least 1 m inside it (no edge
mixing with the street or the neighbours). A footprint whose upper part stands well above the rest
(a tower on a podium, several towers on one podium, a setback, a crown) is split into parts: the
high pixels form connected components, each one becomes its own prism (convex hull ∩ footprint),
split again in turn, up to three levels; the rest of each level keeps the 75th percentile of its own
pixels. A single-level roof gets the 90th percentile (rooftop plant and parapets lift it a little
above the roof slab, the median of a pitched roof would sit below its ridge).

The outlines were captured from the 2017 aerial photos, the LiDAR is from 2024. So:
  - outlines with nothing standing on them in 2024 (demolished, a construction site) are dropped;
  - buildings completed since 2017 (PwC Tower, Pacifica, …) have no outline: footprints are traced
    from the LiDAR itself where ≥ 8 m stands outside every outline, compact, and either ≥ 30 m tall
    or smooth and straight-edged (trees are rough: their 3 × 3 nDSM spread is metres, a roof's a few
    decimetres, and a canopy's outline wanders). buildings.ts also drops the traced footprints over
    a street, a motorway or a park (street trees, viaducts).

Output: <work>/buildings.json (rings in WGS84 lon/lat, heights in m above the LiDAR ground), read by
buildings.ts, which reprojects with the game's geoToWorld, keeps the buildings of the CBD region and
bakes src/world/terrain/data/auckland-buildings.bin. Also <work>/spotchecks.json: the raw LiDAR
height of the named towers and a sample of outlines, measured independently of the part splitting
(copied into tests/fixtures by buildings.ts for the ±5 m test).
"""
import json, os, subprocess, sys
import numpy as np
import rasterio
from rasterio import features
from rasterio.windows import from_bounds
from pyproj import Transformer
from scipy import ndimage
from shapely.geometry import MultiPoint, Polygon, shape, mapping
from shapely.ops import unary_union

os.environ.setdefault('GDAL_DISABLE_READDIR_ON_OPEN', 'EMPTY_DIR')
os.environ.setdefault('GDAL_HTTP_MULTIRANGE', 'YES')

WORK = sys.argv[1] if len(sys.argv) > 1 else '/tmp/f35-linz-buildings'
os.makedirs(WORK, exist_ok=True)

# CBD box (NZTM2000 / EPSG:2193): the phase 2a CBD region (game x −1135…1102, z −1700…1364) + 100 m
E0, N0, E1, N1 = 1755700.0, 5918900.0, 1758450.0, 5922400.0
S3 = 'https://nz-elevation.s3.ap-southeast-2.amazonaws.com/auckland/auckland-part-1_2024'
TILES = ['BA31_10000_0405', 'BA32_10000_0401']  # the 1:10k sheets over the box (STAC item bboxes)

to_wgs = Transformer.from_crs(2193, 4326, always_xy=True)
to_nztm = Transformer.from_crs(4326, 2193, always_xy=True)
SKY_TOWER = to_nztm.transform(174.7622, -36.8485)  # game origin; the hand-built model stands there

SIMPLIFY = 0.5     # m, Douglas–Peucker on the footprints (the outlines are ±0.5–1 m)
MIN_AREA = 30.0    # m²: sheds, kiosks and bike shelters are dropped (issue #2 budget)
MIN_HEIGHT = 2.5   # m: lower than this in 2024 = gone (demolished, a car park, a building site)


# ── Outlines ──
def outlines():
    out = f'{WORK}/outlines.json'
    if not os.path.exists(out):
        key = os.environ.get('LINZ_API_KEY')
        if not key:
            sys.exit(f'{out} is not cached and LINZ_API_KEY is not set (free key: https://data.linz.govt.nz)')
        q = {'service': 'WFS', 'version': '2.0.0', 'request': 'GetFeature', 'outputFormat': 'json', 'srsName': 'EPSG:2193',
             'typeNames': 'layer-101290', 'cql_filter': f'BBOX(shape,{N0},{E0},{N1},{E1})'}
        print('fetching outlines …', flush=True)
        args = ['curl', '-sSfG', f'https://data.linz.govt.nz/services;key={key}/wfs']
        for k, v in q.items():
            args += ['--data-urlencode', f'{k}={v}']
        subprocess.run(args + ['-o', out + '.part'], check=True)
        os.replace(out + '.part', out)
    fc = json.load(open(out))
    print(f'outlines: {len(fc["features"])}', flush=True)
    return fc['features']


# ── LiDAR (1 m DSM / DEM over the box) ──
def lidar():
    out = f'{WORK}/lidar.npz'
    if os.path.exists(out):
        d = np.load(out)
        return d['dsm'], d['dem']
    W = int(E1 - E0)
    H = int(N1 - N0)
    res = {}
    for kind in ('dsm', 'dem'):
        mos = np.full((H, W), np.nan, np.float32)
        for t in TILES:
            url = f'/vsicurl/{S3}/{kind}_1m/2193/{t}.tiff'
            with rasterio.open(url) as s:
                b = s.bounds
                ix0, ix1 = max(b.left, E0), min(b.right, E1)
                iy0, iy1 = max(b.bottom, N0), min(b.top, N1)
                if ix0 >= ix1 or iy0 >= iy1:
                    continue
                a = s.read(1, window=from_bounds(ix0, iy0, ix1, iy1, s.transform), masked=True).astype(np.float32).filled(np.nan)
                r0 = int(round(N1 - iy1))
                c0 = int(round(ix0 - E0))
                sub = mos[r0:r0 + a.shape[0], c0:c0 + a.shape[1]]
                m = ~np.isnan(a[:sub.shape[0], :sub.shape[1]])
                sub[m] = a[:sub.shape[0], :sub.shape[1]][m]
                print(f'{kind} {t}: {a.shape}', flush=True)
        res[kind] = mos
    np.savez_compressed(out, dsm=res['dsm'], dem=res['dem'])
    return res['dsm'], res['dem']


TRANSFORM = rasterio.transform.from_origin(E0, N1, 1.0, 1.0)  # pixel (r, c) centre = (E0 + c + .5, N1 − r − .5)


def px_to_nztm(rows, cols):
    return E0 + cols + 0.5, N1 - rows - 0.5


def clean(poly):
    """Valid, simplified outer ring (courtyards filled: invisible from the air, half the triangles)."""
    if poly.is_empty:
        return None
    if poly.geom_type != 'Polygon':
        poly = max(poly.geoms, key=lambda g: g.area) if hasattr(poly, 'geoms') and len(poly.geoms) else None
        if poly is None or poly.geom_type != 'Polygon':
            return None
    p = Polygon(poly.exterior).buffer(0).simplify(SIMPLIFY, preserve_topology=True)
    if p.geom_type != 'Polygon' or p.area < MIN_AREA:
        return None
    return p


def split_parts(poly, nd, lab, k, sl):
    """Prisms [(polygon, height)] of one footprint (label k in `lab`, inside the window `sl`)."""
    r0, c0 = sl[0].start, sl[1].start
    m = lab[sl] == k
    inner = ndimage.binary_erosion(m, iterations=1)
    use = inner if inner.sum() >= 12 else m
    rr, cc = np.nonzero(use)
    rr, cc = rr + r0, cc + c0
    # the Sky Tower is a hand-built model: its shaft and pod never count for a building's height
    x, y = px_to_nztm(rr, cc)
    keep = np.hypot(x - SKY_TOWER[0], y - SKY_TOWER[1]) > 30
    rr, cc = rr[keep], cc[keep]
    v = nd[rr, cc]
    ok = ~np.isnan(v)
    return levels(poly, nd, rr[ok], cc[ok], v[ok], 0)


def otsu(v):
    """Threshold between the two height classes of a roof (maximum between-class variance, 0.5 m bins)."""
    lo, hi = float(v.min()), float(v.max())
    if hi - lo < 1:
        return hi
    hist, edges = np.histogram(v, bins=max(2, int((hi - lo) / 0.5)))
    w = np.cumsum(hist)
    mid = (edges[:-1] + edges[1:]) / 2
    m = np.cumsum(hist * mid)
    w0, w1 = w[:-1], w[-1] - w[:-1]
    ok = (w0 > 0) & (w1 > 0)
    between = np.where(ok, (m[-1] * w0 / w[-1] - m[:-1]) ** 2 / np.maximum(w0 * w1, 1), 0)
    return float(edges[1:][np.argmax(between)])


def roof(poly, rr, cc, v):
    """One level: (height, slope east, slope south). A roof that is clearly one tilted plane (a wedge
    crown, a monopitch shed) keeps its plane, height at the footprint's centroid; else the 90th
    percentile, flat."""
    flat = float(np.percentile(v, 90))
    if len(v) < 100 or np.std(v) < 2.0:
        return flat, 0.0, 0.0
    e, n = px_to_nztm(rr, cc)
    c = poly.centroid
    A = np.column_stack([np.ones(len(v)), e - c.x, n - c.y])
    keep = np.ones(len(v), bool)
    for _ in range(3):  # drop plant rooms and parapets from the fit
        coef, *_ = np.linalg.lstsq(A[keep], v[keep], rcond=None)
        res = v - A @ coef
        keep = np.abs(res) < max(1.0, 2.0 * np.std(res[keep]))
    rms = float(np.sqrt(np.mean(res[keep] ** 2)))
    grad = float(np.hypot(coef[1], coef[2]))
    if grad < 0.1 or grad > 1.2 or rms > 0.35 * np.std(v) or keep.mean() < 0.8:
        return flat, 0.0, 0.0
    # game axes: +X east, +Z south
    return float(coef[0]), float(coef[1]), float(-coef[2])


def levels(poly, nd, rr, cc, v, depth):
    """
    Prisms (polygon, height, slope east, slope south) of a footprint from its pixels (absolute rows /
    cols, nDSM values). One level when the roof heights form one class; else (Otsu threshold) the
    upper pixels form upper parts, each connected component its own footprint (convex hull ∩ this
    one), split again in turn (setbacks, a crown), up to three levels deep; this level keeps the 75th
    percentile of its own lower pixels.
    """
    if len(v) < 4:
        return []
    thr = otsu(v) if depth < 2 else float('inf')
    upper = v > thr
    split = upper.sum() >= 60 and (~upper).sum() >= max(30, 0.08 * len(v))
    if split:
        mu, ml = float(v[upper].mean()), float(v[~upper].mean())
        split = mu - ml >= max(8.0, 0.2 * mu)
    if not split:
        h, sx, sz = roof(poly, rr, cc, v)
        return [(poly, h, sx, sz)] if h >= MIN_HEIGHT else []
    ur, uc = rr[upper], cc[upper]
    r0, c0 = ur.min(), uc.min()
    grid = np.zeros((ur.max() - r0 + 1, uc.max() - c0 + 1), bool)
    grid[ur - r0, uc - c0] = True
    comp, n = ndimage.label(grid, structure=np.ones((3, 3)))
    label_of = np.zeros(len(v), np.int32)
    label_of[upper] = comp[ur - r0, uc - c0]
    parts = []
    taken = np.zeros(len(v), bool)
    for c in range(1, n + 1):
        sel = label_of == c
        if sel.sum() < 60:  # < 60 m²: a lift overrun, a plant room, a spire
            continue
        cx, cy = px_to_nztm(rr[sel], cc[sel])
        hull = MultiPoint(np.column_stack([cx, cy])).convex_hull.buffer(0.5, join_style=2)
        part = clean(hull.intersection(poly))
        if part is None:
            continue
        parts += levels(part, nd, rr[sel], cc[sel], v[sel], depth + 1)
        taken |= sel
    if not parts:
        h, sx, sz = roof(poly, rr, cc, v)
        return [(poly, h, sx, sz)] if h >= MIN_HEIGHT else []
    rest = ~taken & ~upper
    base_h = float(np.percentile(v[rest], 75)) if rest.sum() >= 12 else 0.0
    base = [(poly, base_h, 0.0, 0.0)] if base_h >= MIN_HEIGHT else []
    return base + parts


def main():
    feats = outlines()
    dsm, dem = lidar()
    nd = dsm - dem
    print(f'nDSM: {nd.shape}, nan {np.isnan(nd).mean():.3f}, max {np.nanmax(nd):.1f}', flush=True)

    polys = []
    for f in feats:
        p = clean(shape(f['geometry']))
        if p is not None:
            polys.append((p, f['properties']))
    lab = features.rasterize(((mapping(p), i + 1) for i, (p, _) in enumerate(polys)), out_shape=nd.shape, transform=TRANSFORM, fill=0, dtype='int32')

    slices = ndimage.find_objects(lab)
    pad = lambda sl: (slice(max(0, sl[0].start - 2), sl[0].stop + 2), slice(max(0, sl[1].start - 2), sl[1].stop + 2))
    buildings = []
    dropped = 0
    for i, (p, props) in enumerate(polys):
        sl = slices[i] if i < len(slices) else None
        parts = split_parts(p, nd, lab, i + 1, pad(sl)) if sl is not None else []
        if not parts:
            dropped += 1
            continue
        buildings.append({'id': props['building_id'], 'src': 'outline', 'name': props.get('name') or '', 'use': props.get('use') or '', 'parts': parts})
    print(f'outline buildings: {len(buildings)} ({dropped} outlines with nothing standing in 2024)', flush=True)

    # ── LiDAR-only footprints: smooth surfaces ≥ 8 m high (any surface ≥ 30 m) outside every outline ──
    ndz = np.nan_to_num(nd, nan=0.0)
    mean = ndimage.uniform_filter(ndz, 3)
    sq = ndimage.uniform_filter(ndz * ndz, 3)
    rough = np.sqrt(np.maximum(0.0, sq - mean * mean))
    covered = ndimage.binary_dilation(lab > 0, iterations=3)
    # Sky Tower (hand-built)
    yy, xx = np.mgrid[0:nd.shape[0], 0:nd.shape[1]]
    ex, ny = px_to_nztm(yy, xx)
    near_tower = np.hypot(ex - SKY_TOWER[0], ny - SKY_TOWER[1]) < 40
    # trees: rough at 1 m and below ≈ 30 m (the CBD's tallest are Moreton Bay figs); tower roofs are
    # rough too (plant, crowns, glass returns), but taller
    smooth = ndimage.median_filter(rough, 5) < 0.5
    cand = (ndz >= 8.0) & (smooth | (ndz >= 30.0)) & ~covered & ~near_tower
    cand = ndimage.binary_opening(cand, iterations=2)  # thin cranes, wires, tree crowns
    cand = ndimage.binary_closing(cand, iterations=2)
    comp, n = ndimage.label(cand)
    sizes = ndimage.sum(cand, comp, range(1, n + 1))
    lid = 0
    shapes_ = features.shapes(comp.astype(np.int32), mask=cand, transform=TRANSFORM)
    by_comp = {}
    for geom, val in shapes_:
        by_comp.setdefault(int(val), []).append(shape(geom))
    cands = []
    for c, geoms in by_comp.items():
        if sizes[c - 1] < 150:
            continue
        p = clean(unary_union(geoms).simplify(1.0))
        if p is None or p.area < 150:
            continue
        # buildings are compact; tree rows and retaining walls are not. Below 30 m, also straight-edged:
        # a canopy's outline wanders (perimeter well over its bounding rectangle's)
        mrr = p.minimum_rotated_rectangle
        if p.area / mrr.area < 0.45:
            continue
        tall = np.nanpercentile(nd[features.geometry_mask([mapping(p)], nd.shape, TRANSFORM, invert=True)], 90) >= 30
        if not tall and p.length / mrr.length > 1.15:
            continue
        cands.append(p)
    lab2 = features.rasterize(((mapping(p), i + 1) for i, p in enumerate(cands)), out_shape=nd.shape, transform=TRANSFORM, fill=0, dtype='int32') if cands else np.zeros_like(lab)
    slices2 = ndimage.find_objects(lab2)
    for i, p in enumerate(cands):
        sl = slices2[i] if i < len(slices2) else None
        parts = split_parts(p, nd, lab2, i + 1, pad(sl)) if sl is not None else []
        if parts:
            lid += 1
            buildings.append({'id': -(i + 1), 'src': 'lidar', 'name': '', 'use': '', 'parts': parts})
    print(f'LiDAR-only buildings: {lid}', flush=True)

    def ring(p):
        xs, ys = p.exterior.coords.xy
        lon, lat = to_wgs.transform(np.array(xs[:-1]), np.array(ys[:-1]))
        return [[round(a, 8), round(b, 8)] for a, b in zip(lon, lat)]

    out = [{**b, 'parts': [{'ring': ring(p), 'h': round(h, 2), 'sx': round(sx, 3), 'sz': round(sz, 3)} for p, h, sx, sz in b['parts']]} for b in buildings]
    json.dump(out, open(f'{WORK}/buildings.json', 'w'))

    # ── Spot checks: the raw LiDAR at known towers (independent of the splitting above) ──
    # hand-placed game positions of CBD_LANDMARKS (auckland.ts, ±50 m): the roof point is the highest
    # smooth (9 × 9 median: not a crane) nDSM within 70 m; the reference height is the median of the
    # raw nDSM within 4 m of it (the test checks the baked roof there)
    # (only towers whose position is close enough that the highest roof nearby is theirs)
    named = {'PwC Tower': (392, -433), 'Vero Centre': (445, -277), 'Pacifica': (650, -300), 'Metropolis': (440, -10), 'ANZ Centre': (294, -144)}
    med = ndimage.median_filter(ndz, 9)
    med[near_tower] = 0
    def ref(r, c, rad=4):
        yy, xx = np.mgrid[-rad:rad + 1, -rad:rad + 1]
        w = nd[r - rad:r + rad + 1, c - rad:c + rad + 1][np.hypot(yy, xx) <= rad]
        return round(float(np.nanmedian(w)), 2)

    checks = []
    for name, (gx, gz) in named.items():
        lon0, lat0 = 174.7622 + gx / (111320 * np.cos(np.radians(-36.8485))), -36.8485 - gz / 110950
        e, n_ = to_nztm.transform(lon0, lat0)
        c0, r0 = int(e - E0), int(N1 - n_)
        win = med[r0 - 70:r0 + 71, c0 - 70:c0 + 71].copy()
        yy, xx = np.mgrid[-70:71, -70:71]
        win[np.hypot(yy, xx) > 70] = 0
        r, c = np.unravel_index(np.argmax(win), win.shape)
        e2, n2 = px_to_nztm(r0 - 70 + r, c0 - 70 + c)
        lon, lat = to_wgs.transform(e2, n2)
        checks.append({'name': name, 'lon': round(lon, 8), 'lat': round(lat, 8), 'lidar': ref(r0 - 70 + r, c0 - 70 + c), 'peak': round(float(win[r, c]), 2)})
    # a sample of outlines that stand at one level: the median nDSM around a point well inside them
    rng = np.random.default_rng(2)
    single = [b for b in buildings if b['src'] == 'outline' and len(b['parts']) == 1 and b['parts'][0][0].area > 400]
    for k in rng.choice(len(single), 40, replace=False):
        b = single[k]
        q = b['parts'][0][0].buffer(-4).representative_point() if not b['parts'][0][0].buffer(-4).is_empty else b['parts'][0][0].representative_point()
        c = int(q.x - E0)
        r = int(N1 - q.y)
        lon, lat = to_wgs.transform(q.x, q.y)
        if not (3 <= r < nd.shape[0] - 3 and 3 <= c < nd.shape[1] - 3) or np.isnan(nd[r - 3:r + 4, c - 3:c + 4]).any():
            continue
        checks.append({'name': f'outline {b["id"]}', 'lon': round(lon, 8), 'lat': round(lat, 8), 'lidar': ref(r, c, 3)})
    json.dump(checks, open(f'{WORK}/spotchecks.json', 'w'), indent=1)
    for c in checks[:8]:
        print(c, flush=True)
    print(f'wrote {WORK}/buildings.json ({len(out)} buildings, {sum(len(b["parts"]) for b in out)} prisms)')


if __name__ == '__main__':
    main()
