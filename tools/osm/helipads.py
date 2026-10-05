"""
Bake the helipad table of the Auckland theatre (issue #125) into src/core/helipadsData.ts: every OSM
`aeroway=helipad` and `aeroway=heliport` in the world box, as a node or a polygon, with its size, heading, name,
parent site (hospital, airfield, naval base, vineyard) and height; rooftop pads at the 2024 LiDAR DSM.

  pads      a node is a pad of DEFAULT_SIZE m (or its `diameter` / `width` tag) facing north; a polygon is its
            minimum rotated rectangle: centre, long side (size), short side, the long side's heading
  parent    the hospital (`amenity=hospital`), aerodrome, naval base, vineyard or heliport area containing the pad
  roof      a pad tagged `location=roof|rooftop` (or `roof`), or one inside a building outline, or inside a
            hospital's grounds with the LiDAR surface ROOF_MIN m above the ground at its centre
  height    rooftop pads: the median 2024 LiDAR 1 m DSM over the pad's central RING m square (Part 1 mainland,
            Part 2 gulf islands); ground pads: the DEM there (the game puts them on its terrain)
  area      waiheke | north_shore | isthmus | other (AREAS below, the same boxes as AREA_BOXES in core/sites.ts)

The manifest (manifest.json "helipads") gets the counts per kind and per area, which tests/world-helipads.test.ts
checks the table against. Data © OpenStreetMap contributors (ODbL 1.0; the table is a derivative database under the
same licence) and LINZ (LiDAR, CC BY 4.0).

Usage: python3 helipads.py <stac-cache-dir> <extract> [<extract> ...]
"""
import json, math, os, sys
import numpy as np
import osmium
from shapely.geometry import Point, Polygon, MultiPoint
from shapely.ops import unary_union
from shapely.prepared import prep
from bake import BBOX, in_box, world, header_time, sha256, merged_input

# tools/hero/site.py (loaded by path: `site` is also a standard module)
import importlib.util  # noqa: E402
_spec = importlib.util.spec_from_file_location('hero_site', os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'hero', 'site.py'))
_hero = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_hero)
ELEV, stac_tiles, mosaic, to_nztm = _hero.ELEV, _hero.stac_tiles, _hero.mosaic, _hero.to_nztm

DEFAULT_SIZE = 20.0   # m, a pad mapped as a node
RING = 8.0            # m, central square of a pad sampled for its roof height
ROOF_MIN = 4.0        # m of LiDAR surface above the ground that makes a hospital pad a rooftop pad
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'src', 'core', 'helipadsData.ts')

# Areas (game XZ, m): keep in sync with AREA_BOXES in src/core/sites.ts
AREAS = [
    ('waiheke', (18_500, -10_500, 36_500, 3_000)),
    ('north_shore', (-8_000, -22_000, 6_000, -1_900)),
    ('isthmus', (-9_000, -1_900, 14_000, 14_000)),
]


def area_of(x, z):
    for name, (x0, z0, x1, z1) in AREAS:
        if x0 <= x <= x1 and z0 <= z <= z1:
            return name
    return 'other'


def num(v):
    try:
        return float(str(v).replace('m', '').replace(',', '.').split(';')[0].strip())
    except (ValueError, TypeError):
        return 0.0


class Collect(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.pads = []
        self.sites = []      # (kind, name, polygon)
        self.buildings = []  # polygons (only those near a pad are kept, later)

    def _pad(self, kind_tag, t, x, z, size, width, heading, osm_id, geom):
        self.pads.append(dict(osm=osm_id, heliport=kind_tag == 'heliport', name=t.get('name', ''), ref=t.get('ref', ''),
                              x=x, z=z, size=size, width=width, heading=heading,
                              roof_tag=t.get('location') in ('roof', 'rooftop') or t.get('roof') == 'yes' or t.get('building') == 'roof',
                              surface=t.get('surface', ''), geom=geom))

    def node(self, n):
        a = n.tags.get('aeroway')
        if a not in ('helipad', 'heliport') or not in_box(n.location.lat, n.location.lon):
            return
        t = dict(n.tags)
        x, z = world(n.location.lat, n.location.lon)
        size = num(t.get('diameter')) or num(t.get('width')) or DEFAULT_SIZE
        heading = math.radians(num(t.get('direction'))) if t.get('direction') else 0.0
        self._pad(a, t, x, z, size, size, heading, f'n{n.id}', None)

    def area(self, ar):
        t = ar.tags
        a = t.get('aeroway')
        kind = None
        if a in ('helipad', 'heliport'):
            kind = 'pad'
        elif t.get('amenity') == 'hospital' or t.get('healthcare') == 'hospital':
            kind = 'hospital'
        elif a == 'aerodrome':
            kind = 'airfield'
        elif t.get('military') == 'naval_base':
            kind = 'naval'
        elif t.get('landuse') == 'vineyard' or t.get('craft') == 'winery':
            kind = 'vineyard'
        elif 'building' in t and t.get('building') != 'no':
            kind = 'building'
        if kind is None:
            return
        try:
            parts = [Polygon([world(n.lat, n.lon) for n in outer]).buffer(0) for outer in ar.outer_rings()]
        except (osmium.InvalidLocationError, ValueError):
            return
        parts = [p for p in parts if not p.is_empty and p.area > 0]
        if not parts:
            return
        g = unary_union(parts)
        if kind == 'pad':
            c = g.centroid
            if not in_box(-36.8485 - c.y / 110_950.0, 174.7622 + c.x / (111_320.0 * math.cos(math.radians(-36.8485)))):
                return
            r = g.minimum_rotated_rectangle
            pts = list(r.exterior.coords)[:4] if r.geom_type == 'Polygon' else [(c.x, c.y)] * 4
            e1 = (pts[1][0] - pts[0][0], pts[1][1] - pts[0][1])
            e2 = (pts[2][0] - pts[1][0], pts[2][1] - pts[1][1])
            l1, l2 = math.hypot(*e1), math.hypot(*e2)
            long_e = e1 if l1 >= l2 else e2
            # heading of the long side: 0 = north (−Z), clockwise; folded to [0, π)
            hd = math.atan2(long_e[0], -long_e[1]) % math.pi
            self._pad(a, dict(t), c.x, c.y, max(l1, l2), min(l1, l2), hd, ('w' if ar.from_way() else 'r') + str(ar.orig_id()), g)
            if a == 'heliport':  # the pads mapped inside it take it as their parent site
                self.sites.append(('heliport', t.get('name', ''), g))
        elif kind == 'building':
            b = g.bounds
            if b[2] - b[0] < 400 and b[3] - b[1] < 400:
                self.buildings.append(g)
        else:
            self.sites.append((kind, t.get('name', ''), g))


def lidar_height(pads, cache):
    """DSM median over each pad's central square and DEM at its centre (m), by LiDAR part."""
    for p in pads:
        p['dsm'] = p['dem'] = None
    for part in (1, 2):
        for p in pads:
            if p['dsm'] is not None:
                continue
            lon = 174.7622 + p['x'] / (111_320.0 * math.cos(math.radians(-36.8485)))
            lat = -36.8485 - p['z'] / 110_950.0
            E, N = to_nztm.transform(lon, lat)
            h = RING / 2
            bbox = (lon - 0.0002, lat - 0.0002, lon + 0.0002, lat + 0.0002)
            vals = {}
            for kind in ('dsm', 'dem'):
                urls = stac_tiles(ELEV.format(part=part, kind=kind), bbox, cache)
                if not urls:
                    break
                a = mosaic(urls, round(E - h), round(N - h), round(E + h), round(N + h), 1.0, 1)
                if np.all(np.isnan(a)):
                    break
                vals[kind] = float(np.nanmedian(a)) if kind == 'dsm' else float(a[a.shape[0] // 2, a.shape[1] // 2])
            if len(vals) == 2 and not math.isnan(vals['dem']):
                p['dsm'], p['dem'] = vals['dsm'], vals['dem']
                p['part'] = part


def main():
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    cache, inputs = sys.argv[1], sys.argv[2:]
    h = Collect()
    with merged_input(inputs) as path:
        h.apply_file(path, locations=True, idx='flex_mem')
    pads = h.pads
    # drop a node pad duplicating a polygon pad (the same pad mapped twice)
    polys = [p for p in pads if p['geom'] is not None]
    pads = [p for p in pads if p['geom'] is not None or not any(q['geom'].buffer(5).contains(Point(p['x'], p['z'])) for q in polys)]
    sites = [(k, n, prep(g), g) for k, n, g in h.sites]
    blds = [prep(b) for b in h.buildings]
    for p in pads:
        pt = Point(p['x'], p['z'])
        best = None
        for k, n, pg, g in sites:
            if pg.contains(pt) and (best is None or g.area < best[2].area):
                best = (k, n, g)
        p['kind'] = best[0] if best else ('heliport' if p['heliport'] else 'other')
        p['site'] = best[1] if best else ''
        p['in_building'] = any(b.contains(pt) for b in blds)
    lidar_height(pads, cache)
    for p in pads:
        nd = (p['dsm'] - p['dem']) if p['dsm'] is not None else 0.0
        p['roof'] = bool(p['roof_tag'] or p['in_building'] or (p['kind'] == 'hospital' and nd > ROOF_MIN))
        p['height'] = round(p['dsm'] if p['roof'] and p['dsm'] is not None else (p['dem'] if p['dem'] is not None else 0.0), 1)
        p['area'] = area_of(p['x'], p['z'])
    pads.sort(key=lambda p: (p['area'], round(p['z']), round(p['x'])))
    seen = {}
    for p in pads:
        base = (p['site'] or p['name'] or p['area']).lower()
        base = ''.join(ch if ch.isalnum() else '_' for ch in base).strip('_')
        while '__' in base:
            base = base.replace('__', '_')
        seen[base] = seen.get(base, 0) + 1
        p['id'] = f"{base}_{seen[base]}" if seen[base] > 1 or not base else base
    stamps = [header_time(p) for p in inputs]
    lines = [
        '/**',
        ' * GENERATED by tools/osm/helipads.py (#125): every OpenStreetMap `aeroway=helipad` / `aeroway=heliport` in the world',
        ' * box. © OpenStreetMap contributors, ODbL 1.0 (a derivative database, rebuilt with tools/osm); rooftop heights',
        ' * from the LINZ Auckland 2024 LiDAR 1 m DSM (CC BY 4.0). Inputs: ' + ', '.join(f'{os.path.basename(a)} ({t})' for a, t in zip(inputs, stamps)) + '.',
        ' * Do not edit by hand: re-run the bake (tools/osm/README.md).',
        ' */',
        "import type { Helipad } from './sites';",
        '',
        'export const HELIPADS_DATA: readonly Helipad[] = [',
    ]
    for p in pads:
        rec = dict(id=p['id'], name=p['name'] or p['site'], x=round(p['x'], 1), z=round(p['z'], 1), height=p['height'],
                   heading=round(p['heading'], 3), size=round(p['size'], 1), width=round(p['width'], 1), kind=p['kind'],
                   site=p['site'], roof=p['roof'], heliport=p['heliport'], area=p['area'], osm=p['osm'])
        lines.append('  ' + json.dumps(rec, ensure_ascii=False).replace('"id":', 'id:').replace('"name":', 'name:')
                     .replace('"x":', 'x:').replace('"z":', 'z:').replace('"height":', 'height:').replace('"heading":', 'heading:')
                     .replace('"size":', 'size:').replace('"width":', 'width:').replace('"kind":', 'kind:').replace('"site":', 'site:')
                     .replace('"roof":', 'roof:').replace('"heliport":', 'heliport:').replace('"area":', 'area:').replace('"osm":', 'osm:') + ',')
    lines.append('];')
    lines.append('')
    open(OUT, 'w').write('\n'.join(lines))
    by = lambda key: dict(sorted({v: sum(1 for p in pads if p[key] == v) for v in {p[key] for p in pads}}.items()))
    entry = dict(
        output='../../src/core/helipadsData.ts', osm_objects=len(h.pads), total=len(pads), helipads=sum(1 for p in pads if not p['heliport']),
        heliports=sum(1 for p in pads if p['heliport']), roof=sum(1 for p in pads if p['roof']),
        mapped_as=dict(node=sum(1 for p in pads if p['geom'] is None), polygon=sum(1 for p in pads if p['geom'] is not None)),
        by_area=by('area'), by_kind=by('kind'),
        roof_pads={p['id']: dict(dsm=round(p['dsm'], 2), dem=round(p['dem'], 2), height=p['height']) for p in pads if p['roof'] and p['dsm'] is not None},
        inputs=[dict(file=os.path.basename(a), timestamp=t, sha256=sha256(a)) for a, t in zip(inputs, stamps)],
    )
    mpath = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'manifest.json')
    m = json.load(open(mpath))
    m['helipads'] = entry
    with open(mpath, 'w') as f:
        json.dump(m, f, indent=2, ensure_ascii=False)
        f.write('\n')
    print(json.dumps({k: v for k, v in entry.items() if k != 'roof_pads'}, indent=2, ensure_ascii=False))
    for p in pads:
        if p['roof'] or p['kind'] == 'hospital':
            print(p['id'], p['kind'], p['site'], 'roof' if p['roof'] else 'ground', p['dsm'], p['dem'], p['height'])


if __name__ == '__main__':
    main()
