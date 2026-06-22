---
id: 2601
title: "Standalone: String.fromCodePoint RangeError on non-integral / out-of-range code points"
status: done
completed: 2026-06-22
assignee: ttraenkler/agent-af6ff9d85ab8e6fc4
sprint: 65
priority: medium
feasibility: easy
reasoning_effort: low
task_type: conformance
area: string-number
language_feature: string-methods
goal: standalone-mode
parent: 2160
related: [2088, 2122, 2600]
---

# #2601 — Standalone String.fromCodePoint RangeError guard

## Problem

`String.fromCodePoint(...codePoints)` (§22.1.2.2) must throw a **RangeError** when
any argument, after ToNumber, is **not an integral Number** or is **< 0 or >
0x10FFFF**. The standalone native lowering omits both guards, so
`String.fromCodePoint(3.14)`, `String.fromCodePoint(-1)`,
`String.fromCodePoint(0x10FFFF + 1)` silently truncate/wrap instead of throwing.

### Verified repros (host pass / standalone fail, current main `0451ee920`)

| test262 path | shape | expected |
|---|---|---|
| `built-ins/String/fromCodePoint/argument-is-not-integer.js` | `String.fromCodePoint(3.14)` | RangeError |
| `built-ins/String/fromCodePoint/number-is-out-of-range.js` | `String.fromCodePoint(-1)`, `(0x10FFFF+1)` | RangeError |

Probe (host-vs-standalone `built-ins/String` sweep): both fail standalone with
`returned 2 | assert.throws(RangeError, …)` — the code ran and returned a string
instead of throwing.

No receiver involved (static method, numeric args) → **substrate-independent**.

## Root cause

The fromCodePoint lowering (`src/codegen/expressions/calls.ts`, the
`propAccess.name.text === "fromCodePoint"` block at line ~4481) routes through
`compileFromCharCodeFamily(ctx, fctx, expr, { native: true, helperIdx })`. That
shared fold (also used by `fromCharCode`, which has **no** such guard by spec)
emits each code point and concatenates, but never checks §22.1.2.2 step 2b
("not an integral Number → RangeError") or step 2c ("< 0 or > 0x10FFFF →
RangeError"). The native `__str_fromCodePoint(cp: i32)` helper
(`native-strings.ts` line ~4417) takes an i32 — by the time the value is an i32
the fractional/range information is already lost.

## Implementation Plan

### Root cause (1 sentence)
The shared fromCharCode/fromCodePoint fold skips fromCodePoint's per-argument
integral + [0, 0x10FFFF] RangeError checks.

### Changes — `src/codegen/expressions/calls.ts` (`compileFromCharCodeFamily`)
- Add a `kind: "fromCodePoint"` flag (or reuse the existing native/non-native
  discriminator) so the fold knows to emit the guard **only** for fromCodePoint
  (NOT fromCharCode — fromCharCode does ToUint16 with no RangeError).
- For each argument, compile to **f64** (the spec ToNumber, via the existing numeric
  coercion — `coerceType(argType, {kind:"f64"})`), then before truncating to the i32
  code point emit:
  ```
  ;; integral check: trunc(cp) != cp  → RangeError
  local.get $cp_f64
  local.get $cp_f64
  f64.trunc
  f64.ne
  ;; range check: cp < 0 || cp > 0x10FFFF
  local.get $cp_f64  f64.const 0      f64.lt
  local.get $cp_f64  f64.const 1114111 f64.gt
  i32.or  i32.or
  if  <throw RangeError "Invalid code point ...">  end
  ```
  Also throw on `NaN` (NaN fails the `trunc != self` test → already caught) and on
  `±Infinity` (caught by the range test).
- Throw helper: `addStringConstantGlobal` + `ensureExnTag` + `throw` — mirror the
  static-RangeError fold in `string-ops.ts` `normalize` arm (line ~2846/2848) and
  `emitTypeErrorThrow`.

### Wasm IR pattern
See the integral + range block above. Code-point value `1114111` = `0x10FFFF`.

### Edge cases
- `String.fromCodePoint()` (no args) → `""` (already: the block guards
  `arguments.length >= 1`; the 0-arg case returns empty — unchanged).
- Integral floats are OK: `String.fromCodePoint(65)` and `(65.0)` → `"A"` (the
  `trunc != self` test passes for `65.0`).
- `0` and `0x10FFFF` are valid (inclusive bounds — use `<0` and `>0x10FFFF`, not
  `<=`/`>=`).
- `-0` is integral and in range → valid (`""`-adjacent; ToNumber(-0)=0).
- A non-numeric arg (string/object) first goes through ToNumber (the f64 coercion);
  `String.fromCodePoint("65")` → `"A"`. A NaN result (`fromCodePoint("x")`) →
  RangeError (NaN fails integral test). Keep this consistent with host.

### Out of scope (defer)
- `String.fromCharCode` / `String.fromCodePoint` accessed **as a value** (`.length`,
  `.name`, `new String.fromCodePoint`, passed as a callback) → the
  `built-in static property value read is not supported in --target standalone` /
  `__get_builtin` CE family. That is the **builtin-method-as-value** substrate
  concern (a native built-in method closure), NOT this method-correctness fix.
  Tests: `fromCodePoint/not-a-constructor.js`, `length.js`, `fromCharCode/
  S15.5.3.2_A2.js`, `_A4.js`. Track under the builtin-closure substrate, not here.

### Failing test262 paths (verify flip)
- `built-ins/String/fromCodePoint/argument-is-not-integer.js`
- `built-ins/String/fromCodePoint/number-is-out-of-range.js`

### Estimated rows
~2–3 standalone rows (small but a clean, bounded native-helper correctness fix).

### Validation
- New `tests/issue-2601-fromcodepoint-rangeerror.test.ts`: `fromCodePoint(3.14)`,
  `(-1)`, `(0x10FFFF+1)`, `(NaN)`, `(Infinity)` all throw RangeError;
  `fromCodePoint(0)`, `(65)`, `(65.0)`, `(0x10FFFF)`, multi-arg valid all return
  correct strings; × `{standalone, gc}`. Assert `fromCharCode` still does NOT throw
  on `3.14` (ToUint16, no RangeError) — guard must be fromCodePoint-only.
- gc-mode no-regression guard.

## Resolution (2026-06-22)

Fixed together with #2600 in one branch (`issue-2600-2601-string-index-fromcodepoint`).

**Change** — `src/codegen/expressions/calls.ts`, `compileFromCharCodeFamily`:
- Added an `isFromCodePoint` flag; the per-argument fold now emits the §22.1.2.2
  step 2b/2c RangeError guard **only** for fromCodePoint (NOT fromCharCode, which
  does ToUint16 with no check). Per arg: coerce ToNumber→f64, then
  `if (trunc(cp) != cp  ||  cp < 0  ||  cp > 0x10FFFF) throw RangeError`
  (`trunc != self` catches fractional AND NaN; the range test catches ±∞), then
  trunc to the i32 the native helper wants.
- Gated on `noJsHost(ctx)` (standalone/WASI): the throw uses the in-module
  `__new_RangeError` constructor (no host bridge). The JS-host lane keeps its
  existing host-delegated behaviour — gating it standalone-only also avoids a
  mid-part-loop late-import index shift that briefly broke the fast-mode
  multi-arg path (#2122 regression, caught + fixed before commit).
- No new #2108 coercion site (`coerceType` f64 reuse).

## Test Results

- `tests/issue-2601-fromcodepoint-rangeerror.test.ts` — 17/17 pass.
- Standalone: `fromCodePoint(3.14|-1|0x10FFFF+1|NaN|Infinity|"x")` and multi-arg
  `(65, 3.14)` all throw RangeError; `fromCodePoint(0|65|65.0|0x10FFFF|"65")` and
  `(65,66,67)` return correct strings; `fromCharCode(3.14)` does NOT throw
  (guard is fromCodePoint-only).
- Regression: #2122 (incl. native fromCodePoint multi-arg surrogate pairs) and
  #2088 green; gc-mode fromCodePoint/fromCharCode unchanged.
- tsc + prettier clean; `check:coercion-sites` OK (no change).
- Note: `String.fromCodePoint()` (0-arg) is out of this slice — the native block
  gates on `arguments.length >= 1`, so the 0-arg case is unchanged (pre-existing).
