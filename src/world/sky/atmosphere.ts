/**
 * Shared atmosphere uniforms + GLSL (sky colour, horizon haze, height-dependent exp² fog, lights).
 * Every world shader (sky, terrain, water, clouds, scenery) includes ATMOSPHERE_GLSL and shares the
 * SAME uniform objects, so updating them once per frame updates all materials, and the distant
 * terrain always melts into the sky at the horizon.
 */
import { Color, Vector3, Vector4 } from 'three';
import type { SkyPreset } from './presets';

export interface AtmosphereUniforms {
  [name: string]: { value: unknown };
  uSunDir: { value: Vector3 };
  /** Sun colour × DirectionalLight intensity (linear). */
  uSunColor: { value: Color };
  uHemiSky: { value: Color };
  uHemiGround: { value: Color };
  uZenith: { value: Color };
  uHorizon: { value: Color };
  uHorizonSun: { value: Color };
  uSunDisk: { value: Color };
  uSunGlow: { value: number };
  uFogDensity: { value: number };
  uFogFar: { value: number };
  uHazeHeight: { value: number };
  uCamPos: { value: Vector3 };
  uTime: { value: number };
  /** 0 = day, 1 = full night (emissive lights on). */
  uNight: { value: number };
  /** Night light dome over a city: centre x, z (m), radius (m), strength (0 = none). */
  uCityGlow: { value: Vector4 };
}

export function createAtmosphereUniforms(p: SkyPreset, drawDistance: number): AtmosphereUniforms {
  return {
    uSunDir: { value: p.sunDir.clone() },
    uSunColor: { value: p.sunColor.clone().multiplyScalar(p.sunIntensity) },
    uHemiSky: { value: p.hemiSky.clone().multiplyScalar(p.hemiIntensity) },
    uHemiGround: { value: p.hemiGround.clone().multiplyScalar(p.hemiIntensity) },
    uZenith: { value: p.zenith.clone() },
    uHorizon: { value: p.horizon.clone() },
    uHorizonSun: { value: p.horizonSun.clone() },
    uSunDisk: { value: p.sunDisk.clone() },
    uSunGlow: { value: p.sunGlow },
    uFogDensity: { value: p.fogDensity },
    uFogFar: { value: drawDistance },
    uHazeHeight: { value: p.hazeHeight },
    uCamPos: { value: new Vector3() },
    uTime: { value: 0 },
    uNight: { value: p.lights },
    uCityGlow: { value: new Vector4(0, 0, 1, 0) },
  };
}

/**
 * Write a blend of two presets into the shared uniforms (e.g. overcast below the deck → clear sky
 * above it). t = 0 → a, 1 → b.
 */
export function blendAtmosphere(u: AtmosphereUniforms, a: SkyPreset, b: SkyPreset, t: number): void {
  u.uZenith.value.lerpColors(a.zenith, b.zenith, t);
  u.uHorizon.value.lerpColors(a.horizon, b.horizon, t);
  u.uHorizonSun.value.lerpColors(a.horizonSun, b.horizonSun, t);
  const ia = a.sunIntensity + (b.sunIntensity - a.sunIntensity) * t;
  u.uSunColor.value.lerpColors(a.sunColor, b.sunColor, t).multiplyScalar(ia);
  const ha = a.hemiIntensity + (b.hemiIntensity - a.hemiIntensity) * t;
  u.uHemiSky.value.lerpColors(a.hemiSky, b.hemiSky, t).multiplyScalar(ha);
  u.uSunGlow.value = a.sunGlow + (b.sunGlow - a.sunGlow) * t;
}

/** GLSL declarations + helpers. Include in both vertex and fragment shaders that need them. */
export const ATMOSPHERE_GLSL = /* glsl */ `
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uHemiSky;
uniform vec3 uHemiGround;
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uHorizonSun;
uniform vec3 uSunDisk;
uniform float uSunGlow;
uniform float uFogDensity;
uniform float uFogFar;
uniform float uHazeHeight;
uniform vec3 uCamPos;
uniform float uTime;
uniform float uNight;
uniform vec4 uCityGlow;

// Sodium / LED light dome over the city at night: low on the horizon in the city's direction,
// all around (and overhead) when flying over it.
vec3 atmoCityGlow(vec3 dir) {
  vec2 to = uCityGlow.xy - uCamPos.xz;
  float d = length(to);
  float R = uCityGlow.z;
  float inside = 1.0 - smoothstep(R * 0.6, R * 1.4, d);
  float angw = clamp(R / max(d, 1.0), 0.2, 3.1);
  float az = dot(normalize(dir.xz + vec2(1e-5)), to / max(d, 1.0));
  float toward = smoothstep(cos(min(angw * 1.5, 3.1)), 1.0, az);
  float el = exp(-max(dir.y, 0.0) * mix(10.0, 3.0, inside));
  float fall = 1.0 / (1.0 + max(0.0, d - R) / (R * 1.5));
  return vec3(1.0, 0.56, 0.26) * uCityGlow.w * el * mix(toward, 1.0, inside) * fall;
}

// Horizon haze colour in a view direction (warmer towards the sun) + broad sun glow.
vec3 atmoHorizon(vec3 dir) {
  float s = max(dot(dir, uSunDir), 0.0);
  float sunUp = smoothstep(-0.12, 0.08, uSunDir.y);
  vec3 hz = mix(uHorizon, uHorizonSun, pow(s, 4.0) * sunUp);
  hz += uSunDisk * uSunGlow * (0.10 * pow(s, 10.0) + 0.06 * pow(s, 3.0)) * sunUp;
  if (uCityGlow.w > 0.0) hz += atmoCityGlow(dir);
  return hz;
}

// Distant haze seen in a direction: the horizon colour, slightly deeper when looking down into
// the haze layer (used by both the fog and the dome below the horizon, so they always match).
vec3 atmoHaze(vec3 dir) {
  vec3 hz = atmoHorizon(dir);
  float down = clamp(-dir.y, 0.0, 1.0);
  return hz * (1.0 - 0.22 * smoothstep(0.0, 0.45, down));
}

// Sky radiance (no sun disk) in a direction.
vec3 atmoSky(vec3 dir) {
  float y = dir.y;
  // exponential gradient: finite slope at the horizon (pow(y, k<1) leaves a visible seam)
  float t = 1.0 - exp(-3.6 * max(y, 0.0));
  // Below the horizon the sky IS the haze colour, so fogged terrain at the far plane blends in.
  vec3 col = mix(atmoHaze(dir), uZenith, t);
  float s = max(dot(dir, uSunDir), 0.0);
  col += uSunDisk * uSunGlow * 0.35 * pow(s, 64.0);
  return col;
}

// Height-dependent exp² fog: density thins with the mean altitude of the ray; forced to 1 near the
// far distance so geometry never ends in a visible edge.
float atmoFogFactor(float dist, float y0, float y1) {
  float h = max(0.0, 0.5 * (y0 + y1));
  float dens = uFogDensity * exp(-h / uHazeHeight);
  float fd = dens * dist;
  float f = 1.0 - exp(-fd * fd);
  // Gradual fade towards the far plane (a steep late fade reads as a wall of haze).
  float far = smoothstep(uFogFar * 0.36, uFogFar * 0.985, dist);
  return max(f, far);
}

vec3 atmoApplyFog(vec3 col, vec3 worldPos) {
  vec3 d = worldPos - uCamPos;
  float dist = length(d);
  float f = atmoFogFactor(dist, uCamPos.y, worldPos.y);
  return mix(col, atmoHaze(d / max(dist, 1e-3)), f);
}

// Scotopic (night) vision: moonlit colours desaturate towards a cool grey.
vec3 atmoNight(vec3 c) {
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  return mix(c, vec3(l) * vec3(0.85, 0.95, 1.15), step(0.95, uNight) * 0.65);
}

// Diffuse lighting (matches three.js physically-correct Lambert: albedo/π · irradiance).
vec3 atmoDiffuse(vec3 albedo, vec3 n, float sunVis) {
  float ndl = max(dot(n, uSunDir), 0.0);
  vec3 hemi = mix(uHemiGround, uHemiSky, n.y * 0.5 + 0.5);
  return albedo * (uSunColor * ndl * sunVis + hemi) * 0.3183099;
}
`;
