---
id: 4044
title: "`correctness-support-sanitizers` is not a required check — it caught wrong codegen (saturate-vs-wrap) that the equivalence shards missed"
status: ready
sprint: current
created: 2026-08-02
updated: 2026-08-02
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: infrastructure
area: ci
language_feature: n/a
goal: dogfood
---
# `correctness-support-sanitizers` is not a required check — it caught wrong codegen (saturate-vs-wrap) that the equivalence shards missed

> Filed 2026-08-02 from a TaskList entry that had been carrying the full
> analysis but no issue file. The body below is the original measurement
> report, verbatim — it was written by the agent that did the measuring.

Found 2026-07-28 on PR #3719. A concurrent lane pushed commit `5ae831199` ("#3745: IR-native i32-pure-bitwise fast path", 5 files, +400/−13, no tests) which emits `i32.trunc_sat_f64_s` (SATURATING) where JS `ToInt32` must WRAP modulo 2^32.

**The defect is a soundness bug in the precondition proof, not just the emission.** `computeI32PureNames` classifies fib's int32-overflowing accumulator as "i32-pure", so the commit's claim of "bit-for-bit identical under the precondition" is falsified — the precondition analysis itself is unsound. Saturation and wrapping agree only while values stay in int32 range, which is exactly what an overflowing accumulator violates.

**Observed:** four-lane fib probe returned `[0,1,2147483647,2147483647]` vs expected `[0,1,-1846256875,-1821818939]`. `2147483647` = INT32_MAX is the saturation fingerprint.

**Attribution (revert-verified, gold standard):** sanitizers green on `6c721de93`, red on `b7c707be1`, sole delta is `5ae831199`.

**THE GAP — this is the actionable part:**

1. **`correctness-support-sanitizers` is NOT in the required-checks list** (`docs/ci-policy.md` §7). So a PR can be `CLEAN`/mergeable with this check red.
2. **The equivalence shards did NOT catch it.** Only the four-lane fib probe inside the sanitizer did. So the required gates are blind to this class.
3. Consequence: **silent runtime-value corruption can ride a fully-green PR into the `merge_group`** — and the merge_group's test262 gates may or may not surface it depending on corpus coverage. #3687 demonstrated the adjacent failure mode at 302 tests the same night.

**Proposed work:**
- Decide whether `correctness-support-sanitizers` should be promoted to a required check. If it is too slow/flaky for PR level, consider running it in the `merge_group` alongside the other real gates rather than leaving it advisory everywhere.
- Add a wrap-vs-saturate regression test to the equivalence suite so the required lane is not blind to it — an overflowing int32 accumulator is a two-line repro.
- Separately: any future `i32.trunc_sat_*` fast path needs an explicit wrap-vs-saturate proof and tests before landing. Consider a lint/grep gate on new `trunc_sat` emission sites in the ToInt32 path.

**Do not conflate with the #3719 PR itself** — that PR's own work (string-hash IR migration) was measured green on quality, equivalence and sanitizers at `6c721de93`; the defect arrived from a different lane pushing onto its branch. The revert restores a byte-identical proven-green tree.
