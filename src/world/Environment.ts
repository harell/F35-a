/**
 * WORLD module entry point: builds the terrain (deterministic per theatre + seed), sky, lighting,
 * water, clouds and scenery for a mission, and implements the TerrainQuery used by the sim.
 *
 *   createEnvironment(scene, renderer, opts)  (async, reports progress)
 *     1. heightfield generation (time-sliced; ~1024² or 2048² on high)
 *     2. texture bakes: soft sun shadows + normals + water depth, albedo/forest/urban colour map
 *     3. GPU objects: CDLOD terrain, water, sky dome/lights/fog, clouds, scenery
 *
 * Camera-dependent work (LOD selection, sky/water centring, cloud sorting) runs in
 * scene.onBeforeRender so it always matches the camera actually being rendered.
 */
import {
  ClampToEdgeWrapping,
  DataTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  RedFormat,
  RGBAFormat,
  SRGBColorSpace,
  UnsignedByteType,
  Vector3,
  type Camera,
  type Scene,
  type WebGLRenderer,
} from 'three';
import type { CreateEnvironment, EnvironmentApi, FrameContext } from '../core/contracts';
import { BASE_MAX, finishTerrain, generateTerrain } from './terrain/generate';
import { reduceView, TerrainWorkerPool } from './terrain/parallel';
import { anchorsFor } from './terrain/features';
import { Heightfield as HeightfieldClass } from './terrain/Heightfield';
import { HF_EXTENT } from './terrain/types';
import { TerrainQueryImpl } from './terrain/TerrainQueryImpl';
import { coastUniforms, TerrainRenderer, type CoastMaskInfo } from './terrain/TerrainRenderer';
import { LightReflections } from './scenery/nightLights';
import { bakeAucklandCoastMask, WHENUAPAI_CROSS } from './terrain/theaters/auckland';
import { aucklandLinzBytes, loadAucklandLinz } from './terrain/theaters/aucklandLinz';
import { loadAucklandRoads } from './scenery/aucklandRoads';
import { loadAucklandBuildings } from './scenery/aucklandBuildings';
import { footprintOf } from './terrain/features';
import type { SceneryFeature } from '../core/contracts';
import { bakeColorRows, bakeSunVisibility, bakeSurface, dilateLandColour } from './terrain/bake';
import { skyPreset } from './sky/presets';
import { blendAtmosphere, createAtmosphereUniforms } from './sky/atmosphere';
import { SkySystem } from './sky/SkySystem';
import { Water } from './water/Water';
import { createCloudAtlas, createCloudLayerTexture, createDetailTextures } from './textures/procedural';
import { Clouds } from './clouds/Clouds';
import { terrainStyle, worldConfig } from './config';
import { runSliced, yieldToEventLoop } from './util/async';
import type { Heightfield } from './terrain/Heightfield';
import { allFeatures, Scenery } from './scenery/Scenery';
import type { EnvironmentOptions } from '../core/contracts';

/** Extra (non-contract) surface for dev tools / other world code. */
export interface EnvironmentInternals extends EnvironmentApi {
  readonly heightfield: Heightfield;
  readonly stats: () => { patches: number; genMs: number; bakeMs: number; workers: number; timings: Record<string, number>; instances: number; meshes: number; lights: number; idle: boolean };
}

export const createEnvironment: CreateEnvironment = async (scene, renderer, opts) => {
  const t0 = performance.now();
  const q = opts.quality;
  const cfg = worldConfig(q);
  const report = (f: number, label: string) => opts.onProgress?.(Math.min(1, Math.max(0, f)), label);
  const preset = skyPreset(opts.theater, opts.timeOfDay, opts.weather, q.drawDistance);
  const features = allFeatures(opts.theater, opts.features);
  // Above an overcast deck the sky is clear and sunny.
  const abovePreset = opts.weather === 'overcast' ? skyPreset(opts.theater, opts.timeOfDay, 'clear', q.drawDistance) : null;
  let lastAbove = -1;

  // ── 1. Heightfield (worker pool when available, else time-sliced on the main thread) ──
  report(0, 'Generating terrain');
  await yieldToEventLoop();
  const spec = { theater: opts.theater, seed: opts.seed, resolution: cfg.hfResolution, features, pads: opts.pads };
  // Real coastline + terrain heights, road centrelines and CBD buildings (LINZ); each falls back to
  // the hand-traced map / roads or the procedural CBD if unavailable.
  if (opts.theater === 'auckland') await Promise.all([loadAucklandLinz(), loadAucklandRoads(), loadAucklandBuildings()]);
  let pool = TerrainWorkerPool.create();
  if (pool && opts.theater === 'auckland') {
    try {
      await pool.setLinz(aucklandLinzBytes());
    } catch (err) {
      console.warn('[world] terrain workers failed, falling back to main thread', err);
      pool.dispose();
      pool = null;
    }
  }
  const workerCount = pool?.size ?? 0;
  // High-resolution coast mask (Auckland): 15 m signed coast distance over the central 32 km,
  // baked on the workers alongside the heightfield.
  const coastN = opts.theater === 'auckland' ? (q.terrainDetail === 0 ? 1024 : 2048) : 0;
  const coastExtent = 32_000;
  let coastPromise: Promise<Uint8Array | null> | null = null;
  if (coastN && pool) coastPromise = pool.bakeCoast(opts.seed, coastN, coastExtent).catch(() => null);
  let hf: Heightfield | null = null;
  if (pool) {
    try {
      const anchors = anchorsFor(features, opts.pads);
      const baseN = Math.min(BASE_MAX, cfg.hfResolution);
      const res = await pool.generateBase(opts.theater, opts.seed, anchors, baseN, (f) => report(f * 0.45, 'Generating terrain'));
      const base = new HeightfieldClass(baseN, HF_EXTENT);
      base.data.set(res.data);
      base.mat.set(res.mat);
      base.aux.set(res.aux);
      hf = await runSliced(finishTerrain(base, spec, anchors, 0), (f) => report(0.45 + f * 0.1, 'Shaping terrain'));
    } catch (err) {
      console.warn('[world] terrain workers failed, falling back to main thread', err);
      hf = null;
    }
  }
  if (!hf) hf = await runSliced(generateTerrain(spec), (f) => report(f * 0.55, 'Generating terrain'));
  const terrainQuery = new TerrainQueryImpl(hf);
  const genMs = performance.now() - t0;

  // ── 2. Bakes ──
  const timings: Record<string, number> = { generate: Math.round(genMs) };
  let mark = performance.now();
  const lap = (name: string) => {
    const now = performance.now();
    timings[name] = Math.round(now - mark);
    mark = now;
  };
  report(0.57, 'Baking light & shadows');
  await yieldToEventLoop();
  const n = hf.n;
  const vis = new Uint8Array(n * n);
  bakeSunVisibility(hf, preset.sunDir, vis, 22 + hf.cell * 0.15);
  const surfaceData = new Uint8Array(n * n * 4);
  bakeSurface(hf, vis, surfaceData);
  lap('light');
  report(0.62, 'Painting terrain');
  await yieldToEventLoop();
  const colorSize = Math.min(1024, n);
  let colorData: Uint8Array | null = null;
  if (pool) {
    if (coastPromise) await coastPromise;
    try {
      colorData = await pool.bakeColor(hf, opts.theater, opts.seed, features, colorSize, (f) => report(0.62 + f * 0.2, 'Painting terrain'));
    } catch (err) {
      console.warn('[world] colour bake workers failed, falling back to main thread', err);
    }
    pool.dispose();
  }
  let coastData: Uint8Array | null = coastPromise ? await coastPromise : null;
  if (coastN && !coastData) {
    const cd = new Uint8Array(coastN * coastN);
    const seed = opts.seed;
    await runSliced(
      (function* () {
        const rows = 256;
        for (let j = 0; j < coastN; j += rows) {
          const j1 = Math.min(coastN, j + rows);
          cd.set(bakeAucklandCoastMask(seed, coastN, coastExtent, j, j1), j * coastN);
          yield j1 / coastN;
        }
      })(),
      () => undefined,
    );
    coastData = cd;
  }
  if (!colorData) {
    const cd = new Uint8Array(colorSize * colorSize * 4);
    const bakeOpts = { theater: opts.theater, seed: opts.seed, features };
    const hfv = hf;
    await runSliced(
      (function* () {
        const rows = 32;
        for (let j = 0; j < colorSize; j += rows) {
          const j1 = Math.min(colorSize, j + rows);
          bakeColorRows(hfv, bakeOpts, colorSize, j, j1, cd.subarray(j * colorSize * 4, j1 * colorSize * 4));
          yield j1 / colorSize;
        }
      })(),
      (f) => report(0.62 + f * 0.2, 'Painting terrain'),
    );
    colorData = cd;
  }
  if (opts.theater === 'auckland') {
    const view = colorSize === n ? hf.data : reduceView(hf, colorSize).data;
    dilateLandColour(colorData, view, colorSize);
  }
  const bakeMs = performance.now() - t0;
  lap('colour');

  // ── 3. GPU objects ──
  report(0.84, 'Building world');
  await yieldToEventLoop();
  const maxAniso = renderer.capabilities.getMaxAnisotropy();
  const surfaceTex = new DataTexture(surfaceData, n, n, RGBAFormat, UnsignedByteType);
  surfaceTex.wrapS = surfaceTex.wrapT = ClampToEdgeWrapping;
  surfaceTex.magFilter = LinearFilter;
  surfaceTex.minFilter = LinearMipmapLinearFilter;
  surfaceTex.generateMipmaps = true;
  surfaceTex.needsUpdate = true;
  const colorTex = new DataTexture(colorData, colorSize, colorSize, RGBAFormat, UnsignedByteType);
  colorTex.colorSpace = SRGBColorSpace;
  colorTex.wrapS = colorTex.wrapT = ClampToEdgeWrapping;
  colorTex.magFilter = LinearFilter;
  colorTex.minFilter = LinearMipmapLinearFilter;
  colorTex.generateMipmaps = true;
  colorTex.anisotropy = Math.min(maxAniso, cfg.anisotropy);
  colorTex.needsUpdate = true;
  const detail = createDetailTextures();
  detail.detail.anisotropy = detail.normal.anisotropy = Math.min(maxAniso, cfg.anisotropy);
  let coast: CoastMaskInfo | null = null;
  if (coastData) {
    const t = new DataTexture(coastData, coastN, coastN, RedFormat, UnsignedByteType);
    t.wrapS = t.wrapT = ClampToEdgeWrapping;
    t.magFilter = LinearFilter;
    t.minFilter = LinearMipmapLinearFilter;
    t.generateMipmaps = true;
    t.needsUpdate = true;
    coast = { texture: t, x0: -coastExtent / 2, z0: -coastExtent / 2, size: coastExtent };
  }
  const dummyTex = new DataTexture(new Uint8Array([128, 128, 128, 255]), 1, 1, RGBAFormat, UnsignedByteType);
  dummyTex.needsUpdate = true;
  const cloudLayer = createCloudLayerTexture();

  const atmo = createAtmosphereUniforms(preset, q.drawDistance);
  // Auckland's light dome at night (centre of the built-up area, ~12 km radius)
  if (opts.theater === 'auckland' && preset.lights > 0.01) atmo.uCityGlow.value.set(1500, 2500, 12_000, 0.035 * preset.lights * (opts.weather === 'overcast' ? 1.8 : 1));
  const cloudCover = opts.weather === 'overcast' ? 0.75 : opts.weather === 'scattered' ? 0.42 : 0.12;
  const sky = new SkySystem({ scene, preset, atmo, quality: q, cloudLayer, cloudCover });

  const style = terrainStyle(opts.theater);
  const terrain = new TerrainRenderer({
    hf,
    surface: surfaceTex,
    color: colorTex,
    colorSize,
    detail: detail.detail,
    detailNormal: detail.normal,
    atmo,
    style,
    patchQuads: cfg.patchQuads,
    drawDistance: q.drawDistance,
    lodRange: cfg.lodRange,
    coast,
    dummy: dummyTex,
    noFields: airfieldRects(features, opts.theater),
    seaShallow: preset.waterShallow,
  });
  scene.add(terrain.mesh);

  const water = new Water({
    atmo,
    heightTexture: terrain.heightTexture,
    detail: detail.detail,
    hf: { origin: hf.origin, cell: hf.cell, n: hf.n },
    deep: preset.waterDeep,
    shallow: preset.waterShallow,
    seaIce: preset.seaIce,
    shallowDepth: preset.shallowDepth,
    radius: q.drawDistance * 1.2,
    coast,
    dummy: dummyTex,
  });
  scene.add(water.mesh);

  const cloudAtlas = createCloudAtlas();
  const clouds = new Clouds({ weather: opts.weather, quality: q, preset, atmo, atlas: cloudAtlas, layer: cloudLayer, seed: opts.seed });
  for (const m of clouds.meshes) scene.add(m);

  lap('gpu');
  report(0.92, 'Placing scenery');
  await yieldToEventLoop();
  const scenery = new Scenery({
    atmo,
    hf,
    theater: opts.theater,
    seed: opts.seed,
    features: opts.features,
    quality: q,
    cfg,
    colorData,
    colorSize,
    style,
    lights: preset.lights,
    skyTowerRuin: opts.skyTowerRuin?.fallHeading ?? null,
  });
  scene.add(scenery.group);
  let reflections: LightReflections | null = null;
  if (scenery.reflectionSources.length) {
    reflections = new LightReflections(atmo, scenery.reflectionSources, water.normalMapUniform, coastUniforms(coast, dummyTex));
    scene.add(reflections.mesh);
  }
  // the Sky Tower's own reflections (they go out with its lights when it falls)
  let towerReflections: LightReflections | null = null;
  if (scenery.skyTower?.reflectionSources.length) {
    towerReflections = new LightReflections(atmo, scenery.skyTower.reflectionSources, water.normalMapUniform, coastUniforms(coast, dummyTex));
    towerReflections.mesh.name = 'akl-skytower-reflections';
    scene.add(towerReflections.mesh);
    scenery.skyTower.setReflections(towerReflections.mesh);
  }

  lap('scenery');
  timings.total = Math.round(performance.now() - t0);
  report(1, 'World ready');

  // ── Per-frame ──
  const camPos = new Vector3();
  const focus = new Vector3();
  let time = 0;
  const pixelRatio = () => renderer.getPixelRatio();

  const preRender = (camera: Camera) => {
    camera.getWorldPosition(camPos);
    atmo.uCamPos.value.copy(camPos);
    // The fog must reach the horizon colour exactly at the far plane (tactical view sets a longer far).
    const far = (camera as Camera & { far?: number }).far ?? q.drawDistance;
    atmo.uFogFar.value = far;
    terrain.update(camera);
    water.preRender(camPos);
    sky.preRender(camera, camPos, pixelRatio());
    scenery.preRender(camera, pixelRatio(), renderer.domElement.height / pixelRatio());
    clouds.preRender(camPos);
  };
  // Scene.onBeforeRender is invoked with (renderer, scene, camera, renderTarget) by WebGLRenderer.
  type SceneHook = (renderer: WebGLRenderer, scene: Scene, camera: Camera, target: unknown) => void;
  const prevHook = scene.onBeforeRender as unknown as SceneHook;
  const hook: SceneHook = function (this: Scene, r, s, cam, rt) {
    prevHook.call(this, r, s, cam, rt);
    preRender(cam);
  };
  scene.onBeforeRender = hook as unknown as Scene['onBeforeRender'];

  const env: EnvironmentInternals = {
    terrain: terrainQuery,
    sunDirection: preset.sunDir.clone(),
    isNight: preset.isNight,
    fogColor: preset.fogColor.getHex(),
    heightfield: hf,
    stats: () => ({ patches: terrain.lastPatchCount, genMs, bakeMs, workers: workerCount, timings, instances: scenery.instanceCount, meshes: scenery.stats.meshes, lights: scenery.stats.lights, idle: scenery.idle }),

    update(ctx: FrameContext) {
      if (!ctx.paused) {
        time += ctx.dt;
        clouds.update(ctx.dt);
      }
      atmo.uTime.value = time;
      const cam = ctx.camera;
      const camY = cam ? cam.position.y : 0;
      const f = ctx.player?.position ?? (cam ? cam.position : null);
      if (f) focus.copy(f);
      // Inside a cloud: white-out (much denser fog for everything)
      const inCloud = cam ? clouds.inCloud(cam.position) : 0;
      atmo.uFogDensity.value = preset.fogDensity * (1 + 300 * inCloud * inCloud);
      const deckY = clouds.deckAltitude;
      if (abovePreset && deckY !== null) {
        const t = Math.min(1, Math.max(0, (camY - deckY - 120) / 600));
        if (Math.abs(t - lastAbove) > 0.002) {
          lastAbove = t;
          blendAtmosphere(atmo, preset, abovePreset, t);
          sky.setSunIntensity(preset.sunIntensity + (abovePreset.sunIntensity - preset.sunIntensity) * t);
        }
      }
      sky.update(f ? focus : null, camY, inCloud, 0);
      scenery.updateLandmarks(ctx.world);
      if (cam) {
        const agl = cam.position.y - terrainQuery.surfaceHeightAt(cam.position.x, cam.position.z);
        scenery.update(cam.position, agl);
      }
    },

    dispose() {
      if ((scene.onBeforeRender as unknown) === hook) scene.onBeforeRender = prevHook as unknown as Scene['onBeforeRender'];
      terrain.dispose();
      water.dispose();
      scenery.dispose();
      reflections?.dispose();
      towerReflections?.dispose();
      clouds.dispose();
      cloudAtlas.dispose();
      sky.dispose();
      surfaceTex.dispose();
      colorTex.dispose();
      detail.detail.dispose();
      detail.normal.dispose();
      cloudLayer.dispose();
      coast?.texture.dispose();
      dummyTex.dispose();
    },
  };
  return env;
};

/** Airfield rectangles (runway strips + aprons) where the terrain shader draws no paddocks. */
function airfieldRects(features: SceneryFeature[], theater: string): { x: number; z: number; heading: number; halfW: number; halfL: number }[] {
  const out: { x: number; z: number; heading: number; halfW: number; halfL: number }[] = [];
  for (const f of features) {
    if (f.type !== 'airbase') continue;
    const fp = footprintOf(f);
    out.push({ x: fp.x, z: fp.z, heading: fp.heading, halfW: fp.halfW * 0.8, halfL: fp.halfL });
  }
  if (theater === 'auckland') {
    const X = WHENUAPAI_CROSS;
    out.push({ x: X.x, z: X.z, heading: X.heading, halfW: 150, halfL: X.length / 2 + 120 });
  }
  return out.slice(0, 6);
}

export type { EnvironmentOptions };
export type { WebGLRenderer };
