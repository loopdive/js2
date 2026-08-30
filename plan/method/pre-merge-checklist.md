# Pre-Merge Checklist

**Read this before merging to main.**

## Dev self-merge via PR (standard path)

Devs do NOT do a direct ff-only merge to main. Instead:

1. [ ] `git fetch origin && git merge origin/main` on your branch (before opening PR)
   - Planning conflicts → `git checkout --theirs` + regen
   - Compiler source conflicts → dispatch to `senior-developer` (Opus) via priority TaskList item
2. [ ] Run scoped local checks (issue-specific compile+run)
   - ⚠ Local `quality`-style validation on Node ≤ 22 can show a **phantom red
     main**: the guard-suite generator-resume path (`__gen_resume___closure_*`
     `RuntimeError: unreachable`) is engine-version-dependent — fails on Node
     20/22, passes on CI's Node 25 (#3481, 2026-08-27). Before diagnosing a
     "red on main" locally, check `node --version` against CI's.
3. [ ] `git push && gh pr create`
4. [ ] Monitor `.claude/ci-status/pr-<N>.json` until SHA matches HEAD
5. [ ] `net_per_test > 0`: `gh pr merge <N> --auto` (enqueues — NO `--merge`/strategy flag; the queue owns the strategy and rejects `--merge --auto`; queue re-runs checks against merged state then lands)
6. [ ] Escalate to tech lead if: regressions > 10, single bucket > 50, or judgment call needed

## Tech lead direct merge (fallback / hotfix only)

Only used when bypassing PR flow is explicitly approved.

### How ff-only works with merge commits

Your branch has merge commits from `git merge main` — that's normal. **ff-only still works** as long as your branch tip includes main's HEAD as an ancestor.

If ff-only fails: main moved since your last `git merge main`. Just merge main again and retry. **Never rebase.**

### Before merging to main

1. [ ] You are in `/workspace` on `main`: `pwd && git branch --show-current`
2. [ ] You already merged main into your branch: `git merge main` (on your branch)
3. [ ] You ran equiv tests ON YOUR BRANCH (not on main) — **only required if the branch touches compiler source** (`src/`). UI-only changes (HTML, CSS, landing page, report page, dashboard, `scripts/`, `components/`) skip equiv tests.
4. [ ] Test proof exists: `.claude/nonces/merge-proof.json` (hook validates this) — **skip for UI-only branches** (no `src/` changes)
5. [ ] Merge: `git merge --ff-only <branch>`
6. [ ] If ff-only fails: go back to your branch, `git merge main` again, recreate proof, retry

## After merging

7. [ ] `git diff HEAD~1 --stat` — no unexpected deletions
8. [ ] Update issue frontmatter: `status: done` and `completed: YYYY-MM-DD`
9. [ ] Update `plan/log/dependency-graph.md`
10. [ ] **Refresh all open PR branches** — for every remaining open PR, merge origin/main into its branch and push so the quality gate doesn't fail and branches stay close to main:
    ```bash
    gh pr list --state open --json number,headRefName --jq '.[].headRefName' | while read branch; do
      wt="/workspace/.claude/worktrees/$branch"
      if [ -d "$wt" ]; then
        git -C "$wt" merge origin/main --no-edit && git -C "$wt" push origin "$branch" \
          && echo "refreshed $branch" || echo "CONFLICT on $branch — ping dev"
      else
        echo "no worktree for $branch — create one or ask dev to refresh"
      fi
    done
    ```
11. [ ] Message tech lead: `"Merged #N to main. Refreshed open PR branches."`

## If something went wrong

- `git reset --hard HEAD~1` to undo (only if not pushed)
- **Never** manually patch files on main
