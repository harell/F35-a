# LINZ terrain pipeline (Auckland theatre)

Bakes Toitū Te Whenua LINZ open elevation data into `src/world/terrain/data/auckland-linz.bin`
(≈ 510 kB gzip), which the game fetches once per page load (`src/world/terrain/theaters/aucklandLinz.ts`).

Data is licensed CC BY 4.0: *Sourced from the LINZ Data Service and licensed for reuse under the CC BY 4.0 licence.*

## What goes in

| Product | Source | Used for |
|---|---|---|
| NZ LiDAR 1m DEM (national mosaic) | `s3://nz-elevation/new-zealand/new-zealand/dem_1m/2193/` (LDS layer 121859) | land heights |
| NZ Contour-Interpolated 8m DEM | `s3://nz-elevation/new-zealand/new-zealand-contour/dem_8m/2193/` (from Topo50 contours, LDS 50768) | land/sea mask = Topo50 mean-high-water coastline |

Only the 16 m overview of the 12 tiles covering the 88 km world box is read (Cloud-Optimised GeoTIFF range
requests, ≈ 85 MB). The 1 m LiDAR DEM is not used for the coastline: it includes intertidal mudflats and
a blocky ≤ 0 m fill offshore, while the game's sea level is mean high water.

## Steps

```sh
pip install numpy scipy rasterio pyproj shapely scikit-image pillow
python3 stac.py https://nz-elevation.s3.ap-southeast-2.amazonaws.com/new-zealand/new-zealand/dem_1m/2193 dem1m.json
python3 stac.py https://nz-elevation.s3.ap-southeast-2.amazonaws.com/new-zealand/new-zealand-contour/dem_8m/2193 dem8m.json
python3 fetch.py dem1m.json new-zealand/new-zealand/dem_1m/2193 16 <work>/dem1m_16.npz
python3 fetch.py dem8m.json new-zealand/new-zealand-contour/dem_8m/2193 16 <work>/dem8m_16.npz
python3 bake.py <work>            # writes ../../src/world/terrain/data/auckland-linz.bin
python3 cones.py <work>           # prints LiDAR-snapped cone centres for aucklandMap.ts / core/auckland.ts
```

No API key is needed (the `nz-elevation` bucket is public). The LINZ Data Service (data.linz.govt.nz) serves
the same products and the vector layers (building outlines, roads) for later phases; it needs a free API key.

## What comes out

- **Coastline**: rings traced on a 16 m game grid (marching squares, Douglas–Peucker 5 m, islets < 6000 m² dropped),
  2 m vertex quantum, even–odd (land = inside an odd number of rings). ≈ 100 rings, 25 k vertices.
- **Heights**: a 1024² grid at the exact `Heightfield` sample positions (86 m), Gaussian pre-filter σ = 0.25 cell
  (keeps cone summits within ≈ 2–12 m of the LiDAR maximum), 0.5 m steps, planar-predicted zig-zag residuals.
  The 2048 (high quality) tier upsamples it: a real 2048 grid would add ≈ 1.5 MB to every page load.

Coordinates: game origin = Sky Tower, +X east, +Z south, the equirectangular projection of `src/core/auckland.ts`
(reprojected from NZTM2000 / EPSG:2193 with pyproj). Heights are NZVD2016 (≈ mean sea level; the game's y = 0).

# Phase 2a: roads (CBD streets, motorways, arterials)

`roads.ts` bakes LINZ road centrelines into `src/world/terrain/data/auckland-roads.bin` (≈ 19 kB gzip), fetched next to
the terrain data (`src/world/scenery/aucklandRoads.ts`). Same licence and attribution as above.

| Product | LDS layer | Used for |
|---|---|---|
| NZ Addresses: Road Sections | 123109 | CBD streets (every section in the CBD box), all motorway / state-highway carriageways and ramps in the theatre, the main arterials by name |
| NZ Tunnel Centrelines (Topo, 1:50k) | 50366 | motorway runs in a tunnel (Waterview) |

```sh
export LINZ_API_KEY=…            # free key from https://data.linz.govt.nz (never commit it)
npx vite-node tools/linz/roads.ts <work> [preview.svg]
```

The WFS downloads (curl) are cached as GeoJSON in `<work>`; delete them to refresh. `preview.svg` draws the result
over the LINZ coastline (`SVG_BOX="x0,z0,x1,z1"` picks another view, e.g. the whole motorway network). The bake runs
under vite-node so it reprojects with the game's own `geoToWorld` (WGS84 requested from the WFS; NZGD2000 ≈ WGS84).

What comes out:

- **CBD region**: a polygon traced along the real road graph (Dijkstra over the LINZ sections): down the SH1
  carriageways from St Marys Bay, round the Central Motorway Junction, up SH16 Grafton Gully, along Stanley St / Beach Rd
  / Quay St to the west edge of the port's wharves, then through the harbour round Queens Wharf and the Wynyard Quarter.
  Inside it the terrain shader paints the real streets instead of the procedural Voronoi grid and `buildCBD` places the
  buildings along them; the hand-over to the procedural suburbs happens under a motorway, along a street or over water.
- **Streets**: the sections within 60 m of the region, chained into polylines (Douglas–Peucker 0.6 m) with a width
  class: 19 m main streets (Queen St, Customs St, Symonds St, K Rd, …), 12 m streets, 7 m lanes; steps, walks, arcades
  and marina accessways are left out.
- **Motorways**: one 13 m ribbon per carriageway / ramp (DP 1.5 m), cut over the water beside the Harbour Bridge model
  (its abutments are the ends of the LINZ bridge section). Runs along a vehicle tunnel are flagged: within 22 m of short
  tunnels (Victoria Park, where the address data has only the viaduct), anywhere between the portals of tunnels over
  1 km (Waterview, where the address centreline is schematic). Runs under 150 m are dropped.
- **Arterials**: Dominion Rd, Mt Eden Rd, Manukau Rd, Remuera Rd, Sandringham Rd, New North Rd, Lake Rd, Onewa Rd and East
  Coast Rd along their hand-traced corridors (± 700 m), Great North Rd by suburb from Grey Lynn over the Whau to New Lynn;
  the parts inside the CBD region are left to the street map.

At runtime `cbdStreets.ts` rasterises the streets into a 4 m RGBA8 texture over the region (kerb distance, region
distance, parks, motorway verges); the shader and the JS placement code read the same texels.
