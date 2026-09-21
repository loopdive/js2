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
loc-budget-allow:
  - src/codegen/string-ops.ts
  - src/codegen/declarations/import-collector.ts
func-budget-allow:
  - src/codegen/string-ops.ts::compileStringBinaryOp
  - src/codegen/declarations/import-collector.ts::unifiedVisitNode
---

<!--
2026-09-20 budget rationale (slice 2). The DECISION (which formatter a
bigint-typed operand gets, and the native-format gate that keeps the JS-host
lane byte-inert) lives entirely in the new leaf
`src/codegen/bigint-string-context.ts`. What remains in the two god-files is
call-site glue that cannot move: five separate string contexts in
`string-ops.ts` (native operand arm, template span, `String.raw` substitution,
and both `+` concat operands) each already own their numeric lowering inline,
and the three demand blocks in `import-collector.ts::unifiedVisitNode` sit
inside existing `number_toString` registrations whose `spanType`/`leftType`/
`stringArgFact` locals they reuse — hoisting them out would duplicate the type
queries. Measured after extracting everything extractable into the leaf:
string-ops +25, import-collector +7, `compileStringBinaryOp` +9,
`unifiedVisitNode` +6.
-->


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
operand never gets there: `src/codegen/string-ops.ts` has five
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
(S69's attribution).

The slice-1 hypothesis for the `«NaN»` and `«[object Object]»` rows was that
they are **string-round-trip** failures — the polyfill converts its JSBI
carrier with `globalThis.BigInt(t.toString(10))` and reads values back out of
strings, so a rounded `String(bigint)` would corrupt a value that never left
i64 range. **Slice 2 falsified that** (see its log below): those rows do not
move, because the vendored polyfill is untyped JS whose bigints are `any` and
therefore already took the exact dynamic route. `Duration#total("seconds")`
answering `NaN` is the >2^63 wrap — the nanosecond total is ~9.0e24. All eight
rows are on slices 3–5.

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
| ToString (LOSSY, fixed in slice 2) | `string-ops.ts` ×5 | `f64.convert_i64_s` + `number_toString` |
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

### Slice 2 (2026-09-20) — exact ToString for a statically-typed bigint

**Landed.** `src/codegen/string-ops.ts` had five sites that stringified a
branded-bigint i64 by `f64.convert_i64_s` + `number_toString`, which rounds
above 2^53: the native-strings operand arm, a template span, a `String.raw`
substitution and both `+` concat operands. Each now prefers the exact
`bigint_toString` formatter when the operand carries the `bigint` brand, the
lane emits native number formatters, and the module demanded the helper.

New leaf `src/codegen/bigint-string-context.ts` owns both halves of that one
decision — `bigIntToStringIdx` (codegen) and `registerBigIntToStringDemand`
(import collector) — so the emitter and the demand can never disagree. The
`usesNativeNumberFormat` gate is load-bearing: in the JS-host lane the demand
would become an `env` IMPORT, and a new import shifts every function index.

**Result: the eight section-C Temporal rows are UNCHANGED — all 8 still fail,
with byte-identical error text (`.tmp/s74/battery/Target8-s2.tsv` vs
`base/Target8-base.tsv`).** The slice-1 hypothesis that they were
string-round-trip failures is therefore **falsified**, and the corroborating
evidence is that the standalone Temporal provider binary is
**3 488 870 B before and after** with the same cache key: the vendored
polyfill is untyped JS, so its bigints are `any`-typed and already took the
exact `__any_to_string` route that #6642 S62 built. Only code whose operand is
**statically** `bigint` — i.e. TypeScript source, not the polyfill — was on
the lossy path. `Duration#total("seconds")` answering `NaN` is the >2^63 wrap
(the nanosecond total is ~9.0e24), not a printing defect.

So slice 2 is a real correctness fix with no Temporal yield, and the eight
rows remain entirely on slices 3–5.

Measured:

- Witness `tests/issue-6656-bigint-tostring-exact.test.ts` — 24 rows. On the
  file-copy revert of the two touched files it FAILS with 17 rounded rows
  (`String(9223372036854775807n)` → `9223372036854776000`, `"" +
  9007199254740993n` → `…992`, `` `${2n ** 62n}` `` → `4611686018427388000`,
  …) while all 5 `ctrl` rows plus `strSmall`/`strZero` already pass, so the
  controls cannot carry the file green. With the fix: 24/24.
- Probes: `bi2.mts` 20/20 exact (was 12 wrong), `bi4.mts` 10/10 (was 7 wrong).
  `bi1.mts`'s remaining 10 wrong rows are all genuine >2^63 wrap and now print
  the wrapped value EXACTLY (`864n * 10n ** 19n` →
  `6923773503929843712`, previously the f64-rounded `6923773503929844000`).
- Corpus 47×{gc,standalone}: `statusFlips=0 shaFlips=0` vs the S70 base.
- `npm run -s test:equivalence:gate`: no new equivalence regressions.
- Gate chain green with the frontmatter allowances above.

### Slice 3 target — measured, and it REORDERS the plan (2026-09-20)

Probing where slice 2's `any`-typed control row actually goes turned up a
defect an order of magnitude larger than the >2^63 range, and it is the one
that owns the eight briefed rows.

**`any`-typed bigint ARITHMETIC does not exist in standalone.** Probe
`.tmp/s74/probes/bi5.mts` — plain untyped helpers (`function mul(a,b){return
a*b}` …) called with bigint arguments, `--target standalone`,
`hostBridge: off`:

| probe | standalone | Node |
| --- | --- | --- |
| `mul(6n, 7n)` | `NaN` | `42` |
| `mul(1234567890123456789n, 7n)` | `NaN` | `8641975230864197523` |
| `add(9007199254740992n, 1n)` | `90071992547409921` | `9007199254740993` |
| `sub(…)` / `div(…)` / `mod(…)` | `NaN` | correct |
| `lt(1n, 2n)` | `false` | `true` |
| `neg(9007199254740993n)` | `NaN` | `-9007199254740993` |
| `typeof mul(6n, 7n)` | `number` | `bigint` |
| `eq(x, x)` | `true` ✅ | `true` |

Only `===` is right — that is #6642 S62's `extern-eq-fast` bigint arm, the one
place a bigint carrier is explicitly recognised.

**Root cause.** The `binary-ops.ts` bigint block is entered only when
`isBigIntType(leftTsType) || isBigIntType(rightTsType)` — i.e. on a STATIC
bigint type. An `any`-typed operand never reaches it and falls into the
generic `AnyValue` numeric path, whose tag set is `0 null · 1 undefined ·
2 number · 4 boolean · 5 string · 6 object` — **there is no bigint tag**. The
`$BigInt` carrier boxes as an opaque ref, so `*` reads it as a non-number
(`NaN`), `+` takes the stringy arm (hence the concatenated
`90071992547409921`, which is `"9007199254740992" + "1"`), and `<` compares
two non-numbers.

**Why this owns the briefed rows.** `@js-temporal/polyfill` is untyped JS, so
every bigint it touches is `any`. `Duration.prototype.total("seconds")`
answering `«NaN»` on three of the eight rows is this, not a >2^63 wrap and not
a printing defect — the wrap hypothesis predicted a WRONG NUMBER, and the
observed value is `NaN`. `TypeError: cannot convert number to bigint` on the
eighth row is the same absence seen from the conversion side.

**Consequence for this issue's order.** A limb representation is worthless
until the dynamic path dispatches to bigint at all: arbitrary precision behind
an operator that answers `NaN` changes nothing. So the slice order becomes:

| slice | content |
| --- | --- |
| 3 (was 4) | **dynamic bigint arithmetic** — a bigint arm in the `AnyValue` numeric helpers (`+ - * / % **`, unary `-`, ordering) plus `typeof` and ToNumeric, still on the i64 carrier |
| 4 | `$BigIntVal` supertype + promote/demote (the limb representation) |
| 5 | limb arithmetic / conversions |
| 6 | link-boundary survival |

Slice 3 is the one with measurable Temporal yield and it is **independent of
the representation change**, so it can land on the i64 carrier first. The
open design question it has to answer is whether the bigint carrier gets a
real `AnyValue` TAG (touches `typeof`, `===`, truthiness, ToString, ToNumber
and every arithmetic helper) or whether each numeric helper tests
`ref.test $BigInt` on the existing object tag's `refval` — the second is
narrower and is what `extern-eq-fast.ts` already does for `===`.

#### Slice 3 design (read before starting)

Everything the arm needs already exists; nothing here requires a new type.

- **Detection is free.** `__typeof_bigint(externref) -> i32` is already a
  registered helper (`src/codegen/typeof-delete.ts:2272,2505`; native body in
  standalone), and `ref.test $BigInt` is already used directly by
  `extern-eq-fast.ts:135-155`, `any-helpers.ts:832-848`,
  `collections-es2025.ts:260,732`, `wrapper-proto-value-of.ts:450` and
  `is-truthy-ladder.ts:91`. So "this dynamic value is a bigint" is a
  one-instruction question, not a new mechanism.
- **The value is one `struct.get` away.** `$BigInt` is a one-field immutable
  struct holding the i64, and `bigint_toString` / `compileI64BinaryOp` /
  `__box_bigint` are the exact-i64 formatter, operator and re-boxer.
- **The gap is only the dynamic numeric helpers.** In `any-helpers.ts`:
  `addNumericBinaryHelper` (which generates `__any_sub` and `__any_mul`),
  `__any_div`, `__any_add` (whose "stringy" test currently claims a bigint
  carrier — that is the `90071992547409921` concat), the relational path
  (`emitAnyRelational`) and `__any_to_f64` (`Number(bigint)`). Each needs a
  leading both-operands-are-bigint arm: unwrap to i64, run the i64 op, re-box
  with `__box_bigint`. Every arm is absent-not-wrong — a non-bigint operand
  falls through to the existing tag dispatch untouched.
- **The one real design decision** is whether the re-boxed result gets a new
  `AnyValue` TAG or keeps riding the existing object/extern tag with the
  `$BigInt` ref inside. The current tag set is `0 null · 1 undefined ·
  2 number · 4 boolean · 5 string · 6 object` (`any-helpers.ts`), and a bigint
  currently lands on 5/6 — which is *why* `+` concatenates. Keeping it on the
  extern tag and testing the carrier (the `extern-eq-fast.ts` shape) is the
  narrow option and needs no change to `__any_eq`, truthiness or the boxing
  chokepoints; a real tag is cleaner but touches every tag consumer. Whichever
  is chosen, `__any_typeof` must answer `"bigint"` for the carrier — today it
  cannot, which is the `typeof mul(6n,7n) === "number"` row.
- **Mixed bigint/number must throw a real TypeError**, not coerce (§6.1.6.2.1),
  and `+` with a string operand must still CONCATENATE (§13.15.4) using the
  exact formatter slice 2 just wired up.

Acceptance for slice 3: `.tmp/s74/probes/bi5.mts` 11/11, and a re-measurement
of the eight section-C rows (three of which are `«NaN»` from exactly this).

### Slice 2 validation, completed (2026-09-21)

- **Witness sweep** `tests/issue-66*.test.ts tests/issue-6484-*.test.ts
  tests/issue-6493-*.test.ts`, `--maxWorkers=1`:
  - **Node 25.9.0: 59 files / 368 tests, all green.**
  - Node 22: the same 368 tests pass, but the first run reported 5 red files —
    every one of them `Hook timed out in 10000ms` / `Test timed out in
    35000ms`, never an assertion, on a 4-core box under load ~15 with four
    lanes active. Re-running the five together leaves one
    (`issue-6614-accessor-literal-return-carrier`), and running that one alone
    passes 4/4. So: contention, not regression — recorded rather than silently
    re-run, because "re-run until green" is how a real flake-shaped regression
    gets buried.
- **Battery** (S70 base TSVs, slice-2 provider `.test262-cache/s74-2`,
  `cacheHit=false` on first build): `Duration` 120 rows **matched=120
  passToFail=0 failToPass=0**.
- **Boundaries**: `check:compiler-boundaries:inventory` green with the new
  leaf registered. The `--mode complete` variant fails on
  `prepared-async-frame-adapter.ts`, a pre-existing `bound-unresolved` symbol
  this change does not touch (`inventoryValid: true`).

**Why the remaining battery groups are low-risk.** The change can only fire on
an operand whose STATIC type is `bigint`, which a test262 `.js` body cannot
have; the standalone Temporal provider is byte-identical before and after
(3 488 870 B, same cache key); and the 94-row corpus shows `shaFlips=0`. The
`Duration` group — the one of the thirteen that actually contains bigint rows
— is measured flat above.
