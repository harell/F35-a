/**
 * Airbase builder: runway (marked texture), parallel taxiway + connectors, apron, hardened aircraft
 * shelters or a civil terminal, hangars, control tower, fuel farm, radar, and a full night lighting
 * set (edge, threshold, end, approach lights with sequenced strobes, taxiway blue, apron floods,
 * tower beacon, obstruction lights). Everything sits on the flattened strip (see terrain/features).
 */
import { Color } from 'three';
import type { SceneryFeature } from '../../core/contracts';
import { AIRBASE } from '../terrain/features';
import { frameFromHeading, GeometryBuilder, WIN_GLOW, WIN_HOME, WIN_INDUSTRIAL, WIN_OFFICE, type Frame } from './GeometryBuilder';
import { DecalBuilder, LightList, type HeightFn } from './builders';

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
