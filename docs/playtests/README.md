# Playtest ledger

Every `/playtest` run (`.claude/skills/playtest/SKILL.md`) records itself here so the next run can test what changed since then, and fill the gaps it left, instead of starting from zero.

- One file per run: `<YYYY-MM-DD>-<short-sha>.md`. The format is in the skill, section 5.
- The **last playtested SHA** is the `Tested SHA` of the top row of the index. `/playtest` diffs from it.

## Runs

<!-- Newest first. Tested SHA = the commit the reviewers played (before that run's fixes). -->

| Date | Tested SHA | Rounds | Final score | Result | Run file |
|---|---|---|---|---|---|
| 2026-10-02 | 796f92b | 3 | 6.5 / 10 (5.9 → 6.0 → 6.5) | TIME UP | [2026-10-02-796f92b.md](2026-10-02-796f92b.md) |

## Coverage

When each playtest type was last run, and on what. `/playtest` adds +2 risk to a type that wasn't run in the last 3 runs (`charters.md` section 2).

| Type | Last run | Scope covered | Not covered |
|---|---|---|---|
| Smoke | 2026-10-02 (r1, r3) | c01–c12, t01–t03, all 5 IA modes on Auckland, Defend on all 5 theatres; no page or console errors | IA modes other than Defend on the procedural theatres; medium/high quality; desktop viewport |
| Winnability | 2026-10-02 (r1–r3) | campaign ×4 difficulties, training, IA 5 modes × 5 theatres × recruit/pilot/veteran, the `strike_sdb2` loadout | Ace for IA and training; IA beyond 2 seeds; non-default IA options (enemy count, type, night, weather) |
| Difficulty curve | 2026-10-02 | campaign ×4 difficulties ×3 seeds (6 for c02, c09, c12, t03) | Veteran misses rerun at 6 seeds (#58) |
| Soft-lock / flow | 2026-10-02 | HUNG rows in every sweep; menus, onboarding, training chain T01 → c01, briefing Back (`ui-touch --part=menus`) | `ui-touch --part=flight`; tilt and left-handed layouts in flight |
| Exploit | 2026-10-02 (r2, r3) | park-and-wait (Defend in every theatre and difficulty; c01, c02, c05, c10; more in r3), low flight (t03, c03, c04), bridge farming, rearm cheese | gun-only; MANPADS at Veteran+ low level |
| Regression | 2026-10-02 (r2, r3) | every round-1 and round-2 finding | — |
| Visual / scene | 2026-10-02 (r1) | rail ribbons (5 views), aerial photo (2 daytime views), ferries and wakes, Wiri tanks | aerial photo at dusk/night; rail z-fighting at junctions; night ferries |
| HUD / readability | 2026-10-02 (r1–r3) | c01, c03, c06 and Defend in chase, hud, cockpit and tactical; bomb cue, site marker, objectives, hints | time-based visibility (simulate() freezes the HUD clock); the missile hint on screen |
| First-time experience | 2026-10-02 (r1, r2) | splash → menus → onboarding → T01 briefing and flight, hint wording | learnability (proxy only); tilt controls |
| Pacing | 2026-10-02 (r1) | dead stretches per mission from bot event logs (#59) | — |
| Performance budget | 2026-10-02 (r1, r3) | draw calls and triangles at t=0/120 for 24 missions (quality=low, chase, 844×390) | frame time on a real device; medium/high quality; cockpit view |
