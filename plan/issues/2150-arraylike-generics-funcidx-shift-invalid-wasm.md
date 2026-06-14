---
id: 2150
title: "standalone: Array.prototype generics over array-like receivers emit invalid Wasm — stale funcIdx baked before a late-import shift (emitWat/emitBinary divergence)"
status: done
sprint: Backlog
created: 2026-06-14
updated: 2026-06-14
completed: 2026-06-14
priority: high
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen, emit
language_feature: array-methods
goal: standalone-mode
related: [2036, 1448, 2149]
origin: "Surfaced by dev-b during #2036: standalone indexOf/lastIndexOf/includes/filter/map over an array-like receiver emit INVALID Wasm — emitWat output is well-formed but emitBinary bakes the wrong numeric funcIdx (`local.set[0] expected f64, found call externref` / `call[0] expected extern`). This was TaskList #16."
---

# #2150 — array-like generics: stale funcIdx baked before a late-import shift

## Problem

In `--target standalone`, `Array.prototype.indexOf/lastIndexOf/includes/filter/
map.call(arrayLike, …)` emit **invalid Wasm**. The compiler's `emitWat` output
is well-formed, but `emitBinary` produces a binary V8 rejects with
`local.set[0] expected f64, found call externref` (search methods) or
`call[0] expected extern` (filter/map). The function metadata (`f.typeIdx`,
`f.locals`, the type section) is all correct — only the emitted body's `call`
funcIdx is wrong.

## Root cause (addUnionImports late-shift hazard)

`compileArrayLikePrototypeCall` and `compileArrayLikePrototypeSearch`
(`src/codegen/array-methods.ts`) capture the per-element helper funcIdx —
`__extern_length` / `__extern_get_idx` / `__extern_has_idx` (+ `__host_eq` /
`__same_value_zero`) — at the TOP of the function via `ensureLateImport`. They
then compile the **receiver**, the **callback** / **search value**, the
**fromIndex**, and (for filter/map/reduce) register the result-array build
helpers (`__js_array_new` / `__js_array_push` / `__extern_set` / `__box_number`).
Each of those steps can register a NEW defined function, which **shifts every
defined-func index**. The funcIdx captured up-front therefore goes stale-low by
the shift delta, and the emitted `call <stale-idx>` targets the WRONG function
(e.g. indexOf's `__extern_length` call resolved to `__object_keys`, which
returns externref → `local.set <f64-local>` type error). Confirmed empirically:
`lenFn` captured = 130, current `funcMap.get("__extern_length")` = 131. `emitWat`
reprints the function by NAME so it looks valid, hiding the divergence.

## Fix

`src/codegen/array-methods.ts`:
- **Re-resolve** `__extern_length` / `__extern_get_idx` / `__extern_has_idx`
  (and the comparison helper) from `ctx.funcMap` (names are stable) AFTER the
  receiver / callback / fromIndex compiles, right before baking the `call`s —
  in both `compileArrayLikePrototypeCall` and `compileArrayLikePrototypeSearch`.
- **Pre-register** the result-array build helpers (`__js_array_new`,
  `__js_array_push`, `__extern_set`, `__box_number`) at the top, before the
  re-resolve, so their index shifts happen before the funcIdx are read (filter/
  map/reduce arms otherwise shift indices after the loop instrs are built).

## Acceptance criteria

- `WebAssembly.validate` passes for standalone indexOf / lastIndexOf / includes /
  filter / map / some / every / find / findIndex over an array-like receiver
  (was invalid for the search + filter/map paths). ✓ — `tests/issue-arraylike-
  search-funcidx-shift.test.ts` (6 passing).
- forEach/some/every/find/findIndex stay valid (no regression). ✓
- `emitBinary` and `emitWat` agree.

## Scope note

This fixes the **invalid-Wasm** class only. Full runtime correctness over a pure
`$Object` receiver additionally needs the #2036 `$Object` arm
(`__extern_length`/`__extern_get_idx`/`__extern_has_idx` reading `$Object`) and,
for `indexOf`/`includes`, the #2081 native loose-eq (`__host_eq` is a host import
with no standalone native yet). Both are tracked separately; #2150 is the
emit-layer prerequisite that stops the invalid-Wasm so those can land.
