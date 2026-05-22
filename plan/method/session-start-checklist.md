# Session Start Checklist (Tech Lead)

**Read this at the beginning of every session.**

## Effort level

0. [ ] Set `/effort max` — tech lead must use maximum reasoning effort

## Environment check

1. [ ] `pwd` — must be `/workspace`
2. [ ] `git branch --show-current` — must be `main`
3. [ ] `git status` — working tree should be clean. If dirty, review changes before proceeding.
4. [ ] `git stash list` — should be empty. If not, investigate what's stashed and why.
5. [ ] `free -m` — check available RAM. Need ~4GB free before spawning agents.

## Orphan check

6. [ ] `ls .claude/worktrees/ 2>/dev/null` — check for leftover worktrees from previous sessions
7. [ ] For each worktree: `git -C <wt> diff --stat` and `git -C <wt> log --oneline main..HEAD` — check for unmerged/uncommitted work
8. [ ] `ps aux | grep -E 'tsx|vitest|node.*agent' | grep -v grep` — check for zombie processes
9. [ ] Kill zombies, clean up merged worktrees, save any unmerged work to issue files

## State check

10. [ ] Read `MEMORY.md` — check for stale entries, update if needed
11. [ ] Read `plan/log/dependency-graph.md` — check what's ready to work on
12. [ ] Check `plan/issues/` for any issues with `status: suspended` — these have unfinished work
13. [ ] Read last session's notes in `project_next_session.md` memory file

## Background watchers

14. [ ] **Start the PR-drift mention poller** — Monitor that watches for new
    PR comments tagging `@claude` (drift events from `pr-drift-detect.yml`).
    The poller uses a state file so it catches up on events missed while no
    session was running — start at session boot every time.
    ```
    Monitor:
      description: "PR drift @claude mentions — dispatch agent on each"
      persistent: true
      command: INTERVAL_SECS=60 STATE_FILE=/tmp/poll-pr-mentions-state bash /workspace/scripts/poll-pr-mentions.sh 2>&1
    ```
    Verify with `TaskList` that exactly one `poll-pr-mentions` Monitor is running.
    If a previous session's Monitor is still in the list (zombie), `TaskStop`
    it before starting a fresh one — duplicate pollers double-dispatch.
    See `plan/method/pr-drift-protocol.md` for what to do when an event fires.

## Before starting a new sprint

14. [ ] **Check previous sprint is fully closed** — run the deterministic check:
   ```bash
   node scripts/check-sprint-closed.mjs <N-1>
   ```
   Must exit 0 (all ✅) before starting a new sprint. If it exits 1, run `/sprint-wrap-up` and fix the failing items, then re-run the check.

15. [ ] **Review stale/orphaned work**: check for unmerged branches, old worktrees, suspended issues, stale tasks. Report to user and ask before cleaning up.
   - Unmerged branches: `git branch | grep -v main`
   - Orphan worktrees: `git worktree list`
   - Suspended issues: `grep -l "status: suspended" plan/issues/*.md`
   - Stale task list: check if previous sprint's tasks are resolved
16. [ ] **Smoke-test candidate issues**: for each issue you plan to dispatch, compile 1-2 sample test files from the issue description against current main. If they pass, close the issue — it's already fixed.
17. [ ] Shut down all dev agents before running final test262 with multiple forks
