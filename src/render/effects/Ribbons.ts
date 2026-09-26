/**
 * Ribbon trails (missile smoke, contrails, wingtip vortices, flare & wreck smoke trails).
 *
 * All ribbons share ONE geometry and draw call. Committed segments live in a global ring buffer
 * (segments are allocated in time order, so overwriting the oldest is always correct); each active
 * emitter additionally owns a "head" segment slot that is rewritten every frame to connect the
 * last committed point to the live source position. Width growth, fading, wind drift and
 * camera-facing expansion are evaluated on the GPU from the birth time, so committed segments are
 * uploaded exactly once.
 */
import {
  BufferAttribute,
  BufferGeometry,
  DynamicDrawUsage,
  InterleavedBuffer,
  InterleavedBufferAttribute,
  Mesh,
  NormalBlending,
  ShaderMaterial,
  UniformsLib,
  UniformsUtils,
  Vector3,
} from 'three';

export interface RibbonStyle {
  /** Initial width (m) and growth (m/s). */
  width: number;
  growth: number;
  /** Segment lifetime (s). */
  life: number;
  /** Peak opacity. */
  alpha: number;
  /** Linear RGB. */
  r: number;
  g: number;
  b: number;
  /** Seconds before the trail becomes visible (contrails form behind the engine). */
  formDelay: number;
  /** Commit a new point after this distance (m) or interval (s). */
  spacing: number;
  interval: number;
}

/** Floats per vertex: center(3) tangent(3) time(4: birth, life, side, dist) style(4: w0, growth, alpha, form) color(3). */
const VS = 17;

const VERT = /* glsl */ `
attribute vec3 aCenter;
attribute vec3 aTangent;
attribute vec4 aTime;
attribute vec4 aStyle;
attribute vec3 aColor;
uniform float uTime;
uniform vec3 uWind;
uniform float uPx;
varying float vSide;
varying float vU;
varying float vAlpha;
varying vec3 vColor;
#include <fog_pars_vertex>
void main() {
  float age = uTime - aTime.x;
  float life = aTime.y;
  if (life <= 0.0 || age >= life || age < -0.25) {
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    vAlpha = 0.0;
    return;
  }
  age = max(age, 0.0);
  float t = age / life;
  vec3 c = aCenter + uWind * age * 0.85;
  float w0 = aStyle.x + aStyle.y * age;
  vec3 toCam = cameraPosition - c;
  float dist = length(toCam);
  // keep distant trails visible as thin lines (≥ ~1.6 px) but fade them to compensate
  float w = max(w0, 1.6 * dist * uPx);
  float thin = w0 / w;
  toCam /= max(dist, 1e-3);
  vec3 side = cross(aTangent, toCam);
  float sl = length(side);
  side = sl > 1e-4 ? side / sl : vec3(0.0, 1.0, 0.0);
  vec3 p = c + side * aTime.z * w * 0.5;
  vAlpha = aStyle.z * pow(1.0 - t, 1.25) * smoothstep(0.0, max(aStyle.w, 1e-3), age) * (0.45 + 0.55 * thin);
  // viewed end-on a ribbon collapses to a line: soften it (puff particles cover that case)
  vAlpha *= 0.35 + 0.65 * smoothstep(0.02, 0.25, sl);
  // don't let a trail fill the screen when the camera flies through it
  vAlpha *= smoothstep(w0 * 0.3, w0 * 1.5, dist);
  vSide = aTime.z;
  vU = aTime.w / max(w * 2.5, 0.8);
  vColor = aColor;
  vec4 mv = viewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  #ifdef USE_FOG
    vFogDepth = -mv.z;
  #endif
}`;

const FRAG = /* glsl */ `
uniform vec3 uLight;
varying float vSide;
varying float vU;
varying float vAlpha;
varying vec3 vColor;
#include <fog_pars_fragment>
void main() {
  float prof = pow(max(0.0, 1.0 - vSide * vSide), 1.4);
  float n = 0.72 + 0.28 * sin(vU * 5.1 + vSide * 2.3) * sin(vU * 1.7 - vSide * 1.3 + 1.0);
  float a = vAlpha * prof * n;
  if (a < 0.003) discard;
  vec3 col = vColor * uLight * (0.85 + 0.25 * (1.0 - abs(vSide)));
  #ifdef USE_FOG
    #ifdef FOG_EXP2
      float fogF = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
    #else
      float fogF = smoothstep(fogNear, fogFar, vFogDepth);
    #endif
    col = mix(col, fogColor, fogF);
  #endif
  gl_FragColor = vec4(col, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

interface Emitter {
  active: boolean;
  hasLast: boolean;
  last: Vector3;
  lastTime: number;
  dist: number;
  style: RibbonStyle;
  alphaMul: number;
}

const _d = new Vector3();

export class Ribbons {
  readonly mesh: Mesh;
  readonly material: ShaderMaterial;
  private readonly data: Float32Array;
  private readonly buffer: InterleavedBuffer;
  private readonly geo: BufferGeometry;
  private readonly emitters: Emitter[] = [];
  private ringHead = 0;
  private dirtyStart = 0;
  private dirtyCount = 0;
  private headDirty = false;
  readonly totalSegments: number;
  committed = 0;

  constructor(
    readonly ringCapacity: number,
    readonly headSlots = 96,
    renderOrder = 9,
  ) {
    const segs = headSlots + ringCapacity;
    this.totalSegments = segs;
    this.data = new Float32Array(segs * 4 * VS);
    this.buffer = new InterleavedBuffer(this.data, VS);
    this.buffer.setUsage(DynamicDrawUsage);
    const g = new BufferGeometry();
    const at = (name: string, size: number, offset: number) => g.setAttribute(name, new InterleavedBufferAttribute(this.buffer, size, offset));
    at('aCenter', 3, 0);
    at('aTangent', 3, 3);
    at('aTime', 4, 6);
    at('aStyle', 4, 10);
    at('aColor', 3, 14);
    // three.js needs a 'position' attribute for bounds/draw range; alias the centre
    g.setAttribute('position', new InterleavedBufferAttribute(this.buffer, 3, 0));
    const idx = new Uint32Array(segs * 6);
    for (let s = 0; s < segs; s++) {
      const v = s * 4;
      idx.set([v, v + 1, v + 2, v + 1, v + 3, v + 2], s * 6);
    }
    g.setIndex(new BufferAttribute(idx, 1));
    this.geo = g;
    this.material = new ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: UniformsUtils.merge([UniformsLib.fog, { uTime: { value: 0 }, uWind: { value: new Vector3() }, uLight: { value: new Vector3(1, 1, 1) }, uPx: { value: 0.002 } }]),
      transparent: true,
      depthWrite: false,
      blending: NormalBlending,
      fog: true,
    });
    this.mesh = new Mesh(g, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = renderOrder;
    this.mesh.name = 'ribbons';
    for (let i = 0; i < headSlots; i++)
      this.emitters.push({ active: false, hasLast: false, last: new Vector3(), lastTime: 0, dist: 0, style: null as unknown as RibbonStyle, alphaMul: 1 });
  }

  /** Allocate an emitter (returns -1 when all head slots are busy). */
  alloc(style: RibbonStyle): number {
    for (let i = 0; i < this.emitters.length; i++) {
      const e = this.emitters[i];
      if (!e.active) {
        e.active = true;
        e.hasLast = false;
        e.style = style;
        e.dist = 0;
        e.alphaMul = 1;
        return i;
      }
    }
    return -1;
  }

  isActive(id: number): boolean {
    return id >= 0 && this.emitters[id].active;
  }

  /** Feed the current source position (call every frame while emitting). */
  emit(id: number, x: number, y: number, z: number, time: number, alphaMul = 1): void {
    if (id < 0) return;
    const e = this.emitters[id];
    if (!e.active) return;
    e.alphaMul = alphaMul;
    if (!e.hasLast) {
      e.hasLast = true;
      e.last.set(x, y, z);
      e.lastTime = time;
      this.clearSegment(id);
      return;
    }
    _d.set(x - e.last.x, y - e.last.y, z - e.last.z);
    const len = _d.length();
    if (len > 0.05 && (len >= e.style.spacing || time - e.lastTime >= e.style.interval)) {
      this.writeSegment(this.headSlots + this.ringHead, e, x, y, z, len, time);
      this.markRing(this.ringHead);
      this.ringHead = (this.ringHead + 1) % this.ringCapacity;
      this.committed++;
      e.dist += len;
      e.last.set(x, y, z);
      e.lastTime = time;
      this.clearSegment(id);
    } else if (len > 0.02) {
      this.writeSegment(id, e, x, y, z, len, time);
      this.headDirty = true;
    }
  }

  /** Stop emitting: commit the final piece; the trail keeps fading on its own. */
  release(id: number, time: number): void {
    if (id < 0) return;
    const e = this.emitters[id];
    if (!e.active) return;
    e.active = false;
    this.clearSegment(id);
    void time;
  }

  private markRing(slot: number): void {
    if (this.dirtyCount === 0) this.dirtyStart = slot;
    if (this.dirtyCount < this.ringCapacity) this.dirtyCount++;
  }

  private clearSegment(seg: number): void {
    const o = seg * 4 * VS;
    for (let v = 0; v < 4; v++) this.data[o + v * VS + 7] = 0; // life = 0 → hidden
    if (seg < this.headSlots) this.headDirty = true;
  }

  private writeSegment(seg: number, e: Emitter, x: number, y: number, z: number, len: number, time: number): void {
    const d = this.data;
    const s = e.style;
    const tx = (x - e.last.x) / len;
    const ty = (y - e.last.y) / len;
    const tz = (z - e.last.z) / len;
    const base = seg * 4 * VS;
    for (let v = 0; v < 4; v++) {
      const end = v >= 2;
      const o = base + v * VS;
      d[o] = end ? x : e.last.x;
      d[o + 1] = end ? y : e.last.y;
      d[o + 2] = end ? z : e.last.z;
      d[o + 3] = tx;
      d[o + 4] = ty;
      d[o + 5] = tz;
      d[o + 6] = end ? time : e.lastTime;
      d[o + 7] = s.life;
      d[o + 8] = v % 2 === 0 ? -1 : 1;
      d[o + 9] = end ? e.dist + len : e.dist;
      d[o + 10] = s.width;
      d[o + 11] = s.growth;
      d[o + 12] = s.alpha * e.alphaMul;
      d[o + 13] = s.formDelay;
      d[o + 14] = s.r;
      d[o + 15] = s.g;
      d[o + 16] = s.b;
    }
  }

  update(time: number, wind: Vector3, light: number, px = 0.002): void {
    const u = this.material.uniforms;
    u.uTime.value = time;
    u.uPx.value = px;
    (u.uWind.value as Vector3).copy(wind);
    (u.uLight.value as Vector3).setScalar(light);
    const per = 4 * VS;
    if (!this.headDirty && this.dirtyCount === 0) return;
    this.buffer.clearUpdateRanges();
    if (this.headDirty) this.buffer.addUpdateRange(0, this.headSlots * per);
    if (this.dirtyCount > 0) {
      const start = this.headSlots + this.dirtyStart;
      const end = this.dirtyStart + this.dirtyCount;
      if (end <= this.ringCapacity) this.buffer.addUpdateRange(start * per, this.dirtyCount * per);
      else {
        this.buffer.addUpdateRange(start * per, (this.ringCapacity - this.dirtyStart) * per);
        this.buffer.addUpdateRange(this.headSlots * per, (end - this.ringCapacity) * per);
      }
    }
    this.buffer.needsUpdate = true;
    this.headDirty = false;
    this.dirtyCount = 0;
  }

  dispose(): void {
    this.geo.dispose();
    this.material.dispose();
    this.mesh.removeFromParent();
  }
}
