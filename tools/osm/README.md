# OpenStreetMap pipeline (Auckland theatre)

Bakes OpenStreetMap layers into `src/world/scenery/data/auckland-osm.bin` (≈ 53 kB gzip), which the game fetches once per
page load next to the LINZ data (`src/world/scenery/aucklandOsm.ts`). It gives the theatre its **real airfield layouts**
(Open data 1, issue #32) and its **real waterfront and strategic sites** (Open data 2, issue #33): the Ports of Auckland
wharves, piers, pontoons and breakwaters, the marinas, Devonport Naval Base, the Wiri oil terminal and Eden Park
(`src/world/scenery/waterfront.ts`).

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
| pier, breakwater, marina | `man_made=pier` (flag: `floating=yes`) / `breakwater`, `leisure=marina` | every pier, pontoon and breakwater; yachts on the marina pontoons |
| port | `landuse=port`, `landuse=industrial` + `industrial=port`, `man_made=container_terminal` | the wharf decks (they cover the Fergusson reclamations the LINZ coastline predates), the container yard |
| berth, crane | `seamark:type=berth` (points, with the name); `man_made=crane` (points; flag: a Ports of Auckland container crane) | the moored ships' berths (checked by `tests/world-waterfront.test.ts`); quay cranes on their real positions, dock gantries |
| dock | `waterway=dock` (areas) | Calliope Dock, the naval base's dry dock |
| storage tank | `man_made=storage_tank` at least 8 m across (farm water tanks dropped); flag for oil, fuel and gas content | airfield fuel farms; the Wiri terminal (`src/core/aucklandSites.ts`) and the other tanks |
| military, naval, building | `landuse=military`, `military=naval_base`; the buildings (`building=*`, ≥ 30 m²) inside that land and outside every aerodrome, with `height` / `building:levels` in the width field | Devonport Naval Base (`AKL.devonport_naval`) and its buildings; the scatters keep off this land |
| stadium, pitch | `leisure=stadium`; the `leisure=pitch` inside a stadium | Eden Park's stands round the Main Oval (`AKL.eden_park`) |
| bridge | `man_made=bridge` outlines longer than 600 m | the Harbour Bridge pier check (`tests/world-waterfront.test.ts`) |
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

1. Run `npx vitest run tests/world-osm.test.ts tests/world-waterfront.test.ts`. They check that the tables gameplay uses
   without the baked file still match it: `src/core/airfields.ts` (runway thresholds, within 5 m), the moored ships'
   berths (`PORT_BERTHS` in `src/missions/runtime/shipping.ts`, alongside the OSM berths and clear of the OSM wharves) and
   the Wiri tanks (`src/core/aucklandSites.ts`, within 2 m). If OSM moved something, update the table from the bake.
2. Look at the airfields with `node e2e/airfield-shots.mjs <port> <tag> <out-dir>` against a dev server
   (`npx vite --port <port>`), and at the waterfront with `node e2e/waterfront-shots.mjs <port> <tag> <out-dir>`. They
   render the same world-lab camera positions before and after. The comparisons are in `docs/screenshots/airfields/`
   (#32) and `docs/screenshots/waterfront/` (#33).

### The committed file

The sandbox that produced this bake could not reach download.geofabrik.de or Overpass, so the committed
`auckland-osm.bin` was built from two equivalent sources (see `manifest.json`):

```sh
python3 fetch.py bbbike <work>     # BBBike's Auckland extract, replication timestamp 2026-09-25T23:00:00Z
# North Shore Aerodrome (Dairy Flat) lies just north of BBBike's box (−36.66): add it from the OSM API
python3 fetch.py api 174.635,-36.672,174.680,-36.640 <work>/nzne-dairy-flat.osm   # downloaded 2026-10-01T21:48Z
python3 bake.py ../../src/world/scenery/data/auckland-osm.bin <work>/Auckland.osm.pbf <work>/nzne-dairy-flat.osm
```

The BBBike box (lon 174.45…175.05, lat −37.15…−36.66) covers every layer #32 and #33 use. The #33 re-bake reproduced the
#32 file byte for byte (only the Dairy Flat download time in the attribution changed) before the new layers were added. Switching to the pinned
Geofabrik file changes only the data's date.

## Fallback

When the file is missing (offline without a cache, an old browser without `DecompressionStream`), the four airfields
fall back to the template layout (`buildAirbase` in `src/world/scenery/airbase.ts`) laid on their **real** main
runways from `src/core/airfields.ts`, with the real secondary runways (Whenuapai 08/26) as extra strips. Spawn points,
rearm, civil traffic and approaches stay correct either way, because they use that table and never the baked file.

The waterfront falls back to the hand-placed port (on the real Fergusson and Bledisloe extents, clear of the berths) and
the hand-placed Westhaven and Viaduct marinas (`buildPort` / `buildMarinas` in `src/world/scenery/auckland.ts`); the
Wiri tanks come from `src/core/aucklandSites.ts` and Eden Park is built round its landmark. Devonport Naval Base has no
fallback beyond the town. The moored ships and any mission target on a Wiri tank use the core tables, so they are
unaffected.
