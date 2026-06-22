---
id: 2590
title: "Standalone `RegExp.escape(str)` static method (ES2025 §22.2.5.x)"
status: done
sprint: 65
priority: medium
feasibility: medium
parent: 2161
area: regexp
goal: standalone-mode
language_feature: regexp
task_type: conformance
created: 2026-06-22
completed: 2026-06-22
assignee: ttraenkler/agent-regexp-escape
---

# Standalone `RegExp.escape(str)` static method (ES2025)

Slice of umbrella #2161. **Substrate-independent** — pure string transform, no
regex engine and no value-rep involvement.

## Problem

`RegExp.escape` is the new ES2025 static method (Stage 4) that returns a string
with all regex-syntax-significant characters escaped so it can be safely embedded
in a pattern. It is **entirely unimplemented** in this compiler — in
`--target standalone` it leaks `env::__get_builtin` (the dynamic-builtin host
import) and the binary fails to instantiate.

Verified on current main: `RegExp.escape("a.b")` compiles but leaks
`env::__get_builtin`, so no standalone binary runs. The whole `RegExp/escape/`
test262 dir (14 in the standalone gap, all `compile_error`) plus the AnnexB
`RegExp-*-escape` cases fail.

## Spec (ES2025 §22.2.5 "RegExp.escape ( S )" / EncodeForRegExpEscape)

`RegExp.escape(S)`:
1. If `S` is not a String → **TypeError**.
2. Let `escaped` be the empty String, `cpList` the code points of `S`.
3. For the **first** code point: if it is an ASCII **decimal digit or ASCII letter**
   (`[0-9A-Za-z]`), escape it as `\xHH` (so the result never starts with a char that
   could combine into a quantifier/identifier). Otherwise process normally.
4. For every code point `c`:
   - If `c` is one of the **syntax characters** `^ $ \ . * + ? ( ) [ ] { } |` or
     the **solidus** `/` → prepend `\` (i.e. `\c`).
   - Else if `c` is a **white space / control / line terminator** in the
     "other punctuators to escape" set (`\t \n \v \f \r`, and the
     `ControlEscape`/whitespace set per the spec table) → escape as the canonical
     `\t`/`\n`/`\v`/`\f`/`\r`, or `\xHH` / `\uHHHH` / `\u{…}` for the rest.
   - Else → the code point unescaped.

**Fetch the exact spec text** (tc39.es/ecma262 RegExp.escape + EncodeForRegExpEscape)
and the test262 `escaped-*` files before coding — the per-character escape table
(which chars get `\xHH` vs `\uHHHH` vs a named escape) is precise and the tests
check it byte-for-byte. Implement from the fetched table, NOT from memory.

## Implementation Plan

### Approach — a native string-transform helper, dispatched as a static method

This is a deterministic char-by-char rewrite over a native string; no regex engine.

**File: `src/codegen/native-regex.ts`** (or a small new `regexp-escape.ts` —
keep it near the other native-string regex helpers)

1. New native helper `ensureRegexEscape(ctx)` → emits
   `__regex_escape(s: ref $AnyString) -> ref $AnyString`. Loop over the input
   string's code units / code points (reuse the same iteration the engine's
   `__str_*` helpers use — `charCodeAt`/code-point decode, see the existing
   `__regex_*` helpers for the surrogate-pair handling), building the output with
   `__str_concat` over per-character pieces (mirror `__regex_get_substitution`'s
   O(1)-piece concat construction, `native-regex.ts:2724`). Use `__str_from_char` /
   the existing single-char native-string constructors for the escape sequences.
   - First-char `[0-9A-Za-z]` → `\xHH`.
   - Syntax chars + `/` → `\` + char.
   - Control/whitespace set → canonical named escape or `\xHH`/`\uHHHH`/`\u{…}`.
   - Everything else → the char unescaped.
   Precompute the escape mapping at **compile time** in TS (a lookup the emitted
   loop branches on) so the Wasm stays a tight switch.

**File: `src/codegen/expressions/calls.ts`**

2. Add a `RegExp.escape(s)` dispatch next to the existing static-method handlers
   (`Number.isNaN` ~line 4287, `Object.is` ~line 5931, `Array.isArray` ~line 4400).
   Gate on `ctx.standalone` + the callee being the `RegExp` builtin ctor identifier
   and `name === "escape"`. Compile arg0 to a native string and emit the
   `__regex_escape` call; return `nativeStringType(ctx)`. **Before** the
   `__get_builtin` refusal/fallthrough so it never leaks the host import.
   - Host mode is untouched (it can keep the `__get_builtin`/host path or also
     route to the native helper — prefer routing both modes to the native helper
     so behaviour is identical; confirm the host path doesn't already exist).

### Edge cases
- Non-string argument → TypeError (per spec step 1). In standalone, follow the
  same throw lowering the other RegExp methods use for a type error; a TS-typed
  `string` param makes this a compile-time guarantee for typed call sites — only
  `any`-typed args need the runtime throw (those may narrow-refuse for the slice).
- **Empty string** → empty string.
- **First-character** special-casing (`\xHH` for a leading ASCII alnum) is easy to
  miss — the spec escapes the leading alnum even though mid-string alnums are left
  bare. The `escaped-*-simple.js` tests check exactly this.
- **Astral / surrogate pairs** (`escaped-surrogates.js`,
  `escaped-utf16encodecodepoint.js`) — escape per code point, emitting `\u{…}` /
  surrogate `\uHHHH\uHHHH` per the spec's UTF-16 encoding rule. Reuse the engine's
  existing surrogate-decode; do NOT invent a second decoder.

### Representative failing test262 paths
- `test/built-ins/RegExp/escape/escaped-syntax-characters-simple.js`
- `test/built-ins/RegExp/escape/escaped-syntax-characters-mixed.js`
- `test/built-ins/RegExp/escape/escaped-control-characters.js`
- `test/built-ins/RegExp/escape/escaped-solidus-character-simple.js`
- `test/built-ins/RegExp/escape/escaped-surrogates.js`
- `test/built-ins/RegExp/escape/escaped-utf16encodecodepoint.js`
- `test/built-ins/RegExp/escape/escaped-lineterminator.js`

### Estimated rows recovered
~20-29 (escape dir 14 in the standalone gap + AnnexB `RegExp-*-escape` cases +
the `RegExp/escape/cross-realm`/`escaped-*` variants that currently CE on
`__get_builtin`).

### Test gate (standalone, empty importObject, no env/`__get_builtin` leak)
- `RegExp.escape("a.b") === "\\x61\\.b"` (leading alnum → `\xHH`, `.` → `\.`)
- `RegExp.escape("(x)") === "\\(x\\)"`
- `RegExp.escape("\t") === "\\t"`
- `RegExp.escape("") === ""`
- host-JS parity check across the test262 `escaped-*` inputs

## Resolution

Implemented as a pure-Wasm native string transform — no regex engine, no host
import — so a standalone binary instantiates with an **empty importObject** and
never leaks `env::__get_builtin`.

- **`src/codegen/native-strings.ts`** — new `__regex_escape(s: ref $AnyString)
  -> ref $AnyString` helper, registered at the end of `ensureNativeStringHelpers`
  (same late-import-shift reconciliation domain as its sibling-call targets
  `__str_concat`/`__str_flatten`). Flattens the input, iterates UTF-16 code
  units, and builds the output with `__str_concat` over per-character flat
  pieces (`array.new_fixed` + `struct.new $NativeString`). Implements
  EncodeForRegExpEscape exactly: first-char `[0-9A-Za-z]` → `\xHH`; syntax chars
  `^ $ \ . * + ? ( ) [ ] { } |` + solidus `/` → `\c`; ControlEscape `\t \n \v
  \f \r`; otherPunctuators / WhiteSpace / LineTerminator / lone surrogate →
  `\xHH` (c ≤ 0xFF) or `\uHHHH`; a valid surrogate **pair** (decoded to a
  >0xFFFF code point by StringToCodePoints) passes through unescaped — detected
  *before* the lone-surrogate classification so it never gets double-`\u`-escaped.
- **`src/codegen/expressions/calls.ts`** — `RegExp.escape(s)` dispatch placed
  right after the `Math.*` block (before the generic builtin-member /
  `__get_builtin` fallthrough), gated on `ctx.standalone` + `ctx.nativeStrings`
  + `isGlobalRegExpIdentifier`. A statically `string`-typed arg compiles to a
  native string and calls `__regex_escape`; a statically non-string literal
  throws a catchable `TypeError` (§22.2.5 step 1, via `emitBrandCheckTypeError`);
  an `any`/`unknown` arg narrow-refuses (falls through).

## Test Results

`tests/issue-2590.test.ts` — **28/28 pass** under `target: "standalone"`,
asserting byte-for-byte via the same `isSameValue(a: any, b: any)` shape the
test262 harness uses. Covers every escape category from the test262 `escaped-*`
files (syntax / control / otherpunctuators / whitespace / lineterminator /
surrogates / utf16encodecodepoint / initial-char / not-escaped) plus the
non-string-input `TypeError` path. Each case also asserts **no
`env::__get_builtin` import leaks** and the module instantiates with `{}`.

Residual (out of scope — not behavior, needs runtime function-object reflection):
the metadata tests `is-function.js` / `length.js` / `name.js` / `prop-desc.js` /
`not-a-constructor.js` require `RegExp.escape` to be a reflectable first-class
function object (`typeof`, `.length`, `verifyProperty`), which standalone
compile-time dispatch does not expose.

Scoped gates green: `tsc`, `prettier --check`, `check:coercion-sites`,
`check:ir-fallbacks`, `check:issue-ids`. The 2 pre-existing `arr.entries()`
failures in `tests/issue-1320-standalone.test.ts` (#2043 late-import shift at
`__defineProperty_value`) are unrelated — confirmed present on the clean base
commit before this change.
