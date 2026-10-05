"""
#140: register the aerial photo on the CBD buildings' roofs (one offset per building).

    npx vite-node tools/linz/roofs.ts dump <work>    # → <work>/roofs-in.json
    python3 tools/linz/roofs.py <work> [--check] [--spot]   # → <work>/roofs.json (+ roofs-report.json, roofs-rows.json, roofs-field.png)
    npx vite-node tools/linz/roofs.ts bake <work>    # → src/world/terrain/data/auckland-buildings.bin

The LINZ 2024 aerial is a standard orthophoto (rectified to the ground, not a true ortho): a roof h m up is drawn
displaced from its footprint by h x (its offset from the camera's nadir) / (flying height), and the mosaic switches
from frame to frame, so the lean changes across the city. The game's photo (auckland-aerial-{2048,4096}.webp, baked by
aerial.py from the same tiles) carries the same displacement, so an offset measured on the source applies to it.

Measured on the source, not on the game's 1.25 m / px photo, whose roof edges are too soft to tell a 3 m lean from a
neighbour's edge: the 1:1000 tiles' 1/4 overviews (0.3 m, s3://nz-imagery/auckland/auckland_2024_0.075m/rgb/2193/,
public, cached in <work>/tiles), mosaicked in NZTM.

1. Edges: the luminance gradient (Gaussian 0.3 m) as its structure tensor (gx^2, 2 gx gn, gn^2).
2. Template: each prism's outline (game XZ → NZTM) splatted along every edge with its outward normal n as
   (nx^2, nx nn, nn^2), one template per side (the quadrant the normal faces: east, south, west, north): its
   correlation is the mean of (n . grad)^2 along that side, the photo's edge strength across it.
3. Joint search: a building's prisms lean in proportion to their height (a tower on its podium), so a shift s (at the
   tallest roof) scores each prism's sides at s x h_p / h_top; the sides' log-ratios to their own median over the
   search are summed (each side at most 35 % of the weight), so a shift has to put an edge under every side of the
   roof, not slide one long side along a kerb. Search: 1 px lattice, |s| <= min(30 m, MAX_LEAN h_top + 1.5 m) (the
   issue's ~25 m on the tallest towers, ~180 m, is ~0.14 m per metre).
4. Quality: q, the peak's score (0.7 = the roof's sides sit on edges twice as strong as usual there), and u, its lead
   over the best score more than 3 m away (a neighbour, the building's own base, a shadow's edge).
5. Lean field: lean per metre L = s / h_top of the confident roofs (h_top >= 12 m, FIELD_*), estimated at every
   building as the Gaussian-weighted median of the neighbours (sigma 90 m, the building itself left out).
6. Decision per building:
   - registered: a clear peak (ACCEPT_*) that agrees with the field (|s - L h| <= 2.5 m + 0.15 |L h|), or the best
     peak within that distance of the field when it is nearly as strong as the best anywhere (NEAR_Q), or a peak clear
     enough on its own (SURE_*: a field built from frames next door can be wrong at a seam);
   - else a roof under LOW_ROOF (35 m) keeps the photo, at the field's prediction L x h (a few metres at most), or with
     no offset where no confident roof is near;
   - else no photo (today's plain roof; counted as a fallback).
   Buildings the game doesn't draw from the file (the tower kit, the Scene apartments, the hero neighbourhoods
   replace them) get none.
7. Offsets go back to game XZ through the local Jacobian of the game → NZTM map (the frames turn ~1 deg).

--check also writes roofs-check.png: the game's own 4096 photo round the ten tallest registered roofs, the footprint
in red and the registered roof outline in green, for a look by eye.

pip install numpy scipy rasterio pyproj pillow
"""
import concurrent.futures as cf
import json
import os
import sys

import numpy as np
import rasterio
from PIL import Image, ImageDraw
from pyproj import Transformer
from rasterio.enums import Resampling
from scipy.ndimage import gaussian_filter, map_coordinates
from scipy.signal import fftconvolve

os.environ['GDAL_DISABLE_READDIR_ON_OPEN'] = 'EMPTY_DIR'
HERE = os.path.dirname(os.path.abspath(__file__))
PHOTO = os.path.join(HERE, '../../src/world/terrain/data/auckland-aerial-4096.webp')
BASE = 'https://nz-imagery.s3.ap-southeast-2.amazonaws.com/auckland/auckland_2024_0.075m/rgb/2193'
# AERIAL_RECT (src/world/terrain/theaters/aucklandAerial.ts), AKL_ORIGIN and its metres per degree (src/core/auckland.ts)
X0, Z0, SIZE = -1536, -3072, 5120
O = (-36.8485, 174.7622)
MLAT = 110950
MLON = 111320 * np.cos(np.radians(O[0]))
# the 1:1000 tile grid: 480 m x 720 m, 50 x 50 to a 1:50k sheet (BA31 starts at E 1732000, N 5946000; BA32 east of it)
SHEETS = {'BA31': (1732000, 5946000), 'BA32': (1756000, 5946000)}
TW, TH = 480, 720
RES = 0.3            # m / px (the tiles' 1/4 overview)
OVR = 4

LOW_ROOF = 35.0      # m: under it a roof that fails the correlation still takes the photo
MAX_SHIFT = 30.0     # m
MAX_LEAN = 0.2       # m of offset per m of height, at most
FIELD_Q, FIELD_U = 1.2, 0.25    # a roof that builds the lean field
ACCEPT_Q, ACCEPT_U = 0.9, 0.12  # a registered roof that agrees with the field
SURE_Q, SURE_U = 1.3, 0.5       # a registered roof on its own
NEAR_Q = 0.15                   # the field's peak may be this much weaker than the best one
FIELD_SIGMA = 90.0   # m
MIN_FIELD_H = 12.0   # m

work = sys.argv[1]
CHECK = '--check' in sys.argv
SPOT = '--spot' in sys.argv
to_nztm = Transformer.from_crs(4326, 2193, always_xy=True)


def game_to_nztm(x, z):
    return to_nztm.transform(O[1] + np.asarray(x) / MLON, O[0] - np.asarray(z) / MLAT)


bs = json.load(open(os.path.join(work, 'roofs-in.json')))
drawn = [b for b in bs if b['drawn']]
for b in drawn:
    b['top'] = max(p['h'] for p in b['prisms'])
    for p in b['prisms']:
        E, Nn = game_to_nztm(p['ring'][0::2], p['ring'][1::2])
        p['en'] = np.stack([E, Nn], 1)

# ── the source mosaic (luminance, uint8) over every drawn building + the search margin ──
allen = np.concatenate([p['en'] for b in drawn for p in b['prisms']])
# (on the tiles' own grid, which starts at the sheets' corner, not at a multiple of the tile size)
GE, GN = SHEETS['BA31']
e0 = GE + np.floor((allen[:, 0].min() - 80 - GE) / TW) * TW
e1 = GE + np.ceil((allen[:, 0].max() + 80 - GE) / TW) * TW
n0 = GN + np.floor((allen[:, 1].min() - 80 - GN) / TH) * TH
n1 = GN + np.ceil((allen[:, 1].max() + 80 - GN) / TH) * TH
W, H = int(round((e1 - e0) / RES)), int(round((n1 - n0) / RES))
tiles_dir = os.path.join(work, 'tiles')
os.makedirs(tiles_dir, exist_ok=True)


def tile_name(e, n):
    for sheet, (se, sn) in SHEETS.items():
        if se <= e < se + 50 * TW and sn - 50 * TH < n <= sn:
            return f'{sheet}_1000_{int((sn - n) // TH) + 1:02d}{int((e - se) // TW) + 1:02d}'
    return None


def fetch(key):
    e, n = key
    name = tile_name(e + 1, n - 1)
    path = os.path.join(tiles_dir, f'{name}.npy')
    if not os.path.exists(path):
        with rasterio.open(f'/vsicurl/{BASE}/{name}.tiff') as s:
            h, w = s.height // OVR, s.width // OVR
            a = s.read([1, 2, 3], out_shape=(3, h, w), resampling=Resampling.average).astype(np.float32)
        lum = np.round(a[0] * 0.2126 + a[1] * 0.7152 + a[2] * 0.0722).astype(np.uint8)
        np.save(path, lum)
    return e, n, np.load(path)


keys = [(e, n) for e in np.arange(e0, e1, TW) for n in np.arange(n0 + TH, n1 + 1e-6, TH)]
mos = np.zeros((H, W), np.uint8)
with cf.ThreadPoolExecutor(8) as ex:
    for e, n, lum in ex.map(fetch, keys):
        c0, r0 = int(round((e - e0) / RES)), int(round((n1 - n) / RES))
        mos[r0:r0 + lum.shape[0], c0:c0 + lum.shape[1]] = lum
print(f'source mosaic {W} x {H} px at {RES} m from {len(keys)} tiles', flush=True)


def to_px(E, Nn):
    return (np.asarray(E) - e0) / RES - 0.5, (n1 - np.asarray(Nn)) / RES - 0.5


def splat(en, ox, oy, w, h):
    """Templates (4 sides, 3, h, w) of one outline (NZTM, any winding) on the window whose pixel (0, 0) is mosaic pixel
    (ox, oy): its edges by the quadrant their outward normal faces (east, south, west, north), and each side's length."""
    t = np.zeros((4, 3, h, w), np.float32)
    lens = np.zeros(4)
    # in mosaic pixels (x east, y south): counter-clockwise on the map = positive shoelace
    px, py = to_px(en[:, 0], en[:, 1])
    r = np.stack([px - ox, py - oy], 1)
    area = 0.5 * np.sum(r[:, 0] * np.roll(r[:, 1], -1) - np.roll(r[:, 0], -1) * r[:, 1])
    for a, b in zip(r, np.roll(r, -1, 0)):
        d = b - a
        L = np.hypot(*d)
        if L < 1.0:
            continue
        n = np.array([d[1], -d[0]]) / L * (1 if area > 0 else -1)
        side = int(np.round(np.arctan2(n[1], n[0]) / (np.pi / 2))) % 4
        lens[side] += L * RES
        k = max(2, int(L * 2))
        s = (np.arange(k) + 0.5) / k
        x = a[0] + d[0] * s
        y = a[1] + d[1] * s
        i0 = np.floor(x).astype(int)
        j0 = np.floor(y).astype(int)
        fx = x - i0
        fy = y - j0
        for di, dj, ww in ((0, 0, (1 - fx) * (1 - fy)), (1, 0, fx * (1 - fy)), (0, 1, (1 - fx) * fy), (1, 1, fx * fy)):
            ii = i0 + di
            jj = j0 + dj
            ok = (ii >= 0) & (ii < w) & (jj >= 0) & (jj < h)
            for c, v in enumerate((n[0] * n[0], n[0] * n[1], n[1] * n[1])):
                np.add.at(t[side, c], (jj[ok], ii[ok]), ww[ok] * v / 2)
    return t, lens


def measure(b):
    """Score map of the building's tallest-roof shift over the search (shifts in NZTM m, east / north); None off the mosaic."""
    top = b['top']
    lim_m = min(MAX_SHIFT, MAX_LEAN * top + 1.5)
    R = int(np.ceil(lim_m / RES)) + 1
    allp = np.concatenate([p['en'] for p in b['prisms']])
    px, py = to_px(allp[:, 0], allp[:, 1])
    ox, oy = int(np.floor(px.min())) - 2, int(np.floor(py.min())) - 2
    w, h = int(np.ceil(px.max())) - ox + 3, int(np.ceil(py.max())) - oy + 3
    if ox - R < 0 or oy - R < 0 or ox + w + R > W or oy + h + R > H:
        return None
    win = mos[oy - R:oy + h + R, ox - R:ox + w + R].astype(np.float32) / 255
    if (win == 0).mean() > 0.2:
        return None
    sm = gaussian_filter(win, 0.3 / RES)  # 0.3 m at any resolution
    gy, gx = np.gradient(sm)
    G = (gx * gx, 2 * gx * gy, gy * gy)
    g = np.arange(-R + 1, R)
    DX, DY = np.meshgrid(g, g)
    keep = np.hypot(DX, DY) * RES <= lim_m
    side = [np.zeros(DX.shape) for _ in range(4)]
    slen = np.zeros(4)
    for p in b['prisms']:
        k = p['h'] / top if top > 0 else 1.0
        t, lens = splat(p['en'], ox, oy, w, h)
        for q in range(4):
            if lens[q] < 2.0:
                continue
            # c[R + dy, R + dx] = mean edge strength across this side for a shift (dx, dy) px
            c = sum(fftconvolve(G[j], t[q, j][::-1, ::-1], mode='valid') for j in range(3)) / (t[q].sum() + 1e-9)
            side[q] += lens[q] * map_coordinates(c, [R + DY * k, R + DX * k], order=1, mode='nearest')
            slen[q] += lens[q]
    if (slen > 0).sum() < 2:
        return None
    wq = np.minimum(slen / slen.sum(), 0.35)
    wq /= wq.sum()
    S = np.zeros(DX.shape)
    for q in range(4):
        if slen[q] > 0:
            v = side[q] / slen[q]
            S += wq[q] * np.log(v / max(np.median(v[keep]), 1e-12) + 1e-3)
    S[~keep] = -np.inf
    return S, DX * RES, -DY * RES  # east, north (m)


def peak(S, DE, DN, centre=None, radius=None):
    T = S if centre is None else np.where(np.hypot(DE - centre[0], DN - centre[1]) <= radius, S, -np.inf)
    j, i = np.unravel_index(np.argmax(T), T.shape)
    if not np.isfinite(T[j, i]):
        return None
    away = np.isfinite(S) & (np.hypot(DE - DE[j, i], DN - DN[j, i]) > 3.0)
    second = S[away].max() if away.any() else S[np.isfinite(S)].min()
    return np.array([DE[j, i], DN[j, i]]), float(T[j, i]), float(T[j, i] - second)


def jac(x, z):
    """d(E, N) / d(x, z) of the game → NZTM map at (x, z)."""
    E0, N0 = game_to_nztm(x, z)
    Ex, Nx = game_to_nztm(x + 1, z)
    Ez, Nz = game_to_nztm(x, z + 1)
    return np.array([[Ex - E0, Ez - E0], [Nx - N0, Nz - N0]])


rows = []
for k, b in enumerate(drawn):
    r0 = b['prisms'][0]['ring']
    row = {'b': b, 'i': b['i'], 'h': b['top'], 'x': float(np.mean(r0[0::2])), 'z': float(np.mean(r0[1::2]))}
    row['J'] = jac(row['x'], row['z'])
    m = measure(b)
    row['map'] = m
    if m is not None:
        pk = peak(*m)
        if pk:
            # to game XZ
            row['s'] = np.linalg.solve(row['J'], pk[0])
            row['q'], row['u'] = pk[1], pk[2]
    rows.append(row)
    if k % 100 == 0:
        print(f'  {k} / {len(drawn)}', flush=True)
print(f'{len(rows)} drawn buildings, {sum("s" in r for r in rows)} measured', flush=True)

# ── lean field (m of offset per m of height, game XZ) from the confident roofs ──
F = [r for r in rows if 's' in r and r['h'] >= MIN_FIELD_H and r['q'] >= FIELD_Q and r['u'] >= FIELD_U]
FP = np.array([[r['x'], r['z']] for r in F])
FL = np.array([r['s'] / r['h'] for r in F])
print(f'lean field from {len(F)} roofs; |lean| per metre: median {np.median(np.hypot(*FL.T)):.3f}, p90 {np.percentile(np.hypot(*FL.T), 90):.3f}', flush=True)


def wmedian(v, w):
    o = np.argsort(v)
    c = np.cumsum(w[o])
    return v[o][np.searchsorted(c, c[-1] / 2)]


def field(x, z, skip=None):
    d2 = (FP[:, 0] - x) ** 2 + (FP[:, 1] - z) ** 2
    w = np.exp(-d2 / (2 * FIELD_SIGMA ** 2)) * (d2 < (2.5 * FIELD_SIGMA) ** 2)
    if skip is not None:
        w[skip] = 0
    if w.sum() < 0.6:
        return None
    return np.array([wmedian(FL[:, 0], w), wmedian(FL[:, 1], w)])


fidx = {id(r): k for k, r in enumerate(F)}
out = []
stats = {'registered': 0, 'registered_sure': 0, 'predicted_low': 0, 'unshifted_low': 0, 'fallback_tall': 0, 'fallback_off_source': 0}
resid = []
for r in rows:
    L = field(r['x'], r['z'], fidx.get(id(r)))
    pred = L * r['h'] if L is not None else None
    s, q, u = r.get('s'), r.get('q', 0.0), r.get('u', 0.0)
    # a low roof's search (|s| < 6 m) has no room for a second match 3 m away: its lead is not asked for
    small = MAX_LEAN * r['h'] + 1.5 < 6.0
    clear = q >= ACCEPT_Q and (small or u >= ACCEPT_U)
    kind = None
    if s is not None and pred is not None:
        tol = 2.5 + 0.15 * np.hypot(*pred)
        if clear and np.hypot(*(s - pred)) <= tol:
            kind = 'registered'
        elif not (q >= SURE_Q and u >= SURE_U):
            # the best match near the field's prediction, when it is about as good as the best one anywhere
            pk = peak(*r['map'], centre=r['J'] @ pred, radius=tol)
            if pk and pk[1] >= ACCEPT_Q and pk[1] >= q - NEAR_Q:
                s, q = np.linalg.solve(r['J'], pk[0]), pk[1]
                kind = 'registered'
    if kind is None and s is not None and q >= SURE_Q and (small or u >= SURE_U):
        kind = 'registered_sure'
    if kind is None and s is not None and pred is None and small and clear:
        kind = 'registered_sure'
    if kind:
        stats['registered' if kind == 'registered' else 'registered_sure'] += 1
        if pred is not None:
            resid.append(np.hypot(*(s - pred)))
        out.append({'i': r['i'], 'dx': round(float(s[0]), 2), 'dz': round(float(s[1]), 2), 'measured': True})
    elif r['h'] < LOW_ROOF:
        kind = 'predicted' if pred is not None else 'unshifted'
        s = pred if pred is not None else np.zeros(2)
        stats['predicted_low' if pred is not None else 'unshifted_low'] += 1
        out.append({'i': r['i'], 'dx': round(float(s[0]), 2), 'dz': round(float(s[1]), 2), 'measured': False})
    else:
        stats['fallback_tall' if r['map'] is not None else 'fallback_off_source'] += 1
        kind = 'fallback'
    r['kind'] = kind
    r['final'] = s if kind != 'fallback' else None
    r['pred'] = pred

json.dump(out, open(os.path.join(work, 'roofs.json'), 'w'))
lst = lambda v: None if v is None else [round(float(v[0]), 2), round(float(v[1]), 2)]
json.dump([{'i': r['i'], 'h': r['h'], 'x': r['x'], 'z': r['z'], 'q': r.get('q'), 'u': r.get('u'), 'kind': r['kind'], 'best': lst(r.get('s')),
            's': lst(r.get('final')), 'pred': lst(r.get('pred'))} for r in rows], open(os.path.join(work, 'roofs-rows.json'), 'w'))
tall = [r for r in rows if r['h'] >= LOW_ROOF]
mags = np.array([np.hypot(*r['final']) for r in rows if r['kind'] in ('registered', 'registered_sure')])
rep = {
    **stats,
    'drawn': len(rows),
    'photo_roofs': len(out),
    'tall': len(tall),
    'tall_registered': sum(r['kind'] in ('registered', 'registered_sure') for r in tall),
    'field_roofs': len(F),
    'registered_offset_m': {'median': float(np.median(mags)), 'p90': float(np.percentile(mags, 90)), 'max': float(mags.max())},
    'residual_vs_field_m': {'median': float(np.median(resid)), 'p90': float(np.percentile(resid, 90))} if resid else None,
    'lean_per_m_median': float(np.median(np.hypot(*FL.T))),
}
json.dump(rep, open(os.path.join(work, 'roofs-report.json'), 'w'), indent=1)
print(json.dumps(rep, indent=1))

# the lean field as a picture: one arrow per photo roof (x5), coloured by kind; fallbacks as red rings
S_ = 1400 / 2600
pic = Image.new('RGB', (1400, int(3300 * S_)), 'white')
dr = ImageDraw.Draw(pic)
for r in rows:
    x, z = (r['x'] + 1300) * S_, (r['z'] + 1900) * S_
    if r.get('final') is None:
        dr.ellipse([x - 3, z - 3, x + 3, z + 3], outline='red')
        continue
    dx, dz = r['final'] * 5 * S_
    dr.line([x, z, x + dx, z + dz], fill={'registered': 'green', 'registered_sure': 'blue', 'predicted': 'orange', 'unshifted': 'grey'}[r['kind']], width=2)
pic.save(os.path.join(work, 'roofs-field.png'))

if CHECK:
    # on the game's own photo (what the player sees), 1.25 m / px, x4
    img = np.asarray(Image.open(PHOTO).convert('RGB'))
    PX = SIZE / img.shape[0]
    reg = sorted([r for r in rows if r['kind'] in ('registered', 'registered_sure')], key=lambda r: -r['h'])[:10]
    tiles = []
    for r in reg:
        ci, cj = (r['x'] - X0) / PX - 0.5, (r['z'] - Z0) / PX - 0.5
        half = 40
        i0, j0 = int(ci) - half, int(cj) - half
        crop = Image.fromarray(img[j0:j0 + 2 * half, i0:i0 + 2 * half]).resize((320, 320), Image.Resampling.NEAREST)
        d = ImageDraw.Draw(crop)
        for p in r['b']['prisms']:
            k = p['h'] / r['h']
            pts = np.asarray(p['ring']).reshape(-1, 2)
            for col, off in (('red', (0, 0)), ('lime', r['final'] * k)):
                xs = [((x + off[0] - X0) / PX - i0) * 4 for x in pts[:, 0]]
                zs = [((z + off[1] - Z0) / PX - j0) * 4 for z in pts[:, 1]]
                d.line(list(zip(xs + xs[:1], zs + zs[:1])), fill=col, width=1)
        d.text((4, 4), f"#{r['i']} h {r['h']:.0f} m s ({r['final'][0]:+.1f}, {r['final'][1]:+.1f}) q {r.get('q', 0):.2f} u {r.get('u', 0):.2f}", fill='yellow')
        tiles.append(crop)
    sheet = Image.new('RGB', (320 * 5, 320 * 2))
    for k, t in enumerate(tiles):
        sheet.paste(t, ((k % 5) * 320, (k // 5) * 320))
    sheet.save(os.path.join(work, 'roofs-check.png'))

if SPOT:
    # an independent check of the ten tallest registered roofs: the same search at 0.15 m (the tiles' 1/2 overview,
    # read in a window round each building), its offset compared with the baked one; the result is the test fixture
    # tests/fixtures/linz-roof-spotchecks.json (tests/world-buildings.test.ts)
    def window(b, res):
        lim = min(MAX_SHIFT, MAX_LEAN * b['top'] + 1.5) + 6
        allp = np.concatenate([p['en'] for p in b['prisms']])
        we0 = GE + np.floor((allp[:, 0].min() - lim - GE) / res) * res
        wn1 = GN + np.ceil((allp[:, 1].max() + lim - GN) / res) * res
        w = int(np.ceil((allp[:, 0].max() + lim - we0) / res))
        h = int(np.ceil((wn1 - allp[:, 1].min() + lim) / res))
        out = np.zeros((h, w), np.uint8)
        for te in np.arange(GE + np.floor((we0 - GE) / TW) * TW, we0 + w * res, TW):
            for tn in np.arange(GN + np.ceil((wn1 - GN) / TH) * TH, wn1 - h * res - TH, -TH):
                ie0, ie1 = max(te, we0), min(te + TW, we0 + w * res)
                in1, in0 = min(tn, wn1), max(tn - TH, wn1 - h * res)
                if ie0 >= ie1 or in0 >= in1:
                    continue
                with rasterio.open(f'/vsicurl/{BASE}/{tile_name(te + 1, tn - 1)}.tiff') as s:
                    win = rasterio.windows.Window((ie0 - te) / 0.075, (tn - in1) / 0.075, (ie1 - ie0) / 0.075, (in1 - in0) / 0.075)
                    ow, oh = int(round((ie1 - ie0) / res)), int(round((in1 - in0) / res))
                    a = s.read([1, 2, 3], window=win, out_shape=(3, oh, ow), resampling=Resampling.average).astype(np.float32)
                c0, r0 = int(round((ie0 - we0) / res)), int(round((wn1 - in1) / res))
                out[r0:r0 + oh, c0:c0 + ow] = np.round(a[0] * 0.2126 + a[1] * 0.7152 + a[2] * 0.0722)
        return out, we0, wn1

    reg = sorted([r for r in rows if r['kind'] in ('registered', 'registered_sure')], key=lambda r: -r['h'])[:10]
    fixture = []
    for r in reg:
        b = r['b']
        img, we0, wn1 = window(b, 0.15)
        # measure() and peak() read the mosaic's globals: point them at this window
        globals().update(mos=img, e0=we0, n1=wn1, RES=0.15, W=img.shape[1], H=img.shape[0])
        m = measure(b)
        pk = peak(*m) if m is not None else None
        if not pk:
            continue
        s15 = np.linalg.solve(r['J'], pk[0])
        miss = float(np.hypot(*(s15 - r['final'])))
        fixture.append({'i': r['i'], 'h': r['h'], 'x': round(r['x'], 1), 'z': round(r['z'], 1), 'dx': round(float(s15[0]), 2), 'dz': round(float(s15[1]), 2), 'apart': round(miss, 2), 'q': round(pk[1], 2)})
        print(f"  #{r['i']:<5} h {r['h']:5.1f} m  baked ({r['final'][0]:+5.2f}, {r['final'][1]:+5.2f})  at 0.15 m ({s15[0]:+5.2f}, {s15[1]:+5.2f})  apart {miss:.2f} m  q {pk[1]:.2f}", flush=True)
    path = os.path.join(HERE, '../../tests/fixtures/linz-roof-spotchecks.json')
    json.dump(fixture, open(path, 'w'), indent=1)
    print(f'wrote {path}')
