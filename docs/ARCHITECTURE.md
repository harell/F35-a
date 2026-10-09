# F35-A — Architecture & Game Design

F35-A is a mobile-first combat flight simulator that runs in a phone browser (iOS Safari 15+,
Android Chrome). It is inspired by NovaLogic's *F-22 Raptor* (1997), with the F-35A Lightning II as the player jet:
mission-based campaign over Auckland, air-to-air and SAM threats, AWACS radio calls,
multiple camera views, and an arcade-leaning but believable flight model.

**Engine choice:** Unreal Engine 5 can't target mobile browsers (HTML5 export was removed in UE 4.24).
The game is built on **three.js (WebGL 2) + TypeScript + Vite + Web Audio**, packaged as a PWA.

> ## ⚠️ ORCHESTRATOR UPDATE — SETTING IS AUCKLAND, NEW ZEALAND (supersedes older task text)
>
> The user has asked for the game's scenery to be **Auckland CBD, New Zealand**. `TheaterId` (see `src/core/types.ts`)
> has a single member, **`'auckland'`**: it is the **only theatre**:
>
> * **Every mission uses `theater: 'auckland'`**: campaign, training and Instant Action (vary time of day and weather
>   for variety). The four procedural theatres (generic terrain, sky presets and scenery, Instant Action only) were
>   removed in issue #73; `ia_<mode>_auckland` is the only Instant Action id form.
> * Geography reference with world coordinates is in **`src/core/auckland.ts`**. The Sky Tower is the origin; use
>   `AKL.<id>` for landmark positions, for example `AKL.rangitoto`, `AKL.whenuapai`, `AKL.port`, `AKL.bridge_s`, `AKL.waiheke`.
>   The CBD sits on the south shore of the Waitematā Harbour, the Hauraki Gulf and its islands lie to the east/north-east,
>   the Manukau Harbour and the airport to the south-west/south, and the Waitākere Ranges (≤474 m) plus the Tasman coast to the west.
> * **Campaign fiction:** the IRGC campaign (epic #72, `src/missions/content/irgc.ts`, `irgcHauraki.ts` and `irgcWaiheke.ts`,
>   mission ids `g01`–`g03`): Shahed one-way attack drones over the city, IRGC Navy fast boats in the Hauraki Gulf and the
>   Waiheke air defences round a stoat on the Onetangi dunes. F-35As fly
>   from **RNZAF Base Auckland (Whenuapai)** to defend Auckland. Enemy targets are always **military**; never target
>   civilian landmarks. The CBD, Sky Tower and Harbour Bridge are things you **protect**. Optional bonus: flying under the
>   Harbour Bridge (43 m clearance) earns a score bonus and a HUD message. Instant Action still uses a hostile SAM belt on
>   the Gulf islands and an enemy-held airstrip on Waiheke.
> * **Campaigns:** `CAMPAIGNS` in `src/missions/index.ts` lists every campaign (today the IRGC campaign only; Operation
>   Southern Cross, c01–c11, was deleted, so old saves may still hold those ids: never reuse them). Each campaign has its
>   own unlock chain (its first mission is always unlocked, a win unlocks the next one of the same campaign), its own ending
>   screen and a card in the campaign picker (shown when more than one is playable). Progress stays keyed by mission id, so
>   mission ids must be unique across campaigns.
> * Terrain heights: sea level 0, isthmus 20–80 m, volcanic cones up to 196 m (Mt Eden), Rangitoto 260 m, Waitākere
>   ≤474 m, Hunua ≤688 m at the SE edge. Aircraft spawn altitudes can be low: a 1,000–3,000 m CAP is fine.

## Design pillars

1. **Mobile-first.** Landscape, two thumbs. Throttle on the left, side-stick on the right (like the real
   F-35 HOTAS), big fire buttons, and a HUD that stays readable on a 390 px-tall screen. Tilt steering is optional.
   Missions last 5–12 minutes. Performance target is 60 fps on a mid-range 2022 phone at 'medium' quality.
2. **Believable F-35A.** It has 9 g and AoA limits and a fly-by-wire g-command law, and afterburner burns fuel hard.
   Energy management matters. Stealth and sensor fusion are the jet's edge: enemies struggle to
   see a clean F-35, and "beast mode" external stores trade stealth for firepower.
3. **Tense threat environment.** The RWR shows search, lock and launch. Missile approach warning comes from DAS.
   Flares and chaff work, and so do notching, terrain masking and out-running a missile's energy.
   SAM rings appear on the TSD, and pop-up SAMs, AAA and MANPADS threaten low flight.
4. **Sound-rich cockpit.** Betty voice warnings, RWR tones, the AIM-9X growl, missile launch roar,
   the GAU-22 "brrrt", engine and afterburner rumble, wind, radio chatter and the AWACS picture.
5. **Juice.** Missile smoke trails, explosions, burning wrecks, vapor cones, wingtip vortices, contrails,
   tracers, camera shake, haptics and hit markers. Kill feedback is loud and clear.

## Scale (gameplay-compressed ≈ 40–50 % of real ranges)

| Item | Value |
|---|---|
| World | 80 km × 80 km (±40 km); ocean/flat beyond. Sea level y = 0 |
| F-35A radar (APG-81) vs 5 m² fighter | ~60 km (radar equation R ∝ RCS^¼) |
| Enemy fighter radar vs clean F-35A (RCS ≈ 0.001 m²) | ~10 km; vs beast mode ≈ 25–30 km |
| AIM-120D Rmax (co-alt, head-on) | ~30 km, NEZ ~12 km |
| AIM-9X | 0.3–8 km, ±90° off-boresight via HMD |
| GAU-22 | effective ≤ 1.2 km |
| R-77 / R-27ER / R-73 | 25 / 20 / 6 km |
| SA-6 / SA-15 / SA-18 (AD boat) / ZSU-23-4 | 20 / 12 / 5 / 2.5 km |
| Typical cruise | 250 m/s (~480 kt); Mach 1.6 max; 50,000 ft ceiling |

## Conventions

See `src/core/types.ts` header: world +X east, +Y up, −Z north; the body nose is −Z; aerospace body rates are
`AircraftEntity.rates` (x = p roll, y = q pitch, z = r yaw). Internals are SI; the HMD shows knots, feet and ft/min.
No per-frame allocations in hot loops: reuse module-level scratch `Vector3`/`Quaternion`s.

## Module map & ownership

| Module | Owner | Files | Export used by Game.ts |
|---|---|---|---|
| Contracts / core | orchestrator | `src/core/*`, `src/sim/api.ts`, `src/sim/entities.ts`, `src/game/*`, `src/main.ts`, `index.html` | — |
| Sim core (flight model, world, warnings) | SIM-CORE | `src/sim/World.ts`, `src/sim/flight/**`, `src/sim/Warnings.ts`, `tests/sim-*.test.ts` | `createSimWorld` |
| Weapons, sensors, SAMs | COMBAT | `src/sim/weapons/**`, `src/sim/sensors/**`, `src/sim/sam/**`, `tests/combat-*.test.ts` | `createCombatSystem` |
| AI pilots | AI | `src/ai/**`, `tests/ai-*.test.ts` | `createAiBrain` |
| Terrain, sky, water, clouds, scenery | WORLD | `src/world/**`, `public/textures/**`, `tests/world-*.test.ts` | `createEnvironment` |
| 3D models, entity visuals, effects, cameras | MODELS | `src/render/**`, `tests/render-*.test.ts` | `createEntityRenderer`, `createEffects`, `createCameraRig` |
| HMD symbology + 3D cockpit + PCD | HUD | `src/hud/**`, `tests/hud-*.test.ts` | `createHud`, `createCockpit` |
| Audio (synth + voice) | AUDIO | `src/audio/**`, `tools/gen-voices.sh`, `public/audio/**` | `createAudio` |
| Touch/tilt/keyboard/gamepad input, menus, PWA | UI | `src/input/**`, `src/ui/**`, `public/manifest.webmanifest`, `public/sw.js`, `public/icons/**`, `tools/gen-icons.mjs` | `createInput`, `createUi` |
| Missions, campaigns, scoring | MISSIONS | `src/missions/**`, `tests/missions-*.test.ts` | `CAMPAIGNS`, `TRAINING`, `buildInstantMission`, `createMissionRunner`, progress fns, `terrainPadsFor` |

## Protected landmarks (the Sky Tower)

The Sky Tower is a sim **landmark** (`src/sim/landmarks.ts`, `SimWorld.landmarks`), not an entity: it is never in
`aircraft` / `sams` / `ground`, so sensors, TGT cycling, AI, objectives and scoring never see it. Its shape (OpenStreetMap
building parts) and its scripted collapse are pure data and functions in `src/core/skyTower.ts`, shared by the sim (hit
volume, collisions, collapse explosions) and the renderer (`src/world/scenery/skyTower.ts`, posed from sim time). One hit
from the player's bomb, AGM or AAM destroys it at once, damaged or not (`landmark:destroyed`, cause `player`). Enemy
attacks register through `hitSkyTower()` / `hitLandmark()` in `src/sim/landmarks.ts`: the first hit leaves it damaged
(`landmark:damaged`; fire and smoke on its face from `src/render/effects/Effects.ts`), the second brings it down (cause
`enemy`). A one-way drone that flies into it is such an enemy hit: the sim only reports the impact (`drone:impact` with
the landmark), and the mission runner (`src/missions/runtime/landmarks.ts`) registers it with `hitLandmark()`, makes the
radio and HUD calls and fails the sortie on a collapse, with a different reason for each cause. The tower is **never destroyed for good**: nothing about it is saved,
so every mission start and restart builds it intact, and old saves' `skyTowerDown` is dropped on load.

## One-way attack drones (the Shahed-136)

Missiles are never sensor contacts or missile targets, so the drone the player shoots down is an **aircraft type**,
`shahed136` (team red): radar, HMD, missiles, gun and objectives work on it with no special case. While alive it
flies a kinematic profile like the civil airliners (`src/sim/drone/oneWay.ts`, `AircraftEntity.oneWay`; the world
skips the flight model and the AI for it): a fixed route at a fixed height and speed, then a straight dive into its
target point. It dives only when lined up on the target; a target just past its last waypoint makes it fly on and come
back round. It never manoeuvres or reacts, and carries no stores, gun, flares or radar. It never holds a beam on
purpose, so it never notches a radar or a seeker (`notchDepth` in `src/sim/weapons/ew.ts` is 0 for it). Reaching the target, or
flying into a landmark on the way, emits `drone:impact` (with the landmark, if any) and detonates it (`destroyed`,
no attacker; `oneWay.impacted` tells it from a drone that was shot down). Wherever it is destroyed its warhead damages
every other live aircraft within 150 m (`AIRCRAFT_WARHEAD` in `src/sim/damage/tables.ts`, applied as `flak`), never
other drones, so one missile can't clear a swarm by chain reaction. A mission spawns a swarm with an aircraft group
carrying `oneWay` (target point and optional route; `formation: 'triangle'` gives rows of 1, 2, 3, 4) in
`src/missions/runtime/spawner.ts`. Each drone flies the route shifted by its slot, and at a fixed speed the triangle
can't wheel round a corner: it keeps its first-leg orientation, so a swarm whose shape matters wants a straight route.
Converging on one target point, a row abreast closes up into a bunch that one missile can clear: `oneWay.stagger` steps
each drone further back than the one before it, so the swarm funnels into single file instead (g01). Its buzz is `PistonBuzzVoice` (`src/audio/world/DroneSounds.ts`), not a jet voice.

## Real airfields (OpenStreetMap)

Whenuapai, Auckland Airport, Ardmore and North Shore (Dairy Flat) come in two layers. **`src/core/airfields.ts`** holds
their runway thresholds (from OSM), synchronous and always present. Gameplay reads only this table: the home base
`FEATURES.whenuapai`, the `AKL` landmarks at the runway centres, and the civil traffic on 05R/23L.
**`src/world/scenery/data/auckland-osm.bin`** (baked by `tools/osm`, ODbL, loaded by `aucklandOsm.ts`) adds the
taxiways, aprons, hangars, terminals and a levelled outline. `allFeatures('auckland', …)` always adds the four airfields
(a mission airbase within 2.5 km of one is dropped as a duplicate). Each gets an `outline` the terrain levels
(`Footprint.kind = 'poly'`), and the scenery builds `buildRealAirfield`. Without the file, the template airbase is
laid on the same real runways. `tests/world-osm.test.ts` keeps the table and the bake in step.

## Real land use (OpenStreetMap, #122)

**`src/world/scenery/data/auckland-landuse.bin`** (baked by `tools/osm/landuse.py`, ODbL; 436 kB gzip, loaded by
`aucklandLandUse.ts` on the medium and high tiers only, `worldConfig().landUse`) is a 16 m class grid over the ±40 km
world: residential, commercial / retail, industrial, park, pitch, golf, school, hospital, cemetery, vineyard,
farmland, or none. Three readers: `applyLandUse` (`src/world/terrain/landUse.ts`, on the base heightfield in
`finishTerrain`, main thread only, `TerrainSpec.landUse`) sets the built-up density from the class shares of each
86 m sample, so the colour map, the garden trees and the house scatter follow the real suburbs and parks; the
terrain shader (`landUseAt()`, the grid as an RGBA8 texture of 4 × 2 nibbles) paints open ground (pitches, fairways,
headstones, vine rows; no procedural streets across parks and campuses) and sheds round car parks; `HouseSource`
places houses only off open ground and one flat-roofed shed (`SHED`, a third instanced draw) per unit of three lots
on commercial, industrial and hospital land and on some school land (`landUseLots.ts` holds the shared rules, so
the painted and the 3D sheds agree). A cell without a class keeps the hand-traced suburbs (`AKL_URBAN`, `AKL_PARKS`),
which stay the low tier's and the offline fallback. Gameplay never reads it.

## Helipads (OpenStreetMap + LiDAR, #125)

`HELIPADS` in `src/core/sites.ts` (generated `src/core/helipadsData.ts`, baked by `tools/osm/helipads.py`) is every
OSM helipad and heliport in the world box with its size, heading, parent site (hospital, airfield, naval base,
vineyard), area and height; rooftop pads carry the 2024 LiDAR roof height. It is synchronous and always present, like
`WIRI_TANKS`: the scenery draws every pad in one decal draw call (`src/world/scenery/helipads.ts`: concrete with a
yellow circle at hospitals, airfields and heliports, grass elsewhere; green edge lights at night on the hospital,
airfield and heliport pads), and a rooftop pad whose building the game doesn't model yet (Auckland City Hospital:
the LINZ CBD buildings stop short of Grafton) stands on a plain block in the sites mesh. Gameplay may read the table
(the civil helicopters fly between its pads).

## Waterfront and strategic sites (OpenStreetMap)

`src/world/scenery/aucklandSites.ts` builds from the same OSM file: the Ports of Auckland outline as a wharf deck (it
includes the Fergusson reclamation the LINZ coastline predates), with its sheds, container stacks and procedural
cranes on the real berth faces; every pier, pontoon and breakwater, with yachts along the marina pontoons; Devonport
Naval Base (`AKL.naval_base`: buildings, Calliope Dock); the Wiri oil terminal (`AKL.wiri`); and stadiums with OSM
stands (`AKL.eden_park`). Water tests use the LINZ coastline rasterised at 2 m, not the coarse terrain mesh. The
houses and trees scatter keeps off these sites. Gameplay never reads the file: the moored ships' berths
(`PORT_BERTHS` in `missions/runtime/shipping.ts`), the Wiri tanks (`WIRI_TANKS` in `src/core/sites.ts`) and the
Harbour Bridge piers (`BRIDGE_PIERS_T`, which also set the fly-under span) are static tables that
`tests/world-sites.test.ts` checks against it. Without the file the hand-placed port and marinas come back, and the
Wiri tanks still stand.

## Aerial photo (LINZ, CBD and waterfront; Devonport and the gulf islands)

`src/world/terrain/theaters/aucklandAerial.ts` loads the LINZ 2024 aerial photo of a 5.12 km square over the CBD,
the waterfront and Devonport (`AERIAL_RECT`; baked by `tools/linz/aerial.py`): 2048² on the medium tier, 4096² on
high, never on low (`worldConfig().aerial`, the *Aerial photo* setting, `?aerial=0`). Its alpha marks land and the
OSM wharf decks. The terrain shader replaces its procedural ground colour with it (fading out at the square's edge),
the wharf decks and the naval base take it on their top faces, so do the CBD's LINZ buildings (below), and the house / tree scatter and the procedural
suburb centres keep off it (`aerialCovers`). Gameplay never reads it. Without it (download failed, low tier) the
procedural ground stays. **The outer photo (#120)** continues it over the rest of the Devonport peninsula (same
resolution) and over the gulf islands' land (Rangitoto, Motutapu, Rakino, Motuihe, Browns Island, Waiheke; 5 m on
high, 10 m on medium): boxes packed into one atlas per tier (`AERIAL_OUTER` from `auckland-aerial-outer.json`,
`auckland-aerial-outer-2048.webp`; on high `auckland-aerial-outer-4096.ktx2`, GPU-compressed ETC1S that three.js's
`KTX2Loader` transcodes in a worker to the GPU's block format, ≈ 35 MB instead of ≈ 140 MB, with its alpha in
`auckland-aerial-outer-cover.png`), loaded with the square (and only with it: it takes the square's grade).
The terrain shader's `aerialPhoto()` sums the square's weight and every box's (alpha × the box's own edge fade,
sampled with `textureGrad`); the Devonport boxes overlap the square by their 320 m feather so the fades cross over.
The scatters keep off where that sum is over ½ (`aerialCovers(x, z, cover)`, the outer alpha read back once at load
through a 512-wide canvas: `imageAlphaMask`). The photo-topped building material still reads the square only. Its colours are graded toward the procedural suburbs it fades into (`aerialGrade`: the
photo's land average measured at load, scaled onto the suburbs' far albedo), fully at dawn, dusk and night, a trace by
day. That matches the average albedo; two lighting terms do the rest. Under a low sun (dawn, dusk) the photo also
takes the light of a 28° roof facing the sun on 80 % of its area (`aerialLowSun`, `AERIAL_LIGHT_GLSL`, on the terrain
and the photo-topped buildings), as the procedural 3D houses round it catch the sun on their sun-facing slopes and
walls; nothing by day or under the moon. It applies only as far as those houses are drawn: it follows their scatter's
thinning with slant range (`aerialHouseShare`, the same curve as `scatterKeep` in `scatter.ts`, with the tier's
`houseRadius` as the `uAerialHouseR` uniform) and is gone beyond their radius, where both sides are lit as flat ground.
At night the procedural ground still runs under the photo for its lamps and lit windows, and the photo gives half its
colour to that ground (`AERIAL_NIGHT_MIX`; the photo-topped decks and roofs give it to their own colour), so the lamps
sit on the warmer procedural colour instead of a cool grey square. The other way round, the procedural lawns, parks and pitches (`terrainStyle().garden`) are a muted green half
way from a fresh lime to the photo's lawns, so the square's edge (Ponsonby Rd, Newmarket) is no hard break from
grey-green photo to lime lots.

**Real houses under the photo (#121).** Where the photo covers the Devonport peninsula and the gulf islands, the house
scatter draws the real houses instead (`src/world/scenery/aucklandHouses.ts`, `auckland-houses.bin`, ≈ 17,000 houses at
8 bytes each, baked by `tools/linz/houses.py` + `houses.ts`): each LINZ outline up to 600 m² as an oriented rectangle with
its LiDAR eave, ridge rise and photo roof colour, through the same instanced house and apartment archetypes
(`HouseSource`; the roof's rise rides in the record's `aux` slot to the `aRise` attribute of the `HOUSES` shader), so no
draw call is added. The file also carries its coverage (the land under those photo boxes, 32 m cells); `houseCoverage`
turns it into lot-mask cells joined to `Scenery.siteMask`, so the procedural lots and streets (terrain shader), the
procedural and frontage houses and the centres' blocks keep off it on every tier, by day and by night. Without the file
the suburbs there are procedural again (and the photo keeps them off on medium and high, as before).

**Real tree canopy (#123).** `src/world/terrain/theaters/aucklandCanopy.ts` loads `auckland-canopy.bin` (baked by
`tools/linz/canopy.py` + `canopy.ts` from the 2024 LiDAR: DSM − DEM ≥ 3 m, the LINZ outlines buffered 1 m and the
buildings since 2017 taken out) on the medium and high tiers, with the land use: the share of each 32 m cell's land under
trees (16 levels, on the land-use lattice) and the trees' 75th-percentile height per 128 m, over Devonport, the North
Shore to Takapuna, the CBD, the isthmus and the flight corridor (20 Part 1 sheets) and the island boxes of the outer photo
(Part 2). Where it covers, `TreeSource` grows its trees by it (`canopyTree`: a 14 m point takes a tree with probability
−ln(1 − share) · 196 m² / crown area, crowns sized from the measured height and widened in a closed canopy) instead of the
Topo50 cover and the even garden trees, **on the photo too**: the photo's blocker keeps only the procedural trees off, so
Rangitoto, the islands' bush and Devonport's gardens get 3D trees standing on their photographed crowns, clear of the real
houses (#121), the road ribbons, the landmark sites and, in the procedural suburbs, the painted streets and houses. On
the photo a canopy tree (record aux ≥ 1, the `aPhoto` attribute) takes the photo's colour at its trunk in the foliage
vertex shader (`treePhoto`, a ≈ 12 m mip of the square or the outer atlas), so its crown sits in the photographed forest
instead of on it. With the canopy the broadleaf mesh gets twice the tier's tree budget, and the tree scatter is
`fitCapacity`: over budget it thins every tile evenly and widens the crowns it keeps (up to 2.2×), so a forest over a
whole island stays a forest instead of ending in a square of the nearest tiles. The
terrain shader reads the share from a pyramid (32–256 m box averages, `canopyPyramid`) stored in extra rows of the land-use
texture (the fragment shader has no sampler unit left): the suburbs' far-field albedo is `OPEN_MIX` (urbanColor.ts) mixed
with the canopy colour by the share, the lot-level garden trees follow it, and on open ground the forest tone does; the
grid's edge blends into the procedural mix. Without the file (low tier, offline) the Topo50 cover and the garden-tree
rule stay. Gameplay never reads it.

**Island and Devonport roads (#127).** Where the real houses stand (#121's coverage: the Devonport peninsula and the
gulf islands) every LINZ road is a ribbon (`ROAD_LOCAL` in `auckland-roads.bin`, baked by `tools/linz/islandRoads.ts`:
the address road sections with the Topo50 surface, and Topo50 for the islands' roads with no addresses), sealed or
unsealed, 4.5–9 m wide. They join `RoadNetwork`, so the procedural and real houses, the trees and the canopy keep off
them, and are drawn as one unlit mesh (`akl-local-roads`, two vertices across, the sealed or gravel half of
`createLocalRoadTexture`; no lamp posts, no frontage lots, low over causeways). On the low tier (no photo) they are the
streets of the covered land, which #121 left as plain garden ground. Without the data file nothing changes.

**The corridor's real houses and streets, streamed (#126).** From Whenuapai to Auckland Airport (the box of epic #119's
count inside the 2024 LiDAR Part 1 sheets: ≈ 286,000 houses) the real houses and their LINZ streets ship as 136 tiles of
2,048 m (`src/world/terrain/data/corridor/akl-corridor-<i>_<j>.bin`, ≈ 2.4 MB gzip in all, baked by
`tools/linz/corridor-houses.py` + `.ts`; #121's record format, #127's local road ribbons) and a bundled manifest
(`corridor.json`: tiles, bytes, the shared roof palette). `CorridorHouses` (`corridorHouses.ts`, built by
`createCorridorHouses` in `corridorTiles.ts` from the Environment) fetches the tiles whose square comes within the house
scatter's radius + 1.5 km of the camera, nearest first, two at a time, while the houses are drawn (`Scenery.update`), and
drops them past radius + 6 km. A tile's arrival: its houses join `HouseSource` (and the trees keep off them), its coverage
(32 m cells) is set in `cover`, under which no procedural, frontage or shed lot is built, the town centres' blocks hide
(their vertex ranges collapsed in `akl-centres`), and the terrain shader reads the cells from rows below the site mask's
in the same texture (`setHouseMask` / `updateHouseMask`: no sampler unit to spare) and paints no procedural
streets there, nor lots where the 3D houses are drawn (gardens round them); as they thin out (`realHouseShare`, the
scatter's curve) and past where the scatter's capacity runs out (`TileScatter.reach`: a dense real suburb fills the
medium tier's 6,000 houses within about 1.4 km, about as far as the high tier's 7,500 over its wider radius) the lots' roofs come back as the mid-range mosaic and the far
average, without the grid's streets. Its streets join one unlit mesh (`akl-corridor-roads`, rebuilt as
tiles come and go: +1 draw call) and the trees keep off them. The scatter tiles under a changed tile regenerate
(`TileScatter.invalidate`), drawn as they were until then. The service worker never precaches the tiles and keeps them
in a cache of their own (`f35a-tiles-<VERSION>`). Until a tile has loaded, offline, and without the files, the
procedural suburbs stay.

**Landmark buildings (#124).** `src/world/scenery/aucklandLandmarks.ts` loads `auckland-landmarks.bin` (baked by
`tools/linz/landmark-buildings.py` + `.ts`: OSM hospital, mall, station and school sites, the LINZ outlines inside them
with their 2024 LiDAR roof levels, the station platforms moved beside the railway ribbons, and the outlines over 600 m²
that #121 leaves out on Devonport and the islands) on every tier. `aucklandBuildings()` appends them to the LINZ list
(`Building.landmark`: kind, site; named after the site), so `buildCBD` extrudes them with their kind's facade
(`landmarkFacade`: hospitals white with many windows, malls blank with a lit signage band, stations, schools brick and
weatherboard; a platform canopy is a roof slab) into one mesh per 8 km square (`LANDMARK_TILE`, through the
`houseBuilder` callback; facades, no photo roofs), hidden beyond `LANDMARK_FAR` of the camera; they are scenery only
(`buildBuildingGeometry` skips them: as solids the mission bot flew into a hospital tower), and the hospital rooftop
helipads (#125) now sit on their roofs. The site outlines
join `siteRings()` (no procedural street grid, lots, sheds or centre blocks on them), the footprints and platforms
`siteBlocker()` (`landmarkCovers`: no tree or house, procedural or #121's, on them). At night a hospital's windows are
lit (`buildFacadeLightPoints` with a 55 % share), a mall's car park has lamps. Without the file nothing changes.

**Photo roofs (#140).** The photo is a standard orthophoto, not a true one: a roof h m up is drawn displaced from its
footprint by h × the camera's lean there (0.07 m per metre typically in the CBD, the mosaic switching frame to frame).
`tools/linz/roofs.py` registers every LINZ building the game draws on the photo's 0.3 m source tiles (edge correlation of
the outline, every side at once, the prisms leaning in proportion to their height) and bakes one offset per building into
`auckland-buildings.bin` (format v2, `Building.roof`, `roofPhotoOffset`). The CBD mesh then carries an int16 `aRoof`
attribute (`GeometryBuilder.enablePhotoRoofs`, only when the tier has the photo) and draws with the `roofs` variant of the
building material: a photo roof samples the photo at its footprint + offset, its walls' top 0.9 m take the photo's roof
border as a parapet band (no windows there), and every other part of the mesh (the tower kit, the heroes, the
neighbourhoods) keeps its own roof. A roof under 35 m that failed the correlation takes the offset its neighbours'
lean predicts; a taller one keeps today's plain roof. Same mesh, same draw call, same triangles; low tier unchanged.

**Building lighting and facades (#141).** Every wall of the building material takes sky light on top of the hemisphere
term: the sky dome's radiance half way up in the direction it faces (its horizon colour, warmer towards the sun,
blended with the zenith; × `SKY_WALL_FILL`), so shaded towers keep their form and take the sky's tint. The CBD mesh also carries an int16 `aFacade` attribute on every tier
(`GeometryBuilder.enableFacades` / `setFacade`, the `facades` variant of the material): each building's base (its walls
darken over the bottom `CONTACT_HEIGHT` m, contact shading without SSAO), and for the LINZ blocks their storey height,
a seed and a glass flag. `buildingFacade` (auckland.ts) picks colour, window style and storey from the building's
OpenStreetMap tags where it has them (`Building.osm`, baked by `tools/linz/facades.py`: use, `building:levels`,
material, colour) and from its height class as before where not; the shader draws one floor per storey from the base,
window width and margins from the seed (`STOREY_WINDOWS`), and a glass facade as a curtain wall. Glass (window panes,
glass facades, the tower kit's curtain walls) is a dark body colour plus the sky it reflects, added as radiance after the
lighting and weighted by Schlick's Fresnel (`GLASS_REFLECT`, more towards grazing), so glass in shade still reads as
glass. A building's own grid fades to its average once a cell is under ~6 px and keeps its style's mean night glow. The night facade lights
(`buildFacadeLightPoints`) sit on the same storeys. Same mesh, draw calls and triangles.

The terrain's night glow constants live in `src/world/terrain/nightGlow.ts`. In the CBD region (`cbdPattern`) the
streets themselves glow with their lamps (the posts are `buildCBD`'s fixtures), with shop windows on the footpaths and
some floodlit plazas; every term is weighted by its share of the pixel footprint, and the far constant is the near
pattern's average over the real street map (`cbdNightGlow`, checked in `tests/world-night.test.ts`), so the CBD's
ground keeps most of its glow at every range (no dark ring) and is brighter than the suburbs' from afar.

The suburbs' painted lots and the 3D houses on them keep a corridor clear along the road and railway ribbons:
`src/world/scenery/lotMask.ts` is one bit per 12 m cell, set near a ribbon, and both the terrain shader
(`lotMasked()`, `TerrainRenderer.setLotMask`) and `HouseSource` leave a lot unbuilt when its centre falls in a set
cell, so painted and 3D houses still agree.
Along the arterials and main streets (LINZ, `tools/linz/roads.ts`) that corridor starts at the back of a frontage band:
`src/world/scenery/frontage.ts` lines each side of the road with lots that face it (footpath, front lawn, house,
driveway; shops in the town centres), fitted in blocks between the grid's side streets, and every district an arterial
runs through turns its street grid to the road (`urbanGrid.ts districtAngles`). The shader's `frontageLot()` and
`HouseSource` read the same lots (textures from `TerrainRenderer.setFrontage`), so painted and 3D houses agree there too.

## Civil helicopters (#144)

Three code-built types (`aw169` Westpac Rescue, `bell429` police "Eagle", `h130` sightseeing; `src/render/models/aircraft/helicopters.ts`)
are neutral sim entities like the airliners, spawned once per Auckland sortie by `src/missions/runtime/helicopters.ts`
(`QualitySettings.helicopters`: 1 low, 3 medium, 4 high; seeded from the mission) and flown kinematically by
`src/sim/civil/heli.ts` (`AircraftEntity.heli`; the world skips the flight model, the collisions skip them while alive):
the rescue AW169 shuttles between Auckland City Hospital's rooftop pad and Waiheke's Onetangi pad (now and then North
Shore or Middlemore), the police Bell 429 orbits a point drifting over the CBD and the motorways at 1,000–1,500 ft, and
the sightseeing H130s shuttle between Mechanics Bay and a Waiheke vineyard. Their pads come from `HELIPADS`
(`src/core/sites.ts`, #125). Being neutral they are off the datalink, boxed `CIV`, ranked last for designation and
broadcast ADS-B in the stroll; shooting one down is a civilian loss ("CIVILIAN HELICOPTER DOWN", −500, −0.15 rating,
a debrief row, `MissionResultExt.civilianHeliKills`), never a kill and never a failed sortie, and the wreck falls on
the flight model. They are drawn instanced, one draw call per type (`src/render/visuals/HeliBatch.ts`: the airframe
and both rotors merged, the rotors turned in the vertex shader); their `AircraftVisual` keeps no meshes
(`AircraftPrototype.instanced`), only the pose, LOD distance and nav-light anchors, which join the shared sprite batch.
The Eagle's searchlight is one more instanced draw, at night only.

## Named superyachts (#145)

Koru, Serene, A and Aquijo are civil ships like the merchant ships, each yacht a `VesselClass` of her own
(`SuperyachtId`, `src/core/superyachts.ts`): her shape data there (length, beam, colours, bow rake, tumblehome,
superstructure tiers, masts or radar mast) sizes the sim's hull volume (`VESSEL_DATA`), the ship motion and sinking
(`SHIP_DIMS`, the masts included) and the model, built in code by `src/render/models/superyachts.ts` (one merged mesh,
one draw call, the glossy `yacht` material; night lights through `ShipLight`: navigation, lit windows, blue underwater
lights, red obstruction lights on the mast tops). `SUPERYACHT_BERTHS` (Koru on Wynyard Wharf, A at Silo Marina, Aquijo in
the Viaduct) is a static table checked against the LINZ coast and the OSM quays (`tests/civil-superyachts.test.ts`);
the marina scenery keeps its small yachts out of it (`inSuperyachtBerth`). `src/missions/runtime/superyachts.ts` spawns
them per Auckland sortie with the civil traffic, and Serene under way on `YACHT_LANE` (a harbour loop toward North Head
at 10 kn; always in the stroll, half the combat sorties), whose wake the shared `WakeBatch` draws. Neutral and boxed CIV,
a yacht is named on the designated box, the TSD and the PCD (`trackLabel`: "KORU"); one bomb or missile or a held gun
pass sinks her, a civilian loss ("CIVILIAN YACHT DESTROYED", −500, −0.15 rating, a debrief row naming her,
`MissionResultExt.civilianYachts`), never a kill or a failed sortie.

## Harbour ferries and wakes (render-only)

The harbour ferries are not sim entities: no radar, no targeting, no sim cost. `src/render/traffic/ferryRoutes.ts`
holds six timetable routes out of the Downtown Ferry Terminal (five bow-in slots in the basins either side of Queens
Wharf) to the real OSM wharves (Devonport, Bayswater, Stanley Bay, Northcote Point and Birkenhead, Hobsonville Point,
West Harbour), never towards the enemy-held islands. A ferry's pose is a pure function of mission time: dwell, back
out, turn on the spot, sail a smoothed path, brake in along the next dock's axis. Every route period divides
`FERRY_CYCLE`, so the fleet repeats exactly and `tests/render-ferries.test.ts` can prove every hull position is on the
LINZ water clear of wharves, bridge piers and moored ships, and that no two ferries ever overlap. When you move a route
or a dock, rerun that test; if two ferries clash, change the route `offset`s (only routes with the same headway may
share a Downtown slot). `HarbourFerries` draws the fleet as one `InstancedMesh` (`QualitySettings.ferries` takes the
first N of `FERRY_FLEET`; at night a second, unlit `InstancedMesh` on the same instances lights the cabin windows),
and the `WakeBatch` (`src/render/effects/Wakes.ts`) draws the V-shaped foam wakes of every
moving ship and ferry in one draw call (`QualitySettings.wakes`, off on `low`). Both are owned by the EntityRenderer.

## Trains (#146: timetable, civil but targetable)

Auckland Transport's AM class sets (3 and 6 cars) run the three post-CRL lines (East-West, South-City, Onehunga-West)
and two KiwiRail container trains run between the Ports of Auckland's rail siding and the POAL sidings at Wiri. The
network is baked by `tools/gtfs/trains.ts` into `src/sim/civil/railData.ts` (13 kB, base64 in the bundle so the sim
and the tests have it synchronously): each line's two GTFS shapes (cleaned of their 1–3 m jogs, so cars don't bunch),
its stations (each on the track within 10 m of its GTFS stop) with one representative weekday trip's stop times, and
tunnel runs from OpenStreetMap (the CRL, Britomart, Parnell) and the LINZ ribbons (New Lynn, Purewa). The freight path
is the OSM sidings joined to the GTFS main lines. `src/sim/civil/rail.ts` is the timetable, a pure function of mission
time like `ferryAt`: every train is a unit circulating its line (out, a layover, back, a layover), the units a
headway apart, so each direction departs every headway; a run between stations is a trapezoid (0.9 m/s², ≤ 110 km/h)
fitted to the GTFS time less a 30 s dwell. Headways come from the GTFS by `servicePeriod(timeOfDay)`: dawn and dusk run
the peak, day off-peak, night the evening service. `TrainService` (one per sortie, seeded) holds the units and the
wrecks; the mission's `TrainTraffic` (`src/missions/runtime/trains.ts`) hangs it on `world.trains`.

Trains are **sim entities only near the player**: every 0.5 s the nearest 12 within 15 km (released past 17 km, kept
while designated or with a weapon in flight at them, never wholly underground) become neutral `'train'` ground
entities (`known = false`, `scenery` so the entity renderer adds no model), posed every step from the timetable. That is
the airliners' and merchant ships' path, so the consequences are the same with no new code in sensors, HUD or
targeting: EOTS / radar ground-map contacts boxed CIV, designatable, AI and SAMs ignore them, a civilian loss in
`callouts.ts` ("CIVILIAN TRAIN HIT", −500, −0.15 rating, a debrief row; never a mission failure). A render-only
train with a separate hit test would have needed its own designation, TGT and kill path; 20–50 entities all the time
would have cost every sensor scan. Hit tests run along the cars (`trainHullDistance` in `src/sim/civil/vessels.ts`; a
car in a tunnel can't be hit), one bomb or missile destroys a train, the gun a few rounds. A destroyed train stops,
burns (the ground kill fire), stays a charred wreck (`TrainService.wrecks`) and its unit leaves the timetable.

`src/render/traffic/Trains.ts` draws the nearest `QualitySettings.trains` (4 / 8 / 14) within 6 / 9 / 13 km of the
camera, plus the player's designated one, as four `InstancedMesh`es (AM end car, AM middle car, DL, container wagon:
four draw calls day and night; windows and the destination display glow at night through a per-vertex term in the
shared material; headlights and tail lights in the entity renderer's sprite batch). A car in a tunnel isn't drawn.
`__f35.trains(x, z, { ahead })` lists the trains or finds when one passes a spot; `e2e/train-shots.mjs` shoots them.

## IRGC Navy fast boats (moving threats)

`src/sim/boats.ts` sails the IRGC campaign's boats after the ground movers each step. A **suicide boat**
(`'suicide_boat'` ground target) chases a ship (`BoatState.chaseId`, weaving about the intercept course)
and its contact with the hull is one hit on her (`applyDamage(…, 'collision')` from a ground entity).
A **missile boat** (`'missile_boat'`, `BoatState.strike`) closes to its launch range with a clear line
of sight over the water, lies stopped and counts down, then fires a **Kowsar** (one by default): a plain `MissileEntity` flown by `boats.ts`, never by the
CombatSystem, that always reaches its ship and scores one hit, and like every missile is never a
sensor contact, so the only defence is killing the boat first. The countdown is announced (DARKSTAR
call with the bearing, HUD "MISSILE BOAT LAUNCH n", a launch ring on the TSD and tac map). The
**air-defence boat** is a SAM type (`'ad_boat'`) whose `SamSiteEntity.boat` makes it move: `SamSystem`
runs it like any site (the SA-15's missile and envelope, plus SA-18s through `SamTypeData.manpads`),
`boats.ts` only moves it and keeps its velocity, which the GBU-53/B and the AGM-88G use. Its close-in
cue (`SamTypeData.closeCue`, #115: an electro-optical tracker) detects any jet inside 9 km whatever its
shaping, and inside 12 km while its weapon bay is open (× `samRangeScale`), so a stand-off release is
safe and a closer pass is not. Boats only
ever move onto water (`TerrainQuery.isWater`), steering round land. Missions point them at a group
(`GroundTargetDef.chase` / `.strike`, `SamSiteDef.escort`): `boats.ts` takes the group's first live
member, and looks it up again each step the boat has no live target, so spawn order doesn't matter.
The IRGC campaign's g02 "Straight Outta Hauraki" (`src/missions/content/irgcHauraki.ts`, appended to the campaign at the
end of `irgc.ts`) puts all three round the two-hit tanker leaving the Rangitoto Channel: suicide boats on a 2-minute
clock, missile boats in launch range 3–4 minutes in, AD boats escorting each wave (a bonus objective, not the job).
The missile boats and their escort spawn at `G02_MISSILE_WAVE_AT` (60 s, #115), so one opening ripple can't cover both
waves; the tanker's protect objective completes only once no Kowsar is still in the air.
The player starts at 10,000 ft with no boat in StormBreaker reach; Recruit flies a suicide boat fewer; on Veteran seven boats
must be sunk with eight bombs, so the gun is part of the plan. The briefing map marks a neutral ground group (the tanker)
friendly, by name (`autoIntel`), and drops a waypoint's label next to a marker of the same name (`routeLabel`).

## The stoat (g03, #200) and the rats (t07)

g03's target is a `'stoat'` ground target (one hit point, 0.2 m radius) run by `src/sim/runner.ts`: it runs a route along
the Onetangi dunes in dashes, stops at three bait stations (the drop windows) and reaching its last point is reaching
the nest (a mission `area` trigger on its group ends the sortie). Its clock starts at mission start
(`RunnerSpawn.clockStart`), so when the mission spawns it late (under the cloud, near the nest) it catches up with where
it would be. Designated, locked or with a weapon in flight at it, it rears up into the "periscope" stance at its next
stop (`RunnerState.alert`, posed by `src/render/visuals/stoatPose.ts` on the posable model in
`src/render/models/stoat.ts`); a weapon that goes off within 30 m and misses makes it bolt to the next station. A
ground target under 0.5 m (`src/sim/weapons/small.ts`) is too small for a GBU-53/B to track on the move: the seeker and
the datalink only update its estimate while it stands still, and never lead it (`smallTargetGuidance`), so a release
at a stop hits and one while it runs lands where it was. A killed stoat leaves no model, only a crater
(`src/render/effects/Craters.ts`). The volunteers' radio channel (`G03_VOLUNTEERS`, fictional like every local name in
the mission) calls the bait stations and the moment the stoat stands up (the `runner_alert` condition). The debrief
prices the sortie against one volunteer's trap (`MissionScript.costSummary`, unit costs and their sources in
`src/missions/runtime/costs.ts`).

T07's sewer rats (`'rat'`, `src/missions/content/trainingSmallTargets.ts`) run on the same runner: down a Herne Bay
street with a stop at each drain, then swimming (`RunnerState.swimming`: a steady speed, no stops, so a StormBreaker
can't track them) for Watchman Island. The lesson is g03's release on two of them: a StormBreaker while the rat stops.

Every munition that goes off on land digs a crater sized by its warhead (`craterRadius` in
`src/render/effects/Effects.ts`), and a bomb going off in the water throws up a splash column, hit or miss.

## Targeting pod view (#199)

The target camera window (`src/render/TargetCam.ts`, laid out by `src/hud/hmd/pip.ts`) shows aircraft and ships in
its cinematic shots near the target, but a ground target or SAM site through the targeting pod (`src/core/pod.ts`):
the camera sits on the line of sight from the player's jet, 200 m up it from the target or at the jet when that is
closer (`podCamPose` and `POD_STANDOFF` in `src/render/targetCam/pose.ts`), looking down it as the pod does, with the
lens narrowed to one of three zoom steps (WIDE 150 m, NARROW 30 m, ZOOM 1 m top to bottom; a tap on the window cycles
them), so g03's 0.38 m stoat spans a third of the window at ZOOM. With no line of sight (terrain, or the overcast
deck between the jet and the target: `cloudBetween()` in `src/sim/sensors/los.ts`) nothing is rendered and the window
reads MASKED. Small ground targets are framed size-aware in the orbit shot too (`groundMinFraming`).

## Waiheke air defences: several ways in (g03)

The IRGC campaign's g03 "Stoat of Emergency" (`src/missions/content/irgcWaiheke.ts`, epic #196) sends the jet from
west Auckland through a layered air-defence network to one small target on the Onetangi dunes, on a 5:20 clock
(`timeLimit`) with 2 AARGM-ER and 2 GBU-53/B (`sead_precision`). The layout gives a casual player several ways in, none
of them free (playtest 2026-10-10, r1): an SA-6 on Motuihe on the straight line, a ZSU-23-4 on the ridge over the nest
(every route ends in a fight), and three patrolling AD boats over the water north of Rakino, off Onetangi and in the
Tāmaki Strait (`SamSiteDef.path` + `loop`; `noHarass`, so no long shots at the drop the reveal radius already forces
close in). Veteran adds an SA-6 on Rakino over the way round the north (`minDifficulty`), 14 km from the nest, so the
north meets three radars there and the strait and the straight line leave an AARGM to spare (playtest r2: with a
Veteran Tor over the Motuihe SA-6 and the SA-6 at the airstrip over the nest, every way needed three AARGMs). The island radars carry a close-in cue of their own (`SamSiteDef.closeCue` →
`SamSiteEntity.closeCue`, which overrides the type's `SamTypeData.closeCue`): it holds a jet beaming them low in the
notch, where the radar alone would lose it. The weather is overcast; the deck height is `OVERCAST_DECK` in
`src/core/weather.ts` (shared with `world/clouds/Clouds.ts`), and the target spawns only once the player has been under
it within 6 km of the nest (an `area` spawn condition with `below`), so neither a high transit nor a stand-off release
finds it. The stoat's three 60 s stops start at about 1:28, 2:43 and 3:58, so a jet that finds it at 3:00 still has two
drop windows. `tests/missions-g03.test.ts` checks the rings each route crosses on the real LINZ coast and the stops, and
the bot's route probes (`tools/playtest/bot-sweep.ts --route=<name>`, `ROUTE_PROBES` in `tests/missions-probes.ts`)
measure the ways in flight (`tests/missions-balance.test.ts`): low down the Tāmaki Strait (`golden`, `south`), round
the north with an AARGM for each boat (`golden_north`) and straight across behind an AARGM at the Motuihe SA-6 (`sead`)
each win on Pilot, while over the top of every SAM (`high`) or killing every site first (`killall`) loses. Under an
overcast deck the bot attacks from below the cloud and plans short run-ins (`MissionBot.deck`). No IRGC mission is the
campaign's finale while the campaign is being built (no `campaignFinale`).

## Frame / sim order (Game.ts)

```
input.update → player.input = controls
fixed 60 Hz: world.step(dt) { AI brains (20 Hz) → flight model (sub-steps) → combat.update → movers
                              → fast boats → collisions (+ landmark collapses) → warnings → cleanup }  →  missionRunner.update
render: env.update → entities.update → cameraRig.update → effects.update → cockpit.update
        renderer.render(scene, camera) → cockpit.render (2nd pass, depth cleared) → hud.update (2D canvas) → audio.update
        (cockpit.update opens the DAS window, src/hud/cockpit/das.ts, which hud.update reads in the same frame)
```

Events (`src/core/events.ts`) decouple the sim from its presentation: audio, effects, HUD and haptics all
react to `munition:launch`, `explosion`, `destroyed`, `radio`, `warning` and so on.

## Testing

* `npx tsc --noEmit` must be clean.
* `npx vitest run` covers unit tests (flight model trim and limits, missile guidance, radar and RCS, mission logic).
* `node e2e/missions.mjs --base=http://localhost:5173/` loads every campaign and training mission in headless Chromium and reports errors, entity counts and draw calls.
* Developer labs live in `labs/` (`/labs/models-lab.html`, `fx-lab`, `hud-lab`, `audio-lab`, `ui-lab`, `world-lab`, `sandbox`).
* `node e2e/shot.mjs --url='http://localhost:5173/?mission=g01&autostart=1&view=chase' --wait=6000 --out=e2e/screenshots/x.png`
  takes a mobile-landscape (844×390 @2x) screenshot with headless Chromium (SwiftShader, so it's slow) and prints
  console errors plus `window.__f35.state()`. The dev server runs with `npx vite --port 5173`.
* `node e2e/harbour-shots.mjs [--quality=medium] [--tag=x]` pins the camera over the Waitematā (mostly 1 km up) in an
  Auckland sortie and screenshots the ferries and wakes, printing draw calls and triangles per view.
