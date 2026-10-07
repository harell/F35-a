"""
Real suburbs 2/9 (#121), step 1: real houses on the Devonport peninsula, Waiheke and the gulf islands, from the LINZ
building outlines and the 2024 LiDAR, each fitted to an oriented rectangle with a measured roof.

    LINZ_API_KEY=… python3 tools/linz/houses.py <work dir> [<aerial work dir>]

Areas: the outlines wherever the aerial photo of #120 keeps the scatter's procedural houses off the ground (its summed
weight over ½: aucklandAerial.ts aerialCovers), i.e. on the North Shore side of the harbour inside the city square and
the two Devonport boxes (Devonport, Stanley Bay, Cheltenham, Narrow Neck, Bayswater, Belmont, and Northcote Point at
the square's west edge), and on the land of the island boxes (Waiheke with Pakatoa and Rotoroa, Rangitoto, Motutapu,
Motuihe, Rakino; Browns Island has no outlines).

Inputs (cached in <work>):
  - LINZ NZ Building Outlines (LDS layer 101290, WFS, LINZ_API_KEY), one request per area box (outlines-<area>.json).
  - Auckland LiDAR 1 m DSM and DEM (2024), Part 1 (Devonport) and Part 2 (the islands), s3://nz-elevation/auckland/
    auckland-part-{1,2}_2024/{dsm,dem}_1m/2193/: whole sheets downloaded once into <work>/../lidar/part<N>/<kind>/
    (run tools/linz/houses.py fetch first, or let it download what is missing).
  - The 2024 7.5 cm aerial mosaics the aerial bake (#120) cached in <aerial work> (aerial-mosaic-<box>.npz: 0.6 m over
    Devonport, 2.4 m over the islands) and its islands' land alpha (aerial-rect-<box>.png), for roof colours, the
    spot checks and the trees-vs-roofs test of the LiDAR-only buildings.

Per outline (≤ MAX_AREA m²: bigger buildings are #124's; ≥ MIN_AREA m²):
  - Rectangle: oriented along the outline's dominant edge direction (length²-weighted mode of the edge angles mod
    90°), centred on its centroid, with the outline's second moments along both axes and its area (an L-shaped house
    gets the rectangle of its main mass).
  - Gone since 2017: the LINZ outlines were traced from the 2017 photos; one with less than GONE m standing on most
    of it in the 2024 LiDAR is dropped (demolished, a building site).
  - Roof: nDSM = DSM − DEM inside the outline shrunk 0.7 m, fitted as h = eave + pitch · d with d the distance to the
    eave edges of the rectangle for a gable along either axis or a hip (least squares, refitted without the cells
    off by more than max(0.6 m, 2.5 RMS): a tree over the roof, a chimney); flat (the median) unless a pitched fit
    is clearly better. A hip is drawn as a gable along the long side (the game's house archetype).
  - Roof colour: the median of the 2024 photo inside the outline shrunk 0.5 m, at the city square's exposure (#120:
    the albedo the game's photo shows), quantised to a palette of PALETTE colours.
New since 2017 (no outline): components of the LiDAR standing 2.5–15 m, smooth (a roof, not a canopy), not green in
the photo, compact and straight-edged, MIN_LIDAR–MAX_AREA m², outside every outline: fitted the same way.

Spot checks (#121's "within 2 m"): SPOTS random Devonport houses; the photo roof under each is found by
cross-correlating the house's rectangle outline with the photo's luminance gradient (±6 m), independently of the
outline; the test checks the baked house centre against it.

Output: <work>/houses.json (lon/lat, read by houses.ts) and <work>/house-spotchecks.json.
"""
import concurrent.futures as cf
import glob
import json
import os
import subprocess
import sys

import numpy as np
import rasterio
import shapely
from PIL import Image
from pyproj import Transformer
from rasterio import features
from rasterio.windows import from_bounds
from scipy import ndimage
from scipy.cluster.vq import kmeans2
from shapely.geometry import LineString, Polygon, mapping, shape
from shapely.ops import unary_union

os.environ.setdefault('GDAL_DISABLE_READDIR_ON_OPEN', 'EMPTY_DIR')

WORK = sys.argv[1] if len(sys.argv) > 1 else '/home/user/work/houses'
AERIAL = sys.argv[2] if len(sys.argv) > 2 else os.path.join(os.path.dirname(WORK.rstrip('/')), 'aerial')
LIDAR = os.path.join(os.path.dirname(WORK.rstrip('/')), 'lidar')
os.makedirs(WORK, exist_ok=True)

O = (-36.8485, 174.7622)  # AKL_ORIGIN (src/core/auckland.ts)
MLAT = 110950
MLON = 111320 * np.cos(np.radians(O[0]))
to_nztm = Transformer.from_crs(4326, 2193, always_xy=True)
to_wgs = Transformer.from_crs(2193, 4326, always_xy=True)

MIN_AREA = 20.0     # m²: smaller sheds and water tanks are left out
MAX_AREA = 600.0    # m²: schools, halls, shops and apartment blocks over this are #124's
MIN_LIDAR = 40.0    # m²: a LiDAR-only building (new since 2017) at least this big
GONE = 2.0          # m: less than this standing on most of an outline in 2024 = gone
PALETTE = 256
SPOTS = 20
EXPOSURE_FALLBACK = 0.522  # the city square's exposure (aerial-grade.json) if the aerial cache lacks it

# the photo square and the boxes of #120 (aucklandAerial.ts AERIAL_RECT, AERIAL_FEATHER; aerial.py OUTER)
SQUARE = dict(name='city', x0=-1536, z0=-3072, w=5120, h=5120, feather=320)
DEV_BOXES = [
    dict(name='devonport_north', x0=-1, z0=-5499.5, w=4480, h=2750, feather=320),
    dict(name='devonport_east', x0=3261.5, z0=-3069.5, w=1740, h=1670, feather=320),
]
ISLAND_BOXES = [
    dict(name='waiheke', x0=19380, z0=-12420, w=20040, h=12580, px=5, feather=60),
    dict(name='rangitoto_motutapu', x0=5720, z0=-13280, w=10060, h=9080, px=5, feather=60),
    dict(name='motuihe', x0=15140, z0=-5500, w=2500, h=2720, px=5, feather=40),
    dict(name='rakino', x0=15660, z0=-15660, w=1600, h=2560, px=5, feather=60),
    dict(name='browns', x0=11120, z0=-2580, w=1300, h=1340, px=5, feather=60),
]
APRON = 32
# North of the harbour: the CBD side (z > NORTH_SHORE_Z) is the CBD region and the neighbourhoods, not this issue's
NORTH_SHORE_Z = -1500
AREAS = {
    # game XZ box of each WFS request, the LiDAR part(s) to read first, the photo mosaics
    'devonport': dict(box=(-1600, -5500, 5000, NORTH_SHORE_Z), parts=(1, 2), photos=('devonport_north', 'devonport_east', 'city')),
    'waiheke': dict(box=(19380, -12420, 39420, 160), parts=(2, 1), photos=('waiheke',)),
    'rangitoto_motutapu': dict(box=(5720, -13280, 15780, -4200), parts=(2, 1), photos=('rangitoto_motutapu',)),
    'motuihe': dict(box=(15140, -5500, 17640, -2780), parts=(2, 1), photos=('motuihe',)),
    'rakino': dict(box=(15660, -15660, 17260, -13100), parts=(2, 1), photos=('rakino',)),
    'browns': dict(box=(11120, -2580, 12420, -1240), parts=(2, 1), photos=('browns',)),
}
S3 = 'https://nz-elevation.s3.ap-southeast-2.amazonaws.com/auckland/auckland-part-{part}_2024/{kind}_1m/2193'


def game_to_lonlat(x, z):
    return O[1] + x / MLON, O[0] - z / MLAT


def nztm_to_game(e, n):
    lon, lat = to_wgs.transform(e, n)
    return (lon - O[1]) * MLON, (O[0] - lat) * MLAT


def game_to_nztm(x, z):
    return to_nztm.transform(*game_to_lonlat(x, z))


def nztm_box(x0, z0, x1, z1):
    pts = [game_to_nztm(x, z) for x in (x0, x1) for z in (z0, z1)]
    return min(p[0] for p in pts), min(p[1] for p in pts), max(p[0] for p in pts), max(p[1] for p in pts)


# ── Inputs ──
def outlines(area):
    out = os.path.join(WORK, f'outlines-{area}.json')
    if not os.path.exists(out):
        key = os.environ.get('LINZ_API_KEY')
        if not key:
            sys.exit(f'{out} is not cached and LINZ_API_KEY is not set (free key: https://data.linz.govt.nz)')
        E0, N0, E1, N1 = nztm_box(*AREAS[area]['box'])
        q = {'service': 'WFS', 'version': '2.0.0', 'request': 'GetFeature', 'outputFormat': 'json', 'srsName': 'EPSG:2193',
             'typeNames': 'layer-101290', 'cql_filter': f'BBOX(shape,{N0},{E0},{N1},{E1})'}
        args = ['curl', '-sSfG', f'https://data.linz.govt.nz/services;key={key}/wfs']
        for k, v in q.items():
            args += ['--data-urlencode', f'{k}={v}']
        print(f'fetching outlines: {area} …', flush=True)
        subprocess.run(args + ['-o', out + '.part'], check=True)
        os.replace(out + '.part', out)
    return json.load(open(out))['features']


def stac_sheets(part, kind, area):
    """Sheet names of a LiDAR part over an area (STAC, cached by the hero kit's site.py in <work>/../hero/_stac)."""
    import importlib.util
    spec = importlib.util.spec_from_file_location('hero_site', os.path.join(os.path.dirname(__file__), '../hero/site.py'))
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    x0, z0, x1, z1 = AREAS[area]['box']
    lo0, la1 = game_to_lonlat(x0, z0)
    lo1, la0 = game_to_lonlat(x1, z1)
    urls = m.stac_tiles(S3.format(part=part, kind=kind), (lo0, la0, lo1, la1), os.path.join(os.path.dirname(WORK.rstrip('/')), 'hero/_stac'))
    return [u.split('/')[-1][:-5] for u in urls]


def fetch_lidar():
    """Download every LiDAR sheet the areas need (whole COGs, ≈ 15–30 MB each) into <work>/../lidar."""
    jobs = set()
    for area in AREAS:
        for part in (1, 2):
            for kind in ('dsm', 'dem'):
                for t in stac_sheets(part, kind, area):
                    jobs.add((part, kind, t))

    def get(job):
        part, kind, t = job
        d = os.path.join(LIDAR, f'part{part}', kind)
        os.makedirs(d, exist_ok=True)
        f = os.path.join(d, f'{t}.tiff')
        if not os.path.exists(f):
            subprocess.run(['curl', '-sSf', '--retry', '4', '-o', f + '.part', f'{S3.format(part=part, kind=kind)}/{t}.tiff'], check=True)
            os.replace(f + '.part', f)
        return f

    with cf.ThreadPoolExecutor(8) as ex:
        print(f'LiDAR sheets: {len(list(ex.map(get, sorted(jobs))))}', flush=True)


_bounds = {}


def sheets(part, kind):
    out = []
    for f in sorted(glob.glob(os.path.join(LIDAR, f'part{part}', kind, '*.tiff'))):
        if f not in _bounds:
            with rasterio.open(f) as s:
                _bounds[f] = tuple(s.bounds)
        out.append((f, _bounds[f]))
    return out


def lidar_window(E0, N0, E1, N1, parts):
    """DSM − DEM (nDSM) and the DEM on the 1 m grid over the window (E0 … E1, N0 … N1 on whole metres), the first part
    first and the others filling its gaps."""
    W, H = int(E1 - E0), int(N1 - N0)
    res = {}
    for kind in ('dsm', 'dem'):
        mos = np.full((H, W), np.nan, np.float32)
        for part in parts:
            for f, b in sheets(part, kind):
                ix0, ix1, iy0, iy1 = max(b[0], E0), min(b[2], E1), max(b[1], N0), min(b[3], N1)
                if ix0 >= ix1 or iy0 >= iy1:
                    continue
                with rasterio.open(f) as s:
                    a = s.read(1, window=from_bounds(ix0, iy0, ix1, iy1, s.transform), masked=True).astype(np.float32).filled(np.nan)
                r0, c0 = int(round(N1 - iy1)), int(round(ix0 - E0))
                sub = mos[r0:r0 + a.shape[0], c0:c0 + a.shape[1]]
                a = a[:sub.shape[0], :sub.shape[1]]
                m = np.isnan(sub) & ~np.isnan(a)
                sub[m] = a[m]
        res[kind] = mos
    return res['dsm'] - res['dem'], res['dem']


_photos = {}


def photo(name):
    if name not in _photos:
        p = os.path.join(AERIAL, f'aerial-mosaic-{name}.npz')
        if not os.path.exists(p):
            _photos[name] = None
        else:
            d = np.load(p)
            _photos[name] = dict(rgb=d['rgb'], e0=float(d['e0']), n1=float(d['n1']), res=float(d['res']))
    return _photos[name]


def photo_pixels(names, poly):
    """RGB (sRGB uint8) of the photo pixels inside poly (NZTM), from the first mosaic that holds it."""
    for n in names:
        p = photo(n)
        if p is None:
            continue
        e0, n1, res, rgb = p['e0'], p['n1'], p['res'], p['rgb']
        b = poly.bounds
        c0, c1 = int((b[0] - e0) / res), int((b[2] - e0) / res) + 1
        r0, r1 = int((n1 - b[3]) / res), int((n1 - b[1]) / res) + 1
        if c0 < 0 or r0 < 0 or c1 >= rgb.shape[1] or r1 >= rgb.shape[0]:
            continue
        win = rgb[r0:r1 + 1, c0:c1 + 1]
        if win.size == 0 or win.max() == 0:
            continue
        tr = rasterio.transform.from_origin(e0 + c0 * res, n1 - r0 * res, res, res)
        m = features.geometry_mask([mapping(poly)], win.shape[:2], tr, invert=True, all_touched=False)
        if m.sum() == 0:
            cx, cy = poly.centroid.x, poly.centroid.y
            m = np.zeros(win.shape[:2], bool)
            m[min(win.shape[0] - 1, int((n1 - cy) / res) - r0), min(win.shape[1] - 1, int((cx - e0) / res) - c0)] = True
        px = win[m]
        px = px[px.max(1) > 0]
        if len(px):
            return px
    return None


def srgb_to_lin(c):
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def lin_to_srgb(c):
    c = np.clip(c, 0, 1)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * c ** (1 / 2.4) - 0.055)


# ── Coverage: where the photo keeps the procedural houses off ──
def smooth01(e, f):
    t = np.clip(e / f, 0, 1)
    return t * t * (3 - 2 * t)


def box_weight(b, x, z):
    return smooth01(min(x - b['x0'], b['x0'] + b['w'] - x, z - b['z0'], b['z0'] + b['h'] - z), b['feather'])


_alpha = {}


def island_alpha(b, x, z):
    if b['name'] not in _alpha:
        p = os.path.join(AERIAL, f'aerial-rect-{b["name"]}.png')
        _alpha[b['name']] = np.asarray(Image.open(p))[..., 3] if os.path.exists(p) else None
    a = _alpha[b['name']]
    if a is None:
        return 1.0
    i = int((x - b['x0']) / b['px']) + APRON
    j = int((z - b['z0']) / b['px']) + APRON
    if not (0 <= i < a.shape[1] and 0 <= j < a.shape[0]):
        return 0.0
    return a[j, i] / 255.0


def photo_covers(area, x, z):
    """aucklandAerial.ts aerialCovers: the square's edge weight + each box's (× its alpha on the islands) over ½."""
    if area == 'devonport':
        if z > NORTH_SHORE_Z:
            return False
        w = box_weight(SQUARE, x, z) + sum(box_weight(b, x, z) for b in DEV_BOXES)
        return w > 0.5
    w = 0.0
    for b in ISLAND_BOXES:
        if b['x0'] < x < b['x0'] + b['w'] and b['z0'] < z < b['z0'] + b['h']:
            w += box_weight(b, x, z) * island_alpha(b, x, z)
    return w > 0.5


COVER_CELL = 32  # m: the cells of the coverage grid shipped with the houses


def coverage_grid():
    """
    Where the real houses are the truth: every COVER_CELL m cell (game XZ) whose centre the areas' photo covers
    (photo_covers, vectorised), i.e. where the bake took every outline it found. The game keeps the procedural lots,
    streets, houses and centres off it (aucklandHouses.ts houseCoverage). (x0, z0, cols, rows, run lengths per row:
    alternating unset / set, starting unset.)
    """
    bx = [a['box'] for a in AREAS.values()]
    c = COVER_CELL
    x0 = int(np.floor(min(b[0] for b in bx) / c)) * c
    z0 = int(np.floor(min(b[1] for b in bx) / c)) * c
    cols = int(np.ceil((max(b[2] for b in bx) - x0) / c))
    rows = int(np.ceil((max(b[3] for b in bx) - z0) / c))
    X, Z = np.meshgrid(x0 + (np.arange(cols) + 0.5) * c, z0 + (np.arange(rows) + 0.5) * c)

    def bw(b):
        e = np.minimum.reduce([X - b['x0'], b['x0'] + b['w'] - X, Z - b['z0'], b['z0'] + b['h'] - Z])
        return smooth01(e, b['feather'])

    dev = (bw(SQUARE) + sum(bw(b) for b in DEV_BOXES) > 0.5) & (Z <= NORTH_SHORE_Z)
    isl = np.zeros_like(X)
    for b in ISLAND_BOXES:
        p = os.path.join(AERIAL, f'aerial-rect-{b["name"]}.png')
        a = np.asarray(Image.open(p))[..., 3] if os.path.exists(p) else None
        inside = (X > b['x0']) & (X < b['x0'] + b['w']) & (Z > b['z0']) & (Z < b['z0'] + b['h'])
        if a is None or not inside.any():
            continue
        i = np.clip(((X - b['x0']) / b['px']).astype(int) + APRON, 0, a.shape[1] - 1)
        j = np.clip(((Z - b['z0']) / b['px']).astype(int) + APRON, 0, a.shape[0] - 1)
        isl += np.where(inside, bw(b) * a[j, i] / 255.0, 0)
    cov = dev | (isl > 0.5)
    runs = []
    for r in cov:
        rr, cur, n = [], False, 0
        for v in r:
            if bool(v) != cur:
                rr.append(n)
                cur, n = bool(v), 0
            n += 1
        rr.append(n)
        runs.append(rr)
    print(f'coverage: {cols} x {rows} cells of {c} m, {cov.mean() * 100:.1f} % set ({cov.sum() * c * c / 1e6:.1f} km²)', flush=True)
    return dict(x0=x0, z0=z0, cell=c, cols=cols, rows=rows, runs=runs)


# ── Rectangle and roof fits ──
def dominant_angle(poly):
    """The outline's main direction (rad, NZTM east = 0, counter-clockwise), from its edges' angles mod 90°."""
    xy = np.asarray(poly.exterior.coords)
    d = np.diff(xy, axis=0)
    ln = np.hypot(d[:, 0], d[:, 1])
    ang = np.degrees(np.arctan2(d[:, 1], d[:, 0])) % 90
    hist = np.zeros(90)
    np.add.at(hist, ang.astype(int) % 90, ln * ln)
    sm = sum(np.roll(hist, k) * w for k, w in ((-2, 0.25), (-1, 0.5), (0, 1), (1, 0.5), (2, 0.25)))
    k = int(np.argmax(sm))
    # refine: weighted circular mean of the edges within 3° of the peak
    dd = (ang - k + 45) % 90 - 45
    sel = np.abs(dd) <= 3
    off = float(np.sum(dd[sel] * ln[sel] ** 2) / max(np.sum(ln[sel] ** 2), 1e-9)) if sel.any() else 0.0
    return np.radians(k + off)


def rectangle(poly):
    """(centre e, n, angle, extent along the angle, extent across): the outline's centroid, second moments and area."""
    th = dominant_angle(poly)
    c = poly.centroid
    xy = np.asarray(poly.exterior.coords) - [c.x, c.y]
    ca, sa = np.cos(th), np.sin(th)
    u = xy[:, 0] * ca + xy[:, 1] * sa
    v = -xy[:, 0] * sa + xy[:, 1] * ca
    a = u[:-1] * v[1:] - u[1:] * v[:-1]
    A = a.sum() / 2
    suu = np.sum(a * (u[:-1] ** 2 + u[:-1] * u[1:] + u[1:] ** 2)) / 12
    svv = np.sum(a * (v[:-1] ** 2 + v[:-1] * v[1:] + v[1:] ** 2)) / 12
    wu = np.sqrt(max(12 * suu / A, 1.0))
    wv = np.sqrt(max(12 * svv / A, 1.0))
    k = np.sqrt(abs(A) / (wu * wv))
    wu, wv = min(wu * k, u.max() - u.min()), min(wv * k, v.max() - v.min())
    return c.x, c.y, th, float(wu), float(wv)


def fit_roof(e, n, th, wu, wv, pe, pn, h, poly=None):
    """
    Roof from the nDSM samples h at NZTM points (pe, pn) for the rectangle (centre e, n, angle th, extents wu, wv):
    (eave, rise, ridge along u?, kind, rms) — rise 0 for a flat roof. Gables along either axis, a hip over the
    rectangle and a hip along the outline itself (d = the distance to its nearest edge: a villa's roof over an L- or
    T-shaped plan) as h = eave + pitch · d; pitched when one fits clearly better than flat. Else a roof whose heights
    still spread over a metre ('spread') runs from their 15th to their 90th percentile.
    """
    ca, sa = np.cos(th), np.sin(th)
    u = (pe - e) * ca + (pn - n) * sa
    v = -(pe - e) * sa + (pn - n) * ca
    hu, hv = wu / 2, wv / 2
    med = float(np.median(h))
    flat_res = h - med
    keep = np.abs(flat_res) < max(0.6, 2.5 * np.std(flat_res))
    rms_flat = float(np.sqrt(np.mean((h[keep] - np.median(h[keep])) ** 2))) if keep.any() else 9.0
    flat = float(np.median(h[keep])) if keep.any() else med
    best = None
    if len(h) >= 10:
        models = {
            'u': (np.clip(hv - np.abs(v), 0, None), hv),           # ridge along u
            'v': (np.clip(hu - np.abs(u), 0, None), hu),           # ridge along v
            'hip': (np.clip(np.minimum(hu - np.abs(u), hv - np.abs(v)), 0, None), min(hu, hv)),
        }
        if poly is not None:
            d = shapely.distance(shapely.points(pe, pn), poly.exterior)
            models['outline'] = (d, min(float(d.max()) + 0.5, min(hu, hv)))
        for name, (d, dmax) in models.items():
            A = np.column_stack([np.ones(len(h)), d])
            k = np.ones(len(h), bool)
            for _ in range(3):
                if k.sum() < 6:
                    break
                coef, *_ = np.linalg.lstsq(A[k], h[k], rcond=None)
                res = h - A @ coef
                rms = float(np.sqrt(np.mean(res[k] ** 2)))
                k = np.abs(res) < max(0.6, 2.5 * rms)
            if k.sum() < max(6, 0.7 * len(h)):
                continue
            coef, *_ = np.linalg.lstsq(A[k], h[k], rcond=None)
            rms = float(np.sqrt(np.mean((h[k] - A[k] @ coef) ** 2)))
            if best is None or rms < best[0]:
                best = (rms, name, float(coef[0]), float(coef[1]), dmax)
    if best is not None:
        rms, name, eave, pitch, dmax = best
        if 0.1 <= pitch <= 1.5 and rms_flat - rms >= 0.1 and rms < 0.85 * rms_flat and eave >= 1.8:
            along_u = name == 'u' or (name in ('hip', 'outline') and wu >= wv)
            return eave, pitch * dmax, along_u, 'pitched', rms
    # no clean plane fit (a complex villa roof, a tree over part of it): a roof whose heights spread over a metre is
    # still a pitched one, from its low edge (p15) to its ridge (p90); a flat roof spreads a few decimetres
    lo, hi = (float(np.percentile(h[keep], q)) for q in (15, 90)) if keep.sum() >= 6 else (flat, flat)
    if hi - lo >= 1.0 and lo >= 1.8:
        return lo, min(hi - lo, 0.8 * min(hu, hv)), wu >= wv, 'spread', rms_flat
    return flat, 0.0, wu >= wv, 'flat', rms_flat


# ── One chunk of outlines ──
def process_chunk(area, polys, all_polys, E0, N0, E1, N1):
    cfg = AREAS[area]
    nd, dem = lidar_window(E0, N0, E1, N1, cfg['parts'])
    tr = rasterio.transform.from_origin(E0, N1, 1.0, 1.0)
    H, W = nd.shape
    out = []
    stats = dict(gone=0, nolidar=0)

    def measure(poly, src, pid):
        e, n, th, wu, wv = rectangle(poly)
        inner = poly.buffer(-0.7, join_style=2)
        use = inner if (not inner.is_empty and inner.area >= 8) else poly
        b = poly.bounds
        c0, c1 = max(0, int(b[0] - E0) - 2), min(W, int(b[2] - E0) + 3)
        r0, r1 = max(0, int(N1 - b[3]) - 2), min(H, int(N1 - b[1]) + 3)
        if c0 >= c1 or r0 >= r1:
            stats['nolidar'] += 1
            return None
        wtr = rasterio.transform.from_origin(E0 + c0, N1 - r0, 1.0, 1.0)
        m = features.geometry_mask([mapping(use)], (r1 - r0, c1 - c0), wtr, invert=True)
        if m.sum() < 4:
            m = features.geometry_mask([mapping(poly)], (r1 - r0, c1 - c0), wtr, invert=True, all_touched=True)
        rr, cc = np.nonzero(m)
        rr, cc = rr + r0, cc + c0
        h = nd[rr, cc]
        ok = ~np.isnan(h)
        if ok.sum() < 3:
            stats['nolidar'] += 1
            return None
        rr, cc, h = rr[ok], cc[ok], h[ok]
        if np.percentile(h, 60) < GONE:
            stats['gone'] += 1
            return None
        pe, pn = E0 + cc + 0.5, N1 - rr - 0.5
        eave, rise, along_u, kind, rms = fit_roof(e, n, th, wu, wv, pe, pn, h, poly)
        if src == 'lidar' and (rms > 0.35 or eave > 9.0):
            return None  # a canopy (rough, or taller than a house), not a roof
        eave = float(np.clip(eave, 2.0, 30.0))
        rise = float(np.clip(rise, 0.0, 12.0))
        # the ridge's direction and the extents across it (w) and along it (d)
        if along_u:
            ang, w, d = th, wv, wu
        else:
            ang, w, d = th + np.pi / 2, wu, wv
        px = photo_pixels(cfg['photos'], poly.buffer(-0.5) if poly.buffer(-0.5).area > 4 else poly)
        rgb = np.median(px, axis=0).tolist() if px is not None else None
        lon, lat = to_wgs.transform(e, n)
        lon2, lat2 = to_wgs.transform(e + 10 * np.cos(ang), n + 10 * np.sin(ang))
        return dict(id=pid, src=src, area=area, lon=round(lon, 8), lat=round(lat, 8), lon2=round(lon2, 8), lat2=round(lat2, 8),
                    w=round(w, 2), d=round(d, 2), eave=round(eave, 2), rise=round(rise, 2), roof=kind, rgb=rgb,
                    e=round(e, 2), n=round(n, 2), ang=round(float(ang), 5), m2=round(poly.area, 1))

    for poly, pid in polys:
        r = measure(poly, 'outline', pid)
        if r:
            out.append(r)

    # ── New since 2017: smooth, not green, compact LiDAR roofs outside every outline ──
    ndz = np.nan_to_num(nd, nan=0.0)
    mean = ndimage.uniform_filter(ndz, 3)
    sq = ndimage.uniform_filter(ndz * ndz, 3)
    rough = np.sqrt(np.maximum(0.0, sq - mean * mean))
    smooth = ndimage.median_filter(rough, 5) < 0.45
    near = [p for p in all_polys if p.bounds[2] > E0 and p.bounds[0] < E1 and p.bounds[3] > N0 and p.bounds[1] < N1]
    covered = features.rasterize(((mapping(p), 1) for p in near), out_shape=(H, W), transform=tr, fill=0, dtype='uint8') > 0 if near else np.zeros((H, W), bool)
    covered = ndimage.binary_dilation(covered, iterations=3)
    green = np.zeros((H, W), bool)
    for name in cfg['photos']:
        p = photo(name)
        if p is None:
            continue
        cols = ((E0 + np.arange(W) + 0.5 - p['e0']) / p['res']).astype(int)
        rows = ((p['n1'] - (N1 - np.arange(H) - 0.5)) / p['res']).astype(int)
        okc = (cols >= 0) & (cols < p['rgb'].shape[1])
        okr = (rows >= 0) & (rows < p['rgb'].shape[0])
        if not okc.any() or not okr.any():
            continue
        sub = p['rgb'][np.clip(rows, 0, p['rgb'].shape[0] - 1)][:, np.clip(cols, 0, p['rgb'].shape[1] - 1)].astype(np.int16)
        valid = okr[:, None] & okc[None, :] & (sub.max(2) > 0)
        r, g, b = sub[..., 0], sub[..., 1], sub[..., 2]
        # vegetation: greener than red, not bluer than green (the 2024 photo's blue-green cast puts pohutukawa crowns
        # at about (34, 48, 45); grey, red and blue-grey roofs stay out)
        green |= valid & (g - r > 8) & (g >= b - 4)
        dark = valid & (sub.max(2) < 25)  # deep shade under a canopy
        green |= dark
    green = ndimage.binary_dilation(green, iterations=1)
    cand = (ndz >= 2.5) & (ndz <= 15) & smooth & ~covered & ~green & (np.nan_to_num(dem, nan=-9) > 0.5)
    cand = ndimage.binary_opening(cand, iterations=1)
    comp, ncomp = ndimage.label(cand)
    if ncomp:
        sizes = ndimage.sum(cand, comp, range(1, ncomp + 1))
        by = {}
        for geom, val in features.shapes(comp.astype(np.int32), mask=cand, transform=tr):
            by.setdefault(int(val), []).append(shape(geom))
        for c, geoms in by.items():
            if not (MIN_LIDAR <= sizes[c - 1] <= MAX_AREA):
                continue
            p = unary_union(geoms).buffer(0).simplify(1.0)
            if p.geom_type != 'Polygon' or p.area < MIN_LIDAR:
                continue
            p = Polygon(p.exterior)
            mrr = p.minimum_rotated_rectangle
            if p.area / mrr.area < 0.7 or p.length / mrr.length > 1.15:
                continue
            ctr = p.centroid
            if not (E0 + 20 <= ctr.x <= E1 - 20 and N0 + 20 <= ctr.y <= N1 - 20):
                continue  # the next chunk's (each chunk owns its inner part)
            r = measure(p, 'lidar', -1)
            if r:
                out.append(r)
    return out, stats


OUTLINE_OF = {}
DEV_OUTLINES = []


def main():
    if len(sys.argv) > 3 and sys.argv[3] == 'fetch':
        fetch_lidar()
        return
    grade = os.path.join(AERIAL, 'aerial-grade.json')
    k = json.load(open(grade))['exposure'] if os.path.exists(grade) else EXPOSURE_FALLBACK
    houses = []
    tally = {}
    only = os.environ.get('HOUSES_AREAS')  # a comma list, for a quick partial run
    for area in AREAS:
        if only and area not in only.split(','):
            continue
        feats = outlines(area)
        polys, all_polys, big, small, off = [], [], 0, 0, 0
        for f in feats:
            g = shape(f['geometry'])
            if g.geom_type == 'MultiPolygon':
                g = max(g.geoms, key=lambda q: q.area)
            if g.geom_type != 'Polygon':
                continue
            p = Polygon(g.exterior).buffer(0)
            if p.geom_type != 'Polygon':
                continue
            all_polys.append(p)
            if area == 'devonport':
                DEV_OUTLINES.append(p)
            x, z = nztm_to_game(p.centroid.x, p.centroid.y)
            if not photo_covers(area, x, z):
                off += 1
                continue
            if p.area > MAX_AREA:
                big += 1
                continue
            if p.area < MIN_AREA:
                small += 1
                continue
            polys.append((p.simplify(0.3, preserve_topology=True), int(f['properties']['building_id'])))
            OUTLINE_OF[int(f['properties']['building_id'])] = p
        # chunks of 1 km (NZTM), the LiDAR-only search over the area's photo-covered outlines' chunks
        chunks = {}
        for p, pid in polys:
            c = p.centroid
            chunks.setdefault((int(c.x // 1000), int(c.y // 1000)), []).append((p, pid))
        res, gone, nolidar = [], 0, 0
        for (ci, cj), ps in sorted(chunks.items()):
            b = np.array([q.bounds for q, _ in ps])
            E0 = float(np.floor(min(b[:, 0].min(), ci * 1000) - 25))
            N0 = float(np.floor(min(b[:, 1].min(), cj * 1000) - 25))
            E1 = float(np.ceil(max(b[:, 2].max(), ci * 1000 + 1000) + 25))
            N1 = float(np.ceil(max(b[:, 3].max(), cj * 1000 + 1000) + 25))
            out, st = process_chunk(area, ps, all_polys, E0, N0, E1, N1)
            # the LiDAR-only ones: keep those in this chunk's own square (and under the photo)
            out = [r for r in out if r['src'] == 'outline' or (ci * 1000 <= r['e'] < ci * 1000 + 1000 and cj * 1000 <= r['n'] < cj * 1000 + 1000
                                                                and photo_covers(area, *nztm_to_game(r['e'], r['n'])))]
            res += out
            gone += st['gone']
            nolidar += st['nolidar']
        # onto the photo's roofs: the measured photo-vs-outline offset field
        at, _ = lean_field(area, all_polys) if all_polys else (lambda e, n: (0.0, 0.0), None)
        for r in res:
            de, dn = at(r['e'], r['n'])
            r['e'], r['n'] = round(r['e'] + de, 2), round(r['n'] + dn, 2)
            r['shift'] = [round(de, 2), round(dn, 2)]
            r['lon'], r['lat'] = (round(v, 8) for v in to_wgs.transform(r['e'], r['n']))
            r['lon2'], r['lat2'] = (round(v, 8) for v in to_wgs.transform(r['e'] + 10 * np.cos(r['ang']), r['n'] + 10 * np.sin(r['ang'])))
        lid = sum(1 for r in res if r['src'] == 'lidar')
        tally[area] = dict(outlines=len(feats), off_photo=off, over_600=big, under_20=small, gone=gone, no_lidar=nolidar,
                           houses=len(res), lidar_only=lid, pitched=sum(1 for r in res if r['roof'] == 'pitched'))
        print(area, tally[area], flush=True)
        houses += res

    # roof colours at the city square's exposure, quantised to a palette
    have = np.array([h['rgb'] is not None for h in houses])
    raw = np.array([h['rgb'] if h['rgb'] is not None else [128, 128, 128] for h in houses], np.float64) / 255
    graded = lin_to_srgb(srgb_to_lin(raw) * k)
    rng = np.random.default_rng(1)
    pal, idx = kmeans2(graded[have], PALETTE, seed=rng, minit='++', iter=30)
    full = np.zeros(len(houses), np.int64)
    d = ((graded[:, None, :] - pal[None, :, :]) ** 2).sum(2)
    full[:] = np.argmin(d, 1)
    # the houses the photo has no colour for take the nearest palette entry to the median roof
    med = np.median(graded[have], 0)
    full[~have] = int(np.argmin(((pal - med) ** 2).sum(1)))
    for h, i in zip(houses, full):
        h['c'] = int(i)
        h.pop('rgb')
    palette = [[int(round(v * 255)) for v in c] for c in np.clip(pal, 0, 1)]
    json.dump(dict(palette=palette, houses=houses, tally=tally, exposure=k, cover=coverage_grid()), open(os.path.join(WORK, 'houses.json'), 'w'))
    print(f'houses: {len(houses)} (pitched {sum(h["roof"] == "pitched" for h in houses)}, LiDAR-only {sum(h["src"] == "lidar" for h in houses)})', flush=True)
    spot_checks(houses)


# ── Spot checks: the photo's roof under random Devonport houses ──
def spot_checks(houses):
    rng = np.random.default_rng(121)
    cand = [h for h in houses if h['area'] == 'devonport' and h['src'] == 'outline' and 60 <= h['m2'] <= 400 and h['w'] >= 6 and h['d'] >= 6]
    order = rng.permutation(len(cand))
    tree = shapely.STRtree(DEV_OUTLINES)
    checks = []
    for i in order:
        h = cand[i]
        r = photo_roof(h, OUTLINE_OF[h['id']], tree, DEV_OUTLINES)
        if r is None:
            continue
        checks.append(r)
        if len(checks) >= SPOTS:
            break
    json.dump(checks, open(os.path.join(WORK, 'house-spotchecks.json'), 'w'), indent=1)
    off = [c['offset'] for c in checks] or [0.0]
    print(f'spot checks: {len(checks)}; photo roof offset median {np.median(off):.2f} m, max {np.max(off):.2f} m', flush=True)


def photo_offset(photos, e, n, R, tree, polys, min_outlines=6):
    """
    The local offset (east, north m) between the photo and the LINZ outlines round NZTM (e, n), as #120's alignment
    report measures it: the photo's luminance gradient cross-correlated with every outline's edges in a window of
    half-side R (±6 m, sub-pixel peak), on the first mosaic in `photos` that holds the window. None where there are
    too few outlines or no photo.
    """
    from shapely.geometry import box as sbox
    for name in photos:
        p = photo(name)
        if p is None:
            continue
        res = p['res']
        c0, r0 = int((e - R - p['e0']) / res), int((p['n1'] - (n + R)) / res)
        size = int(2 * R / res)
        if c0 < 0 or r0 < 0 or c0 + size >= p['rgb'].shape[1] or r0 + size >= p['rgb'].shape[0]:
            continue
        win = p['rgb'][r0:r0 + size, c0:c0 + size].astype(np.float32)
        if (win.max(2) == 0).mean() > 0.02:
            continue
        near = [polys[k].exterior.buffer(res * 0.5) for k in tree.query(sbox(e - R, n - R, e + R, n + R))]
        if len(near) < min_outlines:
            return None
        lum = ndimage.gaussian_filter(win.mean(2), 0.7)
        grad = np.hypot(ndimage.sobel(lum, 0), ndimage.sobel(lum, 1))
        grad = np.minimum(grad, np.percentile(grad, 99))
        tr = rasterio.transform.from_origin(p['e0'] + c0 * res, p['n1'] - r0 * res, res, res)
        edges = features.rasterize(((mapping(g), 1) for g in near), out_shape=lum.shape, transform=tr, fill=0, dtype='uint8').astype(np.float32)
        edges = ndimage.gaussian_filter(edges, 0.7)
        S = int(np.ceil(6 / res))
        m = S + 1
        core = edges[m:-m, m:-m]

        def score(dx, dy):
            return float((core * grad[m + dy:size - m + dy, m + dx:size - m + dx]).sum())

        sc, dx, dy = max(((score(dx, dy), dx, dy) for dy in range(-S, S + 1) for dx in range(-S, S + 1)))
        fx = fy = 0.0
        if abs(dx) < S:
            a, c = score(dx - 1, dy), score(dx + 1, dy)
            fx = 0.5 * (a - c) / (a - 2 * sc + c) if (a - 2 * sc + c) < 0 else 0.0
        if abs(dy) < S:
            a, c = score(dx, dy - 1), score(dx, dy + 1)
            fy = 0.5 * (a - c) / (a - 2 * sc + c) if (a - 2 * sc + c) < 0 else 0.0
        # the photo content matching an outline edge at pixel q lies at q + (dx, dy) (rows grow southward)
        return (dx + fx) * res, -(dy + fy) * res, len(near), name
    return None


LEAN_CELL = 400.0   # m: the photo-vs-outline offset field's cells
LEAN_WINDOW = 150.0  # m: half-side of each cell's correlation window


def lean_field(area, polys):
    """
    The photo-vs-outline offset over an area, measured every LEAN_CELL m where outlines are dense (photo_offset over a
    2 LEAN_WINDOW m window), as a function (e, n) → (east, north) m: the measured cells within 1.5 cells weighted by
    inverse distance, else the area's median. It moves the houses onto the photo's roofs: the 2024 photo is a standard
    orthophoto (a roof is drawn displaced from its footprint by its height × the camera's lean, ≈ 1 m on a house here)
    and the 2017 outlines carry their own photos' lean.
    """
    tree = shapely.STRtree(polys)
    b = np.array([q.bounds for q in polys])
    pts = []
    for e in np.arange(np.floor(b[:, 0].min() / LEAN_CELL) * LEAN_CELL + LEAN_CELL / 2, b[:, 2].max(), LEAN_CELL):
        for n in np.arange(np.floor(b[:, 1].min() / LEAN_CELL) * LEAN_CELL + LEAN_CELL / 2, b[:, 3].max(), LEAN_CELL):
            if not photo_covers(area, *nztm_to_game(e, n)):
                continue
            r = photo_offset(AREAS[area]['photos'], e, n, LEAN_WINDOW, tree, polys, min_outlines=25)
            if r is not None and np.hypot(r[0], r[1]) < 5.5:
                pts.append((e, n, r[0], r[1]))
    pts = np.array(pts) if pts else np.zeros((0, 4))
    med = (float(np.median(pts[:, 2])), float(np.median(pts[:, 3]))) if len(pts) else (0.0, 0.0)
    print(f'  lean field {area}: {len(pts)} cells, median {med[0]:+.2f} m east, {med[1]:+.2f} m north', flush=True)

    if len(pts) < 5:
        # too few dense blocks to measure (the small islands): left as traced
        return (lambda e, n: (0.0, 0.0)), pts

    def at(e, n):
        d = np.hypot(pts[:, 0] - e, pts[:, 1] - n)
        k = d < 1.5 * LEAN_CELL
        if not k.any():
            return med
        w = 1 / (d[k] + LEAN_CELL / 4) ** 2
        return float((pts[k, 2] * w).sum() / w.sum()), float((pts[k, 3] * w).sum() / w.sum())
    return at, pts


def photo_roof(h, poly, tree, polys):
    """
    Where the photo shows the roof of house h (its LINZ outline `poly`, NZTM): the outline's centroid moved by the
    photo-vs-outline offset of a 100 m window round it (photo_offset). One house alone does not register reliably (a
    gable's lit and shaded slopes make an edge half a roof away, as do shadows and neighbours); its block does. Also
    the LiDAR roof's top (p95 of the nDSM inside the outline shrunk 0.7 m), for the ridge check.
    """
    e, n = poly.centroid.x, poly.centroid.y
    r = photo_offset(AREAS['devonport']['photos'], e, n, 50.0, tree, polys)
    if r is None:
        return None
    de, dn, k, name = r
    lon, lat = to_wgs.transform(e + de, n + dn)
    b = poly.bounds
    E0, N0 = np.floor(b[0] - 3), np.floor(b[1] - 3)
    E1, N1 = np.ceil(b[2] + 3), np.ceil(b[3] + 3)
    nd, _ = lidar_window(E0, N0, E1, N1, AREAS['devonport']['parts'])
    inner = poly.buffer(-0.7, join_style=2)
    mk = features.geometry_mask([mapping(inner if not inner.is_empty else poly)], nd.shape, rasterio.transform.from_origin(E0, N1, 1, 1), invert=True)
    top = float(np.nanpercentile(nd[mk], 95))
    return dict(id=h['id'], lon=round(lon, 8), lat=round(lat, 8), offset=round(float(np.hypot(de, dn)), 2), ridge=round(top, 2), photo=name, outlines=k)


if __name__ == '__main__':
    main()
