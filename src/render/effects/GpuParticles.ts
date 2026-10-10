/**
 * GPU particle system with ANALYTIC motion: each particle is written once into a ring buffer
 * (spawn position, velocity, birth time, drag, buoyancy/gravity, size & colour curves) and the
 * vertex shader evaluates position/size/colour from the global time. No per-frame CPU work per
 * particle, no allocation: spawning overwrites the oldest slot. One instanced draw call per system.
 *
 * Motion: v(t) = vt + (v0 - vt)·e^(-k t),  x(t) = x0 + vt·t + (v0 - vt)·(1 - e^(-k t))/k
 * with terminal velocity vt = wind + g/k (g = vertical accel: + buoyant smoke, - falling sparks).
 */
import {
  AdditiveBlending,
  BufferAttribute,
  DynamicDrawUsage,
  InstancedBufferGeometry,
  InstancedInterleavedBuffer,
  InterleavedBufferAttribute,
  Mesh,
  NormalBlending,
  ShaderMaterial,
  UniformsLib,
  UniformsUtils,
  Vector3,
  type Texture,
} from 'three';

/** Floats per particle in the interleaved buffer. */
export const STRIDE = 28;

/** Mutable spawn description — reuse one instance (see `spawnParams()` / `resetSpawn`). */
export interface ParticleSpawn {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  /** Lifetime (s). */
  life: number;
  /** Drag coefficient k (1/s). */
  drag: number;
  /** Vertical acceleration (m/s², + = buoyant/rising, -9.8 = falling). */
  grav: number;
  size0: number;
  size1: number;
  /** Size easing exponent (1 = linear, >1 = fast early growth). */
  sizeCurve: number;
  rot: number;
  rotSpeed: number;
  r0: number;
  g0: number;
  b0: number;
  a0: number;
  r1: number;
  g1: number;
  b1: number;
  a1: number;
  /** Fraction of life for the alpha fade-in. */
  fadeIn: number;
  /** Streak length factor (s): quad stretched along velocity × streak. 0 = billboard. */
  streak: number;
  /** Texture atlas cell 0..3. */
  variant: number;
  /** Minimum on-screen width in CSS px. */
  minPx: number;
  /** 0..1 brightness flicker. */
  flicker: number;
}

export function spawnParams(): ParticleSpawn {
  return resetSpawn({} as ParticleSpawn);
}

export function resetSpawn(p: ParticleSpawn): ParticleSpawn {
  p.x = p.y = p.z = 0;
  p.vx = p.vy = p.vz = 0;
  p.life = 1;
  p.drag = 1;
  p.grav = 0;
  p.size0 = 1;
  p.size1 = 1;
  p.sizeCurve = 1;
  p.rot = 0;
  p.rotSpeed = 0;
  p.r0 = p.g0 = p.b0 = 1;
  p.a0 = 1;
  p.r1 = p.g1 = p.b1 = 1;
  p.a1 = 0;
  p.fadeIn = 0.02;
  p.streak = 0;
  p.variant = 0;
  p.minPx = 0;
  p.flicker = 0;
  return p;
}

/** CPU mirror of the shader motion (used by tests and by effects that need a particle's position). */
export function particlePosition(p: ParticleSpawn, age: number, wind: { x: number; y: number; z: number }, out: Vector3): Vector3 {
  const k = Math.max(p.drag, 0.01);
  const vtx = wind.x;
  const vty = wind.y + p.grav / k;
  const vtz = wind.z;
  const e = (1 - Math.exp(-k * age)) / k;
  return out.set(p.x + vtx * age + (p.vx - vtx) * e, p.y + vty * age + (p.vy - vty) * e, p.z + vtz * age + (p.vz - vtz) * e);
}

/**
 * Brightness of the effects' additive glow (fire particles and Effects' glow sprites), one uniform
 * shared by their materials: 1 in the main view. The target camera pass lowers it for its draw (TargetCam
 * PIP_GLOW_GAIN, #282 R31-10): the zoomed window is filled by a kill's flash and fireball, and stacked
 * additive fire there blew out to white instead of reading as an orange ball over the target.
 */
export const glowGain = { value: 1 };

const VERT = /* glsl */ `
attribute vec3 aP0;
attribute vec3 aV0;
attribute vec4 aT;   // birth, life, drag, grav
attribute vec4 aS;   // size0, size1, rot, rotSpeed
attribute vec4 aC0;
attribute vec4 aC1;
attribute vec4 aM;   // streak, variant, fadeIn, sizeCurve
attribute vec4 aX;   // minPx, flicker, -, -
uniform float uTime;
uniform vec3 uWind;
uniform float uPx;
varying vec2 vUv;
varying vec4 vColor;
#include <fog_pars_vertex>
void main() {
  float age = uTime - aT.x;
  float life = aT.y;
  if (age < 0.0 || age >= life) {
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    vColor = vec4(0.0);
    vUv = vec2(0.0);
    return;
  }
  float t = age / life;
  float k = max(aT.z, 0.01);
  vec3 vt = uWind + vec3(0.0, aT.w / k, 0.0);
  float ek = exp(-k * age);
  vec3 pos = aP0 + vt * age + (aV0 - vt) * (1.0 - ek) / k;
  vec3 vel = vt + (aV0 - vt) * ek;
  float size = mix(aS.x, aS.y, 1.0 - pow(1.0 - t, aM.w));
  float a = mix(aC0.a, aC1.a, t) * smoothstep(0.0, max(aM.z, 1e-4), t);
  vec3 col = mix(aC0.rgb, aC1.rgb, t);
  float seed = fract(sin(dot(aP0.xz, vec2(12.9898, 78.233))) * 43758.5453);
  a *= 1.0 - aX.y * (0.5 + 0.5 * sin(age * 33.0 + seed * 40.0));
  vec4 mv = viewMatrix * vec4(pos, 1.0);
  float depth = -mv.z;
  if (depth < 0.1) {
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    vColor = vec4(0.0);
    vUv = vec2(0.0);
    return;
  }
  size = max(size, aX.x * depth * uPx);
  // fade puffs the camera is inside of, and cap their screen size (mobile fill-rate)
  a *= smoothstep(size * 0.2, size * 0.8, depth);
  size = min(size, depth * 1.4);
  vec2 c = position.xy;
  if (aM.x > 0.0) {
    vec3 dv = (viewMatrix * vec4(vel * aM.x, 0.0)).xyz;
    float len = length(dv.xy);
    vec2 ax = len > 1e-5 ? dv.xy / len : vec2(1.0, 0.0);
    vec2 pr = vec2(-ax.y, ax.x);
    mv.xy += pr * c.x * size + ax * (c.y - 0.5) * (len + size * 0.5);
  } else {
    float rot = aS.z + aS.w * age;
    float cs = cos(rot);
    float sn = sin(rot);
    mv.xy += vec2(c.x * cs - c.y * sn, c.x * sn + c.y * cs) * size;
  }
  float v = floor(aM.y + 0.5);
  vUv = (c + 0.5) * 0.5 + vec2(mod(v, 2.0) * 0.5, 0.5 - floor(v / 2.0) * 0.5);
  vColor = vec4(col, a);
  gl_Position = projectionMatrix * mv;
  #ifdef USE_FOG
    vFogDepth = depth;
  #endif
}`;

const FRAG_SMOKE = /* glsl */ `
uniform sampler2D uMap;
uniform vec3 uLight;
varying vec2 vUv;
varying vec4 vColor;
#include <fog_pars_fragment>
void main() {
  vec4 tx = texture2D(uMap, vUv);
  float a = tx.a * vColor.a;
  if (a < 0.003) discard;
  vec3 col = vColor.rgb * (0.6 + 0.55 * tx.r) * uLight;
  #ifdef USE_FOG
    #ifdef FOG_EXP2
      float fogF = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
    #else
      float fogF = smoothstep(fogNear, fogFar, vFogDepth);
    #endif
    col = mix(col, fogColor, fogF * 0.8);
  #endif
  gl_FragColor = vec4(col, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

const FRAG_GLOW = /* glsl */ `
uniform sampler2D uMap;
uniform float uGain;
varying vec2 vUv;
varying vec4 vColor;
#include <fog_pars_fragment>
void main() {
  float a = texture2D(uMap, vUv).a * vColor.a;
  if (a < 0.003) discard;
  vec3 col = vColor.rgb * a * uGain;
  #ifdef USE_FOG
    #ifdef FOG_EXP2
      float fogF = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
    #else
      float fogF = smoothstep(fogNear, fogFar, vFogDepth);
    #endif
    // emissive fire punches through haze: only ~half the scene fog applies (i1: kills at 1-5 km
    // were washed out by the dawn/dusk fog)
    col *= 1.0 - fogF * 0.5;
  #endif
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}`;

export class GpuParticles {
  readonly mesh: Mesh;
  readonly material: ShaderMaterial;
  private readonly data: Float32Array;
  private readonly buffer: InstancedInterleavedBuffer;
  private readonly geo: InstancedBufferGeometry;
  private head = 0;
  private used = 0;
  private dirtyStart = 0;
  private dirtyCount = 0;
  /** Particles spawned since creation (stats/tests). */
  spawned = 0;

  constructor(
    readonly capacity: number,
    readonly mode: 'normal' | 'additive',
    map: Texture | null,
    renderOrder: number,
  ) {
    this.data = new Float32Array(capacity * STRIDE);
    this.buffer = new InstancedInterleavedBuffer(this.data, STRIDE, 1);
    this.buffer.setUsage(DynamicDrawUsage);
    const g = new InstancedBufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]), 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    const at = (name: string, size: number, offset: number) => g.setAttribute(name, new InterleavedBufferAttribute(this.buffer, size, offset));
    at('aP0', 3, 0);
    at('aV0', 3, 3);
    at('aT', 4, 6);
    at('aS', 4, 10);
    at('aC0', 4, 14);
    at('aC1', 4, 18);
    at('aM', 4, 22);
    at('aX', 2, 26);
    g.instanceCount = 0;
    this.geo = g;
    this.material = new ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: mode === 'normal' ? FRAG_SMOKE : FRAG_GLOW,
      uniforms: UniformsUtils.merge([
        UniformsLib.fog,
        { uTime: { value: 0 }, uWind: { value: new Vector3() }, uPx: { value: 0.002 }, uMap: { value: null }, uLight: { value: new Vector3(1, 1, 1) } },
      ]),
      transparent: true,
      depthWrite: false,
      blending: mode === 'normal' ? NormalBlending : AdditiveBlending,
      fog: true,
      toneMapped: mode === 'normal',
    });
    this.material.uniforms.uMap.value = map;
    // after the merge (it clones uniforms): the glow materials share the one gain object
    if (mode === 'additive') this.material.uniforms.uGain = glowGain;
    this.mesh = new Mesh(g, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = renderOrder;
    this.mesh.name = `particles:${mode}`;
  }

  /** Write one particle (overwrites the oldest when full). */
  spawn(p: ParticleSpawn, time: number): void {
    const i = this.head;
    this.head = (this.head + 1) % this.capacity;
    if (this.used < this.capacity) this.used++;
    this.spawned++;
    if (this.dirtyCount === 0) this.dirtyStart = i;
    if (this.dirtyCount < this.capacity) this.dirtyCount++;
    const d = this.data;
    const o = i * STRIDE;
    d[o] = p.x;
    d[o + 1] = p.y;
    d[o + 2] = p.z;
    d[o + 3] = p.vx;
    d[o + 4] = p.vy;
    d[o + 5] = p.vz;
    d[o + 6] = time;
    d[o + 7] = p.life;
    d[o + 8] = p.drag;
    d[o + 9] = p.grav;
    d[o + 10] = p.size0;
    d[o + 11] = p.size1;
    d[o + 12] = p.rot;
    d[o + 13] = p.rotSpeed;
    d[o + 14] = p.r0;
    d[o + 15] = p.g0;
    d[o + 16] = p.b0;
    d[o + 17] = p.a0;
    d[o + 18] = p.r1;
    d[o + 19] = p.g1;
    d[o + 20] = p.b1;
    d[o + 21] = p.a1;
    d[o + 22] = p.streak;
    d[o + 23] = p.variant;
    d[o + 24] = p.fadeIn;
    d[o + 25] = p.sizeCurve;
    d[o + 26] = p.minPx;
    d[o + 27] = p.flicker;
  }

  /** Ring slots touched since the last upload, as [start, count] pairs (≤ 2 ranges). */
  dirtyRanges(): [number, number][] {
    if (this.dirtyCount === 0) return [];
    const end = this.dirtyStart + this.dirtyCount;
    if (end <= this.capacity) return [[this.dirtyStart, this.dirtyCount]];
    return [
      [this.dirtyStart, this.capacity - this.dirtyStart],
      [0, end - this.capacity],
    ];
  }

  /** Upload new particles and set per-frame uniforms. */
  update(time: number, wind: Vector3, px: number, light: number): void {
    const u = this.material.uniforms;
    u.uTime.value = time;
    (u.uWind.value as Vector3).copy(wind);
    u.uPx.value = px;
    (u.uLight.value as Vector3).setScalar(light);
    this.geo.instanceCount = this.used;
    if (this.dirtyCount === 0) return;
    this.buffer.clearUpdateRanges();
    const end = this.dirtyStart + this.dirtyCount;
    if (end <= this.capacity) this.buffer.addUpdateRange(this.dirtyStart * STRIDE, this.dirtyCount * STRIDE);
    else {
      this.buffer.addUpdateRange(this.dirtyStart * STRIDE, (this.capacity - this.dirtyStart) * STRIDE);
      this.buffer.addUpdateRange(0, (end - this.capacity) * STRIDE);
    }
    this.buffer.needsUpdate = true;
    this.dirtyCount = 0;
  }

  /** Number of slots in use (all ever written, up to capacity). */
  get size(): number {
    return this.used;
  }

  /** Oldest-slot index that the next spawn will overwrite. */
  get cursor(): number {
    return this.head;
  }

  /** Read a slot's birth time (tests/debug). */
  birthAt(i: number): number {
    return this.data[i * STRIDE + 6];
  }

  dispose(): void {
    this.geo.dispose();
    this.material.dispose();
    this.mesh.removeFromParent();
  }
}
