# Playtest ledger

Every `/playtest` run (`.claude/skills/playtest/SKILL.md`) records itself here so the next run can test what changed since then, and fill the gaps it left, instead of starting from zero.

- One file per run: `<YYYY-MM-DD>-<short-sha>.md`. The format is in the skill, section 5.
- The **last playtested SHA** is the `Tested SHA` of the top row of the index. `/playtest` diffs from it.

## Runs

<!-- Newest first. Tested SHA = the commit the reviewers played (before that run's fixes). -->

| Date | Tested SHA | Rounds | Final score | Result | Run file |
|---|---|---|---|---|---|
| — | — | — | — | no runs yet: the first run is a baseline | — |

## Coverage

When each playtest type was last run, and on what. `/playtest` adds +2 risk to a type that wasn't run in the last 3 runs (`charters.md` section 2).

| Type | Last run | Scope covered | Not covered |
|---|---|---|---|
| Smoke | — | — | — |
| Winnability | — | — | — |
| Difficulty curve | — | — | — |
| Soft-lock / flow | — | — | — |
| Exploit | — | — | — |
| Regression | — | — | — |
| Visual / scene | — | — | — |
| HUD / readability | — | — | — |
| First-time experience | — | — | — |
| Pacing | — | — | — |
| Performance budget | — | — | — |
