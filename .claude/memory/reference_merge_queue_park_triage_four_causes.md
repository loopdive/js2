---
name: reference_merge_queue_park_triage_four_causes
description: Auto-park comments are identical regardless of cause. Four distinct causes seen in one day; how to tell them apart — including the jobs-API pagination trap that hides the failing job entirely.
metadata: 
  node_type: memory
  type: reference
  originSessionId: 417b718f-2c4e-4164-9782-006e2e33f7ff
  modified: 2026-07-24T23:32:30.462Z
---

**An `auto-park-bot:merge-group-failure` comment does NOT tell you whether the park is real.**
On 2026-07-24/25 FOUR PRs parked, with only two distinct comment texts between them:

| PR | Comment said | Actual cause | Verdict |
|---|---|---|---|
| #3566 | `check for test262 regressions` | artifact download **403** — verdict step SKIPPED | **bogus** (merged after unpark) |
| #3563 | `check for test262 regressions` | real uncatchable trap, `null_deref` +1 (#3189 ratchet) | **genuine** |
| #3581 | `quality` | duplicate issue id (#1616 integrity gate) | **genuine, trivial** |
| #3583 | `check for test262 regressions` | Temporal `skip → compile_error` churn | **drift** |

#3566 and #3563 had **textually identical** comments and opposite truths.

## Triage procedure

1. **Find the run** — `gh run list` on gh 2.23 has **no `--event` flag**. Use REST:
   `gh api "repos/loopdive/js2wasm/actions/runs?event=merge_group&per_page=40"` and filter
   `.head_branch` on `pr-<N>`.
2. **THE PAGINATION TRAP — this will fool you.** The jobs API caps at `per_page=100`, and a
   test262-sharded run has **114 jobs** (72 host + 34 standalone shards + others). Querying
   `…/jobs?per_page=100` returned **zero failures** for #3583 — every job `success` or
   `skipped` — while the run conclusion was `failure`. The failing job was on **page 2**.
   Always check `.total_count` and paginate, or you will conclude "no failing job" and
   mis-diagnose the park entirely.
3. **Get the failing STEP, not just the job** —
   `gh api ".../jobs?per_page=100&page=N" --jq '.jobs[]|select(.conclusion=="failure")|{name,id,failed_steps:[.steps[]|select(.conclusion=="failure")|.name]}'`.
   - failed step = **"Download shard artifacts"** ⇒ infra; the verdict never ran ⇒ **bogus park**
   - failed step = **"Fail on regressions"** ⇒ the verdict RAN ⇒ real gate output, keep going

## Real-regression vs drift, once the verdict did run

- **Read the gate's own staleness signal.** `CONTENT_CURRENT=true` / `SRC_BEHIND=0` ⇒ the
  baseline reflects current src, so a failure is **likely-real** (this is why #3563 was
  accepted as genuine). `CONTENT_CURRENT=false` with `SRC_BEHIND>0` ⇒ drift is admissible
  (#3583: SRC_BEHIND=3).
- **Ask whether the PR's mechanism can even produce the observed transition.** #3583 changes
  top-level `throw` collection in codegen; it cannot un-skip Temporal tests. A
  `skip → compile_error` transition is a runner/skip-filter concern.
- **Look for the same signature on other PRs and on the main promote job.** Temporal
  `skip → compile_error` churn appeared on #3563's run, #3583's run, AND the concurrent main
  promote — that breadth is the drift tell.
- **Weigh net.** #3583: 26 regressions vs 40 improvements, net +14, wasm-identical noise 0.

## Rules that still bind

Never clear a hold without diagnosing the cited run (a). Never clear in a loop — **once**,
then let the next `merge_group` re-validate (d). State the falsifier: if it re-parks with the
SAME signature it is drift again; a DIFFERENT signature means the read was wrong.
A held PR is skipped by auto-enqueue, so it **strands** until a human acts (e).

Related: [[reference_baseline_promote_trap_gate_two_failure_modes]],
[[reference_verdict_logic_change_must_bump_oracle_version]],
[[reference_cross_session_issue_id_collision_renumber_loser]].
