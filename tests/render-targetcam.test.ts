import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from 'three';
import { computeLayout, makeLayout, type HudLayout } from '../src/hud/hmd/layout';
import { computeTouchLayout } from '../src/input/touch/layout';
import { NATO_AIR, NATO_SAM, pipName, pipStatus, pipView, resetPip, stepPip, PIP_DESTROYED_HOLD } from '../src/hud/hmd/pip';
import { TARGET_CAM_FOV, TARGET_CAM_MIN_AGL, framingDistance, makePose, targetCamPose } from '../src/render/targetCam/pose';
import { AircraftEntity, GroundTargetEntity, SamSiteEntity, type AnyEntity } from '../src/sim/entities';
import type { AircraftType, SamType } from '../src/core/types';

const W = 844;
const H = 390;
const tan30 = Math.tan(Math.PI / 6);
const noSafe = { top: 0, right: 0, bottom: 0, left: 0 };

type Box = { x0: number; y0: number; x1: number; y1: number };
const overlaps = (a: Box, b: Box) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
const pipBox = (L: HudLayout): Box => ({ x0: L.pipX, y0: L.pipY, x1: L.pipX + L.pipW, y1: L.pipY + L.pipH });

function jet(type: AircraftType = 'mig29'): AircraftEntity {
  const a = new AircraftEntity(1, type, 'red');
  a.position.set(1000, 5000, -2000);
  return a;
}

describe('target camera pose', () => {
  it('frames an aircraft from in front of its nose, slightly off-axis and above, looking at it', () => {
    const a = jet();
    // heading east (nose -Z rotated to +X), wings level
    a.quaternion.setFromAxisAngle(new Vector3(0, 1, 0), -Math.PI / 2);
    const nose = new Vector3(0, 0, -1).applyQuaternion(a.quaternion);
    const pose = targetCamPose(a, 0, makePose());
    const toCam = pose.position.clone().sub(a.position);
    const d = toCam.length();
    expect(d).toBeCloseTo(framingDistance(a), 3);
    const dir = toCam.normalize();
    // in front: within ~25° of the nose, never on the axis itself
    expect(dir.dot(nose)).toBeGreaterThan(Math.cos((25 * Math.PI) / 180));
    expect(dir.dot(nose)).toBeLessThan(0.999);
    // above the jet (looking slightly down → scenery behind it)
    expect(pose.position.y).toBeGreaterThan(a.position.y);
    expect(pose.look.distanceTo(a.position)).toBe(0);
    // horizon level (up ≈ world up for a wings-level jet)
    expect(pose.up.y).toBeGreaterThan(0.99);
  });

  it('stays in front of the nose heading and above the horizon whatever the jet pitch / bank', () => {
    const a = jet();
    for (const [pitch, roll] of [
      [0.6, 0],
      [-0.7, 1.2],
      [0.2, -2.5],
      [1.45, 0.4],
    ]) {
      a.quaternion.identity().multiply(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), pitch)).multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), roll));
      const pose = targetCamPose(a, 3, makePose());
      expect(pose.position.y).toBeGreaterThan(a.position.y);
      const fwdH = new Vector3(0, 0, -1).applyQuaternion(a.quaternion).setY(0);
      if (fwdH.lengthSq() > 0.04) {
        const camH = pose.position.clone().sub(a.position).setY(0).normalize();
        expect(camH.dot(fwdH.normalize())).toBeGreaterThan(0.8);
      }
      // the camera never rolls far from the horizon
      expect(pose.up.y).toBeGreaterThan(0.75);
      expect(Number.isFinite(pose.position.x + pose.position.y + pose.position.z)).toBe(true);
    }
  });

  it('scales the framing distance with the airframe and frames it inside the FOV', () => {
    const small = framingDistance(jet('mig29'));
    const big = framingDistance(jet('a50'));
    expect(big).toBeGreaterThan(small * 3);
    // the span fits the frame width (16:9) with room to spare
    const halfW = Math.tan((TARGET_CAM_FOV * Math.PI) / 360) * (16 / 9) * small;
    expect(11.4 / 2).toBeLessThan(halfW * 0.8);
  });

  it('orbits SAM sites slowly at low elevation and never goes below the terrain', () => {
    for (const type of ['sa6', 'sa8', 'sa10', 'sa15', 'sa18', 'zsu23'] as SamType[]) {
      const s = new SamSiteEntity(7, type, 'red');
      s.position.set(500, 120, 800);
      const p0 = targetCamPose(s, 0, makePose()).position.clone();
      const p1 = targetCamPose(s, 2, makePose()).position.clone();
      // moves, but slowly (< 15° in 2 s)
      const a0 = Math.atan2(p0.x - 500, p0.z - 800);
      const a1 = Math.atan2(p1.x - 500, p1.z - 800);
      const da = Math.abs(Math.atan2(Math.sin(a1 - a0), Math.cos(a1 - a0)));
      expect(da).toBeGreaterThan(0.01);
      expect(da).toBeLessThan(0.26);
      // low elevation look-down
      expect(p0.y).toBeGreaterThan(120);
      // ground clamp: a hill between camera and site lifts the camera
      const hill = targetCamPose(s, 0, makePose(), () => 400).position;
      expect(hill.y).toBeGreaterThanOrEqual(400 + TARGET_CAM_MIN_AGL);
    }
    const ship = new GroundTargetEntity(9, 'ship', 'red', { radius: 60 });
    expect(framingDistance(ship)).toBeGreaterThan(100);
  });
});

describe('target camera window layout', () => {
  it('HMD views: top right, clear of the heading tape, button column, DLZ and altitude column', () => {
    for (const cockpit of [true, false]) {
      const L = computeLayout(makeLayout(), W, H, noSafe, tan30, cockpit, { pip: true });
      expect(L.pipW).toBeGreaterThan(130);
      // three kill-feed lines (17 px apart) stay out of the centre band
      expect(L.killY + 34 * L.u).toBeLessThan(L.cy - 60);
      expect(L.pipW / L.pipH).toBeCloseTo(16 / 9, 1);
      expect(L.pipX + L.pipW).toBeLessThanOrEqual(L.right + 0.5);
      expect(L.pipY).toBeGreaterThanOrEqual(L.top);
      // heading tape (+ caret band)
      expect(L.pipX).toBeGreaterThan(L.cx + L.tapeHalfW + 8);
      // DLZ scale starts below the window, kill feed under it and left of the DLZ
      expect(L.dlzTop - 18).toBeGreaterThan(L.pipY + L.pipH);
      expect(L.killY).toBeGreaterThan(L.pipY + L.pipH);
      expect(L.killX).toBeLessThan(L.dlzX - 10);
      // altitude box stays clear
      expect(L.pipY + L.pipH).toBeLessThan(L.boxY - 13);
    }
  });

  it('external views: under the radar inset, above the stick zone and touch buttons', () => {
    for (const leftHanded of [false, true]) {
      const L = computeLayout(makeLayout(), W, H, noSafe, tan30, false, { external: true, pip: true, leftHanded });
      expect(L.pipW).toBeGreaterThan(120);
      const r = pipBox(L);
      const inset: Box = { x0: L.insetCx - L.insetR, y0: L.insetCy - L.insetR, x1: L.insetCx + L.insetR, y1: L.insetCy + L.insetR + 12 };
      expect(overlaps(r, inset)).toBe(false);
      const t = computeTouchLayout(W, H, noSafe, { leftHanded });
      const stick: Box = { x0: t.stickHome.x - t.stickRadius, y0: t.stickHome.y - t.stickRadius, x1: t.stickHome.x + t.stickRadius, y1: t.stickHome.y + t.stickRadius };
      expect(overlaps(r, stick)).toBe(false);
      const b = t.buttons as unknown as Record<string, { x: number; y: number; w: number; h: number }>;
      for (const k of Object.keys(b)) {
        const rc = b[k];
        expect(overlaps(r, { x0: rc.x, y0: rc.y, x1: rc.x + rc.w, y1: rc.y + rc.h }), k).toBe(false);
      }
      expect(overlaps(r, { x0: t.throttle.x, y0: t.throttle.y, x1: t.throttle.x + t.throttle.w, y1: t.throttle.y + t.throttle.h })).toBe(false);
    }
  });

  it('is off without the option, and on tiny screens', () => {
    expect(computeLayout(makeLayout(), W, H, noSafe, tan30, true).pipW).toBe(0);
    expect(computeLayout(makeLayout(), 480, 240, noSafe, tan30, false, { external: true, pip: true }).pipW).toBe(0);
  });

  it('scales up on tablets', () => {
    const L = computeLayout(makeLayout(), 1366, 1024, noSafe, tan30, false, { pip: true });
    expect(L.pipW).toBeGreaterThan(200);
  });
});

describe('target camera window state', () => {
  const L = computeLayout(makeLayout(), W, H, noSafe, tan30, false, { pip: true });

  it('opens on a target, animates, and closes when it is gone', () => {
    resetPip();
    const t = jet();
    const lookup = (id: number) => (id === t.id ? t : null);
    expect(stepPip(L, null, lookup, true, 0.016)).toBe(null);
    expect(pipView.vh).toBe(0);
    stepPip(L, t, lookup, true, 0.05);
    expect(pipView.open).toBe(true);
    expect(pipView.vh).toBeGreaterThan(0);
    expect(pipView.vh).toBeLessThan(L.pipH);
    for (let i = 0; i < 20; i++) stepPip(L, t, lookup, true, 0.05);
    expect(pipView.anim).toBe(1);
    expect(pipView.vh).toBe(L.pipH);
    expect(pipView.targetId).toBe(t.id);
    // designation dropped (target alive): closes
    for (let i = 0; i < 20; i++) stepPip(L, null, lookup, true, 0.05);
    expect(pipView.open).toBe(false);
    expect(pipView.vh).toBe(0);
    expect(pipView.targetId).toBe(null);
  });

  it('holds a destroyed target on screen for a moment, then closes', () => {
    resetPip();
    const t = jet();
    const lookup = (id: number) => (id === t.id ? t : null);
    for (let i = 0; i < 10; i++) stepPip(L, t, lookup, true, 0.05);
    t.alive = false;
    const shown = stepPip(L, null, lookup, true, 0.05);
    expect(shown).toBe(t);
    expect(pipStatus(t, new Vector3()).text).toBe('DESTROYED');
    for (let s = 0; s < PIP_DESTROYED_HOLD + 1; s += 0.05) stepPip(L, null, lookup, true, 0.05);
    expect(pipView.open).toBe(false);
    expect(pipView.vh).toBe(0);
  });

  it('holds the kill shot even when the radar auto-designates the next target, then cuts to it', () => {
    resetPip();
    const a = jet();
    const b = new AircraftEntity(2, 'su35', 'red');
    const lookup = (id: number) => (id === a.id ? a : id === b.id ? b : null);
    for (let i = 0; i < 10; i++) stepPip(L, a, lookup, true, 0.05);
    a.alive = false;
    expect(stepPip(L, b, lookup, true, 0.05)).toBe(a);
    for (let s = 0; s < PIP_DESTROYED_HOLD - 0.2; s += 0.05) expect(stepPip(L, b, lookup, true, 0.05)).toBe(a);
    for (let i = 0; i < 10; i++) stepPip(L, b, lookup, true, 0.05);
    expect(pipView.targetId).toBe(b.id);
    expect(pipView.open).toBe(true);
  });

  it('is never shown when not allowed (setting off / no room)', () => {
    resetPip();
    const t = jet();
    for (let i = 0; i < 10; i++) stepPip(L, t, () => t, false, 0.05);
    expect(pipView.open).toBe(false);
    expect(pipView.vh).toBe(0);
  });
});

describe('target camera labels', () => {
  it('names aircraft and SAMs with their NATO reporting names', () => {
    expect(pipName(jet('mig29'))).toBe('MIG-29 FULCRUM');
    expect(pipName(jet('su57'))).toBe('SU-57 FELON');
    expect(pipName(new SamSiteEntity(2, 'sa6', 'red'))).toBe('SA-6 GAINFUL');
    expect(pipName(new SamSiteEntity(2, 'sa10', 'red'))).toBe('SA-10 GRUMBLE');
    expect(pipName(new GroundTargetEntity(3, 'ship', 'red'))).toBe('SHIP');
    // every military type has a reporting name (the civil A320 shows its callsign instead)
    for (const k of Object.keys(NATO_AIR)) if (k !== 'a320') expect(NATO_AIR[k as AircraftType].length).toBeGreaterThan(2);
    for (const k of Object.keys(NATO_SAM)) expect(NATO_SAM[k as SamType].length).toBeGreaterThan(2);
  });

  it('shows civil airliners as civil traffic: callsign, flight phase, CHECK FIRE when locked', () => {
    const a = new AircraftEntity(5, 'a320', 'neutral', { callsign: 'AeroFlop 104' });
    a.civil = { phase: 'approach' } as AircraftEntity['civil'];
    const me = new Vector3(0, 1000, -10_000);
    expect(pipName(a)).toBe('AEROFLOP 104 A320');
    expect(pipName(a, true)).toBe('AEROFLOP 104');
    expect(pipName(jet('su35'), true)).toBe('SU-35');
    expect(pipStatus(a, me)).toEqual({ text: 'APPROACH', tone: 'civil' });
    a.civil!.phase = 'rollout';
    expect(pipStatus(a, me).text).toBe('LANDING');
    a.civil!.phase = 'takeoff';
    expect(pipStatus(a, me).text).toBe('TAKEOFF');
    // never an aspect / threat tag, even when pointing at us
    a.velocity.set(0, 0, -100);
    expect(['HOT', 'FLANK', 'COLD']).not.toContain(pipStatus(a, me).text);
    expect(pipStatus(a, me, true)).toEqual({ text: 'CHECK FIRE', tone: 'warn' });
    a.alive = false;
    expect(pipStatus(a, me)).toEqual({ text: 'DOWN', tone: 'danger' });
    // framed for a 36 m span
    expect(framingDistance(a)).toBeGreaterThan(50);
  });

  it('shows the SAM radar state', () => {
    const s = new SamSiteEntity(2, 'sa6', 'red');
    const at = new Vector3(0, 0, 0);
    const st = (state: SamSiteEntity['state'], on = true) => {
      s.state = state;
      s.radarOn = on;
      return pipStatus(s as AnyEntity, at);
    };
    expect(st('search')).toEqual({ text: 'SEARCH', tone: 'warn' });
    expect(st('track').text).toBe('TRACK');
    expect(st('launch').text).toBe('LAUNCH');
    expect(st('guiding').text).toBe('LAUNCH');
    expect(st('reload').text).toBe('RELOAD');
    expect(st('emcon').text).toBe('SILENT');
    expect(st('search', false).text).toBe('SILENT');
  });

  it('shows the bandit aspect (HOT / FLANK / COLD)', () => {
    const a = jet();
    a.position.set(0, 1000, 0);
    const me = new Vector3(0, 1000, -10_000); // north of the bandit
    a.velocity.set(0, 0, -250); // flying north, at us
    expect(pipStatus(a, me).text).toBe('HOT');
    a.velocity.set(250, 0, 0);
    expect(pipStatus(a, me).text).toBe('FLANK');
    a.velocity.set(0, 0, 250);
    expect(pipStatus(a, me).text).toBe('COLD');
  });
});
