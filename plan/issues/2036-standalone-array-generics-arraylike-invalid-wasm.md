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

## Stage 1 landed (2026-06-13) — stop the bleeding (NET-NEGATIVE, do not re-ship as-is)

Stage 1 (`compileArrayPrototypeCall` returning `undefined` for non-native-vec
receivers under standalone, so borrowed Array calls refuse loud) was tried and
came back **net-negative**: it converted ~430 invalid-Wasm/null-deref rows into
loud refusals but ALSO refused a meaningful number of array-like calls that
were previously *passing* (or passing-by-luck) on real-array receivers and on
shapes the existing `compileArrayLikePrototypeCall` loop already handled. The
refusal gate was too coarse. Stage 2 below replaces the refusal with a correct
native `$Object` arm so the previously-working rows keep working AND the broken
ones become correct (not merely refused).

## Implementation Plan (stage 2 — architect spec, 2026-06-13)

### Root cause (precise)

Two facts collide in standalone mode:

1. `compileArrayLikePrototypeCall` (`src/codegen/array-methods.ts:466`) emits a
   correct generic loop: `len = __extern_length(recv)`, `elem =
   __extern_get_idx(recv, i)`, callback via `call_ref`, search methods inline.
   It is **target-agnostic** — it just calls those two helpers by funcMap name.
2. In standalone, `__extern_length` / `__extern_get_idx` are NOT host imports —
   they are **native funcs registered in `ensureObjectRuntime`**
   (`src/codegen/object-runtime.ts:2656` and `:2716`). BUT both bodies only
   recognise a wrapped **`$ObjVec`** (the enumeration-result vector type) and
   return `0` / `null` for anything else — including a real array-like
   `$Object` such as `{0:5, 5:'length', length:6}`.

So the generic loop runs with `len = 0` over an `$Object` receiver → `indexOf`
returns `-1` (silent wrong, repro #3), and the f64/i32-typed fast paths that
`resolveArrayInfo` shape-infers for some receivers emit element loads against an
externref (invalid Wasm, repro #1) / null-deref (repro #2).

**The fix is NOT a new dispatch arm — it is to teach the two existing
standalone helpers to read an `$Object` receiver.** Once they do, the
target-agnostic loop in `compileArrayLikePrototypeCall` works unchanged.

### Spec basis

Array.prototype methods are intentionally generic
([§23.1.3 note](https://tc39.es/ecma262/#sec-properties-of-the-array-prototype-object));
each method does `len = ToLength(Get(O, "length"))`
([§23.1.3.17 indexOf](https://tc39.es/ecma262/#sec-array.prototype.indexof) step
2-3) and element access via `Get(O, ToString(k))`
([HasProperty §7.3.12](https://tc39.es/ecma262/#sec-hasproperty) +
[Get §7.3.2](https://tc39.es/ecma262/#sec-get)). For an `$Object` that means:
`length` is the own/proto property keyed by the string `"length"`, and element
`k` is the own/proto property keyed by `ToString(k)` (the canonical decimal).

### Changes

**File: `src/codegen/object-runtime.ts` — `__extern_length`
(registration at `:2656`, body built `:2638-2662`)**

- Add an `$Object` arm BEFORE (or after) the existing `$ObjVec` arm:
  - `any = any.convert_extern(v)`; if `ref.test $Object`:
    - `o = ref.cast $Object`; `e = __obj_find(o, key="length")` where the key is
      the interned native string `"length"`. Use the same string-construction
      path the runtime already uses for static keys (see how `__obj_find`
      callers in this file build a `$AnyString` key — e.g. the `__object_keys`
      / `__getOwnPropertyDescriptor` neighbours pass an externref key; for a
      *constant* `"length"` key, emit a `$NativeString` literal via the existing
      native-string-literal builder used elsewhere in this file, then
      `extern.convert_any`).
    - If `e` is non-null: read `e.value` (anyref), coerce to f64 via the
      runtime's existing **ToLength**/number-unbox path. The value may be a
      boxed number (externref → `__unbox_number`) or already a native f64 box —
      reuse whatever `__extern_get`'s number-return path uses. Clamp to
      ToLength: `max(0, min(trunc(n), 2^53-1))`; return f64.
    - If `e` is null (no `length` own prop) → walk proto chain via `o.proto`
      (the `$Object.proto` field, index 0) repeating `__obj_find`; if still null
      → return `f64.const 0` (matches `ToLength(undefined) = 0`).
  - Keep the existing `$ObjVec` arm and the final `f64.const 0` fallback.
- **Prefer extracting a shared `__obj_get_length(externref) -> f64` native
  helper** (ToLength of `Get(O,"length")`) and call it from both
  `__extern_length` and any future array-like consumer, rather than inlining
  the proto-walk twice. Register it next to `__obj_find` so funcMap ordering is
  stable (see the `ensureObjectRuntime` index-stability note at `:120-140`).

**File: `src/codegen/object-runtime.ts` — `__extern_get_idx`
(registration at `:2716`, body built `:2672-2726`)**

- Add an `$Object` arm before the existing `$ObjVec` arm:
  - `any = any.convert_extern(v)`; if `ref.test $Object`:
    - `o = ref.cast $Object`; `key = ToString(i32(idx))` — build the decimal
      string of the (already-truncated) integer index. Reuse the existing
      number→native-string helper the runtime uses for `String(n)` /
      key-stringification (grep `__num_to_str` / `__f64_to_string` /
      `__number_toString` in this file and `string-ops.ts`; the `$Object`
      keyed-get path for `obj[0]` member access already stringifies numeric
      keys — reuse THAT path, do not write a new int→string).
    - `e = __obj_find(o, key)` (own); if null → proto-walk via `o.proto`; if
      still null → `ref.null.extern` (matches absent element).
    - else → return `e.value` wrapped to externref
      (`extern.convert_any` if the stored anyref needs it; values are stored as
      anyref — mirror `__extern_get`'s value-return marshaling at `:612`).
  - Keep the existing `$ObjVec` arm + null fallback.
- **`__extern_has_idx` (`:2961`)** must get the SAME `$Object` arm so the
  `indexOf`/`forEach` hole-skipping (`HasProperty` per §23.1.3.17 step 8.a)
  is correct: `e = __obj_find(o, ToString(i))`, return `e != null` (proto-walk
  included). Without this, holes vs. `undefined` values diverge from spec and
  the `15.4.4.14-5-*` "skip absent index" tests fail.

**File: `src/codegen/array-methods.ts` — REVERT the stage-1 refusal**

- Undo the stage-1 change in `compileArrayPrototypeCall` (the
  `ctx.standalone || ctx.wasi` early-return-`undefined` for non-native-vec
  receivers). With the helper fix above, the existing dispatch at
  `compileArrayPrototypeCall` (`:1789-1793`) — "`arrInfo` resolves → native vec
  fast path; else → `compileArrayLikePrototypeCall`" — is correct for BOTH
  targets. The array-like branch now produces valid standalone Wasm.
- Keep the existing guards in `compileArrayLikePrototypeCall` (null/primitive
  receiver bail at `:477-494`; `__vec_`/`__arr_` bail at `:508-521`;
  `assert_throws` bail at `:541-553`) — they are target-agnostic and still
  correct.

**File: `src/codegen/expressions/calls.ts` — Array brand refusal (`:3194-3207`)**

- The `typeName === "Array"` borrowed-call refusal arm (the "rides on #6407"
  cite) is a SEPARATE path that fires for `Array.prototype.m.call(recv)` when
  the receiver did NOT shape-infer to an array and the call did not reach
  `compileArrayPrototypeCall`. Verify whether the array-like cases now route
  through `compileArrayPrototypeCall` (`:2610-2614`) BEFORE reaching this
  refusal. If they do, no change. If some borrowed-call forms reach the refusal
  first, route them to `compileArrayLikePrototypeCall` (synthesise
  `recv.m(...args)` exactly like the String arm at `:3151-3154` does) instead of
  refusing. **Trace one `15.4.4.14-3-*` repro through the dispatcher to confirm
  which path it takes before editing — do not edit both blindly.**

### Wasm IR pattern (the `$Object` arm shared shape)

```wasm
;; inside __extern_get_idx / __extern_length / __extern_has_idx
local.get $v
any.convert_extern
local.tee $any
ref.test $Object
if
  local.get $any
  ref.cast $Object
  local.set $o
  ;; key = "length"  (length helper)  OR  ToString(i32(idx))  (idx helpers)
  ...build $AnyString key, extern.convert_any...
  local.get $o
  ;; proto-walk loop: e = __obj_find(o, key); while e==null && o.proto!=null { o=o.proto; e=__obj_find(o,key) }
  call $__obj_find        ;; -> ref null $PropEntry
  ;; if null after walk -> default (f64.const 0 / ref.null.extern / i32.const 0)
  ;; else read e.value (field 1), marshal to result type
end
;; ...existing $ObjVec arm + final fallback unchanged...
```

### Edge cases

- **`length` is a float / coercible (`length: "6"`, `length: 6.9`)**:
  ToLength must `ToNumber` then `truncate` then clamp ≥0, ≤2^53-1. A string
  `length` requires `__unbox`/`ToNumber` on the stored value — route through the
  runtime's existing ToNumber, do NOT assume the value is already f64.
- **Holes vs. `undefined`**: `__obj_find` returning null ⇒ absent (hole) ⇒
  `__extern_has_idx` false. A present entry whose value is boxed-undefined ⇒
  present ⇒ `__extern_has_idx` true, `__extern_get_idx` returns undefined. These
  must differ (the `-5-*` tests assert it).
- **proto-chain `length`/elements**: array-likes can inherit `length` from a
  proto (test262 `15.4.4.*-3-*` uses prototype objects). The proto-walk is
  REQUIRED, not optional. `$Object.proto` is field index 0.
- **Tombstones**: `__obj_find` already skips tombstones (it is the canonical
  own-lookup) — reuse it, never walk the raw `$PropMap` array directly.
- **Non-`$Object`, non-`$ObjVec` receiver** (e.g. a native `$Vec` that slipped
  through, or a boxed primitive): fall through to the existing `$ObjVec`/`0`/null
  fallback — i.e. unchanged behaviour, no new trap.
- **Numeric key canonicalization**: `ToString(0)` is `"0"`, `ToString(5)` is
  `"5"` — the decimal must match how the `$Object` stored numeric-literal keys
  (the object-literal/member-assign path stringifies `{0: x}` to key `"0"`).
  Reuse the SAME stringifier both sides use or lookups silently miss.
- **`assert_throws`-wrapped throwing getters**: still bail to host
  (`:541-553`) — `$Object` props are data slots with no getter invocation in
  this runtime, so the standalone arm cannot reproduce a throwing-getter at a
  numeric index; routing those to host preserves the throw. (Accessor-prop
  array-likes are out of scope — they need #1888 Slice 5 accessor invocation.)

### PR split

1. **PR-1 (helper `$Object` arm + revert stage-1):** add the `$Object` arm to
   `__extern_length`, `__extern_get_idx`, `__extern_has_idx` (ideally via a
   shared `__obj_get_length` + reuse of the existing numeric-key stringifier),
   and revert the stage-1 refusal in `compileArrayPrototypeCall`. This makes the
   minimal repro return `5` and converts the invalid-Wasm/null-deref/wrong-`-1`
   rows to correct results. Scope: `object-runtime.ts` + `array-methods.ts`.
2. **PR-2 (calls.ts borrowed-call routing, only if the trace in §Changes shows
   borrowed forms reaching the refusal first):** route the Array borrowed-call
   refusal to `compileArrayLikePrototypeCall`.
3. **PR-3 (residual runtime-assert rows):** the ~308 callback-evaluation
   assertion rows — re-measure after PR-1; many resolve once the receiver reads
   correctly. Reassign whatever remains.

### Regression risk

- `__extern_length`/`__extern_get_idx` are ALSO used by the host-mode array
  iteration consumers and the `Object.keys`/enumeration path. The `$Object` arm
  is gated behind `ref.test $Object` and runs only when the existing `$ObjVec`
  arm would have returned 0/null — so it is strictly additive for receivers the
  helpers previously gave up on. **Verify host mode is byte-identical** (the
  helpers are shared, but host mode rarely reaches the native `$Object` arm
  because host receivers are real externrefs handled by the JS import — confirm
  no host test flips). Run the full `built-ins/Array/prototype` standalone slice
  AND a host-mode array spot-check before merge.
- **funcIdx stability**: adding a shared `__obj_get_length` native func in
  `ensureObjectRuntime` shifts later funcMap indices — follow the existing
  registration-ordering discipline in that function (`:120-145`) and flush any
  pending late-import batch first, exactly as the surrounding helpers do.

### Test files to verify
- `tests/issue-2036.test.ts` (extend): standalone `indexOf.call({0:5,5:'length',length:6}, 'length')` ⇒ `5`;
  `filter`/`forEach`/`some`/`every` over an array-like in standalone produce the
  same result as host; proto-inherited `length`; hole-skipping (`-5-*` shape).
- Keep the stage-1 cases that assert real-array receivers still work in
  standalone (`indexOf.call([10,20,30],20) === 1`).
- test262 standalone slice: `15.4.4.14-3-*`, `15.4.4.14-5-*`, `15.4.4.20-3-*`
  move to pass; `local.set expected f64, found externref` rows → 0.
