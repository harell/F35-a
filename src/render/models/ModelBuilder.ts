/**
 * ModelBuilder: collects canonical geometry pieces by material key, bakes the static airframe into
 * one mesh (material groups → one draw call per material) and wraps animated parts in hinge pivots.
 *
 * Pivot convention: every animated part rotates about its pivot's LOCAL X axis (mesh.rotation.x).
 *  - For trailing-edge surfaces the hinge axis points to the RIGHT (+X-ish) → positive = TE down.
 *  - For rudders the hinge axis points UP → positive = TE to the right (nose-right yaw).
 *  - For doors the axis is chosen per door; see openAngle in the part metadata.
 */
import { BufferGeometry, Group, Matrix4, Mesh, Object3D, Quaternion, Vector3, type Material } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { applyAtlasUVs, type AtlasBounds } from './geom/atlas';
import { setColor } from './geom/core';
import { getMaterial, getVariant } from './materials';

interface Piece {
  geo: BufferGeometry;
  mat: string;
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
    if (this.atlas && this.atlasMats.has(p.mat)) applyAtlasUVs(p.geo, this.atlas);
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
    geo.computeBoundingSphere();
    geo.computeBoundingBox();
    const mats: Material[] = keys.map((k) => getMaterial(k));
    const mesh = new Mesh(geo, mats.length === 1 ? mats[0] : mats);
    return mesh;
  }

  build(): BuiltModel {
    const resolve = this.resolve;
    this.statics.forEach((p) => this.uv(p));
    this.parts.forEach((d) => d.pieces.forEach((p) => this.uv(p)));

    // LOD1: everything in rest pose (clone geometry so LOD0 keeps its own buffers)
    const all: Piece[] = [...this.statics];
    this.parts.forEach((d) => {
      if (!this.noLod1.has(d.name)) d.pieces.forEach((p) => all.push({ geo: p.geo, mat: p.mat }));
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
        const g = p.geo.clone();
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
        all.map((p) => ({ geo: p.geo.clone(), mat: p.mat })),
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
      const local = d.pieces.map((p) => ({ geo: p.geo.applyMatrix4(inv), mat: p.mat }));
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
