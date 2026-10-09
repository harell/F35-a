# Agent instructions

- Fix stale or outdated text and code (comments, docs, player-facing strings, dead references) whenever you find it, even if it predates your task, without asking first; mention what you fixed in the PR.
- Tidy up before every PR into `master`: remove dead code, unused flags and exports, debug output, throwaway scripts and leftover TODOs from the branch, and re-read the diff for anything that only made sense mid-task.
- No workaround reaches `master`. A temporary hack is fine on a dev branch or inside a test while you work, but replace it with the real fix (or take it out) before the PR; if a real fix isn't possible yet, say so in the PR instead of shipping the workaround.
