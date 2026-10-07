"""
Open data 4 (#6, #120): bake the LINZ Auckland 0.075 m Urban Aerial Photos (2024-2025) into the game's ground
photos (src/world/terrain/data/):

    python3 aerial.py <work> [city|outer|all|align]     (default: all; align: the outer boxes' alignment report again)
    python3 aerial.py <work> outer-ktx2 [atlas.png]      (the high tier's KTX2 and cover again, from a saved atlas)

city   the square over the CBD / waterfront (AERIAL_RECT in src/world/terrain/theaters/aucklandAerial.ts):
       auckland-aerial-{2048,4096}.webp, 2.5 / 1.25 m per pixel (medium / high tier).
outer  one atlas per tier of the rectangles in OUTER below (#120): the rest of the Devonport peninsula at the
       square's resolution and the gulf islands (Rangitoto, Motutapu, Rakino, Motuihe, Browns Island, Waiheke with
       Pakatoa and Rotoroa) at a coarser one: auckland-aerial-outer-2048.webp and auckland-aerial-outer-4096.ktx2
       (2048 / 4096 px wide; the high tier as GPU-compressed KTX2, see OUTER_KTX2, with its alpha beside it in
       auckland-aerial-outer-cover.png) and their
       layout, auckland-aerial-outer.json (read by aucklandAerial.ts; each rectangle's world box and where it sits in
       each tier's atlas).

Steps, per rectangle:
1. STAC: every item of the collection, cached once in <work>/stac-all.json (the first run reads all ~17,700 item
   JSONs, ~3-10 min; later layers and sites reuse it), then the 1:1000 tiles (480 x 720 m COGs) that meet it.
2. Mosaic in NZTM2000 from the COGs' overviews (range requests): 1/8 (0.6 m) for the 1.25 m rectangles, 1/32
   (2.4 m) for the 5 m ones; alpha band as the valid mask. Cached in <work>/aerial-mosaic-<name>.npz.
3. Reproject to game XZ (the equirectangular projection of src/core/auckland.ts; NZTM grid convergence here is
   ~1.06 deg, so it is a per-pixel warp, exact pyproj on a lattice, bilinear between) at half the pixel size,
   box-filtered 2x.
4. Grade: local contrast eased (shadows and sunlit faces pulled toward their 12 m neighbourhood), shadow chroma
   neutralised, exposure matched to the procedural suburbs' far albedo. The exposure gain is the city square's for
   every rectangle (<work>/aerial-grade.json), so the Devonport rectangles continue the square seamlessly and the
   islands sit in the same light.
5. Alpha = land >= 2 m inside the LINZ coastline (masks from aerial-mask.ts, run here), or an OSM deck (wharf, pier,
   breakwater, dock); on an island rectangle only the land wholly inside it (connected components its edge does
   not cut: Ponui's tip inside the Waiheke box stays procedural). Open water is edge-padded from the land
   (push-pull) so it costs ~nothing and filtering at the shore never pulls in sea colour.
6. Alignment report: cross-correlation of the photo's water against the LINZ coastline (sub-pixel peak); for the
   square also its dark asphalt against the LINZ CBD carriageways.
7. WebP (the outer atlas's high tier: KTX2, OUTER_KTX2). The atlas rectangles carry an apron of real photo (APRON px
   at the high tier) round their box, so bilinear filtering and the first mip levels never mix in a neighbour.

pip install numpy scipy rasterio pyproj pillow
"""
import concurrent.futures as cf
import io
import json
import os
import subprocess
import sys
import urllib.request

import numpy as np
import rasterio
from PIL import Image
from pyproj import Transformer
from rasterio.enums import Resampling
from scipy.ndimage import binary_dilation, gaussian_filter, label, map_coordinates
from scipy.signal import fftconvolve

os.environ['GDAL_DISABLE_READDIR_ON_OPEN'] = 'EMPTY_DIR'
os.environ['GDAL_HTTP_MULTIRANGE'] = 'YES'
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, '../..')
OUT_DIR = os.path.join(ROOT, 'src/world/terrain/data')
BASE = 'https://nz-imagery.s3.ap-southeast-2.amazonaws.com/auckland/auckland_2024_0.075m/rgb/2193'

O = (-36.8485, 174.7622)  # AKL_ORIGIN
MLAT = 110950
MLON = 111320 * np.cos(np.radians(O[0]))

# AERIAL_RECT in src/world/terrain/theaters/aucklandAerial.ts
CITY = dict(name='city', x0=-1536, z0=-3072, w=5120, h=5120, px=1.25, ov=8)
X0C, Z0C = CITY['x0'], CITY['z0']
# 2048 / 4096 WebP quality (the photo is 45 % open water, padded flat)
QUALITY = {2048: 62, 4096: 42}
# Tiers whose outer atlas ships as KTX2 (Basis Universal ETC1S, sRGB, with mipmaps) instead of WebP: transcoded to the
# GPU's own block format at load (BC7 / ASTC / ETC2 / BC3: 1 byte a pixel), the high tier's 27.5 Mpx atlas takes
# ~35 MB of GPU memory instead of ~140 MB as RGBA8 with mips, for a ~4x larger download. Needs the basisu CLI
# (github.com/BinomialLLC/basis_universal; $BASISU or on the PATH). The medium tier stays WebP (35 MB is fine there).
OUTER_KTX2 = {4096}
BASISU = os.environ.get('BASISU', 'basisu')
# Width (px) of the outer atlas's alpha copy the KTX2 tiers ship beside it (auckland-aerial-outer-cover.png): the
# scatters read it at load (aucklandAerial.ts imageAlphaMask), as they read the WebP's alpha on the medium tier.
COVER_W = 512

# The outer atlas (#120). Boxes in game XZ (m; x0, z0 = north-west corner): the islands' on multiples of 10 m, the
# Devonport boxes on the city square's pixel lattice (x0 + 1536, z0 + 3072 multiples of 2.5 m), so their pixels are
# the square's at both tiers. `px`: metres per
# pixel at the high tier (the medium tier has twice that). `feather`: the fade at the box's edge (m), as the city
# square's AERIAL_FEATHER. Boxes that continue a photo overlap it by their feather, so the two fades cross over
# (their weights sum to >= 1 there) and no edge shows. `islands`: the box keeps only the land wholly inside it (a
# component its edge cuts, Ponui's tip in Waiheke's box, stays procedural). `ov`: COG overview level read.
OUTER = [
    # Devonport north of the square (Stanley Bay, Bayswater, Belmont to the Hauraki neck, Narrow Neck): overlaps the
    # square's north fade (z -3072 ... -2752); fades out across the neck north of Belmont (z -5500 ... -5180)
    dict(name='devonport_north', x0=-1, z0=-5499.5, w=4480, h=2750, px=1.25, ov=8, feather=320),
    # Cheltenham and North Head, east of the square: overlaps its east fade (x 3260 ... 3584) and devonport_north's
    # south fade (z -3070 ... -2750)
    dict(name='devonport_east', x0=3261.5, z0=-3069.5, w=1740, h=1670, px=1.25, ov=8, feather=320),
    dict(name='waiheke', x0=19380, z0=-12420, w=20040, h=12580, px=5, ov=32, feather=60, islands=True),
    dict(name='rangitoto_motutapu', x0=5720, z0=-13280, w=10060, h=9080, px=5, ov=32, feather=60, islands=True),
    dict(name='motuihe', x0=15140, z0=-5500, w=2500, h=2720, px=5, ov=32, feather=40, islands=True),
    dict(name='rakino', x0=15660, z0=-15660, w=1600, h=2560, px=5, ov=32, feather=60, islands=True),
    dict(name='browns', x0=11120, z0=-2580, w=1300, h=1340, px=5, ov=32, feather=60, islands=True),
]
SEA_BAND = 90  # m of the islands' photo past the coastline (the terrain's shore can lie a heightfield cell out)


def ndi_dilate(mask, r):
    """Disc dilation by r pixels (separable box passes are too square for a coast)."""
    y, x = np.ogrid[-r:r + 1, -r:r + 1]
    return binary_dilation(mask, structure=(x * x + y * y) <= r * r)


APRON = 32  # px of real photo round each atlas box at the high tier (16 at medium)
ATLAS_W = {4096: 4096, 2048: 2048}

to_nztm = Transformer.from_crs(4326, 2193, always_xy=True)


def game_to_nztm(x, z):
    return to_nztm.transform(O[1] + x / MLON, O[0] - z / MLAT)


def stac_all(work):
    """Every item of the collection: {item, bbox (lon/lat), tif, date}. Cached in <work>/stac-all.json."""
    path = os.path.join(work, 'stac-all.json')
    if os.path.exists(path):
        return json.load(open(path))
    col = json.load(urllib.request.urlopen(BASE + '/collection.json'))
    hrefs = [l['href'] for l in col['links'] if l['rel'] == 'item']

    def get(h):
        err = None
        for _ in range(5):
            try:
                d = json.load(urllib.request.urlopen(BASE + '/' + h[2:], timeout=30))
                break
            except Exception as e:  # noqa: BLE001
                err = e
        else:
            raise err
        return {'item': h, 'bbox': d['bbox'], 'tif': [v['href'] for v in d['assets'].values() if v['href'].endswith('.tiff')],
                'date': d['properties'].get('start_datetime')}

    with cf.ThreadPoolExecutor(64) as ex:
        res = list(ex.map(get, hrefs))
    print(f'STAC: {len(res)} items', flush=True)
    json.dump(res, open(path, 'w'))
    return res


def items_in(work, x0, z0, x1, z1, margin=200):
    lon0, lat1 = O[1] + (x0 - margin) / MLON, O[0] - (z0 - margin) / MLAT
    lon1, lat0 = O[1] + (x1 + margin) / MLON, O[0] - (z1 + margin) / MLAT
    return [it for it in stac_all(work) if it['bbox'][0] < lon1 and it['bbox'][2] > lon0 and it['bbox'][1] < lat1 and it['bbox'][3] > lat0]


def mosaic(work, name, x0, z0, x1, z1, ov):
    """NZTM mosaic (uint8 RGB, 0 = no data) over a game box at the COG overview 1/ov; cached per name."""
    res = 0.075 * ov
    path = os.path.join(work, f'aerial-mosaic-{name}.npz')
    if os.path.exists(path):
        d = np.load(path)
        box = d['box'] if 'box' in d else np.array([X0C, Z0C, X0C + CITY['w'], Z0C + CITY['h']])
        if float(d['res']) == res and box[0] <= x0 and box[1] <= z0 and box[2] >= x1 and box[3] >= z1:
            return d['rgb'], float(d['e0']), float(d['n1']), res
    items = items_in(work, x0, z0, x1, z1)
    xs, zs = np.meshgrid(np.linspace(x0 - 100, x1 + 100, 20), np.linspace(z0 - 100, z1 + 100, 20))
    E, Nn = game_to_nztm(xs, zs)
    e0, n1 = np.floor(E.min() / res) * res, np.ceil(Nn.max() / res) * res
    W, H = int(np.ceil((E.max() - e0) / res)), int(np.ceil((n1 - Nn.min()) / res))
    rgb = np.zeros((H, W, 3), np.uint8)
    have = np.zeros((H, W), bool)

    def read(it):
        for k in range(4):
            try:
                with rasterio.open('/vsicurl/' + BASE + '/' + it['tif'][0][2:]) as s:
                    b = s.bounds
                    c0, r0 = int(round((b.left - e0) / res)), int(round((n1 - b.top) / res))
                    w, h = int(round((b.right - b.left) / res)), int(round((b.top - b.bottom) / res))
                    return c0, r0, s.read([1, 2, 3, 4], out_shape=(4, h, w), resampling=Resampling.average)
            except Exception as e:  # noqa: BLE001
                if k == 3:
                    raise e

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
    dates = sorted({it['date'][:10] for it in items if it.get('date')})
    print(f'mosaic {name}: {len(items)} tiles ({", ".join(dates)}), {W}x{H} at {res} m, coverage {have.mean() * 100:.1f} %', flush=True)
    np.savez(path, rgb=rgb, e0=e0, n1=n1, res=res, box=np.array([x0, z0, x1, z1]))
    return rgb, e0, n1, res


def warp(mos, gx0, gz0, cols, rows, px):
    """The mosaic on a game grid (cols x rows pixels of px m from the corner gx0, gz0), sRGB float 0..1."""
    rgb, e0, n1, res = mos
    OS = 2
    G = max(2, int(np.ceil(max(cols, rows) * px / 40)) + 1)  # lattice every <= 40 m
    lx, lz = np.linspace(gx0, gx0 + cols * px, G), np.linspace(gz0, gz0 + rows * px, G)
    LX, LZ = np.meshgrid(lx, lz)
    E, Nn = game_to_nztm(LX, LZ)
    col, row = (E - e0) / res - 0.5, (n1 - Nn) / res - 0.5
    out = np.zeros((rows, cols, 3), np.float32)
    u = (np.arange(cols * OS) + 0.5) / (cols * OS) * (G - 1)
    step = 256
    for j0 in range(0, rows, step):
        j1 = min(rows, j0 + step)
        v = (np.arange(j0 * OS, j1 * OS) + 0.5) / (rows * OS) * (G - 1)
        U, V = np.meshgrid(u, v)
        CR, CC = map_coordinates(row, [V, U], order=1), map_coordinates(col, [V, U], order=1)
        for ch in range(3):
            big = map_coordinates(rgb[..., ch], [CR, CC], order=1, output=np.float32)
            out[j0:j1, :, ch] = big.reshape(j1 - j0, OS, cols, OS).mean(axis=(1, 3)) / 255
    return out


def masks(work, name, gx0, gz0, cols, rows, px):
    """aerial-mask.ts planes on the grid: coast signed distance (m), deck, streets, land."""
    path = os.path.join(work, f'aerial-mask-{name}-{px}-{cols}x{rows}.bin')
    if not os.path.exists(path):
        subprocess.run(['npx', 'vite-node', 'tools/linz/aerial-mask.ts', path, str(gx0), str(gz0), str(cols), str(rows), str(px)],
                       cwd=ROOT, check=True)
    m = np.fromfile(path, np.uint8).reshape(4, rows, cols)
    return m[0].astype(np.float32) - 128, m[1] > 0, m[2] > 0, m[3] > 0


def srgb_to_lin(c):
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def lin_to_srgb(c):
    c = np.clip(c, 0, 1)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * c ** (1 / 2.4) - 0.055)


LUMA = np.array([0.2126, 0.7152, 0.0722], np.float32)
# the procedural far suburb albedo's luminance (urbanColor.ts mix of the Auckland palette, ~0.085 linear)
TARGET_LUM = 0.085


def flatten(srgb, px):
    """Local contrast eased and shadow chroma neutralised; linear RGB."""
    lin = srgb_to_lin(srgb)
    lum = lin @ LUMA + 1e-4
    # pull every pixel's luminance toward its ~12 m neighbourhood (log domain), more for the dark side (cast
    # shadows) than for the bright side
    sig = 12 / px
    loc = np.exp(gaussian_filter(np.log(lum), sig))
    r = np.log(lum / loc)
    r = np.where(r < 0, r * 0.45, r * 0.75)
    lum2 = loc * np.exp(r)
    # shadows are sky-lit (blue): move their chroma toward the neighbourhood's
    chroma = lin / lum[..., None]
    loc_chroma = np.stack([gaussian_filter(chroma[..., c], sig) for c in range(3)], -1)
    shade = np.clip((0.0 - np.log(lum / loc)) / 0.8, 0, 1)[..., None]
    chroma = chroma + (loc_chroma - chroma) * shade * 0.7
    return chroma * lum2[..., None]


def exposure(lin, land):
    """Gain that puts the land's median luminance on the procedural far suburb albedo's, so the fade does not jump."""
    return TARGET_LUM / float(np.median((lin @ LUMA)[land]))


def pad(rgb, mask):
    """Push-pull fill of the pixels outside `mask` (weighted pyramid); any size."""
    H, W = mask.shape
    S = 1 << int(np.ceil(np.log2(max(H, W))))
    big = np.zeros((S, S, 3), np.float32)
    wbig = np.zeros((S, S), np.float32)
    big[:H, :W] = rgb
    wbig[:H, :W] = mask
    levels = []
    c, ww = big * wbig[..., None], wbig
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
    return np.where(mask[..., None], rgb, fill[:H, :W])


def xcorr(a, b, px, R=40, centre=True):
    """Offset (east, south; m) of image a against b at the cross-correlation peak, with a parabolic sub-pixel fit."""
    if centre:
        a, b = a - a.mean(), b - b.mean()
    c = fftconvolve(a, b[::-1, ::-1], mode='same')
    cy, cx = a.shape[0] // 2, a.shape[1] // 2
    win = c[cy - R:cy + R + 1, cx - R:cx + R + 1]
    j, i = np.unravel_index(win.argmax(), win.shape)

    def sub(m, p, q):
        d = m - 2 * p + q
        return 0.0 if d == 0 else 0.5 * (m - q) / d

    fi = sub(win[j, i - 1], win[j, i], win[j, i + 1]) if 0 < i < 2 * R else 0.0
    fj = sub(win[j - 1, i], win[j, i], win[j + 1, i]) if 0 < j < 2 * R else 0.0
    return (i - R + fi) * px, (j - R + fj) * px


def water_of(photo):
    return ((photo[..., 1] + photo[..., 2]) / 2 - photo[..., 0] > 0.04).astype(np.float32)


def water_smooth(photo, px):
    """Water in a suburban or bush photo: smooth (luminance std < 0.02 over ~6 m, or one pixel's neighbours) and
    bluer than it is red ((g + b) / 2 - r > 0.06; the 2024 photo's blue-green cast puts shaded gardens near 0.06),
    then a majority over ~15 m. The colour test alone (water_of) calls half of Devonport's gardens water."""
    from scipy.ndimage import uniform_filter
    lum = photo.mean(2)
    k = max(3, int(round(6 / px)) | 1)
    m = uniform_filter(lum, k)
    sd = np.sqrt(np.maximum(uniform_filter(lum * lum, k) - m * m, 0))
    w = ((sd < 0.02) & ((photo[..., 1] + photo[..., 2]) / 2 - photo[..., 0] > 0.06)).astype(np.float32)
    return (uniform_filter(w, max(3, int(round(15 / px)) | 1)) > 0.5).astype(np.float32)


def align_coast(name, photo, coast_sd, px, reach=40.0):
    """Coast alignment of a photo against the game's LINZ coastline, robust to the tide. Along the game coast's
    normal at every few metres of it, find where the photo's water ends (water_smooth: a clear water -> land step
    within `reach` m); then fit those distances s_i = n_i . t + c by least squares with outliers (|residual| > 3 px)
    trimmed: t (east, south) is the photo's offset, c the mean waterline shift (the tide and the beaches: the
    photo's water edge lies seaward of the high-water coastline on a falling tide) that a translation cannot explain.
    The plain cross-correlation the city square uses is biased by Shoal Bay's mudflats and mangroves and by the
    islands' reefs. Prints and returns (dx, dz)."""
    water = water_smooth(photo, px)
    has = photo.max(2) > 0
    gz, gx = np.gradient(coast_sd)
    g = np.hypot(gx, gz) + 1e-6
    step = max(1, int(round(5 / px)))
    cj, ci = np.nonzero((np.abs(coast_sd) < 0.5 * px + 0.5) & has)
    keep = (cj % step == 0) & (ci % step == 0)
    cj, ci = cj[keep], ci[keep]
    nx, nz = gx[cj, ci] / g[cj, ci], gz[cj, ci] / g[cj, ci]  # toward land, unit
    ss = np.arange(-reach, reach + 1e-6, px / 2)
    J = cj[:, None] + nz[:, None] * ss[None, :] / px
    I = ci[:, None] + nx[:, None] * ss[None, :] / px
    prof = map_coordinates(water, [J, I], order=1, mode='nearest')
    valid = map_coordinates(has.astype(np.float32), [J, I], order=0, mode='nearest').min(1) > 0
    # the first step from water (>= 0.5) to land, seen from the sea, with water before it and land after it
    cross = (prof[:, :-1] >= 0.5) & (prof[:, 1:] < 0.5)
    k = np.where(cross.any(1), cross.argmax(1), -1)
    w5 = max(1, int(round(10 / (px / 2))))
    ok = valid & (k > w5) & (k < len(ss) - 1 - w5)
    rows = np.nonzero(ok)[0]
    before = np.array([prof[r, k[r] - w5:k[r]].mean() for r in rows]) if len(rows) else np.zeros(0)
    after = np.array([prof[r, k[r] + 1:k[r] + 1 + w5].mean() for r in rows]) if len(rows) else np.zeros(0)
    sharp = (before > 0.8) & (after < 0.2)
    rows = rows[sharp]
    if len(rows) < 30:
        print(f'align coast ({name}): too few clear water edges ({len(rows)})', flush=True)
        return None
    kk = k[rows]
    sv = ss[kk] + (ss[1] - ss[0]) * (prof[rows, kk] - 0.5) / np.maximum(prof[rows, kk] - prof[rows, kk + 1], 1e-6)
    M = np.stack([nx[rows], nz[rows], np.ones(len(rows))], 1)
    use = np.ones(len(rows), bool)
    for _ in range(6):
        t = np.linalg.lstsq(M[use], sv[use], rcond=None)[0]
        res = sv - M @ t
        use = np.abs(res) < 3 * px
    t = np.linalg.lstsq(M[use], sv[use], rcond=None)[0]
    res = (sv - M @ t)[use]
    # the photo's water edge at s along the landward normal: the photo is shifted by -t (east, south)
    dx, dz, c = -t[0], -t[1], t[2]
    print(f'align coast ({name}): {dx:+.2f} m east, {dz:+.2f} m south (pixel {px} m; {int(use.sum())} of {len(rows)} clear water '
          f'edges along {len(cj) * step * px / 1000:.0f} km of coast, RMS {np.sqrt((res ** 2).mean()):.1f} m; mean waterline {c:+.1f} m '
          f'landward of the coastline)', flush=True)
    return dx, dz


def ktx2(img, path):
    """Encode an RGBA atlas to KTX2 (ETC1S at its best quality, sRGB, mipmaps with clamped borders)."""
    tmp = path + '.png'
    img.save(tmp)
    try:
        subprocess.run([BASISU, '-etc1s', '-quality', '100', '-mipmap', '-srgb', '-mip_clamp', '-ktx2', '-file', tmp, '-output_file', path],
                       check=True, stdout=subprocess.DEVNULL)
    finally:
        os.remove(tmp)
    return open(path, 'rb').read()


def cover(img):
    """The atlas's alpha box-filtered to COVER_W columns, as the alpha of an otherwise black PNG."""
    w = COVER_W
    h = max(1, int(img.size[1] * w / img.size[0] + 0.5))  # as Math.round
    a = img.getchannel('A').resize((w, h), Image.Resampling.BOX)
    out = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    out.putalpha(a)
    b = io.BytesIO()
    out.save(b, 'PNG', optimize=True)
    return b.getvalue()


def write_outer_ktx2(atlas, size, work=None):
    """The KTX2 atlas and its alpha cover of a tier in OUTER_KTX2 (and the atlas itself in <work>, to re-encode)."""
    assert atlas.size[0] % 4 == 0 and atlas.size[1] % 4 == 0, 'block-compressed textures need sides that are multiples of 4'
    if work:
        atlas.save(os.path.join(work, f'aerial-outer-{size}.png'))
    path = os.path.join(OUT_DIR, f'auckland-aerial-outer-{size}.ktx2')
    data = ktx2(atlas, path)
    c = cover(atlas)
    open(os.path.join(OUT_DIR, 'auckland-aerial-outer-cover.png'), 'wb').write(c)
    print(f'auckland-aerial-outer-cover.png: {COVER_W} px wide, {len(c) / 1024:.0f} KiB', flush=True)
    return path, data


def webp(img, q):
    b = io.BytesIO()
    img.save(b, 'WEBP', quality=q, method=6, alpha_quality=100, exact=False)
    return b.getvalue()


def bake_city(work):
    r = CITY
    N = int(r['w'] / r['px'])
    coast_sd, deck, streets, _ = masks(work, 'city', r['x0'], r['z0'], N, N, r['px'])
    mos = mosaic(work, 'city', r['x0'], r['z0'], r['x0'] + r['w'], r['z0'] + r['h'], r['ov'])
    photo = warp(mos, r['x0'], r['z0'], N, N, r['px'])

    # alignment against the game's LINZ data (east, south offsets of the photo, m)
    water = water_of(photo)
    for name, (rs, cs) in {'CBD waterfront': ((1400, 2400), (0, 3600)), 'Devonport': ((300, 1500), (2400, 4000))}.items():
        dx, dz = xcorr(water[rs[0]:rs[1], cs[0]:cs[1]], (coast_sd[rs[0]:rs[1], cs[0]:cs[1]] < 0).astype(np.float32), r['px'])
        print(f'align coast ({name}): {dx:+.2f} m east, {dz:+.2f} m south', flush=True)
    s = (slice(2000, 3300), slice(1000, 2700))
    lum = photo.mean(2)
    asphalt = ((lum < 0.35) & (photo.max(2) - photo.min(2) < 0.08)).astype(np.float32)
    dx, dz = xcorr(asphalt[s], streets[s].astype(np.float32), r['px'])
    print(f'align CBD streets (biased by building lean and cast shadows): {dx:+.2f} m east, {dz:+.2f} m south', flush=True)

    land = (coast_sd >= 2) | deck
    lin = flatten(photo, r['px'])
    k = exposure(lin, land)
    json.dump({'exposure': k}, open(os.path.join(work, 'aerial-grade.json'), 'w'))
    print(f'grade: exposure x{k:.3f}', flush=True)
    filled = pad(lin_to_srgb(lin * k), land)
    rgba = np.dstack([np.round(filled * 255).astype(np.uint8), (land * 255).astype(np.uint8)])
    img = Image.fromarray(rgba, 'RGBA')
    img.save(os.path.join(work, 'aerial-preview.png'))
    for size, q in QUALITY.items():
        im = img if size == N else img.resize((size, size), Image.Resampling.BOX)
        data = webp(im, q)
        path = os.path.join(OUT_DIR, f'auckland-aerial-{size}.webp')
        open(path, 'wb').write(data)
        print(f'{os.path.basename(path)}: {size}^2, {r["w"] / size:.2f} m/px, q{q}, {len(data) / 1024:.0f} KiB', flush=True)


def city_exposure(work):
    path = os.path.join(work, 'aerial-grade.json')
    if not os.path.exists(path):
        bake_city(work)
    return json.load(open(path))['exposure']


def bake_rect(work, r, k):
    """One outer rectangle at its high-tier pixel size, with the apron: RGBA uint8 (rows x cols x 4)."""
    px = r['px']
    cols, rows = int(round(r['w'] / px)) + 2 * APRON, int(round(r['h'] / px)) + 2 * APRON
    gx0, gz0 = r['x0'] - APRON * px, r['z0'] - APRON * px
    coast_sd, deck, _, landl = masks(work, r['name'], gx0, gz0, cols, rows, px)
    mos = mosaic(work, r['name'], gx0, gz0, gx0 + cols * px, gz0 + rows * px, r['ov'])
    photo = warp(mos, gx0, gz0, cols, rows, px)
    nodata = photo.max(2) <= 0
    land = (coast_sd >= 2) | deck
    if r.get('islands'):
        # every land component inside the box; those its edge cuts are another island's (Ponui) or the mainland's
        lab, _ = label(landl)
        cut = set(np.unique(np.concatenate([lab[0], lab[-1], lab[:, 0], lab[:, -1]]))) - {0}
        land &= (lab > 0) & ~np.isin(lab, list(cut))
        # out here (beyond the 32 km coast mask round the city) the drawn shoreline is the terrain's own, up to a
        # heightfield cell off the LINZ line: the photo (its real shallows and beaches) reaches SEA_BAND m out to sea
        # too, so terrain standing above the water there is not left a strip of procedural grass (the sea covers the rest)
        near = ndi_dilate(land, int(np.ceil(SEA_BAND / px))) & (coast_sd < 2) & ~nodata
        land |= near
    if (land & nodata).any():
        print(f'  {r["name"]}: {int((land & nodata).sum())} land px without photo (left out)', flush=True)
        land &= ~nodata
    lin = flatten(photo, px)
    own = exposure(lin, land)
    print(f'  {r["name"]}: land {land.sum() * px * px / 1e6:.2f} km2; own exposure would be x{own:.3f}, city x{k:.3f} used', flush=True)
    filled = pad(lin_to_srgb(lin * k), land)
    return np.dstack([np.round(filled * 255).astype(np.uint8), (land * 255).astype(np.uint8)])


def seam_check(work):
    """The Devonport boxes against the city square where they overlap (same tiles, same warp, same grade): the
    cross-correlation of their luminance (should peak at 0, 0) and the mean colour difference on land."""
    city = os.path.join(work, 'aerial-preview.png')
    if not os.path.exists(city):
        return
    c = np.asarray(Image.open(city)).astype(np.float32)
    cpx = CITY['w'] / c.shape[1]
    for r in OUTER:
        if r['px'] != cpx:
            continue
        x0, z0 = max(r['x0'], CITY['x0']), max(r['z0'], CITY['z0'])
        x1, z1 = min(r['x0'] + r['w'], CITY['x0'] + CITY['w']), min(r['z0'] + r['h'], CITY['z0'] + CITY['h'])
        if x1 <= x0 or z1 <= z0:
            continue
        b = np.asarray(Image.open(os.path.join(work, f'aerial-rect-{r["name"]}.png'))).astype(np.float32)
        ci, cj = int((x0 - CITY['x0']) / cpx), int((z0 - CITY['z0']) / cpx)
        bi, bj = int((x0 - r['x0']) / cpx) + APRON, int((z0 - r['z0']) / cpx) + APRON
        w, h = int((x1 - x0) / cpx), int((z1 - z0) / cpx)
        e = int(48 / cpx)  # (each photo's local grade sees its own edge within ~4 sigma = 48 m of it: left out)
        A = c[cj + e:cj + h - e, ci + e:ci + w - e]
        B = b[bj + e:bj + h - e, bi + e:bi + w - e]
        land = (A[..., 3] > 127) & (B[..., 3] > 127)
        dx, dz = xcorr(A[..., :3].mean(2), B[..., :3].mean(2), cpx, 8)
        diff = np.abs(A[..., :3] - B[..., :3])[land].mean()
        print(f'seam ({r["name"]} / city square, {w * cpx:.0f} x {h * cpx:.0f} m): {dx:+.2f} m east, {dz:+.2f} m south; '
              f'mean colour difference on land {diff:.2f} / 255', flush=True)


# Windows of dense houses for the buildings alignment (game XZ box, the mosaic it reads, pixel m)
BUILDING_WINDOWS = [
    ('Freemans Bay / Ponsonby (city square)', 'city', (-1400, -500, -300, 700), 1.25),
    ('Bayswater / Belmont', 'devonport_north', (1000, -4800, 3400, -3200), 1.25),
    ('Cheltenham', 'devonport_east', (3600, -3000, 4400, -2100), 1.25),
    ('Oneroa, Waiheke', 'waiheke', (21200, -8300, 23900, -6000), 2.5),
    ('Surfdale / Ostend, Waiheke', 'waiheke', (24000, -6200, 26800, -4200), 2.5),
]


def linz_buildings(work, tag, x0, z0, x1, z1):
    """LINZ NZ Building Outlines (layer 101290, WFS; LINZ_API_KEY) in a game box: rings in game XZ. Cached."""
    path = os.path.join(work, f'buildings-{tag}.json')
    if not os.path.exists(path):
        key = os.environ['LINZ_API_KEY']
        lon0, lon1 = O[1] + x0 / MLON, O[1] + x1 / MLON
        lat0, lat1 = O[0] - z1 / MLAT, O[0] - z0 / MLAT
        url = (f'https://data.linz.govt.nz/services;key={key}/wfs?service=WFS&version=2.0.0&request=GetFeature&typeNames=layer-101290'
               f'&outputFormat=json&srsName=EPSG:4326&bbox={lat0},{lon0},{lat1},{lon1},urn:ogc:def:crs:EPSG::4326')
        d = json.load(urllib.request.urlopen(url, timeout=120))
        rings = []
        for f in d['features']:
            g = f['geometry']
            polys = [g['coordinates']] if g['type'] == 'Polygon' else g['coordinates']
            for poly in polys:
                rings.append([[(lon - O[1]) * MLON, (O[0] - lat) * MLAT] for lon, lat in poly[0]])
        json.dump(rings, open(path, 'w'))
    return json.load(open(path))


def align_buildings(work):
    """The photo's roof edges (luminance gradient) cross-correlated with the LINZ building outlines (2017, sub-metre)
    over dense houses: an independent check of the photo's position, free of the tide and of the 16 m coastline."""
    from PIL import ImageDraw
    from scipy.ndimage import gaussian_filter as gf
    boxes = {r['name']: r for r in OUTER}
    for label_, name, (x0, z0, x1, z1), px in BUILDING_WINDOWS:
        if name == 'city':
            mos = mosaic(work, 'city', CITY['x0'], CITY['z0'], CITY['x0'] + CITY['w'], CITY['z0'] + CITY['h'], CITY['ov'])
        else:
            r = boxes[name]
            a = APRON * r['px']
            mos = mosaic(work, name, r['x0'] - a, r['z0'] - a, r['x0'] + r['w'] + a, r['z0'] + r['h'] + a, r['ov'])
        cols, rows = int((x1 - x0) / px), int((z1 - z0) / px)
        photo = warp(mos, x0, z0, cols, rows, px)
        lum = photo.mean(2)
        gy, gx = np.gradient(gf(lum, 0.7))
        grad = np.hypot(gx, gy)
        grad = np.minimum(grad, np.percentile(grad, 99))
        rings = linz_buildings(work, f'{name}-{x0}-{z0}', x0, z0, x1, z1)
        im = Image.new('L', (cols, rows), 0)
        dr = ImageDraw.Draw(im)
        for ring in rings:
            dr.line([((x - x0) / px - 0.5, (z - z0) / px - 0.5) for x, z in ring], fill=255, width=1)
        edges = gf(np.asarray(im, np.float32) / 255, 0.7)
        dx, dz = xcorr(grad, edges, px, int(12 / px))
        print(f'align buildings ({label_}): {dx:+.2f} m east, {dz:+.2f} m south (pixel {px} m, {len(rings)} LINZ outlines)', flush=True)


ALIGN_PX = 2.5  # the alignment report's pixel (m): the island mosaics are 2.4 m; water reads better than at 1.25 m


def align_outer(work):
    """The alignment report of every outer box, at ALIGN_PX, from the cached mosaics (masks made as needed)."""
    out = {}
    for r in OUTER:
        px = ALIGN_PX
        m = 16 * px
        cols, rows = int(round((r['w'] + 2 * m) / px)), int(round((r['h'] + 2 * m) / px))
        gx0, gz0 = r['x0'] - m, r['z0'] - m
        coast_sd = masks(work, r['name'], gx0, gz0, cols, rows, px)[0]
        a = APRON * r['px']
        mos = mosaic(work, r['name'], r['x0'] - a, r['z0'] - a, r['x0'] + r['w'] + a, r['z0'] + r['h'] + a, r['ov'])
        out[r['name']] = align_coast(r['name'], warp(mos, gx0, gz0, cols, rows, px), coast_sd, px)
    return out


def pack(sizes, width):
    """Guillotine packing (tallest first, each box at the lowest free spot) of (w, h) boxes into `width`:
    positions and the total height."""
    free = [(0, 0, width, 1 << 30)]
    pos = [None] * len(sizes)
    for i in sorted(range(len(sizes)), key=lambda i: (-sizes[i][1], -sizes[i][0])):
        w, h = sizes[i]
        fits = [f for f in free if f[2] >= w and f[3] >= h]
        x, y, fw, fh = min(fits, key=lambda f: (f[1], f[0]))
        free.remove((x, y, fw, fh))
        pos[i] = (x, y)
        # split the rest: right of the box (the box's height), and below it (the free rectangle's width)
        if fw > w:
            free.append((x + w, y, fw - w, h))
        if fh > h:
            free.append((x, y + h, fw, fh - h))
    return pos, max(y + sizes[i][1] for i, (x, y) in enumerate(pos))


def bake_outer(work):
    k = city_exposure(work)
    imgs = {}
    for r in OUTER:
        path = os.path.join(work, f'aerial-rect-{r["name"]}.png')
        if not os.path.exists(path):
            Image.fromarray(bake_rect(work, r, k), 'RGBA').save(path)
        imgs[r['name']] = Image.open(path)
        imgs[r['name']].load()
    sizes = [imgs[r['name']].size for r in OUTER]
    for w, h in sizes:
        assert w % 2 == 0 and h % 2 == 0, 'high-tier boxes must halve exactly'
    pos, height = pack(sizes, ATLAS_W[4096])
    height += height % 4
    manifest = {
        'source': 'LINZ Auckland 0.075m Urban Aerial Photos (2024-2025), CC BY 4.0; baked by tools/linz/aerial.py',
        'rects': [{k2: r[k2] for k2 in ('name', 'x0', 'z0', 'w', 'h', 'feather')} for r in OUTER],
        'tiers': {},
    }
    for size, q in QUALITY.items():
        f = ATLAS_W[4096] // size  # 1 (high) or 2 (medium)
        atlas = Image.new('RGBA', (ATLAS_W[size], height // f), (0, 0, 0, 0))
        boxes = []
        for r, (x, y) in zip(OUTER, pos):
            im = imgs[r['name']]
            if f > 1:
                im = im.resize((im.size[0] // f, im.size[1] // f), Image.Resampling.BOX)
            atlas.paste(im, (x // f, y // f))
            a = APRON // f
            boxes.append([x // f + a, y // f + a, x // f + im.size[0] - a, y // f + im.size[1] - a])
        if size in OUTER_KTX2:
            path, data = write_outer_ktx2(atlas, size, work)
            gpu, fmt = 1, 'ETC1S'
        else:
            data = webp(atlas, q)
            path = os.path.join(OUT_DIR, f'auckland-aerial-outer-{size}.webp')
            open(path, 'wb').write(data)
            gpu, fmt = 4, f'q{q}'
        if size == 4096:
            atlas.convert('RGB').resize((atlas.size[0] // 4, atlas.size[1] // 4)).save(os.path.join(work, 'aerial-outer-preview.jpg'), quality=85)
        manifest['tiers'][str(size)] = {'width': atlas.size[0], 'height': atlas.size[1], 'boxes': boxes}
        mpx = atlas.size[0] * atlas.size[1] / 1e6
        print(f'{os.path.basename(path)}: {atlas.size[0]}x{atlas.size[1]} ({mpx:.1f} Mpx, {mpx * gpu * 4 / 3:.0f} MB on the GPU with mips), {fmt}, {len(data) / 1024:.0f} KiB', flush=True)
        for r, b in zip(OUTER, boxes):
            print(f'  {r["name"]}: {r["w"] / (b[2] - b[0]):.2f} m/px, {b[2] - b[0]}x{b[3] - b[1]} at {b[0]},{b[1]}', flush=True)
    path = os.path.join(OUT_DIR, 'auckland-aerial-outer.json')
    open(path, 'w').write(json.dumps(manifest, indent=1) + '\n')
    print(f'{os.path.basename(path)} written', flush=True)
    seam_check(work)
    align_outer(work)
    align_buildings(work)


def main():
    work = sys.argv[1]
    what = sys.argv[2] if len(sys.argv) > 2 else 'all'
    os.makedirs(work, exist_ok=True)
    if what in ('city', 'all'):
        bake_city(work)
    if what in ('outer', 'all'):
        bake_outer(work)
    if what == 'outer-ktx2':  # re-encode the KTX2 tiers from a saved atlas (<work>/aerial-outer-<size>.png by default)
        for size in OUTER_KTX2:
            src = sys.argv[3] if len(sys.argv) > 3 else os.path.join(work, f'aerial-outer-{size}.png')
            atlas = Image.open(src).convert('RGBA')
            path, data = write_outer_ktx2(atlas, size)
            print(f'{os.path.basename(path)}: {atlas.size[0]}x{atlas.size[1]} from {src}, {len(data) / 1024:.0f} KiB', flush=True)
    if what == 'align':  # (bake_outer ends with it too)
        seam_check(work)
        align_outer(work)
        align_buildings(work)


if __name__ == '__main__':
    main()
