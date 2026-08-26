---
id: 4745
title: "ES2015 Reflect.deleteProperty host closed-struct tombstone"
status: done
sprint: current
created: 2026-08-26
updated: 2026-08-26
completed: 2026-08-26
priority: high
horizon: s
feasibility: medium
reasoning_effort: medium
task_type: bug
area: runtime, codegen, conformance
es_edition: es6
language_feature: Reflect.deleteProperty
goal: test262-conformance
source_loc_cap: 180
loc-budget-allow:
  - src/runtime.ts
  - src/runtime/wasm-struct-host-semantics.ts
  - src/codegen/source-scan-predicates.ts
  - src/codegen/index.ts
  - src/codegen/context/types.ts
  - src/codegen/object-ops.ts
func-budget-allow:
  - src/runtime.ts::_wrapForHost
  - src/codegen/source-scan-predicates.ts::scanMemberDeletes
  - src/codegen/index.ts::generateModule
  - src/codegen/object-ops.ts::compilePropertyIntrospection
related: [4129, 2046, 4742, 4744]
origin: "ES2015 residual census on upstream/main 8ddcd9b2b; distinct from the active Date.parse (#4742) and Array iterator (#4744) slices."
---

# #4745 — host `Reflect.deleteProperty` closed-struct tombstone

## Scope

This issue owns the host/WasmGC residual in the two ES2015 rows below. A
compiled object literal is a fixed-shape WasmGC struct. Host
`Reflect.deleteProperty` wraps that struct in `_wrapForHost`, but the proxy's
delete trap previously removed only sidecar entries. The fixed field therefore
remained visible to the compiled `hasOwnProperty` shape fold.

The standalone non-`$Object` `Reflect.deleteProperty` refusal is already tracked
by #4129/#2046 and is deliberately not changed here.

## Exact rows and baseline

Measured on `upstream/main` `9efc8e766` (the source-equivalent scheduled
baseline-sync successor of `8ddcd9b2b`) with the authoritative assembled
`runTest262File` runner and the pinned Test262 checkout:

```text
test/built-ins/Reflect/deleteProperty/delete-properties.js
  host: fail — Expected SameValue(«true», «false») at o.hasOwnProperty('prop')
  standalone: fail — TypeError: Reflect.deleteProperty called on non-object

test/built-ins/Reflect/deleteProperty/return-boolean.js
  host: fail — Expected SameValue(«true», «false») at Reflect.deleteProperty(o, 'p1')
  standalone: pass
```

The host failures are one family: the call is routed through the host proxy,
while the subsequent closed-struct own-property call is compile-time folded.
The standalone failure is an excluded, pre-existing ownership boundary.

Adjacent host controls were passing on the baseline and remain controls:

```text
delete-symbol-properties.js: pass
target-is-not-object-throws.js: pass
target-is-symbol-throws.js: pass
```

## Bounded implementation plan

1. Make `_wrapForHost`'s WasmGC delete trap mirror `__delete_property`: honor
   frozen/sealed and non-configurable descriptor state, remove sidecar and
   accessor metadata, and record a `_wasmStructDeletedKeys` tombstone. During
   module initialization the export view may not yet expose the struct shape;
   an unresolved delete is recorded so the later host own-property query sees
   the operation.
2. Extend the existing cheap source pre-scan to recognize
   `Reflect.deleteProperty(receiver, key)`. For host modules containing that
   spelling, route `receiver.hasOwnProperty(key)` through the host predicate
   instead of folding from the immutable struct shape. Existing delete-free
   modules retain the no-scan/no-runtime-call path; standalone behavior keeps
   its current native lowering.
3. Add exact Test262 pins plus symbol/target-validation and standalone controls.
   Do not widen standalone Reflect support or touch the active #4742/#4744
   implementation files.

## Acceptance

- Both exact host rows pass, including the frozen false-return assertion.
- Adjacent host controls and the standalone boolean-return control remain green.
- The standalone non-`$Object` row remains attributed to #4129/#2046.
- Production source delta remains ≤180 changed lines.
- TS5, TS7, lint, format, focused tests, issue checks, budgets, hooks, and
  post-upstream-merge validation pass.

## Test Results

Baseline on upstream/main `9efc8e766`:

```text
host exact rows: 0/2 pass
standalone controls: delete-properties fail (owned by #4129/#2046), return-boolean pass
adjacent host controls: 3/3 pass
```

Implementation on merged upstream `9efc8e766`:

```text
host exact rows: 2/2 pass
adjacent host controls: 3/3 pass
standalone return-boolean control: pass
focused Vitest/Test262 suite: 6/6 pass
TypeScript 5 check: pass
TypeScript 7 check: pass
Prettier check: pass
LOC budget: pass, net +60 production LOC (≤180 cap)
function budget: pass
issue-ID and issue/spec checks: pass (repository warnings are pre-existing)
```

Biome lint reports eight pre-existing diagnostics in unrelated lines of the
large `src/runtime.ts` file; the new `tests/issue-4745.test.ts` is lint-clean,
and no diagnostic overlaps the changed ranges.
