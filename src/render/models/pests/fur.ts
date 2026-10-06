/**
 * Shell fur for the Codex pests: the skin mesh drawn again N times, each copy pushed out along the
 * normal (and combed along the vertex's `comb` direction, drooping more towards the tips). A fragment
 * keeps only the pixels inside a strand: a 3D cellular pattern in object space, so it needs no UVs.
 * Strands taper and vary in length per cell; the lowest shells are darker (self-shadowing at the roots)
 * and the tips can take a lighter colour (agouti / silver tips). `furLen` per vertex scales the length
 * (0 on the nose, ears and feet).
 */
import { Color, Group, Mesh, MeshStandardMaterial, type BufferGeometry, type MeshStandardMaterialParameters } from 'three';

export interface FurSpec {
  /** Number of shells above the skin. */
  shells: number;
  /** Full fur length (m) where furLen = 1. */
  length: number;
  /** Strand spacing (m). */
  spacing: number;
  /** How far the fur lies down along `comb` at the tip, as a fraction of its length. */
  comb: number;
  /** Strand thickness at the root, 0..1 of the spacing. */
  thickness?: number;
  /** Colour the strand tips fade towards (sRGB hex), e.g. a possum's silver tips. */
  tip?: number;
  /** How much the tip colour shows (0..1). */
  tipMix?: number;
  /** Root darkening (0 = none, 1 = black roots). */
  occlusion?: number;
  roughness?: number;
}

const NOISE = /* glsl */ `
vec3 furHash(vec3 p) {
  p = vec3(dot(p, vec3(127.1, 311.7, 74.7)), dot(p, vec3(269.5, 183.3, 246.1)), dot(p, vec3(113.5, 271.9, 124.6)));
  return fract(sin(p) * 43758.5453123);
}
// distance to the nearest strand centre (cell units) and that strand's random value; the 2×2×2 cells
// nearest the point (enough for jitter kept inside 0.15..0.85 of a cell)
vec2 furCell(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  vec3 s = step(0.5, f) - 1.0;
  float best = 9.0;
  float id = 0.0;
  for (int z = 0; z <= 1; z++)
    for (int y = 0; y <= 1; y++)
      for (int x = 0; x <= 1; x++) {
        vec3 g = s + vec3(float(x), float(y), float(z));
        vec3 o = furHash(i + g);
        vec3 r = g + 0.15 + 0.7 * o - f;
        float d = dot(r, r);
        if (d < best) { best = d; id = o.x; }
      }
  return vec2(sqrt(best), id);
}
`;

/** A material for one fur shell at height `t` (0 = skin, 1 = tips). */
function shellMaterial(t: number, spec: FurSpec, base: MeshStandardMaterialParameters): MeshStandardMaterial {
  const m = new MeshStandardMaterial({ vertexColors: true, roughness: spec.roughness ?? 0.85, metalness: 0, ...base });
  const tip = new Color(spec.tip ?? 0xffffff);
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uShell = { value: t };
    sh.uniforms.uLen = { value: spec.length };
    sh.uniforms.uSpacing = { value: spec.spacing };
    sh.uniforms.uComb = { value: spec.comb };
    sh.uniforms.uThick = { value: spec.thickness ?? 0.55 };
    sh.uniforms.uTip = { value: tip };
    sh.uniforms.uTipMix = { value: spec.tipMix ?? 0 };
    sh.uniforms.uOcc = { value: spec.occlusion ?? 0.55 };
    sh.vertexShader = sh.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
attribute float furLen;
attribute float furTip;
attribute vec3 comb;
uniform float uShell;
uniform float uLen;
uniform float uSpacing;
uniform float uComb;
varying vec3 vFurP;
varying float vFur;
varying float vTip;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
vFurP = position / uSpacing;
vFur = furLen;
vTip = furTip;
float furH = uShell * uLen * furLen;
transformed += normal * furH * (1.0 - 0.5 * uComb) + comb * (uShell * uShell) * uLen * furLen * uComb;`,
      );
    sh.fragmentShader = sh.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform float uShell;
uniform float uThick;
uniform vec3 uTip;
uniform float uTipMix;
uniform float uOcc;
varying vec3 vFurP;
varying float vFur;
varying float vTip;
${NOISE}`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
if (uShell > 0.0) {
  if (vFur < 0.04) discard;
  vec2 cell = furCell(vFurP);
  float reach = 0.35 + 0.65 * cell.y; // strands differ in length
  float h = uShell / max(reach, 0.001);
  if (h > 1.0 || cell.x > uThick * (1.0 - h * 0.85)) discard;
  diffuseColor.rgb = mix(diffuseColor.rgb, uTip, uTipMix * vTip * smoothstep(0.45, 1.0, h));
}
diffuseColor.rgb *= mix(1.0 - uOcc, 1.0, sqrt(uShell));`,
      );
  };
  m.customProgramCacheKey = () => 'pestFur';
  return m;
}

/**
 * The skin plus its fur shells, as one group. `shellGeo` (a coarser sculpt of the same body) carries
 * the shells so the fur costs a fraction of the skin's triangles per shell. `base` sets the skin's own
 * material (e.g. glossy chitin); the shells keep the fur's roughness.
 */
export function furred(geo: BufferGeometry, spec: FurSpec, base: MeshStandardMaterialParameters = {}, shellGeo = geo): Group {
  const g = new Group();
  const skin = new Mesh(geo, shellMaterial(0, spec, base));
  skin.receiveShadow = true;
  skin.name = 'skin';
  g.add(skin);
  const shells = new Group();
  shells.name = 'fur';
  for (let i = 1; i <= spec.shells; i++) {
    const m = new Mesh(shellGeo, shellMaterial(i / spec.shells, spec, {}));
    m.renderOrder = i;
    shells.add(m);
  }
  g.add(shells);
  return g;
}
