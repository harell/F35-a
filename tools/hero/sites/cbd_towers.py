"""
F35-A — hero buildings: the CBD tower kit (issue #156). Every Auckland CBD building taller than Scene 3 (30 Beach Rd,
49.6 m) as LiDAR-traced terraces: podium, shaft, setbacks, sloped crowns, roof plant and spires, in game coordinates,
for src/core/cbdTowersData.ts (generated) and the prototype page.

  python3 tools/hero/site.py --name cbd --lat -36.84699 --lon 174.76202 --size 3200 --res 0.5 --scale 150
  (a throwaway vitest writes the game's LINZ list: decodeBuildings(BUILDINGS_BYTES) → /tmp/hero/linz_buildings.json)
  python3 tools/hero/sites/cbd_towers.py --site /tmp/hero/cbd --tiers C,C* [--styles tools/hero/sites/cbd_towers_style.json]
      → <site>/towers.json and src/core/cbdTowersData.ts

The list (tools/hero/sites/cbd_towers.tsv) is #156's table: name, tier, measured height and the game x, z of the tallest
LINZ prism. For each row:
1. Outline: the LINZ building whose tallest prism is nearest (x, z), plus any LINZ building over Scene 3's height that
   touches it (towers split over several records). Their footprints' union is the outline the hero replaces.
2. Levels: the LiDAR roof (DSM, 1 m) over the ground at the largest part's centroid (the game stands the building on
   its terrain there; DSM − DEM would make a flat roof on a slope a ramp) inside the outline, histogrammed at 1 m, smoothed 3 m; every
   peak holding ≥ 40 m² (and ≥ 3 % of the outline) is a level, peaks closer than 4 m merge. Each cell takes the nearest
   level, a 3 m mode filter cleans the classes, and each class is traced at 0.5 m (as scene_beach_road.py), clipped to
   the outline, simplified 1.0 m; pieces under 25 m² are dropped. Each terrace's roof is the median of its cells.
3. Steps and slopes: a group of ≥ 16 m² more than 1.8 m off its terrace's roof becomes its own terrace; a terrace a
   plane fits better than a flat roof (RMS halves, slope > 0.08) takes the plane (wedge crowns, ramped roofs). Kinds:
   the levels at ≥ 55 % of the top are the shaft, a top level under 30 % of the shaft's area the crown, lower ones the
   podium.
4. Plant: cells > 2.5 m over a shaft or crown roof, in groups of ≥ 12 m², become boxes (minimum rotated rectangle, p90).
   A spire: a group of ≤ 30 m² rising ≥ 8 m over the roof (the LiDAR catches only the thick part of a thin spire).
5. Spot checks: three LiDAR samples (3×3 median) per tower inside its top terraces, for tests/world-towers.test.ts.
Facades come from the use column and, where measured, tools/hero/sites/cbd_towers_style.json (colours from Auckland
Council's 2023 3D mesh, tools/hero/mesh3d.py).
Data: LINZ 2024 LiDAR, NZ Building Outlines (CC BY 4.0); © OpenStreetMap contributors (ODbL) for the names.
"""
import argparse, csv, json, math, os, sys

import numpy as np
from pyproj import Transformer
from scipy import ndimage
from shapely.affinity import translate
from shapely.geometry import MultiPolygon, Polygon
from shapely.ops import unary_union
from skimage import measure

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..'))
from heights import ring_mask  # noqa: E402

ORIGIN = (-36.8485, 174.7622)  # src/core/auckland.ts AKL_ORIGIN
MLAT = 110_950
MLON = 111_320 * math.cos(math.radians(ORIGIN[0]))
to_nztm = Transformer.from_crs(4326, 2193, always_xy=True)
to_wgs = Transformer.from_crs(2193, 4326, always_xy=True)
SCENE3 = 49.6
UP = 2


def game_to_px(x, z, box):
    """Game XZ (m) → site pixel (col, row) in the lidar arrays (1 m, north-up)."""
    lat, lon = ORIGIN[0] - z / MLAT, ORIGIN[1] + x / MLON
    E, N = to_nztm.transform(lon, lat)
    return E - box[0], box[3] - N


def px_to_game(c, r, box):
    lon, lat = to_wgs.transform(box[0] + c, box[3] - r)
    return (lon - ORIGIN[1]) * MLON, (ORIGIN[0] - lat) * MLAT


def flat(ring):
    return [(ring[i], ring[i + 1]) for i in range(0, len(ring), 2)]


def polys(mask):
    big = np.kron(mask, np.ones((UP, UP), dtype=bool))
    out = []
    for c in measure.find_contours(np.pad(big, 1).astype(float), 0.5):
        pts = [((x - 1) / UP, (y - 1) / UP) for y, x in c]
        if len(pts) >= 4:
            p = Polygon(pts).buffer(0)
            if p.area > 1:
                out.append(p)
    out.sort(key=lambda p: -p.area)
    shapes = []
    for p in out:
        host = next((s for s in shapes if s.contains(p.representative_point())), None)
        if host is None:
            shapes.append(p)
        else:
            shapes[shapes.index(host)] = host.difference(p)
    return shapes


def parts_of(g):
    gs = g.geoms if isinstance(g, MultiPolygon) else [g] if isinstance(g, Polygon) else [x for x in getattr(g, 'geoms', []) if isinstance(x, Polygon)]
    return [p for p in gs if p.area >= 25]


def no_holes(p):
    """Split a polygon with courtyards into hole-free pieces (the game's prisms have no holes): cut it on a line
    through each courtyard, across its shorter extent, until no piece has one."""
    from shapely.geometry import LineString
    from shapely.ops import split
    todo, out = [p], []
    while todo:
        q = todo.pop()
        if not q.interiors:
            out.append(q)
            continue
        hc = Polygon(q.interiors[0]).centroid
        x0, y0, x1, y1 = q.bounds
        line = LineString([(hc.x, y0 - 1), (hc.x, y1 + 1)]) if x1 - x0 > y1 - y0 else LineString([(x0 - 1, hc.y), (x1 + 1, hc.y)])
        pieces = [g for g in split(q, line).geoms if isinstance(g, Polygon) and g.area > 0.5]
        if len(pieces) < 2:  # a line along an edge: keep the outline, drop the courtyard
            out.append(Polygon(q.exterior))
            continue
        todo += pieces
    return out


def levels(vals, total):
    """Roof levels (m) inside an outline: peaks of the 1 m height histogram."""
    v = vals[vals > 2.5]
    if not len(v):
        return []
    hist = np.bincount(np.clip(v.astype(int), 0, 400), minlength=402).astype(float)
    sm = np.convolve(hist, np.ones(3), 'same')
    peaks = []
    for h in range(3, 400):
        if sm[h] >= sm[h - 1] and sm[h] > sm[h + 1] and sm[h] >= max(25, 0.01 * total):
            peaks.append(h + 0.5)
    merged = []
    for p in peaks:
        if merged and p - merged[-1][0] < 3:
            # keep the stronger peak
            if sm[int(p)] > merged[-1][1]:
                merged[-1] = (p, sm[int(p)])
        else:
            merged.append((p, sm[int(p)]))
    return [p for p, _ in merged]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--site', default='/tmp/hero/cbd')
    ap.add_argument('--linz', default='/tmp/hero/linz_buildings.json')
    ap.add_argument('--tiers', default='A,B,C,C*')
    ap.add_argument('--styles', default=os.path.join(HERE, 'cbd_towers_style.json'))
    ap.add_argument('--ts', default=os.path.join(HERE, '..', '..', '..', 'src', 'core', 'cbdTowersData.ts'))
    ap.add_argument('--only', default='')
    a = ap.parse_args()
    d = np.load(f'{a.site}/lidar.npz')
    dsm, dem, box = d['dsm'], d['dem'], d['box']
    nd = np.nan_to_num(dsm - dem)
    spread = ndimage.maximum_filter(nd, 5) - ndimage.minimum_filter(nd, 5)  # local roof flatness, for the spot checks
    linz = json.load(open(a.linz))
    styles = json.load(open(a.styles)) if os.path.exists(a.styles) else {}
    tiers = set(a.tiers.split(','))
    rows = [r for r in csv.reader(open(os.path.join(HERE, 'cbd_towers.tsv')), delimiter='\t') if r and not r[0].startswith('#')]
    only = {int(x) for x in a.only.split(',') if x}

    # LINZ buildings: footprint polygons (game m), tallest prism
    lb = []
    for i, b in enumerate(linz):
        rings = [Polygon(flat(p['ring'])).buffer(0) for p in b['prisms']]
        top = max(b['prisms'], key=lambda p: p['h'])
        lb.append({'i': i, 'poly': unary_union(rings), 'h': top['h'], 'cx': top['cx'], 'cz': top['cz']})
    # every row's own LINZ building first (all tiers), so one tower never swallows another's
    def nearest(x, z):
        return min(lb, key=lambda b: math.hypot(b['cx'] - x, b['cz'] - z))
    primaries = {nearest(float(r[8]), float(r[9]))['i'] for r in rows}
    taken = set()
    towers = []
    for r in rows:
        n, tier, name, addr, h, floors, pub, use, x, z = r
        n, h, x, z = int(n), float(h), float(x), float(z)
        if tier not in tiers or (only and n not in only):
            continue
        if name == 'Scene One':
            continue  # already a hero building (core/sceneApartments.ts)
        prim = nearest(x, z)
        group = [prim] + [b for b in lb if b is not prim and b['h'] > SCENE3 and b['i'] not in primaries and b['poly'].buffer(0.6).intersects(prim['poly'])
                          and b['i'] not in taken and math.hypot(b['cx'] - x, b['cz'] - z) < 45]
        group = [b for b in group if b['i'] not in taken]
        taken.update(b['i'] for b in group)
        outline = unary_union([b['poly'] for b in group]).buffer(0)
        if isinstance(outline, MultiPolygon):
            outline = max(outline.geoms, key=lambda p: p.area)
        if outline.is_empty or outline.area < 50:
            print('no outline', n, name)
            continue
        # outline in pixel space
        ext = [game_to_px(px, pz, box) for px, pz in outline.exterior.coords]
        opx = Polygon(ext).buffer(0)
        m = ring_mask(dem.shape, ext[:-1])
        # heights over the ground at the outline's centre (the game stands a building on the terrain at a centroid): on a
        # slope DSM − DEM would turn a flat roof into a ramp (The Connaught on Waterloo Quadrant)
        oc = opx.centroid
        g_ref = float(np.median(dem[int(oc.y) - 2:int(oc.y) + 3, int(oc.x) - 2:int(oc.x) + 3]))
        hr = dsm - g_ref
        vals = hr[m]
        lv = levels(vals, m.sum())
        if not lv:
            print('no levels', n, name)
            continue
        lv_arr = np.array(lv)
        cls = np.full(dem.shape, -1, np.int16)
        idx = np.abs(vals[:, None] - lv_arr[None, :]).argmin(1)
        idx[nd[m] < 2.5] = -1
        idx[np.abs(vals - lv_arr[np.clip(idx, 0, None)]) > 5] = -1  # far from every level: a part too small to be one
        cls[m] = idx
        r0, r1 = np.where(m.any(1))[0][[0, -1]]
        c0, c1 = np.where(m.any(0))[0][[0, -1]]
        r0, r1, c0, c1 = max(r0 - 3, 0), r1 + 4, max(c0 - 3, 0), c1 + 4
        sub = cls[r0:r1, c0:c1]
        k = len(lv) + 1

        def mode(v):
            # open ground (-1) votes too: a courtyard or a street edge stays open
            return np.bincount(v.astype(int) + 1, minlength=k + 1).argmax() - 1

        sub = ndimage.generic_filter(sub, mode, size=3, mode='nearest').astype(np.int16)
        sub[~m[r0:r1, c0:c1]] = -1
        cls[:] = -1
        cls[r0:r1, c0:c1] = sub
        terr = []
        for li in range(len(lv)):
            km = cls == li
            if km.sum() < 25:
                continue
            km_sub = km[r0:r1, c0:c1]
            for p in polys(km_sub):
                p = translate(p, c0, r0)
                for q in [h for g in parts_of(p.intersection(opx).simplify(1.0, preserve_topology=True)) for h in parts_of(MultiPolygon(no_holes(g)))]:
                    cells = ring_mask(dem.shape, list(q.exterior.coords)[:-1]) & km
                    if cells.sum() < 12:
                        continue
                    roof = float(np.median(hr[cells]))
                    terr.append({'li': li, 'poly': q, 'cells': cells, 'h': roof, 'area': q.area})
        # a step inside one terrace (two levels closer than the histogram resolves, a ramped roof): a group of ≥ 25 m²
        # more than 1.8 m off the terrace's roof (and not plant on it) becomes its own terrace
        for _pass in range(3):  # a carved step can hold another
            out = []
            for t in terr:
                low = t['cells'] & (np.abs(hr - t['h']) > 1.8) & (nd >= 2.5) & (hr < t['h'] + 2.5)
                lab, nl = ndimage.label(low)
                poly, cells_left = t['poly'], t['cells']
                for j in range(1, nl + 1):
                    cm = lab == j
                    if cm.sum() < 16:
                        continue
                    for p in polys(cm[r0:r1, c0:c1]):
                        p = translate(p, c0, r0).simplify(1.0, preserve_topology=True)
                        for q in [h2 for g in parts_of(p.intersection(poly)) for h2 in parts_of(MultiPolygon(no_holes(g)))]:
                            cells = ring_mask(dem.shape, list(q.exterior.coords)[:-1]) & cells_left
                            if cells.sum() < 12:
                                continue
                            poly = poly.difference(q.buffer(0.01))
                            cells_left = cells_left & ~cells
                            out.append({'li': t['li'], 'poly': q, 'cells': cells, 'h': float(np.median(hr[cells])), 'area': q.area})
                # what is left of the terrace, without courtyards (a carved step inside it leaves one)
                for q in [h2 for g in parts_of(poly) for h2 in parts_of(MultiPolygon(no_holes(g)))]:
                    cells = ring_mask(dem.shape, list(q.exterior.coords)[:-1]) & cells_left
                    if cells.sum() < 12:
                        continue
                    out.append({'li': t['li'], 'poly': q, 'cells': cells, 'h': float(np.median(hr[cells])), 'area': q.area})
            if len(out) == len(terr):
                terr = out
                break
            terr = out
        # slivers (< 60 m²) join the touching terrace nearest in height: fewer walls, no gaps
        terr.sort(key=lambda t: t['area'])
        while terr and terr[0]['area'] < 60:
            t = terr.pop(0)
            nb = [u for u in terr if u['poly'].distance(t['poly']) < 0.8]
            if not nb:
                continue
            u = min(nb, key=lambda u: abs(u['h'] - t['h']))
            # close the seam between them with a mitred grow-and-shrink (round joins would add arcs of vertices)
            g = unary_union([u['poly'], t['poly']]).buffer(0.8, join_style=2).buffer(-0.8, join_style=2)
            g = max(parts_of(g) or [u['poly']], key=lambda q: q.area).simplify(1.0, preserve_topology=True)
            pieces = parts_of(MultiPolygon(no_holes(g)))
            if len(pieces) != 1:
                continue
            u['poly'] = pieces[0].intersection(opx).buffer(0)
            if not isinstance(u['poly'], Polygon):
                u['poly'] = max(parts_of(u['poly']) or [pieces[0]], key=lambda q: q.area)
            u['cells'] = u['cells'] | t['cells']
            u['area'] = u['poly'].area
            terr.sort(key=lambda t: t['area'])
        # a terrace well over the listed height is a crane or a neighbour's edge in the old outline, not this tower
        terr = [t for t in terr if 3 <= float(np.median(nd[t['cells']])) <= h + 6]  # (above its own ground: the table's measure)
        if not terr:
            print('no terraces', n, name)
            continue
        # final outline cleanup: 1.2 m (the 0.5 m traces and clips leave raster stairs and slivers of vertices)
        for t in terr:
            q = t['poly'].simplify(1.2, preserve_topology=True)
            if isinstance(q, Polygon) and q.area > 0.8 * t['area']:
                t['poly'] = Polygon(q.exterior)
        top = max(t['h'] for t in terr)
        shaft = [t for t in terr if t['h'] >= 0.55 * top]
        shaft_area = sum(t['area'] for t in shaft)
        for t in terr:
            t['kind'] = 'shaft' if t['h'] >= 0.55 * top else 'podium'
        # a small top level over the shaft: the crown
        top_lv = max(terr, key=lambda t: t['h'])
        below = [t for t in shaft if t['h'] < top_lv['h'] - 3]
        if below and sum(t['area'] for t in terr if t['li'] == top_lv['li']) < 0.3 * shaft_area:
            for t in terr:
                if t['li'] == top_lv['li']:
                    t['kind'] = 'crown'
        # sloped roofs (wedge crowns, ramped roofs): a terrace a plane fits better than a flat roof takes the plane
        for t in terr:
            t['sx'] = t['sz'] = 0.0
            ys, xs = np.where(t['cells'])
            if len(ys) < 40:
                continue
            hv = hr[ys, xs]
            A = np.c_[xs, ys, np.ones(len(xs))]
            coef, *_ = np.linalg.lstsq(A, hv, rcond=None)
            rms_plane = float(np.sqrt(np.mean((A @ coef - hv) ** 2)))
            rms_flat = float(np.sqrt(np.mean((hv - np.median(hv)) ** 2)))
            if 0.08 < math.hypot(coef[0], coef[1]) < 1.0 and rms_plane < 0.5 * rms_flat and rms_flat > 0.8:
                # pixel axes: col = east, row = south (≈ game +x, +z); the game reads the height at the ring's centroid
                t['sx'], t['sz'] = float(coef[0]), float(coef[1])
                cx, cz = t['poly'].centroid.x, t['poly'].centroid.y
                t['h'] = float(coef[0] * cx + coef[1] * cz + coef[2])
        # plant and spires over the shaft / crown roofs
        extras = []
        for t in terr:
            if t['kind'] == 'podium' or t['sx'] or t['sz']:
                continue
            lab, nl = ndimage.label(t['cells'] & (hr > t['h'] + 2.5))
            for j in range(1, nl + 1):
                ys, xs = np.where(lab == j)
                if len(ys) < 3:
                    continue
                hi = float(np.percentile(hr[ys, xs], 90))
                mx = float(hr[ys, xs].max())
                if len(ys) <= 30 and mx > t['h'] + 8 and float(nd[ys, xs].max()) < h + 40:
                    i = int(hr[ys, xs].argmax())
                    extras.append({'kind': 'spire', 'x': xs[i] + 0.5, 'z': ys[i] + 0.5, 'h': mx, 'base': t['h']})
                elif len(ys) >= 12 and float(np.percentile(nd[ys, xs], 90)) <= h + 8:
                    rect = unary_union([Polygon([(x_, y_), (x_ + 1, y_), (x_ + 1, y_ + 1), (x_, y_ + 1)]) for x_, y_ in zip(xs, ys)]).minimum_rotated_rectangle
                    ex = rect.exterior.coords
                    sides = sorted([math.dist(ex[0], ex[1]), math.dist(ex[1], ex[2])])
                    # a crane's jib or a thin sliver is long and mostly empty: not plant
                    # plant is small on its roof: a big raised block is a terrace the levels missed, not a dark box
                    small = rect.area <= min(150, 0.25 * t['area']) and hi <= t['h'] + 9
                    if small and sides[1] < 4 * max(sides[0], 1) and len(ys) > 0.45 * rect.area:
                        extras.append({'kind': 'plant', 'poly': rect, 'h': hi})
        # spot checks: three cells well inside the top terraces (3×3 median), away from plant
        spots = []
        for t in sorted([t for t in terr if t['kind'] != 'podium'], key=lambda t: -t['area'])[:3]:
            er = ndimage.binary_erosion(t['cells'], iterations=3)
            er &= ~ndimage.binary_dilation(hr > t['h'] + 2.0, iterations=2)
            for e in extras:
                if e['kind'] == 'plant':
                    er &= ~ring_mask(dem.shape, list(e['poly'].buffer(1.5).exterior.coords)[:-1])
            # on a flat stretch of the roof (5×5 spread under 1 m): a check of the model's roof, not of the
            # LiDAR's edge noise
            ys, xs = np.where(er & (spread < 1.0))
            if not len(ys):
                ys, xs = np.where(er)
            if not len(ys):
                continue
            i = len(ys) // 2
            yy, xx = ys[i], xs[i]
            v = float(np.median(hr[yy - 1:yy + 2, xx - 1:xx + 2]))
            gx, gz = px_to_game(xx + 0.5, yy + 0.5, box)
            spots.append([round(gx, 1), round(gz, 1), round(v, 1)])

        # the game's ground is the terrain at the largest part's centroid: re-reference every height to the DEM there
        big = max(terr, key=lambda t: t['area'])['poly'].centroid
        g2 = float(np.median(dem[int(big.y) - 2:int(big.y) + 3, int(big.x) - 2:int(big.x) + 3]))
        dg = g_ref - g2
        for t in terr:
            t['h'] += dg
        terr = [t for t in terr if t['h'] >= 2.5]  # a low part downhill of the centroid would sit under the game's ground
        for e in extras:
            e['h'] += dg
            if 'base' in e:
                e['base'] += dg
        for sp in spots:
            sp[2] = round(sp[2] + dg, 1)

        def ring_game(poly):
            pts = [px_to_game(c, rr, box) for c, rr in list(poly.exterior.coords)[:-1]]
            gp = Polygon(pts)
            if gp.exterior.is_ccw:  # shapely ccw in (x, z) with z south = clockwise on the map; the file wants positive shoelace in (x, z)
                pass
            return [round(v, 2) for p in pts for v in p]

        parts = []
        for t in sorted(terr, key=lambda t: -t['area']):
            g = ring_game(t['poly'])
            part = {'kind': t['kind'], 'h': round(t['h'], 1), 'ring': g}
            if t['sx'] or t['sz']:
                part['sx'], part['sz'] = round(t['sx'], 3), round(t['sz'], 3)
            parts.append(part)
        for e in extras:
            if e['kind'] == 'plant':
                parts.append({'kind': 'plant', 'h': round(e['h'], 1), 'ring': ring_game(e['poly'])})
            else:
                gx, gz = px_to_game(e['x'], e['z'], box)
                parts.append({'kind': 'spire', 'h': round(e['h'], 1), 'x': round(gx, 1), 'z': round(gz, 1), 'base': round(e['base'], 1)})
        st = styles.get(str(n), {})
        tw = {'n': n, 'tier': tier, 'name': name, 'address': addr, 'use': use, 'listed': h, 'floors': int(floors) if floors else None,
              'published': float(pub) if pub else None, 'outline': [round(v, 2) for p in list(outline.exterior.coords)[:-1] for v in p],
              'parts': parts, 'spots': spots, 'linz': [b['i'] for b in group], 'style': st,
              # a point inside each replaced LINZ building's first footprint (its centroid can fall outside a concave one)
              'replaces': [[round(c, 2) for c in Polygon(flat(linz[b['i']]['prisms'][0]['ring'])).buffer(0).representative_point().coords[0]] for b in group]}
        towers.append(tw)
        print(f"{n:3d} {tier:2s} {name[:28]:28s} listed {h:6.1f} top {top:6.1f} parts {len(parts):2d} " +
              ' '.join(f"{p['kind'][0]}{p['h']:.0f}" for p in parts[:8]), flush=True)
    json.dump(towers, open(f'{a.site}/towers.json', 'w'))
    write_ts(towers, a.ts)


FACADE = {'residential': 'balcony', 'hotel': 'punched', 'office': 'glass', 'mixed': 'glass', 'university': 'bands', 'civic': 'bands'}
WALL = {'balcony': 0xd9dbd8, 'punched': 0xc9c3b8, 'glass': 0x6f8a99, 'bands': 0xb9b6ae, 'stone': 0xc8bfae}


def write_ts(towers, path):
    lines = [
        '/**',
        ' * F35-A — GENERATED by tools/hero/sites/cbd_towers.py from the LINZ 2024 LiDAR (CC BY 4.0) inside the LINZ NZ Building',
        ' * Outlines (CC BY 4.0); names © OpenStreetMap contributors (ODbL). Do not edit by hand: change the recipe or',
        ' * tools/hero/sites/cbd_towers_style.json and rerun it. Types and use: core/cbdTowers.ts.',
        ' */',
        "import type { CbdTower } from './cbdTowers';",
        '',
        'export const CBD_TOWERS: readonly CbdTower[] = [',
    ]
    for t in sorted(towers, key=lambda t: t['n']):
        st = t['style']
        facade = st.get('facade') or FACADE.get(t['use'], 'punched')
        wall = st.get('wall', '#%06x' % WALL[facade])
        podium = st.get('podium', '#c4c0b6')
        parts = []
        for p in t['parts']:
            if p['kind'] == 'spire':
                parts.append(f"{{ kind: 'spire', h: {p['h']}, x: {p['x']}, z: {p['z']}, base: {p['base']} }}")
            else:
                sl = f", sx: {p['sx']}, sz: {p['sz']}" if 'sx' in p else ''
                parts.append(f"{{ kind: '{p['kind']}', h: {p['h']}{sl}, ring: [{', '.join(str(v) for v in p['ring'])}] }}")
        extra = ''
        if st.get('crown'):
            extra += f", crown: '{st['crown']}'"
        if st.get('crownColour'):
            extra += f", crownColour: 0x{st['crownColour'].lstrip('#')}"
        lines.append(f"  {{ n: {t['n']}, tier: '{t['tier']}', name: {json.dumps(t['name'], ensure_ascii=False)}, address: {json.dumps(t['address'], ensure_ascii=False)}, "
                     f"facade: '{facade}', wall: 0x{wall.lstrip('#')}, podium: 0x{podium.lstrip('#')}{extra},")
        lines.append(f"    spots: {json.dumps(t['spots'])},")
        lines.append(f"    replaces: {json.dumps(t['replaces'])},")
        lines.append(f"    outline: [{', '.join(str(v) for v in t['outline'])}],")
        lines.append('    parts: [')
        for p in parts:
            lines.append(f'      {p},')
        lines.append('    ] },')
    lines.append('];')
    lines.append('')
    open(path, 'w').write('\n'.join(lines))
    print('wrote', path, len(towers), 'towers')


if __name__ == '__main__':
    main()
