# F35-a

## Pull requests

Before opening a PR or editing its description, read `.claude/skills/pull-request/SKILL.md` and follow it.
The rule that matters most: make the first line of the description `Closes #N` (one keyword per issue) so the issue closes when the PR is merged into `master`.

## Playing and playtesting the game

To run, play or inspect the game as an agent (jump to a mission, fast-forward, bot sweeps), read `.claude/skills/play-f35/SKILL.md` first.
Operation Southern Cross (c01–c11) was deleted; old saves may still hold those ids, so never reuse them.
To model a real building (a landmark, tower, stadium or mall) in 3D, read `.claude/skills/hero-building/SKILL.md` first.
Test shortcuts must stay out of the deployed game: gate them behind `TEST_HOOKS` (`src/core/data.ts`).

## Stacked PRs and the nightly run

Work that comes in layers (one issue or one playtest round per PR) goes into a stacked PR: read `.claude/skills/stacked-pr/SKILL.md`.
A routine runs `.claude/skills/nightly-backlog/SKILL.md` every night from 02:00 to 04:00 Pacific/Auckland. It adds one layer per issue to the open stack and never merges; only the owner merges.
