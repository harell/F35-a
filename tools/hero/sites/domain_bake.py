"""
F35-A — bakes the Auckland Domain (tools/hero/sites/auckland_domain.py → domain_model.json, built with the museum's
model on --exclude) into the game's src/world/scenery/data/auckland-domain.bin (gzip), decoded by
src/world/scenery/aucklandDomain.ts.

  python3 tools/hero/sites/auckland_museum.py --site /tmp/hero/museum
  python3 tools/hero/sites/auckland_domain.py --site /tmp/hero/auckland_domain --exclude /tmp/hero/museum/museum_model.json
  python3 tools/hero/sites/domain_bake.py --site /tmp/hero/auckland_domain

What ships (parameters, not triangles): the park's outline; its buildings (the game's LINZ list has none in the
Domain): the OSM outline with its LiDAR roof over the lowest ground in it, the roof's colour from the aerial, and the two
Wintergarden glasshouses (Temperate and Tropical House) as a rectangle with a barrel vault from the eave to the ridge;
and every measured tree (one crown per LiDAR tree): trunk position, height, crown radius, crown base and the aerial's
colour. The game stands each building on its own ground at its centroid and grows each tree from the ground at its
trunk, so each moves by meshHeightAt − DEM there (the layered-site contract).
Trees over roofs: the recipe's roof is the LiDAR median in the outline, which reads a crown that hangs over a small
building (a 5 m hipped pavilion read 18 m). When a measured crown covers the outline's centroid, the roof is the OSM
`height` (else the LiDAR p25); otherwise, on a patchy roof (p25 more than 3 m under the median: part canopy), an OSM
`height` more than 3 m under the median wins. A roof the LiDAR reads evenly keeps its LiDAR height (OSM's are hints).

Format, little-endian:
  'AKLD' u32 version=1 u32 nPark u32 nBuildings u32 nTrees
  park:      nPark × (i16 x, i16 z)                    decimetres, game XZ
  buildings: nBuildings × (u8 kind, u8 n, n × (i16 x, i16 z), u16 a, u16 b, u8 r, g, b)
             kind 0 = flat roof: a = its height (cm over the ground), b = 0; kind 1 = a glasshouse: the ring is its
             rectangle, the first edge along the vault's axis, a = the eave and b = the ridge (cm); then the roof colour
  trees:  nTrees × (i16 x, i16 z, u8 height/4 m, u8 radius/10 m, u8 base/255 of the height, u8 r, g, b)
Data: LINZ 2024 LiDAR and aerial (CC BY 4.0); © OpenStreetMap contributors (ODbL).
"""
import argparse, gzip, json, math, os, struct, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from cbd_towers import px_to_game  # noqa: E402

GLASS = ('Temperate House', 'Tropical House')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--site', default='/tmp/hero/auckland_domain')
    ap.add_argument('--out', default=os.path.join(HERE, '..', '..', '..', 'src', 'world', 'scenery', 'data', 'auckland-domain.bin'))
    a = ap.parse_args()
    m = json.load(open(os.path.join(a.site, 'domain_model.json')))
    box = json.load(open(os.path.join(a.site, 'site.json')))['box_nztm']
    game = lambda x, z: px_to_game(x, z, box)
    dm = lambda v: int(round(v * 10))

    park = m['park'][:-1] if m['park'][0] == m['park'][-1] else m['park']
    from PIL import Image
    Image.MAX_IMAGE_PIXELS = None
    from shapely.geometry import Point, Polygon
    aer = Image.open(os.path.join(a.site, 'aerial_nomuseum.jpg')).convert('RGB')
    k = aer.width / (box[2] - box[0])  # px per m

    def roof_colour(ring):
        poly = Polygon(ring).buffer(-0.7)
        if poly.is_empty:
            poly = Polygon(ring)
        b = poly.bounds
        px = []
        for x in [b[0] + (b[2] - b[0]) * (i + 0.5) / 12 for i in range(12)]:
            for z in [b[1] + (b[3] - b[1]) * (j + 0.5) / 12 for j in range(12)]:
                if poly.contains(Point(x, z)):
                    px.append(aer.getpixel((min(aer.width - 1, int(x * k)), min(aer.height - 1, int(z * k)))))
        px.sort(key=sum)
        return px[len(px) // 2] if px else (150, 150, 150)

    import xml.etree.ElementTree as ET
    osm_h = {}
    for w in ET.parse(os.path.join(a.site, 'map.osm')).getroot().iter('way'):
        t = {x.get('k'): x.get('v') for x in w.findall('tag')}
        try:
            osm_h[w.get('id')] = float(t['height'].split()[0])
        except (KeyError, ValueError):
            pass

    def roof_height(b):
        c = Polygon(b['ring']).centroid
        under = any(math.hypot(t[0] - c.x, t[1] - c.y) < t[4] for t in m['trees'])
        h = b['y1'] - b['y0']
        oh = osm_h.get(b['id'])
        if under:
            h = oh if oh is not None else b['p25']
            print(f"  {b['id']} under a crown: roof {b['median']:.1f} → {h:.1f} m")
        elif oh is not None and b['median'] > oh + 3 and b['p25'] < b['median'] - 3:
            print(f"  {b['id']} over its OSM height: roof {b['median']:.1f} → {oh:.1f} m")
            h = oh
        return h

    blds = [b for b in m['buildings'] if b['y1'] - b['y0'] > 1.5]
    assert sum(b['name'] in GLASS for b in blds) == 2
    out = bytearray(b'AKLD')
    out += struct.pack('<IIII', 1, len(park), len(blds), len(m['trees']))
    for x, z in park:
        out += struct.pack('<hh', *(dm(v) for v in game(x, z)))
    for b in blds:
        if b['name'] in GLASS:
            r = b['rect']
            # the vault runs along the rectangle's long axis: start the corners on a long edge
            if math.dist(r[1], r[2]) > math.dist(r[0], r[1]):
                r = r[1:] + r[:1]
            kind, ring, ha, hb = 1, r, b['eave'] - b['y0'], b['ridge'] - b['y0']
        else:
            ring = b['ring'][:-1] if b['ring'][0] == b['ring'][-1] else b['ring']
            kind, ha, hb = 0, roof_height(b), 0
        out += struct.pack('<BB', kind, len(ring))
        for x, z in ring:
            out += struct.pack('<hh', *(dm(v) for v in game(x, z)))
        out += struct.pack('<HHBBB', round(ha * 100), round(hb * 100), *roof_colour(b['ring']))
    heights = []
    for x, z, g, top, rad, base, cr, cg, cb in m['trees']:
        h = top - g
        heights.append(h)
        out += struct.pack('<hhBBBBBB', *(dm(v) for v in game(x, z)), min(255, round(h * 4)), min(255, round(rad * 10)),
                           max(0, min(255, round((base - g) / h * 255))), int(cr), int(cg), int(cb))
    gz = gzip.compress(bytes(out), 9, mtime=0)
    open(a.out, 'wb').write(gz)
    print(f'wrote {a.out}: {len(out)} B raw, {len(gz)} B gzip; {len(park)} park vertices, {len(blds)} buildings, '
          f'{len(m["trees"])} trees (median {sorted(heights)[len(heights) // 2]:.1f} m, max {max(heights):.1f} m)')


if __name__ == '__main__':
    main()
