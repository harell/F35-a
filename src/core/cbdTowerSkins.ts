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

/** Wall finish of a zone: the kit's facades (cbdTowers.ts) plus `glow` (a lit panel at night), `none` (plain) and
 * `stone` (dressed stone with punched windows, floodlit at night: the Chief Post Office). */
export type SkinFinish = 'glass' | 'bands' | 'punched' | 'plain' | 'glow' | 'none' | 'stone';

/** The signs drawn in the logo atlas (world/scenery/towerSkins.ts). */
export type SkinLogo = 'hsbc' | 'anz' | 'vero' | 'pwc' | 'qbe' | 'waitemata';

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
  signs?: readonly SkinSign[];
  /** The crown terrace's own walls above the shaft (the kit's crown colour otherwise). */
  crown?: { readonly colour: number; readonly finish: SkinFinish };
}

const ALL = [0, Infinity] as const;

export const CBD_TOWER_SKINS: readonly TowerSkin[] = [
  {
    // white precast spandrels over ribbon windows, a full-height strip of dark glass up each face (two on the
    // south-west face), a white crown band with the hexagon sign on every face; the mast is the kit's spire
    n: 11,
    box: { x: 273.71, z: -568.64, face: 17 },
    dy: 11.8,
    zones: [
      { h: [0, 87], colour: 0xe4e2da, finish: 'bands' },
      { h: [87, Infinity], colour: 0xecebe6, finish: 'plain' },
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
    // grey lattice dome over it (the kit's crown terrace)
    n: 7,
    box: { x: 192.18, z: -316.07, face: 19 },
    dy: -2.4,
    zones: [
      { h: [0, 130], colour: 0xd4c2b0, finish: 'bands' },
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
    // the red letters under the white sail crown on every face (the sail and its mast are the kit's)
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
    // big sign; white X bracing up the east and west faces; small signs at the top of the other faces
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
    // dark glass between four white pilasters a face, a dark crown with the sign on the east and west
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
];

/** The skin of a kit tower (by its CBD_TOWERS row), if it has one. */
export function towerSkin(n: number): TowerSkin | undefined {
  return CBD_TOWER_SKINS.find((s) => s.n === n);
}
