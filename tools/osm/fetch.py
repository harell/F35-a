"""
Download the OpenStreetMap inputs for bake.py (see README.md). Never queries Overpass.

  python3 fetch.py geofabrik [YYMMDD] <work>   Geofabrik New Zealand extract: the dated file
                                               new-zealand-YYMMDD.osm.pbf (pinned), or -latest without a date
  python3 fetch.py bbbike <work>               BBBike's weekly Auckland extract (174.45..175.05, -37.15..-36.66):
                                               ~70 MB instead of ~400 MB, but it misses the world's northern edge
  python3 fetch.py api <minlon,minlat,maxlon,maxlat> <out.osm>
                                               a small box from the OSM API (≤ 0.25 deg², e.g. an airfield a
                                               regional extract cuts off); its date is the download time
  python3 fetch.py strips <work>               the parts of the world box (174.31..175.21, -37.21..-36.49) outside
                                               BBBike's box, from the OSM API in 0.05° tiles (a tile the API refuses
                                               for its 50,000-node limit is split in four), merged into one
                                               <work>/akl-strips.osm.pbf (tiles kept in <work>/api-tiles/)

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

WORLD = (174.31, -37.21, 175.21, -36.49)    # min lon, min lat, max lon, max lat (bake.py BBOX)
BBBIKE_BOX = (174.45, -37.15, 175.05, -36.66)
TILE = 0.05     # deg
OVERLAP = 0.01  # deg into BBBike's box, so ways it cuts at its edge come in whole

def strips():
    """The world box minus BBBike's (grown inward by OVERLAP), as four boxes."""
    W, B = WORLD, BBBIKE_BOX
    x0, y0, x1, y1 = B[0] + OVERLAP, B[1] + OVERLAP, B[2] - OVERLAP, B[3] - OVERLAP
    return [
        (W[0], W[1], x0, W[3]),  # west, full height
        (x1, W[1], W[2], W[3]),  # east, full height
        (x0, y1, x1, W[3]),      # north, between them
        (x0, W[1], x1, y0),      # south, between them
    ]

def api_tile(box, out_dir, depth=0):
    """Download one box (split in four while the API refuses it for too many nodes). Returns the files."""
    import urllib.error, time
    name = os.path.join(out_dir, 'tile_%.4f_%.4f_%.4f_%.4f.osm' % box)
    if os.path.exists(name) and os.path.getsize(name) > 0:
        return [name]
    bb = ','.join('%.4f' % v for v in box)
    for attempt in range(4):
        try:
            get(API.format(bb), name + '.part')
            os.replace(name + '.part', name)
            time.sleep(1)  # be gentle with the API
            return [name]
        except urllib.error.HTTPError as e:
            if e.code == 400 and depth < 6:  # too many nodes: split
                a, b, c, d = box
                mx, my = (a + c) / 2, (b + d) / 2
                out = []
                for q in ((a, b, mx, my), (mx, b, c, my), (a, my, mx, d), (mx, my, c, d)):
                    out += api_tile(q, out_dir, depth + 1)
                return out
            if e.code in (429, 509, 503, 504):
                time.sleep(30 * (attempt + 1))
                continue
            raise
        except (urllib.error.URLError, ConnectionError, TimeoutError):
            time.sleep(15 * (attempt + 1))
    raise SystemExit('could not download ' + bb)

def fetch_strips(work):
    import math, osmium
    tiles = os.path.join(work, 'api-tiles')
    os.makedirs(tiles, exist_ok=True)
    files = []
    for s in strips():
        nx = max(1, math.ceil((s[2] - s[0]) / TILE - 1e-9))
        ny = max(1, math.ceil((s[3] - s[1]) / TILE - 1e-9))
        for j in range(ny):
            for i in range(nx):
                box = (s[0] + (s[2] - s[0]) * i / nx, s[1] + (s[3] - s[1]) * j / ny,
                       s[0] + (s[2] - s[0]) * (i + 1) / nx, s[1] + (s[3] - s[1]) * (j + 1) / ny)
                files += api_tile(tuple(round(v, 4) for v in box), tiles)
    out = os.path.join(work, 'akl-strips.osm.pbf')
    if os.path.exists(out):
        os.remove(out)
    # one file, each object once (its newest version), sorted, so bake.py can assemble areas across tiles
    reader = osmium.MergeInputReader()
    for f in sorted(files):
        reader.add_file(f)
    writer = osmium.SimpleWriter(out)
    reader.apply(writer, simplify=True)
    writer.close()
    h = hashlib.sha256(open(out, 'rb').read()).hexdigest()
    print(out, os.path.getsize(out), 'bytes,', len(files), 'tiles, sha256', h)

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
    elif mode == 'strips':
        fetch_strips(sys.argv[2])
    else:
        sys.exit(__doc__)

if __name__ == '__main__':
    main()
