/**
 * Aerial photo before/after screenshots (Open data 4, issue #6): renders the world lab from fixed camera
 * positions over the CBD, the waterfront and Devonport (300–1000 m) at several times of day, once with the
 * photo and once without (`aerial=0`), so the two can be compared shot for shot.
 *
 *   node e2e/aerial-shots.mjs [port] [out-dir] [quality] [view,view,...]
 *
 * writes <out-dir>/<view>-{photo,procedural}.png (1280×720, seed 1840; headless Chromium with SwiftShader,
 * so each shot takes a minute or two) and prints the draw calls / triangles of each.
 */
import { chromium } from 'playwright-core';
import fs from 'node:fs';

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
const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
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
