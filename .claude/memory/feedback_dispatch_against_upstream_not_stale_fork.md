---
name: feedback_dispatch_against_upstream_not_stale_fork
description: "Dispatch from upstream/main probes, not stale fork frontmatter; claim handles ≠ agent names"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 54c1df0f-04d4-4026-b675-77fe695fb95c
---

The tech lead's local view in `/workspace` is the **fork** `origin` =
`ttraenkler/js2`, whose `main` runs **far behind** upstream `loopdive/js2wasm`
(measured 1165 commits behind, 0 ahead, on 2026-06-21). PRs merge to
**upstream**, and `scripts/sync-workspace-main.sh` only ff's to the stale
fork `origin/main`, so local plan/issue files rot relative to canonical.

Two compounding traps that caused heavy dispatch thrash:

1. **Issue frontmatter `status:` lags the actual merged code.** An issue
   can read `status: in-progress`/`ready` locally while its headline fix is
   already merged on upstream/main (e.g. #2200 Phase 1 via PR #1764, #2029
   u32-emit crash — both done upstream, both still `in-progress` in
   frontmatter). **Do not dispatch by frontmatter alone.** The reliable
   open/closed signal is a dev **probe against upstream/main** (compile the
   repro on upstream HEAD). Devs are good at this triage; let them
   probe-and-claim a broad pool rather than hand-routing single issues.

2. **Claim-ref handles ≠ agent chat names.** On the `issue-assignments`
   ref, agents claim under arbitrary handles (`dev-conformance`,
   `dev-agent`, `sendev-funcidx`, `cs-2160`) that do **not** match their
   spawned names (dev-carla confirmed she = `dev-conformance`). So an
   assignee you don't recognize is very likely **your own agent**, not
   "another session." Don't infer parallel teams from unfamiliar assignee
   names, and don't `--force`-release a claim as "stale" on that basis —
   freeing it just triggers a re-claim race (this happened with #2160).

**Slice-granular claims for big issues.** Multiple devs gravitate to the
same big bucket issue (#2160, #2029, #2200…) and pick the *same slice*.
Whole-issue claims (`claim-issue.mjs 2160`) do NOT prevent slice
collisions — two agents both holding "2160" can implement the same
sub-fix (happened 2026-06-21: anita + bruno both did #2160
`Number.prototype.toLocaleString`; bruno shipped PR #1806, anita was about
to duplicate). When slicing, claim at slice granularity
(`claim-issue.mjs 2160:<slice-tag>`) so distinct slices hold independent
locks, and the lead should assign distinct slice tags up front.

**How to apply:** (a) `git fetch upstream && git rev-list --count
origin/main..upstream/main` at session start to gauge staleness; read
authoritative statuses via `git show upstream/main:plan/issues/<f>` when it
matters. (b) Give devs a broad candidate pool + "probe upstream first,
claim-first the first with genuine remaining work, note already-done ones."
(c) Treat claim staleness by **process liveness / claim age**, never by
whether you recognize the handle. Related: [[feedback_auto_ff_workspace_main]],
[[feedback_verify_fix_in_git_not_narrative]], [[feedback_tasklist_sync_unreliable]].
