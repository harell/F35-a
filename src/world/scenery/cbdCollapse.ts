/**
 * F35-A — collapsed CBD skyscrapers in the merged CBD mesh (#128).
 *
 * The sim marks a building collapsed when an aircraft flies into it (sim/buildings.ts). Here its
 * vertices in the merged CBD mesh drop to a low rubble heap (the walls and roof squashed to
 * RUBBLE_HEIGHT above its ground); Effects plays the dust and fire. A new mission's world has every
 * building standing, so the heap is lifted back to the original heights (kept per building).
 */
import type { BufferAttribute, BufferGeometry } from 'three';
import type { SimWorld } from '../../sim/api';

/** Height of a collapsed building's rubble heap above its ground (m). */
export const RUBBLE_HEIGHT = 9;

export class CbdCollapseVisual {
  /** Building id (index into aucklandBuildings()) → the original Y of its vertices. */
  private readonly applied = new Map<number, Float32Array>();
  private world: SimWorld | null = null;
  private version = -1;

  constructor(
    private readonly geo: BufferGeometry,
    /** [start, end) vertex range of building i at [2i, 2i + 1]. */
    private readonly verts: Int32Array,
    /** Ground height of building i. */
    private readonly ground: Float32Array,
  ) {}

  /** Building ids shown collapsed now. */
  get collapsed(): number[] {
    return [...this.applied.keys()];
  }

  update(world: SimWorld | null | undefined): void {
    const w = world ?? null;
    const idx = w?.buildings ?? null;
    const version = idx?.version ?? 0;
    if (w === this.world && version === this.version) return;
    this.world = w;
    this.version = version;
    const want = new Set<number>();
    if (idx) for (const k of idx.collapsed) want.add(idx.geo.buildings[k].id);
    const pos = this.geo.getAttribute('position') as BufferAttribute;
    const arr = pos.array as Float32Array;
    let dirty = false;
    for (const [id, ys] of this.applied) {
      if (want.has(id)) continue;
      const v0 = this.verts[id * 2];
      for (let i = 0; i < ys.length; i++) arr[(v0 + i) * 3 + 1] = ys[i];
      this.applied.delete(id);
      dirty = true;
    }
    for (const id of want) {
      if (this.applied.has(id) || id * 2 + 1 >= this.verts.length) continue;
      const v0 = this.verts[id * 2];
      const v1 = this.verts[id * 2 + 1];
      const ys = new Float32Array(Math.max(0, v1 - v0));
      const cap = this.ground[id] + RUBBLE_HEIGHT;
      for (let v = v0; v < v1; v++) {
        const y = arr[v * 3 + 1];
        ys[v - v0] = y;
        if (y > cap) arr[v * 3 + 1] = cap;
      }
      this.applied.set(id, ys);
      dirty = true;
    }
    if (dirty) pos.needsUpdate = true;
  }
}
