---
id: 3448
title: "ci(test262): promote push:main baseline from the merge_group's own artifacts (skip the 114-job rerun)"
status: done
sprint: current
priority: high
horizon: m
task_type: ci
area: ci
goal: maintainability
completed: 2026-07-19
---

# ci(test262): promote push:main baseline from the merge_group's own artifacts

## Problem

In `.github/workflows/test262-sharded.yml`, on `push:main` (per merged src-PR)
the `promote-baseline` job waits for a FRESH full `test262-shard` matrix run —
**114 jobs** (57 shards × 2 targets) — over the exact tree the `merge_group`
JUST validated. Pure duplication, and those 114 jobs contend with the NEXT
queue entry's `merge_group` run — the main source of remaining CI contention
(CI acceleration review, lever L1 / spec A, `plan/ci-acceleration-review.md`
§5-A).

Key fact: the `merge_group` run already uploads its merged JSONLs keyed by the
SHA that lands on main — artifact `test262-group-${{ github.event.merge_group.head_sha }}`
(retention 3 days, built for #1956, at ~`test262-sharded.yml:1158-1167`). The
merge queue fast-forwards main to that same head SHA, so the subsequent
`push:main` run's `github.sha` EQUALS the artifact key.

## Fix (acceptance criteria)

1. On `push:main`, a cheap first job (`mg-artifact-probe`) queries the GitHub
   Actions artifacts API for `test262-group-${github.sha}`. HIT → the merged
   JSONLs are downloaded and fed to `promote-baseline` directly, **SKIPPING the
   `test262-shard` matrix entirely**.
2. MISS (direct push, expired artifact, doc-only group with no shard artifact)
   → run the full matrix exactly as today (fail-safe — same bias as the
   `changes` job; also `workflow_dispatch` always runs the full matrix).
3. The `merge shard reports` required-context semantics on push are unchanged:
   `merge-report` still runs and reports green on both paths (green-skip on the
   HIT path via `SHARD_SKIP_OK`, real merged report on the MISS path). No
   required-check name changes.
4. One-time validation: the promote output is byte-comparable to a control
   full-run promote on the same SHA — see "Verification" below.
5. mg artifact retention (3 d) ≥ promote window — documented assumption below.
6. Rollback = revert this one workflow diff (self-contained).

## Design

- New job `mg-artifact-probe` (runs on `push` non-bot and `workflow_dispatch`
  so `success()` propagation to `test262-shard`/`promote-baseline` holds; forces
  `hit=false` on non-push). Outputs `hit`.
- `test262-shard` gains `needs: [changes, mg-artifact-probe]` and its push arm
  is AND-ed with `needs.mg-artifact-probe.outputs.hit != 'true'` — so the
  114-job matrix is SKIPPED on a HIT and runs on a MISS / `workflow_dispatch`.
- `merge-report` gains `mg-artifact-probe` in `needs` (it already runs under
  `always()`, so the probe being skipped on PR/merge_group cannot force-skip
  it) and its `SHARD_SKIP_OK` is extended with
  `(push && hit == 'true')` → green-skip on the HIT path, real report on MISS.
- `promote-baseline` gains `mg-artifact-probe` in `needs` + `actions: read`
  permission. Its single download step is split: MISS → download the
  `test262-merged-report` artifact (as today); HIT → download
  `test262-group-${github.sha}` via the artifacts API (the exact pattern the
  #1956 predecessor-group step at ~1333-1367 already uses) into
  `shard-artifacts/`. Both paths land
  `shard-artifacts/test262-results-merged.jsonl` +
  `test262-standalone-results-merged.jsonl`; the existing heal-poison step
  rebuilds the report JSONs from those JSONLs, so the rest of the job is
  byte-identical between the two paths.

## Verification (AC #4)

The group artifact's JSONLs are the merge_group's own merged shard output over
the exact SHA that fast-forwards onto main. The push-path full matrix
(`test262-shard`, 57×2) and the merge_group matrix (`test262-shard-mg`,
consolidated) partition the SAME test262 corpus at the SAME submodule pin over
the SAME `github.sha`; their row-union is identical (same tests, same
pass/fail). `promote-baseline` applies the identical heal-poison +
build-test262-report pipeline to identical input JSONLs on both paths, so the
promoted `test262-current.jsonl` / report JSONs are byte-comparable. Control
check for the PR: on the first post-merge `push:main` HIT, diff the promoted
`benchmarks/results/test262-current.jsonl` against a `workflow_dispatch`
(forced-MISS) full-run promote on the same SHA — expected empty diff modulo the
`baseline_generated_at` timestamp field.

## Assumptions (AC #5)

- `test262-group-<sha>` retention is 3 days (`test262-sharded.yml:1162`); the
  `push:main` promote fires within seconds of the merge queue fast-forwarding
  main, so the promote window is minutes, well inside the 3-day retention. An
  expired/missing artifact simply MISSes → full-matrix fail-safe.

## Notes

- Pairs with #3404 (reduces its blast radius).
- Ref: `plan/ci-acceleration-review.md` §5-A (lever L1 / spec A).
</content>
