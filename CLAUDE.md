# F35-a

## Pull requests

Before opening a PR or editing its description, read `.claude/skills/pull-request/SKILL.md` and follow it.
The rule that matters most: make the first line of the description `Closes #N` (one keyword per issue) so the issue closes when the PR is merged into `master`.

## Playing and playtesting the game

To run, play or inspect the game as an agent (jump to a mission, fast-forward, bot sweeps), read `.claude/skills/play-f35/SKILL.md` first.
Operation Southern Cross (c01–c11) is disabled: its code stays, but players can't reach it, so playtests and sweeps skip it until the owner enables it again (`enabled: false` in `src/missions/index.ts`).
To model a real building (a landmark, tower, stadium or mall) in 3D, read `.claude/skills/hero-building/SKILL.md` first.
Test shortcuts must stay out of the deployed game: gate them behind `TEST_HOOKS` (`src/core/data.ts`).
