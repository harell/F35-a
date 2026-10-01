/**
 * ModelBuilder: collects canonical geometry pieces by material key, bakes the static airframe into
 * one mesh (material groups → one draw call per material) and wraps animated parts in hinge pivots.
 *
 * Pivot convention: every animated part rotates about its pivot's LOCAL X axis (mesh.rotation.x).
 *  - For trailing-edge surfaces the hinge axis points to the RIGHT (+X-ish) → positive = TE down.
 *  - For rudders the hinge axis points UP → positive = TE to the right (nose-right yaw).
 *  - For doors the axis is chosen per door; see openAngle in the part metadata.
 * Parts may also carry relative morph targets (e.g. a variable-area nozzle); they are kept in LOD0
 * and dropped from the rest-pose LOD1 merge.
 *
 * Optional baked AO (`ao`): the airframe is ray-cast against its static pieces once at build time
 * and the result multiplied into the vertex colours. Animated parts never cast it (so nothing goes
 * dark when a surface deflects or a door opens) and receive it in their rest pose unless excluded.
 */
import { BufferAttribute, BufferGeometry, Group, Matrix3, Matrix4, Mesh, Object3D, Quaternion, Vector3, type Material } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { applyAtlasUVs, type AtlasBounds } from './geom/atlas';
import { bakeVertexAO, type AoOptions } from './geom/ao';
import { setColor } from './geom/core';
import { getMaterial, getVariant } from './materials';

interface Piece {
  geo: BufferGeometry;
  mat: string;
  /** Unrefined stand-in for the merged LOD1 mesh (set when the AO bake refined `geo`). */
  lod1?: BufferGeometry;
}

interface PartDef {
  name: string;
  pieces: Piece[];
  pivot: Vector3;
  axis: Vector3;
}

const _x = new Vector3(1, 0, 0);

export interface BuiltModel {
  /** Full detail: static mesh + pivots with animated parts (named). */
  lod0: Group;
  /** Everything merged at rest pose (one mesh, material groups). */
  lod1: Group;
  triangles: number;
}

export class ModelBuilder {
  private statics: Piece[] = [];
  private parts = new Map<string, PartDef>();
  /** Material keys that receive atlas UVs (textured liveries). */
  private atlasMats = new Set<string>();
  /** Parts left out of the merged LOD1 mesh (e.g. empty pylons). */
  private noLod1 = new Set<string>();
  /** Vertex tint used for canopy glass in the single-material LOD1 mesh. */
  glassTint = 0x1c2229;
  /** Bake ambient occlusion into the vertex colours (null = off); see bakeAO(). */
  ao: (AoOptions & { skip?: string[]; skipParts?: string[] }) | null = null;

  constructor(
    /** Maps logical material names ('skin', 'dark', ...) to cache keys ('f35.skin'). */
    private readonly resolve: (mat: string) => string = (m) => m,
    private readonly atlas: AtlasBounds | null = null,
    atlasMaterials: string[] = ['skin'],
  ) {
    atlasMaterials.forEach((m) => this.atlasMats.add(m));
  }

  add(geo: BufferGeometry, mat: string): this {
    this.statics.push({ geo, mat });
    return this;
  }

  /**
   * Add geometry (model coordinates) to an animated part that rotates about the axis through
   * `pivot` along `axis` (normalised internally). Multiple calls with the same name accumulate.
   */
  addPart(name: string, geo: BufferGeometry, mat: string, pivot: Vector3, axis: Vector3): this {
    let p = this.parts.get(name);
    if (!p) {
      p = { name, pieces: [], pivot: pivot.clone(), axis: axis.clone().normalize() };
      this.parts.set(name, p);
    }
    p.pieces.push({ geo, mat });
    return this;
  }

  /** Part defined by a hinge line from a to b (axis = b - a). */
  addHinged(name: string, geo: BufferGeometry, mat: string, a: Vector3, b: Vector3): this {
    return this.addPart(name, geo, mat, a, b.clone().sub(a));
  }

  excludeFromLod1(...names: string[]): this {
    names.forEach((n) => this.noLod1.add(n));
    return this;
  }

  private uv(p: Piece): void {
    if (!this.atlas || !this.atlasMats.has(p.mat)) return;
    applyAtlasUVs(p.geo, this.atlas);
    if (p.lod1) applyAtlasUVs(p.lod1, this.atlas);
  }

  /** Merge pieces by material into one mesh with groups. */
  private static meshOf(pieces: Piece[], resolve: (m: string) => string): Mesh | null {
    if (pieces.length === 0) return null;
    const byMat = new Map<string, BufferGeometry[]>();
    for (const p of pieces) {
      const k = resolve(p.mat);
      let arr = byMat.get(k);
      if (!arr) byMat.set(k, (arr = []));
      arr.push(p.geo);
    }
    const keys = [...byMat.keys()];
    const perMat = keys.map((k) => {
      const list = byMat.get(k)!;
      return list.length === 1 ? list[0] : mergeGeometries(list, false)!;
    });
    const geo = perMat.length === 1 ? perMat[0] : mergeGeometries(perMat, true)!;
    if (perMat.length === 1) {
      geo.clearGroups();
    }
    // mergeGeometries checks but does not copy this flag; absolute morphs would collapse the base
    geo.morphTargetsRelative = pieces[0].geo.morphTargetsRelative;
    geo.computeBoundingSphere();
    geo.computeBoundingBox();
    const mats: Material[] = keys.map((k) => getMaterial(k));
    const mesh = new Mesh(geo, mats.length === 1 ? mats[0] : mats);
    return mesh;
  }

  /**
   * Static pieces and animated parts (in their rest pose) receive AO, except `skip` materials and
   * `skipParts`; only the statics occlude. Hinged surfaces keep their roots against the airframe at
   * any deflection, so a rest-pose bake stays valid; doors, whose closed pose seals a cavity, don't.
   */
  private bakeAO(): void {
    if (!this.ao) return;
    const skip = new Set(this.ao.skip ?? []);
    const skipParts = new Set(this.ao.skipParts ?? []);
    const receivers = this.statics.filter((p) => !skip.has(p.mat));
    for (const d of this.parts.values()) if (!skipParts.has(d.name)) receivers.push(...d.pieces.filter((p) => !skip.has(p.mat)));
    const { fine, coarse } = bakeVertexAO(
      receivers.map((p) => p.geo),
      this.statics.map((p) => p.geo),
      this.ao,
    );
    // refined geometry draws in LOD0; LOD1 keeps the original triangle count
    receivers.forEach((p, i) => {
      if (fine[i] !== coarse[i]) p.lod1 = coarse[i];
      p.geo = fine[i];
    });
  }

  /** Apply `m` to a part piece, including its relative morph deltas (linear part only). */
  private static transformPiece(geo: BufferGeometry, m: Matrix4): BufferGeometry {
    geo.applyMatrix4(m);
    const morph = geo.morphAttributes;
    if (morph.position || morph.normal) {
      const lin = new Matrix3().setFromMatrix4(m);
      const nrm = new Matrix3().getNormalMatrix(m);
      for (const a of morph.position ?? []) (a as BufferAttribute).applyMatrix3(lin);
      for (const a of morph.normal ?? []) (a as BufferAttribute).applyMatrix3(nrm);
    }
    return geo;
  }

  build(): BuiltModel {
    const resolve = this.resolve;
    this.bakeAO();
    this.statics.forEach((p) => this.uv(p));
    this.parts.forEach((d) => d.pieces.forEach((p) => this.uv(p)));

    // LOD1: everything in rest pose (clone geometry so LOD0 keeps its own buffers)
    const all: Piece[] = this.statics.map((p) => ({ geo: p.lod1 ?? p.geo, mat: p.mat }));
    this.parts.forEach((d) => {
      if (!this.noLod1.has(d.name)) d.pieces.forEach((p) => all.push({ geo: p.lod1 ?? p.geo, mat: p.mat }));
    });
    const lod1 = new Group();
    lod1.name = 'lod1';
    let m1: Mesh | null;
    if (this.atlas) {
      // Single draw call: every piece uses the textured skin material with vertex-colour tints
      // (glass/dark/metal parts are darkened through their vertex colours).
      const atlas = this.atlas;
      const skinKey = resolve('skin');
      const pieces = all.map((p) => {
        const g = restPose(p.geo.clone());
        if (!this.atlasMats.has(p.mat)) applyAtlasUVs(g, atlas);
        if (p.mat === 'glass') setColor(g, this.glassTint);
        return { geo: g, mat: 'skin' };
      });
      m1 = ModelBuilder.meshOf(pieces, () => skinKey);
      if (m1) m1.material = getVariant(skinKey, 'lod1', (m) => {
        const c = m.clone();
        c.vertexColors = true;
        return c;
      });
    } else {
      m1 = ModelBuilder.meshOf(
        all.map((p) => ({ geo: restPose(p.geo.clone()), mat: p.mat })),
        resolve,
      );
    }
    if (m1) {
      m1.name = 'body';
      lod1.add(m1);
    }

    // LOD0: static body + pivots
    const lod0 = new Group();
    lod0.name = 'lod0';
    const body = ModelBuilder.meshOf(this.statics, resolve);
    if (body) {
      body.name = 'body';
      lod0.add(body);
    }
    const inv = new Matrix4();
    const pm = new Matrix4();
    const q = new Quaternion();
    for (const d of this.parts.values()) {
      const pivot = new Object3D();
      pivot.name = `pivot:${d.name}`;
      q.setFromUnitVectors(_x, d.axis);
      pivot.position.copy(d.pivot);
      pivot.quaternion.copy(q);
      pm.compose(d.pivot, q, new Vector3(1, 1, 1));
      inv.copy(pm).invert();
      const local = d.pieces.map((p) => ({ geo: ModelBuilder.transformPiece(p.geo, inv), mat: p.mat }));
      const mesh = ModelBuilder.meshOf(local, resolve);
      if (mesh) {
        mesh.name = `part:${d.name}`;
        pivot.add(mesh);
      }
      lod0.add(pivot);
    }
    let triangles = 0;
    lod0.traverse((o) => {
      const m = o as Mesh;
      if (m.isMesh) triangles += (m.geometry.attributes.position.count / 3) | 0;
    });
    return { lod0, lod1, triangles };
  }
}

/** Drop morph targets (LOD1 is a single rest-pose merge; base positions are the rest pose). */
function restPose(g: BufferGeometry): BufferGeometry {
  g.morphAttributes = {};
  g.morphTargetsRelative = false;
  return g;
}
