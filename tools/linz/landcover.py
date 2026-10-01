"""
Download the land-cover and bathymetry inputs of bake.py into <work> (cached: delete a file to refresh).

  veg-50306.json   NZ Native Polygons (Topo, 1:50k)   -> native bush / forest
  veg-50267.json   NZ Exotic Polygons (Topo, 1:50k)   -> plantation forest (pines)
  veg-50339.json   NZ Scrub Polygons (Topo, 1:50k)    -> scrub (sparse bush)
  depare-50671.json / 50553 / 50447 / 50852
                   Depth area polygons (Hydro) at 1:4k-22k, 1:22k-90k, 1:90k-350k, 1:350k-1.5M: the ENC depth
                   bands (drval1..drval2, metres below chart datum; negative = drying height) -> water depth

All are WFS GeoJSON in NZTM2000 (EPSG:2193, the DEM mosaics' grid) and need LINZ_API_KEY. LINZ licenses them
CC BY 4.0. The hydrographic layers are ENC data: not for navigation (nor is the game).

Usage: python3 landcover.py <work>
"""
import json, os, sys, urllib.parse, urllib.request

D = sys.argv[1] if len(sys.argv) > 1 else '.'
VEG_LAYERS = {50306: 'native', 50267: 'exotic', 50339: 'scrub'}
DEPTH_LAYERS = (50671, 50553, 50447, 50852)   # finest chart scale first
# The ±45 km world box: NZTM2000 (northing, easting order) for the Topo50 layers, whose geometry column is
# GEOMETRY in NZTM; lat/lon for the Hydro layers (column `shape`, NZGD2000 geographic).
BBOX_TOPO = 'BBOX(GEOMETRY,5870000,1700000,5975000,1810000)'
BBOX_HYDRO = 'BBOX(shape,-37.27,174.25,-36.43,175.27)'


def fetch(path, url):
    if os.path.exists(path):
        print('cached', path)
        return
    print('get', url.split('?')[0])
    with urllib.request.urlopen(url, timeout=600) as r:
        data = r.read()
    open(path, 'wb').write(data)


def wfs(path, layer, cql):
    q = {'service': 'WFS', 'version': '2.0.0', 'request': 'GetFeature', 'outputFormat': 'json',
         'srsName': 'EPSG:2193', 'typeNames': f'layer-{layer}', 'cql_filter': cql}
    fetch(path, f'https://data.linz.govt.nz/services;key={key}/wfs?' + urllib.parse.urlencode(q))
    print(path, len(json.load(open(path))['features']), 'polygons')


key = os.environ.get('LINZ_API_KEY')
if not key:
    sys.exit('LINZ_API_KEY is not set (free key from https://data.linz.govt.nz)')
for layer in VEG_LAYERS:
    wfs(f'{D}/veg-{layer}.json', layer, BBOX_TOPO)
for layer in DEPTH_LAYERS:
    wfs(f'{D}/depare-{layer}.json', layer, BBOX_HYDRO)
