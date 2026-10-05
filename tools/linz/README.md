# LINZ terrain pipeline (Auckland theatre)

Bakes Toitū Te Whenua LINZ open elevation, vegetation and hydrographic data into `src/world/terrain/data/auckland-linz.bin`
(≈ 588 kB gzip), which the game fetches once per page load (`src/world/terrain/theaters/aucklandLinz.ts`), and
`auckland-linz-hd.bin` (≈ 1.24 MB gzip), the real 2048² detail fetched only by the high quality tier
(`src/world/terrain/theaters/aucklandLinzHd.ts`).

Data is licensed CC BY 4.0: *Sourced from the LINZ Data Service and licensed for reuse under the CC BY 4.0 licence.*

## What goes in

| Product | Source | Used for |
|---|---|---|
| NZ LiDAR 1m DEM (national mosaic) | `s3://nz-elevation/new-zealand/new-zealand/dem_1m/2193/` (LDS layer 121859) | land heights |
| NZ Contour-Interpolated 8m DEM | `s3://nz-elevation/new-zealand/new-zealand-contour/dem_8m/2193/` (from Topo50 contours, LDS 50768) | land/sea mask = Topo50 mean-high-water coastline |
| NZ Native / Exotic / Scrub Polygons (Topo, 1:50k) | LDS layers 50306 / 50267 / 50339 (WFS, API key) | bush, pine plantations, scrub |
| Depth area polygon (Hydro) 1:4k–22k, 1:22k–90k, 1:90k–350k, 1:350k–1.5M | LDS layers 50671 / 50553 / 50447 / 50852 (WFS, API key; ENC data, not for navigation) | water depth |

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
LINZ_API_KEY=… python3 landcover.py <work>   # vegetation + depth-area polygons (WFS GeoJSON, cached in <work>)
python3 bake.py <work>            # writes ../../src/world/terrain/data/auckland-linz.bin and auckland-linz-hd.bin
python3 cones.py <work>           # prints LiDAR-snapped cone centres for aucklandMap.ts / core/auckland.ts
```

### Landmarks against the coastline

```sh
npx vite-node tools/linz/landmarks.ts [margin m = 50]
```

Reads the baked coastline (no download) and prints the signed coast distance (+ land, − water) of every landmark
in `src/core/auckland.ts`, every named mission position (`P` in `src/missions/content/common.ts`) and every hand-traced
road vertex in the water (`src/world/scenery/motorways.ts`). Landmarks are expected on land with the margin to spare
unless their `site` says `'water'` (a lake, marina basin or river mouth) or `'shore'` (the Harbour Bridge abutments);
for each one that isn't, it suggests the nearest point that is. Review every suggestion by hand: the nearest land
with a margin can be the wrong landmass (it puts the Whangaparāoa tip on Tiritiri Matangi).
`tests/world-landmarks.test.ts` asserts the same rules.

The elevation needs no API key (the `nz-elevation` bucket is public); the vegetation and hydrographic layers come from
the LINZ Data Service (data.linz.govt.nz) WFS, which needs a free API key (`LINZ_API_KEY`, never commit it).

## What comes out

- **Coastline**: rings traced on a 16 m game grid (marching squares, Douglas–Peucker 5 m, islets < 6000 m² dropped),
  2 m vertex quantum, even–odd (land = inside an odd number of rings). ≈ 100 rings, 25 k vertices.
- **Heights**: a 1024² grid at the exact `Heightfield` sample positions (86 m), Gaussian pre-filter σ = 0.25 cell
  (keeps cone summits within ≈ 2–12 m of the LiDAR maximum), 0.5 m steps, planar-predicted zig-zag residuals.
- **HD detail** (high tier only, `auckland-linz-hd.bin`): the 2048² grid (43 m) with the same σ = 0.25-cell pre-filter;
  at its local maxima the sample takes the source maximum within one cell, so narrow summits that fall between
  samples keep their LiDAR height. Stored as the residual over the Catmull-Rom upsample of the decoded 1024 grid
  (what `upsample2x` in `generate.ts` reconstructs), zig-zag bytes, plus an FNV-1a hash of the 1024 grid so a
  stale pair is rejected. Always re-bake both files together.

- **Land cover** (version 2, #7): a 512² grid at the 1024 grid's even samples (172 m). Each Topo50 class is rasterised
  on the 16 m mosaic grid and box-averaged over a cell; a byte holds the class with the largest share (1 native,
  2 exotic, 3 scrub) and the total tree cover in eighths. The game interpolates the share per class
  (`linzCover`), so a forest edge falls where the share crosses ½, not on the 172 m cell edges. Native → `MAT_BUSH`,
  exotic → `MAT_PINE` (darker colour, conifers), scrub → sparse `MAT_BUSH`; a share over ½ wins over the hand-traced
  suburbs. Mangroves (layer 50296) are left out: they grow below the MHW coastline, in the game's water.
- **Water depth** (version 2, #7): the same 512² grid, √depth in 0.1 steps (±0.1 m at 1 m, ±0.5 m at 25 m), the
  height coder. From the ENC depth areas on a 32 m grid, finer chart scales painting over coarser ones; inside a band
  [drval1, drval2] the depth runs from drval1 at the edge shared with shallower water or the shore to drval2 at the
  edge shared with deeper water, in proportion to the distances to the two. Drying flats (drval1 < 0) instead stay at
  55 % of the charted drying height (≈ mean sea level) and fall to chart datum within 400 m of deeper water: a linear
  ramp from the shore left the middle of the Manukau's kilometres-wide banks as deep as its channels. Chart datum
  (≈ lowest tide) is moved to the game's sea level, mean high water, by the highest drying height charted nearby
  (≈ MHWS: 4.2 m in the Manukau, 3.1–3.3 m in the Waitematā) less 0.3 m. Depth ≥ 0.3 m everywhere below the
  coastline; the land samples within two cells of the water hold the nearest water depth for bilinear lookups.
  The game reads it in `waterHeight()` (`theaters/auckland.ts`), except in the hand-placed crater lakes.
- Both add ≈ 78 kB gzip (cover ≈ 37 kB, depth ≈ 40 kB); at 1024² they would cost ≈ 105 + 130 kB. The coastline and
  heights are unchanged, so `auckland-linz-hd.bin` (tied to the 1024 grid by its hash) stays valid.

## HD terrain (high quality tier)

On the high tier (2048² heightfield) `finishTerrain` blends the upsampled base to the real 2048 heights instead
of adding procedural noise: weight 0 below 3 m rising to 1 at 12 m of upsampled height (the shoreline and the
base's shore ramp at the waterline stay put; headlands inside the ramp, like North Head, still reach their real
summits), faded out with the border fade, never below 3 m on land.

| | procedural detail | real detail |
|---|---|---|
| cone summits vs LiDAR (12 cones) | −4 … −28 % (Browns Island 47 m vs 65 m) | within ±1.7 % |
| download | – | ≈ 1.24 MB gzip once (content-hashed, browser-cached); ≈ 2.3 s at 10 Mbit/s, overlapping the workers' base generation |
| `finishTerrain` at 2048 (node) | ≈ 0.9 s | ≈ 0.7 s |

Only the high tier with the *HD terrain* setting on (default; `?hdterrain=0` turns it off) requests the file;
low / medium never do, and the service worker never precaches it (`ON_DEMAND` in `public/sw.js`).
`tests/world-linz-hd.test.ts` checks the summits, the absence of seeded noise on land, the shoreline and the
tier gating; `e2e/hd-terrain.mjs` checks the real network and service-worker caches per tier.

Measured alternative: shipping the residual only within 15 km of the CBD would cut the file to ≈ 134 kB (25 km:
≈ 366 kB), but leaves the Waitākere and Hunua ranges smoothed, so the whole grid is shipped.

Coordinates: game origin = Sky Tower, +X east, +Z south, the equirectangular projection of `src/core/auckland.ts`
(reprojected from NZTM2000 / EPSG:2193 with pyproj). Heights are NZVD2016 (≈ mean sea level; the game's y = 0).

# Phase 2a: roads (CBD streets, motorways, arterials)

`roads.ts` bakes LINZ road centrelines into `src/world/terrain/data/auckland-roads.bin` (≈ 38 kB gzip with the railways), fetched next to
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

- **CBD region** (the real-streets region): a polygon traced along the real road graph (Dijkstra over the LINZ
  sections): along Jervois Rd from Herne Bay's west end and up Shelly Beach Rd (a graph of those two roads alone), down
  the SH1 carriageways from the bridge approach through St Marys Bay, round the Central Motorway Junction, up SH16 Grafton
  Gully, along Stanley St / Beach Rd / Quay St to the west edge of the port's wharves, then through the harbour round
  Queens Wharf, the Wynyard Quarter and outside Westhaven's breakwaters, under the Harbour Bridge and along Herne Bay's
  shore to Cox's Bay. Inside it the terrain shader paints the real streets instead of the procedural Voronoi grid and
  `buildCBD` places the buildings along them (in Herne Bay and Westhaven: the hero neighbourhoods,
  `src/world/scenery/aucklandNeighbourhoods.ts`); the hand-over to the procedural suburbs happens under a motorway, along
  a street or over water. St Marys Bay and Ponsonby stay procedural: inside the region every building has to come from
  data, so it only grows where the buildings exist.
- **Streets**: the sections within 60 m of the region, chained into polylines (Douglas–Peucker 0.6 m) with a width
  class: 19 m main streets (Queen St, Customs St, Symonds St, K Rd, …), 12 m streets, 7 m lanes; steps, walks, arcades
  and marina accessways are left out.
- **Motorways**: one 13 m ribbon per carriageway / ramp (DP 1.5 m), cut over the water beside the Harbour Bridge model
  (its abutments are on the shore at the ends of the LINZ bridge section). Runs along a vehicle tunnel are flagged: within 22 m of short
  tunnels (Victoria Park, where the address data has only the viaduct), anywhere between the portals of tunnels over
  1 km (Waterview, where the address centreline is schematic). Runs under 150 m are dropped.
- **Arterials and main streets**: ≈ 140 named roads (`ARTERIALS` in `roads.ts`: the radial roads out of the CBD such as
  Great North, New North, Dominion, Mt Eden, Manukau and Great South Rd, Symonds St, Khyber Pass, Park Rd, Domain Dr,
  Broadway, Remuera Rd, Tamaki Dr, and the main roads of the south, east, west and North Shore), ≈ 485 km, each with a
  kerb-to-kerb width (12–16 m). The LINZ layer covers the whole Auckland region, so a name that is used in
  several places (Park Road in Grafton, Titirangi and Waiuku) is taken only from the listed suburbs, and everything outside
  the world box is dropped. There is no "Domain Road" near the CBD: the Domain's roads are Domain Dr and Park Rd. The parts
  inside the CBD region (Queen St, most of Symonds St) are left to the street map.
- **Streets round the landmarks**: for every OSM stadium outside the region (`auckland-osm.bin`), the LINZ sections
  within 90 m of its outline, clipped there and off the grounds, as arterial-kind ribbons (widths of the street classes,
  at most 12 m); runs along an existing motorway or arterial are left out. With the terrain shader's site mask
  (`Scenery.siteMask`: no procedural grid on a stadium's grounds), a 3D stadium stands among its own streets.

Outside the region every arterial is lined with frontage lots that face it (`src/world/scenery/frontage.ts`): its
straight pieces (DP 2 m) carry a 3.5 m footpath and lots 34 m deep, trimmed on the inside of each bend and fitted in blocks
between the side streets. The suburbs' grid turns to the arterial in every district it runs through
(`urbanGrid.ts districtAngles`), so the side streets meet it square. The terrain shader paints the same lots
(`frontageLot()`) and `HouseSource` stands the 3D houses, apartment blocks and town-centre shops on them; the grid's own
lots are cleared from the back of the band (`lotMask.ts`).

At runtime `cbdStreets.ts` rasterises the streets into a 4 m RGBA8 texture over the region (kerb distance, region
distance, parks and the hero neighbourhoods' gardens, motorway verges); the shader and the JS placement code read the same
texels. Since the region took in Herne Bay and Westhaven it is ≈ 1190 × 790 texels (3.7 MB of GPU memory, ≈ 0.22 s to
build on the cloud container, ≈ 0.1 s before).

# Railways (#31)

`railways.ts` adds the railway lines to `src/world/terrain/data/auckland-roads.bin` (lines of kind `ROAD_RAIL`, ≈ 5 kB
gzip of the file's ≈ 24 kB). It rewrites only its own lines and keeps the roads; `roads.ts` keeps the railways the same
way, so the two bakes can run in either order. Same licence and attribution.

| Product | LDS layer | Used for |
|---|---|---|
| NZ Railway Centrelines (Topo, 1:50k) | 50319 | the lines: NIMT (with the Eastern line), North Auckland Line (Western line), Newmarket line, Onehunga, Southdown, Mission Bush and Glenbrook branches |
| NZ Tunnel Centrelines (Topo, 1:50k) | 50366 (`use1='train'`) | runs in a tunnel (Britomart, Parnell) |

```sh
export LINZ_API_KEY=…            # free key from https://data.linz.govt.nz (never commit it)
npx vite-node tools/linz/railways.ts <work> [preview.svg]
```

What comes out: the lines chained by name and track type, clipped to the 88 km world (the North Auckland Line runs on
to Whangārei), Douglas–Peucker 1.5 m. Sidings (yards, freight spurs) and the Waitākere bush tramways are left out. The
width is the formation: 11 m for a double track, 6 m for a single one, so the ribbons read from altitude. Runs within
25 m of a train tunnel and parallel to it, between its portals, are flagged as tunnels. In the game (`motorways.ts`,
`aucklandRailPaths`) they are ballast-and-track ribbons in one mesh of their own (`QUALITY_PRESETS.railways`), and they
join the `RoadNetwork` so houses, trees and towers keep off the tracks.

# Phase 2b: CBD buildings (outlines + LiDAR heights)

`buildings.py` and `buildings.ts` bake the CBD's real buildings into `src/world/terrain/data/auckland-buildings.bin`
(≈ 37 kB gzip), fetched next to the road data (`src/world/scenery/aucklandBuildings.ts`). Same licence and attribution.

| Product | Source | Used for |
|---|---|---|
| NZ Building Outlines | LDS layer 101290 (the current outlines, not *All Sources* 101292) | footprints |
| Auckland Part 1 LiDAR 1m DSM / DEM (2024) | `s3://nz-elevation/auckland/auckland-part-1_2024/{dsm,dem}_1m/2193/` (sheets BA31_10000_0405, BA32_10000_0401) | heights (DSM − DEM) |

```sh
pip install numpy scipy rasterio pyproj shapely
export LINZ_API_KEY=…            # free key from https://data.linz.govt.nz (never commit it)
python3 tools/linz/buildings.py <work>                       # outlines + heights → <work>/buildings.json (+ spotchecks.json)
npx vite-node tools/linz/buildings.ts <work> [preview.svg]   # → auckland-buildings.bin, tests/fixtures/linz-buildings-spotchecks.json
```

The WFS download (`outlines.json`) and the 1 m LiDAR window over the CBD box (`lidar.npz`, ≈ 40 MB, two Cloud-Optimised
GeoTIFF window reads per product) are cached in `<work>`. The DEM is the one of the same 2024 survey, not the national
mosaic: same epoch and ground classification as the DSM.

How it works:

- **Heights**: nDSM = DSM − DEM on the pixels ≥ 1 m inside each footprint (no edge mixing). When a roof's heights fall into
  two classes (Otsu threshold, classes ≥ 8 m and 20 % apart) the upper pixels' connected components become their own prisms
  (convex hull ∩ footprint), split again in turn, up to three levels: towers on podiums, setbacks, crowns. A level keeps the
  90th percentile of its pixels (the 75th for a podium around a tower); a roof that is clearly one tilted plane (least-squares
  fit, residual < 35 % of the spread, slope 0.1–1.2) keeps the plane. The Sky Tower's shaft and pod (hand-built) are ignored.
- **2017 outlines vs 2024 LiDAR**: the outlines come from the 2017 aerial photos. Outlines with nothing ≥ 2.5 m standing on
  them in 2024 are dropped (demolished, building sites: 170 of 3165). Buildings completed since (PwC Tower, Pacifica, …) are
  traced from the LiDAR: ≥ 8 m above the ground outside every outline, compact, and either ≥ 30 m tall or smooth and
  straight-edged below that (trees are rough at 1 m and their outlines wander); `buildings.ts` also drops traced
  footprints over a street, a motorway or a park (street trees, viaducts).
- **Footprints**: courtyards filled (invisible from the air, half the triangles), Douglas–Peucker 0.5 m, < 30 m² dropped.
- **Kept**: the buildings whose footprint centroid is inside the CBD region (phase 2a), ≈ 1050 buildings / 1350 prisms.
  Outside it the procedural suburbs and their street grid stay (the real outlines would clash with them).
- **Spot checks**: `buildings.py` measures the raw LiDAR (median within 4 m) at the roofs of PwC Tower, Vero Centre, Pacifica,
  ANZ Centre and Metropolis (the highest crane-free roof near each one's hand-placed position) and inside 40 random outlines;
  `tests/world-buildings.test.ts` checks the baked roofs there to ±5 m.

At runtime `buildCBD` (scenery/auckland.ts) extrudes every prism from the terrain at the building's lowest corner to its roof
(the terrain at the centroid + the LiDAR height), into the city's single merged mesh. Facade colour and window style by height
class; red obstruction lights on the towers over 95 m; at night `buildFacadeLightPoints` (nightLights.ts) lights their
windows floor by floor, replacing the flat light carpet inside the CBD region. Medium tier: ≈ 45 k triangles (the procedural
towers: ≈ 36 k), the same draw calls. Without the file the procedural towers on the real streets remain.

## Photo roofs (#140)

The aerial photo below lies on the CBD buildings' roofs too, each where the photo shows it: a standard orthophoto leans a
roof off its footprint by its height × the camera's lean. `roofs.ts` and `roofs.py` add one offset per building to
`auckland-buildings.bin` (format v2) and change nothing else in it, so they run after any re-bake of the buildings
(`buildings.ts` writes them without offsets):

```sh
pip install numpy scipy rasterio pyproj pillow
npx vite-node tools/linz/roofs.ts dump <work>          # the buildings the game draws from the file → roofs-in.json
python3 tools/linz/roofs.py <work> [--check] [--spot]  # offsets → roofs.json (+ roofs-report.json, roofs-rows.json, pictures)
npx vite-node tools/linz/roofs.ts bake <work>          # → auckland-buildings.bin
```

`roofs.py` reads the 1:1000 tiles' 1/4 overviews over the CBD (0.3 m, 30 tiles, ~1 min, cached in `<work>/tiles`) and
matches each outline's edges to the photo's, every side at once (the method and every threshold are in its header).
2026-10-05: of the 916 buildings the game draws from the file, 755 are registered (offsets: median 1.2 m, p90 3.0 m, at
most 6.9 m; their lean field: 0.07 m per metre median), 101 roofs under 35 m take the field's predicted offset and 2 none,
58 roofs of 35 m and over failed and keep the plain roof (of 150 over 35 m). +1.3 kB gzip. `--spot` re-measures the ten
tallest registered roofs at 0.15 m (`tests/fixtures/linz-roof-spotchecks.json`): nine agree within 0.21 m; the tenth
(row 1024, an oval roof between two others) the 0.15 m search alone puts 6.3 m off on a neighbour's edge, and the 0.3 m
overlay shows the baked offset on the roof. `--check` draws the ten tallest on the game's own photo.

## Facade tags (#141)

`facades.py` and `facades.ts` add each CBD building's OpenStreetMap tags to `auckland-buildings.bin` (format v3), for its
facade (use, storeys, material, colour; `auckland.ts buildingFacade`), keeping every other byte:

```sh
pip install shapely
npx vite-node tools/linz/roofs.ts dump <work>        # (as above)
python3 tools/linz/facades.py <work>                 # OSM main API, 3 x 3 tiles (~70 MB, cached in <work>/osm) → facades.json
npx vite-node tools/linz/facades.ts bake <work>      # → auckland-buildings.bin
```

A building takes the tags of the OSM building outline covering most of its footprint, if it covers at least half of it.
2026-10-05: 531 of the 916 buildings the game draws from the file are tagged (apartments 125, education 78, retail 67,
commercial 60, office 24, civic 19, hotel 15, industrial 12, parking 8, house 2; 326 with `building:levels`, 10 with a
material, 5 with a colour). +0.9 kB gzip. OSM data: © OpenStreetMap contributors, ODbL 1.0 (the file is a derivative
database for these tags).

# Open data 4: CBD and waterfront aerial photo

`aerial-mask.ts` and `aerial.py` bake the LINZ Auckland 0.075 m Urban Aerial Photos (2024–2025) into
`src/world/terrain/data/auckland-aerial-2048.webp` (≈ 274 KiB, medium tier) and `auckland-aerial-4096.webp`
(≈ 625 KiB, high tier), loaded by `src/world/terrain/theaters/aucklandAerial.ts`. Same licence and attribution as above.

| Product | Source | Used for |
|---|---|---|
| Auckland 0.075m Urban Aerial Photos (2024-2025), RGB | `s3://nz-imagery/auckland/auckland_2024_0.075m/rgb/2193/` (LDS layer 121752; public bucket, no API key). The tiles over the square were all flown in January 2024 | ground colour and wharf tops over the photo square |

```sh
pip install numpy scipy rasterio pyproj pillow
npx vite-node tools/linz/aerial-mask.ts <work>     # coastline / OSM deck / CBD street masks on the photo grid
python3 tools/linz/aerial.py <work>                # writes both .webp files and prints the alignment report
```

The first run reads every item of the STAC collection (≈ 17,700 JSONs, ≈ 10 min) to find the 154 tiles over the
square; the list and the 0.6 m mosaic are cached in `<work>`. Then ≈ 1 min (the COGs' 1/8 overviews, ≈ 20 MB).

- **Square**: `AERIAL_RECT`, x −1536 … 3584, z −3072 … 2048 (5.12 km): Westhaven to the Fergusson terminal, Devonport and
  the naval base to the Domain, Grafton and Parnell. The issue's 4 × 4 km at 0.5–1 m in ≤ 500 KB is not reachable: the
  4096² file at 1.25 m is ≈ 625 KiB even with the harbour masked out (the photo itself is ≈ 1 MB at that quality), so
  the medium tier gets 2048² (2.5 m) for 274 KiB and the high tier 4096². GPU memory with mips: ≈ 22 MB / 89 MB.
- **Reprojection**: NZTM2000 → game XZ (`geoToWorld`, equirectangular about the Sky Tower) with pyproj on a 129² lattice,
  bilinear in between (an affine fit would be off by up to 0.8 m; grid convergence here is ≈ 1.06°), sampled at 0.625 m
  and box-filtered to 1.25 m.
- **Alignment** (printed by `aerial.py`): the photo's water against the game's LINZ coastline cross-correlates at
  0 m offset over both the CBD waterfront and Devonport; overlays of the LINZ CBD carriageways and the OSM wharf
  outlines on the photo agree to ≈ 1–2 m by eye. (The street cross-correlation peaks 9 m east, but that is the
  building lean and cast shadows hiding one side of each street, not a shift: the coast and the wharf edges show none.)
  The 7.5 cm photos are not true orthophotos: tall towers lean up to ≈ 25 m away from the frame centres, so the CBD's
  3D towers keep their own roofs.
- **Grade**: luminance pulled toward its 12 m neighbourhood in the log domain (dark side × 0.45, bright side × 0.75:
  cast shadows and sunlit faces flatten, roofs and markings stay), the blue sky-lit chroma of the shadows moved 70 %
  toward the neighbourhood's, then the land's median luminance set to the procedural suburbs' far albedo
  (≈ 0.085 linear), so the photo carries no strong sun of its own and the fade at the square's edge does not jump.
- **Alpha** = land ≥ 2 m inside the LINZ coastline (the game's shore band paints the last metres) or inside an OSM
  wharf / pier / breakwater / dock outline; the open water is push-pull padded from the land colour.

At runtime (medium / high tier, *Aerial photo* setting, `?aerial=0` to compare): the terrain shader mixes the photo
over its procedural colour by alpha × a 320 m fade at the square's edge, skips the street / house / paddock patterns
by day where it fully covers (at night they still run for their lamps and lit windows, over the dim photo), and keeps
a trace of the shore band and a faint fine grain under 1.3 km. The wharf decks (`akl-waterfront`) and the naval base
(`akl-sites`) take it on their upward faces. No scattered houses or trees and no procedural suburb-centre blocks
stand where its fade is over ½. `e2e/aerial-shots.mjs` renders the before / after views.
