"""
F35-A — hero neighbourhoods: fill tools/hero/examples/neighbourhoods.html with Herne Bay and Westhaven → <out>.

  python3 tools/hero/sites/herne_bay.py --site /tmp/hero/herne_bay --osm /tmp/hero/osm/herne_bay.osm
  python3 tools/hero/sites/westhaven.py --site /tmp/hero/westhaven --osm /tmp/hero/osm/westhaven.osm
  npx vite --config vite.e2e.config.ts --port 5190 &
  node tools/hero/today-shot.mjs --x=-2600 --z=-330 --dist=1300 --alt=520 --from=se --out=/tmp/hero/shots/hb_se.jpg   (and nw;
       Westhaven: --x=-1180 --z=-1050 --dist=1100 --alt=450 --from=sw / ne → wh_sw.jpg, wh_ne.jpg)
  python3 tools/hero/sites/neighbourhoods_page.py --out /tmp/hero/neighbourhoods.html

Per area the page gets: the buildings mesh (int16 decimetres, gzip), trees, boats, pontoons/piers as a mesh, the OSM
carriageways as a draped ribbon mesh (an overlay, never part of the model), the LiDAR DEM at 4 m, the aerial at ~0.9 m/px,
the two "today" frames and the cameras that took them, moved from game XZ into the site frame through WGS84.
"""
import argparse, base64, gzip, io, json, math, os, sys

import numpy as np
import shapely
from PIL import Image
from pyproj import Transformer
from scipy import ndimage
from shapely.geometry import LineString, Polygon
from shapely.ops import unary_union

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, '..'))
from neighbourhood import load_lidar, mesh_building, pack_mesh  # noqa: E402

Image.MAX_IMAGE_PIXELS = None
to_nztm = Transformer.from_crs(4326, 2193, always_xy=True)
O_LAT, O_LON, MLAT = -36.8485, 174.7622, 110950
MLON = 111320 * math.cos(math.radians(O_LAT))

AREAS = {
    'herne_bay': {'site': '/tmp/hero/herne_bay', 'shots': [('se', -2600, -330, 1300, 520), ('nw', -2600, -330, 1300, 520)], 'tex': 2048},
    'westhaven': {'site': '/tmp/hero/westhaven', 'shots': [('sw', -1180, -1050, 1100, 450), ('ne', -1180, -1050, 1100, 450)], 'tex': 2048},
}
DIRS = {'sw': (-1, 1), 'se': (1, 1), 'nw': (-1, -1), 'ne': (1, -1)}


def gz64(a):
    return base64.b64encode(gzip.compress(np.ascontiguousarray(a).tobytes(), 9)).decode()


def jpeg(img, q):
    buf = io.BytesIO()
    img.save(buf, 'JPEG', quality=q, optimize=True)
    return 'data:image/jpeg;base64,' + base64.b64encode(buf.getvalue()).decode()


def slab_mesh(rings, y, depth=0.5):
    parts = []
    for r, yy in rings:
        P = Polygon(r).buffer(0)
        for g in getattr(P, 'geoms', [P]):
            if g.geom_type == 'Polygon' and g.area > 0.5:
                pos, tri, kind = mesh_building(g, {'kind': 'flat', 'eave': yy, 'y0': yy - depth})
                parts.append((pos, tri, kind, 0))
    pos, tri, _, _ = pack_mesh(parts)
    return pos, tri


def road_mesh(roads, dem, lift=0.25):
    polys = [LineString(r['pts']).buffer(r['width'] / 2, cap_style='flat', join_style='round') for r in roads
             if len(r['pts']) > 1 and not r['tunnel'] and r['kind'] not in ('motorway', 'motorway_link')]
    U = unary_union(polys)
    H, W = dem.shape
    P, T = [], []
    off = 0
    for g in getattr(U, 'geoms', [U]):
        if g.geom_type != 'Polygon':
            continue
        g = shapely.segmentize(g, 5.0)
        for t in shapely.constrained_delaunay_triangles(g).geoms:
            cc = np.array(t.exterior.coords)[:3]
            a, b, c = cc
            if (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]) > 0:
                cc = cc[[0, 2, 1]]
            y = ndimage.map_coordinates(dem, [np.clip(cc[:, 1], 0, H - 1), np.clip(cc[:, 0], 0, W - 1)], order=1) + lift
            P.append(np.stack([cc[:, 0], y, cc[:, 1]], 1))
            T.append([off, off + 1, off + 2])
            off += 3
    return np.concatenate(P), np.array(T), U.area


def gzn(b):
    return len(gzip.compress(bytes(b), 9))


def sizes(M, mesh):
    """Gzipped bytes of each part of the model in two shipping formats: a baked mesh, or parameters the game rebuilds."""
    import struct
    pos = np.round(mesh['pos'] * 10).astype(np.int16).tobytes()
    tri = mesh['tri'].astype(np.uint32).tobytes()
    col = mesh['tcol'].astype(np.uint8).tobytes()
    out = bytearray()
    kinds = {'flat': 0, 'gable': 1, 'hip': 2, 'skel': 3}
    for b in M['buildings']:  # u8 n, base, eave (dm), pitch (‰), kind, roof rgb, ring as int16 dm deltas
        r = np.round(np.array(b['ring'][:-1]) * 10).astype(np.int32)
        out += struct.pack('<BhhhBBBB', len(r), int(b['y0'] * 10), int(b['eave'] * 10), int(b.get('pitch', 0) * 1000), kinds[b['kind']], *b['roof'])
        out += np.diff(np.vstack([[0, 0], r]), axis=0).astype(np.int16).tobytes()
    T = np.array(M['trees'], np.float64).reshape(-1, 9)
    xy = np.ascontiguousarray(np.round(T[:, :2] * 10).astype(np.int16)).view(np.uint8).reshape(len(T), 4)
    rest = np.c_[np.round(np.c_[T[:, 3] - T[:, 2], T[:, 4], T[:, 5] - T[:, 2]] * 4).clip(0, 255), T[:, 6:9]].astype(np.uint8)
    C = M['canopy']
    grid = np.array(C['cover'], np.uint8).tobytes() + np.array(C['height'], np.uint8).tobytes()
    B = M.get('boats', [])
    return {'mesh_pos': gzn(pos), 'mesh_tri': gzn(tri), 'mesh_col': gzn(col), 'params': gzn(out),
            'trees': gzn(np.ascontiguousarray(np.concatenate([xy, rest], 1)).tobytes()), 'canopy': gzn(grid),
            'boats': gzn(np.round(np.array(B, np.float64).reshape(-1, 11)[:, :8] * 10).astype(np.int16).tobytes()) if B else 0,
            'n_trees': len(T), 'n_cells': int(sum(1 for c in C['cover'] if c > 0))}


def no_tree_mask(M, res=2):
    """Page only: a 2 m bit mask of buildings and carriageways, where the canopy-grid scatter may not put a trunk
    (the game knows both from its own layers)."""
    from heights import ring_mask
    n = M['size'] // res
    m = np.zeros((n, n), bool)
    for b in M['buildings']:
        m |= ring_mask(m.shape, [(x / res, z / res) for x, z in b['ring']])
    U = unary_union([LineString(r['pts']).buffer(r['width'] / 2 / res * res, cap_style='flat') for r in M['roads'] if len(r['pts']) > 1])
    for g in getattr(U, 'geoms', [U]):
        if g.geom_type == 'Polygon':  # the street network's union holds the blocks as holes
            r = ring_mask(m.shape, [(x / res, z / res) for x, z in g.exterior.coords])
            for h in g.interiors:
                r &= ~ring_mask(m.shape, [(x / res, z / res) for x, z in h.coords])
            m |= r
    return {'n': int(n), 'res': res, 'bits': base64.b64encode(gzip.compress(np.packbits(m.ravel()).tobytes(), 9)).decode()}


def i16(a):
    return np.round(np.asarray(a, np.float64) * 10).astype(np.int16)


def build_area(key, cfg):
    site = cfg['site']
    S = json.load(open(os.path.join(site, 'site.json')))
    M = json.load(open(os.path.join(site, 'model.json')))
    E0, N1 = S['box_nztm'][0], S['box_nztm'][3]
    SIZE = M['size']
    mesh = np.load(os.path.join(site, 'mesh.npz'))
    dsm, dem = load_lidar(site)

    def to_site(gx, gz):
        lon, lat = O_LON + np.asarray(gx, float) / MLON, O_LAT - np.asarray(gz, float) / MLAT
        E, N = to_nztm.transform(lon, lat)
        return np.asarray(E) - E0, N1 - np.asarray(N)

    # the ground: LiDAR DEM at 4 m, water held at the sea plane
    r = 4
    n = SIZE // r + 1
    idx = np.minimum(np.arange(n) * r, SIZE - 1)
    g4 = dem[np.ix_(idx, idx)]
    sea = M.get('sea', -0.6)
    # buildings
    pos, tri, tcol = mesh['pos'], mesh['tri'], mesh['tcol']
    # pontoons, piers
    rings = [(p['ring'], p['y']) for p in M.get('pontoons', [])] + [(p['ring'], p['y']) for p in M['piers']]
    spos, stri = slab_mesh(rings, 0) if rings else (np.zeros((0, 3)), np.zeros((0, 3), int))
    rpos, rtri, rarea = road_mesh(M['roads'], dem)
    trees = np.array(M['trees'], np.float64).reshape(-1, 9)
    boats = np.array(M.get('boats', []), np.float64).reshape(-1, 11)
    # the frames from the game and their cameras in the site frame
    shots, cams = {}, {}
    for side, gx, gz, dist, alt in cfg['shots']:
        k = dist / math.sqrt(2)
        dx, dz = DIRS[side]
        cx, cz = to_site([gx + dx * k], [gz + dz * k])
        tx, tz = to_site([gx], [gz])
        cams[side] = {'pos': [round(float(cx[0]), 1), alt, round(float(cz[0]), 1)], 'look': [round(float(tx[0]), 1), 10, round(float(tz[0]), 1)]}
        im = Image.open(f"/tmp/hero/shots/{'hb' if key == 'herne_bay' else 'wh'}_{side}.jpg").convert('RGB')
        if side in ('sw', 'nw'):  # the keyboard help card sits bottom-left: crop it off, keeping 16:9
            im = im.crop((240, 0, 1280, 585))
        shots[side] = jpeg(im.resize((960, 540), Image.LANCZOS), 80)
    full = Image.open(os.path.join(site, 'aerial.jpg')).convert('RGB')
    tex = jpeg(full.resize((cfg['tex'], cfg['tex']), Image.LANCZOS), 80)
    st = M['stats']
    data = {
        'key': key, 'name': M['name'], 'size': SIZE, 'sea': sea, 'stats': st, 'cams': cams,
        'E0': E0, 'N1': N1, 'centre': S['centre'],
        'footprint': M['footprint'], 'exclude': M.get('exclude', []),
        'ground': {'n': int(n), 'res': r, 'h': gz64(i16(g4))},
        'bld': {'pos': gz64(i16(pos)), 'tri': gz64(tri.astype(np.uint32)), 'col': gz64(tcol.astype(np.uint8)), 'nt': int(len(tri)), 'nv': int(len(pos))},
        'slab': {'pos': gz64(i16(spos)), 'tri': gz64(stri.astype(np.uint32)), 'nt': int(len(stri)), 'nv': int(len(spos))},
        'road': {'pos': gz64(i16(rpos)), 'tri': gz64(rtri.astype(np.uint32)), 'nt': int(len(rtri)), 'nv': int(len(rpos))},
        'trees': {'n': int(len(trees)), 'xyz': gz64(i16(trees[:, :6])), 'col': gz64(trees[:, 6:9].astype(np.uint8))},
        'boats': {'n': int(len(boats)), 'f': gz64(np.round(boats[:, :8] * np.array([10, 10, 1000, 10, 10, 10, 10, 10])).astype(np.int16)),
                  'col': gz64(boats[:, 8:11].astype(np.uint8))},
        'kinds': st.get('kinds', {}),
        'canopy': M['canopy'], 'nomask': no_tree_mask(M), 'sizes': sizes(M, mesh),
        'tallest': sorted([{'name': b.get('name') or '', 'h': round(b['eave'] - b['y0'], 1)} for b in M['buildings']], key=lambda b: -b['h'])[:3],
    }
    return data, tex, shots


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default='/tmp/hero/neighbourhoods.html')
    a = ap.parse_args()
    page = open(os.path.join(HERE, '..', 'examples', 'neighbourhoods.html')).read()
    all_data, texs, shots = {}, {}, {}
    for key, cfg in AREAS.items():
        d, t, s = build_area(key, cfg)
        all_data[key] = d
        texs[key] = t
        shots[key] = s
        print(key, json.dumps({k: v for k, v in d['stats'].items() if k != 'roads'}), json.dumps(d['stats']['roads']))
    script = ('const DATA=' + json.dumps(all_data, separators=(',', ':')) + ';const TEX=' + json.dumps(texs) + ';const SHOTS=' + json.dumps(shots) + ';')
    page = page.replace('/*@DATA@*/', script)
    open(a.out, 'w').write(page)
    print(a.out, round(len(page) / 1e6, 2), 'MB')


if __name__ == '__main__':
    main()
