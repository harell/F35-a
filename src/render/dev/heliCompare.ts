/**
 * DEV ONLY — helicopter rework comparison (labs/heli-compare.html, and the review artifact built from it): today's
 * civil helicopter models (helicopters.ts) beside the prototype shared airframe (heliAirframe.ts) in each proposed
 * livery, one split-screen WebGL view, plus the proposed routes drawn over the game's Auckland map.
 */
import {
  ACESFilmicToneMapping,
  CircleGeometry,
  Color,
  DirectionalLight,
  Group,
  HemisphereLight,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  PerspectiveCamera,
  PMREMGenerator,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
  type Object3D,
} from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { buildAW169, buildBell429, buildH130 } from '../models/aircraft/helicopters';
import { buildHeliV2, type HeliLivery, type HeliOptions } from '../models/aircraft/heliAirframe';
import { setEnvironment } from '../models/materials';
import { AKL_ISLANDS, AKL_WATER } from '../../world/terrain/theaters/aucklandMap';
import { geoToWorld } from '../../core/auckland';
import { helipad } from '../../core/sites';

/* ───────────────────────── the proposal ───────────────────────── */

export const LIVERIES: Record<string, HeliLivery> = {
  westpac: {
    id: 'westpac',
    top: 0xd3222a,
    belly: 0xf5c400,
    stripe: 0xf4f4f0,
    stripeY: [-0.3, -0.18],
    boom: 0xf5c400,
    fin: 0xd3222a,
    check: null,
    blade: 0x2b2d30,
    tip: 0xf5c400,
    name: 'WESTPAC RESCUE',
    boomText: 'NORTHERN RESCUE',
    reg: 'ZK-HLH',
    text: 0xf4f4f0,
    boomTextColor: 0xc4161e,
  },
  northland: {
    id: 'northland',
    top: 0xf3f3f0,
    belly: 0xf3f3f0,
    stripe: 0xc8102e,
    stripeY: [-0.34, -0.14],
    boom: 0xf3f3f0,
    fin: 0xf3f3f0,
    check: null,
    blade: 0x2b2d30,
    tip: 0xf5c400,
    name: 'NORTHLAND RESCUE',
    boomText: 'NORTHERN RESCUE',
    reg: 'ZK-HQO',
    text: 0x1b2a4a,
  },
  eagle: {
    id: 'eagle',
    top: 0x15203a,
    belly: 0x15203a,
    stripe: 0,
    stripeY: [-0.45, -0.1],
    boom: 0x15203a,
    fin: 0x15203a,
    check: [0xf2c500, 0x1d4ea6],
    blade: 0x2b2d30,
    tip: 0xd8d8d4,
    name: 'POLICE',
    boomText: 'EAGLE',
    reg: 'ZK-IPB',
    text: 0xf4f4f0,
  },
};

const OPTIONS: Record<string, HeliOptions> = {
  westpac: { blades: 5, gear: 'wheels', hoist: true, flir: false, searchlight: true },
  northland: { blades: 4, gear: 'wheels', hoist: true, flir: false, searchlight: true },
  eagle: { blades: 4, gear: 'skids', hoist: false, flir: true, searchlight: true },
};

/** Today's model for each proposed helicopter (null: nothing like it in the game today). */
const TODAY: Record<string, (() => Object3D) | null> = {
  westpac: () => buildAW169().lod0,
  northland: null,
  eagle: () => buildBell429().lod0,
  tour: () => buildH130().lod0,
};

/* ───────────────────────── the split view ───────────────────────── */

interface Side {
  scene: Scene;
  holder: Group;
  spinners: { obj: Object3D; rate: number }[];
  triangles: number;
}

function makeScene(): Scene {
  const s = new Scene();
  s.add(new HemisphereLight(0xe8f0ff, 0x6d6656, 1.1));
  const sun = new DirectionalLight(0xffffff, 2.4);
  sun.position.set(30, 60, -20);
  s.add(sun);
  const fill = new DirectionalLight(0xbcd0ff, 0.6);
  fill.position.set(-30, 20, 40);
  s.add(fill);
  const pad = new Mesh(new CircleGeometry(9, 48), new MeshLambertMaterial({ color: 0x8f8d86 }));
  pad.rotation.x = -Math.PI / 2;
  s.add(pad);
  const ring = new Mesh(new CircleGeometry(6.4, 48), new MeshLambertMaterial({ color: 0xe8c43a }));
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.005;
  s.add(ring);
  const inner = new Mesh(new CircleGeometry(5.9, 48), new MeshLambertMaterial({ color: 0x8f8d86 }));
  inner.rotation.x = -Math.PI / 2;
  inner.position.y = 0.01;
  s.add(inner);
  return s;
}

function countTris(o: Object3D): number {
  let n = 0;
  o.traverse((c) => {
    const m = c as Mesh;
    if (m.isMesh && m.geometry && !(m.material as MeshBasicMaterial).map) {
      const g = m.geometry;
      n += g.index ? g.index.count / 3 : g.attributes.position.count / 3;
    }
  });
  return Math.round(n);
}

function sideFor(build: () => { obj: Object3D; rotor?: Object3D | null; tail?: Object3D | null; gear: number }): Side {
  const scene = makeScene();
  const holder = new Group();
  const b = build();
  b.obj.position.y = b.gear;
  holder.add(b.obj);
  scene.add(holder);
  const spinners: Side['spinners'] = [];
  if (b.rotor) spinners.push({ obj: b.rotor, rate: 2 * Math.PI * 4.3 });
  if (b.tail) spinners.push({ obj: b.tail, rate: 2 * Math.PI * 11 });
  return { scene, holder, spinners, triangles: countTris(b.obj) };
}

function todaySide(id: string): Side | null {
  const f = TODAY[id];
  if (!f) return null;
  return sideFor(() => {
    const obj = f();
    const rotor = obj.getObjectByName('pivot:rotor')?.getObjectByName('part:rotor') ?? null;
    const tail = obj.getObjectByName('pivot:tailrotor')?.getObjectByName('part:tailrotor') ?? null;
    return { obj, rotor, tail, gear: id === 'westpac' ? 1.45 : 1.3 };
  });
}

function newSide(id: string): Side | null {
  if (!LIVERIES[id]) return null;
  return sideFor(() => {
    const gear = OPTIONS[id].gear === 'skids' ? 1.3 : 1.45;
    const b = buildHeliV2(LIVERIES[id], OPTIONS[id], gear);
    const rotor = b.rotor?.getObjectByName('part:rotor') ?? null;
    const tail = b.tailrotor?.getObjectByName('part:tailrotor') ?? null;
    return { obj: b.group, rotor, tail, gear };
  });
}

export function mountViewer(canvas: HTMLCanvasElement, onStats: (today: number | null, next: number | null) => void): {
  show(id: string): void;
  setSpin(on: boolean): void;
  setDistance(d: number): void;
} {
  const renderer = new WebGLRenderer({ canvas, antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(2, devicePixelRatio));
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.setScissorTest(true);
  const env = new PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
  setEnvironment(env, 0.6);
  const sky = new Color(0x9db9d6);

  const cam = new PerspectiveCamera(32, 1, 0.1, 2000);
  let yaw = -2.35;
  let pitch = 0.2;
  let dist = 27;
  let spin = true;
  const target = new Vector3(0, 1.4, 1.4);
  const cache = new Map<string, { today: Side | null; next: Side | null }>();
  let cur: { today: Side | null; next: Side | null } | null = null;

  let dragging = false;
  let lx = 0;
  let ly = 0;
  canvas.addEventListener('pointerdown', (e) => {
    dragging = true;
    lx = e.clientX;
    ly = e.clientY;
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    yaw -= (e.clientX - lx) * 0.008;
    pitch = Math.max(-0.25, Math.min(1.35, pitch + (e.clientY - ly) * 0.006));
    lx = e.clientX;
    ly = e.clientY;
  });
  canvas.addEventListener('pointerup', () => (dragging = false));
  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      dist = Math.max(10, Math.min(400, dist * Math.exp(e.deltaY * 0.001)));
    },
    { passive: false },
  );

  let last = performance.now();
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  function frame(now: number): void {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (canvas.width !== Math.round(w * renderer.getPixelRatio()) || canvas.height !== Math.round(h * renderer.getPixelRatio())) renderer.setSize(w, h, false);
    if (!dragging && !reduce) yaw += dt * 0.12;
    if (cur) {
      const wide = w > 640;
      const halves: [Side | null, number, number, number, number][] = wide
        ? [
            [cur.today, 0, 0, w / 2, h],
            [cur.next, w / 2, 0, w / 2, h],
          ]
        : [
            [cur.today, 0, h / 2, w, h / 2],
            [cur.next, 0, 0, w, h / 2],
          ];
      for (const [side, x, y, sw, sh] of halves) {
        renderer.setViewport(x, y, sw, sh);
        renderer.setScissor(x, y, sw, sh);
        cam.aspect = sw / sh;
        cam.position.set(target.x + Math.sin(yaw) * Math.cos(pitch) * dist, target.y + Math.sin(pitch) * dist, target.z + Math.cos(yaw) * Math.cos(pitch) * dist);
        cam.lookAt(target);
        cam.updateProjectionMatrix();
        if (!side) {
          renderer.setClearColor(0x2a2f36);
          renderer.clear();
          continue;
        }
        side.scene.background = sky;
        // ModelBuilder parts turn about their pivot's local X
        if (spin) for (const s of side.spinners) s.obj.rotation.x += s.rate * dt;
        renderer.render(side.scene, cam);
      }
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  return {
    show(id: string) {
      let c = cache.get(id);
      if (!c) {
        c = { today: todaySide(id), next: newSide(id) };
        cache.set(id, c);
      }
      cur = c;
      onStats(c.today?.triangles ?? null, c.next?.triangles ?? null);
    },
    setSpin(on: boolean) {
      spin = on;
    },
    setDistance(d: number) {
      dist = d;
    },
  };
}

/* ───────────────────────── the route map ───────────────────────── */

export interface RouteStop {
  label: string;
  x: number;
  z: number;
}

const pad = (id: string, label: string): RouteStop => {
  const p = helipad(id)!;
  return { label, x: p.x, z: p.z };
};
const geo = (lat: number, lon: number, label: string): RouteStop => ({ label, ...geoToWorld(lat, lon) });

export const STOPS = {
  ach: pad('auckland_city_hospital', 'Auckland City Hospital (Starship)'),
  ardmore: pad('ardmore_aerodrome', 'Ardmore base'),
  onetangi: geo(-36.80548, 175.06987, 'Onetangi, Waiheke'),
  nsh: pad('north_shore_hospital', 'North Shore Hospital'),
  middlemore: pad('middlemore_hospital', 'Middlemore Hospital'),
  onehunga: pad('auckland_heliport', 'Auckland Heliport, Onehunga'),
  mechanics: pad('mechanics_bay_heliport', 'Mechanics Bay'),
  cablebay: pad('cable_bay_vineyards', 'Cable Bay Vineyards'),
  // off the map: where the route enters the game world
  barrierEdge: { label: 'from Great Barrier (90 km NE)', x: 30000, z: -24000 },
  northEdge: { label: 'from Whangārei (130 km N)', x: -6000, z: -27000 },
};

export function routePoints(): Record<string, RouteStop> {
  return STOPS;
}

/** The coast as SVG path data in world km (x east, z south), clipped by the viewBox. */
export function coastPaths(): { water: string[]; islands: string[] } {
  const poly = (pts: number[]) => {
    let d = '';
    for (let i = 0; i < pts.length; i += 2) d += `${i ? 'L' : 'M'}${pts[i].toFixed(2)} ${pts[i + 1].toFixed(2)}`;
    return d + 'Z';
  };
  const islands: string[] = [];
  for (const isl of AKL_ISLANDS) {
    if ('pts' in isl) islands.push(poly(isl.pts));
    else {
      const [cx, cz, rx, rz, rot] = isl.ellipse;
      islands.push(`ellipse:${cx},${cz},${rx},${rz},${rot}`);
    }
  }
  return { water: AKL_WATER.map((w) => poly(w.pts)), islands };
}
