/**
 * IRGC Navy fast boats in the target camera (issue #79): in an Auckland sortie (c02, day) spawns a
 * suicide boat, a missile boat and an air-defence boat on open water near a civil ship, designates
 * each in turn and screenshots the PiP (full frame + a crop of the PiP) to e2e/screenshots/boats/.
 *
 *   npx vite --config vite.e2e.config.ts --port 5190 &  node e2e/boats-pip.mjs [--base=http://localhost:5190/] [--quality=medium] [--only=suicide|missile|ad]
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
const quality = args.quality || 'medium';
const out = args.out || 'e2e/screenshots/boats';
fs.mkdirSync(out, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const ctx = await browser.newContext({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
await page.goto(`${base}?mission=c02&autostart=1&view=cockpit&quality=${quality}&fps=1&loadout=strike_sdb2`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__f35?.state().inMission, null, { timeout: 90000 });
await page.waitForTimeout(2000);

// three boats in a row on open water, the AD boat escorting the suicide boat
const ids = await page.evaluate(() => {
  const f = window.__f35;
  f.autopilot(false);
  f.invulnerable(true);
  const w = f.game.session.world;
  const ship = w.ground.find((e) => e.vessel && e.alive);
  const V = w.player.position.constructor;
  const water = (x, z) => [0, 60, -60].every((d) => w.terrain.isWater(x + d, z) && w.terrain.isWater(x, z + d));
  const spots = [];
  for (let r = 600; r < 6000 && spots.length < 3; r += 150)
    for (let a = 0; a < 16 && spots.length < 3; a++) {
      const x = ship.position.x + Math.sin(a) * r;
      const z = ship.position.z + Math.cos(a) * r;
      if (water(x, z) && spots.every((s) => Math.hypot(s.x - x, s.z - z) > 500)) spots.push({ x, z });
    }
  const sb = w.spawnGround({ type: 'suicide_boat', team: 'red', position: new V(spots[0].x, 0, spots[0].z), boat: { chaseId: ship.id } });
  const mb = w.spawnGround({ type: 'missile_boat', team: 'red', position: new V(spots[1].x, 0, spots[1].z), boat: { strike: { targetId: ship.id, range: 1000, countdown: 600 } } });
  const ad = w.spawnSam({ type: 'ad_boat', team: 'red', position: new V(spots[2].x, 0, spots[2].z), known: true, boat: { escortId: sb.id } });
  return { suicide: sb.id, missile: mb.id, ad: ad.id };
});

async function designate(id) {
  return page.evaluate((id) => {
    const w = window.__f35.game.session.world;
    const b = w.getEntity(id);
    const p = w.player;
    p.position.set(b.position.x - 2500, 1200, b.position.z + 2500);
    w.combat.designate(p, id, w);
    if (p.radar.designatedId !== id) p.radar.designatedId = id;
    return { name: b.name, x: Math.round(b.position.x), z: Math.round(b.position.z), speed: Math.round(Math.hypot(b.velocity.x, b.velocity.z)) };
  }, id);
}

async function shot(name) {
  await page.screenshot({ path: `${out}/${name}.png`, timeout: 180000 });
  const r = await page.evaluate(() => window.__f35.targetCam());
  if (r.open && r.rect[2] > 0) {
    const [x, y, w, h] = r.rect;
    await page.screenshot({ path: `${out}/${name}-pip.png`, clip: { x, y, width: w, height: h }, timeout: 180000 });
  }
  return r;
}

const report = [];
for (const [kind, id] of Object.entries(ids)) {
  if (args.only && args.only !== kind) continue; // one boat: a shorter browser session
  let b = await designate(id);
  for (let i = 0; i < 6; i++) {
    b = await designate(id);
    await page.waitForTimeout(1000);
    if ((await page.evaluate(() => window.__f35.targetCam())).rendered === id) break;
  }
  const r = await shot(kind);
  report.push(`${kind} ${b.name} at ${b.x},${b.z} ${b.speed} m/s: pip open=${r.open} rendered=${r.rendered === id}`);
}
const st = await page.evaluate(() => window.__f35.state());
report.push(`dc=${st.renderer.calls} tri=${st.renderer.triangles} errors=${errors.length ? errors.join(' | ') : 'none'}`);
console.log(report.join('\n'));
await page.close();
await browser.close();
