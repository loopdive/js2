---
id: 1836
title: "Standalone Number<->String conformance gaps (0o/0b, toFixed 1e21, exponential, fractional radix, whitespace, ToNumber) (residual #1335)"
status: done
created: 2026-06-04
updated: 2026-06-11
priority: high
feasibility: medium
task_type: bugfix
area: codegen
goal: correctness
sprint: 61
model: fable
parent: 1335
pr: 1280
claimed_by: codex-developer
claimed_at: 2026-06-07T10:19:57.814Z
completed: 2026-06-10
---
# #1836 — standalone Number↔String conformance gaps

Residual of #1335 (marked done, sprint 58). All in the no-JS-host (standalone/WASI)
path; JS-host delegates to V8 and is correct.

## Defects
- `Number("0o17")`/`Number("0b101")` → `NaN` — only hex prefix handled
  (`src/codegen/parse-number-native.ts:949`). §7.1.4.1.
- `(1e21).toFixed(2)` emits a bogus 22-digit integer — no `≥1e21 → ToString` branch
  (`src/codegen/number-format-native.ts:894`). §21.1.3.3.
- `(1e-7).toString()`→`"0"`, `(1e21).toString()` lacks `e` — no exponential path
  (`number-format-native.ts:470`). §6.1.6.1.20.
- `(3.5).toString(2)` **traps** (`unreachable`) — fractional radix unimplemented (`:713`).
- `parseInt`/`parseFloat`/`Number` whitespace set misses U+FEFF, U+2028/2029, most Zs
  (`parse-number-native.ts:61`). §19.2.4/.5.
- `+"12abc"` → `12` instead of `NaN` — ToNumber(String) falls back to `parseFloat`
  (`src/codegen/type-coercion.ts:1748`).

## Fix
Add octal/binary prefix arms; add the 1e21 / exponential branches; emit fractional
radix digits; extend the whitespace predicate; emit a spec StringToNumber routine as
the standalone ToNumber fallback (not parseFloat).

## Progress (2026-06-04)

### Slice 1 — DONE: octal/binary prefix parsing (§7.1.4.1)
Fixed in `src/codegen/parse-number-native.ts` (`emitRadixPrefixParse`). Refactored
`buildArm` to be self-conditioned (reads `data[i+1]` and uses the prefix-letter
test as its own `if` condition) so three arms (`0x/0X`→16, `0o/0O`→8, `0b/0B`→2)
can be sequenced inside the shared `0`-prefix guard; a non-matching arm is a no-op
and falls through. Added `C_LC_B/C_UC_B/C_LC_O/C_UC_O` char-code constants.
- `Number("0o17")`/`"0O17"` → 15; `Number("0b101")`/`"0B101"` → 5
- `Number("0x1F")` → 31 unchanged; `Number("0o8")`/`"0b2"`/`"0o"` → NaN
- `Number("-0x1F")` etc. → NaN (NonDecimalIntegerLiteral is unsigned)
- `Number("08")` → 8 (leading-zero decimal, not legacy octal)
Tests: `tests/issue-1836.test.ts` (8 tests). No regression in
`tests/issue-1335-standalone.test.ts` (8) / `tests/issue-49-*` (7).

### Slice 2 — DONE: toFixed |x| >= 1e21 defers to ToString (§21.1.3.3 step 5)
`emitToFixed` (`src/codegen/number-format-native.ts`) gained a guard right after
the non-finite prologue: if `abs >= 1e21`, call `number_toString(value)` and
return — instead of the scaled fixed-point path, which overflowed the integer-
digit emitter and printed a bogus 22-digit integer with a spurious fraction.
`number_toString` is now emitted alongside `number_toFixed`
(`emitNumberFormatHelpers`) so the branch always resolves. `(1e21).toFixed(2)`
now equals `(1e21).toString()` with no `.`; normal-magnitude toFixed unchanged.

### Slice 3 — DONE: full StrWhiteSpace set for ToNumber/parseInt/parseFloat (§19.2.4/.5, §7.1.4.1)
`isWsBody` (`src/codegen/parse-number-native.ts`) extended from
space/tab/LF/VT/FF/CR/NBSP to the complete WhiteSpace (§11.2) ∪ LineTerminator
(§11.3) set: BOM/ZWNBSP (U+FEFF), LS (U+2028), PS (U+2029), and the Zs category —
OGHAM SPACE (U+1680), EN-QUAD..HAIR-SPACE (U+2000–U+200A range), NARROW (U+202F),
MEDIUM (U+205F), IDEOGRAPHIC (U+3000) spaces. Shared by parseInt/parseFloat (and
Number routes through them). `Number("﻿12")` → 12; non-ws (e.g. U+200B Cf)
still rejected.

### Slice 4 — DONE: fractional radix in toString(radix) (§6.1.6.1.20)
`emitToStringRadix` (`number_toString_radix`) no longer traps (`unreachable`) on
non-integer values. The value is split into `intPart = floor(abs)` and
`frac = abs - intPart`: the integer part is rendered LSB-first then reversed (as
before); the fractional part is appended MSB-first afterwards (repeated
`frac *= radix; digit = floor(frac); frac -= digit`), up to `MAX_FRAC_DIGITS`
(100) or until the remainder is exhausted, so it survives the integer-segment
reverse with no further reversal. A leading `0` is emitted when `intPart == 0`
(e.g. `(0.5).toString(2)` → `"0.1"`). `(3.5).toString(2)` → `"11.1"`,
`(10.5).toString(16)` → `"a.8"`, negatives handled; integer radix output
unchanged. The `MAX_SAFE_INTEGER` guard now bounds only the integer part.

### Historical residuals (closed by later slices)
- `(1e-7).toString()`→`"0"`, `(1e21).toString()` lacks `e` — exponential
  Number→String formatting, `number-format-native.ts:470`. §6.1.6.1.20. Closed by
  the exponential Number→String slice below.
- `+"12abc"` ToNumber(String) — still returns 12 not NaN on current main (the
  earlier "appears fixed" note is stale). `type-coercion.ts:1748` falls back to
  parseFloat instead of a strict StringToNumber (which rejects trailing non-numeric).
  Closed by the strict ToNumber(String) slice below.

### Slice — DONE: exponential Number→String in toString() (§6.1.6.1.20)
`emitToString` (`number_toString`, `src/codegen/number-format-native.ts`) gained
an exponential-notation regime. A guard right after the non-finite prologue routes
`|x| >= 1e21 || (0 < |x| < 1e-6)` — exactly where V8 switches to `d[.ddd]e±N` — to
a new `emitExponential` helper. The mantissa is normalised into [1,10) by iterative
×/÷10 while tracking the decimal exponent (no `log10`; Wasm has none), biased by half
a unit in the last emitted place for round-half-up, then 15 significant digits are
emitted (the safe double-precision floor — more exposes binary-representation noise),
trailing zeros and a bare `.` trimmed, followed by `e`, the sign, and the exponent
magnitude rendered MSB-first via a hundreds/tens/ones decomposition (no reverse pass,
so the write cursor is never corrupted). Three new locals added to `number_toString`
(`exp` i32, `m` f64, `sd` i32).
- `(1e21).toString()` → `"1e+21"` (was a 22-digit integer); `(1e-7)` → `"1e-7"` (was `"0"`)
- `(1.5e-7)`/`(5e-7)`/`(1.234e-10)`/`(6.022e23)`/`(1.602e-19)` bit-exact with V8
- round-half-up: `(1.1e-7)`→`"1.1e-7"`, `(9.5e-8)`→`"9.5e-8"` (not the `…9999…` truncation)
- negatives, multi-digit exponents (`1e100`/`1e308`/`1e-100`) correct
- no regression: `(1e-6)`→`"0.000001"`, `9.999e20`→long integer, ordinary ints/fractions unchanged
Tests: `tests/issue-1836-exp.test.ts` (7 tests). No regression in
`tests/issue-1335-standalone.test.ts` (8) / `tests/issue-49-*` (7) / `tests/issue-1836.test.ts` (8).
Residual: bit-perfect shortest-round-trip (Grisu/Ryū) for 16-17-digit extremes at the
double-range boundaries (max-double `1.797…e308`, denormals ~`1e-308`) — these print a
last-digit-rounded approximation, not the V8 shortest string. That is #1335 Phase 2.

### Slice — DONE: strict ToNumber(String) fallback (§7.1.4 → §7.1.4.1)
Dynamic native string refs now route through the pure-Wasm `__str_to_number`
StringToNumber helper before generic object/valueOf coercion. `coerceType`
recognises `$AnyString`/`$NativeString` refs and calls `__str_to_number` directly;
the declaration collector pre-emits the helper for unary `+string` and string
arithmetic under native strings. String arithmetic also reuses `coerceType(...,
f64, "number")` instead of hand-calling `parseFloat`, so all numeric string
coercion sites use the full-string StringNumericLiteral grammar while global
`parseFloat` keeps its longest-prefix behavior.
- `+"12abc"` / `+"  12abc  "` → NaN (was 0/parseFloat-like fallback)
- `+"0x10"` / `+"0o10"` / `+"0b10"` → 16 / 8 / 2
- `""` and all-whitespace strings under unary `+` → 0
- `"12abc" - 0` → NaN; `"0x10" - 0` → 16
- `parseFloat("12abc")` remains 12; `parseFloat("0x10")` remains 0

Validation:
- `pnpm exec vitest run tests/issue-1836.test.ts` — 25 passed
- `pnpm exec vitest run tests/issue-1836-exp.test.ts tests/issue-1335-standalone.test.ts tests/issue-49-number-format-nonfinite.test.ts` — 22 passed
- `pnpm exec biome lint src/codegen/type-coercion.ts src/codegen/declarations.ts src/codegen/string-ops.ts tests/issue-1836.test.ts --diagnostic-level=error`

### Attempt 30 refresh (2026-06-07)
Revalidated the focused #1836 coverage and adjacent formatter regressions after
PR #1280 had gone behind `origin/main`. Merged `origin/main` into
`symphony/1836` before republishing; no additional #1836 code changes were needed.

Validation:
- `pnpm exec vitest run tests/issue-1836.test.ts` — 25 passed
- `pnpm exec vitest run tests/issue-1836-exp.test.ts tests/issue-1335-standalone.test.ts tests/issue-49-number-format-nonfinite.test.ts` — 22 passed
- `pnpm exec biome lint src/codegen/type-coercion.ts src/codegen/declarations.ts src/codegen/string-ops.ts tests/issue-1836.test.ts --diagnostic-level=error`

No open #1836 residual remains. The documented shortest-round-trip formatter
limitation stays a separate #1335 Phase 2 follow-up.
