---
id: 3423
title: "Module-global representation: top-level bindings read as undefined under literal harness — ~600 default reclassifications"
status: in_progress
created: 2026-07-18
priority: medium
feasibility: hard
task_type: bugfix
area: codegen
goal: test262-conformance
model: gpt-5.6-luna
reasoning_effort: max
sprint: current
horizon: l
related: [3370, 3188, 3417]
loc-budget-allow:
  - src/codegen/declarations.ts
  - src/codegen/index.ts
  - src/codegen/destructuring-params.ts
  - src/codegen/async-frame.ts
  - src/codegen/object-runtime.ts
  - src/runtime.ts
func-budget-allow:
  - src/codegen/declarations.ts::collectDeclarations
  - src/codegen/async-frame.ts::ensureAsyncResumeFunction
  - src/codegen/object-runtime.ts::fillClosedStructExternGetArms
  - src/codegen/destructuring-params.ts::destructureParamObject
---

# #3423 — top-level module-global bindings read as undefined under the literal harness

## Problem
#3370 stopped wrapping the test body in `export function test()`, which used to turn
module-global `var`/`let`/`function`/`class` bindings into function locals (masking a
representation gap). Under the literal harness the body runs as real top-level
`__module_init`, and cross-reference reads of those globals resolve to `undefined`.
Measured (oracle-v8, default lane) reclassification signatures:

- `Expected SameValue(«NaN», «undefined») to be true` = 122
- `Expected SameValue(«undefined», «"X"») to be true` = 80
- `Expected SameValue(«N», «undefined») to be true` = 35
- `null is not a constructor [in __module_init()]` = 47
- `obj should have an own property m` / `foo doesn't appear as an own property on the C
  constructor` / `strict rerun: obj should have an own property {length,name}` =
  201 + 136 + 92 + 86 (class field/method + function length/name own-property presence)
- `Cannot convert undefined or null to object [in verifyProperty()/verifyNotEnumerable()/
  verifyNotWritable()]` = 140 + 9 + 5

## Root cause (to confirm)
Two overlapping representation gaps the correct harness exposes:
1. **Top-level binding storage**: `var`/`let`/`function`/`class` declared at module
   top level are not stored/loaded as real module globals reachable by later top-level
   statements — later references read the uninitialised/undefined slot (hence the
   `SameValue(x, undefined)` and `null is not a constructor` families). Overlaps the
   module-code semantics umbrella #3188.
2. **Own-property presence on class/function objects**: class fields/methods and
   function `length`/`name` are not installed as observable own properties, so
   `verifyProperty`/own-property assertions fail.

## Implementation Plan
- Reproduce a minimal case: `var x = 1; assert.sameValue(x, 1);` and
  `class C { m(){} } assert(Object.prototype.hasOwnProperty.call(C.prototype,'m'))`
  through the literal harness; confirm the undefined/own-property gaps.
- Sub-family 1: ensure top-level `var`/`let`/`function`/`class` bindings are emitted as
  module globals with correct init ordering and TDZ, and later top-level reads load the
  live slot. Coordinate with #3188 (module-code semantics) to avoid double-work — this
  may be a child of #3188.
- Sub-family 2: install class methods/fields and function `length`/`name` as
  enumerable/own properties per spec so `verifyProperty` observes them.

### Edge cases
- TDZ for `let`/`const` (read-before-init must throw ReferenceError, not undefined).
- Function `.name`/`.length` and class static vs instance property placement.
- Hoisting order of `function` declarations vs `var`.

## Verification
- Scoped: `language/statements/{class,let,const,var}/**` own-property + value tests
  pass on the default lane.
- Cross-check with #3188 to route shared module-semantics work.

## Notes
This is genuinely HARD (representation work) — spec first, land incrementally. Likely
overlaps/merges with #3188; the architect/PO should decide whether to fold this into
#3188 or keep it as the v8-reclassification-scoped child.

## 2026-08-26 authoritative ES2015 remeasurement and first milestone

The complete authoritative host run `20260826-180615` and standalone run
`20260826-194014` each contain the same 82 `/dstr/` rows with the exact
observable mismatch `Expected SameValue(«NaN», «undefined») to be true`. This
is a stable cross-lane family, not a lane-specific adapter result. Its syntax
distribution is identical in both reports: 16 statement-class, 16
expression-class, 9 `for`, 9 `for-of`, 6 object-method, 4 statement-generator,
4 statement-function, and 18 rows across function/generator/arrow and
`let`/`const`/`var` contexts.

The source artifacts are:

```text
/private/tmp/js2-es6-authoritative-measure3/benchmarks/results/test262-results-20260826-180615.jsonl
/private/tmp/js2-es6-authoritative-measure4/benchmarks/results/test262-standalone-results-20260826-194014.jsonl
```

The first implementation milestone is deliberately the exact 82-row family,
not the full historical ~600-row umbrella:

1. Extract the identical 82-path intersection and rerun every path alone in
   both lanes with pass/fail harness controls before attributing the mismatch.
2. Reduce at least one `obj-ptrn-prop-obj` and one
   `ary-ptrn-rest-obj-prop-id` row to prove whether the `NaN` binding is lost at
   module-global storage, nested destructuring, or closure capture.
3. Implement the shared representation fix at the owning binding/load path.
   Preserve TDZ, hoisting, closure capture, and `var`/`let`/`const` distinctions;
   do not patch Test262 values or route through a host oracle.
4. Add focused module-global and destructuring controls, then rerun all 82
   exact paths in host and standalone modes. Record any distinct residual as a
   follow-up instead of counting it as fixed.
5. Run TypeScript 5/7, formatting, lint, LOC/function budgets, ratchets, and
   issue gates; commit and push the worktree branch for integration into the
   sole upstream draft PR #5010.

Acceptance for this milestone is 82/82 pass in both lanes with no timeout,
compile error, skip, filter, fixture rewrite, or oracle-only workaround.

## 2026-08-26 first-milestone checkpoint — reduced array slice

The exact-path extraction remains 82 host rows, 82 standalone rows, and an
identical 82-path intersection (82/82). I stopped before the requested full
82-row solo sweep as directed after the representative reduction.

Fresh bounded-process representative results are:

| path | host | standalone |
| --- | --- | --- |
| `language/statements/variable/dstr/ary-ptrn-rest-obj-prop-id.js` | pass (`cb0700bc3aa4`) | pass (`5ce0187eef9e`) |
| `language/statements/variable/dstr/obj-ptrn-prop-obj.js` | fail: `SameValue(NaN, undefined)` (`ac476ff4e548`) | fail: `SameValue(NaN, undefined)` (`701bb611de5b`) |

The retained checkpoint is the smallest proven array-rest slice. It widens
no-default scalar f64 destructuring slots to `externref` consistently across
the checker binding resolver, module-global registration, and `var` hoisting;
the array-like object-rest extraction also brands its f64 source as
undefined-capable before coercing it into the widened slot. This preserves the
dedicated f64 undefined sentinel while ordinary NaN remains a number. The
checkpoint touches only `src/checker/type-mapper.ts`,
`src/codegen/declarations.ts`, `src/codegen/index.ts`, and
`src/codegen/destructuring-params.ts`.

The object representative is not counted as fixed. Its module globals are now
`externref`, but the nested object source still crosses a closed-struct
f64-field/externref boundary (`y` is materialized as NaN before the binding
read), so the remaining fix belongs to source-shape/property loading rather
than this proven array-rest storage path. Do not expand the denominator until
that path is isolated and separately verified. The interrupted dependency
provisioning left no artifact in the worktree; the linked dependency and
pinned QuickJS artifact were used for this checkpoint.

## 2026-08-27 nested-object source-shape checkpoint — exact 11-row denominator

The owned source-shape slice is the 11 exact `obj-ptrn-prop-obj.js` paths in
the statement/expressions function, generator, async-generator, try, and
`let`/`const`/`var` contexts. It is intentionally narrower than the historical
82-row family; no 82-row rerun was performed in this checkpoint.

Fresh controls before the source-boundary fix were the variable representative:
host run `20260827-015237` = 0/1 and standalone run `20260827-015424` = 0/1,
both failing with `SameValue(NaN, undefined)`. After the closed-struct f64
field → externref boundary and shared binding allocation fixes, the exact
11-row denominator measured as follows (empty filtered shard files are not
rows):

| run | lane | rows | result |
| --- | --- | --- | --- |
| `20260827-022532` | host | 11/11 | pass |
| `20260827-022648` | standalone | 9/11 | two async-generator resume rows still failed |
| `20260827-023944` | standalone | 11/11 | pass after async-frame binding-marker fix |
| `20260827-024058` | host | 11/11 | pass after the same shared fix |

The remaining 2/11 standalone failures were the async-generator expression and
statement paths. Their entry destructuring had already widened `x`, `y`, and
`z` to `externref`, but the independently compiled async resume function still
applied checker-type `__unbox_number` reads. The shared async-frame metadata now
threads the undefined-preserving pattern-binding marker into that resume context;
ordinary NaN is still boxed as a number because only the dedicated undefined
sentinel bit pattern is restored. Permanent host and standalone coverage is in
`tests/issue-3423-nested-object-dstr.test.ts`.

After narrowing the host runtime edit to the proven string-key property path,
the exact denominator was re-measured again: standalone run `20260827-025828`
= 11/11 and host run `20260827-025951` = 11/11. These are the final checkpoint
results for this branch; the five empty filtered shard files in each run are
not Test262 rows.

After integration onto refreshed upstream head `9e0c7a1b9` plus completed Set
slice #4763, combined commit `f1aaaca7d` independently passed the focused
regression at 2/2, host run `20260827-030825` at 11/11, and standalone run
`20260827-030955` at 11/11. Both maintained-runner Test262 runs had zero
failures, compile errors, compile timeouts, or skips.

The async-frame binding classification was then routed through the existing
oracle facts instead of adding a raw checker query. The oracle ratchet reports
zero raw-query growth, the focused regression remains 2/2, and the final code
was re-measured with the exact 11-row filter: host run `20260827-031536` and
standalone run `20260827-031714` both pass 11/11 with zero failures, compile
errors, compile timeouts, or skips. These final run IDs supersede the earlier
combined-head measurements above.
