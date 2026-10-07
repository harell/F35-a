/**
 * Real tree canopy (#123) screenshots: Rangitoto from 1, 2 and 3 km, and the test suburbs (Mt Albert, Devonport,
 * Māngere, Hobsonville) and Waiheke's bush from 0.6–1.5 km. The game (mission t01, seed 7, chase view, HUD hidden) through
 * `__f35.camera(cam, look)`, waiting for the tree and house scatters to finish streaming; prints the draw calls and
 * triangles of each view (run it against a server of the layer below for the before numbers).
 *
 *   node e2e/canopy-shots.mjs [--base=http://localhost:5190/] [--out=e2e/screenshots] [--quality=medium] [--only=view,view]
 *                             [--variants=photo,procedural] [--tag=after] [--mission=t01] [--tod=day] [--cam=x,y,z --look=x,y,z (view 'custom')]
 *
 * (`--tod` applies to Instant Action ids only, e.g. --mission=ia_stroll_auckland --tod=night.)
 * <out>/123-<view>-<variant>-<tag>.png (1280×720). `procedural` is `aerial=0` (the low tier's ground and the fallback
 * without the photo). Headless Chromium with SwiftShader: a minute or two a view.
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
  // Rangitoto from the harbour side (south-west, over Devonport's North Head) at 1, 2 and 3 km from its summit
  rangitoto_1km: { cam: [7900, 350, -5900], look: [8540, 120, -6800] },
  rangitoto_2km: { cam: [7300, 600, -5100], look: [8540, 120, -6800] },
  rangitoto_3km: { cam: [6700, 900, -4300], look: [8540, 120, -6800] },
  // the test suburbs from 600 m – 1.5 km: Mt Albert (with its cone), Devonport, Māngere, Hobsonville Point
  mt_albert: { cam: [-3778, 600, 6000], look: [-3778, 0, 4600] },
  devonport: { cam: [3029, 700, -700], look: [3029, 0, -2200] },
  mangere: { cam: [3400, 800, 15000], look: [3400, 0, 13300] },
  hobsonville: { cam: [-8600, 700, -4700], look: [-9000, 0, -6300] },
  // Waiheke's bush and farmland (Onetangi to the hills behind it) from 1.5 km
  waiheke: { cam: [28300, 900, -7500], look: [28800, 0, -4500] },
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
    if (m.type() === 'error' || /canopy|houses|aerial/.test(m.text())) errs.push(m.text());
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
    const file = `${out}/123-${name}-${variant}-${tag}.png`;
    await page.screenshot({ path: file, timeout: 300_000 });
    const r = await page.evaluate(() => ({ ...window.__f35.state().renderer, instances: window.__f35.game.session.env.stats().instances }));
    console.log(`${file}\t${r?.calls} calls\t${r?.triangles} tris\t${r?.instances} instances`);
  }
  console.log(variant, errs.length ? errs.slice(0, 3) : 'ok');
  await page.close();
}
await browser.close();
process.exit(0);
