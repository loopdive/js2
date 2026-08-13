---
name: project_fork_headed_pr_push
description: "Updating a fork-headed PR's branch needs a gh-credential push to the fork, not origin"
metadata: 
  node_type: memory
  type: project
  originSessionId: 75ffdde9-6b72-447e-992f-f6b025616c19
---

Some js2wasm PRs are **fork-headed**: the PR's head branch lives on the
`ttraenkler/js2` fork (`headRepositoryOwner: ttraenkler`), NOT on `origin`
(`loopdive/js2wasm`). When resolving a conflict / pushing a branch update for such
a PR, a plain `git push origin HEAD:<branch>` lands a **stray branch on loopdive**
and does NOT update the PR (verified on PR #1765, 2026-06-19 — created then deleted
the stray origin branch).

**How to push to a fork-headed PR branch:** the `fork` remote is HTTPS
(`https://github.com/ttraenkler/js2.git`) with no ambient creds, so use gh's
credential helper:

```
git -c credential.helper='!gh auth git-credential' push --no-verify fork HEAD:<branch>
```

(`gh` is authed as `ttraenkler` for https.) Confirm with
`gh pr view <N> -R loopdive/js2wasm --json headRepositoryOwner` BEFORE pushing — if
owner is `ttraenkler`, push to `fork`; if `loopdive`, push to `origin`.

To fetch a fork-headed PR locally when the branch name isn't resolvable on origin:
`git fetch origin pull/<N>/head:<local-branch>`.

**Why:** saves the detour of a stray-branch push + cleanup. See
[[feedback_explicit_main_push]] for the related main-push discipline.
