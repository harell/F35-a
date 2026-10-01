"""
Download the land-cover and bathymetry inputs of bake.py into <work> (cached: delete a file to refresh).

  veg-50306.json   NZ Native Polygons (Topo, 1:50k)   -> native bush / forest
  veg-50267.json   NZ Exotic Polygons (Topo, 1:50k)   -> plantation forest (pines)
  veg-50339.json   NZ Scrub Polygons (Topo, 1:50k)    -> scrub (sparse bush)
  niwa250.tif      NIWA NZ bathymetry 250 m (2016), the world box in its native NZCS2000 (EPSG:3851) cells

The LINZ layers are WFS GeoJSON in NZTM2000 (EPSG:2193, the DEM mosaics' grid); they need LINZ_API_KEY.
The NIWA grid comes from the GNS Science mirror of the model (the NIWA image server and FTP are often down);
S16 metres relative to mean sea level, land positive.

Usage: python3 landcover.py <work>
"""
import json, os, sys, urllib.parse, urllib.request

D = sys.argv[1] if len(sys.argv) > 1 else '.'
VEG_LAYERS = {50306: 'native', 50267: 'exotic', 50339: 'scrub'}
# NZTM2000 box (northing, easting order for the WFS BBOX filter) around the ±45 km world box
BBOX = '5870000,1700000,5975000,1810000'
# NIWA 250 m grid: whole cells of the published grid (origin 1315947.877, 4997698.101) around the world box
NIWA_X0, NIWA_Y0, NIWA_W, NIWA_H, NIWA_CELL = 3110697.87728211, 7410948.101281367, 376, 384, 250
NIWA_URL = 'https://gis.gns.cri.nz/server/rest/services/basemaps/NIWA_BathymetricElevationModel_NZCS/ImageServer/exportImage'


def fetch(path, url):
    if os.path.exists(path):
        print('cached', path)
        return
    print('get', url.split('?')[0])
    with urllib.request.urlopen(url, timeout=600) as r:
        data = r.read()
    open(path, 'wb').write(data)


key = os.environ.get('LINZ_API_KEY')
if not key:
    sys.exit('LINZ_API_KEY is not set (free key from https://data.linz.govt.nz)')
for layer, name in VEG_LAYERS.items():
    q = {'service': 'WFS', 'version': '2.0.0', 'request': 'GetFeature', 'outputFormat': 'json',
         'srsName': 'EPSG:2193', 'typeNames': f'layer-{layer}', 'cql_filter': f'BBOX(GEOMETRY,{BBOX})'}
    path = f'{D}/veg-{layer}.json'
    fetch(path, f'https://data.linz.govt.nz/services;key={key}/wfs?' + urllib.parse.urlencode(q))
    print(name, len(json.load(open(path))['features']), 'polygons')

q = {'bbox': f'{NIWA_X0},{NIWA_Y0},{NIWA_X0 + NIWA_W * NIWA_CELL},{NIWA_Y0 + NIWA_H * NIWA_CELL}',
     'bboxSR': 3851, 'imageSR': 3851, 'size': f'{NIWA_W},{NIWA_H}', 'format': 'tiff', 'pixelType': 'S16',
     'noData': -32768, 'interpolation': 'RSP_NearestNeighbor', 'f': 'image'}
fetch(f'{D}/niwa250.tif', NIWA_URL + '?' + urllib.parse.urlencode(q))
