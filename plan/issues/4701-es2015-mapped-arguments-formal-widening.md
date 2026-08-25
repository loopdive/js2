---
id: 4701
title: "ES2015 mapped arguments string-valued formal reverse-sync widening"
status: in-progress
sprint: current
created: 2026-08-25
updated: 2026-08-25
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen, conformance
es_edition: es6
language_feature: arguments-object
goal: test262-conformance
source_loc_cap: 180
loc-budget-allow:
  - src/codegen/closures.ts
  - src/codegen/declarations.ts
  - src/codegen/expressions/identifiers.ts
func-budget-allow:
  - src/codegen/expressions/identifiers.ts::compileIdentifierCore
related: [4695, 4699, 4444, 4658, 1511]
origin: "Single excluded ES2015 row split from blocked #4695/#4699: a mapped argument descriptor writes a string into an inferred-f64 formal, and reverse synchronization currently converts it to NaN."
---

# #4701 — ES2015 mapped arguments formal-carrier widening

## Scope

This issue owns only the single excluded row:

```
test/language/arguments-object/mapped/writable-enumerable-configurable-descriptor.js
```

The row calls a sloppy simple-parameter function as `(0)`, so call-site
inference gives `a` an `f64` carrier. `Object.defineProperty(arguments, "0",
{ value: "foo", writable: true, enumerable: true, configurable: true })`
must update the mapped formal to the exact string. The current reverse-sync path
unboxes the externref string through `__unbox_number` and stores `NaN` in the
`f64` local.

This slice may widen only the affected mapped formal's carrier and its
parameter/arguments synchronization. It must not alter #4699's descriptor
sidecar, descriptor flags, accessor routing, generator/async paths, host-import
paths, or unrelated function ABI decisions. **Changed source LOC must remain at
or below 180.**

## Exact baseline (upstream/main)

Baseline was measured on `upstream/main` commit `86c9ec686` (2026-08-25) with
the repository's assembled `runTest262File` host-lane harness and the pinned
Test262 submodule. The exact row failed during its primary sloppy run:

```
status: fail
first error: Expected SameValue(«NaN», «"foo"») to be true
at assert.sameValue(a, "foo")
```

The three numeric mapped-arguments controls all passed:

```
test/language/arguments-object/mapped/mapped-arguments-nonconfigurable-1.js  pass
test/language/arguments-object/mapped/mapped-arguments-nonconfigurable-2.js  pass
test/language/arguments-object/mapped/mapped-arguments-nonconfigurable-4.js  pass
```

The 20 descriptor rows owned by #4699 are additional controls for this slice:

```
test/language/arguments-object/mapped/enumerable-configurable-accessor-descriptor.js
test/language/arguments-object/mapped/nonconfigurable-descriptors-basic.js
test/language/arguments-object/mapped/nonconfigurable-descriptors-define-failure.js
test/language/arguments-object/mapped/nonconfigurable-descriptors-set-value-by-arguments.js
test/language/arguments-object/mapped/nonconfigurable-descriptors-set-value-with-define-property.js
test/language/arguments-object/mapped/nonconfigurable-descriptors-with-param-assign.js
test/language/arguments-object/mapped/nonconfigurable-nonenumerable-nonwritable-descriptors-basic.js
test/language/arguments-object/mapped/nonconfigurable-nonenumerable-nonwritable-descriptors-set-by-arguments.js
test/language/arguments-object/mapped/nonconfigurable-nonenumerable-nonwritable-descriptors-set-by-param.js
test/language/arguments-object/mapped/nonconfigurable-nonwritable-descriptors-basic.js
test/language/arguments-object/mapped/nonconfigurable-nonwritable-descriptors-define-property-consecutive.js
test/language/arguments-object/mapped/nonconfigurable-nonwritable-descriptors-set-by-arguments.js
test/language/arguments-object/mapped/nonconfigurable-nonwritable-descriptors-set-by-param.js
test/language/arguments-object/mapped/nonwritable-nonconfigurable-descriptors-basic.js
test/language/arguments-object/mapped/nonwritable-nonconfigurable-descriptors-set-by-arguments.js
test/language/arguments-object/mapped/nonwritable-nonconfigurable-descriptors-set-by-param.js
test/language/arguments-object/mapped/nonwritable-nonenumerable-nonconfigurable-descriptors-basic.js
test/language/arguments-object/mapped/nonwritable-nonenumerable-nonconfigurable-descriptors-set-by-arguments.js
test/language/arguments-object/mapped/nonwritable-nonenumerable-nonconfigurable-descriptors-set-by-define-property.js
test/language/arguments-object/mapped/nonwritable-nonenumerable-nonconfigurable-descriptors-set-by-param.js
```

Those rows are not owned by this issue and are not changed here. They are
re-run as controls after the formal-carrier change, together with the three
numeric controls above, to detect ABI or reverse-sync regressions.

## Bounded implementation plan

1. Keep the current inferred numeric ABI for ordinary functions. Detect only a
   non-strict simple-parameter function that materializes mapped `arguments`
   and has a direct descriptor/element write capable of putting a nonnumeric
   value into the mapped slot.
2. For that function and affected formal index, use the universal `externref`
   carrier at the function boundary and in the local. Existing numeric body
   operations must continue to request the existing `f64` coercion at their
   use site; no general inference policy or unrelated closure ABI is widened.
3. Make mapped-arguments initialization and reverse synchronization honor the
   widened per-index carrier: numeric values remain boxed/unboxed as before,
   while an externref value is stored/read without `__unbox_number`. Preserve
   the existing severed-link and descriptor-sidecar gates.
4. Add focused equivalence coverage for string-valued reverse sync plus numeric
   mapped writes. Validate the exact row, the three numeric controls, and all
   20 #4699 descriptor controls serially before considering a PR.

No implementation is acceptable if the exact row does not pass, any control
regresses, the change crosses #4699 descriptor-sidecar ownership, or the source
diff exceeds 180 changed source LOC. If the safe affected-index analysis cannot
be implemented within this boundary, leave this issue blocked and open no PR.

## Acceptance

- The exact `writable-enumerable-configurable-descriptor.js` row passes.
- All three named numeric mapped-arguments controls remain passing.
- All 20 #4699 descriptor rows remain passing when run against the same
  descriptor implementation; no descriptor-sidecar code is changed here.
- Other ordinary numeric mapped arguments continue using their existing
  `f64`/`i32` carriers and reverse-sync behavior.
- No generator, async, host-import, or unrelated closure ABI behavior changes.
- Changed source LOC is ≤180; focused tests and issue results are recorded.
- Scoped compiler/typecheck/equivalence checks pass on the final merged branch.

## Test Results

Baseline only (upstream/main `86c9ec686`):

```
1/1 exact row fail (NaN vs "foo")
3/3 numeric mapped-arguments controls pass
20 #4699 descriptor rows: control set; no implementation change in this slice
```

Implementation results on the same upstream base:

```
exact writable-enumerable-configurable-descriptor.js: pass
numeric mapped-arguments controls: 3/3 pass
focused Vitest/Test262 suite: 4/4 pass
TypeScript 7 typecheck: pass
Prettier check: pass
Oracle ratchet: pass
changed source LOC: 154 (≤180 cap)
```

The 20 non-owned #4699 descriptor controls remain 12/20 on both upstream and
the current descriptor-sidecar worktree. This formal-carrier slice leaves that
baseline unchanged and does not modify any #4699-owned file; the full 20-row
acceptance check remains a parent-lane integration gate after the descriptor
implementation is repaired/landed.

Combined integration validation was then run in disposable branch
`tmp/4701-with-4699`, merging the head of upstream PR #4924
(`codex/4699-es2015-mapped-arguments-descriptor-flags`) without carrying that
merge into this PR. The documented/default host `runTest262File` lane passed
the full matrix: 1 exact row + 20 #4699 descriptor controls + 3 numeric
controls = **24/24 pass**. The PR therefore depends on upstream #4924 for the
non-owned descriptor implementation; this branch contributes only formal
carrier widening and its exact/numeric regression tests.
