/**
 * Harbour traffic screenshots (issue #30): the shared ship / ferry wakes and the visual-only ferries, seen
 * from fixed cameras over the Waitematā (most of them ~1 km up, where the wakes are what reads). Loads an
 * Auckland sortie, parks the player out of the way, pins the camera, and prints the renderer's draw calls
 * and triangles per view so two builds can be compared (?quality=low|medium|high).
 *
 *   npm run dev &  node e2e/harbour-shots.mjs [--base=http://localhost:5173/] [--quality=medium] [--tag=x] [--only=view,view]
 *
 * Writes e2e/screenshots/harbour/<view>-<tag>.png (844×390 @2x; SwiftShader, so slow).
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
const tag = args.tag || quality;
const out = args.out || 'e2e/screenshots/harbour';
fs.mkdirSync(out, { recursive: true });

/** cam: camera position; look: point looked at; mission: the Instant Action stroll (`tod` for night); t: sim time to jump to (s). */
const VIEWS = {
  // the inner harbour from 1 km: Downtown basins, the fairway to Devonport, Stanley Bay and Bayswater
  harbour_1km: { mission: 'ia_stroll_auckland', t: 620, cam: [1000, 1000, -300], look: [1300, 0, -1500] },
  // the Downtown Ferry Terminal from low over the CBD
  downtown_low: { mission: 'ia_stroll_auckland', t: 620, cam: [520, 160, -380], look: [520, 0, -1100] },
  // the upper harbour from 1 km over the Harbour Bridge
  bridge_1km: { mission: 'ia_stroll_auckland', t: 1500, cam: [-800, 1000, -1500], look: [-1900, 0, -2400] },
  // a container ship under way in the outer Gulf, from 1 km
  ship_1km: { mission: 'ia_stroll_auckland', t: 60, ship: true, cam: [0, 1000, 0], look: [0, 0, 0] },
  // the harbour at night: ferry lights and faint wakes
  harbour_night: { mission: 'ia_stroll_auckland', tod: 'night', t: 620, cam: [1000, 700, -300], look: [1300, 0, -1500] },
};

const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
for (const [name, v] of Object.entries(VIEWS)) {
  if (args.only && !String(args.only).split(',').includes(name)) continue;
  const page = await browser.newPage({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 2 });
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
  await page.goto(`${base}?mission=${v.mission}${v.tod ? `&tod=${v.tod}` : ''}&autostart=1&quality=${quality}&view=chase`);
  await page.waitForFunction(() => window.__f35?.game?.session?.world?.player, null, { timeout: 240_000 });
  await page.waitForTimeout(1500);
  const info = await page.evaluate((v) => {
    const g = window.__f35.game;
    const s = g.session;
    const w = s.world;
    // the player: parked high out of the way, invisible to the shot
    const p = w.player;
    p.position.set(0, 9000, 20000);
    // jump the clock (ferries are a pure function of mission time)
    w.time = v.t;
    let cam = v.cam;
    let look = v.look;
    if (v.ship) {
      const ship = w.ground.find((e) => e.type === 'ship' && e.path && e.alive);
      if (!ship) return { error: 'no moving ship' };
      look = [ship.position.x, 0, ship.position.z];
      cam = [ship.position.x + 500, 1000, ship.position.z + 700];
    }
    // a clean frame: no HUD, no help overlay
    g.hud.setVisible(false);
    const camera = s.rig.camera;
    s.rig.update = () => {
      camera.position.set(cam[0], cam[1], cam[2]);
      camera.lookAt(look[0], look[1], look[2]);
      camera.updateMatrixWorld();
    };
    return { ok: true };
  }, v);
  await page.waitForTimeout(5000);
  await page.evaluate(() => {
    for (const el of document.querySelectorAll('body *')) if (!(el instanceof HTMLCanvasElement) && !el.querySelector('canvas')) el.style.visibility = 'hidden';
  });
  await page.waitForTimeout(300);
  const file = `${out}/${name}-${tag}.png`;
  await page.screenshot({ path: file, timeout: 240_000 });
  const stats = await page.evaluate(() => window.__f35.state().renderer);
  console.log(name, JSON.stringify(info), 'renderer', JSON.stringify(stats), errs.length ? errs.slice(0, 3) : 'ok', '→', file);
  await page.close();
}
await browser.close();
