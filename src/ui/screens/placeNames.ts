/**
 * F35-A — suburb, locality and island names on the briefing map (#129).
 *
 * The names (src/ui/art/aucklandPlaces.ts, baked from LINZ) are the lowest-priority labels: they go
 * after the mission's markers, route and labels, and a name is dropped when its box would touch one
 * of theirs, another name or the canvas edge. The names nearest the targets and waypoints come first
 * (a strike on Newmarket shows "Newmarket" even when bigger suburbs are dropped), then islands and the
 * biggest suburbs; how many fit follows from the zoom, since a wider view has more names competing
 * for the same pixels.
 */
import { AUCKLAND_PLACES, type PlaceKind } from '../art/aucklandPlaces';

export interface ScreenBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PlacedName extends ScreenBox {
  name: string;
  kind: PlaceKind;
  /** Text centre (CSS px). */
  cx: number;
  cy: number;
}

export interface PlaceNameOptions {
  /** Canvas size (CSS px). */
  w: number;
  h: number;
  /** World → screen. */
  X: (x: number) => number;
  Y: (z: number) => number;
  /** World points the mission is about (targets, threats, waypoints): names near them win. */
  anchors: readonly { x: number; z: number }[];
  /** Boxes already taken (marker icons, labels, the north arrow, the scale bar). */
  blocked: readonly ScreenBox[];
  /** Text width (CSS px) at the names' font. */
  measure: (text: string) => number;
  /** Font size (CSS px). */
  size: number;
  /** At most this many names (default: one per 9,000 px², so ~36 on an 844×390 phone map). */
  max?: number;
}

/** Within this distance of an anchor (m), a name is mission-relevant and goes first. */
const NEAR = 2500;
/** Clear space kept round each name (px). */
const GAP = 5;

/** Display text: 'Te Atatū Peninsula' stays, 'Rangitoto Island' → 'Rangitoto Island' (as LINZ spells it). */
export function placeLabel(name: string): string {
  return name;
}

function overlaps(a: ScreenBox, b: ScreenBox): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** Choose and position the place names for one map. Pure: the caller draws them. */
export function choosePlaceNames(o: PlaceNameOptions): PlacedName[] {
  const max = o.max ?? Math.max(4, Math.round((o.w * o.h) / 9000));
  type Cand = { name: string; kind: PlaceKind; sx: number; sy: number; score: number };
  const cands: Cand[] = [];
  const seen = new Set<string>();
  for (const [name, kind, x, z, pop] of AUCKLAND_PLACES) {
    const sx = o.X(x);
    const sy = o.Y(z);
    if (sx < 0 || sy < 0 || sx > o.w || sy > o.h) continue;
    let near = Infinity;
    for (const a of o.anchors) near = Math.min(near, Math.hypot(a.x - x, a.z - z));
    // mission-relevant first (closest first), then islands, then by population
    const base = kind === 'island' ? 30_000 : pop;
    const score = (near < NEAR ? 1e7 * (1 - near / NEAR) + 1e6 : 0) + base;
    cands.push({ name, kind, sx, sy, score });
  }
  cands.sort((a, b) => b.score - a.score);
  const out: PlacedName[] = [];
  for (const c of cands) {
    if (out.length >= max) break;
    if (seen.has(c.name)) continue;
    const text = placeLabel(c.name);
    const tw = o.measure(text) + 4;
    const th = o.size + 2;
    const box = { x: c.sx - tw / 2, y: c.sy - th / 2, w: tw, h: th };
    if (box.x < 2 || box.y < 2 || box.x + box.w > o.w - 2 || box.y + box.h > o.h - 2) continue;
    const padded = { x: box.x - GAP, y: box.y - GAP, w: box.w + GAP * 2, h: box.h + GAP * 2 };
    if (o.blocked.some((b) => overlaps(padded, b)) || out.some((b) => overlaps(padded, b))) continue;
    seen.add(c.name);
    out.push({ ...box, name: text, kind: c.kind, cx: c.sx, cy: c.sy });
  }
  return out;
}
