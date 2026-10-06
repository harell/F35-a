"""
F35-A — bakes the detailed Auckland War Memorial Museum (tools/hero/sites/auckland_museum.py → museum_model.json) into
the game's src/core/museumData.ts.

  python3 tools/hero/sites/auckland_museum.py --site /tmp/hero/museum          (museum_model.json + tex_*.jpg)
  python3 tools/hero/sites/museum_bake.py --site /tmp/hero/museum             → src/core/museumData.ts

What ships (measured numbers only, ~10 kB; no textures):
  parts      the LiDAR terraces (court / low / main / upper / top bands) in game XZ, each with its roof height and its
             roof colour (the median of the 2023 mesh's top view inside it)
  dome       the Grand Atrium's glass and copper dome as its LiDAR surface on a 2 m grid (decimetres; −1 = outside its
             ring), with the rim height; the grid's own axes in game XZ (the site frame turns ~1° against the game's)
  portico    the north portico's entablature (ring, top, underside) and its eight columns
  colours    the walls' Portland stone from the sunlit north face (the south and west faces of the mesh lie in shade
             and read blue; taken as measured), the atrium's glass ring, the dome's cap and the roofs from the top
             view, white-balanced against the mesh's blue haze (gray world over the textures)
Heights are over the LiDAR ground at the outline's centroid (`g`), so the game stands the whole building on its
terrain by one offset (meshHeightAt − DEM at the centroid) and its roofs stay level.
Data: LINZ 2024 LiDAR (CC BY 4.0); Auckland Council 3D mesh 2023 (CC BY 4.0); © OpenStreetMap contributors (ODbL).
"""
import argparse, json, os, sys

import numpy as np
from PIL import Image
from shapely.geometry import Point, Polygon

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from cbd_towers import px_to_game  # noqa: E402

DOME_CELL = 2  # m, the shipped dome grid (the model's is 1 m)


def hexc(c):
    return '0x%02x%02x%02x' % tuple(int(max(0, min(255, round(v)))) for v in c)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--site', default='/tmp/hero/museum')
    ap.add_argument('--out', default=os.path.join(HERE, '..', '..', '..', 'src', 'core', 'museumData.ts'))
    a = ap.parse_args()
    m = json.load(open(os.path.join(a.site, 'museum_model.json')))
    S = json.load(open(os.path.join(a.site, 'site.json')))
    box = S['box_nztm']
    L = np.load(os.path.join(a.site, 'lidar.npz'))
    dsm, dem = L['dsm'].astype(np.float32), L['dem'].astype(np.float32)
    game = lambda x, z: tuple(round(v, 2) for v in px_to_game(x, z, box))
    def ring_g(ring):  # open rings: a closing point repeating the first is dropped
        ring = ring[:-1] if len(ring) > 3 and tuple(ring[0]) == tuple(ring[-1]) else ring
        return [v for x, z in ring for v in game(x, z)]

    outline = Polygon(m['footprint'])
    c = outline.centroid
    g = float(dem[int(c.y), int(c.x)])  # the LiDAR ground at the centroid: every height is over it
    cx, cz = game(c.x, c.y)

    # white balance: gray world over everything the mesh painted (the background is the page's beige)
    tex = {s: np.asarray(Image.open(os.path.join(a.site, f'tex_{s}.jpg')).convert('RGB')).astype(np.float32) for s in ('north', 'south', 'east', 'west', 'top')}
    px = np.concatenate([t[np.abs(t - [200, 196, 186]).sum(2) > 25] for t in tex.values()])
    mean = px.mean(0)
    wb = mean.mean() / mean
    bal = lambda col: np.clip(np.asarray(col) * wb, 0, 255)

    tx = m['tex']
    top = tex['top']
    H, W, _ = top.shape

    def top_median(poly, pred=None):
        b = poly.bounds
        vals = []
        for x in np.arange(b[0], b[2], 0.5):
            for z in np.arange(b[1], b[3], 0.5):
                if not poly.contains(Point(x, z)) or (pred and not pred(x, z)):
                    continue
                i = int((x - tx['x'][0]) / (tx['x'][1] - tx['x'][0]) * (W - 1))
                j = int((z - tx['z'][0]) / (tx['z'][1] - tx['z'][0]) * (H - 1))
                if 0 <= i < W and 0 <= j < H:
                    vals.append(top[j, i])
        return bal(np.median(np.array(vals), 0))

    # stone: the sunlit north face's bright stone (60th–90th percentile of lightness), as measured: the haze is a blue
    # cast on the shaded faces, and balancing the sunlit stone with it turns the stone yellow (#fff7d1)
    nf = tex['north'][np.abs(tex['north'] - [200, 196, 186]).sum(2) > 25]
    lum = nf.mean(1)
    stone = np.median(nf[(lum > np.percentile(lum, 60)) & (lum < np.percentile(lum, 90))], 0)

    parts = []
    for t in m['terraces']:
        poly = Polygon(t['ring'])
        parts.append({'kind': t['kind'], 'h': round(t['y1'] - g, 2), 'ring': ring_g(t['ring']), 'roof': hexc(top_median(poly))})

    # the dome: resample the 1 m surface to DOME_CELL, cells outside its ring −1
    d = m['dome']
    hd = np.array(d['h'], dtype=np.float32).reshape(d['nz'], d['nx'])
    dpoly = Polygon(d['ring'])
    nx, nz = (d['nx'] - 1) // DOME_CELL + 1, (d['nz'] - 1) // DOME_CELL + 1
    grid = []
    for j in range(nz):
        for i in range(nx):
            x, z = d['x0'] + i * DOME_CELL, d['z0'] + j * DOME_CELL
            inside = dpoly.contains(Point(x, z))
            grid.append(int(round((float(hd[j * DOME_CELL, i * DOME_CELL]) - g) * 10)) if inside else -1)
    o = game(d['x0'], d['z0'])
    ex = tuple(round(v - w, 4) for v, w in zip(game(d['x0'] + DOME_CELL, d['z0']), o))
    ez = tuple(round(v - w, 4) for v, w in zip(game(d['x0'], d['z0'] + DOME_CELL), o))
    cap = top_median(dpoly, lambda x, z: hd[int(round(z - d['z0'])), int(round(x - d['x0']))] > d['rim'] + 2.5)
    glass = top_median(dpoly, lambda x, z: hd[int(round(z - d['z0'])), int(round(x - d['x0']))] <= d['rim'] + 2.5)

    p = m['portico']
    columns = [[*game(x, z), round(r, 2)] for x, z, r in p['columns']]

    # spot checks for the test: a flat cell inside each of the three largest terraces (3×3 DSM median over g)
    spots = []
    for t in sorted(m['terraces'], key=lambda t: -t['area'])[:3]:
        q = Polygon(t['ring']).buffer(-2).representative_point()
        i, j = int(q.x), int(q.y)
        spots.append([*game(q.x, q.y), round(float(np.median(dsm[j - 1:j + 2, i - 1:i + 2])) - g, 2)])

    fmt = lambda xs: ', '.join(str(v) for v in xs)
    out = [
        '/**',
        ' * F35-A — GENERATED by tools/hero/sites/museum_bake.py from tools/hero/sites/auckland_museum.py: Auckland War Memorial',
        ' * Museum (Tāmaki Paenga Hira) on Pukekawa, the top layer on the Auckland Domain (core/aucklandDomain.ts).',
        ' * The block as LiDAR terraces in its OpenStreetMap outline (way 23906678), the 2007 Grand Atrium dome as its LiDAR',
        ' * surface, the north portico. Heights over the LiDAR ground at the outline\'s centroid; colours from Auckland Council\'s',
        ' * 2023 3D mesh, white-balanced (the stone from the sunlit north face).',
        ' * Sources: LINZ 2024 LiDAR (CC BY 4.0); © OpenStreetMap contributors (ODbL); Auckland Council 3D mesh (CC BY 4.0).',
        ' * Builder: world/scenery/museum.ts; the shared shape (scenery and sim): core/museum.ts. Do not edit by hand.',
        ' */',
        '',
        "export type MuseumPartKind = 'court' | 'low' | 'main' | 'upper' | 'top';",
        '',
        '/** Where the game stands the museum: its outline\'s centroid (game m). Every height below is over the ground there. */',
        f'export const MUSEUM_CENTRE = {{ x: {cx}, z: {cz} }};',
        '',
        '/** Terraces: a ring (flat [x0, z0, …], game m) up to h m, and its roof\'s colour (the mesh\'s top view). */',
        'export const MUSEUM_PARTS: readonly { kind: MuseumPartKind; h: number; roof: number; ring: readonly number[] }[] = [',
        *[f"  {{ kind: '{q['kind']}', h: {q['h']}, roof: {q['roof']}, ring: [{fmt(q['ring'])}] }}," for q in parts],
        '];',
        '',
        '/**',
        ' * The Grand Atrium dome: its LiDAR surface on a grid of nx × nz points (row-major, z rows), heights in decimetres',
        ' * (−1 = outside the dome). Point (i, j) is at origin + i·ex + j·ez (game m); `ring` is its outline, `rim` the',
        ' * copper ring\'s top (m).',
        ' */',
        'export const MUSEUM_DOME = {',
        f'  origin: [{o[0]}, {o[1]}], ex: [{ex[0]}, {ex[1]}], ez: [{ez[0]}, {ez[1]}], nx: {nx}, nz: {nz},',
        f"  rim: {round(d['rim'] - g, 2)}, top: {max(round(d['top'] - g, 2), max(grid) / 10)},",
        f"  ring: [{fmt(ring_g(d['ring']))}],",
        f'  h: [{fmt(grid)}],',
        '} as const;',
        '',
        '/** The north portico: the entablature (ring, its top and underside, m) and its eight columns [x, z, radius]. */',
        'export const MUSEUM_PORTICO = {',
        f"  top: {round(p['top'] - g, 2)}, under: {round(p['under'] - g, 2)},",
        f"  ring: [{fmt(ring_g(p['ring']))}],",
        f'  columns: [{", ".join("[" + fmt(cl) + "]" for cl in columns)}],',
        '} as const;',
        '',
        '/** Colours (sRGB): Portland stone, the atrium\'s glass ring and its dome\'s cap. */',
        f'export const MUSEUM_COLOURS = {{ stone: {hexc(stone)}, glass: {hexc(glass)}, cap: {hexc(cap)} }} as const;',
        '',
        '/** LiDAR spot checks [x, z, roof over the ground] (m, 3×3 median) on the three largest terraces. */',
        f'export const MUSEUM_SPOTS: readonly (readonly number[])[] = [{", ".join("[" + fmt(s) + "]" for s in spots)}];',
        '',
        '/** The OSM outline (game m): nothing of the Domain stands inside it. */',
        f"export const MUSEUM_OUTLINE: readonly number[] = [{fmt(ring_g(m['footprint']))}];",
        '',
    ]
    open(a.out, 'w').write('\n'.join(out))
    print(f'wrote {a.out}: {os.path.getsize(a.out)} B, g = {g:.2f}, stone {hexc(stone)}, glass {hexc(glass)}, cap {hexc(cap)}, {len(parts)} terraces')


if __name__ == '__main__':
    main()
