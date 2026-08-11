---
id: 1644
title: "spec gap: BigInt typed-path eager f64 assumptions (47 test262 fails, 4 illegal_cast + 13 runtime)"
status: done
created: 2026-05-08
updated: 2026-06-11
priority: medium
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: codegen+runtime
language_feature: bigint
goal: spec-completeness
sprint: 61
renumbered_from: 1350
parent: 1328
pr: 1249
claimed_by: codex-developer
claimed_at: 2026-06-06T09:10:20.967Z
completed: 2026-06-06
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
- **Slice C:** `BigInt.asIntN` / `asUintN` codegen + runtime. **STATUS:** already
  works on current main via the generic `__extern_method_call` host-bridge
  path (verified 2026-05-28 — `BigInt.asIntN(8, 256n) === 0n` etc.). No
  codegen change required; can be folded into Slice D's PR as a coverage
  note in the unit test if desired.
- **Slice D:** `BigInt.prototype.toString(radix)`. **STATUS:** landed in PR for
  this commit. `bigint_toString` (1-arg i64 → externref) and
  `bigint_toString_radix` (2-arg i64 + i32 → externref) host imports added
  to the runtime/allowlist; codegen routes typed-bigint `.toString(...)` via
  these mirroring the `number_toString` pattern, including the §21.2.3.4
  radix 2-36 RangeError guard. Test: `tests/issue-1644-slice-d.test.ts`
  (7 cases, all pass).

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

## Architect Spec — Slice E: standalone (no-JS-host) BigInt representation (2026-06-04)

**Status of the rest of the issue:** the i64-bigint-brand ValType decision is
RATIFIED and Slices A–D are MERGED (verified on main 2026-06-04:
`src/ir/types.ts:106` carries `{ kind: "i64"; bigint?: boolean }`;
`type-coercion.ts:1372/1472` branch on `from.bigint`/`to.bigint`; `__box_bigint`
/ `__to_bigint` / `__bigint_ctor` registered at `index.ts:7462-7476`). So the
"needs the i64-bigint-brand decision" framing is satisfied. The genuinely-open
architectural piece is the **standalone path** the Slice-A spec explicitly
deferred (§5: "Slice A MAY land JS-host-first and defer the standalone struct to
a follow-up `#1644-standalone`"). This section IS that follow-up spec.

### Root cause (standalone gap)

`__box_bigint` / `__to_bigint` / `__bigint_ctor` are **JS host imports**
(`addImport(ctx, "env", ...)` at `index.ts:7465/7469/7476`). Under
`--target wasi` / `nativeStrings` (auto-on, no JS runtime), the host cannot
supply them. At the coercion site the dev guarded with `ctx.funcMap.get(...)`
returning `undefined`, so a branded-bigint `i64 → externref` **silently falls
through to the number-box fallback** (`type-coercion.ts:1479-1487`:
`f64.convert_i64_s` + `__box_number`, or drop+`ref.null.extern`). Result in
standalone: a bigint becomes a boxed *number* (precision loss > 2^53; wrong
`typeof`), or null. This is the same dual-mode regression class as #1470
(string literals emitting unbound globals in standalone) and violates the
CLAUDE.md rule "Don't add new host imports without a standalone fallback."

### Representation (standalone): a WasmGC brand struct

Define one module-level GC type, allocated lazily like the other native runtime
structs (mirror `getOrRegisterVecType` / the open-object struct registration in
`object-runtime.ts`):

```
(type $BigInt (struct (field $v i64)))      ;; immutable; bigint is a value type
```

- **Why a 1-field struct, not bare i64-as-externref:** externref must carry a
  *reference*; an i64 is not a ref. The struct gives bigint a distinct heap type
  so `ref.test $BigInt` cleanly distinguishes it from $Vec, open-objects, boxed
  numbers, and strings at any `externref`/`anyref` site — exactly what
  `typeof`, `===`, and ToPrimitive need. (A boxed *number* in standalone is its
  own struct/representation; do NOT reuse it — the whole defect is bigint vs
  number confusion.)
- The brand ValType is **unchanged** — still `{ kind: "i64"; bigint: true }`.
  Only the i64↔externref frontier instructions differ by mode. This is the
  invariant the Slice-A spec promised ("the ValType brand is identical in both
  modes").

### Changes (Slice E)

**File: src/codegen/type-coercion.ts** — the two frontier sites already branch on the brand
- `i64 → externref` (`:1472`, `if (from.bigint)`): when
  `ctx.funcMap.get("__box_bigint") === undefined` (standalone), instead of
  falling through to `__box_number`, emit the native box:
  `struct.new $BigInt` (the i64 is already on the stack) then
  `extern.convert_any`. Register `$BigInt` via a new
  `getOrRegisterBigIntType(ctx)` helper (see below).
- `externref → i64` (`:1372`, `if (to.bigint)`): when `__to_bigint` is absent,
  emit the native unbox: `any.convert_extern` → `ref.test $BigInt` →
  if true `ref.cast $BigInt` + `struct.get $BigInt 0`; else this is a ToBigInt
  on a non-bigint → call the standalone `__throw_type_error` path (§7.1.13: a
  Number/most types throw **TypeError**; a String must parse — see helper).
- Keep the existing JS-host arms first; the standalone arm is the
  `funcMap.get(...) === undefined` else-branch. Pattern mirrors how
  `number_toString` etc. already pick host-vs-native by funcMap presence.

**File: src/codegen/object-runtime.ts (or a new bigint-standalone.ts)** — native runtime helpers
- `getOrRegisterBigIntType(ctx): number` — lazily registers `$BigInt` and
  caches the type index on ctx (add `bigIntTypeIdx: number` to context/types.ts,
  init `-1` in create-context.ts; mirror `extrasArgvVecTypeIdx`).
- `__bigint_ctor` standalone equivalent — for the `BigInt(x)` constructor in
  standalone, route string/number args through the **native ToNumber/ToString
  string machinery** already built for #1685 (`Number(string)` native) and
  #1335/#1836 (native number↔string). Specifically:
  - `BigInt(string)` → reuse the standalone numeric-string parser, but with
    BigInt grammar (decimal/`0x`/`0o`/`0b`, optional leading `-`, no fraction/
    exponent); SyntaxError (standalone `__throw_syntax_error`) on malformed.
  - `BigInt(number)` → integer-gate (the f64 is already in a local; check
    `f64.floor == self && is-finite`) then `i64.trunc_sat_f64_s`; RangeError
    (`__throw_range_error`) otherwise.
  - `BigInt(boolean)` → `i64.extend_i32_u` (false→0n, true→1n).
- `BigInt.prototype.toString(radix)` standalone — Slice D landed
  `bigint_toString` / `bigint_toString_radix` as **host imports**; the standalone
  twin reuses the native integer→string-radix routine from #1335
  (`number_toString_radix`) generalised to i64 (it currently takes f64; add an
  i64 entry point or widen). RangeError guard for radix ∉ [2,36] stays.

**File: src/codegen/binary-ops.ts** — the mixed-operand TypeError gate (Slice A §6) is mode-agnostic
- No change needed: the gate keys off the `InnerResult` brand, not on a host
  import. Both-bigint → native i64 op (already correct in both modes); one-bigint
  → TypeError via the standalone `__throw_type_error` path that Slice A wired.
  Just confirm the i64 arithmetic ops (`i64.add` etc.) are what's emitted for
  branded operands in standalone — they are (the brand never changes the op).

**File: src/codegen/typeof-delete.ts** — `typeof x === "bigint"`
- In standalone, `__typeof` is unavailable; the native typeof must add a
  `ref.test $BigInt` arm returning the interned `"bigint"` string (mirror the
  native typeof string arms added for #1594A / #1788). One arm.

### Wasm IR pattern (standalone box / unbox)

```wasm
;; i64 → externref  (standalone bigint box)
;; (i64 value already on stack)
struct.new $BigInt          ;; (ref $BigInt)
extern.convert_any          ;; externref

;; externref → i64  (standalone bigint unbox / ToBigInt)
;; (externref on stack)
any.convert_extern
local.tee $tmp_any
ref.test (ref $BigInt)
if (result i64)
  local.get $tmp_any
  ref.cast (ref $BigInt)
  struct.get $BigInt 0
else
  ;; not a bigint → §7.1.13: number/etc → TypeError; string → parse
  ... call __throw_type_error / native string-parse ...
end
```

### Edge cases

- `0n` falsy in standalone: `ToBoolean` reads the struct field and `i64.eqz`
  (this is exactly what #1565 did for the JS-host i64 path — confirm it routes
  through the struct unbox first in standalone).
- `typeof 1n === "bigint"` in both modes (typeof arm above).
- `1n === 1n` (value equality): strict-equals on two `$BigInt` structs must
  compare the i64 fields, not ref identity — `===` lowering for branded-bigint
  operands emits `struct.get`×2 + `i64.eq` (NOT `ref.eq`). Flag this for the dev;
  it's the one place where "bigint is a value type but represented as a struct"
  needs explicit field comparison. Cross-check with #1827 (loose-equality
  precision, currently in progress) so the `==` path and this `===` path agree.
- BigInt64Array / BigUint64Array (#838) read/write elements as branded i64 —
  out of Slice E scope but the struct brand is what they'll box/unbox through;
  note the dependency.

### Slice breakdown (Slice E only — A–D are done)

- **E1 — native box/unbox + `$BigInt` type + typeof arm.** The frontier
  (type-coercion.ts both sites) + `getOrRegisterBigIntType` + typeof. Makes a
  bigint round-trip correctly through externref in standalone. ~120 LOC.
- **E2 — native `BigInt(x)` constructor** (string parse / number integer-gate /
  boolean) reusing the #1685/#1335 native string↔number machinery. ~100 LOC.
- **E3 — native `toString(radix)`** via the generalised-to-i64
  `number_toString_radix`. ~60 LOC.
- **E4 — `===` field-compare for branded bigint** (and reconcile with #1827's
  `==`). ~30 LOC.
- E1 is load-bearing and must land first; E2–E4 are independent after it.

### Test files to verify (standalone)

- Run the `built-ins/BigInt` tree under `--target wasi` (the JS-host runner
  already covers JS-host mode post-Slices-A–D). Add
  `tests/issue-1644-standalone.test.ts` compiling with `nativeStrings:true`:
  - `BigInt("10") === 10n`, `10n + 20n === 30n`, `typeof 5n === "bigint"`,
    `0n` falsy, `BigInt(1.5)` throws RangeError, `1n + 1` throws TypeError,
    `(255n).toString(16) === "ff"`, `BigInt("0xff") === 255n`.
- Native-i64 guard (regression): `playground/examples/*i64*` must compile +
  run byte-identically in standalone — the `bigint` flag must NOT touch native
  `type i64 = number` boxing (which has no struct).

### Acceptance (closes #1644)

The issue's ≥75% `built-ins/BigInt` bar is met in JS-host mode by Slices A–D
(constructor 15/22 + toString + asIntN/asUintN already pass). Slice E brings
standalone/WASI to parity so the dual-mode invariant holds and the remaining
WASI-mode BigInt fails clear. Residual host-class items
(`is-a-constructor`, wrapper-object) stay with #1568 (BigInt extern wrapper
class) — explicitly out of #1644 scope per the Slice-B residual note above.

## Implementation 2026-06-06 (codex-developer) — Slice E1 standalone carrier

Landed the load-bearing standalone `$BigInt` carrier in the native union-helper
path:

- No-JS-host `__box_bigint(i64) -> externref`, `__to_bigint(externref) -> i64`,
  `__bigint_ctor(externref) -> i64`, and `__typeof_bigint(externref) -> i32`
  are registered as native funcs instead of env imports under WASI/standalone.
- Native `typeof`, truthiness, object-type exclusion, and dynamic strict
  equality now recognize the `$BigInt` struct, so a bigint can round-trip
  through `any`/`externref` without falling back to boxed number semantics.
- `BigInt("...")` string/no-substitution-template literal calls fold to
  bigint-branded `i64.const` for decimal and prefixed numeric strings that fit
  signed i64; malformed strings stay on the runtime path.

Validation:

- `npm test -- tests/issue-1644.test.ts` — pass (11 tests).
- `npm test -- tests/issue-1644.test.ts tests/issue-1644-sliceb.test.ts tests/issue-1644-slice-d.test.ts` — pass (24 tests).
- `pnpm run typecheck` — pass.
- Scoped standalone test262 only:
  `TEST262_TARGET=standalone TEST262_REPORTER=basic TEST262_LOCAL_SHARD_GLOB='tests/test262-local-shard[1-6].test.ts' TEST262_PATH_FILTER='built-ins/BigInt/constructor-from-hex-string.js|built-ins/BigInt/constructor-from-decimal-string.js|built-ins/BigInt/constructor-from-string-syntax-errors.js|built-ins/BigInt/non-integer-rangeerror.js|built-ins/BigInt/asIntN/bigint-tobigint.js|built-ins/BigInt/asUintN/bigint-tobigint.js' pnpm run test:262 -- --official-scope-only`
  — report `2 pass / 6 total`. Passing: `constructor-from-string-syntax-errors.js`,
  `non-integer-rangeerror.js`. Residual compile errors are the pre-existing
  standalone dynamic built-in/property gap (`__get_builtin`, #1472) for
  `asIntN`/`asUintN` harness access and object-to-primitive conversion for the
  decimal/hex constructor harness assertions.

Residual Slice E work after this PR:

- Native standalone dynamic string parser for non-literal `BigInt(string)` inputs.
- Native standalone `BigInt.prototype.toString(radix)` helper parity with Slice D
  host imports.

---

## Harvest note — 2026-08-11 (count grew after close → see #4363)

Source: `test262-current.jsonl` from `loopdive/js2wasm-baselines`, run
`20260811-103533` (gitHash `9268d5a5`).

This issue closed scoped at **47 test262 fails**. The BigInt typed-path family
now carries **287 official failures**, all one signature:

```
TypeError: Cannot convert N to a BigInt (Testing with BigInt64Array and makeArray.)
```

concentrated in `built-ins/TypedArray/prototype` (222) and
`built-ins/TypedArrayConstructors/internals` (54).

Whether this is a regression of this fix or an always-present adjacent bucket
that this issue never covered is **not yet determined**. Filed as **#4363** for
that determination; the leading hypothesis there is the same "typed paths assume
f64 too eagerly" failure mode this issue was named for.
