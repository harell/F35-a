"""
F35-A — hero buildings: reference views from Auckland Council's 2023 textured 3D mesh ("Auckland CBD to Airport 3D Mesh",
captured August 2023, 6 cm texture, 25 cm RMSE; CC BY 4.0), a public ArcGIS I3S scene service, no key.

What it gives that nothing else does: every side of a building in colour, straight on (walls no street photo reaches,
the inner faces of a block, podium roofs), and roofs seen from straight above with no lean. Read colours, materials,
fins and panels, window rhythm and setbacks off the views; take heights from the LiDAR (tools/hero/heights.py,
pointcloud.py), which is more accurate.

  python3 tools/hero/mesh3d.py --site /tmp/hero/<id> [--match <OSM name>] [--px 0.1] [--zone 1A]

Crawls the service's node pages for the finest-level nodes over the site box (or the matched OSM buildings + 20 m),
caches their geometry and textures in /tmp/hero/_i3s/<zone>/ (~2 MB a node; the Scene apartments took 120 nodes, 25 s),
and writes into the site folder:
  mesh_<side>.jpg   orthographic views from south, north, east, west at --px m per pixel (heights from 0 to 120 m)
  mesh_top.jpg      the plan view, north up, same frame as aerial.jpg (x = E − E0, z = N1 − N)
Zone 1A covers the CBD and the waterfront; other zones of the same dataset follow the corridor to the airport.
"""
import argparse, gzip, json, os, time, urllib.request
from concurrent.futures import ThreadPoolExecutor

import numpy as np
from PIL import Image

SERVICE = 'https://tiles.arcgis.com/tiles/n4yPwebTjJCmXB6W/arcgis/rest/services/Akl_CBD_to_Airport_3D_Mesh_Zone{zone}/SceneServer/layers/0'


def get(url):
    for k in range(4):
        try:
            b = urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'F35-A-hero-buildings/1.0'}), timeout=90).read()
            return gzip.decompress(b) if b[:2] == b'\x1f\x8b' else b
        except Exception as e:  # noqa: BLE001 — retry transient errors
            print('retry', url, e)
            time.sleep(2 * (k + 1))
    raise RuntimeError(url)


def crawl(base, box):
    """Leaf nodes whose oriented box meets `box` (E0, N0, E1, N1, NZTM)."""
    pages = {}

    def node(i):
        p = i // 64
        if p not in pages:
            pages[p] = json.loads(get(f'{base}/nodepages/{p}'))['nodes']
        return pages[p][i % 64]

    leaves, stack = [], [0]
    while stack:
        n = node(stack.pop())
        c, h = n['obb']['center'], n['obb']['halfSize']
        r = max(h) * 1.8
        if c[0] + r < box[0] or c[0] - r > box[2] or c[1] + r < box[1] or c[1] - r > box[3]:
            continue
        ch = n.get('children', [])
        if ch:
            stack += ch
        elif 'mesh' in n:
            leaves.append(n)
    return leaves


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--site', required=True)
    ap.add_argument('--match', default='', help='OSM building name (substring): views of these buildings only')
    ap.add_argument('--px', type=float, default=0.1)
    ap.add_argument('--zone', default='1A')
    a = ap.parse_args()
    from shapely import contains_xy
    from shapely.geometry import Polygon, box as sbox
    from shapely.ops import unary_union

    site = json.load(open(f'{a.site}/site.json'))
    E0, N0, E1, N1 = site['box_nztm']
    area = sbox(E0, N0, E1, N1)
    if a.match:
        feats = [f for f in json.load(open(f'{a.site}/osm.json'))['features'] if a.match.lower() in f['tags'].get('name', '').lower() and len(f['ring']) > 3]
        area = unary_union([Polygon([(E0 + x, N1 - z) for x, z in f['ring']]).buffer(0) for f in feats]).buffer(20)
    base = SERVICE.format(zone=a.zone)
    leaves = crawl(base, area.bounds)
    cache = f'/tmp/hero/_i3s/{a.zone}'
    os.makedirs(cache, exist_ok=True)

    def one(n):
        r, m = n['mesh']['geometry']['resource'], n['mesh']['material']['resource']
        g, t = f'{cache}/{r}.bin', f'{cache}/{r}.jpg'
        if not os.path.exists(g):
            open(g, 'wb').write(get(f'{base}/nodes/{r}/geometries/0'))
        if not os.path.exists(t):
            open(t, 'wb').write(get(f'{base}/nodes/{m}/textures/0'))
        return n

    with ThreadPoolExecutor(8) as ex:
        leaves = list(ex.map(one, leaves))
    print(len(leaves), 'mesh nodes over the area')

    # sample every triangle's texture into points (x, z site frame; y height), then splat orthographic views
    U, V, W, Cc = [], [], [], []
    for n in leaves:
        r = n['mesh']['geometry']['resource']
        b = open(f'{cache}/{r}.bin', 'rb').read()
        nv = int(np.frombuffer(b[:4], np.uint32)[0])
        o = 8
        P = np.frombuffer(b[o:o + nv * 12], np.float32).reshape(-1, 3).astype(np.float64) + n['obb']['center']
        o += nv * 24  # positions, normals
        UV = np.frombuffer(b[o:o + nv * 8], np.float32).reshape(-1, 2)
        tex = np.asarray(Image.open(f'{cache}/{r}.jpg').convert('RGB'))
        T, TU = P.reshape(-1, 3, 3), UV.reshape(-1, 3, 2)
        cen = T.mean(1)
        k = contains_xy(area, cen[:, 0], cen[:, 1])
        T, TU = T[k], TU[k]
        if not len(T):
            continue
        ab = np.linalg.norm(np.cross(T[:, 1] - T[:, 0], T[:, 2] - T[:, 0]), axis=1) / 2
        cnt = np.clip(np.ceil(ab / (a.px * a.px) * 2.5).astype(int), 1, 1600)
        idx = np.repeat(np.arange(len(T)), cnt)
        r1, r2 = np.random.rand(len(idx)), np.random.rand(len(idx))
        s = np.sqrt(r1)
        w = np.stack([1 - s, s * (1 - r2), s * r2], 1)
        p = (w[:, :, None] * T[idx]).sum(1)
        uv = (w[:, :, None] * TU[idx]).sum(1)
        H, Wd = tex.shape[:2]
        Cc.append(tex[np.clip((uv[:, 1] % 1) * H, 0, H - 1).astype(int), np.clip((uv[:, 0] % 1) * Wd, 0, Wd - 1).astype(int)])
        U.append(p[:, 0] - E0); W.append(N1 - p[:, 1]); V.append(p[:, 2])
    x, z, y, col = np.concatenate(U), np.concatenate(W), np.concatenate(V), np.concatenate(Cc)
    g = float(np.percentile(y, 1))
    for side in ('south', 'north', 'east', 'west', 'top'):
        if side == 'top':
            u, v, d = x, z, y
            u0, v0 = 0.0, 0.0
            Wi, Hi = int((E1 - E0) / a.px), int((N1 - N0) / a.px)
            iu, iv = (u / a.px).astype(int), (v / a.px).astype(int)
        else:
            u, d = {'south': (x, z), 'north': (-x, -z), 'east': (-z, x), 'west': (z, -x)}[side]
            u0 = float(np.percentile(u, 0.2))
            Wi = int((np.percentile(u, 99.8) - u0) / a.px) + 1
            Hi = int((min(float(y.max()), g + 120) - g) / a.px) + 1
            iu, iv = ((u - u0) / a.px).astype(int), (Hi - 1 - (y - g) / a.px).astype(int)
        ok = (iu >= 0) & (iu < Wi) & (iv >= 0) & (iv < Hi)
        o = np.argsort(d[ok])
        img = np.full((Hi, Wi, 3), 255, np.uint8)
        img[iv[ok][o], iu[ok][o]] = col[ok][o]
        Image.fromarray(img).save(f'{a.site}/mesh_{side}.jpg', quality=88)
        print(side, img.shape)


if __name__ == '__main__':
    main()
