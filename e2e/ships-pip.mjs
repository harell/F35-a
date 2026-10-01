/**
 * Civil ships in the target camera (issue #29): designates a container ship and a cruise liner in an
 * Auckland sortie (day: c02, night: c10), screenshots the PiP, then sinks one and captures the
 * sinking at several stages. Screenshots (full frame + a 3× crop of the PiP) go to
 * e2e/screenshots/ships/.
 *
 *   npm run dev &  node e2e/ships-pip.mjs [--base=http://localhost:5173/] [--quality=medium]
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
const quality = args.quality || 'medium';
const out = args.out || 'e2e/screenshots/ships';
fs.mkdirSync(out, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const ctx = await browser.newContext({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });

/** Put the player 4 km off the ship, 1,500 m up, heading at it, and designate it. */
async function designate(page, vessel) {
  return page.evaluate((vessel) => {
    const g = window.__f35.game;
    const w = g.session.world;
    const s = w.ground.find((e) => e.vessel === vessel && e.alive && (vessel !== 'container' || e.anchored));
    if (!s) return null;
    const p = w.player;
    p.position.set(s.position.x - 2800, 1500, s.position.z + 2800);
    w.combat.designate(p, s.id, w);
    if (p.radar.designatedId !== s.id) p.radar.designatedId = s.id;
    return { id: s.id, name: s.name, anchored: s.anchored };
  }, vessel);
}

async function shot(page, name) {
  await page.screenshot({ path: `${out}/${name}.png`, timeout: 180000 });
  const r = await page.evaluate(() => window.__f35.targetCam());
  if (r.open && r.rect[2] > 0) {
    const [x, y, w, h] = r.rect;
    await page.screenshot({ path: `${out}/${name}-pip.png`, clip: { x, y, width: w, height: h }, timeout: 180000 });
  }
  return r;
}

async function fly(mission) {
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto(`${base}?mission=${mission}&autostart=1&view=cockpit&quality=${quality}&fps=1`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__f35?.state().inMission, null, { timeout: 90000 });
  await page.waitForTimeout(3000);
  return { page, errors };
}

const report = [];
for (const [mission, tod] of [
  ['c02', 'day'],
  ['c10', 'night'],
]) {
  const { page, errors } = await fly(mission);
  for (const vessel of ['container', 'cruise']) {
    const s = await designate(page, vessel);
    if (!s) {
      report.push(`${mission} ${vessel}: no ship`);
      continue;
    }
    for (let i = 0; i < 4; i++) {
      await designate(page, vessel);
      await page.waitForTimeout(1000);
    }
    const r = await shot(page, `${tod}-${vessel}`);
    report.push(`${mission} ${tod} ${vessel} ${s.name}${s.anchored ? ' (anchored)' : ''}: pip open=${r.open} rendered=${r.rendered === s.id}`);
  }
  if (tod === 'day') {
    // sinking stages: kill the designated ship, then (within the PiP hold) show the pose T s in
    for (const T of [2, 20, 40, 60]) {
      const s = await designate(page, 'container');
      await page.waitForTimeout(2500);
      await page.evaluate(
        ({ id, T }) => {
          const w = window.__f35.game.session.world;
          const e = w.getEntity(id);
          w.applyDamage(e, 5, w.player.id, 'gbu31');
          e.destroyedAt = w.time - T;
        },
        { id: s.id, T },
      );
      await page.waitForTimeout(2500);
      const r = await shot(page, `sinking-${String(T).padStart(2, '0')}s`);
      report.push(`sinking +${T}s: pip open=${r.open}`);
      // revive it for the next stage
      await page.evaluate((id) => {
        const e = window.__f35.game.session.world.getEntity(id);
        e.alive = true;
        e.health = e.maxHealth;
        e.destroyedAt = -1;
      }, s.id);
      await page.waitForTimeout(6500); // let the PiP hold run out
    }
  }
  const st = await page.evaluate(() => window.__f35.state());
  report.push(`${mission}: dc=${st.renderer.calls} tri=${st.renderer.triangles} errors=${errors.length ? errors.join(' | ') : 'none'}`);
  await page.close();
}
console.log(report.join('\n'));
await browser.close();
