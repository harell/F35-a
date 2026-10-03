"""
F35-A — hero buildings: turn <site>/model.json (written by a site recipe in tools/hero/sites/) into a
self-contained prototype page, <site>/prototype.html, from tools/hero/viewer.html.

  python3 tools/hero/build_prototype.py --site /tmp/hero/<name>

Embeds aerial.jpg (resized to 1024 px), ndsm.png and today.jpg (if present) as data URIs, so the page
can be published as one private artifact for the owner's review. Publish it as an Artifact (HTML); the
page loads three.js r128 from cdnjs/jsdelivr, which the artifact CSP allows.
"""
import argparse, base64, io, json, os

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))


def data_uri(path, max_px=1024, fmt='JPEG'):
    if not os.path.exists(path):
        return ''
    im = Image.open(path).convert('RGB')
    im.thumbnail((max_px, max_px))
    buf = io.BytesIO()
    im.save(buf, fmt, quality=82)
    return f'data:image/{fmt.lower()};base64,' + base64.b64encode(buf.getvalue()).decode()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--site', required=True)
    a = ap.parse_args()
    model = json.load(open(f'{a.site}/model.json'))
    t = open(f'{HERE}/viewer.html').read()
    t = (t.replace('__TITLE__', model['meta']['page_title'])
          .replace('__MODEL__', json.dumps(model, separators=(',', ':')))
          .replace('__AERIAL__', data_uri(f'{a.site}/aerial.jpg'))
          .replace('__NDSM__', data_uri(f'{a.site}/ndsm.png', 512))
          .replace('__TODAY__', data_uri(f'{a.site}/today.jpg', 1280)))
    open(f'{a.site}/prototype.html', 'w').write(t)
    print(f'{a.site}/prototype.html  {len(t) // 1024} kB')


if __name__ == '__main__':
    main()
