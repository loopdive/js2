---
id: 3713
title: "Plain object with a custom [Symbol.iterator]() method is not iterated correctly by spread/for-of"
status: ready
sprint: current
created: 2026-07-27
updated: 2026-07-27
priority: medium
horizon: m
feasibility: medium
task_type: bugfix
area: codegen, runtime
language_feature: iterators
goal: iterator-protocol
origin: "#3690 — new tests/differential/corpus/builtins/19-symbol-iterator.js surfaced this on first run"
related: [3690]
---

# #3713 — Custom `[Symbol.iterator]()` on a plain object literal doesn't drive spread/for-of

## Repro

```js
const range = {
  from: 1,
  to: 3,
  [Symbol.iterator]() {
    let current = this.from;
    const last = this.to;
    return {
      next() {
        return current <= last ? { value: current++, done: false } : { value: undefined, done: true };
      },
    };
  },
};
console.log([...range].join(","));
let total = 0;
for (const n of range) total += n;
console.log(total);
```

## Symptom

- V8: `1,2,3\n6`
- js2wasm: `0\n0`

Both the spread (`[...range]`) and `for-of` consumption produce empty/zero
results, as if `range` is treated as an empty iterable rather than invoking
the computed `[Symbol.iterator]()` method and driving its returned
`{next()}` protocol object. Built-in iterables (arrays, generator objects
per #3690's `generators/02-for-of.js`, which matches) already work — the
gap is specifically a **user-defined** iterable via a computed
`[Symbol.iterator]` method on an object literal.

## Repro file

`tests/differential/corpus/builtins/19-symbol-iterator.js` (see #3690).

## Root cause (investigated 2026-07-27) — narrowed to a specific wrong value, not a missing feature

Traced with instrumented host imports (wrapped `__iterator` in
`buildImports` to log its argument at the exact call site both the spread
and the for-of loop reach). **The generic host-delegated iterator path
(`src/codegen/statements/loops.ts` `compileForOfIterator`, the `__iterator`
/ `__iterator_next` host imports in `src/runtime.ts`) IS being invoked** —
confirmed the compiled program imports and calls `__iterator` exactly
twice (once for the spread, once for the for-of). But the value passed to
it is **not `range`**:

```
TRACE __iterator called with: [Object: null prototype] {} keys: [] hasSymbolIterator: false
```

Both call sites pass an **empty placeholder object** — no `from`, `to`,
`[Symbol.iterator]`, nothing — instead of the actual compiled `range`
value. So this is not "the runtime doesn't know how to call a custom
iterator" (the `__iterator` runtime fallback for opaque WasmGC structs —
`_isWasmStruct(obj)` → `exports["__call_@@iterator"]` — looks like it's
designed for exactly this case, per `src/runtime.ts` around line 13161).
The bug is upstream: **whatever compiles `range` (an object literal with a
computed `[Symbol.iterator]()` method key, no explicit type annotation —
TS infers a concrete struct type for it since there's no contextual
`any`/`unknown`) and coerces it to externref before the `__iterator` call
is producing/passing a fresh empty object instead of the real one.**

Two candidate sites for whoever picks this up, not yet disambiguated:

1. `src/codegen/literals.ts` `compileObjectLiteralAsExternref` (or whatever
   builds the struct/`$Object` for `range`) may be dropping ALL properties
   when a computed well-known-symbol method key is present, rather than
   just skipping the unsupported key.
2. The for-of/spread "coerce struct to externref" step in
   `compileForOfIterator` / the spread-element codegen may be pushing an
   unrelated freshly-constructed placeholder onto the stack instead of the
   actual compiled `range` expression result.

Distinguishing which requires adding raw WAT/bytecode-level tracing rather
than JS-level `console.log` instrumentation (the wrong value is already
wrong by the time it reaches the `env.__iterator` import boundary), which
is a next step, not something completed here.

**Not fixed here** — narrowed considerably (exact wrong value identified,
two concrete candidate emission sites named) but the precise site needs
one more investigation pass before a safe patch. Left `status: ready` since
this is scoped enough for a focused follow-up, unlike #3710-#3712.
