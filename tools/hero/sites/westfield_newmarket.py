"""
F35-A — hero building recipe: Westfield Newmarket (277 + 309 Broadway, Newmarket, Auckland).

  python3 tools/hero/site.py --name westfield_newmarket --lat -36.87154 --lon 174.77592 --size 340 --scale 50 --res 0.2
  python3 tools/hero/osm.py --site /tmp/hero/westfield_newmarket
  python3 tools/hero/sites/westfield_newmarket.py --site /tmp/hero/westfield_newmarket
  python3 tools/hero/build_prototype.py --site /tmp/hero/westfield_newmarket

Baseline: OSM relation 11520833 "Westfield Newmarket" (two outer rings: 277 Broadway with its rooftop car
park, 309 Broadway) and its building:part ways (5–8 levels). Heights: LINZ 2024 LiDAR, the median DSM
inside each ring (flat roofs), walls down to the lowest DEM in the ring (Newmarket slopes ~8 m across the
site). Roofs: the 2024 7.5 cm aerial draped in the same frame (low buildings: lean < 1 m). Facades and
signs: Wikimedia Commons photo File:Westfield_Newmarket_20220125_163111.jpg (Broadway frontage, 2022:
dark precast and glass bays, the teal glass air bridge over Mortimer Pass, the corner "Westfield" sign);
architect's renders show the 277 entrance's glass dome (confirmed in the aerial) but are not as-built.
"""
import argparse, json, os, sys

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
from heights import ring_mask  # noqa: E402

PARTS = {  # OSM id → (wall material, bay [u, v] m, roof, base {mat, h} or None); walls from Mapillary street imagery 2021–25
    'way/30088824': ('lattice', [2.5, 2.5], 'aerial', {'mat': 'slate', 'h': 7}),           # 277: white diamond screen over the car park, slate base
    'way/1010450578': ('precast_light', [5, 4], 'aerial', {'mat': 'shopfront', 'h': 6}), # 277: grey stone block on Broadway, shopfronts
    'way/1010450579': ('precast_dark', [4, 4], 'aerial', None),                          # 277: plant/lift block on the car park
    'way/1010450580': ('glass', [3, 4], 'aerial', None),                                 # 277: corner rotunda (dome on top)
    'way/720081499': ('precast_light', [6, 4.5], 'aerial', {'mat': 'slate', 'h': 6}),   # 309: white precast over a slate base
    'way/1010450575': ('precast_dark', [5, 4.5], 'aerial', None),                        # 309: upper levels (dining, cinema)
    'way/1010450573': ('precast_light', [6, 4.5], 'aerial', {'mat': 'slate', 'h': 6}),  # 309: department-store block
    'way/1010450572': ('carpark', [6, 3.3], 'aerial', None),                             # 309: open car-park decks with white fins (motorway side)
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--site', required=True)
    a = ap.parse_args()
    S = a.site
    site = json.load(open(f'{S}/site.json'))
    d = np.load(f'{S}/lidar.npz')
    dsm, dem = d['dsm'], d['dem']
    H, W = dsm.shape
    feats = {f['id']: f for f in json.load(open(f'{S}/osm.json'))['features'] if f['ring']}
    mall = np.zeros_like(dem, dtype=bool)
    for k in PARTS:
        mall |= ring_mask(dem.shape, feats[k]['ring'])
    g0 = float(np.nanpercentile(dem[mall], 2))          # heights in the model are metres above this

    prisms = []
    for k, (wall, bay, roof, base) in PARTS.items():
        m = ring_mask(dem.shape, feats[k]['ring'])
        prisms.append({'id': k, 'ring': feats[k]['ring'], 'y0': round(float(np.nanmin(dem[m])) - g0 - 0.5, 2),
                       'y1': round(float(np.nanmedian(dsm[m])) - g0, 2), 'wall': wall, 'bay': bay, 'roof': roof, **({'base': base} if base else {})})
    P = {p['id']: p for p in prisms}
    # the rotunda's glass dome lets the LiDAR through (p10 ≈ 0 m inside it), so its median reads low;
    # it stands one storey above the car-park deck it sits on (renders and the aerial's shadow)
    P['way/1010450580']['y1'] = round(P['way/30088824']['y1'] + 3.5, 2)
    ground_at = lambda x, z: float(dem[min(H - 1, int(z)), min(W - 1, int(x))]) - g0  # noqa: E731

    # Broadway frontage of 309 (its east edge): shopfronts at street level, glass bays above (2022 photo)
    facades = []
    ring = feats['way/720081499']['ring']
    cx, cz = np.mean([p[0] for p in ring]), np.mean([p[1] for p in ring])
    for (ax, az), (bx, bz) in zip(ring, ring[1:]):
        if min(ax, bx) > 235 and abs(bz - az) > 6:
            L = float(np.hypot(bx - ax, bz - az))
            nrm = [(bz - az) / L, -(bx - ax) / L]
            if nrm[0] * ((ax + bx) / 2 - cx) + nrm[1] * ((az + bz) / 2 - cz) < 0:
                nrm = [-nrm[0], -nrm[1]]                     # point away from the building
            n = max(1, int(abs(bz - az) // 14))
            for i in range(n):
                t0, t1 = i / n, (i + 1) / n
                pa, pb = [ax + (bx - ax) * t0, az + (bz - az) * t0], [ax + (bx - ax) * t1, az + (bz - az) * t1]
                gy = ground_at(*pa)
                facades.append({'a': pa, 'b': pb, 'n': nrm, 'y0': gy, 'y1': gy + 5, 'mat': 'shopfront', 'bay': [4, 5]})
                # glass bays alternating with the silver perforated screen (2022 photo, Mapillary)
                facades.append({'a': pa, 'b': pb, 'n': nrm, 'y0': gy + 5.5, 'y1': P['way/720081499']['y1'] - 1.5, 'mat': 'glass' if i % 3 != 1 else 'metal', 'bay': [3, 4.5] if i % 3 != 1 else [1, 4]})

    # the two-level glass air bridge over Mortimer Pass (opened Oct 2019; 12 m high), between 277 and 309
    gb = ground_at(229, 165)
    boxes = [{'from': [229, 150], 'to': [229, 178], 'y0': gb + 5, 'y1': gb + 15, 'width': 8, 'mat': 'glass_teal'}]
    # the glass dome on the 277 corner rotunda
    rx, rz = np.mean([p[0] for p in feats['way/1010450580']['ring']]), np.mean([p[1] for p in feats['way/1010450580']['ring']])
    rt = P['way/1010450580']['y1']
    domes = [{'x': round(float(rx), 1), 'z': round(float(rz), 1), 'y': rt, 'r': 8.5, 'mat': 'glass', 'squash': 0.7}]
    script = 'italic 700 {px}px "Brush Script MT", "Segoe Script", "Snell Roundhand", cursive'
    signs = [
        {'text': 'Westfield', 'font': script, 'colour': '#f6f3ee', 'x': round(float(rx) + 9.2, 1), 'z': round(float(rz), 1), 'y': rt - 4, 'w': 14, 'h': 3.6, 'face': [1, 0]},
        {'text': 'Westfield', 'font': script, 'colour': '#f6f3ee', 'x': 253.5, 'z': 194, 'y': P['way/720081499']['y1'] - 4, 'w': 16, 'h': 4, 'face': [1, 0]},
    ]

    ground = (dem - g0)[::2, ::2]
    lidar = np.maximum(dsm - g0, dem - g0)[::2, ::2]
    pack = lambda arr: {'res': 2, 'w': arr.shape[1], 'h': arr.shape[0], 'z': [round(float(v), 1) for v in np.nan_to_num(arr).ravel()]}  # noqa: E731
    gx, gz = site['centre']['game_x'], site['centre']['game_z']
    model = {
        'size': [W, H], 'centre': [W / 2, H / 2], 'camera': [230, 70, 120], 'ground': pack(ground), 'lidar': pack(lidar),
        'prisms': prisms, 'facades': facades, 'boxes': boxes, 'domes': domes, 'signs': signs,
        'meta': {
            'page_title': 'Westfield Newmarket Hero Model',
            'eyebrow': 'F35-A · hero building test · Newmarket, Auckland',
            'title': 'Westfield Newmarket, built from OSM, LINZ LiDAR and the aerial photo',
            'lede': 'A test drive of the hero-building skill: OpenStreetMap gave the outline and the parts, the LiDAR gave every roof height, the 7.5 cm aerial gave the roofs, and one street photo gave the Broadway frontage. Drag to orbit.',
            'notes': {
                'today': f'The game today (high tier): Newmarket is procedural suburb, generic blocks and houses; there is no Westfield. Site centre at game x {gx:.0f}, z {gz:.0f}.',
                'lidar': 'LINZ 2024 LiDAR surface on a 2 m grid with the aerial draped on it: the mall, the rooftop car park, the motorway viaduct and the trees of Highwic.',
                'hero': 'Hero model: 8 OSM parts extruded to their LiDAR roof heights, aerial roofs, the Broadway frontage, the glass air bridge, the rotunda dome and two signs. About {tris} triangles.',
            },
            'steps': [
                {'n': 'STEP 1 · OSM BASELINE', 'title': 'Someone already mapped it', 'text': 'OSM relation 11520833 "Westfield Newmarket": two outlines (277 and 309 Broadway) and 7 building parts tagged 5–8 levels. The outlines match the LiDAR and the aerial to about a metre.'},
                {'n': 'STEP 2 · LIDAR', 'title': 'Roof heights', 'img': 'ndsm', 'alt': 'LiDAR heights over the site', 'text': 'Median LiDAR height inside each part: 20.5 m (277, car-park deck) to 29.9 m (309, the department-store block). Newmarket slopes about 8 m across the site, so walls run down to the lowest ground in each part.'},
                {'n': 'STEP 3 · AERIAL', 'title': 'Real roofs', 'img': 'aerial', 'alt': 'LINZ aerial of the mall', 'text': 'The 7.5 cm aerial is draped on every roof: the parked cars, the white plant roofs, the glazed atrium. These roofs are under 35 m, so the photo leans them by less than a metre.'},
                {'n': 'STEP 4 · PHOTOS', 'title': 'The frontage', 'text': 'A 2022 Wikimedia Commons photo of Broadway: dark precast and glass bays, shopfronts, the teal two-level air bridge over Mortimer Pass and the corner "Westfield" sign. Three of four photos found were architect\'s renders, not the building as built.'},
                {'n': 'STEP 5 · KIT', 'title': 'Model as data', 'text': 'tools/hero/sites/westfield_newmarket.py writes model.json (prisms, facades, boxes, domes, signs); tools/hero/build_prototype.py turns it into this page. No bespoke mesh code was needed.'},
            ],
            'ledger': [
                {'cls': 'm', 'tag': 'Measured', 'text': 'Every roof height (LiDAR medians), the ground slope, outlines (OSM, checked against LiDAR).'},
                {'cls': 'r', 'tag': 'From photos', 'text': 'Roofs (aerial), the Broadway frontage pattern, the air bridge, the rotunda dome, the signs.'},
                {'cls': 'r', 'tag': 'From Mapillary', 'text': 'Every street side: the white diamond screen over 277\'s car park, slate plinths, white precast on 309, the open car-park decks with white fins on the motorway side, shopfronts on Broadway.'},
                {'cls': 'g', 'tag': 'Guessed', 'text': 'The west side facing Highwic\'s trees (no street reaches it), the exact bay rhythm, the air bridge\'s exact ends, the living wall and canopies (not modelled).'},
            ],
            'sources': 'Data: LINZ Auckland LiDAR 1 m DSM/DEM (2024) and 0.075 m Urban Aerial Photos (2024), CC BY 4.0. Outlines and parts © OpenStreetMap contributors, ODbL. Frontage: Wikimedia Commons, <a href="https://commons.wikimedia.org/wiki/File:Westfield_Newmarket_20220125_163111.jpg">Westfield_Newmarket_20220125_163111.jpg</a>. Air bridge and facade materials: <a href="https://en.wikipedia.org/wiki/Westfield_Newmarket">Wikipedia</a>, <a href="https://www.retail-insight-network.com/projects/westfield-newmarket-redevelopment/">Retail Insight Network</a>. Walls on every street side: <a href="https://www.mapillary.com">Mapillary</a> contributors, CC BY-SA 4.0. The script sign is a font stand-in, not the official logo.',
        },
    }
    json.dump(model, open(f'{S}/model.json', 'w'), separators=(',', ':'))
    print(f'{S}/model.json: {len(prisms)} prisms, {len(facades)} facade panels; heights above {g0:.1f} m:')
    for p in prisms:
        print(f"  {p['id']:>16}  y0 {p['y0']:6.1f}  y1 {p['y1']:6.1f}  {p['wall']}")


if __name__ == '__main__':
    main()
