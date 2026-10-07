/**
 * Named superyachts of the Auckland waterfront (#145): Koru, Serene, A and Aquijo, each a VesselClass of its own
 * (`SuperyachtId`), so the sim's hull volume (VESSEL_DATA), the model (render/models/superyachts.ts), the ship motion
 * (SHIP_DIMS), the wakes and the sinking all follow the merchant ships' path with no new plumbing.
 *
 * The shape of each yacht is data here, built in code by the renderer: length and beam (builders' figures), the hull
 * colour, the bow, the superstructure tiers and, for the sailing yachts, the masts. Tier spans and mast stations were
 * read off the reference photos linked in the issue (Wikimedia Commons; deck counts aren't published).
 *
 * The berths are the real quays they have used (OpenStreetMap / the LINZ 2024 aerial): Koru on the east face of
 * Wynyard Wharf (29 Sep 2026), A on North Wharf at Silo Marina, Aquijo in the Viaduct. Serene sails the harbour.
 * This table is synchronous and always present (gameplay spawns them, the scenery keeps its marina yachts clear of the
 * berths); tests/civil-superyachts.test.ts checks the berths against the coastline and the OSM quays.
 */

export type SuperyachtId = 'koru' | 'serene' | 'a' | 'aquijo';

/** A superstructure tier: a box with a dark window band at its foot, its front rounded in plan. */
export interface YachtTier {
  /** Fore and aft ends: fractions of the length from the bow (0) to the stern (1). */
  from: number;
  to: number;
  /** Height (m). Tiers stack: each stands on the one listed before it, the first on the main deck. */
  h: number;
  /** Half-width as a share of the hull's half-width at the tier's middle. */
  w: number;
  /** Length (m) over which the front rounds in (0 = square). */
  round: number;
  /** Share of the height that is the dark window band at its foot. */
  band: number;
}

export interface YachtMast {
  /** Station along the hull: fraction of the length from the bow. */
  at: number;
  /** Mast top above the waterline (m). */
  top: number;
  /** Heights of the crosstrees above the waterline (m). */
  spreaders: number[];
  /** Boom length (m), 0 for none (a furled sail lies along it). */
  boom: number;
}

export interface SuperyachtSpec {
  id: SuperyachtId;
  /** As the HUD, the radio and the debrief name her. */
  name: string;
  builder: string;
  /** Length overall (m), as built: the hull's waterline-to-bow geometry fits inside it. */
  length: number;
  beam: number;
  /** Main deck height above the waterline (m). */
  freeboard: number;
  hull: number;
  /** Boot-top stripe at the waterline (null: none). */
  boot: number | null;
  /** Superstructure (and mast) colour, window bands, deck. */
  white: number;
  glass: number;
  deck: number;
  /**
   * Bow profile: how far (m) the deck's tip stands ahead of the forefoot at the waterline. > 0 a raked or clipper
   * bow (the deck overhangs), < 0 a reverse bow (A: the waterline reaches further forward than the deck).
   */
  bowRake: number;
  /** Top half-width of the hull over its half-width at the waterline (< 1: tumblehome, A's "stealth" hull). */
  tumble: number;
  tiers: YachtTier[];
  /** Sailing yachts: the rig. */
  masts: YachtMast[];
  /** Bowsprit beyond the deck's tip (m). */
  bowsprit: number;
  /** Motor yachts: the radar / dome mast (station from the bow, top above the waterline). */
  radar: { at: number; top: number } | null;
  /** Highest point above the waterline (m): the mast tops or the radar mast. */
  air: number;
  /** Top of the hull and superstructure (m): the sim's hit volume (masts aren't hit). */
  height: number;
}

const MAIN = (top: number, at: number, boom: number, spreaders: number[]): YachtMast => ({ at, top, boom, spreaders });

/**
 * The yachts (lengths and beams: the builders, via Wikipedia and superyacht registers; looks: the photos):
 * - Koru: Oceanco 2023, three-masted schooner. Black-navy hull with a red boot-top, a gilded figurehead under the long
 *   bowsprit, a low cream superstructure aft, three tall white masts with radar domes on the crosstrees.
 * - Serene: Fincantieri 2011. Dark navy hull with white waterline stripes, four rounded white tiers from a third of the
 *   way aft, a radar mast with domes.
 * - A: Blohm+Voss 2008 (Philippe Starck). All white (the Wynyard Quarter photo; the grey "stealth" yacht is the sailing
 *   yacht A), the reverse bow and the tumblehome hull, three tiers of long window bands set aft, a tall mast tower.
 * - Aquijo: Oceanco / Vitters 2016, the largest ketch. Dark navy hull, a low white superstructure, two tall masts.
 */
export const SUPERYACHTS: Record<SuperyachtId, SuperyachtSpec> = {
  koru: {
    id: 'koru',
    name: 'Koru',
    builder: 'Oceanco 2023',
    length: 127,
    beam: 15.5,
    freeboard: 7.5,
    hull: 0x111823,
    boot: 0xb3241c,
    white: 0xe9e1cf,
    glass: 0x2a3138,
    deck: 0xa88a62,
    bowRake: 7,
    tumble: 0.98,
    tiers: [
      { from: 0.45, to: 0.97, h: 3.6, w: 0.9, round: 4, band: 0.5 },
      { from: 0.53, to: 0.93, h: 3.2, w: 0.8, round: 5, band: 0.5 },
      { from: 0.62, to: 0.86, h: 2.4, w: 0.66, round: 4, band: 0.45 },
    ],
    masts: [MAIN(68, 0.27, 20, [28, 42, 56]), MAIN(70, 0.49, 22, [30, 44, 58]), MAIN(68, 0.71, 22, [28, 42, 56])],
    bowsprit: 16,
    radar: null,
    air: 70,
    height: 17,
  },
  serene: {
    id: 'serene',
    name: 'Serene',
    builder: 'Fincantieri 2011',
    length: 133.9,
    beam: 18.5,
    freeboard: 8,
    hull: 0x0f1b30,
    boot: 0xeef0ee,
    white: 0xf2f3f0,
    glass: 0x26323d,
    deck: 0xb39268,
    bowRake: 6,
    tumble: 0.97,
    tiers: [
      { from: 0.3, to: 0.97, h: 3.6, w: 0.97, round: 10, band: 0.35 },
      { from: 0.37, to: 0.92, h: 3.4, w: 0.9, round: 12, band: 0.4 },
      { from: 0.44, to: 0.84, h: 3.2, w: 0.8, round: 11, band: 0.42 },
      { from: 0.52, to: 0.72, h: 3.0, w: 0.64, round: 7, band: 0.45 },
    ],
    masts: [],
    bowsprit: 0,
    radar: { at: 0.62, top: 33 },
    air: 33,
    height: 22,
  },
  a: {
    id: 'a',
    name: 'A',
    builder: 'Blohm+Voss 2008',
    length: 119,
    beam: 18.9,
    freeboard: 6.5,
    hull: 0xeef0ee,
    boot: null,
    white: 0xf4f5f2,
    glass: 0x34506a,
    deck: 0xd8d8d2,
    bowRake: -9,
    tumble: 0.86,
    tiers: [
      { from: 0.38, to: 0.97, h: 3.6, w: 0.97, round: 12, band: 0.35 },
      { from: 0.48, to: 0.9, h: 3.4, w: 0.88, round: 14, band: 0.4 },
      { from: 0.62, to: 0.86, h: 3.4, w: 0.72, round: 9, band: 0.45 },
    ],
    masts: [],
    bowsprit: 0,
    radar: { at: 0.8, top: 32 },
    air: 32,
    height: 17,
  },
  aquijo: {
    id: 'aquijo',
    name: 'Aquijo',
    builder: 'Oceanco / Vitters 2016',
    length: 85.9,
    beam: 14.6,
    freeboard: 5,
    hull: 0x13233c,
    boot: 0x9fb7c8,
    white: 0xf0f1ee,
    glass: 0x28323c,
    deck: 0xa88a62,
    bowRake: 6,
    tumble: 0.97,
    tiers: [
      { from: 0.33, to: 0.82, h: 3, w: 0.84, round: 7, band: 0.5 },
      { from: 0.42, to: 0.7, h: 2.6, w: 0.62, round: 5, band: 0.5 },
    ],
    masts: [MAIN(88, 0.27, 22, [32, 50, 68]), MAIN(80, 0.62, 18, [30, 46, 62])],
    bowsprit: 3,
    radar: null,
    air: 88,
    height: 11,
  },
};

export const SUPERYACHT_IDS = Object.keys(SUPERYACHTS) as SuperyachtId[];

export function isSuperyachtId(v: string | null | undefined): v is SuperyachtId {
  return !!v && v in SUPERYACHTS;
}

export interface YachtBerth {
  yacht: SuperyachtId;
  /** Hull centre (world XZ, m). */
  x: number;
  z: number;
  /** Bow heading (deg, clockwise from north). */
  heading: number;
  /** Where she lies, for the tests and the docs. */
  quay: string;
}

/**
 * The berths: alongside the real quay faces, hull on the LINZ water and clear of the OSM wharves, its side within a few
 * metres of the quay (tests/civil-superyachts.test.ts). World XZ (origin the Sky Tower, +x east, +z south).
 */
export const SUPERYACHT_BERTHS: readonly YachtBerth[] = [
  { yacht: 'koru', x: -238, z: -1165, heading: 42.5, quay: 'Wynyard Wharf, east face' },
  { yacht: 'a', x: -783, z: -1070, heading: 18, quay: 'Silo Marina, the superyacht pontoons' },
  { yacht: 'aquijo', x: -254.5, z: -711.5, heading: 16.4, quay: 'Viaduct Harbour, west side' },
];

/** The yacht that sails the harbour (when one does). */
export const UNDERWAY_YACHT: SuperyachtId = 'serene';

/**
 * Inside a berthed superyacht's hull rectangle grown by `margin` m (bowsprit included)? The scenery keeps its marina
 * yachts out of it.
 */
export function inSuperyachtBerth(x: number, z: number, margin = 0): boolean {
  for (const b of SUPERYACHT_BERTHS) {
    const y = SUPERYACHTS[b.yacht];
    const h = (b.heading * Math.PI) / 180;
    const fx = Math.sin(h);
    const fz = -Math.cos(h);
    const dx = x - b.x;
    const dz = z - b.z;
    const along = dx * fx + dz * fz;
    const across = -dx * fz + dz * fx;
    if (along > -y.length / 2 - margin && along < y.length / 2 + y.bowsprit + margin && Math.abs(across) < y.beam / 2 + margin) return true;
  }
  return false;
}
