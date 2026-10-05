/**
 * Train screenshots (issue #146): AT AM class sets and KiwiRail freight on their timetable, from fixed
 * cameras. Each view finds the first moment a train (of a line / length) is at its spot
 * (`__f35.trains(x, z, { ahead })`), jumps the sim clock there, and shoots it twice from the same camera:
 * `-before` with the train meshes hidden (what master draws) and `-after`, printing the renderer's draw
 * calls and triangles for each, and the train meshes' own instance and triangle counts.
 *
 *   npx vite --config vite.e2e.config.ts --port 5193 &
 *   node e2e/train-shots.mjs [--base=http://localhost:5193/] [--quality=medium] [--only=view,view]
 *
 * Writes e2e/screenshots/146-<view>-{before,after}.png (844×390 @2x; SwiftShader, so slow).
 */
import { chromium } from 'playwright-core';
import fs from 'node:fs';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)=?(.*)$/);
    return m ? [m[1], m[2] === '' ? true : m[2]] : [a, true];
  }),
);
const base = args.base || 'http://localhost:5193/';
const quality = args.quality || 'medium';
const out = args.out || 'e2e/screenshots';
fs.mkdirSync(out, { recursive: true });

/**
 * at: where the train's middle must be (world XZ) and how close (r); line / cars: which train; cam: camera
 * offset from `at` (m); look: what the camera looks at, offset from `at`.
 */
const VIEWS = {
  // a 6-car set coming out of the Britomart tunnel's east portal (the CRL's way out of Waitematā) at Quay Park
  waitemata_portal: { at: [1330, -185], r: 120, cars: 6, cam: [130, 70, -150], look: [-50, 0, -20] },
  // a set at the CRL's south portal, Maungawhau station
  maungawhau_portal: { at: [-300, 2110], r: 140, cam: [-160, 70, 170], look: [20, 0, -40] },
  // a train crossing Newmarket (the junction and the station)
  newmarket: { at: [1481, 2354], r: 220, cam: [-230, 130, 240], look: [0, 0, 0] },
  // a freight train in the port's rail yard along The Strand
  port_freight: { at: [1650, -150], r: 400, line: 3, cam: [-160, 120, -280], look: [80, 0, 30] },
  // night: a set at Newmarket, lit windows and headlights
  night_newmarket: { tod: 'night', at: [1481, 2354], r: 260, cam: [-230, 130, 240], look: [0, 0, 0] },
};

const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
for (const [name, v] of Object.entries(VIEWS)) {
  if (args.only && !String(args.only).split(',').includes(name)) continue;
  const page = await browser.newPage({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 2 });
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
  await page.goto(`${base}?mission=ia_stroll_auckland${v.tod ? `&tod=${v.tod}` : ''}&autostart=1&seed=7&quality=${quality}&view=chase`);
  await page.waitForFunction(() => window.__f35?.game?.session?.world?.trains, null, { timeout: 300_000 });
  await page.waitForTimeout(1500);
  const info = await page.evaluate((v) => {
    const f = window.__f35;
    const s = f.game.session;
    const w = s.world;
    // the player: parked high out of the way (the trains near it are sim entities; the camera is elsewhere)
    w.player.position.set(v.at[0], 6000, v.at[1] + 3000);
    const hit = f.trains(v.at[0], v.at[1], { ahead: 4 * 3600, radius: v.r, line: v.line, cars: v.cars });
    if (!hit) return { error: 'no train comes by' };
    w.time = hit.t;
    f.hud(false);
    const cam = [v.at[0] + v.cam[0], v.cam[1], v.at[1] + v.cam[2]];
    const look = [v.at[0] + v.look[0], v.look[1], v.at[1] + v.look[2]];
    const ground = w.terrain.heightAt(look[0], look[2]);
    f.camera([cam[0], cam[1] + ground, cam[2]], [look[0], ground + 2, look[2]]);
    return { train: hit, near: f.trains(v.at[0], v.at[1]).slice(0, 3) };
  }, v);
  if (info.error) {
    console.log(name, info.error);
    await page.close();
    continue;
  }
  await page.evaluate(() => {
    for (const el of document.querySelectorAll('body *')) if (!(el instanceof HTMLCanvasElement) && !el.querySelector('canvas')) el.style.visibility = 'hidden';
  });
  // before (train meshes hidden: what master draws), after, and hidden again (the draw-call delta at the same moment)
  for (const phase of ['before', 'after', 'hidden']) {
    await page.evaluate((phase) => {
      const s = window.__f35.game.session;
      s.scene?.traverse?.((o) => o.name?.startsWith('trains-') && (o.visible = phase === 'after'));
      window.__f35.hold?.(true);
    }, phase);
    await page.waitForTimeout(4000);
    const file = `${out}/146-${name}-${phase}.png`;
    if (phase !== 'hidden') await page.screenshot({ path: file, timeout: 300_000 });
    const stats = await page.evaluate(() => {
      const s = window.__f35.game.session;
      const meshes = {};
      s.scene?.traverse?.((o) => {
        if (!o.name?.startsWith('trains-') || !o.isInstancedMesh) return;
        const g = o.geometry;
        const tris = (g.index ? g.index.count : g.attributes.position.count) / 3;
        meshes[o.name] = { instances: o.count, triangles: tris * o.count, visible: o.visible };
      });
      return { renderer: window.__f35.state().renderer, meshes };
    });
    console.log(name, phase, JSON.stringify(stats.renderer.calls), 'calls', stats.renderer.triangles, 'tris', JSON.stringify(stats.meshes), '→', file);
  }
  console.log(name, JSON.stringify(info), errs.length ? errs.slice(0, 3) : 'ok');
  await page.close();
}
await browser.close();
