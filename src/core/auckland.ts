/**
 * F35-A — Auckland (Tāmaki Makaurau), New Zealand: geographic reference for the primary theatre.
 * OWNERSHIP: orchestrator. Used by the WORLD module (terrain/coastline/landmarks) and MISSIONS
 * (spawn positions). Coordinates are hand-compiled (±200–400 m inland), then checked against the
 * real LINZ coastline: every landmark sits on the side of the shore its `site` says, with ≥ 50 m
 * to spare on land (tests/world-landmarks.test.ts; tools/linz/landmarks.ts measures and suggests).
 *
 * World origin (0, 0) = Sky Tower. +X = east, −Z = north, metres. The 80 km world spans
 * roughly Muriwai/Piha (west coast, x≈−30 km) to eastern Waiheke (x≈+35 km) and from
 * Whangaparāoa (z≈−25 km) to the Manukau Heads / airport (z≈+18…22 km).
 */

export const AKL_ORIGIN = { lat: -36.8485, lon: 174.7622 };
const M_PER_DEG_LAT = 110_950;
const M_PER_DEG_LON = 111_320 * Math.cos((AKL_ORIGIN.lat * Math.PI) / 180); // ≈ 89,090

/** WGS84 lat/lon (deg) → world XZ (m). */
export function geoToWorld(lat: number, lon: number): { x: number; z: number } {
  return { x: (lon - AKL_ORIGIN.lon) * M_PER_DEG_LON, z: (AKL_ORIGIN.lat - lat) * M_PER_DEG_LAT };
}

/** World XZ (m) → lat/lon (deg). */
export function worldToGeo(x: number, z: number): { lat: number; lon: number } {
  return { lat: AKL_ORIGIN.lat - z / M_PER_DEG_LAT, lon: AKL_ORIGIN.lon + x / M_PER_DEG_LON };
}

export type AklLandmarkKind =
  | 'tower'
  | 'bridge'
  | 'cbd'
  | 'port'
  | 'marina'
  | 'volcano'
  | 'island'
  | 'suburb'
  | 'airport'
  | 'airbase'
  | 'range'
  | 'lake'
  | 'coast'
  | 'landmark';

export interface AklLandmark {
  id: string;
  name: string;
  kind: AklLandmarkKind;
  lat: number;
  lon: number;
  /** Summit / structure height above sea level (m), where meaningful. */
  height?: number;
  /** Approximate radius / half-extent (m), where meaningful. */
  radius?: number;
  note?: string;
  /**
   * Where it sits against the real LINZ coastline: on land at least 50 m inland unless set
   * ('water': a lake, marina basin or river mouth; 'shore': a bridge abutment, on the shoreline).
   * Checked by tests/world-landmarks.test.ts; tools/linz/landmarks.ts reports and suggests fixes.
   */
  site?: 'water' | 'shore';
}

/** Key places (lat/lon WGS84, approx; volcano summits snapped to the LINZ LiDAR DEM). Use AKL[id] for world coordinates. */
export const AKL_LANDMARKS: AklLandmark[] = [
  // CBD & waterfront
  { id: 'skytower', name: 'Sky Tower', kind: 'tower', lat: -36.848471, lon: 174.762188, height: 328, note: 'Tallest free-standing structure in the southern hemisphere; shaft axis from OpenStreetMap (≈3 m from the world origin). Shape in core/skyTower.ts' },
  { id: 'cbd', name: 'Auckland CBD', kind: 'cbd', lat: -36.8470, lon: 174.7650, radius: 900, note: 'High-rise cluster (towers to ~180 m) between Viaduct, Britomart, Albert Park and Karangahape Rd' },
  { id: 'britomart', name: 'Britomart / Queens Wharf', kind: 'landmark', lat: -36.8440, lon: 174.7680 },
  { id: 'viaduct', name: 'Viaduct Harbour', kind: 'marina', lat: -36.8440, lon: 174.7575, radius: 250 },
  { id: 'wynyard', name: 'Wynyard Quarter', kind: 'port', lat: -36.8400, lon: 174.7550, radius: 350 },
  { id: 'westhaven', name: 'Westhaven Marina', kind: 'marina', lat: -36.8385, lon: 174.7490, radius: 400, site: 'water' },
  { id: 'port', name: 'Ports of Auckland (Fergusson Container Terminal)', kind: 'port', lat: -36.8438, lon: 174.7857, radius: 600, note: 'Container cranes, wharves projecting ~600 m north into the harbour' },
  // abutments: on the LINZ SH1 bridge centreline, where the motorway ribbons meet the model. The north one is the end of the
  // LINZ bridge section; the section's south end is 11 m out over Westhaven, so the abutment is 40 m further back along the
  // deck, on the St Marys Bay shore (≈ 25 m inland, like Northcote Point's ≈ 16 m). Deck length ≈ 1,020 m, as built.
  { id: 'bridge_s', name: 'Harbour Bridge (south abutment, St Marys Bay)', kind: 'bridge', lat: -36.83536, lon: 174.74254, site: 'shore' },
  { id: 'bridge_n', name: 'Harbour Bridge (north abutment, Northcote Point)', kind: 'bridge', lat: -36.82724, lon: 174.74786, note: 'Steel truss, ~1,020 m, main span 243 m, 43 m clearance over the water', site: 'shore' },
  { id: 'domain', name: 'Auckland Domain (Pukekawa) & War Memorial Museum', kind: 'landmark', lat: -36.8600, lon: 174.7780 },
  { id: 'ponsonby', name: 'Ponsonby / Herne Bay', kind: 'suburb', lat: -36.8480, lon: 174.7400 },
  { id: 'parnell', name: 'Parnell', kind: 'suburb', lat: -36.8560, lon: 174.7800 },
  { id: 'newmarket', name: 'Newmarket', kind: 'suburb', lat: -36.8700, lon: 174.7780 },
  { id: 'tamaki_drive', name: 'Tamaki Drive / Mission Bay', kind: 'coast', lat: -36.8485, lon: 174.8331 },
  { id: 'bastion', name: 'Bastion Point (Takaparawhau)', kind: 'landmark', lat: -36.8468, lon: 174.8270 },
  { id: 'st_heliers', name: 'St Heliers', kind: 'suburb', lat: -36.8520, lon: 174.8600 },

  // North Shore
  { id: 'devonport', name: 'Devonport', kind: 'suburb', lat: -36.8310, lon: 174.7960 },
  { id: 'north_head', name: 'North Head (Maungauika)', kind: 'volcano', lat: -36.8276, lon: 174.8121, height: 64, radius: 450 },
  { id: 'mt_victoria_dp', name: 'Mt Victoria (Takarunga)', kind: 'volcano', lat: -36.8266, lon: 174.7990, height: 82, radius: 350 },
  { id: 'northcote', name: 'Northcote', kind: 'suburb', lat: -36.8050, lon: 174.7480 },
  { id: 'takapuna', name: 'Takapuna', kind: 'suburb', lat: -36.7880, lon: 174.7700 },
  { id: 'pupuke', name: 'Lake Pupuke', kind: 'lake', lat: -36.7810, lon: 174.7650, radius: 550, note: 'Crater lake', site: 'water' },
  { id: 'browns_bay', name: "Browns Bay", kind: 'suburb', lat: -36.7160, lon: 174.7480 },
  { id: 'long_bay', name: 'Long Bay', kind: 'coast', lat: -36.6800, lon: 174.7450 },
  { id: 'whangaparaoa', name: 'Whangaparāoa Peninsula (tip)', kind: 'coast', lat: -36.6050, lon: 174.8370, note: 'Peninsula runs west→east from Silverdale (~174.70) to Whangaparāoa Head (~174.84) along lat ≈ -36.59…-36.64' },
  { id: 'tiritiri', name: 'Tiritiri Matangi Island', kind: 'island', lat: -36.6010, lon: 174.8910, radius: 1300, height: 90 },

  // Hauraki Gulf islands (enemy-held in the campaign fiction)
  { id: 'rangitoto', name: 'Rangitoto Island', kind: 'volcano', lat: -36.7867, lon: 174.8584, height: 259, radius: 2800, note: 'Near-perfectly symmetric basalt shield volcano, dark bush-covered lava fields, summit craters' },
  { id: 'motutapu', name: 'Motutapu Island', kind: 'island', lat: -36.7700, lon: 174.9050, height: 120, radius: 2600, note: 'Grassy rolling farmland, joined to Rangitoto by a causeway at the NW' },
  { id: 'browns_is', name: 'Browns Island (Motukorea)', kind: 'volcano', lat: -36.8291, lon: 174.8955, height: 65, radius: 600 },
  { id: 'waiheke_w', name: 'Waiheke Island (Oneroa, west)', kind: 'island', lat: -36.7850, lon: 175.0100 },
  { id: 'waiheke', name: 'Waiheke Island (centre)', kind: 'island', lat: -36.8000, lon: 175.0700, radius: 9000, height: 230, note: '~19 km E-W, 2-9 km N-S, deeply indented bays, vineyards' },
  { id: 'waiheke_e', name: 'Waiheke Island (east end)', kind: 'island', lat: -36.8295, lon: 175.1591 },
  { id: 'rakino', name: 'Rakino Island', kind: 'island', lat: -36.7237, lon: 174.9497, radius: 800 },
  { id: 'motuihe', name: 'Motuihe Island', kind: 'island', lat: -36.8080, lon: 174.9437, radius: 1100 },

  // Isthmus volcanic cones
  { id: 'mt_eden', name: 'Mt Eden (Maungawhau)', kind: 'volcano', lat: -36.8775, lon: 174.7644, height: 194, radius: 600, note: 'Deep 50 m summit crater' },
  { id: 'one_tree_hill', name: 'One Tree Hill (Maungakiekie)', kind: 'volcano', lat: -36.8998, lon: 174.7830, height: 180, radius: 700, note: 'Obelisk on the summit' },
  { id: 'mt_albert', name: 'Mt Albert (Ōwairaka)', kind: 'volcano', lat: -36.8910, lon: 174.7198, height: 133, radius: 450 },
  { id: 'mt_hobson', name: 'Mt Hobson (Ōhinerau)', kind: 'volcano', lat: -36.8781, lon: 174.7870, height: 142, radius: 400 },
  { id: 'mt_wellington', name: 'Mt Wellington (Maungarei)', kind: 'volcano', lat: -36.8925, lon: 174.8471, height: 134, radius: 600 },
  { id: 'mt_roskill', name: 'Mt Roskill (Puketāpapa)', kind: 'volcano', lat: -36.9124, lon: 174.7371, height: 106, radius: 400 },
  { id: 'mangere_mtn', name: 'Māngere Mountain', kind: 'volcano', lat: -36.9486, lon: 174.7820, height: 104, radius: 600 },

  // Harbours, rivers & isthmus
  { id: 'tamaki_mouth', name: 'Tāmaki River mouth', kind: 'coast', lat: -36.8470, lon: 174.8830, note: 'Estuary runs south ~9 km to Panmure/Ōtāhuhu', site: 'water' },
  { id: 'otahuhu', name: 'Ōtāhuhu portage (narrowest isthmus, ~1.3 km)', kind: 'landmark', lat: -36.9450, lon: 174.8400 },
  { id: 'onehunga', name: 'Onehunga (Manukau Harbour north shore)', kind: 'coast', lat: -36.9250, lon: 174.7850 },
  { id: 'blockhouse_bay', name: 'Blockhouse Bay', kind: 'coast', lat: -36.9250, lon: 174.7000 },
  { id: 'titirangi', name: 'Titirangi', kind: 'suburb', lat: -36.9400, lon: 174.6550 },
  { id: 'huia', name: 'Huia', kind: 'coast', lat: -36.9988, lon: 174.5702 },
  { id: 'manukau_heads', name: 'Manukau Heads (harbour entrance)', kind: 'coast', lat: -37.0501, lon: 174.5407, note: 'Narrow entrance ~2 km, harbour spreads NE/E/SE with many arms and mudflats' },
  { id: 'chelsea', name: 'Chelsea (upper Waitematā)', kind: 'coast', lat: -36.8200, lon: 174.7200 },
  { id: 'herald_is', name: 'Herald Island', kind: 'island', lat: -36.7672, lon: 174.6535, radius: 600, note: 'Joined to Whenuapai by a causeway (one landmass in the LINZ coastline)' },
  { id: 'riverhead', name: 'Riverhead (head of Waitematā)', kind: 'coast', lat: -36.7600, lon: 174.5900 },
  { id: 'hobsonville', name: 'Hobsonville Point', kind: 'coast', lat: -36.7930, lon: 174.6600 },

  // Air bases (player operates from Whenuapai)
  // Centres of the main runways (OpenStreetMap thresholds in src/core/airfields.ts)
  { id: 'whenuapai', name: 'RNZAF Base Auckland (Whenuapai)', kind: 'airbase', lat: -36.79062, lon: 174.630006, note: 'Main runway 03/21 (2,020 m, 053° true) + cross runway 08/26 (1,570 m, 098° true)' },
  { id: 'akl_airport', name: 'Auckland Airport (Māngere)', kind: 'airport', lat: -37.012063, lon: 174.786209, note: 'Runway 05R/23L, ≈3,650 m, 071°/251° true, along the Manukau shore of the Māngere promontory' },
  { id: 'ardmore', name: 'Ardmore Airport', kind: 'airport', lat: -37.030862, lon: 174.97449, note: 'General aviation; sealed runway 03/21, 1,390 m, 046° true' },
  { id: 'dairy_flat', name: 'North Shore Aerodrome (Dairy Flat)', kind: 'airport', lat: -36.656537, lon: 174.655261, note: 'General aviation; sealed 03/21 (730 m) and grass 09/27' },

  // Ranges & coasts
  { id: 'waitakere', name: 'Waitākere Ranges', kind: 'range', lat: -36.9500, lon: 174.5400, height: 474, radius: 9000, note: 'Bush-clad hills 250-474 m, dropping in cliffs to the Tasman coast' },
  { id: 'piha', name: 'Piha (west coast, Lion Rock)', kind: 'coast', lat: -36.9530, lon: 174.4700 },
  { id: 'muriwai', name: 'Muriwai Beach (west coast)', kind: 'coast', lat: -36.8292, lon: 174.4268, note: 'Long straight black-sand beach running north' },
  { id: 'hunua', name: 'Hunua Ranges', kind: 'range', lat: -37.0600, lon: 175.1000, height: 688, radius: 9000 },
  { id: 'beachlands', name: 'Beachlands / Maraetai (Tāmaki Strait south shore)', kind: 'coast', lat: -36.8850, lon: 175.0000 },
];

/** Centre of the Harbour Bridge's 243 m navigation span, as a fraction of the deck from bridge_s to bridge_n. */
export const BRIDGE_SPAN_T = 0.64;

/** World-space lookup: AKL.skytower → { x, z, height?, radius? }. */
export const AKL: Record<string, { x: number; z: number; height?: number; radius?: number; name: string }> = Object.fromEntries(
  AKL_LANDMARKS.map((l) => [l.id, { ...geoToWorld(l.lat, l.lon), height: l.height, radius: l.radius, name: l.name }]),
);
