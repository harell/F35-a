/**
 * World → screen projection for the HMD overlay (pure three.js math, no DOM — unit tested).
 *
 * The projector caches the camera's view matrix and the relevant projection-matrix terms once per
 * frame so that projecting dozens of points/directions is just a matrix-vector product and a divide.
 * Screen coordinates are CSS pixels with the origin at the top-left (x right, y down).
 */
import { Matrix4, Vector3 } from 'three';
import type { PerspectiveCamera } from 'three';

/** Result of a projection (reused by callers — never allocate one per call in hot paths). */
export interface ScreenPoint {
  /** Screen x/y (CSS px). Only meaningful when `front` is true. */
  x: number;
  y: number;
  /** View-space distance along the camera axis (m, > 0 in front of the camera). */
  depth: number;
  /** In front of the camera plane. */
  front: boolean;
  /** Inside the viewport (with the margin passed to the call). */
  onScreen: boolean;
  /** Screen-space direction (unit, y down) from the screen centre towards the point — valid even behind. */
  dirX: number;
  dirY: number;
  /** Angle between the camera axis and the point (rad). */
  offAxis: number;
}

export function makeScreenPoint(): ScreenPoint {
  return { x: 0, y: 0, depth: 0, front: false, onScreen: false, dirX: 0, dirY: -1, offAxis: 0 };
}

const _v = new Vector3();

export class Projector {
  width = 1;
  height = 1;
  cx = 0.5;
  cy = 0.5;
  /** Camera world position. */
  readonly eye = new Vector3();
  /** Camera world forward (unit). */
  readonly forward = new Vector3(0, 0, -1);
  /** Camera world up (unit). */
  readonly up = new Vector3(0, 1, 0);
  /** Camera world right (unit). */
  readonly right = new Vector3(1, 0, 0);
  /** tan(vertical half FOV). */
  tanHalfV = Math.tan(Math.PI / 6);
  /** Pixels per radian near the screen centre (vertical). */
  pxPerRad = 1;
  private readonly view = new Matrix4();
  private p0 = 1;
  private p5 = 1;
  private p8 = 0;
  private p9 = 0;

  /** Cache the camera state (call once per frame, after the camera moved). */
  update(camera: PerspectiveCamera, width: number, height: number): void {
    camera.updateMatrixWorld();
    this.view.copy(camera.matrixWorldInverse);
    const e = camera.projectionMatrix.elements;
    this.p0 = e[0];
    this.p5 = e[5];
    this.p8 = e[8];
    this.p9 = e[9];
    this.width = width;
    this.height = height;
    this.cx = width * 0.5;
    this.cy = height * 0.5;
    const m = camera.matrixWorld.elements;
    this.eye.set(m[12], m[13], m[14]);
    this.right.set(m[0], m[1], m[2]).normalize();
    this.up.set(m[4], m[5], m[6]).normalize();
    this.forward.set(-m[8], -m[9], -m[10]).normalize();
    this.tanHalfV = 1 / Math.max(1e-6, this.p5);
    this.pxPerRad = (height * 0.5) / this.tanHalfV;
  }

  /** Project a world-space point. Returns `out.front`. */
  point(p: Vector3, out: ScreenPoint, margin = 0): boolean {
    _v.copy(p).applyMatrix4(this.view);
    return this.fromView(_v.x, _v.y, _v.z, out, margin);
  }

  /** Project a world-space direction (a point at infinity). Returns `out.front`. */
  dir(d: Vector3, out: ScreenPoint, margin = 0): boolean {
    _v.copy(d).transformDirection(this.view);
    return this.fromView(_v.x, _v.y, _v.z, out, margin);
  }

  /** Project a view-space vector (camera looks down -Z). */
  fromView(x: number, y: number, z: number, out: ScreenPoint, margin = 0): boolean {
    const d = -z;
    const len = Math.hypot(x, y, z);
    out.depth = d;
    out.offAxis = len > 1e-9 ? Math.acos(Math.max(-1, Math.min(1, d / len))) : 0;
    const lat = Math.hypot(x, y);
    if (lat > 1e-9) {
      out.dirX = x / lat;
      out.dirY = -y / lat;
    } else {
      out.dirX = 0;
      out.dirY = d >= 0 ? 0 : 1;
    }
    out.front = d > 1e-6;
    if (!out.front) {
      out.x = this.cx + out.dirX * this.width * 4;
      out.y = this.cy + out.dirY * this.height * 4;
      out.onScreen = false;
      return false;
    }
    const ndcX = (this.p0 * x + this.p8 * z) / d;
    const ndcY = (this.p5 * y + this.p9 * z) / d;
    out.x = (ndcX * 0.5 + 0.5) * this.width;
    out.y = (0.5 - ndcY * 0.5) * this.height;
    out.onScreen = out.x >= margin && out.x <= this.width - margin && out.y >= margin && out.y <= this.height - margin;
    return true;
  }
}

/**
 * Intersect a ray from (cx, cy) in direction (dx, dy) with an axis-aligned ellipse centred at
 * (cx, cy) with radii (rx, ry). Writes the edge point into `out` (x, y).
 */
export function edgeOfEllipse(cx: number, cy: number, rx: number, ry: number, dx: number, dy: number, out: { x: number; y: number }): { x: number; y: number } {
  const l = Math.hypot(dx, dy) || 1;
  const ux = dx / l;
  const uy = dy / l;
  const t = 1 / Math.sqrt((ux * ux) / (rx * rx) + (uy * uy) / (ry * ry));
  out.x = cx + ux * t;
  out.y = cy + uy * t;
  return out;
}

/** Is (x, y) inside the ellipse (cx, cy, rx, ry)? */
export function insideEllipse(x: number, y: number, cx: number, cy: number, rx: number, ry: number): boolean {
  const u = (x - cx) / rx;
  const v = (y - cy) / ry;
  return u * u + v * v <= 1;
}
