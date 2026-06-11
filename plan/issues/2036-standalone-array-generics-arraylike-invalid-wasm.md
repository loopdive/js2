---
id: 2036
title: "standalone: Array.prototype generics over array-like receivers emit invalid Wasm / null-deref / wrong results instead of refusing loud (~500+ tests)"
status: ready
sprint: Backlog
created: 2026-06-10
updated: 2026-06-10
priority: high
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen, runtime
language_feature: array-methods, objects
goal: standalone-mode
related: [1888, 1472, 1030]
test262_bucket: standalone-array-generics
test262_count: 500
es_edition: multi
origin: "2026-06-10 standalone-vs-host baseline diff: Array.prototype.* borrowed-receiver calls produce 3 distinct broken outcomes in standalone where host passes."
---

# #2036 — standalone: Array.prototype generics over array-like receivers

## Problem

ECMA-262 Array.prototype methods are intentionally generic
([§23.1.3 note](https://tc39.es/ecma262/#sec-properties-of-the-array-prototype-object)):
`Array.prototype.indexOf.call(arrayLike, x)` must work on any object with
`length`. test262 exercises this heavily
(`15.4.4.14-3-*`, `15.4.4.14-5-*`, `15.4.4.20-3-*`, …).

In standalone mode these calls currently produce **three different broken
outcomes** — two of which violate the #1888 dual-mode invariant ("any
uncertainty ⇒ fail loud, never invalid Wasm"):

1. **Invalid Wasm** (compile-time, ~195 gap tests):
   - `Compiling function "test" failed: local.set[0] expected type f64, found call of type externref`
     — e.g. `built-ins/Array/prototype/indexOf/15.4.4.14-3-16.js` (98 tests)
   - `Compiling function "test" failed: call[0] expected type externref, found f64.convert_i32_s of type f64`
     — e.g. `built-ins/Array/prototype/filter/15.4.4.20-3-9.js` (97 tests)
2. **Runtime null deref** (~40 non-Temporal gap tests):
   `dereferencing a null pointer [in test()]` — e.g.
   `built-ins/Array/prototype/indexOf/15.4.4.14-5-23.js` (confirmed by local
   probe on main @ 936d1ac51).
3. **Silently wrong result**: minimal probe
   `Array.prototype.indexOf.call({0:5, 5:'length', length:6}, 'length')`
   compiles and runs but returns `-1` instead of `5`.

Meanwhile *other* prototype methods on the same receiver shapes refuse
correctly and loudly:
`Codegen error: Array.prototype.map.call(...) is not yet supported in --target standalone (#1888 Slice 3/4) — the Array brand arm …`
(`map`/`reduce`/`reduceRight`/`lastIndexOf` and the Set/WeakMap/WeakSet
families). So the refusal gate exists but `indexOf`/`filter`/`forEach`/… have
arms that slip past it into broken codegen.

Beyond the compile-time buckets, ~308 `built-ins/Array/prototype` gap rows
fail at runtime with assertion errors (`accessed === false` callback-evaluation
tests etc.) that share this generic-receiver root: the standalone arm treats
the receiver as a native array (f64/i32-typed element access) when it is an
open `$Object`.

## Minimal repro (confirmed on main @ 936d1ac51)

```ts
// wrapped test262-style, compile({ target: "standalone" })
const obj = { 0: 5, 5: 'length', length: 6 };
const i = Array.prototype.indexOf.call(obj, 'length');
if (i !== 5) throw new Error('got: ' + i);
```

→ `WebAssembly.instantiate(): Compiling function #38:"test" failed: local.set[0] expected type f64, found call of type externref @+7826`

## Root cause in compiler

The standalone borrowed-method (`X.prototype.m.call(...)`) lowering in
`src/codegen/expressions/late-imports.ts` / the #1888 Slice 3 brand-arm
routing: the `indexOf`/`filter` Array-brand arms assume a typed native array
receiver and emit element loads typed f64/i32, but an open `$Object`/externref
receiver flows in. Where the loads "work", `length`/holes come back null →
null deref or `-1`.

## Suggested fix

1. **Stop the bleeding first (small PR):** make every Array.prototype
   borrowed-call arm that cannot handle non-array receivers route to the same
   loud `#1888 Slice 3/4` refusal that `map`/`reduce` already use. That alone
   converts ~430 invalid-Wasm/null-deref/wrong-result rows into honest
   refusals and protects the conformance numbers from silent wrongness.
2. **Then implement the generic arm** per #1888 Slice 4: receiver brand-switch
   — native array fast path; `$Object` arm reads `length` via `__extern_get`,
   elements via keyed get, all values as externref/anyref with proper
   coercion at comparison sites (`indexOf` uses strict equality on JS values,
   [§23.1.3.17](https://tc39.es/ecma262/#sec-array.prototype.indexof)).

## Acceptance criteria

- The minimal repro returns `5` (or, for the interim PR, refuses with a
  `Codegen error:` naming the method) — never invalid Wasm, never `-1`.
- `15.4.4.14-3-*`, `15.4.4.14-5-*`, `15.4.4.20-3-*` standalone rows move from
  `compile_error`(invalid Wasm)/`fail`(null deref) to pass or loud refusal.
- No `local.set expected f64, found externref` rows remain in the standalone
  baseline for `built-ins/Array/prototype`.
- Host mode unchanged.
