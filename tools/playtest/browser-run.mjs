/**
 * Browser playtest driver: opens a mission in headless Chromium on the dev server, lets the AI fly
 * the player's jet (or holds scripted controls) and fast-forwards the simulation with
 * window.__f35.simulate(), taking a screenshot and a state dump at each checkpoint. Fast-forward
 * matters: under SwiftShader (cloud containers, CI) the game clock runs at a few % of real time, so
 * waiting in real time shows nothing past the first second.
 *
 *   npx vite --config vite.e2e.config.ts --port 5190 &      # test hooks are on in dev
 *   node tools/playtest/browser-run.mjs --mission=c09 [--at=0,30,120,300] [--view=chase|cockpit|hud|...]
 *       [--difficulty=pilot] [--autopilot=fighter|wingman|interceptor|off] [--controls='{"throttle":1}']
 *       [--device=phone|desktop] [--base=http://localhost:5190/] [--out=e2e/screenshots/playtest]
 *
 * --at: game-time checkpoints in seconds (default 0,60,180). Output: <out>/<mission>-<t>s.png per
 * checkpoint, one JSON line per checkpoint (state, objectives, errors so far) and timings, so the
 * caller can see where the wall-clock went (page load vs simulation vs screenshots).
 * Exit code 1 on page errors or if the mission never starts.
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
const mission = args.mission || 'c01';
const at = String(args.at || '0,60,180').split(',').map(Number).sort((a, b) => a - b);
const view = args.view || 'chase';
const out = args.out || 'e2e/screenshots/playtest';
const autopilot = args.autopilot || 'fighter';
fs.mkdirSync(out, { recursive: true });

const timing = {};
let t = Date.now();
const lap = (k) => {
  timing[k] = (timing[k] ?? 0) + Date.now() - t;
  t = Date.now();
};

const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
});
const ctx = await browser.newContext(
  args.device === 'desktop'
    ? { viewport: { width: 1280, height: 720 } }
    : { viewport: { width: 844, height: 390 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true },
);
const page = await ctx.newPage();
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text().slice(0, 300)));
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`.slice(0, 300)));
lap('browser');

const q = new URLSearchParams({ mission, autostart: '1', view, quality: args.quality || 'low' });
if (args.difficulty) q.set('difficulty', args.difficulty);
await page.goto(`${base}?${q}`, { waitUntil: 'load' });
try {
  await page.waitForFunction(() => window.__f35?.state().inMission, null, { timeout: 90_000 });
} catch {
  const hooks = await page.evaluate(() => !!window.__f35).catch(() => false);
  console.error(hooks ? 'mission did not start within 90 s' : 'no window.__f35: not a dev server / VITE_TEST_HOOKS=1 build');
  await browser.close();
  process.exit(1);
}
lap('load');

await page.evaluate(
  ({ autopilot, controls }) => {
    if (autopilot !== 'off') window.__f35.autopilot(true, autopilot);
    if (controls) window.__f35.controls(JSON.parse(controls));
  },
  { autopilot, controls: args.controls || null },
);

let simT = 0;
for (const target of at) {
  if (target > simT) {
    const state = await page.evaluate((s) => window.__f35.simulate(s), target - simT);
    simT = target;
    lap('simulate');
    if (state?.missionState !== 'running') console.error(`mission ${state?.missionState} at ${state?.time?.toFixed(0)} s`);
  }
  // let a couple of frames render so the screenshot shows the simulated state
  await page.waitForTimeout(300);
  const file = `${out}/${mission}-${target}s.png`;
  await page.screenshot({ path: file });
  lap('screenshot');
  const state = await page.evaluate(() => window.__f35.state());
  console.log(JSON.stringify({ checkpoint: target, file, state, errors: errors.length }));
  if (state.missionState !== 'running') break;
}
await browser.close();
console.log(JSON.stringify({ timingMs: timing, errors }));
process.exit(errors.some((e) => e.startsWith('pageerror')) ? 1 : 0);
