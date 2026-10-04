/**
 * Browser playtest driver: opens a mission in headless Chromium on the dev server, lets the AI fly
 * the player's jet (or holds scripted controls) and fast-forwards the simulation with
 * window.__f35.simulate(), taking a screenshot and a state dump at each checkpoint. Fast-forward
 * matters: under SwiftShader (cloud containers, CI) the game clock runs at a few % of real time, so
 * waiting in real time shows nothing past the first second.
 *
 *   npx vite --config vite.e2e.config.ts --port 5190 &      # test hooks are on in dev
 *   node tools/playtest/browser-run.mjs --mission=g01 [--at=0,30,120,300] [--view=chase|cockpit|hud|...]
 *       [--missions=g01,g02,ia_defend_auckland] [--loadout=strike_sdb2] [--shots=0] [--text]
 *       [--difficulty=pilot] [--autopilot=fighter|wingman|interceptor|off] [--controls='{"throttle":1}'] [--seed=7]
 *       [--device=phone|desktop] [--base=http://localhost:5190/] [--out=e2e/screenshots/playtest]
 *       [--tod=dawn|day|dusk|night] [--weather=clear|scattered|overcast]   (Instant Action ids, first mission)
 *
 * --at: game-time checkpoints in seconds (default 0,60,180). Output: <out>/<mission>-<t>s.png per
 * checkpoint, one JSON line per checkpoint (state, objectives, errors so far) and timings, so the
 * caller can see where the wall-clock went (page load vs simulation vs screenshots).
 * --missions: several missions in ONE page (the first by URL, the rest with window.__f35.fly), about
 * 2× faster than a page load each. --shots=0 skips the screenshots (state and draw calls only).
 * State is read after five rendered frames (two weren't enough for a settled `renderer` read), and
 * even then draw calls vary ±10–20 % frame to frame. `state.renderer.pip` says whether the target
 * camera window was open and drawn in that frame and what its pass cost (`calls`, `triangles`): compare
 * reads with the same PiP state. A mission that fails to start is reported and skipped; the run exits 1
 * at the end.
 * --seed: a fixed combat RNG seed (`?seed=`, the autopilot brain's too), and the sim clock held at t = 0
 * until each simulate(), so two runs of the same mission reach the same game state at the same game time,
 * whatever missions flew before it in the page, and read the same draw calls within frame-to-frame noise
 * (seen up to ±8) (#66). Without it every run rolls its own seed and the real-time loop runs a few frames
 * first.
 * --text: also record every string the HUD draws (canvas fillText) over 8 frames at each checkpoint, as
 * `hudText`, so a blinking cue (IN RANGE, SHOOT) is caught even when a screenshot lands on its off phase.
 * Exit code 1 on page errors or if a mission never starts.
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
const missions = String(args.missions || args.mission || 'g01').split(',').filter(Boolean);
const shots = args.shots !== '0';
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

if (args.text) {
  await page.addInitScript(() => {
    const seen = (window.__f35text = []);
    const fillText = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function (text, ...rest) {
      if (seen.length < 20_000) seen.push(String(text));
      return fillText.call(this, text, ...rest);
    };
  });
}
/** `n` rendered frames: the canvas and state().renderer show the simulated state. */
const frames = (n = 2) =>
  page.evaluate((n) => new Promise((r) => { const tick = (k) => (k <= 0 ? r() : requestAnimationFrame(() => tick(k - 1))); tick(n); }), n);
/** The strings the HUD drew over the next 8 frames (--text). */
const hudText = async () => {
  if (!args.text) return undefined;
  await page.evaluate(() => (window.__f35text.length = 0));
  await frames(8);
  return page.evaluate(() => [...new Set(window.__f35text.map((t) => t.trim()).filter(Boolean))]);
};

let failed = 0;
for (const [k, mission] of missions.entries()) {
  const errors0 = errors.length;
  if (k === 0) {
    const q = new URLSearchParams({ mission, autostart: '1', view, quality: args.quality || 'low' });
    if (args.difficulty) q.set('difficulty', args.difficulty);
    if (args.loadout) q.set('loadout', args.loadout);
    if (args.seed !== undefined) q.set('seed', String(args.seed));
    if (args.tod) q.set('tod', args.tod);
    if (args.weather) q.set('weather', args.weather);
    await page.goto(`${base}?${q}`, { waitUntil: 'load' });
  }
  try {
    if (k > 0) await page.evaluate(({ id, loadout }) => window.__f35.fly(id, loadout || undefined), { id: mission, loadout: args.loadout });
    await page.waitForFunction((id) => window.__f35?.state().inMission && window.__f35.state().mission === id && window.__f35.state().missionState === 'running', mission, { timeout: 90_000 });
  } catch (e) {
    const hooks = await page.evaluate(() => !!window.__f35).catch(() => false);
    if (!hooks) {
      console.error('no window.__f35: not a dev server / VITE_TEST_HOOKS=1 build');
      await browser.close();
      process.exit(1);
    }
    failed++;
    console.log(JSON.stringify({ mission, error: String(e?.message ?? e).split('\n')[0].slice(0, 200) }));
    lap('load');
    continue;
  }
  lap('load');

  await page.evaluate(
    ({ autopilot, controls, view }) => {
      window.__f35.setView(view);
      window.__f35.autopilot(autopilot !== 'off', autopilot === 'off' ? undefined : autopilot);
      window.__f35.controls(controls ? JSON.parse(controls) : null);
    },
    { autopilot, controls: args.controls || null, view },
  );

  let simT = 0;
  for (const target of at) {
    if (target > simT) {
      const state = await page.evaluate((s) => window.__f35.simulate(s), target - simT);
      simT = target;
      lap('simulate');
      if (state?.missionState !== 'running') console.error(`${mission}: mission ${state?.missionState} at ${state?.time?.toFixed(0)} s`);
    }
    await frames(5);
    let file = null;
    if (shots) {
      file = `${out}/${mission}-${target}s.png`;
      await page.screenshot({ path: file });
      lap('screenshot');
    }
    const text = await hudText();
    const state = await page.evaluate(() => window.__f35.state());
    console.log(JSON.stringify({ mission, checkpoint: target, file, state, hudText: text, errors: errors.slice(errors0) }));
    lap('read');
    if (state.missionState !== 'running') break;
  }
}
await browser.close();
console.log(JSON.stringify({ timingMs: timing, errors }));
process.exit(failed > 0 || errors.some((e) => e.startsWith('pageerror')) ? 1 : 0);
