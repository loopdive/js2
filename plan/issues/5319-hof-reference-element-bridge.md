---
id: 5319
title: "array.filter(Boolean) drops every element when the elements are references"
status: done
sprint: current
created: 2026-09-05
updated: 2026-09-05
completed: 2026-09-05
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: correctness
# 2026-09-05 — both grown files are the ones that OWN this decision and there is
# no subsystem module to move it to: the bridge choice lives beside
# `setupArrayCallback` (array-methods.ts) and its pre-scan arming lives beside
# the other functional-array import triggers (import-collector.ts). The growth is
# +54 / +13 lines, of which the large majority is the root-cause comment
# explaining WHY `__is_truthy` must be registered at bridge-selection time rather
# than inside `buildToBooleanInstrs` — the ordering hazard that would otherwise be
# re-introduced by the next editor. Executable growth is 7 hoisted `const bridge`
# lines, one 20-line predicate function (which NET-REMOVES #4527's inline copy),
# and two 3-line arms in the truthy/falsy builders.
loc-budget-allow:
  - src/codegen/array-methods.ts
  - src/codegen/declarations/import-collector.ts
---

## Problem

`["x", "y"].filter(Boolean)` compiled to Wasm returns `[]`. So does
`"a,b,,c".split(",").filter(Boolean)`, `[{}, {}].filter(Boolean)`, and
`["x","skip","y"].filter(o.keep)`. `.filter(Boolean)` is one of the most common
idioms in published JS, so this is broad correctness, not one package.

Measured through the npm dogfood harness before the fix (native vs Wasm):

| case | native | Wasm |
| --- | --- | --- |
| `["x","y"].filter(Boolean).length` | 2 | **0** |
| `[{},{}].filter(Boolean).length` | 2 | **0** |
| `["x","y"].filter(String).length` | 2 | **0** |
| `"a,b,,c".split(",").filter(Boolean).length` | 3 | **0** |
| `["","y"].some(Boolean)` | true | **false** |
| `["x","y"].every(Boolean)` | true | **false** |
| `["","y"].find(Boolean)` | `"y"` | **null** |
| `["","y"].findIndex(Boolean)` | 1 | **-1** |
| `["x","y"].filter(s => !!s).length` | 2 | 2 (control) |
| `[1,0,2,null,3].filter(Boolean).length` | 3 | 3 (control) |

## Root cause

`setupArrayCallback` (`src/codegen/array-methods.ts`) has two lanes. A callback
that compiles to a wasm closure is invoked with `call_ref`; anything else falls
back to a **host bridge**, and the default bridge is numeric:

```
__call_1_f64 : (externref callee, f64 arg) -> f64
```

`buildBridgeCallInstrs` therefore pushes the loop element through
`bridgeElemConvertInstrs`, which for a reference element emits
`call __unbox_number` — ToNumber. The emitted loop for
`["x","y"].filter(Boolean)` was literally:

```wat
local.get $data
local.get $i
array.get $__arr_externref   ;; the string element
local.set $el
local.get $cb                ;; Boolean
local.get $el
call $__unbox_number         ;; "x" -> NaN   <-- the defect
call $__call_1_f64           ;; Boolean(NaN) -> 0
f64.abs
f64.const 0
f64.gt                       ;; falsy -> element dropped
```

Every element became `NaN`, `Boolean(NaN)` is `false`, so the result was empty.

**#4527 already fixed exactly this — for `map` only.** It added the
reference-preserving `__call_dyn_1` bridge
(`(externref callee, externref arg) -> externref`, passes the value LIVE) and
armed it from an import pre-scan gated on `method === "map"`. `filter`,
`forEach`, `find`, `findIndex`, `some` and `every` lower the *same*
`setupArrayCallback` fallback and were never routed to it.

**"Unresolved callback" is much broader than the builtin case that surfaced
it.** Only a syntactically inline arrow / function expression, or a hoisted
function *declaration*, compiles to a closure. All of these fall back to the
bridge and were therefore broken:

- a bare ambient builtin — `filter(Boolean)`, `filter(String)`
- a `var`-bound function expression — `var keep = function (s) {…}`
- an object member — `filter(o.keep)`
- a cross-module imported function

## Fix

1. **`src/codegen/declarations/import-collector.ts`** — the `__call_dyn_1`
   pre-scan trigger widens from `method === "map"` to
   `DYNAMIC_ELEMENT_BRIDGE_METHODS = {map, filter, forEach, find, findIndex,
   some, every}`. Everything else about the trigger is unchanged (host lane
   only, non-inline callback only, receiver must carry reference elements).
2. **`src/codegen/array-methods.ts`** — `#4527`'s inline predicate is lifted into
   `referenceElementBridgeName(ctx, elemType, consumesResultAsBoolean)` and used
   at all seven call sites.
3. **`buildTruthyCheck` / `buildFalsyCheck`** — on the dynamic bridge the
   callback result is an opaque `externref`, so ToBoolean routes through
   `__is_truthy` instead of the `|x| > 0` f64 ladder. Without this the module
   does not merely answer wrongly, it fails Wasm validation.

### Why the `__is_truthy` registration happens in `referenceElementBridgeName`

`emitToBoolean`'s externref arm calls `ensureLateImport("__is_truthy", …)`,
which **shifts every defined-function index** when it actually registers. The
truthiness instructions are built by `buildCallAndCheck` *after* the call
instructions, into a plain `Instr[]` that is attached to the function body only
later — so a shift fired from inside `buildToBooleanInstrs` would not walk the
already-built array and would leave its baked `call` funcIdx values stale.
Registering via `addUnionImports` at bridge-selection time — before the callback
expression is even compiled — makes the later lookup a pure `funcMap` read.

### Blast radius

`referenceElementBridgeName` returns `undefined` unless `__call_dyn_1` is in
`funcMap`, and that import is added only when the pre-scan fires. A module with
no non-inline-callback reference-element HOF call therefore compiles
**byte-identically** to before.

## Deliberately NOT in scope (separately reproduced on the same head)

These are different lowering paths with different root causes. Each was
confirmed broken both before and after this change, i.e. this PR neither fixes
nor regresses them:

- **`reduce` / `reduceRight` with an unresolved callback over reference
  elements** — 2-arg callbacks use `__call_2_f64`; there is no `__call_dyn_2`
  bridge to route to. `function cat(a,b){return a+b}; ["x","y"].reduce(cat,"")`
  answers `NaN`.
- **`sort(cmp)` with a non-inline comparator** — `["b","a"].sort(cmp)` with a
  hoisted `cmp` leaves the array unsorted. `sort` does not use
  `setupArrayCallback`; inline arrows and the no-arg form are correct.
- **`findLast` / `findLastIndex`** — not members of `FUNCTIONAL_ARRAY_METHODS`,
  so neither the numeric nor the dynamic bridge is armed for them at all.
  `["","y"].findLast(Boolean)` answers `undefined`.
- **`ref` / `ref_null` element arrays (object-struct, native-string) under the
  gc HOST lane** — `hofElemKindOk` / `refElemHofCallbackIsClosure`
  (array-methods.ts ~L2260) refuse the native HOF lane for a non-closure
  callback and fall through to a lowering that is a *silent no-op*: for
  `[{v:1}, null, {v:2}].filter(Boolean)` codegen emits
  `__extern_get "filter"; drop; <callback>; drop; ref.null extern`. This is the
  documented #3126 residual. Widening that gate is the change #2838 showed can
  flip ~212 Temporal test262 tests, so it needs its own PR and its own
  merge-group validation.

## Acceptance criteria

- [x] `["x","y"].filter(Boolean).length === 2` in Wasm, from an untyped `.js`
      module in a two-file project (annotating the array routes to a different
      arm and passes with or without the fix).
- [x] Same for `some` / `every` / `find` / `findIndex` / `forEach`, and for
      `var`-bound and object-member callbacks.
- [x] Numeric-element HOFs keep the compact numeric bridge (control case).
- [x] `map` (#4527's arm) unchanged.
- [x] No npm dogfood suite regresses.

## Evidence

- `tests/issue-5319-hof-reference-element-bridge.test.ts` — **14 failed / 3
  passed** on the unmodified parent, **17 passed** with the fix. The 3 that pass
  on the parent are the intended controls (numeric bridge, `every`-false,
  `map`).
- npm dogfood A/B at one head over `webpack three clsx cookie lodash redux axios
  stylelint tailwindcss jsdom styled-components uuid marked moment prettier jest
  hono` — see the PR body for the per-file `native; Wasm` comparison.
