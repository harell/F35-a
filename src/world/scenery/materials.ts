/**
 * Shared scenery materials (all include the atmosphere chunk so they fog and light exactly like the
 * terrain):
 *  - building: vertex colours, procedural facade windows (glass by day, randomly lit at night),
 *    works for merged meshes and InstancedMesh (instanceMatrix / instanceColor)
 *  - decal: textured ground overlays (runways, taxiways, aprons) with polygon offset
 *  - sign: lit letters from a canvas texture (Spark Arena)
 *  - foliage: instanced low-poly trees with wrap lighting
 *  - lights: point sprites sized in metres with a pixel minimum (runway / city / aviation lights)
 */
import { AdditiveBlending, ShaderMaterial, type Color, type Texture, type Vector4 } from 'three';
import { ATMOSPHERE_GLSL, type AtmosphereUniforms } from '../sky/atmosphere';
import { AERIAL_LIGHT_GLSL } from '../terrain/terrainShader';
import { AERIAL_NIGHT_MIX } from '../terrain/theaters/aucklandAerial';

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

/**
 * Window grids of the building shader: cell spacing (m, across × up), the unlit margin of each cell
 * (fraction, x / y) and the fraction of windows lit at night, per facade style (aWin 1 = office,
 * 2 = home, 3 = industrial).
 */
export const WINDOW_STYLES = {
  office: { spacing: [3.4, 3.7], margin: [0.1, 0.22], lit: 0.38 },
  home: { spacing: [4.6, 3.1], margin: [0.28, 0.3], lit: 0.25 },
  industrial: { spacing: [9.0, 6.5], margin: [0.28, 0.3], lit: 0.25 },
} as const;

/** Mean colour of a lit window (warm 80 % / cool 20 %, × 1.5 like the shader). */
export const LIT_WINDOW_MEAN: [number, number, number] = [1.5 * (0.8 * 1.0 + 0.2 * 0.75), 1.5 * (0.8 * 0.7 + 0.2 * 0.85), 1.5 * (0.8 * 0.38 + 0.2 * 1.0)];

/**
 * Night emissive of a facade whose windows are sub-pixel: lit fraction × window area × mean lit
 * colour — the spatial average of the full-detail pattern (so the city doesn't dim with distance).
 */
export function windowGlowAverage(style: keyof typeof WINDOW_STYLES): [number, number, number] {
  const w = WINDOW_STYLES[style];
  const area = (1 - 2 * w.margin[0]) * (1 - 2 * w.margin[1]);
  return LIT_WINDOW_MEAN.map((c) => c * w.lit * area) as [number, number, number];
}

const v3 = (a: readonly number[]) => `vec3(${a.map((x) => x.toFixed(5)).join(', ')})`;
const v2 = (a: readonly number[]) => `vec2(${a.map((x) => x.toFixed(4)).join(', ')})`;

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
  #ifdef HOUSES
    // walls: painted weatherboard / render tint per instance (the instance colour is the roof's)
    if (aWin > 0.5) {
      float hh = fract(sin(dot(m[3].xz, vec2(0.12989, 0.78233))) * 43758.5453);
      vColor = color * mix(vec3(0.93, 0.91, 0.86), vec3(0.8, 0.83, 0.85), step(0.62, hh)) * (0.86 + 0.18 * fract(hh * 7.0));
    }
  #endif
  vWin = aWin;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

const buildingFragment = /* glsl */ `
${ATMOSPHERE_GLSL}
#ifdef AERIAL
${AERIAL_LIGHT_GLSL}
uniform sampler2D uAerial;
uniform vec4 uAerialRect; // x0, z0, 1/size, edge feather (m)
uniform vec4 uAerialGrade; // colour grade (terrain shader's): rgb gain, strength
#endif
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
  float photoW = 0.0;
  #ifdef AERIAL
    // decks and roofs take the aerial photo where it shows land or a deck (yachts over the water keep
    // their own colour); light fixtures (aWin 4) keep theirs
    if (N.y > 0.7 && vWin < 3.5) {
      vec2 uv = (vWorld.xz - uAerialRect.xy) * uAerialRect.z;
      float e = min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y));
      if (e > 0.0) {
        vec4 p = texture2D(uAerial, uv);
        photoW = p.a * smoothstep(0.0, 1.0, e / (uAerialRect.z * uAerialRect.w));
        vec3 photoCol = p.rgb * mix(vec3(1.0), uAerialGrade.rgb, uAerialGrade.a);
        // at night half the photo's colour gives way to the top's own, as on the terrain photo (#61 item 5)
        if (uNight > 0.0) photoCol = mix(photoCol, base, ${AERIAL_NIGHT_MIX.toFixed(2)} * smoothstep(0.5, 1.0, uNight));
        base = mix(base, photoCol, photoW);
      }
    }
  #endif
  if (vWin > 0.5 && vWin < 3.5 && abs(N.y) < 0.5) {
    vec2 t = normalize(vec2(-N.z, N.x) + 1e-5);
    float u = dot(vWorld.xz, t);
    vec2 spacing = vWin < 1.5 ? ${v2(WINDOW_STYLES.office.spacing)} : vWin < 2.5 ? ${v2(WINDOW_STYLES.home.spacing)} : ${v2(WINDOW_STYLES.industrial.spacing)};
    vec2 g = vec2(u, vWorld.y) / spacing;
    vec2 id = floor(g);
    vec2 f = fract(g);
    vec2 lo = vWin < 1.5 ? ${v2(WINDOW_STYLES.office.margin)} : ${v2(WINDOW_STYLES.home.margin)};
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
      float litFrac = vWin < 1.5 ? ${WINDOW_STYLES.office.lit.toFixed(3)} : ${WINDOW_STYLES.home.lit.toFixed(3)};
      float lit = step(hsh, litFrac);
      vec3 warm = mix(vec3(1.0, 0.7, 0.38), vec3(0.75, 0.85, 1.0), step(0.8, fract(hsh * 7.0))) * 1.5;
      // Window LOD keeps the facade's average brightness at every range:
      //  near: individual lit windows; mid: 4 × 3-window blocks lit at a random fraction (floors /
      //  offices with the lights on); far: the spatial average (windowGlowAverage). Averages match,
      //  so the CBD does not dim with distance.
      vec3 avg = vWin < 1.5 ? ${v3(windowGlowAverage('office'))} : ${v3(windowGlowAverage('home'))};
      vec2 bid = floor(g / vec2(4.0, 3.0));
      float bh = hash12(bid + floor(vWorld.xz / 41.0) * 3.0);
      float blockLit = clamp(bh * bh * 2.2, 0.0, 1.0) / 0.5508; // mean 1 over blocks
      vec3 blockCol = mix(vec3(1.0, 0.7, 0.38), vec3(0.75, 0.85, 1.0), step(0.8, fract(bh * 5.0))) * 1.5;
      float detail2 = 1.0 - smoothstep(0.35, 0.9, mpp / (spacing.y * 3.0));
      vec3 mid = mix(avg, avg * blockLit * blockCol / ${v3(LIT_WINDOW_MEAN)}, detail2);
      emissive += uNight * mix(mid, warm * win * lit, detail);
    }
  } else if (vWin > 9.5) {
    // floodlit stone (aWin 10, the War Memorial Museum): plain walls by day, washed warm white by floodlights at night
    if (uNight > 0.0 && abs(N.y) < 0.5) emissive += uNight * base * vec3(1.0, 0.92, 0.78) * 0.55;
  } else if (vWin > 7.5 && abs(N.y) < 0.5) {
    // the CBD tower kit's facades (core/cbdTowers.ts): aWin 8 curtain-wall glass on a 1.5 m × 3.8 m storey grid with a dark
    // spandrel at each slab; aWin 9 ribbon windows between precast bands (1.5 m band, 2.1 m glass, mullions every 1.8 m).
    // Both blend to their average once a storey is a few pixels; at night office floors lit as the office grid (window LOD)
    bool curtain = vWin < 8.5;
    vec2 t = normalize(vec2(-N.z, N.x) + 1e-5);
    vec2 cell = curtain ? vec2(1.5, 3.8) : vec2(1.8, 3.6);
    vec2 g = vec2(dot(vWorld.xz, t), vWorld.y) / cell;
    vec2 f = fract(g);
    vec2 aa = vec2(mpp) / cell;
    float detail = 1.0 - smoothstep(0.35, 0.9, mpp / cell.y);
    vec3 sky = atmoSky(normalize(reflect(normalize(vWorld - uCamPos), N) + vec3(0.0, 0.25, 0.0)));
    float band;
    float mull;
    vec3 glass;
    if (curtain) {
      band = 1.0 - smoothstep(0.2 - aa.y, 0.2 + aa.y, f.y);
      mull = smoothstep(0.93 - aa.x, 0.93 + aa.x, abs(f.x - 0.5) * 2.0);
      glass = mix(base * 0.7, sky * 0.75, 0.5);
      vec3 spandrel = base * 0.55;
      vec3 face = mix(mix(glass, base * 0.9, mull * 0.6), spandrel, band);
      vec3 avg = mix(glass, spandrel, 0.2);
      base = mix(avg, face, detail);
    } else {
      band = 1.0 - smoothstep(0.42 - aa.y, 0.42 + aa.y, f.y);
      mull = smoothstep(0.92 - aa.x, 0.92 + aa.x, abs(f.x - 0.5) * 2.0);
      glass = mix(vec3(0.12, 0.15, 0.18), sky * 0.5, 0.45);
      vec3 face = mix(mix(glass, base * 0.8, mull), base, band);
      vec3 avg = mix(glass, base, 0.5);
      base = mix(avg, face, detail);
    }
    if (uNight > 0.0) {
      vec2 id = floor(g);
      float hsh = hash12(id + floor(vWorld.xz / 37.0) * 7.0);
      float lit = step(hsh, ${WINDOW_STYLES.office.lit.toFixed(3)}) * (1.0 - band);
      vec3 warm = mix(vec3(1.0, 0.7, 0.38), vec3(0.75, 0.85, 1.0), step(0.8, fract(hsh * 7.0))) * 1.5;
      vec3 avg = ${v3(windowGlowAverage('office'))};
      emissive += uNight * mix(avg, warm * lit, detail);
    }
  } else if (vWin > 6.5 && vWin < 7.5) {
    // balcony bands (aWin 7, the Scene apartments): a white slab edge (0.45 m) every 3.2 m storey, frosted balustrades
    // and dark glazing between; blends to the band's average once a storey is a few pixels; some bays lit at night
    float y = fract(vWorld.y / 3.2);
    float aa = mpp / 3.2;
    float slab = 1.0 - smoothstep(0.14 - aa, 0.14 + aa, y);
    float rail = smoothstep(0.14 - aa, 0.14 + aa, y) * (1.0 - smoothstep(0.45 - aa, 0.45 + aa, y));
    float detail = 1.0 - smoothstep(0.35, 0.9, mpp / 3.2);
    vec3 sky = atmoSky(normalize(reflect(normalize(vWorld - uCamPos), N) + vec3(0.0, 0.25, 0.0)));
    vec3 glass = mix(vec3(0.16, 0.2, 0.23), sky * 0.5, 0.4);
    vec3 band = mix(glass, mix(glass, vec3(0.62, 0.69, 0.72), 0.6), rail);
    base = mix(mix(base, band, 0.55), mix(band, base, slab), detail);
    if (uNight > 0.0) {
      vec2 t = normalize(vec2(-N.z, N.x) + 1e-5);
      vec2 id = floor(vec2(dot(vWorld.xz, t) / 4.0, vWorld.y / 3.2));
      float lit = step(hash12(id + floor(vWorld.xz / 37.0) * 7.0), 0.3) * (1.0 - slab);
      emissive += uNight * mix(vec3(0.22, 0.16, 0.09), vec3(1.0, 0.7, 0.38) * 1.5 * lit, detail);
    }
  } else if (vWin > 5.5) {
    // curtain-wall glass (aWin 6): sky reflections between the mullions of a 3 m × 2.7 m grid by day;
    // at night lit from inside, panel columns warm white or the arena's purple
    vec2 t = normalize(vec2(-N.z, N.x) + 1e-5);
    vec2 g = vec2(dot(vWorld.xz, t) / 3.0, vWorld.y / 2.7);
    vec2 f = abs(fract(g) - 0.5) * 2.0;
    vec2 aa = vec2(mpp / 3.0, mpp / 2.7) * 2.0;
    vec2 bar = smoothstep(1.0 - vec2(0.12, 0.09) - aa, 1.0 - vec2(0.12, 0.09) + aa, f);
    float frame = max(bar.x, bar.y) * (1.0 - smoothstep(0.4, 1.0, mpp / 2.7));
    vec3 sky = atmoSky(normalize(reflect(normalize(vWorld - uCamPos), N) + vec3(0.0, 0.25, 0.0)));
    vec3 glass = mix(base * 0.6, sky * 0.6, 0.45);
    base = mix(glass, vec3(0.62, 0.65, 0.67), frame);
    if (uNight > 0.0) {
      float col = hash12(vec2(floor(g.x), 3.0));
      vec3 inside = mix(vec3(1.0, 0.62, 0.3), vec3(0.42, 0.12, 1.0), step(0.45, col)) * (0.5 + 0.5 * hash12(floor(g) + 7.0));
      emissive += uNight * inside * (1.0 - frame * 0.9) * 0.55;
    }
  } else if (vWin > 4.5) {
    // ribbed sheet metal (aWin 5): a bright seam every 0.63 m across the face's fall line (the ribs run
    // down a sloped roof and up a wall), blending into the sheet's average once a rib is under a pixel
    vec2 t = normalize(vec2(-N.z, N.x) + 1e-5);
    float seam = pow(0.5 + 0.5 * cos(6.2831853 * dot(vWorld.xz, t) / 0.63), 6.0);
    // (the mean of the seam profile is 924 / 4096: the sheet's colour on average stays its own)
    base *= 1.0 + 0.35 * (mix(seam, 0.2256, smoothstep(0.2, 0.6, mpp / 0.63)) - 0.2256);
  } else if (vWin > 3.5) {
    emissive += base * uNight * 1.6;
  }
  vec3 lit = atmoDiffuse(base, N, 1.0);
  #ifdef AERIAL
    // the photo's low-sun light, as on the terrain photo round these tops (#61 item 5)
    lit += base * uSunColor * (aerialLowSun() * aerialHouseShare(distance(vWorld, uCamPos)) * photoW * 0.3183099);
  #endif
  vec3 col = atmoNight(lit);
  col = atmoApplyFog(col, vWorld);
  // lit windows pierce the haze more than lit surfaces do (like the terrain's street lights)
  col += emissive * (1.0 - atmoFogFactor(distance(vWorld, uCamPos) * 0.45, uCamPos.y, vWorld.y));
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/**
 * `aerial`: the aerial photo's uniforms (TerrainRenderer aerialUniforms): upward faces inside its
 * square take the photo's colour (the OSM wharf decks, the sheds' and the naval base's roofs).
 */
export function createBuildingMaterial(
  atmo: AtmosphereUniforms,
  opts: {
    houses?: boolean;
    aerial?: { uAerial: { value: Texture }; uAerialRect: { value: Vector4 }; uAerialGrade: { value: Vector4 }; uAerialHouseR: { value: number } };
  } = {},
): ShaderMaterial {
  const defines: Record<string, number> = {};
  if (opts.houses) defines.HOUSES = 1;
  if (opts.aerial) defines.AERIAL = 1;
  return new ShaderMaterial({
    name: opts.houses ? 'WorldHouses' : opts.aerial ? 'WorldBuildingAerial' : 'WorldBuilding',
    vertexShader: buildingVertex,
    fragmentShader: buildingFragment,
    uniforms: { ...atmo, ...(opts.aerial ?? {}) },
    vertexColors: true,
    defines,
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
  vec3 col = atmoNight(atmoDiffuse(t.rgb, vec3(0.0, 1.0, 0.0), 1.0));
  col = atmoApplyFog(col, vWorld);
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const roadVertex = /* glsl */ `
${ATMOSPHERE_GLSL}
varying vec3 vWorld;
varying vec2 vUv;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  // Lift with distance: coarse terrain LODs deviate from the fine heights the ribbon follows.
  float dist = distance(w.xyz, uCamPos);
  w.y += dist * 0.0016;
  vWorld = w.xyz;
  vUv = uv;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

/** Motorway ribbons: decal material whose vertices rise slightly with distance. */
/** Sodium glow of a lit road ribbon at night (× uNight), and the lamp spacing along it (m). */
export const ROAD_NIGHT_GLOW = 0.075;
const ROAD_LAMP_SPACING = 60;

// The road ribbons (decalFragment) plus, at night on the lit roads (uLit 1: motorways and arterials, not
// the railways), the sodium light of their lamp posts on the asphalt: pools every lamp spacing along
// the ribbon (v runs in 40 m units), so a lit motorway reads as a warm line from the air (#61 item 6).
const roadFragment = /* glsl */ `
${ATMOSPHERE_GLSL}
uniform sampler2D uMap;
uniform float uLit;
varying vec3 vWorld;
varying vec2 vUv;
void main() {
  vec4 t = texture2D(uMap, vUv);
  vec3 col = atmoNight(atmoDiffuse(t.rgb, vec3(0.0, 1.0, 0.0), 1.0));
  col = atmoApplyFog(col, vWorld);
  if (uLit * uNight > 0.0) {
    float d = distance(vWorld, uCamPos);
    float pool = 0.45 + 0.55 * pow(abs(cos(vUv.y * ${(Math.PI * 40 / ROAD_LAMP_SPACING).toFixed(5)})), 6.0);
    // pools blur into an even glow with distance (no shimmer)
    pool = mix(pool, 0.62, smoothstep(300.0, 1500.0, d));
    vec3 sodium = vec3(1.0, 0.6, 0.26) * ${ROAD_NIGHT_GLOW.toFixed(3)} * pool * (0.6 + 0.8 * t.g);
    col += sodium * uLit * uNight * (1.0 - atmoFogFactor(d * 0.45, uCamPos.y, vWorld.y));
  }
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/** Road and railway ribbons; `lit` roads glow with their street lights at night (not the railways). */
export function createRoadMaterial(atmo: AtmosphereUniforms, map: Texture, lit = false): ShaderMaterial {
  return new ShaderMaterial({
    name: 'WorldRoad',
    vertexShader: roadVertex,
    fragmentShader: roadFragment,
    uniforms: { ...atmo, uMap: { value: map }, uLit: { value: lit ? 1 : 0 } },
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -4,
  });
}

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

const signVertex = /* glsl */ `
varying vec3 vWorld;
varying vec3 vNormal;
varying vec2 vUv;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  vNormal = normalize(mat3(modelMatrix) * normal);
  vUv = uv;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

const signFragment = /* glsl */ `
${ATMOSPHERE_GLSL}
uniform sampler2D uMap;
uniform vec3 uDayInk;
uniform vec3 uNightInk;
varying vec3 vWorld;
varying vec3 vNormal;
varying vec2 vUv;
void main() {
  vec4 t = texture2D(uMap, vUv);
  float a = max(t.r, t.g);
  if (a < 0.4) discard;
  // red channel = letters (cream by day, purple LED at night), green = the white mark
  vec3 ink = mix(uDayInk, uNightInk, smoothstep(0.2, 0.8, uNight));
  vec3 base = mix(ink, vec3(1.0), clamp(t.g / a, 0.0, 1.0));
  vec3 col = atmoNight(atmoDiffuse(base, normalize(vNormal), 1.0));
  col = atmoApplyFog(col, vWorld);
  col += base * (0.12 + 1.6 * uNight) * (1.0 - atmoFogFactor(distance(vWorld, uCamPos) * 0.45, uCamPos.y, vWorld.y));
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/**
 * Lit sign letters on a building (Spark Arena): a canvas texture whose red channel is the letters and
 * green channel a white mark, alpha-tested; the letters glow a little by day and brightly at night
 * (`dayInk` / `nightInk`, linear RGB).
 */
export function createSignMaterial(atmo: AtmosphereUniforms, map: Texture, dayInk: Color, nightInk: Color): ShaderMaterial {
  return new ShaderMaterial({
    name: 'WorldSign',
    vertexShader: signVertex,
    fragmentShader: signFragment,
    uniforms: { ...atmo, uMap: { value: map }, uDayInk: { value: dayInk }, uNightInk: { value: nightInk } },
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
  vec3 col = atmoNight(vColor * (uSunColor * max(ndl, 0.0) + hemi) * 0.3183099);
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

/**
 * Minimum opacity of a sub-pixel light, by fixture size (m): small runway / taxiway edge lights fade
 * out with range, floodlights / towers / strobes stay visible from far away.
 */
export const LIGHT_FADE = { small: 0.05, bright: 0.35, from: 3.3, to: 5.0 } as const;

export function lightMinAlpha(size: number): number {
  const t = Math.min(1, Math.max(0, (size - LIGHT_FADE.from) / (LIGHT_FADE.to - LIGHT_FADE.from)));
  return LIGHT_FADE.small + (LIGHT_FADE.bright - LIGHT_FADE.small) * t * t * (3 - 2 * t);
}

const lightsVertex = /* glsl */ `
${ATMOSPHERE_GLSL}
attribute vec3 aColor;
attribute vec2 aSizeBlink; // size (m), blink phase (−1 = steady)
uniform float uPixelScale; // viewport height (px) / (2·tan(fov/2))
uniform float uPixelRatio;
uniform float uIntensity;
uniform float uNearFade; // > 0: fade lights out closer than this (m) — far-field city carpet
uniform float uFar;
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
  // Sub-pixel lights keep a minimum brightness that depends on how bright the fixture is: small
  // runway / taxiway edge lights fade out with range (no solid line on the horizon), floodlights,
  // towers and strobes stay visible from far away.
  float minA = mix(${LIGHT_FADE.small.toFixed(3)}, ${LIGHT_FADE.bright.toFixed(3)}, smoothstep(${LIGHT_FADE.from.toFixed(2)}, ${LIGHT_FADE.to.toFixed(2)}, aSizeBlink.x));
  vAlpha = uIntensity * blink * (1.0 - fog) * clamp(pow(px / 1.6, 0.8), minA, 1.0) * uFar;
  float nearFade = smoothstep(uNearFade * 0.5, uNearFade, dist);
  vAlpha *= mix(1.0, nearFade, step(0.5, uNearFade));
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
    uniforms: { ...atmo, uPixelScale: { value: 400 }, uPixelRatio: { value: 1 }, uIntensity: { value: 1 }, uNearFade: { value: 0 }, uFar: { value: 1 } },
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
  });
}
