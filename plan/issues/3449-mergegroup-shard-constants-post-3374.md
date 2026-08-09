---
id: 3449
title: "ci(#3431 follow-up): re-derive merge_group shard constants from post-#3374 timings"
status: done
completed: 2026-07-24
sprint: 76
created: 2026-07-19
updated: 2026-07-24
priority: medium
horizon: s
feasibility: easy
reasoning_effort: low
task_type: ci
area: ci
language_feature: n/a
goal: maintainability
depends_on: [3431]
---

# Re-derive merge_group shard constants from post-#3374 timings (L6 / Spec C)

Implements lever **L6** from `plan/ci-acceleration-review.md` (§3-L6, §5-C).

## Problem (measured)

`scripts/gen-test262-mg-matrix.mjs:51-52` currently hard-codes:

```js
JS_HOST_CHUNKS   = 40
STANDALONE_CHUNKS = 19
```

These constants were scaled from **pre-#3374** timings (57-way: host 13.6 min,
standalone 5.8 min), so the split was correct when the js-host lane was the long
pole. **#3374** (issue #3433, memoized quadratic scans, 2.6–3.8× faster harness
compiles) inverted that relationship:

- post-#3374 57-way numbers: host **6.7** / standalone **5.4** min — near-parity.
- first live **59**-job merge_group run (`29666753663`) shows host max **~10.9 min**
  (40-way) but standalone **~13–15 min** (19-way) — **standalone is now the
  inverted long pole**, and `merge_group` cannot finish until the slowest shard
  does.

So at 40/19 the two lanes finish minutes apart, wasting the tail. Re-derive so
both lanes finish together.

Note: **#3438** re-derived the **57-way per-lane WEIGHT maps** from post-#3374
timings, but did **NOT** touch these merge_group CHUNK count constants — they are
distinct (weight maps balance *within* a lane; the chunk counts set *how many*
shards each lane splits into). This issue is the merge_group-specific follow-up.

## Approach

Re-derive `JS_HOST_CHUNKS` / `STANDALONE_CHUNKS` from ≥1 completed post-#3374
merge_group run so both-lane max lands within ~1 min of each other and ≤ ~18 min.
Candidate splits from the review:

- host ≈ **30** / standalone ≈ **24** (≈12.7 / 12.8 min avg, 54 jobs), or
- host ≈ **24** / standalone ≈ **20** (≈16 / 15.4 min, 44 jobs — −25 % more
  contention win at a slightly higher tail).

Update the evidence table in the `gen-test262-mg-matrix.mjs` header (it currently
cites only pre-#3374 numbers).

## Sequencing

If this change **increases shard density**, sequence it AFTER the guard-tolerance
fix (#3447 / L2 — make the #1942 compile-timeout count guard contention-tolerant).
Higher density raises per-shard boundary-compile pressure, and until the count
guard AND-gates on the aggregate signal, a denser matrix could re-trigger a false
ejection. With #3374 landed the 25-min cap already has 10+ min headroom, so the
density itself is safe; the guard interaction is the only ordering constraint.
`#3447` is not yet on `main`; it is referenced here in prose rather than
`depends_on` to keep the dependency graph clean until it lands.

## Acceptance criteria

1. `JS_HOST_CHUNKS` / `STANDALONE_CHUNKS` re-derived from ≥1 completed post-#3374
   merge_group run (e.g. `29666753663`), with both-lane max within ~1 min of each
   other and ≤ ~18 min.
2. Evidence table in `scripts/gen-test262-mg-matrix.mjs` header updated with the
   post-#3374 numbers (replacing the stale pre-#3374 citations).
3. Change sequenced AFTER #3447 (guard tolerance) if it increases density.
4. No change to the `merge shard reports` required-context semantics.

## References

- Review: `plan/ci-acceleration-review.md` §3-L6, §5-C, §2.4.
- #3431 (114→59 mg shard consolidation), #3374/#3433 (compile speedup),
  #3438 (57-way weight-map rebalance — distinct from these chunk counts).

## Reconcile → DONE (false-ready, 2026-07-24, dev-std-4)

Landed (uncited) in `9761b20` — "perf(ci): saturate the serial merge queue":
re-derived the merge_group shard constants from production lane timings
(72 host / 34 standalone shards), replacing the stale five-group contention
assumptions with the live serial-queue capacity contract. Touched
`.github/workflows/test262-sharded.yml`, `scripts/gen-test262-mg-matrix.mjs`,
`tests/issue-3431-mg-matrix.test.ts` — exactly this issue's ask. The commit did
not cite #3449, so the status stayed `ready` (false-ready). Marking `done`.
