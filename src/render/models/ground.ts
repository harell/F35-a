/**
 * Ground target prototypes: fuel farm, hardened aircraft shelter, parked jet, the stoat,
 * IRGC Navy fast boats, plus the merchant ships: container ship, cruise liner and crude carrier
 * (a 'ship' always has a VesselClass), and the named superyachts (superyachts.ts, #145).
 * Front = -Z, origin at ground level (ship: waterline). Named nodes:
 *  'spin:i'   continuously rotating antenna
 * Ship wakes are not part of the models: the EntityRenderer draws them all in one WakeBatch.
 * Civil ships also carry their night lights (ShipLight, drawn as sprites by the EntityRenderer).
 */
import { BufferGeometry, Group, Object3D, Vector3 } from 'three';
import type { GroundTargetType, MerchantClass, VesselClass } from '../../core/types';
import { isSuperyachtId } from '../../core/superyachts';
import { buildSuperyacht } from './superyachts';
import { mulberry32 } from '../../core/math';
import { box, cylinder, place } from './geom/core';
import { loftRings, prismZ } from './geom/loft';
import { getAircraftPrototype } from './aircraft';
import { SHIP_DIMS } from '../visuals/shipMotion';
import { missileBoat, suicideBoat } from './boats';
import { stoatModel } from './stoat';
import { PALETTES, meshFrom, panel, tank, type Palette, type PaletteId } from './vehicles';

export type WreckStyle = 'vehicle' | 'building' | 'ship' | 'aircraft';

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
  if (type === 'ship') {
    if (!vessel) throw new Error('a ship needs a VesselClass');
    return isSuperyachtId(vessel) ? buildSuperyacht(vessel) : buildMerchant(vessel);
  }
  const root = new Group();
  root.name = `ground:${type}`;
  const statics: BufferGeometry[] = [];
  const spinners: GroundPrototype['spinners'] = [];
  let wreck: WreckStyle = 'vehicle';
  let radius = 10;
  let farScale = 1;
  let mat = 'vehicle';

  switch (type) {
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
    case 'stoat': {
      // g03's stoat (models/stoat.ts): posable parts, posed by the renderer; a killed one is gone
      root.add(stoatModel());
      radius = 0.3;
      farScale = 0.05;
      break;
    }
    case 'suicide_boat':
    case 'missile_boat': {
      // IRGC Navy fast boats (models/boats.ts); a killed one stays afloat, burnt out
      statics.push(...(type === 'suicide_boat' ? suicideBoat() : missileBoat()));
      radius = 9;
      farScale = 1.2;
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
 * a radar on the mast ('spin:0'); or the flat pipe deck and aft accommodation of a crude carrier.
 * Sizes match VESSEL_DATA (sim hit volume) and SHIP_DIMS.
 */
function buildMerchant(vessel: MerchantClass): GroundPrototype {
  const root = new Group();
  root.name = `ground:ship:${vessel}`;
  const statics: BufferGeometry[] = [];
  const cruise = vessel === 'cruise';
  const tanker = vessel === 'tanker';
  const dims = SHIP_DIMS[vessel];
  const L = dims.length;
  const B = dims.beam;
  const F = dims.deck; // freeboard: main deck height above the waterline
  const hullCol = cruise ? 0xeef0ee : tanker ? 0x1c1f24 : 0x22303f;
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
  statics.push(place(box(B * 0.98, 0.4, L * 0.84, cruise ? 0x9a8a72 : tanker ? 0x7a3a2a : 0x5c6064), [0, F + 0.2, 8]));
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
  if (tanker) {
    // crude carrier: a long flat deck (pipe runs, the manifold and its hose crane amidships, a
    // catwalk to the forecastle), the accommodation block, bridge and funnel aft
    const za = L / 2 - 34;
    for (const x of [-4, -1.5, 1.5, 4]) statics.push(place(box(0.9, 0.9, L * 0.66, 0x9aa0a4), [x, F + 0.9, -12]));
    statics.push(place(box(2.2, 0.5, L * 0.66, 0xd8d4c8), [B * 0.3, F + 3.2, -12])); // catwalk
    for (let z = -L / 2 + 40; z < L / 2 - 60; z += 22) statics.push(place(box(0.5, 2.8, 0.5, 0xd8d4c8), [B * 0.3, F + 1.6, z]));
    statics.push(place(box(B * 0.8, 1.6, 6, 0x9aa0a4), [0, F + 1.2, 0])); // manifold
    statics.push(place(box(1.2, 12, 1.2, 0xd8b030), [B * 0.42, F + 6, 4]), place(box(1, 1, 16, 0xd8b030), [B * 0.42, F + 12, -2]));
    statics.push(place(box(1.2, 12, 1.2, 0xd8b030), [-B * 0.42, F + 6, 4]), place(box(1, 1, 16, 0xd8b030), [-B * 0.42, F + 12, -2]));
    statics.push(place(box(B * 0.82, 18, 16, 0xf0f0ec), [0, F + 9, za]));
    statics.push(place(box(B * 1.02, 3, 9, 0xf0f0ec), [0, F + 19.5, za - 3]), place(box(B * 0.8, 1.2, 0.3, 0x1c2328), [0, F + 19.6, za - 7.6]));
    statics.push(place(box(4, 8, 3, 0xf0f0ec), [0, F + 25, za]));
    spin.position.set(0, F + 30, za);
    light(-B * 0.52, F + 20, za - 3, RED, 'way');
    light(B * 0.52, F + 20, za - 3, GREEN, 'way');
    light(0, F + 10, -L / 2 + 12, WHITE, 'way');
    light(0, F + 32, za, WHITE, 'way');
    for (let r = 0; r < 3; r++) for (const x of [-10, 0, 10]) light(x, F + 4 + r * 5, za - 8.3, CABIN, 'deck');
    for (let z = -L / 2 + 40; z < L / 2 - 60; z += 40) light(B * 0.3, F + 6, z, FLOOD, 'deck', 3.2);
    statics.push(place(box(B * 0.6, 3, 14, hullCol), [0, F + 1.5, -L / 2 + 14])); // forecastle
  } else if (!cruise) {
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
  const fw = cruise ? 9 : tanker ? 7.5 : 6.5;
  const fl = cruise ? 14 : tanker ? 9 : 8;
  const [, fTop, fz] = dims.funnel!;
  const fy = fTop - fH;
  statics.push(place(box(fw, fH, fl, 0x1f4f8a), [0, fy + fH / 2, fz]));
  statics.push(place(box(fw + 0.1, 1.6, fl + 0.1, 0xf2f2ee), [0, fy + fH * 0.62, fz]), place(box(fw + 0.2, 1.4, fl + 0.2, 0x161a1c), [0, fy + fH + 0.7, fz]));
  // stern light under way, all-round anchor lights fore and aft at anchor
  light(0, F + 1.5, L / 2 + 0.6, WHITE, 'stern');
  light(0, F + 7, -L / 2 + 6, WHITE, 'anchor');
  light(0, F + 4, L / 2 - 3, WHITE, 'anchor');
  // mast + rotating radar
  spin.add(meshFrom(panel(5, 0.7, 0.3, 0x3a3e40), 'building'));
  root.add(spin);
  const spinners = [{ name: 'spin:0', rate: 2.2 }];
  const body = meshFrom(statics, 'building');
  body.name = 'static';
  root.add(body);
  return { type: 'ship', root, spinners, wreck: 'ship', radius: L / 2, farScale: 3.5, lights };
}

export function getGroundPrototype(type: GroundTargetType, palette: PaletteId = 'green', vessel: VesselClass | null = null): GroundPrototype {
  const key = type === 'ship' ? `ship:${vessel}` : `${type}:${palette}`;
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
