/**
 * Target camera (PiP) smoke test: flies a mission, designates the nearest hostile of a kind
 * (air / sam / ground), switches view and screenshots the target camera window.
 *
 *   node e2e/targetcam.mjs [--base=http://localhost:5173/] [--mission=c01] [--kind=air|civil|sam|ground]
 *                          [--view=cockpit|hud|chase] [--wait=6000] [--steps=1 --every=1000] [--clip] [--dpr=2]
 *                          [--out=e2e/screenshots/targetcam/<mission>-<kind>-<view>.png]
 *
 * Prints the PiP state (target, rect, label) from window.__f35.targetCam() and any console errors.
 * Exits non-zero on page errors or when the window did not open for a designated target.
 */
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)=?(.*)$/);
    return m ? [m[1], m[2] === '' ? true : m[2]] : [a, true];
  }),
);
const base = args.base || 'http://localhost:5173/';
const mission = args.mission || 'c01';
const kind = args.kind || 'air';
const view = args.view || 'cockpit';
const wait = Number(args.wait || 6000);
const steps = Number(args.steps || 1);
const every = Number(args.every || 1000);
const quality = args.quality || 'low';
const out = args.out || `e2e/screenshots/targetcam/${mission}-${kind}-${view}.png`;
fs.mkdirSync(path.dirname(out), { recursive: true });

const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const dpr = Number(args.dpr || 1);
const ctx = await browser.newContext({ viewport: { width: 844, height: 390 }, deviceScaleFactor: dpr, isMobile: true, hasTouch: true });
const page = await ctx.newPage();
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
await page.goto(`${base}?mission=${mission}&autostart=1&view=${view}&quality=${quality}`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__f35?.state().inMission, null, { timeout: 90000 });
await page.waitForTimeout(1500);

const picked = await page.evaluate((kind) => {
  const g = window.__f35.game;
  const s = g.session;
  const p = s.world.player;
  const pool = kind === 'air' || kind === 'civil' ? s.world.aircraft : kind === 'sam' ? s.world.sams : s.world.ground;
  let best = null;
  let bd = Infinity;
  for (const e of pool) {
    if (!e.alive || e.team === p.team) continue;
    if ((kind === 'civil') !== (e.team === 'neutral')) continue;
    const d = e.position.distanceTo(p.position);
    if (d < bd) {
      bd = d;
      best = e;
    }
  }
  if (!best) return null;
  s.world.combat.designate(p, best.id, s.world);
  return { id: best.id, type: best.type, dist: Math.round(bd) };
}, kind);
console.log('designated', JSON.stringify(picked));

for (let i = 0; i < steps; i++) {
  await page.waitForTimeout(i === 0 ? wait : every);
  const file = steps > 1 ? out.replace(/\.png$/, `-${i}.png`) : out;
  // --clip: only the target camera window (with a small margin)
  let clip;
  if (args.clip) {
    const r = await page.evaluate(() => window.__f35.targetCam?.().rect ?? null);
    if (r && r[2] > 0) clip = { x: Math.max(0, r[0] - 6), y: Math.max(0, r[1] - 6), width: r[2] + 12, height: r[3] + 12 };
  }
  await page.screenshot({ path: file, clip });
  console.log('screenshot', file);
}
const pip = await page.evaluate(() => window.__f35.targetCam?.() ?? null);
console.log('targetCam', JSON.stringify(pip));
for (const e of errors.slice(0, 10)) console.log('  error:', e.slice(0, 300));
await browser.close();
const failed = errors.some((e) => e.startsWith('pageerror')) || (picked && pip && !pip.open);
process.exit(failed ? 1 : 0);
