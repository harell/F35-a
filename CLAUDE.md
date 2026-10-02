# F35-a

## Pull requests

Before opening a PR or editing its description, read `.claude/skills/pull-request/SKILL.md` and follow it.
The rule that matters most: make the first line of the description `Closes #N` (one keyword per issue) so the issue closes when the PR is merged into `master`.

## Playing and playtesting the game

To run, play or inspect the game as an agent (jump to a mission, fast-forward, bot sweeps), read `.claude/skills/play-f35/SKILL.md` first.
Test shortcuts must stay out of the deployed game: gate them behind `TEST_HOOKS` (`src/core/data.ts`).
