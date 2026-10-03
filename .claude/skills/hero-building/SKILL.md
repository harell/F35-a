---
name: hero-building
description: How to build a recognisable 3D model of a real Auckland building ("hero building" or landmark) for F35-A from public data — OpenStreetMap 3D parts as the baseline, LINZ LiDAR for heights, the LINZ 7.5 cm aerial for roofs, street photos for facades and signs — prototype it as a reviewable three.js page, then port it into the game. A routing table from "I want to…" to the tool, the procedure, and dated lessons. Use when asked to model, build, add, improve or check a landmark, tower, stadium, mall or any specific real building, or when a building in the game "doesn't look like" the real one.
---

# Hero buildings: real Auckland buildings in 3D

Ordinary buildings in the game are LINZ outlines extruded to one LiDAR height (`tools/linz/buildings.py`). A **hero building** gets its own model, so players recognise it from the air: the Sky Tower (`src/core/skyTower.ts`), Spark Arena (`src/core/sparkArena.ts`). "Hand-made" here means **built in code from measured public data**, not sculpted in a 3D tool and not generated from photos.

Worked examples, both with prototypes reviewed by the owner:
- **Spark Arena**: bespoke geometry (two tilted lens-shaped roof planes fitted to the LiDAR). Prototype source `tools/hero/examples/spark-arena.html`; in game: `src/core/sparkArena.ts`, `src/world/scenery/sparkArena.ts`, `tests/world-sparkarena.test.ts`. Private prototype: https://claude.ai/artifact/KcbdyPLaEjkGRzhHhECVRu
- **Auckland Harbour Bridge** (a bridge, so bespoke): measurements `tools/hero/sites/harbour_bridge.py`, prototype source `tools/hero/examples/harbour-bridge.html` (stage 1 is the game's own mesh exported from `buildHarbourBridge`, stage 4 overlays it). Private prototype: https://claude.ai/artifact/HPXWhDrXJj8z4oSnYTZ4MM. In game: `src/core/harbourBridge.ts`, `src/world/scenery/harbourBridge.ts`, `tests/world-heroes.test.ts`.
- **Ports of Auckland** (a whole site, LiDAR-driven): recipe `tools/hero/sites/ports_of_auckland.py` (decks, sheds, cranes, masts, container stacks → `port_model.json`), prototype source `tools/hero/examples/ports-of-auckland.html` (the game's own waterfront and CBD meshes in stages 1 and 3). Private prototype: https://claude.ai/artifact/ETBZ3YvvDDqSSFM1gZKFa2. In game: `src/core/portOfAuckland.ts` (cranes, masts), `src/world/scenery/aucklandPort.ts` + `data/auckland-port.bin` (stacks, 55 kB), `aucklandSites.ts` buildRealPort, crane solids in `src/sim/buildings.ts`.
- **Scene One, Two and Three** (Beach Road apartments: towers on a shared podium): recipe `tools/hero/sites/scene_beach_road.py` (LiDAR terraces inside each OSM outline), prototype source `tools/hero/examples/scene-beach-road.html`. Private prototype: https://claude.ai/artifact/HqiQtMc7dWf9No9cNTT1P4. In game: `src/core/sceneApartments.ts`, swapped into the LINZ building list by `applyHeroBuildings` (`aucklandBuildings.ts`), facade style `WIN_BALCONY`.
- **Westfield Newmarket**: the data-driven kit (OSM parts → LiDAR heights → aerial roofs → facades/signs). Recipe `tools/hero/sites/westfield_newmarket.py`. Private prototype: https://claude.ai/artifact/RKaS3WF7Zz1JmK95LXHRgJ

## Routing table

| I want to… | Use | Cost (cloud container, measured 2026-10-03) |
|---|---|---|
| Get everything LINZ has for a site (LiDAR DSM/DEM 1 m, the 7.5 cm aerial, height map, game coordinates) | `python3 tools/hero/site.py --name <id> --lat <lat> --lon <lon> --size <m>` → `/tmp/hero/<id>/` | 6 min the first time (it reads the 17,739-item aerial STAC catalogue), **10 s after** (cached in `/tmp/hero/_stac`) |
| See whether someone already mapped it in 3D (OSM `building:part`, `height`, `building:levels`, `roof:shape`, colours) | `python3 tools/hero/osm.py --site /tmp/hero/<id>` → `osm.json` + a table | ~5 s |
| Check that OSM, LiDAR and the photo agree | `python3 tools/hero/overlay.py --site /tmp/hero/<id> [--match <name>]` → `overlay-ndsm.png`, `overlay-aerial.jpg`; look at both | ~2 s |
| Roof heights per OSM part (median for a flat roof, p90 for parapets, max for a spire/dome) | `python3 tools/hero/heights.py --site /tmp/hero/<id> [--match <name>]` | ~2 s |
| A box / slab / tower / mall that OSM already outlines | **The kit**: write `tools/hero/sites/<id>.py` (copy `westfield_newmarket.py`) → `model.json` | 30–60 min |
| A building with curved or tilted roofs, cylinders, trusses | **Bespoke**: fit primitives to the LiDAR in Python (planes: least squares in a mask), then copy `tools/hero/examples/spark-arena.html` and edit its geometry | 1–2 h |
| See every side a street reaches (walls no photo shows, extra signs) | `MAPILLARY_STREET_API=MLY|… python3 tools/hero/mapillary.py --site /tmp/hero/<id> --radius <half the length + a street>` → `mly/sheet.jpg` (CC BY-SA 4.0) | ~30 s |
| Find facade and sign photos | Section "Photos" below (WebSearch → venue/news/architect pages → `curl` + `grep` for image URLs → look at each) | 10–20 min |
| Turn `model.json` into a review page | `python3 tools/hero/build_prototype.py --site /tmp/hero/<id>` → `prototype.html`, publish it as a private Artifact | ~1 s + publish |
| A "before" shot of the site in the game | dev server, then `node tools/hero/today-shot.mjs --x=<game_x> --z=<game_z> --out=/tmp/hero/<id>/today.jpg [--from=se]` | ~1–2 min (SwiftShader) |
| Put the approved model in the game | Section "Port into the game" | half a day |

## Procedure

**0. Identify the site.** Name, address, approximate lat/lon (Wikipedia, OSM). Pick a box that holds the whole building with ~30 m margin (`--size`): one fetch, then re-centre once you've seen the height map (Westfield needed a second, shifted box).

**1. OSM baseline first.** `osm.py`. If the building has `building:part`s with heights or levels, they *are* the model's skeleton (Westfield: 2 outlines + 7 parts, matched the LiDAR to ~1 m). If OSM has only an outline, use it as the footprint. Treat OSM heights/levels as hints: the LiDAR decides.

**2. Measure.** `site.py` then `overlay.py` and `heights.py`. Read `ndsm.png` (height above ground) next to `aerial.jpg`. Decide the primitive per part:
- one flat roof: median DSM inside the ring; a wide p10–p90 spread means several levels → split the ring or use OSM parts;
- tilted planes: fit `h = a·x + b·z + c` with least squares in a mask and report the RMS (Spark Arena: 0.25 m and 0.32 m);
- cylinders, domes, spires: centre from the aerial, radius from the outline, height from the LiDAR max.
Sloping ground matters (Newmarket drops ~8 m across the site): walls start at the **lowest DEM** inside each ring, roofs at absolute DSM heights.

**3. Roofs from the aerial.** Drape `aerial.jpg` on flat roofs (same local frame: `u = x/W, v = 1 − z/H`). It is a standard orthophoto, not a true ortho: **roofs lean away from the photo centre by about height × offset / flying height** — negligible under ~35 m (Westfield), up to ~25 m on the CBD towers. Tall towers get modelled roofs, not the photo.

**4. Photos for facades and signs.** See "Photos". Write down what each photo shows and use only as-built photos for geometry and materials.

**5. Prototype and review gate.** Kit: write the recipe and run `build_prototype.py`. Bespoke: edit a copy of the Spark Arena page. Take one look yourself (render it headless, see "Lessons"), fix what's obviously wrong, then **publish it as a private Artifact and get the owner's approval before porting**. The page shows three stages: the game today, the raw LiDAR, the hero model; and a "measured / from photos / guessed" ledger. Be honest in the ledger.

**6. Port into the game** (below), then update this skill's "Learned" section.

## Photos

- **Wikimedia's API is rate-limited (HTTP 429) from the cloud container.** Use `WebSearch` to find pages (Wikipedia article, the venue's own site, Auckland Live / Austadiums-style venue guides, architect and contractor project pages, news articles), then `curl -sL -A "Mozilla/5.0 …"` each page and `grep -oE 'https?://[^"'"'"' )]+\.(jpg|jpeg|png|webp)'` for image URLs. `thumb.wikimedia.org/…/1280px-…` thumbnails often still load.
- **Look at every photo** (download, contact-sheet with PIL, Read it). For Spark Arena 2 of 8 scraped photos were other venues; for Westfield 3 of 4 were architect's renders, not as built.
- Wanted shots: the main frontage from street level (materials, glazing rhythm, entrances, canopies), the signage by day and at night (colours change: Spark Arena's LED sign is coral by day, purple at night), and anything only visible from the side (roof edges and overhangs: Spark Arena's roof is light silver from above but its edges and undersides read dark from the street).
- Don't embed third-party photos or official logo files in the game or the prototype: draw signs as text with a similar font and a simple stand-in mark, and credit the photos you used as references. Whether a real brand name appears in the game is the owner's call.
- Never send the user's email or other personal data in a User-Agent or request.
- **Mapillary for the sides** (`tools/hero/mapillary.py`, token in `MAPILLARY_STREET_API`): crowd-sourced street imagery under CC BY-SA 4.0, so modelling from it is allowed; credit "Mapillary contributors" in the sources. It rings the building with probe points, keeps one image per side (360° panoramas cropped towards the building, normal photos only if they face it) and writes `mly/sheet.jpg` labelled by side and date. Expect tilted 360° shots, car roof racks and glare; it misses pedestrian-only plazas.

## The kit's model.json (what `build_prototype.py` renders)

Local frame: metres, `x = E − E0` (east), `z = N1 − N` (south), from `site.json`; heights in metres above the recipe's `g0`.
- `prisms`: `{ring: [[x,z]...], y0, y1, wall: 'precast_dark'|'precast_light'|'glass'|'glass_teal'|'shopfront'|'metal'|<colour>, bay: [u, v] m, roof: 'aerial'|<material>}`
- `facades`: `{a: [x,z], b: [x,z], n: [nx,nz] outward, y0, y1, mat, bay}` — a panel on one edge (glass bays, shopfronts)
- `boxes`: `{from, to, y0, y1, width, mat}` — air bridges, canopies, plant
- `domes`: `{x, z, y, r, mat, squash}`; `signs`: `{text, font ('{px}' placeholder), colour, nightColour?, x, z, y, w, h, face: [nx, nz]}`
- `ground`, `lidar`: 2 m grids `{res, w, h, z[]}`; `meta`: page text (title, notes per stage, steps, ledger, sources HTML).
Add a new primitive to `tools/hero/viewer.html` when a building needs one, and list it here.

## Port into the game

Follow the Sky Tower / Spark Arena pattern (read their files first):
- **Shape data** in `src/core/<id>.ts`: the measured numbers in game coordinates (origin Sky Tower, +x east, +z south; convert with the game's own lat/lon → world function, never by hand), sources and fit errors in the header comment.
- **Meshes** in `src/world/scenery/<id>.ts`, wired into the Auckland scenery build (`Scenery.ts`); merged per material (one or two draw calls); canvas-texture signs; night lights following `nightLights.ts`.
- **Remove what it replaces**: the LINZ prism inside the CBD box (`buildLinzCBD`) or procedural scatter/OSM site objects inside its footprint.
- **Collision**: register its footprint and roof height with the sim's building lookup (`src/sim/buildings.ts`, `src/sim/damage/Collisions.ts`).
- **Place entry** in `AKL` (`src/core/auckland.ts`).
- **Test** in `tests/`: position, heights at a few points against the LiDAR (±2 m), collision at the centre.
- Before/after shots from the same camera, draw calls and triangles (`window.__f35.state().renderer`) on medium; credits (LINZ CC BY 4.0, OSM ODbL) in `docs/CREDITS.md`.
- `npx tsc --noEmit && npx vitest run && npx vite build`.

## Lessons (add dated one-liners; delete ones that stop being true)

- 2026-10-03: OSM before modelling: Westfield Newmarket already had 7 tagged `building:part`s; they became the whole skeleton. The Sky Tower also started from OSM parts.
- 2026-10-03: Overpass (overpass-api.de, kumi) is unreachable from the cloud container; the main API's `/api/0.6/map?bbox=` works (0.25 deg² / 50k nodes max).
- 2026-10-03: The first `site.py` run reads the whole aerial STAC catalogue (17,739 items, ~6 min); keep `/tmp/hero/_stac` and later sites take ~10 s.
- 2026-10-03: The LINZ 2024 aerial is a standard orthophoto (no true ortho exists for Auckland). Fine on roofs under ~35 m; model taller roofs. Auckland Council's older "Auckland CBD – 3D Model" (2020) has no licence: avoid it. Its 2023 "Auckland CBD to Airport 3D Mesh" (Zone 1A, I3S, 6 cm textured, licence field CC BY 4.0 but the description says visualisation only) is reachable without a key: measure from it with credit; ask the owner before embedding its mesh or textures.
- 2026-10-03: Glass lets LiDAR through: a glass dome's median height reads low (Westfield's rotunda: p10 ≈ 0 m). Use p90/max or the photo for glazed parts and say so in the recipe.
- 2026-10-03: A raw LiDAR roof between modelled parts is lumpy at the walls (struts, glass, edges): blur it (~14 m) and clamp, or fit a plane.
- 2026-10-03: A facade panel's outward normal must be computed against the ring's centre, not assumed from winding (OSM ring winding varies); the first Westfield render had every Broadway facade hidden inside the building.
- 2026-10-03: Street-level imagery of every side overturned Spark Arena's model: the north/east walls are terracotta and red-brown bands with a window ribbon, not the silver ribs assumed from the foyer photos, and there are three signs, not one. Look at every side before calling a facade done.
- 2026-10-03: Mapillary on Spark Arena and Westfield Newmarket: it showed the walls and signs on every side a road reaches (Spark Arena's bands and both north signs; Westfield's lattice screen and its motorway-side wall) but had no images of Spark Arena's pedestrian-only west plaza, and its images are rough (tilt, roof racks, 2021–25). Order: venue/Commons photos for the front, Mapillary for the other sides.
- 2026-10-03: An LED sign's colour in one photo can be a show colour (Spark Arena: coral in one photo, white in the street-level images); use the colour most photos agree on.
- 2026-10-03: Headless render check of a prototype: wrap the page in `<!doctype html><html><head><meta charset="utf-8"></head><body>…`, open it with playwright-core from a script under `e2e/` (delete it after), Chromium flags `--use-gl=angle --use-angle=swiftshader --ignore-gpu-blocklist --ignore-certificate-errors` (the proxy's CA isn't trusted by Chromium, so the CDN scripts fail without the last flag), wait ~15–20 s, screenshot the `.stage-wrap` element.
- 2026-10-03: Bridges and other long structures: sample the DSM in cross-sections along an axis (OSM `bridge:support=pier` line, re-centred on the deck edges) instead of reading rings. The Harbour Bridge deck came out as two ±5.0 % grades with a 248 m vertical curve (RMS 0.05 m), and the truss top chord matched to 0.5 m on both sides. LiDAR sees nothing under a deck: take the under-structure from side photos and mark it guessed.
- 2026-10-03: Panel or bay spacing of repetitive structure: autocorrelate the DSM along a line through it (the Harbour Bridge's top bracing gave 15.3 m, i.e. 16 panels over the 244 m main span).
- 2026-10-03: To show "the game today" in 3D next to the hero model, export the game's own mesh with a throwaway vitest that calls the scenery builder with the real terrain (`generateTerrain` + `meshHeightAt`, as in `tests/world-city.test.ts`) and writes positions, colours and indices to /tmp; delete the test afterwards. The vertex colours are linear (three ≥ r152): convert them to sRGB for the r128 prototype page.
- 2026-10-03: Wikimedia's API is rate-limited, but thumbnails load if you build the URL yourself: `upload.wikimedia.org/wikipedia/commons/thumb/{md5[0]}/{md5[:2]}/{Name}/1280px-{Name}`, with md5 of the file name (spaces → underscores).
- 2026-10-03: Sites full of repeated objects (a container yard): let the LiDAR place them. Mask DSM 1.8–17 m over the deck, grid each connected group in its own minimum-bounding-box orientation at 1 m, quantise to 2.6 m tiers and merge equal-tier cells into rectangles (greedy meshing); colour each from the aerial's mean over it. Ports of Auckland: 125k cells → 10k blocks in 40 s.
- 2026-10-03: Neighbouring tall structures merge in a height mask (two ship-to-shore cranes touched at 42 m). Seed one per structure from a higher threshold (the A-frames over 62 m) and give each cell to the nearest seed along the row (the quay).
- 2026-10-03: The aerial and the LiDAR were flown on different days: crane booms are up in one and down in the other. Take moving parts from the LiDAR, which also sets the heights, and say so on the page.
- 2026-10-03: Showing a site in the game's context: export the neighbouring game meshes too (here `buildCBD` with the real LINZ buildings), drop their triangles inside the hero's footprint, and use them as the context in the hero stage, so only the modelled part differs between stages.
- 2026-10-03: One OSM outline often holds a tower and its podium (Scene apartments: 49 m slabs on a 10 m podium, one outline each; the game extrudes the whole outline to tower height). Class the LiDAR inside the outline into height bands, mode-filter 3 m, trace at 0.5 m (skimage contours → shapely), clip to the outline and simplify ~1.2 m (0.6 m left 1 m raster stairs). `tools/hero/sites/scene_beach_road.py` does it; the step is generic for any LINZ building with a wide p10–p90 spread.
- 2026-10-03: Mapillary's default ring (`--radius` half the length + a street) can miss the facade you need on a long block: rerun with a radius that puts the probes on the street itself (Scene: 110 m showed other buildings, 55 m stood on Beach Road).
- 2026-10-03: The classified 2024 Auckland LiDAR point cloud is on OpenTopography's public S3 (`https://opentopography.s3.sdsc.edu/pc-bulk/NZ24_Auckland/CL2_<tile>.laz`, CC BY 4.0, no key; `pip install laspy[lazrs]`), not in `nz-elevation`. ~22 pts/m² on the Scene towers, with wall returns: it gives storey heights (3.1 m) and slab levels that the 1 m DSM loses.
- 2026-10-03: Porting a hero whose parts are prisms: swap them into the LINZ building list at load time (`applyHeroBuildings`), keeping the file's rules (positive winding, largest footprint first), so the scenery, collision and collapse all follow without new code paths.
- 2026-10-03: A site with thousands of repeated parts ships as a small baked binary next to the other data (`auckland-port.bin`: 15-byte records, 55 kB gzip for 5k stack blocks), loaded in `Environment.ts` and `tests/linz-setup.ts`, with the procedural fallback kept.
- 2026-10-03: The game's terrain can disagree with the LiDAR ground by 10 m+ (Northcote Point under the bridge's north approach): check `meshHeightAt` along a hero's footprint before assuming its measured base meets the game ground.
