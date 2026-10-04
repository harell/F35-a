/**
 * F35-A — the Auckland Harbour Bridge coming down: the span the player's jet flew into (sim/buildings.ts, one hero per
 * span, ids HARBOUR_BRIDGE_ID − i) falls into the harbour.
 *
 * The bridge is one merged mesh (harbourBridge.ts). Each vertex belongs to the span whose stretch of s it lies in, a few
 * metres clear of the supports, so the piers and their caps stand and the neighbouring spans end in torn stubs. A falling
 * span stands for COLLAPSE_DELAY while its charges go off (Effects), then drops at about free fall, sagging in the middle,
 * until it lies under the water; its lamp posts go dark with it. A new mission's world has the bridge whole again.
 */
import type { BufferAttribute, BufferGeometry } from 'three';
import { HB_SUPPORTS, hbFrame } from '../../core/harbourBridge';
import type { SimWorld } from '../../sim/api';
import { COLLAPSE_ACCEL, COLLAPSE_DELAY, HARBOUR_BRIDGE_ID, HARBOUR_BRIDGE_SPANS } from '../../sim/buildings';

/** How far a fallen span ends up below where it stood (m): its top chord (~65 m) well under the water. */
export const SPAN_SINK = 100;
/** Vertices this close to a support (m along the bridge) stay with it: the pier caps and the stubs over them. */
const SUPPORT_CLEAR = 4;

/** How far a span's vertex at `u` (0..1 along the span) has dropped `t` s into its fall (m). */
export function spanDrop(t: number, u: number): number {
  if (t <= COLLAPSE_DELAY) return 0;
  const tf = t - COLLAPSE_DELAY;
  // the middle leads (it sags and breaks first), the ends follow
  const sag = 0.7 + 0.3 * Math.sin(Math.PI * Math.min(1, Math.max(0, u)));
  return Math.min(SPAN_SINK, 0.5 * COLLAPSE_ACCEL * tf * tf * sag);
}

/** Seconds until a span has finished falling. */
export const SPAN_FALL_TIME = COLLAPSE_DELAY + Math.sqrt((2 * SPAN_SINK) / (COLLAPSE_ACCEL * 0.7));

interface Span {
  /** Vertex indices in the bridge mesh, their standing Y and their place along the span (0..1). */
  verts: Int32Array;
  ys: Float32Array;
  us: Float32Array;
  /** Fixture light indices on the span, their colours while lit. */
  lights: Int32Array | null;
  lightColors: Float32Array | null;
}

/** Span index (0..HARBOUR_BRIDGE_SPANS-1) at bridge-frame `s`, or -1 (a support, or off the bridge). */
export function spanAt(s: number): number {
  for (let i = 0; i < HARBOUR_BRIDGE_SPANS; i++) {
    if (s > HB_SUPPORTS[i] + SUPPORT_CLEAR && s < HB_SUPPORTS[i + 1] - SUPPORT_CLEAR) return i;
  }
  return -1;
}

export class BridgeCollapseVisual {
  private readonly spans: Span[] = [];
  /** Span index → the sim time its fall started (what the mesh shows now). */
  private readonly shown = new Map<number, { start: number; done: boolean }>();
  private world: SimWorld | null = null;
  private version = -1;

  constructor(
    private readonly geo: BufferGeometry,
    /** The fixture lights (LightList Points) and the bridge's [l0, l1) range in them (set once the lights are built). */
    public lights: BufferGeometry | null = null,
    public lightRange: [number, number] = [0, 0],
  ) {
    const arr = (geo.getAttribute('position') as BufferAttribute).array as Float32Array;
    const lists: number[][] = Array.from({ length: HARBOUR_BRIDGE_SPANS }, () => []);
    const n = arr.length / 3;
    for (let v = 0; v < n; v++) {
      const k = spanAt(hbFrame(arr[v * 3], arr[v * 3 + 2])[0]);
      if (k >= 0) lists[k].push(v);
    }
    for (let k = 0; k < HARBOUR_BRIDGE_SPANS; k++) {
      const verts = Int32Array.from(lists[k]);
      const ys = new Float32Array(verts.length);
      const us = new Float32Array(verts.length);
      const a = HB_SUPPORTS[k];
      const len = HB_SUPPORTS[k + 1] - a;
      verts.forEach((v, i) => {
        ys[i] = arr[v * 3 + 1];
        us[i] = (hbFrame(arr[v * 3], arr[v * 3 + 2])[0] - a) / len;
      });
      this.spans.push({ verts, ys, us, lights: null, lightColors: null });
    }
  }

  /** Spans shown fallen (or falling) now. */
  get collapsed(): number[] {
    return [...this.shown.keys()];
  }

  get animating(): boolean {
    for (const s of this.shown.values()) if (!s.done) return true;
    return false;
  }

  update(world: SimWorld | null | undefined): void {
    const w = world ?? null;
    const idx = w?.buildings ?? null;
    const version = idx?.version ?? 0;
    if (w === this.world && version === this.version && !this.animating) return;
    this.world = w;
    this.version = version;
    const want = new Map<number, number>();
    if (idx) {
      for (const k of idx.collapsed) {
        const span = HARBOUR_BRIDGE_ID - idx.geo.buildings[k].id;
        if (span >= 0 && span < HARBOUR_BRIDGE_SPANS) want.set(span, idx.collapsedAt.get(k) ?? -Infinity);
      }
    }
    const pos = this.geo.getAttribute('position') as BufferAttribute;
    const arr = pos.array as Float32Array;
    let dirty = false;
    // a new world: the fallen spans stand again
    for (const k of [...this.shown.keys()]) {
      if (want.has(k)) continue;
      const sp = this.spans[k];
      sp.verts.forEach((v, i) => (arr[v * 3 + 1] = sp.ys[i]));
      this.setLit(sp, true);
      this.shown.delete(k);
      dirty = true;
    }
    const now = w?.time ?? 0;
    for (const [k, start] of want) {
      let st = this.shown.get(k);
      if (!st) {
        this.shown.set(k, (st = { start, done: false }));
        this.setLit(this.spans[k], false);
      }
      if (st.done) continue;
      const t = now - st.start;
      const sp = this.spans[k];
      sp.verts.forEach((v, i) => (arr[v * 3 + 1] = sp.ys[i] - spanDrop(t, sp.us[i])));
      st.done = t >= SPAN_FALL_TIME;
      dirty = true;
    }
    // (the bounding sphere of a bridge a kilometre long holds a span 100 m under it)
    if (dirty) pos.needsUpdate = true;
  }

  /** A span's lamp posts on (their colours back) or off (black: the lights draw additively). */
  private setLit(sp: Span, lit: boolean): void {
    const g = this.lights;
    if (!g) return;
    const attr = g.getAttribute('aColor') as BufferAttribute | undefined;
    const p = g.getAttribute('position') as BufferAttribute | undefined;
    if (!attr || !p) return;
    const col = attr.array as Float32Array;
    if (!sp.lights) {
      const k = this.spans.indexOf(sp);
      const ids: number[] = [];
      const [l0, l1] = this.lightRange;
      for (let i = l0; i < l1; i++) if (spanAt(hbFrame(p.getX(i), p.getZ(i))[0]) === k) ids.push(i);
      sp.lights = Int32Array.from(ids);
    }
    if (!lit) {
      sp.lightColors = new Float32Array(sp.lights.length * 3);
      sp.lights.forEach((l, i) => {
        sp.lightColors!.set(col.subarray(l * 3, l * 3 + 3), i * 3);
        col.fill(0, l * 3, l * 3 + 3);
      });
    } else if (sp.lightColors) {
      sp.lights.forEach((l, i) => col.set(sp.lightColors!.subarray(i * 3, i * 3 + 3), l * 3));
      sp.lightColors = null;
    }
    attr.needsUpdate = true;
  }
}
