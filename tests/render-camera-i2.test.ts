/**
 * Regression tests for the i2 render review (scratchpad i2-render.md):
 *  - missile cam rode the NEWEST missile of an AIM-120 pair, so the first missile's kill happened
 *    off camera (a speck under the objectives text);
 *  - padlock view put the jet low-left, under the throttle cluster / AMRAAM button / radio subtitles.
 */
import { describe, expect, it } from 'vitest';
import { PerspectiveCamera, Quaternion, Vector3 } from 'three';
import { EventBus } from '../src/core/events';
import { DEFAULT_SETTINGS, QUALITY_PRESETS } from '../src/core/data';
import type { FrameContext } from '../src/core/contracts';
import { createCameraRig } from '../src/render/CameraRig';
import {
  NOT_GUIDING,
  PADLOCK,
  aimAtNdc,
  missileTimeToGo,
  padlockPose,
  pickFollowMissile,
  type FollowMissile,
  type FollowTarget,
} from '../src/render/camera/cameraMath';
import { computeTouchLayout, type Rect } from '../src/input/touch/layout';
import { impactPose, sideOf } from '../src/render/camera/cameraMath';

/* ───────────── helpers ───────────── */

function project(pos: Vector3, q: Quaternion, pt: Vector3, fov: number, aspect: number): Vector3 {
  const cam = new PerspectiveCamera(fov, aspect, 0.5, 1e6);
  cam.position.copy(pos);
  cam.quaternion.copy(q);
  cam.updateMatrixWorld();
  return pt.clone().project(cam);
}

const mk = (id: number, o: Partial<FollowMissile> & { position: Vector3 }): FollowMissile => ({
  id,
  alive: true,
  shooterId: 1,
  targetId: null,
  age: 0,
  decoyed: false,
  phase: 'midcourse',
  velocity: new Vector3(0, 0, -900),
  ...o,
});

/* ───────────── missile selection ───────────── */

describe('missile cam picks the missile most likely to hit (i2: rode the newest of a pair)', () => {
  const mig: FollowTarget = { alive: true, position: new Vector3(0, 4500, -10_000), velocity: new Vector3(0, 0, 250) };
  const targets = new Map<number, FollowTarget>([[50, mig]]);
  const get = (id: number | null) => (id == null ? null : (targets.get(id) ?? null));

  it('time to go = range / closing speed', () => {
    const m = mk(1, { position: new Vector3(0, 4500, -9000), velocity: new Vector3(0, 0, -750) });
    // 1000 m at 1000 m/s closing
    expect(missileTimeToGo(m, mig)).toBeCloseTo(1, 5);
  });

  it('reviewer case: AIM-120 pair on the MiG-29 — follows the first (closest to impact), not the newest', () => {
    const first = mk(11, { targetId: 50, age: 14, position: new Vector3(0, 4500, -9760) }); // 240 m out
    const second = mk(12, { targetId: 50, age: 10, position: new Vector3(0, 4500, -6500) }); // launched later
    const r = pickFollowMissile([first, second], 1, 50, get);
    expect(r.id).toBe(11);
    expect(r.score).toBeLessThan(NOT_GUIDING);
    // order in the array must not matter
    expect(pickFollowMissile([second, first], 1, 50, get).id).toBe(11);
  });

  it('prefers a missile guiding on a live target over a ballistic / decoyed / orphaned one', () => {
    const orphan = mk(21, { targetId: 99, age: 20, position: new Vector3(0, 4500, -9990) }); // target gone
    const decoyed = mk(22, { targetId: 50, age: 20, decoyed: true, position: new Vector3(0, 4500, -9900) });
    const ballistic = mk(23, { targetId: 50, age: 20, phase: 'ballistic', position: new Vector3(0, 4500, -9900) });
    const guiding = mk(24, { targetId: 50, age: 3, position: new Vector3(0, 4500, -2000) });
    expect(pickFollowMissile([orphan, decoyed, ballistic, guiding], 1, 50, get).id).toBe(24);
  });

  it('prefers the locked/primary target when times to go are close', () => {
    const other: FollowTarget = { alive: true, position: new Vector3(2000, 4500, -10_000), velocity: new Vector3(0, 0, 250) };
    targets.set(60, other);
    const onPrimary = mk(31, { targetId: 50, position: new Vector3(0, 4500, -5000) }); // ~4.3 s
    const onOther = mk(32, { targetId: 60, position: new Vector3(2000, 4500, -6000) }); // ~3.5 s
    expect(pickFollowMissile([onPrimary, onOther], 1, 50, get).id).toBe(31);
    expect(pickFollowMissile([onPrimary, onOther], 1, null, get).id).toBe(32);
    targets.delete(60);
  });

  it('falls back to the oldest missile when none is guiding; ignores other shooters and dead missiles', () => {
    const a = mk(41, { age: 3, position: new Vector3() });
    const b = mk(42, { age: 9, position: new Vector3() });
    const enemy = mk(43, { shooterId: 7, targetId: 50, position: new Vector3(0, 4500, -9990) });
    const dead = mk(44, { alive: false, targetId: 50, position: new Vector3(0, 4500, -9990) });
    const r = pickFollowMissile([a, b, enemy, dead], 1, 50, get);
    expect(r.id).toBe(42);
    expect(r.score).toBeGreaterThanOrEqual(NOT_GUIDING);
    expect(pickFollowMissile([enemy, dead], 1, 50, get).id).toBe(-1);
  });
});

/* ───────────── rig-level missile cam (fake world, real CameraRig + EventBus) ───────────── */

function makeWorld() {
  const events = new EventBus();
  const player = {
    id: 1,
    kind: 'aircraft',
    type: 'f35a',
    alive: true,
    position: new Vector3(0, 4500, 0),
    velocity: new Vector3(0, 0, -250),
    quaternion: new Quaternion(),
    radar: { lockedId: 50 as number | null, designatedId: null as number | null },
    flight: { afterburner: 0, mach: 0.8, gLoad: 1, alpha: 0.05, stalled: false },
  };
  const ents = new Map<number, any>();
  const missiles: any[] = [];
  const world: any = {
    events,
    player,
    missiles,
    aircraft: [player],
    terrain: { surfaceHeightAt: () => 0 },
    getEntity: (id: number | null | undefined) => (id == null ? null : (ents.get(id) ?? null)),
  };
  ents.set(1, player);
  const addTarget = (id: number, pos: Vector3) => {
    const t = { id, kind: 'aircraft', alive: true, position: pos, velocity: new Vector3(0, 0, 250), quaternion: new Quaternion() };
    ents.set(id, t);
    return t;
  };
  const addMissile = (id: number, targetId: number, pos: Vector3, age: number) => {
    const m = {
      id,
      kind: 'missile',
      alive: true,
      shooterId: 1,
      targetId,
      age,
      decoyed: false,
      phase: 'midcourse',
      position: pos,
      velocity: new Vector3(0, 0, -900),
      quaternion: new Quaternion(), // nose along -Z
      def: { length: 3.65 },
    };
    ents.set(id, m);
    missiles.push(m);
    return m;
  };
  const entities: any = { getEyeOffset: () => new Vector3(0, 1, -5) };
  const rig = createCameraRig(world, entities, { ...DEFAULT_SETTINGS });
  rig.resize(844, 390);
  const ctx = {
    dt: 1 / 60,
    time: 0,
    world,
    player,
    camera: rig.camera,
    viewMode: 'chase',
    focusId: null,
    mission: null,
    settings: { ...DEFAULT_SETTINGS },
    quality: QUALITY_PRESETS.medium,
    paused: false,
  } as unknown as FrameContext;
  const step = (sec: number) => {
    for (let t = 0; t < sec; t += 1 / 60) rig.update(ctx);
  };
  const end = (m: any, reason: 'hit' | 'proximity' | 'selfdestruct' | 'decoyed') => {
    m.alive = false;
    events.emit('munition:end', { missile: m, position: m.position.clone(), reason, targetId: m.targetId } as any);
  };
  /** Is the world point near the centre of the current view? */
  const centred = (pt: Vector3, tol = 0.25) => {
    rig.camera.updateMatrixWorld();
    const p = pt.clone().project(rig.camera);
    return p.z < 1 && Math.abs(p.x) < tol && Math.abs(p.y) < tol;
  };
  return { world, player, rig, addTarget, addMissile, step, end, centred, ents };
}

describe('missile cam rig behaviour (i2: salvo kill happened off camera)', () => {
  it('entering missile view rides the pair missile closest to impact and holds on its kill', () => {
    const w = makeWorld();
    const mig = w.addTarget(50, new Vector3(0, 4500, -10_000));
    w.addMissile(11, 50, new Vector3(0, 4500, -9760), 14); // first of the pair, 240 m out
    w.addMissile(12, 50, new Vector3(0, 4500, -6500), 10); // newest
    w.rig.setMode('missile');
    expect(w.rig.mode).toBe('missile');
    expect(w.rig.focusId).toBe(11);
    w.step(0.2);
    // the kill: hold on the impact, fireball centred in frame
    w.end(w.ents.get(11), 'hit');
    mig.alive = false;
    w.step(0.5);
    expect(w.rig.mode).toBe('missile');
    expect(w.centred(new Vector3(0, 4500, -9760))).toBe(true);
    // the second missile has nothing left to guide on: back to the previous view after the linger
    w.step(3.2);
    expect(w.rig.mode).toBe('chase');
  });

  it('cuts to another salvo missile\'s kill when the ridden one is still > 2 s out, then resumes it', () => {
    const w = makeWorld();
    w.addTarget(50, new Vector3(0, 4500, -10_000)); // locked MiG (primary)
    const t2 = w.addTarget(60, new Vector3(3000, 4500, -9000));
    const a = w.addMissile(21, 50, new Vector3(0, 4500, -4500), 8); // ~4.8 s (-1.5 primary bonus)
    const b = w.addMissile(22, 60, new Vector3(3000, 4500, -4800), 8); // ~3.7 s
    w.rig.setMode('missile');
    expect(w.rig.focusId).toBe(21);
    w.step(0.2);
    // missile b kills the second MiG while a still has ~5 s to go
    b.position.set(3000, 4500, -9000);
    w.end(b, 'hit');
    t2.alive = false;
    w.step(0.5);
    expect(w.rig.focusId).toBe(22);
    expect(w.centred(new Vector3(3000, 4500, -9000))).toBe(true);
    // after the linger the camera rides the missile still guiding (the salvo stays on screen)
    w.step(3.2);
    expect(w.rig.mode).toBe('missile');
    expect(w.rig.focusId).toBe(21);
    w.step(0.1);
    rigAhead(w.rig.camera, a.position);
  });

  it('does not cut away when the ridden missile is about to hit (TTI ≤ 2 s)', () => {
    const w = makeWorld();
    w.addTarget(50, new Vector3(0, 4500, -10_000));
    w.addTarget(60, new Vector3(3000, 4500, -9000));
    w.addMissile(31, 50, new Vector3(0, 4500, -8800), 8); // ~1 s
    const b = w.addMissile(32, 60, new Vector3(3000, 4500, -8900), 8);
    w.rig.setMode('missile');
    expect(w.rig.focusId).toBe(31);
    w.step(0.1);
    w.end(b, 'hit');
    w.step(0.1);
    expect(w.rig.focusId).toBe(31);
  });

  it('switches mid-flight when the ridden missile is decoyed and another is still guiding', () => {
    const w = makeWorld();
    w.addTarget(50, new Vector3(0, 4500, -10_000));
    const a = w.addMissile(51, 50, new Vector3(0, 4500, -8000), 10);
    w.addMissile(52, 50, new Vector3(0, 4500, -5000), 6);
    w.rig.setMode('missile');
    expect(w.rig.focusId).toBe(51);
    a.decoyed = true; // chasing a flare
    w.step(0.1);
    expect(w.rig.focusId).toBe(52);
    expect(w.rig.mode).toBe('missile');
  });

  it('missile view is unavailable without a live player missile; cycling skips it', () => {
    const w = makeWorld();
    w.rig.setMode('missile');
    expect(w.rig.mode).toBe('chase');
    w.addTarget(50, new Vector3(0, 4500, -10_000));
    w.addMissile(61, 50, new Vector3(0, 4500, -8000), 10);
    w.rig.setMode('missile');
    expect(w.rig.mode).toBe('missile');
    expect(w.rig.focusId).toBe(61);
  });

  it('when the ridden missile misses, it rides the next guiding one of the salvo', () => {
    const w = makeWorld();
    w.addTarget(50, new Vector3(0, 4500, -10_000));
    const a = w.addMissile(41, 50, new Vector3(0, 4500, -9000), 10);
    w.addMissile(42, 50, new Vector3(0, 4500, -6000), 6);
    w.rig.setMode('missile');
    expect(w.rig.focusId).toBe(41);
    w.step(0.1);
    w.end(a, 'decoyed');
    w.step(0.1);
    expect(w.rig.mode).toBe('missile');
    expect(w.rig.focusId).toBe(42);
  });
});

function rigAhead(cam: PerspectiveCamera, pt: Vector3): void {
  cam.updateMatrixWorld();
  const p = pt.clone().project(cam);
  expect(p.z).toBeLessThan(1);
  expect(Math.abs(p.x)).toBeLessThan(1);
  expect(Math.abs(p.y)).toBeLessThan(1);
}

/* ───────────── padlock composition vs the touch zones ───────────── */

describe('aimAtNdc pins a direction at an NDC spot without roll', () => {
  it('projects exactly and keeps the horizon level', () => {
    const q = new Quaternion();
    const right = new Vector3();
    // (a roll-free camera cannot put a near-vertical direction far off-centre: stay within ±55°)
    const dirs = [new Vector3(0, 0, -1), new Vector3(1, -0.3, 0.2), new Vector3(-0.4, 0.6, -0.3), new Vector3(0.5, -0.9, 0.4)];
    for (const d of dirs) {
      for (const [nx, ny] of [[-0.1, -0.18], [0.5, 0.4], [0, 0]]) {
        aimAtNdc(d, nx, ny, 60, 844 / 390, q);
        const p = project(new Vector3(), q, d.clone().normalize().multiplyScalar(50), 60, 844 / 390);
        expect(p.x).toBeCloseTo(nx, 4);
        expect(p.y).toBeCloseTo(ny, 4);
        right.set(1, 0, 0).applyQuaternion(q);
        expect(Math.abs(right.y)).toBeLessThan(1e-6);
      }
    }
  });
});

describe('padlock view keeps the jet clear of the touch controls and radio band (i2 review)', () => {
  const screens: [string, number, number][] = [
    ['844x390', 844, 390],
    ['667x375', 667, 375],
    ['desktop 1280x720', 1280, 720],
  ];
  const los: [string, Vector3][] = [
    ['far ahead', new Vector3(300, 4800, -9000)],
    ['beam', new Vector3(9000, 4500, -500)],
    ['below', new Vector3(1000, 1500, -6000)],
    ['high', new Vector3(0, 8000, -4000)],
    ['close', new Vector3(80, 4530, -300)],
  ];
  const JET_R = 8; // bounding sphere of the F-35 (15.7 m long) — any attitude
  const hit = (cx: number, cy: number, r: number, rc: Rect) => {
    const nx = Math.max(rc.x, Math.min(cx, rc.x + rc.w));
    const ny = Math.max(rc.y, Math.min(cy, rc.y + rc.h));
    return Math.hypot(cx - nx, cy - ny) < r;
  };
  for (const [sname, W, H] of screens) {
    for (const fov of [60, 75]) {
      for (const [lname, tgt] of los) {
        it(`${sname}, fov ${fov}, ${lname}`, () => {
          const aspect = W / H;
          const jet = new Vector3(0, 4500, 0);
          const dir = tgt.clone().sub(jet).normalize();
          const pos = new Vector3();
          const q = new Quaternion();
          padlockPose(jet, dir, 19, fov, aspect, pos, q);
          const pj = project(pos, q, jet, fov, aspect);
          const pt = project(pos, q, tgt, fov, aspect);
          // jet pinned at ≈45 % x / 59 % y
          const jx = ((pj.x + 1) / 2) * W;
          const jy = ((1 - pj.y) / 2) * H;
          expect(jx / W).toBeCloseTo(0.45, 2);
          expect(jy / H).toBeCloseTo(0.59, 2);
          // on-screen radius of the jet's bounding sphere
          const dist = pos.distanceTo(jet);
          const rPx = (Math.atan(JET_R / dist) / Math.atan(Math.tan(((fov * Math.PI) / 180) / 2))) * (H / 2);
          const L = computeTouchLayout(W, H, { top: 0, right: 0, bottom: 0, left: 0 }, { leftHanded: false });
          const zones: Rect[] = [L.throttle, L.buttons.fire, L.buttons.gun, L.buttons.cms, L.stickZone, L.buttons.cam, L.buttons.tgt, L.buttons.wpn, L.buttons.radar];
          // radio subtitles: two lines at the bottom centre (≈ 60 px × scale)
          zones.push({ x: 0, y: H - 60 * L.s, w: W, h: 60 * L.s });
          // objectives / hint panel column at the top-left (≈ 28 % of the width)
          zones.push({ x: 0, y: 0, w: W * 0.28, h: H });
          for (const z of zones) expect(hit(jx, jy, rPx, z), `jet overlaps ${JSON.stringify(z)}`).toBe(false);
          // target: in front, on screen, up and right of the jet
          expect(pt.z).toBeLessThan(1);
          expect(Math.abs(pt.x)).toBeLessThan(0.95);
          expect(Math.abs(pt.y)).toBeLessThan(0.95);
          expect(pt.x).toBeGreaterThan(pj.x);
          expect(pt.y).toBeGreaterThan(pj.y);
          if (lname !== 'close') {
            // far target in the upper-right third
            expect(pt.x).toBeGreaterThan(1 / 3);
            expect(pt.y).toBeGreaterThan(1 / 3);
          }
        });
      }
    }
  }

  it('constants: jet left of centre, just below the middle; target upper-right third', () => {
    expect(PADLOCK.jetX).toBeLessThan(0);
    expect(PADLOCK.jetY).toBeLessThan(0);
    expect(PADLOCK.jetY).toBeGreaterThan(-0.3);
    expect(PADLOCK.tgtX).toBeGreaterThan(1 / 3);
    expect(PADLOCK.tgtY).toBeGreaterThan(1 / 3);
  });
});

/* ───────────── impact linger vs the wreck's path ───────────── */

describe('impact linger keeps the lens out of the wreck / fireball path (i2 browser check)', () => {
  const impact = new Vector3(0, 4500, -9760);
  const cases: [string, Vector3, Vector3][] = [
    ['head-on', new Vector3(0, 0, -1), new Vector3(0, 0, 250)],
    ['tail chase', new Vector3(0, 0, -1), new Vector3(0, 0, -250)],
    ['beam', new Vector3(0, 0, -1), new Vector3(250, -20, 0)],
    ['diving target', new Vector3(0, 0, -1), new Vector3(0, -200, 150)],
    ['no target (miss)', new Vector3(0.3, -0.2, -0.93).normalize(), new Vector3()],
  ];
  for (const [name, fwd, vel] of cases) {
    it(name, () => {
      const side = sideOf(fwd, new Vector3(1, 0, 0), new Vector3());
      const cam = impactPose(impact, fwd, side, new Vector3(), vel.lengthSq() > 0 ? vel : null);
      expect(cam.distanceTo(impact)).toBeGreaterThan(180);
      expect(cam.y).toBeGreaterThan(impact.y);
      // the wreck (straight line at its velocity for 3 s) never comes within 150 m of the lens
      for (let t = 0; t <= 3; t += 0.05) {
        const w = impact.clone().addScaledVector(vel, t);
        expect(w.distanceTo(cam)).toBeGreaterThan(150);
      }
      // and it moves away from (not toward) the lens
      if (vel.lengthSq() > 0) expect(impact.clone().sub(cam).dot(vel)).toBeGreaterThan(0);
    });
  }
});
