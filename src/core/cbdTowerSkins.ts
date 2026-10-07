/**
 * F35-A — skins for the CBD tower kit's best-known towers: the facade each side really has, the way Spark Arena's is
 * built (core/sparkArena.ts): zones of colour and material by height and by face (crown bands, full-height glass
 * strips, white pilasters, one facade on the harbour face and another on the rest), the bracing that shows on a face,
 * and the signs on the crowns. A tower without a skin keeps the kit's one wall colour and one window style.
 *
 * Read off Auckland Council's 2023 textured 3D mesh ("Auckland CBD to Airport 3D Mesh", zone 1A, 6 cm texture; CC BY
 * 4.0): every side of each tower as an orthographic elevation in the frame of its shaft's box (face-aligned, 0.2 m a
 * pixel, a 5 m grid), positions by eye to about ±1 m, colours the median of each zone (white-balanced as
 * cbd_towers_colours.py does). The mesh's heights are its own: `dy` moves them onto the LiDAR heights the kit uses,
 * matched at the main roof. Signs are drawn as text with a simple stand-in mark (towerSkins.ts), not the logo files.
 */

/** Wall finish of a zone: the kit's facades (cbdTowers.ts) plus `glow` (a lit panel at night), `none` (plain),
 * `stone` (dressed stone with punched windows, floodlit at night: the Chief Post Office) and `dark` (curtain glass with
 * no floor lit at night: an empty tower). */
export type SkinFinish = 'glass' | 'bands' | 'punched' | 'plain' | 'glow' | 'none' | 'stone' | 'dark';

/** The signs drawn in the logo atlas (world/scenery/towerLogos.ts). */
export type SkinLogo = 'hsbc' | 'anz' | 'vero' | 'pwc' | 'qbe' | 'waitemata' | 'voco' | 'hiexpress' | 'quaywest' | 'sap' | 'aon' | 'huawei' | 'deloitte' | 'rydges' | 'skycity' | 'aa' | 'aut' | 'jarden' | 'nzx' | 'so';

/** A painted zone of the walls. Later zones win. */
export interface SkinZone {
  /** The face it is on: the compass heading its outside faces (deg), snapped to the box's nearest face; omitted: all. */
  face?: number;
  /** Across the face (m from the box's centre line, positive to the right as seen from outside); omitted: all of it. */
  t?: readonly [number, number];
  /** Heights above the ground (mesh m; + dy in the game); Infinity: up to the roof. */
  h: readonly [number, number];
  colour: number;
  finish: SkinFinish;
}

/** Diagonal bracing over a face: two zigzags meeting at the face's edges every `module` m (an X per module). */
export interface SkinBrace {
  face: number;
  t: readonly [number, number];
  h: readonly [number, number];
  /** A height (mesh m) where the zigzags meet at the braced band's edges. */
  node: number;
  module: number;
  colour: number;
  /** Member width (m). */
  width: number;
  /** No vertical member where the X's cross (a diagrid). */
  noMullion?: boolean;
}

/** A drawn line on a face (a white edge trim, a frame): a polyline of (t, h) points in mesh m, as beams on the wall. */
export interface SkinLine {
  face: number;
  /** t0, h0, t1, h1, … */
  pts: readonly number[];
  colour: number;
  /** Width (m). */
  width: number;
}

/** A sign on a face, its middle at (t, h); its height follows the logo's aspect. */
export interface SkinSign {
  face: number;
  t: number;
  h: number;
  /** Width (m). */
  w: number;
  logo: SkinLogo;
}

export interface TowerSkin {
  /** CBD_TOWERS row. */
  n: number;
  /** The shaft's box (the rectangle round its upper terraces at its edges' main direction): centre (game m) and the
   * heading one face looks out to (deg). */
  box: { readonly x: number; readonly z: number; readonly face: number };
  /** Mesh height + dy = height over the kit's ground (m). */
  dy: number;
  zones: readonly SkinZone[];
  braces?: readonly SkinBrace[];
  lines?: readonly SkinLine[];
  signs?: readonly SkinSign[];
  /** The crown terrace's own walls above the shaft (the kit's crown colour otherwise). */
  crown?: { readonly colour: number; readonly finish: SkinFinish };
}

const ALL = [0, Infinity] as const;

export const CBD_TOWER_SKINS: readonly TowerSkin[] = [
  {
    // white precast spandrels over ribbon windows, a full-height strip of dark glass up each face (two on the
    // south-west face), a white crown band with the hexagon sign on every face; the mast is the kit's spire. #213:
    // Mapillary (2022–25) confirms the bands and strips; a night photo of the crown shows the band dark (not
    // floodlit) under the lit sign, its letters glowing white
    n: 11,
    box: { x: 273.71, z: -568.64, face: 17 },
    dy: 11.8,
    zones: [
      { h: [0, 87], colour: 0xe4e2da, finish: 'bands' },
      { h: [87, Infinity], colour: 0xecebe6, finish: 'none' },
      { face: 17, t: [-5, 3.5], h: [0, 87], colour: 0x3b4656, finish: 'glass' },
      { face: 107, t: [-11, -3.5], h: [0, 87], colour: 0x3b4656, finish: 'glass' },
      { face: 197, t: [-14, -9.5], h: [0, 87], colour: 0x3b4656, finish: 'glass' },
      { face: 197, t: [13.5, 18], h: [0, 87], colour: 0x3b4656, finish: 'glass' },
      { face: 287, t: [2, 9.5], h: [0, 87], colour: 0x3b4656, finish: 'glass' },
    ],
    signs: [
      { face: 17, t: -0.5, h: 93, w: 14.5, logo: 'hsbc' },
      { face: 107, t: -5, h: 93, w: 13, logo: 'hsbc' },
      { face: 197, t: -12, h: 93, w: 10, logo: 'hsbc' },
      { face: 197, t: 14.5, h: 93, w: 10, logo: 'hsbc' },
      { face: 287, t: 7, h: 93, w: 12, logo: 'hsbc' },
    ],
  },
  {
    // warm beige precast bands, the bright blue crown box (lit at night) with white letters on every face, and the
    // grey lattice dome over it (the kit's crown terrace). #213: Mapillary (2025) and 2024 photos show the walls a
    // rosier granite beige than the mesh's haze, with dark blue glass between
    n: 7,
    box: { x: 192.18, z: -316.07, face: 19 },
    dy: -2.4,
    zones: [
      { h: [0, 130], colour: 0xcbb4a4, finish: 'bands' },
      { h: [130, 138], colour: 0x2a8fd6, finish: 'glow' },
      { h: [138, Infinity], colour: 0x7d8288, finish: 'none' },
    ],
    crown: { colour: 0x7d8288, finish: 'none' },
    signs: [
      { face: 19, t: 4, h: 133.5, w: 14, logo: 'anz' },
      { face: 109, t: 1.6, h: 133.5, w: 13, logo: 'anz' },
      { face: 199, t: -1, h: 133.5, w: 14, logo: 'anz' },
      { face: 289, t: 6, h: 133.5, w: 13, logo: 'anz' },
    ],
  },
  {
    // a white square grid over dark glass on the south and west, glass with white mullions on the north and east,
    // the red letters under the white sail crown on every face (the sail and its mast are the kit's). #213: Mapillary
    // (2024–25) shows the pale podium; a night photo has the sail lit white and the letters glowing red
    n: 4,
    box: { x: 549.42, z: -207.12, face: 10 },
    dy: 11.8,
    zones: [
      { face: 10, h: [0, 137], colour: 0x8a929c, finish: 'glass' },
      { face: 100, h: [0, 137], colour: 0x8a929c, finish: 'glass' },
      { face: 190, h: [0, 137], colour: 0xe2e6ea, finish: 'punched' },
      { face: 280, h: [0, 137], colour: 0xe2e6ea, finish: 'punched' },
    ],
    signs: [
      { face: 10, t: -12, h: 132.5, w: 11, logo: 'vero' },
      { face: 100, t: 7.3, h: 132.5, w: 11, logo: 'vero' },
      { face: 190, t: -9, h: 132.5, w: 13, logo: 'vero' },
      { face: 280, t: -0.2, h: 132.5, w: 14, logo: 'vero' },
    ],
  },
  {
    // dark blue glass; the harbour face (north) in pale sunshade bands under its white glass crown screen with the
    // big sign; white X bracing up the east and west faces; small signs at the top of the other faces. #213: Mapillary
    // (2022) confirms the bracing; the crown screen is an LED wall that changes colour (1News, 2021), the kit's lit
    // crown; the letters glow white at night
    n: 3,
    box: { x: 333.29, z: -488.59, face: 19 },
    dy: 2,
    zones: [
      { h: ALL, colour: 0x4d5a78, finish: 'glass' },
      { face: 19, h: [0, 140], colour: 0xc4c8c4, finish: 'bands' },
      { face: 19, h: [140, Infinity], colour: 0xc9d3dc, finish: 'glass' },
    ],
    braces: [
      { face: 109, t: [-8, 20], h: [10, 146], node: 33, module: 48, colour: 0xd9dde0, width: 0.9 },
      { face: 289, t: [-20.6, 7.4], h: [10, 146], node: 38, module: 50, colour: 0xd9dde0, width: 0.9 },
    ],
    signs: [
      { face: 19, t: 9.5, h: 148, w: 12, logo: 'pwc' },
      { face: 109, t: -15.7, h: 146, w: 5, logo: 'pwc' },
      { face: 199, t: -11, h: 146, w: 5, logo: 'pwc' },
      { face: 289, t: 16, h: 146, w: 6, logo: 'pwc' },
    ],
  },
  {
    // dark glass between four white pilasters a face, a dark crown with the sign on the east and west. #213: a 2016
    // photo from the Sky Tower shows the white letters by the blue disc on the west face; Mapillary (2025) the glass
    n: 14,
    box: { x: 308.13, z: -222.32, face: 17 },
    dy: 0,
    zones: [
      { h: [0, 91], colour: 0x4a5171, finish: 'glass' },
      { t: [-17, -15.5], h: [0, 91], colour: 0xd6d8d9, finish: 'none' },
      { t: [-8.75, -7.25], h: [0, 91], colour: 0xd6d8d9, finish: 'none' },
      { t: [4, 5.5], h: [0, 91], colour: 0xd6d8d9, finish: 'none' },
      { t: [13.75, 15.25], h: [0, 91], colour: 0xd6d8d9, finish: 'none' },
      { h: [91, Infinity], colour: 0x444a5e, finish: 'glass' },
    ],
    signs: [
      { face: 107, t: -1, h: 100, w: 9, logo: 'qbe' },
      { face: 287, t: -0.9, h: 100, w: 9, logo: 'qbe' },
    ],
  },
  {
    // the Chief Post Office (Britomart station's main entrance): a rusticated Coromandel granite ground storey with its
    // arched windows, Oamaru stone above, the main cornice at 18 m, lead-grey domes on the west corner pavilions
    // (britomart.ts adds the domes themselves over the kit's stepped crown terraces). Heights from the LiDAR point
    // cloud (slabs at 7.3, 12.4, 17.0, 20.2 and 23.3 m; 3.9 m storeys); colours from a daylight photo of the Queen St
    // front, since the 2023 mesh has that face in shade
    n: 202,
    box: { x: 463.46, z: -489.56, face: 17 },
    dy: 0,
    zones: [
      { h: [0, 7.2], colour: 0x86827b, finish: 'stone' },
      { h: [7.2, 18], colour: 0xd6d0c2, finish: 'stone' },
      { h: [18, 19], colour: 0xe6e1d5, finish: 'plain' },
      { h: [19, Infinity], colour: 0xd6d0c2, finish: 'stone' },
    ],
    crown: { colour: 0xc6c2b8, finish: 'plain' },
  },
  {
    // the Glasshouse (Britomart station's east entrance): blue-grey glass behind silver vertical fins on every face,
    // the "Waitematā" sign over the canopy on the Commerce St plaza (the east face); Mapillary and a 2025 photo
    n: 206,
    box: { x: 493.68, z: -479.15, face: 17 },
    dy: 0,
    zones: [{ h: ALL, colour: 0xbac6cc, finish: 'glass' }],
    signs: [{ face: 107, t: 0, h: 6, w: 8, logo: 'waitemata' }],
  },
  // ── #213 Tier A, group 1: the Britomart east end ──
  {
    // Seascape: topped out in 2024 and empty since work stopped (a buyer in 2026): dark grey glass up to about
    // two-thirds, bare slab edges above, the white lattice mega-brace up both narrow faces and its edges, the kit's
    // wedge crown. No lit floor at night. Heights from a March 2026 photo (the 2023 mesh has it at 145 m, half built)
    n: 1,
    box: { x: 633.04, z: -319.28, face: 23 },
    dy: 0,
    zones: [
      { h: [0, 122], colour: 0x3f4852, finish: 'dark' },
      { h: [122, Infinity], colour: 0x8e9196, finish: 'none' },
    ],
    braces: [
      { face: 113, t: [-7, 1.5], h: [6, 176], node: 10, module: 22, colour: 0xe6e7e4, width: 0.9, noMullion: true },
      { face: 113, t: [1.5, 10.5], h: [6, 176], node: 10, module: 22, colour: 0xe6e7e4, width: 0.9, noMullion: true },
      { face: 293, t: [-11, 0.5], h: [6, 176], node: 10, module: 22, colour: 0xe6e7e4, width: 0.9, noMullion: true },
      { face: 293, t: [0.5, 12], h: [6, 176], node: 10, module: 22, colour: 0xe6e7e4, width: 0.9, noMullion: true },
    ],
    lines: [
      { face: 113, pts: [-7, 4, -7, 186], colour: 0xe6e7e4, width: 0.9 },
      { face: 113, pts: [10.5, 4, 10.5, 186], colour: 0xe6e7e4, width: 0.9 },
      { face: 293, pts: [-11, 4, -11, 186], colour: 0xe6e7e4, width: 0.9 },
      { face: 293, pts: [12, 4, 12, 186], colour: 0xe6e7e4, width: 0.9 },
    ],
  },
  {
    // The Pacifica: blue glass, darker below, paler towards the top; the white trim lines of its "twist" (the pikorua):
    // two verticals up the middle of each face from 70 m, a level line out to the corner, three parallel diagonals
    // across the lower half; the core strip between the verticals in grey balcony bands
    n: 2,
    box: { x: 520.06, z: -317.6, face: 17 },
    dy: 14,
    zones: [
      { h: [0, 70], colour: 0x3e4a66, finish: 'glass' },
      { h: [70, Infinity], colour: 0x4f6382, finish: 'glass' },
      { face: 17, h: [70, Infinity], colour: 0x5f7787, finish: 'glass' },
      { face: 17, t: [-3.5, 2.5], h: [70, 158], colour: 0x939596, finish: 'bands' },
      { face: 197, t: [-3.4, 3.2], h: [70, 158], colour: 0x6e7380, finish: 'bands' },
      { face: 107, t: [-6, -2.4], h: [70, 158], colour: 0x6e7380, finish: 'bands' },
      { face: 287, t: [-2.8, 1.2], h: [70, 158], colour: 0x6e7380, finish: 'bands' },
      { h: [158, Infinity], colour: 0xa6aa9e, finish: 'glass' },
    ],
    lines: [
      { face: 17, pts: [-3.5, 160, -3.5, 68], colour: 0xeef0ef, width: 0.8 },
      { face: 17, pts: [2.5, 160, 2.5, 71, 16.5, 71], colour: 0xeef0ef, width: 0.8 },
      { face: 17, pts: [-16.5, 69, 16.5, 48], colour: 0xeef0ef, width: 0.8 },
      { face: 17, pts: [-16.5, 51, 16.5, 29], colour: 0xeef0ef, width: 0.8 },
      { face: 17, pts: [-16.5, 37, 3, 13], colour: 0xeef0ef, width: 0.8 },
      { face: 197, pts: [-3.4, 160, -3.4, 68], colour: 0xeef0ef, width: 0.8 },
      { face: 197, pts: [3.2, 160, 3.2, 70, 16.5, 70], colour: 0xeef0ef, width: 0.8 },
      { face: 197, pts: [-16.5, 70, 16.5, 49], colour: 0xeef0ef, width: 0.8 },
      { face: 197, pts: [-16.5, 52, 16.5, 30], colour: 0xeef0ef, width: 0.8 },
      { face: 197, pts: [-16.5, 37, 4, 13], colour: 0xeef0ef, width: 0.8 },
      { face: 107, pts: [-6, 160, -6, 70], colour: 0xeef0ef, width: 0.8 },
      { face: 107, pts: [-2.4, 160, -2.4, 70, 12.3, 70], colour: 0xeef0ef, width: 0.8 },
      { face: 107, pts: [-12.3, 69, 12.3, 46], colour: 0xeef0ef, width: 0.8 },
      { face: 107, pts: [-12.3, 51, 12.3, 28], colour: 0xeef0ef, width: 0.8 },
      { face: 107, pts: [-12.3, 37, 6, 13], colour: 0xeef0ef, width: 0.8 },
      { face: 287, pts: [-2.8, 160, -2.8, 70], colour: 0xeef0ef, width: 0.8 },
      { face: 287, pts: [1.2, 160, 1.2, 71, 12.3, 71], colour: 0xeef0ef, width: 0.8 },
      { face: 287, pts: [-12.3, 69, 12.3, 52], colour: 0xeef0ef, width: 0.8 },
      { face: 287, pts: [-12.3, 52, 12.3, 36], colour: 0xeef0ef, width: 0.8 },
      { face: 287, pts: [-12.3, 38, 10, 15], colour: 0xeef0ef, width: 0.8 },
    ],
  },
  {
    // Auckland Harbour Suites: pale precast with punched windows on the long east and west faces, a column of dark
    // glass and balconies up the middle of the narrow north and south faces, a plain white parapet
    n: 9,
    box: { x: 597.15, z: -284.16, face: 18 },
    dy: 1.5,
    zones: [
      { h: [0, 120], colour: 0xd8d6cf, finish: 'punched' },
      { face: 18, t: [-8, 5], h: [0, 120], colour: 0x4c5568, finish: 'glass' },
      { face: 198, t: [-4, 7], h: [0, 120], colour: 0x4c5568, finish: 'glass' },
      { h: [120, Infinity], colour: 0xdedcd6, finish: 'none' },
    ],
  },
  // ── #213 Tier A, group 2: Albert Street ──
  {
    // 51 Albert (Hotel Indigo): dark navy glass over the restored 1912 facade (the kit's podium); finished in 2024, so
    // the 2023 mesh has only its lower 100 m: the rest from Mapillary (July 2025) and the mesh's lower floors
    n: 5,
    box: { x: 165.33, z: -231.35, face: 19 },
    dy: 0,
    zones: [
      { h: ALL, colour: 0x3a4560, finish: 'glass' },
      { face: 19, h: ALL, colour: 0x445069, finish: 'glass' },
    ],
  },
  {
    // voco and the Holiday Inn Express: two stacked volumes. Pale grey panels (blank) up the middle of the north,
    // east and west faces with glass at their edges, a full window grid on the south face, a column of windows up the
    // upper volume's north face; the "voco" name at the top of the east and west faces and the green Holiday Inn
    // Express panels round the north corners at the step
    n: 6,
    box: { x: 221.46, z: -181.11, face: 19 },
    dy: 1.5,
    zones: [
      { h: ALL, colour: 0x7f8694, finish: 'glass' },
      { face: 19, h: ALL, colour: 0xd4d5d1, finish: 'none' },
      { face: 19, t: [-14, -6], h: [72, 134], colour: 0x6f7888, finish: 'glass' },
      { face: 109, t: [-8, 5], h: ALL, colour: 0xd4d5d1, finish: 'none' },
      { face: 289, t: [-7, 8], h: ALL, colour: 0xd4d5d1, finish: 'none' },
    ],
    signs: [
      { face: 109, t: 1, h: 131.5, w: 7, logo: 'voco' },
      { face: 289, t: -2, h: 131.5, w: 7, logo: 'voco' },
      { face: 19, t: 12.5, h: 69, w: 4, logo: 'hiexpress' },
      { face: 109, t: -9.5, h: 69, w: 4, logo: 'hiexpress' },
      { face: 289, t: 9.5, h: 69, w: 4, logo: 'hiexpress' },
    ],
  },
  {
    // Park Residences: dark bronze glass on a dark frame grid, the red line full height up the middle of the west face
    // (and part of the east), the red roof frame; white balcony edges up the south face
    n: 13,
    box: { x: 180.11, z: -271.82, face: 20 },
    dy: 3.5,
    zones: [
      { h: ALL, colour: 0x45463c, finish: 'glass' },
      { face: 200, t: [-4, 6], h: [55, 98], colour: 0x8a8c88, finish: 'bands' },
      { h: [98, Infinity], colour: 0xc2402c, finish: 'none' },
    ],
    lines: [
      { face: 290, pts: [-1, 2, -1, 99], colour: 0xd23a22, width: 0.7 },
      { face: 110, pts: [-2, 48, -2, 99], colour: 0xd23a22, width: 0.7 },
    ],
  },
  // ── #213 Tier A, group 3: Metropolis, the Council tower, Quay West ──
  {
    // Metropolis: cream precast round balcony bands over blue-grey glass, a ring of round windows under the crown, the
    // lead-grey dome (the kit's crown terraces) and its spire (the kit's)
    n: 8,
    box: { x: 410.18, z: -29.32, face: 10 },
    dy: 0,
    zones: [
      { h: [0, 106], colour: 0xe0d6c4, finish: 'bands' },
      { h: [106, 120], colour: 0xe6dfd0, finish: 'punched' },
      { h: [120, Infinity], colour: 0x4d525c, finish: 'none' },
    ],
    crown: { colour: 0x4d525c, finish: 'none' },
  },
  {
    // the Auckland Council tower (the old ASB Bank Centre): navy glass between pale vertical strips at the corners and
    // a ladder of pale spandrels up the middle of the north and south faces, pale louvre bands across the east face,
    // a pale parapet
    n: 10,
    box: { x: 22.88, z: 157.52, face: 84 },
    dy: -2,
    zones: [
      { h: ALL, colour: 0x3d4a6c, finish: 'glass' },
      { face: 84, t: [-18, 5], h: [15, 100], colour: 0x8e8a8d, finish: 'bands' },
      { face: 84, t: [-14, -12.5], h: [0, 106], colour: 0x9aa1ad, finish: 'none' },
      { face: 84, t: [12, 13.5], h: [0, 106], colour: 0x9aa1ad, finish: 'none' },
      { face: 174, t: [-16.5, -15], h: [0, 106], colour: 0x9aa1ad, finish: 'none' },
      { face: 174, t: [-2, 2], h: [0, 106], colour: 0x8f97a6, finish: 'bands' },
      { face: 174, t: [15, 16.5], h: [0, 106], colour: 0x9aa1ad, finish: 'none' },
      { face: 264, t: [-14.5, -12.5], h: [0, 106], colour: 0x9aa1ad, finish: 'none' },
      { face: 264, t: [12.5, 14.5], h: [0, 106], colour: 0x9aa1ad, finish: 'none' },
      { face: 354, t: [-16, -14.5], h: [0, 106], colour: 0x9aa1ad, finish: 'none' },
      { face: 354, t: [-1, 1], h: [0, 106], colour: 0x8f97a6, finish: 'bands' },
      { face: 354, t: [14.5, 16], h: [0, 106], colour: 0x9aa1ad, finish: 'none' },
      { h: [106, Infinity], colour: 0xa3aebb, finish: 'none' },
    ],
  },
  {
    // Quay West: sand precast balcony bands, white over the top floors, the white wave crown with the red serif name
    // on its north and south faces
    n: 12,
    box: { x: 291.07, z: -396.45, face: 18 },
    dy: 0,
    zones: [
      { h: [0, 86], colour: 0xd6c8ab, finish: 'bands' },
      { h: [86, 104], colour: 0xeeebe2, finish: 'bands' },
      { h: [104, Infinity], colour: 0xf2f0ea, finish: 'none' },
    ],
    signs: [
      { face: 18, t: -1, h: 107.5, w: 13, logo: 'quaywest' },
      { face: 198, t: -4, h: 107.5, w: 13, logo: 'quaywest' },
    ],
  },
  // ── #213 Tier B, batch 1 (rows 15–25): mesh elevations, one Mapillary sheet, signs from photos ──
  {
    // 205 Queen: twin shafts of dark blue glass, a paler glass crown over the top floors
    n: 15,
    box: { x: 220.02, z: 84.49, face: 84 },
    dy: 0,
    zones: [
      { h: ALL, colour: 0x3f4a68, finish: 'glass' },
      { h: [92, Infinity], colour: 0x7f8ea6, finish: 'glass' },
    ],
  },
  {
    // the SAP Tower: dark glass, slender pale fins up the long north face, a louvred crown band; the SAP panel at the
    // top of the west face (the Sky Tower photo)
    n: 16,
    box: { x: 289.58, z: -158.13, face: 18 },
    dy: 0,
    zones: [
      { h: ALL, colour: 0x3f476b, finish: 'glass' },
      { h: [86, Infinity], colour: 0x6b6470, finish: 'bands' },
    ],
    lines: [-20, -12, -6, 7, 13, 19].map((t) => ({ face: 18, pts: [t, 28, t, 86], colour: 0xd8d0c8, width: 0.6 })),
    signs: [{ face: 288, t: 4, h: 94, w: 7, logo: 'sap' }],
  },
  {
    // Shortland & Fort (88 Shortland St): blue glass crossed by one long white diagonal on each face, from a low
    // corner to the top of the middle, under a pale band and a dark parapet
    n: 17,
    box: { x: 671.34, z: -223.07, face: 60 },
    dy: 0,
    zones: [
      { h: ALL, colour: 0x3e6286, finish: 'glass' },
      { face: 60, h: ALL, colour: 0x5b8fa3, finish: 'glass' },
      { h: [80, 89], colour: 0xa4acb5, finish: 'bands' },
      { h: [89, Infinity], colour: 0x34445e, finish: 'glass' },
    ],
    lines: [
      { face: 60, pts: [-10.5, 17, -0.5, 89, 22, 89], colour: 0xe8eaea, width: 0.8 },
      { face: 150, pts: [8, 13, -4, 89], colour: 0xe8eaea, width: 0.8 },
      { face: 240, pts: [-11, 17, 1, 89], colour: 0xe8eaea, width: 0.8 },
      { face: 330, pts: [9, 23, -5, 89], colour: 0xe8eaea, width: 0.8 },
    ],
  },
  {
    // Precinct Apartments: white balcony bands, a grey core strip up the south face
    n: 18,
    box: { x: 353.81, z: 144.97, face: 14 },
    dy: 0,
    zones: [
      { h: ALL, colour: 0xe2e1dc, finish: 'bands' },
      { face: 194, h: [25, Infinity], colour: 0x9aa0ad, finish: 'bands' },
      { face: 194, t: [0, 5], h: [25, 95], colour: 0xbdc0c8, finish: 'none' },
    ],
  },
  {
    // the Aon Centre: dark glass on pale mullions, a pale strip up the north face, the silver AON on every face
    n: 19,
    box: { x: 249.96, z: -519.84, face: 19 },
    dy: 3,
    zones: [
      { h: ALL, colour: 0x444f72, finish: 'glass' },
      { face: 19, t: [-16, -10], h: [10, 80], colour: 0xb9bcc3, finish: 'bands' },
    ],
    signs: [
      { face: 19, t: -2, h: 83, w: 9, logo: 'aon' },
      { face: 109, t: 0, h: 83, w: 9, logo: 'aon' },
      { face: 199, t: 2, h: 83, w: 9, logo: 'aon' },
      { face: 289, t: 0, h: 83, w: 9, logo: 'aon' },
    ],
  },
  {
    // the Crombie Lockwood Tower (191 Queen St): a white precast grid over dark windows, a dark glass crown box, a
    // full-height dark glass strip up the middle of the south face (its sign isn't legible in the mesh: none)
    n: 20,
    box: { x: 257.9, z: 7.94, face: 21 },
    dy: 1.5,
    zones: [
      { h: ALL, colour: 0xd8dadb, finish: 'punched' },
      { face: 201, t: [-6, 6], h: [55, Infinity], colour: 0x475a7b, finish: 'glass' },
      { h: [78, Infinity], colour: 0x475a7b, finish: 'glass' },
    ],
  },
  {
    // the Huawei Centre: warm beige precast with dark window bands, a glass rooftop box, the red petal and name at
    // the top of the north, east and west faces
    n: 21,
    box: { x: 128.17, z: 108.34, face: 19 },
    dy: 0.5,
    zones: [
      { h: ALL, colour: 0xd6c9b4, finish: 'bands' },
      { face: 199, h: ALL, colour: 0xa69c94, finish: 'bands' },
      { h: [88, Infinity], colour: 0xb7c3d0, finish: 'glass' },
    ],
    signs: [
      { face: 19, t: -4, h: 85.5, w: 9, logo: 'huawei' },
      { face: 109, t: -3, h: 85.5, w: 8, logo: 'huawei' },
      { face: 289, t: -2, h: 85.5, w: 8, logo: 'huawei' },
    ],
  },
  {
    // Campbell House: white balcony bands, a column of coloured balcony panels up the north face
    n: 22,
    box: { x: 282.51, z: 415.26, face: 82 },
    dy: -3,
    zones: [
      { h: ALL, colour: 0xdcdedf, finish: 'bands' },
      { face: 352, t: [0, 3], h: [5, 50], colour: 0xe0a84c, finish: 'none' },
    ],
  },
  {
    // 80 Queen St: dark blue glass, the Deloitte name at the top of the north and south faces (Deloitte's offices
    // until 2024, still on the crown in the 2023 mesh)
    n: 23,
    box: { x: 391.55, z: -257.56, face: 16 },
    dy: -1,
    zones: [
      { h: ALL, colour: 0x354563, finish: 'glass' },
      { face: 16, h: ALL, colour: 0x506a80, finish: 'glass' },
    ],
    signs: [
      { face: 16, t: 7, h: 84, w: 14, logo: 'deloitte' },
      { face: 196, t: -8, h: 84, w: 14, logo: 'deloitte' },
    ],
  },
  {
    // CityLife: cream walls with punched windows over a dark glass base, the dark glass crown of arched windows
    n: 24,
    box: { x: 244.2, z: -75.39, face: 16 },
    dy: 0,
    zones: [
      { h: ALL, colour: 0xd6d0c4, finish: 'punched' },
      { h: [0, 20], colour: 0x4b5670, finish: 'glass' },
      { h: [70, Infinity], colour: 0x56607a, finish: 'glass' },
    ],
  },
  {
    // Victoria Residences: a white balcony grid on dark glass, a blank pale party wall on the east
    n: 25,
    box: { x: 62.55, z: -44.89, face: 19 },
    dy: 0,
    zones: [
      { h: ALL, colour: 0xd9dade, finish: 'bands' },
      { face: 109, t: [-10, 10], h: [20, 76], colour: 0xbfc2c9, finish: 'none' },
    ],
  },
  // ── #213 Tier B, batch 2 (rows 26–36) ──
  {
    // the AIG Building: dark glass bays between pale pilasters on the long faces; pale narrow ends, each with two
    // slots of dark glass
    n: 26,
    box: { x: 494.78, z: -121.6, face: 9 },
    dy: 3.4,
    zones: [
      { h: ALL, colour: 0x2f3c60, finish: 'glass' },
      ...[-14, -7, 0, 7, 14].flatMap((t) => [
        { face: 9, t: [t - 0.8, t + 0.8] as const, h: [0, 76] as const, colour: 0xaab0be, finish: 'none' as const },
        { face: 189, t: [t - 0.8, t + 0.8] as const, h: [0, 76] as const, colour: 0xaab0be, finish: 'none' as const },
      ]),
      { face: 99, colour: 0xbcc0ca, h: ALL, finish: 'none' },
      { face: 279, colour: 0xbcc0ca, h: ALL, finish: 'none' },
      { face: 99, t: [-3.5, -1], h: [5, 73], colour: 0x2f3c60, finish: 'glass' },
      { face: 99, t: [1, 3.5], h: [5, 73], colour: 0x2f3c60, finish: 'glass' },
      { face: 279, t: [-3.5, -1], h: [5, 73], colour: 0x2f3c60, finish: 'glass' },
      { face: 279, t: [1, 3.5], h: [5, 73], colour: 0x2f3c60, finish: 'glass' },
    ],
  },
  {
    // the Crowne Plaza: pale punched walls over the car-park podium, a stack of dark windows up the north end
    n: 27,
    box: { x: 91.48, z: 143.8, face: 20 },
    dy: 0,
    zones: [
      { h: ALL, colour: 0xd5d2cb, finish: 'punched' },
      { face: 20, t: [-10, -1], h: [30, 78], colour: 0x4b5570, finish: 'glass' },
    ],
  },
  {
    // the Deloitte Centre (1 Queen St): dark blue glass over a lighter grid base, the Deloitte name at the top of the
    // long faces
    n: 28,
    box: { x: 382.02, z: -565.64, face: 18 },
    dy: 5,
    zones: [
      { h: ALL, colour: 0x37466a, finish: 'glass' },
      { h: [0, 34], colour: 0x6f7890, finish: 'glass' },
    ],
    signs: [
      { face: 18, t: -21, h: 66, w: 12, logo: 'deloitte' },
      { face: 198, t: 17, h: 66, w: 12, logo: 'deloitte' },
    ],
  },
  {
    // Chorus House: salmon precast with punched windows, a full-height slot of dark glass up the north face under an
    // arch; Rydges' pale glass block to the east and west with its name at the top
    n: 29,
    box: { x: 45.67, z: -166.22, face: 20 },
    dy: 0,
    zones: [
      { h: ALL, colour: 0xc9a59c, finish: 'punched' },
      { face: 20, t: [-4, 4], h: [25, 73], colour: 0x3d4560, finish: 'glass' },
      { face: 110, t: [-35, -14], h: [0, 60], colour: 0xa8b0bf, finish: 'glass' },
      { face: 290, t: [14, 35], h: [0, 60], colour: 0xa8b0bf, finish: 'glass' },
      { face: 200, t: [-5, 25], h: [0, 58], colour: 0xa8b0bf, finish: 'glass' },
      { h: [73, Infinity], colour: 0xc9a59c, finish: 'none' },
    ],
    signs: [
      { face: 110, t: -27, h: 57.5, w: 9, logo: 'rydges' },
      { face: 290, t: 22, h: 57, w: 9, logo: 'rydges' },
    ],
  },
  {
    // the SkyCity Grand Hotel: a grid of windows with salmon balcony bands on the east, pale blank narrow ends, the
    // lift tower up the west face with the "sky" disc at its top
    n: 30,
    box: { x: 52.45, z: 108.25, face: 19 },
    dy: 2.5,
    zones: [
      { h: ALL, colour: 0xc8c4c4, finish: 'punched' },
      { face: 109, h: [33, Infinity], colour: 0xcaa8a2, finish: 'bands' },
      { face: 19, h: [38, Infinity], colour: 0xdedbd6, finish: 'none' },
      { face: 199, h: [38, Infinity], colour: 0xdedbd6, finish: 'none' },
      { face: 289, t: [19, 27], h: [30, Infinity], colour: 0xa2a8b8, finish: 'none' },
    ],
    signs: [{ face: 289, t: 23, h: 75, w: 5, logo: 'skycity' }],
  },
  {
    // Barclay Suites: blank pale narrow ends, a grid of windows on the long faces
    n: 31,
    box: { x: 184.85, z: -127.04, face: 18 },
    dy: 0.5,
    zones: [
      { h: ALL, colour: 0x9ea6b8, finish: 'punched' },
      { face: 18, h: ALL, colour: 0xc9ccd4, finish: 'none' },
      { face: 198, h: ALL, colour: 0xc9ccd4, finish: 'none' },
    ],
  },
  {
    // the JW Marriott block: dark glass, a white core strip up the north face, a pinkish grid of windows on part of
    // the east face
    n: 32,
    box: { x: 264.86, z: -318.76, face: 20 },
    dy: 0,
    zones: [
      { h: ALL, colour: 0x404d6e, finish: 'glass' },
      { face: 20, t: [-10, 0], h: [0, 73], colour: 0xd0d2d8, finish: 'none' },
      { face: 110, t: [5, 40], h: [8, 70], colour: 0xb9aba2, finish: 'punched' },
    ],
  },
  {
    // Four Points by Sheraton: white slab bands over dark glass, a white grid round the top floors
    n: 33,
    box: { x: 126.68, z: 580.48, face: 82 },
    dy: 0.5,
    zones: [
      { h: ALL, colour: 0xd9dbdf, finish: 'bands' },
      { h: [55, Infinity], colour: 0xe2e3e6, finish: 'punched' },
    ],
  },
  {
    // City Gardens Apartments: dark balcony bands, a pale core strip up the east and west faces
    n: 34,
    box: { x: 192.4, z: -86.83, face: 18 },
    dy: 2,
    zones: [
      { h: ALL, colour: 0x5d6680, finish: 'bands' },
      { face: 108, t: [-1, 5], h: [20, 70], colour: 0xb9aeb6, finish: 'none' },
      { face: 288, t: [-5, 4], h: [20, 72], colour: 0xb9aeb6, finish: 'none' },
    ],
  },
  {
    // West Plaza: a white frame; dark window strips up the narrow ends, two dark window blocks on the south face, a
    // window grid on the north
    n: 35,
    box: { x: 234.11, z: -448.53, face: 87 },
    dy: -2,
    zones: [
      { h: ALL, colour: 0xe5e6e8, finish: 'none' },
      { face: 87, t: [-7, 6], h: [5, 72], colour: 0x4a5068, finish: 'glass' },
      { face: 267, t: [-6, 3], h: [5, 72], colour: 0x4a5068, finish: 'glass' },
      { face: 177, t: [-21, -10], h: [10, 72], colour: 0x4a5068, finish: 'glass' },
      { face: 177, t: [3, 17], h: [10, 72], colour: 0x4a5068, finish: 'glass' },
      { face: 357, t: [-20, 17], h: [5, 72], colour: 0xb8b7b8, finish: 'punched' },
    ],
  },
  {
    // Queens Residences: dark glass with tall white panels on the long faces, a white balcony grid on the north-east
    // end, the sloping roof (the kit's crown)
    n: 36,
    box: { x: 179.63, z: 528.56, face: 63 },
    dy: -2,
    zones: [
      { h: ALL, colour: 0x4a5470, finish: 'glass' },
      { face: 63, h: ALL, colour: 0xd8d7d3, finish: 'bands' },
      { face: 153, t: [-20, -14], h: [10, 65], colour: 0xd4d6dc, finish: 'none' },
      { face: 153, t: [6, 16], h: [10, 65], colour: 0xd4d6dc, finish: 'none' },
      { face: 333, t: [-24, -14], h: [10, 70], colour: 0xd4d6dc, finish: 'none' },
    ],
  },
];

/** The skin of a kit tower (by its CBD_TOWERS row), if it has one. */
export function towerSkin(n: number): TowerSkin | undefined {
  return CBD_TOWER_SKINS.find((s) => s.n === n);
}
