/**
 * F-35A cockpit geometry, built in code (no assets). Coordinates are metres in the pilot EYE frame:
 * eye at the origin, forward = -Z, up = +Y, right = +X (same axes as the aircraft body).
 *
 * All static parts (glare shield, lip, hood face, instrument panel body, PCD bezel, sills, side
 * consoles, canopy rails and rear canopy bow) are merged into ONE vertex-coloured geometry → one draw
 * call. The side-stick and throttle are separate small groups so they can move with the pilot inputs.
 *
 * The glare-shield lip sits GLARE_LIP_ANGLE below the boresight, which the HMD layout uses to keep its
 * symbology above the cockpit panel.
 */
import {
  BoxGeometry,
  BufferGeometry,
  CatmullRomCurve3,
  Color,
  CylinderGeometry,
  Float32BufferAttribute,
  Group,
  Matrix4,
  Mesh,
  Quaternion,
  SphereGeometry,
  TubeGeometry,
  Vector3,
  type Material,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { GLARE_LIP_ANGLE } from '../hmd/layout';

/** Panoramic cockpit display placement (eye frame). */
export const PCD = {
  /** Screen size (m). The real PCD is 20x8 in (0.51 x 0.20 m); scaled up ~1.25x for phone legibility. */
  width: 0.8,
  height: 0.32,
  /** Distance from the eye to the screen centre (m). */
  dist: 0.66,
  /** Angle (rad) of the screen's top edge below the boresight. */
  topAngle: GLARE_LIP_ANGLE + 0.06,
};

/** Up-front display (small strip under the glare-shield lip, above the PCD). */
export const UFD = { width: 0.26, height: 0.03 };

const LIP_Z = -0.64;
const LIP_Y = LIP_Z * Math.tan(GLARE_LIP_ANGLE);
const HALF_W = 0.6;
/** Up-front display screen centre (in the hood face, just under the lip). */
export const UFD_POS = new Vector3(0, LIP_Y - 0.026, LIP_Z - 0.012);

/** Centre, orientation and size of the PCD screen plane facing the eye. */
export function pcdFrame(out: { center: Vector3; quat: Quaternion }): { center: Vector3; quat: Quaternion } {
  const halfAng = Math.atan(PCD.height / 2 / PCD.dist);
  const ang = PCD.topAngle + halfAng;
  out.center.set(0, -Math.sin(ang) * PCD.dist, -Math.cos(ang) * PCD.dist);
  // face the eye: rotate about X so the plane normal (+Z) points back up toward the origin
  out.quat.setFromAxisAngle(new Vector3(1, 0, 0), -ang);
  return out;
}

function colorize(g: BufferGeometry, hex: number): BufferGeometry {
  const c = new Color(hex);
  const n = g.getAttribute('position').count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    arr[i * 3] = c.r;
    arr[i * 3 + 1] = c.g;
    arr[i * 3 + 2] = c.b;
  }
  g.setAttribute('color', new Float32BufferAttribute(arr, 3));
  if (g.getAttribute('uv')) g.deleteAttribute('uv');
  if (!g.index) {
    const idx: number[] = [];
    for (let i = 0; i < n; i++) idx.push(i);
    g.setIndex(idx);
  }
  return g;
}

function place(g: BufferGeometry, pos: Vector3, quat?: Quaternion): BufferGeometry {
  const m = new Matrix4().compose(pos, quat ?? new Quaternion(), new Vector3(1, 1, 1));
  g.applyMatrix4(m);
  return g;
}

/** Lip droop (m) at normalised span u (-1..1): flat across the PCD, curving down at the ends. */
function droop(u: number): number {
  const k = Math.max(0, (Math.abs(u) - 0.74) / 0.26);
  return 0.2 * k * k;
}

/** Glare-shield top: a gently curved hood from the lip forward over the nose coaming. */
function glareShield(): BufferGeometry {
  const nu = 24;
  const nv = 6;
  const pos: number[] = [];
  const idx: number[] = [];
  for (let j = 0; j <= nv; j++) {
    const v = j / nv;
    for (let i = 0; i <= nu; i++) {
      const u = (i / nu) * 2 - 1;
      const hw = HALF_W + 0.04 * v;
      const x = u * hw;
      const z = LIP_Z + 0.07 * u * u - 0.42 * v;
      const y = LIP_Y - 0.07 * v - droop(u) + 0.01 * (1 - u * u);
      pos.push(x, y, z);
    }
  }
  for (let j = 0; j < nv; j++) {
    for (let i = 0; i < nu; i++) {
      const a = j * (nu + 1) + i;
      const b = a + 1;
      const c = a + nu + 1;
      const d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function lipCurve(dy = 0, dz = 0): CatmullRomCurve3 {
  const pts: Vector3[] = [];
  for (let i = 0; i <= 16; i++) {
    const u = (i / 16) * 2 - 1;
    pts.push(new Vector3(u * HALF_W, LIP_Y - droop(u) + 0.01 * (1 - u * u) + dy, LIP_Z + 0.07 * u * u + dz));
  }
  return new CatmullRomCurve3(pts);
}

/** Hood face hanging under the lip (a ribbon following the lip curve). */
function hoodFace(depth: number): BufferGeometry {
  const top = lipCurve(-0.004, -0.004);
  const n = 24;
  const pos: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= n; i++) {
    const p = top.getPoint(i / n);
    pos.push(p.x, p.y, p.z);
    pos.push(p.x, p.y - depth, p.z - 0.02);
  }
  for (let i = 0; i < n; i++) {
    const a = i * 2;
    idx.push(a, a + 1, a + 2, a + 2, a + 1, a + 3);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function tube(points: Vector3[], radius: number, seg = 24): BufferGeometry {
  return new TubeGeometry(new CatmullRomCurve3(points), seg, radius, 6, false);
}

export interface CockpitMeshes {
  /** Merged static cockpit shell. */
  shell: BufferGeometry;
  stick: Group;
  throttle: Group;
  /** Stick pivot rest orientation (for input animation). */
  stickBase: Quaternion;
  throttleZ0: number;
}

/** Build the static shell geometry + the movable controls (materials supplied by the caller). */
export function buildCockpit(controlMat: Material, gripMat: Material): CockpitMeshes {
  const parts: BufferGeometry[] = [];
  const C = {
    glare: 0x33373c,
    lip: 0x4a4f55,
    face: 0x1d1f22,
    panel: 0x42464c,
    bezel: 0x141517,
    sill: 0x575d64,
    console: 0x4a4f56,
    frame: 0x656b73,
    panelLight: 0x5a6068,
    panelDark: 0x2a2d31,
  };
  parts.push(colorize(glareShield(), C.glare));
  parts.push(colorize(new TubeGeometry(lipCurve(), 32, 0.011, 6, false), C.lip));
  parts.push(colorize(hoodFace(0.046), C.face));

  // PCD bezel + instrument panel body (facing the eye)
  const fr = pcdFrame({ center: new Vector3(), quat: new Quaternion() });
  const back = new Vector3(0, 0, -1).applyQuaternion(fr.quat);
  parts.push(colorize(place(new BoxGeometry(PCD.width + 0.036, PCD.height + 0.05, 0.03), fr.center.clone().addScaledVector(back, 0.018), fr.quat), C.bezel));
  parts.push(colorize(place(new BoxGeometry(1.25, 0.7, 0.02), fr.center.clone().addScaledVector(back, 0.045).add(new Vector3(0, -0.12, 0)), fr.quat), C.panel));
  // UFD housing set into the hood face, under the lip
  parts.push(colorize(place(new BoxGeometry(UFD.width + 0.018, UFD.height + 0.01, 0.012), UFD_POS.clone().add(new Vector3(0, 0, -0.008))), C.bezel));

  // canopy sills (rails along the canopy edge) + side consoles
  for (const s of [-1, 1]) {
    parts.push(
      colorize(
        tube(
          [
            new Vector3(s * 0.56, LIP_Y - 0.2, LIP_Z + 0.14),
            new Vector3(s * 0.56, -0.24, -0.3),
            new Vector3(s * 0.56, -0.21, 0.05),
            new Vector3(s * 0.52, -0.17, 0.42),
          ],
          0.024,
        ),
        C.frame,
      ),
    );
    parts.push(colorize(place(new BoxGeometry(0.12, 0.07, 1.0), new Vector3(s * 0.57, -0.29, -0.08)), C.sill));
    parts.push(colorize(place(new BoxGeometry(0.26, 0.2, 0.78), new Vector3(s * 0.43, -0.52, -0.1)), C.console));
    // switch panels on the console tops (slightly lighter / darker patches)
    for (let k = 0; k < 3; k++) {
      const col = k === 1 ? C.panelDark : C.panelLight;
      parts.push(colorize(place(new BoxGeometry(0.2, 0.006, 0.16), new Vector3(s * 0.44, -0.418, -0.36 + k * 0.2)), col));
    }
    // hood side cheek between the glare shield end and the sill
    parts.push(colorize(place(new BoxGeometry(0.08, 0.26, 0.3), new Vector3(s * 0.53, -0.4, -0.5)), C.panel));
  }
  // rear canopy bow (behind the pilot's head — seen when looking back)
  const bow: Vector3[] = [];
  for (let i = 0; i <= 10; i++) {
    const a = Math.PI * (i / 10);
    bow.push(new Vector3(-Math.cos(a) * 0.52, -0.17 + Math.sin(a) * 0.55, 0.5));
  }
  parts.push(colorize(tube(bow, 0.03, 30), C.frame));

  // ejection handle (yellow / black) on the seat bucket between the knees
  for (let k = 0; k < 4; k++) {
    parts.push(colorize(place(new BoxGeometry(0.035, 0.022, 0.03), new Vector3(-0.0525 + k * 0.035, -0.6, -0.22)), k % 2 === 0 ? 0xe8c020 : 0x151515));
  }
  const shell = mergeGeometries(parts, false)!;
  for (const p of parts) p.dispose();
  shell.computeBoundingSphere();

  // side-stick (right console)
  const stick = new Group();
  stick.position.set(0.4, -0.415, -0.28);
  const shaft = new Mesh(new CylinderGeometry(0.009, 0.012, 0.09, 8), controlMat);
  shaft.position.y = 0.045;
  const grip = new Mesh(new CylinderGeometry(0.018, 0.021, 0.085, 10), gripMat);
  grip.position.set(0, 0.12, 0.004);
  grip.rotation.x = -0.18;
  const cap = new Mesh(new SphereGeometry(0.02, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2), gripMat);
  cap.position.set(0, 0.162, -0.004);
  stick.add(shaft, grip, cap);
  const boot = new Mesh(new CylinderGeometry(0.03, 0.035, 0.02, 10), controlMat);
  boot.position.y = 0.005;
  stick.add(boot);

  // throttle (left console): lever sliding fore/aft in a slot
  const throttle = new Group();
  throttle.position.set(-0.42, -0.415, -0.16);
  const slot = new Mesh(new BoxGeometry(0.04, 0.01, 0.2), controlMat);
  slot.position.set(0, 0, -0.06);
  const lever = new Group();
  const arm = new Mesh(new BoxGeometry(0.016, 0.08, 0.02), controlMat);
  arm.position.y = 0.04;
  const handle = new Mesh(new BoxGeometry(0.05, 0.045, 0.06), gripMat);
  handle.position.set(0.005, 0.09, 0);
  lever.add(arm, handle);
  lever.name = 'lever';
  throttle.add(slot, lever);

  return { shell, stick, throttle, stickBase: stick.quaternion.clone(), throttleZ0: 0 };
}

