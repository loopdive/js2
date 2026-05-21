---
id: 1130
title: "Array methods — getter-observing property access on indices and length"
status: ready
created: 2026-04-20
updated: 2026-04-28
priority: medium
feasibility: hard
reasoning_effort: high
goal: property-model
---
# #1130 — Array methods: getter-observing property access on indices and length

## Problem

**~80 test262 failures** in `assertion_fail / /Array/prototype/{forEach,map,every,some,filter,reduce,reduceRight}/` install a getter via `Object.defineProperty` on an array index or the `length` property, and expect the getter to fire when the Array iteration method accesses that slot:

```js
var accessed = false;
var arr = [0, 1, 2];
Object.defineProperty(arr, "1", {
  get: function () {
    accessed = true;
    return 99;
  },
});
arr.forEach(function (v) {
  /* ... */
});
assert(accessed, "accessed !== true"); // fails — our impl reads data[1] directly, bypassing getter
```

Spec §23.1.3.{method} — each step calls `HasProperty(O, ! ToString(ℱ(k)))` and `Get(O, ! ToString(ℱ(k)))`, which invoke accessor getters when present. Our `src/codegen/array-methods.ts` generates a tight Wasm loop that reads from the underlying `array.get` instruction — no accessor machinery.

Same mechanism for `length`:

```js
Object.defineProperty(arr, "length", {
  get: function () {
    lengthAccessed = true;
    return 2;
  },
});
```

## Scope

- **~80 tests** — auto-classified with the regex `Object\.defineProperty\([^)]+, "(?:\d+|length)", .*get:` + `accessed|testResult`.
- Covers forEach, map, every, some, filter, reduce, reduceRight.
- Related: 68 "accessed !== true" + 7 "lengthAccessed !== true" + portions of "testResult" variants.

## Why this is hard

1. **Indexed access currently goes to `struct.get`/`array.get` directly.** No [[Get]] semantics.
2. **Spec-compliant iteration** requires HasProperty + Get for every index from 0 to ToLength(O.length). Each of those can trigger a user getter.
3. **`length` coercion** — ToLength(O.length) also goes through a Get. If length has a getter that returns a non-number (e.g. string `"2"` in filter/15.4.4.20-3-11.js), ToLength must still produce `2`.
4. Touches the property-access machinery (`src/codegen/property-access.ts`, `src/codegen/object-ops.ts`) — any change must keep the fast-path for real Arrays without accessors.
5. Interacts with **#1129 array-like receiver** (pattern B) — both need a general "read element via [[Get]]" primitive; fix for B may pave the way for A.

## Sample failing tests

- `test/built-ins/Array/prototype/reduceRight/15.4.4.22-5-10.js` (getter on `length`, ToLength(getter result) expected)
- `test/built-ins/Array/prototype/every/15.4.4.16-7-b-3.js` (getter on index, flag check)
- `test/built-ins/Array/prototype/forEach/15.4.4.18-7-b-15.js` (getter on `"1"`, flag check)

All three FAIL today (codes 2 or 3) — confirmed via compile-verify probe.

## Implementation sketch (needs architect spec)

1. **Runtime representation** — for arrays that have had `defineProperty` called on an own index or `length`, flip a "has-accessors" bit in the vector struct. Fast-path: no-accessors → current direct read.
2. **Slow-path**: when accessors present, iterate via a host-bridge or Wasm-native [[Get]] that checks for an accessor descriptor and invokes the getter closure.
3. **`length` descriptor** — extend the vec struct to carry an optional length-accessor descriptor, or route length reads through a general property-access helper.
4. **ToLength coercion on getter result** — piggyback on the existing number-coercion path used by array bracket access.

## Acceptance criteria

- [ ] **Architect spec**: where the accessor descriptor lives on the vec struct, the fast-path/slow-path branching, how each callback method's loop is adjusted, interaction with `Array.prototype.X.call(plainObj, cb)` (issue #1131 — the B fix).
- [ ] **Regression test** `tests/issue-1130.test.ts` — one test per getter-on-index, getter-on-length, getter returning non-number with ToLength coercion, forEach/map/filter/every/some/reduce/reduceRight.
- [ ] **≥60 of 80 target tests** flip from FAIL to PASS.

## Related

- Probe report: `.tmp/array-callback-probe.md` in worktree `issue-cluster-b-dstr`
- Sub-pattern A of the array-proto-callback cluster (parent: 874 assertion_fail tests).
- Related: #1129 (thisArg ABI), #1131 (array-like receiver via .call).
- Spec: <https://tc39.es/ecma262/#sec-array.prototype.foreach> and siblings.

## Dispatch notes

Route to architect for implementation spec. `reasoning_effort: high`. Recommend **filing after #1131 lands** — if the B fix introduces a general "[[Get]](O, k)" helper, this issue can reuse it for the slow-path.

## Investigation 2026-05-21 (dev-1130-5)

Investigated by dev-1130-5; bounced back as needing architect spec before implementation. Findings to inform spec:

**Why the obvious "route through existing helper" approaches don't work as dispatched:**

1. **`__extern_get_idx` cannot serve as slow path for `__vec_*` receivers.** The existing host import at `src/runtime.ts:2400` tries `obj[idx]` and `_sidecarGet(obj, idx)` and `obj[strKey]` and `_sidecarGet(obj, strKey)` and `exports.__sget_${strKey}` — all five return undefined for normal `__vec_f64`/`__vec_i32`/`__vec_externref` elements because WasmGC array data is opaque to JS. `__sget_${strKey}` only exists for object struct fields, not vec data. The existing slow path `compileArrayLikePrototypeCall` (src/codegen/array-methods.ts:377) bails on `__vec_*`/`__arr_*` types at line 427 for exactly this reason.

2. **`_safeGet` *does* invoke `__get_${key}` sidecar accessors** for WasmGC structs (runtime.ts:1046), so `Object.defineProperty(arr, "1", {get:...})` does store the accessor in `_wasmStructProps` — but no host import currently reads it for indexed access in a way that also returns the underlying array element when no accessor is present.

3. **There is no existing `__get_property` host import** that satisfies "[[Get]](O, k)" for Wasm-typed arrays. The mentioned property-access codegen path in src/codegen/property-access.ts handles object struct fields and indexed access on externrefs, but not the dual case (accessor-or-vec-element).

**Recommended implementation approach (for architect to validate / refine):**

1. **Two new host imports in src/runtime.ts:**
   - `__array_idx_accessor_get(obj: externref, idx: f64) -> externref` — returns accessor getter's `.call(obj)` value if `_wasmStructProps.get(obj)?.__get_${String(idx)}` is a function; otherwise returns a unique sentinel (e.g. `__array_no_accessor_sentinel` exported as a separate global).
   - `__array_length_accessor_get(obj: externref) -> externref` — analogous for `"length"`.
   - `__is_array_accessor_hit(v: externref) -> i32` — tests sentinel.

2. **Plumb `state.getterCallbackFound`** (currently local to `collectAllSourceImports` in src/codegen/index.ts:2978) onto `ctx` (e.g. `ctx.hasGetterCallbacks`) so array-methods.ts can read it during code generation.

3. **In `setupArrayLoop` (line 4363):** when `ctx.hasGetterCallbacks`, additionally allocate `vecExternTmp`, push `extern.convert_any(vec)` into it. Replace direct `struct.get vec.length` with: call `__array_length_accessor_get(vec_extern)` → if hit, coerce result via ToLength → set lenTmp; else fall back to current `struct.get` length.

4. **In `buildClosureCallInstrs` / `buildBridgeCallInstrs` (lines 4404, 4467):** when `ctx.hasGetterCallbacks` and `elemSource.kind === "inline"`, emit per-iteration: call `__array_idx_accessor_get(vec_extern, i_f64)` → if hit, coerce result to `elemType` → use as element; else `array.get(data, i)`.

5. **For `local` elemSource (find, every, etc.):** the local must be filled with the accessor-aware result before the call instruction sequence runs.

**Risk: getter side-effects during iteration.** Tests like `Array/prototype/forEach/15.4.4.18-7-b-15.js` may have getters that mutate `arr` or `arr.length` mid-iteration. Spec §23.1.3.X re-evaluates `Get(O, len)` once at start but re-evaluates `Get(O, k)` each step. The current loop snapshots `lenTmp` at entry — that's spec-compliant. But mutating the underlying `data` array via the getter could break the `array.get` fallback. Architect should decide whether to also snapshot `data` to a frozen tmp.

**Scope estimate:** ~300-400 LOC across `src/runtime.ts` (~60 LOC for the three imports + sentinel), `src/codegen/index.ts` (~5 LOC to expose state), `src/codegen/array-methods.ts` (~250 LOC: `setupArrayLoop` + the 7 method compilers + the two call builders). Plus tests/issue-1130.test.ts.

**Recommended scoping for first PR (~10-15 tests):** ONLY forEach on `__vec_f64`. Defer map/filter/reduce/etc. to follow-ups. Validates the host-import + sentinel machinery on a single method before fanning out.
