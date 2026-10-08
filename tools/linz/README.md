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

`roads.ts` bakes LINZ road centrelines into `src/world/terrain/data/auckland-roads.bin` (≈ 68 kB gzip with the railways and the island and Devonport roads), fetched next to
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

## Island and Devonport roads (#127)

`islandRoads.ts` adds every road of the gulf islands (Waiheke, Rangitoto, Motutapu, Motuihe, Rakino, Rotoroa, Pakatoa)
and of the Devonport peninsula to the same file as **local roads** (kind `ROAD_LOCAL`): where #121's real houses stand
(the coverage grid of `auckland-houses.bin`) and the procedural street grid is off. `roads.ts` runs it in a full re-bake;
after a re-bake of the houses, `island-roads.ts` replaces just the local roads:

```sh
npx vite-node tools/linz/island-roads.ts <work> [preview.svg]   # SVG_BOX="x0,z0,x1,z1" picks the preview's view
```

| Product | LDS layer | Used for |
|---|---|---|
| NZ Addresses: Road Sections | 123109 | every section on the coverage, outside the CBD region and not along a ribbon already baked (Lake Rd, Victoria Rd, Bayswater Ave) |
| NZ Road Centrelines (Topo, 1:50k) | 50329 | the surface (`surface`: sealed / metalled / unmetalled, `lane_count`), matched to a section by road id (`rna_sufi` = `road_id`) within 40 m or any line within 20 m, the section's majority; and the island roads with no address sections (Rangitoto's summit and Islington Bay roads, Motutapu's and Motuihe's farm roads), sealed and metalled only, where they run over 25 m from every address section |

- Left out: footpaths (accessways, walks, steps, tracks), and the address data's placeholder "roads" with no road type
  named after an island, bay, inlet or beach (Motutapu Island, Rotoroa Island, Matiatia Bay, Blackpool Beach): lines
  round a shore, up to 15 m out to sea. Stretches off the coastline longer than 60 m (wharves) are cut; shorter ones
  (causeways) stay, drawn at least 1.2 m over the water, without a deck.
- Widths (m): island roads 7 for the sealed spine (`ISLAND_MAIN`: Ocean View, Onetangi, Waiheke, Te Whau, Orapiu, …),
  6 for other sealed roads, 4.5 for one-lane roads, lanes and every unsealed road; Devonport's streets 9 (parking both
  sides), lanes and places 6.
- 2026-10-07: 1,257 sections (80 footpaths, motorways and placeholders skipped) and 44.8 km from Topo50 → 894 ribbons:
  islands 129.0 km sealed + 80.8 km unsealed, Devonport 58.8 km. The file grew from 46.9 kB to 67.8 kB gzip (89 kB raw).
- Checked on the 2024 photo (the 2.4 m mosaics `aerial.py` caches, every ribbon drawn on them): Waiheke's, Rakino's and
  Devonport's roads lie on the photographed roads; the Topo50 lines on Rangitoto and Motutapu within a few metres in most
  places, ≈ 10–20 m off on some bends (1:50k).

At runtime `RoadNetwork` holds them like the other ribbons (houses, real houses, trees and the canopy keep off), drawn
as one mesh of their own (`akl-local-roads`, Scenery.ts): two vertices across, unlit, no lamp posts and no frontage lots,
the sealed or gravel half of `createLocalRoadTexture`.

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

# Open data 4: CBD and waterfront aerial photo (and Devonport and the gulf islands, #120)

`aerial-mask.ts` and `aerial.py` bake the LINZ Auckland 0.075 m Urban Aerial Photos (2024–2025) into
`src/world/terrain/data/auckland-aerial-2048.webp` (≈ 274 KiB, medium tier) and `auckland-aerial-4096.webp`
(≈ 625 KiB, high tier), loaded by `src/world/terrain/theaters/aucklandAerial.ts`, and (#120) the outer atlas of the rest
of the Devonport peninsula and the gulf islands, `auckland-aerial-outer-2048.webp` (≈ 272 KiB, medium) and
`auckland-aerial-outer-4096.ktx2` (≈ 2.5 MiB, high; GPU-compressed, its alpha beside it in
`auckland-aerial-outer-cover.png`, 28 KiB) with its layout `auckland-aerial-outer.json`. Same licence and attribution
as above.

| Product | Source | Used for |
|---|---|---|
| Auckland 0.075m Urban Aerial Photos (2024-2025), RGB | `s3://nz-imagery/auckland/auckland_2024_0.075m/rgb/2193/` (LDS layer 121752; public bucket, no API key). The tiles over the square were all flown in January 2024 | ground colour and wharf tops over the photo square |

```sh
pip install numpy scipy rasterio pyproj pillow
python3 tools/linz/aerial.py <work> city     # the square: both .webp files, its alignment report (runs aerial-mask.ts)
python3 tools/linz/aerial.py <work> outer    # the outer atlas (Devonport, the islands), its seam and alignment reports
python3 tools/linz/aerial.py <work> align    # the outer boxes' seam and alignment reports again (needs LINZ_API_KEY)
python3 tools/linz/aerial.py <work> outer-ktx2 [atlas.png]   # the high tier's KTX2 + cover again from a saved atlas
```

The high tier's outer atlas is encoded with the Basis Universal CLI (`basisu`, github.com/BinomialLLC/basis_universal,
built with cmake; `$BASISU` or on the PATH). `outer` saves the atlas as `<work>/aerial-outer-4096.png`, so `outer-ktx2`
can re-encode it alone.

`aerial-mask.ts <out.bin> <x0> <z0> <cols> <rows> <cell>` writes the coastline / OSM deck / CBD street / land masks on
any photo grid (aerial.py runs it per box and caches it). The first run reads every item of the STAC collection
(≈ 17,700 JSONs, 3–10 min) into `<work>/stac-all.json`, reused by every later bake (and by other layers that need
the 7.5 cm tiles); each box's mosaic (`aerial-mosaic-<box>.npz`), masks and graded image (`aerial-rect-<box>.png`)
are cached in `<work>` too. The square then takes ≈ 2 min (117 tiles, the COGs' 1/8 overviews), the outer atlas
≈ 4 min (the Devonport boxes' 74 tiles at 1/8, the islands' 697 tiles at 1/32). Re-running `city` reproduces the
committed square byte for byte. Delete a box's `aerial-rect-*.png` to bake it again.

### Game shots next to the 2024 photo (#124)

`photo-compare.py` puts an e2e shot script's frames beside a north-up crop of the same photo round each view's look
point, with the camera and its line of sight drawn on it. It reads the views from the script, so the two never drift:

```sh
node e2e/landmark-shots.mjs --out=<shots>                       # the game frames, <shots>/124-<view>-after.png
python3 tools/linz/photo-compare.py <work> <shots>              # docs/screenshots/real-suburbs/124-<view>.jpg
python3 tools/linz/photo-compare.py <work> <shots> --script=e2e/corridor-shots.mjs --prefix=126 --tag=streamed-after
```

It lists the tiles from their names in the 1:1000 grid (sheet BA32's north-west corner is E 1,756,000, N 5,946,000;
tiles of 480 × 720 m named `<sheet>_1000_<row><col>`) rather than crawling the STAC items, so a view takes ≈ 20 s
(about 24 tiles at the 1/16 overview). The bucket now and then answers a ranged read with a stray 404 through the
cloud container's proxy; the script sets GDAL to retry on every code.

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

**The outer atlas (#120).** Boxes (`OUTER` in `aerial.py`, game XZ) packed into one atlas per tier (4096 px wide on
high, 2048 on medium, the same layout halved), each with a 32 px apron of real photo round it (16 on medium) so
filtering and the first mips never mix in a neighbour:

| Box | x, z (m) | Pixel (high / medium) | Fade |
|---|---|---|---|
| `devonport_north`: Stanley Bay, Bayswater, Belmont, Narrow Neck | −1 … 4479, −5499.5 … −2749.5 | 1.25 / 2.5 m (the square's) | 320 m; overlaps the square's north fade, fades out across the Hauraki neck north of Belmont |
| `devonport_east`: Cheltenham, North Head | 3261.5 … 5001.5, −3069.5 … −1399.5 | 1.25 / 2.5 m | 320 m; overlaps the square's east fade and `devonport_north`'s south fade |
| `waiheke` (with Pakatoa, Rotoroa) | 19380 … 39420, −12420 … 160 | 5 / 10 m | 60 m, in the sea |
| `rangitoto_motutapu` | 5720 … 15780, −13280 … −4200 | 5 / 10 m | 60 m |
| `motuihe`, `rakino`, `browns` | (see `OUTER`) | 5 / 10 m | 40–60 m |

- **Seamless Devonport.** The Devonport boxes lie on the square's pixel lattice and use the square's exposure, so where
  they overlap it their pixels are the square's (`seam` lines of the report: 0.00 m, colour difference 0.00 / 255).
  Overlapping boxes fade across each other over their feather; the weights add up to ≥ 1 there, so the only fade on
  the peninsula's land is the one across the neck north of Belmont (z −5500 … −5180).
- **Islands' alpha** = the land wholly inside the box (a land component the box's edge cuts, Ponui's tip inside
  Waiheke's box, stays procedural); decks are left out there. It also reaches 90 m out to sea (`SEA_BAND`, the
  photo's real shallows and beaches): the islands lie beyond the 32 km coast mask round the city, where the drawn
  shoreline is the heightfield's own (86 m cells on medium), and a strip of terrain standing above the water between
  it and the LINZ line read as bright procedural grass round every bay (the sea covers the rest of the band).
- **Resolution.** Measured per tier before choosing: the whole atlas is 272 KiB on medium and 599 KiB on high (the
  islands at 5 m and Devonport at 1.25 m are in the high one). At 5 m the high atlas is 4096 × 6724 (147 MB of GPU
  memory with mips); the islands at 5 m on medium would have needed a 4096-wide atlas too (≈ 100 MB on a phone), so the
  medium tier has them at 10 m (2048 × 3362, 37 MB): Rangitoto's lava and bush patches and Waiheke's vineyard blocks
  still show at 10 m, its vine rows don't at either.
- **High tier as KTX2 (ETC1S).** Measured on the 4096 atlas, against its WebP: GPU memory ≈ 140 → 35 MB (it stays
  in the GPU's block format: BC7 on desktops, ASTC / ETC2 on phones, 1 byte a pixel, alpha included), load
  1.8–2.8 s → 0.6–0.8 s and main-thread upload with mips 0.35–1.3 s → ≈ 90 ms (headless Chromium on SwiftShader, so
  CPU-bound; the transcode runs in a worker), for a download of ≈ 2.5 MiB instead of 0.6 (plus three.js's Basis
  transcoder, ≈ 245 KiB gzip, once). Quality on land: 36.8 dB PSNR against the WebP; up close it loses some local
  colour (red roofs duller, a blue tinge in shadow), at the heights players see it from it reads the same, and it is
  still sharper than the medium atlas at the same GPU memory. UASTC looked closer to the WebP but weighed 10.5 MiB.
  The medium tier stays WebP: 35 MB is fine there and ETC1S would almost triple its download. A block-compressed
  atlas needs sides that are multiples of 4 (the medium one, 3362 px tall, rendered black as KTX2).
- **Grade.** The city square's exposure for every box (the islands' own would be ×1.1–2.2 brighter: bush is darker than
  a suburb), so the islands sit in the same light as the city.
- **Alignment.** The plain cross-correlation of the photo's water against the coastline (the square's check) does not
  work here: Shoal Bay's mudflats and mangroves and the islands' reefs and beaches are dry in the photo but sea in the
  high-water coastline, and the photo's blue-green cast makes shaded gardens look like water. The report has two
  checks instead: (1) along the coast's normal every 5 m, where the photo's (smooth, blue) water ends, fitted as a
  translation plus a mean waterline shift with outliers trimmed; and (2) the photo's roof edges cross-correlated
  with the LINZ NZ Building Outlines (layer 101290, WFS, `LINZ_API_KEY`) over dense houses. Measured (east, south):
  buildings Bayswater / Belmont +1.1, −0.0 m; Cheltenham +0.6, +0.4 m; Oneroa +1.4, +0.8 m; Surfdale / Ostend +1.5,
  +1.1 m, against +0.9, +0.5 m for the square itself (Freemans Bay), i.e. 0 at the pixel. The coast fit gives
  Waiheke −1.0, +5.2 m and Rangitoto–Motutapu −0.5, +5.2 m (≈ 1 pixel of the islands' 5 m; the coastline itself is
  traced on a 16 m grid; Rakino −10, +9 and Motuihe −7, +3 m with a few hundred edges each), with the waterline
  10–17 m seaward of the high-water line (the photos were flown on a falling tide); the Devonport boxes have too few
  clear water edges (beaches, mudflats) for it to mean much.

At runtime (medium / high tier, *Aerial photo* setting, `?aerial=0` to compare): the terrain shader mixes the photo
over its procedural colour by alpha × a 320 m fade at the square's edge, skips the street / house / paddock patterns
by day where it fully covers (at night they still run for their lamps and lit windows, over the dim photo), and keeps
a trace of the shore band and a faint fine grain under 1.3 km. The wharf decks (`akl-waterfront`) and the naval base
(`akl-sites`) take it on their upward faces. No scattered houses or trees and no procedural suburb-centre blocks
stand where its fade is over ½. `e2e/aerial-shots.mjs` renders the before / after views.

# Real suburbs 2/9: real houses on Devonport, Waiheke and the gulf islands (#121)

`houses.py` and `houses.ts` bake the houses under #120's photo of the Devonport peninsula and the gulf islands into
`src/world/terrain/data/auckland-houses.bin` (≈ 130 kB gzip, every tier), decoded by `src/world/scenery/aucklandHouses.ts`
and drawn by the house scatter (`HouseSource`) through its instanced house and apartment archetypes. Same licence and
attribution as above.

| Product | Source | Used for |
|---|---|---|
| NZ Building Outlines | LDS layer 101290 (WFS, `LINZ_API_KEY`), one request per area box | footprints → rectangles |
| Auckland Part 1 and Part 2 LiDAR 1m DSM / DEM (2024) | `s3://nz-elevation/auckland/auckland-part-{1,2}_2024/{dsm,dem}_1m/2193/`, whole sheets (25 per product, ≈ 900 MB in all) | eave, roof pitch, gone since 2017, new since 2017 |
| Auckland 0.075m Urban Aerial Photos (2024-2025) | the mosaics `aerial.py` caches (0.6 m over Devonport, 2.4 m over the islands) | roof colours, the houses' registration on the photo |

```sh
pip install numpy scipy rasterio pyproj shapely pillow
python3 tools/linz/aerial.py <aerial work> outer                    # (#120) the photo mosaics, if not cached
LINZ_API_KEY=… python3 tools/linz/houses.py <work> <aerial work> fetch   # the LiDAR sheets → <work>/../lidar
LINZ_API_KEY=… python3 tools/linz/houses.py <work> <aerial work>         # → <work>/houses.json, house-spotchecks.json (≈ 3 min)
npx vite-node tools/linz/houses.ts <work>                           # → auckland-houses.bin, tests/fixtures/linz-house-spotchecks.json
```

How it works (the details and every threshold are in `houses.py`'s header):

- **Areas**: every outline whose centre the photo covers (its summed weight over ½: `aerialCovers`): the North Shore side
  of the harbour inside the city square and the two Devonport boxes (Devonport, Stanley Bay, Cheltenham, Narrow Neck,
  Bayswater, Belmont, Northcote Point at the square's edge), and the land of the island boxes (Waiheke with Pakatoa
  and Rotoroa, Rangitoto, Motutapu, Motuihe, Rakino; Browns Island has no outlines). Outlines over 600 m² (schools,
  halls, shops, apartment blocks: #124's) and under 20 m² are left out.
- **Rectangles, not polygons**: each outline becomes the rectangle along its dominant edge direction with its centroid,
  its second moments along both axes and its area (an L-shaped villa gets the rectangle of its mass), drawn through the
  scatter's instanced archetypes, so no polygon is extruded and no draw call is added.
- **Roofs**: on the nDSM inside the outline shrunk 0.7 m, h = eave + pitch · d for a gable along either axis, a hip over
  the rectangle and a hip along the outline itself (d = the distance to its nearest edge), least squares refitted
  without outliers; pitched when clearly better than flat, else a roof whose heights spread over a metre runs from its
  p15 to its p90. In the game every pitched roof is a gable along the ridge direction (the house archetype; the ridge's
  rise is per instance); a flat roof with its eave at 8 m or more is an apartment block.
- **2017 vs 2024**: an outline with less than 2 m standing on most of it in 2024 is dropped (gone); buildings since are
  taken from the LiDAR where 2.5–15 m stands outside every outline, smooth (a roof, not a canopy), not green in the
  photo, compact and straight-edged, 40–600 m², and fits a roof plane to 0.35 m RMS (pohutukawa crowns read smooth
  at 1 m; the photo's colour and the plane fit keep them out).
- **On the photo's roofs**: the 2024 photo is a standard orthophoto (a roof drawn displaced from its footprint by its
  height × the camera's lean) and the 2017 outlines carry their own photos' lean, so the houses are moved by the
  photo-vs-outline offset measured every 400 m where the outlines are dense (the photo's luminance gradient
  cross-correlated with the outlines' edges over a 300 m window, #120's alignment method). Devonport: 50 cells, median
  +0.35 m east, +0.30 m north; Waiheke: 79 cells; the small islands are too sparse to measure and stay as traced.
- **Coverage**: the land under those photo boxes (32 m cells) ships with the houses; there the procedural lots, streets,
  houses, frontage lots and centres' blocks step aside on every tier (`houseCoverage` → `Scenery.siteMask`).
- **Spot checks**: 20 random Devonport houses (60–400 m²); the photo's roof under each is the outline moved by the
  photo-vs-outline offset of a 100 m window round it (one house alone registers badly: a gable's lit and shaded slopes
  make an edge half a roof away). `tests/world-houses.test.ts` checks the baked centres within 2 m of it (2026-10-07:
  median 0.37 m, max 1.57 m) and the ridges within 2 m of the LiDAR roof's p95.

2026-10-07: 22,712 outlines in the area boxes; 17,088 houses baked (Devonport 8,314, Waiheke 8,453, Rangitoto and
Motutapu 108, Motuihe 9, Rakino 212; 73 of them new since 2017 from the LiDAR), 170 over 600 m² left for #124, 632
gone since 2017. 143.6 kB of houses raw (8.40 B a house) + 6.2 kB of coverage; 129.8 kB gzip (7.60 B a house; the
houses alone 7.32 B).

# Real suburbs 7/9: the corridor's real houses and streets, streamed (#126)

`corridor-houses.py` and `corridor-houses.ts` bake every house and local street from Whenuapai to Auckland Airport into
136 tiles of 2,048 m, `src/world/terrain/data/corridor/akl-corridor-<i>_<j>.bin` (gzip; ≈ 2.4 MB in all, the same on
every tier), and their manifest `corridor.json` (bundled: tiles, bytes, the shared roof palette). The game fetches a tile
as the house scatter's radius reaches it (`src/world/scenery/corridorHouses.ts`); the service worker caches it on first
use and never precaches it (`public/sw.js` `ON_DEMAND`). Same licence and attribution as above.

| Product | Source | Used for |
|---|---|---|
| NZ Building Outlines | LDS layer 101290, per LiDAR sheet as `canopy.py` (#123) cached them in `<work>/../canopy/outlines/` | footprints → rectangles |
| Auckland Part 1 LiDAR 1m DSM / DEM (2024) | the 19 sheets of the corridor in `<work>/../lidar/part1/` (`canopy.py fetch`) | eave, roof pitch, gone since 2017, new since 2017 |
| Auckland 0.075m Urban Aerial Photos (2024-2025) | COG overview 1/16 (1.2 m), one mosaic per sheet (`aerial.py` `mosaic()`, cached in `<aerial work>`; ≈ 150 tiles a sheet by range requests) | roof colours, the trees-vs-roofs test |
| NZ Addresses: Road Sections | LDS layer 123109 (WFS, `LINZ_API_KEY`), 4 km boxes cached in `<work>` | the local streets (#127 phase B) |

```sh
python3 tools/linz/canopy.py fetch /home/user/work/canopy                 # (#123) the sheets and outlines, if not cached
python3 tools/linz/corridor-houses.py /home/user/work/corridor           # → corridor-houses.json (≈ 12 min, 4 processes)
LINZ_API_KEY=… npx vite-node tools/linz/corridor-houses.ts /home/user/work/corridor   # → the tiles, corridor.json, tests/fixtures/corridor-house-spotchecks.json (≈ 4 min)
```

How it works (the details are in the two files' headers):

- **The corridor**: the box of epic #119's count (lon 174.58 … 174.86, lat −37.03 … −36.76) inside the 19 Part 1 sheets
  `canopy.py` reads (604 km² with the water). Its edges outside them (≈ 15,600 outlines: a 1 km strip west of
  Hobsonville, 0.4 km of Ōtāhuhu east of E 1765600, Papatoetoe and the Manukau shore south of the airport) stay
  procedural.
- **Houses**: `houses.py`'s fit (#121) on every outline of 20–20,000 m²: an oriented rectangle, the LiDAR roof, gone since
  2017, the LiDAR-only buildings since 2017 (the photo's green test at 1.2 m), the photo's roof colour at the city
  square's exposure in a 256-colour palette of the corridor's own. Unlike #121 the buildings over 600 m² are kept (shops,
  warehouses, apartment blocks: nothing else draws them here, and the procedural sheds step aside); one longer than a
  record holds (63 m) is cut into equal flat pieces. Not registered to the photo (#121's lean field): the game shows no
  photo here, and the houses stand where LINZ traced them.
- **Left out** (`corridor-houses.ts`): houses in the water, in the CBD region (its LINZ buildings), on #121's coverage
  (Devonport), on the landmark and hero sites (`siteRings`, `siteBlocker`: #124's sites and footprints, the hero
  neighbourhoods, the stadiums, the port, the oil terminal) and the OSM aerodromes (the airfields' own buildings).
- **Coverage** (32 m cells, in each tile): the corridor's land outside the CBD region and #121's coverage.
- **Streets (#127 phase B)**: every road section on the coverage that is not a footpath, a motorway or a placeholder, not
  along a ribbon already baked (motorways, arterials, the hero neighbourhoods' streets) and outside the hero
  neighbourhoods: a sealed `ROAD_LOCAL` ribbon, 9 m kerb to kerb (lanes and places 6 m), cut at the tiles' edges.
- **Tile file**: `'AKLC'`, version, a houses file (`aucklandHouses.ts` format, no palette of its own, the tile's coverage
  grid) and a roads file (`aucklandRoads.ts` format, no region, no names).

2026-10-07: 345,316 outlines in the sheets (9,679 outside the box, 22,536 under 20 m², 46 over 20,000 m²); 307,120 houses
fitted (12,256 outlines gone since 2017, 6,326 LiDAR-only buildings since); 285,961 records in the tiles after the
exclusions (CBD region 2,155, Devonport 8,443, sites 12,891, aerodromes 320, water 139, landmark footprints 24; 2,303 big
outlines cut into 4,661 pieces). Streets: 28,483 sections → 14,159 ribbon pieces, 2,109 km. **2,357,689 B gzip** in all
(8.24 B a house): the houses alone 2.16 MB (7.57 B a house), the streets 179 kB, coverage and cell tables ≈ 82 kB raw.
A tile: median 15.0 kB, p90 36.8 kB, max 46.7 kB.

## Real tree canopy (#123)

`canopy.py` and `canopy.ts` bake the real tree canopy of the suburbs and the gulf islands into
`src/world/terrain/data/auckland-canopy.bin` (213 kB gzip; medium and high tiers, loaded with the land use by
`src/world/terrain/theaters/aucklandCanopy.ts`). Same licence and attribution.

| Product | Source | Used for |
|---|---|---|
| Auckland Part 1 LiDAR 1m DSM / DEM (2024) | `s3://nz-elevation/auckland/auckland-part-1_2024/{dsm,dem}_1m/2193/`, 20 sheets (`PART1_SHEETS`: BA31 0303–0305, 0403–0405, 0503–0505; BA32 0301, 0302, 0401, 0402, 0404, 0501, 0502; BB31 0105; BB32 0101, 0102, 0201), gaps filled from Part 2 | canopy height (DSM − DEM): Devonport, the North Shore to Takapuna, the CBD, the isthmus, Whenuapai → Māngere and the airport |
| Auckland Part 2 LiDAR 1m DSM / DEM (2024) | `auckland-part-2_2024`, the sheets under the island boxes of #120's photo (18) | Rangitoto, Motutapu, Browns Island, Motuihe, Rakino, Waiheke |
| NZ Building Outlines | LDS layer 101290 (WFS per sheet, `propertyName=shape`) | buildings out of the canopy (buffered 1 m) |
| NZ Suburbs and Localities | LDS layer 113764 | the test areas only (Mount Albert, Devonport, Māngere, Hobsonville; Rangitoto, Motutapu, Waiheke Island) |

```sh
export LINZ_API_KEY=…                                  # free key from https://data.linz.govt.nz (never commit it)
python3 tools/linz/canopy.py fetch /home/user/work/canopy   # sheets (≈ 2 GB, into <work>/../lidar, shared with houses.py), outlines, areas
python3 tools/linz/canopy.py bake /home/user/work/canopy    # ≈ 50 min on 3 processes; per-sheet results cached in <work>/sheets
npx vite-node tools/linz/canopy.ts /home/user/work/canopy   # → auckland-canopy.bin, tests/fixtures/linz-canopy-areas.json
```

How it works:

- **Tree pixel**: DEM ≥ 1 m (keeps the sea, beaches, mangroves and boats out), CHM ≥ 3 m, not inside a LINZ outline + 1 m,
  not one of #121's LiDAR-only houses (`houses.json`) and, outside #121's areas, not a building since 2017 by the CBD
  bake's test (smooth at 1 m, compact and straight-edged, 30–2,500 m²: without the cap pōhutukawa stands on Rangitoto
  and pine blocks on Waiheke went as "buildings"). A 2 × 2 opening and a 3-pixel minimum drop wires and poles. Hedges,
  sheds and cranes can still count; at 32 m they average out.
- **Grid**: tree and land pixels counted per 16 m cell of the land-use lattice (game XZ through a per-sheet quadratic fit of
  NZTM → `geoToWorld`, a few cm off), summed into 32 m cells: share = tree / land, 16 levels; a cell is covered when half its
  pixels are LiDAR of a covered sheet or island box. Heights: the trees' 75th percentile per 128 m. 776 km² covered.
- **Size**: an adaptive binary range coder (LZMA's) with the left and upper neighbours as context. 16 m cells were ≈ 640 kB
  at 16 levels (≈ 290 kB at 4), over the issue's 100–250 kB estimate, so the grid ships at 32 m: 194 kB of shares, 19 kB of
  heights. Decoding takes ≈ 0.1 s (desktop).
- **LiDAR canopy of the test areas** (1 m, the polygons themselves): Mount Albert 18.2 %, Devonport 20.8 %, Māngere 11.1 %,
  Hobsonville 11.9 %; Rangitoto 58.1 %, Motutapu 10.3 %, Waiheke Island 52.6 %. `tests/world-canopy.test.ts` checks the
  grid within 2 points and the scatter's crowns within 5 points of these.

# Real suburbs 5/9: landmark buildings — hospitals, stations, malls, schools (#124)

`landmark-buildings.py` and `landmark-buildings.ts` bake the big buildings people navigate by outside the CBD into
`src/world/terrain/data/auckland-landmarks.bin` (≈ 175 kB gzip, every tier; `src/world/scenery/aucklandLandmarks.ts`).
LINZ data: same licence and attribution as above. The sites are © OpenStreetMap contributors (ODbL 1.0): the file is a
derivative database, available under the ODbL, and these two scripts plus the Overpass queries in the Python file are
how to rebuild it (the Overpass timestamps are printed by the bake and kept in `<work>/osm-<kind>.json`).

| Product | Source | Used for |
|---|---|---|
| Sites | OpenStreetMap via Overpass (`maps.mail.ru` mirror; overpass-api.de and kumi refused the container): `amenity=hospital`, `shop=mall`, `railway=station`, `railway=platform`, `amenity=school` in the world box, `out body geom` (relations assembled from their member ways) | which outlines are a landmark's, the platforms, the site outlines (no procedural grid, lots or sheds there) |
| NZ Building Outlines | LDS layer 101290, WFS per site box (+30 m) | footprints |
| Auckland Part 1 / Part 2 LiDAR 1m DSM / DEM (2024) | `s3://nz-elevation/auckland/auckland-part-{1,2}_2024/`, a window per site: the sheets cached by `houses.py` / `canopy.py` in `<work>/../lidar`, others over HTTP (COG range reads; no sheet downloaded) | roof levels, buildings since 2017 |

```sh
export LINZ_API_KEY=…
python3 tools/linz/landmark-buildings.py fetch /home/user/work/landmarks   # Overpass (5 queries) + 611 WFS requests, ≈ 3 min
python3 tools/linz/landmark-buildings.py bake /home/user/work/landmarks    # ≈ 90 s with the 20 + 18 sheets cached
npx vite-node tools/linz/landmark-buildings.ts /home/user/work/landmarks [preview.svg]   # → auckland-landmarks.bin, tests/fixtures/landmark-spotchecks.json
```

Selection (2026-10-07 inputs): hospitals over 2 ha plus the priority list (Auckland City, Middlemore, North Shore,
Waitākere, Greenlane: checked by hand against the OSM names; the bake stops if one is missing) → 16 sites; malls over
7,000 m² plus Sylvia Park, Westfield St Lukes / Newmarket / Albany / Manukau City, LynnMall and NorthWest (Westgate) → 33;
all 44 `railway=station`s but MOTAT's tram stops, with the 77 above-ground platforms within 300 m (layer −1, an open
cutting, kept; underground and the depot's cleaning platforms left out); schools over 2,000 m² → 518. A building
belongs to the first site that holds its outline's representative point (hospitals, malls, stations, schools); an
outline #121 ships as a house (`houses.json` ids) is left to #121, and every outline over #121's 600 m² in its areas is
taken here as kind `other`. Heights: the CBD bake's level split (`buildings.py`) with a 5 m step; outlines standing on
less than ¾ of their area (a wing demolished since 2017) or round an open court of 40 m² are cut to what stands, their
courtyards split out. The `.ts` step leaves out what the game models already (the CBD region, the hero neighbourhoods,
Westfield Newmarket, Spark Arena, the Domain, aerodromes, the water), moves each platform across the railway ribbon
(beside the formation, or onto its centre line for an island platform; ≤ 16 m) with its canopies, drops 7 station
outlines standing on the ribbon (footbridges, concourses), simplifies the schools' outlines by 0.9 m and quantises
vertices to 0.5 m.

| Kind | Sites | Buildings | gzip alone |
|---|---|---|---|
| hospital | 16 (+1 second part of Middlemore) | 217 | 10 kB |
| mall | 29 | 66 | 8 kB |
| station | 43, 75 platforms | 121 (56 canopies) | 7 kB |
| school | 509 | 5,124 | 146 kB |
| other (#121's areas) | 62 tiles | 171 | 10 kB |

Spot checks (the ±5 m test, `tests/world-landmark-buildings.test.ts`): the highest smooth roof of every priority
hospital and mall (all 11 within 3.1 m; Auckland City Hospital 56.8 m LiDAR / 56.5 m baked) and two random one-level
outlines over 400 m² per site: 959 of 965 within 5 m, the rest pitched halls whose flat roof stands at the ridge (≤ 8.6 m).
