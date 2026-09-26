/**
 * Afterburner / rocket-motor flame: layered additive cones with a view-dependent core, flicker and
 * shock diamonds, plus a hot nozzle "glow disc". Each flame instance owns a (cheap) material clone
 * so every aircraft has its own uniforms; the shader program is shared.
 */
import {
  AdditiveBlending,
  BufferGeometry,
  CircleGeometry,
  CylinderGeometry,
  DoubleSide,
  Group,
  Mesh,
  ShaderMaterial,
  Vector3,
} from 'three';

const VERT = /* glsl */ `
varying float vAlong;
varying float vFacing;
void main() {
  vAlong = position.z;                       // 0 at the nozzle → 1 at the tip
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vec3 n = normalize(normalMatrix * normal);
  vFacing = abs(dot(n, normalize(-mv.xyz)));
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
varying float vAlong;
varying float vFacing;
void main() {
  float a = clamp(vAlong, 0.0, 1.0);
  // bright where the plume faces the viewer, but never vanish when seen end-on (chase view)
  float body = 0.3 + 0.7 * pow(vFacing, 1.6);
  float fade = pow(1.0 - a, 1.3) * smoothstep(0.0, 0.04, a);
  float d = 0.5 + 0.5 * cos(a * 6.2831853 * uDiamondCount);
  float diamonds = mix(1.0, 0.45 + 1.1 * pow(d, 5.0), uDiamonds * (1.0 - a * 0.7));
  float flick = 0.86 + 0.14 * sin(uTime * 47.0 + a * 23.0 + uSeed) * sin(uTime * 31.0 + uSeed * 3.1);
  vec3 col = mix(uColorA, uColorB, smoothstep(0.0, 0.85, a));
  float k = body * fade * diamonds * flick * uIntensity;
  gl_FragColor = vec4(col * k, 1.0);
}`;

const GLOW_FRAG = /* glsl */ `
uniform float uIntensity;
uniform vec3 uColorA;
uniform vec3 uColorB;
varying float vAlong;
varying float vFacing;
varying vec2 vUv;
void main() {
  float r = length(vUv - 0.5) * 2.0;
  float k = (1.0 - smoothstep(0.2, 1.0, r)) * uIntensity;
  gl_FragColor = vec4(mix(uColorA, uColorB, r) * k, 1.0);
}`;

const GLOW_VERT = /* glsl */ `
varying vec2 vUv;
varying float vAlong;
varying float vFacing;
void main() {
  vUv = uv; vAlong = 0.0; vFacing = 1.0;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

let coneGeo: BufferGeometry | null = null;
let discGeo: BufferGeometry | null = null;
let baseFlame: ShaderMaterial | null = null;
let baseGlow: ShaderMaterial | null = null;

/** Unit cone: radius 1 at z=0 narrowing to 0.25 at z=1 (extends aft along +Z). */
export function flameCone(): BufferGeometry {
  if (coneGeo) return coneGeo;
  const g = new CylinderGeometry(0.25, 1, 1, 14, 6, true);
  g.rotateX(Math.PI / 2); // +Y → +Z ; bottom (r=1) at z=-0.5
  g.translate(0, 0, 0.5);
  coneGeo = g;
  return g;
}

function disc(): BufferGeometry {
  if (discGeo) return discGeo;
  discGeo = new CircleGeometry(1, 16); // faces +Z (aft)
  return discGeo;
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

export type FlameStyle = 'afterburner' | 'motor';

/**
 * One engine's flame set: outer plume + inner core (with diamonds) + nozzle glow disc.
 * Parent it at the nozzle exit (flame extends along +Z). Call update() every frame.
 */
export class Flame {
  readonly group = new Group();
  private outer: Mesh;
  private core: Mesh;
  private glow: Mesh;
  private mOuter: ShaderMaterial;
  private mCore: ShaderMaterial;
  private mGlow: ShaderMaterial;
  /** Scales the dry-power nozzle glow (low by day, higher at night). */
  dryGlow = 1;

  constructor(
    private readonly radius: number,
    private readonly maxLength: number,
    private readonly style: FlameStyle = 'afterburner',
    seed = Math.random() * 100,
  ) {
    this.mOuter = flameBase().clone();
    this.mCore = flameBase().clone();
    this.mGlow = glowBase().clone();
    this.mOuter.uniforms.uSeed.value = seed;
    this.mCore.uniforms.uSeed.value = seed + 17;
    if (style === 'afterburner') {
      this.mOuter.uniforms.uColorA.value.set(1.0, 0.62, 0.3);
      this.mOuter.uniforms.uColorB.value.set(0.85, 0.22, 0.06);
      this.mCore.uniforms.uColorA.value.set(1.0, 0.95, 0.82);
      this.mCore.uniforms.uColorB.value.set(1.0, 0.55, 0.25);
    } else {
      this.mOuter.uniforms.uColorA.value.set(1.0, 0.75, 0.4);
      this.mOuter.uniforms.uColorB.value.set(1.0, 0.35, 0.1);
      this.mCore.uniforms.uColorA.value.set(1.0, 1.0, 0.92);
      this.mCore.uniforms.uColorB.value.set(1.0, 0.75, 0.4);
      this.mCore.uniforms.uDiamondCount.value = 3;
    }
    this.outer = new Mesh(flameCone(), this.mOuter);
    this.core = new Mesh(flameCone(), this.mCore);
    this.glow = new Mesh(disc(), this.mGlow);
    this.outer.frustumCulled = this.core.frustumCulled = this.glow.frustumCulled = false;
    this.outer.renderOrder = this.core.renderOrder = 5;
    this.glow.renderOrder = 4;
    this.glow.scale.setScalar(radius * 0.92);
    this.glow.position.z = -0.08;
    this.group.add(this.glow, this.outer, this.core);
  }

  /**
   * @param ab afterburner 0..1
   * @param rpm engine 0..1.05 (dry glow)
   */
  update(time: number, ab: number, rpm: number, visible = true, far = false): void {
    const r = this.radius;
    const dry = Math.max(0, Math.min(1, (rpm - 0.6) / 0.4));
    const glowK = this.style === 'motor' ? 1.2 : (0.06 + 0.22 * dry) * this.dryGlow + 0.7 * ab;
    this.mGlow.uniforms.uIntensity.value = visible ? glowK : 0;
    this.glow.visible = visible && !far;
    const u = this.mOuter.uniforms;
    const c = this.mCore.uniforms;
    u.uTime.value = c.uTime.value = time;
    if (this.style === 'motor') {
      const L = this.maxLength * (0.85 + 0.15 * Math.sin(time * 37));
      this.outer.scale.set(r * 1.25, r * 1.25, L);
      this.core.scale.set(r * 0.8, r * 0.8, L * 0.55);
      u.uIntensity.value = 0.9;
      c.uIntensity.value = 1.4;
      c.uDiamonds.value = 0.5;
      this.outer.visible = this.core.visible = visible;
      return;
    }
    // afterburner: long plume with diamonds; dry power → short faint heat plume
    const abK = Math.max(0, Math.min(1, ab));
    const show = visible && (abK > 0.02 || (dry > 0.5 && !far));
    this.outer.visible = this.core.visible = show;
    if (!show) return;
    const L = this.maxLength * (0.12 + 0.88 * abK) * (0.94 + 0.06 * Math.sin(time * 23));
    this.outer.scale.set(r * 0.98, r * 0.98, L);
    this.core.scale.set(r * 0.72, r * 0.72, L * 0.72);
    u.uIntensity.value = 0.12 * dry + 0.95 * abK;
    c.uIntensity.value = 0.08 * dry + 1.25 * abK;
    c.uDiamonds.value = abK;
    c.uDiamondCount.value = 4.5;
  }

  dispose(): void {
    this.mOuter.dispose();
    this.mCore.dispose();
    this.mGlow.dispose();
  }
}

export function disposeFlameShared(): void {
  coneGeo?.dispose();
  discGeo?.dispose();
  baseFlame?.dispose();
  baseGlow?.dispose();
  coneGeo = discGeo = null;
  baseFlame = baseGlow = null;
}
