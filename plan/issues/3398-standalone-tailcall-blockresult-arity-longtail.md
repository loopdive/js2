---
id: 3398
title: "standalone: tail-call ABI mismatch / block-result fallthru / call arity / ref.test-cast long tail — invalid Wasm (~13 tests)"
status: ready
sprint: current
created: 2026-07-18
updated: 2026-07-18
priority: medium
feasibility: medium
reasoning_effort: high
model: fable
task_type: bugfix
area: codegen, emit
language_feature: private-fields, arrays, tail-calls
goal: standalone-mode
umbrella: 2039
related: [2039]
test262_bucket: standalone-invalid-wasm
test262_count: 13
es_edition: multi
---

# #3398 — tail-call / block-result / arity / ref.test long tail (child of #2039)

## Bucket

- **Records:** 13 (the structurally-distinct long tail — smaller mechanisms,
  each 1–6 rows; grouped because none warrants its own umbrella child).
- **Validator signatures:**
  - `return_call: tail call type error` — 3 (all `expressions/in/private-field-presence-*`, in `Parent_new`)
  - `type error in fallthru[0] (expected (ref null A), got (ref B))` — 4 (Array join / toLocaleString)
  - `not enough arguments on the stack for struct.new (need N, got M)` — 2 (Array.from)
  - `not enough arguments on the stack for call` — 1
  - `Invalid types for ref.test: local.tee of type externref has to be in the same rec group` — 2 (expressions)
  - `Invalid types for ref.cast null: extern.convert_any of type externref …` — 1
- **Area distribution:** expressions:6, Array:6, statements:1.
- **3 sample tests:**
  - `test/language/expressions/in/private-field-presence-method-shadowed.js`
    (`return_call: tail call type error` in `Parent_new`)
  - `test/built-ins/Array/prototype/join/S15.4.4.5_A3.2_T2.js`
    (`type error in fallthru[0] (expected (ref null 6), got (ref 118))`)
  - `test/built-ins/Array/from/source-object-iterator-1.js`
    (`not enough arguments on the stack for struct.new (need 2, got 1)`)

## Reproduced on current main

```
INVALID [in/private-field-presence-method-shadowed.js]:
  Compiling function #48:"Parent_new" failed: return_call: tail call type error @+28702
INVALID [Array/prototype/join/S15.4.4.5_A3.2_T2.js]:
  Compiling function #56:"test" failed:
  type error in fallthru[0] (expected (ref null 6), got (ref 118)) @+30746
```

## Root cause (four sub-mechanisms)

1. **`return_call` tail-call type error (3, private-field-in `Parent_new`).**
   A class constructor `Parent_new` returns via `return_call`/`return_call_ref`
   (tail-call optimization, CLAUDE.md pattern) whose callee result type does not
   match `Parent_new`'s declared result. The WAT shows
   `struct.new 46 local.tee 0 return_call …` — the tail call's signature differs
   from the enclosing function's result. Root: tail-call emission does not
   verify caller/callee result-type identity in the constructor path with
   private-field presence checks (`#x in obj`).

2. **Block-result fallthru mismatch (4, Array join/toLocaleString).** A block's
   declared result type is `(ref null 6)` (generic object) but the fallthru
   value is a non-null `(ref 118)` (a concrete struct). The block-type
   annotation and the produced value disagree — the array-iteration block result
   ValType is too narrow/wide. Root: the join/toLocaleString element-accumulator
   block type is computed inconsistently with the element push.

3. **`struct.new` arity (2, Array.from).** The `Array.from` source-iterator
   lowering pushes only 1 of the 2 fields `struct.new` needs — a missing operand
   push in the array/iterator materialization.

4. **`ref.test`/`ref.cast` rec-group violation (3, expressions).** An externref
   operand is fed to `ref.test`/`ref.cast $T` where `$T` is a GC type in a
   different rec group — externref is never castable to a GC struct directly;
   must `any.convert_extern` first. Root: a `ref.test`/`ref.cast` is emitted on
   a still-externref value without the `any.convert_extern` bridge (mirror of
   #3395 shape 3 but on the test/cast side).

## Implementation Plan

### Investigation anchors

- **Tail call (1):** grep `return_call` / `return_call_ref` emission in
  `src/codegen/statements.ts` / `src/codegen/index.ts` (return-position TCO).
  Add a result-type identity check: only emit `return_call` when callee result
  ValType === enclosing function result ValType; otherwise fall back to
  `call` + `return`. Focus on the constructor (`*_new`) path with `#x in obj`.
- **Block fallthru (2):** grep the Array `join` / `toLocaleString` lowering
  (`src/codegen/array-methods.ts`) for the accumulator block type. Align the
  block result type with the pushed element ValType (widen the block type to
  `(ref null 6)` on both sides, or cast the pushed value).
- **struct.new arity (3):** grep `Array.from` / iterator materialization
  (`array-methods.ts` / `expressions.ts`); find the `struct.new` with a dropped
  operand and push the missing field.
- **ref.test/cast rec-group (4):** grep the offending `ref.test`/`ref.cast`
  sites; insert `any.convert_extern` before testing/casting an externref to a
  GC type (use the `ref.test`-before-`ref.cast` guard from CLAUDE.md).

### Wasm IR patterns (targets)

```wasm
;; 1: only tail-call when result types match
call $callee                 ;; if result type != caller's, use call+return
return
;; 4: bridge externref before ref.test
local.get $x                 ;; externref
any.convert_extern           ;; -> anyref
ref.test $T                  ;; now legal
```

### Edge cases

- Tail-call fallback must preserve TCO where types DO match (don't disable it
  wholesale — it's load-bearing for deep recursion).
- `Array.from` with a custom `@@iterator` returning fewer values must still
  materialize a well-formed element struct.
- `ref.test` on a null externref → returns 0 (not a trap).

### Test files to verify

- `test/language/expressions/in/private-field-presence-method-shadowed.js`
- `test/built-ins/Array/prototype/join/S15.4.4.5_A3.2_T2.js`
- `test/built-ins/Array/from/source-object-iterator-1.js`
- Regression test `tests/issue-3398-tailcall-longtail.test.ts` (standalone +
  wasi + host-guard), one case per sub-mechanism.

## Acceptance criteria

- All 13 rows compile to valid Wasm (or refuse loudly).
- TCO preserved where result types match; no deep-recursion regression.
- No host-mode regression; equivalence tests green.
