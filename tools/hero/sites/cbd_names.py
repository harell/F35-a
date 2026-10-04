"""
F35-A — names for the CBD's remaining skyscrapers: every LINZ building the sim knows as a solid (a roof ≥ 40 m above the
ground, sim/buildings.ts SKYSCRAPER_MIN_HEIGHT) that isn't a tower of the tower kit (core/cbdTowersData.ts) or a Scene
apartment, so a crash into any of them names it on the HUD and in the debrief. Writes src/core/cbdBuildingNames.ts.

  (a throwaway vitest writes the list: for every aucklandBuildings() entry with no `tower` / `hero` and a prism ≥ 40 m,
   {id, x, z, h, lon, lat, ring: [[lon, lat], …]} of its first prism (worldToGeo) → /tmp/hero/cbd_unnamed.json)
  python3 tools/hero/sites/cbd_names.py --list /tmp/hero/cbd_unnamed.json [--cache /tmp/hero/cbd_names_osm]

For each building: the OpenStreetMap map call (api.openstreetmap.org, the same one tools/hero/osm.py uses) over its
footprint plus ~40 m; the OSM buildings that hold its centroid, or two of its corners, or whose centre it holds, give the
name (the one holding the centroid first), else the first `addr:housenumber` + `addr:street` (on those buildings, then on
address points inside the footprint). OVERRIDES fixes the few where OSM's name is a tenant, not the building, and names
the ones OSM has neither for after their street.
Data: LINZ NZ Building Outlines (CC BY 4.0); names and addresses © OpenStreetMap contributors (ODbL).
"""
import argparse, json, os, time, urllib.request
import xml.etree.ElementTree as ET

OUT = os.path.join(os.path.dirname(__file__), '../../../src/core/cbdBuildingNames.ts')

# LINZ index → (name in a sentence, HUD label); None keeps OSM's
OVERRIDES = {
    540: ('2 Kitchener Street', None),  # OSM: a tenant (an immigration firm)
    754: ('39 Symonds Street', None),  # OSM: the art shop on the ground floor
    233: ('a tower on Shortland Street', 'SHORTLAND ST TOWER'),  # no OSM building or address
    498: ('a University of Auckland building', 'UNIVERSITY BUILDING'),
    718: ('a building on Wellesley Street East', 'WELLESLEY ST BUILDING'),
    914: ('a building on Symonds Street', 'SYMONDS ST BUILDING'),
}


def pip(r, x, y):
    c = False
    for i in range(len(r)):
        x1, y1 = r[i - 1]
        x2, y2 = r[i]
        if (y2 > y) != (y1 > y) and x < (x1 - x2) * (y - y2) / (y1 - y2) + x2:
            c = not c
    return c


def fetch(b, cache):
    f = os.path.join(cache, f"{b['id']}.xml")
    if not os.path.exists(f):
        lons = [p[0] for p in b['ring']]
        lats = [p[1] for p in b['ring']]
        pad = 0.0004
        url = f'https://api.openstreetmap.org/api/0.6/map?bbox={min(lons) - pad:.6f},{min(lats) - pad:.6f},{max(lons) + pad:.6f},{max(lats) + pad:.6f}'
        req = urllib.request.Request(url, headers={'User-Agent': 'F35-A-hero-buildings/1.0'})
        open(f, 'wb').write(urllib.request.urlopen(req, timeout=60).read())
        time.sleep(0.5)
    return ET.parse(f).getroot()


def name_of(b, root):
    nodes = {n.get('id'): (float(n.get('lon')), float(n.get('lat'))) for n in root.iter('node')}
    ways = {w.get('id'): w for w in root.iter('way')}
    tags_of = lambda e: {t.get('k'): t.get('v') for t in e.iter('tag')}
    cands = []

    def consider(tags, rings):
        if 'building' not in tags and 'building:part' not in tags:
            return
        for r in rings:
            if len(r) < 3:
                continue
            cx = sum(p[0] for p in r) / len(r)
            cy = sum(p[1] for p in r) / len(r)
            holds = pip(r, b['lon'], b['lat'])
            corners = sum(pip(r, p[0], p[1]) for p in b['ring'])
            if holds or corners >= 2 or pip(b['ring'], cx, cy):
                cands.append((holds, corners, tags))

    for w in root.iter('way'):
        consider(tags_of(w), [[nodes[n.get('ref')] for n in w.iter('nd') if n.get('ref') in nodes]])
    for rel in root.iter('relation'):
        outers = [ways[m.get('ref')] for m in rel.iter('member') if m.get('type') == 'way' and m.get('role') == 'outer' and m.get('ref') in ways]
        consider(tags_of(rel), [[nodes[n.get('ref')] for n in w.iter('nd') if n.get('ref') in nodes] for w in outers])
    cands.sort(key=lambda c: (-c[0], -c[1]))
    name = next((t['name'] for _, _, t in cands if t.get('name')), None)
    addr = next((f"{t['addr:housenumber']} {t['addr:street']}" for _, _, t in cands if t.get('addr:housenumber') and t.get('addr:street')), None)
    if not addr:
        for n in root.iter('node'):
            t = tags_of(n)
            if t.get('addr:housenumber') and t.get('addr:street') and pip(b['ring'], float(n.get('lon')), float(n.get('lat'))):
                addr = f"{t['addr:housenumber']} {t['addr:street']}"
                break
    return name or addr


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--list', required=True)
    ap.add_argument('--cache', default='/tmp/hero/cbd_names_osm')
    a = ap.parse_args()
    os.makedirs(a.cache, exist_ok=True)
    rows = []
    for b in json.load(open(a.list)):
        name, label = OVERRIDES.get(b['id'], (None, None))
        name = name or name_of(b, fetch(b, a.cache))
        if not name:
            print('no name:', b['id'], b['x'], b['z'])
            continue
        rows.append((b['x'], b['z'], name, label))
    q = lambda s: json.dumps(s, ensure_ascii=False)
    lines = [
        '/**',
        ' * F35-A — GENERATED by tools/hero/sites/cbd_names.py: the names of the CBD skyscrapers the sim knows as solids (roof',
        " * ≥ 40 m) that aren't in the tower kit (core/cbdTowersData.ts), so a crash names every one (sim/buildings.ts). Each",
        ' * is a point inside its LINZ footprint (NZ Building Outlines, CC BY 4.0) and its name or street address',
        ' * (© OpenStreetMap contributors, ODbL). Do not edit by hand: change OVERRIDES in the tool and rerun it.',
        ' */',
        '',
        'export interface CbdBuildingName {',
        '  /** A point inside the footprint (game m). */',
        '  x: number;',
        '  z: number;',
        '  /** In a sentence ("Crashed into Quest"). */',
        '  name: string;',
        '  /** On the HUD when it differs from the name upper-cased. */',
        '  label?: string;',
        '}',
        '',
        'export const CBD_BUILDING_NAMES: readonly CbdBuildingName[] = [',
    ]
    for x, z, name, label in rows:
        lines.append(f'  {{ x: {x}, z: {z}, name: {q(name)}' + (f', label: {q(label)}' if label else '') + ' },')
    lines += ['];', '']
    open(OUT, 'w').write('\n'.join(lines))
    print(f'{len(rows)} names → {os.path.normpath(OUT)}')


if __name__ == '__main__':
    main()
