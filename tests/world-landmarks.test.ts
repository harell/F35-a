/**
 * Hand-placed Auckland positions against the real LINZ coastline (issue #3): the landmarks of
 * src/core/auckland.ts, the named mission positions derived from them (missions/content/common.ts P)
 * and the hand-traced road polylines (scenery/motorways.ts). Signed coast distance: + land, − water.
 * tools/linz/landmarks.ts prints the same measurements and suggests the nearest point with a margin.
 */
import { describe, expect, it } from 'vitest';
import { AKL, AKL_LANDMARKS, BRIDGE_SPAN_T, geoToWorld } from '../src/core/auckland';
import { segmentDistance } from '../src/world/terrain/coastline';
import { aucklandMapData } from '../src/world/terrain/theaters/auckland';
import { HAND_ARTERIALS, HAND_MOTORWAYS } from '../src/world/scenery/motorways';
import { P } from '../src/missions/content/common';

const map = aucklandMapData();
const coastDist = (x: number, z: number) => (map.isLand(x, z) ? 1 : -1) * segmentDistance(map.segments, x, z);
/** Land margin (m) for every landmark and position that is not on the shore or in the water. */
const MARGIN = 50;

it('runs on the real LINZ coastline', () => {
  expect(map.linz).not.toBeNull();
});

describe('landmarks (src/core/auckland.ts)', () => {
  it(`are on land with ≥ ${MARGIN} m to spare unless whitelisted as water or shore`, () => {
    for (const l of AKL_LANDMARKS) {
      const p = geoToWorld(l.lat, l.lon);
      const d = coastDist(p.x, p.z);
      if (l.site === 'water') expect(d, l.id).toBeLessThan(0);
      else if (l.site === 'shore') expect(d, l.id).toBeGreaterThan(0);
      else expect(d, l.id).toBeGreaterThanOrEqual(MARGIN);
    }
  });

  it('the whitelist stays short: only the bridge abutments, the crater lake, a marina basin and a river mouth', () => {
    const listed = AKL_LANDMARKS.filter((l) => l.site).map((l) => `${l.id}:${l.site}`);
    expect(listed.sort()).toEqual(['bridge_n:shore', 'bridge_s:shore', 'pupuke:water', 'tamaki_mouth:water', 'westhaven:water']);
  });

  it('the coastal places sit just inland of their coast (within 1.5 km)', () => {
    for (const l of AKL_LANDMARKS.filter((m) => m.kind === 'coast' && !m.site)) {
      const p = geoToWorld(l.lat, l.lon);
      expect(coastDist(p.x, p.z), l.id).toBeLessThan(1500);
    }
  });

  it('the Whangaparāoa tip is at Whangaparāoa Head, not in the Gulf between the peninsula and Tiritiri Matangi', () => {
    const tip = AKL.whangaparaoa;
    expect(coastDist(tip.x, tip.z)).toBeGreaterThan(100);
    // …and it is the tip: nothing but water 1.5 km further east
    for (let dz = -1000; dz <= 1000; dz += 250) expect(map.isLand(tip.x + 1500, tip.z + dz), `dz ${dz}`).toBe(false);
  });
});

describe('Harbour Bridge', () => {
  const S = AKL.bridge_s;
  const N = AKL.bridge_n;
  const len = Math.hypot(N.x - S.x, N.z - S.z);
  const at = (t: number) => ({ x: S.x + (N.x - S.x) * t, z: S.z + (N.z - S.z) * t });

  it('both abutments sit on the shore (on land, within 60 m of the waterline)', () => {
    for (const [id, p] of [['bridge_s', S], ['bridge_n', N]] as const) {
      const d = coastDist(p.x, p.z);
      expect(d, id).toBeGreaterThan(5);
      expect(d, id).toBeLessThan(60);
    }
  });

  it('the deck crosses open water from shore to shore, about 1,020 m long', () => {
    expect(len).toBeGreaterThan(990);
    expect(len).toBeLessThan(1050);
    for (let t = 0.06; t <= 0.94; t += 0.02) expect(coastDist(at(t).x, at(t).z), `t ${t.toFixed(2)}`).toBeLessThan(0);
    // the navigation span is mid-harbour
    expect(coastDist(at(BRIDGE_SPAN_T).x, at(BRIDGE_SPAN_T).z)).toBeLessThan(-150);
  });

  it('the mission points are derived from it: P.harbourBridge is under the navigation span', () => {
    expect(P.bridgeS).toEqual({ x: Math.round(S.x), z: Math.round(S.z) });
    expect(P.bridgeN).toEqual({ x: Math.round(N.x), z: Math.round(N.z) });
    const span = at(BRIDGE_SPAN_T);
    expect(Math.hypot(P.harbourBridge.x - span.x, P.harbourBridge.z - span.z)).toBeLessThan(1);
  });

  it('the hand-traced SH1 (no-LINZ fallback) starts at the abutments', () => {
    for (const [name, end] of [['SH1 CBD', S], ['SH1 North Shore', N]] as const) {
      const [lat, lon] = HAND_MOTORWAYS.find((m) => m.name === name)!.ll[0];
      const p = geoToWorld(lat, lon);
      expect(Math.hypot(p.x - end.x, p.z - end.z), name).toBeLessThan(5);
    }
  });
});

describe('named mission positions (missions/content/common.ts P)', () => {
  const WATER = new Set(['harbourBridge', 'gulfNE', 'gulfN', 'channel', 'strait']);

  it(`land positions have ≥ ${MARGIN} m to spare, open-water ones are in the water`, () => {
    for (const [k, p] of Object.entries(P)) {
      const d = coastDist(p.x, p.z);
      if (WATER.has(k)) expect(d, k).toBeLessThan(0);
      else if (k === 'bridgeS' || k === 'bridgeN') expect(d, k).toBeGreaterThan(0);
      else expect(d, k).toBeGreaterThanOrEqual(MARGIN);
    }
  });
});

describe('hand-traced roads (scenery/motorways.ts)', () => {
  it('every arterial vertex is on land with ≥ 30 m to spare (Onewa Rd started in Shoal Bay)', () => {
    for (const r of HAND_ARTERIALS)
      r.ll.forEach(([lat, lon], i) => {
        const p = geoToWorld(lat, lon);
        expect(coastDist(p.x, p.z), `${r.name} #${i}`).toBeGreaterThanOrEqual(30);
      });
  });

  it('motorway vertices are in the water only on the real crossings', () => {
    const CROSSINGS: Record<string, number[]> = {
      'SH16 Northwestern': [10, 11, 12, 13, 14], // the causeway from Waterview to Te Atatū
      'SH20 Southwestern': [11, 12], // Māngere Bridge
      'SH18 Upper Harbour': [6, 7], // Upper Harbour Bridge
    };
    for (const r of HAND_MOTORWAYS)
      r.ll.forEach(([lat, lon], i) => {
        if (CROSSINGS[r.name]?.includes(i)) return;
        const p = geoToWorld(lat, lon);
        expect(coastDist(p.x, p.z), `${r.name} #${i}`).toBeGreaterThan(0);
      });
  });
});
