/**
 * Mission sweep smoke test: launches every mission (campaign + training) via
 * ?mission=<id>&autostart=1, lets it run, and reports console errors, entity counts,
 * player state and frame stats. Screenshots go to e2e/screenshots/missions/.
 * Training lessons start on an Ace setting and must fly at Pilot (#68: Game.runSession).
 *
 *   node e2e/missions.mjs [--base=http://localhost:5173/] [--seconds=12] [--only=g01,g02] [--view=chase]
 */
import { chromium } from 'playwright-core';
import fs from 'node:fs';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)=?(.*)$/);
    return m ? [m[1], m[2] === '' ? true : m[2]] : [a, true];
  }),
);
const base = args.base || 'http://localhost:5173/';
const seconds = Number(args.seconds || 12);
const view = args.view || 'chase';
fs.mkdirSync('e2e/screenshots/missions', { recursive: true });

const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const ctx = await browser.newContext({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });

// Discover missions
let page = await ctx.newPage();
await page.goto(base + '?autostart=1', { waitUntil: 'load' });
await page.waitForFunction(() => !!window.__f35, null, { timeout: 30000 });
let missions = await page.evaluate(() => window.__f35.missions());
await page.close();
// --only picks any ids; without it, the missions the player can reach (not a disabled campaign's)
if (args.only) missions = missions.filter((m) => String(args.only).split(',').includes(m.id));
else missions = missions.filter((m) => m.playable !== false);

let failures = 0;
for (const m of missions) {
  page = await ctx.newPage();
  const errors = [];
  page.on('console', (msg) => msg.type() === 'error' && errors.push(msg.text()));
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  const t0 = Date.now();
  // a lesson flies at Pilot whatever the setting: start it on Ace and read what the session got
  const lesson = m.kind === 'training';
  await page.goto(`${base}?mission=${m.id}&autostart=1&view=${view}&quality=low${lesson ? '&difficulty=ace' : ''}`, { waitUntil: 'load' });
  try {
    await page.waitForFunction(() => window.__f35?.state().inMission, null, { timeout: 60000 });
  } catch {
    errors.push('mission did not start within 60 s');
  }
  const loadMs = Date.now() - t0;
  await page.waitForTimeout(seconds * 1000);
  const state = await page.evaluate(() => window.__f35?.state()).catch((e) => ({ error: e.message }));
  await page.screenshot({ path: `e2e/screenshots/missions/${m.id}.png` });
  if (lesson && state?.difficulty !== 'pilot') errors.push(`lesson flies at ${state?.difficulty} on an Ace setting, not Pilot`);
  const ok = errors.length === 0 && state?.inMission && state?.player;
  if (!ok) failures++;
  console.log(
    `${ok ? 'OK  ' : 'FAIL'} ${m.id.padEnd(6)} ${m.title.padEnd(34)} load ${(loadMs / 1000).toFixed(1)}s  t=${state?.time?.toFixed?.(1)}  ` +
      `ac=${state?.counts?.aircraft} sam=${state?.counts?.sams} gnd=${state?.counts?.ground} msl=${state?.counts?.missiles}  ` +
      `player=${state?.player ? `${state.player.alive ? 'alive' : 'DEAD'} hp=${Math.round(state.player.health)} alt=${Math.round(state.player.alt)}m` : 'none'}  ` +
      `diff=${state?.difficulty}  state=${state?.missionState}  dc=${state?.renderer?.calls} tri=${state?.renderer?.triangles}`,
  );
  for (const e of errors.slice(0, 5)) console.log('     ', e.slice(0, 300));
  await page.close();
}
await browser.close();
console.log(failures ? `${failures} mission(s) failed` : 'all missions OK');
process.exit(failures ? 1 : 0);
