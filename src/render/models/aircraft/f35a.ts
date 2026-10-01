/**
 * Lockheed Martin F-35A Lightning II — procedural hero model (~6k triangles).
 *
 * Built from lofted chined fuselage sections, caret/DSI intakes, a single-piece bubble canopy,
 * diamond-airfoil trapezoidal wings with LE flaps + flaperons, canted twin tails with rudders,
 * all-moving stabilators, a serrated variable-area F135 nozzle, EOTS window, internal bays with
 * animated doors, beast-mode pylons, and a pilot; ambient occlusion is baked into the vertex colours.
 * Nose = -Z, up = +Y, right = +X, origin ≈ CG.
 *
 * Stations: `s` = metres aft of the nose tip; model z = Z0 + s.
 */
import { Float32BufferAttribute, Vector3 } from 'three';
import { ModelBuilder } from '../ModelBuilder';
import { box, ellipsoid, flatNormals, merge, mirrorX, place, setColor } from '../geom/core';
import { bandBetween, latheZ, liftingSurface, loftRings, prismX, superRing, type LoftStation, type SurfaceSection } from '../geom/loft';
import { lerp, samples, tableCurves } from '../geom/curves';
import type { AtlasBounds } from '../geom/atlas';
import type { AircraftPrototype, DriveDef, StoreSlot } from './types';
import { registerF35Materials } from './liveries';
import type { BufferGeometry } from 'three';

const Z0 = -8.3;
const DEG = Math.PI / 180;
const Y_CEIL = -0.27; // weapons bay ceiling
const BAY_S0 = 8.1;
const BAY_S1 = 11.9;
const DOOR_Y = -0.8;

/**
 * AO bake tuning for the F-35A airframe (see geom/ao.ts): ~75 ms on a desktop CPU, once per session
 * behind the loading screen; one refinement pass adds ~10% LOD0 triangles (LOD1 is unchanged).
 */
export const F35_AO = { rays: 16, cell: 0.12, maxDist: 1.0, strength: 1, floor: 0.3, refine: 1, splitLen: 1.0, splitDelta: 0.35 };

export const F35_ATLAS: AtlasBounds = { xMax: 5.6, zMin: -8.45, zMax: 7.45, yMin: -1.1, yMax: 2.65 };

/* ───────────── fuselage section table ─────────────
 * shelf: 1 = intake region, where the lower fuselage steps inboard (vertical wall at the duct's inner
 * side) and the chine becomes a thin ledge overhanging the caret intakes.
 *   s,    yTop, wTop, ySh,  xCh,  yCh,   xLo,  yLo,   yBot, shelf */
const FUS = tableCurves([
  // deep, wide, blunt forebody and a fat mid-body (F-35 'chunky' side profile, reviewer i1)
  [0.0, 0.02, 0.0, 0.02, 0.04, -0.02, 0.02, -0.05, -0.06, 0],
  [0.3, 0.25, 0.08, 0.21, 0.33, -0.03, 0.2, -0.26, -0.27, 0],
  [1.0, 0.48, 0.14, 0.42, 0.6, -0.02, 0.36, -0.49, -0.51, 0],
  [2.0, 0.64, 0.2, 0.57, 0.79, 0.0, 0.47, -0.65, -0.68, 0],
  [3.0, 0.7, 0.25, 0.63, 0.9, 0.03, 0.52, -0.71, -0.74, 0],
  [3.6, 0.74, 0.3, 0.66, 0.98, 0.04, 0.56, -0.75, -0.78, 0],
  [4.6, 0.8, 0.38, 0.71, 1.1, 0.06, 0.6, -0.78, -0.81, 0.15],
  [5.0, 0.83, 0.42, 0.74, 1.18, 0.07, 0.6, -0.79, -0.82, 0.9],
  [5.4, 0.9, 0.48, 0.8, 1.38, 0.08, 0.6, -0.8, -0.83, 1],
  [6.4, 1.06, 0.58, 0.95, 1.6, 0.08, 0.62, -0.8, -0.83, 1],
  [7.4, 1.16, 0.66, 1.02, 1.74, 0.07, 0.7, -0.8, -0.83, 1],
  [8.4, 1.15, 0.68, 1.01, 1.76, 0.06, 1.22, -0.8, -0.84, 0],
  [10.4, 1.04, 0.66, 0.92, 1.68, 0.05, 1.24, -0.8, -0.83, 0],
  [11.8, 0.9, 0.6, 0.78, 1.5, 0.05, 1.12, -0.78, -0.81, 0],
  [13.0, 0.68, 0.53, 0.58, 1.28, 0.05, 0.97, -0.58, -0.6, 0],
  [14.1, 0.53, 0.43, 0.46, 1.14, 0.05, 0.82, -0.45, -0.47, 0],
]);

/** Right half of a section, from bottom centre (0) to top centre (8). */
function halfSection(s: number, bay = false): [number, number][] {
  const [yTop, wTop, ySh, xCh, yCh, xLo, yLo, yBot, shelfRaw] = FUS.map((f) => f(s));
  const shelf = Math.min(1, Math.max(0, shelfRaw));
  const side: [number, number] = [
    lerp(lerp(xLo, xCh, 0.62), xLo + 0.05, shelf),
    lerp(lerp(yLo, yCh, 0.5), yCh - 0.07, shelf),
  ];
  if (bay) {
    // flat belly out to the door hinge, then the cavity wall up to the ceiling
    return [
      [0, Y_CEIL],
      [0.93, Y_CEIL],
      [0.95, yLo],
      [xLo, yLo],
      [xCh, yCh],
      [lerp(xCh, wTop, 0.5), lerp(yCh, ySh, 0.62)],
      [wTop, ySh],
      [wTop * 0.5, lerp(ySh, yTop, 0.82)],
      [0, yTop],
    ];
  }
  return [
    [0, yBot],
    [xLo * 0.55, yBot + (yLo - yBot) * 0.25],
    [xLo, yLo],
    side,
    [xCh, yCh],
    [lerp(xCh, wTop, 0.5), lerp(yCh, ySh, 0.62)],
    [wTop, ySh],
    [wTop * 0.5, lerp(ySh, yTop, 0.82)],
    [0, yTop],
  ];
}

/** Full CCW ring (16 points). Chines at indices 4 and 12. */
function sectionRing(s: number, bay = false): number[] {
  const r = halfSection(s, bay);
  const left = r.slice(1, 8).reverse().map(([x, y]) => [-x, y] as [number, number]);
  return [...r, ...left].flat();
}

/** Height of the upper fuselage surface at |x| for station s (walks chine → top centre). */
function upperY(s: number, x: number): number {
  const r = halfSection(s);
  x = Math.abs(x);
  for (let i = 4; i < 8; i++) {
    const [x0, y0] = r[i];
    const [x1, y1] = r[i + 1];
    if (x <= x0 && x >= x1) return lerp(y0, y1, (x0 - x) / Math.max(1e-6, x0 - x1));
  }
  return x > r[4][0] ? r[4][1] : r[8][1];
}

function fuselage(): BufferGeometry {
  const st = (s: number, bay = false): LoftStation => ({ z: Z0 + s, ring: sectionRing(s, bay) });
  const fwd = samples(0, BAY_S0, 30, [0.35, 1, 2, 3, 3.6, 4.6, 5, 5.4, 6.4, 7.4]).map((s) => st(s));
  const bay = samples(BAY_S0, BAY_S1, 8, [8.4, 10.4]).map((s) => st(s, true));
  const aft = samples(BAY_S1, 14.1, 7, [13]).map((s) => st(s));
  const all = [0, 1, 2, 3, 4, 12, 13, 14, 15];
  return merge([
    loftRings(fwd, { creases: [3, 4, 12, 13] }),
    loftRings([st(BAY_S0), st(BAY_S0 + 0.001, true)], { creases: all }),
    loftRings(bay, { creases: [1, 2, 3, 4, 12, 13, 14, 15] }),
    loftRings([st(BAY_S1 - 0.001, true), st(BAY_S1)], { creases: all }),
    loftRings(aft, { creases: [4, 12], capEnd: true }),
  ])!;
}

/* ───────────── canopy (single-piece bubble) ───────────── */
const CANOPY = tableCurves([
  // s,  halfWidth, topY
  [3.4, 0.22, 0.72],
  [3.8, 0.4, 0.96],
  [4.3, 0.49, 1.18],
  [4.9, 0.52, 1.33],
  [5.5, 0.52, 1.37],
  [6.1, 0.5, 1.33],
  [6.6, 0.46, 1.23],
  [7.2, 0.4, 1.09],
]);

function canopy(): BufferGeometry {
  const stations: LoftStation[] = samples(3.4, 7.2, 14).map((s) => {
    const [w, top] = CANOPY.map((f) => f(s));
    const y0 = upperY(s, 0);
    const ring: number[] = [];
    const N = 12;
    for (let i = 0; i <= N; i++) {
      const th = (i / N) * Math.PI;
      const x = Math.cos(th) * w;
      const base = upperY(s, x) - 0.015;
      const k = Math.pow(Math.sin(th), 0.75);
      ring.push(x, base + (Math.max(top, y0 + 0.02) - base) * k);
    }
    ring.push(-w * 0.5, y0 - 0.12, w * 0.5, y0 - 0.12);
    return { z: Z0 + s, ring };
  });
  return loftRings(stations, { capStart: true, capEnd: true });
}

/* ───────────── intakes (caret, DSI bump) ───────────── */

function roundedPoly(c: [number, number][], bevel: number): number[] {
  const out: number[] = [];
  const n = c.length;
  for (let i = 0; i < n; i++) {
    const p = c[i];
    const a = c[(i - 1 + n) % n];
    const b = c[(i + 1) % n];
    const da = Math.hypot(a[0] - p[0], a[1] - p[1]);
    const db = Math.hypot(b[0] - p[0], b[1] - p[1]);
    out.push(p[0] + ((a[0] - p[0]) / da) * bevel, p[1] + ((a[1] - p[1]) / da) * bevel);
    out.push(p[0] + ((b[0] - p[0]) / db) * bevel, p[1] + ((b[1] - p[1]) / db) * bevel);
  }
  return out;
}

const LIP_S = 5.3;
function lipZ(x: number, y: number): number {
  const top = 0.02;
  const bot = -0.72;
  return Z0 + LIP_S + 0.45 * ((top - y) / (top - bot)) + 0.22 * ((x - 0.62) / 0.5);
}

export interface Piece {
  geo: BufferGeometry;
  mat: string;
}

function intakeRight(): Piece[] {
  const out: Piece[] = [];
  const b = { add: (geo: BufferGeometry, mat: string) => out.push({ geo, mat }) };
  // corners CCW: bottom-inner, bottom-outer, top-outer, top-inner
  const outerLip = roundedPoly(
    [
      [0.66, -0.72],
      [1.16, -0.64],
      [1.29, -0.03],
      [0.64, 0.02],
    ],
    0.05,
  );
  const withZ = (ring: number[]): LoftStation => ({
    z: 0,
    ring,
    zs: Array.from({ length: ring.length / 2 }, (_, j) => lipZ(ring[2 * j], ring[2 * j + 1])),
  });
  const ringAt = (inner: number, outer: number, top: number, bottom: number, outerBottom: number) =>
    roundedPoly(
      [
        [inner + 0.02, bottom],
        [outer - 0.1, outerBottom],
        [outer, top - 0.06],
        [inner, top],
      ],
      0.06,
    );
  const cowl: LoftStation[] = [
    withZ(outerLip),
    { z: Z0 + 6.3, ring: ringAt(0.64, 1.42, 0.03, -0.76, -0.7) },
    { z: Z0 + 7.4, ring: ringAt(0.68, 1.52, 0.03, -0.79, -0.73) },
    { z: Z0 + 8.35, ring: ringAt(0.9, 1.38, -0.05, -0.78, -0.74) },
  ];
  b.add(loftRings(cowl, {}), 'skin');
  // inner duct + lip band
  const innerLip = roundedPoly(
    [
      [0.71, -0.67],
      [1.12, -0.6],
      [1.24, -0.08],
      [0.69, -0.03],
    ],
    0.04,
  );
  const innerSt = withZ(innerLip);
  const deep: LoftStation = { z: Z0 + LIP_S + 1.6, ring: innerLip.map((v, i) => (i % 2 === 0 ? v * 0.98 + 0.01 : v * 0.95 - 0.01)) };
  b.add(loftRings([innerSt, deep], { inward: true, capEnd: true, color: 0x1c1d1e }), 'dark');
  b.add(bandBetween(innerSt, withZ(outerLip)), 'skin');
  // diverterless supersonic inlet bump
  b.add(place(ellipsoid(0.21, 0.34, 0.98, 12, 8), [0.63, -0.35, Z0 + 4.85]), 'skin');
  return out;
}

/* ───────────── lifting surfaces ───────────── */

function wingAt(x: number): SurfaceSection {
  const t = (x - 1.2) / (5.35 - 1.2);
  return { x, y: lerp(0.0, -0.06, t), zLE: lerp(-1.1, 1.74, t), zTE: lerp(4.3, 3.34, t), t: lerp(0.28, 0.07, t) };
}
function hingeAt(x: number, f: number): Vector3 {
  const s = wingAt(x);
  return new Vector3(x, s.y, lerp(s.zLE, s.zTE, f));
}

function stabAt(x: number): SurfaceSection {
  const t = (x - 1.0) / (3.35 - 1.0);
  return { x, y: -0.02, zLE: lerp(4.55, 6.1, t), zTE: lerp(7.15, 6.95, t), t: lerp(0.14, 0.04, t) };
}

const FIN_SPAN = 2.2;
function finAt(u: number): SurfaceSection {
  const t = Math.max(0, u) / FIN_SPAN;
  return { x: u, y: 0, zLE: lerp(2.9, 4.75, t), zTE: lerp(5.72, 5.82, t), t: lerp(0.15, 0.045, t) };
}
const FIN_CANT = 25 * DEG;
const FIN_ROOT = new Vector3(1.0, 0.24, 0);
/** Transform a fin-local point/geometry (span +X) to the right fin position. */
function finMatrixPlace(g: BufferGeometry): BufferGeometry {
  return place(g, [FIN_ROOT.x, FIN_ROOT.y, FIN_ROOT.z], [0, 0, Math.PI / 2 - FIN_CANT]);
}
function finPoint(u: number, f: number): Vector3 {
  const s = finAt(u);
  const p = new Vector3(u, 0, lerp(s.zLE, s.zTE, f));
  p.applyAxisAngle(new Vector3(0, 0, 1), Math.PI / 2 - FIN_CANT);
  return p.add(FIN_ROOT);
}

/* ───────────── F135 variable-area nozzle ───────────── */

const NZ = 28;
/** Hinge ring: the petals pivot here, so it never moves and the joint to the fuselage stays closed. */
const NOZZLE_HINGE_Z = 5.9;
/** Exit radius (outer shell) closed at MIL and fully open in max AB: 13% of the open diameter. */
export const NOZZLE_EXIT_R = { closed: 0.52, open: 0.6 };
/** Exit radius the flame (spec engine radius) was tuned against; flames scale relative to it. */
const NOZZLE_NOMINAL_R = 0.555;
const NOZZLE_EXIT_ZS = Array.from({ length: NZ }, (_, j) => (j % 2 === 0 ? 7.02 : 6.84));

function nozzleRing(r: number): number[] {
  const ring: number[] = [];
  for (let j = 0; j < NZ; j++) {
    const a = (j / NZ) * Math.PI * 2;
    ring.push(Math.cos(a) * r, 0.03 + Math.sin(a) * r);
  }
  return ring;
}

/** Outer shell (metal) + interior liner (dark) at opening k (0 = closed / MIL, 1 = open / max AB). */
function nozzleAt(k: number): Piece[] {
  const exit = lerp(NOZZLE_EXIT_R.closed, NOZZLE_EXIT_R.open, k);
  const mid = lerp(0.61, 0.645, k);
  const shell = loftRings([
    { z: 5.3, ring: nozzleRing(0.7) },
    { z: NOZZLE_HINGE_Z, ring: nozzleRing(0.68) },
    { z: 6.45, ring: nozzleRing(mid) },
    { z: 0, ring: nozzleRing(exit), zs: NOZZLE_EXIT_ZS },
  ]);
  setColor(shell, 0x4d5053);
  // interior + turbine face: follows the exit, 15 mm inside the shell
  const liner = loftRings(
    [
      { z: 6.2, ring: nozzleRing(0.5) },
      { z: 0, ring: nozzleRing(exit - 0.015), zs: NOZZLE_EXIT_ZS.map((z) => z - 0.01) },
    ],
    { inward: true, capStart: true, color: 0x252322 },
  );
  return [
    { geo: shell, mat: 'metal' },
    { geo: liner, mat: 'dark' },
  ];
}

/**
 * Nozzle at its closed (MIL) pose with one relative morph target that opens it fully. The two poses
 * come from the same builder, so vertex order matches and the hinge ring has a zero delta.
 */
export function f35Nozzle(): Piece[] {
  const closed = nozzleAt(0);
  const open = nozzleAt(1);
  return closed.map((p, i) => {
    const g = p.geo;
    const delta = (name: 'position' | 'normal') => {
      const a = g.attributes[name].array as Float32Array;
      const b = open[i].geo.attributes[name].array as Float32Array;
      return new Float32BufferAttribute(b.map((v, j) => v - a[j]), 3);
    };
    g.morphAttributes.position = [delta('position')];
    g.morphAttributes.normal = [delta('normal')];
    g.morphTargetsRelative = true;
    return p;
  });
}

/* ───────────── model ───────────── */

export function buildF35(): AircraftPrototype {
  registerF35Materials(F35_ATLAS);
  const b = new ModelBuilder(
    (m) =>
      (({ skin: 'f35.skin', glass: 'glass.gold', dark: 'darkStd', metal: 'metal', pilot: 'darkStd' }) as Record<string, string>)[
        m
      ] ?? m,
    F35_ATLAS,
    ['skin'],
  );
  b.glassTint = 0x3a2c14;
  // baked AO (rest pose); the canopy glass (no vertex colours) only casts it, and the bay doors
  // are left out: closed, their inner faces would bake as dark as the sealed cavity
  b.ao = { ...F35_AO, skip: ['glass'], skipParts: ['doorOR', 'doorIR', 'doorOL', 'doorIL'] };
  const drives: DriveDef[] = [];

  // Fuselage + canopy
  b.add(fuselage(), 'skin');
  b.add(canopy(), 'glass');

  // Intakes (right, then mirrored)
  for (const p of intakeRight()) {
    b.add(p.geo, p.mat);
    b.add(mirrorX(p.geo), p.mat);
  }

  // Wings (static panels) — right then mirrored
  const W_ROOT = 1.2;
  const F_IN = 1.65;
  const F_OUT = 4.8;
  const TIP = 5.35;
  const LEF_C = 0.12;
  const FLAP_C = 0.8;
  const wingPanels = [
    liftingSurface([wingAt(W_ROOT), wingAt(F_IN)], { c0: LEF_C, c1: 1, capRoot: false }),
    liftingSurface([wingAt(F_IN), wingAt(F_OUT)], { c0: LEF_C, c1: FLAP_C }),
    liftingSurface([wingAt(F_OUT), wingAt(TIP)], { c0: LEF_C, c1: 1 }),
  ];
  for (const g of wingPanels) {
    b.add(g, 'skin');
    b.add(mirrorX(g), 'skin');
  }
  // Leading-edge flaps
  const lef = liftingSurface([wingAt(W_ROOT), wingAt(TIP)], { c0: 0, c1: LEF_C, capRoot: false });
  const lefA = hingeAt(W_ROOT, LEF_C);
  const lefB = hingeAt(TIP, LEF_C);
  b.addHinged('lefR', lef, 'skin', lefA, lefB);
  b.addHinged('lefL', mirrorX(lef), 'skin', lefB.clone().setX(-lefB.x), lefA.clone().setX(-lefA.x));
  drives.push({ part: 'lefR', kind: 'lef', side: 1, max: 25 * DEG }, { part: 'lefL', kind: 'lef', side: -1, max: 25 * DEG });
  // Flaperons
  const flap = liftingSurface([wingAt(F_IN), wingAt(F_OUT)], { c0: FLAP_C, c1: 1 });
  const flA = hingeAt(F_IN, FLAP_C);
  const flB = hingeAt(F_OUT, FLAP_C);
  b.addHinged('flapR', flap, 'skin', flA, flB);
  b.addHinged('flapL', mirrorX(flap), 'skin', flB.clone().setX(-flB.x), flA.clone().setX(-flA.x));
  drives.push(
    { part: 'flapR', kind: 'flaperon', side: 1, max: 20 * DEG, extra: 30 * DEG },
    { part: 'flapL', kind: 'flaperon', side: -1, max: 20 * DEG, extra: 30 * DEG },
  );

  // Stabilators (all-moving)
  const stab = liftingSurface([stabAt(1.0), stabAt(3.35)], { profile: 'diamond', capRoot: false });
  b.addPart('stabR', stab, 'skin', new Vector3(1.0, -0.02, 5.75), new Vector3(1, 0, 0));
  b.addPart('stabL', mirrorX(stab), 'skin', new Vector3(-1.0, -0.02, 5.75), new Vector3(1, 0, 0));
  drives.push(
    { part: 'stabR', kind: 'stab', side: 1, max: 20 * DEG, extra: 8 * DEG },
    { part: 'stabL', kind: 'stab', side: -1, max: 20 * DEG, extra: 8 * DEG },
  );

  // Twin canted vertical tails + rudders
  const RU0 = 0.25;
  const RU1 = FIN_SPAN - 0.25;
  const RUDDER_C = 0.7;
  const finParts = [
    liftingSurface([finAt(-0.25), finAt(RU0)], { c0: 0, c1: 1, capRoot: false }),
    liftingSurface([finAt(RU0), finAt(RU1)], { c0: 0, c1: RUDDER_C }),
    liftingSurface([finAt(RU1), finAt(FIN_SPAN)], { c0: 0, c1: 1 }),
  ].map(finMatrixPlace);
  for (const g of finParts) {
    b.add(g, 'skin');
    b.add(mirrorX(g), 'skin');
  }
  const rudder = finMatrixPlace(liftingSurface([finAt(RU0), finAt(RU1)], { c0: RUDDER_C, c1: 1 }));
  const rA = finPoint(RU0, RUDDER_C);
  const rB = finPoint(RU1, RUDDER_C);
  b.addHinged('rudderR', rudder, 'skin', rA, rB);
  // left rudder: hinge still pointing UP so +angle = TE right
  b.addHinged('rudderL', mirrorX(rudder), 'skin', rA.clone().setX(-rA.x), rB.clone().setX(-rB.x));
  drives.push(
    { part: 'rudderR', kind: 'rudder', side: 1, max: 25 * DEG, extra: 22 * DEG },
    { part: 'rudderL', kind: 'rudder', side: -1, max: 25 * DEG, extra: 22 * DEG },
  );

  // Tail booms carrying the stabilators
  const boom = loftRings(
    [
      [12.5, 0.5],
      [13.1, 1],
      [14.4, 1],
      [15.05, 0.7],
      [15.4, 0.25],
    ].map(([s, k]) => ({ z: Z0 + s, ring: superRing(1.03, 0.02, 0.2 * k, 0.21 * k, 2.6, 10) })),
    { capEnd: true },
  );
  b.add(boom, 'skin');
  b.add(mirrorX(boom), 'skin');

  // F135 variable-area nozzle (serrated exit), its own animated part: see f35Nozzle()
  for (const p of f35Nozzle()) b.addPart('nozzle', p.geo, p.mat, new Vector3(0, 0, 0), new Vector3(1, 0, 0));
  drives.push({ part: 'nozzle', kind: 'nozzle', side: 0, max: NOZZLE_EXIT_R.open / NOZZLE_NOMINAL_R, extra: NOZZLE_EXIT_R.closed / NOZZLE_NOMINAL_R });

  // EOTS faceted window under the nose
  {
    const ring8 = (r: number) => Array.from({ length: 8 }, (_, j) => [Math.cos((j / 8) * Math.PI * 2 + Math.PI / 8) * r, Math.sin((j / 8) * Math.PI * 2 + Math.PI / 8) * r]).flat();
    const g = loftRings(
      [
        { z: 0, ring: ring8(0.16) },
        { z: 0.14, ring: ring8(0.115) },
      ],
      { capEnd: true, creases: [0, 1, 2, 3, 4, 5, 6, 7] },
    );
    place(g, [0, -0.52, Z0 + 2.55], [Math.PI / 2, 0, 0], [1, 1, 1.45]);
    b.add(flatNormals(g), 'glass');
  }

  // Gun blister (GAU-22, upper left fuselage) and antennas
  b.add(place(ellipsoid(0.13, 0.085, 0.95, 10, 6), [-1.12, 0.42, -0.4]), 'skin');
  b.add(place(box(0.025, 0.2, 0.32, 0x55595d), [0, 1.24, 1.1], [-0.25, 0, 0]), 'pilot');
  b.add(place(box(0.025, 0.16, 0.28, 0x55595d), [0, -0.86, -2.2], [0.25, 0, 0]), 'pilot');

  // Pilot, ejection seat and glare shield (seen through the gold canopy) — kept inside the bubble
  const pilotParts = [
    place(box(0.44, 0.62, 0.22, 0x2b2c2e), [0, 0.93, -2.98], [-0.22, 0, 0]),
    place(box(0.38, 0.4, 0.26, 0x4a5142), [0, 0.93, -3.28], [-0.15, 0, 0]),
    place(ellipsoid(0.13, 0.145, 0.15, 12, 8, 0x3b3e42), [0, 1.12, -3.43]),
    place(ellipsoid(0.095, 0.065, 0.07, 10, 6, 0x101214), [0, 1.1, -3.53]),
    place(box(0.56, 0.1, 0.36, 0x1d1e20), [0, 0.84, -4.08]),
  ];
  b.add(merge(pilotParts)!, 'pilot');

  // Weapons bays: centre keel between the two bays (light grey interior)
  const bayLen = BAY_S1 - BAY_S0;
  const bayZ = Z0 + (BAY_S0 + BAY_S1) / 2;
  b.add(place(box(0.05, Math.abs(DOOR_Y - Y_CEIL) - 0.01, bayLen - 0.02, 0xb8bcbf), [0, (DOOR_Y + Y_CEIL) / 2, bayZ]), 'pilot');
  b.add(place(box(1.84, 0.015, bayLen - 0.02, 0xc4c8cb), [0, Y_CEIL - 0.008, bayZ]), 'pilot');

  // Bay doors (sawtooth ends) — right side: outer (hinge at x=0.95) and inner (hinge at x=0.08)
  const doorPoly = (x0: number, x1: number): [number, number][] => {
    const zA = Z0 + BAY_S0 + 0.02;
    const zB = Z0 + BAY_S1 - 0.02;
    const teeth = 3;
    const w = (x1 - x0) / teeth;
    const pts: [number, number][] = [];
    // CCW in (x, z-as-y) — front edge teeth
    pts.push([x0, zA]);
    for (let i = 0; i < teeth; i++) pts.push([x0 + (i + 0.5) * w, zA + 0.16], [x0 + (i + 1) * w, zA]);
    pts.push([x1, zB]);
    for (let i = teeth - 1; i >= 0; i--) pts.push([x0 + (i + 0.5) * w, zB - 0.16], [x0 + i * w, zB]);
    return pts;
  };
  const doorGeo = (x0: number, x1: number) => {
    // extrude footprint (x, z) along y: build in XY then rotate so +Z(extrusion) → -Y
    const pts = doorPoly(x0, x1);
    const poly = pts.map(([x, z]) => [x, z]).flat();
    const g = loftRings(
      [
        { z: 0, ring: poly },
        { z: 0.03, ring: poly },
      ],
      { creases: pts.map((_, i) => i), capStart: true, capEnd: true },
    );
    // (x, zf, e) → rotate +90° about X: y' = -e, z' = zf
    place(g, [0, DOOR_Y + 0.015, 0], [Math.PI / 2, 0, 0]);
    return g;
  };
  const dOuter = doorGeo(0.47, 0.95);
  const dInner = doorGeo(0.08, 0.47);
  const hz0 = Z0 + BAY_S0;
  b.addPart('doorOR', dOuter, 'skin', new Vector3(0.95, DOOR_Y, hz0), new Vector3(0, 0, 1));
  b.addPart('doorIR', dInner, 'skin', new Vector3(0.08, DOOR_Y, hz0), new Vector3(0, 0, -1));
  b.addPart('doorOL', mirrorX(dOuter), 'skin', new Vector3(-0.95, DOOR_Y, hz0), new Vector3(0, 0, -1));
  b.addPart('doorIL', mirrorX(dInner), 'skin', new Vector3(-0.08, DOOR_Y, hz0), new Vector3(0, 0, 1));
  drives.push(
    { part: 'doorOR', kind: 'door', side: 1, max: 100 * DEG },
    { part: 'doorIR', kind: 'door', side: 1, max: 92 * DEG },
    { part: 'doorOL', kind: 'door', side: -1, max: 100 * DEG },
    { part: 'doorIL', kind: 'door', side: -1, max: 92 * DEG },
  );

  // Beast-mode pylons (hidden unless external stores are loaded)
  const pylonAt = (x: number, name: string) => {
    const s = wingAt(x);
    const zc = lerp(s.zLE, s.zTE, 0.42);
    const top = s.y - s.t * 0.3;
    const prof: [number, number][] = [
      [zc - 0.6, top],
      [zc - 0.35, top - 0.3],
      [zc + 0.6, top - 0.3],
      [zc + 0.85, top],
    ];
    const g = prismX(prof, 0.1, 0xffffff, x - 0.05);
    b.addPart(name, g, 'skin', new Vector3(0, 0, 0), new Vector3(1, 0, 0));
    b.addPart(name, mirrorX(g), 'skin', new Vector3(0, 0, 0), new Vector3(1, 0, 0));
    return { x, y: top - 0.3, z: zc + 0.1 };
  };
  const pIn = pylonAt(2.35, 'pylonInner');
  const pMid = pylonAt(3.45, 'pylonMid');
  const pOut = pylonAt(4.75, 'pylonOuter');
  b.excludeFromLod1('pylonInner', 'pylonMid', 'pylonOuter');

  const built = b.build();

  const bayZc = Z0 + 9.55;
  const slots: StoreSlot[] = [];
  for (const side of [1, -1] as const) slots.push({ pos: [0.46 * side, -0.29, bayZc], internal: true, accepts: ['gbu31', 'aargm', 'aim120', 'gbu39'], side });
  for (const side of [1, -1] as const) slots.push({ pos: [0.78 * side, -0.36, bayZc - 0.1], internal: true, accepts: ['aim120', 'gbu39'], side });
  for (const side of [1, -1] as const) slots.push({ pos: [0.2 * side, -0.29, bayZc - 0.15], internal: true, accepts: ['aim120', 'gbu39'], side });
  for (const side of [1, -1] as const) slots.push({ pos: [pIn.x * side, pIn.y, pIn.z], internal: false, accepts: ['gbu31'], side, pylon: 'pylonInner' });
  for (const side of [1, -1] as const)
    slots.push({ pos: [pMid.x * side, pMid.y, pMid.z], internal: false, accepts: ['aim120', 'gbu31', 'aim9x'], side, pylon: 'pylonMid' });
  for (const side of [1, -1] as const) slots.push({ pos: [pOut.x * side, pOut.y, pOut.z], internal: false, accepts: ['aim9x', 'aim120'], side, pylon: 'pylonOuter' });

  return { type: 'f35a', lod0: built.lod0, lod1: built.lod1, drives, slots, fixedStores: [], triangles: built.triangles };
}
