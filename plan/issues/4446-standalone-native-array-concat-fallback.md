---
id: 4446
title: "standalone: Array.prototype.concat extern fallback leaks __array_concat_any/__js_array_new/__js_array_push — lower natively"
status: done
sprint: 78
created: 2026-08-15
updated: 2026-08-18
completed: 2026-08-15
assignee: claude/es6-standalone-session
priority: high
horizon: m
feasibility: medium
task_type: conformance
area: codegen
es_edition: es6
goal: standalone-mode
related: [4444, 2961, 1359, 2860]
coercion-sites-allow:
  - src/codegen/array-concat-spec.ts
---

# #4446 — standalone native Array.prototype.concat fallback

## Problem

`compileArrayConcatExtern` (`src/codegen/array-methods.ts` ~L4113-4175) is the
fallback when any concat operand is not a statically-known WasmGC array (any-
typed receiver, `Symbol.isConcatSpreadable` objects, array-likes). It emits the
host imports `__array_concat_any` + `__js_array_new` + `__js_array_push`; in
the standalone lane the strict leak guard (#2961) turns that into a
compile_error: `standalone target emitted host imports: env::__array_concat_any…`.

**~30 non-passing ES2015 tests** under `built-ins/Array/prototype/concat/*`
(all CE), including every `isConcatSpreadable` protocol test. The same leaked
pair `__js_array_new`/`__js_array_push` also appears in Promise-combinator CEs
(owned by #2867 — out of scope here).

The native fast path directly above it (~L4090, WasmGC vec `array.copy` with
`emitBackingClampedArrayCopy`) already handles statically-typed array operands
— this issue is only the dynamic fallback.

## Implementation Plan (fable, 2026-08-15)

Spec (§23.1.3.1): result = ArraySpeciesCreate(O, 0); for O then each arg E:
if `IsConcatSpreadable(E)` (Object + `@@isConcatSpreadable` coerced via
ToBoolean, default IsArray(E)) append E's `0..ToLength(E.length)` elements via
HasProperty/Get; else append E itself. Final `Set(result, "length")`.

1. **Investigate the dynamic-object substrate first.** Standalone has a dynamic
   object runtime (`src/stdlib/object-runtime.ts`, `src/codegen/dyn-read.ts`)
   with property get/has and array-ness answers. Find the existing helpers for
   "is this dyn value an array", "get length", "indexed get", "indexed set /
   push" — the ES5 standalone lane already passes generic
   `Array.prototype.*` tests (#1461 array-like receivers is `done`), so
   these primitives exist. Reuse them; do NOT invent a second dyn-array ABI.
2. **Self-hosted or hand-emitted `__arr_concat_dyn`** taking the receiver and
   an args vec, implementing the spec loop over dyn values:
   spreadable-check (`@@isConcatSpreadable` read → ToBoolean, falling back to
   IsArray), ToLength on `length` (handles the
   `arg-length-exceeding-integer-limit.js` / `length-to-string-throws` abrupt
   cases), hole semantics via HasProperty (`concat` skips holes but counts
   them in length). Check how the standalone `slice`/`splice` generic paths
   (#1359, done) solved species + holes and mirror their approach; if a
   shared `ArraySpeciesCreate` helper exists, use it, else default-Array
   creation is acceptable for a first slice (species tests are a minority of
   the bucket — measure and say which remain).
3. **Rewire** `compileArrayConcatExtern` behind a target switch: standalone →
   the native lowering; JS-host (gc) → keep the existing host-import path
   unchanged (it is faster and complete there).
4. **Symbol plumbing**: `@@isConcatSpreadable` needs a well-known-symbol
   property read on a dyn object in standalone. Check how existing well-known
   symbol reads (`Symbol.iterator` in for-of dyn paths, `@@toStringTag`) are
   keyed in the object runtime and use the same keying. If Symbol keying is
   genuinely blocked on #2866 (Symbol carrier), implement the default
   IsArray(E) branch now, leave the @@isConcatSpreadable override subset
   failing, and record the residual count here.

## Validation

- Scoped run: `TEST262_TARGET=standalone TEST262_PATH_FILTER="built-ins/Array/prototype/concat" pnpm run test:262`
  Baseline: ~30 CE. Target: majority flip to pass; every remaining non-pass
  named in this file with its reason.
- Unit test `tests/issue-4446-concat-dyn-standalone.test.ts`: any-typed
  receiver concat, isConcatSpreadable=false array, spreadable object
  array-like, length-getter-throws abrupt — assert no `env::` imports in the
  emitted module (mirror an existing strict-leak assertion from #2961 tests).
- gc-lane equivalence: `npm test -- tests/equivalence.test.ts`.

## Implementation (2026-08-15)

Three files. The bulk lands in a NEW subsystem module rather than in
`array-methods.ts`, which is a tracked god-file — `check:loc-budget` and
`check:godfiles` both refuse a 270-line addition there, and their own advice is
"add code to the subsystem module, not the barrel/driver". After the split
`array-methods.ts` is 8881 lines (**below** its 8909 cap) and
`profile-godfiles.mjs --check` output is byte-identical to the base.

- **`src/codegen/array-concat-spec.ts`** (new) — the native lowering.
- **`src/codegen/array-method-host.ts`** — gains the JS-host bridge, moved
  verbatim from `array-methods.ts`.
- **`src/codegen/array-methods.ts`** — keeps only the two dispatch decisions.

- **`compileArrayConcatNativeSpec`** (new) — the §23.1.3.1 loop over dynamic
  operands, emitted inline (the operand count is static, so no args vec and no
  new module-level helper function is needed). Per operand E:
  `IsConcatSpreadable(E)` = `__extern_get(E, __box_symbol(6))` → null/undefined
  ⇒ `__extern_is_array(E)`, else `ToBoolean` via the shared `emitToBoolean`
  (`__is_truthy`); spreadable ⇒ `__extern_length(E)` (which already performs
  `Get` + ToLength §7.1.20 including the observable ToPrimitive walk) then
  `__extern_get_idx` per index into `__objvec_push`; non-spreadable ⇒ push E.
  A running f64 total enforces the step-5.c.iii `n + len > 2^53-1` TypeError —
  load-bearing beyond conformance, since it is what stops
  `length = Number.MAX_SAFE_INTEGER` from entering a 2^31-iteration loop after
  the i32 truncation.
- **`compileArrayConcatExtern`** now switches per target: `native-first`
  (standalone / wasi / explicit `semanticProviders`) → the native lowering;
  everything else → `compileArrayConcatExternHost`, the untouched
  `__array_concat_any` bridge.
- **`compileArrayConcatNativeDynamic`** (the pre-existing all-operands-are-arrays
  shortcut) now delegates to the same spec loop, keeping its unconditional walk
  only as the substrate-unavailable fallback. The shortcut spread every operand
  unconditionally, which is wrong for an array carrying a falsy
  `@@isConcatSpreadable`.

Deliberate under-approximations (both pre-existing, neither a regression):

- **ArraySpeciesCreate** is a plain `$ObjVec`, not a species-derived construct.
- **Holes are not preserved** — `$ObjVec` has no hole slot. The VALUES are
  spec-correct (`Get` of an absent index is `undefined`, exactly what
  `__extern_get_idx` answers), so `compareArray` tests pass; only a
  `hasOwnProperty` probe on the result could tell. This is also why the loop
  does NOT gate on `__extern_has_idx`: the gate would buy nothing and would
  actively drop legitimately-present `null` elements (`__extern_has_idx`
  answers 0 for a field holding the externref null — the #1382 note in
  `array-prototype-borrow.ts`).

## Test Results

Scoped `TEST262_PATH_FILTER="built-ins/Array/prototype/concat"` (69 files),
measured in this worktree on 2026-08-15:

| target | before | after |
| ------ | ------ | ----- |
| `standalone` | **13 pass** / 27 fail / 29 compile_error | **23 pass** / 45 fail / 1 compile_error |
| `gc` | (binaries byte-identical to after — see below) | **24 pass** / 45 fail / 0 compile_error |

`+10 standalone passes; 28 of the 29 compile_errors cleared` (the survivor is
`concat_non-array.js`, a `__get_builtin` refusal unrelated to concat). **Zero
pass → non-pass transitions**: all 13 baseline standalone passes are retained.

The gc lane is proved unchanged by something stronger than a conformance run:
compiling all **69** concat test262 files for gc against the working tree and
against `git show HEAD:` (restored `array-methods.ts` + `array-method-host.ts`,
`array-concat-spec.ts` removed) yields **byte-identical `result.binary` for
every file** — 69/69 sha256 match. `gc` never reaches the new branch
(`semanticProviders` is `host-assisted` there), and the host bridge was moved
verbatim.

Re-measured after the module extraction: the standalone per-test result set is
identical to the pre-extraction measurement (`diff` of both result summaries is
empty), i.e. the extraction is a pure move.

Unit test `tests/issue-4446-concat-dyn-standalone.test.ts` — 13 assertions,
all green: zero `env::` imports for each of the four Validation fixtures, the
three retired imports absent by name, the §23.1.3.1 behaviours, the pinned
residual, and the gc lane still routing through `env::__array_concat_any`.

## Residual non-passes (46 of 69), by cause

None of these is in the concat loop itself; each names the substrate that owns it.

1. **ArraySpeciesCreate not implemented (12)** — `create-ctor-non-object`,
   `create-ctor-poisoned`, `create-species-abrupt`, `create-species-non-ctor`,
   `create-species-non-extensible{,-spreadable}`,
   `create-species-with-non-configurable-property{,-spreadable}`,
   `create-species`, `create-proto-from-ctor-realm-non-array`, `create-proxy`,
   `is-concat-spreadable-get-order` (needs the observable `constructor` read).
   The result is a plain `$ObjVec`; species needs the native constructor channel.
2. **`Array.prototype.concat` not callable as a VALUE standalone (5)** —
   `15.4.4.4-5-c-i-1`, `concat_array-like-string-length`, `concat_array-like`,
   `call-with-boolean`, `create-non-array`. A `#1888`-class builtin-method-as-value
   gap that fails before concat is ever entered.
3. **Symbol keys on a VEC receiver (2)** — `is-concat-spreadable-val-falsey`,
   `-val-undefined`. `item[Symbol.isConcatSpreadable] = v` on an array lands on
   numeric index 6 (so `item.length` becomes 7) instead of the symbol-key
   channel `__extern_get` reads, so IsConcatSpreadable falls through to IsArray.
   `Object.defineProperty(arr, Symbol.…)` does not corrupt length but is still
   invisible to `__extern_get`. **Reproduces identically on the untouched gc
   lane** (`item.length === 7` there too) ⇒ it is the #2866-adjacent symbol/vec
   property channel, not this issue. The object-receiver form works
   (`is-concat-spreadable-val-truthy` now passes).
4. **Symbol-keyed ACCESSORS not invoked (3)** — `is-concat-spreadable-get-err`,
   `concat_spreadable-getter-throws`, `concat_length-throws`. A throwing
   `@@isConcatSpreadable` / `length` getter installed via `defineProperty` is
   not run by the reflective read, so the abrupt completion never propagates.
5. **Proxy (3)** — `is-concat-spreadable-is-array-proxy-revoked`,
   `is-concat-spreadable-proxy-revoked` (illegal cast),
   `arg-length-exceeding-integer-limit` (its Proxy half; the non-Proxy half now
   throws the correct TypeError).
6. **Boxed-primitive / exotic operands (5)** — `spreadable-boolean-wrapper`,
   `spreadable-number-wrapper`, `spreadable-string-wrapper`,
   `spreadable-reg-exp`, `spreadable-function`. `new Boolean(true)` &c. as a
   concat operand do not round-trip through the reflective element channel.
7. **TypedArray operands (2)** — `concat_large-typed-array`,
   `concat_small-typed-array`: `__extern_get_idx` over a TypedArray answers
   0/NaN rather than the element.
8. **`arguments` object absent indices read back as `null`, not `undefined` (3)**
   — `concat_sloppy-arguments`, `-with-dupes`, `concat_strict-arguments`.
   Verified NOT general: an array-like `$Object`, an array hole and a stored
   `undefined` all read back as `undefined` from this same loop; only the
   arguments carrier answers null.
9. **`__extern_length` ToPrimitive gap (1)** — `concat_array-like-length-to-string-throws`:
   `illegal cast [in __call_valueOf() ← __to_primitive ← __extern_length]`.
10. **`concat_spreadable-sparse-object` (1)** — uncaught Wasm-GC exception.
11. **Pre-existing, not on the dynamic fallback at all (8)** —
    `S15.4.4.4_A1_T2`, `_A1_T4`, `_A2_T1`, `_A2_T2`, `_A3_T1`, `_A3_T2`,
    `_A3_T3` (typed vec path / null receiver), and the one surviving
    compile_error `concat_non-array.js` (`__get_builtin`, #1472).
