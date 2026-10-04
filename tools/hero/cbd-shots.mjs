/**
 * F35-A — hero buildings: before/after shots of the CBD from fixed cameras, with the renderer's draw calls and triangles
 * (issue #156's performance check). Run it against two dev servers (master and the branch) and compare.
 *
 *   npx vite --config vite.e2e.config.ts --port 5190 &
 *   node tools/hero/cbd-shots.mjs --out=/tmp/hero/shots/after [--base=http://localhost:5190/] [--quality=medium]
 *       [--tod=day|night] [--only=north,east] [--cams='name:x,y,z:lx,ly,lz;…']
 *
 * Writes <out>-<camera>.jpg and prints one JSON line per camera: {cam, calls, triangles}.
 */
import { chromium } from 'playwright-core';

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const m = a.match(/^--([^=]+)=?(.*)$/); return [m[1], m[2]]; }));
const base = args.base ?? 'http://localhost:5190/';
const url = `${base}?mission=ia_stroll_auckland&autostart=1&tod=${args.tod ?? 'day'}&weather=clear&seed=7&quality=${args.quality ?? 'medium'}`;
// cameras: the CBD from the harbour (north), from the east (Parnell), from the south (K Rd) and over Queen St
let CAMS = {
  north: [[250, 260, -1500], [300, 60, -150]],
  east: [[1600, 240, -150], [300, 60, -150]],
  south: [[250, 300, 1500], [300, 60, 0]],
  queen: [[600, 420, 400], [250, 40, -200]],
};
if (args.cams) CAMS = Object.fromEntries(args.cams.split(';').map((c) => { const [n, p, l] = c.split(':'); return [n, [p.split(',').map(Number), l.split(',').map(Number)]]; }));
const only = args.only ? args.only.split(',') : Object.keys(CAMS);

const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.goto(url);
await page.waitForFunction(() => window.__f35?.state?.()?.player, null, { timeout: 240000 });
const frames = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(r)))));
await page.evaluate(() => { const f = window.__f35; f.autopilot(false); f.invulnerable(true); f.setView('chase'); f.place(15000, 3000, 15000, 0, 150); f.hud(false); });
for (const name of only) {
  const [cam, look] = CAMS[name];
  await page.evaluate(([c, l]) => window.__f35.camera(c, l), [cam, look]);
  await frames(); await frames();
  const path = `${args.out}-${name}.jpg`;
  await page.screenshot({ path, type: 'jpeg', quality: 85, timeout: 240000 });
  const r = await page.evaluate(() => window.__f35.state().renderer);
  console.log(JSON.stringify({ cam: name, calls: r?.calls, triangles: r?.triangles, path }));
}
await browser.close();
