"""
F35-A — bake the Tāmaki Drive waterfront model (tools/hero/sites/tamaki_drive.py → model.json) into the game's
src/world/scenery/data/tamaki-waterfront.bin (gzip), in game XZ (origin the Sky Tower, lat/lon-linear) and metres above
the datum. Decoded by src/world/scenery/tamakiWaterfront.ts.

  python3 tools/hero/sites/tamaki_drive_bake.py [--out /tmp/hero/tamaki] [--dst src/world/scenery/data/tamaki-waterfront.bin]

Besides the model's parts it bakes the "fill": per 5 m section the real ground from the seawall crest (or the harbour-most
path) to 3 m past the land-side path. The game's terrain is coarse and has the Hobson Bay causeway as sea; the game draws
the fill only where it has water, sloping its land edge down to its own ground.

Format (little-endian): 'AKTW' | u32 version | then six blocks, each u32 count + records:
  polylines (paths, road, fill):  u8 kind, u8 surface, u16 n, f32 x0, f32 z0, then n × (i16 dx, i16 dz in cm from the
                                  previous point, i16 y cm, u8 width dm)
  walls:      u8 kind, u16 n, f32 x0, f32 z0, n × (i16 dx, i16 dz cm crest, i16 yc cm, i16 tx, i16 tz cm toe − crest, i16 yt cm)
  rails:      u16 n, f32 x0, f32 z0, n × (i16 dx, i16 dz cm, i16 y cm)
  lamps:      f32 x, f32 z, i16 ground cm, i16 top cm, i8 hx, i8 hz (dm, the head's offset from the shaft)
  trees:      f32 x, f32 z, i16 ground cm, u16 height cm, u8 radius dm, u8 r, g, b (sRGB), u8 palm
"""
import argparse, gzip, json, math, os, struct, sys

import numpy as np
from scipy.ndimage import map_coordinates, median_filter, uniform_filter1d

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import tamaki_drive as td  # noqa: E402

KIND = {'SP': 1, 'CY': 2, 'FW': 3, 'road': 4, 'fill': 5}
SURF = {'asphalt': 0, 'concrete': 1, 'paving': 2, 'grass': 3, 'road': 4}
WALL = {'rock': 0, 'concrete': 1, 'low': 2}
VERSION = 1


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default='/tmp/hero/tamaki')
    ap.add_argument('--dst', default=os.path.join(os.path.dirname(__file__), '..', '..', '..', 'src', 'world', 'scenery', 'data', 'tamaki-waterfront.bin'))
    a = ap.parse_args()
    M = json.load(open(f'{a.out}/model.json')); E0, N1 = M['meta']['E0'], M['meta']['N1']
    rows = json.load(open(f'{a.out}/measure.json'))
    F = td.Frame(a.out)
    L = np.load(f'{a.out}/lidar.npz'); dem = np.nan_to_num(L['dem'], nan=td.WATER); BE0, BN0, BE1, BN1 = L['box']

    def game(x, z):
        """Site frame (x = E − E0, z = N1 − N) → game XZ."""
        E = np.asarray(x, float) + E0; N = N1 - np.asarray(z, float)
        lon, lat = td.hs.to_wgs.transform(E, N)
        return (np.asarray(lon) - td.hs.ORIGIN[1]) * td.hs.MLON, -(np.asarray(lat) - td.hs.ORIGIN[0]) * td.hs.MLAT

    def demAt(E, N):
        return map_coordinates(dem, [np.atleast_1d(BN1 - np.asarray(N) - .5), np.atleast_1d(np.asarray(E) - BE0 - .5)], order=1)

    out = bytearray(b'AKTW') + struct.pack('<I', VERSION)
    cm = lambda v: int(np.clip(round(v * 100), -32767, 32767))

    def poly(kind, surf, pts, w):
        gx, gz = game([p[0] for p in pts], [p[1] for p in pts])
        b = struct.pack('<BBHff', kind, surf, len(pts), float(gx[0]), float(gz[0]))
        px, pz = gx[0], gz[0]
        for i, p in enumerate(pts):
            dx, dz = cm(gx[i] - px), cm(gz[i] - pz); px += dx / 100; pz += dz / 100
            b += struct.pack('<hhhB', dx, dz, cm(p[2]), int(np.clip(round(w[i] * 10), 0, 255)))
        return b

    # ── polylines: paths, the road (its floor for the game's ribbon), the fill ──
    polys = []
    for r in M['ribbons']:
        polys.append(poly(KIND[r['kind']], SURF.get(r['surface'], 0), r['pts'], r['w']))
    for r in M['road']:
        polys.append(poly(KIND['road'], SURF['road'], r['pts'], r['w']))
    # fill: from the harbour edge (crest, else the harbour-most path's outer edge) to the land's edge
    lo, hi, ys = [], [], []
    for i, q in enumerate(rows):
        P, n = F.X[i], F.N[i]
        h_edges = [p['e'][0] for p in q['paths'] if p['c'] < 0]
        a_ = q['wall']['crest'] if q['wall'] else (min(h_edges) if h_edges else (q['rd'][0] - 7 if q['rd'] else -8))
        l_edges = [p['e'][1] for p in q['paths'] if p['c'] > 0]
        b_ = max(l_edges) if l_edges else (q['rd'][1] + 7 if q['rd'] else 8)
        b_ += 3.0   # the verge past the land-side path; the game slopes the fill's edges down to its own ground
        lo.append(a_); hi.append(b_)
        oo = np.linspace(a_, b_, 9)
        ys.append(float(np.median(demAt(P[0] + oo * n[0], P[1] + oo * n[1]))))
    lo = median_filter(np.array(lo), 5, mode='nearest'); hi = median_filter(np.array(hi), 5, mode='nearest'); ys = uniform_filter1d(np.array(ys), 3, mode='nearest')
    cen = (lo + hi) / 2; wid = np.clip(hi - lo, 0, 25.5)
    E, N = F.xy(F.S, cen); x, z = E - E0, N1 - N
    fill = [[float(a), float(b), float(c)] for a, b, c in zip(x, z, ys)]
    polys.append(poly(KIND['fill'], SURF['grass'], fill, wid))
    out += struct.pack('<I', len(polys)) + b''.join(polys)

    # ── walls ──
    walls = []
    for w in M['walls']:
        C, T = w['crest'], w['toe']
        gx, gz = game([p[0] for p in C], [p[1] for p in C]); tx, tz = game([p[0] for p in T], [p[1] for p in T])
        b = struct.pack('<BHff', WALL[w['kind']], len(C), float(gx[0]), float(gz[0]))
        px, pz = gx[0], gz[0]
        for i in range(len(C)):
            dx, dz = cm(gx[i] - px), cm(gz[i] - pz); px += dx / 100; pz += dz / 100
            b += struct.pack('<hhhhhh', dx, dz, cm(C[i][2]), cm(tx[i] - gx[i]), cm(tz[i] - gz[i]), cm(T[i][2]))
        walls.append(b)
    out += struct.pack('<I', len(walls)) + b''.join(walls)

    # ── rails ──
    rails = []
    for r in M['rails']:
        P = r['pts']; gx, gz = game([p[0] for p in P], [p[1] for p in P])
        b = struct.pack('<Hff', len(P), float(gx[0]), float(gz[0])); px, pz = gx[0], gz[0]
        for i in range(len(P)):
            dx, dz = cm(gx[i] - px), cm(gz[i] - pz); px += dx / 100; pz += dz / 100
            b += struct.pack('<hhh', dx, dz, cm(P[i][2]))
        rails.append(b)
    out += struct.pack('<I', len(rails)) + b''.join(rails)

    # ── lamps (head offset turned into game XZ through the local frame's own axes) ──
    lamps = b''
    for l in M['lamps']:
        x, z, g, top, hx, hz = l
        gx, gz = game([x, x + hx], [z, z + hz])
        lamps += struct.pack('<ffhhbb', float(gx[0]), float(gz[0]), cm(g), cm(top),
                             int(np.clip(round((gx[1] - gx[0]) * 10), -127, 127)), int(np.clip(round((gz[1] - gz[0]) * 10), -127, 127)))
    out += struct.pack('<I', len(M['lamps'])) + lamps

    # ── trees ──
    trees = b''
    for t in M['trees']:
        x, z, g, top, r, cr, cg, cb, palm = t
        gx, gz = game([x], [z])
        trees += struct.pack('<ffhHBBBBB', float(gx[0]), float(gz[0]), cm(g), int(np.clip(round((top - g) * 100), 0, 65535)),
                             int(np.clip(round(r * 10), 0, 255)), cr, cg, cb, int(palm))
    out += struct.pack('<I', len(M['trees'])) + trees

    os.makedirs(os.path.dirname(os.path.abspath(a.dst)), exist_ok=True)
    gz_ = gzip.compress(bytes(out), 9, mtime=0)
    open(a.dst, 'wb').write(gz_)
    print(f'{len(polys)} polylines, {len(walls)} walls, {len(rails)} rails, {len(M["lamps"])} lamps, {len(M["trees"])} trees; '
          f'{len(out) // 1024} kB raw, {len(gz_) // 1024} kB gzip → {os.path.relpath(a.dst)}')


if __name__ == '__main__':
    main()
