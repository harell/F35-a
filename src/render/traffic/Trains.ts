/**
 * Trains (#146): Auckland Transport AM class sets and KiwiRail container trains, drawn from the sortie's
 * timetable (sim/civil/rail.ts TrainService on world.trains). One InstancedMesh per model, four draw
 * calls by day and night alike: the AM end car (AMA / AMP, cab forward; the AMP is the same car turned
 * round), the AM middle car (AMT, with the pantograph), the DL locomotive and the container flat wagon.
 *
 * Each frame the trains nearest the camera within the tier's range are posed (QualitySettings.trains of
 * them, the player's designated one always), car by car on the track; a car in a tunnel is not drawn,
 * so a train runs into the CRL at the Maungawhau portal and out east of Waitematā. Destroyed trains
 * stay where they stopped, charred and knocked askew.
 *
 * Livery (code-built, vertex colours): AT's silver body with a dark navy window band, bright yellow
 * doors, a yellow cab front round a black windscreen and the round blue AT roundel by the cab; KiwiRail's
 * red body side with a white stripe, yellow cab ends, grey roof and black underframe; containers in
 * shipping-line colours (instance colours). At night the windows, the destination display and the DL's
 * cab glow (a per-vertex glow term in the shared material, not another draw call), headlights and tail
 * lights go through the entity renderer's sprite batch.
 */
import { BufferAttribute, BufferGeometry, Color, Euler, InstancedBufferAttribute, InstancedMesh, Matrix4, MeshLambertMaterial, Quaternion, Vector3 } from 'three';
import type { SpriteBatch } from '../effects/SpriteBatch';
import { box, merge, place } from '../models/geom/core';
import { CAR_LENGTH, CAR_WIDTH, CONTAINER_TINTS, type CarKind, type CarPose, type TrainService, type UnitState } from '../../sim/civil/rail';

const SILVER = 0xc9ced3;
const PINSTRIPE = 0x8d949b;
const NAVY = 0x1d2a4a;
const YELLOW = 0xf2c418;
const BLACK = 0x16181b;
const ROOF = 0x7b8086;
const UNDER = 0x2c2e31;
const AT_BLUE = 0x1f5fae;
const WHITE = 0xf1f2ee;
const KR_RED = 0xc4262e;
const DECK = 0x4a4c4f;

/** Container colours (index 1…): Maersk blue, MSC gold, CMA navy, Hapag orange, ONE magenta, Evergreen green, Hamburg Süd red. */
const CONTAINER_COLORS = [0xffffff, 0x4aa3d6, 0xd9b23a, 0x2d4f8a, 0xe0782d, 0xc0307a, 0x3b8a4d, 0xb5352d];
const WRECK = new Color(0.24, 0.22, 0.2);

const KINDS: readonly CarKind[] = ['am_end', 'am_mid', 'dl', 'wagon'];

/** Draw range of the trains (m) per tier: about where a 3 m wide car is still a pixel or two. */
const RANGE: Record<'low' | 'medium' | 'high', number> = { low: 6_000, medium: 9_000, high: 13_000 };
/** Headlights and tail lights out to this range (m), at night. */
const LIGHTS_FAR = 8_000;
/** Most wrecks drawn. */
const MAX_WRECKS = 8;

type Geo = BufferGeometry;
/** A box whose faces glow at night (windows, displays). Boxes are (x = width, y = height, z = length). */
function glowing(g: Geo): Geo {
  g.userData.glow = true;
  return g;
}

/** Merge parts and give them the per-vertex `glow` attribute (1 on glowing parts). */
function build(parts: Geo[]): Geo {
  for (const p of parts) {
    const n = p.getAttribute('position').count;
    p.setAttribute('glow', new BufferAttribute(new Float32Array(n).fill(p.userData.glow ? 1 : 0), 1));
  }
  const g = merge(parts)!;
  g.computeBoundingSphere();
  return g;
}

/** An AM class car, bow at −Z, rail top at y = 0. `cab`: the end car (AMA / AMP), else the AMT with the pantograph. */
export function amCarGeometry(cab: boolean): Geo {
  const L = CAR_LENGTH[cab ? 'am_end' : 'am_mid'];
  const W = CAR_WIDTH.am_end;
  const body = cab ? L - 1.2 : L; // the cab front takes the last 1.2 m
  const zc = cab ? 0.6 : 0;
  const g: Geo[] = [
    place(box(W - 0.5, 0.8, L - 3, UNDER), [0, 0.55, 0]), // underframe and bogies
    place(box(W, 1.25, body, SILVER), [0, 1.55, zc]), // lower body
    place(box(W + 0.02, 0.08, body + 0.02, PINSTRIPE), [0, 1.95, zc]), // pinstripe
    glowing(place(box(W + 0.04, 0.95, body - 0.4, NAVY), [0, 2.65, zc])), // window band
    place(box(W, 0.75, body, SILVER), [0, 3.5, zc]), // upper body
    place(box(W - 0.3, 0.12, L - 0.6, ROOF), [0, 3.93, zc * 0.5]), // roof
  ];
  // two double doors a side, yellow
  for (const z of [-L / 4, L / 4]) g.push(place(box(W + 0.08, 2.05, 1.35, YELLOW), [0, 2.0, z + zc]));
  if (cab) {
    g.push(
      place(box(W - 0.06, 2.9, 1.2, YELLOW), [0, 2.35, -L / 2 + 0.6]), // cab front
      place(box(W - 0.5, 1.05, 0.12, BLACK), [0, 2.75, -L / 2 - 0.02]), // windscreen
      glowing(place(box(1.5, 0.28, 0.1, 0x3a2a12), [0, 3.5, -L / 2 - 0.02])), // destination display
      place(box(W + 0.1, 0.62, 0.62, AT_BLUE), [0, 1.6, -L / 2 + 2.3]), // AT roundel
      place(box(W + 0.14, 0.3, 0.3, WHITE), [0, 1.6, -L / 2 + 2.3]),
    );
  } else {
    // pantograph: a frame and a head on the roof
    g.push(place(box(1.6, 0.18, 2.6, BLACK), [0, 4.05, -2]), place(box(1.9, 0.08, 0.3, 0x9a9da0), [0, 4.45, -2]));
  }
  return build(g);
}

/** A KiwiRail DL Co-Co diesel, cab at each end, bow at −Z. */
export function dlGeometry(): Geo {
  const L = CAR_LENGTH.dl;
  const W = CAR_WIDTH.dl;
  const g: Geo[] = [
    place(box(W - 0.4, 1.0, L - 2, BLACK), [0, 0.6, 0]), // bogies and underframe
    place(box(W, 2.6, L - 4.4, KR_RED), [0, 2.4, 0]), // red body side
    place(box(W + 0.02, 0.18, L - 4.4, WHITE), [0, 1.7, 0]), // white stripe
    place(box(W + 0.02, 0.14, L - 4.4, WHITE), [0, 3.3, 0]),
    place(box(W - 0.3, 0.25, L - 1.0, ROOF), [0, 3.78, 0]), // roof
    place(box(1.4, 0.5, 2.6, BLACK), [0, 4.1, 1.5]), // exhaust and radiator housing
  ];
  for (const s of [-1, 1]) {
    g.push(place(box(W, 2.7, 2.2, YELLOW), [0, 2.45, s * (L / 2 - 1.1)])); // cab ends
    g.push(glowing(place(box(W - 0.5, 0.75, 0.1, BLACK), [0, 3.05, s * (L / 2 + 0.02)]))); // windscreens
  }
  return build(g);
}

/** A container flat wagon with one 40 ft box (the box white: the instance colour paints it), bow at −Z. */
export function wagonGeometry(): Geo {
  const L = CAR_LENGTH.wagon;
  const W = CAR_WIDTH.wagon;
  return build([
    place(box(W - 0.6, 0.8, L - 2.5, UNDER), [0, 0.55, 0]),
    place(box(W, 0.35, L, DECK), [0, 1.12, 0]),
    place(box(2.44, 2.59, 12.19, 0xe8e8e8), [0, 2.6, 0]),
    place(box(2.46, 0.12, 12.21, 0xb8b8b8), [0, 3.85, 0]), // roof edge
  ]);
}

/** The cars' shared material: vertex colours × instance colour, and at night the `glow` parts lit. */
function trainMaterial(): { mat: MeshLambertMaterial; night: { value: number } } {
  const mat = new MeshLambertMaterial({ color: 0xffffff, vertexColors: true });
  const night = { value: 0 };
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uNight = night;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float glow;\nvarying float vGlow;')
      // a wreck (dark instance colour) stays dark
      .replace('#include <color_vertex>', '#include <color_vertex>\nvGlow = glow;\n#ifdef USE_INSTANCING_COLOR\nvGlow *= step(0.6, instanceColor.r + instanceColor.g);\n#endif');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uNight;\nvarying float vGlow;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += vGlow * uNight * vec3(1.0, 0.82, 0.55);');
  };
  mat.customProgramCacheKey = () => 'f35-trains';
  return { mat, night };
}

const _m = new Matrix4();
const _q = new Quaternion();
const _e = new Euler(0, 0, 0, 'YXZ');
const _p = new Vector3();
const _s = new Vector3(1, 1, 1);
const _c = new Color();
const _l = new Vector3();

interface Pick {
  unit: number;
  d2: number;
}

export class TrainRenderer {
  readonly meshes: Record<CarKind, InstancedMesh>;
  private readonly night: { value: number };
  private readonly mat: MeshLambertMaterial;
  private readonly max: number;
  private readonly range: number;
  private readonly picks: Pick[] = [];
  private readonly st: UnitState = { path: null!, s: 0, v: 0, x: 0, z: 0 };
  private readonly poses: CarPose[] = [];
  private readonly count: Record<CarKind, number> = { am_end: 0, am_mid: 0, dl: 0, wagon: 0 };
  /** Front and rear lights of the trains drawn this frame (x, y, z, heading; front first), for addLights(). */
  private readonly ends: number[] = [];
  /** Trains drawn in the last update() (wrecks excluded). */
  drawn = 0;

  constructor(maxTrains: number, tier: 'low' | 'medium' | 'high') {
    this.max = Math.max(0, maxTrains);
    this.range = RANGE[tier];
    const { mat, night } = trainMaterial();
    this.mat = mat;
    this.night = night;
    // capacity: every drawn train a 6-car set (4 end cars, 2 middle), two 2-loco freights of 30 wagons, the wrecks
    const n = this.max + MAX_WRECKS;
    const cap: Record<CarKind, number> = { am_end: 4 * n, am_mid: 2 * n, dl: 2 * 3, wagon: 30 * 3 };
    const geo: Record<CarKind, () => Geo> = { am_end: () => amCarGeometry(true), am_mid: () => amCarGeometry(false), dl: dlGeometry, wagon: wagonGeometry };
    const meshes = {} as Record<CarKind, InstancedMesh>;
    for (const k of KINDS) {
      const m = new InstancedMesh(geo[k](), mat, cap[k]);
      m.name = `trains-${k}`;
      m.instanceColor = new InstancedBufferAttribute(new Float32Array(cap[k] * 3).fill(1), 3);
      // the instances span the city: few and small, so no culling
      m.frustumCulled = false;
      m.count = 0;
      meshes[k] = m;
    }
    this.meshes = meshes;
  }

  setNight(night: boolean): void {
    this.night.value = night ? 1 : 0;
  }

  /** Pose the trains nearest `cam` at sim time `time`; `keep` (a unit id, or -1) is drawn whatever its range. */
  update(svc: TrainService, time: number, cam: Vector3, keep = -1): void {
    for (const k of KINDS) this.count[k] = 0;
    this.ends.length = 0;
    const picks = this.picks;
    picks.length = 0;
    const r2 = this.range * this.range;
    for (const u of svc.units) {
      if (svc.isWrecked(u.id)) continue;
      svc.state(u, time, this.st);
      const d2 = (this.st.x - cam.x) ** 2 + (this.st.z - cam.z) ** 2;
      if (d2 > r2 && u.id !== keep) continue;
      picks.push({ unit: u.id, d2: u.id === keep ? -1 : d2 });
    }
    picks.sort((a, b) => a.d2 - b.d2);
    const n = Math.min(this.max, picks.length);
    this.drawn = 0;
    for (let i = 0; i < n; i++) {
      const u = svc.units[picks[i].unit];
      svc.state(u, time, this.st);
      const cars = svc.cars(u, this.st, this.poses);
      let any = false;
      for (const c of cars) {
        if (c.hidden) continue;
        any = true;
        this.add(c, c.kind === 'wagon' ? CONTAINER_COLORS[c.tint % CONTAINER_TINTS] : 0xffffff, false);
      }
      if (any) this.drawn++;
      const f = cars[0];
      const b = cars[cars.length - 1];
      // a passenger set shows its headlights forward and tail lights aft; the freight's lead loco only
      if (!f.hidden) this.ends.push(f.x, f.y, f.z, f.heading + (f.kind === 'am_end' || f.kind === 'dl' ? 0 : Math.PI), 1, CAR_LENGTH[f.kind]);
      if (!b.hidden && b.kind === 'am_end') this.ends.push(b.x, b.y, b.z, b.heading, 0, CAR_LENGTH[b.kind]);
    }
    let w = 0;
    for (const wr of svc.wrecks.values()) {
      if (w++ >= MAX_WRECKS) break;
      wr.cars.forEach((c, i) => !c.hidden && this.add(c, WRECK.getHex(), true, i));
    }
    for (const k of KINDS) {
      const m = this.meshes[k];
      m.count = this.count[k];
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }
  }

  private add(c: CarPose, color: number, wreck: boolean, i = 0): void {
    const m = this.meshes[c.kind];
    const k = this.count[c.kind];
    if (k >= m.instanceMatrix.count) return;
    // a wreck: knocked askew, half off the rails
    const askew = wreck ? (((i * 7919) % 13) / 13 - 0.5) * 0.5 : 0;
    _e.set(c.pitch, -c.heading + askew * 0.3, askew * 0.6);
    _q.setFromEuler(_e);
    _p.set(c.x, c.y - (wreck ? 0.4 : 0), c.z);
    _m.compose(_p, _q, _s);
    m.setMatrixAt(k, _m);
    m.setColorAt(k, _c.setHex(color));
    this.count[c.kind] = k + 1;
  }

  /** Headlights (white, forward) and tail lights (red) of the trains drawn, at night. Call after update(). */
  addLights(lights: SpriteBatch, cam: Vector3): void {
    const e = this.ends;
    for (let i = 0; i < e.length; i += 6) {
      const [x, y, z, h, front, L] = [e[i], e[i + 1], e[i + 2], e[i + 3], e[i + 4], e[i + 5]];
      if ((x - cam.x) ** 2 + (z - cam.z) ** 2 > LIGHTS_FAR * LIGHTS_FAR) continue;
      const fx = Math.sin(h);
      const fz = -Math.cos(h);
      const rx = -fz;
      const rz = fx;
      for (const side of [-0.85, 0.85]) {
        _l.set(x + fx * (L / 2 + 0.1) + rx * side, y + 1.25, z + fz * (L / 2 + 0.1) + rz * side);
        const ok = front ? lights.add(_l.x, _l.y, _l.z, 2.6, 2.5, 2.2, 1, 1.2, 3) : lights.add(_l.x, _l.y, _l.z, 2.2, 0.15, 0.1, 1, 0.9, 2.2);
        if (!ok) return;
      }
    }
  }

  /** Triangles drawn by the last update() (for the stats overlay and tests). */
  triangles(): number {
    let t = 0;
    for (const k of KINDS) {
      const m = this.meshes[k];
      const idx = m.geometry.getIndex();
      t += ((idx ? idx.count : m.geometry.getAttribute('position').count) / 3) * m.count;
    }
    return t;
  }

  dispose(): void {
    for (const k of KINDS) {
      const m = this.meshes[k];
      m.removeFromParent();
      m.geometry.dispose();
      m.dispose();
    }
    this.mat.dispose();
  }
}
