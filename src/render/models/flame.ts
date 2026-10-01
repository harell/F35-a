/**
 * Afterburner / rocket-motor flame: layered additive cones with a view-dependent core, scrolling noise
 * turbulence and shock diamonds, a hot nozzle interior (liner + flameholder rings) and a camera-facing
 * glow sprite. Each flame instance owns a (cheap) material clone so every aircraft has its own
 * uniforms; the shader programs are shared.
 *
 * Exposure: the shaders write straight to the framebuffer (additive, not tone-mapped), so by day the
 * plume uses warm, low-intensity colours that leave headroom over the sky and only the shock diamonds
 * reach white. At night the palette switches to a bright, saturated orange.
 */
import {
  AdditiveBlending,
  BufferGeometry,
  CylinderGeometry,
  DataTexture,
  DoubleSide,
  Group,
  LatheGeometry,
  LinearFilter,
  LinearMipmapLinearFilter,
  Mesh,
  PlaneGeometry,
  RepeatWrapping,
  RGBAFormat,
  ShaderMaterial,
  Vector2,
  Vector3,
  type Texture,
} from 'three';

/* ───────────── plume (outer + core cones) ───────────── */

const VERT = /* glsl */ `
varying float vAlong;
varying float vFacing;
varying float vAxial;
varying float vAround;
void main() {
  vAlong = position.z;                       // 0 at the nozzle → 1 at the tip
  vAround = uv.x;                            // 0..1 around the cone (seam-safe with a tiling texture)
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vec3 v = normalize(-mv.xyz);
  vec3 n = normalize(normalMatrix * normal);
  vFacing = abs(dot(n, v));
  // how end-on the plume is seen (1 = looking straight up/down its axis, e.g. chase view)
  vAxial = abs(dot(normalize((modelViewMatrix * vec4(0.0, 0.0, 1.0, 0.0)).xyz), v));
  gl_Position = projectionMatrix * mv;
}`;

const FRAG = /* glsl */ `
uniform float uTime;
uniform float uIntensity;   // 0..1+ overall brightness
uniform float uDiamonds;    // 0..1 shock-diamond strength
uniform float uDiamondCount;
uniform vec3 uColorA;       // near nozzle
uniform vec3 uColorB;       // tail
uniform float uSeed;
uniform float uLength;      // current plume length (m): noise is laid out in metres
uniform float uFlow;        // turbulence scroll speed (m/s, aft)
uniform float uTurb;        // 0..1 turbulence strength
uniform sampler2D uNoise;   // tiling noise: R = coarse octave, G = fine octave
varying float vAlong;
varying float vFacing;
varying float vAxial;
varying float vAround;
void main() {
  float a = clamp(vAlong, 0.0, 1.0);
  // soft silhouette: fade where the surface turns away from the viewer, but not when seen end-on
  float soft = mix(smoothstep(0.0, 0.6, vFacing), 1.0, vAxial * vAxial);
  float body = (0.25 + 0.75 * vFacing) * soft;
  // two octaves of noise scrolling aft at flow speed
  float s = vAlong * uLength;
  float n1 = texture2D(uNoise, vec2(vAround + uSeed * 0.13, (s - uTime * uFlow) * 0.16 + uSeed)).r;
  float n2 = texture2D(uNoise, vec2(vAround * 2.0 - uSeed * 0.07, (s - uTime * uFlow * 1.6) * 0.45)).g;
  float turb = n1 * 0.65 + n2 * 0.35;                       // ~0..1, mean 0.5
  float tk = uTurb * (0.25 + 0.75 * a);                     // calm at the lip, churning at the tail
  float flick = 1.0 + (turb - 0.5) * 1.3 * tk;
  // tail eaten away by the noise instead of ending as a cut cone
  float fade = pow(1.0 - a, 1.1) * smoothstep(0.0, 0.04, a);
  fade *= 1.0 - smoothstep(0.3, 0.95, a + (turb - 0.5) * 0.55 * a * uTurb);
  float d = 0.5 + 0.5 * cos(a * 6.2831853 * uDiamondCount);
  float diamonds = mix(1.0, 0.4 + 1.5 * pow(d, 6.0), uDiamonds * (1.0 - a * 0.75));
  vec3 col = mix(uColorA, uColorB, smoothstep(0.0, 0.85, a));
  float k = body * fade * diamonds * flick * uIntensity;
  gl_FragColor = vec4(col * k, 1.0);
}`;

/* ───────────── hot nozzle interior (flameholder disc + liner wall) ───────────── */

const HOT_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

/** uv.y along the lathe profile: 0..HOLDER_V is the flameholder disc (centre → rim), above it the liner. */
const HOT_FRAG = /* glsl */ `
uniform float uIntensity;
uniform vec3 uColor;
uniform float uHolderV;
varying vec2 vUv;
void main() {
  float v = vUv.y;
  float k;
  if (v < uHolderV) {
    // flameholder: two hot concentric rings + radial spokes on a dimmer face
    float r = v / uHolderV;
    float rings = max(1.0 - abs(r - 0.45) * 9.0, 1.0 - abs(r - 0.8) * 9.0);
    float spokes = pow(0.5 + 0.5 * cos(vUv.x * 6.2831853 * 10.0), 6.0) * smoothstep(0.15, 0.3, r) * (1.0 - smoothstep(0.75, 0.85, r));
    k = 0.55 + 0.5 * clamp(max(rings, spokes * 0.7), 0.0, 1.0);
  } else {
    // liner: hottest deep inside, cooling toward the exit, with faint cooling-hole hoops
    float w = (v - uHolderV) / (1.0 - uHolderV);
    float hoops = 0.85 + 0.15 * cos(w * 6.2831853 * 4.0);
    k = mix(0.9, 0.18, w) * hoops;
  }
  gl_FragColor = vec4(uColor * k * uIntensity, 1.0);
}`;

/* ───────────── camera-facing glow sprite ───────────── */

const GLOW_VERT = /* glsl */ `
uniform float uSize;
uniform float uLift;        // pulled toward the camera so the airframe doesn't clip it
varying vec2 vUv;
void main() {
  vUv = uv;
  vec4 c = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  c.xyz += normalize(-c.xyz) * uLift;
  c.xy += position.xy * uSize;
  gl_Position = projectionMatrix * c;
}`;

const GLOW_FRAG = /* glsl */ `
uniform float uIntensity;
uniform vec3 uColorA;
uniform vec3 uColorB;
varying vec2 vUv;
void main() {
  float r = length(vUv - 0.5) * 2.0;
  float core = exp(-r * r * 9.0);
  float halo = pow(max(0.0, 1.0 - r), 2.4);
  float k = (core * 0.7 + halo * 0.45) * uIntensity;
  gl_FragColor = vec4(mix(uColorA, uColorB, smoothstep(0.0, 0.8, r)) * k, 1.0);
}`;

/* ───────────── shared resources ───────────── */

const HOLDER_V = 0.42;
/** Interior extent relative to the Flame origin (which sits ~0.35 m inside the nozzle exit). */
const INNER_BACK = -0.33;
const INNER_FRONT = 0.18;

let coneGeo: BufferGeometry | null = null;
let quadGeo: BufferGeometry | null = null;
let innerGeo: BufferGeometry | null = null;
let noiseTex: Texture | null = null;
let baseFlame: ShaderMaterial | null = null;
let baseGlow: ShaderMaterial | null = null;
let baseHot: ShaderMaterial | null = null;

/** Unit cone: radius 1 at z=0 narrowing to 0.25 at z=1 (extends aft along +Z). */
export function flameCone(): BufferGeometry {
  if (coneGeo) return coneGeo;
  const g = new CylinderGeometry(0.25, 1, 1, 14, 6, true);
  g.rotateX(Math.PI / 2); // +Y → +Z ; bottom (r=1) at z=-0.5
  g.translate(0, 0, 0.5);
  coneGeo = g;
  return g;
}

function quad(): BufferGeometry {
  if (quadGeo) return quadGeo;
  quadGeo = new PlaneGeometry(1, 1);
  return quadGeo;
}

/**
 * Unit nozzle interior (radius 1): flameholder disc at z=0 facing aft, then a liner tube to z=1.
 * uv.y runs along the profile so the shader can tell the two apart (see HOLDER_V).
 */
function interior(): BufferGeometry {
  if (innerGeo) return innerGeo;
  // profile in (r, along); lathe revolves around Y, then Y → Z
  const pts = [new Vector2(0, 0), new Vector2(0.5, 0), new Vector2(1, 0), new Vector2(1, 0.5), new Vector2(1, 1)];
  const g = new LatheGeometry(pts, 20);
  // LatheGeometry spaces uv.y by point index; remap so the disc spans 0..HOLDER_V
  const uv = g.attributes.uv;
  const pos = g.attributes.position;
  for (let i = 0; i < uv.count; i++) {
    const y = pos.getY(i);
    const r = Math.hypot(pos.getX(i), pos.getZ(i));
    uv.setY(i, y < 1e-4 ? r * HOLDER_V : HOLDER_V + y * (1 - HOLDER_V));
  }
  g.rotateX(Math.PI / 2);
  innerGeo = g;
  return g;
}

/**
 * Small tiling 2-octave value-noise texture (R = 8-cell lattice, G = 16-cell lattice), built from a
 * byte array so it costs no canvas and also works in node tests.
 */
export function flameNoiseTexture(): Texture {
  if (noiseTex) return noiseTex;
  const S = 64;
  const data = new Uint8Array(S * S * 4);
  const lattice = (n: number, seed: number) => {
    let x = seed;
    const g = new Float32Array(n * n).map(() => {
      x = (x * 1664525 + 1013904223) >>> 0;
      return x / 4294967296;
    });
    const at = (i: number, j: number) => g[(j % n) * n + (i % n)];
    const sm = (t: number) => t * t * (3 - 2 * t);
    return (u: number, v: number) => {
      const fx = u * n;
      const fy = v * n;
      const i = Math.floor(fx);
      const j = Math.floor(fy);
      const tx = sm(fx - i);
      const ty = sm(fy - j);
      const a = at(i, j) + (at(i + 1, j) - at(i, j)) * tx;
      const b = at(i, j + 1) + (at(i + 1, j + 1) - at(i, j + 1)) * tx;
      return a + (b - a) * ty;
    };
  };
  const coarse = lattice(8, 1234);
  const fine = lattice(16, 98765);
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const o = (y * S + x) * 4;
      data[o] = Math.round(coarse(x / S, y / S) * 255);
      data[o + 1] = Math.round(fine(x / S, y / S) * 255);
      data[o + 2] = 0;
      data[o + 3] = 255;
    }
  const t = new DataTexture(data, S, S, RGBAFormat);
  t.wrapS = t.wrapT = RepeatWrapping;
  t.magFilter = LinearFilter;
  t.minFilter = LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  noiseTex = t;
  return t;
}

function flameBase(): ShaderMaterial {
  if (baseFlame) return baseFlame;
  baseFlame = new ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms: {
      uTime: { value: 0 },
      uIntensity: { value: 0 },
      uDiamonds: { value: 0 },
      uDiamondCount: { value: 5 },
      uColorA: { value: new Vector3(1, 0.85, 0.6) },
      uColorB: { value: new Vector3(1, 0.4, 0.1) },
      uSeed: { value: 0 },
      uLength: { value: 1 },
      uFlow: { value: 14 },
      uTurb: { value: 1 },
      uNoise: { value: null },
    },
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    side: DoubleSide,
    toneMapped: false,
  });
  return baseFlame;
}

function glowBase(): ShaderMaterial {
  if (baseGlow) return baseGlow;
  baseGlow = new ShaderMaterial({
    vertexShader: GLOW_VERT,
    fragmentShader: GLOW_FRAG,
    uniforms: {
      uIntensity: { value: 0 },
      uSize: { value: 1 },
      uLift: { value: 0 },
      uColorA: { value: new Vector3(1, 0.55, 0.25) },
      uColorB: { value: new Vector3(0.6, 0.1, 0.02) },
    },
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    toneMapped: false,
  });
  return baseGlow;
}

function hotBase(): ShaderMaterial {
  if (baseHot) return baseHot;
  baseHot = new ShaderMaterial({
    vertexShader: HOT_VERT,
    fragmentShader: HOT_FRAG,
    uniforms: {
      uIntensity: { value: 0 },
      uColor: { value: new Vector3(1, 0.45, 0.12) },
      uHolderV: { value: HOLDER_V },
    },
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    // seen from inside through the nozzle exit; the airframe's nozzle shell hides the outside
    side: DoubleSide,
    toneMapped: false,
  });
  return baseHot;
}

/* ───────────── tunables ───────────── */

type Rgb = [number, number, number];
interface PlumePalette {
  outerA: Rgb;
  outerB: Rgb;
  coreA: Rgb;
  coreB: Rgb;
  /** Intensity scale for outer / core at full AB. */
  outer: number;
  core: number;
}

/** Day: pale and translucent (headroom over the sky so the diamonds read). Night: bright orange. */
export const AB_PALETTE: { day: PlumePalette; night: PlumePalette } = {
  day: {
    outerA: [0.62, 0.42, 0.24],
    outerB: [0.42, 0.2, 0.08],
    coreA: [0.75, 0.62, 0.42],
    coreB: [0.6, 0.36, 0.16],
    outer: 0.38,
    core: 0.55,
  },
  night: {
    outerA: [1.0, 0.5, 0.16],
    outerB: [0.85, 0.2, 0.04],
    coreA: [1.0, 0.82, 0.5],
    coreB: [1.0, 0.45, 0.12],
    outer: 1.35,
    core: 1.6,
  },
};

/** Light-off transient: brightness flash + brief length overshoot (fractions at the peak). */
export const AB_POP = { tau: 0.05, flash: 0.5, overshoot: 0.22 };

/** Light-off envelope: 0 at t=0, peaks at 1 after tau, mostly gone by ~4·tau (≈ 200 ms). */
export function popEnvelope(t: number, tau = AB_POP.tau): number {
  if (!(t >= 0) || t > tau * 8) return 0;
  const x = t / tau;
  return x * Math.exp(1 - x);
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const set3 = (out: Vector3, c: Rgb) => out.set(c[0], c[1], c[2]);

export type FlameStyle = 'afterburner' | 'motor';

/**
 * One engine's flame set: outer plume + inner core (with diamonds) + hot nozzle interior + glow sprite.
 * Parent it slightly inside the nozzle exit (flame extends along +Z). Call update() every frame.
 */
export class Flame {
  readonly group = new Group();
  private outer: Mesh;
  private core: Mesh;
  private glow: Mesh;
  private inner: Mesh | null = null;
  private mOuter: ShaderMaterial;
  private mCore: ShaderMaterial;
  private mGlow: ShaderMaterial;
  private mHot: ShaderMaterial | null = null;
  /** Scales the dry-power nozzle glow (low by day, higher at night). */
  dryGlow = 1;
  /** Night look (saturated orange, brighter interior). */
  night = false;
  private prevAb = Number.NaN;
  private lightT = -1e9;
  private cutting = false;

  constructor(
    private readonly radius: number,
    private readonly maxLength: number,
    private readonly style: FlameStyle = 'afterburner',
    seed = Math.random() * 100,
  ) {
    const noise = flameNoiseTexture();
    this.mOuter = flameBase().clone();
    this.mCore = flameBase().clone();
    this.mGlow = glowBase().clone();
    // clone() copies textures; point every instance back at the one shared noise texture
    this.mOuter.uniforms.uNoise.value = this.mCore.uniforms.uNoise.value = noise;
    this.mOuter.uniforms.uSeed.value = seed;
    this.mCore.uniforms.uSeed.value = seed + 17;
    if (style === 'afterburner') {
      this.mCore.uniforms.uDiamondCount.value = 4.5;
      this.mOuter.uniforms.uFlow.value = 12;
      this.mCore.uniforms.uFlow.value = 16;
      this.mCore.uniforms.uTurb.value = 0.7;
    } else {
      this.mOuter.uniforms.uColorA.value.set(1.0, 0.75, 0.4);
      this.mOuter.uniforms.uColorB.value.set(1.0, 0.35, 0.1);
      this.mCore.uniforms.uColorA.value.set(1.0, 1.0, 0.92);
      this.mCore.uniforms.uColorB.value.set(1.0, 0.75, 0.4);
      this.mCore.uniforms.uDiamondCount.value = 3;
      this.mOuter.uniforms.uFlow.value = this.mCore.uniforms.uFlow.value = 30;
    }
    this.outer = new Mesh(flameCone(), this.mOuter);
    this.core = new Mesh(flameCone(), this.mCore);
    this.glow = new Mesh(quad(), this.mGlow);
    this.outer.name = 'flame:outer';
    this.core.name = 'flame:core';
    this.glow.name = 'flame:glow';
    this.outer.frustumCulled = this.core.frustumCulled = this.glow.frustumCulled = false;
    this.outer.renderOrder = this.core.renderOrder = 5;
    this.glow.renderOrder = 6;
    if (style === 'afterburner') {
      this.glow.position.z = 0.4; // about at the nozzle exit
      this.mGlow.uniforms.uLift.value = radius * 1.4;
      this.mHot = hotBase().clone();
      this.inner = new Mesh(interior(), this.mHot);
      this.inner.name = 'flame:interior';
      this.inner.frustumCulled = false;
      this.inner.renderOrder = 4;
      this.inner.position.z = INNER_BACK;
      this.inner.scale.set(radius * 0.9, radius * 0.9, INNER_FRONT - INNER_BACK);
      this.group.add(this.inner);
    } else {
      this.glow.position.z = -0.02;
      this.mGlow.uniforms.uLift.value = radius * 2;
    }
    this.group.add(this.glow, this.outer, this.core);
  }

  /**
   * @param ab afterburner 0..1
   * @param rpm engine 0..1.05 (dry glow)
   */
  update(time: number, ab: number, rpm: number, visible = true, far = false): void {
    const r = this.radius;
    const dry = clamp01((rpm - 0.6) / 0.4);
    const u = this.mOuter.uniforms;
    const c = this.mCore.uniforms;
    const g = this.mGlow.uniforms;
    u.uTime.value = c.uTime.value = time;
    if (this.style === 'motor') {
      const L = this.maxLength * (0.85 + 0.15 * Math.sin(time * 37));
      this.outer.scale.set(r * 1.25, r * 1.25, L);
      this.core.scale.set(r * 0.8, r * 0.8, L * 0.55);
      u.uLength.value = L;
      c.uLength.value = L * 0.55;
      u.uIntensity.value = 0.9;
      c.uIntensity.value = 1.4;
      c.uDiamonds.value = 0.5;
      g.uIntensity.value = visible ? 1.2 : 0;
      g.uSize.value = r * 7;
      this.outer.visible = this.core.visible = this.glow.visible = visible;
      return;
    }

    // afterburner transients: light-off pop on the rising edge, fast retract on cut
    const abK = clamp01(ab);
    const prev = this.prevAb;
    if (prev === prev) {
      if (abK > 0.02 && prev <= 0.02) this.lightT = time;
      if (abK > prev + 1e-4) this.cutting = false;
      else if (abK < prev - 1e-4) this.cutting = true;
    }
    if (abK <= 0.02) this.cutting = false;
    this.prevAb = abK;
    const pop = abK > 0.02 ? popEnvelope(time - this.lightT) : 0;
    const abL = this.cutting ? abK * abK : abK;

    // hot nozzle interior: dull red at MIL, orange in AB, stronger at night
    const night = this.night ? 1 : 0;
    const inner = this.inner!;
    const hot = this.mHot!.uniforms;
    const hotK = dry * (0.22 + 0.4 * night) + abK * (0.75 + 0.35 * night) * (1 + pop * AB_POP.flash);
    inner.visible = visible && !far && hotK > 0.01;
    hot.uIntensity.value = hotK;
    const t = clamp01(abK * 1.5);
    hot.uColor.value.set(0.55 + 0.45 * t, 0.07 + 0.38 * t, 0.02 + 0.1 * t);

    // glow sprite: billboard sized by AB level (cheap stand-in for bloom; visible side-on)
    const dryK = (0.05 + 0.18 * dry) * this.dryGlow;
    const abGlow = abK * (0.45 + 0.75 * night) * (1 + pop * AB_POP.flash * 1.5);
    g.uIntensity.value = visible ? dryK + abGlow : 0;
    g.uSize.value = r * (2.2 + (3.2 + 1.6 * night) * abK + 1.5 * pop);
    if (night || abK > 0.02) g.uColorA.value.set(1, 0.6 + 0.15 * (1 - night), 0.3 + 0.15 * (1 - night));
    else g.uColorA.value.set(1, 0.4, 0.15);
    this.glow.visible = visible && !far;

    // plume: long with diamonds in AB; dry power → short faint heat plume
    const show = visible && (abK > 0.02 || (dry > 0.5 && !far));
    this.outer.visible = this.core.visible = show;
    if (!show) return;
    const P = night ? AB_PALETTE.night : AB_PALETTE.day;
    set3(u.uColorA.value, P.outerA);
    set3(u.uColorB.value, P.outerB);
    set3(c.uColorA.value, P.coreA);
    set3(c.uColorB.value, P.coreB);
    const L = this.maxLength * ((0.12 + 0.88 * abL) * (0.97 + 0.03 * Math.sin(time * 23)) + AB_POP.overshoot * pop);
    this.outer.scale.set(r * 0.98, r * 0.98, L);
    this.core.scale.set(r * 0.72, r * 0.72, L * 0.72);
    u.uLength.value = L;
    c.uLength.value = L * 0.72;
    const flash = 1 + AB_POP.flash * pop;
    // minimum visibility: even by day the lit AB never drops below a readable core
    u.uIntensity.value = (0.12 * dry + P.outer * abK) * flash;
    c.uIntensity.value = (0.08 * dry + P.core * Math.max(abK, Math.min(abK * 4, 0.6))) * flash;
    c.uDiamonds.value = abK;
  }

  dispose(): void {
    this.mOuter.dispose();
    this.mCore.dispose();
    this.mGlow.dispose();
    this.mHot?.dispose();
  }
}

export function disposeFlameShared(): void {
  coneGeo?.dispose();
  quadGeo?.dispose();
  innerGeo?.dispose();
  noiseTex?.dispose();
  baseFlame?.dispose();
  baseGlow?.dispose();
  baseHot?.dispose();
  coneGeo = quadGeo = innerGeo = null;
  noiseTex = null;
  baseFlame = baseGlow = baseHot = null;
}
