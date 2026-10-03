/**
 * Suburb and island names on the briefing map (#129): the baked LINZ names and the chooser that
 * places them as the lowest-priority labels.
 */
import { describe, expect, it } from 'vitest';
import { AUCKLAND_PLACES } from '../src/ui/art/aucklandPlaces';
import { choosePlaceNames, type ScreenBox } from '../src/ui/screens/placeNames';
import { fitIntelView, intelBounds } from '../src/ui/screens/intelMap';
import { missionById } from '../src/missions';

const W = 844;
const H = 390;
/** Monospace-ish width: 6.2 px a character at 11 px. */
const measure = (t: string) => t.length * 6.2;
const place = (name: string) => AUCKLAND_PLACES.find((p) => p[0] === name)!;

function view(cx: number, cz: number, span: number) {
  const v = fitIntelView({ minX: cx - span / 2, maxX: cx + span / 2, minZ: cz - span / 2, maxZ: cz + span / 2 } as never, W, H);
  return { X: (x: number) => (x - v.x0) * v.scale, Y: (z: number) => (z - v.z0) * v.scale };
}

const overlaps = (a: ScreenBox, b: ScreenBox) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

describe('the baked LINZ place names', () => {
  it('has the suburbs and gulf islands a New Zealander looks for, with their macrons', () => {
    for (const n of ['Devonport', 'Newmarket', 'Te Atatū Peninsula', 'Ōrākei', 'Ōtāhuhu', 'Māngere', 'Rangitoto Island', 'Motutapu Island', 'Waiheke Island']) {
      expect(place(n), n).toBeTruthy();
    }
    expect(place('Rangitoto Island')[1]).toBe('island');
    expect(place('Devonport')[4]).toBeGreaterThan(5000);
  });
  it("Devonport's label point is on the peninsula (pole of inaccessibility, not a centroid in the harbour)", () => {
    const [, , x, z] = place('Devonport');
    // the peninsula is about 2–4 km east and 1.5–3 km north of the Sky Tower
    expect(x).toBeGreaterThan(2000);
    expect(x).toBeLessThan(4500);
    expect(z).toBeLessThan(-1500);
    expect(z).toBeGreaterThan(-3500);
  });
});

describe('choosePlaceNames', () => {
  it('a strike on Newmarket shows "Newmarket", even at a wide zoom with bigger suburbs about', () => {
    const [, , x, z] = place('Newmarket');
    const v = view(0, 0, 40_000);
    const names = choosePlaceNames({ w: W, h: H, ...v, anchors: [{ x, z }], blocked: [], measure, size: 11 });
    expect(names.map((n) => n.name)).toContain('Newmarket');
    expect(names[0].name).toBe('Newmarket');
  });

  it('no name overlaps a blocked box (a marker or label) or another name, and all stay on the canvas', () => {
    const v = view(0, 0, 24_000);
    const blocked: ScreenBox[] = [
      { x: 400, y: 180, w: 120, h: 20 },
      { x: 300, y: 100, w: 14, h: 14 },
    ];
    const names = choosePlaceNames({ w: W, h: H, ...v, anchors: [{ x: 0, z: 0 }], blocked, measure, size: 11 });
    expect(names.length).toBeGreaterThan(8);
    for (const n of names) {
      expect(n.x).toBeGreaterThanOrEqual(2);
      expect(n.y).toBeGreaterThanOrEqual(2);
      expect(n.x + n.w).toBeLessThanOrEqual(W - 2);
      expect(n.y + n.h).toBeLessThanOrEqual(H - 2);
      for (const b of blocked) expect(overlaps(n, b), `${n.name} over a blocked box`).toBe(false);
      for (const o of names) if (o !== n) expect(overlaps(n, o), `${n.name} over ${o.name}`).toBe(false);
    }
    expect(new Set(names.map((n) => n.name)).size).toBe(names.length);
  });

  it('a Hauraki Gulf view names the islands', () => {
    const m = missionById('g02');
    expect(m).toBeTruthy();
    const v = fitIntelView(intelBounds(m!), W, H);
    const X = (x: number) => (x - v.x0) * v.scale;
    const Y = (z: number) => (z - v.z0) * v.scale;
    const anchors = m!.intel.map((i) => ({ x: i.x, z: i.z }));
    const names = choosePlaceNames({ w: W, h: H, X, Y, anchors, blocked: [], measure, size: 11 }).map((n) => n.name);
    expect(names.some((n) => /Rangitoto|Motutapu|Waiheke|Motuihe|Rakino|Browns/.test(n))).toBe(true);
  });
});
