/**
 * HUD declutter (owner, 2026-10-06, from the clutter playtest):
 *  1. symbols win over the fixed columns: a column row with a symbol under it is dimmed, not drawn over it;
 *  2. the weapon block shows only news where the counts have another home (the SMS page in the cockpit,
 *     the buttons with touch controls): a weapon change, low or empty, a refusal, a wrong weapon. No A-A /
 *     A-G line anywhere;
 *  3. limit-only numbers: G over 6, AoA over 20°, fuel from joker; no Mach or max G; throttle only without
 *     the touch lever (or in afterburner); radar altitude below 1,500 ft or descending.
 */
import { describe, expect, it } from 'vitest';
import { PerspectiveCamera, Quaternion, Vector3 } from 'three';
import { restHead } from '../src/render/camera/cameraMath';
import type { FrameContext } from '../src/core/contracts';
import { DEFAULT_SETTINGS, JOKER_FRACTION, QUALITY_PRESETS } from '../src/core/data';
import type { CameraMode } from '../src/core/types';
import { createHud } from '../src/hud/Hud';
import { buildMock, type Scenario } from '../src/hud/dev/mockWorld';
import { installPath2D, makeFakeCanvas, type TextRec } from '../src/hud/dev/fakeCanvas';
import { COLUMN_DIM } from '../src/hud/hmd/flight';
import { AIRCRAFT_PERF } from '../src/sim/flight/aircraftData';

installPath2D();

const FT = 0.3048;

function rig(scene: Scenario, view: CameraMode, touch = false, W = 1280, H = 720) {
  const mock = buildMock(scene);
  const { canvas, ctx: fake } = makeFakeCanvas(W, H, 1);
  const hud = createHud(canvas, mock.events);
  hud.resize(W, H, 1);
  hud.setVisible(true);
  const camera = new PerspectiveCamera(60, W / H, 0.5, 60_000);
  const p = mock.player;
  const aim = () => {
    if (view === 'cockpit' || view === 'hud') {
      camera.position.set(0, 1.02, -3.52).applyQuaternion(p.quaternion).add(p.position);
      camera.quaternion.copy(p.quaternion).multiply(restHead(view, new Quaternion()));
    } else {
      camera.position.copy(p.position).add(new Vector3(0, 4.5, 20).applyQuaternion(p.quaternion));
      camera.up.set(0, 1, 0).applyQuaternion(p.quaternion);
      camera.lookAt(p.position.clone().add(new Vector3(0, 0, -40).applyQuaternion(p.quaternion)));
    }
    camera.updateMatrixWorld();
    camera.updateProjectionMatrix();
  };
  aim();
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
    touchControls: touch,
  };
  return {
    mock,
    p,
    camera,
    W,
    H,
    /** Run `seconds` of frames with `set` applied before each (the mock's tick may move things). */
    run(seconds = 0.1, set?: () => void, dt = 1 / 30): TextRec[] {
      const n = Math.max(1, Math.round(seconds / dt));
      for (let i = 0; i < n; i++) {
        fake.reset();
        ctx.time += dt;
        ctx.dt = dt;
        mock.tick(dt);
        set?.();
        aim();
        hud.update(ctx);
      }
      return fake.texts.slice();
    },
  };
}

const has = (t: TextRec[], re: RegExp) => t.some((x) => re.test(x.text));
const find = (t: TextRec[], re: RegExp) => t.find((x) => re.test(x.text));

describe('3. limit-only numbers in the speed and altitude columns', () => {
  it('cruise on a desktop: the speed box and THR; no Mach, G, max G, AoA or fuel', () => {
    const r = rig('aa', 'hud');
    const t = r.run(0.3, () => {
      r.p.flight.gLoad = 1;
      r.p.flight.alpha = 3 * (Math.PI / 180);
      r.p.flight.fuel = 0.8 * AIRCRAFT_PERF.f35a.internalFuel;
    });
    expect(has(t, /^THR \d+%$/)).toBe(true);
    for (const re of [/^M \d\.\d\d$/, /^G -?\d+\.\d$/, /^GMAX /, /^α /, /^FUEL \d/]) expect(t.filter((x) => re.test(x.text)).map((x) => x.text), String(re)).toEqual([]);
  });

  it('with the touch throttle lever showing: no THR, except the afterburner stage', () => {
    const r = rig('aa', 'hud', true);
    expect(has(r.run(0.2, () => (r.p.input.throttle = 0.5)), /^THR /)).toBe(false);
    expect(has(r.run(0.2, () => (r.p.input.throttle = 1)), /^AB( \d)?$/)).toBe(true);
  });

  it('G over 6 shows, and stays 2 s after the pull ends (no flicker at the threshold)', () => {
    const r = rig('aa', 'hud');
    expect(has(r.run(0.2, () => (r.p.flight.gLoad = 7)), /^G 7\.0$/)).toBe(true);
    expect(has(r.run(1, () => (r.p.flight.gLoad = 1)), /^G 1\.0$/)).toBe(true);
    expect(has(r.run(1.5, () => (r.p.flight.gLoad = 1)), /^G /)).toBe(false);
  });

  it('AoA over 20° shows', () => {
    const r = rig('aa', 'hud');
    expect(has(r.run(0.2, () => (r.p.flight.alpha = 24 * (Math.PI / 180))), /^α /)).toBe(true);
  });

  it('fuel shows from joker', () => {
    const r = rig('aa', 'hud');
    expect(has(r.run(0.2, () => (r.p.flight.fuel = (JOKER_FRACTION - 0.02) * AIRCRAFT_PERF.f35a.internalFuel)), /^FUEL /)).toBe(true);
  });

  it('radar altitude: below 1,500 ft, or descending under 5,000 ft; not in level flight at 3,000 ft', () => {
    const r = rig('aa', 'hud');
    const at = (aglFt: number, fpm: number) =>
      has(
        r.run(0.2, () => {
          r.p.flight.agl = aglFt * FT;
          r.p.flight.verticalSpeed = (fpm * FT) / 60;
        }),
        /^R \d+$/,
      );
    expect(at(3000, 0)).toBe(false);
    expect(at(1000, 0)).toBe(true);
    expect(at(3000, -2500)).toBe(true);
    expect(at(8000, -2500)).toBe(false);
  });
});

describe('2. the weapon block shows only news where the counts have another home', () => {
  it('HUD view on a desktop (no SMS page, no buttons): the weapon, gun rounds and flares stay; no A-A line', () => {
    const r = rig('aa', 'hud');
    const t = r.run(0.3);
    expect(has(t, /^AMRAAM \d+$/)).toBe(true);
    expect(has(t, /^GUN \d+$/)).toBe(true);
    expect(has(t, /^FL \d+$/)).toBe(true);
    expect(has(t, /^A-[AG]$|^NAV$/)).toBe(false);
  });

  for (const [view, touch] of [['cockpit', false], ['hud', true], ['chase', true]] as [CameraMode, boolean][]) {
    it(`${view}${touch ? ' with touch controls' : ''}: nothing in steady flight; the weapon for 2 s after a change; low flares`, () => {
      const r = rig('aa', view, touch);
      const steady = r.run(0.3);
      expect(has(steady, /^AMRAAM \d+$/)).toBe(false);
      expect(has(steady, /^FL \d+$/)).toBe(false);
      r.mock.events.emit('weapon:select', { ownerId: r.p.id, weapon: 'aim120' });
      expect(has(r.run(1), /^AMRAAM \d+$/)).toBe(true);
      expect(has(r.run(1.5), /^AMRAAM \d+$/)).toBe(false);
      // (the chase view's compact block never had a flares row: FLARES LOW is the warning band's chip)
      if (view !== 'chase') expect(has(r.run(0.2, () => (r.p.flares = 3)), /^FL 3$/)).toBe(true);
    });
  }

  it('cockpit: the last store shows, amber', () => {
    const r = rig('aa', 'cockpit');
    const t = r.run(0.3, () => {
      for (const s of r.p.stores) if (s.weapon === 'aim120') s.count = 0;
      const st = r.p.stores.find((s) => s.weapon === 'aim120');
      if (st) st.count = 1;
    });
    expect(find(t, /^AMRAAM 1$/)).toBeTruthy();
  });
});

describe('1. symbols win over the fixed columns', () => {
  it('a designated target under the THR row dims the row; clear of it, the row is at full strength', () => {
    const r = rig('aa', 'hud');
    const thr = find(r.run(0.2), /^THR \d+%$/)!;
    expect(thr.alpha).toBe(1);
    const t = r.mock.world.getEntity(r.p.radar.designatedId!)!;
    const put = () => {
      const ndc = new Vector3((thr.x - 25) / r.W * 2 - 1, -((thr.y / r.H) * 2 - 1), 0.5).unproject(r.camera);
      t.position.copy(r.camera.position).addScaledVector(ndc.sub(r.camera.position).normalize(), 9000);
      const c = r.p.radar.contacts.find((x) => x.id === t.id);
      if (c) c.position.copy(t.position);
    };
    const dim = find(r.run(0.2, put), /^THR \d+%$/)!;
    expect(dim.alpha).toBeCloseTo(COLUMN_DIM, 2);
  });
});
