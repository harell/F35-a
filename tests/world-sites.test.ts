/**
 * Open data 2 (issue #33): the port, marinas, Devonport Naval Base, Wiri oil terminal and Eden Park from the
 * OpenStreetMap layer (scenery/aucklandSites.ts), the ships' berths on the real wharves, the Wiri tank table
 * (core/sites.ts) in step with the bake, the Harbour Bridge piers from OSM, and the hand-placed fallback.
 * Also issue #48: the narrow basins (Viaduct, Silo, Westhaven, west of Fergusson) stay below the water plane.
 */
import { describe, expect, it } from 'vitest';
import { OSM_BYTES } from './linz-setup';
import { AKL, BRIDGE_PIERS_T, BRIDGE_SPAN_T } from '../src/core/auckland';
import { WIRI_TANKS } from '../src/core/sites';
import { VESSEL_DATA } from '../src/sim/damage/tables';
import { PORT_BERTHS } from '../src/missions/runtime/shipping';
import { aucklandOsm, distToPath, OSM_TANK, pointInRing, setAucklandOsm } from '../src/world/scenery/aucklandOsm';
import { areaOf, berthFaces, buildNavalBase, buildRealPort, buildRealWaterside, buildStadiums, buildWiriTerminal, centreOf, inRing, siteBlocker, siteLayout, type SiteLayout } from '../src/world/scenery/aucklandSites';
import { buildMarinas, buildPort } from '../src/world/scenery/auckland';
import { GeometryBuilder } from '../src/world/scenery/GeometryBuilder';
import { LightList } from '../src/world/scenery/builders';
import { segmentDistance } from '../src/world/terrain/coastline';
import { aucklandMapData } from '../src/world/terrain/theaters/auckland';
import { generateTerrain, runSync } from '../src/world/terrain/generate';
import { allFeatures } from '../src/world/scenery/Scenery';

const map = aucklandMapData();
const coastDist = (x: number, z: number) => (map.isLand(x, z) ? 1 : -1) * segmentDistance(map.segments, x, z);
const hf = runSync(generateTerrain({ theater: 'auckland', seed: 1840, resolution: 1024, features: allFeatures('auckland', []), pads: [] }));
const height = (x: number, z: number) => hf.meshHeightAt(x, z);
const isWater = (x: number, z: number) => !map.isLand(x, z);
const S = (): SiteLayout => siteLayout()!;
/** The Waitematā port ring (Queens Wharf → Fergusson). */
const mainPort = () => S().port.reduce((a, b) => (areaOf(b.pts) > areaOf(a.pts) ? b : a));

describe('Ports of Auckland on the real wharves', () => {
  it('the OSM port outline covers the terminal: ≈ 0.77 km², mostly LINZ land (the rest is the new Fergusson reclamation)', () => {
    const p = mainPort();
    expect(areaOf(p.pts)).toBeGreaterThan(600_000);
    expect(areaOf(p.pts)).toBeLessThan(900_000);
    expect(inRing(p, AKL.port.x, AKL.port.z)).toBe(true);
    let n = 0;
    let land = 0;
    for (let x = p.x0; x < p.x1; x += 20)
      for (let z = p.z0; z < p.z1; z += 20) {
        if (!inRing(p, x, z)) continue;
        n++;
        if (map.isLand(x, z)) land++;
      }
    expect(land / n).toBeGreaterThan(0.8);
    // …the reclamation is the only water: all of it east of x = 1,850 (Fergusson)
    for (let x = p.x0; x < 1850; x += 20) for (let z = p.z0; z < p.z1; z += 20) if (inRing(p, x, z)) expect(coastDist(x, z), `${x},${z}`).toBeGreaterThan(-25);
  });

  it('cranes stand on the real berth faces: Fergusson West and North, Bledisloe', () => {
    const faces = berthFaces(mainPort(), isWater, S().port).sort((a, b) => b.length - a.length);
    expect(faces.length).toBeGreaterThanOrEqual(3);
    const near = (x: number, z: number) => faces.some((f) => distToPath([f.ax, f.az, f.bx, f.bz], x, z, false) < 40);
    expect(near(1915, -645), 'Fergusson West').toBe(true);
    expect(near(2015, -950), 'Fergusson North').toBe(true);
    expect(near(895, -730), 'Bledisloe West').toBe(true);
    const B = new GeometryBuilder();
    const built = buildRealPort(B, new LightList(), height, 1, S());
    expect(built.length).toBe(faces.length);
    expect(B.triangleCount).toBeGreaterThan(2000);
    expect(B.triangleCount).toBeLessThan(60_000);
  });

  it('the moored ships lie alongside a real wharf: hull on the water, clear of the port, its side within 25 m of the quay', () => {
    const DEG = Math.PI / 180;
    for (const b of PORT_BERTHS) {
      const { length: L, beam: W } = VESSEL_DATA[b.vessel];
      const ux = Math.sin(b.heading * DEG);
      const uz = -Math.cos(b.heading * DEG);
      let gap = Infinity;
      for (let k = -0.5; k <= 0.5001; k += 0.05)
        for (const w of [-0.5, 0.5]) {
          const x = b.x + ux * L * k - uz * W * w;
          const z = b.z + uz * L * k + ux * W * w;
          expect(map.isLand(x, z), `${b.vessel} @ ${b.x},${b.z}: ${x.toFixed(0)},${z.toFixed(0)}`).toBe(false);
          expect(S().port.some((p) => inRing(p, x, z))).toBe(false);
          gap = Math.min(gap, segmentDistance(map.segments, x, z), ...S().port.map((p) => distToPath(p.pts, x, z, true)));
        }
      expect(gap, `${b.x},${b.z}`).toBeLessThan(25);
    }
    // the cruise liner is at Princes Wharf, the container ships at Fergusson
    expect(PORT_BERTHS.filter((b) => b.vessel === 'container').every((b) => b.x > 1800)).toBe(true);
    const cruise = PORT_BERTHS.find((b) => b.vessel === 'cruise')!;
    const princes = S().pierLines.find((f) => f.name === 'Princes Wharf Cruise Terminal')!;
    expect(distToPath(princes.pts, cruise.x, cruise.z, false)).toBeLessThan(60);
  });
});

describe('marinas, piers and breakwaters', () => {
  it('Westhaven and the Viaduct marinas are OSM outlines with their pontoons inside', () => {
    const names = S().marinas.map((m) => m.name);
    for (const n of ['Westhaven Marina', 'Auckland Central Marina', 'Silo Marina']) expect(names).toContain(n);
    const westhaven = S().marinas.find((m) => m.name === 'Westhaven Marina')!;
    expect(inRing(westhaven, AKL.westhaven.x, AKL.westhaven.z)).toBe(true);
    expect(S().piers.filter((p) => inRing(westhaven, ...centreOf(p.pts))).length).toBeGreaterThan(20);
  });

  it('berths yachts along the pontoons (none on a pontoon or on land), within the triangle budget', () => {
    const B = new GeometryBuilder();
    const boats = buildRealWaterside(B, new LightList(), height, 1, S());
    expect(boats).toBeGreaterThan(800);
    expect(boats).toBeLessThanOrEqual(2400);
    expect(B.triangleCount).toBeLessThan(120_000);
    const low = new GeometryBuilder();
    expect(buildRealWaterside(low, new LightList(), height, 0.3, S())).toBeLessThanOrEqual(900);
  });
});

describe('narrow harbour basins render as water (issue #48)', () => {
  // The terrain mesh (78 m cells) must not stand above the water plane inside the basins, or the basin
  // draws as land and the moored ships and yachts sit on it. Auckland heights are a continuous function
  // of the exact LINZ coast distance, so samples inside a 150 m basin still come out below sea level.
  // Near the camera the terrain shader sinks ground below 1.2 m by 0.8 m (renderH in terrainShader.ts), fading
  // the sink out at 2.5 m, and paints any ground the 15 m coast mask calls sea as water.
  const SUNK = 0.5; // m: still under the water plane once sunk
  const SINK_TOP = 2.5; // m: above this the terrain is not sunk at all

  it('the moored hulls float: the terrain under each berthed ship stays below the water plane', () => {
    const DEG = Math.PI / 180;
    for (const b of PORT_BERTHS) {
      const { length: L, beam: W } = VESSEL_DATA[b.vessel];
      const ux = Math.sin(b.heading * DEG);
      const uz = -Math.cos(b.heading * DEG);
      for (let k = -0.5; k <= 0.5001; k += 0.05)
        for (const w of [-0.5, 0, 0.5]) {
          const x = b.x + ux * L * k - uz * W * w;
          const z = b.z + uz * L * k + ux * W * w;
          expect(height(x, z), `${b.vessel} @ ${b.x},${b.z}: ${x.toFixed(0)},${z.toFixed(0)}`).toBeLessThan(SUNK);
        }
    }
  });

  it('the Viaduct, Silo and Westhaven basins are below sea level, with no ground above the sink range', () => {
    // [OSM marina, min share of its water (≥ 15 m from the LINZ coast) below sea level]; measured 0.94 / 1 / 0.999
    const basins: [string, number][] = [
      ['Auckland Central Marina', 0.9], // the Viaduct Harbour
      ['Silo Marina', 0.97],
      ['Westhaven Marina', 0.97],
    ];
    for (const [name, minShare] of basins) {
      const r = S().marinas.find((m) => m.name === name)!;
      let n = 0;
      let below = 0;
      for (let x = Math.ceil(r.x0 / 10) * 10; x <= r.x1; x += 10)
        for (let z = Math.ceil(r.z0 / 10) * 10; z <= r.z1; z += 10) {
          if (!inRing(r, x, z) || map.isLand(x, z) || segmentDistance(map.segments, x, z) < 15) continue;
          const h = height(x, z);
          n++;
          if (h < 0) below++;
          expect(h, `${name} @ ${x},${z}`).toBeLessThan(SINK_TOP);
        }
      expect(n, name).toBeGreaterThan(200);
      expect(below / n, name).toBeGreaterThanOrEqual(minShare);
    }
  });
});

describe('strategic sites (AKL landmarks)', () => {
  it('Devonport Naval Base: the OSM base outline round AKL.naval_base, with Calliope Dock, Calliope Wharf and its buildings', () => {
    const base = S().naval!;
    expect(base).not.toBeNull();
    expect(base.name).toBe('Devonport Naval Base');
    expect(S().docks.some((d) => d.name === 'Calliope Dock' && inRing(base, ...centreOf(d.pts)))).toBe(true);
    expect(S().piers.some((p) => p.name === 'Calliope Wharf' && distToPath(base.pts, ...centreOf(p.pts), true) < 300)).toBe(true);
    expect(S().buildings.filter((b) => inRing(base, ...centreOf(b.pts))).length).toBeGreaterThan(30);
    const B = new GeometryBuilder();
    buildNavalBase(B, new LightList(), height, S());
    expect(B.triangleCount).toBeGreaterThan(500);
  });

  it('Wiri oil terminal: AKL.wiri inside the OSM terminal; WIRI_TANKS is every baked tank inside it, within 1 m', () => {
    const depot = S().depot!;
    expect(depot.name).toMatch(/Wiri Oil/);
    expect(inRing(depot, AKL.wiri.x, AKL.wiri.z)).toBe(true);
    const baked = aucklandOsm()!.features.filter((f) => f.layer === OSM_TANK && (pointInRing(depot.pts, ...centreOf(f.pts)) || distToPath(depot.pts, ...centreOf(f.pts), true) < 30));
    expect(baked.length).toBe(WIRI_TANKS.length);
    for (const t of WIRI_TANKS) {
      const m = baked.find((f) => {
        const [x, z] = centreOf(f.pts);
        return Math.hypot(x - t.x, z - t.z) < 6;
      });
      expect(m, `${t.x},${t.z}`).toBeDefined();
      expect(Math.abs(Math.sqrt(areaOf(m!.pts) / Math.PI) - t.r)).toBeLessThan(1);
      expect(m!.fuel).toBe(t.fuel);
    }
    expect(WIRI_TANKS.filter((t) => t.fuel).length).toBeGreaterThanOrEqual(8);
  });

  it('Eden Park: AKL.eden_park inside the OSM stadium, with its four stands', () => {
    const eden = S().stadiums.find((s) => inRing(s.outline, AKL.eden_park.x, AKL.eden_park.z))!;
    expect(eden.outline.name).toMatch(/Eden Park/);
    expect(eden.stands.length).toBeGreaterThanOrEqual(4);
    const B = new GeometryBuilder();
    buildStadiums(B, new LightList(), height, S());
    expect(B.triangleCount).toBeGreaterThan(200);
  });

  it('houses and trees keep off the sites, not off the suburb next door', () => {
    const blocked = siteBlocker()!;
    expect(blocked(AKL.naval_base.x, AKL.naval_base.z, 0)).toBe(true);
    expect(blocked(AKL.wiri.x, AKL.wiri.z, 0)).toBe(true);
    expect(blocked(AKL.eden_park.x, AKL.eden_park.z, 0)).toBe(true);
    expect(blocked(AKL.port.x, AKL.port.z, 0)).toBe(true);
    expect(blocked(AKL.devonport.x, AKL.devonport.z, 0)).toBe(false);
    expect(blocked(AKL.cbd.x, AKL.cbd.z, 0)).toBe(false);
  });
});

describe('Harbour Bridge piers (OSM bridge:support)', () => {
  const Sb = AKL.bridge_s;
  const Nb = AKL.bridge_n;
  const at = (t: number) => ({ x: Sb.x + (Nb.x - Sb.x) * t, z: Sb.z + (Nb.z - Sb.z) * t });
  const len = Math.hypot(Nb.x - Sb.x, Nb.z - Sb.z);

  it('every pier stands in the harbour, in order', () => {
    for (const t of BRIDGE_PIERS_T) expect(coastDist(at(t).x, at(t).z), `t ${t}`).toBeLessThan(0);
    for (let i = 1; i < BRIDGE_PIERS_T.length; i++) expect(BRIDGE_PIERS_T[i]).toBeGreaterThan(BRIDGE_PIERS_T[i - 1]);
  });

  it('the navigation span is the 241 m gap between the last two piers, and the fly-under point is its centre', () => {
    const [a, b] = BRIDGE_PIERS_T.slice(-2);
    expect((b - a) * len).toBeGreaterThan(230);
    expect((b - a) * len).toBeLessThan(250);
    // the longest span of the bridge
    for (let i = 1; i < BRIDGE_PIERS_T.length - 1; i++) expect(BRIDGE_PIERS_T[i] - BRIDGE_PIERS_T[i - 1]).toBeLessThan(b - a);
    expect(BRIDGE_SPAN_T).toBeCloseTo((a + b) / 2, 6);
  });
});

describe('fallback without the OSM file', () => {
  it('keeps the hand-placed port and marinas and the Wiri tanks', () => {
    setAucklandOsm(null);
    try {
      expect(siteLayout()).toBeNull();
      expect(siteBlocker()).toBeNull();
      const B = new GeometryBuilder();
      buildPort(B, new LightList(), height, 1);
      const port = B.triangleCount;
      expect(port).toBeGreaterThan(1000);
      buildMarinas(B, new LightList(), height, 1);
      expect(B.triangleCount).toBeGreaterThan(port);
      const W = new GeometryBuilder();
      buildWiriTerminal(W, new LightList(), height, null);
      expect(W.triangleCount).toBeGreaterThan(WIRI_TANKS.length * 16);
    } finally {
      setAucklandOsm(OSM_BYTES);
    }
    expect(siteLayout()).not.toBeNull();
  });
});
