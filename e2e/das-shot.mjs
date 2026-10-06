/**
 * DAS see-through window (#116): cockpit view with the designated ground target behind the panel.
 * Puts the jet `--back` m short of the mission's first ground target at `--alt` m, designates the target,
 * and saves one shot plus `__f35.state().hud.das`.
 *
 *   node e2e/das-shot.mjs [--base=http://localhost:5190/] [--mission=ia_strike_auckland] [--alt=1100] [--back=3000]
 *                         [--device=phone|desktop] [--out=e2e/screenshots/das.png]
 */
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const m = a.match(/^--([^=]+)=?(.*)$/); return m ? [m[1], m[2]] : [a, true]; }));
const base = args.base || 'http://localhost:5190/';
const mission = args.mission || 'ia_strike_auckland';
const alt = Number(args.alt || 1100);
const back = Number(args.back || 3000);
const out = args.out || 'e2e/screenshots/das.png';
const desktop = args.device === 'desktop';
fs.mkdirSync(path.dirname(out), { recursive: true });
const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await (await browser.newContext(desktop ? { viewport: { width: 1280, height: 720 } } : { viewport: { width: 844, height: 390 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })).newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(`${base}?mission=${mission}&autostart=1&seed=7&view=cockpit`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__f35?.state?.()?.player, null, { timeout: 60_000 });
const frames = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
const info = await page.evaluate(({ alt, back }) => {
  const f = window.__f35;
  const w = f.game.session.world;
  const t = w.ground.find((g) => g.alive && g.team !== 'blue') ?? w.sams.find((s) => s.alive);
  if (!t) return null;
  f.invulnerable(true);
  f.autopilot(false);
  f.place(t.position.x, alt, t.position.z + back, 0, 170);
  f.setView('cockpit');
  w.player.radar.designatedId = t.id;
  return { id: t.id, kind: t.kind };
}, { alt, back });
console.log('target', JSON.stringify(info));
await frames();
await frames();
await page.screenshot({ path: out });
console.log('hud.das', JSON.stringify(await page.evaluate(() => window.__f35.state().hud?.das ?? null)));
console.log('designated', JSON.stringify(await page.evaluate(() => window.__f35.state().hud?.designated ?? null)));
console.log('renderer', JSON.stringify(await page.evaluate(() => { const r = window.__f35.state().renderer; return r && { calls: r.calls, triangles: r.triangles }; })));
console.log('screenshot', out);
await browser.close();
