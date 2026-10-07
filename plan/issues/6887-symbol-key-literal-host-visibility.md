---
id: 6887
title: "Object literal `{ [Symbol.iterator]: v }` with a NON-callable value is invisible to the host (Array.fromAsync resolves instead of rejecting)"
status: ready
sprint: current
created: 2026-10-07
updated: 2026-10-07
priority: low
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: runtime
goal: core-semantics
related: [6884, 6847]
---

## Problem

A well-known-symbol key in an object literal is compiled to a static struct
field named `@@iterator` (`src/codegen/literals.ts`, the reserved-name map).
Compiled reads find it, but the host mirror of the struct does not expose it
under the real `Symbol.iterator` key when the value is not a function.

Measured on upstream/main `75252327a4` (JS-host lane):

```js
const o = { [Symbol.iterator]: true };
Object.getOwnPropertySymbols(o).length;   // js2wasm 0   node 1
o[Symbol.iterator];                        // js2wasm true (compiled read)
Array.fromAsync({ [Symbol.iterator]: true }).then(ok, err);
// js2wasm: resolves ([] — treated as array-like)   node: rejects TypeError
```

test262 rows (previously vacuous passes; #6847 made the enclosing
`for (…of…) { await assert.throwsAsync(…) }` really await, so the
non-rejection is now observed):
`built-ins/Array/fromAsync/asyncitems-iterator-not-callable.js`,
`built-ins/Array/fromAsync/asyncitems-asynciterator-not-callable.js`.

## Implementation Plan

1. Find the struct host-mirror traps (`_wrapForHost` Proxy in
   `src/runtime.ts` and its helpers under `src/runtime/`): `get`, `has`,
   `getOwnPropertyDescriptor`, `ownKeys`.
2. Map a well-known `Symbol.<name>` property key to the `@@<name>` struct
   field for EVERY value kind (today only the callable/iterator paths
   translate it), and list it from `ownKeys` as the symbol, not the string.
3. Keep `@@name` itself out of `ownKeys`' string keys.
4. Test: the three expressions above against node; the two test262 rows.
   Runtime-only change → no standalone impact, but check
   `check:host-import-policy` stays green (no new import).
