import { describe, expect, it } from 'vitest';
import { NM } from '../src/core/math';
import { BUTTON_COLUMN, GLARE_LIP_ANGLE, THUMB_H, THUMB_W, computeLayout, makeLayout } from '../src/hud/hmd/layout';
import { autoTsdRange } from '../src/hud/hmd/tsd';
import { NumText, groupThousands, hmm, mmss, entityLabel, killText, WARNING_INFO } from '../src/hud/hmd/format';
import { AircraftEntity, SamSiteEntity, GroundTargetEntity } from '../src/sim/entities';

const W = 844;
const H = 390;
const tan30 = Math.tan(Math.PI / 6);

describe('hud layout (844x390 phone landscape)', () => {
  const noSafe = { top: 0, right: 0, bottom: 0, left: 0 };

  it('keeps the speed / altitude columns and DLZ out of the thumb zones and button column', () => {
    const L = computeLayout(makeLayout(), W, H, noSafe, tan30, true);
    const thumbLX = W * THUMB_W;
    const thumbRX = W * (1 - THUMB_W);
    const thumbY = H * (1 - THUMB_H);
    expect(L.spdRight - 60).toBeGreaterThan(thumbLX);
    expect(L.altLeft + 70).toBeLessThan(thumbRX);
    expect(L.dlzX).toBeLessThan(W - BUTTON_COLUMN);
    expect(L.dlzBottom).toBeLessThan(thumbY);
    // weapon block (4 lines) ends above the throttle zone
    expect(L.wpnY + 4 * L.line).toBeLessThanOrEqual(thumbY + 1);
    // kill feed right edge left of the button column
    expect(L.killX).toBeLessThanOrEqual(W - BUTTON_COLUMN);
  });

  it('places the cockpit top at the glare-shield lip and keeps the centre stack above it', () => {
    const L = computeLayout(makeLayout(), W, H, noSafe, tan30, true);
    const expected = H / 2 + (Math.tan(GLARE_LIP_ANGLE) / tan30) * (H / 2);
    expect(L.cockpitTop).toBeCloseTo(expected, 3);
    // lip lowered so ~60 % of the PCD is in view (i1): the outside view keeps ≥ 64 % of the height
    expect(L.cockpitTop / H).toBeGreaterThan(0.64);
    expect(L.cockpitTop / H).toBeLessThan(0.8);
    expect(L.stackY).toBeLessThan(L.cockpitTop - 30);
    const ext = computeLayout(makeLayout(), W, H, noSafe, tan30, false);
    expect(ext.cockpitTop).toBe(H);
  });

  it('respects safe-area insets (notch)', () => {
    const safe = { top: 0, right: 47, bottom: 21, left: 47 };
    const L = computeLayout(makeLayout(), W, H, safe, tan30, false);
    expect(L.left).toBeGreaterThanOrEqual(47);
    expect(L.objX).toBeGreaterThanOrEqual(47);
    expect(L.right).toBeLessThanOrEqual(W - 47 - BUTTON_COLUMN);
    expect(L.radioY).toBeLessThan(H - 21);
    expect(L.insetCx + L.insetR).toBeLessThanOrEqual(L.right + 1);
  });

  it('scales up on bigger screens', () => {
    const L = computeLayout(makeLayout(), 1280, 720, noSafe, tan30, false);
    expect(L.u).toBeGreaterThan(1.5);
  });
});

describe('hud TSD auto range', () => {
  it('fits the content with nm steps and hysteresis', () => {
    expect(autoTsdRange(0, 15 * NM) / NM).toBe(20);
    expect(autoTsdRange(0, 5 * NM) / NM).toBe(10);
    expect(autoTsdRange(0, 500 * NM) / NM).toBe(40);
    // stays at 40 while content still uses > 45 % of it
    expect(autoTsdRange(40 * NM, 19 * NM) / NM).toBe(40);
    // shrinks when content is small
    expect(autoTsdRange(40 * NM, 8 * NM) / NM).toBe(10);
  });
});

describe('hud formatting', () => {
  it('formats numbers and times', () => {
    expect(groupThousands(17060)).toBe('17,060');
    expect(groupThousands(-1250)).toBe('-1,250');
    expect(groupThousands(999)).toBe('999');
    expect(mmss(95)).toBe('1:35');
    expect(hmm(66 * 60 + 40)).toBe('1:07');
    const n = new NumText(1, 'M ');
    const a = n.get(0.841);
    expect(a).toBe('M 0.8');
    expect(n.get(0.84)).toBe(a); // cached instance for an unchanged rounded value
    expect(new NumText(0, '', '', false, 3).get(7)).toBe('007');
  });

  it('labels entities and kills', () => {
    expect(entityLabel(new AircraftEntity(1, 'mig29', 'red'))).toBe('MIG-29');
    expect(entityLabel(new SamSiteEntity(2, 'sa6', 'red'))).toBe('SA-6');
    expect(killText(new AircraftEntity(3, 'su35', 'red'))).toBe('SPLASH SU-35');
    expect(killText(new SamSiteEntity(4, 'sa15', 'red'))).toBe('SA-15 DESTROYED');
    expect(killText(new GroundTargetEntity(5, 'ship', 'red'))).toBe('SHIP DESTROYED');
    expect(WARNING_INFO.pull_up.level).toBe(2);
    expect(WARNING_INFO.bingo.label).toBe('BINGO');
  });
});
