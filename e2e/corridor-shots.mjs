/**
 * The corridor's real houses (#126) screenshots: the epic's (#119) corridor cameras (near the Whau; Mt Roskill top-down,
 * #127's) and a low pass over Henderson, Avondale, Mt Roskill, Onehunga and Māngere at 300 m – 1 km, through
 * `__f35.camera(cam, look)` on mission t01 (seed 7, chase view, HUD hidden). Waits for the scatters and the corridor's
 * tiles to finish streaming; prints the draw calls, triangles, scatter instances, the corridor's stream (tiles loaded,
 * their bytes) and the street-ribbon mesh's triangles of each view.
 *
 *   node e2e/corridor-shots.mjs [--base=http://localhost:5190/] [--out=e2e/screenshots] [--quality=medium] [--only=view,view]
 *                               [--variants=streamed,offline] [--tag=after] [--tod=day] [--cam=x,y,z --look=x,y,z (view 'custom')]
 *
 * <out>/126-<view>-<variant>-<tag>.png (1280×720). `offline` blocks every tile request (the procedural suburbs: the
 * fallback, and the game before this layer). Headless Chromium with SwiftShader: a minute or two a view.
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
  // epic #119's corridor camera: identical houses in straight rows near the Whau
  whau_200: { cam: [-8500, 200, 2500], look: [-5500, 0, 5800] },
  // #127's Mt Roskill top-down (the suburb streets)
  roskill_top: { cam: [-1990, 1250, 6830], look: [-1990, 0, 6845] },
  // Mt Roskill from 300 m
  roskill_300: { cam: [-2250, 300, 6500], look: [-2250, 0, 7300] },
  // Henderson from 300 m
  henderson_300: { cam: [-11735, 300, 2800], look: [-11735, 0, 3600] },
  // Avondale from 1 km
  avondale_1km: { cam: [-6080, 1000, 3500], look: [-6080, 0, 5300] },
  // Onehunga from 600 m
  onehunga_600: { cam: [2000, 600, 7300], look: [2000, 0, 8400] },
  // Māngere from 500 m
  mangere_500: { cam: [3280, 500, 12400], look: [3280, 0, 13300] },
  // the isthmus from 3 km
  isthmus_3km: { cam: [-7000, 3000, 0], look: [-3000, 0, 7000] },
  // Howick from 450 m (#274: the playtest's R11-4 camera, East Auckland's added tiles)
  howick_450: { cam: [15040, 450, 3400], look: [15040, 0, 5050] },
};
if (args.cam && args.look) VIEWS.custom = { cam: String(args.cam).split(',').map(Number), look: String(args.look).split(',').map(Number) };
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const variants = String(args.variants || 'streamed,offline').split(',');
for (const variant of ['streamed', 'offline']) {
  if (!variants.includes(variant)) continue;
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  if (variant === 'offline') await page.route(/akl-corridor-[^?]*\.bin$/, (r) => r.abort()); // (the tiles, not Vite's ?url modules)
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' || /corridor/.test(m.text())) errs.push(m.text());
  });
  await page.goto(`${base}?mission=${mission}&autostart=1&seed=7&quality=${quality}&view=chase&weather=clear&tod=${tod}`);
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
    await page.waitForTimeout(3000);
    // (a few rendered frames first: the scatters and the corridor stream move to the new camera in the frame after it,
    // and until then `idle` still reads the old place's)
    for (let k = 0; k < 3; k++) await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    await page.waitForFunction(() => window.__f35.game.session.env.stats().idle, null, { timeout: Number(args.idle || 900) * 1000, polling: 1000 }).catch(() => console.log(name, "scatter not idle"));
    await page.waitForTimeout(1500);
    const file = `${out}/126-${name}-${variant}-${tag}.png`;
    await page.screenshot({ path: file, timeout: 300_000 });
    const r = await page.evaluate(() => {
      const env = window.__f35.game.session.env;
      const st = env.stats();
      let roads = 0;
      window.__f35.game.session.scene.traverse((o) => {
        if (o.name === 'akl-corridor-roads' && o.visible && o.geometry.index) roads = o.geometry.index.count / 3;
      });
      return { ...window.__f35.state().renderer, instances: st.instances, corridor: st.corridor, roads };
    });
    const c = r.corridor;
    console.log(`${file}\t${r?.calls} calls\t${r?.triangles} tris\t${r?.instances} instances\tcorridor ${c ? `${c.loaded} tiles loaded, ${c.requests} requests, ${(c.bytes / 1024).toFixed(0)} KiB, ${c.houses} houses, ${c.failed} failed` : 'none'}\tstreet mesh ${r.roads} tris`);
  }
  console.log(variant, errs.length ? errs.slice(0, 3) : 'ok');
  await page.close();
}
await browser.close();
process.exit(0);
