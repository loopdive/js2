---
id: 2862
title: "Standalone: ToPrimitive throws 'Cannot convert object to primitive value' for built-in exotics + inherited valueOf/toString"
status: blocked
created: 2026-06-30
updated: 2026-06-30
priority: high
feasibility: hard
task_type: feature
area: codegen
goal: standalone
sprint: current
horizon: l
related: [2860, 1900, 2358, 2638, 1910]
umbrella: 2860
architect_spec: candidate
---

# Standalone: ToPrimitive incomplete for built-in exotics + inherited methods

## Problem

In `--target standalone`, converting many objects to a primitive throws
`TypeError: Cannot convert object to primitive value` where js-host succeeds.

### Impact (measured 2026-06-30)

**2,039 standalone-only failures** carry this signature (the single largest
error signature in the gap). Of these, **728 are "pure"** (no host-import leak —
ToPrimitive is the sole blocker; the rest also leak a generator/promise/symbol
import and additionally need their carrier). By category among the 2,039:
Object 476, TypedArray 304, language/expressions 293, String 189, RegExp 125,
Array 88, DataView 43, Set/Map/Iterator/Function ~80.

Note: the proximate throw is often in **harness** code (`assert.sameValue`/
`String(x)` formatting a value), so flipping these also depends on the value's
own representation reaching a primitive.

## Root cause

The Wasm-native `__to_primitive` engine (`src/codegen/object-runtime.ts:2011`,
#1900/#2358/#2638) implements §7.1.1.1 OrdinaryToPrimitive over the standalone
runtime, with arms for:
- non-objects → unchanged
- `$__vec_base` (arrays) → `__array_to_primitive_string` (#2358)
- nominal class structs → `__class_to_primitive` valueOf/toString dispatch (#2638)
- `$Object` wrapper internal slot (`new Number/String/Boolean`) → slot value (#1910)
- `$Object` own-prop `valueOf`/`toString` via `__extern_get` + call, with a
  `"[object Object]"` default when `toString` is missing.

It falls to the `throwTypeError()` (object-runtime.ts:2278) when **none** match.
The misses are:

1. **Built-in exotic instances not modeled as `$Object`/`$Vec`/class-struct** —
   TypedArray views, DataView, ArrayBuffer, RegExp, boxed wrappers backed by a
   nominal runtime struct. These reach the non-`$Object` arm (line 2192), miss
   `ref.test $__vec_base` and `__class_to_primitive` (no user valueOf/toString
   dispatcher), and return **unchanged** → caller's `__unbox_number`/string
   coercion then fails, or a later ToPrimitive throws.
2. **`$Object` instances whose `valueOf`/`toString` are INHERITED** (on a
   prototype, not own) — `__extern_get(obj, "toString")` only reads OWN props in
   standalone (the prototype chain / `Object.prototype.toString` is not
   materialized), so both probes miss. For the **number/default** hint the
   `"[object Object]"` default is only supplied on the `toString` arm
   (`defaultObjectToStringOnMissing`), and `valueOf` missing returns nothing →
   falls through to throw.

## Implementation Plan

This is substrate-scale; **tagged `architect_spec: candidate`** — wants a design
pass on the value-representation classifier before coding. Sketch:

### A. Built-in exotic → primitive arm (object-runtime.ts ~line 2196, the
`!ref.test $Object` block)
- After the `$__vec_base` and `__class_to_primitive` arms, add a
  brand-dispatch over the built-in nominal structs (TypedArray view structs,
  DataView, RegExp, ArrayBuffer). Each has a spec'd OrdinaryToPrimitive result:
  - TypedArray / Array-like → `Array.prototype.toString` style join (reuse the
    `__array_to_primitive_string` reservation pattern, array-to-primitive.ts).
  - RegExp → `RegExp.prototype.toString` (`"/source/flags"`) — native string.
  - DataView/ArrayBuffer → inherit `Object.prototype.toString` → `"[object DataView]"`/`"[object ArrayBuffer]"`.
- Use the reserve-placeholder-funcIdx + fill-in-post-processing discipline
  (array-to-primitive.ts / class-to-primitive.ts) since these helpers depend on
  carriers registered AFTER `__to_primitive`.

### B. Default Object.prototype.toString for the number/default hint
(object-runtime.ts:2138 `tryOrdinaryMethod`)
- When BOTH `valueOf` and `toString` own-prop probes miss on a `$Object`, supply
  the `"[object Object]"` default on the **final** probe regardless of hint
  (today only the `toString`-arm default fires). Spec: a plain object with no own
  valueOf/toString uses `Object.prototype.{valueOf,toString}`; valueOf returns
  the object (not primitive) so toString wins → `"[object Object]"`. So: if both
  own probes miss, return `"[object Object]"` rather than throwing. The throw
  must remain reachable ONLY when a present `toString`/`valueOf` returns an
  object (the genuine §7.1.1.1 TypeError — keep the existing return-if-primitive
  guard so a present-but-object-returning method still throws).

### Edge cases / regression guards
- A user object with `Symbol.toPrimitive` must still take precedence (that path
  is handled before `__to_primitive` in the coercion engine — verify it isn't
  short-circuited by the new exotic arm).
- `new Number(5)` etc. wrapper slot (line 2240) must still win over the new
  default-toString arm (order preserved).
- Confirm the genuine §7.1.1.1 TypeError tests still throw:
  `test/.../Symbol.toPrimitive/*returns-object*`, ordinary toString/valueOf
  returning an object.

## Test plan

Standalone fail/CE → pass:
- `test/built-ins/TypedArray/prototype/**` (toLocaleString, join via ToPrimitive)
- `test/built-ins/Object/getOwnPropertyDescriptor/15.2.3.3-*` (object formatting)
- `test/built-ins/Iterator/prototype/drop|take/**`
- `test/built-ins/RegExp/prototype/test/S15.10.6.3*`
- `test/language/expressions/**` ToPrimitive coercions

Validate full `merge_group` + standalone high-water. Expect the **728 pure**
to flip directly; re-measure the leak-bucket residual after #2864-#2867 land.
Zero host-mode regression (all arms `ctx.standalone`).

## Verify-first finding (2026-06-30, sendev) — root cause is mis-scoped; DO NOT code the substrate arms as-is

Verify-first against current main (`runTest262File(file, cat, undefined, "standalone")`,
the exact CI standalone path) shows the **proximate `"Cannot convert object to
primitive value"` throw is a JS-HOST TEST-RUNNER artifact, not the in-Wasm
`__to_primitive` engine.** The 728 "pure" tests are **heterogeneous** standalone
failures, all collapsed onto one signature by the runner's error-formatter.

### Mechanism (proven)
1. The standalone module compiles fine and `test()` throws a real
   `WebAssembly.Exception` at runtime (a genuine, per-test failure).
2. The runner's `extractWasmExceptionMessage` (`tests/test262-runner.ts:2913`,
   stack hits **line 2927**) extracts the payload via `err.getArg(tag, 0)` then
   calls **`String(payload)`**. The payload is a standalone Error object
   (Wasm-GC struct / `$Object`) with no JS-reachable `toString`, so the JS-host
   `String()` itself throws `TypeError: Cannot convert object to primitive
   value`. That host-side throw — NOT the in-Wasm engine — is what the baseline
   records (as `compile_error`/`fail` with this message).

### Evidence it is NOT the `__to_primitive` engine
- Direct standalone probes of the engine's suspected misses **do not throw**:
  `"" + new Uint8Array([1,2,3])` → `"1,2,3"` (works); plain `{}` → `"[object
  Object]"` (works); inherited `toString` → works; `new Number(5)*2` → 10
  (works). RegExp/DataView/ArrayBuffer concat return *wrong values* (0) but
  **do not throw** the TypeError.
- The sampled "ToPrimitive" failures test unrelated things:
  - `Object/getOwnPropertyDescriptor/15.2.3.3-2-14.js` → number→string **key
    coercion** (`ToString(+Infinity)`→`"Infinity"`); the in-Wasm throw is a
    null-deref on `desc.value` (lookup missed), nothing to do with object
    ToPrimitive.
  - `DataView/.../getInt8/toindex-byteoffset.js` → `ToIndex(byteOffset)`.
  - `TypedArray/prototype/fill/length.js` → `propertyHelper`/`verifyProperty`
    formatting.
  - `RegExp/prototype/global/this-val-regexp-prototype.js` → getter reflection
    (`Object.getOwnPropertyDescriptor(RegExp.prototype,'global').get.call(...)`).

### Recommended sequencing (supersedes the Implementation Plan sketch)
1. **De-mask first (triage-enablement):** make `extractWasmExceptionMessage`
   (and the CI worker `scripts/compiler-fork-worker.mjs`, if it shares the path)
   never throw while stringifying a Wasm-GC payload — wrap `String(payload)` in
   try/catch and/or read the error struct's message field defensively, falling
   back to a generic class label. **Error-text only — flips zero pass/fail**, so
   the standalone-floor (pass count) and the regression gate (pass→fail
   transitions) are unaffected; it only relabels the ~2014 entries onto their
   REAL signatures so the cluster can be triaged.
2. **Re-triage** the now-visible signatures into real clusters (number→string
   key coercion, `ToIndex` object coercion, getter reflection, propertyHelper
   formatting, …) and file/route those as separate issues.
3. The genuine `__to_primitive` arms A/B in the plan above ARE real spec gaps
   but address only a subset (e.g. RegExp/DataView concat returning the wrong
   value) — they must NOT be sold as flipping all 728.

**Status set to `blocked`** pending the architect design pass this issue is
already tagged for (`architect_spec: candidate`). The claim is released so the
de-mask step (a test-infra change, not this compiler substrate) can be routed
independently.
