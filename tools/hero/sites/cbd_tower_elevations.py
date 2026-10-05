"""
F35-A — hero buildings: face-aligned elevations of the CBD tower kit's towers from Auckland Council's 2023 textured 3D
mesh (CC BY 4.0; tools/hero/mesh3d.py), for writing a tower's skin (src/core/cbdTowerSkins.ts): what each face really
has (crown bands, glass strips, pilasters, bracing, signs) and where, in metres.

For each tower: the mesh inside its outline + 2 m as coloured points; the shaft's box (its upper terraces, turned to the
length²-weighted mode of their edge directions: shapely's minimum rotated rectangle picked a 45° box for the HSBC
Tower); then one orthographic elevation per box face, 0.2 m a pixel, nearest point last, gaps filled from the nearest
sample and a 3 px median (the mesh texture is speckled). Each elevation has a 5 m tick grid: heights up the left
(mesh m above the mesh's ground), t across the bottom (0, green, is the box's centre line; t grows to the right as seen
from outside, as in the skin), green marks at the top at the box face's ends.

  # the kit's towers as JSON (outline, parts) from the generated TypeScript:
  npx esbuild src/core/cbdTowersData.ts --bundle --format=esm --platform=node --outfile=/tmp/hero/cbd/towers.mjs
  node -e "import('/tmp/hero/cbd/towers.mjs').then(m=>require('fs').writeFileSync('/tmp/hero/cbd/towers.json',JSON.stringify(m.CBD_TOWERS)))"
  python3 tools/hero/sites/cbd_tower_elevations.py --towers /tmp/hero/cbd/towers.json --out /tmp/hero/cbd/elev 11 7 4
  python3 tools/hero/sites/cbd_tower_elevations.py --out /tmp/hero/cbd/elev --colour 11,17,-20,-8,20,80[,hi|lo|all]

Writes <out>/<n>_faces.jpg (all four faces), <n>_f<heading>.npy (each face, for --colour), boxes.json (the box of each
tower: paste x, z, face into the skin). --colour prints the white-balanced median colour of a zone: tower, face heading,
t0, t1, h0, h1 and the brighter half (hi, default: the sunlit side, as cbd_towers_colours.py), the darker or all.
Mesh heights are the mesh's own: compare the main roof with the kit's terraces and set the skin's dy (up to 12 m apart).
~25 s a tower for the mesh (cached in /tmp/hero/_i3s), seconds for the elevations.
"""
import argparse, json, math, os, sys

import numpy as np
from PIL import Image, ImageDraw
from pyproj import Transformer
from scipy import ndimage
from shapely import affinity
from shapely.geometry import Polygon
from shapely.ops import unary_union

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..'))
sys.path.insert(0, HERE)
from mesh3d import sample_points  # noqa: E402
from cbd_towers_colours import ORIGIN, MLAT, MLON, nztm  # noqa: E402

PX = 0.2
WB = np.array([1.041, 1.056, 0.916])  # cbd_towers_colours.py's gray-world gains for the walls
inv = Transformer.from_crs(2193, 4326, always_xy=True)


def shaft_box(t):
    """Centre (game m) and the 4 faces (normal, length, heading) of the box round the tower's upper terraces."""
    parts = [p for p in t['parts'] if p['kind'] != 'spire']
    top = max(p['h'] for p in parts)
    sh = unary_union([Polygon(np.array(p['ring']).reshape(-1, 2)) for p in parts if p['kind'] in ('shaft', 'crown') and p['h'] > 0.6 * top])
    hist = np.zeros(90)
    for g in getattr(sh, 'geoms', [sh]):
        q = np.array(g.exterior.coords)
        for a, b in zip(q[:-1], q[1:]):
            dx, dz = b - a
            hist[int(math.degrees(math.atan2(dz, dx)) % 90)] += math.hypot(dx, dz) ** 2
    hist = np.convolve(np.r_[hist[-1:], hist, hist[:1]], np.ones(3), 'valid')
    ang = math.radians(int(np.argmax(hist)))
    rect = affinity.rotate(affinity.rotate(sh, -ang, origin=(0, 0), use_radians=True).envelope, ang, origin=(0, 0), use_radians=True)
    cx, cz = rect.centroid.x, rect.centroid.y
    pts = np.array(rect.exterior.coords)[:4]
    faces = []
    for i in range(4):
        a, b = pts[i], pts[(i + 1) % 4]
        mx, mz = (a + b) / 2
        nx, nz = mx - cx, mz - cz
        ln = math.hypot(nx, nz)
        faces.append(dict(nx=nx / ln, nz=nz / ln, L=math.hypot(*(b - a)), hd=(math.degrees(math.atan2(nx, -nz)) + 360) % 360))
    return cx, cz, top, sorted(faces, key=lambda f: f['hd'])


def elevations(t, out):
    o = t['outline']
    poly = Polygon([nztm(o[i], o[i + 1]) for i in range(0, len(o), 2)]).buffer(2)
    E0, N1 = 1750000, 5930000
    x, z, y, c = sample_points({'box_nztm': [E0, 5900000, 1770000, N1]}, poly, px=0.12)
    lon, lat = inv.transform(x + E0, N1 - z)
    X, Z = (lon - ORIGIN[1]) * MLON, -(lat - ORIGIN[0]) * MLAT
    h = y - np.percentile(y, 1)
    cx, cz, top, faces = shaft_box(t)
    ims = []
    for f in faces:
        rx, rz = f['nz'], -f['nx']
        u = (X - cx) * rx + (Z - cz) * rz
        dd = -((X - cx) * f['nx'] + (Z - cz) * f['nz'])
        lim = f['L'] / 2 + 6
        k = np.abs(u) < lim
        W, H = int(2 * lim / PX) + 1, int((top + 10) / PX) + 1
        iu, iv = ((u[k] + lim) / PX).astype(int), (H - 1 - h[k] / PX).astype(int)
        ok = (iv >= 0) & (iv < H) & (iu >= 0) & (iu < W)
        order = np.argsort(-dd[k][ok])
        img = np.zeros((H, W, 3), np.uint8)
        seen = np.zeros((H, W), bool)
        img[iv[ok][order], iu[ok][order]] = c[k][ok][order]
        seen[iv[ok][order], iu[ok][order]] = True
        dist, (ii, jj) = ndimage.distance_transform_edt(~seen, return_indices=True)
        img = img[ii, jj]
        img[dist > 4] = 255
        img = np.stack([ndimage.median_filter(img[..., q], size=3) for q in range(3)], -1)
        np.save(f"{out}/{t['n']}_f{int(round(f['hd']))}.npy", img)
        im = Image.fromarray(img)
        dr = ImageDraw.Draw(im)
        for yy in range(0, int(top) + 10, 10):
            r = H - 1 - yy / PX
            dr.line([(0, r), (12, r)], fill=(255, 0, 0))
            dr.text((14, r - 6), str(yy), fill=(255, 0, 0))
        for tt in range(-int(lim) // 5 * 5, int(lim), 5):
            col = W // 2 + tt / PX
            dr.line([(col, H - 10), (col, H - 1)], fill=(255, 0, 0) if tt else (0, 160, 0))
        for s in (-1, 1):
            col = (lim + s * f['L'] / 2) / PX
            dr.line([(col, 0), (col, 30)], fill=(0, 160, 0), width=2)
        ims.append((f, im))
    Hh = max(i.height for _, i in ims)
    sheet = Image.new('RGB', (sum(i.width for _, i in ims) + 12 * len(ims), Hh + 22), 'white')
    dr = ImageDraw.Draw(sheet)
    xx = 0
    for f, i in ims:
        sheet.paste(i, (xx, 22))
        dr.text((xx + 2, 4), f"{t['name']} face {f['hd']:.0f} L={f['L']:.1f}", fill=(0, 0, 0))
        xx += i.width + 12
    sheet.save(f"{out}/{t['n']}_faces.jpg", quality=90)
    return dict(name=t['name'], x=round(cx, 2), z=round(cz, 2), top=top, faces=[{k: round(v, 3) for k, v in f.items()} for f in faces])


def colour(out, boxes, spec):
    p = spec.split(',')
    n, hd, t0, t1, h0, h1 = p[0], float(p[1]), *map(float, p[2:6])
    half = p[6] if len(p) > 6 else 'hi'
    f = min(boxes[n]['faces'], key=lambda f: abs((f['hd'] - hd + 180) % 360 - 180))
    img = np.load(f"{out}/{n}_f{int(round(f['hd']))}.npy").astype(float)
    H, lim = img.shape[0], f['L'] / 2 + 6
    sl = img[int(H - 1 - h1 / PX):int(H - 1 - h0 / PX), int((t0 + lim) / PX):int((t1 + lim) / PX)].reshape(-1, 3)
    sl = sl[sl.min(1) < 250] * WB
    lum = sl @ [0.299, 0.587, 0.114]
    s = sl[lum >= np.median(lum)] if half == 'hi' else sl[lum < np.median(lum)] if half == 'lo' else sl
    return '#%02x%02x%02x' % tuple(int(v) for v in np.clip(np.median(s, 0), 0, 255))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--towers', default='/tmp/hero/cbd/towers.json')
    ap.add_argument('--out', default='/tmp/hero/cbd/elev')
    ap.add_argument('--colour', action='append', default=[], help='n,face,t0,t1,h0,h1[,hi|lo|all]')
    ap.add_argument('rows', nargs='*', type=int)
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    bpath = f'{a.out}/boxes.json'
    boxes = json.load(open(bpath)) if os.path.exists(bpath) else {}
    if a.rows:
        towers = {t['n']: t for t in json.load(open(a.towers))}
        for n in a.rows:
            boxes[str(n)] = elevations(towers[n], a.out)
            b = boxes[str(n)]
            print(n, b['name'], 'box', b['x'], b['z'], 'faces', [(round(f['hd']), round(f['L'], 1)) for f in b['faces']], flush=True)
        json.dump(boxes, open(bpath, 'w'), indent=1)
    for s in a.colour:
        print(s, colour(a.out, boxes, s))


if __name__ == '__main__':
    main()
