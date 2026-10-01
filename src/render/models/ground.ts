/**
 * Ground target prototypes: EWR (rotating array on a mast), command bunker, fuel farm, hardened
 * aircraft shelter, parked jet, truck, tank, corvette (with wake), factory, bridge, plus the civil
 * container ship and cruise liner (a 'ship' with a VesselClass).
 * Front = -Z, origin at ground level (ship: waterline). Named nodes:
 *  'spin:i'   continuously rotating antenna
 *  'span:mid' bridge middle span (drops when destroyed)
 *  'wake'     ship wake (scaled with speed)
 * Civil ships also carry their night lights (ShipLight, drawn as sprites by the EntityRenderer).
 */
import { BufferGeometry, Float32BufferAttribute, Group, Mesh, Object3D, Vector3 } from 'three';
import type { GroundTargetType, VesselClass } from '../../core/types';
import { mulberry32 } from '../../core/math';
import { box, cylinder, place } from './geom/core';
import { loftRings, prismX, prismZ } from './geom/loft';
import { capsuleRing } from './aircraft/parts';
import { getAircraftPrototype } from './aircraft';
import { getMaterial } from './materials';
import { SHIP_DIMS } from '../visuals/shipMotion';
import { PALETTES, building, mast, meshFrom, nodeFrom, panel, sawtoothHall, tank, trackedChassis, wheeledChassis, type Palette, type PaletteId } from './vehicles';

export type WreckStyle = 'vehicle' | 'building' | 'bridge' | 'ship' | 'aircraft';

/**
 * A ship's night light (local position, bow at -Z). COLREGS-ish: 'way' lights (red port / green
 * starboard sidelights, white mastheads) and the white 'stern' light are lit under way, the two
 * all-round white 'anchor' lights at anchor; 'deck' lights (cabins, floodlights) are always on at
 * night.
 */
export interface ShipLight {
  pos: Vector3;
  color: number;
  kind: 'way' | 'stern' | 'anchor' | 'deck';
  /** Sprite size (m). */
  size: number;
}

export interface GroundPrototype {
  type: GroundTargetType;
  root: Group;
  spinners: { name: string; rate: number }[];
  wreck: WreckStyle;
  radius: number;
  /** Visible up to this distance multiplier (big structures further). */
  farScale: number;
  /** Night lights (civil ships only). */
  lights: ShipLight[];
}

const cache = new Map<string, GroundPrototype>();

function build(type: GroundTargetType, pal: Palette, vessel: VesselClass | null = null): GroundPrototype {
  if (type === 'ship' && vessel) return buildMerchant(vessel);
  const root = new Group();
  root.name = `ground:${type}`;
  const statics: BufferGeometry[] = [];
  const spinners: GroundPrototype['spinners'] = [];
  let wreck: WreckStyle = 'vehicle';
  let radius = 10;
  let farScale = 1;
  let mat = 'vehicle';

  switch (type) {
    case 'ewr': {
      statics.push(...mast(14, 3, pal.metal));
      statics.push(place(box(6, 2.6, 2.5, pal.body), [8, 1.3, 3]), place(box(2.2, 2.0, 2.2, pal.dark), [8, 1.0, -1]));
      statics.push(...wheeledChassis(7, 2.4, [-2, 1.5, 2.6], 0.5, pal).map((g) => place(g, [-9, 0, 4], [0, 0.4, 0])));
      const spin = new Object3D();
      spin.name = 'spin:0';
      spin.position.set(0, 14.3, 0);
      const ant: BufferGeometry[] = [cylinder(0.5, 0.6, 0.6, 8, pal.dark), place(box(0.3, 1.5, 0.3, pal.dark), [0, 0.9, 0])];
      ant.push(...panel(11, 3.2, 0.3, pal.body).map((g) => place(g, [0, 2.4, -0.4], [-0.12, 0, 0])));
      for (let i = -5; i <= 5; i++) ant.push(place(box(0.06, 0.06, 1.2, pal.white), [i, 2.4, -1.0]));
      spin.add(meshFrom(ant));
      root.add(spin);
      spinners.push({ name: 'spin:0', rate: (Math.PI * 2) / 8 });
      wreck = 'building';
      radius = 16;
      farScale = 1.6;
      break;
    }
    case 'bunker': {
      mat = 'building';
      statics.push(
        prismX(
          [
            [-13, 0],
            [13, 0],
            [8, 5.5],
            [-8, 5.5],
          ],
          18,
          pal.earth,
        ),
      );
      statics.push(place(box(8, 4.2, 1.0, pal.concrete), [0, 2.1, -10.2]), place(box(4.5, 3.2, 0.3, pal.dark), [0, 1.6, -10.8]));
      statics.push(place(box(12, 0.6, 5, pal.concrete), [0, 0.3, -13.5]));
      for (const x of [-5, 5]) statics.push(place(cylinder(0.4, 0.4, 2.2, 8, pal.metal), [x, 6.3, 2]));
      statics.push(place(cylinder(0.08, 0.08, 9, 4, pal.metal), [3, 9, 6]));
      wreck = 'building';
      radius = 16;
      farScale = 1.3;
      break;
    }
    case 'fuel': {
      mat = 'building';
      const spots: [number, number][] = [
        [-15, 2],
        [0, -10],
        [15, 2],
      ];
      for (const [x, z] of spots) {
        statics.push(...tank(5.5, 8, 0xd8d6cf, [x, 0, z]));
        statics.push(place(box(14, 1.2, 0.6, pal.concrete), [x, 0.6, z - 7]), place(box(14, 1.2, 0.6, pal.concrete), [x, 0.6, z + 7]));
        statics.push(place(box(0.6, 1.2, 14, pal.concrete), [x - 7, 0.6, z]), place(box(0.6, 1.2, 14, pal.concrete), [x + 7, 0.6, z]));
      }
      statics.push(place(box(34, 0.5, 0.5, pal.metal), [0, 1.2, 10]), place(box(0.5, 0.5, 20, pal.metal), [0, 1.2, 0]));
      wreck = 'building';
      radius = 24;
      farScale = 1.5;
      break;
    }
    case 'hangar': {
      mat = 'building';
      const arch: [number, number][] = [];
      const R = 11;
      const H = 8.5;
      for (let i = 0; i <= 12; i++) {
        const a = Math.PI - (i / 12) * Math.PI;
        arch.push([Math.cos(a) * R, Math.sin(a) * H]);
      }
      statics.push(prismZ(arch, -15, 15, pal.concrete));
      statics.push(place(box(19, 7.2, 0.6, pal.dark), [0, 3.6, -15.2]));
      statics.push(place(box(26, 0.3, 14, pal.concrete), [0, 0.15, -22]));
      wreck = 'building';
      radius = 18;
      farScale = 1.4;
      break;
    }
    case 'parked_jet': {
      const jet = getAircraftPrototype('mig29').lod1.clone(true);
      jet.position.y = 2.0;
      jet.rotation.x = 0.03;
      root.add(jet);
      statics.push(place(cylinder(0.08, 0.08, 1.6, 6, 0x333333), [0, 0.9, -4.8]), place(cylinder(0.3, 0.3, 0.25, 10, 0x1d1d1d), [0, 0.32, -4.8], [0, 0, Math.PI / 2]));
      for (const s of [-1, 1])
        statics.push(place(cylinder(0.1, 0.1, 1.6, 6, 0x333333), [s * 1.6, 0.9, 1.5]), place(cylinder(0.42, 0.42, 0.3, 10, 0x1d1d1d), [s * 1.6, 0.42, 1.5], [0, 0, Math.PI / 2]));
      wreck = 'aircraft';
      radius = 9;
      break;
    }
    case 'truck': {
      statics.push(...wheeledChassis(7.4, 2.5, [-2.3, 1.3, 2.7], 0.55, pal, 2.3, 2.3));
      statics.push(place(box(2.5, 1.0, 4.6, pal.body), [0, 1.65, 1.35]));
      const canvasTop = loftRings(
        [
          { z: -0.95, ring: capsuleRing(1.25, 1.0, 0.02, 2.6, 10, 2.15) },
          { z: 3.65, ring: capsuleRing(1.25, 1.0, 0.02, 2.6, 10, 2.15) },
        ],
        { capStart: true, capEnd: true, color: pal.canvas },
      );
      statics.push(canvasTop);
      radius = 5;
      break;
    }
    case 'tank': {
      statics.push(...trackedChassis(6.9, 3.5, 0.95, pal));
      const turret = loftRings(
        [
          { z: -1.6, ring: capsuleRing(1.0, 0.45, 0.05, 2.2, 12, 1.4) },
          { z: -0.6, ring: capsuleRing(1.6, 0.75, 0.05, 2.2, 12, 1.4) },
          { z: 1.2, ring: capsuleRing(1.45, 0.7, 0.05, 2.2, 12, 1.4) },
          { z: 1.9, ring: capsuleRing(0.9, 0.45, 0.05, 2.2, 12, 1.4) },
        ],
        { capStart: true, capEnd: true, color: pal.body },
      );
      statics.push(place(turret, [0, 0, 0.3]));
      statics.push(place(cylinder(0.09, 0.12, 5.2, 8, pal.dark), [0, 1.85, -3.6], [Math.PI / 2, 0, 0]));
      radius = 5;
      break;
    }
    case 'ship': {
      mat = 'building';
      // hull: pointed bow at -Z, transom stern at +Z; waterline y = 0
      const L = 72;
      const hull = loftRings(
        [
          [-L / 2, 0.1],
          [-L / 2 + 6, 0.55],
          [-L / 2 + 18, 0.92],
          [0, 1],
          [L / 2 - 8, 0.95],
          [L / 2, 0.85],
        ].map(([z, k]) => {
          const hw = 5.2 * k;
          return {
            z,
            ring: [0, -3.2 * k, hw * 0.7, -2.4 * k, hw, 0, hw * 1.02, 4.2 + (z < 0 ? -z * 0.03 : 0), 0, 4.4 + (z < 0 ? -z * 0.03 : 0), -hw * 1.02, 4.2 + (z < 0 ? -z * 0.03 : 0), -hw, 0, -hw * 0.7, -2.4 * k],
          };
        }),
        { capEnd: true, creases: [2, 3, 5, 6], color: 0x6e767b },
      );
      statics.push(hull);
      statics.push(place(box(9.6, 0.3, 60, 0x5a5f61), [0, 4.35, 4]));
      // superstructure
      statics.push(place(box(8, 5, 16, 0x7e878b), [0, 6.9, 2]), place(box(6.5, 3.2, 8, 0x7e878b), [0, 11.0, -1]));
      statics.push(place(box(6.6, 0.8, 0.2, 0x1c2328), [0, 11.6, -5.05]));
      statics.push(place(box(3, 4, 4, 0x6f777b), [0, 11.4, 9]));
      statics.push(...mast(12, 2, 0x70777a).map((g) => place(g, [0, 12.6, 1])));
      // gun turret + missile canisters
      statics.push(place(cylinder(1.6, 1.8, 1.6, 10, 0x7e878b), [0, 5.2, -22]), place(cylinder(0.12, 0.14, 4.5, 6, 0x4a4f52), [0, 5.6, -25], [Math.PI / 2, 0, 0]));
      for (const s of [-1, 1]) statics.push(place(box(1.6, 1.4, 6, 0x6a7276), [s * 3.2, 5.2, 16], [0.25, 0, 0]));
      const spin = new Object3D();
      spin.name = 'spin:0';
      spin.position.set(0, 25, 1);
      spin.add(meshFrom(panel(4, 1, 0.2, 0x5e6568), 'building'));
      root.add(spin);
      spinners.push({ name: 'spin:0', rate: 2.5 });
      // wake: V-shaped foam decal widening aft (additive, fades with distance)
      const wake = new Mesh(makeWake(L), getMaterial('wake'));
      wake.name = 'wake';
      wake.renderOrder = 2;
      root.add(wake);
      wreck = 'ship';
      radius = 36;
      farScale = 2;
      break;
    }
    case 'factory': {
      mat = 'building';
      statics.push(...sawtoothHall(40, 9, 30, 5, 0x9a938a, 0x6d6e6c, [-8, 0, 0]));
      statics.push(...building(16, 14, 14, 0x8c8a86, 0x5d5f5f, [22, 0, -6]));
      for (const [x, z] of [
        [18, 12],
        [26, 12],
      ])
        statics.push(place(cylinder(1.2, 1.7, 32, 10, 0x7a716a), [x, 16, z]), place(cylinder(1.25, 1.25, 1.5, 10, 0x9a3a2a), [x, 30, z]));
      statics.push(...tank(4, 7, 0xd8d6cf, [-8, 0, 24]));
      wreck = 'building';
      radius = 30;
      farScale = 2;
      break;
    }
    case 'bridge': {
      mat = 'building';
      const span = 64;
      const deckY = 11;
      const spanGeo = (z0: number): BufferGeometry[] => {
        const g: BufferGeometry[] = [place(box(12, 1.4, span, pal.concrete), [0, deckY, z0])];
        for (const s of [-1, 1]) {
          g.push(place(box(0.4, 3.2, span, 0x6b6f70), [s * 6.2, deckY + 2.3, z0]));
          for (let k = -3; k <= 3; k++) g.push(place(box(0.35, 4.2, 0.35, 0x6b6f70), [s * 6.2, deckY + 2.0, z0 + (k * span) / 7], [(k % 2) * 0.6, 0, 0]));
        }
        return g;
      };
      statics.push(...spanGeo(-span), ...spanGeo(span));
      for (const z of [-span / 2, span / 2]) statics.push(place(box(8, deckY + 14, 4, pal.concrete), [0, (deckY - 14) / 2, z]));
      const mid = nodeFrom('span:mid', spanGeo(0), [0, 0, 0], 'building');
      root.add(mid);
      wreck = 'bridge';
      radius = 40;
      farScale = 2.2;
      break;
    }
  }
  if (statics.length) {
    const body = meshFrom(statics, mat);
    body.name = 'static';
    root.add(body);
  }
  return { type, root, spinners, wreck, radius, farScale, lights: [] };
}

/**
 * Civil merchant ship, waterline at y = 0, bow at -Z: a lofted hull, then container bays and the
 * aft accommodation block (container ship) or the stacked white decks of a cruise liner, a funnel,
 * a radar on the mast ('spin:0') and a wake. Sizes match VESSEL_DATA (sim hit volume).
 */
function buildMerchant(vessel: VesselClass): GroundPrototype {
  const root = new Group();
  root.name = `ground:ship:${vessel}`;
  const statics: BufferGeometry[] = [];
  const cruise = vessel === 'cruise';
  const L = cruise ? 290 : 270;
  const B = cruise ? 36 : 34;
  const F = cruise ? 14 : 12; // freeboard: main deck height above the waterline
  const hullCol = cruise ? 0xeef0ee : 0x22303f;
  // hull: fine bow at -Z (with a little sheer), full body, transom stern at +Z
  const hw = B / 2;
  const hull = loftRings(
    [
      [-L / 2, 0.06, 1.12],
      [-L / 2 + 10, 0.4, 1.08],
      [-L / 2 + 34, 0.82, 1.03],
      [-L / 2 + 70, 1, 1],
      [L / 2 - 30, 1, 1],
      [L / 2 - 6, 0.92, 1.02],
      [L / 2, 0.86, 1.03],
    ].map(([z, k, sh]) => {
      const w = hw * k;
      const top = F * sh;
      return { z, ring: [0, -3, w * 0.8, -2.4, w, 0, w, top, 0, top + 0.3, -w, top, -w, 0, -w * 0.8, -2.4] };
    }),
    { capEnd: true, creases: [2, 3, 5, 6], color: hullCol },
  );
  statics.push(hull);
  // red boot-topping just above the waterline
  statics.push(place(box(B * 1.004, 1.2, L * 0.86, 0x8a2a22), [0, 0.4, 6]));
  // main deck
  statics.push(place(box(B * 0.98, 0.4, L * 0.84, cruise ? 0x9a8a72 : 0x5c6064), [0, F + 0.2, 8]));
  const spin = new Object3D();
  spin.name = 'spin:0';
  const lights: ShipLight[] = [];
  const light = (x: number, y: number, z: number, color: number, kind: ShipLight['kind'], size = kind === 'deck' ? 2.4 : 4.5) =>
    lights.push({ pos: new Vector3(x, y, z), color, kind, size });
  const RED = 0xff2a1a;
  const GREEN = 0x2aff5a;
  const WHITE = 0xffffff;
  const CABIN = 0xffcf8a;
  const FLOOD = 0xfff0d6;
  if (!cruise) {
    // container bays forward of the accommodation block (deterministic colours)
    const rnd = mulberry32(270);
    const colors = [0xb03a2e, 0x2e5a9a, 0x2f7a4a, 0xd87a2a, 0xe8e6e0, 0x6a6e72, 0x1f3f6a, 0x8a6a3a, 0x3a8a9a];
    for (let z = -L / 2 + 30; z < L / 2 - 52; z += 13.6) {
      const tiers = 3 + ((rnd() * 4) | 0);
      for (const sx of [-1, 1]) statics.push(place(box(B * 0.45, 2.6 * tiers, 12.4, colors[(rnd() * colors.length) | 0]), [sx * B * 0.235, F + 1.3 * tiers, z]));
    }
    // accommodation block, bridge wings, funnel
    const za = L / 2 - 40;
    statics.push(place(box(B * 0.7, 22, 14, 0xf0f0ec), [0, F + 11, za]));
    statics.push(place(box(B * 1.04, 3, 9, 0xf0f0ec), [0, F + 23.5, za - 2]), place(box(B * 0.8, 1.2, 0.3, 0x1c2328), [0, F + 23.6, za - 6.6]));
    statics.push(place(box(5, 9, 3, 0xf0f0ec), [0, F + 29, za]));
    spin.position.set(0, F + 34, za);
    // night: sidelights on the bridge wings, mastheads fore and aft, lit accommodation windows and
    // floodlights on the lashing bridges
    light(-B * 0.52, F + 24, za - 2, RED, 'way');
    light(B * 0.52, F + 24, za - 2, GREEN, 'way');
    light(0, F + 12, -L / 2 + 14, WHITE, 'way');
    light(0, F + 37, za, WHITE, 'way');
    for (let r = 0; r < 4; r++) for (const x of [-8, 0, 8]) light(x, F + 4 + r * 5, za - 7.3, CABIN, 'deck');
    for (let z = -L / 2 + 34; z < L / 2 - 52; z += 27) for (const sx of [-1, 1]) light(sx * B * 0.47, F + 17, z, FLOOD, 'deck', 3.2);
    // forecastle
    statics.push(place(box(B * 0.6, 3, 16, hullCol), [0, F + 1.5, -L / 2 + 16]));
  } else {
    // stacked superstructure: white decks with dark window / balcony bands, stepped in fore and aft
    for (let t = 0; t < 7; t++) {
      const len = L * (0.8 - t * 0.045);
      const w = B * (0.96 - t * 0.03);
      const zc = 18 + t * 2;
      const y = F + t * 3.4;
      // recessed window / balcony band, then the white deck above it (white deck tops)
      statics.push(place(box(w * 0.97, 1.1, len * 0.97, t < 2 ? 0x30404e : 0x41566a), [0, y + 0.55, zc]));
      statics.push(place(box(w, 2.3, len, 0xf6f6f2), [0, y + 2.25, zc]));
    }
    const top = F + 7 * 3.4;
    // bridge at the front of the top deck, lifeboats along both sides of deck 2
    statics.push(place(box(B * 1.02, 3.2, 10, 0xf6f6f2), [0, top - 2, -L * 0.24]), place(box(B * 0.9, 1, 0.3, 0x1c2328), [0, top - 1.6, -L * 0.24 - 5.1]));
    for (let z = -L * 0.2; z < L * 0.25; z += 13) for (const sx of [-1, 1]) statics.push(place(box(3, 2.4, 9, 0xf08a1a), [sx * (B * 0.5 + 0.8), F + 5.6, z]));
    statics.push(place(box(B * 0.5, 3, 30, 0x2a6a9a), [0, top + 1.5, 30])); // pool deck / lido roof
    spin.position.set(0, top + 10, -L * 0.2);
    statics.push(place(box(1.2, 10, 1.2, 0xd8dcdc), [0, top + 5, -L * 0.2]));
    // night: sidelights on the bridge wings, mastheads, rows of lit cabins / balconies on both sides
    light(-B * 0.52, top - 1, -L * 0.24, RED, 'way');
    light(B * 0.52, top - 1, -L * 0.24, GREEN, 'way');
    light(0, F + 8, -L / 2 + 10, WHITE, 'way');
    light(0, top + 11.5, -L * 0.2, WHITE, 'way');
    for (let t = 0; t < 7; t += 2) {
      const len = L * (0.8 - t * 0.045);
      const w = B * (0.96 - t * 0.03);
      const zc = 18 + t * 2;
      const n = Math.floor(len / 19);
      for (let i = 0; i <= n; i++) for (const sx of [-1, 1]) light(sx * (w / 2 + 0.3), F + t * 3.4 + 0.6, zc - len / 2 + (i * len) / n, CABIN, 'deck');
    }
    for (const z of [18, 30, 42]) light(0, top + 4, z, FLOOD, 'deck', 3.2); // lido deck
  }
  // funnel: company colours (blue with a white band and a black top); its top is in SHIP_DIMS (the
  // effects emit the exhaust there)
  const fH = cruise ? 12 : 14;
  const [, fTop, fz] = SHIP_DIMS[vessel].funnel!;
  const fy = fTop - fH;
  statics.push(place(box(cruise ? 9 : 6.5, fH, cruise ? 14 : 8, 0x1f4f8a), [0, fy + fH / 2, fz]));
  statics.push(place(box(cruise ? 9.1 : 6.6, 1.6, cruise ? 14.1 : 8.1, 0xf2f2ee), [0, fy + fH * 0.62, fz]), place(box(cruise ? 9.2 : 6.7, 1.4, cruise ? 14.2 : 8.2, 0x161a1c), [0, fy + fH + 0.7, fz]));
  // stern light under way, all-round anchor lights fore and aft at anchor
  light(0, F + 1.5, L / 2 + 0.6, WHITE, 'stern');
  light(0, F + 7, -L / 2 + 6, WHITE, 'anchor');
  light(0, F + 4, L / 2 - 3, WHITE, 'anchor');
  // mast + rotating radar
  spin.add(meshFrom(panel(5, 0.7, 0.3, 0x3a3e40), 'building'));
  root.add(spin);
  const spinners = [{ name: 'spin:0', rate: 2.2 }];
  const wake = new Mesh(makeWake(L, B / 2, 260), getMaterial('wake'));
  wake.name = 'wake';
  wake.renderOrder = 2;
  root.add(wake);
  const body = meshFrom(statics, 'building');
  body.name = 'static';
  root.add(body);
  return { type: 'ship', root, spinners, wreck: 'ship', radius: L / 2, farScale: 3.5, lights };
}

/** Flat V-shaped wake strip on the water behind the stern (+Z), vertex colour fading to black (additive). */
function makeWake(L: number, halfBeam = 5, len = 140): BufferGeometry {
  const pos: number[] = [];
  const col: number[] = [];
  const N = 8;
  const spread = (34 * len) / 140;
  const at = (i: number) => {
    const t = i / N;
    return { z: L / 2 - 4 + t * len, w: halfBeam + t * spread, k: Math.pow(1 - t, 1.6) * 0.9 };
  };
  for (let i = 0; i < N; i++) {
    const a = at(i);
    const b = at(i + 1);
    // two quads per segment: left and right halves with a darker centre line (turbulent water)
    for (const s of [-1, 1]) {
      const q = [
        [0, a.z, a.k * 0.7],
        [s * a.w, a.z, a.k],
        [s * b.w, b.z, b.k],
        [0, b.z, b.k * 0.7],
      ];
      const tri = s > 0 ? [0, 2, 1, 0, 3, 2] : [0, 1, 2, 0, 2, 3];
      for (const k of tri) {
        pos.push(q[k][0], 0.12, q[k][1]);
        col.push(q[k][2], q[k][2], q[k][2]);
      }
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new Float32BufferAttribute(col, 3));
  g.setAttribute('normal', new Float32BufferAttribute(new Float32Array(pos.length).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
  g.setAttribute('uv', new Float32BufferAttribute(new Float32Array((pos.length / 3) * 2), 2));
  return g;
}

export function getGroundPrototype(type: GroundTargetType, palette: PaletteId = 'green', vessel: VesselClass | null = null): GroundPrototype {
  const key = type === 'ship' && vessel ? `ship:${vessel}` : `${type}:${palette}`;
  let p = cache.get(key);
  if (!p) {
    p = build(type, PALETTES[palette], vessel);
    cache.set(key, p);
  }
  return p;
}

export function disposeGroundPrototypes(): void {
  cache.forEach((p) =>
    p.root.traverse((o) => {
      const m = o as { geometry?: { dispose(): void } };
      m.geometry?.dispose();
    }),
  );
}
