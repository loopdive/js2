---
id: 1130
title: "Array methods — getter-observing property access on indices and length"
status: done
completed: 2026-06-12
created: 2026-04-20
updated: 2026-05-25
priority: medium
feasibility: hard
reasoning_effort: high
goal: property-model
sprint: 55
---
# #1130 — Array methods: getter-observing property access on indices and length

> **2026-05-29 — folded into the array object-value representation track.**
> This is one of the three convergent symptoms of the missing array object
> identity (compiled WasmGC arrays are not host JS Arrays / not on the host
> `Array.prototype` chain). The canonical architecture spec lives in **#1719**
> ("Architecture Spec — array object-value representation"), which is the array
> analog of #1732's `$FuncObj`. Under that spec, the own index/length accessor
> descriptor moves onto `$ArrayObj.$descs` (a #1629 descriptor record) and the
> element-load slow path reads it from there. **PR-0 (vec array-index-exotic
> `length` growth, branch `issue-1130-getter-observe-v2`) is independent and
> still valid to land on its own**; the accessor-observation slow path (PR-1/2)
> is **S3** of the #1719 spec. See #1719 for the dual-mode (JS-host vs
> standalone) design and the honest test-count scope (native-vec ~30–45,
> interior-hole + prototype-chain subsets are explicit follow-ups).

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

1. **`__extern_get_idx` cannot serve as slow path for `__vec_*` receivers.** The existing host import at `src/runtime.ts:3371` tries `obj[idx]` and `_sidecarGet(obj, idx)` and `obj[strKey]` and `_sidecarGet(obj, strKey)` and `exports.__sget_${strKey}` — all five return undefined for normal `__vec_f64`/`__vec_i32`/`__vec_externref` elements because WasmGC array data is opaque to JS. `__sget_${strKey}` only exists for object struct fields, not vec data. The existing slow path `compileArrayLikePrototypeCall` (src/codegen/array-methods.ts:377) bails on `__vec_*`/`__arr_*` types at line 427 for exactly this reason.

2. **`_safeGet` *does* invoke `__get_${key}` sidecar accessors** for WasmGC structs (runtime.ts:1729-1733), so `Object.defineProperty(arr, "1", {get:...})` does store the accessor in `_wasmStructProps` — but no host import currently reads it for indexed access in a way that also returns the underlying array element when no accessor is present.

3. **There is no existing `__get_property` host import** that satisfies "[[Get]](O, k)" for Wasm-typed arrays. The property-access codegen path in src/codegen/property-access.ts handles object struct fields and indexed access on externrefs, but not the dual case (accessor-or-vec-element).

**Recommended implementation approach (refined by architect below):** two new host imports + a sentinel for "no accessor", plus a compile-time `ctx`-level flag plumbed from `state.getterCallbackFound` so the slow path is only emitted when the program contains accessor `defineProperty`.

**Risk: getter side-effects during iteration.** Tests like `Array/prototype/forEach/15.4.4.18-7-b-15.js` may have getters that mutate `arr` or `arr.length` mid-iteration. Spec §23.1.3.X re-evaluates `Get(O, len)` once at start but re-evaluates `Get(O, k)` each step. The current loop snapshots `lenTmp` at entry — that's spec-compliant.

---

## Implementation Plan (SUPERSEDED — 2026-05-21, pre-investigation)

> **This plan below is NOT viable** and is retained only for history. It
> proposed adding `$flags` / `$lenDesc` fields to the vec struct and a
> Wasm-native `[[Get]]`. The dev-1130-5 investigation showed the accessor
> descriptors already live JS-side in `_wasmStructProps` (keyed on the
> boxed externref), the vec *data* is opaque to JS, and there is no
> per-vec runtime flag to read in Wasm. The authoritative plan is
> **"## Implementation Plan (authoritative — 2026-05-23)"** further down.

(Author: architect, 2026-05-21. Builds on the sketch above; adds
exact struct field, branch placement, and the `__array_get_via_get`
helper.)

### Entry point

- `src/codegen/array-methods.ts` — every Array.prototype.X loop
  generator (forEach, map, every, some, filter, reduce, reduceRight,
  find, findIndex, indexOf, lastIndexOf, includes).
- New runtime helper `__array_get_via_get(arr, index)` in
  `src/runtime.ts` that performs spec-compliant [[Get]].

### Data structure changes

1. Vec struct (existing) gets a flag field:
   ```wat
   (type $vec_externref (struct
     (field $len    (mut i32))
     (field $data   (mut (ref $arr_externref)))
     (field $flags  (mut i32))          ;; NEW: bit 0 = has-index-accessors
     (field $lenDesc (mut (ref null any))) ;; NEW: optional length descriptor
   ))
   ```
   Bit 0 of `$flags` is set when any `Object.defineProperty(arr,
   numericKey, {get|set})` is invoked.

2. `$lenDesc` (nullable) holds the length getter descriptor when
   `defineProperty(arr, "length", ...)` is invoked with an accessor.

### Algorithm — array method loop with branch

For each loop method (e.g. `forEach`):

```wat
local.get $arr
struct.get $vec_externref $flags
i32.const 1
i32.and
if
  ;; slow path: spec-compliant loop using [[Get]]
  ;; for k from 0 to ToLength(Get(arr, "length")):
  ;;   if HasProperty(arr, ToString(k)):
  ;;     let v = Get(arr, ToString(k));
  ;;     callback(v, k, arr);
  ;; (calls __array_get_via_get, __array_has_via_get, callback)
else
  ;; fast path: existing tight loop
end
```

### Spec compliance — `length` coercion

When `$lenDesc` is non-null:
1. Invoke the getter (a funcref or externref).
2. Apply ToLength: ToNumber (coerce via existing `__to_number`),
   then floor / clamp to [0, 2^53-1].
3. Use the result as the loop bound. (Spec: ToLength of a string
   "2" → 2; of NaN → 0; etc.)

### Fast-path preservation

The bit-flag check is one `struct.get + i32.and + if`. For arrays
with no accessors, the branch predictor will pin the false path;
overhead < 1ns per call. Acceptable.

### Where the flag is set

`compileObjectDefineProperty` in `src/codegen/object-ops.ts:336`
already has a branch for arrays. When the key is numeric AND the
descriptor includes `get` or `set`, OR the key is "length" AND
descriptor is accessor, emit:

```wat
local.get $arr
struct.get $vec_externref $flags
i32.const 1
i32.or
struct.set $vec_externref $flags
```

Plus, for length-accessor: store the descriptor in `$lenDesc`.

### `__array_get_via_get(arr, index)`

```ts
function __array_get_via_get(arr, index) {
  const key = String(index);
  // Check own accessor on this index
  const accGet = _sidecarGet(arr, "__get_" + key);
  if (accGet) return _invokeCallback(accGet, arr, []);
  // Fall through to indexed read
  return _vecGet(arr, index);
}
```

### Edge cases

- **Getter throws** — must propagate (existing exception machinery).
- **Sparse arrays / HasProperty** — `HasProperty(arr, "5")` must
  return false for unset indices in `forEach` (spec skips them);
  `every` must NOT call the callback for missing indices. The
  helper `__array_has_via_get` returns based on sidecar + length +
  defined-bitmap.
- **Mutation during iteration** — spec snapshots `length` at start
  for some methods (map, filter, reduce — implementation-defined
  behaviour for some). Match V8: cache initial length.
- **`length` setter** — orthogonal; if user installs a length
  setter, writes to length now dispatch to the setter. Handle in
  array-length-write path (separate from this issue's scope but
  same flag).
- **`Array.prototype.X.call(plainObject, cb)`** — covered by #1131
  not here; coordinate the [[Get]] helper.
- **Reduce with no initial value, empty getter-driven array** —
  throws TypeError per spec; the slow path must mirror this.
- **`forEach` with a getter that returns `undefined`** — callback
  still invoked with undefined; do NOT skip.

### Test262 paths

- `test/built-ins/Array/prototype/{forEach,map,every,some,filter,reduce,reduceRight,find,findIndex,indexOf,lastIndexOf,includes}/15.4.4.*-*`
- Specifically the `accessed` / `lengthAccessed` / `testResult`
  patterns called out above.

Acceptance: ≥60 of 80 target tests pass.

### Dependencies

- **#1131** — array-like receiver via .call; introduces the
  [[Get]] helper. This issue should land *after* #1131 to reuse it.
  If #1131 stalls, implement the helper here and #1131 reuses.
- **#739** — Object.defineProperty correctness; the flag-setting
  branch lives in the same file. Coordinate.
- **#929** — Object.defineProperty receiver validation; harmless
  overlap.

### Risks

- **Fast-path regression**: any incorrect bit-check could redirect
  hot arrays to the slow path. Add a vitest in
  `tests/issue-1130.test.ts` measuring iteration count delta
  before/after (microbench).
- **Spec corners**: ToLength returning 2^53-1 with no array data →
  loop must terminate; cap at a max of 2^32-1 for safety (matches
  V8 fast-path limit).

---

## Implementation Plan (authoritative — 2026-05-23)

Author: architect. Supersedes the 2026-05-21 plan. Built on the
dev-1130-5 investigation and a read of the current source
(`src/codegen/array-methods.ts` rev with `setupArrayLoop` @4472,
`buildClosureCallInstrs` @4513, `buildBridgeCallInstrs` @4576;
`src/runtime.ts` `_safeGet` @1700, `__defineProperty_accessor` @~830,
`__extern_get_idx` @3371; `src/codegen/declarations.ts`
`finalizeUnifiedCollector` @1073, `getterCallbackFound` @557).

### Root cause

Array callback loops read elements with a raw `array.get` on the vec's
`$data` field (`buildClosureCallInstrs` @4538-4540, `buildBridgeCallInstrs`
@4592-4594) and read the loop bound with a raw `struct.get $vec.len`
(`setupArrayLoop` @4496-4497). Neither path consults the accessor
descriptor that `Object.defineProperty(arr, "1", {get})` stores. That
descriptor *is* recorded: `__defineProperty_accessor` (runtime.ts ~830)
catches the "opaque WebAssembly object" `TypeError`, then writes
`sc["__get_1"] = getter` into `_wasmStructProps`, keyed on the boxed
externref of the vec. So the data we need lives JS-side; the Wasm loop
just never asks for it.

### Key facts that constrain the design

1. **Accessor descriptors live JS-side, keyed on the boxed externref.**
   `_wasmStructProps` is a `WeakMap<object, Record<string|symbol, any>>`.
   The key is the JS wrapper V8 hands back for the WasmGC ref. For a
   given vec ref, `extern.convert_any` yields a *stable* wrapper
   identity within one module instance (V8 interns externref wrappers
   for GC refs), so a value stored under the wrapper during
   `defineProperty` is retrievable under the wrapper produced later in
   the loop. **This identity-stability assumption MUST be asserted by a
   regression test** (define a getter, then read it back via the helper
   in a separate call) before fanning out to all methods.
2. **Vec data is opaque to JS** — confirmed: `__extern_get_idx`'s five
   lookups all miss. So the slow path cannot delegate element reads to
   JS; JS only knows about *accessors*, not the backing elements.
   Therefore the helper returns a **sentinel** when no accessor is
   present, and the Wasm side falls back to `array.get`.
3. **There is a compile-time bit already.** `state.getterCallbackFound`
   (declarations.ts:557-581) is set during the single AST pre-scan iff
   the program contains `Object.defineProperty`/`defineProperties`/
   `Reflect.defineProperty` with an accessor descriptor. If it is
   false, **no array in the program can ever have an index/length
   accessor**, so the slow path need not be emitted at all. This is the
   "avoid per-iteration branch cost when none" mechanism — it is
   *whole-program*, not per-array, and it is free (already computed).

### Compile-time gating (the "any vec might have accessors" bit)

- **File: `src/codegen/context/types.ts`** — add to the `CodegenContext`
  interface (near `nativeStrings: boolean;` @503): `arrayAccessorObserved: boolean;`.
  Initialise to `false` wherever the context object is constructed
  (same place `nativeStrings`/`fast` get their defaults).
- **File: `src/codegen/declarations.ts`**, `finalizeUnifiedCollector`
  (the `if (state.callbackFound || state.getterCallbackFound)` block
  @1073). Inside the `if (state.getterCallbackFound)` branch (@1078),
  also set `ctx.arrayAccessorObserved = true;` and register the two new
  imports (see below). `collectAllSourceImports` runs at index.ts:789,
  i.e. **before** any function body (and thus any array method) is
  compiled, so `ctx.arrayAccessorObserved` is reliably set by the time
  `compileArrayMethodCall` runs.
- **Effect**: when `ctx.arrayAccessorObserved === false`, every site
  below emits *exactly the bytes it emits today* — zero new branches,
  zero new locals, zero import references. The slow path only exists in
  modules that call accessor `defineProperty`.

### New host imports (`src/runtime.ts`)

Add inside the `getImport(name)` switch, adjacent to `__extern_get_idx`
(@3371). Register them in `finalizeUnifiedCollector` via `addImport(ctx,
"env", "<name>", {kind:"func", typeIdx})` with the func types shown.

1. **`__array_idx_accessor_get(obj: externref, idx: f64) -> externref`**
   Func type `[externref, f64] -> [externref]`.
   ```ts
   if (name === "__array_idx_accessor_get")
     return (obj: any, idx: number): any => {
       if (obj == null) return __array_no_accessor;     // module-level singleton
       const sc = _wasmStructProps.get(obj);
       if (!sc) return __array_no_accessor;
       const getter = sc[`__get_${String(idx)}`];
       if (typeof getter === "function") return getter.call(obj);
       return __array_no_accessor;
     };
   ```
   `__array_no_accessor` is a module-private `const __array_no_accessor = Symbol("noacc")`
   (or `{}` — any object distinct from all user values; a Symbol cannot
   collide with a user array element). Do NOT use `undefined`/`null` —
   a getter legitimately returns those.

2. **`__array_length_accessor_get(obj: externref) -> externref`**
   Func type `[externref] -> [externref]`. Same shape, key `"__get_length"`.
   ```ts
   if (name === "__array_length_accessor_get")
     return (obj: any): any => {
       if (obj == null) return __array_no_accessor;
       const sc = _wasmStructProps.get(obj);
       const getter = sc?.["__get_length"];
       if (typeof getter === "function") return getter.call(obj);
       return __array_no_accessor;
     };
   ```

3. **Sentinel test — `__is_array_no_accessor(v: externref) -> i32`**
   Func type `[externref] -> [i32]`. Returns `1` iff `v === __array_no_accessor`.
   ```ts
   if (name === "__is_array_no_accessor")
     return (v: any): number => (v === __array_no_accessor ? 1 : 0);
   ```
   The Wasm side uses this rather than `ref.eq`/`ref.is_null` because the
   sentinel is a host value not reachable as a Wasm global.

> Reuse of existing machinery: the getter stored in `_wasmStructProps`
> is already `this`-bound-callable JS (it was wrapped by
> `_maybeWrapCallable` in `__defineProperty_accessor`), so a plain
> `getter.call(obj)` is correct and goes through the existing
> `__call_fn_<arity>` bridge. No new callback bridge is needed.

### Where the per-index accessor probe goes (element read)

There are exactly two element-load sites; both currently emit
`local.get dataTmp; local.get iTmp; <getOp>`:

- **`buildClosureCallInstrs`** @4537-4541 (the `elemSource.kind === "inline"` arm).
- **`buildBridgeCallInstrs`** @4591-4596 (the `inline` arm).

Refactor the "load element" into one shared helper and branch on
`ctx.arrayAccessorObserved`:

```
// helper: emitElementLoad(ctx, fctx, loop, elemType, arrTypeIdx) -> Instr[]
// FAST (ctx.arrayAccessorObserved === false): unchanged
[ local.get dataTmp, local.get iTmp, <getOp> ]

// SLOW (ctx.arrayAccessorObserved === true): probe accessor, else array.get
//   probe = __array_idx_accessor_get(vecExtern, f64(i))
//   if __is_array_no_accessor(probe):  elem = array.get(data, i)   (coerced to elemType)
//   else:                              elem = coerce(probe -> elemType)
```

Wasm sketch (result left on stack typed as `elemType`):
```wat
local.get $vecExternTmp            ;; externref of the receiver (see setup)
local.get $iTmp
f64.convert_i32_s
call $__array_idx_accessor_get     ;; -> externref (sentinel | getter result)
local.tee $probeTmp                ;; externref scratch
call $__is_array_no_accessor       ;; -> i32
(if (result <elemType>)
  (then
    local.get $dataTmp
    local.get $iTmp
    <getOp>                        ;; existing fast read; result is elemType
  )
  (else
    local.get $probeTmp
    ;; coerce externref -> elemType (see "Element coercion")
  ))
```

The two `inline` arms become a single call to `emitElementLoad`. The
`elemSource.kind === "local"` arms (find/every/etc. that pre-fill a
local) are unaffected — see "local elemSource" below.

### Element coercion (getter result → elemType)

The getter returns a JS value (externref). Coerce it to the loop's
`elemType` using the **existing** externref→T coercion already used by
bracket-index reads:
- `elemType.kind === "f64"`: `__to_number(externref) -> f64` (the same
  unbox/ToNumber path bracket access uses). For `__vec_externref` /
  string vecs, the element type is `externref`, so no coercion — pass
  the boxed value straight through.
- `elemType.kind === "i32"`: `__to_number` then `i32.trunc` (match the
  bracket path; reuse `coercionInstrs(ctx, {kind:"externref"}, elemType, fctx)`).
- `elemType.kind === "i16"` (string char arrays): treat as
  `__vec_externref`-style; in practice string element vecs are
  `externref`. If an i16 vec ever reaches here, coerce via the same
  `coercionInstrs` helper.

**Do not hand-roll coercion** — call
`coercionInstrs(ctx, {kind:"externref"}, elemType, fctx)` so this stays
consistent with bracket-index `[[Get]]` (and #1131).

### `setupArrayLoop` changes (the receiver externref + length getter)

`setupArrayLoop` @4472 currently allocates `vecTmp, dataTmp, lenTmp,
iTmp`. When `ctx.arrayAccessorObserved`:

1. Allocate `vecExternTmp` (`{kind:"externref"}`) and after
   `local.tee vecTmp` (@4494) + the null guard, push
   `local.get vecTmp; extern.convert_any; local.set vecExternTmp`. This
   is the externref handed to both new imports. (Use `extern.convert_any`
   directly — matches the `defineProperty` path @1623/1709 that produced
   the key; this guarantees the *same* wrapper identity, satisfying
   fact #1.)
2. Allocate `probeTmp` (`{kind:"externref"}`) for the element-load
   branch.
3. **Length via getter** — replace the unconditional
   `struct.get $vec.len; local.set lenTmp` (@4496-4497) with:
   ```wat
   local.get $vecExternTmp
   call $__array_length_accessor_get   ;; -> externref
   local.tee $probeTmp
   call $__is_array_no_accessor
   (if (result i32)
     (then local.get $vecTmp
           struct.get $vec 0)          ;; no length accessor: raw len (existing)
     (else local.get $probeTmp
           call $__to_length))         ;; ToLength(getterResult) -> i32
   local.set $lenTmp
   ```
   `__to_length` = ToNumber → if NaN/≤0 then 0 → `min(floor(n), 2^32-1)`.
   This is needed for `reduceRight/15.4.4.22-5-10.js` (length getter)
   and `filter/15.4.4.20-3-11.js` (length getter returning string
   `"2"`). Implement `__to_length` as a host import
   `[externref] -> [i32]` (cap at 2^32-1 to keep the loop counter i32;
   matches the V8 fast-path limit and avoids i64 in the bound), OR
   inline it from `__to_number` + clamp. Prefer the host import — it is
   small and reusable by #1131.
   - **Length is read ONCE at loop entry** (spec §23.1.3.X step
     "Let len be LengthOfArrayLike(O)"). The current snapshot-into-lenTmp
     behaviour is already correct; do not re-read length per iteration.
   - `lenTmp` stays i32 — the `2^32-1` cap guarantees it fits.

`ArrayLoopLocals` gains optional `vecExternTmp?: number; probeTmp?: number;`
(only populated on the slow path). `getOp` stays as-is.

### `local` elemSource (find / findIndex / indexOf / lastIndexOf / includes / every / some early-exit prefill)

Some methods pre-load `data[i]` into a local before the call sequence
(`elemSource.kind === "local"`). For those, the **accessor probe must
fill that local instead of `array.get`**. Concretely: wherever the
method currently emits `local.get dataTmp; local.get iTmp; getOp;
local.set elemLocal`, route through `emitElementLoad` and `local.set
elemLocal` with the result. Audit each of the 7 in-scope compilers (see
next section) for a `local.set` of the element and swap the load.

### The 7 in-scope method compilers + setupArrayLoop

All seven call `setupArrayLoop` and one of the call builders, so they
inherit the length-getter fix and the element-accessor fix automatically
**once the two builders + setupArrayLoop are patched**. Verify each
still type-checks and that any `local`-elemSource prefill is routed:

- `compileArrayForEach`, `compileArrayMap`, `compileArrayFilter` (@4717),
  `compileArrayEvery`, `compileArraySome`, `compileArrayReduce`,
  `compileArrayReduceRight`.
- `setupArrayLoop` @4472 (length getter + externref/probe locals).
- `buildClosureCallInstrs` @4513 / `buildBridgeCallInstrs` @4576 (element
  accessor probe).

`reduce`/`reduceRight` use a different accumulator-threading loop but
still read each element — route their element read through
`emitElementLoad` too. **`reduceRight` iterates high→low**; the accessor
probe uses the *current* `iTmp`, so direction is irrelevant to the probe.

**reduce/reduceRight with no initial value**: spec finds the first
present element via HasProperty. Out of strict scope for the first PR
(the targeted tests install a *getter*, so the index *is* present); keep
existing behaviour. Note in the test file that a `reduce`-empty-accessor
edge is deferred to a follow-up (HasProperty integration with #1131).

### Getter side-effects during iteration

- **Length is snapshotted at entry** (above) — a getter that grows/shrinks
  `arr.length` mid-loop does NOT change the bound. Spec-compliant.
- **A getter that mutates the backing data** (e.g. writes `arr[2]=…`):
  the fallback `array.get` reads `$data` live each iteration (we hold
  `dataTmp`, a ref to the same backing array, not a copy), so mutations
  are observed — matches spec "Get is re-evaluated each step". Do **not**
  snapshot/freeze `data`.
- **A getter that throws**: the `getter.call(obj)` throw propagates
  through the existing host-call exception machinery; the in-flight
  loop unwinds. No special handling.
- The targeted `accessed`/`lengthAccessed`/`testResult` tests pass
  because the getter is now actually invoked (the flag flips).

### Interaction with #1131 (array-like receiver via `.call`)

- #1131 handles `Array.prototype.X.call(plainObject, cb)` — a different
  receiver shape (`compileArrayLikePrototypeCall` @377, which bails on
  `__vec_*` @427). This issue handles the **native `__vec_*` receiver**.
  They are disjoint dispatch paths.
- **Shared primitives**: `__to_length` and the externref→elemType
  coercion (`coercionInstrs`) should be the *same* helpers #1131 uses
  for its `[[Get]]`/`ToLength`. If #1131 lands first, reuse its
  `__to_length`; if this lands first, #1131 reuses ours. Coordinate the
  import name (`__to_length`) so it is registered once.
- `__array_idx_accessor_get` is vec-specific (reads `_wasmStructProps`
  for the boxed vec). #1131's array-like path can call `__extern_get_idx`
  (already accessor-blind for plain objects, but plain-object accessors
  are visible via `obj[idx]`, so that path is fine). No conflict.

### File:line summary

| File | Location | Change |
|------|----------|--------|
| `src/codegen/context/types.ts` | `CodegenContext` iface ~503; ctx construction | add `arrayAccessorObserved: boolean` (default false) |
| `src/codegen/declarations.ts` | `finalizeUnifiedCollector` @1078 (inside `getterCallbackFound`) | set `ctx.arrayAccessorObserved = true`; `addImport` the 3 new helpers + `__to_length` |
| `src/runtime.ts` | adjacent to `__extern_get_idx` @3371 | add `__array_idx_accessor_get`, `__array_length_accessor_get`, `__is_array_no_accessor`, `__to_length` + module-private `__array_no_accessor` sentinel |
| `src/codegen/array-methods.ts` | `setupArrayLoop` @4472 | slow-path: alloc `vecExternTmp`/`probeTmp`; length via `__array_length_accessor_get`+`__to_length` |
| `src/codegen/array-methods.ts` | `buildClosureCallInstrs` @4537-4541, `buildBridgeCallInstrs` @4591-4596 | factor `emitElementLoad`; slow-path probe via `__array_idx_accessor_get` |
| `src/codegen/array-methods.ts` | `local`-elemSource prefills in the 7 compilers | route element load through `emitElementLoad` |

### Recommended PR sequencing

1. **PR 1 (machinery + forEach only)**: add the ctx flag, the 4 imports,
   the sentinel, `__to_length`; wire `setupArrayLoop` length getter and
   the element probe; gate to `compileArrayForEach` (and prove
   `buildClosureCallInstrs`/`buildBridgeCallInstrs` both work). Land
   `tests/issue-1130.test.ts` covering: getter-on-index fires; getter-on-
   length fires + ToLength on string `"2"`; externref-identity round-trip
   assertion; fast-path-unchanged microcheck (compile a getter-free
   forEach, assert byte output identical to pre-change). Target ~10-15
   tests.
2. **PR 2 (fan-out)**: map/every/some/filter/reduce/reduceRight. These
   are near-free since the shared builders are already patched; mostly
   adds tests and the `local`-elemSource audit. Target the remaining
   ~50-65 tests to clear ≥60/80.

### Test262 paths to verify

- `test/built-ins/Array/prototype/reduceRight/15.4.4.22-5-10.js` (length getter + ToLength)
- `test/built-ins/Array/prototype/every/15.4.4.16-7-b-3.js` (index getter flag)
- `test/built-ins/Array/prototype/forEach/15.4.4.18-7-b-15.js` (index getter, mutation)
- `test/built-ins/Array/prototype/filter/15.4.4.20-3-11.js` (length getter returns string `"2"`)
- the `accessed` / `lengthAccessed` / `testResult` clusters across
  forEach/map/every/some/filter/reduce/reduceRight.

### Risks

- **Externref-wrapper identity** (fact #1) is the load-bearing
  assumption. Mitigate with the round-trip regression test in PR 1
  *before* fan-out. If V8 ever hands a fresh wrapper per
  `extern.convert_any`, the `_wasmStructProps` lookup misses and the
  getter never fires — the test catches this immediately.
- **Fast-path regression**: the whole-program gate means getter-free
  modules emit byte-identical output. The PR-1 byte-equality microcheck
  guards this.
- **ToLength overflow**: cap at 2^32-1 keeps `lenTmp` i32 and the loop
  terminating; documented in `__to_length`.

---

## PR1 implementation attempt — BLOCKED on invalid spec premise (2026-05-23, dev-1130-6)

Implemented the full PR1 machinery from the 2026-05-23 authoritative plan
(ctx flag + 4 host imports + sentinel + `__to_length`; `setupArrayLoop`
length getter; `emitElementLoad` element-accessor probe wired through both
call builders; forEach gated). It type-checks, and on the **JS-sidecar
receiver shape it works**:

```ts
const arr: any = [0, 1, 2];                     // ← `any`-typed
Object.defineProperty(arr, "1", { get() { return 99; } });
let sum = 0; arr.forEach(v => sum += v); // ⇒ 101  ✅ (getter observed)
```

**But the actual #1130 test262 targets do NOT use this shape, and the
spec's load-bearing premise is false for them.**

### Root cause the spec missed

The authoritative plan assumes `Object.defineProperty(arr, "1", {get})`
stores the getter JS-side in `_wasmStructProps[boxedVec]["__get_1"]` (via
`__defineProperty_accessor`'s opaque-TypeError catch path). That is only
true when the receiver is an **externref / `any`-typed** object.

For a **statically-typed vec** — which is what `var arr = [0,1,2]` (or
`number[]`) compiles to, and what every #1130 target uses — codegen takes a
completely different path at **compile time**:
`compileObjectDefineProperty` (`src/codegen/object-ops.ts:690`, the
`if ((getNode||setNode) && structName && structTypeIdx !== undefined)`
branch) compiles the getter body into a **Wasm struct accessor function**
`<structName>_get_1` and registers it in `ctx.classAccessorSet`. It never
calls `__defineProperty_accessor`, so `_wasmStructProps` is empty and the
host-import probe (`__array_idx_accessor_get`) always returns the sentinel
→ the loop falls back to the raw `array.get` → getter never fires.

Verified by WAT inspection:
- `const arr = [0,1,2]` / `var arr = [0,1,2]` / `number[]` →
  WAT contains `_get_1`, does **not** contain `__defineProperty_accessor`
  → struct-accessor path → **getter NOT observed** (returns old value).
- `const arr: any = [0,1,2]` → WAT contains `__defineProperty_accessor`,
  no `_get_1` → JS-sidecar path → **getter IS observed** (my machinery
  works, returns 99 / sum 101).

Real target `forEach/15.4.4.18-7-b-15.js` is even harder: it also installs
a getter on **`Array.prototype` "2"** and mutates `arr.length` inside the
index getter. `every/15.4.4.16-7-b-3.js` uses
`Array.prototype.every.call({2:6.99,8:19}, cb)` — a **plain-object
receiver**, which is #1131's array-like path, not the native-vec path at
all.

### Why this needs an architect re-spec (not a dev fix)

To observe getters on native typed vecs, the array-method loop would have
to consult `ctx.classAccessorSet` / the compiled `<struct>_get_<idx>`
accessor funcs — a compile-time, per-(struct,index) dispatch — instead of
(or in addition to) the runtime `_wasmStructProps` probe. Indices are
dynamic in the loop (`i` is an i32 local), but the accessors are
statically-named per literal index, so this is a non-trivial design
question:
  - either route vec element reads in the accessor case through a
    generalized `[[Get]]` that can dispatch to a compiled accessor by
    runtime index (needs an index→accessor jump table or a per-vec
    "has-accessor" sidecar populated at defineProperty time), or
  - make `compileObjectDefineProperty` ALSO populate `_wasmStructProps`
    (the JS sidecar) for vec receivers so the existing host-import probe
    works uniformly — but then the getter body is a Wasm func, and storing
    a callable JS wrapper for it is the open question.

The 2026-05-23 plan's "## New host imports" + "emitElementLoad" design is
sound **only for the sidecar shape** and should be kept for the #1131
array-like path, but it does not move any #1130 target. Re-spec required to
decide the vec-accessor dispatch strategy above before further dev work.

Branch with the (working-for-sidecar, harmless) machinery:
`issue-1130-getter-observe`. NOT opened as a PR — it changes 4 files but
flips 0 target tests, so it is net-neutral churn until the re-spec lands.

---

## Implementation Plan (authoritative — 2026-05-24, re-spec from corrected premise)

Author: architect. **Supersedes all plans above.** Written after
re-measuring current `main` (HEAD `92c7483a4`) end-to-end with the live
compiler (`compileToWat` + `compileToWasm` probes), not from the stale
2026-05-23 source snapshot. **Read this section and ignore the two earlier
"authoritative" plans** — both rested on premises that current `main`
falsifies.

### TL;DR for the dev

- **The dev-1130-6 blocker is STALE.** Its claim — "statically-typed vecs
  compile `defineProperty(arr,"1",{get})` into a `<struct>_get_1` Wasm
  accessor and never touch `_wasmStructProps`" — is **false on current
  main**. Verified by WAT inspection across `var`/`const`/`number[]`/`any`
  array shapes: *every* shape routes the accessor through
  `__defineProperty_accessor`, which stores `sc["__get_1"]` in
  `_wasmStructProps` keyed on the vec's `extern.convert_any` externref.
  No `_get_1` struct accessor is emitted for arrays (arrays never resolve
  to a named `structName`, so the struct branch at
  `object-ops.ts:690` is not taken). The JS-sidecar mechanism the
  2026-05-23 plan assumed **is** the real mechanism. It is unblocked.
- **BUT the 2026-05-23 plan's scope is wrong in three material ways**
  (below). Implementing it verbatim still flips far fewer tests than
  promised. This re-spec corrects the scope and adds the two prerequisites
  it missed.

### Corrected scope (measured, not estimated)

I classified every getter-observing test across the 7 methods
(`forEach map every some filter reduce reduceRight`) by receiver shape
(regex over `Object.defineProperty(.., "length"|<digits>, .. get:)`):

| Receiver shape | Count | Owner |
|----------------|------:|-------|
| **Native vec** — `arr.method()`, getter on own index/length | **96** | **#1130 (this issue)** |
| `Array.prototype.method.call(plainObj, cb)` | 233 | the **array-like `.call` path**, already largely handled — NOT #1130 |
| getter installed on `Array.prototype[k]` (prototype chain) | 48 | separate prototype-visiting problem — NOT #1130 PR-1/2 |

**The issue header's "~80" and its three "sample failing tests" are
mis-scoped.** Two of the three samples are *not* native-vec receivers:
- `every/15.4.4.16-7-b-3.js` → `Array.prototype.every.call({2:6.99,8:19}, cb)` (array-like `.call`).
- `reduceRight/15.4.4.22-5-10.js` → `Array.prototype.reduceRight.call({0:11,1:12}, fn)` (array-like `.call`).
- `filter/15.4.4.20-3-11.js` (listed in "Sample failing tests") → `Array.prototype.filter.call({1:11,2:9,length:"2"}, cb)` (array-like `.call`).

**The array-like `.call` path is already correct** for these. Verified by
probe: `Array.prototype.filter.call({1:11,2:9,length:"2"}, cb)` returns
`newArr.length === 1` today — spec-correct. `compileArrayLikePrototypeCall`
(`array-methods.ts:377`) routes plain-object/anonymous-struct receivers
through `__extern_get_idx` / `__extern_length` (`runtime.ts:3371` / nearby),
which **do** invoke accessor getters via `_safeGet`/sidecar. That path
*deliberately bails on `__vec_*`/`__arr_*`* receivers (line 427) — which is
exactly the gap #1130 must fill. **#1130's true domain is the 96 native-vec
tests only.** (Note: every reference to "#1131 (the B fix / array-like
receiver)" in the older notes is a wrong issue number — #1131 is the SSA-IR
issue. The array-like path is `compileArrayLikePrototypeCall`, already in
tree; there is no separate open issue to wait on.)

### Three prerequisites the 2026-05-23 plan MISSED (load-bearing)

These are not edge cases — the *clean native-vec targets require all three*:

1. **Array-index-exotic `length` growth on `defineProperty`.** Per spec
   (ArraySetLength / `[[DefineOwnProperty]]` on array exotic objects),
   `Object.defineProperty(arr, "2", {get})` when `2 >= arr.length` sets
   `arr.length = 3`. Targets like `forEach/15.4.4.18-7-c-i-10.js`
   (`var arr = []; defineProperty(arr,"2",{get:()=>12})`) depend on this:
   the loop bound must become 3 so index 2 is visited. **Measured today:
   `arr.length` stays 0** after such a defineProperty (probe confirmed).
   The accessor-probe element read is useless if the loop never reaches the
   index. **This must be fixed first** (in the vec defineProperty path),
   independent of the element-read change.
2. **`HasProperty` / hole semantics are central, not deferred.** The clean
   targets use holes (`[0, , ]`, `[9, , 12]`, `[]`) plus an accessor on a
   specific index. `forEach`/`every`/`some`/`reduce`(no-init) MUST skip
   absent indices and visit accessor-defined ones. So the loop needs a
   per-index `HasProperty(arr, k)` that is true iff the index is a real
   backing element OR has a sidecar accessor. The 2026-05-23 plan
   explicitly deferred this ("out of strict scope for first PR") — but
   without it the clean targets don't pass.
3. **Prototype-chain getters appear even in native-receiver tests.**
   `forEach/15.4.4.18-7-b-11.js` defines `Array.prototype[1]` and toggles
   it inside an own-index getter. Spec `Get`/`HasProperty` walk the
   prototype chain. This subset (and the 48 proto-getter tests) needs
   prototype-chain consultation, which the sidecar probe does not do.
   **Defer the prototype-chain subset to a follow-up** (see sequencing).

### Mechanism (confirmed correct, reused from `_safeGet`)

The element-read and length-read slow paths use the **exact pattern
`_safeGet` already uses** (`runtime.ts:1729-1733`):
```ts
const getter = _wasmStructProps.get(obj)?.[`__get_${key}`];
if (typeof getter === "function") return getter.call(obj);
```
`obj` is the vec's `extern.convert_any` externref. **Externref-wrapper
identity is stable** for a WasmGC ref within an instance — this is already
relied upon in production by the `#856` `defineProperty value` + sidecar
read/write paths (`object-ops.ts:1374` comment), so the assumption is not
new risk. The getter stored by `__defineProperty_accessor`
(`runtime.ts:4121`, `_maybeWrapCallable`) is already JS-callable through the
`__call_fn_<arity>` bridge — `getter.call(obj)` is correct, no new bridge.

The host-import + sentinel design from the 2026-05-23 plan
(`__array_idx_accessor_get`, `__array_length_accessor_get`,
`__is_array_no_accessor`, `__to_length`, module-private `__array_no_accessor`
sentinel) is **sound and is adopted verbatim** for the element/length reads
— see that section above for the import signatures and the
`emitElementLoad` codegen sketch. The compile-time whole-program gate
(`ctx.arrayAccessorObserved` set from `state.getterCallbackFound` in
`finalizeUnifiedCollector`, declarations.ts ~1091) is also adopted verbatim
— re-verified the anchors (`getterCallbackFound` @declarations.ts:96/559,
`finalizeUnifiedCollector` @814, the `if (state.getterCallbackFound)` block
@1091; `CodegenContext` `nativeStrings` @types.ts:523;
`setupArrayLoop` @array-methods.ts:4472, element loads @4538-4540 /
@4592-4594). Add `__array_has_idx_accessor(obj, idx) -> i32` (returns 1 iff
`_wasmStructProps.get(obj)?["__get_"+idx]` is a function) for the
`HasProperty` slow path.

### What this re-spec ADDS on top of the 2026-05-23 element/length design

**A. Vec array-index-exotic length growth (new, prerequisite — PR-0).**
- File: `src/codegen/object-ops.ts`, the vec/non-struct accessor branch
  that reaches `emitExternDefinePropertyValue` / the `__defineProperty_accessor`
  call path (the branch taken when `structName === undefined`, i.e. arrays).
- When the prop key is a canonical array index `n` (`ToString(ToUint32(n)) === key`
  and `n < 2^32-1`) and the receiver is a `__vec_*`, after the
  `__defineProperty_accessor`/`__defineProperty_value` call, emit a guarded
  length bump: `if (n >= vec.len) vec.len = n + 1` via `struct.get/struct.set`
  on field 0. This mirrors array `[[DefineOwnProperty]]`. Gate on
  `ctx.arrayAccessorObserved` is NOT required here (it is correct
  unconditionally and cheap), but scope it to the vec-accessor branch so
  non-array defineProperty is unaffected.
- Add a runtime sentinel store so the accessor index is recoverable: the
  getter is already in `_wasmStructProps[obj]["__get_n"]`; no extra runtime
  store needed. The length bump is pure Wasm on the vec struct.
- **Verify**: `compileToWasm` probe — `[]; defineProperty(arr,"2",{get}); arr.length` must return 3.

**B. HasProperty in the callback loop (new, promoted from "deferred").**
- In `setupArrayLoop` slow path and the per-method loop body: before the
  element load, when `ctx.arrayAccessorObserved`, compute presence:
  `present = (i < backingLen) ? array data has index (always true for dense vec, false for hole)` OR `__array_has_idx_accessor(vecExtern, i)`.
  For a WasmGC vec the backing array is dense up to `vec.len`; holes from
  `[0, , ]` literals are represented as the default element value, **not**
  as true absences — so HasProperty for a hole index needs care. **Audit
  how array-literal holes are currently encoded** (`array.new_default`
  vs a hole bitmap): if holes are *not* tracked, `forEach` over `[0, , ]`
  cannot distinguish hole index 1 from a real 0. This is the single biggest
  open implementation question (see Risks). If holes are not represented,
  PR-1 should target only the **non-hole** native targets first (e.g.
  `7-c-i-10` uses `[]` + accessor, no interior hole) and the hole-dependent
  targets (`map/15.4.4.19-8-9` uses `[9, , 12]`) move to a follow-up tied
  to hole representation.
- `forEach`/`every`/`some`/`find*`/`reduce`(no-init) skip when `!present`;
  `map`/`filter` produce a hole in the result when `!present` (match
  `map/15.4.4.19-8-9`: result keeps length 3 with `result[2]` undefined and
  index 1 skipped after `arr.length=2` mutation).

**C. Element + length read slow path** — exactly the 2026-05-23
`emitElementLoad` + `__array_length_accessor_get` + `__to_length` design.
No change.

### Recommended PR sequencing (revised, honest)

- **PR-0 (prerequisite, ~3-5 native tests)**: vec array-index-exotic
  `length` growth on `defineProperty` (item A). Standalone, low-risk,
  independently valuable (fixes `arr.length` after numeric-index
  defineProperty). Land first; it unblocks any later loop-bound work.
- **PR-1 (machinery + forEach, non-hole subset)**: ctx flag + 4 host
  imports + sentinel + `__to_length` + `__array_has_idx_accessor`;
  `setupArrayLoop` length-getter + element-accessor probe + HasProperty;
  gate to `compileArrayForEach`. Land `tests/issue-1130.test.ts`:
  getter-on-index fires (`[]`+accessor@2 → val 12); getter-on-length fires
  + ToLength on string `"2"`; **externref-identity round-trip assertion**
  (store getter, read back via helper in a later call — guards the
  load-bearing assumption); **byte-equality microcheck** (getter-free
  forEach emits identical bytes pre/post change, proving the gate).
- **PR-2 (fan-out)**: map/every/some/filter/reduce/reduceRight via the
  shared builders; `local`-elemSource audit; the `map` result-hole
  semantics. Target the remaining clean native tests.
- **Follow-up issues (NOT #1130)**: (i) interior-hole representation if
  absent (blocks `[9, , 12]`-style targets); (ii) prototype-chain
  `Get`/`HasProperty` for the 48 proto-getter tests + native tests that
  toggle `Array.prototype[k]`.

### Honest acceptance criteria (replaces the header's "≥60 of 80")

The header's "≥60 of 80" is **not achievable in #1130's true scope** — only
96 tests are native-receiver, and an unknown fraction depend on hole
representation / prototype chain that are out of scope. Realistic targets:
- **PR-0**: `arr.length` reflects numeric-index defineProperty (3-5 tests
  + the length-read direct cases).
- **PR-1+PR-2**: clear the **non-hole, own-accessor, native-receiver**
  subset of the 96 — estimate **30-45 tests** (exact count to be measured
  by the dev with a scoped test262 run on the 7 method dirs before/after).
  Treat 30 as the floor for "worth merging"; if PR-1's scoped run shows
  <15 in the non-hole subset, re-evaluate with the architect.

### Why this is still worth doing (not wont-fix)

The mechanism is proven (`_safeGet` already does it), the externref
identity risk is already retired in production, and PR-0 alone fixes a
visible correctness bug (`arr.length` after numeric defineProperty). The
work is real and bounded; only the *headline test count* was inflated. Keep
`status: ready`. Dispatch PR-0 first as a small, independent task; gate
PR-1/2 on the dev's scoped before/after measurement so the team commits to
real, measured numbers rather than the stale "~80".

### Open question the dev MUST resolve early (could re-block)

**Interior-hole representation.** If WasmGC array literals encode `[0, , 2]`
as a dense `array.new` with a default value at index 1 (no hole bitmap),
then `HasProperty(arr, 1)` cannot return false for the literal hole, and
the hole-dependent targets are unreachable without a representation change
(a follow-up issue, larger than #1130). The dev should answer this in the
first hour (inspect `array.new`/`array.new_default`/literal-with-elision
codegen) and, if holes are not tracked, **scope PR-1/2 to the `[]`-or-dense
+ own-accessor subset** and file the hole-representation follow-up rather
than expanding #1130. This is the one place this issue could legitimately
need more than a spec — flag it to the architect/PO if hole tracking turns
out to be a prerequisite for a majority of the 96.

---

## PR-0 implemented — vec array-index-exotic length growth (2026-05-25)

Branch `issue-1130-getter-observe-v2` (off current main, dcf2b287c).
Implements **PR-0** from the 2026-05-24 authoritative re-spec, item A:
array exotic objects grow `length` when `Object.defineProperty(arr, "n", …)`
defines a property at a numeric index `n >= arr.length` (ES §10.4.2.1
ArraySetLength via `[[DefineOwnProperty]]`).

### What changed

`src/codegen/object-ops.ts` only:
- `parseCanonicalArrayIndex(key)` — canonical array index per
  `ToString(ToUint32(n)) === key`, range `[0, 2^32-2]`. Excludes `"length"`,
  `"01"`, `"-1"`, `"1.5"`, `"4294967295"`.
- `maybeEmitVecLengthGrowth(ctx, fctx, objArg, propArg)` — emitted at the top
  of `compileObjectDefineProperty` before descriptor dispatch (so it fires for
  both the accessor and value sub-paths). No-op unless the receiver is a
  side-effect-free vec receiver (identifier / `this`, validated via
  `getVecInfo`) and the key is a canonical array index. Uses a fresh
  side-effect-free re-compile of the receiver to get the raw vec ref.

### Finding that corrects the spec (load-bearing)

The re-spec said "emit a guarded length bump: `if (n >= vec.len) vec.len = n+1`
via `struct.set` on field 0." **That alone is unsafe.** Bumping only the
logical length (struct field 0) leaves the physical backing `$data` array at
its old size, so a subsequent `for`-loop to `arr.length` or `arr.forEach`
**traps with "array element access out of bounds."** Verified by probe.

PR-0 therefore **also grows the backing `$data` array** (capacity → `n+1`,
`array.new_default` + `array.copy`), mirroring the indexed-assignment grow
path at `src/codegen/expressions/assignment.ts:2488-2578`. This keeps the vec
internally consistent (logical length never exceeds backing capacity), so
iteration and index reads no longer trap.

### Scope / boundary

PR-0 grows length + capacity and is independently valuable + safe (fixes a
real `arr.length`-after-numeric-`defineProperty` correctness bug without
introducing iteration traps). It does **not** yet store the value-descriptor's
value nor invoke accessor getters during iteration — newly-grown slots read as
the element default. The element/length accessor slow-path (the
`__array_idx_accessor_get` / `emitElementLoad` machinery + HasProperty) is
**PR-1's scope** and is not in this PR.

### Validation

- `tests/issue-1130.test.ts` (8 cases): index-grow value+accessor descriptors,
  `length`-key exclusion, no-shrink for in-range index, for-loop + forEach over
  the grown array do not trap, grown index reads default, `string[]` vec grows.
  All pass.
- Existing defineProperty suites (`issue-1460`, `issue-846`,
  `issue-846-class-static-prototype`) pass unchanged.
- Array suites (`array-capacity`, `array-bounds-elimination`,
  `array-oob-bounds-check`, `array-callback-three-params`) show identical
  pass/fail counts with and without the change (the failing ones fail on clean
  main too — `helpers.js` infra breakage, not this change). Zero regressions.

### Remaining (NOT in PR-0)

- **PR-1**: element + length accessor slow-path read (`emitElementLoad`,
  `__array_idx_accessor_get`, `__array_length_accessor_get`, `__to_length`,
  sentinel) gated on `ctx.arrayAccessorObserved`; HasProperty; forEach.
- **PR-2**: fan-out to map/every/some/filter/reduce/reduceRight.
- **Open question still open**: interior-hole representation (`[9, , 12]`).
  PR-0 does not touch holes, so it is unaffected; PR-1's HasProperty work must
  resolve it (flag to architect if it blocks a majority of the 96).
