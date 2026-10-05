"""
Download the LINZ Topo50 polygons the land-use layer uses to fill gaps in OpenStreetMap (see README.md):

  topo-50281.json   NZ Golf Course Polygons (Topo, 1:50k)  -> golf course
  topo-50255.json   NZ Cemetery Polygons (Topo, 1:50k)     -> cemetery

WFS GeoJSON in NZTM2000 (EPSG:2193) over the ±45 km world box; needs LINZ_API_KEY (free key from
https://data.linz.govt.nz, never commit it). LINZ licenses them CC BY 4.0. Cached: delete a file to refresh.

Usage: python3 topo50.py <work>
"""
import json, os, sys, urllib.parse, urllib.request

LAYERS = {50281: 'golf', 50255: 'cemetery'}
# The ±45 km world box in NZTM2000 (northing, easting order: the layers' GEOMETRY column), as tools/linz/landcover.py
BBOX_TOPO = 'BBOX(GEOMETRY,5870000,1700000,5975000,1810000)'


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    work = sys.argv[1]
    key = os.environ.get('LINZ_API_KEY')
    if not key:
        sys.exit('LINZ_API_KEY is not set (free key from https://data.linz.govt.nz)')
    os.makedirs(work, exist_ok=True)
    for layer in LAYERS:
        path = os.path.join(work, f'topo-{layer}.json')
        if not os.path.exists(path):
            q = {'service': 'WFS', 'version': '2.0.0', 'request': 'GetFeature', 'outputFormat': 'json',
                 'srsName': 'EPSG:2193', 'typeNames': f'layer-{layer}', 'cql_filter': BBOX_TOPO}
            print('get', path)  # not the URL: the API key is in its path
            with urllib.request.urlopen(f'https://data.linz.govt.nz/services;key={key}/wfs?' + urllib.parse.urlencode(q), timeout=600) as r:
                open(path, 'wb').write(r.read())
        print(path, len(json.load(open(path))['features']), LAYERS[layer], 'polygons')


if __name__ == '__main__':
    main()
