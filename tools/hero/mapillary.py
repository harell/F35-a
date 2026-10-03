"""
F35-A — hero buildings: street-level views of a site from Mapillary (CC BY-SA 4.0, crowd-sourced).

Rings the building with probe points, picks the nearest usable Mapillary image to each (a 360° panorama,
cropped towards the building, or a normal photo whose camera faces it), and writes <site>/mly/<n>-<side>.jpg,
<site>/mly/index.json (image id, date, creator, position, heading, distance) and <site>/mly/sheet.jpg.

  MAPILLARY_STREET_API=MLY|... python3 tools/hero/mapillary.py --site /tmp/hero/<name> [--target lat,lon]
      [--radius 110] [--probes 12] [--fov 70] [--min-year 2019]

Licence: Mapillary imagery is CC BY-SA 4.0. Modelling from it is allowed; credit "Mapillary contributors"
(and the creators in index.json) in the prototype's sources. Keep the token in the environment, never in the
repo; the images are references and stay under /tmp.
"""
import argparse, datetime, io, json, math, os, urllib.parse, urllib.request

from PIL import Image, ImageDraw

API = 'https://graph.mapillary.com'
SIDES = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']
FIELDS = 'id,captured_at,compass_angle,computed_compass_angle,computed_geometry,geometry,is_pano,creator,thumb_2048_url'


def get(url):
    return urllib.request.urlopen(url, timeout=60).read()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--site', required=True)
    ap.add_argument('--target', default=None)
    ap.add_argument('--radius', type=float, default=110)
    ap.add_argument('--probes', type=int, default=12)
    ap.add_argument('--fov', type=float, default=70)
    ap.add_argument('--min-year', type=int, default=2019)
    a = ap.parse_args()
    tok = os.environ.get('MAPILLARY_STREET_API') or os.environ.get('MAPILLARY_TOKEN')
    if not tok:
        raise SystemExit('MAPILLARY_STREET_API is not set')
    site = json.load(open(f'{a.site}/site.json'))
    lat0, lon0 = (map(float, a.target.split(','))) if a.target else (site['centre']['lat'], site['centre']['lon'])
    mlat, mlon = 110950.0, 111320.0 * math.cos(math.radians(lat0))
    r = a.radius * 1.6
    bbox = f'{lon0 - r / mlon},{lat0 - r / mlat},{lon0 + r / mlon},{lat0 + r / mlat}'
    q = urllib.parse.urlencode({'access_token': tok, 'fields': FIELDS, 'bbox': bbox, 'limit': 2000})
    images = json.loads(get(f'{API}/images?{q}')).get('data', [])
    cands = []
    for im in images:
        yr = datetime.datetime.utcfromtimestamp(im['captured_at'] / 1000).year
        g = (im.get('computed_geometry') or im['geometry'])['coordinates']
        dx, dz = (lon0 - g[0]) * mlon, (lat0 - g[1]) * mlat
        heading = (math.degrees(math.atan2(dx, dz)) + 360) % 360           # from the camera towards the building
        yaw = im.get('computed_compass_angle', im.get('compass_angle')) or 0
        off = (heading - yaw + 540) % 360 - 180                             # where the building is, relative to the camera
        if yr < a.min_year or not im.get('thumb_2048_url'):
            continue
        if not im.get('is_pano') and abs(off) > 35:                          # a normal photo must face the building
            continue
        cands.append({**im, 'year': yr, 'lon': g[0], 'lat': g[1], 'heading': heading, 'off': off, 'dist': math.hypot(dx, dz)})
    print(f'{len(images)} images in the box, {len(cands)} usable (year ≥ {a.min_year}, panoramas or facing the building)')

    out = f'{a.site}/mly'
    os.makedirs(out, exist_ok=True)
    shots, used = [], set()
    for i in range(a.probes):
        brg = 360 * i / a.probes
        px, pz = a.radius * math.sin(math.radians(brg)), a.radius * math.cos(math.radians(brg))
        best = min(((math.hypot((c['lon'] - lon0) * mlon - px, (c['lat'] - lat0) * mlat - pz), -c['captured_at'], c['id'], c)
                    for c in cands if c['id'] not in used), default=None)
        if not best or best[0] > a.radius * 0.6:
            continue
        c = best[3]
        used.add(c['id'])
        img = Image.open(io.BytesIO(get(c['thumb_2048_url']))).convert('RGB')
        if c.get('is_pano'):  # equirectangular: centre column = the camera's yaw; crop the building's direction
            W, H = img.size
            cx = (0.5 + c['off'] / 360) * W
            hw = a.fov / 360 * W / 2
            x0, x1 = int(cx - hw), int(cx + hw)
            if x0 < 0 or x1 > W:  # wrap around the seam
                img = Image.fromarray(__import__('numpy').roll(__import__('numpy').array(img), W // 2, axis=1))
                x0, x1 = x0 + W // 2 - (W if x0 >= W // 2 else 0), x1 + W // 2 - (W if x0 >= W // 2 else 0)
                x0, x1 = x0 % W, x0 % W + int(2 * hw)
            img = img.crop((x0, int(H * 0.22), x1, int(H * 0.62)))
        img.thumbnail((640, 640))
        side = SIDES[int(((c['heading'] + 180) % 360 + 22.5) // 45) % 8]
        name = f'{len(shots):02d}-{side}'
        img.save(f'{out}/{name}.jpg', quality=85)
        shots.append({'file': f'{name}.jpg', 'side': side, 'id': c['id'], 'date': datetime.datetime.utcfromtimestamp(c['captured_at'] / 1000).strftime('%Y-%m'),
                      'pano': bool(c.get('is_pano')), 'creator': (c.get('creator') or {}).get('username'), 'lat': c['lat'], 'lon': c['lon'],
                      'heading': round(c['heading'], 1), 'distance_m': round(c['dist'])})
        print(name, shots[-1]['date'], 'pano' if c.get('is_pano') else 'photo', f"{c['dist']:.0f} m", shots[-1]['creator'])
    json.dump(shots, open(f'{out}/index.json', 'w'), indent=1)
    if shots:
        tw, th = 320, 200
        cols = 3
        sheet = Image.new('RGB', (tw * cols, (th + 18) * math.ceil(len(shots) / cols)), (30, 30, 30))
        g = ImageDraw.Draw(sheet)
        for k, s in enumerate(shots):
            im = Image.open(f'{out}/{s["file"]}').convert('RGB').resize((tw, th))
            x, y = (k % cols) * tw, (k // cols) * (th + 18)
            sheet.paste(im, (x, y + 18))
            g.text((x + 4, y + 3), f'{s["file"]}  {s["side"]} side  {s["date"]}  {s["distance_m"]} m', fill=(255, 255, 255))
        sheet.save(f'{out}/sheet.jpg', quality=82)
        print(f'{out}/sheet.jpg')


if __name__ == '__main__':
    main()
