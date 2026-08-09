---
id: 3056
title: "Standalone numeric assertions are vacuous — add `assert_sameValue_num` harness routing (measurement re-baseline)"
status: blocked
sprint: Backlog
model: opus
created: 2026-07-05
updated: 2026-07-12
priority: high
horizon: m
feasibility: medium
task_type: measurement-integrity
area: test-harness
language_feature: test262-runner, standalone-floor
goal: standalone-mode
blocked_by: [3055]
related: [3054, 3055]
# NOT auto-pickable: human-gated. Do NOT land under the autonomous loop — this
# re-baselines the headline standalone floor and needs HUMAN sign-off + a
# coordinated standalone-floor re-baseline (refresh test262-current.jsonl in
# loopdive/js2wasm-baselines). Land after/with #3055 (the real codegen fix).
# status: blocked removes it from `budget-status --pick` (two prior mis-claims).
---

# #3056 — Standalone numeric assertions are not enforced (vacuous host_free_pass)

## Summary

The **standalone lane does not enforce NUMERIC equality assertions**. A test whose
only failing assertion is numeric (`assert.sameValue(x, y)` with number operands)
is scored **pass** in standalone even when the assertion is FALSE — it "passes"
merely by compiling + running to completion without an uncaught trap. **String**
and **boolean** assertions ARE enforced. So a large fraction of numeric-heavy
standalone "passes" (TypedArray / DataView / ArrayBuffer / Number / Math — nearly
all assert on numbers) are **vacuous**, and the headline standalone
`host_free_pass` floor % overstates real numeric conformance.

## Reproduction (through the real `wrapTest`, `--target standalone`)

- `assert.sameValue(1, 2)` → standalone `test()` returns **1 (PASS)**; host returns
  **2 (FAIL)**.
- `assert.sameValue("a","b")` → **2 (FAIL)** in BOTH lanes (strings enforced).

## Mechanism (pinpointed)

`tests/test262-runner.ts`:

- Numeric `assert.sameValue` → `assert_sameValue(actual: any, expected: any)`
  (~:1577) → `isSameValue(a: any, b: any)` (~:1571) → `a === b`. In standalone,
  that boxed-number `any === any` miscompiles (**root cause: #3055**) so `__fail`
  is never set → `test()` returns 1 → scored pass.
- String / bool asserts DODGE it: `wrapTest` routes them to TYPED specializations
  `assert_sameValue_str` (~:1633) and `assert_sameValue_bool` (~:1651) whose params
  are `string` / `boolean` → a direct compare, no `any`-boxing. The routing block
  (~:2219–2328) has `_str` / `_bool` / `typeof` cases but **no numeric case**, so
  numeric asserts fall onto the buggy generic `any` path.

## Proposed fix (cheap; sidesteps #3055)

Add a typed numeric specialization mirroring `_str` / `_bool`:

```ts
function assert_sameValue_num(actual: number, expected: number): void {
  __assert_count = __assert_count + 1;
  // SameValue on numbers: equal, or both NaN.
  if (!(actual === expected || (actual !== actual && expected !== expected))) {
    if (!__fail) __fail = __assert_count;
  }
}
```

and route `assert_sameValue(numExpr, numLit | numExpr)` → `assert_sameValue_num`
in `wrapTest` (same shape as the existing `_str` / `_bool` routing). `number`
params compile to a direct f64 `===`, avoiding the any-boxing path. Do the same
for `assert_notSameValue_num`.

## CRITICAL — this is a measurement RE-BASELINE, not a normal PR

Enforcing numeric asserts turns currently-vacuously-"passing" numeric tests into
**honest FAILS** → the standalone `host_free_pass` floor **DROPS** (potentially by
a lot). The floor gate will read that as a large regression and **auto-park** the
PR. This is expected and correct — it is a deliberate re-baseline of a
measurement that was over-counting. Therefore:

- **Do NOT land under the autonomous loop.** This changes the headline standalone
  conformance number and needs the **human's** sign-off + a coordinated floor
  re-baseline (refresh `test262-current.jsonl` in `loopdive/js2wasm-baselines` and
  the committed summary in the SAME change, and expect/allow the one-time floor
  drop).
- Preferably land **after or together with #3055** (the real codegen fix), so the
  numbers reflect genuine post-fix conformance rather than harness-only masking.

## Acceptance criteria

- `assert.sameValue(1, 2)` (and arithmetic-derived numeric asserts) are scored
  **fail** in standalone, matching host.
- No change to string / bool / typeof assert enforcement.
- The standalone floor is re-baselined in the same coordinated change, with the
  one-time drop acknowledged (human-approved), not auto-parked as a false regression.
