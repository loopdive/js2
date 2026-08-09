---
id: 3916
title: "`Array.from(<non-vec source>).map(<compiled closure>)` traps `illegal_cast` — uncatchable, present on main"
status: ready
sprint: current
created: 2026-07-31
updated: 2026-07-31
priority: high
horizon: m
feasibility: medium
task_type: bugfix
area: codegen
language_feature: array-builtins
goal: crash-free
related: [3643, 3596, 3888]
origin: "Isolated while unparking PR #3888 (#3643 Slice B). The trap-ratchet flagged one newly-trapping file; the trap turned out to be pre-existing on main and unrelated to that PR, which merely advanced a test far enough to reach it."
---

# #3916 — `Array.from(x).map(fn)` traps `illegal_cast` when `x` is not a vec

## Summary

`Array.from(<source>)` returns a **host JS array** for every source that is not a
WasmGC vec. Calling `.map(<compiled closure>)` on that result **traps**
`illegal cast` — an **uncatchable** failure, strictly worse than an exception.

This is **present on `main` today**, independent of any open PR:

```js
Array.from("ab").map(function (x) {
  return 1;
}); // RuntimeError: illegal cast
```

## Measured, 2026-07-31

Every row run through `runTest262File` (the harness path, not a bare compile).
The "main" column was produced by checking `origin/main`'s `src/runtime.ts` into
the branch and re-running — **not** inferred.

| probe                                     | PR #3888 branch | `origin/main` |
| ----------------------------------------- | --------------- | ------------- |
| `Array.from("ab")` (no `.map`)            | pass            | pass          |
| `Array.from(["a","b"]).map(f)`            | pass            | —             |
| `Array.from([1,2]).map(f)`                | pass            | —             |
| `[undefined,undefined].map(f)`            | pass            | —             |
| **`Array.from("ab").map(f)`**             | **TRAP**        | **TRAP**      |
| **`Array.from({length:5}).map(f)`**       | **TRAP**        | **TRAP**      |
| **`Array.from({length:2,0:"a",1:"b"}).map(f)`** | **TRAP**  | —             |

## What the probes rule out

Three tempting explanations, each falsified by a row above:

- **Not `undefined` elements.** `[undefined, undefined].map(f)` passes, and
  `Array.from({length:2,0:"a",1:"b"}).map(f)` traps with real string elements.
- **Not element type.** `Array.from(["a","b"]).map(f)` passes with the same
  string elements that trap via `Array.from("ab")`.
- **Not `Array.from` itself.** `Array.from("ab")` alone passes — `length`,
  indexed reads and `join` are all correct. The trap needs the `.map`.
- **Not #3643 Slice B.** Both trapping rows reproduce on `origin/main`, and
  `Array.from({length:5})` returns `[]` there, so the callback is invoked **zero
  times** and it still traps. The trap does not require the closure to run.

## Root-cause direction (not yet pinned — do not treat as established)

The surviving hypothesis is a **type lie**: `Array.from` is declared to return
`T[]`, which the backend lowers as a **WasmGC vec**, so a subsequent `.map` is
compiled as a vec operation with a `ref.cast` on the receiver. The runtime's
`__array_from` (`src/runtime.ts`, `if (name === "__array_from")`) returns a plain
host `any[]` on every non-vec path (`return Array.from(src)` /
`return Array.from(src, wrapped)` / the `drained` path), so the cast meets an
externref and traps.

That would explain why the vec-sourced rows pass and the rest trap, but **it has
not been confirmed against the emitted Wasm**. Confirm before fixing.

## Likely shape of the fix

Make `__array_from` return a **WasmGC vec** rather than a host array on the
non-vec paths, so the declared `T[]` return type is honest. `_materializeIterable`
is the existing precedent for moving between the two representations. Whatever the
fix, it must keep the passing rows above passing.

## Acceptance

1. `Array.from("ab").map(f)` and `Array.from({length:5}).map(f)` run to
   completion instead of trapping.
2. Every currently-passing row in the table above still passes.
3. The `illegal_cast` trap-category count does not grow.
4. `test/built-ins/Array/from/array-like-has-length-but-no-indexes-with-values.js`
   reaches its final assertion instead of trapping at line 33.

## Why this is filed rather than fixed in #3888

#3888 (#3643 Slice B) is a **fail → fail** transition on that test — the baseline
records `status: "fail"` with `Expected SameValue(«0», «5»)` at line 26, and
Slice B makes that first assertion pass, so execution now reaches the pre-existing
trap at line 33. Fixing this bug is a codegen/representation change well outside
that PR's scope, so #3888 declares a bounded `trap-growth-allow` (#3596, the
documented mechanism for exactly a `fail` baseline) naming that one file, and
points at this issue. The valve is acceptable **because** the underlying bug is
tracked here — an untracked valve would be a cover-up.
