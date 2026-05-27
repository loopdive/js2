---
id: 1644
title: "spec gap: BigInt typed-path eager f64 assumptions (47 test262 fails, 4 illegal_cast + 13 runtime)"
status: needs-spec
created: 2026-05-08
updated: 2026-05-27
priority: medium
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: codegen+runtime
language_feature: bigint
goal: spec-completeness
sprint: 50
renumbered_from: 1350
parent: 1328
---
# #1350 — BigInt: typed paths assume f64 too eagerly

## Problem

`built-ins/BigInt`: **30 / 77 pass (39.0%) — 47 fails (24 assertion_fail, 13 runtime_error,
5 other, 4 illegal_cast, 1 type_error)**.

Spec §21.2 (BigInt): BigInt values are i64 in i64-friendly Wasm or arbitrary-precision otherwise.
Mixing BigInt and Number in arithmetic must throw TypeError; explicit conversion (BigInt(num)) is allowed
for safe-integer-or-toString-parseable inputs.

The `illegal_cast` failures suggest typed paths emit `f64.add` on operands that are externref BigInt,
i.e. our type-coercion is unaware of the BigInt brand. The runtime errors include numeric overflows
(BigInt → toBigInt of a non-finite Number).

## Acceptance criteria

1. `built-ins/BigInt/data-type-mixing-throw-typeerror.js` passes (both operands must be BigInt).
2. `built-ins/BigInt/from-string-numeric-syntax-error.js` passes.
3. `built-ins/BigInt/asIntN-asUintN-bits.js` passes.
4. Pass-rate for `built-ins/BigInt` rises from 39% to ≥75%.

## Files to modify

- `src/codegen/binary-ops.ts` — type-aware operator dispatch
- `src/codegen/type-coercion.ts` — ToBigInt / ToBigNumeric
- `src/runtime.ts` — `__bigint_*` host imports

## Implementation Plan

### Root cause

The type-inference assumes any "numeric" operand is f64 — when an externref BigInt slips through,
`coerceType(externref → f64)` is emitted, which in standalone mode is `f64.const NaN` (illegal_cast
in tests that round-trip).

### Approach

1. Tag BigInt-shaped externref locals with a TypeScript-level brand (so type-inference knows).
2. In `compileBinaryOp`, check if either operand has the BigInt brand → dispatch to `__bigint_X`
   host helper instead of f64 ops.
3. Add `BigInt(value)`, `BigInt.asIntN(bits, value)`, `BigInt.asUintN(bits, value)` wrappers that
   throw on non-integer numbers.

### Edge cases

- `1n + 1` → TypeError per spec.
- `BigInt(1.5)` → RangeError per spec (must be safe integer).
- `BigInt("0xff")` → 255n (parses hex/octal/binary literals).
- `0n` is falsy.

### Test262 sample

- `test262/test/built-ins/BigInt/data-type-mixing-throw-typeerror.js`
- `test262/test/built-ins/BigInt/from-string-numeric-syntax-error.js`
- `test262/test/built-ins/BigInt/asIntN-asUintN-bits.js`

  > NOTE: the three filenames above do not exist verbatim in the submodule.
  > Actual files live under `built-ins/BigInt/*.js` plus the `asIntN/`,
  > `asUintN/`, `parseInt/`, `prototype/` subdirs.

## Investigation 2026-05-27 (developer) — NEEDS ARCHITECT SPEC

Ran the full `built-ins/BigInt` tree (77 tests) through the real
`runTest262File` runner against `origin/main` (b290fe96d):
**28 pass / 49 fail.** The failures are NOT "add a type guard in
type-coercion.ts" — they trace to one foundational representation decision
plus several missing sub-features. Recommend an architect spec to ratify the
representation, then split into ordered dev slices.

### Root cause analysis

**BigInt is represented as wasm `i64`** (`expressions.ts:707`: `10n` →
`i64.const 10`). Two structural defects flow from how that i64 meets the
JS/host boundary and the `BigInt()` constructor:

1. **DOMINANT (~30+ fails) — i64 boxes as a JS *number*, not a JS bigint.**
   `type-coercion.ts:1408` (`i64 → externref`) emits `f64.convert_i64_s` +
   `__box_number`, producing a boxed *number*. test262's `assert.sameValue`
   runs in the host and compares against a real JS `bigint` literal, so
   `BigInt("10")` (correct i64 10) boxes to JS number `10`, and `10 !== 10n`
   → assert #1 fails. This sinks nearly every `constructor-*`, `toString`,
   and value-returning test even when the i64 value is correct. Symmetric
   defect at `type-coercion.ts:1320` (`externref → i64` via `__unbox_number`
   → f64) loses precision for |value| > 2^53.
   - **Wasm i64 ↔ JS bigint is automatic at the import/export boundary**
     (JS-BigInt-integration, baseline since 2020; verified in this repo's
     node). So a host import `__box_bigint(i64) → externref` with body
     `(v) => v` returns a real JS bigint; `__to_bigint(externref) → i64`
     with body `(v) => BigInt(v)` parses/validates and returns i64. The
     representation works — the question is *which* i64s get bigint-boxed.
   - **The hard part / design decision:** `i64` is ALSO the representation
     for native `type i64 = number` annotations (CLAUDE.md "Native type
     annotations"). Boxing *all* i64→externref as bigint would break native
     i64 numeric code. Distinguishing them requires either (a) a
     `bigint`-branded ValType (`{kind:"i64", bigint:true}`) threaded through
     type inference + every coercion site, or (b) TS-type-driven boxing
     decisions (`ctx.checker` IS available at call sites, but `coerceType`
     currently only sees ValType). This is the representation choice an
     architect must ratify — it's cross-cutting (boxing, `__typeof`,
     truthiness, arithmetic round-trips all consult it).

2. **`BigInt(x)` constructor is wrong for the common cases**
   (`calls.ts:6438`): string args fall through and **return the raw string**
   (`BigInt("10")` returns `"10"`, not `10n`); f64 args do a silent
   `i64.trunc_sat_f64_s` instead of throwing **RangeError** for
   non-integers / NaN / ±Infinity (sinks `nan-throws-rangeerror`,
   `infinity-throws-rangeerror`, `non-integer-rangeerror`,
   `constructor-from-*-string`). Needs a `__to_bigint(externref)→i64` host
   helper: parse decimal/hex/octal/binary strings (SyntaxError on bad
   syntax), RangeError on non-integer/non-finite numbers, identity on bigint.

3. **`BigInt.asIntN` / `BigInt.asUintN` have NO codegen or runtime support**
   (entire `asIntN/` + `asUintN/` subdirs, ~20 tests, all
   "Cannot convert X to a BigInt"). They need dedicated codegen recognition
   + `__bigint_asintn(bits, i64)` / `__bigint_asuintn` host helpers
   implementing the spec wrap (ToIndex(bits) then `BigInt.asIntN`).

4. **`BigInt.prototype.toString(radix)`** (the `prototype/toString/*` cluster)
   needs a radix-aware host `__bigint_tostring(i64, radix)` (RangeError for
   radix ∉ [2,36]); currently no bigint-specific path.

### Recommended slices (after architect ratifies the i64-bigint-brand design)
- **Slice A (biggest win):** bigint-branded boxing — `__box_bigint` /
  `__to_bigint` host imports + brand plumbing so bigint i64s box as JS
  bigint while native i64s keep number boxing. Flips the ~30 value-compare
  fails.
- **Slice B:** `BigInt(string|number)` via `__to_bigint` (SyntaxError /
  RangeError per spec). Depends on A for comparable results.
- **Slice C:** `BigInt.asIntN` / `asUintN` codegen + runtime.
- **Slice D:** `BigInt.prototype.toString(radix)`.

No code landed — a type-guard-only patch cannot satisfy the ≥75% acceptance
bar and risks regressing native `type i64` code without the brand decision.
Baseline recorded: 28/77 pass on b290fe96d.
