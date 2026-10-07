/**
 * Aerial photo before/after screenshots (Open data 4, issue #6; the outer photo, #120). Each view is shot once with
 * the photo and once without (`aerial=0`), so the two can be compared shot for shot, and prints the draw calls /
 * triangles of each. Two sets:
 *
 *   node e2e/aerial-shots.mjs [port] [out-dir] [quality] [view,view,...]
 *     the world lab (labs/world-lab.html) from fixed cameras over the CBD, the waterfront and Devonport (300–1000 m)
 *     at several times of day: <out-dir>/<view>-{photo,procedural}.png (1280×720, seed 1840)
 *
 *   node e2e/aerial-shots.mjs --game [--base=http://localhost:5190/] [--out=e2e/screenshots] [--quality=medium] [--only=view,view]
 *     the game (mission t01, seed 7, chase view, HUD hidden) through `__f35.camera(cam, look)`: the Devonport peninsula from the
 *     cameras of issue #120 (the old square's edge, North Head, the fade across the Belmont neck) and the gulf islands
 *     from 1–3 km: <out>/120-<view>-{photo,procedural}.png (1280×720). One page per variant, every view in it.
 *
 * Headless Chromium with SwiftShader, so each shot takes a minute or two.
 */
import { chromium } from 'playwright-core';
import fs from 'node:fs';

const launch = () => chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });

if (process.argv.includes('--game')) {
  const args = Object.fromEntries(
    process.argv.slice(2).map((a) => {
      const m = a.match(/^--([^=]+)=?(.*)$/);
      return m ? [m[1], m[2] === '' ? true : m[2]] : [a, true];
    }),
  );
  const base = args.base || 'http://localhost:5190/';
  const out = args.out || 'e2e/screenshots';
  const quality = args.quality || 'medium';
  /** Game XZ (m, origin Sky Tower, +x east, +z south): camera position and the point it looks at. */
  const VIEWS = {
    // #120 repro 1: straight down on the old square's east edge (x 3584) between Devonport and Cheltenham
    devonport_top: { cam: [3560, 1100, -2390], look: [3560, 0, -2375] },
    // #120 repro 2: across Devonport to North Head and Cheltenham
    north_head: { cam: [2700, 350, -1500], look: [4600, 0, -2600] },
    // Bayswater and Belmont, and the fade across the neck north of Belmont (z −5500 … −5180)
    belmont: { cam: [1200, 700, -2300], look: [2200, 0, -5000] },
    // Rangitoto from 2.7 km (the summit, the lava fields and the bush)
    rangitoto: { cam: [6800, 900, -4400], look: [8600, 150, -6800] },
    // Motutapu's farmland past Rangitoto's east flank
    motutapu: { cam: [11500, 800, -6400], look: [13200, 40, -9000] },
    // Waiheke: Oneroa and Little Oneroa from 2.5 km
    oneroa: { cam: [21000, 800, -3500], look: [22300, 20, -7000] },
    // Waiheke's vineyards (Onetangi valley) from 1.5 km
    vineyards: { cam: [26800, 700, -4600], look: [27300, 20, -6100] },
    // Man O' War and Stony Batter, the east end, from 3 km
    waiheke_east: { cam: [34500, 900, -5200], look: [36800, 60, -8600] },
  };
  fs.mkdirSync(out, { recursive: true });
  const browser = await launch();
  for (const [tag, flag] of [
    ['photo', ''],
    ['procedural', '&aerial=0'],
  ]) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error' || /aerial/.test(m.text())) errs.push(m.text());
    });
    await page.goto(`${base}?mission=t01&autostart=1&seed=7&quality=${quality}&view=chase${flag}`);
    await page.waitForFunction(() => window.__f35?.game?.session?.world, null, { timeout: 300_000 });
    await page.waitForTimeout(2000);
    // the canvas alone (no pause button or other DOM overlay)
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
      // let the scatters stream in round the new camera
      await page.waitForTimeout(6000);
      const file = `${out}/120-${name}-${tag}.png`;
      await page.screenshot({ path: file, timeout: 300_000 });
      const r = await page.evaluate(() => window.__f35.state().renderer);
      console.log(file, `${r?.calls} calls`, `${r?.triangles} tris`);
    }
    console.log(tag, errs.length ? errs.slice(0, 3) : 'ok');
    await page.close();
  }
  await browser.close();
  process.exit(0);
}

const [port = '5173', outDir = 'e2e/screenshots', quality = 'medium', only] = process.argv.slice(2);
/** World-lab camera: cam = x,y,z (m), look = heading,pitch (deg), tod = time of day. */
const VIEWS = {
  cbd_600: 'cam=-300,600,1900&look=12,-24&tod=day',
  waterfront_450: 'cam=900,450,-2300&look=155,-18&tod=day',
  viaduct_300: 'cam=-1300,300,-1900&look=140,-20&tod=day',
  devonport_300: 'cam=2300,300,-700&look=30,-12&tod=day',
  cbd_1000_dawn: 'cam=-300,1000,2600&look=12,-24&tod=dawn',
  cbd_600_dusk: 'cam=-300,600,1900&look=12,-24&tod=dusk',
  cbd_600_night: 'cam=-300,600,1900&look=12,-24&tod=night',
  edge_700: 'cam=-3300,700,3300&look=45,-16&tod=day',
};

fs.mkdirSync(outDir, { recursive: true });
const browser = await launch();
for (const [name, q] of Object.entries(VIEWS)) {
  if (only && !only.split(',').includes(name)) continue;
  for (const [tag, flag] of [
    ['photo', ''],
    ['procedural', '&aerial=0'],
  ]) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error' || /aerial/.test(m.text())) errs.push(m.text());
    });
    await page.goto(`http://localhost:${port}/labs/world-lab.html?weather=clear&quality=${quality}&seed=1840&${q}${flag}`);
    await page.waitForFunction(() => window.__lab?.ready, null, { timeout: 300_000 });
    await page.waitForTimeout(6000); // let the tree / house scatters stream in
    const file = `${outDir}/${name}-${tag}.png`;
    await page.screenshot({ path: file, timeout: 240_000 });
    const st = await page.evaluate(() => window.__lab?.stats?.() ?? null);
    console.log(file, JSON.stringify(st), errs.length ? errs.slice(0, 3) : 'ok');
    await page.close();
  }
}
await browser.close();
