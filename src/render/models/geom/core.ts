/**
 * Geometry core helpers for the procedural model pipeline.
 *
 * Every geometry that flows through the model builders is normalised to the SAME attribute
 * layout so they can always be merged: NON-indexed, with `position`, `normal`, `uv` and `color`
 * (RGB, default white). Model convention: nose = local -Z, up = +Y, right wing = +X, metres.
 */
import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  CylinderGeometry,
  Euler,
  Float32BufferAttribute,
  Matrix4,
  Quaternion,
  SphereGeometry,
  Vector3,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

const _v0 = new Vector3();
const _v1 = new Vector3();
const _v2 = new Vector3();
const _m = new Matrix4();
const _q = new Quaternion();
const _c = new Color();
const _e = new Euler();

/** Convert to the canonical non-indexed layout (position, normal, uv, color). */
export function finalize(geo: BufferGeometry, color: number | Color = 0xffffff): BufferGeometry {
  let g = geo.index ? geo.toNonIndexed() : geo;
  if (g !== geo) geo.dispose();
  // Drop attributes we do not use (uv1, tangents, ...).
  for (const name of Object.keys(g.attributes)) {
    if (name !== 'position' && name !== 'normal' && name !== 'uv' && name !== 'color') g.deleteAttribute(name);
  }
  const n = g.attributes.position.count;
  if (!g.attributes.normal) g.computeVertexNormals();
  if (!g.attributes.uv) g.setAttribute('uv', new Float32BufferAttribute(new Float32Array(n * 2), 2));
  if (!g.attributes.color || g.attributes.color.itemSize !== 3) {
    if (g.attributes.color) g.deleteAttribute('color');
    g.setAttribute('color', new Float32BufferAttribute(new Float32Array(n * 3), 3));
    setColor(g, color);
  }
  g.clearGroups();
  return g;
}

/** Fill the colour attribute with a single colour (sRGB hex → linear working space). */
export function setColor(geo: BufferGeometry, color: number | Color): BufferGeometry {
  const c = typeof color === 'number' ? _c.setHex(color) : _c.copy(color);
  const attr = geo.attributes.color as BufferAttribute;
  for (let i = 0; i < attr.count; i++) attr.setXYZ(i, c.r, c.g, c.b);
  attr.needsUpdate = true;
  return geo;
}

/** Transform in place (positions + normals). Handles mirroring (negative determinant) by flipping winding. */
export function transform(geo: BufferGeometry, m: Matrix4): BufferGeometry {
  geo.applyMatrix4(m);
  if (m.determinant() < 0) flipWinding(geo, false);
  return geo;
}

/** Translate / rotate (Euler XYZ, radians) / scale helper returning the same geometry. */
export function place(
  geo: BufferGeometry,
  pos: [number, number, number] = [0, 0, 0],
  rot: [number, number, number] = [0, 0, 0],
  scale: [number, number, number] = [1, 1, 1],
): BufferGeometry {
  _q.setFromEuler(_e.set(rot[0], rot[1], rot[2], 'XYZ'));
  _m.compose(_v0.set(pos[0], pos[1], pos[2]), _q, _v1.set(scale[0], scale[1], scale[2]));
  return transform(geo, _m);
}

/** Reverse triangle winding of a non-indexed geometry (and optionally negate normals). */
export function flipWinding(geo: BufferGeometry, negateNormals = true): BufferGeometry {
  const count = geo.attributes.position.count;
  for (const name of Object.keys(geo.attributes)) {
    const a = geo.attributes[name] as BufferAttribute;
    const s = a.itemSize;
    const arr = a.array as Float32Array;
    for (let t = 0; t + 2 < count; t += 3) {
      for (let k = 0; k < s; k++) {
        const i1 = (t + 1) * s + k;
        const i2 = (t + 2) * s + k;
        const tmp = arr[i1];
        arr[i1] = arr[i2];
        arr[i2] = tmp;
      }
    }
    a.needsUpdate = true;
  }
  if (negateNormals && geo.attributes.normal) {
    const n = geo.attributes.normal.array as Float32Array;
    for (let i = 0; i < n.length; i++) n[i] = -n[i];
  }
  return geo;
}

/** Mirror across the YZ plane (x → -x) keeping outward winding. Returns a new geometry. */
export function mirrorX(geo: BufferGeometry): BufferGeometry {
  const g = geo.clone();
  g.scale(-1, 1, 1); // three negates normals.x via normalMatrix
  flipWinding(g, false);
  return g;
}

/** Signed volume (m³) of a closed non-indexed triangle soup — positive when the winding is outward. */
export function signedVolume(geo: BufferGeometry): number {
  const p = geo.attributes.position;
  let vol = 0;
  for (let i = 0; i + 2 < p.count; i += 3) {
    _v0.fromBufferAttribute(p, i);
    _v1.fromBufferAttribute(p, i + 1);
    _v2.fromBufferAttribute(p, i + 2);
    vol += _v0.dot(_v1.cross(_v2));
  }
  return vol / 6;
}

/** Ensure outward winding for (approximately) closed shapes; recomputes normals when flipped. */
export function ensureOutward(geo: BufferGeometry): BufferGeometry {
  geo.computeBoundingBox();
  const c = geo.boundingBox!.getCenter(new Vector3());
  // volume relative to the centre is translation-invariant for closed meshes but more robust numerically
  geo.translate(-c.x, -c.y, -c.z);
  const v = signedVolume(geo);
  geo.translate(c.x, c.y, c.z);
  if (v < 0) flipWinding(geo, true);
  return geo;
}

/** Merge canonical geometries (all must be finalized). Returns null for an empty list. */
export function merge(geos: BufferGeometry[]): BufferGeometry | null {
  if (geos.length === 0) return null;
  if (geos.length === 1) return geos[0];
  const g = mergeGeometries(geos, false);
  if (!g) throw new Error('mergeGeometries failed (attribute mismatch)');
  return g;
}

/** Flat-shade a non-indexed geometry (per-face normals) — for faceted parts. */
export function flatNormals(geo: BufferGeometry): BufferGeometry {
  const p = geo.attributes.position;
  const n = geo.attributes.normal as BufferAttribute;
  for (let i = 0; i + 2 < p.count; i += 3) {
    _v0.fromBufferAttribute(p, i);
    _v1.fromBufferAttribute(p, i + 1);
    _v2.fromBufferAttribute(p, i + 2);
    _v1.sub(_v0);
    _v2.sub(_v0);
    _v1.cross(_v2).normalize();
    for (let k = 0; k < 3; k++) n.setXYZ(i + k, _v1.x, _v1.y, _v1.z);
  }
  n.needsUpdate = true;
  return geo;
}

/* ───────────── primitives (all canonical) ───────────── */

export function box(w: number, h: number, d: number, color = 0xffffff): BufferGeometry {
  return finalize(new BoxGeometry(w, h, d), color);
}

/** Cylinder along Y (three default). */
export function cylinder(rTop: number, rBottom: number, h: number, seg = 10, color = 0xffffff, open = false): BufferGeometry {
  return finalize(new CylinderGeometry(rTop, rBottom, h, seg, 1, open), color);
}

/** Cylinder along Z (from z0 to z1). */
export function cylinderZ(r0: number, r1: number, z0: number, z1: number, seg = 10, color = 0xffffff, open = false): BufferGeometry {
  const g = new CylinderGeometry(r1, r0, Math.abs(z1 - z0), seg, 1, open);
  g.rotateX(Math.PI / 2); // +Y → +Z ; top (r1) ends at +Z
  g.translate(0, 0, (z0 + z1) / 2);
  return finalize(g, color);
}

/** Cylinder along X. */
export function cylinderX(r: number, len: number, seg = 10, color = 0xffffff): BufferGeometry {
  const g = new CylinderGeometry(r, r, len, seg, 1, false);
  g.rotateZ(Math.PI / 2);
  return finalize(g, color);
}

export function ellipsoid(rx: number, ry: number, rz: number, wSeg = 12, hSeg = 8, color = 0xffffff): BufferGeometry {
  const g = new SphereGeometry(1, wSeg, hSeg);
  g.scale(rx, ry, rz);
  return finalize(g, color);
}

/** Half ellipsoid (upper dome, y ≥ 0). */
export function dome(rx: number, ry: number, rz: number, wSeg = 12, hSeg = 5, color = 0xffffff): BufferGeometry {
  const g = new SphereGeometry(1, wSeg, hSeg, 0, Math.PI * 2, 0, Math.PI / 2);
  g.scale(rx, ry, rz);
  return finalize(g, color);
}

/** Count triangles of a canonical (non-indexed) geometry. */
export function triCount(geo: BufferGeometry): number {
  return geo.index ? geo.index.count / 3 : geo.attributes.position.count / 3;
}

/** Box-projected UVs (per-triangle dominant axis) in metres × scale — for tiling grime textures. */
export function boxUV(geo: BufferGeometry, scale = 0.25): BufferGeometry {
  const p = geo.attributes.position.array as Float32Array;
  const uv = geo.attributes.uv.array as Float32Array;
  for (let t = 0; t < p.length / 9; t++) {
    const o = t * 9;
    const ax = p[o + 3] - p[o];
    const ay = p[o + 4] - p[o + 1];
    const az = p[o + 5] - p[o + 2];
    const bx = p[o + 6] - p[o];
    const by = p[o + 7] - p[o + 1];
    const bz = p[o + 8] - p[o + 2];
    const nx = Math.abs(ay * bz - az * by);
    const ny = Math.abs(az * bx - ax * bz);
    const nz = Math.abs(ax * by - ay * bx);
    for (let k = 0; k < 3; k++) {
      const x = p[o + k * 3];
      const y = p[o + k * 3 + 1];
      const z = p[o + k * 3 + 2];
      const i = (t * 3 + k) * 2;
      if (ny >= nx && ny >= nz) {
        uv[i] = x * scale;
        uv[i + 1] = z * scale;
      } else if (nx >= nz) {
        uv[i] = z * scale;
        uv[i + 1] = y * scale;
      } else {
        uv[i] = x * scale;
        uv[i + 1] = y * scale;
      }
    }
  }
  geo.attributes.uv.needsUpdate = true;
  return geo;
}
