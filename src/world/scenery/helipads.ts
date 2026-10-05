/**
 * Helipads (#125): every pad of the helipad table (src/core/sites.ts HELIPADS, baked from OpenStreetMap by
 * tools/osm/helipads.py) as a marked square: a concrete pad with the yellow touchdown circle and the white "H" at
 * hospitals, airfields, the naval base and heliports, a mown grass square with a white circle and "H" elsewhere
 * (vineyard and private pads). Ground pads follow the terrain; rooftop pads sit at their LiDAR roof height. At night
 * the hospital, airfield and heliport pads get green perimeter lights. A rooftop pad whose building the game doesn't
 * model yet stands on a plain block (buildHelipadDecks). One decal draw call for every pad (a
 * two-tile canvas atlas), the lights join the scenery's light points.
 */
import { CanvasTexture, SRGBColorSpace } from 'three';
import { HELIPADS, type Helipad } from '../../core/sites';
import type { DecalBuilder, LightList } from './builders';
import { WIN_OFFICE, type GeometryBuilder } from './GeometryBuilder';
import { roofHeight, type Building } from './aucklandBuildings';
import { pointInRing } from './aucklandOsm';

type HeightFn = (x: number, z: number) => number;

/** A pad is drawn at least this big (m): OSM's pads are often only the touchdown circle. */
const MIN_SIZE = 14;
/** The marked touchdown square drawn at a heliport (m). */
const HELIPORT_PAD = 30;
/** Rooftop pads are drawn this far above their LiDAR roof (the median DSM of the pad: its top). */
const ROOF_LIFT = 0.25;
/** Perimeter lights per side of a lit pad. */
const LIGHTS_PER_SIDE = 3;
const LIGHT_GREEN = 0x5cff7a;

/** Concrete-and-markings pads (the rest are grass): the official and commercial ones. */
export function padIsConcrete(p: Pick<Helipad, 'kind' | 'heliport'>): boolean {
  return p.heliport || p.kind === 'hospital' || p.kind === 'airfield' || p.kind === 'naval' || p.kind === 'heliport';
}

/** Pads lit at night (#125: hospital and airfield pads; heliports too). */
export function padIsLit(p: Pick<Helipad, 'kind' | 'heliport'>): boolean {
  return p.heliport || p.kind === 'hospital' || p.kind === 'airfield' || p.kind === 'heliport';
}

/**
 * The pad's drawn square: side (m) and the height of its surface at (x, z). A rooftop pad sits at its LiDAR roof,
 * or just above the modelled roof under it (`roof`, absolute m) when that stands higher.
 */
export function padSurface(p: Helipad, height: HeightFn, roof: number | null = null): { side: number; at: HeightFn } {
  // a heliport is mapped as the whole facility (Mechanics Bay: 110 m): its marked pad is the touchdown square at the centre
  const side = p.heliport ? Math.min(HELIPORT_PAD, Math.max(MIN_SIZE, p.width)) : Math.max(MIN_SIZE, p.size);
  const top = Math.max(p.height, roof ?? -Infinity) + ROOF_LIFT;
  return { side, at: p.roof ? () => top : height };
}

/**
 * The modelled roof (absolute height, m) at a point from building footprints (aucklandBuildings.ts: the LINZ CBD
 * buildings and the hero neighbourhoods), or null where the game draws no building.
 */
export function roofLookup(buildings: readonly Building[] | null, height: HeightFn): (x: number, z: number) => number | null {
  return (x, z) => {
    let best: number | null = null;
    for (const b of buildings ?? [])
      for (const pr of b.prisms) {
        const r = pr.ring;
        if (Math.abs(pr.cx - x) > 150 || Math.abs(pr.cz - z) > 150) continue;
        if (!pointInRing(r, x, z)) continue;
        const y = height(pr.cx, pr.cz) + roofHeight(pr, x, z);
        if (best === null || y > best) best = y;
      }
    return best;
  };
}

/** The atlas: left tile concrete with a yellow circle and a white H, right tile grass with a white circle and H. */
export function createHelipadTexture(): CanvasTexture {
  const S = 256;
  const c = document.createElement('canvas');
  c.width = S * 2;
  c.height = S;
  const g = c.getContext('2d')!;
  for (const [i, ground, ring] of [
    [0, '#9d9b95', '#e8c43a'],
    [1, '#5b7d3c', '#f2f2ee'],
  ] as const) {
    const x0 = i * S;
    g.fillStyle = ground;
    g.fillRect(x0, 0, S, S);
    if (i === 0) {
      // a white edge line round the concrete square
      g.strokeStyle = '#f2f2ee';
      g.lineWidth = 6;
      g.strokeRect(x0 + 8, 8, S - 16, S - 16);
    }
    g.strokeStyle = ring;
    g.lineWidth = 14;
    g.beginPath();
    g.arc(x0 + S / 2, S / 2, S * 0.36, 0, Math.PI * 2);
    g.stroke();
    // the H (cross bar along the pad's long axis, upright along its heading)
    g.fillStyle = '#f4f4f0';
    const w = S * 0.08;
    g.fillRect(x0 + S * 0.36, S * 0.3, w, S * 0.4);
    g.fillRect(x0 + S * 0.64 - w, S * 0.3, w, S * 0.4);
    g.fillRect(x0 + S * 0.36, S * 0.47, S * 0.28, w * 0.75);
  }
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  return t;
}

/**
 * Rooftop pads on a building the game doesn't model yet (Auckland City Hospital: the LINZ CBD buildings stop short of
 * Grafton, #124 adds the hospitals; Takapuna's towers): a plain block from the ground up to the pad, a little wider
 * than it, so the pad stands on a roof instead of floating. Pads over the water (a pontoon) get none. Into the sites'
 * mesh (`B`, the building material: no extra draw call). Returns the number of blocks.
 */
export function buildHelipadDecks(B: GeometryBuilder, height: HeightFn, roofAt: (x: number, z: number) => number | null, pads: readonly Helipad[] = HELIPADS): number {
  let n = 0;
  for (const p of pads) {
    if (!p.roof || roofAt(p.x, p.z) !== null || height(p.x, p.z) <= 0.5) continue;
    const side = Math.max(MIN_SIZE, p.size) + 4;
    let g = Infinity;
    for (const [dx, dz] of [[-1, -1], [1, -1], [1, 1], [-1, 1], [0, 0]]) g = Math.min(g, height(p.x + (dx * side) / 2, p.z + (dz * side) / 2));
    g -= 1;
    if (p.height - g < 2) continue;
    B.box({ ox: p.x, oy: g, oz: p.z, c: Math.cos(p.heading), s: Math.sin(p.heading) }, 0, 0, 0, side, p.height - g, side, 0xc4c1b8, 0x8e8c86, WIN_OFFICE);
    n++;
  }
  return n;
}

/** Lay every pad into `decal` (the helipad atlas's mesh) and add the night lights. Returns the number of pads laid. */
export function buildHelipads(decal: DecalBuilder, lights: LightList | null, height: HeightFn, roofAt: (x: number, z: number) => number | null = () => null, pads: readonly Helipad[] = HELIPADS): number {
  let n = 0;
  for (const p of pads) {
    const roof = p.roof ? roofAt(p.x, p.z) : null;
    const { side, at } = padSurface(p, height, roof);
    const h = side / 2;
    const u0 = padIsConcrete(p) ? 0 : 0.5;
    // local frame: −Z along the heading (DecalBuilder: wx = ox + lx·c + lz·s, wz = oz − lx·s + lz·c)
    const f = { ox: p.x, oz: p.z, c: Math.cos(p.heading), s: Math.sin(p.heading) };
    decal.quad(f, -h, h, -h, h, at, (lx, lz) => [u0 + 0.01 + ((lx + h) / side) * 0.48, 0.01 + ((lz + h) / side) * 0.98], side, p.roof ? 0 : 0.3);
    n++;
    if (lights && padIsLit(p)) {
      for (let k = 0; k < LIGHTS_PER_SIDE * 4; k++) {
        const e = Math.floor(k / LIGHTS_PER_SIDE);
        const t = ((k % LIGHTS_PER_SIDE) + 0.5) / LIGHTS_PER_SIDE;
        const lx = e === 0 ? -h + t * side : e === 1 ? h : e === 2 ? h - t * side : -h;
        const lz = e === 0 ? -h : e === 1 ? -h + t * side : e === 2 ? h : h - t * side;
        const wx = f.ox + lx * f.c + lz * f.s;
        const wz = f.oz - lx * f.s + lz * f.c;
        lights.add(wx, at(wx, wz) + 0.5, wz, LIGHT_GREEN, 1.2);
      }
    }
  }
  return n;
}
