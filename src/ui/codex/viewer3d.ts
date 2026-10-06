/**
 * F35-A UI — Codex 3D viewer: a small three.js scene per weapon page.
 *   Inspect    the munition alone, turning slowly; drag to rotate.
 *   In action  the launch or drop against one example of a target class, with the game's blast
 *              falloff (sim/weapons/flight.ts applyBlast) deciding the result shown under the view.
 *              The jet breaks away after launch; a blue beam shows datalink course updates for the
 *              weapons that take them from the jet (AMRAAM, StormBreaker).
 * Models are schematic and enlarged; blast rings are drawn to the grid's scale (one square = 50 m).
 * Renders only while the canvas is on screen; dispose() frees the WebGL context.
 */
import * as THREE from 'three';
import { GROUND_TARGET_DATA, SAM_SITE_DATA } from '../../sim/damage/tables';
import { MUNITIONS } from '../../sim/weapons/defs';
import { GUN_HIT_DAMAGE, targetHp, type TargetClass, type WeaponEntry } from './data';

/** Scene units per metre: 1 unit = 10 m (a 5-unit grid square is 50 m). */
const S = 10;
const XA = new THREE.Vector3(1, 0, 0);
const v3 = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

const TARGET_NAME: Record<string, string> = {
  fighter: 'Fighter', sa6: 'SAM site', fuel: 'Fuel depot', hangar: 'Hangar', missile_boat: 'Missile boat',
};

interface Target {
  type: string;
  name: string;
  hp: number;
  radius: number;
  air: boolean;
  water: boolean;
  moving: boolean;
  emitter: boolean;
}

function targetOf(cls: TargetClass): Target {
  const type = cls.example;
  const sam = (SAM_SITE_DATA as Record<string, { radius: number } | undefined>)[type];
  const g = (GROUND_TARGET_DATA as Record<string, { radius: number; naval: boolean } | undefined>)[type];
  return {
    type,
    name: TARGET_NAME[type] ?? cls.name,
    hp: targetHp(type) ?? 100,
    radius: type === 'fighter' ? 8 : sam?.radius ?? g?.radius ?? 10,
    air: cls.id === 'air',
    water: !!g?.naval || cls.id === 'boat',
    moving: !!cls.moving && cls.id !== 'air',
    emitter: !!cls.emitters?.includes(type),
  };
}

/* ───────────────────────────── geometry helpers ───────────────────────────── */

function mat(color: number, o: THREE.MeshStandardMaterialParameters = {}): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.5, metalness: 0.3, ...o });
}
/** Cylinder along +X from x to x+len (radius rB at the back, rF at the front). */
function cylX(rB: number, rF: number, len: number, m: THREE.Material, x: number): THREE.Mesh {
  const g = new THREE.CylinderGeometry(rF, rB, len, 28);
  g.rotateZ(-Math.PI / 2);
  const me = new THREE.Mesh(g, m);
  me.position.x = x + len / 2;
  return me;
}
function nose(r: number, len: number, m: THREE.Material, x: number, blunt = 1.7): THREE.Mesh {
  const pts: THREE.Vector2[] = [];
  for (let i = 0; i <= 16; i++) {
    const y = (i / 16) * len;
    pts.push(new THREE.Vector2(Math.max(0.0005, r * Math.pow(1 - Math.pow(y / len, blunt), 0.75)), y));
  }
  const g = new THREE.LatheGeometry(pts, 28);
  g.rotateZ(-Math.PI / 2);
  const me = new THREE.Mesh(g, m);
  me.position.x = x;
  return me;
}
function fins(n: number, x: number, rad: number, chord: number, span: number, tip: number, sweep: number, m: THREE.Material, roll = Math.PI / 4): THREE.Group {
  const G = new THREE.Group();
  const depth = Math.max(0.008, span * 0.06);
  for (let i = 0; i < n; i++) {
    const s = new THREE.Shape();
    s.moveTo(-chord / 2, 0);
    s.lineTo(chord / 2, 0);
    s.lineTo(-chord / 2 + sweep + tip, span);
    s.lineTo(-chord / 2 + sweep, span);
    s.closePath();
    const g = new THREE.ExtrudeGeometry(s, { depth, bevelEnabled: false });
    g.translate(0, rad, -depth / 2);
    const p = new THREE.Group();
    p.add(new THREE.Mesh(g, m));
    p.rotation.x = roll + (i * Math.PI * 2) / n;
    p.position.x = x;
    G.add(p);
  }
  return G;
}
const band = (r: number, x: number, w: number, c: number) => cylX(r * 1.004, r * 1.004, w, mat(c, { roughness: 0.6 }), x);

function plume(r: number, len: number): THREE.Mesh {
  const g = new THREE.ConeGeometry(r, len, 16, 1, true);
  g.rotateZ(Math.PI / 2);
  g.translate(-len / 2, 0, 0);
  const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: 0xffb050, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
  m.visible = false;
  return m;
}
function orient(o: THREE.Object3D, dir: THREE.Vector3): void {
  if (dir.lengthSq() < 1e-8) return;
  o.quaternion.setFromUnitVectors(XA, dir.clone().normalize());
}
const qb = (a: THREE.Vector3, c: THREE.Vector3, b: THREE.Vector3, u: number) =>
  a.clone().multiplyScalar((1 - u) * (1 - u)).add(c.clone().multiplyScalar(2 * u * (1 - u))).add(b.clone().multiplyScalar(u * u));

interface Munition {
  obj: THREE.Group;
  len: number;
  plume: THREE.Mesh | null;
  wings: THREE.Group[] | null;
  spin: THREE.Group | null;
}

/** A schematic munition built along +X, centred on its own bounding box. */
function buildMunition(id: string): Munition {
  const g = new THREE.Group();
  let wings: THREE.Group[] | null = null;
  let spin: THREE.Group | null = null;
  let r = 0.1;
  if (id === 'aim120') {
    r = 0.089;
    g.add(cylX(r, r, 3.2, mat(0xe9ecef), -1.825), nose(r, 0.45, mat(0xd2d6d9), 1.375), band(r, 0.75, 0.06, 0xd9b23a), band(r, -0.4, 0.06, 0x7a5a2c));
    const f = mat(0xc9ced2);
    g.add(fins(4, 0.3, r, 0.36, 0.13, 0.12, 0.2, f), fins(4, -1.6, r, 0.32, 0.2, 0.14, 0.13, f));
  } else if (id === 'aim9x') {
    r = 0.0635;
    g.add(cylX(r, r, 2.75, mat(0xe6e9ec), -1.5));
    const d = new THREE.Mesh(new THREE.SphereGeometry(r, 24, 16, 0, Math.PI * 2, 0, Math.PI / 2), mat(0x1b2630, { metalness: 0.8, roughness: 0.1 }));
    d.rotation.z = -Math.PI / 2;
    d.position.x = 1.25;
    g.add(d, band(r, 0.8, 0.05, 0xd9b23a), band(r, -0.3, 0.05, 0x7a5a2c));
    const f = mat(0xc5cad0);
    g.add(fins(4, 0.55, r, 0.28, 0.045, 0.2, 0.06, f), fins(4, -1.35, r, 0.22, 0.14, 0.12, 0.09, f));
  } else if (id === 'gbu31') {
    r = 0.23;
    const o = mat(0x59603f, { metalness: 0.15 });
    const gr = mat(0x8a8f8c);
    g.add(cylX(0.2, r, 2.3, o, -1.3), nose(r, 0.9, o, 1.0, 2.2), band(r, 0.85, 0.08, 0xd9b23a), cylX(0.13, 0.2, 0.65, gr, -1.95));
    g.add(fins(4, -1.72, 0.14, 0.5, 0.32, 0.22, 0.24, gr), fins(4, -0.1, r, 1.1, 0.05, 0.95, 0.1, gr, 0));
  } else if (id === 'gbu53') {
    r = 0.09;
    const L = 1.45;
    g.add(cylX(r, r, L, mat(0xa9ae9e), -0.85));
    const d = new THREE.Mesh(new THREE.SphereGeometry(r, 24, 16, 0, Math.PI * 2, 0, Math.PI / 2), mat(0x22303a, { metalness: 0.9, roughness: 0.08 }));
    d.rotation.z = -Math.PI / 2;
    d.position.x = L - 0.85;
    d.scale.set(1.4, 1, 1);
    g.add(d, band(r, 0.25, 0.04, 0xd9b23a), fins(4, -0.78, r, 0.16, 0.12, 0.1, 0.06, mat(0x7d8388)));
    wings = [];
    const wm = mat(0x7d8388);
    for (const s of [1, -1]) {
      const p = new THREE.Group();
      const b = new THREE.Mesh(new THREE.BoxGeometry(0.78, 0.012, 0.07), wm);
      b.position.x = -0.39;
      p.add(b);
      p.position.set(0.15, r + 0.01, 0);
      p.userData.s = s;
      g.add(p);
      wings.push(p);
    }
  } else if (id === 'aargm') {
    r = 0.127;
    g.add(cylX(r, r, 3.4, mat(0xe6e8ea), -1.8), nose(r, 0.46, mat(0xcfd4d6), 1.6), band(r, 0.9, 0.06, 0xd9b23a), band(r, -0.6, 0.06, 0x7a5a2c));
    const f = mat(0xc5cad0);
    g.add(fins(4, 0.1, r, 1.3, 0.08, 1.1, 0.12, f), fins(4, -1.62, r, 0.4, 0.22, 0.18, 0.2, f));
  } else if (id === 'gun') {
    spin = new THREE.Group();
    const b = mat(0x3d4349, { metalness: 0.8, roughness: 0.3 });
    for (let i = 0; i < 4; i++) {
      const a = (i * Math.PI) / 2;
      const br = cylX(0.022, 0.022, 1.9, b, -0.6);
      br.position.y = Math.cos(a) * 0.06;
      br.position.z = Math.sin(a) * 0.06;
      spin.add(br);
    }
    spin.add(cylX(0.1, 0.1, 0.06, b, 1.1), cylX(0.1, 0.1, 0.06, b, 0.4));
    g.add(spin, cylX(0.14, 0.12, 0.55, mat(0x51585e), -1.15), cylX(0.07, 0.07, 0.3, mat(0x2b3035), -1.45));
  }
  const box = new THREE.Box3().setFromObject(g);
  const c = box.getCenter(new THREE.Vector3());
  for (const ch of g.children) ch.position.sub(c);
  const obj = new THREE.Group();
  obj.add(g);
  let pl: THREE.Mesh | null = null;
  if (id === 'aim120' || id === 'aim9x' || id === 'aargm') {
    pl = plume(r * 0.9, r * 14);
    pl.position.x = box.min.x - c.x;
    obj.add(pl);
  }
  return { obj, len: box.max.x - box.min.x, plume: pl, wings, spin };
}

/** A schematic fighter (≈16 m long) along +X. */
function buildJet(color: number, scale: number, mats?: THREE.MeshStandardMaterial[]): THREE.Group {
  const g = new THREE.Group();
  const m = mat(color, { metalness: 0.35, roughness: 0.55 });
  mats?.push(m);
  g.add(cylX(0.9, 0.95, 10, m, -6), nose(0.95, 4, m, 4, 1.6));
  const ws = new THREE.Shape();
  ws.moveTo(2, 0);
  ws.lineTo(-3.5, 5.4);
  ws.lineTo(-5.6, 5.4);
  ws.lineTo(-5.8, 0);
  ws.lineTo(-5.6, -5.4);
  ws.lineTo(-3.5, -5.4);
  ws.closePath();
  const wg = new THREE.ExtrudeGeometry(ws, { depth: 0.12, bevelEnabled: false });
  wg.rotateX(-Math.PI / 2);
  g.add(new THREE.Mesh(wg, m));
  const ts = new THREE.Shape();
  ts.moveTo(-4.4, 0);
  ts.lineTo(-6.6, 3.4);
  ts.lineTo(-7.8, 3.4);
  ts.lineTo(-7.6, 0);
  ts.closePath();
  const tg = new THREE.ExtrudeGeometry(ts, { depth: 0.1, bevelEnabled: false });
  tg.rotateX(-Math.PI / 2);
  for (const s of [1, -1]) {
    const me = new THREE.Mesh(tg, m);
    me.scale.z = s;
    g.add(me);
    const f = new THREE.Mesh(new THREE.BoxGeometry(2.2, 2.4, 0.1), m);
    f.position.set(-5.4, 1.3, s);
    f.rotation.x = s * 0.45;
    g.add(f);
  }
  const cp = new THREE.Mesh(new THREE.SphereGeometry(0.7, 16, 12), mat(0x1b2a34, { metalness: 0.9, roughness: 0.1 }));
  cp.scale.set(2.2, 0.8, 0.9);
  cp.position.set(2.4, 0.7, 0);
  g.add(cp);
  g.scale.setScalar(scale);
  return g;
}

interface TargetModel {
  g: THREE.Group;
  mats: THREE.MeshStandardMaterial[];
  spin: THREE.Object3D | null;
}

function buildTarget(t: Target): TargetModel {
  const g = new THREE.Group();
  const mats: THREE.MeshStandardMaterial[] = [];
  const m = (c: number) => {
    const x = mat(c, { metalness: 0.1, roughness: 0.85 });
    mats.push(x);
    return x;
  };
  const box = (w: number, hh: number, d: number, c: number, x = 0, y = 0, z = 0) => {
    const b = new THREE.Mesh(new THREE.BoxGeometry(w, hh, d), m(c));
    b.position.set(x, y + hh / 2, z);
    g.add(b);
    return b;
  };
  const R = Math.max(0.7, t.radius / S);
  let spin: THREE.Object3D | null = null;
  switch (t.type) {
    case 'fighter':
      g.add(buildJet(0x6b7480, 0.32, mats));
      break;
    case 'sa6': {
      const s = Math.min(2, Math.max(0.7, R / 2));
      for (let i = 0; i < 3; i++) {
        const ox = (i - 1) * s * 2.4;
        const oz = (i % 2 ? 1 : -1) * s * 0.9;
        box(1.4 * s, 0.5 * s, 0.7 * s, 0x4d5a3c, ox, 0, oz);
        for (let k = 0; k < 3; k++) {
          const tb = new THREE.Mesh(new THREE.CylinderGeometry(0.09 * s, 0.09 * s, 1.3 * s, 10), m(0x5d6a4a));
          tb.rotation.z = 0.9;
          tb.position.set(ox, 1.1 * s, oz + (k - 1) * 0.2 * s);
          g.add(tb);
        }
      }
      const rd = new THREE.Group();
      const dish = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.9 * s, 1.2 * s), m(0x8b9493));
      dish.position.y = 0.5 * s;
      rd.add(dish);
      rd.position.set(0, 0.6 * s, -s * 2.6);
      g.add(rd);
      box(0.6 * s, 0.6 * s, 0.6 * s, 0x4d5a3c, 0, 0, -s * 2.6);
      spin = rd;
      break;
    }
    case 'fuel':
      for (let i = 0; i < 3; i++) {
        const c = new THREE.Mesh(new THREE.CylinderGeometry(R * 0.3, R * 0.3, 0.9, 20), m(0xb9b6a8));
        c.position.set((i - 1) * R * 0.7, 0.45, (i % 2) * R * 0.3);
        g.add(c);
      }
      break;
    case 'hangar': {
      // a hardened aircraft shelter: a low concrete vault with a dark door
      const v = new THREE.Mesh(new THREE.CylinderGeometry(R * 0.6, R * 0.6, R * 1.6, 24, 1, false, -Math.PI / 2, Math.PI), m(0x7d7a70));
      v.rotation.x = -Math.PI / 2; // the half shell above the ground, its length along z
      v.scale.set(1, 1, 0.7);
      g.add(v);
      box(R * 0.8, R * 0.35, 0.1, 0x2b2a26, 0, 0, R * 0.8);
      break;
    }
    default:
      box(Math.max(1.4, R * 1.6), 0.35, Math.max(0.4, R * 0.35), 0x5e666c);
      box(0.5, 0.35, 0.3, 0x737c82, -0.2, 0.35);
      break;
  }
  for (const x of mats) x.userData.c = x.color.getHex();
  return { g, mats, spin };
}

/** 0 intact, 1 damaged, 2 destroyed. */
function setDamage(tg: TargetModel, state: 0 | 1 | 2): void {
  for (const m of tg.mats) {
    const c = new THREE.Color(m.userData.c as number);
    if (state === 2) c.setHex(0x1b1b1b);
    else if (state === 1) c.lerp(new THREE.Color(0xff6a2a), 0.45);
    m.color.copy(c);
  }
}

function baseScene(ground: 'none' | 'land' | 'water'): THREE.Scene {
  const s = new THREE.Scene();
  s.background = new THREE.Color(0x061019);
  s.fog = new THREE.Fog(0x061019, 90, 190);
  s.add(new THREE.HemisphereLight(0xcfeeff, 0x0a1a22, 0.95));
  const d = new THREE.DirectionalLight(0xffffff, 0.9);
  d.position.set(20, 40, 25);
  s.add(d);
  if (ground !== 'none') {
    const gr = new THREE.Mesh(new THREE.PlaneGeometry(260, 260), new THREE.MeshStandardMaterial({ color: ground === 'water' ? 0x0a2533 : 0x0e1b1c, roughness: 1 }));
    gr.rotation.x = -Math.PI / 2;
    s.add(gr);
    const grid = new THREE.GridHelper(260, 52, 0x2a7d90, 0x1a5366);
    grid.position.y = 0.02;
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.85;
    s.add(grid);
  }
  return s;
}

class Trail {
  private n = 0;
  private readonly arr = new Float32Array(400 * 3);
  private readonly geo = new THREE.BufferGeometry();
  constructor(s: THREE.Scene) {
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.arr, 3));
    this.geo.setDrawRange(0, 0);
    s.add(new THREE.Line(this.geo, new THREE.LineBasicMaterial({ color: 0xdfe8ee, transparent: true, opacity: 0.65 })));
  }
  push(p: THREE.Vector3): void {
    if (this.n >= 400) return;
    this.arr.set([p.x, p.y, p.z], this.n * 3);
    this.n++;
    this.geo.setDrawRange(0, this.n);
    this.geo.attributes.position.needsUpdate = true;
  }
  reset(): void {
    this.n = 0;
    this.geo.setDrawRange(0, 0);
  }
}

class Blast {
  private readonly ball: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
  private readonly ring: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  constructor(s: THREE.Scene, private readonly radius: number, private readonly ground: boolean) {
    this.ball = new THREE.Mesh(new THREE.SphereGeometry(1, 28, 18), new THREE.MeshBasicMaterial({ color: 0xffa040, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.ball.visible = false;
    this.ring = new THREE.Mesh(new THREE.RingGeometry(Math.max(0.1, radius - 0.18), radius, 72), new THREE.MeshBasicMaterial({ color: 0x5fe3ff, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false }));
    this.ring.rotation.x = -Math.PI / 2;
    s.add(this.ball, this.ring);
  }
  set(p: THREE.Vector3, age: number): void {
    if (age < 0) {
      this.ball.visible = false;
      this.ring.material.opacity = 0;
      return;
    }
    this.ball.visible = true;
    this.ball.position.copy(p);
    this.ball.scale.setScalar(Math.max(0.05, this.radius * Math.min(1, age / 0.25)));
    this.ball.material.opacity = age < 0.25 ? 0.85 : Math.max(0, 0.85 - (age - 0.25) * 1.1);
    if (this.ground) {
      this.ring.position.set(p.x, 0.06, p.z);
      this.ring.material.opacity = Math.min(0.9, age * 3);
    }
  }
}

/** Straight run to the launch, then a banked break-away turn away from the viewer. */
function jetPath(jet: THREE.Object3D, tt: number, p0: THREE.Vector3, v: number, tb: number): void {
  if (tt < tb) {
    jet.position.copy(p0).add(v3(v * tt, 0, 0));
    orient(jet, XA);
    return;
  }
  const dt = tt - tb;
  const w = 1.1;
  const maxA = 2.7;
  const R = v / w;
  const a = Math.min(maxA, w * dt);
  const p = p0.clone().add(v3(v * tb + R * Math.sin(a), dt * 0.3, -R * (1 - Math.cos(a))));
  const d = v3(Math.cos(a), 0, -Math.sin(a));
  if (w * dt > maxA) p.add(d.clone().multiplyScalar(v * (dt - maxA / w)));
  jet.position.copy(p);
  orient(jet, d);
  jet.rotateX(w * dt < maxA ? Math.min(1, dt * 3) * Math.min(1, (maxA - w * dt) * 2) : 0);
}

/** Blast damage at distance distM from a target's centre (sim/weapons/flight.ts applyBlast). */
function blastDamage(damage: number, blastRadius: number, t: Target, distM: number): number {
  const d = Math.max(0, distM - (t.air ? 0.5 : 0.6) * t.radius);
  if (d >= blastRadius) return 0;
  const v = damage * (1 - d / blastRadius);
  return v <= 0.5 ? 0 : v;
}

const AFTER_LAUNCH: Partial<Record<string, string>> = {
  aim9x: 'Fire and forget: your jet turned away right after launch.',
  gbu31: 'Fire and forget: GPS guides it, so your jet turned away after release.',
  aargm: 'Fire and forget: it homes on the radar by itself.',
  aim120: 'Your jet turned away but kept sending course updates (blue line) until the missile\'s own radar took over. The F-35\'s sensors see all around, so you don\'t have to point at the target.',
  gbu53: 'Your jet turned away but kept sending course updates (blue line) until the bomb\'s own seeker took over for the last 3 km.',
};

function resultHtml(short: string, t: Target, dmg: number, extra: string): string {
  const left = Math.max(0, t.hp - dmg);
  const pct = (left / t.hp) * 100;
  const verdict =
    dmg <= 0
      ? '<span class="bad">No damage.</span>'
      : left <= 0
        ? '<span class="ok">Destroyed in one hit.</span>'
        : `<span class="warn">${Math.round(left)} of ${t.hp} HP left: needs ${Math.ceil(t.hp / Math.max(1, dmg))} hits like this.</span>`;
  const colour = left <= 0 ? 'var(--red)' : pct < 60 ? 'var(--amber)' : 'var(--green)';
  return `<div><b>${short} → ${t.name}</b> · ${Math.round(dmg)} damage</div><div class="cx-hp"><i style="width:${pct.toFixed(0)}%;background:${colour}"></i></div><div>${verdict}${extra ? ' ' + extra : ''}</div>`;
}

type Update = (t: number) => void;

export interface ViewerOptions {
  reducedMotion: boolean;
}

export class CodexViewer {
  private renderer: THREE.WebGLRenderer | null = null;
  private scene: THREE.Scene | null = null;
  private camera: THREE.PerspectiveCamera | null = null;
  private update: Update | null = null;
  private reset: (() => void) | null = null;
  private t = 0;
  private dur = 1e9;
  private raf = 0;
  private last = 0;
  private inspect = false;
  private rot = { x: 0.25, y: -0.6 };
  private drag: { x: number; y: number; mouse: boolean } | null = null;
  readonly ok: boolean;
  /** Receives the result line under the view (HTML), or null while the weapon is in flight. */
  onResult: (html: string | null) => void = () => undefined;

  constructor(readonly canvas: HTMLCanvasElement, private readonly opts: ViewerOptions) {
    try {
      this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
      this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    } catch {
      this.renderer = null;
    }
    this.ok = !!this.renderer;
    canvas.addEventListener('pointerdown', this.onDown);
    canvas.addEventListener('pointermove', this.onMove);
    for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) canvas.addEventListener(ev, this.onUp);
  }

  /** Show a weapon: Inspect (the model alone) or In action against one example of a target class. */
  show(w: WeaponEntry, mode: 'inspect' | 'action', cls: TargetClass | null): void {
    if (!this.renderer) return;
    this.clearScene();
    this.t = 0;
    this.reset = null;
    if (mode === 'inspect' || (w.scene !== 'cms' && !cls)) this.buildInspect(w);
    else this.buildAction(w, cls);
    this.start();
  }

  replay(): void {
    this.t = 0;
    this.reset?.();
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.clearScene();
    this.renderer?.dispose();
    this.renderer?.forceContextLoss();
    this.renderer = null;
  }

  private clearScene(): void {
    this.scene?.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose();
      const mm = m.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mm)) mm.forEach((x) => x.dispose());
      else mm?.dispose();
    });
    this.scene = null;
  }

  private start(): void {
    if (this.raf) return;
    this.last = performance.now();
    const loop = (now: number) => {
      this.raf = 0;
      if (!this.renderer || !this.canvas.isConnected) return;
      const dt = Math.min(0.05, (now - this.last) / 1000);
      this.last = now;
      const r = this.canvas.getBoundingClientRect();
      if (r.width > 0 && r.bottom > 0 && r.top < innerHeight && this.scene && this.camera) {
        const sz = this.renderer.getSize(new THREE.Vector2());
        const w = Math.round(r.width);
        const h = Math.round(r.height);
        if (w && h && (sz.x !== w || sz.y !== h)) {
          this.renderer.setSize(w, h, false);
          this.camera.aspect = w / h;
          this.camera.updateProjectionMatrix();
        }
        this.t += dt;
        if (this.t > this.dur) {
          this.t = 0;
          this.reset?.();
        }
        this.update?.(this.t);
        this.renderer.render(this.scene, this.camera);
      }
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  private onDown = (e: PointerEvent): void => {
    if (!this.inspect) return;
    this.drag = { x: e.clientX, y: e.clientY, mouse: e.pointerType === 'mouse' };
    if (this.drag.mouse) this.canvas.setPointerCapture(e.pointerId);
  };
  private onMove = (e: PointerEvent): void => {
    const d = this.drag;
    if (!d) return;
    this.rot.y += (e.clientX - d.x) * 0.01;
    if (d.mouse) this.rot.x = Math.max(-1.2, Math.min(1.2, this.rot.x + (e.clientY - d.y) * 0.01));
    d.x = e.clientX;
    d.y = e.clientY;
  };
  private onUp = (): void => {
    this.drag = null;
  };

  private buildInspect(w: WeaponEntry): void {
    const s = baseScene('none');
    this.inspect = true;
    this.onResult(null);
    const disc = new THREE.Mesh(new THREE.RingGeometry(3.6, 3.7, 96), new THREE.MeshBasicMaterial({ color: 0x5fe3ff, transparent: true, opacity: 0.25, side: THREE.DoubleSide }));
    disc.rotation.x = -Math.PI / 2;
    disc.position.y = -1.6;
    s.add(disc);
    const model = new THREE.Group();
    let anim: Update | null = null;
    let mun: Munition | null = null;
    if (w.id === 'cms') {
      model.add(buildJet(0x7f8a96, 0.42));
      const flares: THREE.Mesh[] = [];
      for (let i = 0; i < 4; i++) {
        const f = new THREE.Mesh(new THREE.SphereGeometry(0.12, 10, 8), new THREE.MeshBasicMaterial({ color: 0xffc070 }));
        f.visible = false;
        model.add(f);
        flares.push(f);
      }
      anim = (t) => {
        const cyc = t % 2.4;
        flares.forEach((f, i) => {
          const a = cyc - (i % 2) * 0.15;
          f.visible = a >= 0 && a <= 1.6;
          f.position.set(-1.2 - a * 1.6, -0.3 - a * a * 1.6, (i % 2 ? 1 : -1) * (0.3 + a * 0.6));
        });
      };
    } else {
      mun = buildMunition(w.id);
      mun.obj.scale.setScalar((w.id === 'gun' ? 5.5 : 7) / mun.len);
      model.add(mun.obj);
    }
    s.add(model);
    const cam = new THREE.PerspectiveCamera(32, 21 / 9, 0.1, 200);
    cam.position.set(0, 1.4, 11.5);
    cam.lookAt(0, 0, 0);
    this.scene = s;
    this.camera = cam;
    this.dur = 1e9;
    const rm = this.opts.reducedMotion;
    this.update = (t) => {
      if (!this.drag && !rm) this.rot.y += 0.004;
      model.rotation.set(this.rot.x, this.rot.y, 0, 'YXZ');
      if (mun?.wings) {
        const a = Math.sin(t * 1.2) * 0.5 + 0.5;
        for (const p of mun.wings) p.rotation.y = (p.userData.s as number) * a * 1.15;
      }
      if (mun?.spin && !rm) mun.spin.rotation.x += 0.25;
      anim?.(t);
    };
  }

  private buildAction(w: WeaponEntry, cls: TargetClass | null): void {
    this.inspect = false;
    const t = cls ? targetOf(cls) : null;
    const s = baseScene(t?.water ? 'water' : 'land');
    const cam = new THREE.PerspectiveCamera(38, 21 / 9, 0.1, 400);
    this.scene = s;
    this.camera = cam;
    let focus = v3(15, 7, 0);
    let lead = 1.2;
    const tg = t ? buildTarget(t) : null;
    if (tg) s.add(tg.g);
    const jet = buildJet(0x7f8a96, 0.34);
    s.add(jet);
    const mun = w.scene === 'gun' || w.scene === 'cms' ? null : buildMunition(w.id);
    if (mun) {
      mun.obj.scale.setScalar(w.scene === 'bomb' ? (w.glide ? 1.5 : 0.9) : 0.85);
      s.add(mun.obj);
    }
    const trail = new Trail(s);
    const TP = v3(10, 0, 0);
    let upd: Update = () => undefined;
    let dur = 4;
    let linkUntil = -1;
    const link = w.datalink ? new THREE.Mesh(new THREE.BoxGeometry(1, 0.18, 0.18), new THREE.MeshBasicMaterial({ color: 0x7ff0ff, transparent: true, opacity: 0.85 })) : null;
    if (link) {
      link.visible = false;
      s.add(link);
    }
    const out = (html: string | null) => this.onResult(html);
    const def = w.id !== 'gun' && w.id !== 'cms' ? MUNITIONS[w.id] : null;

    if (w.scene === 'aam' && t && tg && mun && def) {
      const T = 3.2;
      dur = T + 2.4;
      const A = v3(-16, 17, 8);
      const tpos = (tt: number) => (t.air ? v3(18 - 3 * tt, 18 + 0.2 * tt, -12 + 2.6 * tt) : TP.clone());
      const E = tpos(T);
      if (!t.air) E.y = 0.4;
      const C = A.clone().lerp(E, 0.5);
      C.y += w.id === 'aim120' ? 12 : 3;
      const dmg = t.air ? def.damage : 0;
      const bl = new Blast(s, def.blastRadius / S, !t.air);
      focus = E.clone();
      linkUntil = w.datalink ? T * 0.6 : -1;
      upd = (tt) => {
        jetPath(jet, tt, A, 9, 0.3);
        const p = tpos(Math.min(tt, T));
        tg.g.position.copy(p);
        if (t.air) {
          orient(tg.g, v3(-3, 0.2, 2.6));
          if (tt > T) {
            const a = tt - T;
            tg.g.position.y = p.y - 3 * a * a;
            tg.g.rotation.z += 0.03;
          }
        }
        if (tt >= 0 && tt < T) {
          const u = Math.pow(tt / T, 1.35);
          const q = qb(A, C, E, u);
          mun.obj.visible = true;
          mun.obj.position.copy(q);
          orient(mun.obj, qb(A, C, E, Math.min(1, u + 0.01)).sub(q));
          trail.push(q);
          if (mun.plume) {
            mun.plume.visible = tt < (w.burn ?? 5);
            mun.plume.scale.x = 0.8 + Math.random() * 0.4;
          }
        } else mun.obj.visible = false;
        bl.set(E, tt - T);
        setDamage(tg, tt >= T && dmg > 0 ? 2 : 0);
        out(tt >= T ? resultHtml(w.short, t, dmg, t.air ? AFTER_LAUNCH[w.id] ?? '' : 'Air-to-air warheads only damage aircraft.') : null);
      };
    } else if (w.scene === 'bomb' && t && tg && mun && def) {
      const glide = !!w.glide;
      const T = glide ? 4.4 : 3.1;
      const rel = 0.4;
      dur = T + 2.6;
      const Y = 16;
      const jx = (tt: number) => (glide ? -14 : -12) + 9 * tt;
      // a moving target drives 50 m while the bomb falls
      const tpos = (tt: number) => {
        const p = TP.clone();
        if (t.moving) p.z = -2.5 + 5 * Math.min(1, Math.max(0, tt / T));
        return p;
      };
      const R0 = v3(jx(rel), Y, 0);
      const aim = tpos(w.seeker ? T : rel);
      aim.y = 0;
      focus = aim.clone().add(v3(5, 7, 0));
      const distM = tpos(T).distanceTo(aim) * S;
      const dmg = blastDamage(def.damage, def.blastRadius, t, distM);
      const bl = new Blast(s, def.blastRadius / S, true);
      linkUntil = w.datalink ? rel + (T - rel) * 0.8 : -1;
      upd = (tt) => {
        jetPath(jet, tt, v3(jx(0), Y, 0), 9, rel + 0.3);
        tg.g.position.copy(tpos(Math.min(tt, T)));
        if (t.moving) orient(tg.g, v3(0.0001, 0, 1));
        if (tg.spin) tg.spin.rotation.y += 0.05;
        if (tt >= rel && tt < T) {
          const u = (tt - rel) / (T - rel);
          const end = w.seeker ? tpos(tt) : aim;
          const y = glide ? R0.y * Math.pow(1 - u, 1.15) : R0.y * (1 - u * u);
          const p = v3(R0.x + (end.x - R0.x) * u, Math.max(0, y), R0.z + (end.z - R0.z) * (w.seeker ? u * u : u));
          const prev = mun.obj.position.clone();
          mun.obj.visible = true;
          mun.obj.position.copy(p);
          orient(mun.obj, u > 0.01 ? p.clone().sub(prev) : XA);
          trail.push(p);
          if (mun.wings) {
            const a = Math.min(1, (tt - rel) / 0.5);
            for (const wg of mun.wings) wg.rotation.y = (wg.userData.s as number) * a * 1.15;
          }
        } else mun.obj.visible = false;
        bl.set(aim.clone().setY(0.2), tt - T);
        setDamage(tg, tt >= T ? (dmg >= t.hp ? 2 : dmg > 0 ? 1 : 0) : 0);
        if (tt >= T) {
          let extra = '';
          if (t.moving && w.gps) extra = `The target moved ${Math.round(distM)} m while the bomb fell, and GPS bombs hit the point they were aimed at. `;
          if (t.moving && w.seeker) extra = 'Its seeker followed the target as it moved. ';
          out(resultHtml(w.short, t, dmg, extra + (AFTER_LAUNCH[w.id] ?? '')));
        } else out(null);
      };
    } else if (w.scene === 'agm' && t && tg && mun && def) {
      if (!t.emitter) {
        upd = (tt) => {
          jet.position.set(-8 + 6 * tt, 13, 0);
          orient(jet, XA);
          tg.g.position.copy(TP);
          mun.obj.visible = false;
          out(`<div><b>${w.short} → ${t.name}</b></div><div class="bad">Can't target: it has no radar.</div>`);
        };
      } else {
        const T = 4.4;
        dur = T + 2.6;
        const A = v3(-8, 13, 0);
        const E = TP.clone().setY(0.6);
        const C = v3(2, 26, 0);
        const bl = new Blast(s, def.blastRadius / S, true);
        upd = (tt) => {
          jetPath(jet, tt, A, 6, 0.3);
          tg.g.position.copy(TP);
          if (tg.spin) tg.spin.rotation.y += 0.06;
          if (tt >= 0 && tt < T) {
            const u = Math.pow(tt / T, 1.2);
            const q = qb(A, C, E, u);
            mun.obj.visible = true;
            mun.obj.position.copy(q);
            orient(mun.obj, qb(A, C, E, Math.min(1, u + 0.01)).sub(q));
            trail.push(q);
            if (mun.plume) {
              mun.plume.visible = true;
              mun.plume.scale.x = 0.8 + Math.random() * 0.4;
            }
          } else mun.obj.visible = false;
          bl.set(E, tt - T);
          setDamage(tg, tt >= T ? (def.damage >= t.hp ? 2 : 1) : 0);
          out(tt >= T ? resultHtml(w.short, t, def.damage, `${AFTER_LAUNCH.aargm} This assumes the crew kept the radar on. If they switch it off, the missile gets one chance to find the site.`) : null);
        };
      }
    } else if (w.scene === 'gun' && t && tg) {
      const pool: THREE.Mesh[] = [];
      for (let i = 0; i < 10; i++) {
        const b = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.08, 0.08), new THREE.MeshBasicMaterial({ color: 0xffe08a }));
        b.visible = false;
        s.add(b);
        pool.push(b);
      }
      const spark = new THREE.Mesh(new THREE.SphereGeometry(0.35, 10, 8), new THREE.MeshBasicMaterial({ color: 0xffc060, transparent: true, blending: THREE.AdditiveBlending }));
      s.add(spark);
      const b0 = 0.6;
      const b1 = 2.2;
      const step = 0.073;
      const fly = 0.32;
      dur = 4.2;
      const sp = (tt: number) => (t.air ? v3(-14 + 7 * tt, 15, 0) : v3(-14 + 5 * tt, 16 - 2.4 * tt, 0));
      const tp = (tt: number) => (t.air ? v3(4 + 7 * tt, 15.6, 0) : TP.clone());
      const hits = t.air ? '5–7 hits' : `${Math.ceil(t.hp / GUN_HIT_DAMAGE)} hits`;
      const kill = t.air || Math.ceil(t.hp / GUN_HIT_DAMAGE) <= 7;
      focus = t.air ? tp(1.9) : TP.clone().add(v3(5, 7, 0));
      upd = (tt) => {
        const p = sp(tt);
        jet.position.copy(p);
        orient(jet, tp(tt).sub(p));
        tg.g.position.copy(tp(tt));
        if (t.air) orient(tg.g, XA);
        for (const b of pool) b.visible = false;
        let k = 0;
        let hit = false;
        const j0 = Math.max(0, Math.floor((tt - fly - b0) / step));
        const j1 = Math.floor((tt - b0) / step);
        for (let j = j0; j <= j1 && k < pool.length; j++) {
          const ts = b0 + j * step;
          if (ts > b1 || ts < b0) continue;
          const a = (tt - ts) / fly;
          if (a < 0 || a > 1) continue;
          const from = sp(ts);
          const to = tp(ts + fly).add(v3(Math.sin(j * 7.3) * 0.6, Math.sin(j * 3.1) * 0.4, Math.cos(j * 5.7) * 0.6));
          const b = pool[k++];
          b.visible = true;
          b.position.copy(from.clone().lerp(to, a));
          orient(b, to.clone().sub(from));
          if (a > 0.85) hit = true;
        }
        spark.visible = hit;
        spark.position.copy(tp(tt)).add(v3(0, t.air ? 0 : 0.5, 0));
        spark.scale.setScalar(0.6 + Math.random());
        const done = tt > b1 + fly;
        setDamage(tg, done ? (kill ? 2 : 1) : 0);
        if (t.air && done && kill) {
          const a = tt - b1 - fly;
          tg.g.position.y -= 2.5 * a * a;
        }
        out(done ? `<div><b>${w.short} → ${t.name}</b> · about ${GUN_HIT_DAMAGE} per hit</div><div>${kill ? `<span class="ok">Destroyed after about ${hits}.</span>` : `<span class="warn">Needs about ${hits}.</span> A bomb does it in one.`}</div>` : null);
      };
    } else if (w.scene === 'cms') {
      const flares: THREE.Mesh[] = [];
      for (let i = 0; i < 4; i++) {
        const f = new THREE.Mesh(new THREE.SphereGeometry(0.45, 10, 8), new THREE.MeshBasicMaterial({ color: 0xffc070, transparent: true, blending: THREE.AdditiveBlending }));
        s.add(f);
        flares.push(f);
      }
      const n = 300;
      const chaffPos = new Float32Array(n * 3);
      const seeds = new Float32Array(n * 3).map(() => Math.random() - 0.5);
      const chaffGeo = new THREE.BufferGeometry();
      chaffGeo.setAttribute('position', new THREE.BufferAttribute(chaffPos, 3));
      const chaff = new THREE.Points(chaffGeo, new THREE.PointsMaterial({ color: 0xc8d4dc, size: 0.18 }));
      s.add(chaff);
      const missile = buildMunition('aim9x');
      missile.obj.scale.setScalar(0.65);
      if (missile.plume) missile.plume.visible = true;
      s.add(missile.obj);
      const bl = new Blast(s, 1.6, false);
      dur = 5.6;
      const jp = (tt: number) => v3(-26 + 11 * tt, 17 + Math.sin(tt * 1.2) * 1.5, -tt * 1.2);
      const rel = [1.2, 1.35, 1.8, 1.95];
      const fp = (i: number, tt: number) => {
        const a = tt - rel[i];
        const o = jp(rel[i]);
        return v3(o.x + a * 4, o.y - 1.8 * a * a - a * 1.5, o.z + (i % 2 ? 1 : -1) * a * 1.2);
      };
      const seduce = 2.0;
      const T = 3.0;
      focus = fp(0, T);
      lead = 0;
      const M0 = v3(-44, 6, 14);
      upd = (tt) => {
        jet.position.copy(jp(tt));
        orient(jet, v3(11, 1.8 * Math.cos(tt * 1.2), -1.2));
        flares.forEach((f, i) => {
          const a = tt - rel[i];
          f.visible = a > 0 && a < 3.5;
          if (f.visible) {
            f.position.copy(fp(i, tt));
            f.scale.setScalar(1 + 0.3 * Math.sin(tt * 50 + i));
          }
        });
        const ca = tt - 1.2;
        chaff.visible = ca > 0 && ca < 5;
        if (chaff.visible) {
          const o = jp(1.2);
          for (let i = 0; i < n; i++) {
            chaffPos[i * 3] = o.x + ca * 2 + seeds[i * 3] * (1 + ca * 3);
            chaffPos[i * 3 + 1] = o.y - ca * 0.6 + seeds[i * 3 + 1] * (1 + ca * 2.4);
            chaffPos[i * 3 + 2] = o.z + seeds[i * 3 + 2] * (1 + ca * 3);
          }
          chaffGeo.attributes.position.needsUpdate = true;
        }
        let p: THREE.Vector3 | null = null;
        if (tt < seduce) p = M0.clone().lerp(jp(tt + 0.9), Math.pow(tt / seduce, 1.3) * 0.75);
        else if (tt < T) p = M0.clone().lerp(jp(seduce + 0.9), 0.75).lerp(fp(0, T), (tt - seduce) / (T - seduce));
        if (p) {
          const prev = missile.obj.position.clone();
          missile.obj.visible = true;
          missile.obj.position.copy(p);
          orient(missile.obj, p.clone().sub(prev));
          trail.push(p);
          if (missile.plume) missile.plume.scale.x = 0.8 + Math.random() * 0.4;
        } else missile.obj.visible = false;
        bl.set(fp(0, T), tt - T);
        out(tt > T ? '<div><b>Heat-seeker vs flares</b></div><div class="ok">The missile chased the flare and missed.</div><div>One press drops 2 flares and 2 chaff. The chance depends on timing, angle and the missile\'s seeker.</div>' : null);
      };
    }

    const inner = upd;
    this.update = lead
      ? (tt) => {
          const t2 = tt - lead;
          inner(t2);
          if (link && mun) {
            link.visible = mun.obj.visible && t2 >= 0 && t2 < linkUntil;
            if (link.visible) {
              const d = mun.obj.position.clone().sub(jet.position);
              link.position.copy(jet.position).addScaledVector(d, 0.5);
              link.scale.set(Math.max(0.01, d.length()), 1, 1);
              orient(link, d);
            }
          }
        }
      : inner;
    this.dur = dur + lead;
    cam.position.copy(focus).add(v3(-6, 13, 42));
    cam.lookAt(focus);
    this.reset = () => {
      trail.reset();
      out(null);
    };
    out(null);
  }
}
