#!/usr/bin/env python3
"""
Bake suburb, locality and island names for the briefing map (#129) into src/ui/art/aucklandPlaces.ts.

Sources (Toitū Te Whenua LINZ, CC BY 4.0), via LINZ's keyless ArcGIS Online mirrors:
  - NZ Suburbs and Localities (LDS layer 113764): official names with macrons, polygons and
    population_estimate. Label point = the polygon's pole of inaccessibility (grid search), so
    Devonport's label stays on land; priority = population.
  - NZ Place Names (NZGB, LDS layer 51681): islands (feat_type 'Island'), as points.

Run: python3 tools/linz/placenames.py   (network; writes the TS module; never at runtime)
"""
import json
import math
import urllib.parse
import urllib.request

ORIGIN_LAT, ORIGIN_LON = -36.8485, 174.7622  # AKL_ORIGIN (src/core/auckland.ts)
M_PER_DEG_LAT = 110_540
M_PER_DEG_LON = 111_320 * math.cos(math.radians(ORIGIN_LAT))
HALF = 44_000  # HF_EXTENT / 2 (src/world/terrain/types.ts)
BASE = 'https://services.arcgis.com/xdsHIIxuCWByZiCB/arcgis/rest/services'
OUT = 'src/ui/art/aucklandPlaces.ts'


def to_world(lon, lat):
    return (lon - ORIGIN_LON) * M_PER_DEG_LON, (ORIGIN_LAT - lat) * M_PER_DEG_LAT


def bbox():
    lon0 = ORIGIN_LON - HALF / M_PER_DEG_LON
    lon1 = ORIGIN_LON + HALF / M_PER_DEG_LON
    lat0 = ORIGIN_LAT - HALF / M_PER_DEG_LAT
    lat1 = ORIGIN_LAT + HALF / M_PER_DEG_LAT
    return f'{lon0},{lat0},{lon1},{lat1}'


def query(layer, where, fields, geometry=True, offset=0):
    q = {
        'where': where, 'geometry': bbox(), 'geometryType': 'esriGeometryEnvelope', 'inSR': 4326,
        'spatialRel': 'esriSpatialRelIntersects', 'outFields': fields, 'returnGeometry': 'true' if geometry else 'false',
        'outSR': 4326, 'maxAllowableOffset': 0.0002, 'resultOffset': offset, 'resultRecordCount': 1000, 'f': 'json',
    }
    url = f'{BASE}/{layer}/FeatureServer/0/query?' + urllib.parse.urlencode(q)
    with urllib.request.urlopen(url, timeout=60) as r:
        d = json.load(r)
    if 'error' in d:
        raise RuntimeError(d['error'])
    return d['features'], d.get('exceededTransferLimit', False)


def all_features(layer, where, fields):
    out, off = [], 0
    while True:
        fs, more = query(layer, where, fields, offset=off)
        out += fs
        off += len(fs)
        if not more or not fs:
            return out


def point_in(rings, x, z):
    inside = False
    for r in rings:
        n = len(r)
        j = n - 1
        for i in range(n):
            xi, zi = r[i]
            xj, zj = r[j]
            if (zi > z) != (zj > z) and x < (xj - xi) * (z - zi) / (zj - zi) + xi:
                inside = not inside
            j = i
    return inside


def edge_dist(rings, x, z):
    best = math.inf
    for r in rings:
        for i in range(len(r) - 1):
            ax, az = r[i]
            bx, bz = r[i + 1]
            dx, dz = bx - ax, bz - az
            L = dx * dx + dz * dz
            t = 0 if L == 0 else max(0, min(1, ((x - ax) * dx + (z - az) * dz) / L))
            best = min(best, math.hypot(x - ax - t * dx, z - az - t * dz))
    return best


def pole(rings):
    """Pole of inaccessibility by a coarse grid then a finer one round the best cell."""
    xs = [p[0] for r in rings for p in r]
    zs = [p[1] for r in rings for p in r]
    x0, x1, z0, z1 = min(xs), max(xs), min(zs), max(zs)
    best, bd = ((x0 + x1) / 2, (z0 + z1) / 2), -1
    step = max(x1 - x0, z1 - z0) / 24
    for _ in range(3):
        cx, cz = best
        span = step * 12 if bd < 0 else step * 2
        n = 12
        for i in range(-n, n + 1):
            for k in range(-n, n + 1):
                x = (x0 + x1) / 2 + i * step if bd < 0 else cx + i * span / n
                z = (z0 + z1) / 2 + k * step if bd < 0 else cz + k * span / n
                if not point_in(rings, x, z):
                    continue
                d = edge_dist(rings, x, z)
                if d > bd:
                    best, bd = (x, z), d
        step /= 4
    return best


def main():
    places = []
    subs = all_features('LINZ_NZ_Suburbs_and_Localities', '1=1', 'name,type,population_estimate')
    for f in subs:
        a = f['attributes']
        g = f.get('geometry')
        if not g or not g.get('rings'):
            continue
        rings = [[to_world(lon, lat) for lon, lat in r] for r in g['rings']]
        x, z = pole(rings)
        if abs(x) > HALF or abs(z) > HALF:
            continue
        kind = 'suburb' if (a.get('type') or '').lower() == 'suburb' else 'locality'
        places.append({'name': a['name'], 'kind': kind, 'x': round(x), 'z': round(z), 'p': int(a.get('population_estimate') or 0)})
    isl = all_features('LINZ_NZ_Place_Names', "feat_type='Island' AND status LIKE 'Official%'", 'name,feat_type,status')
    if not isl:
        isl = all_features('LINZ_NZ_Place_Names', "feat_type='Island'", 'name,feat_type,status')
    for f in isl:
        g = f.get('geometry')
        if not g or 'x' not in g:
            continue
        x, z = to_world(g['x'], g['y'])
        if abs(x) > HALF or abs(z) > HALF:
            continue
        # 'Motuihe Island / Te Motu-a-Ihenga' → 'Motuihe Island'; 'Motumānawa / Pollen Island' keeps the first
        name = f['attributes']['name'].split(' / ')[0].strip()
        places.append({'name': name, 'kind': 'island', 'x': round(x), 'z': round(z), 'p': 0})
    # an island the suburbs layer also has (Rangitoto Island, Waiheke Island…): keep the locality's
    # label point and population, as an island
    local = {p['name']: p for p in places if p['kind'] != 'island'}
    keep = []
    for p in places:
        if p['kind'] == 'island' and p['name'] in local:
            local[p['name']]['kind'] = 'island'
            continue
        keep.append(p)
    places = keep
    places.sort(key=lambda p: (p['kind'] != 'island', -p['p'], p['name']))
    rows = ',\n'.join(f"  [{json.dumps(p['name'], ensure_ascii=False)}, '{p['kind']}', {p['x']}, {p['z']}, {p['p']}]" for p in places)
    with open(OUT, 'w', encoding='utf-8') as fh:
        fh.write(f'''/**
 * Suburb, locality and island names for the briefing map (#129). GENERATED by tools/linz/placenames.py:
 * do not edit. Toitū Te Whenua LINZ (CC BY 4.0): NZ Suburbs and Localities (LDS layer 113764; label
 * point = the polygon's pole of inaccessibility, priority = population_estimate) and NZ Place Names
 * (NZGB, LDS layer 51681; islands). Game XZ (m, origin = the Sky Tower, +X east, +Z south).
 */
export type PlaceKind = 'suburb' | 'locality' | 'island';
/** [name, kind, x, z, population (0 for islands)] */
export const AUCKLAND_PLACES: readonly (readonly [string, PlaceKind, number, number, number])[] = [
{rows},
];
''')
    print(f'{len(places)} places → {OUT}')


if __name__ == '__main__':
    main()
