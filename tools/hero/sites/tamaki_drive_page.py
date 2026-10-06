"""
F35-A — the review page for the Tāmaki Drive waterfront model (tools/hero/sites/tamaki_drive.py → model.json).

Five segments along the drive, each a 3D scene of its own: the LiDAR (DSM draped with the 7.5 cm aerial), the model
on the LiDAR ground, the two together, and the game today from the same camera (a screenshot, see --today).

  python3 tools/hero/sites/tamaki_drive_page.py [--out /tmp/hero/tamaki] [--today <dir of seg_<id>.jpg>]
      → <out>/prototype.html (publish as a private Artifact)
  python3 tools/hero/sites/tamaki_drive_page.py --cameras   # prints each segment's camera in game metres

The page template is tools/hero/examples/tamaki-drive.html; this fills its data placeholder.
"""
import argparse, base64, io, json, math, os, sys

import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import tamaki_drive as td  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
TEMPLATE = os.path.join(HERE, '..', 'examples', 'tamaki-drive.html')
# (id, title, chainage from, to, blurb)
SEGMENTS = [
    ('causeway', 'Hobson Bay causeway', 380, 1020,
     'Paths on both sides of the road. Harbour side: a concrete promenade on top of the basalt revetment, a grass verge with pōhutukawa and lamps, then the two-way Tāmaki Drive Cycleway against the kerb. Land side: the Tāmaki Drive Shared Path under a second tree row, then the rail line.'),
    ('ngapipi', 'Ngapipi bridge to Okahu Bay', 1880, 2520,
     'The shared path moves to the harbour side here. The bridge over the Hobson Bay outlet has no seawall, and the revetment starts again at Okahu Bay.'),
    ('orakei', 'Orakei and Kelly Tarlton’s', 3560, 4200,
     'A single wide asphalt shared path on the crest of the seawall, with lamps on its inner edge. Bikes on the road get painted green lanes. Under the cliff the land side has no footpath.'),
    ('missionbay', 'Mission Bay', 5640, 6280,
     'The seawall turns from rock to a stepped concrete face. A wide footpath runs in front of the apartments, and palms stand at the reserve.'),
    ('kohimarama', 'Kohimarama beach', 6800, 7440,
     'The shared path runs along the beach on a low wall, with the Phoenix palms on the land side and the concrete seawall again past the boat ramp.'),
]
MARGIN = 75   # m either side of the axis kept in each scene
GRID = 1.0    # m, LiDAR grid in the page
AER = 0.3     # m/px, aerial in the page


def b64(a):
    return base64.b64encode(np.ascontiguousarray(a).tobytes()).decode()


def jpg_uri(img, q=80):
    buf = io.BytesIO(); img.save(buf, 'JPEG', quality=q)
    return 'data:image/jpeg;base64,' + base64.b64encode(buf.getvalue()).decode()


def game_xz(E, N):
    """NZTM → game metres (origin Sky Tower, lat/lon-linear, as tools/hero/site.py)."""
    lon, lat = td.hs.to_wgs.transform(E, N)
    return (lon - td.hs.ORIGIN[1]) * td.hs.MLON, -(lat - td.hs.ORIGIN[0]) * td.hs.MLAT


def camera(F, s0, s1):
    """From the harbour, low: 230 m seaward of the segment's middle, 55 m up, looking at the axis."""
    sm = (s0 + s1) / 2
    E, N = F.xy(sm, 0.0); Ec, Nc = F.xy(sm, -230.0)
    return (float(E), float(N)), (float(Ec), float(Nc))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default='/tmp/hero/tamaki')
    ap.add_argument('--today', default=None)
    ap.add_argument('--cameras', action='store_true')
    a = ap.parse_args()
    F = td.Frame(a.out)
    if a.cameras:
        for sid, title, s0, s1, _ in SEGMENTS:
            (E, N), (Ec, Nc) = camera(F, s0, s1)
            gx, gz = game_xz(E, N); cx, cz = game_xz(Ec, Nc)
            print(sid, round(gx, 1), round(gz, 1), round(cx, 1), round(cz, 1))
        return
    M = json.load(open(f'{a.out}/model.json')); E0, N1 = M['meta']['E0'], M['meta']['N1']
    L = np.load(f'{a.out}/lidar.npz'); dsm = np.nan_to_num(L['dsm'], nan=td.WATER); dem = np.nan_to_num(L['dem'], nan=td.WATER)
    aer = td.Aerial(a.out)
    segs = []
    for sid, title, s0, s1, blurb in SEGMENTS:
        s = np.arange(s0, s1 + 1, 5.0)
        corners = []
        for o in (-MARGIN, MARGIN):
            E, N = F.xy(s, np.full_like(s, o)); corners += list(zip(E, N))
        Es, Ns = zip(*corners)
        e0, e1 = math.floor(min(Es)), math.ceil(max(Es)); n0, n1 = math.floor(min(Ns)), math.ceil(max(Ns))
        x0, z0 = e0 - E0, N1 - n1                                   # local frame of the box's NW corner
        W, H = int((e1 - e0) / GRID), int((n1 - n0) / GRID)
        r0, c0 = int(L['box'][3] - n1), int(e0 - L['box'][0])
        g = dem[r0:r0 + H, c0:c0 + W]; d = dsm[r0:r0 + H, c0:c0 + W]
        # keep only the band within MARGIN of the axis (the rest is the next suburb or open water)
        cc, rr = np.meshgrid(e0 + np.arange(W) + .5, n1 - np.arange(H) - .5)
        ss, oo = F.so(np.c_[cc.ravel(), rr.ravel()])
        keep = ((np.abs(oo) < MARGIN) & (ss >= s0 - 2) & (ss <= s1 + 2)).reshape(H, W)
        ii = (lambda v: np.where(keep, np.round(v * 100), -32768).astype(np.int16))
        # aerial over the box at AER m/px
        ew, nh = int((e1 - e0) / AER), int((n1 - n0) / AER)
        EE, NN = np.meshgrid(e0 + (np.arange(ew) + .5) * AER, n1 - (np.arange(nh) + .5) * AER)
        img = Image.fromarray(aer(EE, NN).astype(np.uint8))
        bx = (x0, z0, x0 + W * GRID, z0 + H * GRID)

        def inside(x, z, pad=2):
            return bx[0] - pad <= x <= bx[2] + pad and bx[1] - pad <= z <= bx[3] + pad

        def cut(pts, key=lambda p: (p[0], p[1])):
            ok = [i for i, p in enumerate(pts) if inside(*key(p))]
            return (ok[0], ok[-1] + 1) if ok else None
        sub = {'ribbons': [], 'road': [], 'walls': [], 'rails': []}
        for k in ('ribbons', 'road'):
            for r in M[k]:
                c = [i for i, v in enumerate(r['s']) if s0 - 5 <= v <= s1 + 5]
                if len(c) > 1:
                    i, j = c[0], c[-1] + 1
                    sub[k].append({**{kk: vv for kk, vv in r.items() if kk not in ('s', 'o', 'w', 'pts')}, 'w': r['w'][i:j], 'pts': r['pts'][i:j]})
        for w in M['walls']:
            c = [i for i, v in enumerate(w['s']) if s0 - 5 <= v <= s1 + 5]
            if len(c) > 1:
                i, j = c[0], c[-1] + 1
                sub['walls'].append({'kind': w['kind'], 'rgb': w['rgb'], 'crest': w['crest'][i:j], 'toe': w['toe'][i:j]})
        for r in M['rails']:
            ab = cut(r['pts'])
            if ab and ab[1] - ab[0] > 1:
                sub['rails'].append({'h': r['h'], 'pts': r['pts'][ab[0]:ab[1]]})
        lamps = [l for l in M['lamps'] if inside(l[0], l[1], 0) and keep[int(np.clip(l[1] - z0, 0, H - 1)), int(np.clip(l[0] - x0, 0, W - 1))]]
        trees = [t for t in M['trees'] if inside(t[0], t[1], 0) and keep[int(np.clip(t[1] - z0, 0, H - 1)), int(np.clip(t[0] - x0, 0, W - 1))]]
        (E, N), (Ec, Nc) = camera(F, s0, s1)
        today = None
        if a.today and os.path.exists(f'{a.today}/seg_{sid}.jpg'):
            today = jpg_uri(Image.open(f'{a.today}/seg_{sid}.jpg').convert('RGB'), 78)
        segs.append({'id': sid, 'title': title, 'blurb': blurb, 's': [s0, s1], 'box': bx, 'W': W, 'H': H, 'res': GRID,
                     'dem': b64(ii(g)), 'dsm': b64(ii(d)), 'aerial': jpg_uri(img), 'today': today,
                     'cam': {'look': [E - E0, N1 - N], 'from': [Ec - E0, N1 - Nc]},
                     'counts': {'lamps': len(lamps), 'trees': len(trees), 'palms': sum(t[-1] for t in trees)},
                     **sub, 'lamps': lamps, 'trees': trees})
        print(sid, W, H, len(lamps), 'lamps', len(trees), 'trees')
    data = {'meta': M['meta'], 'segments': segs, 'ledger': ledger(M), 'axis': M['axis'], 'strip': M['strip'][::3]}
    html = open(TEMPLATE).read().replace('__DATA__', 'const DATA = ' + json.dumps(data, separators=(',', ':')) + ';')
    open(f'{a.out}/prototype.html', 'w').write(html)
    print('prototype.html', os.path.getsize(f'{a.out}/prototype.html') // 1024, 'kB')


def ledger(M):
    from shapely.geometry import LineString

    def km(rs):
        return round(sum(LineString([(p[0], p[1]) for p in r['pts']]).length for r in rs if len(r['pts']) > 1) / 1000, 2)
    rows = []
    for k, side, name in (('FW', -1, 'Promenade footpath, harbour side'), ('CY', -1, 'Tāmaki Drive Cycleway, harbour side'),
                          ('SP', -1, 'Tāmaki Drive Shared Path, harbour side'), ('SP', 1, 'Tāmaki Drive Shared Path, land side'),
                          ('FW', 1, 'Footpath, land side')):
        rs = [r for r in M['ribbons'] if r['kind'] == k and r['side'] == side]
        if rs:
            rows.append({'what': name, 'len': km(rs), 'w': round(float(np.median(np.concatenate([r['w'] for r in rs]))), 1)})
    walls = []
    for k, name in (('rock', 'Rock revetment (basalt)'), ('concrete', 'Concrete seawall'), ('low', 'Low beach wall')):
        ws = [w for w in M['walls'] if w['kind'] == k]
        if ws:
            dr = np.concatenate([[c[2] - t[2] for c, t in zip(w['crest'], w['toe'])] for w in ws])
            run = np.concatenate([[math.dist(c[:2], t[:2]) for c, t in zip(w['crest'], w['toe'])] for w in ws])
            walls.append({'what': name, 'len': round(sum(LineString([(p[0], p[1]) for p in w['crest']]).length for w in ws) / 1000, 2),
                          'drop': round(float(np.median(dr)), 1), 'face': round(float(np.median(run)), 1)})
    # the port's size: quantised parameters (offset and width per 5 m station, wall crest and toe, lamps, trees)
    n_rib = sum(len(r['pts']) for r in M['ribbons'] + M['road']); n_wall = sum(len(w['crest']) for w in M['walls'])
    n_rail = sum(len(r['pts']) for r in M['rails'])
    raw = n_rib * 5 + n_wall * 8 + n_rail * 4 + len(M['lamps']) * 8 + len(M['trees']) * 9
    tris = n_rib * 6 + n_wall * 10 + n_rail * 4 + len(M['lamps']) * 30
    budget = {'stations': n_rib + n_wall, 'kb_gzip': int(round(raw * 0.7 / 1024)), 'tris': tris}
    lamp_h = [l[3] - l[2] for l in M['lamps']]
    tr = M['trees']
    return {'paths': rows, 'walls': walls, 'rails_km': km(M['rails']), 'road_w': round(float(np.median(np.concatenate([r['w'] for r in M['road']]))), 1),
            'lamps': len(M['lamps']), 'lamp_h': round(float(np.median(lamp_h)), 1),
            'trees': len(tr), 'palms': sum(t[-1] for t in tr), 'tree_h': round(float(np.median([t[3] - t[2] for t in tr])), 1),
            'tree_r': round(float(np.median([t[4] for t in tr])), 1), 'length': M['meta']['length_m'], 'budget': budget}


if __name__ == '__main__':
    main()
