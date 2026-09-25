# F35-A — Architecture & Game Design

F35-A is a mobile-first combat flight simulator that runs in a phone browser (iOS Safari 15+,
Android Chrome). It is inspired by NovaLogic's *F-22 Raptor* (1997), with the F-35A Lightning II as the player jet:
mission-based campaign across several theatres, air-to-air and SAM threats, AWACS radio calls,
multiple camera views, and an arcade-leaning but believable flight model.

**Engine choice:** Unreal Engine 5 can't target mobile browsers (HTML5 export was removed in UE 4.24).
The game is built on **three.js (WebGL 2) + TypeScript + Vite + Web Audio**, packaged as a PWA.

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

## Frame / sim order (Game.ts)

```
input.update → player.input = controls
fixed 60 Hz: world.step(dt) { AI brains (20 Hz) → flight model (sub-steps) → combat.update → movers
                              → collisions → warnings → cleanup }  →  missionRunner.update
render: env.update → entities.update → cameraRig.update → effects.update → cockpit.update
        renderer.render(scene, camera) → cockpit.render (2nd pass, depth cleared) → hud.update (2D canvas) → audio.update
```

Events (`src/core/events.ts`) decouple the sim from its presentation: audio, effects, HUD and haptics all
react to `munition:launch`, `explosion`, `destroyed`, `radio`, `warning` and so on.

## Testing

* `npx tsc --noEmit` must be clean.
* `npx vitest run` covers unit tests (flight model trim and limits, missile guidance, radar and RCS, mission logic).
* `node e2e/shot.mjs --url='http://localhost:5173/?mission=c01&autostart=1&view=chase' --wait=6000 --out=e2e/screenshots/x.png`
  takes a mobile-landscape (844×390 @2x) screenshot with headless Chromium (SwiftShader, so it's slow) and prints
  console errors plus `window.__f35.state()`. The dev server runs with `npx vite --port 5173`.
