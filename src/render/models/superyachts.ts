/**
 * Named superyachts (#145): one model per yacht, built in code from her shape data (core/superyachts.ts), like the
 * merchant ships in ground.ts. Waterline at y = 0, bow at -Z, one merged mesh (one draw call), no spinners.
 *
 *  - hull: lofted stations whose every point is sheared between the stem line and the transom, so a raked or clipper
 *    bow overhangs and A's reverse bow slopes back from the waterline; the sheer rises toward the bow; the topsides
 *    lean in by the yacht's tumblehome; a boot-top stripe at the waterline; a teak (or white) deck;
 *  - superstructure: tiers lofted with a rounded front, each a dark window band under its white deck;
 *  - sailing yachts: tapered white masts, crosstrees, booms with the furled sail, fore- and backstays and shrouds,
 *    the bowsprit; Koru's radar domes on her crosstrees;
 *  - motor yachts: the radar mast with its two domes.
 *
 * Night (ShipLight): navigation lights, lit window bands ('deck'), the blue underwater lights along the hull and red
 * obstruction lights on tall mast tops.
 */
import { BufferGeometry, Group, Matrix4, Quaternion, Vector3 } from 'three';
import { SUPERYACHTS, type SuperyachtId, type SuperyachtSpec } from '../../core/superyachts';
import { box, cylinder, cylinderZ, ellipsoid, place, transform } from './geom/core';
import { loftRings, type LoftStation } from './geom/loft';
import { meshFrom } from './vehicles';
import type { GroundPrototype, ShipLight } from './ground';

/** Plan shape of the hull at the deck: half-width share of the beam at station u (0 bow, 1 stern). */
export function yachtPlan(u: number): number {
  if (u <= 0) return 0.03;
  if (u < 0.42) return Math.max(0.03, Math.pow(Math.sin((Math.PI / 2) * (u / 0.42)), 0.75));
  if (u > 0.86) return 1 - 0.1 * ((u - 0.86) / 0.14) ** 2;
  return 1;
}

const STATIONS = [0, 0.02, 0.06, 0.12, 0.2, 0.3, 0.42, 0.6, 0.86, 0.94, 1];

const _a = new Vector3();
const _b = new Vector3();
const _m = new Matrix4();
const _q = new Quaternion();
const _up = new Vector3(0, 1, 0);
const _dir = new Vector3();

/** A round-ish rod (4-sided) between two points. */
function rod(a: [number, number, number], b: [number, number, number], w: number, color: number): BufferGeometry {
  _a.set(...a);
  _b.set(...b);
  const len = _a.distanceTo(_b);
  const g = box(w, len, w, color);
  _dir.subVectors(_b, _a).normalize();
  _q.setFromUnitVectors(_up, _dir);
  _m.compose(_a.add(_b).multiplyScalar(0.5), _q, new Vector3(1, 1, 1));
  return transform(g, _m);
}

/** Geometry and lights of one yacht. */
export function superyachtParts(y: SuperyachtSpec): { geos: BufferGeometry[]; lights: ShipLight[] } {
  const L = y.length;
  const hw = y.beam / 2;
  const F = y.freeboard;
  const rake = y.bowRake;
  // stem: the deck's tip and the forefoot at the waterline; the transom is vertical at +L/2
  const zDeckTip = -L / 2 + Math.max(0, -rake);
  const zForefoot = -L / 2 + Math.max(0, rake);
  const zStem = (yy: number) => zForefoot + (zDeckTip - zForefoot) * (yy / F);
  /** z of a hull point at height yy and station u. */
  const zAt = (u: number, yy: number) => zStem(yy) + (L / 2 - zStem(yy)) * u;
  /** Deck height at station u (the sheer rises toward the bow). */
  const deckAt = (u: number) => F * (1 + 0.14 * (1 - u) ** 2);
  const geos: BufferGeometry[] = [];

  // hull: keel, bilge, waterline, topside (tumblehome), deck edge on both sides
  const hull: LoftStation[] = STATIONS.map((u) => {
    const w = hw * yachtPlan(u);
    const d = deckAt(u);
    const pts: [number, number][] = [
      [0, -2.2],
      [w * 0.7, -1.8],
      [w, 0.2],
      [w * y.tumble, d],
      [-w * y.tumble, d],
      [-w, 0.2],
      [-w * 0.7, -1.8],
    ];
    return { z: zAt(u, 0), ring: pts.flat(), zs: pts.map(([, yy]) => zAt(u, Math.max(-1, yy))) };
  });
  geos.push(loftRings(hull, { capEnd: true, creases: [2, 3, 4, 5], color: y.hull }));
  // boot-top stripe (a slab across the hull whose sides stand just proud of it), then the deck
  if (y.boot !== null) {
    const boot: LoftStation[] = STATIONS.slice(1).map((u) => {
      const w = hw * yachtPlan(u) * 1.015 + 0.04;
      const pts: [number, number][] = [
        [w, -0.25],
        [w, 0.75],
        [-w, 0.75],
        [-w, -0.25],
      ];
      return { z: zAt(u, 0.25), ring: pts.flat() };
    });
    geos.push(loftRings(boot, { creases: [0, 1, 2, 3], capStart: true, capEnd: true, color: y.boot }));
  }
  const deck: LoftStation[] = STATIONS.slice(1).map((u) => {
    const w = hw * yachtPlan(u) * y.tumble * 0.97;
    const d = deckAt(u);
    const pts: [number, number][] = [
      [w, d - 0.3],
      [w, d + 0.12],
      [-w, d + 0.12],
      [-w, d - 0.3],
    ];
    return { z: zAt(u, d), ring: pts.flat() };
  });
  geos.push(loftRings(deck, { creases: [0, 1, 2, 3], capStart: true, capEnd: true, color: y.deck }));
  // bulwark cap along the deck edge (the white line of a yacht's rail), as two rods per side
  for (const sx of [-1, 1])
    for (let i = 1; i + 1 < STATIONS.length; i += 2) {
      const u0 = STATIONS[i];
      const u1 = STATIONS[Math.min(STATIONS.length - 1, i + 2)];
      geos.push(
        rod(
          [sx * hw * yachtPlan(u0) * y.tumble, deckAt(u0) + 0.5, zAt(u0, deckAt(u0))],
          [sx * hw * yachtPlan(u1) * y.tumble, deckAt(u1) + 0.5, zAt(u1, deckAt(u1))],
          0.35,
          y.white,
        ),
      );
    }

  // superstructure tiers
  const lights: ShipLight[] = [];
  const light = (x: number, yy: number, z: number, color: number, kind: ShipLight['kind'], size = kind === 'deck' ? 1.8 : 3.2) =>
    lights.push({ pos: new Vector3(x, yy, z), color, kind, size });
  const CABIN = 0xffd9a0;
  let base = 0;
  let prevTop = 0;
  let firstFront = 0;
  let topZ = 0;
  y.tiers.forEach((t, i) => {
    const um = (t.from + t.to) / 2;
    const y0 = i === 0 ? deckAt(um) : prevTop;
    base = y0;
    const w = hw * y.tumble * t.w * yachtPlan(um);
    const z0 = zAt(t.from, deckAt(t.from));
    const z1 = zAt(t.to, deckAt(t.to));
    const r = Math.min(t.round, (z1 - z0) / 3);
    const plan: [number, number][] = r > 0 ? [[0, 0.5], [0.12, 0.8], [0.4, 0.95], [1, 1], [z1 - z0, 0.97]] : [[0, 1], [z1 - z0, 0.97]];
    // the front leans back like a windscreen: a point h m up sits rake·h further aft, fading to nothing at the aft end
    const rake = Math.min(t.h * 0.9, (z1 - z0) * 0.3);
    const tier = (ya: number, yb: number, inset: number, color: number) => {
      const st: LoftStation[] = plan.map(([dz, k]) => {
        const zz = dz <= 1 && r > 0 ? z0 + dz * r : z0 + dz;
        const ww = Math.max(0.3, w * k - inset);
        const lean = (yy: number) => zz + rake * ((yy - y0) / t.h) * (1 - (zz - z0) / (z1 - z0));
        const pts: [number, number][] = [
          [ww, ya],
          [ww * 0.97, yb],
          [-ww * 0.97, yb],
          [-ww, ya],
        ];
        return { z: zz, ring: pts.flat(), zs: pts.map(([, yy]) => lean(yy)) };
      });
      geos.push(loftRings(st, { creases: [0, 1, 2, 3], capStart: true, capEnd: true, color }));
    };
    const yb = y0 + t.h * t.band;
    tier(y0, yb, 0.25, y.glass);
    tier(yb, y0 + t.h, 0, y.white);
    prevTop = y0 + t.h;
    if (i === 0) firstFront = z0;
    topZ = (z0 + z1) / 2;
    // lit windows along both sides of the band (and across its front)
    const n = Math.max(1, Math.floor((z1 - z0) / 9));
    for (let k = 0; k <= n; k++) for (const sx of [-1, 1]) light(sx * (w - 0.1), y0 + t.h * t.band * 0.5, z0 + r + ((z1 - z0 - r) * k) / n, CABIN, 'deck');
    light(0, y0 + t.h * t.band * 0.5, z0 - 0.1, CABIN, 'deck');
  });
  void base;
  const top = prevTop || F;

  // rig (sailing yachts)
  let mastHead = 0;
  let mastHeadZ = 0;
  const tipZ = zDeckTip - y.bowsprit;
  if (y.bowsprit > 0) geos.push(place(cylinderZ(0.45, 0.3, tipZ, zDeckTip + 4, 6, y.white), [0, deckAt(0) + 0.6, 0]));
  y.masts.forEach((m, i) => {
    const z = zAt(m.at, deckAt(m.at));
    const d = deckAt(m.at);
    const h = m.top - d;
    geos.push(place(cylinder(0.45, 0.85, h, 8, y.white), [0, d + h / 2, z]));
    m.spreaders.forEach((sy, k) => {
      const half = Math.max(2.5, 6.5 - k * 1.6);
      geos.push(place(box(half * 2, 0.5, 0.7, y.white), [0, sy, z]));
      // Koru's radar domes sit on her lowest crosstrees
      if (k === 0 && y.id === 'koru' && i !== 1) for (const sx of [-1, 1]) geos.push(place(ellipsoid(1.2, 1.2, 1.2, 8, 5, 0xf2f2ee), [sx * half * 0.6, sy + 1.3, z]));
      // shrouds from each crosstree's tips to the chainplates
      for (const sx of [-1, 1]) geos.push(rod([sx * half, sy, z], [sx * hw * y.tumble * yachtPlan(m.at), d + 0.6, z + 3], 0.18, 0x8a8f94));
    });
    // boom with its furled sail
    if (m.boom > 0) {
      geos.push(place(cylinderZ(0.5, 0.4, z + 1, z + m.boom, 6, y.white), [0, d + 6, 0]));
      geos.push(place(box(1.4, 1.3, m.boom * 0.85, y.white), [0, d + 7.1, z + 1 + m.boom * 0.45]));
    }
    // forestay to the bowsprit / bow or the mast ahead
    const prev = y.masts[i - 1];
    const fore: [number, number, number] = prev ? [0, prev.top - 4, zAt(prev.at, deckAt(prev.at))] : [0, deckAt(0) + 0.6, tipZ];
    geos.push(rod([0, m.top - 1, z], fore, 0.2, 0x8a8f94));
    if (m.top > mastHead) {
      mastHead = m.top;
      mastHeadZ = z;
    }
    light(0, m.top + 0.6, z, 0xff2a1a, 'deck', 2.4); // obstruction light
  });
  if (y.masts.length) {
    const last = y.masts[y.masts.length - 1];
    geos.push(rod([0, last.top - 1, zAt(last.at, deckAt(last.at))], [0, deckAt(1) + 0.5, L / 2 - 1], 0.2, 0x8a8f94)); // backstay
  }
  // radar mast (motor yachts): a raked tower off the top tier, a crossbar with two domes
  if (y.radar) {
    const z = zAt(y.radar.at, deckAt(y.radar.at));
    const h = y.radar.top - top;
    geos.push(rod([0, top, z + 2.5], [0, y.radar.top - 2, z - 0.5], 1.6, y.white));
    geos.push(place(box(7, 0.5, 1, y.white), [0, y.radar.top - 4, z]));
    for (const sx of [-1, 1]) geos.push(place(ellipsoid(1.3, 1.3, 1.3, 8, 5, 0xf2f2ee), [sx * 2.6, y.radar.top - 2.4, z]));
    geos.push(place(box(0.2, 2, 0.2, 0x8a8f94), [0, y.radar.top - 1, z - 0.5]));
    mastHead = Math.max(mastHead, top + h);
    mastHeadZ = z;
  }

  // navigation lights: sidelights at the front of the first tier, masthead, stern; anchor lights at moorings
  const sideY = (y.tiers[0]?.h ?? 2) + deckAt(0.4);
  const sideX = hw * y.tumble * yachtPlan(0.4) * 0.9;
  light(-sideX, sideY, firstFront || -L * 0.1, 0xff2a1a, 'way');
  light(sideX, sideY, firstFront || -L * 0.1, 0x2aff5a, 'way');
  light(0, Math.max(top + 3, mastHead - 3), mastHeadZ || topZ, 0xffffff, 'way');
  light(0, deckAt(1) + 1, L / 2 + 0.3, 0xffffff, 'stern');
  light(0, deckAt(0) + 3, zDeckTip + 3, 0xffffff, 'anchor');
  light(0, deckAt(1) + 3, L / 2 - 3, 0xffffff, 'anchor');
  // underwater lights: the blue glow along both sides and round the transom
  for (let u = 0.15; u < 0.97; u += 0.11) for (const sx of [-1, 1]) light(sx * (hw * yachtPlan(u) + 0.6), 0.6, zAt(u, 0), 0x38c8ff, 'deck', 3.6);
  light(0, 0.6, L / 2 + 0.8, 0x38c8ff, 'deck', 4.2);
  return { geos, lights };
}

/** Prototype of a named superyacht (cached by getGroundPrototype in ground.ts). */
export function buildSuperyacht(id: SuperyachtId): GroundPrototype {
  const y = SUPERYACHTS[id];
  const root = new Group();
  root.name = `ground:ship:${id}`;
  const { geos, lights } = superyachtParts(y);
  const body = meshFrom(geos, 'yacht');
  body.name = 'static';
  root.add(body);
  return { type: 'ship', root, spinners: [], wreck: 'ship', radius: y.length / 2, farScale: 3, lights };
}
