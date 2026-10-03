/**
 * Sky & lighting: gradient sky dome with sun disk + glow (drawn at the far plane, after opaque
 * geometry so terrain early-z rejects it), stars and a textured moon at night, the directional
 * sun/moon light (+ optional player shadow frustum), hemisphere light, and scene fog for other
 * modules' standard materials. Lens flare on high quality.
 */
import {
  AdditiveBlending,
  BackSide,
  DoubleSide,
  BufferAttribute,
  BufferGeometry,
  Color,
  DirectionalLight,
  FogExp2,
  HemisphereLight,
  Mesh,
  Object3D,
  PlaneGeometry,
  PointLight,
  Points,
  ShaderMaterial,
  SphereGeometry,
  SRGBColorSpace,
  TextureLoader,
  Vector3,
  type Camera,
  type Scene,
  type Texture,
} from 'three';
import { Lensflare, LensflareElement } from 'three/examples/jsm/objects/Lensflare.js';
import { mulberry32 } from '../../core/math';
import type { QualitySettings } from '../../core/types';
import { ATMOSPHERE_GLSL, type AtmosphereUniforms } from './atmosphere';
import type { SkyPreset } from './presets';

const skyVertex = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 p = projectionMatrix * mat4(mat3(viewMatrix)) * vec4(position, 1.0);
  gl_Position = vec4(p.xy, p.w * 0.99999, p.w); // just inside the far plane
}
`;

const skyFragment = /* glsl */ `
${ATMOSPHERE_GLSL}
uniform float uDiskSize; // cos of the disk radius
uniform float uDiskIntensity;
uniform sampler2D uClouds;
uniform float uCloudCover;
uniform vec3 uCloudLit;
uniform vec3 uCloudShade;
varying vec3 vDir;
void main() {
  vec3 dir = normalize(vDir);
  vec3 col = atmoSky(dir);
  float s = dot(dir, uSunDir);
  // Sun disk with a soft limb (HDR so ACES blooms it to white)
  float disk = smoothstep(uDiskSize - 0.00004, uDiskSize + 0.00002, s);
  col += uSunDisk * disk * uDiskIntensity * step(0.0, dir.y + 0.02);
  // Far cloud band painted on the dome (cheap, adds depth beyond the 3D clouds)
  if (uCloudCover > 0.0 && dir.y > 0.0) {
    vec2 uv = dir.xz / (dir.y + 0.12) * 0.22 + uTime * vec2(0.0006, 0.0002);
    // explicit LOD (UV stretch grows ~1/y towards the horizon): no derivative seams on the dome
    float lod = clamp(log2(0.35 / max(dir.y + 0.12, 0.05)) + 1.5, 0.0, 7.0);
    vec4 c = textureLod(uClouds, uv, lod);
    float dens = smoothstep(1.0 - uCloudCover, 1.0 - uCloudCover + 0.35, c.r * 0.8 + c.g * 0.3);
    dens *= smoothstep(0.0, 0.08, dir.y) * (1.0 - smoothstep(0.35, 0.9, dir.y) * 0.6);
    float lit = 0.5 + 0.5 * pow(max(s, 0.0), 3.0);
    float thick = smoothstep(0.0, 1.0, dens);
    vec3 cc = mix(uCloudShade, uCloudLit, clamp(lit * (0.45 + 0.55 * c.g) + 0.25 * (1.0 - thick), 0.0, 1.0));
    col = mix(col, cc, dens * 0.88);
  }
  col = atmoGrade(col);
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const starVertex = /* glsl */ `
attribute float aSize;
attribute float aPhase;
uniform float uTime;
uniform float uAlpha;
uniform float uPixelRatio;
varying float vA;
void main() {
  vec4 p = projectionMatrix * mat4(mat3(viewMatrix)) * vec4(position, 1.0);
  gl_Position = vec4(p.xy, p.w * 0.99999, p.w); // just inside the far plane
  float tw = 0.75 + 0.25 * sin(uTime * (1.5 + aPhase) + aPhase * 17.0);
  vA = uAlpha * tw * smoothstep(-0.02, 0.18, position.y);
  gl_PointSize = aSize * uPixelRatio;
}
`;

const starFragment = /* glsl */ `
varying float vA;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float a = smoothstep(0.5, 0.0, length(c)) * vA;
  gl_FragColor = vec4(vec3(1.0, 0.97, 0.92) * a * 1.6, a);
}
`;

const moonVertex = /* glsl */ `
uniform vec3 uMoonDir;
uniform float uMoonSize;
varying vec2 vUv;
void main() {
  vUv = uv;
  // Billboard at the far plane in the moon direction
  vec3 d = normalize(uMoonDir);
  vec3 up = abs(d.y) > 0.99 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0);
  vec3 r = normalize(cross(up, d));
  vec3 u = cross(d, r);
  vec3 p = d + (r * position.x + u * position.y) * uMoonSize;
  vec4 cp = projectionMatrix * mat4(mat3(viewMatrix)) * vec4(p, 1.0);
  gl_Position = vec4(cp.xy, cp.w * 0.99999, cp.w);
}
`;

const moonFragment = /* glsl */ `
uniform sampler2D uMoonMap;
uniform float uHasMap;
uniform vec3 uMoonColor;
varying vec2 vUv;
void main() {
  vec2 c = vUv * 2.0 - 1.0;
  float r2 = dot(c, c);
  float glow = exp(-max(r2 - 1.0, 0.0) * 2.5) * 0.25 * step(1.0, r2) * (1.0 - smoothstep(1.0, 4.0, r2));
  vec3 col = vec3(0.0);
  float a = glow;
  if (r2 < 1.0) {
    vec3 n = vec3(c, sqrt(1.0 - r2));
    float lon = atan(n.x, n.z) / 6.2831853 + 0.5;
    float lat = asin(n.y) / 3.1415926 + 0.5;
    vec3 tex = uHasMap > 0.5 ? texture2D(uMoonMap, vec2(lon, lat)).rgb : vec3(0.8);
    float limb = 0.55 + 0.45 * n.z;
    col = uMoonColor * tex * limb * 2.2;
    a = 1.0;
  }
  col += uMoonColor * glow;
  gl_FragColor = vec4(col, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export interface SkySystemOptions {
  scene: Scene;
  preset: SkyPreset;
  atmo: AtmosphereUniforms;
  quality: QualitySettings;
  cloudLayer: Texture;
  cloudCover: number;
}

export class SkySystem {
  readonly sun: DirectionalLight;
  readonly hemi: HemisphereLight;
  readonly fog: FogExp2;
  private readonly dome: Mesh;
  private readonly domeMat: ShaderMaterial;
  private stars: Points | null = null;
  private moon: Mesh | null = null;
  private moonTex: Texture | null = null;
  private flareLight: PointLight | null = null;
  private flareTextures: Texture[] = [];
  private readonly objects: Object3D[] = [];
  private readonly preset: SkyPreset;
  private readonly baseFogColor = new Color();
  private readonly shadows: boolean;
  private readonly origin = new Vector3();

  constructor(private readonly o: SkySystemOptions) {
    const p = o.preset;
    this.preset = p;
    const scene = o.scene;

    // Lights
    this.sun = new DirectionalLight(p.sunColor, p.sunIntensity);
    this.sun.name = p.isNight ? 'moonlight' : 'sunlight';
    this.sun.position.copy(p.sunDir).multiplyScalar(1000);
    this.sun.target.position.set(0, 0, 0);
    this.shadows = o.quality.shadows;
    if (this.shadows) {
      this.sun.castShadow = true;
      this.sun.shadow.mapSize.set(1024, 1024);
      const cam = this.sun.shadow.camera;
      cam.left = -30;
      cam.right = 30;
      cam.top = 30;
      cam.bottom = -30;
      cam.near = 1;
      cam.far = 1200;
      this.sun.shadow.bias = -0.0004;
      this.sun.shadow.normalBias = 0.02;
    }
    this.hemi = new HemisphereLight(p.hemiSky, p.hemiGround, p.hemiIntensity);
    scene.add(this.sun, this.sun.target, this.hemi);
    this.objects.push(this.sun, this.sun.target, this.hemi);

    // Fog for other modules' standard materials (our shaders use the atmosphere uniforms)
    this.baseFogColor.copy(p.fogColor);
    this.fog = new FogExp2(p.fogColor.clone(), p.fogDensity);
    scene.fog = this.fog;
    scene.background = p.fogColor.clone();

    // Sky dome
    this.domeMat = new ShaderMaterial({
      name: 'SkyDome',
      vertexShader: skyVertex,
      fragmentShader: skyFragment,
      uniforms: {
        ...o.atmo,
        uDiskSize: { value: Math.cos(((p.isNight ? 0 : 0.9) * Math.PI) / 180) },
        uDiskIntensity: { value: p.isNight ? 0 : p.timeOfDay === 'day' ? 40 : 22 },
        uClouds: { value: o.cloudLayer },
        uCloudCover: { value: o.cloudCover },
        uCloudLit: { value: p.cloudLit },
        uCloudShade: { value: p.cloudShade },
      },
      depthWrite: false,
      side: BackSide, // we are inside the dome
    });
    this.dome = new Mesh(new SphereGeometry(1, 48, 24), this.domeMat);
    this.dome.name = 'sky';
    this.dome.frustumCulled = false;
    this.dome.renderOrder = 1000; // after opaque geometry: early-z skips covered pixels
    this.dome.matrixAutoUpdate = false;
    scene.add(this.dome);
    this.objects.push(this.dome);

    if (p.starAlpha > 0) this.buildStars(o.quality);
    if (p.isNight) this.buildMoon(p);
    if (o.quality.level === 'high' && !p.isNight && p.weather !== 'overcast') this.buildLensflare(p);
  }

  private buildStars(q: QualitySettings): void {
    const count = q.level === 'low' ? 700 : q.level === 'medium' ? 1400 : 2200;
    const rnd = mulberry32(4242);
    const pos = new Float32Array(count * 3);
    const size = new Float32Array(count);
    const phase = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const u = rnd() * 2 - 1;
      const a = rnd() * Math.PI * 2;
      const r = Math.sqrt(1 - u * u);
      // bias towards the upper hemisphere
      const y = Math.abs(u) * 0.98 + 0.02;
      pos[i * 3] = Math.cos(a) * r;
      pos[i * 3 + 1] = y;
      pos[i * 3 + 2] = Math.sin(a) * r;
      const m = rnd();
      size[i] = 0.8 + m * m * m * 2.6;
      phase[i] = rnd() * 3;
    }
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(pos, 3));
    g.setAttribute('aSize', new BufferAttribute(size, 1));
    g.setAttribute('aPhase', new BufferAttribute(phase, 1));
    const mat = new ShaderMaterial({
      name: 'Stars',
      vertexShader: starVertex,
      fragmentShader: starFragment,
      uniforms: { uTime: this.o.atmo.uTime, uAlpha: { value: this.preset.starAlpha }, uPixelRatio: { value: 1 } },
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    this.stars = new Points(g, mat);
    this.stars.name = 'stars';
    this.stars.frustumCulled = false;
    this.stars.renderOrder = 1001;
    this.o.scene.add(this.stars);
    this.objects.push(this.stars);
  }

  private buildMoon(p: SkyPreset): void {
    const mat = new ShaderMaterial({
      name: 'Moon',
      vertexShader: moonVertex,
      fragmentShader: moonFragment,
      uniforms: {
        uMoonDir: { value: p.isNight ? p.sunDir.clone() : new Vector3(-0.5, 0.25, 0.6).normalize() },
        uMoonSize: { value: p.isNight ? 0.026 : 0.02 },
        uMoonMap: { value: null },
        uHasMap: { value: 0 },
        uMoonColor: { value: new Color(p.isNight ? 0xe8eeff : 0x9aa0b0).multiplyScalar(p.isNight ? 1 : 0.35) },
      },
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
    });
    this.moon = new Mesh(new PlaneGeometry(2.6, 2.6), mat);
    this.moon.name = 'moon';
    this.moon.frustumCulled = false;
    this.moon.renderOrder = 1002;
    this.o.scene.add(this.moon);
    this.objects.push(this.moon);
    new TextureLoader().load(
      'textures/moon_1024.jpg',
      (t) => {
        t.colorSpace = SRGBColorSpace;
        this.moonTex = t;
        mat.uniforms.uMoonMap.value = t;
        mat.uniforms.uHasMap.value = 1;
      },
      undefined,
      () => undefined,
    );
  }

  private buildLensflare(p: SkyPreset): void {
    const loader = new TextureLoader();
    const t0 = loader.load('textures/lensflare0.png');
    const t3 = loader.load('textures/lensflare3.png');
    this.flareTextures.push(t0, t3);
    const light = new PointLight(0xffffff, 0, 1);
    const lf = new Lensflare();
    const c = p.sunDisk.clone();
    lf.addElement(new LensflareElement(t0, 300, 0, c));
    lf.addElement(new LensflareElement(t3, 60, 0.6));
    lf.addElement(new LensflareElement(t3, 70, 0.7));
    lf.addElement(new LensflareElement(t3, 120, 0.9));
    lf.addElement(new LensflareElement(t3, 70, 1.0));
    light.add(lf);
    this.flareLight = light;
    this.o.scene.add(light);
    this.objects.push(light);
  }

  /** Camera-dependent placement (called right before rendering). */
  preRender(camera: Camera, camPos: Vector3, pixelRatio: number): void {
    if (this.stars) (this.stars.material as ShaderMaterial).uniforms.uPixelRatio.value = pixelRatio;
    if (this.flareLight) this.flareLight.position.copy(camPos).addScaledVector(this.preset.sunDir, 20_000);
    void camera;
  }

  private sunIntensity = -1;

  /** Override the directional light intensity (e.g. above an overcast deck). */
  setSunIntensity(i: number): void {
    this.sunIntensity = i;
  }

  /** Keep the light (and its shadow frustum) around the focus point; adjust fog for altitude/clouds. */
  update(focus: Vector3 | null, camY: number, inCloud: number, extraDim: number): void {
    const p = this.preset;
    const f = focus ?? this.origin;
    this.sun.target.position.copy(f);
    this.sun.position.copy(f).addScaledVector(p.sunDir, 600);
    this.sun.target.updateMatrixWorld();
    // three.js FogExp2 has no height term: approximate ours at the camera altitude.
    const dens = p.fogDensity * Math.exp(-Math.max(0, camY) / (2 * p.hazeHeight));
    this.fog.density = dens + inCloud * 0.004;
    this.fog.color.copy(this.baseFogColor).lerp(this.o.preset.cloudShade, inCloud * 0.6).multiplyScalar(1 - extraDim * 0.3);
    this.sun.intensity = (this.sunIntensity >= 0 ? this.sunIntensity : p.sunIntensity) * (1 - extraDim);
  }

  dispose(): void {
    for (const o of this.objects) o.removeFromParent();
    this.dome.geometry.dispose();
    this.domeMat.dispose();
    if (this.stars) {
      this.stars.geometry.dispose();
      (this.stars.material as ShaderMaterial).dispose();
    }
    if (this.moon) {
      this.moon.geometry.dispose();
      (this.moon.material as ShaderMaterial).dispose();
    }
    this.moonTex?.dispose();
    for (const t of this.flareTextures) t.dispose();
    this.flareLight?.children.forEach((c) => (c as Lensflare).dispose?.());
    this.sun.dispose();
    this.hemi.dispose();
    if (this.o.scene.fog === this.fog) this.o.scene.fog = null;
  }
}
