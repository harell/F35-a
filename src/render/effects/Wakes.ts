/**
 * WakeBatch: the foam wakes of every moving ship and ferry in one instanced draw call (issue #30),
 * rewritten every frame. Each wake is a flat V on the water behind the stern: two Kelvin arms
 * diverging at ~19° (the angle that reads from altitude, whatever the speed), plus the churned
 * propeller wash down the middle, brightest at the stern. Length and brightness grow with speed
 * (wakeLength / wakeIntensity); a hull below ~0.5 m/s leaves none. Alpha-blended white water, not
 * additive light: an additive V read as two glowing cyan beams from above (#276, R32-6). Greyed at
 * night and faded into the fog. Allocation-free: fixed typed arrays.
 */
import {
  BufferAttribute,
  DoubleSide,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  ShaderMaterial,
  UniformsLib,
  UniformsUtils,
} from 'three';

/** tan of the Kelvin wake's half-angle (19.47°). */
const KELVIN = 0.354;
/** Rows along the wake. */
const ROWS = 12;

const VERT = /* glsl */ `
attribute vec3 wk;      // x = × half beam, y = × length (lateral), z = 0..1 along the wake
attribute float shade;  // brightness profile
attribute vec4 iPose;   // stern x, z, heading (rad, clockwise from north), intensity
attribute vec2 iShape;  // half beam, length (m)
varying float vShade;
varying vec2 vWorld;
#include <fog_pars_vertex>
void main() {
  float lx = wk.x * iShape.x + wk.y * iShape.y;
  float lz = wk.z * iShape.y;
  float s = sin(iPose.z);
  float c = cos(iPose.z);
  // starboard (cos h, sin h), aft (-sin h, cos h)
  vec3 w = vec3(iPose.x + c * lx - s * lz, 0.15, iPose.y + s * lx + c * lz);
  vWorld = w.xz;
  vShade = shade * iPose.w;
  vec4 mv = viewMatrix * vec4(w, 1.0);
  gl_Position = projectionMatrix * mv;
  #ifdef USE_FOG
    vFogDepth = -mv.z;
  #endif
}`;

const FRAG = /* glsl */ `
uniform float uDim;
uniform float uTime;
varying float vShade;
varying vec2 vWorld;
#include <fog_pars_fragment>
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}
void main() {
  // broken-up foam rather than a flat decal
  float n = vnoise(vWorld * 0.21 + vec2(uTime * 0.13, 0.0)) * 0.6 + vnoise(vWorld * 0.07 - vec2(0.0, uTime * 0.05)) * 0.4;
  // foam covers the water rather than lighting it; crossing wakes stack their cover, not their light
  float a = clamp(vShade * (0.45 + 0.75 * n), 0.0, 0.85);
  vec3 c = vec3(0.86, 0.89, 0.89) * uDim;
  #ifdef USE_FOG
    #ifdef FOG_EXP2
      float fogF = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
    #else
      float fogF = smoothstep(fogNear, fogFar, vFogDepth);
    #endif
    a *= 1.0 - fogF;
  #endif
  gl_FragColor = vec4(c, a);
}`;

/** Wake length (m) behind a hull of length `hull` m at `speed` m/s: ~250 m for a ship at 11 kn or a ferry at 20 kn. */
export function wakeLength(speed: number, hull: number): number {
  return Math.min(4 * hull + 150, Math.max(0, speed) * (18 + 0.12 * hull));
}

/** Wake brightness 0..1 at `speed` m/s: none below 0.5 m/s, full from ~4.5 m/s. */
export function wakeIntensity(speed: number): number {
  const t = Math.max(0, Math.min(1, (speed - 0.5) / 4));
  return t * t * (3 - 2 * t);
}

/** The V's static geometry: arms and centre wash, in wake units (see VERT). */
function buildGeometry(): InstancedBufferGeometry {
  const wk: number[] = [];
  const shade: number[] = [];
  const idx: number[] = [];
  // a band = `cols` vertices across × ROWS + 1 along; profile(v, j) → [cb, cl, shade]
  const band = (cols: number, profile: (v: number, j: number) => [number, number, number]) => {
    const base = wk.length / 3;
    for (let r = 0; r <= ROWS; r++) {
      const v = Math.pow(r / ROWS, 1.3); // finer near the stern
      for (let j = 0; j < cols; j++) {
        const [cb, cl, s] = profile(v, j);
        wk.push(cb, cl, v);
        shade.push(s);
      }
    }
    for (let r = 0; r < ROWS; r++)
      for (let j = 0; j < cols - 1; j++) {
        const a = base + r * cols + j;
        const b = a + cols;
        idx.push(a, b, a + 1, a + 1, b, b + 1);
      }
  };
  for (const s of [-1, 1]) {
    // Kelvin arm: soft-edged band, its outer edge on the 19.5° line
    band(3, (v, j) => {
      const fade = Math.pow(1 - v, 0.9);
      const width = 0.04 + 0.07 * v;
      if (j === 0) return [s * 1.0, s * KELVIN * v, 0];
      if (j === 1) return [s * 0.8, s * (KELVIN * v - width * 0.4), fade];
      return [s * 0.45, s * (KELVIN * v - width), 0];
    });
  }
  // propeller wash down the middle: brightest at the stern, spreading a little
  band(3, (v, j) => {
    const k = Math.pow(1 - v, 1.6);
    if (j === 1) return [0, 0, k];
    const s = j === 0 ? -1 : 1;
    return [s * 0.9, s * 0.06 * v, 0];
  });
  const g = new InstancedBufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(wk.length), 3)); // unused (bounds only)
  g.setAttribute('wk', new BufferAttribute(new Float32Array(wk), 3));
  g.setAttribute('shade', new BufferAttribute(new Float32Array(shade), 1));
  g.setIndex(idx);
  return g;
}

export class WakeBatch {
  readonly mesh: Mesh;
  private readonly pose: Float32Array;
  private readonly shape: Float32Array;
  private readonly aPose: InstancedBufferAttribute;
  private readonly aShape: InstancedBufferAttribute;
  private readonly geo: InstancedBufferGeometry;
  readonly material: ShaderMaterial;
  count = 0;

  constructor(readonly capacity = 64) {
    const g = buildGeometry();
    this.pose = new Float32Array(capacity * 4);
    this.shape = new Float32Array(capacity * 2);
    this.aPose = new InstancedBufferAttribute(this.pose, 4).setUsage(DynamicDrawUsage) as InstancedBufferAttribute;
    this.aShape = new InstancedBufferAttribute(this.shape, 2).setUsage(DynamicDrawUsage) as InstancedBufferAttribute;
    g.setAttribute('iPose', this.aPose);
    g.setAttribute('iShape', this.aShape);
    g.instanceCount = 0;
    this.geo = g;
    this.material = new ShaderMaterial({
      name: 'Wakes',
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: UniformsUtils.merge([UniformsLib.fog, { uDim: { value: 1 }, uTime: { value: 0 } }]),
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
      fog: true,
      toneMapped: false,
      // keep the flat foam above the water at grazing angles and long range
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -4,
    });
    this.mesh = new Mesh(g, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
    this.mesh.name = 'wakes';
  }

  /** Start a new frame. `dim` scales every wake (night), `time` animates the foam. */
  begin(dim: number, time: number): void {
    this.count = 0;
    this.material.uniforms.uDim.value = dim;
    this.material.uniforms.uTime.value = time;
  }

  /**
   * Adds the wake of a hull centred at (x, z), bow on `heading` (rad, clockwise from north), `length`
   * × `beam` m, making `speed` m/s through the water. Returns false when it leaves none (too slow, or
   * the batch is full).
   */
  addHull(x: number, z: number, heading: number, length: number, beam: number, speed: number): boolean {
    const k = wakeIntensity(speed);
    if (k <= 0.01 || this.count >= this.capacity) return false;
    const i = this.count++;
    // the stern, a little inside the transom
    const back = length / 2 - Math.min(6, length * 0.1);
    this.pose[i * 4] = x - Math.sin(heading) * back;
    this.pose[i * 4 + 1] = z + Math.cos(heading) * back;
    this.pose[i * 4 + 2] = heading;
    this.pose[i * 4 + 3] = k;
    this.shape[i * 2] = beam / 2;
    this.shape[i * 2 + 1] = Math.max(1, wakeLength(speed, length));
    return true;
  }

  /** Upload this frame's wakes. */
  end(): void {
    const n = this.count;
    this.geo.instanceCount = n;
    if (n === 0) return;
    this.aPose.clearUpdateRanges();
    this.aPose.addUpdateRange(0, n * 4);
    this.aPose.needsUpdate = true;
    this.aShape.clearUpdateRanges();
    this.aShape.addUpdateRange(0, n * 2);
    this.aShape.needsUpdate = true;
  }

  dispose(): void {
    this.geo.dispose();
    this.material.dispose();
    this.mesh.removeFromParent();
  }
}
