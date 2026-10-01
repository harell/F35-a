/**
 * Open data 2 (issue #33): the waterfront and strategic sites from the OpenStreetMap layer — the Ports of Auckland
 * wharves, piers, pontoons and breakwaters, the marinas, Devonport Naval Base, the Wiri oil terminal, Eden Park —
 * the moored ships on the real berths, the Harbour Bridge pier check and the hand-placed fallback.
 */
import { describe, expect, it } from 'vitest';
import { OSM_BYTES } from './linz-setup';
import { AKL, AKL_LANDMARKS } from '../src/core/auckland';
import { WIRI_TANKS, wiriTarget } from '../src/core/aucklandSites';
import { VESSEL_DATA } from '../src/sim/damage/tables';
import { PORT_BERTHS } from '../src/missions/runtime/shipping';
import {
  distToPath,
  osmLayer,
  OSM_BERTH,
  OSM_BREAKWATER,
  OSM_BRIDGE,
  OSM_BUILDING,
  OSM_CRANE,
  OSM_DOCK,
  OSM_MARINA,
  OSM_MILITARY,
  OSM_PIER,
  OSM_PITCH,
  OSM_PORT,
  OSM_STADIUM,
  OSM_TANK,
  pointInRing,
  setAucklandOsm,
} from '../src/world/scenery/aucklandOsm';
import { buildPort, buildMarinas, HARBOUR_BRIDGE_PIERS } from '../src/world/scenery/auckland';
import { buildStrategicSites, buildWaterfront, ringArea, ringCentre, WHARF_TOP } from '../src/world/scenery/waterfront';
import { GeometryBuilder } from '../src/world/scenery/GeometryBuilder';
import { LightList } from '../src/world/scenery/builders';
import { allFeatures } from '../src/world/scenery/Scenery';
import { generateTerrain, runSync } from '../src/world/terrain/generate';
import { segmentDistance } from '../src/world/terrain/coastline';
import { aucklandMapData } from '../src/world/terrain/theaters/auckland';

const DEG = Math.PI / 180;

/** Area centroid of a ring (the bake's tank centres are area centroids, not vertex means). */
function centroid(r: ArrayLike<number>): [number, number] {
  let a = 0;
  let cx = 0;
  let cz = 0;
  const n = r.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const c = r[j * 2] * r[i * 2 + 1] - r[i * 2] * r[j * 2 + 1];
    a += c;
    cx += (r[j * 2] + r[i * 2]) * c;
    cz += (r[j * 2 + 1] + r[i * 2 + 1]) * c;
  }
  return [cx / (3 * a), cz / (3 * a)];
}

/** Waterfront vertices above the waterline and below the quay crane booms that stand inside a berthed hull. */
function verticesInHulls(B: GeometryBuilder): string[] {
  const pos = B.build()!.getAttribute('position');
  const bad: string[] = [];
  for (const b of PORT_BERTHS) {
    const { length, beam } = VESSEL_DATA[b.vessel];
    const fx = Math.sin(b.heading * DEG);
    const fz = -Math.cos(b.heading * DEG);
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i);
      if (y < 0.5 || y > 40) continue;
      const dx = pos.getX(i) - b.x;
      const dz = pos.getZ(i) - b.z;
      if (Math.abs(dx * fx + dz * fz) < length / 2 - 2 && Math.abs(-dx * fz + dz * fx) < beam / 2 - 2) bad.push(`${b.x},${b.z}: ${pos.getX(i).toFixed(0)},${y.toFixed(0)},${pos.getZ(i).toFixed(0)}`);
    }
  }
  return bad;
}
const map = aucklandMapData();
/** Signed distance to the LINZ coastline: + land, − water. */
const coastDist = (x: number, z: number) => (map.isLand(x, z) ? 1 : -1) * segmentDistance(map.segments, x, z);
const hf = runSync(generateTerrain({ theater: 'auckland', seed: 1840, resolution: 1024, features: allFeatures('auckland', []), pads: [] }));
const height = (x: number, z: number) => hf.meshHeightAt(x, z);

const berth = (name: string) => osmLayer(OSM_BERTH).find((b) => b.name === name)!;
const port = () => osmLayer(OSM_PORT);
/** Hull outline samples (5 m along, 2 m across) of a ship at (x, z) with bow heading `deg`. */
function hull(x: number, z: number, deg: number, L: number, B: number): [number, number][] {
  const fx = Math.sin(deg * DEG);
  const fz = -Math.cos(deg * DEG);
  const out: [number, number][] = [];
  for (let a = -L / 2; a <= L / 2; a += 5) for (let b = -B / 2; b <= B / 2; b += 2) out.push([x + fx * a - fz * b, z + fz * a + fx * b]);
  return out;
}

describe('OSM waterfront layers', () => {
  it('holds the port, berths, cranes, dry dock, naval buildings, stadiums and the bridge outlines', () => {
    expect(port().map((f) => f.name)).toEqual(expect.arrayContaining(['Port of Auckland', 'Fergusson Container Terminal']));
    for (const n of ['Fergusson North', 'Fergusson Z', 'Princes E', 'Calliope South 1', 'Dry Dock']) expect(berth(n), n).toBeDefined();
    const quay = osmLayer(OSM_CRANE).filter((c) => c.container);
    expect(quay.map((c) => c.ref)).toEqual(expect.arrayContaining(['A', 'B', 'C', 'E', 'F', 'G', 'H', 'I']));
    expect(osmLayer(OSM_DOCK).map((d) => d.name)).toContain('Calliope Dock');
    expect(osmLayer(OSM_STADIUM).some((s) => /Eden Park/.test(s.name))).toBe(true);
    expect(osmLayer(OSM_PITCH).some((p) => p.name === 'Main Oval')).toBe(true);
    expect(osmLayer(OSM_BRIDGE).some((b) => b.name === 'Auckland Harbour Bridge')).toBe(true);
    expect(osmLayer(OSM_PIER).filter((p) => p.floating).length).toBeGreaterThan(100); // pontoons
    expect(osmLayer(OSM_BREAKWATER).length).toBeGreaterThan(100);
    expect(osmLayer(OSM_MARINA).length).toBeGreaterThanOrEqual(10);
    const base = osmLayer(OSM_MILITARY).find((m) => m.name === 'Devonport Naval Base')!;
    expect(base).toBeDefined();
    const inBase = osmLayer(OSM_BUILDING).filter((b) => pointInRing(base.pts, ...ringCentre(b.pts)));
    expect(inBase.length).toBeGreaterThan(30);
  });

  it('every pitch is inside a stadium and every building on military land (the bake filters them)', () => {
    const stadiums = osmLayer(OSM_STADIUM);
    for (const p of osmLayer(OSM_PITCH)) expect(stadiums.some((s) => pointInRing(s.pts, ...ringCentre(p.pts)) || distToPath(s.pts, ...ringCentre(p.pts), true) < 5)).toBe(true);
    for (const b of osmLayer(OSM_BUILDING)) expect(ringArea(b.pts)).toBeGreaterThanOrEqual(25);
  });
});

describe('ships at berth (missions/runtime/shipping.ts PORT_BERTHS)', () => {
  const named: [number, string][] = [
    [0, 'Fergusson North'],
    [1, 'Fergusson Z'],
    [2, 'Princes E'],
  ];

  it('lie on the real OSM berths: the berth point alongside the hull', () => {
    for (const [i, n] of named) {
      const b = PORT_BERTHS[i];
      const o = berth(n);
      const dx = o.pts[0] - b.x;
      const dz = o.pts[1] - b.z;
      const fx = Math.sin(b.heading * DEG);
      const fz = -Math.cos(b.heading * DEG);
      expect(Math.abs(dx * fx + dz * fz), `${n} along`).toBeLessThan(VESSEL_DATA[b.vessel].length / 2);
      expect(Math.abs(-dx * fz + dz * fx), `${n} across`).toBeLessThan(45);
    }
  });

  it('have the whole hull on water: ≥ 3 m off the LINZ coast and ≥ 3 m off the OSM wharves', () => {
    for (const b of PORT_BERTHS) {
      const { length, beam } = VESSEL_DATA[b.vessel];
      for (const [x, z] of hull(b.x, b.z, b.heading, length, beam)) {
        expect(coastDist(x, z), `${b.x},${b.z} @ ${x.toFixed(0)},${z.toFixed(0)}`).toBeLessThan(-3);
        for (const p of port()) {
          expect(pointInRing(p.pts, x, z), p.name).toBe(false);
          expect(distToPath(p.pts, x, z, true), p.name).toBeGreaterThan(3);
        }
      }
    }
  });

  it('lie alongside: parallel to the nearest wharf face (within 5°) and within 25 m of it', () => {
    const fergusson = port().find((p) => /Fergusson/.test(p.name))!;
    for (const b of PORT_BERTHS.slice(0, 2)) {
      // the nearest edge of the terminal
      const r = fergusson.pts;
      const n = r.length / 2;
      let best = Infinity;
      let dir = 0;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const d = distToPath([r[i * 2], r[i * 2 + 1], r[j * 2], r[j * 2 + 1]], b.x, b.z, false);
        if (d < best) {
          best = d;
          dir = Math.atan2(r[j * 2] - r[i * 2], -(r[j * 2 + 1] - r[i * 2 + 1])) / DEG;
        }
      }
      const diff = Math.abs((((b.heading - dir) % 180) + 180) % 180);
      expect(Math.min(diff, 180 - diff), `${b.x},${b.z}`).toBeLessThan(5);
      expect(best - VESSEL_DATA[b.vessel].beam / 2).toBeLessThan(25);
    }
  });

  it('no static ship geometry: nothing of the waterfront stands inside a berthed hull below the crane booms', () => {
    const B = new GeometryBuilder();
    buildWaterfront(B, new LightList(), height, 1);
    expect(verticesInHulls(B).slice(0, 5)).toEqual([]);
  }, 30_000);
});

describe('Wiri oil terminal (core/aucklandSites.ts)', () => {
  it('the tank table matches the OSM tanks (≤ 2 m, diameter ≤ 1 m) and the landmark', () => {
    const osm = osmLayer(OSM_TANK).map((t) => ({ c: centroid(t.pts), d: 2 * Math.sqrt(ringArea(t.pts) / Math.PI), fuel: t.fuel }));
    for (const t of WIRI_TANKS) {
      const m = osm.reduce((a, b) => (Math.hypot(b.c[0] - t.x, b.c[1] - t.z) < Math.hypot(a.c[0] - t.x, a.c[1] - t.z) ? b : a));
      expect(Math.hypot(m.c[0] - t.x, m.c[1] - t.z), `${t.x},${t.z}`).toBeLessThan(2);
      expect(Math.abs(m.d - t.d)).toBeLessThan(1);
      expect(m.fuel).toBe(t.fuel);
      expect(Math.hypot(t.x - AKL.wiri_terminal.x, t.z - AKL.wiri_terminal.z)).toBeLessThan(600);
    }
    expect(WIRI_TANKS.filter((t) => t.fuel).length).toBeGreaterThanOrEqual(12);
    expect(wiriTarget(2)).toEqual({ x: 7702, z: 17461 });
  });

  it('a mission target on a tank replaces the scenery tanks under its pad', () => {
    const run = (pads: { x: number; z: number; radius: number }[]) => buildStrategicSites(new GeometryBuilder(), new LightList(), height, 1, pads);
    const free = run([]);
    const t = wiriTarget(2);
    const padded = run([{ ...t, radius: 40 }]);
    expect(padded.tanksUnderPads).toBeGreaterThanOrEqual(1);
    expect(padded.tanks).toBe(free.tanks - padded.tanksUnderPads);
  });
});

describe('landmarks', () => {
  it('registers Devonport Naval Base, the Wiri terminal and Eden Park on the real sites', () => {
    const ids = AKL_LANDMARKS.map((l) => l.id);
    expect(ids).toEqual(expect.arrayContaining(['devonport_naval', 'wiri_terminal', 'eden_park']));
    const base = osmLayer(OSM_MILITARY).find((m) => m.name === 'Devonport Naval Base')!;
    expect(pointInRing(base.pts, AKL.devonport_naval.x, AKL.devonport_naval.z)).toBe(true);
    const oval = osmLayer(OSM_PITCH).find((p) => p.name === 'Main Oval')!;
    const [ox, oz] = ringCentre(oval.pts);
    expect(Math.hypot(AKL.eden_park.x - ox, AKL.eden_park.z - oz)).toBeLessThan(10);
    const fuel = WIRI_TANKS.filter((t) => t.fuel);
    const cx = fuel.reduce((s, t) => s + t.x, 0) / fuel.length;
    const cz = fuel.reduce((s, t) => s + t.z, 0) / fuel.length;
    expect(Math.hypot(AKL.wiri_terminal.x - cx, AKL.wiri_terminal.z - cz)).toBeLessThan(200);
  });
});

describe('Harbour Bridge (residual pier check against the OSM bridge outline)', () => {
  const S = AKL.bridge_s;
  const N = AKL.bridge_n;
  const outline = () => osmLayer(OSM_BRIDGE).find((b) => b.name === 'Auckland Harbour Bridge')!.pts;

  it('the deck axis and every pier lie inside the outline, within 4 m of its centreline', () => {
    const dx = N.x - S.x;
    const dz = N.z - S.z;
    const L = Math.hypot(dx, dz);
    const nx = -dz / L;
    const nz = dx / L;
    const r = outline();
    for (const t of [0.02, ...HARBOUR_BRIDGE_PIERS, 0.98]) {
      const x = S.x + dx * t;
      const z = S.z + dz * t;
      expect(pointInRing(r, x, z), `t ${t}`).toBe(true);
      // half widths of the outline either side of the deck axis
      let left = 0;
      while (left < 100 && pointInRing(r, x + nx * left, z + nz * left)) left += 0.5;
      let right = 0;
      while (right < 100 && pointInRing(r, x - nx * right, z - nz * right)) right += 0.5;
      expect(Math.abs(left - right) / 2, `t ${t}`).toBeLessThan(4);
      // the 24 m pier (and the 30 m deck) fit within the outline
      expect(Math.min(left, right), `t ${t}`).toBeGreaterThan(12);
    }
  });
});

describe('waterfront scenery (world/scenery/waterfront.ts)', () => {
  it('builds the real port, piers, marinas, naval base, tanks and Eden Park from OSM', () => {
    const B = new GeometryBuilder();
    const lights = new LightList();
    const st = buildWaterfront(B, lights, height, 1)!;
    expect(st).not.toBeNull();
    expect(st.decks).toBeGreaterThanOrEqual(1);
    expect(st.piers).toBeGreaterThan(1000);
    expect(st.yachts).toBeGreaterThan(800);
    expect(st.cranes).toBeGreaterThanOrEqual(10); // 10 quay cranes + the naval dock gantries
    expect(st.stacks).toBeGreaterThan(50);
    expect(st.tanks).toBeGreaterThanOrEqual(WIRI_TANKS.length);
    expect(st.navalBuildings).toBeGreaterThan(30);
    // mobile budget: the whole waterfront mesh stays under 120 k triangles
    expect(B.triangleCount).toBeLessThan(120_000);
    const eden = buildStrategicSites(new GeometryBuilder(), new LightList(), height, 1).eden!;
    expect(eden.osm).toBe(true);
    expect(Math.hypot(eden.x - AKL.eden_park.x, eden.z - AKL.eden_park.z)).toBeLessThan(10);
  });

  it('the port deck reaches the Fergusson reclamations the LINZ coastline lacks', () => {
    const B = new GeometryBuilder();
    buildWaterfront(B, new LightList(), height, 1);
    const pos = B.build()!.getAttribute('position');
    // a deck vertex at wharf level on the terminal's north-east corner (2172, −933), out over LINZ water
    let found = false;
    for (let i = 0; i < pos.count && !found; i++) found = Math.abs(pos.getY(i) - WHARF_TOP) < 0.01 && Math.hypot(pos.getX(i) - 2172, pos.getZ(i) + 933) < 3;
    expect(found).toBe(true);
    expect(coastDist(2172, -933)).toBeLessThan(0);
  });

  it('falls back to the hand-placed port and marinas, and the core-table sites, without the OSM file', () => {
    setAucklandOsm(null);
    try {
      expect(buildWaterfront(new GeometryBuilder(), new LightList(), height, 1)).toBeNull();
      const B = new GeometryBuilder();
      buildPort(B, new LightList(), height, 1);
      buildMarinas(B, new LightList(), height, 1);
      const sites = buildStrategicSites(B, new LightList(), height, 1);
      expect(B.triangleCount).toBeGreaterThan(1000);
      expect(sites.tanks).toBe(WIRI_TANKS.length);
      expect(sites.eden?.osm).toBe(false);
      // the fallback decks keep clear of the berthed hulls too
      expect(verticesInHulls(B).slice(0, 5)).toEqual([]);
    } finally {
      setAucklandOsm(OSM_BYTES);
    }
  });
});
