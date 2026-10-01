"""
Download the OpenStreetMap inputs for bake.py (see README.md). Never queries Overpass.

  python3 fetch.py geofabrik [YYMMDD] <work>   Geofabrik New Zealand extract: the dated file
                                               new-zealand-YYMMDD.osm.pbf (pinned), or -latest without a date
  python3 fetch.py bbbike <work>               BBBike's weekly Auckland extract (174.45..175.05, -37.15..-36.66):
                                               ~70 MB instead of ~400 MB, but it misses the world's northern edge
  python3 fetch.py api <minlon,minlat,maxlon,maxlat> <out.osm>
                                               a small box from the OSM API (≤ 0.25 deg², e.g. an airfield a
                                               regional extract cuts off); its date is the download time

Prints the SHA-256 of what it wrote; bake.py records it in manifest.json.
"""
import hashlib, os, sys, urllib.request

GEOFABRIK = 'https://download.geofabrik.de/australia-oceania/new-zealand-{}.osm.pbf'
BBBIKE = 'https://download.bbbike.org/osm/bbbike/Auckland/Auckland.osm.pbf'
API = 'https://api.openstreetmap.org/api/0.6/map?bbox={}'
UA = {'User-Agent': 'F35-A scenery bake (tools/osm/fetch.py)'}

def get(url, out):
    print('GET', url)
    req = urllib.request.Request(url, headers=UA)
    h = hashlib.sha256()
    with urllib.request.urlopen(req) as r, open(out, 'wb') as f:
        while True:
            b = r.read(1 << 20)
            if not b:
                break
            h.update(b)
            f.write(b)
    print(out, os.path.getsize(out), 'bytes, sha256', h.hexdigest())

def main():
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    mode = sys.argv[1]
    if mode == 'geofabrik':
        date = sys.argv[2] if len(sys.argv) > 3 else 'latest'
        work = sys.argv[-1]
        os.makedirs(work, exist_ok=True)
        get(GEOFABRIK.format(date), os.path.join(work, f'new-zealand-{date}.osm.pbf'))
    elif mode == 'bbbike':
        os.makedirs(sys.argv[2], exist_ok=True)
        get(BBBIKE, os.path.join(sys.argv[2], 'Auckland.osm.pbf'))
    elif mode == 'api':
        a, b, c, d = (float(v) for v in sys.argv[2].split(','))
        if (c - a) * (d - b) > 0.25:
            sys.exit('the OSM API serves at most 0.25 square degrees')
        get(API.format(sys.argv[2]), sys.argv[3])
    else:
        sys.exit(__doc__)

if __name__ == '__main__':
    main()
