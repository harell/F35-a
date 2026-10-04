/**
 * F35-A — collapsing buildings in the merged CBD mesh: the CBD's skyscrapers (#128) and the hero
 * landmarks that ride in the same mesh (Spark Arena, the Auckland Museum).
 *
 * The sim marks a building collapsed when an aircraft flies into it (sim/buildings.ts), with the sim
 * time it started coming down. Here its vertices in the merged CBD mesh come down to a low rubble heap:
 * the building stands for COLLAPSE_DELAY while its charges go off (Effects), then everything above
 * the heap drops at about free fall (the walls and roof squashed to RUBBLE_HEIGHT above its ground),
 * so the top comes down first and the heap is all that is left after buildingCollapseTime(). A hero's
 * night lights go out and its separate meshes (Spark Arena's signs) hide as it falls. A new mission's
 * world has every building standing, so the heap is lifted back to the original heights (kept per building).
 */
import type { BufferAttribute, BufferGeometry, Object3D } from 'three';
import type { SimWorld } from '../../sim/api';
import { COLLAPSE_ACCEL, COLLAPSE_DELAY, buildingCollapseTime } from '../../sim/buildings';

/** Height of a collapsed building's rubble heap above its ground (m). */
export const RUBBLE_HEIGHT = 9;

/** A hero landmark in the merged mesh (its building id is negative: sim/buildings.ts). */
export interface HeroCollapseRange {
  /** Building id in the sim's index (SPARK_ARENA_ID, MUSEUM_ID). */
  id: number;
  /** [v0, v1) vertex range in the merged mesh. */
  v0: number;
  v1: number;
  ground: number;
  /** [l0, l1) of its night lights in the fixture lights (none: l0 = l1). */
  l0: number;
  l1: number;
  /** Separate meshes that go with it (Spark Arena's signs). */
  objects?: Object3D[];
}

/** Height of a vertex that stood at `y0`, `t` s into its building's collapse. */
export function collapsedY(y0: number, ground: number, t: number): number {
  const cap = ground + RUBBLE_HEIGHT;
  if (y0 <= cap || t <= COLLAPSE_DELAY) return y0;
  const tf = t - COLLAPSE_DELAY;
  return Math.max(cap, y0 - 0.5 * COLLAPSE_ACCEL * tf * tf);
}

interface Applied {
  v0: number;
  ground: number;
  ys: Float32Array;
  /** Building height (m): how long its fall lasts. */
  height: number;
  done: boolean;
  hero: HeroCollapseRange | null;
  /** Hero light colours before they went out. */
  lightColors: Float32Array | null;
}

export class CbdCollapseVisual {
  /** Building id → what was changed (the original Y of its vertices). */
  private readonly applied = new Map<number, Applied>();
  private readonly heroes = new Map<number, HeroCollapseRange>();
  private world: SimWorld | null = null;
  private version = -1;

  constructor(
    private readonly geo: BufferGeometry,
    /** [start, end) vertex range of building i at [2i, 2i + 1]. */
    private readonly verts: Int32Array,
    /** Ground height of building i. */
    private readonly ground: Float32Array,
    heroes: readonly HeroCollapseRange[] = [],
    /** The fixture lights (LightList Points), where the heroes' night lights are (built after the mesh). */
    public lights: BufferGeometry | null = null,
  ) {
    for (const h of heroes) this.heroes.set(h.id, h);
  }

  /** Building ids shown collapsed (or collapsing) now. */
  get collapsed(): number[] {
    return [...this.applied.keys()];
  }

  /** True while a building is still coming down. */
  get animating(): boolean {
    for (const a of this.applied.values()) if (!a.done) return true;
    return false;
  }

  update(world: SimWorld | null | undefined): void {
    const w = world ?? null;
    const idx = w?.buildings ?? null;
    const version = idx?.version ?? 0;
    if (w === this.world && version === this.version && !this.animating) return;
    this.world = w;
    this.version = version;
    const want = new Map<number, { start: number; height: number }>();
    if (idx) {
      for (const k of idx.collapsed) {
        const b = idx.geo.buildings[k];
        want.set(b.id, { start: idx.collapsedAt.get(k) ?? -Infinity, height: b.top - b.ground });
      }
    }
    const pos = this.geo.getAttribute('position') as BufferAttribute;
    const arr = pos.array as Float32Array;
    let dirty = false;
    // a new world: stand the fallen ones up again
    for (const [id, a] of this.applied) {
      if (want.has(id)) continue;
      for (let i = 0; i < a.ys.length; i++) arr[(a.v0 + i) * 3 + 1] = a.ys[i];
      pos.addUpdateRange(a.v0 * 3, a.ys.length * 3);
      this.setHeroShown(a, true);
      this.applied.delete(id);
      dirty = true;
    }
    const now = w?.time ?? 0;
    for (const [id, c] of want) {
      let a = this.applied.get(id);
      if (!a) {
        a = this.begin(id, c.height, arr) ?? undefined;
        if (!a) continue;
        this.applied.set(id, a);
        this.setHeroShown(a, false);
      }
      if (a.done) continue;
      const t = now - c.start;
      for (let i = 0; i < a.ys.length; i++) arr[(a.v0 + i) * 3 + 1] = collapsedY(a.ys[i], a.ground, t);
      pos.addUpdateRange(a.v0 * 3, a.ys.length * 3);
      a.done = t >= buildingCollapseTime(a.height);
      dirty = true;
    }
    if (dirty) pos.needsUpdate = true;
  }

  /** Snapshot a building's vertices before its fall (null: it isn't in this mesh). */
  private begin(id: number, height: number, arr: Float32Array): Applied | null {
    const hero = this.heroes.get(id) ?? null;
    let v0: number;
    let v1: number;
    let ground: number;
    if (hero) {
      v0 = hero.v0;
      v1 = hero.v1;
      ground = hero.ground;
    } else {
      if (id < 0 || id * 2 + 1 >= this.verts.length) return null;
      v0 = this.verts[id * 2];
      v1 = this.verts[id * 2 + 1];
      ground = this.ground[id];
    }
    const ys = new Float32Array(Math.max(0, v1 - v0));
    for (let v = v0; v < v1; v++) ys[v - v0] = arr[v * 3 + 1];
    return { v0, ground, ys, height, done: false, hero, lightColors: null };
  }

  /** A hero's night lights (blacked out: they draw additively) and its separate meshes, on or off. */
  private setHeroShown(a: Applied, shown: boolean): void {
    const h = a.hero;
    if (!h) return;
    for (const o of h.objects ?? []) o.visible = shown;
    const attr = this.lights?.getAttribute('aColor') as BufferAttribute | undefined;
    if (!attr || h.l1 <= h.l0) return;
    const col = attr.array as Float32Array;
    if (!shown) {
      a.lightColors = col.slice(h.l0 * 3, h.l1 * 3);
      col.fill(0, h.l0 * 3, h.l1 * 3);
    } else if (a.lightColors) {
      col.set(a.lightColors, h.l0 * 3);
      a.lightColors = null;
    }
    attr.needsUpdate = true;
  }
}
