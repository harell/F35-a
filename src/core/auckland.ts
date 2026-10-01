/**
 * F35-A — Auckland (Tāmaki Makaurau), New Zealand: geographic reference for the primary theatre.
 * OWNERSHIP: orchestrator. Used by the WORLD module (terrain/coastline/landmarks) and MISSIONS
 * (spawn positions). Coordinates are approximate (±200–400 m) and hand-compiled; the terrain
 * generator should treat the coastline as a stylised but recognisable reconstruction.
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
}

/** Key places (lat/lon WGS84, approx; volcano summits snapped to the LINZ LiDAR DEM). Use AKL[id] for world coordinates. */
export const AKL_LANDMARKS: AklLandmark[] = [
  // CBD & waterfront
  { id: 'skytower', name: 'Sky Tower', kind: 'tower', lat: -36.8485, lon: 174.7622, height: 328, note: 'Tallest free-standing structure in the southern hemisphere; needle with pod at ~190-220 m' },
  { id: 'cbd', name: 'Auckland CBD', kind: 'cbd', lat: -36.8470, lon: 174.7650, radius: 900, note: 'High-rise cluster (towers to ~180 m) between Viaduct, Britomart, Albert Park and Karangahape Rd' },
  { id: 'britomart', name: 'Britomart / Queens Wharf', kind: 'landmark', lat: -36.8440, lon: 174.7680 },
  { id: 'viaduct', name: 'Viaduct Harbour', kind: 'marina', lat: -36.8440, lon: 174.7575, radius: 250 },
  { id: 'wynyard', name: 'Wynyard Quarter', kind: 'port', lat: -36.8400, lon: 174.7550, radius: 350 },
  { id: 'westhaven', name: 'Westhaven Marina', kind: 'marina', lat: -36.8385, lon: 174.7490, radius: 400 },
  { id: 'port', name: 'Ports of Auckland (Fergusson Container Terminal)', kind: 'port', lat: -36.8420, lon: 174.7790, radius: 600, note: 'Container cranes, wharves projecting ~600 m north into the harbour' },
  // abutments: the ends of the LINZ SH1 bridge centreline (NZ Addresses road sections), where the motorway ribbons meet the model
  { id: 'bridge_s', name: 'Harbour Bridge (south abutment, St Marys Bay)', kind: 'bridge', lat: -36.83504, lon: 174.74275 },
  { id: 'bridge_n', name: 'Harbour Bridge (north abutment, Northcote Point)', kind: 'bridge', lat: -36.82724, lon: 174.74786, note: 'Steel truss, ~1,020 m, main span 243 m, 43 m clearance over the water' },
  { id: 'domain', name: 'Auckland Domain (Pukekawa) & War Memorial Museum', kind: 'landmark', lat: -36.8600, lon: 174.7780 },
  { id: 'ponsonby', name: 'Ponsonby / Herne Bay', kind: 'suburb', lat: -36.8480, lon: 174.7400 },
  { id: 'parnell', name: 'Parnell', kind: 'suburb', lat: -36.8560, lon: 174.7800 },
  { id: 'newmarket', name: 'Newmarket', kind: 'suburb', lat: -36.8700, lon: 174.7780 },
  { id: 'tamaki_drive', name: 'Tamaki Drive / Mission Bay', kind: 'coast', lat: -36.8470, lon: 174.8330 },
  { id: 'bastion', name: 'Bastion Point (Takaparawhau)', kind: 'landmark', lat: -36.8468, lon: 174.8270 },
  { id: 'st_heliers', name: 'St Heliers', kind: 'suburb', lat: -36.8520, lon: 174.8600 },

  // North Shore
  { id: 'devonport', name: 'Devonport', kind: 'suburb', lat: -36.8310, lon: 174.7960 },
  { id: 'north_head', name: 'North Head (Maungauika)', kind: 'volcano', lat: -36.8276, lon: 174.8121, height: 64, radius: 450 },
  { id: 'mt_victoria_dp', name: 'Mt Victoria (Takarunga)', kind: 'volcano', lat: -36.8266, lon: 174.7990, height: 82, radius: 350 },
  { id: 'northcote', name: 'Northcote', kind: 'suburb', lat: -36.8050, lon: 174.7480 },
  { id: 'takapuna', name: 'Takapuna', kind: 'suburb', lat: -36.7880, lon: 174.7700 },
  { id: 'pupuke', name: 'Lake Pupuke', kind: 'lake', lat: -36.7810, lon: 174.7650, radius: 550, note: 'Crater lake' },
  { id: 'browns_bay', name: "Browns Bay", kind: 'suburb', lat: -36.7160, lon: 174.7480 },
  { id: 'long_bay', name: 'Long Bay', kind: 'coast', lat: -36.6800, lon: 174.7450 },
  { id: 'whangaparaoa', name: 'Whangaparāoa Peninsula (tip)', kind: 'coast', lat: -36.6330, lon: 174.8700, note: 'Peninsula runs west→east from ~174.72 to ~174.87 along lat ≈ -36.62…-36.64' },
  { id: 'tiritiri', name: 'Tiritiri Matangi Island', kind: 'island', lat: -36.6010, lon: 174.8910, radius: 1300, height: 90 },

  // Hauraki Gulf islands (enemy-held in the campaign fiction)
  { id: 'rangitoto', name: 'Rangitoto Island', kind: 'volcano', lat: -36.7867, lon: 174.8584, height: 259, radius: 2800, note: 'Near-perfectly symmetric basalt shield volcano, dark bush-covered lava fields, summit craters' },
  { id: 'motutapu', name: 'Motutapu Island', kind: 'island', lat: -36.7700, lon: 174.9050, height: 120, radius: 2600, note: 'Grassy rolling farmland, joined to Rangitoto by a causeway at the NW' },
  { id: 'browns_is', name: 'Browns Island (Motukorea)', kind: 'volcano', lat: -36.8291, lon: 174.8955, height: 65, radius: 600 },
  { id: 'waiheke_w', name: 'Waiheke Island (Oneroa, west)', kind: 'island', lat: -36.7850, lon: 175.0100 },
  { id: 'waiheke', name: 'Waiheke Island (centre)', kind: 'island', lat: -36.8000, lon: 175.0700, radius: 9000, height: 230, note: '~19 km E-W, 2-9 km N-S, deeply indented bays, vineyards' },
  { id: 'waiheke_e', name: 'Waiheke Island (east end)', kind: 'island', lat: -36.8300, lon: 175.1600 },
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
  { id: 'tamaki_mouth', name: 'Tāmaki River mouth', kind: 'coast', lat: -36.8470, lon: 174.8830, note: 'Estuary runs south ~9 km to Panmure/Ōtāhuhu' },
  { id: 'otahuhu', name: 'Ōtāhuhu portage (narrowest isthmus, ~1.3 km)', kind: 'landmark', lat: -36.9450, lon: 174.8400 },
  { id: 'onehunga', name: 'Onehunga (Manukau Harbour north shore)', kind: 'coast', lat: -36.9250, lon: 174.7850 },
  { id: 'blockhouse_bay', name: 'Blockhouse Bay', kind: 'coast', lat: -36.9250, lon: 174.7000 },
  { id: 'titirangi', name: 'Titirangi', kind: 'suburb', lat: -36.9400, lon: 174.6550 },
  { id: 'huia', name: 'Huia', kind: 'coast', lat: -37.0000, lon: 174.5700 },
  { id: 'manukau_heads', name: 'Manukau Heads (harbour entrance)', kind: 'coast', lat: -37.0500, lon: 174.5400, note: 'Narrow entrance ~2 km, harbour spreads NE/E/SE with many arms and mudflats' },
  { id: 'chelsea', name: 'Chelsea (upper Waitematā)', kind: 'coast', lat: -36.8200, lon: 174.7200 },
  { id: 'herald_is', name: 'Herald Island', kind: 'island', lat: -36.7700, lon: 174.6500, radius: 600 },
  { id: 'riverhead', name: 'Riverhead (head of Waitematā)', kind: 'coast', lat: -36.7600, lon: 174.5900 },
  { id: 'hobsonville', name: 'Hobsonville Point', kind: 'coast', lat: -36.7930, lon: 174.6600 },

  // Air bases (player operates from Whenuapai)
  { id: 'whenuapai', name: 'RNZAF Base Auckland (Whenuapai)', kind: 'airbase', lat: -36.7880, lon: 174.6300, note: 'Main runway 03/21 (~2,000 m) + cross runway 08/26' },
  { id: 'akl_airport', name: 'Auckland Airport (Māngere)', kind: 'airport', lat: -37.0122, lon: 174.7863, note: 'Runway 05R/23L, 3,635 m, ~070°/250° true, along the Manukau shore of the Māngere promontory (fitted to the LINZ coastline / LiDAR)' },

  // Ranges & coasts
  { id: 'waitakere', name: 'Waitākere Ranges', kind: 'range', lat: -36.9500, lon: 174.5400, height: 474, radius: 9000, note: 'Bush-clad hills 250-474 m, dropping in cliffs to the Tasman coast' },
  { id: 'piha', name: 'Piha (west coast, Lion Rock)', kind: 'coast', lat: -36.9530, lon: 174.4700 },
  { id: 'muriwai', name: 'Muriwai Beach (west coast)', kind: 'coast', lat: -36.8300, lon: 174.4250, note: 'Long straight black-sand beach running north' },
  { id: 'hunua', name: 'Hunua Ranges', kind: 'range', lat: -37.0600, lon: 175.1000, height: 688, radius: 9000 },
  { id: 'beachlands', name: 'Beachlands / Maraetai (Tāmaki Strait south shore)', kind: 'coast', lat: -36.8850, lon: 175.0000 },
];

/** World-space lookup: AKL.skytower → { x, z, height?, radius? }. */
export const AKL: Record<string, { x: number; z: number; height?: number; radius?: number; name: string }> = Object.fromEntries(
  AKL_LANDMARKS.map((l) => [l.id, { ...geoToWorld(l.lat, l.lon), height: l.height, radius: l.radius, name: l.name }]),
);
