"""
F35-A — hero neighbourhoods: Herne Bay (Auckland's villa suburb on the Waitematā) measured from LiDAR, for the
neighbourhoods review page (tools/hero/sites/neighbourhoods_page.py).

  python3 tools/hero/site.py --name herne_bay --lat -36.8455 --lon 174.7330 --size 1800 --res 0.3
  curl -o /tmp/hero/osm/herne_bay.osm "https://api.openstreetmap.org/api/0.6/map?bbox=174.7215,-36.8540,174.7445,-36.8370"
  python3 tools/hero/sites/herne_bay.py --site /tmp/hero/herne_bay --osm /tmp/hero/osm/herne_bay.osm
      → <site>/model.json, <site>/mesh.npz, <site>/herne_bay.glb

Scope: north of Jervois Road and west of Shelly Beach Road to the harbour, from Cox's Bay in the west (the OSM roads
themselves, so the edge follows the streets, not a hand-drawn line), on land (LiDAR DEM > 0.6 m) and 30 m out over the beaches, plus the jetties.
Shelly Beach Road's east side, Point Erin and the marina are Westhaven's (tools/hero/sites/westhaven.py).
The kit (neighbourhood.py) does the measuring: roofs per OSM outline, trees per LiDAR crown, buildings OSM misses,
and the roads check (roads are left out of the model and drawn on top by the game).
Data: LINZ 2024 LiDAR and aerial (CC BY 4.0); © OpenStreetMap contributors (ODbL).
"""
import argparse, json, os, sys

import numpy as np
from shapely.geometry import LineString, Point, Polygon, box
from shapely.ops import linemerge, nearest_points, polygonize, unary_union

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from neighbourhood import load_lidar, load_osm, model_area, write_glb  # noqa: E402
from osm import to_nztm  # noqa: E402
from heights import ring_mask  # noqa: E402


def footprint(site, osm_path):
    S = json.load(open(os.path.join(site, 'site.json')))
    E0, N0, E1, N1 = S['box_nztm']
    W = E1 - E0
    _, lines, _ = load_osm(osm_path, E0, N1)
    named = lambda n: linemerge(unary_union([LineString(l['pts']) for l in lines if l['tags'].get('name') == n and l['tags'].get('highway')]))
    jervois, shelly = named('Jervois Road'), named('Shelly Beach Road')
    frame = box(0, 0, W, W)
    # Jervois Road's west end, out to Cox's Bay (west edge of the box)
    jl = jervois if jervois.geom_type == 'LineString' else max(jervois.geoms, key=lambda g: g.length)
    west = min((Point(c) for c in (jl.coords[0], jl.coords[-1])), key=lambda p: p.x)
    ext = LineString([(west.x, west.y), (0, west.y)])
    # Jervois to Shelly Beach Road where they don't quite meet in the data
    a, b = nearest_points(jervois, shelly)
    link = LineString([a, b])
    cut = unary_union([jervois, shelly, ext, link, frame.boundary])
    seed = Point(*[v for v in (lambda e, n: (e - E0, N1 - n))(*to_nztm.transform(174.7330, -36.8425))])
    face = next(f for f in polygonize(cut) if f.contains(seed))
    dsm, dem = load_lidar(site)
    land = dem > 0.6
    from rasterio import features
    from rasterio.transform import Affine
    import shapely
    m = ring_mask(dem.shape, list(face.exterior.coords)) & land
    polys = [shapely.geometry.shape(g) for g, v in features.shapes(m.astype(np.uint8), mask=m, transform=Affine(1, 0, 0, 0, 1, 0)) if v == 1]
    landpoly = max(polys, key=lambda p: p.area).buffer(2).buffer(-2).simplify(1.5)
    # out over the beaches to 30 m past the land (the game's coastline is mean high water), never past the streets
    return landpoly.union(landpoly.buffer(30).intersection(face)).simplify(1.5), face


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--site', required=True)
    ap.add_argument('--osm', required=True)
    a = ap.parse_args()
    land, face = footprint(a.site, a.osm)
    if land.geom_type == 'MultiPolygon':
        land = max(land.geoms, key=lambda g: g.area)
    model, mesh, _ = model_area(a.site, a.osm, land)
    model['name'] = 'Herne Bay'
    model['face'] = [[round(x, 1), round(z, 1)] for x, z in face.exterior.coords]
    json.dump(model, open(os.path.join(a.site, 'model.json'), 'w'))
    np.savez_compressed(os.path.join(a.site, 'mesh.npz'), **mesh)
    write_glb(os.path.join(a.site, 'herne_bay.glb'), mesh['pos'][mesh['tri'].ravel()], np.arange(len(mesh['tri']) * 3).reshape(-1, 3),
              np.repeat(mesh['tcol'], 3, 0), (model['size'] / 2, model['size'] / 2))
    print(json.dumps(model['stats'], indent=1))


if __name__ == '__main__':
    main()
