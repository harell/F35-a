/**
 * Tap-to-designate in the target (padlock) camera view (#71, decided 2026-10-02): a tap on a contact's
 * box designates it there too, as in the chase view. The real CameraRig frames the HUD lab's mock
 * world, the real HUD draws it on a recording canvas, and a tap runs the same path as Game.handleTap:
 * hud.pick() at the tap, then combat.designate().
 */
import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import type { FrameContext } from '../src/core/contracts';
import { DEFAULT_SETTINGS, QUALITY_PRESETS } from '../src/core/data';
import type { CameraMode } from '../src/core/types';
import { createHud } from '../src/hud/Hud';
import { buildMock } from '../src/hud/dev/mockWorld';
import { installPath2D, makeFakeCanvas } from '../src/hud/dev/fakeCanvas';
import { createCameraRig } from '../src/render/CameraRig';

installPath2D();

const W = 844;
const H = 390;

function scene(view: CameraMode) {
  const mock = buildMock('aa');
  const { canvas } = makeFakeCanvas(W, H, 1);
  const hud = createHud(canvas, mock.events);
  hud.resize(W, H, 1);
  hud.setVisible(true);
  const entities = { getEyeOffset: () => new Vector3(0, 1.02, -3.52) } as unknown as Parameters<typeof createCameraRig>[1];
  const rig = createCameraRig(mock.world, entities, { ...DEFAULT_SETTINGS });
  rig.resize(W, H);
  rig.setMode(view);
  const p = mock.player;
  const ctx: FrameContext = {
    dt: 1 / 30,
    time: 0,
    world: mock.world,
    player: p,
    camera: rig.camera,
    viewMode: view,
    focusId: p.id,
    mission: mock.mission,
    settings: { ...DEFAULT_SETTINGS },
    quality: { ...QUALITY_PRESETS.medium },
    paused: false,
    screen: { width: W, height: H, dpr: 1, safe: { top: 0, right: 0, bottom: 0, left: 0 } },
  };
  /** One game frame's presentation: the camera, then the HUD (which registers what it drew for picking). */
  const frame = () => {
    ctx.time += ctx.dt;
    rig.update(ctx);
    ctx.viewMode = rig.mode;
    ctx.focusId = rig.focusId;
    hud.update(ctx);
  };
  for (let i = 0; i < 30; i++) frame();
  /** Game.handleTap: the HUD symbol under the tap gets designated. */
  const tap = (x: number, y: number) => {
    const id = hud.pick(x, y);
    if (id != null) mock.world.combat.designate(p, id, mock.world);
    return id;
  };
  /** Where each hostile contact (other than the designated one) is on screen now. */
  const others = () => {
    const out: { id: number; x: number; y: number }[] = [];
    for (const c of p.radar.contacts) {
      const e = mock.world.getEntity(c.id);
      if (!e || e.team === p.team || e.id === p.radar.designatedId) continue;
      const v = e.position.clone().project(rig.camera);
      const x = ((v.x + 1) / 2) * W;
      const y = ((1 - v.y) / 2) * H;
      // well inside the screen and clear of the touch controls along the bottom
      if (v.z < 1 && x > 80 && x < W - 80 && y > 40 && y < H - 120) out.push({ id: e.id, x, y });
    }
    return out;
  };
  return { mock, rig, frame, tap, others, p };
}

describe('tap to designate: the target (padlock) view works like chase (#71)', () => {
  for (const view of ['chase', 'target'] as const) {
    it(`${view}: a tap on a contact's box designates that contact`, () => {
      const s = scene(view);
      expect(s.rig.mode).toBe(view);
      const first = s.p.radar.designatedId;
      expect(first).not.toBeNull();
      const boxes = s.others();
      expect(boxes.length, `another contact on screen in the ${view} view`).toBeGreaterThan(0);
      const box = boxes[0];
      expect(s.tap(box.x, box.y)).toBe(box.id);
      expect(s.p.radar.designatedId).toBe(box.id);
      // the view carries on: the padlock swings onto the newly designated contact
      for (let i = 0; i < 30; i++) s.frame();
      expect(s.rig.mode).toBe(view);
      expect(s.rig.focusId).toBe(view === 'target' ? box.id : s.p.id);
    });
  }
});
