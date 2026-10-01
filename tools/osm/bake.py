"""
Bake OpenStreetMap layers into compact game data for the Auckland theatre.

Inputs: one or more OSM extracts (.osm.pbf / .osm / .osm.gz) covering the world box, normally the pinned
Geofabrik New Zealand extract clipped by fetch.py (see README.md). Later files only add objects the
earlier ones lack (same OSM id = same object), so a small supplement can fill a gap in a regional extract.

Output (gzip): src/world/scenery/data/auckland-osm.bin, decoded by src/world/scenery/aucklandOsm.ts.
Only the layers the game reads are kept (roads, streets and buildings come from LINZ, tools/linz):
  aeroway   aerodrome, runway, taxiway, apron, hangar (+ building=hangar), terminal, control tower, helipad
  waterside man_made=pier (flag: floating), man_made=breakwater, leisure=marina, port land (landuse=port,
            industrial=port, man_made=container_terminal), waterway=dock (dry docks), seamark:type=berth (points),
            man_made=crane (points; flag: container crane)
  sites     man_made=storage_tank (>= 8 m across), landuse=military, military=naval_base, the buildings inside
            military / naval land (outside aerodromes; height in the width field), leisure=stadium and the
            leisure=pitch inside a stadium, man_made=bridge outlines longer than 600 m (the big harbour bridges)
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
from shapely.prepared import prep

O_LAT, O_LON = -36.8485, 174.7622
M_LAT = 110_950.0
M_LON = 111_320.0 * math.cos(math.radians(O_LAT))
# World box (lat/lon) the game covers: ±40 km round the Sky Tower plus margin.
BBOX = (174.31, -37.21, 175.21, -36.49)  # min lon, min lat, max lon, max lat
Q = 0.5             # vertex quantum (m)
SIMPLIFY = 1.0      # Douglas-Peucker tolerance (m)
MIN_TANK = 8.0      # storage tanks narrower than this (farm water tanks) are dropped (m)
VERSION = 2
MIN_BUILDING = 30.0  # building footprints smaller than this (sheds, kiosks) are dropped (m²)
MIN_BRIDGE = 600.0   # only bridge outlines at least this long are kept (m)

# Layer ids: keep in sync with OSM_* in src/world/scenery/aucklandOsm.ts
L = dict(aerodrome=0, runway=1, taxiway=2, apron=3, hangar=4, terminal=5, tower=6, helipad=7,
         pier=8, breakwater=9, marina=10, port=11, tank=12, military=13, naval=14, core=15,
         dock=16, berth=17, crane=18, stadium=19, pitch=20, building=21, bridge=22)
AREA_LAYERS = {'aerodrome', 'apron', 'hangar', 'terminal', 'marina', 'port', 'tank', 'military', 'naval', 'core',
               'dock', 'stadium', 'pitch', 'building', 'bridge'}
POINT_LAYERS = {'tower', 'helipad', 'berth', 'crane'}
FUEL = ('oil', 'fuel', 'petroleum', 'gas', 'diesel', 'lpg')
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
    if mm == 'crane' and not area:
        return 'crane'
    if t.get('seamark:type') == 'berth' and not area:
        return 'berth'
    if area and (t.get('landuse') == 'port' or (t.get('landuse') == 'industrial' and t.get('industrial') == 'port') or mm == 'container_terminal'):
        return 'port'
    if mm == 'storage_tank' and area:
        return 'tank'
    if t.get('military') == 'naval_base' and area:
        return 'naval'
    if t.get('landuse') == 'military' and area:
        return 'military'
    if t.get('waterway') == 'dock' and area:
        return 'dock'
    if t.get('leisure') == 'stadium' and area:
        return 'stadium'
    if t.get('leisure') == 'pitch' and area:
        return 'pitch'
    if mm == 'bridge' and area:
        return 'bridge'
    if t.get('building') and t.get('building') != 'no' and area:
        return 'building'
    return None

class Collector(osmium.SimpleHandler):
    """Collects the kept layers as world-space geometry, keyed by OSM id (first input wins). Buildings are
    skipped unless `buildings` (a prepared region) is given; then only buildings are collected, and only those
    whose footprint centre lies inside the region."""

    def __init__(self, store, buildings=None):
        super().__init__()
        self.store = store
        self.buildings = buildings

    def _add(self, key, layer, t, pts, area):
        if key in self.store or len(pts) < (3 if area else 2) and layer not in POINT_LAYERS:
            return
        self.store[key] = dict(layer=layer, tags=t, pts=pts, area=area)

    def node(self, n):
        if self.buildings is not None:
            return
        t = n.tags
        if 'aeroway' not in t and 'man_made' not in t and 'seamark:type' not in t:
            return
        lay = layer_of(dict(t), False)
        if lay in POINT_LAYERS and in_box(n.location.lat, n.location.lon):
            self._add(('n', n.id), lay, dict(t), [world(n.location.lat, n.location.lon)], False)

    def way(self, w):
        if self.buildings is not None:
            return
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
        if lay is None or lay in ('runway', 'taxiway') or lay in POINT_LAYERS:
            return
        if (lay == 'building') != (self.buildings is not None):
            return
        if lay in ('pier', 'breakwater') and tags.get('area') != 'yes' and a.from_way():
            return  # an open-style closed pier way stays a line (handled in way())
        best = None
        try:
            for outer in a.outer_rings():
                ring = [(n.lat, n.lon) for n in outer]
                if not any(in_box(la, lo) for la, lo in ring):
                    continue
                pts = [world(la, lo) for la, lo in ring]
                if best is None or len(pts) > len(best):
                    best = pts
                if lay not in ('aerodrome', 'military', 'naval', 'port', 'marina', 'stadium'):
                    break
        except osmium.InvalidLocationError:
            return
        if best is None:
            return
        if lay == 'building':
            g = Polygon(best)
            if not g.is_valid or g.area < MIN_BUILDING or not self.buildings.contains(g.representative_point()):
                return
        key = ('w' if a.from_way() else 'r', a.orig_id())
        self._add(key, lay, tags, best, True)

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

def building_region(store):
    """Where buildings are kept (prepared geometry): military and naval land outside every aerodrome."""
    def union(layers):
        gs = [Polygon(it['pts']).buffer(0) for it in store.values() if it['layer'] in layers and len(it['pts']) >= 3]
        return unary_union([g for g in gs if not g.is_empty])
    return prep(union({'military', 'naval'}).difference(union({'aerodrome'})))

def in_context(items):
    """Keep the context-dependent layers only where the game uses them: pitches inside a stadium and only the
    long bridge outlines (buildings were filtered while collecting, see building_region)."""
    def polys(layers):
        out = []
        for it in items:
            if it['layer'] in layers and len(it['pts']) >= 3:
                g = Polygon(it['pts']).buffer(0)
                if not g.is_empty:
                    out.append(g)
        return out
    stadiums = polys({'stadium'})
    kept = []
    for it in items:
        lay = it['layer']
        if lay == 'pitch':
            g = Polygon(it['pts']).buffer(0)
            if g.is_empty or not any(st.contains(g.representative_point()) for st in stadiums):
                continue
        elif lay == 'bridge':
            xs = [p[0] for p in it['pts']]
            zs = [p[1] for p in it['pts']]
            if math.hypot(max(xs) - min(xs), max(zs) - min(zs)) < MIN_BRIDGE:
                continue
        kept.append(it)
    return kept

def building_height(t):
    """Height (m) from the height or building:levels tag, 0 when OSM has neither."""
    h = num(t.get('height'))
    if h:
        return h
    lv = num(t.get('building:levels'))
    return lv * 3.2 + 1.0 if lv else 0.0

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
        lay = it['layer']
        name = s(t.get('name') or (t.get('official_name') if lay == 'crane' else None))
        ref = s(t.get('ref') or t.get('icao'))
        if lay == 'building':
            width = building_height(t)  # buildings: the width field holds the height
        else:
            width = num(t.get('width')) or DEF_WIDTH.get(lay, 0.0)
        flags = (1 if it['area'] else 0) | (2 if (t.get('surface') or '') in PAVED else 0)
        if lay == 'tank':
            flags |= 4 if t.get('content') in FUEL else 0
        if lay == 'pier' and t.get('floating') == 'yes':
            flags |= 8
        if lay == 'crane' and (t.get('seamark:crane:category') == 'container' or t.get('crane:type') == 'portal_crane' and t.get('operator') == 'Ports of Auckland'):
            flags |= 16
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

def main():
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    out = sys.argv[1]
    inputs = sys.argv[2:]
    store = {}
    for p in inputs:
        Collector(store).apply_file(p, locations=True, idx='flex_mem')
    # second pass: the buildings inside military / naval land (Devonport Naval Base), now that the land is known
    region = building_region(store)
    for p in inputs:
        Collector(store, region).apply_file(p, locations=True, idx='flex_mem')
    items = []
    for it in store.values():
        lay = it['layer']
        pts = simplify(it['pts'], it['area'])
        if len(pts) < (3 if it['area'] else 2) and lay not in POINT_LAYERS:
            continue
        if lay == 'tank':
            g = Polygon(pts)
            if 2 * math.sqrt(g.area / math.pi) < MIN_TANK:
                continue
        items.append(dict(it, pts=pts))
    items = in_context(items)
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
    with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'manifest.json'), 'w') as f:
        json.dump(manifest, f, indent=2, ensure_ascii=False)
        f.write('\n')
    print(json.dumps(manifest, indent=2, ensure_ascii=False))

if __name__ == '__main__':
    main()
