"""
Bake LINZ elevation into compact game data for the Auckland theatre.

Inputs (from fetch.py, NZTM2000 / EPSG:2193 mosaics at 16 m):
  dem1m_16.npz  national 1 m LiDAR DEM, read at its 16 m overview  -> land heights
  dem8m_16.npz  national contour 8 m DEM at 16 m                     -> land/sea mask (MHW coast)
and (from landcover.py):
  veg-50306.json / veg-50267.json / veg-50339.json   Topo50 native / exotic / scrub polygons -> land cover
  niwa250.tif   NIWA 250 m bathymetry (+ the LiDAR DEM's intertidal flats)                   -> water depth
Outputs (gzip):
  src/world/terrain/data/auckland-linz.bin     (decoded by src/world/terrain/theaters/aucklandLinz.ts, every tier)
    - coastline rings in game metres (even-odd: land = inside an odd number of rings)
    - 1024² height grid sampled at the exact Heightfield sample positions
    - 512² land cover (class + tree cover) and water depth grids at the 1024 grid's even samples (version 2)
  src/world/terrain/data/auckland-linz-hd.bin  (decoded by src/world/terrain/theaters/aucklandLinzHd.ts, high tier only)
    - 2048² detail: the real 2048 grid minus the Catmull-Rom upsample of the 1024 grid (what generate.ts's
      upsample2x reconstructs), so the high tier gets the real 43 m terrain instead of procedural noise
Game coordinates: origin = Sky Tower, +X east, +Z south, equirectangular (src/core/auckland.ts).
"""
import gzip, json, sys, numpy as np
import rasterio
from rasterio.features import rasterize
from rasterio.transform import from_origin
from pyproj import Transformer
from scipy.ndimage import map_coordinates, gaussian_filter, binary_fill_holes, label, maximum_filter, uniform_filter, distance_transform_edt
from skimage.measure import find_contours
from shapely.geometry import Polygon

D = sys.argv[1] if len(sys.argv) > 1 else '.'
OUT = sys.argv[2] if len(sys.argv) > 2 else '../../src/world/terrain/data/auckland-linz.bin'
OUT_HD = sys.argv[3] if len(sys.argv) > 3 else '../../src/world/terrain/data/auckland-linz-hd.bin'
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

# ── Land cover and bathymetry on a 512² grid (the 1024 grid's even samples; the game interpolates) ──
# 172 m cells keep both under ≈ 90 kB gzip (1024² would cost ≈ 105 + 130 kB): the NIWA grid is 250 m anyway,
# and interpolated tree cover still puts a forest edge within a fraction of a cell.
N = 1024
NA = 512
cell = HF_EXTENT / NA
pos = -HF_EXTENT / 2 + np.arange(NA) * cell
hx, hz = np.meshgrid(pos, pos)
water = sample(landf, hx, hz) < 0.5             # the coastline's side of every sample (rings = landf 0.5 contour)
box = int(round(cell / R)) | 1                  # 11 mosaic cells ≈ one 172 m grid cell

def sstep(a, b, x):
    t = np.clip((x - a) / (b - a), 0, 1)
    return t * t * (3 - 2 * t)

# Land cover: the share of each cell covered by the Topo50 polygons of each class (rasterised on the 16 m NZTM
# mosaic grid, box-averaged over one cell). Byte = class << 3 | total cover in 0..7, class = the largest share.
VEG = (50306, 50267, 50339)                     # class 1 native bush, 2 exotic forest (pines), 3 scrub
T16 = from_origin(X0, Y1, R, R)
cov = []
for layer in VEG:
    feats = json.load(open(f'{D}/veg-{layer}.json'))['features']
    m = rasterize(((f['geometry'], 1) for f in feats if f['geometry']), out_shape=h1.shape, transform=T16, dtype='uint8')
    cov.append(sample(uniform_filter(m.astype(np.float32), box), hx, hz))
    print('cover', layer, len(feats), 'polygons', round(float((cov[-1] > 0.5).mean()) * 100, 2), '% of the grid')
cov = np.stack(cov)
cq = np.round(np.minimum(cov.sum(0), 1) * 7).astype(np.uint8)
cover = np.where((cq > 0) & ~water, ((np.argmax(cov, 0) + 1) << 3) | cq, 0).astype(np.uint8)

# Bathymetry, game datum (y = 0 is the coastline's mean high water): the NIWA 250 m grid (charts + surveys,
# metres re. mean sea level, drying flats > 0) blended with the LiDAR DEM where it measured the intertidal
# flats (its offshore fill, flat blocks of one value per survey, is ignored). MHW ≈ 1.5 m above NZVD2016
# (≈ MSL) in the Waitematā / Manukau: the median LiDAR ground along the coastline is 1.6 m.
MHW = 1.5
SQ = 0.1                                        # quantum of √depth: ±0.1 m at 1 m, ±0.5 m at 25 m
with rasterio.open(f'{D}/niwa250.tif') as src:
    niwa_img, nt = src.read(1).astype(np.float32), src.transform
assert niwa_img.min() > -11000, 'NIWA nodata inside the world box'
t3851 = Transformer.from_crs(4326, 3851, always_xy=True)
E3, N3 = t3851.transform(O_LON + hx / M_LON, O_LAT - hz / M_LAT)
niwa = map_coordinates(niwa_img, [(N3 - nt.f) / nt.e - 0.5, (E3 - nt.c) / nt.a - 0.5], order=1, mode='nearest')
a = np.nan_to_num(h1).astype(np.float64)
mean = uniform_filter(a, 3)
flat = (uniform_filter(a * a, 3) - mean * mean < 1e-6) | (uniform_filter(np.isnan(h1).astype(np.float32), 3) > 0)
flats = ~land & ~np.isnan(h1) & ~flat           # measured seabed below the MHW coastline
wf = sample(uniform_filter(flats.astype(np.float32), box), hx, hz)
lid = sample(uniform_filter(np.where(flats, a, 0).astype(np.float32), box), hx, hz) / np.maximum(wf, 1e-6)
w_lid = sstep(0.25, 0.6, wf)
depth = np.maximum(MHW - (niwa + (lid - niwa) * w_lid), 0.3)
# land samples within 2 cells of the water take the nearest water depth (bilinear lookups along the shore)
dist, (ii, jj) = distance_transform_edt(~water, return_indices=True)
depth = np.where(water, depth, np.where(dist <= 2, depth[ii, jj], 0.0))
print('depth: water samples', int(water.sum()), 'lidar flats', int((water & (w_lid > 0.5)).sum()),
      'pct', np.percentile(depth[water], [1, 25, 50, 75, 99]).round(1))
cover_bytes = cover.tobytes()
depth_bytes = encode_heights(np.sqrt(depth) * (HQ / SQ)).tobytes()   # encode_heights quantises by HQ
print('cover gz', len(gzip.compress(cover_bytes, 9)), 'depth gz', len(gzip.compress(depth_bytes, 9)))

# ── Pack: one gzip-compressed binary, fetched once by the game (Vite-hashed asset) ──
#   'AKLZ' | u32 version (2) | f32 coast quantum | f32 height quantum | u32 rings | u32 vertices
#   | u32 grid n | f32 grid extent | u32[rings] ring sizes | i16[2·vertices] x,z | height residual bytes
#   | u32 aux grid n | u8[aux n²] land cover (class << 3 | cover 0..7) | f32 √depth quantum
#   | √depth residual bytes (same coder; depth > 0 below the waterline, 0 inland)
import struct
ring_hdr = np.array([len(r) for r in rings], '<u4')
ring_xy = np.concatenate(rings)
assert np.abs(ring_xy).max() < 32767
body = (b'AKLZ' + struct.pack('<IffIIIf', 2, Q, HQ, len(rings), nv, N, HF_EXTENT)
        + ring_hdr.tobytes() + ring_xy.astype('<i2').tobytes() + grids[N].tobytes()
        + struct.pack('<I', NA) + cover_bytes + struct.pack('<f', SQ) + depth_bytes)
data = gzip.compress(body, 9, mtime=0)
open(OUT, 'wb').write(data)
print('wrote', OUT, len(body), 'bytes raw,', len(data), 'gzip')

# ── HD detail (high quality tier): real 2048² grid as a residual over the upsampled 1024² grid ──
# Same σ = 0.25-cell pre-filter as the 1024 grid; at the grid's local maxima the sample takes the source
# maximum within one cell, so narrow summits (Browns Island, Māngere) that fall between 43 m samples
# keep their LiDAR height (all cones within ≈ ±1 %, vs −8 % with plain sampling).
def cr_upsample(b):
    """2× Catmull-Rom upsample, exactly as upsample2x in src/world/terrain/generate.ts (clamped edges)."""
    n = b.shape[0]
    i = np.arange(n)
    def up1(a):
        c = lambda k: a[:, np.clip(k, 0, n - 1)]
        o = np.empty((a.shape[0], 2 * n))
        o[:, 0::2] = a
        o[:, 1::2] = (-c(i - 1) + 9 * c(i) + 9 * c(i + 1) - c(i + 2)) * 0.0625
        return o
    return up1(up1(b.astype(np.float64)).T).T

def zigzag_bytes(r):
    """Zig-zag residuals, one byte each; 255 escapes a u16."""
    z = np.where(r >= 0, 2 * r, -2 * r - 1).ravel()
    assert z.max() < 65536
    out = bytearray()
    prev = 0
    for e in np.flatnonzero(z >= 255):
        out += z[prev:e].astype(np.uint8).tobytes() + bytes([255]) + int(z[e]).to_bytes(2, 'little')
        prev = e + 1
    out += z[prev:].astype(np.uint8).tobytes()
    return bytes(out)

def fnv1a(b):
    """FNV-1a 32 of a byte string (ties the HD file to the 1024 grid it was baked against)."""
    hsh = 0x811C9DC5
    for x in np.frombuffer(b, np.uint8).tolist():
        hsh = ((hsh ^ x) * 0x01000193) & 0xFFFFFFFF
    return hsh

NH = 2048
cell = HF_EXTENT / NH
pos = -HF_EXTENT / 2 + np.arange(NH) * cell
hx, hz = np.meshgrid(pos, pos)
v = sample(gaussian_filter(h, 0.25 * cell / R), hx, hz)
v[sample(landf, hx, hz) < 0.02] = 0.0
peak = (v == maximum_filter(v, size=3)) & (v > 5)
vmax = sample(maximum_filter(h, size=int(np.ceil(cell / R)) | 1), hx, hz)
v = np.where(peak, np.maximum(v, vmax), v)
# the 1024 grid as the game decodes it (0.5 m steps)
cell1 = HF_EXTENT / N
pos1 = -HF_EXTENT / 2 + np.arange(N) * cell1
hx1, hz1 = np.meshgrid(pos1, pos1)
v1 = sample(gaussian_filter(h, 0.25 * cell1 / R), hx1, hz1)
v1[sample(landf, hx1, hz1) < 0.02] = 0.0
q1 = np.round(v1 / HQ).astype(np.int32)
res = np.round((v - cr_upsample(q1 * HQ)) / HQ).astype(np.int32)
print('hd residual max', np.abs(res).max(), 'peaks snapped', int(peak.sum()))
#   'AKLH' | u32 version | f32 height quantum | u32 grid n | f32 grid extent | u32 base n
#   | u32 FNV-1a of the base grid's quantised heights (i32 LE) | residual bytes
body = (b'AKLH' + struct.pack('<IfIfII', 1, HQ, NH, HF_EXTENT, N, fnv1a(q1.astype('<i4').tobytes()))
        + zigzag_bytes(res))
data = gzip.compress(body, 9, mtime=0)
open(OUT_HD, 'wb').write(data)
print('wrote', OUT_HD, len(body), 'bytes raw,', len(data), 'gzip')
