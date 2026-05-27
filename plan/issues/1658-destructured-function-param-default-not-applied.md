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

## Root cause & fix

The failure was in the **call-site inlining** path, not the destructuring step.
`process` is a small expression-shaped function, so `registerInlinableFunction`
marks it inlinable. For a **constant** parameter default (e.g. `y = 10`), the
callee-side default guard is elided entirely (#869) — the caller is responsible
for materializing the default. But the inline path
(`src/codegen/expressions/calls.ts`) padded any missing argument with
`pushDefaultValue` (a plain `f64.const 0`), ignoring the declared default. So
`process(5)` inlined to `y = 0` instead of `y = 10`, and the suite returned 30
instead of 40.

Fix: in the inline path, consult `ctx.funcOptionalParams` for the callee and,
when an argument is missing OR an explicit `undefined`-like literal, emit the
recorded default via `pushParamSentinel(..., optEntry)` (which yields the
constant value for constant defaults). Expression defaults can't reach this path
— their callee guard emits an `if`/`local.set`, which `INLINE_DISALLOWED_OPS`
already excludes from inlining.

Regression test: `tests/issue-1658.test.ts` (scalar omitted, explicit
`undefined`, default-of-0, and multiple trailing defaults).
