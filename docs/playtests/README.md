# Playtest ledger

Every `/playtest` run (`.claude/skills/playtest/SKILL.md`) records itself here so the next run can test what changed since then, and fill the gaps it left, instead of starting from zero.

- One file per run: `<YYYY-MM-DD>-<short-sha>.md`. The format is in the skill, section 5.
- The **last playtested SHA** is the `Tested SHA` of the top row of the index. `/playtest` diffs from it.

## Runs

<!-- Newest first. Tested SHA = the commit the reviewers played (before that run's fixes). -->

| Date | Tested SHA | Rounds | Final score | Result | Run file |
|---|---|---|---|---|---|
| 2026-10-02 | bc94edd | 2 + 1 check | 7.1 / 10 (5.2 → 6.8 → 7.1) | STOPPED (token budget) | [2026-10-02-bc94edd.md](2026-10-02-bc94edd.md) |
| 2026-10-02 | 796f92b | 3 + 1 extra | 6.4 / 10 (5.9 → 6.0 → 6.5 → 6.4) | TIME UP | [2026-10-02-796f92b.md](2026-10-02-796f92b.md) |

## Coverage

When each playtest type was last run, and on what. `/playtest` adds +2 risk to a type that wasn't run in the last 3 runs (`charters.md` section 2).

| Type | Last run | Scope covered | Not covered |
|---|---|---|---|
| Smoke | 2026-10-02 bc94edd (sweeps, r1–r3 browser flows) | c01–c12, t01–t03, g01, g02 and the 6 IA modes headless (≈1,100 runs, no crash); browser flows for g01, g02, the IRGC picker, ending and stroll | a browser smoke of every mission (`browser-run --missions`) was not run this time; desktop viewport |
| Winnability | 2026-10-02 bc94edd (r1–r2) | campaign ×4 at 6 seeds, IRGC g01/g02 ×4 at 6 seeds, training (Pilot and Ace settings), IA 6 modes incl. stroll, c08 strike_sdb2 | IA beyond 3 seeds; a human gun pass on a touch device |
| Difficulty curve | 2026-10-02 bc94edd | campaign and IRGC ×4 difficulties ×6 seeds | — |
| Soft-lock / flow | 2026-10-02 bc94edd (r1–r3) | HUNG rows in every sweep; stroll endings (quit, crash, AO edge); IRGC picker → g01 → g02 → ending; the stroll tour | `ui-touch --part=menus/flight` not rerun |
| Exploit | 2026-10-02 bc94edd (r1) | park-and-wait in c02 (at the start and far), c09, g01, g02; missiles-only g01; gun-only probes | g02 stand-off ripple (found, filed #115) |
| Regression | 2026-10-02 bc94edd (r1–r3) | the previous run's fixes from the cockpit and the sweep; every round-1 and round-2 fix of this run | — |
| Visual / scene | 2026-10-02 bc94edd (r1, sightseer) | landmarks by day, dusk and night from the stroll (Sky Tower, bridge, One Tree Hill, Takapuna, Rangitoto, the Domain, suburbs); the PiP tower shot | the #61 spots (rail causeways, Wiri, the photo edge) were not re-shot |
| HUD / readability | 2026-10-02 bc94edd (r1–r3) | cockpit view as an F-35A pilot (BVR, WVR, SAMs, A/G, night, damage, bingo) at 844×390 and 1280×720; the g01 swarm and gun cues in chase and cockpit; the stroll's cue | the hud-only view beyond one scene; time-based visibility |
| First-time experience | 2026-10-02 bc94edd (r1) | the main menu and Instant Action from a fresh save; the IRGC picker from a fresh save | the training chain and touch layouts were not rerun |
| Pacing | 2026-10-02 bc94edd (r1) | dead stretches for c02, c04, c08, c09, c11, g01, g02 | — |
| Performance budget | 2026-10-02 796f92b (r1, r3) | draw calls and triangles at t=0/120 for 24 missions (quality=low, chase, 844×390); the target-camera PiP's cost (about 2×, #66) | not rerun in bc94edd; frame time on a real device |
