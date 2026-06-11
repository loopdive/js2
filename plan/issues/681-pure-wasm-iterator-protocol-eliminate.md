---
id: 681
title: "Pure Wasm iterator protocol (eliminate 5 host imports)"
status: done
created: 2026-03-20
updated: 2026-06-11
priority: high
feasibility: medium
reasoning_effort: high
goal: iterator-protocol
sprint: 61
depends_on: [680]
required_by: [735]
files:
  src/codegen/statements.ts:
    breaking:
      - "compile iterator protocol as Wasm struct with next/done/value"
  src/codegen/expressions.ts:
    breaking:
      - "for-of uses struct-based iterators instead of host imports"
claimed_by: codex-developer
claimed_at: 2026-06-06T18:07:10.511Z
pr: 1256
completed: 2026-06-06
---
# #681 — Pure Wasm iterator protocol (eliminate 5 host imports)

## ECMAScript spec reference

- [§7.4 Operations on Iterator Objects](https://tc39.es/ecma262/#sec-operations-on-iterator-objects) — GetIterator, IteratorNext, IteratorComplete, IteratorValue, IteratorClose
- [§7.4.2 IteratorNext](https://tc39.es/ecma262/#sec-iteratornext) — calls .next() on iterator, returns IteratorResult
- [§7.4.7 IteratorClose](https://tc39.es/ecma262/#sec-iteratorclose) — calls .return() if it exists


## Status: done

Iterator protocol uses 5 host imports (__iterator, __iterator_next, __iterator_done, __iterator_value, __iterator_return). Should be pure Wasm.

### Approach

Define an iterator result struct:
```
struct $IterResult {
  field $value externref
  field $done i32
}
```

And an iterator struct:
```
struct $Iterator {
  field $next (ref null $func_type)  ;; next() function ref
  field $return (ref null $func_type) ;; return() function ref (optional)
  field $state (ref null $gen_state)  ;; for generator iterators
}
```

- `Symbol.iterator` call → compile to creating an $Iterator struct
- `iterator.next()` → `call_ref $next`
- `iterator.done` → `struct.get $done` from result
- `iterator.value` → `struct.get $value` from result
- `iterator.return()` → `call_ref $return` if non-null

For arrays: iterator next() is a closure over index + array ref.
For generators: iterator wraps the state machine from #680.
For custom iterables: compile the [Symbol.iterator]() method return as $Iterator struct.

### What stays as host import (js-host mode only)
When iterating over externref values (unknown type), still need host `__iterator` to get the iterator. But for known types (Array, Map, Set, generators), use pure Wasm.

## Complexity: L (depends on #680 for generators)

## 2026-06-03 senior-dev re-profile (current main state)

The original issue (April) predates the #1665 generator work and the #1472
Phase B native-vec foundation. The actual current state on main is **much
further along** than "uses 5 host imports". Mapping the real surface:

### What already works pure-Wasm in standalone/WASI (no host imports)
- **Direct array for-of** `for (const x of [1,2,3])` → index loop
  (`compileForOfArray`, loops.ts:2557). No host import.
- **Array for-of destructuring** `for (const [a,b] of pairs)` → index loop.
- **Native generator for-of** `for (const x of gen())` (numeric `function*`)
  → drives the generator resume fn directly (`tryCompileNativeGeneratorForOf`,
  generators-native.ts:639; #1665). No host import.
- **Class custom-iterable for-of** — when the iterable is a class struct whose
  `_@@iterator` method was compiled and whose `next()` returns a struct with
  `done`/`value` fields, `compileForOfDirectIterator` (loops.ts:3073) drives the
  whole loop in Wasm. No host import.
- **Native string for-of** (`compileForOfString`, nativeStrings mode).

### What currently HARD-ERRORS in standalone (the real #681 gap)
Two shapes deliberately `reportError("#681 …")` rather than emit a host import
(see tests/issue-681-standalone-iterators.test.ts, which pins this refusal):

1. **`Array.prototype.values()/.keys()/.entries()`** —
   `compileArrayIteratorMethod` (array-methods.ts:3084) hard-errors under
   standalone/WASI. Highest-frequency gap; cleanly bounded.
2. **for-of over an unknown externref `any`** — generic Iterator-Record dispatch
   on an opaque value. Genuinely hard (needs a runtime `GetIterator` →
   `IteratorStepValue` machine on an arbitrary externref). Out of this slice.

The five `__iterator*` imports are NOT emitted in standalone at all anymore —
they only fire in JS-host mode (the dual-mode fast path, which is legitimate
per CLAUDE.md). So "eliminate 5 host imports" in standalone is mostly **done**;
the residual is the two refusal shapes above. The 532-row figure is dominated
by shape (1) — `[...].values()`-style iteration in array/TypedArray test262.

### Chosen slice (this PR): native `Array.prototype.values()` for-of

`for (x of arr.values())` is semantically identical to `for (x of arr)` —
both drive the array's element list in order. So the slice recognizes a for-of
whose subject is `<vecExpr>.values()` and lowers it to the existing
`compileForOfArray` index loop driven by `<vecExpr>`, in standalone/WASI. Zero
new runtime types, reuses the proven index-loop drive, byte-identical to the
direct-array path. `.keys()`/`.entries()` (different element shape — index, or
`[i, v]` pair) and the generic-externref case are explicit follow-ups.

Source: loops.ts `compileForOfStatement` recognizer + a `valuesReceiverForForOf`
helper. JS-host mode is unchanged (still routes through `__array_values`).

## 2026-06-05 follow-up slice (dev-iter): native `.keys()` + `.entries()` for-of

Built directly on the `.values()` slice. The `.values()` recognizer
(`valuesReceiverForForOf`) is generalized to `arrayIteratorReceiverForForOf`,
which now also matches `<vec>.keys()` (§23.1.3.16) and `<vec>.entries()`
(§23.1.3.4). Two new dedicated lowerings drive a pure-Wasm index loop over the
receiver vec and project the correct per-iteration value:

- **`.keys()`** → `compileForOfArrayKeys`: binds the loop variable to `f64(i)`
  each iteration. Only a simple-identifier binding is supported (`.keys()`
  yields numbers); other binding forms fall through to the iterator path.
- **`.entries()`** → `compileForOfArrayEntries`: for the common destructured
  `for (const [k, v] of arr.entries())` form, binds `k = f64(i)` and
  `v = data[i]` directly — no pair object is materialized. Non-destructured /
  nested / hole / rest forms fall through.

Both share `emitArrayKeysEntriesLoop`, which mirrors `compileForOfArray`'s
length read, `block { loop }` structure, break/continue depth bookkeeping and
genuinely-null receiver TypeError guard. JS-host mode is unchanged. The three
Array iterator methods now lower natively in standalone/WASI with **zero**
`__array_keys`/`__array_entries`/`__array_values` host imports.

Validated (compile + run under `--target standalone` / `--target wasi` and
JS-host default): keys/entries sums, break/continue, empty arrays, variable
receivers — all correct, no iterator host imports. Tests in
`tests/issue-681-standalone-iterators.test.ts` (7 passing).

### Remaining #681 gap (still open — keeps this umbrella in-progress)

Generic for-of over an opaque externref `any` (a runtime `GetIterator` →
`IteratorStepValue` machine on an arbitrary externref) still hard-errors in
standalone — the genuinely-hard residual called out in the 2026-06-03 profile.
Non-destructured `for (pair of arr.entries())` (needs a materialized 2-tuple)
is also a deliberate fall-through, not yet native.

## 2026-06-06 codex slice: continue-safe native Array iterator loops

Fixed the direct pure-Wasm array iterator loops so `continue` advances the
native index before re-entering the loop. The previous `block { loop { ... } }`
shape bound `continue` to the loop header while the increment sat after the
user body, so `for (... of arr.entries()) { if (...) continue; }` could repeat
the same `[index, value]` pair forever.

The array value loop used by direct array for-of and `arr.values()` now wraps
the user body in an inner block and places `i += 1` after that block. The
`.keys()` / `.entries()` projection loop uses the same structure. `break`
still exits the outer block, while `continue` exits only the inner body block
and falls through to the increment. No iterator or array-iterator host imports
are introduced.

Scoped validation:

- `pnpm vitest run tests/issue-681.test.ts tests/issue-681-standalone-iterators.test.ts tests/issue-1320-standalone.test.ts --reporter verbose` — 21 passing.
- `pnpm vitest run tests/issue-1665-standalone-generator-forof.test.ts --reporter verbose` — 3 passing.
- `pnpm exec prettier --check src/codegen/statements/loops.ts tests/issue-681.test.ts` — passing.

Remaining #681 gap stays open: fully generic for-of over an opaque externref
`any` in standalone/WASI still refuses at the IR gate unless the iterable is a
known native shape handled by earlier slices.
