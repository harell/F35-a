"""
Bake OpenStreetMap layers into compact game data for the Auckland theatre.

Inputs: one or more OSM extracts (.osm.pbf / .osm / .osm.gz) covering the world box (see README.md). Several
are merged into one first (each object once, at its newest version), so a supplement can fill a gap in a
regional extract and an area cut at an extract's edge is assembled from both.

Output (gzip): src/world/scenery/data/auckland-osm.bin, decoded by src/world/scenery/aucklandOsm.ts.
Only the layers the game reads are kept (roads, streets and buildings come from LINZ, tools/linz):
  aeroway   aerodrome, runway, taxiway, apron, hangar (+ building=hangar), terminal, control tower, helipad
  waterside man_made=pier, man_made=breakwater, leisure=marina, landuse=port (or industrial=port), waterway=dock
  sites     man_made=storage_tank (>= 8 m across), landuse=military, military=naval_base, industrial=oil (fuel
            terminals), leisure=stadium (>= 1 ha) and its building=grandstand, and the buildings inside the
            port, military / naval and fuel-terminal areas (with their height)
plus, per aerodrome, a derived "airfield core" outline: the union of its runway strips, taxiways, aprons
and hangars, buffered and simplified, which the terrain flattener follows (src/world/terrain/features.ts).

Projection: the game's equirectangular formula (geoToWorld in src/core/auckland.ts): origin = Sky Tower,
+X east, +Z south, metres. Not NZTM: the landmarks and the LINZ layers use the same formula.

The data is © OpenStreetMap contributors and licensed under the ODbL 1.0; the baked file is a derivative
database under the same licence (docs/CREDITS.md). The header carries the attribution and the source
timestamps, and tools/osm/manifest.json the inputs' SHA-256, so the file can be rebuilt.

Usage: python3 bake.py <out.bin> <extract> [<extract> ...]
"""
import gzip, hashlib, json, math, os, sys
import osmium
from shapely.geometry import LineString, Polygon, Point, MultiPolygon
from shapely.ops import unary_union

O_LAT, O_LON = -36.8485, 174.7622
M_LAT = 110_950.0
M_LON = 111_320.0 * math.cos(math.radians(O_LAT))
# World box (lat/lon) the game covers: ±40 km round the Sky Tower plus margin.
BBOX = (174.31, -37.21, 175.21, -36.49)  # min lon, min lat, max lon, max lat
Q = 0.5             # vertex quantum (m)
SIMPLIFY = 1.0      # Douglas-Peucker tolerance (m)
MIN_TANK = 8.0      # storage tanks narrower than this (farm water tanks) are dropped (m)
MIN_STADIUM = 10_000.0  # stadiums smaller than this (m²) are dropped (club grounds)
MIN_SITE_RING = 2_000.0  # outer rings of multi-part port / depot / dock areas smaller than this (m²) are dropped
LEVEL_M = 3.5       # storey height (m) when a building has building:levels but no height
VERSION = 1

# Layer ids: keep in sync with OSM_* in src/world/scenery/aucklandOsm.ts
L = dict(aerodrome=0, runway=1, taxiway=2, apron=3, hangar=4, terminal=5, tower=6, helipad=7,
         pier=8, breakwater=9, marina=10, port=11, tank=12, military=13, naval=14, core=15,
         dock=16, depot=17, stadium=18, grandstand=19, building=20)
AREA_LAYERS = {'aerodrome', 'apron', 'hangar', 'terminal', 'marina', 'port', 'tank', 'military', 'naval', 'core',
               'dock', 'depot', 'stadium', 'grandstand', 'building'}
# Areas whose buildings are kept (layer 'building'): the strategic sites and the port
SITE_LAYERS = ('port', 'military', 'naval', 'depot')
# Areas that keep every sizeable outer ring (one feature each), not only the largest
MULTI_LAYERS = ('port', 'depot', 'dock')
PAVED = {'asphalt', 'concrete', 'paved', 'sealed', 'concrete:plates', 'paving_stones', 'metal'}
# Default widths (m) when the tag is missing
DEF_WIDTH = {'runway': 45.0, 'taxiway': 18.0}

def world(lat, lon):
    return ((lon - O_LON) * M_LON, (O_LAT - lat) * M_LAT)

def in_box(lat, lon):
    return BBOX[0] <= lon <= BBOX[2] and BBOX[1] <= lat <= BBOX[3]

def num(v):
    if not v:
        return 0.0
    try:
        return float(v.replace('m', '').replace(',', '.').split(';')[0].strip())
    except ValueError:
        return 0.0

def layer_of(t, area):
    a = t.get('aeroway')
    if a == 'aerodrome' and area:
        return 'aerodrome'
    if a in ('runway', 'taxiway') and not area:
        return a
    if a == 'apron' and area:
        return 'apron'
    if (a == 'hangar' or t.get('building') == 'hangar') and area:
        return 'hangar'
    if a == 'terminal' and area:
        return 'terminal'
    if a == 'control_tower' or (t.get('man_made') == 'tower' and t.get('tower:type') in ('observation', 'air_traffic_control') and a):
        return 'tower'
    if a == 'helipad':
        return 'helipad'
    mm = t.get('man_made')
    if mm == 'pier':
        return 'pier'
    if mm == 'breakwater':
        return 'breakwater'
    if t.get('leisure') == 'marina' and area:
        return 'marina'
    if (t.get('landuse') == 'port' or t.get('industrial') == 'port') and area:
        return 'port'
    if t.get('waterway') == 'dock' and area:
        return 'dock'
    if t.get('industrial') == 'oil' and t.get('landuse') == 'industrial' and area:
        return 'depot'
    if t.get('leisure') == 'stadium' and area:
        return 'stadium'
    if t.get('building') == 'grandstand' and area:
        return 'grandstand'
    if mm == 'storage_tank' and area:
        return 'tank'
    if t.get('military') == 'naval_base' and area:
        return 'naval'
    if t.get('landuse') == 'military' and area:
        return 'military'
    return None

class Collector(osmium.SimpleHandler):
    """Collects the kept layers as world-space geometry, keyed by OSM id (first input wins)."""

    def __init__(self, store):
        super().__init__()
        self.store = store

    def _add(self, key, layer, t, pts, area):
        if key in self.store or len(pts) < (3 if area else 2) and layer not in ('tower', 'helipad'):
            return
        self.store[key] = dict(layer=layer, tags=t, pts=pts, area=area)

    def node(self, n):
        t = n.tags
        if 'aeroway' not in t and 'man_made' not in t:
            return
        lay = layer_of(dict(t), False)
        if lay in ('tower', 'helipad') and in_box(n.location.lat, n.location.lon):
            self._add(('n', n.id), lay, dict(t), [world(n.location.lat, n.location.lon)], False)

    def way(self, w):
        t = w.tags
        if not any(k in t for k in ('aeroway', 'man_made')):
            return
        tags = dict(t)
        # closed piers / breakwaters tagged as areas come through area(); open ones are lines
        lay = layer_of(tags, False)
        if lay not in ('runway', 'taxiway', 'pier', 'breakwater'):
            return
        if lay in ('pier', 'breakwater') and w.is_closed() and tags.get('area') == 'yes':
            return
        try:
            locs = [(n.location.lat, n.location.lon) for n in w.nodes]
        except osmium.InvalidLocationError:
            return
        if not any(in_box(a, b) for a, b in locs):
            return
        self._add(('w', w.id), lay, tags, [world(a, b) for a, b in locs], False)

    def area(self, a):
        tags = dict(a.tags)
        lay = layer_of(tags, True)
        if lay is None or lay in ('runway', 'taxiway', 'helipad'):
            return
        if lay in ('pier', 'breakwater') and tags.get('area') != 'yes' and a.from_way():
            return  # an open-style closed pier way stays a line (handled in way())
        best = None
        rings = []
        try:
            for outer in a.outer_rings():
                ring = [(n.lat, n.lon) for n in outer]
                if not any(in_box(la, lo) for la, lo in ring):
                    continue
                pts = [world(la, lo) for la, lo in ring]
                rings.append(pts)
                if best is None or len(pts) > len(best):
                    best = pts
                if lay not in ('aerodrome', 'military', 'naval', 'port', 'marina', 'depot', 'dock'):
                    break
        except osmium.InvalidLocationError:
            return
        if best is None:
            return
        key = ('w' if a.from_way() else 'r', a.orig_id())
        if lay in MULTI_LAYERS and len(rings) > 1:
            for i, pts in enumerate(rings):
                if Polygon(pts).buffer(0).area >= MIN_SITE_RING:
                    self._add(key + (i,), lay, tags, pts, True)
            return
        self._add(key, lay, tags, best, True)

class SiteBuildings(osmium.SimpleHandler):
    """Second pass: the buildings (OSM building=*) whose centre lies inside one of the site areas."""

    def __init__(self, store, sites):
        super().__init__()
        from shapely.prepared import prep
        self.store = store
        self.sites = [prep(Polygon(s).buffer(0)) for s in sites]
        self.box = [unary_union([Polygon(s).buffer(0) for s in sites]).bounds] if sites else []

    def area(self, a):
        t = a.tags
        if 'building' not in t or t.get('building') in ('grandstand', 'hangar', 'roof', 'no') or 'aeroway' in t:
            return
        if t.get('man_made') == 'storage_tank':
            return
        key = ('w' if a.from_way() else 'r', a.orig_id())
        if key in self.store:
            return
        try:
            outer = next(iter(a.outer_rings()))
            pts = [world(n.lat, n.lon) for n in outer]
        except (osmium.InvalidLocationError, StopIteration):
            return
        if len(pts) < 4:
            return
        cx = sum(p[0] for p in pts) / len(pts)
        cz = sum(p[1] for p in pts) / len(pts)
        x0, z0, x1, z1 = self.box[0]
        if not (x0 <= cx <= x1 and z0 <= cz <= z1):
            return
        c = Point(cx, cz)
        if not any(s.contains(c) for s in self.sites):
            return
        tags = dict(t)
        h = num(tags.get('height')) or num(tags.get('building:levels')) * LEVEL_M
        tags['width'] = str(round(h, 1)) if h else ''
        self.store[key] = dict(layer='building', tags=tags, pts=pts, area=True)

def simplify(pts, area):
    if len(pts) <= 2:
        return pts
    if area:
        g = Polygon(pts)
        if not g.is_valid:
            g = g.buffer(0)
        g = g.simplify(SIMPLIFY, preserve_topology=True)
        if g.is_empty:
            return []
        if isinstance(g, MultiPolygon):
            g = max(g.geoms, key=lambda p: p.area)
        out = list(g.exterior.coords)[:-1]
        return out
    return list(LineString(pts).simplify(SIMPLIFY).coords)

def merge_runways(items):
    """OSM often splits a runway into several ways (displaced thresholds, blast pads): join collinear
    pieces with the same ref end-to-end into one centreline."""
    rws = [it for it in items if it['layer'] == 'runway']
    rest = [it for it in items if it['layer'] != 'runway']
    groups = {}
    for r in rws:
        groups.setdefault((r['tags'].get('ref') or '', r['tags'].get('surface') or ''), []).append(r)
    out = []
    for (ref, _), lst in groups.items():
        if not ref:
            out.extend(lst)
            continue
        # cluster pieces that touch (within 5 m)
        pending = list(lst)
        while pending:
            cur = pending.pop()
            pts = list(cur['pts'])
            tags = dict(cur['tags'])
            grown = True
            while grown:
                grown = False
                for o in pending:
                    q = list(o['pts'])
                    if math.dist(pts[-1], q[0]) < 5:
                        pts = pts + q[1:]
                    elif math.dist(pts[-1], q[-1]) < 5:
                        pts = pts + q[::-1][1:]
                    elif math.dist(pts[0], q[-1]) < 5:
                        pts = q[:-1] + pts
                    elif math.dist(pts[0], q[0]) < 5:
                        pts = q[::-1][:-1] + pts
                    else:
                        continue
                    pending.remove(o)
                    tags = {**o['tags'], **tags}
                    grown = True
                    break
            out.append(dict(cur, tags=tags, pts=pts))
    return out + rest

def airfield_cores(items):
    """Per aerodrome: union of runway strips (150 m each side of a paved runway, 40 m grass), taxiways,
    aprons and hangars, buffered, holes filled, simplified to 15 m. The terrain levels this area."""
    out = []
    for ad in [it for it in items if it['layer'] == 'aerodrome']:
        poly = Polygon(ad['pts']).buffer(0)
        parts = []
        for it in items:
            lay = it['layer']
            if lay not in ('runway', 'taxiway', 'apron', 'hangar', 'terminal'):
                continue
            g = Polygon(it['pts']).buffer(0) if it['area'] else LineString(it['pts'])
            if not poly.buffer(200).intersects(g):
                continue
            if lay == 'runway':
                paved = (it['tags'].get('surface') or '') in PAVED
                w = num(it['tags'].get('width')) or DEF_WIDTH['runway']
                parts.append(g.buffer((150.0 if paved else 40.0) if w >= 25 or paved else 40.0, cap_style='flat'))
                # the runway end safety areas, 90 m beyond each threshold
                parts.append(g.buffer(w / 2 + 30, cap_style='square'))
            elif lay == 'taxiway':
                parts.append(g.buffer(35))
            else:
                parts.append(g.buffer(30))
        if not parts:
            continue
        u = unary_union(parts)
        u = u.buffer(40).buffer(-40)  # close small gaps between strips
        geoms = list(u.geoms) if isinstance(u, MultiPolygon) else [u]
        for g in geoms:
            if g.area < 20_000:
                continue
            g = Polygon(g.exterior).simplify(15, preserve_topology=True)
            out.append(dict(layer='core', tags={'name': ad['tags'].get('name', ''), 'icao': ad['tags'].get('icao', '')}, pts=list(g.exterior.coords)[:-1], area=True))
    return out

class Writer:
    def __init__(self):
        self.b = bytearray()
    def u8(self, v):
        self.b.append(v & 255)
    def u32(self, v):
        self.b += int(v).to_bytes(4, 'little')
    def f32(self, v):
        import struct
        self.b += struct.pack('<f', v)
    def varint(self, v):
        assert v >= 0
        while True:
            c = v & 127
            v >>= 7
            if v:
                self.u8(c | 128)
            else:
                self.u8(c)
                return

zig = lambda v: -2 * v - 1 if v < 0 else 2 * v

def encode(items, attribution):
    strings = ['']
    sidx = {'': 0}
    def s(v):
        v = (v or '')[:255]
        if v not in sidx:
            sidx[v] = len(strings)
            strings.append(v)
        return sidx[v]
    recs = []
    for it in items:
        t = it['tags']
        name = s(t.get('name'))
        ref = s(t.get('ref') or t.get('icao'))
        width = num(t.get('width')) or DEF_WIDTH.get(it['layer'], 0.0)
        flags = (1 if it['area'] else 0) | (2 if (t.get('surface') or '') in PAVED else 0)
        if it['layer'] == 'tank':
            flags |= 4 if t.get('content') in ('oil', 'fuel', 'petroleum', 'gas', 'diesel', 'lpg') else 0
        recs.append((L[it['layer']], flags, name, ref, int(round(width * 2)), it['pts']))
    s(attribution)
    w = Writer()
    for c in b'AKLO':
        w.u8(c)
    w.u32(VERSION)
    w.f32(Q)
    w.u32(len(strings))
    w.u32(len(recs))
    w.varint(sidx[attribution])
    for st in strings:
        e = st.encode('utf-8')[:255]
        w.u8(len(e))
        w.b += e
    px = pz = 0
    for lay, flags, name, ref, width, pts in recs:
        w.u8(lay)
        w.u8(flags)
        w.varint(name)
        w.varint(ref)
        w.varint(width)
        w.varint(len(pts))
        for x, z in pts:
            qx, qz = round(x / Q), round(z / Q)
            w.varint(zig(qx - px))
            w.varint(zig(qz - pz))
            px, pz = qx, qz
    return bytes(w.b)

def header_time(path):
    """The extract's replication timestamp; for a file without one (an OSM API download) its file time."""
    try:
        r = osmium.io.Reader(path, osmium.osm.osm_entity_bits.NOTHING)
        h = r.header()
        r.close()
        t = h.get('osmosis_replication_timestamp') or h.get('timestamp')
        if t:
            return t
    except Exception:
        pass
    import datetime
    t = datetime.datetime.fromtimestamp(os.path.getmtime(path), datetime.timezone.utc)
    return 'downloaded ' + t.strftime('%Y-%m-%dT%H:%MZ')

def sha256(path):
    d = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            d.update(chunk)
    return d.hexdigest()

class merged_input:
    """Context manager: the path of one file holding every input's objects, each once at its newest version
    (osmium's merge, sorted by type and id). A single input is used as it is."""

    def __init__(self, inputs):
        self.inputs = list(inputs)
        self.tmp = None

    def __enter__(self):
        if len(self.inputs) == 1:
            return self.inputs[0]
        import tempfile
        fd, self.tmp = tempfile.mkstemp(suffix='.osm.pbf')
        os.close(fd)
        os.remove(self.tmp)
        reader = osmium.MergeInputReader()
        for p in self.inputs:
            reader.add_file(p)
        writer = osmium.SimpleWriter(self.tmp)
        reader.apply(writer, simplify=True)
        writer.close()
        return self.tmp

    def __exit__(self, *exc):
        if self.tmp and os.path.exists(self.tmp):
            os.remove(self.tmp)

def main():
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    out = sys.argv[1]
    inputs = sys.argv[2:]
    store = {}
    with merged_input(inputs) as src:
        Collector(store).apply_file(src, locations=True, idx='flex_mem')
        sites = [it['pts'] for it in store.values() if it['layer'] in SITE_LAYERS and it['area']]
        SiteBuildings(store, sites).apply_file(src, locations=True, idx='flex_mem')
    items = []
    for it in store.values():
        lay = it['layer']
        pts = simplify(it['pts'], it['area'])
        if len(pts) < (3 if it['area'] else 2) and lay not in ('tower', 'helipad'):
            continue
        if lay == 'tank':
            g = Polygon(pts)
            if 2 * math.sqrt(g.area / math.pi) < MIN_TANK:
                continue
        if lay == 'stadium' and Polygon(pts).buffer(0).area < MIN_STADIUM:
            continue
        items.append(dict(it, pts=pts))
    items = merge_runways(items)
    items += airfield_cores(items)
    # stable order: by layer, then position (deterministic bakes, better delta compression)
    items.sort(key=lambda it: (L[it['layer']], round(it['pts'][0][1] / 500), it['pts'][0][0]))
    stamps = [header_time(p) for p in inputs]
    attribution = '© OpenStreetMap contributors, ODbL 1.0. Data: ' + ', '.join(f'{os.path.basename(p)} ({t})' for p, t in zip(inputs, stamps))
    data = encode(items, attribution)
    gz = gzip.compress(data, 9, mtime=0)
    with open(out, 'wb') as f:
        f.write(gz)
    counts = {}
    for it in items:
        counts[it['layer']] = counts.get(it['layer'], 0) + 1
    manifest = dict(
        output=os.path.relpath(out, os.path.dirname(os.path.abspath(__file__))),
        bytes=len(data), gzip_bytes=len(gz), sha256=hashlib.sha256(gz).hexdigest(),
        bbox=BBOX, simplify_m=SIMPLIFY, quantum_m=Q,
        inputs=[dict(file=os.path.basename(p), timestamp=t, sha256=sha256(p)) for p, t in zip(inputs, stamps)],
        layers=dict(sorted(counts.items())),
    )
    mpath = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'manifest.json')
    if os.path.exists(mpath):
        old = json.load(open(mpath))
        if 'landuse' in old:  # landuse.py's entry (same inputs, its own output)
            manifest['landuse'] = old['landuse']
    with open(mpath, 'w') as f:
        json.dump(manifest, f, indent=2, ensure_ascii=False)
        f.write('\n')
    print(json.dumps(manifest, indent=2, ensure_ascii=False))

if __name__ == '__main__':
    main()
