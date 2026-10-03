/**
 * Issue #116 — an F-35A pilot's review of the cockpit view (playtest 2026-10-02, findings 1.2-*, 2.1-e,
 * 3.1-c): text collisions and wording on the HMD. Each scene puts the two symbols the review saw
 * colliding on top of each other and checks the layout pulls them apart.
 */
import { describe, expect, it } from 'vitest';
import { PerspectiveCamera, Quaternion, Vector3 } from 'three';
import { restHead } from '../src/render/camera/cameraMath';
import type { FrameContext } from '../src/core/contracts';
import { DEFAULT_SETTINGS, QUALITY_PRESETS } from '../src/core/data';
import type { CameraMode } from '../src/core/types';
import { createHud } from '../src/hud/Hud';
import { buildMock, type Scenario } from '../src/hud/dev/mockWorld';
import { installPath2D, makeFakeCanvas, overlaps, textBox, type Box, type TextRec } from '../src/hud/dev/fakeCanvas';
import { computeLayout, makeLayout } from '../src/hud/hmd/layout';
import { entityLabel, groundLabel } from '../src/hud/hmd/format';
import { AircraftEntity, GroundTargetEntity, MissileEntity } from '../src/sim/entities';
import type { MunitionDef } from '../src/sim/entities';

installPath2D();

const W = 844;
const H = 390;
const L = computeLayout(makeLayout(), W, H, { top: 0, right: 0, bottom: 0, left: 0 }, Math.tan((60 * Math.PI) / 360), false);

function rig(scene: Scenario, view: CameraMode) {
  const mock = buildMock(scene);
  const { canvas, ctx: fake } = makeFakeCanvas(W, H, 1);
  const hud = createHud(canvas, mock.events);
  hud.resize(W, H, 1);
  hud.setVisible(true);
  const camera = new PerspectiveCamera(60, W / H, 0.5, 60_000);
  const p = mock.player;
  const place = () => {
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
  place();
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
  return {
    hud,
    fake,
    mock,
    camera,
    ctx,
    /** World point `dist` m from the camera that projects to screen (x, y). */
    at(x: number, y: number, dist: number): Vector3 {
      const v = new Vector3((x / W) * 2 - 1, -((y / H) * 2 - 1), 0.5).unproject(camera);
      return camera.position.clone().add(v.sub(camera.position).normalize().multiplyScalar(dist));
    },
    run(seconds = 0.1, dt = 1 / 30): TextRec[] {
      const n = Math.max(1, Math.round(seconds / dt));
      for (let i = 0; i < n; i++) {
        fake.reset();
        ctx.dt = dt;
        ctx.time += dt;
        mock.tick(dt);
        hud.update(ctx);
      }
      return fake.texts.slice();
    },
  };
}

const find = (texts: TextRec[], s: string | RegExp) => texts.filter((t) => (typeof s === 'string' ? t.text === s : s.test(t.text)));

/** Texts that overlap `t` (other than itself). */
function hitsOf(texts: TextRec[], t: TextRec, pad = 1): string[] {
  const b = textBox(t);
  return texts.filter((o) => o !== t && o.text.trim() && overlaps(b, textBox(o), pad)).map((o) => `"${o.text}"@${o.x | 0},${o.y | 0}`);
}

/** Pairs of overlapping texts. */
function textOverlaps(texts: TextRec[], pad = 1.5): string[] {
  const out: string[] = [];
  const boxes: Box[] = texts.map(textBox);
  for (let i = 0; i < texts.length; i++) {
    for (let j = i + 1; j < texts.length; j++) {
      if (!texts[i].text.trim() || !texts[j].text.trim()) continue;
      if (overlaps(boxes[i], boxes[j], pad)) out.push(`"${texts[i].text}"@${texts[i].x | 0},${texts[i].y | 0} x "${texts[j].text}"@${texts[j].x | 0},${texts[j].y | 0}`);
    }
  }
  return out;
}

const aim120 = (): MunitionDef => ({
  id: 'aim120', name: 'AIM-120D', short: 'AMRAAM', category: 'aam', guidance: 'active_radar', launch: 'rail', mass: 150, boostTime: 3, boostAccel: 200,
  sustainTime: 5, sustainAccel: 40, drag: 0.001, glideRatio: 0, maxG: 40, seekerFov: 0.3, gimbalLimit: 1, seekerRange: 15000,
  navConstant: 4, minRange: 1000, maxRange: 30000, fuseRadius: 10, damage: 100, blastRadius: 15, maxFlightTime: 60,
  flareResistance: 0.5, chaffResistance: 0.5, notchResistance: 0.5, smoke: 0.3, length: 3.6, diameter: 0.18,
});

/** Does the circle (cx, cy, r) cross the box (by more than `pad` px)? */
function circleCutsBox(cx: number, cy: number, r: number, b: Box, pad = 1): boolean {
  const nx = Math.max(b.x0 + pad, Math.min(b.x1 - pad, cx));
  const ny = Math.max(b.y0 + pad, Math.min(b.y1 - pad, cy));
  const near = Math.hypot(nx - cx, ny - cy);
  const fx = Math.max(Math.abs(b.x0 + pad - cx), Math.abs(b.x1 - pad - cx));
  const fy = Math.max(Math.abs(b.y0 + pad - cy), Math.abs(b.y1 - pad - cy));
  const far = Math.hypot(fx, fy);
  return near < r && far > r;
}

describe('#116 collisions: brevity, seeker and gun labels vs the target box', () => {
  it('1.2-b: FOX 3 never prints over the target box\'s type / range labels (head-on shot, box at the cue slot)', () => {
    for (const view of ['hud', 'cockpit'] as CameraMode[]) {
      for (const dy of [-30, -16, 0, 12, 24, 40]) {
        const r = rig('lock', view);
        const mig = r.mock.world.aircraft.find((a) => a.type === 'mig29')!;
        const cue = computeLayout(makeLayout(), W, H, { top: 0, right: 0, bottom: 0, left: 0 }, Math.tan((60 * Math.PI) / 360), view === 'cockpit');
        mig.position.copy(r.at(cue.cx + 4, cue.cueY + dy, 14_000));
        r.run(1 / 30);
        const m = new MissileEntity(950, aim120(), 'blue', r.mock.player.id, mig.id);
        r.mock.events.emit('munition:launch', { missile: m, shooter: r.mock.player } as never);
        const texts = r.run(1 / 30);
        const fox = find(texts, 'FOX 3');
        expect(fox.length, `${view} dy ${dy}`).toBe(1);
        expect(hitsOf(texts, fox[0]), `${view} dy ${dy}`).toEqual([]);
      }
    }
  });

  it('1.2-c: the AIM-9X TONE label never covers the target box\'s range readout', () => {
    // (the scene's MiG sits under the target camera window: bring it out, at a few heights)
    for (const view of ['hud', 'cockpit'] as CameraMode[]) {
      for (const [x, y] of [[560, 150], [470, 200], [330, 140], [500, 225]]) {
        const r = rig('9x', view);
        const mig = r.mock.world.aircraft.find((a) => a.type === 'mig29')!;
        mig.position.copy(r.at(x, y, 3200));
        const texts = r.run(0.2);
        const tone = find(texts, 'TONE');
        expect(tone.length, `${view} ${x},${y}`).toBe(1);
        expect(hitsOf(texts, tone[0]), `${view} ${x},${y}`).toEqual([]);
        // the range readout is still drawn, clear of the seeker circle
        const rng = find(texts, /^\d+(\.\d)?$/).filter((t) => t.size === 12.5 && Math.abs(t.x - x) < 30);
        expect(rng.length, `${view} ${x},${y}`).toBe(1);
        expect(hitsOf(texts, rng[0]), `${view} ${x},${y}`).toEqual([]);
        const ring = r.fake.arcs.find((a) => Math.abs(a.x - x) < 2 && Math.abs(a.y - y) < 2 && a.r > 14 && a.r < 20)!;
        expect(circleCutsBox(ring.x, ring.y, ring.r, textBox(rng[0])), `${view} ${x},${y}: seeker ring cuts the range`).toBe(false);
      }
    }
  });

  it('1.2-c: TONE stays off the box labels with the kill feed above the box (the reserved feed rect is wider than its text)', () => {
    for (const view of ['hud', 'cockpit'] as CameraMode[]) {
      const r = rig('9x', view);
      const mig = r.mock.world.aircraft.find((a) => a.type === 'mig29')!;
      mig.position.copy(r.at(530, 125, 3200));
      r.run(1 / 30);
      const su35 = r.mock.world.aircraft.find((a) => a.type === 'su35')!;
      const sa6 = r.mock.world.sams[0];
      r.mock.events.emit('destroyed', { entity: sa6, attackerId: r.mock.player.id } as never);
      r.mock.events.emit('destroyed', { entity: su35, attackerId: r.mock.player.id } as never);
      r.run(0.2);
      const texts = r.run(1 / 30);
      expect(find(texts, /DESTROYED|SPLASH/).length, view).toBeGreaterThan(0);
      const tone = find(texts, 'TONE');
      expect(tone.length, view).toBe(1);
      expect(hitsOf(texts, tone[0]), view).toEqual([]);
    }
  });

  it('3.1-c: the gun pipper ring never cuts the designated target\'s name / range labels', () => {
    for (const view of ['hud', 'cockpit', 'chase'] as CameraMode[]) {
      // the pipper sliding over the box: below it, on it, above it, to the side
      for (const [ox, oy] of [[0, 30], [0, 22], [0, 0], [0, -24], [6, 34], [-12, -30], [20, 20]]) {
        const r = rig('gun', view);
        const mig = r.mock.world.aircraft.find((a) => a.type === 'mig29')!;
        let lead = new Vector3();
        (r.mock.world.combat as unknown as { gunLeadPoint: () => Vector3 }).gunLeadPoint = () => lead.clone();
        r.run(1 / 30);
        // where the box is (the type label is centred on it)
        const sp = mig.position.clone().project(r.camera);
        const bx = ((sp.x + 1) / 2) * W;
        const by = ((1 - sp.y) / 2) * H;
        lead = r.at(bx + ox, by + oy, mig.position.distanceTo(r.camera.position));
        const texts = r.run(1 / 30);
        const ring = r.fake.arcs.find((a) => Math.abs(a.r - 19) < 0.5 && Math.abs(a.x - (bx + ox)) < 2 && Math.abs(a.y - (by + oy)) < 2);
        expect(ring, `${view} ${ox},${oy}: pipper drawn`).toBeTruthy();
        const labels = texts.filter((t) => Math.abs(t.x - bx) < 40 && (t.text === 'MIG-29' || (/^\d+(\.\d)?$/.test(t.text) && t.size === 12.5)));
        for (const t of labels) expect(circleCutsBox(ring!.x, ring!.y, ring!.r, textBox(t)), `${view} ${ox},${oy}: ring cuts "${t.text}"`).toBe(false);
        // the range stays on screen unless the ring is right on top of it
        expect(labels.length, `${view} ${ox},${oy}`).toBeGreaterThan(0);
      }
    }
  });
});

describe('#116 collisions: incoming missiles, waterline, wingmen, bank arc, CIV labels', () => {
  it('1.2-d: the off-screen cue\'s text never runs into an incoming missile\'s arrow / TTI, whatever its bearing', () => {
    const bad: string[] = [];
    for (const view of ['hud', 'cockpit'] as CameraMode[]) {
      // the designated fuel depot 50° / 90° off the nose in 8 directions, the missile from 12 bearings
      for (const off of [0.9, Math.PI / 2]) {
        for (let a = 0; a < 8; a++) {
          for (let b = 0; b < 12; b++) {
            const r = rig('threat', view);
            const p = r.mock.player;
            const fuel = r.mock.world.ground.find((g) => g.type === 'fuel')!;
            const ang = (a / 8) * Math.PI * 2;
            const dir = new Vector3(Math.sin(ang) * Math.sin(off), Math.cos(ang) * Math.sin(off), -Math.cos(off)).applyQuaternion(p.quaternion);
            fuel.position.copy(p.position).addScaledVector(dir, 9000);
            p.radar.designatedId = fuel.id;
            p.radar.lockedId = null;
            p.incoming = [{ missileId: 9999, bearing: (b * Math.PI) / 6, elevation: 0, distance: 6000, timeToImpact: 32, guidance: 'radar' }];
            const texts = r.run(1 / 30);
            const tti = find(texts, '32');
            expect(tti.length, `${view} b ${b}`).toBe(1);
            for (const h of hitsOf(texts, tti[0], 0)) bad.push(`${view} target ${a * 45}° ${((off * 180) / Math.PI) | 0}° off, missile ${b * 30}°: ${h}`);
          }
        }
      }
    }
    expect(bad).toEqual([]);
  }, 60_000);

  it('1.2-d: the centre cues (SHOOT, FOX 3) never print over an incoming missile\'s TTI', () => {
    for (const view of ['hud', 'cockpit'] as CameraMode[]) {
      for (let b = 0; b < 12; b++) {
        const r = rig('lock', view);
        const p = r.mock.player;
        p.incoming = [{ missileId: 9999, bearing: (b * Math.PI) / 6, elevation: 0, distance: 6000, timeToImpact: 32, guidance: 'radar' }];
        r.run(1 / 30);
        const m = new MissileEntity(950, aim120(), 'blue', p.id, p.radar.lockedId!);
        r.mock.events.emit('munition:launch', { missile: m, shooter: p } as never);
        const texts = r.run(1 / 30);
        const tti = find(texts, '32')[0];
        expect(tti, `${view} b ${b}`).toBeTruthy();
        for (const c of [...find(texts, 'SHOOT'), ...find(texts, 'FOX 3')]) expect(overlaps(textBox(c), textBox(tti), 0), `${view} ${c.text} b ${b}`).toBe(false);
      }
    }
  });

  it('1.2-k: REL n / SHOOT never print into the waterline W', () => {
    for (const scene of ['ag', 'lock'] as Scenario[]) {
      for (const dy of [-10, -4, 0, 6, 12]) {
        const r = rig(scene, 'hud');
        r.run(1 / 30);
        // pitch the camera up so the nose (the W) sits on the centre cue slot
        const f = (H / 2) / Math.tan((30 * Math.PI) / 180);
        const pitch = Math.atan((L.cueY + dy - L.cy) / f);
        r.camera.quaternion.multiply(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), pitch));
        r.camera.updateMatrixWorld();
        const texts = r.run(1 / 30);
        const nose = new Vector3(0, 0, -1000).applyQuaternion(r.mock.player.quaternion).add(r.camera.position).project(r.camera);
        const nx = ((nose.x + 1) / 2) * W;
        const ny = ((1 - nose.y) / 2) * H;
        expect(Math.abs(ny - (L.cueY + dy))).toBeLessThan(2);
        const w: Box = { x0: nx - 15, y0: ny - 1, x1: nx + 15, y1: ny + 6 };
        const cue = [...find(texts, /^REL \d+$/), ...find(texts, 'SHOOT'), ...find(texts, 'IN RANGE')];
        expect(cue.length, `${scene} dy ${dy}`).toBeGreaterThan(0);
        for (const c of cue) expect(overlaps(textBox(c), w, 0), `${scene} ${c.text} dy ${dy}`).toBe(false);
      }
    }
  });

  it('1.2-l: a wingman marker never prints over the off-screen cue\'s text', () => {
    for (const view of ['hud', 'cockpit'] as CameraMode[]) {
      const r = rig('offscreen', view);
      const texts0 = r.run(1 / 30);
      const rng = find(texts0, /^\d+(\.\d)?$/).find((t) => t.size === 10.5);
      expect(rng, view).toBeTruthy();
      // the wingman flies right where the cue's range text was
      const wing = r.mock.world.aircraft.find((a) => a.name === 'VIPER 2')!;
      wing.position.copy(r.at(rng!.x, rng!.y + 3, 1500));
      const texts = r.run(1 / 30);
      const marker = r.fake.arcs.find((a) => Math.abs(a.a0 - Math.PI) < 1e-6 && Math.abs(a.a1 - Math.PI * 2) < 1e-6);
      expect(marker, view).toBeTruthy();
      const mb: Box = { x0: marker!.x - marker!.r, y0: marker!.y - marker!.r, x1: marker!.x + marker!.r, y1: marker!.y + 1 };
      const cueText = texts.filter((t) => t.size === 10.5 || t.size === 12.5).filter((t) => /°$|^SU-57$|^\d+(\.\d)?$/.test(t.text));
      expect(cueText.length, view).toBeGreaterThanOrEqual(3);
      for (const t of cueText) expect(overlaps(textBox(t), mb, 0), `${view} "${t.text}" under the wingman`).toBe(false);
    }
  });

  it('1.2-o: the bank arc breaks around the target box (hud view)', () => {
    const r = rig('lock', 'hud');
    r.run(1 / 30);
    // the MiG right on the bank arc's bottom
    const R = Math.max(60 * L.u, Math.min(L.H * 0.25, L.cockpitTop - L.cy - 16 * L.u));
    const mig = r.mock.world.aircraft.find((a) => a.type === 'mig29')!;
    mig.position.copy(r.at(L.cx + 20, L.cy + R, 14_000));
    r.run(1 / 30);
    const box: Box = { x0: L.cx + 20 - 13, y0: L.cy + R - 13, x1: L.cx + 20 + 13, y1: L.cy + R + 13 };
    const pieces = r.fake.arcs.filter((a) => Math.abs(a.r - R) < 0.5 && Math.abs(a.x - L.cx) < 0.5 && Math.abs(a.y - L.cy) < 0.5);
    expect(pieces.length).toBeGreaterThan(1);
    for (const a of pieces) {
      for (let k = 0; k <= 20; k++) {
        const ang = a.a0 + ((a.a1 - a.a0) * k) / 20;
        const x = a.x + Math.cos(ang) * a.r;
        const y = a.y + Math.sin(ang) * a.r;
        expect(x > box.x0 && x < box.x1 && y > box.y0 && y < box.y1, `arc at ${x | 0},${y | 0}`).toBe(false);
      }
    }
  });

  it('1.2-o: over a city of civil traffic only the two nearest say CIV (white boxes for the rest)', () => {
    const r = rig('nav', 'hud');
    const p = r.mock.player;
    for (let i = 0; i < 6; i++) {
      const civ = new AircraftEntity(700 + i, 'a320', 'neutral', { name: 'NZ' + i, radius: 20 });
      civ.position.copy(r.at(L.cx - 100 + i * 45, L.cy - 60 + (i % 2) * 28, 9000 + i * 900));
      (r.mock.world.aircraft as AircraftEntity[]).push(civ);
      p.radar.contacts.push({ id: civ.id, lastSeen: 0, position: civ.position.clone(), velocity: civ.velocity.clone(), team: 'neutral', source: 'radar' });
      const byId = r.mock.world.getEntity;
      (r.mock.world as { getEntity: unknown }).getEntity = (id: number | null | undefined) => (id === civ.id ? civ : byId(id));
    }
    const texts = r.run(1 / 30);
    expect(find(texts, 'CIV').length).toBe(2);
  });
});

describe('#116 wording', () => {
  it('1.2-m: a parked jet the mission names after its type reads as that type (HMD, PiP, PCD)', () => {
    const jet = new GroundTargetEntity(1, 'parked_jet', 'red', { name: 'MiG-29', radius: 9 });
    expect(entityLabel(jet)).toBe('MIG-29');
    expect(groundLabel(jet)).toBe('MIG-29');
    const generic = new GroundTargetEntity(2, 'parked_jet', 'red', { name: 'Parked Jet', radius: 9 });
    expect(entityLabel(generic)).toBe('JET');
    expect(groundLabel(new GroundTargetEntity(3, 'fuel', 'red', { name: 'Fuel Depot', radius: 9 }))).toBe('FUEL DEPOT');
  });

  it('1.2-n: missile time to impact reads T n (M is Mach), peak g reads GMAX', () => {
    const r = rig('lock', 'hud');
    const texts = r.run(0.2);
    expect(find(texts, /^T \d+$/).length).toBeGreaterThan(0);
    expect(find(texts, /^M \d+$/).length).toBe(0);
    expect(find(texts, /^M \d\.\d\d$/).length).toBe(1);
    expect(find(texts, /^GMAX \d+\.\d$/).length).toBe(1);
  });

  it('2.1-e: a release denial (NO SEEKER) goes away when the weapon changes', () => {
    const r = rig('9x', 'hud');
    const p = r.mock.player;
    r.run(1 / 30);
    r.mock.events.emit('weapon:denied', { ownerId: p.id, weapon: 'aim9x', reason: 'No seeker' });
    expect(find(r.run(1 / 30), 'NO SEEKER').length + find(r.run(1 / 30), 'NO SEEKER').length).toBeGreaterThan(0);
    p.selectedWeapon = 'gun';
    r.mock.events.emit('weapon:select', { ownerId: p.id, weapon: 'gun' });
    for (let i = 0; i < 6; i++) expect(find(r.run(1 / 30), 'NO SEEKER').length).toBe(0);
  });
});

describe('#116: the existing combat scenes stay overlap-free', () => {
  // ('9x' is left out: its MiG sits under the target camera window, a mock geometry the game avoids)
  for (const scene of ['threat', 'gun', 'lock', 'aa', 'ag', 'offscreen'] as Scenario[]) {
    for (const view of ['hud', 'cockpit', 'chase'] as CameraMode[]) {
      it(`${scene} / ${view}`, () => {
        const r = rig(scene, view);
        r.run(1.2);
        const bad = textOverlaps(r.run(1 / 30));
        expect(bad, bad.join('\n')).toEqual([]);
      });
    }
  }
});
