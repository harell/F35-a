/**
 * Real island roads (#127) screenshots: Waiheke from 1, 2 and 3 km (oblique and straight down), Onetangi, Rangitoto's
 * summit road and Devonport, in the game (mission t01, seed 7, chase view, HUD hidden) through `__f35.camera(cam, look)`,
 * waiting for the scatters to stream; prints the draw calls and triangles of each view and the local-road mesh's
 * triangles. `photo` is the tier's own ground (on medium and high the 2024 photo, which the ribbons should lie on);
 * `procedural` is `aerial=0` (the low tier's ground and the fallback without the photo).
 *
 *   node e2e/roads-shots.mjs [--base=http://localhost:5190/] [--out=e2e/screenshots] [--quality=medium] [--only=view,view]
 *                            [--variants=photo,procedural] [--tag=after] [--cam=x,y,z --look=x,y,z (view 'custom')]
 *
 * <out>/127-<view>-<quality>-<variant>-<tag>.png (1280×720). Headless Chromium with SwiftShader: a minute or two a view.
 */
import { chromium } from 'playwright-core';
import fs from 'node:fs';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)=?(.*)$/);
    return m ? [m[1], m[2] === '' ? true : m[2]] : [a, true];
  }),
);
const base = args.base || 'http://localhost:5190/';
const out = args.out || 'e2e/screenshots';
const quality = args.quality || 'medium';
const tag = args.tag || 'after';
const tod = args.tod || 'day';
const mission = args.mission || 't01';
/** Game XZ (m, origin Sky Tower, +x east, +z south): camera position and the point it looks at. */
const VIEWS = {
  // Oneroa, Blackpool and Surfdale from 1 km, looking south-east across the isthmus
  waiheke_1km: { cam: [21900, 1000, -9000], look: [23600, 0, -6600] },
  // the west end from 2 km: Matiatia, Oneroa, Ostend, Palm Beach
  waiheke_2km: { cam: [20500, 2000, -11500], look: [24500, 0, -6500] },
  // straight down from 3 km over Surfdale and Ostend (to lay next to the photo)
  waiheke_3km_top: { cam: [24200, 3000, -6600], look: [24200, 0, -6590] },
  // Onetangi and the vineyards behind it, straight down from 1.5 km
  onetangi_top: { cam: [27900, 1500, -6400], look: [27900, 0, -6390] },
  // Rangitoto's summit road and the Islington Bay road from 1.5 km
  rangitoto: { cam: [8200, 1500, -3800], look: [8900, 0, -6600] },
  // Devonport's streets straight down from 1 km
  devonport_top: { cam: [3100, 1000, -2400], look: [3100, 0, -2390] },
};
// --cam=x,y,z --look=x,y,z: one more view, 'custom'
if (args.cam && args.look) VIEWS.custom = { cam: String(args.cam).split(',').map(Number), look: String(args.look).split(',').map(Number) };
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const variants = String(args.variants || 'photo,procedural').split(',');
for (const [variant, flag] of [
  ['photo', ''],
  ['procedural', '&aerial=0'],
]) {
  if (!variants.includes(variant)) continue;
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' || /houses|aerial/.test(m.text())) errs.push(m.text());
  });
  await page.goto(`${base}?mission=${mission}&autostart=1&seed=7&quality=${quality}&view=chase&weather=clear&tod=${tod}${flag}`);
  await page.waitForFunction(() => window.__f35?.game?.session?.world, null, { timeout: 300_000 });
  await page.waitForTimeout(2000);
  await page.evaluate(() => {
    for (const el of document.querySelectorAll('body *')) if (!(el instanceof HTMLCanvasElement) && !el.querySelector('canvas')) el.style.visibility = 'hidden';
  });
  for (const [name, v] of Object.entries(VIEWS)) {
    if (args.only && !String(args.only).split(',').includes(name)) continue;
    await page.evaluate((v) => {
      const f = window.__f35;
      f.setView('chase');
      f.hud(false);
      f.hold?.(true);
      f.camera(v.cam, v.look);
    }, v);
    // let the scatters stream in round the new camera (they stream a few tiles a rendered frame)
    await page.waitForTimeout(3000);
    await page.waitForFunction(() => window.__f35.game.session.env.stats().idle, null, { timeout: 240_000, polling: 1000 }).catch(() => console.log(name, 'scatter not idle'));
    await page.waitForTimeout(1500);
    const file = `${out}/127-${name}-${quality}-${variant}-${tag}.png`;
    await page.screenshot({ path: file, timeout: 300_000 });
    const r = await page.evaluate(() => {
      let local = 0;
      window.__f35.game.session.scene.traverse((o) => {
        if (o.name === 'akl-local-roads' && o.geometry?.index) local = o.geometry.index.count / 3;
      });
      return { ...window.__f35.state().renderer, instances: window.__f35.game.session.env.stats().instances, local };
    });
    console.log(`${file}\t${r?.calls} calls\t${r?.triangles} tris\t${r?.instances} instances\tlocal-road mesh ${r?.local} tris`);
  }
  console.log(variant, errs.length ? errs.slice(0, 3) : 'ok');
  await page.close();
}
await browser.close();
process.exit(0);
