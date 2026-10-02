# Playtest charters, risk scoring and the rubric

Reference for `/playtest` (SKILL.md). Tools and their costs are in `.claude/skills/play-f35/SKILL.md`.

Every playtest session starts from a **question** (Schell: a playtest is a prototype of an experience, built to answer specific questions). A session that can't name its question is a tour, and tours spend the budget without changing anything.

## 1. Playtest types

Pick from this menu. "Agent can judge" says how far an agent's verdict can be trusted. Where it says *proxy*, report the numbers and label them as a proxy, never as "fun" or "feel".

| Type | Question it answers | Tool (cheapest first) | Cost | Agent can judge |
|---|---|---|---|---|
| **Smoke** | Does every touched mission and screen start without errors? | `browser-run.mjs --at=0`, `e2e/missions.mjs --only=` | ~15–20 s per mission | yes |
| **Winnability** | Can a competent player win it at each difficulty? Is anything a wall? | `bot-sweep.ts` | ~4 s per run, parallel | yes |
| **Difficulty curve** | Do win rates fall from Recruit to Ace, and does the campaign get harder in order without spikes? | `bot-sweep.ts --missions=campaign --diffs=recruit,pilot,veteran,ace` | 2–3 min | yes |
| **Soft-lock / flow** | Does every objective progress, or does a mission hang? | `bot-sweep.ts`: `HUNG` rows (still running at `maxT`), `reason`, `events` in `--json` | with the sweep | yes |
| **Exploit / dominant strategy** | Is there a cheap way to win that skips the intended play (stay low, stand off, gun-only, ignore the escort)? | `browser-run.mjs --autopilot=off --controls=…` plus `simulate()`; a bot variant in a scratch test | 5–20 min | partly: it finds what it tries |
| **Regression** | Are last run's findings still fixed? | the repro line of each finding in the last `docs/playtests/` file | per finding | yes |
| **Visual / scene** | Is the changed thing there and right (Auckland landmarks, terrain, ships, effects)? | `browser-run.mjs --at=…` checkpoints, `e2e/*-shots.mjs`, labs | ~5 s per screenshot + load | yes, against a reference: the README screenshots, the last run's shots, the real place |
| **HUD / readability** | At phone size (844×390), can a player read the objective, target, threat and weapon state at the moment it matters? | `browser-run.mjs` checkpoints at lock, launch, missile warning, objective complete; `--view=cockpit` and `hud` | ~5 s per screenshot | mostly: legibility and clutter yes, comprehension *proxy* |
| **First-time experience** | Can a new player get from the splash to a first kill: menus, briefing, training `t01`, touch controls? | `e2e/ui-touch.mjs --part=menus`, read the briefing and tip texts, `browser-run.mjs --mission=t01` | 2–5 min | *proxy*: flow and wording yes, learnability no |
| **Pacing** | How long are the dead stretches before first contact, between waves and after the last objective? | `bot-sweep.ts --json`: `t`, `events` timestamps | with the sweep | *proxy* |
| **Performance budget** | Did draw calls or triangles grow? | `state().renderer` at fixed checkpoints, compared with the last run | with browser-run | draw calls yes, frame time **no** (CPU renderer) |

## 2. From the diff to risks

Start from `git diff --stat <last-sha>..HEAD` and `git log --oneline <last-sha>..HEAD`. Map each changed area to the types it can break:

| Changed path | Likely breaks | Types |
|---|---|---|
| `src/missions/content/`, `src/missions/runtime/` | one mission's winnability, objectives, soft-locks | Winnability, Soft-lock, Smoke for that mission, Pacing |
| `src/ai/`, `src/sim/` (combat, sam, flight) | balance everywhere | Difficulty curve (whole campaign), Exploit, Regression |
| `src/core/data.ts` (DIFFICULTIES, weapons) | difficulty bands | Difficulty curve |
| `src/hud/` | readability, clutter, wrong symbols | HUD/readability, Visual |
| `src/ui/`, `src/input/` | menus, onboarding, touch | First-time experience, Smoke |
| `src/world/`, `src/render/`, `public/` data | scenery, terrain, performance | Visual/scene, Performance budget, Smoke |
| `src/audio/` | can't be heard headless | Smoke only; hand the rest to a human (say so) |
| `src/game/Game.ts`, `src/main.ts` | everything starts or nothing does | Smoke on all missions |
| tests, docs, tools only | nothing the player sees | Regression of the last findings only |

Then score every candidate charter:

```
risk = likelihood × impact + gap
likelihood: 3 the diff changes it directly · 2 the diff changes something it depends on · 1 untouched
impact:     3 blocks progress or crashes (wall, soft-lock, error) · 2 wrong but playable · 1 cosmetic
gap:        +2 if this type/area wasn't tested in the last 3 runs (coverage table in docs/playtests/README.md)
            +1 if a finding there was fixed last run (regressions cluster)
```

Sort by `risk / estimated minutes` and take charters from the top until the round's review budget is spent. Name what you are **not** testing and why. That list goes into the ledger and seeds the gap score of the next run.

With no previous run (no SHA in the ledger), the first run is a **baseline**: a full-campaign Difficulty curve sweep, Smoke on all missions, and one HUD and one First-time charter. Then the risk model has something to compare against.

## 3. Charter format

One charter per reviewer subagent, and one question per charter:

```
Charter <round>.<n> — <type>: <question>
Explore: <missions / screens / systems>
With:    <tool and flags, seeds, difficulties, checkpoints>
To find: <what a failure looks like: win rate below the band, HUNG, page error, unreadable at 844×390, …>
Budget:  <minutes>
Repro of last finding (regression charters only): <command or URL>
```

## 4. Reviewer brief and output

Spawn each reviewer as a **separate subagent with fresh context**. Give it the charter, `.claude/skills/play-f35/SKILL.md`, the server port, its screenshot folder (`e2e/screenshots/playtest/r<round>-<n>/`), and last run's findings for its area. Don't give it the developer's reasoning or the current score: a reviewer who knows what the fixer intended grades the intention.

Tell it:
- Be critical. Your job is to find what's wrong, with evidence. Praise is limited to two lines.
- Every finding needs **evidence** (bot table rows, a screenshot path you looked at, a state dump, an error) and a **repro** (a command or URL anyone can rerun). A claim without evidence is not a finding.
- Report what you did **not** cover.
- Log wall-clock time per step (setup, load, simulate, screenshots, analysis, waiting) and anything that wasted time.

Output (one JSON block, then at most 10 lines of prose):

```json
{
  "charter": "2.1",
  "findings": [
    { "id": "2.1-a", "severity": "blocker|major|minor|polish", "area": "c09 balance",
      "summary": "c09 is 0/3 on Pilot: two R-77 kills before the first Flanker is in range",
      "evidence": "bot-sweep rows …; e2e/screenshots/playtest/r2-1/c09-60s.png",
      "repro": "npx vite-node tools/playtest/bot-sweep.ts -- --missions=c09 --diffs=pilot --seeds=3",
      "suggested_fix": "optional" }
  ],
  "scores": { "stability": 8, "balance": 5 },
  "not_covered": ["c09 on Veteran/Ace", "cockpit view"],
  "time_log": [ { "step": "server start", "s": 12 }, { "step": "waiting on screenshots", "s": 140 } ],
  "time_sinks": ["had to fly 4 min to reach the strike: no way to start at the IP"]
}
```

Severity: **blocker** stops progress or crashes (a wall on Recruit or Pilot, a soft-lock, a page error). **major** is wrong in a common path (a band missed, an unreadable critical cue). **minor** is wrong but rare or recoverable. **polish** is everything else.

## 5. Rubric

Score only the dimensions a charter this round covered. Copy the others from the last run marked `stale`, or leave them `—`.

| Dimension | Weight | Evidence it rests on |
|---|---|---|
| Stability | 25 % | Smoke, Soft-lock: errors, missions that don't start or hang |
| Balance | 25 % | Winnability, Difficulty curve, Exploit. Band for the competent bot (from `tests/missions-playthrough.test.ts`): Recruit ≥ 75 %, Pilot ≥ 75 %, Veteran ≥ 25 %; Ace ≥ 90 % means too easy |
| Clarity | 20 % | HUD/readability, First-time experience |
| Mission flow | 15 % | Pacing, objectives, briefing ↔ mission match |
| Presentation | 15 % | Visual/scene (Auckland, models, effects) |

Anchors for every dimension: **10** no findings, with good coverage · **8** polish or minor findings only · **6** one major or several minors · **4** a blocker in a common path · **2** broadly broken.

**Overall** = the weighted mean of the dimensions scored this run (stale ones included at their old value, flagged). The run **passes** when overall ≥ the pass mark (default 8), no blocker or major is open, **and** every dimension the diff touched was scored this run. A high score on dimensions nobody tested is not a pass.
