/**
 * Small pooled mesh effects:
 *  - Debris: InstancedMesh of tumbling burnt chunks with CPU ballistics; they trail smoke/fire.
 *  - Pulses: expanding ground shockwave / dust rings, water foam rings, air shock spheres.
 *  - VaporCones: transonic condensation cone shells around aircraft.
 */
import {
  AdditiveBlending,
  Color,
  DoubleSide,
  DynamicDrawUsage,
  IcosahedronGeometry,
  InstancedMesh,
  LatheGeometry,
  Matrix4,
  Mesh,
  MeshLambertMaterial,
  NormalBlending,
  Object3D,
  Quaternion,
  RingGeometry,
  ShaderMaterial,
  SphereGeometry,
  Vector2,
  Vector3,
  type BufferGeometry,
} from 'three';

const _m = new Matrix4();
const _q = new Quaternion();
const _s = new Vector3();

/* ───────────────────────── debris ───────────────────────── */

interface Chunk {
  alive: boolean;
  pos: Vector3;
  vel: Vector3;
  axis: Vector3;
  angle: number;
  spin: number;
  size: number;
  age: number;
  life: number;
  landed: boolean;
  burn: number;
  emitAcc: number;
}

export class Debris {
  readonly mesh: InstancedMesh;
  private readonly chunks: Chunk[] = [];
  private next = 0;

  constructor(readonly capacity: number) {
    const geo = new IcosahedronGeometry(0.5, 0);
    geo.scale(1.3, 0.55, 0.9);
    const mat = new MeshLambertMaterial({ color: 0x2a2724 });
    this.mesh = new InstancedMesh(geo, mat, Math.max(1, capacity));
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.name = 'debris';
    for (let i = 0; i < capacity; i++)
      this.chunks.push({ alive: false, pos: new Vector3(), vel: new Vector3(), axis: new Vector3(0, 1, 0), angle: 0, spin: 0, size: 1, age: 0, life: 1, landed: false, burn: 0, emitAcc: 0 });
  }

  spawn(x: number, y: number, z: number, vx: number, vy: number, vz: number, size: number, life: number, burn: number): void {
    if (this.capacity === 0) return;
    const c = this.chunks[this.next];
    this.next = (this.next + 1) % this.capacity;
    c.alive = true;
    c.pos.set(x, y, z);
    c.vel.set(vx, vy, vz);
    c.axis.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
    c.angle = Math.random() * 6;
    c.spin = 2 + Math.random() * 8;
    c.size = size;
    c.age = 0;
    c.life = life;
    c.landed = false;
    c.burn = burn;
    c.emitAcc = 0;
  }

  /**
   * Integrate and rebuild instance matrices. `ground(x,z)` gives the surface height;
   * `trail(chunk pos, burning 0..1, dtEmit)` is called ~every 60 ms per flying chunk to emit smoke.
   */
  update(dt: number, ground: (x: number, z: number) => number, trail: (p: Vector3, burning: number) => void): void {
    let n = 0;
    for (let i = 0; i < this.chunks.length; i++) {
      const c = this.chunks[i];
      if (!c.alive) continue;
      c.age += dt;
      if (c.age >= c.life) {
        c.alive = false;
        continue;
      }
      if (!c.landed) {
        const k = Math.exp(-0.25 * dt);
        c.vel.multiplyScalar(k);
        c.vel.y -= 9.81 * dt;
        c.pos.addScaledVector(c.vel, dt);
        c.angle += c.spin * dt;
        const gy = ground(c.pos.x, c.pos.z);
        if (c.pos.y <= gy + c.size * 0.3) {
          c.pos.y = gy + c.size * 0.3;
          c.landed = true;
          c.life = Math.min(c.life, c.age + 6);
        }
        c.emitAcc += dt;
        if (c.emitAcc > 0.06) {
          c.emitAcc = 0;
          trail(c.pos, Math.max(0, 1 - c.age / Math.max(0.1, c.burn)));
        }
      }
      const fade = c.landed ? Math.max(0, 1 - (c.age - (c.life - 6)) / 6) : 1;
      _q.setFromAxisAngle(c.axis, c.angle);
      _s.setScalar(c.size * Math.max(0.05, fade));
      _m.compose(c.pos, _q, _s);
      this.mesh.setMatrixAt(n++, _m);
    }
    this.mesh.count = n;
    if (n > 0) this.mesh.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as MeshLambertMaterial).dispose();
    this.mesh.dispose();
    this.mesh.removeFromParent();
  }
}

/* ───────────────────────── pulses (rings & shock spheres) ───────────────────────── */

const PULSE_VERT = /* glsl */ `
varying vec2 vUv;
varying vec3 vN;
varying vec3 vV;
void main() {
  vUv = uv;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vN = normalize(normalMatrix * normal);
  vV = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}`;
const PULSE_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uAlpha;
uniform float uSphere;
varying vec2 vUv;
varying vec3 vN;
varying vec3 vV;
void main() {
  float a;
  if (uSphere > 0.5) {
    float f = 1.0 - abs(dot(vN, vV));
    a = pow(f, 2.0) * uAlpha;
  } else {
    // ring: soft band across the ring width (uv.y from inner to outer in three's RingGeometry via radius)
    float r = vUv.x;
    a = smoothstep(0.0, 0.35, r) * (1.0 - smoothstep(0.55, 1.0, r)) * uAlpha;
  }
  if (a < 0.003) discard;
  gl_FragColor = vec4(uColor, a);
}`;

interface Pulse {
  mesh: Mesh;
  mat: ShaderMaterial;
  t: number;
  dur: number;
  r0: number;
  r1: number;
  alpha: number;
  active: boolean;
  sphere: boolean;
}

export class Pulses {
  readonly group = new Object3D();
  private readonly list: Pulse[] = [];
  private readonly ringGeo: BufferGeometry;
  private readonly sphereGeo: BufferGeometry;

  constructor(rings = 8, spheres = 4) {
    this.group.name = 'pulses';
    // ring with uv.x = radial coordinate 0 (inner) → 1 (outer)
    const rg = new RingGeometry(0.55, 1, 48, 1);
    const uv = rg.attributes.uv;
    const pos = rg.attributes.position;
    for (let i = 0; i < uv.count; i++) {
      const r = Math.hypot(pos.getX(i), pos.getY(i));
      uv.setXY(i, (r - 0.55) / 0.45, 0);
    }
    rg.rotateX(-Math.PI / 2);
    this.ringGeo = rg;
    this.sphereGeo = new SphereGeometry(1, 20, 12);
    const make = (sphere: boolean) => {
      const mat = new ShaderMaterial({
        vertexShader: PULSE_VERT,
        fragmentShader: PULSE_FRAG,
        uniforms: { uColor: { value: new Color(1, 1, 1) }, uAlpha: { value: 0 }, uSphere: { value: sphere ? 1 : 0 } },
        transparent: true,
        depthWrite: false,
        side: DoubleSide,
        blending: sphere ? AdditiveBlending : NormalBlending,
      });
      const mesh = new Mesh(sphere ? this.sphereGeo : this.ringGeo, mat);
      mesh.visible = false;
      mesh.frustumCulled = false;
      mesh.renderOrder = 8;
      this.group.add(mesh);
      this.list.push({ mesh, mat, t: 0, dur: 1, r0: 1, r1: 10, alpha: 1, active: false, sphere });
    };
    for (let i = 0; i < rings; i++) make(false);
    for (let i = 0; i < spheres; i++) make(true);
  }

  /** Start a pulse. kind: 'ring' (flat, on the ground/water) or 'sphere' (air shock). */
  fire(kind: 'ring' | 'sphere', x: number, y: number, z: number, r0: number, r1: number, dur: number, color: Color, alpha: number): void {
    const want = kind === 'sphere';
    let best: Pulse | null = null;
    for (const p of this.list) {
      if (p.sphere !== want) continue;
      if (!p.active) {
        best = p;
        break;
      }
      if (!best || p.t / p.dur > best.t / best.dur) best = p;
    }
    if (!best) return;
    best.active = true;
    best.t = 0;
    best.dur = dur;
    best.r0 = r0;
    best.r1 = r1;
    best.alpha = alpha;
    best.mesh.position.set(x, y, z);
    (best.mat.uniforms.uColor.value as Color).copy(color);
    best.mesh.visible = true;
  }

  update(dt: number): void {
    for (const p of this.list) {
      if (!p.active) continue;
      p.t += dt;
      const k = p.t / p.dur;
      if (k >= 1) {
        p.active = false;
        p.mesh.visible = false;
        continue;
      }
      const e = 1 - Math.pow(1 - k, 2.2);
      p.mesh.scale.setScalar(p.r0 + (p.r1 - p.r0) * e);
      p.mat.uniforms.uAlpha.value = p.alpha * (1 - k) * (p.sphere ? 1 : Math.min(1, k * 8));
    }
  }

  dispose(): void {
    this.ringGeo.dispose();
    this.sphereGeo.dispose();
    this.list.forEach((p) => p.mat.dispose());
    this.group.removeFromParent();
  }
}

/* ───────────────────────── vapor cones ───────────────────────── */

const CONE_FRAG = /* glsl */ `
uniform float uAlpha;
uniform float uTime;
varying vec2 vUv;
varying vec3 vN;
varying vec3 vV;
void main() {
  float rim = 1.0 - abs(dot(vN, vV));
  float along = vUv.y;                         // 0 front edge → 1 aft edge
  float band = smoothstep(0.0, 0.25, along) * (1.0 - smoothstep(0.55, 1.0, along));
  float streak = 0.75 + 0.25 * sin(vUv.x * 60.0 + uTime * 3.0) * sin(vUv.x * 23.0);
  float a = uAlpha * band * streak * (0.35 + 0.65 * rim);
  if (a < 0.003) discard;
  gl_FragColor = vec4(vec3(0.95, 0.97, 1.0), a);
}`;

export class VaporCones {
  readonly group = new Object3D();
  private readonly cones: { mesh: Mesh; mat: ShaderMaterial }[] = [];
  private readonly geo: BufferGeometry;
  private used = 0;

  constructor(count = 3) {
    this.group.name = 'vaporCones';
    // lathe profile (radius, y) → rotate so the axis runs along Z (front at -Z)
    const pts: Vector2[] = [];
    for (let i = 0; i <= 8; i++) {
      const t = i / 8;
      pts.push(new Vector2(0.9 + t * 5.2 + Math.sin(t * Math.PI) * 0.6, -3 + t * 9));
    }
    const g = new LatheGeometry(pts, 28);
    g.rotateX(Math.PI / 2); // lathe Y axis → +Z (aft)
    this.geo = g;
    for (let i = 0; i < count; i++) {
      const mat = new ShaderMaterial({
        vertexShader: PULSE_VERT,
        fragmentShader: CONE_FRAG,
        uniforms: { uAlpha: { value: 0 }, uTime: { value: 0 } },
        transparent: true,
        depthWrite: false,
        side: DoubleSide,
      });
      const mesh = new Mesh(g, mat);
      mesh.visible = false;
      mesh.frustumCulled = false;
      mesh.renderOrder = 7;
      this.group.add(mesh);
      this.cones.push({ mesh, mat });
    }
  }

  begin(): void {
    this.used = 0;
  }

  /** Show a cone around an aircraft (world position/orientation, model-space scale). */
  add(pos: Vector3, quat: Quaternion, scale: number, alpha: number, time: number): void {
    if (this.used >= this.cones.length) return;
    const c = this.cones[this.used++];
    c.mesh.position.copy(pos);
    c.mesh.quaternion.copy(quat);
    c.mesh.scale.setScalar(scale);
    c.mat.uniforms.uAlpha.value = alpha;
    c.mat.uniforms.uTime.value = time;
    c.mesh.visible = true;
  }

  end(): void {
    for (let i = this.used; i < this.cones.length; i++) this.cones[i].mesh.visible = false;
  }

  dispose(): void {
    this.geo.dispose();
    this.cones.forEach((c) => c.mat.dispose());
    this.group.removeFromParent();
  }
}

