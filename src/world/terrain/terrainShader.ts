/**
 * Terrain GLSL: CDLOD vertex shader (heights fetched from an R32F mip pyramid, geomorphing between
 * LOD levels) and a splatting fragment shader (baked colour map + slope rock + altitude snow +
 * canopy + multi-scale detail textures, baked soft sun shadows, shared atmosphere fog).
 */
import { ATMOSPHERE_GLSL } from '../sky/atmosphere';

export const MAX_TERRAIN_LODS = 16;

export const terrainVertexShader = /* glsl */ `
${ATMOSPHERE_GLSL}
attribute vec4 aPatch; // xz origin (m), lod, unused
uniform highp sampler2D uHeight;
uniform vec4 uHf; // origin, cell, n, max mip
uniform vec2 uMorph[${MAX_TERRAIN_LODS}]; // morph start, 1/(end-start)
varying vec3 vWorld;
varying vec2 vUv;

float hFetch(ivec2 p, int lod) {
  int size = max(1, int(uHf.z + 0.5) >> lod);
  p = clamp(p, ivec2(0), ivec2(size - 1));
  return texelFetch(uHeight, p, lod).r;
}

float hBilinear(vec2 wp, int lod) {
  float sp = uHf.y * exp2(float(lod));
  vec2 g = (wp - uHf.x) / sp;
  vec2 gi = floor(g);
  vec2 f = g - gi;
  ivec2 i = ivec2(gi);
  float a = hFetch(i, lod);
  float b = hFetch(i + ivec2(1, 0), lod);
  float c = hFetch(i + ivec2(0, 1), lod);
  float d = hFetch(i + ivec2(1, 1), lod);
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

void main() {
  int lod = int(aPatch.z + 0.5);
  float sp = uHf.y * exp2(aPatch.z);
  vec2 grid = position.xz;
  vec2 wp = aPatch.xy + grid * sp;
  ivec2 gi = ivec2(floor((wp - uHf.x) / sp + 0.5));
  float h = hFetch(gi, lod);
  float dist = distance(uCamPos, vec3(wp.x, h, wp.y));
  vec2 mp = uMorph[lod];
  float k = clamp((dist - mp.x) * mp.y, 0.0, 1.0);
  vec2 odd = fract(grid * 0.5) * 2.0;
  wp -= odd * sp * k;
  int lod1 = min(lod + 1, int(uHf.w + 0.5));
  h = mix(hBilinear(wp, lod), hBilinear(wp, lod1), k);
  // Push the sea floor well below the water plane (depth-buffer precision at long range); the
  // water shader decides the visible coastline from the exact height.
  if (h < 0.0) h = h * 1.5 - 2.0 - dist * 0.004 - dist * dist * 3e-8;
  vWorld = vec3(wp.x, h, wp.y);
  vUv = (wp - uHf.x) / (uHf.y * uHf.z);
  gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0);
}
`;

export const terrainFragmentShader = /* glsl */ `
${ATMOSPHERE_GLSL}
uniform sampler2D uSurface;
uniform sampler2D uColor;
uniform sampler2D uDetail;
uniform sampler2D uDetailN;
uniform vec2 uHalfTexel; // surface, colour
uniform vec3 uRockColor;
uniform vec3 uSnowColor;
uniform float uSnowLine;
uniform float uRockSlope;
uniform float uOutside; // half extent of the heightfield (m)
uniform vec3 uOutsideColor;
uniform float uFields; // strength of the procedural paddock pattern (0 = none)
uniform vec3 uRoofA;
uniform vec3 uRoofB;
uniform vec3 uRoofC;
uniform vec3 uGarden;
varying vec3 vWorld;
varying vec2 vUv;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

mat2 rot2(float a) {
  float c = cos(a);
  float s = sin(a);
  return mat2(c, -s, s, c);
}

// Distance (m) to the nearest cell border of a grid with cell size sz, given coordinates in metres.
float edgeDist(vec2 p, vec2 sz) {
  vec2 f = fract(p / sz);
  vec2 e = min(f, 1.0 - f) * sz;
  return min(e.x, e.y);
}

// Jittered-grid Voronoi "district": xy = centre, z = hash, w = distance to the district border (m).
vec4 district(vec2 wp, float size) {
  vec2 g = floor(wp / size);
  float b1 = 1e12;
  float b2 = 1e12;
  vec3 res = vec3(0.0);
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 cc = g + vec2(float(i), float(j));
      vec2 cp = (cc + 0.2 + 0.6 * vec2(hash12(cc), hash12(cc + 31.7))) * size;
      vec2 dv = wp - cp;
      float d = dot(dv, dv);
      if (d < b1) {
        b2 = b1;
        b1 = d;
        res = vec3(cp, hash12(cc + 7.3));
      } else if (d < b2) {
        b2 = d;
      }
    }
  }
  return vec4(res, 0.5 * (sqrt(b2) - sqrt(b1)));
}

// Suburbs / city from altitude: arterial roads, street grid, lots, roofs, gardens and street
// trees. Level of detail driven by the pixel footprint (mpp = metres per pixel). At night the
// streets glow with sodium lamps and some windows are lit (emissive out).
vec3 urbanPattern(vec3 base, vec2 wp, float dens, float mpp, out vec3 emissive) {
  vec4 dist = district(wp, 1300.0);
  vec2 p = rot2(dist.z * 6.2831) * (wp - dist.xy);
  vec2 blockSz = vec2(105.0, 76.0);
  vec2 bid = floor(p / blockSz);
  float bh = hash12(bid + dist.z * 91.0);
  float road = 1.0 - smoothstep(3.5 - mpp * 0.5, 3.5 + mpp * 0.5, edgeDist(p, blockSz));
  float arterial = 1.0 - smoothstep(7.0 - mpp * 0.6, 7.0 + mpp * 0.6, dist.w);
  vec2 lotSz = blockSz / vec2(6.0, 2.0);
  vec2 lid = floor(p / lotSz);
  float lh = hash12(lid + 17.0 + dist.z * 13.0);
  vec2 lf = fract(p / lotSz);
  vec2 inset = mix(vec2(0.17, 0.28), vec2(0.06, 0.08), dens);
  vec2 aa = vec2(mpp) / lotSz;
  vec2 bx = smoothstep(inset - aa, inset + aa, lf) * smoothstep(inset - aa, inset + aa, 1.0 - lf);
  float built = step(lh, 0.62 + 0.38 * dens) * bx.x * bx.y;
  vec3 roof = lh < 0.3 ? uRoofA : lh < 0.66 ? uRoofB : uRoofC;
  roof *= 0.8 + 0.45 * fract(lh * 7.3);
  vec3 garden = uGarden * (0.85 + 0.3 * bh);
  // street trees / garden trees: dark clumps in the yards
  float tree = step(0.55, hash12(floor(p / 9.0) + 3.1)) * (1.0 - built) * (1.0 - dens * 0.7);
  garden *= 1.0 - 0.45 * tree * (1.0 - smoothstep(1.0, 4.0, mpp));
  vec3 lotCol = mix(garden, roof, built);
  float park = step(0.95 - dens * 0.04, bh);
  vec3 parkCol = uGarden * (0.6 + 0.18 * step(0.5, hash12(floor(p / 14.0))));
  lotCol = mix(lotCol, parkCol, park);
  vec3 asphalt = vec3(0.075, 0.075, 0.08);
  vec3 avgRoof = (uRoofA + uRoofB + uRoofC) / 3.0;
  vec3 avgLot = mix(uGarden * 0.78, avgRoof, 0.28 + 0.22 * dens);
  // mid-range: speckled roofs & tree canopy at ~12 m granularity instead of flat block colours
  float sp = hash12(floor(p / 12.0) + bid * 3.1);
  vec3 speckle = sp < 0.3 + 0.25 * dens ? avgRoof * (0.75 + 0.5 * fract(sp * 13.7)) : uGarden * (0.62 + 0.35 * fract(sp * 7.1));
  vec3 midCol = mix(mix(speckle, avgLot, smoothstep(4.0, 12.0, mpp)), parkCol, park);
  vec3 lots = mix(lotCol, midCol, smoothstep(1.2, 4.5, mpp));
  vec3 far = mix(avgLot, asphalt, 0.1 + 0.08 * dens) * (0.92 + 0.16 * hash12(floor(wp / 700.0)));
  float roads = max(road * (1.0 - smoothstep(3.0, 14.0, mpp)), arterial * 0.8 * (1.0 - smoothstep(6.0, 22.0, mpp)));
  vec3 col = mix(lots, mix(asphalt, far, smoothstep(2.0, 12.0, mpp) * 0.5), roads);
  col = mix(col, far * (0.94 + 0.12 * bh), smoothstep(10.0, 40.0, mpp));
  emissive = vec3(0.0);
  if (uNight > 0.0) {
    // street lamps: dots every ~32 m along the roads, arterials brighter; lit windows in lots
    vec2 q = fract(p / 32.0) - 0.5;
    float lampDot = exp(-dot(q, q) * 32.0 * 32.0 / max(9.0, mpp * mpp * 2.0));
    float nearLamps = (road + arterial) * lampDot * (1.0 - smoothstep(6.0, 18.0, mpp));
    float avgLamps = (0.018 + 0.1 * arterial * (1.0 - smoothstep(20.0, 80.0, mpp))) * dens * (0.7 + 0.6 * bh);
    float lamps = mix(nearLamps * 2.5, avgLamps, smoothstep(3.0, 18.0, mpp));
    float windows = built * step(lh, 0.3) * (1.0 - smoothstep(1.5, 5.0, mpp)) * 0.3 + 0.012 * dens * smoothstep(1.5, 5.0, mpp);
    emissive = (vec3(1.0, 0.56, 0.2) * lamps + vec3(1.0, 0.75, 0.45) * windows) * uNight * clamp(dens * 1.5, 0.0, 1.0);
  }
  return mix(base, col, clamp(dens * 1.5, 0.0, 1.0));
}

// Rural paddocks with darker hedgerows / shelter belts, oriented per farm district.
vec3 fieldPattern(vec3 base, vec2 wp, float mpp) {
  vec4 dist = district(wp, 2600.0);
  vec2 p = rot2(dist.z * 6.2831) * (wp - dist.xy);
  vec2 sz = vec2(230.0, 165.0) * (0.8 + 0.4 * fract(dist.z * 5.1));
  vec2 id = floor(p / sz);
  float h = hash12(id + dist.z * 37.0);
  vec3 tint = h < 0.1 ? vec3(1.12, 1.02, 0.78) : h < 0.2 ? vec3(0.86, 0.92, 0.82) : vec3(0.88 + 0.18 * h, 0.9 + 0.12 * fract(h * 3.7), 0.9);
  float hedge = 1.0 - smoothstep(2.5 - mpp * 0.5, 2.5 + mpp * 0.5, edgeDist(p, sz));
  hedge = max(hedge, 1.0 - smoothstep(4.0 - mpp * 0.5, 4.0 + mpp * 0.5, dist.w));
  vec3 col = base * tint;
  col = mix(col, base * vec3(0.42, 0.55, 0.4), hedge * step(0.3, fract(h * 11.0)) * (1.0 - smoothstep(4.0, 16.0, mpp)));
  return mix(col, base, smoothstep(25.0, 70.0, mpp));
}

void main() {
  vec4 s = texture2D(uSurface, vUv + uHalfTexel.x);
  vec3 N = vec3(s.r * 2.0 - 1.0, 0.0, s.g * 2.0 - 1.0);
  N.y = sqrt(max(0.02, 1.0 - dot(N.xz, N.xz)));
  vec4 c = texture2D(uColor, vUv + uHalfTexel.y);
  vec3 albedo = c.rgb;
  float forest = c.a < 0.5 ? c.a * 2.0 : 0.0;
  float urban = c.a >= 0.5 ? clamp(c.a * 2.0 - 1.0, 0.0, 1.0) : 0.0;
  vec3 toCam = vWorld - uCamPos;
  float dist = length(toCam);
  vec2 wp = vWorld.xz;
  // metres per pixel (footprint) for pattern anti-aliasing
  float mpp = max(length(dFdx(wp)), length(dFdy(wp)));

  // Past the heightfield the (clamped) colour map would streak: fade to a flat outside colour.
  float outside = smoothstep(uOutside - 3000.0, uOutside, max(abs(wp.x), abs(wp.y)));
  albedo = mix(albedo, uOutsideColor, outside);

  vec4 dA = texture2D(uDetail, wp * (1.0 / 523.0));
  vec4 dB = texture2D(uDetail, wp * (1.0 / 71.0));
  vec4 dC = texture2D(uDetail, wp * (1.0 / 13.3));
  float nearB = 1.0 - smoothstep(2500.0, 9000.0, dist);
  float nearC = 1.0 - smoothstep(200.0, 1300.0, dist);
  float slope = 1.0 - N.y;

  float natural = 1.0 - urban;
  albedo *= mix(1.0, (0.86 + 0.28 * dA.g) * mix(1.0, 0.86 + 0.28 * dB.r, nearB) * mix(1.0, 0.9 + 0.2 * dC.r, nearC), natural);

  if (uFields > 0.0) {
    float fw = uFields * natural * (1.0 - forest) * (1.0 - smoothstep(0.06, 0.16, slope)) * step(2.0, vWorld.y);
    if (fw > 0.01) albedo = mix(albedo, fieldPattern(albedo, wp, mpp), fw);
  }
  vec3 emissive = vec3(0.0);
  if (urban > 0.01) albedo = urbanPattern(albedo, wp, urban, mpp, emissive);

  float rockW = smoothstep(uRockSlope, uRockSlope + 0.09, slope + (dA.b - 0.5) * 0.12 + (dB.g - 0.5) * 0.05 * nearB) * natural;
  vec3 rock = uRockColor * (0.68 + 0.6 * mix(dA.b, dB.b, nearB * 0.7));
  albedo = mix(albedo, rock, rockW * (1.0 - outside));

  float snowH = smoothstep(uSnowLine - 140.0, uSnowLine + 140.0, vWorld.y + (dA.g - 0.5) * 520.0 + (dB.r - 0.5) * 60.0 * nearB);
  float snowW = snowH * (1.0 - smoothstep(0.38, 0.6, slope + (dB.r - 0.5) * 0.12));
  albedo = mix(albedo, uSnowColor * (0.93 + 0.07 * dB.r), snowW);

  // Forest canopy: darker, clumpy close up (crowns lit on one side)
  float canopy = forest * (0.18 + 0.32 * dB.a * nearB + 0.2 * dC.a * nearC);
  albedo *= 1.0 - canopy;

  // Detail bump
  vec3 dn = texture2D(uDetailN, wp * (1.0 / 71.0)).xyz * 2.0 - 1.0;
  vec3 dn2 = texture2D(uDetailN, wp * (1.0 / 13.3)).xyz * 2.0 - 1.0;
  float bump = (0.3 + 0.6 * rockW + 0.5 * forest) * nearB * natural;
  N = normalize(N + vec3(dn.x, 0.0, dn.y) * bump + vec3(dn2.x, 0.0, dn2.y) * 0.35 * nearC * natural);

  vec3 col = atmoDiffuse(albedo, N, s.a);
  col = atmoApplyFog(col, vWorld);
  // Night lights pierce the haze more than lit surfaces do
  col += emissive * (1.0 - atmoFogFactor(dist * 0.5, uCamPos.y, vWorld.y));
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;
