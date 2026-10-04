"""
F35-A — hero neighbourhoods: Westhaven (Westhaven Marina and its waterfront strip) measured from LiDAR, for the
neighbourhoods review page (tools/hero/sites/neighbourhoods_page.py).

  python3 tools/hero/site.py --name westhaven --lat -36.8395 --lon 174.7480 --size 1500 --res 0.3
  curl -o /tmp/hero/osm/westhaven.osm "https://api.openstreetmap.org/api/0.6/map?bbox=174.7385,-36.8465,174.7575,-36.8325"
  python3 tools/hero/sites/westhaven.py --site /tmp/hero/westhaven --osm /tmp/hero/osm/westhaven.osm
      → <site>/model.json, <site>/mesh.npz, <site>/westhaven.glb

Scope (traced by hand on the 2024 aerial, site frame): the marina inside its northern breakwater and the eastern
breakwater, and the reclaimed strip along Westhaven Drive, bounded on the land side by the north-east edge of the SH1
motorway from the Harbour Bridge to St Marys Bay, and on the east by a line at the Westhaven / Wynyard Quarter boundary.
The Harbour Bridge is its own hero (src/core/harbourBridge.ts) and is kept clear.
On top of the kit (neighbourhood.py: buildings, trees, roads check):
  boats and pontoons  shapes from the 2024 aerial at 0.3 m, heights from the LiDAR (OSM maps the main walkways but few
            finger berths; the 1 m LiDAR merges low hulls with the pontoons). Over the water (which the LiDAR flattens to
            −1.14 m) everything bright is boat or pontoon; an opening with a 2.1 m disc keeps the hulls and drops fingers
            and walkways, a distance watershed splits touching hulls, the rest is pontoon. Each boat = minimum rotated
            rectangle (length, beam, heading); deck = p60 of the LiDAR inside it, cabin = p95 below any mast, mast = the
            highest return within 1 m when it stands ≥ 4 m above the deck (masts are 15 cm wide: the 1 m DSM catches many,
            not all, and the LiDAR was flown on another day than the photo, so a berth can differ). Colour = aerial.
Data: LINZ 2024 LiDAR and aerial (CC BY 4.0); © OpenStreetMap contributors (ODbL).
"""
import argparse, json, math, os, sys

import numpy as np
import shapely
from scipy import ndimage
from shapely.geometry import Polygon, Point
from shapely.ops import unary_union
from skimage.segmentation import watershed

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from neighbourhood import blobs, model_area, write_glb  # noqa: E402
from heights import ring_mask  # noqa: E402

# site frame (m), traced on aerial.jpg: the motorway's NE edge, the Wynyard boundary, the breakwaters
AREA = [(305, 232), (262, 300), (236, 380), (232, 470), (250, 560), (300, 640), (370, 700), (470, 790), (560, 880), (600, 960),
        (630, 1030), (720, 1060), (860, 1085), (960, 1130), (1015, 1160), (1015, 830), (1085, 720), (1085, 640), (1195, 570),
        (1255, 395), (1312, 392), (1305, 365), (955, 322), (305, 232)]
WATER = -1.0  # LiDAR DEM/DSM over open water is flattened to −1.14 m


def bridge_exclusion(areas, lines, area):
    """The Harbour Bridge and its motorway approach inside the box, buffered: kept clear for its own hero."""
    from shapely.geometry import LineString
    parts = []
    for a in areas:
        if a['tags'].get('man_made') == 'bridge':
            P = Polygon(a['ring']).buffer(0)
            if P.intersects(area.buffer(50)):
                parts.append(P.buffer(4))
    for l in lines:
        t = l['tags']
        if t.get('highway') in ('motorway', 'motorway_link') and len(l['pts']) > 1:
            parts.append(LineString(l['pts']).buffer(9))
    return unary_union(parts)


def boats_and_pontoons(site, dsm, dem, area_m, bld_m, res=0.3):
    """Boats and pontoons: shapes from the 2024 aerial (0.3 m), heights from the LiDAR.

    Over the water (the LiDAR's flattened −1.14 m) anything bright in the photo (red > 100; the water reads ~60) is a
    boat or a pontoon. An opening with a 2.1 m disc removes the fingers (1.2 m) and most walkways (2 m), leaving the hulls
    (beam ≥ 2.5 m), which a watershed of the distance map splits where two touch (h-maxima ≥ 0.75 m, so a hull's ridge stays whole); what is left of the bright pixels is pontoon.
    Long thin survivors (a walkway, L > 40 m or L/B > 5.5) go back to the pontoons."""
    from PIL import Image
    from rasterio import features
    from rasterio.transform import Affine
    from skimage.morphology import disk
    from skimage.morphology import h_maxima
    img = np.asarray(Image.open(os.path.join(site, 'aerial.jpg')).convert('RGB'))
    k = img.shape[0] / dsm.shape[0]
    water = (dem < WATER) & area_m & ~bld_m
    up = lambda m: np.asarray(Image.fromarray(m.astype(np.uint8) * 255).resize((img.shape[1], img.shape[0]), Image.NEAREST)) > 127
    wu = up(ndimage.binary_dilation(water, iterations=1) & area_m & ~bld_m)
    obj = ((img[..., 0].astype(np.int16) > 100) | (img.astype(np.int16).sum(2) > 360)) & wu
    obj = ndimage.binary_opening(obj, iterations=1)
    hull = ndimage.binary_opening(obj, structure=disk(3))
    dist = ndimage.distance_transform_edt(hull)
    # one marker per dome of the distance map at least 0.75 m high: a hull's own ridge stays one marker, two hulls
    # touching side by side (a neck) get two
    mk, _ = ndimage.label(h_maxima(ndimage.gaussian_filter(dist, 1.0), 2.5) & hull)
    reg = watershed(-dist, mk, mask=hull)
    pont_lvl = water & (dsm > -0.45) & (dsm <= 0.45)
    deck_level = float(np.median(dsm[pont_lvl])) if pont_lvl.any() else -0.1
    sea = deck_level - 0.5  # pontoons float ~0.5 m proud of the water
    boats, walk = [], np.zeros_like(hull)

    def rect_of(m, sl):
        rr_, cc_ = np.nonzero(m)
        pts = np.stack([(cc_ + sl[1].start + 0.5) * res, (rr_ + sl[0].start + 0.5) * res], 1)
        rect = np.array(shapely.MultiPoint(pts).convex_hull.buffer(res / 2).minimum_rotated_rectangle.exterior.coords)[:4]
        e1, e2 = rect[1] - rect[0], rect[2] - rect[1]
        if np.hypot(*e1) < np.hypot(*e2):
            e1, e2 = e2, e1
        L, B = float(np.hypot(*e1)), float(np.hypot(*e2))
        return rect, e1, L, B, m.sum() * res * res / max(L * B, 1e-6)

    pieces = [(reg[sl] == i, sl, 0) for i, sl in enumerate(ndimage.find_objects(reg), 1) if sl is not None]
    while pieces:
        m, sl, depth = pieces.pop()
        if m.sum() * res * res < 5:
            continue
        rect, e1, L, B, fill = rect_of(m, sl)
        if L > 40 or L / max(B, 0.1) > 5.5:
            walk[sl] |= m
            continue
        # a blob too wide or too ragged for one hull is two or more that touch: split it again, finer
        if (fill < 0.62 or B > 6.5) and depth < 2:
            d = ndimage.distance_transform_edt(m)
            sub, ns = ndimage.label(h_maxima(ndimage.gaussian_filter(d, 0.7), 1.2 if depth == 0 else 0.6) & m)
            if ns > 1:
                rg = watershed(-d, sub, mask=m)
                for j, s2 in enumerate(ndimage.find_objects(rg), 1):
                    if s2 is not None:
                        g = (slice(sl[0].start + s2[0].start, sl[0].start + s2[0].stop), slice(sl[1].start + s2[1].start, sl[1].start + s2[1].stop))
                        pieces.append((rg[s2] == j, g, depth + 1))
                continue
        if L < 3.5 or B < 1.5 or fill < 0.45:
            continue
        c = rect.mean(0)
        poly = Polygon(rect)
        mm = ring_mask(dsm.shape, list(poly.exterior.coords))
        h = dsm[mm]
        h = h[h > 0.45]
        deck = float(np.percentile(h, 60)) if h.size >= 3 else sea + 1.2
        cabin = float(np.percentile(h[h < deck + 4], 95)) if (h < deck + 4).sum() >= 3 else deck
        near = dsm[ring_mask(dsm.shape, list(poly.buffer(1.0).exterior.coords))]
        top = float(near.max()) if near.size else deck
        mast = round(top - sea, 1) if top > deck + 4 else 0
        col = np.median(img[sl][m], 0)
        boats.append([round(float(c[0]), 1), round(float(c[1]), 1), round(math.atan2(e1[1], e1[0]), 3), round(L, 1), round(B, 1),
                      round(max(deck - sea, 0.6), 1), round(max(cabin - deck, 0), 1), mast, int(col[0]), int(col[1]), int(col[2])])
    pont = (obj & ~ndimage.binary_dilation(hull & ~walk, iterations=2)) | walk
    pont = ndimage.binary_opening(pont, iterations=1)
    pontoons = []
    lab, nlab = ndimage.label(pont)
    sizes = ndimage.sum(np.ones_like(lab), lab, range(1, nlab + 1))
    keep = np.zeros(nlab + 1, bool)
    keep[1:] = sizes * res * res >= 3
    lab = np.where(keep[lab], lab, 0).astype(np.int32)
    for geom, val in features.shapes(lab, mask=lab > 0, transform=Affine(res, 0, 0, 0, res, 0)):
        P = shapely.geometry.shape(geom).simplify(0.3).buffer(0)
        for q in getattr(P, 'geoms', [P]):
            if q.geom_type == 'Polygon' and q.area >= 3:
                pontoons.append({'ring': [[round(x, 2), round(z, 2)] for x, z in q.exterior.coords], 'y': round(deck_level, 2)})
    return boats, pontoons, sea


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--site', required=True)
    ap.add_argument('--osm', required=True)
    a = ap.parse_args()
    from neighbourhood import load_osm
    S = json.load(open(os.path.join(a.site, 'site.json')))
    area = Polygon(AREA)
    areas, lines, _ = load_osm(a.osm, S['box_nztm'][0], S['box_nztm'][3])
    excl = bridge_exclusion(areas, lines, area).intersection(area.buffer(30))
    model, mesh, G = model_area(a.site, a.osm, area, exclude=excl)
    bld_m = np.zeros_like(G['area_m'])
    for b in model['buildings']:
        bld_m |= ring_mask(bld_m.shape, b['ring'])
    for p in model['piers']:
        bld_m |= ring_mask(bld_m.shape, p['ring'])
    excl_m = np.zeros_like(bld_m)
    for g in getattr(excl, 'geoms', [excl]):
        if g.geom_type == 'Polygon':
            excl_m |= ring_mask(bld_m.shape, list(g.exterior.coords))
    boats, pontoons, sea = boats_and_pontoons(a.site, G['dsm'], G['dem'], G['area_m'] & ~excl_m, bld_m)
    model['name'] = 'Westhaven'
    model['boats'] = boats
    model['pontoons'] = pontoons
    model['sea'] = round(sea, 2)
    model['exclude'] = [[[round(x, 1), round(z, 1)] for x, z in g.exterior.coords] for g in getattr(excl, 'geoms', [excl]) if g.geom_type == 'Polygon']
    model['stats'].update({'boats': len(boats), 'sailboats': sum(1 for b in boats if b[7] > 0), 'pontoon_m2': round(sum(Polygon(p['ring']).area for p in pontoons)),
                           'boat_len_median': round(float(np.median([b[3] for b in boats])), 1) if boats else 0})
    json.dump(model, open(os.path.join(a.site, 'model.json'), 'w'))
    np.savez_compressed(os.path.join(a.site, 'mesh.npz'), **mesh)
    write_glb(os.path.join(a.site, 'westhaven.glb'), mesh['pos'][mesh['tri'].ravel()], np.arange(len(mesh['tri']) * 3).reshape(-1, 3),
              np.repeat(mesh['tcol'], 3, 0), (model['size'] / 2, model['size'] / 2))
    print(json.dumps(model['stats'], indent=1))


if __name__ == '__main__':
    main()
