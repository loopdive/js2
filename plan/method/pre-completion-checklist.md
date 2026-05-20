# Pre-Completion Checklist

**You MUST read this file and confirm each step before signaling task completion.**

## Before signaling completion

1. [ ] All work is committed to your branch (no uncommitted changes)
2. [ ] `git merge main` — merge main INTO your branch (not rebase)
   - If conflicts: resolve them, `git add`, `git commit`
   - If merge goes wrong: `git merge --abort` (your commits are safe)
   - **Never rebase** — rebase rewrites SHAs and causes branch name churn

## Post-integration local checks

Local validation happens AFTER merging main into your branch, but **full test262 runs happen in CI on the PR**, not in your worktree.

3. [ ] Run issue-targeted local checks
   - Compile+run the specific sample tests from the issue description
   - Run any narrow local tests needed for confidence
   - Do **not** run local full `test262` as part of completion
4. [ ] Record local test results in the issue file

## Finalize

5. [ ] Issue file updated with implementation notes
6. [ ] Issue status set to `in-review` in frontmatter
7. [ ] File locks removed from `plan/method/file-locks.md`
8. [ ] Branch pushed to `origin`
9. [ ] PR opened against `main`
10. [ ] PR is the canonical place for full validation — wait for GitHub Actions `test262` results there

## Terminate after PR open

11. [ ] Write agent-status file with `state: ci-wait, pr: N` so the dispatch loop sees you as in-flight
12. [ ] **Terminate** — the monitor watches CI and auto-merges when green. You do not need to wait.
    - If CI comes back red and needs a fix, the tech lead will respawn you with context from the issue file
    - Do NOT poll ci-status yourself — the monitor owns that

## What NOT to do

- Do NOT open a PR before merging `origin/main` into your branch
- Do NOT wait for CI after opening a PR — terminate immediately
- Do NOT use `git rebase` — use `git merge origin/main` instead
- Do NOT resolve compiler source conflicts (`src/`) inline — create a `[CONFLICT]` priority task for a senior-developer (Opus)
- Do NOT leave uncommitted changes on your branch
- Do NOT treat local full `test262` as part of the normal developer workflow — use the PR workflow instead
