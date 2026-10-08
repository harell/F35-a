/**
 * Superyacht screenshots (issue #145): Koru, A and Aquijo at their berths and Serene under way with her wake, from
 * fixed cameras in A Stroll in the Park, plus the waterfront with every yacht in view for the draw-call / triangle
 * count. Prints the renderer's draw calls and triangles per view; `--hide` moves the yachts 30 km away first, so the
 * same views read the cost without them.
 *
 *   npx vite --config vite.e2e.config.ts --port 5190 &
 *   node e2e/superyacht-shots.mjs [--base=http://localhost:5190/] [--quality=medium] [--tag=x] [--only=view,view] [--hide]
 *
 * Writes e2e/screenshots/superyachts/<view>-<tag>.png (844×390 @2x; SwiftShader, so slow).
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
const tag = args.tag || (args.hide ? `${quality}-hidden` : quality);
const out = args.out || 'e2e/screenshots/superyachts';
fs.mkdirSync(out, { recursive: true });

/**
 * yacht: frame that yacht (vessel class) from `off` metres (her local frame: x starboard, y up, z aft) looking at her
 * centre `lookUp` m up; cam / look: fixed world cameras. tod: time of day.
 */
const VIEWS = {
  // close shots from the reference photos' side and angle (local frame: +x starboard, +z aft)
  koru: { yacht: 'koru', off: [70, 4, -115], lookUp: 24 },
  a: { yacht: 'a', off: [120, 4, 10], lookUp: 9 },
  aquijo: { yacht: 'aquijo', off: [95, 40, -5], lookUp: 30 },
  serene: { yacht: 'serene', off: [-150, 4, 0], lookUp: 9 },
  // the same yachts from 300 m, a pilot's low pass
  koru_300: { yacht: 'koru', off: [280, 60, -60], lookUp: 20 },
  a_300: { yacht: 'a', off: [280, 60, 60], lookUp: 8 },
  // Serene under way from above and astern: the wake
  serene_wake: { yacht: 'serene', off: [120, 220, 380], lookUp: 0 },
  // the waterfront with all three berths and the harbour loop in view (draw calls, triangles)
  waterfront: { cam: [-420, 420, -250], look: [-470, 0, -1000] },
  // night: deck, window and underwater lights
  koru_night: { yacht: 'koru', off: [230, 25, -40], lookUp: 18, tod: 'night' },
  waterfront_night: { cam: [-420, 420, -250], look: [-470, 0, -1000], tod: 'night' },
};

const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
for (const [name, v] of Object.entries(VIEWS)) {
  if (args.only && !String(args.only).split(',').includes(name)) continue;
  const page = await browser.newPage({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 2 });
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
  await page.goto(`${base}?mission=ia_stroll_auckland&autostart=1&seed=7&quality=${quality}&tod=${v.tod || 'day'}&view=chase`);
  await page.waitForFunction(() => window.__f35?.game?.session?.world?.player, null, { timeout: 240_000 });
  await page.waitForTimeout(1500);
  const info = await page.evaluate(
    ({ v, hide }) => {
      const f = window.__f35;
      const w = f.game.session.world;
      w.player.position.set(0, 9000, 20000); // out of the shot
      const yachts = w.ground.filter((g) => g.type === 'ship' && ['koru', 'serene', 'a', 'aquijo'].includes(g.vessel));
      f.simulate(20); // Serene a little way along her loop, her wake laid
      let cam = v.cam;
      let look = v.look;
      if (v.yacht) {
        const y = yachts.find((g) => g.vessel === v.yacht);
        if (!y) return { error: `no ${v.yacht}`, yachts: yachts.map((g) => g.vessel) };
        const q = y.quaternion;
        const o = { x: v.off[0], y: v.off[1], z: v.off[2] };
        // rotate the offset by the yacht's heading (yaw only)
        const yaw = 2 * Math.atan2(q.y, q.w);
        const c = Math.cos(yaw);
        const s = Math.sin(yaw);
        cam = [y.position.x + o.x * c + o.z * s, o.y, y.position.z - o.x * s + o.z * c];
        look = [y.position.x, v.lookUp, y.position.z];
      }
      if (hide) for (const y of yachts) y.position.set(0, 0, 30000);
      f.hud(false);
      f.camera(cam, look);
      return { cam: cam.map(Math.round), look: look.map(Math.round), yachts: yachts.map((g) => `${g.name}${g.path ? ' (under way)' : ''}`) };
    },
    { v, hide: !!args.hide },
  );
  await page.waitForTimeout(4000);
  await page.evaluate(() => {
    for (const el of document.querySelectorAll('body *')) if (!(el instanceof HTMLCanvasElement) && !el.querySelector('canvas')) el.style.visibility = 'hidden';
  });
  await page.waitForTimeout(300);
  const file = `${out}/${name}-${tag}.png`;
  await page.screenshot({ path: file, timeout: 240_000 });
  const stats = await page.evaluate(() => {
    const r = window.__f35.state().renderer;
    return { calls: r.calls ?? r.drawCalls, triangles: r.triangles };
  });
  console.log(name, JSON.stringify(info), 'renderer', JSON.stringify(stats), errs.length ? errs.slice(0, 3) : 'ok', '→', file);
  await page.close();
}
await browser.close();
