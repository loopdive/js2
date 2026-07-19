---
id: 3447
title: "ci(test262): make the #1942 compile-timeout count guard contention-tolerant"
status: done
completed: 2026-07-19
sprint: current
priority: high
horizon: s
task_type: ci
area: ci
goal: maintainability
---

# ci(test262): make the #1942 compile-timeout count guard contention-tolerant

## Problem

`.github/workflows/test262-sharded.yml` has the "Compile-time regression guard
(#1942)" step. It failed when the `pass → compile_timeout` COUNT `CT` exceeded a
flat threshold (`CT > 50 ⇒ fail`). That count is priced by runner CPU
contention, not by real compile-perf regressions: it **false-ejected PR #3365
from the merge queue TWICE**, both times with `CT > 50` while the aggregate
compile-time Δ was only **+3.2%**. A genuine regression that pushes >50 tests
past the 30s per-test timeout cannot leave the aggregate that flat — real
slowdowns move BOTH the count and the aggregate; contention moves only the
count.

Reference: `plan/ci-acceleration-review.md` §5-B (lever L2 / spec B).

## Fix (acceptance criteria)

Replace the flat count trigger in the guard step with:

1. **Fail** only on `(CT > CT_SOFT AND aggregate Δ > +10%)` — both signals must
   agree. `CT_SOFT = 50`.
2. **Fail** unconditionally on `CT > CT_HARD` (`= 200`, ~boundary-population
   scale). Closes the survivor-bias hole: a pathological slowdown times out its
   victims, removing them from the both-compiled shared set, so the aggregate
   can stay flat while the count spikes into the hundreds.
3. `CT_SOFT < CT ≤ CT_HARD` with a flat aggregate ⇒ emit `::warning` + write the
   count into `$GITHUB_STEP_SUMMARY`, do **not** fail (the #3365 contention
   regime).
4. Leave the existing aggregate **+20%** arm UNCHANGED (standalone systemic
   backstop).
5. Document the `CT_SOFT` derivation (25 × 114/59 ≈ 48 → 50) so future matrix
   changes have the rationale.
6. In-workflow comment documents the thresholds + the #3365 double-ejection
   evidence (CT>50 at Δ=+3.2% twice) so the rationale is durable.

## Verification (arithmetic dry-run)

- #3365 contention case (CT≈55, Δ=+3.2%): `CT>200` no; `CT>50 && 3>10` no →
  warning path; `3>20` no → **does NOT fail**. ✓
- Real pathological regression (CT=300): `CT>200` → **fails** via CT_HARD. ✓
- Real regression, both signals (CT=80, Δ=+15%): `CT>50 && 15>10` → **fails**. ✓
- Systemic slowdown, low CT (CT=10, Δ=+25%): standalone `25>20` → **fails**. ✓

CI-workflow-only change; no `src/` touched.
