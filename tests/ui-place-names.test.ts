/**
 * Suburb and island names on the briefing map (#129): the baked LINZ names and the chooser that
 * places them as the lowest-priority labels.
 */
import { describe, expect, it } from 'vitest';
import { AUCKLAND_PLACES } from '../src/ui/art/aucklandPlaces';
import { chartLabel, chooseChartNames, choosePlaceNames, isIsland, type ScreenBox } from '../src/ui/screens/placeNames';
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

describe('the main-menu chart names (#129, scope item 4)', () => {
  // the menu's 1280×720 view: ~62 km across, centred 2 km east and 6 km north of the Sky Tower
  const CW = 1280;
  const CH = 720;
  const scale = CW / 62; // px per km
  const X = (x: number) => (x / 1000 - (2 - CW / 2 / scale)) * scale;
  const Y = (z: number) => (z / 1000 - (-6 - CH / 2 / scale)) * scale;
  const chartMeasure = (t: string) => t.length * 7;
  const fixedAt = (text: string, x: number, z: number) => {
    const w = chartMeasure(text);
    return { text, x: X(x * 1000) - w / 2, y: Y(z * 1000) - 5, w, h: 10 };
  };
  const fixed = [fixedAt('HAURAKI GULF', 22, -18), fixedAt('AUCKLAND', 1.5, 2.4), fixedAt('WAIHEKE', 28, -9.8), fixedAt('WHENUAPAI', -11.6, -5.6)];
  const names = chooseChartNames({ w: CW, h: CH, X, Y, measure: chartMeasure, size: 9, fixed });
  const texts = names.map((n) => n.name);

  it('chart labels are upper case, the first of two names, without "Island"', () => {
    expect(chartLabel('Rangitoto Island')).toBe('RANGITOTO');
    expect(chartLabel('Browns Island (Motukorea)')).toBe('BROWNS');
    expect(chartLabel('Motuihe Island / Te Motu-a-Ihenga')).toBe('MOTUIHE');
    expect(chartLabel('Te Atatū Peninsula')).toBe('TE ATATŪ PENINSULA');
  });

  it('shows the gulf islands people know and the big suburbs, with macrons', () => {
    for (const n of ['RANGITOTO', 'MOTUTAPU', 'RĀKINO', 'MOUNT EDEN', 'HENDERSON']) expect(texts, n).toContain(n);
    expect(texts.some((t) => /[ĀĒĪŌŪ]/.test(t))).toBe(true);
  });

  it('ranks inhabited islands and suburbs above uninhabited islets', () => {
    // The Noises and Otata are uninhabited islets in the view; Rangitoto and Motutapu outrank them
    expect(texts.indexOf('RANGITOTO')).toBeLessThan(5);
    expect(texts).not.toContain('THE NOISES');
  });

  it('never repeats a fixed label, overlaps one, or overlaps another name', () => {
    for (const f of fixed) expect(texts).not.toContain(f.text);
    expect(texts).not.toContain('AUCKLAND CENTRAL');
    expect(new Set(texts).size).toBe(texts.length);
    for (const n of names) {
      for (const f of fixed) expect(overlaps(n, f), `${n.name} × ${f.text}`).toBe(false);
      for (const m of names) if (m !== n) expect(overlaps(n, m), `${n.name} × ${m.name}`).toBe(false);
      expect(n.x).toBeGreaterThanOrEqual(2);
      expect(n.x + n.w).toBeLessThanOrEqual(CW - 2);
    }
  });

  it('is sparser than a briefing map: about one name per 35,000 px²', () => {
    expect(names.length).toBeGreaterThan(8);
    expect(names.length).toBeLessThanOrEqual(Math.round((CW * CH) / 35_000));
  });
});

describe('isIsland', () => {
  it('counts islands the bake files as localities (Waiheke, Motutapu)', () => {
    expect(isIsland('Waiheke Island', place('Waiheke Island')[1])).toBe(true);
    expect(isIsland('Motutapu Island', 'locality')).toBe(true);
    expect(isIsland('Island Bay', 'suburb')).toBe(false);
    expect(isIsland('Devonport', 'suburb')).toBe(false);
  });
});
