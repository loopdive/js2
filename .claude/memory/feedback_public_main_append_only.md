---
name: feedback_public_main_append_only
description: Never force-push or rewrite published history on the public main branch — it breaks every external clone/fork. Public main is append-only.
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 0ffbd21c-b73d-429a-a76d-4fb742ea9794
---

Public `main` (the open-source repo, loopdive/js2wasm, formerly js2wasm) is **append-only**. Never force-push it, never rewrite its history (no `git push --force`/`--force-with-lease` to main, no rebasing published commits, no history-rewriting subtree/filter operations that change SHAs on the public branch).

**Why:** During the public/private restructure, `origin/main` was force-pushed / rewritten (rollback + subtree splits) and the repo was renamed (js2wasm → js2). That broke external contributor guest271314's clone — on `git pull` they hit "divergent branches" through no fault of their own (their clone kept the old lineage; the remote's was rewritten). For a project courting external contributors, breaking their first `git pull` is a serious own-goal.

**How to apply:**
- All changes to public main go through PRs + the merge queue, which **appends** (safe). The merge queue is fine.
- NEVER run `git push --force*` against public main, and never instruct/allow an agent to. If a bad commit lands, fix it forward with a revert PR, not a history rewrite.
- The only safe rewrite of a published branch is "never" once anyone may have cloned/forked it. Treat published history as immutable.
- If history ever *must* be rewritten (true emergency, e.g. leaked secret), it's a deliberate, announced break: notify watchers/contributors to re-clone, and expect every fork to diverge.
- Local-only sync of a throwaway checkout (e.g. the /workspace container) with `git reset --hard origin/main` is fine — that resets a *local* branch to match remote, it does NOT rewrite remote history. The rule is specifically about pushing rewrites to the public remote.

See also [[feedback_no_github_issue_comments]] (don't mutate user-opened issues without consent) — same theme of not surprising external contributors.
