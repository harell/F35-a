/**
 * The Auckland Sky Tower: its own meshes and lights (not merged into the CBD), so it can fall.
 *
 *  - Standing: three meshes from the OSM profile in core/skyTower.ts — the stump below the break
 *    (8 buttress legs, shaft, collar), the upper section (shaft, pod tiers, SkyWalk, conical upper
 *    pod, Sky Deck, lower mast) and the top of the mast above the snap point — plus their own night
 *    lights (aviation lights, pod ring, shaft floodlights) and harbour reflections.
 *  - Collapse: SkyTowerVisual follows the sim's Sky Tower landmark. Once it is destroyed the lights
 *    go out and the upper section / mast are posed from collapsePose(world time − destroyedAt), then
 *    swapped for the ruin (jagged stump + rubble along the fall line) under the impact dust.
 *  - It is never down at the start of a sortie (issue #75): every scene builds it standing. An enemy
 *    hit's fire and smoke are effects (render/effects/Effects.ts), not geometry.
 */
import { Color, Group, Mesh, Quaternion, Vector3, type Material, type Object3D, type Points } from 'three';
import { AKL } from '../../core/auckland';
import { mulberry32 } from '../../core/math';
import {
  COLLAPSE,
  POD_HEIGHT,
  SKY_TOWER_BANDS,
  SKY_TOWER_COLOURS,
  SKY_TOWER_HEIGHT,
  SKY_TOWER_LEGS,
  collapsePose,
  headingDir,
  towerAxisPoint,
  type CollapsePose,
  type TowerMaterial,
} from '../../core/skyTower';
import type { SimWorld } from '../../sim/api';
import type { LandmarkEntity } from '../../sim/landmarks';
import { frameFromHeading, GeometryBuilder, IDENT_FRAME, WIN_GLOW, WIN_NONE, type Frame } from './GeometryBuilder';
import { LightList, type HeightFn } from './builders';
import type { ReflectionSource } from './nightLights';

const COLOUR: Record<TowerMaterial, number> = {
  concrete: SKY_TOWER_COLOURS.concrete,
  metal: SKY_TOWER_COLOURS.glass,
  refuge: 0x26292b,
  glass: 0x46606b, // tinted glazing (OSM gives the frame colour #9BA9A9)
  mast: SKY_TOWER_COLOURS.glass,
};
const CUT = 0x4a4844; // broken concrete
const RUBBLE = [0x8f918c, 0xa3a59f, 0x6f706b, 0x7c8a8f, 0x55595a];

function segmentsFor(r: number): number {
  return r >= 12 ? 28 : r >= 6 ? 18 : r >= 2 ? 10 : 6;
}

/** Ground level (y) of the tower's base. */
export function skyTowerGround(height: HeightFn): number {
  const { x, z } = AKL.skytower;
  return height(x, z) - 2;
}

/**
 * Bands of the profile between `from` and `to` (m above the base), built around the axis at the
 * frame's origin with y = height − `origin`. Cut ends get a cap (`capBottom` for the underside).
 */
export function buildTowerSection(B: GeometryBuilder, from: number, to: number, origin: number, capBottom = false, f: Frame = IDENT_FRAME): void {
  for (const b of SKY_TOWER_BANDS) {
    const y0 = Math.max(b.y0, from);
    const y1 = Math.min(b.y1, to);
    if (y1 - y0 < 0.05) continue;
    const rAt = (y: number) => b.r0 + ((b.r1 - b.r0) * (y - b.y0)) / (b.y1 - b.y0);
    const r0 = rAt(y0);
    const r1 = rAt(y1);
    const segs = segmentsFor(b.r0);
    const col = COLOUR[b.material];
    const win = b.material === 'glass' ? WIN_GLOW : WIN_NONE;
    B.cylinder(f, 0, y0 - origin, 0, r0, r1, y1 - y0, segs, col, win, r1 > 0.01, y1 < b.y1 ? CUT : undefined);
    if (capBottom && y0 > b.y0 && r0 > 0.01) disc(B, f, y0 - origin, r0, segs, CUT, true);
  }
  if (from < SKY_TOWER_LEGS.height) legs(B, f, from, to, origin);
}

/** Horizontal disc (facing down if `down`). */
function disc(B: GeometryBuilder, f: Frame, y: number, r: number, segs: number, color: number, down: boolean): void {
  for (let i = 0; i < segs; i++) {
    const a0 = (i / segs) * Math.PI * 2;
    const a1 = ((i + 1) / segs) * Math.PI * 2;
    const p0 = [Math.cos(a0) * r, y, Math.sin(a0) * r];
    const p1 = [Math.cos(a1) * r, y, Math.sin(a1) * r];
    B.tri(f, down ? [0, y, 0, ...p0, ...p1] : [0, y, 0, ...p1, ...p0], color);
  }
}

/**
 * The 8 buttress legs: wedges from the shaft face (80 m high) down to the ground at the outer edge,
 * clipped to [from, to].
 */
function legs(B: GeometryBuilder, f: Frame, from: number, to: number, origin: number): void {
  const L = SKY_TOWER_LEGS;
  const top = Math.min(L.height, to);
  if (top <= from) return;
  const col = COLOUR.concrete;
  const rIn = L.rIn - 0.3; // tucked into the shaft
  // outer face: r(y) = rOut − (rOut − rIn)·y/height
  const rOf = (y: number) => L.rOut - ((L.rOut - L.rIn) * y) / L.height;
  const y0 = Math.max(0, from);
  for (let k = 0; k < L.count; k++) {
    const h = (k / L.count) * Math.PI * 2;
    const [ux, uz] = headingDir(h);
    const tx = -uz;
    const tz = ux;
    const w = L.width / 2;
    const P = (r: number, y: number, side: number) => [ux * r + tx * w * side, y - origin, uz * r + tz * w * side];
    const ro0 = rOf(y0);
    const ro1 = rOf(top);
    // sloped outer face (normal outward / up), two sides, and the cut top if clipped
    face(B, [...P(ro0, y0, -1), ...P(ro0, y0, 1), ...P(ro1, top, 1), ...P(ro1, top, -1)], col, ux, uz, 0, f);
    face(B, [...P(rIn, y0, 1), ...P(rIn, top, 1), ...P(ro1, top, 1), ...P(ro0, y0, 1)], col, tx, tz, 0, f);
    face(B, [...P(rIn, y0, -1), ...P(ro0, y0, -1), ...P(ro1, top, -1), ...P(rIn, top, -1)], col, -tx, -tz, 0, f);
    if (top < L.height) face(B, [...P(rIn, top, -1), ...P(ro1, top, -1), ...P(ro1, top, 1), ...P(rIn, top, 1)], CUT, 0, 0, 1, f);
  }
}

/** Quad (4 points) or triangle (3) whose normal is flipped to face (ox, oy, oz). */
function face(B: GeometryBuilder, p: number[], color: number, ox: number, oz: number, oy = 0, f: Frame = IDENT_FRAME): void {
  const n = p.length / 3;
  const ax = p[3] - p[0], ay = p[4] - p[1], az = p[5] - p[2];
  const bx = p[(n - 1) * 3] - p[0], by = p[(n - 1) * 3 + 1] - p[1], bz = p[(n - 1) * 3 + 2] - p[2];
  const nx = ay * bz - az * by;
  const ny = az * bx - ax * bz;
  const nz = ax * by - ay * bx;
  let q = p;
  if (nx * ox + ny * oy + nz * oz < 0) {
    q = [];
    for (let i = n - 1; i >= 0; i--) q.push(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]);
  }
  if (n === 4) B.quad(f, q, color);
  else B.tri(f, q, color);
}

/** Night lights of the standing tower (world positions; base at ground y `g`). */
export function buildSkyTowerLights(lights: LightList, g: number): void {
  const { x, z } = AKL.skytower;
  // aviation lights
  lights.add(x, g + SKY_TOWER_HEIGHT + 1, z, 0xff2a18, 5, 0.1);
  lights.add(x, g + 300, z, 0xff2a18, 4, 0.6);
  lights.add(x, g + 262, z, 0xffffff, 4, 0.35);
  // the lit restaurant ring (Orbit) and the SkyWalk edge
  for (let k = 0; k < 16; k++) {
    const a = (k / 16) * Math.PI * 2;
    lights.add(x + Math.cos(a) * 17.2, g + 190.5, z + Math.sin(a) * 17.2, 0x9fd0ff, 3);
  }
  // shaft floodlights
  for (let y = 30; y < 155; y += 30) lights.add(x, g + y, z - 7.5, 0xaec8ff, 5);
}

/**
 * The ruin, in world coordinates: the jagged stump and a rubble field along the fall line (the
 * shaft lying in sections, the crushed pod, the upper pod and the snapped mast, debris).
 */
export function buildSkyTowerRuins(B: GeometryBuilder, height: HeightFn, fallHeading: number): void {
  const { x, z } = AKL.skytower;
  const g = skyTowerGround(height);
  const rnd = mulberry32((Math.round(fallHeading * 1000) * 2654435761) >>> 0);
  const [ux, uz] = headingDir(fallHeading);
  const tx = -uz;
  const tz = ux;
  const stumpTop = COLLAPSE.breakHeight - 8;

  // stump: legs, collar and shaft with a jagged crown
  buildTowerSection(B, 0, stumpTop, -g, false, { ox: x, oy: 0, oz: z, c: 1, s: 0 });
  const segs = 18;
  const r = 6.1;
  const jag: number[] = [];
  for (let i = 0; i < segs; i++) jag.push(1 + rnd() * 9 * (i % 3 === 0 ? 1.4 : 1));
  for (let i = 0; i < segs; i++) {
    const a0 = (i / segs) * Math.PI * 2;
    const a1 = ((i + 1) / segs) * Math.PI * 2;
    const j0 = jag[i];
    const j1 = jag[(i + 1) % segs];
    const c0 = Math.cos(a0), s0 = Math.sin(a0), c1 = Math.cos(a1), s1 = Math.sin(a1);
    const yb = g + stumpTop;
    face(B, [x + c1 * r, yb, z + s1 * r, x + c0 * r, yb, z + s0 * r, x + c0 * r, yb + j0, z + s0 * r, x + c1 * r, yb + j1, z + s1 * r], COLOUR.concrete, c0 + c1, s0 + s1);
    face(B, [x + c0 * r * 0.7, yb + j0 * 0.6, z + s0 * r * 0.7, x + c1 * r * 0.7, yb + j1 * 0.6, z + s1 * r * 0.7, x + c1 * r, yb + j1, z + s1 * r, x + c0 * r, yb + j0, z + s0 * r], CUT, 0, 0, 1);
  }
  disc(B, { ox: x, oy: 0, oz: z, c: 1, s: 0 }, g + stumpTop + 0.5, r * 0.75, segs, CUT, false);

  // where a point that stood h m up came to rest (the end of the collapse)
  const end: [number, number] = [0, 0];
  const restAt = (h: number) => towerAxisPoint(h, COLLAPSE.impactAt, end)[0];
  const at = (along: number, side: number) => [x + ux * along + tx * side, z + uz * along + tz * side] as const;

  // the shaft in broken sections
  const shaftFrom = restAt(COLLAPSE.breakHeight) + 4;
  const shaftTo = restAt(150);
  const pieces = 6;
  for (let i = 0; i < pieces; i++) {
    const a = shaftFrom + ((shaftTo - shaftFrom) * (i + 0.5)) / pieces;
    const [px, pz] = at(a, (rnd() - 0.5) * 6);
    const f = frameFromHeading(px, height(px, pz) - 2.5, pz, fallHeading + (rnd() - 0.5) * 0.35);
    const len = ((shaftTo - shaftFrom) / pieces) * (0.75 + rnd() * 0.15);
    B.box(f, 0, 0, 0, 11.5, 9 + rnd() * 3, len, COLOUR.concrete, CUT);
  }
  // the crushed pod: glass and metal tiers pancaked on the street
  {
    const [px, pz] = at(restAt(POD_HEIGHT), 0);
    const gy = height(px, pz) - 1.5;
    B.cylinder(IDENT_FRAME, px, gy, pz, 18, 15, 6, 20, COLOUR.metal, WIN_NONE, true, COLOUR.refuge);
    B.cylinder(IDENT_FRAME, px + tx * 3, gy + 6, pz + tz * 3, 14, 9, 5, 16, COLOUR.glass, WIN_NONE, true, CUT);
    B.cylinder(IDENT_FRAME, px - tx * 4, gy, pz - tz * 4, 21, 20, 1.5, 20, COLOUR.metal, WIN_NONE, true); // SkyWalk ring
  }
  // the upper pod and the mast, snapped
  {
    const [ax, az] = at(restAt(205), 2);
    const [bx, bz] = at(restAt(240), 3);
    B.beam(IDENT_FRAME, ax, height(ax, az) + 3, az, bx, height(bx, bz) + 2, bz, 9, COLOUR.metal);
    const [cx, cz] = at(restAt(245), 4);
    const [dx, dz] = at(restAt(COLLAPSE.mastSnapHeight) - 2, 5);
    B.beam(IDENT_FRAME, cx, height(cx, cz) + 1.6, cz, dx, height(dx, dz) + 1.4, dz, 3.4, COLOUR.mast);
    const kink = (rnd() - 0.5) * 30;
    const [ex, ez] = at(restAt(COLLAPSE.mastSnapHeight) + 4, 8);
    const [fx, fz] = at(restAt(310), 8 + kink);
    B.beam(IDENT_FRAME, ex, height(ex, ez) + 1.2, ez, fx, height(fx, fz) + 1, fz, 2.4, COLOUR.mast);
    const [hx, hz] = at(restAt(SKY_TOWER_HEIGHT), 10 + kink * 1.3);
    B.beam(IDENT_FRAME, fx, height(fx, fz) + 1, fz, hx, height(hx, hz) + 0.6, hz, 1.2, COLOUR.mast);
  }
  // debris: concrete, cladding and glass along the fall line and around the stump
  const reach = restAt(POD_HEIGHT) + 25;
  for (let i = 0; i < 70; i++) {
    const near = i < 14;
    const a = near ? (rnd() - 0.3) * 30 : 10 + rnd() * reach;
    const side = (rnd() - 0.5) * (near ? 34 : 18 + a * 0.12);
    const [px, pz] = near ? [x + ux * a + tx * side, z + uz * a + tz * side] : at(a, side);
    const s = 1.5 + rnd() * (near ? 4 : 5);
    const f = frameFromHeading(px, height(px, pz) - 0.5, pz, rnd() * Math.PI * 2);
    B.box(f, 0, 0, 0, s, s * (0.4 + rnd() * 0.5), s * (0.6 + rnd() * 0.8), RUBBLE[(rnd() * RUBBLE.length) | 0], CUT);
  }
}

interface Pieces {
  base: Mesh;
  upper: Mesh;
  mast: Mesh;
  lights: Points | null;
}

const _axis = new Vector3();
const _q = new Quaternion();

/**
 * The tower in the scene: standing, falling (driven by the sim's Sky Tower landmark) or in ruins.
 * Geometries are owned here (dispose()).
 */
export class SkyTowerVisual {
  readonly group = new Group();
  /** Bright tower lights near / above the water, for the harbour reflections (empty when down). */
  readonly reflectionSources: ReflectionSource[] = [];
  private readonly pieces: Pieces;
  private ruin: Mesh | null = null;
  private reflections: Object3D | null = null;
  private broken = false;
  private readonly pose: CollapsePose = { tilt: 0, mastTilt: 0, footAlong: 0, footUp: 0 };
  private readonly g: number;

  constructor(
    private readonly material: Material,
    lightsMaterial: Material | null,
    private readonly height: HeightFn,
  ) {
    this.group.name = 'akl-skytower';
    this.g = skyTowerGround(height);
    const { x, z } = AKL.skytower;
    const C = COLLAPSE;
    const mesh = (b: GeometryBuilder, name: string): Mesh => {
      const m = new Mesh(b.build()!, material);
      m.name = name;
      return m;
    };
    const base = new GeometryBuilder();
    buildTowerSection(base, 0, C.breakHeight, 0);
    const upper = new GeometryBuilder();
    buildTowerSection(upper, C.breakHeight, C.mastSnapHeight, C.breakHeight, true);
    const mast = new GeometryBuilder();
    buildTowerSection(mast, C.mastSnapHeight, SKY_TOWER_HEIGHT, C.mastSnapHeight, true);
    const p: Pieces = { base: mesh(base, 'akl-skytower-base'), upper: mesh(upper, 'akl-skytower-upper'), mast: mesh(mast, 'akl-skytower-mast'), lights: null };
    p.base.position.set(x, this.g, z);
    p.base.updateMatrix();
    p.base.matrixAutoUpdate = false;
    p.upper.position.set(x, this.g + C.breakHeight, z);
    p.mast.position.set(0, C.mastSnapHeight - C.breakHeight, 0);
    p.upper.add(p.mast);
    this.group.add(p.base, p.upper);
    if (lightsMaterial) {
      const lights = new LightList();
      buildSkyTowerLights(lights, this.g);
      p.lights = lights.build(lightsMaterial);
      if (p.lights) {
        p.lights.name = 'akl-skytower-lights';
        this.group.add(p.lights);
      }
      // steady lights high on the tower (the pod ring), as in Scenery's reflection filter
      const c = new Color();
      lights.forEach((lx, ly, lz, r, gg, b, size, blink) => {
        if (blink >= 0 || size < 2.4 || ly - this.g < 150) return;
        this.reflectionSources.push({ x: lx, y: ly, z: lz, color: c.setRGB(r, gg, b).getHex(), intensity: Math.min(1.3, 0.22 * size) });
      });
    }
    this.pieces = p;
  }

  /** The harbour-reflection mesh of the tower's lights (hidden when it falls). */
  setReflections(o: Object3D | null): void {
    this.reflections = o;
    if (o && this.broken) o.visible = false;
  }

  /** Follow the sim's Sky Tower (if this sortie has one). */
  update(world: SimWorld | null | undefined): void {
    const p = this.pieces;
    if (!world?.landmarks) return;
    let lm: LandmarkEntity | null = null;
    for (const l of world.landmarks) if (l.id === 'skytower') lm = l;
    if (!lm || lm.alive) return;
    const t = world.time - lm.destroyedAt;
    if (!this.broken) {
      this.broken = true;
      if (p.lights) p.lights.visible = false;
      if (this.reflections) this.reflections.visible = false;
    }
    if (t >= COLLAPSE.ruinsAt) {
      if (!this.ruin) {
        this.buildRuin(lm.fallHeading);
        p.base.visible = false;
        p.upper.visible = false;
      }
      return;
    }
    const { x, z } = AKL.skytower;
    const pose = collapsePose(t, this.pose);
    const [ux, uz] = headingDir(lm.fallHeading);
    // rotating +Y toward the fall direction: axis = up × dir
    _axis.set(uz, 0, -ux);
    p.upper.position.set(x + ux * pose.footAlong, this.g + pose.footUp, z + uz * pose.footAlong);
    p.upper.quaternion.setFromAxisAngle(_axis, pose.tilt);
    p.mast.quaternion.copy(_q.setFromAxisAngle(_axis, pose.mastTilt));
  }

  /** Current state (tests / debug). */
  get state(): 'standing' | 'falling' | 'ruin' {
    return this.ruin ? 'ruin' : this.broken ? 'falling' : 'standing';
  }

  private buildRuin(heading: number): void {
    const b = new GeometryBuilder();
    buildSkyTowerRuins(b, this.height, heading);
    const m = new Mesh(b.build()!, this.material);
    m.name = 'akl-skytower-ruin';
    m.matrixAutoUpdate = false;
    this.ruin = m;
    this.group.add(m);
  }

  dispose(): void {
    this.group.removeFromParent();
    this.group.traverse((o) => {
      const g = (o as Mesh).geometry;
      if (g) g.dispose();
    });
  }
}
