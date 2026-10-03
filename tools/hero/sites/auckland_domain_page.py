"""
F35-A — hero landmarks: fill tools/hero/examples/auckland-domain.html with the Domain data → <site>/prototype.html.

  python3 tools/hero/sites/auckland_domain.py --site /tmp/hero/auckland_domain          (→ domain_model.json)
  # the game's own Domain: a throwaway vitest writes <site>/game_export.json (see the skill's lessons):
  #   generateTerrain at 1024 (medium) and 2048 + LINZ HD (high), meshHeightAt on a 10 m grid ±800 m round the
  #   site centre in game XZ, and the buildCBD + buildMuseumAndObelisk triangles inside that square
  node tools/hero/today-shot.mjs --x=1123 --z=1243 --dist=900 --alt=420 --from=sw|ne --out=<site>/today_<from>.jpg
  python3 tools/hero/sites/auckland_domain_page.py --site /tmp/hero/auckland_domain       (→ prototype.html)

Game XZ → site frame goes through WGS84 (geoToWorld is linear in lat/lon; the site frame is NZTM, ~1° apart).
"""
import argparse, base64, io, json, math, os

import numpy as np
from PIL import Image
from pyproj import Transformer
from scipy import ndimage

Image.MAX_IMAGE_PIXELS = None
to_nztm = Transformer.from_crs(4326, 2193, always_xy=True)
O_LAT, O_LON, MLAT = -36.8485, 174.7622, 110950
MLON = 111320 * math.cos(math.radians(O_LAT))
HERE = os.path.dirname(os.path.abspath(__file__))


def b64(a):
    return base64.b64encode(np.ascontiguousarray(a).tobytes()).decode()


def i16(a, k=10):
    return b64(np.round(np.asarray(a, np.float64) * k).astype(np.int16))


def jpeg(img, q):
    buf = io.BytesIO()
    img.save(buf, 'JPEG', quality=q, optimize=True)
    return 'data:image/jpeg;base64,' + base64.b64encode(buf.getvalue()).decode()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--site', required=True)
    ap.add_argument('--tex', type=int, default=3072)
    a = ap.parse_args()
    S = json.load(open(os.path.join(a.site, 'site.json')))
    E0, N1 = S['box_nztm'][0], S['box_nztm'][3]
    SIZE = S['box_nztm'][2] - E0
    M = json.load(open(os.path.join(a.site, 'domain_model.json')))
    G = json.load(open(os.path.join(a.site, 'game_export.json')))
    L = np.load(os.path.join(a.site, 'lidar.npz'))
    dem = L['dem'].astype(np.float32)
    dem = np.where(np.isnan(dem), np.nanmedian(dem), dem)
    dsm = L['dsm'].astype(np.float32)
    dsm = np.where(np.isnan(dsm), dem, dsm)

    def to_site(gx, gz):
        lon, lat = O_LON + np.asarray(gx) / MLON, O_LAT - np.asarray(gz) / MLAT
        E, N = to_nztm.transform(lon, lat)
        return np.asarray(E) - E0, N1 - np.asarray(N)

    def to_game(x, z):  # inverse by two Newton steps on the (nearly affine) forward map
        gx, gz = np.asarray(x, np.float64) + S['centre']['game_x'] - SIZE / 2, np.asarray(z, np.float64) + S['centre']['game_z'] - SIZE / 2
        for _ in range(3):
            sx, sz = to_site(gx, gz)
            gx, gz = gx + (x - sx), gz + (z - sz)
        return gx, gz

    def game_h(t, gx, gz):  # bilinear on the exported game grid
        n, st = t['n'], t['step']
        h = np.array(t['h'], np.float32).reshape(n, n)
        fi, fj = (gx - (G['cx'] - G['r'])) / st, (gz - (G['cz'] - G['r'])) / st
        return ndimage.map_coordinates(h, [fj, fi], order=1, mode='nearest')

    # LiDAR grids at 3 m: the DEM sampled, the DSM max-pooled (tree tops survive)
    r = 3
    n = SIZE // r + 1
    idx = np.minimum(np.arange(n) * r, SIZE - 1)
    dem3 = dem[np.ix_(idx, idx)]
    dsm3 = ndimage.maximum_filter(dsm, size=r)[np.ix_(idx, idx)]

    # the game's terrain in the site frame at 10 m, and its difference to the LiDAR ground
    gr = 10
    gn = SIZE // gr + 1
    zz, xx = np.meshgrid(np.arange(gn) * gr, np.arange(gn) * gr, indexing='ij')
    gx, gz = to_game(xx.astype(np.float64), zz.astype(np.float64))
    gh_hi, gh_med = game_h(G['terrain_high'], gx, gz), game_h(G['terrain_med'], gx, gz)
    demg = ndimage.map_coordinates(dem, [np.minimum(zz, SIZE - 1), np.minimum(xx, SIZE - 1)], order=1)
    park = np.array(M['park'])
    from heights import ring_mask  # noqa: E402
    pm = ring_mask((gn, gn), [(x / gr, z / gr) for x, z in park])
    d_hi, d_med = (gh_hi - demg)[pm], (gh_med - demg)[pm]

    def at(x, z, rad=30):  # LiDAR ground (median in a disc) vs the game's at a named spot
        yy, xs = np.ogrid[:SIZE, :SIZE]
        m = (xs - x) ** 2 + (yy - z) ** 2 < rad * rad
        gxx, gzz = to_game(np.array([x], float), np.array([z], float))
        return {'lidar': round(float(np.median(dem[m])), 1), 'high': round(float(game_h(G['terrain_high'], gxx, gzz)[0]), 1),
                'medium': round(float(game_h(G['terrain_med'], gxx, gzz)[0]), 1)}

    zmax = np.unravel_index(np.argmax(np.where(ring_mask(dem.shape, park), dem, -1)), dem.shape)
    spots = {
        'crown': {**at(zmax[1], zmax[0], 10), 'x': int(zmax[1]), 'z': int(zmax[0])},
        'fields': at(700, 960, 40),
        'duckpond': at(*np.mean([p['ring'] for p in M['ponds'] if p['name'] == 'The Duckpond'][0], axis=0), 10),
        'wintergardens': at(*np.mean([b['ring'] for b in M['buildings'] if b['name'] == 'Temperate House'][0], axis=0), 30),
    }
    stats = {**M['stats'], 'spots': spots,
             'diff_high': {'mean': round(float(d_hi.mean()), 1), 'rms': round(float(np.sqrt((d_hi ** 2).mean())), 1),
                           'p5': round(float(np.percentile(d_hi, 5)), 1), 'p95': round(float(np.percentile(d_hi, 95)), 1)},
             'diff_med': {'mean': round(float(d_med.mean()), 1), 'rms': round(float(np.sqrt((d_med ** 2).mean())), 1),
                          'p5': round(float(np.percentile(d_med, 5)), 1), 'p95': round(float(np.percentile(d_med, 95)), 1)},
             'game_cell_high': G['terrain_high']['cell'], 'game_cell_med': G['terrain_med']['cell']}

    # the game's meshes in the site frame, with the per-vertex lift onto the LiDAR ground for the hero context
    gm = G['mesh']
    P = np.array(gm['pos'], np.float64).reshape(-1, 3)
    sx, sz = to_site(P[:, 0], P[:, 2])
    gy = game_h(G['terrain_high'], P[:, 0], P[:, 2])
    ly = ndimage.map_coordinates(dem, [np.clip(sz, 0, SIZE - 1), np.clip(sx, 0, SIZE - 1)], order=1)
    col = np.clip(np.array(gm['col']) ** (1 / 2.2) * 255, 0, 255).astype(np.uint8)  # linear → sRGB
    kind = np.array(gm['kind'], np.uint8)

    # trees, buildings, ponds
    data = {
        'size': SIZE, 'stats': stats,
        'dem': {'n': int(n), 'res': r, 'h': i16(dem3)}, 'dsm': {'n': int(n), 'res': r, 'h': i16(dsm3)},
        'game': {'n': int(gn), 'res': gr, 'h': i16(gh_hi), 'd': i16(gh_hi - demg)},
        'gmesh': {'pos': i16(np.stack([sx, P[:, 1], sz], 1)), 'dy': i16(ly - gy), 'col': b64(col), 'kind': b64(kind)},
        'trees': M['trees'], 'park': park.round(1).tolist(), 'museum': M['museum'],
        'buildings': [{k: b[k] for k in ('name', 'kind', 'ring', 'y0', 'y1', 'rect', 'eave', 'ridge') if k in b} for b in M['buildings']],
        'ponds': M['ponds'],
    }
    full = Image.open(os.path.join(a.site, 'aerial.jpg')).convert('RGB')
    hero_tex = jpeg(Image.open(os.path.join(a.site, 'aerial_nomuseum.jpg')).convert('RGB').resize((a.tex, a.tex), Image.LANCZOS), 80)
    # the game's high tier draws the photo at 1.25 m / px, with the museum in it
    game_tex = jpeg(full.resize((SIZE * 4 // 5, SIZE * 4 // 5), Image.LANCZOS), 82)
    shots = {}
    for side in ('sw', 'ne'):
        p = os.path.join(a.site, f'today_{side}.jpg')
        im = Image.open(p).convert('RGB')
        if side == 'sw':  # the keyboard help card covers the bottom-left
            im = im.crop((240, 0, 1280, 720))
        shots[side] = jpeg(im, 80)
    page = open(os.path.join(HERE, '..', 'examples', 'auckland-domain.html')).read()
    script = 'const DATA=' + json.dumps(data, separators=(',', ':')) + ';const AERIAL_HERO="' + hero_tex + '";const AERIAL_GAME="' + game_tex + '";'
    page = page.replace('__DATA__', script).replace('__TODAY_SW__', shots['sw']).replace('__TODAY_NE__', shots['ne'])
    out = os.path.join(a.site, 'prototype.html')
    open(out, 'w').write(page)
    print(json.dumps(stats, indent=1))
    print(out, round(len(page) / 1e6, 2), 'MB')


if __name__ == '__main__':
    import sys
    sys.path.insert(0, os.path.join(HERE, '..'))
    main()
