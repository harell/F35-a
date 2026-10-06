/**
 * The Auckland Domain's buildings (aucklandDomain.ts): each OSM outline up to its LiDAR roof in the aerial's roof colour,
 * stood on the game's ground at its centroid (the layered-site contract: it moves by meshHeightAt − DEM there), walls
 * down to the lowest ground in its outline; the Wintergarden's Temperate and Tropical Houses as glass barrel vaults over
 * their rectangles, dark at night (the Wintergarden closes at dusk). Merged into the caller's builder. The trees are TreeSource's (sources.ts).
 */
import type { AucklandDomain, DomainBuilding } from './aucklandDomain';
import { GeometryBuilder, IDENT_FRAME, WIN_NONE } from './GeometryBuilder';

type HeightFn = (x: number, z: number) => number;

/** Painted timber and plaster: the park's pavilions, the band rotunda, the grandstand's back. */
const WALL = 0xd9d3c4;
/** The glasshouses' glass and white-painted iron. */
const GLASS = 0xb9cdd2;
/** Segments of a vault's half-ellipse. */
const VAULT_SEGS = 8;

function groundOf(ring: ArrayLike<number>, height: HeightFn): { g: number; gMin: number } {
  let cx = 0, cz = 0, gMin = Infinity;
  const n = ring.length / 2;
  for (let i = 0; i < n; i++) {
    cx += ring[i * 2] / n;
    cz += ring[i * 2 + 1] / n;
    gMin = Math.min(gMin, height(ring[i * 2], ring[i * 2 + 1]));
  }
  return { g: height(cx, cz), gMin };
}

/** A glass barrel vault over a rectangle (corners c0…c3, c0 → c1 along the vault) from the eave to the ridge. */
function vault(B: GeometryBuilder, b: DomainBuilding, g: number, y0: number): void {
  const r = b.ring;
  const eave = g + b.h;
  const ridge = g + Math.max(b.ridge, b.h + 0.5);
  B.prism(r, y0, () => eave, GLASS, GLASS, WIN_NONE);
  // across the vault: from the c0–c1 side (u = 0) to the c3–c2 side (u = 1)
  const at = (u: number, end: 0 | 1): [number, number] => {
    const [ax, az] = end === 0 ? [r[0], r[1]] : [r[2], r[3]];
    const [bx, bz] = end === 0 ? [r[6], r[7]] : [r[4], r[5]];
    return [ax + (bx - ax) * u, az + (bz - az) * u];
  };
  const arc: [number, number][] = [];
  for (let k = 0; k <= VAULT_SEGS; k++) {
    const t = (k / VAULT_SEGS) * Math.PI;
    arc.push([(1 - Math.cos(t)) / 2, eave + (ridge - eave) * Math.sin(t)]);
  }
  // the sign of the turn c0 → c1 → c2 says which way the quads face out
  const turn = (r[2] - r[0]) * (r[5] - r[1]) - (r[3] - r[1]) * (r[4] - r[0]);
  for (let k = 0; k < VAULT_SEGS; k++) {
    const [u0, y0a] = arc[k];
    const [u1, y1a] = arc[k + 1];
    const [p0x, p0z] = at(u0, 0), [p1x, p1z] = at(u0, 1), [q0x, q0z] = at(u1, 0), [q1x, q1z] = at(u1, 1);
    const pts = [p0x, y0a, p0z, p1x, y0a, p1z, q1x, y1a, q1z, q0x, y1a, q0z];
    if (turn < 0) B.quad(IDENT_FRAME, pts, GLASS, WIN_NONE);
    else B.quad(IDENT_FRAME, [p0x, y0a, p0z, q0x, y1a, q0z, q1x, y1a, q1z, p1x, y0a, p1z], GLASS, WIN_NONE);
  }
  // the gable ends: a fan from the middle of each end at the eave
  for (const end of [0, 1] as const) {
    const [mx, mz] = at(0.5, end);
    for (let k = 0; k < VAULT_SEGS; k++) {
      const [ax, az] = at(arc[k][0], end);
      const [bx, bz] = at(arc[k + 1][0], end);
      const a = [ax, arc[k][1], az], c = [bx, arc[k + 1][1], bz];
      const out = (end === 0) === turn > 0;
      B.tri(IDENT_FRAME, out ? [mx, eave, mz, ...c, ...a] : [mx, eave, mz, ...a, ...c], GLASS, WIN_NONE);
    }
  }
}

/** Build the Domain's buildings into `B`; returns the triangles added. */
export function buildDomainBuildings(B: GeometryBuilder, domain: AucklandDomain, height: HeightFn): number {
  const t0 = B.triangleCount;
  for (const b of domain.buildings) {
    const { g, gMin } = groundOf(b.ring, height);
    const y0 = Math.min(g, gMin) - 0.5;
    if (b.kind === 1) vault(B, b, g, y0);
    else B.prism(b.ring, y0, () => g + b.h, WALL, b.roof, WIN_NONE);
  }
  return B.triangleCount - t0;
}
