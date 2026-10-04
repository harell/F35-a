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
  /** Display text for a baked name (default: `placeLabel`). Names that read the same are shown once. */
  label?: (name: string) => string;
  /** Rank of a name with no mission anchor near it (default: islands 30,000, others their population). */
  rank?: (name: string, kind: PlaceKind, pop: number) => number;
  /** Display texts never to show (already on the map as fixed labels). */
  skip?: readonly string[];
}

/** Within this distance of an anchor (m), a name is mission-relevant and goes first. */
const NEAR = 2500;
/** Clear space kept round each name (px). */
const GAP = 5;

/** Display text: 'Te Atatū Peninsula' stays, 'Rangitoto Island' → 'Rangitoto Island' (as LINZ spells it). */
export function placeLabel(name: string): string {
  return name;
}

/**
 * An island for ranking. The bake files some islands as localities (Waiheke Island, Motutapu Island,
 * Browns Island (Motukorea)) with a resident count that would rank Waiheke below a small suburb.
 */
export function isIsland(name: string, kind: PlaceKind): boolean {
  return kind === 'island' || /\S Island\b/.test(name);
}

function overlaps(a: ScreenBox, b: ScreenBox): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** Choose and position the place names for one map. Pure: the caller draws them. */
export function choosePlaceNames(o: PlaceNameOptions): PlacedName[] {
  const max = o.max ?? Math.max(4, Math.round((o.w * o.h) / 9000));
  type Cand = { name: string; kind: PlaceKind; sx: number; sy: number; score: number };
  const cands: Cand[] = [];
  const seen = new Set<string>(o.skip ?? []);
  for (const [name, kind, x, z, pop] of AUCKLAND_PLACES) {
    const sx = o.X(x);
    const sy = o.Y(z);
    if (sx < 0 || sy < 0 || sx > o.w || sy > o.h) continue;
    let near = Infinity;
    for (const a of o.anchors) near = Math.min(near, Math.hypot(a.x - x, a.z - z));
    // mission-relevant first (closest first), then islands, then by population
    const base = o.rank ? o.rank(name, kind, pop) : isIsland(name, kind) ? 30_000 : pop;
    const score = (near < NEAR ? 1e7 * (1 - near / NEAR) + 1e6 : 0) + base;
    cands.push({ name, kind, sx, sy, score });
  }
  cands.sort((a, b) => b.score - a.score);
  const out: PlacedName[] = [];
  for (const c of cands) {
    if (out.length >= max) break;
    const text = (o.label ?? placeLabel)(c.name);
    if (seen.has(text)) continue;
    const tw = o.measure(text) + 4;
    const th = o.size + 2;
    const box = { x: c.sx - tw / 2, y: c.sy - th / 2, w: tw, h: th };
    if (box.x < 2 || box.y < 2 || box.x + box.w > o.w - 2 || box.y + box.h > o.h - 2) continue;
    const padded = { x: box.x - GAP, y: box.y - GAP, w: box.w + GAP * 2, h: box.h + GAP * 2 };
    if (o.blocked.some((b) => overlaps(padded, b)) || out.some((b) => overlaps(padded, b))) continue;
    seen.add(text);
    out.push({ ...box, name: text, kind: isIsland(c.name, c.kind) ? 'island' : c.kind, cx: c.sx, cy: c.sy });
  }
  return out;
}

/**
 * Menu-chart text: upper case, the first of two names, without "Island"
 * ('Browns Island (Motukorea)' → 'BROWNS', 'Motuihe Island / Te Motu-a-Ihenga' → 'MOTUIHE').
 */
export function chartLabel(name: string): string {
  return name
    .replace(/\s*\/.*$/, '')
    .replace(/\s*\(.*\)$/, '')
    .replace(/ Island$/, '')
    .toUpperCase();
}

/**
 * Menu-chart rank: the islands people live on or visit (the bake gives them a population: Waiheke,
 * Herald, Rākino, Rangitoto, Motutapu…) first, then suburbs by population; the dozens of uninhabited
 * islets rank with a small suburb, so they fill in only where there is room.
 */
function chartRank(name: string, kind: PlaceKind, pop: number): number {
  if (!isIsland(name, kind)) return pop;
  return pop > 0 ? 50_000 + pop : 3_000;
}

export interface ChartNameOptions {
  /** Chart canvas size (px). */
  w: number;
  h: number;
  X: (x: number) => number;
  Y: (z: number) => number;
  /** Text width (px) of a chart label as drawn. */
  measure: (text: string) => number;
  /** Font size (px). */
  size: number;
  /** The chart's fixed labels (seas, the city, the air base): their boxes and texts. */
  fixed: readonly (ScreenBox & { text: string })[];
  /** Square pixels per name (default 35,000; the menu chart is a background, so sparser than a briefing). */
  areaPerName?: number;
}

/**
 * The main-menu chart's island and suburb names (#129): the same chooser as the briefing map, with
 * no mission to favour, so islands come first and then the biggest suburbs, dropped where they would
 * touch a fixed label or another name.
 */
export function chooseChartNames(o: ChartNameOptions): PlacedName[] {
  return choosePlaceNames({
    w: o.w,
    h: o.h,
    X: o.X,
    Y: o.Y,
    anchors: [],
    blocked: o.fixed,
    measure: o.measure,
    size: o.size,
    max: Math.max(6, Math.round((o.w * o.h) / (o.areaPerName ?? 35_000))),
    label: chartLabel,
    rank: chartRank,
    // the fixed AUCKLAND label already names the city centre
    skip: [...o.fixed.map((f) => f.text), 'AUCKLAND CENTRAL'],
  });
}
