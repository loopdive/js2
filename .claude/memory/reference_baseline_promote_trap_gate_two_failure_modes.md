---
name: reference_baseline_promote_trap_gate_two_failure_modes
description: "Baseline-promote trap-growth ratchet gate has TWO silent failure modes — too-strict (freezes landing number) and too-permissive (one-cycle tolerance var left open banks regressions). gh variable set no-ops in gh 2.23 → use REST PATCH. Watchers can't solely own gate resets; lead backstop is load-bearing."
metadata:
  node_type: memory
  type: reference
  originSessionId: f3739381-bbf1-4f5c-9036-57a3a6c8eeac
---

2026-07-20 landing-page freeze incident — fully diagnosed + fixed.

**The gate:** #3335/#3189 trap-growth ratchet. Two live enforcement points, BOTH read
**repo-level** vars (no environment): (1) merge_group "check for test262 regressions"
(`merge-report`/`regression-gate` in test262-sharded.yml) reads `vars.TRAP_RATCHET_TOLERANCE`
(default 0 = strict, PER-CATEGORY); (2) post-merge promote `write-run-cache-bot` reads
`vars.BASELINE_TRAP_GROWTH_ALLOW`. The `promote-baseline` job (has `environment: baseline-promote`)
is SKIPPED on queue merges, so repo scope is what both live gates read. The change-scoped
frontmatter `trap-growth-allow:` is INERT unless the PR bumps oracle_version (rebaseMode) —
useless for a same-oracle/runner-only PR; the repo VARS are the only lever there.

**Failure mode A — too STRICT (freeze):** a landed PR grows a trap category (e.g. illegal_cast
79→80, one never-passing test changing failure-MODE, not a lost pass) → every `write-run-cache-bot`
promote REFUSES to publish (`REFUSING baseline push`, exit 1) → landing-page number
(`benchmarks/results/test262-current.json` summary) freezes SILENTLY. Hid ~7h (staleness threshold +
`[skip ci]` sync commits). NOT the summary-sync's fault (it's healthy — nothing newer to mirror).
Fix: re-anchor once (set the ALLOW var to cover growth → re-run the failed promote → RESET to 0),
+ fix-forward the real trap regression to return the ratchet, + observability #3442 (ntfy on refusal).

**Failure mode B — too PERMISSIVE (stale open valve):** the one-cycle override vars left non-zero.
A background-bash watcher owning the reset is TOO FRAGILE (queue-merge promote head_sha ≠ PR
mergeCommit oid → run-lookup stays empty; or session lapses mid-~10min promote) → vars stuck at 25
after the PR merged. Then ANY later PR banks trap regressions silently. Caught only by the lead
re-checking the var values. **Lead backstop is load-bearing — never let a watcher SOLELY own a
time-critical gate reset.** Needs its OWN alert (companion to #3442): scheduled workflow, ntfy if
either trap var > 0 beyond a grace window. #3442 (mode A) does NOT catch mode B — opposite modes.

**Tooling quirks (gh 2.23, container):** `gh variable set` SILENTLY no-ops — use REST:
`gh api -X PATCH repos/<o>/<r>/actions/variables/<NAME> -f name=<NAME> -f value=<V>`; read with
`gh api .../actions/variables/<NAME> --jq .value`. Also `gh pr edit --add-label`/`--remove-label`
silently fail (deprecated Projects-classic GraphQL path) — to keep a PR out of the queue use
DRAFT (`gh pr ready --undo <N>`), reliable; see [[reference_gh_remove_label_rest_not_pr_edit]].

Applied to #3430 (#3441 ~2069-flip runner PR; +28 collateral traps null_deref+19/oob+9 from
UNMASKED pre-existing TypedArray gaps, +647 net, zero pass-loss): both vars→25 (per-category),
landed → 68.43%, backstop-reset to 0, fix-forward #3488.

See [[reference_host_restore_triage_verify_first_measure]], [[reference_baseline_gates_need_postmerge_autorefresh]].
