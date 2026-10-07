/**
 * Landmark buildings (#124) screenshots: hospitals, malls, stations with their platforms and schools from 250–600 m,
 * and two wide views over the suburbs for the budget. The game (mission t01, seed 7, chase view, HUD hidden) through
 * `__f35.camera(cam, look)`, waiting for the tree and house scatters to finish streaming; prints the draw calls and
 * triangles of each view (run it against a server of the layer below for the before numbers).
 *
 *   node e2e/landmark-shots.mjs [--base=http://localhost:5190/] [--out=e2e/screenshots] [--quality=medium] [--only=view,view]
 *                               [--tag=after] [--idle=120 (s to wait for the scatters)] [--mission=t01] [--tod=day] [--cam=x,y,z --look=x,y,z (view 'custom')]
 *
 * (`--tod` applies to Instant Action ids only, e.g. --mission=ia_stroll_auckland --tod=night.)
 * <out>/124-<view>-<tag>.png (1280×720). Headless Chromium with SwiftShader: a minute or two a view.
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
  // Auckland City Hospital and Starship, Grafton, from the south-east
  grafton_hospital: { cam: [1150, 320, 1700], look: [726, 30, 1220] },
  // Middlemore Hospital from the west
  middlemore: { cam: [6450, 380, 12500], look: [7050, 20, 12770] },
  // North Shore Hospital, Takapuna, from the south
  north_shore_hospital: { cam: [-450, 350, -6850], look: [-500, 20, -7400] },
  // Sylvia Park and its station from the south-west
  sylvia_park: { cam: [6600, 400, 8150], look: [7090, 15, 7600] },
  // Westfield Albany from the south
  albany: { cam: [-4700, 380, -12750], look: [-4770, 10, -13310] },
  // Ellerslie station's platforms beside the ribbon, low
  ellerslie_station: { cam: [4300, 160, 5800], look: [4097, 5, 5544] },
  // Henderson: Waitākere Hospital, WestCity mall, the station
  henderson: { cam: [-11000, 600, 4400], look: [-11650, 20, 3200] },
  // wide: the isthmus from Newmarket to Ellerslie and Greenlane (schools, hospital, stations)
  wide_isthmus: { cam: [1500, 1500, 1500], look: [3500, 0, 5500] },
  // wide: Manukau and Middlemore
  wide_south: { cam: [7000, 1800, 9000], look: [9500, 0, 15000] },
};
// --cam=x,y,z --look=x,y,z: one more view, 'custom'
if (args.cam && args.look) VIEWS.custom = { cam: String(args.cam).split(',').map(Number), look: String(args.look).split(',').map(Number) };
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
for (const [variant, flag] of [['photo', '']]) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' || /landmarks|aerial/.test(m.text())) errs.push(m.text());
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
    await page.waitForFunction(() => window.__f35.game.session.env.stats().idle, null, { timeout: Number(args.idle || 120) * 1000, polling: 1000 }).catch(() => console.log(name, 'scatter not idle'));
    await page.waitForTimeout(1500);
    const file = `${out}/124-${name}-${tag}.png`;
    await page.screenshot({ path: file, timeout: 300_000 });
    const r = await page.evaluate(() => ({ ...window.__f35.state().renderer, instances: window.__f35.game.session.env.stats().instances }));
    console.log(`${file}\t${r?.calls} calls\t${r?.triangles} tris\t${r?.instances} instances`);
  }
  console.log(variant, errs.length ? errs.slice(0, 3) : 'ok');
  await page.close();
}
await browser.close();
process.exit(0);
