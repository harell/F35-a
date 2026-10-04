---
name: hero-building
description: How to build a recognisable 3D model of a real Auckland building ("hero building" or landmark) for F35-A from public data — OpenStreetMap outlines and parts, LINZ LiDAR rasters and point cloud for heights and shape, the LINZ 7.5 cm aerial and Auckland Council's textured 3D mesh for roofs and facades, street photos for what is left — prototype it as a reviewable three.js page, then port it into the game. A table of what each source gives, the order to go through them (and which to skip), a routing table from "I want to…" to the tool, and dated lessons. Use when asked to model, build, add, improve or check a landmark, tower, stadium, mall or any specific real building, or when a building in the game "doesn't look like" the real one.
---

# Hero buildings: real Auckland buildings in 3D

Ordinary buildings in the game are LINZ outlines extruded to one LiDAR height (`tools/linz/buildings.py`). A **hero building** gets its own model, so players recognise it from the air: the Sky Tower (`src/core/skyTower.ts`), Spark Arena (`src/core/sparkArena.ts`). "Hand-made" here means **built in code from measured public data**, not sculpted in a 3D tool and not generated from photos.

Worked examples, both with prototypes reviewed by the owner:
- **Spark Arena**: bespoke geometry (two tilted lens-shaped roof planes fitted to the LiDAR). Prototype source `tools/hero/examples/spark-arena.html`; in game: `src/core/sparkArena.ts`, `src/world/scenery/sparkArena.ts`, `tests/world-sparkarena.test.ts`. Private prototype: https://claude.ai/artifact/KcbdyPLaEjkGRzhHhECVRu
- **Auckland Harbour Bridge** (a bridge, so bespoke): measurements `tools/hero/sites/harbour_bridge.py`, prototype source `tools/hero/examples/harbour-bridge.html` (stage 1 is the game's own mesh exported from `buildHarbourBridge`, stage 4 overlays it). Private prototype: https://claude.ai/artifact/HPXWhDrXJj8z4oSnYTZ4MM. In game: `src/core/harbourBridge.ts`, `src/world/scenery/harbourBridge.ts`, `tests/world-heroes.test.ts`.
- **Ports of Auckland** (a whole site, LiDAR-driven): recipe `tools/hero/sites/ports_of_auckland.py` (decks, sheds, cranes, masts, container stacks → `port_model.json`), prototype source `tools/hero/examples/ports-of-auckland.html` (the game's own waterfront and CBD meshes in stages 1 and 3). Private prototype: https://claude.ai/artifact/ETBZ3YvvDDqSSFM1gZKFa2. In game: `src/core/portOfAuckland.ts` (cranes, masts), `src/world/scenery/aucklandPort.ts` + `data/auckland-port.bin` (stacks, 55 kB), `aucklandSites.ts` buildRealPort, crane solids in `src/sim/buildings.ts`.
- **Scene One, Two and Three** (Beach Road apartments: towers on a shared podium): recipe `tools/hero/sites/scene_beach_road.py` (LiDAR terraces inside each OSM outline), prototype source `tools/hero/examples/scene-beach-road.html`. Private prototype: https://claude.ai/artifact/HqiQtMc7dWf9No9cNTT1P4. In game: `src/core/sceneApartments.ts`, swapped into the LINZ building list by `applyHeroBuildings` (`aucklandBuildings.ts`), facade style `WIN_BALCONY`.
- **The CBD tower kit** (every CBD building taller than Scene 3, #156): one recipe for all of them, `tools/hero/sites/cbd_towers.py` (list in `cbd_towers.tsv`, colours from the 3D mesh by `cbd_towers_colours.py` into `cbd_towers_style.json`) → generated `src/core/cbdTowersData.ts`; types and spires `src/core/cbdTowers.ts`; swapped into the LINZ list by `applyHeroBuildings`, facades `WIN_CURTAIN` / `WIN_BANDS` / `WIN_BALCONY` / `WIN_OFFICE` in `auckland.ts`; test `tests/world-towers.test.ts`; before/after shots and draw calls `tools/hero/cbd-shots.mjs`.
- **Auckland Domain** (a park, the base layer; LiDAR trees): recipe `tools/hero/sites/auckland_domain.py` (ground, one crown per tree by watershed, park buildings, glasshouse vaults, ponds → `domain_model.json`), page builder `tools/hero/sites/auckland_domain_page.py`, prototype source `tools/hero/examples/auckland-domain.html` (stage 4 maps game terrain − LiDAR ground). Private prototype: https://claude.ai/artifact/4kscNUVkQ6UfsqiKsaNrMc. Not in the game yet.
- **Auckland War Memorial Museum** (the top layer on the Domain; terraces + a LiDAR dome surface + mesh-projected facades): recipe `tools/hero/sites/auckland_museum.py` → `museum_model.json` + `tex_{north,south,east,west,top}.jpg`; both layers together, on the LiDAR and on the game's terrain, with a 300 kt pilot pass: `tools/hero/sites/auckland_domain_museum_page.py`, source `tools/hero/examples/auckland-domain-museum.html`. Private prototype: https://claude.ai/artifact/GrLJuxMEex8jeyyV9uvbxm. Not in the game yet.
- **Westfield Newmarket**: the data-driven kit (OSM parts → LiDAR heights → aerial roofs → facades/signs). Recipe `tools/hero/sites/westfield_newmarket.py`. Private prototype: https://claude.ai/artifact/RKaS3WF7Zz1JmK95LXHRgJ

## Sources: what each one gives

Read the row before reaching for a source: most buildings need only some of them (next section).

| Source (tool) | Footprint & shape | Heights & volume | Roof | Outside colour & materials | Detail (storeys, windows, fins, signs) | Blind spots | Licence |
|---|---|---|---|---|---|---|---|
| **OpenStreetMap** outlines, `building:part`, levels, roof tags (`osm.py`) | **Best start**: outline, parts | Hints only (`height`, `building:levels` are often wrong: Scene says 12/14/15, it has 16) | `roof:shape` hint | `building:colour` hint (rare) | Names, addresses | One outline often holds a tower *and* its podium | ODbL |
| **LINZ LiDAR 1 m DSM/DEM** (`site.py`, `heights.py`, `overlay.py`) | Traces terraces, cranes, stacks, decks (1 m) | **Primary**: roof heights ±0.3 m, ground, terraces, profiles | Roof planes, parapets, plant | — | Spacing by autocorrelation (truss panels) | Walls, anything under a deck or canopy, glass (reads low) | CC BY 4.0 |
| **LINZ LiDAR point cloud** (`pointcloud.py`) | Wall lines, setbacks | Slab levels, **storey height**, podium decks, roof plant, thin structures | Exact plant and parapets | Intensity only | **Storey count and rhythm**, balconies, fins in profile | Faces away from both flight lines; no colour | CC BY 4.0 |
| **LINZ 7.5 cm aerial** (`site.py`) | Outline check, layout of yards and decks | — | **Colour for low roofs** (< 35 m) | Roof colours, container colours | Rooftop courts, skylights, markings | Tall roofs lean (≈ 4 m at 50 m, ~25 m on CBD towers); one flight date | CC BY 4.0 |
| **Auckland Council 3D mesh 2023** (`mesh3d.py`, CBD–airport corridor) | Checks setbacks and curves | Rough (±0.25 m RMSE) — use the LiDAR | **Roofs without lean**, top view | **Primary for colours on every side** | **Fins, panels, window rhythm, signs, podium decks**, inner walls of a block | Outside the corridor; texture blur under canopies | CC BY 4.0 |
| **Mapillary** street imagery (`mapillary.py`) | — | — | — | Street-level colour check | Ground floor, entrances, signs by day | Pedestrian plazas, upper storeys at grazing angles | CC BY-SA 4.0 |
| **Photos** (venue, news, architect, Commons; "Photos" below) | — | — | Undersides, roof edges | Materials close up | **Signs (also at night)**, under-structure (bridge decks), interiors you need | Renders that aren't as-built; other buildings | Per photo: reference only, never embedded |
| **Records & specs** (news, Wikidata, Structurae, manufacturers, listings) | — | Published heights, spans, levels | — | — | Architect, year, units, uses of each level | Marketing numbers | Facts only |

## Which sources to use, and when to stop

Go down the list; each step says when to skip it. Stop when everything a player sees from the air is measured or backed by an image: don't chase detail no one sees at 300 kt.

1. **Always:** `site.py` (box with ~30 m margin) and `osm.py`. You now have the footprint and every height.
2. **Massing.** `heights.py --match <name>` per outline:
   - OSM `building:part`s whose heights agree with the LiDAR within ~2 m → they are the skeleton (Westfield). Skip 3.
   - p10–p90 spread under ~3 m → one flat prism at the median. Skip 3.
   - Otherwise go to 3.
3. **Shape from the LiDAR:** terraces inside the outline (`sites/scene_beach_road.py`) for towers on podiums; least-squares planes for tilted roofs (Spark Arena); profiles along an axis for bridges and long structures (`sites/harbour_bridge.py`); masks and seeds for repeated objects (`sites/ports_of_auckland.py`).
4. **Storeys and thin structure** — only if the building has visible floor bands, balconies, setbacks you can't see in the raster, or thin parts (trusses, masts, cranes): `pointcloud.py`. It gives the storey height the facade texture needs. Skip it for sheds, malls and anything under ~15 m.
5. **Colours and facades:**
   - Inside the mesh's coverage (the CBD, the waterfront, the corridor to the airport): `mesh3d.py --match <name>` and read all four sides and the top. That usually covers every side; take only signs, night colours and ground-floor details from 6.
   - Outside it: go to 6 for every side.
6. **Street level:** `mapillary.py` (probes on the street itself), then photos for signs and anything the street can't reach. Skip what 5 already showed.
7. **Roofs:** under ~35 m drape the aerial; above, take the colour from the mesh's top view (or model the roof) and the plant from the point cloud.
8. **What nothing measures** (under a deck, inside a podium): photos and published specs, and mark it *guessed* on the review page.
9. **Facts** (levels, year, uses): records. They check the LiDAR count; they never replace it.

## Routing table

| I want to… | Use | Cost (cloud container, measured 2026-10-03) |
|---|---|---|
| Get everything LINZ has for a site (LiDAR DSM/DEM 1 m, the 7.5 cm aerial, height map, game coordinates) | `python3 tools/hero/site.py --name <id> --lat <lat> --lon <lon> --size <m>` → `/tmp/hero/<id>/` | 6 min the first time (it reads the 17,739-item aerial STAC catalogue), **10 s after** (cached in `/tmp/hero/_stac`) |
| See whether someone already mapped it in 3D (OSM `building:part`, `height`, `building:levels`, `roof:shape`, colours) | `python3 tools/hero/osm.py --site /tmp/hero/<id>` → `osm.json` + a table | ~5 s |
| Check that OSM, LiDAR and the photo agree | `python3 tools/hero/overlay.py --site /tmp/hero/<id> [--match <name>]` → `overlay-ndsm.png`, `overlay-aerial.jpg`; look at both | ~2 s |
| Roof heights per OSM part (median for a flat roof, p90 for parapets, max for a spire/dome) | `python3 tools/hero/heights.py --site /tmp/hero/<id> [--match <name>]` | ~2 s |
| Storey height, slab levels, roof plant, wall lines; side views of the points | `python3 tools/hero/pointcloud.py --site /tmp/hero/<id> --match <name>` → `storeys.json`, `pc_<side>.png`, `points.npz` | ~1 min the first time (4 tiles, cached in `/tmp/hero/_laz`), seconds after |
| See every side and the roof in colour, straight on (walls no street reaches, podium decks, roofs without lean) | `python3 tools/hero/mesh3d.py --site /tmp/hero/<id> --match <name>` → `mesh_{south,north,east,west,top}.jpg` | ~50 s for three towers (116 nodes, cached in `/tmp/hero/_i3s`) |
| A box / slab / tower / mall that OSM already outlines | **The kit**: write `tools/hero/sites/<id>.py` (copy `westfield_newmarket.py`) → `model.json` | 30–60 min |
| A tower on a podium inside one outline | Terraces: copy `tools/hero/sites/scene_beach_road.py` | 20 min |
| A building with curved or tilted roofs, cylinders, trusses | **Bespoke**: fit primitives to the LiDAR in Python (planes: least squares in a mask), then copy `tools/hero/examples/spark-arena.html` and edit its geometry | 1–2 h |
| A bridge or other long structure | Profiles along its axis: copy `tools/hero/sites/harbour_bridge.py` | 1–2 h |
| A yard of repeated objects (containers, cranes, masts) | Copy `tools/hero/sites/ports_of_auckland.py` | 1–2 h |
| See every side a street reaches (entrances, signs) | `MAPILLARY_STREET_API=MLY|… python3 tools/hero/mapillary.py --site /tmp/hero/<id> --radius <m>` → `mly/sheet.jpg` | ~30 s |
| Find facade and sign photos | Section "Photos" below (WebSearch → venue/news/architect pages → `curl` + `grep` for image URLs → look at each) | 10–20 min |
| Turn `model.json` into a review page | `python3 tools/hero/build_prototype.py --site /tmp/hero/<id>` → `prototype.html`, publish it as a private Artifact | ~1 s + publish |
| A "before" shot of the site in the game | dev server, then `node tools/hero/today-shot.mjs --x=<game_x> --z=<game_z> --out=/tmp/hero/<id>/today.jpg [--from=se]` | ~1–2 min (SwiftShader) |
| Put the approved model in the game | Section "Port into the game" | half a day |

## Procedure

**0. Identify the site.** Name, address, approximate lat/lon (Wikipedia, OSM). Pick a box that holds the whole building with ~30 m margin (`--size`): one fetch, then re-centre once you've seen the height map (Westfield needed a second, shifted box).

**1. Go through the sources** in the order of "Which sources to use, and when to stop" above. Treat OSM heights and levels as hints: the LiDAR decides heights, the mesh and photos decide colours.

**2. Measure.** Read `ndsm.png` (height above ground) next to `aerial.jpg` and the mesh views. Decide the primitive per part:
- one flat roof: median DSM inside the ring; a wide p10–p90 spread means several levels → split the ring or use OSM parts;
- tilted planes: fit `h = a·x + b·z + c` with least squares in a mask and report the RMS (Spark Arena: 0.25 m and 0.32 m);
- cylinders, domes, spires: centre from the aerial, radius from the outline, height from the LiDAR max.
Sloping ground matters (Newmarket drops ~8 m across the site): walls start at the **lowest DEM** inside each ring, roofs at absolute DSM heights.

**3. Roofs.** Drape `aerial.jpg` on flat roofs (same local frame: `u = x/W, v = 1 − z/H`). It is a standard orthophoto, not a true ortho: **roofs lean away from the photo centre by about height × offset / flying height** — negligible under ~35 m (Westfield), up to ~25 m on the CBD towers. Above that, take the roof's colour from `mesh_top.jpg` (same frame, no lean) or model it.

**4. Facades and signs.** The mesh views first where they exist, then street imagery and photos (see "Photos"). Write down what each image shows and use only as-built images for geometry and materials.

**5. Prototype and review gate.** Kit: write the recipe and run `build_prototype.py`. Bespoke: edit a copy of the Spark Arena page. Take one look yourself (render it headless, see "Lessons"), fix what's obviously wrong, then **publish it as a private Artifact and get the owner's approval before porting**. The page shows the stages (the game today, the raw LiDAR, the hero model, an overlay) and a "measured / from images / guessed" ledger. Be honest in the ledger.

**6. Port into the game** (below), then update this skill's "Lessons".

## Layered sites (a hero standing on a hero)

When one hero stands inside another (a building in a park, a stadium in a precinct, a bridge over a port), build them as **layers**: a base layer and the ones on top, each with its own recipe, box and model.json. Worked example: the Auckland Domain (base) and the museum (top), composed in `tools/hero/sites/auckland_domain_museum_page.py`. The contract:

1. **Frames.** Every site frame is NZTM metres (`x = E − E0`, `z = N1 − N`), so a top layer moves into the base's frame by `(E0_top − E0_base, N1_base − N1_top)`. That is a pure translation, with no rotation or scaling. Never go through game XZ for this: it is lat/lon-linear and turns about 1° against NZTM.
2. **The top layer declares its footprint.** Its model.json carries `footprint` (ring), `E0` and `N1`. That ring is the only place the boundary is defined.
3. **The base layer keeps clear.** It takes the top layers' model.json files on `--exclude` (`auckland_domain.py --exclude <museum>/museum_model.json`). Inside footprint + 3 m it places no trees or buildings. It drops any crown whose radius reaches over the footprint. It fills the aerial under footprint + 2 m only, so the forecourt round the top layer stays photo and the top layer covers the fill. Build the top layer first.
4. **One ground.** Heights are absolute (NZVD2016). The top layer's walls start at the lowest LiDAR DEM inside its own outline, so it meets the base's ground with no gap or float.
5. **On the game's terrain** (the port), each part moves by `meshHeightAt − DEM` at its own anchor: trees at the trunk, small buildings at their centroid, and a big rigid building by **one** value at its centroid so its roofs stay level. Export that offset as a grid (`DATA.game.d`, 10 m) with the game's terrain, as the Domain page does.
6. **Port order and test.** Load the top layer before the base (its footprint is the base's exclusion). Test that no tree or base building lies within 3 m of the footprint, and that the top layer's base is within 0.5 m of `meshHeightAt` at its centroid. Fill the footprint in the game's baked aerial webp too.

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
- 2026-10-03: The LINZ 2024 aerial is a standard orthophoto (no true ortho exists for Auckland). Fine on roofs under ~35 m; take taller roofs from the 2023 mesh's top view or model them.
- 2026-10-03: Auckland Council's 2023 "Auckland CBD to Airport 3D Mesh" (I3S scene service, Zone 1A = CBD and waterfront, 6 cm texture, 25 cm RMSE, CC BY 4.0) is reachable without a key; use it, not the older, coarser 2020 "Auckland CBD – 3D Model". Its node geometry is gzip'd, positions are float32 offsets from each node's box centre in NZTM metres. On the Scene apartments it showed what no other source did: Scene Two's full-height green panel, Scene One's blue strip, yellow balcony accents on the north faces, the level-4 podium deck with its pool and tennis court.
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
- 2026-10-04: Many buildings at once: fetch the LiDAR for the whole area once (`site.py --size 3200` over the CBD: 1 m DSM/DEM in ~1 min) and run one recipe over a list, instead of a site per building. 68 towers take ~1 min.
- 2026-10-04: Tower kit levels: peaks of each outline's 1 m height histogram (≥ 25 m², merged under 3 m) give the terraces; then carve any group ≥ 16 m² more than 1.8 m off its terrace's roof into its own terrace (repeat: a carved step can hold another), fit a plane where it halves the RMS (ramped roofs, wedge crowns; cap the slope at 1:1, a step fit as a plane reads 5:1), and fold slivers under 60 m² into the touching terrace nearest in height. Without the carve and the planes 9 of 68 spot checks missed by 2–8 m.
- 2026-10-04: In a mode filter over height classes, let open ground (no class) vote too, or courtyards and street edges fill with roof and a plane fit sees 12 m RMS.
- 2026-10-04: The game's prisms have no holes: split a terrace with a courtyard on a line through the courtyard (`no_holes`), or the courtyard is roofed over.
- 2026-10-04: Round buffers (shapely's default join) add arcs of vertices: merging terraces with them took 68 towers from 1.5 k to 10.7 k vertices. Use mitred joins and a last 1.2 m simplify (4 k).
- 2026-10-04: A LINZ footprint's centroid can fall outside a concave footprint (Volt Apartments): replace LINZ buildings by a point *inside* each one (shapely `representative_point`), not by "centroid inside the hero's outline".
- 2026-10-04: Auckland Council's 3D mesh textures carry a blue-violet haze (CBD walls average R 158, G 156, B 181): white-balance colours read off it over the whole set (gray world) before use.
- 2026-10-04: Budget of the tower kit: 115 towers took the CBD mesh from 45.5 k to 58.6 k triangles on medium (33 k → 38 k on low, roof plant dropped there), in the same draw call. Each terrace is a prism from the ground, so the part count, not the ring detail, drives the triangles.
- 2026-10-04: `vite.e2e.config.ts` neither watches nor reloads: restart the dev server after every data or code change before a shot, or the "after" shot shows the first version you served (it cost a round of wrong shots here).
- 2026-10-03: Parks and bush: one crown per tree from the 1 m nDSM. Mask nDSM > 2.5 m off buildings, smooth it (σ 1 m), take local maxima with a window that grows with height (3/5/7 m), and run a watershed from those tops. Then widen each equal-area radius by 10 %, or a closed canopy shows gaps. Crown bases at 40 % of the height read as lollipops; 30 % reads as bush. The Domain gave 2,095 trees over 34.7 ha of canopy, and the circles matched the aerial on the first try.
- 2026-10-03: The game keeps scattered trees off the aerial square (`aerialCovers` in Scenery's tree blocker), so on medium and high every park inside it (the Domain, Albert Park) has no 3D trees at all. Its high-tier terrain there is within ~2 m RMS of the LiDAR, so the fix is the vegetation, not the ground.
- 2026-10-03: When a page template's header comment names its placeholders, a plain `str.replace` fills the comment too and embeds the data twice (12 MB instead of 6). Don't write the placeholder tokens in comments.
- 2026-10-03: Facades from the 2023 mesh with no hand texturing: sample the mesh inside the outline + 1.5 m (`mesh3d.sample_points`), splat it orthographically onto four axis planes and the roof plan in frames you choose (u = x or z over the outline's extent, v = height from the ground), then give each wall the side its outward normal faces most. Fill small gaps from the nearest pixel and run a 3 px median, because the mesh texture is speckled. On the museum every facade read correctly first time; inner courtyard walls get the outer facade's colours, which nobody sees from the air.
- 2026-10-03: A glass dome or roof: take its LiDAR surface on a 1 m grid inside the OSM ring. Fill the returns that fell through the glass (well below the rim) from the nearest roof cell, smooth 1.5 m and drape the mesh's top view. That beat any parametric dome for the museum's undulating atrium.
- 2026-10-03: LiDAR "trees" in a park include monuments, poles and cars. Drop crowns whose aerial colour is pale and not green (mean > 150, 2g − r − b < 15); that removed the Auckland Cenotaph.

