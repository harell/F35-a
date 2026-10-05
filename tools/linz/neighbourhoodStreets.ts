/**
 * The LINZ streets of the hero neighbourhoods that lie outside the CBD region (Mission Bay), as road ribbons.
 *
 * Inside the region the terrain shader draws the real street map; outside it paints a procedural grid, which the game
 * stops on a neighbourhood's footprint (Scenery.siteMask, aucklandSites.ts siteRings). The streets there are drawn
 * the way the 3D landmarks' are (roads.ts "streets round the 3D landmarks"): every LINZ road section (layer 123109)
 * within REACH m of the footprint, as an arterial-kind ribbon at most 12 m wide, without accessways (footpaths) and
 * without the runs that follow a ribbon already baked (Tāmaki Drive, Kepa Road: the arterials).
 *
 * Used by roads.ts (a full re-bake) and by neighbourhood-streets.ts (adds them to the current file).
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { ROAD_ARTERIAL, ROAD_RAIL, type RoadLine } from '../../src/world/scenery/aucklandRoads';
import { decodeNeighbourhoods } from '../../src/world/scenery/aucklandNeighbourhoods';
import { worldToGeo } from '../../src/core/auckland';
import { densify, fetchWfs, lines, polyDist, runs, segDist, simplify, type Feature, type Pt } from './polyline';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const NB = path.join(HERE, '../../src/world/scenery/data/auckland-neighbourhoods.bin');
/** Streets this far past the footprint join it to the streets around (the ribbons end there). */
const REACH = 20;
const LANES = new Set(['Lane', 'Place', 'Accessway', 'Service Lane', 'Close', 'Spur', 'Grove']);
const PEDESTRIAN = new Set(['Steps', 'Walk', 'Track', 'Te Ara', 'Arcade']);

function width(p: Feature['properties']): number | null {
  const n = String(p.full_road_name ?? '');
  const t = p.road_name_type as string | null;
  if (t === 'Accessway' || /Motorway|State Highway|Boardwalk/.test(n) || (t && PEDESTRIAN.has(t))) return null;
  return t && LANES.has(t) ? 7 : 12;
}

const inRing = (ring: Pt[], x: number, z: number) => {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i];
    const [xj, zj] = ring[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c;
  }
  return c;
};

/** The footprints of the neighbourhoods (auckland-neighbourhoods.bin) with no vertex inside the region. */
export function outsideFootprints(region: Pt[]): { name: string; ring: Pt[] }[] {
  const raw = fs.readFileSync(NB);
  const nbs = decodeNeighbourhoods(new Uint8Array(raw[0] === 0x1f ? zlib.gunzipSync(raw) : raw));
  return nbs
    .map((n) => ({ name: n.name, ring: Array.from({ length: n.footprint.length / 2 }, (_, i): Pt => [n.footprint[2 * i], n.footprint[2 * i + 1]]) }))
    .filter((n) => !n.ring.some(([x, z]) => inRing(region, x, z)));
}

/**
 * Street ribbons of every neighbourhood outside `region`, skipping runs along the `existing` ribbons. `wet(x, z)`: where
 * the game's terrain is water; those stretches are left out (a marina road on reclaimed land the 86 m terrain sees as
 * sea would run across the water: Westpark Marina, West Harbour).
 */
export function neighbourhoodStreets(work: string, region: Pt[], existing: RoadLine[], log = console.log, wet: (x: number, z: number) => boolean = () => false): RoadLine[] {
  const out: RoadLine[] = [];
  for (const nb of outsideFootprints(region)) {
    const xs = nb.ring.map((p) => p[0]);
    const zs = nb.ring.map((p) => p[1]);
    // the ribbons already baked near the footprint (roads, not railways)
    const segs: [Pt, Pt][] = [];
    const m = REACH + 100;
    const nearBox = (x: number, z: number) => x > Math.min(...xs) - m && x < Math.max(...xs) + m && z > Math.min(...zs) - m && z < Math.max(...zs) + m;
    for (const l of existing)
      if (l.kind !== ROAD_RAIL)
        for (let i = 0; i + 3 < l.pts.length; i += 2) if (nearBox(l.pts[i], l.pts[i + 1])) segs.push([[l.pts[i], l.pts[i + 1]], [l.pts[i + 2], l.pts[i + 3]]]);
    const onRibbon = (p: Pt) => segs.some(([a, b]) => segDist(p[0], p[1], a, b) < 12);
    const lo = worldToGeo(Math.min(...xs) - REACH - 50, Math.max(...zs) + REACH + 50);
    const hi = worldToGeo(Math.max(...xs) + REACH + 50, Math.min(...zs) - REACH - 50);
    const key = `neighbourhood-${nb.name.toLowerCase().replace(/\W+/g, '-')}.json`;
    const secs = fetchWfs(work, key, 'layer-123109', `BBOX(shape,${lo.lat},${lo.lon},${hi.lat},${hi.lon})`);
    const closed = nb.ring.concat([nb.ring[0]]);
    const near = (p: Pt) => inRing(nb.ring, p[0], p[1]) || polyDist(p[0], p[1], closed) < REACH;
    let n = 0;
    let km = 0;
    for (const sec of secs) {
      const w = width(sec.properties);
      if (w === null) continue;
      for (const pl of lines(sec))
        for (const r of runs(densify(pl, 4), (p) => (near(p) && !wet(p[0], p[1]) ? 0 : -1))) {
          if (r.flag !== 0 || r.pts.filter(onRibbon).length > r.pts.length / 2) continue;
          if (Math.hypot(r.pts[r.pts.length - 1][0] - r.pts[0][0], r.pts[r.pts.length - 1][1] - r.pts[0][1]) < 15) continue; // stubs
          const pts = simplify(r.pts, 0.8);
          if (pts.length < 2) continue;
          out.push({ name: String(sec.properties.full_road_name ?? ''), kind: ROAD_ARTERIAL, width: w, tunnel: false, pts: Float32Array.from(pts.flat()) });
          n++;
          for (let i = 1; i < pts.length; i++) km += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]) / 1000;
        }
    }
    log(`${nb.name}: ${n} street runs, ${km.toFixed(1)} km`);
  }
  return out;
}
