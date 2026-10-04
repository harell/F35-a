/**
 * F35-A — Auckland Harbour Bridge: shape data measured from the LINZ 2024 Auckland LiDAR (1 m DSM/DEM, CC BY 4.0),
 * OpenStreetMap piers (bridge:support=pier, ways 1000929555–1000929560, from the LINZ chart; ODbL) and the published
 * spans (Structurae: 80.82 · 103.70 · 114.375 · 124.06 · 177.28 · 244.00 · 176.90 m). Prototype and measurements:
 * tools/hero/examples/harbour-bridge.html, tools/hero/sites/harbour_bridge.py.
 *
 * Frame: s runs along the pier line towards Northcote (+s north-north-east), t across it (+t east-south-east);
 * s = 0 is 20.7 m north of the main span's centre. Measured in the NZTM site frame, converted NZTM → WGS84 → game
 * (geoToWorld); the game's scale is 0.9996 of NZTM along the axis, which this ignores (< 0.4 m at the ends).
 * Heights are metres above the datum (the game's y, ≈ mean sea level).
 *
 * Measured: the deck (two ±5.0 % grades joined by a 248 m vertical curve, RMS 0.05 m; crest 46.4 m), the width
 * (±17.6 m), the through truss's top chord (two trusses at t = ±7.5 m, agreeing to 0.5 m; 64.4 m at the crest), the
 * panel length (the top bracing repeats every 15.3 m), the sign gantries and the flagpoles (73.2 m).
 * From photos (Wikimedia Commons): a deck truss under the road the whole way, deepest at the main piers; the clip-on
 * box girders' haunches; rough concrete pier shafts under steel caps. Guessed: the depths under the deck.
 */

/** Origin of the bridge frame (game x, z) and its unit axes (game XZ). */
export const HB_ORIGIN = { x: -1379.44, z: -2162.7 } as const;
export const HB_DIR = [0.46779, -0.88384] as const;
export const HB_NRM = [0.88334, 0.46873] as const;

/** Abutments: the first pier − 80.8 m and the last pier + 176.9 m (Structurae spans). */
export const HB_S_SOUTH = -759.8;
export const HB_S_NORTH = 276.9;
/** Pier centres along s (OSM, on the pier line); footprints 13.1 m across × 6.8 m along. */
export const HB_PIERS: readonly number[] = [-679.0, -577.2, -459.2, -331.7, -141.4, 100.0];
/** The main (navigation) span's piers. */
export const HB_MAIN: readonly [number, number] = [-141.4, 100.0];
/** Half the deck's width (m): 13.4 m original deck + two 11 m clip-ons. */
export const HB_HALF_WIDTH = 17.6;
/** The two trusses' planes (t, m). */
export const HB_TRUSS_T = 7.5;

// deck grades (LiDAR, RMS 0.05 m) and the vertical curve between them
const G1 = 0.049974;
const C1 = 51.279;
const G2 = -0.050099;
const C2 = 47.766;
const LV = 248;
const SV = (C2 - C1) / (G1 - G2);
const SA = SV - LV / 2;
const SB = SV + LV / 2;

/** Road surface height (m above datum) at s. */
export function hbDeck(s: number): number {
  if (s <= SA) return C1 + G1 * s;
  if (s >= SB) return C2 + G2 * s;
  const d = s - SA;
  return C1 + G1 * SA + G1 * d + ((G2 - G1) / (2 * LV)) * d * d;
}

/** The through truss's top chord above the road (LiDAR p90 of both trusses, 12 m bins); −Infinity outside it. */
const CHORD: readonly (readonly [number, number])[] = [
  [-204, 41.1], [-196, 44.2], [-184, 48.6], [-172, 50.3], [-160, 52.5], [-148, 55.6], [-136, 58.0], [-124, 60.1], [-112, 61.4], [-100, 62.5],
  [-88, 63.2], [-76, 63.7], [-64, 64.1], [-52, 64.3], [-40, 64.35], [-28, 64.35], [-16, 64.2], [-4, 64.1], [8, 63.7], [20, 63.1], [32, 62.3],
  [44, 61.4], [56, 59.8], [68, 57.7], [80, 55.1], [92, 52.2], [104, 50.0], [116, 48.1], [124, 45.0], [130, 41.5],
];

export function hbChord(s: number): number {
  if (s <= CHORD[0][0] || s >= CHORD[CHORD.length - 1][0]) return -Infinity;
  for (let i = 1; i < CHORD.length; i++) {
    if (s <= CHORD[i][0]) {
      const [a, ya] = CHORD[i - 1];
      const [b, yb] = CHORD[i];
      return ya + ((yb - ya) * (s - a)) / (b - a);
    }
  }
  return -Infinity;
}

const dMain = (s: number) => Math.min(Math.abs(s - HB_MAIN[0]), Math.abs(s - HB_MAIN[1]));

/** Depth of the truss below the road (m; guessed from photos): 8 m on the approaches, 16 m at the main piers, 2.6 m mid-span. */
export function hbTrussDepth(s: number): number {
  if (s > HB_MAIN[0] && s < HB_MAIN[1]) {
    const k = Math.max(0, 1 - dMain(s) / 78);
    return 2.6 + 13.4 * k * k;
  }
  if (s <= HB_MAIN[0] && s >= HB_PIERS[3]) {
    const k = (s - HB_PIERS[3]) / (HB_MAIN[0] - HB_PIERS[3]);
    return 8 + 8 * k * k;
  }
  if (s >= HB_MAIN[1]) {
    const k = 1 - (s - HB_MAIN[1]) / (HB_S_NORTH - HB_MAIN[1]);
    return 8 + 8 * k * k;
  }
  return 8;
}

/** Depth of the clip-on box girders (m; guessed from photos): 3.4 m, haunched to 10 m at the main piers. */
export function hbClipDepth(s: number): number {
  const k = Math.max(0, 1 - dMain(s) / 70);
  let h = 3.4 + 6.6 * k * k;
  for (let i = 0; i < 4; i++) {
    const q = Math.max(0, 1 - Math.abs(s - HB_PIERS[i]) / 22);
    h += 1.4 * q * q;
  }
  return h;
}

/** Truss panel points along s: equal panels of about 15.25 m in every span (abutments and piers included). */
export function hbPanelNodes(): number[] {
  const sup = [HB_S_SOUTH, ...HB_PIERS, HB_S_NORTH];
  const nodes: number[] = [];
  for (let k = 0; k + 1 < sup.length; k++) {
    const a = sup[k];
    const b = sup[k + 1];
    const n = Math.max(1, Math.round((b - a) / 15.25));
    for (let i = 0; i < n; i++) nodes.push(a + ((b - a) * i) / n);
  }
  nodes.push(HB_S_NORTH);
  return nodes;
}

/** Sign gantries over the road (LiDAR: full-width objects 8–10 m over the deck). */
export const HB_GANTRIES: readonly number[] = [-706, -460, -159, 88];
/** The two flagpoles on the crest of the truss (LiDAR spike to 73.2 m). */
export const HB_FLAGS = { s: -36, top: 73.2 } as const;

/** Game XZ of the bridge-frame point (s, t). */
export function hbAt(s: number, t: number): [number, number] {
  return [HB_ORIGIN.x + HB_DIR[0] * s + HB_NRM[0] * t, HB_ORIGIN.z + HB_DIR[1] * s + HB_NRM[1] * t];
}

/** Bridge-frame (s, t) of a game XZ point. */
export function hbFrame(x: number, z: number): [number, number] {
  const dx = x - HB_ORIGIN.x;
  const dz = z - HB_ORIGIN.z;
  return [dx * HB_DIR[0] + dz * HB_DIR[1], dx * HB_NRM[0] + dz * HB_NRM[1]];
}

/** The bridge's supports along s: the two abutments and the six piers. Span i runs from HB_SUPPORTS[i] to HB_SUPPORTS[i + 1]. */
export const HB_SUPPORTS: readonly number[] = [HB_S_SOUTH, ...HB_PIERS, HB_S_NORTH];

/** A solid of the bridge for the sim (sim/buildings.ts): a footprint ring (game XZ) from y0 up to y1 (m above the datum). */
export interface HbSolid {
  ring: number[];
  y0: number;
  y1: number;
}

/**
 * The solids of span `i` (between HB_SUPPORTS[i] and [i + 1]) in ~16 m pieces: the deck from the bottom of its truss or
 * clip-on girders up to the parapets, and over the main spans the through truss from the road up to its top chord.
 * The water and the navigation clearance under the deck stay open (a jet can still fly under the bridge).
 */
export function hbSpanSolids(i: number): HbSolid[] {
  const a = HB_SUPPORTS[i];
  const b = HB_SUPPORTS[i + 1];
  const n = Math.max(1, Math.round((b - a) / 16));
  const out: HbSolid[] = [];
  const quad = (s0: number, s1: number, t: number) => [...hbAt(s0, -t), ...hbAt(s1, -t), ...hbAt(s1, t), ...hbAt(s0, t)];
  for (let k = 0; k < n; k++) {
    const s0 = a + ((b - a) * k) / n;
    const s1 = a + ((b - a) * (k + 1)) / n;
    const d0 = hbDeck(s0);
    const d1 = hbDeck(s1);
    const depth = Math.max(hbTrussDepth(s0), hbTrussDepth(s1), hbClipDepth(s0), hbClipDepth(s1));
    out.push({ ring: quad(s0, s1, HB_HALF_WIDTH), y0: Math.min(d0, d1) - depth, y1: Math.max(d0, d1) + 1.1 });
    const top = Math.max(hbChord(s0), hbChord(s1));
    if (top > Math.max(d0, d1) + 1.5) out.push({ ring: quad(s0, s1, HB_TRUSS_T + 0.6), y0: Math.min(d0, d1), y1: top + 0.5 });
  }
  return out;
}
