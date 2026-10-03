---
name: stacked-pr
description: Build, extend and look after a stacked pull request in harell/F35-a, a chain of PRs where each layer targets the branch below it and GitHub links them into one native stack. Covers finding the open stack, adding a layer, linking it with the Stacks REST API, fixing a lower layer, and what happens when layers merge. Works in Claude Code cloud sessions, where `gh` isn't logged in. Use when asked to stack PRs, add a layer, or work on a stack.
---

# Stacked pull requests

A **stack** is two or more pull requests in one repository that build on each other. The bottom PR targets `master`. Every PR above targets the branch of the PR below it, so each one shows only its own diff and can be reviewed alone. GitHub links them into one **native stack**: each PR shows its layer number and a stack map in the merge box, and merging a layer also merges everything below it, after which the next layer is retargeted to `master`. The feature is in public preview ([about stacks](https://docs.github.com/en/pull-requests/get-started/about-stacked-prs), [REST API](https://docs.github.com/en/rest/pulls/stacks), [merging](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/merging-stacked-pull-requests)).

A chain of PRs isn't a native stack just because their bases line up. It has to be linked, with the Stacks REST API (section 3) or `gh stack link`/`gh stack submit`.

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
| Read, create and extend stacks | `curl` the Stacks REST API (sections 2–3). The session's proxy authenticates it. | the same `curl`, `gh api`, or `gh stack` |

`gh` isn't logged in inside cloud sessions, so `gh stack` and `gh api` don't work there. Plain `curl` does.

Set these once per shell. Every request with a body needs the `Content-Type` header, or it fails with HTTP 415:

```bash
API=https://api.github.com/repos/harell/F35-a
H=(-H "Accept: application/vnd.github+json" -H "X-GitHub-Api-Version: 2026-03-10" -H "Content-Type: application/json")
```

## 2. Find the open stack

Before starting a new stack, look for one to extend:

```bash
curl -sS "${H[@]}" "$API/stacks" \
  | jq -c '.[] | select(.open) | {number, prs: [.pull_requests[] | {number, state, merged_at, head: .head.ref, base: .base.ref}]}'
```

- `pull_requests` is ordered bottom to top. The **top layer** is the last one; build on its `head.ref`.
- `open: true` means the stack still has unmerged PRs. Several open stacks: extend the one the task names, or ask.
- Stack numbers share the numbering of issues and PRs (stack #134 sits between PRs #133 and #135), so always say "stack #134", never just "#134".
- From a PR: `curl -sS "${H[@]}" "$API/stacks?pull_request=<PR>"`, or the `stack` field of `GET $API/pulls/<PR>`: `{number, size, position}`, where position 1 is the bottom.

If no stack is open but open PRs chain by base branch (`list_pull_requests state: open`, fields `number, head, base`), they are an unlinked stack: link them (section 3) and carry on.

## 3. Add a layer

```bash
git fetch origin
git checkout -B <new-branch> origin/<top-branch>      # origin/master for a new stack
# … the change …
npx tsc --noEmit && npx vitest run && npx vite build    # a red layer is never pushed
git commit -m "<what this layer does>"
git push -u origin <new-branch>
```

1. **Branch name:** `stack/<issue>-<slug>` for an issue (`stack/97-radar-lock-tone`), `stack/<topic>` without one. One branch per layer, never reused.
2. **Open the PR** with `create_pull_request`: `head` the new branch, `base` the branch below (`master` for the bottom layer). Under the closing line write `Stack layer <N> of stack #<S>. Base: #<PR below>.`, so the order reads right even without the stack map.
3. **Link it.** A single PR on `master` isn't a stack yet: the second layer creates the stack, and every later one is appended to its top.

```bash
curl -sS "${H[@]}" -X POST "$API/stacks" -d '{"pull_requests":[<bottom>,<second>]}' | jq '{number, open}'   # 201
curl -sS "${H[@]}" -X POST "$API/stacks/<S>/add" -d '{"pull_requests":[<new>]}' | jq '[.pull_requests[].number]'   # 200
```

Each PR's base must be the head branch of the PR before it, or the API answers 422.

## 4. Fix a lower layer

When review or CI asks for a change in layer *k*:
1. Commit the fix on layer *k*'s branch and push it.
2. Carry it upward: for each layer above, in order, `git checkout <branch> && git merge --no-edit origin/<branch below>`, rerun the checks and push.

**Never rebase or force-push a pushed layer.** Merging keeps every reviewer's checkout valid, and each PR's diff stays its own because it compares against the branch below. The stack link survives pushes; nothing needs relinking.

## 5. When layers merge

- Layers merge **bottom up**. Merging a layer lands it and every unmerged layer below it on `master` in one operation, and GitHub retargets the next layer to `master`.
- Merged branches stay on GitHub. A cloud session can't delete them, so the owner deletes them, or turns on "Automatically delete head branches" in the repository settings.
- **Closing keywords** act when a PR merges into `master`. After a stack merge, check each merged layer's issues with `issue_read get`. Close any still open as `completed`, with a comment naming the PR.
- **`master` moved on under an open stack:** merge `origin/master` into the bottom layer, then carry it upward (section 4).

## 6. Checklist for a layer

- [ ] Branched from the current top layer (`origin/master` for a new stack).
- [ ] Checks green locally before the push.
- [ ] PR base is the branch below, and the body names the stack and the PR below.
- [ ] Linked: `curl -sS "${H[@]}" "$API/stacks?pull_request=<new PR>" | jq '.[].pull_requests[-1].number'` prints the new PR.
- [ ] No merge, no rebase, no force-push.
