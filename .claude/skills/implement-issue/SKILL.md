---
name: implement-issue
description: Design, implement and test one GitHub issue of harell/F35-a on a branch linked to the issue, then open a PR that closes it on merge. Takes an issue number or URL. Use when asked to implement, build, do or work on a specific issue.
argument-hint: <issue number or URL>
---

# Implement an issue

Run as `/implement-issue <number or URL>`. Issue: $ARGUMENTS

Input: an issue number (`29`, `#29`) or URL (`https://github.com/harell/F35-a/issues/29`). If none was given, ask for one and stop. If the URL points to another repository, stop and say so; this skill only covers `harell/F35-a`.

The result is a PR that implements the issue, proves it with tests, and is linked to the issue so that merging it into `master` closes the issue.

## 1. Check the issue is ready (read only)

1. Read the issue, **all its comments**, its parent epic and the section of the epic it points to (`Full spec: #19, section "Phase 1c"`). A decision made in a comment overrides the body.
2. **Is it an epic?** (title `Epic: ...` or it has sub-issues). Don't implement an epic in one go. Tell the user which sub-issues are ready, and stop.
3. **Is it blocked?** Check the native dependencies (`gh api repos/harell/F35-a/issues/<N>/dependencies/blocked_by`) and the `Blocked by:` line in the body. If a hard blocker is still open, stop and tell the user. `soft:` blockers don't stop you; mention them in the PR.
4. **Is it already in progress?** Look for an open PR for it (`issue_read get` → `closed_by_pull_requests`, and open PRs mentioning `#N`) and an existing branch named `<N>-...` (`git ls-remote --heads origin '<N>-*'`). If a PR is open, stop and ask. If a branch exists without a PR, continue on that branch instead of creating a second one.
5. **Is it closed?** Stop and ask.

## 2. Get a branch linked to the issue

Start from the latest `master`: `git fetch origin master`.

**Linked branch (preferred).** This is what the issue's "Create a branch" button does. The branch appears in the issue's Development sidebar, and a PR from it closes the issue on merge even without a keyword:

```bash
gh issue develop <N> --repo harell/F35-a --base master --checkout
```

The default branch name is `<N>-<title-slug>`, which is the repo's convention (`28-civil-ships-...`). If step 1.4 found an existing branch, check it out instead.

**When that isn't possible**, use the branch you are on and rely on the `Closes #N` line in the PR (section 5). That's equivalent once the PR is open, because the PR then shows in the issue's Development sidebar and closes it on merge. It isn't possible when:
- you're in a Claude Code cloud session. GitHub's GraphQL API, which `gh issue develop` needs, returns HTTP 403 there, and the session can only push to the branch it was given.
- `gh` isn't installed or logged in.

Tell the user which of the two you used. Don't push an `<N>-...` branch by hand to look linked: only "Create a branch" and `gh issue develop` link a branch, so a branch merely named after the issue isn't linked.

## 3. Design

Before writing code:
- Read `docs/ARCHITECTURE.md` and every file the issue's `Files:` line names. Check the issue's pointers (`~L158`, function names) against today's `master`, because specs drift.
- Decide the approach, and write down the decisions the issue left open (data structures, where the code lives, defaults, numbers). These go in the PR's description.
- **Stop and ask the user** if the issue contradicts itself, its epic, a comment or the code, or if it leaves open a choice that changes gameplay or the player's experience. Do not silently pick one. Purely technical choices are yours: make them and record them.
- Keep to the issue's scope. Write down anything else you notice for the PR's "Things to know" section instead of fixing it here.

## 4. Implement and test

- Follow the surrounding code's style and the conventions in `docs/ARCHITECTURE.md`. Commit in logical steps.
- **Test each "Done when" or acceptance criterion with a test** in `tests/` where it can be unit-tested (look at the existing `tests/*.test.ts` for the style). A criterion with no test needs another proof (a screenshot, a measurement) or an explicit "not verified".
- Run all of these before opening the PR, and fix every failure:
  ```bash
  npx tsc --noEmit
  npx vitest run
  npx vite build
  ```
- **For visual or gameplay changes**, run the game:
  - Start `npm run dev` in the background.
  - Take screenshots with `node e2e/shot.mjs --url='http://localhost:5173/?mission=<id>&autostart=1' --out=e2e/screenshots/<name>.png`, and look at them yourself.
  - Run the mission smoke test on the missions you touched: `node e2e/missions.mjs --only=<ids>`.
  - `e2e/screenshots` is in `.gitignore`, so never commit screenshots. The GitHub API can't attach images to a PR either. If the issue asks for screenshots in the PR, send them to the user, and tell them in the PR that the user has to add them.
- **Frame time can't be measured here.** The headless browser renders on the CPU. Report draw calls and triangles (`?fps=1`) instead, and say that real-phone frame time is unverified.
- Before the PR, merge the latest `origin/master` into your branch and rerun the checks.

## 5. Open the PR

Follow the `pull-request` skill (`.claude/skills/pull-request/SKILL.md`). In particular:
- **Is the issue fully done?** Then the first line is `Closes #N`. **If any "Done when" item is not met**, write `Part of #N` instead and list what's left. Closing an issue with work left loses that work.
- Add a **Design** section after the summary, listing the decisions from section 3.
- **Verification** lists each "Done when" item with how it was checked: test name, screenshot or command output, or "not verified, because ...".
- The base branch is `master`.

Then check the link: `issue_read get` on the issue should list the PR under `closed_by_pull_requests`. If it doesn't, fix the PR description.

If what you built differs from the issue's spec (a number, an approach, a file layout), add a comment to the issue saying what changed and why, so the spec and the code agree.

## 6. Report

Reply to the user with:
- the PR link;
- the branch, and whether it is natively linked or linked through `Closes #N`;
- each "Done when" item: met, partly met, or not verified;
- any questions and follow-ups.
