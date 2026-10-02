/**
 * Waterfront and strategic-site before/after screenshots (Open data 2, issue #33): renders the world lab from fixed
 * camera positions over the port, the marinas, Devonport Naval Base, the Harbour Bridge, the Wiri oil terminal and
 * Eden Park, so two builds (e.g. master and a branch, each on its own dev server) can be compared shot for shot.
 * The moored ships are sim entities: the world lab has none.
 *
 *   node e2e/sites-shots.mjs <port> <tag> <out-dir> [view,view,...]
 *
 * writes <out-dir>/<view>-<tag>.png (1280×720, medium quality, seed 1840; headless Chromium with SwiftShader, so
 * each shot takes a minute or two).
 */
import { chromium } from 'playwright-core';
import fs from 'node:fs';

const [port = '5173', tag = 'shot', outDir = 'e2e/screenshots', only] = process.argv.slice(2);
/** World-lab camera: cam = x,y,z (m), look = heading,pitch (deg); tod overrides the default day. */
const VIEWS = {
  port_overview: 'cam=900,450,-2300&look=155,-18',
  port_fergusson: 'cam=2900,160,-1500&look=230,-12',
  viaduct_westhaven: 'cam=-500,350,-2000&look=195,-17',
  westhaven_close: 'cam=-1250,110,-1750&look=190,-22',
  devonport_naval: 'cam=1400,320,-1000&look=30,-16',
  harbour_bridge: 'cam=-2400,90,-1600&look=71,-1',
  wiri_terminal: 'cam=7150,420,16850&look=143,-28',
  eden_park: 'cam=-2150,330,2350&look=134,-24',
  port_night: 'cam=900,450,-2300&look=155,-18&tod=night',
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
  await page.goto(`http://localhost:${port}/labs/world-lab.html?${tod}weather=clear&quality=medium&seed=1840&${q}`);
  await page.waitForFunction(() => window.__lab?.ready, null, { timeout: 240_000 });
  await page.waitForTimeout(6000); // let the tree / house scatters stream in
  const file = `${outDir}/${name}-${tag}.png`;
  await page.screenshot({ path: file, timeout: 240_000 });
  console.log(file, errs.length ? errs.slice(0, 3) : 'ok');
  await page.close();
}
await browser.close();
