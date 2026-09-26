/**
 * JS replica of the terrain shader's procedural urban grid (terrainShader.ts: district(),
 * urbanPattern()): Voronoi districts with their own street orientation, 105 × 76 m blocks split into
 * 4 × 2 lots. Float32 arithmetic is emulated so 3D houses / towers land on the same lots (and get
 * the same roof colours) the shader paints from altitude. Node-safe.
 */
const f32 = Math.fround;
const K = f32(0.1031);
const C33 = f32(33.33);

function fract(x: number): number {
  return x - Math.floor(x);
}

/** GLSL hash12 (Dave Hoskins) with float32 rounding. */
export function hash12(x: number, y: number): number {
  const p0 = fract(f32(f32(x) * K));
  const p1 = fract(f32(f32(y) * K));
  const p2 = p0;
  const d = f32(f32(f32(p0 * f32(p1 + C33)) + f32(p1 * f32(p2 + C33))) + f32(p2 * f32(p0 + C33)));
  const q0 = f32(p0 + d);
  const q1 = f32(p1 + d);
  const q2 = f32(p2 + d);
  return fract(f32(f32(q0 + q1) * q2));
}

export const DISTRICT_SIZE = 1300;
export const BLOCK_W = 105;
export const BLOCK_D = 76;
export const LOTS_X = 6;
export const LOTS_Z = 2;
export const ROAD_HALF = 3.5;

export interface District {
  cx: number;
  cz: number;
  hash: number;
  /** Rotation (rad): local = R·(world − centre). */
  angle: number;
  cos: number;
  sin: number;
  /** Distance to the district border (m). */
  border: number;
}

/** Voronoi district containing (x, z) (matches GLSL district()). */
export function districtAt(x: number, z: number, size = DISTRICT_SIZE, out?: District): District {
  const gx = Math.floor(x / size);
  const gz = Math.floor(z / size);
  let b1 = 1e30;
  let b2 = 1e30;
  let cx = 0;
  let cz = 0;
  let h = 0;
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const ccx = gx + i;
      const ccz = gz + j;
      const px = (ccx + 0.2 + 0.6 * hash12(ccx, ccz)) * size;
      const pz = (ccz + 0.2 + 0.6 * hash12(ccx + 31.7, ccz + 31.7)) * size;
      const dx = x - px;
      const dz = z - pz;
      const d = dx * dx + dz * dz;
      if (d < b1) {
        b2 = b1;
        b1 = d;
        cx = px;
        cz = pz;
        h = hash12(ccx + 7.3, ccz + 7.3);
      } else if (d < b2) b2 = d;
    }
  }
  const angle = f32(h * 6.2831);
  const o = out ?? ({} as District);
  o.cx = cx;
  o.cz = cz;
  o.hash = h;
  o.angle = angle;
  o.cos = Math.cos(angle);
  o.sin = Math.sin(angle);
  o.border = 0.5 * (Math.sqrt(b2) - Math.sqrt(b1));
  return o;
}

/** World → district-local (GLSL: p = rot2(a) · (wp − centre), rot2 = mat2(c, −s, s, c)). */
export function toLocal(d: District, x: number, z: number): [number, number] {
  const vx = x - d.cx;
  const vz = z - d.cz;
  return [d.cos * vx + d.sin * vz, -d.sin * vx + d.cos * vz];
}

/** District-local → world. */
export function toWorld(d: District, px: number, pz: number): [number, number] {
  return [d.cx + d.cos * px - d.sin * pz, d.cz + d.sin * px + d.cos * pz];
}

/** Block hash (parks when ≥ 0.94 − 0.06·dens). */
export function blockHash(d: District, bx: number, bz: number): number {
  return hash12(bx + d.hash * 91, bz + d.hash * 91);
}

/** Lot hash (built when < 0.62 + 0.38·dens; roof colour by thirds). */
export function lotHash(d: District, lx: number, lz: number): number {
  return hash12(lx + 17 + d.hash * 13, lz + 17 + d.hash * 13);
}

/** Lot inset fractions [across, along] for a density (matches the shader). */
export function lotInset(dens: number): [number, number] {
  return [0.17 + (0.06 - 0.17) * dens, 0.28 + (0.08 - 0.28) * dens];
}
