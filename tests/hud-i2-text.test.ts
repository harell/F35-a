/**
 * Iteration-2 HUD regression tests (reviewer package i2-hud):
 *  - no text-on-text overlaps in the threat / gun / lock / aa lab scenes (HMD, cockpit and external
 *    views): fixed blocks are reserved in the occupancy registry before any world label, SAM / ground /
 *    friendly labels register and dodge ("CAPSA-10", "PITBULLSPIKE 29"), warning chips are never dimmed;
 *  - the pitch ladder never prints on the heading tape and declutters under G / missile threat;
 *  - cockpit view: radio subtitles live in the left column, the warning band keeps its top slot;
 *  - TSD 5 / 10 NM ranges, RWR co-bearing declutter, tactical legend collapses behind an 'i' chip.
 */
import { describe, expect, it } from 'vitest';
import { PerspectiveCamera, Quaternion, Vector3 } from 'three';
import type { FrameContext } from '../src/core/contracts';
import { DEFAULT_SETTINGS, QUALITY_PRESETS } from '../src/core/data';
import type { CameraMode } from '../src/core/types';
import { createHud } from '../src/hud/Hud';
import { buildMock, type Scenario } from '../src/hud/dev/mockWorld';
import { installPath2D, makeFakeCanvas, overlaps, textBox, type Box, type TextRec } from '../src/hud/dev/fakeCanvas';
import { computeLayout, makeLayout } from '../src/hud/hmd/layout';
import { Occupancy } from '../src/hud/hmd/occupancy';
import { TacMapState, LEGEND_SHOW } from '../src/hud/hmd/tacmap';
import { autoTsdRange } from '../src/hud/hmd/tsd';
import { TSD_STEPS_NM, rwrDeclutter } from '../src/hud/cockpit/pages';
import { NM } from '../src/core/math';

installPath2D();

function rig(scene: Scenario, view: CameraMode, W = 844, H = 390) {
  const mock = buildMock(scene);
  const { canvas, ctx: fake } = makeFakeCanvas(W, H, 1);
  const hud = createHud(canvas, mock.events);
  hud.resize(W, H, 1);
  hud.setVisible(view !== 'tactical');
  const camera = new PerspectiveCamera(60, W / H, 0.5, 60_000);
  const p = mock.player;
  if (view === 'cockpit' || view === 'hud') {
    camera.position.set(0, 1.02, -3.52).applyQuaternion(p.quaternion).add(p.position);
    camera.quaternion.copy(p.quaternion);
  } else {
    camera.position.copy(p.position).add(new Vector3(0, 4.5, 20).applyQuaternion(p.quaternion));
    camera.up.set(0, 1, 0).applyQuaternion(p.quaternion);
    camera.lookAt(p.position.clone().add(new Vector3(0, 0, -40).applyQuaternion(p.quaternion)));
  }
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
  return {
    hud,
    fake,
    mock,
    ctx,
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

/** Pairs of HUD texts whose boxes overlap (texts on the same baseline row of one block are one line). */
function textOverlaps(texts: TextRec[], pad = 1.5): string[] {
  const out: string[] = [];
  const boxes: Box[] = texts.map(textBox);
  for (let i = 0; i < texts.length; i++) {
    for (let j = i + 1; j < texts.length; j++) {
      const a = texts[i];
      const b = texts[j];
      if (!a.text.trim() || !b.text.trim()) continue;
      if (overlaps(boxes[i], boxes[j], pad)) out.push(`"${a.text}"@${a.x | 0},${a.y | 0} x "${b.text}"@${b.x | 0},${b.y | 0}`);
    }
  }
  return out;
}

describe('i2: no text-on-text overlaps in the combat lab scenes', () => {
  for (const scene of ['threat', 'gun', 'lock', 'aa'] as Scenario[]) {
    for (const view of ['hud', 'cockpit', 'chase'] as CameraMode[]) {
      it(`${scene} / ${view}`, () => {
        const r = rig(scene, view);
        r.run(1.2);
        const texts = r.run(1 / 30);
        expect(texts.length).toBeGreaterThan(8);
        const bad = textOverlaps(texts);
        expect(bad, bad.join('\n')).toEqual([]);
      });
    }
  }

  it('threat: the SPIKE / FLARES LOW chips are drawn at full strength (never dimmed under a bandit)', () => {
    for (const view of ['hud', 'cockpit', 'chase'] as CameraMode[]) {
      const r = rig('threat', view);
      r.run(1.2);
      const texts = r.run(1 / 30);
      const chips = texts.filter((t) => /SPIKE|FLARES LOW/.test(t.text));
      expect(chips.length, view).toBeGreaterThan(0);
      for (const c of chips) expect(c.alpha, `${view} ${c.text}`).toBeGreaterThan(0.95);
    }
  });

  it('no pitch-ladder numeral / label ever prints inside the heading-tape band (hud view)', () => {
    const r = rig('aa', 'hud');
    r.run(1.0);
    const L = computeLayout(makeLayout(), 844, 390, { top: 0, right: 0, bottom: 0, left: 0 }, Math.tan((60 * Math.PI) / 360), false);
    const band: Box = { x0: L.cx - L.tapeHalfW - 8, y0: L.tapeY, x1: L.cx + L.tapeHalfW + 8, y1: L.tapeY + 58 * L.u };
    // pitch the nose up 12°: the +20 / +25 rungs would otherwise ride up onto the tape
    r.mock.player.quaternion.multiply(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), 0.21));
    r.mock.player.velocity.set(0, 0, -250).applyQuaternion(r.mock.player.quaternion);
    const texts = r.run(1 / 30);
    const tapeTexts = /^(\d\d|N|E|S|W|\d{3})$/;
    // …and the NEXT slot beside the heading box: the steering waypoint's name and distance when its
    // diamond has no room for them (playtest 2.2-1)
    const next = (r.mock.mission.currentWaypoint?.label ?? '').toUpperCase();
    for (const t of texts) {
      if (!overlaps(textBox(t), band)) continue;
      // only the tape's own numerals / heading box live there
      expect(tapeTexts.test(t.text) || t.text === next || /^\d+(\.\d)? NM$/.test(t.text), `"${t.text}" in the tape band`).toBe(true);
    }
  });
});

describe('i2: fixed-zone occupancy + text placement units', () => {
  it('occupancy level filter: the FPM (level 2) does not knock out the ladder, text (0) and the target box (1) do', () => {
    const o = new Occupancy(8);
    o.add(0, 0, 10, 10, 2);
    expect(o.hits(5, 5, 6, 6, 0, 1)).toBe(false);
    expect(o.hits(5, 5, 6, 6, 1)).toBe(true); // still protected from text placers
    o.add(20, 0, 30, 10, 0);
    o.add(40, 0, 50, 10, 1);
    expect(o.hits(25, 5, 26, 6, 0, 1)).toBe(true);
    expect(o.hits(45, 5, 46, 6, 0, 1)).toBe(true);
  });

  it('cockpit view: radio subtitles sit in the left column; the warning band keeps the HMD slot', () => {
    const noSafe = { top: 0, right: 0, bottom: 0, left: 0 };
    const tan = Math.tan((60 * Math.PI) / 360);
    const hud = computeLayout(makeLayout(), 844, 390, noSafe, tan, false);
    const ck = computeLayout(makeLayout(), 844, 390, noSafe, tan, true);
    expect(ck.radioTop).toBe(true);
    expect(ck.warnY).toBe(hud.warnY);
    expect(ck.radioX1).toBeLessThan(ck.cx - ck.tapeHalfW);
    expect(ck.warnY).toBeLessThan(110);
  });
});

describe('i2: TSD range, RWR declutter, tactical legend', () => {
  it('TSD steps include 5 and 10 NM: a close fight is not squeezed into 20 NM', () => {
    expect(TSD_STEPS_NM[0]).toBe(5);
    expect(autoTsdRange(0, 7_000, TSD_STEPS_NM) / NM).toBe(5);
    expect(autoTsdRange(0, 15_000, TSD_STEPS_NM) / NM).toBe(10);
    expect(autoTsdRange(0, 60_000, TSD_STEPS_NM) / NM).toBe(40);
  });

  it('RWR: co-bearing emitters ("29" and "10" at 2° apart) are offset radially instead of merging', () => {
    const R = 200;
    const bs = new Float32Array(4);
    const rs = new Float32Array(4);
    bs[0] = 0.8;
    rs[0] = 120;
    const r2 = rwrDeclutter(0.8 + (2 * Math.PI) / 180, 120, R, 1, bs, rs);
    const dx = Math.sin(0.835) * r2 - Math.sin(0.8) * 120;
    const dy = Math.cos(0.835) * r2 - Math.cos(0.8) * 120;
    expect(Math.hypot(dx, dy)).toBeGreaterThanOrEqual(36);
    expect(r2).toBeGreaterThanOrEqual(R * 0.2);
    expect(r2).toBeLessThanOrEqual(R * 0.95);
    // far apart: untouched
    expect(rwrDeclutter(2.5, 120, R, 1, bs, rs)).toBe(120);
  });

  it('tactical legend: open for 5 s on entry, then collapsed; tapping the chip toggles it', () => {
    const tm = new TacMapState();
    tm.legendUntil = 10 + LEGEND_SHOW;
    expect(tm.legendOpen(11)).toBe(true);
    expect(tm.legendOpen(10 + LEGEND_SHOW + 0.1)).toBe(false);
    Object.assign(tm.legendRect, { x: 10, y: 10, w: 110, h: 22 });
    expect(tm.tapLegend(400, 200, 20)).toBe(false);
    expect(tm.tapLegend(30, 20, 20)).toBe(true);
    expect(tm.legendOpen(20)).toBe(true);
    expect(tm.tapLegend(30, 20, 21)).toBe(true);
    expect(tm.legendOpen(21)).toBe(false);
  });

  it('tactical view in free flight names the sights and suburbs; a combat mission keeps the sparse chart (playtest 1.1-c)', () => {
    const names = (free: boolean) => {
      const r = rig('aa', 'tactical');
      const m = r.mock.mission as unknown as { def?: { script: { freeFlight?: boolean } } };
      m.def = { ...(m.def ?? {}), script: { ...(m.def?.script ?? {}), freeFlight: free } } as typeof m.def;
      r.mock.player.position.set(1000, 3000, 1000);
      return r.run(0.2).map((t) => t.text);
    };
    const free = names(true);
    // (at the 20 km scale the centre names give way to the map's symbols: the suburbs show)
    const sights = ['SKY TOWER', 'HARBOUR BRIDGE', 'EDEN PARK', 'MT EDEN', 'PONSONBY', 'PARNELL', 'MUSEUM', 'ST HELIERS', 'MT ALBERT', 'OTAHUHU', 'HOBSONVILLE', 'LONG BAY', 'MURIWAI', 'BEACHLANDS'];
    expect(free.filter((t) => sights.includes(t)).length).toBeGreaterThanOrEqual(3);
    expect(names(false).some((t) => sights.includes(t))).toBe(false);
  });

  it('tactical view: the legend collapses after 5 s and the objectives list leaves the map', () => {
    const r = rig('aa', 'tactical');
    let texts = r.run(1);
    expect(texts.some((t) => /^TACTICAL MAP/.test(t.text))).toBe(true);
    expect(texts.some((t) => t.text === 'OBJECTIVES')).toBe(true);
    texts = r.run(LEGEND_SHOW + 0.5);
    expect(texts.some((t) => /^TACTICAL MAP/.test(t.text))).toBe(false);
    expect(texts.some((t) => /^MAP \d+ KM$/.test(t.text))).toBe(true);
    expect(texts.some((t) => t.text === 'OBJECTIVES')).toBe(false);
    // tap the 'i' chip: legend back
    expect(r.hud.pick(20, 20)).toBeNull();
    texts = r.run(1 / 30);
    expect(texts.some((t) => /^TACTICAL MAP/.test(t.text))).toBe(true);
  });
});
