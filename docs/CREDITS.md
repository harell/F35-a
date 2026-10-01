# F35-A — Credits & licences

F35-A is built almost entirely from procedural content: aircraft, SAM and ground models are generated from code,
textures are painted onto canvases at runtime, Auckland's coastline and terrain come from LINZ open data (below), and every
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
| Auckland coastline + terrain heights (`src/world/terrain/data/auckland-linz.bin`) | Toitū Te Whenua Land Information New Zealand (LINZ): [NZ LiDAR 1m DEM](https://data.linz.govt.nz/layer/121859-new-zealand-lidar-1m-dem/), NZ Contour-Interpolated 8m DEM (from [NZ Contours Topo 1:50k](https://data.linz.govt.nz/layer/50768)), via the LINZ Data Service / [nz-elevation](https://github.com/linz/elevation) open data | CC BY 4.0 — *Sourced from the LINZ Data Service and licensed for reuse under the CC BY 4.0 licence.* | [tools/linz](../tools/linz/README.md) |
| Auckland roads: CBD streets, motorways, arterials (`src/world/terrain/data/auckland-roads.bin`) | Toitū Te Whenua Land Information New Zealand (LINZ): [NZ Addresses: Road Sections](https://data.linz.govt.nz/layer/123109) and [NZ Tunnel Centrelines (Topo, 1:50k)](https://data.linz.govt.nz/layer/50366), via the LINZ Data Service | CC BY 4.0 — *Sourced from the LINZ Data Service and licensed for reuse under the CC BY 4.0 licence.* | [tools/linz](../tools/linz/README.md) |

**Geography.** The Auckland coastline (mean high water, ±10–20 m) and terrain heights (LiDAR, resampled to 86 m) are
real LINZ data, and the volcanic cones are snapped to the LiDAR summits. The CBD streets, the motorway carriageways and the
main arterials are LINZ road centrelines (the Harbour Bridge abutments snapped to them); the suburbs' street grid is
procedural and most other landmark positions are still hand-placed (roughly 100–400 m accuracy). The hand-traced map and
roads remain as an offline fallback; the map still names the harbours for the procedural bathymetry.

**Inspiration.** NovaLogic's *F-22 Raptor* (1997).

**Disclaimer.** F35-A is a fan-made, non-commercial game. It is not affiliated with or endorsed by Lockheed Martin,
the Royal New Zealand Air Force, the United States Air Force, NovaLogic or THQ Nordic. The scenario is fictional.
