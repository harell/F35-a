import { describe, expect, it } from 'vitest';
import { computeTouchLayout, inRect, rectsOverlap, type ButtonId, type Rect } from '../src/input/touch/layout';

const NO_SAFE = { top: 0, right: 0, bottom: 0, left: 0 };
const NOTCH = { top: 0, right: 47, bottom: 21, left: 47 };
const SCREENS: [number, number, typeof NO_SAFE][] = [
  [844, 390, NO_SAFE],
  [844, 390, NOTCH],
  [667, 375, NO_SAFE],
  [932, 430, NOTCH],
  [1280, 720, NO_SAFE],
  [1024, 768, NO_SAFE],
];

const inside = (r: Rect, W: number, H: number) => r.x >= 0 && r.y >= 0 && r.x + r.w <= W && r.y + r.h <= H;

describe('touch layout', () => {
  for (const [W, H, safe] of SCREENS) {
    for (const leftHanded of [false, true]) {
      const tag = `${W}×${H}${safe === NOTCH ? ' notch' : ''}${leftHanded ? ' left-handed' : ''}`;
      const L = computeTouchLayout(W, H, safe, { leftHanded });
      const ids = (Object.keys(L.buttons) as ButtonId[]).filter((b) => b !== 'recenter');

      it(`${tag}: everything on screen and inside the safe area`, () => {
        for (const id of ids) {
          const r = L.buttons[id];
          expect(inside(r, W, H), id).toBe(true);
          expect(r.x, id).toBeGreaterThanOrEqual(safe.left);
          expect(r.x + r.w, id).toBeLessThanOrEqual(W - safe.right);
        }
        expect(inside(L.throttle, W, H)).toBe(true);
      });

      it(`${tag}: controls never overlap each other`, () => {
        const all: [string, Rect][] = [...ids.map((id) => [id, L.buttons[id]] as [string, Rect]), ['throttle', L.throttle]];
        for (let i = 0; i < all.length; i++)
          for (let j = i + 1; j < all.length; j++) expect(rectsOverlap(all[i][1], all[j][1]), `${all[i][0]} vs ${all[j][0]}`).toBe(false);
      });

      it(`${tag}: thumb buttons are big enough`, () => {
        for (const id of ['fire', 'gun', 'cms', 'cam', 'tgt', 'wpn'] as const) expect(Math.min(L.buttons[id].w, L.buttons[id].h), id).toBeGreaterThanOrEqual(48);
        expect(L.buttons.fire.w).toBeGreaterThanOrEqual(56);
        expect(L.throttle.h).toBeGreaterThanOrEqual(120);
      });

      it(`${tag}: the centre of the view stays free`, () => {
        const centre: Rect = { x: W * 0.3, y: H * 0.15, w: W * 0.4, h: H * 0.55 };
        for (const id of ids) expect(rectsOverlap(L.buttons[id], centre), id).toBe(false);
        expect(rectsOverlap(L.throttle, centre)).toBe(false);
        expect(inRect(L.stickZone, W / 2, H / 2)).toBe(false);
      });

      it(`${tag}: stick zone is on the opposite side of the throttle`, () => {
        const zoneCx = L.stickZone.x + L.stickZone.w / 2;
        const thrCx = L.throttle.x + L.throttle.w / 2;
        if (leftHanded) {
          expect(zoneCx).toBeLessThan(W / 2);
          expect(thrCx).toBeGreaterThan(W / 2);
        } else {
          expect(zoneCx).toBeGreaterThan(W / 2);
          expect(thrCx).toBeLessThan(W / 2);
        }
        expect(inRect(L.stickZone, L.stickHome.x, L.stickHome.y)).toBe(true);
      });
    }
  }

  it('weapon buttons sit next to the throttle (left thumb) in the default layout', () => {
    const L = computeTouchLayout(844, 390, NO_SAFE, { leftHanded: false });
    for (const id of ['fire', 'gun', 'cms'] as const) expect(L.buttons[id].x + L.buttons[id].w).toBeLessThan(844 * 0.3);
    // the button column is on the right edge (where the HMD expects it)
    for (const id of ['pause', 'cam', 'tgt', 'wpn', 'radar'] as const) expect(L.buttons[id].x).toBeGreaterThan(844 - 80);
  });
});

describe('left-handed layout keeps the PCD / RWR clear (i1 regression)', () => {
  for (const [W, H, safe] of SCREENS) {
    it(`${W}×${H}: CMS sits in the right button column, below RADAR`, () => {
      const L = computeTouchLayout(W, H, safe, { leftHanded: true });
      const cms = L.buttons.cms;
      const radar = L.buttons.radar;
      // same column as the other right-edge buttons (was left of FIRE, over the PCD's right portal)
      expect(cms.x).toBeGreaterThanOrEqual(radar.x - 2);
      expect(cms.x + cms.w).toBeLessThanOrEqual(W - safe.right);
      expect(cms.y).toBeGreaterThanOrEqual(radar.y + radar.h);
      // the whole weapon cluster stays inside the right 40 % of the screen (the PCD's centre and
      // left/RWR portal are free)
      for (const id of ['fire', 'gun', 'cms'] as const) expect(L.buttons[id].x, id).toBeGreaterThan(W * 0.6 - 40);
      expect(L.throttle.x).toBeGreaterThan(W * 0.6);
    });
  }
});
