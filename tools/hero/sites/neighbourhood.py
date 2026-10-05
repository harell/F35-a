"""
F35-A — hero neighbourhoods: the shared kit for modelling a whole suburb from public data (Herne Bay, Westhaven).

A neighbourhood is many small buildings, trees and (at a marina) boats, so instead of one bespoke shape it measures every
part the same way:

  buildings  OSM outlines (Auckland's are the LINZ import), walls from the lowest LiDAR DEM inside the ring. The roof is
             fitted to the 1 m DSM inside the ring shrunk by 0.7 m: flat, gable (ridge along the long side of the minimum
             rotated rectangle) or hip, each `h = eave + pitch · d` with d the distance to the rectangle's eave edges,
             solved by least squares, refitted once without the cells more than 1.5 m off (trees over the roof, chimneys).
             A pitched fit wins only if it is clearly better than flat; a big flat building with a wide p10–p90 spread is
             split into height terraces (k-means bands, mode filter, traced). Roof colour = the 2024 aerial's median over
             the shrunk ring; walls are not measured (no 3D mesh this far west): a light palette, marked guessed.
  trees      one crown per LiDAR tree as for the Auckland Domain (watershed of the nDSM from local maxima), off buildings;
             crowns whose aerial colour is not green are structures (roofs OSM misses, boats on the hardstand, poles).
  traced     LiDAR blobs over 2.5 m that are not green, not OSM buildings and big enough: buildings OSM misses, as one
             flat prism at the blob's median height.
  roads      OSM highway centrelines with a width per class. They are *not* part of the model: they are used to check that
             no building or boat sits on a carriageway, i.e. that roads can be drawn on top by the game's own road layer.

Frames: site frame from site.py (x = E − E0 east, z = N1 − N south, metres; heights metres above NZVD2016).
The mesh (`mesh_building`) splits each roof along its creases (ridge, hips) into planar faces, so a gable end wall meets
its roof exactly; vertices carry absolute heights and each building also records its base `y0` so the port can re-seat it
on the game's terrain (one offset per building at its centroid, the layered-site rule).
Data: LINZ 2024 LiDAR and aerial (CC BY 4.0); © OpenStreetMap contributors (ODbL).
"""
import math, os, sys
import xml.etree.ElementTree as ET

import numpy as np
import shapely
from PIL import Image
from scipy import ndimage
from shapely.geometry import LineString, MultiLineString, Polygon, Point
from shapely.ops import polygonize, unary_union
from skimage.segmentation import watershed

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
from heights import ring_mask  # noqa: E402
from osm import stitch, to_nztm  # noqa: E402

Image.MAX_IMAGE_PIXELS = None

# carriageway width (kerb to kerb, m) by OSM highway class when the way has no width tag
ROAD_W = {'motorway': 11, 'trunk': 10, 'primary': 11, 'secondary': 10, 'tertiary': 9, 'residential': 7.5, 'unclassified': 7,
          'living_street': 6, 'service': 4.5, 'motorway_link': 6, 'primary_link': 6, 'secondary_link': 6, 'tertiary_link': 6}


# ───────────────────────── inputs ─────────────────────────

def load_lidar(site):
    L = np.load(os.path.join(site, 'lidar.npz'))
    dsm, dem = L['dsm'].astype(np.float32), L['dem'].astype(np.float32)
    dem = np.where(np.isnan(dem), np.nanmedian(dem), dem)
    dsm = np.where(np.isnan(dsm), dem, dsm)
    return dsm, dem


def load_osm(path, E0, N1):
    """Areas (closed ways and multipolygon outers) and lines (open ways) in the site frame, with their tags."""
    r = ET.parse(path).getroot()
    nodes = {}
    pts = []
    for n in r.iter('node'):
        lon, lat = float(n.get('lon')), float(n.get('lat'))
        nodes[n.get('id')] = (lon, lat)
        t = {x.get('k'): x.get('v') for x in n.findall('tag')}
        if t:
            pts.append((n.get('id'), lon, lat, t))
    ids = list(nodes)
    E, N = to_nztm.transform([nodes[i][0] for i in ids], [nodes[i][1] for i in ids])
    xy = {i: (round(e - E0, 2), round(N1 - nn, 2)) for i, e, nn in zip(ids, E, N)}
    ways, areas, lines = {}, [], []
    for w in r.iter('way'):
        ways[w.get('id')] = [nd.get('ref') for nd in w.findall('nd')]
    for el in r:
        if el.tag not in ('way', 'relation'):
            continue
        t = {x.get('k'): x.get('v') for x in el.findall('tag')}
        if el.tag == 'way':
            ref = ways[el.get('id')]
            if any(i not in xy for i in ref) or len(ref) < 2:
                continue
            if len(ref) >= 4 and ref[0] == ref[-1] and t.get('area') != 'no' and 'highway' not in t and t.get('barrier') is None:
                areas.append({'id': 'w' + el.get('id'), 'tags': t, 'ring': [xy[i] for i in ref]})
            else:
                lines.append({'id': 'w' + el.get('id'), 'tags': t, 'pts': [xy[i] for i in ref]})
        elif t.get('type') == 'multipolygon':
            segs = [ways.get(m.get('ref')) for m in el.findall('member') if m.get('type') == 'way' and m.get('role') == 'outer']
            for rg in stitch([s for s in segs if s]):
                if rg[0] == rg[-1] and all(i in xy for i in rg):
                    areas.append({'id': 'r' + el.get('id'), 'tags': t, 'ring': [xy[i] for i in rg]})
    E, N = to_nztm.transform([p[1] for p in pts], [p[2] for p in pts]) if pts else ([], [])
    points = [{'id': p[0], 'tags': p[3], 'x': round(e - E0, 2), 'z': round(N1 - nn, 2)} for p, e, nn in zip(pts, E, N)]
    return areas, lines, points


def aerial_at(site, shape):
    """The aerial resampled to the 1 m LiDAR grid (box mean)."""
    H, W = shape
    return np.asarray(Image.open(os.path.join(site, 'aerial.jpg')).convert('RGB').resize((W, H), Image.BOX), np.float32)


def roads(lines, clip=None):
    """OSM carriageways: [{name, kind, width, pts}] (bridges and tunnels flagged); footways and paths are left out."""
    out = []
    for l in lines:
        t = l['tags']
        k = t.get('highway')
        if k not in ROAD_W:
            continue
        if k == 'service' and t.get('service') in ('parking_aisle', 'driveway'):
            w = 4.0
        else:
            w = ROAD_W[k]
        try:
            w = float(t.get('width', w))
        except ValueError:
            pass
        ls = LineString(l['pts'])
        if clip is not None and not ls.intersects(clip):
            continue
        out.append({'name': t.get('name', ''), 'kind': k, 'width': round(w, 1), 'bridge': t.get('bridge') not in (None, 'no'),
                    'tunnel': t.get('tunnel') not in (None, 'no'), 'pts': [[round(x, 1), round(z, 1)] for x, z in l['pts']]})
    return out


# ───────────────────────── roofs ─────────────────────────

def rect_frame(P):
    """Minimum rotated rectangle as (centre, unit long axis, unit short axis, half long A, half short B)."""
    rr = np.array(P.minimum_rotated_rectangle.exterior.coords)[:4]
    e1, e2 = rr[1] - rr[0], rr[2] - rr[1]
    if np.hypot(*e1) < np.hypot(*e2):
        e1, e2 = e2, e1
    c = rr.mean(0)
    A, B = np.hypot(*e1) / 2, np.hypot(*e2) / 2
    return c, e1 / (2 * A), e2 / (2 * B), A, B


def roof_d(kind, u, v, A, B):
    """Distance to the eave edges (m) of a gable or hip roof in the rectangle frame; 0 for flat."""
    if kind == 'gable':
        return np.maximum(B - np.abs(v), 0)
    if kind == 'hip':
        return np.maximum(np.minimum(B - np.abs(v), A - np.abs(u)), 0)
    return np.zeros_like(u)


def creases(kind, c, ax, ay, A, B):
    """Ridge and hip lines (site frame) of a pitched roof over the rectangle."""
    p = lambda u, v: tuple(c + ax * u + ay * v)
    if kind == 'gable':
        return [LineString([p(-A - 1, 0), p(A + 1, 0)])]
    if kind == 'hip':
        r = max(A - B, 0)
        ls = [LineString([p(-r, 0), p(r, 0)])] if r > 0.05 else []
        for su in (-1, 1):
            for sv in (-1, 1):
                # from the ridge end through the eave corner (at 45° in plan), a little past it
                ls.append(LineString([p(su * r, 0), p(su * (r + 1.3 * (A - r)), sv * 1.3 * B)]))
        return ls
    return []


def fit_roof(P, dsm, dem, rgb, min_pitch=0.15, kinds=('gable', 'hip', 'skel')):
    """Measure one building: base, roof kind, eave, pitch, colour, fit error. None if the LiDAR sees too little of it."""
    ring = list(P.exterior.coords)
    m_all = ring_mask(dsm.shape, ring)
    if m_all.sum() < 4:
        return None
    inner = P.buffer(-0.7)
    m = ring_mask(dsm.shape, list(inner.exterior.coords)) if (not inner.is_empty and inner.geom_type == 'Polygon' and inner.area > 6) else m_all
    if m.sum() < 4:
        m = m_all
    y0 = float(np.percentile(dem[m_all], 3))
    zz, xx = np.nonzero(m)
    h = dsm[zz, xx].astype(np.float64)
    nd = h - dem[zz, xx]
    keep = nd > 1.2  # cells that see the ground through a gap (courtyard, light well) are not roof
    if keep.sum() >= 4:
        zz, xx, h = zz[keep], xx[keep], h[keep]
    col = np.median(rgb[zz, xx], axis=0)
    c, ax, ay, A, B = rect_frame(P)
    px, pz = xx + 0.5 - c[0], zz + 0.5 - c[1]
    u, v = px * ax[0] + pz * ax[1], px * ay[0] + pz * ay[1]
    fits = {}
    dsk = shapely.distance(shapely.points(np.stack([xx + 0.5, zz + 0.5], 1)), P.boundary)
    for kind in ('flat', 'gable', 'hip', 'skel'):
        d = dsk if kind == 'skel' else roof_d(kind, u, v, A, B)
        M = np.stack([np.ones_like(d), d], 1) if kind != 'flat' else np.ones((len(d), 1))
        sel = np.ones(len(h), bool)
        for _ in range(2):
            sol, *_ = np.linalg.lstsq(M[sel], h[sel], rcond=None)
            res = M @ sol - h
            sel = np.abs(res) < max(1.5, 2.5 * np.sqrt(np.mean(res[sel] ** 2)) if sel.sum() else 1.5)
            if sel.sum() < 3:
                sel = np.ones(len(h), bool)
                break
        rms = float(np.sqrt(np.mean(res[sel] ** 2)))
        fits[kind] = (sol, rms, float(sel.mean()))
    (e_flat,), rms_flat, _ = fits['flat']
    best = ('flat', e_flat, 0.0, rms_flat)
    for kind in kinds:
        (e, t), rms, inl = fits[kind]
        rise = t * (B if kind == 'gable' else min(A, B) if kind == 'hip' else float(dsk.max()))
        # a clearly better pitched fit; or, on a house-sized roof that is not flat (rms > 0.5 m), any better pitched fit
        better = rms < 0.75 * rms_flat or (rms_flat > 0.5 and P.area < 600 and rms < 0.95 * rms_flat)
        if min_pitch <= t <= 1.4 and rise > 0.7 and better and rms < best[3] - 0.03:
            best = (kind, float(e), float(t), rms)
    kind, e, t, rms = best
    v_all = (dsm - dem)[m_all]
    return {'y0': round(y0, 2), 'kind': kind, 'eave': round(e, 2), 'pitch': round(t, 3), 'rms': round(rms, 2),
            'rms_flat': round(rms_flat, 2), 'frame': [[round(c[0], 2), round(c[1], 2)], [round(ax[0], 4), round(ax[1], 4)],
                                                       [round(ay[0], 4), round(ay[1], 4)], round(A, 2), round(B, 2)],
            'roof': [int(col[0]), int(col[1]), int(col[2])], 'area': round(P.area, 1),
            'p10': round(float(np.percentile(v_all, 10)), 1), 'p90': round(float(np.percentile(v_all, 90)), 1)}


def skel_facets(P, step=0.6):
    """Hipped roof over any outline: each wall edge's facet = the points nearer to it than to any other edge (Voronoi of
    the densified outline, merged per edge). Returns [(facet polygon, edge a, edge b)]; the facet rises from its edge."""
    rings = [list(P.exterior.coords)] + [list(r.coords) for r in P.interiors]
    pts, own, edges = [], [], []
    for rc in rings:
        for i in range(len(rc) - 1):
            a, b = np.array(rc[i]), np.array(rc[i + 1])
            L = np.hypot(*(b - a))
            if L < 1e-6:
                continue
            n = max(1, int(L / step))
            for k in range(n):
                pts.append(a + (b - a) * ((k + 0.5) / n))
                own.append(len(edges))
            edges.append((a, b))
    from shapely.geometry import MultiPoint
    mp = MultiPoint(pts)
    vor = shapely.voronoi_polygons(mp, extend_to=P.envelope.buffer(5))
    tree = shapely.STRtree(shapely.points(np.array(pts)))
    cells = {}
    for cell in vor.geoms:
        idx = tree.query(cell, predicate='contains')
        if len(idx):
            cells.setdefault(own[idx[0]], []).append(cell)
    out = []
    for e, cs in cells.items():
        try:
            f = unary_union(cs).intersection(P)
        except shapely.errors.GEOSException:  # an invalid Voronoi cell (one Mission Bay house): repair the cells first
            f = unary_union([shapely.make_valid(c).buffer(0) for c in cs]).intersection(P)
        if not f.is_empty and f.area > 0.01:
            out.append((f, edges[e][0], edges[e][1]))
    return out


def edge_dist(a, b, x, z):
    """Perpendicular distance from the line through edge a→b (m), either side."""
    d = b - a
    L = np.hypot(*d)
    return np.abs((np.asarray(x) - a[0]) * d[1] - (np.asarray(z) - a[1]) * d[0]) / L


def roof_height(b, x, z, edge=None):
    if b['kind'] == 'skel':
        if edge is not None:
            return b['eave'] + b['pitch'] * edge_dist(edge[0], edge[1], x, z)
        return b['eave'] + b['pitch'] * shapely.distance(shapely.points(np.stack([np.ravel(x), np.ravel(z)], 1)), b['_P'].boundary).reshape(np.shape(x))
    (c, ax, ay, A, B) = b['frame']
    px, pz = np.asarray(x) - c[0], np.asarray(z) - c[1]
    u, v = px * ax[0] + pz * ax[1], px * ay[0] + pz * ay[1]
    return b['eave'] + b['pitch'] * roof_d(b['kind'], u, v, A, B)


def terraces(P, dsm, dem, levels=3, min_area=25):
    """A big flat building whose roof steps: height bands (1-D k-means), mode-filtered, traced and clipped to P."""
    from rasterio import features
    from rasterio.transform import Affine
    m = ring_mask(dsm.shape, list(P.exterior.coords))
    v = dsm[m]
    if v.size < 50:
        return None
    cs = np.percentile(v, np.linspace(15, 90, levels))
    for _ in range(12):
        lab = np.argmin(np.abs(v[:, None] - cs[None]), 1)
        cs = np.array([v[lab == k].mean() if (lab == k).any() else cs[k] for k in range(levels)])
    # merge bands closer than 2 m
    cs = np.sort(cs)
    keep = [cs[0]]
    for cc in cs[1:]:
        if cc - keep[-1] > 2.0:
            keep.append(cc)
    cs = np.array(keep)
    if len(cs) < 2:
        return None
    grid = np.full(dsm.shape, -1, np.int16)
    grid[m] = np.argmin(np.abs(dsm[m][:, None] - cs[None]), 1)
    zz, xx = np.nonzero(m)
    z0, z1, x0, x1 = zz.min(), zz.max() + 1, xx.min(), xx.max() + 1
    sub = grid[z0:z1, x0:x1]
    sm = ndimage.generic_filter(sub, lambda w: np.bincount(w[w >= 0].astype(int)).argmax() if (w >= 0).any() else -1, size=3, mode='nearest')
    sm = np.where(sub >= 0, sm, -1).astype(np.int16)
    out = []
    for geom, val in features.shapes(sm, mask=sm >= 0, transform=Affine(1, 0, x0, 0, 1, z0)):
        g = shapely.geometry.shape(geom).intersection(P).simplify(1.2)
        for q in getattr(g, 'geoms', [g]):
            if q.geom_type == 'Polygon' and q.area >= min_area:
                out.append((q, float(cs[int(val)])))
    return out if len(out) > 1 else None


# ───────────────────────── mesh ─────────────────────────

def _noded_ring(coords, cuts):
    """Insert the points where the crease lines cross the ring's edges, and densify edges to ≤ 3 m."""
    out = []
    for i in range(len(coords) - 1):
        a, b = np.array(coords[i]), np.array(coords[i + 1])
        seg = LineString([a, b])
        L = seg.length
        ts = [0.0]
        if cuts is not None and seg.intersects(cuts):
            x = seg.intersection(cuts)
            for p in getattr(x, 'geoms', [x]):
                if p.geom_type == 'Point':
                    ts.append(seg.project(p) / max(L, 1e-9))
        n = int(L // 3)
        ts += [k / (n + 1) for k in range(1, n + 1)]
        for t in sorted(set(round(t, 6) for t in ts)):
            if t < 1:
                out.append(tuple(a + (b - a) * t))
    return out


def mesh_building(P, b, walls_to=None):
    """(positions [n,3], triangles [m,3], face kind [m] 0 wall / 1 roof) for one building in the site frame."""
    pos, tri, kind = [], [], []
    y0 = b['y0'] if walls_to is None else walls_to
    b = dict(b, _P=P)
    hfun = (lambda x, z: roof_height(b, x, z)) if 'frame' in b else (lambda x, z: np.full(np.shape(x), b['eave']))
    cl = None
    if b.get('kind') in ('gable', 'hip'):
        c, ax, ay, A, B = b['frame']
        cl = unary_union([l.intersection(P.buffer(0.01)) for l in creases(b['kind'], np.array(c), np.array(ax), np.array(ay), A, B)])
        if cl.is_empty:
            cl = None
    # roof: split along the creases into planar faces, triangulate each
    if b.get('kind') == 'skel':
        faces = skel_facets(P)
    elif cl is not None:
        faces = [f for f in polygonize(unary_union([P.boundary, cl])) if P.buffer(0.05).contains(f.representative_point()) and f.area > 0.01]
        faces = [(f.intersection(P), None, None) for f in faces]
    else:
        faces = [(P, None, None)]
    for f, ea, eb in faces:
        if ea is not None:
            hfun_f = lambda x, z, ea=ea, eb=eb: roof_height(b, x, z, (ea, eb))
        else:
            hfun_f = hfun
        for g in getattr(f, 'geoms', [f]):
            if g.geom_type != 'Polygon' or g.area < 0.01:
                continue
            g = shapely.segmentize(g, 4.0)
            tris = shapely.constrained_delaunay_triangles(g)
            for t in tris.geoms:
                cc = np.array(t.exterior.coords)[:3]
                cen = cc.mean(0)
                # evaluate at a point nudged towards the centroid so a vertex on a crease takes this face's plane
                hh = hfun_f(cc[:, 0] + (cen[0] - cc[:, 0]) * 1e-3, cc[:, 1] + (cen[1] - cc[:, 1]) * 1e-3)
                k = len(pos)
                # counter-clockwise seen from above in x/z with +z south means clockwise in (x, z); keep normals up
                a, bb, cpt = cc
                cross = (bb[0] - a[0]) * (cpt[1] - a[1]) - (bb[1] - a[1]) * (cpt[0] - a[0])
                order = (0, 2, 1) if cross > 0 else (0, 1, 2)
                for j in order:
                    pos.append((cc[j, 0], float(hh[j]), cc[j, 1]))
                tri.append((k, k + 1, k + 2))
                kind.append(1)
    # walls: every ring (outer and holes), noded where the creases cross it, from y0 up to the roof
    rings = [list(P.exterior.coords)] + [list(r.coords) for r in P.interiors]
    for ri, rc in enumerate(rings):
        pts = _noded_ring(rc, cl)
        n = len(pts)
        if n < 3:
            continue
        arr = np.array(pts)
        top = np.full(n, b['eave']) if b.get('kind') == 'skel' else hfun(arr[:, 0], arr[:, 1])
        # outward = to the right of the edge when the ring is clockwise in (x, z)... decide by signed area
        sa = 0.5 * np.sum(arr[:, 0] * np.roll(arr[:, 1], -1) - np.roll(arr[:, 0], -1) * arr[:, 1])
        flip = (sa > 0) != (ri > 0)
        for i in range(n):
            j = (i + 1) % n
            k = len(pos)
            pos += [(arr[i, 0], y0, arr[i, 1]), (arr[j, 0], y0, arr[j, 1]), (arr[j, 0], float(top[j]), arr[j, 1]), (arr[i, 0], float(top[i]), arr[i, 1])]
            if flip:
                tri += [(k, k + 2, k + 1), (k, k + 3, k + 2)]
            else:
                tri += [(k, k + 1, k + 2), (k, k + 2, k + 3)]
            kind += [0, 0]
    return np.array(pos, np.float64), np.array(tri, np.int64), np.array(kind, np.uint8)


# ───────────────────────── trees and blobs ─────────────────────────

def is_green(r, g, b):
    return 2 * g - r - b >= 6 and (r + g + b) / 3 < 150


def tree_crowns(nd, dem, rgb, mask):
    """One crown per LiDAR tree inside `mask` (Domain method). Returns (trees, dropped crowns' label image, labels)."""
    canopy = ndimage.binary_opening((nd > 2.5) & mask, iterations=1)
    sm = ndimage.gaussian_filter(np.where(canopy, nd, 0), 1.0)
    peaks = np.zeros_like(canopy)
    for lo, hi, w in ((2.5, 12, 3), (12, 22, 5), (22, 99, 7)):
        mx = ndimage.maximum_filter(sm, size=w)
        peaks |= (sm == mx) & (sm > lo) & (sm <= hi) & canopy
    lab, n = ndimage.label(peaks)
    tops = ndimage.center_of_mass(peaks, lab, range(1, n + 1))
    markers = np.zeros(nd.shape, np.int32)
    for i, (r, c) in enumerate(tops, 1):
        markers[int(round(r)), int(round(c))] = i
    crowns = watershed(-sm, markers, mask=canopy)
    idx = np.arange(1, n + 1)
    area = ndimage.sum(np.ones_like(nd), crowns, idx)
    top = ndimage.maximum(nd, crowns, idx)
    cr, cg, cb = (ndimage.mean(rgb[..., k], crowns, idx) for k in range(3))
    trees, rejected = [], np.zeros(n + 1, bool)
    for i in range(n):
        if area[i] < 3 or top[i] < 2.5:
            rejected[i + 1] = True
            continue
        if not is_green(cr[i], cg[i], cb[i]):
            rejected[i + 1] = True
            continue
        r, c = tops[i]
        x, z = c + 0.5, r + 0.5
        hgt = float(top[i])
        rad = float(np.clip(1.1 * math.sqrt(area[i] / math.pi), 1.0, 17))
        base = hgt * (0.5 if hgt < 6 else 0.3)
        g = float(dem[int(r), int(c)])
        trees.append([round(x, 1), round(z, 1), round(g, 1), round(g + hgt, 1), round(rad, 1), round(g + base, 1),
                      int(cr[i]), int(cg[i]), int(cb[i])])
    return trees, crowns, rejected


def blobs(mask, min_area):
    """Connected components of a mask as shapely polygons (traced on the 1 m grid) with their pixel masks' labels."""
    from rasterio import features
    lab, n = ndimage.label(mask)
    out = []
    if n == 0:
        return out, lab
    sizes = ndimage.sum(np.ones_like(lab), lab, range(1, n + 1))
    keep = np.zeros(n + 1, bool)
    keep[1:] = sizes >= min_area
    lab = np.where(keep[lab], lab, 0).astype(np.int32)
    for geom, val in features.shapes(lab, mask=lab > 0):
        out.append((int(val), shapely.geometry.shape(geom)))
    return out, lab


def pack_mesh(parts):
    """Concatenate (pos, tri, kind, colour index) parts into flat arrays."""
    P, T, K, C = [], [], [], []
    off = 0
    for pos, tri, kind, ci in parts:
        if len(tri) == 0:
            continue
        P.append(pos)
        T.append(tri + off)
        K.append(kind)
        C.append(np.full(len(pos), ci, np.int32))
        off += len(pos)
    if not P:
        return np.zeros((0, 3)), np.zeros((0, 3), np.int64), np.zeros(0, np.uint8), np.zeros(0, np.int32)
    return np.concatenate(P), np.concatenate(T), np.concatenate(K), np.concatenate(C)


def write_glb(path, pos, tri, colours, origin):
    """The buildings as one glTF binary (vertex colours, metres, y up, x east, z south → glTF −z north)."""
    import trimesh
    v = pos - np.array([origin[0], 0, origin[1]])
    m = trimesh.Trimesh(vertices=v, faces=tri, vertex_colors=colours, process=False)
    m.export(path)


# ───────────────────────── one area, end to end ─────────────────────────

WALLS = [(236, 233, 224), (226, 222, 210), (242, 240, 234), (214, 210, 200), (200, 196, 188), (228, 220, 200)]
WALLS_BIG = [(190, 188, 182), (172, 172, 170), (206, 202, 192)]


def plane_rms(h, zz, xx):
    M = np.stack([np.ones(len(h)), xx, zz], 1)
    sol, *_ = np.linalg.lstsq(M, h, rcond=None)
    return float(np.sqrt(np.mean((M @ sol - h) ** 2)))


def model_area(site, osm_path, area, exclude=None, log=print):
    """Buildings (OSM + traced), trees, roads and piers inside `area` (site-frame Polygon). `exclude`: a Polygon kept
    clear (another layer, e.g. the Harbour Bridge). Returns (model dict, mesh dict, helper grids)."""
    S = __import__('json').load(open(os.path.join(site, 'site.json')))
    E0, N1 = S['box_nztm'][0], S['box_nztm'][3]
    dsm, dem = load_lidar(site)
    nd = np.clip(dsm - dem, 0, None)
    H, W = nd.shape
    rgb = aerial_at(site, nd.shape)
    areas, lines, points = load_osm(osm_path, E0, N1)
    area_m = ring_mask(nd.shape, list(area.exterior.coords))
    for hole in area.interiors:
        area_m &= ~ring_mask(nd.shape, list(hole.coords))
    excl = exclude if exclude is not None else Polygon()
    excl_m = ring_mask(nd.shape, list(excl.exterior.coords)) if not excl.is_empty and excl.geom_type == 'Polygon' else np.zeros_like(area_m)
    if not excl.is_empty and excl.geom_type == 'MultiPolygon':
        excl_m = np.zeros_like(area_m)
        for g in excl.geoms:
            excl_m |= ring_mask(nd.shape, list(g.exterior.coords))

    # ── OSM buildings ──
    blds, meshes = [], []
    bld_m = np.zeros_like(area_m)
    stats = {'osm_buildings': 0, 'kinds': {}, 'terraced': 0}
    for a in areas:
        t = a['tags']
        if 'building' not in t:
            continue
        P = Polygon(a['ring']).buffer(0)
        if P.geom_type == 'MultiPolygon':
            P = max(P.geoms, key=lambda g: g.area)
        if P.is_empty or P.area < 8 or not area.contains(P.representative_point()) or excl.intersects(P):
            continue
        x0, z0, x1, z1 = P.bounds
        if x0 < 1 or z0 < 1 or x1 > W - 1 or z1 > H - 1:
            continue
        P = P.simplify(0.25)
        b = fit_roof(P, dsm, dem, rgb)
        if b is None:
            continue
        bld_m |= ndimage.binary_dilation(ring_mask(nd.shape, list(P.exterior.coords)), iterations=1)
        big = P.area > 300 or t.get('building') in ('apartments', 'commercial', 'retail', 'industrial', 'warehouse', 'school', 'church', 'office')
        h = (hash(a['id']) & 0xffff)
        wall = (WALLS_BIG if big else WALLS)[h % len(WALLS_BIG if big else WALLS)]
        parts = [(P, b)]
        if b['kind'] == 'flat' and P.area > 250 and b['p90'] - b['p10'] > 3.0:
            tr = terraces(P, dsm, dem)
            if tr:
                stats['terraced'] += 1
                parts = [(q, dict(b, kind='flat', eave=round(hh, 2), frame=None)) for q, hh in tr]
        for q, bb in parts:
            if bb.get('frame') is None:
                bb = {k: v for k, v in bb.items() if k != 'frame'}
            pos, tri, kind = mesh_building(q, bb)
            col = np.where(kind[:, None] == 1, np.array(bb['roof'])[None], np.array(wall)[None])  # one colour per triangle
            meshes.append((pos, tri, col))
            blds.append({'id': a['id'], 'src': 'osm', 'tag': t.get('building'), 'name': t.get('name', ''),
                         'levels': t.get('building:levels'), 'ring': [[round(x, 2), round(z, 2)] for x, z in q.exterior.coords],
                         **{k: v for k, v in bb.items() if not k.startswith('_')}, 'wall': list(wall)})
        stats['osm_buildings'] += 1
        stats['kinds'][b['kind']] = stats['kinds'].get(b['kind'], 0) + 1

    # ── trees (green crowns) and traced buildings (smooth, not green) ──
    free = area_m & ~bld_m & ~excl_m & (dem > -0.9)  # land: the LiDAR flattens open water to −1.14 m (boats are not trees)
    trees, crowns, rejected = tree_crowns(nd, dem, rgb, free)
    log(f'trees {len(trees)}')
    cand = (nd > 2.5) & free & rejected[crowns] & (crowns > 0)
    cand = ndimage.binary_opening(cand, iterations=1)
    traced = 0
    bl, lab = blobs(cand, 30)
    for val, g in bl:
        m = lab == val
        zz, xx = np.nonzero(m)
        hs = dsm[zz, xx]
        col = np.median(rgb[zz, xx], 0)
        if plane_rms(hs, zz, xx) > 0.8 or is_green(*col):
            continue
        P = g.simplify(1.0).buffer(0)
        if P.geom_type != 'Polygon' or P.area < 25:
            continue
        b = fit_roof(P, dsm, dem, rgb)
        if b is None:
            continue
        b = {k: v for k, v in b.items() if k != 'frame'} if b['kind'] == 'flat' else b
        pos, tri, kind = mesh_building(P, b)
        wall = WALLS[traced % len(WALLS)]
        col = np.where(kind[:, None] == 1, np.array(b['roof'])[None], np.array(wall)[None])
        meshes.append((pos, tri, col))
        blds.append({'id': f't{traced}', 'src': 'traced', 'ring': [[round(x, 2), round(z, 2)] for x, z in P.exterior.coords], **b, 'wall': list(wall)})
        traced += 1
    stats['traced_buildings'] = traced

    # ── piers / jetties / boardwalks (OSM areas, or lines with a width) ──
    piers = []
    for a in areas:
        if a['tags'].get('man_made') in ('pier', 'jetty') or a['tags'].get('man_made') == 'breakwater':
            P = Polygon(a['ring']).buffer(0)
            # a jetty that starts in the area belongs to it, out over the water
            if not P.is_empty and area.buffer(5).intersects(P) and not excl.intersects(P):
                for g in getattr(P, 'geoms', [P]):
                    if g.geom_type == 'Polygon' and g.area > 4:
                        m = ring_mask(nd.shape, list(g.exterior.coords))
                        y = float(np.median(dsm[m])) if m.sum() > 2 else 2.5
                        piers.append({'ring': [[round(x, 2), round(z, 2)] for x, z in g.exterior.coords], 'y': round(y, 2),
                                      'kind': a['tags'].get('man_made'), 'floating': a['tags'].get('floating') == 'yes'})
    for l in lines:
        t = l['tags']
        if t.get('man_made') in ('pier', 'jetty', 'breakwater') and len(l['pts']) >= 2:
            w = 2.5
            try:
                w = float(t.get('width', w))
            except ValueError:
                pass
            ls = LineString(l['pts'])
            if not ls.intersects(area.buffer(5)) or excl.intersects(ls):
                continue
            g = ls.buffer(w / 2, cap_style='flat')
            for q in getattr(g, 'geoms', [g]):
                if q.geom_type == 'Polygon' and q.area > 2:
                    m = ring_mask(nd.shape, list(q.exterior.coords))
                    y = float(np.median(dsm[m])) if m.sum() > 2 else 1.5
                    piers.append({'ring': [[round(x, 2), round(z, 2)] for x, z in q.exterior.coords], 'y': round(y, 2),
                                  'kind': t.get('man_made'), 'floating': t.get('floating') == 'yes', 'width': w})

    # ── roads: not modelled, checked ──
    rd = roads(lines, area.buffer(40))
    carriage = unary_union([LineString(r['pts']).buffer(r['width'] / 2, cap_style='flat') for r in rd if not r['bridge'] and not r['tunnel'] and len(r['pts']) > 1])
    carriage_in = carriage.intersection(area)
    over = []
    for b in blds:
        P = Polygon(b['ring'])
        x = P.intersection(carriage).area if P.intersects(carriage) else 0
        if x > 2:
            over.append((b['id'], round(x, 1), round(P.area, 1)))
    trunk_on_road = sum(1 for t in trees if carriage.contains(Point(t[0], t[1])))
    overhang = sum(1 for t in trees if Point(t[0], t[1]).buffer(t[4]).intersects(carriage))
    # ground along the roads: the cross-fall a flat ribbon would have to hide
    stats['roads'] = {'ways': len(rd), 'carriageway_ha': round(carriage_in.area / 1e4, 2), 'area_share_pct': round(100 * carriage_in.area / area.area, 1),
                      'buildings_over_road': len(over), 'buildings_over_road_m2': round(sum(o[1] for o in over), 1),
                      'worst_overlaps': sorted(over, key=lambda o: -o[1])[:8],
                      'trees_rooted_on_road': trunk_on_road, 'trees_overhanging_road': overhang}
    pos, tri, kind, _ = pack_mesh([(m[0], m[1], np.zeros(len(m[1]), np.uint8), 0) for m in meshes])
    cols = np.concatenate([m[2] for m in meshes]).astype(np.uint8) if meshes else np.zeros((0, 3), np.uint8)
    mesh = {'pos': pos, 'tri': tri, 'tcol': cols}
    hts = np.array([t[3] - t[2] for t in trees]) if trees else np.zeros(1)
    stats.update({'area_ha': round(area.area / 1e4, 1), 'trees': len(trees), 'tree_h_median': round(float(np.median(hts)), 1),
                  'tree_h_p90': round(float(np.percentile(hts, 90)), 1), 'buildings_total': len(blds), 'triangles': int(len(tri)),
                  'canopy_ha': round(float(((nd > 2.5) & free & (crowns > 0) & ~rejected[crowns]).sum()) / 1e4, 1)})
    canopy = canopy_grid(nd, free)
    model = {'E0': E0, 'N1': N1, 'size': W, 'canopy': canopy, 'footprint': [[round(x, 1), round(z, 1)] for x, z in area.exterior.coords],
             'buildings': blds, 'trees': trees, 'piers': piers, 'roads': rd, 'stats': stats}
    return model, mesh, {'dsm': dsm, 'dem': dem, 'nd': nd, 'rgb': rgb, 'area_m': area_m, 'areas': areas, 'lines': lines, 'points': points}


def canopy_grid(nd, free, cell=20):
    """The cheap alternative to one record per tree: per `cell` m square, the share of it under canopy (nDSM > 2.5 m on
    free land, off buildings) in sixteenths and the canopy's p75 height in 0.5 m steps. The game scatters its own
    trees to match (density and height per cell, positions random, kept off buildings and roads by its own layers)."""
    H, W = nd.shape
    ny, nx = H // cell, W // cell
    can = (nd > 2.5) & free
    c = can[:ny * cell, :nx * cell].reshape(ny, cell, nx, cell)
    cover = np.round(c.mean((1, 3)) * 15).astype(int)
    h = np.where(can, nd, np.nan)[:ny * cell, :nx * cell].reshape(ny, cell, nx, cell).transpose(0, 2, 1, 3).reshape(ny, nx, -1)
    with np.errstate(all='ignore'):
        import warnings
        warnings.simplefilter('ignore')
        p75 = np.nan_to_num(np.nanpercentile(h, 75, axis=2))
    height = np.clip(np.round(p75 * 2), 0, 255).astype(int)
    return {'cell': cell, 'nx': int(nx), 'ny': int(ny), 'cover': cover.ravel().tolist(), 'height': np.where(cover > 0, height, 0).ravel().tolist()}
