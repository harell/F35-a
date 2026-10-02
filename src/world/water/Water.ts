/**
 * Ocean / harbour water: a camera-centred polar disc at y = 0 out to the far plane, shaded with
 * three scrolling normal-map octaves, Fresnel sky reflection (same atmosphere as the sky dome, so
 * the sea melts into the horizon), sun/moon glint, depth-based shallows (exact bilinear depth
 * from the terrain height texture) with animated shore foam, optional sea ice, and fog.
 */
import {
  BufferAttribute,
  BufferGeometry,
  Mesh,
  RepeatWrapping,
  ShaderMaterial,
  TextureLoader,
  Vector4,
  type Color,
  type DataTexture,
  type Texture,
  type Vector3,
} from 'three';
import { ATMOSPHERE_GLSL, type AtmosphereUniforms } from '../sky/atmosphere';
import { createWaterNormalFallback } from '../textures/procedural';
import { COAST_GLSL } from '../terrain/terrainShader';
import { coastUniforms, type CoastMaskInfo } from '../terrain/TerrainRenderer';

const vertex = /* glsl */ `
varying vec3 vWorld;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

const fragment = /* glsl */ `
${ATMOSPHERE_GLSL}
${COAST_GLSL}
uniform sampler2D uNormalMap;
uniform highp sampler2D uHeight;
uniform sampler2D uDetail;
uniform vec4 uHf; // origin, cell, n, 0
uniform vec3 uDeep;
uniform vec3 uShallow;
uniform float uGlint;
uniform float uShallowDepth;
varying vec3 vWorld;

float groundHeight(vec2 wp) {
  vec2 g = (wp - uHf.x) / uHf.y;
  int n = int(uHf.z + 0.5);
  vec2 gi = floor(g);
  vec2 f = g - gi;
  ivec2 i = clamp(ivec2(gi), ivec2(0), ivec2(n - 2));
  f = clamp(g - vec2(i), 0.0, 1.0);
  float a = texelFetch(uHeight, i, 0).r;
  float b = texelFetch(uHeight, i + ivec2(1, 0), 0).r;
  float c = texelFetch(uHeight, i + ivec2(0, 1), 0).r;
  float d = texelFetch(uHeight, i + ivec2(1, 1), 0).r;
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

void main() {
  vec3 toCam = uCamPos - vWorld;
  float dist = length(toCam);
  vec3 V = toCam / dist;
  vec2 wp = vWorld.xz;
  float t = uTime;

  vec3 n1 = texture2D(uNormalMap, wp / 173.0 + vec2(t * 0.010, t * 0.006)).xyz * 2.0 - 1.0;
  vec3 n2 = texture2D(uNormalMap, wp / 59.0 + vec2(-t * 0.016, t * 0.012)).xyz * 2.0 - 1.0;
  vec3 n3 = texture2D(uNormalMap, wp / 911.0 + vec2(t * 0.0025, -t * 0.0035)).xyz * 2.0 - 1.0;
  vec2 slope = n1.xy + n2.xy * 0.6 + n3.xy * 0.9;
  float strength = mix(0.55, 0.12, smoothstep(300.0, 15000.0, dist));
  vec3 N = normalize(vec3(slope.x * strength, 1.0, slope.y * strength));

  // Shoreline: near the camera the 15 m coast mask decides (the terrain there is sunk just below
  // the water plane); further out, and outside the mask, the exact bilinear ground height does.
  float gh = groundHeight(wp);
  float mw;
  float sdM = coastMaskSD(wp, mw) + coastWiggle(uDetail, wp);
  mw *= 1.0 - smoothstep(3500.0, 5500.0, dist);
  float sd = mix(gh / 0.03, sdM, mw);
  // the mask may only move the shore onto hf water that is less than 0.6 m deep (the terrain
  // there is held just below the water plane, never pushed into a trench)
  if (sd > 0.0 && gh > -0.6) discard;
  float depth = max(-gh, -sd * 0.03 * mw);
  // Surf: along the mask shoreline (beaches and rocks), or where the sea floor shelves quickly.
  float grad = length(vec2(dFdx(depth), dFdy(depth))) / max(1e-3, length(vec2(length(dFdx(wp)), length(dFdy(wp)))));
  float shoreH = (1.0 - smoothstep(0.0, 0.9, depth)) * smoothstep(0.004, 0.03, grad);
  float shore = mix(shoreH, 1.0 - smoothstep(0.0, 16.0, -sd), mw);

  float ndv = max(dot(N, V), 0.0);
  float fres = 0.02 + 0.98 * pow(1.0 - ndv, 5.0);
  vec3 R = reflect(-V, N);
  R.y = max(R.y, 0.02);
  R = normalize(R);
  vec3 sky = atmoSky(R);

  // Water body: shallow (sand shows through) → deep
  vec3 body = mix(uShallow, uDeep, smoothstep(0.3, uShallowDepth, depth));
  vec3 light = uHemiSky * 0.55 + uSunColor * max(uSunDir.y, 0.0) * 0.35;
  body *= light * 0.9;
  vec3 col = mix(body, sky, fres * (1.0 - shore * 0.4));

  // Sun / moon glint
  float sdot = max(dot(R, uSunDir), 0.0);
  float spec = pow(sdot, 900.0) * 14.0 + pow(sdot, 90.0) * 0.18 + pow(sdot, 12.0) * 0.02;
  col += uSunColor * spec * uGlint * smoothstep(-0.05, 0.05, uSunDir.y);

  // Shore foam: animated bands where the water gets very shallow
  float fade = 1.0 - smoothstep(1500.0, 6000.0, dist);
  if (shore > 0.0 && fade > 0.0) {
    float fn = texture2D(uDetail, wp / 19.0 + vec2(t * 0.013, t * 0.007)).r;
    float wave = 0.5 + 0.5 * sin(t * 1.4 - (mw > 0.5 ? -sd * 0.35 : depth * 3.5) + fn * 4.0);
    float edge = mw > 0.5 ? 1.0 - smoothstep(0.0, 3.0, -sd) : 1.0 - smoothstep(0.0, 0.25, depth);
    float foam = shore * (smoothstep(0.55, 0.85, fn * 0.7 + wave * 0.5) * 0.7 + edge * 0.45);
    col = mix(col, (uHemiSky * 0.6 + uSunColor * 0.3) * 0.9, clamp(foam, 0.0, 1.0) * 0.6 * fade);
  }

  col = atmoNight(col);
  col = atmoApplyFog(col, vWorld);
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export interface WaterOptions {
  atmo: AtmosphereUniforms;
  heightTexture: DataTexture;
  detail: Texture;
  hf: { origin: number; cell: number; n: number };
  deep: Color;
  shallow: Color;
  shallowDepth: number;
  radius: number;
  coast: CoastMaskInfo | null;
  dummy: Texture;
}

export class Water {
  readonly mesh: Mesh;
  private readonly material: ShaderMaterial;
  private normalMap: Texture;
  private loaded: Texture | null = null;

  constructor(o: WaterOptions) {
    this.normalMap = createWaterNormalFallback();
    this.material = new ShaderMaterial({
      name: 'Water',
      vertexShader: vertex,
      fragmentShader: fragment,
      uniforms: {
        ...o.atmo,
        uNormalMap: { value: this.normalMap },
        uHeight: { value: o.heightTexture },
        uDetail: { value: o.detail },
        uHf: { value: new Vector4(o.hf.origin, o.hf.cell, o.hf.n, 0) },
        uDeep: { value: o.deep },
        uShallow: { value: o.shallow },
        uGlint: { value: 1 },
        uShallowDepth: { value: o.shallowDepth },
        ...coastUniforms(o.coast, o.dummy),
      },
    });
    new TextureLoader().load(
      'textures/waternormals.jpg',
      (t) => {
        t.wrapS = t.wrapT = RepeatWrapping;
        this.loaded = t;
        this.material.uniforms.uNormalMap.value = t;
      },
      undefined,
      () => undefined,
    );
    this.mesh = new Mesh(buildDisc(o.radius), this.material);
    this.mesh.name = 'water';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 0;
  }

  /** Shared uniform holding the (async-loaded) water normal map. */
  get normalMapUniform(): { value: Texture } {
    return this.material.uniforms.uNormalMap as { value: Texture };
  }

  preRender(camPos: Vector3): void {
    // Offset by a non-round fraction so no disc vertex ever lies exactly on the camera plane
    // (w = 0 for a level camera), a degenerate case some rasterisers clip incorrectly.
    this.mesh.position.set(camPos.x + 0.1234, 0, camPos.z + 0.3117);
    this.mesh.updateMatrix();
    this.mesh.updateMatrixWorld();
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.normalMap.dispose();
    this.loaded?.dispose();
  }
}

/** Polar disc (y = 0) with rings concentrated near the centre. */
function buildDisc(radius: number): BufferGeometry {
  const rings = 10;
  const segs = 48;
  const pos: number[] = [0, 0, 0];
  for (let r = 1; r <= rings; r++) {
    const rad = radius * Math.pow(r / rings, 2.2);
    for (let s = 0; s < segs; s++) {
      const a = (s / segs) * Math.PI * 2;
      pos.push(Math.cos(a) * rad, 0, Math.sin(a) * rad);
    }
  }
  const idx: number[] = [];
  for (let s = 0; s < segs; s++) idx.push(0, 1 + ((s + 1) % segs), 1 + s);
  for (let r = 1; r < rings; r++) {
    const a0 = 1 + (r - 1) * segs;
    const b0 = 1 + r * segs;
    for (let s = 0; s < segs; s++) {
      const s1 = (s + 1) % segs;
      idx.push(a0 + s, a0 + s1, b0 + s);
      idx.push(a0 + s1, b0 + s1, b0 + s);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setIndex(idx);
  return g;
}
