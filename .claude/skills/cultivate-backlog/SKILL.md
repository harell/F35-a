---
name: cultivate-backlog
description: Cultivate (groom, tidy, triage, organise) the GitHub issue backlog of harell/F35-a. It closes issues that are done, duplicated or no longer relevant, groups related issues under epics as sub-issues, sets "blocked by" dependencies, fixes contradictions between issue bodies, and works out the order and what can run in parallel. Use when asked to cultivate, groom, tidy, triage or organise the backlog or issues.
argument-hint: "[epic number to limit the run to] [apply]"
---

# Cultivate the backlog

Run as `/cultivate-backlog`. Arguments: $ARGUMENTS
- With no arguments, it covers the whole backlog.
- A number limits the run to that epic and its sub-issues, plus anything they depend on or block.
- `apply` means the user has already approved: apply the plan without waiting (section 0).

The goal is a backlog where every open issue is still wanted, says one consistent thing, sits under the right epic, and declares what it waits on. Then anyone can pick up a "ready" issue cold and in the right order.

Issues here are specs (see #19). A careless rewrite destroys decisions, so this skill is conservative about deleting and strict about evidence.

## 0. Ground rules

- **Plan first, then apply.** Build the whole change plan (section 6), show it to the user, and apply it only after they approve. Skip the approval only if the user's request already says to apply without asking.
- **Evidence for every close.** Closing needs a merged PR, code on `master`, or a stated decision. "Looks old" is not evidence.
- **Never lose content.** When you merge, split or rewrite, move text to where it now belongs. Delete only text that is wrong, and say why in the change plan. Keep "Decisions already made" sections word for word unless the user changes the decision.
- **Don't change scope under someone's feet.** If an issue has an open PR, or a branch named `<N>-...`, don't rewrite its scope. Comment the proposed change on the issue instead.
- **Don't invent structure.** Don't make up labels, milestones or epics for one or two issues. Group only where it helps someone choose what to do next.
- **Running it twice changes nothing.** A second run with no new activity should produce an empty plan.

## 1. Tools

Prefer the GitHub MCP tools. Use `gh api` for what they can't do.

| Need | How |
|---|---|
| List or read issues, comments, labels | `list_issues`, `issue_read` (`get`, `get_comments`, `get_sub_issues`, `get_parent`) |
| Edit body or title, close, reopen | `issue_write` (`method: update`). When closing, always set `state_reason`: `completed`, `not_planned`, or `duplicate` with `duplicate_of`. |
| Comment | `add_issue_comment`, ending with the attribution footer your session requires |
| Sub-issues | `sub_issue_write` (`add`, `remove`, `reprioritize`). It takes the issue's **REST id**, not its number. Get the id with `gh api repos/harell/F35-a/issues/<N> --jq .id`. To move an issue to a new parent, pass `replace_parent: true`. |
| Read dependencies | `gh api repos/harell/F35-a/issues/<N>/dependencies/blocked_by` (and `.../blocking`) |
| Add a dependency (<N> is blocked by <M>) | `gh api -X POST repos/harell/F35-a/issues/<N>/dependencies/blocked_by -F issue_id=<REST id of M>` |
| Remove a dependency | `gh api -X DELETE repos/harell/F35-a/issues/<N>/dependencies/blocked_by/<REST id of M>` |
| Which PRs closed or will close an issue | `issue_read get`, field `closed_by_pull_requests` |
| Merged PRs and the code | `list_pull_requests` (`state: closed`, check `merged_at`), `git log origin/master`, and reading the source |

If `gh` isn't authenticated, write dependencies in the issue body only, and tell the user the native links are missing.

## 2. Gather (read everything first, write nothing)

1. All **open** issues, with their bodies, comments, labels, parents, sub-issues and dependencies. Paginate until you have them all.
2. Issues **closed since the last cultivation** (or the last 30 days). They show what is already done and what a duplicate may point to.
3. **Merged PRs** in the same window, their bodies, and which issues they closed or mentioned.
4. `git fetch origin master`, then read the code paths each open issue names. Specs drift: files move, functions get renamed, features land under other issues.

Comments count. A decision made in a comment overrides the body until you fold it into the body.

## 3. Decide each issue

Settle each issue in this order: first whether it should exist, then where it sits, then what it says.

### 3a. Close
- **Done:** a merged PR delivered it, or the code on `master` meets its "Done when" or acceptance criteria. Check the criteria themselves; a linked PR alone isn't enough. If only part is done, don't close it. Rewrite it to list what's left, and name the PR that did the rest.
  Close with `state_reason: completed` and a comment naming the PR or commit.
- **Duplicate:** first merge anything unique from the duplicate into the issue that survives, then close with `state_reason: duplicate` and `duplicate_of`. Keep the older issue unless the newer one is clearly the better spec.
- **No longer relevant:** the feature was removed, the approach was replaced, or another issue made it moot. Close with `state_reason: not_planned` and a comment that gives the reason and links what replaced it.
- **Unsure:** don't close. Put it under "Questions for the user" in the plan.

### 3b. Group
- **Epics** are parent issues titled `Epic: ...`. They hold the shared spec and an execution plan table. Each sub-issue is one PR.
- Make an issue a sub-issue when it's one deliverable of an existing epic. Create a new epic only when 3 or more open issues share a goal and none of them is already the umbrella. One level of nesting is enough.
- A sub-issue starts with `Part of epic #N.`, and its title carries its position in the plan, like `Civil ships 2/4: ...`. Renumber the titles when the plan changes.

### 3c. Dependencies
- **Blocked by** means the issue can't be built or merged until the other issue's code or data exists. Name the concrete thing it needs (`#28: the ship entities and container/cruise subtype`).
- **Soft dependencies** ("easier after", or "whichever lands second re-checks both") go in the body only, marked `soft:`. Never make them native dependencies, because they'd block work that doesn't need to wait.
- Every hard dependency is set **both** natively (section 1) and in the issue's `## Dependencies` section. Make the two agree; when they differ, the code and the specs decide which is right.
- A dependency on a closed issue is satisfied. Mark it done in the body (`#28 ✅`) rather than deleting it, so the reason stays readable. Leave the native link; GitHub shows it as resolved.
- Check for cycles. A cycle means a wrong dependency or an issue that should be split. Fix it or ask.

### 3d. Make the bodies agree
- Look for contradictions **between** issues: the same file or feature specced two ways, numbers that disagree (ranges, budgets, counts), a decision in one issue undone in another, or an issue still describing work that a merged PR did differently.
- The newest **decision** wins, not the newest **text**. A merged PR's actual behavior beats an unmerged spec. If you can't tell which is intended, ask the user rather than picking one.
- Fix the spec in **one place**. Sub-issues point to the epic section ("Full spec: #19, section Phase 1c") rather than copying it. Point to code and files that still exist on `master`.
- Keep the repo's sub-issue layout:
  ```
  Part of epic #N. **Full spec: #N, section "..."**

  ## Dependencies
  - **Blocked by:** #A (what it needs from it). soft: #B (why).
  - **Blocks:** #C.
  - **Files:** `src/...`, `src/...`

  ## Scope
  ## Done when
  ```
- Every issue must work from a **cold start**: readable without any earlier conversation.

## 4. Order and parallelism

Work this out from the dependency graph plus file overlap:
- **Ready now:** open, all hard blockers closed, and no open PR on it.
- **Can run in parallel:** ready issues whose `Files:` lists don't overlap. Two issues touching the same files will conflict as PRs, so put them in order even if neither blocks the other, and say "same files" as the reason.
- **Order:** sort by dependency depth, then by how many other issues each one unblocks.

Write this into each epic's execution plan table (`# | Sub-issue | Blocked by | Can run in parallel with`, plus cross-epic links), and mark finished rows `✅ done in #PR`. Don't create a separate roadmap issue; it would just be another thing to keep up to date.

## 5. Apply

Apply the approved plan in this order, so each step builds on settled state: closes and duplicates → sub-issue moves → dependencies → body edits → epic tables.

- When an edit changes an issue's meaning (scope, dependencies, a decision), add a one-line comment saying what changed and why. Typos and link fixes don't need one.
- Afterwards, re-read every issue you touched and recheck: no cycles, body and native dependencies agree, every sub-issue has the right parent.

## 6. Change plan and report

Show the plan in chat in this form (then use the same form for the final report, saying what was done). The issue numbers below are made up to show the format, not real findings:

```
## Close (N)
- #101 completed: delivered by PR #140 (checked against its "Done when": ...)
- #102 duplicate of #103: moved its test list into #103 first

## Regroup (N)
- #104 → sub-issue of epic #100

## Dependencies (+N / −N)
- #105 blocked by #106 (needs the X entity that #106 adds)
- #107: mark "blocked by #106" as done (#106 closed)

## Body edits (N)
- #100: execution plan table marks #106 as done
- #108: berth count 8 → 3, to match what PR #140 shipped

## Ready now, can run in parallel
- #109, #110, #111 (no shared files)
- #112 and #113 both touch Effects.ts: do #112 first

## Questions for the user
- #114: still wanted after #108 changed the approach?
```

Link every issue in the report as a full URL (`https://github.com/harell/F35-a/issues/N`) so the user can click through.
