---
id: 4536
title: "stylelint arrayEqual + webpack groupBy/formatSize residuals: illegal casts on mixed-element compares and NaN branch — 5 tests"
status: done
sprint: current
created: 2026-08-16
updated: 2026-08-24
priority: low
horizon: s
feasibility: medium
reasoning_effort: medium
task_type: bug
area: codegen
language_feature: arrays, closures
goal: npm-library-support
related: [3995, 4531, 4303]
budget_allowance: "granted 2026-08-23 — curated-npm lane, tuple/host-boundary fix slice on PR #4728"
loc-budget-allow:
  - src/codegen/property-access.ts
  - src/codegen/declarations.ts
  - src/codegen/closures.ts
  - src/codegen/expressions/calls.ts
  - src/codegen/index.ts
  - src/codegen/expressions/call-identifier.ts
  - src/codegen/context/types.ts
func-budget-allow:
  - src/codegen/property-access.ts::compileElementAccessBody
  - src/codegen/declarations.ts::lowerParamType
  - src/codegen/declarations.ts::collectDeclarations
  - src/codegen/closures.ts::computeClosureWrapperSig
  - src/codegen/expressions/call-identifier.ts::compileIdentifierCall
  - src/codegen/index.ts::generateModule
  - src/codegen/index.ts::generateMultiModule
files:
  - tests/dogfood/stylelint-upstream-suite.mjs
  - tests/dogfood/webpack-upstream-suite.mjs
  - tests/issue-4536-jsdoc-optional-number.test.ts
  - tests/issue-4536-callable-spread.test.ts
  - src/codegen/expressions/calls.ts
  - src/codegen/expressions/call-identifier.ts
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

## 2026-08-22 triage (curated-npm-tests lane, post-#4614/#4616)

stylelint 104/108, webpack 13/16 after this session's fixes. The residuals:

- **stylelint arrayEqual "handles arrays"** — `arrayEqual(a: unknown, b:
  unknown)` + `Array.isArray` CFA narrowing + `a.every(...)`: the array-method
  lane bakes one vec cast for the narrowed receiver; a different-carrier
  argument traps "illegal cast". #4611-family (CFA-narrowed dynamic value
  treated as a proven GC rep). A minimal reduction of exactly this shape is
  BLOCKED by a separate pre-existing compile bug, reproduced on origin/main:
  `Invalid JavaScript adapter manifest: duplicate adapter import
  'env::__box_number' appears 2 times` (compile of a small module with
  unknown-param isArray+every; worth its own issue).
- **stylelint ruleMessages "message functions"** — `[undefined and undefined]`
  in the output: rest/`arguments` forwarding drops the args of a
  message-function call (related to the #4530 protocol family).
- **stylelint vendor prefix ×2** — `null` instead of `"-moz-"`/`"color"`: a
  string/regex op returns null through the boxed lane.
- **webpack groupBy ×2** — illegal cast at `__call_fn_method_2`: callback
  dispatch on `Array.prototype.filter/partition`-style HOF with a
  cross-carrier receiver.
- **webpack formatSize "undefined/NaN"** — `"0 bytes"` vs `"unknown size"`:
  the `typeof size !== "number" || Number.isNaN(size)` guard misfolds for a
  boxed undefined crossing the any lane (residual of the #4529 family).

## 2026-08-23 fix slice (curated-npm-tests lane) — webpack 15/16, stylelint 105/108

Root cause of the webpack groupBy pair was NOT the HOF callback dispatch — it
was the JSDoc tuple typing. `@returns {[T[], T[]]}` lowers the reduce
accumulator to a fixed tuple struct `{_0, _1}`, and three defects stacked:

1. **Dynamic tuple index compiled to `undefined` silently** —
   `groups[fn(v) ? 0 : 1]` hit property-access.ts's "tuple element access
   requires a numeric literal index" arm (demoted in JS mode), so `.push` ran
   on undefined → the host threw "Cannot read properties of null". Fixed: a
   HOMOGENEOUS tuple (all fields one ValType) lowers a dynamic index to an i32
   `struct.get` ladder. Mixed-type tuples keep the literal requirement.
2. **Tuple structs crossing to host read as `{_0:…,_1:…}`** — `Array.isArray`
   false, `.length` 0, so the upstream `toStrictEqual` shim mismatched even
   with correct contents. Fixed in the runtime: `__extern_is_array`,
   `__extern_length`, and `_wrapForHost` now present tuple-shaped structs
   (all fields `_N`, probed via `_tupleFieldCount`) as arrays — same
   semantics `_convertIterableForHost` (#1438) already applied for Map/Set
   construction.
3. **Vec-typed closure params trapped on host arrays in dynamic dispatch** —
   `externToClosureParamRef` (closure-exports.ts) emitted a bare `ref.cast`;
   a JSDoc-typed `(arr = [], fn)` closure reached via `__call_fn_method_2`
   with a raw JS array arg trapped. Fixed: vec params route through the
   #2831 `__vec_from_extern_<vecTypeIdx>` materializer (same-rep short
   circuit, host arrays materialized). Also plumbed `receiverIsExternref`
   through `compileArrayReduce`/`reduceRight`/`find*`/`some`/`every` →
   `setupArrayLoop`'s #3996 arm (reduce previously ignored the flag —
   direct-call default-param `arr = []` shapes trapped the same way).

Measured: webpack 13 → **15/16** (groupBy ×2 fixed; formatSize NaN residual
remains). stylelint 104 → **105/108** — the `arrayEqual` "handles arrays"
illegal cast healed as collateral of fix 3 (its `a.every(...)` receiver
crossed the same bridge). Regression test:
`tests/issue-4536-tuple-dynamic-index-array-identity.test.ts` (verbatim
upstream shape via compileProject, both tests fail on base). Tuple-family
guard tests (issue-1158/1161/1182/1314/1431/1451, illegal-cast-vec-tuple-648)
A/B'd identical on base (the 648 file + one 1451 case fail on base too —
pre-existing, `link` options iterability + object-rest default NaN).

Remaining #4536 residuals: webpack formatSize NaN (`"0 bytes"` vs
`"unknown size"`), stylelint ruleMessages arg forwarding, stylelint vendor ×2.

## 2026-08-24 optional-JSDoc ABI fix

The remaining webpack failure was the first assertion in the unchanged
`formatSize()` test: its `@param {number=} size` declaration was lowered to an
`f64` because the caller lived in a different source module. The missing-arg
pad therefore supplied `0`, so the upstream `typeof size !== "number"` guard
returned `"0 bytes"` instead of observing JavaScript `undefined`.

The declaration and closure ABI paths now recognize optional TypeScript/JSDoc
parameters without initializers and keep them in the undefined-capable
`externref` representation (explicit native annotations remain authoritative;
initializer parameters retain their existing default sentinel path). This is a
generic boundary rule, not a webpack-specific case. A compact regression in
`tests/issue-4536-jsdoc-optional-number.test.ts` covers omitted, numeric, and
explicit-NaN calls across a module boundary.

Fresh unchanged-suite result: **webpack 16/16** Wasm tests, all three selected
modules compile and validate. Stylelint remains **105/108**; its three
remaining failures are the unrelated `ruleMessages` argument-forwarding and
vendor string/regex residuals listed above.

## 2026-08-24 completion

The two remaining classes were fixed generically:

- ESM `export default <expression>` assignments now retain a graph-global
  externref cell through module initialization. Late default-import aliases
  resolve to that cell, so cross-module default object/function values are
  initialized before their consumers run. This repaired Stylelint's vendor
  formatter callbacks without package-specific handling.
- A dynamically stored callable invoked as `fn(...args)` now uses the host call
  adapter with a real argument array. Wasm `__vec_*` rest values are expanded
  element-by-element (opaque host iterables use the existing length/index
  helpers), preserving argument order and count for both Wasm closures and JS
  functions. The reduction is covered by
  `tests/issue-4536-callable-spread.test.ts`.

Fresh unchanged-suite results: **Stylelint 108/108** and **Webpack 16/16**
admitted upstream tests pass, all selected modules compile and validate, and
neither suite has runtime-only failures. The remaining upstream registrations
are explicitly reported as unavailable infrastructure by their adapters.
