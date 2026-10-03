"""
F35-A — hero buildings: fetch everything LINZ has for one site, ready to model from.

Given a centre (WGS84) and a box size, writes into <out>/:
  lidar.npz      1 m DSM and DEM over the box (float32, NZTM rows north → south), plus the box corners
  ndsm.png       height above ground (DSM − DEM), 0–<scale> m as black → white, 4 px per metre
  aerial.jpg     the 2024 7.5 cm urban aerial over the box, resampled to <res> m/px (north up)
  heights.json   nDSM on a 2 m grid {res, w, h, z[]} for prototypes (row-major, south = +z)
  site.json      box (NZTM and WGS84), the game-frame centre, ground height, nDSM percentiles,
                 and the tiles used, so the numbers can be traced

Sources (public, no API key, CC BY 4.0, LINZ / Auckland Council):
  s3://nz-elevation/auckland/auckland-part-1_2024/{dsm,dem}_1m/2193/   (mainland; part-2 = gulf islands)
  s3://nz-imagery/auckland/auckland_2024_0.075m/rgb/2193/
Tiles are found through each collection's STAC items (bbox test), and cached in <cache>/ so the
17,739-item aerial catalogue is read once.

  python3 tools/hero/site.py --name westfield_newmarket --lat -36.8697 --lon 174.7776 --size 300 \
      [--out /tmp/hero/<name>] [--res 0.15] [--scale 60] [--part 1]

Needs: numpy, rasterio, pyproj, pillow (pip install numpy rasterio pyproj pillow).
"""
import argparse, concurrent.futures as cf, json, math, os, urllib.request

import numpy as np
import rasterio
from PIL import Image
from pyproj import Transformer
from rasterio.windows import from_bounds

os.environ.setdefault('GDAL_DISABLE_READDIR_ON_OPEN', 'EMPTY_DIR')
os.environ.setdefault('GDAL_HTTP_MULTIRANGE', 'YES')

ELEV = 'https://nz-elevation.s3.ap-southeast-2.amazonaws.com/auckland/auckland-part-{part}_2024/{kind}_1m/2193'
AERIAL = 'https://nz-imagery.s3.ap-southeast-2.amazonaws.com/auckland/auckland_2024_0.075m/rgb/2193'
# game frame: origin at the Sky Tower (AKL_ORIGIN), +x east, +z south (src/core/auckland.ts)
ORIGIN = (-36.8485, 174.7622)
MLAT = 110950
MLON = 111320 * math.cos(math.radians(ORIGIN[0]))

to_nztm = Transformer.from_crs(4326, 2193, always_xy=True)
to_wgs = Transformer.from_crs(2193, 4326, always_xy=True)


def stac_tiles(base, bbox, cache):
    """The .tiff assets of the STAC items in `base` whose bbox meets `bbox` (lon0, lat0, lon1, lat1)."""
    os.makedirs(cache, exist_ok=True)
    path = os.path.join(cache, base.replace('https://', '').replace('/', '_') + '.json')
    if os.path.exists(path):
        items = json.load(open(path))
    else:
        col = json.load(urllib.request.urlopen(base + '/collection.json', timeout=60))
        hrefs = [l['href'] for l in col['links'] if l['rel'] == 'item']

        def get(h):
            for _ in range(4):
                try:
                    d = json.load(urllib.request.urlopen(base + '/' + h.lstrip('./'), timeout=30))
                    return {'bbox': d['bbox'], 'tif': [v['href'] for v in d['assets'].values() if v['href'].endswith('.tiff')]}
                except Exception:  # noqa: BLE001 — retry transient S3 errors
                    pass
            return None

        with cf.ThreadPoolExecutor(64) as ex:
            items = [r for r in ex.map(get, hrefs) if r]
        json.dump(items, open(path, 'w'))
    lo0, la0, lo1, la1 = bbox
    out = []
    for it in items:
        b = it['bbox']
        if b[0] < lo1 and b[2] > lo0 and b[1] < la1 and b[3] > la0:
            out += [t if t.startswith('http') else base + '/' + t.lstrip('./') for t in it['tif']]
    return out


def mosaic(urls, E0, N0, E1, N1, res, bands):
    """Read the box from each COG at `res` m/px into one array (north-up)."""
    W, H = int(round((E1 - E0) / res)), int(round((N1 - N0) / res))
    shape = (H, W) if bands == 1 else (H, W, 3)
    out = np.full(shape, np.nan if bands == 1 else 0, np.float32 if bands == 1 else np.uint8)
    for url in urls:
        with rasterio.open('/vsicurl/' + url) as s:
            b = s.bounds
            ix0, ix1, iy0, iy1 = max(b.left, E0), min(b.right, E1), max(b.bottom, N0), min(b.top, N1)
            if ix0 >= ix1 or iy0 >= iy1:
                continue
            oh, ow = int(round((iy1 - iy0) / res)), int(round((ix1 - ix0) / res))
            if oh < 1 or ow < 1:
                continue
            w = from_bounds(ix0, iy0, ix1, iy1, s.transform)
            r0, c0 = int(round((N1 - iy1) / res)), int(round((ix0 - E0) / res))
            if bands == 1:
                a = s.read(1, window=w, out_shape=(oh, ow), masked=True).astype(np.float32).filled(np.nan)
                sub = out[r0:r0 + oh, c0:c0 + ow]
                m = ~np.isnan(a[:sub.shape[0], :sub.shape[1]])
                sub[m] = a[:sub.shape[0], :sub.shape[1]][m]
            else:
                a = np.transpose(s.read([1, 2, 3], window=w, out_shape=(3, oh, ow)), (1, 2, 0))
                out[r0:r0 + oh, c0:c0 + ow] = a[:H - r0, :W - c0]
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--name', required=True)
    ap.add_argument('--lat', type=float, required=True)
    ap.add_argument('--lon', type=float, required=True)
    ap.add_argument('--size', type=float, default=250, help='box side, m')
    ap.add_argument('--res', type=float, default=0.15, help='aerial m/px')
    ap.add_argument('--scale', type=float, default=60, help='nDSM metres shown as white in ndsm.png')
    ap.add_argument('--part', type=int, default=1, help='LiDAR part: 1 mainland, 2 gulf islands')
    ap.add_argument('--out', default=None)
    ap.add_argument('--cache', default='/tmp/hero/_stac')
    a = ap.parse_args()
    out = a.out or f'/tmp/hero/{a.name}'
    os.makedirs(out, exist_ok=True)

    E, N = to_nztm.transform(a.lon, a.lat)
    E0, N0, E1, N1 = round(E - a.size / 2), round(N - a.size / 2), round(E + a.size / 2), round(N + a.size / 2)
    lo0, la0 = to_wgs.transform(E0, N0)
    lo1, la1 = to_wgs.transform(E1, N1)
    bbox = (lo0, la0, lo1, la1)

    lidar = {}
    tiles = {}
    for kind in ('dsm', 'dem'):
        base = ELEV.format(part=a.part, kind=kind)
        urls = stac_tiles(base, bbox, a.cache)
        tiles[kind] = [u.rsplit('/', 1)[1] for u in urls]
        lidar[kind] = mosaic(urls, E0, N0, E1, N1, 1.0, 1)
    nd = lidar['dsm'] - lidar['dem']
    np.savez_compressed(f'{out}/lidar.npz', dsm=lidar['dsm'], dem=lidar['dem'], box=np.array([E0, N0, E1, N1]))
    v = np.clip(np.nan_to_num(nd) / a.scale, 0, 1) * 255
    Image.fromarray(v.astype(np.uint8)).resize((nd.shape[1] * 4, nd.shape[0] * 4), Image.NEAREST).save(f'{out}/ndsm.png')
    h2 = np.nan_to_num(nd)[::2, ::2].clip(0, 400)
    json.dump({'res': 2, 'w': h2.shape[1], 'h': h2.shape[0], 'z': [round(float(x), 1) for x in h2.ravel()]}, open(f'{out}/heights.json', 'w'))

    aurls = stac_tiles(AERIAL, bbox, a.cache)
    tiles['aerial'] = [u.rsplit('/', 1)[1] for u in aurls]
    img = mosaic(aurls, E0, N0, E1, N1, a.res, 3)
    Image.fromarray(img).save(f'{out}/aerial.jpg', quality=88)

    gx, gz = (a.lon - ORIGIN[1]) * MLON, -(a.lat - ORIGIN[0]) * MLAT
    valid = nd[~np.isnan(nd)]
    site = {
        'name': a.name, 'centre': {'lat': a.lat, 'lon': a.lon, 'E': E, 'N': N, 'game_x': round(gx, 1), 'game_z': round(gz, 1)},
        'box_nztm': [E0, N0, E1, N1], 'box_wgs84': [lo0, la0, lo1, la1],
        'local_frame': 'metres, x = E − E0 (east), z = N1 − N (south); lidar arrays are [z, x]',
        'ground_m': round(float(np.nanmedian(lidar['dem'])), 1),
        'ndsm_percentiles_m': {p: round(float(np.percentile(valid, p)), 1) for p in (50, 90, 99, 100)},
        'tiles': tiles,
    }
    json.dump(site, open(f'{out}/site.json', 'w'), indent=1)
    print(json.dumps(site, indent=1))


if __name__ == '__main__':
    main()
