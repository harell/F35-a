/**
 * Airfield before/after screenshots (tools/osm): renders the world lab from fixed camera positions over Auckland's
 * real airfields, so two builds (e.g. master and a branch, each on its own dev server) can be compared shot for shot.
 *
 *   node e2e/airfield-shots.mjs <port> <tag> <out-dir> [view,view,...]
 *
 * writes <out-dir>/<view>-<tag>.png (1280×720, medium quality, seed 1840; headless Chromium with SwiftShader, so
 * each shot takes a minute or two).
 */
import { chromium } from 'playwright-core';
import fs from 'node:fs';

const [port = '5173', tag = 'shot', outDir = 'e2e/screenshots', only] = process.argv.slice(2);
/** World-lab camera: cam = x,y,z (m), look = heading,pitch (deg); tod overrides the default day. */
const VIEWS = {
  whenuapai_approach: 'cam=-14972,230,-4000&look=52.8,-4', // 3 km final for runway 03, on its real 053° course
  whenuapai_overview: 'cam=-13800,1500,-3300&look=40,-30',
  whenuapai_close: 'cam=-12700,260,-6000&look=60,-22',
  whenuapai_night: 'cam=-14972,230,-4000&look=52.8,-4&tod=night',
  akl_approach_23l: 'cam=6718,230,16571&look=251,-4', // 3 km final for 23L
  akl_overview: 'cam=-400,1400,14400&look=145,-24',
  akl_close: 'cam=1300,300,17200&look=130,-25',
  akl_night: 'cam=6718,330,16571&look=251,-6&tod=night',
  ardmore_overview: 'cam=17200,1100,22200&look=40,-28',
  dairyflat_overview: 'cam=-10500,650,-20000&look=37,-24',
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
  const tod = q.includes('tod=') ? '' : 'tod=day&';
  await page.goto(`http://localhost:${port}/labs/world-lab.html?theater=auckland&${tod}weather=clear&quality=medium&seed=1840&${q}`);
  await page.waitForFunction(() => window.__lab?.ready, null, { timeout: 240_000 });
  await page.waitForTimeout(6000); // let the tree / house scatters stream in
  const file = `${outDir}/${name}-${tag}.png`;
  await page.screenshot({ path: file, timeout: 240_000 });
  console.log(file, errs.length ? errs.slice(0, 3) : 'ok');
  await page.close();
}
await browser.close();
