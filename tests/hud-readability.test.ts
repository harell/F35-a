/**
 * HUD and menu readability at 844×390 (issue #62, polish 4/5 of epic #84):
 *  - Defend: the strikers carry a STRK tag on every display (contacts, target box, TSD, tactical map),
 *    the escort doesn't, and the primary objective counts the strikers left ("STRIKERS n");
 *  - the off-screen target cue's text (angle-off, type, range) never prints over the speed / altitude
 *    columns, the DLZ or another HUD text, whichever way the target lies;
 *  - the target box's labels slide off the speed column instead of printing into it;
 *  - the GPS bomb's azimuth steering line breaks around the centre cue ("IN RANGE", "REL 5", STEER);
 *  - Defend's radar inset (chase view) always shows the tanks' count, even when it doesn't fit under
 *    the site symbol or the site lies beyond the scope's rim;
 *  - a civil contact's CIV label never prints on the touch controls (GUN, CMS, FIRE, throttle, stick);
 *  - the cockpit PCD's TSD and RWR corner readouts ("10 NM", "BULL 005/6", "2 EMIT") are at least
 *    12 px tall on the 844×390 screen (they were 9–10 px, and look smaller on the tilted panel).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PerspectiveCamera, Quaternion, Vector3 } from 'three';
import type { FrameContext } from '../src/core/contracts';
import { DEFAULT_SETTINGS, QUALITY_PRESETS } from '../src/core/data';
import { createCockpit } from '../src/hud/Cockpit';
import { createHud } from '../src/hud/Hud';
import type { CameraMode } from '../src/core/types';
import { computeTouchLayout } from '../src/input/touch/layout';
import { buildMock } from '../src/hud/dev/mockWorld';
import { installPath2D, makeFakeCanvas, overlaps, textBox, type Box } from '../src/hud/dev/fakeCanvas';
import { pcdScreenRect } from '../src/hud/cockpit/geometry';
import { PCD_W } from '../src/hud/cockpit/pcd';
import { altColumnBottom, speedColumnBottom } from '../src/hud/hmd/zones';
import type { HudFrame } from '../src/hud/hmd/frame';
import type { MissionDef } from '../src/core/contracts';
import { buildInstantMissionSeeded } from '../src/missions';
import { entityLabel, trackLabel, trackShort } from '../src/hud/hmd/format';
import { objectiveLines } from '../src/hud/hmd/overlays';
import { harness, killGroup } from './missions-helpers';

const defend = (enemyCount = 6): MissionDef =>
  buildInstantMissionSeeded({ mode: 'defend', theater: 'auckland', timeOfDay: 'day', weather: 'clear', enemyType: 'su27', enemyCount }, 62);

describe('Defend: the strikers can be told from the escort', () => {
  it('tags the strikers STRK and leaves the escort untagged, even when both fly the Su-27', () => {
    const h = harness(defend());
    const strikers = h.world.aircraft.filter((a) => a.groupId === 'strikers');
    const escort = h.world.aircraft.filter((a) => a.groupId === 'escort');
    expect(strikers.length).toBeGreaterThanOrEqual(2);
    expect(escort.length).toBeGreaterThanOrEqual(1);
    for (const s of strikers) {
      expect(s.hudTag).toBe('STRK');
      expect(trackLabel(s)).toBe(entityLabel(s) + ' STRK');
      expect(trackShort(s)).toBe('STRK');
    }
    for (const e of escort) {
      expect(e.hudTag).toBeUndefined();
      expect(trackLabel(e)).toBe(entityLabel(e));
      expect(trackShort(e)).not.toBe('STRK');
    }
    // the same label string every frame (no per-frame allocation)
    expect(trackLabel(strikers[0])).toBe(trackLabel(strikers[1]));
  });

  it('counts the strikers left on the primary objective line', () => {
    const h = harness(defend());
    h.runner.update(h.world, 0.1);
    const o = h.runner.objectives.find((x) => x.id === 'o_tanks')!;
    const strikers = h.world.aircraft.filter((a) => a.groupId === 'strikers');
    expect(o.primary).toBe(true);
    expect(o.threat).toEqual({ label: 'Strikers', left: strikers.length });
    const before = objectiveLines(o, 30);
    expect(before.join(' ')).toContain('STRIKERS ' + strikers.length);
    // one striker splashed: the count drops
    h.world.applyDamage(strikers[0], 1e6, h.world.player!.id, 'aim120');
    h.runner.update(h.world, 0.1);
    expect(o.threat?.left).toBe(strikers.length - 1);
    expect(objectiveLines(o, 30).join(' ')).toContain('STRIKERS ' + (strikers.length - 1));
    // the escort doesn't count
    killGroup(h, 'escort');
    h.runner.update(h.world, 0.1);
    expect(o.threat?.left).toBe(strikers.length - 1);
  });

  it('shows the count only while the objective is active', () => {
    const lines = objectiveLines({ label: 'Keep the tanks standing', state: 'complete', progress: { done: 9, total: 9 }, threat: { label: 'Strikers', left: 0 } }, 30);
    expect(lines.join(' ')).not.toContain('STRIKERS');
  });
});

describe('cockpit PCD corner readouts at 844×390', () => {
  installPath2D();
  const g = globalThis as unknown as { document?: unknown };
  const prevDoc = g.document;
  const created: ReturnType<typeof makeFakeCanvas>['ctx'][] = [];
  beforeAll(() => {
    g.document = {
      createElement: () => {
        const c = makeFakeCanvas(1024, 512);
        created.push(c.ctx);
        return c.canvas;
      },
    };
  });
  afterAll(() => {
    g.document = prevDoc;
  });

  it('draws the TSD range, the bullseye call and the RWR emitter count at least 12 px tall', () => {
    const W = 844;
    const H = 390;
    const mock = buildMock('threat');
    const cockpit = createCockpit(mock.events, { ...QUALITY_PRESETS.medium });
    cockpit.resize(W, H);
    cockpit.visible = true;
    const p = mock.player;
    const camera = new PerspectiveCamera(60, W / H, 0.5, 60_000);
    camera.position.set(0, 1.02, -3.52).applyQuaternion(p.quaternion).add(p.position);
    camera.quaternion.copy(p.quaternion);
    camera.updateMatrixWorld();
    const ctx: FrameContext = {
      dt: 1 / 30,
      time: 1,
      world: mock.world,
      player: p,
      camera,
      viewMode: 'cockpit',
      focusId: p.id,
      mission: mock.mission,
      settings: { ...DEFAULT_SETTINGS },
      quality: { ...QUALITY_PRESETS.medium },
      paused: false,
      screen: { width: W, height: H, dpr: 1, safe: { top: 0, right: 0, bottom: 0, left: 0 } },
    };
    for (let i = 0; i < 3; i++) cockpit.update(ctx, new Quaternion());
    const rect = pcdScreenRect(60, W, H);
    // the PCD texture is PCD_W texels across the panel's on-screen width
    const pxPerTexel = (rect.right - rect.left) / PCD_W;
    const texts = created.flatMap((c) => c.texts);
    for (const re of [/^\d+ NM$/, /^BULL \d{3}\/\d+$/, /^\d+ EMIT$/]) {
      const t = texts.find((x) => re.test(x.text));
      expect(t, String(re)).toBeTruthy();
      expect(t!.size * pxPerTexel, `${t!.text}: ${(t!.size * pxPerTexel).toFixed(1)} px`).toBeGreaterThanOrEqual(12);
    }
  });
});

describe('labels stay off the touch controls at 844×390', () => {
  installPath2D();
  for (const view of ['hud', 'chase'] as CameraMode[]) {
    for (const button of ['gun', 'cms', 'fire'] as const) {
      it(`${view}: a civil jet behind the ${button.toUpperCase()} button has no label on it`, () => {
        const W = 844;
        const H = 390;
        const mock = buildMock('aa');
        const { canvas, ctx: fake } = makeFakeCanvas(W, H, 1);
        const hud = createHud(canvas, mock.events);
        hud.resize(W, H, 1);
        const p = mock.player;
        const camera = new PerspectiveCamera(60, W / H, 0.5, 60_000);
        if (view === 'hud') {
          camera.position.set(0, 1.02, -3.52).applyQuaternion(p.quaternion).add(p.position);
          camera.quaternion.copy(p.quaternion);
        } else {
          camera.position.copy(p.position).add(new Vector3(0, 4.5, 20).applyQuaternion(p.quaternion));
          camera.up.set(0, 1, 0).applyQuaternion(p.quaternion);
          camera.lookAt(p.position.clone().add(new Vector3(0, 0, -40).applyQuaternion(p.quaternion)));
        }
        camera.updateMatrixWorld();
        camera.updateProjectionMatrix();
        const b = computeTouchLayout(W, H, { top: 0, right: 0, bottom: 0, left: 0 }, { leftHanded: false }).buttons[button];
        // a civil airliner (the mock's Su-57, repainted) 8 km out, right behind the button's centre
        const civ = mock.world.aircraft.find((a) => a.type === 'su57')!;
        (civ as { type: string }).type = 'a320';
        civ.team = 'neutral';
        const place = () => {
          const ndc = new Vector3(((b.x + b.w / 2) / W) * 2 - 1, -(((b.y + b.h / 2) / H) * 2 - 1), 0.5).unproject(camera);
          civ.position.copy(camera.position).addScaledVector(ndc.sub(camera.position).normalize(), 8000);
          const c = p.radar.contacts.find((x) => x.id === civ.id)!;
          c.position.copy(civ.position);
          c.team = 'neutral';
          c.lastSeen = 0;
        };
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
        for (let i = 0; i < 4; i++) {
          fake.reset();
          ctx.time += ctx.dt;
          place();
          hud.update(ctx);
        }
        const rect = { x0: b.x, y0: b.y, x1: b.x + b.w, y1: b.y + b.h };
        // (the contact's box is a symbol and may sit there; no text may)
        const on = fake.texts.filter((t) => t.text.trim() && overlaps(textBox(t), rect));
        expect(on.map((t) => t.text)).toEqual([]);
      });
    }
  }
});

describe('the off-screen target cue keeps clear of the HMD text', () => {
  installPath2D();
  // the bank-scale arc (drawn ±60° around the nadir, ticks up to 8 px out) as sample points
  const onBankArc = (arcs: { x: number; y: number; r: number; dashed: boolean }[], H: number, b: Box): boolean => {
    for (const a of arcs) {
      if (a.dashed || a.r < 55 || a.r > H * 0.26) continue;
      for (let d = -60; d <= 60; d += 1) {
        const ang = Math.PI / 2 + (d * Math.PI) / 180;
        for (const rr of [a.r, a.r + 4]) {
          const x = a.x + Math.cos(ang) * rr;
          const y = a.y + Math.sin(ang) * rr;
          if (x > b.x0 && x < b.x1 && y > b.y0 && y < b.y1) return true;
        }
      }
    }
    return false;
  };
  for (const view of ['hud', 'cockpit'] as CameraMode[]) {
    it(`${view}: no text overlap, and clear of the FPM, waterline and bank scale, in 16 directions`, () => {
      const W = 844;
      const H = 390;
      const bad: string[] = [];
      for (const offAxis of [0.45, 1.2, 2.3]) {
        for (let a = 0; a < 16; a++) {
          const mock = buildMock('offscreen');
          const { canvas, ctx: fake } = makeFakeCanvas(W, H, 1);
          const hud = createHud(canvas, mock.events);
          hud.resize(W, H, 1);
          const p = mock.player;
          const camera = new PerspectiveCamera(60, W / H, 0.5, 60_000);
          camera.position.set(0, 1.02, -3.52).applyQuaternion(p.quaternion).add(p.position);
          camera.quaternion.copy(p.quaternion);
          camera.updateMatrixWorld();
          camera.updateProjectionMatrix();
          const t = mock.world.getEntity(p.radar.designatedId!)!;
          const ang = (a / 16) * Math.PI * 2;
          const dir = new Vector3(Math.sin(ang) * Math.sin(offAxis), Math.cos(ang) * Math.sin(offAxis), -Math.cos(offAxis)).applyQuaternion(p.quaternion);
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
          for (let i = 0; i < 3; i++) {
            fake.reset();
            t.position.copy(p.position).addScaledVector(dir, 9000);
            hud.update(ctx);
          }
          const tx = fake.texts.filter((x) => x.text.trim());
          const tag = `${view} ${offAxis} ${a}`;
          const cueOff = tx.find((x) => x.text.endsWith('°') && x.size === 12.5);
          if (!cueOff) {
            // on screen in this view (the target box instead): nothing to check
            if (offAxis > 1) bad.push(`${tag}: no off-screen cue`);
            continue;
          }
          for (let i = 0; i < tx.length; i++) {
            for (let j = i + 1; j < tx.length; j++) {
              if (overlaps(textBox(tx[i]), textBox(tx[j]))) bad.push(`${tag}: "${tx[i].text}" x "${tx[j].text}"`);
            }
          }
          // the cue's block: the angle-off and the lines under it (same centre x)
          const cue = tx.filter((x) => Math.abs(x.x - cueOff.x) < 0.01 && x.y >= cueOff.y - 0.01 && x.y <= cueOff.y + 42);
          expect(cue.length).toBeGreaterThanOrEqual(3);
          // waterline at the nose (the camera looks along it): W/2 ± 15, from H/2 to 5 px below
          const wl: Box = { x0: W / 2 - 15, y0: H / 2 - 1, x1: W / 2 + 15, y1: H / 2 + 6 };
          // the FPM: a 6.5 px circle with 10 px wings and a 7 px fin
          const fpm = fake.arcs.find((c) => !c.dashed && Math.abs(c.r - 6.5) < 0.01);
          for (const c of cue) {
            const b = textBox(c);
            if (overlaps(b, wl)) bad.push(`${tag}: "${c.text}" on the waterline`);
            if (fpm && overlaps(b, { x0: fpm.x - 16.5, y0: fpm.y - 13.5, x1: fpm.x + 16.5, y1: fpm.y + 6.5 })) bad.push(`${tag}: "${c.text}" on the FPM`);
            if (onBankArc(fake.arcs, H, b)) bad.push(`${tag}: "${c.text}" on the bank scale`);
          }
        }
      }
      expect(bad).toEqual([]);
    });
  }
});

describe('the speed column reservation', () => {
  it('covers the THR line, and SPD BRK while the speed brake is out', () => {
    // rows: box (±11u), Mach at +0.75 line, G, max G, AoA, THR at +4.75 line, SPD BRK at +5.75 line
    const L = { boxY: 200, u: 1, line: 15 };
    const frame = (airbrake: boolean) => ({ L, p: { input: { airbrake }, flight: { surfaces: { airbrake: 0 } } } }) as unknown as HudFrame;
    const row = (k: number) => L.boxY + 11 + k * L.line + 6.5; // bottom of a 12 px row
    expect(speedColumnBottom(frame(false))).toBeGreaterThanOrEqual(row(4.75));
    expect(speedColumnBottom(frame(true))).toBeGreaterThanOrEqual(row(5.75));
  });

  it('on the altitude side, covers the aspect line under RALT, VVI and closure when flying low', () => {
    // rows: box (±11u), RALT at +0.75 line (below 5000 ft AGL), VVI, Vc, aspect / angels (air target)
    const L = { boxY: 200, u: 1, line: 15 };
    const frame = (aglM: number, air: boolean) => ({ L, p: { flight: { agl: aglM } }, target: air ? { kind: 'aircraft' } : null }) as unknown as HudFrame;
    const row = (k: number) => L.boxY + 11 + k * L.line + 6.5;
    expect(altColumnBottom(frame(300, true))).toBeGreaterThanOrEqual(row(3.75));
    expect(altColumnBottom(frame(3000, true))).toBeGreaterThanOrEqual(row(2.75));
    expect(altColumnBottom(frame(300, false))).toBeGreaterThanOrEqual(row(1.75));
    // no 4th row: the reservation stays as tight as before
    expect(altColumnBottom(frame(3000, true))).toBeLessThan(row(3.75));
  });
});

describe('the GPS azimuth steering line', () => {
  installPath2D();
  it('never runs through the centre release cue', () => {
    const W = 844;
    const H = 390;
    const mock = buildMock('ag');
    const { canvas, ctx: fake } = makeFakeCanvas(W, H, 1);
    // record every path segment (the fake canvas only records texts)
    const segs: [number, number, number, number][] = [];
    let cx = 0;
    let cy = 0;
    (fake as unknown as { moveTo: (x: number, y: number) => void }).moveTo = (x, y) => {
      cx = x;
      cy = y;
    };
    (fake as unknown as { lineTo: (x: number, y: number) => void }).lineTo = (x, y) => {
      segs.push([cx, cy, x, y]);
      cx = x;
      cy = y;
    };
    const hud = createHud(canvas, mock.events);
    hud.resize(W, H, 1);
    const p = mock.player;
    // the designated ground point dead ahead: the steering line runs down the middle, through the cue slot
    const fwd = new Vector3(0, 0, -1).applyQuaternion(p.quaternion).setY(0).normalize();
    p.radar.groundPoint = p.position.clone().addScaledVector(fwd, 9000).setY(0);
    const camera = new PerspectiveCamera(60, W / H, 0.5, 60_000);
    camera.position.set(0, 1.02, -3.52).applyQuaternion(p.quaternion).add(p.position);
    camera.quaternion.copy(p.quaternion);
    camera.updateMatrixWorld();
    camera.updateProjectionMatrix();
    const ctx: FrameContext = {
      dt: 1 / 30,
      time: 0,
      world: mock.world,
      player: p,
      camera,
      viewMode: 'hud',
      focusId: p.id,
      mission: mock.mission,
      settings: { ...DEFAULT_SETTINGS },
      quality: { ...QUALITY_PRESETS.medium },
      paused: false,
      screen: { width: W, height: H, dpr: 1, safe: { top: 0, right: 0, bottom: 0, left: 0 } },
    };
    let cue: ReturnType<typeof textBox> | null = null;
    for (let i = 0; i < 12 && !cue; i++) {
      fake.reset();
      segs.length = 0;
      ctx.time += ctx.dt;
      hud.update(ctx);
      const t = fake.texts.find((x) => x.text === 'IN RANGE' || x.text === 'STEER' || x.text === 'OUT OF RANGE' || /^REL \d+$/.test(x.text));
      if (t) cue = textBox(t);
    }
    expect(cue).toBeTruthy();
    // does the steering line (a long, near-vertical segment) cross the cue's text box? (sampled along it)
    const crosses = segs.filter(([x0, y0, x1, y1]) => {
      if (Math.abs(y1 - y0) < 15 || Math.abs(x1 - x0) > Math.abs(y1 - y0) * 0.5) return false;
      for (let k = 0; k <= 40; k++) {
        const x = x0 + ((x1 - x0) * k) / 40;
        const y = y0 + ((y1 - y0) * k) / 40;
        if (x > cue!.x0 + 1 && x < cue!.x1 - 1 && y > cue!.y0 + 1 && y < cue!.y1 - 1) return true;
      }
      return false;
    });
    expect(crosses.map((s) => s.map((v) => Math.round(v)).join(','))).toEqual([]);
  });
});

describe("Defend: the radar inset's site count", () => {
  installPath2D();
  it('is on the inset in the chase view at the start, wherever the site lies', () => {
    const W = 844;
    const H = 390;
    const h = harness(defend());
    h.runner.update(h.world, 0.1);
    const p = h.world.player!;
    const { canvas, ctx: fake } = makeFakeCanvas(W, H, 1);
    const hud = createHud(canvas, h.events);
    hud.resize(W, H, 1);
    const camera = new PerspectiveCamera(60, W / H, 0.5, 60_000);
    camera.position.copy(p.position).add(new Vector3(0, 4.5, 20).applyQuaternion(p.quaternion));
    camera.up.set(0, 1, 0).applyQuaternion(p.quaternion);
    camera.lookAt(p.position.clone().add(new Vector3(0, 0, -40).applyQuaternion(p.quaternion)));
    camera.updateMatrixWorld();
    camera.updateProjectionMatrix();
    const ctx: FrameContext = {
      dt: 1 / 30,
      time: 0,
      world: h.world,
      player: p,
      camera,
      viewMode: 'chase',
      focusId: p.id,
      mission: h.runner,
      settings: { ...DEFAULT_SETTINGS },
      quality: { ...QUALITY_PRESETS.medium },
      paused: false,
      screen: { width: W, height: H, dpr: 1, safe: { top: 0, right: 0, bottom: 0, left: 0 } },
    };
    // the site at the start (inside or beyond the scope), then moved out to 80 km on the same bearing
    const site = h.world.ground.filter((g) => g.groupId === 'wiri');
    for (const far of [false, true]) {
      if (far) {
        for (const g of site) {
          g.position.x = p.position.x + (g.position.x - p.position.x) * 4;
          g.position.z = p.position.z + (g.position.z - p.position.z) * 4;
        }
      }
      for (let i = 0; i < 3; i++) {
        fake.reset();
        ctx.time += ctx.dt;
        hud.update(ctx);
      }
      const counts = fake.texts.filter((t) => /^\d+\/9$/.test(t.text));
      expect(counts.length, far ? 'site far beyond the rim' : 'site at the start').toBeGreaterThanOrEqual(1);
    }
  });
});

describe("the target box's labels keep off the speed column", () => {
  installPath2D();
  it('hud view: a target right by the speed box has its type and range clear of the column', () => {
    const W = 844;
    const H = 390;
    const mock = buildMock('aa');
    const { canvas, ctx: fake } = makeFakeCanvas(W, H, 1);
    const hud = createHud(canvas, mock.events);
    hud.resize(W, H, 1);
    const p = mock.player;
    const camera = new PerspectiveCamera(60, W / H, 0.5, 60_000);
    camera.position.set(0, 1.02, -3.52).applyQuaternion(p.quaternion).add(p.position);
    camera.quaternion.copy(p.quaternion);
    camera.updateMatrixWorld();
    camera.updateProjectionMatrix();
    const ctx: FrameContext = {
      dt: 1 / 30,
      time: 0,
      world: mock.world,
      player: p,
      camera,
      viewMode: 'hud',
      focusId: p.id,
      mission: mock.mission,
      settings: { ...DEFAULT_SETTINGS },
      quality: { ...QUALITY_PRESETS.medium },
      paused: false,
      screen: { width: W, height: H, dpr: 1, safe: { top: 0, right: 0, bottom: 0, left: 0 } },
    };
    hud.update(ctx);
    const mach = fake.texts.find((t) => /^M \d/.test(t.text))!;
    expect(mach).toBeTruthy();
    const t = mock.world.getEntity(p.radar.designatedId!)!;
    const at = (sx: number, sy: number) => {
      const ndc = new Vector3((sx / W) * 2 - 1, -((sy / H) * 2 - 1), 0.5).unproject(camera);
      t.position.copy(camera.position).addScaledVector(ndc.sub(camera.position).normalize(), 9000);
      const c = p.radar.contacts.find((x) => x.id === t.id);
      if (c) c.position.copy(t.position);
    };
    const bad: string[] = [];
    // the box just right of the column, level with the Mach and G lines
    for (const [dx, dy] of [[10, 0], [25, 10], [40, 25]]) {
      for (let i = 0; i < 3; i++) {
        fake.reset();
        at(mach.x + dx, mach.y + dy);
        ctx.time += ctx.dt;
        hud.update(ctx);
      }
      const tx = fake.texts.filter((x) => x.text.trim());
      for (let i = 0; i < tx.length; i++) {
        for (let j = i + 1; j < tx.length; j++) if (overlaps(textBox(tx[i]), textBox(tx[j]))) bad.push(`${dx},${dy}: "${tx[i].text}" x "${tx[j].text}"`);
      }
    }
    expect(bad).toEqual([]);
  });
});
