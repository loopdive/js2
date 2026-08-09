---
id: 3570
title: "Standalone: Number('+0x10') / '+0o17' / '+0b10' parse the radix literal instead of NaN (leading-'+' + NonDecimalIntegerLiteral)"
status: done
created: 2026-07-24
completed: 2026-07-24
priority: medium
feasibility: easy
task_type: bugfix
area: codegen
goal: standalone
sprint: 76
horizon: s
model: opus
assignee: ttraenkler/dev-std-date-math
parent: 1836
related: [1335, 1836, 2160]
loc-budget-allow:
  - src/codegen/parse-number-native.ts
func-budget-allow:
  - src/codegen/parse-number-native.ts::emitStrToNumber
---

# #3570 — Number('+0x10') parses instead of NaN (residual of #1836)

## Problem

In `--target standalone`/`wasi` (the no-JS-host native `__str_to_number`
path), a NonDecimalIntegerLiteral preceded by an explicit `+` sign is parsed
as the radix value instead of `NaN`:

```
Number('+0x10')  →  16   (must be NaN)
Number('+0o17')  →  15   (must be NaN)
Number('+0b10')  →   2   (must be NaN)
```

The `-` case was already correct (`Number('-0x10')` → NaN, fixed in #1836) —
this is the `+` residual.

Per ECMA-262 §7.1.4.1 StringToNumber, a `StrNumericLiteral` beginning with
`0x`/`0o`/`0b` is a `NonDecimalIntegerLiteral`, which the grammar admits **only
with no leading sign**. Both `+` and `-` before the prefix are invalid and the
whole string is `NaN`. (JS-host mode delegates `Number(string)` to V8 and was
already correct; this is native-parser-only.)

## Root cause

`src/codegen/parse-number-native.ts`. The native `__str_to_number` sign block
sets `sign = -1` for `-` but leaves `sign = +1` for `+` (only advancing the
index). `emitRadixPrefixParse`'s guard keyed the "no sign consumed" condition
on `sign == 1` (f64) — which is TRUE for both "no sign" and "explicit `+`", so
`+0x10` wrongly entered the radix arm. `-0x10` was excluded only incidentally
(sign became -1).

## Fix

Track sign-char consumption explicitly with a new `sawSign` (i32) local:
set it to 1 in **both** the `-` and `+` branches, and change the radix-prefix
guard from `sign == 1` to `sawSign == 0`. Now both signs fall through to the
decimal scanner → NaN, and unsigned `0x`/`0o`/`0b` still parse. `parseInt`
(which spec-legitimately accepts `+0x`) is unaffected — it uses a separate code
path (`emitParseInt`), not `emitRadixPrefixParse`.

## Acceptance criteria

- [x] `Number('+0x10')` / `'+0o17'` / `'+0b10'` → NaN in standalone.
- [x] Unsigned `Number('0x10')` → 16, `Number('0o17')` → 15 unchanged.
- [x] `Number('-0x10')` → NaN unchanged; signed decimals (`+12`, `-3.5e2`,
      whitespace-wrapped) unchanged.
- [x] test262 standalone flips: `built-ins/Number/string-{hex,binary,octal}-literal-invalid.js`
      fail → pass (+3), zero new standalone failures across Date/Math/Number.
- [x] No JS-host (gc) regression — native-parser-only change.

## Test Results

Measured (`runTest262File(..., "standalone")`, worktree on origin/main `fa2b189`):
`string-hex-literal-invalid.js`, `string-binary-literal-invalid.js`,
`string-octal-literal-invald.js` all fail → pass in standalone; still pass in
gc. Full Date+Math+Number standalone re-run: net **+3**, no regressions.
