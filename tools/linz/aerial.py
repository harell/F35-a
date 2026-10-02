"""
Open data 4 (#6): bake the LINZ Auckland 0.075 m Urban Aerial Photos (2024-2025) into the game's CBD /
waterfront ground texture (src/world/terrain/data/auckland-aerial-{2048,4096}.webp).

    python3 aerial.py <work>          (needs <work>/aerial-mask-4096.bin from aerial-mask.ts)

1. STAC: the 1:1000 tiles (480 x 720 m COGs, s3://nz-imagery/auckland/auckland_2024_0.075m/rgb/2193/)
   whose bbox meets the photo square (cached in <work>/aerial-items.json; the first run reads all
   ~17,700 item JSONs, ~10 min).
2. Mosaic in NZTM2000 at 0.6 m from the COGs' 1/8 overviews (range requests, ~20 MB), alpha band
   as the valid mask.
3. Reproject to game XZ (the equirectangular projection of src/core/auckland.ts; NZTM grid
   convergence here is ~1.06 deg, so it is a per-pixel warp, exact pyproj on a 129^2 lattice,
   bilinear between) at 0.625 m, box-filtered 2x to 4096^2 (1.25 m).
4. Grade: local contrast eased (shadows and sunlit faces pulled toward their 12 m neighbourhood),
   shadow chroma neutralised, exposure matched to the procedural suburbs' far albedo.
5. Alpha = land >= 2 m inside the LINZ coastline, or an OSM deck (wharf, pier, breakwater, dock);
   open water is edge-padded from the land (push-pull) so it costs ~nothing and filtering at the
   shore never pulls in sea colour.
6. Alignment report: cross-correlation of the photo's water against the LINZ coastline, and of its
   dark asphalt against the LINZ CBD carriageways.
7. WebP: 4096^2 (high tier) and 2048^2 (medium tier).

pip install numpy scipy rasterio pyproj pillow
"""
import concurrent.futures as cf
import io
import json
import os
import sys
import urllib.request

import numpy as np
import rasterio
from PIL import Image
from pyproj import Transformer
from rasterio.enums import Resampling
from scipy.ndimage import gaussian_filter, map_coordinates
from scipy.signal import fftconvolve

os.environ['GDAL_DISABLE_READDIR_ON_OPEN'] = 'EMPTY_DIR'
os.environ['GDAL_HTTP_MULTIRANGE'] = 'YES'
HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.join(HERE, '../../src/world/terrain/data')
BASE = 'https://nz-imagery.s3.ap-southeast-2.amazonaws.com/auckland/auckland_2024_0.075m/rgb/2193'

# AERIAL_RECT in src/world/terrain/theaters/aucklandAerial.ts
X0, Z0, SIZE = -1536, -3072, 5120
N = 4096
MOS_RES = 0.6
O = (-36.8485, 174.7622)  # AKL_ORIGIN
MLAT = 110950
MLON = 111320 * np.cos(np.radians(O[0]))
# 2048 / 4096 WebP quality (the photo is 45 % open water, padded flat)
QUALITY = {2048: 62, 4096: 42}

work = sys.argv[1]
to_nztm = Transformer.from_crs(4326, 2193, always_xy=True)


def game_to_nztm(x, z):
    return to_nztm.transform(O[1] + x / MLON, O[0] - z / MLAT)


def stac_items():
    path = os.path.join(work, 'aerial-items.json')
    if os.path.exists(path):
        return json.load(open(path))
    lon0, lat1 = O[1] + (X0 - 200) / MLON, O[0] - (Z0 - 200) / MLAT
    lon1, lat0 = O[1] + (X0 + SIZE + 200) / MLON, O[0] - (Z0 + SIZE + 200) / MLAT
    col = json.load(urllib.request.urlopen(BASE + '/collection.json'))
    hrefs = [l['href'] for l in col['links'] if l['rel'] == 'item']

    def get(h):
        for _ in range(4):
            try:
                d = json.load(urllib.request.urlopen(BASE + '/' + h[2:], timeout=30))
                break
            except Exception as e:  # noqa: BLE001
                err = e
        else:
            raise err
        b = d['bbox']
        if b[0] < lon1 and b[2] > lon0 and b[1] < lat1 and b[3] > lat0:
            return {'item': h, 'bbox': b, 'tif': [v['href'] for v in d['assets'].values() if v['href'].endswith('.tiff')],
                    'date': d['properties'].get('start_datetime')}
        return None

    with cf.ThreadPoolExecutor(64) as ex:
        res = [r for r in ex.map(get, hrefs) if r]
    print(f'{len(hrefs)} items, {len(res)} in the square', flush=True)
    json.dump(res, open(path, 'w'))
    return res


def mosaic(items):
    path = os.path.join(work, 'aerial-mosaic.npz')
    if os.path.exists(path):
        d = np.load(path)
        return d['rgb'], float(d['e0']), float(d['n1'])
    xs, zs = np.meshgrid(np.linspace(X0 - 100, X0 + SIZE + 100, 20), np.linspace(Z0 - 100, Z0 + SIZE + 100, 20))
    E, Nn = game_to_nztm(xs, zs)
    e0, n1 = np.floor(E.min() / MOS_RES) * MOS_RES, np.ceil(Nn.max() / MOS_RES) * MOS_RES
    W, H = int(np.ceil((E.max() - e0) / MOS_RES)), int(np.ceil((n1 - Nn.min()) / MOS_RES))
    rgb = np.zeros((H, W, 3), np.uint8)
    have = np.zeros((H, W), bool)

    def read(it):
        with rasterio.open('/vsicurl/' + BASE + '/' + it['tif'][0][2:]) as s:
            b = s.bounds
            c0, r0 = int(round((b.left - e0) / MOS_RES)), int(round((n1 - b.top) / MOS_RES))
            w, h = int(round((b.right - b.left) / MOS_RES)), int(round((b.top - b.bottom) / MOS_RES))
            return c0, r0, s.read([1, 2, 3, 4], out_shape=(4, h, w), resampling=Resampling.average)

    with cf.ThreadPoolExecutor(16) as ex:
        for c0, r0, a in ex.map(read, items):
            h, w = a.shape[1:]
            rr0, cc0, rr1, cc1 = max(0, r0), max(0, c0), min(H, r0 + h), min(W, c0 + w)
            if rr0 >= rr1 or cc0 >= cc1:
                continue
            sub = a[:, rr0 - r0:rr1 - r0, cc0 - c0:cc1 - c0]
            m = sub[3] > 127
            rgb[rr0:rr1, cc0:cc1][m] = np.moveaxis(sub[:3], 0, -1)[m]
            have[rr0:rr1, cc0:cc1] |= m
    print(f'mosaic {W}x{H} at {MOS_RES} m, coverage {have.mean() * 100:.2f} %', flush=True)
    np.savez(path, rgb=rgb, e0=e0, n1=n1)
    return rgb, e0, n1


def warp(rgb, e0, n1):
    """Photo on the game grid, N x N pixel centres, sRGB float 0..1."""
    G, OS = 129, 2
    gx, gz = np.meshgrid(np.linspace(X0, X0 + SIZE, G), np.linspace(Z0, Z0 + SIZE, G))
    E, Nn = game_to_nztm(gx, gz)
    col, row = (E - e0) / MOS_RES - 0.5, (n1 - Nn) / MOS_RES - 0.5
    M = N * OS
    u = (np.arange(M) + 0.5) / M * (G - 1)
    U, V = np.meshgrid(u, u)
    CR, CC = map_coordinates(row, [V, U], order=1), map_coordinates(col, [V, U], order=1)
    out = np.zeros((N, N, 3), np.float32)
    for ch in range(3):
        big = map_coordinates(rgb[..., ch].astype(np.float32), [CR, CC], order=1)
        out[..., ch] = big.reshape(N, OS, N, OS).mean(axis=(1, 3)) / 255
    return out


def srgb_to_lin(c):
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def lin_to_srgb(c):
    c = np.clip(c, 0, 1)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * c ** (1 / 2.4) - 0.055)


def grade(srgb, land):
    lin = srgb_to_lin(srgb)
    lum = lin @ np.array([0.2126, 0.7152, 0.0722], np.float32) + 1e-4
    # local contrast: pull every pixel's luminance toward its ~12 m neighbourhood (log domain), more for
    # the dark side (cast shadows) than for the bright side
    sig = 12 / (SIZE / N)
    loc = np.exp(gaussian_filter(np.log(lum), sig))
    r = np.log(lum / loc)
    r = np.where(r < 0, r * 0.45, r * 0.75)
    lum2 = loc * np.exp(r)
    # shadows are sky-lit (blue): move their chroma toward the neighbourhood's
    chroma = lin / lum[..., None]
    loc_chroma = np.stack([gaussian_filter(chroma[..., c], sig) for c in range(3)], -1)
    shade = np.clip((0.0 - np.log(lum / loc)) / 0.8, 0, 1)[..., None]
    chroma = chroma + (loc_chroma - chroma) * shade * 0.7
    out = chroma * lum2[..., None]
    # exposure: the land's mean luminance onto the procedural far suburb albedo's (urbanColor.ts mix of
    # the Auckland palette, ~0.085 linear), so the feathered edge does not jump in brightness
    target = 0.085
    k = target / np.median((out @ np.array([0.2126, 0.7152, 0.0722], np.float32))[land])
    print(f'grade: exposure x{k:.3f}', flush=True)
    return lin_to_srgb(out * k)


def pad(rgb, mask):
    """Push-pull fill of the pixels outside `mask` (weighted pyramid)."""
    w = mask.astype(np.float32)
    levels = []
    c, ww = rgb * w[..., None], w
    while c.shape[0] > 4:
        levels.append((c, ww))
        h = c.shape[0] // 2
        c = c.reshape(h, 2, h, 2, 3).sum(axis=(1, 3))
        ww = ww.reshape(h, 2, h, 2).sum(axis=(1, 3))
    fill = c.sum(axis=(0, 1)) / max(ww.sum(), 1e-6) * np.ones_like(c)
    for c, ww in reversed(levels):
        up = np.repeat(np.repeat(fill, 2, 0), 2, 1)
        up = gaussian_filter(up, (1, 1, 0))
        fill = np.where(ww[..., None] > 1e-6, c / np.maximum(ww, 1e-6)[..., None], up)
    return np.where(mask[..., None], rgb, fill)


def xcorr(a, b, R=40):
    a, b = a - a.mean(), b - b.mean()
    c = fftconvolve(a, b[::-1, ::-1], mode='same')
    cy, cx = a.shape[0] // 2, a.shape[1] // 2
    win = c[cy - R:cy + R + 1, cx - R:cx + R + 1]
    j, i = np.unravel_index(win.argmax(), win.shape)
    return (i - R) * SIZE / N, (j - R) * SIZE / N


def main():
    masks = np.fromfile(os.path.join(work, f'aerial-mask-{N}.bin'), np.uint8).reshape(3, N, N)
    coast_sd = masks[0].astype(np.float32) - 128
    deck, streets = masks[1] > 0, masks[2] > 0
    items = stac_items()
    print('capture dates:', sorted({it['date'][:10] for it in items if it.get('date')}), flush=True)
    photo = warp(*mosaic(items))

    # alignment against the game's LINZ data (east, south offsets of the photo, m)
    water = ((photo[..., 1] + photo[..., 2]) / 2 - photo[..., 0] > 0.04).astype(np.float32)
    for name, (rs, cs) in {'CBD waterfront': ((1400, 2400), (0, 3600)), 'Devonport': ((300, 1500), (2400, 4000))}.items():
        dx, dz = xcorr(water[rs[0]:rs[1], cs[0]:cs[1]], (coast_sd[rs[0]:rs[1], cs[0]:cs[1]] < 0).astype(np.float32))
        print(f'align coast ({name}): {dx:+.2f} m east, {dz:+.2f} m south', flush=True)
    s = (slice(2000, 3300), slice(1000, 2700))
    lum = photo.mean(2)
    asphalt = ((lum < 0.35) & (photo.max(2) - photo.min(2) < 0.08)).astype(np.float32)
    dx, dz = xcorr(asphalt[s], streets[s].astype(np.float32))
    print(f'align CBD streets (biased by building lean and cast shadows): {dx:+.2f} m east, {dz:+.2f} m south', flush=True)

    land = (coast_sd >= 2) | deck
    graded = grade(photo, land)
    filled = pad(graded, land)
    alpha = (land * 255).astype(np.uint8)
    rgba = np.dstack([np.round(filled * 255).astype(np.uint8), alpha])
    img = Image.fromarray(rgba, 'RGBA')
    img.save(os.path.join(work, 'aerial-preview.png'))
    for size, q in QUALITY.items():
        im = img if size == N else img.resize((size, size), Image.Resampling.BOX)
        b = io.BytesIO()
        im.save(b, 'WEBP', quality=q, method=6, alpha_quality=100, exact=False)
        path = os.path.join(OUT_DIR, f'auckland-aerial-{size}.webp')
        open(path, 'wb').write(b.getvalue())
        print(f'{os.path.basename(path)}: {size}^2, {SIZE / size:.2f} m/px, q{q}, {len(b.getvalue()) / 1024:.0f} KiB', flush=True)


main()
