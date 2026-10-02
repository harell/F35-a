# OpenStreetMap pipeline (Auckland theatre)

Bakes OpenStreetMap layers into `src/world/scenery/data/auckland-osm.bin` (≈ 44 kB gzip), which the game fetches once per
page load next to the LINZ data (`src/world/scenery/aucklandOsm.ts`). It gives the theatre its **real airfield layouts**
(Open data 1, issue #32) and holds the waterside and strategic-site layers that Open data 2 (#33) builds on.

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
| tower, helipad | `aeroway=control_tower` (or an aeroway ATC `man_made=tower`), `aeroway=helipad` | control tower position (none in the current data: a fallback places one) |
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

## Rebuild

```sh
pip install osmium shapely
# canonical input: the Geofabrik New Zealand extract pinned by date (a dated new-zealand-YYMMDD.osm.pbf from
# https://download.geofabrik.de/australia-oceania/; record the date you used in the commit)
python3 fetch.py geofabrik 260925 <work>
# optional: clip to the world box first (osmium-tool) — the bake also clips, this only makes it faster
osmium extract -b 174.31,-37.21,175.21,-36.49 <work>/new-zealand-260925.osm.pbf -o <work>/auckland.osm.pbf
python3 bake.py ../../src/world/scenery/data/auckland-osm.bin <work>/auckland.osm.pbf
```

`bake.py` takes one or more extracts. A later file only adds objects the earlier ones lack (keyed by OSM id), so a
small supplement can fill a gap in a regional extract. It writes `manifest.json` with every input's timestamp and
SHA-256, the output's hash and per-layer counts. For the same inputs the output is byte-identical.

After a re-bake:

1. Run `npx vitest run tests/world-osm.test.ts`. It checks that `src/core/airfields.ts` (the runway thresholds that gameplay,
   civil traffic and the offline fallback use) still matches the baked runways within 5 m. If OSM moved a runway,
   update the table from the bake's runway ends.
2. Look at the airfields with `node e2e/airfield-shots.mjs <port> <tag> <out-dir>` against a dev server
   (`npx vite --port <port>`). It renders the same world-lab camera positions before and after. The comparison for
   #32 (master vs. the first bake) is in `docs/screenshots/airfields/`.

### The committed file

The sandbox that produced this bake could not reach download.geofabrik.de or Overpass, so the committed
`auckland-osm.bin` was built from two equivalent sources (see `manifest.json`):

```sh
python3 fetch.py bbbike <work>     # BBBike's Auckland extract, replication timestamp 2026-09-25T23:00:00Z
# North Shore Aerodrome (Dairy Flat) lies just north of BBBike's box (−36.66): add it from the OSM API
python3 fetch.py api 174.635,-36.672,174.680,-36.640 <work>/nzne-dairy-flat.osm   # downloaded 2026-10-01T23:15Z
python3 bake.py ../../src/world/scenery/data/auckland-osm.bin <work>/Auckland.osm.pbf <work>/nzne-dairy-flat.osm
```

The BBBike box (lon 174.45…175.05, lat −37.15…−36.66) covers every layer #32 and #33 use. Switching to the pinned
Geofabrik file changes only the data's date. The #33 re-bake (port, dock, depot, stadium and site-building layers) used
the same BBBike file (same SHA-256) and a fresh Dairy Flat download; with the old script it reproduces the #32 bake
byte for byte apart from that download's timestamp.

## Fallback

When the file is missing (offline without a cache, an old browser without `DecompressionStream`), the four airfields
fall back to the template layout (`buildAirbase` in `src/world/scenery/airbase.ts`) laid on their **real** main
runways from `src/core/airfields.ts`, with the real secondary runways (Whenuapai 08/26) as extra strips. Spawn points,
civil traffic and approaches stay correct either way, because they use that table and never the baked file.
