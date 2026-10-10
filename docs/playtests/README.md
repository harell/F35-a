# Playtest ledger

Every `/playtest` run (`.claude/skills/playtest/SKILL.md`) records itself here so the next run can test what changed since then, and fill the gaps it left, instead of starting from zero.

- One file per run: `<YYYY-MM-DD>-<short-sha>.md`. The format is in the skill, section 5.
- The **last playtested SHA** is the `Tested SHA` of the top row of the index. `/playtest` diffs from it.

## Runs

<!-- Newest first. Tested SHA = the commit the reviewers played (before that run's fixes). -->

| Date | Tested SHA | Rounds | Final score | Result | Run file |
|---|---|---|---|---|---|
| 2026-10-10 | d676141 | 4 | 7.3 / 10 (5.3 → 6.2 → 6.9 → 7.3) | TIME UP | [2026-10-10-d676141.md](2026-10-10-d676141.md) |
| 2026-10-02 | bc94edd | 2 + 1 check | 7.1 / 10 (5.2 → 6.8 → 7.1) | STOPPED (token budget) | [2026-10-02-bc94edd.md](2026-10-02-bc94edd.md) |
| 2026-10-02 | 796f92b | 3 + 1 extra | 6.4 / 10 (5.9 → 6.0 → 6.5 → 6.4) | TIME UP | [2026-10-02-796f92b.md](2026-10-02-796f92b.md) |

## Coverage

When each playtest type was last run, and on what. `/playtest` adds +2 risk to a type that wasn't run in the last 3 runs (`charters.md` section 2).

| Type | Last run | Scope covered | Not covered |
|---|---|---|---|
| Smoke | 2026-10-10 d676141 (r1 1.2; every browser charter after) | all 15 playable missions (g01–g03, t01–t07, five IA modes) in one page, 0 page errors; ~2,900 sweep runs over three rounds with no crash | desktop beyond the menu |
| Winnability | 2026-10-10 d676141 (r1–r3) | g01–g03 by route (g03: golden, golden_north, south, sead, straight, north, wide, high, killall; g02: plain, sead, killall) × R/P/V × 6 seeds; the casual proxies `--reaction=2.5` and `--nodefend`; IA four modes × loadouts; training; g01's ways (gun only, a2a_dogfight, routes, r4) | g01 Veteran plays like Pilot (#286); a human gun pass |
| Difficulty curve | 2026-10-10 d676141 | campaign and IA × 3 difficulties × 6 seeds, against g01 as the owner's reference, with the new threat table (rounds at the jet, lowest health) | — |
| Soft-lock / flow | 2026-10-10 d676141 (r1–r3) | HUNG rows in every sweep (T05 without the beam, IA Strike Veteran, the Gauntlet parked: all fixed); T05 drill 3's heat-seekers running out; the menu → lessons → campaign flow from a fresh save | `ui-touch --part=flight` not rerun |
| Exploit | 2026-10-10 d676141 (r1, r2) | park start/far in g01–g03 and IA, g03 high/wide, `--nodefend` in g02/g03/T05, strike_beast and strike_stealth traps, gun only in g01 (r4) | `--gunonly` in g02 (the bot can't strafe boats, #283) |
| Regression | 2026-10-10 d676141 (r2 2.2, r3 3.1) | every round-1 and round-2 fix, on screen at 844×390 | — |
| Visual / scene | 2026-10-10 d676141 (r1 1.1, r2 2.2, r3 3.2) | the suburbs, the aerial photo's seam, missing neighbourhoods (#274), the Pakuranga hole, the CBD by day, low and at night, Britomart, the Domain and Museum, Mission Bay, trains, helicopters, superyachts, Waiheke, the Codex pests | idle scenes (SwiftShader never settled after a camera jump); Devonport and Tāmaki Drive up close; high tier |
| HUD / readability | 2026-10-10 d676141 (r1 1.2, r2 2.1/2.2, r3 3.1) | the cockpit view for a casual player, missile launches, hits and incoming missiles from cockpit and chase, the AARGM/AWAY cues, the pod, hint paging, briefing threats at 844×390 | real-time trails (held-sim shots can't show them) |
| First-time experience | 2026-10-10 d676141 (r1 1.4, r2 2.1, r3 3.1) | fresh save → new-pilot card (sightseeing) → Training list → every lesson's texts → campaign briefings | touch learnability on a real phone |
| Pacing | 2026-10-10 d676141 (r1–r3) | dead stretches for every playable mission and lesson, every round | — |
| Performance budget | 2026-10-10 d676141 (r1 1.2, 1.1) | draw calls ≤ the 796f92b baseline; triangles on low +74 % (median 586k, #275); medium 0.5–1.06 M | frame time on a real device |

Rows dated before 2026-10-04 predate the deletion of Operation Southern Cross (c01–c12), the Ace difficulty and the lesson renumbering of #271 (the old t03 is t06 now): read them as history, not as current scope.
