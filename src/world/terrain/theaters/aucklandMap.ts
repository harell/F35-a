/**
 * Stylised map of Auckland (Tāmaki Makaurau) in world kilometres (origin = Sky Tower, +X east,
 * +Z south — see src/core/auckland.ts). Hand-traced from real geography to ~300 m accuracy:
 * water bodies are polygons carved out of a land base, islands are painted back on top.
 */

export const AKL_LABEL = {
  land: 1,
  tasman: 2,
  gulf: 3,
  waitemata: 4,
  manukau: 5,
  tamaki: 6,
  lake: 7,
} as const;

/** Polygons as flat [x, z, x, z, ...] km lists. */
export const AKL_WATER: { label: number; pts: number[] }[] = [
  {
    // Tasman Sea: west coast (black-sand beaches, cliffs of the Waitākere Ranges)
    label: AKL_LABEL.tasman,
    pts: [
      -70, -70, -34.5, -70, -33.4, -40, -32.4, -28, -31.4, -15, -30.6, -5, -30.0, -1.5, -29.1, 2.5, -28.1, 5.2, -27.3, 8.0, -26.5, 10.6,
      -26.0, 12.2, -25.8, 14.2, -25.2, 16.0, -24.2, 18.0, -23.4, 20.0, -22.6, 21.2, -21.6, 21.8, -21.0, 22.6, -21.4, 24.5, -22.2, 28, -23.2, 34,
      -24.4, 42, -26, 70, -70, 70,
    ],
  },
  {
    // Hauraki Gulf + Tāmaki Strait (east coast from Waiwera round the Whangaparāoa Peninsula,
    // East Coast Bays, Devonport, Tamaki Drive, Howick, Beachlands, Kawakawa Bay)
    label: AKL_LABEL.gulf,
    pts: [
      -6.0, -70, -5.2, -42, -4.4, -35, -5.0, -32, -6.2, -29.5, -5.6, -27.0, -4.8, -25.6, -3.0, -25.2, -0.5, -25.4, 2.5, -25.0, 5.5, -24.7,
      8.0, -24.5, 9.8, -24.3, 10.1, -23.8, 9.0, -23.4, 6.5, -23.4, 4.0, -23.2, 1.5, -23.3, -1.0, -23.1, -3.0, -22.8, -4.0, -22.0, -3.6, -21.0,
      -3.4, -20.3, -2.2, -19.8, -1.3, -18.7, -0.9, -17.2, -0.8, -15.8, -0.9, -14.7, -0.5, -13.5, -0.4, -12.3, 0.0, -11.2, 0.3, -10.0, 0.7, -8.8,
      1.3, -7.6, 1.6, -6.5, 2.2, -5.4, 3.0, -4.6, 3.6, -3.6, 4.2, -3.0, 4.7, -2.6, 5.3, -2.0, 5.9, -0.8, 5.8, -0.3, 6.3, -0.25, 7.5, -0.05,
      8.7, 0.1, 9.6, 0.1, 10.3, 0.2, 11.0, 0.6, 11.6, 0.5, 11.9, 0.0, 12.3, 1.2, 12.9, 2.6, 13.6, 3.8, 14.6, 4.6, 15.8, 5.4, 16.6, 6.6, 17.2, 5.6,
      18.6, 4.6, 20.2, 4.0, 22.0, 3.8, 24.0, 3.3, 26.0, 4.2, 27.8, 5.4, 29.6, 6.6, 31.6, 7.6, 33.6, 8.8, 35.8, 10.6, 37.2, 10.0, 38.8, 11.5,
      40.5, 16, 42, 25, 44, 40, 70, 70, 70, -70,
    ],
  },
  {
    // Waitematā Harbour: CBD waterfront (wharves), under the Harbour Bridge, Te Atatū, Hobsonville,
    // the upper harbour to Riverhead, back along Greenhithe / Birkenhead / Northcote / Devonport
    label: AKL_LABEL.waitemata,
    pts: [
      5.2, -2.6, 5.9, -1.0, 5.6, -0.45, 4.8, -0.35, 4.0, -0.15, 3.4, 0.6, 2.9, 0.9, 2.6, 0.2, 2.2, -0.45, 1.95, -0.72, 1.95, -1.35, 1.2, -1.35, 1.15, -0.8,
      0.75, -0.76, 0.7, -1.2, 0.45, -1.2, 0.35, -0.72, -0.2, -0.72, -0.3, -0.92, -0.45, -1.3, -0.9, -1.35, -1.0, -1.05, -1.25, -1.25, -1.55, -1.3,
      -2.2, -1.1, -2.7, -0.85, -3.3, 0.1, -4.0, 0.2, -4.8, 0.35, -5.3, 1.1, -5.9, 0.6, -6.7, 0.3, -7.6, 0.8, -8.5, 0.7, -8.8, -0.5, -9.1, -1.9,
      -9.5, -2.9, -10.0, -2.3, -10.4, -1.0, -11.0, -1.6, -11.0, -2.8, -10.6, -4.0, -9.8, -5.0, -8.5, -6.1, -9.4, -6.6, -10.8, -7.4, -12.5, -8.2,
      -14.0, -9.0, -15.3, -9.8, -14.2, -10.4, -12.5, -9.7, -11.0, -9.6, -9.0, -8.9, -7.3, -7.9, -6.4, -8.4, -5.9, -10.6, -5.5, -8.2, -5.3, -6.5,
      -4.8, -4.6, -3.8, -3.35, -2.9, -3.2, -1.9, -2.7, -1.3, -2.45, -0.6, -2.7, -0.3, -3.4, 0.4, -3.9, 0.9, -3.0, 1.5, -2.2, 2.1, -2.3, 2.4, -3.3,
      2.8, -2.6, 2.9, -1.85, 3.8, -1.75, 4.3, -2.05, 4.8, -2.3,
    ],
  },
  {
    // Tāmaki River estuary (mouth at St Heliers / Bucklands Beach, head at Ōtāhuhu)
    label: AKL_LABEL.tamaki,
    pts: [
      10.2, -0.2, 10.2, 0.8, 9.8, 1.8, 9.3, 3.0, 8.7, 4.2, 8.2, 5.2, 7.7, 6.2, 7.4, 7.6, 7.2, 8.8, 7.0, 10.1, 7.6, 10.2, 7.9, 8.9, 8.3, 7.4,
      8.9, 6.2, 9.6, 5.4, 10.4, 4.6, 11.0, 3.4, 11.3, 2.0, 11.5, 0.8, 11.8, -0.2,
    ],
  },
  {
    // Manukau Harbour: narrow entrance at the Heads, Huia, Titirangi, Blockhouse Bay, Onehunga,
    // Māngere Inlet, the airport shore, Pahurehure Inlet (Papakura), Waiuku arm, Awhitu shore
    label: AKL_LABEL.manukau,
    pts: [
      -23.0, 21.0, -21.6, 20.3, -20.2, 19.6, -18.8, 18.6, -17.2, 17.2, -15.6, 16.2, -14.0, 15.3, -12.6, 14.0, -11.2, 12.6, -9.8, 11.6, -8.2, 10.4,
      -6.6, 9.2, -5.3, 8.6, -3.8, 8.9, -2.4, 8.6, -0.8, 8.9, 0.8, 8.8, 2.0, 8.6, 3.2, 8.9, 4.6, 9.2, 5.9, 9.6, 6.4, 10.1, 5.6, 10.4, 4.2, 10.3,
      3.0, 10.1, 2.1, 9.9, 1.0, 10.6, 0.2, 11.8, -0.3, 13.5, 0.0, 15.0, 0.3, 16.6, 0.3, 18.2, 0.8, 19.6, 2.0, 20.4, 3.6, 20.8, 5.2, 20.9, 7.0, 21.2,
      9.0, 21.8, 11.5, 22.5, 14.0, 23.0, 16.0, 23.5, 14.5, 24.3, 12.0, 24.7, 9.5, 25.7, 7.0, 26.9, 5.0, 28.1, 3.0, 29.8, 1.2, 32.0, -0.5, 35.0,
      -2.0, 38.0, -3.8, 37.5, -4.2, 34.5, -5.5, 31.5, -7.5, 29.5, -10.0, 28.2, -12.5, 27.0, -15.0, 25.6, -17.2, 24.2, -18.9, 23.0, -20.0, 22.3,
      -21.2, 22.0,
    ],
  },
];

/** Islands painted back as land (on top of the water). Polygons or ellipses. */
export const AKL_ISLANDS: ({ pts: number[] } | { ellipse: [number, number, number, number, number] })[] = [
  // Rangitoto — near-perfectly round shield volcano
  { ellipse: [8.7, -6.85, 2.8, 2.65, 0] },
  // Motutapu (joined to Rangitoto by a causeway)
  { pts: [10.9, -8.2, 11.3, -9.6, 11.9, -10.8, 12.8, -11.6, 13.8, -11.4, 14.4, -10.3, 14.5, -8.8, 14.0, -7.4, 13.3, -6.7, 12.4, -6.9, 11.6, -7.5] },
  { ellipse: [15.8, -4.3, 1.6, 0.45, -0.7] }, // Motuihe
  { ellipse: [16.7, -13.7, 0.9, 0.6, 0.3] }, // Rakino
  { ellipse: [11.83, -1.72, 0.6, 0.55, 0] }, // Browns Island (Motukorea)
  { ellipse: [11.5, -27.46, 1.45, 0.55, 0.5] }, // Tiritiri Matangi
  { ellipse: [-10.0, -8.7, 0.55, 0.45, 0] }, // Herald Island
  {
    // Waiheke Island: ~16 km E–W, deeply indented bays
    pts: [
      20.3, -7.3, 21.2, -7.9, 22.3, -7.5, 23.5, -8.2, 24.8, -7.9, 26.0, -8.5, 27.4, -8.3, 28.8, -8.0, 30.2, -7.5, 31.4, -6.6, 32.8, -5.8, 34.2, -4.6,
      35.5, -3.3, 36.0, -2.2, 35.4, -1.3, 34.0, -1.6, 32.6, -1.2, 31.4, -2.0, 30.6, -3.0, 29.6, -3.5, 28.6, -2.9, 27.4, -3.3, 26.2, -2.9, 25.3, -3.8,
      24.3, -4.4, 23.3, -5.0, 22.4, -4.8, 21.6, -5.6, 21.0, -6.3,
    ],
  },
  { ellipse: [37.2, 2.4, 1.5, 0.9, 0.6] }, // Ponui Island
];

/** Inland water painted last (crater lakes). */
export const AKL_LAKES: [number, number, number][] = [
  [0.25, -7.49, 0.55], // Lake Pupuke
  [8.35, 5.75, 0.42], // Panmure Basin
];

/** Relief regions: ellipse (cx, cz, rx, rz, rot) km, base height (m), roughness 0..1. */
export const AKL_RELIEF: { e: [number, number, number, number, number]; h: number; rough: number }[] = [
  { e: [-19.5, 8.5, 7.5, 9.0, 0.2], h: 330, rough: 1.0 }, // Waitākere Ranges
  { e: [-19.0, -6.0, 9.0, 7.0, 0], h: 95, rough: 0.35 }, // Kumeu / Waitākere foothills
  { e: [-16.0, -17.0, 10.0, 10.0, 0], h: 125, rough: 0.45 }, // Riverhead forest / north-west
  { e: [-3.0, -12.0, 5.0, 10.0, 0], h: 65, rough: 0.25 }, // North Shore
  { e: [-10.0, -25.0, 8.0, 10.0, 0], h: 150, rough: 0.5 }, // Dairy Flat / Orewa hills
  { e: [3.0, -24.3, 7.0, 1.3, 0], h: 70, rough: 0.3 }, // Whangaparāoa ridge
  { e: [1.0, 3.0, 9.0, 6.0, 0], h: 38, rough: 0.1 }, // isthmus
  { e: [-9.0, 3.0, 4.0, 5.0, 0], h: 40, rough: 0.15 }, // Henderson / New Lynn
  { e: [10.0, 16.0, 8.0, 6.0, 0], h: 25, rough: 0.1 }, // South Auckland plains
  { e: [17.0, 9.0, 6.0, 5.0, 0], h: 70, rough: 0.3 }, // Howick / Whitford hills
  { e: [27.0, 13.0, 7.0, 6.0, 0], h: 190, rough: 0.55 }, // Clevedon hills
  { e: [31.0, 24.0, 8.5, 8.5, 0], h: 460, rough: 1.0 }, // Hunua Ranges
  { e: [-17.0, 33.0, 5.0, 12.0, 0.3], h: 150, rough: 0.45 }, // Awhitu Peninsula
  { e: [5.0, 34.0, 10.0, 8.0, 0], h: 80, rough: 0.25 }, // Karaka / Pukekohe
  { e: [28.0, -5.0, 8.5, 3.5, -0.3], h: 150, rough: 0.55 }, // Waiheke
  { e: [12.8, -9.0, 1.8, 2.4, 0], h: 95, rough: 0.35 }, // Motutapu
  { e: [11.5, -27.46, 1.4, 0.55, 0.5], h: 70, rough: 0.3 }, // Tiritiri Matangi
  { e: [15.8, -4.3, 1.4, 0.5, -0.7], h: 45, rough: 0.2 }, // Motuihe
  { e: [16.7, -13.7, 0.9, 0.6, 0.3], h: 55, rough: 0.3 }, // Rakino
  { e: [37.2, 2.4, 1.5, 0.9, 0.6], h: 120, rough: 0.4 }, // Ponui
];

/** Volcanic cones: centre (km), summit (m), radius (m), crater radius (m), crater depth (m). */
export const AKL_CONES: { x: number; z: number; h: number; r: number; cr: number; cd: number }[] = [
  { x: 0.16, z: 3.11, h: 196, r: 650, cr: 150, cd: 50 }, // Mt Eden (Maungawhau)
  { x: 1.85, z: 5.71, h: 182, r: 750, cr: 120, cd: 18 }, // One Tree Hill (Maungakiekie)
  { x: -3.76, z: 4.38, h: 135, r: 480, cr: 90, cd: 15 }, // Mt Albert
  { x: 2.21, z: 3.61, h: 143, r: 430, cr: 80, cd: 20 }, // Mt Hobson
  { x: 1.23, z: 3.23, h: 126, r: 320, cr: 70, cd: 20 }, // Mt St John
  { x: 7.38, z: 4.94, h: 135, r: 620, cr: 110, cd: 25 }, // Mt Wellington
  { x: -2.25, z: 7.05, h: 110, r: 420, cr: 70, cd: 12 }, // Mt Roskill
  { x: 1.68, z: 10.82, h: 106, r: 620, cr: 100, cd: 20 }, // Māngere Mountain
  { x: 4.35, z: -2.39, h: 65, r: 460, cr: 0, cd: 0 }, // North Head
  { x: 3.19, z: -2.22, h: 87, r: 360, cr: 60, cd: 10 }, // Mt Victoria (Devonport)
  { x: 11.83, z: -1.72, h: 68, r: 560, cr: 150, cd: 20 }, // Browns Island
];

/** Rangitoto shield volcano. */
export const AKL_RANGITOTO = { x: 8.7, z: -6.85, h: 260, r: 2750, cr: 130, cd: 55 };

/** Urban footprint polygons (km); only applied on land. */
export const AKL_URBAN: number[][] = [
  // Isthmus, west, south and east suburbs
  [
    -13.0, -2.0, -9.0, -3.5, -8.0, -7.0, -5.0, -8.0, -3.0, -3.0, 5.0, -2.0, 12.0, 0.0, 16.0, 3.0, 18.0, 7.0, 17.5, 14.0, 19.0, 22.0, 16.0, 26.0, 9.0, 25.0,
    4.0, 21.5, 0.2, 19.5, -1.0, 14.0, -5.0, 12.0, -9.0, 11.5, -12.0, 9.0, -13.0, 4.0, -13.5, 0.0,
  ],
  // North Shore
  [-6.5, -10.5, -5.2, -4.2, -3.0, -2.6, -1.0, -1.9, 1.5, -1.6, 3.2, -1.4, 5.0, -2.0, 4.8, -3.2, 2.5, -5.5, 1.5, -8.0, 0.5, -12.0, -0.5, -16.0, -2.0, -19.0, -5.0, -18.0, -7.0, -12.0],
  // Whangaparāoa Peninsula
  [-5.5, -26.0, -5.5, -22.5, 5.0, -23.0, 9.8, -24.2, 5.0, -25.0, -2.0, -25.5],
  // Orewa
  [-7.5, -30.5, -5.0, -30.5, -5.0, -27.0, -7.0, -27.0],
  // Oneroa / Surfdale (Waiheke)
  [20.3, -8.0, 24.0, -8.5, 24.0, -6.5, 20.3, -6.5],
];

/** Parks & green spaces inside the urban area (km, radius km) — no houses. */
export const AKL_PARKS: [number, number, number][] = [
  [1.4, 1.3, 0.55], // Auckland Domain
  [0.35, -0.2, 0.2], // Albert Park
  [2.3, 6.0, 0.9], // Cornwall Park / One Tree Hill
  [-4.5, 1.8, 0.5], // Western Springs
  [0.6, 5.0, 0.35], // Alexandra Park
];

/** Non-urban zones inside the urban footprint (km, radius km): airport, Ihumātao, Waitākere foothills. */
export const AKL_RURAL: [number, number, number][] = [
  [2.66, 17.7, 2.6], // Auckland Airport (Māngere)
  [0.2, 14.8, 1.1], // Ihumātao / Ōtuataua stonefields
  [-12.5, 7.0, 1.6], // Waitākere foothills
];

/** Built-up density boost: CBD high-rise core (km, radius km). */
export const AKL_CBD = { x: 0.25, z: -0.2, r: 0.95 };
