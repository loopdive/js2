---
id: 2036
title: "standalone: Array.prototype generics over array-like receivers emit invalid Wasm / null-deref / wrong results instead of refusing loud (~500+ tests)"
status: in-progress
sprint: Backlog
created: 2026-06-10
updated: 2026-06-14
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

## Progress

### PR-1 — helper `$Object` arm (2026-06-14, dev-b) — DONE (partial)

Taught the three standalone native array-like helpers to read a real array-like
`$Object` receiver (`{0:x, length:n}`), so the target-agnostic generic loop in
`compileArrayLikePrototypeCall` works for the callback methods. All in
`src/codegen/object-runtime.ts`, gated on `ctx.standalone` (gc/host uses the JS
`__extern_*` imports, byte-identical):

- `__extern_length`: `$Object` arm = ToLength(Get(O,"length")) — `__extern_get`
  the `"length"` key, `__unbox_number`, then truncate + clamp to [0, 2^53-1].
- `__extern_get_idx`: `$Object` arm = `__extern_get(O, number_toString(trunc(idx)))`
  — canonical decimal key matching `{0:x}` storage; proto-walk + marshaling via
  `__extern_get`; null for holes.
- `__extern_has_idx`: `$Object` arm = `__extern_has(O, number_toString(trunc(idx)))`
  — HasProperty (proto-walk); present-but-undefined ≠ absent (hole).
- `ensureObjectRuntime` registers `number_toString` + the boxing helpers early
  (standalone only) so the arm bodies resolve their funcIdx.

**Verified (tests/issue-2036.test.ts, 6 passing):** `forEach`/`some`/`every`/
`findIndex` over an array-like `$Object` in standalone now return the correct
result (were null-deref / silent-wrong); ToLength is honored (only in-range
indices visited); holes are skipped.

### Remaining (NOT in PR-1)

- **SEARCH methods (`indexOf`/`lastIndexOf`/`includes`) and `filter`** over an
  `$Object` receiver still emit **invalid Wasm** in standalone — a SEPARATE
  pre-existing codegen bug in their call-site loop. The compiler's `emitWat`
  output for the offending function is well-formed, but `emitBinary` mis-types a
  local (`local.set[0] expected f64, found call externref`). This reproduces on
  origin/main with the helper fix reverted, so it is NOT caused by PR-1 — it is a
  binary-emitter / local-type-layout bug needing senior/infra attention. Filed as
  a follow-up (escalated to tech lead 2026-06-14).
- The broader generic-arm work (#1888 Slice 4) and the ~308 residual
  callback-evaluation assertion rows — re-measure after PR-1.

## S6 Step 1 — LANDED (2026-06-17, dev-2)

Implemented the loud-refusal step per the architect spec. In
`compileArrayLikePrototypeCall` (`src/codegen/array-methods.ts`), when the
receiver is a **borrowed array-like `$Object`** (real `__vec_`/`__arr_` arrays
already take the dedicated native path and return earlier) and the target is a
not-yet-native method, standalone/WASI now emits a `Codegen error:` naming the
method + `#2036 S6` instead of leaking a host import or emitting invalid Wasm:

- `STANDALONE_UNSUPPORTED_ARRAY_LIKE_METHODS = {indexOf, lastIndexOf, includes,
  filter, map, reduce, reduceRight}` — search methods leaked
  `__host_eq`/`__same_value_zero` + tripped the `local.set expected f64, found
  call externref` binary-emitter bug; result-builders leaked
  `__js_array_new`/`__js_array_push`.
- Callback-iteration methods (`forEach`/`some`/`every`/`find`/`findIndex`) got a
  native `$Object` arm in PR-1 and are intentionally NOT in the set (control test
  asserts they keep compiling + running).
- Gated on `ctx.standalone || ctx.wasi`; host/gc output byte-identical.

Tests: `tests/issue-2036.test.ts` (+9 cases — each of the 7 methods refuses
loudly over an array-like `$Object`; controls: `forEach` still works, real native
array still works, host mode still compiles the borrowed call). All 16 in the
file pass; prettier/biome/tsc clean. Re-validated through the real
`runTest262File` standalone harness: `15.4.4.20-9-c-iii-3.js` now refuses cleanly
(was invalid Wasm).

### Remaining true-invalid-Wasm (NOT this slice — separate follow-up)

Three `built-ins/Array/prototype/filter` rows still emit genuine invalid Wasm but
are NOT borrowed-receiver array-likes (out of S6 scope): `15.4.4.20-4-7.js`
(`arr.filter(new Object())` — non-callable callback on a real array),
`create-ctor-non-object.js`, `create-ctor-poisoned.js` (`Symbol.species`
constructor reflection). All fail in a `__closure_N` with `call[1] expected type
f64, found local.get` — a distinct native-`filter`-closure / species bug, not the
generic-receiver root. Fold into Step 2 (senior/infra) or file separately.

Issue stays `in-progress` — Step 2 (the real generic `$Object` arm +
binary-emitter local-type fix) is senior/infra and unshipped.
