/**
 * Terrain before/after screenshots (tools/linz land cover + bathymetry, #7): renders the world lab from fixed camera
 * positions over Auckland's bush, pine forests and harbours, so two builds (e.g. master and a branch, each on its own
 * dev server) can be compared shot for shot.
 *
 *   node e2e/terrain-shots.mjs <port> <tag> <out-dir> [view,view,...]
 *
 * writes <out-dir>/<view>-<tag>.png (1280×720, medium quality, seed 1840; headless Chromium with SwiftShader, so
 * each shot takes a minute or two).
 */
import { chromium } from 'playwright-core';
import fs from 'node:fs';

const [port = '5173', tag = 'shot', outDir = 'e2e/screenshots', only] = process.argv.slice(2);
/** World-lab camera: cam = x,y,z (m), look = heading,pitch (deg). */
const VIEWS = {
  waitakere: 'cam=-6000,3200,21000&look=305,-14', // Waitākere Ranges over the Manukau Harbour
  hunua: 'cam=14000,3000,20000&look=95,-12', // Hunua Ranges from the west
  woodhill: 'cam=-24000,3000,-4000&look=300,-16', // Woodhill (coast) and Riverhead (right) pine forests
  rangitoto_channel: 'cam=-1500,4500,3000&look=35,-32', // CBD, Rangitoto Channel, Rangitoto
  manukau: 'cam=-3000,6000,30000&look=330,-38', // Manukau flats and channels
};

fs.mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
for (const [name, q] of Object.entries(VIEWS)) {
  if (only && !only.split(',').includes(name)) continue;
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errs.push(m.text());
  });
  await page.goto(`http://localhost:${port}/labs/world-lab.html?tod=day&weather=clear&quality=medium&seed=1840&${q}`);
  await page.waitForFunction(() => window.__lab?.ready, null, { timeout: 240_000 });
  await page.waitForTimeout(6000); // let the tree / house scatters stream in
  const file = `${outDir}/${name}-${tag}.png`;
  await page.screenshot({ path: file, timeout: 240_000 });
  console.log(file, errs.length ? errs.slice(0, 3) : 'ok');
  await page.close();
}
await browser.close();
