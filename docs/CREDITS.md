# F35-A — Credits & licences

F35-A is built almost entirely from procedural content: aircraft, SAM and ground models are generated from code,
textures are painted onto canvases at runtime, Auckland's coastline, terrain, roads and CBD buildings come from LINZ open data and its airfields from
OpenStreetMap (below), and every
sound effect and the music are synthesized with Web Audio. The third-party assets below are the only exceptions.

| What | Source | Licence | Details |
|---|---|---|---|
| **three.js** (incl. `examples/jsm` addons: Lensflare, BufferGeometryUtils) | https://github.com/mrdoob/three.js | MIT | [render](credits/render.md), [world](credits/world.md) |
| Water normal map, lens-flare sprites, moon texture (`public/textures/*`) | three.js examples, via raw.githubusercontent.com | MIT | [world](credits/world.md) |
| **B612 Mono** HMD font | https://github.com/polarsys/b612 (via google/fonts) | SIL OFL 1.1 (`src/hud/assets/OFL-B612.txt`) | [hud](credits/hud.md) |
| "Betty" cockpit voice (`b_*` clips) | Piper TTS `en-us-kathleen-low` | CC0 | [audio](credits/audio.md) |
| Pilot, wingman and AWACS voices (`p_*`, `a_*`, `s_*`, `h_*` clips) | Piper TTS `en-us-libritts-high` (LibriTTS speakers) | CC BY 4.0: LibriTTS (openslr.org/60), derived from LibriVox public-domain recordings | [audio](credits/audio.md) |
| Piper TTS engine (build-time only) | https://github.com/rhasspy/piper | MIT | [audio](credits/audio.md) |
| Shader hash `hash12` | Dave Hoskins, *Hash without Sine* | MIT | [world](credits/world.md) |
| Auckland coastline, terrain heights, bush / forest cover and water depth (`src/world/terrain/data/auckland-linz.bin`, high tier detail `auckland-linz-hd.bin`) | Toitū Te Whenua Land Information New Zealand (LINZ): [NZ LiDAR 1m DEM](https://data.linz.govt.nz/layer/121859-new-zealand-lidar-1m-dem/), NZ Contour-Interpolated 8m DEM (from [NZ Contours Topo 1:50k](https://data.linz.govt.nz/layer/50768)), [NZ Native](https://data.linz.govt.nz/layer/50306), [Exotic](https://data.linz.govt.nz/layer/50267) and [Scrub](https://data.linz.govt.nz/layer/50339) Polygons (Topo, 1:50k), Depth area polygons (Hydro, layers [50671](https://data.linz.govt.nz/layer/50671), [50553](https://data.linz.govt.nz/layer/50553), [50447](https://data.linz.govt.nz/layer/50447), [50852](https://data.linz.govt.nz/layer/50852); not for navigation), via the LINZ Data Service / [nz-elevation](https://github.com/linz/elevation) open data | CC BY 4.0 — *Sourced from the LINZ Data Service and licensed for reuse under the CC BY 4.0 licence.* | [tools/linz](../tools/linz/README.md) |
| Auckland roads: CBD streets, motorways, arterials (`src/world/terrain/data/auckland-roads.bin`) | Toitū Te Whenua Land Information New Zealand (LINZ): [NZ Addresses: Road Sections](https://data.linz.govt.nz/layer/123109) and [NZ Tunnel Centrelines (Topo, 1:50k)](https://data.linz.govt.nz/layer/50366), via the LINZ Data Service | CC BY 4.0 — *Sourced from the LINZ Data Service and licensed for reuse under the CC BY 4.0 licence.* | [tools/linz](../tools/linz/README.md) |
| Auckland CBD buildings: footprints + heights (`src/world/terrain/data/auckland-buildings.bin`) | Toitū Te Whenua Land Information New Zealand (LINZ): [NZ Building Outlines](https://data.linz.govt.nz/layer/101290-nz-building-outlines/) via the LINZ Data Service, and the Auckland Part 1 LiDAR 1m DSM and DEM (2024) from the [nz-elevation](https://github.com/linz/elevation) open data (`s3://nz-elevation/auckland/auckland-part-1_2024/`) | CC BY 4.0 — *Sourced from the LINZ Data Service and licensed for reuse under the CC BY 4.0 licence.* | [tools/linz](../tools/linz/README.md) |
| Auckland airfield layouts and waterside / strategic-site layers (`src/world/scenery/data/auckland-osm.bin`; runway thresholds in `src/core/airfields.ts`) | © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors: aeroway (runways, taxiways, aprons, hangars, terminals, aerodromes), piers, breakwaters, marinas, port land, storage tanks, military and naval land, from the BBBike Auckland extract of 2026-09-25 plus an OSM API download for North Shore Aerodrome (`tools/osm/manifest.json`) | **ODbL 1.0**: `auckland-osm.bin` is a derivative database and is available under the same licence. It is rebuilt with `tools/osm` from the pinned inputs | [tools/osm](../tools/osm/README.md) |
| Sky Tower model: profile of every tier, legs and mast (`src/core/skyTower.ts`) | © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors: the Simple-3D-Buildings parts of [relation 19745928](https://www.openstreetmap.org/relation/19745928) (and the SkyWalk, [relation 15909011](https://www.openstreetmap.org/relation/15909011)), cross-checked against the LINZ 2024 1 m DSM | ODbL 1.0 — a Produced Work: attribution only | `src/core/skyTower.ts` |

**Geography.** The Auckland coastline (mean high water, ±10–20 m) and terrain heights (LiDAR, resampled to 86 m) are
real LINZ data, and the volcanic cones are snapped to the LiDAR summits. Native bush, pine plantations and scrub follow
the Topo50 vegetation polygons (172 m grid), and the water depth follows the LINZ nautical charts' depth areas (172 m grid,
chart datum moved to mean high water). The CBD streets, the motorway carriageways and the
main arterials are LINZ road centrelines (the Harbour Bridge abutments snapped to them). The CBD's buildings are the LINZ
outlines extruded to their 2024 LiDAR heights (±5 m), plus the towers completed since the outlines were captured (2017),
traced from the LiDAR. The Sky Tower is built from its OpenStreetMap 3D building parts (heights ±2 m, radii ±1 m); the
Harbour Bridge remains a hand-built model. Whenuapai, Auckland Airport, Ardmore and North Shore (Dairy Flat) are their
OpenStreetMap layouts: runways from their mapped thresholds (±2–5 m), taxiways, aprons, hangars and terminals, with the terrain
levelled along the real outline. The suburbs' street grid and houses are
procedural and most other landmark positions are still hand-placed (roughly 100–400 m accuracy). The hand-traced map and
roads, the procedural CBD and the template airfields (on the real runways) remain as an offline fallback; the map still names the harbours for the procedural bathymetry.

**Inspiration.** NovaLogic's *F-22 Raptor* (1997).

**Disclaimer.** F35-A is a fan-made, non-commercial game. It is not affiliated with or endorsed by Lockheed Martin,
the Royal New Zealand Air Force, the United States Air Force, NovaLogic or THQ Nordic. The scenario is fictional.
