---
id: 3068
title: "codegen: pure-Wasm String.prototype.isWellFormed / toWellFormed (§22.1.3) — standalone/WASI lowering"
status: done
completed: 2026-07-06
sprint: current
priority: medium
horizon: m
feasibility: easy
reasoning_effort: low
task_type: feature
area: codegen
language_feature: string-builtins, es2024
goal: spec-completeness
related: [3064, 3063, 2500]
test262_bucket: string-wellformed
assignee: ttraenkler/dev-cycleE
origin: "2026-07-06 harvest (dev-cycleE). origin/main; standalone/WASI (host-free) lane. Follow-up in the escape/URI dual-mode-completion vein — String.prototype.isWellFormed / toWellFormed have no standalone-native lowering."
---

# #3068 — `String.prototype.isWellFormed` / `toWellFormed` have no standalone (host-free) lowering

## Problem

`String.prototype.isWellFormed()` (§22.1.3.8) and `String.prototype.toWellFormed()`
(§22.1.3.34) are ES2024 methods that inspect / repair a string's UTF-16
code-unit sequence with respect to lone surrogates:

- `isWellFormed()` → `true` iff the string contains no lone surrogate (every
  leading surrogate `U+D800..U+DBFF` is immediately followed by a trailing
  surrogate `U+DC00..U+DFFF`, and there is no unpaired trailing surrogate).
- `toWellFormed()` → a copy of the string with every lone surrogate replaced by
  U+FFFD (`REPLACEMENT CHARACTER`). Replacement is 1 code unit for 1, so the
  result has the same length.

In **JS-host mode** these dispatch through the generic `__extern_method_call`
bridge to the real engine method — 14/16 test262 files pass. Under
`--target standalone` / `--target wasi` there is no host: the call reaches
`compileNativeStringMethodCall`, matches no arm, and falls through to the
"Unknown string method" stub. `isWellFormed` produced **invalid Wasm** (a
type mismatch: `expected externref, found (ref null $type)` at instantiate) and
`toWellFormed` produced a wrong result — every `String/prototype/{isWellFormed,
toWellFormed}` file failed in the host-free lane (standalone `host_free_pass`
floor). This is the exact dual-mode gap the #679/#682 architecture wants a
Wasm-native path for (mirrors #3064 `escape`/`unescape`).

```ts
// --target standalone, before this fix:
"abc".isWellFormed();      // invalid Wasm (expected externref)
"\uD800".isWellFormed();   // should be false
"a\uD800b".toWellFormed(); // should be "a�b"
```

## Fix

Emit WasmGC-native `__str_isWellFormed` / `__str_toWellFormed` helpers — pure
UTF-16 code-unit scans over the flattened `$NativeString` i16 array, no Unicode
tables, no host import (mirrors `escape-native.ts`, but even simpler: 1:1
replacement, no transcoding).

- `src/codegen/wellformed-native.ts` (new) — `emitNativeWellFormedHelpers(ctx,
  strTypeIdx, strDataTypeIdx, anyStrTypeIdx)`:
  - `__str_isWellFormed(s: ref $NativeString) -> i32` — scan; return 0 on the
    first lone surrogate, else 1.
  - `__str_toWellFormed(s: ref $NativeString) -> ref $NativeString` — copy code
    units, substituting U+FFFD for each lone surrogate, into a same-length
    output array wrapped in `struct.new $NativeString`.
- `src/codegen/native-strings.ts` — `ensureNativeStringHelpers` calls
  `emitNativeWellFormedHelpers` (alongside `emitNativeCaseConversion`) so the
  helpers exist before any body is compiled (no mid-body late-import shift).
  `ensureNativeStringHelpers` is a precondition of every
  `compileNativeStringMethodCall`, so the helpers are always registered when the
  arm needs them — no `STRING_METHODS` entry required to trigger emission.
- `src/codegen/string-ops.ts` — arms in `compileNativeStringMethodCall`:
  `emitReceiver(); emitFlatten(); call __str_{isWellFormed,toWellFormed}`. These
  only run under `ctx.nativeStrings` (standalone/WASI); host mode never reaches
  them.
- `src/checker/index.ts` — add `lib.es2024.string.d.ts` to `ES_BASE_LIB_NAMES`
  so the checker types `X.isWellFormed()` / `X.toWellFormed()` as `boolean` /
  `string`. Without the lib the result is `any`, and `X.toWellFormed() === y`
  silently lowers to reference equality (always false for distinct strings).

Host mode is untouched (byte-identical): `isWellFormed`/`toWellFormed` are NOT
added to `STRING_METHODS`, so a string-typed receiver keeps dispatching through
the generic `__extern_method_call` bridge to the real ES2024 engine method (the
existing behaviour, 14/16 test262 host-lane passes). The only host-visible change
is the added lib, which corrects the static type of the two methods.

## Acceptance criteria

- Standalone `isWellFormed`/`toWellFormed` compile **host-free** (no `env`
  import beyond the shared `console_log`) and match §22.1.3.8/.34 (in-Wasm
  assertions).
- Host mode stays green.
- Raises the standalone `host_free_pass` floor by the
  `String/prototype/{isWellFormed,toWellFormed}` files that previously failed
  host-free.
