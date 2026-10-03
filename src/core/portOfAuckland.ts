/**
 * F35-A — Ports of Auckland (Fergusson Container Terminal and the wharves west of it): the ship-to-shore cranes and the
 * floodlight masts as the LINZ 2024 LiDAR found them (CC BY 4.0), measured by tools/hero/sites/ports_of_auckland.py inside
 * the OSM port outline (relation 11815188; © OpenStreetMap contributors, ODbL) and converted NZTM → WGS84 → game.
 * The container stacks are in a baked file (world/scenery/aucklandPort.ts). Prototype:
 * tools/hero/examples/ports-of-auckland.html.
 *
 * Eight cranes, all at Fergusson: five on the west berth (girder 44 m over the deck, A-frame apex 65–70 m) and the three
 * ZPMC cranes delivered in 2018 on the north berth (girder 54–55 m, apex 82 m; ZPMC gives 82.3 m). Booms as the LiDAR
 * flight found them: three raised (to 102–120 m), five down over the berth. Colours from Wikimedia Commons photos: white
 * legs, portal and machinery house, dark blue girder and boom. Leg gauge (30.5 m) and spacing are guessed.
 */

export interface PortCrane {
  /** Where the crane's axis crosses the quay edge (game m). */
  x: number;
  z: number;
  /** Unit vector along the boom, towards the water. */
  ux: number;
  uz: number;
  /** End of the backreach and tip of the lowered boom, m along the axis from the quay edge (back < 0). */
  back: number;
  tip: number;
  /** Girder and A-frame apex heights above the deck (m). */
  girder: number;
  apex: number;
  /** A raised boom's top above the deck (m), or null when the boom is down. */
  boomTop: number | null;
}

export const PORT_CRANES: readonly PortCrane[] = [
  { x: 1895.3, z: -775.09, ux: -0.9788, uz: 0.2049, back: -60.0, tip: 5.0, girder: 43.8, apex: 65.3, boomTop: 102.2 },
  { x: 1935.14, z: -577.09, ux: -0.9785, uz: 0.2062, back: -62.0, tip: 64.0, girder: 44.0, apex: 66.6, boomTop: null },
  { x: 1944.78, z: -534.64, ux: -0.9708, uz: 0.2399, back: -61.0, tip: 65.0, girder: 43.9, apex: 65.8, boomTop: null },
  { x: 1951.37, z: -506.93, ux: -0.9708, uz: 0.2399, back: -56.0, tip: 59.0, girder: 43.3, apex: 65.2, boomTop: null },
  { x: 1958.45, z: -436.42, ux: -0.9875, uz: 0.1578, back: -63.0, tip: 51.0, girder: 43.8, apex: 69.8, boomTop: null },
  { x: 1978.33, z: -956.24, ux: 0.1128, uz: -0.9936, back: -76.0, tip: 5.0, girder: 54.0, apex: 82.2, boomTop: 120.2 },
  { x: 2015.84, z: -953.23, ux: 0.1129, uz: -0.9936, back: -77.0, tip: 62.0, girder: 54.6, apex: 81.9, boomTop: null },
  { x: 2131.0, z: -939.42, ux: 0.1179, uz: -0.993, back: -75.0, tip: 5.0, girder: 54.8, apex: 82.0, boomTop: 119.3 },
];

/** Floodlight masts: [x, z, top above the ground (m)] (LiDAR spikes 24–45 m high on port land). */
export const PORT_MASTS: readonly (readonly [number, number, number])[] = [
  [1006.0, -935.6, 31.7], [1081.1, -929.0, 31.1], [1179.1, -920.8, 31.7], [1921.0, -884.6, 31.5], [2041.0, -880.9, 32.1], [2168.0, -871.2, 31.4],
  [968.3, -813.9, 25.0], [2182.5, -792.5, 31.8], [2261.3, -794.0, 31.1], [2060.7, -785.2, 31.8], [1136.1, -762.0, 30.9], [1534.5, -717.4, 31.4],
  [2078.2, -704.5, 31.8], [2208.2, -697.0, 31.3], [960.1, -666.7, 31.1], [1964.7, -682.4, 31.0], [1390.4, -624.7, 27.6], [1106.8, -619.4, 31.0],
  [2274.4, -630.2, 40.7], [1415.7, -605.2, 31.7], [1501.6, -605.8, 40.9], [1756.4, -602.5, 29.0], [2130.3, -592.5, 31.0], [2006.6, -579.2, 31.0],
  [1356.5, -513.1, 31.2], [2297.4, -519.6, 40.9], [2028.5, -477.6, 31.3], [2158.6, -468.0, 31.2], [1621.6, -440.0, 30.8], [1749.5, -441.4, 30.7],
  [1195.5, -416.1, 28.3], [1310.2, -422.2, 30.9], [1757.0, -411.5, 30.7], [1792.6, -379.2, 30.8], [1469.1, -370.2, 30.9], [1737.7, -373.2, 31.5],
  [2051.4, -376.0, 31.4], [1851.9, -360.3, 30.7], [1529.4, -351.3, 31.2], [2184.6, -357.5, 32.0], [1887.0, -350.0, 28.9], [1657.6, -332.7, 31.3],
  [1158.3, -319.4, 30.8], [1623.7, -326.0, 31.0], [1723.7, -320.9, 31.5], [1959.4, -325.3, 30.5], [1445.2, -311.7, 31.8], [1964.9, -296.4, 31.9],
  [1839.2, -291.1, 31.5], [1250.1, -273.1, 31.0], [2075.3, -271.5, 31.1], [1344.6, -241.8, 29.8], [1765.5, -221.7, 31.1], [2238.1, -221.5, 31.9],
  [1882.9, -194.9, 30.9], [1980.9, -192.7, 30.9], [1535.5, -179.4, 31.1], [1722.5, -117.9, 31.2], [1906.3, -120.3, 30.9], [1822.7, -100.7, 31.4],
];

/** Container stacks are this high per tier (m): a standard box, 8 ft 6 in. */
export const CONTAINER_TIER = 2.6;
