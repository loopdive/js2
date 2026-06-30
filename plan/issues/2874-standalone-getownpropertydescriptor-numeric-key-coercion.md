---
id: 2874
title: "Standalone: Object.getOwnPropertyDescriptor on a statically-typed receiver leaks the host import __create_descriptor (no native fallback)"
status: ready
created: 2026-06-30
priority: high
task_type: bug
area: codegen
goal: standalone
sprint: current
horizon: m
related: [2860, 2870, 2862]
umbrella: 2860
---

# Standalone: property-key coercion in Object.getOwnPropertyDescriptor / defineProperty

## Problem

In `--target standalone`, `Object.getOwnPropertyDescriptor(obj, key)` (and the
`defineProperty` / `create` / `defineProperties` family) fail to find a property
when the **key is not already a native string** — a number, `+Infinity`, an
object with a `toString`, etc. The §7.1.19 `ToPropertyKey`/`ToString` coercion on
the key is not applied (or applied differently) on the standalone path, so the
lookup misses, returns `undefined`, and the test then null-derefs on
`desc.value` → throws.

This cluster was previously **masked** by the exception-formatter bug (#2870);
de-masking surfaced it as a concrete, isolated standalone gap.

### Impact (host-pass / standalone-fail, measured 2026-06-30)

~**164** `built-ins/Object/getOwnPropertyDescriptor/**`, plus large adjacent
counts in the same key-coercion family:
`Object/defineProperty` 93, `Object/create` 97, `Object/defineProperties` 69.

## Representative repro

```js
// test/built-ins/Object/getOwnPropertyDescriptor/15.2.3.3-2-14.js
var obj = { Infinity: 1 };
var desc = Object.getOwnPropertyDescriptor(obj, +Infinity); // key +Infinity → "Infinity"
assert.sameValue(desc.value, 1); // standalone: desc is undefined → throws
```

Host mode passes; standalone throws (a Wasm exception, recorded post-#2870 as
`uncaught Wasm-GC exception`).

## Root cause (CONFIRMED via verify-first — NOT key coercion)

The original key-coercion hypothesis was **disproved**. Bisection (wrapTest +
`compile({target:"standalone"})`):

- `Object.getOwnPropertyDescriptor({…}, key)` on an **inline object literal** or
  an **`any`-typed** receiver → native path, **no host import, works** (the key
  form — `+Infinity`, `0`, `"a"` — does NOT matter).
- `var o = {…}; Object.getOwnPropertyDescriptor(o, key)` where `o` has a
  **statically-typed structural/nominal object type** → emits the **host import
  `env::__create_descriptor`**, which has **no standalone native fallback**, so
  the standalone module throws/traps. (Confirmed: the typed-receiver case lists
  `imports: __create_descriptor`; the `any` case lists `imports: none` and
  returns the right value.)

The throw is therefore a **host-import leak on the typed-receiver fast path**,
not a key coercion. The real test `15.2.3.3-2-14.js` fails because the harness
writes `var obj = {…}` (inferred structural type), not because of `+Infinity`.

### Exact site

`src/codegen/expressions/calls.ts:6652` — the
`Object.getOwnPropertyDescriptor` "fast path: known struct type + string literal
prop" inlines `struct.get` + a call to the host import `__create_descriptor`
(also at `:6808` for the field-value path). `__create_descriptor(value, flags)`
is host-only (`src/runtime.ts:10032`): it builds
`{value, writable:!!(flags&1), enumerable:!!(flags&2), configurable:!!(flags&4)}`.

### Fix direction

Provide a **standalone-native `__create_descriptor`** (register it in
`src/codegen/object-runtime.ts` like the existing native
`__getOwnPropertyDescriptor` at :5149): build a fresh 4-key `$Object`
(`value` = the externref value; `writable`/`enumerable`/`configurable` = boxed
booleans decoded from the `flags` bits). Then the typed-receiver fast path
resolves natively under `--target standalone` instead of leaking a host import.
Alternatively, under `ctx.standalone` route the typed fast path through the
existing native descriptor builder. Either way — additive, `ctx.standalone`-gated.

Note: this also unblocks the adjacent `defineProperty`/`create`/`defineProperties`
counts insofar as they share the typed-receiver descriptor-construction path
(verify each).

## Test plan

Standalone fail/CE → pass:

- `test/built-ins/Object/getOwnPropertyDescriptor/15.2.3.3-2-*.js`,
  `15.2.3.3-4-*.js`
- `test/built-ins/Object/defineProperty/15.2.3.6-3-*.js`
- `test/built-ins/Object/{create,defineProperties}/**` (shared coercion)

Verify-first with `runTest262File(file, cat, undefined, "standalone")`. Full
`merge_group` + standalone high-water. Pure correctness — `ctx.standalone` only.
