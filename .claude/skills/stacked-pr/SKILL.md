---
name: stacked-pr
description: Build, extend and look after a stacked pull request in harell/F35-a, a chain of PRs where each layer targets the branch below it and GitHub links them into one native stack. Covers finding the open stack, adding a layer, linking it with the Stacks REST API, fixing a lower layer, and what happens when layers merge. Works in Claude Code cloud sessions, where `gh` isn't logged in. Use when asked to stack PRs, add a layer, or work on a stack.
---

# Stacked pull requests

A **stack** is two or more pull requests in one repository that build on each other. The bottom PR targets `master`. Every PR above targets the branch of the PR below it, so each one shows only its own diff and can be reviewed alone. GitHub links them into one **native stack**: each PR shows its layer number and a stack map in the merge box, and merging a layer also merges everything below it, after which the next layer is retargeted to `master`. The feature is in public preview ([about stacks](https://docs.github.com/en/pull-requests/get-started/about-stacked-prs), [REST API](https://docs.github.com/en/rest/pulls/stacks), [merging](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/merging-stacked-pull-requests)).

A chain of PRs isn't a native stack just because their bases line up. It has to be linked, through `gh stack submit`/`gh stack link`, or the Stacks REST API (section 3).

In this repo:
- **One layer = one PR = one branch**, branched from the layer below. A layer is one reviewable unit: one issue, one playtest round.
- **CI runs on every layer.** `.github/workflows/ci.yml` triggers on every `pull_request` whatever its base (typecheck, tests, build).
- **Only the owner merges.** Agents never merge a layer unless the user says so in the task.
- Each layer's description follows `.claude/skills/pull-request/SKILL.md`.

## 1. Which tools work where

| | Cloud session (claude.ai/code, routines) | Local, with `gh` logged in |
|---|---|---|
| Push branches | `git push -u origin <branch>`. Any new branch name works. Deleting a remote branch is refused (403). | same, and deletes work |
| Open and edit PRs | GitHub MCP: `create_pull_request`, `update_pull_request`, `pull_request_read` | `gh pr create`, or the MCP tools |
| Read stacks | `curl` the Stacks REST API, no token needed (the repo is public) | `gh stack view`, `gh api` |
| Link a stack | Stacks REST API (section 3) | `gh stack link` / `gh stack submit` |

`gh` isn't logged in inside cloud sessions, so `gh stack` and `gh api` don't work there.

## 2. Find the open stack

Before starting a new stack, look for one you should extend:

```bash
API=https://api.github.com/repos/harell/F35-a
H=(-H "Accept: application/vnd.github+json" -H "X-GitHub-Api-Version: 2026-03-10")
curl -sS "${H[@]}" "$API/stacks"                       # every stack: number, PRs bottom→top
curl -sS "${H[@]}" "$API/stacks?pull_request=<PR>"     # the stack a PR belongs to
curl -sS "${H[@]}" "$API/stacks/<number>"
```

Then check each PR's state with `pull_request_read get`. A stack is **open** while its top PR is open and unmerged. The **top layer** is the open PR that no other open PR uses as its base; you build on its head branch.

If the API shows no stack but open PRs chain by base branch (`list_pull_requests state: open`, field `base`/`head`), they are an unlinked stack: link them (section 3) and carry on.

## 3. Add a layer

```bash
git fetch origin
git checkout -B <new-branch> origin/<top-branch>     # or origin/master for the first layer
# … the change …
npx tsc --noEmit && npx vitest run && npx vite build   # a red layer is never pushed
git commit -m "<what this layer does>"
git push -u origin <new-branch>
```

1. **Branch names:** `stack/<issue>-<slug>` for an issue (`stack/97-radar-lock-tone`), or `stack/<topic>` without one. One branch per layer, never reused.
2. **Open the PR** with `create_pull_request`: `head` the new branch, `base` the branch below (`master` for the bottom layer). Put `Stack layer N of a stacked PR. Base: #<PR below>.` under the closing line, so the order still reads correctly if the link fails.
3. **Link it.** The first two PRs create the stack. Every later PR is appended to the top:

```bash
curl -sS -X POST "${H[@]}" "$API/stacks" -d '{"pull_requests":[<bottom>,<second>]}'
curl -sS -X POST "${H[@]}" "$API/stacks/<number>/add" -d '{"pull_requests":[<new>]}'
```

A single PR on `master` is not a stack yet. It becomes one when the second layer is linked.

## 4. Fix a lower layer

When review or CI asks for a change in layer *k*:
1. Commit the fix on layer *k*'s branch and push it.
2. Carry it upward: for each layer above, in order, `git checkout <branch> && git merge origin/<branch below>`, rerun the checks and push.

**Never rebase or force-push a pushed layer.** Merging keeps every reviewer's checkout valid, and the stack's diffs stay right because each PR compares against the branch below.

## 5. When layers merge

- Layers merge **bottom up**. Merging a layer lands it and every unmerged layer below it on `master` in one operation, and GitHub retargets the next layer to `master`.
- The merged branches stay on GitHub. A cloud session can't delete them, so the owner deletes them, or turns on "Automatically delete head branches" in the repo settings.
- **Closing keywords.** `Closes #N` acts when the PR merges into `master`. After a stack merge, check each merged layer's issues with `issue_read get`. Close any that are still open as `completed`, with a comment naming the PR.
- **`master` moved on under an open stack** (something else merged): merge `origin/master` into the bottom layer, then carry it upward as in section 4.

## 6. Checklist for a layer

- [ ] Branched from the current top layer (or `master` for the bottom).
- [ ] Checks green locally before the push.
- [ ] PR base is the branch below, and the body says which PR is below it.
- [ ] Linked into the native stack: `curl "$API/stacks?pull_request=<new PR>"` lists it at the top.
- [ ] No merge, no rebase, no force-push.
