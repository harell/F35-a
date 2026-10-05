/**
 * Civil helicopters (#144): neutral traffic between the helipads (sim/civil/heli.ts), code-built like the other
 * aircraft and low poly (≈ 400–600 triangles), vertex-coloured liveries on one paint material:
 *  - Leonardo AW169 (Westpac Rescue): twin-engine medium helicopter, five-blade main rotor, wheels; red with a
 *    yellow tail boom and cabin stripe (the Auckland Rescue Helicopter Trust's colours, as in the 2010 photo of the
 *    rescue helicopter on the Auckland City Hospital pad).
 *  - a light single helicopter on skids, one model with two liveries (the Bell 429 and the H130 are close enough at
 *    the size the game shows them): the NZ Police "Eagle" (Bell 429: dark navy all over with a blue and white
 *    chequered band, red-and-white rotor tips; its Nightsun searchlight beam at night) and a sightseeing H130 (black
 *    with a silver tail, as the Mechanics Bay charter machines).
 * Spinning main and tail rotors (LOD0 parts, driven like the A-50's rotodome); at distance (LOD1) a faint blurred
 * disc instead of the blades. Model frame: −Z nose, +Y up; origin at the cabin centre, HELI_GEAR_HEIGHT above the
 * skids / wheels.
 */
import { AdditiveBlending, ConeGeometry, DoubleSide, Mesh, MeshBasicMaterial, Vector3, type Group } from 'three';
import { ModelBuilder } from '../ModelBuilder';
import { box, cylinder, cylinderZ, merge, mirrorX, place } from '../geom/core';
import { latheZ, prismX } from '../geom/loft';
import type { AircraftType } from '../../../core/types';
import type { AircraftPrototype, DriveDef } from './types';
import { HELI_GEAR_HEIGHT } from '../../../sim/civil/heli';


/** Main and tail rotor speeds (rad/s): slow enough to read as spinning blades at 60 fps. */
const MAIN_RATE = Math.PI * 2 * 4.3;
const TAIL_RATE = Math.PI * 2 * 11;

const DARK = 0x1a1c1f;
const GLASS = 0x26313b;
const METAL = 0x6b6e72;

interface Livery {
  body: number;
  /** Tail boom, fin and a cabin stripe. */
  trim: number;
  /** A chequered band on the rear cabin (police): its second colour, 0 = none. */
  check: number;
  blade: number;
  /** Blade tips. */
  tip: number;
}

const LIVERIES: Record<'aw169' | 'bell429' | 'h130', Livery> = {
  aw169: { body: 0xc8202b, trim: 0xf2c20c, check: 0, blade: 0x2a2b2d, tip: 0xf2c20c },
  bell429: { body: 0x1b2540, trim: 0x1b2540, check: 0xe6eaf0, blade: 0x2a2b2d, tip: 0xd23a2a },
  h130: { body: 0x1c1d20, trim: 0xb5b9be, check: 0, blade: 0x2a2b2d, tip: 0xc8ccd0 },
};

interface Dims {
  /** Nose and tail-boom end (model z). */
  nose: number;
  tail: number;
  /** Cabin half width and half height. */
  r: number;
  /** Rotor radius, its hub height and z, blade count. */
  rotor: number;
  hubY: number;
  hubZ: number;
  blades: number;
  tailRotor: number;
  wheels: boolean;
}

const DIMS: Record<'aw169' | 'bell429' | 'h130', Dims> = {
  aw169: { nose: -6.1, tail: 6.9, r: 1.05, rotor: 6.05, hubY: 1.95, hubZ: -0.4, blades: 5, tailRotor: 1.05, wheels: true },
  bell429: { nose: -5.6, tail: 6.0, r: 0.9, rotor: 5.5, hubY: 1.75, hubZ: -0.3, blades: 4, tailRotor: 0.85, wheels: false },
  h130: { nose: -5.4, tail: 5.9, r: 0.92, rotor: 5.35, hubY: 1.75, hubZ: -0.25, blades: 3, tailRotor: 0.8, wheels: false },
};

function buildHelicopter(type: 'aw169' | 'bell429' | 'h130'): AircraftPrototype {
  const L = LIVERIES[type];
  const D = DIMS[type];
  // one paint material for everything (the colours are vertex colours): one draw call per mesh
  const b = new ModelBuilder(() => 'munition');
  const drives: DriveDef[] = [];
  const cabin = D.nose * 0.25;

  // fuselage: rounded nose and cabin, tapering into the tail boom
  const zc = D.nose;
  b.add(
    place(
      latheZ(
        [
          [zc, 0.12],
          [zc + 0.4, 0.55 * D.r],
          [zc + 1.2, 0.88 * D.r],
          [zc + 2.4, D.r],
          [1.0, D.r],
          [2.0, 0.78 * D.r],
          [2.9, 0.42],
          [D.tail - 0.5, 0.24],
          [D.tail, 0.18],
        ],
        12,
        { color: L.body, ySquash: 1.08, capEnd: true },
      ),
      [0, 0, 0],
    ),
    'paint',
  );
  // the tail boom in the trim colour (over the body's, slightly fatter) and a cabin stripe
  b.add(latheZ([[2.7, 0.47], [D.tail - 0.45, 0.27], [D.tail + 0.02, 0.2]], 10, { color: L.trim }), 'paint');
  if (L.trim !== L.body) b.add(place(box(2 * D.r + 0.04, 0.22, 4.2, L.trim), [0, -0.05, -0.8]), 'paint');
  // windscreen and cabin windows (dark glass), a sliding door line
  b.add(place(box(1.05 * D.r, 0.62, 0.06, GLASS), [0, 0.45, zc + 1.45], [-0.62, 0, 0]), 'paint');
  for (const s of [-1, 1]) {
    b.add(place(box(0.06, 0.62, 1.1, GLASS), [s * (D.r - 0.01), 0.3, zc + 1.9], [0, 0, 0]), 'paint');
    b.add(place(box(0.06, 0.55, 1.4, GLASS), [s * (D.r - 0.01), 0.3, cabin + 0.6], [0, 0, 0]), 'paint');
  }
  // police: a blue and white chequered band along the rear cabin
  if (L.check) {
    for (const s of [-1, 1])
      for (let i = 0; i < 8; i++)
        for (let j = 0; j < 2; j++)
          if ((i + j) % 2 === 0) b.add(place(box(0.04, 0.18, 0.2, L.check), [s * (D.r + 0.01), -0.32 + j * 0.18, 0.15 + i * 0.2]), 'paint');
  }
  // engine housing ("doghouse") and exhausts on the roof, the mast and hub
  b.add(place(box(1.1 * D.r, 0.55, 2.6, L.body), [0, D.r * 1.02, D.hubZ + 0.6]), 'paint');
  for (const s of type === 'aw169' ? [-1, 1] : [0]) b.add(place(cylinderZ(0.13, 0.15, D.hubZ + 1.8, D.hubZ + 2.4, 8, DARK), [s * 0.35, D.r * 1.15, 0]), 'paint');
  b.add(place(cylinder(0.12, 0.16, D.hubY - D.r * 1.3, 8, METAL), [0, (D.hubY + D.r * 1.3) / 2, D.hubZ]), 'paint');
  // tail fin, stabiliser
  const fin = prismX(
    [
      [D.tail - 0.85, 0.05],
      [D.tail + 0.05, 0.1],
      [D.tail + 0.35, 1.25],
      [D.tail - 0.05, 1.25],
    ],
    0.1,
    L.trim,
  );
  b.add(fin, 'paint');
  b.add(place(prismX([[D.tail - 0.7, -0.05], [D.tail - 0.05, -0.05], [D.tail + 0.15, -0.65], [D.tail - 0.25, -0.65]], 0.08, L.trim), [0, 0, 0]), 'paint');
  const stab = place(box(1.0, 0.06, 0.45, L.trim), [0.55, 0.15, D.tail - 1.3]);
  b.add(stab, 'paint');
  b.add(mirrorX(stab), 'paint');
  // undercarriage: wheels (AW169) or skids on two cross tubes
  const g = HELI_GEAR_HEIGHT[type];
  if (D.wheels) {
    for (const [x, z] of [[-0.9, 0.6], [0.9, 0.6], [0, zc + 1.6]] as const) {
      b.add(place(cylinder(0.05, 0.05, g - 0.75, 6, METAL), [x, -0.75 - (g - 0.75) / 2, z]), 'paint');
      b.add(place(cylinder(0.24, 0.24, 0.16, 8, DARK), [x, -g + 0.24, z], [0, 0, Math.PI / 2]), 'paint');
    }
  } else {
    for (const s of [-1, 1]) {
      b.add(place(cylinderZ(0.05, 0.05, zc + 1.4, 1.6, 6, METAL), [s * 1.05, -g + 0.05, 0]), 'paint');
      for (const z of [zc + 2.4, 0.9]) b.add(place(cylinder(0.04, 0.04, g - 0.85, 5, METAL), [s * 0.85, -0.85 - (g - 0.85) / 2, z], [0, 0, s * 0.35]), 'paint');
    }
  }

  // main rotor (spins about +Y through the hub): blades with coloured tips
  const blades = [];
  for (let k = 0; k < D.blades; k++) {
    const a = (k / D.blades) * Math.PI * 2;
    blades.push(place(box(0.32, 0.05, D.rotor - 0.55, L.blade), [Math.sin(a) * (D.rotor - 0.55) / 2, D.hubY, D.hubZ + Math.cos(a) * (D.rotor - 0.55) / 2], [0, a, 0]));
    blades.push(place(box(0.32, 0.051, 0.55, L.tip), [Math.sin(a) * (D.rotor - 0.28), D.hubY, D.hubZ + Math.cos(a) * (D.rotor - 0.28)], [0, a, 0]));
  }
  blades.push(place(cylinder(0.32, 0.32, 0.16, 8, METAL), [0, D.hubY, D.hubZ]));
  b.addPart('rotor', merge(blades)!, 'paint', new Vector3(0, D.hubY, D.hubZ), new Vector3(0, 1, 0));
  drives.push({ part: 'rotor', kind: 'radome', side: 0, max: MAIN_RATE });
  // tail rotor on the left of the fin, spinning about X
  const tz = D.tail + 0.05;
  const ty = 0.75;
  const tr = [];
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * Math.PI * 2;
    tr.push(place(box(0.03, 0.13, D.tailRotor), [-0.17, ty + (Math.sin(a) * D.tailRotor) / 2, tz + (Math.cos(a) * D.tailRotor) / 2], [a, 0, 0]));
  }
  b.addPart('tailrotor', merge(tr)!, 'paint', new Vector3(-0.17, ty, tz), new Vector3(1, 0, 0));
  drives.push({ part: 'tailrotor', kind: 'radome', side: 0, max: TAIL_RATE });
  // LOD1 keeps the airframe; its rotors are the blurred discs below
  b.excludeFromLod1('rotor', 'tailrotor');

  const built = b.build();
  addRotorDiscs(built.lod1, D);
  if (type === 'bell429') addSearchlight(built.lod0, built.lod1, zc);
  return { type, lod0: built.lod0, lod1: built.lod1, drives, slots: [], fixedStores: [], triangles: built.triangles, instanced: true };
}

let discMat: MeshBasicMaterial | null = null;
let beamMat: MeshBasicMaterial | null = null;

/** LOD1: the spinning rotors as faint discs (a blur), the main one and the tail one. */
function addRotorDiscs(lod1: Group, D: Dims): void {
  discMat ??= new MeshBasicMaterial({ color: 0x22252a, transparent: true, opacity: 0.2, depthWrite: false, side: DoubleSide });
  const top = merge([
    place(cylinder(D.rotor, D.rotor, 0.01, 16, 0xffffff), [0, D.hubY, D.hubZ]),
    place(cylinder(D.tailRotor / 2, D.tailRotor / 2, 0.01, 10, 0xffffff), [-0.17, 0.75, D.tail + 0.05], [0, 0, Math.PI / 2]),
  ])!;
  const m = new Mesh(top, discMat);
  m.name = 'rotor-disc';
  lod1.add(m);
}

/**
 * The Eagle's Nightsun searchlight: a faint additive cone from the nose turret, forward and down (≈ 35°), 140 m long.
 * Shown only at night (AircraftVisual toggles objects named `night:*`), in both LODs.
 */
function addSearchlight(lod0: Group, lod1: Group, nose: number): void {
  beamMat ??= new MeshBasicMaterial({ color: 0xfff4d8, transparent: true, opacity: 0.14, blending: AdditiveBlending, depthWrite: false, side: DoubleSide, toneMapped: false });
  const len = 140;
  const geo = new ConeGeometry(len * Math.tan(4 * (Math.PI / 180)), len, 12, 1, true);
  // apex at the turret: the cone's tip is +Y; move it so the tip sits at the origin, then aim it forward-down
  geo.translate(0, -len / 2, 0);
  for (const g of [lod0, lod1]) {
    const m = new Mesh(geo, beamMat);
    m.name = 'night:searchlight';
    m.position.set(0.0, -0.9, nose + 1.1);
    // −Y (the cone's axis after the shift) rotated towards −Z by 55° from straight down
    m.rotation.set(-(55 * Math.PI) / 180, 0, 0);
    m.visible = false;
    g.add(m);
  }
}

export const buildAW169 = (): AircraftPrototype => buildHelicopter('aw169');
export const buildBell429 = (): AircraftPrototype => buildHelicopter('bell429');
export const buildH130 = (): AircraftPrototype => buildHelicopter('h130');

/** The civil helicopter types. */
export const HELICOPTER_TYPES: readonly AircraftType[] = ['aw169', 'bell429', 'h130'];
