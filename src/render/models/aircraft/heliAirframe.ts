/**
 * PROTOTYPE (helicopter rework, not wired into the game yet): one shared airframe for the civil helicopters over
 * Auckland, a modern twin-engine medium helicopter (AW169-like proportions), with liveries painted per triangle and
 * the branding as decals. Model frame as helicopters.ts: −Z nose, +Y up, origin at the cabin centre,
 * HELI_GEAR_HEIGHT.aw169 above the wheels / skids.
 *
 * The fuselage is lofted from superellipse rings (flat floor, near-flat cabin sides, a rounded nose with a raked
 * windscreen, the rear fuselage sweeping up into the tail boom); the livery and the glazing are painted onto it by
 * triangle position, so the bands follow the surface. Five- or four-blade rotor with tapered, swept-tip blades;
 * wheels in sponsons or skids; a rescue hoist, a FLIR ball and a searchlight as options.
 */
import { BufferGeometry, CanvasTexture, Color, Float32BufferAttribute, Group, Mesh, MeshStandardMaterial, PlaneGeometry, SRGBColorSpace, Vector3 } from 'three';
import { ModelBuilder } from '../ModelBuilder';
import { box, cylinder, cylinderX, cylinderZ, ellipsoid, ensureOutward, finalize, merge, mirrorX, place } from '../geom/core';
import { loftRings, prismX, superRing, type LoftStation } from '../geom/loft';

export interface HeliLivery {
  id: string;
  /** Upper fuselage, engine cowling. */
  top: number;
  /** Lower fuselage and belly. */
  belly: number;
  /** A cheat line between them (0 = none) and its height band (model y). */
  stripe: number;
  stripeY?: [number, number];
  /** Tail boom and fin. */
  boom: number;
  fin: number;
  /** A chequered (Battenburg) band along the lower cabin: its two colours, or null. */
  check: [number, number] | null;
  blade: number;
  tip: number;
  /** Side text, boom text, registration; colours of the text. */
  name: string;
  boomText: string;
  reg: string;
  text: number;
  /** The boom text's colour when the boom is painted differently from the cabin (default `text`). */
  boomTextColor?: number;
}

export interface HeliOptions {
  blades: 4 | 5;
  gear: 'wheels' | 'skids';
  hoist: boolean;
  flir: boolean;
  searchlight: boolean;
}

const GLASS = 0x1d2a35;
const GLASS_EDGE = 0x15181b;
const DARK = 0x1c1e21;
const METAL = 0x7a7e83;
const GREY = 0x3b3f44;

/** Fuselage stations: z, half width, bottom y, top y, superellipse exponent. */
const STATIONS: [number, number, number, number, number][] = [
  [-6.3, 0.1, -0.42, -0.22, 2],
  [-6.15, 0.36, -0.58, 0.0, 2.1],
  [-5.9, 0.62, -0.69, 0.2, 2.3],
  [-5.5, 0.84, -0.75, 0.42, 2.6],
  [-5.0, 0.99, -0.78, 0.64, 2.9],
  [-4.45, 1.07, -0.79, 0.83, 3.1],
  [-3.85, 1.11, -0.8, 0.95, 3.3],
  [-3.2, 1.13, -0.8, 1.0, 3.4],
  [-2.4, 1.14, -0.8, 1.02, 3.5],
  [-1.6, 1.14, -0.8, 1.02, 3.5],
  [-0.8, 1.14, -0.8, 1.02, 3.5],
  [0.0, 1.14, -0.8, 1.02, 3.5],
  [0.8, 1.14, -0.8, 1.02, 3.5],
  [1.5, 1.12, -0.78, 1.02, 3.4],
  [2.15, 1.04, -0.68, 1.0, 3.2],
  [2.8, 0.86, -0.42, 0.98, 2.9],
  [3.4, 0.62, -0.08, 0.95, 2.6],
  [4.0, 0.44, 0.2, 0.92, 2.3],
  [4.6, 0.36, 0.34, 0.9, 2.2],
  [6.0, 0.31, 0.42, 0.9, 2.1],
  [7.4, 0.26, 0.48, 0.92, 2.1],
  [8.3, 0.22, 0.52, 0.94, 2],
  [8.75, 0.16, 0.58, 0.9, 2],
];

/** The fuselage surface at z: half width, bottom and top, superellipse exponent (linear between stations). */
function sectionAt(z: number): { w: number; b: number; t: number; n: number } {
  const s = STATIONS;
  if (z <= s[0][0]) return { w: s[0][1], b: s[0][2], t: s[0][3], n: s[0][4] };
  for (let i = 1; i < s.length; i++) {
    if (z <= s[i][0]) {
      const f = (z - s[i - 1][0]) / (s[i][0] - s[i - 1][0]);
      const L = (k: number) => s[i - 1][k] + (s[i][k] - s[i - 1][k]) * f;
      return { w: L(1), b: L(2), t: L(3), n: L(4) };
    }
  }
  const e = s[s.length - 1];
  return { w: e[1], b: e[2], t: e[3], n: e[4] };
}

/** A point of the section at ring angle `a` (0 = right side, π/2 = top). */
function surfacePoint(z: number, a: number, lift = 0): [number, number, number] {
  const s = sectionAt(z);
  const cy = (s.b + s.t) / 2;
  const ry = (s.t - s.b) / 2;
  const c = Math.cos(a);
  const sn = Math.sin(a);
  const ux = Math.sign(c) * Math.pow(Math.abs(c), 2 / s.n);
  const uy = Math.sign(sn) * Math.pow(Math.abs(sn), 2 / s.n);
  // outward (approximate) normal of the superellipse, for decals and glazing lifted off the skin
  const nx = ux / s.w;
  const ny = uy / ry;
  const nl = Math.hypot(nx, ny) || 1;
  return [ux * s.w + (lift * nx) / nl, cy + uy * ry + (lift * ny) / nl, z];
}

/** The ring angle (right side, −π/2..π/2) at which the section at z reaches height y (clamped inside it). */
function angleAtY(z: number, y: number): number {
  const s = sectionAt(z);
  const cy = (s.b + s.t) / 2;
  const ry = (s.t - s.b) / 2;
  const v = Math.max(-0.995, Math.min(0.995, (y - cy) / ry));
  return Math.asin(Math.sign(v) * Math.pow(Math.abs(v), s.n / 2));
}

/** Livery and window heights (model y) the rings carry an edge at, rising with the rear fuselage. */
function breakLevels(L: HeliLivery, z: number): number[] {
  const [s0, s1] = L.stripeY ?? [-0.32, -0.12];
  const rise = z > 1.6 ? (z - 1.6) * 0.32 : 0;
  return [s0 + rise, s1 + rise, WIN_Y[0], WIN_Y[1]];
}
/** Points per ring segment, per side: belly → break 0 → break 1 → sill → window top → roof. */
const SEG = [4, 1, 3, 3, 4];
/** Cabin and cockpit window sill and top. */
const WIN_Y: [number, number] = [0.12, 0.72];
/** Window z edges: cockpit door, sliding door, two rear windows. */
const WINDOWS: [number, number][] = [
  [-3.7, -2.45],
  [-1.95, -0.75],
  [-0.45, 0.55],
  [0.85, 1.65],
];

/** A ring through the break levels (the same point count at every station, so the loft never twists). */
function ring(L: HeliLivery, z: number): number[] {
  const lv = breakLevels(L, z);
  const ang: number[] = [-Math.PI / 2];
  const marks = [-Math.PI / 2];
  let prev = -Math.PI / 2;
  for (const y of lv) {
    const a = Math.max(prev + 0.02, angleAtY(z, y));
    marks.push(a);
    prev = a;
  }
  marks.push(Math.max(prev + 0.02, Math.PI / 2));
  for (let k = 0; k < SEG.length; k++) for (let j = 1; j <= SEG[k]; j++) ang.push(marks[k] + ((marks[k + 1] - marks[k]) * j) / SEG[k]);
  // the right side runs −π/2 → π/2; mirror it for the left (π/2 → 3π/2), skipping both poles
  const right = ang.slice(0, -1);
  const all = [...right, Math.PI / 2, ...right.slice(1).reverse().map((a) => Math.PI - a)];
  const out: number[] = [];
  for (const a of all) {
    const [x, y] = surfacePoint(z, a);
    out.push(x, y);
  }
  return out;
}

/** Is a fuselage point a side window? (The windscreen and chin windows are separate glazing patches.) */
function isWindow(x: number, y: number, z: number): boolean {
  if (y < WIN_Y[0] || y > WIN_Y[1] || Math.abs(x) < 0.85) return false;
  return WINDOWS.some(([z0, z1]) => z > z0 && z < z1);
}

/** The livery colour of a fuselage point. */
function paintFuselage(L: HeliLivery, x: number, y: number, z: number): number {
  if (isWindow(x, y, z)) return GLASS;
  if (z > 3.9) return L.boom;
  const [s0, s1] = L.stripeY ?? [-0.32, -0.12];
  const rise = z > 1.6 ? (z - 1.6) * 0.32 : 0;
  // a chequered band along the lower cabin (police): two rows of blocks below the break line
  if (L.check && z > -3.9 && z < 2.6 && y < s1 + rise && y > -0.78 && Math.abs(x) > 0.7) {
    const i = Math.floor((z + 3.9) / 0.5);
    const j = y < s0 + rise ? 0 : 1;
    return (i + j) % 2 === 0 ? L.check[0] : L.check[1];
  }
  if (L.stripe && y > s0 + rise && y < s1 + rise) return L.stripe;
  return y < s0 + rise ? L.belly : L.top;
}

/** Recolour a canonical (non-indexed) geometry per triangle from its centroid. */
function paintTriangles(g: BufferGeometry, f: (x: number, y: number, z: number, ny: number) => number): BufferGeometry {
  const p = g.attributes.position.array as Float32Array;
  const n = g.attributes.normal.array as Float32Array;
  const c = g.attributes.color.array as Float32Array;
  const col = new Color();
  for (let t = 0; t < p.length / 9; t++) {
    const o = t * 9;
    const x = (p[o] + p[o + 3] + p[o + 6]) / 3;
    const y = (p[o + 1] + p[o + 4] + p[o + 7]) / 3;
    const z = (p[o + 2] + p[o + 5] + p[o + 8]) / 3;
    col.setHex(f(x, y, z, (n[o + 1] + n[o + 4] + n[o + 7]) / 3));
    for (let k = 0; k < 3; k++) {
      c[o + k * 3] = col.r;
      c[o + k * 3 + 1] = col.g;
      c[o + k * 3 + 2] = col.b;
    }
  }
  g.attributes.color.needsUpdate = true;
  return g;
}

function fuselage(L: HeliLivery): BufferGeometry {
  // stations: the shape's own, every window edge, and ≤ 0.4 m apart through the nose and cabin
  const zs = new Set<number>(STATIONS.map((s) => s[0]));
  for (const [z0, z1] of WINDOWS) zs.add(z0).add(z1);
  const sorted = [...zs].sort((a, b) => a - b);
  const all: number[] = [];
  for (let i = 0; i < sorted.length; i++) {
    all.push(sorted[i]);
    const z0 = sorted[i];
    const z1 = sorted[i + 1];
    if (z1 === undefined || z0 >= 3.0) continue;
    const steps = Math.ceil((z1 - z0) / 0.4);
    for (let k = 1; k < steps; k++) all.push(z0 + ((z1 - z0) * k) / steps);
  }
  const g = loftRings(
    all.map((z) => ({ z, ring: ring(L, z) })),
    { capStart: true, capEnd: true },
  );
  return paintTriangles(g, (x, y, z) => paintFuselage(L, x, y, z));
}

/**
 * A patch of the fuselage skin lifted off it by `lift` (glazing): z from z0 to z1, ring angle from a0(z) to a1(z),
 * an nz × na grid, smooth-shaded.
 */
function skinPatch(z0: number, z1: number, a0: (z: number) => number, a1: (z: number) => number, nz: number, na: number, color: number, lift = 0.012): BufferGeometry {
  const pos: number[] = [];
  const P = (i: number, j: number) => {
    const z = z0 + ((z1 - z0) * i) / nz;
    const a = a0(z) + ((a1(z) - a0(z)) * j) / na;
    return surfacePoint(z, a, lift);
  };
  for (let i = 0; i < nz; i++)
    for (let j = 0; j < na; j++) {
      const p00 = P(i, j);
      const p10 = P(i + 1, j);
      const p01 = P(i, j + 1);
      const p11 = P(i + 1, j + 1);
      pos.push(...p00, ...p01, ...p10, ...p10, ...p01, ...p11);
    }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return ensureOutward(finalize(g, color));
}

/** The windscreen (two panes either side of a centre post, the lower edge raking down to the nose) and chin windows. */
function glazing(): BufferGeometry[] {
  const out: BufferGeometry[] = [];
  const lo = (z: number) => -0.08 + (z + 5.8) * 0.26;
  for (const s of [-1, 1]) {
    // right pane: from the raked lower edge up to just short of the centre line
    const a0 = (z: number) => angleAtY(z, lo(z));
    const a1 = () => Math.PI / 2 - 0.07;
    const g = skinPatch(-5.8, -3.8, a0, a1, 8, 6, GLASS);
    out.push(s > 0 ? g : mirrorX(g));
    // chin window
    const c = skinPatch(-5.95, -4.95, (z) => angleAtY(z, -0.62), (z) => angleAtY(z, -0.25), 4, 3, GLASS);
    out.push(s > 0 ? c : mirrorX(c));
  }
  return out;
}

/** The engine cowling ("doghouse") on the roof, with intakes and twin exhausts. */
function cowling(L: HeliLivery): BufferGeometry[] {
  const out: BufferGeometry[] = [];
  const prof: [number, number, number][] = [
    // z, half width, height above the roof
    [-2.9, 0.3, 0.08],
    [-2.45, 0.62, 0.36],
    [-1.6, 0.74, 0.5],
    [0.6, 0.74, 0.54],
    [1.6, 0.66, 0.46],
    [2.5, 0.42, 0.24],
    [3.2, 0.2, 0.06],
  ];
  const st: LoftStation[] = prof.map(([z, w, h]) => {
    const roof = sectionAt(z).t - 0.06;
    return { z, ring: superRing(0, roof + h / 2, w, h / 2 + 0.06, 3.2, 20) };
  });
  out.push(paintTriangles(loftRings(st, { capStart: true, capEnd: true }), (x, y, z) => (z < -2.2 && y < 1.32 && Math.abs(x) > 0.45 ? DARK : L.top)));
  // intake grilles and exhausts each side
  for (const s of [-1, 1]) {
    out.push(place(box(0.04, 0.24, 0.55, DARK), [s * 0.74, 1.27, -1.75]));
    out.push(place(cylinderZ(0.15, 0.17, 0.0, 0.55, 10, GREY), [s * 0.5, 1.33, 1.75], [0.12, s * 0.35, 0]));
    out.push(place(cylinderZ(0.12, 0.12, 0.5, 0.56, 10, 0x0c0c0d), [s * 0.5, 1.33, 1.75], [0.12, s * 0.35, 0]));
  }
  // mast fairing and the swashplate cover
  out.push(place(cylinder(0.32, 0.46, 0.32, 14, L.top), [0, 1.6, -0.35]));
  out.push(place(cylinder(0.14, 0.2, 0.3, 10, METAL), [0, 1.86, -0.35]));
  return out;
}

/** Fin, horizontal stabiliser with end plates, ventral fin and tail skid. */
function tail(L: HeliLivery): BufferGeometry[] {
  const out: BufferGeometry[] = [];
  // vertical fin: swept leading edge, a thick root over the boom end
  const fin = prismX(
    [
      [7.55, 0.82],
      [8.75, 0.82],
      [9.25, 2.35],
      [8.85, 2.42],
    ],
    0.16,
    L.fin,
  );
  out.push(fin);
  // the tail rotor gearbox fairing (left side)
  out.push(place(ellipsoid(0.12, 0.2, 0.32, 10, 6, L.fin), [-0.1, 1.58, 8.85]));
  // ventral fin and the tail skid
  out.push(prismX([[7.9, 0.62], [8.75, 0.62], [8.95, 0.05], [8.65, 0.02]], 0.1, L.fin));
  out.push(place(cylinderZ(0.03, 0.03, 8.6, 9.05, 6, METAL), [0, 0.05, 0]));
  // horizontal stabiliser at the boom, end plates
  const stab = place(box(1.15, 0.07, 0.62, L.fin), [0.78, 0.7, 6.65]);
  out.push(stab, mirrorX(stab.clone()));
  for (const s of [-1, 1]) out.push(place(prismX([[6.35, 0.45], [6.95, 0.45], [7.1, 1.05], [6.65, 1.05]], 0.06, L.fin), [s * 1.37, 0, 0]));
  return out;
}

/** Wheels: nose gear and two mains in sponsons. Skids: two tubes on curved cross tubes with steps. */
function gear(L: HeliLivery, kind: 'wheels' | 'skids', g: number): BufferGeometry[] {
  const out: BufferGeometry[] = [];
  if (kind === 'wheels') {
    // sponsons on the lower rear cabin
    for (const s of [-1, 1]) {
      const sp: LoftStation[] = [
        [0.0, 0.05, 0.06],
        [0.35, 0.26, 0.2],
        [1.1, 0.3, 0.22],
        [2.0, 0.24, 0.17],
        [2.5, 0.06, 0.06],
      ].map(([z, w, h]) => ({ z, ring: superRing(s * (1.0 + w * 0.5), -0.58, w, h, 2.6, 16) }));
      out.push(paintTriangles(loftRings(sp, { capStart: true, capEnd: true }), () => L.belly));
      out.push(place(cylinder(0.05, 0.05, g - 0.95, 6, METAL), [s * 1.2, -0.8 - (g - 0.95) / 2, 1.1]));
      out.push(place(cylinderX(0.3, 0.2, 14, DARK), [s * 1.22, -g + 0.3, 1.1]));
      out.push(place(cylinderX(0.15, 0.22, 10, METAL), [s * 1.22, -g + 0.3, 1.1]));
    }
    out.push(place(cylinder(0.05, 0.05, g - 1.0, 6, METAL), [0, -0.8 - (g - 1.0) / 2, -4.25]));
    for (const s of [-1, 1]) out.push(place(cylinderX(0.2, 0.12, 12, DARK), [s * 0.09, -g + 0.2, -4.25]));
  } else {
    for (const s of [-1, 1]) {
      // the skid tube with an upturned toe
      out.push(place(cylinderZ(0.055, 0.055, -3.6, 1.9, 8, METAL), [s * 1.25, -g + 0.06, 0]));
      out.push(place(cylinderZ(0.055, 0.04, -4.15, -3.6, 8, METAL), [s * 1.25, -g + 0.06, 0], [-0.32, 0, 0]));
      // cross tubes: down and out from the belly
      for (const z of [-2.5, 0.9]) {
        const h = g - 0.8;
        out.push(place(cylinder(0.05, 0.05, Math.hypot(h, 0.3), 6, METAL), [s * 1.1, -0.8 - h / 2, z], [0, 0, s * 0.28]));
      }
    }
  }
  return out;
}

/** Main rotor (spinning about +Y through the hub) and the tail rotor (about X). */
function rotors(b: ModelBuilder, L: HeliLivery, blades: number): void {
  const R = 6.06;
  const hub = new Vector3(0, 2.02, -0.35);
  const parts: BufferGeometry[] = [];
  for (let k = 0; k < blades; k++) {
    const a = (k / blades) * Math.PI * 2;
    const ring = (z: number, chord: number, th: number) => ({ z, ring: superRing(0, 0, chord / 2, th, 2.2, 6, 0) });
    // a blade along +Z from the grip to the tip: taper and a swept, anhedral tip (lofted in the blade's own frame)
    const blade = loftRings(
      [ring(0.55, 0.3, 0.05), ring(1.0, 0.38, 0.045), ring(R - 0.75, 0.38, 0.03), ring(R - 0.25, 0.34, 0.025), ring(R, 0.16, 0.015)],
      { capStart: true, capEnd: true },
    );
    paintTriangles(blade, (_x, _y, z) => (z > R - 0.5 ? L.tip : z > R - 0.75 ? 0xe9e9e6 : L.blade));
    // sweep the tip back (towards −X in the blade frame) and droop it slightly
    const p = blade.attributes.position.array as Float32Array;
    for (let i = 0; i < p.length; i += 3) {
      const t = Math.max(0, (p[i + 2] - (R - 0.6)) / 0.6);
      p[i] -= t * t * 0.18;
      p[i + 1] -= t * 0.03;
    }
    blade.computeVertexNormals();
    // a little pitch, then round the hub
    parts.push(place(blade, [hub.x, hub.y, hub.z], [0, a, 0]));
    // blade grip / cuff
    parts.push(place(box(0.16, 0.12, 0.5, METAL), [hub.x + Math.sin(a) * 0.45, hub.y, hub.z + Math.cos(a) * 0.45], [0, a, 0]));
  }
  parts.push(place(cylinder(0.3, 0.34, 0.2, 14, METAL), [hub.x, hub.y, hub.z]));
  parts.push(place(cylinder(0.12, 0.2, 0.22, 10, GREY), [hub.x, hub.y + 0.2, hub.z]));
  b.addPart('rotor', merge(parts)!, 'paint', hub, new Vector3(0, 1, 0));

  // tail rotor: four blades on the left of the fin
  const tc = new Vector3(-0.24, 1.6, 8.9);
  const tr: BufferGeometry[] = [];
  const TR = 1.1;
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * Math.PI * 2 + Math.PI / 4;
    const bl = place(box(0.035, TR, 0.18, L.blade), [tc.x, tc.y + (Math.sin(a) * TR) / 2, tc.z + (Math.cos(a) * TR) / 2], [a, 0, 0]);
    paintTriangles(bl, (_x, y, z) => (Math.hypot(y - tc.y, z - tc.z) > TR - 0.22 ? L.tip : L.blade));
    tr.push(bl);
  }
  tr.push(place(cylinderX(0.1, 0.12, 10, METAL), [tc.x, tc.y, tc.z]));
  b.addPart('tailrotor', merge(tr)!, 'paint', tc, new Vector3(1, 0, 0));
}

/** Small kit: the hoist, a FLIR ball, the searchlight, antennas, steps, pitot tubes, lights. */
function kit(o: HeliOptions): BufferGeometry[] {
  const out: BufferGeometry[] = [];
  if (o.hoist) {
    // the rescue hoist over the right cabin door: a boom from the roof and its drum
    out.push(place(box(0.1, 0.1, 0.9, GREY), [0.98, 1.05, -1.25]));
    out.push(place(cylinderZ(0.16, 0.16, -1.15, -0.55, 12, 0xd8d8d4), [1.32, 1.02, 0]));
    out.push(place(box(0.42, 0.08, 0.12, GREY), [1.12, 1.05, -0.85]));
  }
  if (o.flir) {
    out.push(place(cylinder(0.07, 0.07, 0.12, 8, GREY), [0, -0.78, -5.05]));
    out.push(place(ellipsoid(0.17, 0.17, 0.17, 12, 8, 0x2b2e33), [0, -0.95, -5.05]));
    out.push(place(box(0.16, 0.11, 0.04, GLASS), [0, -0.95, -5.22]));
  }
  if (o.searchlight) {
    out.push(place(cylinderZ(0.16, 0.2, -0.25, 0.1, 12, GREY), [0.55, -0.98, -3.6], [0.5, 0, 0]));
    out.push(place(cylinderZ(0.15, 0.15, -0.27, -0.25, 12, 0xf3f0e0), [0.55, -0.98, -3.6], [0.5, 0, 0]));
  }
  // pitot tubes, a whip and two blade antennas, the belly beacon
  for (const s of [-1, 1]) out.push(place(cylinderZ(0.02, 0.02, -6.55, -6.0, 5, METAL), [s * 0.32, 0.05, 0]));
  out.push(place(box(0.03, 0.3, 0.18, DARK), [0, 1.16, 1.9], [-0.3, 0, 0]));
  out.push(place(box(0.03, 0.22, 0.16, DARK), [0, -0.92, 0.3], [0.3, 0, 0]));
  out.push(place(ellipsoid(0.07, 0.05, 0.1, 8, 4, 0xd0242b), [0, -0.84, 1.5]));
  out.push(place(ellipsoid(0.07, 0.06, 0.1, 8, 4, 0xd0242b), [0, 2.44, 9.0]));
  // nav lights on the stabiliser end plates: red left, green right
  out.push(place(ellipsoid(0.05, 0.05, 0.08, 6, 4, 0xe02020), [-1.4, 1.07, 6.85]));
  out.push(place(ellipsoid(0.05, 0.05, 0.08, 6, 4, 0x20d050), [1.4, 1.07, 6.85]));
  // door seams and handles (thin dark strips just proud of the skin) on both sides
  for (const s of [-1, 1]) {
    const x = s * 1.145;
    for (const z of [-3.78, -2.38, -2.05, 0.68]) out.push(place(box(0.012, 1.45, 0.025, GLASS_EDGE), [x, 0.05, z]));
    out.push(place(box(0.02, 0.04, 0.2, METAL), [x + s * 0.01, 0.0, -0.4]));
    // the boarding step under the cockpit door (wheeled: skids are the step)
    if (o.gear === 'wheels') out.push(place(box(0.25, 0.04, 0.35, GREY), [s * 1.12, -0.84, -3.1]));
  }
  return out;
}

/* ───────────────────────── decals (branding) ───────────────────────── */

function hex(c: number): string {
  return `#${c.toString(16).padStart(6, '0')}`;
}

/** A text decal: a plane of `w` × `h` m with the text drawn to fit. */
function textDecal(text: string, w: number, h: number, color: number, font = '900', italic = false): Mesh {
  const W = 1024;
  const H = Math.max(32, Math.round((W * h) / w));
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d')!;
  g.clearRect(0, 0, W, H);
  let size = H * 0.9;
  g.font = `${italic ? 'italic ' : ''}${font} ${size}px "Helvetica Neue", Arial, sans-serif`;
  const tw = g.measureText(text).width;
  if (tw > W * 0.96) size *= (W * 0.96) / tw;
  g.font = `${italic ? 'italic ' : ''}${font} ${size}px "Helvetica Neue", Arial, sans-serif`;
  g.fillStyle = hex(color);
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, W / 2, H / 2);
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  t.anisotropy = 4;
  const m = new Mesh(new PlaneGeometry(w, h), new MeshStandardMaterial({ map: t, transparent: true, roughness: 0.5, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }));
  m.renderOrder = 2;
  return m;
}

/** A decal on both sides at (z, y) on the fuselage side (|x| = `xAt` plus a hair), readable from each side. */
function sideDecals(group: Group, make: () => Mesh, z: number, y: number, xAt: number): void {
  for (const s of [-1, 1]) {
    const m = make();
    m.position.set(s * (xAt + 0.006), y, z);
    m.rotation.y = (s * Math.PI) / 2;
    group.add(m);
  }
}

export function addBranding(group: Group, L: HeliLivery): void {
  const cab = sectionAt(-0.5).w;
  sideDecals(group, () => textDecal(L.name, 3.0, 0.26, L.text, '900', true), -0.6, -0.03, cab);
  const boomW = sectionAt(5.6).w;
  sideDecals(group, () => textDecal(L.boomText, 2.6, 0.22, L.boomTextColor ?? L.text, '800'), 5.6, 0.66, boomW);
  sideDecals(group, () => textDecal(L.reg, 0.95, 0.2, L.text, '700'), 8.35, 1.3, 0.085);
}

/* ───────────────────────── build ───────────────────────── */

export interface BuiltHeli {
  group: Group;
  rotor: Group | null;
  tailrotor: Group | null;
  triangles: number;
}

export function buildHeliV2(L: HeliLivery, o: HeliOptions, gearHeight = 1.45): BuiltHeli {
  const b = new ModelBuilder(() => 'munition');
  b.add(fuselage(L), 'paint');
  for (const g of glazing()) b.add(g, 'paint');
  for (const g of [...cowling(L), ...tail(L), ...gear(L, o.gear, gearHeight), ...kit(o)]) b.add(g, 'paint');
  rotors(b, L, o.blades);
  b.ao = { rays: 24, maxDist: 1.2, strength: 0.75, floor: 0.35, skipParts: ['rotor', 'tailrotor'] };
  const built = b.build();
  const group = built.lod0;
  addBranding(group, L);
  return {
    group,
    rotor: (group.getObjectByName('pivot:rotor') as Group) ?? null,
    tailrotor: (group.getObjectByName('pivot:tailrotor') as Group) ?? null,
    triangles: built.triangles,
  };
}
