---
id: 1897
slug: ci-standalone-regression-gate
title: "Gate merges on standalone test262 regression"
status: done
sprint: 61
goal: standalone-mode
area: ci
priority: high
feasibility: hard
created: 2026-06-05
owner: sd-ci-gate
claimed_by: codex-developer
claimed_at: 2026-06-06T09:10:00.109Z
updated: 2026-06-06
completed: 2026-06-11
pr: 1245
---

# ci: gate merges on standalone test262 regression

## Problem

The merge queue only gates the **default (js-host / gc)** test262 lane. The
**standalone** lane runs in the same sharded matrix (`test262-sharded.yml`,
57 chunks × 2 targets) and its merged report is built, but **nothing fails
the merge when the standalone pass-count regresses**. Standalone conformance
is measured *post-merge* by the `promote-baseline` job, which is non-gating.

The cost of this gap is concrete: a #1196 merge regressed standalone by
~1,800 passes (+5,582 `compile_error`) and slipped straight through because
the only hard, required guard inside `merge shard reports` — the
catastrophic-regression guard (#1668) — diffs **only the host lane**
(`test262-current.jsonl`). Standalone went from ~28-29% to 24.76% (10,676
pass) with a green merge queue.

## Root-cause analysis

`merge shard reports` (the required check) already:

1. Merges the 57 standalone shard artifacts into
   `merged-reports/test262-standalone-results-merged.jsonl`.
2. Builds `merged-reports/test262-standalone-report-merged.json`
   (`--target standalone`).

…but the two HARD guards that live inside the required check (the #1668
catastrophic-regression guard and the stale-baseline guard) only ever look
at the **host** JSONL. There is no standalone analog. The advisory
`regression-gate` job also diffs host-only and is not required anyway.

So the standalone merged JSONL is produced and then **discarded** for gating
purposes. Closing the gap is a *diff + fail* step, not new infrastructure.

## Design

### Where the gate lives — inside the existing required check

Add a **standalone net-regression guard step** to the `merge shard reports`
job, immediately after "Build merged standalone test262 report" and beside
the host catastrophic guard (#1668). This is deliberate:

- `merge shard reports` is **already a required check** on the merge queue.
  A failing step inside it fails the required check, so the gate is enforced
  on `merge_group` **with zero branch-protection changes**. No new
  required-check name has to be registered (and no admin creds needed to
  apply branch protection).
- The standalone shards **already run in parallel** with the host shards in
  the same matrix — sharding for speed is reused for free; the gate adds no
  CI compute beyond one fast `diff-test262.ts` invocation.
- It mirrors the host catastrophic guard's pattern exactly, so the location
  is consistent and well understood.

This is the answer to the "make it required" requirement: rather than add a
*new* required job (which would need a branch-protection admin push and would
duplicate the standalone shard run), we **extend the existing required check
to also gate standalone**. `docs/ci-policy.md` §1/§7 are updated so the
required check's responsibility is documented, and a short note in
`scripts/enable-branch-protection.sh` records that no new context is needed.

### What it compares — the standalone baseline floor

`scripts/diff-test262.ts` is already **target-agnostic** — it keys on the
`file` field line-by-line and computes regressions/improvements/net. Verified
it runs unmodified on the standalone JSONL (self-diff → net 0; perturbed
diff → correct regression/improvement/CT split). So the guard diffs:

```
baseline:  /tmp/cat-baselines/test262-standalone-current.jsonl   (baselines repo)
candidate: merged-reports/test262-standalone-results-merged.jsonl (this run)
```

The baselines clone is reused from the host catastrophic-guard step (same
job, same runner, `/tmp/cat-baselines` persists across steps).

Because the baseline is the **moving** standalone floor maintained by
`promote-baseline` on every push to main, the gate **holds whatever floor
standalone is currently at**:

- A PR that does not touch standalone → net 0 → passes.
- A PR that *improves* standalone → net > 0 → passes.
- A PR that *regresses* standalone below tolerance → net < −tol → **fails**.

This is exactly the timing requirement: it must NOT block the in-flight
standalone-fix PRs while standalone is still at 24.76%. It compares against
the *current* baseline floor, not an absolute target. Once sd-1888's fix
lands and `promote-baseline` refreshes the baseline upward, the gate holds
the new, higher floor. (The gate should land **after** the regression is
fixed so the floor it pins is the restored ~28-29%, not the regressed
24.76%.)

### Flake tolerance — net-per-test, not exact equality

The known standalone flake is `compile_timeout` under CI load (tests near
the 30s compile boundary flapping with runner load). `diff-test262.ts`
already excludes `compile_timeout` transitions from its
`Regressions with wasm-hash change` count, so the guard reads that filtered
line:

```
net = improvements − regressions_with_wasm_hash_change
```

and fails when `net < −STANDALONE_REGRESSION_TOLERANCE`. The tolerance
(default **15**) absorbs residual baseline drift (corpus-version skew,
`env::`-import nondeterminism). Measured real run-to-run standalone drift
between two consecutive baseline snapshots was **0 regressions / +3
improvements**, so 15 is comfortably above the noise floor while still
catching the ~1,800-pass class of regression this issue exists to stop.

The compile_timeout flake is excluded *structurally* (by the diff script),
not by the tolerance — the tolerance only covers drift, matching the host
gate's philosophy.

## Acceptance criteria

- [x] A guard step inside the required `merge shard reports` job diffs the
      merged standalone JSONL against the standalone baseline and fails the
      check on net-negative standalone regression beyond tolerance.
- [x] Sharded (reuses the existing 57-chunk standalone matrix — no extra run).
- [x] `compile_timeout` flake excluded; tolerance covers drift only.
- [x] Skips cleanly on the no-shards merge_group path (`SHARDS_RAN != true`)
      and when the standalone baseline is not yet seeded (first run).
- [x] `docs/ci-policy.md` documents that `merge shard reports` now also
      gates standalone; `scripts/enable-branch-protection.sh` notes no new
      required context is needed.
- [x] No new branch-protection admin action required (the gate rides the
      already-required `merge shard reports` check).

## Notes for the merge queue / timing

This gate pins the *current* standalone baseline floor. It is safe to land
while standalone is below target as long as the regression that dropped it
to 24.76% has been restored first (sd-1888), so the floor it holds is the
restored value. The gate never blocks an improving PR.

## Codex implementation note

2026-06-06: Verified the standalone guard is wired inside the required
`merge shard reports` job and added `tests/issue-1897.test.ts` to lock the CI
contract:

- guard order: after the merged standalone report is built, before stale
  baseline validation;
- guard inputs: `test262-standalone-current.jsonl` vs
  `test262-standalone-results-merged.jsonl`;
- guard decision: `improvements - wasm-changing regressions` with
  `compile_timeout` counted only as excluded flake; and
- policy docs / branch-protection script: standalone rides the existing
  `merge shard reports` required context, so no new required check is needed.

Scoped validation:

- `pnpm test tests/issue-1897.test.ts`
- `pnpm exec biome lint tests/issue-1897.test.ts --diagnostic-level=error`
- `pnpm exec prettier --check tests/issue-1897.test.ts`
