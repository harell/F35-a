/**
 * Screenshot / smoke helper for agents and CI.
 *
 *   node e2e/shot.mjs [--url=http://localhost:5173/?mission=c01&autostart=1] [--wait=4000]
 *                     [--out=e2e/screenshots/shot.png] [--device=phone|desktop] [--eval="js"]
 *                     [--steps=N --every=ms]  (take N screenshots every ms)
 *
 * Uses the pre-installed Chromium (PLAYWRIGHT_BROWSERS_PATH) with SwiftShader GL (slow but works).
 * Prints console errors/warnings and the window.__f35.state() JSON at the end.
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
const url = args.url || 'http://localhost:5173/?mission=c01&autostart=1';
const wait = Number(args.wait || 4000);
const out = args.out || 'e2e/screenshots/shot.png';
const steps = Number(args.steps || 1);
const every = Number(args.every || 1000);
const device = args.device || 'phone';
fs.mkdirSync(path.dirname(out), { recursive: true });

const exe = fs.existsSync('/opt/pw-browsers/chromium') ? undefined : undefined;
const browser = await chromium.launch({
  headless: true,
  executablePath: exe,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
});
const context = await browser.newContext(
  device === 'phone'
    ? { viewport: { width: 844, height: 390 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' }
    : { viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 },
);
const page = await context.newPage();
const logs = [];
page.on('console', (m) => {
  if (['error', 'warning'].includes(m.type())) logs.push(`[${m.type()}] ${m.text()}`);
});
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}\n${e.stack ?? ''}`));
await page.goto(url, { waitUntil: 'load' });
if (args.eval) {
  await page.waitForTimeout(500);
  try { console.log('eval ->', JSON.stringify(await page.evaluate(String(args.eval)))); } catch (e) { console.log('eval error', e.message); }
}
for (let i = 0; i < steps; i++) {
  await page.waitForTimeout(i === 0 ? wait : every);
  const file = steps > 1 ? out.replace(/\.png$/, `-${i}.png`) : out;
  await page.screenshot({ path: file });
  console.log('screenshot', file);
}
try {
  const state = await page.evaluate(() => window.__f35?.state?.());
  console.log('state', JSON.stringify(state));
} catch (e) {
  console.log('state error', e.message);
}
console.log(logs.length ? logs.slice(0, 40).join('\n') : 'no console errors');
await browser.close();
