/**
 * UI screenshots of every menu screen via the dev-only UI lab (/labs/ui-lab.html).
 *
 *   node e2e/ui-shots.mjs [--base=http://localhost:5173] [--device=phone|desktop|se|all] [--only=main,briefing]
 *
 * Writes e2e/screenshots/ui/<device>-<screen>.png and reports console errors plus any element that
 * overflows its screen (text clipped horizontally or content wider than the viewport).
 */
import { chromium } from 'playwright-core';
import fs from 'node:fs';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)=?(.*)$/);
    return m ? [m[1], m[2] === '' ? true : m[2]] : [a, true];
  }),
);
const base = args.base || 'http://localhost:5173';
const DEVICES = {
  phone: { viewport: { width: 844, height: 390 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  se: { viewport: { width: 667, height: 375 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  desktop: { viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 },
};
const devices = args.device === 'all' || !args.device ? ['phone', 'se', 'desktop'] : String(args.device).split(',');
const SCREENS = [
  ['splash', 'screen=splash', 1800],
  ['main', 'screen=main', 1200],
  ['campaigns', 'screen=campaigns', 1000],
  ['campaign', 'screen=campaign', 1200],
  ['training', 'screen=training', 1000],
  ['instant', 'screen=instant', 1000],
  ['briefing', 'screen=briefing&mission=c01', 1400],
  ['briefing-obj', 'screen=briefing&mission=c04&tab=obj', 1400],
  ['briefing-hangar', 'screen=briefing&mission=c04&tab=hangar', 1400],
  ['briefing-ia', 'screen=briefing&mission=ia_sam_gauntlet_auckland', 1400],
  ['settings', 'screen=settings', 900],
  ['settings-controls', 'screen=settings&stab=controls&tilt=1', 900],
  ['settings-audio', 'screen=settings&stab=audio', 900],
  ['settings-display', 'screen=settings&stab=display', 900],
  ['pause', 'screen=pause&bg=/e2e/screenshots/hud-cockpit.png', 900],
  ['debrief', 'screen=debrief', 2400],
  ['debrief-fail', 'screen=debrief-fail', 2400],
  ['credits', 'screen=credits', 900],
  ['loading', 'screen=loading', 900],
  ['rotate', 'screen=rotate', 900],
  ['toast', 'screen=toast', 900],
  ['controls', 'screen=controls&bg=/e2e/screenshots/hud-cockpit.png', 700],
  ['controls-left', 'screen=controls&left=1&bg=/e2e/screenshots/hud-cockpit.png', 700],
  ['controls-tilt', 'screen=controls&tilt=1&bg=/e2e/screenshots/hud-cockpit.png', 700],
];
const only = args.only ? String(args.only).split(',') : null;
fs.mkdirSync('e2e/screenshots/ui', { recursive: true });

const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
let problems = 0;
for (const dev of devices) {
  const ctx = await browser.newContext(DEVICES[dev]);
  for (const [name, query, wait] of SCREENS) {
    if (only && !only.includes(name)) continue;
    const page = await ctx.newPage();
    const errors = [];
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${base}/labs/ui-lab.html?${query}`, { waitUntil: 'load' });
    await page.waitForTimeout(wait);
    const file = `e2e/screenshots/ui/${dev}-${name}.png`;
    await page.screenshot({ path: file });
    // overflow audit: text clipped horizontally inside the UI, or anything wider than the viewport
    const issues = await page.evaluate(() => {
      const out = [];
      const W = innerWidth;
      for (const el of document.querySelectorAll('.f35-ui *, .f35-ctl *')) {
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden') continue;
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        if (r.right > W + 1 && !el.closest('.ui-hscroll')) out.push(`off-screen: ${el.className || el.tagName} right=${Math.round(r.right)}`);
        const clips = cs.textOverflow === 'ellipsis' || cs.overflow === 'hidden';
        if (!clips && el.scrollWidth > el.clientWidth + 2 && el.children.length === 0 && el.textContent.trim() && cs.overflowX !== 'auto') {
          out.push(`text overflow: "${el.textContent.trim().slice(0, 40)}" (${el.scrollWidth}>${el.clientWidth})`);
        }
      }
      return out.slice(0, 12);
    });
    const tag = errors.length || issues.length ? '⚠' : 'ok';
    if (errors.length || issues.length) problems++;
    console.log(`${tag} ${file}${errors.length ? `\n   errors: ${errors.join(' | ')}` : ''}${issues.length ? `\n   ${issues.join('\n   ')}` : ''}`);
    await page.close();
  }
  await ctx.close();
}
await browser.close();
console.log(problems ? `${problems} screen(s) with issues` : 'all screens clean');
