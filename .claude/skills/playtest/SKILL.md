---
name: playtest
description: Run a budgeted playtest of F35-A. Reviewer subagents test what changed since the last playtest and score the game with evidence, a developer fixes the findings round by round (one stacked-PR layer per round), and a retro on where the time went turns the slowest steps into faster test mechanisms. Takes constraints such as rounds, hours or a finish time. Use when asked to playtest, review, critique, grade or iteratively improve the game.
argument-hint: "[rounds=N] [hours=H | until=HH:MM <zone>] [pass=8] [focus=<missions, area or question>]"
---

# /playtest

Run as `/playtest <constraints>`. Constraints: $ARGUMENTS

You run a loop of **Reviewer → Check → Developer** rounds within a budget, then a **retro** on the process. Read these first:
- `.claude/skills/play-f35/SKILL.md`: how to play the game as an agent: tools, costs, test hooks.
- `.claude/skills/playtest/charters.md`: the menu of playtest types, risk scoring, the reviewer brief and the rubric.
- `docs/playtests/README.md`: the ledger: the last playtested SHA, coverage and timings.

## 0. Budget

Parse the constraints. Free text is fine ("3 rounds, done by 5pm NZT").

| Constraint | Meaning | Default |
|---|---|---|
| `rounds=N` | Most Reviewer→Developer rounds | 3 |
| `hours=H` | Wall-clock budget from now | 2 |
| `until=HH:MM <zone>` | Hard finish time; overrides `hours` | none |
| `pass=S` | Pass mark (0–10) | 8 |
| `focus=…` | Missions, an area or a question to weight the scope towards | none, the diff decides |

- A clock time without a time zone is ambiguous: cloud containers run in UTC. Ask once. If nobody is there to answer, use UTC and say so.
- Write the start time and the deadline (UTC) at the top of the ledger file (section 5) before doing anything else, and check `date -u` at every phase boundary.
- **Reserve 15 % of the total, at least 15 min, for wrap-up** (ledger, retro, PRs). Nothing else may spend it.
- **Tokens can run out before the clock does.** In a cloud session, `get_session` (claude-code-remote) shows `rate_limit_info`: `allowed_warning` means the weekly allowance is nearly spent, and `resetsAt` says when it renews. Check it at every phase boundary. Measured 2026-10-03: a browser reviewer cost 140–240k tokens, a headless reviewer 170–240k, a developer 190–215k. Under a warning, run the text-output tools (sweeps, `--text`, ui-touch) yourself instead of spawning reviewers, cap screenshots per reviewer (≤ 10), and resume a developer that knows the code with SendMessage rather than spawning a new one.
- Rough split per round: review 45 %, fixes 35 %, verify and commit 20 %. Before you start a round, estimate its cost from the previous round, or from the timings in the last ledger file. If `now + estimate > deadline − reserve`, don't start it: go to wrap-up. A half-finished round is worth less than a finished retro.

## 1. Orient and scope (≤ 10 % of the budget)

**What's in scope: what the player can play.** Operation Southern Cross (c01–c06, c08–c11) is **disabled** (owner's decision, 2026-10-03): its code and tests stay, but players can't reach it. Don't playtest it, sweep it, score it or file findings on it, even when the diff touches its missions, until the owner enables it again (`enabled: false` on `SOUTHERN_CROSS` in `src/missions/index.ts`; a playable campaign is in `PLAYABLE_CAMPAIGNS`). Spend the time on the playable game instead: the IRGC campaign (g01, g02), training (t01–t03) and Instant Action, including A Stroll in the Park. Shared code (HUD, weapons, AI, the bot) is still in scope; check it in playable missions.

1. `npm ci` if `node_modules` is missing. Start the playtest server: `npx vite --config vite.e2e.config.ts --port 5190 &`.
2. Find the last playtested SHA in `docs/playtests/README.md`. Read that run's file: findings, "not covered", time sinks.
3. `git log --oneline <sha>..HEAD` and `git diff --stat <sha>..HEAD`. Skim the commits that touch `src/`. Also list open GitHub issues labelled `bug` or mentioning balance, if you can reach them.
4. Turn the diff into risks and charters with `charters.md` sections 2 and 3: risk = likelihood × impact + coverage gap, ranked by risk per minute. `focus=` adds +3 to matching charters. With no previous run, do the baseline charters.
5. Write the plan into the ledger file: charters with budgets, and what you're deliberately **not** testing (always including the disabled Southern Cross).

## 2. Round loop

`Round <r> / <rounds>`, with the time left and the deadline. Then:

### 2a. Reviewer

- Spawn **one reviewer subagent per charter, in parallel**, with fresh context and the brief from `charters.md` section 4. Run headless sweeps (`bot-sweep.ts --jobs`) inside the reviewers, not in your own context.
- **Parallel limits.** Run one sweep at a time across all reviewers, with `--jobs=2` when browsers run beside it. Browser sessions use the CPU renderer: browsers plus sweep jobs should not exceed the core count. On 4 cores that's 2 browsers and a 2-job sweep. Three browsers plus a sweep pushed the load average to 7–11, which slowed screenshots to 8–14 s and `simulate()` to ~5 s per game minute. Plan the charters so that sweeps and browser work overlap rather than queue.
- **Test a frozen snapshot.** Serve the reviewers a detached worktree of the commit under test, on its own port (`git worktree add ../<repo>-r<N> <sha> --detach`, symlink `node_modules`, `npx vite --config vite.e2e.config.ts --port 519N`). Developers can then fix in their own worktrees while reviewers test, and nobody reads half-edited code through a dev server that doesn't watch files.
- **A Workflow runs at most CPUs − 2 agents at once** (2 on a 4-core box), which matches the two-browser limit. Run headless reviewers and developers as background agents beside it.
- **Start the next charters early.** A reviewer whose charter doesn't depend on a pending fix can start on the last snapshot while developers finish. Round 2's sweep and HUD charters ran while round 1's flow fixes were still in progress.
- **Round 1** runs the risk-ranked charters. **Later rounds** re-test what the developer changed (regression charters on the fixed findings) plus the next charters by risk, if there's budget.
- Collect the JSON. Merge duplicate findings. Drop any finding without evidence or a repro, and note that you dropped it.

### 2b. Check

Print:

```
What works well:       2–3 points, with evidence
What needs improvement: the findings by severity (id, one line, evidence)
Scores:  stability 8 · balance 5 · clarity 7 (stale) · …   Overall: 6.6 / 10   Coverage: 3/5 dimensions this round
```

Then decide:
- **PASS:** overall ≥ pass mark, no open blocker or major, and every dimension the diff touched was scored this run (`charters.md` section 5). Go to wrap-up.
- **TIME UP:** last round reached, or the next round doesn't fit the budget. Go to wrap-up.
- Otherwise go to Developer.

Don't make up a score to keep the loop going. Don't hold one back to make it look rigorous either. The score follows from the evidence and the anchors.

### 2c. Developer

1. **Triage** the open findings by severity, then cost. Fix in this round what fits in the round's fix budget. Anything bigger (a redesign, a new system, multi-file refactors, anything that changes the game's intent) becomes a GitHub issue: the finding, the evidence, the repro and a suggested approach. Never silently drop a finding. Each one ends up fixed, filed, or marked "won't fix" with a reason.
2. **Gameplay intent is the user's.** If a fix would change what a mission or mechanic *is* (not just a number), and the user is reachable, ask. If they aren't, file an issue instead of choosing.
3. **Fix in parallel by area.** Give each area (HUD, bot and tooling, menus and flow, weapons) to its own developer subagent: its own worktree, a local branch, targeted tests only, and a report of its commit SHAs. Cherry-pick the commits into one branch. Keep the small content and balance fixes yourself. Brief each developer with the finding, the evidence, the repro, the files, and "add a test that fails on the old code".
   Fix in the code's own style (`docs/ARCHITECTURE.md`). For each balance or logic fix, add or extend a vitest test that would have caught it (`runPlaythrough()` from `tests/missions-bot.ts`; see `tests/missions-balance.test.ts`), so the finding can't come back unseen.
4. **Verify before committing the layer:** `npx tsc --noEmit && npx vitest run && npx vite build`, plus the finding's own repro command. Run the build even when vitest fails (the `&&` chain skips it). Under reviewer load, heavy tests can hit vitest's 5 s timeout: rerun a failure alone before calling it real, and give heavy new tests an explicit `{ timeout }`. Restart the playtest server (or serve a new snapshot) so the next round tests the new code.
5. Commit the round as one layer (section 4). Go to the next round.

## 3. Wrap-up and retro (the reserved time)

1. **Efficiency retro.** Add up the reviewers' `time_log` and `time_sinks` and your own phase timings. Give the top 3 time sinks, each with a fix:
   - **A missing shortcut** (e.g. "had to fly 4 minutes to reach the target area", "had to win g01 to see g02"): build a test mechanism when it's small (a `window.__f35` method, a URL parameter, a `bot-sweep`/`browser-run` flag). Otherwise file an issue.
   - **A slow tool** (screenshots, page loads, sweeps that repeat work): a flag, caching, or a smaller default.
   - **Wasted orientation** (re-learning how to start a mission, which script does what): add it to `play-f35` (routing table, Gotchas or Learned). That's the stable "how we play" knowledge. Run-specific facts go in the ledger, never in the skill.
   - **Scheduling** (charters waited on each other, the CPU was idle or oversubscribed): change the parallel limits or charter sizes here.
2. **Every new test mechanism must stay out of the deployed game.** This repo is public: a shortcut documented here is documented for every player. Gate it behind `TEST_HOOKS` (`src/core/data.ts`), which is on only on the dev server and in `npm run build:test` builds. No URL parameter, key combination, localStorage flag or console API may reach the GitHub Pages build. Check with `npm run build && grep -c "<your hook name>" dist/assets/*.js`. Wiring code must be absent. A dead method body in a class is acceptable.
3. **Ledger.** Write the run file and update the index and coverage table (section 5).
4. **Skills.** Update `play-f35` (routing, costs, Learned) and this skill or `charters.md` where the process itself should change. Keep `play-f35` free of things that change with the code (its first section says what goes where).
5. **PRs.** Open or submit the stack (section 4). Each PR's description follows `.claude/skills/pull-request/SKILL.md`, with a `Closes #N` line for each issue it fixes.
6. **Report to the user:** the final score, rounds run, findings fixed, filed and won't-fix, the top time sinks and what you did about them, what wasn't covered, and the PR links.

## 4. One stacked PR layer per round

Each round's fixes are one layer of a [stacked PR](https://docs.github.com/en/pull-requests/get-started/about-stacked-prs), so every round can be reviewed and merged on its own and the CI checks (`.github/workflows/ci.yml`: typecheck, tests, build) run on each layer. The wrap-up (ledger, skill updates, new test hooks) is the top layer.

**With `gh stack`** (GitHub CLI ≥ 2.90, `gh extension install github/gh-stack`, push access to new branches):

```bash
git fetch origin master && git checkout -B playtest/<YYYY-MM-DD>-r1 origin/master
gh stack init                          # adopt the branch as the bottom of a stack
# … round 1 fixes, checks green …
git commit -m "Playtest r1: <what it fixes>"
gh stack add playtest/<YYYY-MM-DD>-r2  # next layer on top
# … round 2 …
gh stack add playtest/<YYYY-MM-DD>-wrap
# … ledger, skills, test hooks …
gh stack push && gh stack submit       # push every branch, open one PR per layer
gh stack view                          # check the chain
```

- The checks run on every layer **before** it's committed. A layer that's red locally isn't pushed.
- If a later round has to change an earlier round's code, change it in the later layer. Don't rewrite pushed layers.
- A round with no fixes adds no layer.
- Closing keywords act when a PR merges into `master`. Stack layers retarget to `master` as the layers below them merge, so `Closes #N` in a layer works. If an issue is still open after its layer merges, close it by hand.
- The feature is in public preview. If a command above has changed, check `gh stack --help` and the docs before improvising.

**When you can push only one branch** (Claude Code cloud sessions push only to their assigned branch, and `gh`'s GraphQL calls get HTTP 403 there): keep the rounds as layers *of commits*. One commit per round on the assigned branch, `Playtest r<N>: …`, with the checks green on each commit before the next round starts. Then open one PR with a section per round naming its commit. Tell the user you used the fallback and why.

## 5. The ledger: `docs/playtests/`

The ledger is public and committed with the top layer. Write it as you go, not just at the end, so a run that runs out of time still leaves a record.

- `docs/playtests/<YYYY-MM-DD>-<short-sha>.md` for each run:
  - **Header:** start, deadline, constraints, the SHA tested, the previous SHA.
  - **Scope:** charters with risk scores, and what was not covered and why.
  - **Rounds:** each round's scores, findings (id, severity, evidence, repro, outcome: fixed in `<commit>` / filed #N / won't fix: reason), and wall time per phase.
  - **Retro:** time sinks, and what was built or filed for each.
  - **Summary:** final score, PASS or TIME UP.
- `docs/playtests/README.md`: add a row to the run index and update the coverage table. The next run finds its SHA and its gaps there.

Never put secrets, tokens or personal data in the ledger. Screenshots stay in `e2e/screenshots/` (git-ignored): refer to them by path and send the important ones to the user.
