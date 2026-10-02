/**
 * Harbour ferries (issue #30): render-only traffic on timetable routes out of the Downtown Ferry Terminal.
 * Every hull position on every route lies on the real LINZ water, clear of the OpenStreetMap wharves,
 * piers and breakwaters, the Harbour Bridge piers and the moored ships; the docks are the real wharves;
 * no two ferries ever overlap over the fleet's whole cycle; the motion is deterministic; the quality
 * presets tune the fleet size and switch the wakes off on 'low'.
 */
import { describe, expect, it } from 'vitest';
import { AKL, BRIDGE_PIERS_T } from '../src/core/auckland';
import { QUALITY_PRESETS } from '../src/core/data';
import { PORT_BERTHS } from '../src/missions/runtime/shipping';
import { VESSEL_DATA } from '../src/sim/damage/tables';
import { aucklandOsm, distToPath, OSM_BREAKWATER, OSM_PIER, OSM_PORT, pointInRing, type OsmFeature } from '../src/world/scenery/aucklandOsm';
import { aucklandMapData } from '../src/world/terrain/theaters/auckland';
import { FERRY_BEAM, FERRY_CYCLE, FERRY_FLEET, FERRY_LENGTH, FERRY_ROUTES, ferryAt, ferryRoutes, type FerryState } from '../src/render/traffic/ferryRoutes';

const DEG = Math.PI / 180;
const map = aucklandMapData();
const routes = ferryRoutes();

/* ───────── obstacles: OSM wharves / piers / breakwaters / port land, bridge piers, moored ships ───────── */

interface Obstacle {
  f: OsmFeature;
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  pad: number;
}
const BUCKET = 250;
const buckets = new Map<number, Obstacle[]>();
const key = (i: number, j: number) => i * 100_003 + j;
for (const f of aucklandOsm()!.features) {
  if (f.layer !== OSM_PIER && f.layer !== OSM_BREAKWATER && f.layer !== OSM_PORT) continue;
  const pad = f.area ? 0 : Math.max(1.5, (f.width || 3) / 2);
  let x0 = Infinity;
  let z0 = Infinity;
  let x1 = -Infinity;
  let z1 = -Infinity;
  for (let i = 0; i < f.pts.length; i += 2) {
    x0 = Math.min(x0, f.pts[i] - pad);
    x1 = Math.max(x1, f.pts[i] + pad);
    z0 = Math.min(z0, f.pts[i + 1] - pad);
    z1 = Math.max(z1, f.pts[i + 1] + pad);
  }
  const o = { f, x0, z0, x1, z1, pad };
  for (let i = Math.floor(x0 / BUCKET); i <= Math.floor(x1 / BUCKET); i++)
    for (let j = Math.floor(z0 / BUCKET); j <= Math.floor(z1 / BUCKET); j++) {
      const k = key(i, j);
      if (!buckets.has(k)) buckets.set(k, []);
      buckets.get(k)!.push(o);
    }
}
const Sb = AKL.bridge_s;
const Nb = AKL.bridge_n;
const PIERS = BRIDGE_PIERS_T.map((t) => ({ x: Sb.x + (Nb.x - Sb.x) * t, z: Sb.z + (Nb.z - Sb.z) * t }));

/** What a hull point at (x, z) would hit, or null on open water. */
function blocked(x: number, z: number): string | null {
  if (map.isLand(x, z)) return 'land';
  for (const o of buckets.get(key(Math.floor(x / BUCKET), Math.floor(z / BUCKET))) ?? []) {
    if (x < o.x0 || x > o.x1 || z < o.z0 || z > o.z1) continue;
    if (o.f.area ? pointInRing(o.f.pts, x, z) : distToPath(o.f.pts, x, z, false) < o.pad) return `osm ${o.f.layer} ${o.f.name}`;
  }
  for (const p of PIERS) if (Math.hypot(x - p.x, z - p.z) < 20) return 'bridge pier';
  for (const b of PORT_BERTHS) {
    const { length: L, beam: B } = VESSEL_DATA[b.vessel];
    const h = b.heading * DEG;
    const dx = x - b.x;
    const dz = z - b.z;
    const along = dx * Math.sin(h) - dz * Math.cos(h);
    const across = dx * Math.cos(h) + dz * Math.sin(h);
    if (Math.abs(along) < L / 2 + 10 && Math.abs(across) < B / 2 + 8) return `moored ${b.vessel}`;
  }
  return null;
}

/** Outline points of a ferry hull (the bow / stern ends pulled in 1.5 m: fenders touch the wharf). */
function hullPoints(s: FerryState, scale: number): [number, number][] {
  const L = FERRY_LENGTH * scale;
  const B = FERRY_BEAM * scale;
  const fx = Math.sin(s.heading);
  const fz = -Math.cos(s.heading);
  const out: [number, number][] = [];
  for (let a = -L / 2 + 1.5; a <= L / 2 - 1.5 + 1e-6; a += (L - 3) / 8)
    for (const c of [-B / 2, 0, B / 2]) out.push([s.x + fx * a - fz * c, s.z + fz * a + fx * c]);
  return out;
}

const st = (): FerryState => ({ x: 0, z: 0, heading: 0, speed: 0, dock: -1 });

describe('ferry routes on the real harbour', () => {
  it('runs 10–20 ferries on 6 routes, every period a divisor of the fleet cycle with room for the timetable', () => {
    expect(FERRY_FLEET.length).toBeGreaterThanOrEqual(10);
    expect(FERRY_FLEET.length).toBeLessThanOrEqual(20);
    for (const r of routes) {
      expect(FERRY_CYCLE % r.def.period, r.def.id).toBe(0);
      expect(r.minPeriod, `${r.def.id} needs ${r.minPeriod.toFixed(0)} s`).toBeLessThanOrEqual(r.def.period);
      expect(r.def.docks[0].name).toBe('Downtown Ferry Terminal');
    }
    // the first ferries of the fleet cover every route (the 'low' preset still has them all)
    expect(new Set(FERRY_FLEET.slice(0, FERRY_ROUTES.length).map((f) => f.route)).size).toBe(FERRY_ROUTES.length);
  });

  it('every hull position of every route lies on water (LINZ coastline, OSM wharves, bridge piers, moored ships)', () => {
    const s = st();
    const bad: string[] = [];
    for (const r of routes) {
      for (let t = 0; t < r.def.period; t += 1) {
        ferryAt(r, 0, t - r.def.offset, s);
        for (const [x, z] of hullPoints(s, r.def.scale)) {
          const why = blocked(x, z);
          if (why) {
            bad.push(`${r.def.id} t=${t} hull ${x.toFixed(0)},${z.toFixed(0)} (centre ${s.x.toFixed(0)},${s.z.toFixed(0)} hdg ${(s.heading / DEG).toFixed(0)}): ${why}`);
            break;
          }
        }
        if (bad.length > 40) break;
      }
    }
    expect(bad.slice(0, 40)).toEqual([]);
  }, 60_000);

  it('docks at the real wharves: each outer dock beside an OSM pier, Downtown at the ferry basins', () => {
    const piers = aucklandOsm()!.features.filter((f) => f.layer === OSM_PIER);
    for (const r of FERRY_ROUTES)
      for (const d of r.docks.slice(1)) {
        const near = Math.min(...piers.map((f) => distToPath(f.pts, d.x, d.z, f.area)));
        expect(near, d.name).toBeLessThan(40);
      }
    // the Downtown slots sit at the heads of the basins either side of Queens Wharf, south of the moored liner
    const liner = PORT_BERTHS.find((b) => b.vessel === 'cruise')!;
    for (const r of FERRY_ROUTES) {
      const d = r.docks[0];
      expect(d.z).toBeGreaterThan(liner.z + VESSEL_DATA.cruise.length / 2);
      expect(d.x).toBeGreaterThan(340);
      expect(d.x).toBeLessThan(620);
      expect(d.z).toBeGreaterThan(-760);
      expect(d.z).toBeLessThan(-620);
    }
  });

  it('keeps clear of the enemy-held islands', () => {
    const s = st();
    const ENEMY: [string, number][] = [
      ['rangitoto', 2800],
      ['motutapu', 2600],
      ['waiheke', 9000],
      ['motuihe', 1100],
      ['browns_is', 600],
    ];
    for (const r of routes)
      for (let t = 0; t < r.def.period; t += 10) {
        ferryAt(r, 0, t, s);
        for (const [id, R] of ENEMY) expect(Math.hypot(s.x - AKL[id].x, s.z - AKL[id].z), `${r.def.id} vs ${id}`).toBeGreaterThan(R + 1500);
      }
  });

  it('no two ferries ever overlap over the whole fleet cycle', () => {
    const n = FERRY_FLEET.length;
    const S = FERRY_FLEET.map(st);
    const clash: string[] = [];
    for (let t = 0; t < FERRY_CYCLE && clash.length < 20; t += 1) {
      FERRY_FLEET.forEach((f, i) => ferryAt(routes[f.route], f.k, t, S[i]));
      for (let i = 0; i < n; i++)
        for (let j = i + 1; j < n; j++) {
          const a = S[i];
          const b = S[j];
          if (Math.hypot(a.x - b.x, a.z - b.z) > 60) continue;
          if (obbOverlap(a, routes[FERRY_FLEET[i].route].def.scale, b, routes[FERRY_FLEET[j].route].def.scale))
            clash.push(`t=${t} ${FERRY_ROUTES[FERRY_FLEET[i].route].id}#${FERRY_FLEET[i].k} × ${FERRY_ROUTES[FERRY_FLEET[j].route].id}#${FERRY_FLEET[j].k} at ${a.x.toFixed(0)},${a.z.toFixed(0)}`);
        }
    }
    expect(clash).toEqual([]);
  }, 60_000);

  it('is a pure function of mission time: dwells alongside, accelerates, brakes and backs out', () => {
    const r = routes[0];
    const a = ferryAt(r, 1, 1234.5, st());
    const b = ferryAt(r, 1, 1234.5, st());
    expect(a).toEqual(b);
    // the period repeats
    const c = ferryAt(r, 1, 1234.5 + r.def.period, st());
    expect(c.x).toBeCloseTo(a.x, 3);
    expect(c.z).toBeCloseTo(a.z, 3);
    // over one period: alongside at both docks, at cruising speed in between, backing out after each stop
    const s = st();
    const docks = new Set<number>();
    let vmax = 0;
    let astern = false;
    let jump = 0;
    let px = NaN;
    let pz = NaN;
    for (let t = 0; t < r.def.period; t += 0.5) {
      ferryAt(r, 0, t, s);
      if (s.dock >= 0) {
        docks.add(s.dock);
        expect(s.speed).toBe(0);
      }
      vmax = Math.max(vmax, s.speed);
      if (s.speed < 0) astern = true;
      if (!Number.isNaN(px)) jump = Math.max(jump, Math.hypot(s.x - px, s.z - pz));
      px = s.x;
      pz = s.z;
    }
    expect([...docks].sort()).toEqual([0, 1]);
    expect(vmax).toBeCloseTo(r.speed, 1);
    expect(r.speed).toBeGreaterThan(6);
    expect(astern).toBe(true);
    // never moves faster than its speed allows (no teleporting at segment joins)
    expect(jump).toBeLessThan(r.speed * 0.5 + 0.5);
  });

  it('quality presets: wakes off on low, 10–20 ferries scaling with quality', () => {
    expect(QUALITY_PRESETS.low.wakes).toBe(false);
    expect(QUALITY_PRESETS.medium.wakes).toBe(true);
    expect(QUALITY_PRESETS.high.wakes).toBe(true);
    expect(QUALITY_PRESETS.low.ferries).toBeGreaterThanOrEqual(10);
    expect(QUALITY_PRESETS.low.ferries).toBeLessThanOrEqual(QUALITY_PRESETS.medium.ferries);
    expect(QUALITY_PRESETS.medium.ferries).toBeLessThanOrEqual(QUALITY_PRESETS.high.ferries);
    expect(QUALITY_PRESETS.high.ferries).toBeLessThanOrEqual(FERRY_FLEET.length);
  });
});

/** Separating-axis test of two ferry hulls (oriented rectangles), each grown by 3 m. */
function obbOverlap(a: FerryState, sa: number, b: FerryState, sb: number): boolean {
  const axes = [a.heading, a.heading + Math.PI / 2, b.heading, b.heading + Math.PI / 2];
  const half = (s: FerryState, sc: number, ax: number) => {
    const L = (FERRY_LENGTH * sc) / 2 + 3;
    const B = (FERRY_BEAM * sc) / 2 + 3;
    const d = ax - s.heading;
    return Math.abs(Math.cos(d)) * L + Math.abs(Math.sin(d)) * B;
  };
  for (const ax of axes) {
    const ux = Math.sin(ax);
    const uz = -Math.cos(ax);
    const dist = Math.abs((b.x - a.x) * ux + (b.z - a.z) * uz);
    if (dist > half(a, sa, ax) + half(b, sb, ax)) return false;
  }
  return true;
}
