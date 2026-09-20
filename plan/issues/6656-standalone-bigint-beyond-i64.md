---
id: 6656
title: "Standalone BigInt is a branded i64 — exact ToString, then arbitrary precision"
status: in-progress
sprint: current
priority: high
horizon: xl
goal: standalone
reasoning_effort: max
requested_by: ttraenkler/fable-lead
created: 2026-09-20
assignee: ttraenkler/senior-dev-s74
parent: 5383
---

# #6656 — standalone BigInt beyond i64

`--target standalone` represents a JS `bigint` as a **branded i64**: the
`ValType` is `{ kind: "i64", bigint: true }` (`BIGINT_I64`,
`src/codegen/binary-ops.ts:200`) on the stack and in locals, and a
module-private one-field `$BigInt` struct (`ctx.nativeBigIntTypeIdx`,
minted in `src/codegen/registry/imports.ts:1264`) when the value has to
travel as `externref`/`anyref`.

Consequences: `864n * 10n ** 19n` wraps modulo 2^64 to
`6923773503929843712`, so Temporal's ±8.64e21 ns epoch-limit checks never
fire; and — the part that was **not** previously attributed — even values
that DO fit in i64 print through `f64`, so every bigint above 2^53 is
printed rounded.

## Measurements (base `bccd46c5`, `--target standalone`, `hostBridge: off`)

Probes `.tmp/s74/probes/bi1.mts`, `bi2.mts`, `bi4.mts`. "node=" is Node 22
evaluating the same source.

### A. Range (`bi1.mts`) — 12 of 18 wrong

| expression | standalone | Node |
| --- | --- | --- |
| `2n ** 64n` | `0` | `18446744073709551616` |
| `864n * 10n ** 19n` | `6923773503929844000` | `8640000000000000000000` |
| `Number(2n ** 70n)` | `0` | `1.1805916207174113e+21` |
| `String(2n ** 70n)` | `0` | `1180591620717411303424` |
| `(2n ** 63n) > (2n ** 62n)` | `false` | `true` |
| `(2n ** 64n) === 0n` | `true` | `false` |
| `BigInt("18446744073709551617")` | `1` | `18446744073709551617` |
| `(2n**70n) / (2n**35n)` | `0` | `34359738368` |
| `BigInt.asIntN(64, 2n**70n+5n)` | `5` | `5` (ok by accident) |
| `typeof (2n ** 70n)` | `bigint` | `bigint` (ok) |

### B. Precision INSIDE i64 range (`bi2.mts`, `bi4.mts`) — a separate, cheaper defect

The i64 arithmetic and the `.toString()` METHOD are exact. What is not
exact is **ToString in a string context**:

| expression | standalone | Node |
| --- | --- | --- |
| `(9007199254740993n).toString()` | `9007199254740993` ✅ | same |
| `(9007199254740993n).toString(16)` | `20000000000001` ✅ | same |
| `String(9007199254740993n)` | `9007199254740992` ❌ | `…993` |
| `"" + 9007199254740993n` | `9007199254740992` ❌ | `…993` |
| `` `${mut}` `` (mut: bigint) | `9007199254740992` ❌ | `…993` |
| `String(9223372036854775807n)` | `9223372036854776000` ❌ | `…807` |
| `String(9007199254740992n + 1n)` | `9007199254740992` ❌ | `…993` |
| `String(idb(9007199254740993n))` (`idb` returns `any`) | `9007199254740993` ✅ | same |

The last row is the tell. An `any`-typed bigint boxes into the `$BigInt`
carrier and takes S62's `__any_to_string` bigint arm, which calls the
**exact** `bigint_toString_radix` formatter
(`src/codegen/bigint-format-native.ts`). A **statically** bigint-typed
operand never gets there: `src/codegen/string-ops.ts` has six
`i64 → f64.convert_i64_s → number_toString` sites that treat a branded
bigint exactly like a native `type i64 = number`.

Ruled out by instrumentation, not by reading: it is **not**
`coerceType` (a probe throw on every `from.bigint` coercion never fired —
`.tmp/s74/probes/bi3.mts`), **not** `boxToAny` (same technique on
`src/codegen/value-tags.ts:211`), and **not** the literal (
`compileBigIntLiteral`, `src/codegen/expressions.ts:1041`, always emits an
exact `i64.const`).

### C. The eight briefed Temporal rows (base, `.tmp/s74/battery/base/Target8-base.tsv`)

All 8 fail. Three distinct signatures:

| row | failure |
| --- | --- |
| `Duration/from/argument-duration-max.js` | `SameValue(«NaN», «9007199254740992»)` |
| `Duration/prototype/add/argument-duration-max.js` | same |
| `Duration/max.js` | same |
| `Duration/from/…-precision-exact-numerical-values.js` | `SameValue(«"[object Object]"», «"PT9007199254740991.975424S"»)` |
| `Duration/prototype/add/…-precision-exact-numerical-values.js` | same |
| `Duration/compare/throws-when-target-zoned-date-time-outside-valid-limits.js` | `Expected a RangeError … no exception` |
| `ZonedDateTime/prototype/add/overflow-adding-months-to-max-year.js` | `Expected a RangeError … no exception` |
| `ZonedDateTime/prototype/add/throw-when-intermediate-datetime-outside-valid-limits.js` | `TypeError: cannot convert number to bigint` |

The two `RangeError`-never-thrown rows are the pure >2^63 limit checks
(S69's attribution). The `«NaN»` and `«[object Object]»` rows are
**string-round-trip** failures — the polyfill converts its JSBI carrier
with `globalThis.BigInt(t.toString(10))` and reads values back out of
strings, so a rounded `String(bigint)` corrupts a value that never left
i64 range. That is why slice 2 below is expected to move rows on its own.

## Implementation Plan

### Touchpoint inventory (what the i64 carrier touches)

| touchpoint | file:sym | role |
| --- | --- | --- |
| brand constant | `binary-ops.ts:200` `BIGINT_I64` | the ValType itself |
| literal | `expressions.ts:1041` `compileBigIntLiteral` | `i64.const`, exact |
| all arithmetic/compare | `binary-ops.ts:2087-2137` → `compileI64BinaryOp` | ONE choke point |
| `++`/`--` | `expressions/unary-updates.ts:559`, `expressions/host-bigint-updates.ts` | synthesise `1n` |
| assignment / op-assign brand | `expressions/assignment.ts:212`, `expressions/operator-assignment.ts:3340` | re-brand the i64 |
| boxing i64→externref | `type-coercion.ts:3391` (`__box_bigint`) | mints `$BigInt` |
| boxing i64→AnyValue | `value-tags.ts:168,211` | **loses the brand** (boxes as f64) |
| unboxing externref→i64 | `type-coercion.ts:3076` (`__to_bigint`) | §7.1.13 |
| `BigInt(x)` | `registry/imports.ts:999` `__bigint_ctor`, `builtin-ctor-callable.ts:301` | ctor |
| `StringToBigInt` | `runtime/wasmgc/values/string-to-bigint-body.ts` | native parser, i64 |
| ToString (exact) | `bigint-format-native.ts` `bigint_toString{,_radix}` | i64, radix 2..36 |
| ToString routes | `bigint-primitive-to-string.ts` | dynamic receiver + `__any_to_string` |
| ToString (LOSSY) | `string-ops.ts:345,890,1084,2198,2274,2517/2568` | six `f64.convert_i64_s` sites |
| strict eq on carriers | `extern-eq-fast.ts:135-155`, `any-helpers.ts:832-848` | `struct.get` + `i64.eq` |
| truthiness | `is-truthy-ladder.ts:91` | brand → `"bigint"` |
| `typeof` | `typeof-delete.ts` bigint arms | |
| link boundary | `link-boundary-tostring.ts:154`, `extern-arg-marshal.ts:206` | provider↔consumer |
| `Map`/`Set` keys | `map-runtime.ts:1552-1559`, `collections-es2025.ts:260,732` | |
| wrapper `valueOf` | `wrapper-proto-value-of.ts:385` | `Object(1n)` |

There are 36 `bigint: true` producers and 24 `.bigint` readers across
`src/`.

### Representation (the target, for the >2^63 slices)

Keep the i64 fast path **byte-identical** and add an overflow-promoted
limb form:

```wat
(type $BigIntLimbs (array i32))                     ;; magnitude, little-endian, base 2^32
(type $BigIntBig (struct (field $sign i32) (field $mag (ref $BigIntLimbs))))
```

The **carrier stays `$BigInt`** (one immutable i64 field) for small
values, so every existing `ref.test $BigInt` / `struct.get` site keeps
working unchanged. A promoted value is a `$BigIntBig`; the two are
siblings under a common `$BigIntVal` supertype so `typeof`, truthiness,
`===` and the link boundary test the supertype.

Helpers (all defined funcs, native, no host import):

- `__bigint_is_small(ref $BigIntVal) -> i32`
- `__bigint_small_value(ref $BigIntVal) -> i64`
- `__bigint_promote(i64) -> ref $BigIntBig`
- `__bigint_demote(ref $BigIntBig) -> ref $BigIntVal` (normalises back to
  `$BigInt` whenever the magnitude fits in 63 bits — **canonical form is
  mandatory**, otherwise `===` has two representations for one value)

Operations needing a limb version for Temporal:
`+ - * / % **`, unary `-`, `<` `<=` `>` `>=` `===` `!==`, `ToString`,
`StringToBigInt`, `BigInt(number)`, `Number(bigint)`,
`BigInt.asIntN`/`asUintN`. Bitwise `& | ^ << >>` are **not** on the
Temporal path and are deferred (they stay i64-only, documented).

**Why the ValType does not change.** Stack/local/global/field carriers stay
`{kind:"i64", bigint:true}` for statically-bigint slots, and the overflow
form only ever exists behind the `$BigIntVal` ref. The i64 arms therefore
stay byte-identical for programs whose values fit, which is the acceptance
bar. The cost is that a statically-typed `bigint` local cannot hold a
promoted value — so the arithmetic choke point must **return the ref form**
once any operand or result overflows, which means `resolveWasmType` for
`bigint` has to become the ref carrier in the promoted-capable regime. That
is the real cut line of slice 3 and is the reason slice 2 is landed and
measured first, on its own.

**Link-boundary ABI.** Provider and consumer are compiled by the same
compiler in the same run, so the `$BigIntVal` hierarchy is minted by the
same `addUnionImportsAsNativeFuncs` seeding on both sides and the boundary
`BIGINT` hint (`link-boundary-tostring.ts`, `extern-arg-marshal.ts`) keeps
matching. The limb array type must be minted in the same seeding block as
`$BigInt` so a module that links a provider it did not itself force to mint
the type cannot disagree.

### Landing order

| slice | content | why here |
| --- | --- | --- |
| 1 | this plan + probes (docs only) | measured before coding |
| **2** | **exact ToString for statically-typed bigint** — route the six `string-ops.ts` sites to `bigint_toString`, with demand registered in `import-collector.ts`; witness `tests/issue-6656-bigint-tostring-exact.test.ts` | whole-i64-range correctness, no representation change, self-contained, expected to move the string-round-trip Temporal rows |
| 3 | `$BigIntVal` supertype + promote/demote + construction/`typeof`/`===`/ToString on the promoted form | representation |
| 4 | `+ - * / % **` and ordering on limbs | arithmetic |
| 5 | `StringToBigInt` / `Number(bigint)` / `BigInt(number)` / `asIntN` on limbs | conversions |
| 6 | link-boundary survival of a promoted value | provider↔consumer |

Each slice is a pushed commit carrying its own witness and its own
re-measurement of the eight rows in section C.

### Acceptance

- Section B's eight rows all match Node.
- Section C: no row regresses; the string-round-trip rows flip on slice 2
  or are re-attributed with evidence.
- Byte-neutrality for programs with no bigint above 2^63: corpus
  `statusFlips=0 shaFlips=0` vs the S70 base. A module that contains no
  bigint at all must not move a byte in either lane.
- Four-family battery + the nine must-not-move groups: 0 pass→fail vs the
  S70 base.

## Slice log

### Slice 1 (2026-09-20) — plan + probes

Base `bccd46c552`. No `src/` change. Probes and the base TSV for the eight
rows are in `.tmp/s74/` (gitignored); the numbers they produced are
transcribed in sections A–C above.
