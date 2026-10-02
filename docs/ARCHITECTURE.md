# F35-A — Architecture & Game Design

F35-A is a mobile-first combat flight simulator that runs in a phone browser (iOS Safari 15+,
Android Chrome). It is inspired by NovaLogic's *F-22 Raptor* (1997), with the F-35A Lightning II as the player jet:
mission-based campaign across several theatres, air-to-air and SAM threats, AWACS radio calls,
multiple camera views, and an arcade-leaning but believable flight model.

**Engine choice:** Unreal Engine 5 can't target mobile browsers (HTML5 export was removed in UE 4.24).
The game is built on **three.js (WebGL 2) + TypeScript + Vite + Web Audio**, packaged as a PWA.

> ## ⚠️ ORCHESTRATOR UPDATE — SETTING IS AUCKLAND, NEW ZEALAND (supersedes older task text)
>
> The user has asked for the game's scenery to be **Auckland CBD, New Zealand**. A new `TheaterId` **`'auckland'`**
> exists (see `src/core/types.ts`) and is the **primary theatre**:
>
> * **All campaign and training missions use `theater: 'auckland'`** (vary time of day and weather for variety).
>   This replaces the desert → islands → mountains → arctic campaign. The other theatres stay available **only as
>   optional Instant Action choices**, and Instant Action defaults to Auckland.
> * Geography reference with world coordinates is in **`src/core/auckland.ts`**. The Sky Tower is the origin; use
>   `AKL.<id>` for landmark positions, for example `AKL.rangitoto`, `AKL.whenuapai`, `AKL.port`, `AKL.bridge_s`, `AKL.waiheke`.
>   The CBD sits on the south shore of the Waitematā Harbour, the Hauraki Gulf and its islands lie to the east/north-east,
>   the Manukau Harbour and the airport to the south-west/south, and the Waitākere Ranges (≤474 m) plus the Tasman coast to the west.
> * **Campaign fiction, "Operation Southern Cross":** a fictional hostile expeditionary force has seized the Hauraki
>   Gulf islands (Rangitoto, Motutapu, Waiheke, Motuihe) and set up SAM belts (SA-10 on Motutapu, SA-6/SA-8/SA-15/ZSU on
>   Rangitoto and Waiheke), with warships in the Gulf, fighter CAPs over the Gulf and bomber raids aimed at the city.
>   F-35As fly from **RNZAF Base Auckland (Whenuapai)** to defend Auckland. Enemy targets are always **military**
>   (SAM sites, radars, ships, landing craft, an enemy-held airstrip on Waiheke, fuel depots, a command bunker on Motutapu).
>   Never target civilian landmarks. The CBD, Sky Tower and Harbour Bridge are things you **protect** (for example,
>   intercept cruise-missile carriers and bombers before they reach the CBD).
> * Mission hooks: a CAP over the Waitematā, an intercept of Tu-22M3 raids from the north-east, SEAD on Rangitoto, a ship
>   strike in the Tāmaki Strait, an AWACS hunt beyond Tiritiri Matangi, a low-level strike under the Motutapu SA-10
>   (terrain masking behind Rangitoto), an escort of a friendly strike package to Waiheke, a night defence of the CBD, and
>   a Su-57 finale over the Gulf. Optional bonus: flying under the Harbour Bridge (43 m clearance) earns a score bonus and
>   a HUD message.
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
| SA-10 / SA-6 / SA-15 / SA-8 / SA-18 / ZSU-23-4 | 45 / 20 / 12 / 10 / 5 / 2.5 km |
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
| Missions, campaign, scoring | MISSIONS | `src/missions/**`, `tests/missions-*.test.ts` | `CAMPAIGN`, `TRAINING`, `buildInstantMission`, `createMissionRunner`, progress fns, `terrainPadsFor` |

## Protected landmarks (the Sky Tower)

The Sky Tower is a sim **landmark** (`src/sim/landmarks.ts`, `SimWorld.landmarks`), not an entity: it is never in
`aircraft` / `sams` / `ground`, so sensors, TGT cycling, AI, objectives and scoring never see it. Its shape (OpenStreetMap
building parts) and its scripted collapse are pure data and functions in `src/core/skyTower.ts`, shared by the sim (hit
volume, collisions, collapse explosions) and the renderer (`src/world/scenery/skyTower.ts`, posed from sim time). One hit
from the player's bomb, AGM or AAM destroys it (`landmark:destroyed`), and the mission runner fails the sortie
(`src/missions/runtime/landmarks.ts`). The ruin persists through `skyTowerRuin()` in `src/missions/progress.ts`, the one
place that decides how long it stays down.

## Real airfields (OpenStreetMap)

Whenuapai, Auckland Airport, Ardmore and North Shore (Dairy Flat) come in two layers. **`src/core/airfields.ts`** holds
their runway thresholds (from OSM), synchronous and always present. Gameplay reads only this table: the home base
`FEATURES.whenuapai`, the `AKL` landmarks at the runway centres, the rearm point, and the civil traffic on 05R/23L.
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
first N of `FERRY_FLEET`), and the `WakeBatch` (`src/render/effects/Wakes.ts`) draws the V-shaped foam wakes of every
moving ship and ferry in one draw call (`QualitySettings.wakes`, off on `low`). Both are owned by the EntityRenderer.

## Frame / sim order (Game.ts)

```
input.update → player.input = controls
fixed 60 Hz: world.step(dt) { AI brains (20 Hz) → flight model (sub-steps) → combat.update → movers
                              → collisions (+ landmark collapses) → warnings → cleanup }  →  missionRunner.update
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
* `node e2e/shot.mjs --url='http://localhost:5173/?mission=c01&autostart=1&view=chase' --wait=6000 --out=e2e/screenshots/x.png`
  takes a mobile-landscape (844×390 @2x) screenshot with headless Chromium (SwiftShader, so it's slow) and prints
  console errors plus `window.__f35.state()`. The dev server runs with `npx vite --port 5173`.
* `node e2e/harbour-shots.mjs [--quality=medium] [--tag=x]` pins the camera over the Waitematā (mostly 1 km up) in an
  Auckland sortie and screenshots the ferries and wakes, printing draw calls and triangles per view.
