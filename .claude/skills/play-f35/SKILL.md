---
name: play-f35
description: How an agent plays, inspects and reproduces things in the F35-A game fast. A routing table from "I want to…" to the cheapest tool (headless bot sweep, browser driver with fast-forward, window.__f35 test hooks, unit tests, labs), what each costs, and lessons from earlier playtests. Use before playtesting, reproducing a gameplay bug, checking a mission or UI change in the running game, or whenever you're about to write your own Playwright script for this game.
---

# Playing F35-A as an agent

This skill is the orientation an agent would otherwise rediscover at the start of every session. Read it before touching the game, then go straight to the row of the routing table you need.

## What belongs in this file, and what doesn't

**In here (stable):** how to reach a mission, scene or screen; which tool answers which question; what each tool costs; gotchas that keep biting; durable lessons ("X can't be judged in the headless browser").

**Not in here (changes with the code; look it up every time):**

| You want | Read it from |
|---|---|
| Mission list, objectives, enemies, loadouts | `src/missions/content/*.ts`, `missionById()` in `src/missions/index.ts` |
| Current win rates, open balance problems, last playtest's findings | `docs/playtests/` (latest run file), open GitHub issues |
| What changed since the last playtest | `git log <sha>..HEAD` with the SHA from `docs/playtests/README.md` |
| Difficulty numbers, weapon data | `src/core/data.ts`, `src/sim/**/…Data.ts` |
| Controls | `README.md` → Controls, `src/input/` |
| Architecture and module ownership | `docs/ARCHITECTURE.md` |

When you learn something durable during a session, add it to **Learned** at the bottom (dated, one line each). If a fact here turns out wrong, fix it, don't append a contradiction.

## Routing table

| I want to… | Use | Cost on a 4-core cloud container (measured 2026-10-02; *est.* = not measured) |
|---|---|---|
| Know if a mission is winnable / too easy / harder after a change | `npx vite-node tools/playtest/bot-sweep.ts -- --missions=c04,c09 --diffs=recruit,pilot --seeds=3` | ~3–5 s per run, parallel over cores (12 runs in ~17 s) |
| See why a bot run lost, or the pacing (event log, loss cause, dead stretches) | same, plus `--log --json=<file>` (fills `events`); `--nojitter` for a clean repro | same |
| Balance of one loadout (e.g. the StormBreaker) | same, plus `--loadout=strike_sdb2` (missions that don't allow it show `skip`) | same |
| Sweep the whole campaign | same, `--missions=campaign --diffs=recruit,pilot,veteran,ace --json=<file>` | 144 runs ≈ 2–3 min |
| See a mission at minute 3 without flying there | `node tools/playtest/browser-run.mjs --mission=c09 --at=0,60,180` (needs the dev server, below) | load ~7 s + ~1 s per 3 min of game time + ~4.5 s per screenshot |
| Smoke or draw-call baseline over many missions | `browser-run.mjs --missions=c01,c02,… --at=0,120 --shots=0` (one page, `fly()` per mission) | ~23 s per mission, ~2× faster than a page load each |
| Play level 13 without unlocking 1–12 | `?mission=<id>&autostart=1` (dev server / test build only). Ids: `c01`–`c12`, `t01`–`t03`, `ia_<mode>_auckland` (Auckland is the only theatre) | free |
| Read the game state (objectives, player, counts, draw calls) | `window.__f35.state()` in `page.evaluate` | free |
| Fly with scripted inputs (stall, high-g, low level) | `window.__f35.controls({pitch:1, throttle:1})`, `null` to clear; `autopilot(false)` first | free |
| Let the AI fly the jet | `window.__f35.autopilot(true, role)` (role: `fighter`, `wingman`, `interceptor`) | free |
| Skip ahead N seconds of game time | `window.__f35.simulate(N)` (fixed 60 Hz steps, no rendering; stops when the mission ends) | ~0.4 s per game minute |
| Start another mission in the same page | `window.__f35.fly('c05', loadout?)`: works from any screen, menu or mission; quitting it returns to the main menu, and a `pause()` right after it opens once the mission is ready | *est.* a few s |
| Change camera | `window.__f35.setView('cockpit')` (also `hud`, `chase`, `orbit`, …) or `&view=` | free |
| Check the Sky Tower collapse | `window.__f35.destroySkyTower(y)` (the player's bomb at height `y`) | free (nothing is saved: the next start or restart has the tower standing) |
| Damage the Sky Tower as an enemy would | `window.__f35.hitSkyTower(y)` (an enemy hit at height `y`, default 150 m: the first damages it, the second collapses it; returns the hit count). `state().skyTowerHits` reads it | free |
| Keep the player alive through a scripted run | `window.__f35.invulnerable(true)` (weapons only; crashing still kills; per mission) | free |
| Force an event (a tank lost, a group dead, an objective done) | `window.__f35.destroy(entityId)` or `destroy('groupId', byPlayer?)` (credited as an AIM-120 kill, so debrief stats after it are skewed) | free |
| Reach the debrief after `simulate()` ended the mission | `window.__f35.skipOutro()` (the outro counts render frames, so headless it takes ~60 s otherwise) | free |
| Look at a place without writing a driver | `window.__f35.camera([x,y,z], [lookX,lookY,lookZ])`, `camera(null)` to hand back; `__f35.game.hud.setVisible(false)` for a clean frame. Prefer this to the world lab, whose shots took 45–60 s each under load | free |
| Prove a HUD string is drawn (blinking cues, text that screenshots miss) | `browser-run.mjs … --text` (adds `hudText`: every `fillText` string over 8 frames; the HUD upper-cases and wraps, so match case-insensitively on `hudText.join(' ')`) | free |
| Smoke-test that every mission starts | `node e2e/missions.mjs --base=http://localhost:5190/ --only=c01,c02` | *est.* ~20 s per mission (load + `--seconds`, default 12) |
| Check menus, briefing, touch controls | `node e2e/ui-touch.mjs --base=http://localhost:5190/ --part=menus` (or `flight`) | *est.* 1–2 min |
| One screenshot of any URL | `node e2e/shot.mjs --url='http://localhost:5190/?mission=c01&autostart=1' --out=e2e/screenshots/x.png` | ~17 s |
| Look at a model, effect, HUD page, sound or world tile alone | `labs/*.html` on the dev server (`/labs/hud-lab.html` etc.) | *est.* 5–10 s |
| Prove a balance or logic fix stays fixed | a vitest test using `runPlaythrough()` from `tests/missions-bot.ts` (see `tests/missions-balance.test.ts`) | runs in CI |
| The full regression suite | `npx tsc --noEmit && npx vitest run && npx vite build` | ~85 s + ~60 s |

The other `e2e/*.mjs` scripts (harbour, airfields, sites, ships, target camera, terrain) are targeted screenshot sets; read their header comment for flags.

## Setup

```bash
npm ci                                                   # if node_modules is missing
npx vite --config vite.e2e.config.ts --port 5190 &       # stable dev server for playtests
```

- `vite.e2e.config.ts` turns off HMR and file watching so pages don't reload while code is edited. **After editing code, restart this server** or you'll be testing the old build.
- Parallel agents: give each its own port (5190, 5191, …) or share one server. Several pages on one server are fine; the CPU is the limit, not the server.
- Test hooks (`?mission`/`?autostart`, `window.__f35`) exist **only** on the dev server and in `npm run build:test` builds (`VITE_TEST_HOOKS=1`). The deployed game and `npm run build` have none. `TEST_HOOKS` in `src/core/data.ts` is the switch. To test the service worker or PWA you need the production build: `npm run build:test && npx vite preview --port 4173`.

## Gotchas

- **The headless browser's clock runs at a few % of real time** (SwiftShader renders on the CPU). Waiting 8 s of wall time advanced the game 0.7 s. Never wait in real time to reach a moment: `simulate()` to it, then screenshot.
- **Frame rate, feel and audio can't be judged here.** Report draw calls and triangles (`state().renderer`) and say real-device frame time is unverified. "Feel" findings from the browser need a human or the bot's numbers, not an agent's impression of a slideshow.
- **Scripts outside the repo can't import `playwright-core`** (module resolution starts from the script's folder). Put throwaway drivers under `e2e/` or `tools/playtest/`, or better, extend `browser-run.mjs`.
- **A fresh Playwright context has an empty save.** The menus show only `c01` and training unlocked. Use `?mission=` to jump; don't click through the campaign.
- The bot (`tests/missions-bot.ts`) is a *competent* player using what a human sees. A bot loss means a real wall; a bot win doesn't prove a new player can win. Recruit win rate by the bot is the floor, not the experience.
- Screenshots go in `e2e/screenshots/` (git-ignored). Never commit them.
- **`simulate()` doesn't advance the HUD clock.** Hint paging, objective fades and message timers stay frozen, so whether a HUD element is visible *over time* can't be judged from headless shots.
- **`autopilot(true)` picks its own weapon (AIM-120).** For air-to-ground cues, use `autopilot(false)`, scripted `controls()`, and `w=__f35.game.session.world; w.combat.selectWeapon(w.player,'gbu53',w)`.
- **Draw calls are noisy.** Reads vary ±10–20 % frame to frame and up to 3× between runs (the target-camera PiP adds 20–55 calls while it's open, and browser runs aren't seeded). Compare several missions or reruns, not one read.
- **`state().renderer` is the last rendered frame.** Right after a start, a `fly()` or a `simulate()` it can be stale or half-loaded. Wait two `requestAnimationFrame`s (browser-run does) or take the screenshot first.
- **Under load, everything is 2–3× slower.** With a sweep and two browsers on 4 cores, screenshots took 8–14 s and `simulate()` ~5 s per game minute. Budget charters for the box as it will be, not idle.
- **Don't `pgrep -f`/`pkill -f` on a pattern that's in your own command line.** The wait loop matches itself, and the kill takes out the next job.
- **The bot plays with jitter** (player ±600 m, enemies ±2.5 km), so seeds differ like players do. `--nojitter` gives the designed geometry. Instant Action ids (`ia_<mode>_auckland`) are seeded from the id, so they reproduce; the menu still rolls a fresh mission each flight.

## Learned

<!-- Dated one-liners appended by /playtest's efficiency retro. Keep only durable lessons; delete ones the code has made untrue. -->
- 2026-10-02: Browser: page load ~7 s, `simulate(180)` ~1.1 s, one screenshot ~4.5 s. Screenshots dominate a browser session; take them only at the checkpoints the charter needs.
- 2026-10-02: The headless bot sweep is ~50× cheaper per mission than the browser. Answer balance and winnability questions with it first and use the browser only for what has to be seen.
- 2026-10-02: Exploit and "what if the player does X" probes are fastest headless. Build the mission with `createMissionRunner` + `createSimWorld` (as `realRun` in `tests/missions-defend.test.ts` does) and pin the player each step: 9 parked Defend runs took about a minute, against about a minute per run in the browser.
- 2026-10-02: Scripts that pin the jet's position or velocity trip the flight model's overstress damage, which looks like a crash. `invulnerable()` covers weapons only, so filter overstress out or move the jet gently.
- 2026-10-02: One page with `fly()` per mission smoked 24 missions in 559 s under load. A page load per mission took about 21 min.
- 2026-10-02: The game reads taps (and polls input) once per rendered frame, and a SwiftShader frame takes 0.3–1 s. After a CDP tap wait for two `requestAnimationFrame`s (`settle()` in `e2e/ui-touch.mjs`) before reading the result, never a fixed 100 ms (#71).
- 2026-10-02: Under SwiftShader a quick CDP tap on a long-press button (CAM) can fire its long press: the 480 ms timer is wall-clock and the touchEnd ack waits for a frame. Send such a tap as `pointerdown` + `pointerup` from one `page.evaluate` (ui-touch does for CAM), and set the view with `setView()` when a check needs a given view.
