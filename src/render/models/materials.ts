/**
 * Shared material cache + procedural environment map.
 *
 * All models reference materials by string key ("f35.skin", "vehicle", ...). Materials are created
 * lazily once and shared by every instance (clones share geometry + material). Canvas textures are
 * skipped gracefully when no canvas exists (vitest/node), so geometry builders stay testable.
 */
import {
  CanvasTexture,
  Color,
  CubeTexture,
  LinearMipmapLinearFilter,
  Material,
  MeshBasicMaterial,
  MeshLambertMaterial,
  MeshStandardMaterial,
  RepeatWrapping,
  SRGBColorSpace,
  type Texture,
} from 'three';
import { createCanvas, rng, type Canvas2D } from './geom/atlas';

type Factory = () => Material;

const factories = new Map<string, Factory>();
const cache = new Map<string, Material>();
const textures: Texture[] = [];

/** Global texture detail (set from QualitySettings before first build). */
export const modelQuality = { textureSize: 1024, envIntensity: 1, anisotropy: 1 };

export function registerMaterial(key: string, f: Factory): void {
  if (!factories.has(key)) factories.set(key, f);
}

export function getMaterial(key: string): Material {
  let m = cache.get(key);
  if (m) return m;
  const f = factories.get(key) ?? builtin(key);
  m = f();
  m.name = key;
  cache.set(key, m);
  return m;
}

/** Derived material variant (cached), e.g. a vertex-coloured LOD copy of a skin. */
export function getVariant(key: string, variant: string, make: (base: Material) => Material): Material {
  const k = `${key}#${variant}`;
  let m = cache.get(k);
  if (!m) {
    m = make(getMaterial(key));
    m.name = k;
    cache.set(k, m);
  }
  return m;
}

/** Every material created so far (for env-map/night tweaks). */
export function allMaterials(): Material[] {
  return [...cache.values()];
}

/** Charred/burnt variant of any material key (shared, cached). */
export function charredMaterial(): Material {
  return getMaterial('charred');
}

export function canvasTexture(c: Canvas2D | null, srgb = true, repeat = false): Texture | null {
  if (!c) return null;
  const t = new CanvasTexture(c as HTMLCanvasElement);
  if (srgb) t.colorSpace = SRGBColorSpace;
  t.anisotropy = modelQuality.anisotropy;
  t.minFilter = LinearMipmapLinearFilter;
  if (repeat) t.wrapS = t.wrapT = RepeatWrapping;
  t.needsUpdate = true;
  textures.push(t);
  return t;
}

/* ───────────────────────── environment (reflections) ───────────────────────── */

let envCube: CubeTexture | null = null;

/**
 * Tiny procedural sky cube (sky gradient above, hazy horizon, earth below). three.js converts a
 * CubeTexture envMap to PMREM automatically for standard materials, so this gives cheap, plausible
 * reflections on the canopy and the RAM coating when the environment module provides none.
 */
export function getEnvCube(): CubeTexture | null {
  if (envCube) return envCube;
  const size = 64;
  const faces: Canvas2D[] = [];
  const sky = (y: number) => {
    // y in [-1,1]: world up component of the direction
    if (y > 0) {
      const t = Math.pow(y, 0.6);
      return [lerp(205, 70, t), lerp(220, 120, t), lerp(235, 200, t)];
    }
    const t = Math.pow(-y, 0.5);
    return [lerp(150, 70, t), lerp(145, 68, t), lerp(135, 60, t)];
  };
  // face order: +x, -x, +y, -y, +z, -z
  for (let f = 0; f < 6; f++) {
    const c = createCanvas(size, size);
    if (!c) return null;
    const ctx = c.getContext('2d') as CanvasRenderingContext2D;
    const img = ctx.createImageData(size, size);
    for (let j = 0; j < size; j++) {
      for (let i = 0; i < size; i++) {
        const a = (i + 0.5) / size * 2 - 1;
        const b = (j + 0.5) / size * 2 - 1;
        let x: number;
        let y: number;
        let z: number;
        switch (f) {
          case 0: x = 1; y = -b; z = -a; break;
          case 1: x = -1; y = -b; z = a; break;
          case 2: x = a; y = 1; z = b; break;
          case 3: x = a; y = -1; z = -b; break;
          case 4: x = a; y = -b; z = 1; break;
          default: x = -a; y = -b; z = -1; break;
        }
        const l = Math.hypot(x, y, z);
        const col = sky(y / l);
        // sun glint towards +x/+y
        const sun = Math.max(0, (x * 0.6 + y * 0.55 + z * 0.3) / l);
        const s = Math.pow(sun, 60) * 255;
        const o = (j * size + i) * 4;
        img.data[o] = Math.min(255, col[0] + s);
        img.data[o + 1] = Math.min(255, col[1] + s);
        img.data[o + 2] = Math.min(255, col[2] + s * 0.9);
        img.data[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    faces.push(c);
  }
  envCube = new CubeTexture(faces as unknown as HTMLImageElement[]);
  envCube.colorSpace = SRGBColorSpace;
  envCube.needsUpdate = true;
  return envCube;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/* ───────────────────────── generic tiling textures ───────────────────────── */

let grime: Texture | null | undefined;
/** Tiling grime/noise texture (sRGB, mostly white) for vehicles & buildings (multiplied by vertex colour). */
export function grimeTexture(): Texture | null {
  if (grime !== undefined) return grime;
  const s = 256;
  const c = createCanvas(s, s);
  if (!c) return (grime = null);
  const ctx = c.getContext('2d') as CanvasRenderingContext2D;
  ctx.fillStyle = '#e8e8e8';
  ctx.fillRect(0, 0, s, s);
  const r = rng(77);
  for (let i = 0; i < 160; i++) {
    const x = r() * s;
    const y = r() * s;
    const rad = 6 + r() * 30;
    const g = ctx.createRadialGradient(x, y, 0, x, y, rad);
    const dark = r() > 0.35;
    g.addColorStop(0, dark ? 'rgba(40,35,30,0.07)' : 'rgba(255,255,255,0.06)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    // wrap-around draw for seamless tiling
    for (const ox of [-s, 0, s]) for (const oy of [-s, 0, s]) ctx.fillRect(x - rad + ox, y - rad + oy, rad * 2, rad * 2);
  }
  for (let i = 0; i < 5000; i++) {
    ctx.fillStyle = r() > 0.5 ? 'rgba(0,0,0,0.05)' : 'rgba(255,255,255,0.04)';
    ctx.fillRect(Math.floor(r() * s), Math.floor(r() * s), 1, 1);
  }
  // streaks (rain/rust)
  for (let i = 0; i < 40; i++) {
    ctx.fillStyle = 'rgba(50,40,30,0.045)';
    ctx.fillRect(Math.floor(r() * s), Math.floor(r() * s), 1 + r() * 2, 10 + r() * 40);
  }
  return (grime = canvasTexture(c, true, true));
}

/* ───────────────────────── built-in materials ───────────────────────── */

function std(opts: ConstructorParameters<typeof MeshStandardMaterial>[0]): MeshStandardMaterial {
  const m = new MeshStandardMaterial(opts);
  const env = getEnvCube();
  if (env && !m.envMap) m.envMap = env;
  return m;
}

function builtin(key: string): Factory {
  switch (key) {
    case 'dark':
      // intakes, exhaust interiors, tyres, cockpit tubs (vertex colours tint small parts)
      return () => new MeshLambertMaterial({ color: 0xffffff, vertexColors: true });
    case 'darkStd':
      return () => std({ color: 0xffffff, vertexColors: true, roughness: 0.7, metalness: 0.2, envMapIntensity: 0.4 });
    case 'metal':
      return () => std({ color: 0x55585c, roughness: 0.45, metalness: 0.75, envMapIntensity: 0.8, vertexColors: true });
    case 'glass.gold':
      // F-35 canopy: dark gold-tinted, very reflective, slightly see-through
      return () =>
        std({
          color: 0xb57a32,
          roughness: 0.05,
          metalness: 1,
          envMapIntensity: 1.7,
          transparent: true,
          opacity: 0.86,
          depthWrite: true,
        });
    case 'glass.clear':
      // Russian fighters: clear, slightly blue canopy
      return () =>
        std({ color: 0x223040, roughness: 0.05, metalness: 0.8, envMapIntensity: 1.3, transparent: true, opacity: 0.55 });
    case 'glass.eots':
      return () => std({ color: 0x3a3020, roughness: 0.04, metalness: 1, envMapIntensity: 2 });
    case 'vehicle':
      return () => new MeshLambertMaterial({ color: 0xffffff, vertexColors: true, map: grimeTexture() });
    case 'building':
      return () => new MeshLambertMaterial({ color: 0xffffff, vertexColors: true, map: grimeTexture() });
    case 'yacht':
      // superyachts (#145): glossy paint, a little of the sky in the hull
      return () => std({ color: 0xffffff, vertexColors: true, roughness: 0.32, metalness: 0.05, envMapIntensity: 0.7 });
    case 'munition':
      return () => std({ color: 0xffffff, vertexColors: true, roughness: 0.5, metalness: 0.1, envMapIntensity: 0.5 });
    case 'charred':
      return () => new MeshLambertMaterial({ color: 0x3a3632, map: grimeTexture() });
    case 'emissive':
      return () => new MeshBasicMaterial({ color: 0xffffff, vertexColors: true, toneMapped: false });
    case 'shadowblob':
      return () => new MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35, depthWrite: false });
    default:
      console.warn(`[render] unknown material "${key}" — using grey`);
      return () => new MeshLambertMaterial({ color: new Color(0x888888) });
  }
}

/** Night / environment adjustments for every standard material. */
export function setEnvironment(envMap: Texture | null, intensityScale: number): void {
  for (const m of cache.values()) {
    if ((m as MeshStandardMaterial).isMeshStandardMaterial) {
      const s = m as MeshStandardMaterial;
      if (envMap && s.envMap !== envMap) {
        s.envMap = envMap;
        s.needsUpdate = true;
      }
      const base = (s.userData.baseEnv as number | undefined) ?? s.envMapIntensity;
      s.userData.baseEnv = base;
      s.envMapIntensity = base * intensityScale;
    }
  }
}

/** Dispose every cached material + texture (the cache is rebuilt lazily). */
export function disposeMaterials(): void {
  for (const m of cache.values()) m.dispose();
  cache.clear();
  for (const t of textures) t.dispose();
  textures.length = 0;
  grime = undefined;
  envCube?.dispose();
  envCube = null;
}
