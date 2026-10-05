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
> * **Campaign fiction:** the IRGC campaign (epic #72, `src/missions/content/irgc.ts` and `irgcHauraki.ts`, mission ids
>   `g01`, `g02`, …): Shahed one-way attack drones over the city and IRGC Navy fast boats in the Hauraki Gulf. F-35As fly
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

## Aerial photo (LINZ, CBD and waterfront)

`src/world/terrain/theaters/aucklandAerial.ts` loads the LINZ 2024 aerial photo of a 5.12 km square over the CBD,
the waterfront and Devonport (`AERIAL_RECT`; baked by `tools/linz/aerial.py`): 2048² on the medium tier, 4096² on
high, never on low (`worldConfig().aerial`, the *Aerial photo* setting, `?aerial=0`). Its alpha marks land and the
OSM wharf decks. The terrain shader replaces its procedural ground colour with it (fading out at the square's edge),
the wharf decks and the naval base take it on their top faces, and the house / tree scatter and the procedural
suburb centres keep off it (`aerialCovers`). Gameplay never reads it. Without it (download failed, low tier) the
procedural ground stays. Its colours are graded toward the procedural suburbs it fades into (`aerialGrade`: the
photo's land average measured at load, scaled onto the suburbs' far albedo), fully at dawn, dusk and night, a trace by
day. That matches the average albedo; two lighting terms do the rest. Under a low sun (dawn, dusk) the photo also
takes the light of a 28° roof facing the sun on 80 % of its area (`aerialLowSun`, `AERIAL_LIGHT_GLSL`, on the terrain
and the photo-topped buildings), as the procedural 3D houses round it catch the sun on their sun-facing slopes and
walls; nothing by day or under the moon. It applies only as far as those houses are drawn: it follows their scatter's
thinning with slant range (`aerialHouseShare`, the same curve as `scatterKeep` in `scatter.ts`, with the tier's
`houseRadius` as the `uAerialHouseR` uniform) and is gone beyond their radius, where both sides are lit as flat ground.
At night the procedural ground still runs under the photo for its lamps and lit windows, and the photo gives half its
colour to that ground (`AERIAL_NIGHT_MIX`; the photo-topped decks and roofs give it to their own colour), so the lamps
sit on the warmer procedural colour instead of a cool grey square.

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
The player starts at 10,000 ft with no boat in StormBreaker reach; Recruit flies a suicide boat fewer; on Ace nine boats
must be sunk with eight bombs, so the gun is part of the plan. The briefing map marks a neutral ground group (the tanker)
friendly, by name (`autoIntel`), and drops a waypoint's label next to a marker of the same name (`routeLabel`).

## The stoat (g03, #200)

g03's target is a `'stoat'` ground target (`src/sim/stoat.ts`, one hit point, 0.2 m radius): it runs a route along
the Onetangi dunes in dashes, stops at three bait stations (the drop windows) and reaching its last point is reaching
the nest (a mission `area` trigger on its group ends the sortie). Its clock starts at mission start
(`StoatSpawn.clockStart`), so when the mission spawns it late (under the cloud, near the nest) it catches up with where
it would be. Designated, locked or with a weapon in flight at it, it rears up into the "periscope" stance at its next
stop (`StoatState.alert`, posed by `src/render/visuals/stoatPose.ts` on the posable model in
`src/render/models/stoat.ts`); a weapon that goes off within 30 m and misses makes it bolt to the next station. A
ground target under 0.5 m (`src/sim/weapons/small.ts`) is too small for a GBU-53/B to track on the move: the seeker and
the datalink only update its estimate while it stands still, and never lead it (`smallTargetGuidance`), so a release
at a stop hits and one while it runs lands where it was. A killed stoat leaves no model (the crater is #201).

## Targeting pod view (#199)

The target camera window (`src/render/TargetCam.ts`, laid out by `src/hud/hmd/pip.ts`) shows aircraft and ships in
its cinematic shots near the target, but a ground target or SAM site through the targeting pod (`src/core/pod.ts`):
the camera sits on the line of sight from the player's jet (`podCamPose` in `src/render/targetCam/pose.ts`) and frames
one of three zoom steps (WIDE 150 m, NARROW 30 m, ZOOM 2 m top to bottom; a tap on the window cycles them), so a
target a few tenths of a metre long is still a dozen pixels tall. With no line of sight (terrain, or the overcast
deck between the jet and the target: `cloudBetween()` in `src/sim/sensors/los.ts`) nothing is rendered and the window
reads MASKED. Small ground targets are framed size-aware in the orbit shot too (`groundMinFraming`).

## Waiheke air defences: no free route (g03)

The IRGC campaign's g03 "Stoat of Emergency" (`src/missions/content/irgcWaiheke.ts`, epic #196) sends the jet from
west Auckland through a layered air-defence network to one small target on the Onetangi dunes, on a 4:00 clock
(`timeLimit`) with 2 AARGM-ER and 2 GBU-53/B (`sead_precision`). The layout is built so no single route is free: an
SA-6 and a Tor on Motuihe (the Tor's point defence covers the SA-6), an SA-6 at the Waiheke airstrip and a ZSU-23-4 on
the ridge (the nest is inside both, so every route ends in a fight), and three patrolling AD boats over the water north
and south (`SamSiteDef.path` + `loop`). The island radars carry a close-in cue of their own (`SamSiteDef.closeCue` →
`SamSiteEntity.closeCue`, which overrides the type's `SamTypeData.closeCue`): it holds a jet beaming them low in the
notch, where the radar alone would lose it. The weather is overcast; the deck height is `OVERCAST_DECK` in
`src/core/weather.ts` (shared with `world/clouds/Clouds.ts`), and the target spawns only once the player has been under
it within 6 km of the nest (an `area` spawn condition with `below`), so neither a high transit nor a stand-off release
finds it. `tests/missions-g03.test.ts` checks the rings each route crosses on the real LINZ coast, and the bot's route
probes (`tools/playtest/bot-sweep.ts --route=<name>`, `ROUTE_PROBES` in `tests/missions-probes.ts`) measure it in
flight: every naive route (straight, either detour, the wide way, above the SAMs, killing every site) loses on Pilot,
the intended path (low down the Tāmaki Strait, an AARGM at the strait's boat, a second at the airstrip SA-6 from close
in, then the attack at one of the stoat's stops) wins about half the time on Pilot (`tests/missions-balance.test.ts`). Under an overcast deck the bot
attacks from below the cloud and plans short run-ins (`MissionBot.deck`). No IRGC mission is the campaign's finale
while the campaign is being built (no `campaignFinale`).

## Frame / sim order (Game.ts)

```
input.update → player.input = controls
fixed 60 Hz: world.step(dt) { AI brains (20 Hz) → flight model (sub-steps) → combat.update → movers
                              → fast boats → collisions (+ landmark collapses) → warnings → cleanup }  →  missionRunner.update
render: env.update → entities.update → cameraRig.update → effects.update → cockpit.update
        renderer.render(scene, camera) → cockpit.render (2nd pass, depth cleared) → hud.update (2D canvas) → audio.update
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
