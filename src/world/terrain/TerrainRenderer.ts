/**
 * CDLOD terrain renderer (Strugar 2010) in ONE draw call:
 *  - a quadtree of nodes is selected every frame against distance ranges (doubling per LOD) and
 *    the camera frustum; each selected node area is emitted as instanced n×n-quad patches
 *  - the vertex shader fetches heights from an R32F mip pyramid (level = LOD) and geomorphs odd
 *    vertices towards the next coarser grid near the end of each LOD range → no cracks, no popping
 *  - the finest LOD samples the full-resolution heightfield, so the visible mesh matches the
 *    TerrainQuery used by the sim.
 */
import {
  BufferAttribute,
  Color,
  DataTexture,
  DynamicDrawUsage,
  FloatType,
  Frustum,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Matrix4,
  Mesh,
  NearestFilter,
  NearestMipmapNearestFilter,
  RedFormat,
  ShaderMaterial,
  Vector2,
  Vector3,
  Vector4,
  Box3,
  ClampToEdgeWrapping,
  LinearFilter,
  RGBAFormat,
  UnsignedByteType,
  type Camera,
  type Texture,
} from 'three';
import type { Heightfield } from './Heightfield';
import type { AtmosphereUniforms } from '../sky/atmosphere';
import { MAX_CONES, MAX_TERRAIN_LODS, terrainFragmentShader, terrainVertexShader } from './terrainShader';
import { BARE_MIX, LEAFY_MIX, suburbFarAlbedo } from './urbanColor';
import type { CbdGrid } from '../scenery/urbanGrid';
import type { CbdStreets } from '../scenery/cbdStreets';
import type { LotMask } from '../scenery/lotMask';

export interface TerrainStyle {
  rockColor: Color;
  snowColor: Color;
  snowLine: number;
  rockSlope: number;
  outsideColor: Color;
  /** Procedural paddock pattern strength. */
  fields: number;
  /** Roof palette (six colours) and garden / tree-canopy colours for the urban pattern. */
  roofs: Color[];
  garden: Color;
  canopy: Color;
  /** Shore band colours (beach sand, black sand west of blackSandX, rocky shore). */
  sand: Color;
  blackSand: Color;
  shoreRock: Color;
  blackSandX: number;
  /** Vineyard region (ellipse centre x, z, radii x, z in m) or null. */
  vineyard: [number, number, number, number] | null;
  /** Sink low coastal land under the water plane (terrain with a coast mask / linear shores). */
  sink: boolean;
  /** CBD streets (see urbanGrid.ts CbdGrid: the LINZ street map, else a fixed grid) or null. */
  cbd: CbdGrid | null;
  /** Volcanic cones (≤ MAX_CONES): crater bowls shaded below heightfield resolution, flank terraces. */
  cones?: ConeShading[];
}

/** One volcanic cone for the terrain shader (m): crater radius / depth (0 = no crater), cone radius / height. */
export interface ConeShading {
  x: number;
  z: number;
  craterR: number;
  craterDepth: number;
  coneR: number;
  coneH: number;
  /** Pā earthwork terraces on the flanks. */
  terraces: boolean;
}

export { MAX_CONES };

/** Coast mask (R8 signed distance) covering a square centred on (cx, cz). */
export interface CoastMaskInfo {
  texture: Texture;
  x0: number;
  z0: number;
  size: number;
}

export interface TerrainRendererOptions {
  hf: Heightfield;
  surface: Texture;
  color: Texture;
  colorSize: number;
  detail: Texture;
  detailNormal: Texture;
  atmo: AtmosphereUniforms;
  style: TerrainStyle;
  /** Quads per patch side (even). */
  patchQuads: number;
  drawDistance: number;
  /** Range multiplier (≥ 2.2 keeps morphing crack-free). */
  lodRange?: number;
  /** Optional high-resolution coast mask (shared with the water). */
  coast: CoastMaskInfo | null;
  /** 1×1 fallback texture when there is no coast mask. */
  dummy: Texture;
  /** Airfield rectangles (≤ 6) where the paddock pattern is suppressed. */
  noFields?: { x: number; z: number; heading: number; halfW: number; halfL: number }[];
  /** The water's shallow colour (terrain seaward of the coast mask is painted as water). */
  seaShallow?: Color;
  /** Aerial photo over a square (Auckland CBD / waterfront, aucklandAerial.ts), or none. */
  aerial?: AerialPhotoInfo | null;
}

/** An aerial photo texture over the square [x0, x0 + size] × [z0, z0 + size] (row 0 at z0), fading out over `feather` m. */
export interface AerialPhotoInfo {
  texture: Texture;
  x0: number;
  z0: number;
  size: number;
  feather: number;
}

const MORPH_START = 0.68;

export class TerrainRenderer {
  readonly mesh: Mesh;
  readonly heightTexture: DataTexture;
  /** CBD street map texture (null without LINZ road data). */
  readonly streetTexture: DataTexture | null;
  private lotMaskTexture: DataTexture | null = null;
  private readonly geometry: InstancedBufferGeometry;
  private readonly material: ShaderMaterial;
  private readonly patchAttr: InstancedBufferAttribute;
  private readonly patchData: Float32Array;
  private readonly maxPatches: number;
  private count = 0;

  private readonly hf: Heightfield;
  private readonly nq: number;
  private readonly leaf: number; // leaf node size (m)
  private readonly ranges: number[] = [];
  private readonly maxLod: number;
  /** Node min/max height pyramids indexed by level (leaf = level 0). */
  private readonly minP: Float32Array[] = [];
  private readonly maxP: Float32Array[] = [];
  private readonly dimsP: number[] = [];
  private readonly outsideMin: number;
  private readonly outsideMax: number;

  private readonly frustum = new Frustum();
  private readonly projView = new Matrix4();
  private readonly box = new Box3();
  private readonly cam = new Vector3();
  /** Stats for the dev overlay. */
  lastPatchCount = 0;

  constructor(o: TerrainRendererOptions) {
    this.hf = o.hf;
    this.nq = o.patchQuads;
    const hf = o.hf;
    this.leaf = 2 * this.nq * hf.cell;
    const k = o.lodRange ?? 2.6;
    // Mip pyramid for vertex fetch; LOD l samples mip l, morphs to l+1.
    const mips = buildHeightMips(hf);
    const maxMip = mips.length - 1;
    // Levels: until the range covers the draw distance (and mips remain for lod+1).
    let lod = 0;
    for (;;) {
      this.ranges.push(k * this.leaf * Math.pow(2, lod));
      if (this.ranges[lod] >= o.drawDistance * 1.05 || lod + 2 > maxMip || lod + 1 >= MAX_TERRAIN_LODS) break;
      lod++;
    }
    this.maxLod = lod;

    this.heightTexture = new DataTexture(mips[0].data, hf.n, hf.n, RedFormat, FloatType);
    this.heightTexture.mipmaps = mips as unknown as DataTexture['mipmaps'];
    this.heightTexture.magFilter = NearestFilter;
    this.heightTexture.minFilter = NearestMipmapNearestFilter;
    this.heightTexture.generateMipmaps = false;
    this.heightTexture.needsUpdate = true;

    // Node bound pyramids (per leaf node, then doubling).
    const cellsPerLeaf = 2 * this.nq;
    let dim = Math.ceil((hf.n - 1) / cellsPerLeaf);
    const mn0 = new Float32Array(dim * dim);
    const mx0 = new Float32Array(dim * dim);
    for (let j = 0; j < dim; j++) {
      for (let i = 0; i < dim; i++) {
        let mn = Infinity;
        let mx = -Infinity;
        const i1 = Math.min(hf.n - 1, (i + 1) * cellsPerLeaf);
        const j1 = Math.min(hf.n - 1, (j + 1) * cellsPerLeaf);
        for (let y = j * cellsPerLeaf; y <= j1; y++) {
          for (let x = i * cellsPerLeaf; x <= i1; x++) {
            const h = hf.data[y * hf.n + x];
            if (h < mn) mn = h;
            if (h > mx) mx = h;
          }
        }
        mn0[j * dim + i] = mn;
        mx0[j * dim + i] = mx;
      }
    }
    this.minP.push(mn0);
    this.maxP.push(mx0);
    this.dimsP.push(dim);
    for (let l = 1; l <= this.maxLod; l++) {
      const nd = Math.ceil(dim / 2);
      const pmn = this.minP[l - 1];
      const pmx = this.maxP[l - 1];
      const mn = new Float32Array(nd * nd);
      const mx = new Float32Array(nd * nd);
      for (let j = 0; j < nd; j++)
        for (let i = 0; i < nd; i++) {
          let a = Infinity;
          let b = -Infinity;
          for (let dj = 0; dj < 2; dj++)
            for (let di = 0; di < 2; di++) {
              const x = i * 2 + di;
              const y = j * 2 + dj;
              if (x >= dim || y >= dim) continue;
              a = Math.min(a, pmn[y * dim + x]);
              b = Math.max(b, pmx[y * dim + x]);
            }
          mn[j * nd + i] = a;
          mx[j * nd + i] = b;
        }
      this.minP.push(mn);
      this.maxP.push(mx);
      this.dimsP.push(nd);
      dim = nd;
    }
    let omn = Infinity;
    let omx = -Infinity;
    for (let i = 0; i < hf.n; i++) {
      for (const v of [hf.data[i], hf.data[(hf.n - 1) * hf.n + i], hf.data[i * hf.n], hf.data[i * hf.n + hf.n - 1]]) {
        omn = Math.min(omn, v);
        omx = Math.max(omx, v);
      }
    }
    this.outsideMin = omn;
    this.outsideMax = omx;

    // Patch geometry: (nq+1)² integer grid, diagonal (i+1,j)→(i,j+1) like Heightfield.meshHeightAt.
    const nq = this.nq;
    const verts = new Float32Array((nq + 1) * (nq + 1) * 3);
    for (let j = 0; j <= nq; j++)
      for (let i = 0; i <= nq; i++) {
        const o = (j * (nq + 1) + i) * 3;
        verts[o] = i;
        verts[o + 1] = 0;
        verts[o + 2] = j;
      }
    const idx = new Uint16Array(nq * nq * 6);
    let p = 0;
    for (let j = 0; j < nq; j++)
      for (let i = 0; i < nq; i++) {
        const a = j * (nq + 1) + i;
        const b = a + 1;
        const c = a + nq + 1;
        const d = c + 1;
        idx[p++] = a;
        idx[p++] = c;
        idx[p++] = b;
        idx[p++] = b;
        idx[p++] = c;
        idx[p++] = d;
      }
    this.geometry = new InstancedBufferGeometry();
    this.geometry.setAttribute('position', new BufferAttribute(verts, 3));
    this.geometry.setIndex(new BufferAttribute(idx, 1));
    this.maxPatches = 4096;
    this.patchData = new Float32Array(this.maxPatches * 4);
    this.patchAttr = new InstancedBufferAttribute(this.patchData, 4);
    this.patchAttr.setUsage(DynamicDrawUsage);
    this.geometry.setAttribute('aPatch', this.patchAttr);
    this.geometry.instanceCount = 0;

    const morph: Vector2[] = [];
    for (let l = 0; l < MAX_TERRAIN_LODS; l++) {
      const end = this.ranges[Math.min(l, this.maxLod)] * 0.985;
      const prev = l === 0 ? 0 : this.ranges[Math.min(l - 1, this.maxLod)];
      const start = l > this.maxLod ? 1e9 : prev + (end - prev) * MORPH_START;
      morph.push(new Vector2(start, 1 / Math.max(1, end - start)));
    }
    // The coarsest level never morphs (nothing coarser is drawn next to it).
    morph[this.maxLod].set(1e9, 0);

    this.streetTexture = o.style.cbd?.streets ? createStreetTexture(o.style.cbd.streets) : null;
    this.material = new ShaderMaterial({
      name: 'TerrainCDLOD',
      vertexShader: terrainVertexShader,
      fragmentShader: terrainFragmentShader,
      uniforms: {
        ...o.atmo,
        uHeight: { value: this.heightTexture },
        uHf: { value: new Vector4(hf.origin, hf.cell, hf.n, maxMip) },
        uMorph: { value: morph },
        uSurface: { value: o.surface },
        uColor: { value: o.color },
        uDetail: { value: o.detail },
        uDetailN: { value: o.detailNormal },
        uHalfTexel: { value: new Vector2(0.5 / hf.n, 0.5 / o.colorSize) },
        uRockColor: { value: o.style.rockColor },
        uSnowColor: { value: o.style.snowColor },
        uSnowLine: { value: o.style.snowLine },
        uRockSlope: { value: o.style.rockSlope },
        uOutside: { value: hf.extent / 2 },
        uOutsideColor: { value: o.style.outsideColor },
        uFields: { value: o.style.fields },
        uRoofs: { value: o.style.roofs },
        uGarden: { value: o.style.garden },
        uCanopy: { value: o.style.canopy },
        uSuburbLeafy: { value: suburbFarAlbedo(o.style, LEAFY_MIX) },
        uSuburbBare: { value: suburbFarAlbedo(o.style, BARE_MIX) },
        uSand: { value: o.style.sand },
        uBlackSand: { value: o.style.blackSand },
        uShoreRock: { value: o.style.shoreRock },
        uSeaShallow: { value: o.seaShallow ?? new Color(0x3f8a8c) },
        uBlackSandX: { value: o.style.blackSandX },
        uVineyard: { value: o.style.vineyard ? new Vector4(...o.style.vineyard) : new Vector4(0, 0, 0, 0) },
        uSink: { value: o.style.sink ? 1 : 0 },
        // the circle grid is the fallback for the real CBD streets
        uCbd: { value: o.style.cbd && !o.style.cbd.streets ? new Vector4(o.style.cbd.x, o.style.cbd.z, o.style.cbd.radius, o.style.cbd.hash) : new Vector4(0, 0, 0, 0) },
        ...streetUniforms(o.style.cbd?.streets ?? null, this.streetTexture, o.dummy),
        ...coastUniforms(o.coast, o.dummy),
        ...noFieldUniforms(o.noFields ?? []),
        ...coneUniforms(o.style.cones ?? []),
        ...aerialUniforms(o.aerial ?? null, o.dummy),
        // set by setLotMask() once the scenery has built the road network
        uLotMask: { value: o.dummy },
        uLotMaskRect: { value: new Vector4(0, 0, 1, 0) },
        uLotMaskRows: { value: 1 },
      },
    });
    this.mesh = new Mesh(this.geometry, this.material);
    this.mesh.name = 'terrain';
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.renderOrder = -10; // draw early: big occluder
  }

  /** Select LOD patches for this camera (call right before rendering). */
  update(camera: Camera): void {
    camera.getWorldPosition(this.cam);
    this.projView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projView);
    this.count = 0;
    const top = this.maxLod;
    const rootSize = this.leaf * Math.pow(2, top);
    const reach = this.ranges[top];
    const org = this.hf.origin;
    const i0 = Math.floor((this.cam.x - reach - org) / rootSize);
    const i1 = Math.floor((this.cam.x + reach - org) / rootSize);
    const j0 = Math.floor((this.cam.z - reach - org) / rootSize);
    const j1 = Math.floor((this.cam.z + reach - org) / rootSize);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) this.select(i, j, top);
    this.geometry.instanceCount = this.count;
    this.patchAttr.clearUpdateRanges();
    this.patchAttr.addUpdateRange(0, this.count * 4);
    this.patchAttr.needsUpdate = true;
    this.lastPatchCount = this.count;
  }

  /** Node (i, j) at `level` (indices relative to the heightfield origin, in node units). */
  private select(i: number, j: number, level: number): boolean {
    const size = this.leaf * Math.pow(2, level);
    const x0 = this.hf.origin + i * size;
    const z0 = this.hf.origin + j * size;
    this.nodeBounds(i, j, level, x0, z0, size);
    if (!this.boxInSphere(this.ranges[level])) return false;
    if (!this.frustum.intersectsBox(this.box)) return true;
    const ymin = this.box.min.y;
    const ymax = this.box.max.y;
    if (level === 0) {
      this.addNode(x0, z0, size, 0, 15, ymin, ymax);
      return true;
    }
    if (!this.boxInSphere(this.ranges[level - 1])) {
      this.addNode(x0, z0, size, level, 15, ymin, ymax);
      return true;
    }
    let mask = 0;
    for (let c = 0; c < 4; c++) {
      const ci = i * 2 + (c & 1);
      const cj = j * 2 + (c >> 1);
      // (select() clobbers this.box; ymin/ymax were saved above)
      if (!this.select(ci, cj, level - 1)) mask |= 1 << c;
    }
    if (mask) this.addNode(x0, z0, size, level, mask, ymin, ymax);
    return true;
  }

  /** Emit the node's quadrants (bitmask) as patches at `level`, frustum-tested individually. */
  private addNode(x0: number, z0: number, size: number, level: number, mask: number, ymin: number, ymax: number): void {
    const half = size / 2;
    this.box.min.y = ymin;
    this.box.max.y = ymax;
    for (let c = 0; c < 4; c++) {
      if (!(mask & (1 << c))) continue;
      if (this.count >= this.maxPatches) return;
      const px = x0 + (c & 1) * half;
      const pz = z0 + (c >> 1) * half;
      // quadrant bounds: reuse node min/max (conservative)
      this.box.min.x = px;
      this.box.max.x = px + half;
      this.box.min.z = pz;
      this.box.max.z = pz + half;
      if (!this.frustum.intersectsBox(this.box)) continue;
      const o = this.count * 4;
      this.patchData[o] = px;
      this.patchData[o + 1] = pz;
      this.patchData[o + 2] = level;
      this.patchData[o + 3] = 0;
      this.count++;
    }
  }

  private nodeBounds(i: number, j: number, level: number, x0: number, z0: number, size: number): void {
    const dim = this.dimsP[level];
    let mn: number;
    let mx: number;
    if (i >= 0 && j >= 0 && i < dim && j < dim) {
      mn = this.minP[level][j * dim + i];
      mx = this.maxP[level][j * dim + i];
      // partially outside the grid → include the clamped border range
      const ext = this.hf.origin + this.hf.extent;
      if (x0 + size > ext || z0 + size > ext) {
        mn = Math.min(mn, this.outsideMin);
        mx = Math.max(mx, this.outsideMax);
      }
    } else {
      mn = this.outsideMin;
      mx = this.outsideMax;
      // nodes straddling the grid border from outside
      const ci = Math.min(dim - 1, Math.max(0, i));
      const cj = Math.min(dim - 1, Math.max(0, j));
      if (Math.abs(ci - i) <= 1 && Math.abs(cj - j) <= 1) {
        mn = Math.min(mn, this.minP[level][cj * dim + ci]);
        mx = Math.max(mx, this.maxP[level][cj * dim + ci]);
      }
    }
    // Sea floor is pushed down in the shader; keep boxes generous below 0.
    if (mn < 0) mn -= 100;
    this.box.min.set(x0, mn, z0);
    this.box.max.set(x0 + size, mx + 1, z0 + size);
  }

  private boxInSphere(r: number): boolean {
    const b = this.box;
    const c = this.cam;
    const dx = c.x < b.min.x ? b.min.x - c.x : c.x > b.max.x ? c.x - b.max.x : 0;
    const dy = c.y < b.min.y ? b.min.y - c.y : c.y > b.max.y ? c.y - b.max.y : 0;
    const dz = c.z < b.min.z ? b.min.z - c.z : c.z > b.max.z ? c.z - b.max.z : 0;
    return dx * dx + dy * dy + dz * dz <= r * r;
  }

  /** Clear the lots along the road and railway ribbons (lotMask.ts, built with the scenery); null = none. */
  setLotMask(mask: LotMask | null): void {
    this.lotMaskTexture?.dispose();
    this.lotMaskTexture = null;
    const u = this.material.uniforms;
    if (!mask) {
      u.uLotMaskRect.value.set(0, 0, 1, 0);
      return;
    }
    const t = new DataTexture(mask.data, mask.texW, mask.texH, RGBAFormat, UnsignedByteType);
    t.wrapS = t.wrapT = ClampToEdgeWrapping;
    t.magFilter = NearestFilter;
    t.minFilter = NearestFilter;
    t.generateMipmaps = false;
    t.needsUpdate = true;
    this.lotMaskTexture = t;
    u.uLotMask.value = t;
    u.uLotMaskRect.value.set(mask.x0, mask.z0, mask.cell, mask.texW);
    u.uLotMaskRows.value = mask.texH;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.geometry.dispose();
    this.material.dispose();
    this.heightTexture.dispose();
    this.streetTexture?.dispose();
    this.lotMaskTexture?.dispose();
  }
}

function noFieldUniforms(list: { x: number; z: number; heading: number; halfW: number; halfL: number }[]): { uNoFieldA: { value: Vector4[] }; uNoFieldB: { value: Vector4[] } } {
  const a: Vector4[] = [];
  const b: Vector4[] = [];
  for (let i = 0; i < 6; i++) {
    const r = list[i];
    a.push(r ? new Vector4(r.x, r.z, Math.cos(r.heading), Math.sin(r.heading)) : new Vector4());
    b.push(r ? new Vector4(r.halfW, r.halfL, 250, 0) : new Vector4());
  }
  return { uNoFieldA: { value: a }, uNoFieldB: { value: b } };
}

/** Cone list → uConeA (x, z, crater radius, crater depth), uConeB (cone radius, height, terraces), uConeBox (xz bounds). */
export function coneUniforms(list: ConeShading[]): { uConeA: { value: Vector4[] }; uConeB: { value: Vector4[] }; uConeBox: { value: Vector4 } } {
  const a: Vector4[] = [];
  const b: Vector4[] = [];
  const box = new Vector4(1e9, 1e9, -1e9, -1e9);
  for (let i = 0; i < MAX_CONES; i++) {
    const c = list[i];
    a.push(c ? new Vector4(c.x, c.z, c.craterR, c.craterDepth) : new Vector4());
    b.push(c ? new Vector4(c.coneR, c.coneH, c.terraces ? 1 : 0, 0) : new Vector4());
    if (c) box.set(Math.min(box.x, c.x - c.coneR), Math.min(box.y, c.z - c.coneR), Math.max(box.z, c.x + c.coneR), Math.max(box.w, c.z + c.coneR));
  }
  if (!list.length) box.set(0, 0, -1, -1); // empty: nothing inside
  return { uConeA: { value: a }, uConeB: { value: b }, uConeBox: { value: box } };
}

/** RGBA8 texture of the CBD street map (LINEAR, CLAMP_TO_EDGE: what CbdStreets' samplers replicate). */
export function createStreetTexture(st: CbdStreets): DataTexture {
  const t = new DataTexture(st.data, st.cols, st.rows, RGBAFormat, UnsignedByteType);
  t.wrapS = t.wrapT = ClampToEdgeWrapping;
  t.magFilter = LinearFilter;
  t.minFilter = LinearFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}

/** Uniforms of the terrain shader's streetMap(). */
export function streetUniforms(st: CbdStreets | null, tex: Texture | null, dummy: Texture): { uStreets: { value: Texture }; uStreetRect: { value: Vector4 } } {
  return {
    uStreets: { value: st && tex ? tex : dummy },
    uStreetRect: { value: st && tex ? new Vector4(st.x0, st.z0, 1 / (st.cols * st.cell), 1 / (st.rows * st.cell)) : new Vector4(0, 0, 0, 0) },
  };
}

/** Uniforms of the terrain shader's aerialPhoto() (and the photo-capable building material). */
export function aerialUniforms(a: AerialPhotoInfo | null, dummy: Texture): { uAerial: { value: Texture }; uAerialRect: { value: Vector4 } } {
  return {
    uAerial: { value: a ? a.texture : dummy },
    uAerialRect: { value: a ? new Vector4(a.x0, a.z0, 1 / a.size, a.feather) : new Vector4(0, 0, 0, 0) },
  };
}

/** Uniforms of COAST_GLSL (shared by terrain and water). */
export function coastUniforms(coast: CoastMaskInfo | null, dummy: Texture): { uCoastMask: { value: Texture }; uCoastRect: { value: Vector4 } } {
  return {
    uCoastMask: { value: coast ? coast.texture : dummy },
    uCoastRect: { value: coast ? new Vector4(coast.x0, coast.z0, 1 / coast.size, 1) : new Vector4(0, 0, 1, 0) },
  };
}

/** R32F mip chain with a [1 2 1] tent filter, corner-aligned (mip l+1 sample j ≈ mip l sample 2j). */
export function buildHeightMips(hf: Heightfield): { data: Float32Array; width: number; height: number }[] {
  const out = [{ data: hf.data, width: hf.n, height: hf.n }];
  let src = hf.data;
  let n = hf.n;
  while (n > 1) {
    const m = n >> 1;
    const dst = new Float32Array(m * m);
    const w = [0.25, 0.5, 0.25];
    for (let j = 0; j < m; j++)
      for (let i = 0; i < m; i++) {
        let s = 0;
        for (let b = -1; b <= 1; b++) {
          const y = Math.min(n - 1, Math.max(0, j * 2 + b));
          for (let a = -1; a <= 1; a++) {
            const x = Math.min(n - 1, Math.max(0, i * 2 + a));
            s += src[y * n + x] * w[a + 1] * w[b + 1];
          }
        }
        dst[j * m + i] = s;
      }
    out.push({ data: dst, width: m, height: m });
    src = dst;
    n = m;
  }
  return out;
}
