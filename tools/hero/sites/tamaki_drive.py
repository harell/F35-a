"""
F35-A — the Tāmaki Drive waterfront strip: the shared path, cycleway and footpaths on both sides of the road,
the seawall and rock embankment, railings, light poles and trees, measured along the 8.2 km from The Strand to
St Heliers. It's the first thing a player sees where the harbour ends and the land begins.

A long linear site, so not the kit and not a box: like the Harbour Bridge, everything is measured in sections along
one axis (Tāmaki Drive's carriageway, west → east), 5 m apart. Offsets are across the axis, negative = harbour side.

  python3 tools/hero/sites/tamaki_drive.py fetch     # OSM (4 tiles), LiDAR 1 m DSM/DEM, 7.5 cm aerial in 250 m chunks,
                                                     # the classified point cloud within 45 m of the axis (~4 min)
  python3 tools/hero/sites/tamaki_drive.py measure   # sections, profiles, path edges, seawall, poles, trees (~3 min)
  python3 tools/hero/sites/tamaki_drive.py model     # → model.json (site frame) + a ledger of the numbers
Everything lands in /tmp/hero/tamaki (--out).

What each part rests on:
  paths      OSM centrelines ("Tāmaki Drive Shared Path", "Tāmaki Drive Cycleway", sidewalks; ±1–2 m), re-centred and
             widened to the strongest colour edges either side of them in the aerial (median over 45 m; ±0.5–1 m)
  seawall    the LiDAR DEM across each section: crest = where the ground drops 0.4 m below path level going seaward,
             toe = the flattened water (−1.14 m at the flight) or where the slope levels out on a beach; rock vs
             concrete from the aerial's texture over the face (std > 10 = basalt boulders)
  railings   OSM barrier=fence lines along the crest (Hobson Bay, Okahu Bay); 1.1 m post-and-rail (Mapillary)
  poles      the point cloud: LINZ classes lamp poles as 18 (high noise) or 1, so clusters of those 3–17 m above the DEM,
             narrower than 9 m, taller than 9.5 m (the rail catenary masts on the causeway are ~7 m), arm = the head's
             offset from the shaft
  trees      one crown per LiDAR tree (the Domain recipe: nDSM > 2.5 m off buildings, tops, watershed) inside the strip
             from the seawall toe to 4 m past the land-side path; colour from the aerial
Data: LINZ LiDAR + aerial (CC BY 4.0), © OpenStreetMap contributors (ODbL), Mapillary contributors (CC BY-SA 4.0).
"""
import argparse, concurrent.futures as cf, glob, heapq, importlib.util, json, math, os, re, urllib.request
import xml.etree.ElementTree as ET
from collections import defaultdict

import numpy as np
from PIL import Image
from pyproj import Transformer
from scipy import ndimage
from scipy.ndimage import map_coordinates, median_filter, uniform_filter1d
from scipy.spatial import cKDTree
from shapely import contains_xy
from shapely.geometry import LineString, Point, Polygon, box
from shapely.ops import unary_union

Image.MAX_IMAGE_PIXELS = None
HERE = os.path.dirname(os.path.abspath(__file__))
_sp = importlib.util.spec_from_file_location('hero_site', os.path.join(HERE, '..', 'site.py'))
hs = importlib.util.module_from_spec(_sp); _sp.loader.exec_module(hs)

BOX = (1758900, 5919750, 1765900, 5920950)          # NZTM E0, N0, E1, N1: The Strand to St Heliers
OSM_TILES = ['174.775,-36.858,174.800,-36.842', '174.800,-36.858,174.825,-36.842',
             '174.825,-36.858,174.850,-36.842', '174.850,-36.858,174.870,-36.842']
CHUNK, AER_RES = 250, 0.15
STEP = 5.0                                          # section spacing, m
WATER = -1.14                                       # the LiDAR's flattened sea at the flight, m NZVD2016
LAZ = 'https://opentopography.s3.sdsc.edu/pc-bulk/NZ24_Auckland/'
tr = Transformer.from_crs(4326, 2193, always_xy=True)

# Surface colours (sRGB), read off unshaded aerial pixels and checked against Mapillary: the per-section medians
# are pulled green-grey by tree shade, so they only pick between these.
SURF = {'asphalt': [92, 96, 99], 'concrete': [184, 180, 170], 'paving': [168, 158, 146], 'grass': [104, 128, 72],
        'road': [72, 75, 78], 'rock': [74, 76, 72], 'seawall': [150, 148, 140], 'sand': [196, 182, 150]}


# ───────────────────────── fetch ─────────────────────────

def fetch(out):
    os.makedirs(out, exist_ok=True)
    for t in OSM_TILES:
        p = f"{out}/osm_{t.replace(',', '_')}.xml"
        if not os.path.exists(p):
            req = urllib.request.Request(f'https://api.openstreetmap.org/api/0.6/map?bbox={t}', headers={'User-Agent': 'F35-A-hero-buildings/1.0'})
            open(p, 'wb').write(urllib.request.urlopen(req, timeout=180).read())
    E0, N0, E1, N1 = BOX
    lo0, la0 = hs.to_wgs.transform(E0, N0); lo1, la1 = hs.to_wgs.transform(E1, N1)
    bbox = (lo0, la0, lo1, la1)
    if not os.path.exists(f'{out}/lidar.npz'):
        lid, tiles = {}, {}
        for kind in ('dsm', 'dem'):
            urls = hs.stac_tiles(hs.ELEV.format(part=1, kind=kind), bbox, '/tmp/hero/_stac')
            tiles[kind] = [u.rsplit('/', 1)[1] for u in urls]
            lid[kind] = hs.mosaic(urls, E0, N0, E1, N1, 1.0, 1)
        np.savez_compressed(f'{out}/lidar.npz', dsm=lid['dsm'], dem=lid['dem'], box=np.array(BOX))
    osm_corridor(out)
    sections(out)
    ax = LineString(json.load(open(f'{out}/sections.json'))['axis'])
    buf = ax.buffer(70)
    os.makedirs(f'{out}/aer', exist_ok=True)
    for e in range(E0, E1, CHUNK):
        for n in range(N0, N1, CHUNK):
            fn = f'{out}/aer/{e}_{n}.jpg'
            if os.path.exists(fn) or not box(e, n, e + CHUNK, n + CHUNK).intersects(buf):
                continue
            a0, b0 = hs.to_wgs.transform(e, n); a1, b1 = hs.to_wgs.transform(e + CHUNK, n + CHUNK)
            img = hs.mosaic(hs.stac_tiles(hs.AERIAL, (a0, b0, a1, b1), '/tmp/hero/_stac'), e, n, e + CHUNK, n + CHUNK, AER_RES, 3)
            Image.fromarray(img).save(fn, quality=88)
    fetch_points(out, ax.buffer(45))


def fetch_points(out, buf):
    """The classified point cloud within `buf`, one compressed npz per 1:1000 tile (the LAZ itself is not kept)."""
    import laspy
    items = json.load(open(glob.glob('/tmp/hero/_stac/*imagery*0.075m*')[0]))
    names = set()
    for it in items:
        for t in it['tif']:
            m = re.search(r'(BA\d\d)_1000_(\d{4})', t)
            b = it['bbox']; e0, n0 = tr.transform(b[0], b[1]); e1, n1 = tr.transform(b[2], b[3])
            if m and box(e0, n0, e1, n1).intersects(buf):
                names.add(f'CL2_{m.group(1)}_2024_1000_{m.group(2)}.laz')
    os.makedirs(f'{out}/pc', exist_ok=True); os.makedirs('/tmp/hero/_laz', exist_ok=True)

    def one(n):
        dst = f'{out}/pc/{n[:-4]}.npz'
        if os.path.exists(dst):
            return
        p = f'/tmp/hero/_laz/{n}'
        if not os.path.exists(p):
            urllib.request.urlretrieve(LAZ + n, p + '.part'); os.rename(p + '.part', p)
        las = laspy.read(p)
        x, y = np.asarray(las.x), np.asarray(las.y)
        m = contains_xy(buf, x, y)
        np.savez_compressed(dst, x=x[m], y=y[m], z=np.asarray(las.z)[m].astype(np.float32), c=np.asarray(las.classification)[m],
                            i=np.asarray(las.intensity)[m])
        os.remove(p)

    with cf.ThreadPoolExecutor(4) as ex:
        list(ex.map(one, sorted(names)))


# ───────────────────────── OSM and the axis ─────────────────────────

def load_osm(out):
    nodes, ways, ntags = {}, {}, {}
    for f in sorted(glob.glob(f'{out}/osm_*.xml')):
        r = ET.parse(f).getroot()
        for n in r.iter('node'):
            nodes[n.get('id')] = tr.transform(float(n.get('lon')), float(n.get('lat')))
            t = {x.get('k'): x.get('v') for x in n.findall('tag')}
            if t:
                ntags[n.get('id')] = t
        for w in r.iter('way'):
            ways[w.get('id')] = ({x.get('k'): x.get('v') for x in w.findall('tag')}, [x.get('ref') for x in w.findall('nd')])
    return nodes, ways, ntags


def osm_corridor(out):
    """Tāmaki Drive's ways and everything along them within 40 m: paths, walls, fences, coastline, beaches, buildings."""
    nodes, ways, ntags = load_osm(out)

    def line(refs):
        p = [nodes[r] for r in refs if r in nodes]
        return LineString(p) if len(p) > 1 else None
    td = {k: v for k, v in ways.items() if v[0].get('name') == 'Tāmaki Drive'}
    road = unary_union([line(v[1]) for v in td.values()])
    corr = road.buffer(40)
    res = {'road': [], 'paths': [], 'walls': [], 'buildings': [], 'lamps': [], 'trees': []}
    for k, (t, refs) in ways.items():
        L = line(refs)
        if L is None or not L.intersects(corr) or L.intersection(corr).length < 5:
            continue
        rec = {'id': k, 't': t, 'p': [list(c) for c in L.coords]}
        if k in td:
            res['road'].append(rec)
        elif t.get('highway') in ('cycleway', 'footway', 'path', 'pedestrian'):
            res['paths'].append(rec)
        elif t.get('natural') in ('coastline', 'beach') or t.get('man_made') in ('breakwater', 'pier', 'groyne') or \
                t.get('barrier') in ('fence', 'wall', 'retaining_wall', 'kerb', 'guard_rail'):
            res['walls'].append(rec)
        elif 'building' in t:
            res['buildings'].append(rec)
    for i, t in ntags.items():
        if i in nodes and corr.contains(Point(nodes[i])):
            if t.get('highway') == 'street_lamp':
                res['lamps'].append({'p': nodes[i], 't': t})
            if t.get('natural') == 'tree':
                res['trees'].append({'p': nodes[i], 't': t})
    json.dump(res, open(f'{out}/osm_corridor.json', 'w'))


def sections(out):
    """The axis: the shortest path along Tāmaki Drive's ways from its west end to its east end, stations every 5 m,
    normals from the axis smoothed over 45 m (dual carriageways make it hop)."""
    d = json.load(open(f'{out}/osm_corridor.json'))
    adj = defaultdict(list)
    for r in d['road']:
        p = [tuple(x) for x in r['p']]
        for a, b in zip(p, p[1:]):
            L = math.dist(a, b); adj[a].append((b, L)); adj[b].append((a, L))
    w = min(adj, key=lambda q: q[0]); e = max(adj, key=lambda q: q[0])
    dist, prev, pq = {w: 0}, {}, [(0, w)]
    while pq:
        dd, u = heapq.heappop(pq)
        if u == e:
            break
        if dd > dist[u]:
            continue
        for v, L in adj[u]:
            if dd + L < dist.get(v, 1e18):
                dist[v] = dd + L; prev[v] = u; heapq.heappush(pq, (dd + L, v))
    path = [e]
    while path[-1] != w:
        path.append(prev[path[-1]])
    axis = LineString(path[::-1])
    S = np.arange(0, axis.length, STEP)
    P = np.array([axis.interpolate(s).coords[0] for s in S])
    Ps = np.stack([uniform_filter1d(P[:, 0], 9, mode='nearest'), uniform_filter1d(P[:, 1], 9, mode='nearest')], 1)
    T = np.gradient(Ps, axis=0); T /= np.linalg.norm(T, axis=1)[:, None]
    N = np.stack([T[:, 1], -T[:, 0]], 1)
    rows = [{'s': float(s), 'x': p.tolist(), 'n': n.tolist()} for s, p, n in zip(S, Ps, N)]
    json.dump({'axis': [list(c) for c in axis.coords], 'rows': rows}, open(f'{out}/sections.json', 'w'))


class Frame:
    """Stations and the (s, offset) ↔ NZTM maps."""

    def __init__(self, out):
        sec = json.load(open(f'{out}/sections.json'))['rows']
        self.S = np.array([r['s'] for r in sec]); self.X = np.array([r['x'] for r in sec])
        self.N = np.array([r['n'] for r in sec]); self.N /= np.linalg.norm(self.N, axis=1)[:, None]
        self.sd = np.arange(0, self.S[-1], 0.5)
        self.Xd = np.stack([np.interp(self.sd, self.S, self.X[:, k]) for k in (0, 1)], 1)
        Nd = np.stack([np.interp(self.sd, self.S, self.N[:, k]) for k in (0, 1)], 1)
        self.Nd = Nd / np.linalg.norm(Nd, axis=1)[:, None]
        self.kd = cKDTree(self.Xd)

    def so(self, p):
        p = np.atleast_2d(np.asarray(p, float)); _, i = self.kd.query(p)
        return self.sd[i], np.einsum('ij,ij->i', p - self.Xd[i], self.Nd[i])

    def xy(self, s, o):
        s = np.asarray(s, float); o = np.asarray(o, float)
        px = np.interp(s, self.S, self.X[:, 0]); py = np.interp(s, self.S, self.X[:, 1])
        nx = np.interp(s, self.S, self.N[:, 0]); ny = np.interp(s, self.S, self.N[:, 1]); ln = np.hypot(nx, ny)
        return px + o * nx / ln, py + o * ny / ln


# ───────────────────────── measure ─────────────────────────

def path_kind(t):
    n = t.get('name') or ''
    if 'Shared Path' in n:
        return 'SP'
    if 'Cycleway' in n or t.get('highway') == 'cycleway':
        return 'CY'
    if t.get('highway') in ('footway', 'path', 'pedestrian') and t.get('footway') not in ('crossing', 'traffic_island'):
        return 'FW'
    return None


class Aerial:
    def __init__(self, out):
        self.c = {}
        for f in glob.glob(f'{out}/aer/*.jpg'):
            e, n = map(int, os.path.basename(f)[:-4].split('_')); self.c[(e, n)] = np.asarray(Image.open(f))

    def __call__(self, E, N):
        out = np.zeros(E.shape + (3,), np.float32)
        ke = ((E - BOX[0]) // CHUNK).astype(int) * CHUNK + BOX[0]; kn = ((N - BOX[1]) // CHUNK).astype(int) * CHUNK + BOX[1]
        lim = int(CHUNK / AER_RES) - 1
        for key in set(zip(ke.ravel().tolist(), kn.ravel().tolist())):
            if key in self.c:
                m = (ke == key[0]) & (kn == key[1]); a = self.c[key]
                out[m] = a[((key[1] + CHUNK - N[m]) / AER_RES).astype(int).clip(0, lim), ((E[m] - key[0]) / AER_RES).astype(int).clip(0, lim)]
        return out


def intensity(out, R=0.5):
    """Mean LiDAR intensity of the ground returns (class 2) on a 0.5 m grid, holes filled from the nearest cell.
    Shade doesn't touch it and it sees under the trees: road asphalt ~800, path asphalt ~1,100–1,300, concrete and
    grass 2,000+ (the scanner's near-infrared); grass from concrete is the aerial's job."""
    x, y, v = [], [], []
    for f in glob.glob(f'{out}/pc/*.npz'):
        p = np.load(f); m = p['c'] == 2
        x.append(p['x'][m]); y.append(p['y'][m]); v.append(p['i'][m])
    x, y, v = map(np.concatenate, (x, y, v))
    E0, N0, E1, N1 = BOX; W, H = int((E1 - E0) / R), int((N1 - N0) / R)
    c = ((x - E0) / R).astype(int).clip(0, W - 1); r = ((N1 - y) / R).astype(int).clip(0, H - 1)
    s = np.zeros((H, W)); n = np.zeros((H, W))
    np.add.at(s, (r, c), v.astype(float)); np.add.at(n, (r, c), 1)
    img = np.where(n > 0, s / np.maximum(n, 1), np.nan)
    idx = ndimage.distance_transform_edt(np.isnan(img), return_distances=False, return_indices=True)
    return img[tuple(idx)].astype(np.float32)


def measure(out):
    F = Frame(out); d = json.load(open(f'{out}/osm_corridor.json'))
    L = np.load(f'{out}/lidar.npz'); dsm = np.nan_to_num(L['dsm'], nan=WATER); dem = np.nan_to_num(L['dem'], nan=WATER)
    E0, N0, E1, N1 = L['box']
    aer = Aerial(out)
    inten = intensity(out); IR = 0.5
    # OSM lines → per-station offsets, runs roughly parallel to the axis only (cross paths dropped)
    offs = {k: defaultdict(list) for k in ('SP', 'CY', 'FW', 'RD', 'FE')}

    def add(kind, p, tag=None):
        P = np.asarray(LineString(p).segmentize(1).coords)
        if len(P) < 3:
            return
        s, o = F.so(P)
        ds, do = np.abs(np.gradient(s)), np.abs(np.gradient(o))
        for ss, oo, a, b in zip(s, o, ds, do):
            if abs(oo) <= 50 and a >= 2 * b:     # within ~27° of the axis: side streets' paths turn off
                offs[kind][int(round(ss / STEP))].append((float(oo), tag))
    for x in d['paths']:
        k = path_kind(x['t'])
        if k:
            add(k, x['p'], [x['t'].get('name'), x['t'].get('surface')])
    for x in d['walls']:
        if x['t'].get('barrier') == 'fence':
            add('FE', x['p'])
    for r in d['road']:
        add('RD', r['p'], r['t'].get('lanes'))
    beach = unary_union([Polygon(x['p']).buffer(0) for x in d['walls'] if x['t'].get('natural') == 'beach' and len(x['p']) > 3])

    O = np.arange(-50, 50.01, 0.25); R = 0.25
    def ix(o): return int(round((o + 50) / R))
    rows = []
    for i, s in enumerate(F.S):
        P0, n = F.X[i], F.N[i]; t = np.array([-n[1], n[0]])
        along = np.linspace(-2, 2, 9)
        E = P0[0] + O[None, :] * n[0] + along[:, None] * t[0]; N = P0[1] + O[None, :] * n[1] + along[:, None] * t[1]
        A = aer(E, N); rgb = np.median(A, 0); tex = A.std(0).mean(1)
        rr, cc = N1 - (P0[1] + O * n[1]) - .5, (P0[0] + O * n[0]) - E0 - .5
        zg = map_coordinates(dem, [rr, cc], order=1); zs = map_coordinates(dsm, [rr, cc], order=1)
        iv = np.median(map_coordinates(inten, [(N1 - N) / IR - .5, (E - E0) / IR - .5], order=1), 0)
        # edges: the aerial's colour steps and the intensity's, each scaled to a typical step (60 sRGB, 300 counts)
        g = uniform_filter1d(np.r_[0, np.abs(np.diff(rgb, axis=0)).sum(1)] / 60 + np.r_[0, np.abs(np.diff(iv))] / 300, 3)
        green = (rgb[:, 1] - np.maximum(rgb[:, 0], rgb[:, 2]) > 8) & (rgb[:, 1] - rgb[:, 0] > 12) & (rgb.mean(1) > 70)  # the aerial's cast tints asphalt green-blue
        st = i
        rec = {'s': float(s), 'paths': [], 'iv': iv[::2].round().astype(int).tolist()}
        for k in ('SP', 'CY', 'FW'):
            vals = sorted(offs[k].get(st, []), key=lambda v: v[0])
            groups = []
            for v in vals:
                (groups[-1].append(v) if groups and v[0] - groups[-1][-1][0] < 2 else groups.append([v]))
            for gr in groups:
                c = float(np.median([v[0] for v in gr]))
                if abs(c) > 46:
                    continue
                a = ix(c - 3) + int(np.argmax(g[ix(c - 3):ix(c - 0.9)])); b = ix(c + 0.9) + int(np.argmax(g[ix(c + 0.9):ix(c + 3)]))
                # a concrete path stops at the first lit grass either side of its centre
                for j in range(ix(c), a, -1):
                    if green[j - 1] and green[j - 2]:
                        a = j; break
                for j in range(ix(c), b):
                    if green[j + 1] and green[j + 2]:
                        b = j; break
                rec['paths'].append({'k': k, 'c': round(c, 2), 'e': [round(float(O[a]), 2), round(float(O[b]), 2)], 'tag': gr[0][1],
                                     'rgb': np.median(rgb[a:b + 1], 0).round().tolist(), 'z': round(float(np.median(zg[a:b + 1])), 2)})
        rd = [v[0] for v in offs['RD'].get(st, [])]
        rec['rd'] = [round(min(rd), 2), round(max(rd), 2)] if rd else None
        rec['fence'] = sorted({round(v[0], 1) for v in offs['FE'].get(st, [])})
        inner = min([p['e'][0] for p in rec['paths'] if p['c'] < 0] + ([rec['rd'][0] - 3] if rd else [-8]))
        i0 = ix(inner); lvl = float(np.median(zg[i0:i0 + 4]))
        crest = toe = None
        for j in range(i0, 0, -1):
            if crest is None and zg[j] < lvl - 0.4:
                crest = j + 1
            if crest is not None and (zg[j] <= WATER + 0.15 or (crest - j > 8 and abs(zg[j] - zg[j + 4]) < 0.12)):
                toe = j; break
        rec['wall'] = None
        if crest is not None and toe is not None:
            rec['wall'] = {'crest': round(float(O[crest]), 2), 'toe': round(float(O[toe]), 2), 'zc': round(float(zg[crest]), 2),
                           'zt': round(float(zg[toe]), 2), 'drop': round(float(zg[crest] - zg[toe]), 2),
                           'tex': round(float(np.median(tex[toe:crest + 1])), 1), 'wet': bool(zg[toe] <= WATER + 0.15)}
        rec['level'] = round(lvl, 2)
        rec['beach'] = bool(beach.contains(Point(P0 + n * ((rec['wall'] or {}).get('toe', -15) - 3))))
        rows.append(rec)
    json.dump(rows, open(f'{out}/measure.json', 'w'))
    poles(out, F)
    trees(out, F, rows, d)


def poles(out, F):
    """Light poles from the point cloud (classes 18 and 1: LINZ files thin poles as high noise)."""
    x, y, z, c = [], [], [], []
    for f in glob.glob(f'{out}/pc/*.npz'):
        p = np.load(f); x.append(p['x']); y.append(p['y']); z.append(p['z']); c.append(p['c'])
    x, y, z, c = map(np.concatenate, (x, y, z, c))
    L = np.load(f'{out}/lidar.npz'); dem = np.nan_to_num(L['dem'], nan=WATER); E0, N0, E1, N1 = L['box']
    h = z - map_coordinates(dem, [N1 - y - 0.5, x - E0 - 0.5], order=1)
    m = np.isin(c, (1, 18)) & (h > 3) & (h < 17)
    x, y, h = x[m], y[m], h[m]
    R = 0.5; ex, ny = x.min(), y.max()
    ixs, iys = ((x - ex) / R).astype(int), ((ny - y) / R).astype(int)
    g = np.zeros((iys.max() + 1, ixs.max() + 1), bool); g[iys, ixs] = True
    lab, n = ndimage.label(ndimage.binary_dilation(g, iterations=2))
    cl = lab[iys, ixs]; order = np.argsort(cl); bounds = np.searchsorted(cl[order], np.arange(1, n + 2))
    res = []
    for k in range(n):
        idx = order[bounds[k]:bounds[k + 1]]
        if len(idx) < 4:
            continue
        hx, hy, hh = x[idx], y[idx], h[idx]
        if max(np.ptp(hx), np.ptp(hy)) > 9 or np.ptp(hh) < 2.5 or hh.max() < 6:
            continue
        top = float(hh.max()); low = hh < 0.75 * top
        bx, by = (np.median(hx[low]), np.median(hy[low])) if low.sum() >= 2 else (np.median(hx), np.median(hy))
        hi = hh > top - 1.2
        s, o = F.so([bx, by]); _, oh = F.so([hx[hi].mean(), hy[hi].mean()])
        res.append({'E': round(float(bx), 2), 'N': round(float(by), 2), 's': round(float(s[0]), 1), 'o': round(float(o[0]), 2), 'top': round(top, 1),
                    'n': int(len(idx)), 'head': [round(float(hx[hi].mean() - bx), 2), round(float(hy[hi].mean() - by), 2)], 'arm': round(float(oh[0] - o[0]), 2)})
    json.dump(res, open(f'{out}/poles.json', 'w'))


def strip_polygon(F, rows):
    """The waterfront strip: from the seawall toe (or 14 m seaward) to 4 m past the land-side path (or 10 m past the road)."""
    lo, hi = [], []
    for i, q in enumerate(rows):
        a = q['wall']['toe'] if q['wall'] else -14
        land = [p['e'][1] for p in q['paths'] if p['c'] > 0]
        b = (max(land) + 4) if land else ((q['rd'][1] + 10) if q['rd'] else 10)
        lo.append(max(a, -45)); hi.append(min(b, 30))
    lo = median_filter(np.array(lo), 5); hi = median_filter(np.array(hi), 5)
    l = np.stack(F.xy(F.S, lo), 1); r = np.stack(F.xy(F.S, hi), 1)
    return Polygon(np.vstack([l, r[::-1]])).buffer(0), lo, hi


def trees(out, F, rows, d):
    strip, _, _ = strip_polygon(F, rows)
    L = np.load(f'{out}/lidar.npz'); dsm = np.nan_to_num(L['dsm'], nan=WATER); dem = np.nan_to_num(L['dem'], nan=WATER)
    E0, N0, E1, N1 = L['box']; nd = dsm - dem; H, W = nd.shape
    cc, rr = np.meshgrid(np.arange(W) + 0.5 + E0, N1 - np.arange(H) - 0.5)
    inside = contains_xy(strip, cc, rr)
    nodes, ways, _ = load_osm(out)
    blds = []
    for t, refs in ways.values():
        if 'building' in t or t.get('man_made') == 'pier':
            pts = [nodes[r] for r in refs if r in nodes]
            if len(pts) > 3:
                p = Polygon(pts).buffer(1.0)
                if p.is_valid and p.intersects(strip):
                    blds.append(p)
    bu = unary_union(blds)
    canopy = (nd > 2.5) & inside & ~contains_xy(bu, cc, rr)
    canopy = ndimage.binary_opening(canopy, iterations=1)
    sm = ndimage.gaussian_filter(np.where(canopy, nd, 0), 1.0)
    peaks = np.zeros_like(canopy)
    for lo, hi, w in ((3, 12, 3), (12, 22, 5), (22, 99, 7)):
        peaks |= (sm == ndimage.maximum_filter(sm, size=w)) & (sm > lo) & (sm <= hi) & canopy
    lab, n = ndimage.label(peaks)
    tops = ndimage.center_of_mass(peaks, lab, range(1, n + 1))
    markers = np.zeros(nd.shape, np.int32)
    for i, (r, c) in enumerate(tops, 1):
        markers[int(round(r)), int(round(c))] = i
    from skimage.segmentation import watershed
    crowns = watershed(-sm, markers, mask=canopy)
    aer = Aerial(out)
    rgb = np.zeros((H, W, 3), np.float32)
    for (e, nn), a in aer.c.items():
        a = np.asarray(Image.fromarray(a).resize((CHUNK, CHUNK), Image.BOX), np.float32)
        c0, r0 = int(e - E0), int(N1 - (nn + CHUNK))
        ra, rb, ca, cb = max(r0, 0), min(r0 + CHUNK, H), max(c0, 0), min(c0 + CHUNK, W)
        if ra < rb and ca < cb:
            rgb[ra:rb, ca:cb] = a[ra - r0:rb - r0, ca - c0:cb - c0]
    idx = np.arange(1, n + 1)
    area = ndimage.sum(np.ones_like(nd), crowns, idx); top = ndimage.maximum(nd, crowns, idx)
    cr, cg, cb = (ndimage.mean(rgb[..., k], crowns, idx) for k in range(3))
    # palms (the Phoenix palms of Mission Bay and Kohimarama): tall, a narrow crown, all foliage at the top and almost
    # no returns in the trunk zone; pōhutukawa branch from low down and spread wide
    vx, vy, vh = [], [], []
    for f in glob.glob(f'{out}/pc/*.npz'):
        p = np.load(f); m = np.isin(p['c'], (1, 3, 4, 5))
        vx.append(p['x'][m]); vy.append(p['y'][m]); vh.append(p['z'][m])
    vx, vy, vz = map(np.concatenate, (vx, vy, vh))
    vh = vz - map_coordinates(dem, [N1 - vy - 0.5, vx - E0 - 0.5], order=1)
    vkd = cKDTree(np.c_[vx, vy])

    def palm(E, N, h, rad):
        if h < 10 or rad > 4.5:
            return False
        hh = vh[vkd.query_ball_point([E, N], max(1.5, 0.8 * rad))]
        hh = hh[hh > 0.5]
        if len(hh) < 10:
            return False
        up = hh[hh > 0.3 * h]
        depth = (np.percentile(up, 95) - np.percentile(up, 10)) / h if len(up) > 5 else 1
        return bool(np.mean(hh < 0.55 * h) <= 0.12 and depth <= 0.27)
    res = []
    for i in range(n):
        if area[i] < 3 or top[i] < 3:
            continue
        if (cr[i] + cg[i] + cb[i]) / 3 > 150 and 2 * cg[i] - cr[i] - cb[i] < 15:   # pale, not green: a pole head, a sign
            continue
        r, c = tops[i]
        E, N = E0 + c + 0.5, N1 - r - 0.5
        rad = float(np.clip(1.1 * math.sqrt(area[i] / math.pi), 1.2, 15))
        res.append({'palm': palm(E, N, float(top[i]), rad), 'E': round(E0 + c + 0.5, 1), 'N': round(N1 - r - 0.5, 1), 'g': round(float(dem[int(r), int(c)]), 2), 'h': round(float(top[i]), 1),
                    'r': round(float(np.clip(1.1 * math.sqrt(area[i] / math.pi), 1.2, 15)), 1), 'rgb': [int(cr[i]), int(cg[i]), int(cb[i])]})
    json.dump({'trees': res, 'strip': [list(p) for p in strip.exterior.coords]}, open(f'{out}/trees.json', 'w'))


# ───────────────────────── model ─────────────────────────

def runs(stations, maxgap=3):
    """Split sorted station indices into runs with gaps of at most `maxgap` stations."""
    out = []
    for i in stations:
        (out[-1].append(i) if out and i - out[-1][-1] <= maxgap else out.append([i]))
    return [r for r in out if len(r) >= 4]


def smooth(v, k=9):
    v = np.asarray(v, float)
    if len(v) < 3:
        return v
    k = min(k, len(v) - (1 - len(v) % 2))
    return uniform_filter1d(median_filter(v, size=k, mode='nearest'), max(1, k // 2), mode='nearest')


def surface_of(kind, tag, rgb):
    surf = (tag or [None, None])[1] or ''
    if surf in ('concrete',):
        return 'concrete'
    if surf in ('paving_stones', 'sett'):
        return 'paving'
    if surf in ('asphalt',):
        return 'asphalt'
    return 'concrete' if sum(rgb) / 3 > 140 else 'asphalt'


def model(out):
    F = Frame(out); rows = json.load(open(f'{out}/measure.json'))
    L = np.load(f'{out}/lidar.npz'); dem = np.nan_to_num(L['dem'], nan=WATER); E0, N0, E1, N1 = L['box']
    def ground(E, N): return map_coordinates(dem, [np.atleast_1d(N1 - np.asarray(N) - .5), np.atleast_1d(np.asarray(E) - E0 - .5)], order=1)
    def loc(E, N): return np.asarray(E) - E0, N1 - np.asarray(N)
    # ── paths: tracks per (kind, side), stitched station to station by nearest centre ──
    tracks = []    # each: {k, side, st: [], c: [], e0: [], e1: [], tag, rgb: []}
    for i, q in enumerate(rows):
        for p in q['paths']:
            side = -1 if p['c'] < 0 else 1
            best = None
            for t in tracks:
                if t['k'] == p['k'] and t['side'] == side and 0 < i - t['st'][-1] <= 3 and abs(t['c'][-1] - p['c']) < 2.5:
                    if best is None or abs(t['c'][-1] - p['c']) < abs(best['c'][-1] - p['c']):
                        best = t
            if best is None:
                best = {'k': p['k'], 'side': side, 'st': [], 'c': [], 'e0': [], 'e1': [], 'tag': p['tag'], 'rgb': []}
                tracks.append(best)
            if best['st'] and best['st'][-1] == i:
                continue
            best['st'].append(i); best['c'].append(p['c']); best['e0'].append(p['e'][0]); best['e1'].append(p['e'][1]); best['rgb'].append(p['rgb'])
    ribbons = []
    for t in tracks:
        if len(t['st']) < 8:      # under 40 m: a link to a side street or a crossing
            continue
        w = np.clip(smooth(np.array(t['e1']) - np.array(t['e0'])), 1.8, 5.0)
        mid = smooth((np.array(t['e0']) + np.array(t['e1'])) / 2)
        c = smooth(t['c'])
        cen = np.where(np.abs(mid - c) < 1.8, mid, c)     # trust the aerial's centre unless it ran off the OSM line
        s = F.S[t['st']]
        E, N = F.xy(s, cen); y = ground(E, N)
        x, z = loc(E, N)
        rgb = np.median(t['rgb'], 0)
        surf = surface_of(t['k'], t['tag'], rgb)
        name = (t['tag'] or [None])[0] or {'SP': 'shared path', 'CY': 'cycleway', 'FW': 'footpath'}[t['k']]
        ribbons.append({'kind': t['k'], 'side': t['side'], 'name': name, 'surface': surf, 'rgb': SURF[surf],
                        's': [round(float(a), 1) for a in s], 'o': [round(float(a), 2) for a in cen], 'w': [round(float(a), 2) for a in w],
                        'pts': [[round(float(a), 2), round(float(b), 2), round(float(h), 2)] for a, b, h in zip(x, z, y)]})
    # ── road: kerb to kerb between the innermost path on each side (or OSM carriageways ± 6.5 m) ──
    kerb = []
    for i, q in enumerate(rows):
        hp = [p['e'][1] for p in q['paths'] if p['c'] < 0 and (not q['rd'] or p['c'] > q['rd'][0] - 12)]
        lp = [p['e'][0] for p in q['paths'] if p['c'] > 0 and (not q['rd'] or p['c'] < q['rd'][1] + 12)]
        if not q['rd']:
            kerb.append(None); continue
        a = max(hp) + 0.3 if hp else q['rd'][0] - 6.5
        b = min(lp) - 0.3 if lp else q['rd'][1] + 6.5
        a = float(np.clip(a, q['rd'][0] - 11, q['rd'][0] - 4.5)); b = float(np.clip(b, q['rd'][1] + 4.5, q['rd'][1] + 11))
        kerb.append((a, b))
    ok = [i for i, k in enumerate(kerb) if k]
    road = []
    for r in runs(ok, 2):
        a = smooth([kerb[i][0] for i in r]); b = smooth([kerb[i][1] for i in r])
        s = F.S[r]; cen = (a + b) / 2; E, N = F.xy(s, cen); x, z = loc(E, N); y = ground(E, N)
        road.append({'s': [round(float(v), 1) for v in s], 'o': [round(float(v), 2) for v in cen], 'w': [round(float(v), 2) for v in (b - a)],
                     'pts': [[round(float(p), 2), round(float(q2), 2), round(float(h), 2)] for p, q2, h in zip(x, z, y)]})
    # ── seawall: crest and toe per station, typed rock / concrete / low beach wall ──
    walls = []
    good = [i for i, q in enumerate(rows) if q['wall'] and q['wall']['drop'] > 0.35 and q['wall']['crest'] - q['wall']['toe'] < 22]
    for r in runs(good, 2):
        cr = smooth([rows[i]['wall']['crest'] for i in r], 5); to = smooth([rows[i]['wall']['toe'] for i in r], 5)
        zc = smooth([rows[i]['wall']['zc'] for i in r], 5); zt = smooth([rows[i]['wall']['zt'] for i in r], 5)
        tex = median_filter(np.array([rows[i]['wall']['tex'] for i in r]), 9, mode='nearest')
        drop = zc - zt
        kind = np.where(drop < 1.2, 'low', np.where(tex > 10, 'rock', 'concrete'))
        s = F.S[r]
        Ec, Nc = F.xy(s, cr); Et, Nt = F.xy(s, to)
        xc, zc_ = loc(Ec, Nc); xt, zt_ = loc(Et, Nt)
        # split where the kind changes
        start = 0
        for j in range(1, len(r) + 1):
            if j == len(r) or kind[j] != kind[start]:
                if j - start >= 2:
                    seg = slice(max(start - 1, 0), j)
                    walls.append({'kind': str(kind[start]), 'rgb': SURF['rock' if kind[start] == 'rock' else 'seawall'],
                                  's': [round(float(v), 1) for v in s[seg]],
                                  'crest': [[round(float(a), 2), round(float(b), 2), round(float(c), 2)] for a, b, c in zip(xc[seg], zc_[seg], zc[seg])],
                                  'toe': [[round(float(a), 2), round(float(b), 2), round(float(c), 2)] for a, b, c in zip(xt[seg], zt_[seg], zt[seg])]})
                start = j
    # ── railings: OSM fences running along the crest (within 4 m of it), 1.1 m ──
    d = json.load(open(f'{out}/osm_corridor.json'))
    crest_line = unary_union([LineString([(p[0] + E0, N1 - p[1]) for p in w['crest']]) for w in walls if len(w['crest']) > 1])
    rails = []
    for x in d['walls']:
        if x['t'].get('barrier') not in ('fence', 'guard_rail'):
            continue
        Lf = LineString(x['p'])
        near = Lf.intersection(crest_line.buffer(4))
        for g in getattr(near, 'geoms', [near]):
            if g.geom_type == 'LineString' and g.length > 15:
                P = np.asarray(g.segmentize(5).coords); y = ground(P[:, 0], P[:, 1]); xx, zz = loc(P[:, 0], P[:, 1])
                rails.append({'h': 1.1, 'pts': [[round(float(a), 2), round(float(b), 2), round(float(c), 2)] for a, b, c in zip(xx, zz, y)]})
    # ── strip, lamps, trees ──
    strip, lo, hi = strip_polygon(F, rows)
    lamps = []
    for p in json.load(open(f'{out}/poles.json')):
        st = int(np.clip(round(p['s'] / STEP), 0, len(rows) - 1))
        if not (9.5 <= p['top'] <= 16 and lo[st] - 1 <= p['o'] <= hi[st]):
            continue
        q = rows[st]
        if q['rd'] and p['o'] > q['rd'][1] + 14:         # the rail corridor on the causeway
            continue
        x, z = loc(p['E'], p['N']); g = float(ground(p['E'], p['N'])[0])
        hx, hz = p['head'][0], -p['head'][1]
        arm = math.hypot(hx, hz)
        lamps.append([round(float(x), 2), round(float(z), 2), round(g, 2), round(g + p['top'], 2), round(hx, 2) if arm > 0.6 else 0, round(hz, 2) if arm > 0.6 else 0])
    lamps.sort(key=lambda r: r[0])
    T = json.load(open(f'{out}/trees.json'))['trees']
    # no tree stands in the carriageway or on a deck over the water (roadworks and barriers read as crowns there)
    carriage = []
    for r in road:
        s_, o_, w_ = np.array(r['s']), np.array(r['o']), np.array(r['w'])
        a = np.stack(F.xy(s_, o_ - w_ / 2 + 0.5), 1); b = np.stack(F.xy(s_, o_ + w_ / 2 - 0.5), 1)
        carriage.append(Polygon(np.vstack([a, b[::-1]])).buffer(0))
    carriage = unary_union(carriage)
    trees_ = []
    for t in T:
        if t['g'] < 0.3 or carriage.contains(Point(t['E'], t['N'])):
            continue
        x, z = loc(t['E'], t['N'])
        trees_.append([round(float(x), 1), round(float(z), 1), t['g'], round(t['g'] + t['h'], 1), t['r']] + t['rgb'] + [int(t['palm'])])
    # ── axis and section summary for the page ──
    ax = np.stack(loc(F.X[:, 0], F.X[:, 1]), 1)
    M = {'meta': {'name': 'Tāmaki Drive waterfront', 'E0': int(E0), 'N1': int(N1), 'frame': 'x = E − E0 (east), z = N1 − N (south), y = m NZVD2016',
                  'length_m': round(float(F.S[-1]), 0), 'water': WATER, 'surfaces': SURF},
         'axis': [[round(float(a), 1), round(float(b), 1)] for a, b in ax[::4]],
         'ribbons': ribbons, 'road': road, 'walls': walls, 'rails': rails, 'lamps': lamps, 'trees': trees_,
         'strip': [[round(p[0] - E0, 1), round(N1 - p[1], 1)] for p in strip.exterior.coords]}
    json.dump(M, open(f'{out}/model.json', 'w'), separators=(',', ':'))
    # ledger
    def km(rs): return round(sum(LineString([(p[0], p[1]) for p in r['pts']]).length for r in rs if len(r['pts']) > 1) / 1000, 2)
    print('length', M['meta']['length_m'], 'm')
    for k, side in (('SP', -1), ('SP', 1), ('CY', -1), ('CY', 1), ('FW', -1), ('FW', 1)):
        rs = [r for r in ribbons if r['kind'] == k and r['side'] == side]
        if rs:
            print(f"{k} {'harbour' if side < 0 else 'land   '} {km(rs):5.2f} km  width median {np.median(np.concatenate([r['w'] for r in rs])):.1f} m  runs {len(rs)}")
    for k in ('rock', 'concrete', 'low'):
        ws = [w for w in walls if w['kind'] == k]
        L_ = sum(LineString([(p[0], p[1]) for p in w['crest']]).length for w in ws if len(w['crest']) > 1)
        if ws:
            dr = np.concatenate([[c[2] - t[2] for c, t in zip(w['crest'], w['toe'])] for w in ws])
            run = np.concatenate([[math.dist(c[:2], t[:2]) for c, t in zip(w['crest'], w['toe'])] for w in ws])
            print(f'wall {k:8s} {L_ / 1000:5.2f} km  drop {np.median(dr):.1f} m  face {np.median(run):.1f} m')
    print('road', km(road), 'km, width median', round(float(np.median(np.concatenate([r['w'] for r in road]))), 1), 'm')
    print('rails', km(rails), 'km; lamps', len(lamps), '; trees', len(trees_), f"({sum(t[-1] for t in trees_)} palms)", '; model.json', os.path.getsize(f'{out}/model.json') // 1024, 'kB')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('step', choices=['fetch', 'measure', 'model', 'all'])
    ap.add_argument('--out', default='/tmp/hero/tamaki')
    a = ap.parse_args()
    if a.step in ('fetch', 'all'):
        fetch(a.out)
    if a.step in ('measure', 'all'):
        measure(a.out)
    if a.step in ('model', 'all'):
        model(a.out)


if __name__ == '__main__':
    main()
