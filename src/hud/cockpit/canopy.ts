/**
 * F-35A canopy glass (#116): one transparent dome round the pilot's eye, a single draw call over the world
 * (the cockpit shell, nearer the eye, hides the dome wherever there is no glass). The F-35A's canopy is one
 * piece with no forward bow, so there is no frame line across the view: the glass shows only as
 *  - a very light gold tint (the canopy's coating),
 *  - veiling glare when looking near the sun (a hot core, a soft halo),
 *  - a faint mirror image of the lit PCD just above the glare shield, strongest at dawn, dusk and night
 *    (when the panel is bright against the sky outside) and nearly gone by day.
 * No raindrops: the game has no rain. (In-cloud streaks were left out: no cheap cloud-contact signal here.)
 *
 * Coordinates: the cockpit's eye frame (eye at the origin, -Z forward at the rest head pose, +Y up),
 * where the glare-shield lip sits GLARE_LIP_ANGLE below the forward axis.
 */
import { BackSide, Color, Mesh, ShaderMaterial, SphereGeometry, Vector3, type Texture } from 'three';
import type { TimeOfDay, Weather } from '../../core/types';
import { GLARE_LIP_ANGLE } from '../hmd/layout';
import { PCD } from './geometry';

/** Dome radius (m): beyond the panel and the frame (≤ 0.75 m), well inside the 20 m far plane. */
export const CANOPY_RADIUS = 0.95;
/** The dome's lower edge (rad below the eye's horizontal): the canopy sills sit about there. */
export const CANOPY_SILL_ANGLE = 22 * (Math.PI / 180);

/** How the glass looks per time of day and weather (pure; tests). */
export function canopyLook(tod: TimeOfDay, weather: Weather): { tint: number; glare: number; reflect: number } {
  // a sun behind cloud gives no hot spot; a scattered sky still lets it through most of the time
  const sky = weather === 'overcast' ? 0.12 : weather === 'scattered' ? 0.8 : 1;
  switch (tod) {
    case 'dawn':
    case 'dusk':
      return { tint: 0.03, glare: 0.85 * sky, reflect: 1 };
    case 'night':
      return { tint: 0.015, glare: 0, reflect: 0.75 };
    default:
      return { tint: 0.035, glare: sky, reflect: 0.18 };
  }
}

const vertex = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const fragment = /* glsl */ `
uniform vec3 uSun;
uniform vec3 uSunColor;
uniform float uGlare;
uniform vec3 uTint;
uniform float uTintA;
uniform sampler2D uMap;
uniform float uReflect;
uniform vec4 uPcd; // lip angle, PCD top angle below the forward axis, PCD angular height, PCD half-width / distance
varying vec3 vDir;
void main() {
  vec3 d = normalize(vDir);
  float c = max(dot(d, uSun), 0.0);
  // veiling glare on the coating: a hot core and a wide soft halo round the sun
  vec3 col = uSunColor * uGlare * (pow(c, 700.0) * 0.9 + pow(c, 48.0) * 0.1 + pow(c, 8.0) * 0.025);
  // the lit PCD mirrored in the glass just above the glare shield (mirror line: the lip)
  float el = asin(clamp(d.y, -1.0, 1.0));
  float above = el + uPcd.x; // angle above the lip
  float down = above - (uPcd.y - uPcd.x); // mirrored: angle below the PCD's top edge
  vec2 uv = vec2(0.5 + (d.x / max(0.05, -d.z)) / (2.0 * uPcd.w), 1.0 - down / uPcd.z);
  // (sampled unconditionally, masked after: no texture fetch in divergent control flow)
  vec3 pcd = texture(uMap, clamp(uv, 0.0, 1.0), 2.5).rgb;
  float inside = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0) * step(0.0, above) * step(0.0, -d.z);
  col += pcd * uReflect * inside * (1.0 - smoothstep(0.0, 0.2, above));
  gl_FragColor = vec4(uTint * uTintA + col, uTintA);
  #include <colorspace_fragment>
}
`;

const _v = new Vector3();

/** The canopy glass dome and its per-frame update. */
export class CanopyGlass {
  readonly mesh: Mesh;
  private readonly material: ShaderMaterial;
  private readonly uniforms: {
    uSun: { value: Vector3 };
    uSunColor: { value: Color };
    uGlare: { value: number };
    uTint: { value: Color };
    uTintA: { value: number };
    uMap: { value: Texture };
    uReflect: { value: number };
    uPcd: { value: [number, number, number, number] };
  };

  constructor(pcdTexture: Texture) {
    const halfAng = Math.atan(PCD.height / 2 / PCD.dist);
    this.uniforms = {
      uSun: { value: new Vector3(0, 1, 0) },
      uSunColor: { value: new Color(0xfff3df) },
      uGlare: { value: 0 },
      uTint: { value: new Color(0xc9b27a) },
      uTintA: { value: 0.03 },
      uMap: { value: pcdTexture },
      uReflect: { value: 0 },
      uPcd: { value: [GLARE_LIP_ANGLE, PCD.topAngle, 2 * halfAng, PCD.width / 2 / PCD.dist] },
    };
    this.material = new ShaderMaterial({
      name: 'CanopyGlass',
      vertexShader: vertex,
      fragmentShader: fragment,
      uniforms: this.uniforms,
      transparent: true,
      premultipliedAlpha: true,
      depthWrite: false,
      side: BackSide,
    });
    // from the top of the dome down to the sills, all round (the aft frame and the spine hide the back)
    const geo = new SphereGeometry(CANOPY_RADIUS, 36, 14, 0, Math.PI * 2, 0, Math.PI / 2 + CANOPY_SILL_ANGLE);
    geo.deleteAttribute('uv');
    geo.deleteAttribute('normal');
    this.mesh = new Mesh(geo, this.material);
    this.mesh.name = 'canopyGlass';
    this.mesh.renderOrder = 10;
  }

  /** Look for the time of day / weather; the sun's colour (sRGB hex). */
  setLook(tod: TimeOfDay, weather: Weather, sunHex: number, reflectScale: number): void {
    const L = canopyLook(tod, weather);
    this.uniforms.uTintA.value = L.tint;
    this.uniforms.uGlare.value = L.glare;
    this.uniforms.uReflect.value = L.reflect * reflectScale;
    this.uniforms.uSunColor.value.setHex(sunHex);
  }

  /** Sun direction in the eye frame (unit; below the horizon gives no glare through the glass). */
  setSun(dir: Vector3): void {
    this.uniforms.uSun.value.copy(_v.copy(dir).normalize());
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
