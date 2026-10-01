/**
 * Civil ships 2/4 (issue #29): target-camera framing, the living ship (swell, anchor swing, night
 * lights) and the sinking sequence. All pure maths / scene-graph checks: no WebGL.
 */
import { describe, expect, it } from 'vitest';
import { Matrix4, PerspectiveCamera, Quaternion, Vector3 } from 'three';
import { GroundTargetEntity } from '../src/sim/entities';
import type { VesselClass } from '../src/core/types';
import { ANCHOR_SWING, SHIP_DIMS, shipDims, shipMatrix, shipSeed, sinkDuration, sinkPose, type SinkPose } from '../src/render/visuals/shipMotion';
import { SHIP_FRAMING, TARGET_CAM_FOV, framingDistance, makePose, shipLookY, targetCamPose } from '../src/render/targetCam/pose';
import { PIP_DESTROYED_HOLD, PIP_SHIP_HOLD, pipHold, pipName, pipView, resetPip, stepPip } from '../src/hud/hmd/pip';
import { getGroundPrototype } from '../src/render/models/ground';
import { GroundVisual } from '../src/render/visuals/SiteVisuals';
import { PIP_ASPECT, computeLayout, makeLayout } from '../src/hud/hmd/layout';

const DEG = Math.PI / 180;

function ship(vessel: VesselClass | null, id = 11, opts: { anchored?: boolean; heading?: number } = {}): GroundTargetEntity {
  const e = new GroundTargetEntity(id, 'ship', vessel ? 'neutral' : 'red', { name: vessel === 'cruise' ? 'Southern Barnacle' : 'MV Kōtuku Trader', radius: vessel ? SHIP_DIMS[vessel].length / 2 : 60 });
  e.vessel = vessel;
  e.anchored = !!opts.anchored;
  e.position.set(3000, 0, -13000);
  e.quaternion.setFromAxisAngle(new Vector3(0, 1, 0), -(opts.heading ?? 0) * DEG);
  return e;
}

/** World-space corners of a ship's bounding box (waterline to the top, bow to stern). */
function hullCorners(g: GroundTargetEntity, time: number): Vector3[] {
  const d = shipDims(g.vessel);
  const m = new Matrix4();
  shipMatrix(g, time, m);
  const out: Vector3[] = [];
  for (const x of [-d.beam / 2, d.beam / 2]) for (const y of [-2, d.height]) for (const z of [-d.length / 2, d.length / 2]) out.push(new Vector3(x, y, z).applyMatrix4(m));
  return out;
}

function upOf(m: Matrix4): Vector3 {
  return new Vector3(0, 1, 0).applyQuaternion(new Quaternion().setFromRotationMatrix(m));
}

describe('ship motion: swell and anchor swing', () => {
  it('rides a gentle swell: a few tenths of a degree, a little heave, never still', () => {
    const g = ship('container');
    const m = new Matrix4();
    let maxTilt = 0;
    let minTilt = 1;
    let maxHeave = 0;
    for (let t = 0; t < 60; t += 0.25) {
      shipMatrix(g, t, m);
      const tilt = Math.acos(Math.min(1, upOf(m).y));
      maxTilt = Math.max(maxTilt, tilt);
      minTilt = Math.min(minTilt, tilt);
      maxHeave = Math.max(maxHeave, Math.abs(new Vector3().setFromMatrixPosition(m).y));
    }
    expect(maxTilt).toBeGreaterThan(0.2 * DEG);
    expect(maxTilt).toBeLessThan(1 * DEG);
    expect(maxHeave).toBeGreaterThan(0.1);
    expect(maxHeave).toBeLessThan(0.5);
  });

  it('a ship at anchor swings slowly about its bow (the bow stays put), a moored one does not swing', () => {
    const d = SHIP_DIMS.cruise;
    const g = ship('cruise', 5, { anchored: true, heading: 215 });
    const bow0 = new Vector3(0, 0, -d.length / 2).applyQuaternion(g.quaternion).add(g.position);
    const fwd0 = new Vector3(0, 0, -1).applyQuaternion(g.quaternion);
    const m = new Matrix4();
    let maxYaw = 0;
    for (let t = 0; t < 600; t += 5) {
      shipMatrix(g, t, m);
      const bow = new Vector3(0, 0, -d.length / 2).applyMatrix4(m);
      expect(Math.hypot(bow.x - bow0.x, bow.z - bow0.z)).toBeLessThan(1.5); // swell only
      const fwd = new Vector3(0, 0, -1).applyQuaternion(new Quaternion().setFromRotationMatrix(m)).setY(0).normalize();
      maxYaw = Math.max(maxYaw, Math.acos(Math.min(1, fwd.dot(fwd0))));
    }
    expect(maxYaw).toBeGreaterThan(1.5 * DEG);
    expect(maxYaw).toBeLessThanOrEqual(ANCHOR_SWING + 0.5 * DEG);
    // the swing is slow: < 0.25°/s
    const a = new Matrix4();
    const b = new Matrix4();
    shipMatrix(g, 100, a);
    shipMatrix(g, 101, b);
    const fa = new Vector3(0, 0, -1).applyQuaternion(new Quaternion().setFromRotationMatrix(a)).setY(0).normalize();
    const fb = new Vector3(0, 0, -1).applyQuaternion(new Quaternion().setFromRotationMatrix(b)).setY(0).normalize();
    expect(Math.acos(Math.min(1, fa.dot(fb)))).toBeLessThan(0.25 * DEG);
    // moored alongside: no swing, the hull centre stays on the entity
    const moored = ship('cruise', 5);
    for (let t = 0; t < 300; t += 10) {
      shipMatrix(moored, t, m);
      const c = new Vector3().setFromMatrixPosition(m);
      expect(Math.hypot(c.x - moored.position.x, c.z - moored.position.z)).toBeLessThan(0.01);
    }
  });

  it('seeds are stable per ship and spread out', () => {
    expect(shipSeed(7)).toBe(shipSeed(7));
    const seeds = Array.from({ length: 200 }, (_, i) => shipSeed(i + 1));
    for (const s of seeds) expect(s >= 0 && s < 1).toBe(true);
    expect(seeds.filter((s) => s < 0.5).length).toBeGreaterThan(70);
    expect(seeds.filter((s) => s < 0.5).length).toBeLessThan(130);
  });
});

describe('ship sinking sequence', () => {
  const pose = (): SinkPose => ({ dy: 0, pitch: 0, roll: 0, progress: 0, duration: 0 });

  it('takes 60–90 s, settles, lists to one side and trims by the bow or the stern', () => {
    for (let id = 1; id <= 40; id++) {
      const seed = shipSeed(id);
      const dur = sinkDuration(seed);
      expect(dur).toBeGreaterThanOrEqual(60);
      expect(dur).toBeLessThanOrEqual(90);
      const p0 = sinkPose(0, seed, SHIP_DIMS.container, pose());
      expect(p0.dy).toBeCloseTo(0, 9);
      expect(p0.roll).toBeCloseTo(0, 9);
      expect(p0.pitch).toBeCloseTo(0, 6);
      let prev = pose();
      for (let t = 0; t <= dur + 5; t += 0.5) {
        const p = sinkPose(t, seed, SHIP_DIMS.container, pose());
        expect(p.dy).toBeLessThanOrEqual(prev.dy + 1e-9); // only ever goes down
        expect(Math.abs(p.roll)).toBeGreaterThanOrEqual(Math.abs(prev.roll) - 1e-9); // the list only grows
        expect(Math.abs(p.roll)).toBeLessThan(32 * DEG);
        expect(Math.abs(p.pitch)).toBeLessThan(10 * DEG);
        prev = p;
      }
      // a visible list and trim by half time
      const half = sinkPose(dur / 2, seed, SHIP_DIMS.container, pose());
      expect(Math.abs(half.roll)).toBeGreaterThan(8 * DEG);
      expect(Math.abs(half.pitch)).toBeGreaterThan(1.5 * DEG);
    }
    // both sides and both ends happen across ships
    const rolls = new Set<number>();
    const trims = new Set<number>();
    for (let id = 1; id <= 40; id++) {
      const p = sinkPose(50, shipSeed(id), SHIP_DIMS.cruise, pose());
      rolls.add(Math.sign(p.roll));
      trims.add(Math.sign(p.pitch));
    }
    expect(rolls.size).toBe(2);
    expect(trims.size).toBe(2);
  });

  it('the whole hull is under water after the sinking time, and still partly afloat at a third of it', () => {
    for (const vessel of ['container', 'cruise', null] as const) {
      for (let id = 1; id <= 12; id++) {
        const g = ship(vessel, id, { anchored: id % 2 === 0, heading: id * 37 });
        g.alive = false;
        g.destroyedAt = 100;
        const dur = sinkDuration(shipSeed(id));
        const early = hullCorners(g, 100 + dur / 3);
        expect(Math.max(...early.map((c) => c.y))).toBeGreaterThan(5);
        const end = hullCorners(g, 100 + dur + 1e-6);
        expect(Math.max(...end.map((c) => c.y))).toBeLessThan(0);
        const m = new Matrix4();
        expect(shipMatrix(g, 100 + dur + 1e-6, m).progress).toBe(1);
        expect(shipMatrix(g, 100 + dur * 0.5, m).progress).toBeCloseTo(0.5, 5);
      }
    }
  });

  it('starts from the pose the ship had when hit (no jump at the kill)', () => {
    const g = ship('container', 9, { anchored: true, heading: 200 });
    const a = new Matrix4();
    const b = new Matrix4();
    shipMatrix(g, 250, a);
    g.alive = false;
    g.destroyedAt = 250;
    shipMatrix(g, 250, b);
    const pa = new Vector3().setFromMatrixPosition(a);
    const pb = new Vector3().setFromMatrixPosition(b);
    expect(pa.distanceTo(pb)).toBeLessThan(0.01);
    expect(upOf(a).angleTo(upOf(b))).toBeLessThan(1e-4);
  });
});

describe('ship visual', () => {
  it('sinks, keeps its colours, stops its radar and hides once fully under', () => {
    const g = ship('cruise', 21);
    const v = new GroundVisual(getGroundPrototype('ship', 'green', 'cruise'));
    const cam = new Vector3(3000, 200, -12000);
    expect(v.update(g, 10, 1 / 60, cam, 9000)).toBe(true);
    const radar = v.root.getObjectByName('spin:0')!;
    const mats = new Map<unknown, unknown>();
    v.root.traverse((o) => mats.set(o, (o as { material?: unknown }).material));
    g.alive = false;
    g.destroyedAt = 10;
    const rot = radar.rotation.y;
    expect(v.update(g, 30, 1 / 60, cam, 9000)).toBe(true);
    expect(radar.rotation.y).toBe(rot);
    expect(v.root.position.y).toBeLessThan(-0.5);
    v.root.traverse((o) => expect((o as { material?: unknown }).material).toBe(mats.get(o)));
    expect(v.update(g, 10 + 95, 1 / 60, cam, 9000)).toBe(false);
    expect(v.root.visible).toBe(false);
  });

  it('the corvette sinks the same way (no more 3.5 m sink)', () => {
    const g = ship(null, 4);
    const v = new GroundVisual(getGroundPrototype('ship', 'green', null));
    const cam = new Vector3(3000, 200, -12000);
    g.alive = false;
    g.destroyedAt = 0;
    v.update(g, 40, 1 / 60, cam, 9000);
    expect(v.root.position.y).toBeLessThan(-5);
    v.update(g, 95, 1 / 60, cam, 9000);
    expect(v.root.visible).toBe(false);
  });

  it('carries COLREGS night lights: red to port, green to starboard, white masthead / stern / anchor lights, cabin lights', () => {
    for (const vessel of ['container', 'cruise'] as const) {
      const p = getGroundPrototype('ship', 'green', vessel);
      const red = p.lights.filter((l) => l.color === 0xff2a1a);
      const green = p.lights.filter((l) => l.color === 0x2aff5a);
      expect(red.length).toBe(1);
      expect(green.length).toBe(1);
      // bow at -Z: port is -X, starboard +X
      expect(red[0].pos.x).toBeLessThan(0);
      expect(green[0].pos.x).toBeGreaterThan(0);
      expect(p.lights.filter((l) => l.kind === 'anchor').length).toBe(2);
      expect(p.lights.filter((l) => l.kind === 'stern').length).toBe(1);
      const deck = p.lights.filter((l) => l.kind === 'deck').length;
      expect(deck).toBeGreaterThan(vessel === 'cruise' ? 60 : 15);
      expect(p.lights.length).toBeLessThan(160);
    }
    expect(getGroundPrototype('ship', 'green', null).lights.length).toBe(0); // the warship runs dark
  });

  it('lights by state: under way, at anchor, moored (deck lights only); none when sunk', () => {
    const cam = new Vector3(3000, 200, -12000);
    const proto = getGroundPrototype('ship', 'green', 'container');
    const moving = ship('container', 1);
    moving.velocity.set(0, 0, -5);
    const anchored = ship('container', 2, { anchored: true });
    const moored = ship('container', 3);
    const modes = [moving, anchored, moored].map((g) => {
      const v = new GroundVisual(proto);
      v.update(g, 5, 1 / 60, cam, 9000);
      return v.lightMode;
    });
    expect(modes).toEqual([1, 2, 4]);
    const v = new GroundVisual(proto);
    moored.alive = false;
    moored.destroyedAt = 0;
    v.update(moored, 5, 1 / 60, cam, 9000);
    expect(v.lightMode).toBe(0);
  });

  it('the funnel the effects smoke from is where the model puts it', () => {
    for (const vessel of ['container', 'cruise'] as const) {
      const [, top, z] = SHIP_DIMS[vessel].funnel!;
      // the black funnel cap sits just above SHIP_DIMS' funnel top
      const body = getGroundPrototype('ship', 'green', vessel).root.getObjectByName('static') as unknown as { geometry: { attributes: { position: { count: number; getX(i: number): number; getY(i: number): number; getZ(i: number): number } } } };
      const pos = body.geometry.attributes.position;
      let found = false;
      for (let i = 0; i < pos.count && !found; i++) {
        if (Math.abs(pos.getY(i) - (top + 1.4)) < 0.05 && Math.abs(pos.getZ(i) - z) < 8 && Math.abs(pos.getX(i)) < 5) found = true;
      }
      expect(found).toBe(true);
    }
  });
});

describe('target camera: ship framing', () => {
  it('orbits at 1.6–2× the hull length, looking at mid-superstructure (above the old 12 m clamp)', () => {
    for (const vessel of ['container', 'cruise'] as const) {
      const g = ship(vessel);
      const L = SHIP_DIMS[vessel].length;
      const d = framingDistance(g);
      expect(d / L).toBeGreaterThanOrEqual(1.6);
      expect(d / L).toBeLessThanOrEqual(2);
      const look = shipLookY(g);
      expect(look).toBeGreaterThan(12);
      expect(look).toBeGreaterThan(SHIP_DIMS[vessel].deck);
      expect(look).toBeLessThan(SHIP_DIMS[vessel].height);
      for (let t = 0; t < 300; t += 3.7) {
        const p = targetCamPose(g, t, makePose());
        expect(p.look.y).toBeCloseTo(g.position.y + look, 6);
        const off = p.position.clone().sub(p.look);
        expect(off.length()).toBeCloseTo(d, 3);
        const el = Math.asin(off.y / off.length());
        expect(el).toBeGreaterThanOrEqual(SHIP_FRAMING.elMin - 1e-6);
        expect(el).toBeLessThanOrEqual(SHIP_FRAMING.elMax + 1e-6);
      }
    }
  });

  it('keeps the whole hull in the window from every side of the orbit', () => {
    const cam = new PerspectiveCamera(TARGET_CAM_FOV, PIP_ASPECT, 0.5, 20000);
    for (const vessel of ['container', 'cruise'] as const) {
      const g = ship(vessel, 3, { heading: 30 });
      for (let t = 0; t < 150; t += 5) {
        const p = targetCamPose(g, t, makePose());
        cam.position.copy(p.position);
        cam.up.copy(p.up);
        cam.lookAt(p.look);
        cam.updateMatrixWorld();
        for (const c of hullCorners(g, t)) {
          const ndc = c.clone().project(cam);
          expect(Math.abs(ndc.x)).toBeLessThan(0.98);
          expect(Math.abs(ndc.y)).toBeLessThan(0.98);
        }
      }
    }
  });

  it('orbits slowly (≥ 2 min a lap) and keeps over open water when land blocks part of the circle', () => {
    const g = ship('cruise', 8);
    const a = targetCamPose(g, 10, makePose()).position.clone();
    const b = targetCamPose(g, 11, makePose()).position.clone();
    const d = framingDistance(g);
    expect(a.distanceTo(b) / d).toBeLessThan((2 * Math.PI) / 120);
    // moored at a wharf: everything south of the ship (+Z) and east is land
    const land = (x: number, z: number) => z > g.position.z + 50 || x > g.position.x + 200;
    const water = (x: number, z: number) => !land(x, z);
    let minX = Infinity;
    let maxX = -Infinity;
    for (let t = 0; t < 400; t += 1) {
      const p = targetCamPose(g, t, makePose(), undefined, water);
      expect(water(p.position.x, p.position.z)).toBe(true);
      minX = Math.min(minX, p.position.x);
      maxX = Math.max(maxX, p.position.x);
    }
    // it still moves around (sweeps the open-water arc)
    expect(maxX - minX).toBeGreaterThan(d * 0.6);
    // open water all round: a full orbit
    const all = new Set<number>();
    for (let t = 0; t < 160; t += 2) {
      const p = targetCamPose(g, t, makePose(), undefined, () => true);
      all.add(Math.sign(p.position.x - g.position.x) * 2 + Math.sign(p.position.z - g.position.z));
    }
    expect(all.size).toBe(4);
  });
});

describe('PiP on a civil ship', () => {
  it('labels it with its name (short form drops the MV prefix)', () => {
    const g = ship('container');
    expect(pipName(g)).toBe('MV KŌTUKU TRADER');
    expect(pipName(g, true)).toBe('KŌTUKU TRADER');
    expect(pipName(ship('cruise'))).toBe('SOUTHERN BARNACLE');
  });

  it('holds the shot on a sinking ship longer than on other kills', () => {
    expect(pipHold(ship('cruise'))).toBe(PIP_SHIP_HOLD);
    expect(PIP_SHIP_HOLD).toBeGreaterThan(PIP_DESTROYED_HOLD);
    const L = computeLayout(makeLayout(), 844, 390, { top: 0, right: 0, bottom: 0, left: 0 }, Math.tan(Math.PI / 6), true, { pip: true });
    expect(L.pipW).toBeGreaterThan(0);
    resetPip();
    const g = ship('cruise', 31);
    const lookup = (id: number) => (id === g.id ? g : null);
    for (let i = 0; i < 30; i++) stepPip(L, g, lookup, true, 1 / 30);
    g.alive = false;
    let shown = 0;
    for (let i = 0; i < 30 * 10; i++) {
      const t = stepPip(L, null, lookup, true, 1 / 30);
      if (pipView.open && t === g) shown++;
    }
    expect(shown / 30).toBeGreaterThan(PIP_SHIP_HOLD - 0.2);
    expect(shown / 30).toBeLessThan(PIP_SHIP_HOLD + 0.3);
  });
});
