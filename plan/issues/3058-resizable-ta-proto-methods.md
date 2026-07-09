---
id: 3058
title: "Resizable-TA proto-methods over a dynamic `$__ta_dyn_view` receiver — runtime-kind method dispatch (materialize-into-f64-vec + OOB ValidateTypedArray + write-back)"
status: ready
model: fable
priority: high
feasibility: hard
reasoning_effort: max
task_type: feature
area: codegen
language_feature: typed-array, resizable-arraybuffer, dynamic-index
sprint: current
horizon: l
created: 2026-07-05
updated: 2026-07-08
es_edition: ES2024
test262_category: built-ins/TypedArray
goal: standalone-mode
related: [3054, 3057, 1781]
---

# Resizable-TA proto-methods over a dynamic `$__ta_dyn_view` receiver

## Problem

Follow-up banked from #3057 (the dynamic-view element codec, PR #2741, merged
2026-07-05). #3057 wired **element get/set** (`ta[i]` / `ta[i] = v`) on a boxed
`$__ta_dyn_view` — the runtime-kinded shared-backing view produced by a dynamic
`new <ctorVar>(rab)` where `ctorVar` is a TypedArray constructor held in an
`any`-typed variable (the `for (let ctor of ctors)` shape every resizable
test262 file uses).

What #3057 did **not** wire is **prototype-method dispatch** on that view:

```ts
for (let ctor of ctors) {          // ctor : any
  const ta = new ctor(rab, 0, 4);  // ta : any, boxed $__ta_dyn_view (runtime kind)
  ta.at(-1);                        // RUNTIME "illegal cast" today
  ta.indexOf(3);                    // runs but returns -1 (scans the wrong backing)
  ta.slice();                       // wrong / traps
  ta.length;                        // ✅ already correct (accessor path)
  ta[2];                            // ✅ #3057 element codec
}
```

## Measure-first (senior-dev, opus, 2026-07-05 — against main @ 59d7b6fd5, i.e. POST-#3057)

Ran the standalone lane (`runTest262File(..., "standalone")`) over the 25
`built-ins/TypedArray/prototype/*/resizable-buffer.js` files plus the `with/`
and `sort/` resizable variants. Result on the post-#3057 base:

- **26 `fail`**, **1 `compile_error`** (`entries/resizable-buffer.js`),
  **1 `pass`** (`with/valid-typedarray-index-checked-after-coercions.js`).

Direct minimal-snippet probes (dynamic `new ctor(rab,0,4)` + method) pinned the
**mechanism** precisely:

| probe             | result             | meaning                                                            |
| ----------------- | ------------------ | ------------------------------------------------------------------ |
| `ta[2]` (element) | ✅ correct (#3057) | element codec works                                                |
| `ta.length`       | ✅ correct         | accessor path already handles the view                             |
| `ta.at(-1)`       | ❌ **illegal cast**| reaches a native method impl that `ref.cast`s to a concrete view   |
| `ta.indexOf(3)`   | ❌ returns `-1`    | runs over an empty/opaque backing (wrong vec)                      |
| `ta.slice()`      | ❌ wrong/throws    | species-producing; no dyn-view arm                                 |

### Root cause

The native array/TA method dispatch (`compileArrayMethodCall`,
`src/codegen/array-methods.ts`) resolves the receiver to a concrete WasmGC vec
type. For a **static** per-kind `$__ta_view` it has a materialization arm
(#3054 B1, array-methods.ts:~2997 `isTaViewTypeIdx`) that copies the view into a
native element-typed vec via `emitTaViewToVec` and rebinds the identifier, so the
ordinary method impl then runs. For a **dynamic** `$__ta_dyn_view` the receiver
is a boxed **externref** (`receiverIsExternref = true`) whose element kind is a
**runtime** `kind` field, so:

1. it never enters the `ref`/`ref_null` materialization branch, and
2. `emitTaViewToVec`'s template needs a **compile-time** kind descriptor
   (`taViewDecode`) — which the dyn view does not have.

So the method either `ref.cast`-traps (`.at`) or scans a default/empty vec
(`.indexOf` → -1).

### The "cheap proto-method" framing is PARTLY DISPROVEN

The dispatching task hypothesised a bucket of **cheap** read-only proto-methods
that flip enforced-assert tests with bounded effort. Measure-first shows this is
**not** how the test files are shaped: every `*/resizable-buffer.js` file
**interleaves `rab.resize(...)` with `assert.throws(TypeError, () => ta.<m>())`**
(the ValidateTypedArray out-of-bounds semantics — §23.2.3 methods begin with
ValidateTypedArray, which throws TypeError when the fixed-length view no longer
fits the shrunk buffer). So flipping a **whole** file to `pass` requires, per
method:

1. happy-path element read via the #3057 codec (the "cheap" part), **plus**
2. **ValidateTypedArray OOB → throw TypeError** (fixed-length view no longer
   fits after shrink), **plus**
3. **length-tracking effective length** after grow/shrink (auto-length views).

There is **no single cheap method** that flips a full enforced-assert file on
its own — the OOB-throw + effective-length machinery is a **shared prerequisite**
for all of them. That machinery is the real cost; once built, each method is a
thin arm. This makes the work an **L-sized shared-scaffolding** task, not a
budget-window slice — hence banked here rather than force-shipped at ~18% budget.

## Recommended design (de-risked by the measure-first)

**Build the shared scaffolding once, then add thin per-method arms.**

### 1. `emitTaDynViewToVec` — runtime-kind materialization into an f64 vec

Mirror `emitTaViewToVec` (`src/codegen/dataview-native.ts:2515`), but:

- The dyn view's kind is a **runtime** `kind` field, so the native vec's element
  type cannot be chosen at compile time. **Materialize into a single
  `__vec_f64`** (widen every kind to f64) — this makes the numeric read-side
  methods (`at`, `indexOf`, `lastIndexOf`, `includes`, `join`, `find*`, `every`,
  `some`, `forEach`, `reduce*`, `sort`, `toLocaleString`, `map`, `filter`) work
  through the **existing** f64-vec method impls for free.
- Decode each element by **runtime kind** using the #3057 codec engine — the
  nested `if`-chain over `TA_CTOR_KINDS` in `emitTaDynViewElementGet` is the
  exact pattern to reuse (extract a shared `emitDynDecodeAt(off, kind) -> f64`).
- Length = `pushTaDynViewEffectiveLen` (resolves the -1 auto-length sentinel to
  the live count; already exists).

### 2. `emitTaDynViewValidate` — ValidateTypedArray OOB → throw TypeError

A fixed-length dyn view (length field ≥ 0) is OOB when
`byteOffset + length*elemSize(kind) > buf.byteLength`. Emit that check and, on
OOB, `emitThrowTypeError` (the native throw helper already used across
`property-access.ts` / `type-coercion.ts` in the standalone lane). Auto-length
views (length field = -1) are never OOB by shrink (they track) — only OOB when
`byteOffset > buf.byteLength`. Call this at the **top** of every dyn-view method
arm (matches §23.2.3.* step 1 ValidateTypedArray).

### 3. Wire at the dispatch site (array-methods.ts:~2985)

Right where `receiverIsExternref` is computed, add: if `ctx.moduleUsesDynTaView`
and the probe-compiled receiver `ref.test $__ta_dyn_view`, then
`emitTaDynViewValidate` + `emitTaDynViewToVec` → f64 vec, rebind the identifier
(exactly like the B1 `$__ta_view` rebind at 2997), and let the ordinary f64-vec
method impl run.

### 4. Write-back for mutators (fill/copyWithin/sort/reverse/set)

Mirror #3054 B3 `emitTaViewWriteBack` — after the mutating method runs on the
f64-vec copy, byte-**encode** each element back through the codec
(`emitTaDynViewElementSet`'s per-kind encoder, incl. the Uint8Clamped clamp) into
the view's shared buffer. Capture the same (view local, effective len) so
copy-len == write-back-len.

### 5. Bucket split (per-method landing order)

- **Bucket A — read-side, no new value produced** (thin arms once 1–3 land):
  `at`, `indexOf`, `lastIndexOf`, `includes`, `join`, `find`, `findIndex`,
  `findLast`, `findLastIndex`, `every`, `some`, `forEach`, `reduce`,
  `reduceRight`, `toLocaleString`. Est. flips: ~15 files.
- **Bucket B — in-place mutators** (needs step 4 write-back): `fill`,
  `copyWithin`, `reverse`, `sort`. Est. flips: ~4 files.
- **Bucket C — species / new-view producers** (HARDER — the result must be a
  real TA with a `.buffer`, so materialize-into-f64-vec is insufficient; needs a
  species-constructed `$__ta_view`/`$__ta_dyn_view` result): `slice`, `subarray`,
  `map`, `filter`, `with`, `toSorted`, `toReversed`. **Bank C as its own
  follow-up** if it proves large — the test asserts (`result.buffer.resizable`,
  `!result.buffer.resizable`) require real buffer identity on the result.
- **Iterators** (`keys`, `values`, `entries` — the 1 CE): return iterator
  objects; separate small follow-up.

## Hazard (carry-over from #3057)

The dispatch site is **shared** with plain-array and static-TA-view `any`
receivers. **`ref.test $__ta_dyn_view` FIRST**; on a miss fall through to the
EXACT existing behavior. Gate all new emit behind `ctx.moduleUsesDynTaView`
(the #3057 module pre-scan) so a module without a dynamic TA construct is
**byte-inert** (verify sha256 of a non-dyn-view program unchanged). Reuse the
#3057 element codec (`emitTaDynViewElementGet/Set`, `pushElemSizeForKind`,
`pushTaDynViewEffectiveLen`, `pushTaDynViewInBoundsLen`) — do not duplicate it.

## Acceptance criteria

- `emitTaDynViewToVec` + `emitTaDynViewValidate` land with host-enforced unit
  tests (a dynamic `new ctor(rab,...)` view → `.at`/`.indexOf`/`.join` returns
  correct values; OOB after `rab.resize` throws `TypeError`; length-tracking
  after grow reads the new length).
- Bucket A methods flip their `*/resizable-buffer.js` files to `pass` on the
  standalone lane (these have ENFORCED structural asserts — `compareArray` /
  `ToNumbers` / `sameValue` — so the flip is **floor-VISIBLE**, not vacuous).
- A plain-array / static-view `any` receiver is **unchanged** (byte-inert
  regression guard, and a mixed-module sha256 check).
- Standalone floor does not regress; report the measured pass-count delta.

## Estimated impact

~15 Bucket-A files + ~4 Bucket-B files are floor-VISIBLE flips (enforced asserts).
Bucket C (~7 files) + iterators (1 CE) banked as harder follow-ups.

## References

- #3057 (PR #2741, merged) — dynamic-view element codec + `moduleUsesDynTaView`
  pre-scan + `emitTaDynViewElementGet/Set` + `pushTaDynViewEffectiveLen`.
- #3054 (D+E / B1 / B3) — `$__ta_dyn_view` construct, `emitTaViewToVec`,
  `emitTaViewWriteBack`, the `isTaViewTypeIdx` rebind arm (the exact templates).
- #1781 — resizable ArrayBuffer umbrella.
- `src/codegen/array-methods.ts:~2985-3026` — the dispatch/rebind site.
- `src/codegen/dataview-native.ts:2515` (`emitTaViewToVec`), `:2654`
  (`emitTaViewWriteBack`), `:1551`/`:1684` (element codec) — reuse.

## Landing-mode status (senior-dev opus-3058, 2026-07-05 — NOT started; banked clean)

Claimed under a hard budget-cliff (8% remaining → 5-day wait). After a full
read of the dispatch site + the #3057 codec, I made the disciplined call to
**bank rather than ship a half-PR**, because I found a **gap in the plan's
step 3 that materially changes the size** and cannot be closed safely in a
sub-15-min green slice. No compiler code was written; the implementation claim
is released. **This section de-risks the next attempt — read it first.**

### The crux the measure-first plan under-specified (the real blocker)

Plan step 3 says *"rebind the identifier exactly like the B1 `$__ta_view`
rebind at array-methods.ts:2997, and let the ordinary f64-vec method impl
run."* That B1 rebind is **UNCONDITIONAL and compile-time-typed**: at 2997 the
receiver's `actualType` is a concrete `ref`/`ref_null` `$__ta_view` typeIdx
known at compile time (`isTaViewTypeIdx(ctx, actualVecIdx)`), so it is *always*
that view and the local can be rebound to the materialized native vec with no
runtime guard.

For a **dynamic** `$__ta_dyn_view` the receiver identifier is statically
`any`/externref (`receiverIsExternref = true`, array-methods.ts:2969-2983) —
its dyn-view-ness is a **runtime** `ref.test`, not a compile-time fact. So an
*unconditional* rebind to an f64-vec local is **wrong**: within a
`moduleUsesDynTaView` module, any *other* `any`-typed receiver method call
(e.g. a plain-array `values.join(...)` where `values : any`) would then run the
f64-vec impl and `ref.cast`-trap — a real regression, exactly the "don't hijack
the shared dispatch site" hazard called out in the issue's Hazard section.

**Correct shape (what the next attempt must build):** a **runtime `ref.test
$__ta_dyn_view` branch that wraps BOTH method arms**, mirroring
`emitTaDynViewElementGet` (dataview-native.ts:1551) but around the *method*:

```
if (ref.test $__ta_dyn_view on <probe-compiled receiver>) {
    emitTaDynViewValidate(...)         // OOB fixed-length view → throw TypeError
    matVec = emitTaDynViewToVec(...)   // widen every runtime kind → __vec_f64
    <ordinary f64-vec method impl over matVec>     // arm 1
} else {
    <EXACT existing externref/plain-array method impl>   // arm 2 (unchanged)
}
```

The cost is that the generic method impl must be emitted into **two arms**
(the dyn-view f64-vec arm and the existing externref arm), which the current
`compileArrayMethodCall` structure does **not** do — it emits one impl after
the single rebind. Getting a second, guarded copy of the method body without a
recursive re-entry into `compileArrayMethodCall` is the actual engineering
work, and it is what makes this **L-sized**, not the per-method arms.

**Two viable implementations, pick in the next attempt:**

1. **Dedicated per-method inline emitters** (recommended for the FIRST small
   slice): write `emitTaDynViewAt` / `emitTaDynViewIndexOf` that fully compute
   the result inline over the #3057 byte codec behind a `ref.test` gate, with
   the `else` arm calling back into the *normal* method path. This keeps the
   blast radius to one or two methods and never touches the generic
   two-arm-ification. `.at` and `.indexOf` each flip a couple of enforced-assert
   `*/resizable-buffer.js` files (`at/`, `indexOf/`) — the smallest
   floor-positive slice. Still needs `emitTaDynViewValidate` for the interleaved
   `assert.throws(TypeError, ...)` asserts.
2. **Generic two-arm materialize** (the full Bucket A): restructure the dispatch
   so the whole method impl is emitted inside the `if ref.test` then-arm over a
   materialized `__vec_f64`, and the existing impl in the else-arm. Higher value
   (~15 files) but this is the L-sized restructure — do NOT attempt under a
   budget cliff.

### Scaffolding still to build (unchanged from the plan, all reusable):

- `emitTaDynViewToVec` — mirror `emitTaViewToVec` (dataview-native.ts:2515) but
  materialize into a single `__vec_f64` (widen every runtime kind to f64), using
  `emitDynDecodeDispatch` (the #3057 per-kind decode chain,
  dataview-native.ts:1443) for the element read and `pushTaDynViewInBoundsLen`
  (`:1821`) / `pushElemSizeForKind` (`:2160`) for length + width. Read-side
  Bucket-A methods then run through the existing f64-vec impls for free.
- `emitTaDynViewValidate` — a fixed-length dyn view (field0 length ≥ 0) is OOB
  when `byteOffset + storedLen*elemSize(kind) > buf.byteLength`; on OOB call
  `emitThrowTypeError` (`./expressions/helpers.js`, already used across
  property-access.ts / binary-ops.ts in standalone). Auto-length views
  (field0 = -1) are OOB only when `byteOffset > buf.byteLength`. This is
  REQUIRED — every `*/resizable-buffer.js` interleaves `rab.resize()` with
  `assert.throws(TypeError, () => ta.<m>())`.
- Bucket B write-back (`emitTaViewWriteBack` template, dataview-native.ts:2654,
  using `emitDynEncodeDispatch` at `:1488`) and Bucket C species/new-view
  producers remain banked as follow-ups.

### Byte-inertness (verified path, not yet coded)

Gate every new emit behind `ctx.moduleUsesDynTaView` + the runtime
`ref.test $__ta_dyn_view` FIRST, else fall through to the EXACT existing path —
so a module without a dynamic TA construct is byte-identical (sha256). The
`$__ta_dyn_view` type is registered on demand via `getOrRegisterTaDynViewType`.

### Oracle-ratchet note for the next attempt

`emitThrowTypeError` in a new dyn-view arm adds native `throw` sites; per the
#3000/#3057 precedent, if the oracle new-checker-call ratchet trips, pre-auth
the added call sites with a reason in the PR. No verdict-logic change is
involved, so no `oracle_version` bump is needed.

## LANDED — Bucket A first slice (senior-dev opus-3058b, 2026-07-06)

PR: runtime-kind two-arm dispatch for the **host-import-free read methods**
`at` / `indexOf` / `lastIndexOf` / `includes` / `toLocaleString`, plus the two
reusable scaffolding functions.

### What shipped (`src/codegen/dataview-native.ts`, `src/codegen/array-methods.ts`)

1. **`emitTaDynViewValidate`** (dataview-native.ts) — ValidateTypedArray
   (§10.4.5.11): a fixed view (field0 ≥ 0) is OOB when
   `byteOffset + storedLen*elemSize(kind) > buf.byteLength`; a length-tracking
   view (field0 = −1) is OOB only when `byteOffset > buf.byteLength`. On OOB →
   `emitThrowTypeError`. Required for the interleaved
   `assert.throws(TypeError, () => ta.<m>())` cases.
2. **`emitTaDynViewToVec`** (dataview-native.ts) — materialize the runtime-kinded
   view into a fresh `$__vec_f64` by decoding every in-bounds element via the
   #3057 `emitDynDecodeDispatch` engine (widen every kind → f64) with a
   **runtime** `elemSize`; length = `pushTaDynViewEffectiveLen` (resolves the −1
   auto-length sentinel).
3. **`emitDynViewMethodTwoArm`** (array-methods.ts) — the runtime
   `ref.test $__ta_dyn_view` branch. THEN: validate → materialize → rebind the
   receiver identifier to the f64-vec local → re-enter `compileArrayMethodCall`
   (`skipDynViewWrap=true`, concrete vec ref so it can't re-trigger). ELSE:
   **re-dispatch the WHOLE call via `compileExpression(callExpr)`** guarded by a
   `dynViewTwoArmActive` WeakSet — this reproduces the caller's EXACT non-dyn-view
   behavior including the host/externref fallbacks that live ABOVE
   `compileArrayMethodCall` (which returns `undefined` for an externref receiver).
   Both arms unify to `externref` (the branch's typed-if result rep).

### The crux the banked plan under-specified, now resolved

The banked note correctly said the ELSE arm must be "the EXACT existing impl,"
but its step 3 assumed that impl is reachable by re-entering
`compileArrayMethodCall`. It is **not**: for an externref receiver
`compileArrayMethodCall` returns `undefined` and the real impl is the **caller's
tail** (host/`__extern_method_call`/native-vec fallbacks). Re-entering
`compileArrayMethodCall` in the ELSE arm produced `undefined` → the two-arm
silently abandoned → no flip. The fix is to re-dispatch the entire `callExpr`
through `compileExpression` (with a WeakSet re-entry guard) so the ELSE arm runs
the caller's full fallback verbatim.

Late-import safety: outer body + both arm buffers stay registered on
`fctx.savedBodies` for the whole build (the shift walker dedups by array
identity), so a late-import funcIdx shift in either arm patches everything —
no manual `shiftFuncIndices` and no double-remap.

### Measured floor flips (standalone lane, host-enforced asserts)

+3 files flip fail→pass (enforced `sameValue`, non-vacuous):

- `indexOf/resizable-buffer-special-float-values.js`
- `includes/resizable-buffer-special-float-values.js`
- `lastIndexOf/resizable-buffer-special-float-values.js`

Byte-inert for non-dyn-view modules (gated on `moduleUsesDynTaView`); the base
compiled the identical binary for a plain-array program (verified by construction
+ empty-imports assertion in the test).

### Still banked (blocked, not attempted here)

- **`join` + the callback methods** (`find*`/`every`/`some`/`forEach`/`reduce*`):
  their non-dyn-view ELSE arm re-dispatch pulls a **host import** in standalone
  (`env.<TA>_join`, `env.__make_callback`). Since both arms are emitted, that
  single `env.*` import makes the pure-Wasm module fail to instantiate — so these
  can only land once the standalone externref-receiver join/callback paths are
  Wasm-native (a separate follow-up). This is why the initial `DYN_VIEW_READ_METHODS`
  set is exactly the 5 host-import-free methods.
- **The main `*/resizable-buffer.js` files** (the larger prize) are blocked by an
  **unrelated harness limitation**, not the method dispatch: `resizableArrayBufferUtils.js`
  builds subclass constructors via `new Function('return class MyUint8Array extends
  Uint8Array {}')()` and iterates them in `ctors`/`floatCtors`. Standalone can't build
  a `Function`-constructor TA subclass, so the `for (ctor of ctors)` loop hits an
  undefined ctor and the harness element access traps ("array element access out of
  bounds") BEFORE any method assert. Needs TA-subclass + `Function`-ctor support —
  out of scope. (The `special-float-values` variants use a narrower path that flips.)
- **Bucket B** (mutators `fill`/`copyWithin`/`reverse`/`sort` — need
  `emitTaDynViewWriteBack`, mirroring #3054 B3 `emitTaViewWriteBack` +
  `emitDynEncodeDispatch`) and **Bucket C** (species/new-view producers) remain
  banked per the plan.

### Tests

`tests/issue-3058-dyn-view-proto-methods.test.ts` — 11 host-enforced cases:
each of the 5 methods over a dyn view returns the correct value; fromIndex;
byteOffset/windowed views; length-tracking; OOB-after-shrink → `TypeError`
instance; regrow restores; the plain-array `any` HAZARD GUARD; and the
byte-inert (zero env imports) check.
