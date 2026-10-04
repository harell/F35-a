"""
F35-A — hero landmarks: the Auckland Domain with the museum standing on it, as the two layers will be ported, for
tools/hero/examples/auckland-domain-museum.html → <domain site>/composite.html.

  python3 tools/hero/sites/auckland_museum.py --site /tmp/hero/museum
  python3 tools/hero/sites/auckland_domain.py --site /tmp/hero/auckland_domain --exclude /tmp/hero/museum/museum_model.json
  python3 tools/hero/sites/auckland_domain_museum_page.py --domain /tmp/hero/auckland_domain --museum /tmp/hero/museum

Layering (the base layer first, the top layer on it):
  1. the Domain owns the ground, the trees, the park buildings and the ponds, and keeps clear of the museum's
     footprint (--exclude above: no trees or buildings within 3 m, no crown over it, the aerial filled under it);
  2. the museum owns its footprint. Its model is moved into the Domain's frame by the difference of the two NZTM
     origins (a pure translation: both frames are NZTM metres), and its walls start at the lowest LiDAR ground in
     its outline, so it meets the Domain's ground exactly.
On the game's terrain (stage "after the port") every part moves by the game's height minus the LiDAR ground at
its own anchor: each tree at its trunk, each park building and the museum (one value, so it stays level) at their
centroid. That offset grid is DATA.game.d (game − LiDAR, 10 m), the same grid the Domain page maps in stage 4.
"""
import argparse, base64, json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, '..'))
from auckland_domain_page import build  # noqa: E402


def uri(path):
    return 'data:image/jpeg;base64,' + base64.b64encode(open(path, 'rb').read()).decode()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--domain', required=True)
    ap.add_argument('--museum', required=True)
    a = ap.parse_args()
    data, hero_tex, game_tex, port_tex, shots, stats = build(a.domain)
    S = json.load(open(os.path.join(a.domain, 'site.json')))
    M = json.load(open(os.path.join(a.museum, 'museum_model.json')))
    dx, dz = M['E0'] - S['box_nztm'][0], S['box_nztm'][3] - M['N1']
    mv = lambda ring: [[round(x + dx, 2), round(z + dz, 2)] for x, z in ring]  # noqa: E731
    mus = {
        'ground': M['ground'], 'footprint': mv(M['footprint']),
        'terraces': [{**t, 'ring': mv(t['ring'])} for t in M['terraces']],
        'dome': {**M['dome'], 'ring': mv(M['dome']['ring']), 'x0': M['dome']['x0'] + dx, 'z0': M['dome']['z0'] + dz},
        'portico': {**M['portico'], 'ring': mv(M['portico']['ring']), 'columns': [[x + dx, z + dz, r] for x, z, r in M['portico']['columns']]},
        'tex': {**M['tex'], 'x': [v + dx for v in M['tex']['x']], 'z': [v + dz for v in M['tex']['z']]},
        'offset': [dx, dz],
    }
    data['museum_model'] = mus
    texs = {k: uri(os.path.join(a.museum, f'tex_{k}.jpg')) for k in ('north', 'south', 'east', 'west', 'top')}
    page = open(os.path.join(HERE, '..', 'examples', 'auckland-domain-museum.html')).read()
    script = ('const DATA=' + json.dumps(data, separators=(',', ':')) + ';const AERIAL_HERO="' + hero_tex + '";const AERIAL_GAME="' + game_tex
              + '";const AERIAL_PORT="' + port_tex + '";const MUSEUM_TEX=' + json.dumps(texs) + ';')
    page = page.replace('__DATA__', script).replace('__TODAY_SW__', shots['sw'])
    out = os.path.join(a.domain, 'composite.html')
    open(out, 'w').write(page)
    print('museum offset in the Domain frame', dx, dz, '·', len(mus['terraces']), 'terraces')
    print(out, round(len(page) / 1e6, 2), 'MB')


if __name__ == '__main__':
    main()
