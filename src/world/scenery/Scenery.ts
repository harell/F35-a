/**
 * Scenery orchestrator: turns mission features (+ Auckland's own landmarks) into merged static
 * meshes (one draw call per feature), textured ground decals (runways, taxiways, aprons), a single
 * Points object for all night lights, and camera-local instanced scatters for trees and houses.
 */
import { Group, Mesh, type BufferGeometry, type Camera, type PerspectiveCamera, type ShaderMaterial, type Texture, type Vector3 } from 'three';
import type { SceneryFeature } from '../../core/contracts';
import type { QualitySettings, TheaterId } from '../../core/types';
import type { AtmosphereUniforms } from '../sky/atmosphere';
import type { Heightfield } from '../terrain/Heightfield';
import type { WorldConfig } from '../config';
import type { TerrainStyle } from '../terrain/TerrainRenderer';
import { createVegetation } from '../terrain/vegetation';
import { GeometryBuilder } from './GeometryBuilder';
import { DecalBuilder, LightList } from './builders';
import { buildAirbase } from './airbase';
import { buildSettlement } from './settlements';
import { aucklandBuiltinFeatures, buildCBD, buildHarbourBridge, buildMarinas, buildMuseumAndObelisk, buildPort, buildSkyTower, isDuplicateOfAuckland } from './auckland';
import { createBuildingMaterial, createDecalMaterial, createFoliageMaterial, createLightsMaterial } from './materials';
import { createRunwayTexture, runwayDesignators } from '../textures/runway';
import { createConcreteTexture } from '../textures/procedural';
import { TileScatter } from './scatter';
import { APARTMENT, ColorMapSampler, HOUSE, HouseSource, roofColorFn, TreeSource } from './sources';
import { apartmentRoofGeometry, apartmentWallsGeometry, broadleafGeometry, coniferGeometry, houseRoofGeometry, houseWallsGeometry, palmGeometry } from './archetypes';
import { TREE_BROADLEAF, TREE_CONIFER, TREE_PALM } from '../terrain/vegetation';
import { AKL } from '../../core/auckland';

export interface SceneryOptions {
  atmo: AtmosphereUniforms;
  hf: Heightfield;
  theater: TheaterId;
  seed: number;
  /** Mission features (Auckland built-ins are added here). */
  features: SceneryFeature[];
  quality: QualitySettings;
  cfg: WorldConfig;
  colorData: Uint8Array;
  colorSize: number;
  style: TerrainStyle;
  /** 0 = day … 1 = night (light intensity). */
  lights: number;
}

/** All features used for terrain flattening / baking / scenery (mission + theatre built-ins). */
export function allFeatures(theater: TheaterId, mission: SceneryFeature[]): SceneryFeature[] {
  if (theater !== 'auckland') return mission;
  return [...aucklandBuiltinFeatures(), ...mission.filter((f) => !isDuplicateOfAuckland(f))];
}

export class Scenery {
  readonly group = new Group();
  private readonly geometries: BufferGeometry[] = [];
  private readonly materials: ShaderMaterial[] = [];
  private readonly textures: Texture[] = [];
  private readonly trees: TileScatter | null;
  private readonly houses: TileScatter | null;
  private readonly lightsMat: ShaderMaterial;
  stats = { meshes: 0, lights: 0 };

  constructor(o: SceneryOptions) {
    this.group.name = 'world-scenery';
    const hf = o.hf;
    const height = (x: number, z: number) => hf.meshHeightAt(x, z);
    const detail = o.quality.sceneryDensity;
    const buildingMat = createBuildingMaterial(o.atmo);
    this.lightsMat = createLightsMaterial(o.atmo);
    this.lightsMat.uniforms.uIntensity.value = o.lights;
    this.materials.push(buildingMat, this.lightsMat);
    const lights = new LightList();
    const addMesh = (b: GeometryBuilder, name: string) => {
      const g = b.build();
      if (!g) return;
      this.geometries.push(g);
      const m = new Mesh(g, buildingMat);
      m.name = name;
      m.matrixAutoUpdate = false;
      this.group.add(m);
      this.stats.meshes++;
    };

    // ── Ground decals ──
    const concreteTex = createConcreteTexture();
    this.textures.push(concreteTex);
    const concrete = new DecalBuilder();
    const runways = new Map<string, { builder: DecalBuilder; length: number; names: [string, string] }>();

    // ── Features ──
    const features = allFeatures(o.theater, o.features);
    features.forEach((f, i) => {
      if (f.type === 'airbase') {
        const civil = o.theater === 'auckland' && Math.hypot(f.x - AKL.akl_airport.x, f.z - AKL.akl_airport.z) < 2500;
        const length = civil ? 3600 : 3000;
        const names = runwayDesignators(f.rotation ?? 0);
        const key = `${names[0]}/${names[1]}/${length}`;
        let rw = runways.get(key);
        if (!rw) {
          rw = { builder: new DecalBuilder(), length, names };
          runways.set(key, rw);
        }
        const b = new GeometryBuilder();
        buildAirbase({ feature: f, style: civil ? 'civil' : 'military', runwayLength: length }, { buildings: b, runway: rw.builder, concrete, lights }, height, detail);
        addMesh(b, `airbase-${i}`);
      } else if (f.type !== 'forest' && f.type !== 'farmland') {
        const b = new GeometryBuilder();
        buildSettlement(f, o.theater, b, lights, height, detail);
        addMesh(b, `${f.type}-${i}`);
      }
    });

    // ── Auckland landmarks ──
    if (o.theater === 'auckland') {
      const city = new GeometryBuilder();
      buildSkyTower(city, lights, height);
      buildCBD(city, lights, height, detail);
      buildMuseumAndObelisk(city, lights, height);
      addMesh(city, 'akl-cbd');
      const bridge = new GeometryBuilder();
      buildHarbourBridge(bridge, lights, height);
      addMesh(bridge, 'akl-harbour-bridge');
      const port = new GeometryBuilder();
      buildPort(port, lights, height, detail);
      buildMarinas(port, lights, height, detail);
      addMesh(port, 'akl-waterfront');
    }

    // Decal meshes
    for (const rw of runways.values()) {
      const g = rw.builder.build();
      if (!g) continue;
      const hi = o.quality.level === 'high';
      const tex = createRunwayTexture(rw.length, 45, rw.names);
      if (!hi) {
        // halve the canvas for mobile memory
        const img = tex.image as HTMLCanvasElement;
        const small = document.createElement('canvas');
        small.width = img.width / 2;
        small.height = img.height / 2;
        small.getContext('2d')!.drawImage(img, 0, 0, small.width, small.height);
        tex.image = small;
      }
      tex.anisotropy = o.cfg.anisotropy;
      this.textures.push(tex);
      const mat = createDecalMaterial(o.atmo, tex);
      this.materials.push(mat);
      this.geometries.push(g);
      const m = new Mesh(g, mat);
      m.name = 'runway';
      m.renderOrder = -5;
      this.group.add(m);
    }
    {
      const g = concrete.build();
      if (g) {
        concreteTex.anisotropy = o.cfg.anisotropy;
        const mat = createDecalMaterial(o.atmo, concreteTex);
        this.materials.push(mat);
        this.geometries.push(g);
        const m = new Mesh(g, mat);
        m.name = 'taxiways';
        m.renderOrder = -5;
        this.group.add(m);
      }
    }

    // Night lights
    if (o.lights > 0.01) {
      const pts = lights.build(this.lightsMat);
      if (pts) {
        this.geometries.push(pts.geometry);
        this.group.add(pts);
        this.stats.lights = lights.count;
      }
    }

    // ── Instanced scatters ──
    const cmap = new ColorMapSampler(o.colorData, o.colorSize, hf.origin, hf.extent);
    const veg = createVegetation(o.theater, o.seed, features);
    const foliage = createFoliageMaterial(o.atmo);
    this.materials.push(foliage);
    const treeCap = Math.max(300, o.cfg.treeMax);
    const snowy = o.theater === 'arctic';
    const treeGeoms = [palmGeometry(), broadleafGeometry(), coniferGeometry(snowy)];
    this.geometries.push(...treeGeoms);
    this.trees = new TileScatter(
      new TreeSource(hf, cmap, veg, o.theater, o.seed),
      [
        { geometry: treeGeoms[TREE_PALM], material: foliage, capacity: Math.round(treeCap * 0.4), kind: TREE_PALM },
        { geometry: treeGeoms[TREE_BROADLEAF], material: foliage, capacity: treeCap, kind: TREE_BROADLEAF },
        { geometry: treeGeoms[TREE_CONIFER], material: foliage, capacity: treeCap, kind: TREE_CONIFER },
      ],
      400,
      o.cfg.treeRadius,
      2,
    );
    for (const m of this.trees.meshes) this.group.add(m);

    const houseGeoms = [houseWallsGeometry(), houseRoofGeometry(), apartmentWallsGeometry(), apartmentRoofGeometry()];
    this.geometries.push(...houseGeoms);
    const roofFn = roofColorFn(o.style.roofs);
    const hc = o.cfg.houseMax;
    this.houses = new TileScatter(
      new HouseSource(hf, cmap),
      [
        { geometry: houseGeoms[0], material: buildingMat, capacity: hc, kind: HOUSE },
        { geometry: houseGeoms[1], material: buildingMat, capacity: hc, kind: HOUSE, color: roofFn },
        { geometry: houseGeoms[2], material: buildingMat, capacity: Math.round(hc / 3), kind: APARTMENT },
        { geometry: houseGeoms[3], material: buildingMat, capacity: Math.round(hc / 3), kind: APARTMENT, color: roofFn },
      ],
      300,
      o.cfg.houseRadius,
      2,
    );
    for (const m of this.houses.meshes) this.group.add(m);
  }

  /** Stream scatter tiles; hide them when the camera is too high for them to matter. */
  update(camPos: Vector3, agl: number): void {
    if (this.trees) {
      this.trees.visible = agl < 2200;
      if (this.trees.visible) this.trees.update(camPos);
    }
    if (this.houses) {
      this.houses.visible = agl < 1500;
      if (this.houses.visible) this.houses.update(camPos);
    }
  }

  preRender(camera: Camera, pixelRatio: number, viewportHeight: number): void {
    const cam = camera as PerspectiveCamera;
    const fov = cam.isPerspectiveCamera ? (cam.fov * Math.PI) / 180 : 1;
    this.lightsMat.uniforms.uPixelScale.value = viewportHeight / (2 * Math.tan(fov / 2));
    this.lightsMat.uniforms.uPixelRatio.value = pixelRatio;
  }

  get idle(): boolean {
    return (this.trees?.idle ?? true) && (this.houses?.idle ?? true);
  }

  get instanceCount(): number {
    return (this.trees?.instanceCount ?? 0) + (this.houses?.instanceCount ?? 0);
  }

  dispose(): void {
    this.group.removeFromParent();
    this.trees?.dispose();
    this.houses?.dispose();
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
    for (const t of this.textures) t.dispose();
  }
}
