---
id: 4699
title: "ES2015 mapped arguments descriptor flags and parameter-map synchronization"
status: done
sprint: current
created: 2026-08-25
updated: 2026-08-25
completed: 2026-08-25
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
  - src/runtime.ts
  - src/codegen/property-access.ts
  - src/codegen/expressions/assignment.ts
  - src/codegen/object-ops.ts
  - src/codegen/context/types.ts
func-budget-allow:
  - src/codegen/property-access.ts::compileElementAccessBody
  - src/codegen/expressions/assignment.ts::compileElementAssignment
  - src/codegen/object-ops.ts::compileObjectDefineProperty
  - src/runtime.ts::_safeSet
  - src/runtime.ts::resolveImport
related: [4695, 4444, 4658, 1511]
origin: "Split from blocked #4695: the coherent descriptor-flag/parameter-map subset excludes writable-enumerable-configurable-descriptor.js, whose string-valued inferred-f64 reverse-sync failure requires a separate ABI-widening issue."
---

# #4699 — ES2015 mapped arguments descriptor flags and parameter-map synchronization

## Scope

This issue owns the coherent 20-row subset of the bounded official mapped
arguments descriptor cluster from #4695. It covers descriptor flags and their
interaction with the mapped parameter map. The distinct
`writable-enumerable-configurable-descriptor.js` row is deliberately excluded:
its `{value: "foo"}` update exposes an inferred-`f64` formal parameter and
requires a separate closure-ABI widening change. Generator, async, host-import,
and unrelated array/object descriptor rows are out of scope.

**Source cap:** at most 180 changed source LOC. A fix that exceeds the cap or
crosses into parameter ABI widening must be split into a separately owned
issue.

## Exact 20-row artifact-derived scope

The parent issue's fresh `loopdive/js2wasm-baselines` `test262-current.jsonl`
artifact (fetched 2026-08-25, `oracle_version: 13`, `oracle_lane: honest`,
48,735 entries) recorded all 21 descriptor paths as failures. This split owns
the following exact 20 paths; the final path is explicitly excluded:

```
test262/test/language/arguments-object/mapped/enumerable-configurable-accessor-descriptor.js
test262/test/language/arguments-object/mapped/nonconfigurable-descriptors-basic.js
test262/test/language/arguments-object/mapped/nonconfigurable-descriptors-define-failure.js
test262/test/language/arguments-object/mapped/nonconfigurable-descriptors-set-value-by-arguments.js
test262/test/language/arguments-object/mapped/nonconfigurable-descriptors-set-value-with-define-property.js
test262/test/language/arguments-object/mapped/nonconfigurable-descriptors-with-param-assign.js
test262/test/language/arguments-object/mapped/nonconfigurable-nonenumerable-nonwritable-descriptors-basic.js
test262/test/language/arguments-object/mapped/nonconfigurable-nonenumerable-nonwritable-descriptors-set-by-arguments.js
test262/test/language/arguments-object/mapped/nonconfigurable-nonenumerable-nonwritable-descriptors-set-by-param.js
test262/test/language/arguments-object/mapped/nonconfigurable-nonwritable-descriptors-basic.js
test262/test/language/arguments-object/mapped/nonconfigurable-nonwritable-descriptors-define-property-consecutive.js
test262/test/language/arguments-object/mapped/nonconfigurable-nonwritable-descriptors-set-by-arguments.js
test262/test/language/arguments-object/mapped/nonconfigurable-nonwritable-descriptors-set-by-param.js
test262/test/language/arguments-object/mapped/nonwritable-nonconfigurable-descriptors-basic.js
test262/test/language/arguments-object/mapped/nonwritable-nonconfigurable-descriptors-set-by-arguments.js
test262/test/language/arguments-object/mapped/nonwritable-nonconfigurable-descriptors-set-by-param.js
test262/test/language/arguments-object/mapped/nonwritable-nonenumerable-nonconfigurable-descriptors-basic.js
test262/test/language/arguments-object/mapped/nonwritable-nonenumerable-nonconfigurable-descriptors-set-by-arguments.js
test262/test/language/arguments-object/mapped/nonwritable-nonenumerable-nonconfigurable-descriptors-set-by-define-property.js
test262/test/language/arguments-object/mapped/nonwritable-nonenumerable-nonconfigurable-descriptors-set-by-param.js
```

The excluded row is:

```
test262/test/language/arguments-object/mapped/writable-enumerable-configurable-descriptor.js
```

The three adjacent non-descriptor controls are:

```
test262/test/language/arguments-object/mapped/mapped-arguments-nonconfigurable-1.js
test262/test/language/arguments-object/mapped/mapped-arguments-nonconfigurable-2.js
test262/test/language/arguments-object/mapped/mapped-arguments-nonconfigurable-4.js
```

## Baseline on current upstream/main

The exact 20 rows plus the three controls were rerun serially with
`runTest262File` on `upstream/main` commit `028eb69ae` (2026-08-25). The
descriptor rows were **20/20 fail** and the controls were **3/3 pass**. The
dominant live signatures were default descriptor flags (`enumerable`,
`writable`, and/or `configurable`) rather than the requested values; mapped
value divergence also appeared where an argument write or parameter write
followed a descriptor operation. The excluded row independently failed with
`NaN` versus `"foo"`, confirming that it belongs to the ABI-widening follow-up.

The parent #4695 record and commit `555d1e2e1` document the measured candidate
that repaired all 19 descriptor rows plus the controls while intentionally
leaving that excluded string-valued row untouched. This issue reconstructs
only that coherent candidate; it must not broaden the inferred formal's type.

## Implementation plan

1. Inspect the mapped-arguments descriptor and parameter-map paths in the
   current source and verify the representative emitted behavior for basic,
   non-writable/non-configurable, parameter-write, arguments-write, accessor,
   and define-property rows.
2. Reconstruct the narrow descriptor-sidecar/parameter-map synchronization
   change evidenced by #4695, with no edits to generator, async, host-import,
   closure-ABI widening, or general array/object descriptor machinery.
3. Add focused regression coverage only for the demonstrated mapped-arguments
   root cause. Keep the source diff at or below 180 changed source LOC.
4. Rerun all 20 exact rows and all three controls serially, then run the
   scoped prepush checks and confirm the excluded row remains excluded and
   unchanged. Any exact-row miss, control regression, or source-cap breach
   blocks this split and must result in no PR.

## Controls and acceptance

- All 20 exact official rows pass on current `upstream/main` plus this branch.
- `mapped-arguments-nonconfigurable-{1,2,4}.js` remain passing.
- `writable-enumerable-configurable-descriptor.js` is not changed or counted;
  its string-valued inferred-`f64` reverse-sync defect remains for a follow-up.
- No generator, async, host-import, closure-ABI, or unrelated descriptor
  behavior changes.
- Changed source LOC is no more than 180, and the implementation is one
  measured mapped-arguments descriptor/parameter-map root cause.
- The issue records exact before/after outcomes, controls, source diff size,
  and validation commands before handoff.

## Baseline Results

Baseline only (upstream/main `028eb69ae`, before source changes):

```
20/20 exact rows fail
3/3 controls pass
excluded writable-enumerable-configurable-descriptor.js: fail (NaN vs "foo")
```

## Test Results

The recovered bounded candidate was validated serially on this branch:

```
20/20 exact rows pass
3/3 controls pass
excluded writable-enumerable-configurable-descriptor.js: fail (NaN vs "foo")
```

Command:

```
node --import tsx --input-type=module -e '<serial runTest262File over the exact 20 rows and three controls>'
```

The source diff is 169 additions and 8 deletions (177 changed source LOC),
within the 180-LOC cap. The implementation is limited to mapped-arguments
accessor routing, vector descriptor sidecars/host MOP fidelity, and preserving
default flags for existing mapped elements. No formal-parameter ABI widening
was added; the excluded string-valued row remains the known `f64` reverse-sync
follow-up.

The owned `runtime.ts` surface measures 18,063 lines after the merge-queue
regression repair narrowed descriptor-aware proxying to mapped arguments with
indexed overrides, so the host-import policy ceiling moves from 17,949 to that
exact measurement. The native-first import, legacy-semantic, unknown-import,
resolver, and adapter ceilings remain unchanged.
