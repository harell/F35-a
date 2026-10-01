/**
 * Terrain GLSL: CDLOD vertex shader (heights fetched from an R32F mip pyramid, geomorphing between
 * LOD levels) and a splatting fragment shader (baked colour map with a noise-jittered lookup +
 * slope rock + altitude snow + canopy + multi-scale detail textures, baked soft sun shadows, shared
 * atmosphere fog).
 *
 * Coastline: the water shader decides the visible shoreline from a 15 m signed-distance coast mask
 * (COAST_GLSL). For that to work the terrain must lie just below the water plane wherever the mask
 * may say "water": low coastal land (0–2.5 m) is sunk by ≈ 0.8 m near the camera (vertex shader),
 * and this shader paints the shore itself (sand / black sand / rock band, wet line) from the same
 * mask, so beaches are crisp at 15 m instead of 86 m colour-map texels.
 */
import { ATMOSPHERE_GLSL } from '../sky/atmosphere';
import { COAST_MASK_RANGE } from './coastline';
import { FOOTPATH } from '../scenery/cbdStreets';

export const MAX_TERRAIN_LODS = 16;
/** Volcanic cones the fragment shader can shade (crater bowls, flank terraces). */
export const MAX_CONES = 14;

/** Shared by terrain + water: signed coast distance (m, + land) from the 15 m mask. */
export const COAST_GLSL = /* glsl */ `
uniform sampler2D uCoastMask;
uniform vec4 uCoastRect; // x0, z0, 1/size, enabled
// Signed distance to the coast (m, + land) and the mask weight (0 outside the mask area).
float coastMaskSD(vec2 wp, out float w) {
  vec2 uv = (wp - uCoastRect.xy) * uCoastRect.z;
  float edge = min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y));
  w = uCoastRect.w * smoothstep(0.0, 0.025, edge);
  if (w <= 0.0) return 0.0;
  return (texture2D(uCoastMask, uv).r * 255.0 - 127.5) * ${(COAST_MASK_RANGE / 127.5).toFixed(6)};
}
// Fine shoreline wiggle (m) shared by the water and the terrain beach band.
float coastWiggle(sampler2D detail, vec2 wp) {
  return (texture2D(detail, wp * (1.0 / 57.0)).g - 0.5) * 9.0 + (texture2D(detail, wp * (1.0 / 211.0)).r - 0.5) * 8.0;
}
`;

export const terrainVertexShader = /* glsl */ `
${ATMOSPHERE_GLSL}
attribute vec4 aPatch; // xz origin (m), lod, unused
uniform highp sampler2D uHeight;
uniform vec4 uHf; // origin, cell, n, max mip
uniform vec2 uMorph[${MAX_TERRAIN_LODS}]; // morph start, 1/(end-start)
uniform float uSink; // 1 = sink low coastal land below the water plane near the camera
varying vec3 vWorld;
varying vec2 vUv;
varying float vH; // true (unsunk) terrain height

float hFetch(ivec2 p, int lod) {
  int size = max(1, int(uHf.z + 0.5) >> lod);
  p = clamp(p, ivec2(0), ivec2(size - 1));
  return texelFetch(uHeight, p, lod).r;
}

// Rendered height for a true height: low coastal land sinks slightly below the water plane (the
// water shader then draws the exact shoreline from the coast mask), the sea floor is pushed well
// below it (depth-buffer precision at long range). Continuous and monotonic in h; applied per
// texel so neighbouring LOD patches still meet exactly.
float renderH(float h, float dist) {
  float sink = uSink * (0.8 + min(3e-7 * dist * dist, 5.0)) * (1.0 - smoothstep(1.2, 2.5, h)) * (1.0 - smoothstep(3500.0, 5000.0, dist));
  // near the camera the first 0.6 m below sea level is not pushed down: that is where the coast
  // mask may still draw land (water discarded), which must not open a trench
  float d0 = uSink * -0.6 * (1.0 - smoothstep(3500.0, 5000.0, dist));
  float deep = h < 0.0 ? -0.5 * h + smoothstep(d0, d0 - 2.0, h) * (2.0 + dist * 0.004 + dist * dist * 3e-8) : 0.0;
  return h - sink - deep;
}

// Bilinear (true height, rendered height) at a world position on LOD grid 'lod'.
vec2 hBilinear(vec2 wp, int lod, float dist) {
  float sp = uHf.y * exp2(float(lod));
  vec2 g = (wp - uHf.x) / sp;
  vec2 gi = floor(g);
  vec2 f = g - gi;
  ivec2 i = ivec2(gi);
  float a = hFetch(i, lod);
  float b = hFetch(i + ivec2(1, 0), lod);
  float c = hFetch(i + ivec2(0, 1), lod);
  float d = hFetch(i + ivec2(1, 1), lod);
  float t = mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  float r = mix(mix(renderH(a, dist), renderH(b, dist), f.x), mix(renderH(c, dist), renderH(d, dist), f.x), f.y);
  return vec2(t, r);
}

void main() {
  int lod = int(aPatch.z + 0.5);
  float sp = uHf.y * exp2(aPatch.z);
  vec2 grid = position.xz;
  vec2 wp = aPatch.xy + grid * sp;
  ivec2 gi = ivec2(floor((wp - uHf.x) / sp + 0.5));
  float h0 = hFetch(gi, lod);
  float dist = distance(uCamPos, vec3(wp.x, h0, wp.y));
  vec2 mp = uMorph[lod];
  float k = clamp((dist - mp.x) * mp.y, 0.0, 1.0);
  vec2 odd = fract(grid * 0.5) * 2.0;
  wp -= odd * sp * k;
  int lod1 = min(lod + 1, int(uHf.w + 0.5));
  vec2 h = mix(hBilinear(wp, lod, dist), hBilinear(wp, lod1, dist), k);
  vH = h.x;
  vWorld = vec3(wp.x, h.y, wp.y);
  vUv = (wp - uHf.x) / (uHf.y * uHf.z);
  gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0);
}
`;

export const terrainFragmentShader = /* glsl */ `
${ATMOSPHERE_GLSL}
${COAST_GLSL}
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
uniform vec3 uRoofs[6];
uniform vec3 uGarden;
uniform vec3 uCanopy;
uniform vec3 uSuburbLeafy; // far-field suburb albedo, leafy / bare neighbourhoods (urbanColor.ts)
uniform vec3 uSuburbBare;
uniform vec3 uSand;
uniform vec3 uBlackSand;
uniform vec3 uShoreRock;
uniform vec3 uSeaShallow; // the water shader's shallow-water colour
uniform float uBlackSandX; // black sand west of this x (m)
uniform vec4 uVineyard; // ellipse centre x, z, radii x, z (m); radius 0 = none
uniform vec4 uCbd; // CBD street grid: centre x, z, radius (m), hash (angle = hash · 2π); radius 0 = none
uniform sampler2D uStreets; // CBD street map (cbdStreets.ts): kerb distance, region distance, park, motorway verge
uniform vec4 uStreetRect; // x0, z0, 1/width, 1/height (m); 1/width 0 = none
uniform vec4 uNoFieldA[6]; // airfield rects: centre x, z, cos / sin heading
uniform vec4 uNoFieldB[6]; // half width, half length, blend (m); 0 = unused
uniform vec4 uConeA[${MAX_CONES}]; // x, z, crater radius, crater depth (m)
uniform vec4 uConeB[${MAX_CONES}]; // cone radius, cone height (m), terraces (0/1); radius 0 = unused
uniform vec4 uConeBox; // xz bounds of all cones (min x, min z, max x, max z)
varying vec3 vWorld;
varying vec2 vUv;
varying float vH;

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

// CBD street map (cbdStreets.ts): x = distance to the nearest kerb (m, + off the street), y = signed
// distance to the CBD region border (m, + inside), z = park, w = motorway verge. Far outside the
// region: (32, −32, 0, 0).
vec4 streetMap(vec2 wp) {
  vec2 uv = (wp - uStreetRect.xy) * uStreetRect.zw;
  if (uStreetRect.z <= 0.0 || uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return vec4(32.0, -32.0, 0.0, 0.0);
  vec4 s = texture2D(uStreets, uv);
  return vec4((s.r * 255.0 - 128.0) * 0.25, (s.g * 255.0 - 128.0) * 0.25, s.b, s.a);
}

// Urban district: the CBD's own fixed grid inside uCbd, Voronoi districts elsewhere (urbanGrid.ts).
vec4 urbanDistrict(vec2 wp) {
  if (uCbd.z > 0.0) {
    float r = length(wp - uCbd.xy);
    if (r < uCbd.z) return vec4(uCbd.xy, uCbd.w, uCbd.z - r);
    vec4 d = district(wp, 1300.0);
    d.w = min(d.w, r - uCbd.z);
    return d;
  }
  return district(wp, 1300.0);
}

vec3 roofColor(float lh) {
  int k = int(floor(fract(lh * 5.1) * 5.999));
  return uRoofs[k] * (0.85 + 0.3 * fract(lh * 7.3));
}

// Canopy share of a dense built-up neighbourhood (urbanPattern's treeFrac for apartments).
float denseTreeFrac(float leafy) {
  return mix(0.3, 0.46, leafy) * 0.7 * 0.4;
}

// Auckland CBD with its real streets (inside the region of the LINZ street map, sm = streetMap()):
// asphalt carriageways and footpaths from the kerb distance field, paved / flat-roofed block interiors
// (the 3D buildings of buildCBD stand on them), lawns and trees in the parks. The far colour is the
// suburbs' dense-city average, so nothing changes at the region border from altitude.
vec3 cbdPattern(vec2 wp, float mpp, vec4 sm, out vec3 emissive) {
  vec3 asphalt = vec3(0.085, 0.086, 0.09);
  vec3 paving = vec3(0.28, 0.275, 0.26);
  vec3 flatAvg = vec3(0.3, 0.29, 0.27);
  float aa = max(mpp, 0.05);
  float kerb = sm.x;
  float leafy = smoothstep(0.2, 0.8, texture2D(uDetail, wp * (1.0 / 1730.0)).a);
  float off = smoothstep(${FOOTPATH.toFixed(1)}, ${(FOOTPATH + 2).toFixed(1)}, kerb);
  // parks, and the grassy embankments along the motorways (fewer trees)
  float verge = smoothstep(0.35, 0.65, sm.w) * off;
  float park = max(smoothstep(0.35, 0.65, sm.z) * off, verge);
  vec3 far = flatAvg * 0.6 + uCanopy * denseTreeFrac(leafy) + mix(asphalt, paving, 0.5) * 0.25;
  vec3 lawn = uGarden * 0.75 + uCanopy * 0.35;
  far = mix(far, lawn, park);
  // block interiors: plazas, car parks and flat roofs in ≈ 9 m patches
  float h = hash12(floor(wp / 9.0) + 71.3);
  vec3 block = mix(paving * (0.9 + 0.25 * h), flatAvg * (0.75 + 0.5 * fract(h * 3.7)), step(0.45, h));
  vec3 blockAvg = mix(paving * 1.02, flatAvg, 0.55);
  // mid range: the streets as coverage-weighted lines (fraction of the pixel footprint on asphalt)
  float w = max(mpp, 1.0);
  float roadCov = clamp((w * 0.5 - kerb) / w, 0.0, 1.0);
  float footCov = clamp((w * 0.5 - abs(kerb - ${(FOOTPATH / 2).toFixed(1)})) / w, 0.0, 1.0) * ${FOOTPATH.toFixed(1)} / max(w, ${FOOTPATH.toFixed(1)});
  vec3 mid = mix(mix(blockAvg, lawn, park), paving * 1.15, footCov * 0.8);
  mid = mix(mid, asphalt, roadCov * 0.9);
  vec3 col = mix(mix(mid, far, 0.4), far, smoothstep(16.0, 40.0, mpp));
  if (mpp < 8.0) {
    // park lawns with tree crowns (one per 14 m cell) and their shadows
    vec2 tc = floor(wp / 14.0);
    float th = hash12(tc + 5.7);
    vec2 tp = (tc + 0.3 + 0.4 * vec2(th, fract(th * 7.9))) * 14.0;
    float tr = 3.0 + 1.6 * fract(th * 3.3);
    vec2 tv = wp - tp;
    vec2 shOff = clamp(-uSunDir.xz / max(uSunDir.y, 0.18) * 5.5, -18.0, 18.0);
    float hasTree = step(fract(th * 11.3), 0.55 - 0.3 * verge) * park;
    float tree = hasTree * (1.0 - smoothstep(tr - aa * 0.6, tr + aa * 0.6, length(tv)));
    float tshadow = hasTree * (1.0 - smoothstep(tr - aa, tr + aa, length(tv - shOff * 0.8))) * (1.0 - tree);
    float tlit = mix(clamp(0.8 + 0.5 * dot(tv / tr, normalize(uSunDir.xz + 1e-4)), 0.5, 1.35), 0.95, smoothstep(2.0, 6.0, mpp));
    vec3 grass = uGarden * (0.84 + 0.2 * hash12(floor(wp / 3.0)));
    vec3 near = mix(block, grass * (1.0 - 0.45 * tshadow), park);
    near = mix(near, uCanopy * tlit, tree);
    float foot = 1.0 - smoothstep(${FOOTPATH.toFixed(1)} - aa * 0.5, ${FOOTPATH.toFixed(1)} + aa * 0.5, kerb);
    near = mix(near, paving * 1.15 * (0.95 + 0.1 * hash12(floor(wp / 1.5))), foot);
    // kerb line, then asphalt
    near = mix(near, paving * 0.75, (1.0 - smoothstep(0.0, aa + 0.3, abs(kerb - 0.15))) * (1.0 - smoothstep(2.0, 5.0, mpp)));
    float road = 1.0 - smoothstep(-aa * 0.5, aa * 0.5, kerb);
    near = mix(near, asphalt, road);
    col = mix(near, col, smoothstep(4.5, 8.0, mpp));
  }
  emissive = vec3(0.0);
  if (uNight > 0.0) {
    // street lamps are fixtures (buildCBD); here: lit shopfronts along the footpaths up close and the
    // area-average glow of the city centre further out
    float shop = (1.0 - smoothstep(${FOOTPATH.toFixed(1)}, ${(FOOTPATH + 4).toFixed(1)}, kerb)) * step(0.0, kerb) * (1.0 - park) * step(0.5, fract(h * 5.3));
    float shopGlow = shop * 0.12 * (1.0 - smoothstep(3.0, 10.0, mpp));
    float avg = 0.06 * (0.6 + 0.8 * h) * 1.1 * (1.0 - park * 0.8);
    float glow = mix(shopGlow, avg, smoothstep(3.0, 18.0, mpp));
    emissive = (vec3(1.0, 0.86, 0.66) * glow + vec3(1.0, 0.72, 0.42) * 0.03 * smoothstep(4.0, 12.0, mpp)) * uNight;
  }
  return col;
}

// Suburbs / city seen from the air. The street grid (Voronoi districts, 105 × 76 m blocks, 6 × 2
// lots) matches urbanGrid.ts / sources.ts, so the instanced 3D houses stand exactly on the painted
// ones and the transition between them is invisible.
//  near/mid (< 8 m/px): houses with sun-shaded gable roofs and cast shadows, flat-roofed
//                        apartments, driveways, garden and street trees with shadows, footpaths,
//                        streets — all anti-aliased by the pixel footprint so they dissolve into a
//                        fine roof / canopy texture with distance (no lot-sized colour squares)
//  mid  (8–40 m/px): one mixed colour per lot + coverage-weighted street lines
//  far  (> 16 m/px): fading into area-weighted roofs + canopy + paving (reads as city, not green fields)
// At night: street lamps along the roads, glowing windows, and a far-field average glow.
vec3 urbanPattern(vec3 base, vec2 wp, float dens, float mpp, vec4 sm, out vec3 emissive) {
  const vec2 BLOCK = vec2(105.0, 76.0);
  const vec2 LOT = vec2(17.5, 38.0);
  // CBD region: Auckland's real streets (the whole region is built up, whatever the colour map says)
  if (sm.y > 0.0) return cbdPattern(wp, mpp, sm, emissive);
  vec4 dist = urbanDistrict(wp);
  // the CBD region border is a district border (a street under the motorway that runs along it)
  dist.w = min(dist.w, -sm.y);
  float ang = dist.z * 6.2831;
  mat2 R = rot2(ang);
  vec2 p = R * (wp - dist.xy);
  vec2 sunL = R * uSunDir.xz;
  vec2 bid = floor(p / BLOCK);
  float bh = hash12(bid + dist.z * 91.0);
  float park = step(0.975 - dens * 0.03, bh);
  vec2 lid = floor(p / LOT);
  vec2 lf = fract(p / LOT);
  float lh = hash12(lid + 17.0 + dist.z * 13.0);
  float built = step(lh, 0.8 + 0.2 * dens) * (1.0 - park);
  float apt = step(0.9, dens);
  float roadD = edgeDist(p, BLOCK);
  float aa = max(mpp, 0.05);
  float road = 1.0 - smoothstep(3.6 - aa * 0.5, 3.6 + aa * 0.5, roadD);
  // District borders are ordinary streets where two grid orientations meet (no arterial width,
  // lane marks or extra lamps: painted on every jittered Voronoi border those read as cracked
  // paving from altitude). Real arterials are road ribbons (motorways.ts ARTERIALS).
  road = max(road, 1.0 - smoothstep(3.6 - aa * 0.5, 3.6 + aa * 0.5, dist.w));

  vec3 asphalt = vec3(0.085, 0.086, 0.09);
  vec3 paving = vec3(0.28, 0.275, 0.26);
  // lawns: some lush, some summer-dry, varying per lot
  float lawnH = fract(lh * 3.1);
  vec3 grass = uGarden * (0.84 + 0.24 * bh) * mix(vec3(1.0), lawnH < 0.25 ? vec3(1.12, 1.0, 0.72) : vec3(0.86, 0.9, 0.86), step(0.25, abs(lawnH - 0.5) * 2.0));
  // leafy and bare neighbourhoods (≈ 500 m scale)
  float leafy = smoothstep(0.2, 0.8, texture2D(uDetail, wp * (1.0 / 1730.0)).a);
  // Auckland canopy cover ≈ 30-45 % (leafy isthmus suburbs at the top end), less in the densest parts
  float treeFrac = mix(0.3, 0.46, leafy) * (1.0 - 0.3 * dens) * (1.0 - apt * 0.6);
  vec3 flatAvg = vec3(0.3, 0.29, 0.27);
  // Far: grey-green area average (canopy, NZ roofs, lawns, streets; precomputed on the CPU from the
  // palette), leafier / barer by neighbourhood, plus a per-block canopy / roof mottle (≈ 100 m) that
  // keeps a city grain at combat altitude and fades out before it would alias.
  vec3 far = mix(uSuburbBare, uSuburbLeafy, leafy);
  far = mix(far, uCanopy * 1.25, (bh - 0.5) * 0.45 * (1.0 - smoothstep(40.0, 160.0, mpp)));
  vec3 cbdFar = flatAvg * 0.6 + uCanopy * treeFrac + mix(asphalt, paving, 0.5) * 0.25;
  far = mix(far, cbdFar, apt);
  far = mix(far, uGarden * 0.75 + uCanopy * 0.35, park);
  // Mid range (≈ 8–40 m/px): one colour per lot on the real lot grid (roof share, lawn and garden
  // trees, random per lot) with the streets as coverage-weighted lines, so the suburbs read as rows
  // of houses along a street grid rather than as a mosaic of square colour cells.
  float lotTree = clamp(treeFrac * (0.6 + 0.8 * fract(lh * 5.3)), 0.0, 0.8);
  float lotRoof = built * mix(0.32 + 0.16 * fract(lh * 2.9), 0.62, apt);
  vec3 lotCol = mix(grass, uCanopy, lotTree);
  lotCol = mix(lotCol, mix(roofColor(lh), flatAvg * (0.75 + 0.5 * fract(lh * 3.7)), apt), lotRoof);
  lotCol = mix(lotCol, uGarden * 0.8 + uCanopy * 0.3, park);
  float w = max(mpp, 1.0);
  float roadCov = 7.2 / max(w, 7.2) * clamp((w * 0.5 + 3.6 - roadD) / min(w, 7.2), 0.0, 1.0);
  vec3 mid = mix(lotCol, mix(asphalt, paving, 0.35), roadCov * 0.9);
  vec3 col = mix(mix(mid, far, 0.4), far, smoothstep(16.0, 40.0, mpp));
  if (mpp < 8.0) {
    float row = mod(lid.y, 2.0);
    float h2 = fract(lh * 37.1);
    float h3 = fract(lh * 71.7);
    float h4 = fract(lh * 13.9);
    vec2 hc = apt > 0.5 ? vec2(0.5, 0.5) : vec2(0.5 + (h2 - 0.5) * 0.14, mix(0.34, 0.66, row));
    vec2 hs = apt > 0.5 ? vec2(0.78, 0.6 + 0.2 * h4) : vec2(0.5 + 0.24 * h3, 0.28 + 0.14 * h4);
    vec2 q = (lf - hc) * LOT;
    vec2 hh = hs * LOT * 0.5;
    vec2 e = hh - abs(q);
    float inHouse = built * smoothstep(-aa * 0.5, aa * 0.5, min(e.x, e.y));
    // gable roof shading (ridge along the long side); flat roofs with plant rooms on apartments
    float ridgeY = step(hh.x, hh.y);
    float sgn = ridgeY > 0.5 ? sign(q.x) : sign(q.y);
    vec2 nl = ridgeY > 0.5 ? vec2(sgn, 0.0) : vec2(0.0, sgn);
    vec3 rn = normalize(vec3(nl.x * 0.47, 0.88, nl.y * 0.47));
    float shade = clamp(0.5 + 0.55 * max(dot(rn, vec3(sunL.x, uSunDir.y, sunL.y)), 0.0) / max(uSunDir.y, 0.25), 0.45, 1.35);
    shade = mix(shade, 1.0, smoothstep(2.0, 6.0, mpp));
    vec3 roofCol = roofColor(lh) * shade;
    vec3 flatRoof = flatAvg * (0.75 + 0.5 * fract(lh * 3.7));
    vec2 box = abs(q - hh * vec2(0.3, -0.25)) - vec2(1.6, 1.3);
    float plant = 1.0 - smoothstep(-aa * 0.5, aa * 0.5, max(box.x, box.y));
    roofCol = mix(roofCol, mix(flatRoof, vec3(0.42, 0.42, 0.4), plant * 0.6), apt);
    // cast shadow of the house on its own lot
    vec2 shOff = clamp(-sunL / max(uSunDir.y, 0.18) * (apt > 0.5 ? 12.0 : 5.5), -18.0, 18.0);
    vec2 es = hh - abs(q - shOff);
    float shadow = built * (1.0 - inHouse) * smoothstep(-aa * 0.7, aa * 0.7, min(es.x, es.y));
    // driveway beside the house to the street, a garage / shed on 45 % of lots
    float side = h2 < 0.5 ? -1.0 : 1.0;
    vec2 gq = q - vec2(side * (hh.x + 1.9), (row < 0.5 ? 1.0 : -1.0) * (hh.y * 0.2));
    vec2 ge = vec2(2.9, 3.4) - abs(gq);
    float garage = built * (1.0 - apt) * step(fract(lh * 23.7), 0.45) * smoothstep(-aa * 0.5, aa * 0.5, min(ge.x, ge.y)) * (1.0 - inHouse);
    float toStreet = row < 0.5 ? -q.y : q.y;
    float drive = built * (1.0 - apt) * (1.0 - smoothstep(1.3 - aa * 0.5, 1.3 + aa * 0.5, abs(q.x - side * (hh.x + 1.9)))) * step(-hh.y * 0.3, toStreet);
    // garden / street trees: one crown per 14 m cell
    vec2 tc = floor(p / 14.0);
    float th = hash12(tc + 5.7 + dist.z * 3.1);
    vec2 tp = (tc + 0.3 + 0.4 * vec2(th, fract(th * 7.9))) * 14.0;
    float tr = 2.8 + 1.4 * fract(th * 3.3);
    float hasTree = step(fract(th * 11.3), treeFrac * 1.6 + park * 0.3);
    vec2 tv = p - tp;
    float tree = hasTree * (1.0 - smoothstep(tr - aa * 0.6, tr + aa * 0.6, length(tv))) * (1.0 - inHouse) * (1.0 - road);
    float tshadow = hasTree * (1.0 - smoothstep(tr - aa, tr + aa, length(tv - shOff * 0.8))) * (1.0 - tree);
    float tlit = mix(clamp(0.8 + 0.5 * dot(tv / tr, normalize(sunL + 1e-4)), 0.5, 1.35), 0.95, smoothstep(2.0, 6.0, mpp));
    vec3 ground = grass * (0.9 + 0.2 * hash12(floor(p / 3.0)));
    ground = mix(ground, paving, drive);
    ground *= 1.0 - 0.5 * max(shadow, tshadow * 0.8);
    vec3 near = mix(ground, roofCol, inHouse);
    near = mix(near, roofColor(fract(lh * 3.3)) * 0.95, garage);
    near = mix(near, uCanopy * tlit, tree);
    // parks: grass with sports-field stripes
    vec3 parkCol = uGarden * (0.8 + 0.12 * step(0.5, fract(p.x / 9.0)));
    near = mix(near, mix(parkCol, uCanopy * tlit, tree), park);
    // footpaths, kerbs and streets (lane marks on arterials)
    float foot = 1.0 - smoothstep(5.3 - aa * 0.5, 5.3 + aa * 0.5, roadD);
    near = mix(near, paving * 1.15, foot * (1.0 - tree));
    near = mix(near, asphalt, road);
    col = mix(near, col, smoothstep(4.5, 8.0, mpp));
  }

  emissive = vec3(0.0);
  if (uNight > 0.0) {
    // street lamps every ~32 m along roads (arterials brighter); lit windows glow on the lots
    vec2 lq = fract(p / 36.0) - 0.5;
    // widened with the pixel footprint (no aliasing) but dimmed as it widens, so lamps do not merge
    // into solid glowing street lines at mid range
    float lampDot = exp(-dot(lq, lq) * 36.0 * 36.0 / max(6.0, mpp * mpp * 2.0)) * min(1.0, 4.0 / max(mpp, 1.0));
    float nearLamps = road * 0.8 * lampDot * (1.0 - smoothstep(6.0, 18.0, mpp));
    float glowLots = built * step(lh, 0.45) * (1.0 - smoothstep(4.0, 12.0, mpp)) * 0.05;
    float avgLamps = 0.06 * (0.6 + 0.8 * bh) * (0.6 + 0.5 * dens);
    float lamps = mix(nearLamps * 1.6, avgLamps, smoothstep(3.0, 18.0, mpp));
    vec3 lampCol = mix(vec3(1.0, 0.58, 0.22), vec3(1.0, 0.86, 0.66), step(0.55, fract(dist.z * 17.0)));
    emissive = (lampCol * lamps + vec3(1.0, 0.72, 0.42) * (glowLots + 0.03 * dens * smoothstep(4.0, 12.0, mpp))) * uNight * clamp(dens * 2.5, 0.0, 1.0);
  }
  return mix(base, col, clamp(dens * 2.5, 0.0, 1.0));
}

// 0 on airfields (no paddock hedges across the grass between runways), 1 elsewhere.
float fieldMask(vec2 wp) {
  float m = 1.0;
  for (int i = 0; i < 6; i++) {
    vec4 b = uNoFieldB[i];
    if (b.x <= 0.0) continue;
    vec4 a = uNoFieldA[i];
    vec2 d = wp - a.xy;
    vec2 q = abs(vec2(d.x * a.z + d.y * a.w, d.x * a.w - d.y * a.z)) - b.xy;
    float dd = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0);
    m = min(m, smoothstep(0.0, b.z, dd));
  }
  return m;
}

// Rural paddocks with darker hedgerows / shelter belts, oriented per farm district; vineyards
// (rows of vines) on some fields inside uVineyard.
vec3 fieldPattern(vec3 base, vec2 wp, float mpp) {
  vec4 dist = district(wp, 2600.0);
  vec2 p = rot2(dist.z * 6.2831) * (wp - dist.xy);
  vec2 sz = vec2(230.0, 165.0) * (0.8 + 0.4 * fract(dist.z * 5.1));
  vec2 id = floor(p / sz);
  float h = hash12(id + dist.z * 37.0);
  vec3 tint = h < 0.1 ? vec3(1.12, 1.02, 0.78) : h < 0.2 ? vec3(0.86, 0.92, 0.82) : vec3(0.88 + 0.18 * h, 0.9 + 0.12 * fract(h * 3.7), 0.9);
  float hedge = 1.0 - smoothstep(2.5 - mpp * 0.5, 2.5 + mpp * 0.5, edgeDist(p, sz));
  vec3 col = base * tint;
  if (uVineyard.z > 0.0) {
    vec2 ve = (wp - uVineyard.xy) / uVineyard.zw;
    if (dot(ve, ve) < 1.0 && fract(h * 7.7) < 0.45) {
      float rowsF = abs(fract(p.x / 2.8) - 0.5) * 2.0; // 0 on a vine row
      float vine = 1.0 - smoothstep(0.35, 0.55, rowsF);
      vec3 vineCol = vec3(0.07, 0.1, 0.035);
      vec3 inter = mix(base * vec3(1.05, 0.95, 0.7), vec3(0.2, 0.16, 0.1), 0.35);
      vec3 rows = mix(inter, vineCol, vine);
      col = mix(rows, mix(inter, vineCol, 0.45), smoothstep(0.7, 2.2, mpp));
    }
  }
  col = mix(col, base * vec3(0.42, 0.55, 0.4), hedge * step(0.3, fract(h * 11.0)) * (1.0 - smoothstep(4.0, 16.0, mpp)));
  return mix(col, base, smoothstep(25.0, 70.0, mpp));
}

// Volcanic cones: crater bowls (a 150 m crater is under two heightfield cells, so its relief is
// shaded here: bowl normal, darker floor, worn path round the rim) and the terraces of the old pā
// earthworks on the upper flanks. Returns a normal offset; darkens / tints albedo.
vec3 coneDetail(vec2 wp, float mpp, inout vec3 albedo) {
  vec3 dn = vec3(0.0);
  if (wp.x < uConeBox.x || wp.y < uConeBox.y || wp.x > uConeBox.z || wp.y > uConeBox.w) return dn;
  float fine = 1.0 - smoothstep(3.0, 12.0, mpp);
  for (int i = 0; i < ${MAX_CONES}; i++) {
    vec4 cb = uConeB[i];
    if (cb.x <= 0.0) break;
    vec4 ca = uConeA[i];
    vec2 d = wp - ca.xy;
    float r2 = dot(d, d);
    if (r2 > cb.x * cb.x) continue;
    float r = sqrt(r2);
    // soften the grassy dome: a little darker / less lime overall, and feathered into the
    // surrounding suburbs' grey-green over the outer 45 % of the radius (no hard disc edge)
    float coneEdge = smoothstep(cb.x * 0.55, cb.x, r);
    albedo = mix(albedo * vec3(0.8, 0.84, 0.86), uSuburbLeafy, coneEdge * 0.75);
    if (ca.z > 0.0) {
      float u = r / ca.z;
      float inside = 1.0 - smoothstep(0.9, 1.04, u);
      // bowl h = depth · u²: gradient 2 · depth · d / r_c²
      vec2 g = d * (2.0 * ca.w / (ca.z * ca.z)) * inside;
      dn += vec3(-g.x, 0.0, -g.y);
      albedo *= 1.0 - 0.2 * inside * (1.0 - u * u * 0.6);
      float ring = exp(-(u - 1.09) * (u - 1.09) * 90.0);
      albedo = mix(albedo, vec3(0.46, 0.41, 0.33), ring * 0.5 * fine);
    }
    // terraces every ~7 m of height between the rim and half-way down the flanks
    float flank = smoothstep(ca.z * 1.2 + 15.0, ca.z * 1.2 + 45.0, r) * (1.0 - smoothstep(cb.x * 0.45, cb.x * 0.7, r));
    float tl = abs(fract(vH / 7.0) - 0.5) * 2.0;
    albedo *= 1.0 - 0.22 * (1.0 - smoothstep(0.0, 0.3, tl)) * flank * fine * cb.z;
  }
  return dn;
}

void main() {
  vec4 s = texture2D(uSurface, vUv + uHalfTexel.x);
  vec3 N = vec3(s.r * 2.0 - 1.0, 0.0, s.g * 2.0 - 1.0);
  N.y = sqrt(max(0.02, 1.0 - dot(N.xz, N.xz)));
  vec3 toCam = vWorld - uCamPos;
  float dist = length(toCam);
  vec2 wp = vWorld.xz;
  // metres per pixel (footprint) for pattern anti-aliasing
  float mpp = max(length(dFdx(wp)), length(dFdy(wp)));

  vec4 dA = texture2D(uDetail, wp * (1.0 / 523.0));
  vec4 dB = texture2D(uDetail, wp * (1.0 / 71.0));
  vec4 dC = texture2D(uDetail, wp * (1.0 / 13.3));
  float nearB = 1.0 - smoothstep(2500.0, 9000.0, dist);
  float nearC = 1.0 - smoothstep(200.0, 1300.0, dist);

  // Colour map (86 m texels): jitter the lookup by ±0.7 texel with two noise scales near the camera
  // so texel squares dissolve into organic patches.
  float jit = 1.0 - smoothstep(3000.0, 8000.0, dist);
  vec2 cuv = vUv + uHalfTexel.y + ((dA.rg - 0.5) * 1.1 + (dB.gr - 0.5) * 0.5) * uHalfTexel.y * 2.8 * jit;
  vec4 c = texture2D(uColor, cuv);
  vec3 albedo = c.rgb;
  float forest = c.a < 0.5 ? c.a * 2.0 : 0.0;
  float urban = c.a >= 0.5 ? clamp(c.a * 2.0 - 1.0, 0.0, 1.0) : 0.0;
  // the CBD region (real streets) is built up throughout: no rock, paddocks or beaches there
  vec4 sm = streetMap(wp);
  if (sm.y > 0.0) {
    urban = 1.0;
    forest = 0.0;
  }

  // Past the heightfield the (clamped) colour map would streak: fade to a flat outside colour.
  float outside = smoothstep(uOutside - 3000.0, uOutside, max(abs(wp.x), abs(wp.y)));
  albedo = mix(albedo, uOutsideColor, outside);
  float slope = 1.0 - N.y;

  float natural = 1.0 - urban;
  // multi-scale natural variation, incl. a fine grass/soil mottle close up
  albedo *= mix(1.0, (0.86 + 0.28 * dA.g) * mix(1.0, 0.86 + 0.28 * dB.r, nearB) * mix(1.0, 0.88 + 0.24 * dC.r, nearC), natural);
  albedo = mix(albedo, albedo * vec3(1.06, 1.0, 0.86), (dC.b - 0.5) * 0.5 * nearC * natural);

  if (uFields > 0.0) {
    float fw = uFields * natural * (1.0 - smoothstep(0.08, 0.22, forest)) * (1.0 - smoothstep(0.06, 0.16, slope)) * step(2.0, vH);
    // no paddock hedges inside the city (parks, volcanic cones): blurred (≈ 2 km) urban density
    if (fw > 0.01) fw *= fieldMask(wp) * (1.0 - smoothstep(0.5, 0.62, textureLod(uColor, vUv, 4.6).a));
    if (fw > 0.01) albedo = mix(albedo, fieldPattern(albedo, wp, mpp), fw);
  }
  vec3 emissive = vec3(0.0);
  if (urban > 0.01) albedo = urbanPattern(albedo, wp, urban, mpp, sm, emissive);

  float rockW = smoothstep(uRockSlope, uRockSlope + 0.09, slope + (dA.b - 0.5) * 0.12 + (dB.g - 0.5) * 0.05 * nearB) * natural;
  vec3 rock = uRockColor * (0.68 + 0.6 * mix(dA.b, dB.b, nearB * 0.7));
  albedo = mix(albedo, rock, rockW * (1.0 - outside));

  float snowH = smoothstep(uSnowLine - 140.0, uSnowLine + 140.0, vH + (dA.g - 0.5) * 520.0 + (dB.r - 0.5) * 60.0 * nearB);
  float snowW = snowH * (1.0 - smoothstep(0.38, 0.6, slope + (dB.r - 0.5) * 0.12));
  albedo = mix(albedo, uSnowColor * (0.93 + 0.07 * dB.r), snowW);

  // Forest canopy: darker, clumpy close up (crowns lit on one side)
  float canopy = forest * (0.18 + 0.32 * dB.a * nearB + 0.2 * dC.a * nearC);
  albedo *= 1.0 - canopy;

  vec3 coneN = coneDetail(wp, mpp, albedo);

  // ── Shoreline from the coast mask (15 m) or, outside it, from the true height (the band is at
  //    most ~12 m above sea level even on cliffs, so higher ground skips the lookups) ──
  float sd = 1e3;
  if (vH < 12.0) {
    float mw;
    float sdM = coastMaskSD(wp, mw);
    // same range fade as the water shader: far away both use the heightfield's own shoreline
    mw *= 1.0 - smoothstep(3500.0, 5500.0, dist);
    sd = mix(vH / 0.03, sdM + coastWiggle(uDetail, wp), mw);
  }
  if (sd < 60.0 && outside < 0.99) {
    float lum = dot(albedo, vec3(0.2126, 0.7152, 0.0722));
    float beachy = smoothstep(0.42, 0.62, texture2D(uDetail, wp * (1.0 / 4100.0)).g) * smoothstep(0.05, 0.1, lum) * (1.0 - 0.8 * urban);
    float bw = mix(5.0, 30.0, beachy) * (1.0 - 0.5 * urban);
    float band = 1.0 - smoothstep(bw * 0.55, bw, sd + (dB.r - 0.5) * 7.0);
    vec3 sand = wp.x < uBlackSandX ? uBlackSand : uSand;
    vec3 shore = mix(uShoreRock * (0.7 + 0.5 * dC.g), sand * (0.92 + 0.16 * dC.r), beachy);
    // seawalls / reclaimed edges: grey basalt riprap and concrete (not black: at range the band is
    // a pixel wide and a dark one reads as an outline drawn around the coast)
    shore = mix(shore, vec3(0.4, 0.39, 0.36) * (0.8 + 0.3 * dC.g), urban * 0.7);
    albedo = mix(albedo, shore, band);
    // wet line at the waterline (sub-pixel beyond a few km: faded out rather than aliased into a dark
    // outline), and wet sand / shallows where the terrain shows below the mask coast
    albedo *= 1.0 - 0.32 * (1.0 - smoothstep(0.0, 4.0, abs(sd))) * (1.0 - smoothstep(2.5, 7.0, mpp));
    albedo = mix(albedo, shore * vec3(0.5, 0.52, 0.5), 1.0 - smoothstep(-1.5, 0.0, sd));
  }

  // Detail bump
  vec3 dn = texture2D(uDetailN, wp * (1.0 / 71.0)).xyz * 2.0 - 1.0;
  vec3 dn2 = texture2D(uDetailN, wp * (1.0 / 13.3)).xyz * 2.0 - 1.0;
  float bump = (0.3 + 0.6 * rockW + 0.5 * forest) * nearB * natural;
  N = normalize(N + vec3(dn.x, 0.0, dn.y) * bump + vec3(dn2.x, 0.0, dn2.y) * 0.35 * nearC * natural + coneN);

  vec3 col = atmoDiffuse(albedo, N, s.a);
  // Where the coast mask puts sea but the terrain mesh (coarser LODs a few km out) still stands above
  // the water plane, or shows through a gap in the water, paint it as water rather than as dark wet
  // sand, which read as a black outline along far coasts. Same body + sky-reflection model as the
  // water shader, for a flat surface.
  if (sd < -0.5) {
    vec3 Vw = -toCam / dist;
    float fres = 0.02 + 0.98 * pow(1.0 - max(Vw.y, 0.0), 5.0);
    vec3 sky = atmoSky(normalize(vec3(-Vw.x, max(Vw.y, 0.02), -Vw.z)));
    vec3 body = uSeaShallow * (uHemiSky * 0.55 + uSunColor * max(uSunDir.y, 0.0) * 0.35) * 0.9;
    col = mix(col, mix(body, sky, fres * 0.85), 1.0 - smoothstep(-6.0, -0.5, sd));
  }
  col = atmoNight(col);
  col = atmoApplyFog(col, vWorld);
  // Night lights pierce the haze more than lit surfaces do
  col += emissive * (1.0 - atmoFogFactor(dist * 0.45, uCamPos.y, vWorld.y));
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;
