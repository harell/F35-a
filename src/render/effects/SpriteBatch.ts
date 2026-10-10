/**
 * SpriteBatch: one instanced draw call of camera-facing additive glow sprites, rewritten every frame
 * (nav lights, strobes, motor glows, flare cores, muzzle flashes, tracers). Each sprite is either a
 * round billboard or a streak (quad stretched along a world-space direction). A minimum on-screen
 * size keeps small lights visible at long range. Allocation-free: fixed typed arrays.
 */
import {
  AdditiveBlending,
  BufferAttribute,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  ShaderMaterial,
  UniformsLib,
  UniformsUtils,
  type Texture,
} from 'three';
import { glowTexture } from './textures';

const VERT = /* glsl */ `
attribute vec3 iPos;
attribute vec4 iDir;    // xyz = streak vector (world), w = unused
attribute vec4 iColor;  // rgb * intensity, a = alpha
attribute vec2 iSize;   // world width, min pixel size
uniform float uPx;      // world size of one CSS pixel at unit distance
varying vec2 vUv;
varying vec4 vColor;
#include <fog_pars_vertex>
void main() {
  vUv = position.xy + 0.5;
  vColor = iColor;
  vec4 mv = viewMatrix * vec4(iPos, 1.0);
  float depth = max(0.1, -mv.z);
  float w = max(iSize.x, iSize.y * depth * uPx);
  // fade sprites that are shrunk below their true size (keeps far lights from getting too loud)
  vColor.a *= min(1.0, 0.35 + iSize.x / max(1e-4, w) * 0.65 + 0.0);
  float len = length(iDir.xyz);
  if (len > 1e-4) {
    vec4 mv2 = viewMatrix * vec4(iPos + iDir.xyz, 1.0);
    vec2 d = mv2.xy / max(0.1, -mv2.z) - mv.xy / depth;
    float l2 = length(d);
    vec2 ax = l2 > 1e-6 ? d / l2 : vec2(1.0, 0.0);
    vec2 pr = vec2(-ax.y, ax.x);
    // interpolate along the streak in view space, then offset sideways by the width
    vec3 p = mix(mv.xyz, mv2.xyz, position.y + 0.5);
    float pd = max(0.1, -p.z);
    float ww = max(iSize.x, iSize.y * pd * uPx);
    p.xy += pr * position.x * ww + ax * position.y * ww * 0.5;
    mv = vec4(p, 1.0);
  } else {
    mv.xy += position.xy * w;
  }
  gl_Position = projectionMatrix * mv;
  #ifdef USE_FOG
    vFogDepth = -mv.z;
  #endif
}`;

const FRAG = /* glsl */ `
uniform sampler2D uMap;
uniform float uGain;
varying vec2 vUv;
varying vec4 vColor;
#include <fog_pars_fragment>
void main() {
  float a = texture2D(uMap, vUv).a * vColor.a;
  vec3 c = vColor.rgb * a * uGain;
  #ifdef USE_FOG
    #ifdef FOG_EXP2
      float fogF = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
    #else
      float fogF = smoothstep(fogNear, fogFar, vFogDepth);
    #endif
    c *= 1.0 - fogF * 0.85;
  #endif
  gl_FragColor = vec4(c, 1.0);
}`;

export class SpriteBatch {
  readonly mesh: Mesh;
  private readonly pos: Float32Array;
  private readonly dir: Float32Array;
  private readonly col: Float32Array;
  private readonly size: Float32Array;
  private readonly aPos: InstancedBufferAttribute;
  private readonly aDir: InstancedBufferAttribute;
  private readonly aCol: InstancedBufferAttribute;
  private readonly aSize: InstancedBufferAttribute;
  private readonly geo: InstancedBufferGeometry;
  readonly material: ShaderMaterial;
  count = 0;

  constructor(
    readonly capacity: number,
    map: Texture | null = glowTexture(),
    renderOrder = 12,
    /** Brightness uniform: the effects' batch shares GpuParticles glowGain (dimmed in the PiP, #282 R31-10). */
    gain: { value: number } = { value: 1 },
  ) {
    const g = new InstancedBufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]), 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    this.pos = new Float32Array(capacity * 3);
    this.dir = new Float32Array(capacity * 4);
    this.col = new Float32Array(capacity * 4);
    this.size = new Float32Array(capacity * 2);
    this.aPos = new InstancedBufferAttribute(this.pos, 3).setUsage(DynamicDrawUsage) as InstancedBufferAttribute;
    this.aDir = new InstancedBufferAttribute(this.dir, 4).setUsage(DynamicDrawUsage) as InstancedBufferAttribute;
    this.aCol = new InstancedBufferAttribute(this.col, 4).setUsage(DynamicDrawUsage) as InstancedBufferAttribute;
    this.aSize = new InstancedBufferAttribute(this.size, 2).setUsage(DynamicDrawUsage) as InstancedBufferAttribute;
    g.setAttribute('iPos', this.aPos);
    g.setAttribute('iDir', this.aDir);
    g.setAttribute('iColor', this.aCol);
    g.setAttribute('iSize', this.aSize);
    g.instanceCount = 0;
    this.geo = g;
    this.material = new ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: UniformsUtils.merge([UniformsLib.fog, { uMap: { value: null }, uPx: { value: 0.002 } }]),
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      fog: true,
      toneMapped: false,
    });
    this.material.uniforms.uMap.value = map;
    this.material.uniforms.uGain = gain;
    this.mesh = new Mesh(g, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = renderOrder;
    this.mesh.name = 'sprites';
  }

  /** Start a new frame (call before add()). `px` = world size of one CSS px at 1 m distance. */
  begin(px: number): void {
    this.count = 0;
    this.material.uniforms.uPx.value = px;
  }

  /**
   * Add a sprite. r,g,b are linear intensities (may exceed 1 for HDR-ish glow), a = alpha.
   * dx,dy,dz: streak vector (0 = round billboard). size = world width (m), minPx = min CSS px width.
   */
  add(x: number, y: number, z: number, r: number, g: number, b: number, a: number, size: number, minPx = 0, dx = 0, dy = 0, dz = 0): boolean {
    if (this.count >= this.capacity) return false;
    const i = this.count++;
    this.pos[i * 3] = x;
    this.pos[i * 3 + 1] = y;
    this.pos[i * 3 + 2] = z;
    this.dir[i * 4] = dx;
    this.dir[i * 4 + 1] = dy;
    this.dir[i * 4 + 2] = dz;
    this.col[i * 4] = r;
    this.col[i * 4 + 1] = g;
    this.col[i * 4 + 2] = b;
    this.col[i * 4 + 3] = a;
    this.size[i * 2] = size;
    this.size[i * 2 + 1] = minPx;
    return true;
  }

  /** Upload this frame's sprites. */
  end(): void {
    const n = this.count;
    this.geo.instanceCount = n;
    if (n === 0) return;
    for (const [attr, k] of [
      [this.aPos, 3],
      [this.aDir, 4],
      [this.aCol, 4],
      [this.aSize, 2],
    ] as const) {
      attr.clearUpdateRanges();
      attr.addUpdateRange(0, n * k);
      attr.needsUpdate = true;
    }
  }

  dispose(): void {
    this.geo.dispose();
    this.material.dispose();
    this.mesh.removeFromParent();
  }
}

/** World size of one CSS pixel at 1 m distance for a perspective camera. */
export function pixelScale(fovDeg: number, screenHeightCss: number): number {
  return (2 * Math.tan((fovDeg * Math.PI) / 360)) / Math.max(1, screenHeightCss);
}
