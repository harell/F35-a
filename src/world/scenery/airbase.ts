/**
 * Airbase builder: runway (marked texture), parallel taxiway + connectors, apron, hardened aircraft
 * shelters or a civil terminal, hangars, control tower, fuel farm, radar, and a full night lighting
 * set (edge, threshold, end, approach lights with sequenced strobes, taxiway blue, apron floods,
 * tower beacon, obstruction lights). Everything sits on the flattened strip (see terrain/features).
 *
 * Auckland's real airfields (Whenuapai, Auckland Airport, Ardmore, North Shore) are built from their
 * OpenStreetMap layout instead (buildRealAirfield); the template stays for the fictional Waiheke
 * strip and the offline fallback (template layout on the real runways).
 */
import { Color } from 'three';
import type { SceneryFeature } from '../../core/contracts';
import { AIRBASE } from '../terrain/features';
import type { Runway } from '../../core/airfields';
import { frameFromHeading, GeometryBuilder, IDENT_FRAME, WIN_GLOW, WIN_HOME, WIN_INDUSTRIAL, WIN_OFFICE, type Frame } from './GeometryBuilder';
import { DecalBuilder, LightList, type HeightFn } from './builders';
import type { AirfieldLayout } from './aucklandOsm';

export interface AirbaseSpec {
  feature: SceneryFeature;
  style: 'military' | 'civil';
  runwayLength?: number;
  runwayWidth?: number;
  /** Concrete / building tints. */
  concrete?: number;
}

export interface AirbaseOutput {
  buildings: GeometryBuilder;
  runway: DecalBuilder;
  concrete: DecalBuilder;
  lights: LightList;
}

const LIGHT_EDGE = 0xfff0d0;
const LIGHT_CAUTION = 0xffd060;
const LIGHT_GREEN = 0x40ff70;
const LIGHT_RED = 0xff2a18;
const LIGHT_BLUE = 0x4070ff;
const LIGHT_SODIUM = 0xffa040;
const LIGHT_WHITE = 0xffffff;

export function buildAirbase(spec: AirbaseSpec, out: AirbaseOutput, height: HeightFn, detail: number): void {
  const f = spec.feature;
  const heading = ((f.rotation ?? 0) * Math.PI) / 180;
  const L = spec.runwayLength ?? AIRBASE.runwayLength;
  const W = spec.runwayWidth ?? AIRBASE.runwayWidth;
  const base = height(f.x, f.z);
  const fr = frameFromHeading(f.x, base, f.z, heading);
  const civil = spec.style === 'civil';
  const B = out.buildings;
  const h = (lx: number, lz: number) => height(fr.ox + lx * fr.c + lz * fr.s, fr.oz - lx * fr.s + lz * fr.c);
  const world = (lx: number, lz: number): [number, number] => [fr.ox + lx * fr.c + lz * fr.s, fr.oz - lx * fr.s + lz * fr.c];

  // ── Ground: runway + shoulders, taxiways, apron ──
  out.runway.quad(fr, -W / 2, W / 2, -L / 2, L / 2, height, (lx, lz) => [0.5 - lx / W, 0.5 + lz / L], 100, 0.35);
  const concreteUV = (lx: number, lz: number): [number, number] => [lx / 40, lz / 40];
  const tx = AIRBASE.taxiOffset;
  const tw = AIRBASE.taxiWidth;
  out.concrete.quad(fr, tx - tw / 2, tx + tw / 2, -L / 2 + 80, L / 2 - 80, height, concreteUV, 120, 0.3);
  for (const cz of [-L / 2 + 70, -L / 6, L / 6, L / 2 - 70]) {
    out.concrete.quad(fr, W / 2, tx - tw / 2, cz - tw / 2, cz + tw / 2, height, concreteUV, 90, 0.28);
  }
  const apU0 = AIRBASE.apronU0;
  const apU1 = civil ? AIRBASE.apronU1 + 60 : AIRBASE.apronU1;
  const apL = civil ? AIRBASE.apronHalfLen + 180 : AIRBASE.apronHalfLen;
  out.concrete.quad(fr, apU0, apU1, -apL, apL, height, concreteUV, 110, 0.32);
  for (const cz of [-apL * 0.7, 0, apL * 0.7]) out.concrete.quad(fr, tx + tw / 2, apU0, cz - 14, cz + 14, height, concreteUV, 60, 0.3);

  // ── Buildings ──
  const concrete = new Color(spec.concrete ?? 0x9c9a92);
  const roofGrey = new Color(0x6c6e70);
  const y0 = base - 1.5; // sink foundations
  if (!civil) {
    // Hardened aircraft shelters facing the apron
    const shelters = detail > 0.5 ? 8 : 6;
    for (let i = 0; i < shelters; i++) {
      const lz = -apL + 40 + (i * (2 * apL - 80)) / (shelters - 1);
      const lx = apU1 + 42;
      const [wx, wz] = world(lx, lz);
      const sf = frameFromHeading(wx, h(lx, lz) - 1, wz, heading - Math.PI / 2);
      B.arch(sf, 0, 0, 0, 13, 34, 6, 0xa4a098, 0x55585c);
    }
    // Maintenance hangars at both ends of the apron
    for (const lz of [-apL - 120, apL + 120]) {
      B.box(fr, apU1 + 60, y0, lz, 60, 21, 72, 0x8f9496, roofGrey, WIN_INDUSTRIAL);
      B.gable(fr, apU1 + 60, y0 + 21, lz, 60, 72, 5, roofGrey);
    }
  } else {
    // Terminal with glass facade and two piers
    B.box(fr, apU1 + 45, y0, 0, 50, 22, apL * 1.4, 0xd8dcdf, 0x9aa0a4, WIN_OFFICE);
    for (const lz of [-apL * 0.45, apL * 0.45]) B.box(fr, apU1 - 25, y0, lz, 90, 12, 18, 0xc8ccd0, 0x9aa0a4, WIN_OFFICE);
    // car parks / hotels
    B.box(fr, apU1 + 120, y0, -apL * 0.5, 60, 16, 90, 0xb8b4ac, 0x77746e, WIN_HOME);
    B.box(fr, apU1 + 120, y0, apL * 0.4, 36, 40, 36, 0xe4e0d6, 0x8a8a86, WIN_OFFICE);
    for (const lz of [-apL - 140, apL + 140]) {
      B.box(fr, apU1 + 40, y0, lz, 80, 26, 80, 0xe0e2e4, roofGrey, WIN_INDUSTRIAL);
    }
  }
  // Control tower
  const tX = apU1 + (civil ? 150 : 110);
  const tZ = civil ? apL * 0.9 : 30;
  const tH = civil ? 58 : 30;
  B.box(fr, tX, y0, tZ, 26, 9, 18, 0xcfcac0, 0x7a7a78, WIN_OFFICE);
  B.box(fr, tX, y0 + 9, tZ, 6, tH - 9, 6, 0xd8d4cc, 0xd8d4cc);
  B.box(fr, tX, y0 + tH, tZ, 11, 5, 11, 0x2d4450, 0x3a3c40, WIN_GLOW);
  B.box(fr, tX, y0 + tH + 5, tZ, 12, 0.8, 12, 0x505458);
  // Admin / squadron buildings
  for (let i = 0; i < 4; i++) {
    const lz = -300 + i * 190 + (civil ? apL : 0);
    B.box(fr, AIRBASE.buildU1 - 20, y0, lz, 34, 10 + (i % 2) * 4, 22, 0xc2baa8, 0x7c5a48, WIN_HOME);
  }
  // Fuel farm
  for (let i = 0; i < 4; i++) {
    const lx = AIRBASE.buildU1 - 40 + (i % 2) * 26;
    const lz = -900 - Math.floor(i / 2) * 26;
    B.cylinder(fr, lx, y0, lz, 10, 10, 11.5, 12, 0xe4e4e0, 0, true, 0xcfd0cc);
  }
  // Radar tower with radome
  B.box(fr, AIRBASE.buildU1 - 30, y0, 900, 5, 16, 5, 0xb0b0ac);
  B.cylinder(fr, AIRBASE.buildU1 - 30, y0 + 16, 900, 6.5, 6.5, 3, 10, 0xf0f0ec, 0, false);
  B.cylinder(fr, AIRBASE.buildU1 - 30, y0 + 19, 900, 6.5, 0.5, 5, 10, 0xf0f0ec);

  // ── Night lighting ──
  const L2 = L / 2;
  const edgeStep = 60;
  for (let lz = -L2; lz <= L2 + 0.1; lz += edgeStep) {
    const caution = L2 - Math.abs(lz) < 600;
    for (const side of [-1, 1]) {
      const lx = side * (W / 2 + 1.5);
      const [wx, wz] = world(lx, lz);
      out.lights.add(wx, h(lx, lz) + 0.8, wz, caution ? LIGHT_CAUTION : LIGHT_EDGE, 3.2);
    }
  }
  // Thresholds (green, facing out) and runway ends (red)
  for (const end of [-1, 1]) {
    for (let lx = -W / 2; lx <= W / 2 + 0.1; lx += W / 10) {
      const [wx, wz] = world(lx, end * (L2 + 1));
      out.lights.add(wx, h(lx, end * L2) + 0.7, wz, LIGHT_GREEN, 3.4);
      const [rx, rz] = world(lx, end * (L2 - 3));
      out.lights.add(rx, h(lx, end * L2) + 0.7, rz, LIGHT_RED, 2.6);
    }
    // Approach lighting system: 900 m of centre-line bars with sequenced flashers
    for (let d = 30; d <= 900; d += 30) {
      const lz = end * (L2 + d);
      const gy = Math.max(0, h(0, lz));
      const bar = d % 150 === 0 ? 7 : 5;
      for (let k = 0; k < bar; k++) {
        const lx = (k - (bar - 1) / 2) * 3;
        const [wx, wz] = world(lx, lz);
        out.lights.add(wx, gy + 3 + d * 0.004, wz, LIGHT_WHITE, 3.0);
      }
      const [sx, sz] = world(0, lz);
      out.lights.add(sx, gy + 4, sz, LIGHT_WHITE, 7, 1 - d / 900);
    }
  }
  // Taxiway edges (blue)
  for (let lz = -L2 + 80; lz <= L2 - 80; lz += 60) {
    for (const side of [-1, 1]) {
      const lx = tx + side * (tw / 2 + 1);
      const [wx, wz] = world(lx, lz);
      out.lights.add(wx, h(lx, lz) + 0.5, wz, LIGHT_BLUE, 2.4);
    }
  }
  // Apron floodlights
  for (let lz = -apL; lz <= apL + 0.1; lz += apL / 2) {
    const lx = apU1 + 8;
    const [wx, wz] = world(lx, lz);
    out.lights.add(wx, h(lx, lz) + 22, wz, LIGHT_SODIUM, 9);
  }
  // Tower beacon + obstruction lights
  {
    const [wx, wz] = world(tX, tZ);
    out.lights.add(wx, y0 + tH + 7, wz, 0x60ff90, 5, 0.0);
    out.lights.add(wx, y0 + tH + 7.5, wz, LIGHT_WHITE, 5, 0.5);
  }
  if (!civil) {
    for (const lz of [-apL - 120, apL + 120]) {
      const [wx, wz] = world(apU1 + 60, lz);
      out.lights.add(wx, y0 + 27, wz, LIGHT_RED, 3.5, 0.25);
    }
  }
}

/** Airbase frame helper for other modules (e.g. parking positions). */
export function airbaseFrame(f: SceneryFeature, y = 0): Frame {
  return frameFromHeading(f.x, y, f.z, ((f.rotation ?? 0) * Math.PI) / 180);
}

/**
 * A secondary runway (e.g. Whenuapai 08/26): marked strip decal plus edge / threshold lights.
 * Centre (x, z), heading (rad), length and width in m.
 */
export function buildExtraRunway(
  r: { x: number; z: number; heading: number; length: number; width: number },
  runway: DecalBuilder,
  lights: LightList,
  height: HeightFn,
): void {
  const fr = frameFromHeading(r.x, 0, r.z, r.heading);
  const W = r.width;
  const L = r.length;
  runway.quad(fr, -W / 2, W / 2, -L / 2, L / 2, height, (lx, lz) => [0.5 - lx / W, 0.5 + lz / L], 100, 0.3);
  const world = (lx: number, lz: number): [number, number] => [fr.ox + lx * fr.c + lz * fr.s, fr.oz - lx * fr.s + lz * fr.c];
  for (let lz = -L / 2; lz <= L / 2 + 0.1; lz += 60) {
    for (const side of [-1, 1]) {
      const [wx, wz] = world(side * (W / 2 + 1.5), lz);
      lights.add(wx, height(wx, wz) + 0.8, wz, L / 2 - Math.abs(lz) < 400 ? LIGHT_CAUTION : LIGHT_EDGE, 3.2);
    }
  }
  for (const end of [-1, 1]) {
    for (let lx = -W / 2; lx <= W / 2 + 0.1; lx += W / 8) {
      const [wx, wz] = world(lx, end * (L / 2 + 1));
      lights.add(wx, height(wx, wz) + 0.7, wz, LIGHT_GREEN, 3.4);
    }
  }
}

/* ───────────────────────────── Real airfields (OpenStreetMap) ───────────────────────────── */

export interface RealAirfieldOutput {
  buildings: GeometryBuilder;
  /** Runway decal builder for one runway (one texture per designator pair / size). */
  runway: (rw: Runway) => DecalBuilder;
  concrete: DecalBuilder;
  lights: LightList;
}

/** Ring area (m², unsigned). */
function areaOf(r: ArrayLike<number>): number {
  let a = 0;
  const n = r.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) a += r[j * 2] * r[i * 2 + 1] - r[i * 2] * r[j * 2 + 1];
  return Math.abs(a / 2);
}

function ringCentre(r: ArrayLike<number>): [number, number] {
  let sx = 0;
  let sz = 0;
  const n = r.length / 2;
  for (let i = 0; i < n; i++) {
    sx += r[i * 2];
    sz += r[i * 2 + 1];
  }
  return [sx / n, sz / n];
}

/** Runway frame helpers: lateral (u, right of a → b) and longitudinal (v from the centre towards b) offsets. */
function runwayLocal(rw: Runway, x: number, z: number): [number, number] {
  const sh = Math.sin(rw.heading);
  const ch = Math.cos(rw.heading);
  const dx = x - rw.x;
  const dz = z - rw.z;
  return [dx * ch + dz * sh, dx * sh - dz * ch];
}

/** Split a polyline into the runs that stay off the paved runways (taxiways meet them at the centreline). */
function offRunways(pts: Float32Array, runways: Runway[]): { pts: number[]; cutStart: boolean; cutEnd: boolean }[] {
  const runs: { pts: number[]; cutStart: boolean; cutEnd: boolean }[] = [];
  let cur: number[] = [];
  let cutStart = false;
  const onRunway = (x: number, z: number) =>
    runways.some((rw) => {
      if (!rw.paved) return false;
      const [u, v] = runwayLocal(rw, x, z);
      return Math.abs(u) < rw.width / 2 + 0.5 && Math.abs(v) < rw.length / 2 + 0.5;
    });
  const n = pts.length / 2;
  // the last off-runway sample not yet in `cur` (the cut point when the line runs onto a runway)
  let lx = NaN;
  let lz = NaN;
  for (let i = 0; i < n; i++) {
    const x0 = pts[i * 2];
    const z0 = pts[i * 2 + 1];
    // densify each segment at 8 m so the cut lands near the runway edge
    const last = i === n - 1;
    const steps = last ? 1 : Math.max(1, Math.ceil(Math.hypot(pts[i * 2 + 2] - x0, pts[i * 2 + 3] - z0) / 8));
    for (let k = 0; k < steps; k++) {
      const t = k / steps;
      const x = last ? x0 : x0 + (pts[i * 2 + 2] - x0) * t;
      const z = last ? z0 : z0 + (pts[i * 2 + 3] - z0) * t;
      if (onRunway(x, z)) {
        if (!Number.isNaN(lx)) cur.push(lx, lz);
        if (cur.length >= 4) runs.push({ pts: cur, cutStart, cutEnd: true });
        cur = [];
        cutStart = true;
        lx = NaN;
      } else if (k === 0 || cur.length === 0) {
        // keep the original vertices and the first point off a runway (the ribbon re-densifies)
        cur.push(x, z);
        lx = NaN;
      } else {
        lx = x;
        lz = z;
      }
    }
  }
  if (!Number.isNaN(lx)) cur.push(lx, lz);
  if (cur.length >= 4) runs.push({ pts: cur, cutStart, cutEnd: false });
  return runs;
}

/**
 * One of Auckland's real airfields from its OpenStreetMap layout (aucklandOsm.ts): the real runways
 * (marked texture, src/core/airfields.ts thresholds), taxiways and aprons (concrete), hangar and terminal
 * footprints extruded, fuel tanks, a control tower, and the lighting driven by the real runway ends:
 * edge, threshold and end lights, approach lights on the long runways, blue taxiway edges, apron floods.
 * Everything sits on the levelled outline (terrain/features.ts follows the same core polygon).
 */
export function buildRealAirfield(lay: AirfieldLayout, runways: Runway[], out: RealAirfieldOutput, height: HeightFn, detail: number): void {
  const B = out.buildings;
  const military = lay.def.style === 'military';
  const roofGrey = new Color(0x6c6e70);

  // ── Ground: runways, taxiways, aprons ──
  for (const rw of runways) {
    if (!rw.paved) continue;
    const fr = frameFromHeading(rw.x, 0, rw.z, rw.heading);
    const W = rw.width;
    const Lr = rw.length;
    out.runway(rw).quad(fr, -W / 2, W / 2, -Lr / 2, Lr / 2, height, (lx, lz) => [0.5 - lx / W, 0.5 + lz / Lr], 100, 0.35);
  }
  // an oblique taxiway's corner that reaches onto a runway is pushed back to the runway edge
  const snapOff = (x: number, z: number): [number, number] => {
    for (const rw of runways) {
      if (!rw.paved) continue;
      const [u, v] = runwayLocal(rw, x, z);
      const e = rw.width / 2 + 0.5;
      if (Math.abs(u) >= e || Math.abs(v) >= rw.length / 2) continue;
      const du = (Math.sign(u) || 1) * e - u;
      return [x + Math.cos(rw.heading) * du, z + Math.sin(rw.heading) * du];
    }
    return [x, z];
  };
  for (const t of lay.taxiways) {
    const hw = Math.max(5, Math.min(30, t.width || 18)) / 2;
    for (const run of offRunways(t.pts, runways)) out.concrete.ribbon(run.pts, hw, height, 40, 60, 0.3, !run.cutStart, !run.cutEnd, snapOff);
  }
  for (const a of lay.aprons) out.concrete.polygon(a.pts, height, 40, 90, 0.3);

  // ── Buildings: hangars, terminals, tanks, tower ──
  const ground = (ring: ArrayLike<number>) => {
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < ring.length; i += 2) {
      const y = height(ring[i], ring[i + 1]);
      lo = Math.min(lo, y);
      hi = Math.max(hi, y);
    }
    return [lo, hi];
  };
  for (const hg of lay.hangars) {
    const area = areaOf(hg.pts);
    if (area < 60) continue;
    const [lo, hi] = ground(hg.pts);
    const h = area > 4000 ? 20 : area > 1200 ? 14 : 8;
    B.prism(hg.pts, lo - 1.5, () => hi + h, military ? 0x8f9496 : 0xd6d8da, roofGrey, WIN_INDUSTRIAL);
  }
  for (const tm of lay.terminals) {
    const [lo, hi] = ground(tm.pts);
    B.prism(tm.pts, lo - 1.5, () => hi + (areaOf(tm.pts) > 20_000 ? 22 : 14), 0xd8dcdf, 0x9aa0a4, WIN_OFFICE);
  }
  for (const tk of lay.tanks) {
    const [cx, cz] = ringCentre(tk.pts);
    const r = Math.sqrt(areaOf(tk.pts) / Math.PI);
    const y = height(cx, cz) - 0.5;
    B.cylinder(IDENT_FRAME, cx, y, cz, r, r, Math.max(6, Math.min(16, r * 0.9)), 14, 0xe4e4e0, 0, true, 0xcfd0cc);
  }
  // Control tower: OSM's, else beside the largest apron, on the side away from the main runway
  const main = runways[0];
  let tower: [number, number] | null = null;
  const tw = lay.towers[0];
  if (tw) tower = ringCentre(tw.pts);
  else if (lay.aprons.length) {
    const big = lay.aprons.reduce((a, b) => (areaOf(b.pts) > areaOf(a.pts) ? b : a));
    const [cx, cz] = ringCentre(big.pts);
    const side = Math.sign(runwayLocal(main, cx, cz)[0]) || 1;
    // the apron vertex farthest from the runway, then 40 m further out
    let best = -Infinity;
    for (let i = 0; i < big.pts.length; i += 2) {
      const [u] = runwayLocal(main, big.pts[i], big.pts[i + 1]);
      if (u * side > best) {
        best = u * side;
        tower = [big.pts[i], big.pts[i + 1]];
      }
    }
    if (tower) {
      const sh = Math.sin(main.heading);
      const ch = Math.cos(main.heading);
      tower = [tower[0] + ch * side * 40, tower[1] + sh * side * 40];
    }
  }
  const tH = lay.def.style === 'civil' && main.length > 3000 ? 58 : main.length > 1800 ? 30 : 16;
  let towerTop = 0;
  if (tower) {
    const fr = frameFromHeading(tower[0], 0, tower[1], main.heading);
    const y0 = height(tower[0], tower[1]) - 1.5;
    B.box(fr, 0, y0, 0, 20, 8, 14, 0xcfcac0, 0x7a7a78, WIN_OFFICE);
    B.box(fr, 0, y0 + 8, 0, 6, tH - 8, 6, 0xd8d4cc, 0xd8d4cc);
    B.box(fr, 0, y0 + tH, 0, 10, 5, 10, 0x2d4450, 0x3a3c40, WIN_GLOW);
    B.box(fr, 0, y0 + tH + 5, 0, 11, 0.8, 11, 0x505458);
    towerTop = y0 + tH + 7;
  }

  // ── Night lighting, from the real runway ends ──
  const L = out.lights;
  for (const rw of runways) {
    if (!rw.paved) continue;
    const fr = frameFromHeading(rw.x, 0, rw.z, rw.heading);
    const world = (lx: number, lz: number): [number, number] => [fr.ox + lx * fr.c + lz * fr.s, fr.oz - lx * fr.s + lz * fr.c];
    const W = rw.width;
    const L2 = rw.length / 2;
    const n = Math.max(2, Math.round(rw.length / 60));
    const caution = Math.min(600, rw.length / 3);
    for (let k = 0; k <= n; k++) {
      const lz = -L2 + (2 * L2 * k) / n;
      for (const side of [-1, 1]) {
        const [wx, wz] = world(side * (W / 2 + 1.5), lz);
        // caution (amber) zone: the last 600 m before the far end of a landing either way
        L.add(wx, height(wx, wz) + 0.8, wz, L2 - Math.abs(lz) < caution ? LIGHT_CAUTION : LIGHT_EDGE, 3.2);
      }
    }
    const approach = rw.length >= 1800;
    for (const end of [-1, 1]) {
      for (let lx = -W / 2; lx <= W / 2 + 0.1; lx += W / 10) {
        const [wx, wz] = world(lx, end * (L2 + 1));
        L.add(wx, height(wx, wz) + 0.7, wz, LIGHT_GREEN, 3.4);
        const [rx, rz] = world(lx, end * (L2 - 3));
        L.add(rx, height(rx, rz) + 0.7, rz, LIGHT_RED, 2.6);
      }
      if (!approach) continue;
      // approach lighting: 900 m of centre-line bars with sequenced flashers (over the water at AKL)
      for (let d = 30; d <= 900; d += 30) {
        const lz = end * (L2 + d);
        const [cx, cz] = world(0, lz);
        const gy = Math.max(0, height(cx, cz));
        const bar = d % 150 === 0 ? 7 : 5;
        for (let k = 0; k < bar; k++) {
          const [wx, wz] = world((k - (bar - 1) / 2) * 3, lz);
          L.add(wx, gy + 3 + d * 0.004, wz, LIGHT_WHITE, 3.0);
        }
        L.add(cx, gy + 4, cz, LIGHT_WHITE, 7, 1 - d / 900);
      }
    }
  }
  // Taxiway edges (blue), every 60 m along both sides
  if (detail > 0.3) {
    for (const t of lay.taxiways) {
      const hw = Math.max(5, Math.min(30, t.width || 18)) / 2 + 1;
      for (const { pts: run } of offRunways(t.pts, runways)) {
        let carry = 30;
        for (let i = 0; i + 3 < run.length; i += 2) {
          const ax = run[i], az = run[i + 1];
          const dx = run[i + 2] - ax, dz = run[i + 3] - az;
          const len = Math.hypot(dx, dz);
          if (len < 1e-3) continue;
          const nx = -dz / len, nz = dx / len;
          let s = carry;
          for (; s < len; s += 60) {
            for (const side of [-1, 1]) {
              const x = ax + (dx * s) / len + nx * hw * side;
              const z = az + (dz * s) / len + nz * hw * side;
              L.add(x, height(x, z) + 0.5, z, LIGHT_BLUE, 2.4);
            }
          }
          carry = s - len;
        }
      }
    }
  }
  // Apron floodlights along the apron edges (every ≈ 150 m)
  for (const a of lay.aprons) {
    const r = a.pts;
    const n = r.length / 2;
    let carry = 0;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const dx = r[j * 2] - r[i * 2];
      const dz = r[j * 2 + 1] - r[i * 2 + 1];
      const len = Math.hypot(dx, dz);
      let s = carry;
      for (; s < len; s += 150) {
        const x = r[i * 2] + (dx * s) / len;
        const z = r[i * 2 + 1] + (dz * s) / len;
        L.add(x, height(x, z) + 22, z, LIGHT_SODIUM, 9);
      }
      carry = s - len;
    }
  }
  // Tower beacon + obstruction lights on the big hangars
  if (tower) {
    L.add(tower[0], towerTop, tower[1], 0x60ff90, 5, 0.0);
    L.add(tower[0], towerTop + 0.5, tower[1], LIGHT_WHITE, 5, 0.5);
  }
  for (const hg of lay.hangars) {
    if (areaOf(hg.pts) < 4000) continue;
    const [cx, cz] = ringCentre(hg.pts);
    L.add(cx, height(cx, cz) + 22, cz, LIGHT_RED, 3.5, 0.25);
  }
}
