---
id: 4536
title: "stylelint arrayEqual + webpack groupBy/formatSize residuals: illegal casts on mixed-element compares and NaN branch — 5 tests"
status: ready
sprint: current
created: 2026-08-16
updated: 2026-08-21
priority: low
horizon: s
feasibility: medium
reasoning_effort: medium
task_type: bug
area: codegen
language_feature: arrays, closures
goal: npm-library-support
related: [3995, 4531, 4303]
files:
  - tests/dogfood/stylelint-upstream-suite.mjs
  - tests/dogfood/webpack-upstream-suite.mjs
---

# Last-mile residuals in the stylelint (7/9) and webpack (13/16) suites

## Problem

Measured 2026-08-16 on `a9b20d4c`, both matching their npm-compat cards.

**stylelint — 2 failures**, both:

```text
RuntimeError: illegal cast
    at arrayEqual (wasm-function[56])
```

Upstream `arrayEqual(a, b)` is `a.every((item, i) => item === b[i])` over
arrays that mix strings/numbers in the test fixtures — an element read/compare
on a mixed carrier traps. Same family as #4531 (prettier AstPath); reduce
against that issue's fix first, this may be free collateral.

**webpack — 3 failures**:

- 2× `RuntimeError: illegal cast at __call_fn_method_2` in `ArrayHelpers`
  `groupBy` ("partition into two arrays", "works with empty array"):
  `groupBy(arr, fn)` returns `[arr.filter(fn), arr.filter(x => !fn(x))]` —
  the user callback passed through `wasmClosureDynamicDispatch` traps on its
  argument cast (boolean-returning predicate over number elements).
- 1× `formatSize` NaN branch: `formatSize(NaN)` returns `"0 bytes"` instead
  of `"unknown size"` — upstream gates on `Number.isNaN(size)` (or
  `typeof size !== 'number'`); the compiled NaN test answers false, so NaN
  falls through to the numeric formatting path.

## Reproduction

```bash
node --import tsx tests/dogfood/stylelint-upstream-suite.mjs --json
node --import tsx tests/dogfood/webpack-upstream-suite.mjs --json
```

## Implementation Plan (Fable; implement per the plan/implement split)

1. **Order behind the bigger issues**: re-run both suites after #4531
   (mixed-carrier element reads) and #4529 (boxed-any classification) land;
   strike out whatever they fix and keep only the true residual here.
2. **groupBy cast (if it survives)**: reduce
   `arr.filter(predicate)` where `predicate` arrives as a function parameter
   and `arr` is `number[]` — the `__call_fn_method_2` cast suggests the
   dispatch trampoline casts the predicate's closure struct to the wrong
   shape when the same callback flows through two `filter` sites with
   different inferred element types.
3. **formatSize NaN (independent, small)**: reduce
   `Number.isNaN(x)` / `x !== x` on a boxed-any parameter; the NaN test on
   an unboxed-from-any f64 must survive the round-trip. Likely a one-site
   fix in the isNaN builtin lowering for any-typed operands.
4. **Validation gates**: stylelint 9/9, webpack 16/16 (or residuals named
   with fresh evidence); committed reductions; equivalence green.

## Acceptance criteria

- [ ] stylelint pinned suite 9/9.
- [ ] webpack pinned suite 16/16.
- [ ] Each fix carried by a general reduction, no package-specific casing.

## Latest adapter checkpoint (2026-08-21)

The Stylelint adapter now selects 16 original pure utility files instead of
five, increasing the admitted corpus from 9 to 24 callbacks without adding a
PostCSS, filesystem, plugin, or async test shim. All 16 modules compile and
validate; 20/24 callbacks pass in Wasm and all 24 pass in native Node. The
remaining four scored failures are unchanged compiler/runtime residuals:
`arrayEqual` still traps with an illegal cast, `ruleMessages` loses arguments
through its returned message closure, and both `vendor` callbacks return null.
The other 1,550 registrations remain explicitly deferred infrastructure.

## Latest adapter checkpoint (2026-08-21, utility expansion)

The adapter now selects **30** original synchronous utility files and registers
**108/108** callbacks natively. All 30 modules compile and validate in the
Wasm lane. Wasm passes **104/108** callbacks with no runtime-only failures; the
same four compiler residuals remain (`arrayEqual`, the parameterized
`ruleMessages` closure, and two `vendor` cases). The remaining **251 files / 1,466
registrations** stay explicitly deferred as unavailable infrastructure rather
than being silently omitted. The added files are local utility/reference
modules; no test body or input was rewritten.
