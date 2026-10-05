"""
F35-A — hero neighbourhoods along the flight line from RNZAF Base Auckland (Whenuapai, NZWP) to Auckland Airport (NZAA):
one area model per suburb the straight line crosses, clipped to a corridor ±400 m either side of the line, for the
neighbourhoods review page (neighbourhoods_page.py) and the bake (neighbourhoods_bake.py).

The line runs 28.4 km from NZWP's aerodrome reference point (−36.787778, 174.630278) to NZAA's (−37.008056, 174.791667).
The suburbs it crosses, by LINZ NZ Suburbs and Localities (layer 113764), in order, with the length of line over each:
  Whenuapai 1.2 km · Hobsonville 0.7 · West Harbour 0.8 · (Waitematā Harbour 8.6) · Point Chevalier 0.06 (a corner
  over the harbour: no buildings in the corridor, not modelled) · Waterview 1.2 · Mount Albert 1.3 · Avondale 0.4 ·
  New Windsor 1.4 · Mount Roskill 2.7 · Hillsborough 0.4 · (Manukau Harbour 4.4) · Māngere 3.6 · Auckland Airport 1.1
Whole suburbs are 56,000 buildings (Mount Roskill alone 10,800, ~370 kB baked), far over the area budget (≤ 100 kB a
suburb, tests/world-neighbourhoods.test.ts) and ~2.5 M triangles; the corridor holds ~8,700 (Mount Roskill 2,650).

  # once: the suburbs along the line, and per area the LiDAR and aerial over the corridor's box
  curl -sSfG "https://data.linz.govt.nz/services;key=$LINZ_API_KEY/wfs" --data-urlencode service=WFS \
      --data-urlencode version=2.0.0 --data-urlencode request=GetFeature --data-urlencode outputFormat=json \
      --data-urlencode srsName=EPSG:4326 --data-urlencode typeNames=layer-113764 \
      --data-urlencode "bbox=-37.02,174.62,-36.78,174.80,urn:ogc:def:crs:EPSG::4326" -o /tmp/hero/route/suburbs.json
  python3 tools/hero/sites/flight_corridor.py --suburb "Mount Roskill" --plan      # prints the site.py line
  python3 tools/hero/site.py --name mount_roskill --lat … --lon … --size … --res 0.3
  PYTHONHASHSEED=0 python3 tools/hero/sites/flight_corridor.py --suburb "Mount Roskill" --site /tmp/hero/mount_roskill
      → <site>/osm.osm (OSM API tiles merged, plus LINZ outlines OSM lacks), <site>/model.json, <site>/mesh.npz

Outlines: OpenStreetMap first (tags, names); any LINZ NZ Building Outline (layer 101290) whose centroid lies in no OSM
building joins as building=yes, so the corridor has every building LINZ has. Inside an aerodrome the airfield model
(airbase.ts, from OSM) already draws the hangars, terminals and tanks: those are excluded here.
Data: LINZ 2024 LiDAR and aerial, LINZ suburbs and building outlines (CC BY 4.0); © OpenStreetMap contributors (ODbL).
"""
import argparse, json, math, os, subprocess, sys, time
import xml.etree.ElementTree as ET

import numpy as np
from shapely.geometry import LineString, Polygon, shape
from shapely.ops import transform, unary_union

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
from neighbourhood import load_lidar, model_area  # noqa: E402
from osm import to_nztm  # noqa: E402
from heights import ring_mask  # noqa: E402
from mission_bay import merge_osm  # noqa: E402

NZWP = (174.630278, -36.787778)
NZAA = (174.791667, -37.008056)
HALF_WIDTH = 400.0  # m either side of the line
ROUTE = os.environ.get('ROUTE_DIR', '/tmp/hero/route')
AIRFIELD_KEEP = {'hangar', 'terminal', 'tower', 'control_tower'}


def nztm(g):
    return transform(lambda lon, lat: to_nztm.transform(lon, lat), g)


def corridor():
    return nztm(LineString([NZWP, NZAA])).buffer(HALF_WIDTH, cap_style='flat')


def suburb(name):
    fs = json.load(open(os.path.join(ROUTE, 'suburbs.json')))['features']
    return unary_union([nztm(shape(f['geometry'])) for f in fs if f['properties'].get('name') == name])


def plan(name):
    """The corridor piece of the suburb (NZTM) and the site.py box over it (30 m margin)."""
    piece = suburb(name).intersection(corridor())
    E0, N0, E1, N1 = piece.bounds
    size = math.ceil(max(E1 - E0, N1 - N0) + 60)
    lon, lat = to_nztm.transform((E0 + E1) / 2, (N0 + N1) / 2, direction='INVERSE')
    return piece, size, lat, lon


def fetch_osm(site, out, tile=0.006):
    """OSM API map tiles over the site box (≤ ~650 m each: suburbs are dense), merged by id."""
    S = json.load(open(os.path.join(site, 'site.json')))
    w, s, e, n = S['box_wgs84'] if 'box_wgs84' in S else S['bbox_wgs84']
    tiles = []
    os.makedirs(os.path.join(site, 'osm_tiles'), exist_ok=True)
    for i in range(math.ceil((e - w) / tile)):
        for j in range(math.ceil((n - s) / tile)):
            f = os.path.join(site, 'osm_tiles', f'{i}_{j}.osm')
            if not os.path.exists(f):
                bb = f'{w + i * tile:.6f},{s + j * tile:.6f},{min(e, w + (i + 1) * tile):.6f},{min(n, s + (j + 1) * tile):.6f}'
                for k in range(4):
                    r = subprocess.run(['curl', '-sSf', '-o', f, f'https://api.openstreetmap.org/api/0.6/map?bbox={bb}'])
                    if r.returncode == 0:
                        break
                    time.sleep(2 ** (k + 1))
                else:
                    sys.exit(f'OSM tile {bb} failed')
            tiles.append(f)
    merge_osm(tiles, out)


def linz_outlines(site):
    """LINZ NZ Building Outlines over the site box, NZTM rings (cached as <site>/linz_outlines.json)."""
    f = os.path.join(site, 'linz_outlines.json')
    if not os.path.exists(f):
        S = json.load(open(os.path.join(site, 'site.json')))
        E0, N0, E1, N1 = S['box_nztm']
        subprocess.run(['curl', '-sSfG', f"https://data.linz.govt.nz/services;key={os.environ['LINZ_API_KEY']}/wfs",
                        '--data-urlencode', 'service=WFS', '--data-urlencode', 'version=2.0.0', '--data-urlencode', 'request=GetFeature',
                        '--data-urlencode', 'outputFormat=json', '--data-urlencode', 'srsName=EPSG:2193',
                        '--data-urlencode', 'typeNames=layer-101290', '--data-urlencode', f'cql_filter=BBOX(shape,{N0},{E0},{N1},{E1})',
                        '-o', f], check=True)
    out = []
    for b in json.load(open(f))['features']:
        g = b['geometry'] and shape(b['geometry'])
        for p in getattr(g, 'geoms', [g]) if g else []:
            if p.geom_type == 'Polygon' and p.area >= 8:
                out.append((b['properties'].get('building_outline_id', b.get('id')), p))
    return out


def add_linz(osm_path, site):
    """Append the LINZ outlines whose centroid is in no OSM building to the OSM file, as building=yes ways
    (negative ids), when the 2024 LiDAR stands a roof on it (median nDSM inside > 2.2 m: LINZ still lists houses
    since demolished, which the kit would put across new roads). Returns (joined, rejected)."""
    S = json.load(open(os.path.join(site, 'site.json')))
    E0, N1 = S['box_nztm'][0], S['box_nztm'][3]
    dsm, dem = load_lidar(site)
    nd = dsm - dem
    tree = ET.parse(osm_path)
    root = tree.getroot()
    nodes = {n.get('id'): (float(n.get('lon')), float(n.get('lat'))) for n in root.iter('node')}
    osm_b = []
    for w in root.iter('way'):
        t = {x.get('k'): x.get('v') for x in w.findall('tag')}
        if 'building' in t:
            ref = [nd.get('ref') for nd in w.findall('nd')]
            if len(ref) >= 4 and all(r in nodes for r in ref):
                P = Polygon([to_nztm.transform(*nodes[r]) for r in ref]).buffer(0)
                if not P.is_empty:
                    osm_b.append(P)
    from shapely import STRtree
    tree_b = STRtree(osm_b)
    nid, wid, added, gone = -1, -1, 0, 0
    for oid, P in linz_outlines(site):
        c = P.centroid
        if any(osm_b[k].contains(c) for k in tree_b.query(c)):
            continue
        q = P.buffer(-0.7)
        q = q if q.geom_type == 'Polygon' and not q.is_empty else P
        m = ring_mask(nd.shape, [(e - E0, N1 - n) for e, n in q.exterior.coords])
        if m.sum() < 4 or float(np.median(nd[m])) < 2.2:
            gone += 1
            continue
        ring = list(P.exterior.coords)[:-1]
        refs = []
        for e, n in ring:
            lon, lat = to_nztm.transform(e, n, direction='INVERSE')
            ET.SubElement(root, 'node', id=str(nid), lat=f'{lat:.8f}', lon=f'{lon:.8f}')
            refs.append(nid)
            nid -= 1
        w = ET.SubElement(root, 'way', id=str(wid))
        for r in refs + refs[:1]:
            ET.SubElement(w, 'nd', ref=str(r))
        ET.SubElement(w, 'tag', k='building', v='yes')
        ET.SubElement(w, 'tag', k='source', v=f'LINZ building outline {oid}')
        wid -= 1
        added += 1
    # nodes before ways, as the kit's reader expects ids to resolve
    els = list(root)
    for el in els:
        root.remove(el)
    root.extend([e for e in els if e.tag == 'node'] + [e for e in els if e.tag != 'node'])
    tree.write(osm_path, encoding='utf-8', xml_declaration=True)
    return added, gone


def airfield_keep_out(osm_path, E0, N1):
    """The hangars, terminals and towers the airfield model draws (site frame), to keep clear."""
    from neighbourhood import load_osm
    areas, _, _ = load_osm(osm_path, E0, N1)
    polys = [Polygon(a['ring']).buffer(3) for a in areas if a['tags'].get('aeroway') in AIRFIELD_KEEP
             or a['tags'].get('building') in ('hangar', 'terminal') or a['tags'].get('man_made') == 'storage_tank']
    return unary_union(polys) if polys else None


def footprint(site, name):
    """The corridor piece of the suburb on land (LiDAR DEM > 0.6 m), largest part, in the site frame."""
    S = json.load(open(os.path.join(site, 'site.json')))
    E0, N1 = S['box_nztm'][0], S['box_nztm'][3]
    piece = transform(lambda e, n: (e - E0, N1 - n), plan(name)[0])
    dsm, dem = load_lidar(site)
    from rasterio import features
    from rasterio.transform import Affine
    m = np.zeros(dem.shape, bool)
    for g in getattr(piece, 'geoms', [piece]):
        m |= ring_mask(dem.shape, list(g.exterior.coords))
    m &= dem > 0.6
    polys = [shape(g) for g, v in features.shapes(m.astype(np.uint8), mask=m, transform=Affine(1, 0, 0, 0, 1, 0)) if v == 1]
    land = unary_union([p.buffer(2).buffer(-2) for p in polys if p.area > 400]).intersection(piece)
    parts = sorted(getattr(land, 'geoms', [land]), key=lambda g: -g.area)
    fp = parts[0].simplify(1.5)
    return Polygon(fp.exterior), piece, [round(p.area / 1e4, 2) for p in parts[1:] if p.area > 1e4]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--suburb', required=True)
    ap.add_argument('--site')
    ap.add_argument('--plan', action='store_true', help='print the site.py command for the suburb and stop')
    a = ap.parse_args()
    slug = a.suburb.lower().replace(' ', '_').replace('ā', 'a')
    if a.plan:
        piece, size, lat, lon = plan(a.suburb)
        print(f'# {a.suburb}: corridor piece {piece.area / 1e4:.1f} ha in {len(getattr(piece, "geoms", [piece]))} part(s)')
        print(f'python3 tools/hero/site.py --name {slug} --lat {lat:.5f} --lon {lon:.5f} --size {size} --res 0.3')
        return
    site = a.site or f'/tmp/hero/{slug}'
    osm_path = os.path.join(site, 'osm.osm')
    if not os.path.exists(osm_path):
        fetch_osm(site, osm_path)
        print('LINZ outlines (joined, no roof in the 2024 LiDAR)', add_linz(osm_path, site))
    land, piece, dropped = footprint(site, a.suburb)
    S = json.load(open(os.path.join(site, 'site.json')))
    excl = airfield_keep_out(osm_path, S['box_nztm'][0], S['box_nztm'][3])
    model, mesh, _ = model_area(site, osm_path, land, exclude=excl)
    # a LiDAR-traced "building" on a carriageway is a bridge or overpass (Hobsonville: the SH18 overpass, 22 m up)
    carriage = unary_union([LineString(r['pts']).buffer(r['width'] / 2 + 1, cap_style='flat') for r in model['roads'] if not r['tunnel'] and len(r['pts']) > 1])
    bridges = [b['id'] for b in model['buildings'] if b['src'] == 'traced' and Polygon(b['ring']).intersection(carriage).area > 0.25 * Polygon(b['ring']).area]
    model['buildings'] = [b for b in model['buildings'] if b['id'] not in bridges]
    model['stats']['bridges_dropped'] = len(bridges)
    model['name'] = a.suburb
    model['face'] = [[round(x, 1), round(z, 1)] for x, z in max(getattr(piece, 'geoms', [piece]), key=lambda g: g.area).exterior.coords]
    model['stats']['dropped_parts_ha'] = dropped
    json.dump(model, open(os.path.join(site, 'model.json'), 'w'))
    np.savez_compressed(os.path.join(site, 'mesh.npz'), **mesh)
    print(json.dumps(model['stats'], indent=1))


if __name__ == '__main__':
    main()
