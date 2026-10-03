/**
 * Lighting / atmosphere presets per (time of day, weather) over Auckland. Pure data (three.js Color /
 * Vector3 only), node-safe. All colours are authored as sRGB hex and converted to linear by
 * three's Color (ColorManagement enabled).
 */
import { Color, Vector3 } from 'three';
import type { TheaterId, TimeOfDay, Weather } from '../../core/types';

export interface SkyPreset {
  timeOfDay: TimeOfDay;
  weather: Weather;
  /** Unit vector TO the main light (sun, or moon at night). */
  sunDir: Vector3;
  isNight: boolean;
  /** Main light colour × intensity (for our shaders); `sunIntensity` for the DirectionalLight. */
  sunColor: Color;
  sunIntensity: number;
  hemiSky: Color;
  hemiGround: Color;
  hemiIntensity: number;
  /** Sky dome gradient. */
  zenith: Color;
  horizon: Color;
  /** Horizon haze towards the sun (warm at dawn/dusk). */
  horizonSun: Color;
  /** Fog / haze colour away from the sun (matches the sky horizon). */
  fogColor: Color;
  /** Exp² fog density (1/m) at sea level. */
  fogDensity: number;
  /** Haze scale height (m): fog thins out with altitude. */
  hazeHeight: number;
  /** Sun disk radiance multiplier and glow strength. */
  sunDisk: Color;
  sunGlow: number;
  /** 0..1 star visibility. */
  starAlpha: number;
  /** Cloud colours: lit top / shadowed base. */
  cloudLit: Color;
  cloudShade: Color;
  /** Water colours. */
  waterDeep: Color;
  waterShallow: Color;
  /** Depth (m) at which the water reaches its deep colour. */
  shallowDepth: number;
  /** Night-time emissive factor for town / runway lights (0 by day). */
  lights: number;
  /**
   * Aerial perspective (issue #139): beyond `near` metres, colours blend toward the sky's haze in
   * that view direction, approaching `strength` with an e-folding distance of `range` metres, and
   * thinning with the ray's mean height (scale height `height` m). Layered on top of the fog.
   */
  aerial: AerialPerspective;
  /** A light colour grade after fog, shared by the sky and every world shader. */
  grade: ColourGrade;
}

export interface AerialPerspective {
  near: number;
  range: number;
  strength: number;
  height: number;
}

export interface ColourGrade {
  /** Contrast around mid-grey (linear 0.18): 1 = unchanged. */
  contrast: number;
  /** Saturation around luminance: 1 = unchanged. */
  saturation: number;
}

const DEG = Math.PI / 180;

/** Direction from azimuth (deg, 0 = north, clockwise) and elevation (deg). */
export function dirFromAzEl(az: number, el: number, out = new Vector3()): Vector3 {
  const a = az * DEG;
  const e = el * DEG;
  return out.set(Math.sin(a) * Math.cos(e), Math.sin(e), -Math.cos(a) * Math.cos(e)).normalize();
}

interface TodBase {
  az: number;
  el: number;
  sun: number;
  sunI: number;
  hemiSky: number;
  hemiGround: number;
  hemiI: number;
  zenith: number;
  horizon: number;
  horizonSun: number;
  disk: number;
  glow: number;
  stars: number;
  cloudLit: number;
  cloudShade: number;
  lights: number;
  /** Aerial perspective strength (0..1) and the colour grade, clear weather. */
  aerial: number;
  contrast: number;
  saturation: number;
}

const TOD: Record<TimeOfDay, TodBase> = {
  dawn: {
    az: 96, el: 7, sun: 0xffb27a, sunI: 2.3, hemiSky: 0x8f9cc8, hemiGround: 0x6e6052, hemiI: 1.1,
    zenith: 0x35568f, horizon: 0xc2b4c0, horizonSun: 0xffa060, disk: 0xffc890, glow: 1.3, stars: 0.12,
    cloudLit: 0xffc8a0, cloudShade: 0x6a6886, lights: 0.55, aerial: 0.5, contrast: 1.05, saturation: 1.08,
  },
  day: {
    az: 160, el: 58, sun: 0xfff3df, sunI: 3.1, hemiSky: 0xbcd3f0, hemiGround: 0x7d6e58, hemiI: 1.15,
    zenith: 0x1f5cc0, horizon: 0xb4cce6, horizonSun: 0xe8eef2, disk: 0xfff8e8, glow: 0.8, stars: 0,
    cloudLit: 0xffffff, cloudShade: 0x93a0b4, lights: 0, aerial: 0.36, contrast: 1.06, saturation: 1.06,
  },
  dusk: {
    az: 262, el: 5, sun: 0xff9a58, sunI: 2.1, hemiSky: 0x7d82b4, hemiGround: 0x4a3a38, hemiI: 0.85,
    zenith: 0x2a3a6c, horizon: 0xc0a0a8, horizonSun: 0xff8040, disk: 0xffb070, glow: 1.5, stars: 0.25,
    cloudLit: 0xffa878, cloudShade: 0x585476, lights: 0.8, aerial: 0.55, contrast: 1.05, saturation: 1.08,
  },
  night: {
    az: 205, el: 38, sun: 0xa8bce8, sunI: 0.6, hemiSky: 0x2a3e66, hemiGround: 0x0e1018, hemiI: 0.8,
    zenith: 0x02050c, horizon: 0x101b30, horizonSun: 0x1a2844, disk: 0xdfe8ff, glow: 0.35, stars: 1,
    cloudLit: 0x39465e, cloudShade: 0x121824, lights: 1, aerial: 0.06, contrast: 1, saturation: 1,
  },
};

/**
 * Auckland: sun path, haze colour/density, water colours. Southern hemisphere: the midday sun (and
 * the night's moon) stands in the NORTH over the Hauraki Gulf.
 */
const AKL = { aerialNear: 4000, aerialRange: 9000, aerialHeight: 1500, dayEl: 54, dayAz: 20, nightAz: 20, haze: 0xb6cde6, fogK: 1.3, hazeH: 3000, deep: 0x0f3844, shallow: 0x2a5e58, tint: 0.1, shallowDepth: 5 };

/**
 * City / street-light intensity from the sun's elevation (degrees): street lights and the urban
 * light carpet are off with the sun above +7°, fade in through sunset and are fully on from -3°
 * (civil twilight). Dawn (sun 7° up) therefore shows no light carpet under a sunrise sky; dusk
 * (5°) shows the first lamps coming on. Night presets (moon as the key light) are always 1.
 */
export function lightsForSun(elDeg: number): number {
  return Math.min(1, Math.max(0, (7 - elDeg) / 10));
}

export function skyPreset(_theater: TheaterId, tod: TimeOfDay, weather: Weather, drawDistance: number): SkyPreset {
  const b = TOD[tod];
  const t = AKL;
  const el = tod === 'day' ? t.dayEl : b.el;
  const az = tod === 'day' ? t.dayAz : tod === 'night' ? t.nightAz : b.az;
  const sunDir = dirFromAzEl(az, el);

  const c = (hex: number) => new Color().setHex(hex);
  const horizon = c(b.horizon);
  const zenith = c(b.zenith);
  const horizonSun = c(b.horizonSun);
  // Daytime haze: Auckland's humid maritime blue.
  if (tod === 'day') {
    horizon.lerp(c(t.haze), 0.7);
    horizonSun.lerp(c(t.haze), 0.5);
  } else if (tod !== 'night') {
    horizon.lerp(c(t.haze), t.tint * 0.4);
  }

  let sunI = b.sunI;
  let hemiI = b.hemiI;
  let fogK = t.fogK;
  const hemiSky = c(b.hemiSky);
  const cloudLit = c(b.cloudLit);
  const cloudShade = c(b.cloudShade);
  if (weather === 'scattered') fogK *= 1.08;
  let waterK = 1;
  let aerial = b.aerial;
  let contrast = b.contrast;
  let saturation = b.saturation;
  if (weather === 'scattered') aerial *= 1.08;
  if (weather === 'overcast') {
    // Flat grey light: a denser grey haze (its colour is the grey horizon below), no extra punch.
    aerial = Math.min(0.6, aerial * 1.3);
    contrast = 1 + (contrast - 1) * 0.5;
    saturation = 1;
    // Grey, flat, diffuse light under a low stratus deck: almost no direct sun, a bright grey
    // sky dome, murky haze, dull grey-green water.
    const grey = tod === 'night' ? c(0x0a0e16) : tod === 'day' ? c(0x9ba3ab) : c(0x7a7680);
    horizon.lerp(grey, 0.9);
    zenith.lerp(tod === 'night' ? c(0x05070c) : c(0x9a9da0), 0.97);
    horizonSun.lerp(grey, 0.9);
    hemiSky.lerp(grey, 0.75);
    sunI *= 0.16;
    hemiI *= 1.55;
    fogK *= 1.9;
    cloudLit.lerp(grey, 0.5);
    cloudShade.lerp(tod === 'day' ? c(0x8a9098) : grey, 0.6);
    waterK = 0.72;
  }

  // three.js ACESFilmic divides by 0.6 before the curve: author sky radiance ~0.62× so skies stay
  // saturated; fog colour matches the horizon so distant terrain still melts into it.
  horizon.multiplyScalar(0.9);
  horizonSun.multiplyScalar(0.9);
  zenith.multiplyScalar(0.62);
  const fogColor = horizon.clone();
  return {
    timeOfDay: tod,
    weather,
    sunDir,
    isNight: tod === 'night',
    sunColor: c(b.sun),
    sunIntensity: sunI,
    hemiSky,
    hemiGround: c(b.hemiGround),
    hemiIntensity: hemiI,
    zenith,
    horizon,
    horizonSun,
    fogColor,
    fogDensity: fogK / Math.max(8000, drawDistance),
    hazeHeight: t.hazeH,
    sunDisk: c(b.disk),
    sunGlow: b.glow * (weather === 'overcast' ? 0.08 : 1),
    starAlpha: weather === 'overcast' ? b.stars * 0.15 : b.stars,
    cloudLit,
    cloudShade,
    waterDeep: c(t.deep).lerp(c(0x2a3438), 1 - waterK).multiplyScalar(waterK),
    waterShallow: c(t.shallow).lerp(c(0x3a4644), 1 - waterK).multiplyScalar(waterK),
    shallowDepth: t.shallowDepth,
    lights: tod === 'night' ? b.lights : Math.min(b.lights, lightsForSun(el)),
    aerial: { near: t.aerialNear, range: t.aerialRange, strength: aerial, height: t.aerialHeight },
    grade: { contrast, saturation },
  };
}

/**
 * CPU mirror of the GLSL `atmoAerial` (for tests and tuning): the aerial-perspective blend toward the
 * haze for a ray of length `dist` between heights `y0` and `y1`.
 */
export function aerialFactor(a: AerialPerspective, dist: number, y0: number, y1: number): number {
  const h = Math.max(0, 0.5 * (y0 + y1));
  const k = 1 - Math.exp(-Math.max(dist - a.near, 0) / a.range);
  return a.strength * k * Math.exp(-h / a.height);
}
