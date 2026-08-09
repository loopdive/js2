---
id: 3396
title: "standalone: closure-env / promise-reaction / for-loop struct type A used where type B expected — struct.set/get/call-param invalid Wasm (~70 tests)"
status: done
completed: 2026-07-23
sprint: 75
created: 2026-07-18
updated: 2026-07-18
priority: high
feasibility: hard
reasoning_effort: max
model: fable
task_type: bugfix
area: codegen, closures
language_feature: closures, promises, for-loops, private-fields
goal: standalone-mode
umbrella: 2039
related: [2039]
test262_bucket: standalone-invalid-wasm
test262_count: 70
es_edition: multi
loc-budget-allow:
  # (#3396) The fwd-ref boxed-capture re-type guard adds an 18-line explanatory
  # comment + the `!boxedCaptures.has(name)` condition to the pre-hoisted-slot
  # re-type block; this is the correct home for the fix (the re-type block IS in
  # variables.ts) and cannot move to a subsystem module. +17 over the god-file
  # ceiling is intended.
  - src/codegen/statements/variables.ts
---

# #3396 — closure/reaction-record struct TYPE mismatch (child of #2039)

## Bucket

- **Records:** 70 (the largest and most heterogeneous child — likely fans out
  into further slices after the first mechanism is fixed).
- **Validator signatures (all "a GC struct of type A used where type B
  expected"):**
  - `struct.set[0] expected type (ref null A), found local.get of type (ref null B)` — 24 (Promise:13 dominant)
  - `call[N] expected type (ref null A), found local.get of type externref` — 18 (for/for-in/reference closures)
  - `struct.get[0] expected type (ref null A), found local.get of type (ref null B)` — 5 (DataView)
  - `call[N] expected (ref null A), found local.get of (ref null B)` — 3
  - `local.set expected (ref null A), found ref.as_non_null of (ref null B)` — 2 (eval-code)
  - `i32.ge_s expected i32, found struct.get of (ref null B)` — 4 (a struct field read where the field type is itself wrong)
  - assorted `local.tee` / `call_ref` / `global.get` / `f64.const`-into-struct-slot stragglers (~14)
- **Area distribution:** statements:26, Promise:13, expressions:12, String:6,
  DataView:3, eval-code:2, rest-parameters:2, Function/Object/Array/types/
  TypedArray/language:1 each.
- **3 sample tests:**
  - `test/built-ins/Promise/any/capability-executor-not-callable.js`
    (`struct.set[0] expected (ref null 121), found local.get of (ref null 6)`)
  - `test/language/statements/for-in/scope-body-lex-open.js`
    (`struct.set[0] expected (ref null 121), found local.get of (ref null 6)`)
  - `test/language/types/reference/S8.7_A4.js`
    (`call[0] expected (ref null 6), found local.get of type externref`)

## Reproduced on current main

```
INVALID [Promise/any/capability-executor-not-callable.js]:
  Compiling function #57:"test" failed:
  struct.set[0] expected type (ref null 121), found local.get of type (ref null 6) @+30486
INVALID [for-in/scope-body-lex-open.js]:
  Compiling function #77:"test" failed:
  struct.set[0] expected type (ref null 121), found local.get of type (ref null 6) @+34540
INVALID [types/reference/S8.7_A4.js]:
  Compiling function #55:"test" failed:
  call[0] expected type (ref null 6), found local.get of type externref @+28681
```

Note the recurring `(ref null 6)` — that struct index shows up as both the
found-type in `struct.set` mismatches and the expected-type in `call`
mismatches, strongly suggesting a **single closure-environment struct** whose
type is resolved inconsistently between the capture-site and the use-site.

## Root cause (hypothesis — two overlapping mechanisms)

1. **Closure-environment struct identity drift.** When a closure captures
   variables (for-loop per-iteration bindings `scope-body-lex-open`, `for`
   `S12.6.3`, references `S8.7`), the env is a GC struct. The `struct.set` that
   stores a captured value, and the `call`/`struct.get` that later reads it, are
   resolving the env struct type to **different type indices** (A vs B) — or one
   side has boxed the env to externref (`found local.get of type externref`)
   while the other expects the concrete struct. This is a **ref-cell / closure
   capture struct-type propagation** bug: the ref-cell `struct (field $value
(mut T))` layout (CLAUDE.md pattern) is being emitted/looked-up with a
   mismatched field type on one arm.

2. **Promise reaction-record struct.** The Promise cluster (13 rows) stores a
   value of struct type B (e.g. a callback closure or `(ref null 6)` generic
   object) into a reaction-record field typed `(ref null 121)`. The reaction
   record's field type and the value's type disagree — a missing `ref.cast` (or
   a wrong field ValType) in the Promise-capability / reaction lowering.

Both reduce to: **a GC value is stored/passed at its "wrong" static struct type
because one side resolved the layout to a different type index (or to
externref).** `ref.test`-before-`ref.cast` (CLAUDE.md) is the standard guard —
the emitting site is skipping the cast entirely.

## Implementation Plan

### Investigation (do this first — the 70-row bucket needs sub-slicing)

1. Compile the 3 samples with `--target standalone`, dump WAT around the cited
   `@+offset`, and identify which struct type indices A/B are (`(ref null 6)`,
   `(ref null 121)`) via the module's type section. This tells you whether A/B
   are two DIFFERENT env structs or the SAME struct resolved twice.
2. Split the bucket after step 1: the Promise reaction-record family (13) is
   likely a distinct fix from the closure-env family (~40) and the DataView
   struct.get family (5). File follow-up children under this umbrella if the
   root causes diverge.

### Likely change sites

- **Closure capture / ref-cell:** `src/codegen/index.ts` (closure env struct
  construction) and `src/codegen/expressions.ts` (capture read/write). Grep
  `refCell`, `env`, `capture`, `struct (field $value`. Ensure the env struct
  TYPE INDEX is resolved once (single source) and reused at both the set and the
  read; add `ref.test`+`ref.cast` when a captured value's concrete type is
  narrower than the field type.
- **Promise reactions:** grep the Promise capability / reaction-record lowering
  in `src/runtime.ts` / `src/codegen/*` (`reaction`, `capability`,
  `PromiseReaction`). Align the reaction-field ValType with the stored callback
  value's ValType, or cast the value to the field type before `struct.set`.
- **`call … found externref`:** where a closure body param is a concrete env
  struct but the call site passes an externref, insert
  `any.convert_extern` + `ref.cast $Env` (guarded by `ref.test`).

### Wasm IR pattern (target)

```wasm
;; storing a captured value into a ref-cell (types must match the field decl)
local.get $env               ;; (ref null $Env)
local.get $val               ;; (ref null $Val)  -- if narrower than field, cast:
;; ref.test $Field / ref.cast $Field before struct.set when needed
struct.set $Env $field
```

### Edge cases

- A captured value legitimately typed `(ref null 6)` (generic object) into a
  narrower field must NOT be force-cast if it can be null — use nullable casts
  (`ref.cast null`).
- externref-boxed env: unbox with `any.convert_extern` before `ref.cast`.
- Do not widen field types blindly (breaks other readers) — prefer casting the
  value to the field's declared type.

### Test files to verify

- `test/built-ins/Promise/any/capability-executor-not-callable.js`
- `test/language/statements/for-in/scope-body-lex-open.js`
- `test/language/types/reference/S8.7_A4.js`
- Regression test `tests/issue-3396-closure-struct-type.test.ts` (standalone +
  wasi + host-guard).

## Acceptance criteria

- All 70 rows compile to valid Wasm (or refuse loudly), OR the bucket is
  sub-sliced into further children with per-mechanism fixes landing incrementally.
- Closure capture semantics preserved (equivalence tests for for-loop closures,
  Promise chaining).
- No host-mode regression.

---

## Investigation + MINIMAL REPRO (fable-dev-2, 2026-07-18)

**Branch**: `issue-3396-closure-struct-type` (based on PR #3328 head, which adds
this file). Reproduced the exact bucket signature `struct.set[0] expected type
(ref null A), found local.get of type (ref null B)` — the recurring `(ref null
6)` from the plan confirmed as the FOUND type.

### The closure-env family (~40 rows) is minimized to TWO LINES — no test262 harness needed

```ts
export function test(): number {
  var pf: any = function () {
    return x;
  }; // closure captures x BEFORE its decl
  let x = "o"; // let, REF-typed initializer (string)
  return 1;
}
```

→ `--target standalone` emits INVALID Wasm:
`struct.set[0] expected type (ref null 43), found local.get of type (ref null 6)`.

The 3 cited test262 samples (`for-in/scope-body-lex-open.js`,
`Promise/any/capability-executor-not-callable.js`, `types/reference/S8.7_A4.js`)
were curled from tc39/test262@`63829c6d` (the pinned submodule rev) and
confirmed; `scope-body-lex-open` reduces to exactly the above (its
`var probeBefore = function(){ return x; }; let x = 'outside';` forward-capture
is the trigger — the for-in destructuring is NOT required).

### Trigger matrix (what flips valid ↔ invalid)

| shape                                         | valid?      |
| --------------------------------------------- | ----------- |
| fwd closure over `let x = "o"` (string)       | **INVALID** |
| closure AFTER `let x = "o"` (normal order)    | valid       |
| fwd closure over `var x = "o"` (hoisted)      | valid       |
| fwd closure over `let x = 5` (number/f64)     | valid       |
| fwd closure over `let x: any` (uninitialised) | valid       |
| fwd ARROW closure over `let x = "o"`          | **INVALID** |
| two fwd closures over the same `let x = "o"`  | **INVALID** |

**Necessary + sufficient trigger:** a `let`/`const` binding with a **ref-typed
(externref/string/object) initializer**, captured by a closure that appears
**BEFORE** the binding's declaration in source order (a forward / TDZ-adjacent
reference). `var` (hoisted, function-scoped) and scalar (f64 number) bindings and
uninitialised/`any` bindings all avoid it.

### Root cause (localized)

The mutable-capture **ref-cell** struct type drifts between two sites:

- **forward-capture site** (closure created BEFORE `let x`): `x`'s type is not
  yet resolved, so `cap.valType` falls back to the GENERIC boxed type →
  `getOrRegisterRefCellType(ctx, cap.valType)` yields the generic ref-cell
  `(ref null 6)` (`refCellValueType` fallback, closures.ts:49/552).
- **declaration/init site** (`let x = "o"` → `struct.set $cell $value`): `x`'s
  ref-cell is now resolved to the STRING-typed cell `(ref null 43)`.

The `struct.set` at the init site uses the properly-typed cell (43) but the
value/cell threaded from the forward-capture path is the generic (6) → arity/type
mismatch → invalid module. (Symmetric `call[N] expected (ref null A), found
externref` rows are the same drift where one side boxed the cell to externref.)

### Anchors for the fix

- `src/codegen/closures.ts:552` `getOrRegisterRefCellType(ctx, cap.valType)` and
  `:49` `refCellValueType` (the #3328 boxed-capture valType fallback) — the
  ref-cell TYPE must be resolved from the binding's DECLARED type consistently at
  BOTH the forward-capture site and the init `struct.set`, OR both sites must use
  the generic cell + a cast. Today the forward site gets the fallback and the
  init site gets the resolved type.
- The capture-collection pass that computes `cap.valType` for a forward-referenced
  `let`/`const`: it should look up the binding's declaration type (the checker/
  oracle type of the later `let x = …`) rather than defaulting to the generic box
  when the reference precedes the declaration.

### Fix direction (proposed, unverified)

Make `cap.valType` for a forward-referenced `let`/`const` capture resolve to the
binding's declared type (from its `VariableDeclaration`, via `ctx.oracle` /
`resolveSpillLocalValType`-style lookup) so the forward-capture ref-cell and the
init `struct.set` agree. Alternative (lower-risk): when a capture is a
forward-reference, type its ref-cell GENERICALLY (externref `$value`) on BOTH the
struct-field decl and the init store, and `ref.cast` on read — matches the
uninitialised/`any` case which is already valid.

### Sub-slicing (per the plan's step 2)

- **Closure-env forward-capture family (~40, statements/expressions/reference):**
  the above — ONE mechanism, minimal repro in hand.
- **Promise reaction-record family (13):** NOT reduced here (my minimal
  Promise probes compiled valid) — likely a distinct reaction-field ValType
  mismatch; needs its own reduction (curl `capability-executor-not-callable.js`
  is fetched in `.tmp/3396/`).
- **DataView struct.get family (5):** separate, not investigated.

Remaining work: implement + validate the closure-env fix (equivalence tests for
forward-captured let/const closures across string/object types; no host
regression), then re-measure the bucket and sub-slice the Promise/DataView
remainder.

---

## FIX (fable-dev-5, 2026-07-18, same-team continuation on this branch)

**Exact mechanism (one level deeper than the fix-direction above — neither of
the two proposed directions was needed):** the forward-capture site and the
init site were NOT independently resolving the cell type. Instrumentation
(`allocLocal` + construction + init-store traces) showed the closure
construction (`emitClosureConstruction`, closures/arrow-phases.ts) correctly
allocates `__boxed_x` as `(ref_null <cell>)` and re-aims `localMap[x]` at it,
with `boxedCaptures[x] = {cell, valType}` consistent. The drift happens
AFTERWARD, in the **declaration's pre-hoisted-slot re-type block**
(`variables.ts` ~1268, "If we reused a pre-hoisted slot but inference found a
more precise type"): it resolves `existingIdx = localMap.get(name)` — which
after the re-aim is the CELL slot — and its default arm MUTATES that slot's
declared type to the let's VALUE type (`(ref 6)`). Every already-emitted
`local.tee` (closure construct) and the box-aware init `struct.set` then
disagree with the slot: `struct.set[0] expected (ref null <cell>), found
local.get of type (ref null <value>)`. Why the matrix holds: `var` hoisted
slots aren't re-aimed before their decl (the closure boxes lazily at
construct, but `var x` decl runs FIRST in source order → normal-order valid);
f64 initializers hit the `existingIsRef && newIsPrimitive` refusal arm; `any`
keeps kind-equal externref → no mutation.

**Fix (1 guard):** skip the entire re-type block when
`fctx.boxedCaptures?.has(name)` — the slot is the ref-cell box and must keep
the cell type; the `boxedForInitStore` write below is already cell-aware.
Mirrors the explicit `boxedCaptures` skips the #3037 any-object-carrier and
#3097 TA-view arms in the same function already carry (the default arm and
the block itself lacked the guard).

**Validated:**

- `tests/issue-3396-closure-struct-type.test.ts` (8): 2-line repro valid;
  read-through/mutation-through cell; fwd arrow + const object; TWO fwd
  closures sharing one cell; normal-order guard; fwd-number guard;
  non-captured re-type still applies.
- probeBefore family (all 30 `scope-*-open` test262 files, standalone, vs
  base): 3 × compile_error(INVALID-WASM) → fail (de-masked), 0 regressions.
  The de-masked residual is the per-iteration/TDZ ReferenceError machinery
  (`dereferencing a null pointer in assert_throws()` — a null-cell deref
  instead of a thrown ReferenceError on an in-TDZ read through a captured
  cell) — a SEPARATE mechanism, not this slice.
- `language/statements/{for-in,let,const}` (121 files): 1 flip
  (scope-body-lex-open CE→fail), 0 regressions.
- Closure-capture suites (585/1528/2029/2623/2692/3024/3121/flatmap): failures
  identical base↔branch (7 pre-existing in this darwin env — timing-only
  diff), 0 new.

**Sub-buckets remaining (unchanged, per the sub-slicing above):**
`call[N] … found externref` family (18 — e.g. `S8.7_A4.js`, no closures
involved: `new String` wrapper + `+=`; different mechanism), Promise
reaction-record (13 — sample now fails on `env::Promise_any` host-import leak
#2961, also not this mechanism), DataView struct.get (5), TDZ-ReferenceError
null-deref residual (the de-masked probeBefore fails).
