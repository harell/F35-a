/**
 * Playtest r2 F5: in the cockpit an inbound missile draws a red dashed ring with an arrow toward it;
 * the chase view showed only "MISSILE 3s" (the arrows sat on the small radar inset rim). The chase
 * view now draws the same ring round the jet, clear of it, with the arrows and times to impact.
 */
import { describe, expect, it } from 'vitest';
import { PerspectiveCamera, Vector3 } from 'three';
import type { FrameContext } from '../src/core/contracts';
import { DEFAULT_SETTINGS, QUALITY_PRESETS } from '../src/core/data';
import type { CameraMode } from '../src/core/types';
import { createHud } from '../src/hud/Hud';
import { buildMock } from '../src/hud/dev/mockWorld';
import { installPath2D, makeFakeCanvas } from '../src/hud/dev/fakeCanvas';

installPath2D();

function rig(view: CameraMode, W = 844, H = 390) {
  const mock = buildMock('threat');
  const { canvas, ctx: fake } = makeFakeCanvas(W, H, 1);
  const hud = createHud(canvas, mock.events);
  hud.resize(W, H, 1);
  hud.setVisible(true);
  const camera = new PerspectiveCamera(60, W / H, 0.5, 60_000);
  const p = mock.player;
  // behind and above the jet, looking along its nose (the chase camera's framing)
  camera.position.copy(p.position).add(new Vector3(0, 4.5, 20).applyQuaternion(p.quaternion));
  camera.up.set(0, 1, 0).applyQuaternion(p.quaternion);
  camera.lookAt(p.position.clone().add(new Vector3(0, 0, -40).applyQuaternion(p.quaternion)));
  camera.updateMatrixWorld();
  camera.updateProjectionMatrix();
  const ctx: FrameContext = {
    dt: 1 / 30,
    time: 0,
    world: mock.world,
    player: p,
    camera,
    viewMode: view,
    focusId: p.id,
    mission: mock.mission,
    settings: { ...DEFAULT_SETTINGS },
    quality: { ...QUALITY_PRESETS.medium },
    paused: false,
    screen: { width: W, height: H, dpr: 1, safe: { top: 0, right: 0, bottom: 0, left: 0 } },
  };
  for (let i = 0; i < 6; i++) {
    fake.reset();
    ctx.time += 1 / 30;
    mock.tick(1 / 30);
    hud.update(ctx);
  }
  const jet = p.position.clone().project(camera);
  return { arcs: fake.arcs.slice(), texts: fake.texts.slice(), jet: { x: ((jet.x + 1) / 2) * W, y: ((1 - jet.y) / 2) * H } };
}

describe('the inbound-missile direction cue in the chase view (r2 F5)', () => {
  it('chase: a dashed threat ring round the jet, with the times to impact on it', () => {
    const r = rig('chase');
    const ring = r.arcs.find((a) => a.dashed && Math.hypot(a.x - r.jet.x, a.y - r.jet.y) < 2);
    expect(ring, `dashed arcs: ${JSON.stringify(r.arcs.filter((a) => a.dashed))}`).toBeDefined();
    expect(ring!.r).toBeGreaterThanOrEqual(50);
    // the 'threat' scene's three missiles: 7.2 s, 3.4 s, 9.5 s → "8", "4", "10" inside the ring
    for (const tti of ['8', '4', '10']) {
      const t = r.texts.find((x) => x.text === tti && Math.hypot(x.x - r.jet.x, x.y - r.jet.y) < ring!.r);
      expect(t, `TTI ${tti} on the ring`).toBeDefined();
    }
  });

  it('orbit: no ring round the jet (the arrows stay on the radar inset rim)', () => {
    const r = rig('orbit');
    expect(r.arcs.some((a) => a.dashed && Math.hypot(a.x - r.jet.x, a.y - r.jet.y) < 2)).toBe(false);
  });
});
