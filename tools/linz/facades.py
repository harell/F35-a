"""
#141: OpenStreetMap building tags (use, storeys, material, colour) on the CBD's LINZ buildings, for their facades.

    npx vite-node tools/linz/roofs.ts dump <work>      # the buildings the game draws → <work>/roofs-in.json
    python3 tools/linz/facades.py <work>               # OSM tags per building → <work>/facades.json (+ facades-report.json)
    npx vite-node tools/linz/facades.ts bake <work>    # → src/world/terrain/data/auckland-buildings.bin (format v3)

OSM main API (`/api/0.6/map?bbox=`, 3 x 3 tiles over the CBD; Overpass is unreachable from the cloud container), cached
in <work>/osm. Each LINZ building takes the tags of the OSM building (way or multipolygon outer) that covers most of
its footprint, when that covers at least MIN_COVER of it (an OSM outline over a whole block gives its tags to every
LINZ building inside; one covering a sliver gives none). Tags: `building` (its use: office, retail, apartments, …),
`building:levels` (storeys above ground; the LiDAR height / levels is then the building's storey height),
`building:material` and `building:colour`. The facade shader falls back to the height classes without them.

pip install shapely
"""
import json
import os
import sys
import time
import urllib.request
import xml.etree.ElementTree as ET

import numpy as np
from shapely.geometry import Polygon
from shapely.strtree import STRtree

O = (-36.8485, 174.7622)  # AKL_ORIGIN (src/core/auckland.ts)
MLAT = 110950
MLON = 111320 * np.cos(np.radians(O[0]))
API = 'https://api.openstreetmap.org/api/0.6/map?bbox={},{},{},{}'
UA = 'F35-a facade bake (https://github.com/harell/F35-a)'
MIN_COVER = 0.5

# OSM `building` values → the game's use classes (aucklandBuildings.ts BUILDING_USES, in this order from 1)
USES = ['office', 'commercial', 'retail', 'apartments', 'hotel', 'civic', 'education', 'parking', 'industrial', 'house']
USE_OF = {
    'office': 'office', 'commercial': 'commercial', 'retail': 'retail', 'supermarket': 'retail', 'kiosk': 'retail',
    'apartments': 'apartments', 'residential': 'apartments', 'dormitory': 'apartments', 'terrace': 'apartments',
    'hotel': 'hotel', 'church': 'civic', 'cathedral': 'civic', 'chapel': 'civic', 'civic': 'civic', 'public': 'civic',
    'government': 'civic', 'museum': 'civic', 'train_station': 'civic', 'transportation': 'civic', 'hospital': 'civic',
    'university': 'education', 'school': 'education', 'college': 'education', 'parking': 'parking', 'industrial': 'industrial',
    'warehouse': 'industrial', 'service': 'industrial', 'house': 'house', 'detached': 'house', 'semidetached_house': 'house',
}
# building:material → the game's materials (aucklandBuildings.ts BUILDING_MATERIALS, from 1)
MATERIALS = ['brick', 'concrete', 'glass', 'stone', 'plaster', 'metal', 'wood']
MAT_OF = {'brick': 'brick', 'concrete': 'concrete', 'glass': 'glass', 'stone': 'stone', 'sandstone': 'stone', 'granite': 'stone',
          'limestone': 'stone', 'plaster': 'plaster', 'render': 'plaster', 'stucco': 'plaster', 'metal': 'metal',
          'steel': 'metal', 'metal_plates': 'metal', 'wood': 'wood', 'timber_framing': 'wood', 'cement_block': 'concrete'}
CSS = {'white': 0xffffff, 'black': 0x202020, 'grey': 0x808080, 'gray': 0x808080, 'silver': 0xc0c0c0, 'red': 0xa0402e,
       'brown': 0x7b5a40, 'beige': 0xd8cbb0, 'cream': 0xe8dfc8, 'yellow': 0xd9c66a, 'blue': 0x4a6a8a, 'green': 0x5f7f5a,
       'orange': 0xc9773a, 'tan': 0xc9b28a, 'maroon': 0x6e2a22, 'navy': 0x2a3a5a, 'darkgrey': 0x505050, 'lightgrey': 0xc8c8c8}

work = sys.argv[1]
osm_dir = os.path.join(work, 'osm')
os.makedirs(osm_dir, exist_ok=True)
bs = [b for b in json.load(open(os.path.join(work, 'roofs-in.json'))) if b['drawn']]
xs = np.concatenate([p['ring'][0::2] for b in bs for p in b['prisms']])
zs = np.concatenate([p['ring'][1::2] for b in bs for p in b['prisms']])
lon0, lon1 = O[1] + (xs.min() - 60) / MLON, O[1] + (xs.max() + 60) / MLON
lat0, lat1 = O[0] - (zs.max() + 60) / MLAT, O[0] - (zs.min() - 60) / MLAT


def fetch(i, j, n=3):
    path = os.path.join(osm_dir, f'{i}{j}.osm')
    if not os.path.exists(path):
        a, b = lon0 + (lon1 - lon0) * i / n, lon0 + (lon1 - lon0) * (i + 1) / n
        c, d = lat0 + (lat1 - lat0) * j / n, lat0 + (lat1 - lat0) * (j + 1) / n
        req = urllib.request.Request(API.format(a, c, b, d), headers={'User-Agent': UA})
        data = urllib.request.urlopen(req, timeout=180).read()
        open(path, 'wb').write(data)
        time.sleep(1)
    return ET.parse(path).getroot()


nodes = {}
ways = {}
rels = {}
for i in range(3):
    for j in range(3):
        r = fetch(i, j)
        for n in r.iter('node'):
            nodes[n.get('id')] = (float(n.get('lon')), float(n.get('lat')))
        for w in r.iter('way'):
            ways[w.get('id')] = ([nd.get('ref') for nd in w.iter('nd')], {t.get('k'): t.get('v') for t in w.iter('tag')})
        for rel in r.iter('relation'):
            rels[rel.get('id')] = ([(m.get('ref'), m.get('role')) for m in rel.iter('member') if m.get('type') == 'way'], {t.get('k'): t.get('v') for t in rel.iter('tag')})


def ring_xz(refs):
    pts = [nodes[r] for r in refs if r in nodes]
    if len(pts) < 4 or len(pts) != len(refs):
        return None
    return [((lon - O[1]) * MLON, (O[0] - lat) * MLAT) for lon, lat in pts]


polys = []
tags = []
for wid, (refs, t) in ways.items():
    if 'building' not in t or refs[0] != refs[-1]:
        continue
    r = ring_xz(refs)
    if r:
        p = Polygon(r).buffer(0)
        if p.area > 10:
            polys.append(p)
            tags.append(t)
for rid, (mem, t) in rels.items():
    if 'building' not in t or t.get('type') != 'multipolygon':
        continue
    for ref, role in mem:
        if role == 'outer' and ref in ways and ways[ref][0][0] == ways[ref][0][-1]:
            r = ring_xz(ways[ref][0])
            if r:
                p = Polygon(r).buffer(0)
                if p.area > 10:
                    polys.append(p)
                    tags.append(t)
tree = STRtree(polys)
print(f'{len(polys)} OSM building outlines', flush=True)


def colour(v):
    if not v:
        return None
    v = v.strip().lower().replace(' ', '')
    if v.startswith('#') and len(v) in (4, 7):
        h = v[1:]
        if len(h) == 3:
            h = ''.join(c * 2 for c in h)
        try:
            return int(h, 16)
        except ValueError:
            return None
    return CSS.get(v)


def levels(v):
    try:
        n = float((v or '').split(';')[0])
    except ValueError:
        return 0
    return int(round(n)) if 1 <= n <= 80 else 0


out = []
rep = {'buildings': len(bs), 'matched': 0, 'use': {u: 0 for u in USES}, 'levels': 0, 'material': 0, 'colour': 0}
for b in bs:
    r = np.asarray(b['prisms'][0]['ring']).reshape(-1, 2)
    fp = Polygon(r).buffer(0)
    if fp.area <= 0:
        continue
    best, cover = None, 0.0
    for k in tree.query(fp):
        c = polys[k].intersection(fp).area / fp.area
        if c > cover:
            best, cover = k, c
    if best is None or cover < MIN_COVER:
        continue
    t = tags[best]
    use = USE_OF.get(t.get('building'))
    lv = levels(t.get('building:levels'))
    mat = MAT_OF.get((t.get('building:material') or '').lower())
    col = colour(t.get('building:colour'))
    if not (use or lv or mat or col is not None):
        continue
    rep['matched'] += 1
    if use:
        rep['use'][use] += 1
    rep['levels'] += lv > 0
    rep['material'] += mat is not None
    rep['colour'] += col is not None
    out.append({'i': b['i'], 'use': USES.index(use) + 1 if use else 0, 'levels': lv, 'material': MATERIALS.index(mat) + 1 if mat else 0,
                'colour': col, 'cover': round(cover, 2)})
json.dump(out, open(os.path.join(work, 'facades.json'), 'w'))
json.dump(rep, open(os.path.join(work, 'facades-report.json'), 'w'), indent=1)
print(json.dumps(rep, indent=1))
