/**
 * Clouds per weather:
 *  - cumulus: clusters of soft billboard puffs (instanced, one draw call, sorted back-to-front each
 *    frame) living in a camera-wrapped periodic field, shaded top-lit with sun-side brightening and
 *    silver linings; puffs fade out as the camera approaches (no popping / fill-rate blowups)
 *  - overcast: a camera-following cloud deck (two scrolling density octaves), grey underside / bright
 *    top, fading when the camera crosses it
 *  - clear: a few thin high wisps
 * `inCloud(pos)` reports 0..1 when the camera is inside a cloud so the environment can white out fog.
 */
import {
  DoubleSide,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  NormalBlending,
  PlaneGeometry,
  ShaderMaterial,
  type Texture,
  type Vector3,
} from 'three';
import { mulberry32 } from '../../core/math';
import type { QualitySettings, Weather } from '../../core/types';
import { ATMOSPHERE_GLSL, type AtmosphereUniforms } from '../sky/atmosphere';
import type { SkyPreset } from '../sky/presets';

const puffVertex = /* glsl */ `
attribute vec3 aPos;
attribute vec4 aParam;  // size (m), vertical shade 0..1, atlas cell, rotation
attribute vec2 aParam2; // sun-side factor −1..1, opacity
uniform vec3 uCamPosV;
varying vec2 vUv;
varying float vShade;
varying float vSun;
varying float vAlpha;
varying vec3 vCentre;
void main() {
  vec4 mv = viewMatrix * vec4(aPos, 1.0);
  float c = cos(aParam.w);
  float s = sin(aParam.w);
  vec2 corner = position.xy;
  mv.xy += vec2(c * corner.x - s * corner.y, s * corner.x + c * corner.y) * aParam.x;
  vec2 cell = vec2(mod(aParam.z, 2.0), floor(aParam.z / 2.0));
  vUv = (cell + corner + 0.5) * 0.5;
  float dist = length(aPos - uCamPosV);
  vAlpha = aParam2.y * smoothstep(aParam.x * 0.35, aParam.x * 1.1, dist);
  vShade = aParam.y;
  vSun = aParam2.x;
  vCentre = aPos;
  gl_Position = projectionMatrix * mv;
}
`;

const puffFragment = /* glsl */ `
${ATMOSPHERE_GLSL}
uniform sampler2D uAtlas;
uniform vec3 uCloudLit;
uniform vec3 uCloudShade;
varying vec2 vUv;
varying float vShade;
varying float vSun;
varying float vAlpha;
varying vec3 vCentre;
void main() {
  vec4 t = texture2D(uAtlas, vUv);
  float a = t.r * vAlpha;
  if (a < 0.004) discard;
  float light = clamp(t.g * 0.5 + vShade * 0.45 + vSun * 0.22, 0.0, 1.0);
  vec3 col = mix(uCloudShade, uCloudLit, light);
  vec3 V = normalize(vCentre - uCamPos);
  float fwd = pow(max(dot(V, uSunDir), 0.0), 8.0);
  col += uCloudLit * fwd * (1.0 - t.r) * 0.8; // silver lining on thin edges towards the sun
  col = atmoApplyFog(col, vCentre);
  gl_FragColor = vec4(col, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  gl_FragColor.rgb *= gl_FragColor.a;
}
`;

const deckVertex = /* glsl */ `
varying vec3 vWorld;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

const deckFragment = /* glsl */ `
${ATMOSPHERE_GLSL}
uniform sampler2D uLayer;
uniform float uCover;
uniform float uDeckY;
uniform vec3 uCloudLit;
uniform vec3 uCloudShade;
varying vec3 vWorld;
void main() {
  vec2 uv = vWorld.xz / 9500.0 + uTime * vec2(0.0012, 0.0005);
  float d = texture2D(uLayer, uv).r * 0.72 + texture2D(uLayer, vWorld.xz / 2100.0 + uTime * vec2(-0.0025, 0.0015)).r * 0.4;
  float dens = smoothstep(1.0 - uCover, 1.0 - uCover + 0.28, d);
  bool below = uCamPos.y < uDeckY;
  vec3 col;
  if (below) {
    // solid grey underside with darker, lumpy rolls
    float lump = texture2D(uLayer, vWorld.xz / 1300.0 + uTime * vec2(0.003, -0.002)).r;
    col = mix(uCloudShade * 1.15, uCloudShade * 0.7, clamp(dens * 0.6 + lump * 0.5, 0.0, 1.0));
  } else {
    float sun = max(uSunDir.y, 0.0);
    col = mix(uCloudShade, uCloudLit, 0.55 + 0.45 * dens) * (0.75 + 0.35 * sun);
  }
  float fade = smoothstep(60.0, 420.0, abs(uCamPos.y - uDeckY));
  col = atmoApplyFog(col, vWorld);
  float a = clamp(dens * 0.97, 0.0, 1.0) * fade;
  gl_FragColor = vec4(col, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  gl_FragColor.rgb *= gl_FragColor.a;
}
`;

interface Cloud {
  x: number;
  z: number;
  y: number;
  r: number;
  rv: number;
  puffs: { dx: number; dy: number; dz: number; size: number; shade: number; atlas: number; rot: number; sun: number; opacity: number }[];
}

/** Overcast: base of the stratus deck (m) and its coverage (0..1). */
export const OVERCAST_DECK = { altitude: 1800, cover: 0.985 } as const;

export interface CloudOptions {
  weather: Weather;
  quality: QualitySettings;
  preset: SkyPreset;
  atmo: AtmosphereUniforms;
  atlas: Texture;
  layer: Texture;
  seed: number;
}

export class Clouds {
  readonly meshes: Mesh[] = [];
  private readonly clouds: Cloud[] = [];
  private readonly period: number;
  private puffMesh: Mesh | null = null;
  private deck: Mesh | null = null;
  private readonly deckY: number;
  private readonly geometry: InstancedBufferGeometry | null = null;
  private readonly aPos: InstancedBufferAttribute | null = null;
  private readonly aParam: InstancedBufferAttribute | null = null;
  private readonly aParam2: InstancedBufferAttribute | null = null;
  private readonly total: number;
  private readonly order: Int32Array;
  private readonly dist: Float32Array;
  private readonly wx: Float32Array;
  private readonly wy: Float32Array;
  private readonly wz: Float32Array;
  private readonly flat: { c: number; p: number }[] = [];
  private windX = 0;
  private windZ = 0;
  private readonly materials: ShaderMaterial[] = [];
  private readonly camUniform = { value: null as unknown as Vector3 };

  constructor(private readonly o: CloudOptions) {
    const rnd = mulberry32(o.seed * 7 + 11);
    const w = o.weather;
    const budget = Math.max(8, o.quality.cloudCount);
    const puffCount = w === 'clear' ? Math.round(budget * 0.2) : w === 'overcast' ? Math.round(budget * 0.6) : budget;
    const perCloud = w === 'clear' ? 3 : 6;
    const cloudN = Math.max(2, Math.round(puffCount / perCloud));
    this.period = Math.sqrt(cloudN) * (w === 'clear' ? 11_000 : 6500);
    // Overcast: a low stratus deck (~1,800 m) with ragged scud below it.
    this.deckY = OVERCAST_DECK.altitude;
    const sun = o.preset.sunDir;

    for (let i = 0; i < cloudN; i++) {
      const base = w === 'clear' ? 4200 + rnd() * 1500 : w === 'overcast' ? 600 + rnd() * 700 : 1300 + rnd() * 900;
      const r = w === 'clear' ? 1400 + rnd() * 1800 : 700 + rnd() * 900;
      const cloud: Cloud = { x: rnd() * this.period, z: rnd() * this.period, y: base, r, rv: r * 0.55, puffs: [] };
      const n = perCloud + ((rnd() * 3) | 0) - 1;
      for (let k = 0; k < n; k++) {
        let dx: number, dy: number, dz: number, size: number;
        if (w === 'clear') {
          dx = (rnd() - 0.5) * r * 1.6;
          dz = (rnd() - 0.5) * r * 0.6;
          dy = (rnd() - 0.5) * 60;
          size = r * (0.7 + rnd() * 0.5);
        } else {
          const layer = k < n * 0.5 ? 0 : k < n * 0.85 ? 1 : 2;
          const a = rnd() * Math.PI * 2;
          const rr = r * (layer === 0 ? 0.55 + rnd() * 0.35 : layer === 1 ? 0.25 + rnd() * 0.3 : rnd() * 0.2);
          dx = Math.cos(a) * rr;
          dz = Math.sin(a) * rr;
          dy = layer * r * 0.32 + rnd() * r * 0.1;
          size = r * (layer === 0 ? 0.9 + rnd() * 0.4 : layer === 1 ? 0.8 + rnd() * 0.35 : 0.6 + rnd() * 0.3);
        }
        const len = Math.hypot(dx, dy, dz) || 1;
        cloud.puffs.push({
          dx,
          dy,
          dz,
          size,
          shade: w === 'clear' ? 0.85 : Math.min(1, dy / (r * 0.75) + 0.1),
          atlas: (rnd() * 4) | 0,
          rot: rnd() * Math.PI * 2,
          sun: (dx * sun.x + dy * sun.y + dz * sun.z) / len,
          opacity: w === 'clear' ? 0.42 : 0.9,
        });
      }
      this.clouds.push(cloud);
    }
    for (let c = 0; c < this.clouds.length; c++) for (let p = 0; p < this.clouds[c].puffs.length; p++) this.flat.push({ c, p });
    this.total = this.flat.length;
    this.order = new Int32Array(this.total);
    this.dist = new Float32Array(this.total);
    this.wx = new Float32Array(this.total);
    this.wy = new Float32Array(this.total);
    this.wz = new Float32Array(this.total);

    // Puff mesh
    const quad = new PlaneGeometry(1, 1);
    const g = new InstancedBufferGeometry();
    g.index = quad.index;
    g.setAttribute('position', quad.getAttribute('position'));
    this.aPos = new InstancedBufferAttribute(new Float32Array(this.total * 3), 3);
    this.aParam = new InstancedBufferAttribute(new Float32Array(this.total * 4), 4);
    this.aParam2 = new InstancedBufferAttribute(new Float32Array(this.total * 2), 2);
    g.setAttribute('aPos', this.aPos);
    g.setAttribute('aParam', this.aParam);
    g.setAttribute('aParam2', this.aParam2);
    g.instanceCount = this.total;
    this.geometry = g;
    const puffMat = new ShaderMaterial({
      name: 'CloudPuffs',
      vertexShader: puffVertex,
      fragmentShader: puffFragment,
      uniforms: {
        ...o.atmo,
        uCamPosV: o.atmo.uCamPos,
        uAtlas: { value: o.atlas },
        uCloudLit: { value: o.preset.cloudLit },
        uCloudShade: { value: o.preset.cloudShade },
      },
      transparent: true,
      depthWrite: false,
      blending: NormalBlending,
      premultipliedAlpha: true,
    });
    this.materials.push(puffMat);
    this.puffMesh = new Mesh(g, puffMat);
    this.puffMesh.name = 'cloud-puffs';
    this.puffMesh.frustumCulled = false;
    this.puffMesh.renderOrder = 20;
    this.meshes.push(this.puffMesh);

    if (w === 'overcast') {
      const deckMat = new ShaderMaterial({
        name: 'CloudDeck',
        vertexShader: deckVertex,
        fragmentShader: deckFragment,
        uniforms: {
          ...o.atmo,
          uLayer: { value: o.layer },
          uCover: { value: OVERCAST_DECK.cover },
          uDeckY: { value: this.deckY },
          uCloudLit: { value: o.preset.cloudLit },
          uCloudShade: { value: o.preset.cloudShade },
        },
        transparent: true,
        depthWrite: false,
        side: DoubleSide,
        premultipliedAlpha: true,
      });
      this.materials.push(deckMat);
      const plane = new PlaneGeometry(o.quality.drawDistance * 2.4, o.quality.drawDistance * 2.4, 8, 8).rotateX(-Math.PI / 2);
      this.deck = new Mesh(plane, deckMat);
      this.deck.name = 'cloud-deck';
      this.deck.frustumCulled = false;
      this.meshes.push(this.deck);
    }
  }

  /** Advance wind drift. */
  update(dt: number): void {
    this.windX += dt * 6;
    this.windZ += dt * 2.5;
  }

  /** Place wrapped clouds around the camera and sort puffs back-to-front. */
  preRender(cam: Vector3): void {
    const P = this.period;
    const half = P / 2;
    for (let i = 0; i < this.total; i++) {
      const f = this.flat[i];
      const c = this.clouds[f.c];
      const p = c.puffs[f.p];
      let cx = c.x + this.windX;
      let cz = c.z + this.windZ;
      cx += P * Math.round((cam.x - cx) / P);
      cz += P * Math.round((cam.z - cz) / P);
      this.wx[i] = cx + p.dx;
      this.wy[i] = c.y + p.dy;
      this.wz[i] = cz + p.dz;
      const dx = this.wx[i] - cam.x;
      const dy = this.wy[i] - cam.y;
      const dz = this.wz[i] - cam.z;
      this.dist[i] = dx * dx + dy * dy + dz * dz;
      this.order[i] = i;
    }
    // insertion sort (far → near); nearly sorted frame to frame
    const ord = this.order;
    const d = this.dist;
    for (let i = 1; i < this.total; i++) {
      const v = ord[i];
      const dv = d[v];
      let j = i - 1;
      while (j >= 0 && d[ord[j]] < dv) {
        ord[j + 1] = ord[j];
        j--;
      }
      ord[j + 1] = v;
    }
    const pos = this.aPos!.array as Float32Array;
    const par = this.aParam!.array as Float32Array;
    const par2 = this.aParam2!.array as Float32Array;
    for (let k = 0; k < this.total; k++) {
      const i = ord[k];
      const f = this.flat[i];
      const p = this.clouds[f.c].puffs[f.p];
      // fade clouds in at the edge of the wrap domain (no popping)
      const hd = Math.sqrt((this.wx[i] - cam.x) ** 2 + (this.wz[i] - cam.z) ** 2);
      const edge = 1 - Math.min(1, Math.max(0, (hd - half * 0.7) / (half * 0.3)));
      pos[k * 3] = this.wx[i];
      pos[k * 3 + 1] = this.wy[i];
      pos[k * 3 + 2] = this.wz[i];
      par[k * 4] = p.size;
      par[k * 4 + 1] = p.shade;
      par[k * 4 + 2] = p.atlas;
      par[k * 4 + 3] = p.rot;
      par2[k * 2] = p.sun;
      par2[k * 2 + 1] = p.opacity * edge;
    }
    this.aPos!.needsUpdate = true;
    this.aParam!.needsUpdate = true;
    this.aParam2!.needsUpdate = true;
    if (this.deck) {
      this.deck.position.set(cam.x, this.deckY, cam.z);
      this.deck.updateMatrix();
      this.deck.updateMatrixWorld();
      // below the deck: draw it before the puffs (they are between us and it); above: after
      this.deck.renderOrder = cam.y < this.deckY ? 19 : 21;
    }
  }

  /** 0..1: how deep the camera is inside a cloud (or the overcast deck). */
  inCloud(cam: Vector3): number {
    const P = this.period;
    let m = 0;
    for (const c of this.clouds) {
      let cx = c.x + this.windX;
      let cz = c.z + this.windZ;
      cx += P * Math.round((cam.x - cx) / P);
      cz += P * Math.round((cam.z - cz) / P);
      const dx = (cam.x - cx) / c.r;
      const dz = (cam.z - cz) / c.r;
      const dy = (cam.y - (c.y + c.rv * 0.5)) / c.rv;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const v = 1 - Math.min(1, Math.max(0, (d - 0.45) / 0.55));
      if (v > m) m = v;
    }
    if (this.deck) {
      const dd = Math.abs(cam.y - this.deckY);
      m = Math.max(m, 1 - Math.min(1, Math.max(0, (dd - 40) / 260)));
    }
    return m;
  }

  get deckAltitude(): number | null {
    return this.deck ? this.deckY : null;
  }

  dispose(): void {
    for (const m of this.meshes) {
      m.removeFromParent();
      m.geometry.dispose();
    }
    for (const m of this.materials) m.dispose();
  }
}
