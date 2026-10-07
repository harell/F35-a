/**
 * Real houses (#121) screenshots: the Devonport peninsula from the cameras of the epic (#119) and #120, and Oneroa,
 * Onetangi and Rangitoto's bach settlements from 300 m. The game (mission t01, seed 7, chase view, HUD hidden) through
 * `__f35.camera(cam, look)`, waiting for the tree and house scatters to finish streaming; prints the draw calls and
 * triangles of each view (run it against a server of the layer below for the before numbers).
 *
 *   node e2e/houses-shots.mjs [--base=http://localhost:5190/] [--out=e2e/screenshots] [--quality=medium] [--only=view,view]
 *                             [--variants=photo,procedural] [--tag=after] [--mission=t01] [--tod=day] [--cam=x,y,z --look=x,y,z (view 'custom')]
 *
 * (`--tod` applies to Instant Action ids only, e.g. --mission=ia_stroll_auckland --tod=night.)
 * <out>/121-<view>-<variant>-<tag>.png (1280×720). `procedural` is `aerial=0` (the low tier's ground and the fallback
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
  // #120 repro 1: straight down on the old square's east edge between Devonport and Cheltenham
  devonport_top: { cam: [3560, 1100, -2390], look: [3560, 0, -2375] },
  // #120 repro 2: across Devonport to North Head and Cheltenham
  north_head: { cam: [2700, 350, -1500], look: [4600, 0, -2600] },
  // Bayswater and Belmont, and the fade across the neck north of Belmont
  belmont: { cam: [1200, 700, -2300], look: [2200, 0, -5000] },
  // Devonport village from 300 m, looking north from over the harbour
  devonport_300: { cam: [2966, 300, -1300], look: [2966, 0, -1950] },
  // Oneroa, Waiheke, from 300 m
  oneroa_300: { cam: [22160, 300, -6400], look: [22160, 0, -7000] },
  // Onetangi, Waiheke, from 300 m
  onetangi_300: { cam: [28320, 300, -5350], look: [28320, 0, -5950] },
  // Rangitoto Wharf's baches from 200 m
  rangitoto_wharf_200: { cam: [8600, 200, -4150], look: [8650, 0, -4500] },
  // Islington Bay's baches (Rangitoto's north-east shore) from 300 m
  islington_300: { cam: [11747, 300, -7400], look: [11747, 0, -8000] },
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
    const file = `${out}/121-${name}-${variant}-${tag}.png`;
    await page.screenshot({ path: file, timeout: 300_000 });
    const r = await page.evaluate(() => ({ ...window.__f35.state().renderer, instances: window.__f35.game.session.env.stats().instances }));
    console.log(`${file}\t${r?.calls} calls\t${r?.triangles} tris\t${r?.instances} instances`);
  }
  console.log(variant, errs.length ? errs.slice(0, 3) : 'ok');
  await page.close();
}
await browser.close();
process.exit(0);
