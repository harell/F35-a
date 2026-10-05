"""
Bake the land-use class grid of the Auckland theatre (issue #122) into src/world/scenery/data/auckland-landuse.bin,
decoded by src/world/scenery/aucklandLandUse.ts.

Inputs: the same OSM extracts as bake.py (merged into one, each object at its newest version) plus the LINZ Topo50
golf course and cemetery polygons (topo50.py) that fill OSM's gaps.

Classes (keep in sync with LU_* in aucklandLandUse.ts):
   0 none (no polygon: the game keeps its hand-traced map there)    6 golf course
   1 residential                                                   7 school grounds (incl. universities)
   2 commercial / retail (incl. car parks ≥ 1,500 m²)              8 hospital grounds
   3 industrial (incl. port, railway yards)                        9 cemetery
   4 park / grass / garden / recreation ground                     10 vineyard
   5 sports pitch / track                                          11 farmland / orchard / meadow
Every polygon is painted on its own bounding box in order of decreasing area, so a smaller, more specific polygon
(a pitch in a park, a school in a residential zone) wins over the one it lies in. A Topo50 polygon is dropped where
OSM already maps the same class over half of it.

Grid: CELL m square cells over the ±40 km world (game XZ, the equirectangular projection of bake.py), a cell takes
the class of the last polygon covering its centre; then gaps up to CLOSE_M wide between two cells of one class (the
streets between residential polygons) are filled with it. Format (little-endian, gzip): 'AKLU' | u32 version | f32 x0 |
f32 z0 | f32 cell | u32 cols | u32 rows | u8 attribution length + UTF-8 | rows of runs: varint (run length << 4 |
class), each row's runs summing to cols.

manifest.json gets a "landuse" entry: sizes, per-class areas and, for the spot-check suburbs (SUBURBS), the class
shares computed exactly from the source polygons (shapely, same painting order and gap filling), which
tests/world-landuse.test.ts compares with the decoded grid.

Data © OpenStreetMap contributors (ODbL 1.0; the grid is a derivative database under the same licence) and LINZ
Topo50 (CC BY 4.0).

Usage: python3 landuse.py <out.bin> <topo-dir> <extract> [<extract> ...] [--cell=16]
"""
import gzip, hashlib, json, math, os, sys
import numpy as np
import osmium
from PIL import Image, ImageDraw
from shapely.geometry import Polygon, MultiPolygon, box as sbox, shape
from shapely.ops import unary_union, transform
from shapely.prepared import prep
from bake import BBOX, world, header_time, sha256, merged_input

VERSION = 1
HALF = 40_000.0         # world half extent (m)
MIN_PARKING = 1_500.0   # car parks smaller than this (m²) are dropped (a few spaces behind a shop)
CLOSE_M = 32.0          # unclassified gaps up to this wide (m) between two cells of one class take that class
NAMES = ['none', 'residential', 'commercial', 'industrial', 'park', 'pitch', 'golf', 'school', 'hospital',
         'cemetery', 'vineyard', 'farmland']
C = {n: i for i, n in enumerate(NAMES)}

# Spot-check suburbs (#122 "Weak spots"): a 2 km square on each (lat, lon) centre.
SUBURBS = {
    'mt_roskill': (-36.9130, 174.7330),   # Keith Hay Park, Stoddard Road
    'avondale': (-36.8970, 174.6930),
    'henderson': (-36.8790, 174.6310),
    'mangere': (-36.9680, 174.7990),
    'onetangi': (-36.7870, 175.0770),
    'oneroa': (-36.7840, 175.0080),
    'devonport': (-36.8310, 174.7960),
    'takapuna': (-36.7880, 174.7700),
}
SUBURB_HALF = 1000.0


def cls_of(t):
    """Land-use class of an OSM area's tags, or None."""
    lu, le, am = t.get('landuse'), t.get('leisure'), t.get('amenity')
    if le in ('pitch', 'track'):
        return C['pitch']
    if am == 'hospital' or lu == 'healthcare' or t.get('healthcare') == 'hospital':
        return C['hospital']
    if am in ('school', 'college', 'university', 'kindergarten') or lu == 'education':
        return C['school']
    if le == 'golf_course':
        return C['golf']
    if lu == 'cemetery' or am == 'grave_yard':
        return C['cemetery']
    if lu == 'vineyard':
        return C['vineyard']
    if le in ('park', 'garden', 'recreation_ground', 'playground', 'dog_park', 'common') or \
            lu in ('recreation_ground', 'grass', 'village_green'):
        return C['park']
    if lu in ('retail', 'commercial') or t.get('shop') == 'mall' or am in ('marketplace', 'parking'):
        return C['commercial']
    if lu in ('industrial', 'port', 'railway', 'depot'):
        return C['industrial']
    if lu == 'residential':
        return C['residential']
    if lu in ('farmland', 'orchard', 'meadow', 'farmyard', 'greenhouse_horticulture', 'plant_nursery', 'animal_keeping'):
        return C['farmland']
    return None


def in_world(g):
    x0, z0, x1, z1 = g.bounds
    return x1 > -HALF and x0 < HALF and z1 > -HALF and z0 < HALF


class Areas(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.polys = []  # (area, cls, geometry, source)

    def area(self, a):
        t = a.tags
        if not any(k in t for k in ('landuse', 'leisure', 'amenity', 'shop', 'healthcare')):
            return
        c = cls_of(dict(t))
        if c is None:
            return
        try:
            parts = []
            for outer in a.outer_rings():
                ring = [world(n.lat, n.lon) for n in outer]
                holes = [[world(n.lat, n.lon) for n in inner] for inner in a.inner_rings(outer)]
                if len(ring) >= 4:
                    parts.append(Polygon(ring, [h for h in holes if len(h) >= 4]))
        except osmium.InvalidLocationError:
            return
        if not parts:
            return
        g = unary_union([p.buffer(0) for p in parts])
        if g.is_empty or not in_world(g):
            return
        if t.get('amenity') == 'parking' and g.area < MIN_PARKING:
            return
        self.polys.append((g.area, c, g, 'osm'))


def topo_polys(topo_dir):
    """Topo50 golf courses and cemeteries (NZTM) in game XZ."""
    from pyproj import Transformer
    tr = Transformer.from_crs(2193, 4326, always_xy=True)

    def to_world(x, y, z=None):
        lon, lat = tr.transform(np.asarray(x), np.asarray(y))
        return world(np.asarray(lat), np.asarray(lon))

    out = []
    for layer, name in ((50281, 'golf'), (50255, 'cemetery')):
        path = os.path.join(topo_dir, f'topo-{layer}.json')
        for f in json.load(open(path))['features']:
            g = shape(f['geometry'])
            g = transform(to_world, g).buffer(0)
            if not g.is_empty and in_world(g):
                out.append((g.area, C[name], g, 'topo50'))
    return out


def drop_mapped(polys, topo):
    """Topo50 polygons fill gaps only: drop one where OSM has the same class over half of it."""
    keep = []
    for a, c, g, s in topo:
        same = [p[2] for p in polys if p[1] == c and p[2].intersects(g)]
        if same and unary_union(same).intersection(g).area > 0.5 * a:
            continue
        keep.append((a, c, g, s))
    return keep


def rasterise(polys, cell):
    n = int(round(2 * HALF / cell))
    grid = np.zeros((n, n), np.uint8)
    for _a, c, g, _s in sorted(polys, key=lambda p: -p[0]):
        x0, z0, x1, z1 = g.bounds
        i0 = max(0, int(math.floor((x0 + HALF) / cell)))
        j0 = max(0, int(math.floor((z0 + HALF) / cell)))
        i1 = min(n, int(math.ceil((x1 + HALF) / cell)) + 1)
        j1 = min(n, int(math.ceil((z1 + HALF) / cell)) + 1)
        if i1 <= i0 or j1 <= j0:
            continue
        img = Image.new('1', (i1 - i0, j1 - j0), 0)
        d = ImageDraw.Draw(img)
        # pixel (i, j) has its centre at x0 + (i + 0.5) cell: map world to pixel-centre coordinates
        px = lambda pts: [((x + HALF) / cell - 0.5 - i0, (z + HALF) / cell - 0.5 - j0) for x, z in pts]
        for p in (g.geoms if isinstance(g, MultiPolygon) else [g]):
            if not isinstance(p, Polygon):
                continue
            d.polygon(px(p.exterior.coords), fill=1)
            for h in p.interiors:
                d.polygon(px(h.coords), fill=0)
        m = np.array(img, dtype=bool)
        grid[j0:j1, i0:i1][m] = c
    return grid


def close_gaps(g, k):
    """Fill runs of class 0 up to k cells long, along rows and then columns (twice), whose neighbours on either side
    share a class: the streets and streams between two polygons of one zone. They are drawn by the game's own street
    grid and road ribbons, and as gaps they cost a third of the file."""
    for _ in range(2):
        for a in (g, g.T):
            for gap in range(1, k + 1):
                w = a.shape[1] - gap - 1
                left, right = a[:, :w], a[:, gap + 1:]
                fill = (left == right) & (left != 0)
                for d in range(1, gap + 1):
                    fill &= a[:, d:d + w] == 0
                for d in range(1, gap + 1):
                    a[:, d:d + w][fill] = left[fill]
    return g


def encode(grid, cell, attribution):
    n = grid.shape[0]
    b = bytearray(b'AKLU')
    b += VERSION.to_bytes(4, 'little')
    import struct
    b += struct.pack('<fff', -HALF, -HALF, cell)
    b += n.to_bytes(4, 'little') + n.to_bytes(4, 'little')
    e = attribution.encode('utf-8')[:255]
    b.append(len(e))
    b += e

    def varint(v):
        while True:
            c = v & 127
            v >>= 7
            if v:
                b.append(c | 128)
            else:
                b.append(c)
                return
    for row in grid:
        idx = np.flatnonzero(np.diff(row)) + 1
        starts = np.concatenate(([0], idx))
        ends = np.concatenate((idx, [n]))
        for s, t in zip(starts, ends):
            varint(int(t - s) << 4 | int(row[s]))
    return bytes(b)


def exact_shares(polys, rect):
    """Class shares of `rect` from the polygons, smallest painted last (as rasterise()), gaps filled (as close_gaps)."""
    r = sbox(*rect)
    rp = prep(r)
    hit = [p for p in polys if rp.intersects(p[2])]
    covered = None
    area = {}
    for _a, c, g, _s in sorted(hit, key=lambda p: p[0]):  # smallest first: it wins
        part = g.intersection(r)
        if covered is not None:
            part = part.difference(covered)
        area[c] = area.get(c, 0.0) + part.area
        covered = part if covered is None else unary_union([covered, part])
    # the bake's gap filling (close_gaps): unclassified ground within CLOSE_M between two areas of one class takes it
    # (here as a morphological closing of the class's union, by CLOSE_M / 2)
    for c in sorted(area):
        u = unary_union([p[2] for p in hit if p[1] == c])
        extra = u.buffer(CLOSE_M / 2).buffer(-CLOSE_M / 2).intersection(r)
        if covered is not None:
            extra = extra.difference(covered)
        if extra.area > 0:
            area[c] += extra.area
            covered = extra if covered is None else unary_union([covered, extra])
    tot = r.area
    out = {NAMES[c]: round(v / tot, 4) for c, v in sorted(area.items()) if v > 0}
    out['none'] = round(1 - sum(area.values()) / tot, 4)
    return out


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    opts = dict(a[2:].split('=') for a in sys.argv[1:] if a.startswith('--'))
    if len(args) < 3:
        sys.exit(__doc__)
    out, topo_dir, inputs = args[0], args[1], args[2:]
    cell = float(opts.get('cell', 16))
    h = Areas()
    with merged_input(inputs) as path:
        h.apply_file(path, locations=True, idx='flex_mem')
    osm = h.polys
    topo = drop_mapped(osm, topo_polys(topo_dir))
    polys = osm + topo
    grid = close_gaps(rasterise(polys, cell), int(round(CLOSE_M / cell)))
    stamps = [header_time(p) for p in inputs]
    attribution = ('© OpenStreetMap contributors, ODbL 1.0; LINZ Topo50, CC BY 4.0. Data: ' +
                   ', '.join(f'{os.path.basename(p)} ({t})' for p, t in zip(inputs, stamps)))
    data = encode(grid, cell, attribution)
    gz = gzip.compress(data, 9, mtime=0)
    with open(out, 'wb') as f:
        f.write(gz)
    counts = np.bincount(grid.ravel(), minlength=len(NAMES))
    suburbs = {}
    for name, (lat, lon) in SUBURBS.items():
        x, z = world(lat, lon)
        rect = (x - SUBURB_HALF, z - SUBURB_HALF, x + SUBURB_HALF, z + SUBURB_HALF)
        suburbs[name] = dict(rect=[round(v, 1) for v in rect], shares=exact_shares(polys, rect))
    entry = dict(
        output=os.path.relpath(out, os.path.dirname(os.path.abspath(__file__))),
        cell_m=cell, cols=grid.shape[1], rows=grid.shape[0],
        bytes=len(data), gzip_bytes=len(gz), sha256=hashlib.sha256(gz).hexdigest(),
        inputs=[dict(file=os.path.basename(p), timestamp=t, sha256=sha256(p)) for p, t in zip(inputs, stamps)] +
               [dict(file=f'topo-{l}.json', sha256=sha256(os.path.join(topo_dir, f'topo-{l}.json'))) for l in (50281, 50255)],
        polygons=dict(osm=len(osm), topo50=len(topo)),
        km2={NAMES[i]: round(float(counts[i]) * cell * cell / 1e6, 2) for i in range(1, len(NAMES))},
        suburbs=suburbs,
    )
    mpath = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'manifest.json')
    if opts.get('manifest', '1') != '0':
        m = json.load(open(mpath)) if os.path.exists(mpath) else {}
        m['landuse'] = entry
        with open(mpath, 'w') as f:
            json.dump(m, f, indent=2, ensure_ascii=False)
            f.write('\n')
    print(json.dumps({k: v for k, v in entry.items() if k != 'suburbs'}, indent=2, ensure_ascii=False))


if __name__ == '__main__':
    main()
