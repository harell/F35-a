"""
Real suburbs 5/9 (#124), step 1: the landmark buildings of the theatre (hospitals, railway stations and their
platforms, shopping malls, schools) from OpenStreetMap sites, LINZ building outlines and the 2024 LiDAR.

    python3 tools/linz/landmark-buildings.py fetch [<work dir>]   # OSM sites (Overpass), LINZ outlines per site (WFS)
    python3 tools/linz/landmark-buildings.py bake [<work dir>]    # → <work>/landmarks.json + landmark-spotchecks.json
    npx vite-node tools/linz/landmark-buildings.ts [<work dir>]   # → src/world/terrain/data/auckland-landmarks.bin

Sites (© OpenStreetMap contributors, ODbL; fetched once with Overpass into <work>/osm-<kind>.json, the date is in
each file's osm3s.timestamp_osm_base): areas in the world box (lon 174.31…175.21, lat −37.21…−36.49), multipolygon
relations assembled from their member ways.
  - hospitals: `amenity=hospital` areas of at least HOSPITAL_MIN m² (rest homes and clinics are smaller), and the
    priority list PRIORITY_HOSPITALS whatever their size (checked by hand against the OSM names);
  - malls: `shop=mall` areas of at least MALL_MIN m², and PRIORITY_MALLS;
  - railway stations: `railway=station` (MOTAT's tram stops and heritage lines left out), each with the
    `railway=platform` areas within PLATFORM_REACH m (the nearest station takes a platform; underground ones are
    left out, those in an open cutting at layer −1 kept). The site is the station's own area (if mapped as one) and
    its platforms grown by STATION_PAD m;
  - schools: `amenity=school` areas of at least SCHOOL_MIN m².
Buildings: the LINZ NZ Building Outlines (layer 101290, WFS by site box, cached in <work>/outlines/) whose
representative point is inside a site (a station also takes an outline over one of its platforms: a canopy). An
outline that #121 already ships as a house (its building_id in <work>/../houses/houses.json) is left to #121.
Heights: 1 m nDSM = DSM − DEM of the Auckland 2024 LiDAR (Part 1, then Part 2 where Part 1 has no data: Waiheke),
read per site window from the sheets cached in <work>/../lidar/part<N>/<kind>/ or over HTTP (COG range requests) —
split into levels as the CBD bake does (tools/linz/buildings.py: an Otsu split of the roof heights into connected
upper parts, up to three levels; a level's roof the 90th percentile, or a tilted plane when one fits), with a
smaller step (LEVEL_STEP 5 m, not 8 m: a mall's anchor store over its shops). An outline with nothing standing on it in
2024 is dropped (demolished); one that stands on less than STANDING of its area or holds an open court of COURTYARD m²
is first cut to what stands, its courtyards split out (the game's prisms have no holes). Buildings completed since the 2017 outlines
are traced from the LiDAR inside the site (smooth, compact and straight-edged components ≥ LIDAR_MIN_AREA m² standing
≥ LIDAR_MIN_HEIGHT m outside every outline), as the CBD bake does. A platform canopy (an outline covering a platform
for at least half its area) keeps one level (its roof).

Also every outline over #121's MAX_AREA (600 m²) in #121's areas (Devonport and the gulf islands: its cached
<work>/../houses/outlines-<area>.json), which #121 left to this bake: kind 'other'.

Spot checks (the ±5 m test, as tests/world-buildings.test.ts does for the CBD): per priority hospital and mall the
highest smooth roof (9 × 9 median) inside its buildings, the reference the median raw nDSM within 4 m of it; and a
random sample of one-level outlines over 400 m², the median raw nDSM round a point well inside them.
"""
import concurrent.futures as cf
import json
import os
import subprocess
import sys
import time
import urllib.parse
import urllib.request
import zlib

import numpy as np
import rasterio
from pyproj import Transformer
from rasterio import features
from rasterio.windows import from_bounds
from scipy import ndimage
from shapely.geometry import MultiPoint, Point, Polygon, mapping, shape
from shapely.ops import linemerge, polygonize, unary_union

os.environ.setdefault('GDAL_DISABLE_READDIR_ON_OPEN', 'EMPTY_DIR')
os.environ.setdefault('GDAL_HTTP_MULTIRANGE', 'YES')
os.environ.setdefault('GDAL_HTTP_MAX_RETRY', '4')
os.environ.setdefault('GDAL_HTTP_RETRY_DELAY', '2')
os.environ.setdefault('CPL_VSIL_CURL_CACHE_SIZE', '200000000')

CMD = sys.argv[1] if len(sys.argv) > 1 else 'bake'
WORK = sys.argv[2] if len(sys.argv) > 2 else '/home/user/work/landmarks'
ROOT = os.path.dirname(WORK.rstrip('/'))
LIDAR = os.path.join(ROOT, 'lidar')
STAC = os.path.join(ROOT, 'hero', '_stac')
HOUSES = os.path.join(ROOT, 'houses')
os.makedirs(os.path.join(WORK, 'outlines'), exist_ok=True)

to_wgs = Transformer.from_crs(2193, 4326, always_xy=True)
to_nztm = Transformer.from_crs(4326, 2193, always_xy=True)

BOX = (-37.21, 174.31, -36.49, 175.21)   # world box (S, W, N, E)
OVERPASS = ['https://maps.mail.ru/osm/tools/overpass/api/interpreter', 'https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter']
QUERIES = {
    'hospital': 'nwr["amenity"="hospital"]{b};',
    'mall': 'nwr["shop"="mall"]{b};',
    'station': 'nwr["railway"="station"]{b};',
    'platform': 'nwr["railway"="platform"]{b};',
    'school': 'nwr["amenity"="school"]{b};',
}
S3 = 'https://nz-elevation.s3.ap-southeast-2.amazonaws.com/auckland/auckland-part-{part}_2024/{kind}_1m/2193'

HOSPITAL_MIN = 20000.0   # m²: the public hospitals and the big private ones; rest homes and clinics are smaller
MALL_MIN = 7000.0        # m²
SCHOOL_MIN = 2000.0      # m²
PLATFORM_REACH = 300.0   # m from a station to its platforms
STATION_PAD = 12.0       # m round a station's platforms: its buildings, canopies and footbridges
SITE_PAD = 2.0           # m: an outline's point may sit this far outside the OSM site (volunteer-traced edges)
# checked by hand (2026-10-07) against the OSM names of the issue's list (#124)
PRIORITY_HOSPITALS = ['Auckland City Hospital', 'Middlemore Hospital', 'North Shore Hospital', 'Waitākere Hospital', 'Greenlane Clinical Centre']
PRIORITY_MALLS = ['Sylvia Park', 'Westfield Saint Lukes', 'Westfield Newmarket', 'Westfield Albany', 'Westfield Manukau City', 'LynnMall', 'NorthWest Shopping Centre']

SIMPLIFY = 0.5      # m, Douglas–Peucker on the outlines (as the CBD bake)
MIN_AREA = 30.0     # m²: sheds and kiosks are dropped (as the CBD bake)
MIN_HEIGHT = 2.5    # m: lower than this in 2024 = gone
LIDAR_MIN_AREA = 150.0
LIDAR_MIN_HEIGHT = 5.0
HOUSE_MAX_AREA = 600.0  # m²: #121's MAX_AREA (tools/linz/houses.py)
SITE_SIMPLIFY = 2.0     # m on the shipped site outlines
COURTYARD = 40.0        # m²: an open court this big inside an outline is cut out
STANDING = 0.75         # share of an outline standing MIN_HEIGHT below which it is cut to what stands
LEVEL_STEP = 5.0        # m: an upper level this much above the rest (and a fifth of its height) is its own prism (the
                        # CBD bake's 8 m merged a mall's 14 m anchor store into its 6 m shops)


# ── OSM ──
def overpass(kind):
    out = os.path.join(WORK, f'osm-{kind}.json')
    if os.path.exists(out):
        return
    b = f'({BOX[0]},{BOX[1]},{BOX[2]},{BOX[3]})'
    q = f'[out:json][timeout:180];({QUERIES[kind].format(b=b)});out body geom;'
    for attempt in range(8):
        url = OVERPASS[attempt % len(OVERPASS)]
        try:
            r = urllib.request.urlopen(url + '?' + urllib.parse.urlencode({'data': q}), timeout=300).read()
            json.loads(r)
            open(out, 'wb').write(r)
            print(f'osm {kind}: {len(r)} bytes from {url}', flush=True)
            return
        except Exception as e:  # noqa: BLE001 — Overpass mirrors are flaky: retry, then the next one
            print(f'osm {kind}: {url}: {e}', flush=True)
            time.sleep(10)
    sys.exit(f'Overpass failed for {kind}')


def osm(kind):
    return json.load(open(os.path.join(WORK, f'osm-{kind}.json')))


def ring_nztm(geom):
    return [to_nztm.transform(p['lon'], p['lat']) for p in geom]


def area_of(e):
    """The element's area as an NZTM polygon (multipolygon relations assembled), or None."""
    if e['type'] == 'way' and 'geometry' in e:
        pts = ring_nztm(e['geometry'])
        if len(pts) >= 4 and pts[0] == pts[-1]:
            p = Polygon(pts).buffer(0)
            return p if not p.is_empty else None
        return None
    if e['type'] == 'relation':
        from shapely.geometry import LineString
        outer, inner = [], []
        for m in e.get('members', []):
            if m.get('type') != 'way' or 'geometry' not in m:
                continue
            (inner if m.get('role') == 'inner' else outer).append(LineString(ring_nztm(m['geometry'])))
        if not outer:
            return None
        polys = list(polygonize(linemerge(outer)))
        if not polys:
            return None
        p = unary_union(polys)
        if inner:
            holes = list(polygonize(linemerge(inner)))
            if holes:
                p = p.difference(unary_union(holes))
        p = p.buffer(0)
        return p if not p.is_empty else None
    return None


def centre_of(e):
    if e['type'] == 'node':
        return Point(to_nztm.transform(e['lon'], e['lat']))
    a = area_of(e)
    if a is not None:
        return a.representative_point()
    if 'geometry' in e:
        return MultiPoint(ring_nztm(e['geometry'])).centroid
    b = e.get('bounds')
    return Point(to_nztm.transform((b['minlon'] + b['maxlon']) / 2, (b['minlat'] + b['maxlat']) / 2)) if b else None


def sites():
    """[{kind, name, osm, poly (NZTM), platforms: [poly]}], the order kinds win in (a building in two sites)."""
    out = []
    tally = {}
    # hospitals and malls
    for kind, minimum, priority in (('hospital', HOSPITAL_MIN, PRIORITY_HOSPITALS), ('mall', MALL_MIN, PRIORITY_MALLS)):
        found = set()
        for e in osm(kind)['elements']:
            t = e.get('tags', {})
            name = t.get('name', '')
            a = area_of(e)
            if a is None:
                continue
            if a.area >= minimum or name in priority:
                out.append(dict(kind=kind, name=name, osm=f"{e['type']}/{e['id']}", poly=a, platforms=[]))
                if name in priority:
                    found.add(name)
        missing = [n for n in priority if n not in found]
        if missing:
            sys.exit(f'priority {kind} not found in OSM: {missing}')
        tally[kind] = sum(1 for s in out if s['kind'] == kind)
    # railway stations and their platforms
    stations = []
    for e in osm('station')['elements']:
        t = e.get('tags', {})
        if t.get('railway') != 'station' or t.get('usage') == 'tourism' or 'MOTAT' in t.get('operator', '') or 'Transport And Technology' in t.get('operator', ''):
            continue
        if t.get('location') == 'underground' or t.get('station') == 'subway':
            continue
        c = centre_of(e)
        if c is None:
            continue
        name = t.get('name', '')
        key = name.lower().replace(' station', '').strip()
        if any(s['key'] == key and s['centre'].distance(c) < 600 for s in stations):
            continue
        stations.append(dict(key=key, name=name, osm=f"{e['type']}/{e['id']}", centre=c, poly=area_of(e), platforms=[]))
    under = 0
    unassigned = 0
    for e in osm('platform')['elements']:
        t = e.get('tags', {})
        # (a platform in an open cutting is layer −1: New Lynn, Panmure; one in a tunnel or a station box is below that)
        if t.get('location') in ('underground', 'tunnel') or t.get('tunnel') == 'yes' or int(t.get('layer', '0') or 0) < -1:
            under += 1
            continue
        a = area_of(e)
        if a is None and 'geometry' in e:
            from shapely.geometry import LineString
            a = LineString(ring_nztm(e['geometry'])).buffer(float(t.get('width', 6)) / 2, cap_style=2)
        if a is None:
            continue
        near = min(stations, key=lambda s: s['centre'].distance(a), default=None)
        if near is None or near['centre'].distance(a) > PLATFORM_REACH:
            unassigned += 1
            continue
        near['platforms'].append(a)
    for s in stations:
        parts = [p.buffer(STATION_PAD, join_style=2) for p in s['platforms']]
        if s['poly'] is not None:
            parts.append(s['poly'])
        if not parts:
            parts.append(s['centre'].buffer(30))
        out.append(dict(kind='station', name=s['name'], osm=s['osm'], poly=unary_union(parts).buffer(0), platforms=s['platforms'], centre=s['centre']))
    tally['station'] = len(stations)
    tally['platform'] = sum(len(s['platforms']) for s in stations)
    tally['platform_underground'] = under
    tally['platform_no_station'] = unassigned
    # schools
    n = 0
    for e in osm('school')['elements']:
        a = area_of(e)
        if a is None or a.area < SCHOOL_MIN:
            continue
        out.append(dict(kind='school', name=e.get('tags', {}).get('name', ''), osm=f"{e['type']}/{e['id']}", poly=a, platforms=[]))
        n += 1
    tally['school'] = n
    for i, s in enumerate(out):
        s['id'] = i
    return out, tally


# ── LINZ outlines ──
def outlines_for(site):
    """LINZ outlines (NZTM GeoJSON features) in the site's box + 30 m, cached per site."""
    out = os.path.join(WORK, 'outlines', site['osm'].replace('/', '-') + f"-{site['kind']}.json")
    if not os.path.exists(out):
        key = os.environ.get('LINZ_API_KEY')
        if not key:
            sys.exit(f'{out} is not cached and LINZ_API_KEY is not set')
        e0, n0, e1, n1 = site['poly'].bounds
        q = {'service': 'WFS', 'version': '2.0.0', 'request': 'GetFeature', 'outputFormat': 'json', 'srsName': 'EPSG:2193',
             'typeNames': 'layer-101290', 'cql_filter': f'BBOX(shape,{n0 - 30},{e0 - 30},{n1 + 30},{e1 + 30})',
             'propertyName': 'shape,building_id'}
        args = ['curl', '-sSfG', '--retry', '5', '--retry-delay', '3', f'https://data.linz.govt.nz/services;key={key}/wfs']
        for k, v in q.items():
            args += ['--data-urlencode', f'{k}={v}']
        subprocess.run(args + ['-o', out + '.part'], check=True)
        os.replace(out + '.part', out)
    return json.load(open(out))['features']


def fetch():
    for k in QUERIES:
        overpass(k)
    ss, tally = sites()
    print(tally, flush=True)
    with cf.ThreadPoolExecutor(6) as ex:
        n = sum(len(f) for f in ex.map(outlines_for, ss))
    print(f'outlines cached for {len(ss)} sites ({n} features)', flush=True)


# ── LiDAR ──
_stac = {}


def stac_items(part, kind):
    if (part, kind) not in _stac:
        path = os.path.join(STAC, S3.format(part=part, kind=kind).replace('https://', '').replace('/', '_') + '.json')
        if not os.path.exists(path):
            sys.path.insert(0, os.path.join(os.path.dirname(__file__), '../hero'))
            import site as hero_site  # noqa: E402 — tools/hero/site.py builds the STAC cache
            hero_site.stac_tiles(S3.format(part=part, kind=kind), (0, 0, 0, 0), STAC)
        _stac[(part, kind)] = json.load(open(path))
    return _stac[(part, kind)]


def lidar_window(E0, N0, E1, N1):
    """(DSM, DEM) over the box at 1 m, north-up; Part 1 first, Part 2 where it has no data."""
    W, H = int(E1 - E0), int(N1 - N0)
    lo0, la0 = to_wgs.transform(E0, N0)
    lo1, la1 = to_wgs.transform(E1, N1)
    res = {}
    for kind in ('dsm', 'dem'):
        mos = np.full((H, W), np.nan, np.float32)
        for part in (1, 2):
            if part == 2 and not np.isnan(mos).any():
                break
            for it in stac_items(part, kind):
                b = it['bbox']
                if not (b[0] < lo1 and b[2] > lo0 and b[1] < la1 and b[3] > la0):
                    continue
                for t in it['tif']:
                    name = t.split('/')[-1]
                    local = os.path.join(LIDAR, f'part{part}', kind, name)
                    src = local if os.path.exists(local) else '/vsicurl/' + S3.format(part=part, kind=kind) + '/' + name
                    for attempt in range(4):
                        try:
                            with rasterio.open(src) as s:
                                bb = s.bounds
                                ix0, ix1 = max(bb.left, E0), min(bb.right, E1)
                                iy0, iy1 = max(bb.bottom, N0), min(bb.top, N1)
                                if ix0 >= ix1 or iy0 >= iy1:
                                    break
                                a = s.read(1, window=from_bounds(ix0, iy0, ix1, iy1, s.transform), masked=True).astype(np.float32).filled(np.nan)
                            r0, c0 = int(round(N1 - iy1)), int(round(ix0 - E0))
                            sub = mos[r0:r0 + a.shape[0], c0:c0 + a.shape[1]]
                            a = a[:sub.shape[0], :sub.shape[1]]
                            m = ~np.isnan(a) & np.isnan(sub)
                            sub[m] = a[m]
                            break
                        except rasterio.errors.RasterioIOError as e:
                            if attempt == 3:
                                raise
                            print(f'retry {name}: {e}', flush=True)
                            time.sleep(3 * (attempt + 1))
        res[kind] = mos
    return res['dsm'], res['dem']


# ── Heights (tools/linz/buildings.py's level split, on a window) ──
class Win:
    def __init__(self, E0, N1, nd):
        self.E0, self.N1, self.nd = E0, N1, nd
        self.transform = rasterio.transform.from_origin(E0, N1, 1.0, 1.0)

    def px(self, rows, cols):
        return self.E0 + cols + 0.5, self.N1 - rows - 0.5


def clean(poly):
    if poly is None or poly.is_empty:
        return None
    if poly.geom_type != 'Polygon':
        geoms = [g for g in getattr(poly, 'geoms', []) if g.geom_type == 'Polygon']
        if not geoms:
            return None
        poly = max(geoms, key=lambda g: g.area)
    p = Polygon(poly.exterior).buffer(0).simplify(SIMPLIFY, preserve_topology=True)
    if p.geom_type != 'Polygon' or p.area < MIN_AREA:
        return None
    return p


def otsu(v):
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


def roof(W, poly, rr, cc, v):
    flat = float(np.percentile(v, 90))
    if len(v) < 100 or np.std(v) < 2.0:
        return flat, 0.0, 0.0
    e, n = W.px(rr, cc)
    c = poly.centroid
    A = np.column_stack([np.ones(len(v)), e - c.x, n - c.y])
    keep = np.ones(len(v), bool)
    for _ in range(3):
        coef, *_ = np.linalg.lstsq(A[keep], v[keep], rcond=None)
        res = v - A @ coef
        keep = np.abs(res) < max(1.0, 2.0 * np.std(res[keep]))
    rms = float(np.sqrt(np.mean(res[keep] ** 2)))
    grad = float(np.hypot(coef[1], coef[2]))
    if grad < 0.1 or grad > 1.2 or rms > 0.35 * np.std(v) or keep.mean() < 0.8:
        return flat, 0.0, 0.0
    return float(coef[0]), float(coef[1]), float(-coef[2])


def levels(W, poly, rr, cc, v, depth, max_depth=2):
    if len(v) < 4:
        return []
    thr = otsu(v) if depth < max_depth else float('inf')
    upper = v > thr
    split = upper.sum() >= 60 and (~upper).sum() >= max(30, 0.08 * len(v))
    if split:
        mu, ml = float(v[upper].mean()), float(v[~upper].mean())
        split = mu - ml >= max(LEVEL_STEP, 0.2 * mu)
    if not split:
        h, sx, sz = roof(W, poly, rr, cc, v)
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
        if sel.sum() < 60:
            continue
        cx, cy = W.px(rr[sel], cc[sel])
        hull = MultiPoint(np.column_stack([cx, cy])).convex_hull.buffer(0.5, join_style=2)
        part = clean(hull.intersection(poly))
        if part is None:
            continue
        parts += levels(W, part, rr[sel], cc[sel], v[sel], depth + 1, max_depth)
        taken |= sel
    if not parts:
        h, sx, sz = roof(W, poly, rr, cc, v)
        return [(poly, h, sx, sz)] if h >= MIN_HEIGHT else []
    rest = ~taken & ~upper
    base_h = float(np.percentile(v[rest], 75)) if rest.sum() >= 12 else 0.0
    base = [(poly, base_h, 0.0, 0.0)] if base_h >= MIN_HEIGHT else []
    return base + parts


def pixels(W, mask_poly):
    """Rows, cols and nDSM values of the pixels inside a polygon (1 m inside it when there are enough)."""
    m = features.geometry_mask([mapping(mask_poly)], W.nd.shape, W.transform, invert=True)
    inner = ndimage.binary_erosion(m, iterations=1)
    use = inner if inner.sum() >= 12 else m
    rr, cc = np.nonzero(use)
    v = W.nd[rr, cc]
    ok = ~np.isnan(v)
    return rr[ok], cc[ok], v[ok]


def parts_of(W, poly, single=False):
    """
    The prisms of one outline. Where less than STANDING of it stands MIN_HEIGHT in 2024 (a wing demolished since the
    2017 outline, a covered court or a car park traced with the building), the outline is first cut to what stands:
    the standing pixels closed and opened by a metre, as polygons inside the outline.
    """
    rr, cc, v = pixels(W, poly)
    if len(v) < 4:
        return []
    depth = 0 if single else 2
    up = v >= MIN_HEIGHT
    # an open courtyard or light well inside the outline (≥ COURTYARD m² after a 2 m opening)
    low = np.zeros(W.nd.shape, bool)
    low[rr[~up], cc[~up]] = True
    court = ndimage.binary_opening(low, iterations=2).sum() >= COURTYARD
    if len(v) >= 50 and (up.mean() < STANDING or court):
        m = np.zeros(W.nd.shape, bool)
        m[rr[up], cc[up]] = True
        m = ndimage.binary_opening(ndimage.binary_closing(m, iterations=1), iterations=1)
        if not m.any():
            return []
        geoms = [shape(g) for g, val in features.shapes(m.astype(np.uint8), mask=m, transform=W.transform) if val == 1]
        cut = unary_union(geoms).intersection(poly) if geoms else None
        out = []
        for g in (getattr(cut, 'geoms', [cut]) if cut is not None else []):
            if g.geom_type != 'Polygon':
                continue
            for h in no_holes(g.simplify(1.0)):
                q = clean(h)
                if q is None:
                    continue
                r2, c2, v2 = pixels(W, q)
                if len(v2) >= 4:
                    out += levels(W, q, r2, c2, v2, 0, depth)
        return out
    return levels(W, poly, rr, cc, v, 0, depth)


def no_holes(p, depth=0):
    """A polygon with courtyards as pieces without (the game's prisms have none): cut across each courtyard."""
    from shapely.geometry import LineString
    from shapely.ops import split
    if p.is_empty or p.geom_type != 'Polygon':
        return []
    holes = [h for h in p.interiors if Polygon(h).area >= 4]
    if not holes or depth > 8:
        return [Polygon(p.exterior)]
    c = Polygon(holes[0]).centroid
    e0, n0, e1, n1 = p.bounds
    x0, y0, x1, y1 = Polygon(holes[0]).bounds
    # across the courtyard's shorter side
    line = LineString([(c.x, n0 - 1), (c.x, n1 + 1)]) if (x1 - x0) <= (y1 - y0) else LineString([(e0 - 1, c.y), (e1 + 1, c.y)])
    out = []
    for g in split(p, line).geoms:
        out += no_holes(g, depth + 1)
    return out


def lidar_only(W, polys, area):
    """Footprints traced from the LiDAR inside `area` (new since 2017): the CBD bake's test, from LIDAR_MIN_HEIGHT."""
    nd = W.nd
    ndz = np.nan_to_num(nd, nan=0.0)
    lab = features.rasterize(((mapping(p), 1) for p in polys), out_shape=nd.shape, transform=W.transform, fill=0, dtype='uint8') if polys else np.zeros(nd.shape, np.uint8)
    inside = features.geometry_mask([mapping(area)], nd.shape, W.transform, invert=True)
    mean = ndimage.uniform_filter(ndz, 3)
    sq = ndimage.uniform_filter(ndz * ndz, 3)
    rough = np.sqrt(np.maximum(0.0, sq - mean * mean))
    covered = ndimage.binary_dilation(lab > 0, iterations=3)
    smooth = ndimage.median_filter(rough, 5) < 0.5
    cand = (ndz >= LIDAR_MIN_HEIGHT) & smooth & ~covered & inside
    cand = ndimage.binary_opening(cand, iterations=2)
    cand = ndimage.binary_closing(cand, iterations=2)
    comp, n = ndimage.label(cand)
    if n == 0:
        return []
    sizes = ndimage.sum(cand, comp, range(1, n + 1))
    by = {}
    for geom, val in features.shapes(comp.astype(np.int32), mask=cand, transform=W.transform):
        by.setdefault(int(val), []).append(shape(geom))
    out = []
    for c, geoms in by.items():
        if sizes[c - 1] < LIDAR_MIN_AREA:
            continue
        p = clean(unary_union(geoms).simplify(1.0))
        if p is None or p.area < LIDAR_MIN_AREA:
            continue
        mrr = p.minimum_rotated_rectangle
        if p.area / mrr.area < 0.45 or p.length / mrr.length > 1.15:
            continue
        out.append(p)
    return out


def ring_lonlat(p):
    xs, ys = p.exterior.coords.xy
    lon, lat = to_wgs.transform(np.array(xs[:-1]), np.array(ys[:-1]))
    return [[round(a, 8), round(b, 8)] for a, b in zip(lon, lat)]


def house_ids():
    p = os.path.join(HOUSES, 'houses.json')
    if not os.path.exists(p):
        return set()
    return {h['id'] for h in json.load(open(p))['houses'] if h.get('src') == 'outline'}


def process(site, taken_ids, houses):
    """Buildings of one site: [{id, src, canopy, parts}] and its spot checks."""
    feats = outlines_for(site) if site['kind'] != 'other' else site['features']
    area = site['poly'].buffer(SITE_PAD)
    plats = unary_union([p.buffer(1.0) for p in site['platforms']]) if site['platforms'] else None
    polys = []
    for f in feats:
        bid = f['properties'].get('building_id')
        if bid in houses:
            continue
        p = clean(shape(f['geometry']))
        if p is None:
            continue
        inside = area.contains(p.representative_point())
        over = plats is not None and p.intersects(plats) and p.intersection(plats).area >= 0.5 * p.area
        if not (inside or over):
            continue
        polys.append((bid, p, over))
    e0, n0, e1, n1 = unary_union([area] + [p for _, p, _ in polys]).bounds
    E0, N0, E1, N1 = np.floor(e0) - 6, np.floor(n0) - 6, np.ceil(e1) + 6, np.ceil(n1) + 6
    dsm, dem = lidar_window(E0, N0, E1, N1)
    W = Win(E0, N1, dsm - dem)
    out = []
    dropped = 0
    for bid, p, canopy in polys:
        if bid in taken_ids:
            continue
        parts = parts_of(W, p, single=canopy)
        if not parts:
            dropped += 1
            continue
        out.append({'id': bid, 'src': 'outline', 'canopy': canopy, 'parts': parts})
    if site['kind'] != 'other':
        for p in lidar_only(W, [p for _, p, _ in polys], site['poly']):
            parts = parts_of(W, p)
            if parts:
                out.append({'id': -1, 'src': 'lidar', 'canopy': False, 'parts': parts})
    checks = spot_checks(site, W, out)
    return out, dropped, checks


def ref(W, r, c, rad=4):
    yy, xx = np.mgrid[-rad:rad + 1, -rad:rad + 1]
    w = W.nd[r - rad:r + rad + 1, c - rad:c + rad + 1]
    if w.shape != yy.shape:
        return None
    w = w[np.hypot(yy, xx) <= rad]
    return None if np.isnan(w).mean() > 0.3 else round(float(np.nanmedian(w)), 2)


def spot_checks(site, W, buildings):
    checks = []
    if not buildings:
        return checks
    if site['name'] in PRIORITY_HOSPITALS + PRIORITY_MALLS:
        # the highest smooth roof of the site's buildings (not a mast or a crane)
        m = features.geometry_mask([mapping(p) for b in buildings for p, *_ in b['parts']], W.nd.shape, W.transform, invert=True)
        med = ndimage.median_filter(np.nan_to_num(W.nd, nan=0.0), 9)
        med[~ndimage.binary_erosion(m, iterations=5)] = 0
        r, c = np.unravel_index(np.argmax(med), med.shape)
        v = ref(W, r, c)
        if v is not None:
            e, n = W.px(r, c)
            lon, lat = to_wgs.transform(e, n)
            checks.append({'name': f"{site['name']} (top)", 'kind': site['kind'], 'lon': round(float(lon), 8), 'lat': round(float(lat), 8), 'lidar': v, 'peak': round(float(med[r, c]), 2)})
    rng = np.random.default_rng(zlib.crc32(site['osm'].encode()))
    single = [b for b in buildings if b['src'] == 'outline' and not b['canopy'] and len(b['parts']) == 1 and b['parts'][0][0].area > 400]
    for k in rng.permutation(len(single))[:2]:
        p = single[k]['parts'][0][0]
        q = p.buffer(-4)
        q = q.representative_point() if not q.is_empty else p.representative_point()
        c, r = int(q.x - W.E0), int(W.N1 - q.y)
        v = ref(W, r, c, 3)
        if v is None:
            continue
        lon, lat = to_wgs.transform(q.x, q.y)
        checks.append({'name': f"{site['kind']} {single[k]['id']}", 'kind': site['kind'], 'lon': round(float(lon), 8), 'lat': round(float(lat), 8), 'lidar': v})
    return checks


def other_sites(ss):
    """#121's areas: every outline over HOUSE_MAX_AREA not inside a landmark site, one pseudo-site per 1 km tile."""
    from shapely.strtree import STRtree
    tree = STRtree([s['poly'] for s in ss])
    tiles = {}
    seen = set()
    for f in sorted(os.listdir(HOUSES)):
        if not (f.startswith('outlines-') and f.endswith('.json')):
            continue
        for feat in json.load(open(os.path.join(HOUSES, f)))['features']:
            p = shape(feat['geometry'])
            bid = feat['properties'].get('building_id')
            if bid in seen or p.area <= HOUSE_MAX_AREA:
                continue
            seen.add(bid)
            q = p.representative_point()
            if any(ss[i]['poly'].buffer(SITE_PAD).contains(q) for i in tree.query(q)):
                continue
            k = (int(q.x // 1000), int(q.y // 1000))
            tiles.setdefault(k, []).append(feat)
    out = []
    for (i, j), feats in sorted(tiles.items()):
        poly = unary_union([shape(f['geometry']) for f in feats]).buffer(3)
        out.append(dict(kind='other', name='', osm=f'tile/{i}_{j}', poly=poly, platforms=[], features=feats))
    return out


def bake():
    ss, tally = sites()
    print(tally, flush=True)
    others = other_sites(ss)
    print(f'other: {sum(len(o["features"]) for o in others)} outlines over {HOUSE_MAX_AREA:.0f} m² in #121\'s areas, {len(others)} tiles', flush=True)
    allsites = ss + others
    for i, s in enumerate(allsites):
        s['id'] = i
    houses = house_ids()
    t0 = time.time()
    results = [None] * len(allsites)
    # a building is its first site's (hospitals, malls, stations, schools, then the rest): sites in that order, but the
    # LiDAR reads run in parallel; ownership is settled afterwards
    with cf.ThreadPoolExecutor(8) as ex:
        futs = {ex.submit(process, s, set(), houses): i for i, s in enumerate(allsites)}
        for k, fu in enumerate(cf.as_completed(futs)):
            results[futs[fu]] = fu.result()
            if k % 50 == 0:
                print(f'  {k}/{len(allsites)} sites, {time.time() - t0:.0f} s', flush=True)
    owned = set()
    buildings = []
    checks = []
    gone = 0
    for s, (bs, dropped, ch) in zip(allsites, results):
        gone += dropped
        n0 = len(buildings)
        for b in bs:
            if b['id'] != -1 and b['id'] in owned:
                continue
            if b['id'] != -1:
                owned.add(b['id'])
            buildings.append({'site': s['id'], 'id': b['id'], 'src': b['src'], 'canopy': b['canopy'],
                              'parts': [{'ring': ring_lonlat(p), 'h': round(h, 2), 'sx': round(sx, 3), 'sz': round(sz, 3)} for p, h, sx, sz in b['parts']]})
        s['n'] = len(buildings) - n0
        checks += ch
    out_sites = []
    for s in allsites:
        parts = sorted([g for g in getattr(s['poly'], 'geoms', [s['poly']]) if g.geom_type == 'Polygon'], key=lambda g: -g.area)
        rings = [ring_lonlat(Polygon(g.exterior).simplify(SITE_SIMPLIFY, preserve_topology=True)) for g in parts if g.area >= 200]
        out_sites.append({'kind': s['kind'], 'name': s['name'], 'osm': s['osm'], 'ring': rings[0], 'more': rings[1:], 'm2': round(s['poly'].area),
                          'platforms': [ring_lonlat(p if p.geom_type == 'Polygon' else max(p.geoms, key=lambda g: g.area)) for p in s['platforms']],
                          'buildings': s['n'], **({'centre': list(to_wgs.transform(s['centre'].x, s['centre'].y))} if 'centre' in s else {})})
    stamps = {k: osm(k)['osm3s']['timestamp_osm_base'] for k in QUERIES}
    json.dump({'osm': stamps, 'tally': tally, 'sites': out_sites, 'buildings': buildings}, open(os.path.join(WORK, 'landmarks.json'), 'w'))
    json.dump(checks, open(os.path.join(WORK, 'landmark-spotchecks.json'), 'w'), indent=1)
    by = {}
    for b in buildings:
        k = allsites[b['site']]['kind']
        by[k] = by.get(k, 0) + 1
    print(f'buildings: {len(buildings)} {by} ({sum(1 for b in buildings if b["src"] == "lidar")} traced from the LiDAR, '
          f'{sum(1 for b in buildings if b["canopy"])} canopies, {gone} outlines gone in 2024), {len(checks)} spot checks, {time.time() - t0:.0f} s')


if __name__ == '__main__':
    {'fetch': fetch, 'bake': bake}[CMD]()
