# OpenStreetMap pipeline (Auckland theatre)

Bakes OpenStreetMap layers into `src/world/scenery/data/auckland-osm.bin` (≈ 62 kB gzip), which the game fetches once per
page load next to the LINZ data (`src/world/scenery/aucklandOsm.ts`). It gives the theatre its **real airfield layouts**
(Open data 1, issue #32) and holds the waterside and strategic-site layers that Open data 2 (#33) builds on.

`landuse.py` bakes the **land-use grid** (issue #122) from the same inputs into `src/world/scenery/data/auckland-landuse.bin`
(436 kB gzip; medium and high tiers only, `src/world/scenery/aucklandLandUse.ts`): below.

Data © OpenStreetMap contributors, licensed under the [Open Database License 1.0](https://opendatacommons.org/licenses/odbl/1-0/).
`auckland-osm.bin` is a derivative database: it is also available under the ODbL, and this directory (the scripts, the
pinned inputs below and `manifest.json`) is how to rebuild it. The file's header repeats the attribution and the
extract timestamps. Credits: `docs/CREDITS.md` and the in-game credits screen.

**Never query OSM at runtime, and don't hammer Overpass**: the game reads only the baked file, and the bake reads a
downloaded extract.

## What goes in

Only the layers the game reads. Roads, streets and buildings come from LINZ (`tools/linz`), not from OSM.

| Layer | OSM tags | Used by |
|---|---|---|
| aerodrome | `aeroway=aerodrome` (areas) | airfield boundaries (#32) |
| runway, taxiway | `aeroway=runway` / `taxiway` (lines; split runway ways are joined by `ref`) | runways (checked against `src/core/airfields.ts`), concrete taxiways, blue edge lights |
| apron, hangar, terminal | `aeroway=apron` / `hangar`, `building=hangar`, `aeroway=terminal` (areas) | aprons, extruded hangars and terminals, apron floodlights |
| tower | `aeroway=control_tower` (or an aeroway ATC `man_made=tower`) | control tower position (none in the current data: a fallback places one) |
| helipad | `aeroway=helipad` / `heliport`, nodes and polygons (a polygon as its centre, its size in the width field, flag bit 3 = heliport) | #125: the count; the full table with heights is `helipads.py`'s (below) |
| pier, breakwater, marina, port | `man_made=pier` / `breakwater`, `leisure=marina`, `landuse=port` or `industrial=port` (every outer ring over 2,000 m²) | #33: port deck and berth faces, piers, pontoons, breakwaters, yachts (`src/world/scenery/aucklandSites.ts`) |
| dock | `waterway=dock` (areas) | #33: Calliope Dock at the naval base |
| storage tank | `man_made=storage_tank` at least 8 m across (farm water tanks dropped); flag for oil, fuel and gas content | airfield fuel farms; #33: Wiri terminal (`WIRI_TANKS` in `src/core/sites.ts`) |
| military, naval | `landuse=military`, `military=naval_base` | #33: Devonport Naval Base outline |
| depot | `landuse=industrial` + `industrial=oil` | #33: Wiri oil terminal outline |
| stadium, grandstand | `leisure=stadium` of at least 1 ha, `building=grandstand` | #33: Eden Park (and every other stadium with stands) |
| building | `building=*` whose centre is inside a port, military, naval or depot area; the height (`height`, else `building:levels` × 3.5 m) goes in the width field | #33: port sheds, naval base and terminal buildings |
| core (derived) | per aerodrome: the union of its runway strips (150 m each side of a sealed runway, 40 m for grass), taxiways (35 m), aprons, hangars and terminals (30 m), gaps under 80 m closed, holes filled, simplified to 15 m | the terrain levels this outline (`src/world/terrain/features.ts`) |

Geometry is projected with the game's equirectangular formula (`geoToWorld` in `src/core/auckland.ts`: origin = Sky Tower,
+X east, +Z south). It deliberately does not use NZTM, which would drift from the landmarks and the LINZ layers. Lines and rings
are simplified with Douglas–Peucker at 1 m and quantised to 0.5 m, then written as zig-zag varint deltas. The format is
described in `aucklandOsm.ts`. The world box is lon 174.31…175.21, lat −37.21…−36.49.

## Land use (`landuse.py`, #122)

A class per 16 m cell over the ±40 km world (5000², 4-bit classes; format in `landuse.py` and `aucklandLandUse.ts`):

| Class | OSM tags (areas) |
|---|---|
| residential | `landuse=residential` |
| commercial / retail | `landuse=retail` / `commercial`, `shop=mall`, `amenity=marketplace`, `amenity=parking` of at least 1,500 m² |
| industrial | `landuse=industrial` / `port` / `railway` / `depot` |
| park | `leisure=park` / `garden` / `recreation_ground` / `playground` / `dog_park` / `common`, `landuse=recreation_ground` / `grass` / `village_green` |
| pitch | `leisure=pitch` / `track` |
| golf course | `leisure=golf_course`; LINZ NZ Golf Course Polygons (Topo50, layer 50281) where OSM has none |
| school | `amenity=school` / `college` / `university` / `kindergarten`, `landuse=education` |
| hospital | `amenity=hospital`, `landuse=healthcare`, `healthcare=hospital` |
| cemetery | `landuse=cemetery`, `amenity=grave_yard`; LINZ NZ Cemetery Polygons (Topo50, layer 50255) where OSM has none |
| vineyard | `landuse=vineyard` |
| farmland | `landuse=farmland` / `orchard` / `meadow` / `farmyard` / `greenhouse_horticulture` / `plant_nursery` / `animal_keeping` |

Polygons are painted largest first, so a smaller one (a pitch in a park, a school in a residential zone) wins; then
unclassified gaps up to 32 m between two cells of one class (the streets between residential polygons) take that
class, which cuts the file by a third. A cell without a class keeps the game's hand-traced suburbs. Measured:
16 m cells 436 kB gzip (chosen), 8 m cells 998 kB; without the gap filling 603 kB at 16 m. `manifest.json`'s `landuse`
entry has the per-class areas and, for eight spot-check suburbs, the class shares computed exactly from the polygons,
which `tests/world-landuse.test.ts` checks the grid against.

## Helipads (`helipads.py`, #125)

Every `aeroway=helipad` and `aeroway=heliport` in the world box, as a node or a polygon, into the generated table
`src/core/helipadsData.ts` (re-exported as `HELIPADS` from `src/core/sites.ts`): centre, size and heading (a polygon's
minimum rotated rectangle; a node is 20 m facing north unless tagged `diameter` / `width` / `direction`), name, parent
site (the smallest hospital, aerodrome, naval base or vineyard area containing it) and height. A pad is on a **roof**
when tagged `location=roof`, when it lies inside an OSM building outline, or when it is a hospital pad with the 2024
LiDAR surface at least 4 m above the ground; its height is then the median 1 m DSM over its central 8 m square (Auckland
Part 1 LiDAR on the mainland, Part 2 on the islands, `s3://nz-elevation`, read with `tools/hero/site.py`'s helpers),
else the DEM. A node and a polygon mapping the same pad (4 pads) count once. `manifest.json`'s `helipads` entry has the
counts (OSM objects, pads, heliports, roof pads, per area and per kind) and each roof pad's DSM and DEM, which
`tests/world-helipads.test.ts` checks the table against. At the 2026-10-05 inputs: 87 OSM objects, 83 pads (81
helipads, 2 heliports), 14 on Waiheke Island itself, 4 on roofs (Auckland City Hospital's at 63.6 m, 16 m above the
ground; Middlemore's pad is on the lawn in the 2024 photo and LiDAR).

## Rebuild

```sh
pip install osmium shapely numpy pillow pyproj
# canonical input: the Geofabrik New Zealand extract pinned by date (a dated new-zealand-YYMMDD.osm.pbf from
# https://download.geofabrik.de/australia-oceania/; record the date you used in the commit)
python3 fetch.py geofabrik 260925 <work>
# optional: clip to the world box first (osmium-tool) — the bake also clips, this only makes it faster
osmium extract -b 174.31,-37.21,175.21,-36.49 <work>/new-zealand-260925.osm.pbf -o <work>/auckland.osm.pbf
python3 bake.py ../../src/world/scenery/data/auckland-osm.bin <work>/auckland.osm.pbf
LINZ_API_KEY=… python3 topo50.py <work>     # Topo50 golf courses and cemeteries (cached)
python3 landuse.py ../../src/world/scenery/data/auckland-landuse.bin <work> <work>/auckland.osm.pbf
python3 helipads.py <stac-cache> <work>/auckland.osm.pbf     # needs numpy rasterio pyproj; LiDAR read over HTTP
```

`bake.py` and `landuse.py` take one or more extracts. Several are merged first (osmium's merge: each object once, at
its newest version), so a supplement can fill a gap in a regional extract and an area cut at one extract's edge is
assembled from both. They write `manifest.json` (each keeps the other's entry) with every input's timestamp and
SHA-256, the output's hash and per-layer counts. For the same inputs the output is byte-identical.

After a re-bake:

1. Run `npx vitest run tests/world-osm.test.ts`. It checks that `src/core/airfields.ts` (the runway thresholds that gameplay,
   civil traffic and the offline fallback use) still matches the baked runways within 5 m. If OSM moved a runway,
   update the table from the bake's runway ends.
2. Look at the airfields with `node e2e/airfield-shots.mjs <port> <tag> <out-dir>` against a dev server
   (`npx vite --port <port>`). It renders the same world-lab camera positions before and after. The comparison for
   #32 (master vs. the first bake) is in `docs/screenshots/airfields/`.

### The committed files

The sandbox that produced these bakes could not reach download.geofabrik.de (connection reset) or Overpass, and no other
mirror had a New Zealand extract, so the committed `auckland-osm.bin` and `auckland-landuse.bin` (#122, 2026-10-05) were
built from BBBike's Auckland extract plus the rest of the world box from the OSM API (see `manifest.json`):

```sh
python3 fetch.py bbbike <work>     # BBBike's Auckland extract, replication timestamp 2026-10-02T23:00:00Z
# the world box outside BBBike's (lon 174.45…175.05, lat −37.15…−36.66): eastern Waiheke, Whangaparāoa and the
# northern edge, the west coast, the southern edge. 0.05° tiles from the OSM API, split while too big (201 tiles,
# ≈ 9 minutes), merged into one file; downloaded 2026-10-05T19:58Z
python3 fetch.py strips <work>     # → <work>/akl-strips.osm.pbf
python3 bake.py ../../src/world/scenery/data/auckland-osm.bin <work>/Auckland.osm.pbf <work>/akl-strips.osm.pbf
LINZ_API_KEY=… python3 topo50.py <work>
python3 landuse.py ../../src/world/scenery/data/auckland-landuse.bin <work> <work>/Auckland.osm.pbf <work>/akl-strips.osm.pbf
```

The strips overlap BBBike's box by 0.01°, so ways and areas BBBike cuts at its edge come in whole. Before #122 the bake
used BBBike alone plus an OSM API box for North Shore Aerodrome (Dairy Flat), which lost everything east of lon 175.05
(eastern Waiheke: Kennedy Point and Orapiu wharves, 11 of its 17 helipads) and north of −36.66; the strips cover Dairy
Flat too. Switching to the pinned Geofabrik file changes only the data's date.

## Fallback

When the file is missing (offline without a cache, an old browser without `DecompressionStream`), the four airfields
fall back to the template layout (`buildAirbase` in `src/world/scenery/airbase.ts`) laid on their **real** main
runways from `src/core/airfields.ts`, with the real secondary runways (Whenuapai 08/26) as extra strips. Spawn points,
civil traffic and approaches stay correct either way, because they use that table and never the baked file.
