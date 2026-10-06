/**
 * F35-A — hero buildings: a "today" screenshot of a site in the running game, for the before/after.
 *
 *   npx vite --config vite.e2e.config.ts --port 5190 &        # dev server (test hooks on)
 *   node tools/hero/today-shot.mjs --x=1222 --z=2556 --out=/tmp/hero/<name>/today.jpg [--dist=280] [--alt=140]
 *       [--from=sw|se|nw|ne] [--tod=day|dusk|night] [--quality=high] [--base=http://localhost:5190/]
 *       [--cam=x,y,z --look=x,y,z]   (an explicit camera instead of --from/--dist/--alt, game metres)
 *
 * --x/--z: the site centre in game metres (site.json → centre.game_x / game_z). The camera stands --dist m
 * away horizontally in the --from direction, --alt m up, looking at the centre 10 m above ground.
 * Under SwiftShader a screenshot takes 15–60 s on high: the timeout is generous on purpose.
 */
import { chromium } from 'playwright-core';

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const m = a.match(/^--([^=]+)=?(.*)$/); return [m[1], m[2]]; }));
const x = Number(args.x), z = Number(args.z), dist = Number(args.dist ?? 280), alt = Number(args.alt ?? 140);
const dir = { sw: [-1, 1], se: [1, 1], nw: [-1, -1], ne: [1, -1] }[args.from ?? 'sw'];
const base = args.base ?? 'http://localhost:5190/';
const url = `${base}?mission=ia_stroll_auckland&autostart=1&tod=${args.tod ?? 'day'}&weather=clear&seed=7&quality=${args.quality ?? 'high'}`;

const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.goto(url);
await page.waitForFunction(() => window.__f35?.state?.()?.player, null, { timeout: 180000 });
const frames = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(r)))));
const k = dist / Math.SQRT2;
const triple = (v) => v.split(',').map(Number);
const cam = args.cam ? triple(args.cam) : [x + dir[0] * k, alt, z + dir[1] * k];
const look = args.look ? triple(args.look) : [x, 10, z];
await page.evaluate(([cam, look]) => {
  const f = window.__f35;
  f.autopilot(false); f.invulnerable(true); f.setView('chase'); f.place(15000, 3000, 15000, 0, 150); f.hud(false);
  f.camera(cam, look);
}, [cam, look]);
await frames(); await frames();
await page.screenshot({ path: args.out, type: args.out.endsWith('.png') ? 'png' : 'jpeg', timeout: 240000 });
console.log(args.out);
await browser.close();
