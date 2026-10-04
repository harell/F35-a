"""
F35-A — hero buildings: wall colours of the CBD tower kit's towers (issue #156) from Auckland Council's 2023 textured 3D
mesh ("Auckland CBD to Airport 3D Mesh", zone 1A, 6 cm texture; CC BY 4.0; see tools/hero/mesh3d.py), measured, not
picked: for each tower the wall triangles (normal within 17° of horizontal) inside its outline + 2 m are sampled into
texels, split into the shaft (above 40 % of its height, below the top 4 m) and the podium (3–12 m), and each part's
colour is the median of its brighter half (the sunlit faces; the shaded half is the same material darker). The mesh's
textures carry a blue-violet haze (CBD walls average R 158, G 156, B 181), so the colours are white-balanced over the
whole set (gray world: per-channel gains that make the mean wall, and apart the mean podium, neutral); the raw values stay as wall_raw / podium_raw.

  python3 tools/hero/sites/cbd_towers.py --site /tmp/hero/cbd          # → <site>/towers.json (outlines, heights)
  python3 tools/hero/sites/cbd_towers_colours.py --site /tmp/hero/cbd  # → tools/hero/sites/cbd_towers_style.json

Only the nodes over the towers are fetched, kept in memory (the whole CBD is thousands of 2 MB nodes). Hand-set keys in
the style file (facade, crown…) are kept; `wall` and `podium` are overwritten unless `"lock": true`.
"""
import argparse, json, math, os, sys
from concurrent.futures import ThreadPoolExecutor

import numpy as np
from PIL import Image
from io import BytesIO
from pyproj import Transformer
from shapely import contains_xy
from shapely.geometry import Polygon

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..'))
from mesh3d import SERVICE, crawl, get  # noqa: E402

ORIGIN = (-36.8485, 174.7622)
MLAT = 110_950
MLON = 111_320 * math.cos(math.radians(ORIGIN[0]))
to_nztm = Transformer.from_crs(4326, 2193, always_xy=True)


def nztm(x, z):
    return to_nztm.transform(ORIGIN[1] + x / MLON, ORIGIN[0] - z / MLAT)


def node_points(base, n, area, rng):
    """Texel samples (E, N, h, rgb) of the wall triangles of one node inside `area`."""
    r, m = n['mesh']['geometry']['resource'], n['mesh']['material']['resource']
    b = get(f'{base}/nodes/{r}/geometries/0')
    tex = np.asarray(Image.open(BytesIO(get(f'{base}/nodes/{m}/textures/0'))).convert('RGB'))
    nv = int(np.frombuffer(b[:4], np.uint32)[0])
    o = 8
    P = np.frombuffer(b[o:o + nv * 12], np.float32).reshape(-1, 3).astype(np.float64) + n['obb']['center']
    o += nv * 24
    UV = np.frombuffer(b[o:o + nv * 8], np.float32).reshape(-1, 2)
    T, TU = P.reshape(-1, 3, 3), UV.reshape(-1, 3, 2)
    cen = T.mean(1)
    k = contains_xy(area, cen[:, 0], cen[:, 1])
    T, TU = T[k], TU[k]
    if not len(T):
        return None
    nrm = np.cross(T[:, 1] - T[:, 0], T[:, 2] - T[:, 0])
    ln = np.linalg.norm(nrm, axis=1) + 1e-9
    wall = np.abs(nrm[:, 2] / ln) < 0.3
    T, TU, ab = T[wall], TU[wall], ln[wall] / 2
    if not len(T):
        return None
    cnt = np.clip(np.ceil(ab * 4).astype(int), 1, 400)
    idx = np.repeat(np.arange(len(T)), cnt)
    r1, r2 = rng.random(len(idx)), rng.random(len(idx))
    s = np.sqrt(r1)
    w = np.stack([1 - s, s * (1 - r2), s * r2], 1)
    p = (w[:, :, None] * T[idx]).sum(1)
    uv = (w[:, :, None] * TU[idx]).sum(1)
    H, W = tex.shape[:2]
    c = tex[np.clip((uv[:, 1] % 1) * H, 0, H - 1).astype(int), np.clip((uv[:, 0] % 1) * W, 0, W - 1).astype(int)]
    return p, c


def side_views(P, C, g, top, path, name):
    """Two orthographic elevations (from the south and the east), 0.25 m/px, side by side, for picking a facade."""
    from PIL import ImageDraw
    os.makedirs(os.path.dirname(path), exist_ok=True)
    px = 0.25
    out = []
    for u, d in ((P[:, 0], -P[:, 1]), (-P[:, 1], -P[:, 0])):  # south: x across, depth north; east: −y across, depth −x
        u0 = np.percentile(u, 0.5)
        W = int((np.percentile(u, 99.5) - u0) / px) + 1
        H = int((top + 6) / px) + 1
        iu, iv = ((u - u0) / px).astype(int), (H - 1 - (P[:, 2] - g) / px).astype(int)
        ok = (iu >= 0) & (iu < W) & (iv >= 0) & (iv < H)
        o = np.argsort(-d[ok])  # far first, near last
        img = np.full((H, W, 3), 255, np.uint8)
        img[iv[ok][o], iu[ok][o]] = C[ok][o]
        out.append(Image.fromarray(img))
    h = max(i.height for i in out)
    sheet = Image.new('RGB', (sum(i.width for i in out) + 10, h + 16), (255, 255, 255))
    x = 0
    for i in out:
        sheet.paste(i, (x, 16 + h - i.height))
        x += i.width + 10
    ImageDraw.Draw(sheet).text((2, 2), name, fill=(0, 0, 0))
    sheet.thumbnail((900, 900))
    sheet.save(path, quality=85)


def colour(c):
    if len(c) < 200:
        return None
    lum = c @ np.array([0.299, 0.587, 0.114])
    hi = c[lum >= np.median(lum)]
    return '#%02x%02x%02x' % tuple(int(v) for v in np.median(hi, axis=0))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--site', default='/tmp/hero/cbd')
    ap.add_argument('--out', default=os.path.join(HERE, 'cbd_towers_style.json'))
    ap.add_argument('--zone', default='1A')
    ap.add_argument('--only', default='')
    ap.add_argument('--tiers', default='')
    ap.add_argument('--views', default='', help='folder: also write a side view of each tower (<n>.jpg) to pick its facade by eye')
    a = ap.parse_args()
    towers = json.load(open(f'{a.site}/towers.json'))
    only = {int(x) for x in a.only.split(',') if x}
    styles = json.load(open(a.out)) if os.path.exists(a.out) else {}
    base = SERVICE.format(zone=a.zone)
    rng = np.random.default_rng(7)
    for t in towers:
        if (only and t['n'] not in only) or (a.tiers and t['tier'] not in a.tiers.split(',')):
            continue
        o = t['outline']
        poly = Polygon([nztm(o[i], o[i + 1]) for i in range(0, len(o), 2)]).buffer(2)
        top = max(p['h'] for p in t['parts'])
        try:
            leaves = crawl(base, poly.bounds)
            with ThreadPoolExecutor(8) as ex:
                res = [r for r in ex.map(lambda n: node_points(base, n, poly, rng), leaves) if r is not None]
        except Exception as e:  # noqa: BLE001 — a node that won't load: keep the defaults
            print(t['n'], t['name'], 'failed', e)
            continue
        if not res:
            print(t['n'], t['name'], 'no mesh')
            continue
        P = np.concatenate([r[0] for r in res])
        C = np.concatenate([r[1] for r in res])
        g = float(np.percentile(P[:, 2], 1))
        h = P[:, 2] - g
        if a.views:
            side_views(P, C, g, top, f"{a.views}/{t['n']}.jpg", t['name'])
        st = styles.setdefault(str(t['n']), {})
        st['name'] = t['name']
        if not st.get('lock'):
            wc = colour(C[(h > 0.4 * top) & (h < top - 4)])
            pc = colour(C[(h > 3) & (h < 12)])
            if wc:
                st['wall_raw'] = wc
            if pc:
                st['podium_raw'] = pc
        print(t['n'], t['name'], len(leaves), 'nodes', st.get('wall_raw'), st.get('podium_raw'), flush=True)
        json.dump(styles, open(a.out, 'w'), indent=1, ensure_ascii=False)
    balance(styles)
    json.dump(styles, open(a.out, 'w'), indent=1, ensure_ascii=False)


def balance(styles):
    """Gray-world white balance of the raw mesh colours, walls and podiums apart (the podiums, in the streets' shade, carry
    more of the haze): wall / podium = raw × that set's per-channel gains."""
    rgb = lambda h: np.array([int(h[i:i + 2], 16) for i in (1, 3, 5)], float)
    for k in ('wall', 'podium'):
        raws = np.array([rgb(v[f'{k}_raw']) for v in styles.values() if f'{k}_raw' in v])
        mean = raws.mean(0)
        gain = mean.mean() / mean
        print(k, 'white balance gains', np.round(gain, 3))
        for v in styles.values():
            if not v.get('lock') and f'{k}_raw' in v:
                v[k] = '#%02x%02x%02x' % tuple(int(c) for c in np.clip(rgb(v[f'{k}_raw']) * gain, 0, 255))


if __name__ == '__main__':
    main()
