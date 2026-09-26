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
  RGBAFormat,
  SRGBColorSpace,
  UnsignedByteType,
  Vector3,
  type Camera,
  type Scene,
  type WebGLRenderer,
} from 'three';
import type { CreateEnvironment, EnvironmentApi, FrameContext } from '../core/contracts';
import { generateTerrain } from './terrain/generate';
import { TerrainQueryImpl } from './terrain/TerrainQueryImpl';
import { TerrainRenderer } from './terrain/TerrainRenderer';
import { bakeColorRows, bakeSunVisibility, bakeSurface } from './terrain/bake';
import { skyPreset } from './sky/presets';
import { createAtmosphereUniforms } from './sky/atmosphere';
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
  readonly stats: () => { patches: number; genMs: number; instances: number; meshes: number; lights: number; idle: boolean };
}

export const createEnvironment: CreateEnvironment = async (scene, renderer, opts) => {
  const t0 = performance.now();
  const q = opts.quality;
  const cfg = worldConfig(q);
  const report = (f: number, label: string) => opts.onProgress?.(Math.min(1, Math.max(0, f)), label);
  const preset = skyPreset(opts.theater, opts.timeOfDay, opts.weather, q.drawDistance);
  const features = allFeatures(opts.theater, opts.features);

  // ── 1. Heightfield ──
  report(0, 'Generating terrain');
  await yieldToEventLoop();
  const hf = await runSliced(
    generateTerrain({ theater: opts.theater, seed: opts.seed, resolution: cfg.hfResolution, features, pads: opts.pads }),
    (f) => report(f * 0.55, 'Generating terrain'),
  );
  const terrainQuery = new TerrainQueryImpl(hf);
  const genMs = performance.now() - t0;

  // ── 2. Bakes ──
  report(0.57, 'Baking light & shadows');
  await yieldToEventLoop();
  const n = hf.n;
  const vis = new Uint8Array(n * n);
  bakeSunVisibility(hf, preset.sunDir, vis, 22 + hf.cell * 0.15);
  const surfaceData = new Uint8Array(n * n * 4);
  bakeSurface(hf, vis, surfaceData);
  report(0.62, 'Painting terrain');
  await yieldToEventLoop();
  const colorSize = Math.min(1024, n);
  const colorData = new Uint8Array(colorSize * colorSize * 4);
  const bakeOpts = { theater: opts.theater, seed: opts.seed, features };
  await runSliced(
    (function* () {
      const rows = 32;
      for (let j = 0; j < colorSize; j += rows) {
        const j1 = Math.min(colorSize, j + rows);
        bakeColorRows(hf, bakeOpts, colorSize, j, j1, colorData.subarray(j * colorSize * 4, j1 * colorSize * 4));
        yield j1 / colorSize;
      }
    })(),
    (f) => report(0.62 + f * 0.2, 'Painting terrain'),
  );

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
  const cloudLayer = createCloudLayerTexture();

  const atmo = createAtmosphereUniforms(preset, q.drawDistance);
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
  });
  scene.add(water.mesh);

  const cloudAtlas = createCloudAtlas();
  const clouds = new Clouds({ weather: opts.weather, quality: q, preset, atmo, atlas: cloudAtlas, layer: cloudLayer, seed: opts.seed });
  for (const m of clouds.meshes) scene.add(m);

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
  });
  scene.add(scenery.group);

  report(1, 'World ready');

  // ── Per-frame ──
  const camPos = new Vector3();
  const focus = new Vector3();
  let time = 0;
  const pixelRatio = () => renderer.getPixelRatio();

  const preRender = (camera: Camera) => {
    camera.getWorldPosition(camPos);
    atmo.uCamPos.value.copy(camPos);
    const far = (camera as Camera & { far?: number }).far ?? q.drawDistance;
    atmo.uFogFar.value = Math.min(far, q.drawDistance);
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
    stats: () => ({ patches: terrain.lastPatchCount, genMs, instances: scenery.instanceCount, meshes: scenery.stats.meshes, lights: scenery.stats.lights, idle: scenery.idle }),

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
      sky.update(f ? focus : null, camY, inCloud, 0);
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
      clouds.dispose();
      cloudAtlas.dispose();
      sky.dispose();
      surfaceTex.dispose();
      colorTex.dispose();
      detail.detail.dispose();
      detail.normal.dispose();
      cloudLayer.dispose();
    },
  };
  return env;
};

export type { EnvironmentOptions };
export type { WebGLRenderer };
