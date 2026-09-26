/**
 * Unit tests for the i1 HUD building blocks: fixed text zones vs the live touch layout, the cockpit
 * PCD placement, the occupancy (text de-collision) registry, missile-defeat tracking, the PCD zoom state
 * and the tactical-map range state / projection.
 */
import { describe, expect, it } from 'vitest';
import { computeLayout, makeLayout } from '../src/hud/hmd/layout';
import { computeTouchLayout } from '../src/input/touch/layout';
import { pcdScreenRect, PCD } from '../src/hud/cockpit/geometry';
import { PCD_H, PCD_W } from '../src/hud/cockpit/pcd';
import { Occupancy } from '../src/hud/hmd/occupancy';
import { DEFEAT_CONFIRM, ThreatTracker } from '../src/hud/hmd/threatTracker';
import { PcdZoomState } from '../src/hud/cockpit/zoom';
import { TAC_SCALES_KM, TacMapState, tacProject } from '../src/hud/hmd/tacmap';

const noSafe = { top: 0, right: 0, bottom: 0, left: 0 };
const tan30 = Math.tan(Math.PI / 6);

describe('fixed text zones', () => {
  for (const [W, H] of [
    [844, 390],
    [667, 375],
    [1280, 720],
  ] as const) {
    it(`${W}x${H}: warning band above the FPM band, cue + message below it, radio between the thumbs`, () => {
      for (const cockpit of [false, true]) {
        const L = computeLayout(makeLayout(), W, H, noSafe, tan30, cockpit);
        // band order top → bottom, nothing in the middle of the screen except the FPM
        expect(L.tapeY).toBeLessThan(L.warnY);
        expect(L.warnY).toBeLessThan(L.row2Y);
        expect(L.row2Y + 12 * L.u).toBeLessThan(L.cy - 20 * L.u);
        expect(L.cueY).toBeGreaterThan(L.cy + 20 * L.u);
        expect(L.msgY).toBeGreaterThan(L.cueY);
        if (cockpit) {
          // radio at the top (never over the PCD), the centre slot stays above the glare shield
          expect(L.radioTop).toBe(true);
          expect(L.radioY + 2 * 15 * L.u + 8 * L.u).toBeLessThan(L.warnY - 8 * L.u);
          expect(L.msgY + 10 * L.u).toBeLessThanOrEqual(L.cockpitTop);
        } else {
          const t = computeTouchLayout(W, H, noSafe, { leftHanded: false });
          const b = t.buttons;
          // radio band between the throttle cluster (incl. CMS) and the stick
          expect(L.radioX0).toBeGreaterThanOrEqual(b.cms.x + b.cms.w);
          expect(L.radioX1).toBeLessThanOrEqual(t.stickHome.x - t.stickRadius);
          expect(L.radioY).toBeLessThanOrEqual(H);
        }
      }
    });
  }

  it('left-handed: the radio band follows the mirrored controls', () => {
    const L = computeLayout(makeLayout(), 844, 390, noSafe, tan30, false, { leftHanded: true });
    const t = computeTouchLayout(844, 390, noSafe, { leftHanded: true });
    expect(L.radioX0).toBeGreaterThanOrEqual(t.stickHome.x + t.stickRadius);
    expect(L.radioX1).toBeLessThanOrEqual(t.buttons.cms.x);
  });

  it('external views keep the centre slot above the jet and the rows under the missile-cam labels', () => {
    const L = computeLayout(makeLayout(), 844, 390, noSafe, tan30, false, { external: true });
    expect(L.warnY).toBeGreaterThan(L.tapeY + 64 * L.u); // missile-cam lines end at tapeY + 64
    expect(L.msgY).toBeLessThan(L.cy);
  });
});

describe('cockpit PCD placement (i1-pres-c01-cockpit-t12: only the title row was visible)', () => {
  it('shows ≥ 60 % of the PCD at the default head pose on an 844x390 phone, 60° FOV', () => {
    const r = pcdScreenRect(60, 844, 390);
    expect(r.visible).toBeGreaterThan(0.6);
    expect(r.top).toBeLessThan(390 * 0.75);
  });
  it('sits between the throttle cluster and the stick (right-handed 844x390)', () => {
    const r = pcdScreenRect(60, 844, 390);
    const t = computeTouchLayout(844, 390, noSafe, { leftHanded: false });
    const cmsRight = t.buttons.cms.x + t.buttons.cms.w;
    expect(r.left).toBeGreaterThan(cmsRight - 4);
    expect(r.right).toBeLessThan(t.stickHome.x - t.stickRadius + 8);
  });
  it('texture follows the panel aspect (no stretched texels) and is legible: ≥ 0.4 CSS px per texel', () => {
    expect(PCD_W / PCD_H).toBeCloseTo(PCD.width / PCD.height, 1);
    const r = pcdScreenRect(60, 844, 390);
    expect((r.right - r.left) / PCD_W).toBeGreaterThan(0.4);
  });
});

describe('occupancy (text de-collision)', () => {
  it('finds the nearest free slot and honours protected levels', () => {
    const o = new Occupancy();
    o.add(100, 100, 200, 140, 1); // protected (e.g. target box)
    o.add(100, 150, 200, 160); // label
    expect(o.hits(120, 130, 180, 150)).toBe(true);
    expect(o.hits(120, 145, 180, 149)).toBe(false);
    expect(o.hits(120, 150, 180, 155, 1)).toBe(false); // only a label there
    // preferred top 110 (h 20) collides → next free going down is below the label
    const y = o.freeY(120, 180, 20, 110, 90, 260, 'down');
    expect(y).toBeGreaterThanOrEqual(160);
    expect(o.freeY(120, 180, 20, 110, 60, 150, 'down')).toBeLessThanOrEqual(80); // no room below → above
    expect(o.freeY(120, 180, 20, 110, 90, 150, 'down')).toBeNaN(); // nowhere
    o.clear();
    expect(o.count).toBe(0);
    expect(o.freeY(0, 10, 10, 50, 0, 100)).toBe(50);
  });
});

describe('missile defeat tracking', () => {
  const alive = new Set<number>();
  const isAlive = (id: number) => alive.has(id);

  it('reports a missile that ends decoyed / self-destructs, never one that hits', () => {
    const t = new ThreatTracker();
    alive.clear();
    alive.add(1).add(2);
    t.update([{ missileId: 1, bearing: 0.5 }, { missileId: 2, bearing: -1 }], isAlive, 0.1);
    t.onMunitionEnd(1, 7, 'decoyed', 7);
    expect(t.showing).toBe(true);
    expect(t.defeatedCount).toBe(1);
    expect(t.marks.some((m) => m.active && Math.abs(m.bearing - 0.5) < 1e-6)).toBe(true);
    // missile 2 hits us: no defeat
    t.onMunitionEnd(2, 7, 'proximity', 7);
    expect(t.defeatedCount).toBe(1);
    // an end aimed at someone else is ignored
    t.onMunitionEnd(3, 99, 'selfdestruct', 7);
    expect(t.defeatedCount).toBe(1);
    // a missile never shown on the warning is not announced
    t.onMunitionEnd(4, 7, 'selfdestruct', 7);
    expect(t.defeatedCount).toBe(1);
  });

  it('reports a still-flying missile that drops off the list after the debounce, not if it comes back', () => {
    const t = new ThreatTracker();
    alive.clear();
    alive.add(5);
    t.update([{ missileId: 5, bearing: 0 }], isAlive, 0.1, () => 3000);
    t.update([], isAlive, DEFEAT_CONFIRM * 0.4, () => 3000);
    t.update([{ missileId: 5, bearing: 0 }], isAlive, 0.1, () => 3000); // re-acquired
    t.update([], isAlive, DEFEAT_CONFIRM * 0.4, () => 3000);
    expect(t.defeatedCount).toBe(0);
    t.update([], isAlive, DEFEAT_CONFIRM, () => 3000);
    expect(t.defeatedCount).toBe(1);
    // leaving MAWS range (outrun) is not a defeat
    alive.add(6);
    t.update([{ missileId: 6, bearing: 0 }], isAlive, 0.1, () => 14_500);
    t.update([], isAlive, 1, () => 16_000);
    expect(t.defeatedCount).toBe(1);
  });
});

describe('PCD zoom state', () => {
  it('opens a portal, lays out tabs, maps taps to tabs and closes', () => {
    const z = new PcdZoomState();
    expect(z.open).toBe(false);
    z.openPortal(0, ['SMS', 'FUEL', 'ENG', 'ICAWS'], 1);
    expect(z.open).toBe(true);
    expect(z.page).toBe('FUEL');
    // before the HUD laid it out no tab can be hit
    expect(z.tabAt(10, 10)).toBe(-1);
    z.tabCount = 2;
    Object.assign(z.tabs[0], { x: 0, y: 300, w: 50, h: 30 });
    Object.assign(z.tabs[1], { x: 50, y: 300, w: 50, h: 30 });
    expect(z.tabAt(75, 310)).toBe(1);
    expect(z.tabAt(75, 200)).toBe(-1);
    z.close();
    expect(z.open).toBe(false);
    expect(z.page).toBeNull();
  });
});

describe('tactical map state', () => {
  it('cycles 10 / 20 / 40 km on taps and fits the fight automatically until the player picks', () => {
    const tm = new TacMapState();
    expect(TAC_SCALES_KM).toEqual([10, 20, 40]);
    tm.fit(8_000);
    expect(tm.rangeKm).toBe(10);
    tm.fit(33_000);
    expect(tm.rangeKm).toBe(40);
    expect(tm.cycle()).toBe(10);
    expect(tm.auto).toBe(false);
    expect(tm.cycle()).toBe(20);
    expect(tm.cycle()).toBe(40);
  });
  it('projects north-up: north is up, east is right, scale = px per metre', () => {
    const v = { cx: 400, cy: 200, ox: 1000, oz: -2000, k: 0.01, R: 180 };
    const out = { x: 0, y: 0 };
    tacProject(v, 1000, -2000 - 5000, out); // 5 km north
    expect(out.x).toBeCloseTo(400);
    expect(out.y).toBeCloseTo(150);
    tacProject(v, 1000 + 3000, -2000, out); // 3 km east
    expect(out.x).toBeCloseTo(430);
    expect(out.y).toBeCloseTo(200);
  });
});
