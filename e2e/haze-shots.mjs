/**
 * Before/after shots for the distance haze and colour grade (issue #139): two fixed cameras over the
 * CBD, per time of day / weather / quality, HUD hidden.
 *
 *   node e2e/haze-shots.mjs [--base=http://localhost:5190] [--out=e2e/screenshots/haze] [--tag=after]
 *                           [--cases=day:scattered:high,dusk:clear:low]
 *
 * Needs the dev server (`npx vite --config vite.e2e.config.ts --port 5190`). Prints draw calls and
 * triangles for each shot.
 */
import { chromium } from 'playwright-core';
import fs from 'node:fs';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)=?(.*)$/);
    return m ? [m[1], m[2] === '' ? true : m[2]] : [a, true];
  }),
);
const base = args.base || 'http://localhost:5190';
const out = args.out || 'e2e/screenshots/haze';
const tag = args.tag || 'shot';
const cases = String(args.cases || 'day:scattered:high,dusk:scattered:high,day:overcast:high,day:scattered:low,dusk:scattered:low,day:overcast:low')
  .split(',')
  .map((c) => c.split(':'));
const CAMS = {
  gulf: [[-2500, 1500, 3000], [0, 0, 0]],
  cbd260: [[-1400, 260, 900], [0, 120, -100]],
};
fs.mkdirSync(out, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
const page = await context.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.log('[console.error]', m.text().slice(0, 600)); });
for (const [tod, weather, quality] of cases) {
  await page.goto(`${base}/?mission=ia_stroll_auckland&autostart=1&seed=7&quality=${quality}&tod=${tod}&weather=${weather}`, { waitUntil: 'load', timeout: 180000 });
  await page.waitForFunction(() => window.__f35?.state?.()?.mission, null, { timeout: 60000 });
  await page.evaluate(() => {
    const f = window.__f35;
    f.autopilot(false);
    f.setView('chase');
    f.place(15000, 3000, 15000, 0, 150);
    f.hud(false);
  });
  for (const [name, [pos, look]] of Object.entries(CAMS)) {
    await page.evaluate(([p, l]) => window.__f35.camera(p, l), [pos, look]);
    // let the terrain and scenery stream in around the new camera
    await page.waitForTimeout(6000);
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const file = `${out}/${name}-${tod}-${weather}-${quality}-${tag}.png`;
    await page.screenshot({ path: file, timeout: 120000 });
    const r = await page.evaluate(() => window.__f35.state().renderer);
    console.log(file, JSON.stringify({ calls: r?.calls, triangles: r?.triangles }));
  }
}
await browser.close();
