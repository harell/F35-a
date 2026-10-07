/**
 * Real suburbs 8/9 (#127, phase A): the LINZ roads of the gulf islands and the Devonport peninsula as road ribbons
 * (kind ROAD_LOCAL in auckland-roads.bin, tools/linz/islandRoads.ts), where #121's real houses stand.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { ROADS_BYTES, ROADS_GZ } from './linz-setup';
import { aucklandRoads, decodeRoads, encodeRoads, ROAD_LOCAL, setAucklandRoads, type RoadLine } from '../src/world/scenery/aucklandRoads';
import { aucklandHouses, housesCover } from '../src/world/scenery/aucklandHouses';
import { aucklandRoadPaths, RoadNetwork } from '../src/world/scenery/motorways';
import { GeometryBuilder } from '../src/world/scenery/GeometryBuilder';
import { LightList } from '../src/world/scenery/builders';
import { aucklandStreets } from '../src/world/scenery/cbdStreets';
import { AKL } from '../src/core/auckland';

const ISLAND_X = 5500;
const local = () => aucklandRoads()!.lines.filter((l) => l.kind === ROAD_LOCAL);
const length = (l: RoadLine) => {
  let s = 0;
  for (let i = 2; i < l.pts.length; i += 2) s += Math.hypot(l.pts[i] - l.pts[i - 2], l.pts[i + 1] - l.pts[i - 1]);
  return s;
};
const km = (ls: RoadLine[]) => ls.reduce((s, l) => s + length(l), 0) / 1000;
/** Distance (m) from (x, z) to the nearest vertex chain of the given lines. */
function nearest(ls: RoadLine[], x: number, z: number): number {
  let d = Infinity;
  for (const l of ls)
    for (let i = 2; i < l.pts.length; i += 2) {
      const ax = l.pts[i - 2], az = l.pts[i - 1], bx = l.pts[i], bz = l.pts[i + 1];
      const dx = bx - ax, dz = bz - az;
      const l2 = dx * dx + dz * dz;
      const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2)) : 0;
      d = Math.min(d, Math.hypot(ax + dx * t - x, az + dz * t - z));
    }
  return d;
}

describe('island and Devonport roads data (auckland-roads.bin, kind ROAD_LOCAL)', () => {
  it('holds every island road, sealed and unsealed, and Devonport’s streets, in a file still < 100 kB gzip', () => {
    expect(ROADS_GZ.length).toBeLessThan(100 * 1024);
    const ls = local();
    const islands = ls.filter((l) => l.pts[0] >= ISLAND_X);
    expect(km(islands.filter((l) => !l.unsealed))).toBeGreaterThan(120);
    expect(km(islands.filter((l) => l.unsealed))).toBeGreaterThan(60);
    expect(km(ls.filter((l) => l.pts[0] < ISLAND_X))).toBeGreaterThan(50);
    const names = new Set(ls.map((l) => l.name));
    for (const n of ['Ocean View Road', 'Onetangi Road', 'Te Whau Drive', 'Orapiu Road', 'Waiheke Road', "Man O'War Bay Road", 'South Pacific Road', 'Vauxhall Road', 'Cheltenham Road'])
      expect(names, n).toContain(n);
    // not the address data's placeholder "roads" round a shore (Motutapu Island's runs along its coast)
    for (const n of ['Motutapu Island', 'Rotoroa Island', 'Matiatia Bay', 'Blackpool Beach']) expect(names, n).not.toContain(n);
    // Man O'War Bay Road is gravel past the vineyard; Ocean View Road is sealed
    expect(km(ls.filter((l) => l.name === "Man O'War Bay Road" && l.unsealed))).toBeGreaterThan(4);
    expect(ls.filter((l) => l.name === 'Ocean View Road').every((l) => !l.unsealed && l.width === 7)).toBe(true);
    // widths: 7 / 6 / 4.5 m on the islands (gravel 4.5), 9 / 6 m in Devonport
    for (const l of islands) expect([4.5, 6, 7]).toContain(l.width);
    for (const l of islands) if (l.unsealed) expect(l.width).toBe(4.5);
    for (const l of ls) if (l.pts[0] < ISLAND_X) expect([6, 9]).toContain(l.width);
  });

  it('includes Rangitoto’s summit road and Motutapu’s farm roads (Topo50: no address sections)', () => {
    // Motutapu (east of the Islington Bay causeway): its gravel farm roads
    const motutapu = local().filter((l) => l.pts[0] > 12000 && l.pts[0] < 16500 && l.pts[1] < -6500 && l.pts[1] > -13000);
    expect(km(motutapu.filter((l) => l.unsealed))).toBeGreaterThan(10);
    // the road climbs from Islington Bay's side to the car park ≈ 400 m below the summit's trig
    const summit = AKL.rangitoto;
    const rangitoto = local().filter((l) => Math.hypot(l.pts[0] - summit.x, l.pts[1] - summit.z) < 6000 && l.pts[0] < 11500);
    expect(km(rangitoto)).toBeGreaterThan(5);
    expect(nearest(rangitoto, summit.x, summit.z)).toBeLessThan(600);
  });

  it('lies where the real houses are the truth (#121 coverage), never in the CBD region', () => {
    const h = aucklandHouses()!;
    const st = aucklandStreets()!;
    let n = 0;
    let covered = 0;
    for (const l of local())
      for (let i = 0; i < l.pts.length; i += 2) {
        n++;
        if (housesCover(h, l.pts[i], l.pts[i + 1])) covered++;
        expect(st.inRegion(l.pts[i], l.pts[i + 1])).toBe(false);
      }
    expect(covered / n).toBeGreaterThan(0.97);
  });

  it('round-trips the unsealed flag through the encoder', () => {
    const d = decodeRoads(ROADS_BYTES);
    expect(d.lines.some((l) => l.unsealed)).toBe(true);
    expect(encodeRoads(d, 0.5)).toEqual(ROADS_BYTES);
    const one: RoadLine = { name: 'Gravel', kind: ROAD_LOCAL, width: 4.5, tunnel: false, unsealed: true, pts: Float32Array.of(0, 0, 10, 0) };
    const back = decodeRoads(encodeRoads({ region: new Float32Array(0), lines: [one] })).lines[0];
    expect(back.kind).toBe(ROAD_LOCAL);
    expect(back.unsealed).toBe(true);
  });
});

describe('island roads in the road network', () => {
  const paths = aucklandRoadPaths();
  const roads = new RoadNetwork(paths);
  const lp = paths.filter((p) => p.kind === 'local');

  it('joins RoadNetwork, so houses and trees keep off the carriageway', () => {
    expect(lp.length).toBe(local().length);
    // the middle of every local ribbon is on the road
    for (const p of lp) {
      const i = Math.floor(p.x.length / 2);
      expect(roads.edgeDistance(p.x[i], p.z[i])).toBeLessThan(0);
    }
  });

  it('keeps the real houses (#121): under 2 % of them stand on a ribbon (centre within 0.5 m of its edge)', () => {
    const h = aucklandHouses()!;
    let on = 0;
    for (let k = 0; k < h.count; k++) if (roads.near(h.x[k], h.z[k], 0.5)) on++;
    expect(on / h.count).toBeLessThan(0.02);
  });

  it('builds two vertices across a local ribbon, the sealed or gravel half of its texture, and no lamps', () => {
    const lights = new LightList();
    const g = roads.buildRibbons(() => 20, new GeometryBuilder(), lights, true, (p) => p.kind === 'local');
    expect(lights.count).toBe(0);
    const verts = lp.reduce((s, p) => s + p.x.length, 0);
    expect(g.getAttribute('position').count).toBe(verts * 2);
    expect(g.getIndex()!.count / 3).toBe(lp.reduce((s, p) => s + (p.x.length - 1) * 2, 0));
    const uv = g.getAttribute('uv');
    let o = 0;
    for (const p of lp) {
      for (let i = 0; i < p.x.length * 2; i++) {
        const u = uv.getX(o + i);
        if (p.unsealed) expect(u).toBeGreaterThanOrEqual(0.5);
        else expect(u).toBeLessThanOrEqual(0.5);
      }
      o += p.x.length * 2;
    }
  });

  it('stays low over a causeway (no bridge deck): at most 1.2 m over water', () => {
    const g = roads.buildRibbons(() => -3, new GeometryBuilder(), new LightList(), false, (p) => p.kind === 'local');
    const pos = g.getAttribute('position');
    for (let i = 0; i < pos.count; i += 97) expect(pos.getY(i)).toBeCloseTo(1.2, 5);
  });
});

describe('without the road data', () => {
  afterAll(() => setAucklandRoads(ROADS_BYTES));
  it('has no local roads (the hand-traced motorways and arterials only)', () => {
    setAucklandRoads(null);
    expect(aucklandRoadPaths().some((p) => p.kind === 'local')).toBe(false);
  });
});
