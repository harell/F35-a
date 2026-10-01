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
