/**
 * Scenery orchestrator: turns mission features (+ Auckland's own landmarks) into merged static
 * meshes (one draw call per feature), textured ground decals (runways, taxiways, aprons), a single
 * Points object for all night lights, and camera-local instanced scatters for trees and houses.
 */
import { Color, Group, Mesh, type BufferGeometry, type Camera, type PerspectiveCamera, type ShaderMaterial, type Texture, type Vector3 } from 'three';
import type { SceneryFeature } from '../../core/contracts';
import type { QualitySettings, TheaterId } from '../../core/types';
import type { AtmosphereUniforms } from '../sky/atmosphere';
import type { Heightfield } from '../terrain/Heightfield';
import type { WorldConfig } from '../config';
import { aerialUniforms, type AerialPhotoInfo, type TerrainStyle } from '../terrain/TerrainRenderer';
import { aerialCovers } from '../terrain/theaters/aucklandAerial';
import { createVegetation } from '../terrain/vegetation';
import { GeometryBuilder } from './GeometryBuilder';
import { DecalBuilder, LightList } from './builders';
import { buildAirbase, buildExtraRunway, buildRealAirfield } from './airbase';
import { airfieldLayout } from './aucklandOsm';
import { buildNavalBase, buildStadiums, buildWiriTerminal, siteBlocker, siteLayout } from './aucklandSites';
import { buildSettlement } from './settlements';
import { aucklandBuiltinFeatures, type CbdStats, buildCBD, buildCentres, buildHarbourBridge, buildMarinas, buildMuseumAndObelisk, buildPort, buildSkyCityPodium, isDuplicateOfAuckland } from './auckland';
import { SkyTowerVisual } from './skyTower';
import { aucklandRailPaths, aucklandRoadPaths, clipRailToLand, RoadNetwork } from './motorways';
import { aucklandBuildings } from './aucklandBuildings';
import { LotMask, urbanBounds } from './lotMask';
import { buildCityLightPoints, buildFacadeLightPoints, type ReflectionSource } from './nightLights';
import { AKL_CBD_GRID } from '../config';
import { createBuildingMaterial, createDecalMaterial, createFoliageMaterial, createLightsMaterial, createRoadMaterial } from './materials';
import { createRunwayTexture, runwayDesignators } from '../textures/runway';
import { createConcreteTexture, createMotorwayTexture, createRailTexture } from '../textures/procedural';
import { TileScatter } from './scatter';
import { APARTMENT, ColorMapSampler, HOUSE, HouseSource, roofColorFn, TreeSource } from './sources';
import { apartmentGeometry, broadleafGeometry, coniferGeometry, houseGeometry, palmGeometry } from './archetypes';
import { TREE_BROADLEAF, TREE_CONIFER, TREE_PALM } from '../terrain/vegetation';
import { AIRBASE, airfieldOf } from '../terrain/features';
import { AIRFIELDS, airfieldRotation, runwaysOf } from '../../core/airfields';
import type { SimWorld } from '../../sim/api';

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
  /**
   * Auckland's aerial photo (the terrain's): the wharf decks and the naval base take it on their top
   * faces, and no houses or trees are scattered where it covers the ground (it shows the real ones).
   */
  aerial?: AerialPhotoInfo | null;
}

/** All features used for terrain flattening / baking / scenery (mission + Auckland's built-ins). */
export function allFeatures(_theater: TheaterId, mission: SceneryFeature[]): SceneryFeature[] {
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
  private readonly treeRadius: number;
  private readonly houseRadius: number;
  /** Auckland motorway network, plus the railways when the quality tier draws them (null elsewhere). */
  roads: RoadNetwork | null = null;
  /** Lots left unbuilt along the road and railway ribbons (Auckland); the terrain shader takes it too. */
  lotMask: LotMask | null = null;
  /** The Sky Tower (Auckland): its own meshes and lights, so it can fall. */
  skyTower: SkyTowerVisual | null = null;
  cbdStats: CbdStats | null = null;
  /** Bright lights near the water (for the harbour reflection streaks). */
  reflectionSources: ReflectionSource[] = [];
  stats = { meshes: 0, lights: 0 };

  constructor(o: SceneryOptions) {
    this.group.name = 'world-scenery';
    this.treeRadius = o.cfg.treeRadius;
    this.houseRadius = o.cfg.houseRadius;
    const hf = o.hf;
    const height = (x: number, z: number) => hf.meshHeightAt(x, z);
    const detail = o.quality.sceneryDensity;
    const buildingMat = createBuildingMaterial(o.atmo);
    this.lightsMat = createLightsMaterial(o.atmo);
    this.lightsMat.uniforms.uIntensity.value = o.lights;
    this.materials.push(buildingMat, this.lightsMat);
    // (the CBD's towers keep their own roofs: the photo is not a true orthophoto, a tall tower's roof is
    // drawn up to ~25 m off its footprint)
    const aerialMat = o.aerial ? createBuildingMaterial(o.atmo, { aerial: aerialUniforms(o.aerial, o.aerial.texture) }) : null;
    if (aerialMat) this.materials.push(aerialMat);
    const lights = new LightList();
    const addMesh = (b: GeometryBuilder, name: string, mat: ShaderMaterial = buildingMat) => {
      const g = b.build();
      if (!g) return;
      this.geometries.push(g);
      const m = new Mesh(g, mat);
      m.name = name;
      m.matrixAutoUpdate = false;
      this.group.add(m);
      this.stats.meshes++;
    };

    // ── Ground decals ──
    const concreteTex = createConcreteTexture();
    this.textures.push(concreteTex);
    const concrete = new DecalBuilder();
    const runways = new Map<string, { builder: DecalBuilder; length: number; width: number; names: [string, string] }>();
    const runwayDecal = (names: [string, string], length: number, width: number) => {
      const key = `${names[0]}/${names[1]}/${Math.round(length)}/${width}`;
      let rw = runways.get(key);
      if (!rw) runways.set(key, (rw = { builder: new DecalBuilder(), length, width, names }));
      return rw.builder;
    };

    // ── Features ──
    const features = allFeatures(o.theater, o.features);
    features.forEach((f, i) => {
      if (f.type === 'airbase') {
        const b = new GeometryBuilder();
        // Auckland's real airfields: their OpenStreetMap layout, else the template on the real runways
        const id = airfieldOf(f);
        const layout = id ? airfieldLayout(id) : null;
        if (id && layout) {
          buildRealAirfield(layout, runwaysOf(id), { buildings: b, runway: (rw) => runwayDecal(rw.names, rw.length, rw.width), concrete, lights }, height, detail);
        } else if (id) {
          const [main, ...others] = runwaysOf(id);
          // the feature's yaw runs a → b, or b → a when the apron is on the left of a → b
          const rot = airfieldRotation(id);
          const flip = Math.abs((((rot - (main.heading * 180) / Math.PI) % 360) + 360) % 360 - 180) < 90;
          const names: [string, string] = flip ? [main.names[1], main.names[0]] : main.names;
          const feature = { ...f, x: main.x, z: main.z, rotation: rot };
          buildAirbase({ feature, style: AIRFIELDS[id].style, runwayLength: main.length, runwayWidth: main.width }, { buildings: b, runway: runwayDecal(names, main.length, main.width), concrete, lights }, height, detail);
          // the other paved runways (Whenuapai's cross runway 08/26)
          for (const X of others) if (X.paved) buildExtraRunway(X, runwayDecal(X.names, X.length, X.width), lights, height);
        } else {
          const length = AIRBASE.runwayLength;
          buildAirbase({ feature: f, style: 'military', runwayLength: length }, { buildings: b, runway: runwayDecal(runwayDesignators(f.rotation ?? 0), length, AIRBASE.runwayWidth), concrete, lights }, height, detail);
        }
        addMesh(b, `airbase-${i}`);
      } else if (f.type !== 'forest' && f.type !== 'farmland') {
        const b = new GeometryBuilder();
        buildSettlement(f, o.theater, b, lights, height, detail);
        addMesh(b, `${f.type}-${i}`);
      }
    });

    // ── Auckland landmarks ──
    if (o.theater === 'auckland') {
      // the railways (clipped to the land model) join the network so houses, trees and towers keep off
      // the tracks too
      const rails = o.quality.railways ? clipRailToLand(aucklandRailPaths(), height) : [];
      const roads = new RoadNetwork([...aucklandRoadPaths(), ...rails]);
      this.roads = roads;
      // the suburbs' lots cleared along the ribbons (the houses here and the terrain's painted ones)
      const urban = urbanBounds(o.colorData, o.colorSize, hf.origin, hf.extent);
      this.lotMask = urban ? LotMask.fromSegments(roads.segments, urban) : null;
      const cbd = o.style.cbd ?? AKL_CBD_GRID;
      // the real buildings (LINZ outlines + LiDAR heights) need the real street map they stand along
      const buildings = cbd.streets ? aucklandBuildings() : null;
      const city = new GeometryBuilder();
      if (!buildings) buildSkyCityPodium(city, height);
      this.skyTower = new SkyTowerVisual(buildingMat, o.lights > 0.01 ? this.lightsMat : null, height);
      this.group.add(this.skyTower.group);
      this.stats.meshes++;
      this.cbdStats = buildCBD(city, lights, height, detail, cbd, roads, buildings);
      buildMuseumAndObelisk(city, lights, height);
      addMesh(city, 'akl-cbd');
      const centres = new GeometryBuilder();
      buildCentres(centres, lights, height, detail, cbd, roads, o.aerial ? aerialCovers : null);
      // motorway ribbons (+ bridge decks / piers into the centres mesh, lamp posts)
      const roadGeo = roads.buildRibbons(height, centres, lights, o.lights > 0.01, (p) => p.kind !== 'rail');
      // railway ribbons (+ bridges over the water): one more draw call
      const railGeo = rails.length ? roads.buildRibbons(height, centres, lights, false, (p) => p.kind === 'rail') : null;
      addMesh(centres, 'akl-centres');
      const roadTex = createMotorwayTexture();
      roadTex.anisotropy = o.cfg.anisotropy;
      this.textures.push(roadTex);
      const roadMat = createRoadMaterial(o.atmo, roadTex);
      this.materials.push(roadMat);
      this.geometries.push(roadGeo);
      const roadMesh = new Mesh(roadGeo, roadMat);
      roadMesh.name = 'akl-motorways';
      roadMesh.renderOrder = -4;
      roadMesh.matrixAutoUpdate = false;
      this.group.add(roadMesh);
      if (railGeo) {
        const railTex = createRailTexture();
        railTex.anisotropy = o.cfg.anisotropy;
        this.textures.push(railTex);
        const railMat = createRoadMaterial(o.atmo, railTex);
        this.materials.push(railMat);
        this.geometries.push(railGeo);
        const railMesh = new Mesh(railGeo, railMat);
        railMesh.name = 'akl-railways';
        railMesh.renderOrder = -4;
        railMesh.matrixAutoUpdate = false;
        this.group.add(railMesh);
      }
      const bridge = new GeometryBuilder();
      buildHarbourBridge(bridge, lights, height);
      addMesh(bridge, 'akl-harbour-bridge');
      const port = new GeometryBuilder();
      buildPort(port, lights, height, detail);
      buildMarinas(port, lights, height, detail);
      addMesh(port, 'akl-waterfront', aerialMat ?? buildingMat);
      // strategic sites: Devonport Naval Base, the Wiri oil terminal, Eden Park (aucklandSites.ts)
      const sites = new GeometryBuilder();
      const layout = siteLayout();
      if (layout) {
        buildNavalBase(sites, lights, height, layout);
        buildStadiums(sites, lights, height, layout);
      }
      buildWiriTerminal(sites, lights, height, layout);
      addMesh(sites, 'akl-sites', aerialMat ?? buildingMat);
    }

    // Decal meshes
    for (const rw of runways.values()) {
      const g = rw.builder.build();
      if (!g) continue;
      const hi = o.quality.level === 'high';
      const tex = createRunwayTexture(rw.length, rw.width, rw.names);
      // halve the canvas for mobile memory (and for the short general-aviation strips everywhere)
      if (!hi || rw.length < 1600) {
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

    // Night lights: fixtures (runways, towers, bridge, port, motorways) + the far-field city carpet
    if (o.lights > 0.01) {
      const pts = lights.build(this.lightsMat);
      if (pts) {
        this.geometries.push(pts.geometry);
        this.group.add(pts);
        this.stats.lights = lights.count;
      }
      const city = new LightList();
      const maxCity = o.quality.level === 'low' ? 14_000 : o.quality.level === 'medium' ? 30_000 : 48_000;
      // the real CBD buildings: lit windows on their facades instead of the carpet inside the CBD region
      const real = this.cbdStats?.prisms.length ? this.cbdStats.prisms : null;
      const region = real ? o.style.cbd?.streets ?? null : null;
      buildCityLightPoints({ data: o.colorData, size: o.colorSize, origin: hf.origin, extent: hf.extent }, height, o.seed, maxCity, city, region ? (x, z) => region.inRegion(x, z) : undefined);
      if (real) buildFacadeLightPoints(real, o.seed, o.quality.level === 'low' ? 3000 : o.quality.level === 'medium' ? 6000 : 10_000, city);
      const cityMat = createLightsMaterial(o.atmo);
      cityMat.uniforms.uIntensity.value = o.lights;
      cityMat.uniforms.uNearFade.value = 1600;
      cityMat.uniforms.uFar.value = 0.85;
      cityMat.uniforms.uPixelScale = this.lightsMat.uniforms.uPixelScale;
      cityMat.uniforms.uPixelRatio = this.lightsMat.uniforms.uPixelRatio;
      this.materials.push(cityMat);
      const cpts = city.build(cityMat);
      if (cpts) {
        cpts.name = 'world-city-lights';
        this.geometries.push(cpts.geometry);
        this.group.add(cpts);
        this.stats.lights += city.count;
      }
      // Harbour reflections: fixtures and city lights close to sea level, plus the lit CBD waterfront
      const refl: ReflectionSource[] = [];
      const tmpC = new Color();
      lights.forEach((x, y, z, r, g, b, size, blink) => {
        // steady white / sodium fixtures near sea level (waterfront, bridge, port, ships) and the
        // Sky Tower's pod; not the small red obstruction beacons
        if (blink >= 0 || (r > 0.5 && g < 0.25) || size < 2.4) return;
        const gh = height(x, z);
        if (gh > 7 && y - gh < 150) return;
        refl.push({ x, y, z, color: tmpC.setRGB(r, g, b).getHex(), intensity: Math.min(1.3, 0.22 * size) });
      });
      let every = 0;
      city.forEach((x, y, z, r, g, b) => {
        // (the lit windows of the real waterfront buildings: their ground is near sea level)
        if (height(x, z) > 5 || every++ % 3 !== 0) return;
        refl.push({ x, y, z, color: tmpC.setRGB(r, g, b).getHex(), intensity: 0.7 });
      });
      if (!real) {
        // stand-in lit CBD waterfront (procedural CBD)
        for (let x = -560; x <= 960; x += 40) {
          const z = -660 + ((x * 7) % 50);
          if (height(x, z) < 1) continue;
          refl.push({ x, y: 18 + ((x * 13) % 40 + 40) % 40, z, color: 0xffe2b8, intensity: 0.9 });
        }
      }
      refl.sort((a, b) => b.intensity - a.intensity);
      this.reflectionSources = refl.slice(0, o.quality.level === 'low' ? 250 : 700);
    }

    // ── Instanced scatters ──
    const cmap = new ColorMapSampler(o.colorData, o.colorSize, hf.origin, hf.extent);
    const veg = createVegetation(o.theater, o.seed, features);
    const foliage = createFoliageMaterial(o.atmo);
    this.materials.push(foliage);
    const treeCap = Math.max(300, o.cfg.treeMax);
    const treeGeoms = [palmGeometry(), broadleafGeometry(), coniferGeometry()];
    this.geometries.push(...treeGeoms);
    const roadsRef = this.roads;
    // nothing grows or is built on the roads or inside the port, the naval base, the oil terminal or a stadium
    // (nor under the aerial photo, which shows the real houses and trees)
    const sites = siteBlocker();
    const onSite = o.aerial ? (x: number, z: number, m: number) => aerialCovers(x, z) || (sites?.(x, z, m) ?? false) : sites;
    const offRoad =
      roadsRef || onSite ? (x: number, z: number, m: number) => (roadsRef?.near(x, z, m) ?? false) || (onSite?.(x, z, m) ?? false) : null;
    this.trees = new TileScatter(
      new TreeSource(hf, cmap, veg, o.theater, o.seed, 14, offRoad, o.style.cbd),
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

    const houseGeoms = [houseGeometry(), apartmentGeometry()];
    this.geometries.push(...houseGeoms);
    const houseMat = createBuildingMaterial(o.atmo, { houses: true });
    this.materials.push(houseMat);
    const roofFn = roofColorFn(o.style.roofs);
    const hc = o.cfg.houseMax;
    this.houses = new TileScatter(
      new HouseSource(hf, cmap, height, o.style.cbd, offRoad, this.lotMask),
      [
        { geometry: houseGeoms[0], material: houseMat, capacity: hc, kind: HOUSE, color: roofFn },
        { geometry: houseGeoms[1], material: houseMat, capacity: Math.round(hc / 5), kind: APARTMENT, color: roofFn },
      ],
      300,
      o.cfg.houseRadius,
      3,
    );
    for (const m of this.houses.meshes) this.group.add(m);
  }

  /**
   * Stream scatter tiles. Instances thin out with the slant range from the camera (so they fade
   * gradually as the jet climbs instead of vanishing at a fixed height); the scatters stop drawing
   * once the camera is higher than their radius.
   */
  update(camPos: Vector3, agl: number): void {
    if (this.trees) {
      this.trees.visible = agl < this.treeRadius;
      if (this.trees.visible) this.trees.update(camPos, agl);
    }
    if (this.houses) {
      this.houses.visible = agl < this.houseRadius;
      if (this.houses.visible) this.houses.update(camPos, agl);
    }
  }

  preRender(camera: Camera, pixelRatio: number, viewportHeight: number): void {
    const cam = camera as PerspectiveCamera;
    const fov = cam.isPerspectiveCamera ? (cam.fov * Math.PI) / 180 : 1;
    this.lightsMat.uniforms.uPixelScale.value = viewportHeight / (2 * Math.tan(fov / 2));
    this.lightsMat.uniforms.uPixelRatio.value = pixelRatio;
  }

  /** Follow the sim's landmarks (the Sky Tower's collapse). */
  updateLandmarks(world: SimWorld | null | undefined): void {
    this.skyTower?.update(world);
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
    this.skyTower?.dispose();
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
    for (const t of this.textures) t.dispose();
  }
}
