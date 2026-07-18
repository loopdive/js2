---
id: 3396
title: "standalone: closure-env / promise-reaction / for-loop struct type A used where type B expected — struct.set/get/call-param invalid Wasm (~70 tests)"
status: ready
sprint: current
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
