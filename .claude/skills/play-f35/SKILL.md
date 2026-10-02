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
| Sweep the whole campaign | same, `--missions=campaign --diffs=recruit,pilot,veteran,ace --json=<file>` | 144 runs ≈ 2–3 min |
| See a mission at minute 3 without flying there | `node tools/playtest/browser-run.mjs --mission=c09 --at=0,60,180` (needs the dev server, below) | load ~7 s + ~1 s per 3 min of game time + ~4.5 s per screenshot |
| Play level 13 without unlocking 1–12 | `?mission=<id>&autostart=1` (dev server / test build only). Ids: `c01`–`c12`, `t01`–`t03`, `ia_<mode>_<theater>` | free |
| Read the game state (objectives, player, counts, draw calls) | `window.__f35.state()` in `page.evaluate` | free |
| Fly with scripted inputs (stall, high-g, low level) | `window.__f35.controls({pitch:1, throttle:1})`, `null` to clear; `autopilot(false)` first | free |
| Let the AI fly the jet | `window.__f35.autopilot(true, role)` (role: `fighter`, `wingman`, `interceptor`) | free |
| Skip ahead N seconds of game time | `window.__f35.simulate(N)` (fixed 60 Hz steps, no rendering; stops when the mission ends) | ~0.4 s per game minute |
| Start another mission in the same page | `window.__f35.fly('c05', loadout?)` | *est.* a few s |
| Change camera | `window.__f35.setView('cockpit')` (also `hud`, `chase`, `orbit`, …) or `&view=` | free |
| Check the Sky Tower collapse | `window.__f35.destroySkyTower(y)` | free (writes the ruin to that browser context's save) |
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

## Learned

<!-- Dated one-liners appended by /playtest's efficiency retro. Keep only durable lessons; delete ones the code has made untrue. -->
- 2026-10-02: Browser: page load ~7 s, `simulate(180)` ~1.1 s, one screenshot ~4.5 s. Screenshots dominate a browser session; take them only at the checkpoints the charter needs.
- 2026-10-02: The headless bot sweep is ~50× cheaper per mission than the browser. Answer balance and winnability questions with it first and use the browser only for what has to be seen.
