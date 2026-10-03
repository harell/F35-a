---
name: nightly-backlog
description: The nightly unattended run for harell/F35-a. In a fixed time window it cultivates the backlog, ranks the owner's issues by impact, implements as many as fit, and adds each one as a layer on the open stacked PR (or starts a new stack). Never merges. Takes an optional finish time. Use when a routine or the user asks for the nightly run, or to cultivate and implement the backlog unattended.
argument-hint: "[until=HH:MM <zone>]  (default 04:00 Pacific/Auckland)"
---

# Nightly backlog run

Run as `/nightly-backlog`. Arguments: $ARGUMENTS

Nobody is watching. You work alone from the start until a **hard deadline**, by default **04:00 Pacific/Auckland** on the night of the run (the routine starts at 02:00, so two hours). By the deadline, everything you finished is pushed and reported, and your turn has ended.

The night has three phases: **cultivate** the backlog, **implement** issues in impact order, one stack layer each, and **wrap up**. Read these skills as you reach them:
- `.claude/skills/cultivate-backlog/SKILL.md`: phase 1.
- `.claude/skills/implement-issue/SKILL.md`: sections 1, 3 and 4 for each issue. Its sections 2 and 5 (branch and PR) are replaced by the stack.
- `.claude/skills/stacked-pr/SKILL.md`: how to add and link a layer.
- `.claude/skills/pull-request/SKILL.md`: each layer's description.
- `.claude/skills/play-f35/SKILL.md`: only when an issue needs the game run.

## How the routine is wired

A routine runs this skill. Keep the wiring as it is, because the simpler setups fail:
- The routine **"F35-a nightly backlog run (02:00–04:00 NZ)"** fires at 02:00 Pacific/Auckland into the **launcher** session "F35-a nightly launcher (do not archive)". The launcher only calls `create_session` with `source_url: https://github.com/harell/F35-a` and the night's prompt, then ends its turn.
- The **worker** session it starts has the repository attached: a clone, push access, the GitHub MCP tools and the launcher's model. That's the session that follows this skill.
- A routine that starts a fresh session on its own gets no repository and no `create_session`: pushes and GitHub API writes fail with 403. Pressing **"Run now"** on the routine does exactly that, even with the launcher configured. To test the chain, schedule a one-off run into the launcher instead.
- Archiving the launcher breaks the routine. If it's gone, create a new launcher with `create_session` (with `source_url`) and point the routine's `persistent_session_id` at it.

## Standing rules

- **Only the owner's issues.** Implement only issues opened by `harell` (`user.login`). Cultivation also changes only `harell`'s issues; other issues are read for context (duplicates, dependencies) and never edited or closed.
- **Never merge** a PR, and never rebase or force-push a pushed layer. Only the owner merges.
- **Cultivation applies without asking.** The owner approved this in advance, so run `cultivate-backlog` with `apply`. The skill's other rules still hold: evidence for every close, never lose content, don't rewrite the scope of an issue that has an open PR or a branch. Its "Questions for the user" go into the night's report instead of blocking.
- **Gameplay intent stays the owner's.** If an issue needs a choice that changes what a mission or mechanic is, don't make it. Comment the question on the issue and move to the next one.
- **Pushing extra branches is allowed.** Each layer is pushed to its own `stack/…` branch (stacked-pr skill), not only to the session's assigned branch.
- **Don't subscribe to PR activity** and don't schedule check-ins. The session ends at the deadline. CI results on tonight's layers are picked up by tomorrow's run (phase 0).
- Operation Southern Cross is disabled (CLAUDE.md). Skip issues that only concern it.
- Test shortcuts stay behind `TEST_HOOKS` (`src/core/data.ts`).

## Budget

At the very start:

```bash
date -u
DEADLINE=$(TZ=Pacific/Auckland date -d 'today 04:00' +%s)   # or the until= argument
[ "$DEADLINE" -lt "$(date +%s)" ] && echo "deadline already passed"
echo "minutes left: $(( (DEADLINE - $(date +%s)) / 60 ))"
```

If the deadline has passed or less than 30 minutes are left, don't implement anything: do phase 0 and the report, then stop.

| Phase | Ends by (minutes after start, 120-minute night) | Hard cap |
|---|---|---|
| 0. Setup and the open stack | 15 | 25 min |
| 1. Cultivate and rank | 40 | 30 min |
| 2. Implement | deadline − 15 | – |
| 3. Wrap-up (reserve) | deadline | 15 min, nothing else may spend it |

For a different window, scale the phases to the same proportions, keeping the 15-minute reserve.

**Check `date -u` at every phase boundary and after every layer.** Write each phase's start and end time into your notes; they go into the report.

**Tokens can run out before the clock does.** `get_session` (claude-code-remote) shows `rate_limit_info`. Check it at each phase boundary. Under `allowed_warning`, finish the current issue, then go to wrap-up.

## 0. Setup and the open stack (≤ 25 min)

1. `git fetch origin`. Start `npm ci` in the background; it takes a few minutes.
2. **Find the open stack** (stacked-pr section 2): the stack with `open: true`. If there is one, the night builds on its top layer, even if it has waited days for review; keep adding layers to it. If several are open, extend the one whose bottom PR carries the earlier nightly reports. If none is open, the first issue tonight starts a new stack on `master`, and the second one links it (stacked-pr section 3).
3. **Merged layers:** for each merged layer, check that its issues closed (stacked-pr section 5) and close them if not.
4. **Red layers:** read the check runs of every open layer (`pull_request_read get_check_runs`). Fix a red layer before any new work: lowest red layer first, fix on its branch, merge the fix upward (stacked-pr section 4). If a fix doesn't fit in this phase's cap, comment on that PR what fails and why, and don't stack new layers on top tonight. Instead start a fresh stack on `master` only if tonight's issues don't depend on the red layer's code; otherwise skip to wrap-up.
5. **Review comments** on open layers from the owner: do the small asks on that layer and merge upward. Reply on the thread to larger ones; don't act on them alone.
6. **`master` moved on:** if an open stack's bottom layer is behind `origin/master`, merge `origin/master` into it and carry it upward.

## 1. Cultivate and rank (≤ 30 min)

Run `cultivate-backlog` with `apply`, limited to `harell`'s issues. If it can't finish within the cap, apply what is settled (closes with evidence, dependencies) and list the rest in the report.

Then rank the **ready** issues: open, opened by `harell`, all hard blockers closed, no open PR, not an epic, not already a layer in the open stack. Put the ranking in your notes:

| Rank | Issue | Impact | Size | Est. min | Files |
|---|---|---|---|---|---|

- **Impact first:** bugs that players hit, then what unblocks the most other issues, then player-visible features, then tooling and polish.
- **Size:** S ≈ 20 min, M ≈ 40 min, L ≈ 70 min, including tests and checks. Anything bigger, or anything that needs a gameplay decision, isn't attempted tonight. Note why in the report.
- **Stacking order:** a layer depends on all layers below it. Put an issue above the one it depends on. Issues that touch the same files go in rank order.

## 2. Implement (until deadline − 15 min)

For each issue in rank order:

1. **Fits?** `now + 1.5 × estimate ≤ deadline − 15 min`. If not, try the next smaller ready issue. If nothing fits, go to wrap-up.
2. **Branch** `stack/<N>-<slug>` from the top layer (or `origin/master` for a new stack).
3. **Implement** with `implement-issue` sections 1, 3 and 4: read the issue and comments, design, implement, test every "Done when" item. Run `npx tsc --noEmit && npx vitest run && npx vite build`.
4. **Checkpoint at 2 × estimate**, or at `deadline − 15 min`, whichever comes first. If the layer isn't green by then, stop it: `git stash`, comment on the issue with what was done, what's left and where it got stuck, and go back to the top layer's branch. A half-done issue is never pushed as a layer.
5. **Add the layer** (stacked-pr section 3): commit, push, open the PR with `base` = the branch below, link it into the stack. The PR title is `#<N>: <issue title>`. The description follows `pull-request` and `implement-issue` section 5: `Closes #N` (or `Part of #N`), Design, Verification.
6. Write the layer's actual minutes into your notes, so the next estimate is better.

## 3. Wrap-up (the last 15 minutes)

1. Everything finished is pushed and linked: the stacked-pr checklist's `curl` on the top PR prints the top PR, and the stack lists every layer in order. A new stack with only one layer tonight isn't linked yet; that's expected.
2. **Report** as one comment on the stack's **bottom** PR (the entry point the owner reads), ending with your session's attribution footer:

```
## Nightly run <YYYY-MM-DD> (<start>–<end> NZ)

**Stack #<S>:** #<bottom> … #<top> (<n> layers, <k> added tonight)

### Added tonight
- #<PR>: #<issue> <title> (S, est. 20 / took 26 min, checks green)

### Cultivation
- Closed: …   Regrouped: …   Dependencies: …   Body edits: …

### Not done
- #<issue>: stopped at checkpoint, see the issue comment
- #<issue>: needs your decision (question on the issue)

### Questions for you
- …

### Timing
- Setup 12 min · cultivation 27 · implementation 63 · wrap-up 9
```

If tonight started the stack, there's no earlier comment to look for. Otherwise this is one more comment on the same PR.

3. End your turn before the deadline. Don't start anything new in the reserve.
