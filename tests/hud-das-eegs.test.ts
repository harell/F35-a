/**
 * #116, the pilot's suggestions 1 and 3:
 *  - DAS see-through: in the cockpit view a designated target behind the panel or the PCD gets a window
 *    cut through the cockpit (Cockpit.update opens it, the mask disc keeps the panel out of it), and the
 *    HMD draws the target box inside it instead of only an off-screen cue (finding 1.2-i).
 *  - EEGS: the gun funnel carries a range bar across it at the bandit's range.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Mesh, PerspectiveCamera, Quaternion, Vector3, type Object3D } from 'three';
import type { FrameContext } from '../src/core/contracts';
import { DEFAULT_SETTINGS, QUALITY_PRESETS } from '../src/core/data';
import type { CameraMode } from '../src/core/types';
import { createCockpit } from '../src/hud/Cockpit';
import { createHud, type HudTestHooks } from '../src/hud/Hud';
import { dasRadius, dasWindow } from '../src/hud/cockpit/das';
import { pcdScreenRect } from '../src/hud/cockpit/geometry';
import { buildMock, type Scenario } from '../src/hud/dev/mockWorld';
import { installPath2D, makeFakeCanvas } from '../src/hud/dev/fakeCanvas';
import { computeLayout, makeLayout } from '../src/hud/hmd/layout';
import { funnelIndexAt } from '../src/hud/hmd/weapons';
import { restHead } from '../src/render/camera/cameraMath';

installPath2D();
const g = globalThis as unknown as { document?: unknown };
const prevDoc = g.document;
beforeAll(() => {
  // the PCD draws into a canvas: give it a recording one
  g.document = { createElement: () => makeFakeCanvas(1024, 512).canvas };
});
afterAll(() => {
  g.document = prevDoc;
  dasWindow.active = false;
});

const W = 844;
const H = 390;
const noSafe = { top: 0, right: 0, bottom: 0, left: 0 };
const LIP = computeLayout(makeLayout(), W, H, noSafe, Math.tan((60 * Math.PI) / 360), true).cockpitTop;

function rig(scene: Scenario, view: CameraMode = 'cockpit') {
  const mock = buildMock(scene);
  const p = mock.player;
  const camera = new PerspectiveCamera(60, W / H, 0.5, 60_000);
  camera.position.set(0, 1.02, -3.52).applyQuaternion(p.quaternion).add(p.position);
  camera.quaternion.copy(p.quaternion).multiply(restHead(view, new Quaternion()));
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
    screen: { width: W, height: H, dpr: 1, safe: noSafe },
  };
  /** World point `dist` m from the eye that projects to screen (x, y). */
  const at = (x: number, y: number, dist: number) => {
    const v = new Vector3((x / W) * 2 - 1, -((y / H) * 2 - 1), 0.5).unproject(camera);
    return camera.position.clone().add(v.sub(camera.position).normalize().multiplyScalar(dist));
  };
  const target = () => mock.world.getEntity(p.radar.lockedId ?? p.radar.designatedId)!;
  return { mock, p, camera, ctx, at, target };
}

function cockpitFor(r: ReturnType<typeof rig>) {
  const cockpit = createCockpit(r.mock.events, { ...QUALITY_PRESETS.medium });
  cockpit.resize(W, H);
  cockpit.visible = true;
  let mask: Mesh | null = null;
  // (the mask rides on the cockpit camera, which the scene holds)
  const find = (o: Object3D) => {
    if (o.name === 'dasMask') mask = o as Mesh;
    o.children.forEach(find);
  };
  return {
    cockpit,
    update() {
      cockpit.update(r.ctx, new Quaternion());
      mask = null;
      // the camera's children: reach them through the render pass's scene
      const renderer = { autoClear: true, clearDepth() {}, render(s: Object3D) { find(s); } } as unknown as Parameters<typeof cockpit.render>[0];
      cockpit.render(renderer);
      return mask as Mesh | null;
    },
  };
}

describe('DAS see-through window (#116, 1.2-i)', () => {
  it('opens on a designated ground target behind the PCD, centred on it, and the mask disc shows', () => {
    const r = rig('ag');
    const c = cockpitFor(r);
    r.target().position.copy(r.at(W / 2 + 30, H - 70, 6000));
    const mask = c.update();
    expect(dasWindow.active).toBe(true);
    expect(dasWindow.id).toBe(r.target().id);
    expect(dasWindow.x).toBeCloseTo(W / 2 + 30, 0);
    expect(dasWindow.y).toBeCloseTo(H - 70, 0);
    expect(dasWindow.r).toBe(dasRadius(H));
    expect(mask?.visible).toBe(true);
    c.cockpit.dispose();
  });

  it('stays shut for a target in view over the coaming, one off screen, or with nothing designated', () => {
    const r = rig('ag');
    const c = cockpitFor(r);
    r.target().position.copy(r.at(W / 2, LIP - 60, 6000));
    expect(c.update()?.visible).toBe(false);
    expect(dasWindow.active).toBe(false);
    // behind us
    r.target().position.copy(r.p.position.clone().add(new Vector3(0, -500, 4000).applyQuaternion(r.p.quaternion)));
    c.update();
    expect(dasWindow.active).toBe(false);
    r.p.radar.designatedId = null;
    r.p.radar.lockedId = null;
    c.update();
    expect(dasWindow.active).toBe(false);
    c.cockpit.dispose();
  });

  it('opens for a low bandit behind the glare shield too, and closes outside the cockpit view', () => {
    const r = rig('lock');
    const c = cockpitFor(r);
    r.target().position.copy(r.at(W / 2 - 80, LIP + 40, 5000));
    c.update();
    expect(dasWindow.active).toBe(true);
    c.cockpit.visible = false;
    c.update();
    expect(dasWindow.active).toBe(false);
    c.cockpit.dispose();
  });

  it('the HMD draws the target box inside the window (before: only the off-screen cue)', () => {
    const r = rig('ag');
    const { canvas } = makeFakeCanvas(W, H, 1);
    const hud = createHud(canvas, r.mock.events);
    hud.resize(W, H, 1);
    hud.setVisible(true);
    const x = W / 2 + 30;
    const y = H - 70;
    r.target().position.copy(r.at(x, y, 6000));
    const read = () => (hud as unknown as HudTestHooks).layoutRead();
    dasWindow.active = false;
    hud.update(r.ctx);
    expect(read().designated?.rect).toBeNull();
    expect(read().das).toBeNull();
    Object.assign(dasWindow, { active: true, id: r.target().id, x, y, r: dasRadius(H) });
    hud.update(r.ctx);
    const rect = read().designated?.rect;
    expect(rect).not.toBeNull();
    expect(rect![0] + rect![2] / 2).toBeCloseTo(x, 0);
    expect(rect![1] + rect![3] / 2).toBeCloseTo(y, 0);
    expect(read().das).toEqual({ id: r.target().id, x, y, r: dasRadius(H) });
    dasWindow.active = false;
    hud.dispose();
  });

  it('a tap in the window goes to the HUD (designate), not to the PCD under it', () => {
    const r = rig('ag');
    const c = cockpitFor(r);
    r.target().position.copy(r.at(W / 2, H - 60, 6000));
    c.update();
    expect(dasWindow.active).toBe(true);
    expect(c.cockpit.handleTap(dasWindow.x / W, dasWindow.y / H)).toBe(false);
    // the PCD outside the window still takes taps
    const pr = pcdScreenRect(60, W, H);
    const py = (pr.top + Math.min(H, pr.bottom)) / 2;
    expect(c.cockpit.handleTap((pr.left + 40) / W, py / H)).toBe(true);
    c.cockpit.dispose();
  });
});

describe('EEGS gun funnel range bar (#116, suggestion 3)', () => {
  it('maps a range onto the drawn funnel points', () => {
    expect(funnelIndexAt(150, 7)).toBe(0);
    expect(funnelIndexAt(375, 7)).toBeCloseTo(1.5, 6);
    expect(funnelIndexAt(1250, 7)).toBe(6);
    expect(funnelIndexAt(100, 7)).toBe(-1);
    expect(funnelIndexAt(1300, 7)).toBe(-1);
    expect(funnelIndexAt(700, 3)).toBe(-1); // past the drawn part
  });

  for (const view of ['cockpit', 'hud'] as CameraMode[]) {
    it(`${view}: a bar across the funnel at the bandit's range inside 1,250 m, none beyond`, () => {
      const r = rig('gun', view);
      const { canvas } = makeFakeCanvas(W, H, 1);
      const hud = createHud(canvas, r.mock.events);
      hud.resize(W, H, 1);
      hud.setVisible(true);
      const read = () => (hud as unknown as HudTestHooks).layoutRead();
      const mig = r.target();
      const fwd = new Vector3(0, 0, -1).applyQuaternion(r.p.quaternion);
      const bars: number[] = [];
      for (const d of [300, 600, 1000]) {
        mig.position.copy(r.p.position).addScaledVector(fwd, d);
        hud.update(r.ctx);
        const b = read().funnelBar;
        expect(b, `${d} m`).not.toBeNull();
        expect(b!.range).toBe(d);
        bars.push(b!.len);
      }
      // the funnel narrows with range: the bar spans the wingspan at that range
      expect(bars[0]).toBeGreaterThan(bars[1]);
      expect(bars[1]).toBeGreaterThan(bars[2]);
      mig.position.copy(r.p.position).addScaledVector(fwd, 3000);
      hud.update(r.ctx);
      expect(read().funnelBar).toBeNull();
      hud.dispose();
    });
  }
});
