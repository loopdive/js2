---
id: 1437
sprint: 52
title: "spec gap: Math numeric edge cases beyond random source"
status: done
created: 2026-05-11
updated: 2026-05-20
priority: low
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: runtime
language_feature: math
goal: spec-completeness
related: [807, 1322]
---
# #1437 - Math numeric edge cases beyond random source

## Problem

Spec §21.3 is close but still partial: `309 / 327` passing. #1322 covers the
standalone `Math.random` source, but the report still shows assertion and
wasm_compile failures for numeric edge cases.

Known residual patterns include signed zero, infinities, `NaN`, and method
specific coercion details around `hypot`, `trunc`, `fround`, and newer Math
methods.

## Acceptance criteria

1. Add focused tests for signed-zero and infinity behavior in the failing Math
   methods.
2. Route Math arguments through the same ToNumber behavior as #1434 where the
   spec requires it.
3. Resolve the remaining §21.3 wasm_compile failures or document the exact
   unsupported proposal/runtime dependency.
4. §21.3 pass-rate rises above 98% after #1322 and this issue are both done.

## Files to inspect

- `src/codegen/builtins.ts`
- `src/codegen/math-ops.ts`
- `src/runtime.ts`
- `tests/issue-1437.test.ts`

## Resolution (2026-05-20)

The §21.3 baseline shows 16 not-pass entries out of 327. Of those:

- **10 `Math.sumPrecise/*`** — Stage 3 proposal that needs `Math` to be a
  runtime object (own-property iteration, `length`/`name` descriptors,
  iterable consumption, custom `[Symbol.iterator]` throwers). Out of scope:
  the compiler statically inlines `Math.<method>(…)` calls and does not
  materialise `Math` as an externref host object.
- **2 `Math.f16round/*`** — also a recent proposal not yet wired through.
  `prop-desc.js`, `name.js`, `not-a-constructor.js` rely on `Math` being a
  reflectable host object.
- **1 `Math.prop-desc.js`** — `Object.getOwnPropertyDescriptor(Math, …)`,
  same Math-as-object dependency.

The remaining four are pure numeric edge cases this issue fixes:

- **`Math/pow/applying-the-exp-operator_A7.js`** — `Math.pow(±1, +Infinity)`
  must return NaN per §21.3.2.26. The pre-fix `Math_pow` body short-circuited
  `base == 1 → 1` BEFORE checking for `abs(exp) == Infinity`. Added an
  explicit `abs(base) == 1 AND abs(exp) == Infinity → NaN` guard immediately
  after the NaN propagation checks.
- **`Math/pow/applying-the-exp-operator_A8.js`** — `Math.pow(±1, -Infinity)`
  same fix (the new guard covers both Infinity polarities via `f64.abs`).
- **`Math/sinh/sinh-specialVals.js`** — `Math.sinh(-0)` returned `+0` because
  `(exp(-0) - 1/exp(-0)) / 2 = (1 - 1) / 2 = +0` drops the sign. Added an
  `x == 0 → return x` early-return that preserves the IEEE-754 sign bit
  (§21.3.2.31).
- **`Math/tanh/tanh-specialVals.js`** — same shape, same fix (§21.3.2.34).

The remaining 13 failures are documented as proposal/runtime-object dependencies
above (acceptance criterion #3).

## Test Results

`npm test -- tests/issue-1437.test.ts` — 19/19 pass:
- pow(±1, ±Infinity) → NaN (4 cases)
- pow short-circuit regression guards (pow(2,10), pow(1,5), pow(NaN,0)) (3 cases)
- sinh(NaN), sinh(±Infinity), sinh(±0) (5 cases)
- tanh(NaN), tanh(±Infinity), tanh(±0) (5 cases)
- sinh(1), tanh(1) accuracy regression guards (2 cases)

Pre-existing failures in `tests/issue-324.test.ts`, `tests/codegen.test.ts`,
`tests/issue-379.test.ts`, and `tests/equivalence/math-pow-test262-pattern.test.ts`
(LinkError: stub imports for `__get_builtin`, `__throw_type_error`,
`__new_Error`, etc.) are present on `origin/main` and unrelated to this fix —
confirmed via `git stash && npm test … && git stash pop`.
