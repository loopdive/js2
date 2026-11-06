---
id: 7026
title: "tests: issue-tests backlog, value-assertion class (lower half) — stale host wiring, stale interim pins, three real regressions (hole join, dynamic-new spread, IR const writes)"
status: done
completed: 2026-10-17
sprint: current
created: 2026-10-17
updated: 2026-10-17
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: tests
language_feature: arrays, new, const
goal: test-infrastructure
related: [7014, 5337, 6438, 4491, 3981, 2026, 846, 7027, 7028, 7030, 7031]
requested_by: ttraenkler/wave15-values-a
# 2026-10-17 (#7026): three regression fixes, each a few lines at the site
# that regressed — the hole-marker canonicalisation in the host join loop,
# the spread guard on the #3981 `__construct_closure` arm, and the const-write
# demotions in the IR assignment lowerers (helpers live in the new
# src/ir/const-binding-writes.ts; only the call sites stay in from-ast.ts).
loc-budget-allow:
  - src/ir/from-ast.ts
  - src/codegen/expressions/new-super.ts
  - src/codegen/array-methods.ts
# 2026-10-17 (#7026): the one-line spread guard on the `__construct_closure`
# arm inside compileNewExpression (+ its two-line comment).
func-budget-allow:
  - src/codegen/expressions/new-super.ts::compileNewExpression
---

# #7026 — issue-tests backlog, value-assertion class, lower half (wave 15 "values-a")

Part of [#7014](./7014-issue-tests-detector-red-since-july.md). The value-assertion
class of the July→October backlog has 308 files with an issue number; the
median issue number is **3329**, and this slice is the 154 files / 322 tests
below it.

## Measurement

Every file re-run locally on upstream main `0727e2985b` (serial vitest, one
file per fork) before any change: **151 files / 329 tests red** (148/324 in
the batch run, plus the 3 files / 5 tests below measured individually before
their edit). 3 files already passed (`issue-1672`, `issue-3201`,
`issue-3269`).

## Root causes and fixes

1. **Stale host wiring (≈40 files).** Since 708ebbd56d (#5337, 2026-07-30)
   a raw `setExports(instance.exports)` cannot establish data-struct
   authority, so struct / array-like reads through the host runtime
   silently missed (`indexOf.call(arrayLike)` → -1, descriptor reads → 0).
   The documented wiring is `setInstance(instance)` (#6438, `src/index.ts`).
   The tests are rewired; files that stay red for another reason were left
   untouched.
2. **Stale interim pins.** #4491 (68a3747e9a) made holes skip in
   `reduce`/`forEach`; three #2001 tests pinned the pre-#4491 behaviour. The
   #2940/#3086 vacuity fixtures relied on a compiler bug (a dropped
   numeric-param callback) that no longer exists. #3596 added `tests: []` to
   `parseFrontmatterCountReason`. #2861 pinned a standalone refusal for
   `Math.length`, which now compiles and reads `undefined` as in JS. The
   #739 residual pin now reads the spec value. #4415 (0be07b6077) memoised the
   derivation flags per compile, so two #743 tests reading them directly now
   reset the memo. #5164 (ae3f672db4) made `in` / `,` claim-partial (#2135
   table). 6ebd204cbe IR-claims initialised class fields (#3000-C). The IR now
   lowers `o.x + 1` (#3053 precision list). Standalone now answers
   `gOPD(Symbol, "iterator")`, compiles the dynamic regex `a+`, and has a
   native `Object.seal` (#2984 phase 3, #1474, #1907 fixtures).
3. **Real regression — host `[1,,3].join()` rendered `"1,NaN,3"`.** #4491
   stores literal holes as the absence marker, but the host-lane join loop
   only tested the `undefined` marker. Fixed by the read-boundary
   canonicalisation every other reader uses (`f64HoleToUndefFor`, a no-op for
   modules without holes).
4. **Real regression — `new K(...[4, 5])` through an untyped parameter.**
   #3981 admitted untyped parameter callees to the `__construct_closure` arm,
   which pushes each argument whole, so a spread arrived as one array
   argument. Spread calls now stay on the #2026 path, which flattens them.
5. **Real regression — writes to `const` under the IR.** `const x = 1; x = 2`
   hard-failed the #4502 producer-promise invariant (a compile error), and
   `for (const x of xs) x++` silently performed the write. Both now demote
   to the legacy lowering, which throws the TypeError.

## Probes

- `tests/issue-1998.test.ts`, `tests/issue-1997.test.ts` — host hole join.
- `tests/issue-2026-dynamic-new-varspread.test.ts`,
  `tests/issue-2026-dynamic-new-spread.test.ts` — dynamic-new spread.
- `tests/issue-846.test.ts` — const writes under the IR.

## Residuals

Recorded in the PR body; the ones too large for this wave have their own
issues: #7027 (standalone `(C as any).staticMethod(x)` dispatches the static
as an instance method), #7028 (`new.target` lost when an untyped-parameter
callee takes the `__construct_closure` arm), #7030 (standalone
`Reflect.apply` compiles since #5140 but throws for ordinary closures),
#7031 (standalone `o.p = yield x` now compiles but evaluates the target after
the resume).
