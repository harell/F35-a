/**
 * Waterfront before/after screenshots (Open data 2, tools/osm): renders the world lab from fixed camera positions over
 * the Ports of Auckland, the Viaduct and Westhaven marinas, Devonport Naval Base, the Harbour Bridge, the Wiri oil
 * terminal and Eden Park, so two builds (e.g. master and a branch, each on its own dev server) can be compared shot
 * for shot.
 *
 *   node e2e/waterfront-shots.mjs <port> <tag> <out-dir> [view,view,...]
 *
 * writes <out-dir>/<view>-<tag>.png (1280×720, medium quality, seed 1840; headless Chromium with SwiftShader, so
 * each shot takes a minute or two).
 */
import { chromium } from 'playwright-core';
import fs from 'node:fs';

const [port = '5173', tag = 'shot', outDir = 'e2e/screenshots', only] = process.argv.slice(2);
/** World-lab camera: cam = x,y,z (m), look = heading,pitch (deg); tod overrides the default day. */
const VIEWS = {
  port: 'cam=1150,420,-2150&look=148,-17', // Fergusson / Bledisloe from the harbour, north-west
  viaduct_westhaven: 'cam=-150,380,-2050&look=212,-19',
  devonport: 'cam=2480,170,-1520&look=318,-15', // Calliope wharves and the dry dock from the harbour
  harbour_bridge: 'cam=-250,140,-1650&look=268,-6',
  wiri: 'cam=7150,420,16750&look=140,-24',
  eden_park: 'cam=-950,420,2250&look=222,-27',
  port_night: 'cam=1150,420,-2150&look=148,-17&tod=night',
};

fs.mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
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
