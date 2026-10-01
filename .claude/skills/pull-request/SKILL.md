---
name: pull-request
description: How to write a pull request for this repo, including the closing keywords that close the PR's issues on merge. Use whenever you open a pull request or edit a PR description.
---

# Pull requests in F35-a

## 1. Close the issue (required)

GitHub closes an issue on merge only when the PR is **linked** to it and the PR merges into `master`. A PR made from a `claude/*` branch isn't linked by its branch, so the description has to link it.

**Find the issue number:**
- the task you were given (an issue link, "issue #28", "work on #5");
- the branch name: a branch created from an issue starts with its number (`28-civil-ships-...` is issue #28);
- otherwise, search the open issues for one that matches the change.

If you can't find one for sure, don't guess. Leave the closing line out and say so in your reply to the user.

**Write the closing line as the first line of the description:**

```
Closes #28
```

- **One keyword per issue.** `Closes #28, closes #29` closes both. `Closes #28, #29` closes only #28.
- **Only `close`, `closes`, `closed`, `fix`, `fixes`, `fixed`, `resolve`, `resolves` or `resolved` link the issue.** "Addressing issue #28", "for #28" and "see #28" don't, so the issue stays open.
- **Epics and partial work use `Part of #N`.** Don't close an epic (#18, #19) or an issue the PR only partly does. If a PR finishes a sub-issue of an epic, write `Closes #28` and `Part of #19`.
- **A PR that targets another branch closes nothing.** Closing keywords only act when the PR merges into `master`. If the base branch is different, say so in the description and close the issue by hand after merging into `master`.

## 2. Description layout

Put these sections under the closing line, keeping each short and concrete:

```
Closes #N

<One or two sentences: what changes for the player or the developer, and why.>

## What changed
- Grouped by area, naming the main files.

## Things to know
- Behavior changes, limitations, follow-ups, anything a reviewer could trip on.
  Leave this out if there's nothing.

## Verification
- The commands you ran and their results (`npx tsc --noEmit`, `npx vitest run` with
  the test count, `npx vite build`, e2e or browser checks).
- What you did NOT verify, and why (for example, frame time on a real phone).
```

- **Report results as they happened.** If a test failed or was flaky, say which one and what you did about it.
- **Don't pad.** Don't restate the diff line by line, and don't claim "comprehensive" test coverage.
- **End with the attribution lines** your session tells you to add.

## 3. Before you create the PR

- [ ] The first line is `Closes #N` (one per issue), or `Part of #N`, or you've told the user there's no issue.
- [ ] The base branch is `master`. If it isn't, see the last bullet in section 1.
- [ ] The Verification section matches what you actually ran.
