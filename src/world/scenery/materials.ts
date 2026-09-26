/**
 * Shared scenery materials (all include the atmosphere chunk so they fog and light exactly like the
 * terrain):
 *  - building: vertex colours, procedural facade windows (glass by day, randomly lit at night),
 *    works for merged meshes and InstancedMesh (instanceMatrix / instanceColor)
 *  - decal: textured ground overlays (runways, taxiways, aprons) with polygon offset
 *  - foliage: instanced low-poly trees with wrap lighting
 *  - lights: point sprites sized in metres with a pixel minimum (runway / city / aviation lights)
 */
import { AdditiveBlending, ShaderMaterial, type Texture } from 'three';
import { ATMOSPHERE_GLSL, type AtmosphereUniforms } from '../sky/atmosphere';

const commonVertex = /* glsl */ `
varying vec3 vWorld;
varying vec3 vNormal;
varying vec3 vColor;
mat4 worldMatrix() {
  #ifdef USE_INSTANCING
    return modelMatrix * instanceMatrix;
  #else
    return modelMatrix;
  #endif
}
vec3 vertexColor() {
  vec3 c = vec3(1.0);
  #ifdef USE_COLOR
    c = color;
  #endif
  #ifdef USE_INSTANCING_COLOR
    c *= instanceColor;
  #endif
  return c;
}
`;

const buildingVertex = /* glsl */ `
attribute float aWin;
varying float vWin;
${commonVertex}
void main() {
  mat4 m = worldMatrix();
  vec4 w = m * vec4(position, 1.0);
  vWorld = w.xyz;
  vNormal = normalize(mat3(m) * normal);
  vColor = vertexColor();
  vWin = aWin;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

const buildingFragment = /* glsl */ `
${ATMOSPHERE_GLSL}
varying vec3 vWorld;
varying vec3 vNormal;
varying vec3 vColor;
varying float vWin;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

void main() {
  vec3 N = normalize(vNormal);
  vec3 base = vColor;
  vec3 emissive = vec3(0.0);
  float mpp = max(length(dFdx(vWorld)), length(dFdy(vWorld)));
  if (vWin > 0.5 && vWin < 3.5 && abs(N.y) < 0.5) {
    vec2 t = normalize(vec2(-N.z, N.x) + 1e-5);
    float u = dot(vWorld.xz, t);
    vec2 spacing = vWin < 1.5 ? vec2(3.4, 3.7) : vWin < 2.5 ? vec2(4.6, 3.1) : vec2(9.0, 6.5);
    vec2 g = vec2(u, vWorld.y) / spacing;
    vec2 id = floor(g);
    vec2 f = fract(g);
    vec2 lo = vWin < 1.5 ? vec2(0.1, 0.22) : vec2(0.28, 0.3);
    vec2 aa = vec2(mpp) / spacing;
    vec2 wv = smoothstep(lo - aa, lo + aa, f) * smoothstep(lo - aa, lo + aa, 1.0 - f);
    float win = wv.x * wv.y;
    float detail = 1.0 - smoothstep(0.35, 0.9, mpp / spacing.y);
    vec3 sky = atmoSky(normalize(reflect(normalize(vWorld - uCamPos), N) + vec3(0.0, 0.25, 0.0)));
    vec3 glass = mix(base * 0.25, sky * 0.55, 0.55);
    float cover = vWin < 1.5 ? 0.62 : 0.3;
    base = mix(base, glass, mix(cover * 0.8, win, detail));
    if (uNight > 0.0) {
      float hsh = hash12(id + floor(vWorld.xz / 37.0) * 7.0);
      float lit = step(hsh, vWin < 1.5 ? 0.38 : 0.25);
      vec3 warm = mix(vec3(1.0, 0.7, 0.38), vec3(0.75, 0.85, 1.0), step(0.8, fract(hsh * 7.0))) * 1.5;
      emissive += warm * uNight * mix(cover * (vWin < 1.5 ? 0.1 : 0.06), win * lit, detail);
    }
  } else if (vWin > 3.5) {
    emissive += base * uNight * 1.6;
  }
  vec3 col = atmoDiffuse(base, N, 1.0) + emissive;
  col = atmoApplyFog(col, vWorld);
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export function createBuildingMaterial(atmo: AtmosphereUniforms): ShaderMaterial {
  return new ShaderMaterial({
    name: 'WorldBuilding',
    vertexShader: buildingVertex,
    fragmentShader: buildingFragment,
    uniforms: { ...atmo },
    vertexColors: true,
  });
}

const decalVertex = /* glsl */ `
varying vec3 vWorld;
varying vec2 vUv;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  vUv = uv;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

const decalFragment = /* glsl */ `
${ATMOSPHERE_GLSL}
uniform sampler2D uMap;
varying vec3 vWorld;
varying vec2 vUv;
void main() {
  vec4 t = texture2D(uMap, vUv);
  vec3 col = atmoDiffuse(t.rgb, vec3(0.0, 1.0, 0.0), 1.0);
  col = atmoApplyFog(col, vWorld);
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export function createDecalMaterial(atmo: AtmosphereUniforms, map: Texture): ShaderMaterial {
  return new ShaderMaterial({
    name: 'WorldDecal',
    vertexShader: decalVertex,
    fragmentShader: decalFragment,
    uniforms: { ...atmo, uMap: { value: map } },
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -6,
  });
}

const foliageVertex = /* glsl */ `
${commonVertex}
void main() {
  mat4 m = worldMatrix();
  vec4 w = m * vec4(position, 1.0);
  vWorld = w.xyz;
  vNormal = normalize(mat3(m) * normal);
  vColor = vertexColor();
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

const foliageFragment = /* glsl */ `
${ATMOSPHERE_GLSL}
varying vec3 vWorld;
varying vec3 vNormal;
varying vec3 vColor;
void main() {
  vec3 N = normalize(vNormal);
  // wrap lighting keeps crowns from going black on the shadow side
  float ndl = dot(N, uSunDir) * 0.6 + 0.4;
  vec3 hemi = mix(uHemiGround, uHemiSky, N.y * 0.5 + 0.5);
  vec3 col = vColor * (uSunColor * max(ndl, 0.0) + hemi) * 0.3183099;
  col = atmoApplyFog(col, vWorld);
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export function createFoliageMaterial(atmo: AtmosphereUniforms): ShaderMaterial {
  return new ShaderMaterial({
    name: 'WorldFoliage',
    vertexShader: foliageVertex,
    fragmentShader: foliageFragment,
    uniforms: { ...atmo },
    vertexColors: true,
  });
}

const lightsVertex = /* glsl */ `
${ATMOSPHERE_GLSL}
attribute vec3 aColor;
attribute vec2 aSizeBlink; // size (m), blink phase (−1 = steady)
uniform float uPixelScale; // viewport height (px) / (2·tan(fov/2))
uniform float uPixelRatio;
uniform float uIntensity;
varying vec3 vColor;
varying float vAlpha;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vec4 mv = viewMatrix * w;
  float dist = max(1.0, -mv.z);
  float px = aSizeBlink.x * uPixelScale / dist;
  gl_PointSize = clamp(px, 1.6, 42.0) * uPixelRatio;
  float blink = aSizeBlink.y < 0.0 ? 1.0 : step(0.55, fract(uTime * 0.8 + aSizeBlink.y));
  // lights punch through haze: use a thinner fog than surfaces
  float fog = atmoFogFactor(dist * 0.55, uCamPos.y, w.y);
  vAlpha = uIntensity * blink * (1.0 - fog) * clamp(px / 1.6, 0.35, 1.0);
  vColor = aColor;
  gl_Position = projectionMatrix * mv;
}
`;

const lightsFragment = /* glsl */ `
varying vec3 vColor;
varying float vAlpha;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float r = length(c) * 2.0;
  float a = (exp(-r * r * 9.0) + 0.25 * exp(-r * r * 2.5)) * (1.0 - smoothstep(0.85, 1.0, r));
  gl_FragColor = vec4(vColor * a * vAlpha * 2.2, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export function createLightsMaterial(atmo: AtmosphereUniforms): ShaderMaterial {
  return new ShaderMaterial({
    name: 'WorldLights',
    vertexShader: lightsVertex,
    fragmentShader: lightsFragment,
    uniforms: { ...atmo, uPixelScale: { value: 400 }, uPixelRatio: { value: 1 }, uIntensity: { value: 1 } },
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
  });
}
