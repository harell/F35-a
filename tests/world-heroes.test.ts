/**
 * The hero models measured from the LINZ 2024 LiDAR (tools/hero/): the Harbour Bridge (core/harbourBridge.ts,
 * world/scenery/harbourBridge.ts), the Ports of Auckland's cranes, masts and container stacks (core/portOfAuckland.ts,
 * world/scenery/aucklandPort.ts, aucklandSites.ts buildRealPort) and the Scene apartments on Beach Road
 * (core/sceneApartments.ts, aucklandBuildings.ts applyHeroBuildings): their measured numbers, where they stand in the
 * game, the meshes, and the sim's obstacles.
 */
import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { AKL, BRIDGE_PIERS_T, BRIDGE_SPAN_T } from '../src/core/auckland';
import { HB_MAIN, HB_PIERS, HB_S_NORTH, HB_S_SOUTH, hbChord, hbDeck, hbFrame, hbTrussDepth } from '../src/core/harbourBridge';
import { PORT_CRANES, PORT_MASTS } from '../src/core/portOfAuckland';
import { SCENE_OUTLINES, SCENE_TERRACES } from '../src/core/sceneApartments';
import { BuildingIndex, buildBuildingGeometry } from '../src/sim/buildings';
import { GeometryBuilder } from '../src/world/scenery/GeometryBuilder';
import { LightList } from '../src/world/scenery/builders';
import { buildHarbourBridge } from '../src/world/scenery/harbourBridge';
import { aucklandBuildings, ringArea } from '../src/world/scenery/aucklandBuildings';
import { aucklandPortStacks, decodePort } from '../src/world/scenery/aucklandPort';
import { buildRealPort, siteLayout } from '../src/world/scenery/aucklandSites';
import { PORT_BYTES, PORT_GZ } from './linz-setup';

const inRing = (r: ArrayLike<number>, x: number, z: number) => {
  let c = false;
  for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
    const xi = r[i], zi = r[i + 1], xj = r[j], zj = r[j + 1];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c;
  }
  return c;
};

describe('Auckland Harbour Bridge (measured)', () => {
  const S = AKL.bridge_s, N = AKL.bridge_n;
  const len = Math.hypot(N.x - S.x, N.z - S.z);

  it('stands on the game abutments line: both within 3 m of the pier line, the piers where the OSM fractions put them', () => {
    expect(Math.abs(hbFrame(S.x, S.z)[1])).toBeLessThan(3);
    expect(Math.abs(hbFrame(N.x, N.z)[1])).toBeLessThan(3);
    const s0 = hbFrame(S.x, S.z)[0];
    BRIDGE_PIERS_T.forEach((t, i) => expect(Math.abs(s0 + t * len - HB_PIERS[i])).toBeLessThan(3));
    // the navigation span's centre the missions and ferries use is the measured one
    expect(Math.abs(s0 + BRIDGE_SPAN_T * len - (HB_MAIN[0] + HB_MAIN[1]) / 2)).toBeLessThan(3);
    // abutments: the published spans from the first and last piers
    expect(HB_PIERS[0] - HB_S_SOUTH).toBeCloseTo(80.8, 0);
    expect(HB_S_NORTH - HB_PIERS[5]).toBeCloseTo(176.9, 0);
  });

  it('deck, truss and clearance at their LiDAR heights', () => {
    expect(hbDeck(-35)).toBeCloseTo(46.4, 0); // crest
    expect(hbDeck(-600)).toBeCloseTo(21.3, 0);
    expect(hbDeck(250)).toBeCloseTo(35.3, 0);
    expect(hbChord(-28)).toBeCloseTo(64.4, 0); // top of the truss
    expect(hbChord(-300)).toBe(-Infinity); // deck truss there: nothing above the road
    expect(hbChord(200)).toBe(-Infinity);
    // ≈ 43 m clearance at high tide under the main span; the missions' fly-under band tops out at 41 m
    const sm = (HB_MAIN[0] + HB_MAIN[1]) / 2;
    expect(hbDeck(sm) - hbTrussDepth(sm)).toBeGreaterThan(43);
  });

  it('builds one mesh on the measured profile, with lamps and the aviation light', () => {
    const B = new GeometryBuilder();
    const L = new LightList();
    buildHarbourBridge(B, L, () => 0);
    expect(B.triangleCount).toBeGreaterThan(8000);
    expect(B.triangleCount).toBeLessThan(60000);
    expect(L.count).toBeGreaterThan(50);
    const g = B.build()!;
    const p = g.getAttribute('position');
    let top = 0;
    for (let i = 0; i < p.count; i++) top = Math.max(top, p.getY(i));
    expect(top).toBeGreaterThan(72); // the flags
    expect(top).toBeLessThan(75);
    // the deck at mid-span is where the LiDAR has it: a vertex within 1 m of (sm, 0, 46.x)
    const sm = (HB_MAIN[0] + HB_MAIN[1]) / 2;
    let best = Infinity;
    for (let i = 0; i < p.count; i++) {
      const [s, t] = hbFrame(p.getX(i), p.getZ(i));
      if (Math.abs(s - sm) < 4 && Math.abs(Math.abs(t) - 17.6) < 0.2) best = Math.min(best, Math.abs(p.getY(i) - hbDeck(s)));
    }
    expect(best).toBeLessThan(0.5);
  });
});

describe('Ports of Auckland (measured)', () => {
  it('eight cranes at Fergusson: five on the west berth, the three 82 m ZPMC cranes on the north berth', () => {
    expect(PORT_CRANES).toHaveLength(8);
    const north = PORT_CRANES.filter((c) => c.uz < -0.9);
    expect(north).toHaveLength(3);
    for (const c of north) expect(c.apex).toBeCloseTo(82, 0);
    for (const c of PORT_CRANES.filter((c) => c.ux < -0.9)) {
      expect(c.girder).toBeGreaterThan(42);
      expect(c.girder).toBeLessThan(46);
    }
    expect(PORT_CRANES.filter((c) => c.boomTop !== null)).toHaveLength(3);
    expect(PORT_MASTS.length).toBe(60);
  });

  it('the baked stacks decode, small (≈ 55 kB) and on the port', () => {
    expect(PORT_GZ.length).toBeLessThan(80_000);
    const st = decodePort(PORT_BYTES);
    expect(st.length).toBeGreaterThan(4000);
    expect(aucklandPortStacks()).toHaveLength(st.length);
    const port = siteLayout()!.port;
    const on = st.filter((s) => port.some((r) => inRing(r.pts, s.x, s.z))).length;
    expect(on / st.length).toBeGreaterThan(0.98);
    for (const s of st) {
      expect(s.tiers).toBeGreaterThanOrEqual(1);
      expect(s.tiers).toBeLessThanOrEqual(6);
    }
    expect(() => decodePort(PORT_BYTES.subarray(0, PORT_BYTES.length - 5))).toThrow();
  });

  it('builds the port with the measured cranes and stacks (no generic Bledisloe cranes)', () => {
    const B = new GeometryBuilder();
    const L = new LightList();
    buildRealPort(B, L, () => 3.2, 1, siteLayout()!);
    const g = B.build()!;
    const p = g.getAttribute('position');
    // tall structure (> 40 m over the deck) only at Fergusson, where the cranes are
    const xs = PORT_CRANES.map((c) => c.x);
    for (let i = 0; i < p.count; i++) {
      if (p.getY(i) < 45 || p.getX(i) < 300) continue; // (west of the port: the CBD side)
      expect(p.getX(i)).toBeGreaterThan(Math.min(...xs) - 120);
    }
    expect(L.count).toBeGreaterThan(70); // 60 masts + crane beacons
  });

  it('the cranes are solid: flying through a portal hits it, and it stands', () => {
    const geo = buildBuildingGeometry(() => 3.2)!;
    const idx = new BuildingIndex(geo);
    const c = PORT_CRANES[1];
    const [x, z] = [c.x - c.ux * 18, c.z - c.uz * 18];
    const hit = idx.firstHit(new Vector3(x - c.uz * 80, 30, z + c.ux * 80), new Vector3(x + c.uz * 80, 30, z - c.ux * 80));
    expect(hit?.building.fixed).toBe(true);
    expect(hit?.building.id).toBeLessThan(-1);
  });
});

describe('Scene apartments, Beach Road (measured)', () => {
  const bs = aucklandBuildings()!;
  const hero = bs.filter((b) => b.hero === 'scene');

  it('replace the LINZ blocks: three hero buildings, no LINZ block centred inside their outlines', () => {
    expect(hero).toHaveLength(3);
    for (const b of bs) {
      if (b.hero) continue;
      for (const r of Object.values(SCENE_OUTLINES)) expect(inRing(r, b.prisms[0].cx, b.prisms[0].cz)).toBe(false);
    }
  });

  it('towers at the LiDAR heights on a lower podium (the old blocks stood the podium at tower height)', () => {
    const towers = SCENE_TERRACES.filter((t) => t.kind === 'tower').map((t) => t.h);
    expect(towers).toHaveLength(3);
    for (const h of towers) {
      expect(h).toBeGreaterThan(47);
      expect(h).toBeLessThan(52);
    }
    for (const t of SCENE_TERRACES.filter((t) => t.kind === 'podium')) {
      expect(t.h).toBeGreaterThan(9);
      expect(t.h).toBeLessThan(13);
    }
    for (const b of hero) {
      expect(b.prisms[0].kind).toBe('tower'); // the largest footprint first
      for (const p of b.prisms) expect(ringArea(p.ring)).toBeGreaterThan(0);
    }
  });

  it('the sim flies over the podium at 25 m but into the towers', () => {
    const geo = buildBuildingGeometry(() => 3.5)!;
    const idx = new BuildingIndex(geo);
    const pod = SCENE_TERRACES.find((t) => t.building === 'Scene Two' && t.kind === 'podium')!;
    const tw = SCENE_TERRACES.find((t) => t.building === 'Scene Two' && t.kind === 'tower')!;
    const c = (r: readonly number[]) => {
      let x = 0, z = 0;
      for (let i = 0; i < r.length; i += 2) { x += r[i]; z += r[i + 1]; }
      return [(x * 2) / r.length, (z * 2) / r.length];
    };
    const [px, pz] = c(pod.ring);
    const [tx, tz] = c(tw.ring);
    expect(idx.firstHit(new Vector3(px, 80, pz), new Vector3(px, 3.5 + 13, pz))).toBeNull();
    expect(idx.firstHit(new Vector3(tx, 80, tz), new Vector3(tx, 20, tz))).not.toBeNull();
  });
});
