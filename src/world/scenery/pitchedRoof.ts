/**
 * Gable and hip roofs over any footprint (the hero neighbourhoods' houses, aucklandNeighbourhoods.ts). The roof is
 * fitted to the LiDAR over the footprint's minimum rotated rectangle (tools/hero/sites/neighbourhood.py fit_roof):
 * its height is `eave + pitch · d`, d the distance to the nearest eave edge of that rectangle (gable: the two long
 * sides; hip: all four). Each eave edge owns one planar facet; a facet is the footprint clipped to the half-planes
 * where its edge is the nearest, so an L-shaped house gets the part of the roof over it, and the walls rise to the
 * roof along their length (a gable end reaches the ridge). Node-safe (no three.js).
 */

export interface PitchedRoof {
  /** 1 gable (ridge along the long axis), 2 hip. */
  kind: 1 | 2;
  /** Eave height above the ground at the footprint's centroid (m). */
  eave: number;
  /** Rise per metre run (m/m). */
  pitch: number;
  /** Rectangle centre (m, game XZ). */
  cx: number;
  cz: number;
  /** Unit long axis. */
  ax: number;
  az: number;
  /** Half length along the axis and half width across it (m). */
  a: number;
  b: number;
}

/** Distance coefficients of the eave edges in the rectangle frame: d = cu·u + cv·v + c0. */
function edges(r: PitchedRoof): [number, number, number][] {
  const e: [number, number, number][] = [
    [0, -1, r.b],
    [0, 1, r.b],
  ];
  if (r.kind === 2) e.push([-1, 0, r.a], [1, 0, r.a]);
  return e;
}

function toUV(r: PitchedRoof, x: number, z: number): [number, number] {
  const dx = x - r.cx;
  const dz = z - r.cz;
  return [dx * r.ax + dz * r.az, -dx * r.az + dz * r.ax];
}

/** Roof height above the eave datum's ground (m) at (x, z): eave + pitch · (distance to the nearest eave edge). */
export function pitchedHeight(r: PitchedRoof, x: number, z: number): number {
  const [u, v] = toUV(r, x, z);
  let d = Infinity;
  for (const [cu, cv, c0] of edges(r)) d = Math.min(d, cu * u + cv * v + c0);
  return r.eave + r.pitch * Math.max(0, d);
}

/** Ridge height (m above the same ground): the highest point of the roof over its rectangle. */
export function ridgeHeight(r: PitchedRoof): number {
  return r.eave + r.pitch * (r.kind === 1 ? r.b : Math.min(r.a, r.b));
}

export interface RoofFacet {
  /** Flat [x0, z0, x1, z1, ...] (m), the part of the footprint under this facet. */
  ring: number[];
  /** Heights above the eave datum's ground at each vertex (m). */
  heights: number[];
}

/**
 * The roof's planar facets over a footprint (flat ring, either winding): one per eave edge, the footprint clipped
 * (Sutherland–Hodgman) to the half-planes where that edge is the nearest. Empty facets are dropped.
 */
export function roofFacets(r: PitchedRoof, ring: ArrayLike<number>): RoofFacet[] {
  const es = edges(r);
  const n = ring.length / 2;
  const uv: [number, number][] = [];
  for (let i = 0; i < n; i++) uv.push(toUV(r, ring[i * 2], ring[i * 2 + 1]));
  const out: RoofFacet[] = [];
  for (let k = 0; k < es.length; k++) {
    let poly = uv;
    for (let j = 0; j < es.length && poly.length >= 3; j++) {
      if (j === k) continue;
      // keep d_k − d_j ≤ 0
      const fu = es[k][0] - es[j][0];
      const fv = es[k][1] - es[j][1];
      const f0 = es[k][2] - es[j][2];
      const side = (p: [number, number]) => fu * p[0] + fv * p[1] + f0;
      const next: [number, number][] = [];
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i];
        const b = poly[(i + 1) % poly.length];
        const sa = side(a);
        const sb = side(b);
        if (sa <= 0) next.push(a);
        if ((sa < 0 && sb > 0) || (sa > 0 && sb < 0)) {
          const t = sa / (sa - sb);
          next.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
        }
      }
      poly = next;
    }
    if (poly.length < 3) continue;
    let area = 0;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      area += a[0] * b[1] - b[0] * a[1];
    }
    if (Math.abs(area) < 0.02) continue;
    const [cu, cv, c0] = es[k];
    const fr: number[] = [];
    const hs: number[] = [];
    for (const [u, v] of poly) {
      fr.push(r.cx + u * r.ax - v * r.az, r.cz + u * r.az + v * r.ax);
      hs.push(r.eave + r.pitch * Math.max(0, cu * u + cv * v + c0));
    }
    out.push({ ring: fr, heights: hs });
  }
  return out;
}

/**
 * Points along the edge a → b (as fractions 0 … 1, both ends included) where the roof's height changes slope: where
 * the nearest eave edge changes. Walls split there follow the roof exactly.
 */
export function wallBreaks(r: PitchedRoof, ax: number, az: number, bx: number, bz: number): number[] {
  const es = edges(r);
  const [ua, va] = toUV(r, ax, az);
  const [ub, vb] = toUV(r, bx, bz);
  const ts = [0, 1];
  for (let i = 0; i < es.length; i++)
    for (let j = i + 1; j < es.length; j++) {
      const da = (es[i][0] - es[j][0]) * ua + (es[i][1] - es[j][1]) * va + es[i][2] - es[j][2];
      const db = (es[i][0] - es[j][0]) * ub + (es[i][1] - es[j][1]) * vb + es[i][2] - es[j][2];
      if ((da < 0 && db > 0) || (da > 0 && db < 0)) ts.push(da / (da - db));
    }
  return ts.sort((p, q) => p - q);
}
