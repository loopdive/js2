---
id: 1658
title: "Destructured/scalar function-parameter default not applied (returns wrong value)"
status: done
sprint: Backlog
created: 2026-05-24
updated: 2026-05-27
completed: 2026-05-27
priority: high
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: destructuring
goal: spec-completeness
related: [1553b, 1553d]
depends_on: [1659]
---
# #1658 — Destructured/scalar function-parameter default not applied (returns wrong value)

## Summary

In `tests/equivalence/destructuring-extended.test.ts` under the test case
**"destructured function parameters with defaults"**, a function-parameter
default evaluates to the **wrong value on the real runtime** — the compiled
function returns **30 where 40 is expected**.

This is a genuine codegen bug in the **function-parameter default path**, and is
**distinct from object destructuring**: the related #1553b / #1553d work covered
object/array **declaration-mode** destructuring defaults and is done. This one is
the **function-parameter** path (the scalar/destructured param default applied at
call-time binding), which #1553b/#1553d did not touch.

Found during the **#1553b verification sweep** (dev-1553b destructuring-lane
sweep, 2026-05-24).

## Reproduction

- **Test file:** `tests/equivalence/destructuring-extended.test.ts`
- **Test name:** "destructured function parameters with defaults"
- **Observed:** the function returns **30**
- **Expected:** **40** (the parameter default should fire and contribute the
  larger value)

The discrepancy reproduces **on the real runtime** — it is **not** a harness /
test-stub artifact. (Contrast with the separate harness-fidelity gap noted in
#1659, where `__extern_get` in `tests/equivalence/helpers.ts` returns `undefined`
for opaque WasmGC structs and makes a default *wrongly* fire while the real
runtime is correct. This issue is the opposite: the real runtime is **wrong**.)

## Acceptance criteria

- The function-parameter default fires correctly so the
  "destructured function parameters with defaults" case in
  `tests/equivalence/destructuring-extended.test.ts` returns **40**.
- A focused regression test is added covering the function-parameter default
  path (both the scalar-param default and the destructured-param default
  variants where applicable).
- No regressions in the existing destructuring equivalence suites.

## Notes

- This bug is **NOT currently caught by CI** — the `quality` job does not run the
  full `tests/equivalence/` suite (it OOMs in the runner). See **#1659** for the
  CI coverage gap; until that lands, this regression class is invisible to CI and
  must be validated locally.

## Root cause & fix (2026-05-27)

The actual failure was the **scalar** path, not destructuring: `process(5)`
returned `5` (default `y = 10` dropped), so `process(5) + process(5, 20)` gave
`5 + 25 = 30` instead of `15 + 25 = 40`.

The call to `process` was **inlined** at the call site. The call-site inliner in
`src/codegen/expressions/calls.ts` (the `ctx.inlinableFunctions` branch) padded a
missing optional parameter with `pushDefaultValue` (which emits `f64.const 0` /
`ref.null`), ignoring the parameter's registered default. The non-inlined direct
call path correctly consults `ctx.funcOptionalParams` and uses `pushParamSentinel`
(emits the inlined constant default, or the sNaN sentinel that the inlined
prologue checks for expression defaults).

**Fix:** in the inline path, look up `ctx.funcOptionalParams.get(funcName)` for the
missing index and call `pushParamSentinel` (falling back to `pushDefaultValue` for
non-optional padding). This mirrors the direct-call path so both constant and
expression defaults fire under inlining.

Regression test: `tests/issue-1658.test.ts` (scalar constant default fires/not-fired,
expression default through inline path, multiple omitted defaults).

## Test Results

- `tests/issue-1658.test.ts` — 4/4 pass
- `tests/equivalence/destructuring-extended.test.ts` — 4/4 pass (target case returns 40)
- Inline/default regression set (`default-params`, `inline-small-functions`,
  `array-inline-return`, `issue-1025-param-default-null`, `issue-43-assign-dstr-defaults`,
  `fn-param-dstr-rest-in-rest`, `issue-1372-ir-destructuring-params`,
  `issue-1374-ir-string-iter-inline`) — all pass.
- `tests/math-inline.test.ts` has 6 pre-existing failures **on base** (unrelated
  host-import harness issue) — unchanged by this fix.
