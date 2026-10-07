/**
 * Scenery orchestrator: turns mission features (+ Auckland's own landmarks) into merged static
 * meshes (one draw call per feature), textured ground decals (runways, taxiways, aprons), a single
 * Points object for all night lights, and camera-local instanced scatters for trees and houses.
 */
import { Color, Group, Mesh, type BufferGeometry, type Object3D, type Camera, type PerspectiveCamera, type ShaderMaterial, type Texture, type Vector3 } from 'three';
import type { SceneryFeature } from '../../core/contracts';
import type { QualitySettings, TheaterId } from '../../core/types';
import type { AtmosphereUniforms } from '../sky/atmosphere';
import type { Heightfield } from '../terrain/Heightfield';
import type { WorldConfig } from '../config';
import { aerialOuterUniforms, aerialUniforms, type AerialPhotoInfo, type TerrainStyle } from '../terrain/TerrainRenderer';
import { aerialCovers } from '../terrain/theaters/aucklandAerial';
import { createVegetation } from '../terrain/vegetation';
import { GeometryBuilder } from './GeometryBuilder';
import { DecalBuilder, LightList } from './builders';
import { buildAirbase, buildExtraRunway, buildRealAirfield } from './airbase';
import { airfieldLayout } from './aucklandOsm';
import { buildNavalBase, buildStadiums, buildWiriTerminal, siteBlocker, siteLayout, siteRings } from './aucklandSites';
import { buildSettlement } from './settlements';
import { aucklandBuiltinFeatures, type CbdStats, buildCBD, buildCentres, inTownCentre, buildMarinas, buildObelisk, buildPort, buildSkyCityPodium, isDuplicateOfAuckland } from './auckland';
import { buildMuseum } from './museum';
import { buildDomainBuildings } from './domain';
import { aucklandDomain } from './aucklandDomain';
import { SkyTowerVisual } from './skyTower';
import { buildHarbourBridge } from './harbourBridge';
import { buildSparkArena, buildSparkArenaSignGeometry, createSparkArenaSignTexture, sparkArenaGround } from './sparkArena';
import { sparkArenaCovers } from '../../core/sparkArena';
import { buildWestfieldNewmarket, westfieldCovers } from './westfieldNewmarket';
import { CbdCollapseVisual, type HeroCollapseRange } from './cbdCollapse';
import { BridgeCollapseVisual } from './bridgeCollapse';
import { MUSEUM } from '../../core/museum';
import { MUSEUM_ID, SPARK_ARENA_ID } from '../../sim/buildings';
import { aucklandRailPaths, aucklandRoadPaths, clipRailToLand, RoadNetwork } from './motorways';
import { aucklandBuildings, type Building } from './aucklandBuildings';
import { aucklandLandmarks, buildMallLamps, buildPlatforms, LANDMARK_FAR, LANDMARK_TILE } from './aucklandLandmarks';
import { LotMask, maskFromRings, urbanBounds } from './lotMask';
import { FRONT_BAND, FrontageMap } from './frontage';
import { aucklandNeighbourhoods, neighbourhoodAt } from './aucklandNeighbourhoods';
import { aucklandHouses, houseCoverage, unionMasks } from './aucklandHouses';
import { buildCityLightPoints, buildFacadeLightPoints, type ReflectionSource } from './nightLights';
import { AKL_CBD_GRID } from '../config';
import { createBuildingMaterial, createDecalMaterial, createFoliageMaterial, createLightsMaterial, createLogoMaterial, createRoadMaterial, createSignMaterial } from './materials';
import { createTowerLogoTexture, towerSignGeometry } from './towerSkins';
import { createRunwayTexture, runwayDesignators } from '../textures/runway';
import { createConcreteTexture, createMotorwayTexture, createLocalRoadTexture, createRailTexture } from '../textures/procedural';
import { TileScatter } from './scatter';
import { APARTMENT, ColorMapSampler, HOUSE, HouseSource, roofColorFn, SHED, shedColorFn, TreeSource, type CanopyTrees, type MeasuredTrees } from './sources';
import type { Canopy } from '../terrain/theaters/aucklandCanopy';
import { buildTamakiDrive, tamakiCovers, tamakiGround, tamakiTrees } from './tamakiDrive';
import { tamakiDrive } from './tamakiDriveData';
import type { LandUse } from './aucklandLandUse';
import { buildHelipadDecks, buildHelipads, createHelipadTexture, roofLookup } from './helipads';
import { apartmentGeometry, broadleafGeometry, coniferGeometry, houseGeometry, palmGeometry, shedGeometry } from './archetypes';
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
  /** The real land use (#122, medium and high tiers): houses off open ground, sheds on commercial land. */
  landUse?: LandUse | null;
  /** The real tree canopy (#123, medium and high tiers): where it covers, the trees follow it, on the photo too. */
  canopy?: Canopy | null;
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
  /** Landmark sites (stadium grounds, the oil terminal) and the real houses' coverage, where the procedural street grid stops (terrain shader, houses). */
  siteMask: LotMask | null = null;
  /** Where the real houses stand (#121, aucklandHouses.ts houseCoverage); part of siteMask. */
  houseCover: LotMask | null = null;
  /** The lots lining the arterials, facing them (frontage.ts): the 3D houses here, the terrain paints them. */
  frontage: FrontageMap | null = null;
  /** The Sky Tower (Auckland): its own meshes and lights, so it can fall. */
  skyTower: SkyTowerVisual | null = null;
  /** Collapsed CBD skyscrapers flattened in the merged CBD mesh (#128); null for the procedural CBD. */
  cbdCollapse: CbdCollapseVisual | null = null;
  /** The Harbour Bridge's spans falling into the harbour (Auckland). */
  bridgeCollapse: BridgeCollapseVisual | null = null;
  cbdStats: CbdStats | null = null;
  /** The landmark meshes (#124), one per LANDMARK_TILE square: hidden beyond LANDMARK_FAR of the camera. */
  private readonly landmarkTiles: { mesh: Object3D; x0: number; z0: number }[] = [];
  /** The Tāmaki Drive waterfront's measured trees (tamakiDrive.ts), grown by the tree scatter. */
  private tamakiTrees: MeasuredTrees | null = null;
  /** Bright lights near the water (for the harbour reflection streaks). */
  reflectionSources: ReflectionSource[] = [];
  stats = { meshes: 0, lights: 0 };

  constructor(o: SceneryOptions) {
    this.group.name = 'world-scenery';
    this.treeRadius = o.cfg.treeRadius;
    this.houseRadius = o.cfg.houseRadius;
    const hf = o.hf;
    // the outer photo's alpha (#120: Devonport, the gulf islands) for aerialCovers; null: the square alone
    const aerialCover = o.aerial?.outer?.cover ?? null;
    const height = (x: number, z: number) => hf.meshHeightAt(x, z);
    const detail = o.quality.sceneryDensity;
    const buildingMat = createBuildingMaterial(o.atmo);
    this.lightsMat = createLightsMaterial(o.atmo);
    this.lightsMat.uniforms.uIntensity.value = o.lights;
    this.materials.push(buildingMat, this.lightsMat);
    const aerialMat = o.aerial ? createBuildingMaterial(o.atmo, { aerial: aerialUniforms(o.aerial, o.aerial.texture) }) : null;
    if (aerialMat) this.materials.push(aerialMat);
    // the CBD mesh: the photo is not a true orthophoto (a roof is drawn displaced from its footprint by its height ×
    // the camera's lean), so only the LINZ buildings' roofs take it, each at its registered offset (#140,
    // aucklandBuildings.ts roofPhotoOffset); the tower kit and the other heroes keep their own roofs
    // (and its buildings' facades: storeys, window rhythm, glass, contact shading, #141; on every tier)
    const cbdMat = o.aerial
      ? createBuildingMaterial(o.atmo, { aerial: aerialUniforms(o.aerial, o.aerial.texture), roofs: true, facades: true })
      : createBuildingMaterial(o.atmo, { facades: true });
    this.materials.push(cbdMat);
    const lights = new LightList();
    const addMesh = (b: GeometryBuilder, name: string, mat: ShaderMaterial = buildingMat) => {
      const g = b.build();
      if (!g) return null;
      this.geometries.push(g);
      const m = new Mesh(g, mat);
      m.name = name;
      m.matrixAutoUpdate = false;
      this.group.add(m);
      this.stats.meshes++;
      return g;
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
      // no painted streets or houses through a stadium (its stands are 3D): its site plus a street's width
      this.siteMask = maskFromRings(siteRings(), 8);
      // nor round the real houses of Devonport and the gulf islands (#121: aucklandHouses.ts, drawn by the house
      // scatter): the procedural lots, houses, frontage lots and centres' blocks step aside where they stand
      const real = aucklandHouses();
      this.houseCover = real ? houseCoverage(real) : null;
      this.siteMask = unionMasks(this.siteMask, this.houseCover);
      // the arterials' frontage: a row of lots facing the road along both sides (frontage.ts)
      const site = this.siteMask;
      const region = o.style.cbd?.streets ?? null;
      const urbanAt = new ColorMapSampler(o.colorData, o.colorSize, hf.origin, hf.extent);
      const urban = urbanBounds(o.colorData, o.colorSize, hf.origin, hf.extent);
      this.frontage = new FrontageMap(roads.paths, {
        ribbonEdge: (x, z) => roads.edgeDistance(x, z),
        urban: (x, z) => urbanAt.urban(x, z),
        ground: height,
        excluded: (x, z) => (site?.masked(x, z) ?? false) || (region !== null && region.regionSD(x, z) > -4),
        centre: inTownCentre,
        cbd: o.style.cbd,
      }, urban);
      // the suburbs' grid lots cleared along the ribbons (the houses here and the terrain's painted ones); along an
      // arterial from the back of its frontage band
      this.lotMask = urban ? LotMask.fromSegments(roads.segmentsWith((p) => (p.kind === 'arterial' ? FRONT_BAND : 0)), urban) : null;
      const cbd = o.style.cbd ?? AKL_CBD_GRID;
      // the real buildings (LINZ outlines + LiDAR heights) need the real street map they stand along
      const buildings = cbd.streets ? aucklandBuildings() : null;
      const city = new GeometryBuilder();
      if (o.aerial) city.enablePhotoRoofs();
      city.enableFacades();
      if (!buildings) buildSkyCityPodium(city, height);
      this.skyTower = new SkyTowerVisual(buildingMat, o.lights > 0.01 ? this.lightsMat : null, height);
      this.group.add(this.skyTower.group);
      this.stats.meshes++;
      // a hero neighbourhood outside the real-streets region (Mission Bay, the flight corridor's suburbs) gets its own
      // mesh, so it is frustum-culled instead of widening the CBD mesh's bounds across the city
      const apart = new Map<string, GeometryBuilder>();
      for (const n of buildings && cbd.streets ? aucklandNeighbourhoods() ?? [] : [])
        if (!cbd.streets!.inRegion(n.footprint[0], n.footprint[1])) apart.set(n.name, new GeometryBuilder());
      // the landmark sites' buildings (#124: hospitals, stations, malls, schools; aucklandLandmarks.ts) and the platforms
      // along the railway ribbons: one mesh per LANDMARK_TILE square, frustum-culled, with the CBD's facades (no photo roofs)
      const tiles = new Map<string, GeometryBuilder>();
      const tileOf = (x: number, z: number) => {
        const k = `${Math.floor(x / LANDMARK_TILE)}_${Math.floor(z / LANDMARK_TILE)}`;
        let t = tiles.get(k);
        if (!t) {
          tiles.set(k, (t = new GeometryBuilder()));
          t.enableFacades();
        }
        return t;
      };
      const houseBuilder = (b: Building) => (b.area !== undefined ? apart.get(b.area) ?? null : b.landmark ? tileOf(b.prisms[0].cx, b.prisms[0].cz) : null);
      this.cbdStats = buildCBD(city, lights, height, detail, cbd, roads, buildings, houseBuilder);
      for (const [name, b] of apart) addMesh(b, `akl-nb-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`);
      const landmarks = buildings ? aucklandLandmarks() : null;
      if (landmarks) {
        if (rails.length) buildPlatforms(landmarks, height, tileOf);
        if (o.lights > 0.01) buildMallLamps(landmarks, lights, height, roads);
        const lmMat = createBuildingMaterial(o.atmo, { facades: true });
        this.materials.push(lmMat);
        for (const [k, b] of tiles) {
          const g = addMesh(b, `akl-landmarks-${k}`, lmMat);
          const [i, j] = k.split('_').map(Number);
          const mesh = this.group.children[this.group.children.length - 1];
          if (g) this.landmarkTiles.push({ mesh, x0: i * LANDMARK_TILE, z0: j * LANDMARK_TILE });
        }
      }
      // the hero landmarks in the CBD mesh collapse when the player's jet flies into one (sim/buildings.ts):
      // their vertex and night-light ranges
      const heroes: HeroCollapseRange[] = [];
      const hero = (id: number, ground: number, build: () => void) => {
        const v0 = city.vertexCount;
        const l0 = lights.count;
        build();
        heroes.push({ id, v0, v1: city.vertexCount, ground, l0, l1: lights.count });
        return heroes[heroes.length - 1];
      };
      hero(MUSEUM_ID, height(MUSEUM.x, MUSEUM.z) - 1.5, () => buildMuseum(city, lights, height));
      // the Auckland Domain round it (aucklandDomain.ts): its measured park buildings and glasshouses (its trees: TreeSource)
      const domain = aucklandDomain();
      if (domain) buildDomainBuildings(city, domain, height);
      buildObelisk(city, lights, height);
      // Westfield Newmarket, measured from the LiDAR and OSM (westfieldNewmarket.ts), in the same mesh
      buildWestfieldNewmarket(city, lights, height);
      // Spark Arena (hand-built from the LiDAR, sparkArena.ts) rides in the CBD mesh; its three signs are one small mesh
      const arena = hero(SPARK_ARENA_ID, sparkArenaGround(height), () => buildSparkArena(city, lights, height, detail));
      const cityGeo = addMesh(city, 'akl-cbd', cbdMat);
      {
        const tex = createSparkArenaSignTexture(o.cfg.anisotropy);
        this.textures.push(tex);
        const mat = createSignMaterial(o.atmo, tex, new Color(0xf4f1ea), new Color(0xa65cff));
        this.materials.push(mat);
        const geo = buildSparkArenaSignGeometry(height);
        this.geometries.push(geo);
        const sign = new Mesh(geo, mat);
        sign.name = 'akl-spark-arena-sign';
        sign.matrixAutoUpdate = false;
        this.group.add(sign);
        arena.objects = [sign];
        this.stats.meshes++;
      }
      const cs = this.cbdStats;
      // the skinned CBD towers' crown signs (towerSkins.ts): one small mesh with the logo atlas
      let signs: { geo: BufferGeometry; ranges: readonly [number, number, number][] } | undefined;
      const signGeo = cs.towerSigns ? towerSignGeometry(cs.towerSigns) : null;
      if (signGeo && cs.towerSigns) {
        const tex = createTowerLogoTexture(o.cfg.anisotropy);
        this.textures.push(tex);
        const mat = createLogoMaterial(o.atmo, tex);
        this.materials.push(mat);
        this.geometries.push(signGeo);
        const mesh = new Mesh(signGeo, mat);
        mesh.name = 'akl-tower-signs';
        mesh.matrixAutoUpdate = false;
        this.group.add(mesh);
        this.stats.meshes++;
        signs = { geo: signGeo, ranges: cs.towerSigns.ranges };
      }
      if (cityGeo) this.cbdCollapse = new CbdCollapseVisual(cityGeo, cs.buildingVerts ?? new Int32Array(0), cs.buildingGround ?? new Float32Array(0), heroes, null, signs);
      const centres = new GeometryBuilder();
      // (not on the aerial photo, which shows the real buildings, nor on Spark Arena)
      // (nor on an arterial's frontage, whose shops and houses are the lots')
      const front = this.frontage;
      // (nor where the real houses stand)
      const cover = this.houseCover;
      const realCovers = (x: number, z: number) => cover?.masked(x, z) ?? false;
      // (nor on a landmark site, #124: its real buildings stand there)
      const onSite = (x: number, z: number) => site?.masked(x, z) ?? false;
      buildCentres(centres, lights, height, detail, cbd, roads, o.aerial ? (x, z) => aerialCovers(x, z, aerialCover) || sparkArenaCovers(x, z, 20) || westfieldCovers(x, z, 20) || front.inBand(x, z) || realCovers(x, z) || onSite(x, z) : (x, z) => sparkArenaCovers(x, z, 20) || westfieldCovers(x, z, 20) || front.inBand(x, z) || realCovers(x, z) || onSite(x, z));
      // the Tāmaki Drive waterfront (tamakiDrive.ts: paths, seawall, railings, lamps) in the centres mesh; its trees
      // join the tree scatter below. The road ribbon stands on its raised ground (the Hobson Bay causeway is sea in the
      // terrain) and leaves the lamps to the measured ones there
      const td = tamakiDrive();
      const tdGround = td ? tamakiGround(td, height) : undefined;
      const tdCovers = td ? tamakiCovers(td) : undefined;
      if (td && tdGround) {
        buildTamakiDrive(centres, lights, td, tdGround, height, detail);
        this.tamakiTrees = { trees: tamakiTrees(td, tdGround), covers: tdCovers! };
      }
      // motorway ribbons (+ bridge decks / piers into the centres mesh, lamp posts)
      const roadGeo = roads.buildRibbons(height, centres, lights, o.lights > 0.01, (p) => p.kind !== 'rail' && p.kind !== 'local', { ground: tdGround, noLamp: tdCovers });
      // the local roads of the islands and Devonport (#127): unlit, their own texture (sealed / gravel), one draw call
      const localGeo = roads.paths.some((p) => p.kind === 'local') ? roads.buildRibbons(height, centres, lights, false, (p) => p.kind === 'local') : null;
      // railway ribbons (+ bridges over the water): one more draw call
      const railGeo = rails.length ? roads.buildRibbons(height, centres, lights, false, (p) => p.kind === 'rail') : null;
      addMesh(centres, 'akl-centres');
      const roadTex = createMotorwayTexture();
      roadTex.anisotropy = o.cfg.anisotropy;
      this.textures.push(roadTex);
      // the roads glow with their street lights at night (when the tier draws night lights at all)
      const roadMat = createRoadMaterial(o.atmo, roadTex, o.lights > 0.01);
      this.materials.push(roadMat);
      this.geometries.push(roadGeo);
      const roadMesh = new Mesh(roadGeo, roadMat);
      roadMesh.name = 'akl-motorways';
      roadMesh.renderOrder = -4;
      roadMesh.matrixAutoUpdate = false;
      this.group.add(roadMesh);
      if (localGeo) {
        const localTex = createLocalRoadTexture();
        localTex.anisotropy = o.cfg.anisotropy;
        this.textures.push(localTex);
        const localMat = createRoadMaterial(o.atmo, localTex);
        this.materials.push(localMat);
        this.geometries.push(localGeo);
        const localMesh = new Mesh(localGeo, localMat);
        localMesh.name = 'akl-local-roads';
        localMesh.renderOrder = -4;
        localMesh.matrixAutoUpdate = false;
        this.group.add(localMesh);
      }
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
      const bridgeLights = lights.count;
      buildHarbourBridge(bridge, lights, height, detail);
      const bridgeGeo = addMesh(bridge, 'akl-harbour-bridge');
      if (bridgeGeo) this.bridgeCollapse = new BridgeCollapseVisual(bridgeGeo, null, [bridgeLights, lights.count]);
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
      buildWiriTerminal(sites, lights, height, layout, concrete);
      // the rooftop helipads on buildings the game does not model yet stand on a plain block (#125)
      buildHelipadDecks(sites, height, roofLookup(aucklandBuildings(), height));
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
    {
      // every helipad and heliport (#125, core/sites.ts HELIPADS): one decal draw call, green edge lights at night
      const pads = new DecalBuilder();
      buildHelipads(pads, lights, height, roofLookup(aucklandBuildings(), height));
      const g = pads.build();
      if (g) {
        const tex = createHelipadTexture();
        tex.anisotropy = o.cfg.anisotropy;
        this.textures.push(tex);
        const mat = createDecalMaterial(o.atmo, tex);
        this.materials.push(mat);
        this.geometries.push(g);
        const m = new Mesh(g, mat);
        m.name = 'helipads';
        m.renderOrder = -4;
        this.group.add(m);
      }
    }

    // Night lights: fixtures (runways, towers, bridge, port, motorways) + the far-field city carpet
    if (o.lights > 0.01) {
      const pts = lights.build(this.lightsMat);
      if (pts) {
        if (this.cbdCollapse) this.cbdCollapse.lights = pts.geometry;
        if (this.bridgeCollapse) this.bridgeCollapse.lights = pts.geometry;
        this.geometries.push(pts.geometry);
        this.group.add(pts);
        this.stats.lights = lights.count;
      }
      const city = new LightList();
      const maxCity = o.quality.level === 'low' ? 14_000 : o.quality.level === 'medium' ? 30_000 : 48_000;
      // the real CBD buildings: lit windows on their facades instead of the carpet inside the CBD region
      const real = this.cbdStats?.prisms.length ? this.cbdStats.prisms : null;
      const region = real ? o.style.cbd?.streets ?? null : null;
      // (none inside the CBD region or a hero neighbourhood, which have their facade lights, nor under Spark Arena's roof)
      const nbs = real ? aucklandNeighbourhoods() : null;
      buildCityLightPoints({ data: o.colorData, size: o.colorSize, origin: hf.origin, extent: hf.extent }, height, o.seed, maxCity, city, (x, z) => (region?.inRegion(x, z) ?? false) || sparkArenaCovers(x, z) || westfieldCovers(x, z) || neighbourhoodAt(x, z, nbs) !== null);
      if (real) {
        // the CBD's lit windows; a hospital's are lit all night (#124), a few of a station's, none of a school's or a mall's
        const tier = o.quality.level === 'low' ? 0.5 : o.quality.level === 'medium' ? 1 : 1.7;
        buildFacadeLightPoints(real.filter((p) => !p.landmark), o.seed, o.quality.level === 'low' ? 3000 : o.quality.level === 'medium' ? 6000 : 10_000, city);
        buildFacadeLightPoints(real.filter((p) => p.landmark === 'hospital'), o.seed + 1, Math.round(2500 * tier), city, 0.55);
        buildFacadeLightPoints(real.filter((p) => p.landmark === 'station' || p.landmark === 'other'), o.seed + 2, Math.round(600 * tier), city);
      }
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
    // the real canopy's trees (#123) take the photo's colour where it covers
    const foliage = createFoliageMaterial(o.atmo, o.aerial && o.canopy ? { ...aerialUniforms(o.aerial, o.aerial.texture), ...aerialOuterUniforms(o.aerial.outer ?? null, o.aerial.texture) } : undefined);
    this.materials.push(foliage);
    const treeCap = Math.max(300, o.cfg.treeMax);
    const treeGeoms = [palmGeometry(), broadleafGeometry(), coniferGeometry()];
    this.geometries.push(...treeGeoms);
    const roadsRef = this.roads;
    // nothing grows or is built on the roads or inside the port, the naval base, the oil terminal or a stadium
    // (nor under the aerial photo, which shows the real houses and trees)
    const sites = siteBlocker();
    // (the hero neighbourhoods grow their measured canopy under the photo too: TreeSource.nbTree)
    const nbs = aucklandNeighbourhoods();
    const onSite = o.aerial ? (x: number, z: number, m: number) => (aerialCovers(x, z, aerialCover) && !neighbourhoodAt(x, z, nbs)) || (sites?.(x, z, m) ?? false) : sites;
    const offRoad =
      roadsRef || onSite ? (x: number, z: number, m: number) => (roadsRef?.near(x, z, m) ?? false) || (onSite?.(x, z, m) ?? false) : null;
    // the road ribbons and the landmark sites, not the photo: the real houses (#121) and the real canopy (#123) stand on it
    const roadsOrSites = roadsRef || sites ? (x: number, z: number, m: number) => (roadsRef?.near(x, z, m) ?? false) || (sites?.(x, z, m) ?? false) : null;
    const realHouses = o.theater === 'auckland' ? aucklandHouses() : null;
    const canopy: CanopyTrees | null = o.canopy ? { grid: o.canopy, blocked: roadsOrSites, houses: realHouses, lotMask: joinMasks(this.lotMask, this.siteMask) } : null;
    this.trees = new TileScatter(
      new TreeSource(hf, cmap, veg, o.theater, o.seed, 14, offRoad, o.style.cbd, nbs, o.landUse ?? null, o.theater === 'auckland' ? aucklandDomain() : null, this.tamakiTrees, canopy),
      [
        { geometry: treeGeoms[TREE_PALM], material: foliage, capacity: Math.round(treeCap * 0.4), kind: TREE_PALM, aux: 'aPhoto' },
        { geometry: treeGeoms[TREE_BROADLEAF], material: foliage, capacity: o.canopy ? treeCap * CANOPY_BROADLEAF_CAP : treeCap, kind: TREE_BROADLEAF, aux: 'aPhoto' },
        { geometry: treeGeoms[TREE_CONIFER], material: foliage, capacity: treeCap, kind: TREE_CONIFER, aux: 'aPhoto' },
      ],
      400,
      o.cfg.treeRadius,
      2,
      true,
    );
    for (const m of this.trees.meshes) this.group.add(m);

    const houseGeoms = [houseGeometry(), apartmentGeometry(), ...(o.landUse ? [shedGeometry()] : [])];
    this.geometries.push(...houseGeoms);
    const houseMat = createBuildingMaterial(o.atmo, { houses: true });
    this.materials.push(houseMat);
    const roofFn = roofColorFn(o.style.roofs);
    const hc = o.cfg.houseMax;
    this.houses = new TileScatter(
      new HouseSource(
        hf, cmap, height, o.style.cbd, offRoad, joinMasks(this.lotMask, this.siteMask), this.frontage, o.landUse ?? null,
        // the real houses (#121) stand under the photo too: only the road ribbons and the landmark sites keep them off
        realHouses,
        roadsOrSites,
      ),
      [
        { geometry: houseGeoms[0], material: houseMat, capacity: hc, kind: HOUSE, color: roofFn, aux: 'aRise' },
        { geometry: houseGeoms[1], material: houseMat, capacity: Math.round(hc / 5), kind: APARTMENT, color: roofFn, aux: 'aRise' },
        ...(o.landUse ? [{ geometry: houseGeoms[2], material: houseMat, capacity: Math.round(hc / 6), kind: SHED, color: shedColorFn(), aux: 'aRise' }] : []),
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
    // the landmark tiles past LANDMARK_FAR (horizontally, to the square's nearest point) are a pixel or two: not drawn
    for (const t of this.landmarkTiles) {
      const dx = Math.max(t.x0 - camPos.x, 0, camPos.x - t.x0 - LANDMARK_TILE);
      const dz = Math.max(t.z0 - camPos.z, 0, camPos.z - t.z0 - LANDMARK_TILE);
      t.mesh.visible = dx * dx + dz * dz < LANDMARK_FAR * LANDMARK_FAR;
    }
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
    this.cbdCollapse?.update(world);
    this.bridgeCollapse?.update(world);
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

/**
 * With the real canopy (#123) the broadleaf mesh takes this × the tier's tree budget: a forest over a whole island (Rangitoto,
 * Waiheke's bush) is many times the budget, and its crowns are what the photo's forest reads as at 1–3 km (≈ 16 triangles a
 * crown).
 */
const CANOPY_BROADLEAF_CAP = 2;

/** Either mask (a lot cleared by a road corridor or a landmark site), as HouseSource asks it. */
function joinMasks(a: LotMask | null, b: LotMask | null): Pick<LotMask, 'masked'> | null {
  if (!a || !b) return a ?? b;
  return { masked: (x, z) => a.masked(x, z) || b.masked(x, z) };
}
