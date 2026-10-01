"""
Bake LINZ elevation into compact game data for the Auckland theatre.

Inputs (from fetch.py, NZTM2000 / EPSG:2193 mosaics at 16 m):
  dem1m_16.npz  national 1 m LiDAR DEM, read at its 16 m overview  -> land heights
  dem8m_16.npz  national contour 8 m DEM at 16 m                     -> land/sea mask (MHW coast)
and (from landcover.py):
  veg-50306.json / veg-50267.json / veg-50339.json   Topo50 native / exotic / scrub polygons -> land cover
  depare-*.json ENC depth area polygons (Hydro) at four chart scales                            -> water depth
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
# 172 m cells keep both under ≈ 90 kB gzip (1024² would cost ≈ 105 + 130 kB): the charts are drawn for 1:22k+,
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

# Bathymetry, game datum (y = 0 is the coastline's mean high water), from the ENC depth areas: each polygon is a
# depth band [drval1, drval2] below chart datum (≈ lowest tide; drval1 < 0 = a drying flat's height above it).
# On a 32 m grid the finest chart scale available wins; inside a band the depth runs from drval1 at the edge
# shared with shallower water (or the shore) to drval2 at the edge shared with deeper water, in proportion to the
# distances to the two. Chart datum lies a tide range below MHW: the highest drying height near each point
# (≈ MHWS: 4.2 m in the Manukau, 3.1-3.3 m in the Waitematā) less 0.3 m.
SQ = 0.1                                        # quantum of √depth: ±0.1 m at 1 m, ±0.5 m at 25 m
DR = 2 * R                                      # depth raster cell (32 m), aligned with the mosaics
dshape = ((h1.shape[0] + 1) // 2, (h1.shape[1] + 1) // 2)
T32 = from_origin(X0, Y1, DR, DR)
d1 = np.full(dshape, np.nan, np.float32)
d2 = np.full(dshape, np.nan, np.float32)
for layer in (50852, 50447, 50553, 50671):      # coarse to fine: finer charts paint over coarser ones
    feats = [f for f in json.load(open(f'{D}/depare-{layer}.json'))['features'] if f['geometry'] and f['properties']['drval2'] is not None]
    for k, arr in (('drval1', d1), ('drval2', d2)):
        v = rasterize(((f['geometry'], float(f['properties'][k])) for f in feats), out_shape=dshape, transform=T32, fill=np.nan, dtype='float32')
        arr[~np.isnan(v)] = v[~np.isnan(v)]
land32 = land[::2, ::2][:dshape[0], :dshape[1]]
charted = ~np.isnan(d1) & ~land32
cd = np.full(dshape, np.nan, np.float32)
for lv in np.unique(d1[charted]):
    m = charted & (d1 == lv)
    shallower = land32 | (charted & (d1 < lv))
    deeper = charted & (d1 > lv)
    ds = distance_transform_edt(~shallower) * DR
    dd = distance_transform_edt(~deeper) * DR if deeper.any() else np.full(dshape, np.inf)
    t = np.where(np.isfinite(dd), ds / np.maximum(ds + dd, 1e-6), np.minimum(1, ds / 1500))
    cd[m] = (d1 + (d2 - d1) * t)[m]
# chart datum -> MHW: the nearest drying flat's height limit
dry = charted & (d1 < 0)
_, (di, dj) = distance_transform_edt(~dry, return_indices=True)
mhw_cd = -d1[di, dj] - 0.3
sea32 = ~land32
_, (ci, cj) = distance_transform_edt(~charted, return_indices=True)
depth32 = np.where(charted, cd, cd[ci, cj]) + mhw_cd   # uncharted water (creeks): the nearest charted depth
depth32 = np.where(sea32, np.maximum(depth32, 0.3), 0).astype(np.float32)
print('charted', round(float(charted.sum() / sea32.sum()) * 100, 1), '% of the water; MHW above CD',
      np.percentile(mhw_cd[sea32], [5, 50, 95]).round(2))

def sample32(img, x, z):
    E, Nn = tr.transform(O_LON + x / M_LON, O_LAT - z / M_LAT)
    return map_coordinates(img, [(Y1 - Nn) / DR - 0.5, (E - X0) / DR - 0.5], order=1, mode='nearest')

wsum = sample32(uniform_filter(sea32.astype(np.float32), 5), hx, hz)
depth = sample32(uniform_filter(depth32, 5), hx, hz) / np.maximum(wsum, 1e-6)   # mean over the water in a cell
# land samples within 2 cells of the water take the nearest water depth (bilinear lookups along the shore)
dist, (ii, jj) = distance_transform_edt(~water, return_indices=True)
depth = np.where(water, np.maximum(depth, 0.3), np.where(dist <= 2, np.maximum(depth[ii, jj], 0.3), 0.0))
print('depth: water samples', int(water.sum()), 'pct', np.percentile(depth[water], [1, 25, 50, 75, 99]).round(1))
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
