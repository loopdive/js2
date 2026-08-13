---
name: feedback_mandatory_predispatch_gate_and_lane_partition
description: "Before dispatching ANY agent to an issue, run the pre-dispatch gate (merged-on-main? open-PR? other-lane-claimed?) and stay inside this lane's partition — this prevents the cross-lane duplicate-work waste"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: f3739381-bbf1-4f5c-9036-57a3a6c8eeac
---

User directive (2026-07-18): prevent the duplicated-work hiccups by **partitioning
the queue** between the two lanes. This lane MUST honor two rules.

## 1. Mandatory pre-dispatch gate (run for EVERY dispatch, no exceptions)

Before spawning ANY agent on an issue #N — including a `[CI-FIX]` on someone's
DIRTY PR — verify ALL of:
1. `git log origin/main --grep="#N"` → NOT already merged/fixed.
2. `gh pr list -R loopdive/js2wasm --state open --search "#N"` (and check
   `plan/issues/N-*.md` touched by any open PR) → NO open PR already implements it.
3. `git log origin/issue-assignments --format='%s' | grep N` → NOT claimed by the
   OTHER lane.

Any hit ⇒ do NOT dispatch (adopt/close/route instead). The 2026-07-17 duplication
(#3310/#3311/#3341/#3308 all re-implemented by the fork lane, opus PRs closed as
redundant) happened because this gate was skipped on the initial batch. **Why:**
`claim-issue.mjs` returns exit 0 to both lanes (shared `ttraenkler/senior-dev`
slug), so the lock is advisory — the grep-main + open-PR check is the real gate.
See [[project_dup_prs_upstream_vs_fork_same_branch_name]].

## 2. Stay inside this lane's partition

The queue is partitioned by GOAL (see `plan/method/lane-partition.md`). This lane
(lead + opus) owns: **runtime-eval ladder** (#2927/#2928/#3101/#3308/#3343),
**error-model**, **self-hosting/acorn-dogfood**, **core-semantics**, and ALL
**CI/infra/pipeline/tooling** (baseline, merge-queue, shepherding). Do NOT dispatch
into the fable/porffor lane's goals: **backend-agnostic-ir**, **ir-full-coverage**
(IR north star), **Porffor backend** (#3288 family, `sprint: porffor-backend`),
**value-rep-substrate**, **standalone gap** (#2860). Shared/broad goals
(test262-conformance, spec-completeness, builtin-methods, property/class) are
claim-first-wins — the pre-dispatch gate decides.

**How to apply:** grep-gate before every dispatch; only pull issues whose `goal:`
is in this lane's set (or explicitly `lane: main`); push branches to the `fork`
remote so GitHub rejects any dup PR for free.
