"""
F35-A — hero buildings: the OpenStreetMap baseline for one site (buildings and Simple 3D Buildings parts).

Someone may already have mapped the building in 3D: `building:part` ways with `height`, `min_height`,
`roof:shape`, `building:colour`… (the Sky Tower in src/core/skyTower.ts started from its OSM parts).
This reads the site's box from the main OSM API (Overpass is unreachable from the cloud container;
the API's /map call allows boxes up to 0.25 deg² and 50,000 nodes, plenty for one site), keeps every
`building` and `building:part` way, and writes <out>/osm.json:

  {"source": "...", "features": [{"id", "kind": "building"|"part", "tags", "ring": [[x, z], ...]}]}

with rings in the site's local frame (metres, x = E − E0 east, z = N1 − N south: the same frame as
tools/hero/site.py), plus a printed table of the 3D tags so you can see at a glance what exists.
Multipolygon relations get their outer rings stitched from member ways (a ring stays open if a member lies outside the box).

  python3 tools/hero/osm.py --site /tmp/hero/<name>      (reads the box from <site>/site.json)

Data © OpenStreetMap contributors, ODbL 1.0: credit it, and keep baked derivatives rebuildable.
"""
import argparse, json, urllib.request
import xml.etree.ElementTree as ET

from pyproj import Transformer

to_nztm = Transformer.from_crs(4326, 2193, always_xy=True)
TAGS_3D = ('name', 'building', 'building:part', 'height', 'min_height', 'building:levels', 'building:min_level',
           'roof:shape', 'roof:height', 'roof:colour', 'building:colour', 'building:material', 'roof:material')


def stitch(segs):
    """Join a multipolygon's outer member ways (node-id lists) into closed rings."""
    segs = [list(s) for s in segs if s]
    rings = []
    while segs:
        ring = segs.pop(0)
        while ring[0] != ring[-1]:
            for i, s in enumerate(segs):
                if s[0] == ring[-1]:
                    ring += s[1:]
                elif s[-1] == ring[-1]:
                    ring += s[::-1][1:]
                elif s[-1] == ring[0]:
                    ring = s[:-1] + ring
                elif s[0] == ring[0]:
                    ring = s[::-1][:-1] + ring
                else:
                    continue
                segs.pop(i)
                break
            else:
                break  # open ring: a member way lies outside the box; keep what we have
        rings.append(ring)
    return rings


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--site', required=True, help='folder written by tools/hero/site.py')
    a = ap.parse_args()
    site = json.load(open(f'{a.site}/site.json'))
    lo0, la0, lo1, la1 = site['box_wgs84']
    E0, _, _, N1 = site['box_nztm']
    url = f'https://api.openstreetmap.org/api/0.6/map?bbox={lo0:.6f},{la0:.6f},{lo1:.6f},{la1:.6f}'
    req = urllib.request.Request(url, headers={'User-Agent': 'F35-A-hero-buildings/1.0'})
    root = ET.fromstring(urllib.request.urlopen(req, timeout=120).read())

    nodes = {n.get('id'): (float(n.get('lon')), float(n.get('lat'))) for n in root.iter('node')}
    feats = []
    for w in root.iter('way'):
        tags = {t.get('k'): t.get('v') for t in w.iter('tag')}
        kind = 'part' if 'building:part' in tags else 'building' if 'building' in tags else None
        if not kind:
            continue
        ring = []
        for nd in w.iter('nd'):
            ll = nodes.get(nd.get('ref'))
            if ll:
                E, N = to_nztm.transform(*ll)
                ring.append([round(E - E0, 2), round(N1 - N, 2)])
        feats.append({'id': f'way/{w.get("id")}', 'kind': kind, 'tags': tags, 'ring': ring})
    ways = {w.get('id'): [nd.get('ref') for nd in w.iter('nd')] for w in root.iter('way')}
    for r in root.iter('relation'):
        tags = {t.get('k'): t.get('v') for t in r.iter('tag')}
        if 'building' in tags or 'building:part' in tags:
            outers = [ways[m.get('ref')] for m in r.iter('member') if m.get('type') == 'way' and m.get('role') == 'outer' and m.get('ref') in ways]
            for ring in stitch(outers):
                xy = []
                for ref in ring:
                    if ref in nodes:
                        E, N = to_nztm.transform(*nodes[ref])
                        xy.append([round(E - E0, 2), round(N1 - N, 2)])
                feats.append({'id': f'relation/{r.get("id")}', 'kind': 'part' if 'building:part' in tags else 'building', 'tags': tags, 'ring': xy})

    json.dump({'source': url, 'licence': 'ODbL 1.0, © OpenStreetMap contributors', 'features': feats}, open(f'{a.site}/osm.json', 'w'))
    parts = [f for f in feats if f['kind'] == 'part']
    tagged = [f for f in feats if any(k in f['tags'] for k in ('height', 'building:levels', 'roof:shape'))]
    print(f'{len(feats)} building features, {len(parts)} building:part, {len(tagged)} with height/levels/roof tags')
    for f in sorted(tagged, key=lambda f: -float((f['tags'].get('height') or '0').split()[0] or 0))[:40]:
        print(f['id'], f['kind'], {k: v for k, v in f['tags'].items() if k in TAGS_3D})


if __name__ == '__main__':
    main()
