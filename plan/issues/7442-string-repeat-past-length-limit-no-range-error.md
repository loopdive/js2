---
id: 7442
title: "`'a'.repeat(Number.MAX_SAFE_INTEGER)` gives a 2^31-1 string instead of throwing RangeError"
status: done
sprint: current
created: 2026-11-20
updated: 2026-11-26
completed: 2026-11-26
priority: medium
horizon: s
task_type: bug
area: runtime, strings
goal: core-semantics
related: [7380]
# 2026-11-26 (#7442): one provider-ladder arm (+2) and its import (+2 names, 2026-11-27: on the existing
# ir-native-string-repeat.js import) resolve the IR pad helpers to the checked pad provider, in the same
# one-arm-per-provider shape as the repeat arms beside it; the ladder has no shared arm to fold it into.
loc-budget-allow:
  - src/ir/integration.ts
func-budget-allow:
  - src/ir/integration.ts::resolveAndObserveCallableProvider
---

# #7442 — `String.prototype.repeat` past the string length limit does not throw

## Problem

```ts
export function run(): number {
  try { return "a".repeat(9007199254740991).length; }
  catch (e) { return e instanceof RangeError ? -1 : -2; }
}
```

node: -1 (RangeError, "Invalid string length"). js2wasm, default JS target and `--target standalone`: 2147483647. No
exception at all: the native repeat clamps the result length to 2^31-1 code units.

Called from JavaScript through the compiled exports adapter,
`repeat("a", Number.MAX_SAFE_INTEGER)` instead throws `WebAssembly.RuntimeError` ("requested new array is too
large") when the adapter materializes that string.

Measured on `claude/7380-pins-b`, found by the #7380 PR 2b review.

## Evidence

`tests/issue-3518-string-repeat-ir.test.ts` "documents #7442: a result longer than the string limit traps instead of
throwing RangeError". The test pins the current wrong behaviour; the fix changes its expectation to `RangeError`.

## Acceptance criteria

1. When `count * length` exceeds the engine's string limit (and the string is not empty), `repeat` throws RangeError on
   both targets, in-module and through the adapter.
2. `"".repeat(Number.MAX_SAFE_INTEGER)` stays `""`; the other rows of the test are unchanged.
3. The pinning test flips to `RangeError`.

## Implementation Plan (2026-11-26)

Confirmed on `origin/main` c3b7be66, gc and standalone, default and legacy pipelines: `"a".repeat(2^53-1).length`
is 2147483647; `"a".padStart(2^53-1)` and `"a".padEnd(2^32, "b")` trap with `RuntimeError` ("requested new array is
too large") instead of throwing RangeError.

**Cause.** There is no shared native-string length limit. The IR repeat provider (`ir-native-string-repeat.ts`) has
one, `IR_COUNTED_STRING_REPEAT_NATIVE_MAX_RESULT_CODE_UNITS` (2^30, the bound that keeps rope-doubling intermediates
below 2^31), but throws the count message and is used only by IR. The legacy repeat arm (`string-ops.ts`) repeats the
count validation inline and then clamps with `i32.trunc_sat_f64_s`; the pad arms clamp ToLength the same way and the
kernels' doubling wraps.

**Target structure.**

- `src/ir/core/string-runtime.ts`: the constant becomes `NATIVE_STRING_MAX_LENGTH` (renamed, one definition); the
  counted-repeat proof keeps using it. The codegen alias `IR_NATIVE_STRING_REPEAT_MAX_RESULT_CODE_UNITS` goes.
- New `src/codegen/native-string-length-limit.ts`: the RangeError message (`Invalid string length`, as V8), one
  check builder `buildNativeStringLengthCheck(ctx, length)` (throw when an f64 length exceeds the limit), and the lazy
  pad provider `ensureNativeStringPadProvider(ctx, helper)`: one parameterised builder for `__str_padStart` /
  `__str_padEnd` that throws only after the spec's early returns (target ≤ length, empty fill) and then calls the
  kernel. Lazy, because the native-string prelude is throw-free: a throw there would register the error constructor
  import and tag in every native-string module.
- `ir-native-string-repeat.ts`: its result-size check becomes the shared check; the count check keeps
  `Invalid count value`.
- `string-ops.ts`: the repeat arm calls the repeat provider instead of duplicating its validation (removes the inline
  copy); the pad arms call the pad provider.
- `src/ir/integration.ts`: one provider-ladder arm next to the repeat arms resolves the two pad helper symbols to the
  pad provider, so IR-claimed pads throw too.

**Not in scope.** `+` / `concat` / templates wrap the i32 length past 2^31 rather than clamping; the linear backend
traps by design until #1838 (its repeat already checks its own byte limit).

**Acceptance (quality).** One limit constant, one check builder, one message; the legacy repeat arm loses its copy of
the count validation; no new prelude throw; bytes change only in functions that call repeat / padStart / padEnd
(100-file sample × default and standalone).

## Resolution (2026-11-26)

Implemented as planned. Measured against `origin/main` c3b7be66:

- `tests/issue-7442-native-string-length-limit.test.ts` (11 cases × default/legacy × gc/standalone): 20 of 44 fail
  on main (every past-the-limit case), 44 pass with the fix. `tests/issue-3518-string-repeat-ir.test.ts`: the #7442
  pin flips to `RangeError` through the exports adapter.
- Byte identity: 100 test262 files (70 by stride, 30 by stride over files calling `repeat` / `padStart` / `padEnd`)
  × {default, standalone}, the same × legacy pipeline, and the 13 playground examples × {gc, standalone} ×
  {default, legacy}. Differing binaries: 16 test262 files per pipeline, every one calling repeat or pad; 2
  playground files in legacy only (`benchmarks.ts`, `benchmarks/string.ts`), whose counted append
  `str = str + "abcde"` legacy rewrites into a `repeat` call.

Sites that now use the shared limit: the IR repeat provider (`ir-native-string-repeat.ts`), the legacy repeat arm
(through that provider), the counted-repeat kernel proof (`irCountedStringRepeatFitsNativeKernel`), and padStart /
padEnd in the legacy arms and the IR provider ladder (`ir-native-string-repeat.ts` since 2026-11-27).

**As built (2026-11-27, quality fix).** `native-string-length-limit.ts` is folded into `ir-native-string-repeat.ts`:
the message, the check and the pad provider now sit beside the repeat provider, whose shape and helpers they share.
As its own module it gave `src/ir/integration.ts` a 55th `src/codegen/` import line (ir-layering ratchet, 54) and
joined the largest import SCC with a new `codegen -> ir` edge (import-cycles ratchet).
