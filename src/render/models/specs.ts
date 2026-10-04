/**
 * Per-aircraft visual metadata shared by EntityRenderer, Effects and CameraRig.
 * All positions are model/body space: nose = -Z, up = +Y, right wing = +X, metres, origin ≈ CG.
 */
import type { AircraftType, MunitionId } from '../../core/types';

export type V3 = [number, number, number];

export interface NavLightDef {
  pos: V3;
  color: number;
  /** 'nav' = steady, 'strobe' = anti-collision flash. */
  kind: 'nav' | 'strobe' | 'tail';
}

export interface AircraftSpec {
  type: AircraftType;
  length: number;
  span: number;
  height: number;
  /** Pilot eye position. */
  eye: V3;
  /** Nozzle exit centres + radii (AB flames, contrails, heat glow, damage smoke). */
  engines: { pos: V3; radius: number }[];
  /** Wingtip trailing points (vortex condensation). */
  wingtips: [V3, V3];
  /** Leading-edge root points (LEX / wing-root vapour at high AoA). */
  lex: V3[];
  /** Gun muzzle (null = no gun). */
  gun: V3 | null;
  lights: NavLightDef[];
  /** Chase camera distance behind the jet (m) and height. */
  chase: { dist: number; height: number };
  /** Afterburner flame length at full AB (m) — 0 = no AB. */
  abLength: number;
}

const RED = 0xff2a1a;
const GREEN = 0x2aff5a;
const WHITE = 0xffffff;

export const AIRCRAFT_SPECS: Record<AircraftType, AircraftSpec> = {
  f35a: {
    type: 'f35a',
    length: 15.7,
    span: 10.7,
    height: 4.4,
    eye: [0, 1.02, -3.52],
    engines: [{ pos: [0, 0.03, 6.92], radius: 0.53 }],
    wingtips: [
      [-5.33, -0.06, 3.1],
      [5.33, -0.06, 3.1],
    ],
    lex: [
      [-1.35, 0.12, -1.2],
      [1.35, 0.12, -1.2],
    ],
    gun: [-1.12, 0.3, -0.9],
    lights: [
      { pos: [-5.32, -0.04, 2.3], color: RED, kind: 'nav' },
      { pos: [5.32, -0.04, 2.3], color: GREEN, kind: 'nav' },
      { pos: [0, 0.2, 7.05], color: WHITE, kind: 'tail' },
      { pos: [-1.95, 2.38, 5.55], color: WHITE, kind: 'strobe' },
      { pos: [1.95, 2.38, 5.55], color: WHITE, kind: 'strobe' },
    ],
    chase: { dist: 19, height: 4.6 },
    abLength: 9,
  },
  mig29: {
    type: 'mig29',
    length: 17.3,
    span: 11.4,
    height: 4.7,
    eye: [0, 1.25, -4.4],
    engines: [
      { pos: [-0.78, -0.14, 7.95], radius: 0.42 },
      { pos: [0.78, -0.14, 7.95], radius: 0.42 },
    ],
    wingtips: [
      [-5.68, 0.02, 3.7],
      [5.68, 0.02, 3.7],
    ],
    lex: [
      [-1.2, 0.25, -1.8],
      [1.2, 0.25, -1.8],
    ],
    gun: [-0.95, 0.35, -2.3],
    lights: [
      { pos: [-5.66, 0.02, 3.1], color: RED, kind: 'nav' },
      { pos: [5.66, 0.02, 3.1], color: GREEN, kind: 'nav' },
      { pos: [0, 0.3, 7.9], color: WHITE, kind: 'tail' },
      { pos: [-1.9, 2.95, 6.8], color: RED, kind: 'strobe' },
    ],
    chase: { dist: 21, height: 5 },
    abLength: 8,
  },
  su27: {
    type: 'su27',
    length: 21.9,
    span: 14.7,
    height: 5.9,
    eye: [0, 1.45, -6.1],
    engines: [
      { pos: [-0.95, -0.18, 9.65], radius: 0.47 },
      { pos: [0.95, -0.18, 9.65], radius: 0.47 },
    ],
    wingtips: [
      [-7.35, 0.05, 4.4],
      [7.35, 0.05, 4.4],
    ],
    lex: [
      [-1.4, 0.3, -2.8],
      [1.4, 0.3, -2.8],
    ],
    gun: [1.05, 0.45, -3.6],
    lights: [
      { pos: [-7.3, 0.05, 3.6], color: RED, kind: 'nav' },
      { pos: [7.3, 0.05, 3.6], color: GREEN, kind: 'nav' },
      { pos: [0, 0.35, 11.1], color: WHITE, kind: 'tail' },
      { pos: [-2.2, 3.75, 8.9], color: RED, kind: 'strobe' },
    ],
    chase: { dist: 26, height: 6 },
    abLength: 10,
  },
  su35: {
    type: 'su35',
    length: 21.9,
    span: 14.7,
    height: 5.9,
    eye: [0, 1.45, -6.1],
    engines: [
      { pos: [-0.95, -0.18, 10.05], radius: 0.5 },
      { pos: [0.95, -0.18, 10.05], radius: 0.5 },
    ],
    wingtips: [
      [-7.35, 0.05, 4.4],
      [7.35, 0.05, 4.4],
    ],
    lex: [
      [-1.4, 0.3, -2.8],
      [1.4, 0.3, -2.8],
    ],
    gun: [1.05, 0.45, -3.6],
    lights: [
      { pos: [-7.3, 0.05, 3.6], color: RED, kind: 'nav' },
      { pos: [7.3, 0.05, 3.6], color: GREEN, kind: 'nav' },
      { pos: [0, 0.35, 11.6], color: WHITE, kind: 'tail' },
      { pos: [-2.2, 3.75, 8.9], color: RED, kind: 'strobe' },
    ],
    chase: { dist: 26, height: 6 },
    abLength: 10,
  },
  su57: {
    type: 'su57',
    length: 20.1,
    span: 14.1,
    height: 4.6,
    eye: [0, 1.28, -5.55],
    engines: [
      { pos: [-1.2, -0.1, 8.85], radius: 0.5 },
      { pos: [1.2, -0.1, 8.85], radius: 0.5 },
    ],
    wingtips: [
      [-7.02, -0.02, 4.1],
      [7.02, -0.02, 4.1],
    ],
    lex: [
      [-1.6, 0.2, -2.6],
      [1.6, 0.2, -2.6],
    ],
    gun: [1.2, 0.3, -2.8],
    lights: [
      { pos: [-7.0, -0.02, 3.3], color: RED, kind: 'nav' },
      { pos: [7.0, -0.02, 3.3], color: GREEN, kind: 'nav' },
      { pos: [0, 0.2, 9.6], color: WHITE, kind: 'tail' },
    ],
    chase: { dist: 25, height: 5.5 },
    abLength: 10,
  },
  a320: {
    type: 'a320',
    length: 37.6,
    span: 35.8,
    height: 11.8,
    eye: [0, 0.75, -16.0],
    engines: [
      { pos: [-5.75, -2.1, -2.4], radius: 0.45 },
      { pos: [5.75, -2.1, -2.4], radius: 0.45 },
    ],
    wingtips: [
      [-17.4, 1.6, 3.4],
      [17.4, 1.6, 3.4],
    ],
    lex: [],
    gun: null,
    lights: [
      { pos: [-17.4, 0.3, 2.2], color: RED, kind: 'nav' },
      { pos: [17.4, 0.3, 2.2], color: GREEN, kind: 'nav' },
      { pos: [0, 1.3, 18.8], color: WHITE, kind: 'tail' },
      { pos: [0, -2.1, 0], color: RED, kind: 'strobe' },
      { pos: [0, 2.05, 2], color: RED, kind: 'strobe' },
      { pos: [-17.6, 1.9, 3.6], color: WHITE, kind: 'strobe' },
      { pos: [17.6, 1.9, 3.6], color: WHITE, kind: 'strobe' },
    ],
    chase: { dist: 70, height: 14 },
    abLength: 0,
  },
  shahed136: {
    type: 'shahed136',
    length: 3.5,
    span: 2.5,
    height: 0.65,
    eye: [0, 0.1, -1.2],
    engines: [{ pos: [0, 0, 1.6], radius: 0.1 }],
    wingtips: [
      [-1.22, -0.02, 1.4],
      [1.22, -0.02, 1.4],
    ],
    lex: [],
    gun: null,
    lights: [],
    chase: { dist: 9, height: 2 },
    abLength: 0,
  },
};

/** Default munition dimensions (m) used to build models; instances are rescaled to def.length/diameter. */
export const MUNITION_DIMS: Record<MunitionId, { length: number; diameter: number }> = {
  aim120: { length: 3.66, diameter: 0.178 },
  aim9x: { length: 3.02, diameter: 0.127 },
  gbu31: { length: 3.88, diameter: 0.46 },
  gbu39: { length: 1.8, diameter: 0.19 },
  gbu53: { length: 1.76, diameter: 0.18 },
  aargm: { length: 4.1, diameter: 0.254 },
  r73: { length: 2.9, diameter: 0.17 },
  r27: { length: 4.08, diameter: 0.23 },
  r77: { length: 3.6, diameter: 0.2 },
  kab500: { length: 3.05, diameter: 0.35 },
  m_3m9: { length: 5.8, diameter: 0.335 },
  m_9m33: { length: 3.16, diameter: 0.21 },
  m_48n6: { length: 7.5, diameter: 0.515 },
  m_9m330: { length: 2.9, diameter: 0.23 },
  m_igla: { length: 1.57, diameter: 0.072 },
  kowsar: { length: 3.5, diameter: 0.3 },
};

export function eyeOffsetOf(type: AircraftType): V3 {
  return (AIRCRAFT_SPECS[type] ?? AIRCRAFT_SPECS.f35a).eye;
}
