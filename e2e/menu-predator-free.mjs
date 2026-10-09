/**
 * The main menu's Predator Free 2050 day counter (#211), on a phone in landscape (844×390, touch)
 * and on a desktop (1280×720, mouse): the line sits under the menu list, right-aligned; the explainer
 * opens on hover (desktop), keyboard focus and tap, closes on a tap elsewhere, and on the phone
 * covers no menu item.
 *
 *   node e2e/menu-predator-free.mjs [--base=http://localhost:5173/]
 *
 * Screenshots go to e2e/screenshots/ui/pf-*.png. Exits non-zero on failure.
 */
import { chromium } from 'playwright-core';
import fs from 'node:fs';

const base = (process.argv.find((a) => a.startsWith('--base=')) || '').slice(7) || 'http://localhost:5173/';
fs.mkdirSync('e2e/screenshots/ui', { recursive: true });
const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});

let failures = 0;
const check = (cond, msg, extra = '') => {
  console.log(`${cond ? '  ✓' : '  ✗'} ${msg}${extra ? ` — ${extra}` : ''}`);
  if (!cond) failures++;
};
const overlaps = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

async function menu(name, opts) {
  console.log(`\n[${name}]`);
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  await page.goto(base, { waitUntil: 'load' });
  await page.waitForSelector('.scr-splash', { timeout: 30000 });
  await page.waitForTimeout(800);
  await page.click('.scr-splash');
  await page.waitForSelector('.scr-main:not(.is-leaving)', { timeout: 10000 });
  if (await page.$('.mm-onboard')) {
    await page.click('.mm-onboard .mo-skip');
    await page.waitForSelector('.mm-onboard', { state: 'detached' });
  }
  await page.waitForTimeout(1800);
  const line = await page.$('.mm-pf');
  check(!!line, 'the day counter is on the menu');
  const text = (await line.innerText()).trim();
  check(/^\d+ days to Predator Free 2050$/.test(text), 'text reads "<N> days to Predator Free 2050", no separator', text);
  const lb = await line.boundingBox();
  const items = await page.$$eval('.mm-item', (els) => els.map((e) => e.getBoundingClientRect().toJSON()));
  const last = items[items.length - 1];
  check(lb.y >= last.y + last.height - 1, 'under the menu list');
  check(Math.abs(lb.x + lb.width - (last.x + last.width)) <= 2, "right-aligned with the list's right edge", `${(lb.x + lb.width).toFixed(0)} vs ${(last.x + last.width).toFixed(0)}`);
  check(lb.y + lb.height <= opts.viewport.height, 'fully on screen', `bottom ${(lb.y + lb.height).toFixed(0)}`);
  await page.screenshot({ path: `e2e/screenshots/ui/pf-${name}-closed.png` });
  const popVisible = () => page.$eval('.mm-pf-pop', (e) => getComputedStyle(e).display !== 'none');
  const popBox = () => page.$eval('.mm-pf-pop', (e) => e.getBoundingClientRect().toJSON());
  const coversItem = async () => {
    const pb = await popBox();
    return items.some((it) => overlaps(pb, it));
  };
  const onScreen = async () => {
    const pb = await popBox();
    return pb.x >= 0 && pb.y >= 0 && pb.x + pb.width <= opts.viewport.width && pb.y + pb.height <= opts.viewport.height;
  };
  check(!(await popVisible()), 'explainer closed at first');
  if (opts.hasTouch) {
    await page.tap('.mm-pf');
    await page.waitForTimeout(150);
    check(await popVisible(), 'a tap opens the explainer');
    check(!(await coversItem()), 'the explainer covers no menu item');
    check(await onScreen(), 'the explainer is fully on screen');
    await page.screenshot({ path: `e2e/screenshots/ui/pf-${name}-open.png` });
    await page.tap('.mm-pf');
    await page.waitForTimeout(150);
    check(!(await popVisible()), 'a second tap closes it');
    await page.tap('.mm-pf');
    await page.waitForTimeout(150);
    await page.touchscreen.tap(20, 20);
    await page.waitForTimeout(150);
    check(!(await popVisible()), 'a tap elsewhere closes it');
    check(await page.$('.scr-main:not(.is-leaving)'), 'the tap left the menu up');
  } else {
    await page.hover('.mm-pf');
    await page.waitForTimeout(150);
    check(await popVisible(), 'hover opens the explainer');
    check(await onScreen(), 'the explainer is fully on screen');
    await page.screenshot({ path: `e2e/screenshots/ui/pf-${name}-hover.png` });
    await page.mouse.move(5, 5);
    await page.waitForTimeout(150);
    check(!(await popVisible()), 'it closes when the pointer leaves');
  }
  // keyboard: Tab until the line has focus
  for (let i = 0; i < 20; i++) {
    await page.keyboard.press('Tab');
    if (await page.$eval('.mm-pf', (e) => e === document.activeElement)) break;
  }
  check(await page.$eval('.mm-pf', (e) => e === document.activeElement), 'the line takes keyboard focus');
  check(await popVisible(), 'keyboard focus opens the explainer');
  const label = await page.$eval('.mm-pf', (e) => e.getAttribute('aria-label'));
  check(/days to Predator Free 2050/.test(label || ''), 'aria-label reads the sentence', label);
  await ctx.close();
}

await menu('phone', {
  viewport: { width: 844, height: 390 },
  deviceScaleFactor: 1,
  isMobile: true,
  hasTouch: true,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
});
await menu('desktop', { viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
await browser.close();
console.log(failures ? `\n${failures} failure(s)` : '\nall good');
process.exit(failures ? 1 : 0);
