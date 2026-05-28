---
id: 1644
title: "spec gap: BigInt typed-path eager f64 assumptions (47 test262 fails, 4 illegal_cast + 13 runtime)"
status: ready
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

## Slice B implementation (2026-05-27, senior-developer)

Implemented the spec `BigInt(value)` constructor (§21.2.1.1) on top of Slice A's
brand plumbing (branched off `issue-1644-slice-a`). Before: a string arg fell
through and returned the raw string; an f64 arg silently truncated instead of
throwing. After: full ToPrimitive(number) → NumberToBigInt (RangeError) /
ToBigInt → StringToBigInt (SyntaxError) semantics.

**New host helper `__bigint_ctor(externref) → i64`** — distinct from Slice A's
`__to_bigint` (§7.1.13 ToBigInt, which throws **TypeError** on a Number). The
constructor must throw **RangeError** on a non-safe-integer Number, so it needs
its own helper:
- Number → `Number.isInteger` gate then `BigInt(n)`; NaN/±Infinity/non-integer
  all fail the gate → RangeError (NumberToBigInt).
- Symbol → TypeError. bigint/boolean → identity/0n/1n. string → `BigInt(s)`
  (StringToBigInt parses hex/octal/binary/decimal; SyntaxError on malformed).
- WasmGC-struct / proxy args run through `_toPrimitive`/`_hostToPrimitive`
  ("number" hint) first (ToPrimitive step).

Files (5):
- `src/codegen/index.ts` — declare `__bigint_ctor` import + add to the
  index-shift skip set.
- `src/compiler/import-manifest.ts` — map `__bigint_ctor` to a `builtin` intent.
- `src/runtime.ts` — `__bigint_ctor` body in the `builtin` dispatch.
- `src/codegen/expressions/calls.ts` — `BigInt(x)` routes f64/string/object
  through `__bigint_ctor`; **compile-time numeric-literal fold** to `i64.const`
  for safe integers (incl. negative `-NumericLiteral`) avoids a host call;
  i32/native-i64 still extend/identity directly (no RangeError possible).
- `tests/equivalence/helpers.ts` — `__bigint_ctor` for the unit-test host.

**Result:** `built-ins/BigInt` constructor tests **3/22 → 15/22** through the
real runner. Slice B tests `tests/issue-1644-sliceb.test.ts` (6) + Slice A
`tests/issue-1644.test.ts` (5) all pass; tsc clean.

### Residual (still failing, out of Slice-B scope)
- `is-a-constructor`, `proto`, `wrapper-object-ordinary-toprimitive` — need the
  `BigInt` **extern wrapper class** dependency (shared with #1568, host-class
  gap), not constructor semantics.
- `constructor-coercion` — `Symbol.toPrimitive` on a WasmGC struct returning a
  string: the struct's `Symbol.toPrimitive` is a Wasm closure the host can't
  invoke (#1090 ToPrimitive-with-closure gap).
- `constructor-from-decimal-string` / `constructor-integer` /
  `constructor-trailing-leading-spaces` — fail only at the **negative** assert
  (`BigInt("-10")`, `BigInt(-MAX_SAFE_INTEGER)`) **under the test262 harness**.
  Verified the same comparison passes in isolation and in the equivalence
  helper (`BigInt("-10") === -10n` → true in-Wasm), so this is the harness
  `wrapTest`/scope-wrapping artifact tracked in #1318/#786, not a constructor
  bug.

Slices C (`asIntN`/`asUintN`) and D (`toString(radix)`) remain open.

## Architect Decision — i64-bigint-brand ValType representation (RATIFIED 2026-05-27)

This section answers the open representation question the developer flagged
(option (a) vs (b) above). **Decision: option (a) — a `bigint`-branded
ValType.** It is the only choice that keeps the `coerceType` frontier
self-describing (it already receives `from: ValType` everywhere; it does NOT
reliably have a TS `ts.Node`/`ctx.checker` view at every late coercion site —
e.g. stack-balance fixups and trampoline coercions run post-AST). Threading the
brand on the value type is therefore both sufficient and the smaller blast
radius. The slices A–D above stand; this section is the spec they implement
against. **Slice A is load-bearing and must merge first.**

### 1. The brand

In `src/ir/types.ts` change the i64 ValType variant from `{ kind: "i64" }` to:

```ts
| { kind: "i64"; bigint?: boolean }
```

**Why an optional flag on the existing variant, not a new `kind: "bigint"`:**
the flag is compile-time-only metadata. Both brands emit the *identical* Wasm
i64 local/param/result and the *identical* i64 arithmetic. The binary encoder,
the type-section writer, and the structural checks in `stack-balance.ts` already
treat `kind === "i64"` uniformly and must keep doing so — a new `kind` would
force churning every `case "i64"` / `=== "i64"` site (30+ in `type-coercion.ts`
+ `stack-balance.ts`) only to re-unify them for encoding. Omitting the flag
defaults to *native i64 number*, so every existing `{ kind: "i64" }` literal in
the tree keeps its current meaning with zero edits.

**Hard invariant (CI-guarded by `tests/issue-1644.test.ts`):** the `bigint` flag
NEVER changes which Wasm instruction is emitted for arithmetic / locals / params
/ results / the type section. It changes exactly two things:
(a) the **boxing/unboxing** instruction at the i64↔externref frontier, and
(b) the **mixed-operand TypeError gate** in binary-op dispatch.

### 2. Producers that set `bigint: true`

1. **BigInt literal** — `expressions.ts:707-711` returns
   `{ kind: "i64", bigint: true }`.
2. **`BigInt(x)` / `BigInt.asIntN` / `BigInt.asUintN` results** (Slices B/C) —
   `InnerResult` is `{ kind: "i64", bigint: true }`.
3. **`: bigint` TS annotation + `typeof x === "bigint"` narrowing** — the
   TypeMap resolver maps the `bigint` keyword type to
   `{ kind: "i64", bigint: true }` (today it falls through to f64/externref).
   One site in the type resolver.
4. **Arithmetic propagation** — an i64 op whose operands are branded bigint is
   itself branded bigint. This rides on the `InnerResult` already returned up
   the expression tree (local dataflow in `binary-ops.ts` / the unary path); no
   whole-program pass.

### 3. Storage round-trip (resolution (a))

When a `: bigint`-annotated or bigint-initialised local/global/struct-field is
typed, its declared `ValType` carries `bigint: true`, so reads re-emit the flag.
This is required for `let x: bigint = 10n; return x` to box correctly. Cost:
~1 site in the decl-typing path. (Tagging every store/load instead — rejected:
more sites, identical effect.)

### 4. Coercion-site dispatch (`src/codegen/type-coercion.ts`)

Every i64 branch keys off `from.bigint`. The unset (numeric) column is
byte-identical to today's output, which is what makes native i64 provably
unaffected:

| Site | numeric i64 (`bigint` unset) | bigint i64 (`bigint: true`) |
|------|------------------------------|------------------------------|
| `i64 → externref` (`:1408`) | `f64.convert_i64_s` + `__box_number` (unchanged) | `call __box_bigint` (NEW) |
| `externref → i64` (`:1320`) | existing `__unbox_number`→f64 path | `call __to_bigint` (NEW) — §7.1.13 ToBigInt; throws TypeError on number |
| `i64 ↔ f64`, `i64 ↔ i32` | unchanged | **forbidden** — emit the Slice-A TypeError gate (no implicit bigint↔number) |

### 5. Runtime helpers (`src/runtime.ts`)

Mirror `__box_number`. JS-BigInt-integration makes an i64 crossing the boundary
*already* a JS `BigInt`, so:

```js
// (i64) -> externref
__box_bigint: (v /* JS bigint */) => v,
// (externref) -> i64
__to_bigint:  (v) => (typeof v === "bigint" ? v : BigInt(v)), // §7.1.13: number→TypeError; string→parse/SyntaxError
```

Register both via the existing `addUnionImports(ctx)` path so the late
function-index shift in `index.ts` already covers them (funcMap keys
`__box_bigint` / `__to_bigint`).

**Standalone (no-JS-host) mode** cannot use the boundary auto-conversion: an
externref bigint must be a wasmGC `(struct (field $v i64))` brand, and the two
helpers become struct alloc / field-read + `ref.test`. The **ValType brand is
identical in both modes** (that's the whole point of ratifying it once). Slice A
MAY land JS-host-first and defer the standalone struct to a follow-up
(`#1644-standalone`); the brand does not change.

### 6. Binary-op TypeError gate (Slice A)

In `compileBinaryOp` (`src/codegen/binary-ops.ts`), from the operand
`InnerResult`s compute `(leftBig, rightBig)`:

- both bigint → i64 op, result branded bigint (`1n + 2n`).
- exactly one bigint → **TypeError** (`1n + 1`) via the standalone
  `__throw_type_error` path (the mechanism #1526 already added for mixed
  arithmetic — make the brand the single source of truth, retiring #1526's
  parallel ad-hoc check).
- `**` bigint base + negative bigint exp → **RangeError**.
- neither bigint → unchanged numeric dispatch.

### 7. Regression surface & guard

The ONLY regression path is accidentally branding a native i64, or a coercion
site reading `from.bigint` without defaulting `undefined → numeric`. Mitigation:
the flag is optional (defaults to current behavior) and Slice A ships
`tests/issue-1644.test.ts` asserting (1) `type i64 = number` arithmetic + boxing
is byte-identical pre/post, and (2) a bigint literal round-trips as a JS bigint
(`BigInt("10") === 10n`). Run `playground/examples/*i64*` as an additional
native-i64 guard. Brand is dev-claimable now (Slice A first).
