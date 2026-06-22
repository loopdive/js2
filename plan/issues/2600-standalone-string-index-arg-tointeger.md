---
id: 2600
title: "Standalone: ToIntegerOrInfinity for String index/position args (at/charAt/charCodeAt/codePointAt/indexOf)"
status: done
completed: 2026-06-22
assignee: ttraenkler/agent-af6ff9d85ab8e6fc4
sprint: 65
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: conformance
area: string-number
language_feature: string-methods
goal: standalone-mode
parent: 2160
related: [2124, 2601]
---

# #2600 — Standalone String index/position argument ToIntegerOrInfinity

## Problem

In `--target standalone`, the position/index argument of
`String.prototype.{at,charAt,charCodeAt,codePointAt,indexOf,lastIndexOf}` is not
run through **ToIntegerOrInfinity** (§7.1.5 = ToNumber then truncate-toward-zero),
so a non-integer-typed position yields the wrong index on a **typed string
receiver** (substrate-independent value-correctness, not a trap).

### Verified repros (host pass / standalone wrong-value, current main `0451ee920`)

| call (typed string receiver) | host | standalone |
|---|---|---|
| `"aaaa".indexOf("aa", "1.9")` | `1` (ToInteger("1.9")=1) | **`14`** (assertion at L24 of `indexOf/position-tointeger.js`) |
| `"01".at({valueOf(){return 1}})` | `'1'` | **wrong** (`at/index-argument-tointeger.js`) |
| `"abc".charAt("1.5")` | `'b'` | wrong |
| `"abc".charCodeAt("2.9")` | code of `'c'` | wrong |

Probe (direct standalone compile+run) confirmed `indexOf("aa","1.9")` returns `14`
not `1`, and `s.at({valueOf…})` returns the wrong char.

## Root cause

`compileStringIntegerArg` (`src/codegen/string-ops.ts` line ~2062) lowers the
position with a plain i32 coercion:

```ts
function compileStringIntegerArg(ctx, fctx, arg): void {
  if (tryThrowOnBigIntOrSymbolArg(ctx, fctx, arg)) { ...; return; }
  const argType = compileExpression(ctx, fctx, arg, { kind: "i32" });   // <-- not ToIntegerOrInfinity
  ...
}
```

`compileExpression(arg, {kind:"i32"})`:
- for a **string** literal `"1.9"` does not run ToNumber(string)→1.9→trunc→1; it
  takes a different (wrong) path that yields a large/garbage i32.
- for an **object** with `valueOf` does not invoke ToPrimitive("number")→ToInteger.

Per spec the index is `ToIntegerOrInfinity(arg)` = `truncate(ToNumber(arg))`, with
`NaN`→0, `+∞`/`-∞` clamped by the subsequent range check.

## Implementation Plan

### Root cause (1 sentence)
The string index arg is coerced directly to i32 instead of via
ToNumber→truncate-toward-zero, so non-integer-typed positions resolve wrong.

### Changes — `src/codegen/string-ops.ts`, `compileStringIntegerArg` (line ~2062)
- Replace the direct `compileExpression(arg, {kind:"i32"})` with: compile the arg,
  coerce to **f64** via the existing numeric coercion engine
  (`coerceType(ctx, fctx, argType, {kind:"f64"}, arg)` — this routes a string
  through the existing `__str_to_number` engine helper and an object through the
  ToPrimitive("number") path, both already present for `+str`/`Number(x)`), then
  apply **ToIntegerOrInfinity**:
  - `f64` on stack → handle `NaN`→0 (`f64.ne self` test → select 0), then
    `i32.trunc_sat_f64_s` (truncates toward zero, saturates ±∞ to i32 min/max —
    the subsequent `<0` / `>=len` range checks clamp correctly).
- Keep the existing `tryThrowOnBigIntOrSymbolArg` guard (line ~2063) and the i64
  BigInt-drop/throw branch.

### Wasm IR pattern (ToIntegerOrInfinity)
```wasm
;; arg already coerced to f64 in $f
local.get $f
local.get $f
f64.ne            ;; isNaN ? 1 : 0
if (result i32)
  i32.const 0     ;; NaN → 0
else
  local.get $f
  i32.trunc_sat_f64_s   ;; trunc toward zero, ±∞ saturates
end
```

### Edge cases
- `"1.9"` → 1; `"-1.5"` → -1 (then range-check → behaves per method); `"abc"` →
  NaN → 0; `""` → 0; `true`→1, `false`→0, `null`→0, `undefined`→method default.
- Absent arg keeps the method's existing default sentinel (do not regress #2124:
  explicit `undefined` ≠ 0 for the methods that special-case it; this helper is only
  reached for *present* args — the absent path lives in `compileIntegerValueToLocal`,
  unchanged).
- `at` accepts negative indices (relative from end) — the truncation must preserve
  sign; `trunc_sat_f64_s` does. The `at`-specific negative-wrap arithmetic already
  lives in the `at` arm (line ~2213); this fix only changes how the raw index is
  produced.
- `lastIndexOf` NaN-position → +∞ search-from-end sentinel is already special-cased
  (line ~2390); keep that branch ahead of the generic coercion.

### Out of scope (defer)
- An **object** position whose `valueOf`/`@@toPrimitive` is a *dynamic/class*
  object that lands on the `Cannot convert object to primitive value` engine path
  is shared with **#1917** — if the engine handles a simple-object `{valueOf(){…}}`
  (it does for `+obj`), `s.at({valueOf})` flips here; a residual class/proxy receiver
  is an #1917/#2580-M2 item, not this slice.

### Failing test262 paths (verify flip)
- `built-ins/String/prototype/indexOf/position-tointeger.js`
- `built-ins/String/prototype/at/index-argument-tointeger.js`
- `built-ins/String/prototype/at/index-non-numeric-argument-tointeger.js`
- `built-ins/String/prototype/codePointAt/return-abrupt-from-object-pos-to-integer.js`
  (the throw-from-valueOf abrupt case — verify the engine propagates the throw)

### Estimated rows
~6–12 standalone rows.

### Validation
- New `tests/issue-2600-string-index-tointeger.test.ts`: fractional-string,
  non-numeric-string, boolean, negative positions across at/charAt/charCodeAt/
  codePointAt/indexOf × `{standalone, gc}`.
- gc-mode no-regression guard.
- `pnpm run check:coercion-sites` unchanged (reuse the f64 engine).

## Resolution (2026-06-22)

Fixed together with #2601 in one branch (`issue-2600-2601-string-index-fromcodepoint`).

**Change** — `src/codegen/string-ops.ts`, `compileStringIntegerArg`:
- Under `noJsHost(ctx)` (standalone/WASI), the index/position arg is now run
  through ToIntegerOrInfinity (§7.1.5) instead of a direct i32 coercion:
  - `i32`-typed arg → unchanged (already integral, in range for the helper).
  - `i64` (bigint) → existing TypeError throw, unchanged.
  - else → `coerceType(argType, {kind:"f64"}, "number")` (the existing numeric
    engine: string → `__str_to_number`, object → ToPrimitive("number")), then
    ToIntegerOrInfinity: NaN→0 (`f64.ne self` test), else `i32.trunc_sat_f64_s`
    (truncates toward zero; ±∞ saturates and the method's <0/>=len range checks
    clamp it).
- The legacy direct-i32 path is kept for the JS-host `nativeStrings` mode (this
  slice is standalone). No new #2108 coercion site — `coerceType` reuse only;
  `check:coercion-sites` baseline unchanged.

Covers at/charAt/charCodeAt/codePointAt/indexOf/lastIndexOf (all route their
position through `compileStringIntegerArg`).

## Test Results

- `tests/issue-2600-string-index-tointeger.test.ts` — 17/17 pass (standalone +
  gc-mode regression guards).
- Standalone micro-repros: `indexOf("aa","1.9")`→1, `charAt("1.5")`→'b',
  `charCodeAt("2.9")`→'c', `codePointAt("1.5")`→'b', `charCodeAt("abc")`→0
  (NaN), `charCodeAt(true)`→1, `charAt({valueOf:1})`→'b', `at("1.9")`→'b',
  `at("-1.5")`→'b' — all correct.
- Integer-position regression guards green; #2124 explicit-undefined defaults
  untouched (the absent path lives in `compileIntegerValueToLocal`, unchanged).
- Related suites green: issue-2122, issue-2088, issue-2124, issue-1105-charcodeat,
  issue-substring-noarg, issue-2160-substr, issue-1910-string-wrapper-index.
- tsc + prettier clean; `check:coercion-sites` OK (no change).
