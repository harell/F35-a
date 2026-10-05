"""
F35-A — hero neighbourhoods: bake Herne Bay and Westhaven into src/world/scenery/data/auckland-neighbourhoods.bin
(decoded by src/world/scenery/aucklandNeighbourhoods.ts).

  python3 tools/hero/sites/herne_bay.py --site /tmp/hero/herne_bay --osm /tmp/hero/osm/herne_bay.osm
  python3 tools/hero/sites/westhaven.py --site /tmp/hero/westhaven --osm /tmp/hero/osm/westhaven.osm
  python3 tools/hero/sites/mission_bay.py --site /tmp/hero/mission_bay --osm /tmp/hero/osm/mission_bay.osm
  python3 tools/hero/sites/neighbourhoods_bake.py /tmp/hero/herne_bay /tmp/hero/westhaven /tmp/hero/mission_bay

  # or keep the areas already in the file (byte for byte) and bake only the sites given, replacing any of the same name:
  python3 tools/hero/sites/neighbourhoods_bake.py --keep /tmp/hero/mission_bay
  # the flight corridor's suburbs, one at a time in flight order (flight_corridor.py), each appended after the others:
  python3 tools/hero/sites/neighbourhoods_bake.py --keep /tmp/hero/whenuapai

What goes in (the review page's option C: buildings as parameters, trees as a canopy grid; see the skill):
  buildings  one record per building, its parts as prisms (a terraced roof is several), each the OSM / LiDAR-traced
             outline plus its roof: flat, gable or hip over the outline's minimum rotated rectangle (the game meshes
             these; the prototype's "hipped along any outline" kind is refitted here to the three the game draws),
             eave height above the ground at the outline's centroid, pitch, roof colour (aerial), wall colour
  canopy     a 20 m grid in game XZ: share under canopy (sixteenths) and its p75 height (0.5 m), off buildings, on land
  boats      Westhaven: centre, heading, length, beam, deck / cabin / mast heights above the water, hull colour
  pontoons   Westhaven: every walkway and finger, traced from the aerial
All positions in game XZ (m, origin the Sky Tower, +x east, +z south), from NZTM through WGS84 with the game's own
equirectangular geoToWorld (src/core/auckland.ts), fitted as one affine map per site (residual < 0.2 m).

Format (little-endian): 'AKLN' | u32 version | f32 quantum (m) | u32 areas | per area: u8 name length + UTF-8 |
footprint (varint n + vertices) | varint buildings | per building: varint parts | per part: u8 roof kind (0 flat,
1 gable, 2 hip) | varint eave (dm) | if pitched: u8 pitch (0.01 m/m), u16 long-axis angle (π / 65536), varint half
length A, half width B (dm), zig-zag varint rectangle centre minus the ring's first vertex (dm) | u8 roof rgb | u8 wall
rgb | ring (varint n + vertices) | canopy: f32 x0, z0, u8 cell, u16 nx, nz, nx·nz bytes cover, nx·nz bytes height |
varint boats | per boat: vertex, u8 heading (2π / 256), u8 length (0.2 m), u8 beam, deck, cabin (0.1 m), u8 mast
(0.2 m), u8 rgb | varint pontoons | per pontoon: ring. Vertices are zig-zag varint deltas (in quanta) from the
previous vertex written in the file. Rings counter-clockwise on the map (positive shoelace area in x, z).
Data: LINZ 2024 LiDAR and aerial (CC BY 4.0); outlines © OpenStreetMap contributors (ODbL 1.0: this file is a
derivative database; these steps rebuild it).
"""
import gzip, json, math, os, struct, sys

import numpy as np
from pyproj import Transformer
from scipy import ndimage
from shapely.geometry import Polygon

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, '..'))
from heights import ring_mask  # noqa: E402
from neighbourhood import aerial_at, fit_roof, load_lidar  # noqa: E402

OUT = os.path.join(HERE, '../../../src/world/scenery/data/auckland-neighbourhoods.bin')
to_wgs = Transformer.from_crs(2193, 4326, always_xy=True)
O_LAT, O_LON, MLAT = -36.8485, 174.7622, 110_950
MLON = 111_320 * math.cos(math.radians(O_LAT))
Q = 0.25
CELL = 20
KIND = {'flat': 0, 'gable': 1, 'hip': 2}


def site_to_game(S):
    """Affine map site frame (x, z) → game XZ, fitted on a grid of exact NZTM → WGS84 → geoToWorld transforms."""
    E0, N1 = S['box_nztm'][0], S['box_nztm'][3]
    W = S['box_nztm'][2] - E0
    g = np.linspace(0, W, 9)
    xx, zz = np.meshgrid(g, g)
    lon, lat = to_wgs.transform(E0 + xx.ravel(), N1 - zz.ravel())
    gx, gz = (lon - O_LON) * MLON, (O_LAT - lat) * MLAT
    A = np.stack([xx.ravel(), zz.ravel(), np.ones(xx.size)], 1)
    M, res, *_ = np.linalg.lstsq(A, np.stack([gx, gz], 1), rcond=None)
    err = np.abs(A @ M - np.stack([gx, gz], 1)).max()
    # 9.5 cm over Herne Bay's 1.8 km box, 17 cm over Mission Bay's 2.4 km (the quantum is 25 cm); a bigger box (the
    # flight corridor's: Mount Roskill 2.9 km, Māngere 4.6 km) bends more than an affine map holds: add the
    # quadratic terms for positions (directions and the canopy grid keep the affine part)
    Q2 = np.stack([xx.ravel(), zz.ravel(), np.ones(xx.size), xx.ravel() ** 2, xx.ravel() * zz.ravel(), zz.ravel() ** 2], 1)
    P, *_ = np.linalg.lstsq(Q2, np.stack([gx, gz], 1), rcond=None)
    err2 = np.abs(Q2 @ P - np.stack([gx, gz], 1)).max()
    assert min(err, err2) < 0.2, (err, err2)
    if err < 0.2:
        return M.T, None  # 2 × 3
    return M.T, P


def map_points(T, P, pts):
    """Site frame → game XZ: the affine map T, or the quadratic fit P where the box needs it."""
    a = np.asarray(pts, float).reshape(-1, 2)
    if P is None:
        return a @ T[:, :2].T + T[:, 2]
    x, z = a[:, 0], a[:, 1]
    return np.stack([x, z, np.ones_like(x), x * x, x * z, z * z], 1) @ P


class W:
    def __init__(self):
        self.b = bytearray()
        self.px = self.pz = 0

    def u8(self, v):
        self.b.append(int(max(0, min(255, round(v)))))

    def u16(self, v):
        self.b += struct.pack('<H', int(v) & 0xFFFF)

    def u32(self, v):
        self.b += struct.pack('<I', v)

    def f32(self, v):
        self.b += struct.pack('<f', v)

    def varint(self, v):
        v = int(v)
        assert v >= 0
        while True:
            c = v & 127
            v >>= 7
            if v:
                self.b.append(c | 128)
            else:
                self.b.append(c)
                return

    def zig(self, v):
        v = int(v)
        self.varint(-2 * v - 1 if v < 0 else 2 * v)

    def vertex(self, x, z):
        qx, qz = round(x / Q), round(z / Q)
        self.zig(qx - self.px)
        self.zig(qz - self.pz)
        self.px, self.pz = qx, qz

    def ring(self, pts):
        pts = list(pts)
        if len(pts) > 1 and np.allclose(pts[0], pts[-1]):
            pts = pts[:-1]
        a = sum(pts[i - 1][0] * pts[i][1] - pts[i][0] * pts[i - 1][1] for i in range(len(pts)))
        if a < 0:
            pts = pts[::-1]
        self.varint(len(pts))
        for x, z in pts:
            self.vertex(x, z)
        return pts


def bake_area(w, site):
    S = json.load(open(os.path.join(site, 'site.json')))
    M = json.load(open(os.path.join(site, 'model.json')))
    T, quad = site_to_game(S)
    to_g = lambda pts: map_points(T, quad, pts)
    lin = T[:, :2]
    dsm, dem = load_lidar(site)
    nd = np.clip(dsm - dem, 0, None)
    rgb = aerial_at(site, nd.shape)
    name = M['name'].encode()
    w.u8(len(name))
    w.b += name
    w.ring(to_g(M['footprint'][:-1]))
    # buildings: parts grouped by building id; a pitched roof refitted to flat / gable / hip
    groups = {}
    for b in M['buildings']:
        groups.setdefault(b['id'], []).append(b)
    w.varint(len(groups))
    kinds = {'flat': 0, 'gable': 0, 'hip': 0}
    for parts in groups.values():
        parts.sort(key=lambda b: -Polygon(b['ring']).area)
        w.varint(len(parts))
        for b in parts:
            P = Polygon(b['ring'])
            if b['kind'] == 'skel':
                f = fit_roof(P, dsm, dem, rgb, kinds=('gable', 'hip'))
                b = {**b, **{k: f[k] for k in ('kind', 'eave', 'pitch', 'frame')}} if f else {**b, 'kind': 'flat'}
            kinds[b['kind']] += 1
            ring = to_g(b['ring'][:-1])
            cx, cz = P.centroid.x, P.centroid.y
            g0 = float(ndimage.map_coordinates(dem, [[cz], [cx]], order=1)[0])
            w.u8(KIND[b['kind']])
            # at least a storey over the centroid's ground (a fit can sit low on a steep section or under a tree)
            w.varint(round(max(2.4, b['eave'] - g0) * 10))
            if b['kind'] != 'flat':
                (c, ax, ay, A, B) = b['frame']
                cg = to_g([c])[0]
                axg = lin @ np.array(ax)
                ang = math.atan2(axg[1], axg[0]) % math.pi
                w.u8(b['pitch'] * 100)
                w.u16(round(ang / math.pi * 65536) % 65536)
                w.varint(round(A * 10))
                w.varint(round(B * 10))
                # relative to the ring's first vertex as written (counter-clockwise)
                a = sum(ring[i - 1][0] * ring[i][1] - ring[i][0] * ring[i - 1][1] for i in range(len(ring)))
                first = ring[0] if a >= 0 else ring[-1]
                w.zig(round((cg[0] - first[0]) * 10))
                w.zig(round((cg[1] - first[1]) * 10))
            for v in b['roof']:
                w.u8(v)
            for v in b['wall']:
                w.u8(v)
            w.ring(ring)
    # canopy grid in game XZ: sample the 1 m nDSM through the inverse map
    fp = Polygon(to_g(M['footprint'][:-1]))
    x0, z0, x1, z1 = fp.bounds
    x0, z0 = math.floor(x0 / CELL) * CELL, math.floor(z0 / CELL) * CELL
    nx, nz = math.ceil((x1 - x0) / CELL), math.ceil((z1 - z0) / CELL)
    bld = np.zeros(nd.shape, bool)
    for b in M['buildings']:
        bld |= ring_mask(nd.shape, b['ring'])
    fpm = ring_mask(nd.shape, M['footprint'])
    can = (nd > 2.5) & ~bld & fpm & (dem > -0.9)
    inv = np.linalg.inv(np.vstack([T, [0, 0, 1]]))[:2]
    sub = np.arange(CELL) + 0.5
    gx = x0 + (np.arange(nx)[:, None] * CELL + sub[None]).ravel()  # nx*CELL
    gz = z0 + (np.arange(nz)[:, None] * CELL + sub[None]).ravel()
    GX, GZ = np.meshgrid(gx, gz)
    sx = inv[0, 0] * GX + inv[0, 1] * GZ + inv[0, 2]
    sz = inv[1, 0] * GX + inv[1, 1] * GZ + inv[1, 2]
    H, Wd = nd.shape
    ix, iz = np.clip(sx.astype(int), 0, Wd - 1), np.clip(sz.astype(int), 0, H - 1)
    c = can[iz, ix].reshape(nz, CELL, nx, CELL)
    h = np.where(can[iz, ix], nd[iz, ix], np.nan).reshape(nz, CELL, nx, CELL).transpose(0, 2, 1, 3).reshape(nz, nx, -1)
    cover = np.round(c.mean((1, 3)) * 15).astype(int)
    with np.errstate(all='ignore'):
        import warnings
        warnings.simplefilter('ignore')
        p75 = np.nan_to_num(np.nanpercentile(h, 75, axis=2))
    height = np.where(cover > 0, np.clip(np.round(p75 * 2), 0, 255), 0).astype(int)
    w.f32(x0)
    w.f32(z0)
    w.u8(CELL)
    w.u16(nx)
    w.u16(nz)
    w.b += bytes(cover.ravel().astype(np.uint8))
    w.b += bytes(height.ravel().astype(np.uint8))
    # boats and pontoons
    boats = M.get('boats', [])
    w.varint(len(boats))
    for x, z, hd, L, Bm, deck, cab, mast, r, g, bb in boats:
        p = to_g([[x, z]])[0]
        d = lin @ np.array([math.cos(hd), math.sin(hd)])
        w.vertex(*p)
        w.u8((math.atan2(d[1], d[0]) % (2 * math.pi)) / (2 * math.pi) * 256 % 256)
        w.u8(L / 0.2)
        w.u8(Bm * 10)
        w.u8(deck * 10)
        w.u8(cab * 10)
        w.u8(mast / 0.2)
        for v in (r, g, bb):
            w.u8(v)
    pons = M.get('pontoons', [])
    w.varint(len(pons))
    for p in pons:
        w.ring(to_g(p['ring'][:-1]))
    return {'name': M['name'], 'buildings': len(groups), 'parts': sum(len(v) for v in groups.values()), 'roofs': kinds,
            'canopy_cells': int((cover > 0).sum()), 'boats': len(boats), 'pontoons': len(pons)}


class R:
    """Walks an existing file area by area (the decoder's order), to keep areas' bytes and the running vertex."""

    def __init__(self, b):
        self.b, self.o, self.px, self.pz = b, 16, 0, 0

    def u8(self):
        self.o += 1
        return self.b[self.o - 1]

    def varint(self):
        v, mul = 0, 1
        while True:
            c = self.u8()
            v += (c & 127) * mul
            if c < 128:
                return v
            mul *= 128

    def zig(self):
        z = self.varint()
        return -(z + 1) // 2 if z % 2 else z // 2

    def vertex(self):
        self.px += self.zig()
        self.pz += self.zig()

    def ring(self):
        for _ in range(self.varint()):
            self.vertex()

    def area(self):
        """Skip one area: (name, start, end, vertex before, vertex after)."""
        o0, v0 = self.o, (self.px, self.pz)
        n = self.u8()
        name = self.b[self.o:self.o + n].decode()
        self.o += n
        self.ring()
        for _ in range(self.varint()):
            for _ in range(self.varint()):
                kind = self.u8()
                self.varint()
                if kind:
                    self.o += 3
                    self.varint(), self.varint(), self.zig(), self.zig()
                self.o += 6
                self.ring()
        self.o += 9
        nx, nz = struct.unpack_from('<HH', self.b, self.o)
        self.o += 4 + 2 * nx * nz
        for _ in range(self.varint()):
            self.vertex()
            self.o += 9
        for _ in range(self.varint()):
            self.ring()
        return name, o0, self.o, v0, (self.px, self.pz)


def kept_areas(skip):
    """The areas of the current file not named in `skip`, as raw bytes with their vertex deltas re-based: the first
    vertex of each kept area is written against whatever comes before it in the new file."""
    raw = gzip.decompress(open(OUT, 'rb').read())
    assert raw[:4] == b'AKLN' and struct.unpack_from('<I', raw, 4)[0] == 1 and struct.unpack_from('<f', raw, 8)[0] == Q
    r = R(raw)
    return [a for a in (r.area() for _ in range(struct.unpack_from('<I', raw, 12)[0])) if a[0] not in skip], raw


def copy_area(w, raw, area):
    """Append a kept area. Only its footprint's first vertex is relative to the area before it: rewrite that one."""
    name, o0, o1, v0, v1 = area
    r = R(raw)
    r.px, r.pz = v0
    r.o = o0 + 1 + raw[o0]  # past the name
    n = r.varint()
    start = r.o
    r.vertex()
    first = (r.px, r.pz)
    w.b += raw[o0:start]
    w.zig(first[0] - w.px)
    w.zig(first[1] - w.pz)
    w.b += raw[r.o:o1]
    w.px, w.pz = v1
    assert n > 2


def main():
    args = sys.argv[1:]
    keep = args[:1] == ['--keep']
    sites = args[1:] if keep else args
    names = {json.load(open(os.path.join(s, 'model.json')))['name'] for s in sites}
    old, raw = kept_areas(names) if keep else ([], b'')
    w = W()
    w.b += b'AKLN'
    w.u32(1)
    w.f32(Q)
    w.u32(len(old) + len(sites))
    for a in old:
        copy_area(w, raw, a)
        print(json.dumps({'name': a[0], 'kept': f'{a[2] - a[1]} bytes'}))
    stats = [bake_area(w, s) for s in sites]
    raw = bytes(w.b)
    gz = gzip.compress(raw, 9, mtime=0)
    open(OUT, 'wb').write(gz)
    for s in stats:
        print(json.dumps(s))
    print(f'wrote {os.path.normpath(OUT)}: {len(raw)} bytes raw, {len(gz)} bytes gzip')


if __name__ == '__main__':
    main()
