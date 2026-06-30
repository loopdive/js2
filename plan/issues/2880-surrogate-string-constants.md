---
id: 2880
title: "Host mode: string constants containing lone surrogates arrive as `undefined` (lossy UTF-8 import-name encoding)"
status: done
assignee: ttraenkler/explore2
created: 2026-06-30
updated: 2026-06-30
completed: 2026-06-30
priority: medium
feasibility: medium
task_type: bug
area: runtime
language_feature: string-literals
goal: test262
sprint: current
horizon: m
related: [679]
---

# Host mode: string constants with lone surrogates corrupt to `undefined`

## Problem

In **host (JS-string) mode** — the default and the mode test262 runs in — a
string literal that contains a **lone (unpaired) surrogate** code unit
(`U+D800`–`U+DFFF` not part of a valid pair) is silently corrupted: at runtime
the constant arrives as JS `undefined`, so any operation on it traps or returns
a wrong value.

Confirmed test262 failures (all `built-ins/String/prototype/*`, host mode):

- `codePointAt/return-single-code-unit.js` — `'123\uD800'.codePointAt(3)` etc.
- `codePointAt/return-first-code-unit.js` — lead-surrogate-without-trail cases
- `at/returns-code-unit.js` — `"12\uD80034".at(2)` must be `"\uD800"`
- `padStart/normal-operation.js`, `padEnd/normal-operation.js` — the assertions
  compare against an **expected constant** that has a lone surrogate
  (`'💩\uD83Dabc'`: padding split an astral pair, leaving a lone lead)
- `isWellFormed/returns-boolean.js`, `match/regexp-prototype-match-v-u-flag.js`

(Native-strings mode — `--target wasi/standalone` — is **already correct**: it
materializes string literals inline as `i16` arrays, so lone surrogates survive.
The bug is host-mode only.)

## Root cause

Host-mode string literals are emitted as **imported externref globals** from the
`string_constants` module, where the wasm **import field name IS the literal
text** (`addStringConstantGlobal`, `src/codegen/registry/imports.ts`). The
runtime (`buildStringConstants`, `src/runtime.ts`) builds a JS object keyed by
the same literal text whose value is the JS string; V8 resolves the import via
`string_constants[fieldName]`.

The wasm binary encodes the import field name via
`new TextEncoder().encode()` (`src/emit/encoder.ts` `name()`), which **replaces
every lone surrogate with U+FFFD** (it is lossy — lone surrogates are not valid
Unicode scalar values). So V8 decodes the field name back to a **different**
string (`'123�'`), and `string_constants['123�']` does not exist
(the JS object is keyed by the real `'123\uD800'`) → the import resolves to
`undefined`.

A WTF-8 encoding of the name would round-trip the surrogate, but **V8 rejects
WTF-8 import field names at module-decode time** (`field name: no valid UTF-8
string`) — the core wasm binary format requires names to be valid UTF-8, and the
JS-String-Builtins `importedStringConstants` relaxation does not apply to the
generic import-name validation in the V8 we target. So a lone surrogate
fundamentally **cannot** live in an import field name.

ECMA-262: §22.1.3.4 `codePointAt`, §22.1.3.1 `at`, §22.1.3.16/.17
`padStart/padEnd` (StringPad), §22.1.3.8 `isWellFormed` — all operate on the
String's UTF-16 code units, lone surrogates included. Lone surrogates are
legal String contents (Well-Formed Unicode is a separate predicate).

## Fix

Route **only** the (rare) string constants that contain a lone surrogate through
a **separate import namespace** `string_constants16` whose field name is the
**hex of the UTF-16 code units** (pure ASCII → always valid UTF-8, injective).
Both sides compute the identical hex key; the global's *value* stays the real
JS string (externref can hold any string, lone surrogates included).

- `addStringConstantGlobal` (compiler): if the value has a lone surrogate, import
  from `string_constants16` with field = `hexCodeUnits(value)`; the
  `stringGlobalMap`/`stringPool` still key on the **real** value, so codegen and
  the pool are unchanged.
- `buildStringConstants16` (runtime): for each pool string with a lone
  surrogate, key the global by `hexCodeUnits(s)`, value = `s`. Expose
  `string_constants16` as a namespace in `buildImports` and at every
  instantiate site.

**Surrogate-free constants are completely untouched** — same `string_constants`
namespace, same literal field name, byte-identical binary — so there is zero
regression risk to the ~33k passing tests.

## Test Results

`tests/issue-2880.test.ts` — 8 tests pass (helper unit tests + host-mode
codePointAt/charCodeAt/length/at/padStart/padEnd/equality on lone-surrogate
constants + a surrogate-free regression control).

**Scoped fresh single-file sweep** (one Node process per file via the real
`parseMeta`+`wrapTest`+`compile`+`buildImports`+`WebAssembly.instantiate`
harness, matching `scripts/test262-worker.mjs`). Of the 32 lane files
(`built-ins/String/prototype` + `built-ins/RegExp`) whose decoded source
contains a lone surrogate:

| | baseline | with fix |
| --- | --- | --- |
| pass | 9 | 29 |
| fail | 19 | 0 |
| runtime_error | 4 | 3 |

**Net +20 new passes, 0 regressions.** Recovered: `String.prototype`
codePointAt×2, padStart, padEnd, at, isWellFormed, match (7); `RegExp`
dotall×4, regexp-modifiers×5, named-groups×2, escape, exec (13). The remaining 3
non-passes are unrelated (RegExp Symbol.replace Symbol-coercion,
match-indices `assert is not defined` harness shim).

A full re-sweep of the 1073-file `String/prototype` lane shows no
surrogate-free regression (the normal `string_constants` path is byte-identical).
