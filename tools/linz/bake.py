"""
Bake LINZ elevation into compact game data for the Auckland theatre.

Inputs (from fetch.py, NZTM2000 / EPSG:2193 mosaics at 16 m):
  dem1m_16.npz  national 1 m LiDAR DEM, read at its 16 m overview  -> land heights
  dem8m_16.npz  national contour 8 m DEM at 16 m                     -> land/sea mask (MHW coast)
Output: src/world/terrain/data/auckland-linz.bin (gzip; decoded by src/world/terrain/theaters/aucklandLinz.ts)
  - coastline rings in game metres (even-odd: land = inside an odd number of rings)
  - 1024² height grid sampled at the exact Heightfield sample positions (all quality tiers; the
    2048 tier upsamples it — a real 2048 grid would add ~1.5 MB to every page load)
Game coordinates: origin = Sky Tower, +X east, +Z south, equirectangular (src/core/auckland.ts).
"""
import gzip, sys, numpy as np
from pyproj import Transformer
from scipy.ndimage import map_coordinates, gaussian_filter, binary_fill_holes, label
from skimage.measure import find_contours
from shapely.geometry import Polygon

D = sys.argv[1] if len(sys.argv) > 1 else '.'
OUT = sys.argv[2] if len(sys.argv) > 2 else '../../src/world/terrain/data/auckland-linz.bin'
O_LAT, O_LON = -36.8485, 174.7622
M_LAT = 110_950.0
M_LON = 111_320.0 * np.cos(np.radians(O_LAT))
HF_EXTENT = 88_000.0
COAST_HALF = 45_000.0   # rings cover ±45 km (world ±44 km + margin)
COAST_CELL = 16.0
SIMPLIFY = 5.0          # m (Douglas-Peucker); source is 16 m data, Topo50 coast ≈ ±10-20 m
MIN_AREA = 6_000.0      # m²: drop islets/ponds smaller than this
Q = 2.0                 # ring vertex quantum (m)

tr = Transformer.from_crs(4326, 2193, always_xy=True)
def load(n):
    d = np.load(f'{D}/{n}.npz')
    return d['h'], float(d['x0']), float(d['y1']), float(d['res'])
h1, X0, Y1, R = load('dem1m_16')
h8, X0b, Y1b, Rb = load('dem8m_16')
assert (X0, Y1, R) == (X0b, Y1b, Rb) and h1.shape == h8.shape

def to_px(x, z):
    """Game metres -> fractional (row, col) in the NZTM mosaics."""
    E, N = tr.transform(O_LON + x / M_LON, O_LAT - z / M_LAT)
    return (Y1 - N) / R - 0.5, (E - X0) / R - 0.5

def sample(img, x, z, order=1):
    out = np.empty(x.shape, np.float32)
    fx, fz = x.ravel(), z.ravel()
    o = out.ravel()
    for s in range(0, fx.size, 2_000_000):
        r, c = to_px(fx[s:s + 2_000_000], fz[s:s + 2_000_000])
        o[s:s + 2_000_000] = map_coordinates(img, [r, c], order=order, mode='nearest')
    return out

# ── Land mask: MHW coastline of the contour DEM (nodata = sea); interior nodata holes filled ──
land = ~np.isnan(h8)
lab, nl = label(~land)
# sea = nodata components touching the mosaic border; others (tiny holes) become land
border = np.unique(np.concatenate([lab[0], lab[-1], lab[:, 0], lab[:, -1]]))
sea = np.isin(lab, border[border > 0])
land = ~sea
landf = gaussian_filter(land.astype(np.float32), 0.7)

# ── Heights: LiDAR where present, contour DEM elsewhere; sea = 0 ──
h = np.where(np.isnan(h1), h8, h1)
h = np.where(land, np.nan_to_num(h, nan=0.0), 0.0).astype(np.float32)
h = np.maximum(h, 0.0)

# ── Coastline rings on a 16 m game grid ──
n = int(round(2 * COAST_HALF / COAST_CELL)) + 1
g = -COAST_HALF + np.arange(n) * COAST_CELL
gx, gz = np.meshgrid(g, g)
m = sample(landf, gx, gz)
m[0, :] = m[-1, :] = m[:, 0] = m[:, -1] = 0.0   # close every ring inside the grid
rings = []
for cpts in find_contours(m, 0.5):
    pts = np.stack([-COAST_HALF + cpts[:, 1] * COAST_CELL, -COAST_HALF + cpts[:, 0] * COAST_CELL], 1)
    poly = Polygon(pts)
    if abs(poly.area) < MIN_AREA:
        continue
    s = np.asarray(poly.exterior.simplify(SIMPLIFY, preserve_topology=True).coords)[:-1]
    if len(s) < 3:
        continue
    q = np.round(s / Q).astype(np.int32)
    q = q[np.any(np.diff(np.vstack([q, q[:1]]), axis=0) != 0, axis=1)]  # drop repeats
    if len(q) >= 3:
        rings.append(q)
nv = sum(len(r) for r in rings)
print('rings', len(rings), 'vertices', nv)

HQ = 0.5  # height quantum (m)

def encode_heights(v):
    """0.5 m steps, planar predictor (left + up − upleft), zig-zag residuals (byte; 255 + u16 escape)."""
    q = np.round(v / HQ).astype(np.int32)
    p = np.zeros_like(q)
    p[1:, 1:] = q[1:, :-1] + q[:-1, 1:] - q[:-1, :-1]
    p[0, 1:] = q[0, :-1]
    p[1:, 0] = q[:-1, 0]
    r = q - p
    z = np.where(r >= 0, 2 * r, -2 * r - 1)
    # one byte per sample; 255 escapes a u16 (cliffs)
    z = z.ravel()
    assert z.max() < 65536
    out = bytearray()
    esc = np.flatnonzero(z >= 255)
    prev = 0
    for e in esc:
        out += z[prev:e].astype(np.uint8).tobytes() + bytes([255]) + int(z[e]).to_bytes(2, 'little')
        prev = e + 1
    out += z[prev:].astype(np.uint8).tobytes()
    print('height escapes', len(esc))
    return np.frombuffer(bytes(out), np.uint8)

# ── Height grids at Heightfield sample positions (origin −extent/2, cell extent/n) ──
grids = {}
for N in (1024,):
    cell = HF_EXTENT / N
    pos = -HF_EXTENT / 2 + np.arange(N) * cell
    hx, hz = np.meshgrid(pos, pos)
    sm = gaussian_filter(h, 0.25 * cell / R)   # light anti-alias: keeps cone summits (≈ −2…12 m vs LiDAR)
    v = sample(sm, hx, hz)
    v[sample(landf, hx, hz) < 0.02] = 0.0      # well offshore: no data
    grids[N] = encode_heights(v)
    print(N, 'max', v.max(), 'gz', len(gzip.compress(grids[N].tobytes(), 9)))

# ── Pack: one gzip-compressed binary, fetched once by the game (Vite-hashed asset) ──
#   'AKLZ' | u32 version | f32 coast quantum | f32 height quantum | u32 rings | u32 vertices
#   | u32 grid n | f32 grid extent | u32[rings] ring sizes | i16[2·vertices] x,z | residual bytes
import struct
ring_hdr = np.array([len(r) for r in rings], '<u4')
ring_xy = np.concatenate(rings)
assert np.abs(ring_xy).max() < 32767
N = 1024
body = (b'AKLZ' + struct.pack('<IffIIIf', 1, Q, HQ, len(rings), nv, N, HF_EXTENT)
        + ring_hdr.tobytes() + ring_xy.astype('<i2').tobytes() + grids[N].tobytes())
data = gzip.compress(body, 9, mtime=0)
open(OUT, 'wb').write(data)
print('wrote', OUT, len(body), 'bytes raw,', len(data), 'gzip')
