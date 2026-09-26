/**
 * Night-time far-field lighting:
 *
 *  - `buildCityLightPoints`: a carpet of street / window lights over every built-up area of the
 *    baked colour map (≈ 1–3 lights per 86 m urban texel), drawn as one Points object that fades in
 *    beyond ~1 km (closer in, the terrain shader's lamp grid and lit windows take over), so the city
 *    still reads as a glowing grid of lights from 20+ km.
 *  - `LightReflections`: vertical light streaks on the harbour for bright lights near the water
 *    (waterfront, Harbour Bridge, port floodlights, ships, the Sky Tower and CBD towers): one quad
 *    per light laid on the water plane along the camera's view direction, sized from the view
 *    geometry and a wave-slope spread, broken up by the water's normal map, clipped to the water by
 *    the coast mask. One additive draw call, no per-frame CPU work.
 */
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  Mesh,
  ShaderMaterial,
  type Texture,
} from 'three';
import { ATMOSPHERE_GLSL, type AtmosphereUniforms } from '../sky/atmosphere';
import { COAST_GLSL } from '../terrain/terrainShader';
import { hash2 } from '../terrain/noise';
import type { LightList } from './builders';

/** Minimal colour-map view (RGBA8, alpha ≥ 128 = urban density). */
export interface UrbanMapView {
  data: Uint8Array;
  size: number;
  origin: number;
  extent: number;
}

/**
 * Add far-field city lights to `out` (a LightList drawn with a near-fade material). Returns the
 * number of lights. `maxLights` caps the total (thinned uniformly when exceeded).
 */
export function buildCityLightPoints(map: UrbanMapView, groundAt: (x: number, z: number) => number, seed: number, maxLights: number, out: LightList): number {
  const n = map.size;
  const cell = map.extent / n;
  // First pass: expected count, to thin uniformly to the cap.
  let expected = 0;
  for (let k = 0; k < n * n; k++) {
    const a = map.data[k * 4 + 3];
    if (a >= 140) expected += ((a - 128) / 127) * 2.4;
  }
  const keep = Math.min(1, maxLights / Math.max(1, expected));
  let count = 0;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const a = map.data[(j * n + i) * 4 + 3];
      if (a < 140) continue;
      const u = (a - 128) / 127;
      const lights = u * 2.4 * keep;
      const whole = Math.floor(lights);
      const nLights = whole + (hash2(i, j, seed + 5) < lights - whole ? 1 : 0);
      for (let k = 0; k < nLights; k++) {
        const x = map.origin + (i + hash2(i * 7 + k, j, seed + 11) - 0.5) * cell;
        const z = map.origin + (j + hash2(i, j * 7 + k, seed + 13) - 0.5) * cell;
        const g = groundAt(x, z);
        if (g < 0.5) continue;
        const h = hash2(i + k * 31, j, seed + 17);
        const col = h < 0.55 ? 0xffd9a8 : h < 0.85 ? 0xffab55 : 0xe8f0ff;
        out.add(x, g + 5 + 10 * hash2(j, i + k, seed + 19) * u, z, col, 3.6 + 1.6 * u);
        count++;
      }
    }
  }
  return count;
}

const reflVertex = /* glsl */ `
${ATMOSPHERE_GLSL}
attribute vec3 aLight;
attribute vec4 aColor; // rgb, intensity
attribute vec2 aCorner; // across −1..1, along 0..1
varying vec3 vWorld;
varying vec3 vCol;
varying float vAcross;
varying float vAlong;
varying vec3 vSpan; // x0 (flat-water reflection point), near, far — constant per quad
void main() {
  vec3 C = uCamPos;
  float cy = max(C.y, 3.0);
  vec2 toL = aLight.xz - C.xz;
  float D = max(length(toL), 1.0);
  vec2 dir = toL / D;
  vec2 side = vec2(-dir.y, dir.x);
  float x0 = D * cy / (cy + aLight.y);
  float th0 = atan(cy, max(x0, 1.0));
  float spread = 0.03;
  float xn = cy / tan(min(th0 + spread, 1.45));
  float xf = th0 - spread > 0.0015 ? cy / tan(th0 - spread) : D;
  xf = max(min(xf, D - 4.0), x0 + 1.0);
  xn = min(xn, x0 - 1.0);
  float along = mix(xn, xf, aCorner.y);
  float w = 0.9 + along * 0.0016;
  vec2 P = C.xz + dir * along + side * aCorner.x * w;
  vWorld = vec3(P.x, 0.2, P.y);
  vAcross = aCorner.x;
  vAlong = along;
  vSpan = vec3(x0, xn, xf);
  // behind the light or the camera below the light's mirror: nothing to reflect
  float ok = step(1.0, C.y) * step(20.0, D);
  vCol = aColor.rgb * aColor.w * uNight * ok;
  gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0);
}
`;

const reflFragment = /* glsl */ `
${ATMOSPHERE_GLSL}
${COAST_GLSL}
uniform sampler2D uNormalMap;
varying vec3 vWorld;
varying vec3 vCol;
varying float vAcross;
varying float vAlong;
varying vec3 vSpan;
void main() {
  if (dot(vCol, vec3(1.0)) <= 0.0) discard;
  float mw;
  float sd = coastMaskSD(vWorld.xz, mw);
  if (mw > 0.5 && sd > -2.0) discard;
  float t = vAlong < vSpan.x ? (vAlong - vSpan.x) / max(1.0, vSpan.x - vSpan.y) : (vAlong - vSpan.x) / max(1.0, vSpan.z - vSpan.x);
  float prof = exp(-t * t * 2.2);
  float across = exp(-vAcross * vAcross * 3.5);
  // broken, rippling streak: glints where the waves face the light
  vec2 uv = vWorld.xz / 31.0 + vec2(uTime * 0.012, -uTime * 0.017);
  float n = texture2D(uNormalMap, uv).r * 0.6 + texture2D(uNormalMap, vWorld.xz / 9.0 - uTime * 0.03).g * 0.4;
  float sparkle = smoothstep(0.48, 0.8, n);
  float fog = atmoFogFactor(distance(vWorld, uCamPos) * 0.6, uCamPos.y, 0.0);
  vec3 col = vCol * prof * across * (0.12 + 1.1 * sparkle) * (1.0 - fog);
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export interface ReflectionSource {
  x: number;
  y: number;
  z: number;
  color: number;
  intensity: number;
}

export class LightReflections {
  readonly mesh: Mesh;
  private readonly material: ShaderMaterial;

  constructor(atmo: AtmosphereUniforms, sources: ReflectionSource[], normalMap: { value: Texture }, coastUniforms: Record<string, { value: unknown }>) {
    const n = sources.length;
    const light = new Float32Array(n * 4 * 3);
    const color = new Float32Array(n * 4 * 4);
    const corner = new Float32Array(n * 4 * 2);
    const idx = new Uint16Array(n * 6);
    const c = new Color();
    for (let i = 0; i < n; i++) {
      const s = sources[i];
      c.setHex(s.color);
      for (let k = 0; k < 4; k++) {
        const v = i * 4 + k;
        light.set([s.x, s.y, s.z], v * 3);
        color.set([c.r, c.g, c.b, s.intensity], v * 4);
        corner.set([k & 1 ? 1 : -1, k >> 1], v * 2);
      }
      idx.set([i * 4, i * 4 + 2, i * 4 + 1, i * 4 + 1, i * 4 + 2, i * 4 + 3], i * 6);
    }
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(light.slice(), 3)); // (unused by the shader; keeps three happy)
    g.setAttribute('aLight', new BufferAttribute(light, 3));
    g.setAttribute('aColor', new BufferAttribute(color, 4));
    g.setAttribute('aCorner', new BufferAttribute(corner, 2));
    g.setIndex(new BufferAttribute(idx, 1));
    this.material = new ShaderMaterial({
      name: 'WorldLightReflections',
      vertexShader: reflVertex,
      fragmentShader: reflFragment,
      uniforms: { ...atmo, ...coastUniforms, uNormalMap: normalMap },
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      side: 2,
    });
    this.mesh = new Mesh(g, this.material);
    this.mesh.name = 'world-light-reflections';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 4;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
