"""
F35-A — hero neighbourhoods: Mission Bay (the beach suburb on Tāmaki Drive, east of the CBD) measured from LiDAR, for
the neighbourhoods review page (tools/hero/sites/neighbourhoods_page.py) and the bake (neighbourhoods_bake.py).

  python3 tools/hero/site.py --name mission_bay --lat -36.8555 --lon 174.8330 --size 2400 --res 0.3
  # LINZ NZ Suburbs and Localities (layer 113764): the 'Mission Bay' polygons (the suburb and its beach)
  curl -sSfG "https://data.linz.govt.nz/services;key=$LINZ_API_KEY/wfs" --data-urlencode service=WFS \
      --data-urlencode version=2.0.0 --data-urlencode request=GetFeature --data-urlencode outputFormat=json \
      --data-urlencode srsName=EPSG:4326 --data-urlencode typeNames=layer-113764 \
      --data-urlencode "cql_filter=name='Mission Bay'" -o /tmp/hero/mission_bay/suburbs.json
  # OSM in four tiles (one box is over the API's 50k-node limit), merged by id: see merge_osm below
  python3 tools/hero/sites/mission_bay.py --site /tmp/hero/mission_bay --osm /tmp/hero/osm/mission_bay.osm \
      [--tiles /tmp/hero/osm/mb_*.osm]
      → <site>/model.json, <site>/mesh.npz, <site>/mission_bay.glb

Scope: the LINZ suburb boundary of Mission Bay (Tāmaki Drive and the reserve on the north, up the valley to Kepa Road
and the ridge on the south, Ōrākei on the west, Kohimarama on the east), on land (LiDAR DEM > 0.6 m) and 30 m out over
the beach. The area lies outside the game's real-streets region: the game stops its procedural grid on the footprint
(Scenery.siteMask) and draws its LINZ streets as ribbons (tools/linz/roads.ts, neighbourhood streets).
The kit (neighbourhood.py) does the measuring: roofs per OSM outline, trees per LiDAR crown, buildings OSM misses.
Data: LINZ 2024 LiDAR and aerial, LINZ suburbs (CC BY 4.0); © OpenStreetMap contributors (ODbL).
"""
import argparse, glob, json, os, sys
import xml.etree.ElementTree as ET

import numpy as np
import shapely
from shapely.geometry import shape
from shapely.ops import transform, unary_union

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from neighbourhood import load_lidar, model_area, write_glb  # noqa: E402
from osm import to_nztm  # noqa: E402
from heights import ring_mask  # noqa: E402


def merge_osm(tiles, out):
    """Merge OSM API tiles into one file (elements deduplicated by type and id, nodes first)."""
    seen = {}
    for f in sorted(tiles):
        for el in ET.parse(f).getroot():
            if el.tag in ('node', 'way', 'relation'):
                seen.setdefault((el.tag, el.get('id')), el)
    root = ET.Element('osm', version='0.6')
    for tag in ('node', 'way', 'relation'):
        root.extend(el for (t, _), el in seen.items() if t == tag)
    ET.ElementTree(root).write(out, encoding='utf-8', xml_declaration=True)


def footprint(site):
    S = json.load(open(os.path.join(site, 'site.json')))
    E0, N1 = S['box_nztm'][0], S['box_nztm'][3]
    subs = json.load(open(os.path.join(site, 'suburbs.json')))['features']
    sub = unary_union([shape(f['geometry']) for f in subs if f['properties'].get('name') == 'Mission Bay'])
    sub = transform(lambda lon, lat: (lambda e, n: (e - E0, N1 - n))(*to_nztm.transform(lon, lat)), sub)
    sub = sub.buffer(1).buffer(-1)  # the suburb and its beach polygon share an edge
    dsm, dem = load_lidar(site)
    from rasterio import features
    from rasterio.transform import Affine
    m = ring_mask(dem.shape, list(max(getattr(sub, 'geoms', [sub]), key=lambda g: g.area).exterior.coords)) & (dem > 0.6)
    polys = [shapely.geometry.shape(g) for g, v in features.shapes(m.astype(np.uint8), mask=m, transform=Affine(1, 0, 0, 0, 1, 0)) if v == 1]
    land = max(polys, key=lambda p: p.area).buffer(2).buffer(-2).simplify(1.5)
    fp = land.union(land.buffer(30).intersection(sub)).simplify(1.5)
    if fp.geom_type == 'MultiPolygon':
        fp = max(fp.geoms, key=lambda g: g.area)
    return shapely.geometry.Polygon(fp.exterior), sub


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--site', required=True)
    ap.add_argument('--osm', required=True)
    ap.add_argument('--tiles', nargs='*', help='OSM API tiles to merge into --osm first')
    a = ap.parse_args()
    if a.tiles:
        merge_osm([t for p in a.tiles for t in glob.glob(p)], a.osm)
    land, sub = footprint(a.site)
    model, mesh, _ = model_area(a.site, a.osm, land)
    model['name'] = 'Mission Bay'
    face = max(getattr(sub, 'geoms', [sub]), key=lambda g: g.area)
    model['face'] = [[round(x, 1), round(z, 1)] for x, z in face.exterior.coords]
    json.dump(model, open(os.path.join(a.site, 'model.json'), 'w'))
    np.savez_compressed(os.path.join(a.site, 'mesh.npz'), **mesh)
    write_glb(os.path.join(a.site, 'mission_bay.glb'), mesh['pos'][mesh['tri'].ravel()], np.arange(len(mesh['tri']) * 3).reshape(-1, 3),
              np.repeat(mesh['tcol'], 3, 0), (model['size'] / 2, model['size'] / 2))
    print(json.dumps(model['stats'], indent=1))


if __name__ == '__main__':
    main()
